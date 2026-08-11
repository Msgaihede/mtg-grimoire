//! An in-memory index over the card corpus, in the shape a search engine uses.
//!
//! **Why this exists rather than more SQL.** Faceting needs a count per option per
//! dimension on every filter press. Measured against the live 116 694-printing database on
//! 2026-08-11: a four-dimension pass costs 2 238 ms against `cards` as it stands, 62 ms with
//! a covering index and [`crate::legalities`]' mask, and 106–167 ms at best over a
//! rowid-aligned shadow table — because a one-character search box entry matches 100 129
//! rows and seeking those rowids is the floor. In memory the same pass is 0.31 ms, and the
//! worst case there is is 57 ms, of which 25 ms is the FTS scan nothing avoids.
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
    /// One per [`crate::legalities::LEGALITY_KEYS`] entry, same order.
    pub formats: Vec<BitSet>,
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
    /// paper, 1 047 set codes. The spec left this figure *estimated* at "467 ms for five
    /// columns, and the real read wants about fifteen"; the read as built wants **six**
    /// (`rowid`, `set_code`, `cmc`, `color_identity`, `legal_mask`, `is_paper`), which is
    /// where the estimate's headroom went. Comfortably inside the ~1.5 s at which the spec
    /// would have spent its fallback — a covering index for this read — so that stays
    /// unspent. It is a full table scan today and no existing index changes that:
    /// `idx_cards_collapse` carries every column named here **except `set_code`**, and one
    /// missing column is the whole of it.
    ///
    /// 1 047 set codes rather than the 986 the module docs quote, because those are the
    /// *paper* sets (986 exactly, re-measured on the same snapshot) and this array covers
    /// every printing — a digital-only set still needs an ordinal.
    ///
    /// **Give this its own read-only connection.** It is a full pass over `cards` and holding
    /// `AppState.db_read` for it would stall every search behind it at launch, which is the
    /// exact failure that second connection exists to prevent.
    pub fn build(conn: &Connection) -> rusqlite::Result<CardIndex> {
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
            formats: (0..crate::legalities::LEGALITY_KEYS.len())
                .map(|_| BitSet::new(capacity))
                .collect(),
            set_ord: vec![0; capacity],
            set_codes: Vec::new(),
            owned: BitSet::new(capacity),
        };

        let mut seen: std::collections::HashMap<String, u16> = std::collections::HashMap::new();
        let mut stmt = conn.prepare(
            "SELECT rowid, set_code, cmc, color_identity, legal_mask, is_paper FROM cards",
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

            let bucket = match cmc {
                None => Self::MANA_UNKNOWN,
                Some(v) if v >= 8.0 => 8,
                // A fractional un-card cost truncates, and matches no chip a reader can
                // press — the chips are integers.
                Some(v) => (v as usize).min(8),
            };
            ix.mana[bucket].set(doc);

            let mask = mask.unwrap_or(0) as u64;
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

    /// Re-read just the `owned` dimension. 10–23 ms at 200–12 000 owned printings, measured
    /// 2026-08-11 — cheap enough to run on every collection write.
    ///
    /// The join reads `cards`' primary-key index for the rowid and never the row, so the
    /// cost is one index probe per collection entry.
    pub fn rebuild_owned(&mut self, conn: &Connection) -> rusqlite::Result<()> {
        let mut owned = BitSet::new(self.capacity);
        let mut stmt = conn.prepare(
            "SELECT DISTINCT c.rowid FROM collection_entries e JOIN cards c ON c.id = e.card_id",
        )?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// `(id, name, set_code, cmc, color_identity, is_paper, legal_mask)` — the five columns
    /// [`CardIndex::build`] reads plus the two `cards` will not take a row without. Named
    /// because `clippy::type_complexity` will not take a seven-element tuple written out,
    /// and a `type` definition is the remedy the lint itself asks for.
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
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
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
        conn
    }

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
            conn.execute(
                "INSERT INTO collection_entries (card_id,set_code,collector_number,lang,finish,
                    quantity,created_at,updated_at)
                 VALUES (?1,'grn',?1,'en','nonfoil',1,unixepoch(),unixepoch())",
                rusqlite::params![id],
            )
            .unwrap();
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
    #[test]
    fn mana_buckets_separate_zero_from_unknown_and_cap_at_eight() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,is_paper,raw)
             VALUES ('5','Emrakul','roe','1','en','normal',15.0,1,'{}'),
                    ('6','Ancestral','lea','2','en','normal',0.0,1,'{}')",
            [],
        )
        .unwrap();
        let ix = CardIndex::build(&conn).unwrap();
        assert_eq!(ix.mana[0].and_count(&ix.paper), 1, "the zero-cost card");
        assert_eq!(
            ix.mana[8].and_count(&ix.paper),
            1,
            "15 lands in the open-ended bucket"
        );
        assert_eq!(
            ix.mana[9].count(),
            1,
            "the NULL cmc row, digital though it is"
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

    #[test]
    fn formats_are_indexed_by_the_frozen_key_order() {
        let ix = CardIndex::build(&seeded()).unwrap();
        let modern = crate::legalities::LEGALITY_KEYS
            .iter()
            .position(|k| *k == "modern")
            .unwrap();
        assert_eq!(ix.formats[modern].and_count(&ix.paper), 2);
    }

    /// `owned` is the one dimension that changes while the app runs, so it rebuilds on its
    /// own rather than forcing a full rebuild on every quick-add.
    #[test]
    fn owned_rebuilds_from_the_collection_without_touching_the_rest() {
        let conn = seeded();
        let mut ix = CardIndex::build(&conn).unwrap();
        assert_eq!(ix.owned.count(), 0);
        conn.execute(
            "INSERT INTO collection_entries (card_id,set_code,collector_number,lang,finish,
                quantity,created_at,updated_at)
             VALUES ('1','lea','1','en','nonfoil',0,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        ix.rebuild_owned(&conn).unwrap();
        // An **entry**, not a copy: quantity 0 still counts as owned, exactly as the
        // search's `owned` filter reads it.
        assert_eq!(ix.owned.count(), 1);
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
