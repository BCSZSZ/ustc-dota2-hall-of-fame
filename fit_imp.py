"""Fit the local IMP model used when STRATZ has no IMP for a match (it never scores matches with Kez).

Pulls the recent public matches of every league player from STRATZ and fits one ridge regression with a
separate penalty per block of terms:
  * per-(position, result) linear terms on own per-minute stats, logs, team shares and team-vs-enemy context;
  * the same stats minus their expected value for that hero and position (shrunk means), and those
    hero-normalised stats of teammates and enemies, because IMP compares a game with others on the same hero;
  * pairwise products of 29 key standardised features;
  * hero x position offsets, and "draft" terms for every other hero in the match as ally or enemy;
  * a piecewise-linear tail calibration fitted on 5-fold out-of-fold predictions.
It writes site/data/imp-model.json, which site/imp-model.js evaluates in the browser. Needs numpy, which the
site itself does not, so run it with uv:

    STRATZ_TOKEN=... uv run --with numpy --with-requirements requirements.txt python fit_imp.py --cache /tmp/imp-train.json

Three independent approaches (this one, gradient-boosted trees, a match-level neural net) were compared on
the same split in 2026-11; this one was best (held-out corr 0.905, league 0.880) and blending added ~0.002.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
from dotenv import load_dotenv

from stratz import STRATZ_URL, stratz_client

DATA_DIR = Path(__file__).with_name("site") / "data"
KEYS = ("k", "d", "a", "lh", "dn", "gpm", "xpm", "hd", "td", "hh", "nw", "lvl")
STRATZ_KEYS = {"k": "kills", "d": "deaths", "a": "assists", "lh": "numLastHits", "dn": "numDenies", "gpm": "goldPerMinute",
               "xpm": "experiencePerMinute", "hd": "heroDamage", "td": "towerDamage", "hh": "heroHealing",
               "nw": "networth", "lvl": "level"}
# Modes whose IMP matches normal games; turbo and ability draft play differently.
MODES = {"ALL_PICK_RANKED", "ALL_PICK", "CAPTAINS_MODE", "CAPTAINS_DRAFT", "RANDOM_DRAFT", "SINGLE_DRAFT"}
HISTORY = """query($a: Long!, $skip: Int!) { player(steamAccountId: $a) { matches(request: {take: 100, skip: $skip}) {
  id durationSeconds didRadiantWin gameMode
  players { isRadiant heroId position imp kills deaths assists numLastHits numDenies goldPerMinute
    experiencePerMinute heroDamage towerDamage heroHealing networth level } } } }"""

BASE = ["won", "min", "logmin", "kpm", "dpm", "apm", "lhpm", "dnpm", "hdpm", "tdpm", "hhpm", "gpm", "xpm", "lvl", "nwpm",
        "l_kpm", "l_dpm", "l_apm", "l_lhpm", "l_dnpm", "l_hd", "l_td", "l_hh", "l_gpm", "l_xpm", "l_kda",
        "k_sh", "d_sh", "a_sh", "lh_sh", "dn_sh", "hd_sh", "td_sh", "hh_sh", "nw_sh", "gpm_sh", "xpm_sh", "kp",
        "t_kdiff_pm", "t_nwdiff", "t_xpdiff", "t_tddiff", "t_kpm", "e_kpm", "t_hdpm", "e_hdpm",
        "hd_vs_e", "d_vs_ek", "k_vs_ed", "ka_vs_ed"]
# Stats compared with the hero-position expectation; CZ are averaged over teammates and enemies, KZ are kept
# per teammate and enemy position.
ZN = ["kpm", "dpm", "apm", "lhpm", "dnpm", "gpm", "xpm", "hdpm", "tdpm", "hhpm", "lvl", "nwpm", "l_hd", "l_hh", "l_td",
      "l_kda", "kp", "hd_sh", "nw_sh", "lh_sh", "td_sh", "d_sh", "hh_sh", "l_gpm", "l_xpm", "hd_vs_e"]
CZ = [n for n in ZN if n != "kp" and not n.endswith("_sh")]
KZ = ["gpm", "xpm", "kpm", "dpm", "l_hd", "apm"]
NAMES = BASE + ["z_" + n for n in ZN] + ["tm_" + c for c in CZ] + ["em_" + c for c in CZ] + \
    [f"{s}{q}_{c}" for s in ("tp", "ep") for q in range(1, 6) for c in KZ]
POLY = ["won", "logmin", "kpm", "dpm", "apm", "lhpm", "gpm", "xpm", "l_hd", "l_hh", "l_td", "kp", "nw_sh", "t_nwdiff",
        "t_kdiff_pm", "l_kda", "min", "hd_vs_e", "d_vs_ek", "z_gpm", "z_xpm", "z_l_hd", "z_kpm", "z_dpm", "z_apm",
        "z_lhpm", "z_l_hh", "z_l_td", "z_kp"]
PENALTY = dict(lin=1.0, glin=100.0, poly=30.0, hero=30.0, gint=0.01, draft=100.0, draftpos=300.0)
HERO_SHRINK = 20.0
CALIB_QUANTILES = (0.02, 0.1, 0.9, 0.98)


# ---------- rows and features (mirrored in site/imp-model.js) ----------

def base(p: dict, team: list[dict], enemy: list[dict], m: float, won: bool) -> dict[str, float]:
    v = {k: float(p.get(k) or 0) for k in KEYS}
    t = {k: sum(float(o.get(k) or 0) for o in team) for k in KEYS}
    e = {k: sum(float(o.get(k) or 0) for o in enemy) for k in KEYS}
    f = {"won": float(won), "min": m, "logmin": math.log(m)}
    for k in ("k", "d", "a", "lh", "dn", "hd", "td", "hh"):
        f[k + "pm"] = v[k] / m
    f.update(gpm=v["gpm"], xpm=v["xpm"], lvl=v["lvl"], nwpm=v["nw"] / m)
    for k in ("k", "d", "a", "lh", "dn"):
        f["l_" + k + "pm"] = math.log1p(v[k] / m)
    for k in ("hd", "td", "hh"):
        f["l_" + k] = math.log1p(v[k] / m)
    f["l_gpm"], f["l_xpm"] = math.log(v["gpm"] + 50), math.log(v["xpm"] + 50)
    f["l_kda"] = math.log((v["k"] + v["a"] + 1) / (v["d"] + 1))
    for k in ("k", "d", "a", "lh", "dn", "hd", "td", "hh", "nw", "gpm", "xpm"):
        f[k + "_sh"] = v[k] / max(t[k], 1)
    f["kp"] = (v["k"] + v["a"]) / max(t["k"], 1)
    f["t_kdiff_pm"] = (t["k"] - e["k"]) / m
    for k, n in (("nw", "t_nwdiff"), ("xpm", "t_xpdiff"), ("td", "t_tddiff")):
        f[n] = (t[k] - e[k]) / max(t[k] + e[k], 1)
    f.update(t_kpm=t["k"] / m, e_kpm=e["k"] / m, t_hdpm=t["hd"] / m, e_hdpm=e["hd"] / m)
    f["hd_vs_e"] = v["hd"] / max(e["hd"], 1)
    f["d_vs_ek"] = v["d"] / max(e["k"], 1)
    f["k_vs_ed"] = v["k"] / max(e["d"], 1)
    f["ka_vs_ed"] = (v["k"] + v["a"]) / max(e["d"], 1)
    return f


def match_rows(match_id: int, players: list[dict], radiant_win: bool, minutes: float) -> list[dict]:
    """One row per player; each player dict has KEYS plus pos, hero, radiant and (for training) imp."""
    rows = []
    for p in players:
        team = [o for o in players if o["radiant"] == p["radiant"]]
        enemy = [o for o in players if o["radiant"] != p["radiant"]]
        rows.append({"match": match_id, "hero": p["hero"], "pos": p["pos"], "won": p["radiant"] == radiant_win,
                     "minutes": minutes, "player": p, "team": team, "enemy": enemy, "imp": p.get("imp")})
    return rows


def stratz_rows(history: list[dict], skip_ids: set[int]) -> list[dict]:
    rows = []
    for match in history:
        if match["id"] in skip_ids or match.get("gameMode") not in MODES or (match.get("durationSeconds") or 0) < 600:
            continue
        players = []
        for p in match["players"]:
            stats = {key: p[source] for key, source in STRATZ_KEYS.items()}
            if any(v is None for v in stats.values()) or p["imp"] is None or not p.get("position"):
                break
            players.append({**stats, "pos": int(p["position"][-1]), "hero": p["heroId"], "radiant": p["isRadiant"], "imp": p["imp"]})
        else:
            rows += match_rows(match["id"], players, match["didRadiantWin"], match["durationSeconds"] / 60)
    return rows


def league_rows(data_dir: Path) -> list[dict]:
    """League matches STRATZ scored, with positions corrected like the site does, to check the model."""
    summaries = json.loads((data_dir / "matches.json").read_text(encoding="utf-8"))["matches"]
    scored = json.loads((data_dir / "stratz.json").read_text(encoding="utf-8")).get("matches", {})
    fixes = json.loads((data_dir / "positions.json").read_text(encoding="utf-8")) if (data_dir / "positions.json").exists() else {}
    rows = []
    for match in summaries:
        imp = scored.get(str(match["match_id"]), {}).get("imp")
        if not imp:
            continue
        players = [{**{k: p.get(k) or 0 for k in KEYS}, "slot": p["slot"], "hero": p["hero"], "radiant": p["slot"] < 128,
                    "pos": (fixes.get(str(match["match_id"]), {}).get(str(p["slot"])) or {}).get("pos") or p.get("pos"),
                    "imp": imp[str(p["slot"])]} for p in match["players"]]
        if all(p["pos"] for p in players):
            rows += match_rows(match["match_id"], players, match["radiant_win"], match["duration"] / 60)
    return rows


def hero_table(rows: list[dict]) -> dict[str, Any]:
    """Expected ZN stats per hero and position: (hero,pos) mean shrunk toward hero, hero toward position."""
    x = np.array([[base(r["player"], r["team"], r["enemy"], r["minutes"], r["won"])[n] for n in ZN] for r in rows])
    pos = np.array([r["pos"] for r in rows])
    hero = np.array([r["hero"] for r in rows])
    overall = x.mean(0)
    by_pos = {p: x[pos == p].mean(0) for p in range(1, 6)}
    table = {}
    for h in np.unique(hero):
        i = hero == h
        hero_mean = (x[i].sum(0) + HERO_SHRINK * overall) / (i.sum() + HERO_SHRINK)
        for p in range(1, 6):
            j = i & (pos == p)
            prior = by_pos[p] + hero_mean - overall
            table[f"{h}-{p}"] = (x[j].sum(0) + HERO_SHRINK * prior) / (j.sum() + HERO_SHRINK)
    return {"hp": table, "pos": {str(p): by_pos[p] for p in by_pos}}


def row_features(row: dict, table: dict) -> list[float]:
    normalised, mine = [], None
    for side, won in ((row["team"], row["won"]), (row["enemy"], not row["won"])):
        other = row["enemy"] if side is row["team"] else row["team"]
        for p in side:
            f = base(p, side, other, row["minutes"], won)
            mu = table["hp"].get(f"{p['hero']}-{p['pos']}")
            z = np.array([f[n] for n in ZN]) - (mu if mu is not None else table["pos"][str(p["pos"])])
            is_self = side is row["team"] and p["hero"] == row["hero"]
            normalised.append((side is row["team"], p["pos"], is_self, z))
            if is_self:
                mine = (f, z)
    f, z = mine
    ci = [ZN.index(c) for c in CZ]
    ki = [ZN.index(c) for c in KZ]
    mates = [v for own, _, me, v in normalised if own and not me]
    foes = [v for own, _, _, v in normalised if not own]
    x = [f[n] for n in BASE] + list(z) + list(np.mean(mates, 0)[ci]) + list(np.mean(foes, 0)[ci])
    for own in (True, False):
        for q in range(1, 6):
            found = [v for o, pos, me, v in normalised if o == own and pos == q and not me]
            x += list(found[0][ki]) if found else [0.0] * len(KZ)
    return x


def draft_keys(row: dict) -> list[tuple[str, str]]:
    keys = []
    for side, tag in ((row["team"], "a"), (row["enemy"], "e")):
        for o in side:
            if o["hero"] != row["hero"]:
                keys += [(f"{tag}{o['hero']}", "draft"), (f"{tag}{o['hero']}-{row['pos']}", "draftpos")]
    return keys


# ---------- fitting ----------

def fit(x: np.ndarray, rows: list[dict]) -> dict[str, Any]:
    y = np.array([r["imp"] for r in rows], float)
    dkeys = {b: sorted({k for r in rows for k, bb in draft_keys(r) if bb == b}) for b in ("draft", "draftpos")}
    heroes = sorted({f"{r['hero']}-{r['pos']}" for r in rows})
    mean, sd = x.mean(0), x.std(0) + 1e-9
    pi = [NAMES.index(n) for n in POLY]
    pairs = list(itertools.combinations_with_replacement(range(len(pi)), 2))
    z = (x - mean) / sd
    g = np.eye(10)[[r["pos"] * 2 + int(r["won"]) - 2 for r in rows]]
    hero_index = {h: i for i, h in enumerate(heroes)}
    h = np.zeros((len(rows), len(heroes)))
    d = {b: np.zeros((len(rows), len(dkeys[b]))) for b in dkeys}
    draft_index = {b: {k: i for i, k in enumerate(dkeys[b])} for b in dkeys}
    for i, r in enumerate(rows):
        h[i, hero_index[f"{r['hero']}-{r['pos']}"]] = 1
        for k, b in draft_keys(r):
            d[b][i, draft_index[b][k]] += 1
    blocks = [("lin", z), ("gint", g), ("glin", np.hstack([z * g[:, [j]] for j in range(10)])),
              ("poly", np.column_stack([z[:, pi[a]] * z[:, pi[b]] for a, b in pairs])), ("hero", h),
              ("draft", d["draft"]), ("draftpos", d["draftpos"])]
    a = np.hstack([block for _, block in blocks])
    penalty = np.concatenate([np.full(block.shape[1], PENALTY[name]) for name, block in blocks])
    y_mean = y.mean()
    w = np.linalg.solve(a.T @ a + np.diag(penalty), a.T @ (y - y_mean))
    cut = np.cumsum([0] + [block.shape[1] for _, block in blocks])
    part = {name: w[cut[i]:cut[i + 1]] for i, (name, _) in enumerate(blocks)}
    nf = x.shape[1]
    groups = {}
    for j in range(10):
        wz = part["lin"] + part["glin"][j * nf:(j + 1) * nf]
        groups[f"{j // 2 + 1}-{j % 2}"] = {"b": float(y_mean + part["gint"][j] - wz @ (mean / sd)), "w": wz / sd}
    return {"groups": groups, "poly": {"idx": pi, "mean": mean[pi], "sd": sd[pi], "pairs": pairs, "w": part["poly"]},
            "hero": dict(zip(heroes, part["hero"].tolist())),
            "draft": {k: v for b in dkeys for k, v in zip(dkeys[b], part[b].tolist())},
            "calib": {"knots": [], "c": [0.0, 1.0]}}


def predict(model: dict, x: np.ndarray, rows: list[dict]) -> np.ndarray:
    poly = model["poly"]
    zp = (x[:, poly["idx"]] - poly["mean"]) / poly["sd"]
    raw = np.column_stack([zp[:, a] * zp[:, b] for a, b in poly["pairs"]]) @ poly["w"]
    for i, r in enumerate(rows):
        group = model["groups"][f"{r['pos']}-{int(r['won'])}"]
        raw[i] += group["b"] + x[i] @ group["w"] + model["hero"].get(f"{r['hero']}-{r['pos']}", 0.0) + \
            sum(model["draft"].get(k, 0.0) for k, _ in draft_keys(r))
    knots, c = np.array(model["calib"]["knots"]), np.array(model["calib"]["c"])
    return c[0] + c[1] * raw + sum(c[i + 2] * np.maximum(raw - k, 0) for i, k in enumerate(knots))


def fit_calibrated(rows: list[dict]) -> tuple[dict, dict]:
    """Fit on all rows; the tail calibration maps 5-fold out-of-fold estimates onto IMP."""
    table = hero_table(rows)
    x = np.array([row_features(r, table) for r in rows])
    fold = np.array([(r["match"] // 5) % 5 for r in rows])
    oof = np.zeros(len(rows))
    for f in range(5):
        train, test = np.where(fold != f)[0], np.where(fold == f)[0]
        oof[test] = predict(fit(x[train], [rows[i] for i in train]), x[test], [rows[i] for i in test])
    model = fit(x, rows)
    knots = np.quantile(oof, CALIB_QUANTILES)
    basis = np.column_stack([np.ones_like(oof), oof] + [np.maximum(oof - k, 0) for k in knots])
    model["calib"] = {"knots": knots.tolist(), "c": np.linalg.lstsq(basis, np.array([r["imp"] for r in rows]), rcond=None)[0].tolist()}
    return model, table


def score(model: dict, table: dict, rows: list[dict]) -> tuple[dict[str, float], np.ndarray]:
    estimate = predict(model, np.array([row_features(r, table) for r in rows]), rows)
    truth = np.array([r["imp"] for r in rows], float)
    return {"rows": len(rows), "corr": round(float(np.corrcoef(truth, estimate)[0, 1]), 4),
            "rmse": round(float(np.sqrt(((estimate - truth) ** 2).mean())), 2),
            "mae": round(float(np.abs(estimate - truth).mean()), 2)}, estimate


def export(model: dict, table: dict, check: dict) -> dict[str, Any]:
    r = lambda values: [float(f"{v:.5g}") for v in values]
    return {"base": BASE, "zn": ZN, "cz": CZ, "kz": KZ,
            "hero_mu": {k: r(v) for k, v in table["hp"].items()}, "pos_mu": {k: r(v) for k, v in table["pos"].items()},
            "groups": {k: {"b": round(v["b"], 4), "w": r(v["w"])} for k, v in model["groups"].items()},
            # Pairs (i <= j) of poly.idx in row-major order.
            "poly": {"idx": model["poly"]["idx"], "mean": r(model["poly"]["mean"]), "sd": r(model["poly"]["sd"]), "w": r(model["poly"]["w"])},
            "calib": {"knots": r(model["calib"]["knots"]), "c": r(model["calib"]["c"])},
            "hero_offset": {k: round(v, 3) for k, v in model["hero"].items()},
            "draft": {k: round(v, 3) for k, v in model["draft"].items() if abs(v) >= 0.0005},
            "check": check}


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
    # League matches stay out of training so they can check the model.
    rows = stratz_rows(history, {m["match_id"] for m in summaries})
    league = league_rows(args.data_dir)
    trial, trial_table = fit_calibrated([r for r in rows if r["match"] % 5 != 0])
    held_out, _ = score(trial, trial_table, [r for r in rows if r["match"] % 5 == 0])
    model, table = fit_calibrated(rows)
    league_score, league_estimate = score(model, table, league) if league else (None, [])
    # One league match with this model's estimates, so tests can confirm site/imp-model.js agrees.
    check = None
    if league:
        first = [r for r in league if r["match"] == league[0]["match"]]
        players = [{**{k: r["player"][k] for k in KEYS}, "slot": r["player"]["slot"], "hero": r["hero"], "pos": r["pos"]} for r in first]
        check = {"match": {"duration": round(first[0]["minutes"] * 60), "radiant_win": first[0]["won"] == (players[0]["slot"] < 128),
                           "players": players},
                 "expected": {str(r["player"]["slot"]): float(e) for r, e in zip(first, league_estimate[:len(first)])}}
    payload = export(model, table, check)
    payload["trained"] = {"utc": datetime.now(UTC).isoformat(timespec="seconds"), "rows": len(rows),
                          "matches": len({r["match"] for r in rows})}
    payload["validation"] = {"held_out": held_out, "league": league_score}
    (args.data_dir / "imp-model.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({**payload["trained"], **payload["validation"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
