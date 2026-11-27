// Stats list page: matches, heroes and items, players. Each match and player opens its own page.

import {
  MIN_RATE_GAMES, average, averageDims, bindRange, comebackTag, el, estimateTag, formatDate, formatDuration, hero, heroIcon, heroLabel, item, itemLabel, kda,
  loadData, matchHref, minutes, percent, playerHref, playerName, playerSummary, rangeParams, rate, record, section, smoothed,
  sortableTable, state, statCard, teamPanel, visibleMatches, won,
} from "./stats-core.js?v=18";

function renderMatches(panel, matches) {
  panel.append(section("比赛", `共 ${matches.length} 场。卡片显示每位选手的英雄、号位、装备、评分（由 STRATZ IMP 换算的百分制）、评级和本局称号，悬停称号或评级可看判定条件；胜方胜率曾跌到 20% 以下的比赛标“翻盘”，IMP 为本站估算的比赛标“估算”；点“详情”打开这场比赛的页面，查看 BP、完整数据、出装时间、经济曲线、地图和死亡复盘。`));
  for (const match of [...matches].reverse()) {
    panel.append(el("article", { class: "match-card", id: `match-${match.match_id}` },
      el("div", { class: "match-head" },
        el("span", { class: "match-when" }, formatDate(match.start_time), el("small", {}, `时长 ${formatDuration(match.duration)}`), estimateTag(match), comebackTag(match)),
        el("span", { class: "match-score" },
          el("b", { class: match.radiant_win ? "radiant won" : "radiant" }, "天辉"),
          `${match.radiant_score} : ${match.dire_score}`,
          el("b", { class: match.radiant_win ? "dire" : "dire won" }, "夜魇")),
        el("a", { class: "match-toggle", href: matchHref(match.match_id) }, "详情 →")),
      el("div", { class: "match-teams" }, teamPanel(match, true), teamPanel(match, false))));
  }
}

// ---------- 英雄与装备 ----------

function heroRows(matches) {
  const rows = new Map();
  const entry = (id) => {
    if (!rows.has(id)) rows.set(id, { id, picks: 0, bans: 0, wins: 0, players: [] });
    return rows.get(id);
  };
  for (const match of matches) {
    for (const player of match.players) {
      const row = entry(player.hero);
      row.picks += 1;
      row.wins += won(match, player) ? 1 : 0;
      row.players.push(player);
    }
    for (const [, isPick, , heroId] of match.picks_bans) {
      if (!isPick) entry(heroId).bans += 1;
    }
  }
  return [...rows.values()];
}

function itemRows(matches, filter = () => true) {
  const rows = new Map();
  let games = 0;
  for (const match of matches) {
    for (const player of match.players) {
      if (!filter(player)) continue;
      games += 1;
      for (const [key, time] of Object.entries(player.built)) {
        if (!rows.has(key)) rows.set(key, { key, count: 0, wins: 0, times: [], heroes: new Map() });
        const row = rows.get(key);
        row.count += 1;
        row.wins += won(match, player) ? 1 : 0;
        if (time !== null) row.times.push(time);
        row.heroes.set(player.hero, (row.heroes.get(player.hero) || 0) + 1);
      }
    }
  }
  return { rows: [...rows.values()], games };
}

