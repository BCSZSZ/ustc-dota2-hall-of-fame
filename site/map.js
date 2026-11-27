// Minimap view for one match: hero position heatmaps and ward placements.
// Positions use OpenDota map cells (64-192 on both axes, y pointing north).


const MAP_IMAGE = "./img/map/detailed_740.webp";
export const SIZE = 640;
// The match page draws the map at full page width, so its canvas uses a finer pixel grid than SIZE.
const RES = 1440;
const LANING_SECONDS = 360;
const WARD_SECONDS = [360, 420];
const WARD_NAMES = ["假眼", "真眼"];
const PALETTE = [[0, "rgba(0,0,255,0)"], [0.25, "#2b6cff"], [0.5, "#00e0ff"], [0.65, "#3dff3d"], [0.82, "#ffe600"], [1, "#ff2200"]];

const heatFiles = new Map();
let mapImage = null;
let palette = null;

export const px = (x) => ((x - 64) / 128) * SIZE;
export const py = (y) => (1 - (y - 64) / 128) * SIZE;
export const clock = (seconds) => `${seconds < 0 ? "-" : ""}${Math.floor(Math.abs(seconds) / 60)}:${String(Math.abs(seconds) % 60).padStart(2, "0")}`;

export function loadImage() {
  if (!mapImage) {
    mapImage = new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = MAP_IMAGE;
    });
  }
  return mapImage;
}

function loadHeat(matchId) {
  if (!heatFiles.has(matchId)) {
    heatFiles.set(matchId, fetch(`./data/heat/${matchId}.json`)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null));
  }
  return heatFiles.get(matchId);
}

function heatPalette() {
  if (!palette) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    const gradient = context.createLinearGradient(0, 0, 256, 0);
    for (const [stop, color] of PALETTE) gradient.addColorStop(stop, color);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 1);
    palette = context.getImageData(0, 0, 256, 1).data;
  }
  return palette;
}

// Sum seconds per cell for the chosen players and time slices, then draw blurred blobs and colour them by density.
function drawHeat(context, heat, slots, phase, skipLaning) {
  const cells = new Map();
  for (const slot of slots) {
    const flat = heat.players[slot] || [];
    for (let index = 0; index < flat.length; index += 4) {
      const start = flat[index] * heat.phase_seconds;
      if (phase !== "all" && Math.floor(start / 600) !== phase) continue;
      if (skipLaning && start < LANING_SECONDS) continue;
      const key = flat[index + 1] * 1000 + flat[index + 2];
      cells.set(key, (cells.get(key) || 0) + flat[index + 3]);
    }
  }
  if (!cells.size) return 0;
  const peak = Math.log1p(Math.max(...cells.values()));
  const layer = document.createElement("canvas");
  layer.width = layer.height = RES;
  const shadow = layer.getContext("2d");
  shadow.scale(RES / SIZE, RES / SIZE);
  const step = (heat.bin / 128) * SIZE;
  const radius = step * 1.6;
  for (const [key, seconds] of cells) {
    const x = 64 + (Math.floor(key / 1000) + 0.5) * heat.bin;
    const y = 64 + ((key % 1000) + 0.5) * heat.bin;
    const gradient = shadow.createRadialGradient(px(x), py(y), 0, px(x), py(y), radius);
    gradient.addColorStop(0, `rgba(0,0,0,${Math.max(0.08, Math.log1p(seconds) / peak)})`);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    shadow.fillStyle = gradient;
    shadow.fillRect(px(x) - radius, py(y) - radius, radius * 2, radius * 2);
  }
  const image = shadow.getImageData(0, 0, RES, RES);
  const colours = heatPalette();
  for (let index = 0; index < image.data.length; index += 4) {
    const alpha = image.data[index + 3];
    if (!alpha) continue;
    const offset = Math.min(255, alpha) * 4;
    image.data[index] = colours[offset];
    image.data[index + 1] = colours[offset + 1];
    image.data[index + 2] = colours[offset + 2];
    image.data[index + 3] = Math.min(230, alpha * 1.6);
  }
  shadow.putImageData(image, 0, 0);
  context.drawImage(layer, 0, 0, SIZE, SIZE);
  return [...cells.values()].reduce((sum, seconds) => sum + seconds, 0);
}

// Opacity follows how much of its full duration the ward stayed up; 90% or more is fully opaque.
function lifeAlpha(ward) {
  const ratio = Math.min(1, ward.shown / WARD_SECONDS[ward.kind] / 0.9);
  return 0.2 + 0.8 * ratio;
}

const expired = (ward) => ward.life !== null && !ward.destroyed;

