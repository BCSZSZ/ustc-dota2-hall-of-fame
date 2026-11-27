import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from position_stats import SAMPLE, STRATZ_PAGE, opendota_position, refresh_position_stats

NOW = datetime(2026, 12, 1, 12, tzinfo=UTC)


def at(age_days: float) -> int:
    return int((NOW - timedelta(days=age_days)).timestamp())


def od(match_id: int, age_days: float, won: bool, lane: int | None = None, last_hits: int = 0, mode: int = 22, seconds: int = 1800,
       hero: int = 1) -> dict:
    return {"match_id": match_id, "start_time": at(age_days), "game_mode": mode, "duration": seconds, "player_slot": 0,
            "radiant_win": won, "lane_role": lane, "last_hits": last_hits, "hero_id": hero}


def sz(match_id: int, age_days: float, position: str, won: bool) -> dict:
    return {"id": match_id, "startDateTime": at(age_days), "gameMode": "ALL_PICK_RANKED", "durationSeconds": 1800,
            "players": [{"isVictory": won, "position": position}]}


class OpenDota:
    def __init__(self, lists: dict[int, list[dict]]) -> None:
        self.lists, self.paths = lists, []

    def get_json(self, path: str):
        self.paths.append(path)
        account = int(path.split("/")[2])
        if account not in self.lists:
            raise RuntimeError("down")
        return self.lists[account]


def stratz(histories: dict[int, list[dict]], calls: list) -> httpx.Client:
    def handle(request: httpx.Request) -> httpx.Response:
        variables = json.loads(request.content)["variables"]
        calls.append((variables["a"], variables["skip"]))
        if variables["a"] not in histories:
            return httpx.Response(500)
        page = histories[variables["a"]][variables["skip"]:variables["skip"] + STRATZ_PAGE]
        return httpx.Response(200, json={"data": {"player": {"matches": page}}})
    return httpx.Client(transport=httpx.MockTransport(handle))


def read(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "position-stats.json").read_text(encoding="utf-8"))["players"]


def test_derives_positions_from_lane_and_last_hits() -> None:
    assert opendota_position({"lane_role": 2, "duration": 1800}) == "2"
    assert opendota_position({"lane_role": 1, "duration": 1800, "last_hits": 105}) == "1"
    assert opendota_position({"lane_role": 1, "duration": 1800, "last_hits": 104}) == "5"
    assert opendota_position({"lane_role": 3, "duration": 1800, "last_hits": 200}) == "3"
    assert opendota_position({"lane_role": 3, "duration": 1800, "last_hits": 20}) == "4"
    assert opendota_position({"lane_role": 4, "duration": 1800, "last_hits": 200}) is None
    assert opendota_position({"lane_role": None, "duration": 1800}) is None


def test_lists_opendota_games_and_prefers_stratz_positions(tmp_path: Path) -> None:
    listed = [od(1, 1, True, lane=1, last_hits=20, hero=7), od(2, 2, False, lane=2, hero=9), od(3, 3, True, hero=9), od(4, 4, True, lane=2, mode=23),
              od(5, 5, True, lane=2, seconds=300), od(6, 6, False, lane=3, last_hits=200, hero=5), od(7, 400, True, lane=2)]
    calls: list = []
    result = refresh_position_stats(data_dir=tmp_path, account_ids=[7, 7], opendota=OpenDota({7: listed}),
                                    stratz=stratz({7: [sz(1, 1, "POSITION_4", True), sz(3, 3, "POSITION_2", True)]}, calls), now=NOW)
    assert result == {"players": 1, "failed": 0}
    assert calls == [(7, 0)]
    assert read(tmp_path)["7"] == {"games": 4, "since": "2026-11-25", "sources": {"stratz": 2, "opendota": 2},
                                   "positions": {"1": [0, 0], "2": [2, 1], "3": [1, 0], "4": [1, 1], "5": [0, 0]},
                                   "heroes": [[9, 2, 1], [7, 1, 1], [5, 1, 0]], "pool_games": [4, 2],
                                   "pool": {"1": [], "2": [[9, 2, 1]], "3": [[5, 1, 0]], "4": [[7, 1, 1]], "5": []},
                                   "position_check": [0, 1]}


def test_falls_back_to_one_source_and_keeps_the_previous_record(tmp_path: Path) -> None:
    refresh_position_stats(data_dir=tmp_path, account_ids=[9], opendota=OpenDota({9: [od(1, 1, True, lane=2)]}), stratz=None, now=NOW)
    many = [od(index, index / 10, index % 2 == 0, lane=2) for index in range(SAMPLE + 30)]
    result = refresh_position_stats(
        data_dir=tmp_path, account_ids=[7, 8, 9], opendota=OpenDota({7: many}),
        stratz=stratz({8: [sz(1, 1, "POSITION_5", True)]}, []), now=NOW, error_type=RuntimeError,
    )
    players = read(tmp_path)
    assert result == {"players": 3, "failed": 1}
    assert players["7"]["positions"]["2"] == [SAMPLE, SAMPLE // 2]
    assert players["7"]["pool_games"] == [SAMPLE + 30, (SAMPLE + 30) // 2] and players["7"]["pool"]["2"] == [[1, SAMPLE + 30, (SAMPLE + 30) // 2]]
    assert players["8"]["positions"]["5"] == [1, 1] and players["8"]["sources"] == {"stratz": 1, "opendota": 0}
    assert players["9"]["positions"]["2"] == [1, 1]


def test_keeps_the_stratz_backed_record_when_stratz_fails(tmp_path: Path) -> None:
    listed = [od(index, index, True, lane=None) for index in range(1, 6)]
    refresh_position_stats(data_dir=tmp_path, account_ids=[7], opendota=OpenDota({7: listed}),
                           stratz=stratz({7: [sz(index, index, "POSITION_3", True) for index in range(1, 6)]}, []), now=NOW)
    before = read(tmp_path)["7"]
    result = refresh_position_stats(data_dir=tmp_path, account_ids=[7], opendota=OpenDota({7: listed}), stratz=stratz({}, []), now=NOW)
    assert result == {"players": 1, "failed": 1}
    assert read(tmp_path)["7"] == before and before["positions"]["3"] == [5, 5]


def test_joins_both_match_lists(tmp_path: Path) -> None:
    listed = [od(1, 1, True, lane=2, hero=3)]
    result = refresh_position_stats(data_dir=tmp_path, account_ids=[7], opendota=OpenDota({7: listed}),
                                    stratz=stratz({7: [sz(1, 1, "POSITION_2", True), sz(2, 2, "POSITION_5", False)]}, []), now=NOW)
    record = read(tmp_path)["7"]
    assert result == {"players": 1, "failed": 0}
    assert record["positions"]["2"] == [1, 1] and record["positions"]["5"] == [1, 0]
    assert record["position_check"] == [1, 1] and record["heroes"][0] == [3, 1, 1]
