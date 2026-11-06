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

// ------------------------------------------------------------------ état
const S = {
  sim: null, worker: null, ready: false,
  data: { wind: null, land: null, polar: null },
  info: null, snap: null,
  scale: 600, running: false,
  view: { cx: 0.4, cy: 0.3, z: 3000 },
  layers: { wind: true, iso: true },
  follow: false, armPoint: false, waypoint: null,
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
  $('#courseName').textContent = '';
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
  }
}

// ------------------------------------------------------------------ routeur
function requestRoute({ ai = false, q, lat, lon, t0, auto = false }) {
  if (S.routeBusy && !ai) return;
  const id = ai ? 'ai' : ++S.routeId;
  if (!ai) { S.routeBusy = true; S.routeAuto = auto; S.routeStart = performance.now(); $('#btnRoute').disabled = true; }
  S.currentRouteId = ai ? S.currentRouteId : id;
  if (!ai) $('#routeStatus').textContent = 'Calcul en cours… (le jeu continue)';
  S.worker.postMessage({ type: 'route', id, q, lat, lon, t0 });
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
    return;
  }
  if (m.id !== S.currentRouteId) return; // résultat périmé (partie réinitialisée)
  S.routeBusy = false;
  $('#btnRoute').disabled = false;
  S.route = r; S.route.ms = m.ms; S.route.calcAt = S.snap.now;
  if (S.sim.set_route_flat(flatRoute(r)) && (S.routeAuto || S.followAfter)) S.sim.follow_route();
  S.followAfter = false;
  renderRoute();
}

function renderRoute() {
  const r = S.route, sum = $('#routeSummary'), body = $('#routeTable tbody');
  body.innerHTML = '';
  if (!r) { sum.classList.add('hidden'); $('#routeStatus').textContent = 'Aucune route calculée.'; return; }
  sum.classList.remove('hidden');
  const eta = r.eta_unix;
  const lim = S.info.t_max;
  sum.innerHTML = `<b>${r.reached ? 'Arrivée' : '⚠ Arrivée non atteinte'}</b> ${fmtLocal(eta)} <span class="muted">(${fmtUtc(eta)})</span><br>` +
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
  $('#btnHeading').onclick = () => S.sim.set_heading(+$('#inHeading').value);
  $('#btnTwa').onclick = () => S.sim.set_twa(+$('#inTwa').value);
  $('#btnVmgUp').onclick = () => S.sim.set_vmg(true);
  $('#btnVmgDown').onclick = () => S.sim.set_vmg(false);
  $('#btnFinish').onclick = () => { S.waypoint = null; S.sim.set_waypoint_finish(); };
  $('#btnPoint').onclick = () => { S.armPoint = !S.armPoint; $('#btnPoint').classList.toggle('on', S.armPoint); canvas.classList.toggle('arm', S.armPoint); };
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
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, cx: S.view.cx, cy: S.view.cy, moved: false }; });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    S.hoverLL = screenToLL(px, py);
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) { S.view.cx = drag.cx - dx / S.view.z; S.view.cy = drag.cy - dy / S.view.z; S.follow = false; $('#tgFollow').classList.remove('on'); }
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved && S.armPoint) {
      const r = canvas.getBoundingClientRect();
      const ll = screenToLL(e.clientX - r.left, e.clientY - r.top);
      S.waypoint = ll; S.sim.set_waypoint(ll.lat, ll.lon);
      S.armPoint = false; $('#btnPoint').classList.remove('on'); canvas.classList.remove('arm');
    }
    drag = null;
  });
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
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#0e3a5c'); g.addColorStop(1, '#0a2a44');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  if (S.layers.wind) {
    refreshWind(false);
    if (S.wind.img) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(S.wind.img, 0, 0, S.wind.img.width * 14, S.wind.img.height * 14); }
  }

  // terre
  ctx.save();
  ctx.translate(w / 2 - S.view.cx * S.view.z, h / 2 - S.view.cy * S.view.z); ctx.scale(S.view.z, S.view.z);
  ctx.fillStyle = '#2e4034'; ctx.fill(S.landPath, 'evenodd');
  ctx.lineWidth = 1 / S.view.z; ctx.strokeStyle = '#7fa488'; ctx.stroke(S.landPath);
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
  // route
  if (R) {
    const P = R.points;
    ctx.lineWidth = 2.6; ctx.strokeStyle = '#f6e05e'; ctx.beginPath();
    P.forEach((p, i) => { const [x, y] = toScreen(p.lat, p.lon); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.fillStyle = '#f6e05e'; ctx.font = '10px system-ui'; ctx.textAlign = 'left';
    const t0 = P[0].t; let lastDay = 0;
    P.forEach((p, i) => {
      const [x, y] = toScreen(p.lat, p.lon);
      const day = Math.floor((p.t - t0) / 86400);
      if (day > lastDay) { lastDay = day; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 6.3); ctx.fill(); ctx.fillText(`J+${day}`, x + 6, y - 5); }
    });
  }

  // départ, arrivée, point visé
  const fin = S.info.finish, [fx, fy] = toScreen(fin.lat, fin.lon);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#e53e3e'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(fx, fy, 7, 0, 6.3); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = '11px system-ui'; ctx.fillText('Arrivée', fx + 10, fy + 4);
  const [sx, sy] = toScreen(S.info.start.lat, S.info.start.lon);
  ctx.strokeStyle = '#68d391'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 6.3); ctx.stroke();
  if (S.waypoint) { const [x, y] = toScreen(S.waypoint.lat, S.waypoint.lon); ctx.strokeStyle = '#4fd1c5'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 8, 0, 6.3); ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12); ctx.stroke(); }

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
  ctx.beginPath(); ctx.arc(px, py, 14, 0, 6.3); ctx.fillStyle = 'rgba(79,209,197,.18)'; ctx.fill();
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
  c.lineWidth = 2; c.strokeStyle = '#4fd1c5'; c.beginPath();
  curve.forEach((v, i) => { const r = i * 2 * D2R; const x = ox + Math.sin(r) * v * sc, y = oy - Math.cos(r) * v * sc; i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.stroke();
  const ta = Math.abs(sn.twa) * D2R; c.fillStyle = '#fff'; c.beginPath(); c.arc(ox + Math.sin(ta) * sn.speed * sc, oy - Math.cos(ta) * sn.speed * sc, 4, 0, 6.3); c.fill();
  $('#polarInfo').textContent = `Meilleur VMG à ${sn.tws.toFixed(0)} nds : près ${best[0].toFixed(0)}° (${best[1].toFixed(1)} nds) · portant ${best[2].toFixed(0)}° (${best[3].toFixed(1)} nds)`;
}

function updateUi() {
  const sn = S.snap;
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
    S.snap = JSON.parse(S.sim.snapshot());
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
