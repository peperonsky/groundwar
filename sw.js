// Groundwar service worker — pre-caches the app shell (this file list) so
// the app itself installs and opens offline. Other same-origin files it
// sees fetched, which in practice means the pre-built tiles in data/
// (battles, events, people), are cached as they're used, so a place
// you've already searched still shows its results offline. Cross-origin
// calls (Wikipedia, Nominatim, map tiles, CDN scripts, and Wikidata on
// the rare live fallback) always go straight to the network.
// This is also what makes the app eligible for real app-store packaging —
// Android's Trusted Web Activity wrapper (via Bubblewrap/PWABuilder) and
// Lighthouse's installability check both require an active service worker.
//
// Bump CACHE_VERSION whenever a shell file changes materially — the old
// cache is dropped on the next activate, so this is the thing that makes
// an update actually reach returning visitors.
const CACHE_VERSION = "groundwar-shell-v28";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./favicon.svg",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
  "./privacy.html",
  "./terms.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Network-first: a visitor who's online always gets the current shell (this
// app ships updates often, and a stale-while-revalidate or cache-first
// strategy would leave people stuck on an old version). Only when the
// network fetch itself fails does the cached copy — or, for a navigation
// with nothing cached yet, the cached index page — stand in.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // Data tiles are requested as data/...json?v=<build hash>. Caching them
  // under the bare path keeps one copy per tile instead of a new one for
  // every weekly rebuild, which would otherwise pile up forever. Offline,
  // whatever version was last fetched is served — fine for history.
  const url = new URL(req.url);
  const isData = url.pathname.includes("/data/");
  const key = isData ? url.origin + url.pathname : req;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(key, copy));
        }
        return res;
      })
      .catch(() =>
        caches
          .match(key)
          .then((cached) => cached || (isData ? Response.error() : caches.match("./index.html")))
      )
  );
});
