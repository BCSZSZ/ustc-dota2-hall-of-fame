import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { estimateImp } from "../site/imp-model.js";

const model = JSON.parse(readFileSync(new URL("../site/data/imp-model.json", import.meta.url), "utf8"));

test("the browser estimate matches fit_imp.py on the match stored with the model", () => {
  const result = estimateImp(model, model.check.match);
  // The exported weights keep 5 significant digits, so allow a small difference.
  for (const [slot, expected] of Object.entries(model.check.expected)) assert.ok(Math.abs(result[slot] - expected) < 0.05, slot);
});

test("no estimate without every position", () => {
  const match = structuredClone(model.check.match);
  match.players[3].pos = null;
  assert.equal(estimateImp(model, match), null);
});
