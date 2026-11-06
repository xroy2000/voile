use regatta_core::game::Course;
use regatta_core::land::Land;
use regatta_core::polar::Polar;
use regatta_core::router::{route, RouteConfig};
use regatta_core::wind::{GridWind, WindField};
use std::time::Instant;
fn main() {
    let json = std::fs::read_to_string("web/assets/land50.geojson").unwrap();
    let land = Land::from_geojson(&json, -10.0, 70.0, -100.0, 30.0, 0.05).unwrap();
    let wind = GridWind::from_bytes(&std::fs::read("web/wind.bin").unwrap()).unwrap();
    let (t_min, t_max) = wind.time_range().unwrap();
    let c = Course::route_du_rhum();
    let start = land.nearest_sea(c.start, 30.0).unwrap();
    let finish = land.nearest_sea(c.finish, 30.0).unwrap();
    let polar = Polar::imoca_generic();
    let t0 = t_min + 6.0 * 3600.0;
    println!("prévision : {:.0} h couvertes ; départ H+6", (t_max - t_min) / 3600.0);
    for q in 0..=2u8 {
        let cfg = RouteConfig::new(start, finish, t0).quality(q);
        let t = Instant::now();
        let r = route(&cfg, &wind, &polar, Some(&land));
        let end_h = (r.eta_unix - t_min) / 3600.0;
        println!("qualité {q}: atteint={} durée={:.2} j (arrivée à H+{:.0}{}) dist={:.0} nm vir={} emp={} calcul={:?}",
            r.reached, r.duration_s / 86400.0, end_h, if end_h > (t_max - t_min) / 3600.0 { " ⚠ au-delà de la prévision" } else { "" }, r.distance_nm, r.tacks, r.gybes, t.elapsed());
        if q == 1 {
            for p in r.points.iter().step_by(12) {
                let w = wind.wind_at(regatta_core::LatLon::new(p.lat, p.lon), p.t);
                println!("   H+{:>3.0}  {:5.1}N {:5.1}W  cap {:3.0}° TWA {:+4.0}° vent {:4.1} nds  v={:4.1}  {}", (p.t - t_min) / 3600.0, p.lat, -p.lon, p.heading, p.twa, w.tws(), p.speed, p.sail);
            }
        }
    }
}
