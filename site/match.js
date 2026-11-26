// Match page: match.html?id=<match_id>.

import { deathReview } from "./deaths.js?v=2";
import { laneReview } from "./lanes.js?v=4";
import { matchMap } from "./map.js?v=2";
import {
  LANE_TEXT, SMVP_MARGIN, el, formatDate, formatDuration, hero, heroIcon, heroLabel, isMvp, isRadiant,
  item, itemIcon, loadData, minutes, mvpBadge, playerLink, scoreText, state, teamPanel,
} from "./stats-core.js?v=3";

const LANES = { top: "上路", mid: "中路", bot: "下路" };
const TOWER_TIERS = { 1: "一塔", 2: "二塔", 3: "高地塔", 4: "基地塔" };
const details = new Map();

// ---------- 比赛 ----------

function buildingName(key) {
  const side = key.includes("goodguys") ? "天辉" : "夜魇";
  const tower = key.match(/tower(\d)_?(top|mid|bot)?/);
  if (tower) return `${side}${tower[2] ? LANES[tower[2]] : ""}${TOWER_TIERS[tower[1]] || "防御塔"}`;
  const barracks = key.match(/(melee|range)_rax_(top|mid|bot)/);
  if (barracks) return `${side}${LANES[barracks[2]]}${barracks[1] === "melee" ? "近战" : "远程"}兵营`;
  if (key.includes("fort")) return `${side}基地`;
  return null;
}

