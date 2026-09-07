import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DeckCategory, DeckLabel, GlobalLabel } from "@/lib/ipc";

const deckLabelList = vi.hoisted(() => vi.fn());
const deckLabelCreate = vi.hoisted(() => vi.fn());
const deckLabelUpdate = vi.hoisted(() => vi.fn());
const deckLabelDelete = vi.hoisted(() => vi.fn());
const deckLabelRemoveFromDeck = vi.hoisted(() => vi.fn());
const deckLabelAll = vi.hoisted(() => vi.fn());
/**
 * The category list, which this dialog draws nothing from — `useDeckMeta` is one hook over a
 * deck's piles *and* the app's labels, so mounting it here fires that read too. Mocked so
 * nothing rejects unhandled; what it answers is `CategoriesDialog.test.tsx`'s subject.
 */
const deckCategoryList = vi.hoisted(() => vi.fn());
/** Present so it can be asserted **absent**: this dialog mounts no `useDeck`, because a label
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
    deckLabelList,
    deckLabelCreate,
    deckLabelUpdate,
    deckLabelDelete,
    deckLabelRemoveFromDeck,
    deckLabelAll,
    deckGet,
  },
}));

import { LabelsDialog } from "./LabelsDialog";

/* --------------------------------------------------------------------- fixtures ------- */

/**
 * What this deck's **live** list is wearing.
 *
 * Every row here has a non-zero `cardCount` by construction, and that is the schema rather than
 * the fixture being tidy: since v21 membership of this list *is* wearing the label, so a zero
 * would mean the row is not in the answer at all.
 */
const LABELS: DeckLabel[] = [{ id: 10, name: "Cut candidate", color: "ember", cardCount: 3 }];

/**
 * Every label there is — the app-wide list, and the dialog's second section.
 *
 * `Cut candidate` appears in both lists on purpose: it is the *same row*, seen once as "what
 * this deck wears" and once as "what the app holds". `Budget swap` is in this list only, which
 * is what puts it in the second section; `Playtest` is there too and is worn by nothing at all,
 * which is the row `deck_label_list` can never answer.
 */
const EVERY_LABEL: GlobalLabel[] = [
  { id: 10, name: "Cut candidate", color: "ember", cardCount: 8, deckCount: 3 },
  { id: 12, name: "Budget swap", color: "moss", cardCount: 5, deckCount: 2 },
  { id: 11, name: "Playtest", color: "azure", cardCount: 0, deckCount: 0 },
];

/** Whatever the shared hook's category read answers — see the mock's doc. */
const CATEGORIES: DeckCategory[] = [];

