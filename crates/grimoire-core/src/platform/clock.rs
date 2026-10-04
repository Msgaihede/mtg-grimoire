//! The wall clock, a [`Wall`] moment that can be written down, and a [`Tick`] to measure a
//! wait from.
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
/// **Monotonic on every host**: `Instant` natively and `performance.now()` in a browser, read
/// off the global scope because the host there is a Worker. It was the wall clock in a
/// browser until the web host first paced a request (phase 5, step 5.2) — a clock a reader or
/// an NTP step can move forwards, which read as time having passed and would have let
/// `scryfall`'s pacing gate send early. A browser coarsens the reading (100 µs, or 5 µs on a
/// cross-origin-isolated page), which is nothing against the 100 ms the gate counts. A host
/// with no `performance` object falls back to the wall clock rather than trapping.
///
/// **Two ticks can be compared and a tick can be moved forward**, which is what the scanner's
/// one-window lease needs: it keeps the tick its holder last settled at and asks how long ago
/// that was *as of* a tick it is handed, so its tests can say "two seconds later" without
/// sleeping for two seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tick(imp::Tick);

impl Tick {
    pub fn now() -> Tick {
        Tick(imp::tick())
    }

    /// How long ago this tick was taken. Never negative.
    pub fn elapsed(&self) -> std::time::Duration {
        imp::elapsed(&self.0)
    }

    /// How long after `earlier` this tick was taken — zero when it was not after it at all.
    pub fn saturating_duration_since(&self, earlier: Tick) -> std::time::Duration {
        imp::since(&self.0, &earlier.0)
    }
}

/// This tick, `by` later. Natively it is `Instant`'s own addition, which panics past the end of
/// what the platform can count — a span no caller has.
impl std::ops::Add<std::time::Duration> for Tick {
    type Output = Tick;

    fn add(self, by: std::time::Duration) -> Tick {
        Tick(imp::later(self.0, by))
    }
}

/// A moment on the wall clock that can be **written down and compared** — on a file as its
/// modified time, against another moment read back months later.
///
/// Whole milliseconds since the Unix epoch, on every host: what [`now_ms`] answers, with the
/// arithmetic a stamp needs. The image cache's used-stamp is why it exists — it orders pictures
/// by when each was last served, across restarts, which a [`Tick`] cannot do and a bare `i64`
/// would do without saying which unit it was in.
///
/// **Not for measuring a wait**: a reader or an NTP step can move it either way. That is what
/// [`Tick`] is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Wall(i64);

impl Wall {
    /// 1970-01-01T00:00:00Z.
    pub const EPOCH: Wall = Wall(0);

    pub fn now() -> Wall {
        Wall(now_ms())
    }

    pub fn from_ms(ms: i64) -> Wall {
        Wall(ms)
    }

    /// Milliseconds since the epoch; negative for a moment before it.
    pub fn as_ms(self) -> i64 {
        self.0
    }

    /// Whole seconds since the epoch, rounded towards the past — what `unixepoch()` answers
    /// for the same moment.
    pub fn as_secs(self) -> i64 {
        self.0.div_euclid(1000)
    }

    /// This moment, `by` earlier. `None` only where the arithmetic cannot be done at all.
    pub fn checked_sub(self, by: std::time::Duration) -> Option<Wall> {
        self.0.checked_sub(whole_ms(by)).map(Wall)
    }
}

impl std::ops::Add<std::time::Duration> for Wall {
    type Output = Wall;

    fn add(self, by: std::time::Duration) -> Wall {
        Wall(self.0.saturating_add(whole_ms(by)))
    }
}

impl std::ops::Sub<std::time::Duration> for Wall {
    type Output = Wall;

    fn sub(self, by: std::time::Duration) -> Wall {
        Wall(self.0.saturating_sub(whole_ms(by)))
    }
}

/// A duration in whole milliseconds, saturating: a span too long to count is the longest one.
fn whole_ms(d: std::time::Duration) -> i64 {
    i64::try_from(d.as_millis()).unwrap_or(i64::MAX)
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

    pub fn since(later: &Tick, earlier: &Tick) -> Duration {
        later.saturating_duration_since(*earlier)
    }

    pub fn later(tick: Tick, by: Duration) -> Tick {
        tick + by
    }
}

