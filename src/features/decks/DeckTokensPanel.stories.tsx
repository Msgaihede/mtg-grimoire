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
 * band as props.
 *
 * The band stopped calling the hook itself on 2026-09-24 (issue #507), because the deck views draw
 * the same tokens a second time, and the two drawings — and the one picker both open — have to
 * share one answer. So a story is the host's half as well as the band's, which is what keeps every
 * story below driven end to end by the fake rather than by a hand-built `DeckTokens`.
 */
function TokensBand({ deckId, variant, open, onToggle }: TokensBandProps): JSX.Element {
  const tokens = useDeckTokens(deckId, variant);
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
 * four, plain); the rest are implicit entries, drawn at the resolver's default printing in its
 * default finish — and **at 0**, which is every untouched token since managed tokens (spec §3.1).
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
 * category off and a maker stops making, cut the card and its token leaves. The reader's own
 * rows — an art, a count, a token added by hand — are the only ones the two token tables hold.
 *
 * **Which deck a story opens is the story's whole setup**, because the shapes of this panel are
 * shapes of deck rather than sets of props:
 *
 * * **Deck 1, `Modern Bolt`** — makes five. A Treasure two of its cards name, a Construct, the
 *   two same-named Wurms from a card in its *sideboard*, and an emblem. Its Maybeboard names a
 *   Treasure too and contributes nothing at all, which is what an inactive category means.
 * * **Deck 2** — makes two, and keeps a third **by hand**: Oko's emblem, which nothing in it
 *   makes, so its tile wears the destructive outline and `NOT MADE BY DECK`.
 * * **Deck 3, `Old School`** — makes nothing, and it is a real deck rather than an empty world:
 *   four Alpha cards, none of which names a token in the corpus.
 *
 * **`open` is the deck's own column** (`decks.tokens_open`), so it is an arg here and the press
 * is `onToggle` — the editor writes it back through `deck.update`, and a story is the half of
 * that pair without a database behind it.
 *
 * **The art is real art.** Every token here is an ordinary row of the generated corpus, so
 * `@/lib/images` has a picture for each and `card_printings` answers a grid for the art picker.
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
  // is given a column's width and nothing else. A tile is `stackCardWidth(cardZoom.deck)` —
  // 210px at 100% — so 60rem holds four of the tiles a deck makes, roughly what a real desk holds.
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
          "the deck stats — **every** one, at whatever count, where the deck's stacks draw only " +
          "the ones the reader has counted.\n\n" +
          "**An untouched token reads 0** (managed tokens, 2026-09-27): a token is something the " +
          "reader starts to use, so the band is where it is found and counted.\n\n" +
          "**A tile is an entry — one printing in one finish** (user schema v52). A Treasure kept " +
          "as a plain and a foil copy is two tiles; **Add printing** in the header adds another, " +
          "from the deck's own tokens or — with **All tokens** — from any token in the game; and " +
          "**Remove printing** on a tile takes that entry away.\n\n" +
          "**A token nothing in the deck makes is marked like a rule-break card**: a red outline " +
          "and `NOT MADE BY DECK` in the rule-break mark's corner.\n\n" +
          "**The heading is “Tokens & Emblems” and never bare “Tokens”**, which the deck " +
          "editor already uses for an auto-category of cards that *make* tokens — the opposite " +
          "meaning of the same word.\n\n" +
          "**Emblems sort last.** An emblem is a one-off a deck may make once in a game; a pile " +
          "of Treasures is what a reader reaches for.",
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
 * the reason to open the area at all. It costs one query against a corpus the app already has.
 *
 * **Four, and the number is copies** — the Treasures the reader counted; every other token the
 * deck makes is untouched and reads 0 (managed tokens spec §3.1).
 *
 * **Add printing is drawn while the band is shut**, and opens it as it is pressed. There is no
 * mode control in the header any more (spec §3.9), and no `Show dismissed` (§3.3).
 */
export const Collapsed: Story = {
  args: { open: false },
  play: async ({ canvas, args }) => {
    const disclosure = await canvas.findByRole("button", { name: TOKENS_HEADING });
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    // The pill: a bare `4` for the eye and the whole phrase for a screen reader.
    const words = await canvas.findByText(tokenCountWords(4));
    await expect(words).toHaveClass("sr-only");
    await expect(words.parentElement?.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      /^4$/,
    );

    // Nothing of the wall is mounted while it is shut — no picture, no tile, no stepper.
    await expect(canvas.queryByRole("button", { name: /^Change the art for / })).toBeNull();
    // The header's one control is; the mode control and the dismissed switch are gone.
    await expect(canvas.getByRole("button", { name: "Add printing" })).toBeInTheDocument();
    await expect(canvas.queryByRole("group", { name: "Tokens" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: /^Show dismissed/ })).toBeNull();

    // The press writes `decks.tokens_open`; the editor owns the write, so this is the whole of
    // what the panel does with it.
    await userEvent.click(disclosure);
    await expect(args.onToggle).toHaveBeenCalledWith(true);
  },
};

/**
 * Open, on the deck the seed builds for it — **every token the deck makes**, at whatever count.
 *
 * * **Treasure** — a printing picked and a count set: the one stored entry here, so the one tile
 *   with **Remove printing**. Two of the deck's cards name it, from two different printings.
 * * **Construct** — a legacy count of **0**, stored before v52 and still honoured.
 * * **The two Wurms** — untouched, both at 0, side by side and told apart only by the subtitle.
 *   The lifelink one is stored `hidden`, as an older peer's dismissal would sync in; nothing on
 *   this band reads the word any more, so it is drawn like its twin (Review Focus 1).
 * * **The emblem** — Oko's, untouched, sorted last, with **no subtitle at all**: the tile's own
 *   name already says whose emblem it is.
 *
 * Every token here is one the deck makes, so none wears `NOT MADE BY DECK`; the next story does.
 */
export const Expanded: Story = {
  play: async ({ canvas }) => {
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    await within(region).findByRole("button", { name: `Change the art for ${ENTRY.treasure}` });

    // Emblems last, the rest by name — both Wurms, the stored `hidden` one included.
    await expect(tileNames(region)).toEqual([
      `Change the art for ${ENTRY.construct}`,
      `Change the art for ${ENTRY.treasure}`,
      `Change the art for ${ENTRY.wurmDeathtouch}`,
      `Change the art for ${ENTRY.wurmLifelink}`,
      `Change the art for ${ENTRY.oko}`,
    ]);

    // The effective quantities: stored, stored as zero, and the untouched default.
    await expect(
      within(region).getByRole("spinbutton", { name: `Quantity of ${ENTRY.treasure}` }),
    ).toHaveValue(4);
    await expect(
      within(region).getByRole("spinbutton", { name: `Quantity of ${ENTRY.construct}` }),
    ).toHaveValue(0);
    await expect(
      within(region).getByRole("spinbutton", { name: `Quantity of ${ENTRY.wurmDeathtouch}` }),
    ).toHaveValue(0);

    // Remove printing on the stored entry, and on no implicit one.
    await expect(
      within(region).getByRole("button", { name: `Remove ${ENTRY.treasure}` }),
    ).toBeInTheDocument();
    await expect(
      within(region).queryByRole("button", { name: `Remove ${ENTRY.wurmDeathtouch}` }),
    ).toBeNull();
    // No dismiss, restore or reset anywhere on the wall.
    await expect(within(region).queryByRole("button", { name: /^(Dismiss|Restore|Reset) / })).toBeNull();
    await expect(within(region).queryByText("NOT MADE BY DECK")).toBeNull();

    // The subtitle is drawn as well as spoken, in an element of its own.
    await expect(within(region).getByText(SUBTITLE.wurmDeathtouch)).toBeInTheDocument();
    await expect(
      within(region).getByText("From Ragavan, Nimble Pilferer, Smuggler's Copter"),
    ).toBeInTheDocument();
  },
};

/**
 * **A token nothing in the deck makes, marked like a rule-break card** (managed tokens spec §3.5)
 * — deck 2 keeps Oko's emblem by hand and runs no Jace, so its tile wears the destructive outline
 * round the picture and its foot, and `NOT MADE BY DECK` in the rule-break mark's corner, its
 * reason one hover away. The badge is `aria-hidden`; the words are in the picture's own name.
 *
 * Its Remove printing is the one way to take it off the deck: the next story presses it.
 */
export const HandAddedToken: Story = {
  args: { deckId: 2 },
  play: async ({ canvas }) => {
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    const art = await within(region).findByRole("button", {
      name: `Change the art for ${ENTRY.oko}, not made by deck`,
    });
    const tile = art.closest("li");
    await expect(tile).not.toBeNull();
    await expect(within(tile as HTMLElement).getByText("NOT MADE BY DECK")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(art.parentElement?.classList.contains("ring-destructive")).toBe(true);
    await expect(within(tile as HTMLElement).getByText("Added by hand")).toBeInTheDocument();
    await expect(
      within(region).getByRole("button", { name: `Remove ${ENTRY.oko}` }),
    ).toBeInTheDocument();
    // The deck's own tokens beside it wear no mark.
    await expect(within(region).getAllByText("NOT MADE BY DECK")).toHaveLength(1);
  },
};

/**
 * **Remove printing takes a hand-added token off this list** (managed tokens spec §3.4). Deck 2's
 * emblem is kept in both lists, so its last live entry going leaves the live band — and only it:
 * the plan still holds its copy (Review Focus 3). A derived token's last entry would fall back to
 * its default printing at 0 instead, which is `RemoveFallsBack` below.
 */
export const RemoveHandAdded: Story = {
  args: { deckId: 2 },
  play: async ({ canvas }) => {
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    await userEvent.click(
      await within(region).findByRole("button", { name: `Remove ${ENTRY.oko}` }),
    );

    await waitFor(async () => {
      await expect(
        within(region).queryByRole("button", { name: /^Change the art for Oko/ }),
      ).toBeNull();
    });
    await expect(within(region).queryByText("NOT MADE BY DECK")).toBeNull();
  },
};

/**
 * **Remove printing on a derived token's only entry falls back to its default printing at 0** —
 * what Reset printings did, one entry at a time. Deck 1's Treasure was the `tafr` art at four; the
 * press leaves the printing its cards name (`thob`), untouched at 0 and with no Remove, since an
 * implicit entry is not stored.
 */
export const RemoveFallsBack: Story = {
  play: async ({ canvas }) => {
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    await userEvent.click(
      await within(region).findByRole("button", { name: `Remove ${ENTRY.treasure}` }),
    );

    const fallback = `Treasure, ${SUBTITLE.treasure}, THOB · 13, Nonfoil`;
    await expect(
      await within(region).findByRole("spinbutton", { name: `Quantity of ${fallback}` }),
    ).toHaveValue(0);
    await expect(within(region).queryByRole("button", { name: `Remove ${fallback}` })).toBeNull();
    await waitFor(async () => {
      await expect(within(region).getByText(tokenCountWords(0))).toBeInTheDocument();
    });
  },
};

/**
 * **A deck that makes nothing, and it is not an error.**
 *
 * Deck 3 is four Alpha cards, none of which names a token or an emblem in the corpus. So the
 * heading is set in type with no disclosure under it, and the sentence says which of the two
 * silences this is — "this deck makes nothing" is only written once the read has landed.
 *
 * **Add printing is still drawn** (fix round 1): a deck whose cards make nothing is the spec's
 * own case for a token added by hand, and the picker opens there on every token in the game —
 * {@link AddToADeckThatMakesNothing} presses it.
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
    await expect(canvas.getByRole("button", { name: "Add printing" })).toBeInTheDocument();
  },
};

/**
 * **Add printing on a deck that makes nothing opens on every token** (managed tokens spec §1.3,
 * §3.6; fix round 1). The picker comes up with `All tokens` already pressed — the deck has no token
 * of its own to offer — and a pick adds that token by hand: the band grows its first tile, marked
 * `NOT MADE BY DECK`, at one copy.
 */
export const AddToADeckThatMakesNothing: Story = {
  args: { deckId: 3 },
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByText("Nothing in this deck makes a token or an emblem.");
    await userEvent.click(canvas.getByRole("button", { name: "Add printing" }));

    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Add a printing",
    });
    await expect(within(dialog).getByRole("button", { name: "All tokens" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.type(
      within(dialog).getByRole("searchbox", { name: /find a printing/i }),
      "plst",
    );
    await userEvent.click(
      await within(dialog).findByRole("button", {
        name: /^Start Your Engines! \/\/ Max Speed — PLST · TDFT-14/,
      }),
    );

    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    const art = await within(region).findByRole("button", {
      name: /^Change the art for Start Your Engines! \/\/ Max Speed.*, not made by deck$/,
    });
    const tile = art.closest("li") as HTMLElement;
    await expect(within(tile).getByText("NOT MADE BY DECK")).toBeInTheDocument();
    await expect(within(tile).getByRole("spinbutton")).toHaveValue(1);
    await expect(canvas.queryByText("Nothing in this deck makes a token or an emblem.")).toBeNull();
  },
};

/**
 * **The wall at 150% of the desk's zoom, which is the whole of what a tile's size follows.**
 *
 * A tile is `stackCardWidth(cardZoom.deck)` — the stacked card's own width, read at the number
 * the reader set on the deck beside it — so the tokens a deck makes are drawn the size of the
 * cards that make them. **Everything on the tile moves with it**, through `cardScaleVars`.
 *
 * The store is set rather than mocked because `useCardZoomPersistence` is `AppShell`'s alone —
 * nothing in a story writes this row back.
 */
function ZoomedBand() {
  // **During render rather than in an effect, and in a frame of its own** — `DecksPage`'s
  // `ZoomedWall`, for both of its reasons (`.storybook/CLAUDE.md`).
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

    // The `<li>` carries the width, so the assertion climbs to it rather than reading the button.
    const item = tile.closest("li");
    await expect(item).not.toBeNull();
    await expect(item).toHaveStyle({ width: `${stackCardWidth(1.5)}px` });
    await expect(stackCardWidth(1.5)).toBeGreaterThan(STACK_CARD_WIDTH);
  },
};

/**
 * **Add printing — a second Treasure, in foil, beside the first** (token stacks spec §4.6).
 *
 * The header's button opens the picker on every token the deck has, grouped by token behind a
 * search box that reads a token's name or a set code. Its grain is the printing **and** the
 * finish, so the Treasure the deck already keeps — `tafr` 15, plain — is offered again as a foil
 * tile. A pick is rule 5: that printing in that finish at one copy.
 */
export const AddPrinting: Story = {
  play: async ({ canvas, canvasElement }) => {
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    await within(region).findByRole("button", { name: `Change the art for ${ENTRY.treasure}` });

    await userEvent.click(canvas.getByRole("button", { name: "Add printing" }));

    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Add a printing",
    });
    // `All tokens` is beside the box, off: the deck's own tokens are what the picker opens on.
    await expect(within(dialog).getByRole("button", { name: "All tokens" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await userEvent.type(
      within(dialog).getByRole("searchbox", { name: /find a printing/i }),
      "tafr",
    );
    const foil = await within(dialog).findByRole("button", {
      name: "Treasure — TAFR · 15 · 2021, Foil, art by Dan Murayama Scott",
    });
    await expect(
      within(dialog)
        .getAllByRole("button", { name: / — / })
        .map((tile) => tile.getAttribute("aria-label")),
    ).toEqual([
      "Treasure — TAFR · 15 · 2021, Nonfoil, art by Dan Murayama Scott",
      "Treasure — TAFR · 15 · 2021, Foil, art by Dan Murayama Scott",
    ]);

    await userEvent.click(foil);

    const treasureFoil = `Treasure, ${SUBTITLE.treasure}, TAFR · 15, Foil`;
    await within(region).findByRole("button", { name: `Change the art for ${treasureFoil}` });
    await expect(
      within(region).getByRole("spinbutton", { name: `Quantity of ${treasureFoil}` }),
    ).toHaveValue(1);
    await waitFor(async () => {
      await expect(within(region).getByText(tokenCountWords(5))).toBeInTheDocument();
    });
  },
};

/**
 * **Add printing → All tokens: a token the deck does not make, added by hand** (managed tokens
 * spec §3.6). The toggle swaps the deck's tokens for every token in the game — the corpus's double-
 * faced one here, which nothing in deck 1 makes — and a pick adds it at one copy as a hand-added
 * token, which the band then marks `NOT MADE BY DECK`.
 */
export const AllTokens: Story = {
  play: async ({ canvas, canvasElement }) => {
    const region = await canvas.findByRole("region", { name: TOKENS_HEADING });
    await within(region).findByRole("button", { name: `Change the art for ${ENTRY.treasure}` });

    await userEvent.click(canvas.getByRole("button", { name: "Add printing" }));
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Add a printing",
    });
    const toggle = within(dialog).getByRole("button", { name: "All tokens" });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.type(
      within(dialog).getByRole("searchbox", { name: /find a printing/i }),
      "plst",
    );
    const dft = await within(dialog).findByRole("button", {
      name: /^Start Your Engines! \/\/ Max Speed — PLST · TDFT-14/,
    });
    await userEvent.click(dft);

    const art = await within(region).findByRole("button", {
      name: /^Change the art for Start Your Engines! \/\/ Max Speed.*, not made by deck$/,
    });
    const tile = art.closest("li") as HTMLElement;
    await expect(within(tile).getByText("NOT MADE BY DECK")).toBeInTheDocument();
    await expect(within(tile).getByRole("spinbutton")).toHaveValue(1);
  },
};

/**
 * **A press on a picture swaps that entry** (rule 4) — and the picker marks the entry's own tile
 * current **by printing and finish**, so the plain `tafr` Treasure the deck keeps is pressed and
 * the foil tile over the same picture is not. The entry keeps its count.
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
    // A swap is about one token's printings, so there is nothing for `All tokens` to widen.
    await expect(within(dialog).queryByRole("button", { name: "All tokens" })).toBeNull();

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
