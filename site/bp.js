import { heroPool, metaEdge, overallEdge, suggestBp } from "./bp-model.js?v=3";
import {
  attachPositionRatings, balancedSplit, buildLeagueRoster, calibrateModel, forecastTeams, POSITION_NAMES, teamLineup,
} from "./matchmaker-model.js?v=12";
import { loadSharedMmr } from "./shared-mmr.js?v=4";

const form = document.querySelector("#bpForm");
const inputs = document.querySelector("#bpInputs");
const status = document.querySelector("#bpStatus");
const selection = document.querySelector("#bpSelection");
const submit = document.querySelector("#bpSubmit");
const balance = document.querySelector("#bpBalance");
const search = document.querySelector("#bpSearch");
const rosterList = document.querySelector("#bpRoster");
const noMatches = document.querySelector("#bpNoMatches");
const forecastBox = document.querySelector("#bpForecast");
const poolsSection = document.querySelector("#bpPools");
const poolsTitle = document.querySelector("#bpPoolsTitle");
const poolColumns = document.querySelector("#bpPoolColumns");
const adviceSection = document.querySelector("#bpAdvice");
const adviceColumns = document.querySelector("#bpAdviceColumns");
const metaNote = document.querySelector("#bpMetaNote");
const sides = ["A", "B"];
const teamNames = { A: "甲队", B: "乙队" };
const TEAM_SIZE = 5;
// Account ID → "A" or "B", in the order players were added.
const assigned = new Map();
const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const wholePercent = new Intl.NumberFormat("zh-CN", { style: "percent" });
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 1 });
const decimal = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const onePercent = new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const SIGNATURES = 5;
// A hero this many points above 50% at a position counts as strong in the patch.
const STRONG_PATCH = 2;

let roster = [];
let playersById = new Map();
let scale;
let positionStats = null;
let heroMeta = null;
let heroNames = {};

