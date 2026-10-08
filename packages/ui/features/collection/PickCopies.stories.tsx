import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { PickCopies, type CopyChoice } from "./PickCopies";

/**
 * `collection_folders.rs`'s own refusal, copied rather than imported — the webview never sees the
 * Rust constant, and a fixture that invented a friendlier sentence would be a workbench showing a
 * screen the app cannot draw.
 */
const IN_A_DECK = "Those copies are in a deck. Cut the card from the deck to get them back.";

function copy(over: Partial<CopyChoice> & { entryId: number }): CopyChoice {
  return {
    finish: "Nonfoil",
    condition: "NM",
    lang: "en",
    quantity: 1,
    folderName: null,
    blocked: null,
    ...over,
  };
}

const meta = {
  title: "Collection/Pick copies",
  component: PickCopies,
  tags: ["autodocs"],
  args: {
    cardName: "Lightning Bolt",
    destination: "Trade binder",
    copies: [copy({ entryId: 1 })],
    onConfirm: fn(),
    onCancel: fn(),
  },
  decorators: [
    /**
     * The box this component deliberately does not draw.
     *
     * `PickCopies` is `MoveToFolder`'s `inline` shape: it has been drawn *into* a surface that is
     * already open, so it carries no border, no background, no shadow, no width and no z-index —
     * those are one statement ("I am a popup") and they belong to whoever the drop opened. The
     * workbench has to supply them or every story below would be judged against a panel the app
     * never renders. 18rem is the narrow end of what a host gives it, which is where the rows
     * have to survive.
     */
    (Story) => (
      <div className="w-72 rounded-lg border border-border bg-surface p-2 shadow-lg">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The question a drop asks when the tile a reader let go of stands for more than one " +
          "row. A collection tile merges every entry for one printing across finishes, " +
          "conditions, languages and folders (`CollectionPage`'s `tiles` memo), so the picture " +
          "being dragged is very often several `collection_entries` rows — and filing *the " +
          "card* is not a thing the app can do without choosing. The drag says **where**; only " +
          "the reader knows **which**.\n\n" +
          "**Every copy it can move starts ticked**, because the commonest answer by far is " +
          "\"all of them\": a reader who dragged the card meant the card. What the ticks buy is " +
          "the ability to say *fewer*, which is the answer nothing else on this screen can " +
          "express.\n\n" +
          "**Presentational and nothing else.** It holds which rows are ticked and holds no " +
          "mutation, no query and no layer — the host owns the write, the box and the Escape " +
          "rung. The app's Escape ladder is a handshake between registered layers, so a " +
          "document-level key listener in here would be an unregistered rung closing a surface " +
          "it did not open.\n\n" +
          "**The button counts copies, not rows.** One entry can be `2 copies`, so a press " +
          "reported as \"Move 1 copy\" would be counting the wrong thing at the moment it " +
          "happens — it is `sum(quantity)`, the same arithmetic the tile behind it does, so the " +
          "picker and the wall can never count one printing two ways.\n\n" +
          "**No `play` functions here on purpose**: story plays are not runnable while this " +
          "feature is being built in parallel, and every claim below is asserted in " +
          "`PickCopies.test.tsx` instead. Add plays when the wiring lands, not before.",
      },
    },
  },
} satisfies Meta<typeof PickCopies>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * One copy, which is the case the page is **not** supposed to open this for.
 *
 * A tile standing for a single entry is a drop the host can carry out without asking, so this is
 * the shape rather than the flow: it is what the picker looks like when a reader unticks their
 * way down to one, and it is where the singular is checked. `1 copy`, never `1 copies` — the app
 * must never print that, and `plural` is passed the irregular rather than deriving it.
 *
 * `Collection` is what a `null` folder is drawn as: the top level is a real place with a name the
 * reader already knows from the breadcrumb, not the absence of one.
 */
export const OneCopy: Story = {};

