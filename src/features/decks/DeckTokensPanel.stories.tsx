import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type JSX } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { DEFAULT_SECTION_ZOOMS } from "@/lib/cardZoom";
import type { DeckVariant } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { STACK_CARD_WIDTH, stackCardWidth } from "./CardStack";
import { tokenCountWords } from "./CountPill";
import { DeckTokensPanel, TOKENS_HEADING } from "./DeckTokensPanel";
import { entryRef } from "./deckTokens";
import { TokenArtPicker, type TokenPickerMode } from "./TokenArtPicker";
import { useDeck } from "./useDeck";
import { useDeckTokens } from "./useDeckTokens";

interface TokensBandProps {
  deckId: number;
  variant: DeckVariant;
  open: boolean;
  onToggle: (next: boolean) => void;
}

/**
 * Which job the one picker is open for — `DeckEditor`'s own shape: an entry held **by its key**
 * and looked up on every render, never a frozen view, because the wall is re-derived after every
 * write.
 */
type Picking = { kind: "swap"; entryKey: string } | { kind: "add" } | null;

/**
 * The band as `DeckEditor` hosts it: **one `useDeckTokens` call and one picker**, handed to the
 * band as props — and the deck's own row for the mode, written through `deck.update` exactly as
 * the editor writes it.
 *
 * The band stopped calling the hook itself on 2026-09-24 (issue #507), because a deck whose mode
 * draws a pile draws the same tokens a second time in the deck views, and the two drawings — and
 * the one picker both open — have to share one answer. So a story is the host's half as well as
 * the band's, which is what keeps every story below driven end to end by the fake rather than by
 * a hand-built `DeckTokens`.
 */
function TokensBand({ deckId, variant, open, onToggle }: TokensBandProps): JSX.Element {
  const tokens = useDeckTokens(deckId, variant);
  const deck = useDeck(deckId);
  const [picking, setPicking] = useState<Picking>(null);
  const zoom = useAppStore((s) => s.cardZoom.deck);

  const swapping =
    picking?.kind === "swap"
      ? (tokens.tokens.find((view) => view.entryKey === picking.entryKey) ?? null)
      : null;
  const mode: TokenPickerMode | null =
    swapping !== null
      ? { kind: "swap", entry: swapping }
      : picking?.kind === "add"
        ? { kind: "add", tokens: tokens.tokens }
        : null;

  return (
    <>
      <DeckTokensPanel
        tokens={tokens}
        open={open}
        onToggle={onToggle}
        onPick={(view) => setPicking({ kind: "swap", entryKey: view.entryKey })}
        onAddPrinting={() => setPicking({ kind: "add" })}
        mode={deck.deck?.tokenMode ?? "managed"}
        onMode={(tokenMode) => deck.update.mutate({ tokenMode })}
      />
      <TokenArtPicker
        mode={mode}
        zoom={zoom}
        onPick={(to) => {
          if (mode?.kind === "swap") tokens.swap(entryRef(mode.entry), to);
          if (mode?.kind === "add") tokens.addPrinting(to.cardId, to.finish);
          setPicking(null);
        }}
        onDismiss={() => setPicking(null)}
        onClose={() => setPicking(null)}
      />
    </>
  );
}

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

/** What each seeded token's subtitle comes out as, spelled once so every story agrees. */
const SUBTITLE = {
  treasure: "Colorless · {T}, Sacrifice this token: Add one mana of any color.",
  construct: "Colorless 4/4 · Flying, haste",
  wurmDeathtouch: "Colorless 3/3 · Deathtouch",
  wurmLifelink: "Colorless 3/3 · Lifelink",
} as const;

/**
 * Each seeded entry as every control on its tile names it — the token, its subtitle, **and its
 * printing and finish**, which since user schema v52 is what tells two tiles of one token apart.
 *
 * The Treasure is the entry the seed's art-and-count override became (the `tafr` printing at
 * four, plain — the rung writes `nonfoil`); the other four are implicit entries, drawn at the
 * resolver's default printing in its default finish, which for a printing sold in both is the
 * plain one.
 */
