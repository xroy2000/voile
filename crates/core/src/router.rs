//! Routeur météo par isochrones.
//!
//! À chaque pas de temps, tous les points de la frontière précédente sont propagés
//! dans toutes les directions d'un secteur centré sur l'arrivée, avec la vitesse que
//! donnent la polaire et le vent local. La nouvelle frontière est élaguée par secteurs
//! angulaires (on garde le point le plus proche de l'arrivée dans chaque secteur vu
//! depuis le départ). Un virement ou un empannage coûte le temps perdu équivalent du
//! modèle de manœuvre du bateau.

use crate::boat::{Maneuver, Sail};
use crate::geo::{bearing, destination_flat, dist_nm, norm180, norm360, LatLon};
use crate::land::Land;
use crate::polar::Polar;
use crate::wind::WindField;
use serde::Serialize;

#[derive(Clone, Debug)]
pub struct RouteConfig {
    pub start: LatLon,
    pub dest: LatLon,
    /// instant de départ (Unix s)
    pub t0: f64,
    /// pas de temps (s)
    pub dt_s: f64,
    /// pas d'échantillonnage des caps (°)
    pub heading_step: f64,
    /// demi-ouverture du secteur de caps autour de la direction de l'arrivée (°)
    pub half_angle: f64,
    /// nombre de secteurs d'élagage sur 360°
    pub sectors: usize,
    pub max_hours: f64,
    /// facteur de performance du bateau (1.0 = polaire exacte)
    pub perf: f64,
    /// arrêt si l'arrivée ne se rapproche pas pendant cette durée (h)
    pub stall_hours: f64,
}

impl RouteConfig {
    /// Préréglages mesurés sur Saint-Malo → Pointe-à-Pitre (voir `examples/sens.rs`) :
    /// 0 = rapide (≈0,2 s natif, ~1 % de l'optimum), 1 = standard (≈2 s), 2 = précis (≈7 s).
    pub fn quality(mut self, level: u8) -> Self {
        let (dt, step, sec) = match level {
            0 => (10800.0, 3.0, 360),
            1 => (3600.0, 2.0, 720),
            _ => (1800.0, 2.0, 1440),
        };
        self.dt_s = dt;
        self.heading_step = step;
        self.sectors = sec;
        self
    }

