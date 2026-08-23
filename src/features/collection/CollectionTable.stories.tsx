import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID } from "@/components/tooltip/TooltipProvider";
import { CONDITION_LABEL } from "@/lib/conditions";
import { finishPrice, type Finish } from "@/lib/finish";
import type { CollectionRow } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";

/** The default marketplace, and the as-of sentence it prints. Most of this file is about
 *  columns and rows rather than about which shop the number came from, so it names one and
 *  holds it still; the one story that is about the switch names the other. */
const TCG = MARKETPLACES.tcgplayer;
const PRICES_AS_OF = pricesAsOf(TCG);
const usdPrice = (value: number | null) => formatPrice(value, "usd");
import type { FakeCard } from "../../../.storybook/fake/cards";
import { MISSING, printing } from "../../../.storybook/fake/fixtures";
import { CollectionTable } from "./CollectionTable";

/** `collection_entries.id`. Its own counter rather than the shared fixtures' one, because these
 *  are entries and not deck rows — two tables, two id spaces. Nothing on this page reads it back:
 *  `CollectionTable.tsx` never touches `row.id` (grepped 2026-08-10), and every control it draws
 *  is addressed by its accessible name. */
let nextId = 1;

/**
 * One `collection_entries` row, joined to its card — a `CollectionRow` built the way
 * `.storybook/fake/db.ts`'s `toCollectionRow` builds one.
 *
 * Written here rather than imported because that function is not exported (grepped 2026-08-09:
 * `db.ts`'s eleven exports are its four row types, `Fault`, `FakeDb`, `makeDb`, `CLOCK_BASE` and
 * the three handler tables — no DTO builder among them). What is copied is the rule that
 * matters: every `cards`-derived field is
 * nullable and comes off the card, while `setCode`, `collectorNumber` and `lang` are the
 * **entry's own** — denormalised at write time so an entry survives its printing leaving the
 * database.
 *
 * The USD price goes through the app's own `finishPrice`, which is a lookup by finish in the
 * `prices` blob with **no fallback of any kind**: `cards.price_usd` is a nonfoil→foil→etched
 * chain built for sorting, and using it here would price a plain copy at foil rates.
 */
function entry(card: FakeCard, finish: Finish, over: Partial<CollectionRow> = {}): CollectionRow {
  return {
    promoTypes: null,
    legalities: card.legalities,
    id: nextId++,
    cardId: card.id,
    // Unfiled unless a story says otherwise, which is what most of a collection is: the Folder
    // column draws an em dash for the root.
    folderId: null,
    folderName: null,
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
    finish,
    condition: "NM",
    quantity: 1,
    tradelistQuantity: 0,
    // **One price, and it is what a TCGplayer read answers**: the marketplace is a query
    // parameter now, so a row carries the figure the backend already chose rather than a pair
    // for a cell to pick between. A story about another marketplace overrides this field with
    // that marketplace's number — see `InEuros` below, where the etched row is `null` because
    // `eur_etched` does not exist in Scryfall's data at all.
    unitPrice: finishPrice(card.prices, finish, "usd"),
    purchasePrice: null,
    purchaseCurrency: null,
    acquiredAt: null,
    acquisitionSource: null,
    serialNumber: null,
    altered: false,
    signed: false,
    proxy: false,
    misprint: false,
    grading: null,
    // Never null — the column defaults to `[]`.
    tags: "[]",
    notes: null,
    needsReview: null,
    updatedAt: 1_786_266_000,
    ...over,
  };
}

/**
 * Eight entries, in `collection::COLLECTION_DEFAULT_ORDER` — name, then set code, then the
 * collector number cast to an integer.
 *
 * Written in that order rather than sorted here, because **this component does not sort**: the
 * backend answers a page already ordered and the `sort` prop only tells the headers what to
 * draw. A story that handed rows in one order and a spec claiming another would be showing a
 * table that lies.
 *
 * Two of the eight are chosen for what they cannot say. Alpha Black Lotus has **no USD price
 * at all** — `usd`, `usd_foil` and `usd_etched` are every one of them null in the fixture, and
 * it is priced in euros (€38 719.86) and in tix — so its Value cell is an em dash rather than
 * `$0.00`, which is a price nobody quoted. The Double Masters Bolt is the four-copy row, which
 * is the only shape that draws the per-copy line under the total.
 */
