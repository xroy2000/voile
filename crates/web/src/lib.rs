//! Liaison WebAssembly : `Sim` expose le jeu et le routeur au JavaScript.

use regatta_core::game::{Course, Game};
use regatta_core::land::Land;
use regatta_core::polar::Polar;
use regatta_core::router::{route, RouteConfig, RouteResult};
use regatta_core::wind::{GridWind, SyntheticWind, WindField};
use regatta_core::LatLon;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Zone rasterisée pour la terre : Atlantique Nord élargi.
const LAND_AREA: (f64, f64, f64, f64) = (-10.0, 70.0, -100.0, 30.0);
const LAND_RES: f64 = 0.05;

#[wasm_bindgen]
pub struct Sim {
    game: Game,
    wind: Option<GridWind>,
    land: Option<Land>,
    polar: Polar,
    polar_name: String,
    /// facteur de performance du bateau du joueur (1.0 = polaire exacte) ; les adversaires le suivent
    perf: f64,
}

#[derive(Serialize)]
struct RouteOut<'a> {
    points: &'a [regatta_core::router::RoutePoint],
    isochrones: Vec<Vec<(f32, f32)>>,
    reached: bool,
    eta_unix: f64,
    duration_s: f64,
    distance_nm: f64,
    best_dist_to_dest_nm: f64,
    tacks: u32,
    gybes: u32,
    dt_s: f64,
}

#[derive(Serialize, Deserialize)]
struct BoatSave {
    lat: f64,
    lon: f64,
    heading: f64,
    speed: f64,
    twa: f64,
    tws: f64,
    twd: f64,
    dist_sailed_nm: f64,
    maneuvers: u32,
    since_maneuver_s: f64,
    tack_side: f64,
}

#[derive(Serialize, Deserialize)]
struct GameSave {
    now: f64,
    finished_at: Option<f64>,
    grounded: bool,
    player: BoatSave,
    ai: Vec<(BoatSave, Option<f64>)>,
    track: Vec<(f32, f32)>,
}

impl BoatSave {
    fn of(b: &regatta_core::boat::Boat) -> Self {
        BoatSave { lat: b.pos.lat, lon: b.pos.lon, heading: b.heading, speed: b.speed, twa: b.twa, tws: b.tws, twd: b.twd, dist_sailed_nm: b.dist_sailed_nm, maneuvers: b.maneuvers, since_maneuver_s: b.since_maneuver_s.min(1e9), tack_side: b.tack_side }
    }
    fn apply(&self, b: &mut regatta_core::boat::Boat) {
        b.pos = LatLon::new(self.lat, self.lon);
        b.leg_start = b.pos;
        b.heading = self.heading;
        b.speed = self.speed;
        b.twa = self.twa;
        b.tws = self.tws;
        b.twd = self.twd;
        b.dist_sailed_nm = self.dist_sailed_nm;
        b.maneuvers = self.maneuvers;
        b.since_maneuver_s = self.since_maneuver_s;
        b.tack_side = self.tack_side;
    }
}

fn js_err(s: impl Into<String>) -> JsError {
    JsError::new(&s.into())
}

fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
}

impl Sim {
    fn wind_box(wind: &Option<GridWind>, start: f64) -> Box<dyn WindField> {
        match wind {
            Some(g) => Box::new(g.clone()),
            None => Box::new(SyntheticWind::atlantic(start)),
        }
    }

    fn route_out(r: &RouteResult, dt_s: f64) -> String {
        // une isochrone toutes les ~6 h pour l'affichage
        let stride = ((6.0 * 3600.0 / dt_s).round() as usize).max(1);
        let isochrones = r.isochrones.iter().enumerate().filter(|(i, _)| (i + 1) % stride == 0).map(|(_, v)| v.clone()).collect();
        to_json(&RouteOut {
            points: &r.points,
            isochrones,
            reached: r.reached,
            eta_unix: r.eta_unix,
            duration_s: r.duration_s,
            distance_nm: r.distance_nm,
            best_dist_to_dest_nm: r.best_dist_to_dest_nm,
            tacks: r.tacks,
            gybes: r.gybes,
            dt_s,
        })
    }

    fn build_game(&self, course: Course, start: f64) -> Game {
        let mut g = Game::new(course, Self::wind_box(&self.wind, start), self.polar.clone(), self.land.clone(), start);
        Self::apply_perf(&mut g, self.perf);
        g
    }

