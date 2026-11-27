import assert from "node:assert/strict";
import test from "node:test";
import { bestMetaEdge, heroPool, LIST_SIZE, metaEdge, MIN_SCORE, overallEdge, suggestBp } from "../site/bp-model.js";

// Position 1 has 10 000 picks (5 000 matches); hero 1 wins 60% of 1 000, hero 2 is rarely picked.
const meta = {
  positions: {
    1: { 1: [1000, 600], 2: [50, 40], 3: [8950, 4475] },
    2: { 4: [5000, 2900], 5: [5000, 2100] },
  },
};

function record(pool, games = 200, wins = 100) {
  return { pool_games: [games, wins], pool };
}

test("measures a hero's patch edge at a position and skips rarely picked ones", () => {
  assert.ok(Math.abs(metaEdge(meta, 1, "1") - 100 * ((600 + 200) / 1400 - 0.5)) < 1e-9);
  assert.equal(metaEdge(meta, 2, "1"), null);
  assert.equal(metaEdge(meta, 1, "3"), null);
  assert.deepEqual(bestMetaEdge(meta, 4).position, "2");
  assert.equal(bestMetaEdge(meta, 99), null);
});

test("values a player's heroes by familiarity, results and the patch", () => {
  const pool = heroPool(record({ 1: [[3, 30, 20], [1, 4, 2]], 2: [[3, 10, 5]], 3: [[7, 1, 1]] }), "1", meta);
  const [first, second] = pool;
  assert.equal(first.hero, 3);
  assert.equal(first.games, 35);
  assert.equal(first.here, 30);
  assert.ok(first.skill > 0 && first.comfort > 0.8);
  assert.equal(second.hero, 1);
  assert.ok(second.meta > 0);
  assert.ok(!pool.some((entry) => entry.hero === 7), "half a game elsewhere is below the minimum");
  assert.deepEqual(heroPool(null, "1", meta), []);
});

test("bans the other side's signature heroes and patch-strong ones, and picks our own", () => {
  const member = (accountId, position, pool) => ({ player: { accountId, name: `P${accountId}` }, position, record: record(pool) });
  const own = [member(1, "1", { 1: [[10, 40, 26]] }), member(2, "2", { 2: [[11, 30, 18], [12, 20, 12]] })];
  const enemy = [member(3, "1", { 1: [[20, 50, 33], [21, 40, 26], [22, 30, 19], [23, 25, 15]] }), member(4, "2", { 2: [[11, 10, 6]] })];
  const { bans, picks } = suggestBp(own, enemy, meta);
  const banned = bans.map((ban) => ban.hero);
  const picked = picks.map((pick) => pick.hero);
  assert.ok(banned.includes(20) && banned.includes(21));
  assert.equal(bans.filter((ban) => ban.target?.player.accountId === 3).length, 2, "at most two bans aimed at one opponent");
  assert.ok(banned.includes(4), "the patch-strong mid hero is banned though nobody plays it");
  assert.ok(picked.includes(10) && picked.includes(11));
  const contested = picks.find((pick) => pick.hero === 11);
  assert.equal(contested.denies.player.accountId, 4);
  assert.equal(contested.contested, banned.includes(11), "a hero in both lists is marked contested");
  for (const list of [bans, picks]) {
    assert.ok(list.length <= LIST_SIZE);
    assert.ok(list.every((entry) => entry.score >= MIN_SCORE));
  }
  assert.ok(!picked.includes(5) && !banned.includes(5), "a weak patch hero nobody plays is left out");
});

test("falls back to OpenDota's bracket win rates when STRATZ has no positions", () => {
  const opendota = { positions: {}, overall: { 1: [3000, 1800], 2: [10, 9], 3: [7000, 3500] } };
  const edge = 100 * ((1800 + 200) / 3400 - 0.5);
  assert.ok(Math.abs(overallEdge(opendota, 1) - edge) < 1e-9);
  assert.equal(overallEdge(opendota, 2), null);
  assert.ok(Math.abs(metaEdge(opendota, 1, "4") - edge) < 1e-9);
  assert.deepEqual(bestMetaEdge(opendota, 1), { edge: overallEdge(opendota, 1), position: null });
  const both = { ...meta, overall: { 1: [3000, 1800], 3: [27000, 13500] } };
  const stratzOverall = 100 * ((600 + 200) / 1400 - 0.5);
  assert.ok(Math.abs(metaEdge(both, 1, "1") - (metaEdge(meta, 1, "1") + (overallEdge(both, 1) - stratzOverall) / 2)) < 1e-9,
    "STRATZ's positional edge moves halfway to OpenDota's level");
});

test("lets a hero both sides want be in both the ban and the pick list", () => {
  const member = (accountId, position, pool) => ({ player: { accountId, name: `P${accountId}` }, position, record: record(pool) });
  const own = [member(1, "1", { 1: [[30, 60, 40]] })];
  const enemy = [member(2, "1", { 1: [[30, 60, 40]] })];
  const { bans, picks } = suggestBp(own, enemy, { positions: {} });
  assert.equal(bans[0].hero, 30);
  assert.equal(picks[0].hero, 30);
  assert.ok(bans[0].contested && picks[0].contested);
});
