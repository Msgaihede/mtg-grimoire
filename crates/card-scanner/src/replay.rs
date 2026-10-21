//! A reader's scan, as the scan inbox stores it, and how a replay of one is scored.
//!
//! The inbox (`infrastructure/scan-worker/`) keeps a run of five to twenty JPEGs end to end
//! and a label beside it. This module reads the label, cuts the run by it, and says how a
//! decision compares with the printing the reader named. It builds no session and reads no
//! file: `bin/replay` does both, and everything here is tested under any feature set.

use crate::filters::ScanFilters;
use crate::session::ScanMode;
use serde::{Deserialize, Serialize};

/// The label shape this reads. The inbox writes `"v": 1`.
pub const LABEL_VERSION: u32 = 1;
/// A JPEG's first three bytes — what the inbox holds each frame's start to.
const JPEG_MAGIC: [u8; 3] = [0xFF, 0xD8, 0xFF];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScanLabel {
    pub v: u32,
    pub id: String,
    pub received_at: String,
    pub bytes: u64,
    pub card: LabelCard,
    pub finish: String,
    pub scanner: LabelScanner,
    pub app: LabelApp,
    pub run: Vec<LabelFrame>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelCard {
    pub id: String,
    pub set: String,
    pub number: String,
    pub lang: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelScanner {
    pub reported: Option<String>,
    pub mode: ScanMode,
    pub confidence: Option<f32>,
    pub distance: Option<f32>,
    pub bundle: Option<u64>,
    pub filters: LabelFilters,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelFilters {
    pub sets: Vec<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

impl LabelFilters {
    /// The filters a session takes. A replay without them is another scan.
    pub fn scan_filters(&self) -> ScanFilters {
        ScanFilters {
            sets: self.sets.clone(),
            released_from: self.from.clone(),
            released_to: self.to.clone(),
            // A label does not carry the promo toggle (the scan inbox keeps what it checks,
            // and it checks no such field), so a replay admits promos.
            exclude_promos: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelApp {
    pub version: String,
    pub platform: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelFrame {
    pub ms: i64,
    pub bytes: usize,
    pub width: u32,
    pub height: u32,
    pub ok: bool,
    pub lock: Option<String>,
    pub confidence: Option<f32>,
    pub distance: Option<f32>,
    pub decided: Option<String>,
    pub detail: bool,
}

/// A label as the inbox stored it. A version this does not read is refused by number.
pub fn parse_label(text: &str) -> Result<ScanLabel, String> {
    let label: ScanLabel = serde_json::from_str(text).map_err(|e| format!("label: {e}"))?;
    if label.v != LABEL_VERSION {
        return Err(format!("label version {} is not {LABEL_VERSION}", label.v));
    }
    if label.run.is_empty() {
        return Err("label lists no frames".to_string());
    }
    Ok(label)
}

/// The run cut back into its frames, oldest first. The label is the run's only index, so a
/// run that is not as long as its frames together, or does not start as a JPEG does at one
/// of them, is refused whole — a replay around a hole is not the scan.
pub fn cut<'a>(label: &ScanLabel, run: &'a [u8]) -> Result<Vec<&'a [u8]>, String> {
    // Checked: a label is a file from outside, and a sum that wraps could match a short run.
    let total = label.run.iter().try_fold(0usize, |sum, f| sum.checked_add(f.bytes));
    if total != Some(run.len()) {
        return Err(match total {
            Some(total) => format!(
                "the label's frames add up to {total} bytes and the run is {}",
                run.len()
            ),
            None => format!(
                "the label's frames add up to more bytes than a run can hold and the run is {}",
                run.len()
            ),
        });
    }
    let mut at = 0;
    let mut frames = Vec::with_capacity(label.run.len());
    for (n, frame) in label.run.iter().enumerate() {
        let bytes = &run[at..at + frame.bytes];
        if !bytes.starts_with(&JPEG_MAGIC) {
            return Err(format!("frame {n} does not start as a JPEG does"));
        }
        frames.push(bytes);
        at += frame.bytes;
    }
    Ok(frames)
}

/// How a decision compares with the printing the reader named.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Score {
    /// The printing the reader named.
    Printing,
    /// Another printing of the same card.
    Card,
    /// Another card.
    Wrong,
    /// No decision by the last frame.
    Undecided,
    /// The run could not be replayed; left out of every percentage.
    Error,
}

/// `got` is the printing decided on, `None` for none. The oracle ids say whether two
/// printings are one card; with either missing, only the same printing is the same card.
pub fn score(
    truth: &str,
    truth_oracle: Option<&str>,
    got: Option<&str>,
    got_oracle: Option<&str>,
) -> Score {
    let Some(got) = got else { return Score::Undecided };
    if got.eq_ignore_ascii_case(truth) {
        return Score::Printing;
    }
    match (truth_oracle, got_oracle) {
        (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => Score::Card,
        _ => Score::Wrong,
    }
}

/// What a decision settled, for the two numbers the Neural printing work is read on: the
/// floor (how often a *resolved* decision names another printing of the card) and the bar
/// (how often it names the reader's).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Settled {
    /// Resolved, on the printing the reader named.
    RightPrinting,
    /// Resolved, on another printing of the reader's card.
    WrongPrinting,
    /// The decision offered several printings to pick from. Whatever it listed first is a
    /// guess, not a settled printing, so it is neither right nor wrong here.
    Ambiguous,
    /// Another card decided on, no decision, or a run that could not be replayed.
    Other,
}

/// `ambiguous` is whether the decision was offered as a choice. It outranks the score of a
/// decision that was made: a right first choice among three is not a resolved right printing,
/// and counting it as one would hide how often the scanner can only guess. Every ambiguous
/// decision lands here, whatever its first choice scored, so the count of them is the one the
/// replay has always printed as `ambiguous`.
pub fn settled(score: Score, ambiguous: bool) -> Settled {
    match (score, ambiguous) {
        (Score::Printing | Score::Card | Score::Wrong, true) => Settled::Ambiguous,
        (Score::Printing, false) => Settled::RightPrinting,
        (Score::Card, false) => Settled::WrongPrinting,
        _ => Settled::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The inbox README's own example, cut to two frames.
    fn label_text(first: usize, second: usize) -> String {
        format!(
            r#"{{"v":1,"card":{{"id":"aaaaaaaa-0000-0000-0000-000000000001","set":"2x2",
            "number":"117","lang":"en","name":"Lightning Bolt"}},"finish":"foil",
            "scanner":{{"reported":null,"mode":"fast","confidence":0.82,"distance":31,
            "bundle":98000,"filters":{{"sets":["2x2","lea"],"from":null,"to":"2022-07-08"}}}},
            "app":{{"version":"0.43.0","platform":"desktop"}},
            "run":[{{"ms":-110,"bytes":{first},"width":960,"height":540,"ok":true,
            "lock":"acquiring","confidence":null,"distance":44,"decided":null,"detail":false}},
            {{"ms":0,"bytes":{second},"width":960,"height":540,"ok":true,"lock":"locked",
            "confidence":0.82,"distance":31,"decided":null,"detail":true}}],
            "id":"20261011T101500Z-9f8a0c1d2e3f4a5b","received_at":"2026-10-11T10:15:00.123Z",
            "bytes":{}}}"#,
            first + second
        )
    }

    fn jpeg(len: usize, fill: u8) -> Vec<u8> {
        let mut bytes = vec![fill; len];
        bytes[..3].copy_from_slice(&JPEG_MAGIC);
        bytes
    }

    #[test]
    fn reads_the_inboxes_label_nulls_and_whole_numbers_included() {
        let label = parse_label(&label_text(5, 7)).expect("parses");
        assert_eq!(label.card.name, "Lightning Bolt");
        assert_eq!(label.scanner.mode, ScanMode::Fast);
        assert_eq!(label.scanner.reported, None);
        assert_eq!(label.scanner.distance, Some(31.0));
        assert_eq!(label.run[0].confidence, None);
        assert!(label.run[1].detail);
        let filters = label.scanner.filters.scan_filters();
        assert_eq!(filters.sets, vec!["2x2", "lea"]);
        assert_eq!(filters.released_to.as_deref(), Some("2022-07-08"));
    }

    #[test]
    fn refuses_another_version_and_an_empty_run() {
        let other = label_text(5, 7).replace(r#""v":1"#, r#""v":2"#);
        assert!(parse_label(&other).unwrap_err().contains("version 2"));
        assert!(parse_label("{").unwrap_err().starts_with("label:"));
        let empty = label_text(5, 7);
        let start = empty.find(r#""run":["#).unwrap();
        let end = start + empty[start..].find(r#"],"#).unwrap() + 1;
        let empty = format!(r#"{}"run":[]{}"#,&empty[..start], &empty[end..]);
        assert_eq!(parse_label(&empty).unwrap_err(), "label lists no frames");
    }

    #[test]
    fn a_label_whose_frames_overflow_is_refused_not_a_panic() {
        let mut label = parse_label(&label_text(5, 7)).unwrap();
        label.run[0].bytes = usize::MAX;
        label.run[1].bytes = 12;
        let err = cut(&label, &[0xFF, 0xD8, 0xFF]).unwrap_err();
        assert!(err.contains("add up"), "{err}");
    }

    #[test]
    fn cuts_a_run_where_the_label_says() {
        let label = parse_label(&label_text(5, 7)).unwrap();
        let run = [jpeg(5, 1), jpeg(7, 2)].concat();
        let frames = cut(&label, &run).expect("cuts");
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], &jpeg(5, 1)[..]);
        assert_eq!(frames[1], &jpeg(7, 2)[..]);
    }

    #[test]
    fn refuses_a_run_cut_short_and_a_frame_that_is_not_a_jpeg() {
        let label = parse_label(&label_text(5, 7)).unwrap();
        let short = [jpeg(5, 1), jpeg(6, 2)].concat();
        assert!(cut(&label, &short).unwrap_err().contains("12 bytes and the run is 11"));
        let mut holed = [jpeg(5, 1), jpeg(7, 2)].concat();
        holed[5] = 0;
        assert_eq!(cut(&label, &holed).unwrap_err(), "frame 1 does not start as a JPEG does");
    }

    #[test]
    fn scores_a_decision_against_the_readers_printing() {
        assert_eq!(score("p1", Some("o1"), None, None), Score::Undecided);
        assert_eq!(score("p1", Some("o1"), Some("P1"), Some("o1")), Score::Printing);
        assert_eq!(score("p1", Some("o1"), Some("p2"), Some("o1")), Score::Card);
        assert_eq!(score("p1", Some("o1"), Some("p3"), Some("o9")), Score::Wrong);
    }

    #[test]
    fn a_resolved_decision_settles_right_or_wrong_and_an_ambiguous_one_never_does() {
        assert_eq!(settled(Score::Printing, false), Settled::RightPrinting);
        assert_eq!(settled(Score::Card, false), Settled::WrongPrinting);
        assert_eq!(
            settled(Score::Printing, true),
            Settled::Ambiguous,
            "a right first choice is not a settled printing"
        );
        assert_eq!(settled(Score::Card, true), Settled::Ambiguous);
        assert_eq!(
            settled(Score::Wrong, true),
            Settled::Ambiguous,
            "an ambiguous decision is counted as one whatever its first choice scored"
        );
        assert_eq!(settled(Score::Wrong, false), Settled::Other);
        assert_eq!(settled(Score::Undecided, false), Settled::Other);
    }

    /// A scan of a printing newer than the local card data: no oracle on one side. Only the
    /// same printing can be right, and nothing panics.
    #[test]
    fn scores_without_an_oracle_on_printing_alone() {
        assert_eq!(score("p1", None, Some("p1"), Some("o1")), Score::Printing);
        assert_eq!(score("p1", None, Some("p2"), Some("o1")), Score::Wrong);
        assert_eq!(score("p1", Some("o1"), Some("p2"), None), Score::Wrong);
    }
}
