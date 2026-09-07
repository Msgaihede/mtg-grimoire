import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID } from "@/components/tooltip/TooltipProvider";
import { cardScaleVars } from "@/lib/cardZoom";
import { ART_ASPECT } from "@/lib/images";
import type { PipCounts } from "@/lib/mana";
import { DECK_COLOR_SEGMENT_ATTR, DeckColorBar } from "./DeckColorBar";

/** A pip record with the named colours in it and zero everywhere else — `deckPips`' shape,
 *  written here by hand so a story is one deck's colours rather than a whole fake world. */
function pips(counts: Partial<PipCounts>): PipCounts {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...counts };
}

/**
 * A deck tile with the picture taken out — the crop's rounded box, the bar, the name and the
 * caption, at the width the gallery's grid track gives a tile at 100%.
 *
 * A **stand-in** rather than `DeckTile`, which takes a `DeckRow`, a `Decks`, a folder tree and
 * the whole context-menu wiring and has its page's own stories. What is copied verbatim is the
 * one thing this component's geometry is decided against: the two scale variables on the root,
 * and the 8px the name sits below whatever is above it. The bar's own 4px is its own.
 */
function TileStandIn({ children, zoom = 1 }: { children: ReactNode; zoom?: number }) {
  return (
    <div style={{ ...cardScaleVars(zoom), width: `${220 * zoom}px` }} className="text-left">
      <span
        className="grid w-full place-items-center overflow-hidden rounded-lg bg-surface"
        style={{ aspectRatio: ART_ASPECT }}
      >
        <span className="text-[calc(0.7rem*var(--mark-scale,1))] text-dim">Cover art</span>
      </span>
      {children}
      <span className="mt-[calc(0.5rem*var(--mark-scale,1))] block truncate text-[calc(0.875rem*var(--mark-scale,1))] leading-[calc(1.25rem*var(--mark-scale,1))]">
        Trostani, Selesnya’s Voice
      </span>
      <span className="mt-[calc(0.125rem*var(--mark-scale,1))] block truncate text-[calc(0.75rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))] text-dim">
        Commander · Bracket ~3 · 100 cards
      </span>
    </div>
  );
}

const meta = {
  title: "Decks/DeckColorBar",
  component: DeckColorBar,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "What colours a deck is, as one 5px rule under its cover art — the fact a reader " +
          "browses a wall of decks by, and the one thing a cover cannot carry, because a " +
          "cover is one printing and an identity is the other ninety-nine. Issue #387.\n\n" +
          "**The pips come from the printed mana costs and are counted elsewhere.** Rust " +
          "answers cost strings, `mana.ts` tokenises them and `deckPips.ts` folds them into a " +
          "`PipCounts`; this draws a record and computes nothing but percentages. A hybrid " +
          "counts one pip of each half, a twobrid counts its colour, `{C}` gets a segment and " +
          "generic gets nothing — the issue's own instruction, and it is spelled once in " +
          "`countPips` rather than a second time here.\n\n" +
          "**Segments are in printed order and a colour with no pips draws none** — not a " +
          "zero-width one, which is a DOM node a test can find and a reader cannot. **A deck " +
          "with no pips at all draws no bar**: an all-lands pile has nothing to say, and an " +
          "empty grey rule saying so is worse than silence and indistinguishable from a " +
          "rendering fault.\n\n" +
          "The fills are the `--color-pie-*` deeps `DeckStats` draws its identity pips in — " +
          "the same six custom properties, so the wall and the editor cannot come apart. The " +
          "accessible name is the colours alone (`White, Green`); the counts are in the " +
          "tooltip, where a reader who wants the arithmetic can ask for it.",
      },
    },
  },
} satisfies Meta<typeof DeckColorBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shape the gallery actually draws: a two-colour deck, under the crop and over the name.
 *
 * The bar hugs the picture — 4px above it against the name's 8px below — because it is a fact
 * about the cards drawn as part of the picture rather than a second caption.
 */
