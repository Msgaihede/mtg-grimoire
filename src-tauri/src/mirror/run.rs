//! The pass: render, hash, write what differs, prune what the mirror no longer intends.
//!
//! This is the only module in the mirror that touches the reader's filesystem, so it is the
//! only one where a mistake costs them a file. Three rules follow from that and every branch
//! below is one of them:
//!
//! - **A pass writes bytes only when they differ from the bytes already there.** The digest is
//!   taken from the file *on disk* the first time a path is seen this session, never from an
//!   empty map — a session that trusted an empty map would rewrite the whole mirror at every
//!   launch, about 10 MB into whatever folder the reader chose, for data that had not changed.
//!   Spec §5, "the digests start from the files on disk".
//! - **A prune deletes from a record of what this app actually wrote, never from a guess about
//!   what it might have written.** That record is [`MANIFEST_NAME`], and it is the whole of
//!   [`prune`]'s authority — see the ruling written out there. A file the reader put in the
//!   root, which may be a Dropbox with a decade of somebody's notes in it, was never in a
//!   manifest we wrote and so can never be claimed by one.
//! - **A pass writes only files the mirror itself put there.** The prune path has always been
//!   fenced against destroying a reader's file; [`put_readme`] is the same fence one function
//!   over, on the only fixed name the mirror writes into a folder the reader chose. A
//!   `README.txt` no manifest of ours has ever named is theirs, and it is counted in
//!   [`PassReport::skipped`] rather than overwritten.
//! - **One file that fails is one file.** A render that errors or a write that is refused
//!   increments [`PassReport::failed`] and the pass carries on. An unwritable file is not a
//!   reason to abandon the other 349.
//!
//! The one thing that fails the whole pass is a root that cannot be created: there is then
//! nowhere to write and nothing to prune, and [`super::settings`]' panel has an error sentence
//! to show for exactly this.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::layout::{plan_files, Plan, PlannedFile, Shape, Source};
use super::paths::is_ours;
use crate::sorting::Marketplace;
use crate::transfer::fields::available_fields;
use crate::transfer::write::format_export;
use crate::transfer::{Card, Surface};

/// The one file in the root that is not an export.
pub const README_NAME: &str = "README.txt";

/// The record of what the last pass intended to exist: one root-relative path per line, `/`
/// separators, LF endings, sorted.
///
/// **It is the pruner's only authority.** It lists every file of the current plan and
/// [`README_NAME`]; it does not list itself, so nothing can ever plan it away.
pub const MANIFEST_NAME: &str = ".mirror-manifest";

/// What the folder says about itself.
///
/// Spec §3.1 and §3.2 fix what has to be in here: what the folder is, that it is generated and
/// rewritten, that edits are overwritten, that the app never reads it back, the two omissions
/// §3.1 names — neither of which is a field the mirror could have switched on — and that
/// deleting the whole root is safe. [`MANIFEST_NAME`] is explained for the same reason: it is a
/// file the reader did not make and will wonder about, and what deleting it costs is exactly
/// one pass's worth of leftovers rather than anything they cannot get back.
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

/// What one pass did. Every field is a number the Settings panel and the tests both read.
///
/// `pruned` counts **entries removed** — both the files the manifest showed were no longer
/// wanted and the directories that were left empty by them — because a reader watching a
/// rename settle wants one number for "what went away", and a directory going away is as much
/// of that as a file is.
///
/// `skipped` counts **files the mirror left alone because they are not its own**, which is a
/// different fact from every other number here: `unchanged` says the bytes on disk are already
/// the bytes we would write, and `failed` says we tried and could not. Neither is true of a
/// `README.txt` the reader already had — see [`put_readme`] — and folding it into either would
/// tell them the folder is finished when a file in it is deliberately not.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassReport {
    pub written: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub pruned: usize,
    pub failed: usize,
}

/// The digest of every file the mirror has written, **and the root they were written under**.
///
/// The root is half the key, and it is a field rather than a note to the caller because that is
/// the difference between an invariant and a habit. The map is keyed by a *plan-relative* path
/// — `Decks/Burn/deck.txt` — which is the same key under every root, so a digest taken at one
/// folder will answer confidently about a completely different folder's copy. [`put`]'s
/// `is_file` check does not save it: presence is not content, and a file that is present at the
/// old root holding the *older* plan reads exactly like one that is up to date.
///
/// That was two bugs, found in that order. The first was patched by having the caller clear the
/// map whenever it noticed the setting had moved, which worked until a live pass found the
/// second: a root moved away and back left the returning folder's manifest untouched and
/// orphaned 21 files for good. Keeping the root *in* the cache makes both impossible rather
/// than remembered — [`run_pass`] aims the cache at its root before it writes anything, and a
/// hit can only ever describe the file the pass is actually about.
#[derive(Debug, Default)]
pub struct DigestCache {
    /// The root the digests below were taken under. Empty before the first pass, which is not
    /// a path any root can have — [`crate::mirror::settings::root`] only ever answers absolute.
    root: PathBuf,
    files: HashMap<String, u64>,
}

impl DigestCache {
    /// Point the cache at the root this pass is about, forgetting everything taken under a
    /// different one.
    ///
    /// A different root is not a *stale* cache, it is an unrelated one: nothing in it describes
    /// a file under this folder, so there is nothing to salvage. What is dropped costs one read
    /// per file the next pass finds already correct, which is the price the very first pass of
    /// a session pays anyway.
    fn aim_at(&mut self, root: &Path) {
        if self.root != root {
            self.files.clear();
            root.clone_into(&mut self.root);
        }
    }

    /// Every path this cache has a digest for. Test-only: production code asks [`put`].
    #[cfg(test)]
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.files.keys().map(String::as_str)
    }

    /// How many files it remembers. Test-only, for the same reason.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.files.len()
    }

    /// Does it remember nothing? Clippy asks for this beside [`len`](Self::len), and it is a
    /// fair ask: "the cache was emptied" is what half the tests around a root change assert.
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

/// Which surfaces this pass is responsible for.
///
/// **It narrows what is *rendered*, never what is *pruned*.** A pass over one surface still
/// prunes against the whole plan; anything else and a deck edit would delete the collection.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Dirty {
    pub decks: bool,
    pub collection: bool,
    pub wishlist: bool,
}

impl Dirty {
    /// Every surface — startup, a finished sync, a finished feed refresh, and the Settings
    /// panel's own button (spec §5).
    pub const ALL: Self = Self {
        decks: true,
        collection: true,
        wishlist: true,
    };

    /// Is this surface one this pass renders?
    pub fn covers(self, surface: Surface) -> bool {
        match surface {
            Surface::Deck => self.decks,
            Surface::Collection => self.collection,
            Surface::Wishlist => self.wishlist,
        }
    }
}

