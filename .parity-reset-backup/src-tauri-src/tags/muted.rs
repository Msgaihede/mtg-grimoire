//! Switching an individual tag off.
//!
//! Scryfall asks for this in as many words. Their tag documentation: *"Tag data is subject to
//! change as the community adds, edits, and removes tags. Scryfall performs content moderation
//! on Tagger data. However, we cannot guarantee that tag data is 100% free from intentional
//! errors or abuse. Downstream applications are strongly recommended to implement a way to
//! temporarily disable display of individual tags."*
//!
//! This module is the *write* half of that: three commands over the `muted_tags` user table.
//! The read half already exists and is [`crate::tags::query`]'s `not_muted`, which every tag
//! read carries — so nothing here is ever consulted by a reader, and writing the row is the
//! whole of muting.
//!
//! # Three rules
//!
//! * **A mute is keyed on Scryfall's uuid, never on the slug.** Their docs: *"Do not treat tag
//!   slugs or labels as permanent identifiers […] Use the `id` field."* A mute keyed on a slug
//!   un-mutes itself the week Tagger renames the tag — which is exactly the week it mattered.
//!   The `slug` column is stored anyway, and for one reason only: Settings has to be able to
//!   name a muted tag without joining a taxonomy that may have been rebuilt, or emptied, since
//!   the mute was made. That is also the only reason [`mute`] refreshes it on a re-mute.
//! * **Muting hides a tag. It never hides a card.** Nothing in [`crate::filters`] consults this
//!   table, and a muted tag's `card_count` is still its full reach wherever it is visible at
//!   all. Narrowing a card query by a mute would drop results with no filter chip to explain
//!   them, which is the failure nobody reports.
//! * **`muted_tags` is a user table.** Everything around it is rebuilt on a schedule — the card
//!   corpus daily, both taxonomies weekly — and this is the reader's answer rather than
//!   Scryfall's. So it is on neither swap list, has no staging twin, and
//!   `schema::a_mute_survives_a_card_sync_and_a_taxonomy_rebuild` is the fence that keeps it
//!   that way.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::{params, Connection};
use serde::Serialize;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// One muted tag, as Settings lists it.
///
/// Every field is stored rather than joined, which is the point of the table: a taxonomy that
/// has been rebuilt since — or never fetched on this machine at all — must still be able to
/// show the reader what they hid and offer to give it back.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MutedTag {
    /// `"art"` or `"oracle"`. The two taxonomies are separate files with separate id spaces,
    /// so one uuid appearing in both is two mutes.
    pub namespace: String,
    /// Scryfall's stable uuid — the key, with the namespace.
    pub tag_id: String,
    /// The slug as it read when the mute was made. Display only, and possibly stale by design.
    pub slug: String,
    /// Seconds since the Unix epoch.
    pub muted_at: i64,
}

/// Is this a taxonomy a mute can name?
///
/// `"both"` is deliberately absent even though [`crate::tags::query`] accepts it: there it is
/// an *input* meaning "search each of them", and a stored row always belongs to exactly one.
///
/// Validating at all is [`crate::marketplace::store`]'s rule — a write that refuses is the only
/// thing standing between a typo and a row that looks saved, reads as nothing, and stays in the
/// table forever.
fn known_namespace(namespace: &str) -> bool {
    matches!(namespace, "art" | "oracle")
}

/// Hide `tag_id` from every tag read, remembering `slug` so Settings can name it later.
///
/// Idempotent by the primary key: muting a tag that is already muted refreshes the stored slug
/// and the timestamp rather than adding a second row, which is what makes a rename harmless.
///
/// **A blank `tag_id` is refused, and that refusal is load-bearing.** `oracle_tags.id` is
/// `NOT NULL DEFAULT ''` — the v20 rung adds it with `ALTER TABLE`, which cannot add a
/// `NOT NULL` column without a default — so every row that predates a refresh by a build new
/// enough to write ids still carries `''`. One `muted_tags` row with an empty `tag_id` would
/// otherwise equal every one of those rows and take the entire oracle taxonomy off the page,
/// with no error raised and nothing in `error_log`. [`crate::tags::query`]'s `not_muted` guards
/// the read side against exactly that; this is the same fence at the only place the row can be
/// created, which is the honest place to stop it.
pub fn mute(
    conn: &Connection,
    namespace: &str,
    tag_id: &str,
    slug: &str,
    at: i64,
) -> Result<(), String> {
    if !known_namespace(namespace) {
        return Err(format!(
            "\"{namespace}\" is not a tag taxonomy this app knows. Expected \"art\" or \"oracle\"."
        ));
    }
    if tag_id.is_empty() {
        return Err(
            "That tag has no Scryfall id yet, so it cannot be muted. Refresh the tag data first."
                .to_owned(),
        );
    }
    conn.execute(
        "INSERT INTO muted_tags (namespace, tag_id, slug, muted_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (namespace, tag_id)
         DO UPDATE SET slug = excluded.slug, muted_at = excluded.muted_at",
        params![namespace, tag_id, slug, at],
    )
    .map_err(|e| format!("could not mute that tag: {e}"))?;
    Ok(())
}

