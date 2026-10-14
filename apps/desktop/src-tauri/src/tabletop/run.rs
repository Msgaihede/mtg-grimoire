//! The pass: every deck's saves, written into the `MTG Grimoire` folder, and the ones the decks no
//! longer want taken away.
//!
//! ```text
//! <Tabletop Simulator>/Saves/MTG Grimoire/
//!   .grimoire-manifest                       what the last pass wrote — the pruner's authority
//!   <deck folder>/<deck folder>/             deck_folders, nested as directories
//!     Burn.json                              a deck with one list
//!     Azula/                                 a theory-and-actual deck: one folder, both lists
//!       Azula (Actual).json
//!       Azula (Theory).json
//!   Archived/<deck folder>/…                 archived decks, with their folder tree
//!   Images/<digest>.jpg                      the pictures, only with local images on
//! ```
//!
//! **The names are the mirror's, borrowed rather than re-derived.** The text mirror's
//! [`crate::mirror::layout::plan_files`] already sanitises every name, disambiguates decks and
//! folders that share a directory, and reserves `Archived` — so this pass asks it for the deck
//! tree and turns each deck's plain-text file into a save path ([`save_paths`]). Two folders that
//! sort the same decks into the same tree cannot disagree about which deck is `Aggro (2)`.
//!
//! **Pruning is by manifest, the mirror's rule for the mirror's reason**: the saves folder is the
//! reader's, they may keep their own saves beside ours, and a file is only ever deleted when the
//! last manifest this installation wrote names it and this pass does not. Only `.json` lines are
//! honoured, every line is fenced against leaving the folder, and the manifest is written last so
//! a pass killed half way leaves a superset.

use crate::mirror::layout::{plan_files, Shape, Source};
use crate::mirror::run::PassReport;
use crate::tabletop::images::{Fetch, Localizer, IMAGES_DIR};
use crate::tabletop::read::{stacks_for, ArtMemo};
use crate::tabletop::save::render;
use crate::transfer::Format;
use rusqlite::Connection;
use std::collections::{BTreeSet, HashSet};
use std::path::Path;

/// The pruner's record, at the root of the `MTG Grimoire` folder. A dot-file, which Tabletop
/// Simulator's save browser does not list.
pub const MANIFEST_NAME: &str = ".grimoire-manifest";

/// How the manifest's first line names the installation that wrote it — the mirror's rule (one
/// folder, one installation), because two computers syncing one Documents folder would otherwise
/// prune each other's decks.
const OWNER_PREFIX: &str = "installation: ";

/// The two lists of a theory-and-actual deck, as the file names say them.
const ACTUAL: &str = "Actual";
const THEORY: &str = "Theory";

/// One save this pass intends to exist.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedSave {
    /// Relative to the `MTG Grimoire` folder, `/` separators.
    pub path: String,
    /// What Tabletop Simulator calls the save.
    pub save_name: String,
    pub deck_id: i64,
    pub variant: &'static str,
}

