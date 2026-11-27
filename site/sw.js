// Serves the site's own files from Cache Storage so a repeat visit needs no network round trip.
// Images and versioned files (?v=) never change under the same URL, so they are kept as first fetched.
// Pages and data are shown from the cache and refreshed in the background: a new collection appears on the
// next visit. Bump CACHE to drop everything, e.g. after replacing an image or changing a data format; a visitor
// can do the same for themselves with the "强制刷新" button (refresh.js).
const CACHE = "hof-2";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  // A page's HTML is the same for every query (?id=…), so one copy serves them all.
  const key = event.request.mode === "navigate" ? url.origin + url.pathname : event.request;
  const fixed = url.searchParams.has("v") || url.pathname.includes("/img/");
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    if (cached && fixed) return cached;
    // "no-cache" asks the server (a cheap 304 when unchanged) instead of taking the browser's HTTP cache, which
    // GitHub Pages lets keep a file for 10 minutes; this cache is then the only one between the site and the server.
    const fresh = fetch(event.request, { cache: "no-cache" }).then((response) => {
      if (response.ok) event.waitUntil(cache.put(key, response.clone()));
      return response;
    });
    if (!cached) return fresh;
    event.waitUntil(fresh.catch(() => {}));
    return cached;
  })());
});
