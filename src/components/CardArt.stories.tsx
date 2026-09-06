import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { printing } from "../../.storybook/fake/fixtures";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID } from "@/components/tooltip/TooltipProvider";
import { soleFinish } from "@/lib/finish";
import { CardArt } from "./CardArt";

const meta = {
  title: "Cards/CardArt",
  component: CardArt,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="w-44">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "One card's art in its 5:7 frame — the picture, its retry, and what is drawn when " +
          "there is no picture.\n\n" +
          "**Extracted because five surfaces drew a card** and each had rebuilt part of this: " +
          "the search wall's tiles, the card pane's main art, the pane's printings rows, the " +
          "deck editor's card views and `PrintingPreview`. They agreed on the aspect ratio and " +
          "disagreed about everything else, which is how a foil marking would otherwise have " +
          "come to exist in five slightly different versions. Two of those five went with the " +
          "docked pane on 2026-09-03: its main art is `CardModalArt`'s now, and the printings " +
          "rows became `AllPrintingsDialog`'s tile wall, which is a `CardGrid` and so draws " +
          "this frame.\n\n" +
          "**The foil treatment says what the object *is*, never what it could have been.** " +
          "`soleFinish` (`src/lib/finish.ts`) marks only a printing that leaves no choice — " +
          "12,366 foil-only and 892 etched-only paper printings, measured 2026-08-11 over the " +
          "live corpus. The 53,224 printings that merely *have* a foil version are unmarked: a " +
          "sheen on 61% of every wall would be decoration rather than information.\n\n" +
          "**The sheen tints and never covers.** A `linear-gradient` in " +
          "`mix-blend-mode: screen`, where the gradient's own alphas are the strength — 0.10 " +
          "to 0.13 on the rainbow stops and 0.34 on the one bright band — because a real foil " +
          "is a diffraction grating throwing a different hue at every angle and Scryfall's " +
          "photography has none of it: the art of a foil-only printing is byte-identical to a " +
          "nonfoil one. (`overlay` at 12% was the first attempt and it was *invisible*, " +
          "measured over CDP 2026-08-11.) Legibility is a screenshot question rather than an " +
          "assertion, so the live CDP pass is what proves it; what a story can prove is that " +
          "the whole overlay is `aria-hidden` and that the chip is still hoverable.\n\n" +
          "**The chip holds two facts, and they are different kinds of fact.** A finish " +
          "belongs to the *printing*; a game changer belongs to the *card* — every printing of " +
          "Rhystic Study is one — so a card carries either, both or neither, and both means one " +
          "chip with two glyphs rather than two boxes over the same corner. The crown is the " +
          "deck stack's `GameChangerBanner` glyph without its ribbon, and the same fact the " +
          "other three deck views abbreviate as `GameChangerBadge`'s gold `GC` — one gold, " +
          "three amounts of room.\n\n" +
          "**The frame draws its own edge, and it is the edge `CardChin` continues.** Every " +
          "surface that draws this frame draws a chin under it, and the chin joins whichever " +
          "outline its host has — under the deck's stacks that host is a bordered card, so the " +
          "two have always read as one object, while under a frame with no edge the picture " +
          "stopped and a bordered bar started. A reader reported that as a rough cut-off. It is " +
          "the chin's own colour and costs the wall no height: an aspect ratio on a `border-box` " +
          "element is a ratio of the *border* box, so the 5:7 outer box is the box it was and " +
          "only the picture inside loses a hairline each side.\n\n" +
          "**Art is synthetic here** unless the Live toolbar switch is on, so a checkout with " +
          "no network renders these exactly as one with it.",
      },
    },
  },
} satisfies Meta<typeof CardArt>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The ordinary case: a printing sold in both finishes carries no mark at all. */
export const Nonfoil: Story = {
  args: { cardId: printing("lea", "161").id, name: "Lightning Bolt" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("img", { name: "Lightning Bolt" })).toBeInTheDocument();
    await expect(canvasElement.querySelector("[data-foil-sheen]")).toBeNull();
  },
};

/**
 * `mp2 8` — Consecrated Sphinx, one of the corpus's two foil-only printings.
 *
 * Both halves are drawn and neither does the other's job: the sheen is what *looks* foil, the
 * chip is what *says* it at a glance. A sheen alone is ambiguous on busy art; a chip alone
 * says nothing about the object being a different physical thing.
 *
 * **Both are `aria-hidden`, and that is deliberate.** This frame usually sits inside a button
 * — a wall tile is one — and a button's accessible name is computed from its contents, so a
 * chip that named itself made a wall of foils into buttons called "Consecrated Sphinx Foil"
 * (measured over CDP in the shipped window). The finish is stated in text on every surface
 * that has room: the wall's caption carries an `sr-only` word, the search table a `FinishMark`
 * in its Name cell, the pane one per finish price.
 */
export const FoilOnly: Story = {
  args: {
    cardId: printing("mp2", "8").id,
    name: "Consecrated Sphinx",
    finish: soleFinish(printing("mp2", "8").finishes),
  },
  play: async ({ canvasElement }) => {
    const sheen = canvasElement.querySelector("[data-foil-sheen]");
    await expect(sheen).not.toBeNull();
    await expect(sheen?.parentElement).toHaveAttribute("aria-hidden", "true");
    // The art itself is still named by the card, which is the whole point of hiding the chip.
    await expect(within(canvasElement).getByRole("img")).toHaveAccessibleName("Consecrated Sphinx");
  },
};

/**
 * `acr 211` — Restart Sequence, the corpus's one etched-only printing.
 *
 * **Etched is a third thing and never a kind of foil.** Flattening it into `foil: true` is the
 * single commonest way an importer loses data, so it gets a glyph of its own rather than the
 * foil glyph with a modifier — an interface that draws them identically teaches exactly that
 * mistake.
 */
