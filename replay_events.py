"""Events derived from our own replay parses, and the cross-match death index built from them.

Positions are OpenDota map cells (about 64-192 on both axes, one cell = 128 game units, y points north).
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Iterable

from match_details import _read, _write

# Bump when derived replay data gains or changes fields; older matches are re-parsed once.
REPLAY_VERSION = 1
NEAR_CELLS = 1200 / 128
# The river runs from the top-left Roshan pit (92, 141) to the bottom-right one (148, 106); checked against
# Roshan kills, tower TP landings and rune pickups. Radiant is below the line.
RIVER_SLOPE = -0.625
RIVER_POINT = (92.0, 141.0)
RIVER_HALF_WIDTH = 4.0
FOUNTAINS = {True: (75.0, 79.0), False: (179.0, 173.5)}
BASE_RADIUS = 28.0
# Objectives counted as "lost" when the enemy takes them this soon after a death.
LOSS_WINDOW = 90
INDEX_COLUMNS = [
    "match_id", "slot", "t", "killer", "gold_lost", "time_dead", "buyback",
    "region", "allies", "enemies", "attackers", "x", "y", "lost",
]


def player_slot(index: int) -> int:
    return index if index < 5 else 128 + index - 5


def river_offset(x: float, y: float) -> float:
    """Signed distance in cells from the river's centre line; positive is the Dire side."""
    x0, y0 = RIVER_POINT
    return (y - y0 - RIVER_SLOPE * (x - x0)) / math.hypot(1.0, RIVER_SLOPE)


def region(x: float, y: float, radiant: bool) -> str:
    for own in (True, False):
        fx, fy = FOUNTAINS[radiant if own else not radiant]
        if math.hypot(x - fx, y - fy) <= BASE_RADIUS:
            return "own_base" if own else "enemy_base"
    offset = river_offset(x, y)
    if abs(offset) <= RIVER_HALF_WIDTH:
        return "river"
    return "own_half" if (offset < 0) == radiant else "enemy_half"


def _hero_slots(slots_hero: dict[int, int], hero_keys: dict[str, str]) -> dict[str, int]:
    return {hero_keys[str(hero_id)]: index for index, hero_id in slots_hero.items() if hero_keys.get(str(hero_id))}


def death_events(entries: Iterable[dict[str, Any]], hero_keys: dict[str, str]) -> list[dict[str, Any]]:
    """Every hero death with where it happened, who was near, who hit the victim and the whole map at that moment.

    Deaths come from the game's own per-player death counter (the parser's death_tick events, the same source as
    OpenDota's death counts), so Wraith King reincarnations and Meepo clones are counted as the game counts them.
    The position is the victim's last living second; the combat log adds the killer and the enemy heroes that
    damaged the victim in the 10 seconds before.
    """
    track: dict[int, dict[int, tuple[float, float, bool]]] = {}
    slots_hero: dict[int, int] = {}
    ticks: list[tuple[int, int]] = []
    kills: list[tuple[float, str, str]] = []
    hits: list[tuple[float, str, str]] = []
    for entry in entries:
        kind = entry.get("type")
        if kind == "death_tick" and entry.get("slot") is not None:
            ticks.extend([(int(entry["slot"]), int(entry["time"]))] * max(1, int(entry.get("value") or 1)))
        elif kind == "interval":
            if entry.get("x") is None or entry.get("slot") is None or not isinstance(entry.get("time"), (int, float)):
                continue
            track.setdefault(entry["slot"], {})[int(entry["time"])] = (entry["x"], entry["y"], entry.get("life_state") == 0)
            if entry.get("hero_id"):
                slots_hero[entry["slot"]] = entry["hero_id"]
        elif kind == "DOTA_COMBATLOG_DEATH" and entry.get("targethero") and not entry.get("targetillusion"):
            kills.append((entry["time"], entry.get("targetname"), entry.get("attackername")))
        elif (kind == "DOTA_COMBATLOG_DAMAGE" and entry.get("attackerhero") and entry.get("targethero")
              and not entry.get("targetillusion")):
            hits.append((entry["time"], entry.get("attackername"), entry.get("targetname")))

    slot_of = _hero_slots(slots_hero, hero_keys)
    key_of = {index: key for key, index in slot_of.items()}
    events = []
    for index, moment in sorted(ticks, key=lambda tick: (tick[1], tick[0])):
        seconds = track.get(index, {})
        before = next((second for second in range(moment, moment - 6, -1) if seconds.get(second, (0, 0, False))[2]), None)
        if before is None:
            before = max((second for second in seconds if second <= moment), default=None)
        if before is None:
            continue
        x, y, _ = seconds[before]
        radiant = index < 5
        victim = key_of.get(index)
        kill = min((kill for kill in kills if kill[1] == victim and abs(kill[0] - moment) <= 1),
                   key=lambda kill: abs(kill[0] - moment), default=None)
        attackers = {
            slot_of[attacker] for time, attacker, target in hits
            if target == victim and moment - 10 <= time <= moment and attacker in slot_of
            and (slot_of[attacker] < 5) != radiant
        }
        killer = slot_of.get(kill[2]) if kill else None
        if killer is not None and (killer < 5) != radiant:
            attackers.add(killer)
        snapshot, allies, enemies = [], 0, 0
        for other in range(10):
            spot = track.get(other, {}).get(before)
            if not spot or not spot[2]:
                snapshot.append(None)
                continue
            snapshot.append([round(spot[0], 1), round(spot[1], 1)])
            if other != index and math.hypot(spot[0] - x, spot[1] - y) <= NEAR_CELLS:
                if (other < 5) == radiant:
                    allies += 1
                else:
                    enemies += 1
        events.append({
            "slot": player_slot(index),
            "t": int(moment),
            "x": round(x, 1),
            "y": round(y, 1),
            "region": region(x, y, radiant),
            "allies": allies,
            "enemies": enemies,
            "attackers": sorted(player_slot(slot) for slot in attackers),
            "killer": player_slot(killer) if killer is not None else None,
            "killer_unit": None if killer is not None else (kill[2] if kill else None),
            "snapshot": snapshot,
        })
    return sorted(events, key=lambda event: (event["t"], event["slot"]))


