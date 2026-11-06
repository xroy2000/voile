use regatta_core::game::{Course, Game};
use regatta_core::polar::Polar;
use regatta_core::wind::{UniformWind, Wind};
use regatta_core::LatLon;
fn main() {
    let course = Course { name: "t".into(), start: LatLon::new(0.0, -40.0), finish: LatLon::new(0.0, -35.0) };
    let mut g = Game::new(course, Box::new(UniformWind(Wind::from_speed_dir(14.0, 60.0))), Polar::imoca_generic(), None, 0.0);
    g.compute_route(1);
    let r = g.route.clone().unwrap();
    println!("route prédite {:.2} h, {} points", r.duration_s / 3600.0, r.points.len());
    for p in &r.points { println!("  t={:5.1}h  {:.3},{:.3} cap {:3.0} twa {:+4.0}", p.t / 3600.0, p.lat, p.lon, p.heading, p.twa); }
    g.follow_route();
    for i in 0..(30 * 60) {
        g.tick(60.0);
        if i % 20 == 0 { println!("sim t={:5.2}h pos {:.3},{:.3} cap {:3.0} twa {:+4.0} v {:4.1} cur={}", g.now / 3600.0, g.player.pos.lat, g.player.pos.lon, g.player.heading, g.player.twa, g.player.speed, g.player.route_cursor); }
        if g.finished_at.is_some() { println!("ARRIVÉ à {:.2} h", g.now / 3600.0); break; }
    }
}
