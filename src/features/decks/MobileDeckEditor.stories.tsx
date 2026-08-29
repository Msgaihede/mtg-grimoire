import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToggleChip } from "@/components/FilterChips";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { PHONE_HEIGHT_PX, PHONE_PX } from "@/lib/viewports";
import { AUTO_CATEGORY } from "./autoCategory";
import { DeckEditor } from "./DeckEditor";
import { DeckSearchPanel } from "./DeckSearchPanel";
import { useDeck } from "./useDeck";

/**
 * Three ways the deck editor could work on a phone, drawn on the real components at 390×844.
 *
 * **These are mock-ups for one decision and they are deleted once it is taken** (Task 9 of
 * `docs/superpowers/plans/2026-08-28-mobile-layout-9a-foundation-and-options.md`). Nothing here
 * is a component anybody may import, and the argument each option makes lives in the write-up
 * rather than in this file — the wireframes are what survives.
 *
 * **What the shipped code already does at this width, which is what the round is about.**
 * `DeckEditor`'s desk row is 350px inside the box below, and `roomForPanel` is
 * `DECK_FLOOR` (192) + `DESK_GAP` (16) + `MIN_PANEL_WIDTH_PX` (206) = **414**. So the docked
 * search column is *already* railed to its 36px chevron, and it *already* says why in words —
 * "Not enough room — close the card details or widen the window". Nothing is broken. The
 * question these three answer is what that rail opens into.
 */

/** The one number the sheet is drawn from — 40 % of the frame, which is 338px at 844. */
const SHEET_PX = Math.round(PHONE_HEIGHT_PX * 0.4);

/**
 * `AppShell`'s `<main>`, reproduced — `relative min-h-0 flex-1 overflow-auto p-5`, character for
 * character, and it is the whole of the chrome these frames carry.
 *
 * **A `div` rather than a `<main>`**: what is being reproduced is the *box*, and three landmarks
 * with one name on one docs page is a fact about this file rather than about the app.
 *
 * **It is what makes the desk 350 rather than 390.** `p-5` is 20px a side, and the deck editor
 * reasons about the width it is actually given rather than about the window — so a frame without
 * it would put every measurement in the write-up 40px out.
 *
 * **The ribbon and the nav rail are deliberately absent, and 350 is therefore the *best* case.**
 * Driven at 390×844 in the shipped window on 2026-08-29, `main`'s content is **142px** with
 * today's expanded 208px rail, **282px** with the collapsed 68px one, and 350 only with no rail
 * at all. 142 is below `DECK_FLOOR` (192) outright. So every number these three frames are drawn
 * against assumes Task 5's round takes the rail off a phone; if it keeps the collapsed rail, the
 * desk is 282 and each option's arithmetic moves with it.
 */
function Main({ children }: { children: ReactNode }) {
  return <div className="relative min-h-0 flex-1 overflow-auto p-5">{children}</div>;
}

/**
 * The real `DeckSearchPanel`, with the four props the editor hands it and nothing invented.
 *
 * `useDeck` is mounted here for the reason `DeckSearchPanel.stories.tsx` mounts it in its own
 * wrapper: `add` is the editor's `useDeck().addCard`, handed down rather than re-mounted inside
 * the panel. In these three frames that costs a second observer of the deck read, which the
 * editor beside it also holds — a mock-up's price, and one no shipped surface pays.
 *
 * `roomy` is passed `true` on purpose. The editor's own copy of this panel is railed at this
 * width and every option below is a proposal about what to draw *instead* of that rail, so the
 * panel each option opens has to be told it has room.
 */
function PhoneSearch({ deckId }: { deckId: number }) {
  const deck = useDeck(deckId);
  return (
    <DeckSearchPanel
      add={deck.addCard}
      categories={deck.categories}
      deckId={deckId}
      targetCategoryId={deck.deck?.defaultCategoryId ?? AUTO_CATEGORY}
      roomy
      // The desk's own width, so `drawnWidth` comes out at 350 rather than at the panel's 384
      // default: `min(max(width, 206), max(maxWidth, 206))`, read off the prop's own note.
      maxWidth={PHONE_PX - 40}
    />
  );
}

/**
 * **D1 — the rail's fallback, taken seriously.** The rail stays; pressing it opens the search as
 * a full-width overlay over the deck, which is the pattern issue #183 already established for
 * the card pane (`PANE_OVER_ATTR` — the pane covers whichever column the reader was *not*
 * looking at).
 *
 * **The state is an arg rather than a control in the frame, and that is the option's first
 * cost.** The shipped disclosure is `aria-disabled` exactly when `roomy` is false — `onClick`
 * is `() => roomy && setOpen(!open)` — so at 390 the rail refuses the press and explains why.
 * D1 needs that refusal to become an *answer*: the same measurement, a different consequence.
 * There is no prop that expresses "no room for a column, so open as an overlay"; `roomy` is a
 * boolean meaning "draw it beside the deck", and D1 turns it into a three-way question.
 */
