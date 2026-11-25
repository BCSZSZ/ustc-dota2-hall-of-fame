from pathlib import Path
from typing import Any

import httpx
import pytest

from collector import (
    LeagueCollectionError,
    OpenDotaLeagueClient,
    collect_league_data,
    normalise_match,
    write_snapshot,
)


def make_match(match_id: int, *, league_id: int = 19224) -> dict[str, Any]:
    return {
        "match_id": match_id,
        "leagueid": league_id,
        "start_time": 1_800_000_000 + match_id,
        "duration": 2_400,
        "radiant_win": True,
        "players": [
            {
                "account_id": 1000 + slot,
                "personaname": f"Player {slot}",
                "player_slot": slot if slot < 5 else 123 + slot,
                "hero_id": slot + 1,
            }
            for slot in range(10)
        ],
    }


class FakeClient:
    paid_calls = 0
    free_exhausted = False

    def __init__(self, responses: dict[str, Any]) -> None:
        self.responses = responses
        self.requested: list[str] = []

    def get_json(self, path: str) -> Any:
        self.requested.append(path)
        response = self.responses.get(path, {}) if path.startswith("/players/") else self.responses[path]
        if isinstance(response, LeagueCollectionError):
            raise response
        return response


def test_normalise_match_keeps_active_roster() -> None:
    match = normalise_match(make_match(1), 19224)

    assert match["match_id"] == 1
    assert match["radiant_win"] is True
    assert len(match["players"]) == 10
    assert match["players"][5]["player_slot"] == 128


def test_collector_reuses_old_matches_and_refreshes_recent(tmp_path: Path) -> None:
    output = tmp_path / "league.json"
    old_payload = {
        "league_id": 19224,
        "matches": [normalise_match(make_match(1), 19224)],
        "opendota_ratings": {"1000": 75},
    }
    write_snapshot(output, old_payload)
    client = FakeClient(
        {
            "/leagues/19224": {"name": "Test League", "tier": "excluded"},
            "/leagues/19224/matchIds": [1, 2],
            "/matches/2": make_match(2),
        }
    )

    payload = collect_league_data(
        league_id=19224,
        output_path=output,
        refresh_recent=1,
        client=client,  # type: ignore[arg-type]
    )

    assert [match["match_id"] for match in payload["matches"]] == [1, 2]
    assert "/matches/1" not in client.requested
    assert "/matches/2" in client.requested
    assert payload["metadata"]["matches_available"] == 2
    assert payload["metadata"]["anonymous_player_slots"] == 0
    assert payload["opendota_rank_tiers"] == {}
    assert "opendota_ratings" not in payload


def test_collector_excludes_two_player_match_until_roster_is_complete(tmp_path: Path) -> None:
    output = tmp_path / "league.json"
    match_id = 9103805656
    next_match_id = 9103813138
    complete = make_match(match_id)
    incomplete = {
        **complete,
        "duration": 3152,
        "radiant_win": False,
        "players": [complete["players"][0], complete["players"][5]],
    }
    write_snapshot(output, {"league_id": 19224, "matches": [normalise_match(incomplete, 19224)]})
    next_match = make_match(next_match_id)
    next_match["players"][0]["account_id"] = None
    responses = {
        "/leagues/19224": {"name": "Test League"},
        "/leagues/19224/matchIds": [match_id, next_match_id],
        f"/matches/{match_id}": incomplete,
        f"/matches/{next_match_id}": next_match,
    }
    client = FakeClient(responses)

    snapshot = collect_league_data(
        league_id=19224, output_path=output, refresh_recent=1, client=client,  # type: ignore[arg-type]
    )

    assert [match["match_id"] for match in snapshot["matches"]] == [next_match_id]
    assert snapshot["metadata"]["matches_available"] == 1
    assert snapshot["metadata"]["incomplete_roster_match_ids"] == [match_id]
    assert snapshot["metadata"]["anonymous_player_slots"] == 1

    write_snapshot(output, snapshot)
    responses[f"/matches/{match_id}"] = complete
    snapshot = collect_league_data(
        league_id=19224, output_path=output, refresh_recent=1, client=client,  # type: ignore[arg-type]
    )

    assert [match["match_id"] for match in snapshot["matches"]] == [match_id, next_match_id]
    assert snapshot["metadata"]["incomplete_roster_match_ids"] == []


