import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { DeckDialog } from "./DeckDialog";

/**
 * How long a `waitFor` will wait for this shell's first frame — **the constant every dialog
 * built on it needs, which is why the explanation lives here.**
 *
 * The panel fades and scales in, so its first painted frame carries its `initial`; and
 * `toBeVisible` walks the ancestors, so *nothing* inside the panel is visible until the next
 * frame lands. `findBy*` does not cover it — that waits for an element to **exist**, never to
 * become visible — so an assertion about anything inside a newly opened dialog is wrapped in a
 * `waitFor` and not merely awaited. `src/CLAUDE.md`'s motion rules state it app-wide.
 *
 * Under the suite's `MotionGlobalConfig.skipAnimations` the wait is one `requestAnimationFrame`
 * rather than the preset's 260ms — but jsdom has no compositor, `motion` drives that frame off a
 * timer, and the whole suite is a hundred-odd jsdom files running in parallel. So the default
 * one second is a wait on the *scheduler*: these plays passed in isolation every time and four
 * of them failed under `npm run test:run`. Seconds rather than milliseconds for that reason
 * alone. `TheoryDiffDialog.stories.tsx` measured the same thing first and carries its own copy,
 * because that dialog draws its own scrim rather than borrowing this one.
 *
 * **Not exported, and it must not be.** CSF reads every named export of a story file as a story,
 * so a shared constant hoisted out of one would be indexed as one — a story with a number for a
 * component. Each file keeps its own copy of the value and points back here for the reason.
 */
const FRAME_WAIT = 5_000;

/** A body that is only a body: the shell's half of the bargain is the header, and this is the
 *  host's — its own `min-h-0 flex-1 overflow-y-auto` scroller, with its own padding. */
function Body({ paragraphs }: { paragraphs: number }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <p className="text-sm text-dim">
        The shell owns the scrim, the panel, the trap, the Escape rung, the heading and the ✕.
        Everything under the rule above is the host&rsquo;s, including the box that scrolls.
      </p>
      {Array.from({ length: paragraphs }, (_, i) => (
        <p key={i} className="mt-3.5 text-sm text-dim">
          Paragraph {i + 1}. A deck is what a reader has decided about sixty pieces of cardboard,
          and every dialog the builder opens is asking about one of those decisions.
        </p>
      ))}
    </div>
  );
}

/**
 * The deck builder's modal shell — the chrome every one of its dialogs is made of.
 *
 * It exists because &ldquo;in the style of Deck settings&rdquo; was a **resemblance** across four
 * surfaces, and a resemblance is four independent decisions that happen to agree today. The
 * chrome was lifted whole out of `DeckSettingsDialog`, so what is storied here is the frame with
 * nothing inside it: a scrim a pointer cannot cross, a centred panel that takes the caret, a
 * titled header and a ✕ named by its host.
 *
 * **The bodies live in their own story files** — `Decks/Settings dialog` is this shell with a
 * deck's settings in it, and each of the builder's other dialogs is the same frame around its own
 * queries. Nothing on this page reaches the backend at all, which is the shell's own rule seen
 * from the workbench: it knows what a dialog is and nothing about what a deck is.
 *
 * Three things it guarantees to every host, all visible here. **Closed is nothing mounted** — see
 * {@link Closed}, where the body is an element React never puts in the tree, so its queries never
 * run. **The body owns its own scroller**, because the builder's dialogs do not agree about what
 * scrolls inside them — see {@link LongBody}. And **the width is written out whole** by the host
 * (`w-[55rem]` here), because Tailwind scans source text and a class built by interpolation emits
 * no rule at all.
 */
