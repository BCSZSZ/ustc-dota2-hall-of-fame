"""Events derived from our own replay parses, and the cross-match death index built from them.

Positions are OpenDota map cells (about 64-192 on both axes, one cell = 128 game units, y points north).
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Iterable

from match_details import _read, _write

# Bump when derived replay data gains or changes fields; older matches are re-parsed once.
REPLAY_VERSION = 4
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
# Where the three lanes are fought during the laning phase: the mean of each laner's median position between
# 2:00 and 8:00, from the first 14 league replays. Nearest anchor matches OpenDota's lane for 138 of 140 heroes;
# the other two were junglers, more than 30 cells from every anchor.
LANE_ANCHORS = {"top": (83.1, 160.5), "mid": (125.8, 126.6), "bot": (172.7, 93.1)}
# A hero's lane is the anchor its 2:00-8:00 median position lies within LANE_RADIUS of; otherwise it jungled.
LANE_RADIUS = 18.0
# Per second, a hero is in a lane while within ZONE_RADIUS of its anchor (90% of laners' seconds are within ~21).
ZONE_RADIUS = 24.0
LANE_WINDOW = (120, 480)
LANING_END = 600
ROAM_MIN_SECONDS = 30
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


def _nearest_lane(x: float, y: float, radius: float) -> str | None:
    lane, (ax, ay) = min(LANE_ANCHORS.items(), key=lambda item: math.hypot(x - item[1][0], y - item[1][1]))
    return lane if math.hypot(x - ax, y - ay) <= radius else None


def lane_events(entries: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Each hero's laning-phase lane, its roams to other lanes and its time away from its own lane.

    A roam is 30 seconds or more spent in another lane's zone before 10:00. Time in the jungle, the river or
    near the base is counted as away from the lane but is not a roam. For a jungler every 30-second stay in a
    lane zone is recorded the same way; those are its gank attempts.
    """
    track: dict[int, dict[int, tuple[float, float]]] = {}
    for entry in entries:
        if (entry.get("type") == "interval" and entry.get("x") is not None and entry.get("slot") is not None
                and isinstance(entry.get("time"), (int, float)) and 0 <= entry["time"] <= LANING_END
                and entry.get("life_state") == 0):
            track.setdefault(entry["slot"], {})[int(entry["time"])] = (entry["x"], entry["y"])
    lanes: dict[str, str] = {}
    roams: list[list[Any]] = []
    away: dict[str, int] = {}
    for index, seconds in sorted(track.items()):
        slot = player_slot(index)
        window = [seconds[t] for t in sorted(seconds) if LANE_WINDOW[0] <= t <= LANE_WINDOW[1]]
        if not window:
            continue
        xs = sorted(x for x, _ in window)
        ys = sorted(y for _, y in window)
        own = _nearest_lane(xs[len(xs) // 2], ys[len(ys) // 2], LANE_RADIUS) or "jungle"
        lanes[str(slot)] = own
        radiant = index < 5
        current, start, previous, outside = None, None, None, 0
        for t in sorted(seconds):
            if t < 90:
                continue
            x, y = seconds[t]
            zone = _nearest_lane(x, y, ZONE_RADIUS)
            if zone != own and region(x, y, radiant) != "own_base":
                outside += 1
            visiting = zone if zone not in (None, own) else None
            if visiting != current or (previous is not None and t - previous > 1):
                if current and previous - start + 1 >= ROAM_MIN_SECONDS:
                    roams.append([slot, start, previous, current])
                current, start = visiting, t
            previous = t
        if current and previous - start + 1 >= ROAM_MIN_SECONDS:
            roams.append([slot, start, previous, current])
        if own != "jungle":
            away[str(slot)] = outside
    return {"lanes": lanes, "roams": sorted(roams, key=lambda roam: (roam[1], roam[0])), "away": away}


def level_events(entries: Iterable[dict[str, Any]]) -> dict[str, list[Any]]:
    """Per player: the second it reached level 6, and its level at 5:00 and at 10:00, from the per-second state."""
    seen: dict[int, dict[int, int]] = {}
    for entry in entries:
        if entry.get("type") == "interval" and entry.get("slot") is not None and isinstance(entry.get("level"), int) \
                and isinstance(entry.get("time"), (int, float)) and entry["time"] >= 0:
            seen.setdefault(entry["slot"], {})[int(entry["time"])] = entry["level"]
    levels = {}
    for index, by_time in sorted(seen.items()):
        times = sorted(by_time)
        at = lambda moment: next((by_time[t] for t in reversed(times) if t <= moment), None)
        sixth = next((t for t in times if by_time[t] >= 6), None)
        levels[str(player_slot(index))] = [sixth, at(300), at(600)]
    return {"levels": levels}


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


LANE_COLUMNS = [
    "match_id", "slot", "lane", "role", "source", "opp", "lh5", "lh10", "dn10", "gold5", "gold10", "xp5", "xp10",
    "opp_lh5", "opp_lh10", "opp_gold5", "opp_gold10", "opp_xp10", "result", "lane_diff", "kills", "away", "obs", "sen",
    "deaths", "roams", "ganks", "short_lane", "group", "kind", "dewards",
    "level6", "lvl5", "lvl10", "opp_level6", "opp_lvl10", "curve_lh", "curve_gold", "curve_xp", "curve_lane",
    "runes", "stacks", "boots", "first_item", "fb", "roam_kills", "roam_swing", "obs_life", "obs_lost",
]
# Per-minute curves of the laning phase run from 0:00 to this minute.
CURVE_MINUTES = 12
# A gank attempt succeeded when the jungler hit an enemy hero who died within this many seconds after it left.
GANK_GRACE = 5
# OpenDota's lane_role (1 safe, 2 mid, 3 off, 4 jungle) as a physical lane, used until the replay is parsed.
LANE_EDGE = 0.1


def _opendota_lane(radiant: bool, lane_role: Any) -> str:
    return {2: "mid", 1: "bot" if radiant else "top", 3: "top" if radiant else "bot"}.get(lane_role, "jungle")


def _role(radiant: bool, lane: str) -> str:
    if lane in ("mid", "jungle"):
        return lane
    return "safe" if (lane == "bot") == radiant else "off"


def diff(a: Any, b: Any) -> Any:
    return a - b if isinstance(a, (int, float)) and isinstance(b, (int, float)) else None


def _at(values: list[Any], minute: int) -> Any:
    return values[minute] if isinstance(values, list) and len(values) > minute else None


def _short_lane(slot: int, players: list[dict[str, Any]], lane_of: dict[int, str]) -> tuple[str, int, int] | None:
    """The lane a jungler's side is short in: the biggest deficit, preferring a lane someone still held."""
    count = lambda lane, radiant: sum(lane_of[p["slot"]] == lane and (p["slot"] < 128) == radiant for p in players)
    short = [(count(lane, slot >= 128) - count(lane, slot < 128), count(lane, slot < 128), lane)
             for lane in ("top", "mid", "bot") if count(lane, slot < 128) < count(lane, slot >= 128)]
    if not short:
        return None
    _, held, lane = max(short)
    return lane, held, count(lane, slot >= 128)


def _is_core(pos: Any) -> bool:
    return isinstance(pos, int) and pos <= 3


def _pair(side_a: list[dict[str, Any]], side_b: list[dict[str, Any]], pos_of: dict[int, Any]) -> list[tuple[int, int]]:
    """Pair a lane's two sides core with core and support with support, then any leftovers in position order."""
    order = lambda players: sorted(players, key=lambda player: (pos_of.get(player["slot"]) or 9, player["slot"]))
    pairs, left_a, left_b = [], [], []
    for core in (True, False):
        a = order([player for player in side_a if _is_core(pos_of.get(player["slot"])) == core])
        b = order([player for player in side_b if _is_core(pos_of.get(player["slot"])) == core])
        pairs += [(x["slot"], y["slot"]) for x, y in zip(a, b)]
        left_a += a[len(b):]
        left_b += b[len(a):]
    pairs += [(x["slot"], y["slot"]) for x, y in zip(order(left_a), order(left_b))]
    return pairs


def build_lane_index(data_dir: Path) -> int:
    """Per player and match: laning-phase lane, final position, counterpart, 5/10-minute numbers, deaths, roams.

    Writes site/data/lanes.json and site/data/positions.json. The lane comes from site/data/lane_overrides.json
    when set there, then from the replay, then from OpenDota. Positions are OpenDota's estimate except for a
    jungler and the teammate left alone in the lane its side is short in: whichever had more net worth at 10:00 is
    that lane's core (1 in the safe lane, 3 in the off lane) and the other its support (5 or 4).
    site/data/position_overrides.json overrides both. A jungler is grouped with that short lane (column "group";
    "lane" stays "jungle"), so it is paired and counted there. Counterparts pair core with core and support with
    support; "kind" is core for positions 1-3.
    """
    overrides = _read(data_dir / "lane_overrides.json")
    position_overrides = _read(data_dir / "position_overrides.json")
    positions: dict[str, dict[str, Any]] = {}
    rows = []
    for match in _read(data_dir / "matches.json").get("matches", []):
        match_id = match["match_id"]
        detail = _read(data_dir / "matches" / f"{match_id}.json")
        replay = _read(data_dir / "replay" / f"{match_id}.json")
        replay = replay if replay.get("v") == REPLAY_VERSION else {}
        series = detail.get("series", {})
        players = sorted(match.get("players", []), key=lambda player: player["slot"])
        lane_of, source_of = {}, {}
        for player in players:
            slot = player["slot"]
            manual = (overrides.get(str(match_id)) or {}).get(str(slot))
            if manual:
                lane_of[slot], source_of[slot] = manual, "manual"
            elif str(slot) in replay.get("lanes", {}):
                lane_of[slot], source_of[slot] = replay["lanes"][str(slot)], "replay"
            else:
                lane_of[slot], source_of[slot] = _opendota_lane(slot < 128, player.get("lane_role")), "opendota"
        value = lambda slot, key, minute: _at((series.get(str(slot)) or {}).get(key), minute)
        pos_of = {player["slot"]: player.get("pos") for player in players}
        pos_source = {}
        for player in players:
            slot = player["slot"]
            short = _short_lane(slot, players, lane_of) if lane_of[slot] == "jungle" else None
            mates = [p["slot"] for p in players if short and lane_of[p["slot"]] == short[0] and (p["slot"] < 128) == (slot < 128)]
            if short and len(mates) == 1:
                core, support = (1, 5) if _role(slot < 128, short[0]) == "safe" else (3, 4)
                jungler_core = (value(slot, "gold", 10) or 0) >= (value(mates[0], "gold", 10) or 0)
                pos_of[slot], pos_of[mates[0]] = (core, support) if jungler_core else (support, core)
                pos_source[slot] = pos_source[mates[0]] = "jungle"
        for slot, pos in (position_overrides.get(str(match_id)) or {}).items():
            if int(slot) in pos_of:
                pos_of[int(slot)], pos_source[int(slot)] = int(pos), "manual"
        for player in players:
            if pos_of[player["slot"]] != player.get("pos"):
                positions.setdefault(str(match_id), {})[str(player["slot"])] = {
                    "pos": pos_of[player["slot"]], "source": pos_source.get(player["slot"], "jungle"), "opendota": player.get("pos")}
        # A jungler belongs with the lane its side is short in: it is compared there like a laner, with a tag.
        group_of = {}
        for player in players:
            slot = player["slot"]
            short = _short_lane(slot, players, lane_of) if lane_of[slot] == "jungle" else None
            group_of[slot] = short[0] if short else lane_of[slot]
        opp, result, lane_diff = {}, {}, {}
        for lane in ("top", "mid", "bot"):
            sides = [[player for player in players if group_of[player["slot"]] == lane and (player["slot"] < 128) == radiant]
                     for radiant in (True, False)]
            for mine, theirs in _pair(sides[0], sides[1], pos_of):
                opp[mine], opp[theirs] = theirs, mine
            totals = [sum(value(player["slot"], "gold", 10) or 0 for player in side) for side in sides]
            if all(sides):
                for index, side in enumerate(sides):
                    own, other = totals[index], totals[1 - index]
                    edge = (own - other) / max(own, other, 1)
                    for player in side:
                        result[player["slot"]] = "W" if edge >= LANE_EDGE else "L" if edge <= -LANE_EDGE else "D"
                        lane_diff[player["slot"]] = own - other
        early = [death for death in replay.get("deaths", []) if death["t"] < LANING_END]
        for player in players:
            slot = player["slot"]
            own_deaths = []
            logged = [row for row in detail.get("deaths", []) if row[0] == slot]
            for death in (death for death in early if death["slot"] == slot):
                attackers = death["attackers"]
                kind = ("other" if not attackers else "gank" if any(group_of.get(a) != group_of[slot] for a in attackers)
                        else "solo" if len(attackers) == 1 else "lane")
                gold_lost = next((row[3] for row in logged if abs((row[1] or 0) - death["t"]) <= 3), None)
                own_deaths.append([death["t"], kind, attackers, death.get("region"), gold_lost])
            other = opp.get(slot)
            wards = [ward for ward in detail.get("wards", []) if ward[1] == slot and ward[2] < LANING_END]
            dewards = sum(1 for ward in detail.get("wards", []) if ward[6] and ward[7] == slot
                          and ward[5] is not None and ward[2] + ward[5] < LANING_END)
            ganks = short_lane = None
            if lane_of[slot] == "jungle" and replay:
                ganks = []
                for roam in (roam for roam in replay.get("roams", []) if roam[0] == slot):
                    _, start, end, lane = roam
                    kills = [death["slot"] for death in early if start <= death["t"] <= end + GANK_GRACE and slot in death["attackers"]]
                    died = any(death["slot"] == slot and start <= death["t"] <= end + GANK_GRACE for death in early)
                    ganks.append([start, end, lane, kills, int(died)])
            if lane_of[slot] == "jungle":
                short = _short_lane(slot, players, lane_of)
                if short:
                    short_lane = [*short, result.get(slot)]
            radiant = slot < 128
            group = [p["slot"] for p in players if group_of[p["slot"]] == group_of[slot]]
            curve = lambda key: [diff(value(slot, key, minute), value(other, key, minute)) if other is not None else None
                                 for minute in range(CURVE_MINUTES + 1)]
            lane_total = lambda minute, side: sum(value(s2, "gold", minute) or 0 for s2 in group if (s2 < 128) == side)
            curve_lane = ([lane_total(minute, radiant) - lane_total(minute, not radiant) for minute in range(CURVE_MINUTES + 1)]
                          if group_of[slot] in ("top", "mid", "bot") and series else None)
            own_roams = [roam for roam in replay.get("roams", []) if roam[0] == slot] if lane_of[slot] != "jungle" else []
            roam_kills = sum(1 for roam in own_roams for death in early
                             if roam[1] <= death["t"] <= roam[2] + GANK_GRACE and slot in death["attackers"])
            roam_swing = sum((lane_total(min(roam[2] // 60 + 1, CURVE_MINUTES), radiant) - lane_total(min(roam[2] // 60 + 1, CURVE_MINUTES), not radiant))
                             - (lane_total(roam[1] // 60, radiant) - lane_total(roam[1] // 60, not radiant)) for roam in own_roams) if own_roams and series else None
            first_blood = min(early, key=lambda death: death["t"], default=None) if replay else None
            fb = (None if not first_blood else "death" if first_blood["slot"] == slot
                  else "kill" if slot in first_blood["attackers"] else None)
            observers = [ward for ward in wards if ward[0] == 0]
            lived = [ward[5] for ward in observers if ward[5] is not None]
            level = (replay.get("levels") or {}).get(str(slot)) or [None, None, None]
            opp_level = (replay.get("levels") or {}).get(str(other)) or [None, None, None] if other is not None else [None, None, None]
            extra = (detail.get("laning") or {}).get(str(slot)) or {}
            rows.append([
                match_id, slot, lane_of[slot], _role(slot < 128, group_of[slot]), source_of[slot], other,
                value(slot, "lh", 5), value(slot, "lh", 10), value(slot, "dn", 10), value(slot, "gold", 5),
                value(slot, "gold", 10), value(slot, "xp", 5), value(slot, "xp", 10),
                *(value(other, key, minute) if other is not None else None
                  for key, minute in (("lh", 5), ("lh", 10), ("gold", 5), ("gold", 10), ("xp", 10))),
                result.get(slot), lane_diff.get(slot),
                sum(slot in death["attackers"] for death in early) if replay else None,
                replay.get("away", {}).get(str(slot)),
                sum(ward[0] == 0 for ward in wards), sum(ward[0] == 1 for ward in wards),
                own_deaths if replay else None,
                [roam[1:] for roam in replay.get("roams", []) if roam[0] == slot] if replay and lane_of[slot] != "jungle" else ([] if replay else None),
                ganks, short_lane, group_of[slot], "core" if _is_core(pos_of[slot]) else "support", dewards,
                level[0], level[1], level[2], opp_level[0], opp_level[2],
                curve("lh"), curve("gold"), curve("xp"), curve_lane,
                extra.get("runes"), extra.get("stacks"), extra.get("boots"), extra.get("first_item"), fb,
                roam_kills if replay else None, roam_swing,
                round(sum(lived) / len(lived)) if lived else None, sum(ward[6] for ward in observers),
            ])
    _write(data_dir / "lanes.json", {"columns": LANE_COLUMNS, "rows": rows})
    _write(data_dir / "positions.json", positions)
    return len(rows)
