//! CSV, RFC 4180 — the writer half only.
//!
//! A port of the writer in `src/features/transfer/csv.ts`, unchanged in behaviour. `parseCsv`
//! deliberately did **not** come with it: nothing on this side ever reads a mirror file back, so a
//! reader here would exist only to be tested.

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
}
