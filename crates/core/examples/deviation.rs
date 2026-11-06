use regatta_core::game::{Course, Game};
use regatta_core::geo::dist_nm;
use regatta_core::land::Land;
use regatta_core::polar::Polar;
use regatta_core::wind::GridWind;
use regatta_core::LatLon;
fn main() {
    let json = std::fs::read_to_string("web/assets/land50.geojson").unwrap();
    let bytes = std::fs::read("web/wind.bin").unwrap();
    let t0 = GridWind::from_bytes(&bytes).unwrap().epoch_unix + 6.0 * 3600.0;
    let land = Land::from_geojson(&json, -10.0, 70.0, -100.0, 30.0, 0.05).unwrap();
    let mut g = Game::new(Course::route_du_rhum(), Box::new(GridWind::from_bytes(&bytes).unwrap()), Polar::imoca_generic(), Some(land), t0);
    g.ai.clear();
    let q: u8 = std::env::args().nth(1).map(|x| x.parse().unwrap()).unwrap_or(1);
    g.compute_route(q);
    g.follow_route();
    let pts: Vec<(f64, LatLon)> = g.route.as_ref().unwrap().points.iter().map(|p| (p.t, LatLon::new(p.lat, p.lon))).collect();
    // écart = distance au segment de route actif à l'instant t (position planifiée par interpolation)
    let planned = |t: f64| -> LatLon {
        let i = pts.partition_point(|p| p.0 <= t).clamp(1, pts.len() - 1);
        let (a, b) = (pts[i - 1], pts[i]);
        let f = ((t - a.0) / (b.0 - a.0)).clamp(0.0, 1.0);
        LatLon::new(a.1.lat + (b.1.lat - a.1.lat) * f, a.1.lon + (b.1.lon - a.1.lon) * f)
    };
    let mut maxdev = 0.0f64;
    let pred = g.route.as_ref().unwrap().duration_s;
    println!("prédit {:.2} j", pred / 86400.0);
    for i in 0..(12 * 24 * 60) {
        g.tick(60.0);
        let dev = pts.iter().map(|p| dist_nm(g.player.pos, p.1)).fold(f64::MAX, f64::min); let _ = planned(g.now);
        maxdev = maxdev.max(dev);
        if i % (8 * 60) == 0 {
            let fin = g.course.finish; println!("t={:5.2}j  dtf sim {:5.0} nm  dtf plan {:5.0} nm  retard {:+5.0} nm  écart-tracé {:4.1}  twa {:+4.0} tws {:4.1} v {:4.1}", (g.now - t0) / 86400.0, dist_nm(g.player.pos, fin), dist_nm(planned(g.now), fin), dist_nm(g.player.pos, fin) - dist_nm(planned(g.now), fin), dev, g.player.twa, g.player.tws, g.player.speed);
        }
        if g.finished_at.is_some() { println!("ARRIVÉ à {:.2} j", (g.now - t0) / 86400.0); break; }
    }
    println!("écart maxi : {:.1} nm", maxdev);
}
