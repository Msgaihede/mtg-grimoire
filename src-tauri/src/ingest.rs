//! Streaming ingest of a Scryfall bulk-data file (`.jsonl.gz`) into `cards`.
//!
//! The file is ~500 MB decompressed, so nothing is ever fully materialized: the
//! gzip stream is decoded, line-buffered, and parsed one line at a time into a
//! batch of at most [`BATCH`] rows, which is then written to `cards_staging`
//! through one cached statement. Peak memory is one batch plus SQLite's page cache.
//!
//! The batch is also the unit of *locking*. This module is handed the shared
//! `Mutex<Connection>` rather than a `Connection`, and takes it once per batch, so
//! a user write during the daily sync waits one batch instead of one sync. See
//! [`ingest_gz`].
//!
//! Bad input is never fatal. Scryfall's bulk file has held truncated lines and
//! non-card objects, and one of those must not cost the user their whole card
//! database — unparseable lines are counted in [`IngestStats::skipped`] and the
//! stream continues. The one exception is a file that yields *no* cards at all:
//! that is a failed download, not an empty collection, and it must not be swapped
//! in. See [`IngestError::Empty`].

use crate::{card_row::CardRow, schema};
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

/// Rows per staging transaction, and so also rows between progress callbacks.
///
/// Two jobs, deliberately the same number: it is how long another writer can be made
/// to wait for the connection, and how often a stalled ingest becomes visible. At the
/// measured 2 600 rows/s both are well under a second.
const BATCH: u64 = 2000;

/// What an ingest did. `inserted + skipped` is the number of lines read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IngestStats {
    pub inserted: u64,
    pub skipped: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("failed to read bulk data file: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error during ingest: {0}")]
    Db(#[from] rusqlite::Error),
    /// The file decoded, but not one line was a card. A gzipped error page, the
    /// wrong bulk variant, or a truncated download all land here — none of which
    /// may be allowed to replace the user's collection with an empty table.
    #[error("no card rows found in bulk file ({skipped} lines skipped)")]
    Empty { skipped: u64 },
}

/// Stream a gzipped Scryfall JSONL file into `cards_staging`, then swap it into
/// place as `cards` and rebuild the FTS index.
///
/// `progress` is called with the running insert count every [`BATCH`] rows, and
/// once more with the final count when the swap is done.
///
/// Lines that are not valid JSON, or that are not card objects, are skipped and
/// counted — they never abort the ingest. Any other failure (I/O, database)
/// returns before the swap, so the previous `cards` table is left untouched: the
/// batches that did commit sit in `cards_staging`, which no reader can see, and
/// which both the next run ([`schema::create_staging`]) and the next launch
/// ([`schema::prepare_database`]) drop before anything else happens.
///
/// If *nothing* parsed as a card, this returns [`IngestError::Empty`] without
/// swapping: an empty result is a failed download, and swapping it in would wipe
/// a working collection.
///
/// # The connection is taken a batch at a time, not for the whole run
///
/// `db` is the shared write connection, and this takes it once per [`BATCH`] rows
/// and gives it straight back. That is not an optimisation: the ingest is the
/// app's longest write by an order of magnitude (**~80 s measured** of a 92–99 s
/// sync — it was 44 s before schema v3 gzipped `raw` on the way in), and holding
/// the mutex throughout meant a user edit during the daily sync was a frozen
/// button. Measured mid-ingest since: 10 `collection_add` calls, 4–7 ms each, no
/// `BUSY` refusals. It also bounds the WAL —
/// autocheckpoint can finally run mid-ingest, where a single 116 k-row transaction
/// grew a ~1.9 GB transient one.
///
/// **The connection must be in autocommit mode when this is called.** Each batch
/// opens a transaction of its own, and [`schema::swap_staging`] opens one via
/// `unchecked_transaction`, so calling this from inside a caller-held transaction
/// fails at `BEGIN`. Every batch is committed before the swap begins.
pub fn ingest_gz(
    db: &Mutex<Connection>,
    gz_path: &Path,
    progress: &mut dyn FnMut(u64),
) -> Result<IngestStats, IngestError> {
    use std::io::Read as _;

    // Opened before the database is touched: a missing or unreadable path must not
    // cost the caller the staging table it was about to fill.
    let mut file = std::fs::File::open(gz_path)?;
    let chunks = std::iter::from_fn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        match file.read(&mut buf) {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some(Ok(buf))
            }
            Err(e) => Some(Err(e)),
        }
    });
    ingest_stream(db, chunks, progress)
}

