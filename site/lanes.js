// Laning phase: three lane cards on the match page and three fixed lane slots on the player page.
// Rows come from data/lanes.json (one per player and match); per-minute curves from the match detail file.

const LANES = [["top", "上路"], ["mid", "中路"], ["bot", "下路"]];
const ROLES = [["safe", "优势路"], ["mid", "中路"], ["off", "劣势路"]];
const ROLE_NAME = Object.fromEntries([...ROLES, ["jungle", "打野"]]);
const LANE_NAME = Object.fromEntries(LANES);
const RESULT_TEXT = { W: "优", D: "均", L: "劣" };
const DEATH_KIND = { solo: "单杀", lane: "对线", gank: "被 gank", other: "其他" };
const DEATH_TIP = {
  solo: "只有一名同路敌人参与", lane: "多名同路敌人参与", gank: "有其他路或打野的敌人参与", other: "没有敌方英雄造成伤害（塔、小兵等）",
};
const METRICS = [["gold", "经济"], ["xp", "经验"], ["lh", "正补"], ["dn", "反补"]];
const deathCount = (row) => (row.deaths ? row.deaths.length : null);
// Lane moves: roams for laners, stays in a lane before 10:00 for junglers.
const moves = (row) => (row.lane === "jungle" ? row.ganks : row.roams);
const moveCount = (row) => (moves(row) ? moves(row).length : null);
const wardCount = (row) => (Number.isFinite(row.obs) ? row.obs + (row.sen ?? 0) : null);
// [label, value, lower is better, show the difference]
const CORE_METRICS = [
  ["5′ 正补", (row) => row.lh5], ["10′ 正补", (row) => row.lh10], ["10′ 反补", (row) => row.dn10],
  ["10′ 经济", (row) => row.gold10, false, true], ["10′ 经验", (row) => row.xp10, false, true],
  ["对线期参与击杀", (row) => row.kills], ["对线期死亡", deathCount, true],
];
const SUPPORT_METRICS = [
  ["10′ 经验", (row) => row.xp10, false, true], ["10′ 经济", (row) => row.gold10, false, true],
  ["对线期参与击杀", (row) => row.kills], ["对线期死亡", deathCount, true],
  ["10′ 前插眼", wardCount], ["10′ 前排眼", (row) => row.dewards], ["游走 / 进路", moveCount],
];
const sum = (rows, pick) => {
  const values = rows.map(pick);
  return values.some((value) => !Number.isFinite(value)) ? null : values.reduce((total, value) => total + value, 0);
};
const TEAM_METRICS = [
  ["10′ 经济合计", (rows) => sum(rows, (row) => row.gold10), false, true],
  ["10′ 经验合计", (rows) => sum(rows, (row) => row.xp10), false, true],
  ["10′ 正补合计", (rows) => sum(rows, (row) => row.lh10)],
  ["对线期死亡", (rows) => sum(rows, deathCount), true],
];
const CHART_MINUTES = 12;
const SOURCE_NOTE = { opendota: "分路暂按 OpenDota 判定，录像解析后会更新。", manual: "分路经过手动修正。" };

let laneRows = null;

export function loadLanes() {
  laneRows ??= fetch("./data/lanes.json", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : { columns: [], rows: [] }))
    .catch(() => ({ columns: [], rows: [] }))
    .then(({ columns, rows }) => rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))));
  return laneRows;
}

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const signed = (value) => (value === null || value === undefined || Number.isNaN(value) ? "—"
  : `${value > 0 ? "+" : ""}${Math.round(value).toLocaleString()}`);
const diff = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? a - b : null);
const mean = (values) => {
  const list = values.filter(Number.isFinite);
  return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
};
const sideOf = (slot) => (slot < 128 ? "radiant" : "dire");

