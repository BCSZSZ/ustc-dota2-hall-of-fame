import assert from "node:assert/strict";
import test from "node:test";

import { loadPlayerAliases } from "../site/shared-mmr.js";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
};
const answer = (aliases, delay = 0) => {
  globalThis.fetch = () => new Promise((resolve) => setTimeout(resolve, delay, {
    ok: true, status: 200, json: async () => ({ revision: 1, ratings: {}, aliases }),
  }));
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a first visit waits for the service and remembers its aliases", async () => {
  store.clear();
  answer({ 1: "甲" });
  const changes = [];
  assert.deepEqual(await loadPlayerAliases((aliases) => changes.push(aliases)), { 1: "甲" });
  await settle();
  assert.deepEqual(changes, []);
  assert.equal(store.get("ustc-hof-aliases"), JSON.stringify({ 1: "甲" }));
});

test("later visits draw remembered aliases at once and redraw only when the service differs", async () => {
  answer({ 1: "甲" }, 200);
  const started = Date.now();
  const changes = [];
  assert.deepEqual(await loadPlayerAliases((aliases) => changes.push(aliases)), { 1: "甲" });
  assert.ok(Date.now() - started < 100);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(changes, []);

  answer({ 2: "乙" });
  assert.deepEqual(await loadPlayerAliases((aliases) => changes.push(aliases)), { 1: "甲" });
  await settle();
  assert.deepEqual(changes, [{ 2: "乙" }]);
});

test("a slow first visit falls back to Steam names and redraws when the aliases arrive", async () => {
  store.clear();
  answer({ 1: "甲" }, 1700);
  const changes = [];
  assert.deepEqual(await loadPlayerAliases((aliases) => changes.push(aliases)), {});
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(changes, [{ 1: "甲" }]);
});

test("an unreachable service leaves Steam names without redrawing", async () => {
  store.clear();
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const errors = console.error;
  console.error = () => {};
  const changes = [];
  try {
    assert.deepEqual(await loadPlayerAliases((aliases) => changes.push(aliases)), {});
    await settle();
  } finally {
    console.error = errors;
  }
  assert.deepEqual(changes, []);
});
