"""The patch's hero win rates in high-rank games (site/data/hero-meta.json), from STRATZ and OpenDota.

STRATZ gives each hero's matches and wins by position in Divine and Immortal ranked games; OpenDota gives the
same brackets without positions. BP suggestions (site/bp-model.js) read the positions and fall back to
OpenDota's numbers when STRATZ has none. Each source that fails keeps its part of the previous file.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from match_details import _iso, _read, _write
from stratz import StratzError, post_graphql

WEEKS = 2
BRACKETS = ("DIVINE", "IMMORTAL")
# OpenDota's heroStats buckets by medal: 7 is Divine, 8 Immortal.
OPENDOTA_BRACKETS = ("7", "8")
QUERY = """query($position: MatchPlayerPositionType!) { heroStats {
  winWeek(take: %d, bracketIds: [%s], positionIds: [$position], gameModeIds: [ALL_PICK_RANKED]) { heroId week matchCount winCount } } }""" % (
    WEEKS, ", ".join(BRACKETS))


def _stratz_positions(http: httpx.Client) -> tuple[dict[str, dict[str, list[int]]], list[int]]:
    positions: dict[str, dict[str, list[int]]] = {}
    weeks: set[int] = set()
    for position in "12345":
        rows = (post_graphql(http, QUERY, {"position": f"POSITION_{position}"}).get("heroStats") or {}).get("winWeek") or []
        table: dict[str, list[int]] = {}
        for row in rows:
            hero, matches, wins = row.get("heroId"), row.get("matchCount") or 0, row.get("winCount") or 0
            if isinstance(hero, int) and hero > 0 and matches > 0:
                record = table.setdefault(str(hero), [0, 0])
                record[0] += matches
                record[1] += wins
                weeks.add(row.get("week") or 0)
        if not table:
            raise ValueError(f"STRATZ returned no heroes for position {position}")
        positions[position] = dict(sorted(table.items(), key=lambda item: int(item[0])))
    return positions, sorted(week for week in weeks if week)


def _opendota_overall(get_json: Any) -> dict[str, list[int]]:
    rows = get_json("/heroStats")
    if not isinstance(rows, list):
        raise ValueError("OpenDota returned no hero stats")
    overall = {}
    for row in rows:
        picks = sum(int(row.get(f"{bracket}_pick") or 0) for bracket in OPENDOTA_BRACKETS)
        wins = sum(int(row.get(f"{bracket}_win") or 0) for bracket in OPENDOTA_BRACKETS)
        if isinstance(row.get("id"), int) and picks > 0:
            overall[str(row["id"])] = [picks, wins]
    if not overall:
        raise ValueError("OpenDota hero stats had no Divine or Immortal games")
    return dict(sorted(overall.items(), key=lambda item: int(item[0])))


def refresh_hero_meta(*, data_dir: Path, stratz: httpx.Client | None, opendota: Any, now: datetime,
                      error_type: type[Exception] = Exception) -> dict[str, bool]:
    previous = _read(data_dir / "hero-meta.json")
    meta = {key: previous[key] for key in ("positions", "weeks", "positions_updated_utc", "overall", "overall_updated_utc") if key in previous}
    updated = {"stratz": False, "opendota": False}
    if stratz is not None:
        try:
            meta["positions"], meta["weeks"] = _stratz_positions(stratz)
            meta["positions_updated_utc"] = _iso(now)
            updated["stratz"] = True
        except (httpx.HTTPError, ValueError, StratzError) as error:
            print(f"STRATZ: hero win rates by position failed ({error}); keeping the previous ones")
    try:
        meta["overall"] = _opendota_overall(opendota.get_json)
        meta["overall_updated_utc"] = _iso(now)
        updated["opendota"] = True
    except (error_type, ValueError) as error:
        print(f"OpenDota: hero stats failed ({error}); keeping the previous ones")
    if any(updated.values()):
        _write(data_dir / "hero-meta.json", {
            "schema_version": 2,
            "generated_at_utc": _iso(now),
            "bracket_label": "超凡入圣和冠绝一世",
            "window_label": f"STRATZ 最近 {WEEKS} 周排位，OpenDota 近期公开比赛",
            **meta,
        })
    return updated
