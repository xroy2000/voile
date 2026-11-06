# Offshore Racing — simulateur de course au large avec routeur intégré (Rust + WASM)

Simulateur de régate transatlantique (Saint-Malo → Pointe-à-Pitre) : bateau à polaire, pilote automatique
(cap, TWA, VMG, point, route du routeur), temps accéléré, adversaires, **routeur à isochrones intégré**
(exécuté dans un Web Worker), vent GFS réel.

Aucun asset, code ou polaire de Virtual Regatta n'est inclus ; rien ne s'injecte dans le client VR.

**En ligne : https://offshore-racing.vercel.app** (publié automatiquement à chaque `git push` sur `main`).

## Pilotage
- **Compas** (panneau gauche) : rose, bateau avec grand-voile, vent, zone interdite et lignes de près/portant, secteur de TWA
  (rouge bâbord / vert tribord), cap verrouillé et relèvement du prochain point. Clic ou glisser pour régler le cap
  (ou le TWA en mode TWA) : le cap proposé s'affiche en jaune et ne s'applique qu'après **Valider** (Entrée) ; **Annuler** (Échap) l'abandonne. Boutons ±1° / ±5°, flèches ← → (Maj = 5°), bouton Virer / empanner.
- **Points de routage** : 📍 ou « Ajouter sur la carte » (double-clic aussi), glisser pour déplacer, clic droit ou ✕ pour supprimer.
  « Aller aux points » les fait rallier au pilote dans l'ordre, puis l'arrivée.
- **Route idéale** ★ : route du routeur affichée en jaune, recalculée automatiquement quand les points changent
  (tronçon par point, puis arrivée) ; « Suivre la route idéale » engage le pilote dessus.

## Temps réel et simulation
Le bateau avance **en temps réel** (horloge du jeu = horloge réelle) ; page fermée, il rattrape l'heure écoulée avec son pilote au rechargement.
Le bouton « ▶ Simuler la route » accélère le temps à partir de l'état réel sans le modifier (la sauvegarde garde l'état réel) ;
« ■ Revenir au réel » restaure l'état réel.

## Alignement sur le routage
Par défaut le pilote suit la **route idéale estimée** (routeur à isochrones), recalculée toutes les 3 h (réglable) et à chaque changement de points de routage.
Tout réglage manuel (compas, TWA, VMG, point) coupe l'alignement ; la case « Le bateau s'aligne sur la route idéale » ou « Suivre la route idéale » le rétablit.
La route montre ses points estimés, l'heure toutes les 6 h, les virements (rouge) et empannages (vert) ; survole un point pour le détail.
Après un import GPX, « Suivre la route GPX » fait suivre au pilote les points datés du fichier.

## Performance (calibrage de la polaire)
La polaire générique va trop vite pour un bateau réel. Section « Mon bateau → Performance » : curseur « Polaire × % », **Calibrer** sur la vitesse
réelle saisie (à l'allure et au vent actuels) ou **Calibrer depuis le GPX** (médiane des vitesses du fichier comparées à la polaire dans le vent du modèle).
Le facteur s'applique au bateau, aux adversaires et au routeur (la route est recalculée), il est mémorisé et sauvegardé avec la partie.
Il compense aussi l'écart entre le vent GFS et celui de ton jeu : à recaler si les conditions changent beaucoup.

## Sauvegarde de la partie
Sauvegarde automatique toutes les 5 s dans le navigateur (case « Partie »), reprise au rechargement : position, cap, vitesse, temps de jeu,
adversaires, pilote (cap / TWA / VMG / point / route), route idéale, points de routage, route GPX et vitesse du temps.
**Exporter** télécharge un `.json`, **Charger** le reprend (autre navigateur ou ordinateur), **Nouvelle partie** efface la sauvegarde.

## Mon bateau
Section « Mon bateau » : monocoque IMOCA à foils, trimaran, catamaran ou voilier classique ; couleurs de coque, d'accent et de voile ; taille ;
voiles affichées ou non. L'icône est utilisée sur la carte et au centre du compas, et sa grand-voile suit le TWA. Réglages mémorisés.

## Vent animé
Le bouton ≋ de la carte active des milliers de particules qui glissent dans le champ de vent, avec une traîne : vitesse proportionnelle à la force du vent, trait plus épais quand il forcit,
et suivi du déplacement et du zoom de la carte. Désactivé, la carte revient aux flèches fixes. Le choix est mémorisé (et l'animation est coupée par défaut si le système demande moins de mouvement).

## Cibles, routages et ordre au bateau
Le panneau de droite suit le parcours de Virtual Regatta en trois étapes :
1. **Cibles** (waypoints Wp1, Wp2…) : posées sur la carte, à la position du bateau ou par coordonnées ; renommables (double-clic), réordonnables, déplaçables à la souris. Le bouton **Routage** d'une cible calcule le trajet du bateau jusqu'à cette seule cible.
2. **Routages** : « Calculer le routage complet » (bateau → toutes les cibles → arrivée) et chaque routage vers une cible sont gardés dans **Mes routages** (début, arrivée, durée, distance) : case pour l'afficher sur la carte dans sa couleur, renommage, suppression. Ils sont sauvegardés avec la partie.
3. **Ordre au bateau** : ▶ Suivre un routage (il est alors figé, le recalcul automatique est suspendu), suivre la route active, rallier les cibles en ligne directe, ou aller à l'arrivée. L'ordre en cours est toujours affiché.

Les limites par offre sont rassemblées dans `PLANS` (`web/main.js`) : en mode **admin** tout est ouvert ; une offre payante pourra limiter les cibles, les routages gardés ou le routage par cible.

## Importer ma position (GPX)
Bouton « Importer GPX (position) » : piste = dernier point, route ou waypoint = premier point. Le bateau repart de là **à l'heure du fichier**, rattrape le temps réel en suivant la route idéale,
et la route du fichier est tracée en pointillés bleus (« Route GPX »).

## Comptes et invitations
Pas d'e-mail ni de service externe : l'organisateur ouvre `/admin.html` (code `ADMIN_SECRET`), crée un lien d'invitation à usage unique et l'envoie au joueur,
qui choisit pseudo et mot de passe sur `/join.html`. Mot de passe perdu : « Nouveau mot de passe » sur la fiche du joueur crée un lien de réinitialisation.
Les comptes vivent dans Neon Postgres (`DATABASE_URL`), la session dans un cookie signé (`SESSION_SECRET`). Détails : `docs/MULTIPLAYER.md`.

    npm install
    npm run dev          # http://localhost:8767, base PGlite en mémoire, code admin local affiché au démarrage
    npm run test:auth    # parcours complet (invitation, connexion, réinitialisation, limitation des essais)

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
