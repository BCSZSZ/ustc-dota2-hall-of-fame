import json
import random
from pathlib import Path

from fit_imp import _solve, features, fit, predict

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "imp_estimate.json").read_text(encoding="utf-8"))


def test_fixture_matches_python_estimate() -> None:
    # tests/test_imp_model.mjs checks site/imp-model.js against the same expected values.
    match = FIXTURE["match"]
    for player in match["players"]:
        radiant = player["slot"] < 128
        team = [other for other in match["players"] if (other["slot"] < 128) == radiant]
        won = radiant == match["radiant_win"]
        value = predict(FIXTURE["model"], features(player, team, won, match["duration"] / 60), f"{player['pos']}-{int(won)}", player["hero"])
        assert abs(value - FIXTURE["expected"][str(player["slot"])]) < 1e-9


def test_solve_matches_a_known_system() -> None:
    assert [round(value, 9) for value in _solve([[2.0, 1.0], [1.0, 3.0]], [3.0, 5.0])] == [0.8, 1.4]


def test_fit_recovers_a_linear_target_per_group() -> None:
    rng = random.Random(1)
    rows = []
    for index in range(800):
        x = [rng.random() for _ in range(20)]
        group = f"{index % 5 + 1}-{index % 2}"
        rows.append({"x": x, "y": 40 * x[2] - 20 * x[7] + (10 if group.endswith("1") else -10), "group": group, "hero": 1, "match": index})
    model = fit(rows)
    low, high = model["clip"]
    # Estimates past the 0.5-99.5 percentile of the targets are compressed, so only compare inside it.
    errors = [abs(predict(model, row["x"], row["group"], row["hero"]) - row["y"]) for row in rows if low <= row["y"] <= high]
    # The ridge penalty shrinks slopes a little, so the fit is close but not exact.
    assert max(errors) < 2.0 and sum(errors) / len(errors) < 0.5
