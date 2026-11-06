use regatta_core::land::Land;
use regatta_core::LatLon;
fn main() {
    let json = std::fs::read_to_string("web/assets/land50.geojson").unwrap();
    let land = Land::from_geojson(&json, -10.0, 70.0, -100.0, 30.0, 0.05).unwrap();
    println!("finish (16.30,-61.45) terre ? {}", land.is_land(LatLon::new(16.30, -61.45)));
    println!("départ (48.80,-2.35) terre ? {}", land.is_land(LatLon::new(48.80, -2.35)));
    // carte ASCII 0.05° : F = point d'arrivée actuel
    for j in (0..=24).rev() {
        let lat = 15.8 + j as f64 * 0.05;
        let mut row = String::new();
        for i in 0..=30 {
            let lon = -62.1 + i as f64 * 0.05;
            let f = (lat - 16.30).abs() < 0.025 && (lon + 61.45).abs() < 0.025;
            row.push(if f { 'F' } else if land.is_land(LatLon::new(lat, lon)) { '#' } else { '.' });
        }
        println!("{:5.2} {}", lat, row);
    }
    println!("      lon -62.10 … -60.60");
}
