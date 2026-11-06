//! gribtool : récupère le vent 10 m de GFS (NOAA, bucket public AWS) et l'écrit au format VWN1 du jeu.
//!
//!   gribtool fetch   [--cycle latest|YYYYMMDDHH] [--hours 168] [--step 3] [--res 0p50|0p25|1p00]
//!                    [--area S,N,W,E] [--out web/wind.bin]
//!   gribtool convert --epoch YYYYMMDDHH --out wind.bin  <hh:fichier.grib2> ...   (U et V dans le même fichier)
//!   gribtool inspect <fichier.grib2>

use grib::{Grib2SubmessageDecoder, LatLons};
use regatta_core::wind::GridWind;
use std::io::{Cursor, Read};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BASE: &str = "https://noaa-gfs-bdp-pds.s3.amazonaws.com";
const MS_TO_KN: f64 = 1.943_844_492;

type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone, Copy)]
struct Area {
    s: f64,
    n: f64,
    w: f64,
    e: f64,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("erreur : {e}");
        std::process::exit(1);
    }
}

fn run() -> Res<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("fetch") => fetch(&args[1..]),
        Some("convert") => convert(&args[1..]),
        Some("inspect") => inspect(args.get(1).ok_or("fichier manquant")?),
        _ => {
            eprintln!("{}", include_str!("usage.txt"));
            Err("commande manquante".into())
        }
    }
}

fn opt<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(|s| s.as_str())
}

fn parse_area(s: &str) -> Res<Area> {
    let v: Vec<f64> = s.split(',').map(|x| x.trim().parse::<f64>()).collect::<Result<_, _>>().map_err(|_| "area : S,N,W,E numériques")?;
    if v.len() != 4 || v[0] >= v[1] || v[2] >= v[3] {
        return Err("area : S,N,W,E avec S<N et W<E (longitudes -180..180)".into());
    }
    Ok(Area { s: v[0], n: v[1], w: v[2], e: v[3] })
}

// ------------------------------------------------------------------ dates

/// Jours depuis 1970-01-01 pour une date civile (algorithme de H. Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn cycle_to_unix(c: &str) -> Res<f64> {
    if c.len() != 10 || !c.bytes().all(|b| b.is_ascii_digit()) {
        return Err("cycle attendu au format YYYYMMDDHH".into());
    }
    let n = |a: usize, b: usize| c[a..b].parse::<i64>().unwrap();
    Ok((days_from_civil(n(0, 4), n(4, 6), n(6, 8)) * 86400 + n(8, 10) * 3600) as f64)
}

fn unix_to_cycle(t: i64) -> String {
    let (y, m, d) = civil_from_days(t.div_euclid(86400));
    format!("{:04}{:02}{:02}{:02}", y, m, d, t.rem_euclid(86400) / 3600)
}

// ------------------------------------------------------------------ réseau

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().try_proxy_from_env(true).timeout(Duration::from_secs(120)).build()
}

fn http_ok(ag: &ureq::Agent, url: &str) -> bool {
    matches!(ag.head(url).call(), Ok(r) if r.status() == 200)
}

fn get_bytes(ag: &ureq::Agent, url: &str, range: Option<(u64, Option<u64>)>) -> Res<Vec<u8>> {
    let mut last = String::new();
    for attempt in 0..4 {
        let mut req = ag.get(url);
        if let Some((a, b)) = range {
            req = req.set("Range", &match b {
                Some(b) => format!("bytes={a}-{b}"),
                None => format!("bytes={a}-"),
            });
        }
        match req.call() {
            Ok(resp) => {
                let mut buf = Vec::new();
                match resp.into_reader().take(200_000_000).read_to_end(&mut buf) {
                    Ok(_) => return Ok(buf),
                    Err(e) => last = e.to_string(),
                }
            }
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(Duration::from_millis(500 * (attempt + 1)));
    }
    Err(format!("échec de {url} : {last}").into())
}

fn file_url(cycle: &str, res: &str, fh: u32) -> String {
    let (date, hh) = cycle.split_at(8);
    format!("{BASE}/gfs.{date}/{hh}/atmos/gfs.t{hh}z.pgrb2.{res}.f{fh:03}")
}

/// Plages d'octets (UGRD, VGRD) 10 m dans un fichier d'après son index .idx.
fn wind_ranges(idx: &str) -> Res<[(u64, Option<u64>); 2]> {
    let rows: Vec<(u64, &str, &str)> = idx
        .lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.split(':').collect();
            Some((p.get(1)?.parse::<u64>().ok()?, *p.get(3)?, *p.get(4)?))
        })
        .collect();
    let find = |var: &str| -> Res<(u64, Option<u64>)> {
        let i = rows.iter().position(|r| r.1 == var && r.2 == "10 m above ground").ok_or(format!("{var} 10 m absent de l'index"))?;
        Ok((rows[i].0, rows.get(i + 1).map(|r| r.0 - 1)))
    };
    Ok([find("UGRD")?, find("VGRD")?])
}

