import { buildLeagueRoster, describeRankTier, estimateRankMmr } from "./matchmaker-model.js?v=4";
import { loadSharedMmr, saveSharedMmr } from "./shared-mmr.js?v=1";

const form = document.querySelector("#mmrForm");
const rows = document.querySelector("#mmrRows");
const search = document.querySelector("#mmrSearch");
const noMatches = document.querySelector("#mmrNoMatches");
const rosterStatus = document.querySelector("#mmrRosterStatus");
const pending = document.querySelector("#mmrPending");
const feedback = document.querySelector("#mmrFeedback");
const save = document.querySelector("#mmrSave");
const integer = new Intl.NumberFormat("zh-CN");
const entries = new Map();
let current;
let saving = false;

function make(tag, className, text = "") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function labelMmr(mmr) {
  return mmr === null ? "未填写" : integer.format(mmr);
}

function report(message, isError = false) {
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
}

function storedMmr(state, accountId) {
  return state?.ratings[accountId] ?? null;
}

function applyState(state, drafts = {}) {
  const prior = current;
  const savedCount = [...entries.keys()].filter((accountId) => storedMmr(state, accountId) !== null).length;
  for (const [accountId, entry] of entries) {
    const saved = storedMmr(state, accountId);
    const kept = Object.hasOwn(drafts, accountId) && drafts[accountId] !== saved;
    const value = kept ? drafts[accountId] : saved;
    entry.field.value = value === null ? "" : String(value);
    entry.conflict.textContent = kept && saved !== storedMmr(prior, accountId)
      ? "线上已改为 " + labelMmr(saved)
      : "";
    entry.field.removeAttribute("aria-invalid");
  }
  current = state;
  rosterStatus.textContent = entries.size + " 名玩家 · " + savedCount + " 人已填写";
}

function collectChanges() {
  const changes = {};
  const invalid = [];
  for (const [accountId, entry] of entries) {
    const raw = entry.field.value.trim();
    const valid = /^[0-9]{0,5}$/.test(raw);
    const value = raw === "" ? null : Number(raw);
    const changed = !valid || value !== storedMmr(current, accountId);
    entry.row.classList.toggle("is-pending", changed);
    if (!valid) invalid.push(entry);
    else if (changed) changes[accountId] = value;
  }
  return { changes, invalid };
}

function renderPending() {
  const { changes, invalid } = collectChanges();
  const count = Object.keys(changes).length + invalid.length;
  pending.textContent = count + " 项待保存";
  save.disabled = saving || !current || count === 0;
  save.textContent = saving ? "正在保存…" : "保存改动";
  for (const { field } of entries.values()) field.readOnly = saving;
}

function filterPlayers() {
  const query = search.value.trim().normalize("NFKC").toLowerCase();
  let shown = 0;
  for (const { row, haystack } of entries.values()) {
    row.hidden = !haystack.includes(query);
    if (!row.hidden) shown++;
  }
  noMatches.hidden = shown > 0;
}

function buildRow(player) {
  const row = make("div", "mmr-row");
  const identity = make("div", "mmr-player");
  identity.append(make("strong", "", player.name), make("small", "", String(player.accountId)));
  const rank = make("div", "mmr-rank");
  const tierEstimate = estimateRankMmr(player.rankTier);
  rank.append(
    make("span", "", describeRankTier(player.rankTier) || "无公开段位"),
    make("small", "", tierEstimate !== null ? "约 " + integer.format(tierEstimate) :
      player.ratingSource === "median" ? "暂估 " + integer.format(player.baseRating) : ""),
  );
  const entry = make("div", "mmr-entry");
  const field = make("input", "mmr-input");
  field.type = "text";
  field.inputMode = "numeric";
  field.autocomplete = "off";
  field.placeholder = "未填写";
  field.setAttribute("aria-label", player.name + "（" + player.accountId + "）的天梯 MMR");
  field.id = "mmr-" + player.accountId;
  field.name = String(player.accountId);
  const conflict = make("small", "mmr-conflict");
  conflict.id = field.id + "-conflict";
  field.setAttribute("aria-describedby", conflict.id);
  entry.append(field, conflict);
  row.append(identity, rank, entry);
  entries.set(player.accountId, {
    row, field, conflict, haystack: (player.name + " " + player.accountId).normalize("NFKC").toLowerCase(),
  });
  return row;
}

search.addEventListener("input", filterPlayers);
rows.addEventListener("input", (event) => {
  event.target.removeAttribute("aria-invalid");
  report("");
  renderPending();
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!current || saving) return;
  const { changes, invalid } = collectChanges();
  if (invalid.length) {
    const { field, row } = invalid[0];
    if (row.hidden) {
      search.value = "";
      filterPlayers();
    }
    field.setAttribute("aria-invalid", "true");
    field.focus();
    report("请输入 0–99999 的整数，或留空使用估分。", true);
    return;
  }
  if (Object.keys(changes).length === 0) return;

  saving = true;
  renderPending();
  report("");
  try {
    const result = await saveSharedMmr(current.revision, changes);
    applyState(result.state, result.conflict ? changes : {});
    const stillPending = Object.keys(collectChanges().changes).length > 0;
    if (result.conflict && stillPending) {
      report("已读取其他访客的更新。你的修改还在，请核对后再保存。", true);
    } else {
      report("已保存，平衡分队会读取最新天梯分。");
    }
  } catch (error) {
    report("未能确认保存结果。改动仍在，请稍后重试。", true);
    console.error(error);
  } finally {
    saving = false;
    renderPending();
  }
});

async function loadEditor() {
  try {
    const [snapshot, state] = await Promise.all([
      fetch("./data/league.json", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error("Could not read league snapshot (HTTP " + response.status + ")");
        return response.json();
      }),
      loadSharedMmr(),
    ]);
    const players = buildLeagueRoster(snapshot)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.accountId - right.accountId);
    rows.append(...players.map(buildRow));
    applyState(state);
    search.disabled = false;
    filterPlayers();
    renderPending();
  } catch (error) {
    rosterStatus.textContent = "共享天梯分或联赛名单读取失败，请刷新重试。";
    report("载入完成后才可编辑。", true);
    console.error(error);
  }
}

loadEditor();
