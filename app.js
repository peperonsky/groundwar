(function () {
  "use strict";

  // As early as possible, for an honest "script start" baseline — see
  // hideStartupScreen() below, which measures from this mark to first
  // content. Purely local: logged to the console, never sent anywhere.
  try {
    performance.mark("groundwar-script-start");
  } catch (e) {
    // Performance API unavailable — the measurement is a nice-to-have, not required
  }

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------
  const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
  const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
  const WIKI_SUMMARY_ENDPOINT = "https://en.wikipedia.org/api/rest_v1/page/summary/";
  // battle, siege, naval battle. Q1125864 was previously mislabeled here —
  // it's actually a German-school disambiguation page on current Wikidata
  // (zero real items are ever instance-of it), so this filter had silently
  // matched nothing for that sub-category; Q1261499 is the real "naval
  // battle" class (1300+ instances, most with coordinates).
  const BATTLE_TYPES = ["Q178561", "Q188055", "Q1261499"];
  // offensive, military raid, landing operation, military expedition,
  // military operation — e.g. the Bobruysk offensive (Q2653174) is
  // P31=Q2001676 ("offensive"), not plain "battle", which is why it was
  // missing before. Each QID here was individually confirmed to have real,
  // mostly-coordinate-bearing instances at roughly single-operation scale.
  // Deliberately excludes "military campaign" (Q831663): despite looking
  // like a safe sibling class, its real instances range from items already
  // tagged "battle" up to entire named wars (even "Crusades" is one of its
  // own subclasses) — exactly the "no sensible single point" failure mode
  // this list avoids. Q178561/Q188055 (battle/siege) are themselves
  // transitive P279 subclasses of Q645883 ("military operation"), but
  // Wikidata tags items with their most specific class, so a real battle's
  // P31 is Q178561 itself, never the broad Q645883 — this exact-match
  // VALUES query doesn't double-count battles as operations, and the one
  // case where an item legitimately carries both a battle-type and an
  // operation-type P31 is already handled by dedupeById() below.
  const OPERATION_TYPES = ["Q2001676", "Q476807", "Q646740", "Q1384277", "Q645883"];
  const EVENT_TYPES = ["Q131569", "Q45382", "Q10931", "Q2751054", "Q3882219", "Q217327", "Q124757"];
  // treaty, coup d'état, revolution, massacre, assassination, uprising, riot
  // Operations render with the same icon/color/cluster as battles (this app
  // only ever shows 3 coarse kinds — battle/event/figure — never finer
  // sub-types, same as how a coup or a massacre both just read "event").
  const BATTLE_TYPE_SET = new Set([...BATTLE_TYPES, ...OPERATION_TYPES]);
  const DEFAULT_CENTER = { lat: 51.5072, lon: -0.1276, label: "London (example)" };
  const ERA_PRESETS = {
    ancient: { from: -4000, to: 500 },
    medieval: { from: 500, to: 1500 },
    early_modern: { from: 1500, to: 1800 },
    modern: { from: 1800, to: 2100 },
  };

  // ---------------------------------------------------------------------
  // Theme: auto (follows OS) / light / dark, remembered per visitor
  // ---------------------------------------------------------------------
  const THEME_KEY = "groundwar:theme";
  const THEME_ORDER = ["auto", "light", "dark"];
  const THEME_LABEL = { auto: "Theme: Auto (follows system)", light: "Theme: Light", dark: "Theme: Dark" };
  const THEME_ICON = {
    auto: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 2.1v13.8a6.9 6.9 0 010-13.8z" fill="currentColor"/></svg>',
    light:
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.5v2.6M12 18.9v2.6M4.1 4.1l1.8 1.8M18.1 18.1l1.8 1.8M2.5 12h2.6M18.9 12h2.6M4.1 19.9l1.8-1.8M18.1 5.9l1.8-1.8"/></g></svg>',
    dark: '<svg viewBox="0 0 24 24"><path d="M20.2 14.9A8.7 8.7 0 119.1 3.8a7.2 7.2 0 1011.1 11.1z" fill="currentColor"/></svg>',
  };

  function loadTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return THEME_ORDER.includes(v) ? v : "auto";
    } catch (e) {
      return "auto";
    }
  }

  function applyTheme(mode) {
    if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
    themeToggleBtn.innerHTML = THEME_ICON[mode];
    themeToggleBtn.setAttribute("aria-label", THEME_LABEL[mode] + ". Click to change.");
    themeToggleBtn.title = THEME_LABEL[mode];
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch (e) {
      // private browsing / blocked storage — the choice just won't persist
    }
  }

  // ---------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const startupScreen = $("startup-screen");
  const searchForm = $("search-form");
  const placeInput = $("place-search");
  const locateBtn = $("locate-btn");
  const copyLinkBtn = $("copy-link-btn");
  const surpriseBtn = $("surprise-btn");
  const themeToggleBtn = $("theme-toggle");
  const locationStatus = $("location-status");
  const radiusSelect = $("radius-select");
  const fameSelect = $("fame-select");
  const eraSelect = $("era-select");
  const toggleBattles = $("toggle-battles");
  const battleScopeRow = $("battle-scope-row");
  const toggleEvents = $("toggle-events");
  const toggleFigures = $("toggle-figures");
  const countBattles = $("count-battles");
  const countEvents = $("count-events");
  const countFigures = $("count-figures");
  const searchSuggestions = $("search-suggestions");
  const searchAreaBtn = $("search-area-btn");
  const mapLegend = $("map-legend");
  const mapLegendBattle = mapLegend.querySelector('[data-legend="battle"]');
  const mapLegendEvent = mapLegend.querySelector('[data-legend="event"]');
  const mapLegendFigure = mapLegend.querySelector('[data-legend="figure"]');
  const aboutOverlay = $("about-overlay");
  const aboutClose = $("about-close");
  const shortcutsLink = $("shortcuts-link");
  const shortcutsOverlay = $("shortcuts-overlay");
  const shortcutsClose = $("shortcuts-close");
  const mylistBtn = $("mylist-btn");
  const mylistOverlay = $("mylist-overlay");
  const mylistClose = $("mylist-close");
  const mylistItemsEl = $("mylist-items");
  const mylistCountEl = $("mylist-count");
  const mylistExportBtn = $("mylist-export");
  const mylistClearBtn = $("mylist-clear");
  const recentChips = $("recent-chips");
  const chipsCaption = $("chips-caption");
  const resultsTitle = $("results-title");
  const resultsSpinner = $("results-spinner");
  const resultsExportBtn = $("results-export");
  const installBanner = $("install-banner");
  const installBannerText = $("install-banner-text");
  const installBannerInstallBtn = $("install-banner-install");
  const installBannerDismissBtn = $("install-banner-dismiss");
  const resultsFilterInput = $("results-filter");
  const sortSelect = $("sort-select");
  const otdToggleBtn = $("otd-toggle");
  const starredToggleBtn = $("starred-toggle");
  const resultsList = $("results-list");
  const detailPanel = $("detail-panel");
  const detailContent = $("detail-content");
  const detailClose = $("detail-close");
  const sidebarEl = $("sidebar");
  const sheetHandle = $("sheet-handle");
  const sheetHandleSummary = $("sheet-handle-summary");
  const listView = $("list-view");
  const mobileDetailView = $("mobile-detail-view");
  const mobileDetailBack = $("mobile-detail-back");
  const mobileDetailContent = $("mobile-detail-content");
  const leaveConfirmOverlay = $("leave-confirm-overlay");
  const leaveConfirmStay = $("leave-confirm-stay");
  const leaveConfirmLeave = $("leave-confirm-leave");
  // Scoped to each control's own container, not the shared ".unit-btn" class
  // alone — the battles/operations scope switch below reuses that same
  // class for its visual styling, and an unscoped query would sweep its
  // buttons into this list too (wrong data attribute, wrong handler).
  const unitButtons = Array.from(document.querySelectorAll("#unit-switch .unit-btn"));
  const scopeButtons = Array.from(document.querySelectorAll("#scope-switch .unit-btn"));

  const mobileMq = window.matchMedia("(max-width: 760px)");

  // Applied immediately (not deferred to boot()) so there's no flash of
  // the wrong theme while the map and data are still loading.
  applyTheme(loadTheme());
  themeToggleBtn.addEventListener("click", () => {
    const current = THEME_ORDER.includes(document.documentElement.dataset.theme)
      ? document.documentElement.dataset.theme
      : "auto";
    const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
    applyTheme(next);
  });

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    center: null,
    radiusKm: Number(radiusSelect.value),
    minSitelinks: Number(fameSelect.value),
    units: "km",
    battleScope: "both", // "wars" | "both" | "operations" — which BATTLE_TYPES/OPERATION_TYPES subset to query
    era: "all",
    sort: "distance",
    filterText: "",
    showStarredOnly: false,
    showTodayOnly: false,
    results: [], // flat list for the sidebar, each {kind, id, name, distKm, lat, lon, ...} — already era-filtered
    allIncidents: [], // everything the last search fetched, before the era filter
    allFigures: [],
    lastSearchFailed: false,
    // Which layers the in-flight search is still waiting on. Each query
    // renders as soon as it lands, so for a moment the map can hold
    // battles but not yet figures — these flags let the counts and empty
    // state say "still loading" rather than "found nothing".
    pending: { incidents: false, figures: false },
  };

  // Starred items: a Map of id -> a small snapshot of that item, kept
  // independent of any one search so "My List" can show (and jump back
  // to) something you starred at a completely different place.
  const FAVORITES_KEY = "groundwar:favorites";
  function snapshotOf(item) {
    const isFigure = item.kind === "figure";
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      wikiTitle: item.wikiTitle || null,
      lat: isFigure ? item.birthLat : item.lat,
      lon: isFigure ? item.birthLon : item.lon,
      birthLat: item.birthLat ?? null,
      birthLon: item.birthLon ?? null,
      birthLabel: item.birthLabel || "",
      deathLat: item.deathLat ?? null,
      deathLon: item.deathLon ?? null,
      deathLabel: item.deathLabel || "",
      dateYear: item.dateYear || null,
      dateMD: item.dateMD || null,
      dobYear: item.dobYear || null,
      dobMD: item.dobMD || null,
      dodYear: item.dodYear || null,
      dodMD: item.dodMD || null,
      matchKinds: item.matchKinds || null,
    };
  }
  function loadFavorites() {
    try {
      const raw = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
      // Older versions stored a bare array of ids with no snapshot — those
      // can't be shown in "My List" (nothing to render), so they're
      // dropped rather than kept as un-displayable ghost entries.
      const entries = raw.filter((v) => v && typeof v === "object").map((v) => [v.id, v]);
      return new Map(entries);
    } catch (e) {
      return new Map();
    }
  }
  function saveFavorites() {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites.values()]));
    } catch (e) {
      // private browsing / blocked storage — starring just won't persist
    }
  }
  function toggleFavorite(item) {
    if (favorites.has(item.id)) {
      favorites.delete(item.id);
    } else {
      favorites.set(item.id, snapshotOf(item));
      maybeShowInstallBanner();
    }
    saveFavorites();
    updateMyListBadge();
  }
  const favorites = loadFavorites();
  updateMyListBadge();

  // Effective single year for sorting/era purposes: an incident's own
  // date, or a figure's birth year (falling back to death year).
  function effectiveYear(item) {
    return item.kind === "figure" ? item.dobNum ?? item.dodNum : item.dateNum;
  }

  // Every year an item is actually tied to — a figure has up to two (birth,
  // death), an incident has one — used to cross-match "also from this time".
  function relevantYears(item) {
    return item.kind === "figure" ? [item.dobNum, item.dodNum].filter((y) => y != null) : [item.dateNum].filter((y) => y != null);
  }

  let map, homeMarker, radiusCircle;
  let battleCluster, eventCluster, figureCluster;
  const figureLines = L.layerGroup();
  let activeFetchToken = 0;

  // ---------------------------------------------------------------------
  // Map setup
  // ---------------------------------------------------------------------
  function initMap() {
    map = L.map("map", { zoomControl: false, attributionControl: true }).setView(
      [DEFAULT_CENTER.lat, DEFAULT_CENTER.lon],
      9
    );
    L.control.zoom({ position: "topright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; Historical data from <a href="https://www.wikidata.org">Wikidata</a> &middot; <a href="#" id="about-link">About</a>',
    }).addTo(map);

    battleCluster = L.markerClusterGroup({
      iconCreateFunction: clusterIcon("battle"),
      maxClusterRadius: 48,
      spiderfyOnMaxZoom: true,
    });
    eventCluster = L.markerClusterGroup({
      iconCreateFunction: clusterIcon("event"),
      maxClusterRadius: 48,
      spiderfyOnMaxZoom: true,
    });
    figureCluster = L.markerClusterGroup({
      iconCreateFunction: clusterIcon("figure"),
      maxClusterRadius: 48,
      spiderfyOnMaxZoom: true,
    });
    battleCluster.addTo(map);
    eventCluster.addTo(map);
    figureCluster.addTo(map);
    figureLines.addTo(map);

    // Belt-and-suspenders for the listener clusterIcon() wires up below:
    // Leaflet.markercluster reuses a bubble's DOM element (no fresh "add"
    // event) whenever a pan/zoom regroup lands on the same child count, so
    // a straggler can reach the screen before any listener fires for it.
    // "animationend" fires once the plugin's own spiderfy/zoom DOM settling
    // finishes, so re-sweeping there catches whatever the live listeners missed.
    battleCluster.on("animationend", labelOrphanClusters);
    eventCluster.on("animationend", labelOrphanClusters);
    figureCluster.on("animationend", labelOrphanClusters);

    // "Search this area": show a floating button once the user has panned
    // meaningfully away from the current search point (programmatic moves
    // from our own setHome() land the map back on state.center, so the
    // distance check naturally stays quiet for those).
    map.on("moveend", () => {
      if (!state.center) return;
      const c = map.getCenter();
      const d = haversineKm(state.center.lat, state.center.lon, c.lat, c.lng);
      const threshold = Math.max(5, state.radiusKm * 0.4);
      searchAreaBtn.hidden = !(d > threshold);
    });
  }

  // Cluster bubbles aren't created through addIncidentMarker/addFigureLayer
  // — the plugin builds them internally — but the "cluster" object passed
  // in here is itself a Marker-like layer, so it gets the exact same
  // role="button"-has-no-name problem, fixed the exact same way: label it
  // fresh on every "add", since the plugin recreates the icon element as
  // clusters merge or split while panning/zooming (a one-time label would
  // go stale the moment that happens).
  const CLUSTER_PLURAL_LABELS = { battle: "battles", event: "historical events", figure: "historical figures" };

  function clusterIcon(kind) {
    const pluralLabel = CLUSTER_PLURAL_LABELS[kind];
    return function (cluster) {
      const count = cluster.getChildCount();
      const size = count < 10 ? 30 : count < 50 ? 38 : 46;
      cluster.off("add"); // re-registering per icon-create call would otherwise stack listeners
      cluster.on("add", (e) => e.target.getElement()?.setAttribute("aria-label", `${count} ${pluralLabel}`));
      return L.divIcon({
        className: "gw-icon",
        html: `<div class="gw-cluster gw-cluster-${kind}" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px">${count}</div>`,
        iconSize: [size, size],
      });
    };
  }

  // Safety net for the listener above: reads a still-unlabeled bubble's own
  // rendered count and kind class back off the DOM, so it stays correct
  // without caring why the "add" event didn't fire for it.
  function labelOrphanClusters() {
    document.querySelectorAll(".leaflet-marker-icon:not([aria-label])").forEach((el) => {
      const bubble = el.querySelector(".gw-cluster");
      if (!bubble) return;
      const kind = Object.keys(CLUSTER_PLURAL_LABELS).find((k) => bubble.classList.contains(`gw-cluster-${k}`));
      if (kind) el.setAttribute("aria-label", `${bubble.textContent} ${CLUSTER_PLURAL_LABELS[kind]}`);
    });
  }

  function homeIcon() {
    return L.divIcon({
      className: "gw-icon",
      html:
        '<div style="width:20px;height:20px;border-radius:50%;background:var(--accent);border:3px solid var(--surface);box-shadow:0 1px 5px rgba(0,0,0,.5)"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
  }

  function setHome(lat, lon, label) {
    state.center = { lat, lon, label };
    if (homeMarker) map.removeLayer(homeMarker);
    if (radiusCircle) map.removeLayer(radiusCircle);
    // Leaflet gives every marker role="button" and keyboard focus but no
    // accessible name of its own, and (for clustered markers especially)
    // recreates the icon element on re-clustering — a one-time setAttribute
    // right after addTo() would get silently wiped out later, so this is
    // reapplied on every "add", not just the first.
    homeMarker = L.marker([lat, lon], { icon: homeIcon(), zIndexOffset: 1000 })
      .on("add", (e) => e.target.getElement()?.setAttribute("aria-label", `Search center: ${label || "this point"}`))
      .addTo(map)
      .bindTooltip(label || "Your point", { direction: "top" });
    radiusCircle = L.circle([lat, lon], {
      radius: state.radiusKm * 1000,
      color: "var(--accent)",
      weight: 1,
      dashArray: "4 6",
      fillOpacity: 0.03,
    }).addTo(map);
    map.setView([lat, lon], zoomForRadius(state.radiusKm));
  }

  function zoomForRadius(km) {
    if (km <= 25) return 10;
    if (km <= 50) return 9;
    if (km <= 100) return 8;
    if (km <= 250) return 7;
    return 6;
  }

  // ---------------------------------------------------------------------
  // Geometry helpers
  // ---------------------------------------------------------------------
  function parseWkt(wkt) {
    // "Point(lon lat)"
    const m = /Point\(([-\d.]+)\s+([-\d.]+)\)/.exec(wkt || "");
    if (!m) return null;
    return { lon: parseFloat(m[1]), lat: parseFloat(m[2]) };
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function wikiTitleFromArticleUri(uri) {
    if (!uri) return null;
    const part = uri.split("/wiki/")[1];
    return part ? decodeURIComponent(part) : null;
  }

  function cleanLabel(label, wikiTitle) {
    // The label service falls back to the bare entity id (e.g. "Q312444")
    // when no name is recorded in any known language.
    if (!label || /^Q\d+$/.test(label)) return nameFromWikiTitle(wikiTitle) || label;
    return label;
  }

  function formatYear(iso) {
    if (!iso) return null;
    // Wikidata represents an explicit "unknown value" date as a skolemized
    // blank-node URI (http://www.wikidata.org/.well-known/genid/...), not a
    // literal — skip anything that isn't an actual ISO date string.
    const m = /^(-?\d+)-\d\d-\d\d/.exec(iso);
    if (!m) return null;
    let y = parseInt(m[1], 10);
    if (y < 0) return `${Math.abs(y)} BCE`;
    return String(y);
  }

  function nameFromWikiTitle(title) {
    return title ? title.replace(/_/g, " ") : null;
  }

  // A signed year number for era filtering, alongside formatYear's display
  // string — same "skip unknown-value genids" guard as formatYear.
  function yearNum(iso) {
    if (!iso) return null;
    const m = /^(-?\d+)-\d\d-\d\d/.exec(iso);
    return m ? parseInt(m[1], 10) : null;
  }

  // Month/day only (ignoring year) for "on this day" matching. Many
  // Wikidata dates are precision-to-year only, using a padded "01-01" —
  // those would spuriously match Jan 1, so anything with that exact
  // padding is treated as "no real month/day known".
  function monthDay(iso) {
    if (!iso) return null;
    const m = /^-?\d+-(\d\d)-(\d\d)/.exec(iso);
    if (!m) return null;
    if (m[1] === "01" && m[2] === "01") return null;
    return m[1] + "-" + m[2];
  }

  function todayMonthDay() {
    const d = new Date();
    return String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function onThisDay(item) {
    const today = todayMonthDay();
    if (item.kind === "figure") return item.dobMD === today || item.dodMD === today;
    return item.dateMD === today;
  }

  function onThisDayLabel(item) {
    if (item.kind !== "figure") return "This happened on this day in history.";
    const today = todayMonthDay();
    const bornToday = item.dobMD === today;
    const diedToday = item.dodMD === today;
    if (bornToday && diedToday) return "Born and died on this day in history.";
    return bornToday ? "Born on this day in history." : "Died on this day in history.";
  }

  // Takes an explicit era rather than always reading state.era, so the same
  // logic can also power "how many would each OTHER era option show" for
  // the dropdown's counts, not just the currently-selected filter.
  function inEraRange(item, era) {
    if (era === "all") return true;
    const range = ERA_PRESETS[era];
    if (item.kind === "figure") {
      const lo = item.dobNum ?? item.dodNum;
      const hi = item.dodNum ?? item.dobNum;
      if (lo == null || hi == null) return false;
      return lo <= range.to && hi >= range.from;
    }
    return item.dateNum != null && item.dateNum >= range.from && item.dateNum <= range.to;
  }

  function inEra(item) {
    return inEraRange(item, state.era);
  }

  function formatDist(km) {
    if (state.units === "mi") return (km * 0.621371).toFixed(1) + " mi";
    return km.toFixed(1) + " km";
  }

  // The radius select only ever holds round km figures, so a whole-number
  // mile conversion (no decimals needed) keeps it readable.
  function formatRadiusLabel(km) {
    return state.units === "mi" ? `${Math.round(km * 0.621371)} mi` : `${km} km`;
  }

  // A figure can qualify because they were born nearby, died nearby, or
  // both — say which, since that's the whole point of "lived near you".
  function matchReason(matchKinds) {
    const hasBorn = matchKinds?.includes("born");
    const hasDied = matchKinds?.includes("died");
    if (hasBorn && hasDied) return "born & died here";
    if (hasDied) return "died here";
    return "born here";
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function kindLabel(kind) {
    if (kind === "battle") return "Battle";
    if (kind === "event") return "Historical event";
    return "Historical figure";
  }

  // ---------------------------------------------------------------------
  // Wikidata SPARQL
  // ---------------------------------------------------------------------
  // Wikidata can be slow, and it's common to flip a layer toggle off and
  // back on, or revisit a recent chip — cache identical queries briefly so
  // those don't re-hit the network.
  const QUERY_CACHE_TTL = 10 * 60 * 1000;
  const QUERY_CACHE_MAX = 30;
  const queryCache = new Map();

  async function sparqlQuery(query, signal) {
    const cached = queryCache.get(query);
    if (cached && Date.now() - cached.time < QUERY_CACHE_TTL) return cached.bindings;

    const url = SPARQL_ENDPOINT + "?query=" + encodeURIComponent(query) + "&format=json";
    const res = await fetch(url, {
      headers: { Accept: "application/sparql-results+json" },
      signal,
    });
    if (!res.ok) throw new Error("Wikidata query failed (" + res.status + ")");
    const data = await res.json();
    const bindings = data.results.bindings;

    queryCache.set(query, { bindings, time: Date.now() });
    if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
    return bindings;
  }

  // battleScope is "wars" (BATTLE_TYPES only), "operations" (OPERATION_TYPES
  // only), "both", or "none" (the battles/sieges/operations toggle is off).
  function incidentTypeQids(battleScope, includeEvents) {
    const qids = [];
    if (battleScope === "wars" || battleScope === "both") qids.push(...BATTLE_TYPES);
    if (battleScope === "operations" || battleScope === "both") qids.push(...OPERATION_TYPES);
    if (includeEvents) qids.push(...EVENT_TYPES);
    return qids;
  }

  function incidentsQuery(lat, lon, radiusKm, battleScope, includeEvents) {
    const types = incidentTypeQids(battleScope, includeEvents).map((q) => "wd:" + q).join(" ");
    return `SELECT ?item ?itemLabel ?type ?coord ?date ?dist ?article WHERE {
      SERVICE wikibase:around {
        ?item wdt:P625 ?coord .
        bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral .
        bd:serviceParam wikibase:radius "${radiusKm}" .
        bd:serviceParam wikibase:distance ?dist .
      }
      VALUES ?type { ${types} }
      ?item wdt:P31 ?type .
      OPTIONAL { ?item wdt:P585 ?date }
      ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } ORDER BY ?dist LIMIT 300`;
  }

  // anchorProp is "P19" (birthplace) or "P20" (place of death) — whichever
  // the SERVICE around clause should match against. Birth and death
  // coordinates are always both selected so the path line can be drawn
  // either way, and so the two queries merge into identical shapes.
  function figuresQuery(lat, lon, radiusKm, minSitelinks, anchorProp) {
    return `SELECT ?person ?personLabel ?birthLabel ?bCoord ?dist ?dob ?deathLabel ?dCoord ?dod ?sitelinks ?article WHERE {
      SERVICE wikibase:around {
        ?anchor wdt:P625 ?anchorCoord .
        bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral .
        bd:serviceParam wikibase:radius "${radiusKm}" .
        bd:serviceParam wikibase:distance ?dist .
      }
      ?person wdt:${anchorProp} ?anchor .
      ?person wdt:P31 wd:Q5 .
      OPTIONAL { ?person wdt:P569 ?dob }
      OPTIONAL { ?person wdt:P19 ?birth . ?birth wdt:P625 ?bCoord . ?birth rdfs:label ?birthLabel . FILTER(lang(?birthLabel)='en') }
      OPTIONAL { ?person wdt:P20 ?death . ?death wdt:P625 ?dCoord . ?death rdfs:label ?deathLabel . FILTER(lang(?deathLabel)='en') }
      OPTIONAL { ?person wdt:P570 ?dod }
      ?person wikibase:sitelinks ?sitelinks . FILTER(?sitelinks > ${minSitelinks})
      ?article schema:about ?person ; schema:isPartOf <https://en.wikipedia.org/> .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } ORDER BY DESC(?sitelinks) LIMIT ${FIGURE_LIMIT}`;
  }

  function dedupeById(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  // Merges the born-near and died-near result sets: a person who matches
  // both keeps a single entry, remembers both reasons, and sorts/displays
  // by whichever location is closer.
  function dedupeFigures(items) {
    const byId = new Map();
    for (const item of items) {
      const existing = byId.get(item.id);
      if (!existing) {
        byId.set(item.id, { ...item, matchKinds: [item.matchKind] });
        continue;
      }
      if (!existing.matchKinds.includes(item.matchKind)) existing.matchKinds.push(item.matchKind);
      if (item.distKm < existing.distKm) existing.distKm = item.distKm;
    }
    return Array.from(byId.values());
  }

  // One shape for an incident whether it came from the live query or a
  // pre-built tile, so nothing downstream can tell the two apart.
  function makeIncident({ id, label, lat, lon, distKm, date, wikiTitle, isBattle }) {
    const kind = isBattle ? "battle" : "event";
    return {
      kind,
      id,
      name: cleanLabel(label, wikiTitle) || (kind === "battle" ? "Unnamed battle" : "Unnamed event"),
      lat,
      lon,
      distKm,
      dateYear: formatYear(date),
      dateNum: yearNum(date),
      dateMD: monthDay(date),
      wikiTitle,
    };
  }

  function rowsToIncidents(rows) {
    const items = rows
      .map((r) => {
        const pt = parseWkt(r.coord?.value);
        if (!pt) return null;
        const typeQid = (r.type?.value || "").split("/").pop();
        return makeIncident({
          id: r.item.value,
          label: r.itemLabel?.value,
          lat: pt.lat,
          lon: pt.lon,
          distKm: parseFloat(r.dist?.value || "0"),
          date: r.date?.value,
          wikiTitle: wikiTitleFromArticleUri(r.article?.value),
          isBattle: BATTLE_TYPE_SET.has(typeQid),
        });
      })
      .filter(Boolean);
    return dedupeById(items);
  }

  // ---------------------------------------------------------------------
  // Pre-built incident tiles
  // ---------------------------------------------------------------------
  // Battles, operations and events are pre-built into static JSON tiles by
  // scripts/build-tiles.mjs (refreshed weekly by a GitHub Action), one file
  // per 5°x5° square, so a search loads one to a few small files from this
  // site instead of running a live Wikidata query. Same results as the
  // live query: same types, same radius, same nearest-300 cap. Anything
  // that goes wrong here — no manifest, a missing tile, a type the tiles
  // weren't built with — falls back to the live query, so the tiles can
  // only ever make a search faster, never break it.
  const TILE_ROOT = "data/incidents/";
  const FIGURE_TILE_ROOT = "data/figures/";
  const INCIDENT_LIMIT = 300; // matches incidentsQuery()'s LIMIT
  const ENTITY_PREFIX = "http://www.wikidata.org/entity/";
  // url -> Promise<parsed JSON>, for manifests and tiles alike. A failed
  // fetch is dropped from the cache so a later search can try it again.
  const jsonCache = new Map();

  function loadJson(url) {
    if (!jsonCache.has(url)) {
      const job = fetch(url).then((res) => {
        if (!res.ok) throw new Error(url + " failed (" + res.status + ")");
        return res.json();
      });
      job.catch(() => jsonCache.delete(url));
      jsonCache.set(url, job);
    }
    return jsonCache.get(url);
  }

  // Every cell the search circle could touch: a lat/lon bounding box
  // around it, widened to all longitudes near a pole, wrapped across the
  // antimeridian. Generous by design — exact distances are checked after.
  function cellsForCircle(lat, lon, radiusKm, deg) {
    const dLat = radiusKm / 111;
    const latMin = Math.max(-90, lat - dLat);
    const latMax = Math.min(90, lat + dLat);
    const widest = Math.max(Math.abs(latMin), Math.abs(latMax));
    const cosLat = Math.cos((Math.min(widest, 89.9) * Math.PI) / 180);
    const dLon = radiusKm / (111 * cosLat);
    const rows = 180 / deg;
    const cols = 360 / deg;
    const keys = new Set();
    const rMin = Math.floor(latMin / deg);
    const rMax = Math.min(Math.floor(latMax / deg), rows / 2 - 1);
    const allLon = dLon >= 180;
    const cMin = allLon ? -cols / 2 : Math.floor((lon - dLon) / deg);
    const cMax = allLon ? cols / 2 - 1 : Math.floor((lon + dLon) / deg);
    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const wrapped = ((((c + cols / 2) % cols) + cols) % cols) - cols / 2;
        keys.add(r + "_" + wrapped);
      }
    }
    return [...keys];
  }

  async function incidentsFromTiles(lat, lon, radiusKm, qids) {
    const manifest = await loadJson(TILE_ROOT + "manifest.json");
    const covered = new Set(manifest.types);
    if (!qids.every((q) => covered.has(q))) throw new Error("Tiles weren't built with every requested type");

    const keys = cellsForCircle(lat, lon, radiusKm, manifest.cellDeg).filter((k) => manifest.cells[k]);
    const tiles = await Promise.all(keys.map((k) => loadJson(TILE_ROOT + k + ".json?v=" + manifest.version)));

    const wanted = new Set(qids);
    const nearest = new Map(); // qid -> { row, dist } — an item with several coordinates keeps its closest
    for (const rows of tiles) {
      for (const row of rows) {
        // [qid, label, lat, lon, date, wikiTitle, typeQids]
        if (!row[6].some((t) => wanted.has(t))) continue;
        const dist = haversineKm(lat, lon, row[2], row[3]);
        if (dist > radiusKm) continue;
        const prev = nearest.get(row[0]);
        if (!prev || dist < prev.dist) nearest.set(row[0], { row, dist });
      }
    }
    return [...nearest.values()]
      .sort((a, b) => a.dist - b.dist)
      .slice(0, INCIDENT_LIMIT)
      .map(({ row, dist }) =>
        makeIncident({
          id: ENTITY_PREFIX + row[0],
          label: row[1],
          lat: row[2],
          lon: row[3],
          distKm: dist,
          date: row[4],
          wikiTitle: row[5],
          isBattle: row[6].some((t) => wanted.has(t) && BATTLE_TYPE_SET.has(t)),
        })
      );
  }

  async function fetchIncidents(lat, lon, radiusKm, battleScope, includeEvents) {
    try {
      return await incidentsFromTiles(lat, lon, radiusKm, incidentTypeQids(battleScope, includeEvents));
    } catch (err) {
      console.warn("Groundwar: incident tiles unavailable, querying Wikidata live instead.", err);
      return rowsToIncidents(await sparqlQuery(incidentsQuery(lat, lon, radiusKm, battleScope, includeEvents)));
    }
  }

  // People are pre-built the same way (scripts/build-figure-tiles.mjs),
  // split into fame tiers that match the fame select's options: "t60" holds
  // everyone with more than 60 sitelinks, "t25" those with 26–60, "t8"
  // those with 9–25. Within a tier each person has a coarse fame score.
  //
  // Mirrors figuresQuery(): the FIGURE_LIMIT most famous people born near
  // the point, and separately the FIGURE_LIMIT most famous who died near it.
  // Because every person in a higher tier outranks everyone in a lower one,
  // a lower tier only needs downloading if the tiers above it didn't
  // already fill both lists — so a city search at "Everyone recorded"
  // usually never touches the big long-tail tiles at all.
  //
  // Returns the same {born, died} lists the two live queries would, ready
  // for dedupeFigures(). A fame level that isn't a tier boundary (only
  // possible via a hand-edited URL) throws, sending that search live.
  const FIGURE_LIMIT = 120; // matches figuresQuery()'s LIMIT

  async function figuresFromTiles(lat, lon, radiusKm, minSitelinks) {
    const manifest = await loadJson(FIGURE_TILE_ROOT + "manifest.json");
    if (!manifest.tiers.some((t) => t.min === minSitelinks)) throw new Error("No figure tier for fame " + minSitelinks);
    const tiers = manifest.tiers.filter((t) => t.min >= minSitelinks).sort((a, b) => b.min - a.min);

    const loadTier = (tier) => {
      const urls = cellsForCircle(lat, lon, radiusKm, tier.cellDeg)
        .filter((key) => tier.cells[key])
        .map((key) => FIGURE_TILE_ROOT + tier.id + "/" + key + ".json?v=" + manifest.version);
      return Promise.all(urls.map(loadJson));
    };
    // Every tier but the lowest is small, so those all start downloading
    // at once; the lowest (by far the biggest) waits until it's needed.
    const pending = tiers.map((tier, i) => (i < tiers.length - 1 ? loadTier(tier) : null));

    const born = [];
    const died = [];
    const seen = new Set(); // a person with birth and death in different cells appears in both
    for (let t = 0; t < tiers.length; t++) {
      if (born.length >= FIGURE_LIMIT && died.length >= FIGURE_LIMIT) break;
      const tiles = await (pending[t] || loadTier(tiers[t]));
      const tierBorn = [];
      const tierDied = [];
      for (const { places, people } of tiles) {
        const place = (i) => ({ label: places[i][0], lat: places[i][1], lon: places[i][2] });
        const nearestWithin = (idxs) => {
          let best = null;
          for (const i of idxs) {
            const d = haversineKm(lat, lon, places[i][1], places[i][2]);
            if (d <= radiusKm && (best === null || d < best)) best = d;
          }
          return best;
        };
        for (const [qid, label, birthIdx, deathIdx, dob, dod, wikiTitle, fame] of people) {
          if (seen.has(qid)) continue;
          const bornKm = nearestWithin(birthIdx);
          const diedKm = nearestWithin(deathIdx);
          if (bornKm === null && diedKm === null) continue;
          seen.add(qid);
          const base = {
            id: ENTITY_PREFIX + qid,
            label,
            birth: place(birthIdx[0]),
            death: deathIdx.length ? place(deathIdx[0]) : null,
            dob,
            dod,
            wikiTitle,
          };
          if (bornKm !== null) tierBorn.push({ fame, item: makeFigure({ ...base, distKm: bornKm, matchKind: "born" }) });
          if (diedKm !== null) tierDied.push({ fame, item: makeFigure({ ...base, distKm: diedKm, matchKind: "died" }) });
        }
      }
      const byFame = (a, b) => b.fame - a.fame || a.item.distKm - b.item.distKm;
      for (const [list, found] of [[born, tierBorn], [died, tierDied]]) {
        found.sort(byFame);
        for (const { item } of found) if (list.length < FIGURE_LIMIT) list.push(item);
      }
    }
    return { born, died };
  }

  // One shape for a figure whether it came from the live query or a
  // pre-built tile. birth is required ({lat, lon, label}); death may be null.
  function makeFigure({ id, label, birth, death, distKm, dob, dod, wikiTitle, matchKind }) {
    return {
      kind: "figure",
      id,
      name: cleanLabel(label, wikiTitle) || "Unknown figure",
      birthLat: birth.lat,
      birthLon: birth.lon,
      birthLabel: birth.label || "",
      deathLat: death?.lat ?? null,
      deathLon: death?.lon ?? null,
      deathLabel: death?.label || "",
      distKm,
      dobYear: formatYear(dob),
      dobNum: yearNum(dob),
      dobMD: monthDay(dob),
      dodYear: formatYear(dod),
      dodNum: yearNum(dod),
      dodMD: monthDay(dod),
      wikiTitle,
      matchKind,
    };
  }

  function rowsToFigures(rows, matchKind) {
    return rows
      .map((r) => {
        const birth = parseWkt(r.bCoord?.value);
        if (!birth) return null;
        const death = parseWkt(r.dCoord?.value);
        return makeFigure({
          id: r.person.value,
          label: r.personLabel?.value,
          birth: { ...birth, label: r.birthLabel?.value },
          death: death && { ...death, label: r.deathLabel?.value },
          distKm: parseFloat(r.dist?.value || "0"),
          dob: r.dob?.value,
          dod: r.dod?.value,
          wikiTitle: wikiTitleFromArticleUri(r.article?.value),
          matchKind,
        });
      })
      .filter(Boolean);
  }

  // ---------------------------------------------------------------------
  // Wikipedia summaries
  // ---------------------------------------------------------------------
  async function fetchSummary(title, signal) {
    const res = await fetch(WIKI_SUMMARY_ENDPOINT + encodeURIComponent(title), { signal });
    if (!res.ok) throw new Error("No article summary (" + res.status + ")");
    return res.json();
  }

  // ---------------------------------------------------------------------
  // Nominatim geocoding
  // ---------------------------------------------------------------------
  async function geocode(query) {
    const url =
      NOMINATIM_ENDPOINT + "?format=json&limit=1&q=" + encodeURIComponent(query);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("Geocoding failed");
    const list = await res.json();
    if (!list.length) return null;
    return { lat: parseFloat(list[0].lat), lon: parseFloat(list[0].lon), label: list[0].display_name };
  }

  async function geocodeSuggestions(query, signal) {
    const url = NOMINATIM_ENDPOINT + "?format=json&limit=5&q=" + encodeURIComponent(query);
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
    if (!res.ok) throw new Error("Geocoding failed");
    const list = await res.json();
    return list.map((hit) => ({ lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), label: hit.display_name }));
  }

  async function reverseGeocode(lat, lon) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("Reverse geocoding failed");
    const hit = await res.json();
    return hit?.display_name || null;
  }

  // ---------------------------------------------------------------------
  // Rendering: markers
  // ---------------------------------------------------------------------
  // Hand-drawn, not emoji — keeps the glyph identical across every OS
  // instead of however each platform's system emoji font renders ⚔/⚒.
  const BATTLE_GLYPH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/><line x1="4" y1="3.3" x2="7" y2="3.3"/><line x1="3.3" y1="4" x2="3.3" y2="7"/><line x1="20" y1="3.3" x2="17" y2="3.3"/><line x1="20.7" y1="4" x2="20.7" y2="7"/></svg>';
  const EVENT_GLYPH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="1.5"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>';

  function battleIcon() {
    return L.divIcon({
      className: "gw-icon",
      html: `<div class="gw-pin-battle">${BATTLE_GLYPH}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }
  function eventIcon() {
    return L.divIcon({
      className: "gw-icon",
      html: `<div class="gw-pin-battle gw-pin-event">${EVENT_GLYPH}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }
  function figureBirthIcon() {
    return L.divIcon({
      className: "gw-icon",
      html: '<div class="gw-pin-battle gw-pin-figure-birth"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }
  function figureDeathIcon() {
    return L.divIcon({
      className: "gw-icon",
      html: '<div class="gw-pin-figure-death"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  // Wires a popup's star button fresh each time it opens (rather than
  // baking starred/unstarred into the static popup HTML), so it reflects
  // the current state even if the item was starred elsewhere since the
  // marker was created.
  function wirePopupStar(popupEl, item) {
    const btn = popupEl.querySelector("[data-popup-star]");
    if (!btn) return;
    const sync = () => {
      const starred = favorites.has(item.id);
      btn.classList.toggle("starred", starred);
      btn.setAttribute("aria-pressed", String(starred));
      btn.setAttribute("aria-label", (starred ? "Remove " : "Star ") + item.name + (starred ? " from starred" : " to find it again later"));
    };
    sync();
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleFavorite(item);
      sync();
      renderResultsList(); // keep the sidebar list in sync, if a search is open
    });
  }

  function addIncidentMarker(item) {
    const isBattle = item.kind === "battle";
    const marker = L.marker([item.lat, item.lon], { icon: isBattle ? battleIcon() : eventIcon() });
    const meta = [item.dateYear, formatDist(item.distKm) + " away"].filter(Boolean).join(" &middot; ");
    marker.bindPopup(
      `<div class="gw-popup-head">
         <p class="gw-popup-title">${escapeHtml(item.name)}</p>
         <button type="button" class="gw-popup-star" data-popup-star>&#9733;</button>
       </div>
       <p class="gw-popup-meta">${meta}</p>
       <a class="gw-popup-link" href="#" data-open-detail>Read the story &rarr;</a>`
    );
    marker.on("popupopen", (e) => {
      const el = e.popup.getElement();
      const link = el.querySelector("[data-open-detail]");
      if (link) link.addEventListener("click", (ev) => { ev.preventDefault(); openDetail(item); });
      wirePopupStar(el, item);
    });
    const markerLabel = `${item.name}, ${kindLabel(item.kind)}${item.dateYear ? ", " + item.dateYear : ""}`;
    marker.on("add", (e) => e.target.getElement()?.setAttribute("aria-label", markerLabel));
    marker.addTo(isBattle ? battleCluster : eventCluster);
    return marker;
  }

  function addFigureLayer(p) {
    const hasDeath = p.deathLat != null && p.deathLon != null;
    const birthMarker = L.marker([p.birthLat, p.birthLon], { icon: figureBirthIcon() });
    const lifespan = [p.dobYear, p.dodYear].filter(Boolean).join(" &ndash; ");
    const meta = [lifespan, formatDist(p.distKm) + " &middot; " + matchReason(p.matchKinds)]
      .filter(Boolean)
      .join(" &middot; ");
    const popupHtml = `<div class="gw-popup-head">
         <p class="gw-popup-title">${escapeHtml(p.name)}</p>
         <button type="button" class="gw-popup-star" data-popup-star>&#9733;</button>
       </div>
       <p class="gw-popup-meta">${meta}</p>
       <a class="gw-popup-link" href="#" data-open-detail>Read the story &rarr;</a>`;
    birthMarker.bindPopup(popupHtml);
    birthMarker.on("popupopen", (e) => {
      const el = e.popup.getElement();
      const link = el.querySelector("[data-open-detail]");
      if (link) link.addEventListener("click", (ev) => { ev.preventDefault(); openDetail(p); });
      wirePopupStar(el, p);
    });
    birthMarker.on("add", (e) => e.target.getElement()?.setAttribute("aria-label", `${p.name}, born here`));
    birthMarker.addTo(figureCluster);

    if (hasDeath && (p.deathLat !== p.birthLat || p.deathLon !== p.birthLon)) {
      const deathMarker = L.marker([p.deathLat, p.deathLon], { icon: figureDeathIcon() });
      deathMarker.bindPopup(popupHtml);
      deathMarker.on("popupopen", (e) => {
        const el = e.popup.getElement();
        const link = el.querySelector("[data-open-detail]");
        if (link) link.addEventListener("click", (ev) => { ev.preventDefault(); openDetail(p); });
        wirePopupStar(el, p);
      });
      deathMarker.on("add", (e) => e.target.getElement()?.setAttribute("aria-label", `${p.name}, died here`));
      deathMarker.addTo(figureCluster);

      L.polyline(
        [
          [p.birthLat, p.birthLon],
          [p.deathLat, p.deathLon],
        ],
        { color: "var(--figure)", weight: 2, dashArray: "2 7", opacity: 0.8 }
      ).addTo(figureLines);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------------------------------------------------------------
  // Rendering: sidebar list
  // ---------------------------------------------------------------------
  // The filtered + sorted list, exactly as shown in the sidebar — shared by
  // renderResultsList() (to build the DOM) and exportResults() (to build
  // the text file), so the two can never drift apart.
  function getVisibleResults() {
    let list = state.results;
    if (state.showStarredOnly) list = list.filter((item) => favorites.has(item.id));
    if (state.showTodayOnly) list = list.filter((item) => onThisDay(item));
    const q = state.filterText.trim().toLowerCase();
    if (q) list = list.filter((item) => item.name.toLowerCase().includes(q));

    return [...list].sort((a, b) => {
      if (state.sort === "name") return a.name.localeCompare(b.name);
      if (state.sort === "date-asc" || state.sort === "date-desc") {
        const ya = effectiveYear(a);
        const yb = effectiveYear(b);
        if (ya == null && yb == null) return 0;
        if (ya == null) return 1; // undated sinks to the bottom either way
        if (yb == null) return -1;
        return state.sort === "date-asc" ? ya - yb : yb - ya;
      }
      return a.distKm - b.distKm;
    });
  }

  function exportResults() {
    const items = getVisibleResults();
    if (!items.length) return;
    const place = state.center?.label || "this area";
    const eraLabel = eraSelect.options[eraSelect.selectedIndex]?.textContent || "All of history";
    const lines = items.map((item) => {
      const isFigure = item.kind === "figure";
      const when = isFigure
        ? [item.dobYear, item.dodYear].filter(Boolean).join("–") || "dates unknown"
        : item.dateYear || "date unknown";
      const link = item.wikiTitle ? `https://en.wikipedia.org/wiki/${encodeURIComponent(item.wikiTitle)}` : "";
      return `${item.name}: ${kindLabel(item.kind)}, ${when}, ${formatDist(item.distKm)}${link ? "\n" + link : ""}`;
    });
    const text = `Groundwar: ${place}\n${formatRadiusLabel(state.radiusKm)} radius · ${eraLabel}\nSaved ${new Date().toLocaleDateString()}\n\n${lines.join(
      "\n\n"
    )}\n`;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const slug = place.split(",")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "results";
    a.download = `groundwar-${slug}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderResultsList() {
    resultsList.innerHTML = "";
    const n = state.results.length;
    const place = state.center?.label ? state.center.label.split(",")[0] : "";
    sheetHandleSummary.textContent = n ? `${n} found near ${place}` : "Groundwar";

    const sorted = getVisibleResults();
    resultsExportBtn.hidden = !sorted.length;

    const stillLoading = state.pending.incidents || state.pending.figures;
    resultsTitle.textContent = !n
      ? stillLoading
        ? "Searching…"
        : "Nothing found here"
      : sorted.length === n
      ? `${n} found nearby`
      : `${sorted.length} of ${n} shown`;

    if (!sorted.length) {
      const li = document.createElement("li");
      li.className = "empty-note";
      li.textContent = !n
        ? stillLoading
          ? "Still digging…"
          : state.lastSearchFailed
          ? "Couldn't reach the history data service."
          : state.era !== "all" && (state.allIncidents.length || state.allFigures.length)
          ? "Nothing in that era here. Try widening the era, or a different place."
          : "Try a wider radius, or search a different place."
        : state.showStarredOnly
        ? "Nothing starred here yet. Tap the star on a result to save it."
        : state.showTodayOnly
        ? "Nothing here happened on this day in history. Try a different place."
        : "Nothing matches that filter.";
      if (!n && state.lastSearchFailed) {
        const retryBtn = document.createElement("button");
        retryBtn.type = "button";
        retryBtn.className = "retry-btn";
        retryBtn.textContent = "Try again";
        retryBtn.addEventListener("click", rerunIfReady);
        li.appendChild(document.createElement("br"));
        li.appendChild(retryBtn);
      }
      resultsList.appendChild(li);
      return;
    }

    for (const item of sorted) {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "result-item-row";

      const btn = document.createElement("button");
      const otd = onThisDay(item);
      btn.type = "button";
      btn.className = "result-item" + (otd ? " otd" : "");
      const isFigure = item.kind === "figure";
      const when = isFigure
        ? [item.dobYear, item.dodYear].filter(Boolean).join("–") || "dates unknown"
        : item.dateYear || "date unknown";
      const distPart = isFigure ? `${formatDist(item.distKm)} · ${matchReason(item.matchKinds)}` : formatDist(item.distKm);
      const badge = otd ? `<span class="otd-badge">&#9733; On this day</span>` : "";
      btn.innerHTML = `<span class="result-dot ${item.kind}"></span>
        <span class="result-text">
          <span class="result-name">${escapeHtml(item.name)}</span>
          <span class="result-meta">${when} &middot; ${distPart}</span>
          ${badge}
        </span>`;
      btn.addEventListener("click", () => {
        map.panTo([item.lat ?? item.birthLat, item.lon ?? item.birthLon]);
        openDetail(item);
      });

      const starred = favorites.has(item.id);
      const starBtn = document.createElement("button");
      starBtn.type = "button";
      starBtn.className = "star-btn" + (starred ? " starred" : "");
      starBtn.innerHTML = "&#9733;";
      starBtn.setAttribute("aria-pressed", String(starred));
      starBtn.setAttribute("aria-label", (starred ? "Remove " : "Star ") + item.name + (starred ? " from starred" : " to find it again later"));
      starBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(item);
        const nowStarred = favorites.has(item.id);
        if (state.showStarredOnly && !nowStarred) {
          renderResultsList();
          return;
        }
        starBtn.classList.toggle("starred", nowStarred);
        starBtn.setAttribute("aria-pressed", String(nowStarred));
        starBtn.setAttribute("aria-label", (nowStarred ? "Remove " : "Star ") + item.name + (nowStarred ? " from starred" : " to find it again later"));
      });

      row.appendChild(btn);
      row.appendChild(starBtn);
      li.appendChild(row);
      resultsList.appendChild(li);
    }
  }

  function updateMyListBadge() {
    const n = favorites.size;
    mylistCountEl.textContent = n ? ` (${n})` : "";
    mylistCountEl.hidden = !n;
  }

  // "My List" is independent of the current search: starring something in
  // Rome, then searching Tokyo, still shows the Rome item here — each row
  // is rendered from the saved snapshot, not from state.results.
  function renderMyList() {
    mylistItemsEl.innerHTML = "";
    const items = [...favorites.values()].reverse(); // most recently starred first
    mylistExportBtn.hidden = !items.length;
    mylistClearBtn.hidden = !items.length;

    if (!items.length) {
      const li = document.createElement("li");
      li.className = "empty-note";
      li.textContent = "Nothing starred yet. Tap the star on a battle, event or figure to save it here.";
      mylistItemsEl.appendChild(li);
      return;
    }

    for (const item of items) {
      const li = document.createElement("li");
      const row = document.createElement("div");
      row.className = "result-item-row";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "result-item";
      const isFigure = item.kind === "figure";
      const when = isFigure
        ? [item.dobYear, item.dodYear].filter(Boolean).join("–") || "dates unknown"
        : item.dateYear || "date unknown";
      btn.innerHTML = `<span class="result-dot ${item.kind}"></span>
        <span class="result-text">
          <span class="result-name">${escapeHtml(item.name)}</span>
          <span class="result-meta">${when}</span>
        </span>`;
      btn.addEventListener("click", () => {
        closeModal(mylistOverlay);
        if (map && item.lat != null && item.lon != null) map.panTo([item.lat, item.lon]);
        openDetail(item);
      });

      const starBtn = document.createElement("button");
      starBtn.type = "button";
      starBtn.className = "star-btn starred";
      starBtn.innerHTML = "&#9733;";
      starBtn.setAttribute("aria-label", "Remove " + item.name + " from starred");
      starBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(item);
        renderMyList();
        renderResultsList(); // keep the results list's stars in sync, if a search is open
      });

      row.appendChild(btn);
      row.appendChild(starBtn);
      li.appendChild(row);
      mylistItemsEl.appendChild(li);
    }
  }

  function exportMyList() {
    const items = [...favorites.values()].reverse();
    if (!items.length) return;
    const lines = items.map((item) => {
      const isFigure = item.kind === "figure";
      const when = isFigure
        ? [item.dobYear, item.dodYear].filter(Boolean).join("–") || "dates unknown"
        : item.dateYear || "date unknown";
      const link = item.wikiTitle ? `https://en.wikipedia.org/wiki/${encodeURIComponent(item.wikiTitle)}` : "";
      return `${item.name}: ${kindLabel(item.kind)}, ${when}${link ? "\n" + link : ""}`;
    });
    const text = `Groundwar: My List\nSaved ${new Date().toLocaleDateString()}\n\n${lines.join("\n\n")}\n`;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "groundwar-my-list.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------
  // Detail content (desktop: floating panel · mobile: inline in the sheet)
  // ---------------------------------------------------------------------
  async function buildDetailHtml(item) {
    const isFigure = item.kind === "figure";
    const isIncident = !isFigure;
    // Opened from "My List" rather than a live search, an item has no
    // distance to speak of — there's no search point to measure it from.
    const closePointLabel =
      item.distKm == null
        ? null
        : isIncident
        ? `This site is <strong>${formatDist(item.distKm)}</strong> from your search point.`
        : `${capitalize(matchReason(item.matchKinds))}, <strong>${formatDist(item.distKm)}</strong> from your search point${
            state.center?.label ? " (" + escapeHtml(state.center.label) + ")" : ""
          }.`;

    let summary = null;
    try {
      if (item.wikiTitle) summary = await fetchSummary(item.wikiTitle);
    } catch (e) {
      summary = null;
    }

    // A naive year subtraction is off by up to a year across the BCE/CE
    // boundary (there's no year 0) — not worth the extra complexity for a
    // casual "how long they lived" fact, so it's skipped whenever either
    // year is BCE (negative) rather than risk a confidently wrong number.
    const ageAtDeath =
      !isFigure || item.dobNum == null || item.dodNum == null || item.dobNum < 0 || item.dodNum < 0
        ? null
        : item.dodNum - item.dobNum;
    const ageNote = ageAtDeath != null && ageAtDeath >= 0 && ageAtDeath <= 130 ? ` · lived to ${ageAtDeath}` : "";
    const dates = isIncident
      ? item.dateYear || "Date unrecorded"
      : ([item.dobYear, item.dodYear].filter(Boolean).join(" – ") || "Dates unrecorded") + ageNote;

    const thumb = summary?.thumbnail?.source
      ? `<img class="detail-thumb" src="${escapeHtml(summary.thumbnail.source)}" alt="">`
      : "";
    const extract = summary?.extract
      ? `<p class="detail-extract">${escapeHtml(summary.extract)}</p>`
      : `<p class="detail-extract">No summary available for this one yet.</p>`;
    const link = item.wikiTitle
      ? `<a class="detail-link" href="https://en.wikipedia.org/wiki/${encodeURIComponent(item.wikiTitle)}" target="_blank" rel="noopener">Read the full article on Wikipedia &rarr;</a>`
      : "";

    const placeLine = isIncident
      ? ""
      : `<p class="detail-fact" style="margin-top:-2px">
          Born in ${escapeHtml(item.birthLabel || "an unrecorded place")}${
          item.deathLabel ? `, died in ${escapeHtml(item.deathLabel)}` : ""
        }.
        </p>`;

    const otdLine = onThisDay(item)
      ? `<p class="detail-fact otd">&#9733; ${onThisDayLabel(item)}</p>`
      : "";

    // Opened from a live search (not My List, which can span unrelated
    // places), cross-match against everything else already on screen that
    // shares a year — a free "what else happened then, nearby" without any
    // extra network round-trip, since it's all already in state.results.
    const myYears = item.distKm == null ? [] : relevantYears(item);
    const sameYearMatches = myYears.length
      ? state.results
          .filter((r) => r.id !== item.id && relevantYears(r).some((y) => myYears.includes(y)))
          .sort((a, b) => a.distKm - b.distKm)
          .slice(0, 6)
      : [];
    const sameYearHtml = sameYearMatches.length
      ? `<div class="detail-sameyear">
          <p class="detail-sameyear-label">Also from around this time, nearby</p>
          <ul class="detail-sameyear-list">
            ${sameYearMatches
              .map((r) => {
                const when =
                  r.kind === "figure" ? [r.dobYear, r.dodYear].filter(Boolean).join("–") : r.dateYear;
                return `<li><button type="button" class="detail-sameyear-item" data-sameyear-id="${escapeHtml(r.id)}">
                  <span class="result-dot ${r.kind}"></span>
                  <span class="detail-sameyear-name">${escapeHtml(r.name)}</span>
                  <span class="detail-sameyear-year">${escapeHtml(when || "")}</span>
                </button></li>`;
              })
              .join("")}
          </ul>
        </div>`
      : "";

    const isStarred = favorites.has(item.id);
    const starLine = `<button type="button" class="detail-star-btn${isStarred ? " starred" : ""}"
        data-star-toggle aria-pressed="${isStarred}">
        &#9733; <span class="detail-star-label">${isStarred ? "Starred" : "Star this"}</span>
      </button>`;
    const shareLine = `<button type="button" class="detail-share-btn" data-copy-link
        aria-label="${canNativeShare ? "Share" : "Copy"} a link straight to this ${item.kind === "figure" ? "figure" : item.kind}">
        ${LINK_ICON} <span class="detail-share-label">${canNativeShare ? "Share" : "Copy link"}</span>
      </button>`;

    return `
      <div class="detail-eyebrow-row">
        <p class="detail-eyebrow ${item.kind}">${kindLabel(item.kind)}</p>
        <div class="detail-actions">
          ${starLine}
          ${shareLine}
        </div>
      </div>
      <h3 class="detail-title">${escapeHtml(item.name)}</h3>
      <p class="detail-dates">${dates}</p>
      ${otdLine}
      ${thumb}
      ${placeLine}
      ${extract}
      ${closePointLabel ? `<p class="detail-fact">${closePointLabel}</p>` : ""}
      ${link}
      ${sameYearHtml}
    `;
  }

  // Entrance/exit motion for the detail panel and the About/My List/
  // Shortcuts/leave-confirm overlays, all of which just snapped open shut
  // via [hidden] before this: reveal flips off [hidden], forces a style
  // flush, then adds .is-visible so the CSS transition has a "before" state
  // to animate from; conceal reverses that and only sets [hidden] back on
  // once the transition has had time to finish, so closing never just
  // vanishes the element mid-fade. _hideTimer is cleared on reveal so a
  // quick close-then-reopen can't have the old timer hide it again after.
  function revealWithMotion(el) {
    if (el._hideTimer) {
      clearTimeout(el._hideTimer);
      el._hideTimer = null;
    }
    el.hidden = false;
    // Force a style flush between un-hiding and adding .is-visible, so the
    // browser commits the "closed" state before the "open" one instead of
    // collapsing both into a single frame with nothing to transition from.
    // Deliberately not requestAnimationFrame: rAF is throttled or skipped
    // entirely for an occluded/backgrounded tab, which would leave the
    // element stuck at opacity: 0 with no visible way to recover.
    void el.offsetHeight;
    el.classList.add("is-visible");
  }
  function concealWithMotion(el, duration = 220) {
    el.classList.remove("is-visible");
    if (el._hideTimer) clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.hidden = true;
      el._hideTimer = null;
    }, duration);
  }

  let currentDetailItem = null;
  let detailFetchToken = 0;
  // Remembers what had keyboard focus before the detail panel first opened,
  // so closing it (Escape, the close/back button) returns a keyboard or
  // screen-reader user to that same spot instead of dropping focus to
  // <body>. Deliberately NOT re-captured while the panel is already open —
  // a "same year" link inside it reopens openDetail() on a new item without
  // closing first, and that should still return to the original trigger
  // (the result-list item or map marker), not to the link just clicked.
  let focusBeforeDetail = null;
  async function openDetail(item) {
    currentDetailItem = item;
    const token = ++detailFetchToken;
    const loc = urlLocationFor(item);
    if (loc) updateUrl(loc.lat, loc.lon, loc.label, item.id);
    const loading = `<p class="detail-loading">Reading the record&hellip;</p>`;
    const isMobile = mobileMq.matches;
    const alreadyOpen = isMobile ? !mobileDetailView.hidden : !detailPanel.hidden;
    if (!alreadyOpen) focusBeforeDetail = document.activeElement;

    if (isMobile) {
      mobileDetailContent.innerHTML = loading;
      listView.hidden = true;
      mobileDetailView.hidden = false;
      if (sheetState === "peek") setSheetState("half");
      // Opening from a map marker (rather than the results list) would
      // otherwise leave the sheet scrolled to wherever it was, with the
      // new detail content sitting below the fold.
      mobileDetailView.scrollIntoView({ block: "start" });
      mobileDetailBack.focus({ preventScroll: true });
    } else {
      revealWithMotion(detailPanel);
      detailContent.innerHTML = loading;
      detailClose.focus();
    }

    const html = await buildDetailHtml(item);
    if (token !== detailFetchToken) return; // a newer openDetail() call already took over
    if (isMobile) mobileDetailContent.innerHTML = html;
    else detailContent.innerHTML = html;
  }

  function restoreFocusAfterDetail() {
    if (focusBeforeDetail && document.contains(focusBeforeDetail) && typeof focusBeforeDetail.focus === "function") {
      focusBeforeDetail.focus();
    }
    focusBeforeDetail = null;
  }

  function closeMobileDetail() {
    mobileDetailView.hidden = true;
    listView.hidden = false;
    listView.scrollIntoView({ block: "start" });
    currentDetailItem = null;
    if (state.center) updateUrl(state.center.lat, state.center.lon, state.center.label, null);
    restoreFocusAfterDetail();
  }

  function closeDetailPanel() {
    concealWithMotion(detailPanel);
    currentDetailItem = null;
    if (state.center) updateUrl(state.center.lat, state.center.lon, state.center.label, null);
    restoreFocusAfterDetail();
  }

  detailClose.addEventListener("click", closeDetailPanel);
  mobileDetailBack.addEventListener("click", () => openModal(leaveConfirmOverlay, leaveConfirmStay));
  leaveConfirmStay.addEventListener("click", () => closeModal(leaveConfirmOverlay));
  leaveConfirmLeave.addEventListener("click", () => {
    closeModal(leaveConfirmOverlay);
    closeMobileDetail();
  });
  leaveConfirmOverlay.addEventListener("click", (e) => {
    if (e.target === leaveConfirmOverlay) closeModal(leaveConfirmOverlay);
  });
  leaveConfirmOverlay.addEventListener("keydown", (e) => trapFocus(e, leaveConfirmOverlay));

  // ---------------------------------------------------------------------
  // Modal dialogs (About, My List): focus moves in on open, is trapped
  // inside while open (Tab can't escape to the page behind it), and is
  // restored to whatever opened the dialog on close.
  // ---------------------------------------------------------------------
  let focusBeforeModal = null;
  function openModal(overlay, initialFocusEl) {
    focusBeforeModal = document.activeElement;
    revealWithMotion(overlay);
    initialFocusEl.focus();
  }
  function closeModal(overlay) {
    concealWithMotion(overlay);
    if (focusBeforeModal && document.contains(focusBeforeModal) && typeof focusBeforeModal.focus === "function") {
      focusBeforeModal.focus();
    }
    focusBeforeModal = null;
  }
  function trapFocus(e, container) {
    if (e.key !== "Tab") return;
    const focusable = Array.from(
      container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!leaveConfirmOverlay.hidden) closeModal(leaveConfirmOverlay);
    else if (!shortcutsOverlay.hidden) closeModal(shortcutsOverlay);
    else if (!aboutOverlay.hidden) closeModal(aboutOverlay);
    else if (!mylistOverlay.hidden) closeModal(mylistOverlay);
    else if (!detailPanel.hidden) closeDetailPanel();
    else if (!mobileDetailView.hidden) closeMobileDetail();
  });

  // "/" focuses search, as in many list/search-first apps; "?" opens the
  // shortcuts cheatsheet — neither fires while typing into some other field.
  document.addEventListener("keydown", (e) => {
    if ((e.key !== "/" && e.key !== "?") || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target;
    const isTyping =
      el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
    if (isTyping) return;
    e.preventDefault();
    if (e.key === "/") {
      placeInput.focus();
      placeInput.select();
    } else {
      openModal(shortcutsOverlay, shortcutsClose);
    }
  });

  // The "About" link lives inside Leaflet's attribution control, built
  // after the map loads — event delegation avoids depending on that timing.
  // The detail panel's star button is delegated for the same reason: its
  // markup is injected via innerHTML, so it has no listener of its own.
  document.addEventListener("click", (e) => {
    if (e.target.id === "about-link") {
      e.preventDefault();
      openModal(aboutOverlay, aboutClose);
      return;
    }
    const starBtn = e.target.closest("[data-star-toggle]");
    if (starBtn && currentDetailItem) {
      e.preventDefault();
      toggleFavorite(currentDetailItem);
      const nowStarred = favorites.has(currentDetailItem.id);
      starBtn.classList.toggle("starred", nowStarred);
      starBtn.setAttribute("aria-pressed", String(nowStarred));
      const label = starBtn.querySelector(".detail-star-label");
      if (label) label.textContent = nowStarred ? "Starred" : "Star this";
      renderResultsList(); // keep the list's own star icons in sync
      return;
    }
    const shareBtn = e.target.closest("[data-copy-link]");
    if (shareBtn) {
      e.preventDefault();
      const shareLabel = shareBtn.querySelector(".detail-share-label");
      const revert = () => {
        if (shareLabel) shareLabel.textContent = canNativeShare ? "Share" : "Copy link";
      };
      shareCurrentLink(currentDetailItem ? `${currentDetailItem.name} · Groundwar` : undefined).then((result) => {
        if (result === "shared" || result === "cancelled") return; // the OS share sheet already gave feedback
        if (shareLabel) shareLabel.textContent = result === "copied" ? "Copied!" : "Copy failed";
        setTimeout(revert, 1800);
      });
      return;
    }
    const sameYearBtn = e.target.closest("[data-sameyear-id]");
    if (sameYearBtn) {
      e.preventDefault();
      const match = state.results.find((r) => r.id === sameYearBtn.dataset.sameyearId);
      if (match) {
        map.panTo([match.lat ?? match.birthLat, match.lon ?? match.birthLon]);
        openDetail(match);
      }
    }
  });
  aboutClose.addEventListener("click", () => closeModal(aboutOverlay));
  aboutOverlay.addEventListener("click", (e) => {
    if (e.target === aboutOverlay) closeModal(aboutOverlay);
  });
  aboutOverlay.addEventListener("keydown", (e) => trapFocus(e, aboutOverlay));

  shortcutsLink.addEventListener("click", () => {
    // Swap straight to the shortcuts dialog without re-capturing focus —
    // openModal already remembers what was focused before About opened,
    // and that's still the right place to return to once this closes too.
    aboutOverlay.hidden = true;
    aboutOverlay.classList.remove("is-visible");
    revealWithMotion(shortcutsOverlay);
    shortcutsClose.focus();
  });
  shortcutsClose.addEventListener("click", () => closeModal(shortcutsOverlay));
  shortcutsOverlay.addEventListener("click", (e) => {
    if (e.target === shortcutsOverlay) closeModal(shortcutsOverlay);
  });
  shortcutsOverlay.addEventListener("keydown", (e) => trapFocus(e, shortcutsOverlay));

  mylistBtn.addEventListener("click", () => {
    renderMyList();
    openModal(mylistOverlay, mylistClose);
  });
  mylistClose.addEventListener("click", () => closeModal(mylistOverlay));
  mylistOverlay.addEventListener("click", (e) => {
    if (e.target === mylistOverlay) closeModal(mylistOverlay);
  });
  mylistOverlay.addEventListener("keydown", (e) => trapFocus(e, mylistOverlay));
  mylistExportBtn.addEventListener("click", exportMyList);
  mylistClearBtn.addEventListener("click", () => {
    if (!favorites.size) return;
    if (!confirm("Clear your entire My List? This can't be undone.")) return;
    favorites.clear();
    saveFavorites();
    updateMyListBadge();
    renderMyList();
    renderResultsList(); // keep the results list's own star icons in sync
    // The detail panel bakes its star state into its markup on open rather
    // than re-reading favorites each render, so if it's showing a now-
    // unstarred item (desktop or mobile), update it in place too.
    document.querySelectorAll("[data-star-toggle].starred").forEach((btn) => {
      btn.classList.remove("starred");
      btn.setAttribute("aria-pressed", "false");
      const label = btn.querySelector(".detail-star-label");
      if (label) label.textContent = "Star this";
    });
  });
  resultsExportBtn.addEventListener("click", exportResults);

  // ---------------------------------------------------------------------
  // Mobile bottom sheet: drag-to-resize with three snap states
  // ---------------------------------------------------------------------
  let sheetState = "half";

  function sheetSnapPx() {
    const h = window.innerHeight;
    return { peek: 128, half: Math.round(h * 0.5), full: Math.round(h * 0.88) };
  }

  // What tapping/activating the handle does next from each state — peek and
  // half both expand further, full collapses back down. The label needs to
  // track this (not stay fixed at its HTML default) since it's wrong as
  // soon as the sheet leaves its starting state.
  const SHEET_HANDLE_LABEL = { peek: "Expand panel", half: "Expand panel fully", full: "Collapse panel" };

  function setSheetState(next) {
    sheetState = next;
    sidebarEl.classList.remove("state-peek", "state-half", "state-full");
    sidebarEl.classList.add("state-" + next);
    sidebarEl.style.setProperty("--sheet-h", sheetSnapPx()[next] + "px");
    sheetHandle.setAttribute("aria-label", SHEET_HANDLE_LABEL[next]);
    // Collapsing should always reveal the handle + search again, not
    // whatever the user had scrolled to while the sheet was taller.
    if (next === "peek") sidebarEl.scrollTop = 0;
  }

  let dragStartY = 0;
  let dragStartH = 0;
  let dragging = false;
  let dragMoved = false;

  sheetHandle.addEventListener("pointerdown", (e) => {
    if (!mobileMq.matches) return;
    dragging = true;
    dragMoved = false;
    dragStartY = e.clientY;
    dragStartH = sidebarEl.getBoundingClientRect().height;
    sidebarEl.classList.add("dragging");
    sheetHandle.setPointerCapture(e.pointerId);
  });
  sheetHandle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = dragStartY - e.clientY; // dragging up = taller sheet
    if (Math.abs(dy) > 4) dragMoved = true;
    const snaps = sheetSnapPx();
    const h = Math.max(snaps.peek, Math.min(snaps.full, dragStartH + dy));
    sidebarEl.style.setProperty("--sheet-h", h + "px");
  });
  function cycleSheetState() {
    const order = ["peek", "half", "full"];
    setSheetState(order[(order.indexOf(sheetState) + 1) % order.length]);
  }
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    sidebarEl.classList.remove("dragging");
    if (!dragMoved) {
      cycleSheetState();
      return;
    }
    const current = sidebarEl.getBoundingClientRect().height;
    const snaps = sheetSnapPx();
    let nearest = "peek";
    let best = Infinity;
    for (const name of Object.keys(snaps)) {
      const d = Math.abs(current - snaps[name]);
      if (d < best) {
        best = d;
        nearest = name;
      }
    }
    setSheetState(nearest);
  }
  sheetHandle.addEventListener("pointerup", endDrag);
  sheetHandle.addEventListener("pointercancel", endDrag);
  // The handle is a real <button>, but everything above listens for pointer
  // events only — Enter/Space on a focused button fires a "click" with no
  // matching pointerdown/pointerup, so a keyboard user got no response at
  // all. detail is 0 for a keyboard-/script-triggered click and >=1 for a
  // real pointer click, which lets this skip the cases endDrag() above
  // already handled (a real tap fires both a pointerup and a click).
  sheetHandle.addEventListener("click", (e) => {
    if (mobileMq.matches && e.detail === 0) cycleSheetState();
  });

  window.addEventListener("resize", () => {
    if (mobileMq.matches) setSheetState(sheetState);
  });

  // ---------------------------------------------------------------------
  // Sharing — native share sheet where the browser offers one (mainly
  // phones), clipboard otherwise. "cancelled" covers the visitor dismissing
  // the OS share sheet, which isn't a failure worth reporting.
  // ---------------------------------------------------------------------
  const canNativeShare = typeof navigator.share === "function";
  const LINK_ICON =
    '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 15.5 15.5 8.5"/><path d="M10.5 6.5a4 4 0 0 1 5.657 5.657l-1.414 1.414"/><path d="M13.5 17.5a4 4 0 0 1-5.657-5.657l1.414-1.414"/></svg>';

  async function shareCurrentLink(title) {
    const url = location.href;
    if (canNativeShare) {
      try {
        await navigator.share({ title: title || document.title, url });
        return "shared";
      } catch (e) {
        if (e && e.name === "AbortError") return "cancelled";
        // some other share failure — fall through and try the clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      return "copied";
    } catch (e) {
      return "failed";
    }
  }

  // ---------------------------------------------------------------------
  // Permalink + remembered location
  // ---------------------------------------------------------------------
  const STORAGE_KEY = "groundwar:lastSearch";
  const RECENTS_KEY = "groundwar:recentSearches";
  const MAX_RECENTS = 6;
  // Spans several continents, so a first-time visitor sees at a glance
  // that this isn't a UK-only (or even Western-only) tool.
  const DISCOVER_PLACES = [
    { lat: 51.5072, lon: -0.1276, label: "London" },
    { lat: 40.7128, lon: -74.006, label: "New York" },
    { lat: 48.8566, lon: 2.3522, label: "Paris" },
    { lat: 41.9028, lon: 12.4964, label: "Rome" },
    { lat: 35.6895, lon: 139.6917, label: "Tokyo" },
    { lat: -33.8688, lon: 151.2093, label: "Sydney" },
  ];

  // A wider, deliberately global pool for "Surprise me" — places with a
  // dense layer of recorded history, not just big modern cities.
  const SURPRISE_PLACES = [
    { lat: 51.5072, lon: -0.1276, label: "London" },
    { lat: 48.8566, lon: 2.3522, label: "Paris" },
    { lat: 41.9028, lon: 12.4964, label: "Rome" },
    { lat: 41.0082, lon: 28.9784, label: "Istanbul" },
    { lat: 30.0444, lon: 31.2357, label: "Cairo" },
    { lat: 31.7683, lon: 35.2137, label: "Jerusalem" },
    { lat: 28.6139, lon: 77.209, label: "Delhi" },
    { lat: 39.9042, lon: 116.4074, label: "Beijing" },
    { lat: 35.0116, lon: 135.7681, label: "Kyoto" },
    { lat: 55.7558, lon: 37.6173, label: "Moscow" },
    { lat: 59.3293, lon: 18.0686, label: "Stockholm" },
    { lat: 40.4168, lon: -3.7038, label: "Madrid" },
    { lat: 38.7223, lon: -9.1393, label: "Lisbon" },
    { lat: 52.52, lon: 13.405, label: "Berlin" },
    { lat: 50.0755, lon: 14.4378, label: "Prague" },
    { lat: 19.4326, lon: -99.1332, label: "Mexico City" },
    { lat: -13.1631, lon: -72.545, label: "Cusco" },
    { lat: -22.9068, lon: -43.1729, label: "Rio de Janeiro" },
    { lat: 40.7128, lon: -74.006, label: "New York" },
    { lat: -33.9249, lon: 18.4241, label: "Cape Town" },
    { lat: 9.082, lon: 8.6753, label: "Abuja" },
    { lat: -1.2921, lon: 36.8219, label: "Nairobi" },
    { lat: 35.6895, lon: 139.6917, label: "Tokyo" },
    { lat: 13.7563, lon: 100.5018, label: "Bangkok" },
    { lat: -33.8688, lon: 151.2093, label: "Sydney" },
    { lat: 64.1466, lon: -21.9426, label: "Reykjavik" },
  ];

  // Wikidata ids are full entity URIs (http://www.wikidata.org/entity/Q123);
  // the bare QID is all a shareable link needs.
  function qidOf(fullId) {
    return (fullId || "").split("/").pop();
  }

  function updateUrl(lat, lon, label, itemId) {
    try {
      const p = new URLSearchParams();
      p.set("lat", lat.toFixed(4));
      p.set("lon", lon.toFixed(4));
      if (label) p.set("label", label);
      p.set("r", String(state.radiusKm));
      p.set("fame", String(state.minSitelinks));
      p.set("u", state.units);
      p.set("era", state.era);
      p.set("scope", state.battleScope);
      if (itemId) p.set("item", qidOf(itemId));
      history.replaceState(null, "", "?" + p.toString());
    } catch (e) {
      // ignore — URL sync is a convenience, not required for the app to work
    }
  }

  // Whichever pin is currently open (if any) should stay part of the
  // shareable URL across in-place changes like switching era or units.
  function openDetailItem() {
    if (!currentDetailItem) return null;
    if (!detailPanel.hidden || !mobileDetailView.hidden) return currentDetailItem;
    return null;
  }

  // The (lat, lon, label) the URL should reflect. A My List item (no
  // distKm — it didn't come from the active search) has its own real
  // coordinates in its snapshot; pointing the URL at state.center instead
  // would silently share a link to the wrong place, one where this item
  // likely can't even be found again.
  function urlLocationFor(openItem) {
    if (openItem && openItem.distKm == null) {
      const lat = openItem.lat ?? openItem.birthLat;
      const lon = openItem.lon ?? openItem.birthLon;
      if (lat != null && lon != null) return { lat, lon, label: null };
    }
    return state.center ? { lat: state.center.lat, lon: state.center.lon, label: state.center.label } : null;
  }

  function saveLastSearch() {
    if (!state.center) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          lat: state.center.lat,
          lon: state.center.lon,
          label: state.center.label,
          radiusKm: state.radiusKm,
          minSitelinks: state.minSitelinks,
          units: state.units,
          era: state.era,
          battleScope: state.battleScope,
        })
      );
    } catch (e) {
      // private browsing / blocked storage — fine, just skip persistence
    }
  }

  function loadLastSearch() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // Recent searches: a quick way to hop back to a country you've already
  // explored without retyping it. Kept separate from "last search" above,
  // which is only about restoring where you left off.
  function loadRecents() {
    try {
      const raw = localStorage.getItem(RECENTS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function addToRecents(lat, lon, label) {
    try {
      let list = loadRecents();
      // Treat anything within ~1km as "the same place" so re-running a
      // search (radius/era/units changes) doesn't spam duplicate chips.
      list = list.filter((r) => haversineKm(r.lat, r.lon, lat, lon) > 1);
      list.unshift({ lat, lon, label });
      list = list.slice(0, MAX_RECENTS);
      localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
      renderRecentChips(list);
    } catch (e) {
      // private browsing / blocked storage — recents just won't persist
    }
  }

  function renderRecentChips(list) {
    list = list || loadRecents();
    const isDiscovery = list.length === 0;
    const items = isDiscovery ? DISCOVER_PLACES : list;

    chipsCaption.hidden = false;
    chipsCaption.innerHTML = "";
    chipsCaption.appendChild(document.createTextNode(isDiscovery ? "Jump to a place" : "Recent"));
    if (!isDiscovery) {
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "clear-recents-btn";
      clearBtn.textContent = "Clear";
      clearBtn.addEventListener("click", () => {
        if (!confirm("Clear your recent searches? This can't be undone.")) return;
        try {
          localStorage.removeItem(RECENTS_KEY);
        } catch (e) {
          // private browsing / blocked storage — nothing was persisted anyway
        }
        renderRecentChips([]);
      });
      chipsCaption.appendChild(clearBtn);
    }

    recentChips.innerHTML = "";
    recentChips.hidden = false;
    for (const r of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recent-chip";
      btn.textContent = shortLabel(r.label).split(",")[0];
      btn.title = shortLabel(r.label);
      btn.addEventListener("click", () => {
        placeInput.value = shortLabel(r.label);
        runSearch(r.lat, r.lon, shortLabel(r.label));
      });
      recentChips.appendChild(btn);
    }
  }

  function setUnitButtons(unit) {
    unitButtons.forEach((b) => b.classList.toggle("active", b.dataset.unit === unit));
    // The <option> values stay km (what the Wikidata query needs) — only
    // their visible label switches, so miles-preferring visitors aren't
    // stuck reading "25 km" and doing the conversion in their head.
    for (const opt of radiusSelect.options) {
      opt.textContent = formatRadiusLabel(Number(opt.value));
    }
  }

  // A toggle left checked but showing nothing (0) still reads as "no
  // battles here" useful information, so it's left visible — only an
  // unchecked toggle hides its count, since there's nothing fetched to count.
  function updateToggleCounts(incidents, figures) {
    const battleCount = incidents.filter((i) => i.kind === "battle").length;
    const eventCount = incidents.filter((i) => i.kind === "event").length;
    const loading = "· …";
    countBattles.textContent = !toggleBattles.checked ? "" : state.pending.incidents ? loading : `· ${battleCount}`;
    countEvents.textContent = !toggleEvents.checked ? "" : state.pending.incidents ? loading : `· ${eventCount}`;
    countFigures.textContent = !toggleFigures.checked ? "" : state.pending.figures ? loading : `· ${figures.length}`;
  }

  // A quick color key on the map itself — mainly for the mobile "peek"
  // state, where the sheet is collapsed to a handle and the checkboxes
  // (which already explain the colors) aren't on screen at all.
  function updateMapLegend() {
    mapLegendBattle.hidden = !toggleBattles.checked;
    mapLegendEvent.hidden = !toggleEvents.checked;
    mapLegendFigure.hidden = !toggleFigures.checked;
    mapLegend.hidden = !(toggleBattles.checked || toggleEvents.checked || toggleFigures.checked);
  }

  // Captured once, before any count suffix gets appended, so the base
  // wording (and its single source of truth, the HTML) never drifts.
  const ERA_BASE_LABELS = {};
  for (const opt of eraSelect.options) ERA_BASE_LABELS[opt.value] = opt.textContent;

  // Lets a visitor see where the interesting data actually is — e.g.
  // "Ancient (before 500) · 2" vs "Modern (1800–today) · 180" — before
  // clicking through each era one at a time. Pure client-side count against
  // whatever's already been fetched, no extra network cost.
  function updateEraCounts() {
    const pool = [...state.allIncidents, ...state.allFigures];
    // Mid-search the pool is partial, so a count would be misleading.
    const loading = state.pending.incidents || state.pending.figures;
    for (const opt of eraSelect.options) {
      if (loading) {
        opt.textContent = ERA_BASE_LABELS[opt.value];
        continue;
      }
      const count = opt.value === "all" ? pool.length : pool.filter((item) => inEraRange(item, opt.value)).length;
      opt.textContent = `${ERA_BASE_LABELS[opt.value]} · ${count}`;
    }
  }

  // ---------------------------------------------------------------------
  // Era filter — re-renders from the already-fetched data, no network
  // round-trip, so moving the Era select feels instant.
  // ---------------------------------------------------------------------
  function renderFiltered() {
    battleCluster.clearLayers();
    eventCluster.clearLayers();
    figureCluster.clearLayers();
    figureLines.clearLayers();

    const incidents = state.allIncidents.filter(inEra);
    const figures = state.allFigures.filter(inEra);

    incidents.forEach(addIncidentMarker);
    figures.forEach(addFigureLayer);
    labelOrphanClusters();

    state.results = [...incidents, ...figures];
    updateToggleCounts(incidents, figures);
    updateMapLegend();
    updateEraCounts();
    renderResultsList();

    // Lets a visitor with several searches open in tabs tell them apart at
    // a glance — kept in sync with era changes too, not just fresh
    // searches, since both land here.
    const place = state.center?.label ? state.center.label.split(",")[0] : "";
    document.title = place
      ? state.results.length
        ? `${state.results.length} near ${place} · Groundwar`
        : `${place} · Groundwar`
      : "Groundwar: history beneath your feet";
  }

  // ---------------------------------------------------------------------
  // Search orchestration
  // ---------------------------------------------------------------------
  async function runSearch(lat, lon, label, { isDemo = false } = {}) {
    const token = ++activeFetchToken;
    setHome(lat, lon, label);
    detailPanel.hidden = true;
    detailPanel.classList.remove("is-visible");
    mobileDetailView.hidden = true;
    currentDetailItem = null;
    listView.hidden = false;
    battleCluster.clearLayers();
    eventCluster.clearLayers();
    figureCluster.clearLayers();
    figureLines.clearLayers();
    resultsSpinner.hidden = false;
    locationStatus.textContent = `Digging around ${label || "this point"}…`;

    const radiusKm = state.radiusKm;
    const minSitelinks = state.minSitelinks;
    const wantBattles = toggleBattles.checked;
    const wantEvents = toggleEvents.checked;
    const wantFigures = toggleFigures.checked;

    // Start from a clean slate: each query below renders the moment it
    // lands, so leftovers from the previous place must not mix in.
    state.allIncidents = [];
    state.allFigures = [];
    state.lastSearchFailed = false;
    state.pending = { incidents: wantBattles || wantEvents, figures: wantFigures };
    renderFiltered();

    // Track real failures (network/service errors) separately from a
    // legitimately empty result, so the empty state can tell them apart.
    let anyQueryFailed = false;
    const safe = (p) => p.catch(() => { anyQueryFailed = true; return []; });
    const current = () => token === activeFetchToken;

    // All three queries run in parallel, and each one draws its results as
    // soon as it arrives instead of waiting for the slowest. The figures
    // queries (born-near / died-near) are usually the slow ones, so the
    // battles and events don't sit idle behind them.
    const incidentsJob =
      wantBattles || wantEvents
        ? safe(fetchIncidents(lat, lon, radiusKm, wantBattles ? state.battleScope : "none", wantEvents)).then((incidents) => {
            if (!current()) return;
            state.allIncidents = incidents;
            state.pending.incidents = false;
            renderFiltered();
          })
        : Promise.resolve();

    // Born and died each render on arrival too; the figures layer only
    // stops counting as pending once both are in.
    let bornRows = null,
      diedRows = null;
    const onFigures = () => {
      if (!current()) return;
      state.allFigures = dedupeFigures([...(bornRows || []), ...(diedRows || [])]);
      state.pending.figures = bornRows === null || diedRows === null;
      renderFiltered();
    };
    // Pre-built tiles first; if they can't be used, the two live queries
    // (born-near, died-near), each rendering on arrival.
    const liveFigures = () =>
      Promise.all([
        safe(sparqlQuery(figuresQuery(lat, lon, radiusKm, minSitelinks, "P19")).then((rows) => rowsToFigures(rows, "born"))).then(
          (rows) => {
            bornRows = rows;
            onFigures();
          }
        ),
        safe(sparqlQuery(figuresQuery(lat, lon, radiusKm, minSitelinks, "P20")).then((rows) => rowsToFigures(rows, "died"))).then(
          (rows) => {
            diedRows = rows;
            onFigures();
          }
        ),
      ]);
    const figuresJob = wantFigures
      ? figuresFromTiles(lat, lon, radiusKm, minSitelinks).then(
          ({ born, died }) => {
            bornRows = born;
            diedRows = died;
            onFigures();
          },
          (err) => {
            if (!current()) return;
            console.warn("Groundwar: figure tiles unavailable, querying Wikidata live instead.", err);
            return liveFigures();
          }
        )
      : Promise.resolve();

    // Busy modern cities with a wide radius can take several seconds —
    // let the visitor know this is still working, not stuck.
    const slowTimer = setTimeout(() => {
      if (current()) {
        locationStatus.textContent = `Still digging around ${label || "this point"}… busy areas can take a few seconds.`;
      }
    }, 6000);

    try {
      await Promise.all([incidentsJob, figuresJob]);
    } finally {
      clearTimeout(slowTimer);
    }

    if (!current()) return; // a newer search superseded this one

    state.lastSearchFailed = anyQueryFailed && state.allIncidents.length === 0 && state.allFigures.length === 0;
    // Everything is already drawn; only the empty state needs redoing, to
    // swap "nothing found" for "couldn't reach the service" + a retry.
    if (state.lastSearchFailed) renderFiltered();

    resultsSpinner.hidden = true;
    locationStatus.textContent = state.lastSearchFailed
      ? `Trouble reaching the history data for ${label || "this point"}.`
      : `Showing ${label || "this point"} · ${formatRadiusLabel(radiusKm)} radius.`;
    updateUrl(lat, lon, label);
    // The very first load for a brand-new visitor (no saved state, no
    // shared link) shows a demo view of London purely so the page isn't
    // empty at rest — it isn't something the visitor asked for, so it
    // shouldn't be remembered as their search or crowd out the discovery
    // chips with a single "London" entry.
    if (!isDemo) {
      saveLastSearch();
      addToRecents(lat, lon, label);
      maybeShowInstallBanner();
    }
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------
  function shortLabel(displayName) {
    return displayName.split(",").slice(0, 3).join(",");
  }

  function goToPlace(hit) {
    hideSuggestions();
    placeInput.value = shortLabel(hit.label);
    runSearch(hit.lat, hit.lon, shortLabel(hit.label));
  }

  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (suggestionActiveIndex >= 0 && currentSuggestions[suggestionActiveIndex]) {
      goToPlace(currentSuggestions[suggestionActiveIndex]);
      return;
    }
    const q = placeInput.value.trim();
    if (!q) return;
    locationStatus.textContent = "Looking up that place…";
    try {
      const hit = await geocode(q);
      if (!hit) {
        locationStatus.textContent = `Couldn't find "${q}". Try a more specific name.`;
        return;
      }
      goToPlace(hit);
    } catch (err) {
      locationStatus.textContent = "The place lookup failed. Try again in a moment.";
    }
  });

  // ---------------------------------------------------------------------
  // Location search autocomplete
  // ---------------------------------------------------------------------
  let currentSuggestions = [];
  let suggestionActiveIndex = -1;
  let suggestionTimer = null;
  let suggestionAbort = null;

  function hideSuggestions() {
    searchSuggestions.hidden = true;
    searchSuggestions.innerHTML = "";
    currentSuggestions = [];
    suggestionActiveIndex = -1;
    placeInput.setAttribute("aria-expanded", "false");
  }

  function renderSuggestions() {
    searchSuggestions.innerHTML = "";
    currentSuggestions.forEach((hit, i) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "suggestion-item" + (i === suggestionActiveIndex ? " active" : "");
      btn.textContent = shortLabel(hit.label);
      // mousedown (not click) fires before the input's blur, so the list
      // is still in the DOM when the selection is handled.
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        goToPlace(hit);
      });
      li.appendChild(btn);
      searchSuggestions.appendChild(li);
    });
    searchSuggestions.hidden = currentSuggestions.length === 0;
    placeInput.setAttribute("aria-expanded", String(currentSuggestions.length > 0));
  }

  placeInput.addEventListener("input", () => {
    const q = placeInput.value.trim();
    clearTimeout(suggestionTimer);
    if (q.length < 3) {
      hideSuggestions();
      return;
    }
    suggestionTimer = setTimeout(async () => {
      if (suggestionAbort) suggestionAbort.abort();
      suggestionAbort = new AbortController();
      try {
        const hits = await geocodeSuggestions(q, suggestionAbort.signal);
        currentSuggestions = hits;
        suggestionActiveIndex = -1;
        renderSuggestions();
      } catch (err) {
        // aborted or failed — leave whatever is currently shown
      }
    }, 350);
  });

  placeInput.addEventListener("keydown", (e) => {
    if (searchSuggestions.hidden) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      suggestionActiveIndex = Math.min(suggestionActiveIndex + 1, currentSuggestions.length - 1);
      renderSuggestions();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      suggestionActiveIndex = Math.max(suggestionActiveIndex - 1, -1);
      renderSuggestions();
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  placeInput.addEventListener("blur", () => {
    // Delay so a click/mousedown on a suggestion can still register first.
    setTimeout(hideSuggestions, 150);
  });

  locateBtn.addEventListener("click", () => {
    if (!window.isSecureContext) {
      // The Geolocation API is refused outright on plain http (other than
      // localhost) — this is the most likely real-world failure mode once
      // this page is hosted somewhere, so name it specifically rather than
      // letting it look like a permission problem.
      locationStatus.textContent = "Location needs this page served over https. Search a place instead.";
      return;
    }
    if (!navigator.geolocation) {
      locationStatus.textContent = "Your browser can't share a location. Try searching instead.";
      return;
    }
    locateBtn.disabled = true;
    locationStatus.textContent = "Asking your browser for your location…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locateBtn.disabled = false;
        runSearch(pos.coords.latitude, pos.coords.longitude, "your location");
      },
      (err) => {
        locateBtn.disabled = false;
        if (err.code === err.PERMISSION_DENIED) {
          locationStatus.textContent = "Location permission denied. Search a place instead.";
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          locationStatus.textContent = "Your location isn't available right now. Search a place instead.";
        } else {
          locationStatus.textContent = "Location request timed out. Search a place instead.";
        }
      },
      { timeout: 10000, maximumAge: 300000, enableHighAccuracy: false }
    );
  });

  if (canNativeShare) copyLinkBtn.innerHTML = `${LINK_ICON} Share this view`;

  copyLinkBtn.addEventListener("click", async () => {
    const original = copyLinkBtn.innerHTML;
    const revert = () => {
      copyLinkBtn.innerHTML = original;
    };
    const result = await shareCurrentLink(state.center?.label ? `Groundwar: ${state.center.label}` : undefined);
    if (result === "shared" || result === "cancelled") return; // the OS share sheet already gave feedback
    if (result === "copied") {
      copyLinkBtn.textContent = "✓ Link copied";
    } else {
      // Clipboard API unavailable (older browser, blocked permission) —
      // the URL bar is already kept in sync, so point there instead.
      copyLinkBtn.textContent = "Copy the address bar instead";
    }
    setTimeout(revert, 2000);
  });

  searchAreaBtn.addEventListener("click", async () => {
    const c = map.getCenter();
    searchAreaBtn.hidden = true;
    let label = "this area";
    try {
      const name = await reverseGeocode(c.lat, c.lng);
      if (name) label = shortLabel(name);
    } catch (e) {
      // reverse lookup failed — "this area" is still a fine label
    }
    placeInput.value = label;
    runSearch(c.lat, c.lng, label);
  });

  // In-memory only (not persisted) — just enough to stop repeat clicks
  // from cycling back through the same handful of places too soon. Resets
  // naturally on reload, which is fine; it's a freshness nicety, not a
  // preference worth remembering.
  const recentSurprises = [];
  const SURPRISE_MEMORY = 15; // a little over half the pool, so there's still real variety left

  surpriseBtn.addEventListener("click", () => {
    // Avoid landing right back where the visitor already is.
    let pool = SURPRISE_PLACES;
    if (state.center) {
      const filtered = pool.filter((p) => haversineKm(p.lat, p.lon, state.center.lat, state.center.lon) > 50);
      if (filtered.length) pool = filtered;
    }
    if (recentSurprises.length) {
      const fresh = pool.filter((p) => !recentSurprises.includes(p.label));
      if (fresh.length) pool = fresh;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    recentSurprises.push(pick.label);
    if (recentSurprises.length > SURPRISE_MEMORY) recentSurprises.shift();
    placeInput.value = pick.label;
    runSearch(pick.lat, pick.lon, pick.label);
  });

  function rerunIfReady() {
    if (state.center) runSearch(state.center.lat, state.center.lon, state.center.label);
  }
  radiusSelect.addEventListener("change", () => {
    state.radiusKm = Number(radiusSelect.value);
    rerunIfReady();
  });
  fameSelect.addEventListener("change", () => {
    state.minSitelinks = Number(fameSelect.value);
    rerunIfReady();
  });
  // Hide/show a count immediately on click, rather than waiting out a
  // refetch that can take several seconds in a busy city.
  function onLayerToggleChange() {
    updateToggleCounts(state.results.filter((r) => r.kind !== "figure"), state.results.filter((r) => r.kind === "figure"));
    updateMapLegend();
    battleScopeRow.hidden = !toggleBattles.checked;
    rerunIfReady();
  }
  toggleBattles.addEventListener("change", onLayerToggleChange);
  function setBattleScope(scope) {
    state.battleScope = scope;
    scopeButtons.forEach((b) => b.classList.toggle("active", b.dataset.scope === scope));
  }
  scopeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.scope === state.battleScope) return;
      setBattleScope(btn.dataset.scope);
      saveLastSearch();
      rerunIfReady();
    });
  });
  toggleEvents.addEventListener("change", onLayerToggleChange);
  toggleFigures.addEventListener("change", onLayerToggleChange);

  eraSelect.addEventListener("change", () => {
    state.era = eraSelect.value;
    renderFiltered();
    saveLastSearch();
    const openItem = openDetailItem();
    const loc = urlLocationFor(openItem);
    if (loc) updateUrl(loc.lat, loc.lon, loc.label, openItem?.id);
  });

  unitButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.unit === state.units) return;
      state.units = btn.dataset.unit;
      setUnitButtons(state.units);
      renderResultsList();
      saveLastSearch();
      const openItem = openDetailItem();
      const loc = urlLocationFor(openItem);
      if (loc) updateUrl(loc.lat, loc.lon, loc.label, openItem?.id);
      // The status line's radius figure is baked in as text at search
      // time — refresh it now so switching units doesn't leave a stale
      // "km"/"mi" showing until the next search.
      if (state.center && !state.lastSearchFailed) {
        locationStatus.textContent = `Showing ${state.center.label || "this point"} · ${formatRadiusLabel(state.radiusKm)} radius.`;
      }
    });
  });

  // Sorting, the quick text filter and "starred only" are all purely
  // client-side — same re-render-from-cache approach as the era filter.
  let filterDebounce;
  resultsFilterInput.addEventListener("input", () => {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(() => {
      state.filterText = resultsFilterInput.value;
      renderResultsList();
    }, 120);
  });
  sortSelect.addEventListener("change", () => {
    state.sort = sortSelect.value;
    renderResultsList();
  });
  starredToggleBtn.addEventListener("click", () => {
    state.showStarredOnly = !state.showStarredOnly;
    starredToggleBtn.classList.toggle("active", state.showStarredOnly);
    starredToggleBtn.setAttribute("aria-pressed", String(state.showStarredOnly));
    renderResultsList();
  });
  otdToggleBtn.addEventListener("click", () => {
    state.showTodayOnly = !state.showTodayOnly;
    otdToggleBtn.classList.toggle("active", state.showTodayOnly);
    otdToggleBtn.setAttribute("aria-pressed", String(state.showTodayOnly));
    renderResultsList();
  });

  // Arrow-key roving focus within a results list: with 150+ items in a
  // busy city, Tab-ing through one at a time (star button included) is far
  // too slow — Up/Down hops between item buttons directly, Home/End jumps
  // to the ends. A single delegated listener on the stable container
  // survives renderResultsList()/renderMyList() wiping and rebuilding the
  // buttons inside it.
  function wireListKeyboardNav(container) {
    container.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      const current = e.target.closest(".result-item");
      if (!current) return;
      const items = Array.from(container.querySelectorAll(".result-item"));
      const idx = items.indexOf(current);
      if (idx === -1) return;
      let nextIdx = idx;
      if (e.key === "ArrowDown") nextIdx = Math.min(idx + 1, items.length - 1);
      else if (e.key === "ArrowUp") nextIdx = Math.max(idx - 1, 0);
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = items.length - 1;
      if (nextIdx === idx) return;
      e.preventDefault();
      items[nextIdx].focus();
      items[nextIdx].scrollIntoView({ block: "nearest" });
    });
  }
  wireListKeyboardNav(resultsList);
  wireListKeyboardNav(mylistItemsEl);

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  let startupHidden = false;
  // Fires once the very first search (demo or real) has rendered, or after
  // STARTUP_TIMEOUT_MS regardless — a safety net against ever leaving a
  // visitor staring at the startup screen if something hangs. Also where
  // the "startup measure" lives: local-only, console-logged, never sent
  // anywhere (consistent with privacy.html's no-tracking promise about the
  // app itself — the ad network below is the one documented exception).
  function hideStartupScreen() {
    if (startupHidden) return;
    startupHidden = true;
    try {
      performance.mark("groundwar-ready");
      performance.measure("groundwar-startup", "groundwar-script-start", "groundwar-ready");
      const measure = performance.getEntriesByName("groundwar-startup")[0];
      if (measure) console.log(`[Groundwar] Ready in ${Math.round(measure.duration)}ms`);
    } catch (e) {
      // Performance API unavailable — the measurement is a nice-to-have, not required
    }
    startupScreen.classList.add("startup-hide");
    setTimeout(() => {
      startupScreen.hidden = true;
    }, 350); // matches the CSS opacity transition, so it's fully gone (not just invisible) once it ends
  }
  // Headroom against a true hang, not a slow-but-working query. Raised from
  // an original 10s after a live 50km London search genuinely took ~18-25s.
  // The default radius below was narrowed from 50km to 25km specifically to
  // pull typical load times back down; left at 25s rather than re-tuning
  // immediately, since there's no live data yet for the new 25km default.
  const STARTUP_TIMEOUT_MS = 25000;
  setTimeout(hideStartupScreen, STARTUP_TIMEOUT_MS);

  // ---------------------------------------------------------------------
  // "Install this" banner: shown only after someone's done a real search
  // (not the automatic London demo) or starred something — never on
  // arrival. Chrome/Android get the browser's own install prompt, captured
  // here and fired on demand; iOS has no such API at all, so it gets a
  // one-line Safari-only instruction instead. Dismissing it, either way,
  // is remembered forever — it never asks twice.
  // ---------------------------------------------------------------------
  const INSTALL_DISMISSED_KEY = "groundwar:installBannerDismissed";
  let deferredInstallPrompt = null;
  let installBannerShown = false;
  const isStandaloneDisplay =
    window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  function maybeShowInstallBanner() {
    if (installBannerShown || isStandaloneDisplay) return;
    if (!isIOS && !deferredInstallPrompt) return; // Android/Chrome: nothing to offer yet
    try {
      if (localStorage.getItem(INSTALL_DISMISSED_KEY)) return;
    } catch (e) {
      return; // can't remember a dismissal reliably — safest to just stay quiet
    }
    installBannerShown = true;
    installBannerText.textContent = isIOS
      ? "Open this in Safari, then tap Share → Add to Home Screen, to install Groundwar."
      : "Install Groundwar for quick access from your home screen.";
    installBannerInstallBtn.hidden = isIOS;
    installBanner.hidden = false;
  }
  function dismissInstallBanner() {
    installBanner.hidden = true;
    try {
      localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
    } catch (e) {
      // private browsing / blocked storage — it'll just offer again next visit
    }
  }
  installBannerInstallBtn.addEventListener("click", () => {
    if (!deferredInstallPrompt) return;
    dismissInstallBanner();
    deferredInstallPrompt.prompt();
    deferredInstallPrompt = null;
  });
  installBannerDismissBtn.addEventListener("click", dismissInstallBanner);

  function boot() {
    initMap();
    setSheetState("half");
    renderRecentChips();

    const urlParams = new URLSearchParams(location.search);
    let start = null;
    let pendingItemQid = null;

    if (urlParams.has("lat") && urlParams.has("lon")) {
      start = {
        lat: parseFloat(urlParams.get("lat")),
        lon: parseFloat(urlParams.get("lon")),
        label: urlParams.get("label") || "this point",
      };
      pendingItemQid = urlParams.get("item") || null;
      if (urlParams.has("r")) {
        state.radiusKm = Number(urlParams.get("r"));
        radiusSelect.value = String(state.radiusKm);
      }
      if (urlParams.has("fame")) {
        state.minSitelinks = Number(urlParams.get("fame"));
        fameSelect.value = String(state.minSitelinks);
      }
      if (urlParams.get("u") === "mi" || urlParams.get("u") === "km") {
        state.units = urlParams.get("u");
        setUnitButtons(state.units);
      }
      if (urlParams.get("era") in ERA_PRESETS || urlParams.get("era") === "all") {
        state.era = urlParams.get("era");
        eraSelect.value = state.era;
      }
      const urlScope = urlParams.get("scope");
      if (urlScope === "wars" || urlScope === "both" || urlScope === "operations") setBattleScope(urlScope);
    } else {
      const last = loadLastSearch();
      if (last && Number.isFinite(last.lat) && Number.isFinite(last.lon)) {
        start = { lat: last.lat, lon: last.lon, label: last.label };
        state.radiusKm = last.radiusKm || state.radiusKm;
        radiusSelect.value = String(state.radiusKm);
        state.minSitelinks = last.minSitelinks ?? state.minSitelinks;
        fameSelect.value = String(state.minSitelinks);
        state.units = last.units === "mi" ? "mi" : "km";
        setUnitButtons(state.units);
        if (last.era in ERA_PRESETS || last.era === "all") {
          state.era = last.era;
          eraSelect.value = state.era;
        }
        if (last.battleScope === "wars" || last.battleScope === "both" || last.battleScope === "operations") {
          setBattleScope(last.battleScope);
        }
      }
    }

    const searchDone = start
      ? runSearch(start.lat, start.lon, start.label)
      : runSearch(DEFAULT_CENTER.lat, DEFAULT_CENTER.lon, DEFAULT_CENTER.label, { isDemo: true });
    searchDone.then(hideStartupScreen);

    // A shared link to a specific pin: once the area's data is in, find
    // that item among the results and open it straight away.
    if (pendingItemQid) {
      searchDone.then(() => {
        const match = state.results.find((r) => qidOf(r.id) === pendingItemQid);
        if (match) openDetail(match);
      });
    }
  }
  boot();

  // The <ins class="adsbygoogle"> unit in index.html is static HTML already
  // in the DOM, so this doesn't need to wait on boot()/search state — it
  // just asks the (placeholder, inert until a real AdSense account is
  // wired up — see <head>) loader script to fill that slot.
  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch (e) {
    // Ad blocker, offline, or AdSense script failed to load — the rest of
    // the app must never depend on this succeeding.
  }

  // Registered after load so it never competes with the page's own first
  // fetches — makes the app shell installable/openable offline, and is
  // what real app-store packaging (Android Trusted Web Activity) checks
  // for. The data itself (Wikidata, Wikipedia, map tiles, …) still needs
  // a connection regardless.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {
        // Not fatal — the app works the same without it, just without the
        // offline-shell benefit (e.g. blocked storage, unsupported browser).
      });
    });
  }
})();