    /// Joueur à `perf` × polaire ; adversaires à leur écart habituel (95 % à 99,8 %) de ce niveau.
    fn apply_perf(g: &mut Game, perf: f64) {
        g.player.perf = perf;
        for (i, a) in g.ai.iter_mut().enumerate() {
            a.boat.perf = (0.95 + 0.012 * i as f64) * perf;
        }
    }
}

#[wasm_bindgen]
impl Sim {
    /// `wind_bin` : fichier VWN1 produit par `gribtool` (absent = vent synthétique).
    /// `land_geojson` : polygones de terre (absent = pas de côtes). `polar_text` : CSV/.pol (absent = polaire générique).
    /// `now_unix` : instant de départ souhaité (ramené dans la plage de la prévision).
    #[wasm_bindgen(constructor)]
    pub fn new(wind_bin: Option<Vec<u8>>, land_geojson: Option<String>, polar_text: Option<String>, now_unix: f64) -> Result<Sim, JsError> {
        console_error_panic_hook::set_once();
        let wind = match wind_bin {
            Some(b) if !b.is_empty() => Some(GridWind::from_bytes(&b).map_err(js_err)?),
            _ => None,
        };
        let land = match land_geojson {
            Some(s) if !s.is_empty() => {
                let (a, b, c, d) = LAND_AREA;
                Some(Land::from_geojson(&s, a, b, c, d, LAND_RES).map_err(js_err)?)
            }
            _ => None,
        };
        let (polar, polar_name) = match polar_text {
            Some(t) if !t.trim().is_empty() => (Polar::from_text(&t).map_err(|e| js_err(format!("polaire : {e}")))?, "fichier chargé".to_string()),
            _ => (Polar::imoca_generic(), "générique (approximative)".to_string()),
        };
        let start = match &wind {
            Some(g) => {
                let (lo, hi) = g.time_range().unwrap();
                now_unix.clamp(lo, (hi - 12.0 * 3600.0).max(lo))
            }
            None => now_unix,
        };
        let mut s = Sim { game: Game::new(Course::route_du_rhum(), Box::new(SyntheticWind::atlantic(0.0)), polar.clone(), None, start), wind, land, polar, polar_name, perf: 1.0 };
        s.game = s.build_game(Course::route_du_rhum(), start);
        Ok(s)
    }

    /// Repart de zéro sur un nouveau parcours (départ = ta position réelle dans le jeu, par exemple).
    pub fn reset(&mut self, start_lat: f64, start_lon: f64, finish_lat: f64, finish_lon: f64, start_unix: f64) {
        let start = match &self.wind {
            Some(g) => {
                let (lo, hi) = g.time_range().unwrap();
                start_unix.clamp(lo, (hi - 6.0 * 3600.0).max(lo))
            }
            None => start_unix,
        };
        let course = Course { name: "Parcours".into(), start: LatLon::new(start_lat, start_lon), finish: LatLon::new(finish_lat, finish_lon) };
        self.game = self.build_game(course, start);
    }

    /// Performance du bateau (1.0 = polaire exacte), bornée à 5–150 %. Vaut pour le jeu, les adversaires et le routeur.
    pub fn set_perf(&mut self, perf: f64) {
        self.perf = perf.clamp(0.05, 1.5);
        Self::apply_perf(&mut self.game, self.perf);
    }

    pub fn perf(&self) -> f64 {
        self.perf
    }

    /// Vitesse de la polaire (nds) pour un TWA et un vent donnés, sans le facteur de performance.
    pub fn polar_speed(&self, twa: f64, tws: f64) -> f64 {
        self.polar.speed(twa.abs(), tws)
    }

    pub fn set_polar(&mut self, text: &str) -> Result<(), JsError> {
        self.polar = Polar::from_text(text).map_err(|e| js_err(format!("polaire : {e}")))?;
        self.polar_name = "fichier chargé".into();
        self.game.polar = self.polar.clone();
        Ok(())
    }

    pub fn tick(&mut self, sim_dt: f64) {
        if sim_dt > 0.0 {
            self.game.tick(sim_dt.min(7.0 * 86400.0));
        }
    }

    pub fn snapshot(&self) -> String {
        to_json(&self.game.snapshot())
    }

