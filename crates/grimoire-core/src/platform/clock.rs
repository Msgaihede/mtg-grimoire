//! The wall clock, and a [`Tick`] to measure a wait from.
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

/// A moment to measure a wait from — what `Instant::now()` is everywhere but a browser, where
/// reading it panics exactly as the wall clock does.
///
/// **For how long something took and nothing else**: a tick has no date, cannot be stored and
/// is not comparable across a restart. `db::lock_for` is why it exists — a bounded wait has to
/// know when its bound has passed.
///
/// A browser's arm is the wall clock, which a reader or an NTP step can move, and which counts
/// whole milliseconds. A step backwards reads as no time having passed, so a wait there runs
/// long; **a step forwards reads as time having passed, so a wait there can end early**, and
/// the rounding alone can overstate a wait by a millisecond. `db::lock_for` gives up a little
/// soon; `scryfall`'s pacing gate, the second caller, would send a little soon — which is why
/// the web host should give this arm `performance.now()` before it paces anything.
#[derive(Debug, Clone, Copy)]
pub struct Tick(imp::Tick);

impl Tick {
    pub fn now() -> Tick {
        Tick(imp::tick())
    }

    /// How long ago this tick was taken. Never negative.
    pub fn elapsed(&self) -> std::time::Duration {
        imp::elapsed(&self.0)
    }
}

#[cfg(not(target_family = "wasm"))]
mod imp {
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    pub type Tick = Instant;

    pub fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| {
                i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
            })
    }

    pub fn tick() -> Tick {
        Instant::now()
    }

    pub fn elapsed(tick: &Tick) -> Duration {
        tick.elapsed()
    }
}

#[cfg(target_family = "wasm")]
mod imp {
    use std::time::Duration;

    /// Milliseconds since the epoch, as [`now_ms`] answered them.
    pub type Tick = i64;

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

    pub fn tick() -> Tick {
        now_ms()
    }

    pub fn elapsed(tick: &Tick) -> Duration {
        Duration::from_millis(u64::try_from(now_ms().saturating_sub(*tick)).unwrap_or(0))
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

    /// A wait measured with a tick is at least as long as the pause inside it, and two reads
    /// of one tick never run backwards — the two things `db::lock_for`'s bound rests on.
    #[test]
    fn a_tick_measures_the_pause_taken_after_it() {
        let tick = Tick::now();
        let first = tick.elapsed();
        assert!(crate::platform::pause(std::time::Duration::from_millis(20)));
        let second = tick.elapsed();
        assert!(second >= first, "{second:?} after {first:?}");
        assert!(
            second >= std::time::Duration::from_millis(20),
            "a 20 ms pause measured as {second:?}"
        );
    }
}