/**
 * The case this exists for: one printing, filed four ways.
 *
 * Two of these rows are in the same binder and two are in the same condition — what tells any of
 * them from the others is the **folder**, which is why `folderName` is on the row at all. Take it
 * out and the second and fourth rows are one sentence written twice, which is a picker no answer
 * can be given to.
 *
 * The language is drawn only where it is not English. `EN` on ninety-odd per cent of rows is a
 * column of noise that pushes the term actually doing the disambiguating off the end of a narrow
 * panel; a `JA` beside the condition is a fact worth a word.
 *
 * Five rows holding **seven copies**, so the button reads `Move 7 copies` — the arithmetic that
 * makes the difference between counting rows and counting cardboard visible at a glance.
 */
export const SeveralCopies: Story = {
  args: {
    copies: [
      copy({ entryId: 1, quantity: 2 }),
      copy({ entryId: 2, finish: "Foil", folderName: "Trade binder" }),
      copy({ entryId: 3, condition: "LP", quantity: 2, folderName: "Bulk box" }),
      copy({ entryId: 4, condition: "NM", lang: "ja", folderName: "Trade binder" }),
      copy({ entryId: 5, finish: "Etched", condition: "MP", folderName: "Sealed" }),
    ],
  },
};

/**
 * One copy in a deck's group among three that are free.
 *
 * A copy sitting in a deck's group cannot be filed by hand — the deck would go on listing a card
 * whose copies had walked off — so the row is drawn, out of reach, unticked, and **saying why**.
 * `collection_folders.rs`'s sentence is what it says, and it names the way out rather than merely
 * refusing: cutting the card from the deck is the sanctioned route, and it lands the copies in
 * `Recently removed` where this same drag can then take them anywhere.
 *
 * **The reason is in the checkbox's own accessible name**, not only beside it. A greyed row whose
 * name is just its label reads to a screen reader — and to a test — as a row that is simply
 * missing, which is the failure this is drawn to avoid. The visible copy of the sentence is
 * `aria-hidden` for exactly that reason: the name already carries it, and a sentence read twice
 * running is one a reader stops trusting.
 *
 * The button counts the three it can move and leaves the fourth out of the arithmetic.
 */
export const OneBlocked: Story = {
  args: {
    copies: [
      copy({ entryId: 1, quantity: 2 }),
      copy({ entryId: 2, finish: "Foil", folderName: "Trade binder" }),
      copy({
        entryId: 3,
        condition: "LP",
        quantity: 2,
        folderName: "Burn",
        blocked: IN_A_DECK,
      }),
      copy({ entryId: 4, folderName: "Bulk box" }),
    ],
  },
};

/**
 * Every copy the reader owns is sleeved up, so there is nothing here to pick.
 *
 * **No checkboxes at all.** A column of ticks nobody can move is furniture that reads as a broken
 * picker, and an affirmative that can never be pressed is a second one — so the ticks and the
 * `Move` button both go, and the only control left is the way out.
 *
 * What stays is the list, because *which* copies are out of reach and *why* is the whole of what
 * this state has to say. Here the reasons are drawn plainly rather than hidden: with no checkbox,
 * there is no accessible name carrying them, so the sentence is read the ordinary way.
 */
export const AllBlocked: Story = {
  args: {
    copies: [
      copy({ entryId: 1, quantity: 2, folderName: "Burn", blocked: IN_A_DECK }),
      copy({ entryId: 2, finish: "Foil", folderName: "Storm", blocked: IN_A_DECK }),
    ],
  },
};

/**
 * A card whose name is longer than the panel is wide — Magic has several, and this is the real
 * one.
 *
 * The heading wraps rather than truncating, which is the opposite of what a folder tile does and
 * is right for the opposite reason: a tile is one of a wall of twenty and a clipped name there
 * costs a line the reader can recover with a hover, while this is a **question**, and a question
 * that has been cut off is one nobody can answer safely. The destination wraps with it, so the
 * two ends of the sentence — what is moving, and where — are always both on screen.
 *
 * The rows underneath keep their own arrangement: the face wraps inside the row and the tick
 * stays put at the top of it, so a two-line row still reads as one control.
 */
export const LongCardName: Story = {
  args: {
    cardName: "Asmoranomardicadaistinaculdacar",
    destination: "Cards I keep meaning to sleeve up",
    copies: [
      copy({ entryId: 1, quantity: 2 }),
      copy({ entryId: 2, finish: "Foil", condition: "HP", folderName: "Bulk box" }),
    ],
  },
};