export const EtchedOnly: Story = {
  args: {
    cardId: printing("acr", "211").id,
    name: "Restart Sequence",
    finish: soleFinish(printing("acr", "211").finishes),
  },
  play: async ({ canvasElement }) => {
    // The glyph is decoration (see {@link FoilOnly}), so it is found in the markup rather
    // than in the accessibility tree — and what matters is that it is *a different one*.
    await expect(canvasElement.querySelector("[data-foil-sheen]")).not.toBeNull();
    await expect(canvasElement.querySelector("svg")).not.toBeNull();
  },
};

/**
 * `pcy 45` — Rhystic Study, a game changer at rarity **common**: the bracket is a property of
 * the card and never of its rarity or its price.
 *
 * The chip with no sheen, which is the point of the pair. A sheen is a photograph of what the
 * cardboard does to light and this cardboard does nothing special — it is an ordinary common
 * that the Commander bracket counts. Both `gameChanger` and `finish` are read off the fixture
 * rather than written here, so the story is drawing what the corpus says: the printing exists
 * in nonfoil *and* foil, which is exactly why `soleFinish` answers `null` for it.
 *
 * **Hover the crown.** That is the second half of this change: the chip re-enables
 * `pointer-events` against the overlay's `none`, without which `useTooltip()`'s bindings on
 * every glyph here would be unreachable, the same way the `<title>` elements they replaced
 * were for the whole of this component's life before it.
 */
export const GameChanger: Story = {
  args: {
    cardId: printing("pcy", "45").id,
    name: "Rhystic Study",
    finish: soleFinish(printing("pcy", "45").finishes),
    gameChanger: printing("pcy", "45").gameChanger,
  },
  play: async ({ canvasElement }) => {
    const chip = canvasElement.querySelector("[data-card-marks]");
    await expect(chip?.querySelector(".lucide-crown")).not.toBeNull();
    await expect(chip).toHaveClass("pointer-events-auto");
    // `describes: false`, so the panel carries no `role="tooltip"` — find it by its stable id
    // instead. The chip's own `title` prop is gone; the crown's own tooltip (`GameChangerMark`)
    // and the chip's combined one agree on this word when only one fact is on the card.
    await userEvent.hover(chip!);
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_OPEN_MS + 50));
    const panel = canvasElement.ownerDocument.getElementById(TOOLTIP_PANEL_ID);
    await expect(panel).toHaveTextContent("Game changer");
    // No sheen: this printing is sold in both finishes, so there is nothing to photograph.
    await expect(canvasElement.querySelector("[data-foil-sheen]")).toBeNull();
  },
};

/**
 * `mp2 8` again — Consecrated Sphinx is **both**, and the corpus is what says so: the same
 * foil-only printing {@link FoilOnly} draws, now passed the `gameChanger` its row carries.
 * (That story deliberately passes only the finish; it is the one about the sheen.)
 *
 * One chip, two glyphs, crown first. A tile's fourth corner is the only one left — bottom-left
 * is the owned badge, top-left the printing count, and below the frame is the caption — so a
 * second box beside this one would start a row of stickers over the art. The chip's own tooltip
 * joins the two words with the separator the app uses between card facts everywhere else — and
 * is what a hover on the chip's own padding says, since a hover that lands on one glyph gets
 * that glyph's own single-fact tooltip instead (`FinishMark`, `GameChangerMark`).
 */
export const GameChangerFoil: Story = {
  args: {
    cardId: printing("mp2", "8").id,
    name: "Consecrated Sphinx",
    finish: soleFinish(printing("mp2", "8").finishes),
    gameChanger: printing("mp2", "8").gameChanger,
  },
  play: async ({ canvasElement }) => {
    const chips = canvasElement.querySelectorAll("[data-card-marks]");
    await expect(chips).toHaveLength(1);
    await expect(chips[0].querySelectorAll("svg")).toHaveLength(2);
    await userEvent.hover(chips[0]);
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_OPEN_MS + 50));
    const panel = canvasElement.ownerDocument.getElementById(TOOLTIP_PANEL_ID);
    await expect(panel).toHaveTextContent("Game changer · Foil");
    await expect(canvasElement.querySelector("[data-foil-sheen]")).not.toBeNull();
    // Two marks, and the art is still the only thing in the accessibility tree: `getByRole`
    // skips a hidden subtree, so the one `img` it can see is the card.
    await expect(within(canvasElement).getByRole("img")).toHaveAccessibleName("Consecrated Sphinx");
  },
};

/**
 * An orphan: a collection or deck row whose printing has left `cards`.
 *
 * `cardId={null}` fetches nothing — a request could only 404 — and the frame becomes the
 * card's name, which is the one thing still known about it. The same fallback a rate-limited
 * image lands in, so a throttled screen reads as a list of cards rather than a wall of
 * broken-image icons.
 */
export const NoCard: Story = {
  args: { cardId: null, name: "Lightning Bolt" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("img")).toBeNull();
    await expect(canvas.getByText("Lightning Bolt")).toBeInTheDocument();
    await expect(canvas.getByText("No card")).toBeInTheDocument();
  },
};

/**
 * The card an open pane is about, ringed.
 *
 * Gold says "focus" as an outline and "state" as a ring everywhere else in the app, and the
 * ring hugs the art rather than standing off it so a wall keeps its rhythm.
 *
 * It sits **beside** the frame's own edge rather than instead of it: a ring here is a spread-only
 * outset `box-shadow`, which paints outside the border box, so the gold lands against that edge
 * and the frame keeps both marks.
 */
export const Selected: Story = {
  args: { cardId: printing("lea", "161").id, name: "Lightning Bolt", selected: true },
};
