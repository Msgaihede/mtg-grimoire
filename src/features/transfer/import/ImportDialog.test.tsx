import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState, type ReactElement } from "react";
import type {
  DeckCard,
  DeckDetail,
  DeckRow,
  ImportItem,
  ImportMatch,
  ImportOutcome,
  ImportResolveLine,
  SyncStatus,
} from "@/lib/ipc";
import { spec } from "@/features/decks/validation/fixtures";
import { ARENA_LIST } from "./fixtures";

const importResolve = vi.hoisted(() => vi.fn());
const deckImportCommit = vi.hoisted(() => vi.fn());
const importReadFile = vi.hoisted(() => vi.fn());
const deckCreate = vi.hoisted(() => vi.fn());
const deckDelete = vi.hoisted(() => vi.fn());
const deckGet = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
const syncStatus = vi.hoisted(() => vi.fn());
const oracleTagsForPrintings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    importResolve,
    deckImportCommit,
    importReadFile,
    deckCreate,
    deckDelete,
    deckGet,
    formatSpecs,
    syncStatus,
    oracleTagsForPrintings,
  },
}));

/** The system file picker. It opens a native window nothing in a test or a browser can reach,
 *  so this is the one entry point that has to be stubbed rather than driven. */
const pickFile = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: pickFile }));

import type { ImportDestination } from "./destination";
import { collectionDestination } from "./destinations/CollectionPreview";
import type { DeckImportInto } from "./destinations/DeckPreview";
import { deckDestination } from "./destinations/deckInto";
import { NewDeckPreview } from "./destinations/NewDeckPreview";
import { newDeckDestination } from "./destinations/newDeck";
import { wishlistDestination } from "./destinations/WishlistPreview";
import { ImportDialog } from "./ImportDialog";

/** One resolved printing, with everything this surface does not read filled in as nothing —
 *  `plan.test.ts`'s builder, for its reason: the workbench's fixtures are the workbench's. */
function match(over: Partial<ImportMatch> & { name: string }): ImportMatch {
  return {
    cardId: over.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    setCode: "tst",
    collectorNumber: "1",
    lang: "en",
    oracleId: null,
    manaCost: null,
    cmc: null,
    typeLine: null,
    oracleText: null,
    colors: null,
    colorIdentity: null,
    legalities: null,
    power: null,
    toughness: null,
    layout: null,
    rarity: null,
    faces: null,
    gameChanger: false,
    everUncommon: false,
    ownedQuantity: 0,
    printingCount: 1,
    ...over,
  };
}

const SOL_RING = match({ name: "Sol Ring", typeLine: "Artifact" });
const ELVES = match({ name: "Llanowar Elves", typeLine: "Creature — Elf Druid" });
const BOLT = match({ name: "Lightning Bolt", typeLine: "Instant" });
const DURESS = match({ name: "Duress", typeLine: "Sorcery" });
const PATH = match({ name: "Path to Exile", typeLine: "Instant" });
const SISAY = match({
  name: "Captain Sisay",
  typeLine: "Legendary Creature — Human Legend",
  power: "2",
  toughness: "2",
  colorIdentity: "GW",
});
const KENRITH = match({
  name: "Kenrith, the Returned King",
  typeLine: "Legendary Creature — Human Noble",
  power: "5",
  toughness: "5",
  colorIdentity: "BGRUW",
});
/** A legendary creature Scryfall tags `ramp` — so the auto rule files her by what she does, and
 *  the command zone has to outrank that. Solemn Simulacrum, the card everyone reaches for here,
 *  is not legendary. */
const SELVALA = match({
  name: "Selvala, Heart of the Wilds",
  typeLine: "Legendary Creature — Elf Scout",
  power: "2",
  toughness: "3",
  colorIdentity: "G",
});

/** Every printing this app has, for the mocked resolve. A name that is not here matches
 *  nothing, which is how an unmatched line is staged. */
const CARDS: Record<string, ImportMatch> = {
  "Sol Ring": SOL_RING,
  "Llanowar Elves": ELVES,
  "Lightning Bolt": BOLT,
  Duress: DURESS,
  "Path to Exile": PATH,
  "Captain Sisay": SISAY,
  "Kenrith, the Returned King": KENRITH,
  "Selvala, Heart of the Wilds": SELVALA,
};

const DECK: DeckRow = {
  gameKey: "any",
  id: 4,
  name: "Sisay",
  formatKey: "commander",
  formatName: "Commander",
  description: null,
  notes: null,
  coverCardId: null,
  coverKind: "card_art",
  coverArtist: null,
  cardCount: 42,
  isBuilt: false,
  archived: false,
  folderId: null,
  theoryEnabled: false,
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  defaultCategoryId: 0,
  updatedAt: 1_800_000_000,
};

