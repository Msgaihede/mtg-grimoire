import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { TOOLTIP_OPEN_MS } from "@/components/tooltip/TooltipProvider";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";

/** The default marketplace’s as-of sentence — this file is about the component, not about
 *  which shop the number came from, so it names one and holds it still. */
const PRICES_AS_OF = pricesAsOf(MARKETPLACES.tcgplayer);
import { Figure, FigureRow } from "./Figure";

const meta = {
  title: "Primitives/Figure",
  component: Figure,
  // The row is the other half of the pair and has no props of its own worth a story, so it
  // rides here as a subcomponent: autodocs gives it a table of its own on this page rather
  // than leaving `FigureRow` documented nowhere.
  subcomponents: { FigureRow },
  tags: ["autodocs"],
  // **Every story is wrapped, because a bare `Figure` is markup the app never emits.** It
  // renders a `<dt>`/`<dd>` pair, and those are only a definition list inside a `<dl>` —
  // outside one they are two elements with no relationship at all. All three call sites
  // (`CollectionSummary`, `DeckStats`, `WishlistPage`) put their figures inside a `FigureRow`
  // and nothing else ever renders one, so a story that drew it loose would document a shape
  // that does not exist.
  decorators: [
    (Story) => (
      <FigureRow>
        <Story />
      </FigureRow>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "One figure and what it counts — the grammar every list of cards is captioned " +
          "with. No colour and no chrome: the direction spends its boldness on card art, so " +
          "a row of tinted stat cards above a wall of Magic art would be two things " +
          "shouting. `note` is the qualification a number needs to stay honest and `title` " +
          "is where the as-of sentence rides, because the row has no space to write it out.",
      },
    },
  },
} satisfies Meta<typeof Figure>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The plain case: a count, and the word for what is being counted. */
export const ValueOnly: Story = { args: { label: "Cards", value: "1,284" } };

/**
 * A total, and how much of the list it could not price.
 *
 * A sum that silently omits the cards it had no price for is a number that lies by rounding
 * down, so the count travels with it — smaller, dimmer, and inside the same `<dd>`.
 *
 * **Inside the same `<dd>` is a real consequence and the `play` measures it**: the element's
 * text content is the value and the note run together with no separator, because the 8px gap
 * between them is a `margin` and a margin is not a word. Whether a given screen reader inserts
 * a pause at the inner `<span>`'s boundary is not something jsdom can answer — it is flagged
 * here for **Task 17's accessibility pass** rather than fixed, because fixing it means editing
 * a component, which this task may not do.
 */
export const WithNote: Story = {
  args: { label: "Value (USD)", value: "$4,182.55", note: "412 unpriced" },
  play: async ({ canvasElement }) => {
    const value = within(canvasElement).getByText("$4,182.55");
    await expect(value.tagName).toBe("DD");
    await expect(value).toHaveTextContent("$4,182.55412 unpriced");
  },
};

/**
 * Spec §5 requires every price on screen to say how old it is, and there is no room on the
 * row to write it — so it is a tooltip, bound on the figure's own wrapper through
 * `useTooltip()`.
 *
 * A tooltip is invisible until the pointer rests on it and invisible in a screenshot forever,
 * which is what the `play` is for. Note where it lands: on the `<div>` that holds the pair, not
 * on the `<dd>`, so the hover target is the label as well as the number. It describes the pair
 * (the default `describes: true`) rather than repeating it, so the panel carries
 * `role="tooltip"` and `aria-describedby` points at it while open.
 */
export const WithAsOfTitle: Story = {
  args: { label: "Value (EUR)", value: "€3,640.18", title: PRICES_AS_OF },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = canvas.getByText("Value (EUR)");
    await userEvent.hover(label.parentElement!);
    const panel = await canvas.findByRole("tooltip", undefined, { timeout: TOOLTIP_OPEN_MS + 1000 });
    await expect(panel).toHaveTextContent(PRICES_AS_OF);
    await expect(label.parentElement).toHaveAttribute("aria-describedby", panel.id);
  },
};

/**
 * An em dash while the first answer is in flight, and never a zero.
 *
 * A list that briefly claims to be worth nothing is a worse sentence than one that has not
 * said yet — and the two are indistinguishable to a reader who glances once. The callers pass
 * the dash themselves (`summary ? … : "—"` in the collection, `query.isPending ? "—" : …` on
 * the wishlist), which is most of the reason the component takes an already-formatted string
 * rather than a number.
 */
export const InFlight: Story = {
  args: { label: "Value (USD)", value: "—", title: PRICES_AS_OF },
};

/**
 * Four figures in one row — `DeckStats`' shape, the call site no story file in this task
 * covers (it is Task 11's), and the one that puts a note on three of its four figures and a
 * title on two.
 *
 * The values are illustrative rather than measured; what the story is about is the row. The
 * `play` pins the part a screenshot cannot show: this is a `<dl>`, so each number is bound to
 * its label as a definition rather than being one of eight loose strings on a line.
 */
export const FullRow: Story = {
  // Inert, and required: `StoryObj<typeof meta>` demands the component's own required props
  // even from a story whose `render` names its own children. Controls are switched off rather
  // than left offering knobs that move nothing.
  args: { label: "Cards", value: "100" },
  parameters: { controls: { disable: true } },
  render: () => (
    <>
      <Figure
        label="Cards"
        value="100"
        note="+ 15"
        title="The cards a format's size rule counts — every switched-on pile except the sideboard."
      />
      <Figure label="Lands" value="37" />
      <Figure label="Avg. mana value" value="3.14" note="nonlands" />
      <Figure label="Price (USD)" value="$1,204.60" note="3 unpriced" title={PRICES_AS_OF} />
    </>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("dl")).toHaveLength(1);
    await expect(canvasElement.querySelectorAll("dt")).toHaveLength(4);
    await expect(canvasElement.querySelectorAll("dd")).toHaveLength(4);
  },
};
