import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { DEFAULT_SECTION_ZOOMS } from "@/lib/cardZoom";
import { useAppStore } from "@/lib/store";
import { STACK_CARD_WIDTH, stackCardWidth } from "./CardStack";
import { DeckTokensPanel, TOKENS_HEADING } from "./DeckTokensPanel";

/**
 * The wall's tiles in the order they are drawn, by the one string that tells two of them apart.
 *
 * **Read off the picture buttons and not off the list items**, because a `<li>` computes no
 * accessible name at all — so a test that asked the list would be asserting about the DOM while
 * the reader's screen reader answered from somewhere else entirely.
 */
function tileNames(region: HTMLElement): (string | null)[] {
  return within(region)
    .getAllByRole("button", { name: /^Change the art for / })
    .map((tile) => tile.getAttribute("aria-label"));
}

/** What each seeded token's subtitle comes out as, spelled once so four stories agree. */
const SUBTITLE = {
  treasure: "Colorless · {T}, Sacrifice this token: Add one mana of any color.",
  construct: "Colorless 4/4 · Flying, haste",
  wurmDeathtouch: "Colorless 3/3 · Deathtouch",
  wurmLifelink: "Colorless 3/3 · Lifelink",
} as const;

/**
 * The tokens and emblems a deck needs — **driven end to end by `.storybook/fake/`.**
 *
 * Nothing below is a prop. The wall is `deck_tokens`' answer, derived by the fake from the
 * deck's own cards exactly as the crate derives it from each card's `all_parts`: switch a
 * category off and a maker stops making, cut the card and its token leaves. The reader's
 * *deviations* — an art, a count, a dismissal, a token added by hand — are the only rows
 * `deck_tokens` holds, and the seed carries one of each.
 *
 * **Which deck a story opens is the story's whole setup**, because the three shapes of this
 * panel are three shapes of deck rather than three sets of props:
 *
 * * **Deck 1, `Modern Bolt`** — makes five. A Treasure two of its cards name, a Construct, the
 *   two same-named Wurms from a card in its *sideboard*, and an emblem. Its Maybeboard names a
 *   Treasure too and contributes nothing at all, which is what an inactive category means.
 * * **Deck 3, `Old School`** — makes nothing, and it is a real deck rather than an empty world:
 *   four Alpha cards, none of which names a token in the corpus. The empty state is a fact
 *   about a deck, so this is the honest way to reach it.
 *
 * **`open` is the deck's own column** (`decks.tokens_open`), so it is an arg here and the press
 * is `onToggle` — the editor writes it back through `deck.update`, and a story is the half of
 * that pair without a database behind it.
 *
 * **A token's name does not identify it**, which is why every control on a tile spells the
 * subtitle into its own accessible name. 104 token and emblem names are carried by more than one
 * `oracle_id` in the corpus (measured 2026-09-07, debug build) and `Wurmcoil Engine` alone puts
 * two 3/3 colourless Wurms on one wall, separated only by Deathtouch against Lifelink — the pair
 * deck 1 seeds. Two tiles announcing one name is a bug that has shipped here before, on the
 * collection wall, and neither suite could see it because both names were correct.
 *
 * **The art is real art.** Every token here is an ordinary row of the generated corpus — seven
 * of them since 2026-09-07 — so `@/lib/images` has a picture for each and `card_printings`
 * answers a grid for the art picker. Until then the fixture minted its own `7…` printing ids,
 * which resolved to nothing in either: every tile drew the unknown-card frame and the picker's
 * grid was empty. See `.storybook/fake/db.ts`'s `TOKEN_PRINTING` for what each row is for.
 */
