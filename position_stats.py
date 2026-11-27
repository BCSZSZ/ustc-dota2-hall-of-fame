"""Each league player's recent public games by position (site/data/position-stats.json).

OpenDota lists every public match (STRATZ misses some accounts entirely); each match takes STRATZ's position
when STRATZ has one, otherwise one derived from OpenDota's lane and last hits, which agreed with STRATZ on 96%
of 537 overlapping league-player matches in 2026-11. The draft tool turns each position's win rate into a
per-position rating; positions played fewer than POSITION_MIN_GAMES times (site/matchmaker-model.js) count as
rarely played.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

import httpx

from match_details import _iso, _read, _write
from stratz import STRATZ_URL

SAMPLE = 100
MAX_AGE = timedelta(days=365)
OPENDOTA_LIMIT = 300
STRATZ_PAGE = 50
STRATZ_PAGES = 4
# Modes played like a normal game; turbo and ability draft are not.
STRATZ_MODES = {"ALL_PICK_RANKED", "ALL_PICK", "CAPTAINS_MODE", "CAPTAINS_DRAFT", "RANDOM_DRAFT", "SINGLE_DRAFT"}
OPENDOTA_MODES = {1, 2, 3, 4, 16, 22}
# A safe- or off-lane player with at least this many last hits a minute is the lane's core.
CORE_LAST_HITS_PER_MINUTE = 3.5
OPENDOTA_FIELDS = ("match_id", "player_slot", "radiant_win", "duration", "game_mode", "start_time", "lane_role", "last_hits")
STRATZ_QUERY = """query($a: Long!, $skip: Int!) { player(steamAccountId: $a) {
  matches(request: {take: %d, skip: $skip}) { id startDateTime gameMode durationSeconds
    players(steamAccountId: $a) { isVictory position } } } }""" % STRATZ_PAGE


def opendota_position(match: dict[str, Any]) -> str | None:
    lane, duration = match.get("lane_role"), match.get("duration") or 0
    if lane == 2:
        return "2"
    if lane not in (1, 3) or duration <= 0:
        return None
    core = (match.get("last_hits") or 0) / (duration / 60) >= CORE_LAST_HITS_PER_MINUTE
    return ("1" if core else "5") if lane == 1 else ("3" if core else "4")


def _opendota_games(get_json: Any, account: int, oldest: float) -> list[dict[str, Any]]:
    """Counted games, newest first: {id, start, won, position (derived or None)}."""
    query = "&".join([f"limit={OPENDOTA_LIMIT}"] + [f"project={field}" for field in OPENDOTA_FIELDS])
    matches = get_json(f"/players/{account}/matches?{query}")
    if not isinstance(matches, list):
        raise ValueError("OpenDota returned no match list")
    games = []
    for match in sorted(matches, key=lambda item: -(item.get("start_time") or 0)):
        if (match.get("start_time") or 0) < oldest:
            break
        if (match.get("game_mode") in OPENDOTA_MODES and (match.get("duration") or 0) >= 600
                and isinstance(match.get("radiant_win"), bool) and isinstance(match.get("player_slot"), int)):
            games.append({"id": match.get("match_id"), "start": match["start_time"],
                          "won": (match["player_slot"] < 128) == match["radiant_win"], "position": opendota_position(match)})
    return games


def _stratz_games(http: httpx.Client, account: int, oldest: float) -> list[dict[str, Any]]:
    """Counted games STRATZ has a position for, newest first, in the same shape."""
    games = []
    for page in range(STRATZ_PAGES):
        response = http.post(STRATZ_URL, json={"query": STRATZ_QUERY, "variables": {"a": account, "skip": page * STRATZ_PAGE}})
        response.raise_for_status()
        body = response.json()
        if body.get("errors"):
            raise ValueError(body["errors"][0].get("message", "GraphQL error"))
        matches = ((body.get("data") or {}).get("player") or {}).get("matches") or []
        for match in matches:
            if (match.get("startDateTime") or 0) < oldest:
                return games
            player = (match.get("players") or [{}])[0]
            position = (player.get("position") or "")[-1:]
            if (match.get("gameMode") in STRATZ_MODES and (match.get("durationSeconds") or 0) >= 600
                    and position in {"1", "2", "3", "4", "5"} and isinstance(player.get("isVictory"), bool)):
                games.append({"id": match.get("id"), "start": match["startDateTime"], "won": player["isVictory"], "position": position})
        if len(matches) < STRATZ_PAGE:
            break
    return games


def refresh_position_stats(*, data_dir: Path, account_ids: Iterable[int], opendota: Any, stratz: httpx.Client | None,
                           now: datetime, error_type: type[Exception] = Exception) -> dict[str, int]:
    """Replace each player's position record; a player neither source answers for keeps the previous one."""
    stored = _read(data_dir / "position-stats.json").get("players", {})
    oldest = (now - MAX_AGE).timestamp()
    players: dict[str, Any] = {}
    failed = 0
    for account in sorted(set(account_ids)):
        key = str(account)
        listed = stratz_games = None
        try:
            listed = _opendota_games(opendota.get_json, account, oldest)
        except (error_type, ValueError) as error:
            print(f"OpenDota: match list for {account} failed ({error})")
        if stratz is not None:
            try:
                stratz_games = _stratz_games(stratz, account, oldest)
            except (httpx.HTTPError, ValueError) as error:
                print(f"STRATZ: position history for {account} failed ({error})")
        if listed is None and stratz_games is None:
            failed += 1
            if key in stored:
                players[key] = stored[key]
            continue
        known = {game["id"]: game["position"] for game in stratz_games or []}
        sources = {"stratz": 0, "opendota": 0}
        games = []
        for game in listed if listed is not None else stratz_games:
            position = known.get(game["id"]) or game["position"]
            if not position:
                continue
            sources["stratz" if game["id"] in known else "opendota"] += 1
            games.append((game["start"], position, game["won"]))
            if len(games) == SAMPLE:
                break
        positions = {position: [0, 0] for position in "12345"}
        for _, position, won in games:
            positions[position][0] += 1
            positions[position][1] += won
        players[key] = {
            "games": len(games),
            "since": datetime.fromtimestamp(min(start for start, _, _ in games), now.tzinfo).date().isoformat() if games else None,
            "positions": positions,
            "sources": sources,
        }
    _write(data_dir / "position-stats.json", {"schema_version": 1, "generated_at_utc": _iso(now), "sample": SAMPLE, "players": players})
    return {"players": len(players), "failed": failed}
