import { buildLeagueRoster, findBalancedTeams } from "./matchmaker-model.js?v=1";

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

const memberCount = 8;
const selected = new Set();
const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", minimumFractionDigits: 1 });
let roster = [];
let playersById = new Map();

function make(tag, className, text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function captainIds() {
  return captainFields.map((field) => Number(field.value));
}

function scoreDetails(player) {
  const source = player.usedOpenDotaMedian ? "联赛中位数暂估" : "OpenDota 排位 Elo";
  return `${source} ${integer.format(player.openDotaRating)} · 内战 Elo ${integer.format(player.inhouseRating)}（${player.games} 场算分）`;
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
    const account = player.usedOpenDotaMedian ? `${player.accountId} · 暂估` : String(player.accountId);
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
    if (player.usedOpenDotaMedian) label.append(make("small", "draft-role", "暂估"));
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
    make("h3", "", `方案 ${index + 1}`),
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

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  const [captainA, captainB] = captainIds().map((id) => playersById.get(id));
  const others = [...selected].map((id) => playersById.get(id));
  const result = findBalancedTeams(captainA, captainB, others);
  resultsSummary.textContent = result.withinRange === 0
    ? `${result.examined} 套分法均超出 45%–55% 区间，显示最接近五五开的一套。`
    : `${result.examined} 套分法中有 ${result.withinRange} 套在 45%–55% 区间，显示 ${result.plans.length} 套。`;
  plans.replaceChildren(...result.plans.map(renderPlan));
  results.hidden = false;
  resultsTitle.focus({ preventScroll: true });
  results.scrollIntoView({ block: "start" });
});

async function loadRoster() {
  try {
    const response = await fetch("./data/league.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    roster = buildLeagueRoster(snapshot)
      .filter((player) => Number.isFinite(player.rating))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.accountId - right.accountId);
    if (roster.length < 10) {
      dataStatus.textContent = "当前快照的可评分玩家不足 10 人，请等待数据刷新。";
      return;
    }
    playersById = new Map(roster.map((player) => [player.accountId, player]));
    for (const captain of captainFields) {
      for (const player of roster) {
        captain.append(new Option(`${player.name} · ${player.accountId}`, player.accountId));
      }
    }
    const tentative = roster.filter((player) => player.usedOpenDotaMedian).length;
    dataStatus.textContent = `${roster.length} 名可选玩家${tentative ? ` · ${tentative} 人暂用中位数` : ""}`;
    inputs.disabled = false;
    renderPool();
  } catch (error) {
    dataStatus.textContent = "联赛数据读取失败，请刷新页面重试。";
    console.error("Could not load the league roster", error);
  }
}

loadRoster();
