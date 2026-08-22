//! An in-memory index over the card corpus, in the shape a search engine uses.
//!
//! **Why this exists rather than more SQL.** Faceting needs a count per option per
//! dimension on every filter press. The SQL side is measured, 2026-08-11, timed through
//! `node:sqlite` against a page-for-page online backup of the live 116 694-printing
//! database — the work is inside SQLite's own C, so no build of this crate enters into
//! those numbers: a four-dimension pass costs 2 238 ms against `cards` as it stands, 62 ms
//! with a covering index and [`crate::legalities`]' mask, and 106–167 ms at best over a
//! rowid-aligned shadow table — because a one-character search box entry matches 100 129
//! rows and seeking those rowids is the floor.
//!
//! **The in-memory side of that comparison is a projection, not a measurement of this
//! code.** 0.31 ms for the same pass and a 57 ms worst case (25 ms of it the FTS scan
//! nothing avoids) come from the design doc's §3.2 table, whose own header reads "JS
//! harness, so a conservative bound on Rust" — a model of a structure that did not exist
//! yet. It was not a conservative bound on the one case both cover: [`facets::compute`]
//! measures **1.8 ms** unfiltered (release, synthetic corpus, best of five), 5.8× the
//! projected figure and still two orders inside spec §2's 100 ms budget. Read the Rust
//! numbers off [`facets::compute`]; the projection is kept only because it is what the
//! design was decided on.
//!
//! **Low cardinality gets a bitset, high cardinality an ordinal array.** Giving each of the
//! 986 set codes its own bitset was the first design and was wrong by 18× on memory and 35×
//! on speed — 14.3 MB and 11 ms against 0.78 MB and 0.12 ms. Sets get `set_ord`, a `u16` per
//! doc, and are counted by walking the base and bumping a counter.
//!
//! **It is derived, and it is rebuilt wholesale.** Nothing here is patched incrementally
//! except [`CardIndex::owned`], which is the one dimension the user changes while the app is
//! running. `cards` is dropped and recreated by every sync, which renumbers every rowid, so
//! the index is rebuilt after each swap — see [`lifecycle`].

pub mod bitset;
pub mod facets;
pub mod lifecycle;

use bitset::BitSet;
use rusqlite::Connection;

// `Clone` is for exactly one caller: `lifecycle::invalidate_owned`, which copies the
// published index, re-reads `owned` into the copy and publishes that. Copy-on-write rather
// than mutation because readers hold the live one behind an `Arc` — there is no `&mut` to be
// had, and there should not be. It is a deep copy of every bitset and ordinal (~1 MB over the
// live corpus, all of it memcpy), which is the price of not blocking them.
#[derive(Clone)]
pub struct CardIndex {
    /// Rowid ceiling every bitset here was built against, **rounded up to a whole word** —
    /// see `build`. Every sibling array indexed by a doc id is this long.
    pub capacity: usize,
    /// Every printing in the corpus. Not the same as "all bits below `capacity`": rowid 0
    /// is never issued and the padding above the last row is not a card, so this is what a
    /// request with `paperOnly: false` narrows from.
    pub all: BitSet,
    pub paper: BitSet,
    /// WUBRG then C, indexed by [`CardIndex::color_index`].
    pub colors: [BitSet; 6],
    /// 0–7 exact, 8 is "8 or more", 9 is "no mana value at all".
    pub mana: [BitSet; Self::MANA_BUCKETS],
    /// Printings whose printed cost carries an `{X}` — [`crate::filters::CardFilters::mana_x`]'s
    /// bitset, mirroring that filter's `mana_cost LIKE '%{X}%'`.
    ///
    /// **A field of its own and not an eleventh bucket, because the two are different kinds of
    /// thing.** [`Self::mana`] is a *partition*: every printing lands in exactly one of its
    /// slots (or, for a fraction below 8, in none), which is what lets a bucket be counted by a
    /// single `and_count` and what makes [`Self::MANA_BUCKETS`] a closed list. X is an
    /// *overlay*: a card is in its mana-value bucket **and**, if its cost is variable, in here
    /// too — `{X}{B}{B}{B}` is `mana[3]` and `mana_x` at once, because Scryfall scores X as 0
    /// when it computes `cmc`. Widening `MANA_BUCKETS` to make room would put a card in two
    /// buckets of a partition and quietly double every total counted over it.
    pub mana_x: BitSet,
    /// One per [`crate::legalities::LEGALITY_KEYS`] entry, same order.
    pub formats: Vec<BitSet>,
    /// Printings with a **non-zero** `legal_mask` — playable in at least one format.
    ///
    /// Not a facet dimension and not offered as one: it is
    /// [`crate::filters::CardFilters::playable_only`]'s bitset, mirroring that filter's
    /// `legal_mask != 0` so it can ride every facet base the way `paper` does.
    ///
    /// Set per row rather than folded out of [`Self::formats`] afterwards, because the SQL it
    /// has to agree with tests the stored integer and not the 23 bits this build knows how to
    /// name. The two are the same set today — [`crate::legalities::legal_mask`] only ever sets
    /// bits it has a key for — and only one of them stays right if that ever stops being true.
    pub playable: BitSet,
    /// Set ordinal per doc, indexing [`CardIndex::set_codes`]. `u16` because 986 codes is
    /// three orders of magnitude inside its range and this array is one per printing.
    pub set_ord: Vec<u16>,
    pub set_codes: Vec<String>,
    /// Printings the collection has an **entry** for — quantity 0 included, exactly as the
    /// search's `owned` filter reads it.
    pub owned: BitSet,
}

