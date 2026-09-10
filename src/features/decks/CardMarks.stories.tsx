import type { Meta, StoryObj } from "@storybook/react-vite";
import { LabelDot, NoteMark, QuantityTag } from "./CardMarks";

/**
 * The quantity tag as the deck's two card-face views draw it — and, beside it, the note mark the
 * two row views draw instead.
 *
 * The workbench is where the *fold* is worth looking at: every one of these marks is 22px of a
 * 27px strip on a card whose whole reveal is 34px, and the argument for folding a fifth fact into
 * an existing mark rather than drawing a new one is an argument about what those pixels look like
 * side by side.
 */
const meta = {
  title: "Decks/CardMarks",
  component: QuantityTag,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "The copy count as a **filled tag in the card's own label colour**, carrying every " +
          "other fact a deck card's face has to say about itself — because there is nowhere " +
          "else on the card to say them.\n\n" +
          "**Every corner is claimed**: the quantity tag top-left, the theory mark top-right, " +
          "the rule break bottom-left. The marks strip is `overflow-hidden` and was measured " +
          "overflowing a 165px tile by 11px with only the marks it already draws, so a new " +
          "per-card fact cannot be a new corner. It is folded into this tag instead — the game " +
          "changer's crown on 2026-09-08, the deck note's glyph on 2026-09-10 — at 14px each " +
          "(an 11px glyph and a 3px gap, both scaled by the card's own `--mark-scale`).\n\n" +
          "**A card that is several things is all of them.** Neither glyph stands for the " +
          "other and neither suppresses it: a reader cannot learn a mark whose absence is " +
          "ambiguous.\n\n" +
          "**Neither glyph has a colour of its own.** Both are `currentColor`, so both take " +
          "whatever is legible printed on the label the reader chose — gold belongs to the " +
          "crown drawn *unfilled* on somebody else's artwork (`components/GameChangerMark`), " +
          "where colour is the only thing saying which fact it is.\n\n" +
          "The whole tag is `aria-hidden`, so the tooltip is what a pointer gets and " +
          "`deckCardName` is what a keyboard reader gets. Hover any of these to read the one " +
          "sentence that names every fact the mark draws, in the order it draws them.",
      },
    },
  },
} satisfies Meta<typeof QuantityTag>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An unlabelled card, which is the colourless deep: a filled mark has to be *some* colour, and
 *  if the neutral one were gold then gold would stop meaning "there is a label here". */
export const Plain: Story = {
  args: { quantity: 3, name: null, color: null, gameChanger: false },
};

/** The label the reader put on the card, printed as the fill with the count on it — one object
 *  saying "three of these, and they are my ramp" in the 34px strip a collapsed card reveals. */
export const Labelled: Story = {
  args: { quantity: 3, name: "Ramp", color: "#00733e", gameChanger: false },
};

/**
 * A game changer (2026-09-08). The crown is drawn **before** the number and in the tag's own
 * foreground — never gold, which on a Gold-labelled tag would be a glyph nobody can see.
 */
export const Crowned: Story = {
  args: { quantity: 1, name: "Fast mana", color: "#d9b95c", gameChanger: true },
};

/**
 * A card a deck note names (2026-09-10, issue #447) — the fifth fact, and the first that never
 * had a drawing of its own to lose. There was no corner left to give it one.
 */
export const Noted: Story = {
  args: { quantity: 2, name: "Ramp", color: "#00733e", gameChanger: false, noted: true },
};

/**
 * **Both, which is the story worth looking at.** Two glyphs and the number, in one 22px box, on
 * the fill the reader chose — and one sentence naming all four facts in the order they are drawn.
 * If this reads as a row of stickers rather than as one object, that is the finding the fold was
 * betting against.
 */
export const CrownedAndNoted: Story = {
  args: { quantity: 4, name: "Ramp", color: "#00733e", gameChanger: true, noted: true },
};

/** An unlabelled card wearing both, which is where the neutral grey has to carry two glyphs and a
 *  number without any of them disappearing into it. */
export const CrownedAndNotedUnlabelled: Story = {
  args: { quantity: 12, name: null, color: null, gameChanger: true, noted: true },
};

/**
 * **The two row views, where the separation is _shape_ rather than place.**
 *
 * `TableView` and `TextView` have no corners, so the note mark stands inline beside the card's
 * label dot: a stroked outline against an 8px filled square. That difference is what a reader
 * takes in before they read either mark, and it is the whole of what keeps the two apart — the
 * glyph takes no colour of its own, because the `--color-pie-*` deeps are what the dot beside it
 * means.
 *
 * Unlike every mark on a card face, this one **names itself** — a `role="img"` whose accessible
 * name is one text node — because a name inside a table cell is really read.
 */
export const RowMarks: StoryObj = {
  render: () => (
    <div className="flex items-center gap-1.5 text-text">
      <LabelDot name="Ramp" color="#00733e" />
      <NoteMark />
      <span className="text-sm">Lightning Bolt</span>
    </div>
  ),
};
