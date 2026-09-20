import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { registerCommands } from "../../../.storybook/fake/core";
import { printing } from "../../../.storybook/fake/fixtures";
import type { CardCombo, CardCombosPage, ComboPiece, ComboStatus } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { DESKTOP_FLOOR_HEIGHT_PX, DESKTOP_FLOOR_PX } from "@/lib/viewports";
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
 *  rather than an empty heading. It is also the shape {@link OwnedEntirely} is about. */
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
 *
 * It is the pane's tallest drawing and the one {@link WalkTheRail} walks to, which is the whole
 * reason it is third in the list rather than first: the rail's selection falls to row one on open,
 * so the only way to see this one is to press it.
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
 *  corpus, so this is the ordinary case for a staple rather than a stress test. Sixty against a
 *  `PAGE_SIZE` of 50, so the rail's first page is full and the sentinel has something left to
 *  ask for. */
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

/**
 * What one rail row is called, spelled out here so a `play` can press a row by the sentence the
 * component builds for it.
 *
 * **Written out rather than imported from `comboRowLabel`.** That function is not exported, and
 * exporting it so the stories could re-run it would make this page assert that the component
 * agrees with itself. These are the four parts in the order the row says them — the other pieces
 * and the classification, the brackets in words, the size, the ownership — and if the shape moves,
 * these break, which is the whole point of writing them by hand.
 */
const ROW_LIFEGAIN =
  "Boros Charm — Spicy. Legal in brackets 3, 4 and 5. 2 cards. You own every piece.";
const ROW_TEMPLATED =
  "Boros Charm + Spitemare — Powerful. Legal in brackets 3, 4 and 5. 3 cards. Missing 1.";
const ROW_MANY_FIRST =
  "Boros Charm 1 — Spicy. Legal in brackets 3, 4 and 5. 2 cards. Missing 1.";

/** The sentence the pane's five pips carry, and the range box's `3–5` said in full. Both of this
 *  page's `S`/`P` fixtures floor at bracket 3, so it is the same string for all of them. */
const BRACKETS_3_TO_5 = "Legal in brackets 3, 4 and 5";

/** The six arguments the command takes, as the fake receives them. */
interface Args {
  oracleId: string;
  search: string | null;
  cardCount: number | null;
  ownedOnly: boolean;
  limit: number;
  offset: number;
}

/**
 * A handler over a fixed list, doing exactly what the backend does with the search, the two chips
 * and the window — so the box, the chips and the toggle are live on this page rather than
 * decorative, and so is the rail's scroll paging.
 *
 * **The order is the contract and it is the whole of what this fixture has to get right.** The
 * search changes the *subject*; the chips are facets of it. So `total` is over everything;
 * `byCardCount` and `ownedTotal` are censuses of what the **search** leaves standing; `matching` is
 * over that with the chips applied as well. Censusing before the search is how a chip comes to
 * disagree with the list under it — and censusing after the *chips* is how one comes to disagree
 * with itself the moment it is pressed.
 */
function pageOf(all: CardCombo[]) {
  const owns = (c: CardCombo) => c.pieces.every((p) => p.owned >= p.quantity);
  return (args: Args): CardCombosPage => {
    // A case-insensitive substring against any piece's name, the asked-about card included —
    // `null` and `""` alike mean no search.
    const term = (args.search ?? "").toLowerCase();
    const searched = all.filter(
      (c) => term === "" || c.pieces.some((p) => p.name.toLowerCase().includes(term)),
    );
    const sizes = new Map<number, number>();
    for (const c of searched) sizes.set(c.cardCount, (sizes.get(c.cardCount) ?? 0) + 1);
    const matched = searched.filter(
      (c) =>
        (args.cardCount === null || c.cardCount === args.cardCount) && (!args.ownedOnly || owns(c)),
    );
    return {
      total: all.length,
      matching: matched.length,
      ownedTotal: searched.filter(owns).length,
      byCardCount: [...sizes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([cards, combos]) => ({ cards, combos })),
      combos: matched.slice(args.offset, args.offset + args.limit),
    };
  };
}

/* ------------------------------------------------------------------ the host -------------- */