function mount(props: Partial<Parameters<typeof LabelsDialog>[0]> = {}) {
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <LabelsDialog
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

/** The row for one label, by the name in it. */
function row(name: string): HTMLElement {
  const li = screen.getByText(name).closest("li");
  if (!li) throw new Error(`No row for ${name}`);
  return li;
}

beforeEach(() => {
  vi.clearAllMocks();
  deckCategoryList.mockResolvedValue(CATEGORIES);
  deckLabelList.mockResolvedValue(LABELS);
  deckLabelAll.mockResolvedValue(EVERY_LABEL);
  deckLabelCreate.mockResolvedValue(EVERY_LABEL[0]);
  deckLabelUpdate.mockResolvedValue(EVERY_LABEL[0]);
  deckLabelDelete.mockResolvedValue(undefined);
  deckLabelRemoveFromDeck.mockResolvedValue(3);
});

/* ----------------------------------------------------------------------- shell ------- */

describe("LabelsDialog", () => {
  it("draws nothing at all when it is closed", () => {
    const { container } = mount({ open: false });
    expect(container).toBeEmptyDOMElement();
    // Not merely hidden: a closed dialog must cost no query, which is what lets the editor
    // mount it unconditionally beside five others.
    expect(deckLabelList).not.toHaveBeenCalled();
    expect(deckLabelAll).not.toHaveBeenCalled();
  });

  /**
   * **One wiring test, not a second copy of the shell's suite.** The scrim, the trap, the caret
   * moving into the panel and the `aria-modal` claim are all `Dialog`'s now and are tested
   * where they live. What is this file's business is that this dialog hands that shell the right
   * four things: a title, a close label that is a sentence, and the two different ways out.
   */
  it("is a dialog named Labels, dismissed by Escape and closed by the scrim", async () => {
    const { onDismiss, onClose } = mount();
    const dialog = await screen.findByRole("dialog", { name: "Labels" });
    expect(within(dialog).getByRole("button", { name: "Close labels" })).toBeInTheDocument();

    const press = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    window.dispatchEvent(press);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    // The `"inner"` half of the handshake: an outer layer reads this and stands down, so one
    // press closes one layer.
    expect(press.defaultPrevented).toBe(true);

    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("heading", { name: "Labels" }));
    expect(onClose).not.toHaveBeenCalled();

    const scrim = dialog.parentElement;
    if (!scrim) throw new Error("no scrim");
    await user.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    // A press outside closes without moving focus, which is the half that differs from Escape.
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  /**
   * **One `deck_label_list`, for the variant it was given, and no deck read at all.**
   *
   * It used to ask twice — the list on screen and the other one — because a delete's reach was
   * not scoped by the variant and the confirmation needed the total. `deck_label_all` answers that
   * off one row now, and answers it about every *deck* rather than about two lists of one, so
   * the second read is gone.
   *
   * The `deck_get` half is asserted rather than trusted: a label has no card row behind it, so
   * `useDeck` is absent by construction — the categories dialog needs the deck's rows for its
   * auto-filer and this one has no such control. A stray `useDeck` added later would cost a
   * `deck_get` per open and nothing on screen would say so.
   */
  it("reads one list's labels for the variant it was given, plus every label, and never the deck", async () => {
    mount({ variant: "theory" });
    await screen.findByText("Cut candidate");
    expect(deckLabelList).toHaveBeenCalledWith(1, "theory");
    expect(deckLabelList).not.toHaveBeenCalledWith(1, "live");
    expect(deckLabelAll).toHaveBeenCalledWith();
    expect(deckGet).not.toHaveBeenCalled();
  });

  /**
   * The rules that are not guessable from the controls, each said where its controls are.
   *
   * **The header's second sentence changed with schema v21**, and the change is the feature: it
   * said "Deleting a label keeps its cards", which is still true and is now the *less* surprising
   * half. What a reader cannot see anywhere on this screen is that the labels are shared — that
   * recolouring one here recolours it in every other deck — so that is what the line says.
   *
   * Asserted on the *words* rather than on a class, because this is copy the dialog exists to
   * carry, and asserted in all three places, because a redesign that dropped one would leave
   * the others reading fine.
   */
  it("says the labels are shared in the header, and names both of its sections", async () => {
    mount();
    expect(await screen.findByText(/A card carries at most one/)).toHaveTextContent(
      "Labels are shared by all your decks",
    );
    expect(screen.getByText("On cards in this actual list")).toBeInTheDocument();
    expect(screen.getByText("Your other labels")).toBeInTheDocument();
  });

  /** The first section's heading names the **list**, not the deck, because the live and theory
   *  lists are treated as separate decks where labels are concerned. */
  it("names the theory list in the first section's heading when that is what is on screen", async () => {
    mount({ variant: "theory" });
    expect(await screen.findByText("On cards in this theory list")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ the two lists ------- */

describe("the two sections", () => {
  /**
   * **The split is by what this list wears, and a label in both answers appears once.**
   *
   * `Cut candidate` is in `deck_label_list` *and* in `deck_label_all` — the same row seen two ways —
   * so a dialog that concatenated the two would draw it twice with two different counts, which
   * is exactly the bug the id-based subtraction prevents.
   */
  it("puts what this list wears above, and everything else below, each once", async () => {
    mount();
    await screen.findByText("Cut candidate");

    // Its copies **in this list**, which is the list the reader is editing.
    expect(within(row("Cut candidate")).getByText("3 cards")).toBeInTheDocument();
    expect(screen.getAllByText("Cut candidate")).toHaveLength(1);

    // The other two say how far they reach instead, which is what the second section's order is
    // by and what a delete there is about.
    expect(within(row("Budget swap")).getByText("5 in 2 decks")).toBeInTheDocument();
    // A label no card anywhere wears has no number worth printing — "0 in 0 decks" would be
    // arithmetic about a label that has simply never been used.
    expect(within(row("Playtest")).getByText("unused")).toBeInTheDocument();
  });

  /** The two destructive controls are different acts and are labelled as such — the row in this
   *  list offers the deck-scoped one, and the row below offers the app-wide one. */
  it("offers Remove on a worn label and Delete on the rest", async () => {
    mount();
    await screen.findByText("Cut candidate");

    const worn = row("Cut candidate");
    expect(within(worn).getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(within(worn).queryByRole("button", { name: "Delete" })).toBeNull();

    const other = row("Budget swap");
    expect(within(other).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(other).queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("says so when nothing in this list is labelled", async () => {
    deckLabelList.mockResolvedValue([]);
    mount();
    expect(await screen.findByText(/Nothing in this list is labelled yet/)).toBeInTheDocument();
  });

  it("says so when every label the reader has is already on a card here", async () => {
    deckLabelAll.mockResolvedValue([EVERY_LABEL[0]]);
    mount();
    expect(await screen.findByText(/Every label you have is on a card in this list/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------ labels ------- */

describe("labels", () => {
  /**
   * `deck_label_update` renames **and** recolours in one command and has no patch shape, so the
   * field has to send a colour back even when only the name changed. The `deckId` leads, because
   * the write is app-wide and the deck is only where the reader was standing.
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

    expect(deckLabelUpdate).toHaveBeenCalledWith(1, 10, "On the block", "ember");
  });

  /** A row in the second section renames through the same command — the act is app-wide either
   *  way, and the section a row is drawn in says nothing about that. */
  it("renames a label this list does not wear", async () => {
    mount();
    await screen.findByText("Budget swap");
    const user = userEvent.setup();
    const li = row("Budget swap");

    await user.click(within(li).getByRole("button", { name: "Rename" }));
    await user.clear(await within(li).findByLabelText("Rename Budget swap"));
    await user.type(within(li).getByLabelText("Rename Budget swap"), "Thrift");
    await user.click(within(li).getByRole("button", { name: "Save" }));

    expect(deckLabelUpdate).toHaveBeenCalledWith(1, 12, "Thrift", "moss");
  });

  /**
   * **Remove is not delete, and the sentence's job is to say what is *not* happening.**
   *
   * The button is red and sits where Delete used to, so a reader who has used this dialog before
   * will read it as the press that destroys the label. It is not — and this is the only place that
   * can be said before the press rather than discovered after it.
   */
  it("says a removed label survives, in this deck's list and in the others using it", async () => {
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();
    const li = row("Cut candidate");

    await user.click(within(li).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("group", {
      name: "Remove Cut candidate from this deck",
    });
    // The trigger and the control inside what it opens must not share an accessible name: the
    // decks page had to rename three of its heading triggers for exactly that collision.
    expect(within(li).getByRole("button", { name: "Remove" })).toBeDisabled();

    expect(within(dialog).getByText(/^Its 3 cards stay in the deck/)).toHaveTextContent(
      // Three decks wear it, so two of them still will — the number the deck-scoped row cannot
      // know and the app-wide list carries.
      "The label itself stays in your list, and stays on the 2 other decks using it.",
    );

    await user.click(within(dialog).getByRole("button", { name: "Remove from deck" }));
    expect(deckLabelRemoveFromDeck).toHaveBeenCalledWith(1, 10, "live");
    expect(deckLabelDelete).not.toHaveBeenCalled();
  });

  /** The clause about other decks is dropped when there are none: a sentence about decks that
   *  do not exist is chrome, and the outcome for this one is exact either way. */
  it("does not mention other decks when this is the only one wearing it", async () => {
    deckLabelAll.mockResolvedValue([
      { id: 10, name: "Cut candidate", color: "ember", cardCount: 3, deckCount: 1 },
    ]);
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();

    await user.click(within(row("Cut candidate")).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("group", {
      name: "Remove Cut candidate from this deck",
    });

    expect(within(dialog).getByText(/^Its 3 cards stay in the deck/)).toHaveTextContent(
      "The label itself stays in your list.",
    );
    expect(within(dialog).queryByText(/other deck/)).toBeNull();
  });

  /**
   * The delete's reach is **every deck**, which is a widening rather than a rewording: it used
   * to be every *variant* of the open deck. `GlobalLabel` carries both counts off a command that
   * takes no deck at all, so there is no in-flight case left to spell — the row cannot be drawn
   * before the read it came from has answered.
   */
  it("says how many cards in how many decks a delete reaches", async () => {
    mount();
    await screen.findByText("Budget swap");
    const user = userEvent.setup();
    const li = row("Budget swap");

    await user.click(within(li).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Budget swap" });
    expect(within(li).getByRole("button", { name: "Delete" })).toBeDisabled();
    // `deck_cards.label_id` is `ON DELETE SET NULL`: the cards are unlabelled, never deleted.
    expect(within(dialog).getByText(/^Its 5 cards, across 2 decks/)).toHaveTextContent(
      "stay where they are and lose the label",
    );

    await user.click(within(dialog).getByRole("button", { name: "Delete label" }));
    expect(deckLabelDelete).toHaveBeenCalledWith(1, 12);
  });

  /** The zero arm, which is the one a reader presses through without reading. */
  it("says plainly that no deck is using a label nothing wears", async () => {
    mount();
    await screen.findByText("Playtest");
    const user = userEvent.setup();

    await user.click(within(row("Playtest")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Playtest" });

    expect(within(dialog).getByText(/No deck is using it/)).toBeInTheDocument();
  });

  /**
   * `CategoryRow`'s caret contract, on the label row. Same pair, same reason — see the category
   * test's doc for why either half alone would pass against the broken code.
   */
  it("puts the caret in the label delete question, and hands it back on Keep it", async () => {
    mount();
    await screen.findByText("Budget swap");
    const user = userEvent.setup();
    const li = row("Budget swap");

    await user.click(within(li).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("group", { name: "Delete Budget swap" });
    expect(dialog).toHaveFocus();

    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Delete label" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(within(li).getByRole("button", { name: "Delete" })).toHaveFocus());
  });

  /**
   * The empty dialog, and the control that fixes it.
   *
   * **The field is the first thing in the dialog**, where it used to be the last: a reader with
   * no labels met a four-line paragraph about a thing they did not have, with the control that
   * would give them one below it.
   *
   * The colour is a **hex string** and no longer one of six token words — see `labelColors.ts` for
   * what that trades away and why. The six the picker offers first are still the app's own
   * palette, so pressing "Moss" writes what `--color-pie-g` is.
   */
  it("makes a first label from the field, in the colour the picker is on", async () => {
    deckLabelList.mockResolvedValue([]);
    deckLabelAll.mockResolvedValue([]);
    mount();
    await screen.findByText(/None yet/);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("New label name"), "Playtest");
    await user.click(screen.getByRole("button", { name: "Choose label colour" }));
    await user.click(screen.getByRole("button", { name: "Moss" }));
    await user.click(screen.getByRole("button", { name: "Add label" }));

    expect(deckLabelCreate).toHaveBeenCalledWith(1, "Playtest", "#00733e");
  });

  /**
   * **The duplicate guard, which is the issue's second half.**
   *
   * The backend refuses the name and is the authority — one row per name is a table property,
   * and two windows racing the same new name is what a UNIQUE index is for. But a reader who
   * types a name that exists has not made a mistake; they have found the label they wanted, and
   * making them press Add and wait for a refusal would be the app knowing the answer and
   * declining to say so.
   *
   * Compared on `labelNames.ts`' key, not on the word — so a different capitalisation is the same
   * label, which is exactly the case a `===` check would let through to the backend.
   */
  it("refuses to offer a name any label already holds, in any capitalisation", async () => {
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("New label name"), "budget SWAP");

    expect(screen.getByRole("button", { name: "Add label" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "“Budget swap” already exists — every deck shares one list",
    );
    await user.click(screen.getByRole("button", { name: "Add label" }));
    expect(deckLabelCreate).not.toHaveBeenCalled();
  });

  /**
   * A colour outside the six, typed rather than pressed — which is the whole of what the storage
   * change bought and the one path no palette of swatches can serve.
   *
   * The field takes the digits without the `#`, because the `#` is drawn beside the box; the
   * value is normalised on the keystroke that completes a colour, so nothing has to be pressed
   * to commit it before Add.
   */
  it("takes a colour the palette has never heard of, typed as hex", async () => {
    deckLabelList.mockResolvedValue([]);
    deckLabelAll.mockResolvedValue([]);
    mount();
    await screen.findByText(/None yet/);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("New label name"), "Playtest");
    await user.click(screen.getByRole("button", { name: "Choose label colour" }));
    const hex = screen.getByLabelText("Label colour hex");
    await user.clear(hex);
    await user.type(hex, "7b2d8e");
    await user.click(screen.getByRole("button", { name: "Add label" }));

    expect(deckLabelCreate).toHaveBeenCalledWith(1, "Playtest", "#7b2d8e");
  });

  /**
   * **Recolouring is the swatch's, and it sends the name back untouched — for every deck.**
   *
   * It used to be reachable only through Rename, which asked a reader who wanted a different red
   * to open the control for changing the word. `deck_label_update` still renames *and* recolours in
   * one command with no patch shape, so each half of the row has to send the other back — this is
   * the half the rename test above does not cover.
   *
   * **Done is the write, and the picker holds a draft until then**: the wheel fires all the way
   * down a drag through the OS colour dialog, so a row writing on every change would be a
   * `deck_label_update` per pixel of travel.
   */
  it("recolours from the row's swatch, sending the name back unchanged", async () => {
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();
    const li = row("Cut candidate");

    await user.click(within(li).getByRole("button", { name: "Change colour of Cut candidate" }));
    await user.click(within(li).getByRole("button", { name: "Slate" }));
    // The draft is on screen and nothing has been written yet.
    expect(deckLabelUpdate).not.toHaveBeenCalled();

    await user.click(within(li).getByRole("button", { name: "Done" }));
    expect(deckLabelUpdate).toHaveBeenCalledWith(1, 10, "Cut candidate", "#c8c4bf");
  });

  /** Done is also how the panel closes, so it is pressed by readers who opened it to look. A
   *  write for a colour that did not move is a row's `updated_at` moving for nothing. */
  it("writes nothing when the picker is closed on the colour it opened with", async () => {
    mount();
    await screen.findByText("Cut candidate");
    const user = userEvent.setup();
    const li = row("Cut candidate");

    await user.click(within(li).getByRole("button", { name: "Change colour of Cut candidate" }));
    await user.click(within(li).getByRole("button", { name: "Done" }));

    expect(deckLabelUpdate).not.toHaveBeenCalled();
  });

  it("says why a refusal happened rather than losing it", async () => {
    deckLabelDelete.mockRejectedValue("That label is not there any more.");
    mount();
    await screen.findByText("Budget swap");
    const user = userEvent.setup();
    const li = row("Budget swap");

    await user.click(within(li).getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete label" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That label is not there any more.");
  });

  /** The app-wide read can be refused on its own, and it draws a section of its own — so its
   *  failure has to reach the banner rather than leaving an empty list that reads as "you have
   *  no other labels". */
  it("says why the app-wide list could not be read", async () => {
    deckLabelAll.mockRejectedValue("the label list could not be read: database is locked");
    mount();

    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked");
  });
});