const ENTRY = {
  treasure: `Treasure, ${SUBTITLE.treasure}, TAFR · 15, Nonfoil`,
  construct: `Construct, ${SUBTITLE.construct}, TMSC · 14, Nonfoil`,
  wurmDeathtouch: `Wurm, ${SUBTITLE.wurmDeathtouch}, T2XM · 29, Nonfoil`,
  wurmLifelink: `Wurm, ${SUBTITLE.wurmLifelink}, T2XM · 30, Nonfoil`,
  oko: "Oko, Shadowmoor Scion Emblem, TECL · 12, Nonfoil",
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
  // The host wrapper rather than the band, because the band takes the hook's whole answer as a
  // prop — see {@link TokensBand}. The args are the deck and the disclosure, which is what a
  // story actually varies.
  component: TokensBand,
  subcomponents: { DeckTokensPanel },
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
          "**The list is derived on every open.** Each of the deck's distinct cards in an " +
          "*active* category is read for the tokens it makes; what is stored is only what the " +
          "reader chose — which printings, in which finish, how many of each, and whether the " +
          "token is on the wall at all. So a deck nobody has touched still has a full wall, one " +
          "tile per token, and a token that stops being made leaves it.\n\n" +
          "**A tile is an entry — one printing in one finish** (user schema v52). A Treasure kept " +
          "as a plain and a foil copy is two tiles, and **Add printing** in the header adds " +
          "another. The header also carries the deck's token mode, on every deck.\n\n" +
          "**The heading is “Tokens & Emblems” and never bare “Tokens”**, which the deck " +
          "editor already uses for an auto-category of cards that *make* tokens — the opposite " +
          "meaning of the same word.\n\n" +
          "**Emblems sort last.** An emblem is a one-off a deck may make once in a game; a pile " +
          "of Treasures is what a reader reaches for, so the things they touch sit where they " +
          "can be touched.",
      },
    },
  },
} satisfies Meta<typeof TokensBand>;

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
 * **Six, and the number is copies** (token stacks spec §3.1) — the stepper's figure summed over
 * every entry of the tokens the deck brings: four Treasures, no Constructs (zeroed on purpose),
 * one Wurm and Oko's emblem. The second Wurm is not in it, because it is dismissed and the number
 * is what the deck brings. It counted *distinct* tokens until then, and read 4 here.
 *
 * **The header's two controls are drawn while it is shut** — **Add printing**, which opens the
 * band as it is pressed, and the deck's token mode, which is a question about the deck rather
 * than about the wall.
 */
