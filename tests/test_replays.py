import bz2
import hashlib
import json
from datetime import timedelta
from pathlib import Path

import httpx

from match_details import build_constants, detail
from replays import (
    archive_all, fetch_archived, heat_todo, heatmap, plan_downloads, read_manifest, record_archives, release_tag,
)
from test_match_details import HEROES, ITEMS, START, FakeClient, raw_match

REPLAY = bz2.compress(b"PBDEMS2\0" + b"x" * 1000)
MATCH = {"match_id": 7, "start_time": int(START.timestamp())}


def cdn(status: int = 200, body: bytes = REPLAY) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(status, content=body)))


class FakeUploads:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.uploaded: list[tuple[str, str]] = []

    def __call__(self, tag: str, path: Path) -> None:
        if self.fail:
            raise OSError("upload refused")
        self.uploaded.append((tag, path.name))


def plan(tmp_path: Path, client: FakeClient, now, **overrides):
    state = json.loads((tmp_path / "pending.json").read_text()) if (tmp_path / "pending.json").exists() else {}
    return plan_downloads(**{
        "matches": [MATCH], "archived": read_manifest(tmp_path), "raw_by_id": {}, "pending": state.get("replays", {}),
        "unavailable": set(state.get("replays_unavailable", [])), "client": client, "error_type": KeyError, "now": now,
        **overrides,
    })


def test_replay_archive_retries_after_1_2_4_8_hours_and_skips_until_due(tmp_path: Path) -> None:
    replays = tmp_path / "replays"
    client = FakeClient({"/matches/7": {"match_id": 7}})
    now = START
    gaps = []
    for _ in range(5):
        jobs = plan(tmp_path, client, now)
        assert jobs == [(7, None, "replays-2026")]
        record_archives(data_dir=tmp_path, jobs=jobs, results=archive_all(jobs, replays, cdn(), FakeUploads()),
                        match_ids=[7], now=now)
        due = json.loads((tmp_path / "pending.json").read_text())["replays"]["7"]["next_check_utc"]
        gaps.append((START.fromisoformat(due) - now) / timedelta(hours=1))
        now = START.fromisoformat(due)
    assert gaps == [1, 2, 4, 8, 8]
    assert plan(tmp_path, client, now - timedelta(minutes=5)) == []


def test_archive_uploads_valid_replays_and_records_them(tmp_path: Path) -> None:
    replays = tmp_path / "replays"
    url = "http://replay1.valve.net/570/7_1.dem.bz2"
    jobs = [(7, url, "replays-2026")]

    assert archive_all(jobs, replays, cdn(body=b"<html>error</html>"), FakeUploads()) == {7: "not a bzip2 or zstd replay"}
    assert archive_all(jobs, replays, cdn(), FakeUploads(fail=True)) == {7: "upload refused"}

    zstd = b"\x28\xb5\x2f\xfd" + b"z" * 100
    (replays / "7.dem.bz2").unlink()  # the copy kept from the refused upload would otherwise be reused
    uploads = FakeUploads()
    results = archive_all(jobs, replays, cdn(body=zstd), uploads)
    record_archives(data_dir=tmp_path, jobs=jobs, results=results, match_ids=[7], now=START)

    assert uploads.uploaded == [("replays-2026", "7.dem.zst")]
    assert read_manifest(tmp_path) == {"7": {"tag": "replays-2026", "asset": "7.dem.zst", "bytes": 104,
                                              "sha256": hashlib.sha256(zstd).hexdigest()}}
    assert json.loads((tmp_path / "pending.json").read_text())["replays"] == {}
    assert plan(tmp_path, FakeClient({}), START) == []


def test_archive_gives_up_after_a_week(tmp_path: Path) -> None:
    (tmp_path / "pending.json").write_text(json.dumps({"replays": {"7": {
        "first_seen_utc": START.isoformat(), "attempts": 5, "next_check_utc": START.isoformat()}}}))
    later = START + timedelta(days=7, hours=1)
    record_archives(data_dir=tmp_path, jobs=[(7, None, "replays-2026")], results={7: "gone"}, match_ids=[7], now=later)
    state = json.loads((tmp_path / "pending.json").read_text())
    assert state["replays"] == {}
    assert state["replays_unavailable"] == [7]


def test_release_tag_groups_replays_by_year() -> None:
    assert release_tag(int(START.timestamp())) == "replays-2026"


def test_fetch_archived_downloads_from_the_release_and_checks_the_hash(tmp_path: Path) -> None:
    entry = {"tag": "replays-2026", "asset": "7.dem.bz2", "bytes": len(REPLAY), "sha256": hashlib.sha256(REPLAY).hexdigest()}
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, content=REPLAY)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    path = fetch_archived(http, entry, tmp_path, "owner/repo")
    assert path.read_bytes() == REPLAY
    assert seen == ["https://github.com/owner/repo/releases/download/replays-2026/7.dem.bz2"]
    fetch_archived(http, entry, tmp_path, "owner/repo")
    assert len(seen) == 1  # a verified local copy is reused

    path.unlink()
    try:
        fetch_archived(cdn(body=b"corrupt"), entry, tmp_path, "owner/repo")
        raise AssertionError("expected a checksum error")
    except OSError as error:
        assert "checksum" in str(error)
    assert not path.exists()


