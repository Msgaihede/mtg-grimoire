//! Card search: FTS5 prefix matching plus format/colour/set/rarity filters.
//!
//! The query is assembled from fragments rather than written out once, because every
//! filter is optional and SQLite plans `col = ?` far better than `(? IS NULL OR col = ?)`.
//! Only two things are ever interpolated into the SQL string — a colour letter from a
//! fixed array and an `ORDER BY` picked from three literals — so no user text reaches
//! the parser; everything else is bound.

use crate::sync::AppState;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// What the UI asks for. `limit: 0` means "unset", which becomes the default page size.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    /// Free text. Prefix-matched against name, type line and oracle/face text.
    pub text: Option<String>,
    /// A `legalities` key (`"modern"`, `"vintage"`, …). Matches `legal` *or* `restricted`.
    pub format: Option<String>,
    /// Colour identity filter, e.g. `"WU"`. `"C"` means colourless only.
    pub colors: Option<String>,
    pub set_code: Option<String>,
    pub rarity: Option<String>,
    /// Defaults to true: digital-only printings are hidden unless asked for.
    pub paper_only: Option<bool>,
    /// `"name"` (default) | `"released"` | `"price"`.
    pub sort: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

/// One row of a result page — the columns a card grid needs, not the whole card.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSummary {
    pub id: String,
    pub name: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub rarity: Option<String>,
    pub type_line: Option<String>,
    pub mana_cost: Option<String>,
    pub price_usd: Option<f64>,
    pub layout: String,
}

/// A page of results plus the size of the whole match set, for the pager.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub items: Vec<CardSummary>,
    pub total: i64,
}

/// Page size when the caller does not choose one, and the ceiling when it does.
const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 200;

/// The five colour-identity letters, in WUBRG order. Interpolated into SQL, so it must
/// stay a hard-coded list — see [`run_search`].
const COLORS: [&str; 5] = ["W", "U", "B", "R", "G"];