def _lost_after(objectives: list[dict[str, Any]], radiant: bool, start: int) -> list[str]:
    own = "goodguys" if radiant else "badguys"
    lost = []
    for objective in objectives:
        time = objective.get("time") or 0
        if not start < time <= start + LOSS_WINDOW:
            continue
        if objective.get("type") == "building_kill" and own in str(objective.get("key")):
            key = str(objective["key"])
            kind = "tower" if "tower" in key else "barracks" if "rax" in key else "ancient" if "fort" in key else None
            if kind and kind not in lost:
                lost.append(kind)
        elif objective.get("type") == "CHAT_MESSAGE_ROSHAN_KILL" and (objective.get("team") == 2) != radiant:
            if "roshan" not in lost:
                lost.append("roshan")
    return lost


def build_death_index(data_dir: Path) -> int:
    """Join OpenDota's death log (gold, respawn, buyback) with replay positions into site/data/deaths.json."""
    constants = _read(data_dir / "constants.json")
    hero_of_key = {hero.get("key"): int(hero_id) for hero_id, hero in constants.get("heroes", {}).items() if hero.get("key")}
    rows = []
    for match in _read(data_dir / "matches.json").get("matches", []):
        match_id = match["match_id"]
        detail = _read(data_dir / "matches" / f"{match_id}.json")
        replay = _read(data_dir / "replay" / f"{match_id}.json")
        slot_of_hero = {player.get("hero"): player.get("slot") for player in match.get("players", [])}
        logged = detail.get("deaths", [])
        positioned = replay.get("deaths", []) if replay.get("v") == REPLAY_VERSION else []
        if positioned:
            # The replay's deaths follow the game's death counter; OpenDota's log adds gold, respawn time and a
            # killer that credits summons to their owner (its log can list extra Meepo clone deaths, which drop out).
            unused = list(logged)
            for event in positioned:
                row = min((row for row in unused if row[0] == event["slot"] and abs(row[1] - event["t"]) <= 3),
                          key=lambda row: abs(row[1] - event["t"]), default=None)
                if row is not None:
                    unused.remove(row)
                killer = event["killer"] if event["killer"] is not None else event["killer_unit"]
                if row is not None and row[2]:
                    owner = slot_of_hero.get(hero_of_key.get(row[2]))
                    killer = owner if owner is not None else row[2]
                rows.append(_index_row(match, detail, event["slot"], event["t"], killer,
                                       row[3] if row else None, row[4] if row else None, event))
        else:
            for slot, time, killer_key, gold, dead in logged:
                killer = slot_of_hero.get(hero_of_key.get(killer_key)) if killer_key else None
                rows.append(_index_row(match, detail, slot, time, killer if killer is not None else killer_key,
                                       gold, dead, None))
    rows.sort(key=lambda row: (row[0], row[2], row[1]))
    _write(data_dir / "deaths.json", {"columns": INDEX_COLUMNS, "rows": rows})
    return len(rows)


def _index_row(match: dict[str, Any], detail: dict[str, Any], slot: int, time: int, killer: Any,
               gold: Any, dead: Any, event: dict[str, Any] | None) -> list[Any]:
    radiant = slot < 128
    window = dead if isinstance(dead, (int, float)) and dead > 0 else 120
    bought = any(row[0] == slot and time <= row[1] <= time + window for row in detail.get("buybacks", []))
    return [
        match["match_id"], slot, time, killer, gold, dead, int(bought),
        event["region"] if event else None, event["allies"] if event else None,
        event["enemies"] if event else None, len(event["attackers"]) if event else None,
        event["x"] if event else None, event["y"] if event else None,
        _lost_after(detail.get("objectives", []), radiant, time),
    ]