/**
 * One row of the open deck. Everything but the quantity is filled in so this is a real
 * {@link DeckCard} rather than a cast — `CategoriesDialog.test.tsx`'s builder, for its reason.
 *
 * It exists because `DeckPreview` **derives** what a `replace` would clear from the `deck_get`
 * it is already making, rather than being handed a number: the fixture and the sentence on
 * screen can no longer disagree.
 */
function deckCard(over: Partial<DeckCard> & { quantity: number }): DeckCard {
  return {
    promoTypes: null,
    id: 1,
    cardId: "sol-ring",
    categoryId: 9,
    categoryName: "Main deck",
    categoryKind: "main",
    categoryActive: true,
    finish: null,
    variant: "live",
    tagId: null,
    tagName: null,
    tagColor: null,
    name: "Sol Ring",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "1",
    lang: "en",
    needsReview: null,
    oracleId: "o1",
    manaCost: null,
    cmc: null,
    typeLine: "Artifact",
    oracleText: null,
    colors: null,
    colorIdentity: null,
    legalities: null,
    power: null,
    toughness: null,
    layout: null,
    rarity: null,
    faces: null,
    gameChanger: null,
    finishes: null,
    everUncommon: false,
    unitPrice: null,
    ownedQuantity: 0,
    ...over,
  };
}

/** Forty-two copies in Live, over **two** rows: the sentence a `replace` owes the reader counts
 *  copies, not rows, and one row of 42 would not catch a `length` where a sum belongs. */
const DETAIL: DeckDetail = {
  deck: DECK,
  cards: [deckCard({ quantity: 40 }), deckCard({ id: 2, cardId: "bolt", quantity: 2 })],
  categories: [],
  tags: [],
};

const MADE: DeckRow = { ...DECK, id: 12, name: "Burn", formatKey: "modern" };

const OUTCOME: ImportOutcome = { added: 6, removed: 0, categoriesCreated: 2 };

const IDLE: SyncStatus = {
  cardCount: 116_695,
  lastCheckAt: null,
  bulkUpdatedAt: null,
  lastError: null,
  lastIngestSkipped: null,
  dataDir: "C:/data",
  syncing: false,
  imageStoreFailures: 0,
};

const INTO_DECK: DeckImportInto = { deckId: 4, variant: "live" };

/** What a host passes for the destinations that have no `Subtitle` of their own — the
 *  gallery's sentence, near enough. */
const HOST_SUBTITLE = "Paste a list, and it becomes a deck of its own.";

const onDismiss = vi.fn();
const onClose = vi.fn();
const onImported = vi.fn();

/**
 * The dialog with a real trigger beside it, exactly as both entry points mount it.
 *
 * The trigger is real because Escape's contract is "hand the caret back to whatever opened
 * this", and there is nothing to hand it back to without a button still on screen.
 *
 * **One destination, built the way its host builds it** — `DeckEditor` calls `deckDestination`
 * with the deck on screen, `DecksPage` spreads `newDeckDestination` and closes over the format
 * it resolved. The shell is handed an array of one either way, so no destination radios are
 * drawn: that is what both entry points look like until Task 14 gives one of them a second
 * destination.
 */
function Harness({
  /** The deck the cards go into, or absent for the gallery's arm: the list becomes a deck. */
  into,
  /** What the host resolved for the new-deck arm — the gallery's `useNewDeckFormat()`. Left
   *  `undefined` by default, which is the editor's mount of this dialog: it imports into a deck
   *  that already has a format, so it passes nothing and the destination's own fallback
   *  applies. */
  defaultFormatKey,
}: {
  into?: DeckImportInto;
  defaultFormatKey?: string;
}) {
  const [open, setOpen] = useState(true);
  const destination = useMemo<ImportDestination>(
    () =>
      into === undefined
        ? {
            ...newDeckDestination,
            Preview: (props) => (
              <NewDeckPreview
                {...props}
                defaultFormatKey={defaultFormatKey}
                onImported={onImported}
              />
            ),
          }
        : deckDestination({ ...into, onImported }),
    [into, defaultFormatKey],
  );
  return (
    <div>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        Import deck
      </button>
      <ImportDialog
        destinations={[destination]}
        open={open}
        onDismiss={() => {
          onDismiss();
          screen.getByTestId("trigger").focus();
          setOpen(false);
        }}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        onDone={() => setOpen(false)}
      />
    </div>
  );
}