/// Search `cards`, newest schema assumed. Pure over the connection so it is testable
/// without a Tauri app; [`search_cards`] is the only caller in production.
///
/// `total` comes from `count(*) OVER ()`, evaluated before `LIMIT`, so one query answers
/// both "this page" and "how many pages" — a second `COUNT(*)` would re-run every filter,
/// including the FTS match, over 116 k rows.
pub fn run_search(conn: &Connection, req: &SearchRequest) -> Result<SearchResponse, String> {
    let limit = if req.limit == 0 {
        DEFAULT_LIMIT
    } else {
        req.limit.min(MAX_LIMIT)
    };

    let mut wheres: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    // FTS5 has its own query language: `"`, `*`, `:`, `(`, `AND`/`OR`/`NOT` and `NEAR`
    // are all operators, and a stray one is a syntax *error*, not a zero-result search.
    // Reducing each word to its alphanumerics and wrapping it in quotes makes every token
    // a literal phrase; the trailing `*` is the one operator we keep, for prefix matching.
    // Tokens are ANDed by FTS5's default, so "light bol" needs both.
    if let Some(text) = filter(&req.text) {
        let toks: Vec<String> = text
            .split_whitespace()
            .map(|t| {
                t.chars()
                    .filter(|c| c.is_alphanumeric())
                    .collect::<String>()
            })
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{t}\"*"))
            .collect();
        // All-punctuation input leaves nothing to match on. Dropping the clause searches
        // everything, which is what an empty search box does anyway.
        if !toks.is_empty() {
            wheres.push("c.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)".into());
            params.push(Box::new(toks.join(" ")));
        }
    }

    // `restricted` counts as playable — a Vintage search that hid Black Lotus would be
    // wrong. Formats the card has no entry for yield NULL, which fails the IN.
    if let Some(f) = filter(&req.format) {
        wheres.push("json_extract(c.legalities, '$.' || ?) IN ('legal','restricted')".into());
        params.push(Box::new(f.to_owned()));
    }

    // Subset semantics, as in a deckbuilder: show what this identity can *cast*, so "RW"
    // returns mono-R, mono-W, RW — and colourless, which fits in any deck. Expressed as
    // exclusions ("contains no letter outside the filter") so the number of clauses stays
    // fixed and each one is a plain `instr`. The interpolated letter comes from `COLORS`;
    // `colors` itself is never spliced into the SQL.
    if let Some(colors) = filter(&req.colors) {
        let colors = colors.to_ascii_uppercase();
        if colors == "C" {
            wheres.push("(c.color_identity = '' OR c.color_identity IS NULL)".into());
        } else {
            for ch in COLORS {
                if !colors.contains(ch) {
                    wheres.push(format!("instr(coalesce(c.color_identity,''), '{ch}') = 0"));
                }
            }
        }
    }

    if let Some(s) = filter(&req.set_code) {
        wheres.push("c.set_code = ?".into());
        params.push(Box::new(s.to_owned()));
    }
    if let Some(r) = filter(&req.rarity) {
        wheres.push("c.rarity = ?".into());
        params.push(Box::new(r.to_owned()));
    }
    if req.paper_only.unwrap_or(true) {
        wheres.push("c.is_paper = 1".into());
    }

    let where_sql = if wheres.is_empty() {
        "1=1".to_owned()
    } else {
        wheres.join(" AND ")
    };
    // Matched against literals, never interpolated from `req.sort`. `released_at` and
    // `price_usd` are both nullable, so each has a tiebreaker or an explicit null rule.
    let order = match req.sort.as_deref() {
        Some("released") => "c.released_at DESC",
        Some("price") => "c.price_usd DESC NULLS LAST",
        _ => "c.name ASC, c.released_at DESC",
    };
    let sql = format!(
        "SELECT c.id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity,
                c.type_line, c.mana_cost, c.price_usd, c.layout,
                count(*) OVER () AS total
         FROM cards c WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
    );
    // Pushed last, because `?` binds by position and these are the last two in the SQL.
    params.push(Box::new(limit));
    params.push(Box::new(req.offset));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(
            params.iter().map(|p| p.as_ref()),
        ))
        .map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    // `count(*) OVER ()` rides on the returned rows, so an empty page carries no total
    // and this stays 0. Correct for "nothing matched"; for an `offset` past the end it
    // reports 0 rather than the real count — a page a pager built from `total` cannot
    // ask for, and one that degrades to an empty grid rather than a wrong number.
    let mut total = 0i64;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        total = row.get(10).map_err(|e| e.to_string())?;
        items.push(CardSummary {
            id: row.get(0).map_err(|e| e.to_string())?,
            name: row.get(1).map_err(|e| e.to_string())?,
            set_code: row.get(2).map_err(|e| e.to_string())?,
            set_name: row.get(3).map_err(|e| e.to_string())?,
            collector_number: row.get(4).map_err(|e| e.to_string())?,
            rarity: row.get(5).map_err(|e| e.to_string())?,
            type_line: row.get(6).map_err(|e| e.to_string())?,
            mana_cost: row.get(7).map_err(|e| e.to_string())?,
            price_usd: row.get(8).map_err(|e| e.to_string())?,
            layout: row.get(9).map_err(|e| e.to_string())?,
        });
    }
    Ok(SearchResponse { items, total })
}

