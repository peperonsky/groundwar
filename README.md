# Groundwar

A map that pins battles, sieges, skirmishes, military operations,
treaties, revolutions, disasters and other historical events, plus notable
people who were born, died, or both, within reach of any place you search —
anywhere in the world.
Battles, events, disasters and people come from static files pre-built from Wikidata
(see **Pre-built map data** below); article summaries are pulled live
from Wikipedia. There's no database or backend of its own.

## Files

- `index.html`, `style.css`, `app.js` — the whole app. No build step.
- `favicon.svg` — the logo, used as the browser tab icon and in the header.
- `social-card.png` — the 1200×630 image shown when a link to the site is
  shared (Reddit, X, Discord, Slack…): a world map drawn from the site's own
  battle and event data, with the logo and tagline.
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
- `scripts/build-place-pages.mjs` — builds `places/` (static "history near
  <town>" pages for search engines), `sitemap.xml`, `_redirects` and the
  homepage's "Famous battlefields" links; see **Place pages**.
- `.github/workflows/build-tiles.yml` — re-runs all four builds weekly and
  commits the result only if something changed.
- `wrangler.jsonc`, `.assetsignore`, `_headers` — config for the
  Cloudflare Worker that serves groundwar.app; see **Deploying it** below.
- `worker.js` — the Worker's only code: `POST /api/feedback`, which emails
  the "Send feedback" form to the site owner. Everything else is the
  static files. See **Feedback form** below.
- `ads.txt` — lists the AdSense publisher account authorized to sell ads on
  this site; see **Ads** below.
- `serve.js` — a zero-dependency Node static file server, for local use only.
- `CNAME` — the custom domain set on the (secondary) GitHub Pages
  deployment; see **Deploying it** below.

## Running it locally

Needs only Node.js (no npm install, no dependencies):

```bash
node serve.js
```

Then open `http://localhost:8746`.

## Deploying it

This is a plain static site — any static host works. In practice it's a
**Cloudflare Worker** that serves it, deployed from the `main` branch on
every push.

- **[groundwar.app](https://groundwar.app)** and
  **[groundwar.guylautin1.workers.dev](https://groundwar.guylautin1.workers.dev)**
  — both served by the Cloudflare Worker `groundwar` (groundwar.app is
  attached to it as a custom domain). It serves the repo as static
  assets, built by Cloudflare Workers Builds on each push to `main`:
  Workers & Pages → groundwar → Deployments shows each build and its log.
  "Builds for Preview branches" is turned off, so PRs get no Cloudflare
  check or preview link. Don't use the **Disable builds** toggle in those
  settings: it would stop groundwar.app updating. The Worker's config is
  committed:
  - `wrangler.jsonc` — the Worker's name and settings. Without it, each
    build ran wrangler's interactive auto-setup and picked a new
    compatibility date every time.
  - `worker.js` — runs only for requests that aren't a file, which in
    practice is just the feedback form's `/api/feedback`.
  - `.assetsignore` — keeps repo-only files (README, build scripts,
    workflows, the config and `worker.js` itself) off the site.
  - `_headers` — browser caching: the versioned data files
    (`data/...json?v=<hash>`) are cached for a year, their manifests for
    five minutes, everything else is re-checked on each visit.
- **GitHub Pages** — still enabled (Settings → Pages → source: `main`
  branch) and still deploys on every push, with `groundwar.app` set as its
  custom domain via the `CNAME` file. But groundwar.app's DNS points at the
  Worker, so visitors never reach this copy, and it ignores the Worker
  files above (so its feedback form can't send). It can be switched off, or kept as a fallback host
  to point the domain back at if the Worker ever has to go.

An earlier version of this file said GitHub Pages served groundwar.app
with Cloudflare only as DNS/CDN in front. That's no longer the case: a
request to groundwar.app gets the Worker's response (e.g. `README.md`
returns 404 there because of `.assetsignore`, and responses carry the
`_headers` cache rules).

Netlify or Vercel are free options if you ever want yet another host
([netlify.com/drop](https://app.netlify.com/drop), or `vercel deploy` via
their CLI).

### Why HTTPS matters here

Browsers refuse the Geolocation API ("Use my current location") on plain
HTTP unless it's `localhost`. All of the options above serve over HTTPS by
default, so this isn't something you need to configure — just don't host it
on bare HTTP and expect that button to work.

## Feedback form

"Send feedback" (in the sidebar's footer, the About box, and "Tell us" at
the bottom of every result) opens a short form: what it's about, the
message, and an optional email for a reply. `worker.js` emails it to the
site owner, with the page the visitor was on and the entry they sent it
from, so a report makes sense on its own. It goes through Cloudflare Email
Routing, which is free when sending to your own verified address, so the
owner's address is never in the page or this repo. A hidden field catches
bots, and one address can send at most 3 messages a minute.

One-time setup in the Cloudflare dashboard (until it's done, the form
says it couldn't send; nothing else is affected):

1. **Turn on Email Routing for groundwar.app:** select the groundwar.app
   domain → **Email** → **Email Routing** → enable it, and let it add the
   DNS records it asks for (MX and TXT). The site doesn't use email on
   this domain otherwise, so nothing conflicts.
2. **Add your inbox as a destination address** (Email Routing →
   **Destination addresses**) and click the verification link Cloudflare
   emails you. Only verified addresses can receive.
3. **Tell the Worker where to send:** Workers & Pages → **groundwar** →
   **Settings** → **Variables and Secrets** → **Add** → type **Secret**,
   name `FEEDBACK_TO`, value your verified address. (A secret, so it stays
   out of the repo and survives every deploy.)

Messages arrive from `feedback@groundwar.app` (the `FEEDBACK_FROM` var in
`wrangler.jsonc`), with Reply-To set to the visitor's address when they
gave one, so replying just works. If sending fails, the Worker logs why
(Workers & Pages → groundwar → **Logs**).

## Ads

Google AdSense is live: one responsive display unit ("Groundwar sidebar",
slot `2557915888`, publisher `ca-pub-6885508532559879`) in the sidebar,
below the results list. `app.js` loads Google's script only after the
first search has finished (or after 8 seconds at most), when the browser is
idle, so ads never slow down the first results. The section stays out of
sight until Google reports an ad in it (`data-ad-status="filled"`), so an
ad blocker or an unfilled slot leaves no empty box; if the script can't
load at all, the section is hidden. Setting the unit's `data-ad-client` in
`index.html` back to `ca-pub-0000000000000000` switches ads off entirely:
the section stays hidden and nothing is requested from Google.

The publisher account's verification meta tag (`google-adsense-account`) is
in `index.html`'s `<head>` and its `ads.txt` is at the site root. Don't
paste the code snippet AdSense offers: it loads the ad script in `<head>`
on every visit, which the loading described above deliberately avoids.

Settings in the AdSense dashboard (no code involved):
- **Auto ads off** for groundwar.app (Ads → By site): Auto ads would add
  anchor and full-screen ads, which on phones cover the map and the
  results sheet.
- **Privacy & messaging → European regulations** published: Google's
  certified consent message, required to serve ads to visitors in the EU,
  UK and Switzerland. Delivered by the ad script itself. The **US state
  regulations** message is optional.

The privacy policy's "Advertising" section carries the disclosures AdSense
requires (cookies used by Google and other vendors, how to opt out).

**No ad showing?** Open `https://groundwar.app/?ads=debug`, search for a
place, and scroll to the bottom of the results: the ad section then stays
in view with a line saying what happened. "Couldn't load" means an ad
blocker (Brave, Opera and some phone browsers block ads by default); "no
ad" means Google answered but had nothing to show, which is every answer
while the site's status under **Sites** in AdSense is still "Getting
ready" or "Requires review", and some answers after that. The unit has
the sidebar's full width (319px on desktop) so 300×250 ads fit.

Google doesn't allow AdSense inside an iOS app's web view, so an App Store
build would need Google's mobile ads SDK instead; the Android Trusted Web
Activity runs in Chrome and is fine.

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
top of `style.css` (`--battle`, `--event`, `--disaster`, `--figure`, `--accent`, etc.),
defined once for light mode and again for dark — change a value there
rather than hunting through the rest of the file.

What the map looks for is four lists of Wikidata classes near the top of
`app.js`, as entity IDs, each with a comment naming them:
- `BATTLE_TYPES` and `OPERATION_TYPES`, the red "Conflicts" layer:
  battles, sieges, skirmishes, ambushes, sacks; offensives, raids,
  landings, airstrikes, bombardments, invasions.
- `EVENT_TYPES`, the amber "Treaties, revolutions & more" layer: treaties,
  coups, revolutions, massacres, assassinations, rebellions, riots,
  terrorist attacks and bombings, war crimes, pogroms, nuclear tests,
  protests, summits, world's fairs and more.
- `DISASTER_TYPES`, the teal "Disasters" layer: air, rail and sea
  disasters and shipwrecks, earthquakes, eruptions, floods, wildfires and
  other natural disasters, great fires, explosions, mining and industrial
  accidents, collapses, stampedes. An item that's also a battle or an
  event shows as that only. Disasters are searched separately, with their
  own nearest-300 limit, so a city full of them never crowds out its
  battles.

Each comment also says what was left out on purpose and why (classes
whose items are whole regions, like "military campaign" or "conquest";
recent crime, like mass shootings). A wreck's date is its sinking, from
its dated "significant event" (`LOSS_EVENT_TYPES`), since wrecks rarely
have a plain point in time. Add or remove IDs to change what counts,
then rebuild the tiles (below).
Until you do, a search that needs a type the tiles don't have quietly
falls back to the live query, so nothing breaks in the meantime.

The map's animations are in the "Motion" section of `app.js` and "Map
motion" in `style.css`:
- when a search's results land, a sonar ring spreads from the search
  point, each marker pops in as the ring reaches it, nearest first, and
  the list fades in;
- a radar sweep turns inside the search circle while results are still
  loading, but only if that takes more than a moment;
- the open result's marker lifts and pulses.

They're CSS animations of transform and opacity only, with no script
running per frame, and switch off for anyone whose device asks for
reduced motion (the selected marker then gets a still ring instead). The
ring's timing (`SWEEP_MS`) and the pop's (`POP_MS`) are in both files;
change them together. The cost on a busy search was measured before
shipping: about 10 ms slower taps while results land, with the CPU
slowed 4x.

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
geocoding API: about 218,000 towns, cities, regions, countries and lakes
from Wikidata (settlements with 10+ Wikipedia language editions, regions
and countries with 40+, lakes with 30+), ranked by that same notability
measure, ~12 MB split
into ~2,200 files by the first two or three letters typed. Busy prefixes
like "sai" (all the French Saint-… communes) are the largest at ~150 KB,
~45 KB gzipped. Well-known places also carry their English historical
names, so "Stalingrad" finds Volgograd and "Constantinople" Istanbul.

Big places get a bigger search: a lake 200 km long or a whole country
doesn't fit the 25 km circle a town does (from its centre, Lake Champlain
at 25 km finds 2 battles; at 100 km, all 19 along its shores). Each entry
in the list carries a radius worked out from Wikidata's area and length
(the bigger of the equal-area circle and half the length, snapped to the
nearest radius option), and Nominatim results are sized from their
bounding box. Choosing a big place widens the radius to fit; it never
narrows one the visitor picked.

This matters because [Nominatim's usage
policy](https://operations.osmfoundation.org/policies/nominatim/)
forbids client-side autocomplete against its API, and allows at most one
request per second. Nominatim is now only asked when someone presses
Enter on text that matches nothing in the list (a street address, say),
and for "Search this area". Requests from one page are spaced at least a
second apart, and reverse lookups are cached per ~1 km square.

### Place pages

The app is a single page whose results only exist after JavaScript runs a
search, so on its own a search engine can only rank it for its name.
`places/` holds static, indexable pages, one per town, that answer what
people actually search for ("battles near Gettysburg", "history of
Verdun"), e.g. `/places/gettysburg-pennsylvania`. Each has a real title, a
summary written from the data, the battles and events within 25 km with
dates and distances, notable people born or died nearby, links to nearby
place pages, and a button opening that view on the map. `/places/` lists
them all by country, and `sitemap.xml` lists every page. If a town's page
address ever changes (say Wikidata renames its country), the build adds a
permanent redirect from the old address to `_redirects`, which the
Cloudflare Worker applies, so links and search results never break.

The homepage links to a dozen of these pages from a short "About Groundwar"
section at the foot of the sidebar, so search engines find the place pages
from the front page and the homepage has some real text to rank on. The
build rewrites that list (between the `popular-places` markers in
`index.html`) from a hand-picked list of famous battlefield towns, keeping
only those that got a page, so a link never points at a missing page.

Which towns get a page (all thresholds are constants at the top of
`scripts/build-place-pages.mjs`):
- towns and cities with 40+ Wikipedia language editions (any kind of
  settlement or municipality on Wikidata);
- with 8+ battles/events within 25 km, or 3+ if one within 15 km is named
  after the town ("Battle of Hastings", "Siege of Bastogne");
- with at least 6 entries in all, counting notable people, so no page is
  near-empty;
- at least 12 km from a better-known town that already has a page, so a
  city and its suburbs don't get near-duplicate pages;
- towns with a battle named after them first, then the best-known of the
  rest, up to 1,200 pages.

Search engines penalise sites for masses of thin, templated pages, so watch
Search Console's indexing report after these go live. If many land in
"Crawled - currently not indexed", raise the thresholds rather than adding
more. `EXPLAIN="Hastings,Waterloo" node scripts/build-place-pages.mjs` shows
why a given town did or didn't get a page.

### Rebuilding

All four builds need only Node 18+ (no dependencies) and take a couple
of minutes each:

```bash
node scripts/build-tiles.mjs          # battles, operations, events, disasters
node scripts/build-figure-tiles.mjs   # people
node scripts/build-places.mjs         # place-search list
node scripts/build-place-pages.mjs    # place pages + sitemap (run last)
```

The **Build map data** GitHub Action runs all four every Monday and commits
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
