import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { estimateImp } from "../site/imp-model.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/imp_estimate.json", import.meta.url), "utf8"));

test("the browser estimate matches fit_imp.py on the shared fixture", () => {
  const result = estimateImp(fixture.model, fixture.match);
  for (const [slot, expected] of Object.entries(fixture.expected)) assert.ok(Math.abs(result[slot] - expected) < 1e-9, slot);
});

test("no estimate without every position", () => {
  const match = structuredClone(fixture.match);
  match.players[3].pos = null;
  assert.equal(estimateImp(fixture.model, match), null);
});
