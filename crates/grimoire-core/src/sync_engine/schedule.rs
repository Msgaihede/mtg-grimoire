//! When to sync — the whole policy, with no I/O and no clock.
//!
//! **Everything here is a pure function of an explicit `now_ms`**, so the debounces, the
//! single-flight rule and the backoff are testable without a socket, a relay or a timer. The
//! part that does I/O is [`super::live`] — the connection manager, a loop a host spawns over
//! `platform`'s socket and timer — and it is deliberately thin: this is where a bug would live.

/// How long a `head` frame waits before its round trip, so a burst becomes one trip.
///
/// A 50 000-row import is 250 sequential POSTs and therefore 250 frames. The receiving device
/// must answer with one round trip, not 250 — this is the whole reason the relay does no
/// coalescing of its own, which would have needed a timer and blocked hibernation.
pub const FRAME_DEBOUNCE_MS: u64 = 1_000;

/// How long local writes must be quiet before this device pushes.
///
/// Longer than [`FRAME_DEBOUNCE_MS`] because it is waiting for a person to stop typing rather
/// than for a burst that has already finished. It slides: every write pushes the deadline out,
/// so an import that writes for a minute pushes once, at the end.
pub const WRITE_DEBOUNCE_MS: u64 = 3_000;

/// How often the client sends a WebSocket **protocol** ping.
///
/// Cloudflare closes an idle socket after an interval it documents only as "a period of time",
/// so this is a guess to be measured against the deployed Worker rather than a derived number.
/// Protocol pings are answered by the runtime without waking the Durable Object and are not
/// billed — the only keepalive that keeps hibernation.
pub const PING_SECS: u64 = 45;

/// How long a dial may take before the socket is called failed.
///
/// An upgrade is a connection and one small answer, and each of the relay's other clients gives
/// those ten seconds apiece (`entitlement::http`'s `connect_timeout` and `read_timeout`); this is
/// the two added. A healthy dial takes a fraction of a second — 50–150 ms measured against a
/// relay on loopback — so twenty is far outside anything a working network does, and well inside
/// the first rung of patience a reader has for the word `connecting`. It is also about where
/// Windows' own TCP stack gives up on a host that answers nothing (three SYNs, ~21 s), so a
/// desktop whose network is simply gone hears from its stack first, in the stack's own words.
pub const CONNECT_SECS: u64 = 20;

/// The shortest wait, and the cap on the **base** the jitter is then added to.
///
/// ⚠️ `BACKOFF_MAX_MS` is not the longest a reconnect waits, and reading it as one has already
/// misled a doc comment. [`backoff_ms`] adds up to a full `base` of jitter *on top of* the
/// capped base, so the real ceiling is twice this — ~120 s, not 60.
const BACKOFF_MIN_MS: u64 = 1_000;
const BACKOFF_MAX_MS: u64 = 60_000;

/// Something that might mean a round trip is owed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wake {
    /// The relay says its log has reached `cursor`.
    Frame { cursor: i64 },
    /// A transaction committed on this device.
    LocalWrite,
    /// The app started.
    Launch,
    /// The socket came back after being away.
    Reconnect,
}

/// The single-flight, debounced schedule.
#[derive(Debug, Default)]
pub struct Scheduler {
    due: Option<u64>,
    /// Whether the pending deadline came from a local write.
    ///
    /// **The write window slides only against itself.** Without this flag, a write arriving
    /// while a `Reconnect` is owed would push the reconnect out by the write debounce — so a
    /// device that came online holding a backlog would sit on it for as long as somebody kept
    /// typing.
    due_is_write: bool,
    running: bool,
}

