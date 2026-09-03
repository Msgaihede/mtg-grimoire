import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { CollectionRow, WishRow } from "@/lib/ipc";
import { transferCard } from "../fixtures";
import { fromCollectionRow, fromWishRow, type TransferCard } from "../TransferCard";
import { ExportDialog } from "./ExportDialog";
import { printing } from "../../../../.storybook/fake/fixtures";

/** How long a `waitFor` will wait for `Dialog`'s first frame — the shell's panel carries its
 *  `initial`, so nothing inside it is visible yet. `Decks/Dialog shell` has the whole reason and
 *  why the number is seconds; each file keeps its own copy because CSF would index an exported
 *  one as a story. */
const FRAME_WAIT = 5_000;

/**
 * The preview, read off the DOM rather than by role.
 *
 * It is a `<pre>` of generated text and has no role to be found by — and `getByText` is the wrong
 * tool for the same reason a regex matcher is: normalized text is matched against **every**
 * element, so a partial pattern finds the panel and the page as well as the block. `toHaveTextContent`
 * against this element is a substring test scoped to the one box that is supposed to hold it.
 */
function preview(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector("pre");
  if (el === null) throw new Error("the export dialog drew no preview");
  return el;
}

/**
 * Open the preview, which every story arrives with **shut** — see {@link ShutByDefault}.
 *
 * Every play below that reads a rendered line goes through this first, because the `<pre>` is
 * unmounted while the disclosure is shut rather than merely hidden. That is the point: a hidden
 * block still holding the text is exactly what lets a play assert a line no reader can see, and
 * {@link preview} would have found it and passed.
 */
async function expand(canvasElement: HTMLElement): Promise<void> {
  await userEvent.click(
    await within(canvasElement).findByRole("button", { name: /Show decklist/ }),
  );
}

/**
 * The pile being exported: printings out of the generated corpus rather than names typed here.
 *
 * Two in the pile, and with different set codes, because that is the smallest list that tells the
 * six formats apart — Arena, Moxfield and Archidekt name a printing where plain text and MTGO name
 * only a card, and CSV needs more than one row under its header to look like a file. The third is
 * the deck-scope story's cut pile ({@link SwitchedOffPile}): a category the reader has switched
 * off, which is the one card fact two of the six formats have nowhere to put.
 */
const BOLT = printing("2x2", "117");
const SOL_RING = printing("c21", "263");
const FOREST = printing("unf", "239");

/**
 * **The fixtures come from the corpus and the expected strings below are typed out, so the two
 * have to be pinned together.** This file's plays assert whole rendered lines — `1 Sol Ring (C21)
 * 263` — because the *shape* of a line is the thing under test, and a string derived from the same
 * row the writer derives it from would assert nothing about the format. The cost is that a wrong
 * `printing()` lookup shows up only as a spread of confusing play failures: `lea 288` looks like
 * Sol Ring and is **Island**, which is how this arrived. (No count here — every play below asserts
 * a line, so the number is a fact about this file's story list and would rot with the next one.)
 * So the pairing is checked here instead, at module
 * load, where the message says what happened — the same discipline `printing()` itself applies
 * when the corpus has no such row at all.
 */
if (BOLT.name !== "Lightning Bolt" || SOL_RING.name !== "Sol Ring" || FOREST.name !== "Forest") {
  throw new Error(
    `ExportDialog.stories: the fixture printings are ${BOLT.name}, ${SOL_RING.name} and ` +
      `${FOREST.name}; the expected export lines in this file are written for Lightning Bolt, ` +
      `Sol Ring and Forest.`,
  );
}

/**
 * One pile, which is the scope this dialog is opened in from a category heading's right-click.
 *
 * Every row carries the same three category fields because a pile has one name, one kind and one
 * switch — so the grouped formats write it as a single section, `Deck` in Arena's and Moxfield's
 * fixed vocabulary and `Ramp` in Archidekt's, which is the reader's own word for it.
 *
 * **`legalities` comes off the corpus row like every other field here**, and it is what
 * {@link OnlyCardsArenaHas} turns on: Lightning Bolt is `timeless: "legal"` and `historic:
 * "banned"` — Arena has it — while Sol Ring is playable in no Arena format at all, so the pair
 * is a filter with something to do rather than a checkbox over a list it cannot change.
 */
const CARDS: TransferCard[] = [
  transferCard({
    name: BOLT.name,
    quantity: 2,
    setCode: BOLT.setCode,
    collectorNumber: BOLT.collectorNumber,
    legalities: BOLT.legalities,
    categoryName: "Ramp",
    categoryKind: "main",
    categoryActive: true,
  }),
  transferCard({
    name: SOL_RING.name,
    quantity: 1,
    setCode: SOL_RING.setCode,
    collectorNumber: SOL_RING.collectorNumber,
    legalities: SOL_RING.legalities,
    categoryName: "Ramp",
    categoryKind: "main",
    categoryActive: true,
  }),
];

/**
 * The same pile plus a **switched-off** one, which is the deck-level scope: a whole deck holds
 * piles the reader has turned off, and `is_active = 0` is the whole of what a maybeboard is.
 *
 * Six copies on one row rather than six rows, deliberately — {@link SwitchedOffPile} is what says
 * the omission line counts *cards* and not rows.
 */
