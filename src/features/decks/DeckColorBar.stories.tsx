import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID } from "@/components/tooltip/TooltipProvider";
import { cardScaleVars } from "@/lib/cardZoom";
import { ART_ASPECT } from "@/lib/images";
import type { PipCounts } from "@/lib/mana";
import { cn } from "@/lib/utils";
import { DECK_COLOR_SEGMENT_ATTR, DeckColorBar, hasColorBar } from "./DeckColorBar";

/** A pip record with the named colours in it and zero everywhere else — `deckPips`' shape,
 *  written here by hand so a story is one deck's colours rather than a whole fake world. */
function pips(counts: Partial<PipCounts>): PipCounts {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, ...counts };
}

/**
 * A deck tile with the picture taken out — the crop's box, the band, the name and the caption, at
 * the width the gallery's grid track gives a tile at 100%.
 *
 * A **stand-in** rather than `DeckTile`, which takes a `DeckRow`, a `Decks`, a folder tree and
 * the whole context-menu wiring and has its page's own stories. What is copied verbatim are the
 * two things this component's geometry is decided against: the two scale variables on the root,
 * and the 8px the name sits below whatever is above it. The band's own margin used to be the
 * third and is nothing at all now — it abuts the crop, which is the point.
 *
 * **It draws the crop's radius through `hasColorBar`, exactly as the real tile does**, because
 * that join is the thing these stories are for: the crop gives up its bottom two corners only
 * when a band is coming to take them, and a stand-in that hard-coded `rounded-t-lg` would draw a
 * square-cornered picture over nothing on the two silences below and show none of it.
 */
function TileStandIn({ pips: counts, zoom = 1 }: { pips: PipCounts | null; zoom?: number }) {
  return (
    <div style={{ ...cardScaleVars(zoom), width: `${220 * zoom}px` }} className="text-left">
      <span
        // A handle for the play below, because the radius is the one thing about this stand-in
        // that is under test and a crop has no role, no name and no text of its own worth
        // querying. `[style*='aspect-ratio']` would have worked and is a query about how React
        // serialises an inline style rather than about the drawing.
        data-story-crop=""
        className={cn(
          "grid w-full place-items-center overflow-hidden bg-surface",
          hasColorBar(counts) ? "rounded-t-lg" : "rounded-lg",
        )}
        style={{ aspectRatio: ART_ASPECT }}
      >
        <span className="text-[calc(0.7rem*var(--mark-scale,1))] text-dim">Cover art</span>
      </span>
      <DeckColorBar pips={counts} />
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
          "What colours a deck is, as a 20px band fused to the foot of its cover art — the " +
          "fact a reader browses a wall of decks by, and the one thing a cover cannot carry, " +
          "because a cover is one printing and an identity is the other ninety-nine. " +
          "Issue #387.\n\n" +
          "**It is the tile's foot rather than a rule under a picture.** The crop is drawn " +
          "`rounded-t-lg` and the band `rounded-b-lg` with no air between them, so the two read " +
          "as one object; `hasColorBar` is what tells the tile which radius to use, and it is " +
          "`true` exactly when this component draws something. Each colour gets a field of its " +
          "own with its **printed mana symbol** on it, in near-black, which is the arrangement " +
          "`index.css` states at the token and the filter row's mana chips already ship — so a " +
          "reader reads the band in the vocabulary they already have instead of learning six " +
          "fills.\n\n" +
          "**The pips come from the printed mana costs and are counted elsewhere.** Rust " +
          "answers cost strings, `mana.ts` tokenises them and `deckPips.ts` folds them into a " +
          "`PipCounts`; this draws a record and computes nothing but percentages. A hybrid " +
          "counts one pip of each half, a twobrid counts its colour, `{C}` gets a segment and " +
          "generic gets nothing — the issue's own instruction, and it is spelled once in " +
          "`mana.ts`'s `addPips` rather than a second time here.\n\n" +
          "**Segments are in printed order and a colour with no pips draws none** — not a " +
          "zero-width one, which is a DOM node a test can find and a reader cannot. **A deck " +
          "with no pips at all draws no band**: an all-lands pile has nothing to say, an empty " +
          "grey band saying so is worse than silence and indistinguishable from a rendering " +
          "fault, and the crop simply keeps all four of its own corners.\n\n" +
          "The fills are the `--color-mana-*` values a real printed symbol's disc carries, not " +
          "the `--color-pie-*` identity deeps the 5px rule this replaced used: a black `ms-b` " +
          "on `--color-pie-b` (#3b3a3e) is invisible. The accessible name is nothing at all — " +
          "the colours are said in `DeckTile`'s `sr-only` span after the deck's name, and the " +
          "counts are in the tooltip, where a reader who wants the arithmetic can ask for it.",
      },
    },
  },
} satisfies Meta<typeof DeckColorBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The shape the gallery actually draws: a two-colour deck, as the foot of the crop and over the
 * name.
 *
 * The band abuts the picture — no margin at all, against the name's 8px below — because it is a
 * fact about the cards drawn as part of the picture rather than a second caption. The hairline
 * across its top is what keeps the two legible as two things.
 */
