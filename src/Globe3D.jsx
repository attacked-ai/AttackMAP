// ─────────────────────────────────────────────────────────────────────────
// Globe3D — the GLOBE view, rendered with CesiumJS as a photorealistic
// Google-Earth-style satellite globe (ArcGIS World Imagery + sky atmosphere +
// ground haze + fog + HDR). Cesium is loaded from a CDN via <script> tags in
// index.html (window.Cesium), so it needs no local npm install.
//
// Drop-in for the previous globe: same props (visibleIncidents / selectedId /
// onSelect). Incidents render as severity-coloured points; clicking one calls
// onSelect(incident._id) → opens the existing GUARD incident card. No extra
// chrome — the map's HUD, Flat/Globe toggle and RISK LEVEL legend are intact.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from "react";

// Severity → point colour (mirrors GlobalAttackMap's SEVERITY scale, 1–5).
const SEV_COLOR = {
  5: "#FF3B30", // CRITICAL
  4: "#FF6B35", // HIGH
  3: "#FCBD00", // MEDIUM
  2: "#34C759", // LOW
  1: "#8E8E93", // MINIMAL
};

// ── Incident markers ───────────────────────────────────────────────────────
// Until 2026-10-27 markers were canvas billboards (a reticle with a 3 px core).
// On the live globe they did not show at all — billboards clamped to the
// ground were hidden under the imagery — and even where they drew, a 3 px core
// was lost against the satellite texture (owner: "dot is not properly
// visible"). They are now Cesium points, which always draw: a solid
// severity-coloured core with a white rim, over a soft halo of the same
// colour, so a dot reads on desert, ocean and night imagery alike. Bigger for
// worse severities; CRITICAL also pulses.
const CORE_PX = { 5: 18, 4: 16, 3: 14, 2: 12, 1: 12 };
const HALO_PX = 2.6;       // halo diameter = core × this
// Points keep a readable size from the whole-globe view down to city level.
const markerScale = (Cesium) => new Cesium.NearFarScalar(1.5e6, 1.15, 4.0e7, 1.0);
// Points are depth-tested against the globe, but a dot just past the horizon
// lands partly outside the globe's disc, where there is only sky to test
// against, so half of it showed against space at the edge of the globe. Each
// marker therefore shows only while it faces the camera by a small margin
// (the cosine between the ground's "up" and the line to the camera above
// HORIZON_MARGIN), read from the current camera on every evaluation. In 2D
// and while morphing everything shows. The cost is a few multiplications per
// point per frame; PointVisualizer reads every point property each frame anyway.
const HORIZON_MARGIN = 0.12;
const _toCam = { x: 0, y: 0, z: 0 };
const onNearSide = (viewer, p) => {
  const Cesium = window.Cesium;
  if (!Cesium || viewer.scene.mode !== Cesium.SceneMode.SCENE3D) return true;
  const c = viewer.camera.positionWC;
  _toCam.x = c.x - p.x; _toCam.y = c.y - p.y; _toCam.z = c.z - p.z;
  const lc = Math.hypot(_toCam.x, _toCam.y, _toCam.z), lp = Math.hypot(p.x, p.y, p.z);
  if (!lc || !lp) return true;
  return (p.x * _toCam.x + p.y * _toCam.y + p.z * _toCam.z) / (lc * lp) > HORIZON_MARGIN;
};

// Longitude roughly under the user's local timezone (UTC offset × 15°/hour).
// The globe opens over the user's part of the world, so its day/night state
// always matches the laptop's local time (day hours → lit, night → dark).
const LOCAL_LON = Math.max(-180, Math.min(180, (-new Date().getTimezoneOffset() / 60) * 15));

const ARCGIS_WORLD_IMAGERY =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const ARCGIS_LABELS =
  "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer";

// ISO-2 code → country name (Natural-Earth-friendly, so it bridges to the
// world-atlas polygon `properties.name` via the token/substring matcher).
// `inc.country` in the data is mixed: sometimes a code ("BE","CN","KR"),
// sometimes a full name ("Belgium","China") — this normalises the codes.
const ISO2_NAME = {
  US: "United States", GB: "United Kingdom", KR: "South Korea", KP: "North Korea",
  RU: "Russia", CN: "China", JP: "Japan", IN: "India", DE: "Germany", FR: "France",
  IT: "Italy", ES: "Spain", PT: "Portugal", NL: "Netherlands", BE: "Belgium",
  LU: "Luxembourg", IE: "Ireland", CH: "Switzerland", AT: "Austria", SE: "Sweden",
  NO: "Norway", FI: "Finland", DK: "Denmark", IS: "Iceland", PL: "Poland",
  CZ: "Czechia", SK: "Slovakia", HU: "Hungary", RO: "Romania", BG: "Bulgaria",
  GR: "Greece", HR: "Croatia", SI: "Slovenia", RS: "Serbia", BA: "Bosnia and Herz.",
  ME: "Montenegro", MK: "North Macedonia", AL: "Albania", UA: "Ukraine", BY: "Belarus",
  MD: "Moldova", LT: "Lithuania", LV: "Latvia", EE: "Estonia", TR: "Turkey",
  CY: "Cyprus", MT: "Malta", CA: "Canada", MX: "Mexico", BR: "Brazil", AR: "Argentina",
  CL: "Chile", CO: "Colombia", PE: "Peru", VE: "Venezuela", EC: "Ecuador",
  BO: "Bolivia", PY: "Paraguay", UY: "Uruguay", CR: "Costa Rica", PA: "Panama",
  GT: "Guatemala", HN: "Honduras", NI: "Nicaragua", SV: "El Salvador", DO: "Dominican Rep.",
  CU: "Cuba", JM: "Jamaica", HT: "Haiti", AU: "Australia", NZ: "New Zealand",
  ID: "Indonesia", MY: "Malaysia", SG: "Singapore", TH: "Thailand", VN: "Vietnam",
  PH: "Philippines", KH: "Cambodia", LA: "Laos", MM: "Myanmar", BD: "Bangladesh",
  PK: "Pakistan", LK: "Sri Lanka", NP: "Nepal", BT: "Bhutan", BN: "Brunei",
  TW: "Taiwan", HK: "Hong Kong", MN: "Mongolia", KZ: "Kazakhstan", UZ: "Uzbekistan",
  TM: "Turkmenistan", KG: "Kyrgyzstan", TJ: "Tajikistan", AF: "Afghanistan", IR: "Iran",
  IQ: "Iraq", SY: "Syria", LB: "Lebanon", JO: "Jordan", IL: "Israel", PS: "Palestine",
  SA: "Saudi Arabia", AE: "United Arab Emirates", QA: "Qatar", KW: "Kuwait", BH: "Bahrain",
  OM: "Oman", YE: "Yemen", GE: "Georgia", AM: "Armenia", AZ: "Azerbaijan",
  EG: "Egypt", LY: "Libya", TN: "Tunisia", DZ: "Algeria", MA: "Morocco", SD: "Sudan",
  SS: "S. Sudan", ET: "Ethiopia", ER: "Eritrea", SO: "Somalia", KE: "Kenya",
  UG: "Uganda", TZ: "Tanzania", RW: "Rwanda", BI: "Burundi", CD: "Dem. Rep. Congo",
  CG: "Congo", GA: "Gabon", CM: "Cameroon", NG: "Nigeria", GH: "Ghana", CI: "Côte d'Ivoire",
  SN: "Senegal", ML: "Mali", BF: "Burkina Faso", NE: "Niger", TD: "Chad", MR: "Mauritania",
  ZA: "South Africa", NA: "Namibia", BW: "Botswana", ZW: "Zimbabwe", ZM: "Zambia",
  MZ: "Mozambique", AO: "Angola", MW: "Malawi", MG: "Madagascar", MU: "Mauritius",
};

function resolveCountryName(v) {
  if (!v) return v;
  const up = String(v).trim().toUpperCase();
  if (up.length === 2 && ISO2_NAME[up]) return ISO2_NAME[up];
  return String(v);
}

// ── FLAT view = the SAME Cesium viewer in SCENE2D ─────────────────────────
// One viewer, two scene modes: the globe morphs into a flat Web-Mercator map
// and back, so both views share the satellite imagery, the incident markers,
// the highlights, the blast radius and the click/hover handling. Three things
// make the flat map behave like a map instead of a camera looking at a plane:
//   • MapMode2D.ROTATE at construction — the default (INFINITE_SCROLL) repeats
//     the world east-west forever, which is the "scrollable map out of the
//     frame left and right" that made the earlier Cesium flat attempt unusable.
//     (The old value here, MapMode2D.CLAMP, does not exist in Cesium, so it
//     silently fell back to infinite scroll.)
//   • GeographicProjection (equirectangular) — the world is twice as wide as it
//     is tall, the shape every website world map has, so it FILLS a landscape
//     screen edge to edge. Web Mercator was tried first: it makes the world a
//     square, which on a wide screen sat in the middle like a card with black
//     bars either side. Cesium reprojects the (Mercator) ArcGIS tiles on the
//     GPU, exactly as it already does on the globe.
//   • clamp2D() every frame — the camera can never pan or zoom the world out
//     of the viewport: it re-centres when the view is wider than the world and
//     stops at the edges otherwise.
const FLAT_LAT_LIMIT = 90;   // equirectangular runs pole to pole
const FLAT_MIN_HALF_WIDTH = 350;   // metres — street level, same as the globe's 250 m floor

