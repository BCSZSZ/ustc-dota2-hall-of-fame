"""Archive league replays as GitHub Release assets and reduce them to whole-game position heatmaps."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

import httpx

from match_details import GIVE_UP_AFTER, HEAT_BIN, Client, _iso, _read, _write, schedule_retry
from replay_events import REPLAY_VERSION, build_death_index, build_lane_index, death_events, lane_events, level_events

REPO = os.getenv("GITHUB_REPOSITORY") or "BCSZSZ/ustc-dota2-hall-of-fame"
# Local working copies; the archive itself is the Release assets listed in site/data/replays.json.
REPLAY_DIR = Path("replays")
MANIFEST = "replays.json"
# Valve serves .dem.bz2 URLs, but some clusters (e.g. the Perfect World ones) send zstd data under that name.
FORMATS = {b"BZh": ".dem.bz2", b"\x28\xb5\x2f\xfd": ".dem.zst"}
DECOMPRESS = {".dem.bz2": ["bzip2", "-dc"], ".dem.zst": ["zstd", "-dc"]}
# Parser events kept in memory while deriving a match; everything else is dropped as it streams in.
KEPT_EVENTS = {"interval", "death_tick", "DOTA_COMBATLOG_DEATH", "DOTA_COMBATLOG_DAMAGE"}

Uploader = Callable[[str, Path], None]
Job = tuple[int, str | None, str]


def replay_path(replay_dir: Path, match_id: int) -> Path | None:
    """The local copy of a match's replay, whichever compression it came in."""
    for suffix in FORMATS.values():
        path = replay_dir / f"{match_id}{suffix}"
        if path.exists():
            return path
    return None


def release_tag(start_time: int) -> str:
    """One Release per calendar year keeps each well under GitHub's 1000-asset limit."""
    return f"replays-{datetime.fromtimestamp(start_time, UTC).year}"


def read_manifest(data_dir: Path) -> dict[str, dict[str, Any]]:
    return _read(data_dir / MANIFEST).get("replays", {})


def plan_downloads(
    *,
    matches: Iterable[dict[str, Any]],
    archived: dict[str, dict[str, Any]],
    raw_by_id: dict[int, dict[str, Any]],
    pending: dict[str, dict[str, Any]],
    unavailable: set[int],
    client: Client,
    error_type: type[Exception],
    now: datetime,
) -> list[Job]:
    """Unarchived replays that are due now: (match ID, replay URL if OpenDota knows it, Release tag)."""
    jobs = []
    for match in matches:
        match_id = match["match_id"]
        entry = pending.get(str(match_id))
        if str(match_id) in archived or match_id in unavailable:
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
        jobs.append((match_id, url, release_tag(match["start_time"])))
    return jobs


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


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


def gh_uploader(repo: str = REPO) -> Uploader:
    """Upload with the gh CLI, creating the year's Release the first time it is needed."""
    ready: set[str] = set()

    def upload(tag: str, path: Path) -> None:
        if tag not in ready:
            exists = subprocess.run(["gh", "release", "view", tag, "-R", repo], capture_output=True).returncode == 0
            if not exists:
                subprocess.run(
                    ["gh", "release", "create", tag, "-R", repo, "--target", "main", "--latest=false",
                     "--title", f"Replays {tag.removeprefix('replays-')}",
                     "--notes", "League replays archived by the collector; see site/data/replays.json."],
                    check=True, capture_output=True,
                )
            ready.add(tag)
        subprocess.run(["gh", "release", "upload", tag, str(path), "--clobber", "-R", repo], check=True, capture_output=True)

    return upload


