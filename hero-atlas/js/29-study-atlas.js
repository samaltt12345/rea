// ================= STUDY ATLAS (Hero × Atlas) =================
// Atlas-style study modes (Explore, Learn, Flashcards, Test, Blank map, Records) for the
// built-in tours, "My Map" and any number of personal study sets. Everything is local:
// progress, sets and records live in this browser's localStorage.
// Map: Esri satellite / Esri physical terrain tiles, or a solid one-colour map drawn from
// Natural Earth country borders. Clicking a place outlines exactly where it starts and stops.
(() => {
'use strict';
const A = window.AtlasGeo;
if (!A || !window.L) { console.warn('Study Atlas could not start (missing Atlas data or Leaflet).'); return; }

// ---------- small helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NK = s => A.normalizeName(String(s || ''));
const CK = s => NK(s).replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const icons = () => { try { lucide.createIcons(); } catch (e) { /* icons are decorative */ } };
const reducedMotion = () => document.documentElement.dataset.motion === 'off' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const toast = (m, t = 'info') => (typeof showToast === 'function' ? showToast(m, t) : console.log(m));
const LS = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Your browser storage is full, so progress could not be saved.', 'error'); } }
};
const K_PROG = 'heroAtlas_progress_v1', K_SETS = 'heroAtlas_sets_v1', K_PREF = 'heroAtlas_prefs_v1';
const prefs = Object.assign({ style: 'satellite', borders: true, labels: false, sfx: true, lastSet: '', batch: 10, flash: 'where', flashDeck: 'all', test: { count: 20, diff: 'medium', kind: 'mixed' }, blankCount: 'all' }, LS.get(K_PREF, {}));
const savePrefs = () => LS.set(K_PREF, prefs);
let prog = LS.get(K_PROG, { sets: {} }); if (!prog.sets) prog = { sets: {} };
let saveTimer = 0;
const saveProg = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => LS.set(K_PROG, prog), 120); };

// ---------- sound (tiny WebAudio blips; toggle in the study header) ----------
let actx = null;
const FLAME = '<svg class="sa-ico-flame" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1 3.5-1.6 5.2-1.6 8 0 1.3.9 2.3 2.1 2.3 1.4 0 2.2-1.2 1.9-3 2.4 1.6 4.1 4.3 4.1 7.1A6.5 6.5 0 0 1 12 23a6.5 6.5 0 0 1-6.5-6.6C5.5 10.6 11 8 12 2Z" fill="currentColor"/></svg>';
const TROPHY = '<svg class="sa-ico-trophy" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>';
function sfx(kind) {
  if (!prefs.sfx) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = { ok: [660, 880], bad: [220, 165], tick: [520], win: [523, 659, 784, 1047], flip: [440] }[kind] || [440];
    notes.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + i * (kind === 'win' ? .09 : .07);
      o.type = kind === 'bad' ? 'triangle' : 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(kind === 'tick' || kind === 'flip' ? .04 : .09, t + .015); g.gain.exponentialRampToValueAtTime(0.0001, t + .22);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + .25);
    });
  } catch (e) { /* audio unavailable */ }
}
function burst(big = false) {
  if (reducedMotion()) return;
  if (big && typeof fireConfetti === 'function') return fireConfetti();
  const host = $('#sa-stage'); if (!host) return;
  const b = document.createElement('div'); b.className = 'sa-burst';
  const colors = ['#d5ed9c', '#f1d77a', '#34d399', '#60a5fa', '#f472b6'];
  for (let i = 0; i < 22; i++) { const s = document.createElement('i'); const a = Math.PI * 2 * i / 22; s.style.setProperty('--dx', `${Math.cos(a) * (70 + Math.random() * 60)}px`); s.style.setProperty('--dy', `${Math.sin(a) * (70 + Math.random() * 60)}px`); s.style.background = colors[i % colors.length]; b.appendChild(s); }
  host.appendChild(b); setTimeout(() => b.remove(), 1000);
}

// ---------- boundary data ----------
let countriesP = null; const countryIndex = new Map();
window.heroCountries = () => countriesP || (countriesP = fetch('content/countries.geojson').then(r => { if (!r.ok) throw new Error('countries ' + r.status); return r.json(); }).then(d => {
  d.features.forEach(f => [f.properties.name, f.properties.name_long].forEach(n => n && countryIndex.set(CK(n), f)));
  return d;
}).catch(e => { console.warn('Country borders unavailable:', e); return { type: 'FeatureCollection', features: [] }; }));
const COUNTRY_ALIAS = { 'czech republic': 'czechia', 'vatican city': 'vatican', 'holy see': 'vatican', 'united states': 'united states of america', 'usa': 'united states of america', 'us': 'united states of america', 'tanzania': 'united republic of tanzania', 'bahamas': 'the bahamas', 'turkiye': 'turkey', 'great britain': 'united kingdom', 'britain': 'united kingdom', 'uk': 'united kingdom', 'holland': 'netherlands', 'burma': 'myanmar', 'east timor': 'timor leste', 'ivory coast': 'cote divoire', 'swaziland': 'eswatini', 'cape verde': 'cabo verde', 'drc': 'democratic republic congo' };
const WATER_TYPES = /sea|ocean|gulf|bay|strait|channel|lake|river|canal|sound|lagoon/i;
const HIST_TYPES = /historic|empire|kingdom|ancient|civilization|dynasty/i;

const STYLES = {
  satellite: { label: 'Satellite', icon: 'satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxNative: 18, attr: 'Imagery &copy; Esri, Maxar, Earthstar Geographics &middot; Borders: Natural Earth' },
  terrain: { label: 'Terrain', icon: 'mountain', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}', maxNative: 8, attr: 'Terrain &copy; Esri, US National Park Service &middot; Borders: Natural Earth' },
  solid: { label: 'Solid', icon: 'palette', url: null, attr: 'Borders: Natural Earth (public domain)' }
};
const STYLE_ORDER = ['satellite', 'terrain', 'solid'];
const isDark = () => document.documentElement.classList.contains('dark');
function borderStyle(style, show) {
  const dark = isDark();
  if (style === 'solid') return { color: dark ? '#5a7299' : '#8796ad', weight: .8, opacity: 1, fillColor: dark ? '#1f3556' : '#ece5d3', fillOpacity: 1 };
  if (style === 'terrain') return { color: '#3d4a5c', weight: .9, opacity: show ? .7 : 0, fillOpacity: 0 };
  return { color: '#ffffff', weight: .9, opacity: show ? .62 : 0, fillOpacity: 0 };
}
// Apply a map style to any Leaflet map (used by both the Study Atlas and the Hero quiz map).
function applyMapStyle(m, holder, style, showBorders) {
  if (!m) return;
  const st = STYLES[style] || STYLES.satellite;
  if (holder.base) { m.removeLayer(holder.base); holder.base = null; }
  if (st.url) {
    holder.base = L.tileLayer(st.url, { maxNativeZoom: st.maxNative, maxZoom: 14, attribution: st.attr, keepBuffer: 3 }).addTo(m);
    holder.base.bringToBack();
    holder.base.on('tileerror', () => { if (holder.borders && !holder.warned) { holder.warned = true; holder.borders.setStyle(borderStyle('solid', true)); m.getContainer().classList.add('sa-solid-map'); } });
  }
  m.getContainer().classList.toggle('sa-solid-map', style === 'solid');
  m.getContainer().dataset.mapStyle = style;
  window.heroCountries().then(fc => {
    if (!m.getPane('saBorders')) { const p = m.createPane('saBorders'); p.style.zIndex = 250; p.style.pointerEvents = 'none'; }
    if (!holder.borders) holder.borders = L.geoJSON(fc, { pane: 'saBorders', interactive: false, style: () => borderStyle(style, showBorders) }).addTo(m);
    const ac = m.attributionControl; const want = st.url ? '' : STYLES.solid.attr;
    if (ac && holder.attr !== want) { if (holder.attr) ac.removeAttribution(holder.attr); if (want) ac.addAttribution(want); holder.attr = want; }
    holder.warned = false;
    holder.borders.setStyle(borderStyle(style, showBorders || style === 'solid'));
  });
}

// ---------- geometry (grading against real outlines) ----------
function ringsOf(geom) { if (!geom) return []; if (geom.type === 'Polygon') return [geom.coordinates]; if (geom.type === 'MultiPolygon') return geom.coordinates; return []; }
function inRing(r, x, y) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c; } return c; }
function geoContains(feats, lat, lng) {
  for (const f of feats) for (const poly of ringsOf(f.geometry)) { if (poly[0] && inRing(poly[0], lng, lat) && !poly.slice(1).some(h => inRing(h, lng, lat))) return true; }
  return false;
}
function geoDistanceKm(feats, lat, lng) {
  let best = Infinity; const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
  const seg = (a, b) => { const ax = (a[0] - lng) * kx, ay = (a[1] - lat) * ky, bx = (b[0] - lng) * kx, by = (b[1] - lat) * ky; const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; let t = l2 ? -(ax * dx + ay * dy) / l2 : 0; t = clamp(t, 0, 1); const px = ax + t * dx, py = ay + t * dy; return Math.sqrt(px * px + py * py); };
  for (const f of feats) {
    const g = f.geometry; if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : ringsOf(g).flat();
    for (const line of lines) for (let i = 0; i < line.length - 1; i++) { const d = seg(line[i], line[i + 1]); if (d < best) best = d; }
  }
  return best;
}

// ---------- sets & places ----------
const userSets = () => LS.get(K_SETS, []);
const saveUserSets = s => LS.set(K_SETS, s);
function allSets() {
  const out = [];
  Object.keys(QUIZZES).forEach(k => { const s = store[k]; if (s && (s.locs.length || k === 'default')) out.push({ key: 'tour:' + k, kind: 'tour', tour: k, title: s.title || QUIZZES[k].defTitle, sub: `Built-in tour · ${QUIZZES[k].label}`, locs: s.locs, icon: 'map' }); });
  Object.keys(QUIZZES).forEach(k => {
    const locs = k === yearMode ? customLocations : LS.get(QUIZZES[k].custom, []);
    if (k === yearMode || locs.length) out.push({ key: 'mine:' + k, kind: 'mine', tour: k, title: `My Map${Object.keys(QUIZZES).length > 1 ? ` · ${QUIZZES[k].label}` : ''}`, sub: 'Personal practice list', locs, icon: 'compass' });
  });
  userSets().forEach(s => out.push({ key: 'set:' + s.id, kind: 'set', id: s.id, title: s.title, sub: 'Your study set', locs: s.items || [], icon: 'notebook-pen' }));
  return out;
}
function gazMatch(loc) {
  const r = A.lookupGazetteer(loc.name || '');
  let g = r.status === 'resolved' ? r.resolved : r.status === 'ambiguous' ? r.options.slice().sort((a, b) => A.haversineKm(loc.lat, loc.lng, a.lat, a.lng) - A.haversineKm(loc.lat, loc.lng, b.lat, b.lng))[0] : null;
  if (g && Number.isFinite(+loc.lat) && A.haversineKm(+loc.lat, +loc.lng, g.lat, g.lng) > Math.max(900, g.radiusKm * 2.5)) g = null;
  return g;
}
function enrich(loc, i, set) {
  const g = (loc.description && loc.aliases) ? null : gazMatch(loc);
  const name = String(loc.name || 'Unnamed');
  return {
    key: NK(name) || 'p' + i, n: i + 1, id: loc.id || '', name,
    lat: +loc.lat, lng: +loc.lng,
    type: loc.type || g?.type || (loc.category && !/^custom$/i.test(loc.category) ? loc.category : 'Place'),
    region: loc.region || g?.region || '', aliases: loc.aliases || g?.aliases || [],
    description: loc.description || g?.description || '', why: loc.why || loc.whyItMatters || g?.whyItMatters || '',
    radiusKm: +loc.radiusKm || g?.radiusKm || 150, bboxes: loc.bboxes || g?.bboxes || null, path: loc.path || g?.path || null,
    tour: set.tour, year: loc.year
  };
}
function resolveGeo(p) {
  if (p._geo !== undefined) return p._geo;
  let feats = [], kind = '', approx = false;
  const keys = [p.tour && `${p.tour}:${p.id}`, `default:${p.id}`, `twoyear:${p.id}`, p.id].filter(Boolean);
  if (p.id) for (const k of keys) {
    const e = (typeof hlLocations !== 'undefined' ? hlLocations : {})[k];
    if (e?.featureIds?.length) { feats = e.featureIds.map(id => hlFeatures[id]).filter(Boolean); if (feats.length) { kind = e.kind || ''; approx = feats.some(f => f.properties?.heroApproximate); break; } }
  }
  const names = [p.name, ...(p.aliases || [])];
  if (!feats.length && !HIST_TYPES.test(p.type) && !WATER_TYPES.test(p.type)) {
    for (const n of names) { let k = CK(n); k = COUNTRY_ALIAS[k] || k; const f = countryIndex.get(k); if (f) { feats = [f]; kind = 'land'; break; } }
  }
  if (!feats.length && typeof hlFeatures !== 'undefined') {
    const want = new Set(names.map(CK));
    for (const f of Object.values(hlFeatures)) { const pr = f.properties || {}; if ([pr.name, pr.NAME, pr.name_en, pr.NAME_EN].some(n => n && want.has(CK(n)))) { feats = [f]; break; } }
  }
  p._geo = feats.length ? { feats, kind, approx } : null;
  return p._geo;
}
const kindOf = p => { const g = p._geo; if (g?.kind === 'historic' || HIST_TYPES.test(p.type)) return 'hist'; if (g?.kind === 'marine' || WATER_TYPES.test(p.type) || WATER_TYPES.test(p.name)) return 'water'; return 'land'; };
const outlineLabel = p => { const g = resolveGeo(p); if (g) return g.approx ? 'Approximate historical extent' : 'Natural Earth outline'; if (p.path) return 'Approximate course'; if (p.bboxes) return 'Approximate study extent'; return 'Approximate area'; };

