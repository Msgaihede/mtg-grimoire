//! Names on disk: sanitise a reader's name, disambiguate siblings, and decide what a prune
//! pass is allowed to delete.
//!
//! Deck, folder and list names come from the reader and are unconstrained — empty, all
//! punctuation, two hundred characters, or `CON`. Windows is not. Everything in this module
//! is the translation between the two, and it is the *only* place that translation happens:
//! the writer composes file names out of what [`disambiguate`] hands it and never sanitises
//! again.
//!
//! Nothing here touches the filesystem. These are pure functions over names, which is what
//! lets the whole layout be decided — and tested — before a single byte is written.

use std::collections::HashSet;

/// The nine characters Windows refuses in a path component. `/` is here as well as `\`
/// because both are separators, and a deck called `Red/Blue` must be one folder rather
/// than two.
const ILLEGAL: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// What a name that sanitises to nothing is called.
const UNTITLED: &str = "Untitled";

/// The MS-DOS device names, which Windows still reserves in every directory. Creating
/// `CON` does not fail with "invalid name" — it opens the console, which is worse.
const DEVICE_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// What Windows silently drops off the end of a path component. A folder created as
/// `Aggro.` is a folder called `Aggro`, so a mirror that did not trim it would look for a
/// folder that is not there on every pass and rebuild it on every pass.
const TRAILING: [char; 2] = ['.', ' '];

/// The two extensions this app writes. Six of the seven export formats are `.txt` and the
/// seventh is `.csv`; see `EXPORT_FORMAT_EXTENSION` on the TypeScript side.
const OUR_EXTENSIONS: [&str; 2] = [".txt", ".csv"];

