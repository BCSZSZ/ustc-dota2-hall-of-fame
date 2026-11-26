const DAY_SECONDS = 86400;
const MIN_RATE_GAMES = 5;
const LANES = { top: "上路", mid: "中路", bot: "下路" };
const TOWER_TIERS = { 1: "一塔", 2: "二塔", 3: "高地塔", 4: "基地塔" };

const state = {
  matches: [],
  names: {},
  heroes: {},
  items: {},
  min: 0,
  max: 0,
  from: 0,
  to: 0,
  tab: "matches",
  player: null,
  openMatch: null,
  scrollTarget: null,
  sort: {},
};
const details = new Map();

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

const hero = (id) => state.heroes[id] || { name: `英雄 ${id}`, en: "", img: "" };
const item = (key) => state.items[key] || { name: key, img: "" };
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
const playerLink = (id) =>
  id ? el("a", { href: `#tab=players&player=${id}`, class: "player-link" }, playerName(id)) : "匿名";

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
          render();
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

function renderTimeline(container, match) {
  const data = details.get(match.match_id);
  container.replaceChildren();
  if (!data) {
    container.append(el("p", { class: "draft-meta" }, "正在读取曲线……"));
    fetch(`./data/matches/${match.match_id}.json`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { gold_adv: [], xp_adv: [], objectives: [] }))
      .catch(() => ({ gold_adv: [], xp_adv: [], objectives: [] }))
      .then((payload) => {
        details.set(match.match_id, payload);
        renderTimeline(container, match);
      });
    return;
  }
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
      el("td", {}, playerLink(player.account_id), isMvp(match, player) ? mvpBadge() : null),
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
      el("td", { class: "items" },
        player.items.map(itemIcon),
        player.neutral ? el("span", { class: "neutral" }, itemIcon(player.neutral)) : null,
        player.scepter ? el("span", { class: "buff", title: "已吃神杖" }, "杖") : null,
        player.shard ? el("span", { class: "buff", title: "已吃魔晶" }, "晶") : null),
    ));
  return el("div", { class: `team ${radiant ? "radiant" : "dire"}` },
    el("h3", {}, radiant ? "天辉" : "夜魇", el("span", { class: teamWon ? "result win" : "result" }, teamWon ? "胜" : "负"),
      el("small", {}, `击杀 ${radiant ? match.radiant_score : match.dire_score}`)),
    el("div", { class: "table-scroll" }, el("table", { class: "data-table scoreboard" },
      el("thead", {}, el("tr", {}, ["选手", "英雄", "评分", "位置", "K/D/A", "正/反补", "GPM/XPM", "净值", "英雄伤害", "建筑伤害", "治疗", "10 分钟经济", "对线", "装备"].map((label) => el("th", { scope: "col" }, label)))),
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
    el("h3", {}, "装备购买时间"),
    el("p", { class: "draft-meta" }, "只列合成装备和较贵的单件，显示首次购买的分钟；“终局”表示没有购买记录但终局持有。"),
    buildTimes(match),
    el("h3", {}, "经济与经验"),
    timeline);
}

function renderMatches(panel, matches) {
  panel.append(section("比赛", `共 ${matches.length} 场，点开查看 BP、数据、装备和经济曲线。`));
  for (const match of [...matches].reverse()) {
    const open = state.openMatch === match.match_id;
    const side = (radiant) => el("span", { class: `side ${radiant ? "radiant" : "dire"}${radiant === match.radiant_win ? " won" : ""}` },
      el("b", {}, radiant ? "天辉" : "夜魇"),
      el("span", { class: "hero-row" }, match.players.filter((player) => isRadiant(player) === radiant).map((player) => heroIcon(player.hero))));
    const card = el("article", { class: `match-card${open ? " open" : ""}`, id: `match-${match.match_id}` },
      el("button", {
        type: "button", class: "match-row", "aria-expanded": String(open),
        onclick: () => {
          state.openMatch = open ? null : match.match_id;
          state.scrollTarget = open ? null : `#match-${match.match_id}`;
          syncHash();
          render();
        },
      },
      el("span", { class: "match-when" }, formatDate(match.start_time), el("small", {}, formatDuration(match.duration)),
        (() => {
          const mvp = match.players.find((player) => isMvp(match, player));
          return mvp ? el("small", { class: "match-mvp" }, mvpBadge(), mvp.account_id ? playerName(mvp.account_id) : hero(mvp.hero).name) : null;
        })()),
      side(true),
      el("span", { class: "match-score" }, `${match.radiant_score} : ${match.dire_score}`),
      side(false)));
    if (open) card.append(matchDetail(match));
    panel.append(card);
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

// ---------- 综合评分 ----------

const DIMENSIONS = [
  { key: "econ", label: "经济" },
  { key: "farm", label: "发育/视野" },
  { key: "dmg", label: "输出" },
  { key: "push", label: "推进" },
  { key: "surv", label: "生存" },
  { key: "team", label: "参与" },
];

const isSupport = (player) => player.pos === 4 || player.pos === 5;

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

// Six 0-100 dimensions per game: OpenDota's same-hero percentiles where they exist,
// league-internal percentiles for team-fight participation and for supports' vision work.
function computeScores() {
  const players = state.matches.flatMap((match) => match.players);
  const sorted = (rows, pick) => rows.map(pick).filter(Number.isFinite).sort((a, b) => a - b);
  const wardsOf = (player) => (Number.isFinite(player.obs) ? player.obs + (player.sen ?? 0) : null);
  const supports = players.filter(isSupport);
  const pools = {
    tf: sorted(players, (player) => player.tf),
    wards: sorted(supports, wardsOf),
    stacks: sorted(supports, (player) => player.stacks),
    stuns: sorted(supports, (player) => player.stuns),
  };
  for (const match of state.matches) {
    for (const player of match.players) {
      if (!player.bm) {
        player.dims = null;
        player.score = null;
        continue;
      }
      player.dims = {
        econ: player.bm.gpm,
        farm: isSupport(player)
          ? meanOf([percentileRank(wardsOf(player), pools.wards), percentileRank(player.stacks, pools.stacks), percentileRank(player.stuns, pools.stuns)])
          : meanOf([player.bm.lhm, player.bm.xpm]),
        dmg: player.bm.hdm,
        push: player.bm.td,
        surv: player.bm.death,
        team: percentileRank(player.tf, pools.tf),
      };
      player.score = meanOf(Object.values(player.dims));
    }
    const best = match.players.filter((player) => Number.isFinite(player.score)).sort((a, b) => b.score - a.score)[0];
    match.mvp = best ? best.slot : null;
  }
}

const isMvp = (match, player) => match.mvp === player.slot;
const scoreText = (value) => (Number.isFinite(value) ? String(Math.round(value)) : "—");

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

const mvpBadge = () => el("span", { class: "mvp", title: "本场综合评分最高" }, "MVP");

// ---------- 纪录墙 ----------

const RECORDS = [
  { label: "最高综合评分", value: (player) => player.score, format: (value) => Math.round(value) },
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
    return el("a", { class: "record-card", href: `#tab=matches&match=${best.match.match_id}`, title: "查看这场比赛" },
      el("span", { class: "record-label" }, record.label),
      el("strong", {}, record.format ? record.format(best.value) : best.value.toLocaleString()),
      el("span", { class: "record-who" }, heroIcon(best.player.hero), best.player.account_id ? playerName(best.player.account_id) : "匿名"),
      el("small", {}, `${hero(best.player.hero).name} · ${formatDate(best.match.start_time)}`));
  });
  return section("纪录墙", "所选时间内的单场最佳，点击查看那场比赛。", el("div", { class: "record-grid" }, cards));
}

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
  const small = (games) => (games < MIN_RATE_GAMES ? " small-sample" : "");
  return el("div", { class: "pc-positions" },
    el("div", { class: "pc-columns", "aria-hidden": "true" }, rows.map((row) =>
      el("div", { class: "pc-column" },
        el("span", { class: "pc-count" }, row.games ? `${row.games}场` : ""),
        el("span", { class: "pc-bar", style: `height:${(row.games / peak) * 100}%` },
          el("i", { style: `height:${row.games ? (row.wins / row.games) * 100 : 0}%` })),
        el("span", { class: "pc-label" }, `${row.pos}号位`)))),
    el("ul", { class: "pc-rows" }, rows.filter((row) => row.games).map((row) =>
      el("li", {},
        el("span", { class: "pc-pos" }, `${row.pos}号位`),
        el("span", { class: `pc-rate${small(row.games)}`, title: record(row.wins, row.games) }, winText(row.wins, row.games)),
        el("span", { class: "pc-heroes" }, row.top.map((entry) =>
          el("span", { class: "pc-hero", title: `${hero(entry.id).name} ${record(entry.wins, entry.games)}` },
            heroIcon(entry.id), el("small", {}, `${entry.wins}-${entry.games - entry.wins}`))))))));
}

