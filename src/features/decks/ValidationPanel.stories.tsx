import type { RefObject } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { DeckCard } from "@/lib/ipc";
import { deckCard, MISSING, orphanDeckCard, printing } from "../../../.storybook/fake/fixtures";
import { SPECS } from "./validation/fixtures";
import { ValidationPanel } from "./ValidationPanel";

/* Every card fact in every deck below comes off a corpus printing, through the two builders
   imported above rather than written out here, and that is the whole discipline of this file:
   the engine's verdict is only worth rendering if the facts it read are the ones the database
   holds. The one field written by hand is `legalities` in `UnknownLegality`, which is a
   deliberate data fault and says so. */

/**
 * The chip's ref, one per story.
 *
 * `DeckEditor` owns this ref in the app; a story has no editor, so it hands over a bare ref
 * object. **Per story rather than one shared object**, because a docs page mounts every story at
 * once and they would all write into it — the last chip to mount would win, and pressing a card
 * name in one story would move the caret to a different story's chip halfway down the page.
 */
function chipRef(): RefObject<HTMLButtonElement | null> {
  return { current: null };
}

/**
 * Pad the size-counting zones out to `total` with one Alpha Island row.
 *
 * `validation/fixtures.ts`'s `padTo` does the same job for the engine's own tests; this one pads
 * with a **corpus printing** so that every card in every deck below is one the database really
 * holds. It is one row carrying the whole balance rather than 88 rows of one copy, and that is a
 * fixture convenience with a reason: the corpus is 43 printings, a 100-card singleton deck cannot
 * be built out of it, and this panel renders sentences rather than rows — nothing on screen
 * counts how many rows the padding took.
 *
 * Islands are safe padding in a way no other card is. Basic lands are exempt from every copy
 * limit (CR 100.2a, `singleton.isBasicLand`), so the padding never manufactures a copy-limit or
 * singleton finding; `lea 288` is `legal` in all ten legality keys these stories judge against
 * (measured over `.storybook/fake/cards.ts`, 2026-08-09), so it never manufactures a pool
 * finding; and its colour identity is `U`, which every commander below covers.
 */
function padWithIslands(total: number, cards: DeckCard[]): DeckCard[] {
  const counted = cards
    .filter((c) => c.zone === "main" || c.zone === "commander")
    .reduce((n, c) => n + c.quantity, 0);
  return counted < total
    ? [...cards, deckCard(printing("lea", "288"), { quantity: total - counted })]
    : cards;
}

/**
 * Twenty-eight copies of seven Modern-legal printings — the spell half of a deck that breaks no
 * rule, so a story about one broken rule is about exactly that rule.
 *
 * Four of each, which is Modern's `maxCopies`, so any story that adds a fifth copy of one of
 * these is over the limit by exactly one card.
 */
const MODERN_SPELLS: DeckCard[] = [
  deckCard(printing("mh2", "138"), { quantity: 4 }),
  deckCard(printing("isd", "51"), { quantity: 4 }),
  deckCard(printing("fut", "153"), { quantity: 4 }),
  deckCard(printing("lea", "161"), { quantity: 4 }),
  deckCard(printing("mh2", "267"), { quantity: 4 }),
  deckCard(printing("nph", "57"), { quantity: 4 }),
  deckCard(printing("mh2", "259"), { quantity: 4 }),
];

/** Those twenty-eight, padded to Modern's minimum of 60. */
const MODERN_MAIN = padWithIslands(60, MODERN_SPELLS);

/**
 * A sideboard of `n` cards, from four Modern-legal printings that appear in no main deck here —
 * so a sideboard-size story is never also a copy-limit story (CR 100.4a counts a sideboard's
 * copies toward the same four, and `engine.COPY_ZONES` says so).
 */
function modernSide(n: number): DeckCard[] {
  return [
    deckCard(printing("gtc", "215"), { zone: "side", quantity: 4 }),
    deckCard(printing("dom", "168"), { zone: "side", quantity: 4 }),
    deckCard(printing("apc", "128"), { zone: "side", quantity: 4 }),
    deckCard(printing("gtc", "148"), { zone: "side", quantity: n - 12 }),
  ];
}

/**
 * Kenrith, the Returned King in the command zone.
 *
 * The same choice `validation/fixtures.ts`'s `commander()` makes, for the same reason: his five
 * activated abilities put all five colours in his colour identity (`BGRUW` in the fixture), so a
 * story about copy limits or deck size is never also a story about CR 903.5c.
 */
const kenrith = () => deckCard(printing("eld", "303"), { zone: "commander" });

