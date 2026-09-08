import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { CUT_CARDS_NOTE, PriceStrip } from "./PriceStrip";

/**
 * The strip's two standing sentences, and which decks and lists each is true of.
 *
 * **The tray is deliberately not exercised here.** It exists only for the length of a drag, it is
 * `aria-hidden` chrome for a gesture only a pointer can make, and driving a dnd-kit drop is
 * `views.test.tsx`' work with the machinery it already has. What this file is about is the half of
 * the component that is always on screen: a price is never shown without saying how old it is
 * (spec §5), and a promise about where cut copies *go* must be true of the deck making it.
 *
 * `variant === "live"` was the whole of that second test until 2026-09-08 (issue #401), when a
 * Virtual deck gave the app a live list with no cardboard behind it — so the two conditions below
 * are ANDed, and neither implies the other.
 */
describe("PriceStrip", () => {
  const strip = (over: Partial<Parameters<typeof PriceStrip>[0]> = {}) =>
    render(
      <PriceStrip
        marketplace={MARKETPLACES.tcgplayer}
        variant="live"
        tracksCollection
        onRemove={vi.fn()}
        {...over}
      />,
    );

  /** Spec §5, said once at the foot of the deck rather than on sixty tooltips — and true of
   *  every deck, virtual ones included: a price is a fact about the number, not a binder. */
  it("says how old the prices are, and whose, on every kind of deck", () => {
    strip();
    expect(
      screen.getByText(pricesAsOf(MARKETPLACES.tcgplayer), { exact: false }),
    ).toBeInTheDocument();

    strip({ variant: "theory", tracksCollection: false });
    expect(
      screen.getAllByText(pricesAsOf(MARKETPLACES.tcgplayer), { exact: false }).length,
    ).toBeGreaterThan(1);
  });

  /** The ordinary deck on its Actual list — the one arrangement the sentence is true of, and the
   *  regression the two absences below are only meaningful against. */
  it("promises the Actual list's cuts to Recently removed", () => {
    strip();

    expect(screen.getByText(CUT_CARDS_NOTE)).toBeInTheDocument();
  });

  /** The plan holds no copies, so a cut has nothing to give back — the older of the two absences,
   *  asserted here so that the newer one cannot be mistaken for it. */
  it("says nothing about cuts on the theory list", () => {
    strip({ variant: "theory" });

    expect(screen.queryByText(CUT_CARDS_NOTE)).not.toBeInTheDocument();
  });

  /**
   * **A Virtual deck's list is a `live` list, so the old test would pass it.** Its rows are backed
   * by no collection row in any group, so a cut files nothing anywhere and the sentence would be a
   * promise about a folder nothing will arrive in — which is the one kind of wrong this line
   * cannot be, because a reader cannot check it from the deck screen.
   *
   * `variant` stays `"live"` on purpose: with `"theory"` the sentence is already absent for the
   * case above, and the test would pass over a `tracksCollection` that reached nothing.
   */
  it("says nothing about cuts on a deck that does not track a collection", () => {
    strip({ tracksCollection: false });

    expect(screen.queryByText(CUT_CARDS_NOTE)).not.toBeInTheDocument();
    // …and the line itself is still there, so this is one sentence gone rather than the strip.
    expect(
      screen.getByText(pricesAsOf(MARKETPLACES.tcgplayer), { exact: false }),
    ).toBeInTheDocument();
  });
});
