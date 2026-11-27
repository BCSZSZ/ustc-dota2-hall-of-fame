const MATCH_SLOTS = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
const ELO_K = 50;
const MIN_WIN_CHANCE = 0.4;
const MAX_WIN_CHANCE = 0.6;
const PLAN_LIMIT = 5;
// Shown when no split reaches the 40%-60% range.
const FALLBACK_LIMIT = 3;
const DIVERSITY_SLACK = 0.01;

// Win chance = logistic(team average gap / scale); in-house Elo is blended in with
// weight min(50%, games / (games + halfWeightGames)).
export const DEFAULT_MODEL = Object.freeze({ scale: 400, halfWeightGames: 36 });
// Calibration refits both on the league's own history (each match predicted only
// from earlier matches) and adopts them once there is enough evidence.
const SCALE_GRID = Array.from({ length: 41 }, (_, index) => 200 + index * 25);
const HALF_WEIGHT_GRID = [6, 12, 24, 36, 72, 144, Infinity];
const MIN_SCALE_MATCHES = 50;
const MIN_ELO_MATCHES = 100;
// The adopted scale moves from the default toward the fit as n / (n + SCALE_SHRINK).
const SCALE_SHRINK = 50;
// Likelihood-ratio thresholds: 1.92 gives a 95% profile interval; 3.84 is a 5% test.
const INTERVAL_DROP = 1.92;
const SIGNIFICANT_GAIN = 3.84;

// The configured medal bands span 770 points from Herald through Ancient and
// 1000 points for Divine (4620–5620). Divide each into five equal star bands.
// Coarse estimates use band midpoints. Tier codes without stars use the medal midpoint.
// Immortal uses a chosen 6000 proxy. Valve documented 5620 as the old Immortal
// Draft threshold and has since adjusted Immortal ratings.
// An Immortal with a regional leaderboard place (top 5000) gets a rough log-linear estimate between
// 9500 for first place (the top of the 2026-07 rescale, which kept leaderboard order) and 6200 for
// place 5000. Valve publishes no place-to-rating table; regions differ, so this is only an ordering.
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

const LEADERBOARD_TOP = { place: 1, rating: 9500 };
const LEADERBOARD_LAST = { place: 5000, rating: 6200 };

function getMedal(rankTier) {
  if (!Number.isInteger(rankTier)) return null;
  if (rankTier === 80 || (rankTier >= 10 && rankTier <= 75 && rankTier % 10 <= 5)) {
    return MEDALS[Math.floor(rankTier / 10) - 1];
  }
  return null;
}

const leaderboardPlace = (rankTier, place) =>
  rankTier === 80 && Number.isSafeInteger(place) && place > 0 ? Math.min(place, LEADERBOARD_LAST.place) : null;

export function describeRankTier(rankTier, place) {
  const medal = getMedal(rankTier);
  if (!medal) return "";
  const stars = rankTier % 10;
  if (leaderboardPlace(rankTier, place)) return `${medal.name} 第 ${place} 名`;
  return stars ? `${medal.name} ${stars} 星` : medal.name;
}

export function estimateRankMmr(rankTier, place) {
  const medal = getMedal(rankTier);
  if (!medal) return null;
  const onBoard = leaderboardPlace(rankTier, place);
  if (onBoard) {
    const span = Math.log(LEADERBOARD_LAST.place / LEADERBOARD_TOP.place);
    return Math.round(LEADERBOARD_TOP.rating - (LEADERBOARD_TOP.rating - LEADERBOARD_LAST.rating) * Math.log(onBoard) / span);
  }
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

function expectedWinChance(ratingDifference, scale = DEFAULT_MODEL.scale) {
  // Centered form of the Elo logistic curve, 1 / (1 + 10^(-difference / scale)).
  return 0.5 + 0.5 * Math.tanh(ratingDifference * Math.LN10 / (2 * scale));
}

function nonemptyName(name) {
  return typeof name === "string" ? name.trim() : "";
}

function hasFullSlots(players) {
  if (!Array.isArray(players) || players.length !== MATCH_SLOTS.length) return false;
  const slots = new Set(players.map((player) => player?.player_slot));
  return MATCH_SLOTS.every((slot) => slots.has(slot));
}

function prepareLeague(snapshot, manualMmr) {
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
    const place = snapshot.opendota_leaderboard_ranks?.[entry.accountId];
    const medalRating = estimateRankMmr(rankTier, place);
    const manualRating = manualMmr?.[entry.accountId];
    const hasManual = Number.isSafeInteger(manualRating) && manualRating >= 0 && manualRating <= 99999;
    if (medalRating !== null) medalRatings.push(medalRating);
    if (hasManual) manualRatings.push(manualRating);

    entry.rankTier = medalRating === null ? null : rankTier;
    entry.leaderboardRank = leaderboardPlace(entry.rankTier, place);
    entry.baseRating = hasManual ? manualRating : medalRating;
    entry.ratingSource = hasManual ? "manual" : medalRating === null ? "unavailable" : "medal";
  }

  const median = medianRating(medalRatings) ?? medianRating(manualRatings);
  for (const entry of league.values()) {
    if (entry.baseRating === null && median !== null) {
      entry.baseRating = median;
      entry.ratingSource = "median";
    }
  }
  return { league, scoredMatches, median };
}