/// Give a tag back. A tag that was never muted is not an error — the row is simply gone either
/// way, and a Settings list that raced a second window is not something to shout about.
///
/// **Unlike [`mute`], this accepts a blank `tag_id`**, and the asymmetry is the point: a row
/// with an empty id is unreachable by any tag it was meant to name, so the only thing it can
/// ever be is junk to delete. Refusing here would make [`list`] show a row nothing could
/// remove.
pub fn unmute(conn: &Connection, namespace: &str, tag_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM muted_tags WHERE namespace = ?1 AND tag_id = ?2",
        params![namespace, tag_id],
    )
    .map_err(|e| format!("could not unmute that tag: {e}"))?;
    Ok(())
}

/// Every mute, grouped by taxonomy and alphabetical within it.
///
/// Ordered by the stored slug rather than by `muted_at`, because the list exists to be searched
/// by eye for the tag to give back; `tag_id` breaks the tie so the order is total even after a
/// rename has left two rows sharing a slug.
pub fn list(conn: &Connection) -> Result<Vec<MutedTag>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT namespace, tag_id, slug, muted_at FROM muted_tags
              ORDER BY namespace, slug, tag_id",
        )
        .map_err(|e| format!("could not read the muted tags: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(MutedTag {
                namespace: r.get(0)?,
                tag_id: r.get(1)?,
                slug: r.get(2)?,
                muted_at: r.get(3)?,
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(|e| format!("could not read the muted tags: {e}"))?;
    Ok(rows)
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// Stop offering a tag anywhere.
///
/// A write, so it takes `AppState.db` through the one [`crate::sync::with_write`] and answers
/// [`crate::db::BUSY`] if a sync holds it — never `db_read`, which is the read connection and
/// cannot write.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn tag_mute(
    state: tauri::State<'_, Arc<AppState>>,
    namespace: String,
    tag_id: String,
    slug: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| {
            mute(conn, &namespace, &tag_id, &slug, super::unix_now())
        })
    })
    .await
    .map_err(|e| format!("the tag could not be muted: {e}"))?
}

/// Offer a tag again.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn tag_unmute(
    state: tauri::State<'_, Arc<AppState>>,
    namespace: String,
    tag_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| unmute(conn, &namespace, &tag_id))
    })
    .await
    .map_err(|e| format!("the tag could not be unmuted: {e}"))?
}