/** Which world a story stands the dialog up in. `"fake"` asks the workbench's own database, which
 *  is what the last story is for; the rest stage a page of their own. */
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
        stage === "many" ? MANY : stage === "list" ? [LIFEGAIN, AVACYN_COMBO, TEMPLATED] : [];
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
       *
       * **1040px, and the number is arithmetic rather than taste** (raised from 760 on
       * 2026-09-20, when the panel took a fixed `h-[54rem]`). The panel asks for **864px** and
       * `Dialog`'s scrim spends `2 × max(1.5rem, 5vh)` of the frame on glass — 104px at this
       * height — which leaves 936 and draws the dialog whole with 72px to spare. At the old 760
       * the scrim left 684 and `max-h-full` clamped the panel by 180px, so the as-of caption and
       * the foot of both columns were a picture of a window nobody has. Anything from about 1000
       * up would do; this one has headroom rather than sitting on the boundary.
       */
      story: { inline: false, height: "1040px" },
      description: {
        component:
          "What a card is a **piece of** — Commander Spellbook's combo feed asked from the " +
          "card's side.\n\n" +
          "A two-card infinite combo is a fact about an *interaction*, so no amount of reading " +
          "either card's own text finds one: Boros Reckoner says nothing about Boros Charm. " +
          "That is the same reason the deck bracket needed a fourth signal, asked the other way " +
          "round — not *what does this deck contain* but *what is this card part of*.\n\n" +
          "**A rail and a pane, since 2026-09-20 (issue #481).** It was a list of accordions, " +
          "and the report was that the images and the text were too small. Taken literally that " +
          "asks for a wider accordion; what it describes is a surface scanned by card art " +
          "through a 96px window, with the thing the reader wants behind a press. So the left " +
          "rail is the **scan list** — one line per combo, no art, the bracket range, the other " +
          "pieces' names and what is missing — and the right pane is **one combo at full size** " +
          "with nothing collapsed: 176px card frames, the steps, the prerequisites and the " +
          "mana. Selection is derived rather than stored, so the first row is drawn on open and " +
          "narrowing the list falls the pane through to the first row of the new one.\n\n" +
          "**It is paged, and the corpus is why.** 107 016 combos over 7 330 distinct cards " +
          "(measured 2026-09-08), and the distribution is not flat — Ashnod's Altar is in " +
          "**6 044** of them and 114 cards are in more than 500. So 50 a page, fetched when a " +
          "sentinel at the foot of the rail scrolls into view rather than by a press, with the " +
          "search and both chips sent to the backend rather than applied to the page in hand: a " +
          "size chip that narrowed only the rows on screen would be describing 0.8 % of the " +
          "list.\n\n" +
          "**Paging is not a way to find anything, which is what the box above the chips is " +
          "for.** Six thousand combos fifty at a time is 121 scrolls to reach the end of one " +
          "card's list, and no way at all to ask *which of these has Krark-Clan Ironworks in " +
          "it*. The search matches a piece's name — the asked-about card included — and it " +
          "changes the **subject**, where the chips are facets of it.\n\n" +
          "**The chips carry no counts and the rail's heading does.** `All · 412` became `All`: " +
          "five figures of arithmetic in a row of controls between a search box and the cards " +
          "is what the reporter of #481 was reading past. The number is drawn once, as " +
          "`412 combos` over the list it is a count of.\n\n" +
          "**Three empties, and telling them apart is the point.** A card in no combo, a " +
          "database that has never downloaded the feed and a printing with no oracle card behind " +
          "it are the same empty page, and the sentences are not close — one is about the " +
          "reader's card, one about their database, one about the printing. `combos_status` is " +
          "what makes the split sayable. A fourth, *No combo matches that filter*, is about the " +
          "reader's own chips and never borrows one of the other three.\n\n" +
          "**Everything the feed left empty draws nothing.** `produces`, the two prerequisite " +
          "fields, `manaNeeded` and the numbered steps are all `\"\"` on a large share of rows, " +
          "and a heading with nothing under it reads as content that failed to load.\n\n" +
          "**No letter is drawn on this side of the app any more.** The brackets a combo is " +
          "legal in are derived from `COMBO_FLOOR` through `comboBrackets` in " +
          "`features/decks/validation/bracket.ts` and are never tabulated a second time — the " +
          "rail says them as a range (`3–5`), the pane as five pips carrying " +
          "`Legal in brackets 3, 4 and 5` as the group's own label, and a `B` combo says it is " +
          "not legal in Commander rather than drawing five empty pips. `COMBO_TAG`'s **names** " +
          "are still imported from `DeckBracket` and still drawn, because *Powerful — for " +
          "strong decks in bracket 3+* is a sentence and `P` is a vocabulary lesson.",
      },
    },
  },
} satisfies Meta<typeof Host>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The ordinary list: three combos in the rail, and the first of them drawn whole in the pane.
 *
 * **Nothing is collapsed and nothing is behind a press.** The rail's job is what a reader chooses
 * *between* — the bracket range, the other pieces, and how much of the combo they already own —
 * and everything else about the selected one is on the right at full size. Read the second row
 * against the first: Avacyn's says **Missing 1**, in words rather than in colour alone, which is
 * the app's rule wherever a status is coloured and the one that matters most here. The whole point
 * of *I own every piece* is finding the combo you could build tonight, so a reader scanning the
 * rail has to see what they are short of without pressing anything.
 *
 * This is also the **two-card** shape: two 176px frames side by side with a `+` centred on the
 * art, `produces` as the headline, and not one of the five prose sections drawn, because the feed
 * filled none of them.
 */
