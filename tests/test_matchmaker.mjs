import assert from "node:assert/strict";
import test from "node:test";
import { buildLeagueRoster, calibrateModel, DEFAULT_MODEL, describeRankTier, estimateRankMmr, findBalancedTeams } from "../site/matchmaker-model.js";

function match(matchId, startTime, radiantWin, firstAccountId = 1) {
  return {
    match_id: matchId,
    start_time: startTime,
    radiant_win: radiantWin,
    players: [0, 1, 2, 3, 4, 128, 129, 130, 131, 132].map((slot, index) => ({
      account_id: index + firstAccountId,
      player_slot: slot,
      personaname: `Player ${index + firstAccountId}`,
    })),
  };
}

function playersById(snapshot, manualMmr) {
  return new Map(buildLeagueRoster(snapshot, manualMmr).map((entry) => [entry.accountId, entry]));
}

function playersForRatings(ratings) {
  return ratings.map((rating, index) => ({ accountId: index + 1, rating }));
}

function expectedWinChance(ratingDifference) {
  return 1 / (1 + 10 ** (-ratingDifference / 400));
}

test("describes public rank tiers and estimates configured star-band midpoints", () => {
  const medals = ["先锋", "卫士", "中军", "统帅", "传奇", "万古流芳", "超凡入圣"];
  const estimates = [
    [385, 77, 231, 385, 539, 693],
    [1155, 847, 1001, 1155, 1309, 1463],
    [1925, 1617, 1771, 1925, 2079, 2233],
    [2695, 2387, 2541, 2695, 2849, 3003],
    [3465, 3157, 3311, 3465, 3619, 3773],
    [4235, 3927, 4081, 4235, 4389, 4543],
    [5120, 4720, 4920, 5120, 5320, 5520],
  ];
  medals.forEach((name, index) => {
    for (let stars = 0; stars <= 5; stars += 1) {
      const tier = (index + 1) * 10 + stars;
      assert.equal(describeRankTier(tier), stars ? `${name} ${stars} 星` : name);
      assert.equal(estimateRankMmr(tier), estimates[index][stars]);
    }
  });
  assert.equal(describeRankTier(80), "冠绝一世");
  assert.equal(estimateRankMmr(80), 6000);
  for (const value of [undefined, null, 0, 9, 16, 76, 79, 81, 90, 42.25, "42", true]) {
    assert.equal(describeRankTier(value), "");
    assert.equal(estimateRankMmr(value), null);
  }
});

test("seeds Elo with manual, medal, and medal-median baselines and applies each team's delta", () => {
  const shepherd = 883819932;
  const volatil = 372120492;
  const leagueMatch = match(1, 100, true);
  leagueMatch.players[1].account_id = shepherd;
  leagueMatch.players[2].account_id = volatil;
  const radiant = new Set(leagueMatch.players.slice(0, 5).map((player) => player.account_id));
  const roster = playersById({
    matches: [leagueMatch],
    player_names: { 1: " Steam name " },
    opendota_rank_tiers: { 1: 75, [shepherd]: 80, [volatil]: 55, 4: 0, 11: 21 },
    opendota_ratings: { 1: 12000, [shepherd]: 4152.87, [volatil]: 4100.75 },
  }, { 1: 2400, [volatil]: "6000", 11: 99999 });
  const teamRatingDifference = (2400 + 6000 + 3773 + 2 * 5520) / 5 - 5520;
  const delta = 50 * (1 - expectedWinChance(teamRatingDifference));
  assert.equal(roster.size, 10);
  assert.deepEqual(roster.get(1), {
    accountId: 1,
    name: "Steam name",
    games: 1,
    baseRating: 2400,
    inhouseRating: 2400 + delta,
    inhouseWeight: 1 / 37,
    rankTier: 75,
    ratingSource: "manual",
    rating: 2400 + (1 / 37) * ((2400 + delta) - 2400),
  });
  assert.equal(roster.get(shepherd).baseRating, 6000);
  assert.equal(roster.get(shepherd).ratingSource, "medal");
  assert.equal(roster.get(volatil).baseRating, 3773);
  assert.equal(roster.get(volatil).ratingSource, "medal");
  assert.deepEqual(roster.get(4), {
    accountId: 4,
    name: "Player 4",
    games: 1,
    baseRating: 5520,
    inhouseRating: 5520 + delta,
    inhouseWeight: 1 / 37,
    rankTier: null,
    ratingSource: "median",
    rating: 5520 + (1 / 37) * ((5520 + delta) - 5520),
  });
  for (const [id, player] of roster) {
    assert.ok(Math.abs(player.inhouseRating - player.baseRating - (radiant.has(id) ? delta : -delta)) < 1e-10);
  }
  const [captainA, captainB, ...others] = roster.values();
  assert.equal(findBalancedTeams(captainA, captainB, others).examined, 70);
});

