//! One `ORDER BY` builder, shared by the search, the collection and the wishlist.
//!
//! A sort arrives from the UI as an ordered list of `{key, dir}`. Nothing in it is ever
//! interpolated: a key is looked up in the calling table's whitelist of `&'static str`
//! literals and dropped when it misses, and a direction picks one of two literals. So the
//! only thing a request can influence is *which* of a fixed set of clauses is used and in
//! what order — which is the property [`crate::search`] has always had for its four
//! hard-coded orders, kept while the number of reachable orders goes from four to dozens.

use serde::Deserialize;

/// One term of a sort, as the UI sends it.
///
/// `dir` is a string rather than an enum because a bad value must be a *default*, not a
/// deserialization failure: a list that refuses to load is a worse answer to a typo in a
/// payload than a list in ascending order.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortTerm {
    pub key: String,
    pub dir: String,
}

/// A column a table will sort on: the key the UI sends, and the SQL for each direction.
///
/// Both directions are written out rather than one clause plus an appended `DESC`, because
/// half of them are not one column — `set` is three — and every nullable column states its
/// null rule in both directions rather than inheriting SQLite's (NULLs first ascending,
/// last descending, which reads as a different sort rather than as the same one reversed).
pub struct SortColumn {
    pub key: &'static str,
    pub asc: &'static str,
    pub desc: &'static str,
}

/// Build an `ORDER BY` body — no `ORDER BY` keyword, just the list.
///
/// `fallback` is what an empty or wholly unrecognised sort means, which is the view's own
/// order rather than nothing. `tiebreak` is the table's unique key and is always appended:
/// the pagers use `OFFSET`, and two rows tying on every stated key can otherwise swap
/// places between the request for page 1 and the request for page 2 — showing the reader
/// one of them twice and the other never.
pub fn order_by(
    terms: Option<&[SortTerm]>,
    allowed: &[SortColumn],
    fallback: &str,
    tiebreak: &str,
) -> String {
    let mut parts: Vec<&'static str> = Vec::new();
    let mut used: Vec<&'static str> = Vec::new();

    for term in terms.unwrap_or(&[]) {
        let Some(column) = allowed.iter().find(|c| c.key == term.key) else {
            continue;
        };
        // A repeated key is dead SQL whose second copy reads, to a human, like the one that
        // won. First appearance is the one the reader built first.
        if used.contains(&column.key) {
            continue;
        }
        used.push(column.key);
        // Anything that is not "desc" is ascending, for the reason `SortTerm::dir` gives.
        parts.push(if term.dir == "desc" {
            column.desc
        } else {
            column.asc
        });
    }

    if parts.is_empty() {
        return format!("{fallback}, {tiebreak}");
    }
    format!("{}, {tiebreak}", parts.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    const COLUMNS: &[SortColumn] = &[
        SortColumn {
            key: "name",
            asc: "c.name ASC",
            desc: "c.name DESC",
        },
        SortColumn {
            key: "price",
            asc: "c.price_usd ASC NULLS LAST",
            desc: "c.price_usd DESC NULLS LAST",
        },
    ];

    const FALLBACK: &str = "c.name ASC";
    const TIEBREAK: &str = "c.id ASC";

    fn term(key: &str, dir: &str) -> SortTerm {
        SortTerm {
            key: key.to_owned(),
            dir: dir.to_owned(),
        }
    }

    #[test]
    fn no_terms_is_the_view_default() {
        assert_eq!(
            order_by(None, COLUMNS, FALLBACK, TIEBREAK),
            "c.name ASC, c.id ASC"
        );
        assert_eq!(
            order_by(Some(&[]), COLUMNS, FALLBACK, TIEBREAK),
            "c.name ASC, c.id ASC"
        );
    }

    #[test]
    fn terms_are_joined_in_the_order_they_arrive() {
        let terms = [term("price", "desc"), term("name", "asc")];
        assert_eq!(
            order_by(Some(&terms), COLUMNS, FALLBACK, TIEBREAK),
            "c.price_usd DESC NULLS LAST, c.name ASC, c.id ASC"
        );
    }

    /// The whole safety property in one test: a key is a lookup, never a fragment. The
    /// frontend cannot reach the parser, and a request built by hand cannot either.
    #[test]
    fn an_unknown_key_is_dropped_rather_than_interpolated() {
        let terms = [
            term("c.name; DROP TABLE cards", "asc"),
            term("released_at", "desc"),
        ];
        let sql = order_by(Some(&terms), COLUMNS, FALLBACK, TIEBREAK);
        assert_eq!(sql, "c.name ASC, c.id ASC");
        assert!(!sql.contains("DROP"));
    }

    /// Same reason: a direction is two literals, so anything else is `asc` and not a clause.
    #[test]
    fn an_unknown_direction_is_ascending() {
        let terms = [term("name", "descending; --")];
        assert_eq!(
            order_by(Some(&terms), COLUMNS, FALLBACK, TIEBREAK),
            "c.name ASC, c.id ASC"
        );
    }

    /// A UI cannot produce this, and a duplicate key in an `ORDER BY` is dead SQL whose
    /// second copy would be read by a human as the one that won.
    #[test]
    fn a_repeated_key_keeps_only_its_first_appearance() {
        let terms = [
            term("name", "asc"),
            term("price", "desc"),
            term("name", "desc"),
        ];
        assert_eq!(
            order_by(Some(&terms), COLUMNS, FALLBACK, TIEBREAK),
            "c.name ASC, c.price_usd DESC NULLS LAST, c.id ASC"
        );
    }

    /// Paging is `OFFSET`-based, so a sort that is not a total order shows one row twice
    /// and another never. The tiebreak is not the caller's to forget.
    #[test]
    fn the_tiebreak_is_always_last() {
        let terms = [term("name", "asc")];
        assert!(order_by(Some(&terms), COLUMNS, FALLBACK, TIEBREAK).ends_with("c.id ASC"));
        assert!(order_by(None, COLUMNS, FALLBACK, TIEBREAK).ends_with("c.id ASC"));
    }
}
