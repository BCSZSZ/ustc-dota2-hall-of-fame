// Player page laning analysis: a lane overview, then one block per position the player has played.
// Every number is set against the counterpart (the opposite core or support in the same lane) and against the
// league average for the same position over the same matches.

import {
  CHART_MINUTES, DEATH_KIND, RESULT_TEXT, ROLE_NAME, ROLES, clock, diff, diffChart, loadLanes, mean, signed,
} from "./lanes.js?v=8";

const POSITION_NAME = { 1: "1 号位 · 核心", 2: "2 号位 · 核心", 3: "3 号位 · 核心", 4: "4 号位 · 辅助", 5: "5 号位 · 辅助" };
const REGION_NAME = { own_base: "己方基地", own_half: "己方半场", river: "河道", enemy_half: "敌方半场", enemy_base: "敌方基地" };
const SMALL_SAMPLE = 5;
const GAME_LIST = 12;

const count = (list, test) => list.filter(test).length;
const total = (list, pick) => list.reduce((sum, entry) => sum + (Number.isFinite(pick(entry)) ? pick(entry) : 0), 0);
const avg = (list, pick) => mean(list.map(pick));
const fixed = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : "—");
const whole = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString() : "—");
const minuteText = (value) => (Number.isFinite(value) ? clock(Math.round(value)) : "—");
const toneClass = (value, threshold = 1) => (!Number.isFinite(value) || Math.abs(value) < threshold ? "" : value > 0 ? "diff-up" : "diff-down");
const deathsOf = (entry) => entry.row.deaths || [];
const parsedOf = (list) => list.filter((entry) => entry.row.deaths);

// The same-side core in the same lane: whose farm a support is there to protect.
function partnerOf(entry, rowsByMatch) {
  const { row } = entry;
  return (rowsByMatch.get(row.match_id) || []).find((other) => other.slot !== row.slot && other.group === row.group
    && (other.slot < 128) === (row.slot < 128) && other.kind === "core") || null;
}

function laneOverview(list, label, ui) {
  const { el } = ui;
  if (!list.length) return el("article", { class: "lane-slot empty" }, el("h4", {}, label), el("p", { class: "draft-meta" }, `还没有在${label}的比赛。`));
  const positions = new Map();
  for (const { game } of list) positions.set(game.player.pos, (positions.get(game.player.pos) || 0) + 1);
  const jungle = count(list, (entry) => entry.row.lane === "jungle");
  return el("article", { class: "lane-slot" },
    el("h4", {}, label, el("small", {}, `${list.length} 场`)),
    el("div", { class: "lane-results" },
      [["W", "优"], ["D", "均"], ["L", "劣"]].map(([key, text]) => el("span", { class: `lane-count lane-${key}` }, `${text} ${count(list, (entry) => entry.row.result === key)}`))),
    el("p", { class: "lane-positions" }, [...positions.entries()].sort((a, b) => (a[0] ?? 9) - (b[0] ?? 9))
      .map(([pos, games]) => `${pos ? `${pos} 号位` : "号位未知"} ${games} 场`).join("、")),
    jungle ? el("span", { class: "jungle-tag", title: "打野的比赛归入本队少人的这一路" }, `含打野 ${jungle} 场`) : null);
}

// A comparison table: metric | player | counterpart | league same position.
function compareTable(caption, lines, ui) {
  const { el } = ui;
  return el("div", { class: "table-scroll" }, el("table", { class: "data-table compare-table" },
    el("caption", {}, caption),
    el("thead", {}, el("tr", {}, ["", "本人", "对位", "联赛同号位"].map((text) => el("th", { scope: "col" }, text)))),
    el("tbody", {}, lines.map(([label, mine, theirs, league, better]) => {
      // Colour only a gap of more than 5% of the league average, so near-equal values stay neutral.
      const gap = Number.isFinite(mine) && Number.isFinite(league) && better ? mine - league : null;
      const ahead = gap === null || Math.abs(gap) <= Math.abs(league) * 0.05 ? null : better === "low" ? gap < 0 : gap > 0;
      return el("tr", {},
        el("th", { scope: "row" }, label),
        el("td", { class: `num${ahead === true ? " vs-good" : ahead === false ? " vs-bad" : ""}` }, line(mine, label)),
        el("td", { class: "num" }, line(theirs, label)),
        el("td", { class: "num" }, line(league, label)));
    }))));
  function line(value, label) {
    if (value === null || value === undefined || Number.isNaN(value)) return "—";
    if (typeof value === "string") return value;
    if (/时间|6 级/.test(label)) return minuteText(value);
    return Math.abs(value) >= 100 ? whole(value) : fixed(value, Number.isInteger(value) ? 0 : 1);
  }
}

