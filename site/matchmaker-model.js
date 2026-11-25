const MATCH_SLOTS = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
const STARTING_RATING = 4000;
const ELO_K = 50;
const MIN_WIN_CHANCE = 0.45;
const MAX_WIN_CHANCE = 0.55;
const PLAN_LIMIT = 5;
const DIVERSITY_SLACK = 0.01;

function average(ratings) {
  const total = ratings.reduce((sum, rating) => sum + rating, 0);
  if (Number.isFinite(total)) return total / ratings.length;
  return ratings.reduce((sum, rating) => sum + rating / ratings.length, 0);
}

function expectedWinChance(ratingDifference) {
  // Centered form of the standard 400-point Elo logistic curve.
  return 0.5 + 0.5 * Math.tanh(ratingDifference * Math.LN10 / 800);
}

function nonemptyName(name) {
  return typeof name === "string" ? name.trim() : "";
}

function hasFullSlots(players) {
  if (!Array.isArray(players) || players.length !== MATCH_SLOTS.length) return false;
  const slots = new Set(players.map((player) => player?.player_slot));
  return MATCH_SLOTS.every((slot) => slots.has(slot));
}

export function buildLeagueRoster(snapshot) {
  const excluded = new Set(snapshot.metadata?.incomplete_roster_match_ids);
  const matches = (snapshot.matches || [])
    .filter((match) => Number.isSafeInteger(match?.match_id) && match.match_id > 0 &&
      !excluded.has(match.match_id) && Number.isFinite(match.start_time) &&
      typeof match.radiant_win === "boolean" && hasFullSlots(match.players))
    .sort((left, right) => left.start_time - right.start_time || left.match_id - right.match_id);
  const seenMatches = new Set();
  const league = new Map();

  for (const match of matches) {
    if (seenMatches.has(match.match_id)) continue;
    seenMatches.add(match.match_id);
    const participants = new Map();
    for (const player of match.players) {
      const accountId = player.account_id;
      if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
      if (!league.has(accountId)) {
        league.set(accountId, { accountId, name: "", games: 0, inhouseRating: STARTING_RATING });
      }
      const entry = league.get(accountId);
      const name = nonemptyName(player.personaname);
      if (name) entry.name = name;
      participants.set(accountId, { entry, radiant: player.player_slot < 128 });
    }

    if (participants.size !== MATCH_SLOTS.length) continue;
    const radiantRatings = [];
    const direRatings = [];
    for (const { entry, radiant } of participants.values()) {
      (radiant ? radiantRatings : direRatings).push(entry.inhouseRating);
    }
    const expectedRadiant = expectedWinChance(average(radiantRatings) - average(direRatings));
    const radiantDelta = ELO_K * (Number(match.radiant_win) - expectedRadiant);
    for (const { entry, radiant } of participants.values()) {
      entry.inhouseRating += radiant ? radiantDelta : -radiantDelta;
      entry.games += 1;
    }
  }

  const external = snapshot.opendota_ratings;
  const observed = [...league.keys()]
    .map((accountId) => external?.[accountId])
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const median = observed.length
    ? average([observed[Math.floor((observed.length - 1) / 2)], observed[Math.floor(observed.length / 2)]])
    : null;

  return [...league.values()].map(({ accountId, name, games, inhouseRating }) => {
    const observedRating = external?.[accountId];
    const hasObservedRating = Number.isFinite(observedRating);
    const openDotaRating = hasObservedRating ? observedRating : median;
    return {
      accountId,
      name: nonemptyName(snapshot.player_names?.[accountId]) || name || `Account ${accountId}`,
      games,
      inhouseRating,
      openDotaRating,
      usedOpenDotaMedian: !hasObservedRating && median !== null,
      rating: openDotaRating === null ? null : average([inhouseRating, openDotaRating]),
    };
  });
}

function countBits(mask) {
  let count = 0;
  while (mask) {
    mask &= mask - 1;
    count += 1;
  }
  return count;
}

function compareBalance(left, right) {
  // Rating gap is strictly increasing with the distance from 50%.
  return left.ratingGap - right.ratingGap || left.mask - right.mask;
}

function pickDiversePlans(candidates) {
  const selected = [candidates.shift()];
  while (selected.length < PLAN_LIMIT) {
    let bestIndex = 0;
    let bestMinimum = -1;
    let bestTotal = -1;
    for (const [index, candidate] of candidates.entries()) {
      // Each set bit is one noncaptain assigned to team A.
      const distances = selected.map((plan) => countBits(plan.mask ^ candidate.mask));
      const minimum = Math.min(...distances);
      const total = distances.reduce((sum, distance) => sum + distance, 0);
      if (minimum > bestMinimum || (minimum === bestMinimum && total > bestTotal)) {
        bestIndex = index;
        bestMinimum = minimum;
        bestTotal = total;
      }
    }
    // Candidates already follow balance order, which breaks remaining ties.
    selected.push(candidates.splice(bestIndex, 1)[0]);
  }
  return selected.sort(compareBalance);
}

function validPlayer(player) {
  const accountId = player?.accountId;
  return Number.isSafeInteger(accountId) && accountId > 0 && Number.isFinite(player.rating);
}

export function findBalancedTeams(captainA, captainB, others) {
  if (!Array.isArray(others) || others.length !== 8) {
    throw new TypeError("Select exactly eight players in addition to the two captains.");
  }
  const players = [captainA, captainB, ...others];
  if (!players.every(validPlayer) || new Set(players.map((player) => player.accountId)).size !== 10) {
    throw new TypeError("Select ten distinct players with finite ratings.");
  }

  const ordered = [...others].sort((left, right) => left.accountId - right.accountId);
  const plans = [];
  for (let mask = 0; mask < (1 << ordered.length); mask += 1) {
    if (countBits(mask) !== 4) continue;
    const teamA = [captainA];
    const teamB = [captainB];
    ordered.forEach((player, index) => ((mask & (1 << index)) ? teamA : teamB).push(player));
    const averageA = average(teamA.map((player) => player.rating));
    const averageB = average(teamB.map((player) => player.rating));
    const difference = averageA - averageB;
    const ratingGap = Math.abs(difference);
    const winChanceA = expectedWinChance(difference);
    plans.push({ mask, teamA, teamB, averageA, averageB, ratingGap, winChanceA });
  }

  plans.sort(compareBalance);
  const qualifying = plans.filter(({ winChanceA }) =>
    winChanceA >= MIN_WIN_CHANCE && winChanceA <= MAX_WIN_CHANCE);
  let shown = qualifying.length ? qualifying : plans.slice(0, 1);
  if (qualifying.length > PLAN_LIMIT) {
    const fifthBest = qualifying[PLAN_LIMIT - 1];
    const limit = expectedWinChance(fifthBest.ratingGap) + DIVERSITY_SLACK;
    shown = pickDiversePlans(qualifying.filter((plan) => expectedWinChance(plan.ratingGap) <= limit));
  }
  return {
    examined: plans.length,
    withinRange: qualifying.length,
    plans: shown.map(({ mask, ...plan }) => plan),
  };
}
