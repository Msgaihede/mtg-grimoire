//! What a reader can narrow a scan to: sets, and a release-date range. Nothing else.
//!
//! **Language is deliberately absent**, not merely unimplemented — see the design's decision 7
//! (`docs/superpowers/specs/2026-09-15-scanner-modes-and-shipping-design.md` §3). The bundle
//! holds one printing per card, English wherever English exists, so a language filter would
//! bite only on printings that exist in no other language.
//!
//! A filter becomes an [`crate::index::Mask`] through [`crate::reference::Reference::mask_for`],
//! and **that mask constrains every tier** — the hash search, the name lookup and the collector
//! lookup alike. A filter that only hid some answers from one tier would let another tier hand
//! them straight back.

use crate::reference::Label;

/// The reader's narrowing. Every field is optional in JSON, and `{}` is no filter at all.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ScanFilters {
    /// Set codes, compared case-insensitively. Empty admits every set.
    pub sets: Vec<String>,
    /// `YYYY-MM-DD`, inclusive.
    pub released_from: Option<String>,
    /// `YYYY-MM-DD`, inclusive.
    pub released_to: Option<String>,
}

impl ScanFilters {
    /// No restriction at all — the unfiltered search keeps its fast path.
    ///
    /// **A blank string counts as absent.** An HTML date input that has been cleared reports
    /// `""`, not nothing, and a bound of `""` would otherwise be a real bound: every date is
    /// `>= ""` and none is `<= ""`, so a cleared "to" field would match no printing at all and
    /// read as "No printing matches these filters".
    pub fn is_empty(&self) -> bool {
        self.set_codes().next().is_none()
            && bound(&self.released_from).is_none()
            && bound(&self.released_to).is_none()
    }

    /// Does this printing pass? Dates compare lexicographically, which is chronological for
    /// `YYYY-MM-DD`. A printing with no release date fails any date bound — it cannot be shown
    /// to lie inside the range.
    pub fn permits(&self, label: &Label) -> bool {
        let mut sets = self.set_codes().peekable();
        if sets.peek().is_some() && !sets.any(|s| s.eq_ignore_ascii_case(&label.set)) {
            return false;
        }
        let released = label.released.as_str();
        if let Some(from) = bound(&self.released_from) {
            if released.is_empty() || released < from {
                return false;
            }
        }
        if let Some(to) = bound(&self.released_to) {
            if released.is_empty() || released > to {
                return false;
            }
        }
        true
    }

    fn set_codes(&self) -> impl Iterator<Item = &str> {
        self.sets.iter().map(|s| s.trim()).filter(|s| !s.is_empty())
    }
}

fn bound(b: &Option<String>) -> Option<&str> {
    b.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(set: &str, released: &str) -> Label {
        Label {
            name: "Forest".into(),
            set: set.into(),
            number: "1".into(),
            lang: "en".into(),
            released: released.into(),
        }
    }

    #[test]
    fn an_empty_object_is_no_filter() {
        let f: ScanFilters = serde_json::from_str("{}").expect("parse");
        assert_eq!(f, ScanFilters::default());
        assert!(f.is_empty());
        let f: ScanFilters =
            serde_json::from_str(r#"{"sets":["hob"],"released_to":"2025-01-01"}"#).expect("parse");
        assert!(!f.is_empty());
        assert_eq!(f.released_from, None);
    }

    #[test]
    fn a_cleared_field_is_no_bound() {
        // What a cleared date input and an emptied sets field send. Taken as bounds, the "to"
        // alone would admit nothing.
        let f = ScanFilters {
            sets: vec![" ".into()],
            released_from: Some(String::new()),
            released_to: Some(String::new()),
        };
        assert!(f.is_empty());
        assert!(f.permits(&label("ltr", "2023-06-23")));
    }

    #[test]
    fn a_printing_with_no_date_fails_a_date_bound_but_not_a_set() {
        let undated = label("hob", "");
        let by_set = ScanFilters {
            sets: vec!["HOB".into()],
            ..Default::default()
        };
        assert!(by_set.permits(&undated));
        let by_date = ScanFilters {
            released_to: Some("2030-01-01".into()),
            ..Default::default()
        };
        assert!(!by_date.permits(&undated));
    }
}
