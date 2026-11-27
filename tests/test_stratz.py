import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from stratz import MARKS, PAIRS, compare_matches, compare_positions, minute_features, minute_snapshot, refresh_stratz

NOW = datetime(2026, 12, 1, 12, tzinfo=UTC)
SLOTS = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132]


def scored(imp: int | None) -> dict:
    return {"rank": 71, "winRates": [0.5, 0.183, 0.9], "didRadiantWin": True,
            "players": [{"playerSlot": slot, "imp": imp, "heroId": index + 1, "steamAccountId": 100 + index,
                         "position": f"POSITION_{index % 5 + 1}"} for index, slot in enumerate(SLOTS)]}


def client(matches: dict[int, dict], calls: list) -> httpx.Client:
    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append((body["query"].split("(")[0], body["variables"]["id"]))
        if body["query"].startswith("mutation"):
            return httpx.Response(200, json={"data": {"retryMatchDownload": True}})
        return httpx.Response(200, json={"data": {"match": matches.get(body["variables"]["id"])}})
    return httpx.Client(transport=httpx.MockTransport(handle))


def read(tmp_path: Path, name: str) -> dict:
    return json.loads((tmp_path / name).read_text(encoding="utf-8"))


def test_scored_matches_are_stored_and_unscored_ones_wait(tmp_path: Path) -> None:
    calls: list = []
    result = refresh_stratz(data_dir=tmp_path, match_ids=[1, 2], http=client({1: scored(20), 2: scored(None)}, calls), now=NOW)

    assert result == {"scored": 1, "fetched": 2, "waiting": 1, "per_minute": 0}
    assert read(tmp_path, "stratz.json")["matches"]["1"] == {
        "rank": 71, "imp": {str(slot): 20 for slot in SLOTS}, "win": [50, 18, 90], "radiant_win": True,
        "players": {str(slot): [index + 1, 100 + index, index % 5 + 1] for index, slot in enumerate(SLOTS)}}
    pending = read(tmp_path, "pending.json")["stratz"]["2"]
    assert pending["attempts"] == 1 and pending["next_check_utc"] == (NOW + timedelta(hours=1)).isoformat()
    # The unscored match asks STRATZ to download its replay again, once.
    assert ("mutation", 2) in calls


def test_known_and_not_yet_due_matches_are_skipped(tmp_path: Path) -> None:
    calls: list = []
    refresh_stratz(data_dir=tmp_path, match_ids=[1, 2], http=client({1: scored(5), 2: scored(None)}, calls), now=NOW)
    calls.clear()
    refresh_stratz(data_dir=tmp_path, match_ids=[1, 2], http=client({}, calls), now=NOW + timedelta(minutes=30))
    # Only the per-minute snapshot of the unscored match is asked for again; no IMP check is due.
    assert calls == [("query", 2)]


def test_gives_up_after_a_week(tmp_path: Path) -> None:
    calls: list = []
    refresh_stratz(data_dir=tmp_path, match_ids=[2], http=client({2: scored(None)}, calls), now=NOW)
    refresh_stratz(data_dir=tmp_path, match_ids=[2], http=client({2: scored(None)}, calls), now=NOW + timedelta(days=8))

    pending = read(tmp_path, "pending.json")
    assert pending["stratz"] == {} and pending["stratz_unavailable"] == [2]
    assert [call for call in calls if call[0] == "mutation"] == [("mutation", 2)]


def test_other_pending_queues_are_kept(tmp_path: Path) -> None:
    (tmp_path / "pending.json").write_text(json.dumps({"matches": {"9": {"attempts": 1}}}), encoding="utf-8")
    refresh_stratz(data_dir=tmp_path, match_ids=[1], http=client({1: scored(1)}, []), now=NOW)
    assert read(tmp_path, "pending.json")["matches"] == {"9": {"attempts": 1}}


def with_minutes(imp: int | None, minutes: int = 12) -> dict:
    """An unscored-or-scored match that also carries STRATZ per-minute stats and hero averages."""
    def player(slot: int) -> dict:
        return {"playerSlot": slot, "imp": imp, "isRadiant": slot < 128, "lane": "SAFE_LANE" if slot in (0, 128) else "ROAMING",
                "heroAverage": [{"time": t, "kills": t / 10, "deaths": t / 10, "assists": t / 5, "networth": 500 * t, "xp": 400 * t,
                                 "cs": 5 * t, "heroDamage": 300 * t, "towerDamage": 10 * t, "healingAllies": 0} for t in range(minutes + 1)],
                "stats": {"lastHitsPerMinute": [6] * (minutes + 1), "experiencePerMinute": [450] * (minutes + 1),
                          "networthPerMinute": [600 * t for t in range(minutes + 1)], "heroDamagePerMinute": [250] * (minutes + 1),
                          "towerDamagePerMinute": [0] * (minutes + 1), "healPerMinute": [0] * (minutes + 1),
                          "killEvents": [{"time": 290}], "deathEvents": [{"time": 400}, {"time": 700}], "assistEvents": []}}
    return {**scored(imp), "durationSeconds": minutes * 60 + 30, "topLaneOutcome": "DIRE_VICTORY", "midLaneOutcome": "TIE",
            "bottomLaneOutcome": "RADIANT_STOMP", "players": [player(slot) for slot in SLOTS]}


