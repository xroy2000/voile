//! Compare la durée prédite par le routeur à la durée obtenue en suivant sa route dans le simulateur
//! (pas de 10 s, vent local à chaque instant). L'écart mesure l'erreur de discrétisation du routeur.
use regatta_core::game::{Course, Game};
use regatta_core::land::Land;
use regatta_core::polar::Polar;
use regatta_core::wind::GridWind;

fn main() {
    let json = std::fs::read_to_string("web/assets/land50.geojson").unwrap();
    let bytes = std::fs::read("web/wind.bin").unwrap();
    let wind0 = GridWind::from_bytes(&bytes).unwrap();
    let t_min = wind0.epoch_unix;
    let t0 = t_min + 6.0 * 3600.0;
    println!("{:>8} | {:>11} {:>11} {:>8}", "qualité", "prédit (j)", "simulé (j)", "écart");
    for q in 0..=2u8 {
        let land = Land::from_geojson(&json, -10.0, 70.0, -100.0, 30.0, 0.05).unwrap();
        let mut g = Game::new(Course::route_du_rhum(), Box::new(GridWind::from_bytes(&bytes).unwrap()), Polar::imoca_generic(), Some(land), t0);
        g.ai.clear();
        let predicted = g.compute_route(q).duration_s;
        g.follow_route();
        let mut n = 0;
        while g.finished_at.is_none() && n < 20 * 24 * 60 {
            g.tick(60.0);
            n += 1;
        }
        match g.finished_at {
            Some(f) => {
                let sim = f - t0;
                println!("{:>8} | {:>11.2} {:>11.2} {:>+7.1}%", q, predicted / 86400.0, sim / 86400.0, (sim - predicted) / predicted * 100.0);
            }
            None => println!("{:>8} | {:>11.2} {:>11} (le bateau n'est pas arrivé : dtf={:.0} nm)", q, predicted / 86400.0, "—", g.player.dtf_nm(g.course.finish)),
        }
    }
}
