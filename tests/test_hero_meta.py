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


def row(hero: int, week: int, matches: int, wins: int) -> dict:
    return {"heroId": hero, "week": week, "matchCount": matches, "winCount": wins}


def test_sums_the_weeks_for_each_position(tmp_path: Path) -> None:
    rows = {position: [row(1, 100, 10, 6), row(1, 200, 20, 9), row(2, 200, 5, 1), row(3, 200, 0, 0)] for position in "12345"}
    calls: list = []
    assert refresh_hero_meta(data_dir=tmp_path, http=stratz(rows, calls), now=NOW) == {"heroes": 2, "updated": 1}
    stored = json.loads((tmp_path / "hero-meta.json").read_text(encoding="utf-8"))
    assert calls == list("12345")
    assert stored["positions"]["3"] == {"1": [30, 15], "2": [5, 1]}
    assert stored["weeks"] == [100, 200]


def test_keeps_the_previous_file_when_a_position_fails(tmp_path: Path) -> None:
    good = {position: [row(1, 100, 10, 6)] for position in "12345"}
    refresh_hero_meta(data_dir=tmp_path, http=stratz(good, []), now=NOW)
    before = (tmp_path / "hero-meta.json").read_text(encoding="utf-8")
    result = refresh_hero_meta(data_dir=tmp_path, http=stratz({"1": good["1"]}, []), now=NOW)
    assert result == {"heroes": 1, "updated": 0}
    assert (tmp_path / "hero-meta.json").read_text(encoding="utf-8") == before
