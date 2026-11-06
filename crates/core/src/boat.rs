//! Bateau, voiles, manœuvres et pilote automatique.

use crate::geo::{bearing, cross_track_nm, destination, dist_nm, norm180, norm360, LatLon, DEG_NM};
use crate::polar::Polar;
use crate::wind::WindField;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sail {
    Jib,
    Code0,
    Spi,
    StormJib,
}

impl Sail {
    pub fn name(&self) -> &'static str {
        match self {
            Sail::Jib => "Foc",
            Sail::Code0 => "Code 0",
            Sail::Spi => "Spi",
            Sail::StormJib => "Trinquette",
        }
    }

    /// Choix automatique de la voile (affichage/stratégie ; la vitesse vient de la polaire).
    pub fn auto(twa_abs: f64, tws: f64) -> Sail {
        if tws > 30.0 {
            Sail::StormJib
        } else if twa_abs < 70.0 {
            Sail::Jib
        } else if twa_abs < 115.0 {
            if tws < 18.0 { Sail::Code0 } else { Sail::Jib }
        } else if tws < 26.0 {
            Sail::Spi
        } else {
            Sail::Jib
        }
    }
}

/// Perte de vitesse après une manœuvre : `loss` (0..1) à l'instant 0, retour linéaire en `recovery_s`.
#[derive(Clone, Copy, Debug)]
pub struct Maneuver {
    pub loss: f64,
    pub recovery_s: f64,
    /// Temps passé à l'arrêt en traversant la zone interdite face au vent (virement seulement).
    /// Cohérent avec `Boat::turn_rate` = 3 °/s et une zone interdite de ±30° de la polaire générique.
    pub stall_s: f64,
}

impl Maneuver {
    pub const TACK: Maneuver = Maneuver { loss: 0.35, recovery_s: 60.0, stall_s: 20.0 };
    pub const GYBE: Maneuver = Maneuver { loss: 0.25, recovery_s: 60.0, stall_s: 0.0 };

    pub fn factor(&self, since_s: f64) -> f64 {
        1.0 - self.loss * (1.0 - since_s / self.recovery_s).max(0.0)
    }
    /// Temps perdu équivalent (s) : arrêt + intégrale de la perte pendant la récupération.
    pub fn lost_time_s(&self) -> f64 {
        self.stall_s + self.loss * self.recovery_s / 2.0
    }
}

#[derive(Clone, Debug)]
pub enum Pilot {
    /// Cap magnétique fixe.
    Heading(f64),
    /// Angle au vent vrai constant (signé : + vent par tribord).
    Twa(f64),
    /// Meilleur VMG au près (garde l'amure actuelle).
    VmgUp,
    /// Meilleur VMG au portant (garde l'amure actuelle).
    VmgDown,
    /// Rallie un point : cap direct si possible, sinon louvoie au meilleur VMC dans un couloir.
    Waypoint(LatLon),
    /// Suit une route calculée par le routeur en visant un point « lièvre » en avance sur la route.
    Route(RoutePlan),
}

/// Route à suivre : points datés (instant Unix, position, signe du TWA du tronçon qui y arrive).
#[derive(Clone, Debug)]
pub struct RoutePlan {
    pub pts: Vec<(f64, LatLon, f64)>,
    pub finish: LatLon,
    /// distance (nm) entre la projection du bateau sur la route et le point visé
    pub lead_nm: f64,
}