const inhouseWeight = (games, model) => Math.min(0.5, games / (games + model.halfWeightGames));

// Replays scored matches in time order. onMatch receives the pre-match gap between
// the teams' blended ratings, so every prediction only uses earlier matches.
function replayInhouse({ league, scoredMatches, median }, model, onMatch) {
  const inhouse = new Map([...league.values()].map((entry) => [entry, entry.baseRating]));
  const played = new Map();
  if (median === null) return inhouse;
  for (const { participants, radiantWin } of scoredMatches) {
    const sides = { radiant: [], dire: [] };
    for (const { entry, radiant } of participants.values()) (radiant ? sides.radiant : sides.dire).push(entry);
    if (onMatch) {
      const blended = (entry) => entry.baseRating +
        inhouseWeight(played.get(entry) || 0, model) * (inhouse.get(entry) - entry.baseRating);
      onMatch(average(sides.radiant.map(blended)) - average(sides.dire.map(blended)), radiantWin);
    }
    const expectedRadiant = expectedWinChance(
      average(sides.radiant.map((entry) => inhouse.get(entry))) - average(sides.dire.map((entry) => inhouse.get(entry))),
      model.scale,
    );
    const radiantDelta = ELO_K * (Number(radiantWin) - expectedRadiant);
    for (const entry of sides.radiant) inhouse.set(entry, inhouse.get(entry) + radiantDelta);
    for (const entry of sides.dire) inhouse.set(entry, inhouse.get(entry) - radiantDelta);
    for (const entry of [...sides.radiant, ...sides.dire]) played.set(entry, (played.get(entry) || 0) + 1);
  }
  return inhouse;
}

export function buildLeagueRoster(snapshot, manualMmr = {}, model = DEFAULT_MODEL) {
  const prepared = prepareLeague(snapshot, manualMmr);
  const inhouse = replayInhouse(prepared, model);
  return [...prepared.league.values()].map((entry) => {
    const { accountId, name, games, baseRating, rankTier, leaderboardRank, ratingSource } = entry;
    const inhouseRating = inhouse.get(entry);
    const weight = baseRating === null ? 0 : inhouseWeight(games, model);
    return {
      accountId,
      name: nonemptyName(snapshot.player_names?.[accountId]) || name || `Account ${accountId}`,
      games,
      baseRating,
      inhouseRating,
      inhouseWeight: weight,
      rankTier,
      leaderboardRank,
      ratingSource,
      rating: baseRating === null ? null : baseRating + weight * (inhouseRating - baseRating),
    };
  });
}