function advantageChart(gold, xp) {
  const width = 720;
  const height = 220;
  const pad = { left: 52, right: 12, top: 14, bottom: 26 };
  const length = Math.max(gold.length, xp.length);
  if (length < 2) return el("p", { class: "draft-meta" }, "这场没有经济曲线数据。");
  const peak = Math.max(1000, ...gold.map(Math.abs), ...xp.map(Math.abs));
  const x = (index) => pad.left + (index / (length - 1)) * (width - pad.left - pad.right);
  const y = (value) => pad.top + ((peak - value) / (2 * peak)) * (height - pad.top - pad.bottom);
  const line = (values) => values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const ticks = [];
  for (let minute = 0; minute < length; minute += 10) {
    ticks.push(`<line x1="${x(minute)}" x2="${x(minute)}" y1="${pad.top}" y2="${height - pad.bottom}" class="grid"/>`,
      `<text x="${x(minute)}" y="${height - 8}" text-anchor="middle">${minute}′</text>`);
  }
  const label = (value) => `${value > 0 ? "+" : ""}${(value / 1000).toFixed(0)}k`;
  const svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="天辉经济与经验优势曲线">
    ${ticks.join("")}
    <line x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}" class="zero"/>
    <text x="${pad.left - 6}" y="${y(peak) + 4}" text-anchor="end">${label(peak)}</text>
    <text x="${pad.left - 6}" y="${y(0) + 4}" text-anchor="end">0</text>
    <text x="${pad.left - 6}" y="${y(-peak) + 4}" text-anchor="end">${label(-peak)}</text>
    <polyline points="${line(xp)}" class="xp"/>
    <polyline points="${line(gold)}" class="gold"/>
  </svg>`;
  const figure = el("figure", { class: "adv-chart" });
  figure.innerHTML = svg;
  figure.append(el("figcaption", {}, el("span", { class: "key gold" }, "经济差"), el("span", { class: "key xp" }, "经验差"), " · 高于 0 为天辉领先"));
  return figure;
}

function loadDetail(match) {
  if (!details.has(match.match_id)) {
    const empty = { gold_adv: [], xp_adv: [], objectives: [], wards: [] };
    details.set(match.match_id, fetch(`./data/matches/${match.match_id}.json`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : empty))
      .catch(() => empty));
  }
  return details.get(match.match_id);
}

function renderMap(container, match) {
  container.replaceChildren(el("p", { class: "draft-meta" }, "正在读取地图数据……"));
  loadDetail(match).then((data) =>
    container.replaceChildren(matchMap(match, data, { el, heroIcon, heroLabel, heroName: (id) => hero(id).name })));
}

function renderLanes(container, match) {
  container.replaceChildren(el("p", { class: "draft-meta" }, "正在读取对线数据……"));
  loadDetail(match).then((data) => container.replaceChildren(
    laneReview(match, data, { el, heroIcon, playerLink, heroName: (id) => hero(id).name })));
}

function renderTimeline(container, match) {
  container.replaceChildren(el("p", { class: "draft-meta" }, "正在读取曲线……"));
  loadDetail(match).then((data) => drawTimeline(container, data));
}

function drawTimeline(container, data) {
  container.replaceChildren();
  container.append(advantageChart(data.gold_adv || [], data.xp_adv || []));
  const events = (data.objectives || []).flatMap((objective) => {
    if (objective.type === "CHAT_MESSAGE_ROSHAN_KILL") {
      return [{ time: objective.time, text: `${objective.team === 2 ? "天辉" : "夜魇"}击杀肉山`, side: objective.team === 2 ? "radiant" : "dire" }];
    }
    if (objective.type === "building_kill" && objective.key) {
      const name = buildingName(objective.key);
      if (!name) return [];
      return [{ time: objective.time, text: `${name}被摧毁`, side: objective.key.includes("goodguys") ? "dire" : "radiant" }];
    }
    return [];
  });
  if (events.length) {
    container.append(el("h3", {}, "肉山与建筑"), el("ol", { class: "event-list" },
      events.map((event) => el("li", { class: event.side }, el("b", {}, minutes(event.time)), event.text))));
  }
}

function scoreboard(match, radiant) {
  const players = match.players.filter((player) => isRadiant(player) === radiant);
  const teamWon = radiant === match.radiant_win;
  const rows = players.map((player) =>
    el("tr", {},
      el("td", {}, playerLink(player.account_id), isMvp(match, player) ? mvpBadge(player.relative >= SMVP_MARGIN) : null),
      el("td", {}, heroLabel(player.hero)),
      el("td", { class: "num" }, el("b", {}, scoreText(player.score))),
      el("td", { class: "num" }, player.pos ? `${player.pos} 号位` : "—"),
      el("td", { class: "num" }, `${player.k}/${player.d}/${player.a}`),
      el("td", { class: "num" }, `${player.lh}/${player.dn}`),
      el("td", { class: "num" }, `${player.gpm}/${player.xpm}`),
      el("td", { class: "num" }, (player.nw ?? 0).toLocaleString()),
      el("td", { class: "num" }, (player.hd ?? 0).toLocaleString()),
      el("td", { class: "num" }, (player.td ?? 0).toLocaleString()),
      el("td", { class: "num" }, (player.hh ?? 0).toLocaleString()),
      el("td", { class: "num" }, player.gold10 === null || player.gold10 === undefined ? "—" : player.gold10.toLocaleString()),
      el("td", { class: "num" }, player.lane ? el("span", { class: `lane lane-${player.lane}` }, LANE_TEXT[player.lane]) : "—"),
      el("td", { class: "items" }, el("span", { class: "item-list" },
        player.items.map(itemIcon),
        player.neutral ? el("span", { class: "neutral" }, itemIcon(player.neutral)) : null,
        player.scepter ? el("span", { class: "buff", title: "已吃神杖" }, "杖") : null,
        player.shard ? el("span", { class: "buff", title: "已吃魔晶" }, "晶") : null)),
    ));
  return el("div", { class: `team ${radiant ? "radiant" : "dire"}` },
    el("h3", {}, radiant ? "天辉" : "夜魇", el("span", { class: teamWon ? "result win" : "result" }, teamWon ? "胜" : "负"),
      el("small", {}, `击杀 ${radiant ? match.radiant_score : match.dire_score}`)),
    el("div", { class: "table-scroll" }, el("table", { class: "data-table scoreboard" },
      el("thead", {}, el("tr", {}, ["选手", "英雄", "评分", "位置", "K/D/A", "正/反补", "GPM/XPM", "净值", "英雄伤害", "建筑伤害", "治疗", "10′ 经济", "对线", "装备"].map((label) => el("th", { scope: "col" }, label)))),
      el("tbody", {}, rows))));
}

function buildTimes(match) {
  return el("div", { class: "build-times" }, match.players.map((player) => {
    const entries = Object.entries(player.built).sort((a, b) => (a[1] ?? Infinity) - (b[1] ?? Infinity));
    return el("div", { class: `build-row ${isRadiant(player) ? "radiant" : "dire"}` },
      heroLabel(player.hero),
      el("span", { class: "chips" }, entries.map(([key, time]) =>
        el("span", { class: "chip", title: item(key).name }, itemIcon(key), time === null ? "终局" : minutes(time)))));
  }));
}

function matchDetail(match) {
  const timeline = el("div", { class: "match-timeline" });
  renderTimeline(timeline, match);
  const map = el("div", { class: "match-map-box" });
  renderMap(map, match);
  const lanes = el("div", { class: "match-lanes-box" });
  renderLanes(lanes, match);
  const parseNote = match.parse === "parsed" ? null : el("p", { class: "parse-note" },
    match.parse === "pending"
      ? "OpenDota 还在解析这场录像，号位和装备时间暂缺，会自动重查。"
      : "OpenDota 没能解析这场录像，只显示基础数据。");
  return el("div", { class: "match-detail" },
    el("p", { class: "draft-meta" }, `比赛 ID ${match.match_id} · `,
      el("a", { href: `https://www.opendota.com/matches/${match.match_id}`, target: "_blank", rel: "noopener" }, "在 OpenDota 查看")),
    parseNote,
    el("h3", {}, "BP 顺序"),
    el("ol", { class: "draft-strip" }, match.picks_bans.map(([, isPick, team, heroId]) =>
      el("li", { class: `${isPick ? "pick" : "ban"} ${team === 0 ? "radiant" : "dire"}` },
        heroIcon(heroId), el("small", {}, `${team === 0 ? "天辉" : "夜魇"}${isPick ? "选" : "禁"}`)))),
    scoreboard(match, true),
    scoreboard(match, false),
    el("h3", {}, "对线"),
    lanes,
    el("h3", {}, "装备购买时间"),
    el("p", { class: "draft-meta" }, "只列合成装备和较贵的单件，显示首次购买的分钟；“终局”表示没有购买记录但终局持有。"),
    buildTimes(match),
    el("h3", {}, "经济与经验"),
    timeline,
    el("h3", {}, "地图：英雄活动与视野"),
    map,
    el("h3", {}, "死亡复盘"),
    deathReview(match, { el, heroLabel, heroName: (id) => hero(id).name }));
}

