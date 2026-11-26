const PAGES_ORIGIN = "https://bcszsz.github.io";
const LEAGUE_URL = `${PAGES_ORIGIN}/ustc-dota2-hall-of-fame/data/league.json`;
const MATCH_SLOTS = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ALIAS_CHARS = 16;
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const METHODS = "GET, PUT, OPTIONS";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validAccountId(accountId) {
  const id = Number(accountId);
  return Number.isSafeInteger(id) && id > 0 && String(id) === accountId;
}

function validChange([accountId, rating]) {
  return validAccountId(accountId) &&
    (rating === null || (Number.isInteger(rating) && rating >= 0 && rating <= 99999));
}

function validAlias([accountId, alias]) {
  return validAccountId(accountId) && (alias === null || (typeof alias === "string" &&
    alias !== "" && alias === alias.trim() && [...alias].length <= MAX_ALIAS_CHARS && !HIDDEN_CHARS.test(alias)));
}

async function leagueAccountIds() {
  const response = await fetch(LEAGUE_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`League data returned HTTP ${response.status}`);
  const league = await response.json();
  if (league?.league_id !== 19224 || !Array.isArray(league.matches)) {
    throw new Error("Invalid league data");
  }

  // Steam name lookups can omit accounts that are present in valid match rosters.
  const excluded = new Set(league.metadata?.incomplete_roster_match_ids);
  const accounts = new Set();
  for (const match of league.matches) {
    if (!Number.isSafeInteger(match?.match_id) || match.match_id <= 0 || excluded.has(match.match_id) ||
        !Number.isFinite(match.start_time) || typeof match.radiant_win !== "boolean" ||
        !Array.isArray(match.players) || match.players.length !== MATCH_SLOTS.length) continue;
    const slots = new Set(match.players.map((player) => player?.player_slot));
    if (!MATCH_SLOTS.every((slot) => slots.has(slot))) continue;
    for (const { account_id: id } of match.players) {
      if (Number.isSafeInteger(id) && id > 0) accounts.add(id);
    }
  }
  return accounts;
}

function createDynamoRepository(client, { GetItemCommand, PutItemCommand }, tableName) {
  const key = { id: { S: "state" } };
  return {
    async read() {
      const { Item } = await client.send(new GetItemCommand({
        TableName: tableName,
        Key: key,
        ConsistentRead: true,
      }));
      if (!Item) throw new Error("Shared MMR state is missing");
      return {
        revision: Number(Item.revision.N),
        ratings: JSON.parse(Item.ratings.S),
        aliases: JSON.parse(Item.aliases.S),
        updatedAt: Item.updatedAt.NULL ? null : Item.updatedAt.S,
      };
    },
    async compareAndSwap(revision, next) {
      try {
        await client.send(new PutItemCommand({
          TableName: tableName,
          Item: {
            ...key,
            revision: { N: String(next.revision) },
            ratings: { S: JSON.stringify(next.ratings) },
            aliases: { S: JSON.stringify(next.aliases) },
            updatedAt: { S: next.updatedAt },
          },
          ConditionExpression: "#revision = :revision",
          ExpressionAttributeNames: { "#revision": "revision" },
          ExpressionAttributeValues: { ":revision": { N: String(revision) } },
        }));
        return true;
      } catch (err) {
        if (err.name === "ConditionalCheckFailedException") return false;
        throw err;
      }
    },
  };
}

let dynamoRepository;
async function getDynamoRepository() {
  if (!dynamoRepository) {
    const sdk = await import("@aws-sdk/client-dynamodb");
    dynamoRepository ??= createDynamoRepository(new sdk.DynamoDBClient({}), sdk, process.env.TABLE_NAME);
  }
  return dynamoRepository;
}

function patch(current, changes) {
  const updated = changes.filter(([id, value]) => (current[id] ?? null) !== value);
  if (!updated.length) return current;
  const next = { ...current };
  for (const [id, value] of updated) {
    if (value === null) delete next[id];
    else next[id] = value;
  }
  return next;
}

function createHandler({
  getRepository = getDynamoRepository,
  readRoster = leagueAccountIds,
  writesEnabled = process.env.MMR_WRITES_ENABLED === "true",
} = {}) {
  return async (event) => {
    const { method } = event.requestContext.http;
    const requestHeaders = event.headers ?? {};
    const headers = { "Cache-Control": "no-store", "Vary": "Origin" };
    const json = (data, statusCode = 200) => ({
      statusCode,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const error = (status, message) => json({ error: message }, status);

    if (event.rawPath !== "/api/mmr") return error(404, "Not found");
    if ((method === "PUT" || method === "OPTIONS") && requestHeaders.origin !== PAGES_ORIGIN) {
      return error(403, "Origin not allowed");
    }
    // API Gateway supplies the CORS headers and handles browser preflights.
    if (method === "OPTIONS") return { statusCode: 204, headers };
    if (method !== "GET" && method !== "PUT") {
      headers.Allow = METHODS;
      return error(405, "Method not allowed");
    }

    try {
      if (method === "GET") return json(await (await getRepository()).read());
      if (!writesEnabled) return error(503, "Shared MMR unavailable");
      if (requestHeaders["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
        return error(415, "Expected application/json");
      }

      let body;
      try {
        if (Number(requestHeaders["content-length"]) > MAX_BODY_BYTES) return error(413, "Request body too large");
        const bytes = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
        if (bytes.length > MAX_BODY_BYTES) return error(413, "Request body too large");
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return error(400, "Invalid JSON body");
      }
      if (!isObject(body) || !Number.isSafeInteger(body.revision) || body.revision < 0 || !isObject(body.changes) ||
          (body.aliases !== undefined && !isObject(body.aliases))) {
        return error(400, "Expected a revision and changes object");
      }
      const changes = Object.entries(body.changes);
      const aliasChanges = Object.entries(body.aliases ?? {});
      if (!changes.every(validChange)) return error(400, "Invalid account ID or MMR");
      if (!aliasChanges.every(validAlias)) return error(400, "Invalid account ID or player alias");

      if (changes.length || aliasChanges.length) {
        let accounts;
        try {
          accounts = await readRoster();
        } catch (err) {
          console.error(err);
          return error(503, "League roster unavailable");
        }
        if ([...changes, ...aliasChanges].some(([id]) => !accounts.has(Number(id)))) {
          return error(400, "Unknown league account ID");
        }
      }

      const repository = await getRepository();
      const current = await repository.read();
      if (current.revision !== body.revision) return json(current, 409);
      const ratings = patch(current.ratings, changes);
      const aliases = patch(current.aliases, aliasChanges);
      if (ratings === current.ratings && aliases === current.aliases) return json(current);

      const next = { revision: current.revision + 1, ratings, aliases, updatedAt: new Date().toISOString() };
      if (await repository.compareAndSwap(current.revision, next)) return json(next);
      return json(await repository.read(), 409);
    } catch (err) {
      console.error(err);
      return error(503, "Shared MMR unavailable");
    }
  };
}

module.exports = { handler: createHandler(), createHandler, createDynamoRepository };
