import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from match_details import build_constants, refresh_match_details, summarise

HEROES = {"1": {"id": 1, "name": "npc_dota_hero_antimage", "localized_name": "Anti-Mage", "img": "/am.png"}}
ITEMS = {
    "blink": {"id": 1, "dname": "Blink Dagger", "cost": 2250, "qual": "component"},
    "black_king_bar": {"id": 116, "dname": "Black King Bar", "cost": 4050, "components": ["ogre_axe"]},
    "ogre_axe": {"id": 22, "dname": "Ogre Axe", "cost": 1000},
    "tango": {"id": 44, "dname": "Tango", "cost": 90, "qual": "consumable"},
    "ultimate_scepter": {"id": 108, "dname": "Aghanim's Scepter", "cost": 4200, "components": ["ogre_axe"]},
}
START = datetime(2026, 12, 1, 12, tzinfo=UTC)


def raw_match(match_id: int, *, parsed: bool) -> dict[str, Any]:
    return {
        "match_id": match_id,
        "start_time": 1_800_000_000,
        "duration": 2400,
        "radiant_win": True,
        "radiant_score": 30,
        "dire_score": 20,
        "od_data": {"has_parsed": parsed},
        "picks_bans": [{"order": 1, "is_pick": True, "team": 1, "hero_id": 1},
                       {"order": 0, "is_pick": False, "team": 0, "hero_id": 2}],
        "radiant_gold_adv": [0, 100] if parsed else None,
        "objectives": [{"time": 900, "type": "CHAT_MESSAGE_ROSHAN_KILL", "team": 2},
                       {"time": 10, "type": "CHAT_MESSAGE_FIRSTBLOOD"}],
        "players": [
            {
                "account_id": 100 + slot,
                "player_slot": slot if slot < 5 else 123 + slot,
                "hero_id": 1,
                "item_0": 116,
                "item_1": 22,
                "aghanims_scepter": 1,
                "purchase_log": (
                    [{"time": -60, "key": "tango"}, {"time": 600, "key": "blink"},
                     {"time": 700, "key": "ogre_axe"}, {"time": 1300, "key": "black_king_bar"}]
                    if parsed else None
                ),
            }
            for slot in range(10)
        ],
    }


class FakeClient:
    def __init__(self, responses: dict[str, Any]) -> None:
        self.responses = responses
        self.requested: list[str] = []

    def get_json(self, path: str) -> Any:
        self.requested.append(path)
        return self.responses[path]

    def request_parse(self, match_id: int) -> Any:
        self.requested.append(f"POST /request/{match_id}")
        return {}


def run(tmp_path: Path, client: FakeClient, now: datetime, raw: dict[int, Any] | None = None) -> dict[str, Any]:
    refresh_match_details(
        data_dir=tmp_path, counted=[{"match_id": 7}], raw_by_id=raw or {}, client=client,
        error_type=KeyError, refresh_constants=False, now=now,
    )
    return {
        "summary": json.loads((tmp_path / "matches.json").read_text())["matches"][0],
        "pending": json.loads((tmp_path / "pending.json").read_text())["matches"],
    }


def test_summary_keeps_major_first_purchases_and_consumed_scepter() -> None:
    constants = build_constants(HEROES, ITEMS)
    assert constants["items"]["blink"]["major"] is True
    assert constants["items"]["ogre_axe"]["major"] is False
    assert constants["items"]["tango"]["major"] is False

    summary = summarise(raw_match(7, parsed=True), constants)

    assert summary["parse"] == "parsed"
    assert summary["picks_bans"] == [[0, 0, 0, 2], [1, 1, 1, 1]]
    assert summary["players"][0]["items"] == ["black_king_bar", "ogre_axe"]
    assert summary["players"][0]["built"] == {"blink": 600, "black_king_bar": 1300, "ultimate_scepter": None}


