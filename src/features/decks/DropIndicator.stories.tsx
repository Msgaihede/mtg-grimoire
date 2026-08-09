import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { DROP_LINE_ATTR, DropIndicator } from "./DropIndicator";

/**
 * A zone column, reduced to the two things this line needs from one: a `relative` box with a
 * border, and something inside it to have an edge above.
 *
 * A **stand-in**, not `ZoneColumn` — that component takes a deck, a zone and the whole
 * pragmatic-drag-and-drop wiring, and it is Task 10's to story. The one class copied verbatim
 * is `relative`, and it is copied because it is load-bearing: `ZoneColumn` puts it on the
 * column and says so in its own comment ("`relative` is what the drop line hangs from"), and
 * `absolute inset-x-0 top-0` with no positioned ancestor escapes to the page.
 */
function ZoneStandIn({ children, name }: { children?: ReactNode; name: string }) {
  return (
    <div className="relative flex h-48 w-56 flex-col overflow-hidden rounded-lg border border-border bg-surface">
      {children}
      <p className="border-b border-border px-3 py-2 font-mono text-xs text-dim">{name}</p>
      <div className="flex flex-col gap-1 px-3 py-2 text-sm text-dim">
        <span>Lightning Bolt</span>
        <span>Counterspell</span>
        <span>Swords to Plowshares</span>
      </div>
    </div>
  );
}

const meta = {
  title: "Decks/DropIndicator",
  component: DropIndicator,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "The line that says where a dragged card is about to land: 2px of the app's gold " +
          "across the top edge of the zone that will take it. **An edge of the column, not a " +
          "gap between two rows** — `deck_cards` has no order column, the backend answers a " +
          "deck in zone priority then by name, and `deck_add_card` folds a repeat into the " +
          "row already there, so a line drawn between two rows would promise a position the " +
          "data model cannot keep. Hand-rolled rather than Atlaskit's drop indicator, which " +
          "wants a portal and a runtime `<style>` the shipped CSP (`style-src 'self'`) would " +
          "refuse. Nothing here animates, so there is nothing for `prefers-reduced-motion` " +
          "to switch off.",
      },
    },
  },
} satisfies Meta<typeof DropIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The component with nothing around it — which is mostly a story about how little there is.
 *
 * With no positioned ancestor an `absolute` element hangs off the page's own containing block,
 * so what this draws is a gold hairline across the top of the canvas rather than the top of
 * anything. That is why every other story here gives it a box, and it is worth seeing once:
 * the line has no size, no colour and no position of its own that survives being taken out of
 * a column.
 *
 * Everything else about it is invisible by design and is asserted instead. It has no role, no
 * accessible name and no text — narrating it would announce a line to a reader who cannot be
 * dragging anything — so `data-drop-line` is the only handle a test has, and
 * `pointer-events-none` is what stops it from becoming the thing under the pointer: a native
 * drag hit-tests with `elementFromPoint`, and a decoration that answers that is a decoration
 * that decides where the card goes.
 */
export const Alone: Story = {
  play: async ({ canvasElement }) => {
    const line = canvasElement.querySelector(`[${DROP_LINE_ATTR}]`);
    await expect(line).toBeInTheDocument();
    await expect(line).toHaveAttribute("aria-hidden", "true");
    await expect(line).not.toHaveAttribute("role");
    await expect(line).toBeEmptyDOMElement();
    await expect(line).toHaveClass("pointer-events-none");
  },
};

/** The real shape: the line on the top edge of the column that would take the card. The
 *  column is a stand-in, but the `relative` it hangs from is `ZoneColumn`'s own. */
export const OnAZoneEdge: Story = {
  render: () => (
    <ZoneStandIn name="Main deck">
      <DropIndicator />
    </ZoneStandIn>
  ),
};

/**
 * Two columns, one lit — which is the whole of what a drop here decides.
 *
 * The indicator marks the **target**, so the question it answers is "which zone", never "where
 * in the list". Side by side is the only arrangement that shows that, because a single lit
 * column looks equally like an insertion point at the top of it.
 */
export const AcrossTwoZones: Story = {
  render: () => (
    <div className="flex gap-4">
      <ZoneStandIn name="Main deck">
        <DropIndicator />
      </ZoneStandIn>
      <ZoneStandIn name="Sideboard" />
    </div>
  ),
};