export const Combos: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The count is in the heading over the rail and nowhere else — one text node, because a `gap`
    // is not a word separator to the accessible-name computation.
    await expect(await canvas.findByText("3 combos")).toBeInTheDocument();
    const rail = canvas.getByRole("list", { name: "Combos" });
    await expect(within(rail).getAllByRole("button")).toHaveLength(3);

    // **The first row is selected on open**, which is the derivation and not an effect: `picked`
    // is null until something is pressed and the pane falls through to `rows[0]`.
    const first = within(rail).getByRole("button", { name: ROW_LIFEGAIN });
    await expect(first).toHaveAttribute("aria-current", "true");

    // …and the pane is drawing that row. **Boros Charm appears exactly twice**, and the count is
    // the assertion: once as the rail row's headline — the *other* pieces, since the asked-about
    // card is the dialog's subtitle and repeating it on every row costs the width the names need
    // — and once as the caption under its picture in the pane.
    await expect(canvas.getAllByText("Boros Charm")).toHaveLength(2);
    await expect(canvas.getByText("Infinite lifegain · Infinite lifegain triggers")).toBeVisible();
    // **The pips speak once and as a sentence.** Five numbers with two of them merely a different
    // colour is exactly the statement this app never makes on its own, so the group is
    // `role="img"` and carries the whole thing as its label.
    await expect(canvas.getByRole("img", { name: BRACKETS_3_TO_5 })).toBeInTheDocument();
    // Spellbook's own classification in Spellbook's own words, beside the pips — `COMBO_TAG`
    // imported from the deck bracket rather than spelled a second time. **Asserted whole, which is
    // the assertion the one-text-node rule exists for**: the name was briefly drawn in a nested
    // `<span className="font-medium text-text">`, which reads correctly on screen and made this
    // query fail — Testing Library reads an element's *own* text children, so the outer span
    // computed as `— probably 3 or 4, but hard to classify` with `Spicy` somewhere else. A reader
    // reads it as one sentence and so does this.
    await expect(
      canvas.getByText("Spicy — probably 3 or 4, but hard to classify"),
    ).toBeVisible();
    // Ownership said in a word on both frames, not in a colour.
    await expect(canvas.getAllByText("Owned")).toHaveLength(2);
    // The two rows that are not selected still say what they are short of.
    await expect(canvas.getAllByText("Missing 1")).toHaveLength(2);
    await expect(canvas.getByText("You own every piece")).toBeInTheDocument();

    // Every pane draws the link, so this is a presence and not the absence the accordion's
    // collapsed rows used to assert.
    await expect(
      canvas.getByRole("button", { name: "View on Commander Spellbook" }),
    ).toBeInTheDocument();
    // And nothing of the *third* combo is on screen: its pieces, its steps and its template
    // caveat all belong to a row nobody has pressed.
    await expect(canvas.queryByText("Spitemare")).toBeNull();
    await expect(canvas.queryByRole("list", { name: "Steps" })).toBeNull();
    await expect(canvas.queryByText(/no card list can name/i)).toBeNull();
  },
};

