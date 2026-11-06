import init, { Sim } from './pkg/regatta_web.js';

// ------------------------------------------------------------------ utilitaires
const $ = (s) => document.querySelector(s);
const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => {
  const l = clamp(lat, -85, 85) * D2R;
  return (1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2;
};
const invLon = (x) => x * 360 - 180;
const invLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / D2R;

function dm(v, pos, neg, w) {
  const h = v >= 0 ? pos : neg;
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = (a - d) * 60;
  if (m >= 59.995) { d += 1; m = 0; }
  return `${String(d).padStart(w, '0')}°${m.toFixed(2).padStart(5, '0')}'${h}`;
}
const fmtPos = (lat, lon) => `${dm(lat, 'N', 'S', 2)} ${dm(lon, 'E', 'W', 3)}`;
const pad2 = (n) => String(n).padStart(2, '0');
const fmtUtc = (t) => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
const fmtLocal = (t) => new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtDur = (s) => { const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); return `${d} j ${pad2(h)} h ${pad2(m)}`; };

/** Accepte « 39.04 », « -41.67 », « 39°N 02'19" », « 41°W 40'26" », « 39 02.31 N »… */
function parseCoord(str, isLat) {
  let s = String(str).trim().toUpperCase().replace(',', '.');
  if (!s) return null;
  const hemi = (s.match(/[NSEWO]/) || [])[0];
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return null;
  let v = nums[0] + (nums[1] || 0) / 60 + (nums[2] || 0) / 3600;
  if (hemi) {
    if (isLat && !'NS'.includes(hemi)) return null;
    if (!isLat && !'EWO'.includes(hemi)) return null;
  }
  if (/^-/.test(s) || hemi === 'S' || hemi === 'W' || hemi === 'O') v = -v;
  return Math.abs(v) > (isLat ? 90 : 180) ? null : v;
}

