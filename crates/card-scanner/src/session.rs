//! One frame in, one verdict out — what every host's scanner shares.
//!
//! The app (`grimoire-core`'s `scanner.rs`), the browser's scanner Worker (`crates/grimoire-scan`)
//! and the replay (`bin/replay.rs`) each hand a JPEG to a [`Session`] and get a [`Verdict`] back.
//! Everything that decides a frame lives here once: the decode and its bounds, the filters' mask,
//! the recogniser and its agreement across frames (`neural_mode.rs`), the decision count, and
//! the panic guard. What stays with each caller is transport: an IPC body in, JSON out.
//!
//! **The recogniser is `crates/card-neural`'s** — two small CNNs and a gallery of looks, agreed
//! over two frames — and a host hands it its files ([`Session::load_neural`]). Until one has,
//! every frame is a failure that says so ([`NEURAL_UNAVAILABLE_ERROR`]).
//!
//! **The JSON keys are the page's.** `packages/ui/lib/ipc/scanner.ts` mirrors [`Verdict`] by
//! hand, and `packages/ui/lib/ipc.test.ts` holds the two to each other.

use crate::filters::ScanFilters;
use crate::host;
use crate::ids::Mask;
use crate::reference::{Label, MatchReport, Reference};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct FrameSize {
    pub w: u32,
    pub h: u32,
}

/// One card the agreement is counting, with its label resolved.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StandingView {
    pub id: String,
    pub evidence: f32,
    pub share: f32,
    pub seen: u32,
    pub label: Option<Label>,
    pub best_distance: f32,
}

/// How far the agreement is toward a decision.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TrackedView {
    pub committed: bool,
    /// The votes held over what deciding takes, 1 once decided.
    pub confidence: f32,
    /// The accepted frames a decision takes.
    pub decide_at: f32,
    /// The votes held.
    pub streak: u32,
    /// Frames read since the card was last forgotten.
    pub frames: u32,
    /// Frames running with no card in front of the lens.
    pub misses: u32,
    pub standings: Vec<StandingView>,
}

/// What a decision came to: one printing, or a choice among printings the picture cannot tell
/// apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Resolved,
    Ambiguous,
}

/// One printing an ambiguous decision offers.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ChoiceView {
    pub id: String,
    /// `None` when the corpus has no oracle for the printing.
    pub oracle_id: Option<String>,
    pub label: Option<Label>,
    /// As far as the look it came in by, on the page's 0–1 scale.
    pub distance: Option<f32>,
    /// The finishes the printing exists in, from the corpus.
    pub finishes: Vec<String>,
}

/// The card a session has decided on — present on every committed frame.
///
/// **What a tray row is made from.** The page adds one when [`Verdict::decision_seq`] changes
/// and never otherwise; this says what to add.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DecisionView {
    /// The printing: the decided look's, or the first of its choices.
    pub printing: String,
    /// `None` when the corpus has no oracle for the printing.
    pub oracle_id: Option<String>,
    pub label: Option<Label>,
    pub outcome: Outcome,
    /// Empty when `resolved`; the printings not ruled out, best first, when `ambiguous`.
    pub choices: Vec<ChoiceView>,
    /// **This decision is a second opinion on the card the last one named, not a second copy of
    /// it** — so the page replaces that row rather than adding one.
    ///
    /// True when the previous decision named the same oracle card (or the same printing when
    /// no oracle id exists) and the card never left the lens since: the reader changed a filter
    /// with one physical card on the mat throughout. The card away long enough for the
    /// agreement to forget it, or a reset, forgets the previous decision, so the same card
    /// presented again is `false` and adds. The same on every frame of one decision.
    pub replaces_previous: bool,
    /// The finishes the printing exists in, from the corpus — `nonfoil`, `foil`, `etched` — and
    /// empty when it did not say. See [`Reference::finishes_of`].
    pub finishes: Vec<String>,
}

/// What one frame came to.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Verdict {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub frame: FrameSize,
    pub decode_ms: f32,
    /// The recogniser's read of the frame — detector, embedder and search at once.
    pub read_ms: f32,
    /// Whether the recogniser is loaded at all ([`Session::has_neural`]) — "no models" and
    /// "the models are loaded but this frame held no card" are different states.
    pub matcher: bool,
    /// The card the frame votes for, in the frame's pixels.
    pub quad: Option<[(f32, f32); 4]>,
    /// The cards the detector found and the embedder read.
    pub candidates_examined: Option<usize>,
    pub r#match: Option<MatchReport>,
    pub tracked: Option<TrackedView>,
    /// Moves once per new decision, and on no other frame.
    ///
    /// **This is what makes "one add per card" a property of the session rather than of the
    /// page's timing.** A dropped frame, a re-render or a second listener cannot add a card
    /// twice, because the number did not change.
    pub decision_seq: u64,
    /// The decided card, on every committed frame. See [`DecisionView`].
    pub decision: Option<DecisionView>,
}

