const endpoint = "https://ustc-dota2-mmr-api.liaowang586.chatgpt.site/api/mmr";
export const MAX_ALIAS_CHARS = 16;
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Mirrors the worker's rule: trimmed, 1–16 characters, no control or invisible characters.
export function validAlias(alias) {
  return alias !== "" && alias === alias.trim() && [...alias].length <= MAX_ALIAS_CHARS && !HIDDEN_CHARS.test(alias);
}

export async function readState(response) {
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

async function requestState(options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(endpoint, { ...options, signal: controller.signal });
    const conflict = response.status === 409 && options.method === "PUT";
    if (!response.ok && !conflict) throw new Error("Shared MMR returned HTTP " + response.status);
    return { state: await readState(response), conflict };
  } finally {
    clearTimeout(timer);
  }
}

export async function loadSharedMmr() {
  return (await requestState({ cache: "no-store" }, 10000)).state;
}

// Player aliases replace Steam names everywhere except the registration page.
// Pages still render with Steam names when the shared service is slow or down.
export async function loadPlayerAliases() {
  try {
    const { state } = await requestState({ cache: "no-store" }, 4000);
    return state.aliases ?? {};
  } catch (error) {
    console.error("Could not read player aliases", error);
    return {};
  }
}

export async function saveSharedMmr(revision, changes, aliases = {}) {
  return requestState({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, changes, aliases }),
  }, 10000);
}
