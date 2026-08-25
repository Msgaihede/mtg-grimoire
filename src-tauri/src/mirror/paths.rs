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

use crate::transfer::Format;
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

/// The file this mirror writes for one entity in one format.
///
/// `Azula` in [`Format::Archidekt`] is `Azula.archidekt.txt`. **The entity's name is the
/// stem, never the format's** — a file dragged out of its folder still says what it is,
/// which `archidekt.txt` would not. Five of the seven carry their [`Format::key`] as a second
/// segment; [`Format::Plain`] and [`Format::Csv`] are bare, because plain text is what a
/// decklist is by default and `.csv` already distinguishes itself.
///
/// This is the **only** spelling of that rule, and [`is_ours`] is built from it rather than
/// from a second list of five words: what the pruner claims is by construction what the
/// writer writes, so the two cannot drift.
pub fn file_name(entity: &str, format: Format) -> String {
    match format {
        Format::Plain | Format::Csv => format!("{entity}.{}", format.extension()),
        _ => format!("{entity}.{}.{}", format.key(), format.extension()),
    }
}

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
    //
    // The stem is trimmed again before it is compared. Win32 ignores a stem's trailing
    // spaces and dots when it resolves a device, so `CON .txt` opens the console exactly as
    // `CON.txt` does — and the whole-name trim above cannot see that space, because the name
    // does not end in it. Trimming only for the comparison would leave `CON _.txt`; the
    // trimmed stem is used for the output too, because the space it drops is one Win32 was
    // never going to honour.
    let stem_len = trimmed.find('.').unwrap_or(trimmed.len());
    let stem = trimmed[..stem_len].trim_end_matches(TRAILING);
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
/// True only for one of the seven names [`file_name`] would have produced for `dir_name`.
///
/// **This is the entire fence between a prune and a reader's own files**, and the mirror root
/// is user-choosable: it may be a synced folder, a Dropbox, or a stick with a decade of
/// somebody's notes on it. So the fence is *narrow* rather than crude. `budget.csv` dropped
/// into `Collection/` survives, because `Collection/` is only ever going to hold
/// `Collection.csv`; `Azula.archidekt.txt` survives in `Katara/`, because it is not a file
/// this app would have put there. Every file the mirror writes is named after the entity
/// whose directory it sits in, which is what makes the containing directory enough to decide.
///
/// **Callers pass files only. Never ask this about a directory.** A deck the reader named
/// `Azula.csv` is a *directory* called `Azula.csv`, and inside a parent directory called
/// `Azula` this predicate would say yes and a caller that trusted it would delete the deck.
/// A directory is removed by the pass's "now empty and unplanned" rule and by nothing else.
///
/// The comparison ignores ASCII case because Windows does: a file this app created as
/// `Azula.txt` can be enumerated as `AZULA.TXT` after a reader renames its casing, and it is
/// still the same file. Refusing to claim it would leave an orphan nothing could ever clean.
///
/// The cost of the narrow fence, stated plainly: a stale file whose entity was renamed while
/// the app was closed is no longer claimed by name and lingers until the reader deletes the
/// root. `README.txt` says the whole root is generated and safe to delete, which is the
/// remedy the spec chose over deleting a reader's own files.
pub fn is_ours(file_name: &str, dir_name: &str) -> bool {
    Format::ALL
        .iter()
        .any(|&f| file_name.eq_ignore_ascii_case(&self::file_name(dir_name, f)))
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
    fn pruning_claims_the_seven_files_this_app_writes_for_that_directory() {
        assert!(is_ours("Azula.archidekt.txt", "Azula"));
        assert!(is_ours("Collection.csv", "Collection"));
        assert!(!is_ours("my notes.md", "Collection"));
        assert!(!is_ours("Azula.png", "Azula"));
        assert!(!is_ours("README", "Azula"));
    }

    #[test]
    fn a_readers_own_file_survives_a_prune_because_the_stem_is_not_the_directorys() {
        // The defect this predicate was rewritten for: the mirror root is user-choosable, so
        // `budget.csv` can be a decade of somebody's spreadsheet and the pass must not touch
        // it. `Collection/` only ever holds files stemmed `Collection`.
        assert!(!is_ours("budget.csv", "Collection"));
        assert!(!is_ours("my notes.txt", "Collection"));
        assert!(!is_ours("shopping list.txt", "Wishlist"));
        assert!(is_ours("Collection.csv", "Collection"), "ours still is");
    }

    #[test]
    fn a_mirror_file_is_not_ours_in_somebody_elses_directory() {
        // A deck's file dragged one folder over, or left behind by a rename. It is not a file
        // this app would have written *here*, so the pass leaves it for the reader.
        assert!(is_ours("Azula.archidekt.txt", "Azula"));
        assert!(!is_ours("Azula.archidekt.txt", "Katara"));
        assert!(!is_ours("Azula.txt", "Katara"));
    }

    #[test]
    fn every_one_of_the_seven_files_the_writer_plans_is_claimed_and_nothing_else_is() {
        for format in Format::ALL {
            let written = file_name("Azula", format);
            assert!(
                is_ours(&written, "Azula"),
                "the pruner must claim what the writer wrote: {written}"
            );
            assert!(
                !is_ours(&written, "Azula (2)"),
                "but only in the directory it belongs to: {written}"
            );
        }
        // The five that need their key, and the two that do not.
        assert_eq!(file_name("Azula", Format::Plain), "Azula.txt");
        assert_eq!(file_name("Azula", Format::Csv), "Azula.csv");
        assert_eq!(file_name("Azula", Format::Mtgo), "Azula.mtgo.txt");
        assert_eq!(file_name("Azula", Format::Arena), "Azula.arena.txt");
        assert_eq!(file_name("Azula", Format::Moxfield), "Azula.moxfield.txt");
        assert_eq!(file_name("Azula", Format::Archidekt), "Azula.archidekt.txt");
        assert_eq!(file_name("Azula", Format::Tcgplayer), "Azula.tcgplayer.txt");
    }

    #[test]
    fn a_near_miss_on_the_format_segment_is_not_ours() {
        assert!(!is_ours("Azula.mtga.txt", "Azula"), "not a format key");
        assert!(!is_ours("Azula.plain.txt", "Azula"), "plain carries no key");
        assert!(!is_ours("Azula.csv.txt", "Azula"));
        assert!(!is_ours("Azula.archidekt.csv", "Azula"));
        assert!(!is_ours("Azula.archidekt.txt.bak", "Azula"));
    }

    #[test]
    fn a_device_name_keeps_its_extension_because_the_stem_is_what_is_reserved() {
        // `CON.txt` is refused by Windows exactly as `CON` is, so the `_` has to land on the
        // stem. Appending it to the whole name would produce `CON.txt_`, whose stem is still
        // `CON`, and the deck would be un-mirrorable.
        assert_eq!(sanitise("CON.txt"), "CON_.txt");
        assert_eq!(sanitise("nul.dek"), "nul_.dek");
        // Win32 ignores a stem's trailing spaces and dots when it resolves a device, so this
        // one opens the console too. The trim has to run on the stem, not just on the name.
        assert_eq!(sanitise("CON .txt"), "CON_.txt");
        assert_eq!(sanitise("com1 . dek"), "com1_. dek");
        assert_eq!(sanitise("PRN  "), "PRN_");
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
    fn pruning_ignores_ascii_case_because_windows_does() {
        // A reader who renames `Azula.txt` to `AZULA.TXT` has renamed nothing on NTFS. If the
        // pruner stopped claiming it, it could never be cleaned up.
        assert!(is_ours("Collection.CSV", "Collection"));
        assert!(is_ours("AZULA.TXT", "Azula"));
        assert!(is_ours("azula.ARCHIDEKT.txt", "AZULA"));
        assert!(!is_ours("BUDGET.CSV", "Collection"), "still not ours");
    }

    #[test]
    fn a_two_hundred_character_name_is_not_truncated() {
        // Deliberate: nothing here knows the length of the mirror root, so a cap applied
        // at this layer could not be the one that matters.
        let long = "a".repeat(200);
        assert_eq!(sanitise(&long).chars().count(), 200);
    }
}
