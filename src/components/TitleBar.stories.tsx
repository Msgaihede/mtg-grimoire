import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { emitFake } from "../../.storybook/fake/event";
import { setMaximized, windowCalls } from "../../.storybook/fake/window";
import { SNAP_HOVER_EVENTS } from "@/lib/window";
import { TitleBar } from "./TitleBar";

/**
 * The window's caption, drawn by the app because `tauri.conf.json` sets `decorations: false`.
 *
 * **The fake window is a singleton, unlike the fake database.** There is one window on the
 * desk and one here, so `.storybook/fake/window.ts` keeps module state rather than per-world
 * state — and `installWorld` clears it, which is what stops one story on this docs page
 * showing a maximized window because the story above it clicked the button.
 */
const meta = {
  title: "Chrome/TitleBar",
  component: TitleBar,
  tags: ["autodocs"],
  decorators: [
    // Full-bleed and `bg-bg`, because this row is the top of the *window*: its bottom border
    // and its 46px buttons only read correctly against the app's ground and against an edge
    // they are flush with. 1280px is the window's own default width (`tauri.conf.json`),
    // which is the width the caption buttons' right edge is measured against.
    (Story) => (
      <div className="w-[1280px] bg-bg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TitleBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A restored window: the middle button offers Maximize and draws one frame. */
export const Default: Story = {};

/**
 * The lockup in the top-left: `GrimoireMark` at 20px in gold, then the name in Cinzel.
 *
 * **Three things about it are invisible on the page and are what this story asserts.** The
 * mark is *simplified* rather than the master artwork — 20px is under `GrimoireMark`'s 24px
 * detail floor, so the component drops the casting circle, the runes and the clasp rivets on
 * its own, and the size prop is the whole of what picks that. It is `pointer-events-none`, so
 * the pointer over it hit-tests to the wrapper that carries `data-tauri-drag-region` and the
 * mark is not a 20×20 patch of caption that refuses to drag the window — a thing no workbench
 * and no jsdom test can be made to demonstrate, since neither hit-tests anything. And it is
 * `aria-hidden`, because the wordmark beside it already sets the product's name in type and a
 * named mark would be that name announced twice.
 *
 * Gold rather than the wordmark's `text-dim` is the one deliberate exception to
 * `SyncProgress.tsx`'s rule that a name is not an action: that rule is about type and
 * controls, and `logos/README.md` specifies `--color-accent` as the mark's own colour.
 */
export const Lockup: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wordmark = await canvas.findByText("MTG GRIMOIRE");
    const lockup = wordmark.parentElement;

    // Both, because `data-tauri-drag-region` does not inherit: the wrapper is what puts the
    // 10px of `gap-2.5` between the two into the grab area, and the wordmark still needs its
    // own inside it.
    await expect(lockup).toHaveAttribute("data-tauri-drag-region");
    await expect(wordmark).toHaveAttribute("data-tauri-drag-region");

    // Through the lockup rather than the canvas: the three caption buttons each draw a lucide
    // `<svg>`, so an unscoped query would answer about the Minimize glyph and pass with the
    // mark deleted.
    const mark = lockup?.querySelector("svg");
    await expect(mark).toHaveAttribute("width", "20");
    await expect(mark).toHaveClass("pointer-events-none");
    await expect(canvas.queryByRole("img")).toBeNull();
  },
};

/**
 * Maximized, which is the *other* glyph and the other label — `Copy`'s two offset frames,
 * lucide's version of the two-rectangle "restore" mark Windows has drawn since 3.1.
 *
 * Set through the fake window rather than by clicking, because that is how it usually
 * happens in the shipped app: on Windows 11 the native snap overlay swallows the click and
 * sends `SC_MAXIMIZE` itself, so the component learns about it from `onResized` and never from
 * its own handler.
 */
export const Maximized: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    setMaximized(true);
    await waitFor(async () =>
      expect(await canvas.findByRole("button", { name: "Restore Down" })).toBeInTheDocument(),
    );
  },
};

/**
 * The hover the pointer cannot produce.
 *
 * On Windows 11 the maximize button sits under a transparent Win32 child window so the OS can
 * raise its Snap Layouts flyout, which means the button's CSS `:hover` never fires. The plugin
 * emits `tauri-snap://snap/mouseenter` and `…/mouseleave` instead, and this is what those look
 * like — the same gold wash the pointer would have drawn.
 */
export const SnapOverlayHover: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole("button", { name: "Maximize" });

    emitFake(SNAP_HOVER_EVENTS.enter, undefined);
    // `classList`, not `className`: the button always carries `hover:bg-accent/10`, whose
    // name contains the unprefixed class, so a substring check would pass before the event.
    await waitFor(() => expect(button.classList.contains("bg-accent/10")).toBe(true));
  },
};

/**
 * Each button reaching its window verb. Minimize and close change nothing on screen — a story
 * cannot be minimized, and one that closed itself would take the workbench with it — so the
 * fake counts them and this asserts the count.
 */
export const EachButtonActsOnTheWindow: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: "Minimize" }));
    await waitFor(() => expect(windowCalls().minimizeCount).toBe(1));

    await userEvent.click(await canvas.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(windowCalls().closeCount).toBe(1));

    // Toggling flips the fake's flag and fires its resize listeners, so the label follows —
    // the one button whose effect a story can actually see.
    await userEvent.click(await canvas.findByRole("button", { name: "Maximize" }));
    await waitFor(async () =>
      expect(await canvas.findByRole("button", { name: "Restore Down" })).toBeInTheDocument(),
    );
  },
};
