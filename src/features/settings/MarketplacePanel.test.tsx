import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MARKETPLACES } from "@/lib/marketplace";
import type { MarketplaceState } from "@/lib/useMarketplace";
import { MarketplacePanel } from "./MarketplacePanel";

const state = (over: Partial<MarketplaceState> = {}): MarketplaceState => ({
  marketplace: MARKETPLACES.tcgplayer,
  currency: "usd",
  select: vi.fn(),
  selecting: false,
  error: null,
  ...over,
});

const panel = () => screen.getByRole("region", { name: "Prices" });
const row = (name: string) => within(panel()).getByRole("button", { name });

/** The three with no feed in this build, by the accessible name each row carries. */
const UNPRICED = ["Card Kingdom USD", "Mana Pool USD", "Card trader EUR"];
/** In picker order, which is the order a keyboard reader walks. */
const ALL = ["TCGplayer USD", "Cardmarket EUR", ...UNPRICED];

describe("MarketplacePanel", () => {
  /**
   * The one question this panel answers. `aria-pressed` rather than a class, because "which
   * one is on" has to reach a reader who cannot see the gold border or the check.
   */
  it("marks the marketplace in use, and moves the mark when it changes", () => {
    const { rerender } = render(<MarketplacePanel marketplace={state()} />);

    expect(row("TCGplayer USD")).toHaveAttribute("aria-pressed", "true");
    expect(row("Cardmarket EUR")).toHaveAttribute("aria-pressed", "false");

    rerender(
      <MarketplacePanel
        marketplace={state({ marketplace: MARKETPLACES.cardmarket, currency: "eur" })}
      />,
    );

    expect(row("TCGplayer USD")).toHaveAttribute("aria-pressed", "false");
    expect(row("Cardmarket EUR")).toHaveAttribute("aria-pressed", "true");
  });

  it("lists all five with the currency each quotes in", () => {
    render(<MarketplacePanel marketplace={state()} />);

    expect(
      within(panel())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toHaveLength(5);
    for (const name of ALL) expect(row(name)).toBeInTheDocument();
  });

  it("selects a marketplace it can quote", async () => {
    const select = vi.fn();
    render(<MarketplacePanel marketplace={state({ select })} />);

    await userEvent.click(row("Cardmarket EUR"));

    expect(select).toHaveBeenCalledExactlyOnceWith("cardmarket");
  });

  /**
   * **`aria-disabled`, never the attribute.** The `disabled` half of this is the part worth
   * asserting: a `disabled` button leaves the tab order, and these three carry the sentence
   * that says why they are out — so greying them with the attribute would hide the explanation
   * from exactly the reader who cannot see that they are greyed.
   */
  it("offers the three with no feed as aria-disabled and never as disabled", async () => {
    const select = vi.fn();
    render(<MarketplacePanel marketplace={state({ select })} />);

    for (const name of UNPRICED) {
      expect(row(name)).toHaveAttribute("aria-disabled", "true");
      expect(row(name)).not.toBeDisabled();
      expect(row(name)).not.toHaveAttribute("disabled");
      await userEvent.click(row(name));
    }

    expect(select).not.toHaveBeenCalled();
    // And the two that work are marked as reachable, not merely left unmarked.
    for (const name of ["TCGplayer USD", "Cardmarket EUR"]) {
      expect(row(name)).not.toHaveAttribute("aria-disabled");
    }
  });

  /**
   * Each one says why in its own words. A row that only greyed would leave a reader guessing
   * between "the app is broken", "I need to sync" and "this marketplace is gone".
   */
  it("has every unreachable row explain itself, by name", () => {
    render(<MarketplacePanel marketplace={state()} />);

    for (const name of UNPRICED) {
      const label = name.replace(/ (USD|EUR)$/, "");
      expect(row(name)).toHaveAccessibleDescription(
        `No price feed yet — ${label} prices are not in the card data this app syncs.`,
      );
    }
    // The two that work describe nothing: there is nothing to excuse.
    expect(row("TCGplayer USD")).not.toHaveAccessibleDescription();
  });

  /**
   * The reason the rule exists, asserted directly.
   *
   * Walked with the keyboard rather than by reading `disabled` off each node — a tab order is
   * a property of the document, and `user.tab()` is the only thing here that computes one.
   */
  it("keeps all five rows in the tab order", async () => {
    const user = userEvent.setup();
    render(<MarketplacePanel marketplace={state()} />);

    const reached: (string | null)[] = [];
    for (let i = 0; i < ALL.length; i++) {
      await user.tab();
      reached.push(document.activeElement?.getAttribute("aria-labelledby") ?? null);
    }

    expect(reached.map((ids) => ids !== null)).toEqual(ALL.map(() => true));
    expect(new Set(reached).size).toBe(ALL.length);
    // The last one walked to is the last one drawn, so nothing was skipped on the way.
    expect(document.activeElement).toBe(row("Card trader EUR"));
  });

  /** A refused write has to be sayable — the panel's only failure state. */
  it("reports a refused choice", () => {
    render(
      <MarketplacePanel
        marketplace={state({ error: "The card database is busy. Try that again in a moment." })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The card database is busy.");
  });
});
