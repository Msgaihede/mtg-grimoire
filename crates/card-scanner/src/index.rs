//! The reference index: the on-disk bundle format, and the search over it.
//!
//! ## The search needs no index structure, and that is a finding rather than an omission
//!
//! 117,619 printings at 256 bits is four `u64` popcounts each — about **470 k popcounts**,
//! which is a fraction of a millisecond on a desktop core and a few milliseconds on a phone.
//! A brute-force scan *is* the search. There is no approximate-nearest-neighbour structure
//! here, no BK-tree and no vector store, because at this scale every one of them would cost
//! build time, memory and correctness risk to save an amount of time too small to perceive.
//!
//! This is written down because the absence looks like an oversight to anyone who has built
//! a retrieval system at a scale where it is not. Filters make it faster still: a mask is
//! applied *during* the scan, so a reader who has narrowed to three sets is searching a few
//! hundred rows.
//!
//! ## Two sections, because half of all artworks are shared
//!
//! Measured on the corpus: 117,619 printings across 50,963 distinct artworks, of which
//! **25,376 appear on more than one printing**. So the two sections answer different
//! questions and neither substitutes for the other:
//!
//! * [`Section::Card`] is keyed by printing and hashes the whole card, so it can separate a
//!   borderless from a showcase from a retro frame — the differences are on the card even
//!   when the art is identical.
//! * [`Section::Art`] is keyed by `illustration_id` and hashes the art crop alone, so it
//!   survives a frame the whole-card hash has never seen, at the cost of landing in a bucket
//!   averaging 2.3 printings.

use crate::hash::{Descriptor, HashKind};
use std::collections::HashSet;

/// `MTGSCAN\x01`. Deliberately 8 bytes with a trailing version byte, so a future format can
/// be told apart at the first read rather than at the first wrong answer.
pub const MAGIC: [u8; 8] = *b"MTGSCAN\x01";
pub const FORMAT_VERSION: u16 = 1;
/// Bytes before the first entry. Fixed so a section can be memory-mapped later without the
/// header parse moving.
pub const HEADER_LEN: usize = 32;
/// A Scryfall id, raw. 16 bytes rather than the 36-character hyphenated text, which would
/// more than double the file for no gain.
pub const ID_LEN: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Section {
    /// One entry per printing, hashing Scryfall's `thumb` (the whole card).
    Card,
    /// One entry per distinct `illustration_id`, hashing `art` (the art crop).
    Art,
}

impl Section {
    pub fn as_str(self) -> &'static str {
        match self {
            Section::Card => "card",
            Section::Art => "art",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BundleError {
    #[error("not a card-scanner bundle (bad magic)")]
    BadMagic,
    #[error("bundle format version {found}, but this build understands {expected}")]
    BadVersion { found: u16, expected: u16 },
    #[error("unsupported hash width {0} — the format defines 128 and 256")]
    BadHashWidth(u16),
    #[error("unknown hash kind byte {0}")]
    BadHashKind(u8),
    #[error("bundle is truncated: header claims {expected} bytes, file has {actual}")]
    Truncated { expected: usize, actual: usize },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// One section's rows, stored as two parallel arrays rather than a `Vec` of structs.
///
/// Struct-of-arrays because the hot loop touches only `words`: keeping the 16-byte ids out
/// of it means a scan reads 32 bytes per candidate instead of 48, and the ids are touched
/// once, for the handful of rows that actually rank.
#[derive(Debug, Clone, Default)]
pub struct SectionData {
    pub ids: Vec<[u8; ID_LEN]>,
    /// `len() == ids.len() * stride`.
    pub words: Vec<u64>,
    pub stride: usize,
}

impl SectionData {
    pub fn len(&self) -> usize {
        self.ids.len()
    }
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }
}

#[derive(Debug, Clone)]
pub struct Bundle {
    pub built_at: i64,
    pub kind: HashKind,
    pub bits: u16,
    pub cards: SectionData,
    pub arts: SectionData,
}

/// A ranked hit. `distance` is in bits; `normalized` divides by the width so a threshold can
/// be reasoned about without knowing which width the bundle used.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct Match {
    #[serde(serialize_with = "ser_uuid")]
    pub id: [u8; ID_LEN],
    pub distance: u32,
    pub normalized: f32,
}

fn ser_uuid<S: serde::Serializer>(id: &[u8; ID_LEN], s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&format_uuid(id))
}

