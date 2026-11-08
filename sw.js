// Groundwar service worker — caches the app shell only (this file list),
// never the data: Wikidata/Wikipedia/Nominatim calls, map tiles and CDN
// scripts always go straight to the network. That keeps the app itself
// installable and openable offline, while results still need a connection.
// This is also what makes the app eligible for real app-store packaging —
// Android's Trusted Web Activity wrapper (via Bubblewrap/PWABuilder) and
// Lighthouse's installability check both require an active service worker.
//
// Bump CACHE_VERSION whenever a shell file changes materially — the old
// cache is dropped on the next activate, so this is the thing that makes
// an update actually reach returning visitors.
const CACHE_VERSION = "groundwar-shell-v6";
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

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("./index.html")))
  );
});