function averageCurve(list, key) {
  return Array.from({ length: CHART_MINUTES + 1 }, (_, minute) => mean(list.map((entry) => entry.row[key]?.[minute])));
}

function curveSection(list, league, core, ui) {
  const { el } = ui;
  const metrics = core ? [["curve_lh", "正补差"], ["curve_gold", "经济差"], ["curve_xp", "经验差"]]
    : [["curve_xp", "经验差"], ["curve_lane", "本路经济合计差"], ["curve_gold", "经济差"]];
  const view = { key: metrics[0][0] };
  const box = el("div", { class: "curve-box" });
  const draw = () => {
    const label = metrics.find(([key]) => key === view.key)[1];
    const mine = averageCurve(list, view.key);
    const at = (curve, minute) => curve[minute];
    box.replaceChildren(
      el("div", { class: "map-row" }, metrics.map(([key, name]) => el("button", {
        type: "button", class: view.key === key ? "active" : "", "aria-pressed": String(view.key === key),
        onclick: () => { view.key = key; draw(); },
      }, name))),
      diffChart([
        { label: `本人平均（${list.length} 场）`, className: "total", values: mine },
        { label: `联赛同号位平均（${league.length} 人次）`, className: "league", values: averageCurve(league, view.key) },
      ], ui),
      el("p", { class: "draft-meta" }, `${label}按分钟取平均，高于 0 表示本人（或本路）领先对位。`,
        `5′ 时 ${signed(at(mine, 5))}，10′ 时 ${signed(at(mine, 10))}；5′→10′ 变化 ${signed(diff(at(mine, 10), at(mine, 5)))}。`));
  };
  draw();
  return box;
}

function deathSection(list, league, ui) {
  const { el } = ui;
  const parsed = parsedOf(list);
  const leagueParsed = parsedOf(league);
  if (!parsed.length) return el("p", { class: "draft-meta" }, "录像解析后显示对线期死亡。");
  const deaths = parsed.flatMap(deathsOf);
  const perGame = (n, games) => (games ? n / games : null);
  const leagueDeaths = leagueParsed.flatMap(deathsOf);
  const kinds = ["solo", "lane", "gank", "other"].map((kind) => [kind, count(deaths, (death) => death[1] === kind)]).filter(([, n]) => n);
  const phases = [[0, 300, "0–5′"], [300, 600, "5–10′"]].map(([from, to, label]) => [label, count(deaths, (death) => death[0] >= from && death[0] < to)]);
  const regions = Object.entries(deaths.reduce((acc, death) => ({ ...acc, [death[3] || "unknown"]: (acc[death[3] || "unknown"] || 0) + 1 }), {}));
  const fbKill = count(parsed, (entry) => entry.row.fb === "kill");
  const fbDeath = count(parsed, (entry) => entry.row.fb === "death");
  return el("div", { class: "death-summary" },
    compareTable(`对线期死亡与击杀（${parsed.length} 场有录像）`, [
      ["每场死亡", perGame(deaths.length, parsed.length), null, perGame(leagueDeaths.length, leagueParsed.length), "low"],
      ["每场参与击杀", avg(parsed, (entry) => entry.row.kills), null, avg(leagueParsed, (entry) => entry.row.kills), "high"],
      ["每次死亡损失金钱", mean(deaths.map((death) => death[4])), null, mean(leagueDeaths.map((death) => death[4])), "low"],
    ], ui),
    el("dl", { class: "fact-list" },
      el("dt", {}, "死亡类型"), el("dd", {}, kinds.length ? kinds.map(([kind, n]) => `${DEATH_KIND[kind]} ${n}`).join(" · ") : "没有死亡"),
      el("dt", {}, "时段"), el("dd", {}, phases.map(([label, n]) => `${label} ${n} 次`).join(" · ")),
      el("dt", {}, "地点"), el("dd", {}, regions.map(([region, n]) => `${REGION_NAME[region] || "未知"} ${n}`).join(" · ") || "—"),
      el("dt", {}, "损失金钱合计"), el("dd", {}, whole(deaths.reduce((sum, death) => sum + (death[4] || 0), 0))),
      el("dt", {}, "一血"), el("dd", {}, `参与拿下 ${fbKill} 次 · 被拿 ${fbDeath} 次（${parsed.length} 场）`)));
}