function matchHeader(match) {
  return el("div", { class: "match-page-head" },
    el("div", { class: "match-head" },
      el("span", { class: "match-when" }, formatDate(match.start_time), el("small", {}, `时长 ${formatDuration(match.duration)}`)),
      el("span", { class: "match-score" },
        el("b", { class: match.radiant_win ? "radiant won" : "radiant" }, "天辉"),
        `${match.radiant_score} : ${match.dire_score}`,
        el("b", { class: match.radiant_win ? "dire" : "dire won" }, "夜魇"))),
    el("div", { class: "match-teams" }, teamPanel(match, true), teamPanel(match, false)));
}

async function load() {
  const status = document.querySelector("#statsStatus");
  const id = Number(new URLSearchParams(location.search).get("id"));
  try {
    await loadData();
  } catch (error) {
    status.textContent = "数据读取失败，请稍后刷新。";
    console.error(error);
    return;
  }
  const match = state.matches.find((entry) => entry.match_id === id);
  if (!match) {
    status.textContent = id ? `没有找到比赛 ${id}，它可能不在计入光荣榜的比赛里。` : "链接里缺少比赛 ID。";
    return;
  }
  document.title = `${formatDate(match.start_time)} 比赛 · 科大光荣榜`;
  document.querySelector("#matchTitle").textContent = `${formatDate(match.start_time)} · 天辉 ${match.radiant_score} : ${match.dire_score} 夜魇`;
  status.textContent = `比赛 ID ${match.match_id} · 时间为日本时间`;
  const page = document.querySelector("#matchPage");
  state.rerender = () => page.replaceChildren(matchHeader(match), matchDetail(match));
  state.rerender();
}

load();