function diffChart(lines, ui) {
  const width = 640;
  const height = 200;
  const pad = { left: 48, right: 12, top: 12, bottom: 24 };
  const usable = lines.filter((line) => line.values.some(Number.isFinite));
  if (!usable.length) return ui.el("p", { class: "draft-meta" }, "这一路没有逐分钟数据。");
  const peak = Math.max(1, ...usable.flatMap((line) => line.values.filter(Number.isFinite).map(Math.abs)));
  const x = (minute) => pad.left + (minute / CHART_MINUTES) * (width - pad.left - pad.right);
  const y = (value) => pad.top + ((peak - value) / (2 * peak)) * (height - pad.top - pad.bottom);
  const grid = [0, 2, 4, 6, 8, 10, 12].map((minute) =>
    `<line x1="${x(minute)}" x2="${x(minute)}" y1="${pad.top}" y2="${height - pad.bottom}" class="grid"/>` +
    `<text x="${x(minute)}" y="${height - 6}" text-anchor="middle">${minute}′</text>`).join("");
  const paths = usable.map((line) => {
    const points = line.values.map((value, minute) => (Number.isFinite(value) ? `${x(minute).toFixed(1)},${y(value).toFixed(1)}` : null))
      .filter(Boolean).join(" ");
    return `<polyline points="${points}" class="${line.className}"/>`;
  }).join("");
  const figure = ui.el("figure", { class: "lane-chart" });
  figure.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="对线差值曲线">${grid}
    <line x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}" class="zero"/>
    <text x="${pad.left - 6}" y="${y(peak) + 4}" text-anchor="end">${signed(peak)}</text>
    <text x="${pad.left - 6}" y="${y(0) + 4}" text-anchor="end">0</text>
    <text x="${pad.left - 6}" y="${y(-peak) + 4}" text-anchor="end">${signed(-peak)}</text>${paths}</svg>`;
  figure.append(ui.el("figcaption", {}, usable.map((line) => ui.el("span", { class: `key ${line.className}` }, line.label))));
  return figure;
}


// Left (Radiant) against right (Dire): each metric row highlights the side that is ahead.
function versus(title, left, right, metrics, ui, team = false) {
  const { el } = ui;
  const who = (rows) => rows.map((row) => el("span", { class: "vs-player" }, ui.heroIcon(ui.player(row.slot)?.hero),
    el("span", { class: "vs-names" }, el("b", {}, ui.heroName(ui.player(row.slot)?.hero)),
      el("small", {}, ui.playerLink(ui.player(row.slot)?.account_id))),
    row.lane === "jungle" ? el("span", { class: "jungle-tag", title: "打野，按本队少人的这一路计算" }, "打野") : null));
  return el("div", { class: "versus" },
    el("div", { class: "vs-head radiant" }, who(left)),
    el("div", { class: "vs-title" }, title),
    el("div", { class: "vs-head dire" }, who(right)),
    metrics.flatMap(([label, pick, lowerBetter, showDiff]) => {
      const a = team ? pick(left) : pick(left[0]);
      const b = team ? pick(right) : pick(right[0]);
      const both = Number.isFinite(a) && Number.isFinite(b);
      const leftAhead = both && (lowerBetter ? a < b : a > b);
      const rightAhead = both && (lowerBetter ? b < a : b > a);
      const cell = (value, ahead, other, side) => el("div", { class: `vs-value ${side}${ahead ? " ahead" : ""}` },
        Number.isFinite(value) ? value.toLocaleString() : "—",
        ahead && showDiff ? el("small", {}, signed(value - other)) : null);
      return [cell(a, leftAhead, b, "radiant"), el("div", { class: "vs-label" }, label), cell(b, rightAhead, a, "dire")];
    }));
}

function laneCard(match, lane, label, rows, detail, ui) {
  const { el } = ui;
  const mine = rows.filter((row) => row.group === lane);
  const sides = ["radiant", "dire"].map((side) => mine.filter((row) => sideOf(row.slot) === side)
    .sort((a, b) => (ui.player(a.slot)?.pos ?? 9) - (ui.player(b.slot)?.pos ?? 9)));
  const series = detail.series || {};
  const at = (slot, key, minute) => series[String(slot)]?.[key]?.[minute];
  const pairs = sides[0].filter((row) => row.opp !== null).map((row) => [row, mine.find((other) => other.slot === row.opp)])
    .filter(([, b]) => b);
  const corePairs = pairs.filter(([a, b]) => a.kind === "core" && b.kind === "core");
  const supportPairs = pairs.filter(([a, b]) => a.kind === "support" && b.kind === "support");
  const otherPairs = pairs.filter((pair) => !corePairs.includes(pair) && !supportPairs.includes(pair));
  const view = { metric: "gold" };
  const chartBox = el("div");
  const heroName = (slot) => ui.heroName(ui.player(slot)?.hero);

  function drawChart() {
    const total = (list, minute) => (list.length ? list.reduce((acc, row) => acc + (at(row.slot, view.metric, minute) ?? NaN), 0) : NaN);
    const minutes = Array.from({ length: CHART_MINUTES + 1 }, (_, minute) => minute);
    const lines = [];
    if (sides[0].length && sides[1].length && (sides[0].length > 1 || sides[1].length > 1)) {
      lines.push({ label: "这一路合计（天辉 − 夜魇）", className: "total", values: minutes.map((minute) => total(sides[0], minute) - total(sides[1], minute)) });
    }
    pairs.forEach(([a, b], index) => lines.push({
      label: `${heroName(a.slot)} − ${heroName(b.slot)}`, className: `pair pair-${index}`,
      values: minutes.map((minute) => diff(at(a.slot, view.metric, minute), at(b.slot, view.metric, minute))),
    }));
    chartBox.replaceChildren(
      el("div", { class: "map-row" }, METRICS.map(([key, name]) => el("button", {
        type: "button", class: view.metric === key ? "active" : "", "aria-pressed": String(view.metric === key),
        onclick: () => { view.metric = key; drawChart(); },
      }, name))),
      diffChart(lines, ui));
  }
  drawChart();

  const roleLabel = (side) => (sides[side][0] ? ROLE_NAME[sides[side][0].role] : "");
  const result = (side) => sides[side].find((row) => row.result)?.result;
  const deaths = mine.flatMap((row) => (row.deaths || []).map(([t, kind, attackers]) => ({ t, kind, attackers, row })))
    .sort((a, b) => a.t - b.t);
  const trips = mine.flatMap((row) => (moves(row) || []).map((move) => ({ move, row }))).sort((a, b) => a.move[0] - b.move[0]);
  const tower = (detail.objectives || []).filter((objective) => objective.type === "building_kill" && String(objective.key).includes(`tower1_${lane}`))
    .sort((a, b) => a.time - b.time)[0];
  const notes = [...new Set(mine.map((row) => SOURCE_NOTE[row.source]).filter(Boolean))];
  const tag = (row) => (row.lane === "jungle" ? el("span", { class: "jungle-tag" }, "打野") : null);

  return el("article", { class: "lane-card" },
    el("h4", {}, label, tower ? el("small", {}, `${String(tower.key).includes("goodguys") ? "天辉" : "夜魇"}一塔 ${clock(tower.time)} 被拆`) : null),
    el("div", { class: "lane-sides" }, [0, 1].map((side) => el("div", { class: `lane-side ${side === 0 ? "radiant" : "dire"}` },
      el("b", {}, `${side === 0 ? "天辉" : "夜魇"}${roleLabel(side)}`),
      result(side) ? el("span", { class: `lane lane-${result(side)}` }, RESULT_TEXT[result(side)]) : null,
      el("small", {}, sides[side].length ? `${sides[side].length} 人` : "没有人")))),
    corePairs.map(([a, b]) => versus("核心对核心", [a], [b], CORE_METRICS, ui)),
    supportPairs.map(([a, b]) => versus("辅助对辅助", [a], [b], SUPPORT_METRICS, ui)),
    otherPairs.map(([a, b]) => versus("对位", [a], [b], CORE_METRICS, ui)),
    lane !== "mid" && sides[0].length > 1 && sides[1].length > 1 ? versus(`${sides[0].length} 对 ${sides[1].length}`, sides[0], sides[1], TEAM_METRICS, ui, true) : null,
    chartBox,
    el("div", { class: "lane-events" },
      el("div", {}, el("b", {}, "对线期死亡"),
        deaths.length ? el("ul", {}, deaths.map((death) => el("li", { class: sideOf(death.row.slot) },
          el("span", { class: "num" }, clock(death.t)), ui.heroIcon(ui.player(death.row.slot)?.hero), tag(death.row),
          el("span", { class: `death-tag kind-${death.kind}`, title: DEATH_TIP[death.kind] }, DEATH_KIND[death.kind]),
          death.attackers.length ? ["← ", death.attackers.map((slot) => ui.heroIcon(ui.player(slot)?.hero))] : null)))
          : el("span", { class: "draft-meta" }, mine.some((row) => row.deaths) ? " 没有" : " 录像解析后显示")),
      el("div", {}, el("b", {}, "游走与进路"),
        trips.length ? el("ul", {}, trips.map(({ move, row }) => el("li", { class: sideOf(row.slot) },
          el("span", { class: "num" }, `${clock(move[0])}–${clock(move[1])}`), ui.heroIcon(ui.player(row.slot)?.hero), tag(row),
          `去${LANE_NAME[move[2]]}`,
          row.lane === "jungle" ? [" · ", move[3].length ? ["击杀 ", move[3].map((slot) => ui.heroIcon(ui.player(slot)?.hero))] : "无击杀",
            move[4] ? el("span", { class: "death-tag kind-gank" }, "阵亡") : null] : null)))
          : el("span", { class: "draft-meta" }, mine.some((row) => moves(row)) ? " 没有" : " 录像解析后显示"))),
    notes.length ? el("p", { class: "draft-meta" }, notes) : null);
}

export function laneReview(match, detail, ui) {
  const { el } = ui;
  const box = el("div", { class: "lane-review" }, el("p", { class: "draft-meta" }, "正在读取对线数据……"));
  loadLanes().then((rows) => {
    const mine = rows.filter((row) => row.match_id === match.match_id);
    if (!mine.length) {
      box.replaceChildren(el("p", { class: "draft-meta" }, "这场还没有对线数据。"));
      return;
    }
    const player = (slot) => match.players.find((entry) => entry.slot === slot);
    const context = { ...ui, player };
    const loose = mine.filter((row) => row.group === "jungle");
    box.replaceChildren(...[
      el("p", { class: "draft-meta" },
        "分路按录像里 2:00–8:00 的位置判定。核心对核心、辅助对辅助，绿色底色是这一项领先的一方（死亡少者领先）。",
        "辅助不比正补，比经验、参与击杀、死亡、插眼、排眼和游走。打野归入本队少人的那一路，名字旁标「打野」；进路是 10 分钟前在某一路停留 30 秒以上。",
        "对线结果按这一路双方 10 分钟经济总和比较，领先 10% 以上为优。曲线是差值，高于 0 为天辉一方领先。"),
      el("div", { class: "lane-cards" }, LANES.map(([lane, label]) => laneCard(match, lane, label, mine, detail, context))),
      loose.length ? el("p", { class: "draft-meta" }, "打野（两边各路人数相同，没有归入某一路）：",
        loose.map((row) => [ui.heroIcon(player(row.slot)?.hero), ` ${ui.heroName(player(row.slot)?.hero)} `])) : null,
    ].filter(Boolean));
  });
  return box;
}

// ---------- 选手页：三路概况 + 号位表现 ----------

const POSITION_NAME = { 1: "1 号位 · 核心", 2: "2 号位 · 核心", 3: "3 号位 · 核心", 4: "4 号位 · 辅助", 5: "5 号位 · 辅助" };
const RECENT_GAMES = 5;

// Mean of the player's and the counterpart's value, and in how many games the player was ahead.
function headToHead(list, key) {
  const pairs = list.map(({ row }) => [row[key], row[`opp_${key}`]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  return {
    games: pairs.length,
    mine: mean(pairs.map(([a]) => a)),
    theirs: mean(pairs.map(([, b]) => b)),
    ahead: pairs.filter(([a, b]) => a > b).length,
  };
}

function laneOverview(list, label, ui) {
  const { el } = ui;
  if (!list.length) return el("article", { class: "lane-slot empty" }, el("h4", {}, label), el("p", { class: "draft-meta" }, `还没有在${label}的比赛。`));
  const count = (result) => list.filter((entry) => entry.row.result === result).length;
  const positions = new Map();
  for (const { game } of list) positions.set(game.player.pos, (positions.get(game.player.pos) || 0) + 1);
  const jungle = list.filter((entry) => entry.row.lane === "jungle").length;
  return el("article", { class: "lane-slot" },
    el("h4", {}, label, el("small", {}, `${list.length} 场`)),
    el("div", { class: "lane-results" },
      [["W", "优"], ["D", "均"], ["L", "劣"]].map(([key, text]) => el("span", { class: `lane-count lane-${key}` }, `${text} ${count(key)}`))),
    el("p", { class: "lane-positions" }, [...positions.entries()].sort((a, b) => (a[0] ?? 9) - (b[0] ?? 9))
      .map(([pos, games]) => `${pos ? `${pos} 号位` : "号位未知"} ${games} 场`).join("、")),
    jungle ? el("span", { class: "jungle-tag", title: "打野的比赛归入本队少人的这一路" }, `含打野 ${jungle} 场`) : null);
}

function positionBlock(pos, list, ui) {
  const { el } = ui;
  const core = pos <= 3;
  const lanes = new Map();
  for (const { row } of list) lanes.set(ROLE_NAME[row.role], (lanes.get(ROLE_NAME[row.role]) || 0) + 1);
  const jungle = list.filter((entry) => entry.row.lane === "jungle").length;
  const parsed = list.filter((entry) => entry.row.deaths);
  const deaths = parsed.reduce((total, entry) => total + entry.row.deaths.length, 0);
  const ganked = parsed.reduce((total, entry) => total + entry.row.deaths.filter((death) => death[1] === "gank").length, 0);
  const kills = parsed.reduce((total, entry) => total + (entry.row.kills ?? 0), 0);
  const total = (key) => list.reduce((sum, entry) => sum + (entry.row[key] ?? 0), 0);
  const number = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString() : "—");
  const versus = (h2h) => (h2h.games ? `${number(h2h.mine)} vs ${number(h2h.theirs)}` : "—");
  const aheadText = (h2h) => (h2h.games ? `${h2h.games} 场中 ${h2h.ahead} 场领先对位` : "没有对位数据");
  const lh = headToHead(list, "lh10");
  const xp = headToHead(list, "xp10");
  const gold = headToHead(list, "gold10");
  const unparsed = list.length - parsed.length;
  const cards = [
    core ? ui.statCard("10′ 正补（本人 vs 对位）", versus(lh), aheadText(lh)) : ui.statCard("10′ 经验（本人 vs 对位）", versus(xp), aheadText(xp)),
    core ? ui.statCard("10′ 经济差（平均）", el("span", { class: toneClass(diff(gold.mine, gold.theirs)) }, signed(diff(gold.mine, gold.theirs))), aheadText(gold)) : null,
    ui.statCard("对线期死亡", parsed.length ? `${deaths} 次` : "—",
      parsed.length ? `其中被 gank ${ganked} 次 · ${parsed.length} 场${unparsed ? `（另 ${unparsed} 场录像未解析）` : ""}` : "录像解析后显示"),
    ui.statCard("对线期参与击杀", parsed.length ? `${kills} 次` : "—", parsed.length ? `${parsed.length} 场合计` : ""),
    core ? null : ui.statCard("10′ 前视野", `假眼 ${total("obs")} · 真眼 ${total("sen")}`, `排眼 ${total("dewards")} 次 · ${list.length} 场合计`),
  ];
  const recent = [...list].sort((a, b) => b.game.match.start_time - a.game.match.start_time).slice(0, RECENT_GAMES);
  const keyDiff = (row) => (core
    ? [el("span", { class: toneClass(diff(row.lh10, row.opp_lh10)) }, `正补 ${signed(diff(row.lh10, row.opp_lh10))}`), " · ",
      el("span", { class: toneClass(diff(row.gold10, row.opp_gold10), 100) }, `经济 ${signed(diff(row.gold10, row.opp_gold10))}`)]
    : el("span", { class: toneClass(diff(row.xp10, row.opp_xp10), 100) }, `经验 ${signed(diff(row.xp10, row.opp_xp10))}`));
  return el("article", { class: "position-block" },
    el("h4", {}, POSITION_NAME[pos] || `${pos} 号位`, el("small", {},
      `${list.length} 场 · ${[...lanes.entries()].map(([lane, games]) => `${lane} ${games} 场`).join("、")}`),
      jungle ? el("span", { class: "jungle-tag" }, `含打野 ${jungle} 场`) : null),
    el("div", { class: "stat-cards" }, cards.filter(Boolean)),
    el("div", { class: "table-scroll" }, el("table", { class: "data-table recent-lanes" },
      el("caption", {}, `最近 ${recent.length} 场（10 分钟时与对位的差值）`),
      el("thead", {}, el("tr", {}, ["比赛", "英雄", "对线结果", core ? "正补差 · 经济差" : "经验差", "对线期死亡"].map((text) => el("th", { scope: "col" }, text)))),
      el("tbody", {}, recent.map(({ game, row }) => el("tr", {},
        el("td", {}, el("a", { href: ui.matchHref(game.match.match_id) }, ui.formatDate(game.match.start_time))),
        el("td", {}, ui.heroIcon(game.player.hero), row.lane === "jungle" ? el("span", { class: "jungle-tag" }, "打野") : null),
        el("td", {}, row.result ? el("span", { class: `lane lane-${row.result}` }, RESULT_TEXT[row.result]) : "—"),
        el("td", { class: "num" }, keyDiff(row)),
        el("td", { class: "num" }, row.deaths ? `${row.deaths.length}${row.deaths.some((death) => death[1] === "gank") ? `（被 gank ${row.deaths.filter((death) => death[1] === "gank").length}）` : ""}` : "—"))))))); 
}

function toneClass(value, threshold = 1) {
  return !Number.isFinite(value) || Math.abs(value) < threshold ? "" : value > 0 ? "diff-up" : "diff-down";
}

export function laneSlots(games, ui) {
  const { el } = ui;
  const box = el("div", { class: "lane-slots" }, el("p", { class: "draft-meta" }, "正在读取对线数据……"));
  loadLanes().then((rows) => {
    const byKey = new Map(rows.map((row) => [`${row.match_id}:${row.slot}`, row]));
    const mine = games.map((game) => ({ game, row: byKey.get(`${game.match.match_id}:${game.player.slot}`) })).filter((entry) => entry.row);
    const positions = [1, 2, 3, 4, 5].map((pos) => [pos, mine.filter((entry) => entry.game.player.pos === pos)]).filter(([, list]) => list.length);
    const loose = mine.filter((entry) => entry.row.role === "jungle").length;
    box.replaceChildren(
      el("h3", { class: "lane-layer" }, "三路概况"),
      el("p", { class: "draft-meta" }, "这一路双方 10 分钟经济总和领先 10% 以上为优，落后 10% 以上为劣。分路按录像里 2:00–8:00 的位置判定，打野归入本队少人的那一路。",
        loose ? ` 另有 ${loose} 场打野没有归入某一路。` : ""),
      el("div", { class: "lane-slot-grid" }, ROLES.map(([role, label]) => laneOverview(mine.filter((entry) => entry.row.role === role), label, ui))),
      el("h3", { class: "lane-layer" }, "号位表现"),
      el("p", { class: "draft-meta" }, "和对线期同一路对面同类（核心或辅助）的英雄比。核心看 10 分钟正补和经济，辅助看 10 分钟经验和视野。",
        "对线期指 10 分钟前；被 gank 指有其他路或打野的敌人参与击杀。"),
      ...(positions.length ? positions.map(([pos, list]) => positionBlock(pos, list, ui)) : [el("p", { class: "draft-meta" }, "没有号位数据。")]));
  });
  return box;
}