const ROWS: CollectionRow[] = [
  entry(printing("2ed", "48"), "nonfoil"),
  entry(printing("lea", "232"), "nonfoil", { condition: "HP" }),
  entry(printing("gtc", "148"), "foil", { quantity: 2 }),
  entry(printing("mh2", "267"), "etched"),
  entry(printing("2x2", "117"), "nonfoil", { condition: "LP", quantity: 4 }),
  entry(printing("lea", "161"), "nonfoil", { condition: "MP" }),
  entry(printing("c21", "263"), "nonfoil"),
  entry(printing("mh2", "259"), "nonfoil", { quantity: 2 }),
];

/**
 * `reconcile::flag_unfoldable`'s sentence (`src-tauri/src/reconcile.rs:589-591`), with a card id
 * interpolated where the real one puts Scryfall's new id.
 *
 * The other kind of flag: this row's printing is **still in the database** and still draws its
 * name, its mana cost, its rarity and its price. A flag is a sentence, not a hiding place.
 */
const UNFOLDABLE =
  "Scryfall merged this printing into 0f0c1b0e-8e0d-4a2f-9f4b-2f5c9a1d3e77, but this entry " +
  "could not be moved there. It is unchanged — check it against your other entries for that " +
  "card.";

const meta = {
  title: "Collection/Table",
  component: CollectionTable,
  tags: ["autodocs"],
  args: {
    rows: ROWS,
    total: ROWS.length,
    listKey: "stories",
    sort: [],
    onSort: fn(),
    onNeedNextPage: fn(),
    onSetQuantity: fn(),
    onRemove: fn(),
    marketplace: TCG,
  },
  // A height, because the table is `min-h-0 flex-1` and expects a flex parent that has already
  // decided how tall the list is.
  decorators: [
    (Story) => (
      <div className="flex h-[26rem] max-w-[52rem] flex-col">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The collection as a table: one row per **entry**, and the quantity editable in " +
          "place. Per entry rather than per card because a foil in a sleeve and a played " +
          "nonfoil are two different things to own, priced differently and sold separately.\n\n" +
          "Six columns over the shared `VirtualTable`. Only the name flexes; everything else " +
          "holds something whose width is known, because a price column that squeezes is a " +
          "column nobody can scan. It was seven until the card pane opened beside it at " +
          "1280px — 6.5rem of per-copy price plus its gap was the difference between a name " +
          "column of 124px and one of 40 — so that figure moved into the Value cell, under " +
          "the number it multiplies into and only on rows where the two differ.\n\n" +
          "**This component sorts nothing.** `sort` tells the headers what to draw and " +
          "`onSort` reports one press; the rows arrive already ordered from " +
          "`collection::list_entries`. Every story below hands over rows in the order that " +
          "query would have returned them.",
      },
    },
  },
} satisfies Meta<typeof CollectionTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The ordinary list.
 *
 * **Rows are visible to a `play` here, and that is not free.** jsdom lays nothing out, so
 * `@tanstack/react-virtual` would measure the scroller at 0px and render no rows at all;
 * `src/stories.test.tsx`'s `beforeAll` stubs `offsetHeight`/`offsetWidth`/`scrollTo` for every
 * play in the repository, which is the same three lines `VirtualTable.test.tsx:14-18` uses. What
 * it does *not* buy is this app's viewport, so a `play` asserts the **presence of a named row
 * near the top** and never how many rows are in the DOM.
 *
 * The two figures in the Value cell are the arithmetic the header sorts by: the row's total, and
 * — only where the two are different numbers — what one copy costs, under it. On the
 * single-copy rows that are most of a collection the second line would be the same price
 * written twice.
 */
