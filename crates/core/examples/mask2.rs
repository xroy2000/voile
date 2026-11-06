use regatta_core::land::Land;
use regatta_core::LatLon;
fn main() {
    let json = std::fs::read_to_string("web/assets/land50.geojson").unwrap();
    let land = Land::from_geojson(&json, -10.0, 70.0, -100.0, 30.0, 0.05).unwrap();
    let m = land.dilated(1);
    for j in (0..=16).rev() {
        let lat = 16.0 + j as f64 * 0.05;
        let mut row = String::new();
        for i in 0..=24 {
            let lon = -61.6 + i as f64 * 0.05;
            let p = LatLon::new(lat, lon);
            row.push(if land.is_land(p) { '#' } else if m.is_land(p) { '+' } else { '.' });
        }
        println!("{:5.2} {}", lat, row);
    }
    println!("      lon -61.60 … -60.40   (# terre, + marge)");
}
