import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckQuickAddWish } from "@/lib/ipc";
import { QuickUnwishDialog } from "./QuickUnwishDialog";

/**
 * One wish as `deck_quick_add_wishes` answers one — at the root, which is the row with a `null`
 * folder and therefore the one whose *label this file owns*. Every case that wants a named folder
 * says so, so a folder name in an assertion is never a fixture default.
 */
function wish(over: Partial<DeckQuickAddWish> = {}): DeckQuickAddWish {
  return { id: 31, quantity: 2, folderId: null, folderName: null, ...over };
}

/** The two-row payload this dialog exists for: the root and a folder, in the backend's order. */
const TWO: DeckQuickAddWish[] = [
  wish(),
  wish({ id: 32, quantity: 4, folderId: 8, folderName: "Modern staples" }),
];

interface Options {
  wishes?: readonly DeckQuickAddWish[];
  copies?: number;
  pending?: boolean;
  failure?: string | null;
}

/**
 * Mount it open, with **no query client and no provider of any kind**.
 *
 * That absence is the assertion this helper makes on every case: the write, its pending state and
 * its refusal all arrive as props, so a query or a mutation added to the component later fails the
 * suite here rather than in a review. `AddLabelDialog` — the other dialog this menu opens — is
 * built on the same fence for the same reason.
 */
function open(options: Options = {}) {
  const onConfirm = vi.fn();
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <QuickUnwishDialog
      open
      cardName="Lightning Bolt"
      copies={options.copies ?? 4}
      wishes={options.wishes ?? TWO}
      pending={options.pending ?? false}
      failure={options.failure ?? null}
      onConfirm={onConfirm}
      onDismiss={onDismiss}
      onClose={onClose}
    />,
  );
  return { ...view, onConfirm, onDismiss, onClose };
}

/** The panel, addressed the way the app's other dialog suites address one. */
const panel = () => screen.getByRole("dialog", { name: "Which wish?" });

describe("QuickUnwishDialog", () => {
  /**
   * **The two things that tell one wish from another**: where it sits and how much it asks for.
   *
   * The root is drawn as `Wishlist`, which is that page's own word for `folder_id IS NULL` — a row
   * reading "No folder" would be describing the drawer the breadcrumb calls Wishlist. The count is
   * `plural`'d, because `1 copies` is what a bare number and a hard-coded noun produce on the
   * commonest wish there is.
   */
  it("names each wish by its folder and what it asks for", async () => {
    open({ wishes: [wish({ quantity: 1 }), TWO[1]] });

    const rows = within(await screen.findByRole("dialog", { name: "Which wish?" })).getAllByRole(
      "radio",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName("Wishlist · 1 copy");
    expect(rows[1]).toHaveAccessibleName("Modern staples · 4 copies");
  });

  /**
   * **The first row is pre-picked**, which is the backend's own ranking honoured rather than a
   * guess: the root first, then the reader's folders in their own order. A group with nothing
   * chosen would make the commonest press two acts instead of one.
   */
  it("opens on the backend's first row", async () => {
    open();

    expect(await screen.findByRole("radio", { name: "Wishlist · 2 copies" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Modern staples · 4 copies" })).not.toBeChecked();
  });

  /** The affirmative quotes the count the menu row quoted, so a reader who pressed
   *  `Quick add 4 and remove from wishlist` meets the same 4 here. */
  it("says how many copies the press records", async () => {
    open({ copies: 1 });

    expect(await screen.findByRole("button", { name: "Record 1 copy" })).toBeInTheDocument();
    expect(screen.getByText(/1 copy of Lightning Bolt/)).toBeInTheDocument();
  });

  /** Confirming sends the pre-picked row's id, which is the whole of the ordinary press. */
  it("confirms on the pre-picked wish", async () => {
    const { onConfirm } = open();

    await userEvent.click(await screen.findByRole("button", { name: "Record 4 copies" }));

    expect(onConfirm).toHaveBeenCalledWith(31);
  });

  /**
   * **The other row, which is the case the dialog exists for.**
   *
   * Asserted at the callback rather than on the radio's own `checked`: a group that moved its
   * mark and still sent the head of the list would pass a screen assertion and be exactly the
   * defect this is for.
   */
  it("confirms on whichever wish the reader picks", async () => {
    const { onConfirm } = open();

    await userEvent.click(await screen.findByRole("radio", { name: "Modern staples · 4 copies" }));
    await userEvent.click(screen.getByRole("button", { name: "Record 4 copies" }));

    expect(onConfirm).toHaveBeenCalledWith(32);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  /**
   * **Cancel writes nothing at all, including the add** — the decision this component is built
   * around, and the one a later "surely we should still record the copies" would break silently.
   *
   * `onConfirm` not called is the load-bearing half: the dialog closing is what a reader can see,
   * and a version that dismissed *and* wrote would look identical on screen.
   */
  it("writes nothing when the reader cancels", async () => {
    const { onConfirm, onDismiss } = open();

    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Cancel",
    }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  /** The ✕ is the same answer as Cancel and hands the caret back, which is what tells it from
   *  the scrim — `Dialog` splits the two and this dialog gives them different callbacks. */
  it("writes nothing on the ✕ either, and asks for the caret back", async () => {
    const { onConfirm, onDismiss, onClose } = open();

    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Close which wish" }),
    );

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * **The refusal is drawn inside this panel**, because the editor's banner is behind this
   * dialog's scrim — `DeleteCategory`'s and `ClearCategory`'s rule. A refusal the reader cannot
   * see is a press that did nothing.
   */
  it("draws a refused write where the reader is looking", async () => {
    open({ failure: "that wishlist line is not there any more" });

    expect(await within(panel()).findByRole("alert")).toHaveTextContent(
      "Could not record those copies — that wishlist line is not there any more",
    );
    // Still answerable: a refusal leaves the question open with its button live, which is what
    // makes a second press possible at all.
    expect(screen.getByRole("button", { name: "Record 4 copies" })).toBeEnabled();
  });

  /** In flight, the verb keeps its name and the button is out of reach — the `disabled`
   *  attribute rather than `aria-disabled`, because this is the half-second the write is running
   *  rather than a state the reader can work their way out of. */
  it("says the write is in flight and refuses a second press", async () => {
    open({ pending: true });

    const button = await screen.findByRole("button", { name: "Recording…" });
    expect(button).toBeDisabled();
  });

  /**
   * A payload with nothing in it says so rather than drawing an empty fieldset under a live
   * button. The editor cannot produce this — `chooseWish` opens the layer for two or more — so
   * what it guards is a story, and a stale payload the day something else opens this dialog.
   */
  it("says so rather than drawing an empty question", async () => {
    open({ wishes: [] });

    expect(
      await screen.findByText("No wishlist line matches this printing any more."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record 4 copies" })).toBeDisabled();
  });

  /** Closed is nothing mounted, which is `Dialog`'s own guarantee and what makes the pre-pick
   *  free: every open seeds the picked row from the head of the list with no effect. */
  it("mounts nothing while it is shut", () => {
    render(
      <QuickUnwishDialog
        open={false}
        cardName={null}
        copies={0}
        wishes={[]}
        pending={false}
        failure={null}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
