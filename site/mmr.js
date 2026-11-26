import { buildLeagueRoster, describeRankTier, estimateRankMmr } from "./matchmaker-model.js?v=5";
import { loadSharedMmr, MAX_ALIAS_CHARS, saveSharedMmr, validAlias } from "./shared-mmr.js?v=2";

const form = document.querySelector("#mmrForm");
const rows = document.querySelector("#mmrRows");
const search = document.querySelector("#mmrSearch");
const noMatches = document.querySelector("#mmrNoMatches");
const rosterStatus = document.querySelector("#mmrRosterStatus");
const pending = document.querySelector("#mmrPending");
const feedback = document.querySelector("#mmrFeedback");
const save = document.querySelector("#mmrSave");
const aliasNotice = document.querySelector("#mmrAliasNotice");
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

const FIELDS = {
  alias: {
    stored: (state, accountId) => state?.aliases?.[accountId] ?? null,
    parse(raw) {
      const value = raw.trim().normalize("NFC");
      return { valid: value === "" || validAlias(value), value: value === "" ? null : value };
    },
    label: (alias) => alias ?? "未填写",
    invalid: "称呼最多 " + MAX_ALIAS_CHARS + " 个字，不能含换行或不可见字符。",
  },
  mmr: {
    stored: (state, accountId) => state?.ratings[accountId] ?? null,
    parse(raw) {
      const value = raw.trim();
      return { valid: /^[0-9]{0,5}$/.test(value), value: value === "" ? null : Number(value) };
    },
    label: (mmr) => mmr === null ? "未填写" : integer.format(mmr),
    invalid: "请输入 0–99999 的整数，或留空使用估分。",
  },
};
const KINDS = Object.keys(FIELDS);

function report(message, isError = false) {
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
}

const aliasesSupported = (state) => state?.aliases !== undefined;

function applyState(state, drafts = {}) {
  const prior = current;
  const count = (kind) => [...entries.keys()].filter((accountId) => FIELDS[kind].stored(state, accountId) !== null).length;
  for (const [accountId, entry] of entries) {
    for (const kind of KINDS) {
      const { stored, label } = FIELDS[kind];
      const { field, conflict } = entry[kind];
      const saved = stored(state, accountId);
      const kept = Object.hasOwn(drafts[kind] ?? {}, accountId) && drafts[kind][accountId] !== saved;
      const value = kept ? drafts[kind][accountId] : saved;
      field.value = value === null ? "" : String(value);
      conflict.textContent = kept && saved !== stored(prior, accountId) ? "线上已改为 " + label(saved) : "";
      field.removeAttribute("aria-invalid");
    }
    entry.alias.field.disabled = !aliasesSupported(state);
  }
  current = state;
  aliasNotice.hidden = aliasesSupported(state);
  rosterStatus.textContent = entries.size + " 名玩家 · " + count("mmr") + " 人填了天梯分" +
    (aliasesSupported(state) ? " · " + count("alias") + " 人填了称呼" : "");
}

function collectChanges() {
  const changes = { alias: {}, mmr: {} };
  const invalid = [];
  for (const [accountId, entry] of entries) {
    let rowChanged = false;
    for (const kind of KINDS) {
      const { valid, value } = FIELDS[kind].parse(entry[kind].field.value);
      const changed = !valid || value !== FIELDS[kind].stored(current, accountId);
      rowChanged ||= changed;
      if (!valid) invalid.push({ entry, kind });
      else if (changed) changes[kind][accountId] = value;
    }
    entry.row.classList.toggle("is-pending", rowChanged);
  }
  return { changes, invalid };
}

function renderPending() {
  const { changes, invalid } = collectChanges();
  const count = Object.keys(changes.alias).length + Object.keys(changes.mmr).length + invalid.length;
  pending.textContent = count + " 项待保存";
  save.disabled = saving || !current || count === 0;
  save.textContent = saving ? "正在保存…" : "保存改动";
  for (const entry of entries.values()) {
    for (const kind of KINDS) entry[kind].field.readOnly = saving;
  }
}

function filterPlayers() {
  const query = search.value.trim().normalize("NFKC").toLowerCase();
  let shown = 0;
  for (const { row, haystack, alias } of entries.values()) {
    row.hidden = !(haystack + " " + alias.field.value).normalize("NFKC").toLowerCase().includes(query);
    if (!row.hidden) shown++;
  }
  noMatches.hidden = shown > 0;
}

function makeField(kind, player, options) {
  const entry = make("div", "mmr-entry");
  const field = make("input", "mmr-input");
  field.type = "text";
  field.autocomplete = "off";
  field.id = kind + "-" + player.accountId;
  field.name = kind + "-" + player.accountId;
  Object.assign(field, options);
  const conflict = make("small", "mmr-conflict");
  conflict.id = field.id + "-conflict";
  field.setAttribute("aria-describedby", conflict.id);
  entry.append(field, conflict);
  return { entry, field, conflict };
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
  const who = player.name + "（" + player.accountId + "）";
  const alias = makeField("alias", player, { placeholder: "尊姓大名？", maxLength: MAX_ALIAS_CHARS * 2 });
  alias.field.setAttribute("aria-label", who + "的称呼");
  const mmr = makeField("mmr", player, { placeholder: "未填写", inputMode: "numeric" });
  mmr.field.setAttribute("aria-label", who + "的天梯 MMR");
  row.append(identity, rank, alias.entry, mmr.entry);
  entries.set(player.accountId, { row, alias, mmr, haystack: player.name + " " + player.accountId });
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
    const { entry, kind } = invalid[0];
    if (entry.row.hidden) {
      search.value = "";
      filterPlayers();
    }
    entry[kind].field.setAttribute("aria-invalid", "true");
    entry[kind].field.focus();
    report(FIELDS[kind].invalid, true);
    return;
  }
  if (!Object.keys(changes.alias).length && !Object.keys(changes.mmr).length) return;

  saving = true;
  renderPending();
  report("");
  try {
    const result = await saveSharedMmr(current.revision, changes.mmr, changes.alias);
    applyState(result.state, result.conflict ? changes : {});
    const left = collectChanges().changes;
    const stillPending = Object.keys(left.alias).length + Object.keys(left.mmr).length > 0;
    if (result.conflict && stillPending) {
      report("已读取其他访客的更新。你的修改还在，请核对后再保存。", true);
    } else {
      report("已保存。刷新页面即可看到新称呼，平衡分队会读取最新天梯分。");
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
