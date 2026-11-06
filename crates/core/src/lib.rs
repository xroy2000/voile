//! Moteur de course au large autonome : géo, polaires, vent, terre, bateau,
//! pilote automatique, routeur d'isochrones et boucle de jeu.
pub mod boat;
pub mod game;
pub mod geo;
pub mod land;
pub mod polar;
pub mod router;
pub mod wind;

pub use geo::LatLon;