const meta = {
  title: "Decks/DeckTokensPanel",
  component: DeckTokensPanel,
  tags: ["autodocs"],
  args: { deckId: 1, variant: "live", open: true, onToggle: fn() },
  // The band sits at the foot of the editor's column, which is the only scroller in it — so it
  // is given a column's width and nothing else.
  //
  // **It wraps here, and that is the honest picture rather than a decorator that needs widening.**
  // A tile is `stackCardWidth(cardZoom.deck)` since 2026-09-08 — 210px at 100% — so 60rem holds
  // four of the seven the seed makes, which is roughly what a real desk holds. This comment used
  // to promise a row that did not wrap, at 150px tiles.
  decorators: [
    (Story) => (
      <div className="w-[60rem] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Every token and emblem the open deck needs, in a band between the price strip and " +
          "the deck stats.\n\n" +
          "**A tile is a stacked card at the desk’s own zoom** — `cardZoom.deck`, the same " +
          "number the Stacks and Grid views read — so the tokens a deck makes are drawn the " +
          "size of the cards that make them, at every stop of the ladder. The art picker behind " +
          "a tile follows it, because a reader who presses a picture has to meet the same " +
          "picture at the same size.\n\n" +
          "**The list is derived on every open and never stored.** Each of the deck's distinct " +
          "cards in an *active* category is read for the tokens it makes; what the table holds " +
          "is only what the reader changed — which art, how many, and whether it is on the wall " +
          "at all. So a deck nobody has touched still has a full wall, and a token that stops " +
          "being made simply stops being drawn.\n\n" +
          "**The heading is “Tokens & emblems” and never bare “Tokens”**, which the deck " +
          "editor already uses for an auto-category of cards that *make* tokens — the opposite " +
          "meaning of the same word.\n\n" +
          "**Emblems sort last.** An emblem is a one-off a deck may make once in a game; a pile " +
          "of Treasures is what a reader reaches for, so the things they touch sit where they " +
          "can be touched.",
      },
    },
  },
} satisfies Meta<typeof DeckTokensPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Shut, which is what every existing deck is and what a reader who never sleeves tokens goes on
 * paying one header row for.
 *
 * **The read runs anyway**, and the count beside the heading is why: *what this deck brings* is
 * the reason to open the area at all, and a header that could only say "press to find out" would
 * be a control asking the reader to guess. It costs one query against a corpus the app already
 * has.
 *
 * Four rather than five, because one of deck 1's tokens is dismissed — the number is what the
 * deck brings, so a dismissal is not in it.
 */
export const Collapsed: Story = {
  args: { open: false },
  play: async ({ canvas, args }) => {
    const disclosure = await canvas.findByRole("button", { name: TOKENS_HEADING });
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(await canvas.findByText("4 to bring")).toBeInTheDocument();

    // Nothing of the wall is mounted while it is shut — no picture, no tile, no stepper.
    await expect(canvas.queryByRole("button", { name: /^Change the art for / })).toBeNull();
    // …and neither is the dismissed switch, which is a control over a wall that is not there.
    await expect(canvas.queryByRole("button", { name: /^Show dismissed/ })).toBeNull();

    // The press writes `decks.tokens_open`; the editor owns the write, so this is the whole of
    // what the panel does with it.
    await userEvent.click(disclosure);
    await expect(args.onToggle).toHaveBeenCalledWith(true);
  },
};

/**
 * Open, on the deck the seed builds for it.
 *
 * Four tiles, and each one is a different thing the reader can have done:
 *
 * * **Treasure** — an art *and* a count changed, so both controls are off their defaults and the
 *   reset affordance has something to undo. Two of the deck's cards name it, from two different
 *   printings, which is the ordinary case rather than a corner: across 40 Treasure makers in the
 *   corpus, 12 distinct Treasure printings are referenced.
 * * **Construct** — a stored quantity of **0**. Zero is a value and not an absence: a token the
 *   reader has decided they need none of while keeping it on the list, and it is the exact state
 *   `stored || 1` reads as untouched and silently draws as 1.
 * * **Wurm** — untouched, and drawn with the subtitle that is the whole of what tells it from
 *   its twin. Its twin is dismissed and is one story down.
 * * **The emblem** — Oko's, untouched, sorted last, and with **no subtitle at all**: the tile's
 *   own name already says whose emblem it is, so a second line would repeat what it is drawing.
 *   The tile knows it is an emblem from its `layout` and never from its type line, which on this
 *   row is the bare word `Emblem`.
 */