function heroAndOpponents(list, ui, core) {
  const { el } = ui;
  const group = (keyOf) => {
    const map = new Map();
    for (const entry of list) {
      const key = keyOf(entry);
      if (key === null || key === undefined) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(entry);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  };
  const mainDiff = (entries) => avg(entries, (entry) => (core ? diff(entry.row.lh10, entry.row.opp_lh10) : diff(entry.row.xp10, entry.row.opp_xp10)));
  const table = (caption, rows, keyLabel) => el("div", { class: "table-scroll" }, el("table", { class: "data-table compare-table" },
    el("caption", {}, caption),
    el("thead", {}, el("tr", {}, [keyLabel, "场次", "优 / 均 / 劣", core ? "10′ 正补差" : "10′ 经验差"].map((text) => el("th", { scope: "col" }, text)))),
    el("tbody", {}, rows.map(([hero, entries]) => el("tr", {},
      el("td", {}, ui.heroLabel(hero)),
      el("td", { class: "num" }, entries.length),
      el("td", { class: "num" }, ["W", "D", "L"].map((key) => count(entries, (entry) => entry.row.result === key)).join(" / ")),
      el("td", { class: `num ${toneClass(mainDiff(entries))}` }, signed(mainDiff(entries))))))));
  return el("div", { class: "pair-tables" },
    table("用过的英雄", group((entry) => entry.game.player.hero), "英雄"),
    table("遇到的对位英雄", group((entry) => entry.opp?.hero), "对位"));
}

function gameList(list, core, rowsByMatch, ui) {
  const { el } = ui;
  const ordered = [...list].sort((a, b) => b.game.match.start_time - a.game.match.start_time);
  const body = el("tbody");
  const render = (all) => body.replaceChildren(...(all ? ordered : ordered.slice(0, GAME_LIST)).map((entry) => {
    const { game, row } = entry;
    const partner = core ? null : partnerOf(entry, rowsByMatch);
    const cells = core
      ? [signed(diff(row.lh10, row.opp_lh10)), signed(diff(row.gold10, row.opp_gold10)), minuteText(row.level6)]
      : [signed(diff(row.xp10, row.opp_xp10)), partner ? signed(diff(partner.lh10, partner.opp_lh10)) : "—", `${row.obs ?? 0} / ${row.sen ?? 0}`];
    return el("tr", {},
      el("td", {}, el("a", { href: ui.matchHref(game.match.match_id) }, ui.formatDate(game.match.start_time))),
      el("td", {}, ui.heroIcon(game.player.hero), row.lane === "jungle" ? el("span", { class: "jungle-tag" }, "打野") : null),
      el("td", {}, entry.opp ? ui.heroIcon(entry.opp.hero) : "—"),
      el("td", {}, row.result ? el("span", { class: `lane lane-${row.result}` }, RESULT_TEXT[row.result]) : "—"),
      cells.map((text) => el("td", { class: `num ${toneClass(Number.parseFloat(String(text).replace(/[,+]/g, "")))}` }, text)),
      el("td", { class: "num" }, row.deaths ? row.deaths.length : "—"));
  }));
  render(false);
  const more = ordered.length > GAME_LIST
    ? el("button", { type: "button", class: "show-all", onclick: (event) => { render(true); event.target.remove(); } }, `显示全部 ${ordered.length} 场`) : null;
  return el("div", {},
    el("div", { class: "table-scroll" }, el("table", { class: "data-table recent-lanes" },
      el("caption", {}, `逐场（10 分钟时，差值为本人减对位）`),
      el("thead", {}, el("tr", {}, ["比赛", "英雄", "对位", "对线结果", ...(core ? ["正补差", "经济差", "6 级"] : ["经验差", "同路核心正补差", "假眼 / 真眼"]), "对线期死亡"]
        .map((text) => el("th", { scope: "col" }, text)))),
      body)),
    more);
}

function positionBlock(pos, list, league, rowsByMatch, ui) {
  const { el } = ui;
  const core = pos <= 3;
  const lanes = new Map();
  for (const { row } of list) lanes.set(ROLE_NAME[row.role], (lanes.get(ROLE_NAME[row.role]) || 0) + 1);
  const jungle = count(list, (entry) => entry.row.lane === "jungle");
  const results = ["W", "D", "L"].map((key) => count(list, (entry) => entry.row.result === key));
  const leagueWin = league.length ? count(league, (entry) => entry.row.result === "W") / league.length : null;
  const ahead = (key) => {
    const pairs = list.filter((entry) => Number.isFinite(entry.row[key]) && Number.isFinite(entry.row[`opp_${key}`]));
    return `${pairs.length} 场中 ${count(pairs, (entry) => entry.row[key] > entry.row[`opp_${key}`])} 场领先对位`;
  };
  const partners = core ? [] : list.map((entry) => partnerOf(entry, rowsByMatch)).filter(Boolean);
  const partnerDiffs = partners.map((partner) => diff(partner.lh10, partner.opp_lh10)).filter(Number.isFinite);
  const leaguePartnerDiff = core ? null : mean(league.map((entry) => partnerOf(entry, rowsByMatch)).filter(Boolean).map((partner) => diff(partner.lh10, partner.opp_lh10)));

  const cards = [
    ui.statCard("对线结果", el("span", { class: "lane-results" }, ["优", "均", "劣"].map((text, index) =>
      el("span", { class: `lane-count lane-${["W", "D", "L"][index]}` }, `${text} ${results[index]}`))),
    leagueWin === null ? "" : `本人优率 ${Math.round((results[0] / list.length) * 100)}% · 联赛同号位 ${Math.round(leagueWin * 100)}%`),
    core
      ? ui.statCard("10′ 正补（本人 vs 对位）", `${whole(avg(list, (entry) => entry.row.lh10))} vs ${whole(avg(list, (entry) => entry.row.opp_lh10))}`, ahead("lh10"))
      : ui.statCard("10′ 经验（本人 vs 对位）", `${whole(avg(list, (entry) => entry.row.xp10))} vs ${whole(avg(list, (entry) => entry.row.opp_xp10))}`, ahead("xp10")),
    core
      ? ui.statCard("10′ 经济差（平均）", el("span", { class: toneClass(avg(list, (entry) => diff(entry.row.gold10, entry.row.opp_gold10)), 50) },
        signed(avg(list, (entry) => diff(entry.row.gold10, entry.row.opp_gold10)))), ahead("gold10"))
      : ui.statCard("同路核心 10′ 正补差", el("span", { class: toneClass(mean(partnerDiffs)) }, signed(mean(partnerDiffs))),
        `${partnerDiffs.length} 场中 ${count(partnerDiffs, (value) => value > 0)} 场领先 · 联赛同号位 ${signed(leaguePartnerDiff)}`),
  ];

  const leagueAvg = (pick) => avg(league, pick);
  const growth = compareTable(core ? "补刀与等级" : "等级", [
    ...(core ? [
      ["5′ 正补", avg(list, (entry) => entry.row.lh5), avg(list, (entry) => entry.row.opp_lh5), leagueAvg((entry) => entry.row.lh5), "high"],
      ["10′ 正补", avg(list, (entry) => entry.row.lh10), avg(list, (entry) => entry.row.opp_lh10), leagueAvg((entry) => entry.row.lh10), "high"],
      ["10′ 反补", avg(list, (entry) => entry.row.dn10), null, leagueAvg((entry) => entry.row.dn10), "high"],
      ["10′ 经济", avg(list, (entry) => entry.row.gold10), avg(list, (entry) => entry.row.opp_gold10), leagueAvg((entry) => entry.row.gold10), "high"],
    ] : [
      ["10′ 经验", avg(list, (entry) => entry.row.xp10), avg(list, (entry) => entry.row.opp_xp10), leagueAvg((entry) => entry.row.xp10), "high"],
    ]),
    ["6 级时间", avg(list, (entry) => entry.row.level6), avg(list, (entry) => entry.row.opp_level6), leagueAvg((entry) => entry.row.level6), "low"],
    ["10′ 等级", avg(list, (entry) => entry.row.lvl10), avg(list, (entry) => entry.row.opp_lvl10), leagueAvg((entry) => entry.row.lvl10), "high"],
  ], ui);

  const firstItems = new Map();
  for (const { row } of list) if (row.first_item) firstItems.set(row.first_item[1], (firstItems.get(row.first_item[1]) || 0) + 1);
  const topItem = [...firstItems.entries()].sort((a, b) => b[1] - a[1])[0];
  const roamLine = (entries) => [
    ["每场游走", avg(parsedOf(entries), (entry) => entry.row.roams?.length), null, leagueAvg((entry) => (entry.row.deaths ? entry.row.roams?.length : null)), null],
    ["游走中参与击杀（合计）", total(parsedOf(entries), (entry) => entry.row.roam_kills), null, null, null],
  ];
  const special = core
    ? compareTable("出装与资源", [
      ["鞋子时间", avg(list, (entry) => entry.row.boots), null, leagueAvg((entry) => entry.row.boots), "low"],
      ["第一件大件时间", avg(list, (entry) => entry.row.first_item?.[0]), null, leagueAvg((entry) => entry.row.first_item?.[0]), "low"],
      ...(pos === 2 ? [["10′ 前能量符", avg(list, (entry) => entry.row.runes?.power), null, leagueAvg((entry) => entry.row.runes?.power), "high"]] : []),
      ["10′ 前赏金符", avg(list, (entry) => entry.row.runes?.bounty), null, leagueAvg((entry) => entry.row.runes?.bounty), "high"],
      ...roamLine(list),
    ], ui)
    : compareTable("视野、拉野与游走", [
      ["每场假眼", avg(list, (entry) => entry.row.obs), null, leagueAvg((entry) => entry.row.obs), "high"],
      ["每场真眼", avg(list, (entry) => entry.row.sen), null, leagueAvg((entry) => entry.row.sen), "high"],
      ["假眼平均存活时间", avg(list, (entry) => entry.row.obs_life), null, leagueAvg((entry) => entry.row.obs_life), "high"],
      ["每场假眼被排", avg(list, (entry) => entry.row.obs_lost), null, leagueAvg((entry) => entry.row.obs_lost), "low"],
      ["每场排眼", avg(list, (entry) => entry.row.dewards), null, leagueAvg((entry) => entry.row.dewards), "high"],
      ["10′ 堆野", avg(list, (entry) => entry.row.stacks), null, leagueAvg((entry) => entry.row.stacks), "high"],
      ["10′ 前赏金符 + 水符", avg(list, (entry) => (entry.row.runes ? entry.row.runes.bounty + entry.row.runes.water : null)), null,
        leagueAvg((entry) => (entry.row.runes ? entry.row.runes.bounty + entry.row.runes.water : null)), "high"],
      ...roamLine(list),
      ["游走期间本路经济变化（平均每次）", mean(parsedOf(list).flatMap((entry) => (entry.row.roams?.length ? [entry.row.roam_swing / entry.row.roams.length] : []))), null, null, "high"],
    ], ui);

  return el("article", { class: "position-block" },
    el("h4", {}, POSITION_NAME[pos] || `${pos} 号位`, el("small", {},
      `${list.length} 场 · ${[...lanes.entries()].map(([lane, games]) => `${lane} ${games} 场`).join("、")} · 联赛同号位 ${league.length} 人次`),
      jungle ? el("span", { class: "jungle-tag" }, `含打野 ${jungle} 场`) : null,
      list.length < SMALL_SAMPLE ? el("span", { class: "sample-tag" }, "样本少，只看方向") : null),
    el("div", { class: "stat-cards" }, cards),
    el("h5", {}, "过程：每分钟和对位的差"),
    curveSection(list, league, core, ui),
    el("div", { class: "position-grid" },
      el("div", {}, growth),
      el("div", {}, deathSection(list, league, ui)),
      el("div", {}, special,
        core && topItem ? el("p", { class: "draft-meta" }, `最常见的第一件大件：${ui.itemName(topItem[0])}（${topItem[1]} 场）`) : null)),
    el("h5", {}, "英雄与对手"),
    heroAndOpponents(list, ui, core),
    el("h5", {}, "逐场"),
    gameList(list, core, rowsByMatch, ui));
}

export function laneSection(games, matches, ui) {
  const { el } = ui;
  const box = el("div", { class: "lane-slots" }, el("p", { class: "draft-meta" }, "正在读取对线数据……"));
  loadLanes().then((rows) => {
    const visible = new Set(matches.map((match) => match.match_id));
    const byKey = new Map(rows.map((row) => [`${row.match_id}:${row.slot}`, row]));
    const rowsByMatch = new Map();
    for (const row of rows) {
      if (!rowsByMatch.has(row.match_id)) rowsByMatch.set(row.match_id, []);
      rowsByMatch.get(row.match_id).push(row);
    }
    const withOpp = (game, row) => ({ game, row, opp: row.opp === null ? null : game.match.players.find((player) => player.slot === row.opp) });
    const mine = games.map((game) => [game, byKey.get(`${game.match.match_id}:${game.player.slot}`)]).filter(([, row]) => row)
      .map(([game, row]) => withOpp(game, row));
    const everyone = matches.flatMap((match) => match.players.map((player) => [{ match, player }, byKey.get(`${match.match_id}:${player.slot}`)]))
      .filter(([, row]) => row && visible.has(row.match_id)).map(([game, row]) => withOpp(game, row));
    const positions = [1, 2, 3, 4, 5].map((pos) => [pos, mine.filter((entry) => entry.game.player.pos === pos)]).filter(([, list]) => list.length);
    const loose = count(mine, (entry) => entry.row.role === "jungle");
    box.replaceChildren(
      el("h3", { class: "lane-layer" }, "三路概况"),
      el("p", { class: "draft-meta" }, "这一路双方 10 分钟经济总和领先 10% 以上为优，落后 10% 以上为劣。分路按录像里 2:00–8:00 的位置判定，打野归入本队少人的那一路。",
        loose ? ` 另有 ${loose} 场打野没有归入某一路。` : ""),
      el("div", { class: "lane-slot-grid" }, ROLES.map(([role, label]) => laneOverview(mine.filter((entry) => entry.row.role === role), label, ui))),
      el("h3", { class: "lane-layer" }, "号位表现"),
      el("p", { class: "draft-meta" }, "对线期指 10 分钟前。对位是对线期同一路对面同类（核心或辅助）的英雄；联赛同号位是所选时间内所有打这个号位的出场。",
        "表格里本人一栏绿色表示比联赛同号位平均好 5% 以上、红色表示差 5% 以上（时间类越早越好，死亡越少越好）。"),
      ...(positions.length ? positions.map(([pos, list]) => positionBlock(pos, list, everyone.filter((entry) => entry.game.player.pos === pos), rowsByMatch, ui))
        : [el("p", { class: "draft-meta" }, "没有号位数据。")]));
  });
  return box;
}