function renderHeroes(panel, matches) {
  const games = matches.length;
  const radiantWins = matches.filter((match) => match.radiant_win).length;
  panel.append(
    el("div", { class: "stat-cards" },
      statCard("场次", String(games)),
      statCard("天辉战绩", record(radiantWins, games), `夜魇 ${record(games - radiantWins, games)}`),
      statCard("平均时长", games ? formatDuration(Math.round(average(matches.map((match) => match.duration)))) : "—")),
    el("p", { class: "draft-meta sample-note" }, `样本较少：不足 ${MIN_RATE_GAMES} 场时不显示胜率百分比，排序按平滑胜率 (胜+1)/(场+2)。`),
  );

  const heroes = heroRows(matches);
  panel.append(section("英雄", "选用、禁用均按场次计算；争夺率 = (选用 + 禁用) / 场次。",
    sortableTable("heroes", [
      { key: "name", label: "英雄", value: (row) => hero(row.id).name, render: (row) => heroLabel(row.id) },
      { key: "picks", label: "选用", value: (row) => row.picks, align: "num" },
      { key: "pickRate", label: "选用率", value: (row) => row.picks / games, render: (row) => percent(row.picks, games), align: "num" },
      { key: "bans", label: "禁用", value: (row) => row.bans, align: "num" },
      { key: "banRate", label: "禁用率", value: (row) => row.bans / games, render: (row) => percent(row.bans, games), align: "num" },
      { key: "contest", label: "争夺率", value: (row) => (row.picks + row.bans) / games, render: (row) => percent(row.picks + row.bans, games), align: "num" },
      { key: "record", label: "胜负", value: (row) => row.wins - (row.picks - row.wins), render: (row) => (row.picks ? record(row.wins, row.picks) : "—"), align: "num" },
      { key: "rate", label: "胜率", value: (row) => (row.picks ? smoothed(row.wins, row.picks) : -1), render: (row) => rate(row.wins, row.picks), align: "num" },
      { key: "kda", label: "平均 K/D/A", value: (row) => kda(row.players).ratio, render: (row) => (row.picks ? kda(row.players).text : "—"), align: "num" },
    ], heroes, "contest")));

  const { rows, games: playerGames } = itemRows(matches);
  panel.append(section("装备", "出装率 = 出过该装备的人次 / 全部出场人次。装备胜率受经济影响，赢的一方通常装备更多，只作参考。",
    sortableTable("items", [
      { key: "name", label: "装备", value: (row) => item(row.key).name, render: (row) => itemLabel(row.key) },
      { key: "count", label: "出装人次", value: (row) => row.count, align: "num" },
      { key: "share", label: "出装率", value: (row) => row.count, render: (row) => percent(row.count, playerGames), align: "num" },
      { key: "record", label: "胜负", value: (row) => row.wins - (row.count - row.wins), render: (row) => record(row.wins, row.count), align: "num" },
      { key: "rate", label: "胜率", value: (row) => smoothed(row.wins, row.count), render: (row) => rate(row.wins, row.count), align: "num" },
      { key: "time", label: "平均首购", value: (row) => (row.times.length ? average(row.times) : Infinity), render: (row) => (row.times.length ? minutes(average(row.times)) : "—"), align: "num" },
      { key: "heroes", label: "常用英雄", sortable: false, value: () => 0, render: (row) =>
        el("span", { class: "hero-row" }, [...row.heroes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => heroIcon(id))) },
    ], rows, "count")));
}
// ---------- 纪录墙 ----------

const RECORDS = [
  { label: "最高评分", value: (player) => player.score, format: (value) => `${Math.round(value)} 分` },
  { label: "最多击杀", value: (player) => player.k },
  { label: "最多助攻", value: (player) => player.a },
  { label: "最高 GPM", value: (player) => player.gpm },
  { label: "最高 XPM", value: (player) => player.xpm },
  { label: "最多正补", value: (player) => player.lh },
  { label: "最高英雄伤害", value: (player) => player.hd },
  { label: "最高建筑伤害", value: (player) => player.td },
  { label: "最高治疗", value: (player) => player.hh },
  { label: "最多插眼", value: (player) => (Number.isFinite(player.obs) ? player.obs + (player.sen ?? 0) : null) },
  { label: "最多堆野", value: (player) => player.stacks },
  { label: "最长控制", value: (player) => player.stuns, format: (value) => `${value} 秒` },
];

function recordWall(matches) {
  const cards = RECORDS.map((record) => {
    let best = null;
    for (const match of matches) {
      for (const player of match.players) {
        const value = record.value(player);
        if (Number.isFinite(value) && value > 0 && (!best || value > best.value)) best = { value, match, player };
      }
    }
    if (!best) return null;
    return el("a", { class: "record-card", href: matchHref(best.match.match_id), title: "查看这场比赛" },
      el("span", { class: "record-label" }, record.label),
      el("strong", {}, record.format ? record.format(best.value) : best.value.toLocaleString()),
      el("span", { class: "record-who" }, heroIcon(best.player.hero), best.player.account_id ? playerName(best.player.account_id) : "匿名"),
      el("small", {}, `${hero(best.player.hero).name} · ${formatDate(best.match.start_time)}`));
  });
  return section("纪录墙", "所选时间内的单场最佳，点击查看那场比赛。", el("div", { class: "record-grid" }, cards));
}

// ---------- 选手 ----------