/// Every deck's saves, from the mirror's plan of the deck tree.
///
/// Each deck's live list arrives as `Decks/<tree>/<Deck>/<Deck>.txt` and a theory list as
/// `Decks/<tree>/<Deck>/Theory/<Deck>.txt`. A deck with both lists keeps its folder and the two
/// saves go inside it; a deck with one list is a single file where its folder would have been.
/// **A virtual deck has one list whatever its theory switch says** — the pair `1/1` is one the app
/// never writes, and reading it as virtual is what `DeckRow::virtual_only` says loses the least.
pub fn save_paths(conn: &Connection) -> Result<Vec<PlannedSave>, String> {
    let decks = crate::deck::list_decks(conn)?;
    let deck_folders = crate::deck_meta::list_folders(conn)?;
    let plan = plan_files(&Shape {
        decks: &decks,
        deck_folders: &deck_folders,
        collection_folders: &[],
        wishlist_folders: &[],
    });
    let two_lists: HashSet<i64> = decks
        .iter()
        .filter(|d| d.theory_enabled && !d.virtual_only)
        .map(|d| d.id)
        .collect();

    let mut out = Vec::new();
    for file in &plan.files {
        let Source::Deck { id, variant } = file.source else {
            continue;
        };
        if file.format != Format::Plain {
            continue;
        }
        let Some(rest) = file.path.strip_prefix("Decks/") else {
            continue;
        };
        // `<tree>/<Deck>/<Deck>.txt` or `<tree>/<Deck>/Theory/<Deck>.txt` → `<tree>/<Deck>`.
        let Some((dir, _)) = rest.rsplit_once('/') else {
            continue;
        };
        let theory = variant != crate::schema::DECK_VARIANTS[0];
        let deck_dir = if theory {
            match dir.strip_suffix(&format!("/{THEORY}")) {
                Some(d) => d,
                None => continue,
            }
        } else {
            dir
        };
        let name = deck_dir.rsplit('/').next().unwrap_or(deck_dir);
        let (path, save_name) = if two_lists.contains(&id) {
            let list = if theory { THEORY } else { ACTUAL };
            (
                format!("{deck_dir}/{name} ({list}).json"),
                format!("{name} ({list})"),
            )
        } else if theory {
            // A theory file for a deck with one list — the `1/1` pair. Its live list stands.
            continue;
        } else {
            (format!("{deck_dir}.json"), name.to_owned())
        };
        out.push(PlannedSave {
            path,
            save_name,
            deck_id: id,
            variant,
        });
    }
    Ok(out)
}

/// The installation named on a manifest's first line, if it carries one.
fn owner_of(lines: &[String]) -> Option<&str> {
    lines.first()?.strip_prefix(OWNER_PREFIX)
}

/// The sentence for a folder another installation keeps.
pub fn another_installation(root: &Path) -> String {
    format!(
        "{} is kept up to date by another MTG Grimoire installation, so this one will not write \
         there. Choose a different Tabletop Simulator folder, or turn the integration off on the \
         other computer.",
        root.display()
    )
}

/// The previous manifest's lines, or `None` when there is none to act on.
fn read_manifest(root: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(root.join(MANIFEST_NAME)).ok()?;
    Some(
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

/// May this manifest line be turned into a path and deleted? A relative path of plain segments,
/// ending `.json`, or a picture in [`IMAGES_DIR`] — the manifest is a file on the reader's disk,
/// so it is input.
fn safe_entry(rel: &str) -> bool {
    (rel.ends_with(".json")
        || (rel.starts_with(&format!("{IMAGES_DIR}/")) && rel.ends_with(".jpg")))
        && !rel.starts_with('/')
        && !rel.contains('\\')
        && !rel.contains(':')
        && !rel
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
}

/// Write `bytes` at `rel` unless the file already holds exactly them.
fn put(root: &Path, rel: &str, bytes: &[u8], report: &mut PassReport) {
    let abs = root.join(rel);
    if std::fs::read(&abs).is_ok_and(|on_disk| on_disk == bytes) {
        report.unchanged += 1;
        return;
    }
    let written = abs
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&abs, bytes));
    match written {
        Ok(()) => report.written += 1,
        Err(_) => report.failed += 1,
    }
}

/// Delete what the last manifest names and this plan does not, then every directory that leaves
/// empty, deepest first. **Case-insensitively wanted**, because NTFS is: a deck renamed `azula` →
/// `Azula` has just been written through the new spelling to the same file.
fn prune(root: &Path, previous: &[String], wanted: &BTreeSet<String>, report: &mut PassReport) {
    let wanted_folded: HashSet<String> = wanted.iter().map(|w| w.to_lowercase()).collect();
    let mut emptied: BTreeSet<String> = BTreeSet::new();
    for line in previous.iter().skip_while(|l| l.starts_with(OWNER_PREFIX)) {
        if !safe_entry(line) || wanted_folded.contains(&line.to_lowercase()) {
            continue;
        }
        match std::fs::remove_file(root.join(line)) {
            Ok(()) => report.pruned += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => report.failed += 1,
        }
        let mut dir = line.as_str();
        while let Some((parent, _)) = dir.rsplit_once('/') {
            emptied.insert(parent.to_owned());
            dir = parent;
        }
    }
    // Longest first, so a child goes before its parent. `remove_dir` never takes a directory with
    // anything left in it: what is left is not ours.
    let mut dirs: Vec<String> = emptied.into_iter().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.len()));
    for d in dirs {
        let _ = std::fs::remove_dir(root.join(d));
    }
}

