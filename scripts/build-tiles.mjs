#!/usr/bin/env node
// Pre-builds the battles / operations / events layer as static JSON tiles,
// so the app can load them from this site instead of querying Wikidata
// live on every search. Run from the repo root:
//
//   node scripts/build-tiles.mjs
//
// No dependencies (Node 18+ for fetch). It writes data/incidents/:
//   manifest.json      which cells exist, the type QIDs covered, a version hash
//   <lat>_<lon>.json   one file per CELL_DEG x CELL_DEG square that has anything
//
// The type lists are read straight out of app.js, so editing BATTLE_TYPES /
// OPERATION_TYPES / EVENT_TYPES / DISASTER_TYPES there and re-running this
// is all it takes.
// Until it's re-run, the app notices that a type it wants isn't in the
// manifest and falls back to the live query on its own.
//
// Output is deterministic (sorted, no timestamps), so re-running against
// unchanged Wikidata produces no diff — the weekly GitHub Action relies on
// that to only commit when something actually changed.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const CELL_DEG = 5;
const OUT_DIR = "data/incidents";
// QLever's Wikidata copy rather than query.wikidata.org, the same as
// build-figure-tiles.mjs: it answers these in about a second, and keeps
// working during Wikidata Query Service outages (which have rate-limited
// WDQS to one request per minute for whole afternoons), so the weekly
// rebuild doesn't fail whenever WDQS is having a bad day. Its copy can lag
// Wikidata by a week or two.
const ENDPOINT = "https://qlever.dev/api/wikidata";
const PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX ps: <http://www.wikidata.org/prop/statement/>
PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
PREFIX psv: <http://www.wikidata.org/prop/statement/value/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX schema: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
`;
// Wikimedia asks automated clients for a descriptive User-Agent with a way
// to reach the operator: https://meta.wikimedia.org/wiki/User-Agent_policy
const USER_AGENT = "GroundwarTileBuilder/1.0 (https://groundwar.app; https://github.com/peperonsky/groundwar)";

function readTypeList(source, name) {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source);
  if (!m) throw new Error(`Couldn't find ${name} in app.js`);
  return [...m[1].matchAll(/"(Q\d+)"/g)].map((x) => x[1]);
}

