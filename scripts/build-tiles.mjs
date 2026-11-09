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
function typeQuery(qids) {
  return `SELECT ?item ?type ?label ?coord ?date ?article WHERE {
    VALUES ?type { ${qids.map((q) => "wd:" + q).join(" ")} }
    ?item wdt:P31 ?type ; wdt:P625 ?coord .
    ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
    OPTIONAL { ?item wdt:P585 ?pointInTime }
    OPTIONAL { ?item wdt:P580 ?startTime }
    OPTIONAL { ?item p:P793 ?lossStatement . ?lossStatement ps:P793 ?lossType ; pq:P585 ?lossTime .
      VALUES ?lossType { ${LOSS_EVENT_TYPES.map((q) => "wd:" + q).join(" ")} } }
    OPTIONAL { ?item wdt:P576 ?endedTime }
    BIND(STR(COALESCE(?pointInTime, ?startTime, ?lossTime, ?endedTime)) AS ?date)
    OPTIONAL { ?item rdfs:label ?label . FILTER(lang(?label) = "en") }
  }`;
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;

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
    const wkt = r.coord?.value || "";
    // Non-Earth globes are written as "<globe-uri> Point(...)"; the live
    // "around" search never matches those, so neither should the tiles.
    if (wkt.startsWith("<")) continue;
    const m = /Point\(([-\d.eE]+)\s+([-\d.eE]+)\)/i.exec(wkt); // QLever writes "POINT("
    if (!m) continue;
    const lon = round5(parseFloat(m[1]));
    const lat = round5(parseFloat(m[2]));
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) continue;

    const id = r.item.value.split("/").pop();
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

// One row per (item, coordinate) in the cell that coordinate falls in. An
// item with two coordinates can land in two cells; the app keeps whichever
// copy is nearest, just as the live query's ORDER BY dist + dedupe does.
// Row: [qid, label|null, lat, lon, date|null, wikiTitle, [typeQids]]
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
    cells.get(key).push([id, it.label, lat, lon, date, it.title, types]);
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
