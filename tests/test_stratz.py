import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from stratz import refresh_stratz

NOW = datetime(2026, 12, 1, 12, tzinfo=UTC)
SLOTS = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132]


def scored(imp: int | None) -> dict:
    return {"rank": 71, "winRates": [0.5, 0.183, 0.9], "players": [{"playerSlot": slot, "imp": imp} for slot in SLOTS]}


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

    assert result == {"scored": 1, "fetched": 2, "waiting": 1}
    assert read(tmp_path, "stratz.json")["matches"]["1"] == {
        "rank": 71, "imp": {str(slot): 20 for slot in SLOTS}, "win": [50, 18, 90]}
    pending = read(tmp_path, "pending.json")["stratz"]["2"]
    assert pending["attempts"] == 1 and pending["next_check_utc"] == (NOW + timedelta(hours=1)).isoformat()
    # The unscored match asks STRATZ to download its replay again, once.
    assert ("mutation", 2) in calls


def test_known_and_not_yet_due_matches_are_skipped(tmp_path: Path) -> None:
    calls: list = []
    refresh_stratz(data_dir=tmp_path, match_ids=[1, 2], http=client({1: scored(5), 2: scored(None)}, calls), now=NOW)
    calls.clear()
    refresh_stratz(data_dir=tmp_path, match_ids=[1, 2], http=client({}, calls), now=NOW + timedelta(minutes=30))
    assert calls == []


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
