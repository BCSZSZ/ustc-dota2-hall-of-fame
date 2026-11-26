"""Per-match summaries, detail files and OpenDota parse retries for the stats page."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

HERO_NAMES_ZH = Path(__file__).with_name("hero_names_zh.json")
# Recheck unparsed matches after 1h, 2h, 4h, then every 8h until they are a week old.
RETRY_HOURS = (1, 2, 4, 8)
GIVE_UP_AFTER = timedelta(days=7)
BOOTS = {
    "tranquil_boots", "arcane_boots", "phase_boots", "power_treads", "boots_of_bearing",
    "guardian_greaves", "travel_boots", "travel_boots_2",
}
# Pure components that players still finish their build with.
STANDALONE_COMPONENTS = {"blink", "ghost"}
KEPT_OBJECTIVES = {"CHAT_MESSAGE_ROSHAN_KILL", "CHAT_MESSAGE_AEGIS", "building_kill"}


class Client(Protocol):
    def get_json(self, path: str) -> Any: ...
    def request_parse(self, match_id: int) -> Any: ...


def build_constants(heroes: dict[str, Any], items: dict[str, Any]) -> dict[str, Any]:
    names_zh = json.loads(HERO_NAMES_ZH.read_text(encoding="utf-8"))
    used_as_component = {part for item in items.values() for part in item.get("components") or []}

    def is_major(key: str, item: dict[str, Any]) -> bool:
        if key.startswith("recipe_") or "consumable" in (item.get("qual") or ""):
            return False
        if key in BOOTS:
            return True
        if (item.get("cost") or 0) < 1000:
            return False
        return bool(item.get("components")) or key not in used_as_component or key in STANDALONE_COMPONENTS

    return {
        "heroes": {
            str(hero["id"]): {
                "name": names_zh.get(str(hero["id"])) or hero.get("localized_name") or str(hero["id"]),
                "en": hero.get("localized_name") or "",
                "img": hero.get("img") or "",
            }
            for hero in heroes.values()
            if isinstance(hero, dict) and isinstance(hero.get("id"), int)
        },
        "items": {
            key: {
                "id": item["id"],
                "name": item.get("dname") or key,
                "img": item.get("img") or "",
                "cost": item.get("cost") or 0,
                "major": is_major(key, item),
            }
            for key, item in items.items()
            if isinstance(item, dict) and isinstance(item.get("id"), int)
        },
    }


def is_parsed(raw: dict[str, Any]) -> bool:
    players = raw.get("players") or []
    return (
        bool((raw.get("od_data") or {}).get("has_parsed"))
        and len(players) == 10
        and any(player.get("purchase_log") for player in players)
    )


def summarise(raw: dict[str, Any], constants: dict[str, Any]) -> dict[str, Any]:
    items = constants.get("items", {})
    key_by_id = {item["id"]: key for key, item in items.items()}

    def item_key(item_id: Any) -> str | None:
        return key_by_id.get(item_id) if isinstance(item_id, int) and item_id > 0 else None

    def major(key: str | None) -> bool:
        return bool(key and items.get(key, {}).get("major"))

    players = []
    for player in sorted(raw.get("players") or [], key=lambda item: item.get("player_slot", 0)):
        built: dict[str, int | None] = {}
        for purchase in player.get("purchase_log") or []:
            key = purchase.get("key")
            if major(key) and key not in built:
                built[key] = int(purchase.get("time") or 0)
        final = [key for key in (item_key(player.get(f"item_{slot}")) for slot in range(6)) if key]
        consumed = {
            "ultimate_scepter": player.get("aghanims_scepter"),
            "aghanims_shard": player.get("aghanims_shard"),
            "moon_shard": player.get("moonshard"),
        }
        for key in [*final, *(key for key, used in consumed.items() if used)]:
            if major(key) and key not in built:
                built[key] = None
        account_id = player.get("account_id")
        players.append(
            {
                "account_id": account_id if isinstance(account_id, int) and account_id > 0 else None,
                "slot": player.get("player_slot"),
                "hero": player.get("hero_id"),
                "pos": player.get("position_est"),
                "k": player.get("kills"),
                "d": player.get("deaths"),
                "a": player.get("assists"),
                "lh": player.get("last_hits"),
                "dn": player.get("denies"),
                "gpm": player.get("gold_per_min"),
                "xpm": player.get("xp_per_min"),
                "nw": player.get("net_worth"),
                "hd": player.get("hero_damage"),
                "td": player.get("tower_damage"),
                "hh": player.get("hero_healing"),
                "lvl": player.get("level"),
                "items": final,
                "backpack": [key for key in (item_key(player.get(f"backpack_{slot}")) for slot in range(3)) if key],
                "neutral": item_key(player.get("item_neutral")),
                "enchant": item_key(player.get("item_neutral2")),
                "scepter": bool(player.get("aghanims_scepter")),
                "shard": bool(player.get("aghanims_shard")),
                "built": built,
            }
        )
    return {
        "match_id": raw["match_id"],
        "start_time": raw.get("start_time"),
        "duration": raw.get("duration"),
        "radiant_win": raw.get("radiant_win"),
        "radiant_score": raw.get("radiant_score"),
        "dire_score": raw.get("dire_score"),
        "parse": "parsed" if is_parsed(raw) else "pending",
        "picks_bans": [
            [entry.get("order"), int(bool(entry.get("is_pick"))), entry.get("team"), entry.get("hero_id")]
            for entry in sorted(raw.get("picks_bans") or [], key=lambda item: item.get("order", 0))
        ],
        "players": players,
    }


def detail(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "match_id": raw["match_id"],
        "gold_adv": raw.get("radiant_gold_adv") or [],
        "xp_adv": raw.get("radiant_xp_adv") or [],
        "objectives": [
            {
                key: objective[key]
                for key in ("time", "type", "key", "team", "player_slot")
                if objective.get(key) is not None
            }
            for objective in raw.get("objectives") or []
            if objective.get("type") in KEPT_OBJECTIVES
        ],
    }


def _read(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="seconds")


def refresh_match_details(
    *,
    data_dir: Path,
    counted: list[dict[str, Any]],
    raw_by_id: dict[int, dict[str, Any]],
    client: Client,
    error_type: type[Exception],
    refresh_constants: bool,
    now: datetime | None = None,
) -> dict[str, int]:
    """Write matches.json, matches/{id}.json, constants.json and pending.json under data_dir."""
    now = now or datetime.now(UTC)
    constants_path = data_dir / "constants.json"
    constants = _read(constants_path)
    if refresh_constants or not constants.get("heroes"):
        try:
            constants = build_constants(client.get_json("/constants/heroes"), client.get_json("/constants/items"))
            _write(constants_path, constants)
        except error_type:
            if not constants.get("heroes"):
                raise

    previous = {str(match["match_id"]): match for match in _read(data_dir / "matches.json").get("matches", [])}
    previous_pending = _read(data_dir / "pending.json").get("matches", {})
    summaries: list[dict[str, Any]] = []
    pending: dict[str, dict[str, Any]] = {}
    fetched = 0

    for match in counted:
        match_id = match["match_id"]
        key = str(match_id)
        old = previous.get(key)
        entry = previous_pending.get(key)
        raw = raw_by_id.get(match_id)
        due = entry is None or datetime.fromisoformat(entry["next_check_utc"]) <= now
        if raw is None and old is not None and not (old["parse"] == "pending" and due):
            summaries.append(old)
            if entry is not None and old["parse"] == "pending":
                pending[key] = entry
            continue
        if raw is None:
            try:
                raw = client.get_json(f"/matches/{match_id}")
                fetched += 1
            except error_type:
                if old is not None:
                    summaries.append(old)
                if entry is not None:
                    pending[key] = entry
                continue

        summary = summarise(raw, constants)
        if summary["parse"] == "pending" and old is not None and old["parse"] == "unavailable":
            summary["parse"] = "unavailable"
        elif summary["parse"] == "pending":
            if entry is None:
                entry = {"first_seen_utc": _iso(now), "attempts": 0}
                try:
                    client.request_parse(match_id)
                except error_type:
                    pass
            if now - datetime.fromisoformat(entry["first_seen_utc"]) >= GIVE_UP_AFTER:
                summary["parse"] = "unavailable"
            else:
                attempts = entry["attempts"] + 1
                delay = RETRY_HOURS[min(attempts, len(RETRY_HOURS)) - 1]
                pending[key] = {**entry, "attempts": attempts, "next_check_utc": _iso(now + timedelta(hours=delay))}
        summaries.append(summary)
        _write(data_dir / "matches" / f"{match_id}.json", detail(raw))

    summaries.sort(key=lambda item: (item["start_time"], item["match_id"]))
    _write(data_dir / "matches.json", {"schema_version": 1, "generated_at_utc": _iso(now), "matches": summaries})
    _write(data_dir / "pending.json", {"matches": pending})
    return {"summaries": len(summaries), "fetched": fetched, "pending": len(pending)}
