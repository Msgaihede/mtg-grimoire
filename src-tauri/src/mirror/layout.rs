//! The layout: which files the mirror intends to exist, and where.
//!
//! This is the whole of the mirror's answer to "what should be on disk", and it is a **pure
//! function of the database's shape** — [`plan_files`] takes a [`Shape`] of rows and hands back
//! a list of [`PlannedFile`]s. No `Connection`, no filesystem, no clock. That is what lets the
//! tree be decided and tested without a database, and it is why the rows are passed in rather
//! than read here.
//!
//! Nothing below resolves a *card*. A [`PlannedFile`] names its [`Source`] and the reader of
//! this plan turns that into rows; the split is deliberate, because deciding the tree is cheap
//! and reading it is not — a pass that only has to prune never needs the cards at all.
//!
//! The shape it produces is §3 of
//! `docs/superpowers/specs/2026-08-25-text-backed-cards-design.md`:
//!
//! ```text
//! Decks/<folder tree>/<Deck>/<Deck>.txt … <Deck>.csv
//!                            Theory/<Deck>.txt …          only when the deck keeps one
//! Decks/Archived/<folder tree>/<Deck>/…                    archived decks, tree and all
//! Collection/Collection.txt … Collection.csv               every row
//! Collection/<folder tree>/<Folder>.txt …                  what is filed *directly* there
//! Wishlist/Wishlist.txt … Wishlist.csv
//! Wishlist/<folder tree>/<Folder>.txt …
//! ```
//!
//! **Every name in a path is assigned once, per directory, against everything else that lands
//! in that directory** — a reader's folders, their decks, and the two names the app itself
//! claims. A directory listing is the unit because that is the unit the filesystem enforces:
//! `Archived` and `Old` may each be a directory anywhere in the tree, but not twice in one
//! parent, and `Collection.csv` cannot be a file and a folder in the same breath.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use super::paths::{disambiguate, file_name};
use crate::transfer::{Format, Surface};

/// The three top-level directories, and the two below them that the app owns outright.
///
/// `Archived` and `Theory` are directory names the reader never chose, which is the one thing
/// that makes them different from every other segment in a mirrored path: they never go
/// through [`super::paths::sanitise`], because there is nothing in them to sanitise. `Archived`
/// is also **reserved** — see [`plan_files`].
const DECKS_DIR: &str = "Decks";
const ARCHIVED_DIR: &str = "Archived";
const THEORY_DIR: &str = "Theory";
const COLLECTION_DIR: &str = "Collection";
const WISHLIST_DIR: &str = "Wishlist";

/// One file the mirror intends to exist, and where its cards come from.
#[derive(Clone, Debug, PartialEq)]
pub struct PlannedFile {
    /// Relative to the mirror root, using `/` separators. Joined with `Path::join` at write
    /// time — every reader-supplied segment has already been through
    /// [`super::paths::sanitise`], so joining is the only thing left to do to it.
    pub path: String,
    pub format: Format,
    pub surface: Surface,
    pub source: Source,
}

/// Where a planned file's cards come from — resolved against the database by the reader of
/// this plan.
///
/// An id rather than a name, everywhere, because a name is what the *path* is made of and the
/// two are allowed to differ: `Aggro (2)` is a directory on disk and no row in any table says
/// so.
#[derive(Clone, PartialEq, Debug)]
pub enum Source {
    /// One deck's list. `variant` is a [`crate::schema::DECK_VARIANTS`] word — the live list
    /// or the theory one.
    Deck { id: i64, variant: &'static str },
    /// Every row in the collection, whatever folder it is filed in.
    WholeCollection,
    /// What is filed **directly** in one collection folder, never what is beneath it — a
    /// nested folder has its own file one directory down. Rolling children up would make a
    /// card appear once per ancestor, and a reader counting rows in two files could not tell
    /// that from owning it twice.
    CollectionFolder { id: i64 },
    /// Every wish, whatever folder it is filed in.
    WholeWishlist,
    /// What is filed directly in one wishlist folder — [`Source::CollectionFolder`]'s rule.
    WishlistFolder { id: i64 },
}

/// A directory the mirror owns, and the stem its files are named after — if it has any.
///
/// **A prune needs a stem, and three kinds of directory answer differently.**
/// [`super::paths::is_ours`] asks "is this file one of the seven I would have written *here*",
/// and composes the answer from a stem:
///
/// - A **deck's own directory**, a **collection folder** and a **wishlist folder** each hold
///   seven files named after themselves, so the stem is that directory's own name.
/// - A deck's **`Theory`** is the exception this type exists for: its files are named after the
///   *deck* (`Decks/Azula/Theory/Azula.txt`, §3), and the layout is the only thing that ever
///   knows that. It carries a stem whether or not the deck keeps a theory list.
/// - **`None`, which is an answer and not an absence.** `Decks`, `Decks/Archived`, every deck
///   folder and the mirror root are *containers*: they hold other directories and no file of
///   ours, so nothing sitting directly in one is ever the mirror's to delete. A reader who
///   drops `Standard.csv` into their deck folder `Standard` keeps it — handing a container
///   its own name as a stem would have claimed exactly that file.
#[derive(Clone, Debug, PartialEq)]
pub struct OwnedDir {
    /// Relative to the mirror root, `/` separators, no trailing slash. The **empty string is
    /// the mirror root itself**, which holds `README.txt` and nothing else of ours.
    pub path: String,
    /// What [`super::paths::is_ours`] should be given for files directly inside it, or `None`
    /// when no file sitting directly here is ever the mirror's.
    pub stem: Option<String>,
}

/// What a pass is told to bring about: the files, and the directories they live in.
///
/// **The directories are not recoverable from the files, which is the whole reason they are
/// carried.** A deck's `Theory` directory is owned *whether or not the deck keeps a theory
/// list*: a switch that has just been turned off is exactly when seven files are on disk that
/// nothing plans, and this is the only moment anything knows they were named after the deck.
/// A pass handed only the files would see a `Theory` directory it could not claim and would
/// leave those seven behind for good.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub files: Vec<PlannedFile>,
    /// Sorted by path and unique, so a parent always precedes its children and a pass can walk
    /// them in order.
    pub dirs: Vec<OwnedDir>,
}

