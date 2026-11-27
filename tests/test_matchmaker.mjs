import assert from "node:assert/strict";
import test from "node:test";
import { buildLeagueRoster, calibrateModel, DEFAULT_MODEL, describeRankTier, estimateRankMmr, findBalancedTeams, OPTIMAL_STRATEGY, PICK_TURNS, suggestPickOrder,
  attachPositionRatings, describeMedals, medalEstimate, POSITION_WEIGHTS, RARE_POSITION_PENALTY, positionProfile, rateLeague } from "../site/matchmaker-model.js";

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
    stratzRankTier: null,
    leaderboardRank: null,
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
    stratzRankTier: null,
    leaderboardRank: null,
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
    stratzRankTier: null,
    leaderboardRank: null,
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

test("without positions, optimal 1-2-2-2-1 picks take the highest remaining rating", () => {
  const [captainA, captainB, ...others] = playersForRatings([3000, 3000, 2000, 5000, 4000, 4500, 3500, 2500, 4000, 1000]);
  assert.deepEqual(PICK_TURNS, [1, 2, 2, 2, 1]);

  const first = suggestPickOrder(captainA, captainB, others);
  assert.deepEqual(first.picks.map(({ turn, side, player }) => [turn, side, player.accountId]),
    [[0, "A", 4], [1, "B", 6], [1, "B", 5], [2, "A", 9], [2, "A", 7], [3, "B", 8], [3, "B", 3], [4, "A", 10]]);
  assert.deepEqual(first.teamA.map((player) => player.accountId), [1, 4, 9, 7, 10]);
  assert.deepEqual(first.teamB.map((player) => player.accountId), [2, 6, 5, 8, 3]);
  assert.equal(first.averageA, 3300);
  assert.equal(first.averageB, 3200);
  assert.ok(Math.abs(first.winChanceA - expectedWinChance(100)) < 1e-12);

  const second = suggestPickOrder(captainA, captainB, [...others].reverse(), { firstPick: "B" });
  assert.deepEqual(second.picks.map(({ side, player }) => [side, player.accountId]),
    [["B", 4], ["A", 6], ["A", 5], ["B", 9], ["B", 7], ["A", 8], ["A", 3], ["B", 10]]);
});

test("lets each side use its own pick strategy and rejects invalid picks", () => {
  const [captainA, captainB, ...others] = playersForRatings([3000, 3000, 2000, 5000, 4000, 4500, 3500, 2500, 4000, 1000]);
  const lowest = { choose: ({ available }) => available.reduce((low, player) => (player.rating < low.rating ? player : low)) };
  const { teamA, teamB } = suggestPickOrder(captainA, captainB, others, { strategyB: lowest });
  assert.deepEqual(teamA.map((player) => player.accountId), [1, 4, 6, 5, 9]);
  assert.deepEqual(teamB.map((player) => player.accountId), [2, 10, 3, 8, 7]);
  assert.throws(() => suggestPickOrder(captainA, captainB, others, { firstPick: "C" }), TypeError);
  assert.throws(() => suggestPickOrder(captainA, captainB, others.slice(1)), TypeError);
  assert.throws(() => suggestPickOrder(captainA, captainB, others, { strategyA: { choose: () => captainB } }), Error);
});

function record(perPosition) {
  const positions = Object.fromEntries(["1", "2", "3", "4", "5"].map((position, index) => [position, perPosition[index] ?? [0, 0]]));
  return { games: Object.values(positions).reduce((sum, [games]) => sum + games, 0), since: "2026-06-01", positions };
}

test("rates each position from its shrunk win rate and marks rarely played positions", () => {
  const [player, newcomer, unknown] = attachPositionRatings(
    [{ accountId: 1, rating: 4000 }, { accountId: 2, rating: 3000 }, { accountId: 3, rating: 3500 }],
    { 1: record([[60, 30], [30, 21], [9, 9], [1, 0]]), 2: record([[29, 29]]) },
  );
  const overall = (60 + 25) / 150;
  const elo = (chance) => 400 * Math.log10(chance / (1 - chance));
  assert.ok(Math.abs(player.positions[2].delta - (elo((21 + overall * 50) / 80) - elo(overall))) < 1e-9);
  assert.ok(player.positions[2].rating > 4000 && player.positions[1].rating < 4000);
  assert.deepEqual(player.positions[3], { games: 9, wins: 9, rare: true, delta: null, rating: 4000 - RARE_POSITION_PENALTY });
  assert.equal(player.positions[5].rare, true);
  assert.equal(player.positionSince, "2026-06-01");
  assert.equal(newcomer.positions, null);
  assert.equal(unknown.positions, null);
});

