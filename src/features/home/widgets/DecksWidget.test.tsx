import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two reads this widget makes, and **only** those two.
 *
 * The module namespace *and* the `ipc` object are both spread from the original, which is the
 * half that matters: an `ipc` replaced wholesale by a handful of `vi.fn()`s erases the
 * hand-written mirror, so every other command on it becomes `undefined` and a struct that grew a
 * field fails at run time inside a render rather than under `tsc`. Here the mirror is intact and
 * two functions stand in front of it — and every fixture below goes through a typed factory, so
 * the mirror still checks the shapes this file makes up.
 *
 * They are consulted **only where the cache is cold**: the cases that have data seed it through
 * this module's own exported keys (see `client()` below), so the reads never run at all and the
 * assertions need no `await`. What is left for the mock is the two states a cache cannot hold —
 * a read still out, and a read refused.
 */
const deckList = vi.hoisted(() => vi.fn());
const deckValues = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, deckList, deckValues } };
});

import type { DeckRow, DeckValue, HomeWidget } from "@/lib/ipc";
import { DEFAULT_MARKETPLACE } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { deckListKey, deckValuesKey } from "../keys";
import { DecksWidget, decksToShow, RECENT_DECK_COUNT } from "./DecksWidget";

let nextId = 1;

/** A deck, annotated so the mirror checks the fixture — see the mock note above. */
function deck(over: Partial<DeckRow> & { name: string }): DeckRow {
  return {
    id: nextId++,
    formatKey: "commander",
    formatName: "Commander",
    gameKey: "any",
    description: null,
    coverCardId: null,
    coverKind: "card_art",
    coverArtist: null,
    archived: false,
    cardCount: 100,
    updatedAt: 1_800_000_000,
    folderId: null,
    notesOpen: false,
    theoryEnabled: false,
    virtualOnly: false,
    theoryMarkExact: true,
    theoryMarkName: true,
    theoryMarkUnplanned: true,
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    separateXGroup: false,
    defaultCategoryId: 0,
    bracket: 0,
    tokensOpen: false,
    statsOpen: true,
    ...over,
  };
}

/** Likewise. `value: null` is the case the em dash is about and is never spelled as `0`. */
function value(over: Partial<DeckValue> & { deckId: number }): DeckValue {
  return { value: 12.5, unpriced: 0, ...over };
}

/** The stored entry the page hands a widget. `config` is `null` for a widget nobody has set up,
 *  which is what `home.rs` seeds and what `widgetConfig` reads as "use the fallback". */
function widget(config: unknown = null): HomeWidget {
  return { id: "decks", kind: "decks", span: 1, config };
}

const onConfig = vi.fn();
const chrome = {
  onRemove: vi.fn(),
  onSpan: vi.fn(),
  dragHandleRef: vi.fn(),
  onNudge: vi.fn(),
};

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/**
 * Seed the cache through the module's **exported** keys, which is the point of exporting them:
 * a test that reproduced `["decks", "list"]` as a literal would go on passing on the day the
 * widget started reading somewhere else, and the widget's whole claim is that it shares the
 * gallery's key so the gallery's invalidations reach it.
 *
 * `staleTime: Infinity` is what makes a seeded query a *settled* one — without it the data is
 * stale the instant it lands and the observer refetches, which is the mock answering a question
 * the cache had already answered.
 */
function seed(decks: readonly DeckRow[], values: readonly DeckValue[] = []) {
  qc.setQueryData(deckListKey, decks);
  qc.setQueryData(deckValuesKey(DEFAULT_MARKETPLACE), values);
}

function draw(config: unknown = null, editing = false): ReturnType<typeof render> {
  return render(
    <DecksWidget widget={widget(config)} editing={editing} onConfig={onConfig} {...chrome} />,
    { wrapper },
  );
}

/** Every tile's accessible name, in the order they are drawn — the one assertion that can see
 *  both *which* decks are shown and *what order* they are in. */
function tileNames(): string[] {
  return screen
    .getAllByRole("button")
    .map((el) => el.getAttribute("aria-label") ?? "")
    .filter((name) => name !== "");
}