export const OnATile: Story = {
  args: { pips: pips({ W: 34, G: 22 }) },
  render: (args) => <TileStandIn pips={args.pips} />,
  play: async ({ canvasElement }) => {
    // Addressed by the segment attribute's parent, because the band deliberately has no role and
    // no name at all — the colours are said by `DeckTile`'s `sr-only` span, after the deck's
    // name. A query that could name this element would be asserting the opposite.
    await expect(canvasElement.querySelector("[role='img']")).toBeNull();
    const drawn = [...canvasElement.querySelectorAll(`[${DECK_COLOR_SEGMENT_ATTR}]`)];
    await expect(drawn).toHaveLength(2);
    await expect(drawn.map((s) => s.getAttribute(DECK_COLOR_SEGMENT_ATTR))).toEqual(["W", "G"]);
    // Each field carries its printed symbol — the change that made this a band rather than a
    // rule. The glyph is a font `::before`, so the element is empty and only its class says so,
    // which is why this asks the selector rather than reading any text.
    await expect(drawn[0].querySelector("i.ms.ms-w")).not.toBeNull();
    await expect(drawn[1].querySelector("i.ms.ms-g")).not.toBeNull();
  },
};

/**
 * One colour, one field, the whole width — which is what makes the band readable at a glance on a
 * wall: a mono deck is one symbol centred under the picture and a five-colour deck is a row of
 * five, told apart before either name is read.
 */
export const MonoColor: Story = {
  args: { pips: pips({ U: 41 }) },
  render: (args) => <TileStandIn pips={args.pips} />,
};

/** Every colour a band can draw, colourless included, so all six fills and all six glyphs are on
 *  one screen — a near-black symbol that had drifted onto a dark field would be visible here
 *  rather than argued about. */
export const EveryColor: Story = {
  args: { pips: pips({ W: 8, U: 8, B: 8, R: 8, G: 8, C: 4 }) },
  render: (args) => <TileStandIn pips={args.pips} />,
};

/** A deck built around `{C}` — colourless is a colour to this band, and it is printed last. */
export const Colorless: Story = {
  args: { pips: pips({ C: 26 }) },
  render: (args) => <TileStandIn pips={args.pips} />,
};

/**
 * The splash, which is what the 26px floor is for: one blue pip in forty is 2.5% of the tile, and
 * 2.5% of 220px is 5px — a field with no room for the symbol that is the whole point of it.
 *
 * Drawn at 1× and at 0.5×, because the floor scales: a fixed 26px would take a third of a
 * half-size tile for one splash, and the share is still the honest percentage underneath — the
 * floor is a `min-width` laid over it rather than a fudged number.
 */
export const Splash: Story = {
  args: { pips: pips({ W: 39, U: 1 }) },
  render: (args) => (
    <div className="flex items-start gap-6">
      {[1, 0.5].map((zoom) => (
        <TileStandIn key={zoom} pips={args.pips} zoom={zoom} />
      ))}
    </div>
  ),
};

/**
 * The two silences, side by side, and the point of the story is that they look identical: an
 * all-lands pile and a read still out both draw nothing, and **the crop keeps all four of its own
 * corners** — which is `hasColorBar` answering the tile rather than the tile guessing.
 *
 * Worth seeing once, because "no band" is a state a reader meets and not an error — a wall mixing
 * tiles with bands and tiles without is the drawing working.
 */
export const NothingToSay: Story = {
  args: { pips: null },
  render: () => (
    <div className="flex gap-4">
      <TileStandIn pips={null} />
      <TileStandIn pips={pips({})} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[role='img']")).toHaveLength(0);
    await expect(canvasElement.querySelectorAll(`[${DECK_COLOR_SEGMENT_ATTR}]`)).toHaveLength(0);
    // Both crops are round on all four corners, because no band is coming to take two of them.
    const crops = [...canvasElement.querySelectorAll("[data-story-crop]")];
    await expect(crops).toHaveLength(2);
    for (const crop of crops) await expect(crop.classList.contains("rounded-lg")).toBe(true);
  },
};

/**
 * The zoom, which is the reason every size here is a `calc` off `--mark-scale` rather than a
 * fixed 20px: the tiles around this band grow with the reader's wheel, and a band that stayed
 * 20px would be the one thing on the wall that ignored the gesture — with a 12px symbol rattling
 * around inside it at the top of the ladder.
 */
export const AcrossTheZoom: Story = {
  args: { pips: pips({ B: 30, R: 18, G: 6 }) },
  render: (args) => (
    <div className="flex items-start gap-6">
      {[0.7, 1, 1.6].map((zoom) => (
        <TileStandIn key={zoom} pips={args.pips} zoom={zoom} />
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
  render: (args) => <TileStandIn pips={args.pips} />,
  play: async ({ canvasElement }) => {
    const band = canvasElement.querySelector<HTMLElement>(`[${DECK_COLOR_SEGMENT_ATTR}]`)
      ?.parentElement;
    await userEvent.hover(band!);
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_OPEN_MS + 50));
    const panel = canvasElement.ownerDocument.getElementById(TOOLTIP_PANEL_ID);
    await expect(panel).toHaveTextContent("White 11, Green 8");
    await expect(band).not.toHaveAttribute("aria-describedby");
  },
};