export function calibrateModel(snapshot, manualMmr = {}) {
  const prepared = prepareLeague(snapshot, manualMmr);
  const matches = prepared.median === null ? 0 : prepared.scoredMatches.length;
  const result = { matches, fitted: null, scaleInterval: null, status: "collecting", applied: { ...DEFAULT_MODEL } };
  if (matches < 2) return result;

  const logLikelihood = (model) => {
    let total = 0;
    replayInhouse(prepared, model, (difference, radiantWin) => {
      const chance = Math.min(1 - 1e-9, Math.max(1e-9, expectedWinChance(difference, model.scale)));
      total += Math.log(radiantWin ? chance : 1 - chance);
    });
    return total;
  };
  const table = HALF_WEIGHT_GRID.flatMap((halfWeightGames) =>
    SCALE_GRID.map((scale) => ({ scale, halfWeightGames, fit: logLikelihood({ scale, halfWeightGames }) })));
  const best = table.reduce((left, right) => (right.fit > left.fit ? right : left));
  const profile = table.filter((row) => row.halfWeightGames === best.halfWeightGames && row.fit >= best.fit - INTERVAL_DROP)
    .map((row) => row.scale);
  result.fitted = { scale: best.scale, halfWeightGames: best.halfWeightGames };
  result.scaleInterval = [Math.min(...profile), Math.max(...profile)];

  const closed = result.scaleInterval[0] > SCALE_GRID[0] && result.scaleInterval[1] < SCALE_GRID.at(-1);
  if (matches >= MIN_SCALE_MATCHES) {
    result.status = closed ? "applied" : "uncertain";
    if (closed) {
      result.applied.scale = Math.round(DEFAULT_MODEL.scale +
        (matches / (matches + SCALE_SHRINK)) * (best.scale - DEFAULT_MODEL.scale));
    }
  }
  if (matches >= MIN_ELO_MATCHES) {
    const scale = result.applied.scale;
    const current = logLikelihood({ scale, halfWeightGames: DEFAULT_MODEL.halfWeightGames });
    const candidate = HALF_WEIGHT_GRID.map((halfWeightGames) => ({ halfWeightGames, fit: logLikelihood({ scale, halfWeightGames }) }))
      .reduce((left, right) => (right.fit > left.fit ? right : left));
    if (2 * (candidate.fit - current) >= SIGNIFICANT_GAIN) result.applied.halfWeightGames = candidate.halfWeightGames;
  }
  return result;
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

function checkSelection(captainA, captainB, others) {
  if (!Array.isArray(others) || others.length !== 8) {
    throw new TypeError("Select exactly eight players in addition to the two captains.");
  }
  const players = [captainA, captainB, ...others];
  if (!players.every(validPlayer) || new Set(players.map((player) => player.accountId)).size !== 10) {
    throw new TypeError("Select ten distinct players with finite ratings.");
  }
}

// Position strength: each position's public win rate, shrunk toward the player's overall rate, as an Elo
// offset from the player's rating. Positions with too few recent games count as rarely played.
export const POSITIONS = Object.freeze(["1", "2", "3", "4", "5"]);
export const POSITION_PRIORITY = Object.freeze(["2", "1", "3", "5", "4"]);
// A lineup's score is the weighted mean of its position ratings; higher priority weighs more.
export const POSITION_WEIGHTS = Object.freeze({ 2: 1.3, 1: 1.2, 3: 1, 5: 0.85, 4: 0.75 });
export const POSITION_MIN_GAMES = 10;
// With fewer recent games in all, a player has no position data and rates the same everywhere.
const POSITION_MIN_HISTORY = 30;
// Pseudo-games at the player's overall win rate. In 2026-11 the league players' position win rates varied
// by about 0.06 beyond binomial noise (≈ 40-50 rating points), so about 50 games of noise equal that signal.
const POSITION_SHRINK = 50;
const POSITION_ELO_SCALE = 400;
export const RARE_POSITION_PENALTY = 500;
const WEIGHT_TOTAL = POSITIONS.reduce((sum, position) => sum + POSITION_WEIGHTS[position], 0);

const eloOffset = (chance) => POSITION_ELO_SCALE * Math.log10(chance / (1 - chance));

export function attachPositionRatings(players, stats) {
  return players.map((player) => {
    const record = stats?.[player.accountId];
    if (!Number.isFinite(player.rating) || !record || !(record.games >= POSITION_MIN_HISTORY)) return { ...player, positions: null };
    const wins = POSITIONS.reduce((sum, position) => sum + (record.positions?.[position]?.[1] ?? 0), 0);
    const overall = (wins + POSITION_SHRINK / 2) / (record.games + POSITION_SHRINK);
    const positions = Object.fromEntries(POSITIONS.map((position) => {
      const [games = 0, won = 0] = record.positions?.[position] ?? [];
      if (games < POSITION_MIN_GAMES) {
        return [position, { games, wins: won, rare: true, delta: null, rating: player.rating - RARE_POSITION_PENALTY }];
      }
      const delta = eloOffset((won + overall * POSITION_SHRINK) / (games + POSITION_SHRINK)) - eloOffset(overall);
      return [position, { games, wins: won, rare: false, delta, rating: player.rating + delta }];
    }));
    return { ...player, positions, positionGames: record.games, positionSince: record.since ?? null };
  });
}

export const POSITION_NAMES = Object.freeze({ 1: "核心", 2: "中单", 3: "劣势路", 4: "辅助", 5: "硬辅助" });

// Each position's rating and how often the player plays it: "main" for the most played, "rare" below
// POSITION_MIN_GAMES, otherwise "regular". Null without position data.
export function positionProfile(player) {
  if (!player?.positions) return null;
  const most = Math.max(...POSITIONS.map((position) => player.positions[position].games));
  return POSITIONS.map((position) => {
    const slot = player.positions[position];
    return { position, name: POSITION_NAMES[position], ...slot, tag: slot.rare ? "rare" : slot.games === most ? "main" : "regular" };
  });
}

// The whole league roster with blended ratings and position ratings, for pages that only display them.
export function rateLeague(snapshot, manualMmr = {}, positionStats = null) {
  const model = calibrateModel(snapshot, manualMmr).applied;
  const roster = buildLeagueRoster(snapshot, manualMmr, model).filter((player) => Number.isFinite(player.rating));
  return attachPositionRatings(roster, positionStats?.players);
}

const positionRating = (player, position) => player.positions?.[position]?.rating ?? player.rating;

const PERMUTATIONS = (function permute(rest) {
  if (rest.length <= 1) return [rest];
  return rest.flatMap((item, index) => permute([...rest.slice(0, index), ...rest.slice(index + 1)]).map((tail) => [item, ...tail]));
})(POSITIONS);

// The position assignment with the highest weighted rating; ties keep the first permutation.
function bestLineup(team) {
  let best = null;
  for (const order of PERMUTATIONS) {
    const score = order.reduce((sum, position, index) => sum + POSITION_WEIGHTS[position] * positionRating(team[index], position), 0);
    if (!best || score > best.score + 1e-9) best = { score, order };
  }
  const lineup = best.order.map((position, index) => ({ position, player: team[index], ...team[index].positions?.[position] }))
    .map((slot) => ({ ...slot, rating: positionRating(slot.player, slot.position) }))
    .sort((left, right) => Number(left.position) - Number(right.position));
  return { score: best.score / WEIGHT_TOTAL, lineup };
}

function describeTeams(teamA, teamB, scale, positions) {
  const lineupA = positions ? bestLineup(teamA) : null;
  const lineupB = positions ? bestLineup(teamB) : null;
  const averageA = lineupA ? lineupA.score : average(teamA.map((player) => player.rating));
  const averageB = lineupB ? lineupB.score : average(teamB.map((player) => player.rating));
  const difference = averageA - averageB;
  return {
    teamA, teamB, averageA, averageB, lineupA: lineupA?.lineup ?? null, lineupB: lineupB?.lineup ?? null,
    ratingGap: Math.abs(difference), winChanceA: expectedWinChance(difference, scale),
  };
}

// Captains pick the eight others in 1-2-2-2-1 turns, starting with the first picker.
export const PICK_TURNS = Object.freeze([1, 2, 2, 2, 1]);

const byRating = (left, right) => right.rating - left.rating || left.accountId - right.accountId;

// Both captains know how the other drafts: by default each searches every remaining pick and takes the
// best final win chance for its side, so the suggestion is optimal play by both. A custom strategy
// ({ choose({ side, own, opponent, available, turn }) }) can stand in for one side.
export const OPTIMAL_STRATEGY = Object.freeze({ lookahead: true });

export function suggestPickOrder(captainA, captainB, others, {
  firstPick = "A", strategyA = OPTIMAL_STRATEGY, strategyB = OPTIMAL_STRATEGY,
  scale = DEFAULT_MODEL.scale, positions = false,
} = {}) {
  checkSelection(captainA, captainB, others);
  if (firstPick !== "A" && firstPick !== "B") throw new TypeError("firstPick must be A or B.");
  const pool = [...others].sort(byRating);
  const strategies = { A: strategyA, B: strategyB };
  const order = PICK_TURNS.flatMap((count, turn) =>
    Array.from({ length: count }, () => ({ turn, side: (turn % 2 === 0) === (firstPick === "A") ? "A" : "B" })));
  const members = (mask) => pool.filter((_, index) => mask & (1 << index));
  const teams = (masks) => ({ A: [captainA, ...members(masks.A)], B: [captainB, ...members(masks.B)] });

  const memo = new Map();
  // The next pick's index into pool under each side's strategy, and the resulting final win chance for A.
  function play(masks) {
    const key = masks.A * 256 + masks.B;
    if (memo.has(key)) return memo.get(key);
    const step = countBits(masks.A | masks.B);
    let result;
    if (step === order.length) {
      const { A, B } = teams(masks);
      result = { pick: -1, value: describeTeams(A, B, scale, positions).winChanceA };
    } else {
      const { side } = order[step];
      const taken = masks.A | masks.B;
      const options = pool.map((_, index) => index).filter((index) => !(taken & (1 << index)));
      const after = (index) => play({ ...masks, [side]: masks[side] | (1 << index) }).value;
      if (strategies[side].lookahead) {
        result = null;
        for (const index of options) {
          const value = after(index);
          const better = side === "A" ? value > (result?.value ?? -1) + 1e-12 : value < (result?.value ?? 2) - 1e-12;
          if (better) result = { pick: index, value };
        }
      } else {
        const current = teams(masks);
        const player = strategies[side].choose({
          side, own: current[side], opponent: current[side === "A" ? "B" : "A"],
          available: options.map((index) => pool[index]), turn: order[step].turn,
        });
        const index = pool.indexOf(player);
        if (!options.includes(index)) throw new Error("Pick strategy chose a player who is not available.");
        result = { pick: index, value: after(index) };
      }
    }
    memo.set(key, result);
    return result;
  }

  const masks = { A: 0, B: 0 };
  const picks = order.map(({ turn, side }) => {
    const { pick } = play(masks);
    masks[side] |= 1 << pick;
    return { turn, side, player: pool[pick] };
  });
  const sides = { A: [captainA], B: [captainB] };
  for (const { side, player } of picks) sides[side].push(player);
  return { picks, ...describeTeams(sides.A, sides.B, scale, positions) };
}

export function findBalancedTeams(captainA, captainB, others, { scale = DEFAULT_MODEL.scale, positions = false } = {}) {
  checkSelection(captainA, captainB, others);

  const ordered = [...others].sort((left, right) => left.accountId - right.accountId);
  const plans = [];
  for (let mask = 0; mask < (1 << ordered.length); mask += 1) {
    if (countBits(mask) !== 4) continue;
    const teamA = [captainA];
    const teamB = [captainB];
    ordered.forEach((player, index) => ((mask & (1 << index)) ? teamA : teamB).push(player));
    plans.push({ mask, ...describeTeams(teamA, teamB, scale, positions) });
  }

  plans.sort(compareBalance);
  // The bounds are inclusive; the tolerance absorbs floating-point error at exactly 40% or 60%.
  const qualifying = plans.filter(({ winChanceA }) =>
    winChanceA >= MIN_WIN_CHANCE - 1e-12 && winChanceA <= MAX_WIN_CHANCE + 1e-12);
  let shown = qualifying.length ? qualifying : plans.slice(0, FALLBACK_LIMIT);
  if (qualifying.length > PLAN_LIMIT) {
    const fifthBest = qualifying[PLAN_LIMIT - 1];
    const limit = expectedWinChance(fifthBest.ratingGap, scale) + DIVERSITY_SLACK;
    shown = pickDiversePlans(qualifying.filter((plan) => expectedWinChance(plan.ratingGap, scale) <= limit));
  }
  return {
    examined: plans.length,
    withinRange: qualifying.length,
    plans: shown.map(({ mask, ...plan }) => plan),
  };
}
