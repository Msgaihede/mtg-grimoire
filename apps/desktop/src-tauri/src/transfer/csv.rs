//! CSV, RFC 4180 — the writer half only.
//!
//! A port of the writer in `packages/ui/features/transfer/csv.ts`, unchanged in behaviour, and of
//! `escapeFormula` in `packages/ui/features/transfer/formula.ts` beside it. `parseCsv` deliberately did
//! **not** come with them: nothing on this side ever reads a mirror file back, so a reader here
//! would exist only to be tested.

/// A field, quoted only when it has to be. An inner quote doubles — RFC 4180's escape.
///
/// The "never otherwise" half is the point rather than an optimisation: quoting unconditionally is
/// also valid RFC 4180, and it would write every `Lightning Bolt` in the mirror as
/// `"Lightning Bolt"` — noise on every row of a tree somebody reads with `git diff`.
pub fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        let mut out = String::with_capacity(value.len() + 2);
        out.push('"');
        for ch in value.chars() {
            if ch == '"' {
                out.push('"');
            }
            out.push(ch);
        }
        out.push('"');
        return out;
    }
    value.to_string()
}

/// The characters a spreadsheet reads as the start of a formula — `formula.ts`'s set exactly.
/// Tab and carriage return are on it because some spreadsheets read either as one.
const FORMULA_TRIGGERS: [char; 6] = ['=', '+', '-', '@', '\t', '\r'];

/// A cell as the CSV writer should emit it: one apostrophe in front of anything a spreadsheet
/// would evaluate (issue #555).
///
/// **A port of `escapeFormula` in `packages/ui/features/transfer/formula.ts`, whose rule is
/// `^'*[=+\-@\t\r]`** — a leading run of apostrophes, *then* a trigger. The run is what keeps the
/// app's own CSV a round trip: the reader takes one apostrophe back off a cell that has one too
/// many, so a note that already started `'=` is written `''=` and comes back as the note it was.
/// A cell whose apostrophes are followed by anything else is not touched. `trim_start_matches`
/// is that regex's greedy `'*`: backtracking could only hand the class an apostrophe, which is not
/// in it, so the two cannot disagree.
///
/// **Every cell, not a list of free-text columns**, for that file's reason: a quantity, a price and
/// a collector number never start with a trigger, so escaping all of them costs nothing and a
/// free-text field added to the registry later cannot be left out. This half is the only writer's
/// half there is here — nothing on this side reads a CSV back, so there is no `unescape_formula`.
pub fn escape_formula(value: &str) -> String {
    if value.trim_start_matches('\'').starts_with(FORMULA_TRIGGERS) {
        format!("'{value}")
    } else {
        value.to_string()
    }
}

/// One row: every field written by the rule above, joined with commas. No line ending — whatever
/// assembles the file decides what separates its rows.
pub fn csv_row(values: &[String]) -> String {
    values
        .iter()
        .map(|v| csv_field(v))
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_value_is_not_quoted() {
        assert_eq!(csv_field("Lightning Bolt"), "Lightning Bolt");
    }

    #[test]
    fn a_comma_a_quote_a_newline_and_a_carriage_return_each_force_quoting() {
        assert_eq!(
            csv_field("Borrowing 100,000 Arrows"),
            "\"Borrowing 100,000 Arrows\""
        );
        assert_eq!(csv_field("Ach! Hans, Run!"), "\"Ach! Hans, Run!\"");
        assert_eq!(csv_field("a\nb"), "\"a\nb\"");
        assert_eq!(csv_field("a\rb"), "\"a\rb\"");
    }

    #[test]
    fn an_inner_quote_doubles() {
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn a_row_joins_with_commas_and_quotes_only_what_needs_it() {
        let row = csv_row(&["1".into(), "Bolt".into(), "a,b".into()]);
        assert_eq!(row, "1,Bolt,\"a,b\"");
    }

    /// Every trigger `formula.ts` names, each at the head of a cell, gets one apostrophe — and
    /// nothing else about the cell moves.
    #[test]
    fn each_formula_trigger_at_the_head_of_a_cell_gets_one_apostrophe() {
        assert_eq!(escape_formula("-2 lent"), "'-2 lent");
        assert_eq!(escape_formula("=SUM(A1)"), "'=SUM(A1)");
        assert_eq!(escape_formula("+2 Mace"), "'+2 Mace");
        assert_eq!(escape_formula("@shop"), "'@shop");
        assert_eq!(escape_formula("\tindented"), "'\tindented");
        assert_eq!(escape_formula("\rreturn"), "'\rreturn");
    }

    /// The round-trip edge: a cell that already starts with apostrophes and then a trigger gets
    /// one more, so the reader's one-apostrophe strip hands back the value as it was.
    #[test]
    fn a_cell_already_starting_apostrophe_then_trigger_gets_one_more() {
        assert_eq!(escape_formula("'=already"), "''=already");
        assert_eq!(escape_formula("''-x"), "'''-x");
    }

    /// Apostrophes before anything that is not a trigger, a trigger anywhere but the head, and
    /// the empty cell are all written as they are.
    #[test]
    fn a_cell_with_no_trigger_at_its_head_is_written_as_it_is() {
        for value in [
            "",
            "Lightning Bolt",
            "'quoted",
            "''",
            "a-b",
            "1 = 1",
            " -2",
            "e@mail",
        ] {
            assert_eq!(escape_formula(value), value, "{value:?}");
        }
    }

    /// The escape runs before the quoting, so a trigger cell that also needs quoting keeps its
    /// apostrophe inside the quotes — the order `format.ts` uses and the goldens pin.
    #[test]
    fn an_escaped_cell_is_then_quoted_like_any_other() {
        assert_eq!(
            csv_field(&escape_formula("=a, b")),
            "\"'=a, b\"",
            "the apostrophe belongs to the value the quotes carry"
        );
        assert_eq!(csv_field(&escape_formula("\rx")), "\"'\rx\"");
    }
}