const DECK_CARDS: TransferCard[] = [
  ...CARDS,
  transferCard({
    name: FOREST.name,
    quantity: 6,
    setCode: FOREST.setCode,
    collectorNumber: FOREST.collectorNumber,
    legalities: FOREST.legalities,
    categoryName: "Cuts",
    categoryKind: "main",
    categoryActive: false,
  }),
];

/**
 * A `CollectionRow` built the way `.storybook/fake/db.ts`'s `toCollectionRow` builds one —
 * `CollectionTable.stories.tsx`'s own `entry()`, copied rather than imported: that helper is not
 * exported, and every card-derived field it fills in is nullable in the real DTO regardless.
 * Every optional field is given a real value here, deliberately — {@link EveryFieldOn} is the
 * story that turns every checkbox this can feed on, and a `null` column reads identically whether
 * the field is off or merely empty.
 */
function collectionEntry(
  card: ReturnType<typeof printing>,
  over: Partial<CollectionRow> = {},
): CollectionRow {
  return {
    promoTypes: null,
    // The corpus's own blob, so the Arena filter answers over real legalities.
    legalities: card.legalities,
    // At the root: export carries cards, and a folder is not one.
    folderId: null,
    folderName: null,
    id: 1,
    cardId: card.id,
    name: card.name,
    oracleId: card.oracleId,
    setCode: card.setCode,
    setName: card.setName,
    collectorNumber: card.collectorNumber,
    lang: card.lang,
    rarity: card.rarity,
    manaCost: card.manaCost,
    typeLine: card.typeLine,
    layout: card.layout,
    finish: "nonfoil",
    condition: "NM",
    quantity: 1,
    tradelistQuantity: 0,
    unitPrice: 4.5,
    purchasePrice: 3.25,
    purchaseCurrency: "USD",
    acquiredAt: "2026-06-01",
    acquisitionSource: "LGS",
    serialNumber: null,
    altered: false,
    signed: false,
    proxy: false,
    misprint: false,
    grading: null,
    tags: "[]",
    notes: "sleeved",
    needsReview: null,
    updatedAt: 1_786_266_000,
    ...over,
  };
}

/** Two entries the collection surface can carry every field of — a foil, graded and altered
 *  Lightning Bolt and a played Sol Ring with the collection's own free-text tags on it — via
 *  `fromCollectionRow`, the same adapter
 *  `CollectionPage` reads its export scope through. */
const COLLECTION_CARDS: TransferCard[] = [
  fromCollectionRow(
    collectionEntry(BOLT, {
      id: 1,
      finish: "foil",
      condition: "LP",
      quantity: 2,
      tradelistQuantity: 1,
      grading: "PSA 9",
      altered: true,
      signed: true,
      tags: '["playset"]',
      notes: "corner ding",
    }),
  ),
  fromCollectionRow(
    collectionEntry(SOL_RING, {
      id: 2,
      finish: "nonfoil",
      condition: "MP",
      quantity: 1,
      tradelistQuantity: 0,
      purchasePrice: 1.1,
      purchaseCurrency: "EUR",
      acquiredAt: "2026-02-14",
      acquisitionSource: "Trade",
      serialNumber: "007",
      proxy: false,
      misprint: true,
      tags: "[]",
      notes: null,
    }),
  ),
];

/** A `WishRow` for the two printings above, via `fromWishRow` — no condition, no acquisition
 *  story, exactly as {@link ../TransferCard}'s doc says a wishlist row cannot carry either. */
function wishRow(card: ReturnType<typeof printing>, over: Partial<WishRow> = {}): WishRow {
  return {
    id: 1,
    legalities: card.legalities,
    oracleId: card.oracleId,
    cardId: card.id,
    // The root of the wishlist. Nothing an export draws reads it — a decklist has no notion of
    // where a wish was filed — but `WishRow` answers it on every row, so a fixture has to say.
    folderId: null,
    name: card.name,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    lang: card.lang,
    rarity: card.rarity,
    manaCost: card.manaCost,
    typeLine: card.typeLine,
    artCardId: card.id,
    quantity: 1,
    preferredFinish: null,
    unitPrice: 4.5,
    ownedQuantity: 0,
    // No other wish for this oracle card. Same reason as `folderId` above: unread here, and
    // required by the type.
    elsewhere: 0,
    notes: null,
    needsReview: null,
    updatedAt: 1_786_266_000,
    ...over,
  };
}

const WISHLIST_CARDS: TransferCard[] = [
  fromWishRow(wishRow(BOLT, { id: 1, quantity: 4, preferredFinish: "foil", notes: "for Burn" })),
  fromWishRow(wishRow(SOL_RING, { id: 2, quantity: 1, preferredFinish: null, notes: null })),
];

