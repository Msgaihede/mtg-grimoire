//! **What a server-side reader of the collection is given** (issue #1396, spec
//! `2026-10-24-integration-data-access-design.md`, option B): a published projection of the
//! reader's tables, sent by a device after it syncs, and never the group key.
//!
//! [`projection`] is a pure function of the database and its arguments — the six table documents,
//! their digests and their gzip — and the share snapshot reads through the same code (spec §7.5).
//! [`store`] is the integrations Worker's client, [`settings`] the group's switch as this device
//! last heard it and the four commands behind the panel, and [`publish`] the round that keeps the
//! store and every live share current after a sync trip, with the loop each host spawns.
//! Nothing here holds a key.

/// `Projection v1`: six table documents, the field policy, a digest per table, and the readers
/// the share snapshot is a filtered output of.
pub mod projection;
/// The publish round — the group's live shares, then the projection tables whose digest moved —
/// its pure debounce, and the loop a host spawns beside `sync_engine::live::run`.
pub mod publish;
/// What this device can publish whole: every printing it names in its card data (or gone from
/// Scryfall), and its prices readable here — the round's three questions, asked of a share and of
/// a table alike.
pub mod readable;
/// `IntegrationsStatus`, the switch's `app_meta` cache, and `integrations_status`,
/// `integrations_enable`, `integrations_set_fields` and `integrations_disable`.
pub mod settings;
/// The integrations Worker's four requests (plan §3.2), its address — a placeholder until the
/// first deploy — and the sentences its refusals become.
pub mod store;