test("uses the manual median only when no roster member has a public medal", () => {
  const anonymous = match(2, 200, false);
  anonymous.players[9].account_id = null;
  const roster = playersById({
    matches: [anonymous],
    opendota_rank_tiers: { 1: 0, 2: 86, 11: 80 },
  }, { 1: 0, 2: 99999, 3: 100000, 4: -1, 5: 1.5, 6: Infinity, 7: "2345", 11: 7000 });
  assert.equal(roster.get(1).rating, 0);
  assert.equal(roster.get(1).ratingSource, "manual");
  assert.equal(roster.get(2).rating, 99999);
  assert.equal(roster.get(2).ratingSource, "manual");
  for (let id = 3; id <= 9; id += 1) {
    const player = roster.get(id);
    assert.equal(player.ratingSource, "median");
    assert.equal(player.rankTier, null);
    assert.equal(player.games, 0);
    assert.equal(player.inhouseWeight, 0);
    assert.equal(player.baseRating, 49999.5);
    assert.equal(player.inhouseRating, 49999.5);
    assert.equal(player.rating, 49999.5);
  }
});

test("blends the in-house Elo change with 10%, 25% and at most 50% weight", () => {
  for (const [games, weight] of [[4, 0.1], [12, 0.25], [36, 0.5], [48, 0.5]]) {
    const matches = Array.from({ length: games }, (_, index) => match(index + 1, index, true));
    const player = playersById({ matches }, { 1: 4000 }).get(1);
    assert.equal(player.games, games);
    assert.equal(player.inhouseWeight, weight);
    assert.ok(player.inhouseRating > player.baseRating);
    assert.equal(player.rating, player.baseRating + weight * (player.inhouseRating - player.baseRating));
  }
});

test("replays scored matches by start time then ID and skips duplicate or malformed matches", () => {
  const first = match(20, 100, true);
  const second = match(22, 100, false);
  const newest = match(1, 200, true);
  newest.players[0].personaname = " Latest nickname ";
  newest.players[1].personaname = " ";
  const badSlots = match(51, 300, true, 71);
  badSlots.players[9].player_slot = badSlots.players[8].player_slot;
  const roster = playersById({
    matches: [newest, second, first, first, match(3, 300, 1, 31), match(4, 300, true, 51), badSlots],
    metadata: { incomplete_roster_match_ids: [4] },
  }, { 1: 4000 });
  const afterSecond = 4025 - 50 * expectedWinChance(50);
  const expected = afterSecond + 50 * (1 - expectedWinChance(2 * (afterSecond - 4000)));
  assert.equal(roster.size, 10);
  assert.ok(Math.abs(roster.get(1).inhouseRating - expected) < 1e-10);
  assert.ok(Math.abs(roster.get(6).inhouseRating - (8000 - expected)) < 1e-10);
  assert.equal(roster.get(1).games, 3);
  assert.equal(roster.get(1).name, "Latest nickname");
  assert.equal(roster.get(2).name, "Player 2");
});

test("discovers visible players in anonymous matches and ignores ratings from the legacy field", () => {
  const anonymous = match(2, 200, false, 7);
  anonymous.players[9].account_id = null;
  const repeatedAccount = match(3, 300, true);
  repeatedAccount.players[9].account_id = 9;
  const roster = playersById({
    matches: [anonymous, repeatedAccount, match(1, 100, true)],
    opendota_ratings: { 1: 8000, 7: 4000, 16: 3000 },
  });
  assert.equal(roster.size, 15);
  assert.equal(roster.get(7).games, 1);
  assert.equal(roster.get(7).rating, null);
  assert.equal(roster.get(7).inhouseRating, null);
  assert.deepEqual(roster.get(15), {
    accountId: 15,
    name: "Player 15",
    games: 0,
    baseRating: null,
    inhouseRating: null,
    inhouseWeight: 0,
    rankTier: null,
    ratingSource: "unavailable",
    rating: null,
  });
});

test("examines all 70 assignments and spreads comparable plans across noncaptains", () => {
  const [captainA, captainB, ...others] = playersForRatings(Array(10).fill(4000));
  const result = findBalancedTeams(captainA, captainB, others);
  assert.equal(result.examined, 70);
  assert.equal(result.withinRange, 70);
  assert.equal(result.plans.length, 5);
  assert.deepEqual(result, findBalancedTeams(captainA, captainB, [...others].reverse()));
  const distances = [];
  result.plans.forEach((plan, index) => {
    assert.equal(plan.teamA[0], captainA);
    assert.equal(plan.teamB[0], captainB);
    assert.equal(plan.teamA.length, 5);
    assert.equal(plan.teamB.length, 5);
    assert.equal(new Set([...plan.teamA, ...plan.teamB]).size, 10);
    assert.equal(plan.averageA, 4000);
    assert.equal(plan.averageB, 4000);
    assert.equal(plan.ratingGap, 0);
    assert.equal(plan.winChanceA, 0.5);
    for (const previous of result.plans.slice(0, index)) {
      distances.push(2 * plan.teamA.slice(1).filter((player) => !previous.teamA.includes(player)).length);
    }
  });
  assert.equal(Math.min(...distances), 4);
  assert.equal(Math.max(...distances), 8);
});