def test_heatmap_counts_living_seconds_per_player_phase_and_cell() -> None:
    entries = [
        {"type": "interval", "time": -5, "slot": 0, "x": 100.0, "y": 100.0, "life_state": 0},
        {"type": "interval", "time": 10, "slot": 0, "x": 100.4, "y": 101.9, "life_state": 0},
        {"type": "interval", "time": 11, "slot": 0, "x": 100.9, "y": 100.2, "life_state": 0},
        {"type": "interval", "time": 12, "slot": 0, "x": 100.9, "y": 100.2, "life_state": 2},
        {"type": "interval", "time": 650, "slot": 7, "x": 64.0, "y": 191.9, "life_state": 0},
        {"type": "DOTA_COMBATLOG_DAMAGE", "time": 20, "slot": 0},
    ]
    result = heatmap(entries)
    assert result["players"] == {"0": [0, 18, 18, 2], "130": [1, 0, 63, 1]}
    assert result["duration"] == 650


def test_detail_pairs_wards_with_their_end_and_names_the_dewarder() -> None:
    constants = build_constants({**HEROES, "2": {"id": 2, "name": "npc_dota_hero_axe", "localized_name": "Axe"}}, ITEMS)
    raw = raw_match(7, parsed=True)
    raw["duration"] = 2000
    raw["players"][5]["hero_id"] = 2
    raw["players"][0].update({
        "obs_log": [{"time": 100, "x": 120.04, "y": 90.0, "ehandle": 11}, {"time": 500, "x": 130, "y": 95, "ehandle": 12},
                    {"time": 1900, "x": 140, "y": 99, "ehandle": 13}],
        "obs_left_log": [{"time": 460, "ehandle": 11, "attackername": "npc_dota_hero_antimage"},
                         {"time": 620, "ehandle": 12, "attackername": "npc_dota_hero_axe"},
                         {"time": 2000, "ehandle": 13, "attackername": "npc_dota_hero_axe"}],
        "sen_log": [{"time": 300, "x": 110, "y": 110, "ehandle": 21}],
        "lane_pos": {"100": {"100": 3, "101": 2}, "64": {"191": 1}},
    })
    result = detail(raw, constants)
    assert result["wards"] == [
        [0, 0, 100, 120.0, 90.0, 360, 0, None],
        [1, 0, 300, 110, 110, None, 0, None],
        [0, 0, 500, 130, 95, 120, 1, 128],
        [0, 0, 1900, 140, 99, None, 0, None],
    ]
    assert result["lane_heat"]["players"]["0"] == [0, 0, 63, 1, 0, 18, 18, 5]


def test_heat_todo_lists_archived_replays_without_a_heatmap(tmp_path: Path) -> None:
    (tmp_path / "heat").mkdir()
    (tmp_path / "matches.json").write_text(json.dumps({"matches": [{"match_id": 1}, {"match_id": 2}, {"match_id": 3}]}))
    (tmp_path / "replays.json").write_text(json.dumps({"replays": {"1": {}, "2": {}}}))
    (tmp_path / "heat" / "1.json").write_text("{}")
    assert heat_todo(tmp_path) == [2]


# Real odota/parser interval events for match 9098014345 (fields the heatmap reads), captured with the
# parser commit pinned in pages.yml. Expected values come from OpenDota's own parse of the same match.
PARSER_FIXTURE = Path(__file__).with_name("fixtures") / "parser_intervals_9098014345.jsonl.gz"
OPENDOTA_HERO_AND_ALIVE_SECONDS = {
    0: (30, 1857), 1: (113, 1813), 2: (102, 1824), 3: (88, 1887), 4: (8, 1941),
    128: (85, 1971), 129: (44, 1982), 130: (129, 1933), 131: (80, 1920), 132: (21, 2039),
}


def test_heatmap_from_real_parser_output_matches_opendota() -> None:
    import gzip

    from replays import _player_slot

    with gzip.open(PARSER_FIXTURE, "rt", encoding="utf-8") as lines:
        entries = [json.loads(line) for line in lines]
    heroes = {_player_slot(entry["slot"]): entry["hero_id"] for entry in entries if entry.get("hero_id")}
    result = heatmap(entries)

    assert result["duration"] == 2241
    for slot, (hero_id, alive) in OPENDOTA_HERO_AND_ALIVE_SECONDS.items():
        assert heroes[slot] == hero_id
        assert sum(result["players"][str(slot)][3::4]) == alive
