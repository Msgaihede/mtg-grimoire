import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import type {
  DeckDetail,
  DeckRow,
  ImportItem,
  ImportMatch,
  ImportOutcome,
  ImportResolveLine,
  SyncStatus,
} from "@/lib/ipc";
import { spec } from "../validation/fixtures";
import { ARENA_LIST } from "./fixtures";

const deckImportResolve = vi.hoisted(() => vi.fn());
const deckImportCommit = vi.hoisted(() => vi.fn());
const deckImportReadFile = vi.hoisted(() => vi.fn());
const deckCreate = vi.hoisted(() => vi.fn());
const deckDelete = vi.hoisted(() => vi.fn());
const deckGet = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
const syncStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckImportResolve,
    deckImportCommit,
    deckImportReadFile,
    deckCreate,
    deckDelete,
    deckGet,
    formatSpecs,
    syncStatus,
  },
}));

/** The system file picker. It opens a native window nothing in a test or a browser can reach,
 *  so this is the one entry point that has to be stubbed rather than driven. */
const pickFile = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: pickFile }));

import { ImportDeckDialog, type ImportTarget } from "./ImportDeckDialog";

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
};

const DECK: DeckRow = {
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
  updatedAt: 1_800_000_000,
};

const DETAIL: DeckDetail = { deck: DECK, cards: [], categories: [], tags: [] };

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

const INTO_DECK: ImportTarget = { kind: "deck", deckId: 4, variant: "live", cardsInVariant: 42 };

const onDismiss = vi.fn();
const onClose = vi.fn();
const onImported = vi.fn();

/**
 * The dialog with a real trigger beside it, exactly as both entry points mount it.
 *
 * The trigger is real because Escape's contract is "hand the caret back to whatever opened
 * this", and there is nothing to hand it back to without a button still on screen.
 */
function Harness({ target = { kind: "new" } as ImportTarget }: { target?: ImportTarget }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        Import deck
      </button>
      <ImportDeckDialog
        target={target}
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
        onImported={(deckId, outcome) => {
          onImported(deckId, outcome);
          setOpen(false);
        }}
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
  deckImportResolve
    .mockReset()
    .mockImplementation((lines: ImportResolveLine[]) =>
      Promise.resolve(
        lines.map((line, index) => ({
          index,
          matched: CARDS[line.name] ?? null,
          hintMissed: false,
        })),
      ),
    );
  deckImportCommit.mockReset().mockResolvedValue(OUTCOME);
  deckImportReadFile.mockReset().mockResolvedValue("");
  deckCreate.mockReset().mockResolvedValue(MADE);
  deckDelete.mockReset().mockResolvedValue(undefined);
  deckGet.mockReset().mockResolvedValue(DETAIL);
  formatSpecs
    .mockReset()
    .mockResolvedValue([spec("commander"), spec("modern"), spec("casual")]);
  syncStatus.mockReset().mockResolvedValue(IDLE);
  pickFile.mockReset().mockResolvedValue(null);
  onDismiss.mockReset();
  onClose.mockReset();
  onImported.mockReset();
});