/// What a frame's `error` says when the scanner panicked on it (see [`Session::guarded`]).
pub const PANIC_ERROR: &str = "the scanner panicked on this frame — see the log for the assertion";
/// What a frame's `error` starts with when its JPEG could not be decoded.
pub const DECODE_ERROR_PREFIX: &str = "decode: ";
/// The widest or tallest frame the scanner decodes. A 4K camera's whole frame is 3840 px.
pub const MAX_FRAME_SIDE: u32 = 8192;
/// The most pixels a frame decodes to — 24 MP, 72 MB as RGB. With [`MAX_FRAME_SIDE`] alone a
/// grayscale 8192×8192 JPEG would decode to 64 MB and triple to 192 MB on its way to RGB, and
/// WASM linear memory never gives that back (issue #1137).
pub const MAX_FRAME_PIXELS: u64 = 24_000_000;

/// Decode one frame's bytes, **as a JPEG and within bounds**, before any pixel is allocated.
///
/// `image::load_from_memory` would take PNG and WebP too, guessed from the bytes, with nothing
/// but `image`'s 512 MiB allocation cap between a header and the decode. Every host sends a JPEG
/// — the page's `toBlob("image/jpeg")`, the capture button, the inbox's runs — so this takes
/// only that, and refuses a header past [`MAX_FRAME_SIDE`] or [`MAX_FRAME_PIXELS`] before
/// decoding it. Enforced here so no host has to remember to.
pub fn decode_frame(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    use image::ImageDecoder;
    let mut decoder =
        image::codecs::jpeg::JpegDecoder::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_FRAME_SIDE);
    limits.max_image_height = Some(MAX_FRAME_SIDE);
    limits.max_alloc = Some(MAX_FRAME_PIXELS * 3);
    decoder.set_limits(limits).map_err(|e| e.to_string())?;
    let (w, h) = decoder.dimensions();
    if u64::from(w) * u64::from(h) > MAX_FRAME_PIXELS {
        return Err(format!("a {w}×{h} frame is past the scanner's {MAX_FRAME_PIXELS} pixels"));
    }
    image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())
}

impl Verdict {
    /// The frame's `error` when it is a failure of the scanner — a panic, an undecodable JPEG,
    /// a read that failed or no models loaded — and not the ordinary "no card in this frame".
    pub fn failure(&self) -> Option<&str> {
        let e = self.error.as_deref()?;
        (e == PANIC_ERROR
            || e == NEURAL_UNAVAILABLE_ERROR
            || e.starts_with(DECODE_ERROR_PREFIX)
            || e.starts_with(NEURAL_ERROR_PREFIX))
        .then_some(e)
    }

    fn failed(
        error: String,
        frame: FrameSize,
        decode_ms: f32,
        matcher: bool,
        decision_seq: u64,
    ) -> Verdict {
        Verdict {
            ok: false,
            error: Some(error),
            frame,
            decode_ms,
            read_ms: 0.0,
            matcher,
            quad: None,
            candidates_examined: None,
            r#match: None,
            tracked: None,
            decision_seq,
            decision: None,
        }
    }
}

/// The sentence a filter gets when there are no labels to build a mask from.
const FILTERS_NEED_LABELS: &str =
    "Filters need card names, and the scanner has none loaded — it needs the card database.";

/// One scanning session: the labels, the recogniser, and what it remembers across frames. One
/// per camera.
pub struct Session {
    /// Behind an `Arc` so a frame can hold it while it writes the session's own bookkeeping.
    reference: Option<Arc<Reference>>,
    top: usize,
    /// What the filters admit — and, unless [`Session::set_tokens`] admits them, every printing
    /// but the tokens ([`Reference::mask_without_tokens`]).
    mask: Mask,
    filters: ScanFilters,
    /// Whether tokens and emblems are matched at all. `false` until [`Session::set_tokens`].
    tokens: bool,
    /// Decisions so far. Survives a reset — a page keys tray rows on it, and a number that went
    /// back to a value it had already shown would add nothing next time.
    decision_seq: u64,
    /// The last decision's oracle id, or printing id when it has no oracle, held while the card
    /// has stayed in front of the lens since — what [`DecisionView::replaces_previous`] is asked
    /// against. Cleared when the agreement forgets the card and by [`Session::reset`]; **kept**
    /// through a filter change, which is the whole point of it.
    previous_card: Option<String>,
    /// The printing the last emitted decision named, beside `previous_card` and cleared with it.
    previous_printing: Option<String>,
    /// `(decision_seq, replaces_previous)` for the decision now standing, so every frame of one
    /// decision reports the answer its first frame was given.
    standing: (u64, bool),
    /// The recogniser and what it remembers across frames, once [`Session::load_neural`] has
    /// given it its files. See `neural_mode.rs`.
    neural: neural_mode::NeuralMode,
}

