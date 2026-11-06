//! Champs de vent : synthétique (dév/tests) et grille temporelle (GFS décodé).

use crate::geo::{norm360, LatLon};

/// Vent sous forme vectorielle (nds). `u` vers l'est, `v` vers le nord (direction **vers** laquelle il souffle).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Wind {
    pub u: f64,
    pub v: f64,
}

impl Wind {
    pub fn from_speed_dir(tws: f64, twd_from: f64) -> Wind {
        let r = twd_from.to_radians();
        Wind { u: -tws * r.sin(), v: -tws * r.cos() }
    }
    pub fn tws(&self) -> f64 {
        self.u.hypot(self.v)
    }
    /// Direction d'**où** vient le vent, en degrés [0, 360).
    pub fn twd(&self) -> f64 {
        norm360((-self.u).atan2(-self.v).to_degrees())
    }
}

/// `t` est un temps Unix en secondes.
pub trait WindField {
    fn wind_at(&self, p: LatLon, t: f64) -> Wind;
    /// Plage de temps couverte (Unix s), si bornée.
    fn time_range(&self) -> Option<(f64, f64)> {
        None
    }
}

// ---------------------------------------------------------------- synthétique

#[derive(Clone, Debug)]
pub struct System {
    pub lat: f64,
    pub lon: f64,
    /// dérive en degrés par heure
    pub dlat_h: f64,
    pub dlon_h: f64,
    pub radius_nm: f64,
    pub strength_kn: f64,
    /// true = dépression (sens anti-horaire, hémisphère nord)
    pub cyclonic: bool,
}

#[derive(Clone, Debug)]
pub struct SyntheticWind {
    pub t0: f64,
    pub systems: Vec<System>,
    pub base: Wind,
}

impl SyntheticWind {
    /// Situation type Atlantique Nord : anticyclone des Açores, dépression sur le nord.
    pub fn atlantic(t0: f64) -> Self {
        Self {
            t0,
            base: Wind { u: 0.0, v: 0.0 },
            systems: vec![
                System { lat: 34.0, lon: -32.0, dlat_h: 0.0, dlon_h: 0.004, radius_nm: 800.0, strength_kn: 20.0, cyclonic: false },
                System { lat: 52.0, lon: -28.0, dlat_h: 0.01, dlon_h: 0.08, radius_nm: 450.0, strength_kn: 24.0, cyclonic: true },
                System { lat: 25.0, lon: -50.0, dlat_h: 0.02, dlon_h: -0.03, radius_nm: 300.0, strength_kn: 8.0, cyclonic: true },
            ],
        }
    }
}

impl WindField for SyntheticWind {
    fn wind_at(&self, p: LatLon, t: f64) -> Wind {
        let h = (t - self.t0) / 3600.0;
        let (mut u, mut v) = (self.base.u, self.base.v);
        for s in &self.systems {
            let (clat, clon) = (s.lat + s.dlat_h * h, s.lon + s.dlon_h * h);
            let dy = (p.lat - clat) * 60.0;
            let dx = (p.lon - clon) * 60.0 * ((p.lat + clat) / 2.0).to_radians().cos();
            let r = dx.hypot(dy).max(1.0);
            let x = r / s.radius_nm;
            let speed = s.strength_kn * x * (1.0 - x).exp();
            let (tx, ty) = if s.cyclonic { (-dy / r, dx / r) } else { (dy / r, -dx / r) };
            u += speed * tx;
            v += speed * ty;
        }
        // Petites ondulations lentes pour que le champ ne soit pas trop lisse.
        u += 1.5 * (p.lat * 0.31 + h / 9.0).sin();
        v += 1.5 * (p.lon * 0.27 - h / 11.0).cos();
        Wind { u, v }
    }
}

// ---------------------------------------------------------------- grille

/// Grille régulière (lat croissante, lon croissante) à plusieurs échéances, en nds.
#[derive(Clone, Debug)]
pub struct GridWind {
    pub epoch_unix: f64,
    pub lat0: f64,
    pub lon0: f64,
    pub dlat: f64,
    pub dlon: f64,
    pub nlat: usize,
    pub nlon: usize,
    /// heures depuis epoch_unix, croissantes
    pub hours: Vec<f32>,
    /// u puis v ; disposition [t][lat][lon], en 1/100 nd
    pub u: Vec<i16>,
    pub v: Vec<i16>,
}

