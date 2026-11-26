import assert from "node:assert/strict";
import test from "node:test";
import lambda from "../mmr-aws/handler.cjs";

const { createHandler, createDynamoRepository } = lambda;
const origin = "https://bcszsz.github.io";
const empty = { revision: 0, ratings: {}, aliases: {}, updatedAt: null };
const key = { id: { S: "state" } };
const emptyRow = {
  ...key, revision: { N: "0" }, ratings: { S: "{}" }, aliases: { S: "{}" }, updatedAt: { NULL: true },
};

class GetItemCommand {
  constructor(input) { this.input = input; }
}
class PutItemCommand {
  constructor(input) { this.input = input; }
}

function setup({ beforeWrite, seed = emptyRow, ...options } = {}) {
  let row = seed;
  const calls = [];
  const repository = createDynamoRepository({
    async send(command) {
      const { input } = command;
      calls.push(command);
      if (command instanceof GetItemCommand) {
        assert.deepEqual(input, { TableName: "test-mmr", Key: key, ConsistentRead: true });
        return { Item: row };
      }
      assert.ok(command instanceof PutItemCommand);
      assert.equal(input.TableName, "test-mmr");
      assert.equal(input.ConditionExpression, "#revision = :revision");
      assert.deepEqual(input.ExpressionAttributeNames, { "#revision": "revision" });
      await beforeWrite?.();
      if (row?.revision.N !== input.ExpressionAttributeValues[":revision"].N) {
        throw Object.assign(new Error("Condition failed"), { name: "ConditionalCheckFailedException" });
      }
      row = input.Item;
      return {};
    },
  }, { GetItemCommand, PutItemCommand }, "test-mmr");
  const handler = createHandler({
    getRepository: () => repository,
    readRoster: async () => new Set([1, 2, 3]),
    writesEnabled: true,
    ...options,
  });
  const request = async (method = "GET", event = {}) => {
    const response = await handler({
      version: "2.0", rawPath: "/api/mmr", requestContext: { http: { method } },
      ...event,
    });
    assert.equal(response.headers["Cache-Control"], "no-store");
    assert.equal(response.headers.Vary, "Origin");
    return { ...response, data: response.body === undefined ? undefined : JSON.parse(response.body) };
  };
  const putRaw = (body, headers = {}, isBase64Encoded = false) => request("PUT", {
    body, isBase64Encoded, headers: { origin, "content-type": "Application/JSON; charset=utf-8", ...headers },
  });
  const put = (revision, changes, aliases) => putRaw(JSON.stringify({ revision, changes, aliases }));
  return { request, put, putRaw, calls, row: () => row };
}

test("serves public reads and enforces endpoint, method, origin and the write switch", async () => {
  const { request, put, calls } = setup({ writesEnabled: false });
  const read = await request();
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers["Content-Type"], "application/json");
  assert.deepEqual(read.data, empty);
  assert.equal((await request("GET", { rawPath: "/api/mmr/unknown" })).statusCode, 404);
  const post = await request("POST");
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.Allow, "GET, PUT, OPTIONS");
  assert.equal((await request("OPTIONS", { headers: { origin } })).statusCode, 204);
  assert.equal((await request("PUT")).statusCode, 403);
  assert.equal((await request("PUT", { headers: { origin: "https://other.example" } })).statusCode, 403);
  assert.equal((await put(0, { 1: 3000 })).statusCode, 503);
  assert.equal(calls.length, 1);
});

test("patches aliases and rating overrides with a DynamoDB row, preserving deletes and no-ops", async () => {
  const { request, put, putRaw, calls, row } = setup();
  const putBody = JSON.stringify({ revision: 0, changes: { 1: 0, 2: 99999 }, aliases: { 1: "😀".repeat(16) } });
  const written = await putRaw(Buffer.from(putBody).toString("base64"), {}, true);
  assert.equal(written.statusCode, 200);
  const { updatedAt } = written.data;
  assert.equal(new Date(updatedAt).toISOString(), updatedAt);
  assert.deepEqual(written.data, { revision: 1, ratings: { 1: 0, 2: 99999 }, aliases: { 1: "😀".repeat(16) }, updatedAt });
  assert.deepEqual(row(), {
    ...key,
    revision: { N: "1" },
    ratings: { S: '{"1":0,"2":99999}' },
    aliases: { S: JSON.stringify({ 1: "😀".repeat(16) }) },
    updatedAt: { S: updatedAt },
  });
  assert.deepEqual((await put(1, { 1: 0, 3: null })).data, written.data);
  assert.deepEqual((await put(1, {}, { 1: "😀".repeat(16), 3: null })).data, written.data);
  assert.equal(calls.filter((call) => call instanceof PutItemCommand).length, 1);

  const cleared = (await put(1, { 1: null }, { 1: null, 2: "平宝" })).data;
  assert.equal(cleared.revision, 2);
  assert.deepEqual(cleared.ratings, { 2: 99999 });
  assert.deepEqual(cleared.aliases, { 2: "平宝" });
  assert.deepEqual((await request()).data, cleared);
});