/// The database's shape, as far as the layout is concerned: what exists, and how it nests.
///
/// **Rows, not counts.** The layout needs every deck's name, folder and theory switch, and
/// every folder's name and parent — and nothing else. It is handed the same row types the
/// gallery and the three folder pages are drawn from, so a folder renamed on screen and a
/// folder renamed on disk are one fact read twice rather than two reads that can disagree.
pub struct Shape<'a> {
    pub decks: &'a [crate::deck::DeckRow],
    pub deck_folders: &'a [crate::deck_meta::DeckFolderRow],
    pub collection_folders: &'a [crate::collection_folders::CollectionFolder],
    pub wishlist_folders: &'a [crate::wishlist_folders::WishlistFolder],
}

/// A sibling group as [`disambiguate`] wants it: `(id, raw name)` pairs, sorted by id.
type Named = Vec<(i64, String)>;

/// Which of the two deck trees a deck sits in, and which folder of it — `true` for the
/// archived tree, and `None` for the root of whichever tree that is.
type DeckSlot = (bool, Option<i64>);

/// One folder, stripped to the three things a path is made of.
///
/// Three cabinets, three tables, three row types and one shape between them — this is that
/// shape, so [`folder_paths`] is written once. A `CollectionFolder`'s `kind` deliberately does
/// not survive the trip: an automatic folder is mirrored like any other, and a layout that
/// could tell them apart would sooner or later be asked to treat one differently.
struct Node {
    id: i64,
    parent_id: Option<i64>,
    name: String,
}

/// A folder that survived the walk: its id, its parent's, the directory path it sits at
/// (relative to its cabinet's own root, `/`-separated), and the last segment of that path.
///
/// The name is carried rather than re-split off the path, because a folder's *file* is named
/// after it — `Collection/Recently removed/Recently removed.txt` — and splitting a path back
/// apart to recover a name it was just built from is how the two come to disagree. The parent
/// is carried because the deck tree has to know which names each directory has already handed
/// out before it can name the decks that land there too.
struct Placed {
    id: i64,
    parent: Option<i64>,
    path: String,
    name: String,
}

/// Join a directory prefix to a segment, with `""` meaning "at the root of this cabinet".
fn join(prefix: &str, segment: &str) -> String {
    if prefix.is_empty() {
        segment.to_owned()
    } else {
        format!("{prefix}/{segment}")
    }
}

/// The seven file names one list writes into its own directory.
///
/// **Not a second spelling of what a file is called.** [`super::paths::file_name`] is the only
/// one of those, and this is that function swept over [`Format::ALL`] — the same sweep
/// [`super::paths::is_ours`] makes, so what the pruner claims and what the layout plans are one
/// list computed twice rather than two lists that can drift apart.
///
/// They are **reserved against that directory's sub-folders**. A reader's folder called
/// `Collection.csv` sanitises to exactly the name the whole-collection CSV takes, and Windows
/// will not hold a file and a directory of one name in one parent; the app's file is not
/// negotiable, so the folder is what takes a suffix. Unlikely, and one line — the alternative
/// is a pass that fails to create a directory and can say only that the path exists.
fn own_files(stem: &str) -> Vec<String> {
    Format::ALL.iter().map(|&f| file_name(stem, f)).collect()
}

/// Assign disk names to one directory's children, with the names already claimed there going
/// first.
///
/// [`disambiguate`] has no notion of a name already taken, and needs none: a reserved name is
/// simply the **first claimant**, so prepending it and dropping its answer is the same
/// computation. `i64::MIN` is what says the app got there first — that function never reads an
/// id, and the order is what an id *means* to it.
fn name_children(reserved: &[String], rows: &Named) -> Vec<String> {
    let mut all: Named = reserved.iter().map(|n| (i64::MIN, n.clone())).collect();
    all.extend(rows.iter().cloned());
    disambiguate(&all).split_off(reserved.len())
}

/// Add every directory on the way to `path`, but not `path` itself.
fn insert_ancestors(into: &mut BTreeSet<String>, path: &str) {
    let mut dir = path;
    while let Some((parent, _)) = dir.rsplit_once('/') {
        into.insert(parent.to_owned());
        dir = parent;
    }
}

/// The plan under construction.
///
/// It gathers the files **and** what each directory names its files after, because the two are
/// learned in the same breath and neither can be recovered from the other later.
#[derive(Default)]
struct Planner {
    files: Vec<PlannedFile>,
    /// Directory path to the stem its files take. **A directory absent from this map claims
    /// nothing**, which is how a container ends up with `stem: None` without anything having to
    /// list the containers.
    stems: HashMap<String, String>,
    /// Directories the mirror owns that hold no *planned* file: the two deck-tree roots, the
    /// deck folders, and the `Theory` of a deck whose switch is off. Everything else is derived
    /// from the files at [`Planner::finish`].
    bare: Vec<String>,
}

impl Planner {
    /// Write the seven files of one list — one per [`Format::ALL`] — into a directory.
    fn seven(&mut self, dir: &str, stem: &str, surface: Surface, source: &Source) {
        for format in Format::ALL {
            self.files.push(PlannedFile {
                path: join(dir, &file_name(stem, format)),
                format,
                surface,
                source: source.clone(),
            });
        }
        self.stems.insert(dir.to_owned(), stem.to_owned());
    }

    /// Claim a **container**: a directory the mirror owns that holds only other directories.
    /// It gets no stem, so a pass will never delete a file a reader put inside it.
    fn container(&mut self, dir: &str) {
        self.bare.push(dir.to_owned());
    }

    /// Claim a directory that holds no *planned* file but whose files, if any are on disk, are
    /// still the mirror's. There is exactly one: a deck's `Theory` with the switch off.
    fn owns_stemmed(&mut self, dir: &str, stem: &str) {
        self.stems.insert(dir.to_owned(), stem.to_owned());
        self.bare.push(dir.to_owned());
    }