/// Everything the reader has hidden, for the Settings list that gives it back.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn tags_muted(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<MutedTag>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        list(&conn)
    })
    .await
    .map_err(|e| format!("could not read the muted tags: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tags::testing::mem_db;

    fn db() -> Connection {
        mem_db().into_inner().unwrap()
    }

    /// Tagger renames tags, so the same tag arriving under a new slug must be the *same* mute —
    /// keyed on the uuid, with the newer name kept for display. A mute keyed on the slug would
    /// leave two rows here and, worse, would have stopped hiding the tag.
    #[test]
    fn muting_is_idempotent_and_keyed_on_the_uuid() {
        let conn = db();
        mute(&conn, "art", "uuid-1", "dog", 100).unwrap();
        mute(&conn, "art", "uuid-1", "dogs", 200).unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].slug, "dogs");
        assert_eq!(rows[0].muted_at, 200);
        assert_eq!(rows[0].tag_id, "uuid-1");
    }

    /// Two files, two id spaces. `dog` exists in both taxonomies and means different things,
    /// so hiding the picture must not hide the rules text.
    #[test]
    fn the_same_slug_in_two_namespaces_mutes_independently() {
        let conn = db();
        mute(&conn, "art", "uuid-a", "dragon", 100).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1);
        mute(&conn, "oracle", "uuid-b", "dragon", 100).unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(
            rows.iter()
                .map(|m| (m.namespace.as_str(), m.tag_id.as_str()))
                .collect::<Vec<_>>(),
            vec![("art", "uuid-a"), ("oracle", "uuid-b")]
        );
    }

    /// Nothing to give back is not a failure: the row is gone either way, and a second window
    /// having got there first is not worth an error dialog.
    #[test]
    fn unmuting_a_tag_that_was_never_muted_is_not_an_error() {
        let conn = db();
        assert!(unmute(&conn, "art", "nope").is_ok());
    }

    /// A `DELETE` that forgot either half of the key would pass every test above and quietly
    /// give back tags the reader never asked for.
    #[test]
    fn unmute_removes_only_the_named_tag() {
        let conn = db();
        mute(&conn, "art", "uuid-1", "dog", 100).unwrap();
        mute(&conn, "art", "uuid-2", "cat", 100).unwrap();
        mute(&conn, "oracle", "uuid-1", "dog", 100).unwrap();

        unmute(&conn, "art", "uuid-1").unwrap();

        assert_eq!(
            list(&conn)
                .unwrap()
                .iter()
                .map(|m| (m.namespace.clone(), m.tag_id.clone()))
                .collect::<Vec<_>>(),
            vec![
                ("art".to_owned(), "uuid-2".to_owned()),
                ("oracle".to_owned(), "uuid-1".to_owned())
            ]
        );
    }

    /// **The one row that could empty the whole page.** A taxonomy ingested before ids were
    /// stored carries `id = ''` on every row, so a mute on `''` matches all of them. The read
    /// side guards it too; this refuses to create it in the first place.
    #[test]
    fn a_blank_tag_id_is_refused() {
        let conn = db();
        let err = mute(&conn, "oracle", "", "dog", 100).expect_err("a blank id mutes everything");
        assert!(
            !err.contains("  "),
            "a user-facing message with a run of spaces is a joined line continuation: {err:?}"
        );
        assert_eq!(list(&conn).unwrap(), vec![]);
    }

    /// The asymmetry with [`mute`]: a blank row an older build could have written has to be
    /// removable, or the Settings list shows something nothing can clear.
    #[test]
    fn a_blank_tag_id_can_still_be_unmuted() {
        let conn = db();
        conn.execute(
            "INSERT INTO muted_tags (namespace, tag_id, slug, muted_at)
             VALUES ('oracle', '', '', 0)",
            [],
        )
        .unwrap();
        unmute(&conn, "oracle", "").unwrap();
        assert_eq!(list(&conn).unwrap(), vec![]);
    }

    /// A namespace this build does not know would store a row that hides nothing and that the
    /// reader would see listed as muted — [`crate::marketplace::store`]'s failure, one family
    /// over. `"both"` is a search input, never a stored value.
    #[test]
    fn an_unknown_namespace_is_refused() {
        let conn = db();
        for namespace in ["both", "Art", "arts", ""] {
            let err = mute(&conn, namespace, "uuid-1", "dog", 100)
                .expect_err("an unknown namespace must not be stored");
            assert!(
                !err.contains("  "),
                "{namespace:?}: a run of spaces means a joined line continuation: {err:?}"
            );
        }
        assert_eq!(list(&conn).unwrap(), vec![]);
    }

    /// **The fence between the writer and the reader.** Everything above would still pass if
    /// this module spelled a namespace differently from [`crate::tags::query`], or keyed the
    /// row on something that clause does not join to — both halves would be self-consistent and
    /// the mute would simply never take effect. So one mute per taxonomy is written through
    /// [`mute`] and the search is asked whether the tag is gone.
    ///
    /// It also pins the other half of the contract: the *other* taxonomy's tag of the same
    /// name is untouched.
    #[test]
    fn a_mute_written_here_is_the_mute_the_search_honours() {
        for namespace in ["art", "oracle"] {
            let conn = seeded();
            let both = pairs(&[("dog", "art"), ("dog", "oracle")]);
            assert_eq!(visible(&conn), both, "{namespace}");

            mute(&conn, namespace, &format!("{namespace}-dog"), "dog", 100).unwrap();
            let left = visible(&conn);
            assert_eq!(left.len(), 1, "{namespace}: exactly one taxonomy is hidden");
            assert_ne!(left[0].1, namespace, "{namespace}");

            unmute(&conn, namespace, &format!("{namespace}-dog")).unwrap();
            assert_eq!(visible(&conn), both, "{namespace}: unmuting gives it back");
        }
    }

    /// One tag called `dog` in each taxonomy, with the id [`mute`] is keyed on.
    fn seeded() -> Connection {
        let conn = db();
        for table in ["art_tags", "oracle_tags"] {
            let namespace = table.split('_').next().unwrap();
            conn.execute(
                &format!(
                    "INSERT INTO {table} (slug, id, label, description, slug_norm)
                     VALUES ('dog', ?1, 'Dog', NULL, ?2)"
                ),
                params![format!("{namespace}-dog"), crate::tags::normalize("dog")],
            )
            .unwrap();
        }
        conn
    }

    /// The `(slug, namespace)` pairs a search for `dog` still offers.
    fn visible(conn: &Connection) -> Vec<(String, String)> {
        crate::tags::query::run_tag_search(conn, "dog", "both", 10)
            .unwrap()
            .into_iter()
            .map(|h| (h.slug, h.namespace))
            .collect()
    }

    /// [`visible`]'s answer, spelled the way a test literal is.
    fn pairs(of: &[(&str, &str)]) -> Vec<(String, String)> {
        of.iter()
            .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
            .collect()
    }
}
