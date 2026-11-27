// Ban/pick suggestions from each player's hero pool by position (position-stats.json) and the patch's
// high-bracket hero win rates (hero-meta.json: STRATZ by position and OpenDota without positions, combined).
// Every score is in win-rate percentage points.

export const POSITIONS = Object.freeze(["1", "2", "3", "4", "5"]);
// A familiar hero is worth this much over a random one before the player's own results on it.
const COMFORT_POINTS = 4;
// Games on a hero at which familiarity reaches half its full weight.
const COMFORT_HALF_GAMES = 8;
// Pseudo-games at the player's overall win rate when judging their win rate on one hero.
const SKILL_SHRINK = 10;
// Games on the hero at another position count this much toward the assigned one.
const OTHER_POSITION_WEIGHT = 0.5;
const MIN_POOL_GAMES = 2;
// Pseudo-matches at 50% for the patch win rate of a hero at a position.
const META_SHRINK = 400;
// A hero below this pick rate at a position is not judged there.
const META_MIN_PICK_RATE = 0.02;
// A patch-strong hero nobody on the other side plays is still worth banning at this share of its edge.
const META_ONLY_WEIGHT = 0.7;
// A second opponent who also plays the hero adds this share of their value to the ban.
const SECOND_THREAT_WEIGHT = 0.25;
// Picking a hero the other side would play denies it; that adds this share of their value.
const DENY_WEIGHT = 0.5;
export const MIN_SCORE = 3;
// Bans and picks are two separate lists of the highest-priority heroes; a hero may be in both (ban it or take it
// with the first pick), since Captains Mode alternates them and the order is the captains' call.
export const LIST_SIZE = 5;
// At most this many bans aimed at one opponent, or picks for one player.
const PER_PLAYER = 2;

const shrink = (wins, games, prior, weight) => (wins + prior * weight) / (games + weight);

const hasPositions = (meta) => POSITIONS.some((position) => Object.keys(meta?.positions?.[position] ?? {}).length);

// OpenDota's Divine and Immortal edge for the hero at any position, or null when it is rarely picked.
export function overallEdge(meta, hero) {
  const record = meta?.overall?.[hero];
  if (!record) return null;
  const [picks, wins] = record;
  // Ten heroes are picked in every match.
  const matches = Object.values(meta.overall).reduce((sum, [count]) => sum + count, 0) / 10;
  if (!matches || picks / matches < META_MIN_PICK_RATE) return null;
  return 100 * (shrink(wins, picks, 0.5, META_SHRINK) - 0.5);
}

// STRATZ's edge for the hero over all positions.
function stratzOverallEdge(meta, hero) {
  let matches = 0;
  let wins = 0;
  for (const position of POSITIONS) {
    const [count = 0, won = 0] = meta.positions[position]?.[hero] ?? [];
    matches += count;
    wins += won;
  }
  return matches ? 100 * (shrink(wins, matches, 0.5, META_SHRINK) - 0.5) : null;
}

// The patch edge of a hero at a position (points above 50%), or null when it is rarely picked there. STRATZ
// gives the edge by position; its level moves halfway to OpenDota's overall edge for the hero, so both sources
// count. Without STRATZ's positions, OpenDota's edge stands for every position.
export function metaEdge(meta, hero, position) {
  const opendota = overallEdge(meta, hero);
  if (!hasPositions(meta)) return opendota;
  const table = meta.positions[position];
  const record = table?.[hero];
  if (!record) return null;
  const [matches, wins] = record;
  const picks = Object.values(table).reduce((sum, [count]) => sum + count, 0);
  // Each match has two players at every position.
  if (!picks || (2 * matches) / picks < META_MIN_PICK_RATE) return null;
  const edge = 100 * (shrink(wins, matches, 0.5, META_SHRINK) - 0.5);
  return opendota === null ? edge : edge + (opendota - stratzOverallEdge(meta, hero)) / 2;
}

// The hero's best patch edge over all positions it is picked at, with that position.
export function bestMetaEdge(meta, hero) {
  if (!hasPositions(meta)) {
    const edge = overallEdge(meta, hero);
    return edge === null ? null : { edge, position: null };
  }
  let best = null;
  for (const position of POSITIONS) {
    const edge = metaEdge(meta, hero, position);
    if (edge !== null && (!best || edge > best.edge)) best = { edge, position };
  }
  return best;
}