export const Rows: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The top row, found by the cell that identifies the printing. `2ED · 48` is the entry's
    // own denormalised set and number, which is what a collection row is addressed by.
    const top = canvas.getByText("2ED · 48").closest('[role="row"]');
    // The header is row 1, so the first entry is 2 — the only thing that can tell assistive
    // tech where in a virtualised list it is standing.
    await expect(top).toHaveAttribute("aria-rowindex", "2");
    await expect(within(top as HTMLElement).getByText("Ancestral Recall")).toBeInTheDocument();
    // The stepper writes straight through, and it is named for the **entry** rather than the
    // card: a collection holds a foil and a played nonfoil of one printing as two rows, and two
    // controls called "Quantity of Ancestral Recall" would be two a screen reader cannot tell
    // apart.
    await expect(
      canvas.getByRole("spinbutton", { name: "Quantity of Ancestral Recall (Nonfoil, NM)" }),
    ).toBeInTheDocument();
    // One copy at $4 999.95, so the total is the unit price and the per-copy line is absent.
    await expect(within(top as HTMLElement).getByText(usdPrice(4999.95))).toBeInTheDocument();
    await expect(within(top as HTMLElement).queryByText(/ ea$/)).toBeNull();
    // Urza's Saga is the two-copy row, where the pair *is* two numbers and both are drawn.
    const two = canvas.getByText("MH2 · 259").closest('[role="row"]');
    await expect(within(two as HTMLElement).getByText(usdPrice(79.72))).toBeInTheDocument();
    await expect(within(two as HTMLElement).getByText(`${usdPrice(39.86)} ea`)).toBeInTheDocument();
  },
};

/**
 * Nothing owned — and the table draws **no empty state of its own**.
 *
 * `CollectionPage` owns that sentence, because what an empty list means depends on why it is
 * empty (nothing added yet, or every filter excluding everything) and only the page knows which.
 */
export const Empty: Story = {
  args: { rows: [], total: 0 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // 0 rows plus the header. The count is of rows **matching the filters**, not rows in the
    // DOM — otherwise a virtualised list would tell assistive tech the collection holds 20
    // cards. A collection total is counted in full, so there is no unknown-count case here and
    // this is never `-1`.
    await expect(canvas.getByRole("table", { name: "Your collection" })).toHaveAttribute(
      "aria-rowcount",
      "1",
    );
    // Six columns still, but the sixth is `Folder` since v24 — it carries where the copy is
    // filed on *every* row, where the removal column it replaced drew nothing on all but the
    // rare emptied one. Its header is visible rather than `srOnlyHeader` for the same reason a
    // name was needed before: a column a reader cannot name is announced as "column 6".
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(6);
    await expect(canvas.getByRole("columnheader", { name: "Folder" })).toBeInTheDocument();
  },
};

/**
 * A flagged row, **listed and counted exactly as before**.
 *
 * `needs_review` is a sentence, not a flag: the reconciler writes what happened and the first
 * message wins, so a later sweep never overwrites an earlier one. Non-NULL means "listed,
 * counted, and asking to be looked at" — never "hidden".
 *
 * The band is drawn inside the **name's cell** rather than beside it, because a `<p>` among a
 * row's cells is not a cell and what is not a cell is not announced. It is one line, and the
 * row grows by 20px to hold it: `extraHeight` is what tells the virtualiser so, and without it
 * a flagged row would overlap the one below by exactly that band.
 *
 * The sentence here is `flag_unfoldable`'s, so the card behind it is still perfectly present —
 * name, mana cost, rarity, price and all. The row that has *lost* its printing is {@link Orphan}.
 */
