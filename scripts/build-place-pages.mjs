#!/usr/bin/env node
// Builds static, indexable "history near <place>" pages, so search engines
// have real pages to send people to for searches like "battles near
// Gettysburg" or "history of Verdun". The app itself is one page whose
// results only exist after JavaScript runs, so on its own it can only rank
// for its name. Run from the repo root, after the data builds:
//
//   node scripts/build-place-pages.mjs
//
// No dependencies (Node 18+). Writes:
//   places/<slug>.html   one page per place (served as /places/<slug>)
//   places/index.html    an A–Z index of every place page, by country
//   places/manifest.json content hash + last-changed date per page, so a
//                        rebuild only moves a page's <lastmod> when it changed
//   sitemap.xml          the site's pages plus every place page
//
// Which places: towns and cities with MIN_SITELINKS+ Wikipedia language
// editions, from QLever's Wikidata copy, with their country and first-level
// division (state/province). "Town" means any subclass of human settlement
// OR of municipality: many European towns are recorded only as an
// administrative unit (Verdun is a "commune of France", Waterloo a
// "municipality of Belgium") and would otherwise be missed. Each needs
// MIN_ENTRIES+ entries on its page in all, and MIN_INCIDENTS+
// battles/events within RADIUS_KM in data/incidents, or
// MIN_INCIDENTS_AT_BATTLEFIELD+ if one of them, within BATTLEFIELD_KM, is
// named after the town ("Battle of Hastings", "Siege of Bastogne", "Battle of
// Gettysburg"): the towns people search for because of a famous battle. It must
// be MIN_SEPARATION_KM from any better-known place already chosen, so a
// city and its own districts or suburbs don't get near-identical pages
// (Paris wins over La Défense, Arras over the villages around it). The
// MAX_PAGES best-known survivors become pages: people search for places
// they've heard of, so fame (Wikipedia language editions) decides, not just
// how dense the fighting was around some small village. Thin pages are what
// search engines penalise, so the bar is deliberately high: raise MAX_PAGES
// once Search Console shows these being indexed and ranking.
//
// All page content comes from data the site already has (data/incidents,
// data/figures), so the pages always agree with the interactive map.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const SITE = "https://groundwar.app";
const OUT_DIR = "places";
const ENDPOINT = "https://qlever.dev/api/wikidata";
const USER_AGENT = "GroundwarTileBuilder/1.0 (https://groundwar.app; https://github.com/peperonsky/groundwar)";
const MIN_SITELINKS = 40;
const RADIUS_KM = 25;
const MIN_INCIDENTS = 8;
const MIN_INCIDENTS_AT_BATTLEFIELD = 3;
// Every page must list at least this many entries in total (battles, events
// and notable people), so none is a near-empty page.
const MIN_ENTRIES = 6;
const BATTLEFIELD_KM = 15;
const MIN_SEPARATION_KM = 12;
const MAX_PAGES = 1200;
const MAX_PEOPLE = 24;
const NEARBY_PAGES = 6;
const NEARBY_MAX_KM = 200;
// Countries where people name a town by its state/province ("Toledo,
// Ohio"); elsewhere the country is clearer ("Verdun, France").
// For the UK, the first-level division is England/Scotland/Wales/Northern
// Ireland: "Hastings, England".
const SHOW_ADMIN1 = new Set(["United States", "Canada", "Australia", "India", "Brazil", "Mexico", "United Kingdom"]);

// --- data loading -----------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCsv(text) {
  const rows = [];
  let row = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let field;
    if (text[i] === '"') {
      let j = i + 1;
      let parts = "";
      for (;;) {
        const q = text.indexOf('"', j);
        if (q === -1) throw new Error("Unterminated quoted CSV field");
        if (text[q + 1] === '"') {
          parts += text.slice(j, q + 1);
          j = q + 2;
        } else {
          field = parts + text.slice(j, q);
          i = q + 1;
          break;
        }
      }
    } else {
      let j = i;
      while (j < n && text[j] !== "," && text[j] !== "\n" && text[j] !== "\r") j++;
      field = text.slice(i, j);
      i = j;
    }
    row.push(field);
    if (text[i] === ",") {
      i++;
      if (i === n) row.push("");
    } else {
      if (text[i] === "\r") i++;
      if (text[i] === "\n") i++;
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, k) => [h, r[k] ?? ""])));
}

const PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
`;

async function query(name, body) {
  for (let attempt = 1; ; attempt++) {
    let problem;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT, Accept: "text/csv", "Content-Type": "application/x-www-form-urlencoded" },
        body: "query=" + encodeURIComponent(PREFIXES + body),
      });
      const text = await res.text();
      if (res.ok && !text.startsWith("{")) {
        const rows = parseCsv(text);
        console.log(`${name}: ${rows.length} rows`);
        return rows;
      }
      if (res.ok || res.status === 429 || res.status >= 500) problem = res.ok ? text.slice(0, 120) : String(res.status);
      else throw new Error(`${name} failed (${res.status}): ${text.slice(0, 300)}`);
    } catch (err) {
      if (err.message.includes("failed (")) throw err;
      problem = err.message;
    }
    if (attempt >= 6) throw new Error(`${name} kept failing: ${problem}`);
    console.warn(`  ${name}: ${problem}, retrying in ${15 * attempt}s`);
    await sleep(15000 * attempt);
  }
}

// human settlement (Q486972) or municipality (Q15284), and their subclasses
const SETTLEMENTS = `{ ?p wdt:P31/wdt:P279* wd:Q486972 } UNION { ?p wdt:P31/wdt:P279* wd:Q15284 }
    ?p wikibase:sitelinks ?s . FILTER(?s >= ${MIN_SITELINKS})`;
const placeRows = await query(
  "places",
  `SELECT ?p ?s ?label ?coord ?country WHERE {
    ${SETTLEMENTS}
    ?p wdt:P625 ?coord ; rdfs:label ?label . FILTER(LANG(?label) = "en")
    # Current countries only. Wikidata also lists historical states (Babylon's
    # include the Achaemenid Empire, Nicaea's "Roman Asia Minor"), so require
    # a country or sovereign state with no dissolution date (P576).
    OPTIONAL {
      ?p wdt:P17 ?c .
      VALUES ?countryClass { wd:Q6256 wd:Q3624078 }
      ?c wdt:P31 ?countryClass .
      FILTER NOT EXISTS { ?c wdt:P576 ?dissolved }
      ?c rdfs:label ?country . FILTER(LANG(?country) = "en")
    }
  }`
);
await sleep(8000);
const adminRows = await query(
  "first-level divisions",
  `SELECT ?p ?admin1 WHERE {
    ${SETTLEMENTS}
    ?p wdt:P131+ ?a . ?a wdt:P31/wdt:P279* wd:Q10864048 .
    FILTER NOT EXISTS { ?a wdt:P576 ?dissolved }
    ?a rdfs:label ?admin1 . FILTER(LANG(?admin1) = "en")
  }`
);

// qid -> {name, s, lat, lon, country, admin1}. Where Wikidata lists several
// coordinates/countries/divisions, keep the alphabetically first so rebuilds
// are stable.
const qid = (uri) => uri.slice(uri.lastIndexOf("/") + 1);
const places = new Map();
for (const r of placeRows) {
  if (r.coord.startsWith("<")) continue;
  const m = /Point\(([-\d.eE]+)\s+([-\d.eE]+)\)/i.exec(r.coord);
  if (!m) continue;
  const id = qid(r.p);
  const lat = Math.round(parseFloat(m[2]) * 1e4) / 1e4;
  const lon = Math.round(parseFloat(m[1]) * 1e4) / 1e4;
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) continue;
  const prev = places.get(id);
  if (!prev) places.set(id, { id, name: r.label, s: +r.s, lat, lon, country: r.country || "", admin1: "" });
  else {
    if (r.country && (!prev.country || r.country < prev.country)) prev.country = r.country;
    if (`${lat},${lon}` < `${prev.lat},${prev.lon}`) Object.assign(prev, { lat, lon });
  }
}
for (const r of adminRows) {
  const pl = places.get(qid(r.p));
  if (pl && r.admin1 !== pl.name && (!pl.admin1 || r.admin1 < pl.admin1)) pl.admin1 = r.admin1;
}

// The battle/event type lists, read from app.js like build-tiles.mjs does.
const appJs = readFileSync("app.js", "utf8");
const typeList = (name) => [...new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(appJs)[1].matchAll(/"(Q\d+)"/g)].map((x) => x[1]);
const BATTLE = new Set([...typeList("BATTLE_TYPES"), ...typeList("OPERATION_TYPES")]);
const BATTLE_OR_EVENT = new Set([...BATTLE, ...typeList("EVENT_TYPES"), ...typeList("OLD_CRIME_TYPES")]);

// All incidents, deduped by item (an item with several coordinates keeps
// each; the nearest one wins per place below). The tiles hold disasters
// too; these pages are about battles and events, so an item that's only a
// disaster is skipped, which keeps the set of pages what it was. So is one
// pinned at its named place rather than at coordinates of its own (an 8th
// field, see build-tiles.mjs): a page says how far each entry is from the
// town, and for those the distance would only be a guess.
const incidents = [];
for (const f of readdirSync("data/incidents")) {
  if (f === "manifest.json") continue;
  for (const [id, label, lat, lon, date, title, types, place] of JSON.parse(readFileSync(join("data/incidents", f), "utf8"))) {
    if (place || !types.some((t) => BATTLE_OR_EVENT.has(t))) continue;
    incidents.push({ id, label, lat, lon, date, title, battle: types.some((t) => BATTLE.has(t)) });
  }
}
// People from the two higher fame tiers (the app's default "Notable" level).
const people = [];
for (const tier of ["t60", "t25"]) {
  for (const f of readdirSync(join("data/figures", tier))) {
    const { places: pl, people: rows } = JSON.parse(readFileSync(join("data/figures", tier, f), "utf8"));
    for (const [id, label, births, deaths, dob, dod, title, fame] of rows) {
      people.push({
        id,
        label,
        dob,
        dod,
        title,
        fame: (tier === "t60" ? 1000 : 0) + fame,
        births: births.map((i) => ({ name: pl[i][0], lat: pl[i][1], lon: pl[i][2] })),
        deaths: deaths.map((i) => ({ name: pl[i][0], lat: pl[i][1], lon: pl[i][2] })),
      });
    }
  }
}

// 1° grid buckets for fast "within R km" lookups.
function bucketize(items, coordsOf) {
  const grid = new Map();
  for (const it of items) {
    for (const [lat, lon] of coordsOf(it)) {
      const k = `${Math.floor(lat)}_${Math.floor(lon)}`;
      if (!grid.has(k)) grid.set(k, new Set());
      grid.get(k).add(it);
    }
  }
  return grid;
}
function around(grid, lat, lon) {
  const out = new Set();
  for (let a = Math.floor(lat) - 1; a <= Math.floor(lat) + 1; a++)
    for (let b = Math.floor(lon) - 2; b <= Math.floor(lon) + 2; b++) for (const it of grid.get(`${a}_${b}`) || []) out.add(it);
  return out;
}
const incGrid = bucketize(incidents, (it) => [[it.lat, it.lon]]);
const peopleGrid = bucketize(people, (p) => [...p.births, ...p.deaths].map((x) => [x.lat, x.lon]));

const R = 6371;
const rad = Math.PI / 180;
function km(lat1, lon1, lat2, lon2) {
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function compass(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  const deg = (Math.atan2(y, x) / rad + 360) % 360;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

function incidentsNear(pl) {
  const best = new Map();
  for (const it of around(incGrid, pl.lat, pl.lon)) {
    const d = km(pl.lat, pl.lon, it.lat, it.lon);
    if (d > RADIUS_KM) continue;
    const prev = best.get(it.id);
    if (!prev || d < prev.d) best.set(it.id, { ...it, d });
  }
  return [...best.values()];
}

// --- choosing places ---------------------------------------------------

// Lower-case, accent-free, letters/digits only: "Saint-Lô" -> "saint lo".
const foldName = (s) =>
  String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const scored = [];
for (const pl of places.values()) {
  const inc = incidentsNear(pl);
  const town = foldName(pl.name);
  const battlefield = town.length >= 3 && inc.some((i) => i.d <= BATTLEFIELD_KM && new RegExp(`\\b${town}\\b`).test(foldName(i.label || i.title)));
  if (!(inc.length >= MIN_INCIDENTS || (battlefield && inc.length >= MIN_INCIDENTS_AT_BATTLEFIELD))) continue;
  if (inc.length + Math.min(peopleNear(pl).length, MAX_PEOPLE) < MIN_ENTRIES) continue;
  scored.push({ pl, inc, battlefield });
}
// Towns with a battle named after them come first (that's what people
// search for: "Battle of Gettysburg", "Siege of Bastogne"), then the
// best-known of the rest; within each group, better-known first.
scored.sort(
  (a, b) => b.battlefield - a.battlefield || b.pl.s - a.pl.s || b.inc.length - a.inc.length || a.pl.id.localeCompare(b.pl.id)
);
const chosen = [];
for (const c of scored) {
  if (chosen.length >= MAX_PAGES) break;
  if (chosen.some((o) => km(o.pl.lat, o.pl.lon, c.pl.lat, c.pl.lon) < MIN_SEPARATION_KM)) continue;
  chosen.push(c);
}

// EXPLAIN="Hastings,Waterloo" node scripts/build-place-pages.mjs reports why
// each named place did or didn't get a page.
if (process.env.EXPLAIN) {
  for (const want of process.env.EXPLAIN.split(",").map((x) => foldName(x))) {
    const found = [...places.values()].filter((pl) => foldName(pl.name) === want);
    if (!found.length) console.log(`EXPLAIN ${want}: not in the place query`);
    for (const pl of found) {
      const sc = scored.find((c) => c.pl === pl);
      const inc = incidentsNear(pl);
      const named = inc.filter((i) => i.d <= BATTLEFIELD_KM && new RegExp(`\\b${want}\\b`).test(foldName(i.label || i.title)));
      const blocker = chosen.find((o) => o.pl !== pl && km(o.pl.lat, o.pl.lon, pl.lat, pl.lon) < MIN_SEPARATION_KM);
      console.log(
        `EXPLAIN ${pl.name}, ${pl.admin1 || "-"}, ${pl.country} (${pl.id}, ${pl.s} langs): ${inc.length} nearby, named battle: ${named.length ? named.map((i) => i.label).join("/") : "none"}; ` +
          (chosen.some((c) => c.pl === pl) ? "PAGE" : !sc ? "does not qualify" : blocker ? `blocked by ${blocker.pl.name}` : "cut by MAX_PAGES")
      );
    }
  }
}

// Display name and URL slug. "Toledo, Ohio" / "Verdun, France"; the
// country is added to the slug only when two chosen places would collide.
const slugify = (s) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
for (const c of chosen) {
  const { name, admin1, country } = c.pl;
  const region = SHOW_ADMIN1.has(country) && admin1 ? admin1 : country;
  c.display = region ? `${name}, ${region}` : name;
  c.slug = slugify(c.display) || c.pl.id.toLowerCase();
}
const bySlug = new Map();
for (const c of chosen) bySlug.set(c.slug, (bySlug.get(c.slug) || 0) + 1);
for (const c of chosen) if (bySlug.get(c.slug) > 1) c.slug = slugify(`${c.display} ${c.pl.country} ${c.pl.id}`);

// --- rendering ---------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const nameOf = (label, title) => (label && !/^Q\d+$/.test(label) ? label : (title || "").replace(/_/g, " ")) || "Unnamed";
const wiki = (title) => (title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` : null);
function year(iso) {
  const m = /^(-?)(\d+)/.exec(iso || "");
  if (!m) return null;
  const y = parseInt(m[2], 10);
  return m[1] ? `${y} BC` : String(y);
}
const yearNum = (iso) => {
  const m = /^(-?\d+)/.exec(iso || "");
  return m ? parseInt(m[1], 10) : null;
};
const yearSort = (y) => (y.endsWith(" BC") ? -parseInt(y, 10) : parseInt(y, 10));
const fmtKm = (d) => (d < 1 ? "under 1 km" : `${Math.round(d)} km`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function listItems(items, pl) {
  return items
    .map((it) => {
      const y = year(it.date);
      const href = wiki(it.title);
      const name = esc(nameOf(it.label, it.title));
      const where = it.d < 1 ? "in town" : `${fmtKm(it.d)} ${compass(pl.lat, pl.lon, it.lat, it.lon)}`;
      return `<li><span class="when">${y ? esc(y) : "—"}</span><span class="what">${href ? `<a href="${esc(href)}" rel="noopener">${name}</a>` : name} <span class="where">${where}</span></span></li>`;
    })
    .join("\n        ");
}

// People born or died within RADIUS_KM, most famous first. A person is
// filed in the tile of each of their birth and death places, so the same
// person can turn up twice; they're deduped by id. born/died hold the
// nearest matching place ({name, d, dir}), or null.
function peopleNear(pl) {
  const out = new Map();
  const nearest = (list) => {
    let best = null;
    for (const x of list) {
      const d = km(pl.lat, pl.lon, x.lat, x.lon);
      if (d <= RADIUS_KM && (!best || d < best.d)) best = { name: x.name, d, dir: compass(pl.lat, pl.lon, x.lat, x.lon) };
    }
    return best;
  };
  for (const p of around(peopleGrid, pl.lat, pl.lon)) {
    if (out.has(p.id)) continue;
    const born = nearest(p.births);
    const died = nearest(p.deaths);
    if (born || died) out.set(p.id, { ...p, born, died });
  }
  return [...out.values()].sort((a, b) => b.fame - a.fame || a.id.localeCompare(b.id));
}

// "born here" only when it really is this town (same name, or within 3 km of
// its centre); otherwise "born in Blue Ridge Summit, 20 km SW".
function wherePerson(verb, at, pl) {
  if (!at) return null;
  const here = at.d < 3 || foldName(at.name) === foldName(pl.name);
  return here ? `${verb} here` : `${verb} in ${at.name || "a place"} (${fmtKm(at.d)} ${at.dir})`;
}

const PAGE_CSS = "/places/places.css";
const HISTORICAL = "Historical cities";
function page({ title, description, canonical, body, jsonLd }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Groundwar">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${SITE}/social-card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#12141a">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Spectral:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${PAGE_CSS}">
${jsonLd ? `<script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 1)}\n</script>\n` : ""}</head>
<body>
<header class="top"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="28" height="28"> Groundwar</a><a class="top-link" href="/places/">All places</a></header>
<main>
${body}
</main>
<footer>
  <p>Battles, events and people from <a href="https://www.wikidata.org">Wikidata</a>, linked to their <a href="https://www.wikipedia.org">Wikipedia</a> articles, refreshed weekly. Distances are straight-line, from the place's centre.</p>
  <p><a href="/">Groundwar</a> · <a href="/places/">All places</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
</footer>
</body>
</html>
`;
}

function placePage(c, nearbyPages) {
  const { pl, display } = c;
  const battles = c.inc.filter((i) => i.battle);
  const events = c.inc.filter((i) => !i.battle);
  const byDate = (a, b) => (yearNum(a.date) ?? 1e9) - (yearNum(b.date) ?? 1e9) || a.d - b.d;
  battles.sort(byDate);
  events.sort(byDate);
  const ppl = peopleNear(pl);
  const shownPeople = ppl.slice(0, MAX_PEOPLE);

  // A data-driven summary: counts, the time span, and the best-known names.
  const dated = c.inc.filter((i) => yearNum(i.date) !== null).sort(byDate);
  const first = dated.length ? year(dated[0].date) : null;
  const last = dated.length ? year(dated[dated.length - 1].date) : null;
  const span = !first ? "" : first === last ? ` in ${first}` : ` between ${first} and ${last}`;
  // The highlights: what the town is known for first ("Battle of X" /
  // "Siege of X"), then anything else named after it, then the nearest.
  // Same-named entries merge ("the Battle of Verdun (1792 and 1916)").
  const town = foldName(pl.name);
  const nameRe = new RegExp(`\\b${town}\\b`);
  const rank = (n) => (town.length < 3 ? 0 : new RegExp(`^(battle|battles|siege|sack) of ${town}$`).test(foldName(n)) ? 2 : nameRe.test(foldName(n)) ? 1 : 0);
  const withThe = (n) =>
    /^(Battle|Battles|Siege|Sack|Capture|Treaty|Massacre|Raid|Fall|Storming|Relief|Bombing|Liberation|Burning|Assassination)\b/.test(n) ||
    /\b(campaign|massacre|offensive|uprising|riot|riots|bombing|bombings|landings|rebellion|revolt|raid|incident|affair|attack|attacks|shooting|pogrom)$/i.test(n)
      ? `the ${n}`
      : n;
  const groups = new Map();
  for (const i of [...battles, ...events]) {
    if (!i.title) continue;
    const n = nameOf(i.label, i.title);
    if (!groups.has(n)) groups.set(n, { n, d: i.d, years: [] });
    const g = groups.get(n);
    g.d = Math.min(g.d, i.d);
    if (year(i.date) && !g.years.includes(year(i.date))) g.years.push(year(i.date));
  }
  const famous = [...groups.values()]
    .sort((a, b) => rank(b.n) - rank(a.n) || (rank(a.n) ? a.n.length - b.n.length : 0) || a.d - b.d)
    // Skip one that only restates an earlier pick ("…, First Day").
    .filter((g, k, arr) => !arr.slice(0, k).some((o) => g.n.startsWith(o.n)))
    .slice(0, 2)
    .map((g) => `${withThe(g.n)}${g.years.length ? ` (${g.years.sort((x, y) => yearSort(x) - yearSort(y)).join(" and ")})` : ""}`);
  const parts = [];
  if (battles.length) parts.push(plural(battles.length, "battle or military operation", "battles and military operations"));
  if (events.length) parts.push(plural(events.length, "other historical event", "other historical events"));
  const lede = `${parts.join(" and ")} took place within ${RADIUS_KM} km of ${display}${span}${
    famous.length ? `, including ${famous.join(" and ")}` : ""
  }.${ppl.length ? ` ${plural(ppl.length, "notable person was", "notable people were")} born or died here.` : ""}`;

  const title = `Battles and history near ${display} | Groundwar`;
  const description = lede.length > 158 ? lede.slice(0, 155).replace(/\s+\S*$/, "") + "…" : lede;
  const mapUrl = `/?lat=${pl.lat}&lon=${pl.lon}&label=${encodeURIComponent(display)}&r=${RADIUS_KM}`;
  const canonical = `${SITE}/places/${c.slug}`;

  const peopleList = shownPeople
    .map((p) => {
      const href = wiki(p.title);
      const name = esc(nameOf(p.label, p.title));
      const life = [year(p.dob), year(p.dod)].filter(Boolean).join("–");
      const b = wherePerson("born", p.born, pl);
      const d = wherePerson("died", p.died, pl);
      const how = b === "born here" && d === "died here" ? "born and died here" : [b, d].filter(Boolean).join(", ");
      return `<li><span class="when">${life ? esc(life) : "—"}</span><span class="what">${href ? `<a href="${esc(href)}" rel="noopener">${name}</a>` : name} <span class="where">${esc(how)}</span></span></li>`;
    })
    .join("\n        ");

  const body = `  <nav class="crumbs"><a href="/places/">Places</a> › ${esc(pl.country || HISTORICAL)}</nav>
  <h1>History near ${esc(display)}</h1>
  <p class="lede">${esc(lede)}</p>
  <p><a class="cta" href="${esc(mapUrl)}">Explore ${esc(pl.name)} on the map →</a></p>
${
  battles.length
    ? `  <section>
    <h2>Battles and military operations</h2>
    <ul class="items">
        ${listItems(battles, pl)}
    </ul>
  </section>
`
    : ""
}${
    events.length
      ? `  <section>
    <h2>Historical events</h2>
    <ul class="items">
        ${listItems(events, pl)}
    </ul>
  </section>
`
      : ""
  }${
    shownPeople.length
      ? `  <section>
    <h2>Notable people</h2>
    <ul class="items people">
        ${peopleList}
    </ul>${ppl.length > shownPeople.length ? `\n    <p class="more"><a href="${esc(mapUrl)}">See all ${ppl.length} on the map →</a></p>` : ""}
  </section>
`
      : ""
  }${
    nearbyPages.length
      ? `  <section>
    <h2>History nearby</h2>
    <ul class="nearby">
        ${nearbyPages.map((n) => `<li><a href="/places/${esc(n.c.slug)}">${esc(n.c.display)}</a> <span class="where">${Math.round(n.d)} km ${compass(pl.lat, pl.lon, n.c.pl.lat, n.c.pl.lon)}</span></li>`).join("\n        ")}
    </ul>
  </section>
`
      : ""
  }`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `History near ${display}`,
    url: canonical,
    description,
    about: { "@type": "Place", name: display, geo: { "@type": "GeoCoordinates", latitude: pl.lat, longitude: pl.lon } },
    isPartOf: { "@type": "WebSite", name: "Groundwar", url: `${SITE}/` },
  };
  return page({ title, description, canonical, body, jsonLd });
}

function indexPage() {
  const byCountry = new Map();
  for (const c of chosen) {
    const k = c.pl.country || HISTORICAL;
    if (!byCountry.has(k)) byCountry.set(k, []);
    byCountry.get(k).push(c);
  }
  // Historical cities with no present-day country on Wikidata (Nicaea,
  // Königsberg) go last, under their own heading.
  const countries = [...byCountry.keys()].sort((a, b) => (a === HISTORICAL) - (b === HISTORICAL) || a.localeCompare(b));
  const body = `  <h1>Places with a history</h1>
  <p class="lede">${chosen.length} towns and cities around the world with a battlefield on their doorstep or a long record of battles and historical events within ${RADIUS_KM} km, each with what happened there and who was born or died there. Or <a href="/">search anywhere on the map</a>.</p>
${countries
  .map(
    (k) => `  <section>
    <h2>${esc(k)}</h2>
    <ul class="nearby">
        ${byCountry
          .get(k)
          .sort((a, b) => a.display.localeCompare(b.display))
          .map((c) => `<li><a href="/places/${esc(c.slug)}">${esc(c.display)}</a> <span class="where">${plural(c.inc.length, "battle or event", "battles &amp; events")}</span></li>`)
          .join("\n        ")}
    </ul>
  </section>`
  )
  .join("\n")}`;
  return page({
    title: "Places with a history: battles and events by town | Groundwar",
    description: `Browse ${chosen.length} towns and cities and the battles, historical events and notable people tied to each, from Wikidata and Wikipedia.`,
    canonical: `${SITE}/places/`,
    body,
  });
}

// --- writing -----------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
// places/manifest.json remembers, per page: its Wikidata id, a content hash
// and the date its content last changed (so a page's sitemap <lastmod> only
// moves when it really changed), plus every retired address and where it
// now redirects. Shape: { pages: { slug: {id, hash, lastmod} }, redirects:
// { oldSlug: newSlug } }.
const manifestPath = join(OUT_DIR, "manifest.json");
const old = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const oldPages = old.pages || {};
const today = new Date().toISOString().slice(0, 10);
const pages = {};
const keep = new Set(["manifest.json", "places.css", "index.html"]);

function write(file, html, key, id) {
  const hash = createHash("sha256").update(html).digest("hex").slice(0, 16);
  const prev = oldPages[key];
  pages[key] = { id, hash, lastmod: prev && prev.hash === hash ? prev.lastmod : today };
  writeFileSync(join(OUT_DIR, file), html);
}

for (const c of chosen) {
  const nearby = chosen
    .filter((o) => o !== c)
    .map((o) => ({ c: o, d: km(c.pl.lat, c.pl.lon, o.pl.lat, o.pl.lon) }))
    .filter((o) => o.d <= NEARBY_MAX_KM)
    .sort((a, b) => a.d - b.d)
    .slice(0, NEARBY_PAGES);
  write(`${c.slug}.html`, placePage(c, nearby), c.slug, c.pl.id);
  keep.add(`${c.slug}.html`);
}
write("index.html", indexPage(), "", null);
for (const f of readdirSync(OUT_DIR)) if (!keep.has(f) && f.endsWith(".html")) unlinkSync(join(OUT_DIR, f));

// Redirects: when a town's page moves to a new address (say its country
// name changes), its old address 301s to the new one, so links and search
// results never hit a 404. Earlier redirects are re-pointed at the newest
// address (no chains), and dropped if their address is a live page again.
// A page that disappears altogether gets no redirect; it just 404s.
const slugById = new Map(chosen.map((c) => [c.pl.id, c.slug]));
const redirects = { ...(old.redirects || {}) };
for (const [slug, info] of Object.entries(oldPages)) {
  const now = info.id && slugById.get(info.id);
  if (now && now !== slug) redirects[slug] = now;
}
for (const [from, to] of Object.entries(redirects)) {
  const oldInfo = oldPages[to];
  const current = oldInfo && oldInfo.id && slugById.get(oldInfo.id);
  if (current && current !== to) redirects[from] = current;
  if (pages[from] || !keep.has(`${redirects[from]}.html`)) delete redirects[from];
}
const sortedObject = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
writeFileSync(manifestPath, JSON.stringify({ pages: sortedObject(pages), redirects: sortedObject(redirects) }, null, 1) + "\n");
// _redirects at the site root is read by Cloudflare Workers static assets
// (GitHub Pages ignores it). Only place-page redirects live there, so this
// build owns the whole file.
writeFileSync(
  "_redirects",
  "# Generated by scripts/build-place-pages.mjs: retired place-page addresses.\n" +
    Object.keys(redirects)
      .sort()
      .map((from) => `/places/${from} /places/${redirects[from]} 301`)
      .join("\n") +
    "\n"
);
const manifest = pages;

// sitemap.xml: the fixed pages keep the lastmod already in the file; place
// pages use the date their content last changed.
const oldSitemap = existsSync("sitemap.xml") ? readFileSync("sitemap.xml", "utf8") : "";
const lastmodOf = (loc, fallback) => new RegExp(`<loc>${loc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc>\\s*<lastmod>([^<]+)</lastmod>`).exec(oldSitemap)?.[1] || fallback;
const urls = [
  { loc: `${SITE}/`, lastmod: lastmodOf(`${SITE}/`, today), freq: "weekly", prio: "1.0" },
  { loc: `${SITE}/places/`, lastmod: manifest[""].lastmod, freq: "weekly", prio: "0.8" },
  ...chosen
    .slice()
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((c) => ({ loc: `${SITE}/places/${c.slug}`, lastmod: manifest[c.slug].lastmod, freq: "monthly", prio: "0.6" })),
  { loc: `${SITE}/privacy`, lastmod: lastmodOf(`${SITE}/privacy`, today), freq: "yearly", prio: "0.3" },
  { loc: `${SITE}/terms`, lastmod: lastmodOf(`${SITE}/terms`, today), freq: "yearly", prio: "0.3" },
];
writeFileSync(
  "sitemap.xml",
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.prio}</priority>\n  </url>`)
  .join("\n")}
</urlset>
`
);

// The homepage's "Famous battlefields" links (index.html, between the
// popular-places markers). A hand-picked list of the best-known battlefield
// towns, in order of preference: a ranking by Wikipedia languages picks
// places that are famous for other reasons (Aleppo, Bristol). The first
// POPULAR that got a page this build are linked, topped up from that
// ranking if too few did, and the list is rewritten every build so the
// links always point at pages that exist.
const POPULAR = 12;
const FAMOUS = [
  "gettysburg-pennsylvania", "waterloo-belgium", "hastings-england", "verdun-france",
  "ypres-belgium", "bastogne-belgium", "yorktown-virginia", "lexington-massachusetts",
  "dunkirk-france", "arnhem-netherlands", "sedan-france", "fredericksburg-virginia",
  "bayeux-france", "cassino-italy", "leipzig-germany", "lutzen-germany",
];
const pageBySlug = new Map(chosen.map((c) => [c.slug, c]));
const popular = FAMOUS.map((s) => pageBySlug.get(s)).filter(Boolean).slice(0, POPULAR);
for (const c of chosen
  .filter((c) => c.battlefield && c.pl.s < 150)
  .sort((a, b) => b.pl.s - a.pl.s || a.slug.localeCompare(b.slug))) {
  if (popular.length >= POPULAR) break;
  if (!popular.includes(c)) popular.push(c);
}
popular.sort((a, b) => a.pl.name.localeCompare(b.pl.name));
const home = readFileSync("index.html", "utf8");
const block = /(<!-- popular-places:start -->)[\s\S]*?(\n\s*<!-- popular-places:end -->)/;
if (!block.test(home)) throw new Error("index.html is missing the popular-places markers");
writeFileSync(
  "index.html",
  home.replace(
    block,
    (_, start, end) =>
      start + popular.map((c) => `\n        <li><a href="/places/${esc(c.slug)}">${esc(c.pl.name)}</a></li>`).join("") + end
  )
);

const counts = chosen.map((c) => c.inc.length).sort((a, b) => a - b);
console.log(
  `\n${scored.length} places qualify (${scored.filter((c) => c.battlefield).length} with a battle named after them, ` +
    `${chosen.filter((c) => c.battlefield).length} of those got pages); wrote ${chosen.length} pages ` +
    `(${counts[0]}–${counts[counts.length - 1]} battles/events each, median ${counts[counts.length >> 1]}; ` +
    `${chosen[chosen.length - 1].pl.s}+ Wikipedia languages) and sitemap.xml with ${urls.length} URLs`
);
