// Local IMP estimate for matches STRATZ has not scored (it never scores matches with Kez).
// The model is fitted by fit_imp.py; features() and the soft clip must stay identical to the Python version there.

// Past the model's clip range an estimate keeps only a fifth of the excess, so order is kept.
const CLIP_SLOPE = 0.2;
const softClip = (value, [low, high]) =>
  value > high ? high + (value - high) * CLIP_SLOPE : value < low ? low + (value - low) * CLIP_SLOPE : value;

export function features(player, team, won, minutes) {
  const value = (key) => player[key] ?? 0;
  const total = (key) => team.reduce((sum, other) => sum + (other[key] ?? 0), 0) || 1;
  return [
    won ? 1 : 0, minutes, value("k") / minutes, value("d") / minutes, value("a") / minutes, value("lh") / minutes,
    value("dn") / minutes, value("gpm"), value("xpm"), value("hd") / minutes, value("td") / minutes,
    value("hh") / minutes, value("lvl"), (value("k") + value("a")) / total("k"), value("hd") / total("hd"),
    value("nw") / total("nw"), value("lh") / total("lh"), value("td") / total("td"), value("d") / total("d"),
    value("hh") / total("hh"),
  ];
}

// Estimated IMP by player slot, or null when a player's position is unknown.
export function estimateImp(model, match) {
  if (!model?.groups || !match.duration || match.players.some((player) => !player.pos)) return null;
  const minutes = match.duration / 60;
  const result = {};
  for (const player of match.players) {
    const radiant = player.slot < 128;
    const team = match.players.filter((other) => (other.slot < 128) === radiant);
    const won = radiant === match.radiant_win;
    const weights = model.groups[`${player.pos}-${won ? 1 : 0}`];
    if (!weights) return null;
    const x = features(player, team, won, minutes);
    const value = weights.intercept + (model.hero_offset[player.hero] ?? 0) +
      weights.coef.reduce((sum, coef, index) => sum + (coef * (x[index] - model.mean[index])) / model.sd[index], 0);
    result[player.slot] = softClip(value, model.clip);
  }
  return result;
}
