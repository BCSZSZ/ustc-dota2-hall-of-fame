"""Fit the local IMP model used when STRATZ has no IMP for a match (it never scores matches with Kez).

Pulls the recent public matches of every league player from STRATZ, fits one ridge regression of IMP
per position and result on per-minute stats and team shares, adds shrunk per-hero offsets, and writes
site/data/imp-model.json for the stats pages. Run it by hand when the model needs refreshing:

    STRATZ_TOKEN=... python fit_imp.py --cache /tmp/imp-train.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from stratz import STRATZ_URL, stratz_client

DATA_DIR = Path(__file__).with_name("site") / "data"
FEATURES = ["won", "dur", "kpm", "dpm", "apm", "lhpm", "dnpm", "gpm", "xpm", "hdpm", "tdpm", "hhpm", "lvl",
            "kp", "dmg_sh", "nw_sh", "lh_sh", "td_sh", "death_sh", "heal_sh"]
# Modes whose IMP matches normal games; turbo and ability draft play differently.
MODES = {"ALL_PICK_RANKED", "ALL_PICK", "CAPTAINS_MODE", "CAPTAINS_DRAFT", "RANDOM_DRAFT", "SINGLE_DRAFT"}
RIDGE = 3.0
HERO_SHRINK = 30
# Past the 0.5-99.5 percentile of training IMP, estimates keep only a fifth of the excess instead of
# extrapolating freely; the order between players is kept.
CLIP_PERCENTILES = (0.005, 0.995)
CLIP_SLOPE = 0.2
HISTORY = """query($a: Long!, $skip: Int!) { player(steamAccountId: $a) { matches(request: {take: 100, skip: $skip}) {
  id durationSeconds didRadiantWin gameMode
  players { isRadiant heroId position imp kills deaths assists numLastHits numDenies goldPerMinute
    experiencePerMinute heroDamage towerDamage heroHealing networth level } } } }"""


def features(player: dict[str, Any], team: list[dict[str, Any]], won: bool, minutes: float) -> list[float]:
    """Same features as site/imp-model.js, from summary-style fields (k, d, a, lh, ...)."""
    def total(key: str) -> float:
        return sum(other[key] or 0 for other in team) or 1
    value = {key: player[key] or 0 for key in ("k", "d", "a", "lh", "dn", "gpm", "xpm", "hd", "td", "hh", "nw", "lvl")}
    return [
        float(won), minutes, value["k"] / minutes, value["d"] / minutes, value["a"] / minutes, value["lh"] / minutes,
        value["dn"] / minutes, value["gpm"], value["xpm"], value["hd"] / minutes, value["td"] / minutes,
        value["hh"] / minutes, value["lvl"], (value["k"] + value["a"]) / total("k"), value["hd"] / total("hd"),
        value["nw"] / total("nw"), value["lh"] / total("lh"), value["td"] / total("td"), value["d"] / total("d"),
        value["hh"] / total("hh"),
    ]


def training_rows(matches: list[dict[str, Any]], skip_ids: set[int]) -> list[dict[str, Any]]:
    rows = []
    for match in matches:
        if match["id"] in skip_ids or match.get("gameMode") not in MODES or (match.get("durationSeconds") or 0) < 600:
            continue
        players = [{
            "k": p["kills"], "d": p["deaths"], "a": p["assists"], "lh": p["numLastHits"], "dn": p["numDenies"],
            "gpm": p["goldPerMinute"], "xpm": p["experiencePerMinute"], "hd": p["heroDamage"], "td": p["towerDamage"],
            "hh": p["heroHealing"], "nw": p["networth"], "lvl": p["level"], "radiant": p["isRadiant"],
            "imp": p["imp"], "pos": p["position"], "hero": p["heroId"],
        } for p in match["players"]]
        if any(value is None for player in players for value in player.values()):
            continue
        for player in players:
            team = [other for other in players if other["radiant"] == player["radiant"]]
            won = player["radiant"] == match["didRadiantWin"]
            rows.append({"x": features(player, team, won, match["durationSeconds"] / 60), "y": player["imp"],
                         "group": f"{player['pos'][-1]}-{int(won)}", "hero": player["hero"], "match": match["id"]})
    return rows


def _solve(matrix: list[list[float]], vector: list[float]) -> list[float]:
    """Gaussian elimination with partial pivoting for the small ridge systems."""
    size = len(vector)
    rows = [matrix[i][:] + [vector[i]] for i in range(size)]
    for col in range(size):
        pivot = max(range(col, size), key=lambda r: abs(rows[r][col]))
        rows[col], rows[pivot] = rows[pivot], rows[col]
        for r in range(col + 1, size):
            factor = rows[r][col] / rows[col][col]
            for c in range(col, size + 1):
                rows[r][c] -= factor * rows[col][c]
    result = [0.0] * size
    for r in range(size - 1, -1, -1):
        result[r] = (rows[r][size] - sum(rows[r][c] * result[c] for c in range(r + 1, size))) / rows[r][r]
    return result


def fit(rows: list[dict[str, Any]]) -> dict[str, Any]:
    width = len(FEATURES)
    count = len(rows)
    mean = [sum(row["x"][i] for row in rows) / count for i in range(width)]
    sd = [math.sqrt(sum((row["x"][i] - mean[i]) ** 2 for row in rows) / count) or 1.0 for i in range(width)]
    groups: dict[str, Any] = {}
    for name in sorted({row["group"] for row in rows}):
        members = [row for row in rows if row["group"] == name]
        z = [[(row["x"][i] - mean[i]) / sd[i] for i in range(width)] for row in members]
        z_mean = [sum(item[i] for item in z) / len(z) for i in range(width)]
        y_mean = sum(row["y"] for row in members) / len(members)
        centred = [[item[i] - z_mean[i] for i in range(width)] for item in z]
        gram = [[sum(item[i] * item[j] for item in centred) + (RIDGE if i == j else 0) for j in range(width)] for i in range(width)]
        target = [sum(item[i] * (row["y"] - y_mean) for item, row in zip(centred, members)) for i in range(width)]
        coef = _solve(gram, target)
        groups[name] = {"intercept": y_mean - sum(c * m for c, m in zip(coef, z_mean)), "coef": coef}
    model = {"features": FEATURES, "mean": mean, "sd": sd, "groups": groups, "hero_offset": {}, "clip": [-100, 100]}
    residual: dict[int, list[float]] = {}
    for row in rows:
        residual.setdefault(row["hero"], []).append(row["y"] - predict(model, row["x"], row["group"], row["hero"]))
    model["hero_offset"] = {str(hero): sum(values) / (len(values) + HERO_SHRINK) for hero, values in sorted(residual.items())}
    targets = sorted(row["y"] for row in rows)
    model["clip"] = [targets[int(CLIP_PERCENTILES[0] * count)], targets[min(count - 1, int(CLIP_PERCENTILES[1] * count))]]
    return model


def predict(model: dict[str, Any], x: list[float], group: str, hero: int) -> float:
    weights = model["groups"][group]
    value = weights["intercept"] + sum(
        c * (v - m) / s for c, v, m, s in zip(weights["coef"], x, model["mean"], model["sd"])
    ) + model["hero_offset"].get(str(hero), 0.0)
    low, high = model["clip"]
    if value > high:
        return high + (value - high) * CLIP_SLOPE
    if value < low:
        return low + (value - low) * CLIP_SLOPE
    return value


def errors(pairs: list[tuple[float, float]]) -> dict[str, float]:
    count = len(pairs)
    mean_truth = sum(truth for truth, _ in pairs) / count
    mean_estimate = sum(estimate for _, estimate in pairs) / count
    sse = sum((estimate - truth) ** 2 for truth, estimate in pairs)
    covariance = sum((truth - mean_truth) * (estimate - mean_estimate) for truth, estimate in pairs)
    spread_truth = math.sqrt(sum((truth - mean_truth) ** 2 for truth, _ in pairs))
    spread_estimate = math.sqrt(sum((estimate - mean_estimate) ** 2 for _, estimate in pairs))
    return {"rows": count, "rmse": round(math.sqrt(sse / count), 2),
            "mae": round(sum(abs(estimate - truth) for truth, estimate in pairs) / count, 2),
            "corr": round(covariance / (spread_truth * spread_estimate), 3)}


def league_check(model: dict[str, Any], data_dir: Path) -> dict[str, float] | None:
    """Estimates from the league's own OpenDota summaries against the IMP STRATZ gave those matches."""
    summaries = json.loads((data_dir / "matches.json").read_text(encoding="utf-8"))["matches"]
    scored = json.loads((data_dir / "stratz.json").read_text(encoding="utf-8")).get("matches", {})
    pairs = []
    for match in summaries:
        imp = scored.get(str(match["match_id"]), {}).get("imp")
        if not imp:
            continue
        for player in match["players"]:
            if not player.get("pos"):
                continue
            radiant = player["slot"] < 128
            team = [other for other in match["players"] if (other["slot"] < 128) == radiant]
            won = radiant == match["radiant_win"]
            x = features(player, team, won, match["duration"] / 60)
            pairs.append((imp[str(player["slot"])], predict(model, x, f"{player['pos']}-{int(won)}", player["hero"])))
    return errors(pairs) if pairs else None