// The player's heroes for the given position: games there count fully, elsewhere at half weight.
export function heroPool(record, position, meta) {
  if (!record?.pool) return [];
  const [allGames = 0, allWins = 0] = record.pool_games ?? [];
  const overall = allGames ? shrink(allWins, allGames, 0.5, 20) : 0.5;
  const heroes = new Map();
  for (const pos of POSITIONS) {
    const weight = pos === position ? 1 : OTHER_POSITION_WEIGHT;
    for (const [hero, games, wins] of record.pool[pos] ?? []) {
      const entry = heroes.get(hero) ?? { hero, games: 0, wins: 0, here: 0, hereWins: 0 };
      entry.games += weight * games;
      entry.wins += weight * wins;
      if (pos === position) Object.assign(entry, { here: games, hereWins: wins });
      heroes.set(hero, entry);
    }
  }
  return [...heroes.values()].filter((entry) => entry.games >= MIN_POOL_GAMES).map((entry) => {
    const comfort = entry.games / (entry.games + COMFORT_HALF_GAMES);
    const skill = 100 * (shrink(entry.wins, entry.games, overall, SKILL_SHRINK) - overall);
    const mastery = comfort * (COMFORT_POINTS + skill);
    const edge = metaEdge(meta, entry.hero, position);
    return { ...entry, comfort, skill, mastery, meta: edge, value: mastery + (edge ?? 0) };
  }).sort((left, right) => right.value - left.value || right.games - left.games || left.hero - right.hero);
}

// Each side is a list of { player, position, record }, with record from position-stats.json.
function pools(side, meta) {
  return side.map((member) => ({ ...member, heroes: new Map(heroPool(member.record, member.position, meta).map((entry) => [entry.hero, entry])) }));
}

function takeTop(candidates, owner) {
  const list = [];
  const counts = new Map();
  for (const candidate of candidates) {
    if (list.length === LIST_SIZE) break;
    const key = owner(candidate);
    if (key !== null && (counts.get(key) ?? 0) >= PER_PLAYER) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    list.push(candidate);
  }
  return list;
}

// Suggestions from `own`'s side: heroes to ban from `enemy` and heroes for `own` to pick.
export function suggestBp(own, enemy, meta) {
  const ours = pools(own, meta);
  const theirs = pools(enemy, meta);
  const heroes = new Set([...ours, ...theirs].flatMap((member) => [...member.heroes.keys()]));
  for (const table of [...Object.values(meta?.positions ?? {}), meta?.overall ?? {}]) for (const hero of Object.keys(table)) heroes.add(Number(hero));

  const picks = [];
  const bans = [];
  for (const hero of heroes) {
    const threats = theirs.map((member) => ({ member, entry: member.heroes.get(hero) }))
      .filter(({ entry }) => entry && entry.value > 0).sort((left, right) => right.entry.value - left.entry.value);
    const threat = threats[0]?.entry.value ?? 0;
    const patch = bestMetaEdge(meta, hero);
    const metaOnly = META_ONLY_WEIGHT * Math.max(0, patch?.edge ?? 0);
    const banScore = Math.max(threat, metaOnly) + SECOND_THREAT_WEIGHT * (threats[1]?.entry.value ?? 0);

    const mine = ours.map((member) => ({ member, entry: member.heroes.get(hero) })).filter(({ entry }) => entry)
      .sort((left, right) => right.entry.value - left.entry.value)[0];
    const pickScore = mine ? mine.entry.value + DENY_WEIGHT * threat : -Infinity;

    if (mine && pickScore >= MIN_SCORE) {
      picks.push({ hero, score: pickScore, for: mine.member, entry: mine.entry, denies: threats[0]?.member ?? null, threatEntry: threats[0]?.entry ?? null });
    }
    if (banScore >= MIN_SCORE) {
      const target = threat >= metaOnly ? threats[0] : null;
      bans.push({ hero, score: banScore, target: target?.member ?? null, entry: target?.entry ?? null, also: threats[1]?.member ?? null, patch });
    }
  }
  const byScore = (left, right) => right.score - left.score || left.hero - right.hero;
  const top = {
    bans: takeTop(bans.sort(byScore), (ban) => ban.target?.player.accountId ?? null),
    picks: takeTop(picks.sort(byScore), (pick) => pick.for.player.accountId),
  };
  // A hero in both lists is contested: ban it, or take it with the first pick.
  const picked = new Set(top.picks.map((pick) => pick.hero));
  const banned = new Set(top.bans.map((ban) => ban.hero));
  for (const entry of [...top.bans, ...top.picks]) entry.contested = picked.has(entry.hero) && banned.has(entry.hero);
  return top;
}