impl CardIndex {
    pub const COLOR_KEYS: [char; 6] = ['W', 'U', 'B', 'R', 'G', 'C'];
    pub const MANA_BUCKETS: usize = 10;
    /// The bucket for a printing with no `cmc`. Not bucket 0: a card that costs nothing and
    /// a card whose cost is unknown are different answers, and no chip asks for the latter.
    pub const MANA_UNKNOWN: usize = 9;

    pub fn color_index(letter: char) -> Option<usize> {
        Self::COLOR_KEYS.iter().position(|c| *c == letter)
    }

    /// Read every facet column once and fill the arrays.
    ///
    /// **767 ms, measured 2026-08-11** — median of five (762–783 ms), release build, over a
    /// page-for-page online backup of the day's database: 116 695 printings, 107 338 of them
    /// paper, 1 047 set codes. **Two things bound what that number is worth.** It was taken
    /// with a *warm* OS page cache on the 563 MB file, so it is the cost of any launch but
    /// the machine's first — launch-after-reboot is the cold case, it is the case the 1.5 s
    /// ceiling was really about, and nobody has measured it. And the snapshot came from
    /// `main`'s schema lineage, so `legal_mask` was added to it by a hand-run `ALTER TABLE`
    /// and a backfill that rewrote all 116 695 rows: the page layout scanned here is that
    /// rewrite's, which may be more or less fragmented than a synced database's. The spec
    /// left this figure *estimated* at "467 ms for five
    /// columns, and the real read wants about fifteen"; the read as built wants **seven**
    /// (`rowid`, `set_code`, `cmc`, `color_identity`, `legal_mask`, `is_paper`, `mana_cost`),
    /// which is where the estimate's headroom went. **The 767 ms was measured at six** — the
    /// X overlay added `mana_cost` afterwards and nobody has re-timed it, so read that figure
    /// as a floor rather than as this read's cost. Comfortably inside the ~1.5 s at which the
    /// spec would have spent its fallback — a covering index for this read — so that stays
    /// unspent. It is a full table scan today and no existing index changes that:
    /// `idx_cards_collapse` carries neither `set_code` nor `mana_cost`, and one missing column
    /// is the whole of it.
    ///
    /// 1 047 set codes rather than the 986 the module docs quote, because those are the
    /// *paper* sets (986 exactly, re-measured on the same snapshot) and this array covers
    /// every printing — a digital-only set still needs an ordinal.
    ///
    /// **Give this its own read-only connection.** It is a full pass over `cards` and holding
    /// `AppState.db_read` for it would stall every search behind it at launch, which is the
    /// exact failure that second connection exists to prevent.
    pub fn build(conn: &Connection) -> rusqlite::Result<CardIndex> {
        // **One read transaction over both halves of the build.** The corpus scan and the
        // `rebuild_owned` that follows it are two statements, and in autocommit they are two
        // snapshots: a swap landing between them leaves the bitsets describing one generation
        // of rowids and `owned` describing the next, which is an index that says the user
        // owns cards they have never seen. The post-swap rebuild repairs that a few seconds
        // later, so it was only ever a window — but a window is not a guarantee, and one
        // `BEGIN` makes it structural. Deferred, so it takes SQLite's read snapshot at the
        // first statement and releases it on drop without ever writing anything.
        //
        // `unchecked_transaction` because `build` takes `&Connection` (the caller's handle is
        // read-only and shared); it would refuse a connection already inside a transaction,
        // and no caller here is.
        let tx = conn.unchecked_transaction()?;
        let conn = &*tx;

        let highest = conn.query_row("SELECT coalesce(max(rowid), 0) + 1 FROM cards", [], |r| {
            r.get::<_, i64>(0)
        })? as usize;

        // **`capacity` is the bitset's rounded figure, never the row count.** `BitSet::new`
        // rounds up to a whole word, so a set asked for 116 695 docs holds 116 736 — and
        // `set` *accepts* a doc in that padding window rather than dropping it, which is
        // exactly the leniency that lets a sync grow the corpus under a live index. Size
        // every sibling array indexed by the same doc ids from this number, or
        // `paper.for_each` can hand `set_ord` an index up to 63 past its end. The reachable
        // path is `rebuild_owned` re-reading a grown `cards` against a stale capacity.
        let paper = BitSet::new(highest);
        let capacity = paper.capacity();

        let mut ix = CardIndex {
            capacity,
            all: BitSet::new(capacity),
            paper,
            colors: std::array::from_fn(|_| BitSet::new(capacity)),
            mana: std::array::from_fn(|_| BitSet::new(capacity)),
            mana_x: BitSet::new(capacity),
            formats: (0..crate::legalities::LEGALITY_KEYS.len())
                .map(|_| BitSet::new(capacity))
                .collect(),
            playable: BitSet::new(capacity),
            set_ord: vec![0; capacity],
            set_codes: Vec::new(),
            owned: BitSet::new(capacity),
        };

        let mut seen: std::collections::HashMap<String, u16> = std::collections::HashMap::new();
        let mut stmt = conn.prepare(
            "SELECT rowid, set_code, cmc, color_identity, legal_mask, is_paper, mana_cost
               FROM cards",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let doc: i64 = row.get(0)?;
            let doc = doc as u32;
            let set_code: String = row.get(1)?;
            let cmc: Option<f64> = row.get(2)?;
            let identity: Option<String> = row.get(3)?;
            let mask: Option<i64> = row.get(4)?;
            let paper: bool = row.get(5)?;
            // Nullable, and a NULL cost carries no `{X}` — the same answer the SQL gives, where
            // `NULL LIKE '%{X}%'` is NULL rather than false. Read as `Option` so a row with no
            // printed cost is a miss instead of a `rusqlite` type error that fails the build.
            let mana_cost: Option<String> = row.get(6)?;

            ix.all.set(doc);
            if paper {
                ix.paper.set(doc);
            }

            let next = seen.len() as u16;
            let ord = *seen.entry(set_code.clone()).or_insert_with(|| {
                ix.set_codes.push(set_code.clone());
                next
            });
            if let Some(slot) = ix.set_ord.get_mut(doc as usize) {
                *slot = ord;
            }

            // An empty identity is colourless and a NULL one is unknown; both land on the
            // colourless side, which is what `push_card_filters` does with them too.
            let identity = identity.unwrap_or_default();
            if identity.is_empty() {
                ix.colors[5].set(doc);
            } else {
                for ch in identity.chars() {
                    if let Some(i) = Self::color_index(ch) {
                        ix.colors[i].set(doc);
                    }
                }
            }

            // **A bucket is what the matching chip would return, so some printings have
            // none.** [`crate::filters::push_card_filters`] spells chips 0–7 as
            // `cmc IN (0.0, 1.0, …)` — exact float equality — and chip 8 as `cmc >= 8.0`,
            // a range. The two halves therefore treat a fractional cost differently, and
            // the order of these arms is that difference:
            //
            // - at or above 8 a fraction **is** returned by the open-ended chip, so 8.5
            //   belongs in bucket 8 and this arm has to come first;
            // - below 8 a fraction equals no chip's value, so it belongs in **no** bucket.
            //   Counting it under the truncated chip would promise a card the search will
            //   not return, which is the whole failure faceting exists to prevent.
            //
            // Worth a branch for one card: the live corpus holds exactly one fractional
            // printing, `Little Girl` (unh, cmc 0.5, paper), and none at all above 8
            // (measured 2026-08-11). So chip 0 would over-count by one, permanently.
            let bucket = match cmc {
                None => Some(Self::MANA_UNKNOWN),
                Some(v) if v >= 8.0 => Some(8),
                Some(v) if v.fract() != 0.0 => None,
                // `v` is integral and below 8 here, so the clamp is a fence against a
                // future reordering of these arms rather than live arithmetic — and a
                // clamped index is a wrong count where a bare one is a panic.
                Some(v) => Some((v as usize).min(8)),
            };
            if let Some(bucket) = bucket {
                ix.mana[bucket].set(doc);
            }

            // **On top of the bucket above, never instead of it.** The X chip is an overlay:
            // `{X}{B}{B}{B}` is `mana[3]` *and* `mana_x`, because Scryfall counts X as 0 in
            // `cmc`. Substring rather than parse, mirroring
            // [`crate::filters::VARIABLE_COST_LIKE`] character for character — the SQL and this
            // bitset answer the same question or the chip greys out over results that exist.
            if mana_cost.is_some_and(|c| c.contains("{X}")) {
                ix.mana_x.set(doc);
            }

            let mask = mask.unwrap_or(0) as u64;
            // The whole integer, before it is picked apart into bits — `legal_mask != 0`, the
            // predicate `push_card_filters` emits for `playable_only`.
            if mask != 0 {
                ix.playable.set(doc);
            }
            for (k, set) in ix.formats.iter_mut().enumerate() {
                if mask & (1u64 << k) != 0 {
                    set.set(doc);
                }
            }
        }
        drop(rows);
        drop(stmt);

        ix.rebuild_owned(conn)?;
        Ok(ix)
    }

