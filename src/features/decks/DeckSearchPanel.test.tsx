import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { FormatFilterOption } from "@/features/search/useCardSearch";
import type { CardSummary, DeckCategory, SearchResponse } from "@/lib/ipc";
import { startDrag } from "@/test-drag";
import { readDragData } from "./dnd";

const searchCards = vi.hoisted(() => vi.fn());
// The set picker mounts with the filter bar and asks for the set list on the way up.
const listSets = vi.hoisted(() => vi.fn());
// The panel writes through `useDeck`, which reads the deck it is adding to.
const deckGet = vi.hoisted(() => vi.fn());
const deckAddCard = vi.hoisted(() => vi.fn());
const prefetchImages = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    searchCards,
    // The panel's filter row asks for facet counts beside the page. Answered **cold** —
    // `ready: false`, every map empty — so nothing greys and every control keeps its name.
    facetCards: vi.fn().mockResolvedValue({
      colors: {},
      manaValues: {},
      manaX: 0,
      formats: {},
      sets: {},
      owned: { owned: 0, missing: 0 },
      total: 0,
      ready: false,
    }),
    listSets,
    deckGet,
    deckAddCard,
    prefetchImages,
  },
}));

import { DeckSearchPanel } from "./DeckSearchPanel";
import { useDeck } from "./useDeck";
import { useAppStore } from "@/lib/store";

const BOLT: CardSummary = {
  id: "1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  typeLine: "Instant",
  manaCost: "{R}",
  price: 400.5,
  layout: "normal",
  oracleId: "o-bolt",
  finishes: `["nonfoil","foil"]`,
  ownedQuantity: 3,
  wishlisted: false,
  printings: 1,
  priceLow: 400.5,
  priceHigh: 400.5,
  gameChanger: false,
};

/**
 * A card on the Commander game-changer list, which Bolt is not.
 *
 * Its own row rather than a flag on `BOLT`, because the point of the crown is that it tells two
 * cards apart on one wall — and because every other test in this file reads the unmarked tile.
 */
const RHYSTIC_STUDY: CardSummary = {
  ...BOLT,
  id: "2",
  name: "Rhystic Study",
  setCode: "pcy",
  setName: "Prophecy",
  collectorNumber: "45",
  typeLine: "Enchantment",
  manaCost: "{2}{U}",
  oracleId: "o-rhystic",
  gameChanger: true,
};

const page = (items: CardSummary[]): SearchResponse => ({
  items,
  total: items.length,
  totalIsCapped: false,
});

/**
 * jsdom lays nothing out, so the virtualiser measures a scroll container of zero height and
 * renders an empty window — one number is the whole of what it is missing. `scrollTo` is the
 * other thing it reaches for that jsdom does not implement.
 *
 * Put back afterwards: these are patches to a *global* prototype, and a file that leaves one
 * behind is a file that decides how the next one measures the DOM.
 */
const patched: [string, PropertyDescriptor | undefined][] = [];

beforeAll(() => {
  for (const [name, descriptor] of [
    ["offsetHeight", { value: 600 }],
    ["scrollTo", { value: vi.fn() }],
  ] as const) {
    patched.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
  }
});