export const OnATile: Story = {
  args: { pips: pips({ W: 34, G: 22 }) },
  render: (args) => (
    <TileStandIn>
      <DeckColorBar {...args} />
    </TileStandIn>
  ),
  play: async ({ canvasElement }) => {
    // Addressed by the segment attribute's parent, because the bar deliberately has no role and
    // no name at all — the colours are said by `DeckTile`'s `sr-only` span, after the deck's
    // name. A query that could name this element would be asserting the opposite.
    await expect(canvasElement.querySelector("[role='img']")).toBeNull();
    const drawn = [...canvasElement.querySelectorAll(`[${DECK_COLOR_SEGMENT_ATTR}]`)];
    await expect(drawn).toHaveLength(2);
    await expect(drawn.map((s) => s.getAttribute(DECK_COLOR_SEGMENT_ATTR))).toEqual(["W", "G"]);
  },
};

/**
 * One colour, one segment, the whole width — which is what makes the bar readable at a glance on
 * a wall: a mono deck is a solid rule and a five-colour deck is a ribbon, told apart before
 * either name is read.
 */
export const MonoColor: Story = {
  args: { pips: pips({ U: 41 }) },
  render: (args) => (
    <TileStandIn>
      <DeckColorBar {...args} />
    </TileStandIn>
  ),
};

/** Every colour a bar can draw, colourless included, so all six deeps are on one screen and a
 *  fill that had drifted from `DeckStats` would be visible rather than argued about. */
export const EveryColor: Story = {
  args: { pips: pips({ W: 8, U: 8, B: 8, R: 8, G: 8, C: 4 }) },
  render: (args) => (
    <TileStandIn>
      <DeckColorBar {...args} />
    </TileStandIn>
  ),
};

/** A deck built around `{C}` — colourless is a colour to this bar, and it is printed last. */
export const Colorless: Story = {
  args: { pips: pips({ C: 26 }) },
  render: (args) => (
    <TileStandIn>
      <DeckColorBar {...args} />
    </TileStandIn>
  ),
};

/**
 * The two silences, side by side, and the point of the story is that they look identical: an
 * all-lands pile and a read still out both draw nothing, and the tile is simply 9px shorter.
 *
 * Worth seeing once, because "no bar" is a state a reader meets and not an error — a wall
 * mixing tiles with bars and tiles without is the drawing working.
 */
export const NothingToSay: Story = {
  args: { pips: null },
  render: () => (
    <div className="flex gap-4">
      <TileStandIn>
        <DeckColorBar pips={null} />
      </TileStandIn>
      <TileStandIn>
        <DeckColorBar pips={pips({})} />
      </TileStandIn>
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[role='img']")).toHaveLength(0);
    await expect(canvasElement.querySelectorAll(`[${DECK_COLOR_SEGMENT_ATTR}]`)).toHaveLength(0);
  },
};

/**
 * The zoom, which is the reason the height is a `calc` off `--mark-scale` rather than a fixed
 * 5px: the tiles around this bar grow with the reader's wheel, and a rule that stayed 5px would
 * be the one thing on the wall that ignored the gesture.
 */
export const AcrossTheZoom: Story = {
  args: { pips: pips({ B: 30, R: 18, G: 6 }) },
  render: (args) => (
    <div className="flex items-start gap-6">
      {[0.7, 1, 1.6].map((zoom) => (
        <TileStandIn key={zoom} zoom={zoom}>
          <DeckColorBar {...args} />
        </TileStandIn>
      ))}
    </div>
  ),
};

/**
 * The counts, which are the half the accessible name deliberately leaves out — a reader walking
 * the wall wants "White, Green", and a reader who wants eleven and eight hovers for it.
 *
 * `describes: false`, so there is no `aria-describedby` and the panel is the whole of what a
 * pointer gets: this span is not focusable and sits inside the tile's button, so a description
 * wired here would be announced to nobody.
 */
export const CountsInTheTooltip: Story = {
  args: { pips: pips({ W: 11, G: 8 }) },
  render: (args) => (
    <TileStandIn>
      <DeckColorBar {...args} />
    </TileStandIn>
  ),
  play: async ({ canvasElement }) => {
    const bar = canvasElement.querySelector<HTMLElement>(`[${DECK_COLOR_SEGMENT_ATTR}]`)
      ?.parentElement;
    await userEvent.hover(bar!);
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_OPEN_MS + 50));
    const panel = canvasElement.ownerDocument.getElementById(TOOLTIP_PANEL_ID);
    await expect(panel).toHaveTextContent("White 11, Green 8");
    await expect(bar).not.toHaveAttribute("aria-describedby");
  },
};
