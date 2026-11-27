// Death review for one match.
// Rows come from data/deaths.json (OpenDota's death log joined with our replay parse); the map snapshot at the
// moment of a death is read from data/replay/{id}.json when a row is opened.

import { SIZE, clock, loadImage, px, py } from "./map.js?v=5";

const REGIONS = { own_base: "己方基地", own_half: "己方半场", river: "河道", enemy_half: "敌方半场", enemy_base: "敌方基地" };
const LOST = { tower: "塔", barracks: "兵营", ancient: "基地", roshan: "肉山" };

let indexRows = null;
const replays = new Map();
const heroImages = new Map();

export function loadDeaths() {
  indexRows ??= fetch("./data/deaths.json")
    .then((response) => (response.ok ? response.json() : { columns: [], rows: [] }))
    .catch(() => ({ columns: [], rows: [] }))
    .then(({ columns, rows }) => rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))));
  return indexRows;
}

function loadReplay(matchId) {
  if (!replays.has(matchId)) {
    replays.set(matchId, fetch(`./data/replay/${matchId}.json`)
      .then((response) => (response.ok ? response.json() : null)).catch(() => null));
  }
  return replays.get(matchId);
}

function heroImage(id) {
  if (!heroImages.has(id)) {
    heroImages.set(id, new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = `./img/heroes/${id}.webp`;
    }));
  }
  return heroImages.get(id);
}

const positioned = (death) => death.region !== null && death.region !== undefined;
// Alone: no living teammate within 1200 units. Whether a death was a mistake is left to the reader.
const isAlone = (death) => death.allies === 0;
const radiantSlot = (slot) => slot < 128;

function killerText(death, match, ui) {
  if (typeof death.killer === "number") {
    const player = match.players.find((entry) => entry.slot === death.killer);
    return player ? ui.heroLabel(player.hero) : "敌方英雄";
  }
  const unit = String(death.killer || "");
  if (!unit) return "—";
  if (unit.includes("tower") || unit.includes("fort")) return "防御塔";
  if (unit.includes("creep") || unit.includes("siege")) return "小兵";
  if (unit.includes("neutral")) return "野怪";
  if (unit.includes("roshan")) return "肉山";
  return "其他单位";
}

function tags(death, ui) {
  if (!positioned(death)) return "—";
  return isAlone(death) ? ui.el("span", { class: "death-tag alone", title: "1200 码内没有存活的队友" }, "孤立") : null;
}