/// Write every deck's saves under `root` — the `MTG Grimoire` folder — and prune what the last
/// manifest names that this pass does not.
///
/// **The `Saves` folder above it must already exist.** It is Tabletop Simulator's, made by its
/// first launch; a pass that created `Documents/My Games/Tabletop Simulator/Saves` for a reader
/// who has never installed it would be litter. That is the one `Err` besides a root that cannot be
/// made and a folder another installation keeps; everything past them is a count.
///
/// `images` is the local-pictures switch ([`crate::tabletop::images`]): `None` names Scryfall's
/// links, `Some` fetches every picture into `Images/` and names the `file:///` copies.
pub fn run_pass(
    conn: &Connection,
    root: &Path,
    images: Option<&dyn Fetch>,
) -> Result<PassReport, String> {
    let saves = root.parent().unwrap_or(root);
    if !saves.is_dir() {
        return Err(format!(
            "Tabletop Simulator's saves folder was not found at {}. Start Tabletop Simulator once \
             so it makes the folder, or choose where your saves are.",
            saves.display()
        ));
    }
    std::fs::create_dir_all(root)
        .map_err(|e| format!("the folder {} could not be created: {e}", root.display()))?;

    let previous = read_manifest(root);
    let me = crate::mirror::settings::installation(conn);
    if let Some(owner) = previous.as_deref().and_then(owner_of) {
        if me.as_deref() != Some(owner) {
            return Err(another_installation(root));
        }
    }

    let planned = save_paths(conn)?;
    let mut report = PassReport::default();
    let mut memo = ArtMemo::new();
    let mut wanted: BTreeSet<String> = BTreeSet::new();
    let mut local = images.map(|fetch| Localizer::new(root, fetch));
    for save in &planned {
        match stacks_for(conn, save.deck_id, save.variant, &mut memo) {
            Ok(Some(mut stacks)) => {
                if let Some(local) = local.as_mut() {
                    local.localize_stacks(&mut stacks, &mut report);
                }
                put(
                    root,
                    &save.path,
                    render(&save.save_name, &stacks).as_bytes(),
                    &mut report,
                );
                wanted.insert(save.path.clone());
            }
            // Deleted since the plan was read: the prune takes its file away.
            Ok(None) => {}
            // A deck that will not read keeps whatever file it had, rather than losing it.
            Err(_) => {
                report.failed += 1;
                wanted.insert(save.path.clone());
            }
        }
    }

    if let Some(local) = local {
        wanted.extend(local.files);
    }
    if let Some(previous) = &previous {
        prune(root, previous, &wanted, &mut report);
    }

    let mut manifest = String::new();
    if let Some(me) = &me {
        manifest.push_str(OWNER_PREFIX);
        manifest.push_str(me);
        manifest.push('\n');
    }
    for line in &wanted {
        manifest.push_str(line);
        manifest.push('\n');
    }
    if std::fs::write(root.join(MANIFEST_NAME), manifest).is_err() {
        report.failed += 1;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tabletop::read::tests::seed_card;

    fn deck(conn: &Connection, name: &str, theory: bool) -> i64 {
        let deck = crate::deck::create_deck(
            conn,
            &crate::deck::DeckInput {
                name: name.to_owned(),
                theory_enabled: Some(theory),
                ..Default::default()
            },
        )
        .unwrap();
        crate::deck::add_card(conn, deck.id, "bolt", None, Some("Main"), "live", None, 4).unwrap();
        if theory {
            crate::deck::add_card(conn, deck.id, "bolt", None, Some("Main"), "theory", None, 2)
                .unwrap();
        }
        deck.id
    }

    /// A database with one printing, and a `Saves` folder for the pass to write into.
    fn setup() -> (Connection, tempfile::TempDir, std::path::PathBuf) {
        let conn = crate::schema::memory_pair();
        seed_card(&conn, "bolt", "o-bolt", "Bolt", "normal", "1993-08-05");
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("MTG Grimoire");
        (conn, tmp, root)
    }

    #[test]
    fn a_deck_with_one_list_is_one_file_and_a_theory_deck_is_a_folder_of_two() {
        let (conn, _tmp, root) = setup();
        deck(&conn, "Burn", false);
        deck(&conn, "Azula", true);

        let report = run_pass(&conn, &root, None).unwrap();

        assert_eq!(report.written, 3);
        assert!(root.join("Burn.json").is_file());
        assert!(root.join("Azula/Azula (Actual).json").is_file());
        assert!(root.join("Azula/Azula (Theory).json").is_file());
        let theory: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("Azula/Azula (Theory).json")).unwrap(),
        )
        .unwrap();
        assert_eq!(theory["SaveName"], "Azula (Theory)");
        assert_eq!(
            theory["ObjectStates"][0]["DeckIDs"]
                .as_array()
                .unwrap()
                .len(),
            2,
            "the theory list's own cards"
        );
    }

    #[test]
    fn decks_keep_their_folders_and_archived_decks_are_included() {
        let (conn, _tmp, root) = setup();
        let id = deck(&conn, "Old", false);
        conn.execute("UPDATE decks SET archived = 1 WHERE id = ?1", [id])
            .unwrap();
        let folder = crate::deck_meta::create_folder(&conn, None, "Modern").unwrap();
        let filed = deck(&conn, "Burn", false);
        conn.execute(
            "UPDATE decks SET folder_id = ?1 WHERE id = ?2",
            [folder.id, filed],
        )
        .unwrap();

        run_pass(&conn, &root, None).unwrap();

        assert!(root.join("Archived/Old.json").is_file());
        assert!(root.join("Modern/Burn.json").is_file());
    }

    #[test]
    fn an_unchanged_deck_is_not_rewritten_and_an_edit_rewrites_only_its_file() {
        let (conn, _tmp, root) = setup();
        let burn = deck(&conn, "Burn", false);
        deck(&conn, "Azula", false);
        run_pass(&conn, &root, None).unwrap();

        let again = run_pass(&conn, &root, None).unwrap();
        assert_eq!((again.written, again.unchanged), (0, 2));

        crate::deck::add_card(&conn, burn, "bolt", None, Some("Side"), "live", None, 1).unwrap();
        let edited = run_pass(&conn, &root, None).unwrap();
        assert_eq!((edited.written, edited.unchanged), (1, 1));
    }

    #[test]
    fn a_renamed_deck_leaves_its_old_save_behind_for_nobody() {
        let (conn, _tmp, root) = setup();
        let id = deck(&conn, "Burn", false);
        run_pass(&conn, &root, None).unwrap();
        conn.execute("UPDATE decks SET name = 'Fire' WHERE id = ?1", [id])
            .unwrap();

        let report = run_pass(&conn, &root, None).unwrap();

        assert_eq!(report.pruned, 1);
        assert!(!root.join("Burn.json").exists());
        assert!(root.join("Fire.json").is_file());
    }

    /// The reader's own saves in our folder are never in a manifest of ours, so never pruned —
    /// and switching a theory list off takes its folder away only once it is empty.
    #[test]
    fn the_readers_own_saves_survive_every_prune() {
        let (conn, _tmp, root) = setup();
        let id = deck(&conn, "Azula", true);
        run_pass(&conn, &root, None).unwrap();
        std::fs::write(root.join("Azula/My game.json"), "{}").unwrap();
        std::fs::write(root.join("TS_Save_1.json"), "{}").unwrap();
        conn.execute("UPDATE decks SET theory_enabled = 0 WHERE id = ?1", [id])
            .unwrap();

        let report = run_pass(&conn, &root, None).unwrap();

        assert_eq!(report.pruned, 2);
        assert!(root.join("Azula.json").is_file());
        assert!(root.join("Azula/My game.json").is_file());
        assert!(root.join("TS_Save_1.json").is_file());
    }

    #[test]
    fn a_deleted_deck_folder_is_swept_once_empty() {
        let (conn, _tmp, root) = setup();
        let id = deck(&conn, "Azula", true);
        run_pass(&conn, &root, None).unwrap();
        crate::deck::delete_deck(&conn, id).unwrap();

        run_pass(&conn, &root, None).unwrap();

        assert!(!root.join("Azula").exists());
    }

    /// The manifest is input: a line that climbs out of the folder is ignored, not followed.
    #[test]
    fn a_manifest_line_outside_the_folder_is_never_deleted() {
        let (conn, tmp, root) = setup();
        std::fs::create_dir_all(&root).unwrap();
        let outside = tmp.path().join("precious.json");
        std::fs::write(&outside, "{}").unwrap();
        std::fs::write(
            root.join(MANIFEST_NAME),
            "../precious.json\nC:/x.json\nnotes.txt\n",
        )
        .unwrap();
        std::fs::write(root.join("notes.txt"), "mine").unwrap();

        run_pass(&conn, &root, None).unwrap();

        assert!(outside.is_file());
        assert!(
            root.join("notes.txt").is_file(),
            "only .json lines are ours"
        );
    }

    /// Local pictures: the saves name `file:///` copies, a second pass fetches nothing, and
    /// switching back to links prunes every picture.
    #[test]
    fn local_pictures_are_fetched_once_and_pruned_when_switched_off() {
        let (conn, _tmp, root) = setup();
        deck(&conn, "Burn", false);
        let fetch = crate::tabletop::images::tests::FakeFetch::default();

        let first = run_pass(&conn, &root, Some(&fetch)).unwrap();
        assert_eq!(
            fetch.calls.borrow().len(),
            2,
            "Bolt's face and the card back"
        );
        assert_eq!(first.written, 3, "one save and two pictures");
        let save = std::fs::read_to_string(root.join("Burn.json")).unwrap();
        assert!(save.contains("file:///"), "{save}");
        assert!(!save.contains("cards.scryfall.io"));

        run_pass(&conn, &root, Some(&fetch)).unwrap();
        assert_eq!(fetch.calls.borrow().len(), 2, "nothing fetched twice");

        let back = run_pass(&conn, &root, None).unwrap();
        assert_eq!(back.pruned, 2);
        assert!(!root.join(IMAGES_DIR).exists());
        let save = std::fs::read_to_string(root.join("Burn.json")).unwrap();
        assert!(save.contains("cards.scryfall.io"));
    }

    #[test]
    fn no_saves_folder_is_a_sentence_and_nothing_is_created() {
        let conn = crate::schema::memory_pair();
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Saves").join("MTG Grimoire");
        let err = run_pass(&conn, &root, None).unwrap_err();
        assert!(err.contains("saves folder was not found"), "{err}");
        assert!(!tmp.path().join("Saves").exists());
    }

    #[test]
    fn a_folder_another_installation_keeps_is_refused() {
        let (conn, _tmp, root) = setup();
        crate::app_meta::set_app_meta(
            &conn,
            crate::mirror::settings::K_INSTALLATION,
            &"a".repeat(32),
        )
        .unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join(MANIFEST_NAME),
            format!("{OWNER_PREFIX}{}\nBurn.json\n", "b".repeat(32)),
        )
        .unwrap();
        std::fs::write(root.join("Burn.json"), "{}").unwrap();

        let err = run_pass(&conn, &root, None).unwrap_err();

        assert!(err.contains("another MTG Grimoire installation"), "{err}");
        assert!(root.join("Burn.json").is_file());
    }
}
