//! Masque de terre rasterisé à partir de polygones GeoJSON (Natural Earth).

use crate::geo::LatLon;
use serde_json::Value;

#[derive(Clone)]
pub struct Land {
    lat_min: f64,
    lat_max: f64,
    lon_min: f64,
    lon_max: f64,
    res: f64,
    nx: usize,
    ny: usize,
    /// 1 bit par cellule
    bits: Vec<u64>,
    /// Pré-filtre : un octet par bloc de BLOCK×BLOCK cellules, à 1 si de la terre se trouve dans le bloc
    /// ou l'un de ses 8 voisins.
    coarse: Vec<u8>,
    cnx: usize,
    cny: usize,
    pub polygons: usize,
}

const BLOCK: usize = 8;

type Ring = Vec<(f64, f64)>; // (lon, lat)

impl Land {
    /// Rasterise tous les polygones d'un GeoJSON (Polygon / MultiPolygon, FeatureCollection ou géométrie)
    /// sur la zone donnée, à la résolution `res` (degrés).
    pub fn from_geojson(json: &str, lat_min: f64, lat_max: f64, lon_min: f64, lon_max: f64, res: f64) -> Result<Land, String> {
        let root: Value = serde_json::from_str(json).map_err(|e| format!("GeoJSON invalide : {e}"))?;
        let mut polys: Vec<Vec<Ring>> = Vec::new();
        collect(&root, &mut polys);
        if polys.is_empty() {
            return Err("aucun polygone dans le GeoJSON".into());
        }
        let nx = ((lon_max - lon_min) / res).ceil() as usize;
        let ny = ((lat_max - lat_min) / res).ceil() as usize;
        let (cnx, cny) = (nx / BLOCK + 1, ny / BLOCK + 1);
        let mut land = Land { lat_min, lat_max, lon_min, lon_max, res, nx, ny, bits: vec![0; (nx * ny + 63) / 64], coarse: vec![0; cnx * cny], cnx, cny, polygons: polys.len() };
        for rings in &polys {
            land.fill(rings);
        }
        land.build_coarse();
        Ok(land)
    }

    /// Remplissage par balayage, règle pair-impair sur tous les anneaux (trous inclus).
    /// Une cellule est « terre » si son centre est à l'intérieur du polygone.
    fn fill(&mut self, rings: &[Ring]) {
        let mut ys0 = f64::MAX;
        let mut ys1 = f64::MIN;
        for r in rings {
            for &(_, y) in r {
                ys0 = ys0.min(y);
                ys1 = ys1.max(y);
            }
        }
        if ys1 < self.lat_min || ys0 > self.lat_max {
            return;
        }
        let row0 = (((ys0.max(self.lat_min) - self.lat_min) / self.res).floor() as usize).min(self.ny.saturating_sub(1));
        let row1 = (((ys1.min(self.lat_max) - self.lat_min) / self.res).ceil() as usize).min(self.ny);
        let mut xs: Vec<f64> = Vec::new();
        for iy in row0..row1 {
            let y = self.lat_min + (iy as f64 + 0.5) * self.res;
            xs.clear();
            for r in rings {
                for w in r.windows(2) {
                    let ((x1, y1), (x2, y2)) = (w[0], w[1]);
                    if (y1 <= y) != (y2 <= y) {
                        xs.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
                    }
                }
            }
            xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
            for pair in xs.chunks_exact(2) {
                let a = ((pair[0] - self.lon_min) / self.res - 0.5).ceil().max(0.0) as usize;
                let b_f = ((pair[1] - self.lon_min) / self.res - 0.5).floor();
                if b_f < 0.0 {
                    continue;
                }
                let b = (b_f as usize).min(self.nx.saturating_sub(1));
                // OR (et non XOR) : deux polygones qui se recouvrent ne doivent pas s'annuler.
                for ix in a..=b {
                    if ix < self.nx {
                        let i = iy * self.nx + ix;
                        self.bits[i >> 6] |= 1u64 << (i & 63);
                    }
                }
            }
        }
    }

