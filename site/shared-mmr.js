const endpoint = "https://408sq8skz1.execute-api.ap-northeast-1.amazonaws.com/api/mmr";
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
    const state = await readState(response);
    rememberAliases(state.aliases);
    return { state, conflict };
  } finally {
    clearTimeout(timer);
  }
}

export async function loadSharedMmr() {
  return (await requestState({ cache: "no-store" }, 10000)).state;
}

// The last aliases this browser read, so pages can draw names before the shared service answers.
const ALIAS_STORE = "ustc-hof-aliases";
const FIRST_VISIT_WAIT_MS = 1500;

function rememberAliases(aliases) {
  try {
    if (isObject(aliases)) localStorage.setItem(ALIAS_STORE, JSON.stringify(aliases));
  } catch {
    // Storage can be full or blocked; names then simply wait for the service next time.
  }
}

function rememberedAliases() {
  try {
    const aliases = JSON.parse(localStorage.getItem(ALIAS_STORE));
    return isObject(aliases) ? aliases : null;
  } catch {
    return null;
  }
}

// Player aliases replace Steam names everywhere except the registration page.
// Resolves at once with the aliases remembered from the last visit (a first visit waits at most
// FIRST_VISIT_WAIT_MS), then calls onChange if the shared service answers with different ones.
// Pages keep Steam names when the service is slow or down.
export async function loadPlayerAliases(onChange = () => {}) {
  let shown = rememberedAliases();
  const fresh = loadSharedMmr().then((state) => state.aliases ?? {}, (error) => {
    console.error("Could not read player aliases", error);
    return null;
  });
  fresh.then((aliases) => {
    if (aliases && shown && JSON.stringify(aliases) !== JSON.stringify(shown)) onChange(aliases);
  });
  if (!shown) {
    const timeout = new Promise((resolve) => setTimeout(resolve, FIRST_VISIT_WAIT_MS, null));
    shown = (await Promise.race([fresh, timeout])) ?? {};
  }
  return shown;
}

export async function saveSharedMmr(revision, changes, aliases = {}) {
  return requestState({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, changes, aliases }),
  }, 10000);
}