beforeEach(() => {
  nextId = 1;
  onConfig.mockReset();
  deckList.mockReset().mockResolvedValue([]);
  deckValues.mockReset().mockResolvedValue([]);
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // The marketplace, so `useMarketplace` resolves without reaching a Tauri window that is not
  // there. Both of its reads, because only `MARKETPLACE_PROGRESS_KEY` is a `skipToken` query and
  // the other two would otherwise fetch.
  qc.setQueryData(MARKETPLACE_KEY, DEFAULT_MARKETPLACE);
  qc.setQueryData(MARKETPLACE_FEEDS_KEY, []);
  // Store state is module-level and leaks between tests. Not `"home"`: that `ViewId` is a later
  // task's, and this suite must not depend on the union it is not testing.
  useAppStore.setState({ activeView: "search", openDeckId: null, parkedDeckId: null });
});

/**
 * The home page's deck shortcuts.
 *
 * Three questions run through every case below and they are worth naming once: **which** decks a
 * tile is drawn for, **in what order**, and **whose number** is on it.
 */
describe("DecksWidget", () => {
  describe("which decks it draws", () => {
    /**
     * `deck_list` is already `ORDER BY archived ASC, updated_at DESC, id DESC`, so "the six most
     * recently updated" is a slice rather than a sort. The fixture is handed to the widget in
     * that order and comes back in it — a widget that re-sorted would have to disagree with SQL
     * to pass this.
     */
    it("falls back to the six most recently updated when nothing is pinned", () => {
      seed(
        Array.from({ length: 8 }, (_, i) => deck({ name: `Deck ${i + 1}` })),
      );

      draw();

      expect(tileNames()).toHaveLength(RECENT_DECK_COUNT);
      expect(tileNames()[0]).toMatch(/^Deck 1 · /);
      expect(tileNames()[5]).toMatch(/^Deck 6 · /);
      expect(screen.queryByRole("button", { name: /^Deck 7 · / })).toBeNull();
    });

    /**
     * **Pinning is an arrangement, so the reader's order is the order.** `deck_list` would have
     * drawn these three the other way round; the config wins, and it has to — a set re-sorted
     * into "most recently touched" would rearrange itself every time the reader edited a deck.
     */
    it("honours a chosen set in the order it was chosen", () => {
      seed([
        deck({ id: 1, name: "Alpha" }),
        deck({ id: 2, name: "Beta" }),
        deck({ id: 3, name: "Gamma" }),
      ]);

      draw({ deckIds: [3, 1] });

      expect(tileNames().map((name) => name.split(" · ")[0])).toEqual(["Gamma", "Alpha"]);
    });

    /**
     * **An archived deck is out of the fallback and in a pin**, and the pair is one rule rather
     * than two: "the decks I am working on" excludes a shelved one, and "the decks I chose"
     * cannot — the reader chose it. It says `Archived` beside the name so the tile is not
     * mistaken for a live deck.
     */
    it("leaves an archived deck out of the recent fallback", () => {
      seed([deck({ id: 1, name: "Live one" }), deck({ id: 2, name: "Retired", archived: true })]);

      draw();

      expect(tileNames().map((name) => name.split(" · ")[0])).toEqual(["Live one"]);
    });

    it("draws an archived deck that was pinned, and says that it is archived", () => {
      seed([deck({ id: 1, name: "Live one" }), deck({ id: 2, name: "Retired", archived: true })]);

      draw({ deckIds: [2] });

      expect(screen.getByRole("button", { name: /^Retired · / })).toHaveAccessibleName(
        /· Archived ·/,
      );
    });

    /**
     * A soft reference, handled the way every soft reference in this app is: dropped, in silence,
     * and **without rewriting the config** — a deck can come back (an undo, a restore, a sync
     * from the device that still has it) and the pin is right again when it does.
     */
    it("drops a pinned deck that no longer exists without saying anything", () => {
      seed([deck({ id: 1, name: "Alpha" })]);

      draw({ deckIds: [99, 1] });

      expect(tileNames().map((name) => name.split(" · ")[0])).toEqual(["Alpha"]);
      expect(onConfig).not.toHaveBeenCalled();
    });

    /** Junk in the stored document is a pin that answers to no deck. `widgetConfig`'s shape check
     *  is shallow by its own admission, so the elements are narrowed by the widget. */
    it("survives a config whose ids are not numbers", () => {
      seed([deck({ id: 1, name: "Alpha" })]);

      draw({ deckIds: ["1", null, 1.5, 1] });

      expect(tileNames().map((name) => name.split(" · ")[0])).toEqual(["Alpha"]);
    });

    it("draws one tile for a deck pinned twice", () => {
      seed([deck({ id: 1, name: "Alpha" })]);

      draw({ deckIds: [1, 1] });

      expect(tileNames()).toHaveLength(1);
    });
  });

  describe("what a tile says", () => {
    it("names the deck, its format and its card count", () => {
      seed(
        [deck({ id: 1, name: "Burn", formatName: "Modern", cardCount: 60 })],
        [value({ deckId: 1, value: 120 })],
      );

      draw();

      expect(screen.getByRole("button", { name: /^Burn/ })).toHaveAccessibleName(
        "Burn · Modern · 60 cards · $120.00",
      );
    });

    /**
     * **`DeckValue.value` is `null` for "the marketplace priced nothing in this deck", and that
     * is an em dash rather than a zero** — a deck of unpriced cards is not a deck worth nothing.
     * The figure goes through `formatPrice` and the currency comes from `useMarketplace`, so no
     * other marketplace's number can reach this tile.
     */
    it("draws an em dash for a deck the marketplace priced nothing in", () => {
      seed(
        [deck({ id: 1, name: "Tokens", formatName: "Commander", cardCount: 100 })],
        [value({ deckId: 1, value: null, unpriced: 100 })],
      );

      draw();

      expect(screen.getByRole("button", { name: /^Tokens/ })).toHaveAccessibleName(
        "Tokens · Commander · 100 cards · —",
      );
    });

    /** The figures land after the tiles do, so a deck `deck_values` has not answered for yet is
     *  the same em dash — and the note under the list is what tells the two apart. */
    it("draws an em dash for a deck the value read has not answered for", () => {
      seed([deck({ id: 1, name: "Burn", formatName: "Modern", cardCount: 60 })], []);

      draw();

      expect(screen.getByRole("button", { name: /^Burn/ })).toHaveAccessibleName(/· —$/);
    });

    /** The unpriced copies are counted at the same marketplace as the figures beside them, and
     *  they never travel across a switch. */
    it("says how many copies the marketplace has no price for", () => {
      seed(
        [deck({ id: 1, name: "Burn" })],
        [value({ deckId: 1, value: 40, unpriced: 3 })],
      );

      draw();

      expect(screen.getByText(/3 copies here have no price at it\./)).toBeInTheDocument();
    });
  });

  describe("opening a deck", () => {
    /**
     * **`decks` is one view with two states, not two views.** The gallery and the editor are told
     * apart by `openDeckId`, so a press writes the view *and* the id — and in that order, since
     * `setActiveView` clears the id on the way in.
     */
    it("opens the deck it was pressed on", async () => {
      const user = userEvent.setup();
      seed([deck({ id: 7, name: "Burn" })]);
      draw();

      await user.click(screen.getByRole("button", { name: /^Burn/ }));

      expect(useAppStore.getState().activeView).toBe("decks");
      expect(useAppStore.getState().openDeckId).toBe(7);
    });

    /**
     * A reader rearranging the page is not browsing it. A tile that stayed pressable in edit mode
     * would take the layout they are half way through arranging off the screen — so the tile is a
     * preview of itself, with the same words and no affordance.
     */
    it("is not pressable while the page is being customized", () => {
      seed([deck({ id: 7, name: "Burn" })]);

      draw(null, true);

      expect(screen.queryByRole("button", { name: /^Burn/ })).toBeNull();
      expect(screen.getByText("Burn")).toBeInTheDocument();
    });
  });

  /**
   * **Three states, three sentences.** A widget that answered an empty page for all three would
   * be indistinguishable from a working one with nothing in it, which is the failure a reader
   * reports as "my decks disappeared".
   */
  describe("the three states", () => {
    it("says the read is still out", () => {
      // Nothing seeded, so the query runs — and never settles, which is what "loading" is.
      deckList.mockReturnValue(new Promise(() => {}));

      draw();

      expect(screen.getByText("Loading your decks…")).toBeInTheDocument();
    });

    it("says there are no decks at all", async () => {
      seed([]);

      draw();

      expect(
        await screen.findByText(/No decks yet — make one on the Decks page/),
      ).toBeInTheDocument();
    });

    /** Its own sentence: a reader with decks whose every pin has gone is not a reader with no
     *  decks, and falling back to the recent six would answer a question they did not ask. */
    it("says when every pinned deck has gone", () => {
      seed([deck({ id: 1, name: "Alpha" })]);

      draw({ deckIds: [99] });

      expect(screen.getByText(/pinned here are not in this collection any more/)).toBeInTheDocument();
    });

    it("says the read was refused, in the backend's own words", async () => {
      deckList.mockRejectedValue("The database is busy.");

      draw();

      expect(await screen.findByText(/Could not read your decks — The database is busy\./)).toBeInTheDocument();
    });

    /**
     * A refused **price** read is not the widget's refusal state: the tiles are still right and
     * only the money is missing, so the em dashes get a reason and the deck list keeps an error
     * it never had.
     */
    it("keeps drawing tiles when only the price read was refused", async () => {
      qc.setQueryData(deckListKey, [deck({ id: 1, name: "Burn" })]);
      deckValues.mockRejectedValue("No price feed.");

      draw();

      expect(screen.getByRole("button", { name: /^Burn/ })).toHaveAccessibleName(/· —$/);
      expect(
        await screen.findByText(/Could not read what these decks are worth — No price feed\./),
      ).toBeInTheDocument();
    });
  });

  describe("its settings", () => {
    /** The tray's settings control opens on the card's own popover — the widget hands `WidgetCard`
     *  a node and owns nothing about where it is drawn. */
    async function openSettings(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.click(screen.getByRole("button", { name: "Settings for Decks" }));
    }

    it("offers every deck, alphabetically, whatever order the list came in", async () => {
      const user = userEvent.setup();
      seed([
        deck({ id: 1, name: "Zoo" }),
        deck({ id: 2, name: "Affinity" }),
        deck({ id: 3, name: "Merfolk" }),
      ]);
      draw(null, true);

      await openSettings(user);
      await user.click(screen.getByRole("button", { name: "Decks to pin" }));

      expect(screen.getAllByRole("option").map((el) => el.textContent)).toEqual([
        expect.stringContaining("Affinity"),
        expect.stringContaining("Merfolk"),
        expect.stringContaining("Zoo"),
      ]);
    });

    /**
     * **The current config is spread**, so a key a newer build stored on this widget survives an
     * older one writing its own settings back. That is the whole reason `onConfig` takes an
     * object rather than a `deckIds` array.
     */
    it("pins a deck and keeps a setting it does not understand", async () => {
      const user = userEvent.setup();
      seed([deck({ id: 4, name: "Affinity" })]);
      draw({ deckIds: [], somethingFromTheFuture: 7 }, true);

      await openSettings(user);
      await user.click(screen.getByRole("button", { name: "Decks to pin" }));
      await user.click(screen.getByRole("option", { name: /Affinity/ }));

      await waitFor(() =>
        expect(onConfig).toHaveBeenCalledWith({ deckIds: [4], somethingFromTheFuture: 7 }),
      );
    });

    /** A second pin lands at the **end**, which is what makes the stored order the reader's. */
    it("appends a second pin rather than sorting it in", async () => {
      const user = userEvent.setup();
      seed([deck({ id: 1, name: "Affinity" }), deck({ id: 2, name: "Zoo" })]);
      draw({ deckIds: [2] }, true);

      await openSettings(user);
      // The trigger's accessible **name** is the control's label; the count is what it *says*.
      const trigger = screen.getByRole("button", { name: "Decks to pin" });
      expect(trigger).toHaveTextContent("1 deck");
      await user.click(trigger);
      await user.click(screen.getByRole("option", { name: /Affinity/ }));

      await waitFor(() => expect(onConfig).toHaveBeenCalledWith({ deckIds: [2, 1] }));
    });

    it("unpins a deck that was pinned", async () => {
      const user = userEvent.setup();
      seed([deck({ id: 1, name: "Affinity" }), deck({ id: 2, name: "Zoo" })]);
      draw({ deckIds: [1, 2] }, true);

      await openSettings(user);
      const trigger = screen.getByRole("button", { name: "Decks to pin" });
      expect(trigger).toHaveTextContent("2 decks");
      await user.click(trigger);
      await user.click(screen.getByRole("option", { name: /Affinity/ }));

      await waitFor(() => expect(onConfig).toHaveBeenCalledWith({ deckIds: [2] }));
    });
  });

  /**
   * The widget's whole judgement, without a render around it — every rule in one table.
   */
  describe("decksToShow", () => {
    it("answers nothing for a collection with no decks", () => {
      expect(decksToShow([], [])).toEqual([]);
      expect(decksToShow([], [1, 2])).toEqual([]);
    });

    it("never re-sorts the list it was handed", () => {
      const decks = [deck({ id: 3, name: "C" }), deck({ id: 1, name: "A" })];

      expect(decksToShow(decks, []).map((d) => d.name)).toEqual(["C", "A"]);
    });
  });
});