function drawDots(context, deaths, highlight) {
  for (const death of deaths.filter(positioned)) {
    const x = px(death.x);
    const y = py(death.y);
    context.lineWidth = 2;
    context.strokeStyle = radiantSlot(death.slot) ? "#7dff9a" : "#ff6b5a";
    context.fillStyle = isAlone(death) ? "#ff2a2a" : "rgba(20, 10, 8, 0.55)";
    context.beginPath();
    context.arc(x, y, death === highlight ? 9 : 6, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
}

async function drawBase(canvas) {
  const image = await loadImage();
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, SIZE, SIZE);
  if (image) context.drawImage(image, 0, 0, SIZE, SIZE);
  else {
    context.fillStyle = "#24332b";
    context.fillRect(0, 0, SIZE, SIZE);
  }
  return context;
}

async function drawSnapshot(canvas, match, death) {
  const replay = await loadReplay(match.match_id);
  const event = replay?.deaths?.find((entry) => entry.slot === death.slot && entry.t === death.t);
  const context = await drawBase(canvas);
  if (!event) {
    drawDots(context, [death], death);
    return false;
  }
  const players = [...match.players].sort((a, b) => a.slot - b.slot);
  const radius = (1200 / 128 / 128) * SIZE;
  context.strokeStyle = "rgba(255, 255, 255, 0.7)";
  context.setLineDash([6, 4]);
  context.beginPath();
  context.arc(px(death.x), py(death.y), radius, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);
  for (const [index, spot] of event.snapshot.entries()) {
    const player = players[index];
    const [x, y] = index === players.findIndex((entry) => entry.slot === death.slot) ? [death.x, death.y] : spot || [];
    if (!player || x === undefined) continue;
    const image = await heroImage(player.hero);
    const width = 40;
    const height = 23;
    context.lineWidth = 3;
    context.strokeStyle = radiantSlot(player.slot) ? "#3ddc6a" : "#ff4d3d";
    context.strokeRect(px(x) - width / 2, py(y) - height / 2, width, height);
    if (image) context.drawImage(image, px(x) - width / 2, py(y) - height / 2, width, height);
    if (player.slot === death.slot) {
      context.strokeStyle = "#fff";
      context.lineWidth = 4;
      context.beginPath();
      context.moveTo(px(x) - 12, py(y) - 12);
      context.lineTo(px(x) + 12, py(y) + 12);
      context.moveTo(px(x) + 12, py(y) - 12);
      context.lineTo(px(x) - 12, py(y) + 12);
      context.stroke();
    }
  }
  return true;
}

export function deathReview(match, ui) {
  const { el } = ui;
  const box = el("div", { class: "death-review" }, el("p", { class: "draft-meta" }, "正在读取死亡记录……"));
  loadDeaths().then((rows) => {
    const deaths = rows.filter((row) => row.match_id === match.match_id).sort((a, b) => a.t - b.t || a.slot - b.slot);
    if (!deaths.length) {
      box.replaceChildren(el("p", { class: "draft-meta" }, "这场还没有死亡记录（需要 OpenDota 解析完成）。"));
      return;
    }
    const view = { side: "all", aloneOnly: false, open: null };
    const playerOf = (slot) => match.players.find((player) => player.slot === slot);
    const canvas = el("canvas", { width: SIZE, height: SIZE, class: "map-canvas", role: "img", "aria-label": "死亡位置图" });
    const caption = el("p", { class: "draft-meta map-note" });
    const controls = el("div", { class: "map-row" });
    const body = el("tbody");
    const anyPositioned = deaths.some(positioned);

    const summary = [true, false].map((radiant) => {
      const list = deaths.filter((death) => radiantSlot(death.slot) === radiant);
      const placed = list.filter(positioned);
      return el("div", { class: `death-sum ${radiant ? "radiant" : "dire"}` },
        el("b", {}, radiant ? "天辉" : "夜魇"),
        ` 死亡 ${list.length} 次`,
        placed.length ? ` · 孤立 ${placed.filter(isAlone).length}` : "",
        ` · 死后 90 秒内丢目标 ${list.filter((death) => death.lost.length).length} 次`);
    });

    const shown = () => deaths.filter((death) =>
      (view.side === "all" || (view.side === "radiant") === radiantSlot(death.slot)) && (!view.aloneOnly || (positioned(death) && isAlone(death))));

    async function drawOverview() {
      const context = await drawBase(canvas);
      drawDots(context, shown(), null);
      caption.replaceChildren(anyPositioned
        ? "每个点是一次死亡，边框颜色是阵亡方（绿天辉、红夜魇），实心红点是孤立死亡。点表格里的一行，查看那一刻 10 名英雄的位置。"
        : "录像还没解析，暂时没有死亡位置。");
    }

    function button(label, active, onclick) {
      return el("button", { type: "button", class: active ? "active" : "", "aria-pressed": String(active), onclick }, label);
    }

    function render() {
      controls.replaceChildren(
        button("全部", view.side === "all", () => { view.side = "all"; render(); }),
        button("天辉阵亡", view.side === "radiant", () => { view.side = "radiant"; render(); }),
        button("夜魇阵亡", view.side === "dire", () => { view.side = "dire"; render(); }),
        anyPositioned ? button("只看孤立死亡", view.aloneOnly, () => { view.aloneOnly = !view.aloneOnly; render(); }) : null);
      body.replaceChildren(...shown().map((death) => {
        const victim = playerOf(death.slot);
        const open = view.open === death;
        return el("tr", {
          class: `${radiantSlot(death.slot) ? "radiant" : "dire"}${open ? " open" : ""}${positioned(death) && isAlone(death) ? " alone" : ""}`,
          tabindex: "0",
          onclick: () => select(death),
          onkeydown: (event) => { if (event.key === "Enter") select(death); },
        },
        el("td", { class: "num" }, clock(death.t)),
        el("td", {}, victim ? ui.heroLabel(victim.hero) : "—"),
        el("td", {}, killerText(death, match, ui)),
        el("td", { class: "num" }, death.attackers ?? "—"),
        el("td", {}, positioned(death) ? REGIONS[death.region] : "—"),
        el("td", { class: "num" }, positioned(death) ? `${death.allies} / ${death.enemies}` : "—"),
        el("td", { class: "num" }, death.gold_lost ?? "—"),
        el("td", { class: "num" }, death.time_dead ? `${death.time_dead} 秒` : "—"),
        el("td", {}, death.buyback ? "买活" : ""),
        el("td", {}, death.lost.map((kind) => LOST[kind]).join("、") || ""),
        el("td", {}, tags(death, ui)));
      }));
      if (view.open && shown().includes(view.open)) drawSnapshot(canvas, match, view.open).then((ok) => describe(view.open, ok));
      else {
        view.open = null;
        drawOverview();
      }
    }

    function describe(death, ok) {
      const victim = playerOf(death.slot);
      caption.replaceChildren(`${clock(death.t)} ${victim ? ui.heroName(victim.hero) : ""}阵亡时的位置：`,
        ok ? "绿框天辉、红框夜魇，× 是阵亡者，虚线圈是 1200 码。再点一次这一行回到全部死亡点。" : "这场没有录像位置。");
    }

    function select(death) {
      view.open = view.open === death ? null : death;
      render();
    }

    box.replaceChildren(
      el("div", { class: "death-sums" }, summary),
      controls,
      el("div", { class: "death-layout" },
        el("div", { class: "map-stage" }, canvas),
        el("div", { class: "table-scroll death-table-wrap" }, el("table", { class: "data-table death-table" },
          el("thead", {}, el("tr", {}, ["时间", "阵亡", "击杀者", "参与", "位置", "附近队友 / 敌人", "损失金钱", "复活", "买活", "随后丢失", "孤立"]
            .map((label) => el("th", { scope: "col" }, label)))),
          body))),
      caption,
      el("p", { class: "draft-meta" },
        "参与：死前 10 秒对阵亡者造成伤害的敌方英雄数。附近：1200 码内存活的英雄。孤立：1200 码内没有存活的队友。",
        "随后丢失：死后 90 秒内本方被拆的建筑或被敌方击杀的肉山。半场以河道为界，基地为泉水周围约 3600 码。"));
    render();
  });
  return box;
}
