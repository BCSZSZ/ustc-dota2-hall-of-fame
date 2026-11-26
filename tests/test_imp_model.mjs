import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { estimateImp } from "../site/imp-model.js";

const models = JSON.parse(readFileSync(new URL("../site/data/imp-model.json", import.meta.url), "utf8"));

for (const name of ["minute", "basic"]) {
  test(`the browser ${name} estimate matches fit_imp.py on the match stored with the model`, () => {
    const { check } = models[name];
    const result = estimateImp(models, check.match, check.minute);
    assert.equal(result.model, name);
    // The exported weights keep 5 significant digits, so allow a small difference.
    for (const [slot, expected] of Object.entries(check.expected)) assert.ok(Math.abs(result.imp[slot] - expected) < 0.05, slot);
  });
}

test("the basic model is used when a player has no per-minute snapshot", () => {
  const { check } = models.minute;
  const minute = { ...check.minute };
  delete minute[check.match.players[0].slot];
  assert.equal(estimateImp(models, check.match, minute).model, "basic");
});

test("no estimate without every position", () => {
  const match = structuredClone(models.basic.check.match);
  match.players[3].pos = null;
  assert.equal(estimateImp(models, match), null);
});
