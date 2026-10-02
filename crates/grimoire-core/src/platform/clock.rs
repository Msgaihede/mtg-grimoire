//! The wall clock.
//!
//! **`SystemTime::now()` panics on `wasm32-unknown-unknown`** — at run time, in a build that
//! compiled without a warning — and the first web build hit that five separate times. So
//! nothing outside this directory names it, `fence.rs` refuses a source file that does,
//! and a module that wants the time calls [`now_ms`] or [`now_secs`].
//!
//! **Signed, and saturating rather than fallible.** Every stored stamp in this app is an `i64`
//! — SQLite's `unixepoch()` answers one, and the hybrid logical clock carries one — so that is
//! what this answers. A clock set before 1970 reads as `0` instead of an error: no caller has
//! anything better to do with a refusal than to carry on with a zero.
//!
//! **Most of the engine never asks.** The domain modules take their time from SQLite
//! (`unixepoch()`, `date('now')`) inside the statement that needs it, which is the same on
//! every host and is the reason so little code is a clock's caller at all.

/// Milliseconds since the Unix epoch, by the host's wall clock.
pub fn now_ms() -> i64 {
    imp::now_ms()
}

/// Seconds since the Unix epoch, by the host's wall clock.
pub fn now_secs() -> i64 {
    now_ms().div_euclid(1000)
}

#[cfg(not(target_family = "wasm"))]
mod imp {
    use std::time::{SystemTime, UNIX_EPOCH};

    pub fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| {
                i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
            })
    }
}

#[cfg(target_family = "wasm")]
mod imp {
    /// `Date.now()` is a whole number of milliseconds in a double, and a negative one for a
    /// clock set before 1970 — which reads as `0`, the native arm's answer.
    pub fn now_ms() -> i64 {
        let ms = js_sys::Date::now();
        if ms.is_finite() && ms > 0.0 {
            ms as i64
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-01-01T00:00:00Z. Any machine running this suite is past it, and a clock that
    /// answered seconds where milliseconds were asked for would be a thousand times short.
    const FLOOR_MS: i64 = 1_767_225_600_000;

    #[test]
    fn the_clock_answers_milliseconds_since_the_epoch() {
        let ms = now_ms();
        assert!(ms > FLOOR_MS, "{ms} is before 2026 in milliseconds");
        assert!(ms < FLOOR_MS * 10, "{ms} is not a millisecond count");
    }

    #[test]
    fn seconds_are_the_same_instant_a_thousand_times_smaller() {
        let before = now_ms().div_euclid(1000);
        let secs = now_secs();
        let after = now_ms().div_euclid(1000);
        assert!(
            (before..=after).contains(&secs),
            "{before} <= {secs} <= {after}"
        );
    }
}