// Half-extent of the projected world, in the 2D scene's metres.
function worldHalfExtent2D(viewer) {
  const Cesium = window.Cesium;
  const p = viewer.scene.mapProjection.project(new Cesium.Cartographic(Math.PI, Cesium.Math.toRadians(FLAT_LAT_LIMIT)));
  return { x: Math.abs(p.x), y: Math.abs(p.y) };
}

// Widest the flat view may zoom out: the world's full WIDTH fills the
// viewport. On a landscape screen wider than 2:1 that crops only the polar
// caps (a 16:9 screen still shows ±80°); on a tall screen the map is shorter
// than the viewport and sits centred. Either way the map is never a small
// square in the middle of a black frame.
function flatMaxHalfWidth(viewer) {
  return worldHalfExtent2D(viewer).x;
}

// Keep the 2D camera inside the world. Runs on scene.preRender.
function clamp2D(viewer) {
  const Cesium = window.Cesium;
  const scene = viewer.scene;
  if (scene.mode !== Cesium.SceneMode.SCENE2D) return;
  const cam = viewer.camera;
  const f = cam.frustum;
  if (!Cesium.defined(f.left) || !Cesium.defined(f.top)) return;   // not the 2D orthographic frustum yet
  const halfW = (f.right - f.left) / 2;
  const halfH = (f.top - f.bottom) / 2;
  const { x: maxX, y: maxY } = worldHalfExtent2D(viewer);
  let x = cam.position.x, y = cam.position.y, moved = false;
  if (halfW >= maxX) { if (x !== 0) { x = 0; moved = true; } }
  else { const lim = maxX - halfW; if (x > lim) { x = lim; moved = true; } else if (x < -lim) { x = -lim; moved = true; } }
  if (halfH >= maxY) { if (y !== 0) { y = 0; moved = true; } }
  else { const lim = maxY - halfH; if (y > lim) { y = lim; moved = true; } else if (y < -lim) { y = -lim; moved = true; } }
  if (moved) { cam.position.x = x; cam.position.y = y; }
}

// Set the 2D view's half WIDTH directly, keeping the canvas aspect. This is
// what Cesium's own 2D zoomIn/zoomOut do to the frustum, minus one trap: on a
// canvas taller than wide they apply the amount to the VERTICAL extent, so a
// width-based amount came out height/width times too small and a portrait
// phone's flat world was left at ~55-67% of the width.
function setFlatHalfWidth(cam, halfW) {
  const f = cam.frustum;
  const ratio = f.top / f.right;
  f.right = halfW;
  f.left = -halfW;
  f.top = halfW * ratio;
  f.bottom = -f.top;
}

// Frame the whole world, centred and filling the viewport's width, in the
// flat view. setView() with a rectangle CONTAINS it (bars on one axis), so the
// frustum is then widened or narrowed to the exact world width.
function frameFlatWorld(viewer) {
  const Cesium = window.Cesium;
  const cam = viewer.camera;
  cam.setView({ destination: Cesium.Rectangle.fromDegrees(-180, -FLAT_LAT_LIMIT, 180, FLAT_LAT_LIMIT) });
  const f = cam.frustum;
  if (Cesium.defined(f.left) && f.right > 0 && f.top > 0) setFlatHalfWidth(cam, flatMaxHalfWidth(viewer));
  clamp2D(viewer);
  viewer.scene.requestRender();
}

// The globe's home framing (over the reader's part of the world).
function flyHome3D(viewer, duration = 1.1) {
  const Cesium = window.Cesium;
  viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(LOCAL_LON, 15, 24000000), duration });
}

// Per-mode look and controls. Flat: evenly lit like a map (no terminator, no
// fog, no ground haze), pan + zoom only (no twist, so north stays up). Globe:
// the photoreal treatment and free rotation.
function applySceneStyle(viewer) {
  const Cesium = window.Cesium;
  const scene = viewer.scene;
  const flat = scene.mode === Cesium.SceneMode.SCENE2D;
  scene.globe.enableLighting = !flat;
  scene.fog.enabled = !flat;
  scene.globe.showGroundAtmosphere = !flat;
  const cc = scene.screenSpaceCameraController;
  cc.enableInputs = true;
  cc.enableTranslate = true;
  cc.enableZoom = true;
  cc.enableRotate = !flat;
  cc.enableTilt = !flat;
  cc.enableLook = !flat;
  scene.requestRender();
}

// Zoom by a factor (<1 in, >1 out) in whichever mode the scene is in. In 2D
// the zoom is the orthographic frustum width, bounded at street level and at
// the whole world; in 3D it is the camera height.
function zoomByFactor(viewer, factor) {
  const Cesium = window.Cesium;
  const cam = viewer.camera;
  if (viewer.scene.mode === Cesium.SceneMode.SCENE2D) {
    const f = cam.frustum;
    if (!Cesium.defined(f.left)) return;
    const halfW = (f.right - f.left) / 2;
    const target = Math.min(flatMaxHalfWidth(viewer), Math.max(FLAT_MIN_HALF_WIDTH, halfW * factor));
    if (target !== halfW && f.right > 0 && f.top > 0) setFlatHalfWidth(cam, target);
    clamp2D(viewer);
  } else {
    const h = cam.positionCartographic.height;
    const target = Math.min(30000000, Math.max(250, h * factor));
    if (target < h) cam.zoomIn(h - target);
    else if (target > h) cam.zoomOut(target - h);
  }
  viewer.scene.requestRender();
}