/**
 * Walking the rail — press a row, and the pane is about that row instead.
 *
 * **This replaces the story that opened one, because there is nothing to open.** A press moves the
 * *selection*; the pane is keyed on the combo, so a new row is a new element and the pane starts
 * at the top rather than halfway down somebody else's steps.
 *
 * The row it walks to is the **three-card-with-a-template** shape, which is the pane's tallest
 * drawing and the only one on this page with all five prose sections: the pieces (one of them a
 * card this corpus has never synced), the steps, both prerequisite blocks, `Mana needed`, and the
 * sentence saying the cards above are *not the whole combo* — a `requires[]` template can be
 * resolved against no card list at all, so a pane that drew its named pieces and stopped would be
 * implying a two-card combo where the feed says three things are needed.
 *
 * **No arrow key is pressed here, and that is an environment limit rather than a choice.** The
 * rail's `ArrowDown`/`ArrowUp` call `scrollIntoView({ block: "nearest" })` on the row it moves to,
 * which jsdom does not implement at all — so a keyboard `play` would throw under
 * `src/stories.test.tsx` for a reason that has nothing to do with the component. The keyboard is
 * `CombosDialog.test.tsx`'s and the shipped window's.
 */
export const WalkTheRail: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rail = await canvas.findByRole("list", { name: "Combos" });
    // Found by its own name rather than by position: a row's accessible name is built rather than
    // left to fall out of the layout, because the spaces on it are flex gaps and the accname
    // computation would otherwise run the range box, the names, the size and the ownership mark
    // together into one token.
    const row = within(rail).getByRole("button", { name: ROW_TEMPLATED });
    await userEvent.click(row);

    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(within(rail).getByRole("button", { name: ROW_LIFEGAIN })).not.toHaveAttribute(
      "aria-current",
    );

    // The pane moved: the first row's headline is gone and this row's is drawn.
    await expect(canvas.queryByText("Infinite lifegain · Infinite lifegain triggers")).toBeNull();
    await expect(await canvas.findByText("Infinite damage")).toBeVisible();

    // The five sections only this shape fills.
    await expect(canvas.getByRole("list", { name: "Prerequisites" })).toBeInTheDocument();
    await expect(canvas.getByRole("list", { name: "Notable prerequisites" })).toBeInTheDocument();
    await expect(canvas.getByRole("list", { name: "Steps" })).toBeInTheDocument();
    await expect(canvas.getByText("Mana needed")).toBeInTheDocument();
    await expect(canvas.getByText(/no card list can name/i)).toBeVisible();

    // **The unsynced piece names its card twice, on purpose.** `CardArt` prints the name inside
    // the empty frame it draws for a null `cardId`, and the pane prints it again as the caption.
    // "No card" is that frame's word for *this database has no printing*, as against "No image"
    // for a printing whose art did not arrive — asserting it is what separates an unsynced piece
    // from a slow one.
    await expect(canvas.getAllByText("Spitemare")).toHaveLength(2);
    await expect(canvas.getByText("No card")).toBeInTheDocument();
    // A card the corpus has never synced is necessarily not owned, so those two states co-occur
    // rather than competing: the frame says the database has no printing, the mark says the
    // reader has no copy, and both sentences are true at once.
    await expect(canvas.getByText("Not owned")).toBeInTheDocument();
  },
};

/**
 * The combo the reader owns every piece of — the shape the ownership chip exists to find.
 *
 * **Ownership is a word and never only a colour**, and this is the surface where that rule matters
 * most: pressing *I own every piece* is a reader asking which of these they could assemble
 * tonight. The rail row says **You own every piece** and the pane says **Owned** under each frame,
 * so the answer survives a reader who cannot tell the green from the grey.
 *
 * It is also the singular: one match, so the heading reads `1 combo` rather than `1 combos`.
 */
export const OwnedEntirely: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("3 combos");
    const chip = canvas.getByRole("button", { name: "I own every piece" });
    await userEvent.click(chip);

    await expect(await canvas.findByText("1 combo")).toBeInTheDocument();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    const rail = canvas.getByRole("list", { name: "Combos" });
    await expect(within(rail).getAllByRole("button")).toHaveLength(1);

    // The one row left, and the pane that followed the selection down to it.
    await expect(within(rail).getByRole("button", { name: ROW_LIFEGAIN })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(canvas.getAllByText("Owned")).toHaveLength(2);
    // Nothing on screen is short of anything — which is the claim the chip makes.
    await expect(canvas.queryByText("Missing 1")).toBeNull();
    await expect(canvas.queryByText("Not owned")).toBeNull();
  },
};