/**
 * A pile of cards as text: a format, a live preview, Copy, and Save as….
 *
 * **Two controls open it and only the `cards` prop tells them apart.** A deck category's
 * right-click opens it over one pile, which is every story on this page bar one; the editor
 * header's `Export deck` opens it over the whole variant on screen, which is
 * {@link SwitchedOffPile} — a deck holds piles the reader has switched off and one pile does not.
 * Taking the cards as a **prop** is what made the second control a caller rather than a rewrite.
 * Nothing on this page reaches the deck at all.
 *
 * **Built on `Dialog`**, the deck surface's shared modal shell, rather than carrying its own
 * copy of the chrome; the body lives one floor down, so `open={false}` mounts nothing at all —
 * no format state, no memoized preview text. See {@link Closed}.
 *
 * ## What a story can drive here, and what it cannot
 *
 * The **file picker's own half is unverifiable in a browser** — `dialog:allow-save` opens a native
 * window CDP cannot reach — so what the workbench stands in for is the *answer*: the fake's
 * command table carries `plugin:dialog|save`, which hands back a path under `D:\Storybook\` built
 * from the dialog's own `defaultPath`. That is not the same decision as the importer's picker,
 * which throws: there the invented thing would be the **decklist**, and here it is a file name
 * over text the reader is already looking at. So {@link SaveRefused} really does travel
 * press → path → `export_write_file` → the refusal drawn in the app's own words.
 *
 * The one arm still out of reach is **Cancel**, which resolves `null` — writing *that* string to
 * disk is the trap this dialog's guard exists for, and `ExportDialog.test.tsx` pins it by mocking
 * `save` directly. A `null` from the fake would make every save story a story about Cancel.
 *
 * **Its own frame per docs story**, like every dialog here: the shell's scrim is `fixed inset-0`,
 * so rendered inline it would cover the whole docs page rather than its own block. The iframe
 * buys a second thing this page needs — one fake world per story, so the world
 * {@link SaveRefused} refuses in cannot be the world another story's press is answered from.
 */
const meta = {
  title: "Transfer/Export dialog",
  component: ExportDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    subject: "Ramp",
    surface: "deck",
    cards: CARDS,
    suggestedFileName: "Ramp",
    onDismiss: fn(),
    onClose: fn(),
  },
  parameters: {
    layout: "fullscreen",
    docs: { story: { inline: false, height: "600px" } },
  },
} satisfies Meta<typeof ExportDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **Plain text**, which is what the dialog opens on — `quantity name`, and nothing about the
 * printing.
 *
 * The formats are drawn in `EXPORT_FORMATS`' own order and deliberately **not** through
 * `sortOptions`: plain first is the one most readers want, the same kind of deliberate order the
 * app's option-list rule exempts a grade scale for. They are a `radiogroup`, because picking one
 * is picking *instead of* the others and the preview under them is a single answer. The row
 * **maps that array** rather than listing them, so this play counts the writers `format.ts` has.
 */
export const PlainText: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: 'Export "Ramp"' });

    // The panel's arrival, waited out once — everything under it lands in the same tick. See
    // {@link FRAME_WAIT}.
    await waitFor(async () => await expect(dialog).toBeVisible(), { timeout: FRAME_WAIT });

    const group = canvas.getByRole("radiogroup", { name: "Export format" });
    const formats = within(group).getAllByRole("radio");
    await expect(formats.map((r) => r.textContent)).toEqual([
      "Plain text",
      "MTGO",
      "Arena",
      "Moxfield",
      "Archidekt",
      "TCGplayer",
      "CSV",
    ]);
    await expect(formats[0]).toHaveAttribute("aria-checked", "true");

    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent("2 Lightning Bolt 1 Sol Ring");
  },
};

/**
 * **MTGO**, which for a main-deck pile writes exactly what plain text does — and that is the
 * format's own answer rather than a gap here.
 *
 * MTGO's export omits the printing entirely: it resolves a name against whatever copies a player
 * owns rather than pinning one, so naming a set would be a promise this format was never in a
 * position to keep — MTGO's defaults leave `setCode`/`collectorNumber` off `writeLine`'s field
 * set, the same way plain text's do. What MTGO adds on top is a per-line `SB:` prefix on a
 * sideboard or a companion — a one-line override rather than a heading, which is exactly how
 * this app's own importer reads it back. A one-pile export has none, so the two agree here.
 */
export const Mtgo: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "MTGO" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "MTGO" }));
    await expect(canvas.getByRole("radio", { name: "MTGO" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent("2 Lightning Bolt 1 Sol Ring");
    // No set code anywhere in it — the whole of what makes this format different from Moxfield's.
    await expect(preview(canvasElement).textContent).not.toMatch(/2X2|C21/);
  },
};

/**
 * **Moxfield** — `quantity name (SET) collectorNumber` under a **section heading**, and one of
 * three formats here that name a printing rather than just a card.
 *
 * The set code is uppercased for the reason the importer uppercases the one it reads: `(2x2)` and
 * `(2X2)` are the same set, and a decklist this app writes should pick one spelling rather than
 * echo whatever case the row happened to store.
 *
 * **The heading is written even for a single section**, which is what makes this format different
 * from the plain paste above it: the vocabulary is fixed — `Commander`, `Companion`, `Deck`,
 * `Sideboard`, `Maybeboard`, in that ladder — so `Deck` is a fact about where these cards are
 * rather than a separator a one-pile file could do without. **Arena writes the identical text**;
 * the two differ only in what reaches the writer, which is {@link SwitchedOffPile}'s subject.
 */
export const Moxfield: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "Moxfield" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "Moxfield" }));
    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent(
      "Deck 2 Lightning Bolt (2X2) 117 1 Sol Ring (C21) 263",
    );
  },
};