/// The recogniser's frame, a child of this module so it shares the session's bookkeeping —
/// `decision_seq`, the previous decision, the filters' mask.
#[path = "neural_mode.rs"]
mod neural_mode;
pub use neural_mode::{
    CandidateReport, EvidenceReport, NEURAL_ERROR_PREFIX, NEURAL_UNAVAILABLE_ERROR,
};

impl Session {
    /// A session over `reference`'s labels, answering `top` candidates a frame (1 to 25).
    pub fn new(reference: Option<Reference>, top: usize) -> Session {
        // The tokens are left out from the first frame, not from the first filter a page sends.
        let mask = reference
            .as_ref()
            .map_or_else(Mask::all, |r| r.mask_without_tokens(&ScanFilters::default()));
        Session {
            reference: reference.map(Arc::new),
            top: top.clamp(1, 25),
            mask,
            filters: ScanFilters::default(),
            tokens: false,
            decision_seq: 0,
            previous_card: None,
            previous_printing: None,
            standing: (0, false),
            neural: neural_mode::NeuralMode::default(),
        }
    }

    /// Narrow the scan to the printings these filters admit.
    ///
    /// Empty filters always succeed and lift the mask — down to the tokens, which stay out
    /// unless [`Session::set_tokens`] admits them. Anything else needs labels to build a
    /// mask from, and has to admit at least one printing; a refusal is a sentence and keeps the
    /// filters already in force. A change forgets the card ([`Session::forget_card`]), because
    /// votes gathered against a different candidate set are votes on a different question.
    ///
    /// **The filters already in force are not a change** ([`ScanFilters::same_as`]): nothing is
    /// reset and the mask is not rebuilt. The page sends the stored filters every time the
    /// Scanner mounts, and a reset there wiped a decided card still on the mat, which then
    /// decided again and was added to the tray a second time.
    pub fn set_filters(&mut self, f: ScanFilters) -> Result<(), String> {
        if f.same_as(&self.filters) {
            self.filters = f;
            return Ok(());
        }
        let mask = self.mask_under(&f, self.tokens)?;
        self.narrow(mask);
        self.filters = f;
        Ok(())
    }

    /// Match tokens and emblems, or leave them out — **left out until this says otherwise**
    /// (issue #1323). A reader sorting a collection is not sorting its tokens, and a token that
    /// shares a card's name or art (Ornithopter, a Treasure beside the card that makes it) is one
    /// more printing for the recogniser to read the card as.
    ///
    /// The same answers [`Session::set_filters`] gives: the same setting again is no change, a
    /// change forgets the card, and a refusal (filters that admit nothing but tokens) keeps what
    /// is in force. Without labels no token is known, and leaving them out is no restriction.
    pub fn set_tokens(&mut self, admit: bool) -> Result<(), String> {
        if admit == self.tokens {
            return Ok(());
        }
        let mask = self.mask_under(&self.filters, admit)?;
        self.narrow(mask);
        self.tokens = admit;
        Ok(())
    }

    /// Whether tokens are matched — [`Session::set_tokens`].
    pub fn tokens(&self) -> bool {
        self.tokens
    }

    /// The mask these filters admit, with or without the tokens.
    fn mask_under(&self, f: &ScanFilters, tokens: bool) -> Result<Mask, String> {
        let labelled = self.reference.as_deref().filter(|r| r.label_count() > 0);
        if f.is_empty() {
            return Ok(match labelled {
                Some(r) if !tokens => r.mask_without_tokens(f),
                _ => Mask::all(),
            });
        }
        let r = labelled.ok_or_else(|| FILTERS_NEED_LABELS.to_string())?;
        let mask = if tokens { r.mask_for(f) } else { r.mask_without_tokens(f) };
        if mask.len() == Some(0) {
            return Err("No printing matches these filters.".to_string());
        }
        Ok(mask)
    }

    /// Search under `mask` from the next frame on, forgetting the card.
    fn narrow(&mut self, mask: Mask) {
        self.mask = mask;
        // The recogniser searches looks, not printings: the looks this mask admits are worked
        // out again on its next frame.
        self.neural.filters_changed();
        self.forget_card();
    }