// ---------- progress ----------
const P = key => (prog.sets[key] = prog.sets[key] || { places: {}, tests: [], blank: [], learn: null });
const rec = p => { const ps = P(S.set.key).places; return (ps[p.key] = ps[p.key] || { m: 0, c: 0, w: 0, seen: 0 }); };
const mOf = p => (P(S.set.key).places[p.key]?.m) || 0;
function grade(p, ok, how = 'test') {
  const r = rec(p); r.seen++; r.last = Date.now();
  if (ok) { r.c++; r.m = how === 'learned' ? 3 : how === 'learn' ? Math.max(r.m, Math.min(2, r.m + 1)) : Math.min(3, r.m + 1); }
  else { r.w++; r.m = Math.max(r.m > 0 || how === 'learn' ? 1 : 0, r.m - 1); }
  saveProg(); paintPin(p);
}
function setStats(key = S.set?.key, places = S.places) {
  const ps = P(key).places; let mastered = 0, learning = 0, c = 0, w = 0, studied = 0;
  places.forEach(p => { const r = ps[p.key]; if (!r) return; if (r.m >= 3) mastered++; else if (r.m > 0 || r.seen) learning++; if (r.seen) studied++; c += r.c; w += r.w; });
  return { mastered, learning, fresh: places.length - mastered - learning, studied, acc: c + w ? Math.round(100 * c / (c + w)) : null, tests: P(key).tests.length, total: places.length };
}

// ---------- state ----------
const S = { set: null, places: [], tab: 'explore', sel: null, map: null, holder: {}, pinLayer: null, hlLayer: null, markLayer: null, paintLayer: null, pins: new Map(), tour: 0, session: null, onClick: null, built: false, search: '', sort: 'num', opened: false };
window.heroStudyState = S;
{ let oc = null; Object.defineProperty(S, 'onClick', { get: () => oc, set: v => { oc = v; document.getElementById('sa-map')?.classList.toggle('is-asking', !!v); } }); }

