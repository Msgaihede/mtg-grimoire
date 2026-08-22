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

/** The destination list, once the panel has swapped its body for it. */
const listIn = (panel: HTMLElement, row: WishRow) =>
  within(panel).getByRole("dialog", { name: new RegExp(`^Move ${row.name}`) });

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