function playerDetail(games, matches) {
  const everyone = matches.flatMap((match) => match.players);
  const mine = games.map((game) => game.player);
  const league = (key) => `联赛平均 ${rounded(averageOf(everyone, key))}`;
  const lanes = laneSummary(games);
  const leagueLanes = (() => {
    const rated = everyone.filter((player) => player.lane);
    return rated.length ? rated.filter((player) => player.lane === "W").length / rated.length : null;
  })();

  const laneRows = [1, 2, 3].map((role) => {
    const list = games.filter((game) => game.player.lane_role === role);
    return { role, list, lanes: laneSummary(list), wins: list.filter((game) => game.won).length };
  }).filter((row) => row.list.length);

  const heroes = new Map();
  for (const game of games) {
    if (!heroes.has(game.player.hero)) heroes.set(game.player.hero, { id: game.player.hero, games: [], wins: 0 });
    const row = heroes.get(game.player.hero);
    row.games.push(game.player);
    row.wins += game.won ? 1 : 0;
  }

  const dims = averageDims(mine);
  const leagueDims = averageDims(everyone);
  return el("div", { class: "player-detail" },
    section("综合表现",
      "经济、输出、推进、生存，以及核心的发育（正补、经验）取 OpenDota 与全网同英雄玩家相比的百分位；4、5 号位的发育换成视野（插眼、堆野、控制时长在联赛辅助中的百分位）；参与为团战参与率在联赛中的百分位。综合评分是六项的平均，每场最高者为 MVP。",
      el("div", { class: "score-detail" },
        radar(dims, { size: 220, compare: leagueDims }),
        el("div", { class: "table-scroll" }, el("table", { class: "data-table" },
          el("thead", {}, el("tr", {}, ["能力", "百分位", "联赛平均"].map((label) => el("th", { scope: "col" }, label)))),
          el("tbody", {}, DIMENSIONS.map(({ key, label }) => el("tr", {},
            el("td", {}, label),
            el("td", { class: "num" }, el("span", { class: "dim-bar" }, el("i", { style: `width:${dims[key] ?? 0}%` })), scoreText(dims[key])),
            el("td", { class: "num" }, scoreText(leagueDims[key])))))))),
      el("p", { class: "draft-meta" }, "雷达图实线为该选手，虚线为联赛平均。")),
    section("对线", "看 10 分钟时的情况。对线结果按该路双方选手 10 分钟经济总和比较，领先 10% 以上为优，落后 10% 以上为劣，其余为均。",
      el("div", { class: "stat-cards" },
        statCard("10 分钟经济", rounded(averageOf(mine, "gold10")), league("gold10")),
        statCard("10 分钟正补", rounded(averageOf(mine, "lh10")), league("lh10")),
        statCard("10 分钟经验", rounded(averageOf(mine, "xp10")), league("xp10")),
        statCard("线优率", lanes.rated ? winText(lanes.win, lanes.rated) : "—",
          `优 ${lanes.win} · 均 ${lanes.draw} · 劣 ${lanes.loss}${leagueLanes === null ? "" : ` · 联赛 ${Math.round(leagueLanes * 100)}%`}`)),
      laneRows.length ? el("div", { class: "table-scroll" }, el("table", { class: "data-table" },
        el("thead", {}, el("tr", {}, ["分路", "场次", "优 / 均 / 劣", "线优率", "10 分钟经济", "10 分钟正补", "比赛胜负"].map((label) => el("th", { scope: "col" }, label)))),
        el("tbody", {}, laneRows.map((row) => el("tr", {},
          el("td", {}, LANE_ROLES[row.role]),
          el("td", { class: "num" }, row.list.length),
          el("td", { class: "num" }, `${row.lanes.win} / ${row.lanes.draw} / ${row.lanes.loss}`),
          el("td", { class: "num" }, row.lanes.rated ? winText(row.lanes.win, row.lanes.rated) : "—"),
          el("td", { class: "num" }, rounded(averageOf(row.list.map((game) => game.player), "gold10"))),
          el("td", { class: "num" }, rounded(averageOf(row.list.map((game) => game.player), "lh10"))),
          el("td", { class: "num" }, record(row.wins, row.list.length))))))) : null),
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
      el("thead", {}, el("tr", {}, ["结果", "时间", "英雄", "评分", "位置", "K/D/A", "10 分钟经济", "对线", ""].map((label) => el("th", { scope: "col" }, label)))),
      el("tbody", {}, [...games].reverse().map((game) => el("tr", {},
        el("td", {}, el("span", { class: game.won ? "result win" : "result" }, game.won ? "胜" : "负")),
        el("td", {}, formatDate(game.match.start_time)),
        el("td", {}, heroLabel(game.player.hero)),
        el("td", { class: "num" }, scoreText(game.player.score), isMvp(game.match, game.player) ? mvpBadge() : null),
        el("td", { class: "num" }, game.player.pos ? `${game.player.pos} 号位` : "—"),
        el("td", { class: "num" }, `${game.player.k}/${game.player.d}/${game.player.a}`),
        el("td", { class: "num" }, rounded(game.player.gold10 ?? null)),
        el("td", { class: "num" }, game.player.lane ? el("span", { class: `lane lane-${game.player.lane}` }, LANE_TEXT[game.player.lane]) : "—"),
        el("td", {}, el("a", { href: `#tab=matches&match=${game.match.match_id}` }, "查看比赛")))))))));
}

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
  panel.append(section("选手", `所选时间内出场的 ${roster.length} 名选手。综合评分为六项能力百分位的平均，详见卡片展开后的说明。柱子高度为该号位场次，金色部分为胜场；号位为 OpenDota 根据录像的估计。点开卡片查看对线和详细数据。`));
  const grid = el("div", { class: "player-grid" });
  for (const [accountId, games] of roster) {
    const open = state.player === accountId;
    const wins = games.filter((game) => game.won).length;
    const mine = games.map((game) => game.player);
    const card = el("article", { class: `player-card${open ? " open" : ""}`, id: `player-${accountId}` },
      el("button", {
        type: "button", class: "player-card-head", "aria-expanded": String(open),
        onclick: () => {
          state.player = open ? null : accountId;
          state.scrollTarget = open ? null : `#player-${accountId}`;
          syncHash();
          render();
        },
      },
      el("span", { class: "pc-title" },
        el("strong", {}, playerName(accountId)),
        el("span", { class: "pc-record" }, `${record(wins, games.length)} · ${winText(wins, games.length)}`)),
      (() => {
        const scored = mine.filter((player) => Number.isFinite(player.score));
        const mvps = games.filter((game) => isMvp(game.match, game.player)).length;
        return el("span", { class: "pc-summary" },
          radar(averageDims(mine)),
          el("span", { class: "pc-score" },
            el("span", { class: "pc-score-label" }, "综合评分"),
            el("strong", { class: scored.length < MIN_RATE_GAMES ? "small-sample" : "" }, scoreText(meanOf(scored.map((player) => player.score)))),
            el("span", { class: "pc-mvps" }, mvps ? [mvpBadge(), ` × ${mvps}`] : "暂无 MVP"),
            el("span", { class: "pc-meta" }, `K/D/A ${kda(mine).text}`),
            el("span", { class: "pc-meta" }, `GPM ${rounded(averageOf(mine, "gpm"))}`)));
      })(),
      positionChart(games)));
    if (open) card.append(playerDetail(games, matches));
    grid.append(card);
  }
  panel.append(grid);
}

