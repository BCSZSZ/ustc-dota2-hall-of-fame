const MATCH_SLOTS = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
const ELO_K = 50;
const MIN_WIN_CHANCE = 0.45;
const MAX_WIN_CHANCE = 0.55;
const PLAN_LIMIT = 5;
// Shown when no split reaches the 45%-55% range.
const FALLBACK_LIMIT = 3;
const DIVERSITY_SLACK = 0.01;

// The configured medal bands span 770 points from Herald through Ancient and
// 1000 points for Divine (4620–5620). Divide each into five equal star bands.
// Coarse estimates use band midpoints. Tier codes without stars use the medal midpoint.
// Immortal uses a chosen 6000 proxy. Valve documented 5620 as the old Immortal
// Draft threshold and has since adjusted Immortal ratings.
// https://store.steampowered.com/news/posts/?appids=570&enddate=1685665325
// https://www.dota2.com/summerscrub2026
const MEDALS = [
  { name: "先锋", estimate: 385 },
  { name: "卫士", estimate: 1155 },
  { name: "中军", estimate: 1925 },
  { name: "统帅", estimate: 2695 },
  { name: "传奇", estimate: 3465 },
  { name: "万古流芳", estimate: 4235 },
  { name: "超凡入圣", estimate: 5120, starWidth: 200 },
  { name: "冠绝一世", estimate: 6000 },
];

function getMedal(rankTier) {
  if (!Number.isInteger(rankTier)) return null;
  if (rankTier === 80 || (rankTier >= 10 && rankTier <= 75 && rankTier % 10 <= 5)) {
    return MEDALS[Math.floor(rankTier / 10) - 1];
  }
  return null;
}

export function describeRankTier(rankTier) {
  const medal = getMedal(rankTier);
  if (!medal) return "";
  const stars = rankTier % 10;
  return stars ? `${medal.name} ${stars} 星` : medal.name;
}

export function estimateRankMmr(rankTier) {
  const medal = getMedal(rankTier);
  if (!medal) return null;
  const stars = rankTier % 10;
  return medal.estimate + ((stars || 3) - 3) * (medal.starWidth ?? 154);
}

function average(ratings) {
  const total = ratings.reduce((sum, rating) => sum + rating, 0);
  if (Number.isFinite(total)) return total / ratings.length;
  return ratings.reduce((sum, rating) => sum + rating / ratings.length, 0);
}

function medianRating(ratings) {
  if (!ratings.length) return null;
  ratings.sort((left, right) => left - right);
  const middle = Math.floor(ratings.length / 2);
  return ratings.length % 2 ? ratings[middle] : average(ratings.slice(middle - 1, middle + 1));
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

export function buildLeagueRoster(snapshot, manualMmr = {}) {
  const excluded = new Set(snapshot.metadata?.incomplete_roster_match_ids);
  const matches = (snapshot.matches || [])
    .filter((match) => Number.isSafeInteger(match?.match_id) && match.match_id > 0 &&
      !excluded.has(match.match_id) && Number.isFinite(match.start_time) &&
      typeof match.radiant_win === "boolean" && hasFullSlots(match.players))
    .sort((left, right) => left.start_time - right.start_time || left.match_id - right.match_id);
  const seenMatches = new Set();
  const league = new Map();
  const scoredMatches = [];

  for (const match of matches) {
    if (seenMatches.has(match.match_id)) continue;
    seenMatches.add(match.match_id);
    const participants = new Map();
    for (const player of match.players) {
      const accountId = player.account_id;
      if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
      if (!league.has(accountId)) {
        league.set(accountId, { accountId, name: "", games: 0 });
      }
      const entry = league.get(accountId);
      const name = nonemptyName(player.personaname);
      if (name) entry.name = name;
      participants.set(accountId, { entry, radiant: player.player_slot < 128 });
    }

    if (participants.size !== MATCH_SLOTS.length) continue;
    scoredMatches.push({ participants, radiantWin: match.radiant_win });
    for (const { entry } of participants.values()) entry.games += 1;
  }

  const medalRatings = [];
  const manualRatings = [];
  for (const entry of league.values()) {
    const rankTier = snapshot.opendota_rank_tiers?.[entry.accountId];
    const medalRating = estimateRankMmr(rankTier);
    const manualRating = manualMmr?.[entry.accountId];
    const hasManual = Number.isSafeInteger(manualRating) && manualRating >= 0 && manualRating <= 99999;
    if (medalRating !== null) medalRatings.push(medalRating);
    if (hasManual) manualRatings.push(manualRating);

    entry.rankTier = medalRating === null ? null : rankTier;
    entry.baseRating = hasManual ? manualRating : medalRating;
    entry.ratingSource = hasManual ? "manual" : medalRating === null ? "unavailable" : "medal";
  }

  const median = medianRating(medalRatings) ?? medianRating(manualRatings);
  for (const entry of league.values()) {
    if (entry.baseRating === null && median !== null) {
      entry.baseRating = median;
      entry.ratingSource = "median";
    }
    entry.inhouseRating = entry.baseRating;
  }

  if (median !== null) {
    for (const { participants, radiantWin } of scoredMatches) {
      const radiantRatings = [];
      const direRatings = [];
      for (const { entry, radiant } of participants.values()) {
        (radiant ? radiantRatings : direRatings).push(entry.inhouseRating);
      }
      const expectedRadiant = expectedWinChance(average(radiantRatings) - average(direRatings));
      const radiantDelta = ELO_K * (Number(radiantWin) - expectedRadiant);
      for (const { entry, radiant } of participants.values()) {
        entry.inhouseRating += radiant ? radiantDelta : -radiantDelta;
      }
    }
  }

  return [...league.values()].map(({ accountId, name, games, inhouseRating, baseRating, rankTier, ratingSource }) => {
    const inhouseWeight = baseRating === null ? 0 : Math.min(0.5, games / (games + 36));
    return {
      accountId,
      name: nonemptyName(snapshot.player_names?.[accountId]) || name || `Account ${accountId}`,
      games,
      baseRating,
      inhouseRating,
      inhouseWeight,
      rankTier,
      ratingSource,
      rating: baseRating === null ? null : baseRating + inhouseWeight * (inhouseRating - baseRating),
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
  let shown = qualifying.length ? qualifying : plans.slice(0, FALLBACK_LIMIT);
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
