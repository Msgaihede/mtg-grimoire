import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useAppStore } from "@/lib/store";
import { printing } from "../../../.storybook/fake/fixtures";
import { seed } from "../../../.storybook/fake/seeds";
import { CardDetailModal } from "./CardDetailModal";

/**
 * **Lightning Bolt, `lea 161`** — the corpus's one card with four printings, which is what makes
 * the printing picker and its `View all printings (N)` count draw something rather than a stub.
 * Looked up by `(setCode, collectorNumber)` rather than by a pasted id, so a regenerated corpus
 * fails this file at load instead of opening the modal onto a printing the database has no row
 * for.
 */
const BOLT = printing("lea", "161").id;

/** The deck the seed files a Sol Ring into, and the printing it holds. */
const SOL_RING_C21 = printing("c21", "263").id;
const SEEDED_DECK = 2;

/**
 * The category a deck holds a printing in — **read out of the seed rather than written down.**
 *
 * A `PaneDeckContext` names a `deck_categories` **id** (what every deck write is addressed by)
 * and its **name** (what the rail's deck line reads back), and both are minted by the seed's own
 * row numbering rather than being constants this file may assume. Looking the pair up through the
 * deck card itself is also the honest staging: it is exactly the slot a reader would have clicked
 * to open this modal from.
 */
function slotOf(deckId: number, cardId: string) {
  const db = seed("starter");
  const row = db.deckCards.find((c) => c.deckId === deckId && c.cardId === cardId);
  return db.deckCategories.find((c) => c.id === row?.categoryId) ?? null;
}

/**
 * The modal, opened the way the app opens it — through the store, never through a prop.
 *
 * `CardDetailModal` takes nothing at all: it reads `selectedCardId` and is mounted once at `App`
 * level. So a story opens it the same way a card tile does, and the two openers differ in exactly
 * the way the app's do — `openCardFromDeck` sets `paneDeckContext` and is what makes
 * `useCardModalScope` answer `deck`, while `setSelectedCardId` clears it.
 *
 * **`useState`'s lazy initializer rather than an effect**, which is every other card story's
 * answer and for its reason: an effect runs after the first paint, so the story would draw one
 * frame of a closed dialog before it opened.
 */
function Modal({ cardId, deckId }: { cardId: string; deckId: number | null }) {
  useState(() => {
    const store = useAppStore.getState();
    const slot = deckId === null ? null : slotOf(deckId, cardId);
    if (deckId === null || slot === null) store.setSelectedCardId(cardId);
    else {
      store.setActiveView("decks");
      store.openCardFromDeck({
        deckId,
        categoryId: slot.id,
        categoryName: slot.name,
        cardId,
        // The list the editor would have been drawing, and the regular copy — which is what
        // every seeded row is.
        variant: "live",
        finish: null,
      });
    }
    // A walk to step along, so the chevron pair is drawn rather than absent. Two stops either
    // side of the open card, because `StepChevron` renders `disabled` at an end of the walk and a
    // story about the layout wants the ordinary state.
    store.setCardWalk({
      label: "Search results",
      stops: [
        { cardId: printing("2x2", "117").id, oracleId: "o-a", name: "Sol Ring", deck: null },
        { cardId, oracleId: "o-b", name: "Lightning Bolt", deck: null },
        { cardId: printing("lea", "47").id, oracleId: "o-c", name: "Ancestral Recall", deck: null },
      ],
    });
    return null;
  });

  return <CardDetailModal />;
}

/**
 * One frame per rung.
 *
 * **`transform: translateZ(0)` is the whole trick, and it is the same one every dialog story here
 * uses**: `position: fixed` resolves against the nearest *transformed* ancestor rather than the
 * viewport, so one line turns a window-covering modal into a story-sized one and lets four rungs
 * sit on one docs page.
 *
 * It is also what makes these stories exercise the real folds. The panel *asks* for its size with
 * viewport queries — see `PANEL_SIZE`, where the circular-container argument is written out — but
 * `Dialog`'s `max-w-full` clamps that request to this box, and the container queries inside then
 * measure the **panel's actual width**. So a 390px frame draws the phone layout whatever the
 * browser window is doing, which is the property that makes a workbench of four rungs possible at
 * all.
 */
function Frame({
  width,
  height,
  ...args
}: {
  cardId: string;
  deckId: number | null;
  width: number;
  height: number;
}) {
  return (
    <div
      style={{ transform: "translateZ(0)", width, height }}
      className="relative overflow-hidden rounded-lg border border-border bg-bg"
    >
      <Modal {...args} />
    </div>
  );
}

