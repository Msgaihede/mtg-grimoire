import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { registerCommands } from "../../../.storybook/fake/core";
import { printing } from "../../../.storybook/fake/fixtures";
import type { CardCombo, CardCombosPage, ComboPiece, ComboStatus } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { CombosDialog } from "./CombosDialog";

/**
 * **Boros Reckoner, `gtc 215`** — the card every story on this page is opened on, and the one the
 * fake's own combo fixtures name. It is a good subject for the surface rather than an arbitrary
 * one: a three-mana creature whose combos are *interactions* (Boros Charm's indestructible clause,
 * Avacyn's blanket one) and therefore exactly the thing no amount of reading its own text finds.
 *
 * A card, not a fixture: nothing here seeds `cards`, so the pieces draw whatever the shipped
 * `card_detail` and the image fake would answer for real Gatecrash printings. `printing` throws at
 * module load rather than handing this page an id the corpus has no row for.
 */
const RECKONER = printing("gtc", "215");
const CHARM = printing("gtc", "148");
const AVACYN = printing("avr", "6");

/* ------------------------------------------------------------------ fixtures ------------- */

function piece(over: Partial<ComboPiece> = {}): ComboPiece {
  return {
    oracleId: RECKONER.oracleId,
    name: RECKONER.name,
    quantity: 1,
    mustBeCommander: false,
    cardId: RECKONER.id,
    imageUris: null,
    owned: 1,
    ...over,
  };
}

/**
 * The row the ownership mark and the `I own every piece` filter are both about — Avacyn is the
 * piece the reader has none of.
 */
const NOT_OWNED = piece({
  oracleId: AVACYN.oracleId,
  name: AVACYN.name,
  cardId: AVACYN.id,
  owned: 0,
});

/** The plain two-card combo: both pieces owned, nothing but `produces` filled in — which is what a
 *  large share of the feed's rows look like, and why every optional section draws *nothing*
 *  rather than an empty heading. */
const LIFEGAIN: CardCombo = {
  id: "3422-3587",
  bracketTag: "S",
  cardCount: 2,
  templateCount: 0,
  identity: "RW",
  produces: "Infinite lifegain\nInfinite lifegain triggers",
  description: "",
  easyPrerequisites: "",
  notablePrerequisites: "",
  manaNeeded: "",
  popularity: 13_433,
  pieces: [piece(), piece({ oracleId: CHARM.oracleId, name: CHARM.name, cardId: CHARM.id })],
};

/** The same shape with a piece the reader does not own. */
const AVACYN_COMBO: CardCombo = {
  id: "3149-3587",
  bracketTag: "S",
  cardCount: 2,
  templateCount: 0,
  identity: "RW",
  produces: "Infinite lifegain\nInfinite damage",
  description: "",
  easyPrerequisites: "",
  notablePrerequisites: "",
  manaNeeded: "",
  popularity: 1_318,
  pieces: [piece(), NOT_OWNED],
};

/**
 * The row with every optional field filled — and a `templateCount` of 1, which is the state the
 * pieces list cannot show: the combo also needs something no card list can name.
 */
const TEMPLATED: CardCombo = {
  id: "5120-5121",
  bracketTag: "P",
  cardCount: 3,
  templateCount: 1,
  identity: "RW",
  produces: "Infinite damage",
  description:
    "Target Boros Reckoner with Boros Charm.\n" +
    "Deal damage to Boros Reckoner with the creature you control.\n" +
    "Repeat as many times as desired.",
  easyPrerequisites: "Boros Reckoner is on the battlefield.",
  notablePrerequisites: "A creature you control that can deal damage to Boros Reckoner.",
  manaNeeded: "{2}",
  popularity: 402,
  pieces: [
    piece(),
    piece({ oracleId: CHARM.oracleId, name: CHARM.name, cardId: CHARM.id }),
    // A card this corpus has never synced — the feed names cards a reader's database may simply
    // not have, and `CardArt` draws its named, empty frame for one.
    piece({
      oracleId: "0e0e0e0e-0000-0000-0000-000000000000",
      name: "Spitemare",
      cardId: null,
      owned: 0,
    }),
  ],
};

