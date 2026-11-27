import json
from datetime import UTC, datetime
from pathlib import Path

import httpx

from hero_meta import refresh_hero_meta

NOW = datetime(2026, 12, 1, 12, tzinfo=UTC)


def stratz(rows_by_position: dict[str, list[dict]], calls: list) -> httpx.Client:
    def handle(request: httpx.Request) -> httpx.Response:
        position = json.loads(request.content)["variables"]["position"][-1]
        calls.append(position)
        if position not in rows_by_position:
            return httpx.Response(500)
        return httpx.Response(200, json={"data": {"heroStats": {"winWeek": rows_by_position[position]}}})
    return httpx.Client(transport=httpx.MockTransport(handle))


class OpenDota:
    def __init__(self, rows):
        self.rows = rows

    def get_json(self, path: str):
        assert path == "/heroStats"
        if self.rows is None:
            raise RuntimeError("down")
        return self.rows


def row(hero: int, week: int, matches: int, wins: int) -> dict:
    return {"heroId": hero, "week": week, "matchCount": matches, "winCount": wins}


def read(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "hero-meta.json").read_text(encoding="utf-8"))


def test_reads_positions_from_stratz_and_brackets_from_opendota(tmp_path: Path) -> None:
    rows = {position: [row(1, 100, 10, 6), row(1, 200, 20, 9), row(2, 200, 5, 1), row(3, 200, 0, 0)] for position in "12345"}
    heroes = [{"id": 1, "7_pick": 100, "7_win": 55, "8_pick": 10, "8_win": 6}, {"id": 2, "7_pick": 0, "8_pick": 0}]
    calls: list = []
    result = refresh_hero_meta(data_dir=tmp_path, stratz=stratz(rows, calls), opendota=OpenDota(heroes), now=NOW)
    stored = read(tmp_path)
    assert result == {"stratz": True, "opendota": True}
    assert calls == list("12345")
    assert stored["positions"]["3"] == {"1": [30, 15], "2": [5, 1]}
    assert stored["weeks"] == [100, 200]
    assert stored["overall"] == {"1": [110, 61]}


def test_each_failed_source_keeps_its_previous_part(tmp_path: Path) -> None:
    good = {position: [row(1, 100, 10, 6)] for position in "12345"}
    refresh_hero_meta(data_dir=tmp_path, stratz=stratz(good, []), opendota=OpenDota([{"id": 1, "7_pick": 10, "7_win": 5}]), now=NOW)
    before = read(tmp_path)
    later = datetime(2026, 12, 2, tzinfo=UTC)
    result = refresh_hero_meta(data_dir=tmp_path, stratz=stratz({"1": good["1"]}, []),
                               opendota=OpenDota([{"id": 1, "7_pick": 20, "7_win": 12}]), now=later, error_type=RuntimeError)
    after = read(tmp_path)
    assert result == {"stratz": False, "opendota": True}
    assert after["positions"] == before["positions"] and after["positions_updated_utc"] == before["positions_updated_utc"]
    assert after["overall"] == {"1": [20, 12]}
    assert refresh_hero_meta(data_dir=tmp_path, stratz=None, opendota=OpenDota(None), now=later, error_type=RuntimeError) == \
        {"stratz": False, "opendota": False}
    assert read(tmp_path) == after