    pub fn new(start: LatLon, dest: LatLon, t0: f64) -> Self {
        Self { start, dest, t0, dt_s: 3600.0, heading_step: 2.0, half_angle: 100.0, sectors: 720, max_hours: 24.0 * 30.0, perf: 1.0, stall_hours: 72.0 }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct RoutePoint {
    pub lat: f64,
    pub lon: f64,
    /// instant d'arrivée en ce point (Unix s)
    pub t: f64,
    /// cap, TWA, vent et vitesse du tronçon qui **arrive** à ce point
    pub heading: f64,
    pub twa: f64,
    pub tws: f64,
    pub twd: f64,
    pub speed: f64,
    pub sail: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct RouteResult {
    pub points: Vec<RoutePoint>,
    /// frontières successives (lat, lon)
    pub isochrones: Vec<Vec<(f32, f32)>>,
    pub reached: bool,
    pub eta_unix: f64,
    pub duration_s: f64,
    pub distance_nm: f64,
    pub best_dist_to_dest_nm: f64,
    pub tacks: u32,
    pub gybes: u32,
}

impl RouteResult {
    /// 8 nombres par point : t, lat, lon, cap, twa, tws, twd, vitesse.
    pub fn to_flat(&self) -> Vec<f64> {
        self.points.iter().flat_map(|p| [p.t, p.lat, p.lon, p.heading, p.twa, p.tws, p.twd, p.speed]).collect()
    }

    /// Reconstruit une route (sans isochrones) depuis `to_flat`.
    pub fn from_flat(flat: &[f64], start_t: f64) -> Option<RouteResult> {
        if flat.len() < 16 || flat.len() % 8 != 0 {
            return None;
        }
        let points: Vec<RoutePoint> = flat
            .chunks_exact(8)
            .map(|c| RoutePoint { t: c[0], lat: c[1], lon: c[2], heading: c[3], twa: c[4], tws: c[5], twd: c[6], speed: c[7], sail: Sail::auto(c[4].abs(), c[5]).name() })
            .collect();
        let dist = points.windows(2).map(|w| dist_nm(LatLon::new(w[0].lat, w[0].lon), LatLon::new(w[1].lat, w[1].lon))).sum();
        let eta = points.last()?.t;
        Some(RouteResult { points, isochrones: vec![], reached: true, eta_unix: eta, duration_s: eta - start_t, distance_nm: dist, best_dist_to_dest_nm: 0.0, tacks: 0, gybes: 0 })
    }

    /// Route exploitable par `Pilot::Route`.
    pub fn plan(&self, finish: LatLon, lead_nm: f64) -> crate::boat::RoutePlan {
        crate::boat::RoutePlan {
            pts: self.points.iter().map(|p| (p.t, LatLon::new(p.lat, p.lon), if p.twa >= 0.0 { 1.0 } else { -1.0 })).collect(),
            finish,
            lead_nm,
        }
    }
}

#[derive(Clone, Copy)]
struct Node {
    pos: LatLon,
    parent: u32,
    depth: u32,
    heading: f64,
    twa: f64,
    tws: f64,
    twd: f64,
    speed: f64,
}

const NONE: u32 = u32::MAX;
pub const MIN_SECTORS: usize = 360;

pub fn route(cfg: &RouteConfig, wind: &dyn WindField, polar: &Polar, land: Option<&Land>) -> RouteResult {
    let dt = cfg.dt_s;
    let root = Node { pos: cfg.start, parent: NONE, depth: 0, heading: bearing(cfg.start, cfg.dest), twa: 0.0, tws: 0.0, twd: 0.0, speed: 0.0 };
    let mut nodes: Vec<Node> = vec![root];
    let mut front: Vec<usize> = vec![0];
    let mut isos: Vec<Vec<(f32, f32)>> = Vec::new();
    let rel0 = bearing(cfg.start, cfg.dest);
    let steps = (cfg.max_hours * 3600.0 / dt).ceil() as usize;
    // En dessous de ~360 secteurs l'élagage est trop grossier : la route obtenue peut être >15 % plus lente que l'optimum.
    let sectors = cfg.sectors.max(MIN_SECTORS);
    let stall_steps = (cfg.stall_hours * 3600.0 / dt).ceil() as usize;
    let mut best_ever = f64::MAX;
    let mut since_progress = 0usize;
    let blocked = |a: LatLon, b: LatLon| land.map_or(false, |l| l.segment_hits(a, b));

    for k in 0..steps {
        let t = cfg.t0 + k as f64 * dt;

        // 1. Une frontière peut-elle atteindre l'arrivée pendant ce pas ?
        let mut finish: Option<(f64, usize, Node)> = None;
        for &i in &front {
            let n = nodes[i];
            let d = dist_nm(n.pos, cfg.dest);
            let w = wind.wind_at(n.pos, t);
            let b = bearing(n.pos, cfg.dest);
            let twa = norm180(w.twd() - b);
            let sp = polar.speed(twa.abs(), w.tws()) * cfg.perf;
            if sp > 0.1 && d <= sp * dt / 3600.0 && !blocked(n.pos, cfg.dest) {
                let eta = t + d / sp * 3600.0;
                if finish.map_or(true, |f| eta < f.0) {
                    finish = Some((eta, i, Node { pos: cfg.dest, parent: i as u32, depth: n.depth + 1, heading: b, twa, tws: w.tws(), twd: w.twd(), speed: sp }));
                }
            }
        }
        if let Some((eta, _, last)) = finish {
            nodes.push(last);
            let idx = nodes.len() - 1;
            return build(cfg, &nodes, idx, isos, true, eta, 0.0);
        }

        // 2. Propagation + élagage par secteurs.
        // `eval` avance un nœud de `dt` selon le cap `h`.
        //  - criblage (`refine = false`) : vent lu une fois au départ du pas, très bon marché ;
        //  - affinage (`refine = true`, réservé aux points retenus) : le tronçon est intégré en sous-pas de 20 min
        //    comme le fait le simulateur, pour que l'heure d'arrivée annoncée soit celle que le bateau obtiendra
        //    (une poche de vent faible au milieu d'un tronçon de 3 h n'est plus ignorée).
        let eval = |n: &Node, h: f64, tws: f64, twd: f64, refine: bool| -> Option<Node> {
            let twa0 = norm180(twd - h);
            let sp0 = polar.speed(twa0.abs(), tws) * cfg.perf;
            if sp0 < 0.5 {
                return None;
            }
            let mut eff = dt;
            if n.parent != NONE && n.twa != 0.0 && n.twa.signum() != twa0.signum() {
                let m = if n.twa.abs() < 90.0 && twa0.abs() < 90.0 { Maneuver::TACK } else { Maneuver::GYBE };
                eff -= m.lost_time_s();
            }
            if !refine {
                let np = destination_flat(n.pos, h, sp0 * eff / 3600.0);
                if blocked(n.pos, np) {
                    return None;
                }
                return Some(Node { pos: np, parent: n.parent, depth: n.depth + 1, heading: h, twa: twa0, tws, twd, speed: sp0 });
            }
            let nsub = (eff / 1200.0).ceil().max(1.0) as usize;
            let ds = eff / nsub as f64;
            let mut pos = n.pos;
            let (mut tw_s, mut tw_d, mut twa) = (tws, twd, twa0);
            for k in 0..nsub {
                let w = wind.wind_at(pos, t + k as f64 * ds);
                tw_s = w.tws();
                tw_d = w.twd();
                twa = norm180(tw_d - h);
                let sp = polar.speed(twa.abs(), tw_s) * cfg.perf;
                pos = destination_flat(pos, h, sp * ds / 3600.0);
            }
            if blocked(n.pos, pos) {
                return None;
            }
            Some(Node { pos, parent: n.parent, depth: n.depth + 1, heading: h, twa, tws: tw_s, twd: tw_d, speed: dist_nm(n.pos, pos) / eff * 3600.0 })
        };
        let mut best: Vec<Option<(f64, Node)>> = vec![None; sectors];
        let mut parent_of: Vec<usize> = vec![0; sectors];
        for &i in &front {
            let n = nodes[i];
            let w = wind.wind_at(n.pos, t);
            let (tws, twd) = (w.tws(), w.twd());
            let b = bearing(n.pos, cfg.dest);
            let count = (2.0 * cfg.half_angle / cfg.heading_step).round() as i32;
            for j in 0..=count {
                let h = norm360(b - cfg.half_angle + j as f64 * cfg.heading_step);
                let Some(mut c) = eval(&n, h, tws, twd, false) else { continue };
                c.parent = i as u32;
                let rel = norm180(bearing(cfg.start, c.pos) - rel0);
                let s = ((((rel + 180.0) / 360.0) * sectors as f64) as usize).min(sectors - 1);
                let dd = dist_nm(c.pos, cfg.dest);
                if best[s].map_or(true, |x| dd < x.0) {
                    best[s] = Some((dd, c));
                    parent_of[s] = i;
                }
            }
        }
        // Affinage des seuls points retenus (≤ `sectors` par pas) : intégration en sous-pas.
        for (s, slot) in best.iter_mut().enumerate() {
            if let Some((dd, c)) = slot {
                let p = nodes[parent_of[s]];
                let w = wind.wind_at(p.pos, t);
                if let Some(mut r) = eval(&p, c.heading, w.tws(), w.twd(), true) {
                    r.parent = c.parent;
                    *dd = dist_nm(r.pos, cfg.dest);
                    *c = r;
                }
            }
        }
        let mut next = Vec::new();
        for c in best.into_iter().flatten() {
            nodes.push(c.1);
            next.push(nodes.len() - 1);
        }
        if next.is_empty() {
            break; // bloqué (terre, calme plat…)
        }
        let min_d = next.iter().map(|&i| dist_nm(nodes[i].pos, cfg.dest)).fold(f64::MAX, f64::min);
        if min_d < best_ever - 0.5 {
            best_ever = min_d;
            since_progress = 0;
        } else {
            since_progress += 1;
            if since_progress >= stall_steps {
                front = next;
                break; // l'arrivée ne se rapproche plus : inatteignable (terre, calme prolongé)
            }
        }
        isos.push(next.iter().map(|&i| (nodes[i].pos.lat as f32, nodes[i].pos.lon as f32)).collect());
        front = next;
    }

    // Arrivée non atteinte : on renvoie le meilleur chemin vers le point le plus proche.
    let (bi, bd) = front
        .iter()
        .map(|&i| (i, dist_nm(nodes[i].pos, cfg.dest)))
        .fold((0, f64::MAX), |a, c| if c.1 < a.1 { c } else { a });
    let eta = cfg.t0 + nodes[bi].depth as f64 * dt;
    build(cfg, &nodes, bi, isos, false, eta, bd)
}

fn build(cfg: &RouteConfig, nodes: &[Node], last: usize, isos: Vec<Vec<(f32, f32)>>, reached: bool, eta: f64, best_d: f64) -> RouteResult {
    let mut chain = Vec::new();
    let mut i = last;
    loop {
        chain.push(i);
        if nodes[i].parent == NONE {
            break;
        }
        i = nodes[i].parent as usize;
    }
    chain.reverse();
    let mut points = Vec::with_capacity(chain.len());
    let (mut tacks, mut gybes, mut dist) = (0, 0, 0.0);
    for (k, &ni) in chain.iter().enumerate() {
        let n = nodes[ni];
        let t = if reached && k == chain.len() - 1 { eta } else { cfg.t0 + n.depth as f64 * cfg.dt_s };
        let (heading, twa, tws, twd, speed) = if k == 0 {
            let c = nodes.get(chain.get(1).copied().unwrap_or(ni)).copied().unwrap_or(n);
            (c.heading, c.twa, c.tws, c.twd, c.speed)
        } else {
            (n.heading, n.twa, n.tws, n.twd, n.speed)
        };
        if k > 1 {
            let prev = nodes[chain[k - 1]];
            if prev.twa.signum() != n.twa.signum() && prev.twa != 0.0 && n.twa != 0.0 {
                if prev.twa.abs() < 90.0 && n.twa.abs() < 90.0 { tacks += 1 } else { gybes += 1 }
            }
        }
        if k > 0 {
            dist += dist_nm(nodes[chain[k - 1]].pos, n.pos);
        }
        points.push(RoutePoint {
            lat: n.pos.lat,
            lon: n.pos.lon,
            t,
            heading,
            twa,
            tws,
            twd,
            speed,
            sail: Sail::auto(twa.abs(), tws).name(),
        });
    }
    RouteResult { points, isochrones: isos, reached, eta_unix: eta, duration_s: eta - cfg.t0, distance_nm: dist, best_dist_to_dest_nm: best_d, tacks, gybes }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wind::{UniformWind, Wind};

    fn uniform(tws: f64, twd: f64) -> UniformWind {
        UniformWind(Wind::from_speed_dir(tws, twd))
    }

    #[test]
    fn beam_reach_matches_analytic_time() {
        let polar = Polar::imoca_generic();
        let (a, b) = (LatLon::new(0.0, -40.0), LatLon::new(0.0, -30.0)); // 600 nm plein est
        let w = uniform(15.0, 0.0); // vent de nord => travers
        let r = route(&RouteConfig::new(a, b, 0.0), &w, &polar, None);
        assert!(r.reached);
        let expected = dist_nm(a, b) / polar.speed(90.0, 15.0) * 3600.0;
        let err = (r.duration_s - expected).abs() / expected;
        assert!(err < 0.03, "durée {} vs analytique {} ({:.1} %)", r.duration_s, expected, err * 100.0);
        assert_eq!(r.tacks + r.gybes, 0, "route directe, aucune manœuvre");
    }

    #[test]
    fn upwind_is_slower_than_direct_and_bounded_by_vmg() {
        let polar = Polar::imoca_generic();
        let (a, b) = (LatLon::new(0.0, -40.0), LatLon::new(0.0, -35.0)); // 300 nm plein est
        let w = uniform(14.0, 90.0); // vent d'est : on remonte au vent
        let r = route(&RouteConfig::new(a, b, 0.0), &w, &polar, None);
        assert!(r.reached);
        let (_, vmg) = polar.best_upwind(14.0);
        let bound = dist_nm(a, b) / vmg * 3600.0;
        assert!(r.duration_s >= bound * 0.98, "plus rapide que la limite théorique ! {} < {}", r.duration_s, bound);
        assert!(r.duration_s <= bound * 1.12, "trop lent : {} > {}", r.duration_s, bound * 1.12);
        assert!(r.tacks >= 1, "au moins un virement attendu, {}", r.tacks);
    }

    #[test]
    fn downwind_gybes_to_beat_dead_run() {
        let polar = Polar::imoca_generic();
        let (a, b) = (LatLon::new(0.0, -40.0), LatLon::new(0.0, -30.0));
        let w = uniform(20.0, 90.0); // vent arrière (d'est, route vers l'est ? non : vent d'EST, on va à l'EST => face au vent)
        let _ = w;
        let w = uniform(20.0, 270.0); // vent d'ouest : vent arrière
        let r = route(&RouteConfig::new(a, b, 0.0), &w, &polar, None);
        assert!(r.reached);
        let direct = dist_nm(a, b) / polar.speed(180.0, 20.0) * 3600.0;
        assert!(r.duration_s < direct, "empanner doit battre le vent arrière strict ({} vs {})", r.duration_s, direct);
    }

    #[test]
    fn avoids_an_island() {
        let polar = Polar::imoca_generic();
        let island = r#"{"type":"Polygon","coordinates":[[[-36.0,-3.0],[-34.0,-3.0],[-34.0,3.0],[-36.0,3.0],[-36.0,-3.0]]]}"#;
        let land = Land::from_geojson(island, -10.0, 10.0, -50.0, -20.0, 0.05).unwrap();
        let (a, b) = (LatLon::new(0.0, -40.0), LatLon::new(0.0, -30.0));
        let w = uniform(15.0, 0.0);
        let free = route(&RouteConfig::new(a, b, 0.0), &w, &polar, None);
        let r = route(&RouteConfig::new(a, b, 0.0), &w, &polar, Some(&land));
        assert!(r.reached, "contournement attendu");
        assert!(r.duration_s > free.duration_s, "le détour doit coûter du temps");
        for p in r.points.windows(2) {
            let (s, e) = (LatLon::new(p[0].lat, p[0].lon), LatLon::new(p[1].lat, p[1].lon));
            assert!(!land.segment_hits(s, e), "tronçon sur la terre : {:?}->{:?}", s, e);
        }
    }

    #[test]
    fn flat_roundtrip() {
        let polar = Polar::imoca_generic();
        let w = uniform(15.0, 0.0);
        let r = route(&RouteConfig::new(LatLon::new(0.0, -40.0), LatLon::new(0.0, -36.0), 100.0), &w, &polar, None);
        let back = RouteResult::from_flat(&r.to_flat(), 100.0).unwrap();
        assert_eq!(back.points.len(), r.points.len());
        assert!((back.duration_s - r.duration_s).abs() < 1e-6);
        assert!(RouteResult::from_flat(&[1.0, 2.0], 0.0).is_none());
    }

    #[test]
    fn unreachable_returns_best_effort() {
        let polar = Polar::imoca_generic();
        let w = uniform(0.0, 0.0); // calme plat
        let mut cfg = RouteConfig::new(LatLon::new(0.0, -40.0), LatLon::new(0.0, -30.0), 0.0);
        cfg.max_hours = 12.0;
        let r = route(&cfg, &w, &polar, None);
        assert!(!r.reached);
    }
}
