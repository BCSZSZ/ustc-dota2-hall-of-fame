import assert from "node:assert/strict";
import test from "node:test";
import { buildLeagueRoster, findBalancedTeams } from "../site/matchmaker-model.js";

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

function playersById(snapshot) {
  return new Map(buildLeagueRoster(snapshot).map((entry) => [entry.accountId, entry]));
}

function playersForRatings(ratings) {
  return ratings.map((rating, index) => ({ accountId: index + 1, rating }));
}

function expectedWinChance(ratingDifference) {
  return 1 / (1 + 10 ** (-ratingDifference / 400));
}

test("updates everyone on each side equally and blends external scores at full precision", () => {
  const roster = playersById({
    matches: [match(1, 100, true)],
    player_names: { 1: " Steam name " },
    opendota_ratings: { 1: 3900.25, 2: "6000", 3: 4100.75, 11: 9000 },
  });
  assert.equal(roster.size, 10);
  assert.deepEqual(roster.get(1), {
    accountId: 1,
    name: "Steam name",
    games: 1,
    inhouseRating: 4025,
    openDotaRating: 3900.25,
    usedOpenDotaMedian: false,
    rating: 3962.625,
  });
  for (let id = 1; id <= 10; id += 1) {
    assert.equal(roster.get(id).inhouseRating, id <= 5 ? 4025 : 3975);
  }
  assert.deepEqual(roster.get(2), {
    accountId: 2,
    name: "Player 2",
    games: 1,
    inhouseRating: 4025,
    openDotaRating: 4000.5,
    usedOpenDotaMedian: true,
    rating: 4012.75,
  });
  const [captainA, captainB, ...others] = roster.values();
  assert.equal(findBalancedTeams(captainA, captainB, others).examined, 70);
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
  });
  const afterSecond = 4025 - 50 * expectedWinChance(50);
  const expected = afterSecond + 50 * (1 - expectedWinChance(2 * (afterSecond - 4000)));
  assert.equal(roster.size, 10);
  assert.ok(Math.abs(roster.get(1).inhouseRating - expected) < 1e-10);
  assert.ok(Math.abs(roster.get(6).inhouseRating - (8000 - expected)) < 1e-10);
  assert.equal(roster.get(1).games, 3);
  assert.equal(roster.get(1).name, "Latest nickname");
  assert.equal(roster.get(2).name, "Player 2");
});

test("discovers visible players in anonymous matches without rating invalid teams", () => {
  const anonymous = match(2, 200, false, 7);
  anonymous.players[9].account_id = null;
  const repeatedAccount = match(3, 300, true);
  repeatedAccount.players[9].account_id = 9;
  const roster = playersById({
    matches: [anonymous, repeatedAccount, match(1, 100, true)],
    opendota_ratings: { 1: Infinity, 16: 3000 },
  });
  assert.equal(roster.size, 15);
  assert.equal(roster.get(7).inhouseRating, 3975);
  assert.deepEqual(roster.get(15), {
    accountId: 15,
    name: "Player 15",
    games: 0,
    inhouseRating: 4000,
    openDotaRating: null,
    usedOpenDotaMedian: false,
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
  assert.equal(withinRange, 22);
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

test("accepts the two inclusive probability bounds and falls back to the closest split", () => {
  const [captainA, captainB, ...others] = playersForRatings([0, 2000 * Math.log10(11 / 9), ...Array(8).fill(0)]);
  assert.equal(findBalancedTeams(captainA, captainB, others).withinRange, 70);
  assert.equal(findBalancedTeams(captainB, captainA, others).withinRange, 70);

  const [strong, regular, ...pool] = playersForRatings([
    9000, 4000, 3660, 3760, 3890, 3990, 4040, 4180, 4270, 4430,
  ]);
  const { plans, withinRange } = findBalancedTeams(strong, regular, pool);
  assert.equal(withinRange, 0);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].teamA.map((player) => player.accountId), [1, 3, 4, 5, 6]);
  assert.ok(Math.abs(plans[0].winChanceA - expectedWinChance(676)) < 1e-10);
});

test("rejects wrong-sized selections, repeated IDs and missing ratings", () => {
  const [captainA, captainB, ...others] = playersForRatings(Array(10).fill(4000));
  assert.throws(() => findBalancedTeams(captainA, captainB, others.slice(1)), TypeError);
  assert.throws(() => findBalancedTeams(captainA, captainA, others), TypeError);
  assert.throws(() => findBalancedTeams(captainA, captainB, [...others.slice(1), captainA]), TypeError);
  assert.throws(() => findBalancedTeams({ ...captainA, rating: null }, captainB, others), TypeError);
});