describe("the import deck dialog", () => {
  it("will not advance from an empty box", async () => {
    wrap(<Harness />);
    await panel();

    const go = screen.getByRole("button", { name: "Preview" });
    expect(go).toBeDisabled();

    await userEvent.click(await screen.findByLabelText("Decklist"));
    await userEvent.paste("1 Sol Ring");
    await waitFor(() => expect(go).toBeEnabled());
    expect(deckImportResolve).not.toHaveBeenCalled();
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
    deckImportResolve.mockResolvedValue([
      {
        index: 0,
        matched: { ...SOL_RING, setCode: "ltc", collectorNumber: "285" },
        hintMissed: true,
      },
    ]);
    wrap(<Harness />);
    await preview("1 Sol Ring (XYZ) 999");

    // Capitals, as a card prints a set code — `cards.set_code` holds it lowercase.
    expect(
      await screen.findByText("line 1 · Sol Ring — used LTC 285 instead"),
    ).toBeInTheDocument();
  });

  /**
   * Two eligible cards is a question, and it is the one this feature was designed around.
   * Nothing here re-derives eligibility — the plan decides — so a card offered is exactly a
   * card the editor's validation panel would accept.
   */
  it("asks for a commander when more than one card is eligible", async () => {
    wrap(<Harness target={INTO_DECK} />);
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
    // A `new` target is judged by the format picked in this dialog, and Modern has no command
    // zone — so the question is not asked however many legends the list carries.
    wrap(<Harness />);
    await userEvent.selectOptions(await screen.findByLabelText("Format"), "modern");
    await preview("1 Captain Sisay\n1 Kenrith, the Returned King");

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
    wrap(<Harness target={INTO_DECK} />);
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
    wrap(<Harness target={INTO_DECK} />);
    await preview("1 Captain Sisay\n1 Sol Ring");

    expect(
      await screen.findByText("Captain Sisay goes in the command zone."),
    ).toBeInTheDocument();
    expect(await piles()).toEqual([
      ["Commander", "1"],
      ["Artifact", "1"],
    ]);
  });

  it("sends the chosen commander in the Commander category", async () => {
    wrap(<Harness target={INTO_DECK} />);
    const go = await preview("1 Captain Sisay\n1 Kenrith, the Returned King\n1 Sol Ring");

    await userEvent.click(screen.getByRole("button", { name: /Captain Sisay/ }));
    await userEvent.click(go);

    await waitFor(() =>
      expect(deckImportCommit).toHaveBeenCalledWith(4, "live", "merge", [
        { cardId: SISAY.cardId, quantity: 1, categoryName: "Commander" },
        // The one not picked keeps the pile its type line filed it in.
        { cardId: KENRITH.cardId, quantity: 1, categoryName: "Creature" },
        { cardId: SOL_RING.cardId, quantity: 1, categoryName: "Artifact" },
      ] satisfies ImportItem[]),
    );
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(4, OUTCOME));
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
    // Prefilled rather than typed, and still the reader's to overwrite.
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Bant Ramp"));
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await userEvent.click(await screen.findByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(deckCreate).toHaveBeenCalledWith({ name: "Bant Ramp", formatKey: "casual" }),
    );
    await waitFor(() =>
      expect(deckImportCommit).toHaveBeenCalledWith(MADE.id, "live", "merge", [
        { cardId: ELVES.cardId, quantity: 4, categoryName: "Creature" },
        { cardId: BOLT.cardId, quantity: 2, categoryName: "Instant" },
        { cardId: DURESS.cardId, quantity: 2, categoryName: "Sideboard" },
      ]),
    );
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(MADE.id, OUTCOME));
  });

  /** The one reason the button can be dark that the reader cannot see from the preview, said
   *  where the button is — Back keeps everything, so it costs one press. */
  it("will not make a deck with no name", async () => {
    wrap(<Harness />);
    const go = await preview("1 Sol Ring");

    await waitFor(() => expect(go).toBeDisabled());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Go back and name the deck first.",
    );
    expect(deckCreate).not.toHaveBeenCalled();
  });

  it("disables Import when nothing resolved", async () => {
    wrap(<Harness target={INTO_DECK} />);
    const go = await preview("1 Definitely Not A Card\n2 Nor This One");

    await waitFor(() => expect(go).toBeDisabled());
    expect(screen.getByText('line 1 · "1 Definitely Not A Card"')).toBeInTheDocument();
  });

  it("offers Merge and Replace only when importing into a deck", async () => {
    wrap(<Harness />);
    await preview("1 Sol Ring");

    await waitFor(() => expect(screen.queryByLabelText(/^Merge/)).not.toBeInTheDocument());
    expect(screen.queryByLabelText(/^Replace/)).not.toBeInTheDocument();
  });

  it("names what Replace would clear", async () => {
    wrap(<Harness target={INTO_DECK} />);
    await preview("1 Sol Ring");

    const merge = await screen.findByLabelText(/^Merge/);
    expect(merge).toBeChecked();
    const replace = screen.getByLabelText("Replace — removes the 42 cards in Live first");
    await userEvent.click(replace);
    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(deckImportCommit).toHaveBeenCalledWith(4, "live", "replace", [
        { cardId: SOL_RING.cardId, quantity: 1, categoryName: "Artifact" },
      ]),
    );
  });

  it("shows a refused commit and stays open with the pasted text", async () => {
    deckImportCommit.mockRejectedValue("The card database is busy finishing a sync.");
    wrap(<Harness target={INTO_DECK} />);
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
    deckImportResolve.mockImplementation((lines: ImportResolveLine[]) =>
      Promise.resolve(lines.map((_line, index) => ({ index, matched: null, hintMissed: false }))),
    );
    wrap(<Harness />);
    const go = await preview("1 Sol Ring\n1 Lightning Bolt\n1 Duress");

    expect(await screen.findByText(/Card data is still syncing/)).toBeInTheDocument();
    expect(screen.queryByText('line 1 · "1 Sol Ring"')).not.toBeInTheDocument();
    expect(go).toBeDisabled();
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
    deckImportReadFile.mockResolvedValue("4 Lightning Bolt\n2 Sol Ring");
    wrap(<Harness />);
    await panel();

    await userEvent.click(screen.getByRole("button", { name: "Choose file…" }));

    await waitFor(() => expect(deckImportReadFile).toHaveBeenCalledWith("C:/lists/burn.txt"));
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
    expect(deckImportReadFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the file reader's refusal beside the button", async () => {
    pickFile.mockResolvedValue("C:/lists/burn.txt");
    deckImportReadFile.mockRejectedValue("That file is larger than 1 MB.");
    wrap(<Harness />);
    await panel();

    await userEvent.click(screen.getByRole("button", { name: "Choose file…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not read that file — That file is larger than 1 MB.",
    );
    expect(screen.getByLabelText("Decklist")).toHaveValue("");
  });
});