impl RoutePlan {
    /// Poursuite : projette `pos` sur la polyligne (sans jamais reculer grâce à `cursor`) puis vise le point
    /// situé `lead_nm` plus loin. Renvoie ce point et l'amure du tronçon **courant** (+1 tribord, -1 bâbord).
    pub fn carrot(&self, pos: LatLon, cursor: &mut usize) -> (LatLon, f64) {
        let n = self.pts.len();
        if n < 2 {
            return (self.finish, 1.0);
        }
        let local = |a: LatLon, p: LatLon| ((p.lon - a.lon) * DEG_NM * a.lat.to_radians().cos(), (p.lat - a.lat) * DEG_NM);
        let lerp = |a: LatLon, b: LatLon, f: f64| LatLon::new(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f);
        // Tronçon le plus proche parmi le courant et les 3 suivants (jamais en arrière). Les égalités vont au
        // plus tardif : au sommet d'un virement on bascule sur le nouveau tronçon dès qu'il est aussi proche.
        let c0 = (*cursor).min(n - 2);
        let (mut c, mut best_d, mut f) = (c0, f64::MAX, 0.0);
        for k in c0..=(c0 + 3).min(n - 2) {
            let (a, b) = (self.pts[k].1, self.pts[k + 1].1);
            let ((bx, by), (px, py)) = (local(a, b), local(a, pos));
            let len2 = bx * bx + by * by;
            let fk = if len2 > 1e-9 { ((px * bx + py * by) / len2).clamp(0.0, 1.0) } else { 0.0 };
            let d = (px - fk * bx).hypot(py - fk * by);
            if d <= best_d + 1e-9 {
                (c, best_d, f) = (k, d, fk);
            }
        }
        *cursor = c;
        let side = self.pts[c + 1].2;
        let (mut seg, mut start, mut left) = (c, lerp(self.pts[c].1, self.pts[c + 1].1, f), self.lead_nm);
        loop {
            let end = self.pts[seg + 1].1;
            let d = dist_nm(start, end);
            if d >= left {
                return (lerp(start, end, left / d.max(1e-9)), side);
            }
            left -= d;
            seg += 1;
            if seg + 1 >= n {
                return (self.finish, side);
            }
            start = self.pts[seg].1;
        }
    }
}

