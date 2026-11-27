"""STRATZ IMP, match rank and win-probability curves for counted matches (site/data/stratz.json), plus
per-minute snapshots for matches STRATZ never scores, which the local IMP model (fit_imp.py) estimates from."""

from __future__ import annotations

import math
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import httpx

from match_details import GIVE_UP_AFTER, _iso, _read, _write, schedule_retry

STRATZ_URL = "https://api.stratz.com/graphql"
# STRATZ asks every API request to carry this User-Agent.
USER_AGENT = "STRATZ_API"
# The result, heroes, accounts and positions are kept to cross-check OpenDota's copy of the match.
MATCH_QUERY = ("query($id: Long!) { match(id: $id) { rank winRates didRadiantWin "
               "players { playerSlot imp heroId steamAccountId position } } }")

RETRY_DOWNLOAD = "mutation($id: Long!) { retryMatchDownload(matchId: $id) }"
# Per-minute stats and STRATZ's per-minute average for the hero and position, which IMP is measured against.
MINUTE_FIELDS = """durationSeconds topLaneOutcome midLaneOutcome bottomLaneOutcome
  players { playerSlot isRadiant lane
    heroAverage { time kills deaths assists networth xp cs heroDamage towerDamage healingAllies }
    stats { lastHitsPerMinute experiencePerMinute networthPerMinute heroDamagePerMinute towerDamagePerMinute healPerMinute
      killEvents { time } deathEvents { time } assistEvents { time } } }"""
MINUTE_QUERY = "query($id: Long!) { match(id: $id) { " + MINUTE_FIELDS + " } }"
# Snapshot minutes (plus the last minute); a game shorter than a mark uses its last minute there.
MARKS = (5, 10, 15, 20, 25, 30)
# Each player's cumulative stat and the hero average it is compared with, in snapshot order.
PAIRS = (("lh", "cs"), ("xp", "xp"), ("nw", "networth"), ("hd", "heroDamage"), ("td", "towerDamage"),
         ("k", "kills"), ("d", "deaths"), ("a", "assists"), ("hh", "healingAllies"))


class StratzError(RuntimeError):
    pass


def stratz_client(token: str) -> httpx.Client:
    return httpx.Client(
        timeout=30.0, headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
    )


# STRATZ allows two IP addresses per token every 15 minutes, and every GitHub Actions run has a new one.
# A 403 names the minutes until one frees up; each client waits for that once.
IP_LIMIT = re.compile(r"frees up in (\d+) minute")
MAX_IP_WAIT_MINUTES = 6


def post_graphql(http: httpx.Client, query: str, variables: dict[str, Any] | None = None, *, sleep=time.sleep) -> dict[str, Any]:
    for attempt in range(2):
        response = http.post(STRATZ_URL, json={"query": query, "variables": variables or {}})
        limit = IP_LIMIT.search(response.text) if response.status_code == 403 else None
        if limit and attempt == 0 and not getattr(http, "_stratz_waited", False) and int(limit[1]) <= MAX_IP_WAIT_MINUTES:
            http._stratz_waited = True
            print(f"STRATZ: IP address limit, waiting {limit[1]} minutes for a free slot")
            sleep((int(limit[1]) + 0.5) * 60)
            continue
        if limit:
            raise StratzError(f"IP address limit: {response.text.strip()[:160]}")
        response.raise_for_status()
        payload = response.json()
        if payload.get("errors"):
            raise StratzError(payload["errors"][0].get("message", "GraphQL error"))
        return payload.get("data") or {}
    raise StratzError("STRATZ IP address limit")


# STRATZ's seasonLeaderboardRank is empty for every league player, so only the medal is read.
RANKS_QUERY = """query($ids: [Long]!) { players(steamAccountIds: $ids) {
  steamAccountId steamAccount { seasonRank } } }"""


def stratz_ranks(http: httpx.Client, account_ids: Iterable[int]) -> dict[str, dict[str, Any]]:
    """Medal (rank tier) per account, as STRATZ last saw it."""
    ids = list(account_ids)
    # STRATZ answers at most five players per request.
    players = [player for start in range(0, len(ids), 5)
               for player in post_graphql(http, RANKS_QUERY, {"ids": ids[start:start + 5]}).get("players") or []]
    return {str(player["steamAccountId"]): {"rank_tier": (player.get("steamAccount") or {}).get("seasonRank")}
            for player in players if isinstance(player, dict) and player.get("steamAccountId")}


