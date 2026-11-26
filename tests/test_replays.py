import bz2
import hashlib
import json
from datetime import timedelta
from pathlib import Path

import httpx

from match_details import build_constants, detail
from replays import (
    archive_all, fetch_archived, heatmap, parse_todo, plan_downloads, read_manifest, record_archives, release_tag,
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


def test_parse_todo_lists_archived_matches_missing_or_stale_derivations(tmp_path: Path) -> None:
    from replay_events import REPLAY_VERSION

    (tmp_path / "heat").mkdir()
    (tmp_path / "replay").mkdir()
    (tmp_path / "matches.json").write_text(json.dumps({"matches": [{"match_id": i} for i in (1, 2, 3, 4)]}))
    (tmp_path / "replays.json").write_text(json.dumps({"replays": {"1": {}, "2": {}, "3": {}}}))
    for match_id, version in ((1, REPLAY_VERSION), (2, REPLAY_VERSION - 1)):
        (tmp_path / "heat" / f"{match_id}.json").write_text("{}")
        (tmp_path / "replay" / f"{match_id}.json").write_text(json.dumps({"v": version}))
    assert parse_todo(tmp_path) == [2, 3]
    assert parse_todo(tmp_path, redo=True) == [1, 2, 3]


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


COMBAT_FIXTURE = Path(__file__).with_name("fixtures") / "parser_combat_9098014345.jsonl.gz"


def test_death_events_from_real_parser_output_match_opendota() -> None:
    import gzip
    from collections import Counter

    from replay_events import death_events

    entries = []
    for fixture in (PARSER_FIXTURE, COMBAT_FIXTURE):
        with gzip.open(fixture, "rt", encoding="utf-8") as lines:
            entries += [json.loads(line) for line in lines]
    keys = {"30": "npc_dota_hero_witch_doctor", "113": "npc_dota_hero_arc_warden", "102": "npc_dota_hero_abaddon",
            "88": "npc_dota_hero_nyx_assassin", "8": "npc_dota_hero_juggernaut", "85": "npc_dota_hero_undying",
            "44": "npc_dota_hero_phantom_assassin", "129": "npc_dota_hero_mars", "80": "npc_dota_hero_lone_druid",
            "21": "npc_dota_hero_windrunner"}
    events = death_events(entries, keys)

    # OpenDota's deaths for this match: per-slot counts, and first blood at 1:50 on slot 2 by slot 129.
    assert Counter(event["slot"] for event in events) == {
        0: 11, 1: 9, 2: 11, 3: 10, 4: 5, 128: 10, 129: 6, 130: 8, 131: 7, 132: 5}
    first = events[0]
    assert (first["t"], first["slot"], first["killer"], first["attackers"]) == (110, 2, 129, [128, 129])
    assert first["allies"] == 0 and first["region"] == "river"
    assert len(first["snapshot"]) == 10 and first["snapshot"][2] == [first["x"], first["y"]]


def test_regions_follow_the_river_and_bases() -> None:
    from replay_events import region

    assert region(75, 80, radiant=True) == "own_base"
    assert region(178, 172, radiant=True) == "enemy_base"
    assert region(120, 122.5, radiant=True) == "river"
    assert region(110.9, 112.7, radiant=True) == "own_half"   # Radiant mid tier-1 tower
    assert region(137.5, 129, radiant=True) == "enemy_half"   # Dire mid tier-1 tower
    assert region(137.5, 129, radiant=False) == "own_half"


def test_death_index_joins_opendota_log_with_replay_positions(tmp_path: Path) -> None:
    from replay_events import INDEX_COLUMNS, REPLAY_VERSION, build_death_index

    (tmp_path / "matches").mkdir()
    (tmp_path / "replay").mkdir()
    (tmp_path / "constants.json").write_text(json.dumps({"heroes": {"1": {"key": "npc_dota_hero_antimage"}}}))
    players = [{"slot": 0, "hero": 2}, {"slot": 128, "hero": 1}]
    (tmp_path / "matches.json").write_text(json.dumps({"matches": [
        {"match_id": 7, "players": players}, {"match_id": 8, "players": players}]}))
    detail = {
        # The third entry is an extra log line (like a Meepo clone) with no death on the game's counter.
        "deaths": [[0, 300, "npc_dota_hero_antimage", 150, 20], [0, 900, "npc_dota_goodguys_tower1_top", 300, 40],
                   [0, 905, "npc_dota_hero_antimage", 0, 0]],
        "buybacks": [[0, 910]],
        "objectives": [{"time": 350, "type": "building_kill", "key": "npc_dota_goodguys_tower1_mid"},
                       {"time": 950, "type": "CHAT_MESSAGE_ROSHAN_KILL", "team": 3}],
    }
    for match_id in (7, 8):
        (tmp_path / "matches" / f"{match_id}.json").write_text(json.dumps(detail))
    event = {"region": "enemy_half", "allies": 0, "enemies": 2, "attackers": [128], "snapshot": []}
    (tmp_path / "replay" / "7.json").write_text(json.dumps({"v": REPLAY_VERSION, "deaths": [
        {**event, "slot": 0, "t": 301, "x": 150.0, "y": 150.0, "killer": 128, "killer_unit": None},
        {**event, "slot": 0, "t": 900, "x": 100.0, "y": 160.0, "killer": None, "killer_unit": "npc_dota_goodguys_tower1_top"},
    ]}))

    assert build_death_index(tmp_path) == 5
    index = json.loads((tmp_path / "deaths.json").read_text())
    assert index["columns"] == INDEX_COLUMNS
    rows = [dict(zip(index["columns"], row)) for row in index["rows"]]
    replayed, logged = [row for row in rows if row["match_id"] == 7], [row for row in rows if row["match_id"] == 8]
    assert replayed[0] == {"match_id": 7, "slot": 0, "t": 301, "killer": 128, "gold_lost": 150, "time_dead": 20,
                           "buyback": 0, "region": "enemy_half", "allies": 0, "enemies": 2, "attackers": 1,
                           "x": 150.0, "y": 150.0, "lost": ["tower"]}
    assert replayed[1]["killer"] == "npc_dota_goodguys_tower1_top"
    assert replayed[1]["buyback"] == 1 and replayed[1]["lost"] == ["roshan"]
    assert len(logged) == 3 and logged[0]["region"] is None and logged[0]["killer"] == 128