// ---------- shell ----------
const TABS = [
  ['explore', 'compass', 'Explore'], ['learn', 'graduation-cap', 'Learn'], ['flash', 'layers', 'Flashcards'],
  ['test', 'clipboard-check', 'Test'], ['blank', 'map', 'Blank map'], ['records', 'trophy', 'Records']
];
const ATLAS_MARK = '<svg viewBox="0 0 40 40" fill="none" aria-hidden="true" class="sa-atlas-mark"><rect x="1" y="1" width="38" height="38" rx="12" fill="currentColor" fill-opacity=".07" stroke="currentColor" stroke-opacity=".22"/><path d="m10 29 8-19h5l8 19h-6l-5-13-4 13h-6Z" fill="currentColor"/><path d="m12 24 15-5" stroke="#d5ed9c" stroke-width="3"/><circle cx="29" cy="10" r="2.5" fill="#d5ed9c"/></svg>';
function build() {
  if (S.built) return; S.built = true;
  const v = $('#study-view');
  v.innerHTML = `
  <div class="sa-shell">
    <header class="sa-head">
      <button class="sa-setbtn" id="sa-setbtn" type="button" aria-haspopup="dialog" title="Choose a study set">
        <span class="sa-kicker">${ATLAS_MARK}<span>Study Atlas</span><em>Hero × atlas.</em></span>
        <span class="sa-settitle"><strong id="sa-set-title">Loading…</strong><i data-lucide="chevrons-up-down"></i></span>
      </button>
      <nav class="sa-tabs" role="tablist" aria-label="Study modes">${TABS.map(([id, ic, label]) => `<button role="tab" data-tab="${id}" aria-selected="false"><i data-lucide="${ic}"></i><span>${label}</span></button>`).join('')}</nav>
      <div class="sa-head-meta">
        <div class="sa-ring" id="sa-ring" title="Mastered"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.5" class="bg"/><circle cx="18" cy="18" r="15.5" class="fg" id="sa-ring-fg"/></svg><b id="sa-ring-n">0%</b></div>
        <button class="sa-iconbtn" id="sa-sfx" type="button" title="Study sounds"><i data-lucide="volume-2"></i></button>
      </div>
    </header>
    <div class="sa-body">
      <aside class="sa-panel" id="sa-panel" aria-live="polite"></aside>
      <section class="sa-stage" id="sa-stage">
        <div id="sa-map" class="sa-map" aria-label="Study map"></div>
        <div class="sa-prompt hidden" id="sa-prompt"></div>
        <div class="sa-tools">
          <button type="button" data-act="zin" title="Zoom in"><i data-lucide="plus"></i></button>
          <button type="button" data-act="zout" title="Zoom out"><i data-lucide="minus"></i></button>
          <button type="button" data-act="fit" title="Fit all places"><i data-lucide="scan"></i></button>
          <button type="button" data-act="world" title="Whole world"><i data-lucide="globe-2"></i></button>
          <button type="button" data-act="labels" title="Show names next to pins" id="sa-labels-btn"><i data-lucide="type"></i></button>
        </div>
        <div class="sa-layers" role="group" aria-label="Map style">
          <div class="sa-seg">${STYLE_ORDER.map(k => `<button type="button" data-style="${k}" aria-pressed="false"><i data-lucide="${STYLES[k].icon}"></i><span>${STYLES[k].label}</span></button>`).join('')}</div>
          <button type="button" class="sa-borders" id="sa-borders" aria-pressed="true" title="Modern country borders"><span class="sa-check"><i data-lucide="check"></i></span>Borders<small>MODERN</small></button>
        </div>
        <div class="sa-info hidden" id="sa-info"></div>
        <div class="sa-dock" id="sa-dock"></div>
      </section>
    </div>
    <div class="sa-modal hidden" id="sa-modal" role="dialog" aria-modal="true"><div class="sa-modal-card" id="sa-modal-card"></div></div>
  </div>`;
  $('#sa-setbtn').onclick = openSetPicker;
  $$('.sa-tabs button', v).forEach(b => b.onclick = () => setTab(b.dataset.tab));
  $$('.sa-seg button', v).forEach(b => b.onclick = () => setStyle(b.dataset.style));
  $('#sa-borders').onclick = () => { prefs.borders = !prefs.borders; savePrefs(); syncLayerButtons(); applyMapStyle(S.map, S.holder, prefs.style, prefs.borders); };
  $('#sa-sfx').onclick = () => { prefs.sfx = !prefs.sfx; savePrefs(); syncLayerButtons(); if (prefs.sfx) sfx('tick'); };
  $('#sa-modal').addEventListener('mousedown', e => { if (e.target.id === 'sa-modal') closeModal(); });
  $$('.sa-tools button', v).forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (a === 'zin') S.map.zoomIn(); else if (a === 'zout') S.map.zoomOut(); else if (a === 'fit') fitAll(); else if (a === 'world') S.map.flyTo([30, 10], 2, { duration: .8 });
    else if (a === 'labels') { prefs.labels = !prefs.labels; savePrefs(); syncLayerButtons(); renderPins(); }
  });
  initStudyMap(); icons(); syncLayerButtons();
  document.addEventListener('keydown', onKey);
  new MutationObserver(() => S.map && applyMapStyle(S.map, S.holder, prefs.style, prefs.borders)).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
}
function syncLayerButtons() {
  $$('.sa-seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.style === prefs.style)));
  const bb = $('#sa-borders'); if (bb) { bb.setAttribute('aria-pressed', String(prefs.borders)); bb.classList.toggle('is-disabled', prefs.style === 'solid'); }
  $('#sa-labels-btn')?.classList.toggle('on', prefs.labels);
  const s = $('#sa-sfx'); if (s) { s.innerHTML = `<i data-lucide="${prefs.sfx ? 'volume-2' : 'volume-x'}"></i>`; s.classList.toggle('on', prefs.sfx); icons(); }
}
function setStyle(style) {
  if (!STYLES[style]) return; prefs.style = style; savePrefs(); syncLayerButtons();
  applyMapStyle(S.map, S.holder, style, prefs.borders);
}
function initStudyMap() {
  S.map = L.map('sa-map', { zoomControl: false, worldCopyJump: true, minZoom: 2, maxZoom: 12, zoomSnap: .25, zoomDelta: .75, wheelPxPerZoomLevel: 90 }).setView([52, 14], 4);
  [['saPaint', 380], ['saHl', 450], ['saLeader', 590], ['saMarks', 660]].forEach(([n, z]) => { const p = S.map.createPane(n); p.style.zIndex = z; if (n !== 'saMarks') p.style.pointerEvents = 'none'; });
  S.paintLayer = L.layerGroup().addTo(S.map);
  S.pinLayer = L.layerGroup().addTo(S.map);
  S.hlLayer = L.layerGroup().addTo(S.map);
  S.markLayer = L.layerGroup().addTo(S.map);
  S.map.on('click', e => { if (S.onClick) S.onClick(e.latlng); else if (S.tab === 'explore') closeInfo(); });
  S.map.on('zoomend resize', layoutPins);
  applyMapStyle(S.map, S.holder, prefs.style, prefs.borders);
}
// Leaflet cannot frame bounds inside a hidden (0×0) container; it would produce NaN.
// Every camera move goes through cam(), which waits until the stage has a real size.
function cam(fn) {
  if (!S.map) return;
  let sz = S.map.getSize();
  if (!sz.x || !sz.y) { S.map.invalidateSize(false); sz = S.map.getSize(); }
  if (sz.x > 40 && sz.y > 40) { try { fn(); } catch (e) { console.warn('[study] camera', e); } return; }
  clearTimeout(S._camWait); S._pendingCam = fn;
  S._camWait = setTimeout(() => { const f = S._pendingCam; S._pendingCam = null; if (f && S.map) { S.map.invalidateSize(false); const z = S.map.getSize(); if (z.x > 40 && z.y > 40) cam(f); } }, 220);
}
function fitAll(opts = {}) {
  const pts = S.places.filter(p => Number.isFinite(p.lat)).map(p => [p.lat, p.lng]);
  if (!pts.length) return cam(() => S.map.setView([30, 10], 2));
  const b = L.latLngBounds(pts);
  cam(() => S.map.flyToBounds(b.pad(.08), { padding: [30, 30], maxZoom: 6, duration: opts.instant ? 0 : .9, animate: !opts.instant }));
}
function boundsFor(p) {
  const g = resolveGeo(p); let b = null;
  if (g) b = L.geoJSON({ type: 'FeatureCollection', features: g.feats }).getBounds();
  else if (p.path?.length > 1) b = L.latLngBounds(p.path);
  else if (p.bboxes?.length) b = L.latLngBounds(p.bboxes.flatMap(x => [[x[0], x[1]], [x[2], x[3]]]));
  else b = L.latLng(p.lat, p.lng).toBounds(p.radiusKm * 2000);
  if (!b.isValid() || b.getEast() - b.getWest() > 200) return null; // antimeridian giants (Russia): just centre on the pin
  return b;
}
function flyTo(p, { maxZoom = 6, pad = 60 } = {}) {
  const b = boundsFor(p);
  const right = window.innerWidth > 900 ? 40 : 20;
  cam(() => { if (b) S.map.flyToBounds(b, { paddingTopLeft: [pad, pad], paddingBottomRight: [pad + right, pad + 70], maxZoom, duration: reducedMotion() ? 0 : .9 });
  else S.map.flyTo([p.lat, p.lng], 3, { duration: reducedMotion() ? 0 : .9 }); });
}
// Draw a place's outline. variant: focus | ok | bad | reveal | m0..m3 | paint-ok | paint-bad
function outline(p, variant = 'focus', layer = S.hlLayer, { rings = true } = {}) {
  const g = resolveGeo(p), kind = kindOf(p);
  const base = `sa-shape sa-${variant} sa-k-${kind}`;
  const pane = layer === S.paintLayer ? 'saPaint' : 'saHl';
  const parts = variant.startsWith('m') || variant.startsWith('paint') ? ['sa-line'] : ['sa-halo', 'sa-glow', 'sa-line'];
  const make = cls => {
    const o = { pane, interactive: false, className: `${cls} ${base}` };
    if (g) return L.geoJSON({ type: 'FeatureCollection', features: g.feats }, { pane, interactive: false, style: () => ({ className: `${cls} ${base}` }) });
    if (p.path?.length > 1) return L.polyline(p.path, { ...o, className: `${cls} ${base} sa-path` });
    if (p.bboxes?.length) return L.featureGroup(p.bboxes.map(x => L.rectangle([[x[0], x[1]], [x[2], x[3]]], { ...o, className: `${cls} ${base} sa-approx` })));
    return L.circle([p.lat, p.lng], { ...o, radius: clamp(p.radiusKm, 25, 900) * 1000, className: `${cls} ${base} sa-approx` });
  };
  parts.forEach(c => make(c).addTo(layer));
  if (rings && !reducedMotion() && Number.isFinite(p.lat)) [0, 220].forEach(d => { const r = L.circleMarker([p.lat, p.lng], { pane, radius: 10, interactive: false, className: `sa-radiate sa-${variant}` }).addTo(layer); r.getElement()?.style.setProperty('--d', `${d}ms`); });
}
const clearHl = () => { S.hlLayer.clearLayers(); };
const clearMarks = () => { S.markLayer.clearLayers(); };

// ---------- pins (numbered, decluttered with leader lines like Atlas) ----------
const pinIcon = (p, sel) => L.divIcon({ className: 'sa-pin-wrap', html: `<div class="sa-pin m${mOf(p)}${sel ? ' is-sel' : ''}"><span>${p.n}</span></div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
function renderPins(show = S.tab === 'explore' || S.tab === 'records') {
  S.pinLayer.clearLayers(); S.pins.clear();
  if (!show) return;
  S.places.forEach(p => {
    if (!Number.isFinite(p.lat)) return;
    const line = L.polyline([[p.lat, p.lng], [p.lat, p.lng]], { pane: 'saLeader', interactive: false, className: 'sa-leader' }).addTo(S.pinLayer);
    const dot = L.circleMarker([p.lat, p.lng], { pane: 'saLeader', radius: 2.6, interactive: false, className: 'sa-dot' }).addTo(S.pinLayer);
    const m = L.marker([p.lat, p.lng], { icon: pinIcon(p, S.sel === p), keyboard: true, title: '', riseOnHover: true }).addTo(S.pinLayer);
    m.on('click', e => { L.DomEvent.stopPropagation(e); stopTour(); select(p); });
    if (prefs.labels) m.bindTooltip(esc(p.name), { permanent: true, direction: 'right', offset: [14, 0], className: 'sa-label' });
    else m.bindTooltip(`<b>${esc(p.name)}</b><span>${esc(p.type)}</span>`, { direction: 'top', offset: [0, -14], className: 'sa-tip' });
    S.pins.set(p.key, { m, dot, line, p });
  });
  layoutPins();
}
function layoutPins() {
  if (!S.pins.size || !S.map) return;
  { const z = S.map.getSize(); if (!z.x || !z.y) return; }
  const items = [...S.pins.values()];
  const o = items.map(it => S.map.latLngToLayerPoint([it.p.lat, it.p.lng]));
  const pos = o.map(pt => ({ x: pt.x, y: pt.y }));
  const R = 29;
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) {
      let dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y, d = Math.hypot(dx, dy);
      if (d < R) { if (d < .01) { dx = Math.cos(i + j); dy = Math.sin(i + j); d = 1; } const push = (R - d) / 2; dx /= d; dy /= d; pos[i].x -= dx * push; pos[i].y -= dy * push; pos[j].x += dx * push; pos[j].y += dy * push; moved = true; }
    }
    pos.forEach((p, k) => { p.x += (o[k].x - p.x) * .04; p.y += (o[k].y - p.y) * .04; });
    if (!moved) break;
  }
  items.forEach((it, k) => {
    const ll = S.map.layerPointToLatLng(L.point(pos[k].x, pos[k].y));
    const off = Math.hypot(pos[k].x - o[k].x, pos[k].y - o[k].y) > 7;
    it.m.setLatLng(ll); it.line.setLatLngs([[it.p.lat, it.p.lng], ll]);
    it.line.getElement()?.classList.toggle('hidden', !off); it.dot.getElement()?.classList.toggle('hidden', !off);
  });
}
function paintPin(p) { const it = S.pins.get(p.key); if (it) it.m.setIcon(pinIcon(p, S.sel === p)); }

// ---------- selection / info card ----------
function select(p, { fly = true, quiet = false } = {}) {
  const prev = S.sel; S.sel = p;
  if (prev) paintPin(prev); paintPin(p);
  clearHl(); outline(p, 'focus');
  if (fly) flyTo(p);
  showInfo(p);
  $$('#sa-list .sa-row').forEach(r => r.classList.toggle('is-sel', r.dataset.key === p.key));
  const row = $(`#sa-list .sa-row[data-key="${CSS.escape(p.key)}"]`); if (row && !quiet) row.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  S.tour = S.places.indexOf(p);
  renderDock();
}
const STATUS = m => ['New', 'Learning', 'Learning', 'Mastered'][m] || 'New';
function showInfo(p) {
  const el = $('#sa-info'); const r = P(S.set.key).places[p.key] || { m: 0, c: 0, w: 0 };
  const aliases = (p.aliases || []).filter(a => NK(a) !== NK(p.name)).slice(0, 4);
  el.innerHTML = `
    <button class="sa-x" type="button" aria-label="Close" data-close><i data-lucide="x"></i></button>
    <div class="sa-info-top"><span class="sa-num m${r.m}">${p.n}</span><div><div class="sa-info-kicker">${esc(p.type)}${p.region ? ` · ${esc(p.region)}` : ''}</div><h3>${esc(p.name)}</h3></div></div>
    ${p.description ? `<p class="sa-desc">${esc(p.description)}</p>` : `<p class="sa-desc sa-muted">A place on your list. Its outline shows where it starts and stops.</p>`}
    ${p.why ? `<div class="sa-why"><i data-lucide="sparkles"></i><span><b>Why it matters</b>${esc(p.why)}</span></div>` : ''}
    <div class="sa-info-foot">
      <span class="sa-badge m${r.m}">${STATUS(r.m)}</span>
      <span class="sa-outline-src"><i data-lucide="scan-line"></i>${esc(outlineLabel(p))}</span>
      ${aliases.length ? `<span class="sa-aka">Also: ${aliases.map(esc).join(', ')}</span>` : ''}
    </div>`;
  el.classList.remove('hidden'); el.classList.remove('sa-pop'); void el.offsetWidth; el.classList.add('sa-pop');
  el.querySelector('[data-close]').onclick = closeInfo; icons();
}
function closeInfo() { $('#sa-info')?.classList.add('hidden'); clearHl(); const prev = S.sel; S.sel = null; if (prev) paintPin(prev); $$('#sa-list .sa-row.is-sel').forEach(r => r.classList.remove('is-sel')); renderDock(); }
let tourTimer = 0;
function stopTour() { clearInterval(tourTimer); tourTimer = 0; renderDock(); }
function stepTour(d) { if (!S.places.length) return; const i = ((S.sel ? S.places.indexOf(S.sel) : -1) + d + S.places.length) % S.places.length; select(S.places[i]); }
function renderDock() {
  const dock = $('#sa-dock'); if (!dock) return;
  if (S.tab !== 'explore') { dock.classList.add('hidden'); return; }
  dock.classList.remove('hidden');
  const p = S.sel, i = p ? S.places.indexOf(p) + 1 : 0;
  dock.innerHTML = `
    <button type="button" class="sa-dock-btn" data-d="-1" title="Previous place (←)"><i data-lucide="arrow-left"></i></button>
    <div class="sa-dock-text">${p ? `<small>${i} of ${S.places.length} · ${esc(p.type)}</small><b>${esc(p.name)}</b>` : `<small>Start exploring</small><b>Tap any pin, or take the guided tour</b>`}</div>
    <button type="button" class="sa-dock-btn" data-play title="${tourTimer ? 'Pause tour' : 'Play guided tour'}"><i data-lucide="${tourTimer ? 'pause' : 'play'}"></i></button>
    <button type="button" class="sa-dock-btn sa-go" data-d="1" title="Next place (→)"><i data-lucide="arrow-right"></i></button>`;
  dock.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { stopTour(); stepTour(+b.dataset.d); });
  dock.querySelector('[data-play]').onclick = () => { if (tourTimer) return stopTour(); stepTour(1); tourTimer = setInterval(() => stepTour(1), 4200); renderDock(); };
  icons();
}

// ---------- header progress ring ----------
function renderRing() {
  const st = setStats(); const pct = st.total ? Math.round(100 * st.mastered / st.total) : 0;
  const c = 2 * Math.PI * 15.5; const fg = $('#sa-ring-fg'); if (fg) { fg.style.strokeDasharray = c; fg.style.strokeDashoffset = c * (1 - pct / 100); }
  const n = $('#sa-ring-n'); if (n) n.textContent = pct + '%';
  const ring = $('#sa-ring'); if (ring) ring.title = `${st.mastered} of ${st.total} mastered`;
  renderHomeProgress();
}

// ---------- set loading ----------
async function loadSet(key, { keepTab = true } = {}) {
  const sets = allSets(); const set = sets.find(s => s.key === key) || sets[0];
  endSession(); stopTour();
  S.set = set; prefs.lastSet = set.key; savePrefs();
  S.places = (set.locs || []).filter(l => l && l.name && Number.isFinite(+l.lat) && Number.isFinite(+l.lng)).map((l, i) => enrich(l, i, set));
  const seen = new Set(); S.places.forEach(p => { while (seen.has(p.key)) p.key += '_'; seen.add(p.key); });
  S.sel = null; $('#sa-set-title').textContent = set.title; $('#sa-info')?.classList.add('hidden');
  await Promise.all([typeof hlLoad === 'function' ? hlLoad() : null, window.heroCountries()]);
  S.places.forEach(p => resolveGeo(p));
  clearHl(); clearMarks(); S.paintLayer.clearLayers();
  renderRing();
  setTab(keepTab ? S.tab : 'explore', { force: true });
  fitAll({ instant: !S.opened });
}

// ---------- tabs ----------
function setTab(tab, { force = false, sure = false } = {}) {
  if (!force && tab === S.tab && !S.session) return renderTab();
  if (S.session && S.session.live && !force && !sure && tab !== S.tab) {
    const ask = typeof customConfirm === 'function' ? customConfirm({ title: 'Leave this round?', message: 'Answers you already gave still count toward your mastery.', confirmText: 'Leave round', cancelText: 'Keep going' }) : Promise.resolve(true);
    ask.then(ok => { if (ok) setTab(tab, { sure: true }); else syncTabs(); });
    return;
  }
  endSession(); stopTour();
  S.tab = tab; syncTabs();
  $('#study-view')?.setAttribute('data-tab', tab);
  if (location.hash.startsWith('#study')) history.replaceState(null, '', '#study/' + tab);
  renderTab();
}
function syncTabs() { $$('.sa-tabs button').forEach(b => { const on = b.dataset.tab === S.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }); }
function renderTab() {
  clearHl(); clearMarks(); S.paintLayer.clearLayers(); S.onClick = null; hidePrompt();
  if (S.tab !== 'explore') $('#sa-info')?.classList.add('hidden');
  renderPins(); renderDock();
  const panel = $('#sa-panel'); panel.scrollTop = 0;
  if (!S.places.length && S.set.kind === 'tour') { panel.innerHTML = `<div class="sa-empty"><div class="sa-empty-art"><span class="sa-spin"></span></div><h3>Unrolling the map…</h3><p>The tour's places are on their way.</p></div>`; return; }
  if (!S.places.length) { panel.innerHTML = emptyState(); bindEmpty(); icons(); return; }
  ({ explore: renderExplore, learn: renderLearnHome, flash: renderFlashHome, test: renderTestHome, blank: renderBlankHome, records: renderRecords }[S.tab] || renderExplore)();
  icons();
}
function emptyState() {
  return `<div class="sa-empty"><div class="sa-empty-art"><i data-lucide="map-pin-plus"></i></div><h3>This list is empty</h3>
  <p>${S.set.kind === 'mine' ? 'Add places to <b>My Map</b> in Private Charts, or paste a whole list here.' : 'Paste a list of places to build this set.'}</p>
  <div class="sa-row-btns"><button class="sa-btn go" data-new><i data-lucide="sparkles"></i>Paste a list</button>${S.set.kind === 'mine' ? `<button class="sa-btn" data-charts><i data-lucide="compass"></i>Private Charts</button>` : ''}</div></div>`;
}
function bindEmpty() { $('#sa-panel [data-new]')?.addEventListener('click', () => openCreate(S.set.kind === 'mine' ? { target: 'mine' } : {})); $('#sa-panel [data-charts]')?.addEventListener('click', () => switchView('custom-loc-view')); }
function panelHead(title, sub, icon) { return `<div class="sa-ph"><div class="sa-ph-ic"><i data-lucide="${icon}"></i></div><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div></div>`; }
const chips = (name, opts, cur) => `<div class="sa-chips" data-chips="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
function bindChips(root, name, fn) { $$(`[data-chips="${name}"] button`, root).forEach(b => b.onclick = () => { $$(`[data-chips="${name}"] button`, root).forEach(x => x.classList.toggle('on', x === b)); fn(b.dataset.v); sfx('tick'); }); }

// ---------- EXPLORE ----------
function renderExplore() {
  const st = setStats(); const pct = st.total ? Math.round(100 * st.studied / st.total) : 0;
  $('#sa-panel').innerHTML = `
    <div class="sa-ex-head"><span>Your field index</span><span class="sa-mono">${st.total} places</span></div>
    <label class="sa-search"><i data-lucide="search"></i><input id="sa-search" type="search" placeholder="Search name or number…" autocomplete="off" value="${esc(S.search)}"></label>
    ${chips('sort', [['num', '1–N'], ['az', 'A–Z'], ['type', 'Type'], ['todo', 'To do']], S.sort)}
    <div class="sa-studied"><span>${st.studied} of ${st.total} studied</span><span class="sa-mono">${pct}%</span></div>
    <div class="sa-bar"><i style="width:${pct}%"></i></div>
    <div class="sa-mastery-strip" title="Every place, coloured by mastery">${S.places.map(p => `<i class="m${mOf(p)}" title="${esc(p.name)}"></i>`).join('')}</div>
    <div class="sa-list" id="sa-list"></div>
    <div class="sa-ex-foot">
      <div class="sa-kpis"><div><b>${st.mastered}</b><small>Mastered</small></div><div><b>${st.learning}</b><small>Learning</small></div><div><b>${st.fresh}</b><small>New</small></div></div>
      <div class="sa-ex-meta"><span>Accuracy: ${st.acc == null ? '—' : st.acc + '%'}</span><span>Tests: ${st.tests}</span></div>
      <div class="sa-quick"><button class="sa-btn go" data-go="learn"><i data-lucide="graduation-cap"></i>Learn</button><button class="sa-btn" data-go="flash"><i data-lucide="layers"></i>Cards</button><button class="sa-btn" data-go="test"><i data-lucide="clipboard-check"></i>Test</button></div>
    </div>`;
  const panel = $('#sa-panel');
  bindChips(panel, 'sort', v => { S.sort = v; renderList(); });
  const input = $('#sa-search');
  input.oninput = () => { S.search = input.value; renderList(); };
  input.onkeydown = e => {
    if (e.key !== 'Enter') return;
    const first = $('#sa-list .sa-row');
    if (window.heroCommand && window.heroCommand(input.value)) { input.value = ''; S.search = ''; renderList(); return; }
    if (first) first.click();
  };
  $$('[data-go]', panel).forEach(b => b.onclick = () => setTab(b.dataset.go));
  renderList();
}
function renderList() {
  const q = NK(S.search); let list = S.places.slice();
  if (q) list = list.filter(p => String(p.n) === q || NK(p.name).includes(q) || (p.aliases || []).some(a => NK(a).includes(q)) || NK(p.type).includes(q));
  if (S.sort === 'az') list.sort((a, b) => a.name.localeCompare(b.name));
  else if (S.sort === 'type') list.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  else if (S.sort === 'todo') list.sort((a, b) => mOf(a) - mOf(b) || a.n - b.n);
  const el = $('#sa-list'); if (!el) return;
  el.innerHTML = list.length ? list.map(p => { const m = mOf(p); return `<button type="button" class="sa-row${S.sel === p ? ' is-sel' : ''}" data-key="${esc(p.key)}"><span class="sa-num m${m}">${p.n}</span><span class="sa-row-t"><b>${esc(p.name)}</b><small>${esc(p.type)} · ${STATUS(m)}</small></span><span class="sa-pips">${[1, 2, 3].map(k => `<i class="${m >= k ? 'on' : ''}"></i>`).join('')}</span></button>`; }).join('')
    : `<div class="sa-none">No places match “${esc(S.search)}”.</div>`;
  $$('.sa-row', el).forEach(r => r.onclick = () => { stopTour(); const p = S.places.find(x => x.key === r.dataset.key); if (p) select(p, { quiet: true }); });
}

// ---------- shared question helpers ----------
function distractors(p, n) {
  const sameType = shuffle(S.places.filter(x => x !== p && x.type === p.type));
  const others = shuffle(S.places.filter(x => x !== p && x.type !== p.type));
  let names = [...sameType, ...others].map(x => x.name);
  if (names.length < n) names = names.concat(shuffle(A.GAZETTEER.filter(g => g.type === p.type && NK(g.name) !== NK(p.name)).map(g => g.name)));
  return shuffle([p.name, ...[...new Set(names)].filter(x => NK(x) !== NK(p.name)).slice(0, n - 1)]);
}
function gradeClickAt(p, lat, lng, factor = 1) {
  const g = resolveGeo(p);
  const atlas = A.gradeClick(lat, lng, p, factor);
  if (g) {
    if (geoContains(g.feats, lat, lng)) return { correct: true, close: true, distanceKm: 0, inside: true };
    const d = geoDistanceKm(g.feats, lat, lng); const tol = 70 * factor;
    const ok = d <= tol || (/ocean/i.test(p.type) && atlas.correct);
    return { correct: ok, close: d <= tol * 3, distanceKm: Math.min(d, ok ? d : Infinity) };
  }
  return atlas;
}
function clickMark(latlng, ok, p, distanceKm) {
  const icon = L.divIcon({ className: 'sa-click-wrap', html: `<div class="sa-click ${ok ? 'ok' : 'bad'}"><i></i></div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
  L.marker(latlng, { icon, pane: 'saMarks', interactive: false }).addTo(S.markLayer);
  if (!ok && p) {
    const target = nearestPoint(p, latlng);
    L.polyline([latlng, target], { pane: 'saMarks', className: 'sa-miss-line', interactive: false }).addTo(S.markLayer);
    if (Number.isFinite(distanceKm) && distanceKm > 0) L.marker([(latlng.lat + target[0]) / 2, (latlng.lng + target[1]) / 2], { pane: 'saMarks', interactive: false, icon: L.divIcon({ className: 'sa-dist-wrap', html: `<span class="sa-dist">${esc(A.formatDistance(distanceKm))} off</span>`, iconSize: [0, 0] }) }).addTo(S.markLayer);
  }
}
function nearestPoint(p, latlng) {
  const g = resolveGeo(p); if (!g) return [p.lat, p.lng];
  let best = [p.lat, p.lng], bd = Infinity;
  g.feats.forEach(f => ringsOf(f.geometry).flat().forEach(r => r.forEach(([x, y]) => { const d = (x - latlng.lng) ** 2 + (y - latlng.lat) ** 2; if (d < bd) { bd = d; best = [y, x]; } })));
  return best;
}
function showPrompt(html, cls = '') { const el = $('#sa-prompt'); el.className = `sa-prompt ${cls}`; el.innerHTML = html; icons(); }
function hidePrompt() { $('#sa-prompt')?.classList.add('hidden'); }
function endSession() { if (S.session?.timer) clearInterval(S.session.timer); S.session = null; S.onClick = null; hidePrompt(); }
function weighted(places, n) {
  const ps = P(S.set.key).places; const pool = places.map(p => { const r = ps[p.key] || { m: 0, w: 0 }; return { p, w: 1 + (3 - r.m) * 1.5 + Math.min(r.w, 6) * .5 }; });
  const out = [];
  while (out.length < n && pool.length) { const tot = pool.reduce((s, x) => s + x.w, 0); let r = Math.random() * tot, i = 0; for (; i < pool.length - 1; i++) { r -= pool[i].w; if (r <= 0) break; } out.push(pool.splice(i, 1)[0].p); }
  return out;
}
function viewForQuestion(p) {
  // Frame the question around the whole set so the answer's position is not given away.
  const pts = S.places.map(x => [x.lat, x.lng]); const b = L.latLngBounds(pts);
  if (p) b.extend([p.lat, p.lng]);
  cam(() => S.map.flyToBounds(b.pad(.06), { padding: [24, 24], maxZoom: 5, duration: reducedMotion() ? 0 : .7 }));
}

