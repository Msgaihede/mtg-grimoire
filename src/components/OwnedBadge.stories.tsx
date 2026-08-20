import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID } from "@/components/tooltip/TooltipProvider";
import { OwnedBadge } from "./OwnedBadge";

const meta = {
  title: "Primitives/OwnedBadge",
  component: OwnedBadge,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "What the reader already has, and what they said they wanted — said on the card " +
          "itself. A quantity is data, so it is the mono face on a plain surface: no green, " +
          "no “owned” pill. The heart is the sidebar's own wishlist icon, filled, so the " +
          "mark on a search result and the entry in the nav are visibly the same thing.\n\n" +
          "**Hover it and it says in words what it says in glyphs** — the same two sentences " +
          "its `sr-only` spans carry, joined into one tooltip. `×3` beside a filled heart is " +
          "shorthand a sighted reader has to be told once, and two tooltips 4px apart over " +
          "one badge would flicker between them.",
      },
    },
  },
} satisfies Meta<typeof OwnedBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Nothing at all when there is nothing to say.
 *
 * "You own none of these and have not wished for them" is true of almost every one of the
 * 116,694 rows in the card database, and a wall of `×0` would be forty stickers saying
 * nothing. The component is its own guard, which is what lets `CardGrid` place it
 * unconditionally and draw no corner when it comes back null — so this story rendering
 * *empty* is the contract, not a broken story.
 */
export const Nothing: Story = {
  args: { owned: 0, wishlisted: false },
  play: async ({ canvasElement }) => {
    await expect(canvasElement).toBeEmptyDOMElement();
  },
};

export const Owned: Story = { args: { owned: 3 } };

/** The collection wall passes no `wishlisted` at all — it shows what is owned and has no
 *  opinion about what is wanted — so a wish-only badge is the search wall's shape. */
export const Wishlisted: Story = { args: { owned: 0, wishlisted: true } };

/** Owning some and still wanting more is an ordinary state, not a contradiction: a wish is
 *  finish-aware and a count is not — and it is the case that proves the badge says both facts
 *  on hover rather than only the one the pointer happens to be over. */
export const Both: Story = {
  args: { owned: 2, wishlisted: true },
  play: async ({ canvasElement }) => {
    // `describes: false`: the same two sentences are already `sr-only` text inside the badge,
    // so the panel carries no `role="tooltip"` — found by its stable id instead.
    const badge = canvasElement.firstElementChild as HTMLElement;
    await userEvent.hover(badge);
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_OPEN_MS + 50));
    const panel = canvasElement.ownerDocument.getElementById(TOOLTIP_PANEL_ID);
    await expect(panel).toHaveTextContent("2 in your collection · On your wishlist");
  },
};

/** `tabular-nums` is why this is worth a story — four figures must not shove the card frame
 *  around as the count climbs. */
export const LargeCount: Story = { args: { owned: 1284 } };
