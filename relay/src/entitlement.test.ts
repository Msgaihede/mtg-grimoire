import { describe, expect, it } from "vitest";
import { decide, GRACE_MS } from "./entitlement";

const NOW = 1_756_000_000_000;

describe("decide", () => {
  it("makes an active patron active and clears any grace they were in", () => {
    // The reprieve: a reader whose card was declined and then went through must come all the
    // way back, not merely stop counting down.
    expect(decide("active_patron", NOW, NOW + 1000)).toEqual({
      status: "active",
      graceUntil: null,
    });
  });

  it("opens a seven-day window the first time a card is declined", () => {
    expect(decide("declined_patron", NOW, null)).toEqual({
      status: "grace",
      graceUntil: NOW + GRACE_MS,
    });
  });

  it("keeps the original deadline when a decline is seen again", () => {
    // Re-extending on every webhook or every cron pass would make the window unbounded, which
    // is the same as having no window.
    const opened = NOW - 2 * 24 * 60 * 60 * 1000;

    expect(decide("declined_patron", NOW, opened + GRACE_MS)).toEqual({
      status: "grace",
      graceUntil: opened + GRACE_MS,
    });
  });

  it.each([[0], [-1]])(
    "opens a fresh window when the stored deadline is %d rather than a real instant",
    (stored) => {
      // `0` is not nullish, so a `??` guard keeps it, and `nowMs > 0` holds for every real
      // clock — the reader's card is declined and they are killed on sight instead of given
      // their seven days. `decide` never writes a zero, but `schema.sql` lets the column hold
      // one and a caller spelling `decision.graceUntil ?? 0` puts it there.
      //
      // `-1` is here so the `> 0` half of the guard is not vacuous: a guard written as plain
      // truthiness would pass the zero case and still take a negative as a deadline.
      expect(decide("declined_patron", NOW, stored)).toEqual({
        status: "grace",
        graceUntil: NOW + GRACE_MS,
      });
    },
  );

  it("kills a decline once the window has passed", () => {
    expect(decide("declined_patron", NOW, NOW - 1)).toEqual({ status: "dead", graceUntil: null });
  });

  it("still holds at the exact instant the window ends", () => {
    expect(decide("declined_patron", NOW, NOW).status).toBe("grace");
  });

  it.each([["former_patron"], [null], ["something_patreon_added_later"], [""]])(
    "kills %j at once, with no grace",
    (status) => {
      // A cancellation is the reader's own decision, and an unrecognised value must fail
      // closed: an unknown string that read as active would be a free subscription forever.
      expect(decide(status, NOW, NOW + GRACE_MS)).toEqual({ status: "dead", graceUntil: null });
    },
  );

  it("is seven days", () => {
    expect(GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