def _post(http: httpx.Client, query: str, match_id: int) -> dict[str, Any]:
    return post_graphql(http, query, {"id": match_id})


def _lane_result(match: dict[str, Any], player: dict[str, Any]) -> int:
    """+2 lane stomp won, +1 won, 0 even or not in a lane, -1 lost, -2 stomped."""
    lane = player.get("lane")
    if lane not in ("SAFE_LANE", "MID_LANE", "OFF_LANE"):
        return 0
    name = "mid" if lane == "MID_LANE" else ("bottom" if (lane == "SAFE_LANE") == player["isRadiant"] else "top")
    outcome = match.get(name + "LaneOutcome") or "TIE"
    if outcome == "TIE":
        return 0
    sign = 1 if outcome.startswith("RADIANT") == player["isRadiant"] else -1
    return sign * (2 if "STOMP" in outcome else 1)


def minute_snapshot(match: dict[str, Any] | None) -> dict[str, Any] | None:
    """Per player slot: at each mark, the PAIRS stats then their hero averages; None unless all ten have both."""
    if not match or not match.get("durationSeconds"):
        return None
    end = match["durationSeconds"] // 60
    marks = [t for t in MARKS if t < end] + [end]
    result = {}
    for player in match.get("players") or []:
        stats = player.get("stats") or {}
        average = {row["time"]: row for row in player.get("heroAverage") or []}
        if not stats.get("networthPerMinute") or not average:
            return None
        def total(key: str, t: int) -> int:
            return sum((stats.get(key) or [])[: t + 1])
        def events(key: str, t: int) -> int:
            return sum(1 for event in stats.get(key) or [] if event["time"] <= t * 60)
        snapshot = {}
        for t in marks:
            hero = average.get(t) or average[max(average)]
            worth = stats["networthPerMinute"]
            mine = {"lh": total("lastHitsPerMinute", t), "xp": total("experiencePerMinute", t), "nw": worth[min(t, len(worth) - 1)],
                    "hd": total("heroDamagePerMinute", t), "td": total("towerDamagePerMinute", t), "hh": total("healPerMinute", t),
                    "k": events("killEvents", t), "d": events("deathEvents", t), "a": events("assistEvents", t)}
            snapshot[str(t)] = [mine[key] for key, _ in PAIRS] + [round(hero.get(name) or 0, 2) for _, name in PAIRS]
        result[str(player["playerSlot"])] = {"t": snapshot, "lane": _lane_result(match, player)}
    return result if len(result) == 10 else None


def minute_features(entry: dict[str, Any]) -> list[float]:
    """Model inputs from one player's snapshot; site/imp-model.js mirrors this."""
    end = max(int(mark) for mark in entry["t"])
    features: list[float] = []
    for t in (*MARKS, end):
        values = entry["t"].get(str(t)) or entry["t"][str(end)]
        for i in range(len(PAIRS)):
            mine, hero = values[i], values[i + len(PAIRS)]
            features += [mine - hero, math.log((mine + 1) / (hero + 1))]
    return features + [float(entry["lane"])]


def summarise(match: dict[str, Any] | None) -> dict[str, Any] | None:
    """Rank, IMP per player slot and Radiant win chance per minute (0-100), or None until every IMP exists."""
    players = (match or {}).get("players") or []
    imp = {str(player.get("playerSlot")): player.get("imp") for player in players}
    if len(imp) != 10 or any(value is None for value in imp.values()):
        return None
    return {
        "rank": match.get("rank"),
        "imp": imp,
        "win": [round(value * 100) for value in match.get("winRates") or []],
        "radiant_win": match.get("didRadiantWin"),
        # Per player slot: [hero ID, account ID or null, position 1-5 or null].
        "players": {str(player.get("playerSlot")): [player.get("heroId"), player.get("steamAccountId"),
                                                    int(str(player.get("position") or "")[-1:] or 0) or None]
                    for player in players},
    }


def compare_positions(summaries: Iterable[dict[str, Any]], corrections: dict[str, Any], stratz: dict[str, Any]) -> list[str]:
    """Where STRATZ's position for a league player differs from ours (OpenDota's estimate, or the replay or
    manual correction in positions.json)."""
    problems = []
    for match in summaries:
        key = str(match.get("match_id"))
        theirs = (stratz.get(key) or {}).get("players") or {}
        for player in match.get("players", []):
            slot = str(player.get("slot"))
            ours = ((corrections.get(key) or {}).get(slot) or {}).get("pos") or player.get("pos")
            position = (theirs.get(slot) or [None, None, None])[2]
            if ours and position and ours != position:
                problems.append(f"{key} slot {slot}: position {ours} vs STRATZ {position}")
    return problems