    /// **Every directory on the way to a planned file is one the mirror creates**, so it is one
    /// the mirror owns; deriving those rather than declaring them is what keeps the two halves
    /// of a [`Plan`] from disagreeing about which directories exist.
    fn finish(self) -> Plan {
        let Planner { files, stems, bare } = self;
        let mut paths: BTreeSet<String> = BTreeSet::new();
        // The mirror root. It holds `README.txt` and nothing else of ours, so it is owned with
        // no stem — which puts the one file that explains the folder behind this rule as well
        // as behind the pruner's own exemption for it.
        paths.insert(String::new());
        for file in &files {
            insert_ancestors(&mut paths, &file.path);
        }
        for dir in &bare {
            paths.insert(dir.clone());
            insert_ancestors(&mut paths, dir);
        }
        let dirs = paths
            .into_iter()
            .map(|path| {
                let stem = stems.get(&path).cloned();
                OwnedDir { path, stem }
            })
            .collect();
        Plan { files, dirs }
    }
}

/// Every folder's directory path, breadth-first from the roots.
///
/// `reserved` is asked, for each directory the walk reaches, what that directory already
/// holds — `None` at the cabinet's own root, `Some(stem)` inside a folder of that name. The
/// answers claim their names before any child folder does.
///
/// **Reachability from a root is the whole of the walk, and it answers two of the rules at
/// once.** A folder whose `parent_id` names a folder that is not in the slice is not a child
/// of anything the walk reaches, so it and everything beneath it are skipped; and a cycle —
/// 1's parent is 2, 2's parent is 1 — holds no folder whose parent is `None`, so no root
/// reaches it and the queue empties. There is no depth limit and no visited set because
/// neither is needed: every folder sits in exactly one parent's child list, so it is enqueued
/// at most once and the walk is bounded by the slice. **The other shape is the one that needs
/// a guard** — resolving a folder's path by walking *up* to a root never ends on a cycle, and
/// that is the implementation `a_parent_cycle_terminates` stands against.
///
/// **Siblings are disambiguated within their parent**, which is what makes two folders called
/// `Draft` under different parents both `Draft`: a suffix only has to keep one directory
/// listing unambiguous. Each group is sorted **by id**, which is [`disambiguate`]'s contract
/// and the reason the assignment is stable — adding a third `Aggro` never renames the first
/// two, so a reader's shortcut into that folder keeps working.
fn folder_paths(folders: &[Node], reserved: impl Fn(Option<&str>) -> Vec<String>) -> Vec<Placed> {
    let mut children: HashMap<Option<i64>, Named> = HashMap::new();
    for f in folders {
        children
            .entry(f.parent_id)
            .or_default()
            .push((f.id, f.name.clone()));
    }
    for group in children.values_mut() {
        group.sort_by_key(|(id, _)| *id);
    }

    let mut out = Vec::with_capacity(folders.len());
    // (which folder's children, the path of that folder, and its own name — `None` at the root)
    let mut queue: VecDeque<(Option<i64>, String, Option<String>)> = VecDeque::new();
    queue.push_back((None, String::new(), None));

    while let Some((parent, prefix, stem)) = queue.pop_front() {
        let Some(group) = children.get(&parent) else {
            continue;
        };
        let taken = reserved(stem.as_deref());
        for ((id, _), name) in group.iter().zip(name_children(&taken, group)) {
            let path = join(&prefix, &name);
            queue.push_back((Some(*id), path.clone(), Some(name.clone())));
            out.push(Placed {
                id: *id,
                parent,
                path,
                name,
            });
        }
    }

    out
}

/// Plan one cabinet: its whole-list files at the root, then one file set per folder.
///
/// Nothing but folders and this list's own seven files shares a directory here — a deck's
/// group is a `collection_folders` row like any other and comes through the same walk — so
/// [`own_files`] is the whole of what has to be reserved.
fn push_cabinet(
    p: &mut Planner,
    root: &str,
    surface: Surface,
    whole: Source,
    folders: &[Node],
    folder_source: impl Fn(i64) -> Source,
) {
    p.seven(root, root, surface, &whole);
    for placed in folder_paths(folders, |stem| own_files(stem.unwrap_or(root))) {
        p.seven(
            &join(root, &placed.path),
            &placed.name,
            surface,
            &folder_source(placed.id),
        );
    }
}