impl Scheduler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a wake. **A sooner deadline always wins**: a debounce may bring a trip forward
    /// and must never push one back, or a `Reconnect` could be delayed indefinitely by
    /// someone typing.
    pub fn wake(&mut self, wake: Wake, now_ms: u64, pull_cursor: i64) {
        let is_write = matches!(wake, Wake::LocalWrite);
        let deadline = match wake {
            // **A frame is a hint, and this is the only place it is believed.** A device
            // behind a key rotation holds its cursor deliberately, so a frame that is not
            // ahead schedules nothing — otherwise that device spins until `check_keys` hands
            // it the new key.
            Wake::Frame { cursor } => {
                if cursor <= pull_cursor {
                    return;
                }
                now_ms.saturating_add(FRAME_DEBOUNCE_MS)
            }
            Wake::LocalWrite => now_ms.saturating_add(WRITE_DEBOUNCE_MS),
            // **There is no `Exit` here, and there was one until this review.** The shutdown
            // push does not go through a scheduler at all: the desktop's `ExitRequested` arm
            // asks its own `anything_pending` and calls its own `push_now` directly (`src-tauri`'s
            // `sync_engine::live`), inside its own hard budget, because by then this loop may
            // already be gone. A variant nothing constructs is a mechanism a reader believes in.
            Wake::Launch | Wake::Reconnect => now_ms,
        };
        // **Three cases, and only one of them moves a deadline later.**
        //
        // A write arriving while only a write is pending *slides* the window, so an import
        // that writes for a minute pushes once, at the end. Every other combination takes the
        // sooner of the two, because a catch-up must never be held back by typing.
        match self.due {
            None => {
                self.due = Some(deadline);
                self.due_is_write = is_write;
            }
            Some(_) if self.due_is_write && is_write => {
                self.due = Some(deadline);
            }
            Some(existing) => {
                if deadline < existing {
                    self.due = Some(deadline);
                    self.due_is_write = is_write;
                }
            }
        }
    }

    /// When the next trip is owed, if one is.
    pub fn due_at(&self) -> Option<u64> {
        self.due
    }

    /// Claim the pending trip if it is due and nothing is in flight.
    ///
    /// **Single flight.** A wake that arrives during a trip is kept, not dropped: it is still
    /// pending when [`finished`](Self::finished) is called.
    pub fn take_due(&mut self, now_ms: u64) -> bool {
        if self.running {
            return false;
        }
        match self.due {
            Some(at) if at <= now_ms => {
                self.due = None;
                self.due_is_write = false;
                true
            }
            _ => false,
        }
    }

    pub fn started(&mut self) {
        self.running = true;
    }

    pub fn finished(&mut self) {
        self.running = false;
    }
}

/// How long to wait before reconnect attempt `attempt`, given `jitter` in `0.0..1.0`.
///
/// **Jittered because Cloudflare restarts servers as it deploys**, which drops every socket on
/// the relay in the same instant. An unjittered backoff would reconnect every device of every
/// group together, turning a deploy into a thundering herd against the object that just came
/// back.
///
/// **The jitter is added to the capped base, not folded into it**, so the ceiling this returns
/// is `2 × BACKOFF_MAX_MS` — about two minutes, not one. That is deliberate: a spread that is a
/// fixed fraction of the wait keeps its spreading power at every rung, where a jitter squeezed
/// under the cap would collapse to nothing exactly at the top of the ladder, which is where
/// every device is at once after a deploy.
pub fn backoff_ms(attempt: u32, jitter: f64) -> u64 {
    let base = BACKOFF_MIN_MS
        .saturating_mul(1u64 << attempt.min(6))
        .min(BACKOFF_MAX_MS);
    base + (base as f64 * jitter.clamp(0.0, 1.0)) as u64
}

/// Why a socket stopped — the only thing `live` decides for itself.
///
/// **The classification is the socket's and every consequence is here.** The reconnect rules
/// were written inline in that loop where no test could reach them, and they were wrong: a 4001
/// close skipped the backoff and spun against the relay, and how an attempt is forgiven was wrong
/// in a way only a trace could find. So the rules moved to the layer that has tests, and the
/// socket now says only what happened to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disconnect {
    /// The relay closed with 4001: this group no longer exists.
    Removed,
    /// The relay closed the socket, or the stream simply ended.
    Closed,
    /// The connection, the upgrade or a write failed — or a keepalive went unanswered, which is
    /// a socket that died without saying so.
    Failed,
    /// The socket reached `live`'s age limit and was replaced on purpose.
    Aged,
    /// **This device is no longer in the group the socket was opened for** — it left, it was
    /// removed and has since learned so, or it is in another group now — and the loop let go of
    /// the socket itself. [`let_go`] is the test; nothing failed.
    Left,
}

