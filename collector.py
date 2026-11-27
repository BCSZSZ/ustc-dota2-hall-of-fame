from __future__ import annotations

import argparse
import json
import os
import random
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import httpx
from dotenv import load_dotenv

from match_details import _read, ensure_images, refresh_match_details
from replays import REPLAY_DIR, archive_all, gh_uploader, plan_downloads, read_manifest, record_archives
from hero_meta import refresh_hero_meta
from position_stats import refresh_position_stats
from stratz import refresh_stratz, stratz_client

API_BASE_URL = "https://api.opendota.com/api"
STEAM_COMMUNITY_URL = "https://steamcommunity.com"
STEAM_ACCOUNT_ID_OFFSET = 76_561_197_960_265_728
DEFAULT_LEAGUE_ID = 19224
DEFAULT_OUTPUT = Path("site/data/league.json")
PLAYER_SLOTS = {*range(5), *range(128, 133)}
JST = timezone(timedelta(hours=9))
# Matches before this moment never count. Players seen only before it are "neighbours".
SEASON_START = int(datetime(2026, 9, 13, tzinfo=JST).timestamp())
# Every player in a season match before this moment seeds the core roster. Later
# matches count only if they include a core player, and then add their players to it.
CORE_ROSTER_SEED_END = int(datetime(2026, 11, 27, tzinfo=JST).timestamp())


class LeagueCollectionError(RuntimeError):
    """Raised when a league snapshot cannot be collected safely."""


