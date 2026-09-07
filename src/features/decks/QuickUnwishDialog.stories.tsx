import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor } from "storybook/test";
import type { DeckQuickAddWish } from "@/lib/ipc";
import { QuickUnwishDialog } from "./QuickUnwishDialog";

/**
 * How long a `waitFor` will wait for one animation frame.
 *
 * The dialog fades and scales in, so its first painted frame is at `opacity: 0` — and
 * `toBeVisible` walks the ancestors, so *nothing* inside it is visible until that lands. Under the
 * suite's `MotionGlobalConfig.skipAnimations` that is one frame away rather than 260ms, but it is
 * still a frame, and `findBy*` resolves on the render before it. One wait per play: once the
 * surface has arrived, everything under it is visible in the same tick.
 */
const FRAME_WAIT = 5_000;

/** One wish as `deck_quick_add_wishes` answers one, at the root — the row with a `null` folder,
 *  which is the one whose word this component owns. */
function wish(over: Partial<DeckQuickAddWish> = {}): DeckQuickAddWish {
  return { id: 31, quantity: 2, folderId: null, folderName: null, ...over };
}

/**
 * The payload this dialog exists for: one printing on two shopping lines.
 *
 * The order is the backend's — the root first, then the reader's folders in their own
 * `sort_order` — and the head of it is what the group opens on.
 */
const TWO: DeckQuickAddWish[] = [
  wish(),
  wish({ id: 32, quantity: 4, folderId: 8, folderName: "Modern staples" }),
];

/**
 * Which wishlist line the copies a reader has just bought come off.
 *
 * **It reaches nothing** — no query, no mutation, no fake world. The wishes, the pending flag and
 * the refusal all arrive as props, which is `AddLabelDialog`'s fence applied to the other dialog a
 * deck card's right-click opens: every frame below is an argument rather than a seeded database,
 * and a stray query added to the component later would break these stories rather than pass them.
 */
const meta = {
  title: "Decks/QuickUnwishDialog",
  component: QuickUnwishDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    cardName: "Lightning Bolt",
    copies: 4,
    wishes: TWO,
    pending: false,
    failure: null,
    onConfirm: fn(),
    onDismiss: fn(),
    onClose: fn(),
  },
  parameters: {
    // The dialog is `fixed inset-0` — it covers the window, so a padded canvas would only draw a
    // frame around a scrim that ignores it.
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "`Quick add N and remove from wishlist` is two acts in one press: record the copies " +
          "the deck row is short of, and take them off a wish that was asking for exactly that " +
          "printing. **Almost always there is nothing to decide** — no wish matches, or one " +
          "does — and `quickCollection.ts`'s `chooseWish` settles both without drawing anything " +
          "at all.\n\n" +
          "**This is the third case: several wishes match.** It happens when a reader has one " +
          "card on their list in two folders, and no rule the app could invent would say which " +
          "of them a purchase satisfies — a `Modern staples` line and a `Birthday list` line " +
          "are two different intentions about one card, and picking for the reader would " +
          "quietly empty a list they were keeping on purpose.\n\n" +
          "**Cancel does nothing at all, including the add.** They asked for both halves of one " +
          "act and get neither, which is the only answer a cancel can honestly give: a " +
          "collection row recorded against a wish still standing is the exact state the row " +
          "exists to prevent. The two other rows of that submenu are one press away for a " +
          "reader who wanted only the add.\n\n" +
          "**The first row is pre-picked**, because the backend has already ranked by how " +
          "little of the reader's filing the write disturbs — the root first, then their own " +
          "folders in their own order. A group with nothing chosen would make the commonest " +
          "press two acts instead of one.",
      },
    },
  },
} satisfies Meta<typeof QuickUnwishDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The question, opened on the head of the backend's list.
 *
 * Each row is where the wish sits and what it asks for — the place first, because that is what
 * tells two lines of one card apart and the whole of what the reader is choosing on; the quantity
 * second, because it is the term they *check* rather than choose by, saying whether the press
 * settles the line outright or merely reduces it. `Wishlist` is that page's own word for a wish
 * filed at the root, not "No folder", which would be describing the drawer the breadcrumb names.
 */
