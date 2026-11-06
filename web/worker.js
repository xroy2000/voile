// Web Worker : calcule les routes hors du fil principal pour que l'interface ne fige jamais.
import init, { Sim } from './pkg/regatta_web.js';

let sim = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        await init();
        sim = new Sim(m.wind ?? undefined, m.land ?? undefined, m.polar ?? undefined, m.now);
        sim.set_perf(m.perf ?? 1);
        if (m.course) sim.reset(m.course.sLat, m.course.sLon, m.course.fLat, m.course.fLon, m.now);
        self.postMessage({ type: 'ready' });
        break;
      }
      case 'perf':
        sim.set_perf(m.perf);
        break;
      case 'polar':
        sim.set_polar(m.text);
        self.postMessage({ type: 'polarOk' });
        break;
      case 'reset':
        sim.reset(m.sLat, m.sLon, m.fLat, m.fLon, m.now);
        self.postMessage({ type: 'resetOk' });
        break;
      case 'route': {
        const t = performance.now();
        const json = m.target ? sim.route_leg(m.lat, m.lon, m.t0, m.q, m.target.lat, m.target.lon) : m.wps && m.wps.length ? chainRoute(m) : sim.route_from(m.lat, m.lon, m.t0, m.q);
        self.postMessage({ type: 'route', id: m.id, json, ms: performance.now() - t, target: !!m.target });
        break;
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err?.message ?? err) });
  }
};

/** Route idéale passant par les points de routage, dans l'ordre : un tronçon du routeur par point, puis l'arrivée. */
function chainRoute(m) {
  const legs = [];
  let lat = m.lat, lon = m.lon, t = m.t0;
  const dests = [...m.wps.map((w) => [w.lat, w.lon]), null];
  for (const d of dests) {
    const r = JSON.parse(d ? sim.route_leg(lat, lon, t, m.q, d[0], d[1]) : sim.route_from(lat, lon, t, m.q));
    legs.push({ r, wp: d });
    const last = r.points[r.points.length - 1];
    if (!r.reached) break; // point inatteignable dans la prévision : on s'arrête là
    lat = last.lat; lon = last.lon; t = last.t;
  }
  const out = { ...legs[legs.length - 1].r, points: [], isochrones: [], tacks: 0, gybes: 0, distance_nm: 0, wp_index: [] };
  legs.forEach(({ r }, i) => {
    // le premier point d'un tronçon est le dernier du précédent
    const pts = i === 0 ? r.points : r.points.slice(1);
    if (i < legs.length - 1 && r.reached) out.wp_index.push(out.points.length + pts.length - 1);
    out.points.push(...pts);
    out.isochrones.push(...r.isochrones);
    out.tacks += r.tacks; out.gybes += r.gybes; out.distance_nm += r.distance_nm;
  });
  const lastLeg = legs[legs.length - 1].r;
  out.reached = lastLeg.reached && legs.length === dests.length;
  out.eta_unix = lastLeg.eta_unix;
  out.duration_s = lastLeg.eta_unix - m.t0;
  out.best_dist_to_dest_nm = lastLeg.best_dist_to_dest_nm;
  return JSON.stringify(out);
}