    /// Re-read just the `owned` dimension — cheap enough to run on every collection write.
    ///
    /// 10–23 ms at 200/2 000/12 000 owned printings, **per the design doc; not re-measured
    /// here**, because the snapshot `build`'s figure above was taken over held no collection
    /// entries at all. Unlike that figure, this one is inherited.
    ///
    /// The join reads `cards`' primary-key index for the rowid and never the row, so the
    /// cost is one index probe per collection entry.
    ///
    /// **The statement is built rather than literal** — [`crate::collection_source::owned_rowids`]
    /// decides which table it reads, so with the deck-driven collection on the probe is one
    /// per live *deck row* instead of one per collection entry, and the dimension is the
    /// decks' answer rather than the table's.
    pub fn rebuild_owned(&mut self, conn: &Connection) -> rusqlite::Result<()> {
        let mut owned = BitSet::new(self.capacity);
        let mut stmt = conn.prepare(&crate::collection_source::owned_rowids(conn))?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let doc: i64 = row.get(0)?;
            owned.set(doc as u32);
        }
        drop(rows);
        drop(stmt);
        self.owned = owned;
        Ok(())
    }
}

/// The corpus every test in this module tree counts against.
///
/// Its own module rather than `tests`', because [`facets`] counts over exactly this fixture
/// and a second copy of it would be a second corpus: the numbers those tests assert (2 in
/// `lea`, 1 in `rav`, 3 paper) are properties of *these four rows*, so the two files must
/// read the same ones or the assertions stop meaning what they say.
#[cfg(test)]
pub(crate) mod fixtures {
    use rusqlite::Connection;