export const NeedsReview: Story = {
  args: {
    rows: [
      entry(printing("mh2", "138"), "nonfoil", { needsReview: UNFOLDABLE }),
      ...ROWS.slice(0, 3),
    ],
    total: 4,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const flagged = canvas.getByText("MH2 · 138").closest('[role="row"]');
    // **Listed and counted**: the flagged row is the first row of the list, not a row moved to
    // the end and not a row left out. That is the whole of what "a sentence, not a flag" means.
    await expect(flagged).toHaveAttribute("aria-rowindex", "2");
    const row = within(flagged as HTMLElement);
    // The card is still perfectly present behind the sentence.
    await expect(row.getByText("Ragavan, Nimble Pilferer")).toBeInTheDocument();
    await expect(row.getByText(usdPrice(42.19))).toBeInTheDocument();
    // **Six cells, not seven.** The band is drawn *inside* the name's cell rather than beside
    // it, because a `<p>` among a row's cells is not a cell and what is not a cell is never
    // announced. Found by its own text: Testing Library's `getNodeText` concatenates only
    // *direct* text-node children, so the "Needs review:" prefix `<span>` beside it is excluded
    // and this matches the band's element exactly, the same element the tooltip is bound to.
    const cells = row.getAllByRole("cell");
    await expect(cells).toHaveLength(6);
    await expect(row.getByText(UNFOLDABLE).closest('[role="cell"]')).toBe(cells[0]);
    // The sentence reaches anything that reads text, clip or no clip — the band is one line and
    // this one is 182 characters, of which the *second* half is what to do about it. The
    // tooltip is what makes that half reachable by eye; `toHaveTextContent` is what proves it
    // is reachable at all.
    await expect(flagged).toHaveTextContent(UNFOLDABLE);
  },
};

/**
 * The printing has left `cards`, and the entry is still the user's.
 *
 * Every card-derived field is `null` — name, set name, rarity, mana cost, type line, layout,
 * and both prices — while `setCode`, `collectorNumber` and `lang` are intact, because those are
 * the **entry's own** columns, copied at write time for exactly this day. So the row still says
 * *which* piece of cardboard it is even though nothing can say what is printed on it.
 *
 * What that looks like: an em dash where the name goes (`row.name ?? "—"`), a set cell that
 * still reads `LEA · 232`, a `RarityGem` with no rarity, and a Value of `—` rather than `$0.00`.
 * The stepper's accessible name falls back to the card id, which is the only handle left.
 *
 * The sentence is `sweep_orphans`' (`reconcile.rs:633-635`) — the sweep runs after every ingest
 * and **clears the flag again if the card comes back**, which is why an orphan is flagged and
 * never deleted.
 */
export const Orphan: Story = {
  args: {
    rows: [
      entry(printing("lea", "232"), "nonfoil", {
        // An id `cards` has no row for, which is what an orphan *is*. The printing above is
        // still what supplies `setCode`, `collectorNumber` and `lang` — the entry's own
        // denormalised columns, which is exactly how a real orphaned row keeps them.
        cardId: "0f0c1b0e-8e0d-4a2f-9f4b-2f5c9a1d3e77",
        name: null,
        setName: null,
        rarity: null,
        manaCost: null,
        typeLine: null,
        layout: null,
        unitPrice: null,
        needsReview: MISSING,
      }),
      // Deliberately **not** `ROWS.slice(0, 3)`, which the other stories use: that slice holds
      // the healthy Alpha Black Lotus, and two rows reading `LEA · 232` would leave the `play`
      // below unable to say which one it was looking at.
      ...ROWS.slice(2, 5),
    ],
    total: 4,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The entry's **own** set and number, which is the whole point: they were copied off the
    // card at write time, so they are still here on the day the card is not.
    const orphan = canvas.getByText("LEA · 232").closest('[role="row"]');
    await expect(orphan).toHaveAttribute("aria-rowindex", "2");
    const row = within(orphan as HTMLElement);
    // Exactly three em dashes, and they are three different holes: the name the card can no
    // longer supply (`row.name ?? "—"`), the price of a finish of a printing that is not there
    // (`usdPrice(null)`), and — since v24 — the folder, where the dash is not a hole at all but
    // the root, which is where every card starts. Never `$0.00`, which is a price nobody quoted.
    await expect(row.getAllByText("—")).toHaveLength(3);
    // The one handle left. `Quantity of ${row.name ?? row.cardId}` falls back to the card id,
    // so the control is still addressable by something even though nothing can name the card.
    await expect(
      canvas.getByRole("spinbutton", {
        name: "Quantity of 0f0c1b0e-8e0d-4a2f-9f4b-2f5c9a1d3e77 (Nonfoil, NM)",
      }),
    ).toBeInTheDocument();
    await expect(orphan).toHaveTextContent(MISSING);
  },
};

