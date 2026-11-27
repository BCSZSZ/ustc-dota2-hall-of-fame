import { buildLeagueRoster, calibrateModel, describeRankTier, findBalancedTeams, PICK_STRATEGIES, suggestPickOrder } from "./matchmaker-model.js?v=6";
import { loadSharedMmr } from "./shared-mmr.js?v=4";

const form = document.querySelector("#draftForm");
const inputs = document.querySelector("#draftInputs");
const captainFields = [...form.querySelectorAll("select")];
const search = document.querySelector("#draftSearch");
const pool = document.querySelector("#draftPool");
const picked = document.querySelector("#draftPicked");
const noMatches = document.querySelector("#draftNoMatches");
const dataStatus = document.querySelector("#draftDataStatus");
const selectionStatus = document.querySelector("#draftSelection");
const submit = document.querySelector("#draftSubmit");
const results = document.querySelector("#draftResults");
const resultsTitle = document.querySelector("#draftResultsTitle");
const resultsSummary = document.querySelector("#draftResultsSummary");
const plans = document.querySelector("#draftPlans");
const calibrationNote = document.querySelector("#calibrationNote");
const tabs = [...document.querySelectorAll(".draft-tabs [role=tab]")];
const firstPick = document.querySelector("#firstPick");
const pickResults = document.querySelector("#pickResults");
const pickResultsTitle = document.querySelector("#pickResultsTitle");
const pickSummary = document.querySelector("#pickSummary");
const pickOrder = document.querySelector("#pickOrder");
const pickPlan = document.querySelector("#pickPlan");
const submitLabels = { auto: "计算分队", pick: "生成选马顺序" };
const teamNames = { A: "甲队", B: "乙队" };

const memberCount = 8;
const selected = new Set();
const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 1 });
let snapshot;
let sharedState;
let calibration;
let roster = [];
let playersById = new Map();
let mode = "auto";

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
  if (player.ratingSource === "manual") return "手填天梯分";
  return player.ratingSource === "medal" ? "段位估分" : "中位数暂估";
}

function scoreDetails(player) {
  const medal = describeRankTier(player.rankTier);
  const source = player.ratingSource === "medal" ? medal + "估分" : ratingSource(player);
  return source + " " + integer.format(player.baseRating) +
    " · 内战 Elo " + integer.format(player.inhouseRating) +
    "（" + player.games + " 场 · 采纳 " + percent.format(player.inhouseWeight) + "）";
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
    const account = player.accountId + " · " + ratingSource(player);
    info.append(name, make("small", "draft-player-id", account));
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
  results.hidden = true;
  plans.replaceChildren();
  pickResults.hidden = true;
  pickOrder.replaceChildren();
  pickPlan.replaceChildren();
}

function renderTeam(label, players, average) {
  const team = make("div", "draft-team");
  const heading = make("h4", "", `${label} · 均分 ${decimal.format(average)}`);
  const list = make("ul", "draft-team-players");
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

function renderPlan(plan, index) {
  const card = make("article", "draft-plan");
  const heading = make("div", "draft-plan-heading");
  heading.append(
    make("h3", "", typeof index === "string" ? index : `方案 ${index + 1}`),
    make("span", "draft-gap", `均分差 ${decimal.format(plan.ratingGap)}`),
  );

  const forecast = make("div", "draft-forecast");
  forecast.append(
    make("strong", "", `甲队 ${percent.format(plan.winChanceA)}`),
    make("span", "", "预计胜率"),
    make("strong", "", `乙队 ${percent.format(1 - plan.winChanceA)}`),
  );
  const bar = make("div", "draft-odds");
  bar.style.setProperty("--team-a-odds", `${plan.winChanceA * 100}%`);
  bar.setAttribute("aria-hidden", "true");

  const teams = make("div", "draft-teams");
  teams.append(renderTeam("甲队", plan.teamA, plan.averageA), renderTeam("乙队", plan.teamB, plan.averageB));
  card.append(heading, forecast, bar, teams);
  return card;
}

function renderPickOrder(result) {
  const turns = [];
  for (const { turn, side, player } of result.picks) {
    turns[turn] ??= { side, players: [] };
    turns[turn].players.push(player);
  }
  pickOrder.replaceChildren(...turns.map(({ side, players }) => {
    const item = make("li", `draft-pick-turn draft-pick-${side}`);
    item.append(make("strong", "", `${teamNames[side]}选 ${players.length} 匹`));
    for (const player of players) {
      const pick = make("span", "draft-pick-player", player.name);
      const score = make("small", "", integer.format(player.rating));
      score.title = scoreDetails(player);
      pick.append(score);
      item.append(pick);
    }
    return item;
  }));
  pickPlan.replaceChildren(renderPlan(result, "选完后的阵容"));
}

function setMode(next) {
  mode = next;
  for (const tab of tabs) {
    const active = tab.dataset.mode === mode;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  firstPick.hidden = mode !== "pick";
  submit.textContent = submitLabels[mode];
  invalidatePlans();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => setMode(tab.dataset.mode));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
    setMode(next.dataset.mode);
    next.focus();
  });
}