/// Ingest from a stream of byte chunks - gzipped or not, the decoder decides.
///
/// The platform-neutral entry point: desktop feeds it a file and the browser feeds it
/// `fetch`. Peak memory is one chunk plus one batch, exactly as the file version was.
pub fn ingest_stream(
    db: &Mutex<Connection>,
    chunks: impl Iterator<Item = std::io::Result<Vec<u8>>>,
    progress: &mut dyn FnMut(u64),
) -> Result<IngestStats, IngestError> {
    {
        let conn = crate::db::lock_blocking(db);
        schema::create_staging(&conn)?;
    }
    let mut stats = IngestStats {
        inserted: 0,
        skipped: 0,
    };
    let mut batch: Vec<CardRow> = Vec::with_capacity(BATCH as usize);
    let mut decoder = crate::feed::frame::Decoder::new();
    let mut lines = crate::feed::frame::Lines::new();
    let mut decoded: Vec<u8> = Vec::new();

    // Parsing happens with the lock *not* held - it is the expensive half of the loop,
    // and the whole point of chunking is that the connection is free during it.
    let take_line = |line: &[u8], stats: &mut IngestStats, batch: &mut Vec<CardRow>| {
        if line.is_empty() {
            return;
        }
        let Ok(text) = std::str::from_utf8(line) else {
            stats.skipped += 1;
            return;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
            stats.skipped += 1;
            return;
        };
        let Some(row) = CardRow::from_json_line(&v, text) else {
            stats.skipped += 1;
            return;
        };
        batch.push(row);
    };

    for chunk in chunks {
        let chunk = chunk?;
        decoded.clear();
        decoder.push(&chunk, &mut decoded)?;
        lines.push(&decoded, |line| take_line(line, &mut stats, &mut batch));
        flush_full_batches(db, &mut stats, &mut batch, progress)?;
    }
    // The decompressor holds a tail back until `finish` - measured at ~15 KB, roughly
    // 88 card lines, on the 2001-line fixture. So the batch boundary has to be checked
    // again HERE and not only inside the loop above: without this, a file small enough
    // to arrive in one chunk delivers its last batch's worth of lines after the loop has
    // ended, and the per-batch progress call for them never fires. That is exactly what
    // `progress_fires_every_batch_and_once_at_the_end` caught.
    decoded.clear();
    decoder.finish(&mut decoded)?;
    lines.push(&decoded, |line| take_line(line, &mut stats, &mut batch));
    lines.finish(|line| take_line(line, &mut stats, &mut batch));
    flush_full_batches(db, &mut stats, &mut batch, progress)?;

    if !batch.is_empty() {
        stats.inserted += batch.len() as u64;
        write_batch(db, &mut batch)?;
    }

    // Nothing parsed as a card: the download is bad, not the collection. Swapping here
    // would trade a working card database for an empty one, so refuse - and drop the
    // empty staging table rather than leave it lying around.
    if stats.inserted == 0 {
        let conn = crate::db::lock_blocking(db);
        conn.execute_batch("DROP TABLE IF EXISTS cards_staging")?;
        return Err(IngestError::Empty {
            skipped: stats.skipped,
        });
    }

    // The swap is the last thing and belongs to whichever entry point ran the ingest, so it
    // moves here verbatim from `ingest_gz` - both callers need it, and a stream that filled
    // staging and never swapped would leave the reader's `cards` table untouched while
    // reporting success.
    {
        let conn = crate::db::lock_blocking(db);
        schema::swap_staging(&conn)?;
    }
    progress(stats.inserted);
    Ok(stats)
}

/// Write out every whole [`BATCH`] sitting in `batch`, reporting progress after each.
///
/// Called from two places on purpose: once per chunk, and once more after the decoder's
/// `finish` releases its held-back tail. The tail is why the second call exists - a file
/// that arrives in a single chunk yields its last ~64 KB only at `finish`, and those lines
/// belong to a batch that would otherwise be written by the unconditional tail flush with
/// no progress callback of its own.
fn flush_full_batches(
    db: &Mutex<Connection>,
    stats: &mut IngestStats,
    batch: &mut Vec<CardRow>,
    progress: &mut dyn FnMut(u64),
) -> Result<(), IngestError> {
    while batch.len() as u64 >= BATCH {
        // Counted from the batch, exactly as the tail flush does, rather than from
        // `BATCH` - and taken before the write, because the write clears.
        let mut head: Vec<CardRow> = batch.drain(..BATCH as usize).collect();
        stats.inserted += head.len() as u64;
        write_batch(db, &mut head)?;
        progress(stats.inserted);
    }
    Ok(())
}