/**
 * Eleven singles inside Kenrith's identity — the 99 minus its lands.
 *
 * Every one is `legal` under **both** the `commander` and the `duel` keys, and every colour on
 * them is inside `BGRUW`, so a deck built from these plus {@link padWithIslands} and Kenrith
 * produces **no findings at all** in either format. That is what makes it a base: each story
 * below changes one thing.
 *
 * Sol Ring is the conspicuous absence and the reason the list is Duel-clean: it is
 * `duel: banned`, which would have made {@link RestrictedBannedAsCommander} a story about a ban
 * list. {@link Singleton} adds its two printings back where they belong.
 */
const commanderSingles = (): DeckCard[] => [
  deckCard(printing("mh2", "267")),
  deckCard(printing("ema", "32")),
  deckCard(printing("dom", "168")),
  deckCard(printing("fut", "153")),
  deckCard(printing("isd", "51")),
  deckCard(printing("lea", "161")),
  deckCard(printing("gtc", "148")),
  deckCard(printing("gtc", "215")),
  deckCard(printing("nph", "57")),
  deckCard(printing("kld", "235")),
  deckCard(printing("mh2", "259")),
];

const meta = {
  title: "Decks/ValidationPanel",
  component: ValidationPanel,
  tags: ["autodocs"],
  args: {
    open: true,
    onOpen: fn(),
    onDismiss: fn(),
    onClose: fn(),
    onSelectCard: fn(),
  },
  // Room for the popup, which is anchored `absolute left-0 top-11 w-80` under the chip rather
  // than portalled — the shipped CSP is `style-src 'self'` and every overlay primitive in reach
  // injects a runtime `<style>` the moment it opens.
  decorators: [
    (Story) => (
      <div className="h-[34rem] w-[24rem] p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "What the rules make of this deck, behind one chip. **Advisory, never blocking** — " +
          "nothing here refuses a write or stops a deck being saved, because an illegal deck is " +
          "a deck somebody is still building.\n\n" +
          "**Every deck below is built from real printings in `.storybook/fake/cards` and run " +
          "through the real engine in `src/features/decks/validation/`.** Not one " +
          "`ValidationIssue` is written by hand. A hand-written issue list is a claim about what " +
          "the engine says, and the panel's whole job is to render what it actually says — the " +
          "two drift apart silently, and the story would keep passing while the app went wrong. " +
          "Where a deck did not produce the finding it was built for, the deck changed and the " +
          "expectation did not.\n\n" +
          "The format rows come from `validation/fixtures.ts`'s `SPECS`, which is Task 8's " +
          "cell-for-cell mirror of `schema.rs`'s `FORMAT_SPECS_SEED`. A second copy of that " +
          "table here would be a second place for a rules cell to drift.\n\n" +
          "The sentences are the engine's, **verbatim**: the panel only groups them by `code` " +
          "and finds the card names inside them so the reader can press one.\n\n" +
          "**Four things the engine can say have no deck here**, because neither the 43-printing " +
          "corpus nor any seeded format can produce them: the plain “at most N cards” " +
          "size sentence, the “up to N copies by its own text” copy sentence, " +
          "`unknown-copy-limit`, and `commander-banned`. Each is named, with what was measured " +
          "and what would close it, in the story that would have carried it — `DeckTooLarge`, " +
          "`CopyLimit` and `RestrictedBannedAsCommander`.",
      },
    },
  },
} satisfies Meta<typeof ValidationPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A deck with nothing wrong with it: 60 Modern-legal cards and a 15-card sideboard.
 *
 * The chip carries the format's name when there is nothing to count — "No issues · Modern" — and
 * the panel behind it says so in a whole sentence rather than showing an empty list. An empty
 * list is indistinguishable from a list that failed to render.
 *
 * Modern rather than a commander format, because the commander formats also draw the bracket
 * advisory below the findings and this story is about the absence of findings. {@link
 * BracketEstimate} is the legal deck that draws one.
 */
export const Legal: Story = {
  args: { cards: [...MODERN_MAIN, ...modernSide(15)], spec: SPECS.modern, buttonRef: chipRef() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "No issues · Modern" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // The panel is a `dialog` named for the format, and deliberately **not** `aria-modal`: the
    // editor behind it stays live, which is the point — a reader fixes the deck while reading
    // what is wrong with it. A modal here would be a layer that has to be dismissed before the
    // thing it is talking about can be touched.
    const panel = canvas.getByRole("dialog", { name: "Modern check" });
    await expect(panel).not.toHaveAttribute("aria-modal");
    await expect(panel).toHaveTextContent(
      "Nothing to fix. This deck matches every Modern rule this app can check.",
    );
  },
};

