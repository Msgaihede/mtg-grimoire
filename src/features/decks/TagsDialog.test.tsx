import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DeckCategory, DeckTag, TagSuggestion } from "@/lib/ipc";

const deckTagList = vi.hoisted(() => vi.fn());
const deckTagCreate = vi.hoisted(() => vi.fn());
const deckTagUpdate = vi.hoisted(() => vi.fn());
const deckTagDelete = vi.hoisted(() => vi.fn());
const deckTagSuggestions = vi.hoisted(() => vi.fn());
/**
 * The category list, which this dialog draws nothing from — `useDeckMeta` is one hook over a
 * deck's piles *and* its labels, so mounting it here fires that read too. Mocked so nothing
 * rejects unhandled; what it answers is `CategoriesDialog.test.tsx`'s subject.
 */
const deckCategoryList = vi.hoisted(() => vi.fn());
/** Present so it can be asserted **absent**: this dialog mounts no `useDeck`, because a tag
 *  carries a name, a colour and a count, and no card row answers any of the three. */
const deckGet = vi.hoisted(() => vi.fn());

// The fake sits under `ipc.ts` everywhere else in this repository; here it replaces the object,
// because these commands are what the dialog *is* — every assertion below is about the argument
// one of them was handed. `importOriginal` keeps `ipcError`, which the body renders refusals
// through.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckCategoryList,
    deckTagList,
    deckTagCreate,
    deckTagUpdate,
    deckTagDelete,
    deckTagSuggestions,
    deckGet,
  },
}));

import { TagsDialog } from "./TagsDialog";

/* --------------------------------------------------------------------- fixtures ------- */

const TAGS: DeckTag[] = [
  { id: 10, deckId: 1, name: "Cut candidate", color: "ember", cardCount: 3 },
  { id: 11, deckId: 1, name: "Playtest", color: "azure", cardCount: 0 },
];

/**
 * The **theory** list's tag counts, which this dialog reads as well — see {@link useDeckMeta}'s
 * second `deck_tag_list`.
 *
 * Empty by default, so these fixtures are single-list decks and a confirmation's number equals
 * the row's. The tests that make them differ are the point.
 */
const NO_THEORY_TAGS: DeckTag[] = [];

const SUGGESTIONS: TagSuggestion[] = [
  { name: "Cut candidate", color: "ember" },
  { name: "Budget swap", color: "moss" },
];

/** Whatever the shared hook's category read answers — see the mock's doc. */
const CATEGORIES: DeckCategory[] = [];