/**
 * One printing, three entries: a nonfoil, a lightly played foil and an etched — which is the
 * whole reason this table is one row per **entry** rather than one per card.
 *
 * Finish is an **enum** and never a boolean: `etched` is a third thing, and flattening it into
 * `foil: true` is the single most common way an importer loses data. The column reads
 * `Foil · LP`, with the grade inside an `<abbr>` so its word — "Lightly played" — is one hover or
 * one screen reader away.
 *
 * The prices differ because each finish is a **different key** in the same `prices` blob. The
 * Strixhaven Lightning Bolt below is the fixture that has all three: `usd` $17.85,
 * `usd_foil` $23.85, `usd_etched` $18.68 (measured over `.storybook/fake/cards.ts`,
 * 2026-08-09).
 */
export const EveryFinish: Story = {
  args: {
    rows: [
      entry(printing("sta", "105"), "nonfoil"),
      entry(printing("sta", "105"), "foil", { condition: "LP" }),
      entry(printing("sta", "105"), "etched"),
    ],
    total: 3,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Three prices from three keys of one blob, through `finishPrice` rather than literals —
    // the claim is "each finish is priced by its own key", not "these three strings".
    for (const finish of ["nonfoil", "foil", "etched"] as const) {
      const price = finishPrice(printing("sta", "105").prices, finish, "usd");
      await expect(canvas.getByText(usdPrice(price))).toBeInTheDocument();
    }
    // The grade's word is one hover — or one screen reader — away, which is what the `<abbr>`
    // buys over a bare "LP". Spelled the way `CONDITION_LABEL` spells it, not the way a
    // pricing site would.
    //
    // Not a `title` assertion any more (spec §4, "the one site that is not a tooltip"):
    // `aria-label` on a roleless `<abbr>` is not reliably announced, so the expansion rides as
    // `sr-only` text right beside it — what a screen reader actually gets — and the hover panel
    // is a separate `useTooltip()` binding with no attribute of its own to query.
    const abbr = canvas.getByText("LP").closest("abbr") as HTMLElement;
    await expect(abbr).not.toHaveAttribute("title");
    await expect(abbr.nextElementSibling).toHaveTextContent(CONDITION_LABEL.LP);

    // The hover affordance itself: `describes: false`, so nothing doubles the `sr-only` text
    // above — the panel carries no `role="tooltip"` and is found by `TOOLTIP_PANEL_ID` instead,
    // the one stable id the provider ever draws (rule carried from `CollectionPage.test.tsx`'s
    // needs-review band).
    await userEvent.hover(abbr);
    await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).not.toBeNull(), {
      timeout: TOOLTIP_OPEN_MS + 1000,
    });
    const panel = document.getElementById(TOOLTIP_PANEL_ID) as HTMLElement;
    await expect(panel).toHaveTextContent(CONDITION_LABEL.LP);
    await expect(panel).not.toHaveAttribute("role", "tooltip");
    await userEvent.unhover(abbr);
  },
};

/**
 * An etched printing on its own — the finish whose price has a hole in it.
 *
 * `usd_etched` exists and is $2.07 for this printing (Assassin's Creed 211, the fixture's one
 * **etched-only** card: its `finishes` is `["etched"]`, and its `usd` and `usd_foil` are both
 * null). `eur_etched` does **not** exist in Scryfall's data at all, so the same row read at
 * Cardmarket comes back unpriced — see `InEuros`, which is that read.
 */
export const Etched: Story = {
  args: { rows: [entry(printing("acr", "211"), "etched")], total: 1 },
};

/**
 * The same table as a **Cardmarket read answers it** — and the hole above, made visible.
 *
 * The rows here carry what `collection_list` would have returned with `marketplace:
 * "cardmarket"`: the nonfoil row's `eur` figure, and `null` for the etched one. That em dash is
 * the correct answer and not a gap to be filled — `eur_etched` is not a key Scryfall has, so
 * quoting the nonfoil euro rate, or the dollar figure with a euro sign on it, would be
 * inventing a price nobody offered.
 *
 * **The prices are computed rather than typed**, through the same `finishPrice` the fake uses,
 * so the story stays honest about what a real read would answer the day the fixture changes.
 */