def test_unparsed_match_is_rechecked_after_1_2_4_8_8_hours_then_given_up(tmp_path: Path) -> None:
    (tmp_path / "constants.json").write_text(json.dumps(build_constants(HEROES, ITEMS)))
    client = FakeClient({"/matches/7": raw_match(7, parsed=False)})

    state = run(tmp_path, client, START)
    assert client.requested == ["/matches/7", "POST /request/7"]
    assert state["summary"]["parse"] == "pending"
    gaps = [datetime.fromisoformat(state["pending"]["7"]["next_check_utc"]) - START]

    now = START
    for _ in range(4):
        now = datetime.fromisoformat(state["pending"]["7"]["next_check_utc"])
        state = run(tmp_path, client, now)
        gaps.append(datetime.fromisoformat(state["pending"]["7"]["next_check_utc"]) - now)
    assert [gap / timedelta(hours=1) for gap in gaps] == [1, 2, 4, 8, 8]
    assert client.requested.count("POST /request/7") == 1

    requests_before = len(client.requested)
    state = run(tmp_path, client, now + timedelta(minutes=10))
    assert len(client.requested) == requests_before  # not due yet: no OpenDota call

    state = run(tmp_path, client, START + timedelta(days=7, hours=1))
    assert state["summary"]["parse"] == "unavailable"
    assert state["pending"] == {}


def test_parsed_recheck_writes_detail_and_clears_queue(tmp_path: Path) -> None:
    (tmp_path / "constants.json").write_text(json.dumps(build_constants(HEROES, ITEMS)))
    client = FakeClient({"/matches/7": raw_match(7, parsed=False)})
    run(tmp_path, client, START)

    client.responses["/matches/7"] = raw_match(7, parsed=True)
    state = run(tmp_path, client, START + timedelta(hours=1))

    assert state["summary"]["parse"] == "parsed"
    assert state["pending"] == {}
    detail = json.loads((tmp_path / "matches" / "7.json").read_text())
    assert detail["gold_adv"] == [0, 100]
    assert [objective["type"] for objective in detail["objectives"]] == ["CHAT_MESSAGE_ROSHAN_KILL"]


def test_lane_results_compare_ten_minute_gold_by_lane() -> None:
    from match_details import lane_results

    def player(slot: int, role: int, gold: int) -> dict[str, Any]:
        return {"player_slot": slot, "lane_role": role, "gold_t": [0] * 10 + [gold]}

    results = lane_results([
        player(0, 1, 3000), player(1, 1, 1500),    # radiant safe lane (bottom)
        player(128, 3, 3000),                       # dire off lane (bottom)
        player(2, 2, 3000), player(129, 2, 2900),  # mid: within 10%
        player(3, 3, 1000), player(130, 1, 4000),  # radiant off lane vs dire safe lane (top)
        player(4, 4, 2000),                         # jungle: no lane result
    ])

    assert results[0] == {"lane": "W", "lane_diff": 1500}
    assert results[128]["lane"] == "L"
    assert results[2]["lane"] == "D" and results[129]["lane"] == "D"
    assert results[3]["lane"] == "L" and results[130]["lane"] == "W"
    assert 4 not in results


def test_ensure_images_saves_small_webp_once(tmp_path: Path) -> None:
    import io

    import httpx
    from PIL import Image

    from match_details import ensure_images

    data = tmp_path / "data"
    data.mkdir()
    (data / "constants.json").write_text(json.dumps(build_constants(HEROES, {**ITEMS, "blink": {**ITEMS["blink"], "img": "/blink.png"}})))
    (data / "matches.json").write_text(json.dumps({"matches": [{"players": [{"items": ["blink"], "built": {}}]}]}))
    png = io.BytesIO()
    Image.new("RGBA", (256, 144), "red").save(png, "PNG")
    requested: list[str] = []

    def cdn(request: httpx.Request) -> httpx.Response:
        requested.append(request.url.path)
        return httpx.Response(200, content=png.getvalue())

    with httpx.Client(transport=httpx.MockTransport(cdn)) as http:
        assert ensure_images(image_dir=tmp_path / "img", data_dir=data, http=http) == 2
        assert ensure_images(image_dir=tmp_path / "img", data_dir=data, http=http) == 0

    assert sorted(requested) == ["/am.png", "/blink.png"]
    assert Image.open(tmp_path / "img" / "heroes" / "1.webp").size == (128, 72)


