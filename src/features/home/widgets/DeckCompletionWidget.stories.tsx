import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, fn, within } from "storybook/test";
import { ipc, type HomeWidget } from "@/lib/ipc";
import { printing } from "../../../../.storybook/fake/fixtures";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import {
  ALL_COMPLETE,
  DeckCompletionWidget,
  NO_DECKS,
  NOTHING_PINNED,
} from "./DeckCompletionWidget";
import { DecksWidgetSettings } from "./DecksWidget";

/** The grid's target cell. Not exported, for CSF — every non-default export is a story. */
const CELL = 104;

/** A `deckCompletion` widget at a footprint, with a config. */
function completion(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "deckCompletion", kind: "deckCompletion", x: 0, y: 0, w, h, config };
}

/**
 * The body inside the real card, at the footprint's size on the target cell — with the pin
 * checklist the page hands this kind as its `extraSettings`, so the settings popover is the shipped
 * one.
 */
function Framed({ widget, still = false }: { widget: HomeWidget; still?: boolean }) {
  const widthPx = spanPx(widget.w, CELL);
  const heightPx = spanPx(widget.h, CELL);
  const fit = makeFit({
    w: widget.w,
    h: widget.h,
    widthPx,
    heightPx,
    density: widgetDensity(widget),
  });
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
          extraSettings={<DecksWidgetSettings widget={widget} onConfig={onConfig} />}
        >
          <DeckCompletionWidget
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
 * An empty world with one deck that asks for nothing — which the card leaves off, so the sentence
 * it draws is the no-decks one rather than `every deck is complete`.
 *
 * **Staged through the command rather than seeded**, `DecksPage.stories.tsx`'s `OrphanedCover`
 * idiom: `useQuery` so it runs once in the story's own client, `staleTime: Infinity` so a refocus
 * does not write again, and the card held back until the write has landed.
 */
function OneEmptyDeck({ children }: { children: ReactNode }) {
  const staged = useQuery({
    queryKey: ["story", "empty-shell"],
    queryFn: () => ipc.deckCreate({ name: "Empty shell", formatKey: "modern" }),
    staleTime: Infinity,
  });
  return staged.isSuccess ? <>{children}</> : null;
}

/**
 * `starter` plus one deck that is **complete** — no seed holds one, and a deck that asks for
 * nothing is not complete but absent.
 *
 * The cheapest honest one is a **plan**: a theory deck is measured against every copy the reader
 * could use, the root included, so one planned Counterspell and one more copy at the root is a
 * deck of one card, held — three commands and no move. A *live* deck would need its copy filed
 * into its own group, and `collection_to_deck` adds to the list as it files, so the list would
 * always stay one ahead of the copies. Staged the way {@link OneEmptyDeck} is, and it hands the
 * card the new deck's id so the story can pin it rather than guess what the fake will number it.
 */
function OneFinishedPlan({ children }: { children: (deckId: number) => ReactNode }) {
  const staged = useQuery({
    queryKey: ["story", "finished-plan"],
    queryFn: async () => {
      const cardId = printing("mh2", "267").id;
      const deck = await ipc.deckCreate({
        name: "Finished Plan",
        formatKey: "modern",
        theoryEnabled: true,
      });
      await ipc.deckAddCard(deck.id, cardId, null, "Spells", "theory", null, 1);
      await ipc.collectionAdd({ cardId, finish: "nonfoil", quantity: 1 });
      return deck.id;
    },
    staleTime: Infinity,
  });
  return staged.isSuccess ? <>{children(staged.data)}</> : null;
}

const meta = {
  title: "Home/DeckCompletionWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The kind's default footprint and no config: `Most recent`, `Nearest done`, complete decks
    // hidden — the face a reader who adds one from the catalogue meets first.
    widget: completion(3, 3),
  },
  parameters: {
    docs: {
      description: {
        component:
          "How much of each deck the reader owns, and what the rest would cost. **Owned is the " +
          "deck editor's word**: `deck_completion` measures a live deck against its own group and " +
          "a theory deck's plan against every copy it can use, over every active pile, exact " +
          "printing and exact finish — so the card and the deck it opens can never disagree. A " +
          "row measured on the plan says **`Plan`** before its count.\n\n" +
          "**Complete is `missing === 0`**, never a price. A deck missing nothing leaves the list " +
          "unless `Complete decks` is on, and the footer counts it either way — over every deck " +
          "in scope, not over the rows that fit. `missingCost` is an em dash only when nothing on " +
          "the list is priced. **A deck whose list asks for nothing is not on the card at all** — " +
          "neither complete nor in progress.\n\n" +
          "`Most recent` is `deck_list`'s order with archived and virtual decks taken out; " +
          "`Pinned` is the checklist `DecksWidget` draws, reused. The order is this body's.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default panel over `starter`: the live decks, nearest done first, with a track each — and
 * `Rhystic Testbed`, the deck with a plan, saying its count is the plan's.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Deck completion" }));
    await expect(
      await card.findByRole("button", { name: /^Modern Goodstuff · \d+ of \d+ · \d+ missing/ }),
    ).toBeInTheDocument();
    await expect(
      await card.findByRole("button", {
        name: /^Rhystic Testbed · Plan · \d+ of \d+ · \d+ missing/,
      }),
    ).toBeInTheDocument();
  },
};

/** A band ordered cheapest to finish, complete decks listed: the footer a band has room for. */
export const CheapestOnABand: Story = {
  args: { widget: completion(4, 4, { order: "cheapest", complete: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Deck completion" }));
    await expect(
      await card.findByRole("button", { name: /^Modern Goodstuff · / }),
    ).toBeInTheDocument();
  },
};

/** A two-cell tile: the shortfall and its price moved under the name, no footer. */
export const Tile: Story = {
  args: { widget: completion(2, 3) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Deck completion" }));
    await expect(
      await card.findByRole("button", { name: /^Modern Goodstuff · / }),
    ).toBeInTheDocument();
    await expect(card.queryByText(/to finish/)).not.toBeInTheDocument();
  },
};

/** `Pinned` with nothing pinned points at the checklist rather than drawing the recent decks. */
export const NothingPinned: Story = {
  args: { widget: completion(3, 3, { scope: "pinned" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(NOTHING_PINNED)).toBeInTheDocument();
  },
};

/** A database with no decks at all. */
export const NoDecks: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(NO_DECKS)).toBeInTheDocument();
  },
};

/**
 * One deck, and it asks for nothing: **nothing to measure, not every deck complete**. The deck is
 * not drawn as a row even though `missing === 0` is true of it.
 */
export const OnlyAnEmptyDeck: Story = {
  parameters: { fake: { seed: "empty" } },
  render: (args) => (
    <OneEmptyDeck>
      <Framed {...args} />
    </OneEmptyDeck>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(NO_DECKS)).toBeInTheDocument();
    await expect(canvas.queryByText(ALL_COMPLETE)).not.toBeInTheDocument();
    await expect(canvas.queryByText("Empty shell")).not.toBeInTheDocument();
  },
};

/**
 * Every deck in scope is complete and the switch is off: the sentence names the switch. The scope
 * is the one finished deck, pinned — `starter`'s own four are all short.
 */
export const EveryDeckComplete: Story = {
  render: (args) => (
    <OneFinishedPlan>
      {(deckId) => (
        <Framed {...args} widget={completion(3, 3, { scope: "pinned", deckIds: [deckId] })} />
      )}
    </OneFinishedPlan>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(ALL_COMPLETE)).toBeInTheDocument();
  },
};

/** A catalogue preview: the same rows as pictures of rows — nothing to press. */
export const Still: Story = {
  args: { still: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Deck completion" }));
    await expect(await card.findByText("Modern Goodstuff")).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Modern Goodstuff · / })).toBeNull();
  },
};
