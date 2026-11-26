// Data, scoring and components shared by the stats list, match and player pages.

import { estimateImp } from "./imp-model.js?v=4";
import { loadPlayerAliases } from "./shared-mmr.js?v=4";

const DAY_SECONDS = 86400;
const MIN_RATE_GAMES = 5;

const state = {
  matches: [],
  names: {},
  heroes: {},
  items: {},
  min: 0,
  max: 0,
  from: 0,
  to: 0,
  sort: {},
  // Each page sets this so sortable tables can redraw it.
  rerender: () => {},
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

const hero = (id) => state.heroes[id] || { name: `英雄 ${id}` };
const item = (key) => state.items[key] || { name: key };
const playerName = (id) => state.names[id] || `Account ${id}`;
const isRadiant = (player) => player.slot < 128;
const won = (match, player) => isRadiant(player) === match.radiant_win;
const minutes = (seconds) => `${Math.round(seconds / 60)}′`;

function picture(src, alt, className) {
  const image = el("img", { class: className, src, alt, title: alt, loading: "lazy" });
  image.addEventListener("error", () => image.replaceWith(el("span", { class: `${className} fallback`, title: alt }, alt.slice(0, 2))));
  return image;
}

const heroIcon = (id) => picture(`./img/heroes/${id}.webp`, hero(id).name, "hero-img");
const itemIcon = (key) => picture(`./img/items/${key}.webp`, item(key).name, "item-img");
const heroLabel = (id) => el("span", { class: "icon-label" }, heroIcon(id), hero(id).name);
const itemLabel = (key) => el("span", { class: "icon-label" }, itemIcon(key), item(key).name);
const matchHref = (id) => `./match.html?id=${id}`;
const playerHref = (id, range = null) => `./player.html?${new URLSearchParams({ id, ...(range || {}) })}`;
const playerLink = (id) =>
  id ? el("a", { href: playerHref(id), class: "player-link" }, playerName(id)) : "匿名";

function formatDate(seconds) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(seconds * 1000));
}