def test_summary_keeps_benchmark_percentiles_and_support_stats() -> None:
    raw = raw_match(7, parsed=True)
    raw["players"][0].update(
        benchmarks={"gold_per_min": {"raw": 500, "pct": 0.815}, "deaths_per_min": {"raw": 0.1, "pct": 0.2}},
        teamfight_participation=0.71234, obs_placed=6, sen_placed=4, camps_stacked=3, stuns=12.345,
    )

    player = summarise(raw, build_constants(HEROES, ITEMS))["players"][0]

    assert player["bm"] == {"gpm": 82, "death": 20}
    assert (player["tf"], player["obs"], player["sen"], player["stacks"], player["stuns"]) == (0.712, 6, 4, 3, 12.3)
    assert summarise(raw_match(8, parsed=False), build_constants(HEROES, ITEMS))["players"][0]["bm"] is None


def test_talent_picks_record_first_choice_per_tier() -> None:
    heroes = {"1": {"id": 1, "name": "npc_dota_hero_antimage", "localized_name": "Anti-Mage"}}
    hero_abilities = {"npc_dota_hero_antimage": {"talents": [
        {"name": "special_bonus_a", "level": 1}, {"name": "special_bonus_b", "level": 1},
        {"name": "special_bonus_c", "level": 2}, {"name": "special_bonus_d", "level": 2},
    ]}}
    abilities = {"special_bonus_a": {"dname": "+10 Agility"}, "special_bonus_b": {"dname": "+200 Health"}}
    ability_ids = {"901": "special_bonus_a", "902": "special_bonus_b", "903": "special_bonus_c", "904": "special_bonus_d", "5": "blink"}
    constants = build_constants(heroes, ITEMS, hero_abilities, abilities, ability_ids)
    assert constants["talents"]["1"][0] == {"id": 901, "tier": 1, "text": "+10 Agility"}

    raw = raw_match(7, parsed=True)
    raw["players"][0]["ability_upgrades_arr"] = [5, 902, 5, 903, 901]

    assert summarise(raw, constants)["players"][0]["talents"] == [
        {"tier": 1, "id": 902, "both": True},
        {"tier": 2, "id": 903, "both": False},
    ]


def test_summary_keeps_title_inputs() -> None:
    raw = raw_match(7, parsed=True)
    raw["radiant_gold_adv"] = [0, -1500, 4200, -300]
    raw["objectives"] = [{"type": "CHAT_MESSAGE_AEGIS", "player_slot": 1, "time": 1200},
                         {"type": "CHAT_MESSAGE_AEGIS_STOLEN", "player_slot": 0, "time": 2400}]
    raw["players"][0].update(
        multi_kills={"2": 3, "4": 1}, kill_streaks={"3": 2, "10": 1}, firstblood_claimed=1,
        damage_taken={"npc_dota_hero_axe": 900, "npc_dota_creep_goodguys_melee": 400, "npc_dota_hero_lion": 100},
    )

    summary = summarise(raw, build_constants(HEROES, ITEMS))
    player, other = summary["players"][0], summary["players"][1]

    assert summary["max_lead"] == {"radiant": 4200, "dire": 1500}
    assert (player["multi"], player["streak"], player["taken"], player["fb"], player["aegis_stolen"]) == (4, 10, 1000, 1, 1)
    assert (other["multi"], other["streak"], other["taken"], other["fb"], other["aegis_stolen"]) == (0, 0, None, 0, 0)
