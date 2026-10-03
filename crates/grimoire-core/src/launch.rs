//! **Opening a data folder, for a host that is not the desktop** — the light app's phase 4.
//!
//! [`crate::state`] says it plainly: a host opens the connections and [`State::new`] takes them
//! at head. The desktop does that in `src-tauri`'s `desktop::init_state`, around two things only
//! it has — the pre-27 single-file conversion (`split`) and the mirror's installation name, minted
//! before the hook goes on. A host with neither does the rest, and the rest is this: the same
//! steps in the same order, with the desktop's own sentences, so a second host does not write a
//! second copy of them.
//!
//! **What it does, in order**, each for the desktop's reason:
//!
//! 1. Replaces a corpus that will not open, or that an earlier session found damaged —
//!    [`crate::schema::replace_unreadable_corpus`], before any connection holds the file.
//! 2. Opens the write connection and brings both files to head
//!    ([`crate::schema::prepare_database`]).
//! 3. Opens the read connection, only after: a read-only handle on a file with no tables yet is
//!    a handle that can never be made useful.
//! 4. Builds the image cache over `<data>/images` and the Scryfall client, re-entering any 429
//!    lockout an earlier run earned before a single request can go out.
//!
//! **What it does not do** is build the [`State`]: the event sink and the write observers are
//! the host's, and so is the moment the hook goes on. Nor does it start anything — the facet
//! index, the image upkeep, the card sync and the feeds are each a host's to spawn, on whatever
//! runtime it has. `src-tauri` does not call this: its sequence has the conversion first and the
//! installation name in the middle, and its error sentence names two candidate folders.
//!
//! [`State`]: crate::state::State
//! [`State::new`]: crate::state::State::new

use std::path::Path;

use rusqlite::Connection;

use crate::{app_meta, db, images, schema, scryfall, sync};

/// Where the Scryfall API lives. The desktop names the same string in `desktop.rs`.
pub const SCRYFALL_API: &str = "https://api.scryfall.com";

/// The pieces [`open`] answers, ready for [`crate::state::State::new`].
pub struct Opened {
    /// The write connection, at head, with no hook on it yet.
    pub write: Connection,
    /// The read-only connection, opened after the write side migrated.
    pub read: Connection,
    pub client: scryfall::Client,
    pub images: images::Cache,
}

/// Open `data_dir` as a host with no pre-27 data and no mirror opens it — see the module doc.
///
/// Every refusal is a sentence that names the folder and, where it can, which file and why;
/// none of them tells the reader to move `user.db` aside, which would be the one file in the
/// folder nothing can rebuild.
pub fn open(data_dir: &Path) -> Result<Opened, String> {
    crate::platform::files::create_dir_all(data_dir).map_err(|e| {
        format!(
            "MTG Grimoire could not create its data folder at {}: {e}",
            data_dir.display()
        )
    })?;
    schema::replace_unreadable_corpus(data_dir);

    let write = db::open_write(data_dir).map_err(|e| folder_error(data_dir, e))?;
    schema::prepare_database(&write).map_err(|e| {
        format!(
            "MTG Grimoire could not prepare its databases in {}: {e}\n\
             If this says the collection is from a newer version, run that version of the app. \
             Otherwise the storage may be full. Do not delete {}: it holds your collection, \
             decks and wishlist and cannot be rebuilt. Copies taken before each upgrade are in \
             the {} folder beside it.",
            data_dir.display(),
            db::USER_DB,
            schema::USER_BACKUPS_DIR,
        )
    })?;
    let read = db::open_read(data_dir).map_err(|e| folder_error(data_dir, e))?;

    let images = images::Cache::new(data_dir.join("images"));
    let client = scryfall::Client::new(SCRYFALL_API.to_owned());
    if let Some(until) = app_meta::get_app_meta(&write, sync::K_SCRYFALL_PENALTY_UNTIL)
        .and_then(|v| v.parse::<u64>().ok())
    {
        client.restore_penalty(until, scryfall::unix_now());
    }

    Ok(Opened {
        write,
        read,
        client,
        images,
    })
}

fn folder_error(data_dir: &Path, e: rusqlite::Error) -> String {
    format!(
        "MTG Grimoire could not open its databases in {}: {e}",
        data_dir.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder that does not exist yet is the first launch on every new install: it is made,
    /// both files are created at head, and the read connection sees the write side's tables.
    #[test]
    fn a_first_launch_makes_the_folder_and_opens_both_files_at_head() {
        let root = crate::scratch::path("launch-first");
        let dir = root.join("data");
        let opened = open(&dir).expect("a fresh folder opens");
        assert!(dir.join(db::USER_DB).is_file());
        assert!(dir.join(db::CORPUS_DB).is_file());

        app_meta::set_app_meta(&opened.write, "launch_probe", "written").unwrap();
        assert_eq!(
            app_meta::get_app_meta(&opened.read, "launch_probe").as_deref(),
            Some("written"),
            "the read connection must see what the write connection committed"
        );
        assert!(
            !sync::has_cards(&opened.read),
            "a first launch has no corpus yet"
        );
    }

    /// A second launch over the same folder migrates nothing and keeps what the reader wrote.
    #[test]
    fn a_second_launch_keeps_what_the_first_wrote() {
        let root = crate::scratch::path("launch-second");
        let dir = root.join("data");
        {
            let opened = open(&dir).unwrap();
            app_meta::set_app_meta(&opened.write, "reader_wrote", "this").unwrap();
        }
        let opened = open(&dir).unwrap();
        assert_eq!(
            app_meta::get_app_meta(&opened.read, "reader_wrote").as_deref(),
            Some("this")
        );
    }

    /// A lockout an earlier run earned is honoured before the first request: the client comes
    /// back already penalised, not merely told about it later.
    #[test]
    fn a_stored_lockout_is_re_entered_before_any_request() {
        let root = crate::scratch::path("launch-penalty");
        let dir = root.join("data");
        let until = scryfall::unix_now() + 20;
        {
            let opened = open(&dir).unwrap();
            app_meta::set_app_meta(
                &opened.write,
                sync::K_SCRYFALL_PENALTY_UNTIL,
                &until.to_string(),
            )
            .unwrap();
        }
        let opened = open(&dir).unwrap();
        assert!(
            opened.client.penalty_until_unix() > 0,
            "the stored lockout must be live on the new client"
        );
    }
}
