#!/usr/bin/env node
// Pre-builds the "notable people" layer as static JSON tiles, the same way
// build-tiles.mjs does for battles and events. Run from the repo root:
//
//   node scripts/build-figure-tiles.mjs
//
// No dependencies (Node 18+). Writes data/figures/:
//   manifest.json            tiers, which cells exist in each, a version hash
//   <tier>/<lat>_<lon>.json  one file per cell that has anyone in it
//
// Why QLever and not query.wikidata.org: this needs every human with more
// than 8 sitelinks (about 340,000 people with a mapped birthplace), and
// Wikidata's own endpoint can't scan all ~12M humans for sitelink counts
// inside its 60-second limit. QLever (University of Freiburg) runs the same
// SPARQL over a Wikidata copy in about a second per query. Its copy can
// lag Wikidata by a week or two, which is fine for people born centuries
// ago, and the app still falls back to live Wikidata if these tiles fail.
//
// What the tiles reproduce: figuresQuery() in app.js. A person is included
// if they're instance-of human, have an English Wikipedia article, and have
// more sitelinks than the chosen fame level; "born near" means a P19 place,
// "died near" a P20 place, within the radius. Same as the live query, a
// person needs at least one birthplace with coordinates and an English
// label to show up at all, even if it's their death that matched.
//
// The live query keeps the 120 most-linked people per search (ORDER BY
// DESC(?sitelinks) LIMIT 120, once for born-near and once for died-near),
// so the tiles need a fame order too. Fame tiers line up with the app's
// three "fame" options (sitelinks > 60, > 25, > 8), and within a tier each
// person carries a coarse fame score, round(10 * log10(sitelinks)), rather
// than the exact count. The score only moves when someone's sitelinks grow
// by about a quarter, so a tile doesn't change every time one new
// translation of an article appears somewhere. That keeps the weekly
// rebuild's diffs, and the repo, small.

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const OUT_DIR = "data/figures";
const ENDPOINT = "https://qlever.dev/api/wikidata";
const USER_AGENT = "GroundwarTileBuilder/1.0 (https://groundwar.app; https://github.com/peperonsky/groundwar)";

// Highest first. A person goes in the first tier whose `min` they exceed.
// Denser tiers get smaller cells so a city search doesn't pull in a whole
// region's worth of minor figures.
const TIERS = [
  { id: "t60", min: 60, cellDeg: 5 },
  { id: "t25", min: 25, cellDeg: 2 },
  { id: "t8", min: 8, cellDeg: 1 },
];
const FLOOR = TIERS[TIERS.length - 1].min;

const PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX schema: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
`;
const HUMANS = `?p wdt:P31 wd:Q5 ; wikibase:sitelinks ?s . FILTER(?s > ${FLOOR})`;
// Same set, narrowed to people with an English Wikipedia article (the app
// links every result to one), so the side queries don't fetch rows for
// people who'd be dropped anyway.
const ENWIKI = `?enwiki schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> .`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, embedded
// newlines). Returns an array of objects keyed by the header row. Slices
// fields out with indexOf rather than building them a character at a
// time, which matters at ~350,000 rows per query.
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
  return body.map((r) => {
    const o = {};
    for (let k = 0; k < header.length; k++) o[header[k]] = r[k] ?? "";
    return o;
  });
}

async function query(name, body) {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    let problem;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/csv",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "query=" + encodeURIComponent(PREFIXES + body),
      });
      const text = await res.text();
      if (res.ok) {
        const rows = parseCsv(text);
        console.log(`${name}: ${rows.length} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return rows;
      }
      if (res.status !== 429 && res.status < 500) throw new Error(`${name} failed (${res.status}): ${text.slice(0, 300)}`);
      problem = String(res.status);
    } catch (err) {
      if (err.message.includes("failed (")) throw err;
      problem = err.message;
    }
    if (attempt >= 6) throw new Error(`${name} kept failing: ${problem}`);
    const wait = 15000 * attempt;
    console.warn(`  ${name}: ${problem}, retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
}

const qid = (uri) => uri.slice(uri.lastIndexOf("/") + 1);
const isoDate = (v) => /^-?\d+-\d\d-\d\d/.exec(v || "")?.[0] || null;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

// QLever's public endpoint rate-limits bursts, so the queries go one at a
// time with a pause between them.
const PAUSE = 8000;

const people = await query(
  "people",
  `SELECT ?p ?s ?label ?article WHERE {
    ${HUMANS}
    ?article schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> .
    OPTIONAL { ?p rdfs:label ?label . FILTER(LANG(?label) = "en") }
  }`
);
await sleep(PAUSE);
const births = await query("births", `SELECT ?p ?place WHERE { ${HUMANS} ${ENWIKI} ?p wdt:P19 ?place . ?place wdt:P625 ?c . }`);
await sleep(PAUSE);
const deaths = await query("deaths", `SELECT ?p ?place WHERE { ${HUMANS} ${ENWIKI} ?p wdt:P20 ?place . ?place wdt:P625 ?c . }`);
await sleep(PAUSE);
const placeRows = await query(
  "places",
  `SELECT ?place ?coord ?label WHERE {
    { SELECT DISTINCT ?place WHERE { ${HUMANS} ${ENWIKI} { ?p wdt:P19 ?place } UNION { ?p wdt:P20 ?place } } }
    ?place wdt:P625 ?coord .
    OPTIONAL { ?place rdfs:label ?label . FILTER(LANG(?label) = "en") }
  }`
);
await sleep(PAUSE);
const dobs = await query("births-dates", `SELECT ?p ?d WHERE { ${HUMANS} ${ENWIKI} ?p wdt:P569 ?d . }`);
await sleep(PAUSE);
const dods = await query("death-dates", `SELECT ?p ?d WHERE { ${HUMANS} ${ENWIKI} ?p wdt:P570 ?d . }`);

// place qid -> { lat, lon, label }, Earth coordinates only. A place with
// several coordinates keeps the lowest-sorting one, so rebuilds are stable.
const places = new Map();
for (const r of placeRows.sort((a, b) => (a.coord < b.coord ? -1 : 1))) {
  const id = qid(r.place);
  if (places.has(id) || r.coord.startsWith("<")) continue;
  const m = /Point\(([-\d.eE]+)\s+([-\d.eE]+)\)/i.exec(r.coord); // QLever writes "POINT("
  if (!m) continue;
  const lon = round4(parseFloat(m[1]));
  const lat = round4(parseFloat(m[2]));
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) continue;
  places.set(id, { lat, lon, label: r.label || "" });
}

const byPerson = new Map();
for (const r of people) {
  const id = qid(r.p);
  const s = parseInt(r.s, 10);
  const prev = byPerson.get(id);
  if (prev) {
    if (r.label && !prev.label) prev.label = r.label;
    continue;
  }
  byPerson.set(id, {
    tier: TIERS.find((t) => s > t.min).id,
    fame: Math.round(10 * Math.log10(s)),
    label: r.label || null,
    title: decodeURIComponent(r.article.split("/wiki/")[1] || ""),
    births: new Set(),
    deaths: new Set(),
    dob: null,
    dod: null,
  });
}
const addPlace = (rows, key, needLabel) => {
  for (const r of rows) {
    const person = byPerson.get(qid(r.p));
    const place = places.get(qid(r.place));
    if (!person || !place || (needLabel && !place.label)) continue;
    person[key].add(qid(r.place));
  }
};
// The live query only binds a birthplace that has an English label (it's
// shown in the detail panel), so the tiles require one too.
addPlace(births, "births", true);
addPlace(deaths, "deaths", false);
const addDate = (rows, key) => {
  for (const r of rows) {
    const person = byPerson.get(qid(r.p));
    const d = isoDate(r.d);
    if (person && d && (!person[key] || d < person[key])) person[key] = d;
  }
};
addDate(dobs, "dob");
addDate(dods, "dod");

// Group into tier -> cell -> people. Each person lands in every cell that
// holds one of their birth or death places.
const cellKey = (lat, lon, deg) =>
  `${Math.min(Math.floor(lat / deg), 90 / deg - 1)}_${Math.min(Math.floor(lon / deg), 180 / deg - 1)}`;
const tiles = new Map(TIERS.map((t) => [t.id, new Map()]));
let kept = 0;
for (const [id, person] of [...byPerson].sort(([a], [b]) => a.localeCompare(b))) {
  if (!person.births.size) continue; // same rule as the live query
  kept++;
  const tier = TIERS.find((t) => t.id === person.tier);
  const cells = new Set();
  for (const pid of [...person.births, ...person.deaths]) {
    const pl = places.get(pid);
    cells.add(cellKey(pl.lat, pl.lon, tier.cellDeg));
  }
  for (const key of cells) {
    const tierTiles = tiles.get(tier.id);
    if (!tierTiles.has(key)) tierTiles.set(key, []);
    tierTiles.get(key).push([id, person]);
  }
}

// Tile file: { places: [[label, lat, lon], ...],
//              people: [[qid, label|null, [birthIdx...], [deathIdx...], dob|null, dod|null, wikiTitle, fame], ...] }
// People are sorted most famous first.
// Places are listed once per tile and referenced by index, because many
// people share a birthplace (every London-born figure points at London).
rmSync(OUT_DIR, { recursive: true, force: true });
const hash = createHash("sha256");
// Which cells of a tier have a file, as a base64 bitmap over the whole
// grid: bit (row + rows/2) * cols + (col + cols/2), row-major from the
// south-west, rows = 180/cellDeg, cols = 360/cellDeg. A list of the
// ~9,400 cell names was 100 KB (30 KB gzipped) on every first search;
// this is ~11 KB raw, a few KB gzipped. Decoded by hasFigureCell() in app.js.
function cellBitmap(cells, deg) {
  const rows = 180 / deg;
  const cols = 360 / deg;
  const bytes = new Uint8Array(Math.ceil((rows * cols) / 8));
  for (const key of Object.keys(cells)) {
    const [r, c] = key.split("_").map(Number);
    const bit = (r + rows / 2) * cols + (c + cols / 2);
    bytes[bit >> 3] |= 1 << (bit & 7);
  }
  return Buffer.from(bytes).toString("base64");
}
const manifest = { version: "", tiers: [] };
let totalBytes = 0;
const stats = [];
for (const tier of TIERS) {
  mkdirSync(join(OUT_DIR, tier.id), { recursive: true });
  const cells = {};
  let biggest = 0;
  for (const [key, members] of [...tiles.get(tier.id)].sort(([a], [b]) => a.localeCompare(b))) {
    const index = new Map();
    const placeList = [];
    const ref = (pid) => {
      if (!index.has(pid)) {
        const pl = places.get(pid);
        index.set(pid, placeList.length);
        placeList.push([pl.label, pl.lat, pl.lon]);
      }
      return index.get(pid);
    };
    members.sort(([a, pa], [b, pb]) => pb.fame - pa.fame || a.localeCompare(b));
    const rows = members.map(([id, p]) => [
      id,
      p.label,
      [...p.births].sort().map(ref),
      [...p.deaths].sort().map(ref),
      p.dob,
      p.dod,
      p.title,
      p.fame,
    ]);
    const body = JSON.stringify({ places: placeList, people: rows });
    writeFileSync(join(OUT_DIR, tier.id, `${key}.json`), body);
    hash.update(`${tier.id}/${key}\n${body}\n`);
    cells[key] = rows.length;
    totalBytes += body.length;
    biggest = Math.max(biggest, body.length);
  }
  manifest.tiers.push({ id: tier.id, min: tier.min, cellDeg: tier.cellDeg, bits: cellBitmap(cells, tier.cellDeg) });
  stats.push(`${tier.id}: ${Object.keys(cells).length} tiles, largest ${(biggest / 1024).toFixed(0)} KB`);
}
manifest.version = hash.digest("hex").slice(0, 12);
writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest) + "\n");

console.log(`\n${kept} people, ${(totalBytes / 1024 / 1024).toFixed(1)} MB total`);
for (const s of stats) console.log("  " + s);
