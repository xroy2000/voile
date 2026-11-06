use regatta_core::game::{Course, Game};
use regatta_core::land::Land;
use regatta_core::polar::Polar;
use regatta_core::wind::GridWind;
fn main() {
    let json = std::fs::read_to_string("web/assets/land50.geojson").unwrap();
    let bytes = std::fs::read("web/wind.bin").unwrap();
    let t0 = GridWind::from_bytes(&bytes).unwrap().epoch_unix + 6.0 * 3600.0;
    let land = Land::from_geojson(&json, -10.0, 70.0, -100.0, 30.0, 0.05).unwrap();
    let mut g = Game::new(Course::route_du_rhum(), Box::new(GridWind::from_bytes(&bytes).unwrap()), Polar::imoca_generic(), Some(land), t0);
    g.ai.clear();
    g.compute_route(1);
    g.follow_route();
    let mut last = (0.0, 0.0);
    for i in 0..(12 * 24 * 60) {
        g.tick(60.0);
        if g.grounded && i % 30 == 0 { last = (g.player.pos.lat, g.player.pos.lon); }
        if g.finished_at.is_some() { break; }
    }
    let r = g.route.as_ref().unwrap();
    println!("finish {:?} ; échoué={} pos={:.3},{:.3} cap={:.0} t={:.2}j depuis départ ; dernière position échouée {:?}", g.course.finish, g.grounded, g.player.pos.lat, g.player.pos.lon, g.player.heading, (g.now-t0)/86400.0, last);
    println!("derniers points de la route :");
    for p in r.points.iter().rev().take(4).rev() { println!("   {:.3},{:.3} t={:.2}j cap={:.0}", p.lat, p.lon, (p.t-t0)/86400.0, p.heading); }
}