export const Ambiguous: Story = {
  play: async ({ canvas, args }) => {
    await waitFor(
      async () =>
        await expect(
          await canvas.findByRole("radio", { name: "Wishlist · 2 copies" }),
        ).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await expect(canvas.getByRole("radio", { name: "Wishlist · 2 copies" })).toBeChecked();
    await expect(canvas.getByRole("radio", { name: "Modern staples · 4 copies" })).not.toBeChecked();

    // The affirmative quotes the number the menu row quoted, so a reader who pressed
    // `Quick add 4 and remove from wishlist` meets the same 4 here.
    await userEvent.click(canvas.getByRole("button", { name: "Record 4 copies" }));
    await expect(args.onConfirm).toHaveBeenCalledWith(31);
  },
};

/**
 * The other line picked, which is the case the dialog exists for.
 *
 * The assertion is at the wire rather than on the screen: a group that moved its mark and still
 * sent the head of the list would look right in a screenshot and be exactly the defect this
 * dialog is for.
 */
export const PickingTheOtherLine: Story = {
  play: async ({ canvas, args }) => {
    await waitFor(
      async () =>
        await expect(
          await canvas.findByRole("radio", { name: "Modern staples · 4 copies" }),
        ).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "Modern staples · 4 copies" }));
    await userEvent.click(canvas.getByRole("button", { name: "Record 4 copies" }));

    await expect(args.onConfirm).toHaveBeenCalledWith(32);
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
  },
};

/**
 * **Cancel writes nothing at all**, and that includes the collection half the reader has already
 * been told is going to happen.
 *
 * `onConfirm` never called is the load-bearing half of this frame: the dialog closing is what a
 * reader can see, and a version that dismissed *and* wrote would look identical on screen.
 */
export const CancelWritesNothing: Story = {
  play: async ({ canvas, args }) => {
    await waitFor(
      async () => await expect(await canvas.findByRole("button", { name: "Cancel" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));

    await expect(args.onDismiss).toHaveBeenCalledTimes(1);
    await expect(args.onConfirm).not.toHaveBeenCalled();
  },
};

/**
 * A single copy, which is the count a reader meets most and the one a bare number gets wrong.
 *
 * `1 copy` and `Record 1 copy` come through `plural`, the same helper the menu row's label and
 * the pull dialog's footer use — this app must never print "1 copies" on the commonest press
 * there is.
 */
export const OneCopy: Story = {
  args: { copies: 1, wishes: [wish({ quantity: 1 }), TWO[1]] },
  play: async ({ canvas }) => {
    await waitFor(
      async () =>
        await expect(
          await canvas.findByRole("button", { name: "Record 1 copy" }),
        ).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
    await expect(canvas.getByRole("radio", { name: "Wishlist · 1 copy" })).toBeVisible();
  },
};

/**
 * The write refused, said **inside** this panel.
 *
 * The editor's own banner is behind this dialog's `LAYER.overlay` scrim, which is
 * `DeleteCategory`'s and `ClearCategory`'s rule and the reason this component takes a `failure` at
 * all: without it the reader sees a press that did nothing and a question still open. The commonest
 * refusal is the one this dialog's own round trip makes possible — a second window ticking the
 * line off the shopping list while the picker was up.
 *
 * The question stays answerable, which is what makes a second press possible at all.
 */
export const Refused: Story = {
  args: { failure: "That wishlist line is not there any more." },
  play: async ({ canvas }) => {
    await waitFor(
      async () => await expect(await canvas.findByRole("alert")).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Could not record those copies — That wishlist line is not there any more.",
    );
    await expect(canvas.getByRole("button", { name: "Record 4 copies" })).toBeEnabled();
  },
};

/**
 * The half-second the write is in flight: the verb keeps its name and the button is out of reach.
 *
 * The `disabled` attribute rather than `aria-disabled`, which is the app's own split — this is a
 * state the reader cannot work their way out of by changing what they picked, so leaving the tab
 * order for the length of a round trip costs nothing.
 */
export const Recording: Story = {
  args: { pending: true },
  play: async ({ canvas }) => {
    await waitFor(
      async () => await expect(await canvas.findByRole("button", { name: "Recording…" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
    await expect(canvas.getByRole("button", { name: "Recording…" })).toBeDisabled();
  },
};
