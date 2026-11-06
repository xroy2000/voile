# Voile autonome — simulateur de course avec routeur intégré (Rust + WASM)

Simulateur de régate transatlantique (Saint-Malo → Pointe-à-Pitre) : bateau à polaire, pilote automatique
(cap, TWA, VMG, point, route du routeur), temps accéléré, adversaires, **routeur à isochrones intégré**
(exécuté dans un Web Worker), vent GFS réel.

Aucun asset, code ou polaire de Virtual Regatta n'est inclus ; rien ne s'injecte dans le client VR.

## Construire
    rustup target add wasm32-unknown-unknown
    cargo install wasm-bindgen-cli --version 0.2.130 --locked
    ./build.sh                       # génère web/pkg
    cargo test -p regatta-core       # 30 tests

## Vent réel (GFS, NOAA via AWS)
    cargo run --release -p gribtool -- fetch --hours 168 --out web/wind.bin
Sans `web/wind.bin`, un vent synthétique est utilisé.

## Lancer (file:// ne marche pas avec les modules ES)
    python3 -m http.server -d web 8000   # puis http://localhost:8000

## Polaire personnelle
Bouton « Polaire » : fichier .csv/.pol (séparateurs `;` tab `,`, décimales françaises). Sinon polaire IMOCA générique approximative.

## Limites connues
- Polaire générique fictive (pas celle de VR) ; vitesses fortes vent surestimées possibles.
- Voiles affichées seulement (une seule polaire « meilleure voile »).
- Vent GFS 10 m ≠ fichiers météo de VR ; prévision limitée à 168 h (vent figé au-delà).
- Le préréglage rapide du routeur est ~3,6 % sous-optimal ; « Précis » est plus proche de l'optimum.