function RailOverlay({ deckId, searchOpen }: { deckId: number; searchOpen: boolean }) {
  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-bg">
      <Main>
        <DeckEditor key={deckId} deckId={deckId} />
      </Main>
      {searchOpen && (
        // Opaque and full-frame, over the deck. The editor's own 36px rail is underneath it —
        // in the option that rail is the way back, and it is the only chrome D1 adds, which is
        // to say none.
        <div className={cn("absolute inset-0 flex bg-bg p-5", LAYER.popup)}>
          <PhoneSearch deckId={deckId} />
        </div>
      )}
    </div>
  );
}

/**
 * **D2 — a bottom sheet.** The search becomes a surface at the bottom edge of the window with
 * the deck visible above it, and a card is dragged *up* out of the sheet into a pile.
 *
 * **This is the only option that keeps cross-surface drag on a phone**, and the reason it can is
 * not the sheet: it is `QuickZones`, which already draws `Auto`, `New category`, the Maybeboard
 * and the Sideboard as four dashed boxes `sticky` to the top of the editor for the length of a
 * drag. At a 350px desk those four are 70.5 × 76px each — above WCAG 2.5.5's 44 on both axes.
 * So the top half of the corridor a drag out of the sheet needs is already built.
 *
 * **Two things the sheet collides with, and both are in the frame below.** `PriceStrip` goes
 * `sticky bottom-0` while a card is in the air, so the remove tray is drawn at the foot of the
 * visible area — which is under the sheet. And `DeckSearchPanel` draws a left hairline whose
 * whole sentence is "everything right of this line is not your deck": true of a column, false of
 * a sheet, and there is no prop to turn it off.
 */
function BottomSheet({ deckId, searchOpen }: { deckId: number; searchOpen: boolean }) {
  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-bg">
      <Main>
        <DeckEditor key={deckId} deckId={deckId} />
      </Main>
      {searchOpen && (
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 flex flex-col rounded-t-xl border-t border-border",
            "bg-bg shadow-lg",
            LAYER.popup,
          )}
          // Inline rather than an arbitrary Tailwind value, because it is computed — the same
          // reason the frame decorator spells its width this way.
          style={{ height: SHEET_PX }}
        >
          {/* The grab handle, and the one piece of chrome this round invents. `aria-hidden`
              because it is not the control: a sheet a reader can only raise by dragging a 4px
              bar is a sheet with no keyboard path, so the affordance that opens and closes it
              has to be a real button somewhere else — which is the rail's chevron today and is
              exactly the prop D2 does not have. */}
          <div aria-hidden="true" className="flex shrink-0 justify-center py-2">
            <span className="h-1 w-9 rounded-full bg-border" />
          </div>
          <div className="flex min-h-0 flex-1 px-5 pb-5">
            <PhoneSearch deckId={deckId} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * **D3 — `Deck | Find`, one pane at a time.** A segmented pair at the top of the editor; each
 * pane takes the whole width; no cross-surface drag at all.
 *
 * **The pair is two `ToggleChip`s**, which is the app's own `aria-pressed`-over-a-`.map`
 * vocabulary rather than `role="tab"` — the same choice the editor's Theory/Actual switch makes,
 * and for the reason stated there: that role brings an arrow-key contract this app implements
 * nowhere else. Which is also D3's most awkward fact, visible in the frame: the editor *already*
 * draws a segmented pair (`Theory | Actual`), so this puts a second one directly above it, and
 * the two mean different kinds of thing.
 *
 * The `Deck` pane draws the shipped editor, rail and all — the 36px column at the right edge of
 * the desk is the thing D3 deletes, and there is no prop that deletes it.
 */
function OnePaneAtATime({ deckId, searchOpen }: { deckId: number; searchOpen: boolean }) {
  const [pane, setPane] = useState<"deck" | "find">(searchOpen ? "find" : "deck");
  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-bg">
      <div role="group" aria-label="Deck editor pane" className="flex shrink-0 gap-2 px-5 pt-5">
        <ToggleChip label="Deck" pressed={pane === "deck"} onClick={() => setPane("deck")} />
        <ToggleChip label="Find" pressed={pane === "find"} onClick={() => setPane("find")} />
      </div>
      {pane === "deck" ? (
        <Main>
          <DeckEditor key={deckId} deckId={deckId} />
        </Main>
      ) : (
        <div className="flex min-h-0 flex-1 p-5">
          <PhoneSearch deckId={deckId} />
        </div>
      )}
    </div>
  );
}

const OPTIONS = {
  d1: RailOverlay,
  d2: BottomSheet,
  d3: OnePaneAtATime,
} as const;

