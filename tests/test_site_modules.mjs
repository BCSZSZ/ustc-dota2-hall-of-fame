import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const site = new URL("../site/", import.meta.url);
const read = (name) => readFileSync(new URL(name, site), "utf8");
const importsOf = (name) => [...read(name.split("?")[0]).matchAll(/^import [^;]*? from "\.\/([^"]+)";/gms)].map((match) => match[1]);

test("each module is imported under one version, so pages never load two copies", () => {
  const versions = new Map();
  for (const file of readdirSync(site).filter((name) => name.endsWith(".js"))) {
    for (const spec of importsOf(file)) {
      const [path] = spec.split("?");
      versions.set(path, new Set([...(versions.get(path) ?? []), spec]));
    }
  }
  for (const [path, specs] of versions) assert.equal(specs.size, 1, `${path}: ${[...specs].join(", ")}`);
});

test("every page preloads exactly its entry module's imports", () => {
  for (const page of readdirSync(site).filter((name) => name.endsWith(".html"))) {
    const html = read(page);
    const entry = html.match(/<script src="\.\/([^"]+)" type="module">/)[1];
    const graph = new Set();
    const visit = (spec) => importsOf(spec).forEach((child) => graph.has(child) || (graph.add(child), visit(child)));
    visit(entry);
    const preloaded = [...html.matchAll(/<link rel="modulepreload" href="\.\/([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(new Set(preloaded), graph, page);
  }
});

test("data preloads match how modules fetch them, so the browser reuses the download", () => {
  for (const page of readdirSync(site).filter((name) => name.endsWith(".html"))) {
    const html = read(page);
    for (const [link] of html.matchAll(/<link rel="preload"[^>]*>/g)) {
      // fetch() requests are CORS with same-origin credentials; a preload without crossorigin never matches.
      assert.match(link, /^<link rel="preload" href="\.\/data\/[\w-]+\.json" as="fetch" crossorigin \/>$/, `${page}: ${link}`);
      read(link.match(/href="\.\/([^"]+)"/)[1]);
    }
    // refresh.js registers the service worker and runs the page's "强制刷新" button.
    assert.match(html, /<script src="\.\/refresh\.js\?v=\d+" defer><\/script>/, page);
    assert.match(html, /data-hard-refresh/, page);
  }
  assert.match(read("refresh.js"), /navigator\.serviceWorker\.register\("\.\/sw\.js"\)/);
});