function make(tag, className, text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

const heroName = (id) => heroNames[id]?.name ?? `英雄 ${id}`;

function heroIcon(id) {
  const image = make("img", "draft-hero-img");
  Object.assign(image, { src: `./img/heroes/${id}.webp`, alt: heroName(id), title: heroName(id), loading: "lazy" });
  return image;
}

// The patch numbers behind a hero's edge: STRATZ at the position and OpenDota over all positions.
function metaText(hero, position) {
  if (metaEdge(heroMeta, hero, position) === null) return "";
  const record = heroMeta?.positions?.[position]?.[hero];
  const overall = overallEdge(heroMeta, hero) === null ? null : heroMeta.overall[hero];
  const parts = [];
  if (record) parts.push(`STRATZ ${position} 号位 ${onePercent.format(record[1] / record[0])}（${integer.format(record[0])} 场）`);
  if (overall) parts.push(`OpenDota 整体 ${onePercent.format(overall[1] / overall[0])}（${integer.format(overall[0])} 场）`);
  return parts.length ? `版本胜率：${parts.join("，")}` : "";
}

function chosen(side) {
  return [...assigned].filter(([, team]) => team === side).map(([id]) => playersById.get(id));
}

const count = (side) => chosen(side).length;

function assign(id, side) {
  if (side && count(side) >= TEAM_SIZE && assigned.get(id) !== side) return;
  if (side) assigned.set(id, side);
  else assigned.delete(id);
  hideResults();
  renderSelection();
}

function teamChip(player, side) {
  const chip = make("button", `draft-chip bp-chip bp-chip-${side}`, `${player.name} ×`);
  chip.type = "button";
  chip.dataset.remove = String(player.accountId);
  chip.title = `MMR ${integer.format(player.rating)}，点一下移出${teamNames[side]}`;
  chip.setAttribute("aria-label", `把 ${player.name} 移出${teamNames[side]}`);
  return chip;
}

function renderSelection() {
  const total = assigned.size;
  for (const side of sides) {
    const members = chosen(side);
    document.querySelector(`#bpCount${side}`).textContent = `${members.length} / ${TEAM_SIZE}`;
    const slots = members.map((player) => teamChip(player, side));
    for (let index = members.length; index < TEAM_SIZE; index += 1) slots.push(make("span", "bp-empty-slot", "空位"));
    document.querySelector(`#bpTeam${side}`).replaceChildren(...slots);
  }
  for (const row of rosterList.querySelectorAll(".bp-roster-row")) {
    const side = assigned.get(Number(row.dataset.id));
    row.classList.toggle("bp-in-A", side === "A");
    row.classList.toggle("bp-in-B", side === "B");
    const checkbox = row.querySelector("input");
    checkbox.checked = Boolean(side);
    checkbox.disabled = !side && total >= TEAM_SIZE * 2;
    row.classList.toggle("bp-row-disabled", checkbox.disabled);
    for (const button of row.querySelectorAll("button[data-side]")) {
      const target = button.dataset.side;
      button.hidden = !side;
      button.setAttribute("aria-pressed", String(side === target));
      button.disabled = side !== target && count(target) >= TEAM_SIZE;
      button.title = button.disabled ? `${teamNames[target]}已满 ${TEAM_SIZE} 人，先移出一人` : `放到${teamNames[target]}`;
    }
  }
  const [a, b] = sides.map(count);
  selection.textContent = `甲队 ${a} / ${TEAM_SIZE} · 乙队 ${b} / ${TEAM_SIZE}`;
  submit.disabled = a !== TEAM_SIZE || b !== TEAM_SIZE;
  balance.disabled = total !== TEAM_SIZE * 2;
}

function renderRoster() {
  const query = search.value.trim().normalize("NFKC").toLowerCase();
  const visible = roster.filter((player) => !query || player.name.normalize("NFKC").toLowerCase().includes(query) ||
    String(player.accountId).includes(query));
  const rows = visible.map((player) => {
    const row = make("div", "draft-player bp-roster-row");
    row.dataset.id = String(player.accountId);
    const label = make("label", "bp-roster-label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = player.accountId;
    checkbox.setAttribute("aria-label", `${player.name}（${player.accountId}）`);
    const info = make("span", "draft-player-info");
    const name = make("span", "draft-player-name", player.name);
    name.title = player.name;
    info.append(name, make("small", "draft-player-id", `${player.accountId} · MMR ${integer.format(player.rating)}`));
    label.append(checkbox, info);
    const toggle = make("span", "bp-side-toggle");
    toggle.setAttribute("role", "group");
    toggle.setAttribute("aria-label", `${player.name} 的队伍`);
    for (const side of sides) {
      const button = make("button", `bp-side-button bp-side-button-${side}`, side === "A" ? "甲" : "乙");
      button.type = "button";
      button.dataset.side = side;
      toggle.append(button);
    }
    row.append(label, toggle);
    return row;
  });
  rosterList.replaceChildren(...rows);
  noMatches.hidden = visible.length > 0;
  renderSelection();
}

function hideResults() {
  poolsSection.hidden = true;
  adviceSection.hidden = true;
}

// Re-split the ten chosen players into the most even teams, keeping as many players on their side as possible.
function balanceTeams() {
  const players = [...assigned.keys()].map((id) => playersById.get(id));
  const plan = balancedSplit(players, { scale, positions: Boolean(positionStats) });
  const stay = plan.teamA.filter((player) => assigned.get(player.accountId) === "A").length;
  const [toA, toB] = stay >= 3 ? [plan.teamA, plan.teamB] : [plan.teamB, plan.teamA];
  assigned.clear();
  for (const player of toA) assigned.set(player.accountId, "A");
  for (const player of toB) assigned.set(player.accountId, "B");
  hideResults();
  renderSelection();
}

// ---------- 双方绝活 ----------

function lineupOf(side) {
  return teamLineup(chosen(side)).map((slot) => ({
    player: slot.player, position: slot.position, rating: slot.rating, rare: slot.rare,
    record: positionStats?.players?.[slot.player.accountId] ?? null,
  }));
}

function poolColumn(side, lineup) {
  const column = make("div", `bp-column bp-side-${side}`);
  column.append(make("h3", "bp-column-title", teamNames[side]));
  for (const member of lineup) {
    const row = make("article", "bp-player");
    const head = make("div", "bp-player-head");
    head.append(make("span", "bp-position", `${member.position} ${POSITION_NAMES[member.position]}`),
      make("strong", "bp-player-name", member.player.name), make("small", "draft-meta", `${integer.format(member.rating)}${member.rare ? " · 少打" : ""}`));
    row.append(head);
    const heroes = heroPool(member.record, member.position, heroMeta).filter((entry) => entry.here > 0).slice(0, SIGNATURES);
    const list = make("div", "bp-signatures");
    if (!heroes.length) list.append(make("small", "draft-meta", member.record ? "这个号位近一年没有常规比赛" : "没有常规比赛数据"));
    for (const entry of heroes) {
      const item = make("span", `bp-signature${(entry.meta ?? 0) >= STRONG_PATCH ? " strong" : ""}`);
      item.title = `${heroName(entry.hero)}：${member.position} 号位 ${entry.here} 场，胜 ${entry.hereWins} 场。${metaText(entry.hero, member.position)}`;
      item.append(heroIcon(entry.hero), make("small", "", `${entry.here} 场 ${wholePercent.format(entry.hereWins / entry.here)}`));
      if ((entry.meta ?? 0) >= STRONG_PATCH) item.append(make("b", "", "版本强"));
      list.append(item);
    }
    row.append(list);
    column.append(row);
  }
  return column;
}

// ---------- BP 建议 ----------

const who = (member) => `${member.player.name}（${member.position} 号位）`;
const playerRecord = (entry) => `${Math.round(entry.games)} 场 ${wholePercent.format(entry.wins / entry.games)}`;

function adviceItem(kind, item) {
  const row = make("li", "bp-hero");
  const name = make("strong", "", heroName(item.hero));
  const reasons = make("span", "bp-reasons");
  const lines = [];
  if (kind === "ban") {
    if (item.target) lines.push(`针对 ${who(item.target)}：${playerRecord(item.entry)}`);
    if (item.also) lines.push(`${item.also.player.name} 也会玩`);
    const patch = item.target ? metaText(item.hero, item.target.position) : item.patch ? metaText(item.hero, item.patch.position ?? "1") : "";
    if (patch) lines.push((item.target ? "" : "版本强势：") + patch);
  } else {
    lines.push(`给 ${who(item.for)}：${playerRecord(item.entry)}`);
    const patch = metaText(item.hero, item.for.position);
    if (patch) lines.push(patch);
    if (item.denies) lines.push(`也是 ${item.denies.player.name} 的英雄，先拿下`);
  }
  if (item.contested) row.classList.add("contested");
  for (const line of lines) reasons.append(make("span", "", line));
  const score = make("em", "bp-score", item.score.toFixed(1));
  score.title = "推荐分（胜率百分点）";
  row.append(heroIcon(item.hero), make("span", "bp-hero-text"), score);
  if (item.contested) name.append(make("b", "bp-contested", "两边都想要"));
  row.children[1].append(name, reasons);
  return row;
}

function adviceList(title, kind, items) {
  const block = make("div", `bp-tiers bp-${kind}`);
  block.append(make("h4", "", `${title}（${items.length}）`));
  if (!items.length) {
    block.append(make("p", "draft-meta", "没有达到推荐分的英雄。"));
    return block;
  }
  const list = make("ol", "bp-hero-list");
  list.append(...items.map((item) => adviceItem(kind, item)));
  block.append(list);
  return block;
}

function adviceColumn(side, own, enemy) {
  const { bans, picks } = suggestBp(own, enemy, heroMeta);
  const column = make("div", `bp-column bp-side-${side}`);
  column.append(make("h3", "bp-column-title", `${teamNames[side]}的立场`),
    adviceList("优先 Ban", "ban", bans), adviceList("优先 Pick", "pick", picks));
  return column;
}

function renderForecast() {
  const result = forecastTeams(chosen("A"), chosen("B"), { scale, positions: Boolean(positionStats) });
  const line = make("div", "draft-forecast");
  line.append(make("strong", "", `甲队 ${percent.format(result.winChanceA)}`), make("span", "", "预计胜率"),
    make("strong", "", `乙队 ${percent.format(1 - result.winChanceA)}`));
  const bar = make("div", "draft-odds");
  bar.style.setProperty("--team-a-odds", `${result.winChanceA * 100}%`);
  bar.setAttribute("aria-hidden", "true");
  const label = positionStats ? "阵容 MMR" : "平均 MMR";
  const scores = make("p", "draft-meta draft-pick-scores",
    `${label}：甲队 ${decimal.format(result.averageA)} · 乙队 ${decimal.format(result.averageB)}`);
  forecastBox.replaceChildren(line, bar, scores);
}

function calculate() {
  renderForecast();
  const lineups = { A: lineupOf("A"), B: lineupOf("B") };
  poolColumns.replaceChildren(poolColumn("A", lineups.A), poolColumn("B", lineups.B));
  adviceColumns.replaceChildren(adviceColumn("A", lineups.A, lineups.B), adviceColumn("B", lineups.B, lineups.A));
  const updated = (key) => heroMeta?.[key]?.slice(0, 10) ?? "无";
  metaNote.textContent = heroMeta
    ? `版本数据：${heroMeta.bracket_label ?? "高分段"}，STRATZ 最近 2 周分号位胜率（${updated("positions_updated_utc")} 更新）和 OpenDota 整体胜率（${updated("overall_updated_utc")} 更新）综合。先看甲队立场，再看乙队立场。同一英雄可以同时在 ban 和 pick 里：标“两边都想要”的，先 ban 掉或用一选拿下。`
    : "版本数据读取失败，只按双方的英雄池推荐。";
  poolsSection.hidden = false;
  adviceSection.hidden = false;
  const params = new URLSearchParams({ a: chosen("A").map((player) => player.accountId).join(","), b: chosen("B").map((player) => player.accountId).join(",") });
  history.replaceState(null, "", `?${params}`);
  poolsTitle.focus({ preventScroll: true });
  poolsSection.scrollIntoView({ block: "start" });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!submit.disabled) calculate();
});