    /// The filters in force.
    pub fn filters(&self) -> &ScanFilters {
        &self.filters
    }

    pub fn has_reference(&self) -> bool {
        self.reference.is_some()
    }

    /// Forget the card: the reader pressed reset, or moved on. So a new card can be started
    /// immediately instead of waiting for the previous one's votes to age out.
    ///
    /// Clears the previous decision a later one could replace too — a reader who pressed reset
    /// asked for the next decision to be news. Not `decision_seq`: see the field.
    pub fn reset(&mut self) {
        self.forget_card();
        self.previous_card = None;
        self.previous_printing = None;
    }

    /// What a filter change forgets: the agreement's votes and its decision — everything
    /// [`Session::reset`] does **except the previous decision**, so the card still in hand,
    /// decided again under the new filters, replaces its row rather than adding one.
    fn forget_card(&mut self) {
        self.neural.forget();
    }

    /// Whether `d` is a second opinion on the previous decision's card — see
    /// [`DecisionView::replaces_previous`]. Asked once per decision; every later frame of it
    /// repeats the first frame's answer.
    fn replaces_previous(&mut self, d: &DecisionView) -> bool {
        if self.standing.0 != self.decision_seq {
            // Tokens and art cards may have no oracle id. Their printing is still a stable
            // identity for a second opinion; keep the absent oracle absent in the public view.
            let identity = d.oracle_id.as_deref().unwrap_or(&d.printing);
            let replaces = self.previous_card.as_deref() == Some(identity);
            self.previous_card = Some(identity.to_owned());
            self.previous_printing = Some(d.printing.clone());
            self.standing = (self.decision_seq, replaces);
        }
        self.standing.1
    }

    /// One frame. **Never panics** where a panic can be caught ([`host::guard`]): a frame the
    /// image crates or the network runtime assert on answers [`PANIC_ERROR`], and the session
    /// carries on.
    pub fn frame(&mut self, jpeg: &[u8]) -> Verdict {
        self.guarded(|s| s.neural_frame(jpeg))
    }

