//! Boucle de jeu : horloge accélérée, bateau du joueur, bateaux IA, collisions avec la terre,
//! classement, et routeur intégré.

use crate::boat::{Boat, Pilot};
use crate::geo::{bearing, dist_nm, LatLon};
use crate::land::Land;
use crate::polar::Polar;
use crate::router::{route, RouteConfig, RouteResult};
use crate::wind::{Wind, WindField};
use serde::Serialize;

#[derive(Clone, Debug)]
pub struct Course {
    pub name: String,
    pub start: LatLon,
    pub finish: LatLon,
}

impl Course {
    /// Saint-Malo → Pointe-à-Pitre (points en mer proches des ports : le masque de côte est grossier).
    pub fn route_du_rhum() -> Course {
        Course { name: "Saint-Malo → Pointe-à-Pitre".into(), start: LatLon::new(48.80, -2.35), finish: LatLon::new(16.12, -61.45) }
    }
}

pub struct AiBoat {
    pub name: String,
    pub boat: Boat,
    pub finished_at: Option<f64>,
}

pub struct Game {
    pub wind: Box<dyn WindField>,
    pub polar: Polar,
    pub land: Option<Land>,
    /// masque élargi d'une maille : le routeur et les points de départ/arrivée gardent cette distance à la côte
    pub land_margin: Option<Land>,
    pub course: Course,
    pub start_unix: f64,
    pub now: f64,
    pub player: Boat,
    pub ai: Vec<AiBoat>,
    pub finished_at: Option<f64>,
    pub grounded: bool,
    pub route: Option<RouteResult>,
    pub track: Vec<(f32, f32)>,
    last_track_t: f64,
}

#[derive(Serialize)]
pub struct BoatView {
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub heading: f64,
    pub speed: f64,
    pub dtf: f64,
    pub player: bool,
    pub finished: bool,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub now: f64,
    pub elapsed_s: f64,
    pub lat: f64,
    pub lon: f64,
    pub heading: f64,
    pub speed: f64,
    pub twa: f64,
    pub tws: f64,
    pub twd: f64,
    pub sail: &'static str,
    pub auto_sail: bool,
    pub pilot: String,
    pub dtf: f64,
    pub bearing_to_finish: f64,
    pub dist_sailed: f64,
    pub maneuvers: u32,
    pub maneuver_penalty: f64,
    pub grounded: bool,
    pub finished_at: Option<f64>,
    pub rank: usize,
    pub fleet: Vec<BoatView>,
}

const MAX_SUBSTEP: f64 = 10.0;
const FINISH_RADIUS_NM: f64 = 1.0;
const AI_NAMES: [&str; 5] = ["Armor Express", "Cap Ouessant", "Nordet", "Alizé Bleu", "Grain Noir"];

impl Game {
    pub fn new(mut course: Course, wind: Box<dyn WindField>, polar: Polar, land: Option<Land>, start_unix: f64) -> Game {
        let land_margin = land.as_ref().map(|l| l.dilated(1));
        if let Some(l) = &land_margin {
            // départ/arrivée posés sur la terre ou trop près de la côte (masque grossier) : ramenés en mer
            course.start = l.nearest_sea(course.start, 60.0).unwrap_or(course.start);
            course.finish = l.nearest_sea(course.finish, 60.0).unwrap_or(course.finish);
        }
        let h0 = bearing(course.start, course.finish);
        let mut player = Boat::new(course.start, h0);
        player.set_pilot(Pilot::Waypoint(course.finish));
        let ai = AI_NAMES
            .iter()
            .enumerate()
            .map(|(i, n)| {
                let mut b = Boat::new(LatLon::new(course.start.lat + 0.02 * (i as f64 - 2.0), course.start.lon + 0.01 * (i as f64 - 2.0)), h0);
                b.perf = 0.95 + 0.012 * i as f64; // de 95 % à 99,8 % de la polaire
                b.set_pilot(Pilot::Waypoint(course.finish));
                AiBoat { name: (*n).into(), boat: b, finished_at: None }
            })
            .collect();
        Game { wind, polar, land, land_margin, course, start_unix, now: start_unix, player, ai, finished_at: None, grounded: false, route: None, track: vec![], last_track_t: f64::MIN }
    }

