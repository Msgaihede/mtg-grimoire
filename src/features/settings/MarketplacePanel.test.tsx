import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MARKETPLACES, type MarketplaceId } from "@/lib/marketplace";
import type { FeedInfo, FeedState, MarketplaceState } from "@/lib/useMarketplace";
import { MarketplacePanel } from "./MarketplacePanel";

/** A fixed instant the notes are read against, so "2 hours ago" is a fact rather than a race
 *  against the clock. Both feeds below are stamped relative to it. */
const NOW = Math.floor(Date.now() / 1000);

function feed(id: MarketplaceId, state: FeedState, over: Partial<FeedInfo> = {}): FeedInfo {
  return {
    marketplace: MARKETPLACES[id],
    state,
    status: {
      marketplace: id,
      fetchedAt: state === "never" ? null : NOW - 7_200,
      feedBuiltAt: id === "cardkingdom" ? "2026-08-11 21:07:02" : null,
      // `null` and not `0` for a feed never fetched — the two are different states.
      rowCount: state === "never" ? null : 149_989,
      stale: state === "never" || state === "stale",
      refreshing: state === "fetching",
      reachable: true,
    },
    error: null,
    reachable: true,
    ...over,
  };
}

/**
 * Mana Pool as a browser's engine answers it: a feed this host cannot ask, so never fetched and
 * never going to be. `reachable` is the host's own answer — nothing in the panel works it out.
 */
const UNREACHABLE = (() => {
  const never = feed("manapool", "never");
  return { ...never, status: { ...never.status!, reachable: false }, reachable: false };
})();

const state = (over: Partial<MarketplaceState> = {}): MarketplaceState => ({
  marketplace: MARKETPLACES.tcgplayer,
  stored: MARKETPLACES.tcgplayer,
  currency: "usd",
  select: vi.fn(),
  selecting: false,
  error: null,
  feeds: [feed("cardkingdom", "fresh"), feed("manapool", "fresh")],
  feed: null,
  refresh: vi.fn(),
  refreshing: null,
  progress: null,
  ...over,
});

const panel = () => screen.getByRole("region", { name: "Prices" });
const row = (name: string) => within(panel()).getByRole("button", { name });

/** The one with nothing to sync in this build: Card trader's API needs a per-user JWT and
 *  publishes no bulk price list. */
