import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { CHIN_RISE, cardScaleVars, chinHeight, formatZoom } from "@/lib/cardZoom";
import { formatPrice } from "@/lib/prices";
import { finishTreatments } from "@/lib/treatment";
import { cn } from "@/lib/utils";
import { CardChin } from "./CardChin";

/**
 * The chin's own printing line is a direct child of it, so the line the reader can see is also
 * the handle a play function reaches the bar itself by. Every story below draws the chin under
 * something, which is the whole point of `seam` — so `canvasElement.firstElementChild` would be
 * the host rather than the foot.
 */
function chinOf(canvasElement: HTMLElement): HTMLElement {
  return within(canvasElement).getByText("C21 · 179").parentElement as HTMLElement;
}

/**
 * The deck stack's card: a bordered box with its face inset at the face's own corner — the host
 * the `"card"` seam is drawn against, in both the colours the card's own edge is drawn in.
 */
function StackCard({ tone = "default" }: { tone?: "default" | "destructive" }) {
  return (
    <div
      className={cn(
        "rounded-lg border",
        tone === "destructive" ? "border-destructive" : "border-border",
      )}
    >
      <div className="aspect-[488/680] rounded-[7px] bg-bg" />
    </div>
  );
}

const meta = {
  title: "Cards/CardChin",
  component: CardChin,
  tags: ["autodocs"],
  // A card's own width at 100% zoom, which is the box every chin in this app is drawn in.
  decorators: [
    (Story) => (
      <div className="w-[210px]" style={cardScaleVars(1)}>
        <Story />
      </div>
    ),
  ],
  args: {
    rarity: "rare",
    zoom: 1,
    setCode: "c21",
    collectorNumber: "179",
    printingTitle: "Commander 2021 · #179",
    money: "$12.32",
    // The majority answer, so the stories that are not *about* the seam do not have to have an
    // opinion: one of the six surfaces being rewired is a bordered card and five are bare art.
    // The three stories that are about it say so themselves.
    seam: "art",
  },
  parameters: {
    docs: {
      description: {
        component:
          "**The card's foot, and the one definition of it** — rarity, which printing this is, " +
          "its finish, and what one copy costs, in the data face and one step dimmer.\n\n" +
          "Three surfaces drew a foot and each held its own numbers: 28px of 10px type on the " +
          "deck's card stacks, 25px of 12px on the five walls `CardGrid` draws, 20px of 9px on " +
          "the deck's grid view. Only the first had the felt, the edges and the upward rise " +
          "that make a foot read as *part of the card* rather than as a caption under it, and " +
          "three copies is how a shared look stops being shared. This is the stack's, which is " +
          "the one that was right.\n\n" +
          "**It is a sibling of the card's button, never a child of it.** Everything in it is a " +
          "*fact* rather than a mark, so unlike the overlays on the art it is genuinely " +
          "announced instead of being swallowed by the button's accessible name — the price and " +
          "the printing had no reader at all while they were inside it.\n\n" +
          "**`seam` is not decoration.** The chin's edges have to be the *card's* edges, and " +
          "the two hosts own their outline differently: under a bordered card the bar draws the " +
          "two side edges only and rides a pixel outward onto the card's own border, because " +
          "the card's border **is** the bottom edge — a bottom edge here would sit 1px above " +
          "it, giving a red card a 2px foot and a 1px everything-else. Under a bare `CardArt` " +
          "frame, which has no border at all, the chin supplies all three itself.\n\n" +
          "**Nothing in it takes a size.** The height is `chinHeight(zoom)`; the gem, the glyph " +
          "and the type read `--mark-scale`, the card's own inherited factor, so the same " +
          "component is drawn on a card that zooms and (through that variable's fallback) " +
          "wherever one does not.",
      },
    },
  },
} satisfies Meta<typeof CardChin>;

export default meta;
/**
 * `typeof CardChin` and not `typeof meta`, which is this repo's usual spelling.
 *
 * `StoryObj<typeof meta>` subtracts the args the meta already supplies so a story is made to
 * declare the ones still missing — and that set arithmetic collapses to `never` against
 * {@link ChinPrinting}'s union, taking every story in the file with it. Typing the stories off the
 * component keeps each one's args checked against the real props; what is lost is only the
 * "you forgot a required arg" nudge, which the union and a required `seam` now ask for at the
 * component itself, where all six call sites are answerable rather than just these ten.
 */
type Story = StoryObj<typeof CardChin>;

/**
 * The deck stack's foot, whole: the bordered card above it, the shortage after the price.
 *
 * The bar has **no bottom edge** — the card's own border is the bottom edge, and the `-mx-px`
 * puts the chin's two side edges exactly on top of the card's, so the two are one line rather
 * than two.
 */
export const DeckStack: Story = {
  args: {
    seam: "card",
    extra: (
      <span aria-hidden="true" className="shrink-0 tabular-nums text-destructive">
        1/2
      </span>
    ),
  },
  render: (args) => (
    <>
      <StackCard />
      <CardChin {...args} />
    </>
  ),
  play: async ({ canvasElement }) => {
    // `classList.contains`, never a substring of `className`: `border-x` is a substring of
    // `border-x-2`, and this one class is the whole difference between the two seams.
    await expect(chinOf(canvasElement).classList.contains("border-b")).toBe(false);
  },
};