    /// Fait avancer la simulation de `sim_dt` secondes de temps de jeu.
    pub fn tick(&mut self, sim_dt: f64) {
        let mut left = sim_dt;
        while left > 1e-9 {
            let dt = left.min(MAX_SUBSTEP);
            self.sub_step(dt);
            left -= dt;
        }
    }

    fn sub_step(&mut self, dt: f64) {
        let (finish, now) = (self.course.finish, self.now);
        let (wind, polar, land) = (self.wind.as_ref(), &self.polar, self.land.as_ref());

        if self.finished_at.is_none() {
            let prev = self.player.pos;
            self.player.step(dt, now, wind, polar);
            self.grounded = hits_land(land, prev, self.player.pos);
            if self.grounded {
                self.player.pos = prev;
                self.player.speed = 0.0;
            }
            if dist_nm(self.player.pos, finish) <= FINISH_RADIUS_NM {
                self.finished_at = Some(now + dt);
                self.player.speed = 0.0;
            }
        }
        for a in &mut self.ai {
            if a.finished_at.is_some() {
                continue;
            }
            let prev = a.boat.pos;
            a.boat.step(dt, now, wind, polar);
            if hits_land(land, prev, a.boat.pos) {
                a.boat.pos = prev;
                // l'IA se dégage en cherchant un autre bord
                a.boat.tack_side = -a.boat.tack_side;
            }
            if dist_nm(a.boat.pos, finish) <= FINISH_RADIUS_NM {
                a.finished_at = Some(now + dt);
            }
        }
        self.now += dt;
        if self.now - self.last_track_t >= 600.0 && self.finished_at.is_none() {
            self.track.push((self.player.pos.lat as f32, self.player.pos.lon as f32));
            self.last_track_t = self.now;
        }
    }

    /// Calcule la route optimale depuis la position et l'heure actuelles.
    /// `quality` : 0 rapide, 1 standard, 2 précis (voir `RouteConfig::quality`).
    pub fn compute_route(&mut self, quality: u8) -> &RouteResult {
        let mut cfg = RouteConfig::new(self.player.pos, self.course.finish, self.now).quality(quality);
        cfg.perf = self.player.perf;
        let r = route(&cfg, self.wind.as_ref(), &self.polar, self.land_margin.as_ref());
        self.route = Some(r);
        self.route.as_ref().unwrap()
    }

    /// Engage le pilote sur la dernière route calculée. Faux s'il n'y en a pas.
    ///
    /// La route est **rebasée sur l'instant présent** : seuls ses points futurs sont conservés, précédés de la
    /// position réelle du bateau. Cela évite de ramener en arrière un bateau qui a avancé pendant le calcul
    /// (le jeu tourne pendant que le routeur travaille dans son worker).
    pub fn follow_route(&mut self) -> bool {
        let Some(r) = &self.route else { return false };
        if r.points.len() < 2 {
            return false;
        }
        let mut plan = r.plan(self.course.finish, 4.0);
        let first_future = plan.pts.iter().position(|p| p.0 > self.now);
        match first_future {
            Some(i) => {
                let side = plan.pts[i].2;
                plan.pts.drain(..i);
                plan.pts.insert(0, (self.now, self.player.pos, side));
            }
            None => plan.pts = vec![(self.now, self.player.pos, 1.0), (self.now + 1.0, self.course.finish, 1.0)],
        }
        self.player.set_pilot(Pilot::Route(plan));
        true
    }

    /// Les bateaux IA suivent la route calculée (qualité rapide recommandée) avec leur propre performance,
    /// ce qui leur évite de se jeter sur la côte comme le ferait un simple cap vers l'arrivée.
    pub fn assign_ai_routes(&mut self) {
        if let Some(r) = self.route.clone() {
            self.assign_ai_from(&r);
        }
    }

    /// Idem avec une route fournie (calculée ailleurs, par exemple dans un worker).
    pub fn assign_ai_from(&mut self, r: &RouteResult) {
        if r.points.len() > 1 {
            for (i, a) in self.ai.iter_mut().enumerate() {
                a.boat.set_pilot(Pilot::Route(r.plan(self.course.finish, 3.0 + i as f64)));
            }
        }
    }