const meta = {
  title: "Card/Detail modal",
  component: Frame,
  tags: ["autodocs"],
  args: { cardId: BOLT, deckId: null, width: 1400, height: 820 },
  // Keyed on everything the initializer reads, so changing the card or the opener in Controls
  // mounts a fresh host and runs it again rather than writing to a store the mounted modal is
  // already subscribed to.
  render: (args) => <Frame key={`${args.cardId}:${args.deckId}:${args.width}`} {...args} />,
  parameters: {
    docs: {
      /**
       * **Each story on this page gets its own frame**, which is the one thing that gives it its
       * own `useAppStore`. Every story here writes `selectedCardId`, `paneDeckContext` and
       * `cardWalk` during render, and the store is a module singleton `.storybook/` cannot make
       * per-story — inline, a docs page mounts every story at once and the last to render owns
       * the store for all of them.
       */
      story: { inline: false, height: "900px" },
      description: {
        component:
          "One centred modal, replacing the three mounts of the docked card pane.\n\n" +
          "**The folds are container queries on the panel, not viewport branches** — the panel " +
          "carries `@container/card` and every column inside it asks about *that* box, because " +
          "the same panel is drawn in a 390px phone frame and a 1400px window and the window " +
          "answers about the wrong thing. The one exception is the panel's **own** size, which " +
          "cannot be a container query about itself: it asks the window and is then clamped by " +
          "`Dialog`'s `max-w-full`, so what the columns fold on is the width the panel really " +
          "got.\n\n" +
          "**The grimoire counts are drawn twice and exactly one is visible.** " +
          "`CardModalRail` keeps them in the rail at `@min-[1200px]/card` and up; below that " +
          "they are an inline row in the centre column. All four artboards show them — at the " +
          "narrower rungs they *move* rather than vanish.\n\n" +
          "**The step chevrons are one pair in two places.** Above 900px of window they are " +
          "`Dialog`'s `flanks`, hung off the panel's edges in columns the scrim reserves; below " +
          "that there is no glass to hang them in, so they sit in the action row's left corner. " +
          "With no stop for the open card there is no pair at all — `flanks: undefined` — " +
          "because a chevron that cannot say where it would go is worse than no chevron.\n\n" +
          "**`Add to deck` is a `Dropdown` rather than the card menu's deck picker**, and that " +
          "is forced: the context menu is mounted at the app root at `LAYER.popup` and this " +
          "modal's scrim is two rungs above it at `LAYER.overlay`, so a menu opened from in here " +
          "would paint *behind* the scrim — invisible, unreachable, and with nothing going red. " +
          "The numbers are `layers.ts`'s and are deliberately not spelled here: " +
          "`layers.test.ts` sweeps `src/` for one and reads a doc string as markup.",
      },
    },
  },
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The phone rung, below `@min-[640px]/card`: **full-bleed, one column, one scroller.**
 *
 * No columns at all — the picture, the controls, the counts and the rail's options are stacked in
 * a single thumb-driven scroll, and every control in the panel is at its 44px height. `Add to
 * deck` takes the whole action row and the other two sit under it, because a right-aligned row of
 * three at this width is three cramped targets.
 */
export const Phone: Story = {
  args: { width: 390, height: 844 },
};

/**
 * `@min-[640px]/card`: **two columns, `[18.75rem_1fr]`.**
 *
 * The picture takes the left column and spans the full height; the controls take the right, with
 * the options rail under them and the grimoire counts inline between the two. The chevrons are in
 * the action row's corner, which is where they stay until the *window* has room for flanks.
 */
export const Narrow: Story = {
  args: { width: 764, height: 820 },
};

/**
 * `@min-[900px]/card`: **three columns, `[20rem_1fr_max-content]`.**
 *
 * The rail becomes the third column. The counts stay inline in the centre — this is the rung
 * artboard `2c` drops them from the rail, because it is where the panel is three columns and the
 * rail has the least room.
 */
export const Desktop: Story = {
  args: { width: 1060, height: 800 },
};

/**
 * `@min-[1200px]/card`: **three columns, `[23.5rem_1fr_max-content]`, counts in the rail.**
 *
 * Opened out of a deck row, which is the one surface that draws everything: the quantity stepper
 * bound to the row, the deck category and label pickers, `Set deck image` in the rail, and the
 * deck line under the grimoire figures. It is also the rung where the counts move *into* the
 * rail, so this story is the only one on the page where the inline row is hidden.
 */
export const Wide: Story = {
  args: { width: 1400, height: 840, cardId: SOL_RING_C21, deckId: SEEDED_DECK },
};
