#!/usr/bin/env node
// Pre-builds the place-search autocomplete as static JSON, so typing in
// the search box never calls a geocoding API. Run from the repo root:
//
//   node scripts/build-places.mjs
//
// No dependencies (Node 18+). Writes data/places/:
//   manifest.json   which prefix files exist, a version hash
//   <ab>.json       every place whose name (or historical alias) starts
//                   with those two letters, most notable first
//
// Why: Nominatim's usage policy forbids client-side autocomplete against
// its API (https://operations.osmfoundation.org/policies/nominatim/), and
// any public geocoder would buckle or block a traffic spike that fires a
// request every few keystrokes. With this, Nominatim is only asked when
// someone submits text that matches nothing here.
//
// What's in it, from QLever's copy of Wikidata (see build-tiles.mjs):
//   - human settlements (any subclass of Q486972) with 10+ sitelinks:
//     cities, towns, and the small villages battles are named after
//   - countries and administrative regions with 40+ sitelinks
//   - English aliases of places with 40+ sitelinks, so historical names
//     work: "Constantinople" finds Istanbul, "Stalingrad" Volgograd
// Ranked by sitelinks, a decent proxy for "the one you probably meant".

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const OUT_DIR = "data/places";
const ENDPOINT = "https://qlever.dev/api/wikidata";
const USER_AGENT = "GroundwarTileBuilder/1.0 (https://groundwar.app; https://github.com/peperonsky/groundwar)";
const MIN_SETTLEMENT = 10;
const MIN_REGION = 40;
const MIN_ALIASES = 40;

const PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
`;
const PLACES = `{
      ?p wdt:P31/wdt:P279* wd:Q486972 ; wikibase:sitelinks ?s . FILTER(?s >= ${MIN_SETTLEMENT})
    } UNION {
      VALUES ?cls { wd:Q6256 wd:Q56061 }
      ?p wdt:P31/wdt:P279* ?cls ; wikibase:sitelinks ?s . FILTER(?s >= ${MIN_REGION})
    }`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same RFC 4180 parser as build-figure-tiles.mjs (indexOf-based, so it
// copes with a few hundred thousand rows).
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
        headers: { "User-Agent": USER_AGENT, Accept: "text/csv", "Content-Type": "application/x-www-form-urlencoded" },
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
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const PAUSE = 8000;

// Must match normalizePlaceKey() in app.js exactly: strip accents, lower
// case, collapse everything that isn't a letter or digit to one space.
export function normalizeKey(s) {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
// The file a key lives in: its first two characters ("sa"), or for busy
// prefixes listed in the manifest's `split`, its first three ("san").
// Spaces become "-"; a character outside a-z/0-9 sends the key to the
// group's catch-all ("_", or "sa_" inside a split group). Must match
// placeFileFor() in app.js. The app only searches from 3 characters on,
// so a split group never needs its own 2-character file.
export function prefixOf(key, len = 2) {
  const head = key.slice(0, len);
  if (len === 2) return /^[a-z0-9][a-z0-9 ]?$/.test(head) ? head.replace(" ", "-") : "_";
  return /^[a-z0-9 ]{3}$/.test(head) ? head.replace(/ /g, "-") : prefixOf(key, 2) + "_";
}
// A two-letter group bigger than this is split into three-letter files,
// so no keystroke ever downloads more than a few dozen KB.
const SPLIT_BYTES = 60 * 1024;

const placeRows = await query(
  "places",
  `SELECT ?p ?s ?coord ?label WHERE {
    ${PLACES}
    ?p wdt:P625 ?coord ; rdfs:label ?label . FILTER(LANG(?label) = "en")
  }`
);
await sleep(PAUSE);
const countryRows = await query(
  "countries",
  `SELECT ?p ?cl WHERE { ${PLACES} ?p wdt:P17 ?c . ?c rdfs:label ?cl . FILTER(LANG(?cl) = "en") }`
);
await sleep(PAUSE);
const adminRows = await query(
  "admin",
  `SELECT ?p ?al WHERE { ${PLACES} ?p wdt:P131 ?a . ?a rdfs:label ?al . FILTER(LANG(?al) = "en") }`
);
await sleep(PAUSE);
const aliasRows = await query(
  "aliases",
  `SELECT ?p ?alias WHERE {
    ${PLACES}
    FILTER(?s >= ${MIN_ALIASES})
    ?p skos:altLabel ?alias . FILTER(LANG(?alias) = "en")
  }`
);

const places = new Map();
for (const r of placeRows.sort((a, b) => (a.coord < b.coord ? -1 : 1))) {
  const id = qid(r.p);
  if (places.has(id) || r.coord.startsWith("<")) continue;
  const m = /Point\(([-\d.eE]+)\s+([-\d.eE]+)\)/i.exec(r.coord);
  if (!m) continue;
  const lon = round4(parseFloat(m[1]));
  const lat = round4(parseFloat(m[2]));
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) continue;
  places.set(id, { name: r.label, lat, lon, s: parseInt(r.s, 10), country: null, admin: null, aliases: new Set() });
}
// A place with several countries/admins (disputed, or historical values)
// keeps the alphabetically first, so rebuilds are stable.
for (const [rows, key, col] of [
  [countryRows, "country", "cl"],
  [adminRows, "admin", "al"],
]) {
  for (const r of rows) {
    const pl = places.get(qid(r.p));
    if (pl && (!pl[key] || r[col] < pl[key])) pl[key] = r[col];
  }
}
for (const r of aliasRows) {
  const pl = places.get(qid(r.p));
  if (!pl) continue;
  const a = r.alias.trim();
  // Skip codes and abbreviations ("NYC", "UK", "Q12345"), and variants
  // that are just the name plus a qualifier ("Gettysburg, PA") — keep
  // genuinely different names, which is mostly what historical names are.
  const ak = normalizeKey(a);
  if (a.length < 4 || /^[A-Z0-9.\- ]+$/.test(a) || ak.startsWith(normalizeKey(pl.name))) continue;
  pl.aliases.add(a);
}

// Context shown after the name: the country, plus the next admin level
// when the same name appears more than once in that country (Springfield,
// Illinois vs Springfield, Missouri). Countries themselves get none.
const dupes = new Map();
for (const pl of places.values()) {
  const k = normalizeKey(pl.name) + "|" + pl.country;
  dupes.set(k, (dupes.get(k) || 0) + 1);
}
const contextOf = (pl) => {
  const parts = [];
  if (
    pl.admin &&
    pl.admin !== pl.name &&
    pl.admin !== pl.country &&
    dupes.get(normalizeKey(pl.name) + "|" + pl.country) > 1
  )
    parts.push(pl.admin);
  if (pl.country && pl.country !== pl.name) parts.push(pl.country);
  return parts.join(", ");
};

// Row: [name, context, lat, lon, rank, currentName|0]
//   name        what's matched and shown (a historical alias, or the label)
//   currentName for alias rows, the place's actual name ("Constantinople"
//               row -> "Istanbul"), shown as "Constantinople (now Istanbul)"
//   rank        sitelinks, used to order matches; halved for alias rows so
//               a place's real name outranks some other place's nickname
//               ("Constantinople of the East" is Lucknow)
const groups = new Map(); // 2-char prefix -> [{key, row}]
const add = (key, row) => {
  const g = prefixOf(key);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push({ key, row });
};
for (const [, pl] of [...places].sort(([a], [b]) => a.localeCompare(b))) {
  const context = contextOf(pl);
  const key = normalizeKey(pl.name);
  if (key) add(key, [pl.name, context, pl.lat, pl.lon, pl.s, 0]);
  for (const a of [...pl.aliases].sort()) add(normalizeKey(a), [a, context, pl.lat, pl.lon, Math.floor(pl.s / 2), pl.name]);
}

const byRank = (a, b) => b[4] - a[4] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const files = new Map();
const split = [];
for (const [g, entries] of groups) {
  if (JSON.stringify(entries.map((e) => e.row)).length <= SPLIT_BYTES || g === "_") {
    files.set(g, entries.map((e) => e.row));
    continue;
  }
  split.push(g);
  for (const { key, row } of entries) {
    const f = prefixOf(key, 3);
    if (!files.has(f)) files.set(f, []);
    files.get(f).push(row);
  }
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
const hash = createHash("sha256");
let total = 0;
let biggest = ["", 0];
let rowCount = 0;
for (const f of [...files.keys()].sort()) {
  const rows = files.get(f).sort(byRank);
  const body = JSON.stringify(rows);
  writeFileSync(join(OUT_DIR, f + ".json"), body);
  hash.update(f + "\n" + body + "\n");
  total += body.length;
  rowCount += rows.length;
  if (body.length > biggest[1]) biggest = [f, body.length];
}
writeFileSync(
  join(OUT_DIR, "manifest.json"),
  JSON.stringify({ version: hash.digest("hex").slice(0, 12), split: split.sort(), files: [...files.keys()].sort() }) + "\n"
);
console.log(
  `\n${places.size} places, ${rowCount} rows (with aliases) in ${files.size} files, ` +
    `${(total / 1024 / 1024).toFixed(1)} MB total; largest "${biggest[0]}" ${(biggest[1] / 1024).toFixed(0)} KB`
);