    pub fn leaderboard(&self) -> Vec<BoatView> {
        let fin = self.course.finish;
        let mut v: Vec<BoatView> = vec![BoatView {
            name: "Toi".into(),
            lat: self.player.pos.lat,
            lon: self.player.pos.lon,
            heading: self.player.heading,
            speed: self.player.speed,
            dtf: dist_nm(self.player.pos, fin),
            player: true,
            finished: self.finished_at.is_some(),
        }];
        for a in &self.ai {
            v.push(BoatView {
                name: a.name.clone(),
                lat: a.boat.pos.lat,
                lon: a.boat.pos.lon,
                heading: a.boat.heading,
                speed: a.boat.speed,
                dtf: dist_nm(a.boat.pos, fin),
                player: false,
                finished: a.finished_at.is_some(),
            });
        }
        v.sort_by(|a, b| a.dtf.partial_cmp(&b.dtf).unwrap());
        v
    }

    pub fn snapshot(&self) -> Snapshot {
        let fleet = self.leaderboard();
        let rank = fleet.iter().position(|b| b.player).unwrap_or(0) + 1;
        let b = &self.player;
        Snapshot {
            now: self.now,
            elapsed_s: self.now - self.start_unix,
            lat: b.pos.lat,
            lon: b.pos.lon,
            heading: b.heading,
            speed: b.speed,
            twa: b.twa,
            tws: b.tws,
            twd: b.twd,
            sail: b.sail.name(),
            auto_sail: b.auto_sail,
            pilot: b.pilot.label(),
            dtf: dist_nm(b.pos, self.course.finish),
            bearing_to_finish: bearing(b.pos, self.course.finish),
            dist_sailed: b.dist_sailed_nm,
            maneuvers: b.maneuvers,
            maneuver_penalty: 1.0 - b.last_maneuver.factor(b.since_maneuver_s),
            grounded: self.grounded,
            finished_at: self.finished_at,
            rank,
            fleet,
        }
    }

    /// Vent échantillonné sur une grille (pour l'affichage) : [u, v] en nds par point, lignes du sud au nord.
    pub fn wind_grid(&self, lat0: f64, lon0: f64, lat1: f64, lon1: f64, nx: usize, ny: usize, t: f64) -> Vec<f32> {
        let mut out = Vec::with_capacity(nx * ny * 2);
        for j in 0..ny {
            let lat = lat0 + (lat1 - lat0) * j as f64 / (ny.max(2) - 1) as f64;
            for i in 0..nx {
                let lon = lon0 + (lon1 - lon0) * i as f64 / (nx.max(2) - 1) as f64;
                let w: Wind = self.wind.wind_at(LatLon::new(lat, lon), t);
                out.push(w.u as f32);
                out.push(w.v as f32);
            }
        }
        out
    }
}