/** A card with far more combos than one page — Ashnod's Altar is in 6 044 of them on the real
 *  corpus, so this is the ordinary case for a staple rather than a stress test. */
const MANY: CardCombo[] = Array.from({ length: 60 }, (_, i) => ({
  ...LIFEGAIN,
  id: `9000-${i}`,
  popularity: 6_000 - i,
  pieces: [
    piece(),
    piece({
      oracleId: `partner-${i}`,
      name: `${CHARM.name} ${i + 1}`,
      cardId: i % 3 === 0 ? null : CHARM.id,
      owned: i % 2,
    }),
  ],
}));

/** A feed that is here, so an empty answer means the card and not the database. */
const INGESTED: ComboStatus = {
  combos: 107_016,
  cards: 7_330,
  stamp: "2026-09-08T03:12:44Z",
  fetchedAt: 1_800_000_000,
  checkedAt: 1_800_000_000,
  stale: false,
};

/** …and one that has never been fetched: every field null, `stale: true`. */
const NEVER: ComboStatus = {
  combos: 0,
  cards: 0,
  stamp: null,
  fetchedAt: null,
  checkedAt: null,
  stale: true,
};

/** The five arguments the command takes, as the fake receives them. */
interface Args {
  oracleId: string;
  cardCount: number | null;
  ownedOnly: boolean;
  limit: number;
  offset: number;
}

/**
 * A handler over a fixed list, doing exactly what the backend does with the two filters and the
 * window — so the chips, the toggle and **Show more** are live on this page rather than
 * decorative.
 *
 * `total` and `byCardCount` are census fields and are computed **before** the filters; `matching`
 * is computed after. Getting that the other way round is how a chip comes to disagree with itself
 * the moment it is pressed.
 */
function pageOf(all: CardCombo[]) {
  return (args: Args): CardCombosPage => {
    const sizes = new Map<number, number>();
    for (const c of all) sizes.set(c.cardCount, (sizes.get(c.cardCount) ?? 0) + 1);
    const ownedTotal = all.filter((c) =>
      c.pieces.every((p) => p.owned >= p.quantity),
    ).length;
    const matched = all.filter(
      (c) =>
        (args.cardCount === null || c.cardCount === args.cardCount) &&
        (!args.ownedOnly || c.pieces.every((p) => p.owned >= p.quantity)),
    );
    return {
      total: all.length,
      matching: matched.length,
      ownedTotal,
      byCardCount: [...sizes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([cards, combos]) => ({ cards, combos })),
      combos: matched.slice(args.offset, args.offset + args.limit),
    };
  };
}

/* ------------------------------------------------------------------ the host -------------- */

/** Which world a story stands the dialog up in. `"fake"` asks the workbench's own database, which
 *  is what the first story is for; the rest stage a page of their own. */
type Stage = "fake" | "list" | "many" | "never" | "none";

/**
 * The dialog, opened the way the app opens it — through the store's two writers, in the order the
 * store requires.
 *
 * `setSelectedCardId` **clears** `cardOverlay` (an overlay outliving the card under it would be a
 * combo list for a card nobody has open), so the card goes first and the overlay second. Both are
 * written in a lazy `useState` initializer rather than an effect, which is `LegalityDialog`'s
 * answer and for its reason: an effect runs after the first paint, so the story would draw one
 * frame of a closed dialog before it opened.
 */
function Host({ stage }: { stage: Stage }) {
  useState(() => {
    // **Every stage but the first registers its own handlers**, and that is deliberate rather than
    // a shortcut past the fake: the three empty and filtered states are claims about a *database*
    // — a feed that has never been fetched, a card in nothing, a filter that left nothing — and
    // staging them here keeps each story's world in the story that is about it.
    if (stage !== "fake") {
      const all =
        stage === "many"
          ? MANY
          : stage === "list"
            ? [LIFEGAIN, AVACYN_COMBO, TEMPLATED]
            : [];
      registerCommands({
        combos_for_card: pageOf(all),
        combos_status: () => (stage === "never" ? NEVER : INGESTED),
      });
    }
    const store = useAppStore.getState();
    store.setSelectedCardId(RECKONER.id);
    store.openCardOverlay("combos");
  });

  return <CombosDialog />;
}