function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/**
 * The panel.
 *
 * **Everything inside a `motion` element needs this rather than a bare `get`.** A `motion`
 * element's first painted frame carries its `initial`, so `toBeVisible` is false for the whole
 * of a newly opened overlay until the next frame, `MotionGlobalConfig.skipAnimations` and all.
 */
const panel = () => screen.findByRole("dialog", { name: "Import a decklist" });

/** Paste a list and cross to the preview, which is where every claim below but the first two
 *  lives. `paste` rather than `type`: a 105-line list typed a character at a time is a minute
 *  of test, and the box is a plain controlled textarea either way. */
async function preview(list: string) {
  const box = await screen.findByLabelText("Decklist");
  await userEvent.click(box);
  await userEvent.paste(list);
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  return screen.findByRole("button", { name: "Import" });
}

/**
 * The tally, as `[pile, copies]` read straight off its `<dl>`.
 *
 * By structure and not by text, because **`Commander` is also the heading of the section above
 * it** — a `getByText("Commander")` on this step finds two nodes and would pass on the wrong
 * one. Reading the list also asserts its order, which is the order a deck seeds and then files
 * its piles.
 */
async function piles(): Promise<[string, string][]> {
  const list = (await panel()).querySelector("dl");
  if (list === null) return [];
  return [...list.children].map((row) => [
    row.querySelector("dt")?.textContent ?? "",
    row.querySelector("dd")?.textContent ?? "",
  ]);
}

beforeEach(() => {
  importResolve.mockReset().mockImplementation((lines: ImportResolveLine[]) =>
    Promise.resolve(
      lines.map((line, index) => ({
        index,
        matched: CARDS[line.name] ?? null,
        hintMissed: false,
      })),
    ),
  );
  deckImportCommit.mockReset().mockResolvedValue(OUTCOME);
  importReadFile.mockReset().mockResolvedValue("");
  deckCreate.mockReset().mockResolvedValue(MADE);
  deckDelete.mockReset().mockResolvedValue(undefined);
  deckGet.mockReset().mockResolvedValue(DETAIL);
  formatSpecs.mockReset().mockResolvedValue([spec("commander"), spec("modern"), spec("casual")]);
  syncStatus.mockReset().mockResolvedValue(IDLE);
  // **No tags by default, and that is the app before its first taxonomy download** — a
  // supported way to run it, and the state every claim below about a type-line pile is made
  // in. The tests that are about the tags stage their own answer.
  oracleTagsForPrintings.mockReset().mockResolvedValue([]);
  pickFile.mockReset().mockResolvedValue(null);
  onDismiss.mockReset();
  onClose.mockReset();
  onImported.mockReset();
});

