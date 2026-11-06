# Offshore Racing — multijoueur : plan d'architecture

Choix validés : **Vercel + Neon Postgres**, inscription par **lien d'invitation + mot de passe** (sans e-mail), format **course commune en temps réel**
(même parcours, même vent, un bateau et des ordres par joueur, classement partagé, adversaires visibles sur la carte).

## Principe : serveur autoritaire, simulation « paresseuse »
Un voilier en temps réel ne change de trajectoire que lorsqu'il reçoit un ordre. On ne fait donc tourner aucun processus permanent :

- Chaque inscrit a un **état** (position, cap, vitesse, temps, pilote) et des **ordres** (cap, TWA, VMG, point, route, points de routage).
- Quand quelqu'un consulte ou donne un ordre, une fonction serverless charge l'état, l'**avance jusqu'à l'heure actuelle** avec le moteur
  (le même crate Rust, compilé en WASM, déterministe : c'est exactement le « rattrapage du temps réel » déjà présent côté navigateur),
  puis applique l'ordre et enregistre le nouvel état.
- Le client garde son moteur local pour l'affichage fluide, le routeur et les prévisions ; la **position officielle vient du serveur**.
- Le mode « Simuler » reste 100 % local et ne touche jamais l'état officiel.

## Données (Neon Postgres)
| Table | Contenu |
|---|---|
| `users` | id, pseudo, `pseudo_lc` (unique), hash du mot de passe (scrypt), créé le, dernière connexion |
| `invites` | hash du jeton, note, joueur à réinitialiser (facultatif), expiration, utilisé le/par, annulé |
| `login_attempts` | clé IP + pseudo, date (limitation des essais) |
| `races` | id, nom, parcours (départ, arrivée), `start_unix`, vent (`wind_ref`), statut, classe de bateau + `perf` imposée |
| `entries` | user_id, race_id, nom/style du bateau (JSON), `state` (JSON `export_state`), `state_t`, `orders` (JSON : pilote, route, points), arrivée |
| `order_log` | entry_id, t, type, charge utile (audit, relecture, litiges) |
| `standings` | race_id, t, classement calculé (cache) |

## Authentification (en place)
Pas d'e-mail : l'organisateur crée un **lien d'invitation à usage unique** (page `/admin.html`, protégée par `ADMIN_SECRET`). Le joueur ouvre le lien,
choisit son pseudo et son mot de passe (scrypt), puis reçoit un cookie de session signé (HMAC, HttpOnly, SameSite=Lax, 30 jours, `SESSION_SECRET`).
- Les jetons d'invitation ne sont stockés que sous forme de hash ; le lien n'est affiché qu'une fois, valable 1 à 30 jours (7 par défaut), annulable.
- **Mot de passe perdu** : l'administrateur crée un lien de réinitialisation rattaché au pseudo (bouton « Nouveau mot de passe »).
- Connexion limitée à 8 échecs par 15 minutes (IP + pseudo) ; les requêtes qui modifient l'état exigent `Content-Type: application/json`.
- Endpoints : `POST /api/auth/login|logout`, `GET /api/auth/me`, `GET /api/invite/check`, `POST /api/invite/redeem`, `/api/admin/invites`, `/api/admin/users`.
- Test local : `npm install && npm run dev` (base PGlite en mémoire), tests : `npm run test:auth`.
- Suppression de compte par l'administrateur ; export des données (RGPD) prévu.

## API (fonctions Vercel, dossier `api/`)
- `GET /api/races` · `POST /api/races/:id/join` : choisir une course, s'inscrire avec nom et style de bateau.
- `GET /api/races/:id/fleet` : positions de tous les bateaux à l'instant courant (avancés à la demande ou lus du cache), classement.
- `GET /api/entries/me` : mon état officiel avancé à maintenant.
- `POST /api/entries/me/orders` : valider l'ordre (serveur avance l'état à maintenant, applique, journalise).
- Le navigateur interroge la flotte toutes les 15–30 s (pas besoin de websockets au départ).

## Vent partagé
`wind.bin` (GFS) est produit par `gribtool` (Rust natif) : une **tâche planifiée GitHub Actions** (4 fois par jour, après chaque cycle NOAA)
le génère et le dépose dans **Vercel Blob** ; les fonctions et les clients lisent la même référence (`wind_ref` de la course) pour que
tout le monde navigue dans le même vent. Un **Vercel Cron** recalcule le classement toutes les 1 à 5 minutes.

## Équité et triche
- Position et vitesse calculées côté serveur uniquement ; le client n'envoie que des **ordres**, validés (cap 0–359, TWA −180–180, points dans la zone, cadence limitée).
- En course commune, la **performance (`perf`) est imposée par la classe** de bateau : le calibrage libre reste réservé au solo.
- Les icônes (type, couleurs) sont purement cosmétiques.

## Évolutions côté client
Écran de connexion, choix de course, flotte réelle à la place des adversaires simulés (les IA peuvent compléter une course peu peuplée),
ordres envoyés au serveur, indicateur « état officiel / simulation », reprise automatique de la partie par compte au lieu du `localStorage`.

## Phases
1. **Projet Vercel + Neon** : dépôt relié, `api/`, variables d'environnement, schéma SQL.
2. **Comptes** : ✅ invitation par lien, pseudo, mot de passe, session.
3. **Courses et inscriptions** : créer/lister/rejoindre, état initial au départ.
4. **Serveur autoritaire** : moteur WASM en fonction, avance paresseuse, ordres validés et journalisés.
5. **Flotte partagée** : positions des autres joueurs sur la carte, classement, rafraîchissement.
6. **Vent planifié** : GitHub Actions → Blob, Cron pour le classement.
7. **Finitions** : sessions privées sur invitation, notifications d'arrivée, RGPD, limites de débit.

## Ce qu'il me faut de ta part (avant la phase 1)
- Compte **Vercel** connecté à cette session (le connecteur Vercel demande une autorisation à donner toi-même, via `/mcp` dans un terminal Claude Code).
- Un projet **Neon** (créable depuis le Marketplace Vercel) ; je configure le schéma.
- Le nom de domaine ou sous-domaine souhaité pour le jeu.
- Une première course à créer : parcours, date de départ, classe de bateau.

## Points de vigilance
- Le WASM (~300 Ko) est léger pour une fonction serverless ; vérifier le temps de démarrage à froid.
- L'avance d'un état sur plusieurs jours est rapide (pas de 10 s), mais on plafonnera à 7 jours par appel et on mettra à jour les états en tâche de fond.
- Le plan gratuit de Neon suffit pour démarrer ; surveiller le volume du journal d'ordres.