const meta = {
  title: "Card/Combos",
  component: Host,
  tags: ["autodocs"],
  args: { stage: "list" as Stage },
  // Keyed, so changing the stage in Controls mounts a fresh host and the initializer above runs
  // again rather than writing to a store the mounted dialog is already subscribed to.
  render: (args) => <Host key={args.stage} {...args} />,
  parameters: {
    docs: {
      /**
       * **Each story on this page gets its own frame**, which is the one thing that gives it its
       * own `useAppStore` *and* its own command scope. Every story here writes `selectedCardId`
       * and `cardOverlay` during render and most of them register handlers; the store is a module
       * singleton `.storybook/` cannot make per-story, so inline, a docs page mounts every story
       * at once and the last to render owns both for all of them.
       */
      story: { inline: false, height: "760px" },
      description: {
        component:
          "What a card is a **piece of** — Commander Spellbook's combo feed asked from the " +
          "card's side.\n\n" +
          "A two-card infinite combo is a fact about an *interaction*, so no amount of reading " +
          "either card's own text finds one: Boros Reckoner says nothing about Boros Charm. " +
          "That is the same reason the deck bracket needed a fourth signal, asked the other way " +
          "round — not *what does this deck contain* but *what is this card part of*.\n\n" +
          "**It is paged, and the corpus is why.** 107 016 combos over 7 330 distinct cards " +
          "(measured 2026-09-08), and the distribution is not flat — Ashnod's Altar is in " +
          "**6 044** of them and 114 cards are in more than 500. So 25 a page, with both " +
          "filters sent to the backend rather than applied to the page in hand: a size chip that " +
          "narrowed only the rows on screen would be describing 0.4 % of the list.\n\n" +
          "**Three empties, and telling them apart is the point.** A card in no combo, a " +
          "database that has never downloaded the feed and a printing with no oracle card behind " +
          "it are the same empty page, and the sentences are not close — one is about the " +
          "reader's card, one about their database, one about the printing. `combos_status` is " +
          "what makes the split sayable. A fourth, *No combo matches that filter*, is about the " +
          "reader's own chips and never borrows one of the other three.\n\n" +
          "**Everything the feed left empty draws nothing.** `produces`, the two prerequisite " +
          "fields, `manaNeeded` and the numbered steps are all `\"\"` on a large share of rows, " +
          "and a heading with nothing under it reads as content that failed to load.\n\n" +
          "The bracket letter's words are `DeckBracket`'s `COMBO_TAG`, imported rather than " +
          "respelled: two surfaces describing one letter two ways is a letter a reader can " +
          "trust neither drawing of.",
      },
    },
  },
} satisfies Meta<typeof Host>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The ordinary list: three combos, one of them missing a piece and one of them needing something
 * no card list can name.
 *
 * Read the second row against the first — Avacyn is **Not owned**, in words rather than in colour
 * alone, which is the app's rule wherever a status is coloured and the one that matters most here:
 * the whole point of *I own every piece* is finding the combo you could build tonight. The third
 * row is the only one with steps, prerequisites and a mana cost, and the other two draw no heading
 * for any of them.
 */
