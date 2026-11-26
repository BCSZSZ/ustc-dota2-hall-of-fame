"""Archive league replays under replays/ (Git LFS) and reduce them to whole-game position heatmaps."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Iterator

import httpx

from match_details import GIVE_UP_AFTER, HEAT_BIN, HEAT_PHASE_SECONDS, Client, _iso, _read, _write, schedule_retry

REPLAY_DIR = Path("replays")
LFS_POINTER_PREFIX = b"version https://git-lfs"
# Valve serves .dem.bz2 URLs, but some clusters (e.g. the Perfect World ones) send zstd data under that name.
FORMATS = {b"BZh": ".dem.bz2", b"\x28\xb5\x2f\xfd": ".dem.zst"}
DECOMPRESS = {".dem.bz2": ["bzip2", "-dc"], ".dem.zst": ["zstd", "-dc"]}


def replay_path(replay_dir: Path, match_id: int) -> Path | None:
    """The archived replay for a match, whichever compression it came in."""
    for suffix in FORMATS.values():
        path = replay_dir / f"{match_id}{suffix}"
        if path.exists():
            return path
    return None


def plan_downloads(
    *,
    replay_dir: Path,
    match_ids: Iterable[int],
    raw_by_id: dict[int, dict[str, Any]],
    pending: dict[str, dict[str, Any]],
    unavailable: set[int],
    client: Client,
    error_type: type[Exception],
    now: datetime,
) -> list[tuple[int, str | None]]:
    """Missing replays that are due now, with the replay URL when OpenDota knows it."""
    jobs = []
    for match_id in match_ids:
        entry = pending.get(str(match_id))
        if replay_path(replay_dir, match_id) or match_id in unavailable:
            continue
        if entry is not None and datetime.fromisoformat(entry["next_check_utc"]) > now:
            continue
        raw = raw_by_id.get(match_id)
        if raw is None and not (entry or {}).get("replay_url"):
            try:
                raw = client.get_json(f"/matches/{match_id}")
            except error_type:
                raw = None
        url = (raw or {}).get("replay_url") or (entry or {}).get("replay_url")
        jobs.append((match_id, url))
    return jobs


def download(http: httpx.Client, url: str, replay_dir: Path, match_id: int) -> Path:
    """Stream a replay to disk and keep it only if it is a complete bzip2 or zstd file."""
    replay_dir.mkdir(parents=True, exist_ok=True)
    partial = replay_dir / f"{match_id}.part"
    try:
        with http.stream("GET", url) as response:
            response.raise_for_status()
            expected = int(response.headers.get("content-length") or 0)
            written = 0
            with partial.open("wb") as handle:
                for chunk in response.iter_bytes(1 << 20):
                    handle.write(chunk)
                    written += len(chunk)
        if expected and written != expected:
            raise OSError(f"truncated download: {written} of {expected} bytes")
        with partial.open("rb") as handle:
            head = handle.read(4)
        suffix = next((suffix for magic, suffix in FORMATS.items() if head.startswith(magic)), None)
        if suffix is None:
            raise OSError("not a bzip2 or zstd replay")
        destination = replay_dir / f"{match_id}{suffix}"
        partial.replace(destination)
        return destination
    finally:
        partial.unlink(missing_ok=True)


def download_all(jobs: list[tuple[int, str | None]], replay_dir: Path, http: httpx.Client) -> dict[int, str | None]:
    """Download each job; the result maps match ID to None on success or to the failure reason."""
    results: dict[int, str | None] = {}
    for match_id, url in jobs:
        if not url:
            results[match_id] = "OpenDota has no replay URL yet"
            continue
        try:
            download(http, url, replay_dir, match_id)
            results[match_id] = None
        except (httpx.HTTPError, OSError) as error:
            results[match_id] = str(error) or type(error).__name__
    return results


def record_downloads(
    *,
    data_dir: Path,
    jobs: list[tuple[int, str | None]],
    results: dict[int, str | None],
    match_ids: Iterable[int],
    now: datetime,
) -> dict[str, int]:
    """Update the replay retry queue in pending.json with the same 1/2/4/8/8... hour backoff."""
    pending_path = data_dir / "pending.json"
    state = _read(pending_path)
    previous = state.get("replays", {})
    counted = {str(match_id) for match_id in match_ids}
    unavailable = set(state.get("replays_unavailable", []))
    queue = {key: entry for key, entry in previous.items() if key in counted}
    for match_id, url in jobs:
        key = str(match_id)
        if results.get(match_id) is None:
            queue.pop(key, None)
            continue
        entry = queue.get(key) or {"first_seen_utc": _iso(now), "attempts": 0}
        if url:
            entry["replay_url"] = url
        entry["error"] = results[match_id]
        if now - datetime.fromisoformat(entry["first_seen_utc"]) >= GIVE_UP_AFTER:
            queue.pop(key, None)
            unavailable.add(match_id)
        else:
            queue[key] = schedule_retry(entry, now)
    state["replays"] = queue
    state["replays_unavailable"] = sorted(unavailable)
    _write(pending_path, state)
    return {
        "downloaded": sum(result is None for result in results.values()),
        "waiting": len(queue),
    }


def _player_slot(index: int) -> int:
    return index if index < 5 else 128 + index - 5


def _cell(value: float) -> int:
    return int((value - 64) // HEAT_BIN)


def heatmap(entries: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Seconds each living hero spent in each map cell, per 10-minute phase, from the parser's interval events."""
    counts: Counter[tuple[int, int, int, int]] = Counter()
    last_time = 0
    for entry in entries:
        if entry.get("type") != "interval" or entry.get("life_state") not in (0, None):
            continue
        time, x, y, slot = entry.get("time"), entry.get("x"), entry.get("y"), entry.get("slot")
        if not isinstance(time, (int, float)) or time < 0 or x is None or y is None or slot is None:
            continue
        counts[(_player_slot(int(slot)), int(time // HEAT_PHASE_SECONDS), _cell(x), _cell(y))] += 1
        last_time = max(last_time, int(time))
    players: dict[str, list[int]] = {}
    for (slot, phase, cx, cy), seconds in sorted(counts.items()):
        players.setdefault(str(slot), []).extend((phase, cx, cy, seconds))
    return {"bin": HEAT_BIN, "phase_seconds": HEAT_PHASE_SECONDS, "duration": last_time, "players": players}


def _parser_entries(replay: Path, parser_url: str) -> Iterator[dict[str, Any]]:
    """Stream the decompressed .dem to the odota/parser HTTP endpoint and read back its JSON lines."""
    suffix = "".join(replay.suffixes[-2:])
    with subprocess.Popen([*DECOMPRESS[suffix], str(replay)], stdout=subprocess.PIPE) as process:
        assert process.stdout is not None

        def body() -> Iterator[bytes]:
            while chunk := process.stdout.read(1 << 20):
                yield chunk

        with httpx.Client(timeout=httpx.Timeout(600.0, connect=10.0)) as http:
            with http.stream("POST", parser_url, content=body()) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    if line.startswith("{"):
                        yield json.loads(line)
    if process.returncode:
        raise OSError(f"{DECOMPRESS[suffix][0]} exited with {process.returncode}")


def heat_todo(replay_dir: Path, data_dir: Path) -> list[int]:
    matches = _read(data_dir / "matches.json").get("matches", [])
    return [
        match["match_id"]
        for match in matches
        if replay_path(replay_dir, match["match_id"])
        and not (data_dir / "heat" / f"{match['match_id']}.json").exists()
    ]


def parse_heatmaps(replay_dir: Path, data_dir: Path, parser_url: str) -> int:
    done = 0
    for match_id in heat_todo(replay_dir, data_dir):
        replay = replay_path(replay_dir, match_id)
        assert replay is not None
        try:
            with replay.open("rb") as handle:
                if handle.read(len(LFS_POINTER_PREFIX)) == LFS_POINTER_PREFIX:
                    # .lfsconfig excludes replays/ by default; an empty --exclude lifts that for this file.
                    subprocess.run(["git", "lfs", "pull", f"--include={replay.as_posix()}", "--exclude="], check=True)
            result = heatmap(_parser_entries(replay, parser_url))
        except (httpx.HTTPError, subprocess.CalledProcessError, OSError, ValueError) as error:
            print(f"::warning::{match_id}: replay parse failed: {error}", file=sys.stderr)
            continue
        if not result["players"]:
            print(f"{match_id}: parser returned no hero positions", file=sys.stderr)
            continue
        _write(data_dir / "heat" / f"{match_id}.json", {"match_id": match_id, **result})
        done += 1
    return done


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Turn archived replays into whole-game heatmaps")
    parser.add_argument("command", choices=["todo", "parse"])
    parser.add_argument("--replay-dir", type=Path, default=REPLAY_DIR)
    parser.add_argument("--data-dir", type=Path, default=Path("site/data"))
    parser.add_argument("--parser-url", default="http://127.0.0.1:5600")
    args = parser.parse_args(argv)
    if args.command == "todo":
        print(len(heat_todo(args.replay_dir, args.data_dir)))
    else:
        print(f"Heatmaps: {parse_heatmaps(args.replay_dir, args.data_dir, args.parser_url)} replays parsed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