fn hits_land(land: Option<&Land>, a: LatLon, b: LatLon) -> bool {
    land.map_or(false, |l| l.segment_hits(a, b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wind::{SyntheticWind, UniformWind};

    fn open_game(wind: Box<dyn WindField>) -> Game {
        let course = Course { name: "test".into(), start: LatLon::new(0.0, -40.0), finish: LatLon::new(0.0, -35.0) };
        Game::new(course, wind, Polar::imoca_generic(), None, 0.0)
    }

    #[test]
    fn router_plan_followed_by_the_boat_arrives_on_time() {
        // vent de travers puis près : le routeur et le simulateur partagent polaire, vent et modèle de manœuvre.
        let mut g = open_game(Box::new(UniformWind(Wind::from_speed_dir(14.0, 60.0))));
        g.compute_route(1);
        let (eta, reached) = {
            let r = g.route.as_ref().unwrap();
            (r.duration_s, r.reached)
        };
        assert!(reached);
        assert!(g.follow_route());
        let mut guard = 0;
        while g.finished_at.is_none() && guard < 100_000 {
            g.tick(60.0);
            guard += 1;
        }
        let actual = g.finished_at.expect("le bateau doit finir") - g.start_unix;
        let err = (actual - eta).abs() / eta;
        assert!(err < 0.06, "routeur {:.0}s vs simulé {:.0}s ({:.1} %)", eta, actual, err * 100.0);
    }

    #[test]
    fn stale_route_is_rebased_on_the_present() {
        // Le routeur est calculé au temps 0, mais le bateau a avancé de 5 h (autre pilote) avant d'engager la route.
        let mut g = open_game(Box::new(UniformWind(Wind::from_speed_dir(14.0, 60.0))));
        g.compute_route(1);
        g.player.set_pilot(Pilot::Twa(-46.0));
        g.tick(5.0 * 3600.0);
        let d_before = g.player.dtf_nm(g.course.finish);
        assert!(g.follow_route());
        // on ne doit pas faire demi-tour vers le début de la route : la distance à l'arrivée doit diminuer
        g.tick(2.0 * 3600.0);
        let d_after = g.player.dtf_nm(g.course.finish);
        assert!(d_after < d_before, "le bateau recule : {d_before:.0} -> {d_after:.0} nm");
        let mut guard = 0;
        while g.finished_at.is_none() && guard < 5000 {
            g.tick(60.0);
            guard += 1;
        }
        let t = g.finished_at.expect("doit arriver") / 3600.0;
        assert!(t < 30.0, "arrivée en {t:.1} h : trop lent pour un plan à 21 h + 5 h de retard");
    }

    #[test]
    fn waypoint_pilot_beats_a_dumb_heading_when_upwind() {
        let mk = || open_game(Box::new(UniformWind(Wind::from_speed_dir(14.0, 90.0)))); // vent d'est, arrivée plein est
        let mut smart = mk();
        let mut dumb = mk();
        dumb.player.set_pilot(Pilot::Twa(30.0)); // coincé dans la zone interdite : n'avance pas
        for _ in 0..(48 * 60) {
            smart.tick(60.0);
            dumb.tick(60.0);
        }
        assert!(smart.player.dtf_nm(smart.course.finish) < dumb.player.dtf_nm(dumb.course.finish));
        assert!(smart.finished_at.is_some() || smart.player.maneuvers >= 1, "doit louvoyer");
    }

    #[test]
    fn tacking_costs_speed() {
        let mut g = open_game(Box::new(UniformWind(Wind::from_speed_dir(14.0, 90.0))));
        g.player.set_pilot(Pilot::Twa(45.0));
        g.tick(600.0);
        let before = g.player.speed;
        g.player.set_pilot(Pilot::Twa(-45.0)); // virement de bord
        let mut min_speed = before;
        for _ in 0..30 {
            g.tick(10.0);
            min_speed = min_speed.min(g.player.speed);
        }
        assert_eq!(g.player.maneuvers, 1);
        assert!(min_speed < before * 0.75, "perte de vitesse attendue : {min_speed} vs {before}");
        assert!(g.player.speed > before * 0.95, "la vitesse doit revenir");
    }

    #[test]
    fn grounding_stops_the_boat() {
        let island = r#"{"type":"Polygon","coordinates":[[[-39.0,-1.0],[-38.0,-1.0],[-38.0,1.0],[-39.0,1.0],[-39.0,-1.0]]]}"#;
        let land = Land::from_geojson(island, -5.0, 5.0, -45.0, -30.0, 0.05).unwrap();
        let course = Course { name: "t".into(), start: LatLon::new(0.0, -40.0), finish: LatLon::new(0.0, -35.0) };
        let mut g = Game::new(course, Box::new(UniformWind(Wind::from_speed_dir(15.0, 0.0))), Polar::imoca_generic(), Some(land), 0.0);
        g.player.set_pilot(Pilot::Heading(90.0));
        for _ in 0..600 {
            g.tick(60.0);
        }
        assert!(g.grounded);
        assert!(g.player.pos.lon < -38.9, "ne traverse pas l'île : {}", g.player.pos.lon);
    }

    #[test]
    fn full_atlantic_with_synthetic_wind_and_ai() {
        let course = Course::route_du_rhum();
        let g0 = Game::new(course, Box::new(SyntheticWind::atlantic(0.0)), Polar::imoca_generic(), None, 0.0);
        let mut g = g0;
        g.tick(3600.0 * 24.0);
        let s = g.snapshot();
        assert_eq!(s.fleet.len(), 6);
        assert!(s.dist_sailed > 100.0, "le bateau avance : {}", s.dist_sailed);
        assert!(s.rank >= 1 && s.rank <= 6);
    }
}
