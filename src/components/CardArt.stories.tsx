import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { printing } from "../../.storybook/fake/fixtures";
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
          "**Extracted because five surfaces draw a card** and each had rebuilt part of this: " +
          "the search wall's tiles, the pane's main art, the pane's printings rows, the deck " +
          "editor's zone rows and `PrintingPreview`. They agreed on the aspect ratio and " +
          "disagreed about everything else, which is how a foil marking would otherwise have " +
          "come to exist in five slightly different versions.\n\n" +
          "**The foil treatment says what the object *is*, never what it could have been.** " +
          "`soleFinish` (`src/lib/finish.ts`) marks only a printing that leaves no choice — " +
          "12,366 foil-only and 892 etched-only paper printings, measured 2026-08-11 over the " +
          "live corpus. The 53,224 printings that merely *have* a foil version are unmarked: a " +
          "sheen on 61% of every wall would be decoration rather than information.\n\n" +
          "**The sheen tints and never covers.** A `linear-gradient` at 12% opacity in " +
          "`mix-blend-mode: overlay`, because a real foil is a diffraction grating throwing a " +
          "different hue at every angle and Scryfall's photography has none of it — the art of " +
          "a foil-only printing is byte-identical to a nonfoil one. Legibility is a screenshot " +
          "question rather than an assertion, so the live CDP pass is what proves it; what a " +
          "story can prove is that the sheen is `aria-hidden` and the chip is not.\n\n" +
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
    await expect(within(canvasElement).getByRole("img")).toHaveAccessibleName(
      "Consecrated Sphinx",
    );
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
 */
export const Selected: Story = {
  args: { cardId: printing("lea", "161").id, name: "Lightning Bolt", selected: true },
};