test("keeps the closest split and caps diversity by the fifth-best plan's balance", () => {
  const [captainA, captainB, ...others] = playersForRatings([
    3220, 3445, 3040, 3055, 3275, 3165, 3310, 3305, 3430, 3425,
  ]);
  const { plans, withinRange } = findBalancedTeams(captainA, captainB, others);
  assert.equal(withinRange, 36);
  // The fifth-best gap is 16. The 1 pp allowance admits a gap of 22 and excludes 24.
  assert.deepEqual(plans.map((plan) => plan.ratingGap), [6, 14, 16, 22, 22]);
});

test("returns every qualifying split when there are at most five", () => {
  const [captainA, captainB, ...others] = playersForRatings([
    4200, 3000, 5200, 4800, 5600, 5600, 1600, 1600, 3600, 3600,
  ]);
  const { plans, withinRange } = findBalancedTeams(captainA, captainB, others);
  assert.equal(withinRange, 4);
  assert.deepEqual(plans.map((plan) => plan.winChanceA), [0.5, 0.5, 0.5, 0.5]);
});

test("accepts the two inclusive probability bounds and falls back to the three closest splits", () => {
  const [captainA, captainB, ...others] = playersForRatings([0, 2000 * Math.log10(3 / 2), ...Array(8).fill(0)]);
  assert.equal(findBalancedTeams(captainA, captainB, others).withinRange, 70);
  assert.equal(findBalancedTeams(captainB, captainA, others).withinRange, 70);

  const [strong, regular, ...pool] = playersForRatings([
    9000, 4000, 3660, 3760, 3890, 3990, 4040, 4180, 4270, 4430,
  ]);
  const { plans, withinRange } = findBalancedTeams(strong, regular, pool);
  assert.equal(withinRange, 0);
  assert.equal(plans.length, 3);
  assert.deepEqual(plans[0].teamA.map((player) => player.accountId), [1, 3, 4, 5, 6]);
  assert.ok(plans[0].ratingGap <= plans[1].ratingGap && plans[1].ratingGap <= plans[2].ratingGap);
  assert.ok(Math.abs(plans[0].winChanceA - expectedWinChance(676)) < 1e-10);
});

test("rejects wrong-sized selections, repeated IDs and missing ratings", () => {
  const [captainA, captainB, ...others] = playersForRatings(Array(10).fill(4000));
  assert.throws(() => findBalancedTeams(captainA, captainB, others.slice(1)), TypeError);
  assert.throws(() => findBalancedTeams(captainA, captainA, others), TypeError);
  assert.throws(() => findBalancedTeams(captainA, captainB, [...others.slice(1), captainA]), TypeError);
  assert.throws(() => findBalancedTeams({ ...captainA, rating: null }, captainB, others), TypeError);
});

function syntheticLeague(matchCount, trueScale) {
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const ratings = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [index + 1, 3000 + index * 150]));
  const matches = [];
  for (let index = 0; index < matchCount; index += 1) {
    const ids = Object.keys(ratings).map(Number).sort(() => random() - 0.5).slice(0, 10);
    const gap = (ids.slice(0, 5).reduce((sum, id) => sum + ratings[id], 0) - ids.slice(5).reduce((sum, id) => sum + ratings[id], 0)) / 5;
    matches.push({
      match_id: index + 1,
      start_time: 1_800_000_000 + index * 3600,
      radiant_win: random() < 1 / (1 + 10 ** (-gap / trueScale)),
      players: [0, 1, 2, 3, 4, 128, 129, 130, 131, 132].map((slot, seat) => ({ account_id: ids[seat], player_slot: slot })),
    });
  }
  return { snapshot: { matches }, ratings };
}

test("keeps the default model until there are enough matches to calibrate", () => {
  const { snapshot, ratings } = syntheticLeague(14, 400);
  const result = calibrateModel(snapshot, ratings);
  assert.equal(result.matches, 14);
  assert.equal(result.status, "collecting");
  assert.deepEqual(result.applied, DEFAULT_MODEL);
  assert.ok(result.scaleInterval[0] <= result.fitted.scale && result.fitted.scale <= result.scaleInterval[1]);
});

test("adopts a shrunk scale once the fitted interval is closed and the history is long", () => {
  const { snapshot, ratings } = syntheticLeague(400, 800);
  const result = calibrateModel(snapshot, ratings);
  assert.equal(result.status, "applied");
  assert.ok(result.scaleInterval[0] <= 800 && 800 <= result.scaleInterval[1], JSON.stringify(result));
  assert.ok(result.applied.scale > DEFAULT_MODEL.scale && result.applied.scale <= result.fitted.scale, JSON.stringify(result));

  const players = buildLeagueRoster(snapshot, ratings, result.applied);
  const [captainA, captainB, ...others] = players.slice(0, 10);
  const wide = findBalancedTeams(captainA, captainB, others, { scale: 2000 });
  const narrow = findBalancedTeams(captainA, captainB, others);
  assert.ok(wide.withinRange >= narrow.withinRange);
});