    /// `(id, name, set_code, cmc, color_identity, is_paper, legal_mask)` — the five columns
    /// [`super::CardIndex::build`] reads plus the two `cards` will not take a row without.
    /// Named because `clippy::type_complexity` will not take a seven-element tuple written
    /// out, and a `type` definition is the remedy the lint itself asks for.
    type Printing = (
        &'static str,
        &'static str,
        &'static str,
        Option<f64>,
        &'static str,
        i64,
        i64,
    );

    /// Four printings that between them exercise every column the index reads: a colourless
    /// card, a two-colour one, a digital-only one, and one with no `cmc` at all.
    ///
    /// **Every row names `legal_mask` explicitly.** The column is `NOT NULL DEFAULT 0`, so a
    /// fixture that omits it inserts happily and answers *empty* for every format assertion
    /// over it — a green test that proves nothing, which is why `search.rs` grew
    /// `fill_legal_mask` for its own fixtures.
    pub(crate) fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        seed(&conn);
        conn
    }

    /// The same four rows into a connection someone else opened — which is the whole reason
    /// this is split out of [`seeded`]: [`state_with_seeded_cards`] needs them in a **file**
    /// database, and an in-memory one cannot be reached by the second connection the
    /// lifecycle opens for itself.
    pub(crate) fn seed(conn: &Connection) {
        let modern = crate::legalities::bit("modern").unwrap() as i64;
        let rows: [Printing; 4] = [
            ("1", "Lightning Bolt", "lea", Some(1.0), "R", 1, modern),
            ("2", "Lightning Helix", "rav", Some(2.0), "RW", 1, modern),
            ("3", "Sol Ring", "lea", Some(1.0), "", 1, 0),
            ("4", "Digital Only", "alc", None, "B", 0, 0),
        ];
        for (id, name, set, cmc, ci, paper, mask) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,
                    color_identity,is_paper,legal_mask,raw)
                 VALUES (?1,?2,?3,'1','en','normal',?4,?5,?6,?7,'{}')",
                rusqlite::params![id, name, set, cmc, ci, paper, mask],
            )
            .unwrap();
        }
    }

    /// The same four printings on a **file** database, inside the [`crate::sync::AppState`]
    /// the app runs on — `update::tests::file_state`'s arrangement, for its reason.
    ///
    /// A file and not `:memory:`, because [`super::lifecycle::build_now`] opens a read-only
    /// connection of its **own** from `data_dir`: two in-memory connections are two different
    /// databases, so an in-memory state would build an index over an empty corpus and every
    /// count here would be zero.
    ///
    /// `name` is a directory name rather than one shared path because `cargo test` runs these
    /// in parallel — the brief's parameterless version had five tests sharing one path, where
    /// each one's first act is to delete the directory the others are mid-build over.
    ///
    /// **Unique crate-wide, not merely within a module.** The name is the whole of the temp
    /// directory, so two callers agreeing by accident is the same collision whatever files
    /// they live in — and the failure it produces is a flaky test blaming a count. 15 names
    /// across three modules today (`index::lifecycle`, `index::facets` via its own `state`
    /// wrapper, and `collection`); `grep` for the call before inventing a sixteenth.
    pub(crate) fn state_with_seeded_cards(name: &str) -> std::sync::Arc<crate::sync::AppState> {
        let dir = std::env::temp_dir().join(format!("mtgtest-lifecycle-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mtg.db");
        let conn = crate::db::open(&path).unwrap();
        crate::schema::migrate(&conn).unwrap();
        seed(&conn);
        let read = crate::db::open_read_only(&path).unwrap();
        std::sync::Arc::new(crate::sync::AppState {
            db: std::sync::Mutex::new(conn),
            db_read: std::sync::Mutex::new(read),
            data_dir: dir.clone(),
            syncing: std::sync::atomic::AtomicBool::new(false),
            // Never called: nothing in the lifecycle reaches the network or an image.
            client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
            images: crate::images::Cache::new(dir.join("images")),
            index: std::sync::RwLock::default(),
        })
    }

    /// A collection entry for one printing. `set_code`/`collector_number` are denormalized
    /// migration insurance rather than part of [`crate::schema::COLLECTION_GRAIN`], so they
    /// are filler here — the `card_id` is what makes two entries distinct.
    pub(crate) fn own(conn: &Connection, card_id: &str, quantity: i64) {
        conn.execute(
            "INSERT INTO collection_entries (card_id,set_code,collector_number,lang,finish,
                quantity,created_at,updated_at)
             VALUES (?1,'lea','1','en','nonfoil',?2,unixepoch(),unixepoch())",
            rusqlite::params![card_id, quantity],
        )
        .unwrap();
    }

    /// One printing's rowid — the doc id every bitset here is keyed by.
    pub(crate) fn doc(conn: &Connection, id: &str) -> u32 {
        conn.query_row("SELECT rowid FROM cards WHERE id=?1", [id], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{doc, own, seeded};
    use super::*;

    #[test]
    fn the_paper_set_holds_paper_printings_and_nothing_else() {
        let ix = CardIndex::build(&seeded()).unwrap();
        assert_eq!(ix.paper.count(), 3);
        // `all` is the corpus and not "every bit below `capacity`": rowid 0 is never issued
        // and the padding above the last row is not a card, so a `paperOnly: false` request
        // narrows from this rather than from a total.
        assert_eq!(ix.all.count(), 4, "the digital printing is a card too");
    }

    /// The capacity trap, walked rather than asserted. `BitSet::new` rounds up to a whole
    /// word, and [`bitset::BitSet::set`] deliberately *accepts* a doc that lands in the
    /// padding rather than dropping it — which is what lets a sync grow the corpus under a
    /// live index. So `set_ord` must be as long as the bitsets genuinely are: sized from the
    /// row count instead, it is 5 elements here while `rebuild_owned` emits docs up to 24.
    ///
    /// Nothing here claims the grown rows' *ordinals* are right — they are not, and they are
    /// not meant to be. A sync renumbers every rowid and the whole index is rebuilt after the
    /// swap; `rebuild_owned` refreshes the one dimension a collection write moves. What the
    /// walk pins is that the stale window is an out-of-date answer and never an index panic.
    #[test]
    fn every_doc_the_bitsets_can_hold_has_a_slot_in_set_ord() {
        let conn = seeded();
        let mut ix = CardIndex::build(&conn).unwrap();
        assert_eq!(
            ix.capacity,
            ix.paper.capacity(),
            "the rounded figure, not 5"
        );
        assert_eq!(ix.set_ord.len(), ix.capacity);

        for n in 5..=24 {
            let id = n.to_string();
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
                 VALUES (?1,'Grown','grn',?1,'en','normal',1,'{}')",
                rusqlite::params![id],
            )
            .unwrap();
            own(&conn, &id, 1);
        }
        ix.rebuild_owned(&conn).unwrap();
        assert_eq!(
            ix.owned.count(),
            20,
            "every grown printing landed in the padding"
        );
        ix.owned.for_each(|d| {
            assert!(
                (d as usize) < ix.set_ord.len(),
                "doc {d} was emitted with no slot in set_ord"
            );
        });
    }

    /// [`super::fixtures::seeded`]'s four printings, plus one deck holding two of them:
    /// `1` sleeved up, `2` only planned for. Nothing is entered by hand, so the `owned`
    /// dimension is empty until the setting is on.
    fn deck_driven_index_db() -> Connection {
        let conn = seeded();
        conn.execute_batch(
            "INSERT INTO decks (id, name, created_at, updated_at) VALUES (1,'Atraxa',0,0);
             INSERT INTO deck_categories (id, deck_id, name, kind, is_active, sort_order,
                                          created_at, updated_at)
                  VALUES (10,1,'Ramp','main',1,0,0,0);
             INSERT INTO deck_cards (deck_id, category_id, variant, card_id, set_code,
                                     collector_number, lang, name, quantity, finish,
                                     created_at, updated_at)
                  VALUES (1,10,'live','1','lea','1','en','Lightning Bolt',2,NULL,0,0),
                         (1,10,'live','1','lea','1','en','Lightning Bolt',1,'foil',0,0),
                         (1,10,'theory','2','rav','1','en','Lightning Helix',3,NULL,0,0);",
        )
        .unwrap();
        conn
    }

    /// The facet index's `owned` dimension follows the setting: with the collection derived
    /// from the decks it is the live deck lists, **de-duplicated** — two rows of the same
    /// printing are one bit, which is what `SELECT DISTINCT` is for.
    #[test]
    fn rebuild_owned_reads_the_decks_when_deck_driven() {
        let conn = deck_driven_index_db();
        crate::deck_driven::store(&conn, true).unwrap();
        let mut index = CardIndex::build(&conn).unwrap();
        index.rebuild_owned(&conn).unwrap();
        assert_eq!(index.owned.count(), 1, "one live printing, one owned card");
        assert!(index.owned.contains(doc(&conn, "1")));
        assert!(
            !index.owned.contains(doc(&conn, "2")),
            "a theory row is a plan, not a card the reader has"
        );
    }

    /// The same fixture with the setting **off** — the dimension is the hand-kept table,
    /// which is empty however full the decks are. Without this a swap that read the decks
    /// unconditionally would pass the test above.
    #[test]
    fn rebuild_owned_still_reads_the_table_when_the_setting_is_off() {
        let conn = deck_driven_index_db();
        let mut index = CardIndex::build(&conn).unwrap();
        index.rebuild_owned(&conn).unwrap();
        assert_eq!(index.owned.count(), 0);
        own(&conn, "3", 1);
        index.rebuild_owned(&conn).unwrap();
        assert_eq!(index.owned.count(), 1, "the entry the reader typed in");
    }

    /// Colour identity is per letter, and the empty identity is its own bucket — `C` means
    /// colourless, which is a fact about a card and not the absence of one.
    #[test]
    fn colour_bitsets_are_per_letter_with_colourless_its_own() {
        let ix = CardIndex::build(&seeded()).unwrap();
        let idx = |c| CardIndex::color_index(c).unwrap();
        assert_eq!(
            ix.colors[idx('R')].and_count(&ix.paper),
            2,
            "Bolt and Helix"
        );
        assert_eq!(ix.colors[idx('W')].and_count(&ix.paper), 1, "Helix");
        assert_eq!(ix.colors[idx('C')].and_count(&ix.paper), 1, "Sol Ring");
        assert_eq!(
            ix.colors[idx('B')].and_count(&ix.paper),
            0,
            "the black card is digital"
        );
    }

    /// Bucket 9 is "no mana value at all", which is not bucket 0: a card that costs nothing
    /// and a card whose cost is unknown are different answers, and `cmc` is nullable.
    ///
    /// The two fractional rows pin the **order** of `build`'s arms against
    /// [`crate::filters::push_card_filters`], which spells chips 0–7 as
    /// `cmc IN (0.0, 1.0, …)` and chip 8 as `cmc >= 8.0`. Exact equality below, a range at
    /// the top — so 0.5 is returned by no chip and 8.5 is returned by the last one, and a
    /// bucket the search disagrees with is a greyed-out option that should have been live.
    /// `Little Girl` is the live corpus's one fractional printing; nothing above 8 has a
    /// fractional cost today, so row 8 is a fence for the arm order rather than a model of
    /// real data.
    #[test]
    fn mana_buckets_separate_zero_from_unknown_and_cap_at_eight() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,is_paper,raw)
             VALUES ('5','Emrakul','roe','1','en','normal',15.0,1,'{}'),
                    ('6','Ancestral','lea','2','en','normal',0.0,1,'{}'),
                    ('7','Little Girl','unh','3','en','normal',0.5,1,'{}'),
                    ('8','Synthetic 8.5','unh','4','en','normal',8.5,1,'{}')",
            [],
        )
        .unwrap();
        let ix = CardIndex::build(&conn).unwrap();
        assert_eq!(
            ix.mana[0].and_count(&ix.paper),
            1,
            "the zero-cost card, and not Little Girl"
        );
        assert_eq!(
            ix.mana[8].and_count(&ix.paper),
            2,
            "15 and 8.5 both, because chip 8 is a range"
        );
        assert_eq!(
            ix.mana[9].count(),
            1,
            "the NULL cmc row, digital though it is"
        );

        let little_girl = doc(&conn, "7");
        assert!(
            (0..CardIndex::MANA_BUCKETS).all(|b| !ix.mana[b].contains(little_girl)),
            "a fractional cost below 8 equals no chip's value, so it belongs in no bucket \
             — least of all bucket 9, which means having no cost at all"
        );
        assert!(
            ix.mana[8].contains(doc(&conn, "8")),
            "but `cmc >= 8.0` does return a fraction, so this one has a bucket"
        );
    }

    /// **X is an overlay on the buckets, not a bucket.** `mana` is a partition and `mana_x` is
    /// not, which is the whole reason it is a field of its own: Scryfall scores X as 0 when it
    /// computes `cmc`, so `{X}{B}{B}{B}` is mana value 3 — it has to be in `mana[3]` *and* in
    /// `mana_x`, or the two chips disagree about a card that satisfies both.
    ///
    /// The NULL row is the second half. `cards.mana_cost` is nullable, and the SQL this mirrors
    /// answers `NULL LIKE '%{X}%'` — which is NULL, not true — so a printing with no printed
    /// cost belongs in neither set. Reading the column as a bare `String` would have been a
    /// `rusqlite` error on exactly that row and would have failed the whole build.
    #[test]
    fn a_variable_cost_is_in_its_mana_bucket_and_in_the_x_overlay_at_once() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,mana_cost,
                is_paper,raw)
             VALUES ('5','Crux of Fate','ktk','1','en','normal',3.0,'{X}{B}{B}{B}',1,'{}'),
                    ('6','Plain Cost','ktk','2','en','normal',3.0,'{1}{B}{B}',1,'{}'),
                    ('7','No Cost At All','ktk','3','en','normal',3.0,NULL,1,'{}')",
            [],
        )
        .unwrap();
        let ix = CardIndex::build(&conn).unwrap();

        let variable = doc(&conn, "5");
        assert!(
            ix.mana[3].contains(variable),
            "X costs nothing towards `cmc`, so the card is still mana value 3"
        );
        assert!(ix.mana_x.contains(variable), "and it is in the overlay too");

        assert!(ix.mana[3].contains(doc(&conn, "6")));
        assert!(
            !ix.mana_x.contains(doc(&conn, "6")),
            "the same mana value with no `{{X}}` is in the bucket alone"
        );
        assert!(
            !ix.mana_x.contains(doc(&conn, "7")),
            "and a NULL cost is a miss, exactly as `NULL LIKE …` is not true"
        );
        assert_eq!(
            ix.mana_x.count(),
            1,
            "the fixture's four rows carry no cost"
        );
    }

    #[test]
    fn set_ordinals_resolve_back_to_their_codes() {
        let ix = CardIndex::build(&seeded()).unwrap();
        let mut counts = vec![0u32; ix.set_codes.len()];
        ix.paper
            .for_each(|d| counts[ix.set_ord[d as usize] as usize] += 1);
        let lea = ix.set_codes.iter().position(|c| c == "lea").unwrap();
        let rav = ix.set_codes.iter().position(|c| c == "rav").unwrap();
        assert_eq!(counts[lea], 2);
        assert_eq!(counts[rav], 1);
    }

    /// `playable` is the whole mask asked one question — "is any bit set" — and it has to
    /// answer it for a bit this build cannot *name*, because the SQL it mirrors
    /// (`legal_mask != 0`) tests the stored integer rather than the 23 keys
    /// [`crate::legalities::LEGALITY_KEYS`] holds. Folding [`CardIndex::formats`] together
    /// instead would pass every assertion here but the last one, and would grey a card out of
    /// a search that returns it the day Scryfall's list outruns ours.
    #[test]
    fn playable_holds_the_printings_with_any_legality_bit_at_all() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                legal_mask,raw)
             VALUES ('5','Lightning Bolt Art Card','astx','76','en','art_series',1,0,'{}'),
                    ('6','Unnamed Format','fut','1','en','normal',1,?1,'{}')",
            [1i64 << 63],
        )
        .unwrap();

        let ix = CardIndex::build(&conn).unwrap();
        assert!(
            ix.playable.contains(doc(&conn, "1")),
            "Bolt is modern-legal"
        );
        assert!(
            !ix.playable.contains(doc(&conn, "3")),
            "Sol Ring masks to 0"
        );
        assert!(
            !ix.playable.contains(doc(&conn, "5")),
            "an art card is legal nowhere"
        );
        assert!(
            ix.playable.contains(doc(&conn, "6")),
            "a bit with no key is still a bit, and `legal_mask != 0` returns the row"
        );
        assert_eq!(
            ix.playable.and_count(&ix.paper),
            3,
            "Bolt, Helix and the bit"
        );
    }

    #[test]
    fn formats_are_indexed_by_the_frozen_key_order() {
        let ix = CardIndex::build(&seeded()).unwrap();
        let modern = crate::legalities::LEGALITY_KEYS
            .iter()
            .position(|k| *k == "modern")
            .unwrap();
        assert_eq!(ix.formats[modern].and_count(&ix.paper), 2);
    }

    /// `owned` is read **at build** and can be re-read on its own — it is the one dimension
    /// the user changes while the app is running, so a quick-add must not cost a full
    /// rebuild.
    ///
    /// **The entry goes in before the build, and that ordering is the test.** A version that
    /// only ever inserted afterwards could not tell whether `build` reads
    /// `collection_entries` at all: its opening `owned.count() == 0` is equally true of an
    /// index that read an empty collection and of one that never looked, because the bitset
    /// arrives zeroed either way. Delete `build`'s `rebuild_owned` call and that version
    /// stays green — while the app comes up at launch with an empty Owned facet over a real
    /// collection, which is exactly the greyed-out-option-that-should-be-live harm faceting
    /// exists to prevent.
    #[test]
    fn owned_is_read_at_build_and_re_read_on_its_own() {
        let conn = seeded();
        // An **entry**, not a copy: quantity 0 still counts as owned, exactly as the
        // search's `owned` filter reads it ("a row emptied to zero is a row the collection
        // keeps").
        own(&conn, "1", 0);

        let mut ix = CardIndex::build(&conn).unwrap();
        assert_eq!(ix.owned.count(), 1, "the build reads the collection");
        assert!(
            ix.owned.contains(doc(&conn, "1")),
            "and reads the right row"
        );

        own(&conn, "2", 3);
        ix.rebuild_owned(&conn).unwrap();
        assert_eq!(ix.owned.count(), 2, "and a re-read picks up a later write");
        assert_eq!(ix.paper.count(), 3, "the rest of the index is untouched");
    }

    /// Not a unit test — a stopwatch. `--ignored`, because it needs a real database and a
    /// path only a developer has. The number it prints belongs in `CardIndex::build`'s doc
    /// comment, which is where this crate keeps its measurements.
    #[test]
    #[ignore]
    fn warmup_timing() {
        let path = std::env::var("MTG_WARMUP_DB").expect("set MTG_WARMUP_DB to a copied mtg.db");
        let conn = crate::db::open_read_only(std::path::Path::new(&path)).unwrap();
        let t = std::time::Instant::now();
        let ix = CardIndex::build(&conn).unwrap();
        println!(
            "built in {:?} — {} docs, {} sets",
            t.elapsed(),
            ix.paper.count(),
            ix.set_codes.len()
        );
    }
}