const MAGIC: &[u8; 4] = b"VWN1";

impl GridWind {
    fn cell(&self, it: usize, ilat: usize, ilon: usize) -> (f64, f64) {
        let i = (it * self.nlat + ilat) * self.nlon + ilon;
        (self.u[i] as f64 * 0.01, self.v[i] as f64 * 0.01)
    }

    fn spatial(&self, it: usize, fy: f64, fx: f64) -> (f64, f64) {
        let y0 = (fy.floor() as isize).clamp(0, self.nlat as isize - 1) as usize;
        let x0 = (fx.floor() as isize).clamp(0, self.nlon as isize - 1) as usize;
        let y1 = (y0 + 1).min(self.nlat - 1);
        let x1 = (x0 + 1).min(self.nlon - 1);
        let ty = (fy - y0 as f64).clamp(0.0, 1.0);
        let tx = (fx - x0 as f64).clamp(0.0, 1.0);
        let (a, b, c, d) = (self.cell(it, y0, x0), self.cell(it, y0, x1), self.cell(it, y1, x0), self.cell(it, y1, x1));
        let lerp = |p: f64, q: f64, t: f64| p * (1.0 - t) + q * t;
        (
            lerp(lerp(a.0, b.0, tx), lerp(c.0, d.0, tx), ty),
            lerp(lerp(a.1, b.1, tx), lerp(c.1, d.1, tx), ty),
        )
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut o = Vec::new();
        o.extend_from_slice(MAGIC);
        o.extend_from_slice(&self.epoch_unix.to_le_bytes());
        for f in [self.lat0, self.lon0, self.dlat, self.dlon] {
            o.extend_from_slice(&(f as f32).to_le_bytes());
        }
        for n in [self.nlat, self.nlon, self.hours.len()] {
            o.extend_from_slice(&(n as u32).to_le_bytes());
        }
        for h in &self.hours {
            o.extend_from_slice(&h.to_le_bytes());
        }
        for x in self.u.iter().chain(self.v.iter()) {
            o.extend_from_slice(&x.to_le_bytes());
        }
        o
    }

    pub fn from_bytes(b: &[u8]) -> Result<GridWind, String> {
        if b.len() < 44 || &b[0..4] != MAGIC {
            return Err("fichier vent invalide (en-tête VWN1 absent)".into());
        }
        let f32at = |o: usize| f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        let u32at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) as usize;
        let epoch_unix = f64::from_le_bytes(b[4..12].try_into().unwrap());
        let (lat0, lon0, dlat, dlon) = (f32at(12) as f64, f32at(16) as f64, f32at(20) as f64, f32at(24) as f64);
        let (nlat, nlon, nt) = (u32at(28), u32at(32), u32at(36));
        let n = nlat * nlon * nt;
        let need = 40 + nt * 4 + n * 4;
        if nlat < 2 || nlon < 2 || nt < 1 || b.len() != need {
            return Err(format!("fichier vent tronqué ou incohérent ({} octets, {} attendus)", b.len(), need));
        }
        let hours = (0..nt).map(|i| f32at(40 + 4 * i)).collect::<Vec<_>>();
        let base = 40 + nt * 4;
        let rd = |k: usize| i16::from_le_bytes([b[base + 2 * k], b[base + 2 * k + 1]]);
        let u = (0..n).map(rd).collect();
        let v = (n..2 * n).map(rd).collect();
        Ok(GridWind { epoch_unix, lat0, lon0, dlat, dlon, nlat, nlon, hours, u, v })
    }

    pub fn lat_range(&self) -> (f64, f64) {
        (self.lat0, self.lat0 + self.dlat * (self.nlat - 1) as f64)
    }
    pub fn lon_range(&self) -> (f64, f64) {
        (self.lon0, self.lon0 + self.dlon * (self.nlon - 1) as f64)
    }
}

