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
 * this module's own exported keys (see `seed()` below), so the reads never run at all and the
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
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { deckListKey, deckValuesKey } from "../keys";
import type { Density } from "../widgetSettings";
import {
  DecksWidget,
  DecksWidgetSettings,
  deckScope,
  decksToShow,
} from "./DecksWidget";

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
    managedWishlist: "off",
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    separateXGroup: false,
    defaultCategoryId: 0,
    bracket: 0,
    tokensOpen: false,
    tokenStack: false,
    tokenRailIndex: -1,
    statsOpen: true,
    ...over,
  };
}

/** Likewise. `value: null` is the case the em dash is about and is never spelled as `0`. */
function value(over: Partial<DeckValue> & { deckId: number }): DeckValue {
  return { value: 12.5, unpriced: 0, ...over };
}

/** The stored entry the page hands a widget. `config` is `null` for a widget nobody has set up,
 *  which is what `home.rs` seeds and what every reader in `widgetSettings.ts` reads as defaults. */
function widget(config: unknown = null): HomeWidget {
  return { id: "decks", kind: "decks", x: 0, y: 0, w: 3, h: 3, config };
}

/**
 * The box a widget is told it is drawn in, at the grid's target cell — the page's own arithmetic,
 * so a case about "a two-cell tile" is a two-cell tile in pixels too.
 */
function fitFor(w: number, h: number, density: Density = "comfortable"): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, 104), heightPx: spanPx(h, 104), density });
}

/** Room enough for every fixture below: one list column, nine rows with covers. */
const ROOMY = fitFor(3, 6);

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

function draw(
  config: unknown = null,
  { fit = ROOMY, still = false }: { fit?: WidgetFit; still?: boolean } = {},
): ReturnType<typeof render> {
  return render(
    <DecksWidget
      widget={widget(config)}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

/** Every row's accessible name, in the order they are drawn — the one assertion that can see
 *  both *which* decks are shown and *what order* they are in. */
function rowNames(): string[] {
  return screen
    .queryAllByRole("button")
    .map((el) => el.getAttribute("aria-label") ?? "")
    .filter((name) => name !== "");
}

const deckNames = () => rowNames().map((name) => name.split(" · ")[0]);

beforeEach(() => {
  nextId = 1;
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
  // Store state is module-level and leaks between tests — the order case below even replaces two
  // of its actions — so every case starts from the store's own initial state.
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "search" });
});

/**
 * The home page's deck shortcuts.
 *
 * Four questions run through every case below and they are worth naming once: **which** decks a
 * row is drawn for, **in what order**, **whose number** is on it, and **how much of it** the box
 * has room for.
 */