def archive_all(jobs: list[Job], replay_dir: Path, http: httpx.Client, upload: Uploader) -> dict[int, dict[str, Any] | str]:
    """Download (unless a local copy exists) and upload each job; failures map to a reason."""
    results: dict[int, dict[str, Any] | str] = {}
    for match_id, url, tag in jobs:
        try:
            path = replay_path(replay_dir, match_id)
            if path is None:
                if not url:
                    results[match_id] = "OpenDota has no replay URL yet"
                    continue
                path = download(http, url, replay_dir, match_id)
            upload(tag, path)
            results[match_id] = {"tag": tag, "asset": path.name, "bytes": path.stat().st_size, "sha256": _sha256(path)}
        except (httpx.HTTPError, OSError, subprocess.CalledProcessError) as error:
            detail = getattr(error, "stderr", None)
            results[match_id] = (detail.decode(errors="replace").strip() if isinstance(detail, bytes) and detail
                                 else str(error) or type(error).__name__)
    return results


def record_archives(
    *,
    data_dir: Path,
    jobs: list[Job],
    results: dict[int, dict[str, Any] | str],
    match_ids: Iterable[int],
    now: datetime,
) -> dict[str, int]:
    """Add archived replays to replays.json and keep failures in pending.json on the 1/2/4/8/8... hour backoff."""
    manifest = read_manifest(data_dir)
    pending_path = data_dir / "pending.json"
    state = _read(pending_path)
    counted = {str(match_id) for match_id in match_ids}
    unavailable = set(state.get("replays_unavailable", []))
    queue = {key: entry for key, entry in state.get("replays", {}).items() if key in counted}
    for match_id, url, _ in jobs:
        key = str(match_id)
        result = results.get(match_id)
        if isinstance(result, dict):
            manifest[key] = result
            queue.pop(key, None)
            continue
        entry = queue.get(key) or {"first_seen_utc": _iso(now), "attempts": 0}
        if url:
            entry["replay_url"] = url
        entry["error"] = result
        if now - datetime.fromisoformat(entry["first_seen_utc"]) >= GIVE_UP_AFTER:
            queue.pop(key, None)
            unavailable.add(match_id)
        else:
            queue[key] = schedule_retry(entry, now)
    state["replays"] = queue
    state["replays_unavailable"] = sorted(unavailable)
    _write(pending_path, state)
    _write(data_dir / MANIFEST, {"replays": dict(sorted(manifest.items()))})
    return {"archived": sum(isinstance(result, dict) for result in results.values()), "waiting": len(queue)}


def fetch_archived(http: httpx.Client, entry: dict[str, Any], replay_dir: Path, repo: str = REPO) -> Path:
    """A verified local copy of an archived replay, downloaded from its Release when missing."""
    path = replay_dir / entry["asset"]
    if path.exists() and _sha256(path) == entry["sha256"]:
        return path
    replay_dir.mkdir(parents=True, exist_ok=True)
    partial = replay_dir / f"{entry['asset']}.part"
    try:
        url = f"https://github.com/{repo}/releases/download/{entry['tag']}/{entry['asset']}"
        with http.stream("GET", url) as response:
            response.raise_for_status()
            with partial.open("wb") as handle:
                for chunk in response.iter_bytes(1 << 20):
                    handle.write(chunk)
        if _sha256(partial) != entry["sha256"]:
            raise OSError(f"checksum mismatch for {entry['asset']}")
        partial.replace(path)
        return path
    finally:
        partial.unlink(missing_ok=True)


def _player_slot(index: int) -> int:
    return index if index < 5 else 128 + index - 5


# Two-minute slices let the page show 10-minute phases and also skip the laning phase (first 6 minutes).
HEAT_SLICE_SECONDS = 120


