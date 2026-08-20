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