/// Commit one batch of parsed rows into `cards_staging`, then let go of the connection.
///
/// One transaction per batch rather than one for the whole load. Staging is invisible to
/// readers until the swap either way, so the transaction is not what protects anyone —
/// it is a write-batching device, and the *release* between batches is the feature.
///
/// What that costs is a crash partway leaving a *committed* `cards_staging` — invisible,
/// but real bytes. Two places drop it: [`schema::create_staging`] before the next run
/// writes anything, and [`schema::prepare_database`] at the next launch, which is the one
/// that matters because a throttled sync may not run for days.
fn write_batch(db: &Mutex<Connection>, batch: &mut Vec<CardRow>) -> Result<(), IngestError> {
    let mut conn = crate::db::lock_blocking(db);
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(STAGING_INSERT)?;
        for c in batch.iter() {
            stmt.execute(params![
                c.id,
                c.oracle_id,
                c.name,
                c.lang,
                c.released_at,
                c.set_code,
                c.set_name,
                c.collector_number,
                c.rarity,
                c.layout,
                c.mana_cost,
                c.cmc,
                c.type_line,
                c.oracle_text,
                c.colors,
                c.color_identity,
                c.legalities,
                // `as i64` because rusqlite implements `ToSql` for the unsigned types only
                // up to `u32` — SQLite's INTEGER is signed 64-bit, so a `u64` bind cannot
                // be infallible in general. It is lossless while `LEGALITY_KEYS` stays
                // under 63 entries, which `the_key_list_fits_in_a_u64` fences and 23 keys
                // is nowhere near.
                c.legal_mask as i64,
                c.games,
                c.finishes,
                c.prices,
                c.price_usd,
                c.price_eur,
                c.faces,
                c.illustration_id,
                c.frame_effects,
                c.border_color,
                c.full_art,
                c.promo,
                c.promo_types,
                c.digital,
                c.is_paper,
                c.edhrec_rank,
                c.game_changer,
                c.image_status,
                c.image_updated_at,
                c.image_uris,
                c.face_image_uris,
                c.artist,
                c.power,
                c.toughness,
                c.search_text,
                c.raw,
            ])?;
        }
    }
    tx.commit()?;
    batch.clear();
    Ok(())
}

