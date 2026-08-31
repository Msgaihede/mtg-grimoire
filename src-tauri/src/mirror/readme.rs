//! What the backup says about itself — the one fixed name the mirror writes into a folder the
//! reader chose, and the one the zip snapshot puts at the top of the archive.
//!
//! **Two READMEs, one middle, and the split is not tidiness.** The mirror's folder is
//! continuously rewritten and the zip is a snapshot taken once; a file telling a reader that
//! "MTG Grimoire rewrites it whenever something changes" inside an archive nothing will ever
//! touch again is a lie about the only thing the file exists to explain. What the *card files*
//! say is identical in both — the seven formats, and the two omissions §3.1 names — so that
//! paragraph is written once, as a macro, and pasted into both by [`concat!`].
//!
//! A `macro_rules!` rather than two `pub const`s and a runtime join, because both of these are
//! `&'static str` compared byte-for-byte (`run::holds_our_readme`) and `concat!` is the only
//! thing that can build one out of pieces at compile time.
//!
//! **This module is on the every-target side of `lib.rs`'s map**, which is the whole reason it
//! is a module rather than four constants at the top of `run.rs`: the zip is built in the
//! browser too, and `run.rs` — the only module here that touches a filesystem — is not.

/// The one file in the root that is not an export.
pub const README_NAME: &str = "README.txt";

/// What both files say about the seven formats and the two things they cannot say.
///
/// Spec §3.1's two omissions live here, and neither is a field the backup could have switched
/// on: MTGO and Arena have no maybeboard, and Arena's row filter is left off so `*.arena.txt`
/// is a complete record rather than a file Arena would accept.
macro_rules! formats_and_omissions {
    () => {
        "\
Every deck, folder and list is written in all seven formats:

    <name>.txt              plain text
    <name>.mtgo.txt         MTGO
    <name>.arena.txt        MTG Arena
    <name>.moxfield.txt     Moxfield
    <name>.archidekt.txt    Archidekt
    <name>.tcgplayer.txt    TCGplayer
    <name>.csv              spreadsheet - every field the list has

Every optional column is switched on. Two things these files still cannot say,
because the formats themselves have no room for them:

  * MTGO and Arena have no maybeboard. *.mtgo.txt and *.arena.txt leave out any
    pile you have switched off. Those cards are not lost - they are in the other
    five files, and every one of them is in the .csv.

  * *.arena.txt lists every card. For a paper collection that makes it a
    complete record and NOT a valid Arena import, because Arena rejects cards it
    does not have. If you want a list Arena will accept, use Export in the app,
    where that filter is a checkbox.
"
    };
}

/// What the mirror's folder says about itself.
///
/// Spec §3.1 and §3.2 fix what has to be in here: what the folder is, that it is generated and
/// rewritten, that edits are overwritten, that the app never reads it back, the two omissions
/// §3.1 names, and that deleting the whole root is safe. `run::MANIFEST_NAME` is explained for
/// the same reason: it is a file the reader did not make and will wonder about, and what
/// deleting it costs is exactly one pass's worth of leftovers rather than anything they cannot
/// get back.
pub const README: &str = concat!(
    "\
MTG Grimoire - plain-text backup
================================

This folder holds your decks, your collection and your wishlist as plain text
files. You can open them in Notepad, print them, mail them to yourself, or read
them into any other program. It exists for the day this app will not start: the
cards are still yours, in every format the app can write, in a folder you chose.

It is generated. MTG Grimoire rewrites it whenever something changes, and it
only touches the files whose contents actually differ. Anything you type into a
file in here - including this README - is overwritten by the next pass.

This folder is never read back. The database is the only source of truth and the
backup is a one-way copy, so editing a file in here changes nothing in the app.

",
    formats_and_omissions!(),
    "
About .mirror-manifest: it is a plain list of the files this backup last wrote,
and it is how the app knows which of its own files to tidy up after you rename
or delete a deck. It never names anything of yours. Deleting it is safe; the
only cost is that the files the app was about to tidy up stay behind for good,
because after that it no longer knows they were its.

Deleting this whole folder is safe too. Nothing in the app depends on it, and
the next pass builds it again from the database.
"
);

/// What the zip snapshot says about itself.
///
/// **Three things differ from [`README`] and each one is a fact about this archive that is not
/// true of the folder.** It was taken once, at a moment; nothing will update it; and there is
/// no `.mirror-manifest` in it, because that file exists to authorise *deleting* and a zip
/// deletes nothing. Shipping the folder's README inside an archive it does not describe would
/// be wrong about the only thing the file is for.
pub const SNAPSHOT_README: &str = concat!(
    "\
MTG Grimoire - plain-text backup
================================

This archive holds your decks, your collection and your wishlist as plain text
files, exactly as they were at the moment you asked for it. You can open them in
any text editor, print them, mail them to yourself, or read them into any other
program. It exists for the day this app will not start: the cards are still
yours, in every format the app can write.

It is a snapshot rather than a folder that keeps itself up to date. Nothing will
ever write to it again, and the app never reads it back - the database is the
only source of truth. Ask for another one whenever you want a fresher copy.

",
    formats_and_omissions!()
);

#[cfg(test)]
mod tests {
    use super::*;

    /// The paragraph that is genuinely shared is genuinely shared — a format added to one file
    /// and not the other is the drift the macro exists to make impossible, and this is what
    /// says so out loud rather than leaving it to whoever reads the `concat!`.
    #[test]
    fn both_readmes_carry_the_same_seven_formats_and_the_same_two_omissions() {
        let shared = formats_and_omissions!();
        assert!(README.contains(shared));
        assert!(SNAPSHOT_README.contains(shared));
    }

    /// The three sentences that must differ. A snapshot that told the reader it is kept up to
    /// date would be wrong about the only thing this file is for.
    #[test]
    fn the_snapshot_does_not_claim_to_be_kept_up_to_date() {
        let snap = SNAPSHOT_README.to_lowercase();
        assert!(snap.contains("snapshot"), "it has to say what it is");
        assert!(
            !snap.contains("rewrites it whenever something changes"),
            "the mirror's promise is not this archive's"
        );
        assert!(
            !snap.contains(".mirror-manifest"),
            "there is no manifest in a zip, so explaining one would send the reader looking"
        );
    }
}
