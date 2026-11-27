import { heroPool, metaEdge, overallEdge, suggestBp } from "./bp-model.js?v=3";
import { POSITION_NAMES, rateLeague, teamLineup } from "./matchmaker-model.js?v=11";
import { loadSharedMmr } from "./shared-mmr.js?v=4";

const form = document.querySelector("#bpForm");
const inputs = document.querySelector("#bpInputs");
const status = document.querySelector("#bpStatus");
const selection = document.querySelector("#bpSelection");
const submit = document.querySelector("#bpSubmit");
const poolsSection = document.querySelector("#bpPools");
const poolsTitle = document.querySelector("#bpPoolsTitle");
const poolColumns = document.querySelector("#bpPoolColumns");
const adviceSection = document.querySelector("#bpAdvice");
const adviceColumns = document.querySelector("#bpAdviceColumns");
const metaNote = document.querySelector("#bpMetaNote");
const sides = ["A", "B"];
const teamNames = { A: "甲队", B: "乙队" };
const fields = { A: [], B: [] };
const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const wholePercent = new Intl.NumberFormat("zh-CN", { style: "percent" });
const onePercent = new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const SIGNATURES = 5;
// A hero this many points above 50% at a position counts as strong in the patch.
const STRONG_PATCH = 2;

let playersById = new Map();
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
  return fields[side].map((field) => playersById.get(Number(field.value))).filter(Boolean);
}

function renderSelection() {
  const picked = new Set([...fields.A, ...fields.B].map((field) => field.value).filter(Boolean));
  for (const field of [...fields.A, ...fields.B]) {
    for (const option of field.options) option.disabled = option.value !== "" && option.value !== field.value && picked.has(option.value);
  }
  const [a, b] = sides.map((side) => chosen(side).length);
  selection.textContent = `甲队 ${a} / 5 · 乙队 ${b} / 5`;
  submit.disabled = a !== 5 || b !== 5;
}

function hideResults() {
  poolsSection.hidden = true;
  adviceSection.hidden = true;
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
    if (!heroes.length) list.append(make("small", "draft-meta", member.record ? "这个号位近一年没有公开比赛" : "没有公开比赛数据"));
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

function calculate() {
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

form.addEventListener("change", () => {
  hideResults();
  renderSelection();
});

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

function buildFields(roster) {
  const params = new URLSearchParams(location.search);
  for (const side of sides) {
    const container = document.querySelector(`#bpTeam${side}`);
    const preset = (params.get(side.toLowerCase()) ?? "").split(",").map(Number).filter((id) => playersById.has(id));
    fields[side] = Array.from({ length: 5 }, (_, index) => {
      const select = document.createElement("select");
      select.setAttribute("aria-label", `${teamNames[side]}第 ${index + 1} 人`);
      select.append(new Option(`第 ${index + 1} 人`, ""), ...roster.map((player) => new Option(`${player.name} · ${integer.format(player.rating)}`, player.accountId)));
      select.value = preset[index] ? String(preset[index]) : "";
      return select;
    });
    container.replaceChildren(...fields[side]);
  }
  renderSelection();
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
  const roster = rateLeague(named, shared?.ratings ?? {}, stats)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.accountId - right.accountId);
  playersById = new Map(roster.map((player) => [player.accountId, player]));
  buildFields(roster);
  inputs.disabled = false;
  status.textContent = `${roster.length} 名可选玩家 · ` +
    (stats ? `英雄池 ${stats.generated_at_utc.slice(0, 10)} 更新` : "英雄池读取失败") + " · " +
    (meta ? `版本数据 ${meta.generated_at_utc.slice(0, 10)} 更新` : "版本数据读取失败");
  if (!submit.disabled) calculate();
}

load();