const WIND_STOPS = [[0, [40, 70, 120]], [5, [50, 130, 190]], [10, [60, 180, 170]], [15, [120, 200, 90]], [20, [240, 210, 60]], [25, [240, 140, 50]], [30, [230, 70, 70]], [40, [200, 60, 200]]];
function windColor(k) {
  for (let i = 1; i < WIND_STOPS.length; i++) {
    if (k <= WIND_STOPS[i][0]) {
      const [k0, c0] = WIND_STOPS[i - 1], [k1, c1] = WIND_STOPS[i];
      const f = (k - k0) / (k1 - k0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return WIND_STOPS[WIND_STOPS.length - 1][1];
}

const n360 = (a) => ((a % 360) + 360) % 360;
const n180 = (a) => { const x = n360(a); return x > 180 ? x - 360 : x; };
const pad3 = (n) => String(Math.round(n)).padStart(3, '0');
/** Distance (nm) et relèvement (°) approchés, suffisants pour l'affichage et la détection de passage. */
function distNm(la1, lo1, la2, lo2) {
  const dla = (la2 - la1) * 60, dlo = (lo2 - lo1) * 60 * Math.cos(((la1 + la2) / 2) * D2R);
  return Math.hypot(dla, dlo);
}
function bearingDeg(la1, lo1, la2, lo2) {
  const f1 = la1 * D2R, f2 = la2 * D2R, dl = (lo2 - lo1) * D2R;
  return n360(Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) / D2R);
}
/** Plus courte distance (nm) du point p au segment a→b (repère plan local). */
function segDistNm(a, b, p) {
  const k = Math.cos(((a.lat + b.lat) / 2) * D2R) * 60;
  const ax = a.lon * k, ay = a.lat * 60, bx = b.lon * k, by = b.lat * 60, px = p.lon * k, py = p.lat * 60;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / L, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ------------------------------------------------------------------ état
const S = {
  sim: null, worker: null, ready: false,
  data: { wind: null, land: null, polar: null },
  info: null, snap: null,
  scale: 600, running: false,
  view: { cx: 0.4, cy: 0.3, z: 3000 },
  layers: { wind: true, iso: true, route: true },
  follow: false, armPoint: false, waypoint: null,
  wps: [], seq: false, armWp: false, rerouteTimer: 0, reroutePending: false, prevPos: null,
  pilotT: [0, 0, 0], cmMode: 'hdg', pend: null,
  route: null, routeBusy: false, routeId: 0, lastAutoAt: -1e18,
  landPath: null, w: 0, h: 0, dpr: 1,
  wind: { key: '', at: 0, img: null, arrows: [] },
  uiAt: 0, infoAt: 0, hoverLL: null,
};
const SPEEDS = [[1, '×1'], [60, '×60'], [600, '×600'], [3600, '1 h/s'], [14400, '4 h/s'], [43200, '12 h/s']];

const canvas = $('#map');
const ctx = canvas.getContext('2d');

// ------------------------------------------------------------------ démarrage
async function boot() {
  try {
    setLoading('Chargement du moteur WebAssembly…');
    await init();
    setLoading('Chargement des côtes et du vent…');
    const [landResp, windResp] = await Promise.all([fetch('assets/land50.geojson'), fetch('wind.bin').catch(() => null)]);
    if (!landResp.ok) throw new Error('assets/land50.geojson introuvable');
    S.data.land = await landResp.text();
    S.data.wind = windResp && windResp.ok ? new Uint8Array(await windResp.arrayBuffer()) : null;
    buildLandPath(JSON.parse(S.data.land));
    buildSpeedButtons();
    bindUi();
    startWorker();
    createSim(null);
    resize();
    fitView();
    setLoading(null);
    requestAnimationFrame(frame);
  } catch (e) {
    $('#loadingTxt').textContent = 'Erreur au démarrage : ' + (e.message || e);
    $('.spin').style.display = 'none';
    console.error(e);
  }
}

function setLoading(txt) {
  if (txt === null) $('#loading').classList.add('done');
  else { $('#loading').classList.remove('done'); $('#loadingTxt').textContent = txt; }
}

function buildLandPath(geo) {
  const p = new Path2D();
  const ring = (r) => {
    r.forEach(([lon, lat], i) => { const x = mercX(lon), y = mercY(lat); i ? p.lineTo(x, y) : p.moveTo(x, y); });
    p.closePath();
  };
  for (const f of geo.features || [geo]) {
    const g = f.geometry || f;
    if (g.type === 'Polygon') g.coordinates.forEach(ring);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach((poly) => poly.forEach(ring));
  }
  S.landPath = p;
}

function startWorker(course) {
  S.worker?.terminate();
  S.worker = new Worker('worker.js', { type: 'module' });
  S.worker.onmessage = onWorkerMsg;
  S.worker.postMessage({ type: 'init', wind: S.data.wind, land: S.data.land, polar: S.data.polar, now: Date.now() / 1000, course });
}

function createSim(course) {
  try {
    S.sim?.free();
    S.sim = new Sim(S.data.wind ?? undefined, S.data.land ?? undefined, S.data.polar ?? undefined, Date.now() / 1000);
    if (course) S.sim.reset(course.sLat, course.sLon, course.fLat, course.fLon, Date.now() / 1000);
  } catch (e) {
    showDataErr(String(e.message || e));
    S.data.polar = null; S.data.wind = null;
    S.sim = new Sim(undefined, S.data.land ?? undefined, undefined, Date.now() / 1000);
  }
  S.info = JSON.parse(S.sim.info());
  S.snap = JSON.parse(S.sim.snapshot());
  S.route = null; S.waypoint = null; S.ready = false; S.running = false;
  S.lastAutoAt = -1e18;
  S.wps = []; S.seq = false; S.prevPos = null; S.reroutePending = false; S.primed = false; S.pend = null; S.gpxRoute = null; renderPend();
  $('#courseName').textContent = '';
  renderWpList();
  renderRoute();
  fillCourseInputs();
  updateBadges();
  showMapMsg();
}

function fillCourseInputs() {
  const i = S.info;
  $('#inSLat').value = dm(i.start.lat, 'N', 'S', 2); $('#inSLon').value = dm(i.start.lon, 'E', 'W', 3);
  $('#inFLat').value = dm(i.finish.lat, 'N', 'S', 2); $('#inFLon').value = dm(i.finish.lon, 'E', 'W', 3);
}

function onWorkerMsg(e) {
  const m = e.data;
  if (m.type === 'ready') {
    // Les adversaires suivent une route calculée rapidement depuis le départ ; ensuite la partie démarre.
    requestRoute({ ai: true, q: 0, lat: S.info.start.lat, lon: S.info.start.lon, t0: S.info.start_unix });
  } else if (m.type === 'route') {
    onRoute(m);
  } else if (m.type === 'error') {
    if (m.id === 'ai') { S.ready = true; S.running = true; S.scale = 600; syncSpeedBtns(); }
    S.routeBusy = false; $('#btnRoute').disabled = false;
    $('#routeStatus').textContent = 'Erreur du routeur : ' + m.message;
    if (S.reroutePending) scheduleReroute();
  }
}

// ------------------------------------------------------------------ compas : cap proposé, à valider
const pendHeading = (sn) => (S.pend.mode === 'hdg' ? n360(S.pend.v) : n360(sn.twd - S.pend.v));
function setPend(mode, v) {
  S.pend = { mode, v: mode === 'hdg' ? n360(Math.round(v)) : clamp(Math.round(n180(v)), -180, 180) };
  renderPend();
}
function cancelPend() { S.pend = null; renderPend(); }
function applyPend() {
  if (!S.pend) return;
  S.seq = false;
  if (S.pend.mode === 'hdg') S.sim.set_heading(S.pend.v); else S.sim.set_twa(S.pend.v);
  S.pend = null; renderPend();
}
function renderPend() {
  const box = $('#cmConfirm');
  box.classList.toggle('hidden', !S.pend);
  if (!S.pend || !S.snap) return;
  const h = pendHeading(S.snap), twa = n180(S.snap.twd - h);
  $('#cmPendTxt').textContent = `Nouveau cap ${pad3(h)}° · TWA ${twa >= 0 ? '+' : '−'}${Math.abs(Math.round(twa))}°` + (S.pend.mode === 'twa' ? ' (TWA verrouillé)' : '');
}

// ------------------------------------------------------------------ points de routage
const activeWps = () => S.wps.filter((w) => !w.done);

function addWp(lat, lon) {
  S.wps.push({ lat, lon, done: false });
  renderWpList(); scheduleReroute();
}
function removeWp(i) {
  S.wps.splice(i, 1);
  if (S.seq) { const n = activeWps()[0]; if (n) S.sim.set_waypoint(n.lat, n.lon); else { S.sim.set_waypoint_finish(); S.seq = false; } }
  renderWpList(); scheduleReroute();
}
/** Recalcule la route idéale peu après une modification des points (évite de lancer un calcul à chaque pixel de glisser). */
function scheduleReroute() {
  clearTimeout(S.rerouteTimer);
  S.rerouteTimer = setTimeout(() => {
    if (!S.ready) return;
    if (S.routeBusy) { S.reroutePending = true; return; }
    S.reroutePending = false;
    const s = S.snap;
    requestRoute({ q: Math.min(+$('#selQuality').value, 1), lat: s.lat, lon: s.lon, t0: s.now, follow: S.pilotT[0] === 5 });
  }, 350);
}

function renderWpList() {
  const ol = $('#wpList');
  const next = activeWps()[0];
  ol.innerHTML = S.wps.map((w, i) => `<li class="${w.done ? 'done' : ''} ${w === next ? 'next' : ''}" data-i="${i}"><span class="n">${i + 1}</span><span class="p">${fmtPos(w.lat, w.lon)}</span><span class="d"></span><button data-del="${i}" title="Supprimer">✕</button></li>`).join('');
  $('#wpHint').classList.toggle('hidden', S.wps.length > 0);
  $('#btnWpClear').disabled = S.wps.length === 0;
  updateWpDistances();
}
function updateWpDistances() {
  const sn = S.snap; if (!sn) return;
  let la = sn.lat, lo = sn.lon;
  S.wps.forEach((w, i) => {
    const el = $('#wpList').children[i]?.querySelector('.d');
    if (el) el.textContent = w.done ? 'passé' : `${distNm(la, lo, w.lat, w.lon).toFixed(0)} nm`;
    if (!w.done) { la = w.lat; lo = w.lon; }
  });
}
/** Détecte le passage d'un point (même à vitesse accélérée : on teste le segment parcouru entre deux images). */
function trackWps(sn) {
  const prev = S.prevPos || { lat: sn.lat, lon: sn.lon };
  const cur = { lat: sn.lat, lon: sn.lon };
  const w = activeWps()[0];
  if (w && segDistNm(prev, cur, w) < 2) {
    w.done = true;
    if (S.seq) { const n = activeWps()[0]; if (n) S.sim.set_waypoint(n.lat, n.lon); else { S.sim.set_waypoint_finish(); S.seq = false; } }
    renderWpList();
  }
  S.prevPos = cur;
}
function hitWp(px, py) {
  for (let i = S.wps.length - 1; i >= 0; i--) {
    const [x, y] = toScreen(S.wps[i].lat, S.wps[i].lon);
    if (Math.hypot(px - x, py - y) < 13) return i;
  }
  return -1;
}

// ------------------------------------------------------------------ routeur
function requestRoute({ ai = false, q, lat, lon, t0, auto = false, follow = false }) {
  if (S.routeBusy && !ai) return;
  const id = ai ? 'ai' : ++S.routeId;
  if (!ai) { S.routeBusy = true; S.routeAuto = auto; S.routeFollow = follow; S.routeStart = performance.now(); $('#btnRoute').disabled = true; }
  S.currentRouteId = ai ? S.currentRouteId : id;
  if (!ai) $('#routeStatus').textContent = 'Calcul en cours… (le jeu continue)';
  // la route idéale passe par les points de routage restants, dans l'ordre
  const wps = ai ? [] : activeWps().map((w) => ({ lat: w.lat, lon: w.lon }));
  S.worker.postMessage({ type: 'route', id, q, lat, lon, t0, wps });
}

function flatRoute(r) {
  const a = new Float64Array(r.points.length * 8);
  r.points.forEach((p, i) => a.set([p.t, p.lat, p.lon, p.heading, p.twa, p.tws, p.twd, p.speed], i * 8));
  return a;
}

function onRoute(m) {
  const r = JSON.parse(m.json);
  if (m.id === 'ai') {
    S.sim.set_ai_route_flat(flatRoute(r));
    S.ready = true; S.running = true; S.scale = 600; syncSpeedBtns();
    setLoading(null);
    if (S.afterReady) { const f = S.afterReady; S.afterReady = null; f(); }
    // route idéale affichée dès le départ (calcul rapide depuis la position de départ)
    if (!S.route && S.snap.now - S.info.start_unix < 60) { S.route = r; S.route.ms = m.ms; S.route.calcAt = S.snap.now; renderRoute(); }
    return;
  }
  if (m.id !== S.currentRouteId) return; // résultat périmé (partie réinitialisée)
  S.routeBusy = false;
  $('#btnRoute').disabled = false;
  S.route = r; S.route.ms = m.ms; S.route.calcAt = S.snap.now;
  if (S.sim.set_route_flat(flatRoute(r)) && (S.routeAuto || S.followAfter || S.routeFollow)) { S.sim.follow_route(); S.seq = false; }
  S.followAfter = false; S.routeFollow = false;
  renderRoute();
  if (S.reroutePending) scheduleReroute();
}

function renderRoute() {
  const r = S.route, sum = $('#routeSummary'), body = $('#routeTable tbody');
  body.innerHTML = '';
  if (!r) { sum.classList.add('hidden'); $('#routeStatus').textContent = 'Aucune route calculée.'; return; }
  sum.classList.remove('hidden');
  const eta = r.eta_unix;
  const lim = S.info.t_max;
  const nVia = r.wp_index ? r.wp_index.length : 0;
  sum.innerHTML = `<b>Route idéale${nVia ? ` via ${nVia} point${nVia > 1 ? 's' : ''}` : ''}</b><br>` +
    `<b>${r.reached ? 'Arrivée' : '⚠ Arrivée non atteinte'}</b> ${fmtLocal(eta)} <span class="muted">(${fmtUtc(eta)})</span><br>` +
    `Durée <b>${fmtDur(r.duration_s)}</b> · ${r.distance_nm.toFixed(0)} nm<br>` +
    `${r.tacks} virement(s), ${r.gybes} empannage(s)` +
    (lim && eta > lim ? `<br><span class="alert">Une partie de la route dépasse la prévision (${fmtUtc(lim)}) : vent figé au-delà.</span>` : '') +
    (!r.reached ? `<br><span class="alert">Reste ${r.best_dist_to_dest_nm.toFixed(0)} nm de l’arrivée au plus près.</span>` : '');
  $('#routeStatus').textContent = `Calculé en ${(r.ms / 1000).toFixed(1)} s (pas ${r.dt_s / 3600} h) depuis ${fmtLocal(r.points[0].t)}.`;
  // Tableau d'ordres : à l'heure du point k, on prend le cap/TWA du tronçon k→k+1.
  const P = r.points;
  let prevSign = 0;
  for (let k = 0; k < P.length - 1; k++) {
    const leg = P[k + 1];
    const sign = Math.sign(leg.twa);
    const tr = document.createElement('tr');
    if (prevSign && sign !== prevSign) tr.className = 'tackrow';
    prevSign = sign;
    tr.innerHTML = `<td>${fmtLocal(P[k].t)}</td><td>${fmtPos(P[k].lat, P[k].lon)}</td><td>${leg.heading.toFixed(0)}°</td><td>${leg.twa >= 0 ? '+' : ''}${leg.twa.toFixed(0)}°</td><td>${leg.tws.toFixed(0)}</td><td>${leg.sail}</td>`;
    body.appendChild(tr);
  }
}

function exportCsv() {
  const r = S.route;
  if (!r) return;
  const rows = ['heure_utc;heure_locale;lat;lon;cap;twa;vent_nds;vent_dir;vitesse_nds;voile'];
  for (let k = 0; k < r.points.length - 1; k++) {
    const p = r.points[k], leg = r.points[k + 1];
    rows.push([new Date(p.t * 1000).toISOString(), fmtLocal(p.t), p.lat.toFixed(4), p.lon.toFixed(4), leg.heading.toFixed(0), leg.twa.toFixed(0), leg.tws.toFixed(1), leg.twd.toFixed(0), leg.speed.toFixed(1), leg.sail].join(';'));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  a.download = 'route.csv';
  a.click();
}

// ------------------------------------------------------------------ interface
function buildSpeedButtons() {
  $('#speedBtns').innerHTML = SPEEDS.map(([v, l]) => `<button data-s="${v}">${l}</button>`).join('');
  $('#speedBtns').addEventListener('click', (e) => { const s = e.target.dataset?.s; if (s) { S.scale = +s; S.running = true; syncSpeedBtns(); } });
}
function syncSpeedBtns() {
  document.querySelectorAll('#speedBtns button').forEach((b) => b.classList.toggle('active', S.running && +b.dataset.s === S.scale));
  $('#btnPause').classList.toggle('active', !S.running);
}

function showDataErr(msg) { const e = $('#dataErr'); e.textContent = msg; e.classList.toggle('hidden', !msg); }

function updateBadges() {
  const b = $('#windBadge'), i = S.info;
  if (i.has_grid) {
    b.className = 'badge good';
    b.textContent = `Vent GFS · cycle ${fmtUtc(i.t_min).slice(0, 11)}Z · prévision jusqu’au ${fmtUtc(i.t_max).slice(0, 11)}`;
  } else {
    b.className = 'badge warn';
    b.textContent = 'Vent synthétique (pas de wind.bin : lance gribtool)';
  }
  $('#dataInfo').textContent = `Polaire : ${i.polar_name}. Côtes : ${i.has_land ? 'Natural Earth 1:50 m' : 'aucune'}.`;
}

function showMapMsg() {
  const m = $('#mapMsg'), i = S.info, s = S.snap;
  if (i && i.t_max && s && s.now > i.t_max) { m.textContent = 'Au-delà de la prévision : vent figé sur la dernière échéance'; m.classList.remove('hidden'); }
  else m.classList.add('hidden');
}

function bindUi() {
  $('#btnPause').onclick = () => { S.running = !S.running; syncSpeedBtns(); };
  addEventListener('keydown', (e) => { if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('#btnPause').click(); } });
  $('#btnHeading').onclick = () => { S.seq = false; S.sim.set_heading(+$('#inHeading').value); };
  $('#btnTwa').onclick = () => { S.seq = false; S.sim.set_twa(+$('#inTwa').value); };
  $('#btnVmgUp').onclick = () => { S.seq = false; S.sim.set_vmg(true); };
  $('#btnVmgDown').onclick = () => { S.seq = false; S.sim.set_vmg(false); };
  $('#btnFinish').onclick = () => { S.seq = false; S.waypoint = null; S.sim.set_waypoint_finish(); };
  const syncArm = () => {
    $('#btnPoint').classList.toggle('on', S.armPoint); $('#btnWpAdd').classList.toggle('on', S.armWp); $('#btnAddWp').classList.toggle('on', S.armWp);
    canvas.classList.toggle('arm', S.armPoint || S.armWp);
  };
  S.syncArm = syncArm;
  $('#btnPoint').onclick = () => { S.armPoint = !S.armPoint; S.armWp = false; syncArm(); };
  const toggleArmWp = () => { S.armWp = !S.armWp; S.armPoint = false; syncArm(); };
  $('#btnWpAdd').onclick = toggleArmWp; $('#btnAddWp').onclick = toggleArmWp;
  $('#btnWpClear').onclick = () => { S.wps = []; if (S.seq) { S.sim.set_waypoint_finish(); S.seq = false; } renderWpList(); scheduleReroute(); };
  $('#btnWpGo').onclick = () => {
    const n = activeWps()[0];
    if (!n) { S.sim.set_waypoint_finish(); return; }
    S.seq = true; S.waypoint = null; S.sim.set_waypoint(n.lat, n.lon);
  };
  $('#wpList').addEventListener('pointerdown', (e) => { const b = e.target.closest('[data-del]'); if (b) removeWp(+b.dataset.del); });
  $('#tgRoute').onclick = (e) => { S.layers.route = !S.layers.route; e.currentTarget.classList.toggle('on', S.layers.route); };

  // compas : les changements sont proposés (aperçu jaune sur le compas) puis validés ou annulés
  const cmSteer = (d) => {
    // d > 0 : vers tribord (le cap augmente, donc le TWA diminue)
    const sn = S.snap, k = S.pilotT[0];
    const mode = S.pend ? S.pend.mode : k === 1 ? 'twa' : k === 0 ? 'hdg' : S.cmMode;
    const base = S.pend ? S.pend.v : mode === 'twa' ? (k === 1 ? S.pilotT[1] : sn.twa) : (k === 0 ? S.pilotT[1] : sn.heading);
    setPend(mode, mode === 'twa' ? base - d : base + d);
  };
  $('#cmM5').onclick = () => cmSteer(-5); $('#cmM1').onclick = () => cmSteer(-1);
  $('#cmP1').onclick = () => cmSteer(1); $('#cmP5').onclick = () => cmSteer(5);
  $('#cmModeHdg').onclick = () => { S.cmMode = 'hdg'; if (S.pilotT[0] !== 0 || S.pend) setPend('hdg', S.pend ? pendHeading(S.snap) : S.snap.heading); };
  $('#cmModeTwa').onclick = () => { S.cmMode = 'twa'; if (S.pilotT[0] !== 1 || S.pend) setPend('twa', S.pend ? n180(S.snap.twd - pendHeading(S.snap)) : S.snap.twa); };
  $('#cmTack').onclick = () => {
    const sn = S.snap, k = S.pilotT[0];
    const mode = S.pend ? S.pend.mode : k === 0 ? 'hdg' : 'twa';
    if (mode === 'hdg') setPend('hdg', 2 * sn.twd - pendHeading(sn));
    else setPend('twa', -(S.pend ? S.pend.v : sn.twa));
  };
  $('#cmOk').onclick = applyPend; $('#cmCancel').onclick = cancelPend;
  const cv = $('#compassCv');
  const compassAngle = (e) => { const r = cv.getBoundingClientRect(); return n360(Math.atan2(e.clientX - r.left - r.width / 2, -(e.clientY - r.top - r.height / 2)) / D2R); };
  const compassSet = (a) => { if (S.cmMode === 'twa') setPend('twa', S.snap.twd - a); else setPend('hdg', a); };
  let cmDrag = false;
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); cmDrag = true; compassSet(compassAngle(e)); });
  cv.addEventListener('pointermove', (e) => { if (cmDrag) compassSet(compassAngle(e)); });
  cv.addEventListener('pointerup', () => { cmDrag = false; });
  addEventListener('keydown', (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.code === 'Escape') { S.armPoint = false; S.armWp = false; syncArm(); cancelPend(); }
    else if (e.code === 'Enter' && S.pend) { e.preventDefault(); applyPend(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); cmSteer(e.shiftKey ? -5 : -1); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); cmSteer(e.shiftKey ? 5 : 1); }
  });
  $('#tgWind').onclick = (e) => { S.layers.wind = !S.layers.wind; e.currentTarget.classList.toggle('on', S.layers.wind); S.wind.key = ''; };
  $('#tgIso').onclick = (e) => { S.layers.iso = !S.layers.iso; e.currentTarget.classList.toggle('on', S.layers.iso); };
  $('#tgFollow').onclick = (e) => { S.follow = !S.follow; e.currentTarget.classList.toggle('on', S.follow); };
  $('#btnFit').onclick = () => { S.follow = false; $('#tgFollow').classList.remove('on'); fitView(); };

  $('#btnRoute').onclick = () => {
    const s = S.snap;
    requestRoute({ q: +$('#selQuality').value, lat: s.lat, lon: s.lon, t0: s.now });
  };
  $('#btnFollow').onclick = () => {
    if (S.route && S.sim.set_route_flat(flatRoute(S.route))) S.sim.follow_route();
    else { S.followAfter = true; $('#btnRoute').click(); }
  };
  $('#btnCsv').onclick = exportCsv;

  $('#btnReset').onclick = () => {
    const sLat = parseCoord($('#inSLat').value, true), sLon = parseCoord($('#inSLon').value, false);
    const fLat = parseCoord($('#inFLat').value, true), fLon = parseCoord($('#inFLon').value, false);
    const err = $('#resetErr');
    if ([sLat, sLon, fLat, fLon].some((v) => v === null)) { err.textContent = 'Coordonnées illisibles (ex. 39.04 ou 39°N 02\'19").'; err.classList.remove('hidden'); return; }
    err.classList.add('hidden');
    resetGame({ sLat, sLon, fLat, fLon });
  };
  $('#btnPreset').onclick = () => resetGame(null);

  $('#fileGpx').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { importGpx(await f.text(), f.name); } catch (err) { $('#gpxInfo').textContent = ''; showDataErr('GPX : ' + String(err.message || err)); }
  };
  $('#fileWind').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    showDataErr('');
    S.data.wind = new Uint8Array(await f.arrayBuffer());
    resetGame(null, true);
  };
  $('#filePolar').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const text = await f.text();
    try {
      S.sim.set_polar(text);
      S.data.polar = text;
      S.worker.postMessage({ type: 'polar', text });
      S.info = JSON.parse(S.sim.info()); updateBadges(); showDataErr('');
      S.route = null; renderRoute();
    } catch (err) { showDataErr(String(err.message || err)); }
  };

  // carte : déplacement, zoom, clic pour poser un point
  let drag = null;
  const rel = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const [px, py] = rel(e), wi = e.button === 0 ? hitWp(px, py) : -1;
    drag = { x: e.clientX, y: e.clientY, cx: S.view.cx, cy: S.view.cy, moved: false, wp: wi };
  });
  canvas.addEventListener('pointermove', (e) => {
    const [px, py] = rel(e);
    S.hoverLL = screenToLL(px, py);
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved && drag.wp >= 0) {
        // glisser un point de routage
        const w = S.wps[drag.wp]; w.lat = S.hoverLL.lat; w.lon = S.hoverLL.lon; w.done = false;
      } else if (drag.moved) { S.view.cx = drag.cx - dx / S.view.z; S.view.cy = drag.cy - dy / S.view.z; S.follow = false; $('#tgFollow').classList.remove('on'); }
    } else canvas.style.cursor = hitWp(px, py) >= 0 ? 'grab' : '';
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag) {
      const [px, py] = rel(e), ll = screenToLL(px, py);
      if (drag.moved && drag.wp >= 0) {
        if (S.seq) { const n = activeWps()[0]; if (n) S.sim.set_waypoint(n.lat, n.lon); }
        renderWpList(); scheduleReroute();
      } else if (!drag.moved && S.armWp) addWp(ll.lat, ll.lon); // reste armé : on peut poser plusieurs points
      else if (!drag.moved && S.armPoint) {
        S.seq = false; S.waypoint = ll; S.sim.set_waypoint(ll.lat, ll.lon);
        S.armPoint = false; S.syncArm();
      }
    }
    drag = null;
  });
  canvas.addEventListener('dblclick', (e) => { const [px, py] = rel(e); if (!S.armWp && hitWp(px, py) < 0) { const ll = screenToLL(px, py); addWp(ll.lat, ll.lon); } });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); const [px, py] = rel(e), i = hitWp(px, py); if (i >= 0) removeWp(i); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const before = screenToWorld(px, py);
    S.view.z = clamp(S.view.z * Math.exp(-e.deltaY * 0.0015), 600, 400000);
    const after = screenToWorld(px, py);
    S.view.cx += before.x - after.x; S.view.cy += before.y - after.y;
  }, { passive: false });
  addEventListener('resize', resize);
  new ResizeObserver(resize).observe($('#mapwrap'));
}

