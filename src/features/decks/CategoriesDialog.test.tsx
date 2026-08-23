import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  DeckCard,
  DeckCategory,
  DeckDetail,
  DeckRow,
  DeckTag,
  GlobalTag,
} from "@/lib/ipc";
import { startDrag } from "@/test-drag";

const deckCategoryList = vi.hoisted(() => vi.fn());
const deckCategoryCreate = vi.hoisted(() => vi.fn());
const deckCategoryRename = vi.hoisted(() => vi.fn());
const deckCategorySetActive = vi.hoisted(() => vi.fn());
const deckCategoryReorder = vi.hoisted(() => vi.fn());
const deckCategoryDelete = vi.hoisted(() => vi.fn());
const deckGet = vi.hoisted(() => vi.fn());
const deckMoveCard = vi.hoisted(() => vi.fn());
/** What the auto-filer files by: the one read behind "File cards by what they do". */
const oracleTagsForPrintings = vi.hoisted(() => vi.fn());
/**
 * The tag reads, which this dialog draws nothing from.
 *
 * `useDeckMeta` is one hook over a deck's piles *and* its labels, so mounting it here fires the
 * tag queries too — the cost of the two dialogs sharing one hook, and cheap, because only one of
 * them is ever open. They are mocked so nothing rejects unhandled, and asserted nowhere in this
 * file: what they answer is `TagsDialog.test.tsx`'s subject.
 */
const deckTagList = vi.hoisted(() => vi.fn());
const deckTagAll = vi.hoisted(() => vi.fn());
const deckTagCreate = vi.hoisted(() => vi.fn());
const deckTagUpdate = vi.hoisted(() => vi.fn());
const deckTagDelete = vi.hoisted(() => vi.fn());

// The fake sits under `ipc.ts` everywhere else in this repository; here it replaces the object,
// because these commands are what the dialog *is* — every assertion below is about the argument
// one of them was handed. `importOriginal` keeps `ipcError`, which the body renders refusals
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
    deckTagAll,
    deckGet,
    deckMoveCard,
    oracleTagsForPrintings,
  },
}));

import { CategoriesDialog } from "./CategoriesDialog";
import { TagsDialog } from "./TagsDialog";

/* --------------------------------------------------------------------- fixtures ------- */

function category(over: Partial<DeckCategory> & { id: number; name: string }): DeckCategory {
  const row = {
    deckId: 1,
    kind: "main" as const,
    isActive: true,
    sortOrder: over.id,
    cardCount: 0,
    totalPrice: null,
    // The reader's, unless a test says otherwise. `create_category` and the four seeds both
    // write `'user'`; `'auto'` is the app filing a card, and the one test below that cares
    // passes it — this drawer draws all three classes alike and nothing here reads the field
    // except `groupOf`.
    origin: "user" as const,
    ...over,
  };
  // Both lists, defaulting to the one-list count: these fixtures are single-list decks unless
  // a test says otherwise, and the ones that say otherwise are the point — see
  // `quotes the copies in both lists…`.
  return { ...row, cardCountAllVariants: over.cardCountAllVariants ?? row.cardCount };
}

/**
 * The four `schema::PREDEFINED_CATEGORIES` plus the two piles a reader made.
 *
 * The predefined four are named *and* kinded, because `isPredefined` is both — a user is free
 * to call a pile of their own "Sideboard", and that one is theirs to rename and delete.
 */
const CATEGORIES: DeckCategory[] = [
  category({ id: 1, name: "Commander", kind: "commander", sortOrder: 0 }),
  category({ id: 2, name: "Ramp", sortOrder: 1, cardCount: 12, totalPrice: 34.5 }),
  category({ id: 3, name: "Removal", sortOrder: 2, cardCount: 9 }),
  category({ id: 4, name: "Sideboard", kind: "side", sortOrder: 3 }),
  category({ id: 5, name: "Maybeboard", kind: "maybe", isActive: false, sortOrder: 4 }),
];

/** Whatever the shared hook's tag reads answer — see the mock's doc. */
const TAGS: DeckTag[] = [
  { id: 10, name: "Cut candidate", color: "ember", cardCount: 3 },
];
const SUGGESTIONS: GlobalTag[] = [
  { id: 11, name: "Budget swap", color: "moss", cardCount: 4, deckCount: 2 },
];

