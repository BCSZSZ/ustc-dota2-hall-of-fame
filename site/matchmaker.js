import {
  attachPositionRatings, buildLeagueRoster, calibrateModel, describeMedals, findBalancedTeams,
  POSITION_MIN_GAMES, POSITION_NAMES, positionProfile, suggestPickOrder,
} from "./matchmaker-model.js?v=12";
import { loadSharedMmr } from "./shared-mmr.js?v=4";

const form = document.querySelector("#draftForm");
const inputs = document.querySelector("#draftInputs");
const captainFields = [...form.querySelectorAll("#captainA, #captainB")];
const search = document.querySelector("#draftSearch");
const pool = document.querySelector("#draftPool");
const picked = document.querySelector("#draftPicked");
const noMatches = document.querySelector("#draftNoMatches");
const dataStatus = document.querySelector("#draftDataStatus");
const selectionStatus = document.querySelector("#draftSelection");
const submit = document.querySelector("#draftSubmit");
const playersSection = document.querySelector("#draftPlayers");
const playerCards = document.querySelector("#draftPlayerCards");
const results = document.querySelector("#draftResults");
const resultsSummary = document.querySelector("#draftResultsSummary");
const plans = document.querySelector("#draftPlans");
const calibrationNote = document.querySelector("#calibrationNote");
const pickOptions = document.querySelector("#pickOptions");
const pickResults = document.querySelector("#pickResults");
const pickSummary = document.querySelector("#pickSummary");
const pickForecast = document.querySelector("#pickForecast");
const pickOrder = document.querySelector("#pickOrder");
const pickCaptains = document.querySelector("#pickCaptains");
const pickTitle = document.querySelector("#pickResultsTitle");
const teamNames = { A: "甲队", B: "乙队" };
const sections = [pickResults, results, playersSection];

const memberCount = 8;
const selected = new Set();
const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 1 });
const wholePercent = new Intl.NumberFormat("zh-CN", { style: "percent" });
let snapshot;
let sharedState;
let calibration;
let roster = [];
let playersById = new Map();
let positionStats = null;
let heroNames = {};
// The ten players of the last calculation, kept so changing the first pick only redraws the suggestion.
let lineup = null;