/// Every file the mirror intends to exist, and every directory it owns, given what is in the
/// database.
///
/// The order is deterministic — live decks, archived decks, the collection, the wishlist, and
/// within each the folder tree breadth-first and the seven formats in [`Format::ALL`]'s own
/// order. Nothing downstream is documented to depend on it, but a plan that reshuffled between
/// two passes over one unchanged database would make the diff of a pass unreadable.
pub fn plan_files(shape: &Shape) -> Plan {
    let mut p = Planner::default();

    // Both deck trees are the *same* folder tree — `Decks/Archived/` mirrors it rather than
    // flattening it — so the walk happens once and the two roots re-use its answer.
    //
    // **`Archived` is reserved at that root, in both trees.** It is the mirror's own name for
    // the top of the deck cabinet, and a reader's folder of that name would otherwise write
    // into the very directory the archived tree lives in — two different things filling one
    // listing, which a prune could not then tell apart. Reserving it in *both* roots rather
    // than only in the live one is what keeps the folder tree identical under `Decks/` and
    // under `Decks/Archived/`; a tree that renamed a folder depending on which side you looked
    // at it from would be the same folder wearing two names.
    let deck_folders: Vec<Node> = shape
        .deck_folders
        .iter()
        .map(|f| Node {
            id: f.id,
            parent_id: f.parent_id,
            name: f.name.clone(),
        })
        .collect();
    let placed = folder_paths(&deck_folders, |stem| match stem {
        None => vec![ARCHIVED_DIR.to_owned()],
        Some(_) => Vec::new(),
    });
    let known: HashSet<i64> = placed.iter().map(|p| p.id).collect();

    // **A deck and a deck folder are both directories in one listing, so they are named
    // together — folders first, then decks, each by id.** Two independent passes would each
    // hand out the bare name and a deck called `Old` beside a folder called `Old` would be one
    // directory holding both.
    //
    // Folders going first is the deliberate half. It makes a folder's disk name independent of
    // the decks around it, which buys three things: the tree is the same under `Decks/` and
    // `Decks/Archived/` even though the decks in it are not; archiving a deck can never rename
    // a folder; and the item that keeps the bare name is the one whose renaming would move a
    // whole sub-tree rather than one deck's seven files.
    let mut claimed: HashMap<Option<i64>, Vec<String>> = HashMap::new();
    claimed.insert(None, vec![ARCHIVED_DIR.to_owned()]);
    for p in &placed {
        claimed.entry(p.parent).or_default().push(p.name.clone());
    }

    // **A deck whose folder did not survive the walk is planted at the root of its tree
    // rather than dropped**, which is where this parts company with the folders. A folder
    // *is* a path, and a path that cannot be built has no answer; a deck is a thing the
    // reader made, and the mirror's whole promise is that it is on disk somewhere.
    // `decks.folder_id` is a real foreign key with `ON DELETE SET NULL`, so no command can
    // reach this — it is what the mirror does with a database repaired by hand.
    let mut by_folder: HashMap<DeckSlot, Named> = HashMap::new();
    for deck in shape.decks {
        let folder = deck.folder_id.filter(|id| known.contains(id));
        by_folder
            .entry((deck.archived, folder))
            .or_default()
            .push((deck.id, deck.name.clone()));
    }
    for group in by_folder.values_mut() {
        group.sort_by_key(|(id, _)| *id);
    }
    let theory: HashMap<i64, bool> = shape
        .decks
        .iter()
        .map(|d| (d.id, d.theory_enabled))
        .collect();

    for archived in [false, true] {
        let root = if archived {
            join(DECKS_DIR, ARCHIVED_DIR)
        } else {
            DECKS_DIR.to_owned()
        };
        p.container(&root);
        // The root of the tree first, then each folder in the walk's own order, so a deck's
        // place in the plan follows its place in the reader's cabinet.
        let dirs = std::iter::once((None, root.clone()))
            .chain(placed.iter().map(|p| (Some(p.id), join(&root, &p.path))));

        for (folder, dir) in dirs {
            if folder.is_some() {
                // A deck folder is a directory the mirror owns even when no deck is filed
                // there: it is still the reader's folder, and a pass that did not know it was
                // ours could never remove it once emptied.
                p.container(&dir);
            }
            let Some(group) = by_folder.get(&(archived, folder)) else {
                continue;
            };
            let taken = claimed.get(&folder).cloned().unwrap_or_default();
            for ((id, _), name) in group.iter().zip(name_children(&taken, group)) {
                // A deck is a directory rather than a file stem, because seven files belong
                // together.
                let deck_dir = join(&dir, &name);
                p.seven(
                    &deck_dir,
                    &name,
                    Surface::Deck,
                    &Source::Deck {
                        id: *id,
                        variant: crate::schema::DECK_VARIANTS[0],
                    },
                );
                // **The live set is written whatever the switch says.** A deck that keeps a
                // plan has two lists, and the one that is sleeved up does not stop existing
                // because the other was switched on.
                //
                // **And the `Theory` directory is owned whatever the switch says**, which is
                // the other half of the same sentence. A list switched off leaves seven files
                // on disk that nothing plans, and they are named after the deck rather than
                // after the directory holding them — so this is the only moment anything can
                // tell a pass what to claim there.
                let theory_dir = join(&deck_dir, THEORY_DIR);
                if theory.get(id).copied().unwrap_or(false) {
                    p.seven(
                        &theory_dir,
                        &name,
                        Surface::Deck,
                        &Source::Deck {
                            id: *id,
                            variant: crate::schema::DECK_VARIANTS[1],
                        },
                    );
                } else {
                    p.owns_stemmed(&theory_dir, &name);
                }
            }
        }
    }

    let collection: Vec<Node> = shape
        .collection_folders
        .iter()
        .map(|f| Node {
            id: f.id,
            parent_id: f.parent_id,
            name: f.name.clone(),
        })
        .collect();
    push_cabinet(
        &mut p,
        COLLECTION_DIR,
        Surface::Collection,
        Source::WholeCollection,
        &collection,
        |id| Source::CollectionFolder { id },
    );

    let wishlist: Vec<Node> = shape
        .wishlist_folders
        .iter()
        .map(|f| Node {
            id: f.id,
            parent_id: f.parent_id,
            name: f.name.clone(),
        })
        .collect();
    push_cabinet(
        &mut p,
        WISHLIST_DIR,
        Surface::Wishlist,
        Source::WholeWishlist,
        &wishlist,
        |id| Source::WishlistFolder { id },
    );

    p.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collection_folders::CollectionFolder;
    use crate::deck::DeckRow;
    use crate::deck_meta::DeckFolderRow;
    use crate::wishlist_folders::WishlistFolder;

    /// The rows a [`Shape`] borrows, owned, so a builder can hand one back.
    ///
    /// `Shape` holds slices and a builder cannot return one — the vectors would die with the
    /// call. This is that shape one indirection down, and [`Rows::shape`] is the borrow.
    #[derive(Default)]
    struct Rows {
        decks: Vec<DeckRow>,
        deck_folders: Vec<DeckFolderRow>,
        collection_folders: Vec<CollectionFolder>,
        wishlist_folders: Vec<WishlistFolder>,
    }

    impl Rows {
        fn shape(&self) -> Shape<'_> {
            Shape {
                decks: &self.decks,
                deck_folders: &self.deck_folders,
                collection_folders: &self.collection_folders,
                wishlist_folders: &self.wishlist_folders,
            }
        }

        fn plan(&self) -> Vec<PlannedFile> {
            plan_files(&self.shape()).files
        }

        fn dirs(&self) -> Vec<OwnedDir> {
            plan_files(&self.shape()).dirs
        }
    }

    /// A deck row good enough for the layout: the real struct, with everything the layout does
    /// not read set to something a fresh deck would carry. The four fields it *does* read —
    /// `id`, `name`, `archived`, `folder_id`, `theory_enabled` — are overridden per test with
    /// `..deck(…)`, so a field added to `DeckRow` fails here once rather than in every builder.
    fn deck(id: i64, name: &str) -> DeckRow {
        DeckRow {
            id,
            name: name.to_owned(),
            format_key: "commander".to_owned(),
            format_name: Some("Commander".to_owned()),
            game_key: "any".to_owned(),
            description: None,
            cover_card_id: None,
            cover_kind: "card_art".to_owned(),
            cover_artist: None,
            archived: false,
            card_count: 0,
            updated_at: 0,
            folder_id: None,
            notes: None,
            theory_enabled: false,
            separate_x_group: false,
            default_category_id: 0,
            last_variant: "live".to_owned(),
            last_group_by: "category".to_owned(),
            last_sort_by: "alphabetical".to_owned(),
        }
    }

    fn deck_folder(id: i64, parent_id: Option<i64>, name: &str) -> DeckFolderRow {
        DeckFolderRow {
            id,
            parent_id,
            name: name.to_owned(),
            sort_order: 0,
        }
    }

    fn user_folder(id: i64, parent_id: Option<i64>, name: &str) -> CollectionFolder {
        CollectionFolder {
            id,
            parent_id,
            name: name.to_owned(),
            kind: "user".to_owned(),
            deck_id: None,
            sort_order: 0,
        }
    }

    fn wish_folder(id: i64, parent_id: Option<i64>, name: &str) -> WishlistFolder {
        WishlistFolder {
            id,
            parent_id,
            name: name.to_owned(),
            sort_order: 0,
        }
    }

    fn paths(plan: &[PlannedFile]) -> Vec<&str> {
        plan.iter().map(|f| f.path.as_str()).collect()
    }

    /// Just the files a *deck* put in the plan.
    ///
    /// The two whole lists are unconditional — a reader with no folders still has a collection
    /// and a wishlist — so `plan.len()` is never the deck's own count, and a test that wants to
    /// say "seven files, one per format" has to say which seven.
    fn deck_paths(plan: &[PlannedFile]) -> Vec<&str> {
        plan.iter()
            .filter(|f| f.surface == Surface::Deck)
            .map(|f| f.path.as_str())
            .collect()
    }

    fn sorted(mut v: Vec<&str>) -> Vec<&str> {
        v.sort_unstable();
        v
    }

    fn shape_with_one_deck(name: &str) -> Rows {
        Rows {
            decks: vec![deck(1, name)],
            ..Rows::default()
        }
    }

    fn shape_with_theory_deck(name: &str) -> Rows {
        Rows {
            decks: vec![DeckRow {
                theory_enabled: true,
                ..deck(1, name)
            }],
            ..Rows::default()
        }
    }

    fn shape_with_archived_deck_in_folder(folder: &str, name: &str) -> Rows {
        Rows {
            decks: vec![DeckRow {
                archived: true,
                folder_id: Some(3),
                ..deck(1, name)
            }],
            deck_folders: vec![deck_folder(3, None, folder)],
            ..Rows::default()
        }
    }

    /// The cabinet as schema v25 leaves it: the one `removed` folder, one `deck` group, and a
    /// folder the reader made.
    fn shape_with_collection_folders() -> Rows {
        Rows {
            collection_folders: vec![
                CollectionFolder {
                    kind: "removed".to_owned(),
                    ..user_folder(1, None, "Recently removed")
                },
                CollectionFolder {
                    kind: "deck".to_owned(),
                    deck_id: Some(7),
                    ..user_folder(2, None, "Azula")
                },
                user_folder(3, None, "Binder"),
            ],
            ..Rows::default()
        }
    }

    fn shape_with_two_draft_folders() -> Rows {
        Rows {
            collection_folders: vec![
                user_folder(1, None, "Red"),
                user_folder(2, None, "Blue"),
                user_folder(3, Some(1), "Draft"),
                user_folder(4, Some(2), "Draft"),
            ],
            ..Rows::default()
        }
    }

    fn shape_with_orphan_folder() -> Rows {
        Rows {
            collection_folders: vec![
                user_folder(1, None, "Binder"),
                user_folder(2, Some(99), "Orphan"),
                user_folder(3, Some(2), "Orphan child"),
            ],
            ..Rows::default()
        }
    }

    /// 1 -> 2 -> 1. The schema's `ON DELETE CASCADE` should make this impossible; the layout
    /// still has to be handed one and come back.
    fn shape_with_folder_cycle() -> Rows {
        Rows {
            collection_folders: vec![
                user_folder(1, Some(2), "Loop A"),
                user_folder(2, Some(1), "Loop B"),
            ],
            ..Rows::default()
        }
    }

    /// Names chosen to collide every way the layout has to survive: a deck and a folder
    /// both called `Archived` at the deck root, a deck named after its own folder, and
    /// folders named exactly like files their parent writes beside them.
    fn adversarial_shape() -> Rows {
        Rows {
            decks: vec![
                deck(1, "Archived"),
                DeckRow {
                    folder_id: Some(2),
                    theory_enabled: true,
                    ..deck(2, "Azula")
                },
                DeckRow {
                    archived: true,
                    folder_id: Some(1),
                    ..deck(3, "Azula")
                },
            ],
            deck_folders: vec![
                deck_folder(1, None, "Archived"),
                deck_folder(2, None, "Azula"),
            ],
            collection_folders: vec![
                user_folder(1, None, "Collection.csv"),
                user_folder(2, None, "Binder"),
                user_folder(3, Some(2), "Binder.txt"),
            ],
            wishlist_folders: vec![wish_folder(1, None, "Wishlist.txt")],
        }
    }

    #[test]
    fn a_theory_directory_is_owned_with_the_decks_stem_even_when_the_switch_is_off() {
        let rows = shape_with_one_deck("Azula");
        let plan = plan_files(&rows.shape());
        assert!(
            !plan.files.iter().any(|f| f.path.contains("/Theory/")),
            "the switch is off, so not one theory file is planned"
        );
        let dir = plan
            .dirs
            .iter()
            .find(|d| d.path == "Decks/Azula/Theory")
            .expect("the directory is owned all the same");
        let stem = dir
            .stem
            .as_deref()
            .expect("and it claims files, unlike a container");
        assert_eq!(
            stem, "Azula",
            "its files are named after the deck, never after `Theory`"
        );
        assert!(
            crate::mirror::paths::is_ours("Azula.archidekt.txt", stem),
            "which is the whole point: a pass can claim the files of a list since switched off"
        );
    }

    #[test]
    fn every_planned_file_sits_in_an_owned_directory_that_claims_it() {
        let rows = adversarial_shape();
        let plan = plan_files(&rows.shape());
        let owned: HashMap<&str, Option<&str>> = plan
            .dirs
            .iter()
            .map(|d| (d.path.as_str(), d.stem.as_deref()))
            .collect();
        for file in &plan.files {
            let (dir, name) = file
                .path
                .rsplit_once('/')
                .expect("every planned file is inside a directory");
            let stem = owned
                .get(dir)
                .unwrap_or_else(|| panic!("{dir} is not an owned directory"))
                .unwrap_or_else(|| {
                    panic!("{dir} claims nothing, yet {} is planned in it", file.path)
                });
            assert!(
                crate::mirror::paths::is_ours(name, stem),
                "a pass could not claim its own file {}",
                file.path
            );
        }

        // ...and the converse, which is what leaves the two halves of a `Plan` no room to
        // disagree: a directory that claims nothing has nothing of ours planned in it.
        for dir in plan.dirs.iter().filter(|d| d.stem.is_none()) {
            assert!(
                !plan
                    .files
                    .iter()
                    .any(|f| f.path.rsplit_once('/').map(|(d, _)| d) == Some(dir.path.as_str())),
                "{} claims no file, yet one is planned directly inside it",
                dir.path
            );
        }
    }

    #[test]
    fn the_deck_roots_and_every_deck_folder_are_owned_even_with_no_deck_in_them() {
        let rows = Rows {
            deck_folders: vec![
                deck_folder(1, None, "Standard"),
                deck_folder(2, Some(1), "Old"),
            ],
            ..Rows::default()
        };
        let dirs = rows.dirs();
        assert_eq!(
            dirs.iter()
                .map(|d| (d.path.as_str(), d.stem.as_deref()))
                .collect::<Vec<_>>(),
            [
                ("", None),
                ("Collection", Some("Collection")),
                ("Decks", None),
                ("Decks/Archived", None),
                ("Decks/Archived/Standard", None),
                ("Decks/Archived/Standard/Old", None),
                ("Decks/Standard", None),
                ("Decks/Standard/Old", None),
                ("Wishlist", Some("Wishlist")),
            ],
            "a folder holding no deck is still the reader's folder and still ours to empty, \
             and every container claims nothing"
        );
    }

    #[test]
    fn a_deck_folder_claims_nothing_so_a_readers_file_inside_it_survives() {
        let rows = Rows {
            decks: vec![DeckRow {
                folder_id: Some(1),
                ..deck(1, "Azula")
            }],
            deck_folders: vec![deck_folder(1, None, "Standard")],
            ..Rows::default()
        };
        let dirs = rows.dirs();
        let at = |path: &str| {
            dirs.iter()
                .find(|d| d.path == path)
                .unwrap_or_else(|| panic!("{path} is not owned"))
                .stem
                .clone()
        };
        assert_eq!(
            at("Decks/Standard"),
            None,
            "a deck folder is a container: `Standard.csv` dropped in there is the reader's, \
             and naming it after itself would have deleted exactly that file"
        );
        for container in ["", "Decks", "Decks/Archived"] {
            assert_eq!(at(container), None, "{container} holds only directories");
        }
        assert_eq!(
            at("Decks/Standard/Azula").as_deref(),
            Some("Azula"),
            "the deck's own directory does hold seven of ours"
        );
    }

    #[test]
    fn owned_directories_are_sorted_and_unique() {
        let rows = adversarial_shape();
        let dirs = rows.dirs();
        let paths: Vec<&str> = dirs.iter().map(|d| d.path.as_str()).collect();
        let mut expected = paths.clone();
        expected.sort_unstable();
        expected.dedup();
        assert_eq!(
            paths, expected,
            "a parent has to precede its children, and appear once"
        );
    }

    #[test]
    fn a_deck_gets_seven_files_and_the_plain_one_carries_no_format_segment() {
        let rows = shape_with_one_deck("Azula");
        let plan = rows.plan();
        let paths = paths(&plan);
        assert!(paths.contains(&"Decks/Azula/Azula.txt"));
        assert!(paths.contains(&"Decks/Azula/Azula.archidekt.txt"));
        assert!(paths.contains(&"Decks/Azula/Azula.csv"));
        assert_eq!(
            sorted(deck_paths(&plan)),
            [
                "Decks/Azula/Azula.archidekt.txt",
                "Decks/Azula/Azula.arena.txt",
                "Decks/Azula/Azula.csv",
                "Decks/Azula/Azula.moxfield.txt",
                "Decks/Azula/Azula.mtgo.txt",
                "Decks/Azula/Azula.tcgplayer.txt",
                "Decks/Azula/Azula.txt",
            ],
            "seven files, and only plain and csv go without a format segment"
        );
        assert_eq!(
            plan.len(),
            7 + 14,
            "plus the collection's and the wishlist's own lists, which are unconditional"
        );
    }

    #[test]
    fn a_theory_list_is_a_second_set_beneath_the_deck_and_the_live_one_stays() {
        let rows = shape_with_theory_deck("Azula");
        let plan = rows.plan();
        assert_eq!(deck_paths(&plan).len(), 14);
        assert!(plan.iter().any(|f| f.path == "Decks/Azula/Theory/Azula.txt"
            && f.source
                == Source::Deck {
                    id: 1,
                    variant: "theory"
                }));
        assert!(plan.iter().any(|f| f.path == "Decks/Azula/Azula.txt"
            && f.source
                == Source::Deck {
                    id: 1,
                    variant: "live"
                }));
    }

    #[test]
    fn an_archived_deck_keeps_its_folder_tree_beneath_archived() {
        let rows = shape_with_archived_deck_in_folder("Old", "Azula");
        let plan = rows.plan();
        assert!(plan
            .iter()
            .any(|f| f.path == "Decks/Archived/Old/Azula/Azula.txt"));
        assert!(
            !deck_paths(&plan)
                .iter()
                .any(|p| p.starts_with("Decks/Old/")),
            "an archived deck is under Archived and nowhere else"
        );
    }

    #[test]
    fn the_collections_own_list_and_one_file_per_folder_including_the_automatic_ones() {
        let rows = shape_with_collection_folders();
        let plan = rows.plan();
        assert!(plan
            .iter()
            .any(|f| f.path == "Collection/Collection.csv" && f.source == Source::WholeCollection));
        assert!(plan
            .iter()
            .any(|f| f.path == "Collection/Recently removed/Recently removed.txt"));
        assert!(
            plan.iter().any(|f| f.path.starts_with("Collection/Azula/")),
            "a deck group is a folder like any other"
        );
        assert!(
            plan.iter().any(|f| f.path == "Collection/Binder/Binder.txt"
                && f.source == Source::CollectionFolder { id: 3 }),
            "a folder's file is named after the folder and carries its id"
        );
    }

    #[test]
    fn two_folders_of_one_name_under_different_parents_are_both_themselves() {
        let rows = shape_with_two_draft_folders();
        let plan = rows.plan();
        assert!(plan
            .iter()
            .any(|f| f.path == "Collection/Red/Draft/Draft.txt"));
        assert!(plan
            .iter()
            .any(|f| f.path == "Collection/Blue/Draft/Draft.txt"));
        assert!(
            !paths(&plan).iter().any(|p| p.contains("Draft (2)")),
            "the suffix only has to keep one directory listing unambiguous"
        );
    }

    #[test]
    fn two_folders_of_one_name_under_one_parent_are_numbered_by_id() {
        let rows = Rows {
            collection_folders: vec![user_folder(9, None, "Draft"), user_folder(2, None, "Draft")],
            ..Rows::default()
        };
        let plan = rows.plan();
        // The order the caller handed them over is not the order they are named in: the
        // lower id keeps the bare name, so adding a third never renames the first two.
        assert!(plan.iter().any(|f| f.path == "Collection/Draft/Draft.txt"
            && f.source == Source::CollectionFolder { id: 2 }));
        assert!(plan
            .iter()
            .any(|f| f.path == "Collection/Draft (2)/Draft (2).txt"
                && f.source == Source::CollectionFolder { id: 9 }));
    }

    #[test]
    fn a_folder_whose_parent_is_missing_is_skipped_rather_than_planted_at_the_root() {
        let rows = shape_with_orphan_folder();
        let plan = rows.plan();
        assert!(!plan.iter().any(|f| f.path.contains("Orphan")));
        assert!(
            plan.iter()
                .any(|f| f.path == "Collection/Binder/Binder.txt"),
            "and its siblings are untouched"
        );
    }

    #[test]
    fn a_parent_cycle_terminates() {
        let rows = shape_with_folder_cycle();
        let plan = rows.plan();
        assert!(
            plan.len() < 1000,
            "a cycle must terminate rather than recurse"
        );
        assert!(
            !paths(&plan).iter().any(|p| p.contains("Loop")),
            "a folder no root reaches is not planted at the root either"
        );
    }

    // Everything below is this task's own, beyond the brief's seven.

    #[test]
    fn an_empty_database_still_plans_both_whole_lists() {
        let plan = Rows::default().plan();
        assert_eq!(
            sorted(paths(&plan)),
            [
                "Collection/Collection.archidekt.txt",
                "Collection/Collection.arena.txt",
                "Collection/Collection.csv",
                "Collection/Collection.moxfield.txt",
                "Collection/Collection.mtgo.txt",
                "Collection/Collection.tcgplayer.txt",
                "Collection/Collection.txt",
                "Wishlist/Wishlist.archidekt.txt",
                "Wishlist/Wishlist.arena.txt",
                "Wishlist/Wishlist.csv",
                "Wishlist/Wishlist.moxfield.txt",
                "Wishlist/Wishlist.mtgo.txt",
                "Wishlist/Wishlist.tcgplayer.txt",
                "Wishlist/Wishlist.txt",
            ],
            "a reader who owns nothing still gets a mirror that says so"
        );
    }

    #[test]
    fn the_wishlist_mirrors_the_collections_shape() {
        let rows = Rows {
            wishlist_folders: vec![
                wish_folder(4, None, "Buy soon"),
                wish_folder(5, Some(4), "Bolts"),
            ],
            ..Rows::default()
        };
        let plan = rows.plan();
        assert!(plan
            .iter()
            .any(|f| f.path == "Wishlist/Wishlist.txt" && f.source == Source::WholeWishlist));
        assert!(plan
            .iter()
            .any(|f| f.path == "Wishlist/Buy soon/Bolts/Bolts.csv"
                && f.source == Source::WishlistFolder { id: 5 }));
        assert!(
            plan.iter()
                .all(|f| f.surface != Surface::Wishlist || f.path.starts_with("Wishlist/")),
            "a wishlist file never escapes its cabinet"
        );
    }

    #[test]
    fn two_decks_of_one_name_in_one_folder_are_numbered_by_id() {
        let rows = Rows {
            decks: vec![deck(9, "Aggro"), deck(2, "Aggro")],
            ..Rows::default()
        };
        let plan = rows.plan();
        // Assigned by id and not by the order the caller happened to hand them over, so
        // adding a third `Aggro` never renames the first two.
        assert!(plan.iter().any(|f| f.path == "Decks/Aggro/Aggro.txt"
            && f.source
                == Source::Deck {
                    id: 2,
                    variant: "live"
                }));
        assert!(plan
            .iter()
            .any(|f| f.path == "Decks/Aggro (2)/Aggro (2).txt"
                && f.source
                    == Source::Deck {
                        id: 9,
                        variant: "live"
                    }));
    }

    #[test]
    fn an_archived_deck_never_numbers_a_live_one_of_the_same_name() {
        let rows = Rows {
            decks: vec![
                deck(1, "Aggro"),
                DeckRow {
                    archived: true,
                    ..deck(2, "Aggro")
                },
            ],
            ..Rows::default()
        };
        let plan = rows.plan();
        assert!(plan.iter().any(|f| f.path == "Decks/Aggro/Aggro.txt"));
        assert!(plan
            .iter()
            .any(|f| f.path == "Decks/Archived/Aggro/Aggro.txt"));
        assert!(
            !paths(&plan).iter().any(|p| p.contains("Aggro (2)")),
            "the two trees are two directory listings"
        );
    }

    #[test]
    fn every_reader_supplied_segment_is_sanitised_and_the_apps_own_words_are_not() {
        let rows = Rows {
            decks: vec![DeckRow {
                folder_id: Some(1),
                theory_enabled: true,
                ..deck(4, "Red/Blue: Aggro?")
            }],
            deck_folders: vec![deck_folder(1, None, "CON")],
            ..Rows::default()
        };
        let plan = rows.plan();
        assert!(plan
            .iter()
            .any(|f| f.path == "Decks/CON_/Red-Blue- Aggro-/Theory/Red-Blue- Aggro-.mtgo.txt"));
        assert!(
            paths(&plan)
                .iter()
                .all(|p| !p.contains('\\') && !p.contains(':')),
            "nothing Windows refuses survives into a path"
        );
    }

    #[test]
    fn a_deck_whose_folder_is_gone_is_planted_at_the_root_rather_than_dropped() {
        let rows = Rows {
            decks: vec![DeckRow {
                folder_id: Some(404),
                ..deck(1, "Azula")
            }],
            ..Rows::default()
        };
        let plan = rows.plan();
        assert!(
            plan.iter().any(|f| f.path == "Decks/Azula/Azula.txt"),
            "a folder is a path and can have no answer; a deck is a thing and must be somewhere"
        );
    }

    #[test]
    fn no_two_planned_files_claim_one_path() {
        let rows = Rows {
            decks: vec![
                deck(1, "Azula"),
                DeckRow {
                    theory_enabled: true,
                    folder_id: Some(1),
                    ..deck(2, "Azula")
                },
                DeckRow {
                    archived: true,
                    folder_id: Some(2),
                    ..deck(3, "Azula")
                },
                deck(4, "Azula"),
            ],
            deck_folders: vec![
                deck_folder(1, None, "Azula"),
                deck_folder(2, Some(1), "Azula"),
            ],
            collection_folders: vec![
                user_folder(1, None, "Azula"),
                user_folder(2, Some(1), "Azula"),
            ],
            wishlist_folders: vec![wish_folder(1, None, "Azula")],
        };
        let plan = rows.plan();
        let mut seen = std::collections::HashSet::new();
        for file in &plan {
            assert!(
                seen.insert(file.path.to_lowercase()),
                "two files would land on {} — NTFS keeps one",
                file.path
            );
        }
        assert!(plan.len() > 14);
    }

    #[test]
    fn a_reader_folder_called_archived_is_moved_aside_rather_than_merged() {
        let rows = Rows {
            decks: vec![
                DeckRow {
                    folder_id: Some(1),
                    ..deck(1, "Azula")
                },
                DeckRow {
                    archived: true,
                    folder_id: Some(1),
                    ..deck(2, "Katara")
                },
            ],
            deck_folders: vec![deck_folder(1, None, "Archived")],
            ..Rows::default()
        };
        let plan = rows.plan();
        assert!(
            plan.iter()
                .any(|f| f.path == "Decks/Archived (2)/Azula/Azula.txt"),
            "the reader's folder moves aside; the directory the mirror owns does not"
        );
        assert!(
            plan.iter()
                .any(|f| f.path == "Decks/Archived/Archived (2)/Katara/Katara.txt"),
            "and it wears the same name inside the archived tree, which is the same tree"
        );
        assert!(
            !plan
                .iter()
                .any(|f| f.path.starts_with("Decks/Archived/Azula/")),
            "nothing of the reader's is written straight into Decks/Archived/"
        );
    }

    #[test]
    fn a_deck_and_a_folder_of_one_name_are_named_together_and_the_folder_keeps_it() {
        let rows = Rows {
            decks: vec![
                deck(1, "Old"),
                DeckRow {
                    folder_id: Some(5),
                    ..deck(2, "Bolt")
                },
            ],
            deck_folders: vec![deck_folder(5, None, "Old")],
            ..Rows::default()
        };
        let plan = rows.plan();
        assert!(
            plan.iter().any(|f| f.path == "Decks/Old/Bolt/Bolt.txt"),
            "folders are named first, so the folder keeps the bare name"
        );
        assert!(
            plan.iter().any(|f| f.path == "Decks/Old (2)/Old (2).txt"),
            "and the deck of the same name takes the suffix, files and all"
        );
    }

    #[test]
    fn folders_are_named_before_decks_so_archiving_one_never_renames_a_folder() {
        let tree = |archived: bool| {
            let rows = Rows {
                decks: vec![
                    DeckRow {
                        archived,
                        ..deck(1, "Old")
                    },
                    DeckRow {
                        folder_id: Some(5),
                        ..deck(2, "Bolt")
                    },
                ],
                deck_folders: vec![deck_folder(5, None, "Old")],
                ..Rows::default()
            };
            rows.plan()
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>()
        };
        for archived in [false, true] {
            assert!(
                tree(archived).contains(&"Decks/Old/Bolt/Bolt.txt".to_owned()),
                "a folder's disk name does not depend on the decks around it"
            );
        }
    }

    #[test]
    fn a_folder_named_like_a_file_the_list_writes_beside_it_takes_a_suffix() {
        let rows = Rows {
            collection_folders: vec![
                user_folder(1, None, "Collection.csv"),
                user_folder(2, None, "Binder"),
                user_folder(3, Some(2), "Binder.txt"),
            ],
            ..Rows::default()
        };
        let plan = rows.plan();
        assert!(
            plan.iter()
                .any(|f| f.path == "Collection/Collection.csv (2)/Collection.csv (2).csv"),
            "Windows holds no file and directory of one name, and the app's file is not movable"
        );
        assert!(
            plan.iter()
                .any(|f| f.path == "Collection/Binder/Binder.txt (2)/Binder.txt (2).txt"),
            "and the rule is per directory, not just at the cabinet's root"
        );
    }

    #[test]
    fn a_deck_called_archived_is_moved_aside_as_well_as_a_folder() {
        let rows = Rows {
            decks: vec![deck(1, "Archived")],
            ..Rows::default()
        };
        let plan = rows.plan();
        assert!(
            plan.iter()
                .any(|f| f.path == "Decks/Archived (2)/Archived (2).txt"),
            "the reserved name is claimed against decks too, not only against folders"
        );
        assert!(
            !plan.iter().any(|f| f.path.starts_with("Decks/Archived/")),
            "nothing of the reader's writes into the directory the archived tree lives in"
        );
    }

    #[test]
    fn no_planned_file_sits_where_another_one_needs_a_directory() {
        let rows = adversarial_shape();
        let plan = rows.plan();
        let files: std::collections::HashSet<String> =
            plan.iter().map(|f| f.path.to_lowercase()).collect();
        for file in &plan {
            let lower = file.path.to_lowercase();
            let mut prefix = String::new();
            for segment in lower.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(segment);
                assert!(
                    prefix == lower || !files.contains(&prefix),
                    "{} needs a directory at {prefix}, where another file is planned",
                    file.path
                );
            }
        }
        assert!(plan.len() > 14);
    }
}