/// Render a raw 16-byte id as the hyphenated form Scryfall uses, so a debug artifact can be
/// pasted straight into a URL or a SQL query.
pub fn format_uuid(id: &[u8; ID_LEN]) -> String {
    let h: String = id.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// Parse the hyphenated form back to raw bytes. `None` for anything that is not a UUID.
pub fn parse_uuid(s: &str) -> Option<[u8; ID_LEN]> {
    let hex: String = s.chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 {
        return None;
    }
    let mut out = [0u8; ID_LEN];
    for i in 0..ID_LEN {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Restrict a search to a set of ids.
///
/// **Applied during the scan, never to its results.** Filtering afterwards would let an
/// excluded printing occupy a slot in the top-K and push a legitimate candidate out of it —
/// which is the difference between "only cards matching the filters are valid for matching"
/// and "the filters hide some of the answers".
#[derive(Debug, Clone, Default)]
pub struct Mask {
    allowed: Option<HashSet<[u8; ID_LEN]>>,
}

impl Mask {
    /// No restriction.
    pub fn all() -> Self {
        Mask { allowed: None }
    }
    pub fn allow_only(ids: impl IntoIterator<Item = [u8; ID_LEN]>) -> Self {
        Mask { allowed: Some(ids.into_iter().collect()) }
    }
    pub fn permits(&self, id: &[u8; ID_LEN]) -> bool {
        self.allowed.as_ref().is_none_or(|s| s.contains(id))
    }
    pub fn is_unrestricted(&self) -> bool {
        self.allowed.is_none()
    }
    /// How many ids the mask admits, or `None` when unrestricted.
    pub fn len(&self) -> Option<usize> {
        self.allowed.as_ref().map(|s| s.len())
    }
}

impl Bundle {
    pub fn section(&self, s: Section) -> &SectionData {
        match s {
            Section::Card => &self.cards,
            Section::Art => &self.arts,
        }
    }

    /// The `k` nearest entries in `section`, best first.
    ///
    /// Returns an empty vector — never an error — when the descriptor's width does not match
    /// the bundle's. That case is a programming mistake rather than a runtime condition, and
    /// [`Bundle::bits`] is public so a caller can hash to the right width in the first place.
    pub fn search(
        &self,
        query: &Descriptor,
        section: Section,
        k: usize,
        mask: &Mask,
    ) -> Vec<Match> {
        let data = self.section(section);
        if query.bits != self.bits || data.is_empty() || k == 0 {
            return Vec::new();
        }
        let stride = data.stride;

        // A bounded insertion list rather than sorting 117 k results: k is single digits in
        // every caller, so this is O(n·k) with a tiny constant against O(n log n) plus the
        // allocation of a full result vector.
        let mut best: Vec<Match> = Vec::with_capacity(k + 1);
        let mut worst = u32::MAX;

        for (i, id) in data.ids.iter().enumerate() {
            if !mask.permits(id) {
                continue;
            }
            let row = &data.words[i * stride..i * stride + stride];
            let mut d = 0u32;
            for (w, q) in row.iter().zip(query.words.iter()) {
                d += (w ^ q).count_ones();
            }
            if best.len() == k && d >= worst {
                continue;
            }
            let m = Match {
                id: *id,
                distance: d,
                normalized: d as f32 / self.bits as f32,
            };
            let pos = best.partition_point(|e| e.distance <= d);
            best.insert(pos, m);
            best.truncate(k);
            worst = best.last().map_or(u32::MAX, |e| e.distance);
        }
        best
    }

    /// Serialize to the on-disk format.
    pub fn to_bytes(&self) -> Vec<u8> {
        let entry = ID_LEN + self.bits as usize / 8;
        let mut out =
            Vec::with_capacity(HEADER_LEN + (self.cards.len() + self.arts.len()) * entry);
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        out.push(match self.kind {
            HashKind::DHash => 0,
            HashKind::PHash => 1,
            HashKind::DHashChroma => 2,
            HashKind::DHashChroma32 => 3,
        });
        out.extend_from_slice(&self.bits.to_le_bytes());
        out.push(0); // reserved, keeps `built_at` 8-byte aligned within the header
        out.extend_from_slice(&self.built_at.to_le_bytes());
        out.extend_from_slice(&(self.cards.len() as u32).to_le_bytes());
        out.extend_from_slice(&(self.arts.len() as u32).to_le_bytes());
        // Pad the 30 bytes of fields out to the declared [`HEADER_LEN`]. The padding is what
        // makes the header a round 32 bytes, so the first entry of a section begins on an
        // 8-byte boundary and a later change can memory-map `words` instead of copying it.
        out.extend_from_slice(&[0u8; HEADER_LEN - 30]);
        debug_assert_eq!(out.len(), HEADER_LEN, "header must be exactly {HEADER_LEN} bytes");

        for data in [&self.cards, &self.arts] {
            for (i, id) in data.ids.iter().enumerate() {
                out.extend_from_slice(id);
                for w in &data.words[i * data.stride..(i + 1) * data.stride] {
                    out.extend_from_slice(&w.to_le_bytes());
                }
            }
        }
        out
    }

    /// Parse the on-disk format.
    ///
    /// Every failure mode is an error rather than a panic or a partial read: this file
    /// arrives over the network from a GitHub release, so a truncated download is an
    /// expected event, not an impossible one.
    pub fn from_bytes(bytes: &[u8]) -> Result<Bundle, BundleError> {
        if bytes.len() < HEADER_LEN || bytes[..8] != MAGIC {
            return Err(BundleError::BadMagic);
        }
        let version = u16::from_le_bytes([bytes[8], bytes[9]]);
        if version != FORMAT_VERSION {
            return Err(BundleError::BadVersion { found: version, expected: FORMAT_VERSION });
        }
        let kind = match bytes[10] {
            0 => HashKind::DHash,
            1 => HashKind::PHash,
            2 => HashKind::DHashChroma,
            3 => HashKind::DHashChroma32,
            other => return Err(BundleError::BadHashKind(other)),
        };
        let bits = u16::from_le_bytes([bytes[11], bytes[12]]);
        if !matches!(bits, 128 | 256) {
            return Err(BundleError::BadHashWidth(bits));
        }
        let built_at = i64::from_le_bytes(bytes[14..22].try_into().expect("8 bytes"));
        let n_card = u32::from_le_bytes(bytes[22..26].try_into().expect("4 bytes")) as usize;
        let n_art = u32::from_le_bytes(bytes[26..30].try_into().expect("4 bytes")) as usize;

        let hash_bytes = bits as usize / 8;
        let entry = ID_LEN + hash_bytes;
        let expected = HEADER_LEN + (n_card + n_art) * entry;
        if bytes.len() < expected {
            return Err(BundleError::Truncated { expected, actual: bytes.len() });
        }

        let stride = bits as usize / 64;
        let mut offset = HEADER_LEN;
        let mut read = |n: usize| -> SectionData {
            let mut ids = Vec::with_capacity(n);
            let mut words = Vec::with_capacity(n * stride);
            for _ in 0..n {
                let mut id = [0u8; ID_LEN];
                id.copy_from_slice(&bytes[offset..offset + ID_LEN]);
                ids.push(id);
                let h = offset + ID_LEN;
                for w in 0..stride {
                    words.push(u64::from_le_bytes(
                        bytes[h + w * 8..h + w * 8 + 8].try_into().expect("8 bytes"),
                    ));
                }
                offset += entry;
            }
            SectionData { ids, words, stride }
        };

        let cards = read(n_card);
        let arts = read(n_art);
        Ok(Bundle { built_at, kind, bits, cards, arts })
    }
}

/// Accumulate entries while building, then freeze into a [`Bundle`].
#[derive(Debug)]
pub struct BundleBuilder {
    kind: HashKind,
    bits: u16,
    cards: SectionData,
    arts: SectionData,
}

impl BundleBuilder {
    pub fn new(kind: HashKind, bits: u16) -> Self {
        let stride = bits as usize / 64;
        BundleBuilder {
            kind,
            bits,
            cards: SectionData { stride, ..Default::default() },
            arts: SectionData { stride, ..Default::default() },
        }
    }

    /// Add an entry. Silently ignores a descriptor of the wrong width — which cannot happen
    /// from the builder binary, since it hashes at `self.bits` throughout.
    pub fn push(&mut self, section: Section, id: [u8; ID_LEN], d: &Descriptor) {
        if d.bits != self.bits {
            return;
        }
        let data = match section {
            Section::Card => &mut self.cards,
            Section::Art => &mut self.arts,
        };
        data.ids.push(id);
        data.words.extend_from_slice(&d.words[..data.stride]);
    }

    pub fn len(&self, section: Section) -> usize {
        match section {
            Section::Card => self.cards.len(),
            Section::Art => self.arts.len(),
        }
    }

    pub fn finish(self, built_at: i64) -> Bundle {
        Bundle {
            built_at,
            kind: self.kind,
            bits: self.bits,
            cards: self.cards,
            arts: self.arts,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desc(bits: u16, seed: u64) -> Descriptor {
        let mut words = [0u64; 4];
        for (i, w) in words.iter_mut().enumerate().take(bits as usize / 64) {
            // A cheap deterministic spread; the values only need to differ.
            *w = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15).wrapping_add(i as u64 * 0x1234_5678);
        }
        Descriptor { words, bits }
    }

    fn id(n: u8) -> [u8; ID_LEN] {
        let mut b = [0u8; ID_LEN];
        b[0] = n;
        b
    }

    fn sample(bits: u16) -> Bundle {
        let mut b = BundleBuilder::new(HashKind::DHash, bits);
        for i in 0..20u8 {
            b.push(Section::Card, id(i), &desc(bits, i as u64));
        }
        for i in 100..110u8 {
            b.push(Section::Art, id(i), &desc(bits, i as u64));
        }
        b.finish(1_756_000_000)
    }

    #[test]
    fn round_trips_through_bytes() {
        for bits in [128u16, 256] {
            let original = sample(bits);
            let bytes = original.to_bytes();
            assert_eq!(
                bytes.len(),
                HEADER_LEN + 30 * (ID_LEN + bits as usize / 8),
                "unexpected size at {bits} bits"
            );
            let back = Bundle::from_bytes(&bytes).expect("parses");
            assert_eq!(back.bits, bits);
            assert_eq!(back.kind, HashKind::DHash);
            assert_eq!(back.built_at, 1_756_000_000);
            assert_eq!(back.cards.ids, original.cards.ids);
            assert_eq!(back.cards.words, original.cards.words);
            assert_eq!(back.arts.ids, original.arts.ids);
            assert_eq!(back.arts.words, original.arts.words);
        }
    }

    #[test]
    fn an_exact_entry_is_found_at_distance_zero() {
        let b = sample(256);
        let q = desc(256, 7);
        let hits = b.search(&q, Section::Card, 3, &Mask::all());
        assert_eq!(hits[0].id, id(7));
        assert_eq!(hits[0].distance, 0);
        assert_eq!(hits[0].normalized, 0.0);
    }

    #[test]
    fn results_come_back_sorted_and_capped() {
        let b = sample(256);
        let hits = b.search(&desc(256, 3), Section::Card, 5, &Mask::all());
        assert_eq!(hits.len(), 5);
        for w in hits.windows(2) {
            assert!(w[0].distance <= w[1].distance, "results are not sorted: {hits:?}");
        }
    }

    #[test]
    fn sections_do_not_leak_into_each_other() {
        let b = sample(256);
        // id(7) lives only in Card; searching Art for it must not find it.
        let hits = b.search(&desc(256, 7), Section::Art, 5, &Mask::all());
        assert!(hits.iter().all(|h| h.id != id(7)), "a Card entry surfaced in an Art search");
        assert_eq!(b.section(Section::Art).len(), 10);
    }

    #[test]
    fn a_mask_excludes_during_the_scan() {
        let b = sample(256);
        // The exact match is masked out; it must not appear at all, and the results must
        // still be full — which is what proves the mask ran during the scan rather than
        // after it.
        let mask = Mask::allow_only((0..20u8).filter(|i| *i != 7).map(id));
        let hits = b.search(&desc(256, 7), Section::Card, 5, &mask);
        assert_eq!(hits.len(), 5, "masking must not shrink the result set");
        assert!(hits.iter().all(|h| h.id != id(7)), "a masked id was returned");
    }

    #[test]
    fn a_width_mismatch_returns_nothing_rather_than_nonsense() {
        let b = sample(256);
        assert!(b.search(&desc(128, 7), Section::Card, 3, &Mask::all()).is_empty());
    }

    #[test]
    fn bad_headers_are_errors() {
        assert!(matches!(Bundle::from_bytes(b"nope").unwrap_err(), BundleError::BadMagic));

        let mut bytes = sample(256).to_bytes();
        bytes[8] = 99; // version
        assert!(matches!(
            Bundle::from_bytes(&bytes).unwrap_err(),
            BundleError::BadVersion { found: 99, .. }
        ));

        let mut bytes = sample(256).to_bytes();
        bytes[11] = 77; // hash width low byte
        assert!(matches!(Bundle::from_bytes(&bytes).unwrap_err(), BundleError::BadHashWidth(_)));

        let mut bytes = sample(256).to_bytes();
        bytes[10] = 9; // hash kind
        assert!(matches!(Bundle::from_bytes(&bytes).unwrap_err(), BundleError::BadHashKind(9)));
    }

    #[test]
    fn a_truncated_bundle_is_an_error_not_a_panic() {
        // The case that actually happens: a download cut short. Indexing past the end here
        // would be a panic in a background thread.
        let full = sample(256).to_bytes();
        let cut = &full[..full.len() - 17];
        assert!(matches!(
            Bundle::from_bytes(cut).unwrap_err(),
            BundleError::Truncated { .. }
        ));
    }

    #[test]
    fn uuid_text_round_trips() {
        let raw = [
            0x00, 0x00, 0x41, 0x9b, 0x0b, 0xba, 0x44, 0x88, 0x8f, 0x7a, 0x61, 0x94, 0x54, 0x4c,
            0xe9, 0x1e,
        ];
        let text = format_uuid(&raw);
        assert_eq!(text, "0000419b-0bba-4488-8f7a-6194544ce91e");
        assert_eq!(parse_uuid(&text), Some(raw));
        assert_eq!(parse_uuid("not-a-uuid"), None);
    }

    #[test]
    fn an_empty_bundle_searches_without_panicking() {
        let b = BundleBuilder::new(HashKind::PHash, 128).finish(0);
        assert!(b.search(&desc(128, 1), Section::Card, 5, &Mask::all()).is_empty());
        let bytes = b.to_bytes();
        assert_eq!(Bundle::from_bytes(&bytes).expect("parses").cards.len(), 0);
    }
}