function specialist(accountId, rating, best, bonus = 0) {
  const positions = Object.fromEntries(["1", "2", "3", "4", "5"].map((position) => [position,
    position === best ? { games: 50, wins: 25, rare: false, delta: bonus, rating: rating + bonus }
      : { games: 0, wins: 0, rare: true, delta: null, rating: rating - RARE_POSITION_PENALTY }]));
  return { accountId, rating, positions };
}

test("scores each team by its best weighted position lineup", () => {
  const captainA = specialist(1, 4000, "1");
  const captainB = specialist(2, 4000, "1");
  const others = [specialist(3, 4000, "2"), specialist(4, 4000, "2"), specialist(5, 4000, "3"), specialist(6, 4000, "3"),
    specialist(7, 4000, "4"), specialist(8, 4000, "4"), specialist(9, 4000, "5"), specialist(10, 4000, "5")];
  const { plans } = findBalancedTeams(captainA, captainB, others, { positions: true });
  for (const plan of plans) {
    assert.deepEqual(plan.lineupA.map((slot) => slot.player.positions[slot.position].rare), [false, false, false, false, false]);
    assert.ok(Math.abs(plan.averageA - 4000) < 1e-9 && Math.abs(plan.winChanceA - 0.5) < 1e-12);
  }
  assert.equal(plans.length, 5);

  // Team A drafts both mids: the stronger one plays mid and the other a rare position at -500.
  const twoMids = [specialist(3, 4400, "2"), specialist(4, 4000, "2"), ...others.slice(2)];
  const lowestId = { choose: ({ available }) => available.reduce((low, player) => (player.accountId < low.accountId ? player : low)) };
  const highestId = { choose: ({ available }) => available.reduce((high, player) => (player.accountId > high.accountId ? player : high)) };
  const { teamA, lineupA, averageA } = suggestPickOrder(captainA, captainB, twoMids, { strategyA: lowestId, strategyB: highestId, positions: true });
  assert.ok(teamA.includes(twoMids[0]) && teamA.includes(twoMids[1]));
  assert.equal(lineupA.find((slot) => slot.position === "2").player, twoMids[0]);
  const rareSlot = lineupA.find((slot) => slot.player === twoMids[1]);
  assert.equal(rareSlot.rare, true);
  const weighted = lineupA.reduce((sum, slot) => sum + POSITION_WEIGHTS[slot.position] * slot.rating, 0) /
    Object.values(POSITION_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  assert.ok(Math.abs(averageA - weighted) < 1e-9);
});

test("optimal play knows the other side's strategy and never does worse than greedy", () => {
  const ratings = [4300, 4100, 4900, 4700, 4500, 4200, 4000, 3800, 3600, 3300];
  const mains = ["2", "5", "1", "2", "3", "4", "2", "5", "1", "3"];
  const bonus = [80, 0, 40, -30, 0, 20, 60, 0, -50, 10];
  const [captainA, captainB, ...others] = ratings.map((rating, index) => specialist(index + 1, rating, mains[index], bonus[index]));
  const lookahead = OPTIMAL_STRATEGY;
  const highestRating = { choose: ({ available }) => available.reduce((best, player) => (player.rating > best.rating ? player : best)) };
  for (const firstPick of ["A", "B"]) {
    const chance = (strategyA, strategyB) =>
      suggestPickOrder(captainA, captainB, others, { firstPick, strategyA, strategyB, positions: true }).winChanceA;
    const optimal = chance(lookahead, lookahead);
    assert.ok(chance(lookahead, highestRating) >= chance(highestRating, highestRating) - 1e-12);
    assert.ok(chance(highestRating, lookahead) <= chance(highestRating, highestRating) + 1e-12);
    assert.ok(optimal <= chance(lookahead, highestRating) + 1e-12);
    assert.ok(optimal >= chance(highestRating, lookahead) - 1e-12);
  }
  const both = suggestPickOrder(captainA, captainB, others, { positions: true });
  assert.equal(both.picks.length, 8);
  assert.equal(new Set(both.picks.map(({ player }) => player.accountId)).size, 8);
  assert.equal(both.lineupA.length, 5);
});

test("estimates an Immortal's rating from the regional leaderboard place", () => {
  assert.equal(estimateRankMmr(80, 1), 9500);
  assert.equal(estimateRankMmr(80, 5000), 6200);
  assert.equal(estimateRankMmr(80, 9000), 6200);
  assert.equal(estimateRankMmr(80, 302), 7287);
  assert.ok(estimateRankMmr(80, 100) > estimateRankMmr(80, 1000));
  for (const place of [undefined, null, 0, -3, 1.5, "302"]) assert.equal(estimateRankMmr(80, place), 6000);
  assert.equal(estimateRankMmr(75, 4808), 5520);
  assert.equal(describeRankTier(80, 302), "冠绝一世 第 302 名");
  assert.equal(describeRankTier(75, 4808), "超凡入圣 5 星");

  const snapshot = { matches: [match(1, 100, true)], opendota_rank_tiers: { 1: 80, 2: 75 }, opendota_leaderboard_ranks: { 1: 302, 2: 4808 } };
  const players = playersById(snapshot, {});
  assert.equal(players.get(1).baseRating, 7287);
  assert.equal(players.get(1).leaderboardRank, 302);
  assert.equal(players.get(2).baseRating, 5520);
  assert.equal(players.get(2).leaderboardRank, null);
});

test("tags each position as most played, regular or rare", () => {
  const [player, unknown] = attachPositionRatings(
    [{ accountId: 1, rating: 4000 }, { accountId: 2, rating: 3000 }],
    { 1: record([[40, 20], [40, 22], [12, 6], [8, 4]]) },
  );
  assert.deepEqual(positionProfile(player).map(({ position, name, tag }) => [position, name, tag]),
    [["1", "核心", "main"], ["2", "中单", "main"], ["3", "劣势路", "regular"], ["4", "辅助", "rare"], ["5", "硬辅助", "rare"]]);
  assert.equal(positionProfile(unknown), null);

  const snapshot = { matches: [match(1, 100, true)], opendota_rank_tiers: { 1: 55 } };
  const rated = rateLeague(snapshot, { 2: 4100 }, { players: { 1: record([[30, 15], [20, 10]]) } });
  assert.equal(rated.find((entry) => entry.accountId === 2).baseRating, 4100);
  assert.equal(positionProfile(rated.find((entry) => entry.accountId === 1))[0].tag, "main");
});

test("combines OpenDota's and STRATZ's medals", () => {
  assert.equal(medalEstimate(72, undefined, 65), (4920 + 4543) / 2);
  assert.equal(medalEstimate(72, undefined, 72), 4920);
  assert.equal(medalEstimate(null, undefined, 65), 4543);
  assert.equal(medalEstimate(72, undefined, null), 4920);
  assert.equal(medalEstimate(80, 302, 80), 7287, "only OpenDota knows the leaderboard place");
  assert.equal(medalEstimate(80, 302, 75), (7287 + 5520) / 2);
  assert.equal(describeMedals(72, undefined, 65), "OpenDota 超凡入圣 2 星 / STRATZ 万古流芳 5 星");
  assert.equal(describeMedals(72, undefined, 72), "超凡入圣 2 星");
  assert.equal(describeMedals(undefined, undefined, 65), "万古流芳 5 星");

  const snapshot = { matches: [match(1, 100, true)], opendota_rank_tiers: { 1: 72 }, stratz_rank_tiers: { 1: 65, 2: 54 } };
  const players = playersById(snapshot, {});
  assert.equal(players.get(1).baseRating, (4920 + 4543) / 2);
  assert.equal(players.get(1).stratzRankTier, 65);
  assert.equal(players.get(2).baseRating, 3619);
  assert.equal(players.get(2).ratingSource, "medal");
});
