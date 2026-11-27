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


def test_lane_events_from_real_parser_output_match_opendota_lanes() -> None:
    import gzip

    from replay_events import lane_events

    with gzip.open(PARSER_FIXTURE, "rt", encoding="utf-8") as lines:
        entries = [json.loads(line) for line in lines]
    result = lane_events(entries)

    # OpenDota's lane roles for this match, as physical lanes (Radiant safe = bot, Dire safe = top).
    assert result["lanes"] == {"0": "bot", "1": "mid", "2": "top", "3": "top", "4": "bot",
                               "128": "top", "129": "top", "130": "bot", "131": "mid", "132": "bot"}
    assert result["roams"] == [[129, 471, 600, "bot"], [130, 506, 541, "top"]]
    assert all(0 <= seconds <= 510 for seconds in result["away"].values())


def test_lane_events_mark_junglers_and_ignore_short_visits() -> None:
    from replay_events import LANE_ANCHORS, lane_events

    top, mid = LANE_ANCHORS["top"], LANE_ANCHORS["mid"]
    entries = []
    for t in range(0, 601):
        # Slot 0 lanes top, visits mid for 20 s at 3:00 and for 40 s at 6:00; slot 1 stays in the jungle.
        visiting = 180 <= t < 200 or 360 <= t < 400
        x, y = mid if visiting else top
        entries.append({"type": "interval", "time": t, "slot": 0, "x": x, "y": y, "life_state": 0})
        entries.append({"type": "interval", "time": t, "slot": 1, "x": 150.0, "y": 150.0, "life_state": 0})
    result = lane_events(entries)
    assert result["lanes"] == {"0": "top", "1": "jungle"}
    assert result["roams"] == [[0, 360, 399, "mid"]]
    assert result["away"] == {"0": 60}


def test_lane_index_pairs_counterparts_and_classifies_laning_deaths(tmp_path: Path) -> None:
    from replay_events import LANE_COLUMNS, REPLAY_VERSION, build_lane_index

    (tmp_path / "matches").mkdir()
    (tmp_path / "replay").mkdir()
    players = [
        {"slot": 0, "pos": 1, "lane_role": 1}, {"slot": 4, "pos": 5, "lane_role": 1}, {"slot": 1, "pos": 2, "lane_role": 2},
        {"slot": 128, "pos": 3, "lane_role": 3}, {"slot": 132, "pos": 4, "lane_role": 3}, {"slot": 129, "pos": 2, "lane_role": 2},
    ]
    (tmp_path / "matches.json").write_text(json.dumps({"matches": [{"match_id": 7, "players": players}]}))
    gold = {0: 4000, 4: 1500, 128: 3000, 132: 1000, 1: 3500, 129: 3600}
    (tmp_path / "matches" / "7.json").write_text(json.dumps({
        "series": {str(slot): {"gold": [0] * 10 + [value], "lh": list(range(11)), "xp": [0] * 11, "dn": [0] * 11}
                   for slot, value in gold.items()},
        "wards": [[0, 4, 30, 100, 100, 360, 0, None], [1, 4, 700, 100, 100, None, 0, None]],
        "deaths": [[0, 201, "npc_dota_hero_axe", 150, 20]],
        "laning": {"4": {"runes": {"power": 0, "bounty": 2, "water": 1, "wisdom": 0}, "stacks": 3, "boots": 250, "first_item": None}},
    }))
    lanes = {"0": "bot", "4": "bot", "1": "mid", "128": "bot", "132": "bot", "129": "mid"}
    (tmp_path / "replay" / "7.json").write_text(json.dumps({"v": REPLAY_VERSION, "lanes": lanes, "away": {}, "roams": [[4, 300, 340, "mid"]],
        "levels": {"0": [355, 4, 8], "128": [330, 5, 9]},
        "deaths": [{"slot": 0, "t": 200, "attackers": [128], "region": "enemy_half"}, {"slot": 0, "t": 400, "attackers": [128, 129]},
                   {"slot": 4, "t": 500, "attackers": [128, 132]}, {"slot": 128, "t": 900, "attackers": [0]}]}))
    (tmp_path / "lane_overrides.json").write_text(json.dumps({"7": {"1": "mid"}}))

    assert build_lane_index(tmp_path) == 6
    index = json.loads((tmp_path / "lanes.json").read_text())
    assert index["columns"] == LANE_COLUMNS
    row = {r[1]: dict(zip(index["columns"], r)) for r in index["rows"]}
    assert (row[0]["role"], row[0]["opp"], row[4]["opp"], row[128]["role"]) == ("safe", 128, 132, "off")
    assert row[0]["result"] == "W" and row[0]["lane_diff"] == 1500 and row[128]["result"] == "L"
    assert row[1]["source"] == "manual" and row[1]["result"] == "D"
    # Deaths carry where they happened (replay) and the gold lost (OpenDota's log, matched within 3 s).
    assert row[0]["deaths"] == [[200, "solo", [128], "enemy_half", 150], [400, "gank", [128, 129], None, None]]
    assert row[4]["deaths"] == [[500, "lane", [128, 132], None, None]]
    assert (row[0]["fb"], row[128]["fb"], row[4]["fb"]) == ("death", "kill", None)
    assert (row[0]["level6"], row[0]["lvl10"], row[0]["opp_level6"], row[0]["opp_lvl10"]) == (355, 8, 330, 9)
    assert row[0]["curve_gold"][10] == 1000 and row[0]["curve_gold"][11] is None and len(row[0]["curve_gold"]) == 13
    assert row[0]["curve_lane"][10] == 1500 and row[128]["curve_lane"][10] == -1500
    assert (row[4]["runes"]["bounty"], row[4]["stacks"], row[4]["boots"], row[4]["obs_life"], row[4]["obs_lost"]) == (2, 3, 250, 360, 0)
    assert (row[4]["roam_kills"], row[4]["roam_swing"]) == (0, 0)
    assert row[128]["kills"] == 3 and row[128]["deaths"] == []
    assert (row[4]["obs"], row[4]["sen"], row[4]["roams"]) == (1, 0, [[300, 340, "mid"]])
    assert row[0]["lh10"] == 10 and row[0]["opp_lh10"] == 10 and row[0]["gold10"] == 4000 and row[0]["opp_gold10"] == 3000