/// What a look at this device's own `sync_group` found, for a loop that is holding a socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Membership<'a> {
    /// The look could not be taken — the connection was busy past the wait, or the read failed.
    Unknown,
    /// In no group.
    Nowhere,
    /// In the group with this id.
    In(&'a str),
}

/// Whether a socket opened for `socket_group` should be let go of, given what the device's
/// membership is now.
///
/// **A socket belongs to a group, and the loop used to ask which group only between sockets.**
/// The Durable Object a socket reaches is its group's, so a device that left, or left and joined
/// another, went on holding the *old* group's doorbell for as long as that socket lived — up to
/// its twelve hours — reading `live`, and deaf to the group it was actually in. Every host,
/// since the socket was built.
///
/// **`Unknown` keeps the socket.** A look that could not be taken proves nothing, and a socket
/// dropped on a busy connection is a reconnect for no reason; the loop looks again at the next
/// commit and at every keepalive, so a missed look is late by one ping period at most.
pub fn let_go(socket_group: &str, now: Membership<'_>) -> bool {
    match now {
        Membership::Unknown => false,
        Membership::Nowhere => true,
        Membership::In(group) => group != socket_group,
    }
}

/// What a close with the relay's 4001 was, given the device's membership **once any sync
/// operation in flight has finished**.
///
/// The relay closes with 4001 for a group that is gone and — since it tells a removed device —
/// for a device a rotation's manifest no longer names. **A device that leaves a group publishes
/// exactly such a manifest**, so its own *Leave group* closes its own socket, a moment before
/// the press has cleared `sync_group` locally. Read at once, that is a removal: a backoff, the
/// word `offline` and an `error_log` row, for something the reader just chose. So the loop asks
/// behind the sync lane, which the leave holds until its last write: by then the group is gone
/// from this device and the close is [`Disconnect::Left`], which is quiet. A device somebody
/// else removed is still in the group as far as it knows, and that is [`Disconnect::Removed`].
pub fn closed_as_gone(socket_group: &str, now: Membership<'_>) -> Disconnect {
    if let_go(socket_group, now) {
        Disconnect::Left
    } else {
        Disconnect::Removed
    }
}

/// Whether the loop waits before reconnecting after `cause`.
///
/// **`Removed` is on the waiting side, and that is most of why this function exists.** "We have
/// been removed, so there is nothing to back off from" assumes local state has already caught up
/// with the close frame — nothing is cleared by a close, so a device that reconnects at once is
/// told 4001 again and spins against the one endpoint, which is the thundering herd
/// [`backoff_ms`]'s jitter exists to break arriving by a different road.
pub fn deserves_backoff(cause: Disconnect) -> bool {
    match cause {
        Disconnect::Removed | Disconnect::Closed | Disconnect::Failed => true,
        // Not a failure: the age limit is a socket replaced deliberately. Making it wait
        // punishes the healthy case.
        Disconnect::Aged => false,
        // Not a failure either, and the wait would be the bug: a device that has just joined
        // another group is owed that group's socket now, and one in no group is owed the word
        // `off` now — not a second of `offline` first, which is the word for a broken sync.
        // It cannot spin: the loop dials only for a device that is in a group, and a socket it
        // then opens is for that group, which is not one to let go of.
        Disconnect::Left => false,
    }
}

/// How long a socket must have lived for a failure to be forgiven.
///
/// [`BACKOFF_MAX_MS`], reused deliberately rather than given a number of its own: a socket that
/// stayed up longer than the longest wait this ladder can produce has demonstrated the endpoint
/// works, and anything shorter is inside the window a bad connection spends flapping.
const FORGIVEN_AFTER_MS: u64 = BACKOFF_MAX_MS;

