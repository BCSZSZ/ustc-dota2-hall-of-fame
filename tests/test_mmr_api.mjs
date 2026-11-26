import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../mmr-api/worker/index.js";

const url = "https://mmr.example/api/mmr";
const origin = "https://bcszsz.github.io";
const migrations = ["0000_shared_mmr", "0001_player_aliases"]
  .map((tag) => readFileSync(new URL(`../mmr-api/drizzle/${tag}.sql`, import.meta.url), "utf8"));
const empty = { revision: 0, ratings: {}, aliases: {}, updatedAt: null };

function match(matchId, firstAccountId) {
  return {
    match_id: matchId,
    start_time: 100,
    radiant_win: true,
    players: [0, 1, 2, 3, 4, 128, 129, 130, 131, 132].map((slot, index) => ({
      player_slot: slot,
      account_id: firstAccountId + index,
    })),
  };
}

function setup(t, beforeWrite) {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of migrations) sqlite.exec(migration);
  t.after(() => sqlite.close());
  const env = { DB: { prepare(sql) {
    const statement = sqlite.prepare(sql);
    const first = async (...params) => {
      if (sql.includes("UPDATE")) await beforeWrite?.();
      return statement.get(...params) ?? null;
    };
    return { first, bind: (...params) => ({ first: () => first(...params) }) };
  } } };

  const roster = t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(input, `${origin}/ustc-dota2-hall-of-fame/data/league.json`);
    return Response.json({
      league_id: 19224,
      player_names: { 1: "Named player", 11: "Player in an excluded match" },
      matches: [match(1, 1), match(2, 11)],
      metadata: { incomplete_roster_match_ids: [2] },
    });
  });
  const request = (options, endpoint = url) => worker.fetch(new Request(endpoint, options), env);
  const putRaw = (body, headers = {}) => request({
    method: "PUT",
    headers: { Origin: origin, "Content-Type": "application/json; charset=utf-8", ...headers },
    body,
  });
  const put = (revision, changes, aliases) => putRaw(JSON.stringify({ revision, changes, aliases }));
  return { env, request, put, putRaw, roster };
}

test("serves an uncached public state and allows CORS from GitHub Pages", async (t) => {
  const { request, putRaw, roster } = setup(t);
  const get = await request();
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("Cache-Control"), "no-store");
  assert.equal(get.headers.get("Vary"), "Origin");
  assert.deepEqual(await get.json(), empty);
  assert.equal(get.headers.get("Access-Control-Allow-Origin"), null);

  const preflight = await request({ method: "OPTIONS", headers: {
    Origin: origin,
    "Access-Control-Request-Method": "PUT",
    "Access-Control-Request-Headers": "content-type",
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
  assert.match(preflight.headers.get("Access-Control-Allow-Methods"), /\bPUT\b/);
  assert.equal(preflight.headers.get("Access-Control-Allow-Headers"), "Content-Type");
  assert.equal(preflight.headers.get("Access-Control-Allow-Credentials"), null);

  const denied = await putRaw('{"revision":0,"changes":{"1":2000}}', { Origin: "https://other.example" });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await request({ method: "PUT" })).status, 403);
  assert.equal((await request({ method: "POST" })).status, 405);
  assert.equal((await request({}, `${url}/unrecognized`)).status, 404);
  assert.equal(roster.mock.callCount(), 0);
});