/// Render the dirty surfaces, write what differs, prune what the last manifest shows is no
/// longer wanted, and record the new manifest.
///
/// `cache` is the caller's, not this function's, because a digest is worth keeping between
/// passes and a pass is called every couple of seconds while a reader edits: the map is what
/// turns the steady state into render-and-hash with no reads at all. It maps a plan-relative
/// path to the digest of what is on disk there. A cold map is *correct*, only slower — every
/// miss is answered by reading the file — which is what makes handing a fresh one in a
/// supported thing to do rather than a bug waiting to happen.
///
/// **The manifest is written last, and that ordering is the crash contract.** A pass killed
/// half way leaves a manifest describing a *superset* of what is on disk, which the next pass
/// reconciles by trying to delete a few files that are already gone — a no-op. Written first,
/// the same crash would leave files nothing had any record of, orphaned for good.
///
/// The only `Err` is a root that cannot be created. Everything past that point is counted in
/// [`PassReport::failed`] and survived.
pub fn run_pass(
    conn: &Connection,
    root: &Path,
    dirty: Dirty,
    cache: &mut DigestCache,
) -> Result<PassReport, String> {
    // First, and before the four reads: if the stick is unplugged there is no point asking the
    // database for 350 files' worth of rows to discover it.
    std::fs::create_dir_all(root).map_err(|e| {
        format!(
            "the backup folder {} could not be created: {e}",
            root.display()
        )
    })?;

    // The previous manifest, read **once** and used three times: it decides whether this pass
    // is owed a full render, whether `README.txt` in this folder is ours to overwrite, and what
    // [`prune`] is authorised to delete. Reading it once is what keeps those three answers from
    // being about three different moments.
    let previous = read_manifest(root);

    // **A missing manifest under a root that exists means the mirror was reset.**
    //
    // It is the one file every pass writes and no plan can ever leave out, so its absence is
    // not ambiguous: either this is the first pass over this folder, or somebody deleted the
    // whole folder while the app was running. `create_dir_all` above has just quietly put an
    // empty directory back, so **no failure arm fires and nothing else notices**; a live pass
    // measured 93 of 100 files returning and `Wishlist/` never coming back, because the dirty
    // mask only ever named the surface the reader's next edit happened to touch. `README.txt`
    // promises them that deleting this folder is safe, and this is what makes that true.
    //
    // **A reader who deletes one deck's directory rather than all of it is NOT covered by
    // this**, and the sentence that said it was is the reason this one is long: the manifest
    // sits at the root, so `Decks/Azula/` going away leaves the sentinel intact and no
    // escalation fires. That subtree comes back on the next pass that happens to have `decks`
    // dirty, or at the next startup, which takes a full mask of its own.
    let dirty = if previous.is_some() {
        dirty
    } else {
        Dirty::ALL
    };

    // Before anything is written: a cache carried over from a different root describes another
    // folder's files entirely, and `put`'s `is_file` check cannot tell that apart from a file
    // that is up to date. See [`DigestCache`].
    cache.aim_at(root);
    let cache = &mut cache.files;

    let decks = crate::deck::list_decks(conn)?;
    let deck_folders = crate::deck_meta::list_folders(conn)?;
    let collection_folders = crate::collection_folders::list_folders(conn)?;
    let wishlist_folders = crate::wishlist_folders::list_folders(conn)?;
    let plan = plan_files(&Shape {
        decks: &decks,
        deck_folders: &deck_folders,
        collection_folders: &collection_folders,
        wishlist_folders: &wishlist_folders,
    });
    // The reader's own choice, so the `Price` column in a mirrored CSV says what the app says.
    let marketplace = Marketplace::from_id(&crate::marketplace::stored(conn));

    let mut report = PassReport::default();

    // One read per *source*, not per file. `plan_files` emits a list's seven formats together,
    // so remembering only the last source is enough to turn 7 reads of one deck into 1 — and a
    // memo of one cannot hold a list long enough to go stale within a pass.
    let mut memo: Option<(Source, Vec<Card>)> = None;
    for file in plan.files.iter().filter(|f| dirty.covers(f.surface)) {
        match render(conn, file, marketplace, &mut memo) {
            Ok(text) => put(root, &file.path, text.as_bytes(), cache, &mut report),
            // A list that could not be read is one file's worth of failure. The path stays in
            // the plan and so in the manifest, which is what stops the prune below from taking
            // yesterday's copy of it away.
            Err(_) => report.failed += 1,
        }
    }

    // On every pass, and free after the first: it is hash-compared like every other file, so
    // rewriting it costs a hash of a constant. The answer is whether the folder's `README.txt`
    // is one of **ours**, which is what the manifest below may claim.
    let readme_is_ours = put_readme(root, previous.as_deref(), cache, &mut report);

    prune(root, &plan, previous, cache, &mut report);
    put(
        root,
        MANIFEST_NAME,
        manifest_text(&plan, readme_is_ours).as_bytes(),
        cache,
        &mut report,
    );
    Ok(report)
}

/// One planned file's bytes, reading its list only when it is not the one already in hand.
///
/// Every optional field is on, which is exactly what `available_fields` already answers — the
/// mirror is a backup, so the question "what *can* this file say" and "what should it say" have
/// the same answer here and nowhere else in the app.
fn render(
    conn: &Connection,
    file: &PlannedFile,
    marketplace: Marketplace,
    memo: &mut Option<(Source, Vec<Card>)>,
) -> Result<String, String> {
    let stale = match memo {
        Some((source, _)) => source != &file.source,
        None => true,
    };
    if stale {
        // On failure the memo keeps the *previous* source, so the next file of this list finds
        // it stale and tries again rather than being handed the wrong deck's cards.
        let cards = super::read::cards_for(conn, &file.source, marketplace)?;
        *memo = Some((file.source.clone(), cards));
    }
    let cards = memo.as_ref().map_or(&[][..], |(_, c)| c.as_slice());
    Ok(format_export(
        cards,
        file.format,
        &available_fields(file.format, file.surface),
    ))
}