    fn get(&self, ix: usize, iy: usize) -> bool {
        let i = iy * self.nx + ix;
        (self.bits[i >> 6] >> (i & 63)) & 1 == 1
    }

    /// Copie dont la terre est élargie de `cells` mailles dans toutes les directions : marge de sécurité
    /// pour le routage (le bateau réel s'écarte un peu de la route calculée).
    pub fn dilated(&self, cells: usize) -> Land {
        let mut out = self.clone();
        out.bits.iter_mut().for_each(|w| *w = 0);
        let n = cells as isize;
        for iy in 0..self.ny {
            for ix in 0..self.nx {
                if !self.get(ix, iy) {
                    continue;
                }
                for dy in -n..=n {
                    for dx in -n..=n {
                        let (x, y) = (ix as isize + dx, iy as isize + dy);
                        if x >= 0 && y >= 0 && (x as usize) < self.nx && (y as usize) < self.ny {
                            let i = y as usize * self.nx + x as usize;
                            out.bits[i >> 6] |= 1u64 << (i & 63);
                        }
                    }
                }
            }
        }
        out.coarse.iter_mut().for_each(|c| *c = 0);
        out.build_coarse();
        out
    }

    fn build_coarse(&mut self) {
        let mut raw = vec![0u8; self.cnx * self.cny];
        for iy in 0..self.ny {
            for ix in 0..self.nx {
                let i = iy * self.nx + ix;
                if (self.bits[i >> 6] >> (i & 63)) & 1 == 1 {
                    raw[(iy / BLOCK) * self.cnx + ix / BLOCK] = 1;
                }
            }
        }
        for by in 0..self.cny {
            for bx in 0..self.cnx {
                if raw[by * self.cnx + bx] == 1 {
                    for dy in by.saturating_sub(1)..=(by + 1).min(self.cny - 1) {
                        for dx in bx.saturating_sub(1)..=(bx + 1).min(self.cnx - 1) {
                            self.coarse[dy * self.cnx + dx] = 1;
                        }
                    }
                }
            }
        }
    }

    /// Vrai s'il y a de la terre à moins d'un bloc du point (ou si le point est hors zone : faux).
    fn near_land(&self, p: LatLon) -> bool {
        if p.lat < self.lat_min || p.lat >= self.lat_max || p.lon < self.lon_min || p.lon >= self.lon_max {
            return false;
        }
        let bs = self.res * BLOCK as f64;
        let bx = (((p.lon - self.lon_min) / bs) as usize).min(self.cnx - 1);
        let by = (((p.lat - self.lat_min) / bs) as usize).min(self.cny - 1);
        self.coarse[by * self.cnx + bx] == 1
    }

    pub fn is_land(&self, p: LatLon) -> bool {
        if p.lat < self.lat_min || p.lat >= self.lat_max || p.lon < self.lon_min || p.lon >= self.lon_max {
            return false;
        }
        let ix = ((p.lon - self.lon_min) / self.res) as usize;
        let iy = ((p.lat - self.lat_min) / self.res) as usize;
        let i = iy * self.nx + ix.min(self.nx - 1);
        (self.bits[i >> 6] >> (i & 63)) & 1 == 1
    }

    /// Vrai si le segment a→b touche la terre (échantillonné tous les ~res/2).
    pub fn segment_hits(&self, a: LatLon, b: LatLon) -> bool {
        // Voie rapide : on échantillonne tous les ½ bloc sur le pré-filtre dilaté. Si aucun échantillon n'est
        // proche de la terre, le segment ne peut pas la toucher (chaque point du segment est à moins d'un
        // quart de bloc d'un échantillon, et un échantillon « loin » n'a pas de terre à moins d'un bloc).
        let bs = self.res * BLOCK as f64;
        let wide = (b.lat - a.lat).abs().max((b.lon - a.lon).abs());
        let m = ((wide / (bs * 0.5)).ceil() as usize).max(1);
        let mut near = false;
        for i in 0..=m {
            let f = i as f64 / m as f64;
            if self.near_land(LatLon::new(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f)) {
                near = true;
                break;
            }
        }
        if !near {
            return false;
        }
        self.segment_hits_fine(a, b)
    }

