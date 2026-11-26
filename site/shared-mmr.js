const endpoint = "https://ustc-dota2-mmr-api.liaowang586.chatgpt.site/api/mmr";
export const MAX_ALIAS_CHARS = 16;
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Mirrors the worker's rule: trimmed, 1–16 characters, no control or invisible characters.
export function validAlias(alias) {
  return alias !== "" && alias === alias.trim() && [...alias].length <= MAX_ALIAS_CHARS && !HIDDEN_CHARS.test(alias);
}

async function readState(response) {
  const state = await response.json();
  if (!Number.isSafeInteger(state?.revision) || state.revision < 0 ||
      !isObject(state.ratings) ||
      !Object.values(state.ratings).every((mmr) => Number.isSafeInteger(mmr) && mmr >= 0 && mmr <= 99999) ||
      // A service deployed before player aliases existed omits the field; callers treat that as unsupported.
      (state.aliases !== undefined && (!isObject(state.aliases) ||
        !Object.values(state.aliases).every((alias) => typeof alias === "string" && validAlias(alias))))) {
    throw new Error("Invalid shared MMR response");
  }
  return state;
}

export async function loadSharedMmr() {
  const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Could not read shared MMR (HTTP " + response.status + ")");
  return readState(response);
}

// Player aliases replace Steam names everywhere except the registration page.
// Pages still render with Steam names when the shared service is slow or down.
export async function loadPlayerAliases() {
  try {
    const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return (await readState(response)).aliases ?? {};
  } catch (error) {
    console.error("Could not read player aliases", error);
    return {};
  }
}

export async function saveSharedMmr(revision, changes, aliases = {}) {
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, changes, aliases }),
    signal: AbortSignal.timeout(10000),
  });
  const conflict = response.status === 409;
  if (!response.ok && !conflict) {
    throw new Error("Could not save shared MMR (HTTP " + response.status + ")");
  }
  return { state: await readState(response), conflict };
}