def test_snapshot_compares_each_stat_with_the_hero_average() -> None:
    snapshot = minute_snapshot(with_minutes(None))
    assert set(snapshot) == {str(slot) for slot in SLOTS}
    radiant = snapshot["0"]
    # Marks below the game length plus the last minute; per mark the player's values then the hero averages.
    assert list(radiant["t"]) == ["5", "10", "12"]
    assert radiant["t"]["5"] == [36, 2700, 3000, 1500, 0, 1, 0, 0, 0, 25, 2000, 2500, 1500, 50, 0.5, 0.5, 1.0, 0]
    # Radiant safe lane is the bottom lane, which Radiant stomped; the Dire safe lane is top, which Dire won.
    assert radiant["lane"] == 2 and snapshot["128"]["lane"] == 1 and snapshot["1"]["lane"] == 0
    assert len(minute_features(radiant)) == (len(MARKS) + 1) * len(PAIRS) * 2 + 1


def test_unscored_match_keeps_a_snapshot_until_stratz_scores_it(tmp_path: Path) -> None:
    calls: list = []
    result = refresh_stratz(data_dir=tmp_path, match_ids=[2], http=client({2: with_minutes(None)}, calls), now=NOW)
    assert result["per_minute"] == 1 and set(read(tmp_path, "stratz.json")["minute"]["2"]) == {str(slot) for slot in SLOTS}
    refresh_stratz(data_dir=tmp_path, match_ids=[2], http=client({2: with_minutes(7)}, calls), now=NOW + timedelta(hours=2))
    stored = read(tmp_path, "stratz.json")
    assert stored["minute"] == {} and stored["matches"]["2"]["imp"]["0"] == 7


def test_snapshot_is_fetched_even_when_the_imp_check_is_not_due(tmp_path: Path) -> None:
    calls: list = []
    # First run: STRATZ has not parsed the match yet, so no snapshot either.
    refresh_stratz(data_dir=tmp_path, match_ids=[2], http=client({2: scored(None)}, calls), now=NOW)
    # Thirty minutes later the IMP check is not due, but the snapshot is fetched once STRATZ has it.
    calls.clear()
    result = refresh_stratz(data_dir=tmp_path, match_ids=[2], http=client({2: with_minutes(None)}, calls), now=NOW + timedelta(minutes=30))
    assert result["per_minute"] == 1 and len(calls) == 1
    calls.clear()
    refresh_stratz(data_dir=tmp_path, match_ids=[2], http=client({2: with_minutes(None)}, calls), now=NOW + timedelta(minutes=40))
    assert calls == []


def test_matches_stored_without_cross_check_fields_are_fetched_once_more(tmp_path: Path) -> None:
    (tmp_path / "stratz.json").write_text(json.dumps({"matches": {"1": {"rank": 70, "imp": {}, "win": []}}}), encoding="utf-8")
    calls: list = []
    refresh_stratz(data_dir=tmp_path, match_ids=[1], http=client({1: scored(5)}, calls), now=NOW)
    assert read(tmp_path, "stratz.json")["matches"]["1"]["radiant_win"] is True
    refresh_stratz(data_dir=tmp_path, match_ids=[1], http=client({}, calls), now=NOW)
    assert len(calls) == 1


def test_compares_results_heroes_and_accounts_with_opendota() -> None:
    stored = {"1": {"radiant_win": False, "players": {"0": [5, 100, 1], "128": [7, 200, 1]}}, "2": {"imp": {}}}
    matches = [{"match_id": 1, "radiant_win": True, "players": [
        {"player_slot": 0, "hero_id": 5, "account_id": 100}, {"player_slot": 128, "hero_id": 8, "account_id": 201}]},
        {"match_id": 2, "radiant_win": True, "players": []}]
    assert compare_matches(matches, stored) == ["1: result differs", "1 slot 128: hero 8 vs 7", "1 slot 128: account 201 vs 200"]


def test_compares_positions_with_corrections_applied() -> None:
    summaries = [{"match_id": 1, "players": [{"slot": 0, "pos": 1}, {"slot": 1, "pos": 2}, {"slot": 2, "pos": 3}]}]
    stored = {"1": {"players": {"0": [1, 1, 1], "1": [2, 2, 4], "2": [3, 3, 5]}}}
    corrections = {"1": {"2": {"pos": 5, "source": "manual"}}}
    assert compare_positions(summaries, corrections, stored) == ["1 slot 1: position 2 vs STRATZ 4"]


def test_ip_limit_waits_once_then_reports_the_message() -> None:
    import pytest
    from stratz import StratzError, post_graphql
    replies = [httpx.Response(403, text="... One of your IP Addresses frees up in 3 minutes, at ..."),
               httpx.Response(200, json={"data": {"ok": 1}}),
               httpx.Response(403, text="... One of your IP Addresses frees up in 3 minutes, at ...")]
    http = httpx.Client(transport=httpx.MockTransport(lambda request: replies.pop(0)))
    slept: list = []
    assert post_graphql(http, "{ ok }", sleep=slept.append) == {"ok": 1}
    assert slept == [210.0]
    with pytest.raises(StratzError, match="frees up in 3 minutes"):
        post_graphql(http, "{ ok }", sleep=slept.append)
    assert slept == [210.0]