/**
 * Forty cards where the format asks for sixty.
 *
 * `deckMin` is read off the seeded row and the sentence quotes it, so a rules change is an
 * UPDATE rather than a release. The number it counts is `engine.SIZE_ZONES` — main plus
 * commander — which is the same definition the stats strip's headline "Cards" figure imports,
 * because "Modern decks need at least 60 cards; you have 59" under a figure reading 74 would be
 * two numbers for one question.
 */
export const DeckTooSmall: Story = {
  args: { cards: padWithIslands(40, MODERN_SPELLS), spec: SPECS.modern, buttonRef: chipRef() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("dialog", { name: "Modern check" });
    await expect(panel).toHaveTextContent("Modern decks need at least 60 cards; you have 40.");
    // **No card is pressable in this sentence, and that is the rule rather than an oversight.**
    // A finding about the deck itself carries no `cardIds` (`validation/types.ts` says so of the
    // size and sideboard codes): highlighting sixty rows says nothing the sentence did not. The
    // claim is invisible — a sentence with no buttons looks exactly like a sentence whose
    // buttons failed to render.
    await expect(within(panel).queryAllByRole("button")).toHaveLength(0);
  },
};

/**
 * One card over the top, in the only shape a seeded format can be over it.
 *
 * **The engine's plain "decks are at most N cards" sentence (`engine.ts:254`) has no story,
 * because no seeded format can reach it.** It needs `deckMax` non-null and different from
 * `deckMin`, and all nine rows of `FORMAT_SPECS_SEED` that set a maximum set it *equal* to the
 * minimum — Commander 100/100, Oathbreaker 60/60, Standard Brawl, Brawl, Competitive Brawl,
 * Pauper Commander, Duel Commander, PreDH and Tiny Leaders: Reborn
 * (`src-tauri/src/schema.rs:264-275`, read 2026-08-09). So every real format that has a ceiling
 * is *exactly* sized, and
 * `engine.ts:237` answers both directions in one sentence: the same wording says too small and
 * too large, and names the commander as part of the count. `engine.test.ts:80` reaches the other
 * branch with a spec built for the purpose, which is the right place for it.
 */
export const DeckTooLarge: Story = {
  args: {
    cards: padWithIslands(101, [kenrith(), ...commanderSingles()]),
    spec: SPECS.commander,
    buttonRef: chipRef(),
  },
};

/**
 * Sixteen cards where fifteen are allowed.
 *
 * The cap is a cell (`sideboardMax`), and `0` in it is a different sentence rather than a smaller
 * number: the singleton commander formats have **no sideboard at all**, so they get "Commander
 * decks have no sideboard." A companion occupies a sideboard slot only where there is a
 * sideboard for it to sit in, which is read from the same cell — that is how Commander, the
 * Brawls, Oathbreaker, PDH, Duel, PreDH and Gladiator all come out right together with no format
 * key compared anywhere.
 */
export const SideboardTooLarge: Story = {
  args: { cards: [...MODERN_MAIN, ...modernSide(16)], spec: SPECS.modern, buttonRef: chipRef() },
};

/**
 * Five Lightning Bolts, as **two printings** — four Alpha and one Double Masters 2022.
 *
 * Copies are grouped by `oracleId`, so two printings of one card are five copies of one card and
 * not four of one plus one of another. The sentence names the card, and the issue's `cardIds`
 * names both rows, so pressing the name in the panel reaches the deck.
 *
 * **The engine's other copy-limit sentence — "allows up to N copies by its own text"
 * (`engine.ts:354`) — has no story, and neither does `unknown-copy-limit`.** Both need a card
 * printing the clause `singleton.ts` parses (`"A deck can have any number of cards named"` or
 * `"A deck can have up to"`), and the string `"A deck can have"` appears **0 times** in
 * `.storybook/fake/cards.ts` (grepped 2026-08-09). Relentless Rats, Seven Dwarves and Nazgûl are
 * simply not among the 43 printings; `engine.test.ts:214-240` covers both branches instead.
 */
export const CopyLimit: Story = {
  args: {
    cards: padWithIslands(60, [...MODERN_SPELLS, deckCard(printing("2x2", "117"))]),
    spec: SPECS.modern,
    buttonRef: chipRef(),
  },
};