    /// Test exhaustif (référence) : échantillonnage tous les ½ cellule.
    pub fn segment_hits_fine(&self, a: LatLon, b: LatLon) -> bool {
        let span = (b.lat - a.lat).abs().max((b.lon - a.lon).abs());
        let n = ((span / (self.res * 0.5)).ceil() as usize).max(1);
        for i in 1..=n {
            let f = i as f64 / n as f64;
            if self.is_land(LatLon::new(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f)) {
                return true;
            }
        }
        false
    }

    /// Point de mer le plus proche de `p` (dans un rayon de `max_nm`), ou `p` lui-même s'il est déjà en mer.
    pub fn nearest_sea(&self, p: LatLon, max_nm: f64) -> Option<LatLon> {
        if !self.is_land(p) {
            return Some(p);
        }
        let max_r = (max_nm / 60.0 / self.res).ceil() as i32;
        for r in 1..=max_r {
            let mut best: Option<(f64, LatLon)> = None;
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs().max(dy.abs()) != r {
                        continue; // anneau de rayon r uniquement
                    }
                    let q = LatLon::new(p.lat + dy as f64 * self.res, p.lon + dx as f64 * self.res);
                    if !self.is_land(q) {
                        let d = crate::geo::dist_nm(p, q);
                        if best.map_or(true, |b| d < b.0) {
                            best = Some((d, q));
                        }
                    }
                }
            }
            if let Some((_, q)) = best {
                return Some(q);
            }
        }
        None
    }

    pub fn cells_land(&self) -> usize {
        self.bits.iter().map(|w| w.count_ones() as usize).sum()
    }
}

fn collect(v: &Value, out: &mut Vec<Vec<Ring>>) {
    match v.get("type").and_then(|t| t.as_str()) {
        Some("FeatureCollection") => {
            if let Some(fs) = v.get("features").and_then(|f| f.as_array()) {
                fs.iter().for_each(|f| collect(f, out));
            }
        }
        Some("Feature") => {
            if let Some(g) = v.get("geometry") {
                collect(g, out);
            }
        }
        Some("GeometryCollection") => {
            if let Some(gs) = v.get("geometries").and_then(|f| f.as_array()) {
                gs.iter().for_each(|g| collect(g, out));
            }
        }
        Some("Polygon") => {
            if let Some(c) = v.get("coordinates") {
                if let Some(p) = polygon(c) {
                    out.push(p);
                }
            }
        }
        Some("MultiPolygon") => {
            if let Some(ps) = v.get("coordinates").and_then(|c| c.as_array()) {
                for c in ps {
                    if let Some(p) = polygon(c) {
                        out.push(p);
                    }
                }
            }
        }
        _ => {}
    }
}

