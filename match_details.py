"""Per-match summaries, detail files and OpenDota parse retries for the stats page."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path
from typing import Any, Protocol

import httpx
from PIL import Image

# Bump when summaries or detail files gain fields; older matches are refetched once.
SUMMARY_VERSION = 10
IMAGE_CDN = "https://cdn.cloudflare.steamstatic.com"
HERO_IMAGE_SIZE = (128, 72)
ITEM_IMAGE_SIZE = (66, 48)
# OpenDota benchmark percentiles against public matches on the same hero (0-100).
BENCHMARKS = {
    "gpm": "gold_per_min", "xpm": "xp_per_min", "lhm": "last_hits_per_min",
    "hdm": "hero_damage_per_min", "td": "tower_damage", "death": "deaths_per_min",
    "heal": "hero_healing_per_min", "kpm": "kills_per_min", "apm": "assists_per_min",
}
# A lane is won or lost when one side's 10-minute gold in that lane leads by at least 10%.
LANE_EDGE = 0.1
HERO_NAMES_ZH = Path(__file__).with_name("hero_names_zh.json")
# Recheck unparsed matches after 1h, 2h, 4h, then every 8h until they are a week old.
RETRY_HOURS = (1, 2, 4, 8)
GIVE_UP_AFTER = timedelta(days=7)
# Full ward lifetimes in seconds; a ward gone sooner was destroyed.
WARD_SECONDS = {"obs": 360, "sen": 420}
# Heatmap cells are 2x2 OpenDota map cells (the map spans cells 64-192), bucketed per 10 minutes.
HEAT_BIN = 2
HEAT_PHASE_SECONDS = 600
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


def build_talents(
    heroes: dict[str, Any], hero_abilities: dict[str, Any], abilities: dict[str, Any], ability_ids: dict[str, Any]
) -> dict[str, list[dict[str, Any]]]:
    """Each hero's eight talents with tier (1-4 for levels 10/15/20/25), ability ID and English text."""
    id_by_key = {key: int(ability_id) for ability_id, key in ability_ids.items() if str(ability_id).isdigit()}
    talents: dict[str, list[dict[str, Any]]] = {}
    for hero in heroes.values():
        if not isinstance(hero, dict) or not isinstance(hero.get("id"), int):
            continue
        entries = []
        for talent in (hero_abilities.get(hero.get("name"), {}) or {}).get("talents", []):
            key = talent.get("name")
            if key in id_by_key and isinstance(talent.get("level"), int):
                entries.append({"id": id_by_key[key], "tier": talent["level"], "text": (abilities.get(key) or {}).get("dname") or key})
        if entries:
            talents[str(hero["id"])] = entries
    return talents


