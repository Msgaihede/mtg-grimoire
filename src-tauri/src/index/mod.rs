//! **The facet index is `grimoire-core`'s, re-exported here beside what names the desktop.**
//!
//! `CardIndex`, its facets and its lifecycle are in `crates/grimoire-core/src/index/` since the
//! extraction's I/O step, and a path through this module reaches that crate's item unless this
//! file defines it. It defines two things: [`facets`], which is the core's module of that name
//! plus the `facet_cards` command, and — in test builds — the one fixture that builds the
//! desktop's whole `AppState`.

pub use grimoire_core::index::*;

pub mod facets;

/// The core's four seeded printings, and this crate's own state over them.
///
/// `pub`, in a test build only: the glob above carries the core's `fixtures` out of this module
/// publicly, and a private module of the same name over a public re-export is what
/// `hidden_glob_reexports` warns about.
#[cfg(test)]
pub mod fixtures {
    pub use grimoire_core::index::fixtures::*;

    /// The same four printings on a **file** database, inside the [`crate::sync::AppState`]
    /// the app runs on — `update::tests::file_state`'s arrangement, for its reason.
    ///
    /// A file and not `:memory:`, because [`super::lifecycle::build_now`] opens a read-only
    /// connection of its **own** from `data_dir`: two in-memory connections are two different
    /// databases, so an in-memory state would build an index over an empty corpus and every
    /// count here would be zero.
    ///
    /// The directory is [`crate::scratch::path`]'s, private to the calling test and to this
    /// `cargo test` process, so `name` only labels it. It used to be the whole of a shared temp
    /// path and had to be unique crate-wide: the brief's parameterless version had five tests
    /// sharing one directory, each one's first act deleting what the others were mid-build over.
    pub fn state_with_seeded_cards(name: &str) -> std::sync::Arc<crate::sync::AppState> {
        let dir = crate::scratch::path(&format!("lifecycle-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::split::convert(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        // **The corpus is brought to head, because a launch brings it to head.** `convert`
        // builds the file through the frozen `migrate_single_file` ladder and then stamps
        // `CORPUS_SCHEMA_VERSION` on it, so what comes out of it wears head while carrying
        // whatever shape that ladder last built — and `db::open_write` migrates nothing, by
        // design: `schema::prepare_database` is the one door every launch goes through.
        // Without this line the fixture is a database no launch can produce, and every test
        // built on it is asking its question of the wrong file.
        //
        // It went unnoticed for as long as no corpus rung had ever changed a table's shape.
        // Corpus schema 2 did — four columns on `combos` — and the tell was one route test
        // failing with `no such column: c.description` against a fixture whose header said it
        // was current. `prepare_database` itself is deliberately *not* what is called here: it
        // also installs the capture triggers, and arming sync's op log under twenty fixtures
        // that never asked for it is a much larger change than the one this needs.
        crate::schema::migrate_corpus(&conn).unwrap();
        seed(&conn);
        let read = crate::db::open_read(&dir).unwrap();
        // **Hooked up, so what these fixtures drive runs with the cross-file fence
        // armed.** `State::new` installs it, `crate::sync::with_write`'s `debug_assert`
        // reads it, so a command that committed to both files fails its own test rather
        // than printing a line nobody reads. The desktop's three observers ride along as
        // they do in the app, and nothing here looks at them: the wake is a throwaway,
        // since nothing in this fixture starts `sync_engine::live`.
        let mirror = std::sync::Arc::new(crate::mirror::watch::Mask::default());
        let changes = std::sync::Arc::new(crate::changes::Changes::new());
        std::sync::Arc::new(crate::sync::AppState {
            core: std::sync::Arc::new(grimoire_core::state::State::new(
                conn,
                Some(read),
                dir.clone(),
                grimoire_core::events::silent(),
                crate::mirror::watch::observers(
                    mirror.clone(),
                    changes.clone(),
                    Default::default(),
                ),
                // Never called: nothing in the lifecycle reaches the network or an image.
                crate::scryfall::Client::new("http://127.0.0.1:1".into()),
            )),
            images: crate::images::Cache::new(dir.join("images")),
            // The mirror is never started in these tests; a clean mask and an empty record are
            // what an `AppState` looks like before the first pass.
            mirror,
            mirror_status: std::sync::Mutex::new(crate::mirror::watch::LastPass::default()),
            pairing: std::sync::Mutex::new(None),
            changes,
        })
    }
}