/**
 * Two Sol Rings in a singleton format — again as two printings, a Commander 2021 and a Secret
 * Lair Drop.
 *
 * `singleton` and `copy-limit` are two codes for what looks like one rule, and the split is
 * worth the second code: "max 1 copy of Sol Ring" is a *format identity* — CR 903.5b, every card
 * in the deck has a different English name — while a limit of four is an arithmetic ceiling.
 * They group under different headings and read as different problems, which is what they are.
 *
 * The commander zone counts toward the same total (`engine.COPY_ZONES`), because CR 903.5a puts
 * the commander among the hundred: a card held as commander *and* in the 99 is two copies of it.
 */
export const Singleton: Story = {
  args: {
    cards: padWithIslands(100, [
      kenrith(),
      ...commanderSingles(),
      deckCard(printing("c21", "263")),
      deckCard(printing("sld", "913")),
    ]),
    spec: SPECS.commander,
    buttonRef: chipRef(),
  },
};

/**
 * Two Ancestral Recalls in Vintage — where `"restricted"` means **max one copy**.
 *
 * This is half of TRAP A. The word is a property of the *format*, not of the card:
 * `restrictedSemantic` is what decides, and Vintage's is `max_one`. The other half is
 * {@link RestrictedBannedAsCommander}, where the identical Scryfall string means something else
 * entirely — and the engine never infers either meaning from the format key.
 *
 * The corpus has four Vintage-restricted cards across seven printings — Black Lotus (`lea 232`,
 * `vma 4`), Ancestral Recall (`lea 47`, `2ed 48`), Urza's Saga (`mh2 259`) and Sol Ring
 * (`c21 263`, `sld 913`) — measured over `.storybook/fake/cards.ts` on 2026-08-09, where
 * `"vintage":"restricted"` appears exactly 7 times.
 */
export const RestrictedMaxOne: Story = {
  args: {
    cards: padWithIslands(60, [
      deckCard(printing("2ed", "48"), { quantity: 2 }),
      deckCard(printing("lea", "161"), { quantity: 4 }),
      deckCard(printing("mh2", "267"), { quantity: 4 }),
      deckCard(printing("isd", "51"), { quantity: 4 }),
      deckCard(printing("fut", "153"), { quantity: 4 }),
    ]),
    spec: SPECS.vintage,
    buttonRef: chipRef(),
  },
};

/**
 * TRAP A's other half, and **it has no deck**: nothing in the corpus can produce it.
 *
 * In Duel Commander and Tiny Leaders: Reborn, Scryfall's `"restricted"` means *banned as a
 * commander* — a max-one reading would be no restriction at all in a format that is already
 * singleton — and `commanders.ts:822` reports it, in the commander zone only. Producing it needs
 * a printing whose `legalities` blob says `"duel": "restricted"` or `"tlr": "restricted"`, **and
 * the 43-printing corpus holds none**. Measured 2026-08-09 over `.storybook/fake/cards.ts`: the
 * `duel` key is `banned` on 9 printings, `legal` on 30 and `not_legal` on 4; the `tlr` key is
 * `legal` on 31 and `not_legal` on 12. Neither key takes the value `restricted` anywhere in the
 * file.
 *
 * The one thing that would have made a story out of it — overriding a real card's blob — is
 * exactly the fake this file exists to refuse. "Ragavan is banned as a commander in Duel
 * Commander" is a false sentence about a real card, and a reader has no way to tell it from a
 * true one. `commanders.test.ts` covers the rule with fixtures that name nobody; the honest
 * answer here is a story that renders the deck it could build and says what is missing, which is
 * the Duel Commander deck below — **legal**, and therefore silent about the one thing this story
 * was meant to show.
 *
 * Closing this needs a corpus regeneration (`scripts/gen-storybook-cards.mjs`) that deliberately
 * picks up a duel-restricted printing — a change to a fixture **seven other story files** read
 * (grepped 2026-08-09: `CardImage`, `VirtualTable`, `PrintingPreview`, `CollectionSummary`,
 * `CollectionTable`, `ZoneColumn` and `CardGrid`).
 */
