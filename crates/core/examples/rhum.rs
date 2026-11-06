use regatta_core::game::Course;
use regatta_core::land::Land;
use regatta_core::polar::Polar;
use regatta_core::router::{route, RouteConfig};
use regatta_core::wind::SyntheticWind;
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).unwrap_or("web/assets/land50.geojson".into());
    let json = std::fs::read_to_string(&path).expect("geojson");
    let t = Instant::now();
    let land = Land::from_geojson(&json, -10.0, 70.0, -100.0, 30.0, 0.05).unwrap();
    println!("masque de terre : {} polygones, {} cellules, {:?}", land.polygons, land.cells_land(), t.elapsed());
    let c = Course::route_du_rhum();
    let polar = Polar::imoca_generic();
    let wind = SyntheticWind::atlantic(0.0);
    for (dt, step) in [(3600.0, 3.0), (1800.0, 2.0)] {
        let mut cfg = RouteConfig::new(c.start, c.finish, 0.0);
        cfg.dt_s = dt;
        cfg.heading_step = step;
        let t = Instant::now();
        let r = route(&cfg, &wind, &polar, Some(&land));
        println!(
            "dt={:>5}s pas={}° : atteint={} durée={:.1} j  dist={:.0} nm  virements={} empannages={} isochrones={} calcul={:?}",
            dt, step, r.reached, r.duration_s / 86400.0, r.distance_nm, r.tacks, r.gybes, r.isochrones.len(), t.elapsed()
        );
        if dt == 3600.0 {
            for p in r.points.iter().step_by(12) {
                println!("  t+{:>5.0}h  {:6.2}N {:7.2}W  cap {:3.0}° twa {:+4.0}° tws {:4.1} v={:4.1}", (p.t) / 3600.0, p.lat, -p.lon, p.heading, p.twa, p.tws, p.speed);
            }
        }
    }
}