function make(tag, className, text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function captainIds() {
  return captainFields.map((field) => Number(field.value));
}

function ratingSource(player) {
  if (player.ratingSource === "manual") return "手填 MMR";
  return player.ratingSource === "medal" ? "段位估算" : "中位数暂估";
}

function scoreDetails(player) {
  const medal = describeMedals(player.rankTier, player.leaderboardRank, player.stratzRankTier);
  const source = player.ratingSource === "medal" ? medal + " 估算" : ratingSource(player);
  return "基础 MMR " + integer.format(player.baseRating) + "（" + source + "）" +
    " · 内战 Elo " + integer.format(player.inhouseRating) +
    "（" + player.games + " 场 · 采纳 " + percent.format(player.inhouseWeight) + "）";
}

const chipNotes = { main: "最常打", rare: "少打" };

// One cell per position: its rating, marked as the most played or a rarely played position.
function positionStrip(player) {
  const profile = positionProfile(player);
  if (!profile) return make("small", "pos-strip-empty", "近期常规比赛不足 30 场，各号位都按 MMR");
  const strip = make("div", "pos-strip");
  for (const slot of profile) {
    const chip = make("span", `pos-chip ${slot.tag}`);
    chip.append(make("small", "", `${slot.position} ${slot.name}`), make("strong", "", integer.format(slot.rating)),
      make("em", "", chipNotes[slot.tag] ?? `${slot.games} 场`));
    chip.title = positionDetails(player, slot);
    strip.append(chip);
  }
  return strip;
}

function positionDetails(player, slot) {
  if (!player.positions) return scoreDetails(player) + " · 没有足够的近期常规比赛，不分号位";
  const record = `近 ${player.positionGames} 场（${player.positionSince} 起）打了 ${slot.games} 场 ${slot.position} 号位，胜 ${slot.wins} 场`;
  return slot.rare ? `${record} · 少于 ${POSITION_MIN_GAMES} 场，按 MMR ${integer.format(player.rating)} − 500 计`
    : `${record} · MMR ${integer.format(player.rating)}，号位修正 ${slot.delta >= 0 ? "+" : "−"}${integer.format(Math.abs(slot.delta))}`;
}

function heroIcon(id) {
  const name = heroNames[id]?.name ?? `英雄 ${id}`;
  const image = make("img", "draft-hero-img");
  Object.assign(image, { src: `./img/heroes/${id}.webp`, alt: name, title: name, loading: "lazy" });
  return image;
}

function renderSelection() {
  const full = selected.size === memberCount;
  const captainCount = captainIds().filter(Boolean).length;
  for (const checkbox of pool.querySelectorAll("input")) {
    checkbox.checked = selected.has(Number(checkbox.value));
    checkbox.disabled = full && !checkbox.checked;
  }
  picked.replaceChildren();
  for (const id of selected) {
    const player = playersById.get(id);
    const remove = make("button", "draft-chip", `${player.name} ×`);
    remove.type = "button";
    remove.dataset.remove = String(id);
    remove.setAttribute("aria-label", `取消选择 ${player.name}（${id}）`);
    picked.append(remove);
  }
  picked.hidden = selected.size === 0;
  selectionStatus.textContent = `队长 ${captainCount} / 2 · 队员 ${selected.size} / ${memberCount}`;
  submit.disabled = captainCount !== 2 || !full;
}

function renderPool() {
  const query = search.value.trim().normalize("NFKC").toLowerCase();
  const captains = captainIds();
  const visible = roster.filter((player) => !captains.includes(player.accountId) && (
    !query || player.name.normalize("NFKC").toLowerCase().includes(query) ||
    String(player.accountId).includes(query)
  ));
  const items = document.createDocumentFragment();
  for (const player of visible) {
    const label = make("label", "draft-player");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = player.accountId;
    checkbox.setAttribute("aria-label", `${player.name}（${player.accountId}）`);

    const info = make("span", "draft-player-info");
    const name = make("span", "draft-player-name", player.name);
    name.title = player.name;
    info.append(name, make("small", "draft-player-id", player.accountId + " · " + ratingSource(player)));
    const rating = make("strong", "draft-player-rating", integer.format(player.rating));
    rating.title = scoreDetails(player);
    label.append(checkbox, info, rating);
    items.append(label);
  }
  pool.replaceChildren(items);
  noMatches.hidden = visible.length > 0;
  renderSelection();
}

function invalidatePlans() {
  lineup = null;
  for (const section of sections) section.hidden = true;
  playerCards.replaceChildren();
  plans.replaceChildren();
  pickOrder.replaceChildren();
  pickForecast.replaceChildren();
  pickCaptains.replaceChildren();
}

// ---------- 参赛选手 ----------

// `slot`, when given, is the position the player ends up on after the suggested draft.
function playerCard(player, role, slot) {
  const card = make("article", `draft-card${role ? " captain-" + role : ""}`);
  const head = make("div", "draft-card-head");
  const who = make("div", "draft-card-who");
  if (role) who.append(make("span", "draft-card-role", `${teamNames[role]}队长`));
  const name = make("h3", "draft-card-name", player.name);
  name.title = `${player.name}（${player.accountId}）`;
  const medal = describeMedals(player.rankTier, player.leaderboardRank, player.stratzRankTier);
  who.append(name, make("small", "draft-meta",
    `${player.ratingSource === "manual" ? "手填 MMR" : medal || ratingSource(player)} · 内战 ${player.games} 场`));
  const score = make("div", "draft-card-score");
  const value = make("strong", "", integer.format(player.rating));
  value.title = scoreDetails(player);
  score.append(value, make("small", "", "MMR"));
  head.append(who, score);
  card.append(head);

  const main = positionProfile(player)?.filter((slot) => slot.tag === "main") ?? [];
  if (main.length) {
    const tags = make("div", "draft-card-tags");
    for (const slot of main) tags.append(make("span", "pos-tag", `主打 ${slot.position} 号位 ${slot.name}`));
    card.append(tags);
  }
  if (positionStats) card.append(positionStrip(player));

  const heroes = positionStats?.players?.[player.accountId]?.heroes ?? [];
  if (heroes.length) {
    const list = make("div", "draft-card-heroes");
    list.append(make("small", "draft-meta", "常用英雄"));
    for (const [id, games, wins] of heroes) {
      const entry = make("span", "draft-hero");
      entry.title = `${heroNames[id]?.name ?? `英雄 ${id}`}：近 ${player.positionGames ?? "100"} 场里 ${games} 场，胜 ${wins} 场`;
      entry.append(heroIcon(id), make("small", "", `${games} 场 ${wholePercent.format(wins / games)}`));
      list.append(entry);
    }
    card.append(list);
  }
  if (slot) {
    const after = make("p", `draft-card-after${slot.rare ? " rare" : ""}`,
      `选完后打 ${slot.position} 号位 ${POSITION_NAMES[slot.position]} · ${integer.format(slot.rating)}${slot.rare ? " · 少打" : ""}`);
    after.title = positionDetails(player, slot);
    card.append(after);
  }
  return card;
}

function renderPlayers({ captainA, captainB, others }) {
  const byRating = [...others].sort((left, right) => right.rating - left.rating || left.accountId - right.accountId);
  playerCards.replaceChildren(playerCard(captainA, "A"), playerCard(captainB, "B"), ...byRating.map((player) => playerCard(player)));
}

// ---------- 自动分队 ----------

function renderTeam(label, players, average, teamLineup) {
  const team = make("div", "draft-team");
  const heading = make("h4", "", `${label} · ${teamLineup ? "阵容 MMR" : "平均 MMR"} ${decimal.format(average)}`);
  const list = make("ul", "draft-team-players");
  if (teamLineup) {
    for (const slot of teamLineup) {
      const { player } = slot;
      const row = make("li", "");
      row.dataset.accountId = String(player.accountId);
      const name = make("span", "draft-team-player");
      name.append(make("small", "draft-position", `${slot.position} ${POSITION_NAMES[slot.position]}`), player.name);
      if (player === players[0]) name.append(make("small", "draft-role", "队长"));
      if (slot.rare) name.append(make("small", "draft-role draft-rare", "少打"));
      else if (!player.positions) name.append(make("small", "draft-role", "不分号位"));
      const score = make("strong", "", integer.format(slot.rating));
      score.title = positionDetails(player, slot);
      row.append(name, score);
      list.append(row);
    }
    team.append(heading, list);
    return team;
  }
  players.forEach((player, index) => {
    const row = make("li", "");
    row.dataset.accountId = String(player.accountId);
    const label = make("span", "draft-team-player", player.name);
    if (index === 0) label.append(make("small", "draft-role", "队长"));
    if (player.ratingSource !== "manual") label.append(make("small", "draft-role", ratingSource(player)));
    const score = make("strong", "", integer.format(player.rating));
    score.title = scoreDetails(player);
    row.append(label, score);
    list.append(row);
  });
  team.append(heading, list);
  return team;
}

function forecast(winChanceA) {
  const line = make("div", "draft-forecast");
  line.append(
    make("strong", "", `甲队 ${percent.format(winChanceA)}`),
    make("span", "", "预计胜率"),
    make("strong", "", `乙队 ${percent.format(1 - winChanceA)}`),
  );
  const bar = make("div", "draft-odds");
  bar.style.setProperty("--team-a-odds", `${winChanceA * 100}%`);
  bar.setAttribute("aria-hidden", "true");
  return [line, bar];
}

// Opens the BP page with these two teams filled in.
function bpLink(teamA, teamB, text) {
  const link = make("a", "draft-link", text);
  const ids = (team) => team.map((player) => player.accountId).join(",");
  link.href = `./bp.html?${new URLSearchParams({ a: ids(teamA), b: ids(teamB) })}`;
  return link;
}

function renderPlan(plan, index) {
  const card = make("article", "draft-plan");
  const heading = make("div", "draft-plan-heading");
  heading.append(make("h3", "", `方案 ${index + 1}`), make("span", "draft-gap", `分差 ${decimal.format(plan.ratingGap)}`));
  const teams = make("div", "draft-teams");
  teams.append(renderTeam("甲队", plan.teamA, plan.averageA, plan.lineupA), renderTeam("乙队", plan.teamB, plan.averageB, plan.lineupB));
  card.append(heading, ...forecast(plan.winChanceA), teams, bpLink(plan.teamA, plan.teamB, "用这个分队做 BP →"));
  return card;
}

function renderAuto({ captainA, captainB, others }) {
  const result = findBalancedTeams(captainA, captainB, others, { scale: calibration.applied.scale, positions: Boolean(positionStats) });
  resultsSummary.textContent = result.withinRange === 0
    ? `${result.examined} 套分法均超出 40%–60% 区间，显示最接近五五开的 ${result.plans.length} 套。`
    : `${result.examined} 套分法中有 ${result.withinRange} 套在 40%–60% 区间，显示 ${result.plans.length} 套。`;
  plans.replaceChildren(...result.plans.map(renderPlan));
}

// ---------- 选马建议 ----------

function pickCard(player, slot, side) {
  const card = make("span", `draft-mini draft-mini-${side}${slot?.rare ? " rare" : ""}`);
  card.append(make("small", "", slot ? `${slot.position} 号位 ${POSITION_NAMES[slot.position]}` : "不分号位"),
    make("strong", "", player.name));
  const score = make("em", "", integer.format(slot?.rating ?? player.rating));
  if (slot?.rare) score.append(make("b", "", "少打"));
  card.append(score);
  card.title = slot ? positionDetails(player, slot) : scoreDetails(player);
  return card;
}

function turnLabel(title, detail) {
  const label = make("span", "draft-pick-label");
  label.append(make("strong", "", title), make("small", "", detail));
  return label;
}

function renderPick({ captainA, captainB, others }) {
  const side = pickOptions.querySelector("input:checked").value;
  const result = suggestPickOrder(captainA, captainB, others, {
    firstPick: side, scale: calibration.applied.scale, positions: Boolean(positionStats),
  });
  const slotOf = (player, pickSide) => (pickSide === "A" ? result.lineupA : result.lineupB)?.find((entry) => entry.player === player);
  pickSummary.textContent = `${teamNames[side]}先选，按 1-2-2-2-1 顺序。双方都预判对方的选法，每一手都取推演到选完后对本方最好的人；卡片上是这个人选完后打的号位和该号位的 MMR。` +
    (positionStats ? "" : "位置数据读取失败，按平均 MMR 计算。");
  const scores = make("p", "draft-meta draft-pick-scores",
    `选完后阵容 MMR：甲队 ${decimal.format(result.averageA)} · 乙队 ${decimal.format(result.averageB)}`);
  pickForecast.replaceChildren(...forecast(result.winChanceA), scores, bpLink(result.teamA, result.teamB, "按这个选马结果做 BP →"));

  pickCaptains.replaceChildren(playerCard(captainA, "A", slotOf(captainA, "A")), playerCard(captainB, "B", slotOf(captainB, "B")));
  const turns = [];
  for (const { turn, side: pickSide, player } of result.picks) {
    turns[turn] ??= { side: pickSide, players: [] };
    turns[turn].players.push(player);
  }
  pickOrder.replaceChildren(...turns.map(({ side: pickSide, players }, turn) => {
    const item = make("li", `draft-pick-turn draft-pick-${pickSide}`);
    item.append(turnLabel(`第 ${turn + 1} 轮`, `${teamNames[pickSide]}选 ${players.length} 匹`),
      ...players.map((player) => pickCard(player, slotOf(player, pickSide), pickSide)));
    return item;
  }));
}

pickOptions.addEventListener("change", () => {
  if (lineup) renderPick(lineup);
});

for (const [index, field] of captainFields.entries()) {
  field.addEventListener("change", () => {
    if (field.value) selected.delete(Number(field.value));
    const other = captainFields[1 - index];
    for (const option of other.options) {
      option.disabled = option.value !== "" && option.value === field.value;
    }
    invalidatePlans();
    renderPool();
  });
}

search.addEventListener("input", renderPool);

pool.addEventListener("change", ({ target }) => {
  const id = Number(target.value);
  if (!playersById.has(id)) return;
  if (!target.checked) selected.delete(id);
  else if (selected.size < memberCount) selected.add(id);
  invalidatePlans();
  renderSelection();
});

picked.addEventListener("click", ({ target }) => {
  const button = target.closest("button[data-remove]");
  if (!button) return;
  const id = Number(button.dataset.remove);
  selected.delete(id);
  invalidatePlans();
  renderSelection();
  (pool.querySelector(`input[value="${id}"]`) ?? search).focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (inputs.disabled || submit.disabled) return;
  inputs.disabled = true;
  submit.textContent = "正在读取最新分数…";
  invalidatePlans();
  renderRoster(await refreshSharedScores());
  submit.textContent = "计算分队";
  if (inputs.disabled || submit.disabled) return;
  const [captainA, captainB] = captainIds().map((id) => playersById.get(id));
  lineup = { captainA, captainB, others: [...selected].map((id) => playersById.get(id)) };
  renderPlayers(lineup);
  renderAuto(lineup);
  renderPick(lineup);
  for (const section of sections) section.hidden = false;
  pickTitle.focus({ preventScroll: true });
  pickResults.scrollIntoView({ block: "start" });
});

async function refreshSharedScores() {
  try {
    sharedState = await loadSharedMmr();
    return "";
  } catch (error) {
    console.error("Could not read shared MMR", error);
    return sharedState ? "共享 MMR 读取失败，暂用本页已载入的 MMR。" : "共享 MMR 读取失败，暂用段位估算。";
  }
}

function describeHalfWeight(games) {
  return Number.isFinite(games) ? `${games} 场时采纳一半` : "不采纳内战修正";
}

function renderCalibration() {
  const { matches, fitted, scaleInterval, status, applied } = calibration;
  const fit = fitted
    ? `历史拟合：尺度 ${fitted.scale}（95% 区间 ${scaleInterval[0]}–${scaleInterval[1]}${scaleInterval[1] >= 1200 ? " 以上" : ""}），内战修正 ${describeHalfWeight(fitted.halfWeightGames)}。`
    : "";
  const state = {
    collecting: `满 50 场后开始采用拟合尺度，满 100 场且明显更优时才调整内战修正。`,
    uncertain: `已满 50 场，但尺度区间还没收窄，暂不采用。`,
    applied: `已采用拟合尺度（向默认值 400 收缩）。`,
  }[status];
  calibrationNote.textContent = `模型校准：按联赛历史逐场回测，现有 ${matches} 场。${fit}${state}当前使用尺度 ${applied.scale}，内战修正 ${describeHalfWeight(applied.halfWeightGames)}。`;
}

function renderRoster(sharedStatus) {
  calibration = calibrateModel(snapshot, sharedState?.ratings);
  renderCalibration();
  const named = { ...snapshot, player_names: { ...snapshot.player_names, ...sharedState?.aliases } };
  roster = attachPositionRatings(buildLeagueRoster(named, sharedState?.ratings, calibration.applied)
    .filter((player) => Number.isFinite(player.rating)), positionStats?.players)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.accountId - right.accountId);
  playersById = new Map(roster.map((player) => [player.accountId, player]));
  for (const id of selected) {
    if (!playersById.has(id)) selected.delete(id);
  }

  const previousCaptains = captainIds();
  for (const [index, field] of captainFields.entries()) {
    const options = roster.map((player) => {
      const option = new Option(player.name + " · " + player.accountId, player.accountId);
      option.disabled = player.accountId === previousCaptains[1 - index];
      return option;
    });
    field.replaceChildren(new Option("选择队长", ""), ...options);
    field.value = playersById.has(previousCaptains[index]) ? String(previousCaptains[index]) : "";
  }

  const manualCount = roster.filter((player) => player.ratingSource === "manual").length;
  inputs.disabled = roster.length < 10;
  const status = inputs.disabled ? "有 MMR 的玩家不足 10 人，请补充手填 MMR。" :
    roster.length + " 名可选玩家 · " + manualCount + " 人手填了 MMR · " +
    (positionStats ? `位置数据 ${positionStats.generated_at_utc.slice(0, 10)} 更新` : "位置数据读取失败，按平均 MMR 计算");
  dataStatus.textContent = sharedStatus ? status + " · " + sharedStatus : status;
  renderPool();
}

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

async function loadRoster() {
  try {
    const [response, sharedStatus, stats, names] = await Promise.all([
      fetch("./data/league.json"),
      refreshSharedScores(),
      readJson("./data/position-stats.json"),
      readJson("./data/names.json"),
    ]);
    if (!response.ok) throw new Error("Could not read league snapshot (HTTP " + response.status + ")");
    positionStats = stats;
    heroNames = names?.heroes ?? {};
    snapshot = await response.json();
    renderRoster(sharedStatus);
  } catch (error) {
    dataStatus.textContent = "联赛数据读取失败，请刷新页面重试。";
    console.error("Could not load the league roster", error);
  }
}

loadRoster();