def build_constants(
    heroes: dict[str, Any],
    items: dict[str, Any],
    hero_abilities: dict[str, Any] | None = None,
    abilities: dict[str, Any] | None = None,
    ability_ids: dict[str, Any] | None = None,
) -> dict[str, Any]:
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
        "talents": build_talents(heroes, hero_abilities or {}, abilities or {}, ability_ids or {}),
        "heroes": {
            str(hero["id"]): {
                "name": names_zh.get(str(hero["id"])) or hero.get("localized_name") or str(hero["id"]),
                "key": hero.get("name") or "",
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


def _at_minute(series: Any, minute: int) -> int | None:
    return series[minute] if isinstance(series, list) and len(series) > minute else None


def lane_results(players: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """Compare each lane's 10-minute gold with the opposing side's players in the same lane."""
    groups: dict[tuple[str, bool], list[tuple[int, int]]] = {}
    for player in players:
        radiant = player.get("player_slot", 0) < 128
        lane = {1: "bot" if radiant else "top", 2: "mid", 3: "top" if radiant else "bot"}.get(player.get("lane_role"))
        gold = _at_minute(player.get("gold_t"), 10)
        if lane and gold is not None:
            groups.setdefault((lane, radiant), []).append((player["player_slot"], gold))
    results: dict[int, dict[str, Any]] = {}
    for (lane, radiant), members in groups.items():
        rivals = groups.get((lane, not radiant))
        if not rivals:
            continue
        own = sum(gold for _, gold in members)
        other = sum(gold for _, gold in rivals)
        edge = (own - other) / max(own, other, 1)
        result = "W" if edge >= LANE_EDGE else "L" if edge <= -LANE_EDGE else "D"
        for slot, _ in members:
            results[slot] = {"lane": result, "lane_diff": own - other}
    return results


def _talent_picks(player: dict[str, Any], talents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Per tier, the first talent the player took; `both` marks tiers where the other one was taken later too."""
    tier_by_id = {talent["id"]: talent["tier"] for talent in talents}
    picks: dict[int, dict[str, Any]] = {}
    for ability_id in player.get("ability_upgrades_arr") or []:
        tier = tier_by_id.get(ability_id)
        if tier is None:
            continue
        if tier in picks:
            picks[tier]["both"] = picks[tier]["id"] != ability_id or picks[tier]["both"]
        else:
            picks[tier] = {"tier": tier, "id": ability_id, "both": False}
    return [picks[tier] for tier in sorted(picks)]


def _largest_key(counts: Any) -> int:
    """Largest multi-kill size or kill streak recorded, 0 when there is none."""
    if not isinstance(counts, dict):
        return 0
    return max((int(key) for key in counts if str(key).isdigit()), default=0)


def _benchmarks(raw: Any) -> dict[str, int] | None:
    if not isinstance(raw, dict):
        return None
    result = {
        key: round(raw[source]["pct"] * 100)
        for key, source in BENCHMARKS.items()
        if isinstance(raw.get(source), dict) and isinstance(raw[source].get("pct"), (int, float))
    }
    return result or None


def summarise(raw: dict[str, Any], constants: dict[str, Any]) -> dict[str, Any]:
    items = constants.get("items", {})
    key_by_id = {item["id"]: key for key, item in items.items()}

    def item_key(item_id: Any) -> str | None:
        return key_by_id.get(item_id) if isinstance(item_id, int) and item_id > 0 else None

    def major(key: str | None) -> bool:
        return bool(key and items.get(key, {}).get("major"))

    lanes = lane_results(raw.get("players") or [])
    talents_by_hero = constants.get("talents", {})
    stolen_by_slot: dict[Any, int] = {}
    for objective in raw.get("objectives") or []:
        if objective.get("type") == "CHAT_MESSAGE_AEGIS_STOLEN":
            stolen_by_slot[objective.get("player_slot")] = stolen_by_slot.get(objective.get("player_slot"), 0) + 1
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
                "lane_role": player.get("lane_role"),
                "gold10": _at_minute(player.get("gold_t"), 10),
                "lh10": _at_minute(player.get("lh_t"), 10),
                "xp10": _at_minute(player.get("xp_t"), 10),
                "lane": lanes.get(player.get("player_slot"), {}).get("lane"),
                "lane_diff": lanes.get(player.get("player_slot"), {}).get("lane_diff"),
                "bm": _benchmarks(player.get("benchmarks")),
                "tf": round(player["teamfight_participation"], 3)
                if isinstance(player.get("teamfight_participation"), (int, float)) else None,
                "obs": player.get("obs_placed"),
                "sen": player.get("sen_placed"),
                "stacks": player.get("camps_stacked"),
                "stuns": round(player["stuns"], 1) if isinstance(player.get("stuns"), (int, float)) else None,
                "talents": _talent_picks(player, talents_by_hero.get(str(player.get("hero_id")), [])),
                "multi": _largest_key(player.get("multi_kills")),
                "streak": _largest_key(player.get("kill_streaks")),
                "taken": sum(
                    value for source, value in (player.get("damage_taken") or {}).items()
                    if source.startswith("npc_dota_hero_") and isinstance(value, (int, float))
                ) if player.get("damage_taken") else None,
                "fb": int(bool(player.get("firstblood_claimed"))),
                "aegis_stolen": stolen_by_slot.get(player.get("player_slot"), 0),
            }
        )
    return {
        "v": SUMMARY_VERSION,
        "match_id": raw["match_id"],
        "start_time": raw.get("start_time"),
        "duration": raw.get("duration"),
        "radiant_win": raw.get("radiant_win"),
        "radiant_score": raw.get("radiant_score"),
        "dire_score": raw.get("dire_score"),
        "parse": "parsed" if is_parsed(raw) else "pending",
        # Largest gold lead each side ever held, from the Radiant gold-advantage curve.
        "max_lead": {
            "radiant": max([0, *(raw.get("radiant_gold_adv") or [])]),
            "dire": -min([0, *(raw.get("radiant_gold_adv") or [])]),
        },
        "picks_bans": [
            [entry.get("order"), int(bool(entry.get("is_pick"))), entry.get("team"), entry.get("hero_id")]
            for entry in sorted(raw.get("picks_bans") or [], key=lambda item: item.get("order", 0))
        ],
        "players": players,
    }


def wards(raw: dict[str, Any], constants: dict[str, Any]) -> list[list[Any]]:
    """[kind (0 observer, 1 sentry), owner slot, placed second, x, y, lifetime or None if alive at the end,
    1 if destroyed early else 0, destroyer slot or None]."""
    duration = raw.get("duration") or 0
    slot_by_key = {
        constants.get("heroes", {}).get(str(player.get("hero_id")), {}).get("key"): player.get("player_slot")
        for player in raw.get("players") or []
    }
    rows = []
    for player in raw.get("players") or []:
        for kind, log in enumerate(("obs", "sen")):
            gone_log = sorted(player.get(f"{log}_left_log") or [], key=lambda entry: entry.get("time", 0))
            for placed in sorted(player.get(f"{log}_log") or [], key=lambda entry: entry.get("time", 0)):
                gone = next(
                    (entry for entry in gone_log
                     if entry.get("ehandle") == placed.get("ehandle") and entry.get("time", 0) >= placed.get("time", 0)),
                    None,
                )
                if gone is not None:
                    gone_log.remove(gone)
                    if gone["time"] >= duration - 1:
                        gone = None
                life = gone["time"] - placed["time"] if gone else None
                destroyed = life is not None and life < WARD_SECONDS[log] - 2
                rows.append([
                    kind, player.get("player_slot"), placed.get("time"),
                    round(placed.get("x", 0), 1), round(placed.get("y", 0), 1), life, int(destroyed),
                    slot_by_key.get(gone.get("attackername")) if destroyed else None,
                ])
    return sorted(rows, key=lambda row: (row[2], row[1]))


def lane_heat(raw: dict[str, Any]) -> dict[str, Any]:
    """OpenDota's laning-phase positions (one sample per second up to 10:00) in the whole-game heatmap layout."""
    players: dict[str, list[int]] = {}
    for player in raw.get("players") or []:
        counts: dict[tuple[int, int], int] = {}
        for x, column in (player.get("lane_pos") or {}).items():
            for y, seconds in column.items():
                cell = ((int(x) - 64) // HEAT_BIN, (int(y) - 64) // HEAT_BIN)
                counts[cell] = counts.get(cell, 0) + seconds
        if counts:
            players[str(player.get("player_slot"))] = [
                value for (cx, cy), seconds in sorted(counts.items()) for value in (0, cx, cy, seconds)
            ]
    return {"bin": HEAT_BIN, "phase_seconds": HEAT_PHASE_SECONDS, "duration": 600, "players": players}


def deaths(raw: dict[str, Any]) -> list[list[Any]]:
    """[victim slot, second, killer unit name, gold lost, seconds dead] from OpenDota's per-player death log."""
    rows = [
        [player.get("player_slot"), entry.get("time"), entry.get("key"), entry.get("gold_lost"), entry.get("time_dead")]
        for player in raw.get("players") or []
        for entry in player.get("deaths_log") or []
    ]
    return sorted(rows, key=lambda row: (row[1] or 0, row[0]))


def buybacks(raw: dict[str, Any]) -> list[list[Any]]:
    return sorted(
        [player.get("player_slot"), entry.get("time")]
        for player in raw.get("players") or []
        for entry in player.get("buyback_log") or []
    )


# Per-minute laning series are kept up to this minute.
SERIES_MINUTES = 15


def series(raw: dict[str, Any]) -> dict[str, dict[str, list[int]]]:
    """Each player's net worth, XP, last hits and denies at minutes 0..15."""
    keys = {"gold": "gold_t", "xp": "xp_t", "lh": "lh_t", "dn": "dn_t"}
    return {
        str(player.get("player_slot")): {
            key: list(player.get(source) or [])[: SERIES_MINUTES + 1] for key, source in keys.items()
        }
        for player in raw.get("players") or []
        if any(player.get(source) for source in keys.values())
    }


# OpenDota rune types: 5 bounty, 7 water, 8 wisdom; the rest are power runes.
RUNE_KINDS = {"5": "bounty", "7": "water", "8": "wisdom"}
LANING_SECONDS = 600


def laning(raw: dict[str, Any], constants: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Laning-phase extras per player: runes taken and camps stacked by 10:00, boots and first major item times."""
    items = constants.get("items", {})
    result = {}
    for player in raw.get("players") or []:
        runes = {"power": 0, "bounty": 0, "water": 0, "wisdom": 0}
        for entry in player.get("runes_log") or []:
            if (entry.get("time") or 0) < LANING_SECONDS:
                runes[RUNE_KINDS.get(str(entry.get("key")), "power")] += 1
        purchases = sorted(player.get("purchase_log") or [], key=lambda entry: entry.get("time") or 0)
        boots = next((entry["time"] for entry in purchases if entry.get("key") == "boots" or entry.get("key") in BOOTS), None)
        first = next(([entry["time"], entry["key"]] for entry in purchases
                      if items.get(entry.get("key"), {}).get("major") and entry.get("key") not in BOOTS), None)
        stacked = player.get("camps_stacked_t") or []
        result[str(player.get("player_slot"))] = {
            "runes": runes,
            "stacks": stacked[10] if len(stacked) > 10 else (stacked[-1] if stacked else None),
            "boots": boots,
            "first_item": first,
        }
    return result


def detail(raw: dict[str, Any], constants: dict[str, Any]) -> dict[str, Any]:
    return {
        "match_id": raw["match_id"],
        "series": series(raw),
        "laning": laning(raw, constants),
        "deaths": deaths(raw),
        "buybacks": buybacks(raw),
        "wards": wards(raw, constants),
        "lane_heat": lane_heat(raw),
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


def schedule_retry(entry: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Count one more failed check and wait 1, 2, 4, then 8 hours before the next one."""
    attempts = entry["attempts"] + 1
    delay = RETRY_HOURS[min(attempts, len(RETRY_HOURS)) - 1]
    return {**entry, "attempts": attempts, "next_check_utc": _iso(now + timedelta(hours=delay))}


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
    stale = not constants.get("heroes") or "talents" not in constants or not all(
        hero.get("key") for hero in constants["heroes"].values()
    )
    if refresh_constants or stale:
        try:
            constants = build_constants(
                client.get_json("/constants/heroes"),
                client.get_json("/constants/items"),
                client.get_json("/constants/hero_abilities"),
                client.get_json("/constants/abilities"),
                client.get_json("/constants/ability_ids"),
            )
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
        current = old is not None and old.get("v") == SUMMARY_VERSION
        if raw is None and current and not (old["parse"] == "pending" and due):
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
                pending[key] = schedule_retry(entry, now)
        summaries.append(summary)
        _write(data_dir / "matches" / f"{match_id}.json", detail(raw, constants))

    summaries.sort(key=lambda item: (item["start_time"], item["match_id"]))
    _write(data_dir / "matches.json", {"schema_version": 1, "generated_at_utc": _iso(now), "matches": summaries})
    _write(data_dir / "pending.json", {**_read(data_dir / "pending.json"), "matches": pending})
    return {"summaries": len(summaries), "fetched": fetched, "pending": len(pending)}


def ensure_images(*, image_dir: Path, data_dir: Path, http: httpx.Client) -> int:
    """Save small WebP copies of every hero image and of each item seen in a summary."""
    constants = _read(data_dir / "constants.json")
    heroes = constants.get("heroes", {})
    items = constants.get("items", {})
    used = {
        key
        for match in _read(data_dir / "matches.json").get("matches", [])
        for player in match.get("players", [])
        for key in [*player.get("items", []), *player.get("backpack", []), player.get("neutral"),
                    player.get("enchant"), *player.get("built", {})]
        if key in items
    }
    wanted = [
        *((image_dir / "heroes" / f"{hero_id}.webp", hero.get("img"), HERO_IMAGE_SIZE) for hero_id, hero in heroes.items()),
        *((image_dir / "items" / f"{key}.webp", items[key].get("img"), ITEM_IMAGE_SIZE) for key in sorted(used)),
    ]
    saved = 0
    for path, source, size in wanted:
        if path.exists() or not source:
            continue
        try:
            response = http.get(IMAGE_CDN + source)
            response.raise_for_status()
            image = Image.open(BytesIO(response.content))
            image.thumbnail(size)
            path.parent.mkdir(parents=True, exist_ok=True)
            image.save(path, "WEBP", quality=82)
            saved += 1
        except (httpx.HTTPError, OSError):
            continue
    return saved
