//! Streaming ingest of a Scryfall bulk-data file (`.jsonl.gz`) into `cards`.
//!
//! The file is ~500 MB decompressed, so nothing is ever fully materialized: the
//! gzip stream is decoded, line-buffered, and parsed one line at a time, and each
//! row goes straight into `cards_staging` through a single prepared statement.
//! Peak memory is one line plus SQLite's page cache.
//!
//! Bad input is never fatal. Scryfall's bulk file has held truncated lines and
//! non-card objects, and one of those must not cost the user their whole card
//! database — unparseable lines are counted in [`IngestStats::skipped`] and the
//! stream continues.

use crate::{card_row::CardRow, schema};
use flate2::read::GzDecoder;
use rusqlite::{params, Connection};
use std::io::{BufRead, BufReader};
use std::path::Path;

/// Rows between progress callbacks. Small enough that a stalled ingest is visible
/// within a second or so, large enough that the callback is not the bottleneck.
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
/// staging transaction rolls back on drop and `cards_staging` is dropped and
/// recreated by the next run.
///
/// **`conn` must be in autocommit mode.** [`schema::create_staging`] and
/// [`schema::swap_staging`] open their own transactions internally, so calling
/// this from inside a caller-held transaction fails at `BEGIN`. The staging load
/// runs in a transaction owned by this function, which is committed before the
/// swap begins.
pub fn ingest_gz(
    conn: &mut Connection,
    gz_path: &Path,
    progress: &mut dyn FnMut(u64),
) -> Result<IngestStats, IngestError> {
    schema::create_staging(conn)?;
    let reader = BufReader::new(GzDecoder::new(std::fs::File::open(gz_path)?));
    let mut stats = IngestStats {
        inserted: 0,
        skipped: 0,
    };

    // One transaction for the whole staging load: staging is invisible to readers
    // until the swap, so there is nothing to gain from intermediate commits and a
    // failure partway through rolls the partial load away for free.
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO cards_staging (id, oracle_id, name, lang, released_at, set_code, set_name,
                collector_number, rarity, layout, mana_cost, cmc, type_line, oracle_text, colors,
                color_identity, legalities, games, finishes, prices, price_usd, price_eur, faces,
                illustration_id, frame_effects, border_color, full_art, promo, promo_types, digital,
                is_paper, edhrec_rank, game_changer, image_status, image_updated_at, search_text, raw)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,
                ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37)",
        )?;
        for line in reader.lines() {
            let line = line?;
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                stats.skipped += 1;
                continue;
            };
            let Some(c) = CardRow::from_json(&v) else {
                stats.skipped += 1;
                continue;
            };
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
                c.search_text,
                // The original line, stored verbatim: every field this schema does not
                // model yet stays recoverable without a re-download.
                line,
            ])?;
            stats.inserted += 1;
            if stats.inserted.is_multiple_of(BATCH) {
                progress(stats.inserted);
            }
        }
    }
    tx.commit()?;
    schema::swap_staging(conn)?;
    progress(stats.inserted);
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    fn gz_fixture(lines: &[&str]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("mtgtest-{}.jsonl.gz", lines.len()));
        let mut enc = GzEncoder::new(std::fs::File::create(&p).unwrap(), Compression::fast());
        for l in lines {
            enc.write_all(l.as_bytes()).unwrap();
            enc.write_all(b"\n").unwrap();
        }
        enc.finish().unwrap();
        p
    }

    /// A minimal but complete card line, distinct per `i`.
    fn card_line(i: u64) -> String {
        format!(
            r#"{{"object":"card","id":"c{i}","name":"Card {i}","lang":"en","layout":"normal","set":"x","collector_number":"{i}","games":["paper"],"finishes":["nonfoil"],"digital":false}}"#
        )
    }

    #[test]
    fn ingests_fixture_and_swaps() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,raw) VALUES ('stale','Stale','x','1','en','normal','{}')", []).unwrap();
        let sample = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/cards_sample.jsonl"
        ))
        .unwrap();
        let lines: Vec<&str> = sample.lines().collect();
        let p = gz_fixture(&lines);
        let mut ticks = 0u32;
        let stats = ingest_gz(&mut conn, &p, &mut |_| ticks += 1).unwrap();
        assert_eq!(stats.inserted as usize, lines.len());
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
        assert_eq!(ticks, 1, "the final progress call always fires");
    }

    /// The 37-column INSERT is positional, and SQLite columns are dynamically typed:
    /// two transposed parameters would still insert without complaint and only show
    /// up much later as wrong data. So read a fully-populated row back and check
    /// every column against the value its name promises.
    #[test]
    fn every_column_receives_the_field_it_is_named_for() {
        // `prices` and `legalities` are stored as verbatim JSON; their keys are written
        // alphabetically here so the expectation holds whether serde_json sorts keys or
        // preserves input order.
        let line = r#"{"object":"card","id":"ID1","oracle_id":"OID","name":"NAME","lang":"LANG","released_at":"2020-01-02","set":"SET","set_name":"SETNAME","collector_number":"CN","rarity":"rare","layout":"normal","mana_cost":"{R}","cmc":3.0,"type_line":"TYPE","oracle_text":"TEXT","colors":["R"],"color_identity":["R","G"],"legalities":{"modern":"legal"},"games":["paper"],"finishes":["foil"],"prices":{"eur":"2.5","usd":"1.25"},"illustration_id":"ILL","frame_effects":["showcase"],"border_color":"black","full_art":true,"promo":true,"promo_types":["prerelease"],"digital":false,"edhrec_rank":42,"game_changer":true,"image_status":"lowres","image_updated_at":"2021-02-03T00:00:00Z"}"#;
        let mut conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        ingest_gz(&mut conn, &gz_fixture(&[line]), &mut |_| {}).unwrap();

        let expected: [(&str, Option<&str>); 37] = [
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
            ("oracle_text", Some("TEXT")),
            ("colors", Some("R")),
            ("color_identity", Some("RG")),
            ("legalities", Some(r#"{"modern":"legal"}"#)),
            ("games", Some(r#"["paper"]"#)),
            ("finishes", Some(r#"["foil"]"#)),
            ("prices", Some(r#"{"eur":"2.5","usd":"1.25"}"#)),
            ("price_usd", Some("1.25")),
            ("price_eur", Some("2.5")),
            ("faces", None), // no card_faces on this printing
            ("illustration_id", Some("ILL")),
            ("frame_effects", Some(r#"["showcase"]"#)),
            ("border_color", Some("black")),
            ("full_art", Some("1")),
            ("promo", Some("1")),
            ("promo_types", Some(r#"["prerelease"]"#)),
            ("digital", Some("0")),
            ("is_paper", Some("1")),
            ("edhrec_rank", Some("42")),
            ("game_changer", Some("1")),
            ("image_status", Some("lowres")),
            ("image_updated_at", Some("2021-02-03T00:00:00Z")),
            ("search_text", Some("TEXT")),
            ("raw", Some(line)),
        ];

        // CAST so REAL and INTEGER columns come back as text too — this compares the
        // whole row in one shot rather than a hand-picked sample of it.
        let select = expected
            .iter()
            .map(|(c, _)| format!("CAST({c} AS TEXT)"))
            .collect::<Vec<_>>()
            .join(",");
        let got: Vec<Option<String>> = conn
            .query_row(&format!("SELECT {select} FROM cards"), [], |r| {
                (0..expected.len()).map(|i| r.get(i)).collect()
            })
            .unwrap();

        for (i, (col, want)) in expected.iter().enumerate() {
            assert_eq!(got[i].as_deref(), *want, "column `{col}`");
        }
    }

    /// The 10-line fixture never reaches a batch boundary, so the callback contract —
    /// one call per BATCH rows plus a final call after the swap — needs a bigger input.
    #[test]
    fn progress_fires_every_batch_and_once_at_the_end() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let rows: Vec<String> = (0..BATCH + 1).map(card_line).collect();
        let lines: Vec<&str> = rows.iter().map(String::as_str).collect();
        let p = gz_fixture(&lines);

        let mut seen: Vec<u64> = Vec::new();
        let stats = ingest_gz(&mut conn, &p, &mut |n| seen.push(n)).unwrap();

        assert_eq!(stats.inserted, BATCH + 1);
        assert_eq!(seen, vec![BATCH, BATCH + 1]);
    }

    /// A read failure partway through the stream must cost the user nothing: the
    /// staging load rolls back, the swap never runs, and the connection is left
    /// clean enough to retry on the spot.
    #[test]
    fn io_failure_mid_stream_leaves_cards_intact_and_connection_usable() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,raw) VALUES ('stale','Stale','x','1','en','normal','{}')", []).unwrap();

        // Enough lines that the cut lands well past the first batch: the rollback
        // below is only meaningful if rows were already inserted when the read failed.
        let rows: Vec<String> = (0..3000).map(card_line).collect();
        let lines: Vec<&str> = rows.iter().map(String::as_str).collect();
        let good = gz_fixture(&lines);
        let truncated = std::env::temp_dir().join("mtgtest-truncated.jsonl.gz");
        let bytes = std::fs::read(&good).unwrap();
        std::fs::write(&truncated, &bytes[..bytes.len() * 9 / 10]).unwrap();

        let mut seen: Vec<u64> = Vec::new();
        let err = ingest_gz(&mut conn, &truncated, &mut |n| seen.push(n)).unwrap_err();
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

        let stale: i64 = conn
            .query_row("SELECT count(*) FROM cards WHERE id='stale'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(stale, 1, "a failed ingest must not touch the live table");
        let staged: i64 = conn
            .query_row("SELECT count(*) FROM cards_staging", [], |r| r.get(0))
            .unwrap();
        assert_eq!(staged, 0, "the staging load must roll back");

        // No transaction left open on the connection: a retry must just work.
        let stats = ingest_gz(&mut conn, &good, &mut |_| {}).unwrap();
        assert_eq!(stats.inserted, rows.len() as u64);
    }

    #[test]
    fn bad_lines_are_skipped_not_fatal() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let p = gz_fixture(&[
            r#"{"object":"card","id":"a","name":"Good","lang":"en","layout":"normal","set":"x","collector_number":"1","games":["paper"],"finishes":["nonfoil"],"digital":false}"#,
            "NOT JSON",
            r#"{"object":"token"}"#,
        ]);
        let stats = ingest_gz(&mut conn, &p, &mut |_| {}).unwrap();
        assert_eq!(stats.inserted, 1);
        assert_eq!(stats.skipped, 2);
    }
}