/**
 * The dialog in the **smallest window this app can be** — 1024 × 700, `tauri.conf.json`'s
 * `minWidth` and `minHeight`, read from `@/lib/viewports` rather than spelled again here.
 *
 * **This is the story the panel's width was argued against.** `w-[62rem]` is 992px, wider than
 * anything else this app ships, and the scrim spends 24px a side above the phone fold — so the
 * panel asks for 1040 of a window that has 1024, and `Dialog`'s `max-w-full` absorbs the
 * difference. The height is the same argument on the other axis: the panel asks for 864 and the
 * scrim's `max(1.5rem, 5vh)` leaves 630, so `max-h-full` clamps it and both columns scroll inside
 * themselves. Neither clamp is a fallback; they are the reason 62rem is safe and 72rem is not.
 *
 * **What a `play` can settle here is the structure and not the width.** jsdom lays nothing out —
 * every rect is 0 and no stylesheet is loaded — so the assertions below are that the split is
 * still a split at this size: a rail with its three rows, and a pane still drawing one combo
 * whole. Whether the panel really fits is a claim only Storybook's own browser or the shipped
 * window can make, and `docs/superpowers/plans/2026-09-20-combos-dialog-split-view.md` names it as
 * one of the two things the live pass exists for.
 */
export const NarrowWindow: Story = {
  decorators: [
    (Story) => (
      <div
        // **`position: fixed` resolves against the nearest *transformed* ancestor**, not the
        // viewport — so this one line turns a window-covering modal into a story-sized one, and
        // is what makes the frame below a *window* rather than a box drawn next to one. The same
        // trick every dialog story in this repo uses; `AllPrintingsDialog` and `CardDetailModal`
        // are the two to read.
        style={{
          transform: "translateZ(0)",
          width: DESKTOP_FLOOR_PX,
          height: DESKTOP_FLOOR_HEIGHT_PX,
        }}
        className="relative overflow-hidden rounded-lg border border-border bg-bg"
      >
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rail = await canvas.findByRole("list", { name: "Combos" });
    await expect(within(rail).getAllByRole("button")).toHaveLength(3);
    await expect(canvas.getByText("3 combos")).toBeInTheDocument();
    // The pane is still a pane: the picture wall, the pips and the headline all drawn.
    await expect(canvas.getAllByText("Boros Charm")).toHaveLength(2);
    await expect(canvas.getByRole("img", { name: BRACKETS_3_TO_5 })).toBeInTheDocument();
    await expect(canvas.getByText("Infinite lifegain · Infinite lifegain triggers")).toBeVisible();
  },
};

/**
 * A term in the box, and the chip row following it.
 *
 * **This is the half paging cannot do.** Ashnod's Altar is in 6 044 combos, fifty to a page; a
 * reader who wants the one with a particular card in it cannot get there by scrolling 121 times.
 * The search matches any piece's name, the asked-about card included, and it is sent to the
 * backend for the chips' reason — a term applied to the page in hand would be searching 0.8 % of
 * the list and calling the answer *no match*.
 *
 * Watch two things rather than the list. The heading over the rail is `matching`, so it follows
 * the term. And the size chips are drawn from a census of the **searched** set, so a size the term
 * left nothing of loses its chip entirely — a control that could only ever empty the list is a
 * control that lies. Selection follows too, with no effect anywhere: the id in `picked` is not in
 * the new `rows`, so the pane falls through to the first row of the list the reader just asked
 * for.
 */
export const Searched: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("3 combos")).toBeInTheDocument();
    // **The chips carry no counts since 2026-09-20** — `All · 3` is `All`, and the figure it was
    // carrying is the heading asserted above.
    await expect(canvas.getByRole("button", { name: "All" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "3 cards" })).toBeInTheDocument();

    // Named for *this* list and never a bare `Search`: the card modal is on screen behind this
    // dialog and the app is full of boxes, and a `getByLabelText` cannot tell two of one name
    // apart.
    await userEvent.type(canvas.getByLabelText("Search these combos"), "avacyn");

    // 300ms of debounce before a keystroke becomes a query, which is why the wait is generous.
    await expect(await canvas.findByText("1 combo")).toBeInTheDocument();
    // The size the term left nothing of has no chip at all.
    await expect(canvas.queryByRole("button", { name: "3 cards" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "2 cards" })).toBeInTheDocument();
    // One row, and the pane fell through to it — the rail's headline and the pane's caption.
    await expect(canvas.getAllByText("Avacyn, Angel of Hope")).toHaveLength(2);
    await expect(canvas.queryByText("Boros Charm")).toBeNull();
  },
};

