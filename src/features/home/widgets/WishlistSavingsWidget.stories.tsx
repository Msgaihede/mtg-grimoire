import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, fn, within } from "storybook/test";
import { ipc, type HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { ALL_CHEAPEST, NO_WISHES, WishlistSavingsWidget } from "./WishlistSavingsWidget";

/** The grid's target cell. Not exported, for CSF. */
const CELL = 104;

/** How long a play waits for the staged wishes and the plan to land. Not exported, for CSF. */
const LANDED = { timeout: 5_000 };

/**
 * Three printings of the generated corpus (`.storybook/fake/cards.ts`), named by id because that is
 * what a pinned wish stores: Alpha's Lightning Bolt at $620.00, Secret Lair's at $3.03 — both with a
 * cheaper printing, Double Masters 2022's at $2.50 — and Secret Lair's Sol Ring, which carries no
 * price at any marketplace, so its move has no saving to count. Not exported, for CSF.
 */
const LEA_BOLT = "d573ef03-4730-45aa-93dd-e45ac1dbaf4a";
const SLD_BOLT = "4f43c378-9e6a-4ece-9c24-5dc08c977746";
const SLD_SOL_RING = "16a2c470-b2b8-4633-89b1-7b936bcaff8d";

function savings(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "wishlistSavings", kind: "wishlistSavings", x: 0, y: 0, w, h, config };
}

function Framed({ widget, still = false }: { widget: HomeWidget; still?: boolean }) {
  const widthPx = spanPx(widget.w, CELL);
  const heightPx = spanPx(widget.h, CELL);
  const fit = makeFit({ w: widget.w, h: widget.h, widthPx, heightPx, density: widgetDensity(widget) });
  const onConfig = fn();
  return (
    <div className="p-2">
      <div style={{ width: widthPx, height: heightPx }}>
        <WidgetCard
          widget={widget}
          fit={fit}
          editing={false}
          still={still}
          onConfig={onConfig}
          onRemove={fn()}
        >
          <WishlistSavingsWidget
            widget={widget}
            fit={fit}
            editing={false}
            still={still}
            onConfig={onConfig}
          />
        </WidgetCard>
      </div>
    </div>
  );
}

/**
 * `starter`'s pinned wishes are each already on their cheapest printing — every one has a single
 * printing in the corpus, or none cheaper — so the savings are **written through the command** a
 * reader's `+` makes: three pinned wishes at the root, `DecksPage.stories.tsx`'s `OrphanedCover`
 * idiom. `useQuery` so it runs once per story client, and the card is held back until they land.
 */
function WithSavings({ children }: { children: ReactNode }) {
  const staged = useQuery({
    queryKey: ["story", "wishlist-savings"],
    queryFn: async () => {
      await ipc.wishlistAdd({ cardId: LEA_BOLT, quantity: 1 });
      await ipc.wishlistAdd({ cardId: SLD_BOLT, quantity: 2 });
      await ipc.wishlistAdd({ cardId: SLD_SOL_RING, quantity: 1 });
      return true;
    },
    staleTime: Infinity,
  });
  return staged.isSuccess ? <>{children}</> : null;
}

const meta = {
  title: "Home/WishlistSavingsWidget",
  component: Framed,
  tags: ["autodocs"],
  args: { widget: savings(3, 3) },
  render: (args) => (
    <WithSavings>
      <Framed {...args} />
    </WithSavings>
  ),
  parameters: {
    docs: {
      description: {
        component:
          "What moving the pinned wishes to their cheapest printings would save — the optimise " +
          "dialog's own plan, asked about the **whole** wishlist at the reader's marketplace. The " +
          "figure is gold; the rows are the biggest savings first, each captioned with both " +
          "prices per copy.\n\n" +
          "**A move with no current price is never summed as zero**: it is counted on its own " +
          "line, and a card whose moves are all like that says so in a sentence. A press — a row " +
          "or the figure — opens the dialog on the wishlist, over the whole list.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two priced moves and one the marketplace cannot price. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Wishlist savings" }, LANDED));
    await expect(
      await card.findByRole(
        "button",
        { name: /^Could save \$[\d,.]+ on 2 wishes · Optimise prices$/ },
        LANDED,
      ),
    ).toBeInTheDocument();
    await expect(
      card.getByRole("button", {
        name: /^Lightning Bolt · Pinned \$620\.00 · cheapest \$2\.50 · saves /,
      }),
    ).toBeInTheDocument();
    await expect(card.getByText("1 more has no current price")).toBeInTheDocument();
  },
};

/**
 * A two-cell tile: each saving moved under its wish's name. Both staged Bolts are rows here, so
 * the play names the Alpha one by its price rather than by the card name the two share.
 */
export const Tile: Story = {
  args: { widget: savings(2, 3) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Wishlist savings" }, LANDED));
    await expect(
      await card.findByRole("button", { name: /^Lightning Bolt · Pinned \$620\.00 · / }, LANDED),
    ).toBeInTheDocument();
    await expect(card.queryByText(/^Pinned /)).not.toBeInTheDocument();
  },
};

/** `starter` as it is: every pinned wish is already on its cheapest printing. */
export const EveryWishCheapest: Story = {
  render: (args) => <Framed {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(ALL_CHEAPEST, {}, LANDED)).toBeInTheDocument();
  },
};

/** An empty wishlist. */
export const NoWishes: Story = {
  parameters: { fake: { seed: "empty" } },
  render: (args) => <Framed {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(NO_WISHES, {}, LANDED)).toBeInTheDocument();
  },
};

/** A catalogue preview: the figure and the rows as pictures, nothing to press. */
export const Still: Story = {
  args: { still: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Wishlist savings" }, LANDED));
    await expect(await card.findByText("Could save", {}, LANDED)).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Could save / })).toBeNull();
  },
};
