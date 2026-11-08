# Groundwar

A map that pins battles, sieges, military operations, treaties, revolutions
and other historical events, plus notable people who were born, died, or
both, within reach of any place you search — anywhere in the world.
Battles, events and people come from static files pre-built from Wikidata
(see **Pre-built map data** below); article summaries are pulled live
from Wikipedia. There's no database or backend of its own.

## Files

- `index.html`, `style.css`, `app.js` — the whole app. No build step.
- `favicon.svg` — the logo, used as the browser tab icon and in the header.
- `icon-192.png`, `icon-512.png` — the same logo as PNG, for installability
  checks and app-store packaging tools that don't accept SVG.
- `icon-512-maskable.png` — a full-bleed version (background fills the whole
  square, logo kept within the safe zone) so Android's adaptive-icon mask
  doesn't crop it oddly.
- `apple-touch-icon.png` — the iOS home-screen icon (Safari doesn't reliably
  render SVG here, so this needs to be a real PNG).
- `manifest.json` — lets phones/desktops "install" it as an app, and is what
  app-store packaging tools read to build a store listing from.
- `sw.js` — a service worker that caches the app shell, so an installed copy
  still opens (showing your last search) without a connection, and so the
  app passes the "installable" checks app-store packaging tools require.
  Battle, event and people tiles get cached as they're used, so places
  already searched still show their results offline; map tiles and
  everything else still come live from the network.
- `privacy.html` — the privacy policy, including what the ad network (once
  turned on) does and doesn't collect.
- `terms.html` — terms & conditions: what Groundwar is, and that the
  historical data is third-party with no warranty on accuracy.
- `robots.txt`, `sitemap.xml` — tell search engines they can crawl the
  whole site and point them at its three real pages.
- `data/incidents/`, `data/figures/`, `data/places/` — the pre-built
  battles/events tiles, people tiles and place-search list, each with a
  `manifest.json`. Generated; don't edit by hand.
- `scripts/build-tiles.mjs` — builds `data/incidents/` from QLever's copy
  of Wikidata.
- `scripts/build-figure-tiles.mjs` — builds `data/figures/` from QLever's
  copy of Wikidata.
- `scripts/build-places.mjs` — builds `data/places/`.
- `.github/workflows/build-tiles.yml` — re-runs all three builds weekly and
  commits the result only if something changed.
- `serve.js` — a zero-dependency Node static file server, for local use only.
- `CNAME` — tells GitHub Pages which custom domain to serve this repo at
  (`groundwar.app`). This is the actual deploy mechanism; see **Deploying
  it** below.

## Running it locally

Needs only Node.js (no npm install, no dependencies):

```bash
node serve.js
```

Then open `http://localhost:8746`.

## Deploying it

This is a plain static site — any static host works. In practice there's
one real deployment: **GitHub Pages**, building from the `main` branch on
every push (Settings → Pages → source: `main` branch).