/**
 * The five walls `CardGrid` draws, and the deck's grid view: `CardArt` has no border at all, so
 * the chin supplies all three edges itself and rounds to the art's own corner.
 */
export const WallTile: Story = {
  args: { seam: "art" },
  render: (args) => (
    <>
      <div className="aspect-[5/7] rounded-lg bg-surface" />
      <CardChin {...args} />
    </>
  ),
  play: async ({ canvasElement }) => {
    await expect(chinOf(canvasElement).classList.contains("border-b")).toBe(true);
  },
};

/**
 * A card that breaks a rule is outlined in destructive, and **the chin has to agree**.
 *
 * This bar is `relative` and later in the document than the face, so its border paints *over*
 * the card's along every pixel of its height: a `border-border` chin under a red card puts 28px
 * of the wrong colour back through the left and right edges of it, which is the one thing the
 * outline exists to prevent.
 */
export const RuleBreak: Story = {
  args: { seam: "card", tone: "destructive" },
  render: (args) => (
    <>
      <StackCard tone="destructive" />
      <CardChin {...args} />
    </>
  ),
  play: async ({ canvasElement }) => {
    const chin = chinOf(canvasElement);
    await expect(chin.classList.contains("border-destructive")).toBe(true);
    await expect(chin.classList.contains("border-border")).toBe(false);
  },
};

/** A copy the reader holds in foil says so, in the one place on a card face with room for it. */
export const Foil: Story = {
  args: { finish: "foil" },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("Foil")).toBeInTheDocument();
  },
};

/**
 * Nonfoil draws **no glyph at all**, and the chin does not force one: the mark is
 * `FinishMark`'s own rule, and it is right — nonfoil is the finish a price is assumed to be, and
 * 61 % of the corpus has a foil version, so a mark on every plain card would be chrome.
 */
export const Nonfoil: Story = {
  args: { finish: "nonfoil" },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("img")).toBeNull();
  },
};

/**
 * A named treatment replaces the finish's glyph **and** its word — a Surge Foil is not "a foil",
 * which is issue #160 read off a wall where three such rows sit side by side.
 */
export const SurgeFoil: Story = {
  args: { finish: "foil", treatments: finishTreatments('["surgefoil"]', "foil") },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("Surge Foil")).toBeInTheDocument();
    await expect(canvas.queryByLabelText("Foil")).toBeNull();
  },
};

/**
 * A printing this marketplace does not quote draws an em dash rather than a `$0.00` nobody said.
 * The slot takes a node so `formatPrice` fills it and the chin never formats money itself.
 */
export const Unpriced: Story = {
  args: { money: formatPrice(null, "usd") },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("—")).toBeInTheDocument();
  },
};

/**
 * The caller's words win over `SET · number`.
 *
 * The wishlist's "Any printing" is the live case: a wish for *any* printing is drawn as one
 * particular one, and a caption naming that cardboard would say the reader had asked for it.
 *
 * **The title is `null` and that is a required answer rather than a re-null.** `ChinPrinting`'s
 * two arms make this the one story that cannot spread the meta's args: Storybook merges
 * `meta.args` into every story at *runtime*, so a `setCode` and a `collectorNumber` would ride in
 * underneath a `printing` the union exists to keep them away from. It builds its own props
 * instead — which is also the clearest statement of what a caller on this arm actually passes.
 */
export const CallerPrinting: Story = {
  render: ({ rarity, zoom, seam, money }) => (
    <CardChin
      rarity={rarity}
      zoom={zoom}
      seam={seam}
      money={money}
      printing="Any printing"
      printingTitle={null}
    />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Any printing")).toBeInTheDocument();
    // No `SET · number` built beside it — the separator appears nowhere else in a chin.
    await expect(canvas.queryByText(/·/)).toBeNull();
  },
};

/**
 * The same chin at three stops of the ladder, so the bar and what is in it can be seen moving
 * together.
 *
 * The height is the only thing this component is told: `chinHeight(zoom)`. The gem, the gutters
 * and the type size themselves off `--mark-scale`, published by `cardScaleVars` on the card's own
 * root — which is why each stop below is a wrapper rather than a prop, and why the same
 * component sits unscaled in three tables and the card pane. The rise does **not** scale: it is
 * derived from a corner radius that is 7px at every stop.
 */
export const Zoom: Story = {
  render: (args) => (
    <div className="flex flex-col gap-4">
      {[0.5, 1, 2].map((zoom) => (
        <div key={zoom} style={cardScaleVars(zoom)}>
          <div className="mb-1 text-xs text-dim">{formatZoom(zoom)}</div>
          <CardChin {...args} zoom={zoom} />
        </div>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const chins = within(canvasElement)
      .getAllByText("C21 · 179")
      .map((line) => line.parentElement as HTMLElement);
    await expect(chins).toHaveLength(3);
    await expect(chins[0].style.height).toBe(`${chinHeight(0.5)}px`);
    await expect(chins[2].style.height).toBe(`${chinHeight(2)}px`);
    // Four pixels at every stop, because the corner it hides the seam of is 7px at every stop.
    await expect(chins[2].style.marginTop).toBe(`-${CHIN_RISE}px`);
  },
};