firstPick.addEventListener("change", invalidatePlans);

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
  submit.textContent = submitLabels[mode];
  if (inputs.disabled || submit.disabled) return;
  const [captainA, captainB] = captainIds().map((id) => playersById.get(id));
  const others = [...selected].map((id) => playersById.get(id));
  if (mode === "pick") {
    const side = form.elements.firstPick.value;
    const strategy = PICK_STRATEGIES.highestRating;
    const result = suggestPickOrder(captainA, captainB, others, { firstPick: side, strategyA: strategy, scale: calibration.applied.scale });
    pickSummary.textContent = `${teamNames[side]}先选，按 1-2-2-2-1 顺序，双方都${strategy.label}选。`;
    renderPickOrder(result);
    pickResults.hidden = false;
    pickResultsTitle.focus({ preventScroll: true });
    pickResults.scrollIntoView({ block: "start" });
    return;
  }
  const result = findBalancedTeams(captainA, captainB, others, { scale: calibration.applied.scale });
  resultsSummary.textContent = result.withinRange === 0
    ? `${result.examined} 套分法均超出 40%–60% 区间，显示最接近五五开的 ${result.plans.length} 套。`
    : `${result.examined} 套分法中有 ${result.withinRange} 套在 40%–60% 区间，显示 ${result.plans.length} 套。`;
  plans.replaceChildren(...result.plans.map(renderPlan));
  results.hidden = false;
  resultsTitle.focus({ preventScroll: true });
  results.scrollIntoView({ block: "start" });
});

async function refreshSharedScores() {
  try {
    sharedState = await loadSharedMmr();
    return "";
  } catch (error) {
    console.error("Could not read shared MMR", error);
    return sharedState ? "共享分读取失败，暂用本页已载入的分数。" : "共享分读取失败，暂用段位估分。";
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
  roster = buildLeagueRoster(named, sharedState?.ratings, calibration.applied)
    .filter((player) => Number.isFinite(player.rating))
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
  const status = inputs.disabled ? "可评分玩家不足 10 人，请补充天梯分。" :
    roster.length + " 名可选玩家 · " + manualCount + " 人已填写天梯分";
  dataStatus.textContent = sharedStatus ? status + " · " + sharedStatus : status;
  renderPool();
}

async function loadRoster() {
  try {
    const [response, sharedStatus] = await Promise.all([
      fetch("./data/league.json"),
      refreshSharedScores(),
    ]);
    if (!response.ok) throw new Error("Could not read league snapshot (HTTP " + response.status + ")");
    snapshot = await response.json();
    renderRoster(sharedStatus);
  } catch (error) {
    dataStatus.textContent = "联赛数据读取失败，请刷新页面重试。";
    console.error("Could not load the league roster", error);
  }
}

loadRoster();
