use serde::{Deserialize, Serialize};

/// Rayon terrestre moyen en milles nautiques.
pub const R_NM: f64 = 3440.065;
/// Milles nautiques par degré de grand cercle, cohérent avec `R_NM`.
pub const DEG_NM: f64 = R_NM * std::f64::consts::PI / 180.0;

#[derive(Clone, Copy, Debug, PartialEq, Default, Serialize, Deserialize)]
pub struct LatLon {
    pub lat: f64,
    pub lon: f64,
}

impl LatLon {
    pub fn new(lat: f64, lon: f64) -> Self {
        Self { lat, lon }
    }
}

/// Ramène un angle dans [0, 360).
pub fn norm360(a: f64) -> f64 {
    a.rem_euclid(360.0)
}

/// Ramène un angle dans [-180, 180).
pub fn norm180(a: f64) -> f64 {
    norm360(a + 180.0) - 180.0
}

/// Distance orthodromique en milles nautiques (haversine).
pub fn dist_nm(a: LatLon, b: LatLon) -> f64 {
    let (la1, la2) = (a.lat.to_radians(), b.lat.to_radians());
    let dlat = la2 - la1;
    let dlon = (b.lon - a.lon).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * R_NM * h.sqrt().min(1.0).asin()
}

/// Cap initial orthodromique de a vers b, en degrés [0, 360).
pub fn bearing(a: LatLon, b: LatLon) -> f64 {
    let (la1, la2) = (a.lat.to_radians(), b.lat.to_radians());
    let dlon = (b.lon - a.lon).to_radians();
    let y = dlon.sin() * la2.cos();
    let x = la1.cos() * la2.sin() - la1.sin() * la2.cos() * dlon.cos();
    norm360(y.atan2(x).to_degrees())
}

/// Point atteint depuis `a` en suivant la grande-cercle de cap `brg` sur `d` milles.
pub fn destination(a: LatLon, brg: f64, d_nm: f64) -> LatLon {
    let ang = d_nm / R_NM;
    let (la1, lo1, th) = (a.lat.to_radians(), a.lon.to_radians(), brg.to_radians());
    let la2 = (la1.sin() * ang.cos() + la1.cos() * ang.sin() * th.cos()).asin();
    let lo2 = lo1 + (th.sin() * ang.sin() * la1.cos()).atan2(ang.cos() - la1.sin() * la2.sin());
    LatLon::new(la2.to_degrees(), norm180(lo2.to_degrees()))
}

/// Version plane de `destination`, exacte à ~1e-4 près pour d < 100 nm (sauf aux pôles). Beaucoup plus rapide.
pub fn destination_flat(a: LatLon, brg: f64, d_nm: f64) -> LatLon {
    let th = brg.to_radians();
    let dlat = d_nm * th.cos() / DEG_NM;
    let lat = a.lat + dlat;
    let dlon = d_nm * th.sin() / (DEG_NM * ((a.lat + lat) * 0.5).to_radians().cos().max(1e-6));
    LatLon::new(lat, a.lon + dlon)
}

/// Écart transversal (nm, signé) de `p` par rapport à la route a→b.
pub fn cross_track_nm(a: LatLon, b: LatLon, p: LatLon) -> f64 {
    let d13 = dist_nm(a, p) / R_NM;
    let th13 = bearing(a, p).to_radians();
    let th12 = bearing(a, b).to_radians();
    (d13.sin() * (th13 - th12).sin()).asin() * R_NM
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saint_malo_pointe_a_pitre() {
        let sm = LatLon::new(48.65, -2.03);
        let pap = LatLon::new(16.24, -61.53);
        let d = dist_nm(sm, pap);
        // la route du Rhum fait ~3 500 nm en orthodromie
        assert!((3400.0..3600.0).contains(&d), "d = {d}");
    }

    #[test]
    fn destination_roundtrip() {
        let a = LatLon::new(40.0, -30.0);
        let b = destination(a, 123.0, 500.0);
        assert!((dist_nm(a, b) - 500.0).abs() < 1e-6);
        assert!((bearing(a, b) - 123.0).abs() < 1e-6);
    }

    #[test]
    fn flat_destination_close_to_spherical() {
        for (lat, brg, d) in [(0.0, 90.0, 30.0), (48.0, 220.0, 30.0), (16.0, 10.0, 25.0), (60.0, 300.0, 40.0)] {
            let a = LatLon::new(lat, -30.0);
            let (s, f) = (destination(a, brg, d), destination_flat(a, brg, d));
            // à haute latitude, cap constant (loxodromie) et grand cercle divergent légèrement : < 0,4 nm sur 40 nm
            assert!(dist_nm(s, f) < 0.4, "écart {} nm à lat {lat}", dist_nm(s, f));
            assert!((dist_nm(a, f) - d).abs() < 0.05 * d.max(1.0) / 10.0, "longueur {} vs {d}", dist_nm(a, f));
        }
    }

    #[test]
    fn angles() {
        assert_eq!(norm360(-10.0), 350.0);
        assert_eq!(norm180(190.0), -170.0);
        assert_eq!(norm180(-180.0), -180.0);
    }

    #[test]
    fn equator_degree_is_60nm() {
        let d = dist_nm(LatLon::new(0.0, 0.0), LatLon::new(0.0, 1.0));
        assert!((d - 60.0).abs() < 0.2, "d = {d}");
    }
}