// ---------- 页面 ----------

function syncHash() {
  const params = new URLSearchParams({ tab: state.tab });
  if (state.tab === "players" && state.player) params.set("player", state.player);
  if (state.tab === "matches" && state.openMatch) params.set("match", state.openMatch);
  history.replaceState(null, "", `#${params}`);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const player = Number(params.get("player"));
  const match = Number(params.get("match"));
  state.tab = params.get("tab") || (player ? "players" : "matches");
  if (player) state.player = player;
  if (match) state.openMatch = match;
  state.scrollTarget = state.tab === "players" && player ? `#player-${player}` : state.tab === "matches" && match ? `#match-${match}` : null;
}

function render() {
  const matches = visibleMatches();
  for (const button of document.querySelectorAll("[role=tab]")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === state.tab));
  }
  for (const tab of ["matches", "heroes", "players"]) {
    const panel = document.querySelector(`#panel-${tab}`);
    panel.hidden = tab !== state.tab;
    if (tab !== state.tab) continue;
    panel.replaceChildren();
    if (tab === "matches") renderMatches(panel, matches);
    if (tab === "heroes") renderHeroes(panel, matches);
    if (tab === "players") renderPlayers(panel, matches);
  }
  document.querySelector("#statsStatus").textContent =
    `所选时间内 ${matches.length} 场 · 全部 ${state.matches.length} 场 · 时间为日本时间`;
  if (state.scrollTarget) {
    const target = document.querySelector(state.scrollTarget);
    state.scrollTarget = null;
    // Wait a frame so the expanded card has its final position before scrolling it to the top.
    if (target) requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
  }
}