/// The reconnect counter after a socket ended for `cause`, having lived `socket_lifetime_ms`.
///
/// **The counter measures the endpoint's health, not the process's lifetime**, which is the
/// defect it was written for. With every real socket death counted and none ever forgiven, a
/// device that works for three hours and then blips comes back one rung up the ladder; seven
/// blips over a long session put it at the cap, so the eighth costs a minute of `Offline`
/// before a reconnect that would have succeeded instantly.
///
/// ⚠️ **Forgiveness is bought by a long-lived socket and never by reaching `Live`.** Resetting
/// on a successful upgrade looks equivalent and is not: a relay that accepts the upgrade and
/// then closes 4001 would zero the counter every cycle, which is exactly the spin
/// [`deserves_backoff`] exists to prevent.
pub fn next_attempt(attempt: u32, cause: Disconnect, socket_lifetime_ms: u64) -> u32 {
    match cause {
        // Evidence of nothing, so the count is left exactly as it was: a socket retired at its
        // age limit has not failed at all — and neither has one the loop let go of because its
        // device changed groups. Unchanged also means no `error_log` row: `live` writes one only
        // for an attempt that was spent.
        Disconnect::Aged | Disconnect::Left => attempt,
        // **Never forgiven by lifetime.** A group that is gone is gone however long this socket
        // had been up, and the reconnect that follows will be refused the same way.
        Disconnect::Removed => attempt.saturating_add(1),
        Disconnect::Closed | Disconnect::Failed => {
            if socket_lifetime_ms >= FORGIVEN_AFTER_MS {
                0
            } else {
                attempt.saturating_add(1)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_ahead_of_the_cursor_schedules_a_trip() {
        let mut s = Scheduler::new();
        s.wake(Wake::Frame { cursor: 5 }, 1_000, 3);
        assert_eq!(s.due_at(), Some(1_000 + FRAME_DEBOUNCE_MS));
    }

    #[test]
    fn a_frame_at_or_behind_the_cursor_schedules_nothing() {
        let mut s = Scheduler::new();
        s.wake(Wake::Frame { cursor: 3 }, 1_000, 3);
        assert_eq!(s.due_at(), None);
        s.wake(Wake::Frame { cursor: 2 }, 1_000, 3);
        assert_eq!(s.due_at(), None);
    }

    #[test]
    fn a_burst_of_frames_coalesces_into_one_trip() {
        // 250 pushes from a bulk import must cost the peer one round trip, not 250.
        let mut s = Scheduler::new();
        for i in 0..250 {
            s.wake(Wake::Frame { cursor: 10 + i }, 1_000 + i as u64, 3);
        }
        let due = s.due_at().expect("a trip is scheduled");
        assert!(!s.take_due(due - 1), "not due before its deadline");
        assert!(s.take_due(due), "due at its deadline");
        assert_eq!(s.due_at(), None, "one trip, not two hundred and fifty");
    }

    #[test]
    fn a_local_write_debounces_on_quiet_and_the_window_slides() {
        let mut s = Scheduler::new();
        s.wake(Wake::LocalWrite, 1_000, 0);
        assert_eq!(s.due_at(), Some(1_000 + WRITE_DEBOUNCE_MS));
        // A second write before the window closes pushes the deadline out — a long import
        // must not fire a push while it is still writing.
        s.wake(Wake::LocalWrite, 1_500, 0);
        assert_eq!(s.due_at(), Some(1_500 + WRITE_DEBOUNCE_MS));
    }

    #[test]
    // Both sides are `const`, so clippy sees a compile-time-decidable comparison and would
    // rather it were a `const` assertion — but this is a runtime test like its siblings,
    // asserting a relationship between the two debounces that a future edit could still get
    // backwards.
    #[allow(clippy::assertions_on_constants)]
    fn a_write_debounce_is_shorter_than_nothing_and_longer_than_a_frame() {
        // The frame debounce only coalesces a burst that has already happened; the write
        // debounce waits for a human to stop typing.
        assert!(FRAME_DEBOUNCE_MS < WRITE_DEBOUNCE_MS);
    }

    /// The dial's bound sits where its doc says: past a slow network, short of the keepalive —
    /// a dial that outlasted a ping period would be a socket the keepalive could never have
    /// found dead in time either.
    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn a_dial_is_given_longer_than_a_slow_network_and_less_than_a_ping_period() {
        assert!(CONNECT_SECS >= 10);
        assert!(CONNECT_SECS < PING_SECS);
    }

    #[test]
    fn launch_and_reconnect_are_immediate() {
        for wake in [Wake::Launch, Wake::Reconnect] {
            let mut s = Scheduler::new();
            s.wake(wake, 9_000, 0);
            assert_eq!(s.due_at(), Some(9_000), "no debounce on a catch-up");
        }
    }

    #[test]
    fn an_immediate_wake_wins_over_a_pending_debounce() {
        let mut s = Scheduler::new();
        s.wake(Wake::LocalWrite, 1_000, 0);
        s.wake(Wake::Reconnect, 1_100, 0);
        assert_eq!(
            s.due_at(),
            Some(1_100),
            "the sooner deadline is the one that holds"
        );
    }

    #[test]
    fn a_debounce_never_moves_a_sooner_deadline_later() {
        let mut s = Scheduler::new();
        s.wake(Wake::Reconnect, 1_000, 0);
        s.wake(Wake::Frame { cursor: 9 }, 1_000, 0);
        assert_eq!(s.due_at(), Some(1_000));
    }

    #[test]
    fn a_local_write_does_not_delay_a_pending_catch_up() {
        // The sliding write window slides only against *itself*. Someone typing while a
        // reconnect is owed must not hold the reconnect back — a device that came online
        // with a backlog would sit on it for as long as the typing lasted.
        let mut s = Scheduler::new();
        s.wake(Wake::Reconnect, 1_000, 0);
        s.wake(Wake::LocalWrite, 1_100, 0);
        assert_eq!(s.due_at(), Some(1_000));
    }

    #[test]
    fn nothing_runs_while_a_trip_is_in_flight() {
        let mut s = Scheduler::new();
        s.wake(Wake::Launch, 1_000, 0);
        assert!(s.take_due(1_000));
        s.started();
        s.wake(Wake::Frame { cursor: 7 }, 1_100, 0);
        assert!(
            !s.take_due(9_999),
            "single flight: no second trip until this one finishes"
        );
        s.finished();
        assert!(
            s.take_due(9_999),
            "the wake that arrived mid-trip is not lost"
        );
    }

    #[test]
    fn a_removal_backs_off_and_spends_an_attempt() {
        assert!(deserves_backoff(Disconnect::Removed));
        assert_eq!(next_attempt(2, Disconnect::Removed, 0), 3);
        // However long the socket had been up. Forgiving a 4001 on lifetime would let a relay
        // that accepts the upgrade and immediately closes zero the counter every cycle.
        assert_eq!(next_attempt(2, Disconnect::Removed, 10 * BACKOFF_MAX_MS), 3);
    }

    #[test]
    fn the_age_limit_neither_backs_off_nor_spends_an_attempt() {
        assert!(!deserves_backoff(Disconnect::Aged));
        // Twelve hours, which is `live::SOCKET_MAX_AGE`.
        assert_eq!(next_attempt(4, Disconnect::Aged, 12 * 60 * 60 * 1_000), 4);
    }

    /// **A socket is let go of when its device is in no group, or in another one** — and kept
    /// when it is in the same group, or when nobody could look.
    #[test]
    fn a_socket_is_let_go_of_when_its_device_is_no_longer_in_its_group() {
        assert!(let_go("g1", Membership::Nowhere), "it left");
        assert!(let_go("g1", Membership::In("g2")), "it is in another group");
        assert!(!let_go("g1", Membership::In("g1")), "it is where it was");
        // A look that could not be taken is not a departure: dropping a healthy socket because
        // the connection was busy would be a reconnect for nothing.
        assert!(!let_go("g1", Membership::Unknown));
        // Ids are compared whole: a prefix is another group.
        assert!(let_go("g1", Membership::In("g10")));
    }

    /// **Letting go is not a failure**: no wait before the loop looks again, the attempt count
    /// where it was — whatever it was and however long the socket lived — and so no row.
    #[test]
    fn letting_go_neither_backs_off_nor_spends_an_attempt() {
        assert!(!deserves_backoff(Disconnect::Left));
        for attempt in [0, 3, u32::MAX] {
            assert_eq!(next_attempt(attempt, Disconnect::Left, 0), attempt);
            assert_eq!(
                next_attempt(attempt, Disconnect::Left, 10 * BACKOFF_MAX_MS),
                attempt,
                "neither spent nor forgiven: the endpoint has shown nothing"
            );
        }
    }

    /// **The relay's 4001 is a removal for a device that still thinks it is in the group, and
    /// its own doing for one that has left** — the leave's own manifest is what closed it.
    #[test]
    fn a_4001_is_a_removal_unless_the_device_has_already_left() {
        assert_eq!(
            closed_as_gone("g1", Membership::In("g1")),
            Disconnect::Removed
        );
        assert_eq!(closed_as_gone("g1", Membership::Nowhere), Disconnect::Left);
        assert_eq!(closed_as_gone("g1", Membership::In("g2")), Disconnect::Left);
        // Could not look: the cautious reading, which backs off and writes the row.
        assert_eq!(
            closed_as_gone("g1", Membership::Unknown),
            Disconnect::Removed
        );
    }

    #[test]
    fn a_long_lived_socket_forgives_the_whole_run_of_failures() {
        // The counter is about the endpoint, not the process. A device that worked for an hour
        // and then blipped must come back at the bottom rung, not a minute later.
        for cause in [Disconnect::Closed, Disconnect::Failed] {
            assert!(
                deserves_backoff(cause),
                "{cause:?} still waits before reconnecting"
            );
            assert_eq!(next_attempt(6, cause, FORGIVEN_AFTER_MS), 0);
            assert_eq!(next_attempt(6, cause, 60 * 60 * 1_000), 0);
        }
    }

    #[test]
    fn a_short_lived_socket_climbs_the_ladder() {
        for cause in [Disconnect::Closed, Disconnect::Failed] {
            assert_eq!(next_attempt(0, cause, 0), 1);
            assert_eq!(next_attempt(1, cause, FORGIVEN_AFTER_MS - 1), 2);
        }
        // And the climb is what the next wait is measured against.
        assert!(
            backoff_ms(next_attempt(1, Disconnect::Failed, 0), 0.0) > backoff_ms(1, 0.0),
            "a second consecutive failure waits longer than the first"
        );
    }

    #[test]
    fn the_attempt_counter_cannot_overflow() {
        assert_eq!(next_attempt(u32::MAX, Disconnect::Removed, 0), u32::MAX);
        assert_eq!(next_attempt(u32::MAX, Disconnect::Failed, 0), u32::MAX);
    }

    #[test]
    fn backoff_grows_and_is_capped_and_jittered() {
        assert!(backoff_ms(0, 0.0) < backoff_ms(1, 0.0));
        assert!(backoff_ms(1, 0.0) < backoff_ms(4, 0.0));
        assert_eq!(
            backoff_ms(40, 0.0),
            backoff_ms(41, 0.0),
            "capped, not overflowing"
        );
        // Jitter matters because Cloudflare restarts servers: every group's socket drops in
        // the same instant, and an unjittered backoff reconnects them all together.
        assert_ne!(backoff_ms(3, 0.0), backoff_ms(3, 0.9));
        assert!(backoff_ms(3, 0.9) > backoff_ms(3, 0.0));
    }
}