def test_collector_refreshes_nicknames_for_players_in_cached_matches(tmp_path: Path) -> None:
    output = tmp_path / "league.json"
    old_match = make_match(1)
    old_match["players"][0].update(account_id=243513067, personaname="Old nickname")
    write_snapshot(
        output,
        {
            "league_id": 19224,
            "matches": [normalise_match(old_match, 19224)],
            "player_names": {"1001": "Previously fetched"},
        },
    )
    client = FakeClient(
        {
            "/leagues/19224": {"name": "Test League"},
            "/leagues/19224/matchIds": [1, 2],
            "/matches/2": make_match(2),
        }
    )

    def steam_profile(request: httpx.Request) -> httpx.Response:
        assert request.url.params.get("xml") == "1"
        if request.url.path == "/profiles/76561198203778795/":
            return httpx.Response(
                200,
                text="<profile><steamID64>76561198203778795</steamID64>"
                "<steamID><![CDATA[New & current]]></steamID></profile>",
            )
        return httpx.Response(503)

    with httpx.Client(
        base_url="https://steamcommunity.com", transport=httpx.MockTransport(steam_profile)
    ) as steam_client:
        snapshot = collect_league_data(
            league_id=19224,
            output_path=output,
            refresh_recent=1,
            client=client,  # type: ignore[arg-type]
            steam_client=steam_client,
        )

    assert "/matches/1" not in client.requested
    assert snapshot["matches"][0]["players"][0]["personaname"] == "Old nickname"
    assert snapshot["player_names"] == {
        "1001": "Previously fetched",
        "243513067": "New & current",
    }


def test_collector_refreshes_unique_rank_tiers_in_complete_matches(tmp_path: Path) -> None:
    output = tmp_path / "league.json"
    old_match = make_match(1)
    recent_match = make_match(2)
    for match in (old_match, recent_match):
        match["players"][-1]["account_id"] = None
    incomplete_match = make_match(3)
    incomplete_match["players"] = [{**incomplete_match["players"][0], "account_id": 99}]
    write_snapshot(
        output,
        {
            "league_id": 19224,
            "matches": [normalise_match(old_match, 19224)],
            "opendota_rank_tiers": {
                "99": 21,
                "1000": 50,
                "1001": 42,
                "1002": 80,
                "1004": 77,
                "1006": "43",
            },
        },
    )
    failure = LeagueCollectionError("OpenDota server error 503")
    client = FakeClient(
        {
            "/leagues/19224": {"name": "Test League"},
            "/leagues/19224/matchIds": [1, 2, 3],
            "/matches/2": recent_match,
            "/matches/3": incomplete_match,
            "/players/1000": {"rank_tier": 75},
            "/players/1001": {"rank_tier": 0},
            "/players/1002": failure,
            "/players/1003": {"rank_tier": 10},
            "/players/1004": {"rank_tier": "54"},
            "/players/1004/ratings": [
                {"time": "2026-01-01T00:00:00Z", "rank_tier": 61},
                {"time": 1_700_000_000, "rank_tier": 34},
                {"time": "2026-02-01T00:00:00Z", "rank_tier": 81},
                {"time": "invalid", "rank_tier": 75},
            ],
            "/players/1005": {"rank_tier": True, "computed_mmr": 54},
            "/players/1005/ratings": {"rank_tier": 70},
            "/players/1006": failure,
            "/players/1006/ratings": failure,
            "/players/1007/ratings": [{"time": 1_800_000_000, "rank_tier": 35}],
            "/players/1008": None,
            "/players/1008/ratings": [],
        }
    )

    snapshot = collect_league_data(
        league_id=19224, output_path=output, refresh_recent=2, client=client,  # type: ignore[arg-type]
    )

    assert snapshot["opendota_rank_tiers"] == {
        "1000": 75,
        "1001": 42,
        "1002": 80,
        "1003": 10,
        "1004": 61,
        "1007": 35,
    }
    assert [path for path in client.requested if path.startswith("/players/")] == [
        *(f"/players/{account_id}" for account_id in range(1000, 1009)),
        *(f"/players/{account_id}/ratings" for account_id in range(1004, 1009)),
    ]


def test_opendota_client_caps_paid_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    requests: list[httpx.Request] = []

    def profile(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if "Authorization" not in request.headers:
            return httpx.Response(429, json={"error": "daily API limit exceeded"})
        return httpx.Response(503)

    monkeypatch.setattr("collector.time.sleep", lambda _: None)
    with OpenDotaLeagueClient(
        api_key="test-key", max_paid_calls=1, transport=httpx.MockTransport(profile)
    ) as client:
        with pytest.raises(LeagueCollectionError, match="paid-call safety limit reached"):
            client.get_json("/players/1000")

        assert client.free_exhausted
        assert client.paid_calls == 1
        assert [request.headers.get("Authorization") for request in requests] == [
            None,
            "Bearer test-key",
        ]
