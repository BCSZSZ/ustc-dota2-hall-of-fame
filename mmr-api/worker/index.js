const PAGES_ORIGIN = "https://bcszsz.github.io";
const LEAGUE_URL = `${PAGES_ORIGIN}/ustc-dota2-hall-of-fame/data/league.json`;
const MATCH_SLOTS = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
const MAX_BODY_BYTES = 16 * 1024;
const METHODS = "GET, PUT, OPTIONS";
const MAX_ALIAS_CHARS = 16;
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

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

async function readLimitedBody(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
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

function parseState({ revision, ratings, aliases, updated_at }) {
  return { revision, ratings: JSON.parse(ratings), aliases: JSON.parse(aliases), updatedAt: updated_at };
}

async function readState(db) {
  return parseState(await db.prepare("SELECT revision, ratings, aliases, updated_at FROM mmr_state WHERE id = 1").first());
}

export default {
  async fetch(request, { DB }) {
    const { method } = request;
    const allowedOrigin = request.headers.get("Origin") === PAGES_ORIGIN;
    const headers = { "Cache-Control": "no-store", Vary: "Origin" };
    if (allowedOrigin) headers["Access-Control-Allow-Origin"] = PAGES_ORIGIN;
    const json = (data, status = 200) => Response.json(data, { status, headers });
    const error = (status, message) => json({ error: message }, status);

    if (new URL(request.url).pathname !== "/api/mmr") return error(404, "Not found");
    if (method === "OPTIONS" || method === "PUT") {
      if (!allowedOrigin) return error(403, "Origin not allowed");
    }
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        ...headers,
        "Access-Control-Allow-Methods": METHODS,
        "Access-Control-Allow-Headers": "Content-Type",
      } });
    }
    if (method !== "GET" && method !== "PUT") {
      headers.Allow = METHODS;
      return error(405, "Method not allowed");
    }

    try {
      if (method === "GET") return json(await readState(DB));
      if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        return error(415, "Expected application/json");
      }

      let body;
      try {
        const raw = await readLimitedBody(request);
        if (raw === null) return error(413, "Request body too large");
        body = JSON.parse(raw);
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
          accounts = await leagueAccountIds();
        } catch (err) {
          console.error(err);
          return error(503, "League roster unavailable");
        }
        if ([...changes, ...aliasChanges].some(([id]) => !accounts.has(Number(id)))) {
          return error(400, "Unknown league account ID");
        }
      }

      const current = await readState(DB);
      if (current.revision !== body.revision) return json(current, 409);
      const updated = changes.filter(([id, rating]) => (current.ratings[id] ?? null) !== rating);
      const updatedAliases = aliasChanges.filter(([id, alias]) => (current.aliases[id] ?? null) !== alias);
      if (!updated.length && !updatedAliases.length) return json(current);

      const row = await DB.prepare(`
        UPDATE mmr_state
        SET revision = revision + 1, ratings = json_patch(ratings, ?), aliases = json_patch(aliases, ?), updated_at = ?
        WHERE id = 1 AND revision = ?
        RETURNING revision, ratings, aliases, updated_at
      `).bind(
        JSON.stringify(Object.fromEntries(updated)),
        JSON.stringify(Object.fromEntries(updatedAliases)),
        new Date().toISOString(),
        body.revision,
      ).first();
      return row ? json(parseState(row)) : json(await readState(DB), 409);
    } catch (err) {
      console.error(err);
      return error(503, "Shared MMR unavailable");
    }
  },
};
