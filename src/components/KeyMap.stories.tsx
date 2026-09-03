import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Keyboard } from "lucide-react";
import { useAppStore, type ViewId } from "@/lib/store";
import { cn } from "@/lib/utils";
import { KEY_MAP_LABEL, KeyMap } from "./KeyMap";

/**
 * The list of what the keyboard does, opened from the caption bar's fourth button.
 *
 * **What it draws is decided entirely by where the reader is standing** — `activeScopes` answers
 * with `global` and exactly one more scope, and a scope holding no shortcuts draws nothing at
 * all rather than a heading over a gap. All six views are in that state today — `deckEditor` is
 * a scope of its own that *replaces* `decks` rather than filling it — so the two stories below
 * are not an edge case and its opposite; they are the two shapes a reader actually meets.
 *
 * The trigger here is scaffolding. `TitleBar` owns the real caption button and keeps it private,
 * so this is that button's geometry and nothing else — the panel has to open from a 46×34 square
 * flush with the right edge or its placement is a story about a different control.
 * `Chrome/TitleBar` is where the real pair is drawn.
 */
const meta = {
  title: "Chrome/KeyMap",
  component: KeyMap,
  tags: ["autodocs"],
  // Every story here writes `useAppStore` during render, and the store is one object for the
  // whole docs page — inline, the last writer's view would be the view under every heading.
  parameters: { docs: { story: { inline: false, height: "420px" } } },
  // Never read: each story renders its own `KeyMap` with a real trigger inside it. It is here
  // because `children` is a required prop and `satisfies` asks for it.
  args: { children: null },
} satisfies Meta<typeof KeyMap>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The caption button's geometry, standing in for the caption button. */
function Trigger() {
  const open = useAppStore((s) => s.keyMapOpen);
  const setOpen = useAppStore((s) => s.setKeyMapOpen);
  return (
    <button
      type="button"
      aria-label={KEY_MAP_LABEL}
      aria-expanded={open}
      onClick={() => {
        setOpen(!open);
      }}
      className={cn(
        "inline-flex h-full w-[46px] shrink-0 items-center justify-center",
        // `ring-inset` for the caption's own reason: a ring outside an element flush with the
        // window's corner is drawn outside the window.
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        open ? "bg-accent/10 text-accent" : "text-dim hover:bg-accent/10 hover:text-accent",
      )}
    >
      <Keyboard className="size-4" aria-hidden="true" />
    </button>
  );
}

/**
 * A caption-shaped row with the trigger at its right end, and the store said before anything
 * mounts.
 *
 * The write is during render rather than in an effect — an effect runs after the first paint, so
 * a story that opened the panel there would show the caption alone for a frame and then a panel
 * arriving, which is a gesture nobody made.
 */
function Row({ view, deckOpen, open }: { view: ViewId; deckOpen: boolean; open: boolean }) {
  useState(() => {
    useAppStore.setState({ activeView: view, openDeckId: deckOpen ? 7 : null, keyMapOpen: open });
  });
  return (
    <div className="flex h-[34px] justify-end border-b border-border bg-surface">
      <KeyMap>
        <Trigger />
      </KeyMap>
    </div>
  );
}

/**
 * In the deck editor: two sections, and the second is `Deck editor` rather than `Decks`.
 *
 * `App.tsx` renders the editor *instead of* the deck gallery, so `activeScopes` replaces the
 * view's scope rather than nesting under it — a `Decks` heading here would list chords for a
 * page that is not on screen. `Decks` itself binds nothing, so even the gallery would draw no
 * section of its own.
 */
export const InTheDeckEditor: Story = {
  render: () => <Row view="decks" deckOpen open />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("heading", { name: "Everywhere" })).toBeInTheDocument();
    await expect(await canvas.findByRole("heading", { name: "Deck editor" })).toBeInTheDocument();
    await expect(canvas.queryByRole("heading", { name: "Decks" })).toBeNull();
    // Both spellings of redo, because both are muscle memory somewhere.
    await expect(canvas.getByText("Redo the change you undid")).toBeInTheDocument();
  },
};

/**
 * On the search page: one section, and no second heading at all.
 *
 * This is the honest floor rather than a gap — the search page binds nothing of its own, and
 * what a reader can press there is exactly what `Everywhere` lists. A heading over an empty list
 * would promise a page that has more to offer than it does.
 */
export const OnTheSearchPage: Story = {
  render: () => <Row view="search" deckOpen={false} open />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("heading", { name: "Everywhere" })).toBeInTheDocument();
    await expect(canvas.getAllByRole("heading")).toHaveLength(1);
    // The one row that stands for six chords: a range, not six alternatives.
    await expect(canvas.getByText("Jump to a section")).toBeInTheDocument();
  },
};

/**
 * Closed, and opened by pressing — the state the caption is in until somebody asks.
 *
 * The button lights while the panel is open, and it is the same wash the pointer draws: a
 * caption button has no room for a chevron, so `aria-expanded` and that wash are the whole of
 * what says the panel belongs to this button.
 */
export const OpenedByPressing: Story = {
  render: () => <Row view="search" deckOpen={false} open={false} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = await canvas.findByRole("button", { name: KEY_MAP_LABEL });
    await expect(button).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(button);
    await waitFor(async () => {
      await expect(button).toHaveAttribute("aria-expanded", "true");
    });
    await expect(await canvas.findByRole("heading", { name: "Everywhere" })).toBeInTheDocument();
  },
};