// ------------------------------------------------------------------ décodage

/// Champ découpé : lat croissante, lon croissante (−180..180), valeurs en m/s.
struct Field {
    lat0: f64,
    lon0: f64,
    d: f64,
    nlat: usize,
    nlon: usize,
    u: Vec<f32>,
    v: Vec<f32>,
}

fn norm_lon(x: f64) -> f64 {
    let y = (x + 180.0).rem_euclid(360.0) - 180.0;
    if y == -180.0 && x > 0.0 { 180.0 } else { y }
}

/// Décode les messages d'un buffer GRIB2 et en extrait U (cat. 2, n° 2) et V (cat. 2, n° 3) sur `area`.
fn decode_uv(data: Vec<u8>, area: Area) -> Res<Field> {
    let g = grib::from_reader(Cursor::new(data)).map_err(|e| format!("GRIB illisible : {e}"))?;
    let mut u: Option<Vec<(f32, f32, f32)>> = None;
    let mut v: Option<Vec<(f32, f32, f32)>> = None;
    for (_, sm) in g.iter() {
        let (cat, num) = (sm.prod_def().parameter_category(), sm.prod_def().parameter_number());
        let which = match (cat, num) {
            (Some(2), Some(2)) => 0,
            (Some(2), Some(3)) => 1,
            _ => continue,
        };
        let ll = sm.latlons().map_err(|e| format!("grille : {e}"))?;
        let dec = Grib2SubmessageDecoder::from(sm).map_err(|e| format!("décodeur : {e}"))?;
        let vals = dec.dispatch().map_err(|e| format!("décodage : {e}"))?;
        let pts: Vec<(f32, f32, f32)> = ll.zip(vals).map(|((la, lo), x)| (la, lo, x)).collect();
        if which == 0 { u = Some(pts) } else { v = Some(pts) }
    }
    let (u, v) = (u.ok_or("composante U absente")?, v.ok_or("composante V absente")?);
    if u.len() != v.len() {
        return Err("grilles U et V différentes".into());
    }
    // Pas de grille : plus petit écart non nul entre latitudes consécutives distinctes.
    let mut lats: Vec<f64> = u.iter().map(|p| p.0 as f64).collect();
    lats.sort_by(|a, b| a.partial_cmp(b).unwrap());
    lats.dedup_by(|a, b| (*a - *b).abs() < 1e-4);
    let d = (lats[1] - lats[0]).abs();
    let nlat = ((area.n - area.s) / d).round() as usize + 1;
    let nlon = ((area.e - area.w) / d).round() as usize + 1;
    let lat0 = (area.s / d).ceil() * d;
    let lon0 = (area.w / d).ceil() * d;
    let (nlat, nlon) = (nlat.min(((area.n - lat0) / d).floor() as usize + 1), nlon.min(((area.e - lon0) / d).floor() as usize + 1));
    let mut fu = vec![f32::NAN; nlat * nlon];
    let mut fv = vec![f32::NAN; nlat * nlon];
    for (pu, pv) in u.iter().zip(v.iter()) {
        let (lat, lon) = (pu.0 as f64, norm_lon(pu.1 as f64));
        let (iy, ix) = (((lat - lat0) / d).round(), ((lon - lon0) / d).round());
        if iy < 0.0 || ix < 0.0 || iy as usize >= nlat || ix as usize >= nlon {
            continue;
        }
        let k = iy as usize * nlon + ix as usize;
        fu[k] = pu.2;
        fv[k] = pv.2;
    }
    let missing = fu.iter().filter(|x| x.is_nan()).count();
    if missing > 0 {
        return Err(format!("{missing} points de la zone sans valeur (zone hors grille ?)").into());
    }
    Ok(Field { lat0, lon0, d, nlat, nlon, u: fu, v: fv })
}

fn quant(ms: f32) -> i16 {
    (ms as f64 * MS_TO_KN * 100.0).round().clamp(-32000.0, 32000.0) as i16
}

fn assemble(epoch: f64, fields: Vec<(u32, Field)>) -> Res<GridWind> {
    let first = &fields.first().ok_or("aucune échéance")?.1;
    let (nlat, nlon, lat0, lon0, d) = (first.nlat, first.nlon, first.lat0, first.lon0, first.d);
    let mut hours = Vec::new();
    let (mut u, mut v) = (Vec::new(), Vec::new());
    for (fh, f) in &fields {
        if f.nlat != nlat || f.nlon != nlon {
            return Err("échéances de grilles différentes".into());
        }
        hours.push(*fh as f32);
        u.extend(f.u.iter().map(|&x| quant(x)));
        v.extend(f.v.iter().map(|&x| quant(x)));
    }
    Ok(GridWind { epoch_unix: epoch, lat0, lon0, dlat: d, dlon: d, nlat, nlon, hours, u, v })
}