export const Expanded: Story = {
  play: async ({ canvas }) => {
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    await within(region).findByRole("button", { name: `Change the art for Treasure, ${SUBTITLE.treasure}` });

    // Emblems last, the rest by name — and the two Wurms are not both here, because one of them
    // is dismissed.
    await expect(tileNames(region)).toEqual([
      `Change the art for Construct, ${SUBTITLE.construct}`,
      `Change the art for Treasure, ${SUBTITLE.treasure}`,
      `Change the art for Wurm, ${SUBTITLE.wurmDeathtouch}`,
      "Change the art for Oko, Shadowmoor Scion Emblem",
    ]);

    // The three effective quantities, each arrived at a different way: stored, stored as zero,
    // and the floor a token nobody touched falls back to.
    await expect(
      within(region).getByRole("spinbutton", { name: `Quantity of Treasure, ${SUBTITLE.treasure}` }),
    ).toHaveValue(4);
    await expect(
      within(region).getByRole("spinbutton", {
        name: `Quantity of Construct, ${SUBTITLE.construct}`,
      }),
    ).toHaveValue(0);
    await expect(
      within(region).getByRole("spinbutton", {
        name: `Quantity of Wurm, ${SUBTITLE.wurmDeathtouch}`,
      }),
    ).toHaveValue(1);

    // Reset is drawn only where there is a deviation to undo — which is what keeps it from being
    // a control that spends most of a wall refusing.
    await expect(
      within(region).getByRole("button", { name: `Reset Treasure, ${SUBTITLE.treasure}` }),
    ).toBeInTheDocument();
    await expect(
      within(region).queryByRole("button", { name: `Reset Wurm, ${SUBTITLE.wurmDeathtouch}` }),
    ).toBeNull();

    // The subtitle is drawn as well as spoken, in an element of its own — two flex children with
    // a `gap` between them compute to a name with the words run together.
    await expect(within(region).getByText(SUBTITLE.wurmDeathtouch)).toBeInTheDocument();
    // Why the tile is here at all, which is the answer to the only question an unexplained
    // picture raises.
    await expect(
      within(region).getByText("From Ragavan, Nimble Pilferer, Smuggler's Copter"),
    ).toBeInTheDocument();
  },
};

/**
 * **A deck that makes nothing, and it is not an error.**
 *
 * Deck 3 is four Alpha cards, none of which names a token or an emblem in the corpus. So the
 * heading is set in type with no disclosure under it — a greyed control that spends the whole
 * deck refusing is the editor's own argument against drawing one — and the sentence says which
 * of the two silences this is.
 *
 * **"This deck makes nothing" and "nothing has answered yet" are two sentences**, and the panel
 * only writes the first once the read has actually landed. A refused read is not pending and has
 * no rows either, and captioning that *makes nothing* would be the app asserting a fact it does
 * not have.
 *
 * Nothing here depends on the Tagger datasets, the price feeds or the relay: this feature reads
 * the corpus and nothing else.
 */
export const NothingToMake: Story = {
  args: { deckId: 3 },
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByText("Nothing in this deck makes a token or an emblem."),
    ).toBeInTheDocument();

    // The heading is still there — it is the area's name, not a control — and it is not a button.
    await expect(canvas.getByText(TOKENS_HEADING)).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: TOKENS_HEADING })).toBeNull();
    // No count either: a bare `0 to bring` beside a sentence saying so is the same fact twice.
    await expect(canvas.queryByText(/to bring$/)).toBeNull();
  },
};

/**
 * The dismissed token, revealed — **and the two Wurms side by side, which is the whole reason a
 * tile draws a subtitle.**
 *
 * A dismissal is the reader saying "not in this deck", so it really leaves the wall; this switch
 * is the only way back, and it is drawn only on a deck that has one. The count beside the
 * heading does **not** move when it is pressed: the number is what the deck brings, and looking
 * at something you put away does not bring it.
 *
 * Both Wurms are 3/3, both colourless artifact creatures, both called `Wurm`. Deathtouch against
 * Lifelink is every bit of the difference, and it reaches the reader three times over — under
 * the name, in the stepper's name, and in the verb on the button that puts one back.
 */