// ---------- LEARN ----------
const LEVELS = [['Meet', 'book-open', 'A short teach card'], ['Recognize', 'eye', 'Pick its name from four'], ['Locate', 'crosshair', 'Find it on a blank map'], ['Recall', 'keyboard', 'Type the name from memory']];
function learnState() { return P(S.set.key).learn; }
function renderLearnHome() {
  const st = setStats(); const ls = learnState();
  const resumable = ls && ls.items?.some(i => i.lvl < 4);
  $('#sa-panel').innerHTML = `
    ${panelHead('Learn', 'Small batches. Each place climbs four levels until it sticks.', 'graduation-cap')}
    <ol class="sa-levels">${LEVELS.map(([t, ic, d], i) => `<li style="--i:${i}"><span class="sa-lv-ic"><i data-lucide="${ic}"></i></span><span><b>${i + 1}. ${t}</b><small>${d}</small></span></li>`).join('')}</ol>
    <p class="sa-note"><i data-lucide="rotate-ccw"></i>Miss one and it drops a level. The four weakest places from earlier batches are mixed in as review.</p>
    <div class="sa-field"><label>Batch size</label>${chips('batch', [[5, '5'], [10, '10'], [15, '15'], [20, '20']], prefs.batch)}</div>
    <div class="sa-progress-card"><div><b>${st.mastered}</b> of ${st.total} learned</div><div class="sa-bar"><i style="width:${st.total ? 100 * st.mastered / st.total : 0}%"></i></div></div>
    <div class="sa-row-btns">
      ${resumable ? `<button class="sa-btn go" data-resume><i data-lucide="play"></i>Resume batch (${ls.items.filter(i => i.lvl >= 4).length}/${ls.items.length})</button><button class="sa-btn" data-start><i data-lucide="sparkles"></i>New batch</button>`
      : `<button class="sa-btn go big" data-start><i data-lucide="sparkles"></i>${st.mastered >= st.total ? 'Review the set' : 'Start learning'}</button>`}
    </div>`;
  const panel = $('#sa-panel');
  bindChips(panel, 'batch', v => { prefs.batch = +v; savePrefs(); });
  panel.querySelector('[data-start]').onclick = () => startLearn(true);
  panel.querySelector('[data-resume]')?.addEventListener('click', () => startLearn(false));
  fitAll();
}
function startLearn(fresh) {
  const ps = P(S.set.key).places;
  if (fresh || !learnState()) {
    let next = S.places.filter(p => (ps[p.key]?.m || 0) < 3).slice(0, prefs.batch);
    if (!next.length) next = shuffle(S.places).slice(0, prefs.batch); // everything learned: review round
    const review = S.places.filter(p => !next.includes(p) && ps[p.key]?.seen && (ps[p.key]?.m || 0) < 3).sort((a, b) => (ps[a.key].m - ps[b.key].m) || (ps[b.key].w - ps[a.key].w)).slice(0, 4);
    P(S.set.key).learn = { items: [...next.map(p => ({ key: p.key, lvl: (ps[p.key]?.m || 0) >= 3 ? 1 : 0 })), ...review.map(p => ({ key: p.key, lvl: 1, review: true }))], started: Date.now() };
    saveProg();
  }
  S.session = { kind: 'learn', live: false, last: null, streak: 0 };
  nextLearn();
}
function nextLearn() {
  clearTimeout(S.session?.auto);
  const ls = learnState(); if (!ls) return renderLearnHome();
  const open = ls.items.filter(i => i.lvl < 4);
  if (!open.length) return learnDone();
  // Lowest level first, but never the same place twice in a row when there is a choice.
  const minLvl = Math.min(...open.map(i => i.lvl));
  let pool = open.filter(i => i.lvl <= minLvl + 1); if (pool.length > 1) pool = pool.filter(i => i.key !== S.session.last);
  const item = pool[Math.floor(Math.random() * Math.min(pool.length, 3))];
  const p = S.places.find(x => x.key === item.key); if (!p) { item.lvl = 4; return nextLearn(); }
  S.session.last = item.key; S.session.item = item; S.session.p = p;
  clearHl(); clearMarks(); hidePrompt(); S.onClick = null;
  learnFrame(ls, item, p);
}
function learnFrame(ls, item, p) {
  const done = ls.items.filter(i => i.lvl >= 4).length;
  const head = `<div class="sa-session-top"><button class="sa-link" data-quit><i data-lucide="arrow-left"></i>Learn</button><span class="sa-mono">${done}/${ls.items.length} learned</span></div>
    <div class="sa-batch">${ls.items.map(i => { const q = S.places.find(x => x.key === i.key); return `<span class="lv${Math.min(i.lvl, 4)}${i === item ? ' cur' : ''}" title="${esc(q?.name || '')}"></span>`; }).join('')}</div>`;
  const lvl = item.lvl; const panel = $('#sa-panel');
  const lvTag = `<div class="sa-lvtag"><i data-lucide="${LEVELS[lvl][1]}"></i>Level ${lvl + 1} · ${LEVELS[lvl][0]}${item.review ? ' · review' : ''}</div>`;
  if (lvl === 0) {
    outline(p, 'focus'); flyTo(p);
    panel.innerHTML = head + `<div class="sa-qcard sa-teach">${lvTag}<div class="sa-teach-kicker">New place</div><h2 class="sa-big">${esc(p.name)}</h2>
      <div class="sa-tags"><span>${esc(p.type)}</span>${p.region ? `<span>${esc(p.region)}</span>` : ''}</div>
      ${p.description ? `<p class="sa-desc">${esc(p.description)}</p>` : ''}${p.why ? `<div class="sa-why"><i data-lucide="sparkles"></i><span><b>Why it matters</b>${esc(p.why)}</span></div>` : ''}
      <p class="sa-hint"><i data-lucide="scan-line"></i>The glowing outline on the map is where ${esc(p.name)} starts and stops.</p>
      <button class="sa-btn go big" data-ok>Got it <kbd>Enter</kbd></button></div>`;
    panel.querySelector('[data-ok]').onclick = () => { item.lvl = 1; rec(p).m = Math.max(rec(p).m, 1); rec(p).seen++; saveProg(); nextLearn(); };
  } else if (lvl === 1) {
    outline(p, 'focus'); flyTo(p, { maxZoom: 5, pad: 90 });
    const opts = distractors(p, 4);
    panel.innerHTML = head + `<div class="sa-qcard">${lvTag}<h3 class="sa-q">What is the outlined place?</h3>
      <div class="sa-options">${opts.map((o, i) => `<button type="button" data-o="${esc(o)}"><kbd>${i + 1}</kbd>${esc(o)}</button>`).join('')}</div><div class="sa-feedback" id="sa-fb"></div></div>`;
    $$('.sa-options button', panel).forEach(b => b.onclick = () => answerOption(b, b.dataset.o === p.name, p, ok => learnAnswer(item, p, ok)));
  } else if (lvl === 2) {
    viewForQuestion(p);
    showPrompt(`<small>Find on the map</small><b>${esc(p.name)}</b>`, 'is-find');
    panel.innerHTML = head + `<div class="sa-qcard">${lvTag}<h3 class="sa-q">Click where <b>${esc(p.name)}</b> is.</h3><p class="sa-sub">${esc(p.type)}${p.region ? ` · ${esc(p.region)}` : ''}</p><div class="sa-feedback" id="sa-fb"></div>
      <button class="sa-link" data-reveal><i data-lucide="eye"></i>Show me</button></div>`;
    S.onClick = ll => { S.onClick = null; const g = gradeClickAt(p, ll.lat, ll.lng, 1.4); clickMark(ll, g.correct, p, g.distanceKm); outline(p, g.correct ? 'ok' : 'bad'); flyTo(p, { maxZoom: 5, pad: 110 }); learnAnswer(item, p, g.correct, g.correct ? '' : `${A.formatDistance(g.distanceKm)} away.`); };
    panel.querySelector('[data-reveal]').onclick = () => { S.onClick = null; outline(p, 'reveal'); flyTo(p); learnAnswer(item, p, false, 'Here it is.'); };
  } else {
    outline(p, 'focus'); flyTo(p, { maxZoom: 5, pad: 90 });
    panel.innerHTML = head + `<div class="sa-qcard">${lvTag}<h3 class="sa-q">Name the outlined place</h3>
      <form class="sa-typed" id="sa-typed"><input id="sa-answer" autocomplete="off" spellcheck="false" placeholder="Type its name…"><button class="sa-btn go" type="submit">Check</button></form>
      <div class="sa-feedback" id="sa-fb"></div><button class="sa-link" data-skip><i data-lucide="help-circle"></i>I don't know</button></div>`;
    const input = $('#sa-answer'); setTimeout(() => input.focus(), 60);
    $('#sa-typed').onsubmit = e => { e.preventDefault(); if (!input.value.trim()) return; const ok = A.answerMatches(input.value, p.name, p.aliases); input.disabled = true; learnAnswer(item, p, ok, ok ? '' : `It's <b>${esc(p.name)}</b>.`); };
    panel.querySelector('[data-skip]').onclick = () => { input.disabled = true; learnAnswer(item, p, false, `It's <b>${esc(p.name)}</b>.`); };
  }
  panel.querySelector('[data-quit]').onclick = () => { endSession(); renderLearnHome(); };
  icons();
}
function answerOption(btn, ok, p, done) {
  const wrap = btn.parentElement; if (wrap.dataset.done) return; wrap.dataset.done = '1';
  $$('button', wrap).forEach(b => { b.disabled = true; if (b.dataset.o === p.name) b.classList.add('ok'); });
  if (!ok) btn.classList.add('bad');
  done(ok);
}
function learnAnswer(item, p, ok, extra = '') {
  const ls = learnState(); const fb = $('#sa-fb'); hidePrompt();
  if (ok) { item.lvl++; S.session.streak++; sfx('ok'); } else { item.lvl = Math.max(0, item.lvl - 1); S.session.streak = 0; sfx('bad'); }
  const learned = ok && item.lvl >= 4;
  grade(p, ok, learned ? 'learned' : 'learn');
  if (learned) { burst(); }
  saveProg(); renderRing();
  if (fb) {
    fb.className = `sa-feedback show ${ok ? 'ok' : 'bad'}`;
    fb.innerHTML = `<div><b>${learned ? `Learned! ${esc(p.name)} is yours.` : ok ? pick(['Correct!', 'Nice!', 'Spot on!', 'Yes!']) : 'Not quite.'}</b>${extra ? `<span>${extra}</span>` : ''}${S.session.streak >= 3 ? `<em class="sa-streak">${FLAME} ${S.session.streak} in a row</em>` : ''}</div>
      <button class="sa-btn go" data-next>Continue <kbd>Enter</kbd></button>`;
    fb.querySelector('[data-next]').onclick = () => nextLearn();
    if (ok && !learned && item.lvl !== 3) S.session.auto = setTimeout(() => { if (S.session?.item === item) nextLearn(); }, 1400);
    icons();
  }
  void ls;
}
const pick = a => a[Math.floor(Math.random() * a.length)];
function learnDone() {
  const ls = learnState(); const n = ls.items.length; P(S.set.key).learn = null; saveProg(); endSession(); sfx('win'); burst(true);
  const st = setStats();
  $('#sa-panel').innerHTML = `<div class="sa-celebrate"><div class="sa-medal"><i data-lucide="party-popper"></i></div><h2>Batch complete!</h2><p>${n} places climbed all four levels. ${st.mastered} of ${st.total} in this set are now mastered.</p>
    <div class="sa-row-btns"><button class="sa-btn go big" data-next><i data-lucide="sparkles"></i>${st.mastered >= st.total ? 'Review round' : 'Next batch'}</button><button class="sa-btn" data-test><i data-lucide="clipboard-check"></i>Test yourself</button></div></div>`;
  $('#sa-panel [data-next]').onclick = () => startLearn(true); $('#sa-panel [data-test]').onclick = () => setTab('test');
  // Paint what was learned.
  S.places.forEach(p => { if (mOf(p) >= 3) outline(p, 'm3', S.paintLayer, { rings: false }); }); fitAll(); icons();
}

