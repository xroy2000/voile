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
        if (m.course) sim.reset(m.course.sLat, m.course.sLon, m.course.fLat, m.course.fLon, m.now);
        self.postMessage({ type: 'ready' });
        break;
      }
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
        const json = sim.route_from(m.lat, m.lon, m.t0, m.q);
        self.postMessage({ type: 'route', id: m.id, json, ms: performance.now() - t });
        break;
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err?.message ?? err) });
  }
};
