//! The hybrid logical clock — spec §7.3's ordering, with no server clock in it.
//!
//! Physical millis, a logical counter, and the device id as the deterministic tiebreak, **in
//! that order**. The order is the design: leading with the device id would sort every op by
//! whose machine it was written on, which is not an ordering, it is an alphabet.

use serde::{Deserialize, Serialize};

/// One point on the group's shared timeline.
///
/// `Ord` is derived, and the field order below **is** the comparison — moving `device` above
/// `ctr` would silently change what "later" means for the whole engine, with nothing in review
/// to look at but a reordered struct.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hlc {
    pub ms: i64,
    pub ctr: i64,
    pub device: String,
}

impl Hlc {
    /// The next stamp this device issues.
    ///
    /// **`max` and not assignment**, because a wall clock that went backwards is the ordinary
    /// case rather than the exotic one — a reader correcting their system time, a laptop coming
    /// back from sleep. A clock that retreated would issue a stamp that sorts *before* ops
    /// already written, and every last-writer-wins decision made against it would be wrong.
    pub fn tick(prev: &Hlc, wall_ms: i64) -> Hlc {
        let ms = prev.ms.max(wall_ms);
        Hlc {
            ms,
            ctr: if ms == prev.ms { prev.ctr + 1 } else { 0 },
            device: prev.device.clone(),
        }
    }

    /// The next stamp after seeing somebody else's.
    ///
    /// This is what makes the clock *causal*: anything written after an op was received sorts
    /// after it, on every device, whatever the two wall clocks think.
    pub fn observe(prev: &Hlc, remote: &Hlc, wall_ms: i64) -> Hlc {
        let ms = prev.ms.max(remote.ms).max(wall_ms);
        let ctr = if ms == prev.ms && ms == remote.ms {
            prev.ctr.max(remote.ctr) + 1
        } else if ms == prev.ms {
            prev.ctr + 1
        } else if ms == remote.ms {
            remote.ctr + 1
        } else {
            0
        };
        Hlc {
            ms,
            ctr,
            device: prev.device.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(ms: i64, ctr: i64, device: &str) -> Hlc {
        Hlc {
            ms,
            ctr,
            device: device.to_owned(),
        }
    }

    /// A tick under a moving wall clock takes the wall's time and resets the counter.
    #[test]
    fn a_tick_follows_the_wall_clock_when_it_moved() {
        let next = Hlc::tick(&h(1_000, 7, "a"), 2_000);
        assert_eq!((next.ms, next.ctr), (2_000, 0));
    }

    /// A tick within the same millisecond bumps the counter instead — which is the whole
    /// reason the counter exists, since a burst of writes shares one millisecond.
    #[test]
    fn a_tick_inside_one_millisecond_bumps_the_counter() {
        let next = Hlc::tick(&h(1_000, 7, "a"), 1_000);
        assert_eq!((next.ms, next.ctr), (1_000, 8));
    }

    /// A wall clock that went BACKWARDS must not make the clock go backwards. A user setting
    /// their system time back an hour is the ordinary case, not the exotic one.
    #[test]
    fn a_backwards_wall_clock_cannot_move_the_clock_back() {
        let next = Hlc::tick(&h(5_000, 0, "a"), 1_000);
        assert_eq!(next.ms, 5_000, "the clock never retreats");
        assert_eq!(next.ctr, 1);
        assert!(next > h(5_000, 0, "a"));
    }

    /// Observing a remote op from the future pulls this clock up past it, so anything written
    /// afterwards genuinely sorts after what was seen.
    #[test]
    fn observing_a_future_op_pulls_the_clock_past_it() {
        let next = Hlc::observe(&h(1_000, 0, "a"), &h(9_000, 3, "b"), 1_100);
        assert!(
            next > h(9_000, 3, "b"),
            "{next:?} must sort after what it saw"
        );
    }

    /// ...and observing one from the past leaves this clock where it was, moving only the
    /// counter. The two halves of `observe` are the two halves of a reconnect.
    #[test]
    fn observing_a_past_op_does_not_drag_the_clock_back() {
        let next = Hlc::observe(&h(9_000, 2, "a"), &h(1_000, 0, "b"), 9_000);
        assert_eq!((next.ms, next.ctr), (9_000, 3));
        assert!(next > h(9_000, 2, "a"));
    }

    /// The device id is the tiebreak and it is the LAST term. Two ops in one millisecond with
    /// one counter are ordered by device, deterministically and identically on both machines.
    #[test]
    fn the_device_id_breaks_a_tie_and_never_leads() {
        assert!(h(1, 0, "a") < h(1, 0, "b"));
        // ...but it never outranks the millis or the counter.
        assert!(h(1, 0, "z") < h(2, 0, "a"));
        assert!(h(1, 0, "z") < h(1, 1, "a"));
    }

    /// Ordering is total and agrees with itself, which is what "deterministic tiebreak" means:
    /// every device sorting the same set gets the same list.
    #[test]
    fn sorting_is_total_and_stable_across_shuffles() {
        let mut a = vec![h(2, 0, "b"), h(1, 5, "a"), h(2, 0, "a"), h(1, 5, "z")];
        let mut b = vec![h(1, 5, "z"), h(2, 0, "a"), h(2, 0, "b"), h(1, 5, "a")];
        a.sort();
        b.sort();
        assert_eq!(a, b);
        assert_eq!(a[0], h(1, 5, "a"));
        assert_eq!(a[3], h(2, 0, "b"));
    }

    /// The wire shape is camelCase and round-trips, because the relay orders by two of these
    /// three fields and the Worker reads them by name.
    #[test]
    fn a_stamp_round_trips_through_json_in_camel_case() {
        let json = serde_json::to_string(&h(7, 2, "dev-a")).unwrap();
        assert_eq!(json, r#"{"ms":7,"ctr":2,"device":"dev-a"}"#);
        let back: Hlc = serde_json::from_str(&json).unwrap();
        assert_eq!(back, h(7, 2, "dev-a"));
    }
}