afterAll(() => {
  for (const [name, original] of patched.reverse()) {
    if (original) Object.defineProperty(HTMLElement.prototype, name, original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

beforeEach(() => {
  useAppStore.setState({ selectedCardId: null });
  searchCards.mockReset().mockResolvedValue(page([BOLT]));
  listSets.mockReset().mockResolvedValue([]);
  deckGet.mockReset().mockResolvedValue(null);
  deckAddCard.mockReset().mockResolvedValue({ id: 7, quantity: 1, removed: false });
  prefetchImages.mockReset().mockResolvedValue(undefined);
});

/**
 * One of the deck's categories, as `deck_get` answers it.
 *
 * Local rather than borrowed — `.storybook/fake/fixtures.ts` is the Storybook fake's — and only
 * two fields matter to this panel: the `id` an add is addressed by and the `name` the select
 * and every Add button read.
 */
function category(over: Partial<DeckCategory> = {}): DeckCategory {
  return {
    id: 1,
    deckId: 4,
    name: "Main deck",
    kind: "main",
    // Before the spread so a caller may override it. This panel never reads it — it offers
    // every category by name whatever made them — but the DTO carries it, and a fixture that
    // lied about the shape would be the wrong kind of local.
    origin: "user",
    isActive: true,
    sortOrder: 0,
    cardCount: 0,
    totalPrice: null,
    cardCountAllVariants: over.cardCount ?? 0,
    ...over,
  };
}

const MAIN = category();
const SIDE = category({ id: 2, name: "Sideboard", kind: "side", sortOrder: 1 });
const MAYBE = category({ id: 5, name: "Maybeboard", kind: "maybe", isActive: false, sortOrder: 4 });

/**
 * A deck's format as the editor hands it down — the `legalities` key the backend filters by,
 * and the word the picker draws it as.
 *
 * One of `FORMATS`' seven on purpose. Folding an *unlisted* key into the option list is
 * `useCardSearch`'s and `FilterBar`'s to be right about, and a fixture reaching for one here
 * would make this file's claims fail for their reasons rather than for this panel's.
 */
const COMMANDER: FormatFilterOption = { value: "commander", label: "Commander" };

/** What the editor hands down for a deck with the seeded piles and nothing of the reader's
 *  own yet. */
const SEEDED: DeckCategory[] = [MAIN, SIDE, MAYBE];

/**
 * The panel with the editor's own write behind it.
 *
 * The mutation is a prop — the editor holds `useDeck` and hands `addCard` down, so that one
 * open deck is one `deck_get` — and this stands in for the editor holding it.
 */
interface Props {
  categories: DeckCategory[];
  targetCategoryId: number;
  roomy: boolean;
  defaultFormat?: FormatFilterOption | null;
}

function Harness({
  onTargetCategoryChange,
  ...props
}: Props & { onTargetCategoryChange: (categoryId: number) => void }) {
  const deck = useDeck(4);
  return (
    <DeckSearchPanel
      add={deck.addCard}
      onTargetCategoryChange={onTargetCategoryChange}
      {...props}
    />
  );
}

function panel({
  categories = SEEDED,
  targetCategoryId = MAIN.id,
  roomy = true,
  // `null` rather than an omission, because `null` is what the editor actually sends for a deck
  // it has no format to seed the search with — the annotation is what keeps the other cases
  // assignable.
  defaultFormat = null as FormatFilterOption | null,
  onTargetCategoryChange = vi.fn(),
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let props: Props = { categories, targetCategoryId, roomy, defaultFormat };
  const ui = (p: Props) => (
    <QueryClientProvider client={client}>
      <Harness {...p} onTargetCategoryChange={onTargetCategoryChange} />
    </QueryClientProvider>
  );
  const view = render(ui(props));
  /** Re-render with one prop changed — what the editor does when the select moves, or when it
   *  re-measures the row the deck and the panel share. */
  const update = (patch: Partial<Props>) => {
    props = { ...props, ...patch };
    view.rerender(ui(props));
  };
  return {
    ...view,
    onTargetCategoryChange,
    update,
    retarget: (categoryId: number) => update({ targetCategoryId: categoryId }),
  };
}

/**
 * What the target-category select offers, by name.
 *
 * Read off the select rather than by `role: "option"`: the filter bar's format picker sits in
 * the same panel and offers a "Commander" of its own, which is a format and not a category.
 */
const categoryOptions = (): string[] => {
  const select = screen.getByLabelText("Add to") as HTMLSelectElement;
  return [...select.options].map((o) => o.textContent ?? "");
};

/**
 * The filter row's Format select, reached by its label the way "Add to" is above.
 *
 * `FilterBar`'s own, drawn inside this panel and named by an `sr-only` "Format" — the row's
 * other controls are deliberately worded to keep clear of that word (`FilterBar.tsx`'s
 * "Unplayable" says "legal nowhere" for exactly this reason), so the exact string matches one
 * control here.
 */
const formatSelect = (): HTMLSelectElement => screen.getByLabelText("Format") as HTMLSelectElement;

describe("DeckSearchPanel", () => {
  /** The search view's own parts, in a column: not a second search implementation. */
  it("renders the search filters and the results as a wall of art", async () => {
    panel();

    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Color identity" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Mana value" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
  });

  /**
   * The panel is always a wall of art — it is 384px wide and there is no table in it — so the
   * layout pair would be a control that changes the *search view* and nothing the reader can
   * see from here.
   */
  it("leaves the grid-or-table choice to the search view", async () => {
    panel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    expect(screen.queryByRole("button", { name: "Table view" })).not.toBeInTheDocument();
  });

  /**
   * No default is `Any format`, which is the search every other surface mounting this hook
   * gets: `SearchPage` and the collection row pass no default at all, and a panel handed none
   * has to be the browse this app has always opened on. It is also the editor's own answer
   * while the format seed is still loading and for a deck with no legality data to filter by,
   * so this is a live state rather than only a test's.
   */
  it("opens on Any format when it is handed no default", async () => {
    panel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    expect(formatSelect()).toHaveValue("");
  });

  /**
   * A deck is built out of the cards it may legally hold, so the wall beside it starts there
   * rather than at the whole corpus.
   *
   * The label as well as the value, because the two fail differently. A select holding a key
   * none of its options carries reports the **first** option instead — `Any format`, pinned at
   * the top of this list — so `value` reads back `""` and the first assertion below does catch
   * it. What that one cannot say is which word is on screen, and the word is the whole of what
   * the reader has; the second assertion is for that.
   */
  it("opens on the deck's own format when it is handed one", async () => {
    panel({ defaultFormat: COMMANDER });
    await screen.findByRole("button", { name: "Lightning Bolt" });

    const select = formatSelect();
    expect(select).toHaveValue(COMMANDER.value);
    expect(select.selectedOptions[0]).toHaveTextContent(COMMANDER.label);
  });

  /**
   * **A default and not a constraint** — the request's second sentence, and the half a seeded
   * filter is easiest to get wrong.
   *
   * The reader may move the select anywhere, including to a format this deck is not legal in,
   * and the search that comes back is the one they asked for. A card the deck's format does not
   * allow is `validation/engine.ts`'s `RULE BREAK` to draw once it is in the deck; a search
   * that would not show it in the first place would be this panel enforcing a rule it does not
   * own. `Any format` is one press further, which is the way back to the whole corpus.
   */
  it("lets the reader move the select off the deck's format, and keeps searching", async () => {
    panel({ defaultFormat: COMMANDER });
    await screen.findByRole("button", { name: "Lightning Bolt" });

    await userEvent.selectOptions(formatSelect(), "modern");

    expect(formatSelect()).toHaveValue("modern");
    await waitFor(() =>
      expect(searchCards).toHaveBeenCalledWith(expect.objectContaining({ format: "modern" })),
    );
    expect(await screen.findByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();

    await userEvent.selectOptions(formatSelect(), "");

    expect(formatSelect()).toHaveValue("");
    await waitFor(() =>
      expect(searchCards).toHaveBeenCalledWith(expect.objectContaining({ format: undefined })),
    );
  });

  /**
   * The select is the click path's category choice and therefore the keyboard's, which is what
   * makes drag optional. Its options are the deck's own categories in the order the editor
   * draws its columns — and its **value is an id**, because that is what an add is addressed
   * by now that a category's name is the reader's to change.
   */
  it("offers the deck's own categories as targets, in the editor's order", () => {
    panel();

    expect(screen.getByLabelText("Add to")).toHaveValue(String(MAIN.id));
    expect(categoryOptions()).toEqual([
      // Not a category, first, and the editor's default — where a card is filed by its own type
      // line (`AUTO_CATEGORY`). This panel is driven with an explicit `targetCategoryId` here,
      // which is why the value above is still `MAIN`.
      "Auto (by what it does)",
      "Main deck",
      "Sideboard",
      "Maybeboard",
    ]);
  });

  /** The other half of the same rule, and the reason the list is a prop: the categories are
   *  the deck's own rows, so one deck has a pile another has never made. */
  it("offers exactly the categories it is handed, and no others", () => {
    const seeded = panel();
    expect(categoryOptions()).not.toContain("Ramp");
    seeded.unmount();

    panel({ categories: [MAIN, category({ id: 9, name: "Ramp", sortOrder: 2 })] });
    expect(categoryOptions()).toEqual(["Auto (by what it does)", "Main deck", "Ramp"]);
  });

  /**
   * The tile is the drag's handle, and what it carries is the card it is showing.
   *
   * The registration is the half that can go wrong silently — a wall builds its own tiles, so
   * the panel reaches them through one callback ref, and a callback that closed over the wrong
   * card would drag a card the reader is not touching. So this asks the drag itself rather
   * than the `draggable="true"` attribute: pick the tile up, and read what the library was
   * handed. Where the card *lands* is the group's business (`views/views.test.tsx`) and the
   * whole gesture is the editor's (`DeckEditor.test.tsx`).
   */
  it("hands each drawn tile to the drag adapter, carrying the card it draws", async () => {
    const { container } = panel();
    const art = await screen.findByRole("button", { name: "Lightning Bolt" });

    const tiles = [...container.querySelectorAll('[draggable="true"]')];
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toContainElement(art);

    const carried: Record<string, unknown>[] = [];
    const stop = monitorForElements({ onDragStart: ({ source }) => carried.push(source.data) });
    const held = await startDrag(tiles[0]);
    await held.cancel();
    stop();

    expect(carried.map(readDragData)).toEqual([
      // The type line rides along even though every drop target *inside* the editor names its
      // own category: a tile can also be let go on the sidebar's Decks entry, which names none.
      { kind: "search-card", cardId: BOLT.id, name: BOLT.name, typeLine: BOLT.typeLine },
    ]);
  });

  /**
   * The tile's one control keeps its press.
   *
   * The same guard the deck rows need (`cardDraggable`), for the same reason: the press
   * lands on the button and the `dragstart` lands on the tile, so a press that slips a few
   * pixels would add nothing and drag instead. The tile's *art* is a button too and is
   * deliberately still a drag handle — the exclusion is marked, not guessed from the tag.
   */
  it("does not drag a tile when the press landed on its Add button", async () => {
    const { container } = panel();
    const add = await screen.findByRole("button", { name: "Add Lightning Bolt to Main deck" });
    const tile = container.querySelector('[draggable="true"]')!;

    const held = await startDrag(tile, { pressOn: add });
    expect(held.started).toBe(false);
    await held.cancel();

    const art = screen.getByRole("button", { name: "Lightning Bolt" });
    const again = await startDrag(tile, { pressOn: art });
    expect(again.started).toBe(true);
    await again.cancel();
  });

  /**
   * One copy, into the category the header names. `deck_add_card` folds it into whatever is
   * already there, so pressing twice is two copies rather than an error.
   *
   * The `null` in the middle is the command's other arm going unused: `deck_add_card` takes
   * either a category **id** or a **name** to find-or-create, and a panel that has a column to
   * point at always sends the id (`useDeck`'s `DEFAULT_CATEGORY_NAME` is for the surfaces that
   * do not).
   */
  it("adds one copy of a card to the target category", async () => {
    panel();

    await userEvent.click(
      await screen.findByRole("button", { name: "Add Lightning Bolt to Main deck" }),
    );

    expect(deckAddCard).toHaveBeenCalledWith(4, "1", MAIN.id, null, "live", 1);
  });

  it("adds to whichever category is picked, and says so on the button", async () => {
    const view = panel();
    await screen.findByRole("button", { name: "Add Lightning Bolt to Main deck" });

    view.retarget(SIDE.id);
    await userEvent.click(screen.getByRole("button", { name: "Add Lightning Bolt to Sideboard" }));

    expect(deckAddCard).toHaveBeenCalledWith(4, "1", SIDE.id, null, "live", 1);
  });

  /** A `<select>` speaks strings and a category is addressed by number, so the parse back is
   *  the panel's own job and the editor is handed an id it can write with. */
  it("hands the category choice back to the editor as an id", async () => {
    const view = panel();

    await userEvent.selectOptions(screen.getByLabelText("Add to"), String(SIDE.id));

    expect(view.onTargetCategoryChange).toHaveBeenCalledWith(SIDE.id);
  });

  /**
   * A picked id the handed-down list does not hold, which is a single commit's worth of state:
   * a category deleted elsewhere reaches the editor's clamp and this select together, and
   * nothing orders those two.
   *
   * The button says what it can honestly say rather than reading `.name` off `undefined` and
   * taking the whole panel down over a label.
   */
  it("names the deck rather than crashing when the picked category is not in the list", async () => {
    panel({ targetCategoryId: 404 });

    expect(
      await screen.findByRole("button", { name: "Add Lightning Bolt to this deck" }),
    ).toBeInTheDocument();
  });

  /** The result still tells the collection story: a card already in the binder is a card the
   *  deck can be built out of today. */
  it("marks a result with what the collection holds", async () => {
    panel();

    expect(await screen.findByText("×3")).toBeInTheDocument();
  });

  /**
   * The crown, on the one wall a Commander deck is actually built out of.
   *
   * `gameChanger` is a fact about the *card*, so this panel says it exactly as the search view
   * does — a card marked on one wall and bare on the other would be the reader learning that the
   * mark means something about the view. Named rather than shaped: the mark's accessible name is
   * the whole of what a screen reader gets from a 12px glyph.
   *
   * And it lands on the card it is about. Two tiles on one wall is the only arrangement that can
   * catch a mark drawn per *wall* instead of per card, which a callback closing over the wrong
   * row would be — the same failure `tileRef` is asked about above.
   */
  it("crowns a game changer, and leaves the tile beside it unmarked", async () => {
    searchCards.mockResolvedValue(page([BOLT, RHYSTIC_STUDY]));
    const { container } = panel();
    const crowned = await screen.findByRole("button", { name: "Rhystic Study" });

    const marks = screen.getAllByLabelText("Game changer");
    expect(marks).toHaveLength(1);
    const tiles = [...container.querySelectorAll('[draggable="true"]')];
    expect(tiles).toHaveLength(2);
    const crownedTile = tiles.find((tile) => tile.contains(crowned))!;
    expect(crownedTile).toContainElement(marks[0]);
  });

  /** The tiles stay selectable, so the card pane keeps working from inside the editor. */
  it("opens the card in the pane from a tile", async () => {
    panel();

    await userEvent.click(await screen.findByRole("button", { name: "Lightning Bolt" }));

    expect(useAppStore.getState().selectedCardId).toBe("1");
  });

  /** The editor has to be usable at 1024px with the card pane docked beside it, and 384px of
   *  search is what has to give. */
  it("collapses to a rail that says what it is, and opens again", async () => {
    panel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    await userEvent.click(screen.getByRole("button", { name: "Search cards" }));

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    const rail = screen.getByRole("button", { name: "Search cards" });
    expect(rail).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(rail);

    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
  });

  /**
   * The editor measures the row the two of them share and says whether there is room. With
   * none, the rail is what is drawn whatever the reader last chose — and the disclosure is
   * disabled, because a press could not open anything and a control that records an intention
   * and moves nothing is worse than one that says why.
   */
  it("draws its rail, refused and explained, when the editor has no room for it", async () => {
    const view = panel({ roomy: false });

    const rail = screen.getByRole("button", { name: "Search cards" });
    expect(rail).toHaveAttribute("aria-expanded", "false");
    expect(rail).toHaveAttribute("title", expect.stringMatching(/not enough room/i));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

    // `aria-disabled` and a press that does nothing, never the `disabled` attribute: a
    // disabled button leaves the tab order, and the reason for the refusal would then be
    // reachable only by hovering — which is not something a keyboard has.
    expect(rail).toHaveAttribute("aria-disabled", "true");
    expect(rail).not.toBeDisabled();
    rail.focus();
    expect(rail).toHaveFocus();

    // And "does nothing" has to include not quietly flipping the reader's own choice: a press
    // that toggled it would look inert here and then keep the panel shut when the room came
    // back, which is the reader being answered by a control they never operated.
    await userEvent.click(rail);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

    view.update({ roomy: true });

    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
  });

  /**
   * The panel is what took the caret away, so the panel is what gives it somewhere to go.
   *
   * At 1024 a tile press opens the card pane, the pane's arrival squeezes this panel down to
   * its rail, and the tile that was pressed unmounts with it — so `CardDetailPane`'s hand-back
   * finds an opener that is not connected, and Escape drops the caret on `<body>` with the next
   * Tab restarting from the top of the app.
   */
  it("takes the caret when the pane closes and the tile that opened it has gone", async () => {
    const view = panel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    // The card opens, and its arrival is what squeezes the panel out.
    act(() => useAppStore.setState({ selectedCardId: "1" }));
    view.update({ roomy: false });
    // The pane closes with the caret on it and nothing connected to hand it back to.
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => useAppStore.setState({ selectedCardId: null }));

    expect(screen.getByRole("button", { name: "Search cards" })).toHaveFocus();

    // And it is still there one commit later, when the width the closing pane gave back
    // reopens the panel around it. The disclosure is one node across both states for exactly
    // this: two shapes would mean a fresh button here, and the caret back on `<body>`.
    view.update({ roomy: true });

    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search cards" })).toHaveFocus();
  });

  /** And it does not steal one: an opener still on screen has already been handed the caret
   *  back, which is where the reader was. */
  it("leaves the caret alone when something else still has it", async () => {
    const view = panel();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);

    act(() => useAppStore.setState({ selectedCardId: "1" }));
    view.update({ roomy: false });
    elsewhere.focus();
    act(() => useAppStore.setState({ selectedCardId: null }));

    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });

  /**
   * The two states are kept apart on purpose: the measurement decides what is *drawn*, the
   * reader decides what they *want*. So a panel that was pushed aside by a card pane comes
   * back when the pane closes, and one the reader shut stays shut.
   */
  it("comes back when the room does, unless the reader was the one who shut it", async () => {
    const view = panel();
    await screen.findByRole("searchbox", { name: "Search cards" });

    view.update({ roomy: false });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    view.update({ roomy: true });
    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Search cards" }));
    view.update({ roomy: false });
    view.update({ roomy: true });

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  /**
   * The Escape stack, from inside the panel: the set picker is an `"inner"` layer and consumes
   * its press in the capture phase, and the next press reaches `window` untouched — which is
   * where the card detail pane listens, in the bubble phase. Observed in the running window;
   * this is what holds it.
   */
  it("spends the first Escape on the set picker and lets the second through to the pane", async () => {
    listSets.mockResolvedValue([
      {
        code: "lea",
        name: "Limited Edition Alpha",
        setType: "core",
        releasedAt: "1993-08-05",
        cardCount: 295,
      },
    ]);
    panel();
    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    await screen.findByRole("combobox", { name: /search sets/i });

    const heard: boolean[] = [];
    // The bubble phase, which is the rung the card pane is on.
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("combobox", { name: /search sets/i })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    window.removeEventListener("keydown", listen);

    // Consumed, then not: one layer per press, and the panel itself is not one of them.
    expect(heard).toEqual([true, false]);
  });

  /** A refused add is said in the app's own words, where the reader is looking. */
  it("says so when an add is refused", async () => {
    deckAddCard.mockRejectedValue("The database is busy with a sync — try again in a moment.");
    panel();

    await userEvent.click(
      await screen.findByRole("button", { name: "Add Lightning Bolt to Main deck" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("The database is busy with a sync");
  });

  /**
   * The search view warms the page it just fetched because a 1 200px wall shows forty tiles at
   * once. Two tiles per row is not that wall: the grid's own overscan mounts the next two rows
   * of `<img>`s, which is the same warming by a shorter path.
   */
  it("leaves image warming to the grid's overscan", async () => {
    panel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    expect(prefetchImages).not.toHaveBeenCalled();
  });
});