/**
 * **Archidekt** — `1x`, a **lowercase** set code, and the pile's own name in brackets.
 *
 * Lowercase against every other writer here on purpose: it is what Archidekt itself emits, and the
 * point of a format named for a site is that the site reads it back. Our own parser uppercases
 * what it reads, so the round trip is unaffected either way.
 *
 * It is the one format whose headings are the **reader's** words rather than a fixed vocabulary —
 * grouped by `categoryName` in the caller's own array order, so a deck comes out filed the way the
 * reader filed it and nothing here re-files it on the way out. It is also the only one that can
 * say `{noDeck}`, which is what makes an export and a re-import keep a maybeboard; see
 * {@link SwitchedOffPile}.
 */
export const Archidekt: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "Archidekt" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "Archidekt" }));
    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent(
      "Ramp 2x Lightning Bolt (2x2) 117 [Ramp] 1x Sol Ring (c21) 263 [Ramp]",
    );
  },
};

/**
 * The same pile with the reader's own **labels** on it — `deck_labels` rows, one per card.
 *
 * Two of them, because one box is not a choice: the Bolt is a keeper and the Sol Ring is a cut
 * candidate, in the two colours the reader gave them.
 */
const LABELLED_CARDS: TransferCard[] = [
  transferCard({ ...CARDS[0], labelName: "Keeper", labelColor: "#4aab08" }),
  transferCard({ ...CARDS[1], labelName: "Cut candidate", labelColor: "#d3202a" }),
];

/**
 * **The deck's own labels, out.** Archidekt writes one per card as `^Keeper,#4aab08^`, which is
 * exactly the group this app's parser reads back — so a deck's labels survive a full round trip
 * through the one format that has a slot for them.
 *
 * **It is on by default here and nowhere else.** Archidekt's other four optional fields are on
 * too: this format's defaults are everything Archidekt can say, and the caret group is something
 * Archidekt itself emits. The reader unticking Label is what the box is for — a deck exported to
 * share is often a deck whose private "cut candidate" notes should stay at home.
 *
 * **There is no colour checkbox on this format, and that is not an omission.** The colour rides
 * *inside* the group, so a box for it would be a control that changed nothing; {@link Csv} is
 * where the colour is its own column and its own tick, because a cell holds one value.
 *
 * The label goes **last on the line**, after the bracket and after `*F*` — where Archidekt puts
 * it, and the order `parse.ts` peels decorations off the end.
 */
export const DeckLabels: Story = {
  args: { subject: "Atraxa", cards: LABELLED_CARDS, suggestedFileName: "Atraxa" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "Archidekt" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "Archidekt" }));
    await expect(canvas.getByRole("checkbox", { name: "Label" })).toBeChecked();
    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent(
      "Ramp 2x Lightning Bolt (2x2) 117 [Ramp] ^Keeper,#4aab08^ " +
        "1x Sol Ring (c21) 263 [Ramp] ^Cut candidate,#d3202a^",
    );

    // Unticked, the lines are what they were before labels existed — the box is a real control
    // over the file rather than a decoration on the panel.
    await userEvent.click(canvas.getByRole("checkbox", { name: "Label" }));
    await expect(preview(canvasElement)).toHaveTextContent(
      "Ramp 2x Lightning Bolt (2x2) 117 [Ramp] 1x Sol Ring (c21) 263 [Ramp]",
    );
  },
};

/**
 * **TCGplayer Mass Entry** — `quantity name [SET] collectorNumber`, which is a **cart** rather
 * than a decklist, and that is what decides all three of the ways it differs from the writers
 * above it.
 *
 * Mass Entry reads every line as one item and has no section vocabulary at all, so this format
 * writes a **flat** list: a heading here would be read as a card nobody sells. It has nowhere to
 * put a maybeboard either — and unlike Arena and MTGO it does not *lose* one, because a pile the
 * reader switched off is usually exactly the half they still have to buy. So every row is
 * written and the omission line never fires for this format; {@link SwitchedOffPile} is where
 * the two other flat formats answer differently.
 *
 * The set code goes in **square brackets** with the collector number bare after it, which is the
 * most specific of the three shapes TCGplayer documents — the cart then lands on the printing the
 * deck names rather than on whatever art is cheapest. There is no finish marker: a printing's
 * foil is chosen in the cart, so `*F*` here would be a word Mass Entry read as part of the name.
 *
 * **The one write-only format** (CSV stopped being one in Task 10 — see {@link Csv} and
 * `docs/reference/import-export.md`) — measured rather than assumed, in `format.test.ts`. Our
 * own parser's bracket is anchored to the end of the line, so a bracket with a number after it
 * is not a bracket to it and the whole tail lands in the card's name.
 */
export const Tcgplayer: Story = {
  args: { subject: "Atraxa", cards: DECK_CARDS, suggestedFileName: "Atraxa" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "TCGplayer" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "TCGplayer" }));
    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent(
      "2 Lightning Bolt [2X2] 117 1 Sol Ring [C21] 263",
    );

    // The switched-off pile is in the cart with everything else, and nothing is said about
    // omissions because nothing was omitted.
    await expect(preview(canvasElement)).toHaveTextContent("6 Forest [UNF] 239");
    await expect(canvas.queryByText(/not written in this format/)).toBeNull();
    // Flat: not one of the section words the grouped formats write.
    await expect(preview(canvasElement).textContent).not.toMatch(/Deck|Maybeboard|Cuts/);
  },
};

