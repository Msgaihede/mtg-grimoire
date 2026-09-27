//! What the backup says about itself — the one fixed name the mirror writes into a folder the
//! reader chose.
//!
//! [`README`] is a `&'static str` compared byte-for-byte (`run::holds_our_readme`), so a change
//! to one character of it is a change to what the mirror recognises as its own file.

/// The one file in the root that is not an export.
pub const README_NAME: &str = "README.txt";

/// What the mirror's folder says about itself.
///
/// Spec §3.1 and §3.2 fix what has to be in here: what the folder is, that it is generated and
/// rewritten, that edits are overwritten, that the app never reads it back, the two omissions
/// §3.1 names, and that deleting the whole root is safe. `run::MANIFEST_NAME` is explained for
/// the same reason: it is a file the reader did not make and will wonder about, and what
/// deleting it costs is exactly one pass's worth of leftovers rather than anything they cannot
/// get back.
///
/// Spec §3.1's two omissions are the formats paragraph, and neither is a field the backup could
/// have switched on: MTGO and Arena have no maybeboard, and Arena's row filter is left off so
/// `*.arena.txt` is a complete record rather than a file Arena would accept.
pub const README: &str = "\
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

About .mirror-manifest: it is a plain list of the files this backup last wrote,
and it is how the app knows which of its own files to tidy up after you rename
or delete a deck. It never names anything of yours. Deleting it is safe; the
only cost is that the files the app was about to tidy up stay behind for good,
because after that it no longer knows they were its.

Deleting this whole folder is safe too. Nothing in the app depends on it, and
the next pass builds it again from the database.
";