describe("the import dialog", () => {
  it("will not advance from an empty box", async () => {
    wrap(<Harness />);
    await panel();

    const go = screen.getByRole("button", { name: "Preview" });
    expect(go).toBeDisabled();

    await userEvent.click(await screen.findByLabelText("Decklist"));
    await userEvent.paste("1 Sol Ring");
    await waitFor(() => expect(go).toBeEnabled());
    expect(importResolve).not.toHaveBeenCalled();
  });

  /** The whole point of the second step: the reader sees what the import would do before
   *  anything is written. */
  it("previews what it would import without writing anything", async () => {
    wrap(<Harness />);
    await preview("4 Lightning Bolt\n2 Sol Ring\nSB: 2 Duress\nSB: 1 Path to Exile");

    // The headline, then the piles — copies per pile, not lines.
    expect(await screen.findByText("9 cards")).toBeInTheDocument();
    const tally = screen.getByText("Sideboard").closest("div") as HTMLElement;
    expect(within(tally).getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Instant")).toBeInTheDocument();
    expect(screen.getByText("Artifact")).toBeInTheDocument();
    expect(deckImportCommit).not.toHaveBeenCalled();
    expect(deckCreate).not.toHaveBeenCalled();
  });

  it("quotes a line that matched no card", async () => {
    wrap(<Harness />);
    await preview("1 Sol Ring\n1 Lightning Bolth");

    expect(await screen.findByText('line 2 · "1 Lightning Bolth"')).toBeInTheDocument();
    // Never an error: the rest of the list still imports.
    expect(screen.getByText("1 card")).toBeInTheDocument();
  });

  it("quotes a printing hint it could not honour", async () => {
    importResolve.mockResolvedValue([
      {
        index: 0,
        matched: { ...SOL_RING, setCode: "ltc", collectorNumber: "285" },
        hintMissed: true,
      },
    ]);
    wrap(<Harness />);
    await preview("1 Sol Ring (XYZ) 999");

    // Capitals, as a card prints a set code — `cards.set_code` holds it lowercase.
    expect(await screen.findByText("line 1 · Sol Ring — used LTC 285 instead")).toBeInTheDocument();
  });

  /**
   * Two eligible cards is a question, and it is the one this feature was designed around.
   * Nothing here re-derives eligibility — the plan decides — so a card offered is exactly a
   * card the editor's validation panel would accept.
   */
  it("asks for a commander when more than one card is eligible", async () => {
    wrap(<Harness into={INTO_DECK} />);
    await preview("1 Captain Sisay\n1 Kenrith, the Returned King\n1 Sol Ring");

    expect(await screen.findByRole("heading", { name: "Commander" })).toBeInTheDocument();
    const sisay = screen.getByRole("button", { name: /Captain Sisay/ });
    expect(sisay).toHaveAttribute("aria-pressed", "false");
    // The way out is a control of its own, pressed by default: a commander deck with no
    // commander yet is a thing people import halfway through building one.
    expect(screen.getByRole("button", { name: "No commander" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("does not ask when the format has no commander rule", async () => {
    // The new-deck arm is judged by the format picked in this dialog, and Modern has no command
    // zone — so the question is not asked however many legends the list carries. The select
    // sits beside the tally it changes since Task 12, so it is pressed after Preview rather than
    // before it; either way the plan is rebuilt live, which is that arm's whole difference.
    wrap(<Harness />);
    await preview("1 Captain Sisay\n1 Kenrith, the Returned King");
    await userEvent.selectOptions(await screen.findByLabelText("Format"), "modern");

    expect(await screen.findByText("2 cards")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Commander" })).not.toBeInTheDocument();
  });

  /**
   * **The preview has to describe what Import will write — that is the whole job of a
   * preview-then-commit screen, and it did not.** Measured live 2026-08-12 on a **debug**
   * build: the reference list previewed as `117 cards · 6 categories` with `Creature 56` and
   * no Commander row, while `deck_get` after the import read 7 categories, `Creature 55` and
   * `Commander 1`. The tally was computed once, from `autoCategoryFor`'s answer, before the
   * reader had chosen anything.
   *
   * So: press a candidate, and both the headline and the piles must move with it.
   */
  it("counts the commander in the pile the import will actually use", async () => {
    wrap(<Harness into={INTO_DECK} />);
    await preview("1 Captain Sisay\n1 Kenrith, the Returned King\n1 Sol Ring");

    // A regex, because the count sits in its own `<span>` beside a separator and `getByText`
    // matches an element's own text nodes — here " · 2 categories".
    expect(await screen.findByText(/2 categories/)).toBeInTheDocument();
    expect(await piles()).toEqual([
      ["Creature", "2"],
      ["Artifact", "1"],
    ]);

    await userEvent.click(screen.getByRole("button", { name: /Captain Sisay/ }));

    await waitFor(async () =>
      expect(await piles()).toEqual([
        ["Commander", "1"],
        ["Creature", "1"],
        ["Artifact", "1"],
      ]),
    );
    expect(screen.getByText(/3 categories/)).toBeInTheDocument();
  });

  /** The `automatic` arm, which is worse because the reader presses nothing: the dialog states
   *  the commander in words, and a tally that filed him under Creature contradicted the
   *  sentence directly above it. */
  it("counts an automatic commander the reader was never asked about", async () => {
    wrap(<Harness into={INTO_DECK} />);
    await preview("1 Captain Sisay\n1 Sol Ring");

    expect(await screen.findByText("Captain Sisay goes in the command zone.")).toBeInTheDocument();
    expect(await piles()).toEqual([
      ["Commander", "1"],
      ["Artifact", "1"],
    ]);
  });

  it("sends the chosen commander in the Commander category", async () => {
    wrap(<Harness into={INTO_DECK} />);
    const go = await preview("1 Captain Sisay\n1 Kenrith, the Returned King\n1 Sol Ring");

    await userEvent.click(screen.getByRole("button", { name: /Captain Sisay/ }));
    await userEvent.click(go);

    await waitFor(() =>
      expect(deckImportCommit).toHaveBeenCalledWith(4, "live", "merge", [
        // `inactive` is on every item: this list said nothing about a switched-off pile, which
        // is what `false` says. Only an Archidekt `{noDeck}` bracket makes it `true`.
        {
          cardId: SISAY.cardId,
          quantity: 1,
          finish: null,
          categoryName: "Commander",
          inactive: false,
        },
        // The one not picked keeps the pile its type line filed it in.
        {
          cardId: KENRITH.cardId,
          quantity: 1,
          finish: null,
          categoryName: "Creature",
          inactive: false,
        },
        {
          cardId: SOL_RING.cardId,
          quantity: 1,
          finish: null,
          categoryName: "Artifact",
          inactive: false,
        },
      ] satisfies ImportItem[]),
    );
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(4, OUTCOME));
  });

  /**
   * **A decklist is written by function, so the preview files it by function** — and the piles
   * it draws have to be the piles it sends. That is the whole job of a preview-then-commit
   * screen, and the one thing this dialog has already got wrong once.
   *
   * The tag answers are staged out of order on purpose: they are matched back by `cardId`,
   * because `oracle_tags_for_printings` drops duplicates and answers one entry per distinct id.
   */
  it("draws the piles the tags file, and sends exactly the piles it drew", async () => {
    oracleTagsForPrintings.mockResolvedValue([
      { cardId: SOL_RING.cardId, slugs: ["ramp", "mana-producer"] },
      { cardId: BOLT.cardId, slugs: ["removal"] },
    ]);
    wrap(<Harness into={INTO_DECK} />);
    const go = await preview("1 Lightning Bolt\n1 Sol Ring\n2 Llanowar Elves");

    // One read for the whole list — an import is one round trip, and a lookup per line would
    // put ~100 `invoke`s back into it.
    await waitFor(() => expect(oracleTagsForPrintings).toHaveBeenCalledTimes(1));
    expect(oracleTagsForPrintings).toHaveBeenCalledWith([
      BOLT.cardId,
      SOL_RING.cardId,
      ELVES.cardId,
    ]);
    const drawn = await piles();
    // Llanowar Elves is untagged here, so she falls through to her type line — the floor.
    expect(drawn).toEqual([
      ["Removal", "1"],
      ["Ramp", "1"],
      ["Creature", "2"],
    ]);

    await userEvent.click(go);

    await waitFor(() => expect(deckImportCommit).toHaveBeenCalled());
    const items = deckImportCommit.mock.calls[0][3] as ImportItem[];
    const sent = new Map<string, number>();
    for (const item of items) {
      sent.set(item.categoryName, (sent.get(item.categoryName) ?? 0) + item.quantity);
    }
    // The screen and the wire, compared: what was previewed is what was written.
    expect([...sent].map(([name, copies]) => [name, String(copies)]).sort()).toEqual(
      [...drawn].sort(),
    );
  });

  /**
   * **A refused taxonomy read is not a refused import.** The reader pasted a list; losing it to
   * a fetch of the tag table would be the worst trade this dialog could make. Every line lands,
   * in the type-line pile this app filed it in before Oracle tags existed — and nothing on the
   * step says a word about it, because nothing went wrong from where the reader is standing.
   */
  it("imports the whole list by type line when the tag read is refused", async () => {
    oracleTagsForPrintings.mockRejectedValue("The card database is busy finishing a sync.");
    wrap(<Harness into={INTO_DECK} />);
    const go = await preview("1 Lightning Bolt\n1 Sol Ring\n2 Llanowar Elves");

    expect(await piles()).toEqual([
      ["Creature", "2"],
      ["Artifact", "1"],
      ["Instant", "1"],
    ]);
    expect(screen.getByText("4 cards")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await userEvent.click(go);

    await waitFor(() =>
      expect(deckImportCommit).toHaveBeenCalledWith(4, "live", "merge", [
        {
          cardId: BOLT.cardId,
          quantity: 1,
          finish: null,
          categoryName: "Instant",
          inactive: false,
        },
        {
          cardId: SOL_RING.cardId,
          quantity: 1,
          finish: null,
          categoryName: "Artifact",
          inactive: false,
        },
        {
          cardId: ELVES.cardId,
          quantity: 2,
          finish: null,
          categoryName: "Creature",
          inactive: false,
        },
      ] satisfies ImportItem[]),
    );
  });

  /**
   * The command zone outranks every functional pile. Selvala, Heart of the Wilds is tagged
   * `ramp`, which is the right answer for a card in the 99 and the wrong one for the card the
   * deck is built around — and this is the `automatic` arm, where the reader presses nothing,
   * so the tally has to agree with the sentence printed directly above it.
   */
  it("puts an automatic commander in the command zone however her tags file her", async () => {
    oracleTagsForPrintings.mockResolvedValue([
      { cardId: SELVALA.cardId, slugs: ["ramp", "mana-producer"] },
      { cardId: SOL_RING.cardId, slugs: ["ramp"] },
    ]);
    wrap(<Harness into={INTO_DECK} />);
    const go = await preview("1 Selvala, Heart of the Wilds\n1 Sol Ring");

    expect(
      await screen.findByText("Selvala, Heart of the Wilds goes in the command zone."),
    ).toBeInTheDocument();
    expect(await piles()).toEqual([
      ["Commander", "1"],
      // Only the card the command zone claimed moves; Sol Ring is still ramp.
      ["Ramp", "1"],
    ]);

    await userEvent.click(go);

    await waitFor(() =>
      expect(deckImportCommit).toHaveBeenCalledWith(4, "live", "merge", [
        {
          cardId: SELVALA.cardId,
          quantity: 1,
          finish: null,
          categoryName: "Commander",
          inactive: false,
        },
        {
          cardId: SOL_RING.cardId,
          quantity: 1,
          finish: null,
          categoryName: "Ramp",
          inactive: false,
        },
      ] satisfies ImportItem[]),
    );
  });

  /**
   * The gallery's whole flow: a list becomes a deck of its own, named by the file when the file
   * said — Arena's `Name` line is the only thing in any of these formats that names a deck.
   */
  it("makes a deck out of the list, named by the file", async () => {
    wrap(<Harness />);
    await panel();

    await userEvent.click(await screen.findByLabelText("Decklist"));
    await userEvent.paste(ARENA_LIST);
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    // Prefilled rather than typed, and still the reader's to overwrite.
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Bant Ramp"));
    await userEvent.click(await screen.findByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(deckCreate).toHaveBeenCalledWith({
        name: "Bant Ramp",
        formatKey: "casual",
        // The dialog's own game select, on the value it starts on: `any`, so the format list
        // it offered was the unnarrowed one.
        gameKey: "any",
      }),
    );
    await waitFor(() =>
      expect(deckImportCommit).toHaveBeenCalledWith(MADE.id, "live", "merge", [
        {
          cardId: ELVES.cardId,
          quantity: 4,
          finish: null,
          categoryName: "Creature",
          inactive: false,
        },
        {
          cardId: BOLT.cardId,
          quantity: 2,
          finish: null,
          categoryName: "Instant",
          inactive: false,
        },
        {
          cardId: DURESS.cardId,
          quantity: 2,
          finish: null,
          categoryName: "Sideboard",
          inactive: false,
        },
      ]),
    );
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(MADE.id, OUTCOME));
  });

  /** The one reason the button can be dark, said where the button is. Since Task 12 the field
   *  it is about is on this step too, so the sentence names the field rather than the way back
   *  to it — same region, same place, same reason. */
  it("will not make a deck with no name", async () => {
    wrap(<Harness />);
    const go = await preview("1 Sol Ring");

    await waitFor(() => expect(go).toBeDisabled());
    expect(await screen.findByRole("status")).toHaveTextContent("Name the deck first.");
    expect(deckCreate).not.toHaveBeenCalled();
  });

  it("disables Import when nothing resolved", async () => {
    wrap(<Harness into={INTO_DECK} />);
    const go = await preview("1 Definitely Not A Card\n2 Nor This One");

    await waitFor(() => expect(go).toBeDisabled());
    expect(screen.getByText('line 1 · "1 Definitely Not A Card"')).toBeInTheDocument();
  });

  /**
   * **A list pasted into a new deck starts on the format its host resolved** — the one the
   * reader last created a deck in — because making a deck out of a decklist is the same act as
   * making one from the gallery's dialog, and the two must not disagree about where it starts.
   *
   * The value is seeded at mount, so the `waitFor` below is the format *list* arriving rather
   * than the value changing.
   */
  it("starts a new deck on the format the host resolved", async () => {
    wrap(<Harness defaultFormatKey="commander" />);
    await preview("1 Sol Ring");

    const format = await screen.findByLabelText("Format");
    await waitFor(() =>
      expect(
        within(format)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["Casual", "Commander", "Modern"]),
    );
    expect(format).toHaveValue("commander");
  });

  /**
   * **And the prop is optional because one of its two hosts has nothing to say here.** The
   * editor imports into a deck that already carries a format, so it passes nothing — and what a
   * host that says nothing gets is `DEFAULT_FORMAT`, which is what this select started on
   * before the prop existed.
   */
  it("falls back to Casual when the host passes no default", async () => {
    wrap(<Harness />);
    await preview("1 Sol Ring");

    const format = await screen.findByLabelText("Format");
    await waitFor(() => expect(within(format).getAllByRole("option")).toHaveLength(3));
    expect(format).toHaveValue("casual");
  });

  it("offers Merge and Replace only when importing into a deck", async () => {
    wrap(<Harness />);
    await preview("1 Sol Ring");

    await waitFor(() => expect(screen.queryByLabelText(/^Merge/)).not.toBeInTheDocument());
    expect(screen.queryByLabelText(/^Replace/)).not.toBeInTheDocument();
  });

  it("names what Replace would clear", async () => {
    wrap(<Harness into={INTO_DECK} />);
    await preview("1 Sol Ring");

    const merge = await screen.findByLabelText(/^Merge/);
    expect(merge).toBeChecked();
    const replace = screen.getByLabelText("Replace — removes the 42 cards in Live first");
    await userEvent.click(replace);
    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(deckImportCommit).toHaveBeenCalledWith(4, "live", "replace", [
        {
          cardId: SOL_RING.cardId,
          quantity: 1,
          finish: null,
          categoryName: "Artifact",
          inactive: false,
        },
      ]),
    );
  });

  it("shows a refused commit and stays open with the pasted text", async () => {
    deckImportCommit.mockRejectedValue("The card database is busy finishing a sync.");
    wrap(<Harness into={INTO_DECK} />);
    const go = await preview("1 Sol Ring");

    await userEvent.click(go);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Could not import the list — The card database is busy finishing a sync.",
    );
    // Still open, and Back still holds what was pasted: the retry is one press, not a retype.
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByLabelText("Decklist")).toHaveValue("1 Sol Ring");
    expect(onImported).not.toHaveBeenCalled();
  });

  /**
   * A hundred lines of "no such card" during the opening sync is a hundred accusations of a
   * reader who did nothing wrong. The list is not the problem, and the app knows it.
   */
  it("blames the sync, not the reader, when the corpus is empty", async () => {
    syncStatus.mockResolvedValue({ ...IDLE, cardCount: 0, syncing: true });
    // An empty `cards` table answers every line with nothing, which is exactly what the
    // opening sync looks like from here — and what a hundred false accusations start from.
    importResolve.mockImplementation((lines: ImportResolveLine[]) =>
      Promise.resolve(lines.map((_line, index) => ({ index, matched: null, hintMissed: false }))),
    );
    wrap(<Harness />);
    const go = await preview("1 Sol Ring\n1 Lightning Bolt\n1 Duress");

    expect(await screen.findByText(/Card data is still syncing/)).toBeInTheDocument();
    expect(screen.queryByText('line 1 · "1 Sol Ring"')).not.toBeInTheDocument();
    expect(go).toBeDisabled();
  });

  /**
   * **What Back keeps, and what it does not — the rule, pinned.**
   *
   * The paste belongs to the *shell* and survives, because the whole point of a two-step dialog
   * is that a refusal or a second look costs one press rather than a retype. Everything a
   * destination owns goes, because the preview unmounts: preserving it would mean the shell
   * holding state whose shape it must not know, which is the coupling this seam exists to
   * remove. Both halves are checked here rather than assumed, because Task 14's two
   * destinations inherit the rule and neither of them can see this file.
   *
   * The deck arm's mode is the visible half; the new deck's name is the other, and it comes
   * back **re-seeded from the list** rather than empty when the file named a deck — which is
   * how anything that has to outlive a Back is supposed to survive one.
   */
  it("keeps the pasted text across Back and discards the destination's own options", async () => {
    wrap(<Harness into={INTO_DECK} />);
    await preview("1 Sol Ring");

    await userEvent.click(await screen.findByLabelText(/^Replace/));
    expect(screen.getByLabelText(/^Replace/)).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByLabelText("Decklist")).toHaveValue("1 Sol Ring");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));

    // The mode is the destination's, so it is back at the one that cannot clear anything.
    await waitFor(async () => expect(await screen.findByLabelText(/^Merge/)).toBeChecked());
    expect(screen.getByLabelText(/^Replace/)).not.toBeChecked();
  });

  /** The other arm, where the discarded option is a field the reader typed into — and where the
   *  way back is re-deriving it from the list rather than keeping it. */
  it("re-seeds a new deck's name from the list rather than keeping what was typed", async () => {
    wrap(<Harness />);
    await panel();

    await userEvent.click(await screen.findByLabelText("Decklist"));
    await userEvent.paste(ARENA_LIST);
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));

    const named = await screen.findByLabelText("Name");
    await userEvent.clear(named);
    await userEvent.type(named, "Something else");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await userEvent.click(await screen.findByRole("button", { name: "Preview" }));

    // Not "Something else", and not empty either: the file said, and the file is still there.
    await waitFor(async () =>
      expect(await screen.findByLabelText("Name")).toHaveValue("Bant Ramp"),
    );
  });

  /**
   * **The seam, from the shell's side.** Handed two destinations it draws a radio each, mounts
   * whichever is chosen and knows nothing about either — which is what lets Task 14 add the
   * collection and the wishlist without touching that file. Handed one, as both deck entry
   * points do, it draws no radios at all: a choice between one thing is not a choice.
   */
  it("offers the destinations when the host gives it more than one", async () => {
    const both: ImportDestination[] = [
      deckDestination({ ...INTO_DECK, onImported }),
      newDeckDestination,
    ];
    wrap(
      <ImportDialog
        destinations={both}
        subtitle={HOST_SUBTITLE}
        open
        onDismiss={onDismiss}
        onClose={onClose}
        onDone={vi.fn()}
      />,
    );
    await panel();

    expect(await screen.findByLabelText("Import into this deck")).toBeChecked();
    // The header line is the *chosen* destination's, which is why it cannot be a host prop: the
    // header is drawn on both steps and the radios only on the first.
    expect(await screen.findByText("Into Sisay · Live")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Import into a new deck"));

    // The new deck has no deck to name, so it says nothing and the host's fallback stands.
    await waitFor(() => expect(screen.queryByText("Into Sisay · Live")).not.toBeInTheDocument());
    expect(screen.getByText(HOST_SUBTITLE)).toBeInTheDocument();

    await preview("1 Sol Ring");

    // The second destination's own step, drawn by it: a name to give the deck, and none of the
    // merge/replace question that only a deck already on screen can be asked. The header still
    // says what it said on the source step, which is the half a host prop got wrong.
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Merge/)).not.toBeInTheDocument();
    expect(screen.getByText(HOST_SUBTITLE)).toBeInTheDocument();
  });

  it("closes on Escape and hands focus back", async () => {
    wrap(<Harness />);
    await panel();

    await userEvent.keyboard("{Escape}");

    expect(onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByLabelText("Decklist")).not.toBeInTheDocument());
    expect(screen.getByTestId("trigger")).toHaveFocus();
  });

  /**
   * The picker answers a **path** and Rust opens the file — the contract that makes
   * `dialog:allow-open` sufficient and is why this app grants no `fs:` permission at all.
   */
  it("reads a file the reader picked", async () => {
    pickFile.mockResolvedValue("C:/lists/burn.txt");
    importReadFile.mockResolvedValue("4 Lightning Bolt\n2 Sol Ring");
    wrap(<Harness />);
    await panel();

    await userEvent.click(screen.getByRole("button", { name: "Choose file…" }));

    await waitFor(() => expect(importReadFile).toHaveBeenCalledWith("C:/lists/burn.txt"));
    await waitFor(() =>
      expect(screen.getByLabelText("Decklist")).toHaveValue("4 Lightning Bolt\n2 Sol Ring"),
    );
  });

  /** A cancelled picker is not a failure — it is the most ordinary way to use a file dialog
   *  after changing your mind — so nothing is said and nothing is read. */
  it("says nothing when the picker is cancelled", async () => {
    pickFile.mockResolvedValue(null);
    wrap(<Harness />);
    await panel();

    await userEvent.click(screen.getByRole("button", { name: "Choose file…" }));

    await waitFor(() => expect(pickFile).toHaveBeenCalled());
    expect(importReadFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the file reader's refusal beside the button", async () => {
    pickFile.mockResolvedValue("C:/lists/burn.txt");
    importReadFile.mockRejectedValue("That file is larger than 1 MB.");
    wrap(<Harness />);
    await panel();

    await userEvent.click(screen.getByRole("button", { name: "Choose file…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not read that file — That file is larger than 1 MB.",
    );
    expect(screen.getByLabelText("Decklist")).toHaveValue("");
  });

  /**
   * **The collection is an ordinary destination, and this is the only thing that says so.** It
   * used to be the one entry that could refuse — greyed, with its reason folded into its own
   * accessible name — so a radio that renders plain and takes the press is exactly the seam
   * this change opens. Two destinations because one draws no radios at all.
   */
  it("lets the reader choose the collection when there is more than one destination", async () => {
    wrap(
      <ImportDialog
        destinations={[wishlistDestination, collectionDestination]}
        open
        onDismiss={onDismiss}
        onClose={onClose}
        onDone={vi.fn()}
      />,
    );
    await panel();

    const collection = screen.getByRole("radio", { name: "Import into your collection" });
    expect(collection).toBeEnabled();
    expect(collection).not.toHaveAttribute("aria-disabled");
    expect(collection).not.toBeChecked();

    await userEvent.click(collection);

    expect(collection).toBeChecked();
    expect(screen.getByRole("radio", { name: "Import into your wishlist" })).not.toBeChecked();
  });
});
