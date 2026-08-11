//! Owning [`super::CardIndex`] across the app's life: the warm-up build, the rebuild every
//! sync's staging swap owes it, and the cheap `owned` refresh a collection write owes it.