test("keeps state and preflight available when writes are paused", async (t) => {
  const { env, request, put, putRaw, roster } = setup(t);
  const initial = await put(0, { 1: 3000 }, { 1: "平宝" });
  assert.equal(initial.status, 200);
  const saved = await initial.json();
  env.MMR_READ_ONLY = "true";

  const paused = await put(1, { 1: 4000 });
  assert.equal(paused.status, 503);
  assert.equal(paused.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(paused.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await paused.json(), { error: "Shared MMR updates are temporarily paused" });
  assert.equal((await putRaw("{")).status, 503);
  assert.equal((await request({ method: "PUT" })).status, 403);
  assert.equal((await request({ method: "OPTIONS", headers: { Origin: origin } })).status, 204);
  assert.equal(roster.mock.callCount(), 1);
  assert.deepEqual(await (await request()).json(), saved);
});

test("persists only changed ratings and clears a single override with null", async (t) => {
  const { request, put } = setup(t);
  const written = await put(0, { 1: 0, 2: 99999 });
  assert.equal(written.status, 200);
  assert.equal(written.headers.get("Access-Control-Allow-Origin"), origin);
  const initial = await written.json();
  assert.deepEqual(initial.ratings, { 1: 0, 2: 99999 });
  assert.equal(initial.revision, 1);
  assert.equal(new Date(initial.updatedAt).toISOString(), initial.updatedAt);
  assert.deepEqual(await (await request()).json(), initial);
  assert.deepEqual(await (await put(1, { 1: 0, 3: null })).json(), initial);

  const cleared = await (await put(1, { 1: null })).json();
  assert.equal(cleared.revision, 2);
  assert.deepEqual(cleared.ratings, { 2: 99999 });
  assert.deepEqual(await (await request()).json(), cleared);
});

test("stores player aliases alongside ratings and clears one with null", async (t) => {
  const { request, put } = setup(t);
  const named = await put(0, { 1: 3000 }, { 1: "平宝", 2: "Pudge King" });
  assert.equal(named.status, 200);
  const saved = await named.json();
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.ratings, { 1: 3000 });
  assert.deepEqual(saved.aliases, { 1: "平宝", 2: "Pudge King" });
  assert.deepEqual(await (await request()).json(), saved);
  assert.deepEqual(await (await put(1, {}, { 1: "平宝", 3: null })).json(), saved);

  const renamed = await (await put(1, {}, { 1: null, 2: "屠夫" })).json();
  assert.equal(renamed.revision, 2);
  assert.deepEqual(renamed.ratings, { 1: 3000 });
  assert.deepEqual(renamed.aliases, { 2: "屠夫" });
});

test("rejects blank, padded, overlong or hidden-character aliases", async (t) => {
  const { request, put, roster } = setup(t);
  for (const alias of ["", " 平宝", "平宝 ", "a".repeat(17), "平\n宝", "平\u200b宝", 7, ["平宝"]]) {
    assert.equal((await put(0, {}, { 1: alias })).status, 400, JSON.stringify(alias));
  }
  assert.equal((await put(0, {}, [])).status, 400);
  assert.equal((await put(0, {}, { "01": "平宝" })).status, 400);
  assert.equal(roster.mock.callCount(), 0);
  assert.equal((await put(0, {}, { 11: "隔壁" })).status, 400);
  assert.equal((await put(0, {}, { 1: "😀".repeat(16) })).status, 200);
  assert.deepEqual((await (await request()).json()).aliases, { 1: "😀".repeat(16) });
});

test("an atomic compare-and-swap preserves the first writer and lets the other rebase", { timeout: 3000 }, async (t) => {
  let writers = 0;
  const ready = Promise.withResolvers();
  const { request, put } = setup(t, () => {
    writers += 1;
    if (writers === 2) ready.resolve();
    return ready.promise;
  });

  const patches = [{ 1: 3000 }, { 2: 4000 }];
  const results = await Promise.all(patches.map((changes) => put(0, changes)));
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
  const winner = results.findIndex(({ status }) => status === 200);
  const saved = await results[winner].json();
  assert.deepEqual(saved.ratings, patches[winner]);
  assert.equal(saved.revision, 1);
  assert.deepEqual(await results[1 - winner].json(), saved);

  const retry = await put(saved.revision, patches[1 - winner]);
  assert.equal(retry.status, 200);
  const final = await retry.json();
  assert.equal(final.revision, 2);
  assert.deepEqual(final.ratings, { 1: 3000, 2: 4000 });
  assert.deepEqual(await (await request()).json(), final);
  const stale = await put(0, { 1: 5000 });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), final);
});

test("rejects invalid and oversized changes without writing any part of the patch", async (t) => {
  const { request, put, putRaw, roster } = setup(t);
  for (const changes of [{ 1: -1 }, { 1: 100000 }, { 1: 4000.5 }, { 1: "4000" }, { "01": 2000 }, []]) {
    assert.equal((await put(0, changes)).status, 400);
  }
  assert.equal((await put(-1, { 1: 4000 })).status, 400);
  assert.equal((await putRaw('{"revision":0,"changes":{"__proto__":4000}}')).status, 400);
  assert.equal((await putRaw("{")).status, 400);
  assert.equal((await putRaw("{}", { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await putRaw(" ".repeat(16 * 1024 + 1))).status, 413);
  assert.equal(roster.mock.callCount(), 0);
  assert.equal((await put(0, { 1: 4000, 11: 5000 })).status, 400);
  assert.deepEqual(await (await request()).json(), empty);
});

test("keeps reads available when roster validation is temporarily unavailable", async (t) => {
  const { request, put, roster } = setup(t);
  roster.mock.mockImplementation(async () => new Response(null, { status: 502 }));
  t.mock.method(console, "error", () => {});
  const failed = await put(0, { 1: 4000 });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "League roster unavailable" });
  assert.deepEqual(await (await request()).json(), empty);
});
