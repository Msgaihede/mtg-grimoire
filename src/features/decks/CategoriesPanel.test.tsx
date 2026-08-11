import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DeckCategory, DeckDetail, DeckRow, DeckTag, TagSuggestion } from "@/lib/ipc";
import { startDrag } from "@/test-drag";

const deckCategoryList = vi.hoisted(() => vi.fn());
const deckCategoryCreate = vi.hoisted(() => vi.fn());
const deckCategoryRename = vi.hoisted(() => vi.fn());
const deckCategorySetActive = vi.hoisted(() => vi.fn());
const deckCategoryReorder = vi.hoisted(() => vi.fn());
const deckCategoryDelete = vi.hoisted(() => vi.fn());
const deckTagList = vi.hoisted(() => vi.fn());
const deckTagCreate = vi.hoisted(() => vi.fn());
const deckTagUpdate = vi.hoisted(() => vi.fn());
const deckTagDelete = vi.hoisted(() => vi.fn());
const deckTagSuggestions = vi.hoisted(() => vi.fn());
const deckGet = vi.hoisted(() => vi.fn());
const deckMoveCard = vi.hoisted(() => vi.fn());

// The fake sits under `ipc.ts` everywhere else in this repository; here it replaces the object,
// because these commands are what the panel *is* — every assertion below is about the argument
// one of them was handed. `importOriginal` keeps `ipcError`, which the panel renders refusals
// through.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckCategoryList,
    deckCategoryCreate,
    deckCategoryRename,
    deckCategorySetActive,
    deckCategoryReorder,
    deckCategoryDelete,
    deckTagList,
    deckTagCreate,
    deckTagUpdate,
    deckTagDelete,
    deckTagSuggestions,
    deckGet,
    deckMoveCard,
  },
}));

import { CategoriesPanel, movedTo } from "./CategoriesPanel";

/* --------------------------------------------------------------------- fixtures ------- */

function category(over: Partial<DeckCategory> & { id: number; name: string }): DeckCategory {
  return {
    deckId: 1,
    kind: "main",
    isActive: true,
    sortOrder: over.id,
    cardCount: 0,
    totalPriceUsd: null,
    ...over,
  };
}

/**
 * The four `schema::PREDEFINED_CATEGORIES` plus the two piles a reader made.
 *
 * The predefined four are named *and* kinded, because `isPredefined` is both — a user is free
 * to call a pile of their own "Sideboard", and that one is theirs to rename and delete.
 */
const CATEGORIES: DeckCategory[] = [
  category({ id: 1, name: "Commander", kind: "commander", sortOrder: 0 }),
  category({ id: 2, name: "Ramp", sortOrder: 1, cardCount: 12, totalPriceUsd: 34.5 }),
  category({ id: 3, name: "Removal", sortOrder: 2, cardCount: 9 }),
  category({ id: 4, name: "Sideboard", kind: "side", sortOrder: 3 }),
  category({ id: 5, name: "Maybeboard", kind: "maybe", isActive: false, sortOrder: 4 }),
];

const TAGS: DeckTag[] = [
  { id: 10, deckId: 1, name: "Cut candidate", color: "ember", cardCount: 3 },
  { id: 11, deckId: 1, name: "Playtest", color: "azure", cardCount: 0 },
];

const SUGGESTIONS: TagSuggestion[] = [
  { name: "Cut candidate", color: "ember" },
  { name: "Budget swap", color: "moss" },
];

/** The deck row `deck_get` answers with. Nothing on this panel reads a field of it — the one
 *  thing the drawer wants out of `deck_get` is `cards`, for the auto-categoriser. */
const DECK_ROW: DeckRow = {
  id: 1,
  name: "Serah's Toolbox",
  formatKey: "commander",
  formatName: "Commander",
  description: null,
  coverCardId: null,
  coverKind: "card_art",
  coverArtist: null,
  isBuilt: false,
  archived: false,
  cardCount: 21,
  updatedAt: 0,
  folderId: null,
  notes: null,
  theoryEnabled: false,
};

const DECK: DeckDetail = { deck: DECK_ROW, cards: [], categories: CATEGORIES, tags: TAGS };

function mount(props: Partial<Parameters<typeof CategoriesPanel>[0]> = {}) {
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <CategoriesPanel
        deckId={1}
        variant="live"
        open
        onDismiss={onDismiss}
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...view, onDismiss, onClose };
}

/** The row for one category, by the name its heading carries. */
function row(name: string): HTMLElement {
  const heading = screen.getByText(name);
  const li = heading.closest("li");
  if (!li) throw new Error(`No row for ${name}`);
  return li;
}