function setRange(from, to, activeButton) {
  state.from = from;
  state.to = to;
  document.querySelector("#fromDate").value = dateInput(from);
  document.querySelector("#toDate").value = dateInput(to);
  for (const button of document.querySelectorAll("#quickRanges button")) {
    button.classList.toggle("active", button === activeButton);
  }
  render();
}

function bindControls() {
  for (const button of document.querySelectorAll("[role=tab]")) {
    button.addEventListener("click", () => {
      state.tab = button.dataset.tab;
      syncHash();
      render();
    });
  }
  for (const button of document.querySelectorAll("#quickRanges button")) {
    button.addEventListener("click", () => {
      const days = Number(button.dataset.days);
      setRange(days ? Math.max(state.min, state.max - days * DAY_SECONDS) : state.min, state.max, button);
    });
  }
  const dateToSeconds = (value, endOfDay) => Date.parse(`${value}T00:00:00+09:00`) / 1000 + (endOfDay ? DAY_SECONDS - 1 : 0);
  for (const input of [document.querySelector("#fromDate"), document.querySelector("#toDate")]) {
    input.addEventListener("change", () => {
      const from = dateToSeconds(document.querySelector("#fromDate").value, false);
      const to = dateToSeconds(document.querySelector("#toDate").value, true);
      if (Number.isFinite(from) && Number.isFinite(to) && from <= to) setRange(from, to, null);
    });
  }
  window.addEventListener("hashchange", () => {
    readHash();
    render();
  });
}

async function load() {
  try {
    const read = (path) => fetch(path, { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
      return response.json();
    });
    const [summaries, constants, league] = await Promise.all([
      read("./data/matches.json"), read("./data/constants.json"), read("./data/league.json"),
    ]);
    state.heroes = constants.heroes || {};
    state.items = constants.items || {};
    for (const match of league.matches || []) {
      for (const player of match.players || []) {
        if (player.account_id && player.personaname) state.names[player.account_id] = player.personaname;
      }
    }
    Object.assign(state.names, league.player_names || {});
    state.matches = summaries.matches || [];
    computeScores();
    if (!state.matches.length) {
      document.querySelector("#statsStatus").textContent = "还没有可统计的比赛。";
      return;
    }
    state.min = Math.min(...state.matches.map((match) => match.start_time));
    state.max = Math.max(...state.matches.map((match) => match.start_time + match.duration));
    readHash();
    bindControls();
    setRange(state.min, state.max, document.querySelector("#quickRanges button[data-days='0']"));
  } catch (error) {
    document.querySelector("#statsStatus").textContent = "数据读取失败，请稍后刷新。";
    console.error(error);
  }
}

load();