describe("DecksWidget", () => {
  describe("which decks it draws", () => {
    /**
     * `deck_list` is already `ORDER BY archived ASC, updated_at DESC, id DESC`, so "the most
     * recently updated" is a filter rather than a sort. The fixture is handed to the widget in
     * that order and comes back in it — a widget that re-sorted would have to disagree with SQL
     * to pass this.
     */
    it("draws the most recent decks in the list's own order when nothing is configured", () => {
      seed([deck({ name: "Deck 1" }), deck({ name: "Deck 2" }), deck({ name: "Deck 3" })]);

      draw();

      expect(deckNames()).toEqual(["Deck 1", "Deck 2", "Deck 3"]);
    });

    it("leaves an archived deck out of Most recent", () => {
      seed([deck({ id: 1, name: "Live one" }), deck({ id: 2, name: "Retired", archived: true })]);

      draw({ scope: "recent" });

      expect(deckNames()).toEqual(["Live one"]);
    });

    /** `Archived too` keeps the list whole — which, in `deck_list`'s order, is the shelf after
     *  the live decks rather than interleaved with them. */
    it("adds archived decks after the live ones under Archived too", () => {
      seed([deck({ id: 1, name: "Live one" }), deck({ id: 2, name: "Retired", archived: true })]);

      draw({ scope: "archived" });

      expect(deckNames()).toEqual(["Live one", "Retired"]);
      expect(screen.getByRole("button", { name: /^Retired · / })).toHaveAccessibleName(
        "Retired · Commander · 100 cards · Archived · —",
      );
    });

    /**
     * **Pinning is an arrangement, so the reader's order is the order.** `deck_list` would have
     * drawn these the other way round; the config wins, and it has to — a set re-sorted into
     * "most recently touched" would rearrange itself every time the reader edited a deck.
     */
    it("honours a pinned set in the order it was chosen", () => {
      seed([
        deck({ id: 1, name: "Alpha" }),
        deck({ id: 2, name: "Beta" }),
        deck({ id: 3, name: "Gamma" }),
      ]);

      draw({ scope: "pinned", deckIds: [3, 1] });

      expect(deckNames()).toEqual(["Gamma", "Alpha"]);
    });

    it("draws an archived deck that was pinned, and says that it is archived", () => {
      seed([deck({ id: 1, name: "Live one" }), deck({ id: 2, name: "Retired", archived: true })]);

      draw({ scope: "pinned", deckIds: [2] });

      expect(screen.getByRole("button", { name: /^Retired · / })).toHaveAccessibleName(
        /· Archived ·/,
      );
    });

    /**
     * **A config from before the scope pick existed keeps its pins.** The old widget stored
     * `deckIds` alone, and a non-empty set was the whole of what "pinned" meant; reading the
     * registry's default there would draw the recent decks under a reader who chose theirs.
     */
    it("reads a pre-redesign config that holds pins as Pinned", () => {
      seed([deck({ id: 1, name: "Alpha" }), deck({ id: 2, name: "Beta" })]);

      draw({ deckIds: [2] });

      expect(deckNames()).toEqual(["Beta"]);
    });

    /**
     * A soft reference, handled the way every soft reference in this app is: dropped, in silence,
     * and **without rewriting the config** — a deck can come back (an undo, a restore, a sync
     * from the device that still has it) and the pin is right again when it does.
     */
    it("drops a pinned deck that no longer exists without writing anything", () => {
      seed([deck({ id: 1, name: "Alpha" })]);
      const onConfig = vi.fn();

      render(
        <DecksWidget
          widget={widget({ scope: "pinned", deckIds: [99, 1] })}
          fit={ROOMY}
          editing={false}
          still={false}
          onConfig={onConfig}
        />,
        { wrapper },
      );

      expect(deckNames()).toEqual(["Alpha"]);
      expect(onConfig).not.toHaveBeenCalled();
    });

    /** Junk in the stored document is a pin that answers to no deck. `widgetConfig`'s shape check
     *  is shallow by its own admission, so the elements are narrowed by the widget. */
    it("survives a config whose ids are not numbers", () => {
      seed([deck({ id: 1, name: "Alpha" })]);

      draw({ scope: "pinned", deckIds: ["1", null, 1.5, 1] });

      expect(deckNames()).toEqual(["Alpha"]);
    });

    it("draws one row for a deck pinned twice", () => {
      seed([deck({ id: 1, name: "Alpha" })]);

      draw({ scope: "pinned", deckIds: [1, 1] });

      expect(rowNames()).toHaveLength(1);
    });
  });

  describe("what a row says", () => {
    it("names the deck, its format, its card count and its value", () => {
      seed(
        [deck({ id: 1, name: "Burn", formatName: "Modern", cardCount: 60 })],
        [value({ deckId: 1, value: 120 })],
      );

      draw();

      expect(screen.getByRole("button", { name: /^Burn/ })).toHaveAccessibleName(
        "Burn · Modern · 60 cards · $120.00",
      );
      expect(screen.getByText("Modern · 60 cards")).toBeInTheDocument();
      expect(screen.getByText("$120.00")).toBeInTheDocument();
    });

    /**
     * **`DeckValue.value` is `null` for "the marketplace priced nothing in this deck", and that
     * is an em dash rather than a zero** — a deck of unpriced cards is not a deck worth nothing.
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

    /** The figures land after the rows do, so a deck `deck_values` has not answered for yet is
     *  the same em dash — and the note under the list is what tells the two apart. */
    it("draws an em dash for a deck the value read has not answered for", () => {
      seed([deck({ id: 1, name: "Burn", formatName: "Modern", cardCount: 60 })], []);

      draw();

      expect(screen.getByRole("button", { name: /^Burn/ })).toHaveAccessibleName(/· —$/);
    });

    /** The unpriced copies are counted at the same marketplace as the figures beside them. The
     *  note is a band's furniture, so the case draws a four-cell band. */
    it("says how many copies the marketplace has no price for on a band", () => {
      seed([deck({ id: 1, name: "Burn" })], [value({ deckId: 1, value: 40, unpriced: 3 })]);

      draw(null, { fit: fitFor(4, 3) });

      expect(screen.getByText(/3 copies here have no price at it\./)).toBeInTheDocument();
    });

    it("draws no price note on a panel narrower than a band", () => {
      seed([deck({ id: 1, name: "Burn" })], [value({ deckId: 1, value: 40, unpriced: 3 })]);

      draw(null, { fit: fitFor(3, 3) });

      expect(screen.queryByText(/prices as of/)).toBeNull();
    });
  });

  /**
   * What fits is a question about pixels, and every list is cut to **whole rows**. These cases
   * pin the design's four row heights against `makeFit`'s arithmetic, so a row that grew a line
   * without its height moving is a red suite rather than a card that clips.
   */
  describe("what fits", () => {
    const eight = () => Array.from({ length: 8 }, (_, i) => deck({ name: `Deck ${i + 1}` }));

    it("cuts a three-by-two panel with covers to two rows", () => {
      seed(eight());

      draw(null, { fit: fitFor(3, 2) });

      expect(rowNames()).toHaveLength(2);
      // A frame per row. These decks have no cover, so each frame is `CardArt`'s own fallback —
      // which is what makes the frame findable in a DOM that loads no pictures.
      expect(screen.getAllByText("No card")).toHaveLength(2);
    });

    it("draws three captioned rows in the same panel with covers off", () => {
      seed(eight());

      draw({ art: false }, { fit: fitFor(3, 2) });

      expect(rowNames()).toHaveLength(3);
      expect(screen.getAllByText("Commander · 100 cards")).toHaveLength(3);
    });

    /** Compact drops the caption, and a bare row is one line — so more of them fit. */
    it("draws four bare rows in the same panel, compact, covers off", () => {
      seed(eight());

      draw({ art: false }, { fit: fitFor(3, 2, "compact") });

      expect(rowNames()).toHaveLength(4);
      expect(screen.queryByText("Commander · 100 cards")).toBeNull();
    });

    /**
     * **On a two-cell tile the figure moves under the name.** There is no width for a name and a
     * figure side by side, so the value is the caption and no figure sits at the right — and no
     * cover is drawn whatever the switch says, because a 34px frame would leave the name nothing.
     */
    it("moves the value under the name on a two-cell tile, with no cover", () => {
      seed([deck({ id: 1, name: "Burn", formatName: "Modern", cardCount: 60 })], [
        value({ deckId: 1, value: 120 }),
      ]);

      draw(null, { fit: fitFor(2, 3) });

      const row = screen.getByRole("button", { name: /^Burn/ });
      expect(row).toHaveTextContent("Burn$120.00");
      expect(screen.queryByText("Modern · 60 cards")).toBeNull();
      expect(screen.queryByText("No card")).toBeNull();
    });

    it("draws the cover as a whole card, from the deck's cover printing", () => {
      seed([deck({ id: 1, name: "Burn", coverCardId: "abc", coverArtist: "Somebody" })]);

      const { container } = draw(null, { fit: fitFor(3, 3) });

      const img = container.querySelector("img");
      expect(img?.getAttribute("src")).toContain("/thumb/abc/0");
    });

    /** `hasCover`'s rule: a cover whose printing has left `cards` has no artist and nothing to
     *  fetch, so no request is made for it. */
    it("fetches nothing for a cover whose printing has gone", () => {
      seed([deck({ id: 1, name: "Burn", coverCardId: "abc", coverArtist: null })]);

      const { container } = draw(null, { fit: fitFor(3, 3) });

      expect(container.querySelector("img")).toBeNull();
    });
  });

  describe("opening a deck", () => {
    /**
     * **`decks` is one view with two states, not two views.** The gallery and the editor are told
     * apart by `openDeckId`, so a press writes the view *and* the id — and in that order, since
     * `setActiveView` clears the id on the way in. The spy records the order the two writes are
     * made in, which is the half an end state cannot show.
     */
    it("opens the deck it was pressed on, view first and id second", async () => {
      const user = userEvent.setup();
      const writes: string[] = [];
      const { setActiveView, setOpenDeckId } = useAppStore.getState();
      useAppStore.setState({
        setActiveView: (view) => {
          writes.push(`view:${view}`);
          setActiveView(view);
        },
        setOpenDeckId: (id) => {
          writes.push(`deck:${id}`);
          setOpenDeckId(id);
        },
      });
      seed([deck({ id: 7, name: "Burn" })]);
      draw();

      await user.click(screen.getByRole("button", { name: /^Burn/ }));

      expect(writes).toEqual(["view:decks", "deck:7"]);
      expect(useAppStore.getState().activeView).toBe("decks");
      expect(useAppStore.getState().openDeckId).toBe(7);
    });

    /**
     * **A catalogue still presses nothing.** Its rows are pictures of rows: the same words, no
     * button, and no store write however it is clicked.
     */
    it("draws a still body with no presses", () => {
      seed([deck({ id: 7, name: "Burn" })]);

      draw(null, { still: true });

      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText("Burn")).toBeInTheDocument();
      expect(useAppStore.getState().openDeckId).toBeNull();
    });
  });

  /**
   * **Every state is its own sentence.** A widget that answered an empty body for all of them
   * would be indistinguishable from a working one with nothing in it, which is the failure a
   * reader reports as "my decks disappeared".
   */
  describe("the states", () => {
    it("says the read is still out", () => {
      // Nothing seeded, so the query runs — and never settles, which is what "loading" is.
      deckList.mockReturnValue(new Promise(() => {}));

      draw();

      expect(screen.getByText("Loading your decks…")).toBeInTheDocument();
    });

    it("says there are no decks at all", () => {
      seed([]);

      draw();

      expect(screen.getByText(/No decks yet — make one on the Decks page/)).toBeInTheDocument();
    });

    /** Its own sentence: a reader with decks whose every pin has gone is not a reader with no
     *  decks, and falling back to the recent ones would answer a question they did not ask. */
    it("says when every pinned deck has gone", () => {
      seed([deck({ id: 1, name: "Alpha" })]);

      draw({ scope: "pinned", deckIds: [99] });

      expect(screen.getByText(/pinned here are not in this collection any more/)).toBeInTheDocument();
    });

    /** `Pinned` with nothing pinned points at the picker rather than drawing recent decks under a
     *  chip that reads `Pinned`. */
    it("says when Pinned is chosen and nothing is pinned", () => {
      seed([deck({ id: 1, name: "Alpha" })]);

      draw({ scope: "pinned" });

      expect(screen.getByText(/No decks pinned yet/)).toBeInTheDocument();
      expect(rowNames()).toEqual([]);
    });

    it("says when Most recent has nothing but archived decks to leave out", () => {
      seed([deck({ id: 1, name: "Retired", archived: true })]);

      draw();

      expect(screen.getByText(/Every deck is archived/)).toBeInTheDocument();
    });

    it("says the read was refused, in the backend's own words", async () => {
      deckList.mockRejectedValue("The database is busy.");

      draw();

      expect(
        await screen.findByText(/Could not read your decks — The database is busy\./),
      ).toBeInTheDocument();
    });

    /**
     * A refused **price** read is not the widget's refusal state: the rows are still right and
     * only the money is missing, so the em dashes get a reason — on a card of any width, since
     * a dash with no reason is the one thing a reader cannot interrogate.
     */
    it("keeps drawing rows when only the price read was refused", async () => {
      qc.setQueryData(deckListKey, [deck({ id: 1, name: "Burn" })]);
      deckValues.mockRejectedValue("No price feed.");

      draw(null, { fit: fitFor(3, 3) });

      expect(screen.getByRole("button", { name: /^Burn/ })).toHaveAccessibleName(/· —$/);
      expect(
        await screen.findByText(/Could not read what these decks are worth — No price feed\./),
      ).toBeInTheDocument();
    });
  });

  describe("its settings", () => {
    function settings(config: unknown, onConfig = vi.fn()) {
      render(<DecksWidgetSettings widget={widget(config)} onConfig={onConfig} />, { wrapper });
      return onConfig;
    }

    /** Under `Most recent` the picker would change nothing on the card, so it is not drawn and a
     *  sentence names the row and the option that bring it. */
    it("points at the scope row instead of drawing a picker that would do nothing", () => {
      seed([deck({ id: 1, name: "Affinity" })]);

      settings(null);

      expect(screen.queryByRole("button", { name: "Decks to pin" })).toBeNull();
      expect(
        screen.getByText("Choose Pinned under Which decks to pick the decks this card shows."),
      ).toBeInTheDocument();
    });

    it("offers every deck, alphabetically, whatever order the list came in", async () => {
      const user = userEvent.setup();
      seed([
        deck({ id: 1, name: "Zoo" }),
        deck({ id: 2, name: "Affinity" }),
        deck({ id: 3, name: "Merfolk" }),
      ]);
      settings({ scope: "pinned" });

      await user.click(screen.getByRole("button", { name: "Decks to pin" }));

      expect(screen.getAllByRole("option").map((el) => el.textContent)).toEqual([
        expect.stringContaining("Affinity"),
        expect.stringContaining("Merfolk"),
        expect.stringContaining("Zoo"),
      ]);
    });

    /**
     * The patch names the pins and the scope. The page merges it, so a key a newer build stored
     * survives — which is the page's job now rather than this widget's spread.
     */
    it("pins a deck, writing the scope it is already reading", async () => {
      const user = userEvent.setup();
      seed([deck({ id: 4, name: "Affinity" })]);
      const onConfig = settings({ scope: "pinned", deckIds: [] });

      await user.click(screen.getByRole("button", { name: "Decks to pin" }));
      await user.click(screen.getByRole("option", { name: /Affinity/ }));

      await waitFor(() =>
        expect(onConfig).toHaveBeenCalledWith({ deckIds: [4], scope: "pinned" }),
      );
    });

    /** A second pin lands at the **end**, which is what makes the stored order the reader's. */
    it("appends a second pin rather than sorting it in", async () => {
      const user = userEvent.setup();
      seed([deck({ id: 1, name: "Affinity" }), deck({ id: 2, name: "Zoo" })]);
      const onConfig = settings({ scope: "pinned", deckIds: [2] });

      // The trigger's accessible **name** is the control's label; the count is what it *says*.
      const trigger = screen.getByRole("button", { name: "Decks to pin" });
      expect(trigger).toHaveTextContent("1 deck");
      await user.click(trigger);
      await user.click(screen.getByRole("option", { name: /Affinity/ }));

      await waitFor(() =>
        expect(onConfig).toHaveBeenCalledWith({ deckIds: [2, 1], scope: "pinned" }),
      );
    });

    /**
     * **Unpinning the last deck of a pre-redesign config must not flip the card.** That config
     * reads as `Pinned` only while it holds pins; the patch writes the word so an empty set stays
     * `Pinned` and the picker stays under the reader's hand.
     */
    it("unpins the last deck of an old config and keeps the card on Pinned", async () => {
      const user = userEvent.setup();
      seed([deck({ id: 1, name: "Affinity" })]);
      const onConfig = settings({ deckIds: [1] });

      const trigger = screen.getByRole("button", { name: "Decks to pin" });
      expect(trigger).toHaveTextContent("1 deck");
      await user.click(trigger);
      await user.click(screen.getByRole("option", { name: /Affinity/ }));

      await waitFor(() => expect(onConfig).toHaveBeenCalledWith({ deckIds: [], scope: "pinned" }));
    });
  });

  /**
   * The widget's whole judgement, without a render around it — every rule in one table.
   */
  describe("decksToShow and deckScope", () => {
    it("answers nothing for a collection with no decks", () => {
      expect(decksToShow([], "recent", [])).toEqual([]);
      expect(decksToShow([], "pinned", [1, 2])).toEqual([]);
    });

    it("never re-sorts the list it was handed", () => {
      const decks = [deck({ id: 3, name: "C" }), deck({ id: 1, name: "A" })];

      expect(decksToShow(decks, "recent", []).map((d) => d.name)).toEqual(["C", "A"]);
      expect(decksToShow(decks, "archived", []).map((d) => d.name)).toEqual(["C", "A"]);
    });

    it("reads the stored scope, the default, and the pre-redesign upgrade", () => {
      expect(deckScope(widget(null))).toBe("recent");
      expect(deckScope(widget({ scope: "archived" }))).toBe("archived");
      expect(deckScope(widget({ deckIds: [1] }))).toBe("pinned");
      // A stored word wins over the upgrade: the reader chose it after the pick existed.
      expect(deckScope(widget({ scope: "recent", deckIds: [1] }))).toBe("recent");
      // A word no option carries reads as the default.
      expect(deckScope(widget({ scope: "favourites" }))).toBe("recent");
    });
  });
});