// ---------- FLASHCARDS ----------
function renderFlashHome() {
  const st = setStats();
  $('#sa-panel').innerHTML = `${panelHead('Flashcards', 'Flip, grade yourself honestly, repeat. Missed cards come back three cards later.', 'layers')}
    <div class="sa-field"><label>Card style</label>${chips('fmode', [['where', 'Where is it?'], ['what', 'What is this?'], ['mixed', 'Mixed']], prefs.flash)}</div>
    <div class="sa-field"><label>Deck</label>${chips('fdeck', [['all', `All ${st.total}`], ['learning', `Not mastered (${st.total - st.mastered})`]], prefs.flashDeck)}</div>
    <div class="sa-flash-demo"><div class="sa-card3d demo"><div class="face front"><small>Where is it?</small><b>Strait of Gibraltar</b></div></div><div class="sa-card3d demo b"><div class="face front"><small>What is this?</small><i data-lucide="scan-line"></i></div></div></div>
    <div class="sa-row-btns"><button class="sa-btn go big" data-start><i data-lucide="play"></i>Shuffle &amp; start</button></div>
    <p class="sa-note"><i data-lucide="keyboard"></i>Space flips · 1 missed it · 2 got it</p>`;
  const panel = $('#sa-panel');
  bindChips(panel, 'fmode', v => { prefs.flash = v; savePrefs(); });
  bindChips(panel, 'fdeck', v => { prefs.flashDeck = v; savePrefs(); });
  panel.querySelector('[data-start]').onclick = startFlash; fitAll();
}
function startFlash() {
  let deck = prefs.flashDeck === 'learning' ? S.places.filter(p => mOf(p) < 3) : S.places.slice();
  if (!deck.length) { toast('Everything here is mastered. Showing the whole deck.', 'success'); deck = S.places.slice(); }
  deck = shuffle(deck).map(p => ({ p, mode: prefs.flash === 'mixed' ? (Math.random() < .5 ? 'where' : 'what') : prefs.flash }));
  S.session = { kind: 'flash', live: true, deck, i: 0, got: 0, missed: 0, missedSet: new Set(), flipped: false, total: deck.length };
  flashCard();
}
function flashCard() {
  const s = S.session; if (s.i >= s.deck.length) return flashDone();
  const { p, mode } = s.deck[s.i]; s.flipped = false; clearHl(); clearMarks();
  if (mode === 'what') { outline(p, 'focus'); flyTo(p, { maxZoom: 5, pad: 90 }); } else viewForQuestion(p);
  const front = mode === 'where' ? `<small>Where is it?</small><b>${esc(p.name)}</b><em>${esc(p.type)}</em>` : `<small>What is this?</small><i data-lucide="scan-line"></i><em>Look at the outlined place</em>`;
  const back = `<small>${mode === 'where' ? 'Here it is' : 'It is'}</small><b>${esc(p.name)}</b><em>${esc(p.type)}${p.region ? ` · ${esc(p.region)}` : ''}</em>${p.description ? `<p>${esc(p.description)}</p>` : ''}`;
  $('#sa-panel').innerHTML = `<div class="sa-session-top"><button class="sa-link" data-quit><i data-lucide="arrow-left"></i>Flashcards</button><span class="sa-mono">${s.i + 1} / ${s.deck.length}</span></div>
    <div class="sa-bar thin"><i style="width:${100 * s.i / s.deck.length}%"></i></div>
    <div class="sa-flash-score"><span class="bad"><i data-lucide="x"></i>${s.missed}</span><span class="ok"><i data-lucide="check"></i>${s.got}</span></div>
    <button type="button" class="sa-card3d" id="sa-card" aria-label="Flip card"><div class="face front">${front}<span class="sa-tap">Tap or press Space to flip</span></div><div class="face back">${back}</div></button>
    <div class="sa-grade hidden" id="sa-grade"><button class="sa-btn bad" data-g="0"><i data-lucide="x"></i>Missed it <kbd>1</kbd></button><button class="sa-btn ok" data-g="1"><i data-lucide="check"></i>Got it <kbd>2</kbd></button></div>`;
  const card = $('#sa-card');
  card.onclick = () => flipFlash();
  $$('#sa-grade button').forEach(b => b.onclick = () => gradeFlash(b.dataset.g === '1'));
  $('#sa-panel [data-quit]').onclick = () => { endSession(); renderFlashHome(); };
  icons();
}
function flipFlash() {
  const s = S.session; if (!s || s.kind !== 'flash') return; const { p, mode } = s.deck[s.i];
  s.flipped = !s.flipped; $('#sa-card').classList.toggle('flipped', s.flipped); sfx('flip');
  if (s.flipped) { $('#sa-grade').classList.remove('hidden'); if (mode === 'where') { clearHl(); outline(p, 'focus'); flyTo(p); } }
}
function gradeFlash(ok) {
  const s = S.session; if (!s?.flipped) return; const cur = s.deck[s.i];
  grade(cur.p, ok, 'flash'); renderRing();
  if (ok) { s.got++; sfx('ok'); } else { s.missed++; s.missedSet.add(cur.p); sfx('bad'); s.deck.splice(Math.min(s.deck.length, s.i + 4), 0, { ...cur }); }
  s.i++; flashCard();
}
function flashDone() {
  const s = S.session; const missed = [...s.missedSet]; endSession(); sfx('win'); if (!missed.length) burst(true); else burst();
  $('#sa-panel').innerHTML = `<div class="sa-celebrate"><div class="sa-medal"><i data-lucide="${missed.length ? 'layers' : 'trophy'}"></i></div><h2>${missed.length ? 'Deck finished' : 'Flawless deck!'}</h2>
    <p>${s.total} cards · ${s.got} got on the way · ${missed.length} needed another look.</p>
    ${missed.length ? `<div class="sa-chiplist">${missed.map(p => `<span>${esc(p.name)}</span>`).join('')}</div>` : ''}
    <div class="sa-row-btns">${missed.length ? `<button class="sa-btn go" data-missed><i data-lucide="rotate-ccw"></i>Review missed</button>` : ''}<button class="sa-btn${missed.length ? '' : ' go'}" data-again><i data-lucide="shuffle"></i>New shuffle</button></div></div>`;
  $('#sa-panel [data-again]').onclick = startFlash;
  $('#sa-panel [data-missed]')?.addEventListener('click', () => { S.session = { kind: 'flash', live: true, deck: shuffle(missed).map(p => ({ p, mode: prefs.flash === 'mixed' ? (Math.random() < .5 ? 'where' : 'what') : prefs.flash })), i: 0, got: 0, missed: 0, missedSet: new Set(), total: missed.length }; flashCard(); });
  icons();
}