export default function Globe3D({ mapMode = "globe", visibleIncidents = [], selectedId, hoveredId, activeCountries = new Set(), onSelect, onHover, showBlastRadius = false, blastRadius = null, showLabels = false, world = null, fallback = null }) {
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const labelsLayerRef = useRef(null);
  const onSelectRef = useRef(onSelect);
  const incidentsRef = useRef(visibleIncidents);
  const [ready, setReady] = useState(typeof window !== "undefined" && !!window.Cesium);
  const [failed, setFailed] = useState(false);
  const [tooltip, setTooltip] = useState(null); // { x, y, name, channel, color, incidentName }
  // Flips true once the Cesium viewer exists; effects that need the viewer
  // (the morph, the boundary loader) key on it. Declared here, above the
  // first effect that reads it.
  const [viewerReady, setViewerReady] = useState(false);

  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  // ── Wait for the Cesium global (script is `defer`red in index.html) ──────
  useEffect(() => {
    if (window.Cesium) { setReady(true); return; }
    let tries = 0;
    const iv = setInterval(() => {
      tries += 1;
      if (window.Cesium) { setReady(true); clearInterval(iv); }
      else if (tries > 200) { setFailed(true); clearInterval(iv); } // ~20s
    }, 100);
    return () => clearInterval(iv);
  }, []);

  // ── Morph between the flat map (SCENE2D) and the globe (SCENE3D) ────────
  // Runs when the mode changes and once the viewer exists (viewerReady), so a
  // reader whose map opens in FLAT gets the morph too. Cesium restores the
  // camera inputs on morphComplete, so the per-mode style is applied AFTER it;
  // a timer forces the morph to finish if the completion event is missed
  // (the scene otherwise sits in MORPHING and draws nothing).
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !window.Cesium) return;
    const Cesium = window.Cesium;
    const scene = viewer.scene;
    const flat = mapMode === "flat";
    const target = flat ? Cesium.SceneMode.SCENE2D : Cesium.SceneMode.SCENE3D;
    if (scene.mode === target) { applySceneStyle(viewer); return; }

    // Cesium re-touches the camera controls right after it raises
    // morphComplete (the globe came back with inputs disabled), so the
    // per-mode style is applied again shortly after the event.
    const reassert = [];
    const settle = () => {
      if (viewer.isDestroyed()) return;
      applySceneStyle(viewer);
      if (flat) frameFlatWorld(viewer);
      else flyHome3D(viewer, 0.8);
      for (const ms of [50, 700]) reassert.push(setTimeout(() => { if (!viewer.isDestroyed()) applySceneStyle(viewer); }, ms));
    };
    const done = scene.morphComplete.addEventListener(() => { done(); clearTimeout(fallbackTimer); settle(); });
    // The morph is a tween that only advances while the page gets animation
    // frames; a hidden tab (or a missed morphComplete) leaves it half-way.
    // scene.mode reads SCENE2D during a 2D→3D morph, so test for "not yet in
    // the target mode", not for MORPHING. completeMorph() is a no-op when
    // nothing is pending.
    const fallbackTimer = setTimeout(() => {
      if (!viewer.isDestroyed() && scene.mode !== target) scene.completeMorph();
    }, 1400);
    if (flat) scene.morphTo2D(0.9);
    else scene.morphTo3D(0.9);
    return () => { done(); clearTimeout(fallbackTimer); reassert.forEach(clearTimeout); };
  }, [mapMode, viewerReady]);

  // ── Toggle country/city label overlay based on showLabels ──────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !window.Cesium) return;
    const Cesium = window.Cesium;

    if (showLabels) {
      if (!labelsLayerRef.current) {
        labelsLayerRef.current = viewer.imageryLayers.addImageryProvider(
          new Cesium.ArcGisMapServerImageryProvider({ url: ARCGIS_LABELS })
        );
      }
    } else {
      if (labelsLayerRef.current) {
        viewer.imageryLayers.remove(labelsLayerRef.current);
        labelsLayerRef.current = null;
      }
    }
    viewer.scene.requestRender();
  }, [showLabels, ready]);
  // ── Highlight country/region on map ─────────────────────────────────────
  const geoDataSourceRef = useRef(null);
  const [highlightedCountry, setHighlightedCountry] = useState(null);
  const highlightSevRef = useRef(3);
  const [geoLoaded, setGeoLoaded] = useState(false);

  // Admin-1 (state/province) highlight layer — lets us fill "Delhi", not all of
  // India, when the incident's location resolves to a state. Point tier fills
  // nothing (the pin marks the exact spot); country tier is the existing fill.
  const statesFeaturesRef = useRef(null);        // all admin-1 features (for matching)
  const statesByCountryRef = useRef(null);       // Map(canonAdmin -> features[])
  const statesHiDsRef = useRef(null);            // the currently-shown single-state data source
  const stateLoadTokenRef = useRef(0);           // guards against out-of-order async state loads
  const [statesLoaded, setStatesLoaded] = useState(false);
  const [highlightedState, setHighlightedState] = useState(null);   // matched GeoJSON feature (or null)
  const [highlightedPoint, setHighlightedPoint] = useState(null);   // { lng, lat } — exact tier

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !window.Cesium || !world || !world.features) return;
    if (geoDataSourceRef.current) return;
    const Cesium = window.Cesium;
    const geojson = { type: "FeatureCollection", features: world.features };
    console.log("Cesium: Loading world boundaries GeoJSON with features count:", world.features.length);
    Cesium.GeoJsonDataSource.load(geojson, {
      clampToGround: true,
    }).then(ds => {
      viewer.dataSources.add(ds);
      geoDataSourceRef.current = ds;
      console.log("Cesium: GeoJSON loaded successfully! Number of entities:", ds.entities.values.length);
      ds.entities.values.forEach(ent => {
        const nm = ent.properties ? (
          typeof ent.properties.name?.getValue === "function"
            ? ent.properties.name.getValue()
            : ent.properties.name
        ) : null;
        ent._countryName = nm || null;
        if (ent.polygon) {
          ent.polygon.material = new Cesium.ColorMaterialProperty(Cesium.Color.TRANSPARENT);
          ent.polygon.outline = false;
          // Force GEODESIC subdivision (NOT the default RHUMB). Some country
          // polygons (USA/Alaska, Russia, Fiji, NZ…) cross the antimeridian,
          // and Cesium's rhumb tessellation then explodes with
          // "RangeError: Too many properties to enumerate" and stops rendering.
          // Coarse granularity keeps a country fill cheap.
          ent.polygon.arcType = Cesium.ArcType.GEODESIC;
          ent.polygon.granularity = Cesium.Math.toRadians(2.0);
        }
        // Keep every country HIDDEN until it is highlighted. Rendering all ~285
        // clamped polygons at once overflows Cesium's ground-classification
        // batch on real GPUs ("RangeError: Too many properties to enumerate"),
        // so only the handful that are highlighted are ever shown/built.
        ent.show = false;
      });
      setGeoLoaded(true);
      viewer.scene.requestRender();
    }).catch(err => {
      console.error("Cesium: GeoJSON load failed with error:", err);
    });
  }, [world, ready, viewerReady]);

  // ── Load admin-1 (state/province) boundaries for finer-grained highlights.
  //    Lazy-fetched from /admin1_states.json (NOT bundled). Kept as plain GeoJSON
  //    in a ref and indexed by country; only the ONE matched state is ever turned
  //    into a Cesium polygon (state-fill effect below), so global coverage
  //    (4k+ regions) adds zero entities up front. ──────────────────────────────
  useEffect(() => {
    if (statesFeaturesRef.current) return;
    let cancelled = false;
    fetch("/admin1_states.json")
      .then(r => (r.ok ? r.json() : null))
      .then(geo => {
        if (!geo || cancelled) return;
        const feats = geo.features || [];
        statesFeaturesRef.current = feats;
        const idx = new Map();
        for (const ft of feats) {
          const key = canon(ft.properties && ft.properties.admin);
          if (!key) continue;
          if (!idx.has(key)) idx.set(key, []);
          idx.get(key).push(ft);
        }
        statesByCountryRef.current = idx;
        setStatesLoaded(true);
      })
      .catch(err => console.error("admin-1 states load failed:", err));
    return () => { cancelled = true; };
  }, []);

  // STRICT country matcher. Exact-name or curated-alias matches ONLY.
  // The previous version split the filter on the letters "and" anywhere in
  // the word ("Netherlands" → ["netherl","s"]) and then substring-matched,
  // so picking ONE region lit up dozens of countries. No substring matching
  // here — a missed highlight is better than a wrong one.
  const CANON_ALIASES = {
    // canonical → every accepted spelling (all lowercase)
    "united states of america": ["united states", "usa", "us", "america"],
    "united kingdom": ["united kingdom of great britain and northern ireland", "uk", "great britain", "britain"],
    "south korea": ["korea, republic of", "republic of korea", "korea, south", "korea (south)"],
    "north korea": ["korea, democratic people's republic of", "dprk", "korea, north"],
    "russia": ["russian federation"],
    "vietnam": ["viet nam"],
    "iran": ["iran, islamic republic of"],
    "syria": ["syrian arab republic"],
    "czechia": ["czech republic"],
    "türkiye": ["turkey", "turkiye"],
    "myanmar": ["burma"],
    "côte d'ivoire": ["ivory coast", "cote d'ivoire"],
    "dem. rep. congo": ["democratic republic of the congo", "dr congo", "drc", "congo-kinshasa"],
    "congo": ["republic of the congo", "congo-brazzaville"],
    "s. sudan": ["south sudan"],
    "central african rep.": ["central african republic"],
    "dominican rep.": ["dominican republic"],
    "eq. guinea": ["equatorial guinea"],
    "w. sahara": ["western sahara"],
    "bosnia and herz.": ["bosnia and herzegovina", "bosnia"],
    "north macedonia": ["macedonia"],
    "eswatini": ["swaziland"],
    "timor-leste": ["east timor"],
    "united arab emirates": ["uae"],
    "solomon is.": ["solomon islands"],
    "falkland is.": ["falkland islands"],
    "laos": ["lao pdr", "lao people's democratic republic"],
    "netherlands": ["the netherlands", "holland"],
  };
  // name → canonical key (covers canonical names and every alias)
  const CANON_LOOKUP = (() => {
    const m = {};
    for (const [canon, aliases] of Object.entries(CANON_ALIASES)) {
      m[canon] = canon;
      for (const a of aliases) m[a] = canon;
    }
    return m;
  })();
  const canon = (s) => {
    const n = resolveCountryName(String(s)).toLowerCase().trim();
    return CANON_LOOKUP[n] || n;
  };
  const isSameCountry = (mapCountry, filterCountry) => {
    if (!mapCountry || !filterCountry) return false;
    const n1 = canon(mapCountry);
    // A filter value can legitimately name several countries
    // ("United States / Israel", "India, Pakistan"). Split ONLY on real
    // separators — "/", ",", "&", parentheses, or the WORD "and"
    // (word-boundaried, so "Netherlands"/"Rwanda" never get cut).
    const parts = String(filterCountry)
      .split(/\s*(?:[/,()&]|\band\b)\s*/i)
      .map(p => p.trim())
      .filter(p => p.length >= 3);
    const candidates = [String(filterCountry), ...parts];
    return candidates.some(p => canon(p) === n1);
  };

  // ── Admin-1 (state) matcher. Finds the admin-1 (state/province) FEATURE an
  //    incident sits in by matching a whole-word region name (or alias) inside
  //    location_name, gated to every country named in inc.country. Prefers the
  //    RIGHTMOST match — location strings run specific→general, so the state
  //    sits near the country at the end; this stops "Washington County, Kansas"
  //    lighting up Washington state. Tie-broken by longest name. ──────────────
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rightmostMatch = (name, loc) => {
    const re = new RegExp(`(^|[^a-z])${escapeRe(name)}([^a-z]|$)`, "gi");
    let m, last = -1;
    while ((m = re.exec(loc)) !== null) { last = m.index; if (re.lastIndex <= m.index) re.lastIndex = m.index + 1; }
    return last;
  };
  const matchState = (inc) => {
    const idx = statesByCountryRef.current;
    if (!idx || !inc) return null;
    const loc = String(inc.location_name || "").toLowerCase();
    if (!loc) return null;
    // Candidate features = admin-1 regions of EVERY country named in inc.country.
    const parts = String(inc.country || "").split(/\s*(?:[/,()&]|\band\b)\s*/i).map(p => p.trim()).filter(p => p.length >= 3);
    const keys = new Set([String(inc.country || ""), ...parts].map(canon).filter(Boolean));
    const pool = [];
    for (const k of keys) { const arr = idx.get(k); if (arr) pool.push(...arr); }
    if (!pool.length) return null;
    let best = null; // { feature, pos, len }
    for (const ft of pool) {
      const p = ft.properties || {};
      const names = [p.name, ...(p.name_alt ? String(p.name_alt).split(/[|,]/) : [])]
        .map(s => String(s || "").trim().toLowerCase()).filter(s => s.length >= 3);
      for (const nm of names) {
        const pos = rightmostMatch(nm, loc);
        if (pos < 0) continue;
        if (!best || pos > best.pos || (pos === best.pos && nm.length > best.len)) best = { feature: ft, pos, len: nm.length };
      }
    }
    return best ? best.feature : null;
  };

  // Prototype precision tags — until the GUARD pipeline emits a `geo_precision`
  // field, a couple of incidents are hand-tagged so the exact-point tier is
  // demoable. Real data should set inc.geo_precision instead.
  const demoPrecision = (inc) => {
    const h = inc.headline || "";
    if (h.includes("Oxin Palayesh")) return "exact"; // specific refinery → exact point
    return null;
  };

  useEffect(() => {
    const ds = geoDataSourceRef.current;
    if (!ds || !window.Cesium) return;
    const Cesium = window.Cesium;
    const goldColor = Cesium.Color.fromCssColorString("#FCBD00");
    const c = Cesium.Color.fromCssColorString(SEV_COLOR[highlightSevRef.current] || "#FCBD00");
    ds.entities.values.forEach(ent => {
      if (!ent.polygon) return;
      const countryName = ent._countryName;
      if (!countryName) return;

      const isFocused = highlightedCountry && isSameCountry(countryName, highlightedCountry);
      let isActiveFilter = false;
      if (activeCountries && activeCountries.size > 0) {
        for (const ac of activeCountries) {
          if (isSameCountry(countryName, ac)) {
            isActiveFilter = true;
            break;
          }
        }
      }

      if (isFocused) {
        // Selected/hovered incident's country — bold severity-coloured surface.
        ent.polygon.material = new Cesium.ColorMaterialProperty(c.withAlpha(0.8));
        ent.polygon.outline = false;
        ent.show = true;
      } else if (isActiveFilter) {
        // Region-filter selection — bold near-solid gold surface (reference look).
        ent.polygon.material = new Cesium.ColorMaterialProperty(goldColor.withAlpha(0.85));
        ent.polygon.outline = false;
        ent.show = true;
      } else {
        ent.polygon.material = new Cesium.ColorMaterialProperty(Cesium.Color.TRANSPARENT);
        ent.polygon.outline = false;
        ent.show = false;   // hidden → not built → no ground-batch overflow
      }
    });
    if (viewerRef.current) viewerRef.current.scene.requestRender();
  }, [highlightedCountry, activeCountries, geoLoaded]);

  // ── Resolve which precision tier to highlight for the focused incident:
  //    exact point → state/province → country (fallback chain). ──────────────
  useEffect(() => {
    const clearAll = () => { setHighlightedCountry(null); setHighlightedState(null); setHighlightedPoint(null); };
    const focusId = selectedId || hoveredId;
    if (!focusId) { clearAll(); return; }
    const inc = visibleIncidents.find(i => i._id === focusId);
    if (!inc) { clearAll(); return; }
    highlightSevRef.current = inc.severity || 3;

    const prec = String(inc.geo_precision || demoPrecision(inc) || "").toLowerCase();
    const wantPoint = /exact|point|site|rooftop|address|facility|city|town/.test(prec);
    const wantCountry = /country|national|nation/.test(prec);

    // Tier 1 — exact location: no big fill, just a tight disc on the spot.
    if (wantPoint) {
      const coords = resolveCoords(inc);
      if (coords) { setHighlightedPoint({ lng: coords[0], lat: coords[1] }); setHighlightedState(null); setHighlightedCountry(null); return; }
    }
    // Tier 2 — state/province known: fill that admin-1 polygon only.
    const stateFeat = wantCountry ? null : matchState(inc);
    if (stateFeat) { setHighlightedState(stateFeat); setHighlightedCountry(null); setHighlightedPoint(null); return; }

    // Tier 3 — country fill. Filling a country asserts the WHOLE country is the
    // affected area, so it has to be earned rather than fallen into. Anything
    // that fails to match a state used to land here: "Strait of Hormuz, Persian
    // Gulf" matches no admin-1 region, so it filled all of Iran off
    // country:"IR" — the Strait is Iran/Oman shared transit and the incident is
    // one ship, not a nation. Unless the data explicitly says country-scoped,
    // prefer the exact coordinates we already have; open water never fills.
    const loc = String(inc.location_name || "");
    const maritime = /\b(strait|gulf|sea|ocean|channel|bay|waters|high seas)\b/i.test(loc);
    if (!wantCountry) {
      const coords = resolveCoords(inc);
      if (coords) { setHighlightedPoint({ lng: coords[0], lat: coords[1] }); setHighlightedState(null); setHighlightedCountry(null); return; }
    }
    if (maritime) { clearAll(); return; }
    setHighlightedCountry(inc.country || null); setHighlightedState(null); setHighlightedPoint(null);
  }, [selectedId, hoveredId, visibleIncidents, statesLoaded]);

  // ── Fill the highlighted admin-1 (state/province): load JUST the one matched
  //    feature as a clamped polygon (same render path as countries). A token
  //    guards against a slow load overwriting a newer selection/hover. ─────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !window.Cesium) return;
    const Cesium = window.Cesium;
    const token = ++stateLoadTokenRef.current;
    if (statesHiDsRef.current) {
      try { if (!viewer.isDestroyed()) viewer.dataSources.remove(statesHiDsRef.current, true); } catch (_) {}
      statesHiDsRef.current = null;
    }
    if (!highlightedState) { viewer.scene.requestRender(); return; }
    const c = Cesium.Color.fromCssColorString(SEV_COLOR[highlightSevRef.current] || "#FCBD00");
    Cesium.GeoJsonDataSource.load({ type: "FeatureCollection", features: [highlightedState] }, { clampToGround: true })
      .then(ds => {
        if (token !== stateLoadTokenRef.current || viewer.isDestroyed()) return; // superseded
        ds.entities.values.forEach(ent => {
          if (!ent.polygon) return;
          ent.polygon.material = new Cesium.ColorMaterialProperty(c.withAlpha(0.8));
          ent.polygon.outline = false;
          ent.polygon.arcType = Cesium.ArcType.GEODESIC;   // antimeridian-safe (Russia/US states)
          ent.polygon.granularity = Cesium.Math.toRadians(1.0);
        });
        viewer.dataSources.add(ds);
        statesHiDsRef.current = ds;
        viewer.scene.requestRender();
      })
      .catch(err => console.error("state highlight load failed:", err));
  }, [highlightedState]);

  // ── Exact-location tier: a tight severity-coloured disc on the precise spot
  //    (instead of shading a whole region we already know is pinpoint). ───────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !window.Cesium) return;
    const Cesium = window.Cesium;
    viewer.entities.values.filter(e => e._isExactHi).forEach(e => viewer.entities.remove(e));
    if (!highlightedPoint) { viewer.scene.requestRender(); return; }
    const c = Cesium.Color.fromCssColorString(SEV_COLOR[highlightSevRef.current] || "#FCBD00");
    const disc = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(highlightedPoint.lng, highlightedPoint.lat, 5000),
      ellipse: {
        semiMajorAxis: 20000, semiMinorAxis: 20000,
        material: new Cesium.ColorMaterialProperty(c.withAlpha(0.55)),
        outline: true, outlineColor: c.withAlpha(0.95), outlineWidth: 2,
        height: 4000,
      },
    });
    disc._isExactHi = true;
    viewer.scene.requestRender();
    return () => { try { if (!viewer.isDestroyed()) viewer.entities.values.filter(e => e._isExactHi).forEach(e => viewer.entities.remove(e)); } catch (_) {} };
  }, [highlightedPoint]);

