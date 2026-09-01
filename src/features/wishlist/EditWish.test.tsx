import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildFolderTree } from "@/lib/folderTree";
import type { WishlistFolder, WishRow } from "@/lib/ipc";
import { EditWishButton } from "./EditWish";

/**
 * The panel's own suite, and the reason it is worth one separately from `WishlistPage`'s.
 *
 * **Half the rows this control is drawn on have no context menu.** `WishlistPage` withholds it
 * from every wish with no `card_id`, so on those rows this panel is the whole of what a reader
 * can do to the wish — which makes "every control is reachable here" a property of *this*
 * component rather than of the page that mounts it. The page's suite drives one wall; this one
 * drives the three kinds of wish side by side.
 */

const BOLT: WishRow = {
  // The Arena export filter's field and its only reader — nothing this suite drives touches it.
  legalities: null,
  id: 7,
  oracleId: "o-bolt",
  cardId: "c1",
  folderId: 2,
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  typeLine: "Instant",
  artCardId: "c1",
  quantity: 4,
  preferredFinish: "foil",
  unitPrice: 400.5,
  ownedQuantity: 1,
  elsewhere: 0,
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
};

/**
 * A wish for the *card* — no `cardId`, and therefore no context menu on the page. Filed at the
 * root, so between this fixture and `BOLT` the folder row is driven in both of its states.
 */
const ANY: WishRow = {
  ...BOLT,
  id: 8,
  cardId: null,
  folderId: null,
  setCode: null,
  collectorNumber: null,
  lang: null,
  rarity: null,
  preferredFinish: null,
  name: "Ancestral Recall",
  quantity: 1,
};

/** A wish whose printing has left the card database: no oracle id, so no printings to list. */
const ORPHAN: WishRow = { ...BOLT, id: 9, oracleId: null, name: "Chaos Orb" };

const FOLDERS: WishlistFolder[] = [
  { id: 2, parentId: null, name: "Expensive", sortOrder: 0 },
  { id: 3, parentId: 2, name: "Ordered", sortOrder: 0 },
];

const NODES = buildFolderTree(FOLDERS, []);

function setup(row: WishRow) {
  const handlers = {
    onSetQuantity: vi.fn(),
    onRemove: vi.fn(),
    onSetFolder: vi.fn(),
    onChangePrinting: vi.fn(),
    onAnyPrinting: vi.fn(),
  };
  render(<EditWishButton row={row} folders={FOLDERS} nodes={NODES} {...handlers} />);
  return { user: userEvent.setup(), ...handlers };
}