def test_jungler_position_ganks_and_counterpart(tmp_path: Path) -> None:
    from replay_events import LANE_ANCHORS, REPLAY_VERSION, build_lane_index, lane_events

    top = LANE_ANCHORS["top"]
    entries = [{"type": "interval", "time": t, "slot": 2, "x": top[0] if 300 <= t < 340 else 150.0,
                "y": top[1] if 300 <= t < 340 else 150.0, "life_state": 0} for t in range(0, 601)]
    events = lane_events(entries)
    assert events["lanes"] == {"2": "jungle"} and events["roams"] == [[2, 300, 339, "top"]] and events["away"] == {}

    (tmp_path / "matches").mkdir()
    (tmp_path / "replay").mkdir()
    players = [{"slot": 0, "pos": 1}, {"slot": 2, "pos": 3}, {"slot": 128, "pos": 1}, {"slot": 129, "pos": 3},
               {"slot": 130, "pos": 4}]
    (tmp_path / "matches.json").write_text(json.dumps({"matches": [{"match_id": 7, "players": players}]}))
    (tmp_path / "matches" / "7.json").write_text(json.dumps({"series": {
        str(slot): {"gold": [0] * 10 + [gold], "lh": [0] * 11, "xp": [0] * 11, "dn": [0] * 11}
        for slot, gold in {0: 1000, 2: 3000, 128: 3000, 129: 2500, 130: 1500}.items()}}))
    (tmp_path / "replay" / "7.json").write_text(json.dumps({
        "v": REPLAY_VERSION, "away": {}, "roams": [[2, 300, 339, "top"], [2, 450, 490, "bot"]],
        "lanes": {"0": "top", "2": "jungle", "128": "top", "129": "bot", "130": "top"},
        "deaths": [{"slot": 128, "t": 330, "attackers": [0, 2]}, {"slot": 2, "t": 480, "attackers": [129]}]}))

    build_lane_index(tmp_path)
    index = json.loads((tmp_path / "lanes.json").read_text())
    row = {r[1]: dict(zip(index["columns"], r)) for r in index["rows"]}
    jungler = row[2]
    # Radiant is short in top (1 v 2). The jungler out-farmed slot 0 by 10:00, so it is that off lane's core (3) and
    # slot 0 its support (4): slot 0 pairs with the Dire support and the jungler faces the Dire core, and back.
    # Dire's safe lane (top) held 128 and 130: 128 had more gold at 10:00 (no last hits either side), so 130 is its
    # support, 5 rather than OpenDota's 4.
    assert json.loads((tmp_path / "positions.json").read_text()) == {"7": {
        "0": {"pos": 4, "source": "jungle", "opendota": 1}, "130": {"pos": 5, "source": "replay", "opendota": 4}}}
    # The jungler is grouped with top (Radiant's off lane) and counted there: 1000 + 3000 against 3000 + 1500 is a loss.
    assert (jungler["lane"], jungler["group"], jungler["role"], jungler["kind"]) == ("jungle", "top", "off", "core")
    assert (jungler["opp"], jungler["opp_gold10"], jungler["result"], row[0]["result"]) == (128, 3000, "L", "L")
    assert (row[0]["opp"], row[130]["opp"], row[128]["opp"], row[128]["opp_gold10"], row[0]["kind"]) == (130, 0, 2, 3000, "support")

    # A manual position wins: as a support the jungler faces the Dire support instead.
    (tmp_path / "position_overrides.json").write_text(json.dumps({"7": {"2": 4, "0": 3}}))
    build_lane_index(tmp_path)
    index = json.loads((tmp_path / "lanes.json").read_text())
    row = {r[1]: dict(zip(index["columns"], r)) for r in index["rows"]}
    assert json.loads((tmp_path / "positions.json").read_text())["7"] == {
        "0": {"pos": 3, "source": "manual", "opendota": 1}, "2": {"pos": 4, "source": "manual", "opendota": 3},
        "130": {"pos": 5, "source": "replay", "opendota": 4}}
    assert (row[2]["opp"], row[0]["opp"], row[130]["opp"]) == (130, 128, 2)
    assert jungler["ganks"] == [[300, 339, "top", [128], 0], [450, 490, "bot", [], 1]]
    assert jungler["short_lane"] == ["top", 1, 2, "L"]
    assert jungler["roams"] == [] and row[0]["ganks"] is None and row[0]["short_lane"] is None
    # The jungler's own death came from 129, who laned bot: another lane, so a gank.
    assert row[2]["deaths"] == [[480, "gank", [129], None, None]]