export const InEuros: Story = {
  args: {
    rows: [
      entry(printing("sta", "105"), "nonfoil", {
        unitPrice: finishPrice(printing("sta", "105").prices, "nonfoil", "eur"),
      }),
      entry(printing("acr", "211"), "etched", {
        unitPrice: finishPrice(printing("acr", "211").prices, "etched", "eur"),
      }),
    ],
    total: 2,
    marketplace: MARKETPLACES.cardmarket,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const priced = finishPrice(printing("sta", "105").prices, "nonfoil", "eur");
    await expect(canvas.getByText(formatPrice(priced, "eur"))).toBeInTheDocument();

    // The etched row: unpriced in euros, and its dollar figure is nowhere on screen.
    const etched = canvas.getByText("ACR · 211").closest('[role="row"]');
    // Two dashes since v24 and they say different things: this one is the missing euro price,
    // and the other is the Folder column's root. Counted rather than fetched singly, because
    // `getByText` now finds both and throws — which reads like a missing price rather than an
    // extra column.
    await expect(within(etched as HTMLElement).getAllByText("—")).toHaveLength(2);
    const usd = finishPrice(printing("acr", "211").prices, "etched", "usd");
    await expect(canvas.queryByText(usdPrice(usd))).toBeNull();

    // And the header says whose prices these are, not just how old they are.
    await expect(
      canvas.getByRole("columnheader", { name: `Value. ${pricesAsOf(MARKETPLACES.cardmarket)}` }),
    ).toBeInTheDocument();
  },
};

/**
 * A row the user owns none of — **and the row stays**.
 *
 * Zero is a state the stepper can reach and nothing else can leave. The backend keeps the row
 * with its condition, its purchase price and its acquisition story until something says delete,
 * and the only thing in the app that does is the trash button in the last column — which is
 * offered **on an empty row and nowhere else**. On a row that still holds cards it would be a
 * one-click way to lose the lot from a list that scrolls under the pointer.
 *
 * The row recedes rather than disappearing: `rowClassName` puts `text-dim` on it, applied last
 * so it wins over the selection colour. The Value cell is a real `$0.00` here and not an em
 * dash — the price is known and the quantity is zero, which is a different fact from "this
 * finish has no price".
 *
 * The wishlist and `deck_cards` are the opposite by table CHECK (`quantity > 0`): a wish for
 * none of something is not a wish, and a deck's category slot at zero holds no condition, no price and no
 * story. Only the collection's zero is worth keeping.
 */
export const ZeroQuantity: Story = {
  args: {
    rows: [
      entry(printing("c21", "263"), "nonfoil", { quantity: 0, condition: "LP" }),
      ...ROWS.slice(0, 3),
    ],
    total: 4,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const empty = canvas.getByText("C21 · 263").closest('[role="row"]');
    // Still listed, and still first — a row at zero is a record, not a deletion.
    await expect(empty).toHaveAttribute("aria-rowindex", "2");
    // **The Remove button is on this row, and on none of the rows drawn beside it** — the
    // invisible half of the rule, because on a list that scrolls under the pointer a trash
    // icon beside a four-copy row would be a one-click way to lose the lot.
    //
    // Read row by row over the rows the virtualiser really drew, never as a count of the
    // whole canvas. A canvas-wide `toHaveLength(1)` is green when the other three rows were
    // never rendered at all, which is the failure this file's own header forbids: the window
    // here is `stories.test.tsx`'s 600px stub and not this app's viewport, so how many rows
    // are in the DOM is an artefact of that file.
    await expect(
      within(empty as HTMLElement).getByRole("button", { name: /^Remove/ }),
    ).toHaveAccessibleName("Remove Sol Ring (Nonfoil, LP) from your collection");
    // `aria-rowindex="1"` is the header (`VirtualTable.tsx:190`); everything else with the
    // attribute is an entry.
    const others = canvas
      .getAllByRole("row")
      .filter((row) => row !== empty && row.getAttribute("aria-rowindex") !== "1");
    // Without this the loop below is a claim about nothing — which is precisely the way the
    // count it replaced could pass.
    await expect(others.length).toBeGreaterThan(0);
    for (const row of others) {
      await expect(within(row).queryByRole("button", { name: /^Remove/ })).toBeNull();
    }
    // The stepper can still be stepped back up — zero is a state it can reach and nothing else
    // can leave.
    await expect(
      canvas.getByRole("spinbutton", { name: "Quantity of Sol Ring (Nonfoil, LP)" }),
    ).toHaveValue(0);
    // Priced, and worth nothing: `$0.00` here is the answer rather than a stand-in for one,
    // which is exactly the distinction the em dash in {@link Orphan} is drawn for.
    await expect(within(empty as HTMLElement).getByText(usdPrice(0))).toBeInTheDocument();
  },
};