/** Place le bateau sur la position d'un GPX : piste (trk) = dernier point, route (rte) ou waypoint = premier point.
 *  Garde l'arrivée actuelle, met le jeu en pause, reprend le cap du fichier s'il y en a un, et affiche la route du fichier. */
function importGpx(text, name) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('fichier illisible');
  const read = (tag) => [...doc.getElementsByTagName(tag)].map((el) => ({
    lat: parseFloat(el.getAttribute('lat')), lon: parseFloat(el.getAttribute('lon')),
    course: parseFloat(el.getElementsByTagName('course')[0]?.textContent), time: el.getElementsByTagName('time')[0]?.textContent,
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  let kind = 'piste', pts = read('trkpt'), pos;
  if (pts.length) pos = pts[pts.length - 1];
  else { kind = 'route'; pts = read('rtept'); if (!pts.length) { kind = 'waypoint'; pts = read('wpt'); } pos = pts[0]; }
  if (!pos) throw new Error('aucun point trouvé');
  const fin = S.info.finish;
  resetGame({ sLat: pos.lat, sLon: pos.lon, fLat: fin.lat, fLon: fin.lon });
  S.afterReady = () => {
    S.running = false; syncSpeedBtns();
    if (Number.isFinite(pos.course)) S.sim.set_heading(pos.course);
    if (pts.length > 1) S.gpxRoute = pts.map((p) => [p.lat, p.lon]);
  };
  $('#gpxInfo').textContent = `${name} : ${kind}, ${pts.length} point(s). Position ${fmtPos(pos.lat, pos.lon)}` +
    (Number.isFinite(pos.course) ? `, cap ${pos.course.toFixed(0)}°` : '') + (pos.time ? ` (relevée ${pos.time.slice(0, 16).replace('T', ' ')} UTC)` : '') + '. Jeu en pause.';
}

function resetGame(course, keepCourse) {
  setLoading('Initialisation…');
  const c = keepCourse ? { sLat: S.info.start.lat, sLon: S.info.start.lon, fLat: S.info.finish.lat, fLon: S.info.finish.lon } : course;
  S.routeBusy = false; $('#btnRoute').disabled = false; S.currentRouteId = -1;
  createSim(c);
  startWorker(c);
  fitView();
}

// ------------------------------------------------------------------ carte
function resize() {
  const wrap = $('#mapwrap');
  S.dpr = Math.min(2, devicePixelRatio || 1);
  S.w = wrap.clientWidth; S.h = wrap.clientHeight;
  canvas.width = Math.round(S.w * S.dpr); canvas.height = Math.round(S.h * S.dpr);
  S.wind.key = '';
}
const screenToWorld = (px, py) => ({ x: S.view.cx + (px - S.w / 2) / S.view.z, y: S.view.cy + (py - S.h / 2) / S.view.z });
const screenToLL = (px, py) => { const w = screenToWorld(px, py); return { lat: invLat(w.y), lon: invLon(w.x) }; };
const toScreen = (lat, lon) => [(mercX(lon) - S.view.cx) * S.view.z + S.w / 2, (mercY(lat) - S.view.cy) * S.view.z + S.h / 2];

function fitView() {
  const pts = [S.info.start, S.info.finish, { lat: S.snap.lat, lon: S.snap.lon }];
  const xs = pts.map((p) => mercX(p.lon)), ys = pts.map((p) => mercY(p.lat));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  S.view.cx = (x0 + x1) / 2; S.view.cy = (y0 + y1) / 2;
  S.view.z = clamp(Math.min(S.w / Math.max(x1 - x0, 0.01) / 1.35, S.h / Math.max(y1 - y0, 0.01) / 1.35), 600, 400000);
}

function gridStep() {
  const spanDeg = (S.w / S.view.z) * 360;
  for (const st of [0.5, 1, 2, 5, 10, 20, 30]) if (spanDeg / st < 14) return st;
  return 30;
}

function refreshWind(force) {
  const key = [S.w, S.h, S.view.cx.toFixed(4), S.view.cy.toFixed(4), S.view.z.toFixed(0)].join('|') + '|' + Math.floor(S.snap.now / 900);
  const nowMs = performance.now();
  if (!force && key === S.wind.key) return;
  if (nowMs - S.wind.at < 150) return;
  S.wind.key = key; S.wind.at = nowMs;
  const CELL = 14;
  const gw = Math.ceil(S.w / CELL), gh = Math.ceil(S.h / CELL);
  const coords = new Float64Array(gw * gh * 2);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const ll = screenToLL((i + 0.5) * CELL, (j + 0.5) * CELL);
    const k = (j * gw + i) * 2; coords[k] = clamp(ll.lat, -80, 80); coords[k + 1] = ll.lon;
  }
  const uv = S.sim.wind_at_many(coords);
  if (!S.wind.img || S.wind.img.width !== gw || S.wind.img.height !== gh) { S.wind.img = document.createElement('canvas'); S.wind.img.width = gw; S.wind.img.height = gh; }
  const ictx = S.wind.img.getContext('2d'), id = ictx.createImageData(gw, gh);
  const arrows = [];
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const k = j * gw + i, u = uv[k * 2], v = uv[k * 2 + 1], sp = Math.hypot(u, v), c = windColor(sp);
    id.data[k * 4] = c[0]; id.data[k * 4 + 1] = c[1]; id.data[k * 4 + 2] = c[2]; id.data[k * 4 + 3] = 120;
    if (i % 3 === 1 && j % 3 === 1 && sp > 0.3) arrows.push([(i + 0.5) * CELL, (j + 0.5) * CELL, u / sp, -v / sp, sp]);
  }
  ictx.putImageData(id, 0, 0);
  S.wind.arrows = arrows;
}