function mount(props: Partial<Parameters<typeof TagsDialog>[0]> = {}) {
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <TagsDialog
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

/** The row for one tag, by the name in it. */
function row(name: string): HTMLElement {
  const li = screen.getByText(name).closest("li");
  if (!li) throw new Error(`No row for ${name}`);
  return li;
}

beforeEach(() => {
  vi.clearAllMocks();
  deckCategoryList.mockResolvedValue(CATEGORIES);
  // Variant-aware, because the dialog asks twice: the list on screen and the other one. A mock
  // that answered the same rows to both would make every tag's two counts agree by accident,
  // which is the fixture shape that let the undercount through in the first place.
  deckTagList.mockImplementation((_deckId: number, variant: string) =>
    Promise.resolve(variant === "live" ? TAGS : NO_THEORY_TAGS),
  );
  deckTagSuggestions.mockResolvedValue(SUGGESTIONS);
  deckTagCreate.mockResolvedValue(TAGS[0]);
  deckTagUpdate.mockResolvedValue(TAGS[0]);
  deckTagDelete.mockResolvedValue(undefined);
});

/* ----------------------------------------------------------------------- shell ------- */

describe("TagsDialog", () => {
  it("draws nothing at all when it is closed", () => {
    const { container } = mount({ open: false });
    expect(container).toBeEmptyDOMElement();
    // Not merely hidden: a closed dialog must cost no query, which is what lets the editor
    // mount it unconditionally beside five others.
    expect(deckTagList).not.toHaveBeenCalled();
    expect(deckTagSuggestions).not.toHaveBeenCalled();
  });

  /**
   * **One wiring test, not a second copy of the shell's suite.** The scrim, the trap, the caret
   * moving into the panel and the `aria-modal` claim are all `Dialog`'s now and are tested
   * where they live. What is this file's business is that this dialog hands that shell the right
   * four things: a title, a close label that is a sentence, and the two different ways out.
   */
  it("is a dialog named Tags, dismissed by Escape and closed by the scrim", async () => {
    const { onDismiss, onClose } = mount();
    const dialog = await screen.findByRole("dialog", { name: "Tags" });
    expect(within(dialog).getByRole("button", { name: "Close tags" })).toBeInTheDocument();

    const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    window.dispatchEvent(press);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    // The `"inner"` half of the handshake: an outer layer reads this and stands down, so one
    // press closes one layer.
    expect(press.defaultPrevented).toBe(true);

    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("heading", { name: "Tags" }));
    expect(onClose).not.toHaveBeenCalled();

    const scrim = dialog.parentElement;
    if (!scrim) throw new Error("no scrim");
    await user.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    // A press outside closes without moving focus, which is the half that differs from Escape.
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  /**
   * Both lists, and the second one is the interesting half: it has one consumer, the delete
   * confirmation, whose reach is not scoped by the variant on screen.
   *
   * **And no deck read at all.** A tag has no card row behind it, so `useDeck` is absent from
   * this dialog by construction — the categories half needs the deck's rows for its auto-filer
   * and this one has no such control. Asserted rather than trusted, because a stray `useDeck`
   * added later would cost a `deck_get` per open and nothing on screen would say so.
   */
  it("reads both lists' tags for the variant it was given, and never the deck", async () => {
    mount({ variant: "theory" });
    await screen.findByText("Cut candidate");
    expect(deckTagList).toHaveBeenCalledWith(1, "theory");
    expect(deckTagList).toHaveBeenCalledWith(1, "live");
    expect(deckGet).not.toHaveBeenCalled();
  });

  /**
   * The rule that is not guessable from the controls, spelled out where the controls are.
   * Asserted on the *sentence* rather than on a class: this is copy the dialog exists to carry.
   */
  it("says where the suggestions come from", async () => {
    mount();
    expect(await screen.findByText(/come from\s+every deck you have/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------ tags ------- */

describe("tags", () => {
  it("lists a deck's tags with their colour and their copies", async () => {
    mount();
    await screen.findByText("Cut candidate");
    expect(within(row("Cut candidate")).getByText("3 cards")).toBeInTheDocument();
  });

  /**
   * `deck_tag_update` renames **and** recolours in one command and has no patch shape, so the
   * field has to send a colour back even when only the name changed.
   *
   * The caret is asserted here too, on the `RenameField` `metaRows.tsx` now owns.
   * `CategoriesDialog.test.tsx` asks the same question of the same component on a category row
   * — deliberately, and its doc says why either half of that pair alone would pass against the
   * broken code. Shared today is not a guarantee about tomorrow, and this is the caret's only
   * test on this row.
   */
  it("sends both the name and the colour on a rename", async () => {
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();
    const li = row("Cut candidate");

    await user.click(within(li).getByRole("button", { name: "Rename" }));
    const field = await within(li).findByLabelText("Rename Cut candidate");
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, "On the block");
    await user.click(within(li).getByRole("button", { name: "Save" }));

    expect(deckTagUpdate).toHaveBeenCalledWith(10, "On the block", "ember");
  });

  it("says a deleted tag keeps its cards", async () => {
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();
    const li = row("Cut candidate");

    await user.click(within(li).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Cut candidate" });
    // The trigger and the control inside what it opens must not share an accessible name: the
    // decks page had to rename three of its heading triggers for exactly that collision. Here
    // the inner controls are named for the *object* — "Delete tag", "Delete “Ramp”" — so the
    // trigger stays uniquely addressable, and `getByRole` throwing on two matches is the proof.
    expect(within(li).getByRole("button", { name: "Delete" })).toBeDisabled();
    // `deck_cards.tag_id` is `ON DELETE SET NULL`: the cards are untagged, never deleted.
    expect(
      within(dialog).getByText(/cards stay in the deck and lose the label/),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Delete tag" }));
    expect(deckTagDelete).toHaveBeenCalledWith(10);
  });

  /**
   * The confirmation counts **both lists**, because `deck_cards.tag_id` is `ON DELETE SET NULL`
   * across both — the same correction the category delete carries, one dialog over.
   *
   * **The fixture makes the two numbers differ on purpose**, and that is the whole of why this
   * test can fail: with an empty theory list, `cardCount` and the both-lists total are the same
   * number, so a dialog reading the wrong one still prints the right answer. Every other tag
   * test here has them equal, which is exactly how the bug survived a suite.
   */
  it("quotes the copies wearing a tag in both lists, not just the one on screen", async () => {
    deckTagList.mockImplementation((_deckId: number, variant: string) =>
      Promise.resolve(
        variant === "live"
          ? [{ id: 10, deckId: 1, name: "Cut candidate", color: "ember", cardCount: 2 }]
          : [{ id: 10, deckId: 1, name: "Cut candidate", color: "ember", cardCount: 5 }],
      ),
    );
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();
    const li = row("Cut candidate");

    // The row is still the list being edited, and is right to be. Only the confirmation
    // changes scope.
    expect(within(li).getByText("2 cards")).toBeInTheDocument();

    await user.click(within(li).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Cut candidate" });

    expect(within(dialog).getByText(/^Its 7 cards stay in the deck/)).toHaveTextContent(
      "both the live and theory lists, not just the one on screen",
    );
  });

  /**
   * The zero arm, which is the one that read as a flat falsehood: "No card is wearing it" over
   * a theory list with five. Its own test, because it is a different sentence and because the
   * arm that says "nothing will happen" is the one a reader presses through without reading.
   */
  it("does not say a tag is worn by nothing when the other list wears it", async () => {
    deckTagList.mockImplementation((_deckId: number, variant: string) =>
      Promise.resolve([
        {
          id: 10,
          deckId: 1,
          name: "Cut candidate",
          color: "ember",
          cardCount: variant === "live" ? 0 : 5,
        },
      ]),
    );
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();
    const li = row("Cut candidate");

    await user.click(within(li).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Cut candidate" });

    expect(within(dialog).queryByText(/No card in either list is wearing it/)).toBeNull();
    expect(within(dialog).getByText(/^Its 5 cards stay in the deck/)).toHaveTextContent(
      "both the live and theory lists",
    );
  });

  /**
   * `CategoryRow`'s caret contract, on the tag row. Same pair, same reason — see the category
   * test's doc for why either half alone would pass against the broken code.
   */
  it("puts the caret in the tag delete question, and hands it back on Keep it", async () => {
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();
    const li = row("Cut candidate");

    await user.click(within(li).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Cut candidate" });
    expect(dialog).toHaveFocus();

    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Delete tag" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(within(li).getByRole("button", { name: "Delete" })).toHaveFocus());
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
    const li = row("Cut candidate");

    await user.click(within(li).getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete tag" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That tag is not this deck's.");
  });
});
