"""STRATZ IMP, match rank and win-probability curves for counted matches (site/data/stratz.json)."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import httpx

from match_details import GIVE_UP_AFTER, _iso, _read, _write, schedule_retry

STRATZ_URL = "https://api.stratz.com/graphql"
# STRATZ asks every API request to carry this User-Agent.
USER_AGENT = "STRATZ_API"
MATCH_QUERY = "query($id: Long!) { match(id: $id) { rank winRates players { playerSlot imp } } }"
RETRY_DOWNLOAD = "mutation($id: Long!) { retryMatchDownload(matchId: $id) }"


class StratzError(RuntimeError):
    pass


def stratz_client(token: str) -> httpx.Client:
    return httpx.Client(
        timeout=30.0, headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
    )


def _post(http: httpx.Client, query: str, match_id: int) -> dict[str, Any]:
    response = http.post(STRATZ_URL, json={"query": query, "variables": {"id": match_id}})
    response.raise_for_status()
    payload = response.json()
    if payload.get("errors"):
        raise StratzError(payload["errors"][0].get("message", "GraphQL error"))
    return payload.get("data") or {}


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
    }


def refresh_stratz(*, data_dir: Path, match_ids: Iterable[int], http: httpx.Client, now: datetime) -> dict[str, int]:
    """Fetch matches STRATZ has not scored yet; unscored ones are re-downloaded once and rechecked on the
    1/2/4/8/8... hour backoff in pending.json, then given up after a week."""
    ids = list(match_ids)
    counted = {str(match_id) for match_id in ids}
    known = {key: value for key, value in _read(data_dir / "stratz.json").get("matches", {}).items() if key in counted}
    state = _read(data_dir / "pending.json")
    queue = {key: entry for key, entry in state.get("stratz", {}).items() if key in counted}
    unavailable = set(state.get("stratz_unavailable", []))
    fetched = 0
    for match_id in ids:
        key = str(match_id)
        entry = queue.get(key)
        if key in known or match_id in unavailable or (entry and datetime.fromisoformat(entry["next_check_utc"]) > now):
            continue
        try:
            result = summarise(_post(http, MATCH_QUERY, match_id).get("match"))
        except (httpx.HTTPError, ValueError, StratzError) as error:
            print(f"STRATZ: match {match_id} failed ({error}); the next run tries again")
            continue
        fetched += 1
        if result:
            known[key] = result
            queue.pop(key, None)
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
    state["stratz"] = queue
    state["stratz_unavailable"] = sorted(unavailable)
    _write(data_dir / "pending.json", state)
    _write(data_dir / "stratz.json", {"schema_version": 1, "matches": dict(sorted(known.items()))})
    return {"scored": len(known), "fetched": fetched, "waiting": len(queue)}
