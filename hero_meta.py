"""The patch's hero win rates by position in high-rank ranked games (site/data/hero-meta.json), from STRATZ.

BP suggestions (site/bp-model.js) treat a hero that wins clearly more than half its games at a position as
strong in the current patch.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import httpx

from match_details import _iso, _read, _write
from stratz import STRATZ_URL

WEEKS = 2
BRACKETS = ("DIVINE", "IMMORTAL")
QUERY = """query($position: MatchPlayerPositionType!) { heroStats {
  winWeek(take: %d, bracketIds: [%s], positionIds: [$position], gameModeIds: [ALL_PICK_RANKED]) { heroId week matchCount winCount } } }""" % (
    WEEKS, ", ".join(BRACKETS))


def refresh_hero_meta(*, data_dir: Path, http: httpx.Client, now: datetime) -> dict[str, int]:
    """Replace the file only when every position answered, so a failed run keeps yesterday's data."""
    positions: dict[str, dict[str, list[int]]] = {}
    weeks: set[int] = set()
    for position in "12345":
        try:
            response = http.post(STRATZ_URL, json={"query": QUERY, "variables": {"position": f"POSITION_{position}"}})
            response.raise_for_status()
            body = response.json()
            if body.get("errors"):
                raise ValueError(body["errors"][0].get("message", "GraphQL error"))
            rows = ((body.get("data") or {}).get("heroStats") or {}).get("winWeek") or []
        except (httpx.HTTPError, ValueError) as error:
            print(f"STRATZ: hero win rates for position {position} failed ({error}); keeping the previous file")
            return {"heroes": len(_read(data_dir / "hero-meta.json").get("positions", {}).get("1", {})), "updated": 0}
        table: dict[str, list[int]] = {}
        for row in rows:
            hero, matches, wins = row.get("heroId"), row.get("matchCount") or 0, row.get("winCount") or 0
            if isinstance(hero, int) and hero > 0 and matches > 0:
                record = table.setdefault(str(hero), [0, 0])
                record[0] += matches
                record[1] += wins
                weeks.add(row.get("week") or 0)
        positions[position] = dict(sorted(table.items(), key=lambda item: int(item[0])))
    _write(data_dir / "hero-meta.json", {
        "schema_version": 1,
        "generated_at_utc": _iso(now),
        "bracket_label": "超凡入圣和冠绝一世排位",
        "window_label": f"最近 {WEEKS} 周",
        "weeks": sorted(week for week in weeks if week),
        "positions": positions,
    })
    return {"heroes": len(positions["1"]), "updated": 1}