/// Turn a reader's name into a single path component Windows will actually create.
///
/// [`ILLEGAL`] and every control character become `-`; trailing dots and spaces are trimmed,
/// because Windows drops them *silently* and a folder created with one is not the folder you
/// later look for; an empty result becomes [`UNTITLED`]; and a stem that is a reserved
/// [device name](DEVICE_NAMES) gets a `_`.
///
/// **Nothing else is touched.** NTFS takes Unicode, so a deck called `Æther Vial` is a
/// folder called `Æther Vial` — mangling it to ASCII would be this app deciding the reader's
/// own name for their deck was wrong.
///
/// The result is never empty, never ends in `.` or ` `, and is safe to join to a path. It is
/// **not** guaranteed unique — that is [`disambiguate`]'s job — and it is not length-capped:
/// see the note on [`disambiguate`].
pub fn sanitise(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| {
            if ILLEGAL.contains(&c) || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();

    let trimmed = replaced.trim_end_matches(TRAILING);
    if trimmed.is_empty() {
        return UNTITLED.to_string();
    }

    // A device name is reserved by its *stem*, so `CON.txt` is refused exactly as `CON` is.
    // The `_` therefore goes on the stem rather than on the end of the whole name, which is
    // the same thing for the dotless names a deck usually has and the correct thing when a
    // reader has put a dot in one. `.` is ASCII, so the byte index is a char boundary.
    let stem_len = trimmed.find('.').unwrap_or(trimmed.len());
    let stem = &trimmed[..stem_len];
    if DEVICE_NAMES.iter().any(|d| stem.eq_ignore_ascii_case(d)) {
        return format!("{stem}_{}", &trimmed[stem_len..]);
    }

    trimmed.to_string()
}

/// Assign each `(id, raw name)` pair the name it gets on disk, in the caller's order.
///
/// The caller passes siblings **already sorted by database id**, and that ordering is the
/// whole point: the first claimant of a sanitised name keeps it and the *n*th gets ` (n)`,
/// so an assignment depends only on the rows *before* it. Adding a third `Aggro` therefore
/// never renames the first two, and a reader's shortcut into that folder keeps working.
/// Ordering by iteration order instead would reshuffle the folder on every pass.
///
/// Suffixing runs **over the sanitised names**, because sanitising can create a collision
/// that did not exist in the database: `A/B` and `A-B` are two decks and one folder name.
///
/// Collisions are matched case-insensitively — `Aggro` and `aggro` are one file on NTFS, and
/// pretending otherwise would mean two rows writing over each other all the way to disk.
///
/// The `id` is not read. It is in the signature because it is what the order *means*, and a
/// caller that has to build the pairs cannot quietly pass an arbitrary sequence.
///
/// **No length cap.** A 200-character deck name stays 200 characters; nothing here knows how
/// long the mirror root is, so a cap applied here could not be the one that matters. Deep
/// trees under a long root are what the pass's own error handling is for.
pub fn disambiguate(named: &[(i64, String)]) -> Vec<String> {
    let mut taken: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(named.len());

    for (_id, raw) in named {
        let base = sanitise(raw);
        let mut candidate = base.clone();
        let mut n = 1_usize;
        // The loop, rather than a plain counter, is for the reader who has *called* a deck
        // `Aggro (2)`: the counter would hand the second `Aggro` a name already on disk.
        while !taken.insert(candidate.to_lowercase()) {
            n += 1;
            candidate = format!("{base} ({n})");
        }
        out.push(candidate);
    }

    out
}

/// The prune predicate: may a pass delete a file with this name?
///
/// True for anything ending `.txt` or `.csv`, case-insensitively. **This is the entire fence
/// between a prune and a reader's own files, and it is deliberately crude**: the mirror root
/// is user-choosable and may be a synced folder, a Dropbox, or a USB stick with a decade of
/// somebody's notes on it. Every file this app writes ends in one of these two, so the fence
/// only has to be *at least* this wide; making it narrower — matching known stems — would
/// mean a deck renamed while the app was closed left a file nothing could ever clean up.
///
/// The cost, stated plainly: a reader who keeps `shopping list.txt` in the mirror root loses
/// it. `README.txt` says the whole root is generated and safe to delete, which is the honest
/// version of that warning.
pub fn is_ours(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    OUR_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_nine_illegal_characters_and_every_control_character_become_dashes() {
        assert_eq!(sanitise("Red/Blue: Aggro?"), "Red-Blue- Aggro-");
        assert_eq!(sanitise("a\u{0}b\tc"), "a-b-c");
    }

    #[test]
    fn unicode_survives_untouched() {
        assert_eq!(sanitise("Æther Vial"), "Æther Vial");
        assert_eq!(sanitise("Théoden"), "Théoden");
    }

    #[test]
    fn a_trailing_dot_or_space_is_trimmed_because_windows_drops_it_silently() {
        assert_eq!(sanitise("Aggro."), "Aggro");
        assert_eq!(sanitise("Aggro "), "Aggro");
        assert_eq!(sanitise("Aggro. . "), "Aggro");
    }

    #[test]
    fn a_name_that_sanitises_to_nothing_becomes_untitled() {
        assert_eq!(sanitise(""), "Untitled");
        assert_eq!(sanitise("..."), "Untitled");
    }

    #[test]
    fn every_windows_device_name_gets_a_suffix_case_insensitively() {
        for name in [
            "CON", "con", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9",
        ] {
            assert_eq!(
                sanitise(name),
                format!("{name}_"),
                "{name} is a reserved device name"
            );
        }
        assert_eq!(
            sanitise("CONTROL"),
            "CONTROL",
            "only the exact names are reserved"
        );
    }

    #[test]
    fn the_first_claimant_keeps_the_name_and_the_rest_are_numbered_by_id() {
        let got = disambiguate(&[
            (1, "Aggro".into()),
            (7, "Aggro".into()),
            (9, "Aggro".into()),
        ]);
        assert_eq!(got, vec!["Aggro", "Aggro (2)", "Aggro (3)"]);
    }

    #[test]
    fn adding_a_deck_never_renames_the_ones_already_on_disk() {
        let before = disambiguate(&[(1, "Aggro".into()), (7, "Aggro".into())]);
        let after = disambiguate(&[
            (1, "Aggro".into()),
            (7, "Aggro".into()),
            (9, "Aggro".into()),
        ]);
        assert_eq!(
            after[..2],
            before[..],
            "a reader's shortcut into that folder must keep working"
        );
    }

    #[test]
    fn a_collision_that_only_sanitising_creates_is_still_disambiguated() {
        let got = disambiguate(&[(1, "A/B".into()), (2, "A-B".into())]);
        assert_eq!(got, vec!["A-B", "A-B (2)"]);
    }

    #[test]
    fn pruning_claims_only_the_two_extensions_this_app_writes() {
        assert!(is_ours("Azula.archidekt.txt"));
        assert!(is_ours("Collection.csv"));
        assert!(!is_ours("my notes.md"));
        assert!(!is_ours("Azula.png"));
        assert!(!is_ours("README"));
    }

    #[test]
    fn a_device_name_keeps_its_extension_because_the_stem_is_what_is_reserved() {
        // `CON.txt` is refused by Windows exactly as `CON` is, so the `_` has to land on the
        // stem. Appending it to the whole name would produce `CON.txt_`, whose stem is still
        // `CON`, and the deck would be un-mirrorable.
        assert_eq!(sanitise("CON.txt"), "CON_.txt");
        assert_eq!(sanitise("nul.dek"), "nul_.dek");
        assert_eq!(
            sanitise("Aggro.dek"),
            "Aggro.dek",
            "only device stems are touched"
        );
    }

    #[test]
    fn siblings_that_differ_only_in_case_still_collide_because_ntfs_says_so() {
        let got = disambiguate(&[(1, "Aggro".into()), (2, "aggro".into())]);
        assert_eq!(
            got,
            vec!["Aggro", "aggro (2)"],
            "one file on disk, so the second needs a suffix, but the reader's casing is kept"
        );
    }

    #[test]
    fn a_reader_who_named_a_deck_aggro_2_does_not_get_two_of_them() {
        let got = disambiguate(&[
            (1, "Aggro".into()),
            (2, "Aggro (2)".into()),
            (3, "Aggro".into()),
        ]);
        assert_eq!(got, vec!["Aggro", "Aggro (2)", "Aggro (3)"]);
    }

    #[test]
    fn several_unnameable_siblings_each_get_their_own_folder() {
        let got = disambiguate(&[(1, "".into()), (2, "...".into()), (3, "   ".into())]);
        assert_eq!(got, vec!["Untitled", "Untitled (2)", "Untitled (3)"]);
    }

    #[test]
    fn pruning_ignores_the_case_of_the_extension() {
        assert!(is_ours("Collection.CSV"));
        assert!(is_ours("Azula.TXT"));
    }

    #[test]
    fn a_two_hundred_character_name_is_not_truncated() {
        // Deliberate: nothing here knows the length of the mirror root, so a cap applied
        // at this layer could not be the one that matters.
        let long = "a".repeat(200);
        assert_eq!(sanitise(&long).chars().count(), 200);
    }
}