rosterList.addEventListener("change", ({ target }) => {
  const id = Number(target.value);
  if (!playersById.has(id)) return;
  if (!target.checked) return assign(id, null);
  const side = count("A") < TEAM_SIZE ? "A" : count("B") < TEAM_SIZE ? "B" : null;
  if (side) assign(id, side);
  else renderSelection();
});

rosterList.addEventListener("click", ({ target }) => {
  const button = target.closest("button[data-side]");
  if (button) assign(Number(button.closest(".bp-roster-row").dataset.id), button.dataset.side);
});

for (const side of sides) {
  document.querySelector(`#bpTeam${side}`).addEventListener("click", ({ target }) => {
    const chip = target.closest("button[data-remove]");
    if (!chip) return;
    const id = Number(chip.dataset.remove);
    assign(id, null);
    (rosterList.querySelector(`input[value="${id}"]`) ?? search).focus();
  });
}

search.addEventListener("input", renderRoster);
balance.addEventListener("click", balanceTeams);

// ---------- 数据 ----------

async function readJson(path) {
  try {
    const response = await fetch(path);
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await response.json();
  } catch (error) {
    console.error(`Could not read ${path}`, error);
    return null;
  }
}

// Teams passed in the address, e.g. from the draft tool: ?a=id,id,…&b=id,id,…
function readPreset() {
  const params = new URLSearchParams(location.search);
  for (const side of sides) {
    const ids = (params.get(side.toLowerCase()) ?? "").split(",").map(Number).filter((id) => playersById.has(id) && !assigned.has(id));
    for (const id of ids.slice(0, TEAM_SIZE)) assigned.set(id, side);
  }
}