/** The deck row `deck_get` answers with. Nothing on this dialog reads a field of it — the one
 *  thing it wants out of `deck_get` is `cards`, for the auto-categoriser. */
const DECK_ROW: DeckRow = {
  gameKey: "any",
  id: 1,
  name: "Serah's Toolbox",
  formatKey: "commander",
  formatName: "Commander",
  description: null,
  coverCardId: null,
  coverKind: "card_art",
  coverArtist: null,
  archived: false,
  cardCount: 21,
  updatedAt: 0,
  folderId: null,
  notes: null,
  theoryEnabled: false,
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  defaultCategoryId: 0,
};

const DECK: DeckDetail = { deck: DECK_ROW, cards: [], categories: CATEGORIES, tags: TAGS };

/**
 * A row in the deck's loose pile — the only shape the auto-filer acts on, and the only reason
 * this file needs a card fixture at all.
 *
 * Everything but the four fields it reads is filled so this is a real {@link DeckCard} rather
 * than a cast: the pile's name, whether the pile counts, which list it is in, and the type line
 * under the tags.
 */
function deckCard(over: Partial<DeckCard> & { cardId: string }): DeckCard {
  return {
    promoTypes: null,
    id: 1,
    categoryId: 9,
    categoryName: "Main deck",
    categoryKind: "main",
    categoryActive: true,
    finish: null,
    variant: "live",
    tagId: null,
    tagName: null,
    tagColor: null,
    quantity: 1,
    name: "Swords to Plowshares",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "1",
    lang: "en",
    needsReview: null,
    oracleId: "o1",
    manaCost: null,
    cmc: null,
    typeLine: "Instant",
    oracleText: null,
    colors: null,
    colorIdentity: null,
    legalities: null,
    power: null,
    toughness: null,
    layout: null,
    rarity: null,
    faces: null,
    gameChanger: null,
    finishes: null,
    everUncommon: false,
    unitPrice: null,
    ownedQuantity: 0,
    ...over,
  };
}

function mount(props: Partial<Parameters<typeof CategoriesDialog>[0]> = {}) {
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <CategoriesDialog
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
  deckTagAll.mockResolvedValue(SUGGESTIONS);
  deckGet.mockResolvedValue(DECK);
  deckCategoryCreate.mockResolvedValue(category({ id: 6, name: "Draw" }));
  deckCategoryRename.mockResolvedValue(category({ id: 2, name: "Acceleration" }));
  deckCategorySetActive.mockResolvedValue(category({ id: 5, name: "Maybeboard" }));
  deckCategoryReorder.mockResolvedValue(CATEGORIES);
  deckCategoryDelete.mockResolvedValue(undefined);
  deckTagCreate.mockResolvedValue(TAGS[0]);
  deckTagUpdate.mockResolvedValue(TAGS[0]);
  deckTagDelete.mockResolvedValue(undefined);
  // Nothing tagged: the shape of a database that has never ingested the taxonomy, which is a
  // supported way to run this app and not a failure. The tests about tags say otherwise.
  oracleTagsForPrintings.mockResolvedValue([]);
});

/* ----------------------------------------------------------------------- shell ------- */