function drawWards(context, wards) {
  context.font = "11px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const ward of wards) {
    const x = px(ward.x);
    const y = py(ward.y);
    const radius = ward.kind === 0 ? 6 : 5;
    context.globalAlpha = lifeAlpha(ward);
    context.fillStyle = ward.slot < 128 ? "#3ddc6a" : "#ff4b3a";
    context.strokeStyle = "rgba(255,255,255,0.9)";
    context.lineWidth = 1.2;
    context.beginPath();
    if (ward.kind === 0) context.arc(x, y, radius, 0, Math.PI * 2);
    else context.rect(x - radius, y - radius, radius * 2, radius * 2);
    context.fill();
    context.stroke();
    context.globalAlpha = 1;
    if (expired(ward)) context.fillText("✨", x + radius + 3, y - radius - 1);
  }
}

function wardRows(detail, duration) {
  return (detail.wards || []).map(([kind, slot, time, x, y, life, destroyed, by]) => ({
    kind, slot, time, x, y, life, destroyed: Boolean(destroyed), by,
    shown: life === null ? Math.max(0, duration - time) : life,
  }));
}

function wardSummary(match, wards, ui) {
  const rows = match.players.map((player) => {
    const own = wards.filter((ward) => ward.slot === player.slot);
    const observers = own.filter((ward) => ward.kind === 0);
    const finished = observers.filter((ward) => ward.life !== null);
    const lost = observers.filter((ward) => ward.destroyed).length;
    const average = finished.length ? Math.round(finished.reduce((sum, ward) => sum + ward.life, 0) / finished.length) : null;
    const dewards = wards.filter((ward) => ward.by === player.slot && ward.destroyed && (ward.slot < 128) !== (player.slot < 128)).length;
    return { player, observers: observers.length, sentries: own.length - observers.length, lost, average, dewards };
  }).filter((row) => row.observers || row.sentries || row.dewards);
  if (!rows.length) return null;
  const head = ["选手", "假眼", "被排", "假眼平均存活", "真眼", "排掉对方眼"];
  return ui.el("div", { class: "table-scroll" }, ui.el("table", { class: "data-table map-wards" },
    ui.el("thead", {}, ui.el("tr", {}, head.map((label) => ui.el("th", { scope: "col" }, label)))),
    ui.el("tbody", {}, rows.map((row) => ui.el("tr", { class: row.player.slot < 128 ? "radiant" : "dire" },
      ui.el("td", {}, ui.heroLabel(row.player.hero)),
      ui.el("td", { class: "num" }, row.observers),
      ui.el("td", { class: "num" }, row.observers ? `${row.lost}（${Math.round((row.lost / row.observers) * 100)}%）` : "—"),
      ui.el("td", { class: "num" }, row.average === null ? "—" : clock(row.average)),
      ui.el("td", { class: "num" }, row.sentries),
      ui.el("td", { class: "num" }, row.dewards))))));
}