impl WindField for GridWind {
    fn wind_at(&self, p: LatLon, t: f64) -> Wind {
        let fy = (p.lat - self.lat0) / self.dlat;
        let fx = (p.lon - self.lon0) / self.dlon;
        let th = ((t - self.epoch_unix) / 3600.0) as f32;
        let n = self.hours.len();
        let (u, v) = if th <= self.hours[0] || n == 1 {
            self.spatial(0, fy, fx)
        } else if th >= self.hours[n - 1] {
            self.spatial(n - 1, fy, fx)
        } else {
            let i1 = self.hours.partition_point(|&h| h <= th);
            let i0 = i1 - 1;
            let f = ((th - self.hours[i0]) / (self.hours[i1] - self.hours[i0])) as f64;
            let (a, b) = (self.spatial(i0, fy, fx), self.spatial(i1, fy, fx));
            (a.0 * (1.0 - f) + b.0 * f, a.1 * (1.0 - f) + b.1 * f)
        };
        Wind { u, v }
    }

    fn time_range(&self) -> Option<(f64, f64)> {
        Some((
            self.epoch_unix + self.hours[0] as f64 * 3600.0,
            self.epoch_unix + *self.hours.last().unwrap() as f64 * 3600.0,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_dir_roundtrip() {
        for d in [0.0, 45.0, 90.0, 180.0, 270.0, 359.0] {
            let w = Wind::from_speed_dir(17.0, d);
            assert!((w.tws() - 17.0).abs() < 1e-9);
            assert!((w.twd() - d).abs() < 1e-9, "{d} -> {}", w.twd());
        }
        // vent de nord : souffle vers le sud
        let n = Wind::from_speed_dir(10.0, 0.0);
        assert!(n.v < -9.99 && n.u.abs() < 1e-9);
    }

    #[test]
    fn anticyclone_turns_clockwise() {
        let w = SyntheticWind { t0: 0.0, base: Wind::default(), systems: vec![System {
            lat: 30.0, lon: -30.0, dlat_h: 0.0, dlon_h: 0.0, radius_nm: 600.0, strength_kn: 20.0, cyclonic: false }] };
        // au sud du centre d'un anticyclone (hém. nord) : alizé d'est (vent d'est ≈ 90°)
        let south = w.wind_at(LatLon::new(22.0, -30.0), 0.0);
        let d = south.twd();
        assert!((60.0..120.0).contains(&d), "au sud : {d}");
        // au nord : vent d'ouest
        let north = w.wind_at(LatLon::new(38.0, -30.0), 0.0);
        assert!((240.0..300.0).contains(&north.twd()), "au nord : {}", north.twd());
    }

    #[test]
    fn grid_interpolation_and_serialisation() {
        // 2x2 spatial, 2 échéances (0 h et 3 h) ; u varie avec la longitude, v avec le temps
        let mut u = vec![];
        let mut v = vec![];
        for t in 0..2 {
            for _lat in 0..2 {
                for lon in 0..2 {
                    u.push((lon * 1000) as i16);
                    v.push((t * 500) as i16);
                }
            }
        }
        let g = GridWind { epoch_unix: 1000.0, lat0: 10.0, lon0: -20.0, dlat: 1.0, dlon: 1.0,
            nlat: 2, nlon: 2, hours: vec![0.0, 3.0], u, v };
        let w = g.wind_at(LatLon::new(10.5, -19.5), 1000.0 + 1.5 * 3600.0);
        assert!((w.u - 5.0).abs() < 1e-9, "u={}", w.u);
        assert!((w.v - 2.5).abs() < 1e-9, "v={}", w.v);
        let g2 = GridWind::from_bytes(&g.to_bytes()).unwrap();
        let w2 = g2.wind_at(LatLon::new(10.5, -19.5), 1000.0 + 1.5 * 3600.0);
        assert!((w.u - w2.u).abs() < 1e-6 && (w.v - w2.v).abs() < 1e-6);
        assert!(GridWind::from_bytes(&g.to_bytes()[..50]).is_err());
    }
}

/// Vent uniforme et constant (tests, calculs de référence).
#[derive(Clone, Copy, Debug)]
pub struct UniformWind(pub Wind);

impl WindField for UniformWind {
    fn wind_at(&self, _p: LatLon, _t: f64) -> Wind {
        self.0
    }
}
