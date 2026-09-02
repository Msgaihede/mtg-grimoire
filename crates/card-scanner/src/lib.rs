//! Identify a physical Magic card from a camera frame or a photograph, locally.
//!
//! **This crate knows nothing about cameras.** A frame is an [`image::DynamicImage`], and
//! where it came from — a file, a webcam, a phone, a Tauri command — is the caller's
//! business. That is what lets one implementation serve the CLI, the live debug page, and
//! later the app's `getUserMedia` path without a second copy of the pipeline.
//!
//! The design, every measurement behind it, and what is deliberately left out:
//! `docs/superpowers/specs/2026-09-01-card-scanner-design.md`.

pub mod cardness;
pub mod debug;
pub mod detect;
pub mod index;
pub mod lock;
pub mod ocr;
pub mod reference;
pub mod track;
pub mod trim;
pub mod hash;

/// A Magic card's aspect ratio: 63 mm × 88 mm.
///
/// The single most useful prior in the whole pipeline. Quad detection produces dozens of
/// plausible rectangles in any real photograph — a table edge, a playmat border, a phone
/// case, the card's own inner art frame — and almost none of them are 0.716. It is doing
/// more work than any threshold in [`detect`].
pub const CARD_ASPECT: f32 = 63.0 / 88.0;

/// The canonical rectified size every tier downstream assumes.
///
/// Matches Scryfall's `grid` variant exactly, which is deliberate: reference images and
/// rectified photographs then differ in content rather than in geometry, and a debug
/// artifact can be laid beside a reference render with no scaling in between.
pub const RECTIFIED_W: u32 = 488;
pub const RECTIFIED_H: u32 = 680;
