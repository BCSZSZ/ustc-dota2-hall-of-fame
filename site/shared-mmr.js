const endpoint = "https://ustc-dota2-mmr-api.liaowang586.chatgpt.site/api/mmr";

async function readState(response) {
  const state = await response.json();
  if (!Number.isSafeInteger(state?.revision) || state.revision < 0 ||
      !state.ratings || typeof state.ratings !== "object" || Array.isArray(state.ratings) ||
      !Object.values(state.ratings).every((mmr) => Number.isSafeInteger(mmr) && mmr >= 0 && mmr <= 99999)) {
    throw new Error("Invalid shared MMR response");
  }
  return state;
}

export async function loadSharedMmr() {
  const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Could not read shared MMR (HTTP " + response.status + ")");
  return readState(response);
}

export async function saveSharedMmr(revision, changes) {
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, changes }),
    signal: AbortSignal.timeout(10000),
  });
  const conflict = response.status === 409;
  if (!response.ok && !conflict) {
    throw new Error("Could not save shared MMR (HTTP " + response.status + ")");
  }
  return { state: await readState(response), conflict };
}