const meta = {
  title: "Decks/Dialog shell",
  component: DeckDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    title: "Deck settings",
    closeLabel: "Close deck settings",
    width: "w-[55rem]",
    onDismiss: fn(),
    onClose: fn(),
    children: <Body paragraphs={1} />,
  },
  parameters: {
    // **Its own frame per docs story, and the scrim is why.** It is `fixed inset-0`: rendered
    // inline, every story on the docs page would cover the whole page rather than its own block,
    // and the last one mounted would be the only one anybody could read. `inline: false` gives
    // each story an iframe, which is the viewport the fixed positioning is then relative to.
    docs: { story: { inline: false, height: "600px" } },
  },
} satisfies Meta<typeof DeckDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The frame, open, with a sentence in it.
 *
 * The caret is on the **panel** and not on anything inside it: these are panels of settled values
 * rather than questions, and dropping the caret into a host's first field would make the reader's
 * first keystroke an edit. `tabIndex={-1}` keeps the panel out of its own cycle, so that counts as
 * *before* the first stop — which is what makes the reader's very first Shift+Tab wrap to the end
 * rather than fall out of a layer claiming `aria-modal`.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Deck settings" });

    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveFocus();
    // Named by the host rather than derived from the title: "Close Categories & tags" is not a
    // sentence. Waited out rather than read straight off the render `findByRole` resolved on —
    // see {@link FRAME_WAIT}, which is what every `toBeVisible` inside this shell needs.
    await waitFor(
      async () =>
        await expect(canvas.getByRole("button", { name: "Close deck settings" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
  },
};

/**
 * A body longer than the panel, scrolling **inside** it.
 *
 * The panel is `flex max-h-full flex-col`, so it grows to the window and stops; the host's own
 * `min-h-0 flex-1 overflow-y-auto` is what takes the overflow. The header stays put because it is
 * a flex child that never shrinks, not because anything is sticky.
 *
 * The shell deliberately does **not** own that scroller. The builder's dialogs disagree about what
 * scrolls — one keeps a sticky roll-up inside its scroller — so a shell that wrapped `children` in
 * a scroll container would hand that one two, and every other host a prop to turn it off.
 */
export const LongBody: Story = {
  args: {
    title: "Categories & tags",
    closeLabel: "Close categories and tags",
    width: "w-[48rem]",
    children: <Body paragraphs={24} />,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Categories & tags" });

    // The width is the host's, verbatim; `max-w-full` is the shell's, so a panel wider than the
    // window still fits inside it.
    await expect(dialog).toHaveClass("w-[48rem]");
    await expect(dialog).toHaveClass("max-w-full");
    // Header and body, and nothing wrapped around the body.
    await expect(dialog.children).toHaveLength(2);
    await expect(dialog.lastElementChild).toHaveClass("overflow-y-auto");
    await expect(canvas.getByText(/^Paragraph 24\./)).toBeInTheDocument();
  },
};

/**
 * A press on the scrim closes; a press inside the panel does not.
 *
 * The handler is `onMouseDown` rather than `onClick`, and the target check is why: a drag that
 * starts on a textarea's resize handle and ends out on the scrim fires a `click` on the two
 * targets' common ancestor, so a click handler would close the dialog on a gesture that never
 * left it. Where the press *lands* is unambiguous.
 *
 * **Closing is not dismissing.** Escape and the ✕ hand focus back to whatever opened the dialog;
 * a reader who pressed the scrim is already somewhere else, so nothing moves their caret for them.
 */
export const PressingTheScrim: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Deck settings" });

    await userEvent.click(dialog);
    await expect(args.onClose).not.toHaveBeenCalled();

    await userEvent.click(dialog.parentElement as HTMLElement);
    await expect(args.onClose).toHaveBeenCalledTimes(1);
    await expect(args.onDismiss).not.toHaveBeenCalled();
  },
};

/**
 * Closed is **nothing mounted**, not a hidden panel.
 *
 * The body is passed as an *element*, and an element React never puts in the tree is a component
 * that never ran — so a host's queries, drafts and caret position all begin at the open. That is
 * what lets the deck editor mount every one of its dialogs unconditionally and pay for none of
 * them.
 */
export const Closed: Story = {
  args: { open: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("dialog")).toBeNull();
  },
};