describe("CategoriesDialog", () => {
  it("draws nothing at all when it is closed", () => {
    const { container } = mount({ open: false });
    expect(container).toBeEmptyDOMElement();
    // Not merely hidden: a closed dialog must cost no query, which is what lets the editor
    // mount it unconditionally beside five others.
    expect(deckCategoryList).not.toHaveBeenCalled();
    expect(deckGet).not.toHaveBeenCalled();
  });

  /**
   * **One wiring test, not a second copy of the shell's suite.** The scrim, the trap, the caret
   * moving into the panel and the `aria-modal` claim are all `Dialog`'s now and are tested
   * where they live. What is this file's business is that this dialog hands that shell the right
   * four things: a title, a close label that is a sentence, and the two different ways out.
   */
  it("is a dialog named Categories, dismissed by Escape and closed by the scrim", async () => {
    const { onDismiss, onClose } = mount();
    const dialog = await screen.findByRole("dialog", { name: "Categories" });
    expect(within(dialog).getByRole("button", { name: "Close categories" })).toBeInTheDocument();

    const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    window.dispatchEvent(press);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    // The `"inner"` half of the handshake: an outer layer reads this and stands down, so one
    // press closes one layer.
    expect(press.defaultPrevented).toBe(true);

    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("heading", { name: "Categories" }));
    expect(onClose).not.toHaveBeenCalled();

    const scrim = dialog.parentElement;
    if (!scrim) throw new Error("no scrim");
    await user.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    // A press outside closes without moving focus, which is the half that differs from Escape.
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("reads the deck's categories for the variant it was given", async () => {
    mount({ variant: "theory" });
    await screen.findByText("Ramp");
    expect(deckCategoryList).toHaveBeenCalledWith(1, "theory", "tcgplayer");
    expect(deckCategoryList).toHaveBeenCalledTimes(1);
  });

  /**
   * The rule that is not guessable from the controls, spelled out where the controls are.
   * Asserted on the *sentence* rather than on a class: this is copy the dialog exists to carry.
   */
  it("says what an inactive category costs", async () => {
    mount();
    expect(
      await screen.findByText(/Only active categories count toward the deck/),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------- the exit window ------- */

/**
 * The hazard an exit animation introduced, and the reason every one of the editor's dialogs
 * registers its Escape rung on the **flag** rather than on the panel's mount.
 *
 * The editor renders its dialogs unconditionally and holds "which one is up" in a single `Layer`
 * union, which is what guarantees that two `"inner"` rungs are never live at once. That guarantee
 * used to come free from synchronous unmounting: the flag went false and the listener came down
 * in the same commit. With an exit animation the *element* outlives the flag, so a rung
 * registered on the mount would go on consuming Escape for the length of the fade — spending the
 * press on a dialog the reader had already dismissed, and starving the layer behind it, since a
 * capture rung `preventDefault()`s and the card pane's bubble rung returns early on
 * `defaultPrevented`.
 *
 * **It takes two switches to catch, and that is the hook's stack's doing.** `useDismissOnEscape`
 * orders capture-phase registrations by mount depth now — only the token on top acts — so one
 * switch does not discriminate: with the rung on the panel's **mount**, the fading Categories
 * panel would still hold the token pushed at its original mount, the opening Tags panel would
 * push *above* it, and Tags would answer exactly as it does here. Correct code and the defect
 * agree on that press.
 *
 * They part on the way **back**. Registered on the flag, the fade takes the layer off the stack,
 * so reopening Categories over a fading Tags pushes Categories on top and the press is
 * Categories'. Registered on the mount, neither panel ever left: the stack is still
 * `[categories, tags]` in original mount order, Tags is still on top, and the press goes to the
 * dialog the reader has just **left** while the one they have just reopened is starved — a
 * capture rung `preventDefault()`s, so nothing behind it hears the press either. That is the
 * regression in its own words, and the second half of this test is what turns it red. Verified
 * by mutation, 2026-08-15: with `useDismissOnEscape` moved out of `Dialog` and into its
 * `Panel`, the first press stayed green and the second failed on `categoriesDismiss` — called 0
 * times, with `tagsDismiss` called twice.
 *
 * The reader changing their mind one press later is also the realest version of this: Categories
 * and Tags are one press apart in the same toolbar.
 *
 * **The rung it proves is `Dialog`'s**, and this is deliberately not a second copy of that
 * file's own tests: the case needs *two peers*, and these two are the realest pair the editor
 * has — Categories and Tags are one press apart in the same toolbar, and they split out of one
 * drawer where the reader used to scroll between them. It drives exactly that: one commit that
 * closes A and opens B, then a press while A is still painted. It asserts the exit window is
 * real first, because without that this test is green over a dialog that had already vanished
 * and proves nothing.
 */
describe("Escape during a dialog's exit", () => {
  it("gives the press to the open layer, never to the one still fading", async () => {
    const categoriesDismiss = vi.fn();
    const tagsDismiss = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    /** The editor's own arrangement: both dialogs mounted always, one union deciding which. */
    const overlays = (layer: "categories" | "tags") => (
      <QueryClientProvider client={client}>
        <CategoriesDialog
          deckId={1}
          variant="live"
          open={layer === "categories"}
          onDismiss={categoriesDismiss}
          onClose={vi.fn()}
        />
        <TagsDialog
          deckId={1}
          variant="live"
          open={layer === "tags"}
          onDismiss={tagsDismiss}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    );

    /** One press at `window`, handed back so the caller can read whether it was consumed. */
    const escape = () => {
      const press = new KeyboardEvent("keydown", {
        key: "Escape",
        cancelable: true,
        bubbles: true,
      });
      window.dispatchEvent(press);
      return press;
    };

    const { rerender } = render(overlays("categories"));
    await screen.findByText("Ramp");

    // The switch, in one commit, as pressing Tags with Categories open makes it.
    act(() => rerender(overlays("tags")));

    // The window this test exists for. `getByText` and not `getByRole`, deliberately: the
    // exiting layer is `aria-hidden`, so a role query cannot see it — which is itself the other
    // half of the contract, asserted two lines down.
    expect(screen.getByText("Categories")).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Tags" })).toBeInTheDocument();

    const first = escape();
    expect(tagsDismiss).toHaveBeenCalledTimes(1);
    expect(categoriesDismiss).not.toHaveBeenCalled();
    expect(first.defaultPrevented).toBe(true);

    // **Back again, inside both fades — the half that discriminates.** No `await` above this
    // line on purpose: the exit is what the assertions three lines up prove is still running,
    // and anything that yielded would let it finish and take the case with it.
    act(() => rerender(overlays("categories")));

    expect(screen.getByText("Tags")).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Categories" })).toBeInTheDocument();

    const second = escape();
    // The reopened dialog answers, and the one fading out of view has stopped listening — it
    // took no second press and did not consume this one on the way past.
    expect(categoriesDismiss).toHaveBeenCalledTimes(1);
    expect(tagsDismiss).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(true);
  });
});

/* ------------------------------------------------------------------- categories ------- */

describe("categories", () => {
  /**
   * **Every pile the deck has, whichever of the three classes it belongs to** — and this is the
   * assertion the auto rule made load-bearing rather than merely true.
   *
   * `drawsWhenEmpty` gives three different answers about an *empty* pile: a predefined zone draws
   * (bar the two conditional ones), a pile the reader made draws, and a pile the app made while
   * filing a card (`origin: "auto"`) does not — it arrives with its first card and leaves with
   * its last. So an emptied `Draw` is a pile with **no heading anywhere in the editor**, and this
   * dialog is the only place left to find it, rename it or delete it. An `origin` branch in here
   * would close the one door, which is why this file's header says there must never be one.
   *
   * The empty user pile beside it is what keeps this discriminating: a panel that had quietly
   * grown the editor's rule would drop the auto row and keep that one, and the two together say
   * which mistake was made.
   */
  it("draws a row for every pile, including an empty auto one the editor no longer draws", async () => {
    deckCategoryList.mockResolvedValue([
      ...CATEGORIES,
      category({ id: 6, name: "Draw", sortOrder: 5, origin: "auto" }),
      category({ id: 7, name: "Sunday brew", sortOrder: 6 }),
    ]);
    mount();
    await screen.findByText("Ramp");

    expect(within(row("Draw")).getByText("0 cards")).toBeInTheDocument();
    expect(within(row("Sunday brew")).getByText("0 cards")).toBeInTheDocument();
    // And it is deletable from here, which is the whole reason the row has to exist: `origin`
    // decides nothing about the two affordances — `isPredefined` does, and an auto pile is a
    // `main` category like any other of the reader's.
    expect(within(row("Draw")).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(row("Draw")).getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  /**
   * `RULE` is `GroupHeader`'s decision and this dialog renders that component rather than
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

  /**
   * The caret, asserted rather than assumed — and the assertion is `toHaveFocus` plus a bare
   * keystroke, because neither half alone would have caught the bug this test was written for.
   *
   * `HTMLInputElement.select()` sets a selection and, per spec, **does not move focus**.
   * Chromium focuses anyway, so a `play` running in a real browser sees a working field; jsdom
   * follows the spec, so the caret stayed on `<body>` and the reader's first keystroke went to
   * the page. Every other rename test here missed it too, for a reason worth naming: `user.type`
   * and `user.clear` **focus the element they are given**, so a test that reaches for the field
   * by hand repairs the very thing it was meant to check. `user.keyboard` types wherever the
   * caret already is, which is the only honest way to ask this question.
   *
   * `RenameField` is `metaRows.tsx`'s now and `TagsDialog.test.tsx` asks it the same question on
   * a tag row, which is not a duplicate: shared today is not a guarantee about tomorrow, and a
   * caret is a thing every host of that field owes its reader.
   */
  it("puts the caret in the rename field, so the first keystroke lands in it", async () => {
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    await user.click(within(row("Ramp")).getByRole("button", { name: "Rename" }));
    const field = await screen.findByLabelText("Rename Ramp");
    expect(field).toHaveFocus();

    // Selected, not merely focused: the commonest rename replaces the word rather than editing
    // inside it, so typing has to overwrite what is there.
    await user.keyboard("Acceleration");
    expect(field).toHaveValue("Acceleration");
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
   * The one destructive control on this dialog, and the thing its question exists to make
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
    // One list in this deck, so no sentence about a second one: the words appear only where
    // there are copies the reader cannot see.
    expect(within(dialog).queryByText(/both the live and theory lists/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Move 12 cards and delete" }));

    expect(deckCategoryDelete).toHaveBeenCalledWith(2, 1);
  });

  /**
   * The confirmation counts **both lists**, because the delete takes both.
   *
   * `deck_cards.category_id` is `ON DELETE CASCADE` and a category is not per-variant, so the
   * live rows and the theory rows go together — and the move arm moves both. A dialog quoting
   * the variant-scoped `cardCount` promised less than it took, and promised least on the arm
   * that destroys. Found by a reviewer on the fake's seeded deck 4, where a "Ramp" offering to
   * move 2 cards moved 7.
   *
   * **The fixture makes the two numbers differ on purpose.** Every other delete test here has
   * them equal, which is exactly why none of them saw this: a deck with an empty theory list
   * cannot tell the two fields apart, so a test built on one proves nothing about which was
   * read.
   */
  it("quotes the copies in both lists, not just the one on screen", async () => {
    deckCategoryList.mockResolvedValue([
      CATEGORIES[0],
      category({
        id: 2,
        name: "Ramp",
        sortOrder: 1,
        cardCount: 2,
        cardCountAllVariants: 7,
      }),
    ]);
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    // The row is still the list being edited, and is right to be: that is what the reader is
    // looking at. Only the confirmation changes scope.
    expect(within(row("Ramp")).getByText("2 cards")).toBeInTheDocument();

    await user.click(within(row("Ramp")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Ramp" });
    const picker = within(dialog).getByLabelText("Its 7 cards");

    // Anchored on the sentence's own opening: `move to “Commander”` alone also matches the
    // `<option>` in the picker, which is a different control saying a different thing.
    expect(within(dialog).getByText(/^The 7 cards in it move to “Commander”/)).toHaveTextContent(
      "both the live and theory lists",
    );

    await user.selectOptions(picker, "delete");
    expect(within(dialog).getByText(/^The 7 cards in it go with it/)).toHaveTextContent(
      "both the live and theory lists, not just the one on screen",
    );
    await user.click(within(dialog).getByRole("button", { name: "Delete “Ramp”" }));

    expect(deckCategoryDelete).toHaveBeenCalledWith(2, null);
  });

  /**
   * The caret goes into the question, and comes back to the control that asked it.
   *
   * The row **disables** its Delete trigger the moment the confirmation opens, and Chromium
   * blurs a control it disables — so without the effect this asserts, the caret is on `<body>`
   * and the next Tab restarts at the top of the document. That is the bug commit `10761c1`
   * fixed for the rename field; this is the same one on the sibling control.
   *
   * `toHaveFocus` **plus a real Tab**, never a hand-placed focus: the assertion pair is what
   * makes this discriminate. `user.tab()` from `<body>` would land on the dialog's ✕ (the first
   * stop in the document), so the second expectation fails on the broken code even if the first
   * somehow did not — and no line here reaches for the element it goes on to assert about.
   */
  it("puts the caret in the delete question, and hands it back on Keep it", async () => {
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();
    const trigger = within(row("Ramp")).getByRole("button", { name: "Delete" });

    await user.click(trigger);
    const dialog = await screen.findByRole("group", { name: "Delete Ramp" });
    expect(dialog).toHaveFocus();
    expect(trigger).toBeDisabled();

    // From the question, the first stop is the question's own first control — which is only
    // true if the caret is inside it.
    await user.tab();
    expect(within(dialog).getByLabelText("Its 12 cards")).toHaveFocus();

    // "Keep it" is a control, and a control hands the caret back. It cannot do so until the
    // render that re-enables the trigger, which is why the component owes this to an effect.
    await user.click(within(dialog).getByRole("button", { name: "Keep it" }));
    const back = within(row("Ramp")).getByRole("button", { name: "Delete" });
    await waitFor(() => expect(back).toHaveFocus());
  });

  it("says the cards go too when the reader picks the destructive answer", async () => {
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    await user.click(within(row("Ramp")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Ramp" });
    await user.selectOptions(within(dialog).getByLabelText("Its 12 cards"), "delete");

    // The destructive arm says where the cards actually end up: the `deck_cards` rows go, and
    // the copies the reader owns are filed into `Recently removed` rather than destroyed.
    expect(
      within(dialog).getByText(/go with it.*Any copies you own go back to Recently removed/),
    ).toBeInTheDocument();
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

  /**
   * The label is asserted rather than the control's position, because the label is the whole of
   * what a reader has to go on before pressing: the rule files by what a card **does** now
   * (Removal, Ramp, Draw and ten more) and falls back to its type, so "Auto-categorise from card
   * types" described neither what happens nor what comes back.
   */
  it("hands the deck's own rows to the auto-filer and counts what moved", async () => {
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "File cards by what they do" }));
    // An empty deck moves nothing, which is the sentence a reader needs — this dialog draws no
    // cards, so without a count there is no way to tell a no-op from a failure.
    expect(await screen.findByText(/Nothing to file/)).toBeInTheDocument();
    expect(deckGet).toHaveBeenCalledWith(1, "live", "tcgplayer");
    // An empty deck is nothing to file, and nothing to ask about either.
    expect(oracleTagsForPrintings).not.toHaveBeenCalled();
  });

  /**
   * **The press that cannot read what these cards do files nothing, and says so.**
   *
   * Falling through to the type line here would re-file every loose card in the deck by a rule
   * the reader did not press — across every pile at once, with one manual move per card as the
   * way back. Silence would be worse still: this dialog draws no cards, so a reader who pressed
   * a button and saw the same screen would have no way to tell "nothing needed doing" from "the
   * whole deck was just re-filed the other way".
   *
   * `role="alert"` rather than the status line under it: this is news the reader did not ask
   * for. The backend's own words are kept after the app's, because only one of the two facts is
   * guessable from the screen.
   */
  it("files nothing and says why when what the cards do cannot be read", async () => {
    deckGet.mockResolvedValue({ ...DECK, cards: [deckCard({ cardId: "p1" })] });
    oracleTagsForPrintings.mockRejectedValue("The database is busy.");
    mount();
    await screen.findByText("Ramp");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "File cards by what they do" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^Nothing was filed\./);
    expect(alert).toHaveTextContent("The database is busy.");
    // Not one card moved, and not one pile made: the refusal is the whole press.
    expect(deckMoveCard).not.toHaveBeenCalled();
    expect(deckCategoryCreate).not.toHaveBeenCalled();
    // And the count sentence claims nothing — "Filed 12 cards" beside that alert would be two
    // answers to one press.
    expect(screen.queryByText(/^Filed /)).not.toBeInTheDocument();
  });
});

/**
 * **No row in this dialog offers a context menu, and that is a layer rule rather than a gap.**
 *
 * A category heading on the *desk* does offer one — Rename, Import, Export, the switch, Delete —
 * and it is wired onto the **view's own group element**, never onto `GroupHeader`, which is the
 * component this dialog draws in every one of its rows. Wired one level up it would open here
 * too: inside a `Dialog` on `LAYER.overlay` (`z-45`) while `ContextMenu` draws at
 * `LAYER.popup` (`z-30`) — **behind this dialog's own scrim**. Invisible, unreachable, and
 * silent, because jsdom has no opinion about a z-index and every assertion about that menu would
 * go on passing. `layers.ts` names the overlap as the one that must not exist.
 *
 * **This is the check from the side that would actually break.** The wiring site carries a
 * comment saying not to move the handler, and a comment cannot fail; the editor's own "no menu on
 * a derived heading" case keeps passing under exactly this mistake, because the `null`-id guard
 * survives it. A right-click on a row *here* is the thing that changes.
 */
describe("the category rows and the app's context menu", () => {
  it("attaches no menu handler to a row, because a menu here would paint behind the scrim", async () => {
    mount();
    await screen.findByText("Ramp");

    // No `ContextMenuProvider` is mounted in this file, so this asserts the absence of a
    // **handler** rather than of a panel — which is the honest question: `useContextMenu`
    // degrades to a no-op without a provider, so a menu wired onto `GroupHeader` would draw
    // nothing here either way. What it *would* do is call `preventDefault()`, which is
    // `useContextMenu`'s first act on any surface that offers rows.
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.getByText("Ramp").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