#[cfg(target_family = "wasm")]
mod imp {
    use std::time::Duration;
    use wasm_bindgen::prelude::*;

    /// **Microseconds on the host's monotonic clock** — `performance.now()`, counted from the
    /// Worker's own time origin, so it says nothing about the date and cannot be stored.
    pub type Tick = i64;

    #[wasm_bindgen]
    extern "C" {
        /// `performance.now()`, off the global scope — a Worker has no `window`, and
        /// `performance` is on `WorkerGlobalScope` as it is on a page. `catch`, because a host
        /// with no such object would otherwise *throw*, and a throw here is a trap.
        #[wasm_bindgen(js_namespace = performance, js_name = now, catch)]
        fn performance_now() -> Result<f64, JsValue>;
    }

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

    /// The monotonic clock, in whole microseconds. **Never the wall clock while there is a
    /// monotonic one**: a reader or an NTP step can move `Date.now()` either way, and a step
    /// forwards would open Scryfall's pacing gate early. A browser coarsens the reading (to
    /// 100 µs, or 5 µs on a cross-origin-isolated page), which is far inside the 100 ms the
    /// gate counts. A host with no `performance` at all falls back to the wall clock, which is
    /// what this arm was before the web host paced anything.
    pub fn tick() -> Tick {
        match performance_now() {
            Ok(ms) if ms.is_finite() && ms >= 0.0 => (ms * 1000.0) as i64,
            _ => now_ms().saturating_mul(1000),
        }
    }

    fn micros(span: i64) -> Duration {
        Duration::from_micros(u64::try_from(span).unwrap_or(0))
    }

    pub fn elapsed(tick: &Tick) -> Duration {
        micros(self::tick().saturating_sub(*tick))
    }

    pub fn since(later: &Tick, earlier: &Tick) -> Duration {
        micros(later.saturating_sub(*earlier))
    }

    pub fn later(tick: Tick, by: Duration) -> Tick {
        tick.saturating_add(i64::try_from(by.as_micros()).unwrap_or(i64::MAX))
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

    /// A stamp is the clock's own milliseconds, ordered and stepped as a date is — and its
    /// seconds round towards the past on both sides of the epoch, as SQLite's do.
    #[test]
    fn a_wall_moment_is_ordered_stepped_and_read_back_in_seconds() {
        let before = now_ms();
        let now = Wall::now();
        assert!((before..=now_ms()).contains(&now.as_ms()));

        let day = std::time::Duration::from_secs(86_400);
        let then = Wall::EPOCH + day * 1_000;
        assert_eq!(then.as_ms(), 86_400_000_000);
        assert_eq!(then.as_secs(), 86_400_000);
        assert!(then - day < then && then < then + day);
        assert_eq!(then.checked_sub(day), Some(then - day));
        assert_eq!((then - day) + day, then);

        assert_eq!(Wall::from_ms(1_999).as_secs(), 1);
        assert_eq!(Wall::from_ms(-1).as_secs(), -1, "towards the past");
        assert_eq!(
            Wall::from_ms(i64::MAX) + day,
            Wall::from_ms(i64::MAX),
            "a step past the end stays at the end"
        );
        assert_eq!(
            Wall::from_ms(i64::MIN).checked_sub(day),
            None,
            "and the one subtraction that cannot be done says so"
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

    /// A tick moved forward is that much after the one it came from, and never before it — the
    /// arithmetic the scanner's lease asks of two ticks without waiting between them.
    #[test]
    fn a_tick_moved_forward_measures_that_much_after_its_origin() {
        let t0 = Tick::now();
        let two = std::time::Duration::from_secs(2);
        let later = t0 + two;
        assert_eq!(later.saturating_duration_since(t0), two);
        assert_eq!(
            t0.saturating_duration_since(later),
            std::time::Duration::ZERO,
            "an earlier tick is no time after a later one"
        );
        assert_eq!(t0 + std::time::Duration::ZERO, t0);
        assert_ne!(later, t0);
    }
}