class OpenDotaLeagueClient:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        max_paid_calls: int = 250,
        timeout_seconds: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._api_key = api_key or None
        self._max_paid_calls = max_paid_calls
        self._paid_calls = 0
        self._free_exhausted = False
        self._client = httpx.Client(
            base_url=API_BASE_URL,
            headers={"User-Agent": "ustc-dota2-hall-of-fame/1.0"},
            timeout=timeout_seconds,
            transport=transport,
        )

    @property
    def paid_calls(self) -> int:
        return self._paid_calls

    @property
    def free_exhausted(self) -> bool:
        return self._free_exhausted

    def __enter__(self) -> OpenDotaLeagueClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    @staticmethod
    def _error_message(response: httpx.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            return response.text.strip().lower()
        if isinstance(payload, dict):
            return str(payload.get("error") or payload.get("message") or payload).lower()
        return str(payload).lower()

    def _sleep_until_next_minute(self) -> None:
        remaining = 61.0 - (time.time() % 60.0)
        time.sleep(max(2.0, remaining) + random.uniform(0.2, 1.2))

    def _request(self, path: str, *, paid: bool, method: str = "GET") -> Any:
        headers: dict[str, str] = {}
        if paid:
            if not self._api_key:
                raise LeagueCollectionError(
                    "OpenDota anonymous daily quota was exhausted and no API key is configured"
                )
            headers["Authorization"] = f"Bearer {self._api_key}"

        for attempt in range(4):
            if paid:
                if self._paid_calls >= self._max_paid_calls:
                    raise LeagueCollectionError(
                        f"OpenDota paid-call safety limit reached ({self._max_paid_calls})"
                    )
                self._paid_calls += 1
            try:
                response = self._client.request(method, path, headers=headers)
            except httpx.RequestError as error:
                if attempt == 3:
                    raise LeagueCollectionError(
                        f"OpenDota request failed for {path}: {error}"
                    ) from error
                time.sleep(2**attempt + random.uniform(0.1, 0.8))
                continue

            message = self._error_message(response)
            if response.status_code == 429 and "minute rate limit exceeded" in message:
                if attempt == 3:
                    raise LeagueCollectionError(f"OpenDota minute rate limit persisted for {path}")
                self._sleep_until_next_minute()
                continue
            if response.status_code == 429 and "daily api limit exceeded" in message:
                if paid:
                    raise LeagueCollectionError("OpenDota API-key daily limit was exhausted")
                self._free_exhausted = True
                return self._request(path, paid=True, method=method)
            if response.status_code >= 500:
                if attempt == 3:
                    raise LeagueCollectionError(
                        f"OpenDota server error {response.status_code} for {path}"
                    )
                time.sleep(2**attempt + random.uniform(0.1, 0.8))
                continue
            if response.status_code >= 400:
                raise LeagueCollectionError(
                    f"OpenDota returned {response.status_code} for {path}: {message}"
                )
            try:
                return response.json()
            except ValueError as error:
                raise LeagueCollectionError(f"OpenDota returned invalid JSON for {path}") from error

        raise AssertionError("unreachable")

    def get_json(self, path: str) -> Any:
        return self._request(path, paid=self._free_exhausted)

    def request_parse(self, match_id: int) -> Any:
        """Ask OpenDota to parse a match replay that has no parsed data yet."""
        return self._request(f"/request/{match_id}", paid=self._free_exhausted, method="POST")


def normalise_match(raw: dict[str, Any], league_id: int) -> dict[str, Any]:
    match_id = int(raw.get("match_id") or 0)
    actual_league_id = int(raw.get("leagueid") or 0)
    start_time = int(raw.get("start_time") or 0)
    duration = int(raw.get("duration") or 0)
    radiant_win = raw.get("radiant_win")
    players = raw.get("players")

    if match_id <= 0 or start_time <= 0 or duration < 0:
        raise LeagueCollectionError(f"Match {match_id or '<unknown>'} has invalid core fields")
    if actual_league_id != league_id:
        raise LeagueCollectionError(
            f"Match {match_id} belongs to league {actual_league_id}, expected {league_id}"
        )
    if not isinstance(radiant_win, bool):
        raise LeagueCollectionError(f"Match {match_id} has no scored winner")
    if not isinstance(players, list):
        raise LeagueCollectionError(f"Match {match_id} has no player roster")

    normalised_players: list[dict[str, Any]] = []
    for player in players:
        if not isinstance(player, dict):
            continue
        player_slot = player.get("player_slot")
        if not isinstance(player_slot, int) or player_slot not in PLAYER_SLOTS:
            continue
        account_id = player.get("account_id")
        normalised_players.append(
            {
                "account_id": (
                    int(account_id) if isinstance(account_id, int) and account_id > 0 else None
                ),
                "personaname": str(player.get("personaname") or "").strip() or None,
                "player_slot": player_slot,
                "hero_id": int(player.get("hero_id") or 0),
            }
        )

    return {
        "match_id": match_id,
        "league_id": league_id,
        "start_time": start_time,
        "duration": duration,
        "radiant_win": radiant_win,
        "players": normalised_players,
    }


def _has_complete_roster(match: dict[str, Any]) -> bool:
    players = match.get("players", [])
    return (
        len(players) == len(PLAYER_SLOTS)
        and {player["player_slot"] for player in players} == PLAYER_SLOTS
    )


def _load_existing(
    path: Path, league_id: int
) -> tuple[dict[int, dict[str, Any]], dict[str, str], dict[str, Any], dict[str, Any]]:
    if not path.exists():
        return {}, {}, {}, {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}, {}, {}, {}
    if int(payload.get("league_id") or 0) != league_id:
        return {}, {}, {}, {}
    result: dict[int, dict[str, Any]] = {}
    for match in [*payload.get("matches", []), *payload.get("excluded_matches", [])]:
        if (
            isinstance(match, dict)
            and int(match.get("match_id") or 0) > 0
            and _has_complete_roster(match)
        ):
            result[int(match["match_id"])] = {
                key: value for key, value in match.items() if key != "exclusion_reason"
            }
    names = payload.get("player_names")
    rank_tiers = payload.get("opendota_rank_tiers")
    leaderboard_ranks = payload.get("opendota_leaderboard_ranks")
    return (
        result,
        names if isinstance(names, dict) else {},
        rank_tiers if isinstance(rank_tiers, dict) else {},
        leaderboard_ranks if isinstance(leaderboard_ranks, dict) else {},
    )


def _account_ids(match: dict[str, Any]) -> set[int]:
    return {player["account_id"] for player in match["players"] if player["account_id"] is not None}


def classify_matches(
    matches: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[int], list[int]]:
    """Split complete matches into counted and excluded ones, plus core and neighbour IDs."""
    counted: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    core: set[int] = set()
    before_season: set[int] = set()
    for match in sorted(matches, key=lambda item: (item["start_time"], item["match_id"])):
        account_ids = _account_ids(match)
        if match["start_time"] < SEASON_START:
            before_season |= account_ids
            excluded.append({**match, "exclusion_reason": "before_season"})
        elif match["start_time"] < CORE_ROSTER_SEED_END or account_ids & core:
            core |= account_ids
            counted.append(match)
        else:
            excluded.append({**match, "exclusion_reason": "no_core_player"})
    return counted, excluded, sorted(core), sorted(before_season - core)


def _known_account_ids(matches: list[dict[str, Any]]) -> list[int]:
    return sorted(
        {
            player["account_id"]
            for match in matches
            for player in match["players"]
            if player["account_id"] is not None
        }
    )


def _refresh_player_names(
    account_ids: list[int], previous_names: dict[str, str], client: httpx.Client
) -> dict[str, str]:
    names = {
        str(account_id): previous_names[str(account_id)]
        for account_id in account_ids
        if str(account_id) in previous_names
    }
    for account_id in account_ids:
        steam_id = str(STEAM_ACCOUNT_ID_OFFSET + account_id)
        try:
            response = client.get(f"/profiles/{steam_id}/", params={"xml": "1"})
            if response.status_code == 429:
                break
            response.raise_for_status()
            profile = ElementTree.fromstring(response.content)
        except (httpx.HTTPError, ElementTree.ParseError):
            continue
        name = profile.findtext("steamID", "").strip()
        if profile.findtext("steamID64") == steam_id and name:
            names[str(account_id)] = name
    return names


def _valid_rank_tier(value: Any) -> int | None:
    if type(value) is not int:
        return None
    medal, stars = divmod(value, 10)
    return value if value == 80 or (1 <= medal <= 7 and stars <= 5) else None


def _valid_leaderboard_rank(value: Any) -> int | None:
    return value if type(value) is int and value > 0 else None


def _latest_rank_tier(history: Any) -> int | None:
    if not isinstance(history, list):
        return None
    latest_tier = None
    latest_time = 0
    for entry in history:
        if not isinstance(entry, dict):
            continue
        rank_tier = _valid_rank_tier(entry.get("rank_tier"))
        if rank_tier is None:
            continue
        observed_at = entry.get("time")
        if isinstance(observed_at, str):
            try:
                timestamp = datetime.fromisoformat(observed_at)
            except ValueError:
                continue
            if timestamp.tzinfo is None:
                continue
            observed_at = timestamp.timestamp()
        elif type(observed_at) is not int:
            continue
        if observed_at > latest_time:
            latest_time = observed_at
            latest_tier = rank_tier
    return latest_tier


def _refresh_opendota_rank_tiers(
    account_ids: list[int], previous_rank_tiers: dict[str, Any], client: OpenDotaLeagueClient,
    previous_leaderboard_ranks: dict[str, Any] | None = None,
) -> tuple[dict[str, int], dict[str, int]]:
    """Medal per account, plus the regional leaderboard place of Immortal accounts."""
    rank_tiers: dict[str, int] = {}
    leaderboard_ranks: dict[str, int] = {}
    for account_id in account_ids:
        key = str(account_id)
        try:
            profile = client.get_json(f"/players/{key}")
        except LeagueCollectionError:
            profile = None
        rank_tier = _valid_rank_tier(profile.get("rank_tier")) if isinstance(profile, dict) else None
        leaderboard_rank = _valid_leaderboard_rank(profile.get("leaderboard_rank")) if isinstance(profile, dict) else None
        if rank_tier is None:
            rank_tier = _valid_rank_tier(previous_rank_tiers.get(key))
            leaderboard_rank = _valid_leaderboard_rank((previous_leaderboard_ranks or {}).get(key))
        if rank_tier is not None:
            rank_tiers[key] = rank_tier
        if rank_tier == 80 and leaderboard_rank is not None:
            leaderboard_ranks[key] = leaderboard_rank

    # Give profile requests first use of the shared request budget.
    for account_id in account_ids:
        key = str(account_id)
        if key in rank_tiers:
            continue
        try:
            history = client.get_json(f"/players/{key}/ratings")
        except LeagueCollectionError:
            continue
        rank_tier = _latest_rank_tier(history)
        if rank_tier is not None:
            rank_tiers[key] = rank_tier
    return rank_tiers, leaderboard_ranks


def collect_league_data(
    *,
    league_id: int,
    output_path: Path,
    refresh_recent: int = 5,
    client: OpenDotaLeagueClient,
    steam_client: httpx.Client | None = None,
    incremental: bool = False,
    raw_by_id: dict[int, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    league = client.get_json(f"/leagues/{league_id}")
    match_ids_raw = client.get_json(f"/leagues/{league_id}/matchIds")
    if not isinstance(league, dict):
        raise LeagueCollectionError("OpenDota returned an invalid league response")
    if not isinstance(match_ids_raw, list):
        raise LeagueCollectionError("OpenDota returned an invalid match-ID list")

    match_ids = sorted({int(match_id) for match_id in match_ids_raw if int(match_id) > 0})
    existing, player_names, previous_rank_tiers, previous_leaderboard_ranks = _load_existing(output_path, league_id)
    refresh_ids = set(match_ids[-refresh_recent:]) if refresh_recent > 0 else set()
    unavailable: list[dict[str, Any]] = []
    incomplete_rosters: list[int] = []
    matches: dict[int, dict[str, Any]] = {}

    for match_id in match_ids:
        if match_id in existing and match_id not in refresh_ids:
            matches[match_id] = existing[match_id]
            continue
        try:
            raw = client.get_json(f"/matches/{match_id}")
            if not isinstance(raw, dict):
                raise LeagueCollectionError("invalid match payload")
            if raw_by_id is not None:
                raw_by_id[match_id] = raw
            match = normalise_match(raw, league_id)
            if _has_complete_roster(match):
                matches[match_id] = match
            elif match_id in existing:
                matches[match_id] = existing[match_id]
            else:
                incomplete_rosters.append(match_id)
        except LeagueCollectionError as error:
            if match_id in existing:
                matches[match_id] = existing[match_id]
            else:
                unavailable.append({"match_id": match_id, "reason": str(error)})

    ordered_matches, excluded_matches, core_ids, neighbour_ids = classify_matches(
        [matches[match_id] for match_id in match_ids if match_id in matches]
    )
    account_ids = _known_account_ids(ordered_matches)
    if steam_client is not None:
        player_names = _refresh_player_names(account_ids, player_names, steam_client)
    if incremental:
        # Quick runs only add new matches; the daily full run refreshes ranks and names.
        opendota_rank_tiers = {
            str(account_id): rank_tier
            for account_id in account_ids
            if (rank_tier := _valid_rank_tier(previous_rank_tiers.get(str(account_id)))) is not None
        }
        opendota_leaderboard_ranks = {
            key: leaderboard_rank
            for key, tier in opendota_rank_tiers.items()
            if tier == 80 and (leaderboard_rank := _valid_leaderboard_rank(previous_leaderboard_ranks.get(key))) is not None
        }
    else:
        opendota_rank_tiers, opendota_leaderboard_ranks = _refresh_opendota_rank_tiers(
            account_ids, previous_rank_tiers, client, previous_leaderboard_ranks
        )
    anonymous_slots = sum(
        1
        for match in ordered_matches
        for player in match.get("players", [])
        if player.get("account_id") is None
    )
    return {
        "schema_version": 1,
        "league_id": league_id,
        "league": {
            "name": str(league.get("name") or f"League {league_id}"),
            "tier": str(league.get("tier") or ""),
            "banner": str(league.get("banner") or ""),
        },
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "time_zone": "Asia/Tokyo",
        "source": "OpenDota public API",
        "metadata": {
            "match_ids_returned": len(match_ids),
            "matches_available": len(ordered_matches),
            "season_start_utc": datetime.fromtimestamp(SEASON_START, UTC).isoformat(),
            "core_roster_seed_end_utc": datetime.fromtimestamp(CORE_ROSTER_SEED_END, UTC).isoformat(),
            "excluded_before_season": sum(
                match["exclusion_reason"] == "before_season" for match in excluded_matches
            ),
            "excluded_without_core_player": sum(
                match["exclusion_reason"] == "no_core_player" for match in excluded_matches
            ),
            "unavailable_matches": unavailable,
            "anonymous_player_slots": anonymous_slots,
            "incomplete_roster_match_ids": incomplete_rosters,
            "paid_calls": client.paid_calls,
            "anonymous_daily_quota_exhausted": client.free_exhausted,
        },
        "player_names": player_names,
        "opendota_rank_tiers": opendota_rank_tiers,
        "opendota_leaderboard_ranks": opendota_leaderboard_ranks,
        "player_groups": {"core": core_ids, "neighbour": neighbour_ids},
        "matches": ordered_matches,
        "excluded_matches": excluded_matches,
    }


def write_snapshot(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Collect a league snapshot for the GitHub Pages dashboard"
    )
    parser.add_argument("--league-id", type=int, default=DEFAULT_LEAGUE_ID)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--refresh-recent", type=int, default=5)
    parser.add_argument(
        "--incremental",
        action="store_true",
        help="only fetch new matches; reuse cached nicknames and rank tiers",
    )
    parser.add_argument(
        "--max-paid-calls",
        type=int,
        default=int(os.getenv("OPENDOTA_MAX_PAID_CALLS", "250")),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    args = build_parser().parse_args(argv)
    with (
        OpenDotaLeagueClient(
            api_key=os.getenv("OPENDOTA_API_KEY"), max_paid_calls=args.max_paid_calls
        ) as client,
        httpx.Client(base_url=STEAM_COMMUNITY_URL, timeout=5.0) as steam_client,
    ):
        raw_by_id: dict[int, dict[str, Any]] = {}
        payload = collect_league_data(
            league_id=args.league_id,
            output_path=args.output,
            refresh_recent=max(0, args.refresh_recent),
            client=client,
            steam_client=None if args.incremental else steam_client,
            incremental=args.incremental,
            raw_by_id=raw_by_id,
        )
        data_dir = args.output.parent
        match_ids = [match["match_id"] for match in payload["matches"]]
        now = datetime.now(UTC)
        replay_state = _read(data_dir / "pending.json")
        replay_jobs = plan_downloads(
            matches=payload["matches"],
            archived=read_manifest(data_dir),
            raw_by_id=raw_by_id,
            pending=replay_state.get("replays", {}),
            unavailable=set(replay_state.get("replays_unavailable", [])),
            client=client,
            error_type=LeagueCollectionError,
            now=now,
        )
        # Replay downloads and Release uploads run alongside the OpenDota parse requests and detail fetches.
        with (
            httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0), follow_redirects=True) as replay_http,
            ThreadPoolExecutor(max_workers=1) as pool,
        ):
            archives = pool.submit(archive_all, replay_jobs, REPLAY_DIR, replay_http, gh_uploader())
            details = refresh_match_details(
                data_dir=data_dir,
                counted=payload["matches"],
                raw_by_id=raw_by_id,
                client=client,
                error_type=LeagueCollectionError,
                refresh_constants=not args.incremental,
            )
            replays = record_archives(
                data_dir=data_dir, jobs=replay_jobs, results=archives.result(), match_ids=match_ids, now=now
            )
        if not args.incremental:
            token = os.getenv("STRATZ_TOKEN")
            with stratz_client(token) if token else nullcontext() as stratz_http:
                positions = refresh_position_stats(
                    data_dir=data_dir, account_ids=_known_account_ids(payload["matches"]), opendota=client,
                    stratz=stratz_http, now=now, error_type=LeagueCollectionError,
                )
                if stratz_http is not None:
                    meta = refresh_hero_meta(data_dir=data_dir, http=stratz_http, now=now)
                    print(f"Hero meta: {meta['heroes']} heroes ({'updated' if meta['updated'] else 'kept the previous file'})")
            print(f"Positions: recent games for {positions['players']} players ({positions['failed']} failed)")
    with httpx.Client(timeout=15.0, follow_redirects=True) as cdn:
        images = ensure_images(image_dir=args.output.parent.parent / "img", data_dir=args.output.parent, http=cdn)
    if token := os.getenv("STRATZ_TOKEN"):
        with stratz_client(token) as stratz_http:
            stratz = refresh_stratz(data_dir=data_dir, match_ids=match_ids, http=stratz_http, now=now)
        print(f"STRATZ: {stratz['scored']} matches with IMP, {stratz['fetched']} fetched, {stratz['waiting']} waiting, "
              f"{stratz['per_minute']} with per-minute data for the local estimate")
    else:
        print("STRATZ: no STRATZ_TOKEN, IMP and win chances not refreshed")
    write_snapshot(args.output, payload)
    print(f"Images: {images} new hero/item images saved")
    print(f"Replays: {replays['archived']} archived to Releases, {replays['waiting']} waiting for a retry")
    print(
        f"Match details: {details['summaries']} summaries, {details['fetched']} fetched, "
        f"{details['pending']} awaiting OpenDota parsing"
    )
    metadata = payload["metadata"]
    print(
        f"League {args.league_id}: wrote {metadata['matches_available']} matches "
        f"to {args.output} ({len(metadata['unavailable_matches'])} unavailable, "
        f"{len(metadata['incomplete_roster_match_ids'])} incomplete rosters excluded)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
