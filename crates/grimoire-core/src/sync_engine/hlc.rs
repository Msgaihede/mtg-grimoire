//! The hybrid logical clock — spec §7.3's ordering, with no server clock in it.
//!
//! Physical millis, a logical counter, and the device id as the deterministic tiebreak, **in
//! that order**. The order is the design: leading with the device id would sort every op by
//! whose machine it was written on, which is not an ordering, it is an alphabet.
//!
//! **How far ahead a peer's stamp may be is bounded, and not in this file** — [`MAX_AHEAD_MS`]
//! says why [`Hlc::observe`] is the wrong place. `client::pull` holds a batch stamped further
//! ahead of this device's wall clock than the bound (the `clock` hold) until the wall clock comes
//! within it. The relay refuses to store such a batch at the push, a **422** `code:
//! "clock_ahead"` against its own `MAX_CLOCK_AHEAD_MS`.

use serde::{Deserialize, Serialize};

/// How far past this device's wall clock a peer's stamp may be before its op waits: one day.
///
/// **Unbounded, one wrong clock outranks the group.** Last-writer-wins trusts the stamp, so a
/// device whose date is set a year ahead wins every edit it makes for a year, and every device
/// that applies one of its ops is dragged a year forward with it — for good, since [`Hlc::tick`]
/// never retreats.
///
/// **The receiver holds the op; it does not clamp [`Hlc::observe`].** A clock that did not move
/// past an op it applied would stamp the reader's next edit *before* that op: here the edit
/// stands, because it is the last write this row saw, and on every other device the op outranks
/// it — the same row, two answers, and neither device able to see the difference. Applying an op
/// is what obliges the clock to pass it, so the only bounded choice is not to apply it yet: the
/// pull cursor stays where it is, and the op applies once this device's wall clock is within the
/// bound of it. Within the bound the drag stands — a peer a few hours fast still pulls the group
/// those hours forward, which is `observe` doing its job.
///
/// **Why a day.** Ordinary skew is seconds, and a clock set by hand in the wrong time zone is out
/// by hours; both pass. A mis-set *date* is a day or more, and is what this is for. What a hold
/// costs: the held ops wait, and the cursor with them — which pins the relay's compaction — until
/// this device's clock reaches them less a day. Against a relay that refuses such pushes, a
/// receiver whose own clock is right never holds: an accepted stamp was within a day of the
/// relay's clock at the push, and this device's clock is past that moment. What it catches is a
/// log stored before the relay refused them, and a receiver whose own clock is behind, which waits
/// no longer than its clock takes to reach the moment of the push.
///
/// **It must equal `MAX_CLOCK_AHEAD_MS` in `infrastructure/relay/src/log.ts`**, which
/// [`tests::the_bound_is_the_relays`] reads: a relay bound looser than this one stores what every
/// updated receiver holds, and a tighter one refuses a push this device thought it could make.
pub const MAX_AHEAD_MS: i64 = 24 * 60 * 60 * 1000;

/// Whether an op stamped at `stamp_ms` is too far ahead of this device's `wall_ms` to apply yet:
/// more than [`MAX_AHEAD_MS`] past it. Exactly the bound is not too far.
///
/// **Saturating**, because `wall_ms` near `i64::MAX` is a clock set absurdly, not a reason to
/// panic in a debug build or to wrap to a bound in the distant past in a release one.
pub fn too_far_ahead(stamp_ms: i64, wall_ms: i64) -> bool {
    stamp_ms > wall_ms.saturating_add(MAX_AHEAD_MS)
}

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

    /// **Exactly a day ahead applies and one millisecond more waits.** Behind, level and inside
    /// the bound are all ordinary, and the bound is a strict `>` — a peer precisely a day fast is
    /// the last one let through, not the first one held.
    #[test]
    fn a_stamp_is_too_far_ahead_one_millisecond_past_the_bound() {
        let wall = 1_787_000_000_000;
        assert!(!too_far_ahead(wall - 60_000, wall));
        assert!(!too_far_ahead(wall, wall));
        assert!(!too_far_ahead(wall + MAX_AHEAD_MS, wall));
        assert!(too_far_ahead(wall + MAX_AHEAD_MS + 1, wall));
    }

    /// **A wall clock at the top of the range saturates rather than overflowing** — which in a
    /// debug build is a panic in the middle of a pull, and in a release one wraps the bound to the
    /// far past and holds everything.
    #[test]
    fn the_bound_saturates_at_the_top_of_the_range() {
        assert!(!too_far_ahead(i64::MAX, i64::MAX));
        assert!(!too_far_ahead(i64::MAX, i64::MAX - MAX_AHEAD_MS + 1));
        assert!(too_far_ahead(i64::MAX, 0));
    }

    /// **The bound is the relay's, read out of the relay's own source**, so moving it on one side
    /// is red on the other.
    #[test]
    fn the_bound_is_the_relays() {
        let relay = include_str!("../../../../infrastructure/relay/src/log.ts");
        assert_eq!(MAX_AHEAD_MS, 24 * 60 * 60 * 1000);
        assert!(
            relay.contains("export const MAX_CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;"),
            "infrastructure/relay/src/log.ts no longer exports the bound `too_far_ahead` holds against"
        );
    }
}