function drawArrow(x, y, dx, dy, sp) {
  const L = 8 + Math.min(sp, 35) * 0.55, hx = x - dx * L / 2, hy = y - dy * L / 2, tx = x + dx * L / 2, ty = y + dy * L / 2;
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty);
  ctx.moveTo(tx, ty); ctx.lineTo(tx - dx * 4 + dy * 2.6, ty - dy * 4 - dx * 2.6);
  ctx.moveTo(tx, ty); ctx.lineTo(tx - dx * 4 - dy * 2.6, ty - dy * 4 + dx * 2.6);
  ctx.stroke();
}

function boatShape(x, y, hdg, color, size, outline) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(hdg * D2R);
  ctx.beginPath(); ctx.moveTo(0, -size * 1.5); ctx.lineTo(size * 0.7, size); ctx.lineTo(0, size * 0.55); ctx.lineTo(-size * 0.7, size); ctx.closePath();
  ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = outline; ctx.stroke();
  ctx.restore();
}

function draw() {
  const { w, h, dpr } = S;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#0a1f3d'); g.addColorStop(1, '#03070f');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  if (S.layers.wind) {
    refreshWind(false);
    if (S.wind.img) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(S.wind.img, 0, 0, S.wind.img.width * 14, S.wind.img.height * 14); }
  }

  // terre
  ctx.save();
  ctx.translate(w / 2 - S.view.cx * S.view.z, h / 2 - S.view.cy * S.view.z); ctx.scale(S.view.z, S.view.z);
  ctx.fillStyle = '#141a26'; ctx.fill(S.landPath, 'evenodd');
  ctx.lineWidth = 1 / S.view.z; ctx.strokeStyle = '#4b5f82'; ctx.stroke(S.landPath);
  ctx.restore();

  // graticule
  const st = gridStep();
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '10px system-ui';
  const tl = screenToLL(0, 0), br = screenToLL(w, h);
  for (let lon = Math.ceil(tl.lon / st) * st; lon <= br.lon; lon += st) { const [x] = toScreen(0, lon); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.fillText(`${Math.abs(lon)}°${lon < 0 ? 'O' : 'E'}`, x + 3, h - 4); }
  for (let lat = Math.ceil(br.lat / st) * st; lat <= tl.lat; lat += st) { const [, y] = toScreen(lat, 0); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.fillText(`${Math.abs(lat)}°${lat < 0 ? 'S' : 'N'}`, 4, y - 3); }

  // flèches de vent
  if (S.layers.wind) {
    ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.1;
    for (const a of S.wind.arrows) drawArrow(...a);
  }

  // isochrones
  const R = S.route;
  if (R && S.layers.iso) {
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.28)';
    for (const iso of R.isochrones) {
      ctx.beginPath(); let pv = null;
      iso.forEach(([la, lo]) => {
        const [x, y] = toScreen(la, lo);
        const jump = !pv || Math.abs(la - pv[0]) > 2.5 || Math.abs(lo - pv[1]) > 2.5;
        jump ? ctx.moveTo(x, y) : ctx.lineTo(x, y); pv = [la, lo];
      });
      ctx.stroke();
    }
  }
  // trace du bateau
  const tr = S.info.track;
  if (tr && tr.length > 1) {
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.setLineDash([5, 4]); ctx.beginPath();
    tr.forEach(([la, lo], i) => { const [x, y] = toScreen(la, lo); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    const sn = S.snap; const [bx, by] = toScreen(sn.lat, sn.lon); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
  }
  // route idéale (routeur) : trait lumineux jaune, repères de jour, étiquette d'arrivée
  if (R && S.layers.route) {
    const P = R.points;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    P.forEach((p, i) => { const [x, y] = toScreen(p.lat, p.lon); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(246,224,94,.22)'; ctx.stroke(); // halo
    ctx.lineWidth = 2.6; ctx.strokeStyle = '#f6e05e'; ctx.stroke();
    ctx.fillStyle = '#f6e05e'; ctx.font = '10px system-ui'; ctx.textAlign = 'left';
    const t0 = P[0].t; let lastDay = 0;
    P.forEach((p) => {
      const [x, y] = toScreen(p.lat, p.lon);
      const day = Math.floor((p.t - t0) / 86400);
      if (day > lastDay) { lastDay = day; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 6.3); ctx.fill(); ctx.fillText(`J+${day}`, x + 6, y - 5); }
    });
    const e = P[P.length - 1], [ex, ey] = toScreen(e.lat, e.lon);
    ctx.font = 'bold 11px system-ui'; ctx.fillText(`★ Route idéale · ${R.reached ? 'arrivée ' + fmtLocal(R.eta_unix) : 'non atteinte'}`, ex + 10, ey - 10);
  }

  // route importée d'un GPX
  if (S.gpxRoute && S.gpxRoute.length > 1) {
    ctx.setLineDash([7, 5]); ctx.lineWidth = 2; ctx.strokeStyle = '#7fb2ff'; ctx.beginPath();
    S.gpxRoute.forEach(([la, lo], i) => { const [x, y] = toScreen(la, lo); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);
    const [la, lo] = S.gpxRoute[S.gpxRoute.length - 1], [x, y] = toScreen(la, lo);
    ctx.fillStyle = '#7fb2ff'; ctx.font = 'bold 11px system-ui'; ctx.fillText('Route GPX', x + 8, y + 4);
  }

  // points de routage : ordre de passage (boat → 1 → 2 … → arrivée), puis marqueurs numérotés
  {
    const sn0 = S.snap, act = activeWps();
    const fin0 = S.info.finish;
    const chain = [[sn0.lat, sn0.lon], ...act.map((w) => [w.lat, w.lon]), [fin0.lat, fin0.lon]];
    ctx.setLineDash([2, 6]); ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(180,160,255,.8)'; ctx.beginPath();
    chain.forEach(([la, lo], i) => { const [x, y] = toScreen(la, lo); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);
    S.wps.forEach((w, i) => {
      const [x, y] = toScreen(w.lat, w.lon), next = w === act[0];
      ctx.beginPath(); ctx.arc(x, y, next ? 11 : 9.5, 0, 6.3);
      ctx.fillStyle = w.done ? 'rgba(74,85,104,.9)' : '#7c5cff'; ctx.fill();
      ctx.lineWidth = next ? 3 : 2; ctx.strokeStyle = next ? '#fff' : 'rgba(255,255,255,.7)'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 0.5); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    });
  }

  // départ, arrivée, point visé
  const fin = S.info.finish, [fx, fy] = toScreen(fin.lat, fin.lon);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#e53e3e'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(fx, fy, 7, 0, 6.3); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = '11px system-ui'; ctx.fillText('Arrivée', fx + 10, fy + 4);
  const [sx, sy] = toScreen(S.info.start.lat, S.info.start.lon);
  ctx.strokeStyle = '#68d391'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 6.3); ctx.stroke();
  if (S.waypoint) { const [x, y] = toScreen(S.waypoint.lat, S.waypoint.lon); ctx.strokeStyle = '#4d8dff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 8, 0, 6.3); ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12); ctx.stroke(); }

  // bateaux
  const sn = S.snap;
  ctx.font = '11px system-ui'; ctx.textAlign = 'left';
  for (const b of sn.fleet) {
    if (b.player) continue;
    const [x, y] = toScreen(b.lat, b.lon);
    boatShape(x, y, b.heading, '#a0aec0', 5, '#1a202c');
    if (S.view.z > 5000) { ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillText(b.name, x + 8, y + 3); }
  }
  const [px, py] = toScreen(sn.lat, sn.lon);
  ctx.beginPath(); ctx.arc(px, py, 14, 0, 6.3); ctx.fillStyle = 'rgba(77,141,255,.22)'; ctx.fill();
  boatShape(px, py, sn.heading, '#ffffff', 7, '#0b1b2b');
  // vent vrai sur le bateau
  const wr = (sn.twd + 180) * D2R; ctx.strokeStyle = '#f6ad55'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.sin(wr) * 34, py - Math.cos(wr) * 34); ctx.stroke();

  // survol
  if (S.hoverLL) {
    const wv = S.sim.wind_at(S.hoverLL.lat, S.hoverLL.lon, 0);
    $('#hover').textContent = `${fmtPos(S.hoverLL.lat, S.hoverLL.lon)}  ·  vent ${wv[0].toFixed(1)} nds de ${wv[1].toFixed(0)}°`;
  }
}

// ------------------------------------------------------------------ panneaux
function drawPolar(sn) {
  const cv = $('#polarCv'), c = cv.getContext('2d'), W = cv.width, H = cv.height;
  c.clearRect(0, 0, W, H);
  const curve = S.sim.polar_curve(Math.max(sn.tws, 0.1));
  const vmax = Math.max(10, Math.ceil(Math.max(...curve, sn.speed) * 1.1 / 5) * 5);
  const ox = 34, oy = H / 2, R = H / 2 - 10, sc = R / vmax;
  c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,.15)'; c.fillStyle = 'rgba(255,255,255,.45)'; c.font = '9px system-ui';
  for (let v = 10; v <= vmax; v += 10) { c.beginPath(); c.arc(ox, oy, v * sc, -Math.PI / 2, Math.PI / 2); c.stroke(); c.fillText(v, ox + 2, oy - v * sc - 2); }
  for (const a of [0, 45, 90, 135, 180]) { const r = a * D2R; c.beginPath(); c.moveTo(ox, oy); c.lineTo(ox + Math.sin(r) * R, oy - Math.cos(r) * R); c.stroke(); c.fillText(a + '°', ox + Math.sin(r) * (R + 2) - (a === 0 || a === 180 ? 8 : 0), oy - Math.cos(r) * (R + 2) + (a === 0 ? -2 : a === 180 ? 9 : 3)); }
  const best = S.sim.polar_best_angles(Math.max(sn.tws, 0.1));
  c.setLineDash([3, 3]); c.strokeStyle = 'rgba(246,173,85,.8)';
  for (const a of [best[0], best[2]]) { const r = a * D2R; c.beginPath(); c.moveTo(ox, oy); c.lineTo(ox + Math.sin(r) * R, oy - Math.cos(r) * R); c.stroke(); }
  c.setLineDash([]);
  c.lineWidth = 2; c.strokeStyle = '#4d8dff'; c.beginPath();
  curve.forEach((v, i) => { const r = i * 2 * D2R; const x = ox + Math.sin(r) * v * sc, y = oy - Math.cos(r) * v * sc; i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.stroke();
  const ta = Math.abs(sn.twa) * D2R; c.fillStyle = '#fff'; c.beginPath(); c.arc(ox + Math.sin(ta) * sn.speed * sc, oy - Math.cos(ta) * sn.speed * sc, 4, 0, 6.3); c.fill();
  $('#polarInfo').textContent = `Meilleur VMG à ${sn.tws.toFixed(0)} nds : près ${best[0].toFixed(0)}° (${best[1].toFixed(1)} nds) · portant ${best[2].toFixed(0)}° (${best[3].toFixed(1)} nds)`;
}

/** Compas façon Virtual Regatta : rose nord en haut, bateau avec sa grand-voile, vent, zone interdite, lignes de près/portant,
 *  secteur de TWA (rouge bâbord / vert tribord), curseur de cap, cap verrouillé et relèvement du prochain point. */
function drawCompass(sn) {
  const cv = $('#compassCv'), c = cv.getContext('2d'), W = cv.width, cx = W / 2, cy = W / 2, R = W / 2 - 8, Rd = R * 0.76;
  const pt = (a, r) => [cx + Math.sin(a * D2R) * r, cy - Math.cos(a * D2R) * r];
  const ca = (a) => (a - 90) * D2R;
  const [kind, tv] = S.pilotT;
  c.clearRect(0, 0, W, W);

  // boîtier et cadran
  let g = c.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
  g.addColorStop(0, '#1d3566'); g.addColorStop(1, '#04070e');
  c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fillStyle = g; c.fill();
  c.lineWidth = 4; c.strokeStyle = '#2f5fae'; c.stroke();
  g = c.createRadialGradient(cx, cy, 0, cx, cy, Rd);
  g.addColorStop(0, '#0b2347'); g.addColorStop(1, '#03060d');
  c.beginPath(); c.arc(cx, cy, Rd, 0, 7); c.fillStyle = g; c.fill();
  c.lineWidth = 2; c.strokeStyle = '#1c3a6e'; c.stroke();

  // graduations et repères
  for (let a = 0; a < 360; a += 5) {
    const major = a % 30 === 0, mid = a % 10 === 0;
    c.beginPath(); c.moveTo(...pt(a, Rd + 3)); c.lineTo(...pt(a, Rd + (major ? 20 : mid ? 14 : 8)));
    c.lineWidth = major ? 3 : 1.5; c.strokeStyle = major ? '#e6eef5' : 'rgba(230,238,245,.5)'; c.stroke();
  }
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (let a = 0; a < 360; a += 30) {
    const card = { 0: 'N', 90: 'E', 180: 'S', 270: 'O' }[a];
    const [x, y] = pt(a, Rd + 40);
    c.font = card ? 'bold 30px system-ui' : '19px system-ui';
    c.fillStyle = card ? (a === 0 ? '#fc8181' : '#4d8dff') : 'rgba(230,238,245,.75)';
    c.fillText(card || pad3(a), x, y);
  }

  // zone interdite (face au vent) et lignes de près / portant au vent actuel
  const best = S.sim.polar_best_angles(Math.max(sn.tws, 0.1)), up = best[0], down = best[2];
  c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, Rd - 2, ca(sn.twd - up), ca(sn.twd + up)); c.closePath();
  c.fillStyle = 'rgba(252,129,129,.13)'; c.fill();
  c.setLineDash([8, 7]); c.lineWidth = 2;
  for (const [a, col] of [[sn.twd - up, 'rgba(246,173,85,.85)'], [sn.twd + up, 'rgba(246,173,85,.85)'], [sn.twd - down, 'rgba(104,211,145,.75)'], [sn.twd + down, 'rgba(104,211,145,.75)']]) {
    c.beginPath(); c.moveTo(...pt(a, Rd * 0.2)); c.lineTo(...pt(a, Rd - 2)); c.strokeStyle = col; c.stroke();
  }
  c.setLineDash([]);

  // secteur de TWA : de la proue au vent, vert si le vent vient de tribord, rouge de bâbord
  const ra = Rd * 0.5, h = sn.heading;
  c.beginPath();
  if (sn.twa >= 0) c.arc(cx, cy, ra, ca(h), ca(h + sn.twa)); else c.arc(cx, cy, ra, ca(h + sn.twa), ca(h));
  c.lineWidth = 16; c.strokeStyle = sn.twa >= 0 ? 'rgba(104,211,145,.55)' : 'rgba(252,129,129,.55)'; c.stroke();

  // flèche de vent (vient de twd, souffle vers le centre)
  const [tx, ty] = pt(sn.twd, Rd * 0.97), [hx, hy] = pt(sn.twd, Rd * 0.6);
  c.beginPath(); c.moveTo(tx, ty); c.lineTo(hx, hy); c.lineWidth = 5; c.strokeStyle = '#f6ad55'; c.lineCap = 'round'; c.stroke();
  c.save(); c.translate(hx, hy); c.rotate((sn.twd + 180) * D2R);
  c.beginPath(); c.moveTo(0, -16); c.lineTo(-11, 6); c.lineTo(11, 6); c.closePath(); c.fillStyle = '#f6ad55'; c.fill(); c.restore();
  c.lineCap = 'butt';

  // bateau + grand-voile (réglée sous le vent, ouverte selon le TWA)
  c.save(); c.translate(cx, cy); c.rotate(h * D2R);
  const L = Rd * 0.5;
  c.beginPath(); c.moveTo(0, -L);
  c.bezierCurveTo(L * 0.4, -L * 0.45, L * 0.34, L * 0.55, L * 0.2, L * 0.95); c.lineTo(-L * 0.2, L * 0.95);
  c.bezierCurveTo(-L * 0.34, L * 0.55, -L * 0.4, -L * 0.45, 0, -L); c.closePath();
  g = c.createLinearGradient(-L * 0.4, 0, L * 0.4, 0); g.addColorStop(0, '#dbe7f2'); g.addColorStop(0.5, '#ffffff'); g.addColorStop(1, '#c3d3e2');
  c.fillStyle = g; c.fill(); c.lineWidth = 2.5; c.strokeStyle = '#0b1b2b'; c.stroke();
  const side = sn.twa >= 0 ? -1 : 1, sa = clamp(Math.abs(sn.twa) * 0.5, 4, 88) * D2R, mx = 0, my = -L * 0.18, bl = L * 1.0;
  const ex = mx + side * Math.sin(sa) * bl, ey = my + Math.cos(sa) * bl;
  const cx1 = mx + side * (Math.sin(sa) * bl * 0.55 + L * 0.16), cy1 = my + Math.cos(sa) * bl * 0.5;
  c.beginPath(); c.moveTo(mx, my); c.quadraticCurveTo(cx1, cy1, ex, ey); c.lineTo(mx, my);
  c.fillStyle = 'rgba(255,255,255,.28)'; c.fill();
  c.beginPath(); c.moveTo(mx, my); c.quadraticCurveTo(cx1, cy1, ex, ey);
  c.lineWidth = 5; c.lineCap = 'round'; c.strokeStyle = '#ffffff'; c.stroke(); c.lineCap = 'butt';
  c.beginPath(); c.arc(mx, my, 6, 0, 7); c.fillStyle = '#0b1b2b'; c.fill();
  c.restore();

  // curseurs sur la couronne : cap verrouillé (cyan), cap réel (blanc)
  const tri = (a, col, size, r) => {
    const [x, y] = pt(a, r); c.save(); c.translate(x, y); c.rotate(a * D2R);
    c.beginPath(); c.moveTo(0, 0); c.lineTo(-size * 0.7, -size); c.lineTo(size * 0.7, -size); c.closePath();
    c.fillStyle = col; c.fill(); c.lineWidth = 2; c.strokeStyle = '#0b1b2b'; c.stroke(); c.restore();
  };
  const lockHdg = kind === 0 ? tv : kind === 1 ? n360(sn.twd - tv) : null;
  if (lockHdg !== null) tri(lockHdg, '#4d8dff', 30, Rd + 4);
  c.beginPath(); c.moveTo(...pt(h, L + 6)); c.lineTo(...pt(h, Rd - 2)); c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,.9)'; c.stroke();
  tri(h, '#ffffff', 24, Rd + 4);

  // cap proposé (en attente de validation) : curseur et ligne jaunes
  if (S.pend) {
    const ph = pendHeading(sn);
    c.setLineDash([10, 8]); c.beginPath(); c.moveTo(...pt(ph, L + 6)); c.lineTo(...pt(ph, Rd - 2)); c.lineWidth = 4; c.strokeStyle = '#f6e05e'; c.stroke(); c.setLineDash([]);
    tri(ph, '#f6e05e', 32, Rd + 4);
  }

  // relèvement du prochain point (point de routage actif, sinon arrivée)
  const nx = activeWps()[0] || S.info.finish;
  const brg = bearingDeg(sn.lat, sn.lon, nx.lat, nx.lon), [bx, by] = pt(brg, Rd - 16);
  c.beginPath(); c.arc(bx, by, 11, 0, 7); c.fillStyle = activeWps()[0] ? '#7c5cff' : '#fc8181'; c.fill(); c.lineWidth = 2.5; c.strokeStyle = '#fff'; c.stroke();

  // lectures : vitesse en haut, cap et TWA en bas
  const pill = (x, y, w, hh) => { c.beginPath(); c.roundRect(x - w / 2, y - hh / 2, w, hh, 14); c.fillStyle = 'rgba(5,15,25,.78)'; c.fill(); c.lineWidth = 1.5; c.strokeStyle = 'rgba(77,141,255,.5)'; c.stroke(); };
  pill(cx, cy - Rd * 0.66, Rd * 0.95, 62);
  c.fillStyle = '#4d8dff'; c.font = 'bold 34px system-ui'; c.fillText(`${sn.speed.toFixed(1)} nds`, cx, cy - Rd * 0.66 - 7);
  c.fillStyle = '#f6ad55'; c.font = '17px system-ui'; c.fillText(`vent ${sn.tws.toFixed(1)} nds · ${pad3(sn.twd)}°`, cx, cy - Rd * 0.66 + 20);
  pill(cx, cy + Rd * 0.7, Rd * 1.25, 74);
  c.font = '16px system-ui'; c.fillStyle = 'rgba(230,238,245,.7)';
  c.fillText(kind === 0 ? 'CAP ●' : 'CAP', cx - Rd * 0.32, cy + Rd * 0.7 - 22);
  c.fillText(kind === 1 ? 'TWA ●' : 'TWA', cx + Rd * 0.32, cy + Rd * 0.7 - 22);
  c.font = 'bold 36px system-ui'; c.fillStyle = '#fff'; c.fillText(`${pad3(h)}°`, cx - Rd * 0.32, cy + Rd * 0.7 + 10);
  c.fillStyle = sn.twa >= 0 ? '#68d391' : '#fc8181'; c.fillText(`${sn.twa >= 0 ? '+' : '−'}${Math.abs(Math.round(sn.twa))}°`, cx + Rd * 0.32, cy + Rd * 0.7 + 10);
  c.textAlign = 'start'; c.textBaseline = 'alphabetic';
}

function updateUi() {
  const sn = S.snap;
  $('#cmModeHdg').classList.toggle('on', S.pilotT[0] === 0);
  $('#cmModeTwa').classList.toggle('on', S.pilotT[0] === 1);
  updateWpDistances();
  renderPend();
  $('#clockUtc').textContent = fmtUtc(sn.now);
  $('#clockLocal').textContent = 'local ' + fmtLocal(sn.now);
  $('#elapsed').textContent = `J+${Math.floor(sn.elapsed_s / 86400)} ${pad2(Math.floor((sn.elapsed_s % 86400) / 3600))}:${pad2(Math.floor((sn.elapsed_s % 3600) / 60))}`;
  $('#vSpeed').textContent = sn.speed.toFixed(1);
  $('#vHeading').textContent = sn.heading.toFixed(0);
  $('#vTwa').textContent = (sn.twa >= 0 ? '+' : '') + sn.twa.toFixed(0);
  $('#vTws').textContent = sn.tws.toFixed(1);
  $('#vTwd').textContent = `de ${sn.twd.toFixed(0)}°`;
  $('#vSail').textContent = sn.sail;
  $('#vPilot').textContent = sn.pilot;
  $('#vDtf').textContent = sn.dtf.toFixed(0);
  $('#vBrg').textContent = sn.bearing_to_finish.toFixed(0);
  $('#vSailed').textContent = sn.dist_sailed.toFixed(0);
  $('#vManeuvers').textContent = sn.maneuvers + (sn.maneuver_penalty > 0.02 ? ` (−${(sn.maneuver_penalty * 100).toFixed(0)} %)` : '');
  $('#vPos').textContent = fmtPos(sn.lat, sn.lon);
  $('#grounded').classList.toggle('hidden', !sn.grounded);
  $('#finished').classList.toggle('hidden', sn.finished_at == null);
  const done = sn.finished_at != null;
  $('#board').innerHTML = sn.fleet.map((b, i) => `<li class="${b.player ? 'me' : ''} ${b.finished ? 'done' : ''}"><span>${i + 1}. ${b.name}</span><span>${b.finished ? 'arrivé' : b.dtf.toFixed(0) + ' nm'}</span></li>`).join('');
  drawPolar(sn);
  showMapMsg();
  if (done && S.running && sn.finished_at != null && !S.finishNotified) { S.finishNotified = true; $('#routeStatus').textContent = `Arrivée en ${fmtDur(sn.finished_at - S.info.start_unix)}.`; }

  // recalcul automatique
  if ($('#chkAuto').checked && S.ready && !S.routeBusy && !done) {
    const every = Math.max(1, +$('#inAutoH').value || 6) * 3600;
    if (sn.now - S.lastAutoAt >= every) { S.lastAutoAt = sn.now; requestRoute({ q: +$('#selQuality').value, lat: sn.lat, lon: sn.lon, t0: sn.now, auto: true }); }
  }
}

// ------------------------------------------------------------------ boucle
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000); last = now;
  try {
    if (S.ready && S.running) S.sim.tick(dt * S.scale);
    else if (S.ready && !S.primed) { S.sim.tick(0.01); S.primed = true; } // en pause dès le départ : amorce vent/vitesse pour l'affichage
    S.snap = JSON.parse(S.sim.snapshot());
    S.pilotT = Array.from(S.sim.pilot_target());
    if (S.ready) trackWps(S.snap);
    drawCompass(S.snap);
    if (S.follow) { S.view.cx = mercX(S.snap.lon); S.view.cy = mercY(S.snap.lat); }
    if (now - S.infoAt > 1000) { S.info = JSON.parse(S.sim.info()); S.infoAt = now; }
    if (now - S.uiAt > 200) { updateUi(); S.uiAt = now; }
    draw();
  } catch (e) { console.error(e); }
  requestAnimationFrame(frame);
}

// légende
$('#legend').innerHTML = 'Vent (nds)&nbsp;' + [0, 5, 10, 15, 20, 25, 30, 40].map((k) => `<span><i style="background:rgb(${windColor(k).map(Math.round)})"></i>${k}</span>`).join('');
syncSpeedBtns();
boot();
