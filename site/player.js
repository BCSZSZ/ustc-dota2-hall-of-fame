// Player page: player.html?id=<account_id>[&from=YYYY-MM-DD&to=YYYY-MM-DD].

import { laneSlots } from "./lanes.js?v=3";
import {
  LANE_TEXT, averageDims, averageOf, bindRange, el, formatDate, gamesOf, gradeBadge, hero, heroIcon, heroLabel, kda,
  loadData, matchHref, meanOf, playerName, playerSummary, rate, record, rounded, scoreText, section,
  smoothed, sortableTable, state, statCard, titleChip, visibleMatches,
} from "./stats-core.js?v=2";

function playerDetail(games, matches) {
  const everyone = matches.flatMap((match) => match.players);
  const mine = games.map((game) => game.player);
  const league = (key) => `联赛平均 ${rounded(averageOf(everyone, key))}`;
  const heroes = new Map();
  for (const game of games) {
    if (!heroes.has(game.player.hero)) heroes.set(game.player.hero, { id: game.player.hero, games: [], wins: 0 });
    const row = heroes.get(game.player.hero);
    row.games.push(game.player);
    row.wins += game.won ? 1 : 0;
  }

  return el("div", { class: "player-detail" },
    section("对线", null, laneSlots(games, { el, heroIcon, formatDate, matchHref, heroName: (id) => hero(id).name })),
    section("场均数据", null, el("div", { class: "stat-cards" },
      statCard("K/D/A", kda(mine).text, `联赛平均 ${kda(everyone).text}`),
      statCard("GPM", rounded(averageOf(mine, "gpm")), league("gpm")),
      statCard("XPM", rounded(averageOf(mine, "xpm")), league("xpm")),
      statCard("正补", rounded(averageOf(mine, "lh")), league("lh")),
      statCard("英雄伤害", rounded(averageOf(mine, "hd")), league("hd")),
      statCard("建筑伤害", rounded(averageOf(mine, "td")), league("td")))),
    section("英雄池", null, sortableTable("playerHeroes", [
      { key: "name", label: "英雄", value: (row) => hero(row.id).name, render: (row) => heroLabel(row.id) },
      { key: "games", label: "场次", value: (row) => row.games.length, align: "num" },
      { key: "record", label: "胜负", value: (row) => row.wins - (row.games.length - row.wins), render: (row) => record(row.wins, row.games.length), align: "num" },
      { key: "rate", label: "胜率", value: (row) => smoothed(row.wins, row.games.length), render: (row) => rate(row.wins, row.games.length), align: "num" },
      { key: "kda", label: "平均 K/D/A", value: (row) => kda(row.games).ratio, render: (row) => kda(row.games).text, align: "num" },
      { key: "score", label: "评分", value: (row) => meanOf(row.games.map((player) => player.score)) ?? -1, render: (row) => scoreText(meanOf(row.games.map((player) => player.score))), align: "num" },
      { key: "gold10", label: "10 分钟经济", value: (row) => averageOf(row.games, "gold10") ?? -1, render: (row) => rounded(averageOf(row.games, "gold10")), align: "num" },
      { key: "gpm", label: "GPM", value: (row) => averageOf(row.games, "gpm") ?? -1, render: (row) => rounded(averageOf(row.games, "gpm")), align: "num" },
    ], [...heroes.values()], "games")),
    section("比赛记录", null, el("div", { class: "table-scroll" }, el("table", { class: "data-table" },
      el("thead", {}, el("tr", {}, ["结果", "时间", "英雄", "评分", "称号", "位置", "K/D/A", "10 分钟经济", "对线", ""].map((label) => el("th", { scope: "col" }, label)))),
      el("tbody", {}, [...games].reverse().map((game) => el("tr", {},
        el("td", {}, el("span", { class: game.won ? "result win" : "result" }, game.won ? "胜" : "负")),
        el("td", {}, formatDate(game.match.start_time)),
        el("td", {}, heroLabel(game.player.hero)),
        el("td", { class: "num" }, gradeBadge(game.player), scoreText(game.player.score)),
        el("td", {}, (game.player.titles || []).map((name) => titleChip(name))),
        el("td", { class: "num" }, game.player.pos ? `${game.player.pos} 号位` : "—"),
        el("td", { class: "num" }, `${game.player.k}/${game.player.d}/${game.player.a}`),
        el("td", { class: "num" }, rounded(game.player.gold10 ?? null)),
        el("td", { class: "num" }, game.player.lane ? el("span", { class: `lane lane-${game.player.lane}` }, LANE_TEXT[game.player.lane]) : "—"),
        el("td", {}, el("a", { href: matchHref(game.match.match_id) }, "查看比赛")))))))));
}

async function load() {
  const status = document.querySelector("#statsStatus");
  const params = new URLSearchParams(location.search);
  const accountId = Number(params.get("id"));
  try {
    await loadData();
  } catch (error) {
    status.textContent = "数据读取失败，请稍后刷新。";
    console.error(error);
    return;
  }
  if (!accountId || !gamesOf(accountId, state.matches).length) {
    status.textContent = accountId ? "这名选手没有计入光荣榜的比赛。" : "链接里缺少选手 ID。";
    return;
  }
  const name = playerName(accountId);
  document.title = `${name} · 科大光荣榜`;
  document.querySelector("#playerTitle").textContent = name;
  const page = document.querySelector("#playerPage");
  state.rerender = () => {
    const matches = visibleMatches();
    const games = gamesOf(accountId, matches);
    status.textContent = `所选时间内 ${games.length} 场 · 全部 ${gamesOf(accountId, state.matches).length} 场 · 时间为日本时间`;
    if (!games.length) {
      page.replaceChildren(el("p", { class: "draft-meta" }, "所选时间内没有这名选手的比赛。"));
      return;
    }
    page.replaceChildren(
      el("div", { class: "player-card open player-page-head" },
        el("div", { class: "player-card-head" }, playerSummary(accountId, games, averageDims(matches.flatMap((match) => match.players))))),
      playerDetail(games, matches));
  };
  bindRange(state.rerender, { from: params.get("from"), to: params.get("to") });
}

load();
