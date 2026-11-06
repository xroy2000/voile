use regatta_core::game::Course;
use regatta_core::land::Land;
use regatta_core::polar::Polar;
use regatta_core::router::{route, RouteConfig};
use regatta_core::wind::SyntheticWind;
use std::time::Instant;
fn main() {
    let json = std::fs::read_to_string("web/assets/land50.geojson").unwrap();
    let land = Land::from_geojson(&json, -10.0, 70.0, -100.0, 30.0, 0.05).unwrap();
    let c = Course::route_du_rhum();
    let (polar, wind) = (Polar::imoca_generic(), SyntheticWind::atlantic(0.0));
    println!("{:>6} {:>5} {:>7} | {:>8} {:>7} {:>6} {:>6} {:>8}", "dt(s)", "pas°", "secteur", "durée(j)", "dist", "vir.", "emp.", "calcul");
    for (dt, step, sec) in [(3600.0,3.0,180),(3600.0,3.0,360),(3600.0,2.0,720),(1800.0,3.0,180),(1800.0,3.0,360),(1800.0,2.0,720),(1800.0,2.0,1440),(7200.0,3.0,360),(10800.0,3.0,360)] {
        let mut cfg = RouteConfig::new(c.start, c.finish, 0.0);
        cfg.dt_s = dt; cfg.heading_step = step; cfg.sectors = sec;
        let t = Instant::now();
        let r = route(&cfg, &wind, &polar, Some(&land));
        println!("{:>6} {:>5} {:>7} | {:>8.2} {:>7.0} {:>6} {:>6} {:>8.2?}  {}", dt, step, sec, r.duration_s/86400.0, r.distance_nm, r.tacks, r.gybes, t.elapsed(), if r.reached {""} else {"NON ATTEINT"});
    }
}