- **[groundwar.app](https://groundwar.app)** — GitHub Pages serves this
  directly, using the `CNAME` file above plus the custom domain set in
  Settings → Pages. Cloudflare sits in front of it purely as DNS and a
  CDN/proxy layer (the orange-cloud proxy on groundwar.app's DNS
  records) — there's no separate Cloudflare Pages project involved, just
  DNS pointed at GitHub Pages' own IPs. An earlier version of this file
  claimed a real Cloudflare Pages integration; that was never actually set
  up, so don't go looking for a Pages project in the Cloudflare dashboard.
- **`https://<you>.github.io/<repo>`** — the same GitHub Pages build,
  also reachable at its default URL.

Netlify, Vercel, or an actual Cloudflare Pages project are all free options
if you ever want a genuinely separate second host
([netlify.com/drop](https://app.netlify.com/drop), or `vercel deploy` via
their CLI).

### Why HTTPS matters here

Browsers refuse the Geolocation API ("Use my current location") on plain
HTTP unless it's `localhost`. All of the options above serve over HTTPS by
default, so this isn't something you need to configure — just don't host it
on bare HTTP and expect that button to work.

## Turning on ads

The ad infrastructure (Google AdSense) is wired up but inert: the loader
script in `index.html`'s `<head>`, and the `<ins class="adsbygoogle">` unit
in the sidebar below the results list, both use the placeholder client ID
`ca-pub-0000000000000000`, which won't serve real ads. To activate:

1. Sign up at [adsense.google.com](https://adsense.google.com) and add this
   site (it needs to actually be live at a real domain first, not just
   running locally).
2. Once Google approves the site, replace `ca-pub-0000000000000000` in
   **both** places above with your real client ID, and `data-ad-slot`'s
   `0000000000` with the ad unit ID AdSense gives you.
3. `privacy.html`'s "Advertising" section is already written to be accurate
   once this is live — no further edit needed there, since it already
   describes what AdSense does rather than claiming it isn't happening yet.

The placement (below the results list, not between the search controls and
the results) is deliberate: visible once someone's done browsing, never
interrupting the actual search/dig workflow.

## Putting it in the app stores

Groundwar is a PWA (installable web app) first — everything above makes it
pass the standard "installability" checks (manifest, icons at the right
sizes, a service worker, HTTPS). Getting from there into the Play Store or
App Store needs a packaging step and a developer account, both of which are
yours to do — I can't create accounts, sign anything, or submit on your
behalf. The short version:

### Google Play (easier — Android has first-class support for this)

Android can install a PWA almost as-is, wrapped in a thin native shell
called a **Trusted Web Activity (TWA)**. [PWABuilder](https://www.pwabuilder.com)
is the no-install, point-and-click way to do this:

1. Deploy the site somewhere with HTTPS (see **Deploying it** above).
2. Go to pwabuilder.com, enter your deployed URL, let it score the app —
   it'll flag anything still missing.
3. Click "Package for stores" → Android → it generates a signed `.aab` file
   for you (or walks you through signing your own).
4. Upload that `.aab` to the [Google Play Console](https://play.google.com/console)
   (one-time $25 developer registration), fill in the store listing —
   it'll ask for the privacy policy URL, which is `<your-domain>/privacy.html`
   — and submit for review.

(The command-line equivalent, if you want more control, is
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) — same idea,
same output.)

### Apple App Store (harder — iOS has no TWA equivalent)

Apple doesn't have a built-in "wrap this PWA" path the way Android does.
PWABuilder can still generate an iOS package (an Xcode project wrapping the
site in a `WKWebView`), but finishing it requires a Mac with Xcode and an
Apple Developer account ($99/year):

1. From the same PWABuilder run above, choose "Package for stores" → iOS.
2. It downloads an Xcode project. Open it on a Mac, set your signing team,
   build and archive.
3. Submit through [App Store Connect](https://appstoreconnect.apple.com) —
   it'll also ask for the privacy policy URL and, since the app uses
   location and reaches external domains, you'll fill in Apple's "privacy
   nutrition label" questionnaire (answer: no data collected — see
   `privacy.html`, which explains exactly what the app does and doesn't do).

If you don't have a Mac, services like
[Codemagic](https://codemagic.io) or [Ionic Appflow](https://ionic.io/appflow)
can build and sign the iOS package from the Xcode project in the cloud.

### Before submitting either one

Both stores' listing forms will ask for a few things this repo doesn't
generate automatically — screenshots of the app in use, a short/long
description, and a content rating questionnaire. Those are store-listing
content, not code, so they're easiest to fill in once you're looking at the
actual console.

## Customizing

Colors, fonts and the map-pin palette are all CSS custom properties at the
top of `style.css` (`--battle`, `--event`, `--figure`, `--accent`, etc.),
defined once for light mode and again for dark — change a value there
rather than hunting through the rest of the file.

The categories of historical "events" it looks for (treaties, coups,
revolutions, massacres, assassinations, rebellions, riots) are the
`EVENT_TYPES` list near the top of `app.js`, as Wikidata entity IDs — add
or remove IDs there to change what counts. Then rebuild the tiles (below).
Until you do, a search that needs a type the tiles don't have quietly
falls back to the live query, so nothing breaks in the meantime.

## Pre-built map data

### Battles, operations and events

Instead of running a live Wikidata query for every search, battles,
operations and events are pre-built into `data/incidents/`: one small
JSON file per 5°×5° square of the map (about 580 files, roughly 1.2 MB in
all; the densest, northern France/Belgium, is ~40 KB, ~11 KB gzipped).
A search loads only the one to few squares its radius touches, then
filters by exact distance in the browser. It matches the live query
(same types, radius, nearest-300 cap), but loads in a fraction of the
time, costs nothing per visitor, and puts no load on Wikidata however
much traffic the site gets.

If the tiles can't be used for any reason (missing manifest, a failed
download, a type they weren't built with), that search falls back to the
live Wikidata query automatically.

### People

People born or died near a place are pre-built the same way into
`data/figures/`, about 338,000 people, ~43 MB in all, split into three
fame tiers that line up with the app's fame options:

| Tier | Sitelinks | Cell size | Files | Largest file |
|---|---|---|---|---|
| `t60` | over 60 ("Famous only") | 5° | ~400 | ~70 KB |
| `t25` | 26–60 | 2° | ~2,000 | ~225 KB |
| `t8` | 9–25 | 1° | ~7,000 | ~975 KB (Paris) |

Like the live query, a search shows the 120 most famous people born
nearby and the 120 most famous who died nearby. Each file is sorted by a
coarse fame score, and every person in a higher tier outranks everyone in
a lower one, so a search loads the lower tiers only if the higher ones
didn't already fill those lists. A big-city search at "Everyone
recorded" usually never downloads the large long-tail files at all.

### Where the data comes from

Both builds query [QLever](https://qlever.dev)'s copy of Wikidata rather
than query.wikidata.org, for two reasons. Listing every person above a
sitelink threshold means scanning all ~12 million humans, which
Wikidata's own endpoint can't do within its 60-second query limit, while
QLever does each query in a few seconds. And Wikidata's endpoint has
outages where it rate-limits clients to one request per minute; QLever
keeps the weekly rebuild working through those. QLever's copy can lag
Wikidata by a week or two, which doesn't matter for history.

### Place search

The search box's suggestions come from `data/places/`, not from a
geocoding API: about 218,000 towns, cities, regions and countries from
Wikidata (settlements with 10+ Wikipedia language editions, regions and
countries with 40+), ranked by that same notability measure, ~12 MB split
into ~2,200 files by the first two or three letters typed. Busy prefixes
like "sai" (all the French Saint-… communes) are the largest at ~150 KB,
~45 KB gzipped. Well-known places also carry their English historical
names, so "Stalingrad" finds Volgograd and "Constantinople" Istanbul.

This matters because [Nominatim's usage
policy](https://operations.osmfoundation.org/policies/nominatim/)
forbids client-side autocomplete against its API, and allows at most one
request per second. Nominatim is now only asked when someone presses
Enter on text that matches nothing in the list (a street address, say),
and for "Search this area". Requests from one page are spaced at least a
second apart, and reverse lookups are cached per ~1 km square.

### Rebuilding

All three builds need only Node 18+ (no dependencies) and take a couple
of minutes each:

```bash
node scripts/build-tiles.mjs          # battles, operations, events
node scripts/build-figure-tiles.mjs   # people
node scripts/build-places.mjs         # place-search list
```

The **Build map data** GitHub Action runs all three every Monday and commits
only if something actually changed. You can also run it by hand from
the Actions tab. It needs Settings → Actions → General → Workflow
permissions set to "Read and write" so it can push.

If the tiles can't be used for a search (missing manifest, failed
download, a type or fame level they weren't built for), that layer falls
back to the live Wikidata query automatically.

## Data sources

- [Wikidata](https://www.wikidata.org) — battles, events, people, dates, coordinates
- [QLever](https://qlever.dev) — the fast Wikidata query service the people tiles are built with
- [Wikipedia](https://www.wikipedia.org) — article summaries and images shown in the detail panel
- [OpenStreetMap](https://www.openstreetmap.org) — map tiles
- [Nominatim](https://nominatim.org) — address search (when the built-in place list has no match) and reverse geocoding

Wikipedia, OpenStreetMap and Nominatim are called directly from the
visitor's own browser. Wikidata is only queried live as a fallback when
the pre-built tiles can't be used. Being good citizens of them matters more as this gets more
traffic — see each project's usage policy before pointing serious volume
at them.