export const RestrictedBannedAsCommander: Story = {
  args: {
    cards: padWithIslands(100, [kenrith(), ...commanderSingles()]),
    spec: SPECS.duel,
    buttonRef: chipRef(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The deck is Duel Commander legal, which is the finding: the corpus cannot break this rule.
    // Asserted rather than described, so that a future regeneration which *does* pick up a
    // duel-restricted printing fails here and sends someone back to this comment.
    await expect(
      canvas.getByRole("button", { name: "No issues · Duel Commander" }),
    ).toBeInTheDocument();
  },
};

/**
 * A card on the format's ban list.
 *
 * Lurrus of the Dream-Den is `banned` in Modern and legal in Vintage, and the panel does not know
 * either fact — it reads the card's own `legalities` blob, which is 23 keys wide and grows with
 * the formats. {@link CompanionCondition} plays the same card in the format that allows it.
 *
 * A ban is an `error` and reads as one: a 2px destructive edge down the left of the sentence,
 * never a tinted panel. This list refuses nothing, and a red surface would make a deck somebody
 * is still building look broken.
 */
export const Banned: Story = {
  args: {
    cards: padWithIslands(60, [...MODERN_SPELLS, deckCard(printing("iko", "226"))]),
    spec: SPECS.modern,
    buttonRef: chipRef(),
  },
};

/**
 * The same card in two printings, and **only one of them is legal**.
 *
 * Old School is the one printing-sensitive legality key in Magic, and it comes out right here
 * with no special case at all: each `DeckCard` carries its own printing's `legalities`, so the
 * Alpha Lightning Bolt reads `legal` and the Double Masters 2022 one reads `not_legal`, and the
 * engine draws one conclusion per row. Two copies of each, so the deck is at four and the copy
 * limit is not also in play.
 *
 * A key that does not mention a card at all is treated the same way as `not_legal` — a list that
 * does not contain a card is a pool that does not contain it — with one exemption, TRAP C:
 * Pauper Commander's key answers for the commons of the 99, so a `not_legal` there says nothing
 * about the card in the commander zone and is suppressed (`engine.ts:518`).
 */
export const NotLegal: Story = {
  args: {
    cards: padWithIslands(60, [
      deckCard(printing("lea", "161"), { quantity: 2 }),
      deckCard(printing("2x2", "117"), { quantity: 2 }),
    ]),
    spec: SPECS.oldschool,
    buttonRef: chipRef(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("dialog", { name: "Old School check" });
    await expect(panel).toHaveTextContent("Lightning Bolt is not legal in Old School.");
    // **One button, and it opens the printing that is actually illegal.** Both rows are called
    // Lightning Bolt, so the visible sentence looks identical whichever row produced it; the
    // issue's `cardIds` is what makes the difference, and it holds the 2x2 printing alone. This
    // is the whole of "each row carries its own printing's answer", and nothing about it is
    // visible on screen.
    const named = within(panel).getAllByRole("button", { name: "Lightning Bolt" });
    await expect(named).toHaveLength(1);
    await userEvent.click(named[0]);
    await expect(args.onSelectCard).toHaveBeenCalledWith(printing("2x2", "117").id);
  },
};

/**
 * A row whose `legalities` blob cannot be parsed — **the one deck on this page with a fact
 * written by hand, and it is a data fault rather than a claim about a card**.
 *
 * The blob here is a truncated `{"modern":"leg`, which is what a half-written row looks like. The
 * engine's answer is a *warning* and it is carefully worded: "could not be read" is a statement
 * about the row, not about Ragavan — a validator that guessed `legal` or `not_legal` from a blob
 * it could not parse would be inventing the one fact it was asked for. The same warning covers a
 * status string the app does not know (`engine.ts:486-493`), which today no Scryfall key
 * produces.
 *
 * The alternative was to leave the branch unstoried. It is the only finding in the file whose
 * cause is corrupt data rather than a deck, so there is no printing that can produce it and no
 * deck that can be built to; every other story here changes the *deck* and never the facts.
 */
export const UnknownLegality: Story = {
  args: {
    cards: padWithIslands(60, [
      ...MODERN_SPELLS.slice(1),
      deckCard(printing("mh2", "138"), { quantity: 4, legalities: '{"modern":"leg' }),
    ]),
    spec: SPECS.modern,
    buttonRef: chipRef(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("dialog", { name: "Modern check" });
    await expect(panel).toHaveTextContent(
      "Ragavan, Nimble Pilferer's Modern legality could not be read.",
    );
    // **Severity is never carried by the colour alone.** A rule broken and a fact worth a look
    // differ by a 2px edge, which is nothing at all to a screen reader — so every sentence is
    // announced with its severity first. This is a `warning`, and the word is `sr-only`: the one
    // claim on this page that no screenshot can settle.
    await expect(within(panel).getByText("Warning:")).toBeInTheDocument();
    await expect(within(panel).queryByText("Error:")).toBeNull();
  },
};

/**
 * Tiny Leaders: Reborn caps every card at mana value 3, and Fire // Ice is a 4.
 *
 * `maxManaValue` is the cell, and `tlr` is the only seeded row that sets one — 3, at
 * `validation/fixtures.ts:201`. The rule reads **every face** as well as the card, because Scryfall's
 * top-level `cmc` is the front face's and an adventure or a modal double-faced card can hide a
 * face above the ceiling behind a legal number. Fire // Ice is the opposite case and worth having
 * for it: CR 202.3d sums a split card's halves, so its `cmc` is 4 while each half is 2, and the
 * sentence quotes the card's own number rather than a face's.
 *
 * **This deck produces two findings, and the second one cannot be removed.** Fire // Ice's colour
 * identity is `UR`, and it is the *only* `tlr`-legal printing in the corpus above mana value 3 —
 * measured 2026-08-09 over all 43 rows: every other card above 3 (Bruna, Avacyn, Elesh Norn,
 * Consecrated Sphinx, Emrakul, Jace, Kenrith, Restart Sequence, Kozilek Compleated) is
 * `tlr: not_legal`, which would replace the mana-value finding with a pool finding. Meanwhile a
 * 50-card singleton deck can only be padded with basics, and the corpus holds two — Island (`U`)
 * and Forest (`G`) — so the commander's identity must contain `U` or `G`, and no `tlr`-legal
 * corpus legend covers `R` as well: the four are Ragavan (`R`), Tymna (`BW`), Thrasios (`UG`) and
 * Lurrus (`BW`), and the only partner pair among them unions to `WUBG`. Thrasios is the closest,
 * and the `R` in Fire // Ice falls outside him. The colour-identity sentence below is that gap,
 * not a second subject.
 */
export const ManaValueCap: Story = {
  args: {
    cards: padWithIslands(50, [
      deckCard(printing("fca", "58"), { zone: "commander" }),
      deckCard(printing("apc", "128")),
    ]),
    spec: SPECS.tlr,
    buttonRef: chipRef(),
  },
};

/**
 * A commander format with an empty command zone.
 *
 * The zone is checked for **every** format, including the ones that have none: a card parked in
 * the commander zone of a Modern deck counts toward that deck's size, so it is a card in the
 * wrong pile rather than a card nobody mentions. Here the opposite — the deck is the right size
 * and the zone is empty — and the sentence says which of the two problems it is.
 *
 * With no commander there is no colour identity to judge the rest of the deck against, and that
 * is a distinction the engine keeps: `commanderIdentity` answers `null` for an empty zone, while
 * an empty *set* is a real answer that admits only colourless cards. Conflating them would report
 * every coloured card in the deck for a commander the user has not chosen yet.
 */
export const CommanderMissing: Story = {
  args: {
    cards: padWithIslands(100, commanderSingles()),
    spec: SPECS.commander,
    buttonRef: chipRef(),
  },
};

/**
 * Three commanders: Kenrith, Tymna the Weaver and Thrasios, Triton Hero.
 *
 * CR 702.124g caps the zone at two, and only through a partner ability. Each of the three is a
 * perfectly legal commander on its own — that is the point of choosing three real ones — so the
 * only finding is the count.
 *
 * Pairing is checked at exactly two cards and not at three, which is why this deck reports the
 * count alone: with three in the zone there is no pair to judge, and a sentence about which two
 * of three were meant to partner would be a guess.
 */
export const CommanderCount: Story = {
  args: {
    cards: padWithIslands(100, [
      kenrith(),
      deckCard(printing("fca", "18"), { zone: "commander" }),
      deckCard(printing("fca", "58"), { zone: "commander" }),
      ...commanderSingles(),
    ]),
    spec: SPECS.commander,
    buttonRef: chipRef(),
  },
};

/**
 * Jace, the Mind Sculptor in the command zone of a Commander deck.
 *
 * CR 903.3 admits a legendary creature, a legendary Vehicle or Spacecraft **with a power and
 * toughness** (the 2026 wording, and the reason `cards` grew `power`/`toughness` columns in
 * schema v5), or a card whose own text says it can be your commander. A legendary planeswalker
 * is none of those in EDH — Brawl and Tiny Leaders take one, which is why eligibility is keyed on
 * `commanderRule` and never on a format key. The refusal names what *would* have worked, because
 * a rule quoted back is the only useful half of a no.
 *
 * The 99 here are mono-blue and colourless, so Jace's `U` identity admits every one of them and
 * the eligibility sentence stands alone.
 */
export const CommanderEligibility: Story = {
  args: {
    cards: padWithIslands(100, [
      deckCard(printing("wwk", "31"), { zone: "commander" }),
      deckCard(printing("mh2", "267")),
      deckCard(printing("isd", "51")),
      deckCard(printing("c21", "263")),
      deckCard(printing("mh2", "259")),
    ]),
    spec: SPECS.commander,
    buttonRef: chipRef(),
  },
};

/**
 * Two commanders, one partner ability between them.
 *
 * Tymna the Weaver prints plain `Partner`; Kenrith prints nothing of the kind. CR 702.124 is
 * where two commanders come from, and the sentence names which side is missing the ability rather
 * than reporting the pair as jointly wrong — there is one card to change here, and the reader
 * should not have to work out which.
 *
 * The pattern is line-anchored, and that is load-bearing rather than tidy: `Partner with Amy
 * Pond` begins with the word `Partner`, so a bare substring test would pair it with anything.
 */
export const CommanderPartner: Story = {
  args: {
    cards: padWithIslands(100, [
      kenrith(),
      deckCard(printing("fca", "18"), { zone: "commander" }),
      ...commanderSingles(),
    ]),
    spec: SPECS.commander,
    buttonRef: chipRef(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("dialog", { name: "Commander check" });
    // **Both commanders are reachable from the one sentence.** A pairing failure carries every
    // card id in the zone, and `messageParts` splits the engine's sentence at the names it
    // already contains — nothing is added, reordered or reworded, so the parts concatenate back
    // to the message exactly. Two names in the sentence, two buttons; that the second one is a
    // button and not prose is invisible in a screenshot.
    await expect(
      within(panel).getByRole("button", { name: "Tymna the Weaver" }),
    ).toBeInTheDocument();
    await expect(
      within(panel).getByRole("button", { name: "Kenrith, the Returned King" }),
    ).toBeInTheDocument();
  },
};

/**
 * A red card under a `UG` commander.
 *
 * CR 903.5c: every card in the deck must have a colour identity inside the commander's. 903.5d —
 * "a land with a basic land type is inside the identity of every colour that type produces" —
 * needs no rule of its own, because Scryfall's `color_identity` has already folded land types,
 * DFC backs, adventures, colour indicators and reminder-text exclusion in. The Islands padding
 * this deck out answer `U` and pass without a land-specific line of code anywhere.
 *
 * `colorIdentity` is **concatenated letters** (`"UG"`), never JSON — `JSON.parse` throws on it —
 * and the message reads an identity back in WUBRG order with a word for the empty set.
 */
export const ColorIdentity: Story = {
  args: {
    cards: padWithIslands(100, [
      deckCard(printing("fca", "58"), { zone: "commander" }),
      deckCard(printing("mh2", "267")),
      deckCard(printing("isd", "51")),
      deckCard(printing("fut", "153")),
      deckCard(printing("dom", "168")),
      deckCard(printing("c21", "263")),
      deckCard(printing("mh2", "259")),
      deckCard(printing("lea", "161")),
    ]),
    spec: SPECS.commander,
    buttonRef: chipRef(),
  },
};

/**
 * Lurrus of the Dream-Den as a companion, over a deck it does not fit.
 *
 * Ten companions, ten deck-shape predicates, keyed by **printed name** rather than by parsing the
 * printed condition — ten cards printed once each whose conditions are English sentences a parser
 * would read wrongly and silently. Lurrus asks that every permanent card in the starting deck
 * have mana value 2 or less; Rhystic Study is an Enchantment at 3, and it is the only offender
 * here.
 *
 * The starting deck is `main` + `commander` and **never the sideboard** — a companion's condition
 * is about the deck you begin the game with. Vintage rather than Modern because Lurrus is banned
 * in Modern, and a story about a companion condition should not also be a story about a ban list;
 * a legality is the engine's ordinary check and reads the card's own blob either way.
 *
 * **A companion deck that satisfies its condition is not buildable from this corpus, in any
 * format.** Lurrus is the only card in it that prints a `"Companion —"` line at all (grepped
 * 2026-08-09: one occurrence, `cards.ts:1137`). In a commander format the commander is part of
 * the starting deck (CR 903.5a), so it would have to be a permanent at mana value 2 or less
 * whose identity covers `W` and `B` — and the only corpus legends at 2 or less are Ragavan
 * (`R`, 1) and Thrasios (`UG`, 2). `.storybook/fake/seeds.ts`'s seeded deck 2 stages exactly that
 * dead end and says so in its own comment: Kenrith commands, Kenrith is a mana-value-5 permanent,
 * and the deck reports one companion-condition error naming him. Vintage sidesteps the commander
 * entirely, so this story's one offender is a card the reader put in the deck on purpose.
 */
export const CompanionCondition: Story = {
  args: {
    cards: padWithIslands(60, [
      deckCard(printing("iko", "226"), { zone: "companion" }),
      deckCard(printing("c21", "263")),
      deckCard(printing("mh2", "138")),
      deckCard(printing("fut", "153")),
      deckCard(printing("isd", "51")),
      deckCard(printing("kld", "235")),
      deckCard(printing("pcy", "45")),
      deckCard(printing("lea", "161"), { quantity: 4 }),
    ]),
    spec: SPECS.vintage,
    buttonRef: chipRef(),
  },
};

/**
 * A row whose printing has left the card database.
 *
 * It is a **warning**, not an error: the row is not illegal, it is unjudgeable. The engine says
 * so in the reconciler's own words rather than composing a second explanation — `${name}:
 * ${needsReview}` — and it still counts the card toward the deck's size, because it is a card in
 * the deck. A `needs_review` sentence means "listed, counted, and asking to be looked at", never
 * "hidden".
 *
 * The row is left out of every check that needs facts it does not have: no legality guess, no
 * mana value, no companion condition, no commander eligibility.
 */
export const OrphanCard: Story = {
  args: {
    cards: padWithIslands(60, [...MODERN_SPELLS, orphanDeckCard()]),
    spec: SPECS.modern,
    buttonRef: chipRef(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("dialog", { name: "Modern check" });
    // The reconciler's sentence, whole, inside the engine's. Asserted against the constant rather
    // than a retyped copy: if `reconcile.rs` rewords it, the thing that should fail is the
    // fixture, not a paraphrase in a story.
    await expect(panel).toHaveTextContent(`Sword of the Meek: ${MISSING}`);
    // A row with no card left is still a row the reader can open — `deck_cards` denormalises
    // `name`, so the one handle it has survives, and the panel makes a button out of it.
    await expect(
      within(panel).getByRole("button", { name: "Sword of the Meek" }),
    ).toBeInTheDocument();
  },
};

/**
 * A legal Commander deck, with the advisory that is not a finding.
 *
 * The bracket rides in the same panel for the commander formats and is **an estimate in the copy
 * as well as in the code**: `bracket.ts` returns a `BracketEstimate` rather than a
 * `ValidationIssue`, `engine.ts` does not import it at all, and a number that cannot make a deck
 * illegal must not be drawn as though it could. It is computed only while the panel is open,
 * unlike the findings — the chip prints a count, so `validateDeck` earns its every-render pass;
 * this greps every face of every card for four phrases and earns nothing until it is read.
 *
 * Three Game Changers put this deck at bracket 3, and the number comes from a **column**
 * (`cards.game_changer`, maintained by the Commander Format Panel and delivered by a sync) rather
 * than a list this app keeps. Those three are the whole of the corpus's Game Changers: Ancient
 * Tomb, Rhystic Study and Consecrated Sphinx. Measured 2026-08-09 by running `estimateBracket`
 * over all 43 printings at once — **no** card in the corpus reads as mass land denial, and the
 * only one that takes an extra turn is Emrakul, the Aeons Torn, which is `commander: banned`. So
 * those two lines of the disclosure are absent here rather than empty: `estimate` filters an
 * empty list out, and three headings above one number would be two lines of nothing.
 */
export const BracketEstimate: Story = {
  args: {
    cards: padWithIslands(100, [
      kenrith(),
      ...commanderSingles(),
      deckCard(printing("tmp", "315")),
      deckCard(printing("pcy", "45")),
      deckCard(printing("mp2", "8")),
    ]),
    spec: SPECS.commander,
    buttonRef: chipRef(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("dialog", { name: "Commander check" });
    // The headline is one text run rather than styled spans, so it is a sentence something can
    // read back: a fact split across elements is one nothing — screen reader, test, or reader
    // skimming — puts together.
    await expect(panel).toHaveTextContent("Bracket ~3 · 3 game changers");
    // The disclosure is closed until asked, and **what it says is the reason the number is worth
    // showing at all**: a reader who disagrees with a heuristic can see which card caused it.
    const why = within(panel).getByRole("button", { name: "What this read" });
    await expect(why).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(why);
    await expect(why).toHaveAttribute("aria-expanded", "true");
    await expect(within(panel).getByText("Game changers")).toBeInTheDocument();
    await expect(
      within(panel).getByText("Ancient Tomb, Rhystic Study, Consecrated Sphinx"),
    ).toBeInTheDocument();
    // Mass land denial and extra turns have no line at all, rather than a line reading none —
    // `estimate` filters the empty ones out, and an advisory with three headings and one number
    // under them would be two lines of nothing.
    await expect(within(panel).queryByText("Mass land denial")).toBeNull();
    await expect(within(panel).queryByText("Extra turns")).toBeNull();
  },
};
