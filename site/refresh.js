// Repeat visits are served from the service worker's cache (sw.js), so a new deploy shows on the visit after the
// one that fetched it. Local servers skip the worker so edits show at once. The "强制刷新" button in each page's
// navigation empties that cache, asks the browser to check for a newer sw.js, and reloads; with the cache empty
// the worker fetches every file from the server again (sw.js revalidates instead of trusting the HTTP cache).
const serviceWorkerOn = !["localhost", "127.0.0.1"].includes(location.hostname) && "serviceWorker" in navigator;
if (serviceWorkerOn) navigator.serviceWorker.register("./sw.js");

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-hard-refresh]");
  if (!button) return;
  button.disabled = true;
  button.textContent = "正在刷新……";
  if ("caches" in window) await Promise.all((await caches.keys()).map((name) => caches.delete(name)));
  if (serviceWorkerOn) {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update().catch(() => {});
  }
  location.reload();
});