export function matchMap(match, detail, ui) {
  const { el } = ui;
  const view = { layer: "heat", slots: new Set(match.players.map((player) => String(player.slot))), phase: "all", skipLaning: false, kinds: new Set([0, 1]) };
  const canvas = el("canvas", { width: RES, height: RES, class: "map-canvas", role: "img" });
  const tip = el("div", { class: "map-tip", hidden: true });
  const controls = el("div", { class: "map-controls" });
  const note = el("p", { class: "draft-meta map-note" });
  const summary = el("div", { class: "map-summary" });
  const wards = wardRows(detail, match.duration || 0);
  let heat = detail.lane_heat || null;
  let fullGame = false;
  let visible = [];

  const heroBy = new Map(match.players.map((player) => [player.slot, player.hero]));
  const nameOf = (slot) => (heroBy.has(slot) ? ui.heroName(heroBy.get(slot)) : "未知单位");

  function button(label, active, onclick, extra = {}) {
    return el("button", { type: "button", class: active ? "active" : "", "aria-pressed": String(active), onclick, ...extra }, label);
  }

  function renderControls() {
    const sides = [["全部", () => true], ["天辉", (player) => player.slot < 128], ["夜魇", (player) => player.slot >= 128], ["取消全选", () => false]];
    const phases = heat && fullGame ? Math.floor((heat.duration || 0) / 600) + 1 : 0;
    const canSkipLaning = heat && fullGame && LANING_SECONDS % heat.phase_seconds === 0;
    if (!canSkipLaning) view.skipLaning = false;
    controls.replaceChildren(...[
      el("div", { class: "map-row" },
        button("英雄活动", view.layer === "heat", () => { view.layer = "heat"; draw(); }),
        button("视野", view.layer === "wards", () => { view.layer = "wards"; draw(); })),
      el("div", { class: "map-row" },
        sides.map(([label, test]) => button(label, false, () => {
          view.slots = new Set(match.players.filter(test).map((player) => String(player.slot)));
          draw();
        })),
        match.players.map((player) => el("button", {
          type: "button",
          class: `map-hero ${player.slot < 128 ? "radiant" : "dire"}${view.slots.has(String(player.slot)) ? " active" : ""}`,
          "aria-pressed": String(view.slots.has(String(player.slot))),
          title: `${ui.heroName(player.hero)}（点击切换显示）`,
          onclick: () => {
            const key = String(player.slot);
            if (view.slots.has(key)) view.slots.delete(key);
            else view.slots.add(key);
            draw();
          },
        }, ui.heroIcon(player.hero)))),
      view.layer === "heat" && phases > 1
        ? el("div", { class: "map-row" }, button("整局", view.phase === "all", () => { view.phase = "all"; draw(); }),
          Array.from({ length: phases }, (_, phase) => button(`${phase * 10}–${phase * 10 + 10}′`, view.phase === phase, () => { view.phase = phase; draw(); })))
        : null,
      view.layer === "heat" && canSkipLaning
        ? el("label", { class: "map-check" }, el("input", {
          type: "checkbox",
          checked: view.skipLaning,
          onchange: (event) => { view.skipLaning = event.target.checked; draw(); },
        }), "过滤前 6 分钟（对线期）")
        : null,
      view.layer === "wards"
        ? el("div", { class: "map-row" }, WARD_NAMES.map((label, kind) => button(label, view.kinds.has(kind), () => {
          if (view.kinds.has(kind)) view.kinds.delete(kind);
          else view.kinds.add(kind);
          draw();
        })))
        : null,
    ].filter(Boolean));
  }

  async function draw() {
    renderControls();
    const image = await loadImage();
    const context = canvas.getContext("2d");
    context.setTransform(RES / SIZE, 0, 0, RES / SIZE, 0, 0);
    context.clearRect(0, 0, SIZE, SIZE);
    if (image) context.drawImage(image, 0, 0, SIZE, SIZE);
    else {
      context.fillStyle = "#24332b";
      context.fillRect(0, 0, SIZE, SIZE);
    }
    summary.replaceChildren();
    if (view.layer === "heat") {
      visible = [];
      const total = heat ? drawHeat(context, heat, view.slots, view.phase, view.skipLaning) : 0;
      canvas.setAttribute("aria-label", "英雄位置热力图");
      note.replaceChildren(fullGame
        ? `整局位置，来自本站解析的录像，每秒采样一次，只计存活时间。颜色越暖表示停留越久（对数刻度）。当前选择共 ${Math.round(total / 60)} 分钟的位置${view.skipLaning ? "（已去掉前 6 分钟）" : ""}。`
        : "前 10 分钟位置（OpenDota 对线期数据，含开局前 90 秒）。录像下载并解析完成后，这里会自动换成整局热力图。");
      if (!total) note.append(" 当前选择没有位置数据。");
    } else {
      visible = wards.filter((ward) => view.slots.has(String(ward.slot)) && view.kinds.has(ward.kind));
      drawWards(context, visible);
      canvas.setAttribute("aria-label", "眼位分布图");
      note.replaceChildren("圆点是假眼，方块是真眼；绿色是天辉，红色是夜魇。颜色深浅表示存活时间：越淡越早被排，存活超过 90% 时长（假眼 6 分钟、真眼 7 分钟）颜色最深；✨ 表示活到自然消失、没被排掉。悬停查看详情。");
      const table = wardSummary(match, wards, ui);
      if (table) summary.append(table);
      else summary.append(el("p", { class: "draft-meta" }, "这场没有眼位记录。"));
    }
  }

  canvas.addEventListener("mousemove", (event) => {
    if (view.layer !== "wards") return;
    const box = canvas.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * SIZE;
    const y = ((event.clientY - box.top) / box.height) * SIZE;
    const near = visible.filter((ward) => Math.hypot(px(ward.x) - x, py(ward.y) - y) < 9);
    if (!near.length) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren(...near.slice(0, 4).map((ward) => el("div", {},
      `${nameOf(ward.slot)}的${WARD_NAMES[ward.kind]} · ${clock(ward.time)} 插下 · `,
      ward.life === null ? `比赛结束时还在（${clock(ward.shown)}）`
        : ward.destroyed ? `存活 ${clock(ward.life)}，被${nameOf(ward.by)}排掉` : `活满 ${clock(ward.life)}`)));
    tip.hidden = false;
    tip.style.left = `${event.clientX - box.left + 12}px`;
    tip.style.top = `${event.clientY - box.top + 12}px`;
  });
  canvas.addEventListener("mouseleave", () => { tip.hidden = true; });

  loadHeat(match.match_id).then((payload) => {
    if (payload?.players && Object.keys(payload.players).length) {
      heat = payload;
      fullGame = true;
    }
    draw();
  });

  return el("div", { class: "match-map" }, controls, el("div", { class: "map-stage" }, canvas, tip), note, summary);
}