/**
 * **CSV**, with the header row a spreadsheet needs.
 *
 * A field is quoted only when it carries a comma, a quote or a newline — never otherwise, so
 * `Lightning Bolt` stays `Lightning Bolt` rather than becoming `"Lightning Bolt"` on every row.
 * The extension changes with it (`.csv`), which is what the save dialog is seeded with. The last
 * column is the pile's own name, which is how a spreadsheet keeps the filing the five text
 * formats say with a heading.
 *
 * **It reads as well as writes, since Task 10** — `parse.ts` detects a header by content (two
 * known columns, one of which is Name) and then checks the next row's own field count agrees
 * before it trusts the verdict, which is what stops a plain line like `"Quantity, Name"` being
 * mistaken for one. TCGplayer is the one format left that is write-only; the full rule and the
 * CSV header vocabulary are in `docs/reference/import-export.md`.
 *
 * **An empty pile is an empty string in every format, this one included**: a header over no rows
 * is a file that claims to be a decklist and is not one. See {@link EmptyPile}.
 */
export const Csv: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "CSV" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "CSV" }));
    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent(
      "Quantity,Name,Set,Collector number,Category",
    );
    await expect(preview(canvasElement)).toHaveTextContent("2,Lightning Bolt,2x2,117,Ramp");
    // The set code is **not** uppercased here, unlike Moxfield's: a CSV column is data for
    // something else to read, and the row's own spelling is what it stores.
    await expect(preview(canvasElement)).toHaveTextContent("1,Sol Ring,c21,263,Ramp");
  },
};

/**
 * A deck with a **switched-off pile** in it, and the one sentence Arena and MTGO owe the reader
 * because of it.
 *
 * `is_active = 0` is the whole of what a maybeboard is here, and the formats divide on whether
 * they have anywhere to put one. **Arena and MTGO do not** — writing a maybeboard into an Arena
 * deck produces an illegal import at the other end — so they write only the piles that are
 * switched on, and the dialog says how many cards that cost **in copies**: six Forests on one row
 * are six cards missing from the file, and "1 card" would be a true statement about the array and
 * a false one about the deck. **Moxfield has a `Maybeboard` section and Archidekt has `{noDeck}`**,
 * so both write the pile and leave nothing out — and the line goes with the format that needed it.
 *
 * **Not a `role="alert"`, deliberately**: nothing failed. It is a fact about the text underneath
 * it, which is why it sits between the radios and the preview rather than down beside the two
 * failure lines — and why it has to be on screen *before* Copy is pressed rather than after.
 */
export const SwitchedOffPile: Story = {
  args: { subject: "Atraxa", cards: DECK_CARDS, suggestedFileName: "Atraxa" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "Arena" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "Arena" }));
    await expect(
      canvas.getByText("6 cards in switched-off piles are not written in this format."),
    ).toBeVisible();
    // **The sentence is on screen with the preview still shut**, which is the whole of why it is
    // said beside the format rather than over the text: a reader who never opens the decklist can
    // still press Copy, and this is the only thing that tells them what the file will be missing.
    await expect(canvas.getByRole("button", { name: /Show decklist/ })).toBeVisible();

    await expand(canvasElement);
    // Said before Copy could be pressed, and true of the text on screen: no Forest in it.
    await expect(preview(canvasElement).textContent).not.toMatch(/Forest/);

    // Moxfield puts the cut pile in its maybeboard, so nothing is left out and the line goes.
    await userEvent.click(canvas.getByRole("radio", { name: "Moxfield" }));
    await expect(preview(canvasElement)).toHaveTextContent("Maybeboard 6 Forest (UNF) 239");
    await expect(canvas.queryByText(/not written in this format/)).toBeNull();

    // Archidekt keeps the reader's own word for the pile and flags it, which is what makes an
    // export and a re-import agree about a maybeboard.
    await userEvent.click(canvas.getByRole("radio", { name: "Archidekt" }));
    await expect(preview(canvasElement)).toHaveTextContent(
      "Cuts 6x Forest (unf) 239 [Cuts{noDeck}]",
    );
    await expect(canvas.queryByText(/not written in this format/)).toBeNull();
  },
};

/**
 * **Only cards MTG Arena has** — the Arena format's own filter, issue #192.
 *
 * A paper collection is mostly cards Arena has never printed, and an Arena decklist naming one is
 * a line the game cannot resolve. The checkbox leaves them out. `export/arena.ts` is the whole of
 * what "them" means and carries the measurements; the two things to see here are that it is
 * offered by **one** format and that what it holds back is said out loud.
 *
 * **It is not a field, which is why it is not in the `Fields` row.** A field says what a line
 * says about a card; this says which cards there are lines for. It sits under the format radios
 * in a row of its own, shaped after the collection and wishlist scope checkbox one rung up.
 *
 * **Off when the dialog opens**, on every surface: this format has written every card handed to
 * it since it shipped, and a filter that started on would quietly change what an existing
 * reader's next export contains. The count line under it is how they find the box — and it is
 * the twin of the switched-off-pile line above in every respect, `text-dim` rather than an
 * alert because nothing has failed, and in **copies** because two copies of a card Arena lacks
 * are two lines that will not be in the file.
 *
 * The fixture is the deck scope, so both omission lines are reachable: Sol Ring is playable in no
 * Arena format, and the six Forests are in a pile the reader switched off.
 */