def download(accounts: list[int], token: str) -> list[dict[str, Any]]:
    seen: dict[int, dict[str, Any]] = {}
    with stratz_client(token) as http:
        for account in accounts:
            for skip in range(0, 500, 100):
                response = http.post(STRATZ_URL, json={"query": HISTORY, "variables": {"a": account, "skip": skip}}, timeout=90)
                response.raise_for_status()
                matches = ((response.json().get("data") or {}).get("player") or {}).get("matches") or []
                for match in matches:
                    seen[match["id"]] = match
                time.sleep(0.4)
                if len(matches) < 100:
                    break
    return list(seen.values())


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache", type=Path, help="reuse or save the downloaded match histories here")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    args = parser.parse_args()
    summaries = json.loads((args.data_dir / "matches.json").read_text(encoding="utf-8"))["matches"]
    if args.cache and args.cache.exists():
        history = json.loads(args.cache.read_text(encoding="utf-8"))
    else:
        accounts = sorted({p["account_id"] for m in summaries for p in m["players"] if p.get("account_id")})
        history = download(accounts, os.environ["STRATZ_TOKEN"])
        if args.cache:
            args.cache.write_text(json.dumps(history), encoding="utf-8")
    # League matches are left out so they can check the model.
    rows = training_rows(history, {match["match_id"] for match in summaries})
    held_out = [row for row in rows if row["match"] % 5 == 0]
    trial = fit([row for row in rows if row["match"] % 5 != 0])
    model = fit(rows)
    model["trained"] = {"utc": datetime.now(UTC).isoformat(timespec="seconds"), "rows": len(rows),
                        "matches": len({row["match"] for row in rows})}
    model["validation"] = {
        "held_out": errors([(row["y"], predict(trial, row["x"], row["group"], row["hero"])) for row in held_out]),
        "league": league_check(model, args.data_dir),
    }
    (args.data_dir / "imp-model.json").write_text(json.dumps(model, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({**model["trained"], **model["validation"], "clip": model["clip"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