/// The staging insert, named once. `prepare_cached` means the per-batch transaction does
/// not re-plan it 58 times over a full ingest.
const STAGING_INSERT: &str =
    "INSERT INTO cards_staging (id, oracle_id, name, lang, released_at, set_code, set_name,
        collector_number, rarity, layout, mana_cost, cmc, type_line, oracle_text, colors,
        color_identity, legalities, legal_mask, games, finishes, prices, price_usd, price_eur,
        faces, illustration_id, frame_effects, border_color, full_art, promo, promo_types,
        digital, is_paper, edhrec_rank, game_changer, image_status, image_updated_at,
        image_uris, face_image_uris, artist, power, toughness, search_text, raw)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,
        ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38,?39,?40,?41,?42,?43)";

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    /// Tests run in parallel and share the temp directory, so the file name is keyed
    /// on the content — two fixtures with the same line count must not race each
    /// other for the same path.
    ///
    /// **That is only half the race, and the other half bit `oracle_tags`' copy of this
    /// function on 2026-08-20.** Keying on content also guarantees that two fixtures with the
    /// *same* content share a path, which in a test module is the likely case rather than the
    /// unlikely one — and `File::create` truncates, so one test empties the file another is
    /// still streaming and that one dies with `Io(Kind(UnexpectedEof))`. No test here has
    /// collided yet; nothing about this helper made it safe, so it takes the same fix.
    ///
    /// Write a private file and move it into place: nothing ever opens the shared path for
    /// writing. Losing the move is fine — the name is the content's hash, so whoever won wrote
    /// the same bytes.
    fn gz_fixture(lines: &[&str]) -> std::path::PathBuf {
        use std::hash::{DefaultHasher, Hash, Hasher};
        let mut h = DefaultHasher::new();
        lines.hash(&mut h);
        let p = std::env::temp_dir().join(format!(
            "mtgtest-{}-{:016x}.jsonl.gz",
            lines.len(),
            h.finish()
        ));
        if !p.exists() {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let tmp = p.with_extension(format!("{}.tmp", NEXT.fetch_add(1, Ordering::Relaxed)));
            let mut enc = GzEncoder::new(std::fs::File::create(&tmp).unwrap(), Compression::fast());
            for l in lines {
                enc.write_all(l.as_bytes()).unwrap();
                enc.write_all(b"\n").unwrap();
            }
            enc.finish().unwrap();
            if std::fs::rename(&tmp, &p).is_err() {
                let _ = std::fs::remove_file(&tmp);
            }
        }
        p
    }

    /// A migrated in-memory database in the shape the ingest is handed now: the shared
    /// write mutex, not a bare connection.
    fn mem_db() -> Mutex<Connection> {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate_single_file(&conn).unwrap();
        Mutex::new(conn)
    }

    /// A minimal but complete card line, distinct per `i`.
    fn card_line(i: u64) -> String {
        format!(
            r#"{{"object":"card","id":"c{i}","name":"Card {i}","lang":"en","layout":"normal","set":"x","collector_number":"{i}","games":["paper"],"finishes":["nonfoil"],"digital":false}}"#
        )
    }

    #[test]
    fn ingests_fixture_and_swaps() {
        let db = mem_db();
        crate::db::lock_blocking(&db).execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,raw) VALUES ('stale','Stale','x','1','en','normal','{}')", []).unwrap();
        let sample = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/cards_sample.jsonl"
        ))
        .unwrap();
        let lines: Vec<&str> = sample.lines().collect();
        let p = gz_fixture(&lines);
        let mut ticks = 0u32;
        let stats = ingest_gz(&db, &p, &mut |_| ticks += 1).unwrap();
        assert_eq!(stats.inserted as usize, lines.len());
        let conn = crate::db::lock_blocking(&db);
        let stale: i64 = conn
            .query_row("SELECT count(*) FROM cards WHERE id='stale'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(stale, 0); // replaced by swap
        let bolt: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(bolt >= 1);

        // The Game Changers flag, end to end on a real printing: Rhystic Study (cm1 15)
        // publishes `"game_changer": true` and the fixture carries the line verbatim. The
        // whole Commander bracket estimate hangs on this one boolean and nothing else in
        // this app can recompute it — the Commander Format Panel maintains the list and a
        // sync is the only thing that delivers it — so the bulk line reaching the column is
        // the only place the claim can be proven. Asserted beside a `false` and a missing
        // key, because a column that answered `1` unconditionally would pass on its own.
        let flags: Vec<(String, Option<i64>)> = [
            "Rhystic Study",
            "Ragnarok, Divine Deliverance",
            "Lightning Bolt",
        ]
        .iter()
        .map(|name| {
            let flag = conn
                .query_row(
                    "SELECT game_changer FROM cards WHERE name = ?1",
                    [name],
                    |r| r.get(0),
                )
                .unwrap();
            ((*name).to_string(), flag)
        })
        .collect();
        assert_eq!(
            flags,
            [
                ("Rhystic Study".to_string(), Some(1)),
                // Prints the field as `false`.
                ("Ragnarok, Divine Deliverance".to_string(), Some(0)),
                // Omits the field entirely, which is what almost every card does.
                ("Lightning Bolt".to_string(), Some(0)),
            ]
        );

        assert_eq!(ticks, 1, "the final progress call always fires");
    }

    /// The 43-parameter INSERT is positional, and SQLite columns are dynamically typed:
    /// two transposed parameters would still insert without complaint and only show
    /// up much later as wrong data. So read a fully-populated row back and check
    /// every column against the value its name promises. Every text value is distinct
    /// — including `oracle_text` vs the `search_text` derived from it — so no swap
    /// among them can hide. The two image columns are checked just below the table
    /// rather than in it: their key order is serde_json's, not something this crate
    /// promises, so they are compared by content.
    #[test]
    fn every_column_receives_the_field_it_is_named_for() {
        // `prices`, `legalities` and `card_faces` are stored as verbatim JSON; their keys
        // are written alphabetically here so the expectation holds whether serde_json
        // sorts keys or preserves input order. The lone `card_faces` entry is what pushes
        // `search_text` ("ORACLE FACENAME") apart from `oracle_text` ("ORACLE"), and it
        // carries images of its own so `face_image_uris` is populated too.
        let line = r#"{"object":"card","id":"ID1","oracle_id":"OID","name":"NAME","lang":"LANG","released_at":"2020-01-02","set":"SET","set_name":"SETNAME","collector_number":"CN","rarity":"rare","layout":"normal","mana_cost":"{R}","cmc":3.0,"type_line":"TYPE","oracle_text":"ORACLE","colors":["R"],"color_identity":["R","G"],"legalities":{"modern":"legal"},"games":["paper"],"finishes":["foil"],"prices":{"eur":"2.5","usd":"1.25"},"card_faces":[{"image_uris":{"grid":"FACEGRID"},"name":"FACENAME"}],"illustration_id":"ILL","frame_effects":["showcase"],"border_color":"black","full_art":true,"promo":false,"promo_types":["prerelease"],"digital":false,"edhrec_rank":42,"game_changer":true,"image_status":"lowres","image_updated_at":"2021-02-03T00:00:00Z","image_uris":{"grid":"TOPGRID"},"artist":"ARTIST","power":"POW","toughness":"TUF"}"#;
        // Five boolean columns cannot be told apart by one row — with two values to
        // go round, some pair always matches. These two extra rows give each boolean a
        // distinct pattern across the three: full_art 100, promo 011, digital 010,
        // game_changer 110, is_paper 101.
        let bools_2 = r#"{"object":"card","id":"ID2","name":"N2","lang":"en","layout":"normal","set":"x","collector_number":"2","games":["arena"],"finishes":["nonfoil"],"full_art":false,"promo":true,"digital":true,"game_changer":true}"#;
        let bools_3 = r#"{"object":"card","id":"ID3","name":"N3","lang":"en","layout":"normal","set":"x","collector_number":"3","games":["paper"],"finishes":["nonfoil"],"full_art":false,"promo":true,"digital":false,"game_changer":false}"#;

        let db = mem_db();
        ingest_gz(&db, &gz_fixture(&[line, bools_2, bools_3]), &mut |_| {}).unwrap();
        let conn = crate::db::lock_blocking(&db);

        let expected: [(&str, Option<&str>); 40] = [
            ("id", Some("ID1")),
            ("oracle_id", Some("OID")),
            ("name", Some("NAME")),
            ("lang", Some("LANG")),
            ("released_at", Some("2020-01-02")),
            ("set_code", Some("SET")),
            ("set_name", Some("SETNAME")),
            ("collector_number", Some("CN")),
            ("rarity", Some("rare")),
            ("layout", Some("normal")),
            ("mana_cost", Some("{R}")),
            ("cmc", Some("3.0")),
            ("type_line", Some("TYPE")),
            ("oracle_text", Some("ORACLE")),
            ("colors", Some("R")),
            ("color_identity", Some("RG")),
            ("legalities", Some(r#"{"modern":"legal"}"#)),
            // Next to the column it is derived from, which is where a one-place slip is
            // easiest to make and hardest to see — SQLite would take an integer in `games`
            // and a JSON array in `legal_mask` without a word. `modern` is bit 9.
            ("legal_mask", Some("512")),
            ("games", Some(r#"["paper"]"#)),
            ("finishes", Some(r#"["foil"]"#)),
            ("prices", Some(r#"{"eur":"2.5","usd":"1.25"}"#)),
            ("price_usd", Some("1.25")),
            ("price_eur", Some("2.5")),
            (
                "faces",
                Some(r#"[{"image_uris":{"grid":"FACEGRID"},"name":"FACENAME"}]"#),
            ),
            ("illustration_id", Some("ILL")),
            ("frame_effects", Some(r#"["showcase"]"#)),
            ("border_color", Some("black")),
            ("full_art", Some("1")),
            ("promo", Some("0")),
            ("promo_types", Some(r#"["prerelease"]"#)),
            ("digital", Some("0")),
            ("is_paper", Some("1")),
            ("edhrec_rank", Some("42")),
            ("game_changer", Some("1")),
            ("image_status", Some("lowres")),
            ("image_updated_at", Some("2021-02-03T00:00:00Z")),
            ("artist", Some("ARTIST")),
            // Two adjacent TEXT columns holding values of the same shape: distinct
            // sentinels, because transposing them is exactly the mistake a positional
            // INSERT invites and a 2/1 read back as 1/2 is unfalsifiable in real data.
            ("power", Some("POW")),
            ("toughness", Some("TUF")),
            ("search_text", Some("ORACLE FACENAME")),
        ];

        // CAST so REAL and INTEGER columns come back as text too — this compares the
        // whole row in one shot rather than a hand-picked sample of it.
        let select = expected
            .iter()
            .map(|(c, _)| format!("CAST({c} AS TEXT)"))
            .collect::<Vec<_>>()
            .join(",");
        let got: Vec<Option<String>> = conn
            .query_row(
                &format!("SELECT {select} FROM cards WHERE id='ID1'"),
                [],
                |r| (0..expected.len()).map(|i| r.get(i)).collect(),
            )
            .unwrap();

        for (i, (col, want)) in expected.iter().enumerate() {
            assert_eq!(got[i].as_deref(), *want, "column `{col}`");
        }

        // The last two parameters, in the same positional check: distinct values top
        // level vs face, so transposing them cannot hide.
        let (top, face): (String, String) = conn
            .query_row(
                "SELECT json_extract(image_uris, '$.grid'),
                        json_extract(face_image_uris, '$[0].grid')
                 FROM cards WHERE id='ID1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((top.as_str(), face.as_str()), ("TOPGRID", "FACEGRID"));

        // `raw` is a gzip BLOB from v3, so it cannot be compared as a text column with the
        // rest. Decompressed it is still the verbatim line, which is the whole promise.
        let stored: Vec<u8> = conn
            .query_row(
                "SELECT CAST(raw AS BLOB) FROM cards WHERE id='ID1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(crate::card_row::raw_json(&stored).as_deref(), Some(line));

        // (full_art, promo, digital, game_changer, is_paper) per row — read down the
        // columns and every boolean has its own signature, so a transposed pair fails.
        for (id, want) in [
            ("ID1", [1, 0, 0, 1, 1]),
            ("ID2", [0, 1, 1, 1, 0]),
            ("ID3", [0, 1, 0, 0, 1]),
        ] {
            let got: Vec<i64> = conn
                .query_row(
                    "SELECT full_art, promo, digital, game_changer, is_paper
                     FROM cards WHERE id = ?1",
                    [id],
                    |r| (0..5).map(|i| r.get(i)).collect(),
                )
                .unwrap();
            assert_eq!(got, want, "boolean columns of {id}");
        }
    }

    /// The ingest and the v2 backfill must produce the same columns, or a card's art
    /// would change shape depending on whether its row survived a sync. (The extraction
    /// itself is held to that by `schema::tests::the_backfill_and_the_ingest_agree_on_
    /// every_image_shape`; this is the wiring — that the two values reach the two
    /// columns they are named for.)
    #[test]
    fn ingested_rows_carry_their_image_columns() {
        let db = mem_db();
        let p = gz_fixture(&[
            r#"{"object":"card","id":"a","name":"Bolt","lang":"en","layout":"normal","set":"x","collector_number":"1","games":["paper"],"finishes":["nonfoil"],"digital":false,"image_uris":{"thumb":"t.webp","grid":"g.webp","display":"d.webp","art":"a.webp","normal":"n.jpg"}}"#,
            r#"{"object":"card","id":"b","name":"Delver","lang":"en","layout":"transform","set":"x","collector_number":"2","games":["paper"],"finishes":["nonfoil"],"digital":false,"card_faces":[{"name":"Front","image_uris":{"grid":"f0.webp"}},{"name":"Back","image_uris":{"grid":"f1.webp"}}]}"#,
        ]);

        ingest_gz(&db, &p, &mut |_| {}).unwrap();

        let conn = crate::db::lock_blocking(&db);
        let grid: String = conn
            .query_row(
                "SELECT json_extract(image_uris, '$.grid') FROM cards WHERE id='a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(grid, "g.webp");
        let back: String = conn
            .query_row(
                "SELECT json_extract(face_image_uris, '$[1].grid') FROM cards WHERE id='b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(back, "f1.webp");

        // The two columns are disjoint populations and the swap that put them here does
        // not blur them: a `normal` card has no face array, a `transform` no top-level
        // image object. Transposing the two parameters above would land `a`'s object in
        // the face column and `b`'s array in the top-level one, so these NULLs are what
        // says the pair is the right way round.
        let (face_of_a, top_of_b): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT (SELECT face_image_uris FROM cards WHERE id='a'),
                        (SELECT image_uris FROM cards WHERE id='b')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((face_of_a, top_of_b), (None, None));
    }

    /// A gzipped error page, the wrong bulk variant, a file of nothing but tokens —
    /// each decodes fine and yields zero cards. Swapping that in would trade the
    /// user's whole collection for an empty table, so it must be refused outright.
    #[test]
    fn an_all_skipped_file_refuses_to_swap() {
        let db = mem_db();
        crate::db::lock_blocking(&db).execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,raw) VALUES ('keep','Keep','x','1','en','normal','{}')", []).unwrap();

        let p = gz_fixture(&["<html>Service Unavailable</html>", r#"{"object":"token"}"#]);
        let err = ingest_gz(&db, &p, &mut |_| {}).unwrap_err();
        assert!(
            matches!(err, IngestError::Empty { skipped: 2 }),
            "expected Empty {{ skipped: 2 }}, got {err:?}"
        );

        {
            let conn = crate::db::lock_blocking(&db);
            let kept: i64 = conn
                .query_row("SELECT count(*) FROM cards WHERE id='keep'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(kept, 1, "an empty ingest must not touch the live table");
            let fts: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name='cards_fts'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(fts, 1, "the search index must survive an empty ingest");
            let staging: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name='cards_staging'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                staging, 0,
                "the empty staging table is dropped, not left behind"
            );
        }

        // The refusal costs the connection nothing: a real ingest still swaps.
        let stats = ingest_gz(&db, &gz_fixture(&[&card_line(1)]), &mut |_| {}).unwrap();
        assert_eq!(stats.inserted, 1);
    }

    /// The input is opened before the database is touched, so a bad path cannot
    /// destroy a staging table that a caller is mid-way through using.
    #[test]
    fn a_missing_file_fails_before_touching_staging() {
        let db = mem_db();
        {
            let conn = crate::db::lock_blocking(&db);
            crate::schema::create_staging(&conn).unwrap();
            conn.execute("INSERT INTO cards_staging (id,name,set_code,collector_number,lang,layout,raw) VALUES ('half','Half','x','1','en','normal','{}')", []).unwrap();
        }

        let missing = std::env::temp_dir().join("mtgtest-does-not-exist.jsonl.gz");
        let _ = std::fs::remove_file(&missing);
        let err = ingest_gz(&db, &missing, &mut |_| {}).unwrap_err();
        assert!(
            matches!(err, IngestError::Io(_)),
            "expected io error, got {err:?}"
        );

        let conn = crate::db::lock_blocking(&db);
        let staged: i64 = conn
            .query_row("SELECT count(*) FROM cards_staging", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            staged, 1,
            "staging must be untouched when the file never opened"
        );
    }

    /// The 10-line fixture never reaches a batch boundary, so the callback contract —
    /// one call per BATCH rows plus a final call after the swap — needs a bigger input.
    #[test]
    fn progress_fires_every_batch_and_once_at_the_end() {
        let db = mem_db();
        let rows: Vec<String> = (0..BATCH + 1).map(card_line).collect();
        let lines: Vec<&str> = rows.iter().map(String::as_str).collect();
        let p = gz_fixture(&lines);

        let mut seen: Vec<u64> = Vec::new();
        let stats = ingest_gz(&db, &p, &mut |n| seen.push(n)).unwrap();

        assert_eq!(stats.inserted, BATCH + 1);
        assert_eq!(seen, vec![BATCH, BATCH + 1]);
    }

    /// A read failure partway through the stream must cost the user nothing: `cards` is
    /// untouched, the swap never runs, and the connection is left clean enough to retry
    /// on the spot.
    ///
    /// What it must *not* cost is a rollback of the whole load. Chunking commits each
    /// batch, so the rows read before the failure survive in `cards_staging` — which is
    /// harmless in a way worth stating: staging is invisible to every reader until the
    /// swap, and the next run's `create_staging` drops it before it writes a row.
    #[test]
    fn io_failure_mid_stream_leaves_cards_intact_and_connection_usable() {
        let db = mem_db();
        crate::db::lock_blocking(&db).execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,raw) VALUES ('stale','Stale','x','1','en','normal','{}')", []).unwrap();

        // Enough lines that the cut lands well past the first batch: the assertions
        // below are only meaningful if rows were already committed when the read failed.
        let rows: Vec<String> = (0..3000).map(card_line).collect();
        let lines: Vec<&str> = rows.iter().map(String::as_str).collect();
        let good = gz_fixture(&lines);
        let truncated = std::env::temp_dir().join("mtgtest-truncated.jsonl.gz");
        let bytes = std::fs::read(&good).unwrap();
        std::fs::write(&truncated, &bytes[..bytes.len() * 9 / 10]).unwrap();

        let mut seen: Vec<u64> = Vec::new();
        let err = ingest_gz(&db, &truncated, &mut |n| seen.push(n)).unwrap_err();
        assert!(
            matches!(err, IngestError::Io(_)),
            "expected io error, got {err:?}"
        );
        assert_eq!(
            seen,
            vec![BATCH],
            "the read must fail mid-stream, after rows were inserted, \
             and the final progress call must not fire on failure"
        );

        {
            let conn = crate::db::lock_blocking(&db);
            let stale: i64 = conn
                .query_row("SELECT count(*) FROM cards WHERE id='stale'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(stale, 1, "a failed ingest must not touch the live table");
            let cards: i64 = conn
                .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                cards, 1,
                "not one staged row may be visible in `cards` — the swap is the only \
                 thing that makes a load visible, however many transactions filled it"
            );
            let staged: i64 = conn
                .query_row("SELECT count(*) FROM cards_staging", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                staged, BATCH as i64,
                "the batches that committed before the read failed are still in staging — \
                 which costs nothing, because staging is invisible until the swap and the \
                 next run drops it before it writes a row"
            );
        }

        // No transaction left open on the connection, and the leftover staging rows are
        // dropped rather than added to: a retry must just work, and land exactly the
        // rows the file holds.
        let stats = ingest_gz(&db, &good, &mut |_| {}).unwrap();
        assert_eq!(stats.inserted, rows.len() as u64);
        let cards: i64 = crate::db::lock_blocking(&db)
            .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            cards,
            rows.len() as i64,
            "the retry must not inherit the failed run's staged rows"
        );
    }

    /// The whole point of chunking. Plan 3 writes user rows from commands, and the ingest
    /// used to hold `AppState.db` for its entire ~44 s run — so an "Add to collection"
    /// during the daily sync was a frozen button. Now the load commits every `BATCH` rows
    /// and drops the guard between batches, so the longest anyone waits is one batch.
    ///
    /// The probe runs on another thread, as a command would, and asks with a bound. What
    /// makes the count mean something is *when* a take is allowed to count: only between
    /// the first progress callback (the first batch has committed, so the ingest is
    /// demonstrably mid-run and using the connection) and the ingest returning. A take won
    /// before the ingest got going, or in the instant after it finished, is discarded.
    ///
    /// Without that window the assertion is decoration: an ingest that held the connection
    /// from end to end would simply make the probe wait, and it would then collect three
    /// locks from an idle mutex and pass. With it, the same regression scores zero.
    #[test]
    fn a_writer_gets_the_connection_between_batches_of_an_ingest() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

        let dir = std::env::temp_dir().join("mtgtest-ingest-chunked");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("mtg.db")).unwrap();
        crate::schema::migrate_single_file(&conn).unwrap();
        let db = std::sync::Mutex::new(conn);

        // Eight batches' worth. Only the seven release points *after* the first batch
        // count, so the run has to have plenty of them left once counting opens.
        let rows: Vec<String> = (0..BATCH * 8).map(card_line).collect();
        let lines: Vec<&str> = rows.iter().map(String::as_str).collect();
        let p = gz_fixture(&lines);

        let taken = AtomicUsize::new(0);
        let ingesting = AtomicBool::new(false);
        let done = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                // Runs for the length of the ingest, asking the way a command asks.
                while taken.load(Ordering::SeqCst) < 3 && !done.load(Ordering::SeqCst) {
                    let won =
                        crate::db::lock_for(&db, std::time::Duration::from_millis(200)).is_some();
                    if won && ingesting.load(Ordering::SeqCst) && !done.load(Ordering::SeqCst) {
                        taken.fetch_add(1, Ordering::SeqCst);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            });
            // The first progress call is the first committed batch: from here the ingest
            // is unambiguously running, and every lock it gives up is one it chose to.
            let stats = ingest_gz(&db, &p, &mut |_| ingesting.store(true, Ordering::SeqCst));
            // Set before any assertion: a panic here must still release the probe, or
            // the scope would join a thread that never leaves its loop.
            done.store(true, Ordering::SeqCst);
            assert_eq!(stats.unwrap().inserted, BATCH * 8);
        });

        assert!(
            taken.load(Ordering::SeqCst) >= 3,
            "a writer must be able to take the connection while the ingest is running, \
             and took it {} times",
            taken.load(Ordering::SeqCst)
        );
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_lines_are_skipped_not_fatal() {
        let db = mem_db();
        let p = gz_fixture(&[
            r#"{"object":"card","id":"a","name":"Good","lang":"en","layout":"normal","set":"x","collector_number":"1","games":["paper"],"finishes":["nonfoil"],"digital":false}"#,
            "NOT JSON",
            r#"{"object":"token"}"#,
        ]);
        let stats = ingest_gz(&db, &p, &mut |_| {}).unwrap();
        assert_eq!(stats.inserted, 1);
        assert_eq!(stats.skipped, 2);
    }

    /// The new entry point must produce exactly what the file-shaped one does.
    #[test]
    fn ingest_stream_matches_ingest_gz_row_for_row() {
        let lines: Vec<String> = (0..50).map(card_line).collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let path = gz_fixture(&refs);
        let bytes = std::fs::read(&path).unwrap();

        let db_a = mem_db();
        let a = ingest_gz(&db_a, &path, &mut |_| {}).unwrap();

        let db_b = mem_db();
        let chunks = bytes.chunks(64).map(|c| Ok(c.to_vec())).collect::<Vec<_>>();
        let b = ingest_stream(&db_b, chunks.into_iter(), &mut |_| {}).unwrap();

        assert_eq!(a.inserted, b.inserted);
        assert_eq!(a.skipped, b.skipped);
        assert_eq!(b.inserted, 50);
    }

    /// The browser case: fetch already decompressed the body, so the same content arrives
    /// plain. It must ingest identically.
    #[test]
    fn ingest_stream_accepts_already_decompressed_bytes() {
        let lines: Vec<String> = (0..30).map(card_line).collect();
        let mut plain = Vec::new();
        for l in &lines {
            plain.extend_from_slice(l.as_bytes());
            plain.push(b'\n');
        }
        let db = mem_db();
        let chunks = plain.chunks(31).map(|c| Ok(c.to_vec())).collect::<Vec<_>>();
        let stats = ingest_stream(&db, chunks.into_iter(), &mut |_| {}).unwrap();
        assert_eq!(stats.inserted, 30);
    }
}