test("conditionally writes the revision and returns the latest state when another writer wins", { timeout: 3000 }, async () => {
  let writers = 0;
  const ready = Promise.withResolvers();
  const { put, calls } = setup({ beforeWrite: () => {
    if (++writers === 2) ready.resolve();
    return ready.promise;
  } });
  const patches = [{ 1: 3000 }, { 2: 4000 }];
  const results = await Promise.all(patches.map((changes) => put(0, changes)));
  assert.deepEqual(results.map(({ statusCode }) => statusCode).sort(), [200, 409]);
  const winner = results.findIndex(({ statusCode }) => statusCode === 200);
  assert.deepEqual(results[winner].data.ratings, patches[winner]);
  assert.deepEqual(results[1 - winner].data, results[winner].data);
  assert.ok(calls.at(-1) instanceof GetItemCommand);

  const retry = await put(1, patches[1 - winner]);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.data.revision, 2);
  assert.deepEqual(retry.data.ratings, { 1: 3000, 2: 4000 });
  const stale = await put(0, {});
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.data, retry.data);
});

function match(matchId, firstAccountId) {
  return {
    match_id: matchId, start_time: 100, radiant_win: true,
    players: [0, 1, 2, 3, 4, 128, 129, 130, 131, 132].map((slot, index) => ({
      player_slot: slot, account_id: firstAccountId + index,
    })),
  };
}

test("validates payloads and only permits accounts from complete league rosters", async (t) => {
  const malformedMatch = match(3, 21);
  malformedMatch.players[9].player_slot = 0;
  const fetch = t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, `${origin}/ustc-dota2-hall-of-fame/data/league.json`);
    return Response.json({
      league_id: 19224,
      player_names: { 1: "Named player", 11: "Excluded player", 21: "Malformed roster player" },
      matches: [match(1, 1), match(2, 11), malformedMatch],
      metadata: { incomplete_roster_match_ids: [2] },
    });
  });
  const { request, put, putRaw } = setup({ readRoster: undefined });
  assert.equal((await putRaw("{}", { "content-type": "text/plain" })).statusCode, 415);
  assert.equal((await putRaw("{}", { "content-length": "16385" })).statusCode, 413);
  assert.equal((await putRaw("界".repeat(5462))).statusCode, 413);
  assert.equal((await putRaw(Buffer.alloc(16385).toString("base64"), {}, true)).statusCode, 413);
  assert.equal((await putRaw("/w==", {}, true)).statusCode, 400);
  for (const changes of [{ 1: 100000 }, { 1: -1 }, { 1: 5.5 }, { 1: "3000" }, { "01": 2000 }, []]) {
    assert.equal((await put(0, changes)).statusCode, 400);
  }
  for (const aliases of [null, [], { 1: "" }, { 1: " 上" }, { 1: "a".repeat(17) }, { 1: "平\u200b宝" }]) {
    assert.equal((await put(0, {}, aliases)).statusCode, 400);
  }
  assert.equal((await putRaw('{"revision":0,"changes":{"__proto__":2000}}')).statusCode, 400);
  assert.equal((await put(-1, {})).statusCode, 400);
  assert.deepEqual((await put(0, {})).data, empty);
  assert.equal(fetch.mock.callCount(), 0);

  for (const account of [11, 21]) {
    assert.deepEqual((await put(0, { 2: 3000 }, { [account]: null })).data, { error: "Unknown league account ID" });
  }
  assert.deepEqual((await request()).data, empty);
  assert.deepEqual((await put(0, { 2: 3000 })).data.ratings, { 2: 3000 });
});

test("surfaces missing storage and keeps reads available during a roster failure", async (t) => {
  t.mock.method(console, "error", () => {});
  const missing = await setup({ seed: null }).request();
  assert.equal(missing.statusCode, 503);
  assert.deepEqual(missing.data, { error: "Shared MMR unavailable" });

  const { request, put } = setup({ readRoster: async () => { throw new Error("Roster request failed"); } });
  const unavailable = await put(0, { 1: 3000 });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.data, { error: "League roster unavailable" });
  assert.deepEqual((await request()).data, empty);
});