export const OnlyCardsArenaHas: Story = {
  args: { subject: "Atraxa", cards: DECK_CARDS, suggestedFileName: "Atraxa" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "Arena" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    // One format offers it. Plain text is what the dialog opens on, and it has no such question.
    await expect(canvas.queryByRole("checkbox", { name: "Only cards MTG Arena has" })).toBeNull();

    await userEvent.click(canvas.getByRole("radio", { name: "Arena" }));
    const box = canvas.getByRole("checkbox", { name: "Only cards MTG Arena has" });
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();

    // Untouched, the format writes what it always did — Sol Ring included.
    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent(
      "Deck 2 Lightning Bolt (2X2) 117 1 Sol Ring (C21) 263",
    );
    await expect(canvas.queryByText(/not in MTG Arena/)).toBeNull();

    await userEvent.click(box);
    // Lightning Bolt stays: it is banned in Historic and legal in Timeless, and Arena plainly
    // has the card — which is why the rule is "playable in *an* Arena format" rather than
    // "legal in Arena".
    await expect(preview(canvasElement)).toHaveTextContent("Deck 2 Lightning Bolt (2X2) 117");
    await expect(preview(canvasElement).textContent).not.toMatch(/Sol Ring/);
    await expect(canvas.getByText("1 card is not in MTG Arena and is not written.")).toBeVisible();

    // The two lines count different things and never the same card twice: the six Forests are
    // held back by their switched-off pile, the one Sol Ring by the filter.
    await expect(
      canvas.getByText("6 cards in switched-off piles are not written in this format."),
    ).toBeVisible();

    // Leaving the format takes the question with it, and nothing else's export is narrowed.
    await userEvent.click(canvas.getByRole("radio", { name: "Moxfield" }));
    await expect(canvas.queryByRole("checkbox", { name: "Only cards MTG Arena has" })).toBeNull();
    await expect(preview(canvasElement)).toHaveTextContent("1 Sol Ring (C21) 263");

    // And coming back finds it still ticked — unlike the field set, which is re-derived from
    // each format's own defaults.
    await userEvent.click(canvas.getByRole("radio", { name: "Arena" }));
    const again = canvas.getByRole("checkbox", { name: "Only cards MTG Arena has" });
    await expect(again).toBeChecked();

    // Put it back, and it is the *store* being put back rather than this canvas: `exportPrefs`
    // is `useAppStore`'s and outlives a story, so a play that left it ticked would decide what
    // the next Arena story on this page exports.
    await userEvent.click(again);
    await expect(preview(canvasElement)).toHaveTextContent("1 Sol Ring (C21) 263");
  },
};

/**
 * Copy, and the status line that is a **claim about the clipboard's contents**.
 *
 * It is cleared the moment that claim could go stale. Switching format redraws the preview and
 * does nothing at all to the clipboard, which still holds whatever text was on screen at the last
 * Copy — so the radios clear `copied` on every press rather than leaving "Copied." sitting beside
 * text it is no longer true of. (Found in review, 2026-08-14.)
 *
 * The clipboard goes through `tauri-plugin-clipboard-manager` rather than `navigator.clipboard`,
 * so it is a real command that can be refused; the fake answers `write_text` and this story is the
 * accepted half. `ExportDialog.test.tsx` covers the rejection, which reports through the same
 * `role="alert"` a refused save uses.
 */
export const Copied: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("button", { name: "Copy" })).toBeVisible(),
      {
        timeout: FRAME_WAIT,
      },
    );

    await userEvent.click(canvas.getByRole("button", { name: "Copy" }));
    await waitFor(
      async () => await expect(canvas.getByRole("status")).toHaveTextContent("Copied."),
    );

    // The claim goes with the text it was about.
    await userEvent.click(canvas.getByRole("radio", { name: "CSV" }));
    await waitFor(async () => await expect(canvas.queryByRole("status")).toBeNull());
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * **Save as…**, all the way through: the picker's answer, then Rust writing at it.
 *
 * Rust writes the file because `dialog:allow-save` answers a *path* and nothing more, and writing
 * bytes at that path from the page would need an `fs:` permission this app grants nowhere — the
 * same shape `deck_set_cover_image` established in the other direction.
 *
 * Nothing is drawn on success, deliberately: the file is on disk and the dialog stays where it
 * was. So the whole of the happy path is that **no alert appeared**, which is exactly what a
 * reader sees — and {@link SaveRefused} is the control that makes that assertion able to fail:
 * the same press, one fault apart, really does draw one.
 */
export const Saved: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("button", { name: "Save as…" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    const button = canvas.getByRole("button", { name: "Save as…" });
    await userEvent.click(button);

    // **Wait for something positive first.** `queryByRole("alert")` is null on the tick after the
    // press — before `save()`'s promise, the write and the `catch` have run — so a `waitFor` on
    // the absence alone is satisfied by the very first poll and would stay green over a save that
    // failed a moment later. `aria-busy` is set synchronously by the press and cleared in the
    // `finally`, so waiting for it to go is waiting for the whole round trip to have finished.
    await waitFor(async () => await expect(button).not.toHaveAttribute("aria-busy"));
    await expect(canvas.queryByRole("alert")).toBeNull();

    // A saved export does not close the dialog either — the reader may want another format.
    await expect(args.onDismiss).not.toHaveBeenCalled();
    await expect(canvas.getByRole("dialog", { name: 'Export "Ramp"' })).toBeVisible();
    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent("2 Lightning Bolt");
  },
};

