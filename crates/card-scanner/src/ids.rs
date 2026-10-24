//! A printing's id, raw and as text, and the mask the filters narrow a scan to.
//!
//! **Raw ids, 16 bytes**, where the hyphenated text is 36 characters: the labels hold some
//! 118,000 of them, and the gallery names its printings the same way (`card_neural::gallery`).

use std::collections::HashSet;

/// A Scryfall id, raw.
pub const ID_LEN: usize = 16;

/// A Scryfall id, raw.
pub type Id = [u8; ID_LEN];

/// Render a raw 16-byte id as the hyphenated form Scryfall uses, so a verdict's id can be
/// pasted straight into a URL or a SQL query.
pub fn format_uuid(id: &Id) -> String {
    let h: String = id.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// Parse the hyphenated form back to raw bytes. `None` for anything that is not a UUID.
///
/// Reads hex digits rather than slicing the string, so a multi-byte character (which would put
/// a slice boundary inside it and panic — a trap in WASM) or a `+` sign (which `from_str_radix`
/// accepts) is a plain `None`.
pub fn parse_uuid(s: &str) -> Option<Id> {
    let mut digits = s.chars().filter(|c| *c != '-').map(|c| c.to_digit(16));
    let mut out = [0u8; ID_LEN];
    for byte in &mut out {
        let hi = digits.next()??;
        let lo = digits.next()??;
        *byte = (hi << 4 | lo) as u8;
    }
    digits.next().is_none().then_some(out)
}

/// Restrict a scan to a set of printings.
///
/// **Applied during the search, never to its results.** The gallery admits the looks the mask
/// leaves a printing of (`card_neural::Gallery::admit`), so an excluded printing never occupies
/// a place a permitted one should have had — the difference between "only cards matching the
/// filters are valid for matching" and "the filters hide some of the answers".
///
/// **Two shapes: the few it admits, or the few it leaves out.** A filter names a narrow set and is
/// [`Mask::allow_only`]; the tokens a session leaves out by default are some 17 000 of 118 000
/// printings, and [`Mask::all_but`] holds those rather than the hundred thousand it admits — a
/// smaller set to build on every filter change and to look each row up in.
#[derive(Debug, Clone, Default)]
pub struct Mask {
    allowed: Option<HashSet<Id>>,
    /// Left out even when `allowed` is `None`. Empty for every mask but [`Mask::all_but`]'s.
    denied: HashSet<Id>,
}

impl Mask {
    /// No restriction.
    pub fn all() -> Self {
        Mask::default()
    }
    pub fn allow_only(ids: impl IntoIterator<Item = Id>) -> Self {
        Mask { allowed: Some(ids.into_iter().collect()), denied: HashSet::new() }
    }
    /// Every id but these. None at all is [`Mask::all`], and keeps the unrestricted fast path.
    pub fn all_but(ids: impl IntoIterator<Item = Id>) -> Self {
        Mask { allowed: None, denied: ids.into_iter().collect() }
    }
    pub fn permits(&self, id: &Id) -> bool {
        self.allowed.as_ref().is_none_or(|s| s.contains(id))
            && (self.denied.is_empty() || !self.denied.contains(id))
    }
    pub fn is_unrestricted(&self) -> bool {
        self.allowed.is_none() && self.denied.is_empty()
    }
    /// How many ids the mask admits, or `None` when it is not a list of them — unrestricted, or
    /// [`Mask::all_but`] a list.
    pub fn len(&self) -> Option<usize> {
        self.allowed.as_ref().map(|s| s.len())
    }
    /// How many ids [`Mask::all_but`] left out; 0 for any other mask.
    pub fn excluded(&self) -> usize {
        self.denied.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> Id {
        let mut raw = [0u8; ID_LEN];
        raw[15] = n;
        raw
    }

    #[test]
    fn a_mask_admits_only_what_it_names() {
        let mask = Mask::allow_only([id(1), id(2)]);
        assert!(mask.permits(&id(1)) && mask.permits(&id(2)) && !mask.permits(&id(3)));
        assert!(!mask.is_unrestricted());
        assert_eq!((mask.len(), mask.excluded()), (Some(2), 0));
        assert!(Mask::all().permits(&id(9)) && Mask::all().is_unrestricted());
    }

    #[test]
    fn a_mask_of_what_it_leaves_out_excludes_those_and_admits_the_rest() {
        let mask = Mask::all_but([id(7)]);
        assert!(!mask.is_unrestricted() && !mask.permits(&id(7)) && mask.permits(&id(8)));
        assert_eq!((mask.len(), mask.excluded()), (None, 1));
        // Leaving nothing out is no restriction at all.
        assert!(Mask::all_but([]).is_unrestricted());
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
        assert_eq!(parse_uuid(&text[..text.len() - 1]), None);
        assert_eq!(parse_uuid(&format!("{text}0")), None);
    }

    #[test]
    fn uuid_parse_rejects_non_hex_without_panicking() {
        // 32 bytes once the hyphens go, but `é` is two of them: a byte slice at 28..30 used to
        // cut through it and panic.
        let multibyte = format!("{}é0", "0".repeat(29));
        assert_eq!(multibyte.len(), 32);
        assert_eq!(parse_uuid(&multibyte), None);
        assert_eq!(parse_uuid(&"é".repeat(16)), None);
        // `from_str_radix` takes a leading sign; a UUID does not.
        assert_eq!(parse_uuid(&"+f".repeat(16)), None);
    }
}
