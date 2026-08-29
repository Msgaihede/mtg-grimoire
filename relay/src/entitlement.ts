/**
 * Who is entitled to the hosted relay, as one pure function over a Patreon `patron_status`.
 *
 * **Why this is its own module rather than a branch inside the webhook handler.** The same
 * question is asked from three places that share nothing else: the OAuth callback when a reader
 * first links their account, the webhook when Patreon tells us a membership changed, and the
 * daily reconciliation that re-reads every row in case a webhook was never delivered. Three
 * copies of a seven-day window is three places for it to be six days, and the one that drifts
 * would be the one nobody drives by hand. So the decision lives here, the three callers supply
 * `nowMs` and the row's stored `graceUntil`, and each writes back what it is handed.
 *
 * **Nothing here touches D1, and that is the point.** `decide` cannot read the clock and cannot
 * read a row; it is a function of its three arguments, which is what makes the boundary case
 * — the exact instant a window closes — a test rather than a thing you find out about six
 * months later from a reader who lost their log.
 */

/**
 * What a subject is allowed to do. `active` and `grace` both serve; `dead` does not.
 *
 * **`grace` is a state the relay serves from and not merely a label on a dying row.** A reader
 * inside the window syncs exactly as they did the day before — the distinction exists so the
 * *app* can say something, not so the relay can start refusing.
 */
export type Status = "active" | "grace" | "dead";

/**
 * The decision, and the `graceUntil` the caller must persist alongside it.
 *
 * **`graceUntil` is returned even when it is unchanged**, so a caller writes the field
 * unconditionally rather than deciding for itself when to. A caller that skipped the write on
 * some statuses would be re-implementing half of this function at the call site, which is the
 * duplication the module exists to prevent.
 */
export interface Decision {
  status: Status;
  graceUntil: number | null;
}

/** Seven days, as milliseconds. §7.2's window, written once. */
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `patronStatus` is Patreon's string, straight off the member object, and it is typed as
 * `string` rather than a union because it *is* a string on the wire: Patreon can add a value
 * tomorrow without asking, and a union would only mean the unknown value arrived here as a lie.
 *
 * `graceUntil` is what the stored row already holds — `null` for a subject who has never been
 * in a window.
 */
export function decide(
  patronStatus: string | null,
  nowMs: number,
  graceUntil: number | null,
): Decision {
  switch (patronStatus) {
    case "active_patron":
      // The reprieve is total. A reader whose card was declined and then went through is
      // returned to `active` with the window *erased*, not paused at whatever was left of it —
      // a stored `graceUntil` that outlived the decline that opened it would come back to
      // life the next time the card failed, and hand them a window that was already half spent.
      return { status: "active", graceUntil: null };

    case "declined_patron": {
      // A declined card is a **failed payment that Patreon retries**, not a cancellation the
      // reader chose. Deleting their relay log over an expired card would punish them for
      // something they did not decide, so a decline opens a window instead of killing at once.
      //
      // The window opens **once**: an existing deadline is kept and only a subject who has
      // never been in a window gets a fresh one. Patreon can fire this webhook several times
      // over one retry cycle and the daily reconciliation asks again every day, so a branch
      // that always wrote `nowMs + GRACE_MS` would push the deadline forward on every sighting
      // and never arrive — an unbounded window, which is the same as no window.
      //
      // **The guard is `> 0` and not `??`, and the difference is a reader's log.** `0` is not
      // nullish, so `??` would keep it as the deadline, and `nowMs > 0` holds for every real
      // clock — a stored zero reads as a window that closed in 1970 and kills a declined
      // subject on sight instead of giving them their seven days. `decide` never emits `0`,
      // but `schema.sql` lets the column hold one and a caller spelling
      // `decision.graceUntil ?? 0` writes it. Guarded here *and* `CHECK`ed there: either alone
      // is one typo away from a silent revocation, and the typo is on the side that is not
      // this file.
      const deadline = graceUntil && graceUntil > 0 ? graceUntil : nowMs + GRACE_MS;

      // `>` and not `>=`: the deadline instant is the last one *inside* the window. The
      // difference is one millisecond and it is worth being deliberate about, because the
      // comparison that runs is whichever one the cron pass happens to land on.
      if (nowMs > deadline) return { status: "dead", graceUntil: null };
      return { status: "grace", graceUntil: deadline };
    }

    default:
      // **The fail-closed branch, and it must not be omitted.** `former_patron` is a
      // cancellation — the reader's own decision, so no window is owed — and everything else
      // that reaches here is a value this code has never seen. An unrecognised status that
      // fell through to `active` would be a free subscription that lasts until someone
      // notices, which is to say forever. Dying on an unknown string is visible within a day;
      // serving on one is not visible at all.
      return { status: "dead", graceUntil: null };
  }
}