type OptionId = keyof typeof OPTIONS;

/** One frame, one option. The dispatch is here so the three stories share one Controls panel. */
function PhoneEditor({
  option,
  deckId,
  searchOpen,
}: {
  option: OptionId;
  /**
   * Which seeded deck. **2 is `Kenrith Two-Drops`** — a Commander deck grouped by category, so
   * the frame draws the shape this round is about: a command-zone box, one named pile of 17 rows
   * and a rail holding the Sideboard and the Maybeboard.
   *
   * **4 is the stress case** — `Rhystic Testbed`, seven piles, two of them switched off, opening
   * on its plan and grouped by type because that is where its reader left it. **1 is
   * `Modern Goodstuff`**, sixty cards in one pile: the long-column case, and the one that shows
   * what a phone's page scroll costs.
   */
  deckId: number;
  /** Whether the option's search surface is up. See {@link RailOverlay} for why this is an arg. */
  searchOpen: boolean;
}) {
  const Option = OPTIONS[option];
  return <Option deckId={deckId} searchOpen={searchOpen} />;
}

/**
 * The frame — declared here rather than shared, and the numbers rather than the box are what is
 * shared.
 *
 * A Tailwind class cannot be built by interpolation — it would emit no rule at all — so the
 * width is an inline style, which is how this repo already spells a computed length. `shrink-0`
 * because the docs canvas is a flex container: without it a narrow canvas shrinks the frame and
 * the story becomes a picture of a width nobody asked for.
 */
const phone = (Story: () => ReactElement) => (
  <div
    className="flex shrink-0 overflow-hidden"
    style={{ width: PHONE_PX, height: PHONE_HEIGHT_PX }}
  >
    <Story />
  </div>
);

const meta = {
  title: "Mobile/Deck editor",
  component: PhoneEditor,
  tags: ["autodocs"],
  args: { option: "d1", deckId: 2, searchOpen: true },
  argTypes: {
    option: { control: "inline-radio", options: ["d1", "d2", "d3"] },
    deckId: { control: "inline-radio", options: [1, 2, 4] },
  },
  // Keyed on every arg, because two of the three options hold state seeded from one — flipping a
  // control has to mount a fresh frame rather than leave the old answer in it. `DeckEditor` is
  // keyed on its own `deckId` inside each option for the reason `Decks/Editor` keys it: an editor
  // that survives a change of deck inherits the last one's view, grouping, filter and add target.
  render: (args) => (
    <PhoneEditor key={`${args.option}:${args.deckId}:${args.searchOpen}`} {...args} />
  ),
  decorators: [phone],
  parameters: {
    // **An iframe per story, and the reason is `useAppStore` rather than a render-phase write.**
    // `DeckEditor` writes the store only from effects and callbacks, so the letter of
    // `.storybook/CLAUDE.md`'s rule is not what bites here — what bites is that three editors on
    // one shared canvas read one `selectedCardId`, one `cardSelection` and one `cardZoom`, so
    // pressing a card in one frame opens the pane in the other two and resizes their cards. An
    // iframe each is also what makes 390×844 a viewport rather than a box on a wide page.
    docs: { story: { inline: false, height: "900px" } },
  },
} satisfies Meta<typeof PhoneEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **D1 — the rail's fallback, taken seriously.**
 *
 * Reuses the most of any option: `roomForPanel` unchanged, `PANE_OVER_ATTR`'s overlay pattern
 * borrowed whole, `StackView`/`TextView`/`GridView` untouched, and no new surface type. What it
 * costs is drag: while the overlay covers the deck there is nothing to drag *into*, so adding a
 * card from the search is a tap and dragging is for rearranging what is already in the deck.
 */
export const RailOpensAnOverlay: Story = { args: { option: "d1" } };

/**
 * **D2 — a bottom sheet at 40 % of the frame, with the deck above it.**
 *
 * The only option that keeps cross-surface drag, and the only one that spends what the dnd-kit
 * migration bought — `@dnd-kit/dom`'s `PointerSensor` is pointer-based, so a touch drag out of
 * the sheet and up into a pile is a gesture the library can actually deliver. Costs a surface
 * type this app does not have, and lands on the remove tray.
 */
export const SearchAsABottomSheet: Story = { args: { option: "d2" } };

/**
 * **D3 — `Deck | Find`, one pane at a time.**
 *
 * The simplest and the most predictable, and it gives up the most: no cross-surface drag at all,
 * a second segmented pair on a screen that already has one, and — because each pane is the whole
 * 350px — the only option where the deck gets the desk back. Shown on the `Find` pane; press
 * `Deck` in the frame to see the other half.
 */
export const DeckAndFindOneAtATime: Story = {
  name: "Deck | Find, one at a time",
  args: { option: "d3" },
};