function formatDuration(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function dateInput(seconds) {
  return new Date((seconds + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

function record(wins, games) {
  return `${wins}胜${games - wins}负`;
}

function rate(wins, games) {
  return games >= MIN_RATE_GAMES ? `${Math.round((wins / games) * 100)}%` : "—";
}

const smoothed = (wins, games) => (wins + 1) / (games + 2);
const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");
const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
const kda = (rows) => {
  const kills = average(rows.map((row) => row.k ?? 0));
  const deaths = average(rows.map((row) => row.d ?? 0));
  const assists = average(rows.map((row) => row.a ?? 0));
  return { text: `${kills.toFixed(1)} / ${deaths.toFixed(1)} / ${assists.toFixed(1)}`, ratio: (kills + assists) / Math.max(1, deaths) };
};

function sortableTable(id, columns, rows, defaultKey) {
  const sort = state.sort[id] || { key: defaultKey, dir: -1 };
  const column = columns.find((entry) => entry.key === sort.key) || columns[0];
  const sorted = [...rows].sort((left, right) => {
    const a = column.value(left);
    const b = column.value(right);
    return (a > b ? 1 : a < b ? -1 : 0) * sort.dir;
  });
  const head = columns.map((entry) => {
    const active = entry.key === sort.key;
    const label = entry.label + (active ? (sort.dir < 0 ? " ▾" : " ▴") : "");
    if (entry.sortable === false) return el("th", { scope: "col" }, entry.label);
    return el(
      "th",
      { scope: "col", "aria-sort": active ? (sort.dir < 0 ? "descending" : "ascending") : null },
      el("button", {
        type: "button",
        class: "sort-button",
        onclick: () => {
          state.sort[id] = { key: entry.key, dir: active ? -sort.dir : -1 };
          state.rerender();
        },
      }, label),
    );
  });
  return el(
    "div", { class: "table-scroll" },
    el(
      "table", { class: "data-table" },
      el("thead", {}, el("tr", {}, head)),
      el("tbody", {}, sorted.map((row) =>
        el("tr", {}, columns.map((entry) => el("td", { class: entry.align || "" }, entry.render ? entry.render(row) : entry.value(row))))
      )),
    ),
  );
}

function section(title, note, ...content) {
  return el("div", { class: "stats-section" }, el("h2", {}, title), note ? el("p", { class: "draft-meta" }, note) : null, content);
}

function statCard(label, value, sub) {
  return el("div", { class: "stat-card" }, el("span", {}, label), el("strong", {}, value), sub ? el("small", {}, sub) : null);
}

function visibleMatches() {
  return state.matches.filter((match) => match.start_time >= state.from && match.start_time <= state.to);
}

function playerRow(match, player) {
  return el("div", { class: `player-row${isMvp(match, player) ? " is-mvp" : ""}` },
    el("span", { class: "pr-hero" }, heroIcon(player.hero),
      player.pos ? el("i", { class: "pr-pos", title: `${player.pos} 号位` }, player.pos) : null),
    el("span", { class: "pr-who" },
      el("span", { class: "pr-name" }, playerLink(player.account_id)),
      el("span", { class: "pr-sub" }, hero(player.hero).name)),
    el("span", { class: "pr-kda", title: "击杀 / 死亡 / 助攻" },
      el("b", { class: "k" }, player.k ?? 0), "/", el("b", { class: "d" }, player.d ?? 0), "/", el("b", { class: "a" }, player.a ?? 0)),
    el("span", { class: "pr-score", title: scoreTip(player) }, gradeBadge(player), el("b", {}, scoreText(player.score))),
    el("span", { class: "pr-nw", title: `净值 ${(player.nw ?? 0).toLocaleString()} · GPM ${player.gpm ?? "—"}` },
      player.nw ? `${(player.nw / 1000).toFixed(1)}k` : "—"),
    el("span", { class: "pr-bottom" },
      el("span", { class: "pr-items" },
        Array.from({ length: 6 }, (_, slot) => (player.items[slot] ? itemIcon(player.items[slot]) : el("span", { class: "item-img empty" }))),
        el("span", { class: "pr-neutral" }, player.neutral ? itemIcon(player.neutral) : el("span", { class: "item-img empty" }))),
      el("span", { class: "pr-titles" }, (player.titles || []).map((name) => titleChip(name)))));
}

function teamPanel(match, radiant) {
  const players = match.players.filter((player) => isRadiant(player) === radiant);
  const teamWon = radiant === match.radiant_win;
  const worth = players.reduce((sum, player) => sum + (player.nw ?? 0), 0);
  return el("div", { class: `team-panel ${radiant ? "radiant" : "dire"}${teamWon ? " won" : ""}` },
    el("div", { class: "team-head" },
      el("b", {}, radiant ? "天辉" : "夜魇"),
      el("span", { class: teamWon ? "result win" : "result" }, teamWon ? "胜" : "负"),
      el("small", {}, `击杀 ${radiant ? match.radiant_score : match.dire_score} · 总净值 ${(worth / 1000).toFixed(1)}k`)),
    el("div", { class: "team-cols", "aria-hidden": "true" },
      el("span", { class: "pr-hero" }, "英雄"), el("span", { class: "pr-who" }, "选手"), el("span", { class: "pr-kda" }, "K/D/A"),
      el("span", { class: "pr-score" }, "评分"), el("span", { class: "pr-nw" }, "净值")),
    players.map((player) => playerRow(match, player)));
}

// ---------- 综合评分 ----------

// Six 0-100 dimensions. Cores and supports read different stats on each axis, because
// in-house supports give up farm: compared with public players on the same hero they sit
// near the 30th percentile for gold, XP and last hits but near normal for assists and damage.
const DIMENSIONS = [
  { key: "econ", label: "经济/助攻", tip: "核心：GPM；辅助：每分钟助攻（OpenDota 同英雄百分位）" },
  { key: "farm", label: "正补/视野", tip: "核心：每分钟正补（OpenDota 同英雄百分位）；辅助：插眼数在联赛辅助中的百分位" },
  { key: "dmg", label: "输出", tip: "每分钟英雄伤害（OpenDota 同英雄百分位）" },
  { key: "push", label: "推进/控制", tip: "核心：建筑伤害（OpenDota 同英雄百分位）；辅助：控制时长在联赛辅助中的百分位" },
  { key: "surv", label: "生存", tip: "每分钟死亡，死得越少越高（OpenDota 同英雄百分位）" },
  { key: "kill", label: "击杀", tip: "每分钟击杀（OpenDota 同英雄百分位）" },
];
// IMP from STRATZ compares a player with others on the same hero and position in the match's
// rank bracket; 0 is an average game. The score, grades and MVP come from it; the six dimensions
// above only describe playing style. Matches STRATZ never scores use imp-model.js's estimate.
//
// The 0-100 score starts from a split normal CDF: 100·Φ(IMP / 20) at or above 0 and 100·Φ(IMP / 30)
// below. League IMP is close to normal around STRATZ's 0 (130 players: mean −3.9, SD 19.3, skew 0.07;
// a normal with SD 20 is within 0.042 of its CDF), so the upper half reads as the share of same-bracket
// games an IMP beats; the wider lower half keeps poor games out of single digits. On top of that
// every score gets +10, tapering to nothing at the top so it never passes 100: below 0 the score is
// 10 + 100·Φ(IMP / 30) (10-60), from 0 up it is 60 + 80·(Φ(IMP / 20) − 0.5) (60-100).
// Grades are fixed score bands, which are fixed IMP cut-offs: S ≥ 92 (+25.6), A ≥ 80 (+13.5),
// B ≥ 60 (0), C ≥ 40 (−15.7).
const IMP_SD_ABOVE = 20;
const IMP_SD_BELOW = 30;
const IMP_TIP = "评分由 STRATZ IMP 换算：IMP 比较同段位、同英雄、同号位的玩家，0 为平均，对应 60 分；高于平均按标准差 20 的正态换算并逐渐逼近 100，低于平均按标准差 30 放缓扣分，最低约 10 分";
const SMVP_IMP = 30;
const GRADES = [["S", 92], ["A", 80], ["B", 60], ["C", 40], ["D", -Infinity]];

// Standard normal CDF (Abramowitz and Stegun 7.1.26, error below 1.5e-7).
function normalCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
function scoreOfImp(imp) {
  if (!Number.isFinite(imp)) return null;
  return imp < 0 ? 10 + 100 * normalCdf(imp / IMP_SD_BELOW) : 60 + 80 * (normalCdf(imp / IMP_SD_ABOVE) - 0.5);
}
const TITLE_LIMIT = 4;

const isSupport = (player) => player.pos === 4 || player.pos === 5;
const wardsOf = (player) => (Number.isFinite(player.obs) ? player.obs + (player.sen ?? 0) : null);
// Graded on the score as displayed, so a shown 92 is always S.
const gradeOf = (score) => (Number.isFinite(score) ? GRADES.find(([, floor]) => Math.round(score) >= floor)[0] : null);

function meanOf(values) {
  const list = values.filter(Number.isFinite);
  return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
}

function percentileRank(value, sorted) {
  if (!Number.isFinite(value) || !sorted.length) return null;
  let below = 0;
  let equal = 0;
  for (const other of sorted) {
    if (other < value) below += 1;
    else if (other === value) equal += 1;
  }
  return Math.round(((below + equal / 2) / sorted.length) * 100);
}

function computeScores() {
  const players = state.matches.flatMap((match) => match.players);
  const supports = players.filter(isSupport);
  const sorted = (rows, pick) => rows.map(pick).filter(Number.isFinite).sort((a, b) => a - b);
  const pools = { wards: sorted(supports, wardsOf), stuns: sorted(supports, (player) => player.stuns) };
  for (const player of players) {
    const bm = player.bm;
    if (!bm) {
      player.dims = null;
      continue;
    }
    const support = isSupport(player);
    player.dims = {
      econ: support ? bm.apm : bm.gpm,
      farm: support ? percentileRank(wardsOf(player), pools.wards) : bm.lhm,
      dmg: bm.hdm,
      push: support ? percentileRank(player.stuns, pools.stuns) : bm.td,
      surv: bm.death,
      kill: bm.kpm,
    };
  }
  for (const player of players) {
    player.score = scoreOfImp(player.imp);
    player.grade = gradeOf(player.score);
  }
  for (const match of state.matches) {
    const winners = match.players.filter((player) => won(match, player) && Number.isFinite(player.imp));
    const best = winners.sort((a, b) => b.imp - a.imp)[0];
    match.mvp = best ? best.slot : null;
    match.smvp = Boolean(best && best.imp >= SMVP_IMP);
    // The lowest win chance the winners had, from STRATZ's per-minute Radiant win chance.
    const chances = match.win?.length ? match.win.map((chance) => (match.radiant_win ? chance : 100 - chance)) : null;
    match.comeback = chances && Math.min(...chances) <= COMEBACK_CHANCE ? Math.min(...chances) : null;
    match.loserPeak = chances ? 100 - Math.min(...chances) : null;
    assignTitles(match);
  }
}

const isMvp = (match, player) => match.mvp === player.slot;
const scoreText = (value) => (Number.isFinite(value) ? String(Math.round(value)) : "—");
const impText = (value) => (Number.isFinite(value) ? `${value > 0 ? "+" : ""}${Math.round(value)}` : "—");
const scoreTip = (player) => (!Number.isFinite(player.imp) ? "这场还没有 IMP"
  : player.impEstimated ? `估算 IMP ${impText(player.imp)}（STRATZ 没给这场 IMP，按本站模型估算） · ${IMP_TIP}`
    : `IMP ${impText(player.imp)} · ${IMP_TIP}`);
const gradeBadge = (player) => (player.grade
  ? el("span", { class: `grade grade-${player.grade}`, title: `评级 ${player.grade}：S ≥ 92（IMP ≥ +25.6），A ≥ 80（+13.5），B ≥ 60（0），C ≥ 40（−15.7），其余 D` }, player.grade)
  : null);
// A match is a comeback when the winners' win chance dropped to this percentage or lower.
const COMEBACK_CHANCE = 20;
const comebackTag = (match) => (match.comeback === null || match.comeback === undefined ? null
  : el("span", { class: "match-tag comeback", title: `胜方胜率曾跌到 ${match.comeback}%（STRATZ 每分钟胜率预测，≤ ${COMEBACK_CHANCE}% 算翻盘）` }, "翻盘"));
// Shown beside the duration when this match's IMP comes from the local model instead of STRATZ.
const ESTIMATE_BASIS = {
  minute: "按 STRATZ 逐分钟数据与同英雄同号位平均曲线的对比估算",
  basic: "STRATZ 也没有这场的逐分钟数据，只按赛后数据估算，误差较大",
};
const estimateTag = (match) => (match.impSource === "est"
  ? el("span", { class: "match-tag estimate", title: `STRATZ 没给这场 IMP（有凯的比赛一律不评），本场 IMP、评分、评级和 MVP 由本站模型估算：${ESTIMATE_BASIS[match.impModel]}；STRATZ 补上后改用真实 IMP` }, "估算")
  : null);

// ---------- 本局称号 ----------

const teamOf = (match, player) => match.players.filter((other) => isRadiant(other) === isRadiant(player));
const rankIn = (group, player, value) => 1 + group.filter((other) => value(other) > value(player)).length;
const damageShare = (match, player) => (player.hd ?? 0) / Math.max(1, teamOf(match, player).reduce((sum, other) => sum + (other.hd ?? 0), 0));
const killShare = (match, player) => ((player.k ?? 0) + (player.a ?? 0)) / Math.max(1, isRadiant(player) ? match.radiant_score : match.dire_score);
const kdaOf = (player) => ((player.k ?? 0) + (player.a ?? 0)) / Math.max(1, player.d ?? 0);
const topOf = (match, player, value, floor = 0) => (value(player) ?? -Infinity) > floor - 1e-9 && Number.isFinite(value(player)) &&
  rankIn(match.players.filter((other) => Number.isFinite(value(other))), player, value) === 1;

// In priority order. Each title goes to at most one player per match: the most typical
// qualifier by `pick`, or the next one if that player already holds four titles.
const TITLES = [
  { name: "SMVP", tip: "胜方评分最高，且达到 95（IMP +30）", test: (m, p) => isMvp(m, p) && m.smvp, pick: () => 0 },
  { name: "MVP", tip: "胜方评分最高的人", test: (m, p) => isMvp(m, p) && !m.smvp, pick: () => 0 },
  { name: "带队翻盘", tip: "翻盘局里胜方评分最高的人（胜方胜率曾跌到 20% 以下）", test: (m, p) => m.comeback !== null && m.comeback !== undefined &&
    won(m, p) && Number.isFinite(p.imp) && rankIn(teamOf(m, p).filter((o) => Number.isFinite(o.imp)), p, (o) => o.imp) === 1, pick: (m, p) => p.imp },
  { name: "暴走", tip: "一波收下 4 个及以上人头", test: (m, p) => p.multi >= 4, pick: (m, p) => p.multi * 100 + p.k },
  { name: "超神", tip: "最高连杀达到 10", test: (m, p) => p.streak >= 10, pick: (m, p) => p.streak },
  { name: "钢丝C", tip: "输了的 1 号位，死了 9 次以上", test: (m, p) => !won(m, p) && p.pos === 1 && p.d >= 9, pick: (m, p) => p.d },
  { name: "刷了送", tip: "输了的 2、3 号位，经济本队前二，却死了 8 次以上", test: (m, p) => !won(m, p) && (p.pos === 2 || p.pos === 3) &&
    rankIn(teamOf(m, p), p, (o) => o.nw ?? 0) <= 2 && p.d >= 8, pick: (m, p) => p.d },
  { name: "我的", tip: "我的我的：本队胜率曾到 80% 以上却输了（没有胜率数据时看经济曾领先 4000 以上），本人是本队死得最多的", test: (m, p) => !won(m, p) &&
    (m.loserPeak !== null && m.loserPeak !== undefined ? m.loserPeak >= 80 : (m.max_lead?.[isRadiant(p) ? "radiant" : "dire"] ?? 0) >= 4000) &&
    rankIn(teamOf(m, p), p, (o) => o.d ?? 0) === 1, pick: (m, p) => p.d },
  { name: "打心底里佩服", tip: "赢了的 1 号位，输出不到本队 20%，参与击杀不到 50%", test: (m, p) => won(m, p) && p.pos === 1 &&
    damageShare(m, p) < 0.2 && killShare(m, p) < 0.5, pick: (m, p) => -damageShare(m, p) },
  { name: "抢盾", tip: "从对面手里抢走了不朽之守护", test: (m, p) => p.aegis_stolen >= 1, pick: (m, p) => p.aegis_stolen },
  { name: "拆", tip: "全场建筑伤害第一，且不少于 5000", test: (m, p) => topOf(m, p, (o) => o.td, 5000), pick: (m, p) => p.td },
  { name: "壕", tip: "全场净值第一", test: (m, p) => topOf(m, p, (o) => o.nw), pick: (m, p) => p.nw },
  { name: "就是干", tip: "全场英雄伤害第一", test: (m, p) => topOf(m, p, (o) => o.hd), pick: (m, p) => p.hd },
  { name: "奶", tip: "全场治疗第一，且不少于 3000", test: (m, p) => topOf(m, p, (o) => o.hh, 3000), pick: (m, p) => p.hh },
  { name: "肉", tip: "全场承受英雄伤害第一", test: (m, p) => topOf(m, p, (o) => o.taken, 1), pick: (m, p) => p.taken },
  { name: "控", tip: "全场控制时长第一", test: (m, p) => topOf(m, p, (o) => o.stuns, 0.1), pick: (m, p) => p.stuns },
  { name: "眼", tip: "全场插眼最多", test: (m, p) => topOf(m, p, wardsOf, 1), pick: (m, p) => wardsOf(p) },
  { name: "稳", tip: "死亡不超过 3 次，且 KDA 至少 5", test: (m, p) => p.d <= 3 && kdaOf(p) >= 5, pick: (m, p) => kdaOf(p) * 100 - p.d },
  { name: "浪", tip: "击杀至少 7 次，死亡也至少 8 次", test: (m, p) => p.d >= 8 && p.k >= 7, pick: (m, p) => p.d * 100 + p.k },
  { name: "躺", tip: "赢了，评分 D 级（低于 40）且在本队倒数前二", test: (m, p) => won(m, p) && p.grade === "D" &&
    rankIn(teamOf(m, p).filter((o) => Number.isFinite(o.imp)), p, (o) => o.imp) >= 4, pick: (m, p) => -p.imp },
  { name: "僵", tip: "团战参与率不到 50%，输出也不到本队 15%", test: (m, p) => Number.isFinite(p.tf) && p.tf < 0.5 && damageShare(m, p) < 0.15,
    pick: (m, p) => -(p.tf + damageShare(m, p)) },
  { name: "一血", tip: "拿下一血", test: (m, p) => p.fb === 1, pick: () => 0 },
];

function assignTitles(match) {
  for (const player of match.players) player.titles = [];
  for (const title of TITLES) {
    const candidates = match.players.filter((player) => title.test(match, player))
      .sort((a, b) => title.pick(match, b) - title.pick(match, a));
    const winner = candidates.find((player) => player.titles.length < TITLE_LIMIT &&
      !(title.name === "MVP" && player.titles.includes("SMVP")));
    if (winner) winner.titles.push(title.name);
  }
}

const TITLE_TIPS = Object.fromEntries(TITLES.map(({ name, tip }) => [name, tip]));
// Gold for honours, blue for "best in the match" stats, red for roasts.
const TITLE_KIND = {
  SMVP: "honor", MVP: "honor", 带队翻盘: "honor", 暴走: "honor", 超神: "honor", 抢盾: "honor", 稳: "honor",
  拆: "stat", 壕: "stat", 就是干: "stat", 奶: "stat", 肉: "stat", 控: "stat", 眼: "stat", 一血: "stat",
  钢丝C: "roast", 刷了送: "roast", 我的: "roast", 打心底里佩服: "roast", 躺: "roast", 僵: "roast", 浪: "roast",
};
const titleChip = (name, count = 0) => el("span", {
  class: `title-chip ${TITLE_KIND[name] || "stat"}${name.endsWith("MVP") ? " mvp" : ""}`,
  title: `【${name}】${TITLE_TIPS[name]}`,
}, count ? `${name} ×${count}` : name);

function averageDims(players) {
  return Object.fromEntries(DIMENSIONS.map(({ key }) => [key, meanOf(players.map((player) => player.dims?.[key]))]));
}

function radar(values, { size = 132, compare = null } = {}) {
  const center = size / 2;
  const radius = size / 2 - 20;
  const point = (index, value) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / DIMENSIONS.length;
    const length = (radius * Math.max(0, Math.min(100, value ?? 0))) / 100;
    return [center + length * Math.cos(angle), center + length * Math.sin(angle)];
  };
  const shape = (data) => DIMENSIONS.map(({ key }, index) => point(index, data[key]).map((n) => n.toFixed(1)).join(",")).join(" ");
  const rings = [25, 50, 75, 100].map((level) =>
    `<polygon points="${DIMENSIONS.map((_, index) => point(index, level).join(",")).join(" ")}" class="ring"/>`).join("");
  const labels = DIMENSIONS.map(({ label }, index) => {
    const [x, y] = point(index, 128);
    return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle">${label}</text>`;
  }).join("");
  const figure = el("span", { class: "radar" });
  figure.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="六项能力百分位">
    ${rings}${compare ? `<polygon points="${shape(compare)}" class="compare"/>` : ""}<polygon points="${shape(values)}" class="value"/>${labels}</svg>`;
  return figure;
}

const mvpBadge = (smvp = false) => el("span", { class: "mvp", title: TITLE_TIPS[smvp ? "SMVP" : "MVP"] }, smvp ? "SMVP" : "MVP");

// ---------- 选手 ----------

const LANE_ROLES = { 1: "优势路", 2: "中路", 3: "劣势路" };
const LANE_TEXT = { W: "优", D: "均", L: "劣" };

function winText(wins, games) {
  return games ? `${Math.round((wins / games) * 100)}%` : "—";
}

function laneSummary(games) {
  const rated = games.filter((game) => game.player.lane);
  const count = (result) => rated.filter((game) => game.player.lane === result).length;
  return { rated: rated.length, win: count("W"), draw: count("D"), loss: count("L") };
}

function averageOf(rows, key) {
  const values = rows.map((row) => row[key]).filter((value) => Number.isFinite(value));
  return values.length ? average(values) : null;
}

const rounded = (value) => (value === null ? "—" : Math.round(value).toLocaleString());

function positionChart(games) {
  const rows = [1, 2, 3, 4, 5].map((pos) => {
    const list = games.filter((game) => game.player.pos === pos);
    const heroes = new Map();
    for (const game of list) {
      const row = heroes.get(game.player.hero) || { id: game.player.hero, games: 0, wins: 0 };
      row.games += 1;
      row.wins += game.won ? 1 : 0;
      heroes.set(row.id, row);
    }
    const top = [...heroes.values()].sort((a, b) => b.games - a.games || b.wins - a.wins).slice(0, 3);
    return { pos, games: list.length, wins: list.filter((game) => game.won).length, top };
  });
  const peak = Math.max(1, ...rows.map((row) => row.games));
  return el("div", { class: "pc-positions" }, rows.map((row) =>
    el("div", { class: `pc-position${row.games ? "" : " empty"}` },
      el("span", { class: "pc-count" }, row.games ? `${row.games} 场` : ""),
      el("span", { class: "pc-track" },
        el("span", { class: "pc-bar", style: `height:${(row.games / peak) * 100}%` },
          el("i", { style: `height:${row.games ? (row.wins / row.games) * 100 : 0}%` }))),
      el("span", { class: "pc-label" }, `${row.pos} 号位`),
      el("span", { class: `pc-rate${row.games && row.games < MIN_RATE_GAMES ? " small-sample" : ""}`, title: row.games ? record(row.wins, row.games) : "" },
        row.games ? winText(row.wins, row.games) : "—"),
      el("span", { class: "pc-heroes" }, row.top.map((entry) =>
        el("span", { class: "pc-hero", title: `${hero(entry.id).name} ${record(entry.wins, entry.games)}` },
          heroIcon(entry.id), el("small", {}, `${entry.wins}-${entry.games - entry.wins}`)))))));
}

function dimensionBars(dims, leagueDims) {
  return el("div", { class: "pc-dims" }, DIMENSIONS.map(({ key, label }) =>
    el("div", { class: "pc-dim" },
      el("span", { class: "pc-dim-label", title: DIMENSIONS.find((dim) => dim.key === key).tip }, label),
      el("span", { class: "dim-bar" },
        el("i", { style: `width:${dims[key] ?? 0}%` }),
        Number.isFinite(leagueDims[key]) ? el("b", { style: `left:${leagueDims[key]}%`, title: `联赛平均 ${scoreText(leagueDims[key])}` }) : null),
      el("span", { class: "num" }, scoreText(dims[key])))));
}

// ---------- 选手卡片头部（列表和选手页共用） ----------

const TITLE_GROUPS = [["honor", "荣誉"], ["stat", "数据"], ["roast", "吐槽"]];
const titleOrder = new Map(TITLES.map(({ name }, index) => [name, index]));

// Every title the player has earned, totalled over the selected matches and grouped by kind.
function titleStrip(counts, games) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const groups = TITLE_GROUPS.map(([kind, label]) => {
    const entries = [...counts.entries()].filter(([name]) => (TITLE_KIND[name] || "stat") === kind)
      .sort((a, b) => b[0].endsWith("MVP") - a[0].endsWith("MVP") || b[1] - a[1] || titleOrder.get(a[0]) - titleOrder.get(b[0]));
    return entries.length ? el("span", { class: `pc-title-group ${kind}` },
      el("b", {}, label), entries.map(([name, count]) => titleChip(name, count))) : null;
  });
  return el("div", { class: "pc-title-strip" },
    el("span", { class: "pc-title-total" }, el("strong", {}, total), `个称号 · ${games} 场`),
    total ? groups : el("span", { class: "pc-title-empty" }, "还没有称号"));
}

function gamesOf(accountId, matches) {
  return matches.flatMap((match) => match.players
    .filter((player) => player.account_id === accountId)
    .map((player) => ({ match, player, won: won(match, player) })));
}

function playerSummary(accountId, games, leagueDims) {
  const wins = games.filter((game) => game.won).length;
  const mine = games.map((game) => game.player);
  const scored = mine.filter((player) => Number.isFinite(player.score));
  const titleCounts = new Map();
  for (const name of mine.flatMap((player) => player.titles || [])) titleCounts.set(name, (titleCounts.get(name) || 0) + 1);
  const mean = meanOf(scored.map((player) => player.score));
  const lanes = laneSummary(games);
  const dims = averageDims(mine);
  return [
    el("span", { class: "pc-identity" },
      el("strong", { class: "pc-name" }, playerName(accountId)),
      el("span", { class: "pc-record" }, `${record(wins, games.length)} · ${winText(wins, games.length)}`),
      el("span", { class: "pc-score" },
        el("strong", { class: scored.length < MIN_RATE_GAMES ? "small-sample" : "", title: IMP_TIP }, scoreText(mean)),
        el("span", {}, "场均评分 ", gradeBadge({ grade: gradeOf(mean) }), el("br"),
          `IMP 均值 ${impText(meanOf(scored.map((player) => player.imp)))}`)),
      el("span", { class: "pc-meta" }, `K/D/A ${kda(mine).text}`),
      el("span", { class: "pc-meta" }, `GPM ${rounded(averageOf(mine, "gpm"))} · 线优 ${lanes.rated ? winText(lanes.win, lanes.rated) : "—"}`)),
    radar(dims, { size: 150, compare: leagueDims }),
    dimensionBars(dims, leagueDims),
    positionChart(games),
    titleStrip(titleCounts, mine.length),
  ];
}

// ---------- 数据与时间范围 ----------

async function loadData() {
  const read = (path) => fetch(path).then((response) => {
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
    return response.json();
  });
  let steamNames = null;
  let latestAliases = null;
  // Aliases the shared service changed after the page was drawn with remembered ones.
  const onAliases = (aliases) => {
    latestAliases = aliases;
    if (!steamNames) return;
    state.names = { ...steamNames, ...aliases };
    state.rerender();
  };
  const [summaries, names, league, aliases, stratz, positions] = await Promise.all([
    read("./data/matches.json"), read("./data/names.json"), read("./data/league.json"), loadPlayerAliases(onAliases),
    read("./data/stratz.json").catch(() => ({})),
    // Positions corrected after the replay parse (junglers) or by hand replace OpenDota's estimate everywhere.
    read("./data/positions.json").catch(() => ({})),
  ]);
  state.heroes = names.heroes || {};
  state.items = names.items || {};
  steamNames = {};
  for (const match of league.matches || []) {
    for (const player of match.players || []) {
      if (player.account_id && player.personaname) steamNames[player.account_id] = player.personaname;
    }
  }
  Object.assign(steamNames, league.player_names || {});
  state.names = { ...steamNames, ...(latestAliases ?? aliases) };
  state.matches = summaries.matches || [];
  for (const match of state.matches) {
    for (const player of match.players) {
      const fixed = positions[match.match_id]?.[player.slot];
      if (fixed) Object.assign(player, { pos: fixed.pos, pos_source: fixed.source });
    }
  }
  // STRATZ never scores some matches (any with Kez); those use the local estimate from fit_imp.py, whose
  // model file is only fetched when such a match exists.
  const impModel = state.matches.some((match) => !stratz.matches?.[match.match_id]?.imp)
    ? await read("./data/imp-model.json").catch(() => null) : null;
  for (const match of state.matches) {
    const extra = stratz.matches?.[match.match_id];
    match.rank = extra?.rank ?? null;
    match.win = extra?.win || null;
    const estimate = extra?.imp ? null : estimateImp(impModel, match, stratz.minute?.[match.match_id]);
    match.impSource = extra?.imp ? "stratz" : estimate ? "est" : null;
    match.impModel = estimate?.model ?? null;
    for (const player of match.players) {
      player.imp = extra?.imp?.[player.slot] ?? estimate?.imp[player.slot] ?? null;
      player.impEstimated = match.impSource === "est";
    }
  }
  computeScores();
  if (state.matches.length) {
    state.min = Math.min(...state.matches.map((match) => match.start_time));
    state.max = Math.max(...state.matches.map((match) => match.start_time + match.duration));
  }
}

const dateToSeconds = (value, endOfDay) => Date.parse(`${value}T00:00:00+09:00`) / 1000 + (endOfDay ? DAY_SECONDS - 1 : 0);

// The current range as page parameters, or null when it covers every match.
function rangeParams() {
  if (state.from <= state.min && state.to >= state.max) return null;
  return { from: dateInput(state.from), to: dateInput(state.to) };
}

// Wires the quick-range buttons and date inputs; `initial` may carry from/to dates from the URL.
function bindRange(onChange, initial = {}) {
  const buttons = [...document.querySelectorAll("#quickRanges button")];
  const set = (from, to, active) => {
    state.from = from;
    state.to = to;
    document.querySelector("#fromDate").value = dateInput(from);
    document.querySelector("#toDate").value = dateInput(to);
    for (const button of buttons) button.classList.toggle("active", button === active);
    onChange();
  };
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const days = Number(button.dataset.days);
      set(days ? Math.max(state.min, state.max - days * DAY_SECONDS) : state.min, state.max, button);
    });
  }
  for (const input of [document.querySelector("#fromDate"), document.querySelector("#toDate")]) {
    input.addEventListener("change", () => {
      const from = dateToSeconds(document.querySelector("#fromDate").value, false);
      const to = dateToSeconds(document.querySelector("#toDate").value, true);
      if (Number.isFinite(from) && Number.isFinite(to) && from <= to) set(from, to, null);
    });
  }
  const from = initial.from ? dateToSeconds(initial.from, false) : NaN;
  const to = initial.to ? dateToSeconds(initial.to, true) : NaN;
  if (Number.isFinite(from) && Number.isFinite(to) && from <= to) set(from, to, null);
  else set(state.min, state.max, buttons.find((button) => button.dataset.days === "0"));
}

export {
  DAY_SECONDS, MIN_RATE_GAMES, DIMENSIONS, LANE_ROLES, LANE_TEXT, IMP_TIP, TITLES,
  state, el, hero, item, playerName, isRadiant, won, minutes, picture, heroIcon, itemIcon, heroLabel, itemLabel,
  matchHref, playerHref, playerLink, formatDate, formatDuration, dateInput, record, rate, smoothed, percent, average,
  kda, sortableTable, section, statCard, visibleMatches, playerRow, teamPanel, meanOf, isMvp, scoreText, scoreTip, impText, gradeBadge, comebackTag, estimateTag,
  gradeOf, titleChip, averageDims, radar, mvpBadge, winText, laneSummary, averageOf, rounded, positionChart,
  dimensionBars, gamesOf, playerSummary, loadData, rangeParams, bindRange,
};