/**
 * Sorted by what each row is **worth** — quantity times the finish's unit price, descending.
 *
 * The header sorts by the figure printed in the cell, not by the unit price underneath it: a
 * column that reorders by something other than the number in it is a column that lies. `NULLS
 * LAST` in **both** directions, so reversing this moves the rows and not the holes — which is
 * why Alpha Black Lotus, priced in euros and in nothing else, sits at the foot either way.
 *
 * The rows below are in the order `collection::list_entries` would answer that spec, with the
 * entry id breaking ties as `COLLECTION_SORTS` appends it.
 */
export const SortedByValue: Story = {
  args: {
    rows: [...ROWS].sort((a, b) => {
      const value = (r: CollectionRow) =>
        r.unitPrice === null ? null : r.unitPrice * r.quantity;
      const x = value(a);
      const y = value(b);
      if (x === null) return y === null ? a.id - b.id : 1;
      if (y === null) return -1;
      return y - x || a.id - b.id;
    }),
    sort: [{ key: "value", dir: "desc" }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("columnheader", { name: /^Value/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    // Spec §5 in one assertion: the Value column may never be shown without saying how old its
    // prices are, and a 36px header row has nowhere to write the sentence — so it is the
    // header's accessible name, which **begins** with the visible word (WCAG 2.5.3) so the
    // column stays addressable by what is written on it.
    await expect(canvas.getByRole("columnheader", { name: /^Value/ })).toHaveAttribute(
      "aria-label",
      `Value. ${PRICES_AS_OF}`,
    );
    // One key, so no priority is announced: "1 of 1" is a number that says nothing.
    await expect(canvas.getByRole("button", { name: "Value" })).toBeInTheDocument();
  },
};

/**
 * Two keys: finish first, then value inside each finish.
 *
 * The question a collection is usually read for is two-part — "my dearest foils" is a finish and
 * a price — and one key answers half of it, leaving the rest to whatever order the database
 * happened to produce. The Finish column sorts by the finish spelled out and then by the
 * condition **ranked** (`NM` before `DMG`, because alphabetical order puts `DMG` first and that
 * is not what anybody means by condition).
 */
export const SortedByFinishThenValue: Story = {
  args: {
    rows: [
      entry(printing("mh2", "267"), "etched"),
      entry(printing("sta", "105"), "foil", { quantity: 2 }),
      entry(printing("gtc", "148"), "foil"),
      entry(printing("2ed", "48"), "nonfoil"),
      entry(printing("mh2", "259"), "nonfoil", { quantity: 2 }),
      entry(printing("lea", "232"), "nonfoil", { condition: "HP" }),
    ],
    total: 6,
    sort: [
      { key: "finish", dir: "asc" },
      { key: "value", dir: "desc" },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // `aria-sort` on **every** sorted column rather than only the first: the alternative is
    // telling assistive tech that a two-key sort has one key.
    await expect(canvas.getByRole("columnheader", { name: /^Finish/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await expect(canvas.getByRole("columnheader", { name: /^Value/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await expect(
      canvas.getByRole("button", { name: "Finish · condition, sort priority 1" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Value, sort priority 2" }),
    ).toBeInTheDocument();
    // Untouched columns still report a state, because they *could* be sorted — which is a
    // different statement from the Actions column's, which carries no `aria-sort` at all.
    await expect(canvas.getByRole("columnheader", { name: /^Name/ })).toHaveAttribute(
      "aria-sort",
      "none",
    );
  },
};