beforeEach(() => {
  vi.clearAllMocks();
  deckCategoryList.mockResolvedValue(CATEGORIES);
  deckTagList.mockResolvedValue(TAGS);
  deckTagSuggestions.mockResolvedValue(SUGGESTIONS);
  deckGet.mockResolvedValue(DECK);
  deckCategoryCreate.mockResolvedValue(category({ id: 6, name: "Draw" }));
  deckCategoryRename.mockResolvedValue(category({ id: 2, name: "Acceleration" }));
  deckCategorySetActive.mockResolvedValue(category({ id: 5, name: "Maybeboard" }));
  deckCategoryReorder.mockResolvedValue(CATEGORIES);
  deckCategoryDelete.mockResolvedValue(undefined);
  deckTagCreate.mockResolvedValue(TAGS[0]);
  deckTagUpdate.mockResolvedValue(TAGS[0]);
  deckTagDelete.mockResolvedValue(undefined);
});

/* ------------------------------------------------------------------- the reorder ------- */

describe("movedTo", () => {
  it("moves an id to a position, closing the gap it left", () => {
    expect(movedTo([1, 2, 3, 4], 2, 0)).toEqual([2, 1, 3, 4]);
    expect(movedTo([1, 2, 3, 4], 2, 3)).toEqual([1, 3, 4, 2]);
  });

  /**
   * The keyboard asks for `index - 1` on the first row and `index + 1` on the last, every time
   * the reader presses one more than there is list. Clamping there is what makes the handler a
   * two-line `onKeyDown` instead of a bounds check at each of the two call sites — and what
   * keeps `splice` from being handed a `-1`, which inserts from the *other* end.
   */
  it("clamps a position off either end rather than wrapping", () => {
    expect(movedTo([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
    expect(movedTo([1, 2, 3], 3, 9)).toEqual([1, 2, 3]);
  });

  it("answers a copy for an id the list does not hold", () => {
    const ids = [1, 2, 3];
    expect(movedTo(ids, 99, 0)).toEqual(ids);
    expect(movedTo(ids, 99, 0)).not.toBe(ids);
  });
});

/* ----------------------------------------------------------------------- drawer ------- */

describe("CategoriesPanel", () => {
  it("draws nothing at all when it is closed", () => {
    const { container } = mount({ open: false });
    expect(container).toBeEmptyDOMElement();
    // Not merely hidden: a closed drawer must cost no query, which is what lets the editor
    // mount it unconditionally.
    expect(deckCategoryList).not.toHaveBeenCalled();
  });

  it("reads both lists for the variant it was given", async () => {
    mount({ variant: "theory" });
    await screen.findByText("Ramp");
    expect(deckCategoryList).toHaveBeenCalledWith(1, "theory");
    expect(deckTagList).toHaveBeenCalledWith(1, "theory");
  });

  /**
   * The two rules that are not guessable from the controls, spelled out where the controls are.
   * Asserted on the *sentence* rather than on a class: this is copy the panel exists to carry.
   */
  it("says what an inactive category costs and where the suggestions come from", async () => {
    mount();
    expect(
      await screen.findByText(/Only active categories count toward the deck/),
    ).toBeInTheDocument();
    expect(screen.getByText(/come from\s+every deck you have/)).toBeInTheDocument();
  });

  it("closes and hands focus back on Escape, consuming the press", async () => {
    const { onDismiss, onClose } = mount();
    await screen.findByText("Ramp");

    const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    window.dispatchEvent(press);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    // The `"inner"` half of the handshake: an outer layer reads this and stands down, so one
    // press closes one layer.
    expect(press.defaultPrevented).toBe(true);
  });

  it("closes without moving focus when the press lands outside the drawer", async () => {
    const { onDismiss, onClose } = mount();
    const drawer = await screen.findByRole("dialog", { name: "Categories and tags" });
    const user = userEvent.setup();

    await user.click(within(drawer).getByRole("heading", { name: "Categories" }));
    expect(onClose).not.toHaveBeenCalled();

    const scrim = drawer.parentElement;
    if (!scrim) throw new Error("no scrim");
    await user.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------- categories ------- */

describe("categories", () => {
  /**
   * `RULE` is `GroupHeader`'s decision and this panel renders that component rather than
   * drawing its own line, so the marker cannot come to mean one thing in a column heading and
   * another here. The Maybeboard is the case worth pinning: it is predefined, and it carries
   * `INACTIVE` instead — `RULE` is *not* "predefined and undeletable".
   */
  it("marks the piles the rules read by name, and the Maybeboard by its switch", async () => {
    mount();
    await screen.findByText("Ramp");

    expect(within(row("Commander")).getByText("RULE")).toBeInTheDocument();
    expect(within(row("Sideboard")).getByText("RULE")).toBeInTheDocument();
    expect(within(row("Maybeboard")).queryByText("RULE")).not.toBeInTheDocument();
    expect(within(row("Maybeboard")).getByText("INACTIVE")).toBeInTheDocument();
    expect(within(row("Ramp")).queryByText("RULE")).not.toBeInTheDocument();
  });

  it("shows each pile's copies and its money", async () => {
    mount();
    await screen.findByText("Ramp");
    expect(within(row("Ramp")).getByText("12 cards")).toBeInTheDocument();
    expect(within(row("Ramp")).getByText("$34.50")).toBeInTheDocument();
  });

  /**
   * The whole of the predefined rule, in one test, because the two halves are easy to get
   * wrong in opposite directions: the backend refuses a rename and a delete on all four, and
   * refuses **nothing** about the switch — the Commander included.
   */
  it("offers no rename or delete on a predefined pile, and a working switch on every one", async () => {
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    for (const name of ["Commander", "Sideboard", "Maybeboard"]) {
      expect(within(row(name)).queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
      expect(within(row(name)).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    }
    expect(within(row("Ramp")).getByRole("button", { name: "Rename" })).toBeInTheDocument();

    await user.click(within(row("Commander")).getByRole("button", { name: /^Active/ }));
    expect(deckCategorySetActive).toHaveBeenCalledWith(1, false);

    await user.click(within(row("Maybeboard")).getByRole("button", { name: /^Inactive/ }));
    expect(deckCategorySetActive).toHaveBeenCalledWith(5, true);
  });

  it("adds a category by name, and clears the field on the way out", async () => {
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    const field = screen.getByLabelText("New category name");
    await user.type(field, "  Draw  ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    // Trimmed: `(deckId, name)` is the grain, and " Draw" and "Draw" would be two piles.
    expect(deckCategoryCreate).toHaveBeenCalledWith(1, "Draw");
    await waitFor(() => expect(field).toHaveValue(""));
  });

  it("renames a pile the reader made", async () => {
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    await user.click(within(row("Ramp")).getByRole("button", { name: "Rename" }));
    const field = await screen.findByLabelText("Rename Ramp");
    await user.clear(field);
    await user.type(field, "Acceleration");
    await user.click(within(row("Ramp")).getByRole("button", { name: "Save" }));

    expect(deckCategoryRename).toHaveBeenCalledWith(2, "Acceleration");
  });

  /* ------------------------------------------------------------------- reorder ------- */

  it("moves a category with the arrow keys and sends the whole new order", async () => {
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    const handle = screen.getByRole("button", { name: "Move Ramp, 2 of 5" });
    handle.focus();
    await user.keyboard("{ArrowDown}");

    // Every id, from position — `deck_category_reorder` writes `sortOrder` from the list it is
    // given and is not a move.
    expect(deckCategoryReorder).toHaveBeenCalledWith(1, [1, 3, 2, 4, 5]);
    // And it shows immediately, rather than after the round trip: the row's own name says where
    // it now is.
    await screen.findByRole("button", { name: "Move Ramp, 3 of 5" });
  });

  it("puts the order back when the reorder is refused", async () => {
    deckCategoryReorder.mockRejectedValue("The database is busy.");
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    screen.getByRole("button", { name: "Move Ramp, 2 of 5" }).focus();
    await user.keyboard("{ArrowDown}");

    await screen.findByRole("button", { name: "Move Ramp, 2 of 5" });
    expect(await screen.findByRole("alert")).toHaveTextContent("The database is busy.");
  });

  /**
   * The drag, over the library's real code path — `test-drag.ts`'s header has why that is
   * possible in jsdom at all. What it proves is the rule: a drop **lands the dragged row where
   * the target row is**, which is the same move the arrow keys make.
   */
  it("reorders on a drop, and only from the handle", async () => {
    mount();
    await screen.findByText("Ramp");

    const source = row("Removal");
    const handle = within(source).getByRole("button", { name: "Move Removal, 3 of 5" });

    const refused = await startDrag(source);
    expect(refused.started).toBe(false);
    await refused.cancel();
    expect(deckCategoryReorder).not.toHaveBeenCalled();

    const held = await startDrag(source, { pressOn: handle });
    try {
      expect(held.started).toBe(true);
      await held.over(row("Commander"));
      await held.drop();
    } finally {
      await held.cancel();
    }

    expect(deckCategoryReorder).toHaveBeenCalledWith(1, [3, 1, 2, 4, 5]);
  });

  it("refuses to drop a category onto itself", async () => {
    mount();
    await screen.findByText("Ramp");
    const source = row("Ramp");
    const handle = within(source).getByRole("button", { name: "Move Ramp, 2 of 5" });

    const held = await startDrag(source, { pressOn: handle });
    try {
      await held.over(source);
      await held.drop();
    } finally {
      await held.cancel();
    }
    expect(deckCategoryReorder).not.toHaveBeenCalled();
  });

  /* -------------------------------------------------------------------- delete ------- */

  /**
   * The one destructive control on the drawer, and the thing this dialog exists to make
   * unmistakable: `moveToCategoryId: null` takes the cards with the category by cascade, and an
   * id moves them first in the same transaction. The safe answer is the default.
   */
  it("defaults a delete to moving the cards, and says where they go", async () => {
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    await user.click(within(row("Ramp")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Ramp" });

    expect(within(dialog).getByText(/move to “Commander”\. Nothing is lost/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Move 12 cards and delete" }));

    expect(deckCategoryDelete).toHaveBeenCalledWith(2, 1);
  });

  it("says the cards go too when the reader picks the destructive answer", async () => {
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    await user.click(within(row("Ramp")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Ramp" });
    await user.selectOptions(within(dialog).getByLabelText("Its 12 cards"), "delete");

    expect(within(dialog).getByText(/are deleted too\. This cannot be undone/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete “Ramp”" }));

    expect(deckCategoryDelete).toHaveBeenCalledWith(2, null);
  });

  it("asks no question about an empty pile", async () => {
    deckCategoryList.mockResolvedValue([
      CATEGORIES[0],
      category({ id: 7, name: "Draw", sortOrder: 1 }),
    ]);
    mount();
    await screen.findByText("Draw");
    const user = userEvent.setup();

    await user.click(within(row("Draw")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Draw" });
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(dialog).getByText("It is empty, so nothing goes with it.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Delete “Draw”" }));
    expect(deckCategoryDelete).toHaveBeenCalledWith(7, null);
  });

  /* ---------------------------------------------------------------- auto-file ------- */

  it("hands the deck's own rows to the auto-categoriser and counts what moved", async () => {
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Auto-categorise from card types" }));
    // An empty deck moves nothing, which is the sentence a reader needs — the drawer draws no
    // cards, so without a count there is no way to tell a no-op from a failure.
    expect(await screen.findByText(/Nothing to file/)).toBeInTheDocument();
    expect(deckGet).toHaveBeenCalledWith(1, "live");
  });
});

/* ------------------------------------------------------------------------ tags ------- */

describe("tags", () => {
  it("lists a deck's tags with their colour and their copies", async () => {
    mount();
    const tag = await screen.findByText("Cut candidate");
    const li = tag.closest("li");
    expect(li).not.toBeNull();
    expect(within(li as HTMLElement).getByText("3 cards")).toBeInTheDocument();
  });

  /** `deck_tag_update` renames **and** recolours in one command and has no patch shape, so the
   *  field has to send a colour back even when only the name changed. */
  it("sends both the name and the colour on a rename", async () => {
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();
    const li = screen.getByText("Cut candidate").closest("li") as HTMLElement;

    await user.click(within(li).getByRole("button", { name: "Rename" }));
    const field = await within(li).findByLabelText("Rename Cut candidate");
    await user.clear(field);
    await user.type(field, "On the block");
    await user.click(within(li).getByRole("button", { name: "Save" }));

    expect(deckTagUpdate).toHaveBeenCalledWith(10, "On the block", "ember");
  });

  it("says a deleted tag keeps its cards", async () => {
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();
    const li = screen.getByText("Cut candidate").closest("li") as HTMLElement;

    await user.click(within(li).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Cut candidate" });
    // `deck_cards.tag_id` is `ON DELETE SET NULL`: the cards are untagged, never deleted.
    expect(within(dialog).getByText(/cards stay in the deck and lose the label/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Delete tag" }));
    expect(deckTagDelete).toHaveBeenCalledWith(10);
  });

  it("makes a tag of this deck from a suggestion, and offers no name it already has", async () => {
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();

    expect(screen.queryByRole("button", { name: "Add tag Cut candidate" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add tag Budget swap" }));

    // The suggestion's own colour travels with it — a name used across decks reads the same
    // colour in each.
    expect(deckTagCreate).toHaveBeenCalledWith(1, "Budget swap", "moss");
  });

  it("makes a first tag from the field, in the colour the picker is on", async () => {
    deckTagList.mockResolvedValue([]);
    deckTagSuggestions.mockResolvedValue([]);
    mount();
    await screen.findByText("No tags yet.");
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("New tag name"), "Playtest");
    await user.click(screen.getByRole("button", { name: "Moss" }));
    await user.click(screen.getByRole("button", { name: "Add tag" }));

    // A token, never a hex string: a stored colour has to outlive the theme that chose it.
    expect(deckTagCreate).toHaveBeenCalledWith(1, "Playtest", "moss");
  });

  it("says why a refusal happened rather than losing it", async () => {
    deckTagDelete.mockRejectedValue("That tag is not this deck's.");
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();
    const li = screen.getByText("Cut candidate").closest("li") as HTMLElement;

    await user.click(within(li).getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete tag" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That tag is not this deck's.");
  });
});
