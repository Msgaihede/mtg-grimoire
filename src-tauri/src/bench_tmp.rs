//! TEMPORARY measurement harness — deleted before the branch is pushed.
//!
//! Times `run_search` itself, over a copy of the live 107 337-printing corpus, so the
//! numbers describe the SQL the code actually generates rather than a hand-written
//! approximation of it.

#[cfg(test)]
mod bench {
    use crate::search::{run_search, SearchRequest};
    use crate::sorting::SortTerm;
    use rusqlite::Connection;
    use std::time::Instant;

    const DB: &str = "C:/Users/Markus/AppData/Local/Temp/claude/D--Code-mtg-grimoire/bf661795-51b4-4a38-9be4-2a6f0a2b46fd/scratchpad/bench.db";

    fn term(key: &str, dir: &str) -> SortTerm {
        SortTerm {
            key: key.to_owned(),
            dir: dir.to_owned(),
        }
    }

    fn time(conn: &Connection, label: &str, req: &SearchRequest) {
        let warm = run_search(conn, req).unwrap();
        let mut runs: Vec<u128> = Vec::new();
        for _ in 0..5 {
            let t = Instant::now();
            let _ = run_search(conn, req).unwrap();
            runs.push(t.elapsed().as_millis());
        }
        runs.sort_unstable();
        println!(
            "{label:52} {:>6} ms   rows={} total={}{}",
            runs[2],
            warm.items.len(),
            warm.total,
            if warm.total_is_capped { "+" } else { "" }
        );
    }

    #[test]
    #[ignore = "needs a local copy of the synced corpus"]
    fn measure_the_real_queries() {
        let conn = Connection::open_with_flags(
            DB,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .expect("bench.db");

        // Which plan the uncollapsed browse actually gets. CLAUDE.md records it as a full
        // table scan costing 277 ms, measured 2026-08-09 — if this says otherwise, the
        // comparison the whole design rests on has moved.
        println!("--- plan: uncollapsed default browse ---");
        let mut q = conn
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT c.id, c.name, c.price_usd FROM cards c WHERE c.is_paper = 1
                 ORDER BY c.name ASC, c.released_at DESC, c.id ASC LIMIT 50 OFFSET 0",
            )
            .unwrap();
        let rows = q
            .query_map([], |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for d in rows {
            println!("    {d}");
        }
        let v: String = conn
            .query_row("SELECT sqlite_version()", [], |r| r.get(0))
            .unwrap();
        println!("    sqlite {v}");

        // Collapsed FIRST this time, so a warm page cache cannot be what makes the
        // uncollapsed browse look fast.
        println!("\n--- collapsed first (cache-order control) ---");
        time(
            &conn,
            "collapsed default browse",
            &SearchRequest {
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        );
        time(
            &conn,
            "uncollapsed default browse",
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        );

        println!("\n--- uncollapsed (today's behaviour) ---");
        time(
            &conn,
            "default browse",
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        );
        time(
            &conn,
            "text 'dragon'",
            &SearchRequest {
                text: Some("dragon".into()),
                limit: 50,
                ..Default::default()
            },
        );

        println!("\n--- collapsed ---");
        time(
            &conn,
            "default browse",
            &SearchRequest {
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        );
        time(
            &conn,
            "page 100 (offset 4950)",
            &SearchRequest {
                collapse: Some(true),
                limit: 50,
                offset: 4950,
                ..Default::default()
            },
        );
        time(
            &conn,
            "price desc",
            &SearchRequest {
                collapse: Some(true),
                sort: Some(vec![term("price", "desc")]),
                limit: 50,
                ..Default::default()
            },
        );
        time(
            &conn,
            "rarity asc (representative sort, no filter)",
            &SearchRequest {
                collapse: Some(true),
                sort: Some(vec![term("rarity", "asc")]),
                limit: 50,
                ..Default::default()
            },
        );
        time(
            &conn,
            "text 'dragon' (ranked)",
            &SearchRequest {
                text: Some("dragon".into()),
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        );
        time(
            &conn,
            "text 'dragon' + rarity asc",
            &SearchRequest {
                text: Some("dragon".into()),
                collapse: Some(true),
                sort: Some(vec![term("rarity", "asc")]),
                limit: 50,
                ..Default::default()
            },
        );

        // What the collapse is *for*: 107 337 printings become 37 553 cards.
        let flat = run_search(
            &conn,
            &SearchRequest {
                limit: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let grouped = run_search(
            &conn,
            &SearchRequest {
                collapse: Some(true),
                limit: 1,
                ..Default::default()
            },
        )
        .unwrap();
        println!(
            "\ncapped totals: printings {}{} vs cards {}{}",
            flat.total,
            if flat.total_is_capped { "+" } else { "" },
            grouped.total,
            if grouped.total_is_capped { "+" } else { "" }
        );

        // And that the top of a ranked collapsed page is the card, not the art card.
        let bolt = run_search(
            &conn,
            &SearchRequest {
                text: Some("lightning bolt".into()),
                collapse: Some(true),
                limit: 5,
                ..Default::default()
            },
        )
        .unwrap();
        println!("\ntop 5 for 'lightning bolt', collapsed:");
        for c in &bolt.items {
            println!(
                "  {:48} [{}] x{} {:?}..{:?}",
                c.name, c.layout, c.printings, c.price_low, c.price_high
            );
        }
    }
}
