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
const METRICS = [["lh", "正补"], ["gold", "经济"], ["xp", "经验"], ["dn", "反补"]];
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

function laneCard(match, lane, label, rows, detail, ui) {
  const { el } = ui;
  const mine = rows.filter((row) => row.lane === lane);
  const sides = ["radiant", "dire"].map((side) => mine.filter((row) => sideOf(row.slot) === side)
    .sort((a, b) => (ui.player(a.slot)?.pos ?? 9) - (ui.player(b.slot)?.pos ?? 9)));
  const series = detail.series || {};
  const at = (slot, key, minute) => series[String(slot)]?.[key]?.[minute];
  const view = { metric: "lh" };
  const chartBox = el("div");
  const pairs = sides[0].filter((row) => row.opp !== null).map((row) => [row, mine.find((other) => other.slot === row.opp)]).filter(([, b]) => b);

  const roleOf = (side) => (sides[side][0] ? ROLE_NAME[sides[side][0].role] : "");
  const heroName = (slot) => ui.heroName(ui.player(slot)?.hero);
  function drawChart() {
    const sum = (list, minute) => (list.length ? list.reduce((total, row) => total + (at(row.slot, view.metric, minute) ?? NaN), 0) : NaN);
    const minutes = Array.from({ length: CHART_MINUTES + 1 }, (_, minute) => minute);
    const lines = [];
    if (sides[0].length && sides[1].length) {
      lines.push({ label: "这一路合计（天辉 − 夜魇）", className: "total", values: minutes.map((minute) => sum(sides[0], minute) - sum(sides[1], minute)) });
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

  const team = (side) => el("div", { class: `lane-side ${side === 0 ? "radiant" : "dire"}` },
    el("b", {}, `${side === 0 ? "天辉" : "夜魇"}${roleOf(side)}`),
    sides[side][0]?.result ? el("span", { class: `lane lane-${sides[side][0].result}` }, RESULT_TEXT[sides[side][0].result]) : null,
    sides[side].length ? sides[side].map((row) => el("span", { class: "lane-player" }, ui.heroIcon(ui.player(row.slot)?.hero),
      ui.playerLink(ui.player(row.slot)?.account_id))) : el("span", { class: "draft-meta" }, "没有人"));

  const deaths = mine.flatMap((row) => (row.deaths || []).map(([t, kind, attackers]) => ({ t, kind, attackers, slot: row.slot })))
    .sort((a, b) => a.t - b.t);
  const roams = mine.flatMap((row) => (row.roams || []).map(([start, end, to]) => ({ start, end, to, slot: row.slot })))
    .sort((a, b) => a.start - b.start);
  const tower = (detail.objectives || []).filter((objective) => objective.type === "building_kill" && String(objective.key).includes(`tower1_${lane}`))
    .sort((a, b) => a.time - b.time)[0];
  const notes = [...new Set(mine.map((row) => SOURCE_NOTE[row.source]).filter(Boolean))];

  return el("article", { class: "lane-card" },
    el("h4", {}, label, tower ? el("small", {}, `${String(tower.key).includes("goodguys") ? "天辉" : "夜魇"}一塔 ${clock(tower.time)} 被拆`) : null),
    el("div", { class: "lane-sides" }, team(0), team(1)),
    pairs.length ? el("div", { class: "table-scroll" }, el("table", { class: "data-table lane-table" },
      el("thead", {}, el("tr", {}, ["对位", "5′ 正补", "10′ 正补", "10′ 反补", "10′ 经济差", "10′ 经验差"].map((text) => el("th", { scope: "col" }, text)))),
      el("tbody", {}, pairs.map(([a, b]) => el("tr", {},
        el("td", {}, ui.heroIcon(ui.player(a.slot)?.hero), " vs ", ui.heroIcon(ui.player(b.slot)?.hero)),
        el("td", { class: "num" }, `${a.lh5 ?? "—"} : ${b.lh5 ?? "—"}`),
        el("td", { class: "num" }, `${a.lh10 ?? "—"} : ${b.lh10 ?? "—"}`),
        el("td", { class: "num" }, `${a.dn10 ?? "—"} : ${b.dn10 ?? "—"}`),
        el("td", { class: "num" }, signed(diff(a.gold10, b.gold10))),
        el("td", { class: "num" }, signed(diff(a.xp10, b.xp10)))))))) : null,
    chartBox,
    el("div", { class: "lane-events" },
      el("div", {}, el("b", {}, "对线期死亡"),
        deaths.length ? el("ul", {}, deaths.map((death) => el("li", { class: sideOf(death.slot) },
          el("span", { class: "num" }, clock(death.t)), ui.heroIcon(ui.player(death.slot)?.hero),
          el("span", { class: `death-tag kind-${death.kind}`, title: DEATH_TIP[death.kind] }, DEATH_KIND[death.kind]),
          death.attackers.length ? ["← ", death.attackers.map((slot) => ui.heroIcon(ui.player(slot)?.hero))] : null)))
          : el("span", { class: "draft-meta" }, mine.some((row) => row.deaths) ? " 没有" : " 录像解析后显示")),
      el("div", {}, el("b", {}, "游走"),
        roams.length ? el("ul", {}, roams.map((roam) => el("li", { class: sideOf(roam.slot) },
          el("span", { class: "num" }, `${clock(roam.start)}–${clock(roam.end)}`), ui.heroIcon(ui.player(roam.slot)?.hero),
          `去${LANE_NAME[roam.to]}`)))
          : el("span", { class: "draft-meta" }, mine.some((row) => row.roams) ? " 没有" : " 录像解析后显示"))),
    notes.length ? el("p", { class: "draft-meta" }, notes) : null);
}

// What happened during a jungler's stays in a lane: kills it joined, its own death, or nothing.
function visitOutcome(gank, ui, player) {
  const [, , , kills, died] = gank;
  const parts = [];
  if (kills.length) parts.push("击杀 ", kills.map((slot) => ui.heroIcon(player(slot)?.hero)));
  if (died) parts.push(ui.el("span", { class: "death-tag kind-gank" }, "阵亡"));
  return parts.length ? parts : ui.el("span", { class: "draft-meta" }, "无击杀");
}

function shortLaneText(short) {
  if (!short) return "—";
  const [lane, held, against, result] = short;
  return `${LANE_NAME[lane]} ${held} 对 ${against}${result ? `，对线结果${RESULT_TEXT[result]}` : ""}`;
}

function jungleCard(match, row, ui) {
  const { el } = ui;
  const me = ui.player(row.slot);
  const them = row.opp !== null ? ui.player(row.opp) : null;
  const pair = (mine, theirs) => `${mine ?? "—"} : ${theirs ?? "—"}`;
  return el("article", { class: "lane-card jungle-card" },
    el("h4", {}, `${row.slot < 128 ? "天辉" : "夜魇"}打野`, el("small", {}, `本队${shortLaneText(row.short_lane)}`)),
    el("div", { class: "lane-sides" },
      el("div", { class: `lane-side ${sideOf(row.slot)}` }, el("span", { class: "lane-player" }, ui.heroIcon(me?.hero), ui.playerLink(me?.account_id))),
      them ? el("div", { class: `lane-side ${sideOf(row.opp)}` }, el("b", {}, `对方${row.short_lane ? LANE_NAME[row.short_lane[0]] : ""}辅助`),
        el("span", { class: "lane-player" }, ui.heroIcon(them.hero), ui.playerLink(them.account_id))) : null),
    el("div", { class: "table-scroll" }, el("table", { class: "data-table lane-table" },
      el("thead", {}, el("tr", {}, ["与对方辅助比", "5′ 正补", "10′ 正补", "10′ 经济差", "10′ 经验差"].map((text) => el("th", { scope: "col" }, text)))),
      el("tbody", {}, el("tr", {},
        el("td", {}, ui.heroIcon(me?.hero), " vs ", them ? ui.heroIcon(them.hero) : "—"),
        el("td", { class: "num" }, pair(row.lh5, row.opp_lh5)),
        el("td", { class: "num" }, pair(row.lh10, row.opp_lh10)),
        el("td", { class: "num" }, signed(diff(row.gold10, row.opp_gold10))),
        el("td", { class: "num" }, signed(diff(row.xp10, row.opp_xp10))))))),
    el("div", { class: "lane-events" },
      el("div", {}, el("b", {}, "进入各路（10 分钟前，30 秒以上）"),
        row.ganks?.length ? el("ul", {}, row.ganks.map((gank) => el("li", { class: sideOf(row.slot) },
          el("span", { class: "num" }, `${clock(gank[0])}–${clock(gank[1])}`), `${LANE_NAME[gank[2]]}`, visitOutcome(gank, ui, ui.player))))
          : el("span", { class: "draft-meta" }, row.ganks ? " 没有" : " 录像解析后显示")),
      el("div", {}, el("b", {}, "对线期死亡"),
        row.deaths?.length ? el("ul", {}, row.deaths.map(([t, , attackers]) => el("li", { class: sideOf(row.slot) },
          el("span", { class: "num" }, clock(t)), attackers.length ? ["← ", attackers.map((slot) => ui.heroIcon(ui.player(slot)?.hero))] : "非英雄击杀")))
          : el("span", { class: "draft-meta" }, row.deaths ? " 没有" : " 录像解析后显示"))));
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
    const junglers = mine.filter((row) => row.lane === "jungle");
    box.replaceChildren(...[
      el("p", { class: "draft-meta" },
        "分路按录像里 2:00–8:00 的位置判定。对位按号位把两边同一路的英雄配对（核心对核心、辅助对辅助）。",
        "对线结果按这一路双方 10 分钟经济总和比较，领先 10% 以上为优。曲线是差值，高于 0 为天辉一方领先。",
        "游走：10 分钟前进入另一条路 30 秒以上；拉野、回家、退守二塔不算。"),
      el("div", { class: "lane-cards" }, LANES.map(([lane, label]) => laneCard(match, lane, label, mine, detail, context)),
        junglers.map((row) => jungleCard(match, row, context))),
      junglers.length ? el("p", { class: "draft-meta" },
        "打野没有对线对手，和本队少人那一路的对方辅助比较发育（打野的正补含野怪）。进入各路：10 分钟前在某一路停留 30 秒以上，",
        "其中有没有参与击杀或阵亡；开局在线上发育也会算进来，请结合时间判断是不是 gank。") : null,
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
    const jungle = mine.filter((entry) => entry.row.role === "jungle").sort((a, b) => a.game.match.start_time - b.game.match.start_time);
    const perGame = (list, pick) => (list.length ? (list.reduce((sum, entry) => sum + pick(entry), 0) / list.length).toFixed(1) : "—");
    const slot = ([role, label]) => {
      const list = mine.filter((entry) => entry.row.role === role).sort((a, b) => a.game.match.start_time - b.game.match.start_time);
      if (!list.length) return el("article", { class: "lane-slot empty" }, el("h4", {}, label), el("p", { class: "draft-meta" }, `还没有在${label}的比赛。`));
      const count = (result) => list.filter((entry) => entry.row.result === result).length;
      const parsed = list.filter((entry) => entry.row.deaths);
      const deaths = (kind) => perGame(parsed, (entry) => entry.row.deaths.filter((death) => death[1] === kind).length);
      const heroes = new Map();
      for (const { game } of list) heroes.set(game.player.hero, (heroes.get(game.player.hero) || 0) + 1);
      const avgDiff = (key) => signed(mean(list.map((entry) => diff(entry.row[key], entry.row[`opp_${key}`]))));
      return el("article", { class: "lane-slot" },
        el("h4", {}, label, el("small", {}, `${list.length} 场 · 优 ${count("W")} 均 ${count("D")} 劣 ${count("L")}`)),
        el("dl", { class: "lane-stats" },
          el("dt", {}, "正补差（对位）"), el("dd", {}, `5′ ${avgDiff("lh5")} · 10′ ${avgDiff("lh10")}`),
          el("dt", {}, "10′ 经济差（对位）"), el("dd", {}, avgDiff("gold10")),
          el("dt", {}, "10′ 正补 / 经济"), el("dd", {}, `${perGame(list, (entry) => entry.row.lh10 ?? 0)} / ${Math.round(mean(list.map((entry) => entry.row.gold10)) ?? 0).toLocaleString()}`),
          el("dt", {}, "对线期死亡 / 场"), el("dd", {}, parsed.length
            ? [`单杀 ${deaths("solo")} · 对线 ${deaths("lane")} · `, el("b", {}, `被 gank ${deaths("gank")}`)] : "录像解析后显示"),
          el("dt", {}, "对线期参与击杀 / 场"), el("dd", {}, parsed.length ? perGame(parsed, (entry) => entry.row.kills ?? 0) : "—"),
          el("dt", {}, "游走 / 场"), el("dd", {}, parsed.length ? perGame(parsed, (entry) => entry.row.roams.length) : "—"),
          el("dt", {}, "10 分钟前插眼 / 场"), el("dd", {}, `假眼 ${perGame(list, (entry) => entry.row.obs ?? 0)} · 真眼 ${perGame(list, (entry) => entry.row.sen ?? 0)}`)),
        el("div", { class: "lane-heroes" }, [...heroes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([id, games]) => el("span", { title: `${ui.heroName(id)} ${games} 场` }, ui.heroIcon(id), el("small", {}, games)))),
        trendDots(list.map((entry) => ({ ...entry.row, date: ui.formatDate(entry.game.match.start_time) })), ui));
    };
    const jungleSlot = (list) => el("article", { class: "lane-slot jungle-slot" },
      el("h4", {}, "打野", el("small", {}, `${list.length} 场 · 逐场列出，和本队少人那一路的对方辅助比较；打野的正补含野怪`)),
      el("div", { class: "table-scroll" }, el("table", { class: "data-table lane-table" },
        el("thead", {}, el("tr", {}, ["比赛", "英雄", "10′ 正补（本人 : 对方辅助）", "10′ 经济差", "进入各路（有击杀）", "对线期死亡", "本队单人路"]
          .map((text) => el("th", { scope: "col" }, text)))),
        el("tbody", {}, list.map(({ game, row }) => el("tr", {},
          el("td", {}, el("a", { href: ui.matchHref(game.match.match_id) }, ui.formatDate(game.match.start_time))),
          el("td", {}, ui.heroIcon(game.player.hero)),
          el("td", { class: "num" }, `${row.lh10 ?? "—"} : ${row.opp_lh10 ?? "—"}`),
          el("td", { class: "num" }, signed(diff(row.gold10, row.opp_gold10))),
          el("td", { class: "num" }, row.ganks ? `${row.ganks.length}（${row.ganks.filter((gank) => gank[3].length).length}）` : "—"),
          el("td", { class: "num" }, row.deaths ? row.deaths.length : "—"),
          el("td", {}, shortLaneText(row.short_lane))))))));
    box.replaceChildren(
      el("p", { class: "draft-meta" },
        "分路按录像里 2:00–8:00 的位置判定，对位是同一路对面同类号位的英雄（核心对核心、辅助对辅助）。差值为本人减对位。",
        "对线结果按这一路双方 10 分钟经济总和比较，领先 10% 以上为优。死亡类型：单杀只有一名同路敌人参与，对线有多名同路敌人，被 gank 有其他路或打野的敌人参与。"),
      el("div", { class: "lane-slot-grid" }, ROLES.map(slot)),
      jungle.length ? jungleSlot(jungle) : "");
  });
  return box;
}