def test_level_events_from_real_parser_output() -> None:
    import gzip

    from replay_events import level_events

    with gzip.open(PARSER_FIXTURE, "rt", encoding="utf-8") as lines:
        levels = level_events(json.loads(line) for line in lines)["levels"]
    assert len(levels) == 10
    for sixth, at5, at10 in levels.values():
        assert 1 <= at5 <= at10 <= 12
        assert sixth is None or (at10 >= 6) == (sixth <= 600)
    # Mid heroes reach level 6 first.
    assert min(levels, key=lambda slot: levels[slot][0] or 10**6) in ("1", "131")


def test_level_events_take_the_first_second_at_level_six() -> None:
    from replay_events import level_events

    entries = [{"type": "interval", "time": t, "slot": 0, "level": 1 + t // 100} for t in range(0, 700)]
    assert level_events(entries)["levels"] == {"0": [500, 4, 7]}


def test_replay_lanes_set_core_and_support_by_last_hits(tmp_path: Path) -> None:
    from replay_events import REPLAY_VERSION, build_lane_index

    (tmp_path / "matches").mkdir()
    (tmp_path / "replay").mkdir()
    # OpenDota swapped Dire's safe-lane core (131) with an off-lane support (129).
    players = [{"slot": slot, "pos": pos} for slot, pos in {0: 2, 1: 5, 2: 3, 3: 1, 4: 4, 128: 3, 129: 1, 130: 2, 131: 5, 132: 4}.items()]
    (tmp_path / "matches.json").write_text(json.dumps({"matches": [{"match_id": 8, "players": players}]}))
    last_hits = {0: 48, 1: 10, 2: 40, 3: 45, 4: 2, 128: 42, 129: 22, 130: 48, 131: 41, 132: 8}
    gold = {129: 3828, 128: 3670}
    (tmp_path / "matches" / "8.json").write_text(json.dumps({"series": {
        str(slot): {"gold": [0] * 10 + [gold.get(slot, 2000)], "lh": [0] * 10 + [lh], "xp": [0] * 11, "dn": [0] * 11}
        for slot, lh in last_hits.items()}}))
    lanes = {"0": "mid", "1": "bot", "2": "top", "3": "bot", "4": "top", "128": "bot", "129": "bot", "130": "mid", "131": "top", "132": "top"}
    (tmp_path / "replay" / "8.json").write_text(json.dumps({"v": REPLAY_VERSION, "away": {}, "roams": [], "lanes": lanes, "deaths": []}))

    build_lane_index(tmp_path)
    assert json.loads((tmp_path / "positions.json").read_text()) == {"8": {
        "129": {"pos": 4, "source": "replay", "opendota": 1}, "131": {"pos": 1, "source": "replay", "opendota": 5},
        "132": {"pos": 5, "source": "replay", "opendota": 4}}}