/**
 * The disk refusing the path the reader chose — a read-only stick, a folder that has since gone.
 *
 * **Reported, and not fatal to the dialog.** The reader's text is still on screen and still
 * copyable, so a refused write must not throw either away: the sentence lands in a `role="alert"`
 * beneath the buttons and everything else stays exactly where it was.
 *
 * The words are `export.rs`' own, through `ipcError` — `could not write {path}: {os error}` — and
 * the **path is half of it**, which is why the fake's refusal names the file rather than
 * apologising in general terms. The `exportWriteError` fault is the only way to reach it.
 */
export const SaveRefused: Story = {
  parameters: { fake: { fault: "exportWriteError" } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("button", { name: "Save as…" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("button", { name: "Save as…" }));

    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent("Could not save that export");
    // The file the reader named, and the reason — both halves of the sentence.
    await expect(alert).toHaveTextContent("Ramp.txt");
    await expect(alert).toHaveTextContent("Access is denied");

    // Everything the reader could still act on is untouched.
    await expect(args.onDismiss).not.toHaveBeenCalled();
    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent("2 Lightning Bolt");
    await expect(canvas.getByRole("button", { name: "Copy" })).toBeVisible();
  },
};

/**
 * A pile with nothing in it — **an empty string in every format, CSV's header included**.
 *
 * A header row over no rows is a file that claims to be a decklist and is not one, so `formatExport`
 * answers `""` before it reaches a writer at all. The dialog still opens: an empty column is a
 * thing a reader can right-click, and a menu row that refused to open would be one they could not
 * tell from a broken one.
 */
export const EmptyPile: Story = {
  args: { subject: "Sideboard", cards: [], suggestedFileName: "Sideboard" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: 'Export "Sideboard"' });
    await waitFor(async () => await expect(dialog).toBeVisible(), { timeout: FRAME_WAIT });

    // The toggle says so before it is pressed: nothing is showing *and* there is nothing there.
    await expect(canvas.getByRole("button", { name: /decklist/ })).toHaveTextContent(
      "Show decklist (0 lines)",
    );

    await expand(canvasElement);
    await expect(preview(canvasElement).textContent).toBe("");
    await userEvent.click(canvas.getByRole("radio", { name: "CSV" }));
    await expect(preview(canvasElement).textContent).toBe("");
  },
};

/**
 * The **collection** surface — `surface: "collection"`, rows built with {@link fromCollectionRow}
 * rather than a bare `transferCard()`, the same adapter `CollectionPage` reads its export scope
 * through.
 *
 * **Opens on CSV, not plain text** — `useAppStore`'s `exportPrefs` seeds the collection at CSV
 * because it is the only format with a Condition channel, and a collection export with no
 * condition is a card list rather than a record of what the reader owns. The field row is the
 * intersection `availableFields` draws: `Condition` is offered here and nowhere a deck
 * export reaches, `Category` is offered nowhere on this surface at all — a collection row is not
 * filed anywhere, so there is no pile to name.
 */