/// A change detector over the bytes, and deliberately not a security boundary.
///
/// `sha2` is in the tree for release integrity; nothing here is defending against a file
/// crafted to collide, and the digest never leaves the process — it is compared only against
/// another digest taken by the same build in the same run, so the standard hasher's freedom to
/// change between Rust releases costs nothing.
fn digest(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// Put `bytes` at `rel`, if what is there is not already them.
///
/// Three outcomes and each is one line of the report. The **cache miss reads the file** — that
/// is the whole of spec §5's "the digests start from the files on disk", and the reason a
/// relaunch with no edits opens nothing for writing.
///
/// **A remembered digest never vouches for a file on its own.** The cache says what this
/// process last *wrote*, which is not the same claim as what is on disk now, and every way the
/// two come apart looks identical from in here: the reader deletes the mirror folder while the
/// app is running and `create_dir_all` quietly puts an empty one back (`README.txt` promises
/// them that is safe); a stick is unplugged and comes back empty; the root setting moves and
/// the same plan-relative key now names a file under a folder nothing has ever written to.
/// Each of those was a separate special case somewhere up the stack, and each of them is this
/// one `&& abs.is_file()` instead — a cache hit is confirmed with a `stat` before it is
/// trusted. ~350 stats a pass against the ~350 writes it still avoids, and the map goes back
/// to being a pure optimisation rather than a second, quieter source of truth about the disk.
///
/// It is deliberately **presence** and not contents. Re-reading every file to compare would
/// throw away the whole point of the cache; a reader who hand-edits a mirrored file is
/// answered by `Rebuild now`, which runs with a fresh map for exactly that reason.
fn put(
    root: &Path,
    rel: &str,
    bytes: &[u8],
    cache: &mut HashMap<String, u64>,
    report: &mut PassReport,
) {
    let want = digest(bytes);
    let abs = root.join(rel);
    if cache.get(rel) == Some(&want) && abs.is_file() {
        report.unchanged += 1;
        return;
    }
    if std::fs::read(&abs).is_ok_and(|on_disk| digest(&on_disk) == want) {
        cache.insert(rel.to_owned(), want);
        report.unchanged += 1;
        return;
    }
    if write_file(&abs, bytes).is_err() {
        // What is on disk is now unknown — a partial write, the old file, or nothing — so the
        // remembered digest has to go with it, or the next pass would call it unchanged.
        cache.remove(rel);
        report.failed += 1;
        return;
    }
    cache.insert(rel.to_owned(), want);
    report.written += 1;
}

/// Create the parents and write. Split out so that every way this can fail is one `is_err`.
///
/// **Nothing here caps the path length.** Windows stops at `MAX_PATH` unless long paths are
/// switched on, and a deep tree under a long root can pass it — but truncating or hashing a
/// name would put a file on disk whose name no longer said which deck it came from, which is
/// worse than not writing it. An over-long path is an ordinary per-file failure.
fn write_file(abs: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(abs, bytes)
}

/// Write [`README_NAME`] — unless the folder already holds one this mirror never wrote.
/// Answers whether the file at that path is now the mirror's, which is what the manifest says.
///
/// **The write path deserves the fence the prune path has.** [`set_root`] accepts any absolute
/// path whose parent exists, a drive root and a Dropbox with a decade of somebody's notes in it
/// included, and [`README_NAME`] is the one fixed name the mirror puts at the top of it. Five
/// rulings reasoned about what a pass may *delete* from a folder the reader chose; none looked
/// at what the first pass writes **into** it, and the answer was "whatever is already called
/// `README.txt`". That is the same harm the manifest exists to prevent, arriving by the other
/// door.
///
/// **The manifest is the authority, exactly as it is for [`prune`]**, and for the same reason:
/// it is a record of what this app actually wrote rather than a guess about what it might have.
/// A `README.txt` no previous manifest names is the reader's, is left alone, and is counted in
/// [`PassReport::skipped`].
///
/// **Byte-identical content is adopted rather than refused**, which is the one thing that keeps
/// the guard from being permanent. `README.txt` tells the reader that deleting `.mirror-manifest`
/// is safe; without this arm, doing so would freeze the README they already had from us at
/// whatever this build wrote, for good. A file that already *is* what we would write has nothing
/// in it to lose, so writing it changes nothing and claiming it changes everything.
///
/// A directory sitting at the path is not ours either — `exists()` and not `is_file()` — and it
/// is skipped rather than counted as a failure, because a reader who put something there is not
/// a fault to report.
fn put_readme(
    root: &Path,
    previous: Option<&[String]>,
    cache: &mut HashMap<String, u64>,
    report: &mut PassReport,
) -> bool {
    let listed = previous.is_some_and(|lines| lines.iter().any(|line| line == README_NAME));
    let abs = root.join(README_NAME);
    if !listed && abs.exists() && !holds_our_readme(&abs) {
        report.skipped += 1;
        return false;
    }
    put(root, README_NAME, README.as_bytes(), cache, report);
    true
}

/// Is what is at this path already, byte for byte, the README this build writes?
fn holds_our_readme(abs: &Path) -> bool {
    std::fs::read(abs).is_ok_and(|on_disk| on_disk == README.as_bytes())
}

// ---------------------------------------------------------------------------------------
// The manifest, and the prune it authorises
// ---------------------------------------------------------------------------------------

/// Every file this pass intends to exist, one per line, sorted, LF.
///
/// [`README_NAME`] is in the list like any other file, so it stops being a special case
/// anywhere: nothing ever plans it away, so nothing can ever prune it. [`MANIFEST_NAME`] is
/// **not** in the list, which is what makes it unprunable by construction.
///
/// **`readme_is_ours` is the one thing here that is not read off the plan, and it has to be.**
/// A manifest is a record of what this app *wrote*; naming a `README.txt` [`put_readme`] just
/// refused to touch would make the next pass read it back as ours and overwrite the reader's
/// file on the second pass rather than the first — the guard undone by the file that authorises
/// it.
fn manifest_text(plan: &Plan, readme_is_ours: bool) -> String {
    let mut lines: Vec<&str> = plan
        .files
        .iter()
        .map(|f| f.path.as_str())
        .chain(readme_is_ours.then_some(README_NAME))
        .collect();
    lines.sort_unstable();
    lines.dedup();
    let mut out = String::with_capacity(lines.len() * 32);
    for line in lines {
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// The previous manifest, or `None` if there is not one this pass may act on.
///
/// `None` covers the first pass after this feature ships, a reader who deleted the file, and a
/// file that will not read. All three mean the same thing — *this app has no record of what it
/// wrote* — and [`prune`] answers all three the same way.
fn read_manifest(root: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(root.join(MANIFEST_NAME)).ok()?;
    Some(
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

/// May this manifest line be turned into a path and deleted?
///
/// **A manifest is a file on the reader's disk, so it is input.** A corrupted or hand-edited
/// line reading `../../Documents/taxes.csv` would otherwise be a delete outside the root, and
/// the root may sit anywhere. So a line is a relative path of plain segments or it is ignored:
/// no leading separator, no `\` (which `Path::join` reads as a separator on Windows), no `:`
/// (`C:` and NTFS alternate data streams both), and no `.` or `..` segment.
fn safe_entry(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.starts_with('/')
        && !rel.contains('\\')
        && !rel.contains(':')
        && !rel
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
}

/// Delete the files the last pass wrote that this one no longer wants, then the directories
/// that leaves empty.
///
/// **The manifest is the authority and inference is not.** The pruner is handed a record of
/// what the mirror actually wrote and deletes the entries this plan no longer names — so a
/// rename, a delete and a theory list switched off are all one case, it survives a restart,
/// and it cannot touch a reader's file because a reader's file was never in a manifest we
/// wrote. Walking the tree and asking "would I have written a file called this?" is the shape
/// this replaced: it cannot tell a deleted deck's folder from a reader's folder of the same
/// name, and answering either way loses something — the reader's files, or every renamed
/// deck's seven forever.
///
/// **Against the full plan, never the dirty subset.** A pass that renders only the decks still
/// writes a manifest naming every file in the mirror, or the next pass would read one that had
/// forgotten the collection and delete it.
///
/// [`README_NAME`] is in `wanted` **unconditionally**, including when [`put_readme`] refused to
/// write it: `wanted` is what may not be deleted, and a README that is the reader's own is the
/// last file in the folder this pass is allowed to take away.
fn prune(
    root: &Path,
    plan: &Plan,
    previous: Option<Vec<String>>,
    cache: &mut HashMap<String, u64>,
    report: &mut PassReport,
) {
    let wanted: HashSet<&str> = plan
        .files
        .iter()
        .map(|f| f.path.as_str())
        .chain(std::iter::once(README_NAME))
        .collect();
    let mut emptied: BTreeSet<String> = BTreeSet::new();

    match previous {
        Some(previous) => {
            for rel in previous {
                if wanted.contains(rel.as_str()) || !safe_entry(&rel) {
                    continue;
                }
                drop_file(root, &rel, cache, report, &mut emptied);
            }
        }
        None => recover(root, plan, &wanted, cache, report, &mut emptied),
    }

    sweep_empty(root, &wanted, &emptied, report);
}

/// Prune with no manifest to go on: the narrow recovery path, and the only place [`is_ours`]
/// is still asked anything.
///
/// It looks **only inside directories the current plan owns and gives a stem to**, which is
/// what keeps it safe: a container ([`super::layout::OwnedDir`] with `stem: None` — `Decks`,
/// every deck folder, the root) claims nothing, so a reader's `Standard.csv` sitting in their
/// deck folder `Standard` is untouchable here as well. No stem is ever invented for a
/// directory the plan does not name, so a deleted deck's folder is simply left alone.
///
/// What that reaches, in practice, is the one case a first manifest cannot cover: a deck whose
/// theory switch is off still owns its `Theory` directory with the deck's own stem, so seven
/// files from before the switch are claimable. Everything else waits for the next pass, and one
/// pass's worth of orphans is the right price for never guessing.
///
/// **`wanted` is consulted without regard to ASCII case, because [`is_ours`] claims without
/// regard to it.** Each half was right on its own and the pair was not: `is_ours` ignores case
/// deliberately, because Windows does and a file this app created as `Azula.txt` can be
/// enumerated as `AZULA.TXT` after a reader or a sync client re-cases it. `wanted` is a set of
/// the plan's exact spellings, so the same file was claimed by the first test and missed by the
/// second — and dropped, in the same pass that had just written it, because [`put`] runs before
/// [`prune`]. It healed on the next pass and cost the reader a deck's file until then.
fn recover(
    root: &Path,
    plan: &Plan,
    wanted: &HashSet<&str>,
    cache: &mut HashMap<String, u64>,
    report: &mut PassReport,
    emptied: &mut BTreeSet<String>,
) {
    // One lowercased copy of the plan's paths, built once, so the membership test below asks
    // the same question `is_ours` just answered. See this function's doc.
    let wanted_ci: HashSet<String> = wanted.iter().map(|w| w.to_ascii_lowercase()).collect();
    for dir in &plan.dirs {
        let Some(stem) = dir.stem.as_deref() else {
            continue;
        };
        // A planned directory that is not on disk is the ordinary case, not a failure.
        let Ok(entries) = std::fs::read_dir(root.join(&dir.path)) else {
            continue;
        };
        for entry in entries.flatten() {
            // **Files only.** A deck a reader named `Azula.csv` is a *directory* with that
            // name, and `is_ours` answers about names; only the caller can tell the two apart.
            // Anything that is neither (a symlink, a junction) is left alone entirely.
            if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_ours(&name, stem) {
                continue;
            }
            let rel = join_rel(&dir.path, &name);
            if wanted_ci.contains(&rel.to_ascii_lowercase()) {
                continue;
            }
            drop_file(root, &rel, cache, report, emptied);
        }
    }
}

/// Delete one file the mirror wrote and is done with.
///
/// **A file that is already gone is not a failure.** The reader deleting one of these
/// themselves is a thing they are allowed to do, and the manifest is a record of intent rather
/// than a claim about the current disk. Anything at the path that is not a plain file is left
/// where it is: the reader has put something else there, and `remove_file` is the only delete
/// this module ever performs on a path a manifest named.
fn drop_file(
    root: &Path,
    rel: &str,
    cache: &mut HashMap<String, u64>,
    report: &mut PassReport,
    emptied: &mut BTreeSet<String>,
) {
    let abs = root.join(rel);
    let Ok(meta) = std::fs::symlink_metadata(&abs) else {
        // Already gone. Its directory may still be empty now, so it is worth looking at.
        cache.remove(rel);
        note_ancestors(rel, emptied);
        return;
    };
    if !meta.is_file() {
        return;
    }
    match std::fs::remove_file(&abs) {
        Ok(()) => {
            // The digest goes with the file. A deck renamed away and back would otherwise find
            // a remembered digest for a path that no longer exists and call it unchanged,
            // leaving the reader a folder with a file missing from it.
            cache.remove(rel);
            report.pruned += 1;
            note_ancestors(rel, emptied);
        }
        Err(_) => report.failed += 1,
    }
}

/// Remove the directories a prune left empty, deepest first.
///
/// Only directories that held something taken away are even looked at, and only ones that hold
/// **no planned file at all** are removed — which covers a deck's `Theory` after the switch was
/// turned off (owned, but planning nothing) as well as a deleted deck's own directory, and
/// leaves the root standing because `README.txt` is planned in it forever.
fn sweep_empty(
    root: &Path,
    wanted: &HashSet<&str>,
    emptied: &BTreeSet<String>,
    report: &mut PassReport,
) {
    let mut keep: HashSet<&str> = HashSet::new();
    for rel in wanted {
        let mut at = *rel;
        while let Some(parent) = parent_of(at) {
            keep.insert(parent);
            at = parent;
        }
    }
    let mut order: Vec<&String> = emptied.iter().collect();
    // Deepest first, so a `Theory` goes before the deck directory holding it and the deck
    // directory is empty by the time it is looked at.
    order.sort_by_key(|rel| std::cmp::Reverse(rel.matches('/').count()));
    for rel in order {
        if rel.is_empty() || keep.contains(rel.as_str()) {
            continue;
        }
        let abs = root.join(rel);
        // `remove_dir`, never `remove_dir_all`: if anything is left in there it is not ours.
        if !std::fs::read_dir(&abs).is_ok_and(|mut it| it.next().is_none()) {
            continue;
        }
        match std::fs::remove_dir(&abs) {
            Ok(()) => report.pruned += 1,
            Err(_) => report.failed += 1,
        }
    }
}

/// Every directory on the way to `rel`, the root excluded.
fn note_ancestors(rel: &str, out: &mut BTreeSet<String>) {
    let mut at = rel;
    while let Some(parent) = parent_of(at) {
        if parent.is_empty() {
            return;
        }
        out.insert(parent.to_owned());
        at = parent;
    }
}

/// The directory holding `rel`, `""` being the root. `None` for the root itself.
fn parent_of(rel: &str) -> Option<&str> {
    if rel.is_empty() {
        return None;
    }
    Some(rel.rfind('/').map_or("", |cut| &rel[..cut]))
}

/// Join a plan-relative directory to a name, `""` meaning the root.
fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::SystemTime;

    /// The two printings every fixture files copies of.
    ///
    /// **Seeding `cards` is allowed here only because the connection is in memory and dies
    /// with the test**, so no later measurement of the real corpus can be made a fiction by
    /// it. Everything else goes in through the app's own write commands.
    fn seeded_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate_single_file(&conn).unwrap();
        for (id, oracle, name, set, num) in [
            ("bolt-lea", "o1", "Lightning Bolt", "lea", "161"),
            ("sol-lea", "o2", "Sol Ring", "lea", "263"),
        ] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,type_line,finishes,prices,raw)
                 VALUES (?1,?2,?3,?4,?5,'en','normal','common','Instant',
                    '[\"nonfoil\",\"foil\"]','{\"usd\":\"1.00\"}','{}')",
                rusqlite::params![id, oracle, name, set, num],
            )
            .unwrap();
        }
        conn
    }

    /// A deck called `Azula` that keeps a theory list, two cards in the collection and one on
    /// the wishlist. Answers the deck's id, because `decks` is not the only table with a row
    /// 1 and hard-coding one is how a test comes to be about the wrong thing.
    fn seeded_db_and_temp_root() -> (Connection, tempfile::TempDir, i64) {
        let conn = seeded_db();
        let deck = crate::deck::create_deck(
            &conn,
            &crate::deck::DeckInput {
                name: "Azula".to_owned(),
                // On, so that every prune test below is also a test of the one directory whose
                // files are not named after it.
                theory_enabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        for variant in ["live", "theory"] {
            crate::deck::add_card(
                &conn,
                deck.id,
                "bolt-lea",
                None,
                Some("Main"),
                variant,
                None,
                4,
            )
            .unwrap();
        }
        for card in ["bolt-lea", "sol-lea"] {
            crate::collection::add_entry(
                &conn,
                &crate::collection::EntryInput {
                    card_id: card.to_owned(),
                    finish: "nonfoil".to_owned(),
                    quantity: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        }
        crate::wishlist::add_wish(
            &conn,
            &crate::wishlist::WishInput {
                card_id: Some("sol-lea".to_owned()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        (conn, tempfile::tempdir().unwrap(), deck.id)
    }

    /// A pass with a digest map of its own — the shape a caller that keeps no state has.
    fn pass(conn: &Connection, root: &Path, dirty: Dirty) -> PassReport {
        run_pass(conn, root, dirty, &mut DigestCache::default()).unwrap()
    }

    fn mtime(path: &Path) -> SystemTime {
        std::fs::metadata(path).unwrap().modified().unwrap()
    }

    fn deck_file(dir: &tempfile::TempDir, name: &str) -> PathBuf {
        dir.path().join(format!("Decks/{name}/{name}.txt"))
    }

    fn rename_deck(conn: &Connection, id: i64, to: &str) {
        conn.execute(
            "UPDATE decks SET name = ?1 WHERE id = ?2",
            rusqlite::params![to, id],
        )
        .unwrap();
    }

    #[test]
    fn a_pass_writes_the_files_the_plan_names() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        let report = pass(&conn, dir.path(), Dirty::ALL);
        assert!(deck_file(&dir, "Azula").is_file());
        assert!(dir.path().join("Decks/Azula/Theory/Azula.txt").is_file());
        assert!(dir.path().join("Collection/Collection.csv").is_file());
        assert!(dir.path().join("Wishlist/Wishlist.csv").is_file());
        assert!(dir.path().join("README.txt").is_file());
        assert!(dir.path().join(MANIFEST_NAME).is_file());
        assert!(report.written > 0 && report.failed == 0, "{report:?}");
    }

    #[test]
    fn the_manifest_lists_every_planned_file_and_the_readme_and_not_itself() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        pass(&conn, dir.path(), Dirty::ALL);
        let text = std::fs::read_to_string(dir.path().join(MANIFEST_NAME)).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines.contains(&"README.txt"));
        assert!(lines.contains(&"Decks/Azula/Azula.txt"));
        assert!(lines.contains(&"Decks/Azula/Theory/Azula.csv"));
        assert!(lines.contains(&"Collection/Collection.csv"));
        assert!(
            !lines.contains(&MANIFEST_NAME),
            "the manifest must never be able to plan itself away"
        );
        let mut sorted = lines.clone();
        sorted.sort_unstable();
        assert_eq!(lines, sorted, "sorted, so a pass's diff is readable");
        assert!(text.ends_with('\n') && !text.contains('\r'));
    }

    #[test]
    fn a_second_pass_over_unchanged_data_opens_nothing_for_writing() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        let mut cache = DigestCache::default();
        run_pass(&conn, dir.path(), Dirty::ALL, &mut cache).unwrap();
        let before = mtime(&deck_file(&dir, "Azula"));
        let manifest_before = mtime(&dir.path().join(MANIFEST_NAME));
        let report = run_pass(&conn, dir.path(), Dirty::ALL, &mut cache).unwrap();
        assert_eq!(
            report.written, 0,
            "hash-comparison must skip identical files"
        );
        assert!(report.unchanged > 0, "{report:?}");
        assert_eq!(mtime(&deck_file(&dir, "Azula")), before);
        assert_eq!(
            mtime(&dir.path().join(MANIFEST_NAME)),
            manifest_before,
            "the manifest is hash-skipped like everything else"
        );
    }

    /// The mutation Step 5 asks for: trust the map on a cold start and this is what fails.
    /// A fresh map is what every launch has, and a launch that rewrote 350 files would push
    /// ~10 MB through Defender and whatever cloud client owns the folder, for nothing.
    #[test]
    fn a_cold_digest_map_over_an_already_written_mirror_writes_nothing() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        pass(&conn, dir.path(), Dirty::ALL);
        let report = pass(&conn, dir.path(), Dirty::ALL);
        assert_eq!(
            report.written, 0,
            "a cold map must hash what is on disk, not assume it is missing"
        );
        assert!(report.unchanged > 0, "{report:?}");
    }

    #[test]
    fn a_renamed_deck_leaves_nothing_behind() {
        let (conn, dir, id) = seeded_db_and_temp_root();
        let mut cache = DigestCache::default();
        run_pass(&conn, dir.path(), Dirty::ALL, &mut cache).unwrap();
        assert!(dir.path().join("Decks/Azula/Theory").is_dir());
        rename_deck(&conn, id, "Katara");
        let report = run_pass(&conn, dir.path(), Dirty::ALL, &mut cache).unwrap();
        assert!(deck_file(&dir, "Katara").is_file());
        assert!(
            !dir.path().join("Decks/Azula").exists(),
            "the old directory must go, theory list and all"
        );
        assert!(report.pruned > 0 && report.failed == 0, "{report:?}");
    }

    /// The manifest is what makes this work across a restart: the pass that prunes has only a
    /// file on disk to go on, and no memory of the previous plan.
    #[test]
    fn a_renamed_deck_is_pruned_by_a_pass_that_remembers_nothing() {
        let (conn, dir, id) = seeded_db_and_temp_root();
        pass(&conn, dir.path(), Dirty::ALL);
        rename_deck(&conn, id, "Katara");
        pass(&conn, dir.path(), Dirty::ALL);
        assert!(!dir.path().join("Decks/Azula").exists());
        assert!(deck_file(&dir, "Katara").is_file());
    }

    #[test]
    fn a_theory_list_switched_off_takes_its_directory_with_it() {
        let (conn, dir, id) = seeded_db_and_temp_root();
        let mut cache = DigestCache::default();
        run_pass(&conn, dir.path(), Dirty::ALL, &mut cache).unwrap();
        assert!(dir.path().join("Decks/Azula/Theory/Azula.csv").is_file());
        conn.execute("UPDATE decks SET theory_enabled = 0 WHERE id = ?1", [id])
            .unwrap();
        run_pass(&conn, dir.path(), Dirty::ALL, &mut cache).unwrap();
        assert!(
            !dir.path().join("Decks/Azula/Theory").exists(),
            "seven files named after the deck, in a directory that is not"
        );
        assert!(deck_file(&dir, "Azula").is_file(), "the live list stays");
    }

    /// The same, with no manifest — the recovery path, which reaches exactly this case
    /// because a switched-off `Theory` is still a directory the plan owns and gives a stem to.
    #[test]
    fn a_theory_list_switched_off_is_recovered_when_there_is_no_manifest() {
        let (conn, dir, id) = seeded_db_and_temp_root();
        pass(&conn, dir.path(), Dirty::ALL);
        conn.execute("UPDATE decks SET theory_enabled = 0 WHERE id = ?1", [id])
            .unwrap();
        std::fs::remove_file(dir.path().join(MANIFEST_NAME)).unwrap();
        pass(&conn, dir.path(), Dirty::ALL);
        assert!(!dir.path().join("Decks/Azula/Theory").exists());
    }

    #[test]
    fn a_missing_manifest_prunes_nothing_but_writes_one() {
        let (conn, dir, id) = seeded_db_and_temp_root();
        pass(&conn, dir.path(), Dirty::ALL);
        rename_deck(&conn, id, "Katara");
        std::fs::remove_file(dir.path().join(MANIFEST_NAME)).unwrap();
        let report = pass(&conn, dir.path(), Dirty::ALL);
        assert!(
            dir.path().join("Decks/Azula/Azula.txt").is_file(),
            "with no record of what we wrote, one pass's worth of orphans is the right price"
        );
        assert_eq!(report.pruned, 0, "{report:?}");
        assert!(dir.path().join(MANIFEST_NAME).is_file());

        // **And they stay.** The fresh manifest describes the plan as it is now, so no later
        // pass has any record that those files were ever ours — which is exactly the cost
        // `README.txt` states for deleting the manifest, rather than a bug in the next pass.
        pass(&conn, dir.path(), Dirty::ALL);
        assert!(dir.path().join("Decks/Azula/Azula.txt").is_file());
        let text = std::fs::read_to_string(dir.path().join(MANIFEST_NAME)).unwrap();
        assert!(!text.lines().any(|l| l.starts_with("Decks/Azula/")));
    }

    #[test]
    fn a_manifest_naming_a_file_the_reader_already_deleted_is_not_a_failure() {
        let (conn, dir, id) = seeded_db_and_temp_root();
        pass(&conn, dir.path(), Dirty::ALL);
        rename_deck(&conn, id, "Katara");
        std::fs::remove_file(dir.path().join("Decks/Azula/Azula.csv")).unwrap();
        let report = pass(&conn, dir.path(), Dirty::ALL);
        assert_eq!(
            report.failed, 0,
            "a file already gone is simply gone: {report:?}"
        );
        assert!(!dir.path().join("Decks/Azula").exists());
    }

    /// **The one that must never go red.** Both paths: with a manifest, which can only name
    /// files we wrote, and without one, where the recovery path claims nothing in a container.
    #[test]
    fn a_file_the_reader_dropped_in_survives_a_prune() {
        let (conn, dir, id) = seeded_db_and_temp_root();
        // A deck folder the reader made, holding no deck — a container, and the shape a
        // stem-guessing pruner would claim `Standard.csv` inside.
        crate::deck_meta::create_folder(&conn, None, "Standard").unwrap();
        pass(&conn, dir.path(), Dirty::ALL);

        std::fs::create_dir_all(dir.path().join("Decks/Standard")).unwrap();
        let theirs = [
            ("Decks/my notes.md", "mine"),
            ("Decks/Standard/Standard.csv", "a folder of my own"),
            ("Decks/Decks.csv", "shaped like ours, in a container"),
            ("budget.csv", "at the root they chose"),
        ];
        for (rel, body) in theirs {
            std::fs::write(dir.path().join(rel), body).unwrap();
        }

        // Once with a manifest, and once with the deck renamed so there is real pruning to do.
        rename_deck(&conn, id, "Katara");
        pass(&conn, dir.path(), Dirty::ALL);
        for (rel, _) in theirs {
            assert!(
                dir.path().join(rel).is_file(),
                "{rel} was deleted (manifest path)"
            );
        }

        // And again with no manifest at all, which is the recovery path.
        std::fs::remove_file(dir.path().join(MANIFEST_NAME)).unwrap();
        pass(&conn, dir.path(), Dirty::ALL);
        for (rel, _) in theirs {
            assert!(
                dir.path().join(rel).is_file(),
                "{rel} was deleted (recovery path)"
            );
        }
    }

    /// A manifest is a file on the reader's disk and therefore input. A line that escapes the
    /// root is ignored rather than obeyed.
    ///
    /// **The file `../taxes.csv` names is inside the tempdir, not beside it.** The root here is
    /// a *child* of the temp directory rather than the temp directory itself, so the escape the
    /// manifest attempts still lands somewhere `dir` will delete when it drops. Written the
    /// obvious way it reached `%TEMP%/taxes.csv` — a fixed name outside any tempdir, shared by
    /// every worktree running `cargo test`, and cleaned up only when the assertions passed.
    #[test]
    fn a_manifest_line_that_escapes_the_root_is_ignored() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        let root = dir.path().join("mirror");
        pass(&conn, &root, Dirty::ALL);
        let outside = dir.path().join("taxes.csv");
        std::fs::write(&outside, b"not yours").unwrap();
        std::fs::write(
            root.join(MANIFEST_NAME),
            "../taxes.csv\n..\\taxes.csv\n/etc/passwd\nC:/Windows/notepad.exe\n",
        )
        .unwrap();
        let report = pass(&conn, &root, Dirty::ALL);
        assert!(
            outside.is_file(),
            "a manifest may not name a path outside the root"
        );
        assert_eq!(report.pruned, 0, "{report:?}");
        for line in ["../x", "..\\x", "/x", "C:/x", "a//b", "a/./b", "a/../b", ""] {
            assert!(!safe_entry(line), "{line:?} must be refused");
        }
        assert!(safe_entry("Decks/Azula/Azula.txt"));
    }

    /// The cache is a statement about a path, and a path can come back. Without dropping the
    /// digest at the prune, the third pass here calls a file it has just deleted unchanged.
    #[test]
    fn a_deck_renamed_away_and_back_is_written_again() {
        let (conn, dir, id) = seeded_db_and_temp_root();
        let mut cache = DigestCache::default();
        run_pass(&conn, dir.path(), Dirty::ALL, &mut cache).unwrap();
        for name in ["Katara", "Azula"] {
            rename_deck(&conn, id, name);
            run_pass(&conn, dir.path(), Dirty::ALL, &mut cache).unwrap();
        }
        assert!(
            deck_file(&dir, "Azula").is_file(),
            "a pruned path must be forgotten, or it can never be rewritten"
        );
    }

    /// Review I1: a deck a reader named `Azula.csv` is a *directory*. Nothing here removes a
    /// directory except by finding it empty, and `remove_file` is the only delete performed on
    /// a path a manifest named.
    #[test]
    fn a_directory_sitting_where_a_file_was_is_left_alone() {
        let (conn, dir, id) = seeded_db_and_temp_root();
        pass(&conn, dir.path(), Dirty::ALL);
        let claimed = dir.path().join("Decks/Azula/Azula.csv");
        std::fs::remove_file(&claimed).unwrap();
        std::fs::create_dir(&claimed).unwrap();
        std::fs::write(claimed.join("keep.md"), b"mine").unwrap();
        rename_deck(&conn, id, "Katara");
        pass(&conn, dir.path(), Dirty::ALL);
        assert!(
            claimed.join("keep.md").is_file(),
            "a directory is removed only when it is empty"
        );
    }

    #[test]
    fn a_pass_over_one_surface_does_not_prune_the_others() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        let mut cache = DigestCache::default();
        run_pass(&conn, dir.path(), Dirty::ALL, &mut cache).unwrap();
        let decks = Dirty {
            decks: true,
            collection: false,
            wishlist: false,
        };
        run_pass(&conn, dir.path(), decks, &mut cache).unwrap();
        assert!(
            dir.path().join("Collection/Collection.csv").is_file(),
            "pruning compares against the FULL plan, never the dirty subset"
        );
        assert!(dir.path().join("Wishlist/Wishlist.csv").is_file());
        // And the manifest it left still names them, or the next pass would delete them.
        let text = std::fs::read_to_string(dir.path().join(MANIFEST_NAME)).unwrap();
        assert!(text.lines().any(|l| l == "Collection/Collection.csv"));
        run_pass(&conn, dir.path(), decks, &mut cache).unwrap();
        assert!(dir.path().join("Collection/Collection.csv").is_file());
    }

    #[test]
    fn a_pass_renders_only_the_surfaces_it_was_told_are_dirty() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        // **This folder has to look already-mirrored, and that is the point of the two lines.**
        // A root with no manifest owes a *full* pass however narrow the mask is — see the
        // escalation in `run_pass` — so a cold folder can never demonstrate the narrowing. An
        // empty manifest is the honest neutral state here: `prune`'s authority is exactly what
        // it names, so naming nothing authorises nothing, and the only thing it says is "the
        // mirror has been here and nobody has deleted the folder".
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(dir.path().join(MANIFEST_NAME), "").unwrap();

        let decks = Dirty {
            decks: true,
            collection: false,
            wishlist: false,
        };
        pass(&conn, dir.path(), decks);
        assert!(deck_file(&dir, "Azula").is_file());
        assert!(!dir.path().join("Collection/Collection.csv").exists());
        assert!(!dir.path().join("Wishlist/Wishlist.csv").exists());
    }

    /// The escalation itself, at the level it is enforced. A folder with no manifest is
    /// indistinguishable from one a reader has just deleted, and both mean the same thing:
    /// nothing on disk can be relied on, so render everything whatever the mask says.
    #[test]
    fn a_root_with_no_manifest_is_rendered_whole_however_narrow_the_mask() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        let decks = Dirty {
            decks: true,
            collection: false,
            wishlist: false,
        };
        pass(&conn, dir.path(), decks);
        assert!(
            dir.path().join("Collection/Collection.csv").is_file(),
            "a folder the mirror has never written owes a full pass, not the mask's subset"
        );
        assert!(dir.path().join("Wishlist/Wishlist.csv").is_file());
    }

    /// **Which file is the sentinel, and it is the manifest rather than any other.** Deleting
    /// the whole folder takes both it and `README.txt`, so the test above cannot tell the two
    /// choices apart — a mutation keying the escalation on the README survived it. This one
    /// deletes the manifest alone.
    ///
    /// The manifest is the right sentinel because it is the *pruner's authority*: without it a
    /// pass can no longer tell its own leftovers from the reader's own files, which the README
    /// says out loud. Re-establishing it is worth one full render, and no other file in the
    /// folder carries that meaning.
    #[test]
    fn deleting_the_manifest_alone_is_enough_to_owe_a_full_pass() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        pass(&conn, dir.path(), Dirty::ALL);
        std::fs::remove_file(dir.path().join(MANIFEST_NAME)).unwrap();
        std::fs::remove_dir_all(dir.path().join("Wishlist")).unwrap();
        assert!(
            dir.path().join(README_NAME).is_file(),
            "the README stays, so only the manifest can be what is noticed"
        );

        // A deck edit, which is all the mask would ever have said.
        pass(
            &conn,
            dir.path(),
            Dirty {
                decks: true,
                collection: false,
                wishlist: false,
            },
        );

        assert!(
            dir.path().join("Wishlist/Wishlist.csv").is_file(),
            "a lost manifest owes a full pass, whatever the mask said"
        );
        assert!(dir.path().join(MANIFEST_NAME).is_file());
    }

    /// [`DigestCache::aim_at`] itself, which is the invariant in one place.
    #[test]
    fn aiming_the_cache_at_another_root_forgets_everything_it_knew() {
        let mut cache = DigestCache::default();
        cache.aim_at(Path::new("D:/one"));
        cache.files.insert("Decks/Burn/Burn.txt".to_owned(), 42);

        cache.aim_at(Path::new("D:/one"));
        assert_eq!(cache.len(), 1, "the same root keeps its digests");

        cache.aim_at(Path::new("D:/two"));
        assert!(cache.is_empty(), "a different root shares none of them");
    }

    /// And the same guard where a pass reaches it. **The interesting root is one the mirror has
    /// written before**, not an empty one: at an empty root `put`'s `is_file` check misses and
    /// every file is rewritten anyway, so a two-root test that never comes back cannot fail —
    /// it was written that way first and two mutations survived it.
    ///
    /// Coming back is what exposes the cache: every file is *present* at the first root and some
    /// hold the older plan, which is exactly what a digest taken at the second root cannot tell
    /// apart from a file that is up to date.
    #[test]
    fn a_cache_carried_back_to_a_root_cannot_vouch_for_its_stale_copies() {
        let (conn, first, _) = seeded_db_and_temp_root();
        let second = tempfile::tempdir().unwrap();
        let mut cache = DigestCache::default();

        run_pass(&conn, first.path(), Dirty::ALL, &mut cache).unwrap();
        let stale = std::fs::read_to_string(first.path().join(MANIFEST_NAME)).unwrap();

        // The plan grows while the mirror is pointed somewhere else.
        crate::deck::create_deck(
            &conn,
            &crate::deck::DeckInput {
                name: "Zuko".to_owned(),
                ..Default::default()
            },
        )
        .unwrap();
        run_pass(&conn, second.path(), Dirty::ALL, &mut cache).unwrap();
        let planned = std::fs::read_to_string(second.path().join(MANIFEST_NAME)).unwrap();
        assert_ne!(planned, stale, "the two roots have to disagree");

        run_pass(&conn, first.path(), Dirty::ALL, &mut cache).unwrap();

        assert_eq!(
            std::fs::read_to_string(first.path().join(MANIFEST_NAME)).unwrap(),
            planned,
            "the returning root's manifest has to say what this pass planned"
        );
        assert!(
            deck_file(&first, "Zuko").is_file(),
            "and the deck it never had is written into it"
        );
    }

    /// R6: a regular file as the root's parent, which is `paths.rs`'s own idiom for "this
    /// path cannot be made". A hard-coded `Z:/` would be a real drive on somebody's machine.
    #[test]
    fn an_unwritable_root_is_an_error_and_not_a_panic() {
        let conn = seeded_db();
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("not-a-directory");
        std::fs::write(&blocker, b"x").unwrap();
        let root = blocker.join("mirror");
        assert!(run_pass(&conn, &root, Dirty::ALL, &mut DigestCache::default()).is_err());
    }

    /// R9: no path is capped. A name longer than a filesystem component costs that deck its
    /// files and costs the rest of the mirror nothing.
    #[test]
    fn a_name_too_long_for_the_filesystem_costs_that_deck_and_nothing_else() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        // 300 characters: past NTFS's and ext4's 255-byte component limit both, so this is a
        // refusal on every machine rather than one that depends on long paths being on.
        crate::deck::create_deck(
            &conn,
            &crate::deck::DeckInput {
                name: "L".repeat(300),
                ..Default::default()
            },
        )
        .unwrap();
        let report = pass(&conn, dir.path(), Dirty::ALL);
        assert_eq!(
            report.failed, 14,
            "the deck's seven, and the seven of the collection group v25 makes for it: {report:?}"
        );
        assert!(
            report.written > 0,
            "the rest of the mirror is still written"
        );
        assert!(deck_file(&dir, "Azula").is_file());
        assert!(dir.path().join("Collection/Collection.csv").is_file());
    }

    /// One file that cannot be opened for writing is one file. A directory sitting where a
    /// planned file goes is the cheapest way to make a write refuse on every platform.
    #[test]
    fn one_file_that_cannot_be_written_costs_one_and_the_pass_carries_on() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        std::fs::create_dir_all(dir.path().join("Collection/Collection.csv")).unwrap();
        let report = pass(&conn, dir.path(), Dirty::ALL);
        assert_eq!(report.failed, 1, "{report:?}");
        assert!(report.written > 0);
        assert!(deck_file(&dir, "Azula").is_file());
    }

    #[test]
    fn the_readme_names_both_omissions() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        pass(&conn, dir.path(), Dirty::ALL);
        let readme = std::fs::read_to_string(dir.path().join("README.txt")).unwrap();
        assert!(
            readme.contains("maybeboard"),
            "the Arena/MTGO omission must be stated"
        );
        assert!(
            readme.to_lowercase().contains("not a valid arena import")
                || readme.to_lowercase().contains("every card")
        );
    }

    /// The rest of what spec §3.1 and §3.2 put in this file, plus the manifest R14 added.
    #[test]
    fn the_readme_says_what_the_folder_is_and_that_it_is_disposable() {
        let text = README.to_lowercase();
        for phrase in [
            "generated",
            "overwritten",
            "never read back",
            ".mirror-manifest",
            "deleting it is safe",
            "deleting this whole folder is safe",
        ] {
            assert!(text.contains(phrase), "README.txt must say {phrase:?}");
        }
    }

    /// **The write path's own fence, and the harm it closes is data loss by writing.**
    /// `set_root` accepts any absolute path whose parent exists — a project folder, a Downloads
    /// subfolder, `C:\` — and `README.txt` is the one fixed name the mirror puts at the top of
    /// it. Before this guard the first pass overwrote whatever was there, silently.
    ///
    /// The second pass is the half that is easy to get wrong and impossible to see in the
    /// first: a manifest that named the skipped `README.txt` would make the *next* pass read it
    /// back as ours, so the reader's file would survive one pass and be overwritten by the one
    /// two seconds later.
    #[test]
    fn a_readme_the_mirror_did_not_write_is_left_alone_by_every_pass() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        let theirs = "Notes on the folder I keep my cards in.\n";
        std::fs::write(dir.path().join(README_NAME), theirs).unwrap();

        let first = pass(&conn, dir.path(), Dirty::ALL);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(README_NAME)).unwrap(),
            theirs,
            "the reader's own README was overwritten"
        );
        assert_eq!(first.skipped, 1, "{first:?}");
        assert_eq!(
            first.failed, 0,
            "a file of theirs is not a fault: {first:?}"
        );
        assert!(
            deck_file(&dir, "Azula").is_file(),
            "and the rest of the mirror is still written"
        );
        let manifest = std::fs::read_to_string(dir.path().join(MANIFEST_NAME)).unwrap();
        assert!(
            !manifest.lines().any(|line| line == README_NAME),
            "a manifest may only name files we actually wrote"
        );

        let second = pass(&conn, dir.path(), Dirty::ALL);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(README_NAME)).unwrap(),
            theirs,
            "the second pass read the manifest back and took it anyway"
        );
        assert_eq!(second.skipped, 1, "{second:?}");
    }

    /// The half that keeps the guard above from being a refusal to write anything: a
    /// `README.txt` this app wrote is still rewritten after a reader edits it, which is what
    /// the file itself promises them.
    #[test]
    fn a_readme_the_mirror_wrote_is_rewritten_after_a_reader_edits_it() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        pass(&conn, dir.path(), Dirty::ALL);
        std::fs::write(dir.path().join(README_NAME), b"I typed over it").unwrap();

        let report = pass(&conn, dir.path(), Dirty::ALL);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(README_NAME)).unwrap(),
            README,
            "a file the manifest names is ours to rewrite"
        );
        assert_eq!(report.skipped, 0, "{report:?}");
    }

    /// The one arm that keeps the guard from being permanent. `README.txt` tells the reader
    /// deleting `.mirror-manifest` is safe; a guard with no content check would then freeze the
    /// README *we* wrote at whatever that build said, for good, because no later manifest would
    /// ever name it again.
    #[test]
    fn a_readme_identical_to_ours_is_adopted_when_the_manifest_is_gone() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        pass(&conn, dir.path(), Dirty::ALL);
        std::fs::remove_file(dir.path().join(MANIFEST_NAME)).unwrap();

        let report = pass(&conn, dir.path(), Dirty::ALL);
        assert_eq!(report.skipped, 0, "our own README was disowned: {report:?}");
        let manifest = std::fs::read_to_string(dir.path().join(MANIFEST_NAME)).unwrap();
        assert!(manifest.lines().any(|line| line == README_NAME));
    }

    /// **M2: `is_ours` ignores ASCII case and `wanted` did not, so `recover` could delete a
    /// file it wanted.** Reachable only with no manifest, and only after a reader or a sync
    /// client has re-cased one of our files — and it costs that file in the same pass that
    /// wrote it, because `put` runs before `prune`.
    ///
    /// **This test is sharp on a case-insensitive filesystem and vacuous on a case-sensitive
    /// one, deliberately.** On Windows `put` writes *through* the existing `AZULA.TXT` — one
    /// file under two spellings — so a case-sensitive `wanted` deletes the only copy. On Linux
    /// they are two files: `put` creates the planned one, `AZULA.TXT` really is an orphan, and
    /// sparing it is the case-insensitive lookup erring toward leaving a file rather than
    /// removing one. Every measured claim in this repo was taken on Windows, which is also the
    /// platform `is_ours` ignores case for.
    ///
    /// **So the assertion is "the planned file survived", not "exactly one file survived".**
    /// The count is 1 on Windows and 2 on Linux and both are correct; asserting the count made
    /// this red on the Linux half of the CI matrix (run 32811287174) while the code under test
    /// was doing the right thing on both. `is_file` on the planned path is the invariant that
    /// actually holds everywhere: `recover` may never delete a file it wants.
    #[test]
    fn recover_keeps_a_file_it_wants_whose_casing_has_drifted() {
        let (conn, dir, _) = seeded_db_and_temp_root();
        pass(&conn, dir.path(), Dirty::ALL);

        // Re-cased by hand rather than by `rename`, which is not a case-only rename everywhere.
        let planned = deck_file(&dir, "Azula");
        let body = std::fs::read(&planned).unwrap();
        std::fs::remove_file(&planned).unwrap();
        std::fs::write(dir.path().join("Decks/Azula/AZULA.TXT"), &body).unwrap();
        std::fs::remove_file(dir.path().join(MANIFEST_NAME)).unwrap();

        pass(&conn, dir.path(), Dirty::ALL);

        assert!(
            planned.is_file(),
            "the deck's plain file was deleted by the pass that wrote it"
        );
        assert_eq!(
            std::fs::read(&planned).unwrap(),
            body,
            "the surviving file is not the one the pass wrote"
        );
    }

    #[test]
    fn the_readme_and_the_manifest_survive_every_prune() {
        let (conn, dir, id) = seeded_db_and_temp_root();
        let mut cache = DigestCache::default();
        run_pass(&conn, dir.path(), Dirty::ALL, &mut cache).unwrap();
        crate::deck::delete_deck(&conn, id, None).unwrap();
        run_pass(&conn, dir.path(), Dirty::ALL, &mut cache).unwrap();
        assert!(dir.path().join("README.txt").is_file());
        assert!(dir.path().join(MANIFEST_NAME).is_file());
        assert!(!dir.path().join("Decks/Azula").exists());
        assert!(dir.path().is_dir(), "and the root itself is never removed");
    }
}
