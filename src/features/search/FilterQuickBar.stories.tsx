import { useEffect, useRef, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { FilterQuickBar } from "./FilterQuickBar";
import { useCardSearch, type CardSearch } from "./useCardSearch";

/** What a story switches on before the bar is first drawn — `FilterBar.stories.tsx`'s shape. */
type Preset = (search: CardSearch) => void;

/**
 * The box the bar is docked into: `AppShell`'s `main` in miniature.
 *
 * **1232px wide with 20px of padding**, so the content box — which is the bar's container and
 * therefore what picks its rung — is **1192**, a 1440px window's `main` and the spec's `wide`
 * rung: mana values inline, words gone. The padding is load-bearing rather than decoration:
 * `DockedPanel` reaches back across exactly 20px of the scroller's padding to meet its edges, so
 * a box with none would clip the bar's first and last 20px.
 */
const BOX_WIDTH_PX = 1232;

/**
 * `FilterQuickBar` over the **real `useCardSearch`**, with a story's opening filters pressed
 * through the hook's own setters — `FilterBar.stories.tsx`'s `SearchFilters`, for its
 * reasons: a hand-built `FilterSurface` would be a second copy of the toggle rules and of the
 * count the Filters and Reset all badges print, and the two would drift from the app while every
 * story here stayed green. The preset runs once from an effect, so the docs page shows it too.
 *
 * `shown` is always on: the bar draws nothing at all while the page row is on screen, and there
 * is no story for an empty box. **A story cannot show the pinning** — there is no page scroller
 * for `sticky` to pin against — so the bar sits where it would at the moment it undocks, over a
 * 400px block standing in for the wall, which is also the room its tray hangs into.
 */
function QuickBar({
  preset,
  lead,
  manaValuesFrom,
}: {
  preset?: Preset;
  /** `FilterQuickBar`'s own prop, passed straight through. */
  lead?: ReactNode;
  /** `FilterQuickBar`'s own prop, passed straight through. */
  manaValuesFrom?: "wide" | "widest";
}) {
  const search = useCardSearch();
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !preset) return;
    applied.current = true;
    preset(search);
  });
  return (
    <div className="relative bg-bg" style={{ width: BOX_WIDTH_PX, padding: 20 }}>
      <div className="flex flex-col gap-4">
        <FilterQuickBar
          search={search}
          shown
          lead={lead}
          manaValuesFrom={manaValuesFrom}
          className="-mb-4"
        />
        {/* Stand-in tiles in the app's own tokens, so the bar's shadow has a wall to fall on. */}
        <div aria-hidden="true" className="flex gap-4 pt-16" style={{ height: 400 }}>
          {[0, 1, 2, 3, 4, 5].map((tile) => (
            <div key={tile} className="h-72 w-48 rounded-lg border border-border bg-surface" />
          ))}
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Search/FilterQuickBar",
  // The wrapper, as in `FilterBar.stories.tsx`: typing this file over the component itself would
  // demand a whole `FilterSurface` as a story arg — the one object this file exists not to write.
  component: QuickBar,
  tags: ["autodocs"],
  argTypes: {
    preset: { table: { disable: true }, control: false },
    lead: { control: false },
  },
  parameters: {
    docs: {
      description: {
        component:
          "A card wall's filter row, folded into one line and docked across the top of the " +
          "page while the row itself has scrolled away — card search, the collection, the " +
          "wishlist and Tags, grid view only. It takes the page's own `search`, `labels`, " +
          "`sortRows` and `tray`, so every control is a second entrance to one of the row's: " +
          "Top, the text, the colours, the mana values, Filters (the page's own tray, hung " +
          "under the bar), the sort and Reset all.\n\n" +
          "**Four rungs, from its own container width** (`@container/qb`): words at ≥ 1500, " +
          "icons with names below it, the mana values folded into one press below 1100 (1500 " +
          "for Tags), and the sort gone below 860. Every story here is 1192px of content, the " +
          "`wide` rung.",
      },
    },
  },
} satisfies Meta<typeof QuickBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A filtered search, docked: a word in the field, two colours and a mana value pressed, and the
 * two badges — Filters and Reset all — both reading the search's own count of kinds that are on.
 */
export const Docked: Story = {
  args: {
    preset: (search) => {
      search.setText("bolt");
      search.toggleColor("R");
      search.toggleColor("U");
      search.toggleManaValue(1);
    },
  },
};

/**
 * The bar's own tray, open: the page's `FilterTray` with the same cells, hung 8px under the bar
 * with the bar's shadow. Its open state is the bar's own — the page row's tray is untouched.
 */
export const TrayOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const filters = await canvas.findByRole("button", { name: /^Show filters/ });
    await userEvent.click(filters);
    await expect(filters).toHaveAttribute("aria-expanded", "true");
  },
};

/**
 * Tags' arrangement: a lead after Top, and the mana values folded one rung earlier
 * (`manaValuesFrom="widest"`), so at this width they are the `Mana value` press.
 */
export const TagsLead: Story = {
  args: {
    manaValuesFrom: "widest",
    // A plain stand-in until `TagChips` grows its `singleLine` prop (a later task of this plan),
    // which is what Tags will actually hand the bar.
    lead: <span className="shrink-0 text-xs text-dim">No tags picked</span>,
  },
};