export const Combos: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // **Boros Charm appears twice, and the count is the assertion.** It is a piece of two of
    // these three combos, which is the ordinary shape of a combo list rather than a quirk of the
    // fixture — a card is in a combo *with* several others, and the reason this dialog exists is
    // that the relationship is not readable off either card. A `getByText` here fails on the
    // working component; a bare `getAllByText` would pass a page that had collapsed the two rows
    // into one, which is the failure worth catching.
    await expect(await canvas.findAllByText("Boros Charm")).toHaveLength(2);
    await expect(canvas.getByText("Avacyn, Angel of Hope")).toBeInTheDocument();
    // **Ownership said in a word, not in a colour — twice, because two pieces are unowned.**
    // Avacyn in the second row and the unsynced Spitemare in the third. A card the corpus has
    // never synced is necessarily not owned, so those two states co-occur rather than competing:
    // the frame says the database has no printing, the mark says the reader has no copy, and
    // both sentences are true at once.
    await expect(canvas.getAllByText("Not owned")).toHaveLength(2);
    // **The piece this corpus has never synced names its card twice, on purpose.** `CardArt`
    // prints the name inside the empty frame it draws for a null `cardId`, and the row prints it
    // again as the caption — the pairing `DeckTokensPanel` already uses with the same component.
    // "No card" is the frame's own word for *this database has no printing*, as against
    // "No image" for a printing whose art did not arrive; asserting it is what separates an
    // unsynced piece from a slow one.
    await expect(canvas.getAllByText("Spitemare")).toHaveLength(2);
    await expect(canvas.getByText("No card")).toBeInTheDocument();
    // A combo that needs a template says so rather than leaving a reader to infer it.
    await expect(canvas.getByText(/no card list can name/i)).toBeInTheDocument();
  },
};

/**
 * The same three combos, narrowed to the two-card ones.
 *
 * **The chip's count is the census and does not move when it is pressed** — `total` and
 * `byCardCount` describe the card, `matching` describes the filter — so a chip reading `2 cards ·
 * 2` still reads that with the filter on. A control that changed its mind about what it was
 * counting the moment it was used would be unreadable.
 */
export const Filtered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Showing 3 of 3");
    await userEvent.click(await canvas.findByRole("button", { name: "2 cards · 2" }));

    await expect(await canvas.findByText("Showing 2 of 2")).toBeInTheDocument();
    // The three-card row is gone, and the chip still says how many two-card combos there are.
    await expect(canvas.queryByText(/no card list can name/i)).toBeNull();
    await expect(canvas.getByRole("button", { name: "2 cards · 2" })).toBeInTheDocument();
  },
};

/**
 * A card in far more combos than one page holds — the ordinary case for a staple, not a stress
 * test. **Show more** appends the next 25 and the heading says how far down the list the reader
 * has got.
 */
export const ManyCombos: Story = {
  args: { stage: "many" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Showing 25 of 60")).toBeInTheDocument();
    await userEvent.click(await canvas.findByRole("button", { name: "Show more" }));
    await expect(await canvas.findByText("Showing 50 of 60")).toBeInTheDocument();
  },
};

/**
 * **The database has never fetched the combo file, which is every install's opening state and not
 * a failure.**
 *
 * An empty page is also what a card in no combo answers, so silence here would have the dialog
 * implying Commander Spellbook has nothing on this card when the truth is that nothing has been
 * looked at. That is the one sentence this surface may never write, so the status row is consulted
 * and the never-fetched case says which of the two it is — and it asks for no press, because the
 * feed is fetched at launch and there is no button for it anywhere in the app.
 */
export const NeverDownloaded: Story = {
  args: { stage: "never" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/has not been downloaded/i)).toBeInTheDocument();
    // Never the other sentence, on a database that has looked at nothing.
    await expect(canvas.queryByText(/none on record naming this card/i)).toBeNull();
  },
};

/**
 * The other half of that split: the feed is here and lists no combo naming this card.
 *
 * Most cards are in none — 7 330 of the corpus's ~117 000 printings are named by a combo at all —
 * so this is the commonest thing this dialog says.
 */
export const NoCombos: Story = {
  args: { stage: "none" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/none on record naming this card/i)).toBeInTheDocument();
    await expect(canvas.queryByText(/has not been downloaded/i)).toBeNull();
  },
};

/**
 * The workbench's own database answering, with nothing staged.
 *
 * Every other story on this page registers a handler, which is right for the states that are
 * claims about a database — but it also means none of them exercises the fake. This one does, so
 * a change to the fake's combo fixtures shows up here rather than nowhere. It carries no `play`
 * for the same reason: what it draws is the fake's to decide.
 */
export const FromTheFake: Story = {
  args: { stage: "fake" },
};
