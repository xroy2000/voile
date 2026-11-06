//! Polaires de vitesse : interpolation bilinéaire, import texte, polaire générique.

use crate::geo::norm180;

#[derive(Clone, Debug)]
pub struct Polar {
    /// Vitesses du vent vrai (nds), croissantes.
    pub tws: Vec<f64>,
    /// Angles au vent vrai (0..=180°), croissants.
    pub twa: Vec<f64>,
    /// kn[i_twa][i_tws]
    pub kn: Vec<Vec<f64>>,
}

fn bracket(axis: &[f64], x: f64) -> (usize, usize, f64) {
    let n = axis.len();
    if x <= axis[0] {
        return (0, 0, 0.0);
    }
    if x >= axis[n - 1] {
        return (n - 1, n - 1, 0.0);
    }
    let hi = axis.partition_point(|&v| v <= x);
    let lo = hi - 1;
    (lo, hi, (x - axis[lo]) / (axis[hi] - axis[lo]))
}

impl Polar {
    /// Vitesse du bateau (nds) pour un TWA (signe ignoré) et un TWS.
    pub fn speed(&self, twa: f64, tws: f64) -> f64 {
        let a = norm180(twa).abs();
        let (a0, a1, fa) = bracket(&self.twa, a);
        let (w0, w1, fw) = bracket(&self.tws, tws.max(0.0));
        let at = |ia: usize| self.kn[ia][w0] * (1.0 - fw) + self.kn[ia][w1] * fw;
        at(a0) * (1.0 - fa) + at(a1) * fa
    }

    /// Meilleur angle (positif) et VMG au près pour ce TWS.
    pub fn best_upwind(&self, tws: f64) -> (f64, f64) {
        self.best_vmg(tws, 0.0, 90.0, 1.0)
    }

    /// Meilleur angle (positif) et VMG (positive, vers sous le vent) au portant.
    pub fn best_downwind(&self, tws: f64) -> (f64, f64) {
        self.best_vmg(tws, 90.0, 180.0, -1.0)
    }

    fn best_vmg(&self, tws: f64, lo: f64, hi: f64, sign: f64) -> (f64, f64) {
        let (mut best_a, mut best_v) = (lo, f64::MIN);
        let mut a = lo;
        while a <= hi + 1e-9 {
            let v = self.speed(a, tws) * (a.to_radians().cos()) * sign;
            if v > best_v {
                best_v = v;
                best_a = a;
            }
            a += 0.5;
        }
        (best_a, best_v)
    }

    /// Lit un tableau texte (CSV/.pol) : première ligne = TWS, première colonne = TWA.
    /// Séparateurs acceptés : `;`, tabulation, `,` ou espaces. Les virgules décimales
    /// sont tolérées quand le séparateur est `;` ou une tabulation.
    pub fn from_text(s: &str) -> Result<Polar, String> {
        let mut rows: Vec<Vec<f64>> = Vec::new();
        let mut header: Option<Vec<f64>> = None;
        for (ln, raw) in s.lines().enumerate() {
            let line = raw.trim().trim_start_matches('\u{feff}');
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let cells: Vec<String> = if line.contains(';') {
                line.split(';').map(|c| c.trim().replace(',', ".")).collect()
            } else if line.contains('\t') {
                line.split('\t').map(|c| c.trim().replace(',', ".")).collect()
            } else if line.contains(',') {
                line.split(',').map(|c| c.trim().to_string()).collect()
            } else {
                line.split_whitespace().map(|c| c.to_string()).collect()
            };
            let cells: Vec<String> = cells.into_iter().filter(|c| !c.is_empty()).collect();
            if header.is_none() {
                let v: Result<Vec<f64>, _> = cells.iter().skip(1).map(|c| c.parse::<f64>()).collect();
                header = Some(v.map_err(|_| format!("ligne {} : en-tête TWS illisible", ln + 1))?);
                continue;
            }
            let v: Result<Vec<f64>, _> = cells.iter().map(|c| c.parse::<f64>()).collect();
            rows.push(v.map_err(|_| format!("ligne {} : valeur non numérique", ln + 1))?);
        }
        let tws = header.ok_or("fichier vide")?;
        if tws.len() < 2 || rows.len() < 2 {
            return Err("polaire trop petite (au moins 2 TWS et 2 TWA)".into());
        }
        let mut twa = Vec::new();
        let mut kn = Vec::new();
        for (i, r) in rows.iter().enumerate() {
            if r.len() != tws.len() + 1 {
                return Err(format!("ligne de données {} : {} colonnes au lieu de {}", i + 1, r.len(), tws.len() + 1));
            }
            twa.push(r[0]);
            kn.push(r[1..].to_vec());
        }
        let inc = |v: &[f64]| v.windows(2).all(|w| w[1] > w[0]);
        if !inc(&tws) || !inc(&twa) {
            return Err("les axes TWS et TWA doivent être strictement croissants".into());
        }
        if twa[0] < 0.0 || *twa.last().unwrap() > 180.0 {
            return Err("les TWA doivent être compris entre 0 et 180°".into());
        }
        // On étend les axes pour que 0° et 180° soient définis (extrapolation constante).
        let (mut twa, mut kn) = (twa, kn);
        if twa[0] > 0.0 {
            twa.insert(0, 0.0);
            kn.insert(0, vec![0.0; tws.len()]);
        }
        if *twa.last().unwrap() < 180.0 {
            let last = kn.last().unwrap().clone();
            twa.push(180.0);
            kn.push(last);
        }
        Ok(Polar { tws, twa, kn })
    }