impl Pilot {
    pub fn label(&self) -> String {
        match self {
            Pilot::Heading(h) => format!("Cap {:.0}°", h),
            Pilot::Twa(a) => format!("TWA {:+.0}°", a),
            Pilot::VmgUp => "VMG près".into(),
            Pilot::VmgDown => "VMG portant".into(),
            Pilot::Waypoint(_) => "Vers le point".into(),
            Pilot::Route(_) => "Route du routeur".into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Boat {
    pub pos: LatLon,
    pub heading: f64,
    pub speed: f64,
    pub twa: f64,
    pub tws: f64,
    pub twd: f64,
    pub sail: Sail,
    pub auto_sail: bool,
    pub pilot: Pilot,
    /// Facteur global de performance (1.0 = polaire exacte), utile pour les bateaux IA.
    pub perf: f64,
    pub dist_sailed_nm: f64,
    pub since_maneuver_s: f64,
    pub last_maneuver: Maneuver,
    pub maneuvers: u32,
    /// amure choisie par le pilote waypoint (+1 tribord, -1 bâbord)
    pub tack_side: f64,
    pub leg_start: LatLon,
    pub corridor_nm: f64,
    /// vitesse de rotation maximale (°/s)
    pub turn_rate: f64,
    /// avancement sur la route du routeur (indice de tronçon)
    pub route_cursor: usize,
}

impl Boat {
    pub fn new(pos: LatLon, heading: f64) -> Boat {
        Boat {
            pos,
            heading,
            speed: 0.0,
            twa: 0.0,
            tws: 0.0,
            twd: 0.0,
            sail: Sail::Jib,
            auto_sail: true,
            pilot: Pilot::Heading(heading),
            perf: 1.0,
            dist_sailed_nm: 0.0,
            since_maneuver_s: 1e9,
            last_maneuver: Maneuver::TACK,
            maneuvers: 0,
            tack_side: 1.0,
            leg_start: pos,
            corridor_nm: 4.0,
            turn_rate: 3.0,
            route_cursor: 0,
        }
    }

    pub fn set_pilot(&mut self, p: Pilot) {
        self.route_cursor = 0;
        if let Pilot::Waypoint(_) = p {
            self.leg_start = self.pos;
            self.tack_side = if self.twa >= 0.0 { 1.0 } else { -1.0 };
        }
        self.pilot = p;
    }

    fn desired_heading(&mut self, polar: &Polar, twd: f64, tws: f64) -> f64 {
        match self.pilot.clone() {
            Pilot::Heading(h) => h,
            Pilot::Twa(a) => norm360(twd - a),
            Pilot::VmgUp => {
                let side = if self.twa >= 0.0 { 1.0 } else { -1.0 };
                norm360(twd - side * polar.best_upwind(tws).0)
            }
            Pilot::VmgDown => {
                let side = if self.twa >= 0.0 { 1.0 } else { -1.0 };
                norm360(twd - side * polar.best_downwind(tws).0)
            }
            Pilot::Waypoint(target) => self.waypoint_heading(polar, twd, tws, target),
            Pilot::Route(plan) => {
                let mut cur = self.route_cursor;
                let (carrot, side) = plan.carrot(self.pos, &mut cur);
                self.route_cursor = cur;
                let h = bearing(self.pos, carrot);
                let twa = norm180(twd - h);
                if twa.abs() < 60.0 {
                    // Écarté de la route, le point visé peut être dans la zone interdite : on garde l'amure
                    // prévue au plus près (marge de 4° : le routeur échantillonne les caps par pas de 2°).
                    let a_up = polar.best_upwind(tws).0 - 4.0;
                    if twa.abs() < a_up {
                        return norm360(twd - side * a_up);
                    }
                }
                h
            }
        }
    }

    /// Cap vers `target` en maximisant le VMC, avec louvoyage par couloir.
    fn waypoint_heading(&mut self, polar: &Polar, twd: f64, tws: f64, target: LatLon) -> f64 {
        let b = bearing(self.pos, target);
        // Meilleur VMC sur chaque amure.
        let best = |side: f64| -> (f64, f64) {
            let (mut bh, mut bv) = (b, f64::MIN);
            let mut d = -90.0;
            while d <= 90.0 {
                let h = norm360(b + d);
                let twa = norm180(twd - h);
                if twa * side >= 0.0 {
                    let v = polar.speed(twa.abs(), tws) * d.to_radians().cos();
                    if v > bv {
                        bv = v;
                        bh = h;
                    }
                }
                d += 1.0;
            }
            (bh, bv)
        };
        let (h_stb, v_stb) = best(1.0);
        let (h_prt, v_prt) = best(-1.0);
        // Si le cap direct est atteignable aussi bien que le meilleur louvoyage, on y va tout droit.
        let direct = polar.speed(norm180(twd - b).abs(), tws);
        let best_v = v_stb.max(v_prt);
        if direct >= best_v - 1e-9 {
            return b;
        }
        // Louvoyage : on garde l'amure jusqu'à sortir du couloir autour de la route directe.
        let xt = cross_track_nm(self.leg_start, target, self.pos); // >0 : à droite de la route
        let cur = self.tack_side;
        // Le cap de l'amure `cur` s'écarte de la route d'un côté donné ; on change si on est trop loin de ce côté.
        let h_cur = if cur >= 0.0 { h_stb } else { h_prt };
        let drift_side = norm180(h_cur - b).signum(); // + : ce bord nous envoie à droite de la route
        // Couloir : au moins `corridor_nm`, et 4 % de la distance restante pour limiter les virements en océan.
        let corridor = self.corridor_nm.max(0.04 * dist_nm(self.pos, target));
        let out = xt * drift_side > corridor;
        let other_ok = if cur >= 0.0 { v_prt } else { v_stb } > 0.0;
        if out && other_ok {
            self.tack_side = -cur;
        }
        if self.tack_side >= 0.0 { h_stb } else { h_prt }
    }

    /// Avance le bateau de `dt` secondes à l'instant Unix `t`.
    pub fn step(&mut self, dt: f64, t: f64, wind: &dyn WindField, polar: &Polar) {
        let w = wind.wind_at(self.pos, t);
        let (tws, twd) = (w.tws(), w.twd());
        let want = self.desired_heading(polar, twd, tws);
        let max_turn = self.turn_rate * dt;
        let prev_twa = norm180(twd - self.heading);
        self.heading = norm360(self.heading + norm180(want - self.heading).clamp(-max_turn, max_turn));
        let twa = norm180(twd - self.heading);

        // Changement de bord : le signe du TWA s'inverse en passant par le lit du vent (0°) ou 180°.
        if prev_twa.signum() != twa.signum() && prev_twa != 0.0 && twa != 0.0 && self.dist_sailed_nm > 0.01 {
            // deux angles < 90° de part et d'autre du lit du vent : virement ; sinon : empannage
            self.last_maneuver = if prev_twa.abs() < 90.0 && twa.abs() < 90.0 { Maneuver::TACK } else { Maneuver::GYBE };
            self.since_maneuver_s = 0.0;
            self.maneuvers += 1;
        } else {
            self.since_maneuver_s += dt;
        }

        self.twa = twa;
        self.tws = tws;
        self.twd = twd;
        if self.auto_sail {
            self.sail = Sail::auto(twa.abs(), tws);
        }
        let f = self.last_maneuver.factor(self.since_maneuver_s);
        self.speed = polar.speed(twa.abs(), tws) * self.perf * f;
        let d = self.speed * dt / 3600.0;
        self.pos = destination(self.pos, self.heading, d);
        self.dist_sailed_nm += d;
    }

    pub fn dtf_nm(&self, target: LatLon) -> f64 {
        dist_nm(self.pos, target)
    }
}