const appJs = readFileSync("app.js", "utf8");
const TYPES = [
  ...new Set([
    ...readTypeList(appJs, "BATTLE_TYPES"),
    ...readTypeList(appJs, "OPERATION_TYPES"),
    ...readTypeList(appJs, "EVENT_TYPES"),
    ...readTypeList(appJs, "DISASTER_TYPES"),
  ]),
].sort();
const LOSS_EVENT_TYPES = readTypeList(appJs, "LOSS_EVENT_TYPES");
// Types asked for in one query each. Fewer, larger queries: the endpoint
// rate-limits bursts of requests, not the size of an answer.
const BATCH = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sparql(query) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/sparql-results+json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "query=" + encodeURIComponent(PREFIXES + query),
    });
    const text = await res.text();
    let problem;
    if (res.ok) {
      // A 200 can still arrive cut off mid-stream (the endpoint has
      // already sent its headers when it hits a timeout), so a parse
      // failure counts as retryable rather than fatal.
      try {
        return JSON.parse(text).results.bindings;
      } catch (e) {
        problem = `truncated response (${text.length} bytes)`;
      }
    } else if (res.status !== 429 && res.status < 500) {
      throw new Error(`Wikidata query failed (${res.status}): ${text.slice(0, 300)}`);
    } else {
      problem = String(res.status);
    }
    // Up to about four minutes in all: the endpoint's rate limit can take
    // a while to clear, and its Retry-After (often 5s) is too eager for it.
    if (attempt >= 6) throw new Error(`Wikidata query kept failing: ${problem}`);
    const wait = Math.max(Number(res.headers.get("retry-after")) * 1000 || 0, 15000 * attempt);
    console.warn(`  ${problem}, retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
}

// Mirrors incidentsQuery() in app.js, minus the "around" clause: same
// direct P31 match, same English-Wikipedia-article requirement, same date
// (P585 point in time, else P580 start time, since multi-day battles such
// as Gettysburg only record a start and an end; else, for a wreck, the
// dated sinking among its significant events, else the date it ceased to
// exist), taken as a plain string,
// which streams more reliably than typed xsd:dateTime values for odd
// historical dates. rdfs:label instead of the label service, which is much
// cheaper over thousands of rows; a missing label is handled the same way
// the app already handles one (fall back to the article title).
const values = (qids) => qids.map((q) => "wd:" + q).join(" ");
const DATE_AND_LABEL = `
    OPTIONAL { ?item wdt:P585 ?pointInTime }
    OPTIONAL { ?item wdt:P580 ?startTime }
    OPTIONAL { ?item p:P793 ?lossStatement . ?lossStatement ps:P793 ?lossType ; pq:P585 ?lossTime .
      VALUES ?lossType { ${values(LOSS_EVENT_TYPES)} } }
    OPTIONAL { ?item wdt:P576 ?endedTime }
    BIND(STR(COALESCE(?pointInTime, ?startTime, ?lossTime, ?endedTime)) AS ?date)
    OPTIONAL { ?item rdfs:label ?label . FILTER(lang(?label) = "en") }`;

function typeQuery(qids) {
  return `SELECT ?item ?type ?label ?coord ?date ?article WHERE {
    VALUES ?type { ${values(qids)} }
    ?item wdt:P31 ?type ; wdt:P625 ?coord .
    ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .${DATE_AND_LABEL}
  }`;
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;

// A WKT point as { lat, lon } rounded to 5 decimals, or null for anything
// else: non-Earth globes are written as "<globe-uri> Point(...)", and the
// live "around" search never matches those, so neither should the tiles.
function parsePoint(wkt) {
  if (!wkt || wkt.startsWith("<")) return null;
  const m = /Point\(([-\d.eE]+)\s+([-\d.eE]+)\)/i.exec(wkt); // QLever writes "POINT("
  if (!m) return null;
  const lon = round5(parseFloat(m[1]));
  const lat = round5(parseFloat(m[2]));
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

function km(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

const qidOf = (term) => term.value.split("/").pop();

// Same as yearFromName() in app.js: an undated item whose own name starts
// with a year ("2000 MI6 attack") gets that year, as YYYY-01-01.
function yearFromName(...names) {
  for (const name of names) {
    const m = /^(1\d{3}|20\d{2})(?:[–-]\d{1,4})?[ _]/.exec(name || "");
    if (m && Number(m[1]) <= new Date().getFullYear()) return m[1] + "-01-01";
  }
  return null;
}

// item QID -> { label, title, date, types:Set, coords:Set("lat,lon") }
const items = new Map();

for (let b = 0; b < TYPES.length; b += BATCH) {
  const batch = TYPES.slice(b, b + BATCH);
  process.stdout.write(`${batch.join(" ")} … `);
  const rows = await sparql(typeQuery(batch));
  let kept = 0;
  for (const r of rows) {
    const pt = parsePoint(r.coord?.value);
    if (!pt) continue;
    const { lat, lon } = pt;

    const id = qidOf(r.item);
    let it = items.get(id);
    if (!it) {
      const title = decodeURIComponent(r.article.value.split("/wiki/")[1] || "");
      it = { label: null, title, dates: new Set(), types: new Set(), coords: new Set() };
      items.set(id, it);
    }
    if (r.label?.value) it.label = r.label.value;
    // Only real ISO dates; an explicit "unknown value" comes back as a
    // genid URI. Kept to the YYYY-MM-DD part, which is all the app reads.
    const d = /^-?\d+-\d\d-\d\d/.exec(r.date?.value || "");
    if (d) it.dates.add(d[0]);
    it.types.add(r.type.value.split("/").pop());
    it.coords.add(`${lat},${lon}`);
    kept++;
  }
  console.log(`${rows.length} rows, ${kept} kept`);
  await sleep(5000); // be gentle with the shared endpoint (it rate-limits bursts)
}

// ---------------------------------------------------------------------
// Second pass: items with no coordinates of their own, placed at the one
// place Wikidata names as their location (P276), when that's precise.
// ---------------------------------------------------------------------
// Thousands of battles and events have an article but no coordinates, only
// a location: the Battle of Keramaia's is the island of Cyprus. The place
// is linked by its Wikidata ID, not its name, so a town called the same in
// another country can't be picked up by mistake; the country check below
// catches an editor who linked the wrong one. Such an item is pinned at
// its place, and its tile row carries the place's name, so the app can say
// the spot is approximate. An item is left off the map when:
// - it names several places more than SAME_PLACE_KM apart (the September
//   11 attacks: Manhattan, Arlington, Shanksville), since there's no one
//   right spot;
// - its place isn't precise: a country, a region, a river, a sea, or an
//   island, lake, bay or strait bigger than MAX_SIZED_KM2;
// - the item and its place each record a country, the two share none, and
//   the place is over MAX_FOREIGN_KM from every country the item names
//   (that distance lets a "Kingdom of France" battle sit in France).
// The live query in app.js doesn't do this; it's only the fallback for when
// the tiles can't be loaded.
const TOWN_CLASSES = ["Q486972", "Q15284"]; // human settlement; municipality (communes, comuni, municipios)
// architectural structure (castle, fort, palace, bridge...), archaeological
// site, mountain, hill, mountain pass, cape, aerodrome
const SITE_CLASSES = ["Q811979", "Q839954", "Q8502", "Q54050", "Q133056", "Q185113", "Q62447"];
const SIZED_CLASSES = ["Q23442", "Q23397", "Q39594", "Q37901"]; // island, lake, bay, strait
const MAX_SIZED_KM2 = 15000; // Cyprus (9,251 km²) and Crete fit; Sicily and Great Britain don't
const SAME_PLACE_KM = 10; // a palace and its hall of mirrors are one place
const MAX_FOREIGN_KM = 1000;
// Area units Wikidata uses, in km²: km², hectare, m², square mile, acre.
const AREA_UNIT_KM2 = { Q712226: 1, Q35852: 0.01, Q25343: 1e-6, Q232291: 2.589988, Q81292: 0.00404686 };

function placedQuery(qids) {
  return `SELECT ?item ?type ?label ?date ?article ?loc ?locCoord ?locLabel ?locClass ?area ?areaUnit ?itemCountry ?itemCountryCoord ?locCountry WHERE {
    VALUES ?type { ${values(qids)} }
    ?item wdt:P31 ?type .
    ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
    MINUS { ?item wdt:P625 ?ownCoord }
    ?item wdt:P276 ?loc . ?loc wdt:P625 ?locCoord .${DATE_AND_LABEL}
    OPTIONAL { ?loc rdfs:label ?locLabel . FILTER(lang(?locLabel) = "en") }
    OPTIONAL { ?loc wdt:P31 ?locClass }
    OPTIONAL { ?loc p:P2046/psv:P2046 ?areaValue . ?areaValue wikibase:quantityAmount ?area ; wikibase:quantityUnit ?areaUnit }
    OPTIONAL { ?item wdt:P17 ?itemCountry . OPTIONAL { ?itemCountry wdt:P625 ?itemCountryCoord } }
    OPTIONAL { ?loc wdt:P17 ?locCountry }
  }`;
}

// Every subclass of each family, fetched once: walking the class tree for
// each place inside the query above made it take minutes per batch.
async function subclassesOf(roots) {
  const rows = await sparql(`SELECT DISTINCT ?c WHERE { VALUES ?root { ${values(roots)} } ?c wdt:P279* ?root }`);
  await sleep(5000);
  return new Set(rows.map((r) => qidOf(r.c)));
}
const townClasses = await subclassesOf(TOWN_CLASSES);
const siteClasses = await subclassesOf(SITE_CLASSES);
const sizedClasses = await subclassesOf(SIZED_CLASSES);
console.log(`\nPlace kinds: ${townClasses.size} town, ${siteClasses.size} site, ${sizedClasses.size} island/lake/bay/strait classes`);

// item QID -> { label, title, dates, types, locs: Map(QID -> place), countries: Map(QID -> point|null) }
const unplaced = new Map();
for (let b = 0; b < TYPES.length; b += BATCH) {
  const batch = TYPES.slice(b, b + BATCH);
  process.stdout.write(`places for ${batch.join(" ")} … `);
  const rows = await sparql(placedQuery(batch));
  for (const r of rows) {
    const id = qidOf(r.item);
    if (items.has(id)) continue;
    const pt = parsePoint(r.locCoord?.value);
    if (!pt) continue;
    let e = unplaced.get(id);
    if (!e) {
      const title = decodeURIComponent(r.article.value.split("/wiki/")[1] || "");
      e = { label: null, title, dates: new Set(), types: new Set(), locs: new Map(), countries: new Map() };
      unplaced.set(id, e);
    }
    if (r.label?.value) e.label = r.label.value;
    const d = /^-?\d+-\d\d-\d\d/.exec(r.date?.value || "");
    if (d) e.dates.add(d[0]);
    e.types.add(qidOf(r.type));
    const locId = qidOf(r.loc);
    let loc = e.locs.get(locId);
    if (!loc) e.locs.set(locId, (loc = { id: locId, ...pt, label: null, town: false, site: false, sized: false, areaKm2: null, countries: new Set() }));
    // A place with two coordinates keeps the lower one, so reruns agree.
    if (pt.lat < loc.lat || (pt.lat === loc.lat && pt.lon < loc.lon)) Object.assign(loc, pt);
    if (r.locLabel?.value) loc.label = r.locLabel.value;
    if (r.locClass) {
      const c = qidOf(r.locClass);
      if (townClasses.has(c)) loc.town = true;
      if (siteClasses.has(c)) loc.site = true;
      if (sizedClasses.has(c)) loc.sized = true;
    }
    const factor = r.areaUnit && AREA_UNIT_KM2[qidOf(r.areaUnit)];
    if (factor) {
      const area = parseFloat(r.area.value) * factor;
      // The largest figure given, so a disputed area can't sneak under the cap.
      if (Number.isFinite(area)) loc.areaKm2 = Math.max(loc.areaKm2 ?? 0, area);
    }
    if (r.itemCountry) {
      const c = qidOf(r.itemCountry);
      const cpt = parsePoint(r.itemCountryCoord?.value);
      if (!e.countries.has(c) || (cpt && !e.countries.get(c))) e.countries.set(c, cpt);
    }
    if (r.locCountry) loc.countries.add(qidOf(r.locCountry));
  }
  console.log(`${rows.length} rows`);
  await sleep(5000);
}

const placedStats = { placed: 0, severalPlaces: 0, vague: 0, countryMismatch: 0, noName: 0 };
const mismatches = [];
for (const [id, e] of [...unplaced].sort(([a], [b]) => a.localeCompare(b))) {
  const locs = [...e.locs.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (locs.some((l) => km(l, locs[0]) > SAME_PLACE_KM)) {
    placedStats.severalPlaces++;
    continue;
  }
  // Among places that close together, the most specific: a site (the
  // palace), then a town, then a small island or lake.
  const small = (l) => l.sized && l.areaKm2 != null && l.areaKm2 <= MAX_SIZED_KM2;
  const place = locs.find((l) => l.site) || locs.find((l) => l.town) || locs.find(small);
  if (!place) {
    placedStats.vague++;
    continue;
  }
  if (!place.label) {
    placedStats.noName++;
    continue;
  }
  const own = e.countries;
  if (own.size && place.countries.size && ![...place.countries].some((c) => own.has(c))) {
    const near = [...own.values()].some((c) => c && km(c, place) <= MAX_FOREIGN_KM);
    if (!near) {
      placedStats.countryMismatch++;
      mismatches.push(`${e.label || e.title} (${id}) -> ${place.label} (${place.id})`);
      continue;
    }
  }
  items.set(id, {
    label: e.label,
    title: e.title,
    dates: e.dates,
    types: e.types,
    coords: new Set([`${place.lat},${place.lon}`]),
    place: place.label,
  });
  placedStats.placed++;
}
console.log(
  `\nPlaced at their named place: ${placedStats.placed}. Left off: ${placedStats.severalPlaces} name places far apart, ` +
    `${placedStats.vague} name only a country, region or other vague place, ${placedStats.countryMismatch} fail the country check, ` +
    `${placedStats.noName} name a place with no English name.`
);
if (mismatches.length) console.log("Country check failed, e.g.:\n  " + mismatches.slice(0, 15).join("\n  "));

// One row per (item, coordinate) in the cell that coordinate falls in. An
// item with two coordinates can land in two cells; the app keeps whichever
// copy is nearest, just as the live query's ORDER BY dist + dedupe does.
// Row: [qid, label|null, lat, lon, date|null, wikiTitle, [typeQids], place?]
const cells = new Map();
const cellKey = (lat, lon) =>
  `${Math.min(Math.floor(lat / CELL_DEG), 90 / CELL_DEG - 1)}_${Math.min(Math.floor(lon / CELL_DEG), 180 / CELL_DEG - 1)}`;

for (const [id, it] of [...items].sort(([a], [b]) => a.localeCompare(b))) {
  const date = [...it.dates].sort()[0] || yearFromName(it.label, it.title);
  const types = [...it.types].sort();
  for (const c of [...it.coords].sort()) {
    const [lat, lon] = c.split(",").map(Number);
    const key = cellKey(lat, lon);
    if (!cells.has(key)) cells.set(key, []);
    // An item placed at its named place (second pass) carries that place's
    // name as an 8th field, so the app can say the spot is approximate.
    cells.get(key).push([id, it.label, lat, lon, date, it.title, types, ...(it.place ? [it.place] : [])]);
  }
}

mkdirSync(OUT_DIR, { recursive: true });
for (const f of readdirSync(OUT_DIR)) if (f.endsWith(".json")) unlinkSync(join(OUT_DIR, f));

const hash = createHash("sha256");
const cellCounts = {};
let totalBytes = 0;
for (const key of [...cells.keys()].sort()) {
  const body = JSON.stringify(cells.get(key));
  writeFileSync(join(OUT_DIR, `${key}.json`), body);
  hash.update(key + "\n" + body + "\n");
  cellCounts[key] = cells.get(key).length;
  totalBytes += body.length;
}

const manifest = {
  // Changes whenever any tile does; the app appends it to tile URLs so a
  // browser never mixes tiles from two different builds.
  version: hash.update(TYPES.join(",")).digest("hex").slice(0, 12),
  cellDeg: CELL_DEG,
  types: TYPES,
  cells: cellCounts,
};
writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

const sizes = Object.values(cellCounts).sort((a, b) => b - a);
console.log(
  `\n${items.size} items -> ${cells.size} tiles, ${(totalBytes / 1024).toFixed(0)} KB total, ` +
    `largest tile ${sizes[0]} rows, median ${sizes[Math.floor(sizes.length / 2)]} rows`
);