fn polygon(c: &Value) -> Option<Vec<Ring>> {
    let rings = c.as_array()?;
    let mut out = Vec::new();
    for r in rings {
        let pts: Ring = r
            .as_array()?
            .iter()
            .filter_map(|p| {
                let a = p.as_array()?;
                Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))
            })
            .collect();
        out.push(pts);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SQUARE_WITH_HOLE: &str = r#"{"type":"Polygon","coordinates":[
        [[0,0],[10,0],[10,10],[0,10],[0,0]],
        [[4,4],[6,4],[6,6],[4,6],[4,4]]]}"#;

    #[test]
    fn square_with_hole() {
        let l = Land::from_geojson(SQUARE_WITH_HOLE, -5.0, 15.0, -5.0, 15.0, 0.1).unwrap();
        assert!(l.is_land(LatLon::new(2.0, 2.0)));
        assert!(!l.is_land(LatLon::new(5.0, 5.0)), "trou = mer");
        assert!(!l.is_land(LatLon::new(12.0, 5.0)));
        assert!(!l.is_land(LatLon::new(-3.0, -3.0)));
        assert!(!l.is_land(LatLon::new(50.0, 50.0)), "hors zone = mer");
        // surface ≈ 100 − 4 = 96 deg² = 9600 cellules de 0.01 deg²
        let n = l.cells_land() as f64;
        assert!((n - 9600.0).abs() < 200.0, "n = {n}");
    }

    #[test]
    fn segment_crossing() {
        let l = Land::from_geojson(SQUARE_WITH_HOLE, -5.0, 15.0, -5.0, 15.0, 0.1).unwrap();
        assert!(l.segment_hits(LatLon::new(-2.0, 5.0), LatLon::new(12.0, 5.0)));
        assert!(!l.segment_hits(LatLon::new(-2.0, -2.0), LatLon::new(-2.0, 12.0)));
    }

    #[test]
    fn fast_path_agrees_with_fine_check() {
        let l = Land::from_geojson(SQUARE_WITH_HOLE, -5.0, 15.0, -5.0, 15.0, 0.1).unwrap();
        let mut n = 0;
        let mut seed = 12345u64;
        let mut rnd = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as f64) / (1u64 << 31) as f64
        };
        for _ in 0..20000 {
            let a = LatLon::new(-5.0 + 20.0 * rnd(), -5.0 + 20.0 * rnd());
            let b = LatLon::new(a.lat + (rnd() - 0.5) * 3.0, a.lon + (rnd() - 0.5) * 3.0);
            assert_eq!(l.segment_hits(a, b), l.segment_hits_fine(a, b), "{:?} -> {:?}", a, b);
            n += l.segment_hits_fine(a, b) as u32;
        }
        assert!(n > 500 && n < 19500, "le jeu de test doit mélanger touche / ne touche pas : {n}");
    }

    #[test]
    fn dilation_adds_a_safety_margin() {
        let l = Land::from_geojson(SQUARE_WITH_HOLE, -5.0, 15.0, -5.0, 15.0, 0.1).unwrap();
        let d = l.dilated(3); // 0,3° de marge
        assert!(!l.is_land(LatLon::new(10.2, 5.0)) && d.is_land(LatLon::new(10.2, 5.0)), "0,2° au-delà du bord : marge");
        assert!(!d.is_land(LatLon::new(10.5, 5.0)), "0,5° : hors marge");
        assert!(d.cells_land() > l.cells_land());
        assert!(d.segment_hits(LatLon::new(12.0, 5.0), LatLon::new(10.1, 5.0)), "le pré-filtre suit la dilatation");
        assert!(!l.segment_hits(LatLon::new(12.0, 5.0), LatLon::new(10.2, 5.0)));
    }

    #[test]
    fn nearest_sea_leaves_the_island() {
        let l = Land::from_geojson(SQUARE_WITH_HOLE, -5.0, 15.0, -5.0, 15.0, 0.1).unwrap();
        let sea = LatLon::new(12.0, 5.0);
        assert_eq!(l.nearest_sea(sea, 60.0), Some(sea), "déjà en mer : inchangé");
        let q = l.nearest_sea(LatLon::new(9.5, 5.0), 600.0).unwrap(); // à 0,5° (30 nm) du bord nord
        assert!(!l.is_land(q) && q.lat >= 10.0 && q.lat < 10.3, "{:?}", q);
        assert!(l.nearest_sea(LatLon::new(2.0, 2.0), 5.0).is_none(), "rayon trop court : rien");
    }

    #[test]
    fn rejects_garbage() {
        assert!(Land::from_geojson("pas du json", 0.0, 1.0, 0.0, 1.0, 0.1).is_err());
        assert!(Land::from_geojson(r#"{"type":"Point","coordinates":[0,0]}"#, 0.0, 1.0, 0.0, 1.0, 0.1).is_err());
    }
}
