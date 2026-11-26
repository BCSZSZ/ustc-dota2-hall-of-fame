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

function trendDots(rows, ui) {
  const width = 260;
  const height = 64;
  const values = rows.map((row) => diff(row.gold10, row.opp_gold10));
  const peak = Math.max(500, ...values.filter(Number.isFinite).map(Math.abs));
  const x = (index) => 8 + (rows.length > 1 ? (index / (rows.length - 1)) * (width - 16) : (width - 16) / 2);
  const y = (value) => 6 + ((peak - value) / (2 * peak)) * (height - 12);
  const dots = rows.map((row, index) => (Number.isFinite(values[index])
    ? `<circle cx="${x(index).toFixed(1)}" cy="${y(values[index]).toFixed(1)}" r="4" class="dot-${row.result || "N"}"><title>${row.date} ${signed(values[index])}</title></circle>` : "")).join("");
  const figure = ui.el("figure", { class: "lane-trend" });
  figure.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="每场 10 分钟对位经济差">
    <line x1="0" x2="${width}" y1="${y(0)}" y2="${y(0)}" class="zero"/>${dots}</svg>`;
  figure.append(ui.el("figcaption", {}, "每场 10′ 对位经济差，按时间从左到右"));
  return figure;
}

export function laneSlots(games, ui) {
  const { el } = ui;
  const box = el("div", { class: "lane-slots" }, el("p", { class: "draft-meta" }, "正在读取对线数据……"));
  loadLanes().then((rows) => {
    const byKey = new Map(rows.map((row) => [`${row.match_id}:${row.slot}`, row]));
    const mine = games.map((game) => ({ game, row: byKey.get(`${game.match.match_id}:${game.player.slot}`) })).filter((entry) => entry.row);
    const perGame = (list, pick) => {
      const values = list.map(pick).filter(Number.isFinite);
      return values.length ? (values.reduce((total, value) => total + value, 0) / values.length).toFixed(1) : "—";
    };
    const tone = (value) => el("span", { class: !Number.isFinite(value) || Math.abs(value) < 0.5 ? "" : value > 0 ? "diff-up" : "diff-down" }, signed(value));
    const avgDiff = (list, key) => tone(mean(list.map((entry) => diff(entry.row[key], entry.row[`opp_${key}`]))));
    const deathKinds = (list) => {
      const parsed = list.filter((entry) => entry.row.deaths);
      if (!parsed.length) return "录像解析后显示";
      const kind = (name) => perGame(parsed, (entry) => entry.row.deaths.filter((death) => death[1] === name).length);
      return [`单杀 ${kind("solo")} · 对线 ${kind("lane")} · `, el("b", {}, `被 gank ${kind("gank")}`)];
    };
    const block = (title, list, lines) => (list.length ? el("div", { class: "lane-kind" },
      el("h5", {}, `${title} ${list.length} 场`),
      el("dl", { class: "lane-stats" }, lines(list).flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)]))) : null);
    const coreLines = (list) => [
      ["正补差（对位）", ["5′ ", avgDiff(list, "lh5"), " · 10′ ", avgDiff(list, "lh10")]],
      ["10′ 经济差 / 经验差", [avgDiff(list, "gold10"), " / ", avgDiff(list, "xp10")]],
      ["对线期死亡 / 场", deathKinds(list)],
      ["对线期参与击杀 / 场", perGame(list, (entry) => entry.row.kills)],
      ["游走 / 场", perGame(list, (entry) => moveCount(entry.row))],
    ];
    const supportLines = (list) => [
      ["10′ 经验差 / 经济差", [avgDiff(list, "xp10"), " / ", avgDiff(list, "gold10")]],
      ["对线期参与击杀 / 场", perGame(list, (entry) => entry.row.kills)],
      ["对线期死亡 / 场", deathKinds(list)],
      ["10′ 前插眼 / 场", `假眼 ${perGame(list, (entry) => entry.row.obs)} · 真眼 ${perGame(list, (entry) => entry.row.sen)}`],
      ["10′ 前排眼 / 场", perGame(list, (entry) => entry.row.dewards)],
      ["游走或进路 / 场", perGame(list, (entry) => moveCount(entry.row))],
    ];
    const slot = ([role, label]) => {
      const list = mine.filter((entry) => entry.row.role === role).sort((a, b) => a.game.match.start_time - b.game.match.start_time);
      if (!list.length) return el("article", { class: "lane-slot empty" }, el("h4", {}, label), el("p", { class: "draft-meta" }, `还没有在${label}的比赛。`));
      const count = (result) => list.filter((entry) => entry.row.result === result).length;
      const jungle = list.filter((entry) => entry.row.lane === "jungle").length;
      const heroes = new Map();
      for (const { game } of list) heroes.set(game.player.hero, (heroes.get(game.player.hero) || 0) + 1);
      return el("article", { class: "lane-slot" },
        el("h4", {}, label, el("small", {}, `${list.length} 场 · 优 ${count("W")} 均 ${count("D")} 劣 ${count("L")}`),
          jungle ? el("span", { class: "jungle-tag", title: "打野的比赛按本队少人的这一路计算" }, `含打野 ${jungle}`) : null),
        block("核心", list.filter((entry) => entry.row.kind === "core"), coreLines),
        block("辅助", list.filter((entry) => entry.row.kind === "support"), supportLines),
        el("div", { class: "lane-heroes" }, [...heroes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([id, played]) => el("span", { title: `${ui.heroName(id)} ${played} 场` }, ui.heroIcon(id), el("small", {}, played)))),
        trendDots(list.map((entry) => ({ ...entry.row, date: ui.formatDate(entry.game.match.start_time) })), ui));
    };
    const loose = mine.filter((entry) => entry.row.role === "jungle").length;
    box.replaceChildren(
      el("p", { class: "draft-meta" },
        "分路按录像里 2:00–8:00 的位置判定；打野归入本队少人的那一路。对位是同一路对面的核心或辅助，差值为本人减对位，绿色领先、红色落后。",
        "核心看正补、经济、经验；辅助不比正补，看经验、参与击杀、死亡、插眼、排眼和游走。",
        "对线结果按这一路双方 10 分钟经济总和比较，领先 10% 以上为优。死亡类型：单杀只有一名同路敌人参与，对线有多名同路敌人，被 gank 有其他路或打野的敌人参与。",
        loose ? ` 另有 ${loose} 场打野没有归入某一路。` : ""),
      el("div", { class: "lane-slot-grid" }, ROLES.map(slot)));
  });
  return box;
}
