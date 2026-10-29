import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { Spec } from "@json-render/core";
import { CARDS } from "@grimoire/fake/cards";
import { makeFit, spanPx } from "../fit";
import { SpecView } from "./SpecView";
import { CARDS_EXAMPLE, DECKS_EXAMPLE, GALLERY_EXAMPLE, RARITY_EXAMPLE } from "./examples";
import { CatalogFitContext } from "./registry";

/** The grid's target cell — the size the page aims its columns at. Not exported, for CSF. */
const CELL = 104;

/** A printing of the fake's, by name — so a tile's picture is one the fake has. */
function printing(name: string, price: number | null) {
  const card = CARDS.find((c) => c.name === name);
  if (!card) throw new Error(`the fake has no ${name}`);
  return {
    id: card.id,
    name: card.name,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    rarity: card.rarity,
    price,
  };
}

/**
 * A spec in a box a widget of `w` by `h` cells covers, with that box's fit — what a custom
 * widget's body will hand the catalogue's measured parts.
 */
function Framed({ spec, w, h }: { spec: Spec; w: number; h: number }) {
  const widthPx = spanPx(w, CELL);
  const heightPx = spanPx(h, CELL);
  const fit = makeFit({ w, h, widthPx, heightPx, density: "comfortable" });
  return (
    <div className="p-2">
      <div
        className="overflow-auto rounded-lg border border-border bg-surface p-3"
        style={{ width: widthPx, height: heightPx }}
      >
        <CatalogFitContext.Provider value={fit}>
          <SpecView spec={spec} />
        </CatalogFitContext.Provider>
      </div>
    </div>
  );
}

const meta = {
  title: "Home/Generated/SpecView",
  component: Framed,
  tags: ["autodocs"],
  args: { spec: DECKS_EXAMPLE, w: 4, h: 3 },
  parameters: {
    docs: {
      description: {
        component:
          "**The component catalogue a generated widget is drawn from** (json-render). A spec " +
          "names components from `catalog.ts`; `registry.tsx` draws each with the app's own " +
          "part — `Figures` is `WidgetFigures`, `Row` is `WidgetRow`, `CardTile` is `CardTile` — " +
          "so a generated widget looks exactly like a hand-written one. The data is the spec's " +
          "state (a GraphQL answer, later); inputs write only that state, and actions only " +
          "navigate.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Figures over a `repeat` of rows, each opening its deck, and a templated footer. */
export const Decks: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /Mono-Red Burn/ })).toBeInTheDocument();
  },
};

/** Bars at the reader's currency, hidden by a switch that writes the widget's own state. */
export const Rarity: Story = {
  args: { spec: RARITY_EXAMPLE, w: 3, h: 3 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Mythic")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("switch", { name: "Show breakdown" }));
    await waitFor(() => expect(canvas.queryByText("Mythic")).toBeNull());
  },
};

/** A wall of card tiles over the fake's printings, each opening its card. */
export const Cards: Story = {
  args: {
    spec: {
      ...CARDS_EXAMPLE,
      state: {
        cards: [
          printing("Lightning Bolt", 412.5),
          printing("Black Lotus", 32_000),
          printing("Tarmogoyf", null),
        ],
      },
    },
    w: 6,
    h: 4,
  },
};

/** One of every component the catalogue has. */
export const Gallery: Story = {
  args: {
    spec: {
      ...GALLERY_EXAMPLE,
      state: { ...GALLERY_EXAMPLE.state, cardId: printing("Rhystic Study", null).id },
    },
    w: 6,
    h: 8,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Everything" })).toBeInTheDocument();
    await expect(canvas.getByText("No decks yet.")).toBeInTheDocument();
    const filter = canvas.getByRole("textbox", { name: "Filter" });
    await userEvent.type(filter, "bolt");
    await expect(filter).toHaveValue("bolt");
  },
};