    pub fn info(&self) -> String {
        #[derive(Serialize)]
        struct Info<'a> {
            has_grid: bool,
            t_min: Option<f64>,
            t_max: Option<f64>,
            start_unix: f64,
            start: LatLon,
            finish: LatLon,
            polar_name: &'a str,
            has_land: bool,
            track: &'a [(f32, f32)],
        }
        let tr = self.wind.as_ref().and_then(|g| g.time_range());
        to_json(&Info {
            has_grid: self.wind.is_some(),
            t_min: tr.map(|t| t.0),
            t_max: tr.map(|t| t.1),
            start_unix: self.game.start_unix,
            start: self.game.course.start,
            finish: self.game.course.finish,
            polar_name: &self.polar_name,
            has_land: self.land.is_some(),
            track: &self.game.track,
        })
    }

    // ---- pilote -------------------------------------------------------------------------------

    pub fn set_heading(&mut self, h: f64) {
        self.game.player.set_pilot(regatta_core::boat::Pilot::Heading(h.rem_euclid(360.0)));
    }
    /// TWA signé : positif = vent par tribord.
    pub fn set_twa(&mut self, a: f64) {
        self.game.player.set_pilot(regatta_core::boat::Pilot::Twa(a.clamp(-180.0, 180.0)));
    }
    pub fn set_vmg(&mut self, upwind: bool) {
        self.game.player.set_pilot(if upwind { regatta_core::boat::Pilot::VmgUp } else { regatta_core::boat::Pilot::VmgDown });
    }
    pub fn set_waypoint(&mut self, lat: f64, lon: f64) {
        self.game.player.set_pilot(regatta_core::boat::Pilot::Waypoint(LatLon::new(lat, lon)));
    }
    pub fn set_waypoint_finish(&mut self) {
        let f = self.game.course.finish;
        self.game.player.set_pilot(regatta_core::boat::Pilot::Waypoint(f));
    }

    // ---- routeur ------------------------------------------------------------------------------

    /// Route calculée depuis un point et un instant quelconques, sans toucher à la partie en cours
    /// (c'est ce qu'appelle le worker). `quality` : 0 rapide, 1 standard, 2 précis.
    pub fn route_from(&self, lat: f64, lon: f64, t0: f64, quality: u8) -> String {
        let mut cfg = RouteConfig::new(LatLon::new(lat, lon), self.game.course.finish, t0).quality(quality);
        cfg.perf = self.perf;
        let r = route(&cfg, self.game.wind.as_ref(), &self.polar, self.game.land_margin.as_ref());
        Self::route_out(&r, cfg.dt_s)
    }

    /// Comme `route_from` mais vers un point d'arrivée quelconque (point de routage intermédiaire).
    pub fn route_leg(&self, lat: f64, lon: f64, t0: f64, quality: u8, dest_lat: f64, dest_lon: f64) -> String {
        let mut cfg = RouteConfig::new(LatLon::new(lat, lon), LatLon::new(dest_lat, dest_lon), t0).quality(quality);
        cfg.perf = self.perf;
        let r = route(&cfg, self.game.wind.as_ref(), &self.polar, self.game.land_margin.as_ref());
        Self::route_out(&r, cfg.dt_s)
    }

    /// Mode du pilote : [type, a, b] — 0 cap (a = cap), 1 TWA (a = TWA signé), 2 VMG près, 3 VMG portant,
    /// 4 vers un point (a, b = lat, lon), 5 route du routeur.
    pub fn pilot_target(&self) -> Vec<f64> {
        use regatta_core::boat::Pilot;
        match &self.game.player.pilot {
            Pilot::Heading(h) => vec![0.0, *h, 0.0],
            Pilot::Twa(a) => vec![1.0, *a, 0.0],
            Pilot::VmgUp => vec![2.0, 0.0, 0.0],
            Pilot::VmgDown => vec![3.0, 0.0, 0.0],
            Pilot::Waypoint(p) => vec![4.0, p.lat, p.lon],
            Pilot::Route(_) => vec![5.0, 0.0, 0.0],
        }
    }

    /// État de la partie (temps, bateau, adversaires, trace) en JSON, pour la sauvegarde.
    /// Le pilote et la route sont sauvegardés côté JavaScript (`pilot_target`, route du routeur).
    pub fn export_state(&self) -> String {
        to_json(&GameSave {
            now: self.game.now,
            finished_at: self.game.finished_at,
            grounded: self.game.grounded,
            player: BoatSave::of(&self.game.player),
            ai: self.game.ai.iter().map(|a| (BoatSave::of(&a.boat), a.finished_at)).collect(),
            track: self.game.track.clone(),
        })
    }

    /// Restaure un état produit par `export_state` sur la même partie (même parcours, même vent).
    pub fn import_state(&mut self, json: &str) -> Result<(), JsError> {
        let g: GameSave = serde_json::from_str(json).map_err(|e| js_err(format!("sauvegarde illisible : {e}")))?;
        self.game.now = g.now;
        self.game.finished_at = g.finished_at;
        self.game.grounded = g.grounded;
        g.player.apply(&mut self.game.player);
        for (a, (bs, fin)) in self.game.ai.iter_mut().zip(g.ai.iter()) {
            bs.apply(&mut a.boat);
            a.finished_at = *fin;
        }
        self.game.track = g.track;
        Ok(())
    }

    /// Mémorise une route (format `to_flat`) pour que le pilote puisse la suivre.
    pub fn set_route_flat(&mut self, flat: &[f64]) -> bool {
        match RouteResult::from_flat(flat, self.game.now) {
            Some(r) => {
                self.game.route = Some(r);
                true
            }
            None => false,
        }
    }

    pub fn follow_route(&mut self) -> bool {
        self.game.follow_route()
    }

    /// Les bateaux adverses suivent cette route (format `to_flat`).
    pub fn set_ai_route_flat(&mut self, flat: &[f64]) -> bool {
        match RouteResult::from_flat(flat, self.game.start_unix) {
            Some(r) => {
                self.game.assign_ai_from(&r);
                true
            }
            None => false,
        }
    }

    // ---- affichage ----------------------------------------------------------------------------

    /// Vent échantillonné [u, v, u, v, …] (nds), lignes du sud au nord, à l'instant courant du jeu.
    pub fn wind_grid(&self, lat0: f64, lon0: f64, lat1: f64, lon1: f64, nx: usize, ny: usize) -> Vec<f32> {
        self.game.wind_grid(lat0, lon0, lat1, lon1, nx.clamp(2, 200), ny.clamp(2, 200), self.game.now)
    }

    /// [tws, twd] à un point, à l'instant courant plus `dh` heures.
    pub fn wind_at(&self, lat: f64, lon: f64, dh: f64) -> Vec<f64> {
        let w = self.game.wind.wind_at(LatLon::new(lat, lon), self.game.now + dh * 3600.0);
        vec![w.tws(), w.twd()]
    }

    /// Vent en plusieurs points : entrée [lat, lon, lat, lon, …], sortie [u, v, u, v, …] (nds), à l'instant courant.
    pub fn wind_at_many(&self, coords: &[f64]) -> Vec<f32> {
        let mut out = Vec::with_capacity(coords.len());
        for c in coords.chunks_exact(2) {
            let w = self.game.wind.wind_at(LatLon::new(c[0], c[1]), self.game.now);
            out.push(w.u as f32);
            out.push(w.v as f32);
        }
        out
    }

    /// Vitesse du bateau pour TWA = 0, 2, …, 180° au vent `tws` : pour tracer le diagramme polaire.
    pub fn polar_curve(&self, tws: f64) -> Vec<f64> {
        (0..=90).map(|i| self.polar.speed(i as f64 * 2.0, tws)).collect()
    }

    pub fn polar_best_angles(&self, tws: f64) -> Vec<f64> {
        let (au, vu) = self.polar.best_upwind(tws);
        let (ad, vd) = self.polar.best_downwind(tws);
        vec![au, vu, ad, vd]
    }
}

/// Utilitaire natif pour les tests : durée d'un calcul de route.
#[cfg(not(target_arch = "wasm32"))]
pub fn smoke(wind: Option<Vec<u8>>, land: Option<String>) -> Result<(String, String), String> {
    let mut s = Sim::new(wind, land, None, 0.0).map_err(|_| "init".to_string())?;
    s.tick(3600.0);
    let (lat, lon, t) = (s.game.player.pos.lat, s.game.player.pos.lon, s.game.now);
    Ok((s.snapshot(), s.route_from(lat, lon, t, 0)))
}