    /// The guard itself, taking the body rather than being written inline in [`Session::frame`],
    /// so a test can drive a body that really does panic.
    fn guarded(&mut self, body: impl FnOnce(&mut Session) -> Verdict) -> Verdict {
        match host::guard(|| body(self)) {
            Ok(v) => v,
            Err(_) => Verdict::failed(
                PANIC_ERROR.into(),
                FrameSize { w: 0, h: 0 },
                0.0,
                self.has_neural(),
                self.decision_seq,
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Id;
    use image::RgbImage;

    pub(super) fn id(n: u8) -> Id {
        let mut b = [0u8; crate::ids::ID_LEN];
        b[0] = n;
        b
    }

    fn encoded(img: &RgbImage, format: image::ImageFormat) -> Vec<u8> {
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img.clone())
            .write_to(&mut std::io::Cursor::new(&mut out), format)
            .expect("encode");
        out
    }

    /// A small JPEG whose header claims `w`×`h`: the SOF0 segment's size fields rewritten, so a
    /// decoder that trusted the header would allocate for it.
    fn jpeg_claiming(w: u16, h: u16) -> Vec<u8> {
        let mut bytes = encoded(&RgbImage::new(16, 16), image::ImageFormat::Jpeg);
        let sof = bytes.windows(2).position(|m| m == [0xFF, 0xC0]).expect("a baseline JPEG has SOF0");
        bytes[sof + 5..sof + 7].copy_from_slice(&h.to_be_bytes());
        bytes[sof + 7..sof + 9].copy_from_slice(&w.to_be_bytes());
        bytes
    }

    /// A reference with three labelled printings: two of one card, one of another.
    pub(super) fn labelled() -> Reference {
        let mut r = Reference::new();
        for (n, oracle, set) in [(1u8, 10u8, "hob"), (2, 10, "ltr"), (3, 20, "hob")] {
            let label = Label {
                name: format!("Card {oracle}"),
                set: set.into(),
                number: n.to_string(),
                lang: "en".into(),
                released: "2025-01-01".into(),
            };
            r.add_label(id(n), Some(id(oracle)), label);
        }
        r
    }

    fn sets(codes: &[&str]) -> ScanFilters {
        ScanFilters { sets: codes.iter().map(|s| s.to_string()).collect(), ..Default::default() }
    }

    #[test]
    fn only_a_jpeg_within_bounds_is_decoded() {
        let jpeg = encoded(&RgbImage::new(16, 16), image::ImageFormat::Jpeg);
        assert_eq!(decode_frame(&jpeg).map(|i| i.width()).ok(), Some(16));
        let png = encoded(&RgbImage::new(16, 16), image::ImageFormat::Png);
        assert!(decode_frame(&png).is_err(), "a PNG was decoded");
        assert!(decode_frame(b"not a jpeg").is_err());
        // Refused on the header alone: past a side, and within both sides but past the pixels.
        assert!(decode_frame(&jpeg_claiming(9000, 16)).is_err(), "a 9000 px side was decoded");
        assert!(decode_frame(&jpeg_claiming(8000, 8000)).is_err(), "64 MP was decoded");
    }

    #[test]
    fn a_frame_that_panics_answers_a_sentence_and_the_session_carries_on() {
        let mut s = Session::new(None, 5);
        s.decision_seq = 3;
        let v = s.guarded(|_| panic!("an assertion deep in the image crates"));
        assert!(!v.ok);
        assert_eq!(v.failure(), Some(PANIC_ERROR));
        assert_eq!((v.frame.w, v.decision_seq), (0, 3));
        let json = serde_json::to_value(&v).expect("serialise");
        assert_eq!(json["decision_seq"], 3);
        assert!(json["decision"].is_null());
        // And the session is still usable afterwards.
        let v = s.frame(b"not a jpeg");
        assert_eq!(v.failure(), Some(NEURAL_UNAVAILABLE_ERROR));
    }

    #[test]
    fn filters_without_labels_are_a_sentence() {
        let mut s = Session::new(None, 5);
        assert_eq!(s.set_filters(sets(&["hob"])), Err(FILTERS_NEED_LABELS.to_string()));

        let mut s = Session::new(Some(Reference::new()), 5);
        assert_eq!(s.set_filters(sets(&["hob"])), Err(FILTERS_NEED_LABELS.to_string()));
        assert!(s.filters().is_empty());

        // Clearing the filters needs no names.
        assert_eq!(s.set_filters(ScanFilters::default()), Ok(()));
    }

    #[test]
    fn filters_that_match_nothing_are_a_sentence_and_keep_the_old_mask() {
        let mut s = Session::new(Some(labelled()), 5);
        assert_eq!(s.set_filters(sets(&["hob"])), Ok(()));
        assert_eq!(s.mask.len(), Some(2));
        assert_eq!(s.filters(), &sets(&["hob"]));

        assert_eq!(
            s.set_filters(sets(&["zzz"])),
            Err("No printing matches these filters.".to_string())
        );
        assert_eq!(s.mask.len(), Some(2), "a refused filter replaced the mask");
        assert_eq!(s.filters(), &sets(&["hob"]));

        assert_eq!(s.set_filters(ScanFilters::default()), Ok(()));
        assert!(s.mask.is_unrestricted());
    }

    #[test]
    fn tokens_are_left_out_from_the_first_frame_until_they_are_admitted() {
        // Issue #1323. Printing 2, the only LTR one, and printing 3 are tokens.
        let mut r = labelled();
        r.set_token(id(2), true);
        r.set_token(id(3), true);
        let mut s = Session::new(Some(r), 5);
        assert!(!s.tokens());
        assert!(
            s.mask.permits(&id(1)) && !s.mask.permits(&id(2)) && !s.mask.permits(&id(3)),
            "left out from the first frame, not from the first filter"
        );
        assert_eq!(s.set_filters(sets(&["hob"])), Ok(()));
        assert_eq!(s.mask.len(), Some(1));
        let nothing = Err("No printing matches these filters.".to_string());
        assert_eq!(s.set_filters(sets(&["ltr"])), nothing);

        assert_eq!(s.set_tokens(true), Ok(()));
        assert!(s.tokens());
        assert_eq!(s.mask.len(), Some(2));
        assert_eq!(s.set_filters(sets(&["ltr"])), Ok(()));

        // Leaving them out under filters that admit nothing else is refused, and keeps what is in
        // force.
        assert_eq!(s.set_tokens(false), nothing);
        assert!(s.tokens() && s.mask.permits(&id(2)));
        assert_eq!(s.set_filters(ScanFilters::default()), Ok(()));
        assert!(s.mask.is_unrestricted());
        assert_eq!(s.set_tokens(false), Ok(()));
        assert_eq!((s.mask.len(), s.mask.excluded()), (None, 2));

        // With no labels no token is known, and leaving them out restricts nothing.
        let mut bare = Session::new(None, 5);
        assert!(bare.mask.is_unrestricted());
        assert_eq!(bare.set_tokens(true), Ok(()));
        assert_eq!(bare.set_tokens(false), Ok(()));
        assert!(bare.mask.is_unrestricted());
    }
}