    /// Polaire générique d'un monocoque volant de 60 pieds, **fictive et approximative** :
    /// ordres de grandeur plausibles, pas les polaires de Virtual Regatta.
    /// Pour des résultats fidèles à ton bateau, charge tes propres polaires.
    pub fn imoca_generic() -> Polar {
        let tws = vec![0.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0, 20.0, 25.0, 30.0, 40.0];
        let twa = vec![
            0.0, 30.0, 34.0, 38.0, 42.0, 46.0, 52.0, 60.0, 75.0, 90.0, 105.0, 120.0, 135.0, 150.0, 165.0, 180.0,
        ];
        // Forme angulaire (fraction de la vitesse maxi) par TWA, interpolée linéairement.
        let shape: [(f64, f64); 14] = [
            (0.0, 0.0),
            (30.0, 0.0),
            (34.0, 0.35),
            (40.0, 0.55),
            (52.0, 0.72),
            (60.0, 0.80),
            (75.0, 0.90),
            (90.0, 0.96),
            (110.0, 1.0),
            (125.0, 1.0),
            (140.0, 0.95),
            (150.0, 0.90),
            (165.0, 0.80),
            (180.0, 0.72),
        ];
        let h = |a: f64| -> f64 {
            for w in shape.windows(2) {
                if a <= w[1].0 {
                    let f = (a - w[0].0) / (w[1].0 - w[0].0);
                    return w[0].1 * (1.0 - f) + w[1].1 * f;
                }
            }
            shape[shape.len() - 1].1
        };
        let vmax = |w: f64| -> f64 {
            let base = 38.0 * (1.0 - (-w / 11.0).exp());
            if w > 30.0 {
                base * (1.0 - 0.012 * (w - 30.0))
            } else {
                base
            }
        };
        let kn = twa
            .iter()
            .map(|&a| {
                tws.iter()
                    .map(|&w| {
                        // Moins de vitesse au portant dans le petit temps (vent apparent faible).
                        let light = if a > 120.0 { 0.85 + 0.15 * (w / 12.0_f64).min(1.0) } else { 1.0 };
                        (vmax(w) * h(a) * light * 10.0).round() / 10.0
                    })
                    .collect()
            })
            .collect();
        Polar { tws, twa, kn }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolation_between_nodes() {
        let p = Polar::from_text("TWA\\TWS;10;20\n0;0;0\n90;10;20\n180;5;10").unwrap();
        assert!((p.speed(90.0, 15.0) - 15.0).abs() < 1e-9);
        assert!((p.speed(-90.0, 15.0) - 15.0).abs() < 1e-9, "symétrique bâbord/tribord");
        assert!((p.speed(135.0, 10.0) - 7.5).abs() < 1e-9);
        assert_eq!(p.speed(90.0, 99.0), 20.0, "clamp au-delà du TWS maxi");
    }

    #[test]
    fn parse_french_decimal_commas() {
        let p = Polar::from_text("TWA/TWS;6;12\n45;7,5;12,25\n90;9;15\n").unwrap();
        assert_eq!(p.twa[0], 0.0, "0° ajouté");
        assert_eq!(*p.twa.last().unwrap(), 180.0, "180° ajouté");
        assert!((p.speed(45.0, 12.0) - 12.25).abs() < 1e-9);
    }

    #[test]
    fn rejects_bad_files() {
        assert!(Polar::from_text("").is_err());
        assert!(Polar::from_text("a;6;4\n10;1;2\n20;1;2").is_err(), "TWS décroissant");
        assert!(Polar::from_text("a;6;8\n10;1\n20;1;2").is_err(), "colonne manquante");
    }

    #[test]
    fn generic_polar_is_plausible() {
        let p = Polar::imoca_generic();
        assert_eq!(p.speed(0.0, 15.0), 0.0, "pas d'allure face au vent");
        let (a_up, v_up) = p.best_upwind(14.0);
        assert!((38.0..=56.0).contains(&a_up), "angle près {a_up}");
        assert!((8.0..=13.0).contains(&v_up), "VMG près {v_up}");
        let (a_dn, v_dn) = p.best_downwind(20.0);
        assert!(a_dn > 120.0, "angle portant {a_dn}");
        assert!((15.0..=32.0).contains(&v_dn), "VMG portant {v_dn}");
        assert!(p.speed(110.0, 20.0) > 28.0 && p.speed(110.0, 20.0) < 36.0);
    }
}
