//! The session's measured switches, read from the environment by `replay` and `eval`, so a change
//! can be measured against the scanner without it on one binary — and through `pnpm
//! scanner:replay`, which passes the environment on and no unknown argument.
//!
//! ```text
//! SCANNER_REFRAME=off | <margin>[,<only above>[,<min gap>]]   card_scanner::reframe, on by default
//! SCANNER_REFRAME_LOG=1                                       a stderr line per reframed frame
//! SCANNER_GAP=off | [<exact>],[<fast>]                        session::GapGate, Exact's on by default
//! ```
//!
//! Unset leaves the session's own default. A value that does not parse leaves that field's
//! default, so a typo measures the default rather than something nobody asked for.

use card_scanner::session::{GapGate, Session};

fn numbers(spec: &str) -> Vec<Option<f32>> {
    spec.split(',').map(|p| p.trim().parse::<f32>().ok()).collect()
}

pub fn apply(session: &mut Session) {
    let log = std::env::var_os("SCANNER_REFRAME_LOG").is_some();
    match std::env::var("SCANNER_REFRAME").ok().as_deref() {
        Some("off") => session.set_reframe(None),
        spec => {
            let mut opts = card_scanner::reframe::Options { log, ..Default::default() };
            let n = spec.map(numbers).unwrap_or_default();
            let at = |i: usize| n.get(i).copied().flatten();
            opts.margin = at(0).unwrap_or(opts.margin);
            opts.only_above = at(1).unwrap_or(opts.only_above);
            opts.min_gap = at(2).unwrap_or(opts.min_gap);
            session.set_reframe(Some(opts));
        }
    }
    match std::env::var("SCANNER_GAP").ok().as_deref() {
        None => {}
        Some("off") => session.set_gap_gate(None),
        Some(spec) => {
            let n = numbers(spec);
            let at = |i: usize| n.get(i).copied().flatten();
            session.set_gap_gate(Some(GapGate { exact: at(0), fast: at(1) }));
        }
    }
}