export const Collapsed: Story = {
  args: { open: false },
  play: async ({ canvas, args }) => {
    const disclosure = await canvas.findByRole("button", { name: TOKENS_HEADING });
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    // The pill: a bare `6` for the eye and the whole phrase for a screen reader.
    const words = await canvas.findByText(tokenCountWords(6));
    await expect(words).toHaveClass("sr-only");
    await expect(words.parentElement?.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      /^6$/,
    );

    // Nothing of the wall is mounted while it is shut — no picture, no tile, no stepper.
    await expect(canvas.queryByRole("button", { name: /^Change the art for / })).toBeNull();
    // …and neither is the dismissed switch, which is a control over a wall that is not there.
    await expect(canvas.queryByRole("button", { name: /^Show dismissed/ })).toBeNull();
    // The header's own two are.
    await expect(canvas.getByRole("button", { name: "Add printing" })).toBeInTheDocument();
    await expect(canvas.getByRole("group", { name: "Tokens" })).toBeInTheDocument();

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
 * * **Treasure** — a printing picked and a count changed: the entry the seed's override became
 *   at user schema v52, so the reset affordance has something to undo. Two of the deck's cards
 *   name it, from two different printings, which is the ordinary case rather than a corner:
 *   across 40 Treasure makers in the corpus, 12 distinct Treasure printings are referenced.
 * * **Construct** — a count of **0** on a token with no printing picked: its implicit entry, at
 *   the legacy quantity the reader stored. Zero is a value and not an absence — a token the
 *   reader has decided they need none of while keeping it on the list — and it is the exact state
 *   `stored || 1` reads as untouched and silently draws as 1.
 * * **Wurm** — untouched, and drawn with the subtitle that is the whole of what tells it from
 *   its twin. Its twin is dismissed and is one story down.
 * * **The emblem** — Oko's, untouched, sorted last, and with **no subtitle at all**: the tile's
 *   own name already says whose emblem it is, so a second line would repeat what it is drawing.
 *   The tile knows it is an emblem from its `layout` and never from its type line, which on this
 *   row is the bare word `Emblem`.
 *
 * **Every control names the printing and the finish as well as the token** — `TAFR · 15,
 * Nonfoil` — because one token can be several tiles; the foot under each picture draws the same
 * two facts for the eye. **Add printing** shows the next story what that looks like.
 */
export const Expanded: Story = {
  play: async ({ canvas }) => {
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    await within(region).findByRole("button", { name: `Change the art for ${ENTRY.treasure}` });

    // Emblems last, the rest by name — and the two Wurms are not both here, because one of them
    // is dismissed.
    await expect(tileNames(region)).toEqual([
      `Change the art for ${ENTRY.construct}`,
      `Change the art for ${ENTRY.treasure}`,
      `Change the art for ${ENTRY.wurmDeathtouch}`,
      `Change the art for ${ENTRY.oko}`,
    ]);

    // The three effective quantities, each arrived at a different way: stored, stored as zero,
    // and the floor a token nobody touched falls back to.
    await expect(
      within(region).getByRole("spinbutton", { name: `Quantity of ${ENTRY.treasure}` }),
    ).toHaveValue(4);
    await expect(
      within(region).getByRole("spinbutton", { name: `Quantity of ${ENTRY.construct}` }),
    ).toHaveValue(0);
    await expect(
      within(region).getByRole("spinbutton", { name: `Quantity of ${ENTRY.wurmDeathtouch}` }),
    ).toHaveValue(1);

    // Reset is drawn only where there is something to undo — the list holds the token's own
    // entries — which is what keeps it from being a control that spends most of a wall refusing.
    await expect(
      within(region).getByRole("button", { name: `Reset ${ENTRY.treasure}` }),
    ).toBeInTheDocument();
    await expect(
      within(region).queryByRole("button", { name: `Reset ${ENTRY.wurmDeathtouch}` }),
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
 * **The mode control is still here**, and that is the point of the header drawing on every deck:
 * how a deck keeps its tokens is a question about the deck, answerable before it makes its first
 * one. **Add printing is not** — there is no token to add a printing of.
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
    // No count either: a `0` pill beside a sentence saying so is the same fact twice.
    await expect(canvas.queryByText(tokenCountWords(0))).toBeNull();

    // The mode is answerable on a deck that makes nothing; adding a printing is not.
    await expect(canvas.getByRole("group", { name: "Tokens" })).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Add printing" })).toBeNull();
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
    await within(region).findByRole("button", { name: `Restore ${ENTRY.wurmLifelink}` });
    await expect(chip).toHaveAttribute("aria-pressed", "true");

    // Five tiles now, and the two same-named ones are adjacent — which is exactly the layout in
    // which one accessible name for both would be unusable.
    await expect(tileNames(region)).toEqual([
      `Change the art for ${ENTRY.construct}`,
      `Change the art for ${ENTRY.treasure}`,
      `Change the art for ${ENTRY.wurmDeathtouch}`,
      `Change the art for ${ENTRY.wurmLifelink}`,
      `Change the art for ${ENTRY.oko}`,
    ]);

    // The revealed one is the only tile offering to be restored; its twin still offers to be
    // dismissed, and the two are told apart by the same line.
    await expect(
      within(region).getByRole("button", { name: `Restore ${ENTRY.wurmLifelink}` }),
    ).toBeInTheDocument();
    await expect(
      within(region).getByRole("button", { name: `Dismiss ${ENTRY.wurmDeathtouch}` }),
    ).toBeInTheDocument();

    // Unmoved, and deliberately: a dismissal is not one of the tokens this deck brings — the
    // revealed Wurm's one copy is not in the six.
    await expect(within(region).getByText(tokenCountWords(6))).toBeInTheDocument();
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
  return <TokensBand deckId={1} variant="live" open onToggle={fn()} />;
}

export const Zoomed: Story = {
  render: () => <ZoomedBand />,
  parameters: { docs: { story: { inline: false, height: "520px" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    const tile = await within(region).findByRole("button", {
      name: `Change the art for ${ENTRY.treasure}`,
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

/**
 * **Add printing — a second Treasure, in foil, beside the first** (token stacks spec §4.6).
 *
 * The header's button opens the picker on every token the deck has, grouped by token behind a
 * search box that reads a token's name or a set code. Its grain is the printing **and** the
 * finish, so the Treasure the deck already keeps — `tafr` 15, plain — is offered again as a foil
 * tile with the sheen on its picture and the word in its foot.
 *
 * A pick is rule 5: that printing in that finish at one copy. The wall then holds **two tiles of
 * one token**, which is the case every accessible name on a tile now spells its printing and
 * finish for — the two share a name, a subtitle and a picture, and `Nonfoil` against `Foil` is the
 * whole of the difference. The count moves by the one copy added.
 */
export const AddPrinting: Story = {
  play: async ({ canvas, canvasElement }) => {
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    await within(region).findByRole("button", { name: `Change the art for ${ENTRY.treasure}` });

    await userEvent.click(canvas.getByRole("button", { name: "Add printing" }));

    // The dialog, wherever the shell mounts it — addressed from the document rather than the
    // canvas, so a portal would not make this story lie.
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Add a printing",
    });
    await userEvent.type(
      within(dialog).getByRole("searchbox", { name: /find a printing/i }),
      "tafr",
    );
    const foil = await within(dialog).findByRole("button", {
      name: "Treasure — TAFR · 15 · 2021, Foil, art by Dan Murayama Scott",
    });
    // The set code narrowed the wall to one printing, in both of its finishes.
    await expect(
      within(dialog)
        .getAllByRole("button", { name: / — / })
        .map((tile) => tile.getAttribute("aria-label")),
    ).toEqual([
      "Treasure — TAFR · 15 · 2021, Nonfoil, art by Dan Murayama Scott",
      "Treasure — TAFR · 15 · 2021, Foil, art by Dan Murayama Scott",
    ]);
    await expect(foil.querySelector("[data-foil-sheen]")).not.toBeNull();

    await userEvent.click(foil);

    const treasureFoil = `Treasure, ${SUBTITLE.treasure}, TAFR · 15, Foil`;
    await within(region).findByRole("button", { name: `Change the art for ${treasureFoil}` });
    // One token, two tiles, together — and every other tile where it was.
    await expect(tileNames(region)).toEqual([
      `Change the art for ${ENTRY.construct}`,
      `Change the art for ${ENTRY.treasure}`,
      `Change the art for ${treasureFoil}`,
      `Change the art for ${ENTRY.wurmDeathtouch}`,
      `Change the art for ${ENTRY.oko}`,
    ]);
    await expect(
      within(region).getByRole("spinbutton", { name: `Quantity of ${ENTRY.treasure}` }),
    ).toHaveValue(4);
    await expect(
      within(region).getByRole("spinbutton", { name: `Quantity of ${treasureFoil}` }),
    ).toHaveValue(1);
    await waitFor(async () => {
      await expect(within(region).getByText(tokenCountWords(7))).toBeInTheDocument();
    });
  },
};

/**
 * **A press on a picture swaps that entry** (rule 4) — and the picker marks the entry's own tile
 * current **by printing and finish**, so the plain `tafr` Treasure the deck keeps is pressed and
 * the foil tile over the same picture is not.
 *
 * The pick is the other printing in foil. The entry keeps its count — a swap changes which
 * cardboard, not how much of it — and the tile's every name says the new printing and finish.
 */
export const SwapOneEntry: Story = {
  play: async ({ canvas, canvasElement }) => {
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    await userEvent.click(
      await within(region).findByRole("button", { name: `Change the art for ${ENTRY.treasure}` }),
    );

    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Art for Treasure",
    });
    const current = await within(dialog).findByRole("button", {
      name: "Treasure — TAFR · 15 · 2021, Nonfoil, art by Dan Murayama Scott",
    });
    await expect(current).toHaveAttribute("aria-pressed", "true");
    await expect(
      within(dialog).getByRole("button", {
        name: "Treasure — TAFR · 15 · 2021, Foil, art by Dan Murayama Scott",
      }),
    ).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Treasure — THOB · 13 · 2026, Foil, art by Kamila Szutenberg",
      }),
    );

    const swapped = `Treasure, ${SUBTITLE.treasure}, THOB · 13, Foil`;
    await expect(
      await within(region).findByRole("spinbutton", { name: `Quantity of ${swapped}` }),
    ).toHaveValue(4);
    await expect(
      within(region).queryByRole("button", { name: `Change the art for ${ENTRY.treasure}` }),
    ).toBeNull();
  },
};

/**
 * **The mode, in the band's own header** — `Managed` or `Hide`, the same control Deck settings
 * draws, writing the same `decks.token_mode` through `deck.update`.
 *
 * `Hide` takes the token pile out of the deck's four views and **nothing out of this band**: the
 * wall and every stepper on it stay, because the mode decides the pile and never whether a token
 * can be kept. The third word, `Collection`, arrives with the custody it means in PR 3.
 */
export const ModeInTheHeader: Story = {
  play: async ({ canvas }) => {
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    const group = within(region).getByRole("group", { name: "Tokens" });
    await waitFor(async () => {
      await expect(within(group).getByRole("button", { name: "Managed" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    await expect(within(group).queryByRole("button", { name: /collection/i })).toBeNull();

    await userEvent.click(within(group).getByRole("button", { name: "Hide" }));

    await waitFor(async () => {
      await expect(within(group).getByRole("button", { name: "Hide" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    // The band keeps every token and every stepper in every mode.
    await expect(
      within(region).getByRole("spinbutton", { name: `Quantity of ${ENTRY.treasure}` }),
    ).toHaveValue(4);
  },
};