// Country centroid fallback — used when an incident has no lat/lng
// but has a country ISO-2 code. Covers the most common countries in the data.
const COUNTRY_CENTROIDS = {
  US: [-98.58, 39.83],  AD: [1.52, 42.55],  AE: [53.85, 23.42],  AF: [67.71, 33.94],
  AG: [-61.80, 17.08],  AL: [20.17, 41.15],  AM: [45.04, 40.07],  AO: [17.87, -11.20],
  AR: [-63.62, -38.42], AT: [14.55, 47.52],  AU: [133.78, -25.27], AZ: [47.58, 40.14],
  BA: [17.68, 44.16],   BB: [-59.56, 13.19], BD: [90.36, 23.68],  BE: [4.47, 50.50],
  BF: [-1.56, 12.36],   BG: [25.48, 42.73],  BH: [50.56, 26.02],  BI: [29.92, -3.38],
  BJ: [2.32, 9.31],     BN: [114.73, 4.54],  BO: [-64.67, -16.29],BR: [-51.93, -14.24],
  BS: [-77.40, 24.78],  BT: [90.43, 27.51],  BW: [24.68, -22.33], BY: [28.05, 53.71],
  BZ: [-88.50, 17.19],  CA: [-96.80, 56.13], CD: [23.65, -2.88],  CF: [20.94, 6.61],
  CG: [15.83, -0.23],   CH: [8.23, 46.82],   CI: [-5.55, 7.54],   CL: [-71.54, -35.68],
  CM: [12.35, 5.70],    CN: [104.20, 35.86], CO: [-74.30, 4.57],  CR: [-84.02, 9.75],
  CU: [-79.52, 21.52],  CV: [-23.99, 15.12], CY: [33.43, 35.13],  CZ: [15.47, 49.82],
  DE: [10.45, 51.17],   DJ: [42.59, 11.83],  DK: [9.50, 56.26],   DO: [-70.16, 18.74],
  DZ: [1.66, 28.03],    EC: [-78.18, -1.83], EE: [25.01, 58.60],  EG: [30.80, 26.82],
  ER: [39.78, 15.18],   ES: [-3.75, 40.46],  ET: [40.49, 9.15],   FI: [25.75, 61.92],
  FJ: [179.41, -16.58], FR: [2.21, 46.23],   GA: [11.61, -0.80],  GB: [-3.44, 55.38],
  GE: [43.36, 42.32],   GH: [-1.02, 7.95],   GM: [-15.31, 13.44], GN: [-11.81, 10.95],
  GQ: [10.27, 1.65],    GR: [21.82, 39.07],  GT: [-90.23, 15.78], GW: [-14.45, 11.80],
  GY: [-58.93, 4.86],   HN: [-86.24, 15.20], HR: [15.20, 45.10],  HT: [-72.29, 18.97],
  HU: [19.50, 47.16],   ID: [117.75, -0.79], IE: [-8.24, 53.41],  IL: [34.85, 30.80],
  IN: [78.96, 20.59],   IQ: [43.68, 33.22],  IR: [53.69, 32.43],  IS: [-18.53, 64.96],
  IT: [12.57, 41.87],   JM: [-77.30, 18.11], JO: [36.24, 30.59],  JP: [138.25, 36.20],
  KE: [37.91, 0.02],    KG: [74.77, 41.20],  KH: [104.99, 12.57], KI: [174.00, 1.87],
  KM: [43.87, -11.88],  KP: [127.51, 40.34], KR: [127.77, 35.91], KW: [47.48, 29.34],
  KZ: [66.92, 48.02],   LA: [102.50, 17.97], LB: [35.86, 33.85],  LK: [80.77, 7.87],
  LR: [-9.43, 6.43],    LS: [28.23, -29.61], LT: [23.88, 55.17],  LU: [6.13, 49.82],
  LV: [24.60, 56.88],   LY: [17.23, 26.34],  MA: [-7.09, 31.79],  MD: [28.37, 47.41],
  ME: [19.37, 42.71],   MG: [46.87, -18.77], MK: [21.75, 41.61],  ML: [-3.00, 17.57],
  MM: [95.96, 16.87],   MN: [103.85, 46.86], MR: [-10.94, 17.28], MT: [14.38, 35.94],
  MU: [57.55, -20.35],  MV: [73.22, 3.20],   MW: [34.30, -13.25], MX: [-102.55, 23.95],
  MY: [109.70, 4.21],   MZ: [35.53, -18.67], NA: [18.49, -22.96], NE: [8.08, 17.61],
  NG: [8.68, 9.08],     NI: [-85.21, 12.87], NL: [5.29, 52.13],   NO: [8.47, 60.47],
  NP: [84.12, 28.39],   NR: [166.93, -0.52], NZ: [174.89, -40.90],OM: [57.55, 21.51],
  PA: [-80.78, 8.54],   PE: [-75.02, -9.19], PG: [143.96, -6.31], PH: [122.87, 12.88],
  PK: [69.35, 30.38],   PL: [19.15, 51.92],  PT: [-8.22, 39.40],  PW: [134.58, 7.51],
  PY: [-58.44, -23.44], QA: [51.18, 25.35],  RO: [24.97, 45.94],  RS: [21.01, 44.02],
  RU: [105.32, 61.52],  RW: [29.87, -1.94],  SA: [45.08, 23.89],  SB: [160.16, -9.64],
  SD: [30.22, 12.86],   SE: [18.64, 60.13],  SG: [103.82, 1.36],  SI: [14.99, 46.15],
  SK: [19.70, 48.67],   SL: [-11.78, 8.46],  SM: [12.46, 43.94],  SN: [-14.45, 14.50],
  SO: [46.20, 5.15],    SR: [-56.03, 3.92],  SS: [31.30, 6.88],   ST: [6.61, 0.33],
  SV: [-88.90, 13.79],  SY: [38.30, 34.80],  SZ: [31.46, -26.52], TD: [18.73, 15.45],
  TG: [0.82, 8.62],     TH: [100.99, 15.87], TJ: [71.28, 38.86],  TL: [125.73, -8.87],
  TM: [58.74, 40.07],   TN: [9.54, 33.89],   TO: [-175.20, -21.18],TR: [35.24, 38.96],
  TT: [-61.22, 10.69],  TV: [177.65, -7.11], TZ: [34.89, -6.37],  UA: [31.17, 48.38],
  UG: [32.29, 1.37],    UY: [-55.77, -32.52],UZ: [63.95, 41.38],  VA: [12.45, 41.90],
  VC: [-61.20, 12.98],  VE: [-66.59, 6.42],  VN: [108.28, 14.06], VU: [166.36, -15.38],
  WS: [-172.10, -13.76],YE: [47.59, 15.55],  ZA: [25.08, -29.00], ZM: [27.85, -13.13],
  ZW: [29.15, -19.00],
  // Regional/global fallbacks
  EU: [10.00, 50.00], // Europe centroid
  ZZ: [0.00, 20.00],  // Global/unknown fallback
};