fn summarize(g: &GridWind) {
    let n = g.nlat * g.nlon;
    let speeds: Vec<f64> = (0..n).map(|k| (g.u[k] as f64).hypot(g.v[k] as f64) * 0.01).collect();
    let max = speeds.iter().cloned().fold(0.0, f64::max);
    let mean = speeds.iter().sum::<f64>() / n as f64;
    println!(
        "grille {}×{} ({:.2}°) lat {:.1}..{:.1} lon {:.1}..{:.1}, {} échéances de {}h à {}h ; vent 10 m (échéance 0) moyen {:.1} nds, maxi {:.1} nds",
        g.nlat, g.nlon, g.dlat, g.lat0, g.lat_range().1, g.lon0, g.lon_range().1, g.hours.len(), g.hours[0], g.hours.last().unwrap(), mean, max
    );
}

// ------------------------------------------------------------------ commandes

fn fetch(args: &[String]) -> Res<()> {
    let hours: u32 = opt(args, "--hours").unwrap_or("168").parse()?;
    let step: u32 = opt(args, "--step").unwrap_or("3").parse()?;
    let res = opt(args, "--res").unwrap_or("0p50");
    let area = parse_area(opt(args, "--area").unwrap_or("0,60,-85,15"))?;
    let out = opt(args, "--out").unwrap_or("wind.bin");
    if step == 0 || hours % step != 0 || hours > 384 {
        return Err("--hours doit être un multiple de --step et ≤ 384".into());
    }
    let ag = agent();

    let cycle = match opt(args, "--cycle").unwrap_or("latest") {
        "latest" => {
            let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
            let mut t = now - now.rem_euclid(6 * 3600);
            let mut found = None;
            for _ in 0..8 {
                let c = unix_to_cycle(t);
                if http_ok(&ag, &format!("{}.idx", file_url(&c, res, hours))) {
                    found = Some(c);
                    break;
                }
                t -= 6 * 3600;
            }
            found.ok_or("aucun cycle GFS complet trouvé dans les 48 dernières heures")?
        }
        c => c.to_string(),
    };
    println!("cycle GFS {cycle}, résolution {res}, échéances 0..{hours}h par {step}h, zone {:?}", (area.s, area.n, area.w, area.e));
    let epoch = cycle_to_unix(&cycle)?;

    let fhs: Vec<u32> = (0..=hours).step_by(step as usize).collect();
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<(u32, Res<Field>)>> = Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..8 {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                let Some(&fh) = fhs.get(i) else { break };
                let url = file_url(&cycle, res, fh);
                let r = (|| -> Res<Field> {
                    let idx = String::from_utf8(get_bytes(&ag, &format!("{url}.idx"), None)?)?;
                    let ranges = wind_ranges(&idx)?;
                    let mut buf = Vec::new();
                    for r in ranges {
                        buf.extend(get_bytes(&ag, &url, Some(r))?);
                    }
                    decode_uv(buf, area)
                })();
                if r.is_ok() {
                    eprint!(".");
                }
                results.lock().unwrap().push((fh, r));
            });
        }
    });
    eprintln!();
    let mut all = results.into_inner().unwrap();
    all.sort_by_key(|r| r.0);
    let mut fields = Vec::new();
    for (fh, r) in all {
        fields.push((fh, r.map_err(|e| format!("échéance f{fh:03} : {e}"))?));
    }
    let g = assemble(epoch, fields)?;
    summarize(&g);
    let bytes = g.to_bytes();
    std::fs::write(out, &bytes)?;
    println!("écrit {out} ({:.1} Mo)", bytes.len() as f64 / 1e6);
    Ok(())
}

fn convert(args: &[String]) -> Res<()> {
    let epoch = cycle_to_unix(opt(args, "--epoch").ok_or("--epoch YYYYMMDDHH requis")?)?;
    let out = opt(args, "--out").unwrap_or("wind.bin");
    let area = parse_area(opt(args, "--area").unwrap_or("0,60,-85,15"))?;
    let mut fields = Vec::new();
    let mut skip = false;
    for (i, a) in args.iter().enumerate() {
        if skip {
            skip = false;
            continue;
        }
        if a.starts_with("--") {
            skip = true;
            continue;
        }
        let _ = i;
        let (h, path) = a.split_once(':').ok_or("fichier attendu sous la forme HEURE:chemin.grib2")?;
        fields.push((h.parse::<u32>()?, decode_uv(std::fs::read(path)?, area)?));
    }
    fields.sort_by_key(|f| f.0);
    let g = assemble(epoch, fields)?;
    summarize(&g);
    std::fs::write(out, g.to_bytes())?;
    println!("écrit {out}");
    Ok(())
}

fn inspect(path: &str) -> Res<()> {
    let g = grib::from_reader(Cursor::new(std::fs::read(path)?)).map_err(|e| format!("GRIB illisible : {e}"))?;
    for (idx, sm) in g.iter() {
        let shape = sm.grid_shape().map(|s| format!("{}×{}", s.0, s.1)).unwrap_or_else(|_| "?".into());
        println!("{:?} cat={:?} n°={:?} grille={shape}", idx, sm.prod_def().parameter_category(), sm.prod_def().parameter_number());
    }
    Ok(())
}
