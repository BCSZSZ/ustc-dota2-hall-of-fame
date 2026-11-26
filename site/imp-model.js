// Local IMP estimate for matches STRATZ has not scored (it never scores matches with Kez), from end-of-game
// stats. The model is fitted by fit_imp.py into data/imp-model.json; base() and the feature order must stay
// identical to the Python version there.
const KEYS = ["k", "d", "a", "lh", "dn", "gpm", "xpm", "hd", "td", "hh", "nw", "lvl"];

function base(p, team, enemy, m, won) {
  const v = {}, T = {}, E = {};
  for (const k of KEYS) {
    v[k] = p[k] ?? 0;
    T[k] = team.reduce((s, o) => s + (o[k] ?? 0), 0);
    E[k] = enemy.reduce((s, o) => s + (o[k] ?? 0), 0);
  }
  const f = { won: won ? 1 : 0, min: m, logmin: Math.log(m) };
  for (const k of ["k", "d", "a", "lh", "dn", "hd", "td", "hh"]) f[k + "pm"] = v[k] / m;
  Object.assign(f, { gpm: v.gpm, xpm: v.xpm, lvl: v.lvl, nwpm: v.nw / m });
  for (const k of ["k", "d", "a", "lh", "dn"]) f[`l_${k}pm`] = Math.log1p(v[k] / m);
  for (const k of ["hd", "td", "hh"]) f["l_" + k] = Math.log1p(v[k] / m);
  f.l_gpm = Math.log(v.gpm + 50);
  f.l_xpm = Math.log(v.xpm + 50);
  f.l_kda = Math.log((v.k + v.a + 1) / (v.d + 1));
  for (const k of ["k", "d", "a", "lh", "dn", "hd", "td", "hh", "nw", "gpm", "xpm"]) f[k + "_sh"] = v[k] / Math.max(T[k], 1);
  f.kp = (v.k + v.a) / Math.max(T.k, 1);
  f.t_kdiff_pm = (T.k - E.k) / m;
  f.t_nwdiff = (T.nw - E.nw) / Math.max(T.nw + E.nw, 1);
  f.t_xpdiff = (T.xpm - E.xpm) / Math.max(T.xpm + E.xpm, 1);
  f.t_tddiff = (T.td - E.td) / Math.max(T.td + E.td, 1);
  Object.assign(f, { t_kpm: T.k / m, e_kpm: E.k / m, t_hdpm: T.hd / m, e_hdpm: E.hd / m });
  f.hd_vs_e = v.hd / Math.max(E.hd, 1);
  f.d_vs_ek = v.d / Math.max(E.k, 1);
  f.k_vs_ed = v.k / Math.max(E.d, 1);
  f.ka_vs_ed = (v.k + v.a) / Math.max(E.d, 1);
  return f;
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// Estimated IMP by player slot, or null when the match lacks a duration or a player's position.
export function estimateImp(model, match) {
  if (!model?.groups || !match.duration || match.players.some((p) => !p.pos)) return null;
  const m = match.duration / 60;
  const radiant = (p) => p.slot < 128;
  // own features and hero-normalised stats (stat minus hero-position expectation) for all ten players
  const info = match.players.map((p) => {
    const team = match.players.filter((o) => radiant(o) === radiant(p));
    const enemy = match.players.filter((o) => radiant(o) !== radiant(p));
    const won = radiant(p) === match.radiant_win;
    const f = base(p, team, enemy, m, won);
    const mu = model.hero_mu[`${p.hero}-${p.pos}`] ?? model.pos_mu[p.pos];
    const z = Object.fromEntries(model.zn.map((n, i) => [n, f[n] - mu[i]]));
    return { p, f, z, won };
  });
  const mean = (list, n) => list.reduce((s, o) => s + o.z[n], 0) / list.length;
  const result = {};
  for (const me of info) {
    const { p, f, z, won } = me;
    const mates = info.filter((o) => o !== me && radiant(o.p) === radiant(p));
    const foes = info.filter((o) => radiant(o.p) !== radiant(p));
    const x = [...model.base.map((n) => f[n]), ...model.zn.map((n) => z[n]),
      ...model.cz.map((n) => mean(mates, n)), ...model.cz.map((n) => mean(foes, n))];
    for (const side of [mates, foes]) {
      for (let q = 1; q <= 5; q++) {
        const o = side.find((s) => s.p.pos === q);
        for (const n of model.kz) x.push(o ? o.z[n] : 0);
      }
    }
    const group = model.groups[`${p.pos}-${won ? 1 : 0}`];
    if (!group) return null;
    let value = group.b + dot(group.w, x) + (model.hero_offset[`${p.hero}-${p.pos}`] ?? 0);
    const P = model.poly;
    const zp = P.idx.map((j, i) => (x[j] - P.mean[i]) / P.sd[i]);
    let k = 0;
    for (let i = 0; i < zp.length; i++) for (let j = i; j < zp.length; j++) value += P.w[k++] * zp[i] * zp[j];
    for (const o of match.players) {
      if (o === p) continue;
      const tag = radiant(o) === radiant(p) ? "a" : "e";
      value += (model.draft[`${tag}${o.hero}`] ?? 0) + (model.draft[`${tag}${o.hero}-${p.pos}`] ?? 0);
    }
    const { knots, c } = model.calib;
    result[p.slot] = c[0] + c[1] * value + knots.reduce((s, kn, i) => s + c[i + 2] * Math.max(value - kn, 0), 0);
  }
  return result;
}