const UNPRICED = ["Card trader EUR"];
/** In picker order, which is the order a keyboard reader walks. */
const ALL = ["TCGplayer USD", "Cardmarket EUR", "Card Kingdom USD", "Mana Pool USD", ...UNPRICED];
/** The two whose prices are downloaded, and therefore the two with a state to draw. */
const FEEDS: MarketplaceId[] = ["cardkingdom", "manapool"];

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

    for (const name of ALL) expect(row(name)).toBeInTheDocument();
    // Five rows and two refresh buttons — the refresh is offered only where there is a feed to
    // fetch, which is the whole of what tells a downloaded marketplace from a synced one.
    expect(within(panel()).getAllByRole("button")).toHaveLength(ALL.length + FEEDS.length);
  });

  /**
   * **All four priced ones are selectable**, which is the assertion that fails the day someone
   * flips `priced` without wiring a feed — or wires one and forgets to flip it.
   */
  it("selects any of the four it can quote", async () => {
    const select = vi.fn();
    render(<MarketplacePanel marketplace={state({ select })} />);

    await userEvent.click(row("Cardmarket EUR"));
    await userEvent.click(row("Card Kingdom USD"));
    await userEvent.click(row("Mana Pool USD"));

    expect(select.mock.calls).toEqual([["cardmarket"], ["cardkingdom"], ["manapool"]]);
  });

  /**
   * **`aria-disabled`, never the attribute.** The `disabled` half of this is the part worth
   * asserting: a `disabled` button leaves the tab order, and the row carries the sentence that
   * says why it is out — so greying it with the attribute would hide the explanation from
   * exactly the reader who cannot see that it is greyed.
   */
  it("offers the one with no feed as aria-disabled and never as disabled", async () => {
    const select = vi.fn();
    render(<MarketplacePanel marketplace={state({ select })} />);

    for (const name of UNPRICED) {
      expect(row(name)).toHaveAttribute("aria-disabled", "true");
      expect(row(name)).not.toBeDisabled();
      expect(row(name)).not.toHaveAttribute("disabled");
      await userEvent.click(row(name));
    }

    expect(select).not.toHaveBeenCalled();
    // And the four that work are marked as reachable, not merely left unmarked.
    for (const name of ALL.filter((n) => !UNPRICED.includes(n))) {
      expect(row(name)).not.toHaveAttribute("aria-disabled");
    }
  });

  /**
   * The unreachable row says why in its own words. A row that only greyed would leave a reader
   * guessing between "the app is broken", "I need to sync" and "this marketplace is gone".
   */
  it("has the unreachable row explain itself, by name", () => {
    render(<MarketplacePanel marketplace={state()} />);

    expect(row("Card trader EUR")).toHaveAccessibleDescription(/No price feed\. Card trader doesn.t publish/);
    // A marketplace whose prices arrive with the card data describes nothing: there is nothing
    // to excuse and no feed to date.
    expect(row("TCGplayer USD")).not.toHaveAccessibleDescription();
  });

  /**
   * **When a downloaded feed's prices were pulled, on the row they belong to.**
   *
   * The date is what tells a reader whether to believe the numbers everywhere else in the
   * window, and it belongs to the *feed* rather than to the last card sync — which is why
   * TCGplayer, whose prices ride in with the corpus, has no such line at all.
   */
  it("says when each downloaded feed was last pulled", () => {
    render(<MarketplacePanel marketplace={state()} />);

    expect(row("Card Kingdom USD")).toHaveAccessibleDescription(/Prices from 2 hours ago\./);
    expect(row("Mana Pool USD")).toHaveAccessibleDescription(/Prices from 2 hours ago\./);
  });

  /**
   * **Card Kingdom's own build stamp, and Mana Pool's absence of one.**
   *
   * Two dates answering two questions: when this app asked, and when the marketplace last
   * rebuilt its list. Mana Pool publishes no stamp anywhere in its response, so `null` there is
   * an absence rather than a value to invent out of `fetchedAt`.
   */
  it("shows the feed's own build stamp where it publishes one, and nothing where it does not", () => {
    render(<MarketplacePanel marketplace={state()} />);

    expect(row("Card Kingdom USD")).toHaveAccessibleDescription(/Published by Card Kingdom on 2026-08-11/);
    expect(row("Mana Pool USD")).not.toHaveAccessibleDescription(/Published by/);
  });

  /** Never fetched is the state a first selection acts on, and it says what will happen. */
  it("says a feed with no prices has none yet", () => {
    render(
      <MarketplacePanel
        marketplace={state({ feeds: [feed("cardkingdom", "never"), feed("manapool", "fresh")] })}
      />,
    );

    expect(row("Card Kingdom USD")).toHaveAccessibleDescription(/No prices yet/);
  });

  it("says a feed is downloading while it is", () => {
    render(
      <MarketplacePanel
        marketplace={state({
          feeds: [feed("cardkingdom", "fetching"), feed("manapool", "fresh")],
          refreshing: "cardkingdom",
        })}
      />,
    );

    expect(row("Card Kingdom USD")).toHaveAccessibleDescription(/Downloading the price list/);
    // The control that would start a second one is out of reach — `aria-disabled`, so it keeps
    // its place in the tab order like every other greyed control in this window.
    expect(
      within(panel()).getByRole("button", { name: "Refresh Card Kingdom prices" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("says a feed is due a refresh once its prices are a day old", () => {
    render(
      <MarketplacePanel
        marketplace={state({ feeds: [feed("cardkingdom", "stale"), feed("manapool", "fresh")] })}
      />,
    );

    expect(row("Card Kingdom USD")).toHaveAccessibleDescription(/Update due\./);
  });

  /**
   * **A failed fetch leaves the previous prices in place**, and the note must say so rather
   * than imply the table is now empty — that is the whole reason the backend refuses a feed
   * that parsed to zero rows instead of writing it.
   */
  it("says a failed download is still showing the prices it already had", () => {
    render(
      <MarketplacePanel
        marketplace={state({
          feeds: [
            feed("cardkingdom", "failed", { error: "Card Kingdom's price feed timed out." }),
            feed("manapool", "fresh"),
          ],
        })}
      />,
    );

    expect(row("Card Kingdom USD")).toHaveAccessibleDescription(
      /Download failed\. Showing prices from 2 hours ago\./,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("timed out");
  });

  it("refreshes the feed whose button was pressed", async () => {
    const refresh = vi.fn();
    render(<MarketplacePanel marketplace={state({ refresh })} />);

    await userEvent.click(
      within(panel()).getByRole("button", { name: "Refresh Mana Pool prices" }),
    );

    expect(refresh).toHaveBeenCalledExactlyOnceWith("manapool");
  });

  /**
   * The reason the `aria-disabled` rule exists, asserted directly.
   *
   * Walked with the keyboard rather than by reading `disabled` off each node — a tab order is
   * a property of the document, and `user.tab()` is the only thing here that computes one. The
   * two refresh buttons are stops of their own, each after the row it belongs to.
   */
  it("keeps every row and every refresh in the tab order", async () => {
    const user = userEvent.setup();
    render(<MarketplacePanel marketplace={state()} />);

    const stops = ALL.length + FEEDS.length;
    const reached: (Element | null)[] = [];
    for (let i = 0; i < stops; i++) {
      await user.tab();
      reached.push(document.activeElement);
    }

    expect(new Set(reached).size).toBe(stops);
    // The last one walked to is the last one drawn, so nothing was skipped on the way.
    expect(document.activeElement).toBe(row("Card trader EUR"));
  });

  /**
   * **The picker offers what the host can reach** (the light-app spec §4). Mana Pool in a
   * browser has a price list the page may not read, and the host says so on the feed's status
   * row — so the row is Card trader's row: greyed, still a tab stop, explaining itself, and deaf
   * to the press.
   */
  describe("a feed this host cannot ask", () => {
    const unreachable = (over: Partial<MarketplaceState> = {}) =>
      state({ feeds: [feed("cardkingdom", "fresh"), UNREACHABLE], ...over });

    it("is aria-disabled and never disabled, and ignores the press", async () => {
      const select = vi.fn();
      render(<MarketplacePanel marketplace={unreachable({ select })} />);

      expect(row("Mana Pool USD")).toHaveAttribute("aria-disabled", "true");
      expect(row("Mana Pool USD")).not.toBeDisabled();
      expect(row("Mana Pool USD")).toHaveAttribute("aria-pressed", "false");
      await userEvent.click(row("Mana Pool USD"));
      expect(select).not.toHaveBeenCalled();

      // The feed beside it is this host's to ask, and is untouched by any of it.
      expect(row("Card Kingdom USD")).not.toHaveAttribute("aria-disabled");
      await userEvent.click(row("Card Kingdom USD"));
      expect(select).toHaveBeenCalledExactlyOnceWith("cardkingdom");
    });

    /** What happened and where the prices can still be had — "not available" alone reads as
     *  "gone", and this marketplace is neither gone nor unsupported. */
    it("says why, and where its prices can be had", () => {
      render(<MarketplacePanel marketplace={unreachable()} />);

      expect(row("Mana Pool USD")).toHaveAccessibleDescription(
        "Not available in a browser. Mana Pool's price list can't be read from a web page — " +
          "the desktop and Android apps can show it.",
      );
    });

    /**
     * **Neither a feed line nor a refresh.** "No prices yet. Selecting this marketplace downloads
     * them." is a promise this host cannot keep, and a refresh is a press that can only fail.
     */
    it("draws no feed state and no refresh for it", () => {
      render(<MarketplacePanel marketplace={unreachable()} />);

      expect(row("Mana Pool USD")).not.toHaveAccessibleDescription(/No prices yet/);
      expect(
        within(panel()).queryByRole("button", { name: "Refresh Mana Pool prices" }),
      ).toBeNull();
      // Five rows and the one refresh that is left.
      expect(within(panel()).getAllByRole("button")).toHaveLength(ALL.length + 1);
    });

    /**
     * The state the fallback exists for: the database names Mana Pool and the window is quoting
     * TCGplayer in its place. The mark is on what is being quoted, and the greyed row says that
     * it is the reader's own choice and what is standing in for it.
     */
    it("marks what the window quotes, and says whose prices stand in for the stored choice", () => {
      render(<MarketplacePanel marketplace={unreachable({ stored: MARKETPLACES.manapool })} />);

      expect(row("TCGplayer USD")).toHaveAttribute("aria-pressed", "true");
      expect(row("Mana Pool USD")).toHaveAttribute("aria-pressed", "false");
      expect(row("Mana Pool USD")).toHaveAccessibleDescription(
        "Your prices are set to Mana Pool, so prices here are TCGplayer's until you choose " +
          "another. Not available in a browser. Mana Pool's price list can't be read from a " +
          "web page — the desktop and Android apps can show it.",
      );
      // Said once, on the row it is about — the stand-in itself has nothing to excuse.
      expect(row("TCGplayer USD")).not.toHaveAccessibleDescription();
    });

    it("says nothing about a stand-in when the reader's choice is one the host can ask", () => {
      render(<MarketplacePanel marketplace={unreachable()} />);
      expect(row("Mana Pool USD")).not.toHaveAccessibleDescription(/Your prices are set to/);
    });
  });

  /** A refused write has to be sayable — the panel's other failure state. */
  it("reports a refused choice", () => {
    render(
      <MarketplacePanel
        marketplace={state({ error: "The card database is busy. Try that again in a moment." })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The card database is busy.");
  });
});