export const DismissedRevealed: Story = {
  play: async ({ canvas }) => {
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    const chip = await within(region).findByRole("button", {
      name: "Show dismissed, 1 token or emblem",
    });
    await expect(chip).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(chip);
    // **The wait is the assertion.** Reading the wall in the same tick as the press asks about
    // the frame before the reveal, which answers with four tiles and reads exactly like a switch
    // that does nothing.
    await within(region).findByRole("button", {
      name: `Restore Wurm, ${SUBTITLE.wurmLifelink}`,
    });
    await expect(chip).toHaveAttribute("aria-pressed", "true");

    // Five tiles now, and the two same-named ones are adjacent — which is exactly the layout in
    // which one accessible name for both would be unusable.
    await expect(tileNames(region)).toEqual([
      `Change the art for Construct, ${SUBTITLE.construct}`,
      `Change the art for Treasure, ${SUBTITLE.treasure}`,
      `Change the art for Wurm, ${SUBTITLE.wurmDeathtouch}`,
      `Change the art for Wurm, ${SUBTITLE.wurmLifelink}`,
      "Change the art for Oko, Shadowmoor Scion Emblem",
    ]);

    // The revealed one is the only tile offering to be restored; its twin still offers to be
    // dismissed, and the two are told apart by the same line.
    await expect(
      within(region).getByRole("button", { name: `Restore Wurm, ${SUBTITLE.wurmLifelink}` }),
    ).toBeInTheDocument();
    await expect(
      within(region).getByRole("button", { name: `Dismiss Wurm, ${SUBTITLE.wurmDeathtouch}` }),
    ).toBeInTheDocument();

    // Unmoved, and deliberately: a dismissal is not one of the tokens this deck brings.
    await expect(within(region).getByText("4 to bring")).toBeInTheDocument();
  },
};

/**
 * **The wall at 150% of the desk's zoom, which is the whole of what a tile's size follows.**
 *
 * A tile is `stackCardWidth(cardZoom.deck)` — the stacked card's own width, read at the number
 * the reader set on the deck beside it — so the tokens a deck makes are drawn the size of the
 * cards that make them. `cardZoom.deck` is one key for **both** deck views for the reason
 * `cardZoom.ts` gives, and this band is a third thing on the same desk; what it is emphatically
 * not is `deckSearch`, the docked column, which is why that record holds a number per section.
 *
 * **Everything on the tile moves with it**, through `cardScaleVars`: the name, the subtitle, the
 * `From …` line, the stepper and the two icon buttons. A 315px picture over an 11px caption is
 * the tile disagreeing with itself, and it is the failure this story is here to make visible —
 * neither the type sizes nor the picture's width can be asserted from jsdom, so the play below
 * pins the one number that is an inline style and the picture is the reader's own check.
 *
 * The store is set rather than mocked because `useCardZoomPersistence` is `AppShell`'s alone —
 * nothing in a story writes this row back.
 */
function ZoomedBand() {
  // **During render rather than in an effect, and in a frame of its own** — `DecksPage`'s
  // `ZoomedWall`, for both of its reasons. An effect runs after the first paint, so the wall
  // would be shown at 100% for a frame on its way here; and `useAppStore` is a module singleton,
  // so a write made while the other four stories are rendered inline on the docs page would be
  // the last writer and would silently resize all of them (`.storybook/CLAUDE.md`).
  useState(() => {
    useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, deck: 1.5 } });
  });
  return <DeckTokensPanel deckId={1} variant="live" open onToggle={fn()} />;
}

export const Zoomed: Story = {
  render: () => <ZoomedBand />,
  parameters: { docs: { story: { inline: false, height: "520px" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    const tile = await within(region).findByRole("button", {
      name: `Change the art for Treasure, ${SUBTITLE.treasure}`,
    });

    // The `<li>` carries the width, so the assertion climbs to it rather than reading the button
    // — which is `w-full` and would answer about its parent anyway, by a route that would go on
    // agreeing if the width moved to the wrong box.
    const item = tile.closest("li");
    await expect(item).not.toBeNull();
    await expect(item).toHaveStyle({ width: `${stackCardWidth(1.5)}px` });

    // Said as the ladder rather than as a literal, so a change to `STACK_CARD_WIDTH` moves this
    // story with it instead of failing it. What is pinned is that the wall reads the zoom at
    // all, which is the property that can regress.
    await expect(stackCardWidth(1.5)).toBeGreaterThan(STACK_CARD_WIDTH);
  },
};
