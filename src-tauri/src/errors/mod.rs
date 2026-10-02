//! **The error log is `grimoire-core`'s, re-exported here beside the one function that names a
//! type this crate still holds.**
//!
//! [`kind_of`] classifies a [`crate::scryfall::ScryfallError`], and `scryfall` moves with the
//! extraction's I/O step. Until then the classifier lives beside the client it reads, and
//! every other `crate::errors::…` — `record`, `list`, `clear`, `Source`, `Kind` — is the core's.

pub use grimoire_core::errors::*;

/// Classify a Scryfall failure, so the several call sites that report one agree on what it
/// was rather than each deciding for themselves.
pub fn kind_of(err: &crate::scryfall::ScryfallError) -> Kind {
    use crate::scryfall::ScryfallError as E;
    match err {
        E::RateLimited { .. } => Kind::RateLimited,
        E::Timeout(_) => Kind::Timeout,
        E::Io(_) => Kind::Io,
        E::SizeMismatch { .. } => Kind::Parse,
        E::NotFound => Kind::Http,
        E::Unexpected(m) if m.contains("not JSON") => Kind::Parse,
        E::Unexpected(_) => Kind::Http,
        E::Http(e) if e.is_timeout() => Kind::Timeout,
        E::Http(_) => Kind::Http,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Every Scryfall failure has a kind, and the two that a reader acts on differently —
    /// a rate limit and a timeout — must never be flattened into "http".
    #[test]
    fn every_scryfall_failure_classifies() {
        use crate::scryfall::ScryfallError as E;
        assert_eq!(
            kind_of(&E::RateLimited {
                retry_after_secs: 30
            }),
            Kind::RateLimited
        );
        assert_eq!(
            kind_of(&E::Timeout(std::time::Duration::from_secs(10))),
            Kind::Timeout
        );
        assert_eq!(kind_of(&E::NotFound), Kind::Http);
        assert_eq!(kind_of(&E::Unexpected("status 503".into())), Kind::Http);
        assert_eq!(
            kind_of(&E::Unexpected("response was not JSON: x".into())),
            Kind::Parse
        );
        assert_eq!(
            kind_of(&E::SizeMismatch {
                expected: 2,
                actual: 1
            }),
            Kind::Parse
        );
    }
}