def _cell(value: float) -> int:
    return int((value - 64) // HEAT_BIN)


def heatmap(entries: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Seconds each living hero spent in each map cell, per 2-minute slice, from the parser's interval events."""
    counts: Counter[tuple[int, int, int, int]] = Counter()
    last_time = 0
    for entry in entries:
        if entry.get("type") != "interval" or entry.get("life_state") not in (0, None):
            continue
        time, x, y, slot = entry.get("time"), entry.get("x"), entry.get("y"), entry.get("slot")
        if not isinstance(time, (int, float)) or time < 0 or x is None or y is None or slot is None:
            continue
        counts[(_player_slot(int(slot)), int(time // HEAT_SLICE_SECONDS), _cell(x), _cell(y))] += 1
        last_time = max(last_time, int(time))
    players: dict[str, list[int]] = {}
    for (slot, phase, cx, cy), seconds in sorted(counts.items()):
        players.setdefault(str(slot), []).extend((phase, cx, cy, seconds))
    return {"bin": HEAT_BIN, "phase_seconds": HEAT_SLICE_SECONDS, "duration": last_time, "players": players}


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


def parse_todo(data_dir: Path, redo: bool = False) -> list[int]:
    """Counted, archived matches whose heatmap or replay events are missing or from an older format."""
    archived = read_manifest(data_dir)
    todo = []
    for match in _read(data_dir / "matches.json").get("matches", []):
        match_id = match["match_id"]
        if str(match_id) not in archived:
            continue
        heat = data_dir / "heat" / f"{match_id}.json"
        current = heat.exists() and _read(heat).get("phase_seconds") == HEAT_SLICE_SECONDS and (
            _read(data_dir / "replay" / f"{match_id}.json").get("v") == REPLAY_VERSION
        )
        if redo or not current:
            todo.append(match_id)
    return todo


def parse_replays(replay_dir: Path, data_dir: Path, parser_url: str, repo: str = REPO, redo: bool = False) -> int:
    """Write heat/{id}.json and replay/{id}.json for each match in parse_todo."""
    archived = read_manifest(data_dir)
    hero_keys = {hero_id: hero.get("key") for hero_id, hero in _read(data_dir / "constants.json").get("heroes", {}).items()}
    done = 0
    with httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0), follow_redirects=True) as http:
        for match_id in parse_todo(data_dir, redo):
            try:
                replay = fetch_archived(http, archived[str(match_id)], replay_dir, repo)
                entries = [entry for entry in _parser_entries(replay, parser_url) if entry.get("type") in KEPT_EVENTS]
            except (httpx.HTTPError, OSError, ValueError) as error:
                print(f"::warning::{match_id}: replay parse failed: {error}", file=sys.stderr)
                continue
            heat = heatmap(entries)
            if not heat["players"]:
                print(f"::warning::{match_id}: parser returned no hero positions", file=sys.stderr)
                continue
            _write(data_dir / "heat" / f"{match_id}.json", {"match_id": match_id, **heat})
            _write(data_dir / "replay" / f"{match_id}.json", {
                "v": REPLAY_VERSION, "match_id": match_id, "deaths": death_events(entries, hero_keys), **lane_events(entries),
                **level_events(entries),
            })
            done += 1
    return done


def build_indexes(data_dir: Path) -> str:
    """Rebuild the cross-match lane index first; the death index labels laning-phase deaths from it."""
    lanes = build_lane_index(data_dir)
    return f"lane index has {lanes} player-matches; death index has {build_death_index(data_dir)} deaths"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch archived replays and derive heatmaps and match events")
    parser.add_argument("command", choices=["todo", "parse", "fetch", "index"])
    parser.add_argument("--replay-dir", type=Path, default=REPLAY_DIR)
    parser.add_argument("--data-dir", type=Path, default=Path("site/data"))
    parser.add_argument("--parser-url", default="http://127.0.0.1:5600")
    parser.add_argument("--repo", default=REPO)
    parser.add_argument("--redo", action="store_true", help="re-derive every archived match, not only stale ones")
    parser.add_argument("--match", type=int, action="append", help="fetch only these match IDs (default: all)")
    args = parser.parse_args(argv)
    if args.command == "todo":
        print(len(parse_todo(args.data_dir, args.redo)))
    elif args.command == "parse":
        done = parse_replays(args.replay_dir, args.data_dir, args.parser_url, args.repo, args.redo)
        print(f"Replays: {done} parsed; {build_indexes(args.data_dir)}")
    elif args.command == "index":
        print(build_indexes(args.data_dir))
    else:
        archived = read_manifest(args.data_dir)
        wanted = [str(match_id) for match_id in args.match] if args.match else list(archived)
        with httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0), follow_redirects=True) as http:
            for key in wanted:
                print(fetch_archived(http, archived[key], args.replay_dir, args.repo))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