function resolveCoords(inc) {
  if (typeof inc.latitude === "number" && typeof inc.longitude === "number"
      && inc.latitude !== 0 && inc.longitude !== 0) {
    return [inc.longitude, inc.latitude];
  }
  // Try country code fallback
  if (inc.country && COUNTRY_CENTROIDS[inc.country]) {
    return COUNTRY_CENTROIDS[inc.country];
  }
  return null; // truly unknown — skip rendering
}

  // ── Build / rebuild incident points ─────────────────────────────────────
  function buildEntities(viewer, incidents) {
    const Cesium = window.Cesium;
    viewer.entities.removeAll();
    incidents.forEach((inc) => {
      const coords = resolveCoords(inc);
      if (!coords) return;
      const [lng, lat] = coords;
      const hex = SEV_COLOR[inc.severity] || SEV_COLOR[3];
      const color = Cesium.Color.fromCssColorString(hex);
      const core = CORE_PX[inc.severity] || CORE_PX[3];
      const position = Cesium.Cartesian3.fromDegrees(lng, lat);
      const show = new Cesium.CallbackProperty(() => onNearSide(viewer, position), false);
      // Halo first so the core draws over it; clicks on it still open the incident.
      const halo = viewer.entities.add({
        position,
        point: { show, pixelSize: core * HALO_PX, color: color.withAlpha(0.28), outlineWidth: 0, scaleByDistance: markerScale(Cesium) },
      });
      halo._incident = inc;
      const entity = viewer.entities.add({
        id: String(inc._id),
        position,
        point: {
          show,
          pixelSize: core,
          color,
          outlineColor: Cesium.Color.WHITE.withAlpha(0.95),
          outlineWidth: 2,
          scaleByDistance: markerScale(Cesium),
        },
      });
      entity._incident = inc;

      // CRITICAL only — a slow outward pulse, so the eye lands on the worst
      // incident of the day without every marker competing.
      if (inc.severity === 5) {
        const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
        const phase = () => {
          const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
          return ((now - t0) % 2400) / 2400;   // 0→1 every 2.4s
        };
        const pulse = viewer.entities.add({
          position,
          point: {
            show,
            pixelSize: new Cesium.CallbackProperty(() => core * (1.2 + phase() * 2.6), false),
            color: Cesium.Color.TRANSPARENT,
            outlineColor: new Cesium.CallbackProperty(() => color.withAlpha(0.8 * (1 - phase())), false),
            outlineWidth: 2,
            scaleByDistance: markerScale(Cesium),
          },
        });
        // So a click that lands on the expanding ring still opens the incident
        // rather than firing onSelect with an auto-generated entity GUID.
        pulse._incident = inc;
      }
    });
    viewer.scene.requestRender();
  }

  // ── Initialise the Cesium viewer (once, when ready) ─────────────────────
  useEffect(() => {
    if (!ready || !containerRef.current || viewerRef.current) return;
    const Cesium = window.Cesium;
    let viewer;
    try {
      viewer = new Cesium.Viewer(containerRef.current, {
        imageryProvider: new Cesium.ArcGisMapServerImageryProvider({ url: ARCGIS_WORLD_IMAGERY }),
        baseLayerPicker: false,
        fullscreenButton: false,
        vrButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false,
        navigationHelpButton: false,
        animation: false,
        creditContainer: document.createElement("div"), // hide the credit bar
        contextOptions: { webgl: { alpha: false } },
        // FLAT view settings (see the note above worldHalfExtent2D): one copy
        // of the world, never the infinite east-west repeat, drawn 2:1 so it
        // fills a landscape screen.
        mapMode2D: Cesium.MapMode2D.ROTATE,
        mapProjection: new Cesium.GeographicProjection(),
      });
      // Cesium's own 2D zoom-out cap is maximumZoomFactor × the world's half
      // width. Raised so it never undercuts flatMaxHalfWidth() (the whole
      // world fitting the viewport, which on a wide screen needs > 2×);
      // zoomByFactor() applies the real cap and clamp2D() re-centres the map
      // whenever the view is wider than it.
      viewer.camera.maximumZoomFactor = 3;
      viewerRef.current = viewer;
      setViewerReady(true);   // signals the boundary-GeoJSON loader that the viewer now exists

      // ── Photogenic "Google Earth" look, BINARY day/night by LOCAL time ──
      // No physical terminator (lighting off → never a half-dark globe).
      // The WHOLE globe switches visual by the laptop's clock:
      //   local 06:00–18:59 → bright satellite "day" earth (ArcGIS base layer)
      //   local night hours → the real NASA "Earth at night" image (dark planet
      //                        with glowing city lights) laid over the top.
      // Re-checked every minute so it flips at dusk/dawn without a reload.
      viewer.scene.globe.enableLighting = true;   // real sun-position day/night terminator
      viewer.scene.skyAtmosphere.show = true;
      viewer.scene.globe.showGroundAtmosphere = true;
      viewer.scene.fog.enabled = true;
      viewer.scene.fog.density = 0.00008;
      viewer.scene.highDynamicRange = true;
      viewer.scene.globe.baseColor = Cesium.Color.BLACK;
      viewer.scene.backgroundColor = Cesium.Color.BLACK;
      if (viewer.scene.skyBox) viewer.scene.skyBox.show = true; // starfield

      // Night imagery layer — NASA black-marble city-lights, opaque, sits ON TOP
      // of the day layer and is only shown at night (so it fully replaces the
      // day view with a real dark, city-lit earth).
      const nightLayer = viewer.imageryLayers.addImageryProvider(
        new Cesium.SingleTileImageryProvider({
          url: "/textures/earth-night.jpg",
          rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90),
        })
      );
      nightLayer.show = false;
      nightLayer.brightness = 1.35;   // make the city lights pop
      viewer._nightLayer = nightLayer;

      const applyDayNight = () => {
        // Normal sun-lit day/night globe. City-lights swap removed — enableLighting
        // gives the real day/night terminator; the globe opens fixed on the day
        // side by day and the night side after dark (per local time). The FLAT
        // map is a map: evenly lit, never half dark (applySceneStyle owns it).
        nightLayer.show = false;
        viewer.scene.globe.enableLighting = viewer.scene.mode !== Cesium.SceneMode.SCENE2D;
        viewer.scene.skyAtmosphere.brightnessShift = 0.15;
        viewer.scene.requestRender();
      };
      applyDayNight();
      viewer._dayNightTimer = setInterval(applyDayNight, 60000);

      // Easy zoom: get right down to street level.
      const cc = viewer.scene.screenSpaceCameraController;
      cc.minimumZoomDistance = 250;          // ~250 m — street level
      cc.maximumZoomDistance = 30000000;
      cc.enableCollisionDetection = true;
      cc.inertiaZoom = 0.3;                  // slight inertia feels natural
      // Disable default Cesium wheel zoom so our custom handler does not conflict.
      // Keep Cesium's touch screen pinch-zoom intact.
      cc.zoomEventTypes = [
        Cesium.CameraEventType.PINCH,
      ];

      // Framing: whole globe from space, camera on the lit hemisphere so the
      // terminator falls toward the left edge (like the reference). When the
      // map opens in FLAT the morph effect (keyed on viewerReady) takes it to
      // 2D and frames the world from here.
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(LOCAL_LON, 15, 24000000),
      });

      // The flat map can never leave the frame: re-check the 2D camera before
      // every render (no-op in 3D).
      viewer._clamp2DHandler = viewer.scene.preRender.addEventListener(() => {
        if (viewer.isDestroyed()) return;
        clamp2D(viewer);
      });

      // ── Auto-rotation: rotate globe slowly when user is idle ─────────────
      let isUserInteracting = false;
      let interactTimer = null;
      const ROTATE_SPEED = 0.04; // degrees per frame

      // Detect user interaction (mouse/touch down → pause, release → resume)
      const canvas2 = viewer.scene.canvas;
      function onInteractStart() {
        isUserInteracting = true;
        clearTimeout(interactTimer);
      }
      function onInteractEnd() {
        // Resume auto-rotate 1.5s after user releases
        clearTimeout(interactTimer);
        interactTimer = setTimeout(() => { isUserInteracting = false; }, 1500);
      }
      
      // Custom trackpad precision zoom & pinch handler — globe AND flat map
      // (zoomByFactor picks the right zoom model for the scene mode).
      function onWheel(e) {
        e.preventDefault(); // prevent browser from scrolling the webpage!
        if (viewer.scene.mode === Cesium.SceneMode.MORPHING) return;
        onInteractStart();
        let delta = e.deltaY;
        if (e.ctrlKey) {
          // Boost pinch-to-zoom speed
          delta = e.deltaY * 5;
        }
        const zoomSens = 0.0015;
        const factor = Math.exp(delta * zoomSens);
        zoomByFactor(viewer, Math.max(0.7, Math.min(1.4, factor)));
      }

      canvas2.addEventListener("mousedown", onInteractStart);
      canvas2.addEventListener("touchstart", onInteractStart, { passive: true });
      canvas2.addEventListener("wheel", onWheel, { passive: false });
      window.addEventListener("mouseup", onInteractEnd);
      window.addEventListener("touchend", onInteractEnd);
      viewer._autoRotateListeners = { canvas2, onInteractStart, onInteractEnd, onWheel };

      // Auto-rotation DISABLED — the globe must stay fixed so it opens on the
      // day side during local daytime and the night side after dark (driven by
      // the laptop clock + real sun lighting via enableLighting). Manual drag
      // still spins it. The handler stays registered (no-op) so the existing
      // cleanup path keeps working.
      const AUTO_ROTATE = false;
      viewer._autoRotateHandler = viewer.scene.postRender.addEventListener(() => {
        if (!AUTO_ROTATE) return;
        if (viewer.scene.mode !== Cesium.SceneMode.SCENE3D) return;
        if (!isUserInteracting && !viewer._forceStopRotate && viewer && !viewer.isDestroyed()) {
          viewer.scene.camera.rotate(
            Cesium.Cartesian3.UNIT_Z,
            Cesium.Math.toRadians(-ROTATE_SPEED)
          );
        }
      });
      viewer._stopAutoRotate = () => {
        clearTimeout(interactTimer);
        if (viewer._autoRotateHandler) { viewer._autoRotateHandler(); viewer._autoRotateHandler = null; }
        if (viewer._autoRotateListeners) {
          const { canvas2, onInteractStart, onInteractEnd, onWheel } = viewer._autoRotateListeners;
          canvas2.removeEventListener("mousedown", onInteractStart);
          canvas2.removeEventListener("touchstart", onInteractStart);
          canvas2.removeEventListener("wheel", onWheel);
          window.removeEventListener("mouseup", onInteractEnd);
          window.removeEventListener("touchend", onInteractEnd);
        }
      };

      // Click a point → open the existing incident card via onSelect(_id).
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((movement) => {
        const picked = viewer.scene.pick(movement.position);
        if (Cesium.defined(picked) && picked.id) {
          // Prefer the incident stapled to the entity. The severity-5 pulse
          // ring is a second entity at the same position with an auto-assigned
          // GUID, so keying off entity.id alone would fire onSelect with a
          // GUID that matches no incident whenever the click caught the ring.
          const inc = picked.id._incident;
          const id = inc && inc._id != null ? inc._id
                   : (picked.id.id != null ? picked.id.id : null);
          if (id != null) onSelectRef.current && onSelectRef.current(id);
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      viewer._clickHandler = handler;

      buildEntities(viewer, incidentsRef.current);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Cesium init error:", e);
      setFailed(true);
      return;
    }

    return () => {
      try {
        if (viewer._dayNightTimer) clearInterval(viewer._dayNightTimer);
        if (viewer._stopAutoRotate) viewer._stopAutoRotate();
        if (viewer._clamp2DHandler) viewer._clamp2DHandler();
        viewer._clickHandler && viewer._clickHandler.destroy();
      } catch (_) {}
      try { viewer.destroy(); } catch (_) {}
      viewerRef.current = null;
      setViewerReady(false);
      setViewerReady(false);
    };
  }, [ready]);

  // ── Rebuild points when the incident set changes ────────────────────────
  useEffect(() => {
    incidentsRef.current = visibleIncidents;
    const viewer = viewerRef.current;
    if (!viewer || !window.Cesium) return;
    buildEntities(viewer, visibleIncidents);
  }, [visibleIncidents]);

  // ── Fly to / highlight the externally-selected incident ─────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !window.Cesium) return;
    // Stop rotation when an incident is selected, resume when deselected
    viewer._forceStopRotate = !!selectedId;
    if (!selectedId) return;
    const ent = viewer.entities.getById(String(selectedId));
    if (ent && ent.position) {
      const Cesium = window.Cesium;
      const carto = Cesium.Cartographic.fromCartesian(ent.position.getValue(Cesium.JulianDate.now()));
      // Same move in both views. In 2D the height sets the frustum width, so
      // a lower value frames the region as tightly as the globe's 3,500 km.
      const flat = viewer.scene.mode === Cesium.SceneMode.SCENE2D;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, flat ? 2500000 : 3500000),
        duration: 1.2,
      });
    }
  }, [selectedId, mapMode]);

  // ── Selection "ping": pulsing halo + expanding sonar rings on the tapped
  //    incident — restores the old tap-to-expand animation. Always shows on
  //    selection (independent of the BLAST toggle). ─────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !window.Cesium) return;
    const Cesium = window.Cesium;

    // Remove any previous ping entities.
    viewer.entities.values.filter(e => e._isSelPing).forEach(e => viewer.entities.remove(e));

    if (!selectedId) { viewer.scene.requestRender(); return; }
    const inc = incidentsRef.current.find(i => String(i._id) === String(selectedId));
    if (!inc) return;
    const coords = resolveCoords(inc);
    if (!coords) return;
    const [lng, lat] = coords;
    const color = Cesium.Color.fromCssColorString(SEV_COLOR[inc.severity] || SEV_COLOR[3]);
    const pos = Cesium.Cartesian3.fromDegrees(lng, lat, 15000);

    // Pulsing halo — the marker "breathes"/expands.
    const halo = viewer.entities.add({
      position: pos,
      ellipse: {
        semiMajorAxis: new Cesium.CallbackProperty(() => 42000 + 16000 * (0.5 + 0.5 * Math.sin(Date.now() / 420)), false),
        semiMinorAxis: new Cesium.CallbackProperty(() => 42000 + 16000 * (0.5 + 0.5 * Math.sin(Date.now() / 420)), false),
        material: new Cesium.ColorMaterialProperty(color.withAlpha(0.30)),
        outline: true,
        outlineColor: color.withAlpha(0.9),
        outlineWidth: 2,
        height: 11000, fill: true,
      },
    });
    halo._isSelPing = true;

    // Two expanding sonar rings that ripple outward and fade.
    [0, 0.5].forEach((phase) => {
      const ring = viewer.entities.add({
        position: pos,
        ellipse: {
          semiMajorAxis: new Cesium.CallbackProperty(() => { const t = ((Date.now() / 1900) + phase) % 1; return 45000 + t * 230000; }, false),
          semiMinorAxis: new Cesium.CallbackProperty(() => { const t = ((Date.now() / 1900) + phase) % 1; return 45000 + t * 230000; }, false),
          material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => { const t = ((Date.now() / 1900) + phase) % 1; return color.withAlpha(Math.max(0, 0.20 * (1 - t))); }, false)),
          outline: true,
          outlineColor: new Cesium.CallbackProperty(() => { const t = ((Date.now() / 1900) + phase) % 1; return color.withAlpha(Math.max(0, 0.85 * (1 - t))); }, false),
          outlineWidth: 2,
          height: 11000, fill: true,
        },
      });
      ring._isSelPing = true;
    });

    viewer.scene.requestRender();

    return () => {
      try {
        if (!viewer.isDestroyed()) {
          viewer.entities.values.filter(e => e._isSelPing).forEach(e => viewer.entities.remove(e));
        }
      } catch (_) {}
    };
  }, [selectedId, visibleIncidents]);

  // ── Blast-radius arcs for selected incident ──────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !window.Cesium) return;
    const Cesium = window.Cesium;

    // Clear previous blast arcs always
    const toRemove = [];
    const allEnts = viewer.entities.values;
    for (let i = 0; i < allEnts.length; i++) {
      if (allEnts[i]._isBlastArc) toRemove.push(allEnts[i]);
    }
    toRemove.forEach(e => viewer.entities.remove(e));

    // Only draw if BLAST toggle is ON
    if (!selectedId || !showBlastRadius) return;
    const inc = incidentsRef.current.find(i => String(i._id) === String(selectedId));
    if (!inc || typeof inc.latitude !== "number" || typeof inc.longitude !== "number") return;
    // Prefer the lazily-fetched blast data passed from the parent; fall back to
    // whatever the incident already carries.
    const radius = (blastRadius && Object.keys(blastRadius).length) ? blastRadius : (inc.blast_radius || {});
    if (!Object.keys(radius).length) return;

    const channelDefs = {
      internal:              { color: "#FCBD00", width: 3, opacity: 0.75 },
      supply_chain:          { color: "#FF8C5A", width: 3, opacity: 0.75 },
      customer_counterparty: { color: "#4FC3D7", width: 3, opacity: 0.75 },
      competitive_peer:      { color: "#9D7BEC", width: 2.5, opacity: 0.65 },
      regulatory:            { color: "#A8A8A8", width: 2.5, opacity: 0.65 },
      financial_market:      { color: "#7BD693", width: 2.5, opacity: 0.65 },
    };

    Object.entries(radius).forEach(([channel, entities]) => {
      const def = channelDefs[channel] || { color: "#888888", width: 2, opacity: 0.55 };
      if (!Array.isArray(entities)) return;
      entities.forEach(ent => {
        if (typeof ent.latitude !== "number" || typeof ent.longitude !== "number") return;

        // Blast entities very often carry the incident's OWN coordinates (an
        // internal team, an on-site depot, co-located allied personnel), giving a
        // zero-length arc. A ground-clamped polyline needs two DISTINCT points, and
        // a zero-length arc conveys nothing anyway — skip the line, the dot still
        // marks the spot.
        const sameSpot =
          Math.abs(ent.latitude - inc.latitude) < 1e-6 &&
          Math.abs(ent.longitude - inc.longitude) < 1e-6;

        if (!sameSpot) {
          // Draped on the surface — NOT lifted to altitude. These used to be built at
          // 20 km with clampToGround:false while the incident pin is CLAMP_TO_GROUND,
          // so the arcs hung 20 km above their own origin. Zoomed into a city that
          // offset is larger than the map itself (Bahrain is ~50 km end to end), so
          // every arc appeared to sprout from a point well away from the pin —
          // "the blast radius comes out of the wrong dot".
          //
          // Pass the two ENDPOINTS and let Cesium subdivide. clampToGround builds a
          // GroundPolylineGeometry, which accepts ONLY ArcType.GEODESIC or RHUMB —
          // never ArcType.NONE. With NONE the release build (debug asserts stripped)
          // silently skips both subdivision branches, leaving its per-segment
          // EllipsoidGeodesic array empty, and the scene dies on the next frame with
          //   TypeError: Cannot read properties of undefined (reading 'surfaceDistance')
          // Hand-interpolating the great circle ourselves and passing NONE is exactly
          // that trap: the geodesic drape is the ground primitive's job.
          const arcEnt = viewer.entities.add({
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray([
                inc.longitude, inc.latitude,
                ent.longitude, ent.latitude,
              ]),
              width: def.width,
              material: new Cesium.PolylineGlowMaterialProperty({
                glowPower: 0.25,
                color: Cesium.Color.fromCssColorString(def.color).withAlpha(def.opacity),
              }),
              arcType: Cesium.ArcType.GEODESIC,
              clampToGround: true,
            },
          });
          arcEnt._isBlastArc = true;
        }

        // Destination dot
        const channelLabels = {
          internal: "Internal", supply_chain: "Supply Chain",
          customer_counterparty: "Customer", competitive_peer: "Peer",
          regulatory: "Regulator", financial_market: "Capital",
        };
        // Same ground reference as the incident pin (see the arc note above), so
        // a destination dot sits on the place it refers to at every zoom.
        const dotPos = Cesium.Cartesian3.fromDegrees(ent.longitude, ent.latitude);
        const dotEnt = viewer.entities.add({
          position: dotPos,
          point: {
            show: new Cesium.CallbackProperty(() => onNearSide(viewer, dotPos), false),   // not past the horizon (see onNearSide)
            // Was 18 px with a white outline. Against the old reticle — whose
            // visible core is 3 px — an 18 px solid disc made the blast-radius
            // satellites louder than the incident they radiate from. Sized
            // down and given a dark hairline so the hierarchy reads correctly:
            // incident first, related entities second.
            pixelSize: 9,
            color: Cesium.Color.fromCssColorString(def.color).withAlpha(0.9),
            outlineColor: Cesium.Color.fromCssColorString("#0D0D0D").withAlpha(0.8),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        });
        dotEnt._isBlastArc = true;
        dotEnt._blastMeta = {
          name: ent.name || ent.entity_name || ent.company || "Unknown Entity",
          channel: channelLabels[channel] || channel,
          color: def.color,
          country: ent.country || "",
          entityType: ent.type || "",
          incidentName: inc.title || inc.name || inc.headline || "",
        };

        // Pulsing concentric rings — 2 rings, offset phase so they ripple outward.
        // Ground-clamped for the same reason as the arcs and dots above: at 20 km
        // altitude the ripple detached from the entity it belongs to, drifting
        // further from it the closer you zoom.
        const dotColor = Cesium.Color.fromCssColorString(def.color);
        const ringPos = Cesium.Cartesian3.fromDegrees(ent.longitude, ent.latitude);
        [0, 0.5].forEach((phaseOffset) => {
          const ring = viewer.entities.add({
            position: ringPos,
            ellipse: {
              semiMajorAxis: new Cesium.CallbackProperty(() => {
                const t = ((Date.now() / 2200) + phaseOffset) % 1;
                return 30000 + t * 120000; // 30km → 150km expanding
              }, false),
              semiMinorAxis: new Cesium.CallbackProperty(() => {
                const t = ((Date.now() / 2200) + phaseOffset) % 1;
                return 30000 + t * 120000;
              }, false),
              material: new Cesium.ColorMaterialProperty(
                new Cesium.CallbackProperty(() => {
                  const t = ((Date.now() / 2200) + phaseOffset) % 1;
                  return dotColor.withAlpha(Math.max(0, 0.55 * (1 - t)));
                }, false)
              ),
              outline: true,
              outlineColor: new Cesium.CallbackProperty(() => {
                const t = ((Date.now() / 2200) + phaseOffset) % 1;
                return dotColor.withAlpha(Math.max(0, 0.9 * (1 - t)));
              }, false),
              outlineWidth: 2,
              fill: true,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
          });
          ring._isBlastArc = true;
        });
      });
    });

    viewer.scene.requestRender();

    // ── Hover tooltip on blast dots ──────────────────────────────────────
    const hoverHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    hoverHandler.setInputAction((movement) => {
      const picked = viewer.scene.pick(movement.endPosition);
      if (Cesium.defined(picked) && picked.id) {
        if (picked.id._blastMeta) {
          const meta = picked.id._blastMeta;
          setTooltip({
            type: "blast",
            x: movement.endPosition.x,
            y: movement.endPosition.y,
            name: meta.name,
            channel: meta.channel,
            color: meta.color,
            country: meta.country,
            entityType: meta.entityType,
            incidentName: meta.incidentName,
          });
          onHover(null);
        } else if (picked.id._incident) {
          const inc = picked.id._incident;
          const sevColor = SEV_COLOR[inc.severity] || SEV_COLOR[3];
          setTooltip({
            type: "incident",
            x: movement.endPosition.x,
            y: movement.endPosition.y,
            name: inc.headline,
            color: sevColor,
            category: inc.primary_category || "Classification",
            locationName: inc.location_name || inc.country || "",
            severity: inc.severity,
          });
          onHover(inc._id);
        } else {
          setTooltip(null);
          onHover(null);
        }
      } else {
        setTooltip(null);
        onHover(null);
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    viewer._blastHoverHandler = hoverHandler;

    return () => {
      try { hoverHandler.destroy(); } catch (_) {}
      viewer._blastHoverHandler = null;
    };
  }, [selectedId, showBlastRadius, blastRadius]);


  // ── Zoom / reset controls (reliable, cursor-independent), both views ────
  const zoomStep = (factor) => {
    const viewer = viewerRef.current;
    if (!viewer || !window.Cesium) return;
    zoomByFactor(viewer, factor);
  };
  const resetView = () => {
    const viewer = viewerRef.current;
    if (!viewer || !window.Cesium) return;
    if (viewer.scene.mode === window.Cesium.SceneMode.SCENE2D) frameFlatWorld(viewer);
    else flyHome3D(viewer);
  };

  const zBtn = {
    width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center",
    background: "rgba(26,26,26,0.85)", backdropFilter: "blur(10px)",
    border: "1px solid #333", color: "#FCBD00", fontSize: 20, fontWeight: 700,
    cursor: "pointer", lineHeight: 1, userSelect: "none",
  };

  return (
    <div style={{ position: "absolute", inset: 0, background: "#000", overflow: "hidden" }}>
      <style>{`
        .nav-btn {
          width: 44px;
          height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(20, 20, 20, 0.85);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(252,189,0, 0.15);
          color: #FCBD00;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          padding: 0;
          outline: none;
        }
        .nav-btn:hover {
          background: rgba(252,189,0, 0.15);
          color: #FFF;
          border-color: #FCBD00;
        }
        .nav-btn:active {
          transform: scale(0.92);
          background: rgba(252,189,0, 0.25);
        }
        .nav-btn-top {
          border-radius: 0;
          border-bottom: none;
        }
        .nav-btn-mid {
          border-bottom: none;
        }
        .nav-btn-bot {
          border-radius: 0;
        }
      `}</style>
      {/* When the Cesium CDN never arrives, the parent's fallback (the SVG
          map) takes the stage instead of an empty black box. */}
      {failed && fallback ? fallback : <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />}

      {/* Hover tooltip — handles both blast nodes and incident pins */}
      {tooltip && (
        <div style={{
          position: "absolute",
          left: Math.min(tooltip.x + 14, window.innerWidth - 720),
          top: Math.max(10, tooltip.y - 10),
          zIndex: 50,
          pointerEvents: "none",
          background: "rgba(10,10,14,0.92)",
          backdropFilter: "blur(12px)",
          border: `1px solid ${tooltip.color}55`,
          borderLeft: `3px solid ${tooltip.color}`,
          borderRadius: 0,
          padding: "8px 12px",
          minWidth: 200,
          maxWidth: 280,
          boxShadow: `0 4px 24px rgba(0,0,0,0.6), 0 0 12px ${tooltip.color}22`,
          fontFamily: "Inter, sans-serif",
        }}>
          {tooltip.type === "incident" ? (
            <>
              <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: tooltip.color, marginBottom: 4 }}>
                {tooltip.category} · SEV {tooltip.severity}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#FFFFFF", lineHeight: 1.3 }}>
                {tooltip.name}
              </div>
              {tooltip.locationName && (
                <div style={{ fontSize: 11, color: "#C0C0C8", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 12 }}>📍</span> {tooltip.locationName}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: tooltip.color, marginBottom: 4, display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: tooltip.color, flexShrink: 0 }} />
                {tooltip.channel}{tooltip.entityType ? ` · ${tooltip.entityType}` : ""}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#FFFFFF", lineHeight: 1.3 }}>
                {tooltip.name}
              </div>
              {tooltip.country && (
                <div style={{ fontSize: 11, color: "#C0C0C8", marginTop: 3, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 12 }}>📍</span> {tooltip.country}
                </div>
              )}
              {tooltip.incidentName && (
                <div style={{ fontSize: 10, color: "#808088", lineHeight: 1.4, borderTop: "1px solid #2a2a30", paddingTop: 5, marginTop: 5 }}>
                  ↳ {tooltip.incidentName}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Zoom and navigation controls — bottom-left, in both views. */}
      {ready && !failed && (
        <div style={{ position: "absolute", left: 24, bottom: 56, zIndex: 25, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}>
          <button className="nav-btn nav-btn-top" title="Zoom in" onClick={() => zoomStep(0.5)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button className="nav-btn nav-btn-mid" title="Zoom out" onClick={() => zoomStep(2)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button className="nav-btn nav-btn-bot" title="Reset view" onClick={resetView}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
        </div>
      )}
      {!ready && !failed && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#FCBD00", fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" }}>
          Initializing satellite link…
        </div>
      )}
      {failed && !fallback && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#A8A8A8", fontFamily: "Inter, sans-serif", fontSize: 13, textAlign: "center", padding: 24 }}>
          Couldn’t load the satellite map engine.<br />Check your connection and reload.
        </div>
      )}
    </div>
  );
}