function renderPlayers(panel, matches) {
  const byPlayer = new Map();
  for (const match of matches) {
    for (const player of match.players) {
      if (!player.account_id) continue;
      if (!byPlayer.has(player.account_id)) byPlayer.set(player.account_id, []);
      byPlayer.get(player.account_id).push({ match, player, won: won(match, player) });
    }
  }
  const roster = [...byPlayer.entries()].sort((a, b) =>
    b[1].length - a[1].length || playerName(a[0]).localeCompare(playerName(b[0]), "zh-CN"));
  panel.append(recordWall(matches));
  panel.append(section("选手", `所选时间内出场的 ${roster.length} 名选手。评分由 STRATZ 的 IMP 换算成百分制：IMP 与同段位、同英雄、同号位的玩家比较，0 为平均；联赛 IMP 接近标准差约 20 的正态分布：低于平均时评分 = 10 + 100 × Φ(IMP ÷ 30)，扣分放缓，最低约 10 分；IMP 为 0 时 60 分；高于平均时评分 = 60 + 80 × (Φ(IMP ÷ 20) − 0.5)，中段拉开、顶端逐渐逼近 100。评级 S ≥ 92、A ≥ 80、B ≥ 60、C ≥ 40，其余为 D。MVP 是胜方评分最高的人，达到 95（IMP +30）为 SMVP。STRATZ 不给 IMP 的比赛（有凯的比赛一律不评）用本站模型估算 IMP，比赛时长旁标“估算”。卡片底部汇总所选时间内获得的全部称号。雷达图和能力条是六项能力的 OpenDota 同英雄百分位，只描述打法风格，核心和辅助看的数据不同（悬停能力名可看具体口径），虚线、竖线为联赛平均。号位柱子高度为场次，金色部分为胜场，号位为 OpenDota 根据录像的估计。每个号位顶部的小格是天梯位置分：最近 100 场公开比赛按号位胜率换算的估分（不随上面的时间范围变化），红底为打得最多的号位，虚线灰格为少于 10 场、按综合分减 500 计；名字下的标签是打得最多的号位。点卡片打开选手页，查看对线、死亡、场均数据、英雄池和比赛记录。`));
  const leagueDims = averageDims(matches.flatMap((match) => match.players));
  const range = rangeParams();
  const grid = el("div", { class: "player-grid" });
  for (const [accountId, games] of roster) {
    grid.append(el("article", { class: "player-card", id: `player-${accountId}` },
      el("a", { class: "player-card-head", href: playerHref(accountId, range) }, playerSummary(accountId, games, leagueDims))));
  }
  panel.append(grid);
}

// ---------- 页面 ----------

const TABS = ["matches", "heroes", "players"];
let tab = "matches";

function render() {
  const matches = visibleMatches();
  for (const button of document.querySelectorAll("[role=tab]")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  }
  for (const name of TABS) {
    const panel = document.querySelector(`#panel-${name}`);
    panel.hidden = name !== tab;
    if (name !== tab) continue;
    panel.replaceChildren();
    if (name === "matches") renderMatches(panel, matches);
    if (name === "heroes") renderHeroes(panel, matches);
    if (name === "players") renderPlayers(panel, matches);
  }
  document.querySelector("#statsStatus").textContent =
    `所选时间内 ${matches.length} 场 · 全部 ${state.matches.length} 场 · 时间为日本时间`;
}

// Old links opened a match or player card in place; they now go to its own page.
function redirectOldLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  const match = Number(params.get("match"));
  const player = Number(params.get("player"));
  if (match) location.replace(matchHref(match));
  else if (player) location.replace(playerHref(player));
  else return false;
  return true;
}

function readTab() {
  const name = new URLSearchParams(location.hash.slice(1)).get("tab");
  tab = TABS.includes(name) ? name : "matches";
}

async function load() {
  if (redirectOldLink()) return;
  try {
    await loadData();
  } catch (error) {
    document.querySelector("#statsStatus").textContent = "数据读取失败，请稍后刷新。";
    console.error(error);
    return;
  }
  if (!state.matches.length) {
    document.querySelector("#statsStatus").textContent = "还没有可统计的比赛。";
    return;
  }
  readTab();
  state.rerender = render;
  for (const button of document.querySelectorAll("[role=tab]")) {
    button.addEventListener("click", () => {
      tab = button.dataset.tab;
      history.replaceState(null, "", `#${new URLSearchParams({ tab })}`);
      render();
    });
  }
  window.addEventListener("hashchange", () => {
    if (redirectOldLink()) return;
    readTab();
    render();
  });
  bindRange(render);
}

load();