def compare_matches(matches: Iterable[dict[str, Any]], stratz: dict[str, Any]) -> list[str]:
    """Where STRATZ's copy of a counted match disagrees with OpenDota's: result, hero or account per slot."""
    problems = []
    for match in matches:
        theirs = stratz.get(str(match["match_id"]))
        if not theirs or "players" not in theirs:
            continue
        if theirs.get("radiant_win") is not None and theirs["radiant_win"] != match.get("radiant_win"):
            problems.append(f"{match['match_id']}: result differs")
        for player in match.get("players", []):
            hero, account, _ = theirs["players"].get(str(player.get("player_slot")), [None, None, None])
            if hero and player.get("hero_id") and hero != player["hero_id"]:
                problems.append(f"{match['match_id']} slot {player['player_slot']}: hero {player['hero_id']} vs {hero}")
            if account and player.get("account_id") and account != player["account_id"]:
                problems.append(f"{match['match_id']} slot {player['player_slot']}: account {player['account_id']} vs {account}")
    return problems


def refresh_stratz(*, data_dir: Path, match_ids: Iterable[int], http: httpx.Client, now: datetime) -> dict[str, int]:
    """Fetch matches STRATZ has not scored yet; unscored ones are re-downloaded once and rechecked on the
    1/2/4/8/8... hour backoff in pending.json, then given up after a week. While a match has no IMP, its
    per-minute snapshot is fetched on each run until STRATZ has one, then kept for the local estimate."""
    ids = list(match_ids)
    counted = {str(match_id) for match_id in ids}
    stored = _read(data_dir / "stratz.json")
    known = {key: value for key, value in stored.get("matches", {}).items() if key in counted}
    minute = {key: value for key, value in stored.get("minute", {}).items() if key in counted and key not in known}
    state = _read(data_dir / "pending.json")
    queue = {key: entry for key, entry in state.get("stratz", {}).items() if key in counted}
    unavailable = set(state.get("stratz_unavailable", []))
    fetched = 0
    for match_id in ids:
        key = str(match_id)
        entry = queue.get(key)
        # Matches stored before the cross-check fields existed are fetched once more.
        if key in known and "players" in known[key]:
            continue
        if match_id not in unavailable and not (entry and datetime.fromisoformat(entry["next_check_utc"]) > now):
            try:
                result = summarise(_post(http, MATCH_QUERY, match_id).get("match"))
            except (httpx.HTTPError, ValueError, StratzError) as error:
                print(f"STRATZ: match {match_id} failed ({error}); the next run tries again")
                continue
            fetched += 1
            if result:
                known[key] = result
                queue.pop(key, None)
                minute.pop(key, None)
                continue
            if entry is None:
                entry = {"first_seen_utc": _iso(now), "attempts": 0}
                try:
                    _post(http, RETRY_DOWNLOAD, match_id)
                except (httpx.HTTPError, ValueError, StratzError) as error:
                    print(f"STRATZ: retry request for match {match_id} failed ({error})")
            if now - datetime.fromisoformat(entry["first_seen_utc"]) >= GIVE_UP_AFTER:
                queue.pop(key, None)
                unavailable.add(match_id)
            else:
                queue[key] = schedule_retry(entry, now)
        elif entry is None and match_id not in unavailable:
            continue
        # Without IMP, fetch the per-minute snapshot on every run until STRATZ has one, whatever the
        # IMP retry schedule says, so even a match given up on still gets the better estimate.
        if key not in minute:
            try:
                snapshot = minute_snapshot(_post(http, MINUTE_QUERY, match_id).get("match"))
            except (httpx.HTTPError, ValueError, StratzError) as error:
                print(f"STRATZ: per-minute data for match {match_id} failed ({error})")
                snapshot = None
            if snapshot:
                minute[key] = snapshot
    state["stratz"] = queue
    state["stratz_unavailable"] = sorted(unavailable)
    _write(data_dir / "pending.json", state)
    _write(data_dir / "stratz.json", {"schema_version": 1, "matches": dict(sorted(known.items())), "minute": dict(sorted(minute.items()))})
    return {"scored": len(known), "fetched": fetched, "waiting": len(queue), "per_minute": len(minute)}