/// A filter the user actually set: trimmed, and `None` when blank.
///
/// A UI whose "Any set"/"Any format" option carries an empty value sends `Some("")`.
/// Taken literally that would mean `set_code = ''` (matches nothing) or the json path
/// `'$.'` — which is a *SQLite error*, failing the whole search rather than one filter.
fn filter(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// Search the card database.
///
/// `async` + `spawn_blocking`, not a plain sync command: a sync command body runs inline
/// on the IPC thread, and this one waits on the database lock, which a running ingest
/// holds for tens of seconds. Blocking there would stall every other command with it.
/// The wait itself is deliberate — unlike a status poll, a search the user explicitly
/// asked for should answer late rather than answer wrong. Poisoning is recovered from:
/// a panic elsewhere leaves the `Connection` usable, and refusing to lock ever again
/// would brick search for the rest of the session.
#[tauri::command]
pub async fn search_cards(
    state: tauri::State<'_, Arc<AppState>>,
    req: SearchRequest,
) -> Result<SearchResponse, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        run_search(&conn, &req)
    })
    .await
    .map_err(|e| format!("search could not be run: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Three rows chosen to pin the tricky cases: a restricted-in-Vintage card, a
    /// two-colour card, and a digital-only one with a non-Latin name.
    #[rustfmt::skip]
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let rows = [
            ("1","Lightning Bolt","lea","161","Instant","R","R","common", 400.5, r#"{"vintage":"restricted","modern":"legal","standard":"not_legal"}"#, 1),
            ("2","Lightning Helix","rav","213","Instant","RW","RW","uncommon", 1.5, r#"{"modern":"legal"}"#, 1),
            ("3","Черная Молния","alc","1","Sorcery","B","B","rare", 0.5, r#"{"alchemy":"legal"}"#, 0),
        ];
        for (id,name,set,cn,tl,c,ci,r,usd,leg,paper) in rows {
            conn.execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,type_line,colors,color_identity,rarity,price_usd,legalities,is_paper,search_text,raw)
                VALUES (?1,?2,?3,?4,'en','normal',?5,?6,?7,?8,?9,?10,?11,?2,'{}')",
                rusqlite::params![id,name,set,cn,tl,c,ci,r,usd,leg,paper]).unwrap();
        }
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');").unwrap();
        conn
    }

    #[test]
    fn text_prefix_search_matches() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("light bol".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.items[0].name, "Lightning Bolt");
    }

    #[test]
    fn format_filter_includes_restricted() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                format: Some("vintage".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 1);
    }

    #[test]
    fn color_subset_filter() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                colors: Some("RW".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 2); // R and RW both ⊆ RW
    }

    /// The empty set is a subset of every set, so colourless cards belong in *every*
    /// colour search — a Boros deck can still run Sol Ring. `"C"` is the one filter that
    /// means "only these". Identity is `''` for a card Scryfall sends an empty array for
    /// and NULL when the key is missing; both must land on the colourless side.
    #[test]
    fn colorless_cards_match_every_color_filter_and_c_matches_only_them() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,color_identity,is_paper,raw)
             VALUES ('4','Sol Ring','lea','270','en','normal','',1,'{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
             VALUES ('5','Unknown Identity','lea','271','en','normal',1,'{}')",
            [],
        )
        .unwrap();

        let rw = run_search(
            &conn,
            &SearchRequest {
                colors: Some("RW".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rw.total, 4, "R, RW and both colourless cards fit in RW");

        let c = run_search(
            &conn,
            &SearchRequest {
                colors: Some("C".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(c.total, 2, "only the colourless cards");
    }

    /// Filters are ANDed, and every `?` must bind to the clause that pushed it: the SQL
    /// fragments and their parameters are appended in one pass, so a mis-ordered push
    /// would feed the set code to the format's json path and silently match nothing.
    #[test]
    fn filters_combine_and_parameters_bind_in_order() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("light".into()),
                format: Some("modern".into()),
                set_code: Some("rav".into()),
                rarity: Some("uncommon".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.items[0].name, "Lightning Helix");
    }

    #[test]
    fn paper_only_default_excludes_digital() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 2);
    }

    /// `total` must describe the whole match set, not the page — it is what the pager
    /// divides by. A `count(*)` placed after the `LIMIT` would report 1 here.
    #[test]
    fn total_counts_every_match_not_just_the_page() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                limit: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.total, 2);

        // And the second page is the *other* row, not the same one again.
        let p2 = run_search(
            &conn,
            &SearchRequest {
                limit: 1,
                offset: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(p2.total, 2);
        assert_ne!(p2.items[0].id, r.items[0].id);
    }

    /// `NULLS LAST` needs SQLite ≥ 3.30 — older builds reject it at *prepare* time, so
    /// this fails loudly rather than silently sorting priceless cards to the top.
    #[test]
    fn price_sort_puts_unpriced_cards_last() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
             VALUES ('4','Unpriced Card','lea','2','en','normal',1,'{}')",
            [],
        )
        .unwrap();
        let r = run_search(
            &conn,
            &SearchRequest {
                sort: Some("price".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = r.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["Lightning Bolt", "Lightning Helix", "Unpriced Card"],
            "descending by price, NULLs last"
        );
    }

    /// An "Any …" dropdown option with an empty value sends `Some("")`. Blank must mean
    /// "no filter": `set_code = ''` matches nothing, and a blank format would make the
    /// json path `'$.'`, which SQLite rejects — failing the entire search, not one filter.
    #[test]
    fn blank_filters_are_ignored_not_matched() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("  ".into()),
                format: Some("".into()),
                colors: Some("".into()),
                set_code: Some("".into()),
                rarity: Some("".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 2);
    }

    #[test]
    fn fts_special_chars_do_not_panic() {
        let conn = seeded();
        for evil in ["\"", "OR", "name:", "( ", "*"] {
            run_search(
                &conn,
                &SearchRequest {
                    text: Some(evil.into()),
                    limit: 10,
                    ..Default::default()
                },
            )
            .unwrap();
        }
    }
}