/**
 * A term that matches none of them — and it is the **filter's** empty, not a fifth sentence.
 *
 * The two sentences it must never borrow are claims about the reader's card and about their
 * database, and neither is true here: the card is in three combos and the feed is ingested.
 * `total` is over the unfiltered set and the search does not move it, which is what keeps this
 * branch reachable with a term in the box *and* keeps the controls that did the narrowing on
 * screen above the line saying so. The rail goes with the list, because there is no list.
 */
export const SearchedToNothing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("3 combos");
    await userEvent.type(canvas.getByLabelText("Search these combos"), "krark-clan");

    await expect(await canvas.findByText(/no combo matches that filter/i)).toBeInTheDocument();
    await expect(canvas.queryByText(/none on record naming this card/i)).toBeNull();
    await expect(canvas.queryByText(/has not been downloaded/i)).toBeNull();
    // The way back is still on screen; the rail and the pane are not.
    await expect(canvas.getByRole("button", { name: "All" })).toBeInTheDocument();
    await expect(canvas.queryByRole("list", { name: "Combos" })).toBeNull();
  },
};

/**
 * The same three combos, narrowed to the two-card ones.
 *
 * **The census a chip exists by does not move when the chip is pressed** — `byCardCount` is a
 * census of the *searched* set and the box is empty here, where `matching` is that set with the
 * chips applied — so the `3 cards` chip is still drawn with its own size emptied out of the list.
 * A row of controls that rewrote itself the moment one was used would be unreadable, and the chip
 * doing the emptying is the way back out of it. {@link Searched} is the other side of the same
 * rule: a *term* does move it, because a term changes the subject.
 */
export const Filtered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("3 combos");
    await userEvent.click(canvas.getByRole("button", { name: "2 cards" }));

    await expect(await canvas.findByText("2 combos")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "2 cards" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The three-card row has gone from the rail — read off its headline, which is the *other*
    // pieces and therefore the one string only that row draws.
    await expect(canvas.queryByText("Boros Charm + Spitemare")).toBeNull();
    // And its chip is still there, because the census is not the list.
    await expect(canvas.getByRole("button", { name: "3 cards" })).toBeInTheDocument();
  },
};

/**
 * A card in far more combos than one page holds — the ordinary case for a staple, not a stress
 * test.
 *
 * **Paging is scrolling now.** There is no *Show more*: a sentinel sits at the foot of the rail's
 * scroller and an `IntersectionObserver` rooted on it asks for the next fifty when it comes into
 * view. In Storybook's own browser that is live and this rail really does grow to sixty.
 *
 * **Under `src/stories.test.tsx` it can never fire**, because `src/test-setup.ts` stubs
 * `IntersectionObserver` to a no-op — so the assertions below are deliberately about the **first
 * page only**, and the row count is a floor rather than an equality. A `toHaveLength(50)` would be
 * a story that passed in jsdom and failed in the browser it is written for, which is the worst of
 * both.
 */
export const ManyCombos: Story = {
  args: { stage: "many" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // `matching` is the whole list however much of it has been fetched, so this figure is the
    // same in both environments.
    await expect(await canvas.findByText("60 combos")).toBeInTheDocument();
    const rail = canvas.getByRole("list", { name: "Combos" });
    expect(within(rail).getAllByRole("button").length).toBeGreaterThanOrEqual(50);

    // The head of the first page, selected on open…
    await expect(within(rail).getByRole("button", { name: ROW_MANY_FIRST })).toHaveAttribute(
      "aria-current",
      "true",
    );
    // …and its foot, which the first request answered with and no observer had to ask for.
    await expect(canvas.getByText("Boros Charm 50")).toBeInTheDocument();
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
    // And no filter band over it: `total` is 0, so there is nothing for a chip to be a facet of.
    await expect(canvas.queryByRole("button", { name: "All" })).toBeNull();
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