export const Collection: Story = {
  args: {
    subject: "your collection",
    surface: "collection",
    cards: COLLECTION_CARDS,
    suggestedFileName: "collection",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: 'Export "your collection"' });
    await waitFor(async () => await expect(dialog).toBeVisible(), { timeout: FRAME_WAIT });

    await expect(canvas.getByRole("radio", { name: "CSV" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const fields = canvas.getByRole("group", { name: "Fields" });
    await expect(within(fields).getByRole("checkbox", { name: "Condition" })).toBeChecked();
    // No pile to name on this surface — `availableFields` never offers it here.
    await expect(within(fields).queryByRole("checkbox", { name: "Category" })).toBeNull();

    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent(
      "Quantity,Name,Set,Collector number,Finish,Condition",
    );
    await expect(preview(canvasElement)).toHaveTextContent("2,Lightning Bolt,2x2,117,foil,LP");
  },
};

/**
 * The **wishlist** surface — `surface: "wishlist"`, rows built with {@link fromWishRow}. Opens
 * on plain text, the format every surface but the collection remembers first.
 *
 * **No Condition, no Category, no Tradelist quantity** — a wish is cardboard the reader does not
 * own yet, so none of the collection's own facts about a physical copy exist here, and
 * `SURFACE_FIELDS.wishlist` never offers them.
 */
export const Wishlist: Story = {
  args: {
    subject: "your wishlist",
    surface: "wishlist",
    cards: WISHLIST_CARDS,
    suggestedFileName: "wishlist",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: 'Export "your wishlist"' });
    await waitFor(async () => await expect(dialog).toBeVisible(), { timeout: FRAME_WAIT });

    await expect(canvas.getByRole("radio", { name: "Plain text" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent("4 Lightning Bolt");
    await expect(preview(canvasElement)).toHaveTextContent("1 Sol Ring");

    await userEvent.click(canvas.getByRole("radio", { name: "CSV" }));
    const fields = canvas.getByRole("group", { name: "Fields" });
    await expect(within(fields).queryByRole("checkbox", { name: "Condition" })).toBeNull();
    await expect(within(fields).queryByRole("checkbox", { name: "Category" })).toBeNull();
    await expect(within(fields).queryByRole("checkbox", { name: "Tradelist quantity" })).toBeNull();
    await expect(within(fields).getByRole("checkbox", { name: "Notes" })).toBeInTheDocument();
  },
};

/**
 * **Every field the collection can carry, on, in CSV** — the tallest thing this dialog can draw.
 *
 * Not a hypothetical: this dialog already shipped one overflow bug where the panel grew past
 * the window and took Copy and Save as… off the bottom, reachable by neither pointer nor wheel —
 * `src/CLAUDE.md`'s clamp-the-panel paragraph. `jsdom` has no layout engine, so nothing this play
 * asserts can see that failure; what it *can* pin is that every column really does turn on and
 * really does write a value, which is the live pass's starting point at a short viewport.
 *
 * 24 columns for the collection surface — `SURFACE_FIELDS.collection`'s own length, never
 * written down twice: the play turns on every checkbox `Fields` draws rather than a count typed
 * here, so a field added to the registry is exercised by this story without anybody remembering
 * to update it.
 */
export const EveryFieldOn: Story = {
  args: {
    subject: "your collection",
    surface: "collection",
    cards: COLLECTION_CARDS,
    suggestedFileName: "collection",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: 'Export "your collection"' });
    await waitFor(async () => await expect(dialog).toBeVisible(), { timeout: FRAME_WAIT });
    await expect(canvas.getByRole("radio", { name: "CSV" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    const fields = canvas.getByRole("group", { name: "Fields" });
    for (const box of within(fields).getAllByRole("checkbox")) {
      if (!(box as HTMLInputElement).checked) await userEvent.click(box);
    }
    for (const box of within(fields).getAllByRole("checkbox")) {
      await expect(box).toBeChecked();
    }

    await expand(canvasElement);
    await expect(preview(canvasElement)).toHaveTextContent(
      "Quantity,Name,Set,Collector number,Finish,Condition,Language,Tradelist quantity," +
        "Purchase price,Purchase currency,Acquired,Acquired from,Serial number,Grading," +
        "Altered,Signed,Proxy,Misprint,Tags,Notes,Set name,Rarity,Type line,Price",
    );
    // Values from fields that carry nothing anywhere else in this file's fixtures, which is
    // what tells "the column is on" apart from "the column was always going to be empty".
    await expect(preview(canvasElement)).toHaveTextContent("PSA 9");
    await expect(preview(canvasElement)).toHaveTextContent("corner ding");
    await expect(preview(canvasElement)).toHaveTextContent("007");
  },
};

/**
 * **The preview opens shut**, which is what this dialog looks like the moment it is opened.
 *
 * A decklist is the tallest thing here and the least of what a reader came for: the two presses
 * that do the work are Copy and Save as…, and a whole-deck export put both of them a screenful
 * of text away from the format that chose them. Shut, the dialog is the format row, whatever the
 * format leaves out, the toggle and the buttons — and the **count in the toggle's own label** is
 * what a shut preview still owes the reader, so "nothing is showing" is never mistaken for
 * "nothing is there".
 *
 * It really is shut and not hidden: the `<pre>` is **unmounted**, which is why every play on this
 * page presses this button before reading a line. A hidden block still holding the text is
 * exactly the shape that lets a play assert a line no reader can see.
 */
export const ShutByDefault: Story = {
  args: { subject: "Atraxa", cards: DECK_CARDS, suggestedFileName: "Atraxa" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole("button", { name: /Show decklist/ });
    await waitFor(async () => await expect(toggle).toBeVisible(), { timeout: FRAME_WAIT });

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveTextContent("Show decklist (3 lines)");
    await expect(canvasElement.querySelector("pre")).toBeNull();
    // The presses that do the work are on screen with it — which is the point of the whole
    // change, since they were the two a tall export pushed out of reach.
    await expect(canvas.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Save as…" })).toBeVisible();

    await userEvent.click(toggle);
    await expect(preview(canvasElement)).toHaveTextContent("2 Lightning Bolt");
    const open = canvas.getByRole("button", { name: /Hide decklist/ });
    await expect(open).toHaveAttribute("aria-expanded", "true");
    // The pair is announced: while there is something to control, the button names it.
    await expect(open.getAttribute("aria-controls")).toBe(preview(canvasElement).id);

    // And it shuts again, taking the block back out of the tree rather than hiding it.
    await userEvent.click(open);
    await expect(canvasElement.querySelector("pre")).toBeNull();
  },
};

/**
 * Closed draws **no dialog at all** — not a scrim, not a panel, not an off-screen one.
 *
 * The body is passed to `Dialog` as an *element*, and an element React never puts in the tree
 * is a component that never ran — so the chosen format, the memoized preview and the copy status
 * all begin at the open, and every reopen starts on Plain text.
 *
 * **The play can only show the weaker half of that** and says so rather than implying more: a
 * `queryByRole` finding nothing is equally true of a panel that is merely hidden. What pins the
 * real claim is the shell's own first test, which renders a body reporting its mount through a spy.
 */
export const Closed: Story = {
  args: { open: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("dialog")).toBeNull();
  },
};