/** Opens the panel the way a reader does — by pressing the trigger, never by focusing it. */
async function open(user: ReturnType<typeof userEvent.setup>, row: WishRow) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^Edit ${row.name}`) }));
  return screen.getByRole("dialog", { name: `Edit ${row.name}` });
}

/**
 * The destination list, once the panel has swapped its body for it.
 *
 * A `group` and not a `dialog`: the panel is the layer, and the list drawn into its body is not
 * a second one. Found by that role rather than by a test id, so the case below that counts the
 * dialogs in the tree and this helper cannot drift apart.
 */
const listIn = (panel: HTMLElement, row: WishRow) =>
  within(panel).getByRole("group", { name: new RegExp(`^Move ${row.name}`) });

describe("EditWishButton", () => {
  /** The caption is `printingOf`'s words rather than the panel's own — one wording for the same
   *  fact, wherever a wish says which printing it is for. */
  it("says which printing the wish is for", async () => {
    const { user } = setup(BOLT);
    const panel = await open(user, BOLT);
    expect(within(panel).getByText("LEA · 161 · Foil")).toBeInTheDocument();
  });

  it("says any printing rather than a set and a number when the wish names none", async () => {
    const { user } = setup(ANY);
    const panel = await open(user, ANY);
    expect(within(panel).getByText("Any printing")).toBeInTheDocument();
  });

  /**
   * The rule that makes `[Any printing]` absent rather than greyed: it offers the state the wish
   * is already in, and a control that exists only to be refused is worse than one that is not
   * there. This is the one place in the panel where that answer differs from the greying below.
   */
  it("withholds Any printing from a wish that is already for any printing", async () => {
    const { user } = setup(ANY);
    const panel = await open(user, ANY);
    expect(within(panel).queryByRole("button", { name: /^Any printing/ })).toBeNull();
  });

  /**
   * **The two printing controls are stacked, and the class is the whole of what a test can hold.**
   *
   * They shared a row until the live pass of 2026-08-22, where `Change printing…` wrapped onto two
   * lines spanning 32px inside its 28px box — 128px of button against a label that wanted more.
   * The overflow is a *wrap* rather than a scroll, so `scrollWidth === clientWidth` and no width
   * assertion can see it; jsdom has no layout engine, so nothing here can measure it either. What
   * is testable is the decision: full-width controls in a column, which cannot be wrong about a
   * font metric. Put back on one row, this goes red — which is the only warning the suite can give.
   *
   * `toHaveClass` reads `classList`, never the `className` string: a `hover:` variant makes a
   * substring check pass before the state it names ever happens.
   */
  it("stacks the two printing controls rather than sharing a row", async () => {
    const { user } = setup(BOLT);
    const panel = await open(user, BOLT);
    const change = within(panel).getByRole("button", { name: /^Change printing/ });
    const any = within(panel).getByRole("button", { name: /^Any printing/ });

    expect(change).toHaveClass("w-full");
    expect(any).toHaveClass("w-full");
    expect(change.parentElement).toHaveClass("flex-col");
    expect(change.parentElement).toBe(any.parentElement);
  });

  /*
   * **The 4% this panel has not grown yet is `AnchoredPopup`'s problem and is pinned there now.**
   * A `scroll-mb-4` stood here from 2026-08-22 until later the same day, asserted from this file
   * because this is the panel the live pass measured the clip on. The diagnosis held to the pixel
   * and the cure did not: a scroll margin asks the browser to scroll *further*, and what was wrong
   * was the maximum it clamps to, which the scaled panel itself caps — raising the margin to 400px
   * moved the landing `scrollTop` by nothing at all. The shell defers the scroll to the end of the
   * entry tween instead, and `AnchoredPopup.test.tsx` pins that ordering for every caller rather
   * than a class for one of them.
   */

  it("drops a pinned wish's printing through onAnyPrinting", async () => {
    const { user, onAnyPrinting } = setup(BOLT);
    const panel = await open(user, BOLT);
    await user.click(within(panel).getByRole("button", { name: /^Any printing/ }));
    expect(onAnyPrinting).toHaveBeenCalledWith(BOLT);
  });

  it("hands the printings modal to the page", async () => {
    const { user, onChangePrinting } = setup(BOLT);
    const panel = await open(user, BOLT);
    await user.click(within(panel).getByRole("button", { name: /^Change printing/ }));
    expect(onChangePrinting).toHaveBeenCalledWith(BOLT);
  });

  /**
   * `printingsItem`'s judgement, reached from the other end: greyed **with the reason**, never
   * hidden. The control is on every other wish in this list, so removing it from one would read
   * as a bug in the panel rather than as a fact about the card.
   *
   * `aria-disabled` and not the attribute, so the caret still reaches the control the reason is
   * attached to — a `disabled` button leaves the tab order and takes the sentence with it.
   */
  it("greys Change printing with a reason when the printing has left the card database", async () => {
    const { user, onChangePrinting } = setup(ORPHAN);
    const panel = await open(user, ORPHAN);
    const change = within(panel).getByRole("button", { name: /^Change printing/ });
    expect(change).toHaveAttribute("aria-disabled", "true");
    expect(change).not.toBeDisabled();
    expect(within(panel).getByText(/left the card database/)).toBeInTheDocument();
    await user.click(change);
    expect(onChangePrinting).not.toHaveBeenCalled();
  });

  it("names the folder the wish is filed in", async () => {
    const { user } = setup(BOLT);
    const panel = await open(user, BOLT);
    expect(within(panel).getByText("Expensive")).toBeInTheDocument();
  });

  it("names the root wishlist rather than drawing an empty folder row", async () => {
    const { user } = setup(ANY);
    const panel = await open(user, ANY);
    expect(within(panel).getByText("Wishlist")).toBeInTheDocument();
  });

  /**
   * The two-pane swap. **In place** is the assertion that matters: the destination list is
   * inside the panel that was already open, and what it replaced is gone — not a second layer
   * drawn over it.
   *
   * The "Here now" row is what proves `currentId` is the wish's own `folderId` rather than a
   * default, and it is the one destination the list refuses.
   */
  it("swaps its own body for the destination list rather than opening a second layer", async () => {
    const { user } = setup(BOLT);
    const panel = await open(user, BOLT);
    await user.click(within(panel).getByRole("button", { name: /^Move to folder/ }));

    const list = listIn(panel, BOLT);
    expect(within(list).getByRole("button", { name: /Expensive.*Here now/ })).toBeDisabled();
    expect(within(list).getByRole("button", { name: "Ordered" })).toBeInTheDocument();
    expect(within(panel).queryByText("Copies wanted")).toBeNull();
  });

  /**
   * **The assertion the two-pane design actually rests on.**
   *
   * "Not a nested layer" is a promise to a screen reader as much as to the eye: a dialog inside
   * a dialog is announced as one whether or not anything is drawn over anything. Getting the
   * box right and leaving the role behind would make the nesting a lie told to exactly the
   * reader who cannot see that it is one.
   */
  it("adds no second dialog to the tree while the destination list is up", async () => {
    const { user } = setup(BOLT);
    const panel = await open(user, BOLT);
    await user.click(within(panel).getByRole("button", { name: /^Move to folder/ }));

    expect(listIn(panel, BOLT)).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toBe(panel);
  });

  /**
   * The top level, in **this** tree's word.
   *
   * `MoveToFolder` defaults to the deck gallery's "All decks", which is the surface it was
   * written for — and a reader filing a card they are about to buy must not be told they are
   * moving it into the deck gallery. This is the one row whose copy is asserted here, because
   * it is the one this call site chose; every other row's wording is the component's.
   */
  it("names the top level after this list, not after the deck gallery", async () => {
    const { user } = setup(BOLT);
    const panel = await open(user, BOLT);
    await user.click(within(panel).getByRole("button", { name: /^Move to folder/ }));

    const list = listIn(panel, BOLT);
    expect(within(list).getByRole("button", { name: "Wishlist" })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "All decks" })).toBeNull();
  });

  /**
   * The back affordance, and the trap under it: the caret is inside `MoveToFolder`, whose own
   * `onBlur` fires the moment a press lands on this button. Wired to leave the pane, that would
   * unmount the button under the press and the click would never arrive.
   */
  it("comes back from the destination list without writing anything", async () => {
    const { user, onSetFolder } = setup(BOLT);
    const panel = await open(user, BOLT);
    await user.click(within(panel).getByRole("button", { name: /^Move to folder/ }));
    await user.click(within(panel).getByRole("button", { name: "Back" }));

    expect(within(panel).getByText("Copies wanted")).toBeInTheDocument();
    expect(onSetFolder).not.toHaveBeenCalled();
  });

  /**
   * One decision, one Escape rung. This is the whole argument for swapping the body instead of
   * nesting an `AnchoredPopup`: a nested layer would take the first press and leave the reader
   * pressing Escape twice to get out of one panel.
   */
  it("closes the whole panel on one Escape from the destination list", async () => {
    const { user } = setup(BOLT);
    const panel = await open(user, BOLT);
    await user.click(within(panel).getByRole("button", { name: /^Move to folder/ }));
    expect(listIn(panel, BOLT)).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit Lightning Bolt" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: /^Edit Lightning Bolt/ })).toHaveFocus();
  });

  /**
   * The root is a destination with a meaning rather than an omission, and it is the list's first
   * row. Pressed by position and not by name: the wording of that row is `MoveToFolder`'s, and
   * asserting it here would pin one surface's copy in another surface's suite.
   */
  it("files a wish back at the root, and comes back to the main pane", async () => {
    const { user, onSetFolder } = setup(BOLT);
    const panel = await open(user, BOLT);
    await user.click(within(panel).getByRole("button", { name: /^Move to folder/ }));
    await user.click(within(listIn(panel, BOLT)).getAllByRole("button")[0]);

    expect(onSetFolder).toHaveBeenCalledWith(BOLT, null);
    expect(within(panel).getByText("Copies wanted")).toBeInTheDocument();
    // The pane that closed hands the caret back to what opened it, as every layer here does.
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: /^Move to folder/ })).toHaveFocus(),
    );
  });

  /**
   * **The case the whole task exists for.** A wish with no `card_id` gets no context menu on the
   * page, so a control that is not in this panel is nowhere at all: the stepper, the destination
   * list and Remove each have to answer on this row.
   */
  it("reaches every control on a wish with no printing", async () => {
    const { user, onSetQuantity, onRemove, onSetFolder } = setup(ANY);
    const panel = await open(user, ANY);

    await user.click(within(panel).getByRole("button", { name: /^Increase Copies wanted/ }));
    expect(onSetQuantity).toHaveBeenCalledWith(ANY, 2);

    await user.click(within(panel).getByRole("button", { name: /^Move to folder/ }));
    await user.click(within(listIn(panel, ANY)).getByRole("button", { name: "Expensive" }));
    expect(onSetFolder).toHaveBeenCalledWith(ANY, 2);

    await user.click(within(panel).getByRole("button", { name: /^Remove Ancestral Recall/ }));
    expect(onRemove).toHaveBeenCalledWith(ANY);
  });

  /**
   * **The floor is zero, and it was one until issue #284.**
   *
   * The old rule greyed `−` on a single-copy wish, on the argument that zero deletes here and a
   * held-down stepper would be a one-way door. Zero deletes in the collection too — since schema
   * v24 — and `CollectionTable`'s stepper has floored at zero the whole time, so what the greying
   * bought was the wishlist refusing an edit the list beside it allows. Both of this list's views
   * reach this one panel, so a floor left here would have been the wall and the table disagreeing
   * about a number through a control they share.
   *
   * What this component owes is the *press*: it reports `0` and stops there, because turning that
   * into a `wishlistSetQuantity(id, 0)` and dropping the row on the answer is `WishlistPage`'s
   * half and is driven in its own suite. Put `min` back to 1 and the button is `disabled`, which
   * is what the first assertion is for — `userEvent` will not click a disabled button, so without
   * it the case would fail on the call count and read as the handler being unwired.
   */
  it("steps a single-copy wish down to zero, which is how the panel removes one", async () => {
    const ONE: WishRow = { ...BOLT, quantity: 1 };
    const { user, onSetQuantity } = setup(ONE);
    const panel = await open(user, ONE);

    const decrease = within(panel).getByRole("button", { name: /^Decrease Copies wanted/ });
    expect(decrease).not.toBeDisabled();
    await user.click(decrease);

    expect(onSetQuantity).toHaveBeenCalledWith(ONE, 0);
    // And the named press is still there beside it: the overlap is the arrangement, not a
    // duplicate — one press from any quantity, and the one a keyboard reader finds without
    // holding a button down.
    expect(
      within(panel).getByRole("button", { name: /^Remove Lightning Bolt/ }),
    ).toBeInTheDocument();
  });

  /** The pane is the panel's state and dies with it: reopening starts on the main pane, never in
   *  the destination list the reader left up last time. */
  it("reopens on the main pane", async () => {
    const { user } = setup(BOLT);
    const panel = await open(user, BOLT);
    await user.click(within(panel).getByRole("button", { name: /^Move to folder/ }));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit Lightning Bolt" })).toBeNull(),
    );

    const reopened = await open(user, BOLT);
    expect(within(reopened).getByText("Copies wanted")).toBeInTheDocument();
  });
});