// ---------- TEST ----------
const DIFF = { easy: { f: 2.0, opts: 4, label: 'Easy' }, medium: { f: 1.3, opts: 6, label: 'Medium' }, hard: { f: .85, opts: 8, label: 'Hard' } };
const KINDS = { type: 'Type the name', find: 'Find on map', choose: 'Multiple choice', mixed: 'Mixed' };
function renderTestHome() {
  const t = prefs.test; const n = S.places.length;
  const best = P(S.set.key).tests.slice().sort((a, b) => b.acc - a.acc || a.time - b.time)[0];
  $('#sa-panel').innerHTML = `${panelHead('Test', 'Timed and scored. Questions lean toward the places you know least.', 'clipboard-check')}
    <div class="sa-field"><label>Questions</label>${chips('tcount', [[10, '10'], [20, '20'], [30, '30'], [50, '50'], ['all', `All ${n}`]].filter(([v]) => v === 'all' || v < n), t.count)}</div>
    <div class="sa-field"><label>Difficulty</label>${chips('tdiff', Object.entries(DIFF).map(([k, v]) => [k, v.label]), t.diff)}<small class="sa-help" id="sa-diffhelp"></small></div>
    <div class="sa-field"><label>Question type</label>${chips('tkind', Object.entries(KINDS), t.kind)}</div>
    ${best ? `<div class="sa-best"><i data-lucide="trophy"></i><span>Best: <b>${best.acc}%</b> in ${fmtTime(best.time)} · ${best.n} questions</span></div>` : ''}
    <div class="sa-row-btns"><button class="sa-btn go big" data-start><i data-lucide="timer"></i>Start test</button></div>`;
  const panel = $('#sa-panel');
  const help = () => { const d = DIFF[prefs.test.diff]; $('#sa-diffhelp').textContent = `Map clicks: ${d.f >= 2 ? 'generous' : d.f >= 1.3 ? 'fair' : 'tight'} tolerance · ${d.opts} choices`; };
  bindChips(panel, 'tcount', v => { prefs.test.count = v === 'all' ? 'all' : +v; savePrefs(); });
  bindChips(panel, 'tdiff', v => { prefs.test.diff = v; savePrefs(); help(); });
  bindChips(panel, 'tkind', v => { prefs.test.kind = v; savePrefs(); });
  help(); panel.querySelector('[data-start]').onclick = () => startTest(); fitAll();
}
function startTest(only) {
  const t = prefs.test; const n = only ? only.length : t.count === 'all' ? S.places.length : Math.min(+t.count, S.places.length);
  const qs = (only ? shuffle(only) : weighted(S.places, n)).map(p => ({ p, kind: t.kind === 'mixed' ? pick(['type', 'find', 'choose']) : t.kind }));
  S.session = { kind: 'test', live: true, qs, i: 0, correct: 0, streak: 0, best: 0, start: Date.now(), elapsed: 0, diff: t.diff, mode: t.kind, answered: false };
  S.session.timer = setInterval(() => { const s = S.session; if (!s || s.kind !== 'test') return; s.elapsed = Math.floor((Date.now() - s.start) / 1000); const el = $('#sa-clock'); if (el) el.textContent = fmtTime(s.elapsed); }, 500);
  testQuestion();
}
function testQuestion() {
  const s = S.session; if (s.i >= s.qs.length) return testDone();
  const q = s.qs[s.i]; const p = q.p; s.answered = false; clearHl(); clearMarks(); hidePrompt(); S.onClick = null;
  const d = DIFF[s.diff];
  const top = `<div class="sa-session-top"><button class="sa-link" data-quit><i data-lucide="x"></i>End</button><span class="sa-test-meta"><span><i data-lucide="timer"></i><b id="sa-clock">${fmtTime(s.elapsed)}</b></span><span class="sa-flame${s.streak >= 3 ? ' hot' : ''}">${FLAME} ${s.streak}</span><span class="sa-mono">${s.i + 1}/${s.qs.length}</span></span></div>
    <div class="sa-bar thin"><i style="width:${100 * s.i / s.qs.length}%"></i></div>`;
  let body = '';
  if (q.kind === 'find') {
    viewForQuestion(p); showPrompt(`<small>Find on the map</small><b>${esc(p.name)}</b>`, 'is-find');
    body = `<h3 class="sa-q">Click where <b>${esc(p.name)}</b> is.</h3><p class="sa-sub">${esc(p.type)}</p>`;
    S.onClick = ll => { if (s.answered) return; S.onClick = null; const g = gradeClickAt(p, ll.lat, ll.lng, d.f); clickMark(ll, g.correct, p, g.distanceKm); outline(p, g.correct ? 'ok' : 'bad'); flyTo(p, { maxZoom: 5, pad: 110 }); testAnswer(g.correct, g.correct ? (g.inside ? 'Right inside the borders.' : 'Close enough to count.') : `${esc(p.name)} was ${A.formatDistance(g.distanceKm)} away.`); };
  } else if (q.kind === 'choose') {
    outline(p, 'focus'); flyTo(p, { maxZoom: 5, pad: 90 });
    const opts = distractors(p, d.opts);
    body = `<h3 class="sa-q">What is the outlined place?</h3><div class="sa-options${opts.length > 4 ? ' many' : ''}">${opts.map((o, i) => `<button type="button" data-o="${esc(o)}"><kbd>${i + 1}</kbd>${esc(o)}</button>`).join('')}</div>`;
  } else {
    outline(p, 'focus'); flyTo(p, { maxZoom: 5, pad: 90 });
    body = `<h3 class="sa-q">Name the outlined place</h3><form class="sa-typed" id="sa-typed"><input id="sa-answer" autocomplete="off" spellcheck="false" placeholder="Type its name…"><button class="sa-btn go" type="submit">Check</button></form>`;
  }
  $('#sa-panel').innerHTML = top + `<div class="sa-qcard"><div class="sa-lvtag"><i data-lucide="${q.kind === 'find' ? 'crosshair' : q.kind === 'choose' ? 'list' : 'keyboard'}"></i>${KINDS[q.kind]}</div>${body}<div class="sa-feedback" id="sa-fb"></div>${q.kind !== 'choose' ? `<button class="sa-link" data-skip><i data-lucide="skip-forward"></i>Skip</button>` : ''}</div>`;
  const panel = $('#sa-panel');
  if (q.kind === 'choose') $$('.sa-options button', panel).forEach(b => b.onclick = () => answerOption(b, b.dataset.o === p.name, p, ok => testAnswer(ok, ok ? '' : `It was <b>${esc(p.name)}</b>.`)));
  if (q.kind === 'type') { const input = $('#sa-answer'); setTimeout(() => input.focus(), 60); $('#sa-typed').onsubmit = e => { e.preventDefault(); if (!input.value.trim() || s.answered) return; const ok = A.answerMatches(input.value, p.name, p.aliases); input.disabled = true; testAnswer(ok, ok ? (NK(input.value) !== NK(p.name) ? `Accepted: <b>${esc(p.name)}</b>.` : '') : `It was <b>${esc(p.name)}</b>.`, input.value); }; }
  panel.querySelector('[data-skip]')?.addEventListener('click', () => { if (s.answered) return; S.onClick = null; hidePrompt(); outline(p, 'reveal'); flyTo(p); testAnswer(false, `Skipped. It was <b>${esc(p.name)}</b>.`); });
  panel.querySelector('[data-quit]').onclick = () => { if (s.i === 0 && !s.answered) { endSession(); return renderTestHome(); } testDone(true); };
  icons();
}
function testAnswer(ok, msg = '', typed = '') {
  const s = S.session; if (!s || s.answered) return; s.answered = true; hidePrompt();
  const q = s.qs[s.i]; q.ok = ok; q.typed = typed;
  grade(q.p, ok, 'test'); renderRing();
  if (ok) { s.correct++; s.streak++; s.best = Math.max(s.best, s.streak); sfx('ok'); if (s.streak > 0 && s.streak % 5 === 0) burst(); } else { s.streak = 0; sfx('bad'); }
  const fb = $('#sa-fb');
  fb.className = `sa-feedback show ${ok ? 'ok' : 'bad'}`;
  fb.innerHTML = `<div><b>${ok ? pick(['Correct!', 'Nailed it!', 'Yes!', 'Spot on!']) : 'Missed.'}</b>${msg ? `<span>${msg}</span>` : ''}${s.streak >= 3 ? `<em class="sa-streak">${FLAME} ${s.streak} in a row</em>` : ''}</div><button class="sa-btn go" data-next>${s.i + 1 >= s.qs.length ? 'See results' : 'Next'} <kbd>Enter</kbd></button>`;
  fb.querySelector('[data-next]').onclick = () => { clearTimeout(s.auto); s.i++; testQuestion(); };
  if (ok) s.auto = setTimeout(() => { if (S.session === s && s.answered) { s.i++; testQuestion(); } }, 1300);
  $('.sa-test-meta .sa-flame') && ($('.sa-test-meta .sa-flame').innerHTML = `${FLAME} ${s.streak}`);
}
function testDone(early = false) {
  const s = S.session; clearTimeout(s.auto); const answered = s.qs.filter(q => q.ok !== undefined);
  endSession(); if (!answered.length) return renderTestHome();
  const acc = Math.round(100 * s.correct / answered.length);
  const recd = { acc, n: answered.length, correct: s.correct, time: s.elapsed, diff: s.diff, kind: s.mode, best: s.best, date: Date.now(), early };
  const tests = P(S.set.key).tests; tests.push(recd); tests.sort((a, b) => b.acc - a.acc || a.time - b.time); P(S.set.key).tests = tests.slice(0, 50); saveProg();
  const rank = P(S.set.key).tests.indexOf(recd) + 1;
  sfx(acc >= 60 ? 'win' : 'tick'); if (acc >= 80) burst(true);
  const missed = answered.filter(q => !q.ok).map(q => q.p);
  clearHl(); answered.forEach(q => outline(q.p, q.ok ? 'm3' : 'paint-bad', S.paintLayer, { rings: false })); fitAll();
  const c = 2 * Math.PI * 52;
  $('#sa-panel').innerHTML = `<div class="sa-results">
    <div class="sa-bigring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="bg"/><circle cx="60" cy="60" r="52" class="fg ${acc >= 80 ? 'ok' : acc >= 50 ? 'mid' : 'bad'}" style="stroke-dasharray:${c};stroke-dashoffset:${c}" data-off="${c * (1 - acc / 100)}"/></svg><div><b>${acc}%</b><small>accuracy</small></div></div>
    <h2>${acc === 100 ? 'Perfect score!' : acc >= 80 ? 'Excellent work!' : acc >= 50 ? 'Good progress' : 'Keep going'}</h2>
    <div class="sa-kpis"><div><b>${s.correct}/${answered.length}</b><small>Correct</small></div><div><b>${fmtTime(s.elapsed)}</b><small>Time</small></div><div><b>${s.best}</b><small>Best streak</small></div></div>
    <p class="sa-sub">${rank === 1 ? `${TROPHY} New personal best for this set!` : `#${rank} in your records`} · ${DIFF[s.diff].label} · ${KINDS[s.mode]}</p>
    <div class="sa-review">${answered.map((q, i) => `<button type="button" class="sa-rv ${q.ok ? 'ok' : 'bad'}" data-i="${i}"><i data-lucide="${q.ok ? 'check' : 'x'}"></i><span>${esc(q.p.name)}</span><small>${KINDS[q.kind]}</small></button>`).join('')}</div>
    <div class="sa-row-btns">${missed.length ? `<button class="sa-btn go" data-missed><i data-lucide="rotate-ccw"></i>Retake ${missed.length} missed</button>` : ''}<button class="sa-btn${missed.length ? '' : ' go'}" data-new><i data-lucide="refresh-cw"></i>New test</button><button class="sa-btn" data-rec><i data-lucide="trophy"></i>Records</button></div></div>`;
  requestAnimationFrame(() => setTimeout(() => { const fg = $('.sa-bigring .fg'); if (fg) fg.style.strokeDashoffset = fg.dataset.off; }, 60));
  const panel = $('#sa-panel');
  $$('.sa-rv', panel).forEach(b => b.onclick = () => { const q = answered[+b.dataset.i]; clearHl(); outline(q.p, q.ok ? 'ok' : 'bad'); flyTo(q.p); });
  panel.querySelector('[data-missed]')?.addEventListener('click', () => startTest(missed));
  panel.querySelector('[data-new]').onclick = renderTestHome; panel.querySelector('[data-rec]').onclick = () => setTab('records');
  icons();
}

// ---------- BLANK MAP ----------
function renderBlankHome() {
  const n = S.places.length; const best = (P(S.set.key).blank || []).slice().sort((a, b) => b.score - a.score || a.time - b.time)[0];
  $('#sa-panel').innerHTML = `${panelHead('Blank map', 'No pins, no labels. Paint the whole map one place at a time.', 'map')}
    <div class="sa-blank-art"><span></span><span></span><span></span><span></span><span></span><span></span></div>
    <p class="sa-note"><i data-lucide="paintbrush"></i>Each right answer fills in green. A miss shows the real outline in red so you learn it on the spot.</p>
    <div class="sa-field"><label>Places</label>${chips('bcount', [[10, '10'], [20, '20'], ['all', `All ${n}`]].filter(([v]) => v === 'all' || v < n), prefs.blankCount)}</div>
    ${best ? `<div class="sa-best"><i data-lucide="trophy"></i><span>Best: <b>${best.score}/${best.n}</b> in ${fmtTime(best.time)}</span></div>` : ''}
    <div class="sa-row-btns"><button class="sa-btn go big" data-start><i data-lucide="brush"></i>Start painting</button></div>`;
  bindChips($('#sa-panel'), 'bcount', v => { prefs.blankCount = v === 'all' ? 'all' : +v; savePrefs(); });
  $('#sa-panel [data-start]').onclick = startBlank; fitAll();
}
function startBlank() {
  const n = prefs.blankCount === 'all' ? S.places.length : Math.min(+prefs.blankCount, S.places.length);
  const order = (n >= S.places.length ? shuffle(S.places) : weighted(S.places, n));
  S.session = { kind: 'blank', live: true, order, i: 0, score: 0, start: Date.now(), elapsed: 0, results: [] };
  S.session.timer = setInterval(() => { const s = S.session; if (!s || s.kind !== 'blank') return; s.elapsed = Math.floor((Date.now() - s.start) / 1000); const el = $('#sa-clock'); if (el) el.textContent = fmtTime(s.elapsed); }, 500);
  S.paintLayer.clearLayers(); fitAll(); blankStep();
}
function blankStep() {
  const s = S.session; if (s.i >= s.order.length) return blankDone();
  const p = s.order[s.i]; clearMarks();
  showPrompt(`<small>${s.i + 1} of ${s.order.length} · find</small><b>${esc(p.name)}</b><button type="button" class="sa-prompt-skip" data-skip title="Skip">Skip</button>`, 'is-find big');
  $('#sa-prompt [data-skip]').onclick = e => { e.stopPropagation(); blankAnswer(p, null); };
  $('#sa-panel').innerHTML = `<div class="sa-session-top"><button class="sa-link" data-quit><i data-lucide="x"></i>End</button><span class="sa-test-meta"><span><i data-lucide="timer"></i><b id="sa-clock">${fmtTime(s.elapsed)}</b></span><span class="sa-mono">${s.score} painted</span></span></div>
    <div class="sa-bar thin"><i style="width:${100 * s.i / s.order.length}%"></i></div>
    <div class="sa-blank-now"><small>Now find</small><b>${esc(p.name)}</b><span>${esc(p.type)}</span></div>
    <div class="sa-blank-list">${s.order.map((q, i) => { const r = s.results[i]; return `<span class="${r === undefined ? (i === s.i ? 'cur' : '') : r ? 'ok' : 'bad'}">${r === undefined && i !== s.i ? '?' : esc(q.name)}</span>`; }).join('')}</div>`;
  $('#sa-panel [data-quit]').onclick = () => blankDone(true);
  S.onClick = ll => blankAnswer(p, ll);
  icons();
}
function blankAnswer(p, ll) {
  const s = S.session; if (!s) return; S.onClick = null;
  let ok = false, g = null;
  if (ll) { g = gradeClickAt(p, ll.lat, ll.lng, 1.3); ok = g.correct; clickMark(ll, ok, p, g.distanceKm); }
  s.results[s.i] = ok; if (ok) s.score++;
  grade(p, ok, 'test'); renderRing();
  outline(p, ok ? 'paint-ok' : 'paint-bad', S.paintLayer, { rings: false });
  clearHl(); outline(p, ok ? 'ok' : 'bad');
  sfx(ok ? 'ok' : 'bad'); if (ok && s.score % 10 === 0) burst();
  showPrompt(`<small>${ok ? 'Painted!' : ll ? `${esc(A.formatDistance(g.distanceKm))} off` : 'Skipped'}</small><b>${esc(p.name)}</b>`, `is-find big ${ok ? 'ok' : 'bad'}`);
  setTimeout(() => { if (S.session !== s) return; clearHl(); s.i++; blankStep(); }, ok ? 750 : 1500);
}
function blankDone(early = false) {
  const s = S.session; const n = s.results.length; endSession(); clearMarks(); clearHl();
  if (n) { const b = P(S.set.key).blank = P(S.set.key).blank || []; b.push({ score: s.score, n, time: s.elapsed, date: Date.now(), early }); saveProg(); }
  const pct = n ? Math.round(100 * s.score / n) : 0; sfx('win'); if (pct >= 80) burst(true);
  // Show the finished painting: everything answered, plus untouched places faintly.
  s.order.forEach((p, i) => { if (s.results[i] === undefined) outline(p, 'm0', S.paintLayer, { rings: false }); });
  fitAll();
  $('#sa-panel').innerHTML = `<div class="sa-celebrate"><div class="sa-medal"><i data-lucide="brush"></i></div><h2>${pct === 100 ? 'A perfect map!' : 'Your painted map'}</h2>
    <p><b>${s.score}</b> of ${n} painted in ${fmtTime(s.elapsed)} (${pct}%).</p>
    <div class="sa-legend"><span class="ok">Found</span><span class="bad">Missed</span>${early ? '<span class="m0">Not reached</span>' : ''}</div>
    <div class="sa-row-btns"><button class="sa-btn go big" data-again><i data-lucide="brush"></i>Paint again</button></div></div>`;
  $('#sa-panel [data-again]').onclick = renderBlankHome; icons();
}

// ---------- RECORDS ----------
function renderRecords() {
  const P0 = P(S.set.key); const tests = P0.tests || []; const blanks = (P0.blank || []).slice().sort((a, b) => b.score / b.n - a.score / a.n || a.time - b.time);
  const st = setStats();
  $('#sa-panel').innerHTML = `${panelHead('Records', 'Your best rounds on this set, kept in this browser.', 'trophy')}
    <div class="sa-kpis boxed"><div><b>${st.mastered}</b><small>Mastered</small></div><div><b>${st.acc == null ? '—' : st.acc + '%'}</b><small>Accuracy</small></div><div><b>${tests.length}</b><small>Tests</small></div></div>
    <button class="sa-btn wide" data-paint><i data-lucide="paintbrush"></i>Paint my mastery map</button>
    <h4 class="sa-h4">Tests</h4>
    <div class="sa-board">${tests.length ? tests.slice(0, 10).map((t, i) => `<div class="sa-brow"><span class="sa-rank r${i + 1}">${i + 1}</span><span><b>${t.acc}%</b> · ${t.correct}/${t.n}<small>${DIFF[t.diff]?.label || ''} · ${KINDS[t.kind] || ''} · ${new Date(t.date).toLocaleDateString()}</small></span><span class="sa-mono">${fmtTime(t.time)}</span></div>`).join('') : '<p class="sa-none">No tests yet. Your first one sets the bar.</p>'}</div>
    <h4 class="sa-h4">Blank map</h4>
    <div class="sa-board">${blanks.length ? blanks.slice(0, 5).map((t, i) => `<div class="sa-brow"><span class="sa-rank r${i + 1}">${i + 1}</span><span><b>${t.score}/${t.n}</b> painted<small>${new Date(t.date).toLocaleDateString()}</small></span><span class="sa-mono">${fmtTime(t.time)}</span></div>`).join('') : '<p class="sa-none">No painted maps yet.</p>'}</div>
    <button class="sa-link danger" data-reset><i data-lucide="eraser"></i>Reset progress for this set</button>`;
  const panel = $('#sa-panel');
  panel.querySelector('[data-paint]').onclick = () => { S.paintLayer.clearLayers(); clearHl(); S.places.forEach(p => outline(p, 'm' + mOf(p), S.paintLayer, { rings: false })); fitAll(); toast('Green: mastered · gold: learning · grey: new', 'info'); };
  panel.querySelector('[data-reset]').onclick = async () => {
    const ok = typeof customConfirm === 'function' ? await customConfirm({ title: 'Reset progress?', message: `Mastery, tests and painted maps for “${S.set.title}” will be cleared on this browser.`, confirmText: 'Reset', danger: true }) : confirm('Reset progress for this set?');
    if (!ok) return; delete prog.sets[S.set.key]; LS.set(K_PROG, prog); renderRing(); renderTab(); toast('Progress reset.', 'success');
  };
}

// ---------- keyboard ----------
function onKey(e) {
  if (document.body.dataset.view !== 'study-view' || !$('#sa-modal')?.classList.contains('hidden')) { if (e.key === 'Escape') closeModal(); return; }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  const s = S.session;
  if (e.key === 'Enter' && !typing) { const nb = $('#sa-panel [data-next]') || $('#sa-panel [data-ok]'); if (nb) { e.preventDefault(); nb.click(); return; } }
  if (typing) return;
  if (s?.kind === 'flash') {
    if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); flipFlash(); }
    else if (e.key === '1' || e.key === 'ArrowLeft') gradeFlash(false); else if (e.key === '2' || e.key === 'ArrowRight') gradeFlash(true);
    return;
  }
  if (/^[1-8]$/.test(e.key)) { const b = $$('#sa-panel .sa-options button')[+e.key - 1]; if (b && !b.disabled) b.click(); return; }
  if (S.tab === 'explore' && !s) { if (e.key === 'ArrowRight') { stopTour(); stepTour(1); } else if (e.key === 'ArrowLeft') { stopTour(); stepTour(-1); } else if (e.key === 'Escape') closeInfo(); }
}

// ---------- modals: set picker / create / import ----------
function openModal(html, wide = false) { const m = $('#sa-modal'); $('#sa-modal-card').innerHTML = html; $('#sa-modal-card').classList.toggle('wide', wide); m.classList.remove('hidden'); $('#study-view')?.classList.add('sa-modal-open'); icons(); }
function closeModal() { $('#sa-modal')?.classList.add('hidden'); $('#study-view')?.classList.remove('sa-modal-open'); }
function openSetPicker() {
  const sets = allSets();
  openModal(`<div class="sa-mhead"><h3>Study sets</h3><button class="sa-x" data-close aria-label="Close"><i data-lucide="x"></i></button></div>
    <div class="sa-setlist">${sets.map(s => { const n = s.locs.length; const st = n ? setStats(s.key, s.locs.map((l, i) => ({ key: NK(l.name) || 'p' + i }))) : { mastered: 0 }; const pct = n ? Math.round(100 * st.mastered / n) : 0; return `
      <div class="sa-setitem${S.set?.key === s.key ? ' on' : ''}" data-key="${esc(s.key)}">
        <button class="sa-setmain" data-open="${esc(s.key)}"><span class="sa-set-ic"><i data-lucide="${s.icon}"></i></span><span class="sa-set-t"><b>${esc(s.title)}</b><small>${esc(s.sub)} · ${n} place${n === 1 ? '' : 's'}</small><span class="sa-bar thin"><i style="width:${pct}%"></i></span></span><span class="sa-mono">${pct}%</span></button>
        <div class="sa-set-acts">${n ? `<button title="Export .atlas.json" data-export="${esc(s.key)}"><i data-lucide="download"></i></button>` : ''}${s.kind === 'set' ? `<button title="Rename" data-rename="${esc(s.id)}"><i data-lucide="pencil"></i></button><button title="Delete" data-del="${esc(s.id)}"><i data-lucide="trash-2"></i></button>` : ''}${s.kind === 'mine' ? `<button title="Edit in Private Charts" data-charts><i data-lucide="pencil"></i></button>` : ''}</div>
      </div>`; }).join('')}</div>
    <div class="sa-mfoot"><button class="sa-btn go" data-new><i data-lucide="sparkles"></i>New set from a list</button><label class="sa-btn"><i data-lucide="upload"></i>Import .atlas.json<input type="file" accept=".json,application/json" hidden data-import></label></div>`);
  const card = $('#sa-modal-card');
  card.querySelector('[data-close]').onclick = closeModal;
  $$('[data-open]', card).forEach(b => b.onclick = () => { closeModal(); loadSet(b.dataset.open); });
  $$('[data-export]', card).forEach(b => b.onclick = () => exportSet(sets.find(s => s.key === b.dataset.export)));
  $$('[data-del]', card).forEach(b => b.onclick = async () => { const set = userSets().find(s => s.id === b.dataset.del); if (!set) return; const ok = typeof customConfirm === 'function' ? await customConfirm({ title: 'Delete study set?', message: `“${set.title}” and its progress will be removed from this browser.`, confirmText: 'Delete', danger: true }) : confirm('Delete?'); if (!ok) return; saveUserSets(userSets().filter(s => s.id !== set.id)); delete prog.sets['set:' + set.id]; LS.set(K_PROG, prog); if (S.set?.key === 'set:' + set.id) loadSet('tour:default'); openSetPicker(); renderHomeProgress(); });
  $$('[data-rename]', card).forEach(b => b.onclick = () => {
    const sets2 = userSets(); const set = sets2.find(x => x.id === b.dataset.rename); if (!set) return;
    const item = b.closest('.sa-setitem'); const main = item.querySelector('.sa-setmain'); if (item.querySelector('.sa-rename')) return;
    const inp = document.createElement('input'); inp.className = 'sa-rename'; inp.maxLength = 80; inp.value = set.title; inp.setAttribute('aria-label', 'Set name');
    main.hidden = true; main.after(inp); inp.focus(); inp.select();
    let done = false;
    const finish = save => { if (done) return; done = true; const name = inp.value.trim(); if (save && name) { set.title = name.slice(0, 80); saveUserSets(sets2); if (S.set?.key === 'set:' + set.id) { S.set.title = set.title; $('#sa-set-title').textContent = set.title; } main.querySelector('.sa-set-t b').textContent = set.title; } inp.remove(); main.hidden = false; };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
  });
  card.querySelector('[data-charts]')?.addEventListener('click', () => { closeModal(); switchView('custom-loc-view'); });
  card.querySelector('[data-new]').onclick = () => openCreate();
  card.querySelector('[data-import]').onchange = e => importFile(e.target.files[0]);
}
function exportSet(s) {
  const places = (s.locs || []).map((l, i) => enrich(l, i, s));
  const payload = { atlas: 1, geomaster: 1, hero: 1, name: s.title, locations: places.map(p => ({ name: p.name, type: p.type, lat: p.lat, lng: p.lng, radiusKm: p.radiusKm, region: p.region, description: p.description, whyItMatters: p.why, aliases: p.aliases, approximate: !p.bboxes && !p.path, bboxes: p.bboxes || null, path: p.path || null })) };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  a.download = `${s.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '') || 'study-set'}.atlas.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Exported. Atlas can import this file too.', 'success');
}
async function importFile(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.locations;
    const items = (list || []).filter(l => l && l.name && Number.isFinite(+l.lat) && Number.isFinite(+l.lng)).map((l, i) => ({ id: 'loc_' + Date.now().toString(36) + i, name: String(l.name).slice(0, 120), category: l.type || l.category || 'Place', type: l.type || l.category || 'Place', lat: +l.lat, lng: +l.lng, region: l.region || '', description: l.description || '', why: l.whyItMatters || l.why || '', aliases: Array.isArray(l.aliases) ? l.aliases : [], radiusKm: +l.radiusKm || undefined, bboxes: l.bboxes || undefined, path: l.path || undefined }));
    if (!items.length) throw new Error('empty');
    const id = Date.now().toString(36); const sets = userSets(); sets.push({ id, title: String(data.name || file.name.replace(/\.atlas\.json$|\.json$/i, '') || 'Imported set').slice(0, 80), items, created: Date.now() }); saveUserSets(sets);
    closeModal(); toast(`Imported ${items.length} places.`, 'success'); loadSet('set:' + id, { keepTab: false });
  } catch (e) { toast('That file is not an Atlas or Hero study set.', 'error'); }
}
function parseList(text) { return [...new Set(String(text || '').split(/\n|;|,(?![^(]*\))/).map(s => s.replace(/^\s*(\d+[.)]\s*|[-*•]\s*)/, '').trim()).filter(Boolean))].slice(0, 300); }
function openCreate({ target = 'set', text = '' } = {}) {
  openModal(`<div class="sa-mhead"><h3>${target === 'mine' ? 'Add a list to My Map' : 'New study set'}</h3><button class="sa-x" data-close aria-label="Close"><i data-lucide="x"></i></button></div>
    ${target === 'mine' ? '' : `<label class="sa-flabel">Name<input id="sa-new-title" maxlength="80" placeholder="e.g. Unit 3: Ancient Mediterranean"></label>`}
    <label class="sa-flabel">Places <small>one per line or separated by commas</small><textarea id="sa-new-list" rows="7" placeholder="Nile River&#10;Mesopotamia&#10;Strait of Hormuz&#10;Carthage&#10;Mount Olympus">${esc(text)}</textarea></label>
    <div class="sa-resolve" id="sa-resolve"><p class="sa-none">Places are matched instantly against Atlas’s gazetteer of ${A.GAZETTEER.length} seas, rivers, countries, empires and landmarks.</p></div>
    <div class="sa-mfoot"><button class="sa-btn" data-online hidden><i data-lucide="globe"></i>Look up the rest online</button><button class="sa-btn go" data-save disabled><i data-lucide="check"></i>${target === 'mine' ? 'Add to My Map' : 'Create set'}</button></div>`, true);
  const card = $('#sa-modal-card'); const ta = $('#sa-new-list'); let resolved = [];
  card.querySelector('[data-close]').onclick = closeModal;
  const refresh = () => {
    const names = parseList(ta.value); const prev = new Map(resolved.map(r => [r.q, r]));
    resolved = names.map(q => { if (prev.has(q)) return prev.get(q); const r = A.lookupGazetteer(q); if (r.status === 'resolved') return { q, loc: r.resolved, st: 'ok' }; if (r.status === 'ambiguous') return { q, loc: r.options[0], options: r.options, st: 'amb' }; return { q, st: 'none' }; });
    const ok = resolved.filter(r => r.loc).length, none = resolved.filter(r => !r.loc).length;
    $('#sa-resolve').innerHTML = names.length ? `<div class="sa-resolve-sum"><span class="ok">${ok} matched</span>${none ? `<span class="bad">${none} not found</span>` : ''}</div><div class="sa-chiplist">${resolved.map((r, i) => `<span class="${r.st}" title="${r.loc ? esc(`${r.loc.type} · ${r.loc.region}`) : 'Not in the gazetteer'}">${r.loc ? `<i data-lucide="${r.st === 'amb' ? 'help-circle' : 'check'}"></i>` : '<i data-lucide="x"></i>'}${esc(r.loc ? r.loc.name : r.q)}${r.loc ? `<small>${esc(r.loc.type)}</small>` : ''}${r.options ? `<select data-amb="${i}">${r.options.map((o, k) => `<option value="${k}">${esc(o.region || o.type)}</option>`).join('')}</select>` : ''}</span>`).join('')}</div>`
      : '<p class="sa-none">Paste or type a list to see matches.</p>';
    $$('[data-amb]', card).forEach(sel => sel.onchange = () => { const r = resolved[+sel.dataset.amb]; r.loc = r.options[+sel.value]; });
    card.querySelector('[data-save]').disabled = !ok; card.querySelector('[data-online]').hidden = !none; icons();
  };
  ta.oninput = refresh; refresh(); setTimeout(() => (target === 'mine' ? ta : $('#sa-new-title')).focus(), 50);
  card.querySelector('[data-online]').onclick = async e => {
    const btn = e.currentTarget; btn.disabled = true; btn.innerHTML = '<span class="sa-spin"></span>Looking up…';
    for (const r of resolved.filter(x => !x.loc)) {
      try { const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(r.q)}`); const d = await res.json(); if (d[0]) { r.loc = { name: d[0].name || r.q, type: (d[0].type || 'Place').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), lat: +d[0].lat, lng: +d[0].lon, radiusKm: 60, region: (d[0].display_name || '').split(',').slice(-1)[0].trim(), description: '', whyItMatters: '', aliases: [] }; r.st = 'web'; } } catch (err) { /* offline */ }
      await new Promise(res => setTimeout(res, 1100)); // Nominatim usage policy: max 1 request per second
    }
    btn.disabled = false; btn.innerHTML = '<i data-lucide="globe"></i>Look up the rest online'; refresh();
  };
  card.querySelector('[data-save]').onclick = () => {
    const items = resolved.filter(r => r.loc).map((r, i) => ({ id: 'loc_' + Date.now().toString(36) + i, name: r.loc.name, category: r.loc.type, type: r.loc.type, lat: r.loc.lat, lng: r.loc.lng, region: r.loc.region || '', description: r.loc.description || '', why: r.loc.whyItMatters || '', aliases: r.loc.aliases || [], radiusKm: r.loc.radiusKm, ...(r.loc.bboxes ? { bboxes: r.loc.bboxes } : {}), ...(r.loc.path ? { path: r.loc.path } : {}) }));
    if (target === 'mine') {
      const have = new Set(customLocations.map(l => NK(l.name))); const add = items.filter(l => !have.has(NK(l.name)));
      customLocations.push(...add); localStorage.setItem(QUIZZES[yearMode].custom, JSON.stringify(customLocations));
      if (typeof renderUserCustomList === 'function') renderUserCustomList(true);
      closeModal(); toast(`Added ${add.length} place${add.length === 1 ? '' : 's'} to My Map.`, 'success'); loadSet('mine:' + yearMode, { keepTab: false }); return;
    }
    const title = ($('#sa-new-title').value.trim() || 'My study set').slice(0, 80);
    const id = Date.now().toString(36); const sets = userSets(); sets.push({ id, title, items, created: Date.now() }); saveUserSets(sets);
    closeModal(); burst(); toast(`“${title}” created with ${items.length} places.`, 'success');
    if (document.body.dataset.view !== 'study-view') openStudy('explore', 'set:' + id); else loadSet('set:' + id, { keepTab: false });
  };
}

// ---------- entry points ----------
async function openStudy(tab, setKey) {
  build();
  if (tab && TABS.some(t => t[0] === tab)) S.tab = tab;
  S.loading = true;
  try {
    if (document.body.dataset.view !== 'study-view') switchView('study-view');
    const want = setKey || S.set?.key || prefs.lastSet || 'tour:' + yearMode;
    if (!S.set || S.set.key !== want || setKey) await loadSet(allSets().some(s => s.key === want) ? want : 'tour:default');
    else setTab(S.tab, { force: true });
  } finally { S.loading = false; }
  S.opened = true;
  setTimeout(() => { S.map.invalidateSize(); layoutPins(); }, 280);
}
window.openStudy = openStudy;
window.openStudyCreate = opts => { build(); openCreate(opts); };
// Keep the view in sync with routing, data and year changes.
const _svStudy = switchView;
switchView = function (id) {
  if (document.body.dataset.view === 'study-view' && id !== 'study-view') { stopTour(); if (S.session?.timer) { clearInterval(S.session.timer); } endSession(); if (location.hash.startsWith('#study')) history.replaceState(null, '', location.pathname + location.search); }
  _svStudy(id);
  if (id === 'study-view') { build(); if (!S.set && !S.loading) openStudy(); setTimeout(() => S.map?.invalidateSize(), 280); if (!location.hash.startsWith('#study')) history.replaceState(null, '', '#study/' + S.tab); }
};
window.addEventListener('hero-location-data-ready', e => {
  renderHomeProgress();
  if (S.set?.kind === 'tour' && S.set.tour === e.detail?.yearMode && !S.session) { const keep = S.set.key; if (document.body.dataset.view === 'study-view') loadSet(keep); else S.set = null; }
});
function routeHash() { const m = location.hash.match(/^#study(?:\/(\w+))?/); if (m) openStudy(m[1] || 'explore'); }
window.addEventListener('hashchange', routeHash);
if (location.hash.startsWith('#study')) {
  const go = () => setTimeout(routeHash, 300);
  if (store.default.locs.length) go(); else window.addEventListener('hero-location-data-ready', go, { once: true });
}

// ---------- home page card ----------
function renderHomeProgress() {
  const el = document.getElementById('study-home-progress'); if (!el) return;
  const s = store[yearMode]; const key = 'tour:' + yearMode; const locs = s?.locs || [];
  if (!locs.length) { el.innerHTML = ''; return; }
  const st = setStats(key, locs.map((l, i) => ({ key: NK(l.name) || 'p' + i })));
  const pct = Math.round(100 * st.mastered / st.total);
  el.innerHTML = `<div class="sh-strip">${locs.map((l, i) => { const r = P(key).places[NK(l.name) || 'p' + i]; return `<i class="m${r?.m || 0}"></i>`; }).join('')}</div><div class="sh-meta"><span><b>${st.mastered}</b> of ${st.total} mastered · ${esc(s.title)}</span><span>${st.studied ? `${pct}%` : 'Start with Learn'}</span></div>`;
}
document.addEventListener('DOMContentLoaded', renderHomeProgress); setTimeout(renderHomeProgress, 0);

// ---------- Hero quiz map: same three styles ----------
let quizHolder = {};
function quizStyleApply() { if (typeof map === 'undefined' || !map) return; if (tileLayer) { try { map.removeLayer(tileLayer); } catch (e) { /* gone */ } tileLayer = null; } applyMapStyle(map, quizHolder, prefs.style, prefs.borders); }
if (typeof initMap === 'function') { const _im = initMap; initMap = function () { _im.apply(this, arguments); quizHolder = {}; quizStyleApply(); }; }
new MutationObserver(() => { if (typeof map !== 'undefined' && map && quizHolder.borders) quizHolder.borders.setStyle(borderStyle(prefs.style, prefs.borders || prefs.style === 'solid')); }).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
toggleMapStyle = function () {
  prefs.style = STYLE_ORDER[(STYLE_ORDER.indexOf(prefs.style) + 1) % STYLE_ORDER.length]; savePrefs();
  quizStyleApply(); syncLayerButtons(); toast(`Map: ${STYLES[prefs.style].label}${prefs.style === 'solid' ? ' (one colour with borders)' : ''}`, 'info');
};

// ---------- Private Charts: instant gazetteer adds + study shortcuts ----------
if (typeof userAddPlace === 'function') {
  const _uap = userAddPlace;
  userAddPlace = async function () {
    const nameEl = document.getElementById('user-place-name'); const name = nameEl.value.trim(); if (!name) return _uap();
    const r = A.lookupGazetteer(name);
    if (r.status !== 'resolved') return _uap();
    const g = r.resolved; const cat = document.getElementById('user-place-category').value.trim() || g.type;
    if (customLocations.some(l => NK(l.name) === NK(g.name))) return toast(`${g.name} is already on My Map.`, 'info');
    customLocations.push({ id: 'loc_' + Date.now(), name: g.name, category: cat, type: g.type, lat: g.lat, lng: g.lng, region: g.region, description: g.description, why: g.whyItMatters, aliases: g.aliases, radiusKm: g.radiusKm, ...(g.bboxes ? { bboxes: g.bboxes } : {}), ...(g.path ? { path: g.path } : {}) });
    localStorage.setItem(QUIZZES[yearMode].custom, JSON.stringify(customLocations));
    renderUserCustomList(); nameEl.value = ''; toast(`Added ${g.name} to My Map (${g.type}).`, 'success');
  };
}
})();