async function load() {
  const [snapshot, stats, meta, names, shared] = await Promise.all([
    readJson("./data/league.json"), readJson("./data/position-stats.json"), readJson("./data/hero-meta.json"),
    readJson("./data/names.json"), loadSharedMmr().catch((error) => (console.error("Could not read shared MMR", error), null)),
  ]);
  if (!snapshot) {
    status.textContent = "联赛数据读取失败，请刷新页面重试。";
    return;
  }
  positionStats = stats;
  heroMeta = meta;
  heroNames = names?.heroes ?? {};
  const named = { ...snapshot, player_names: { ...snapshot.player_names, ...shared?.aliases } };
  const ratings = shared?.ratings ?? {};
  const model = calibrateModel(named, ratings).applied;
  scale = model.scale;
  roster = attachPositionRatings(buildLeagueRoster(named, ratings, model).filter((player) => Number.isFinite(player.rating)), stats?.players)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.accountId - right.accountId);
  playersById = new Map(roster.map((player) => [player.accountId, player]));
  readPreset();
  renderRoster();
  inputs.disabled = false;
  status.textContent = `${roster.length} 名可选玩家 · ` +
    (stats ? `英雄池 ${stats.generated_at_utc.slice(0, 10)} 更新` : "英雄池读取失败") + " · " +
    (meta ? `版本数据 ${meta.generated_at_utc.slice(0, 10)} 更新` : "版本数据读取失败");
  if (!submit.disabled) calculate();
}

load();
