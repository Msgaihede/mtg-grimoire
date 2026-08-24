/**
 * The one control on this step that makes a **second** write, and the wiring between it and the
 * command — mounted directly rather than through `ImportDialog`, because what is under test is
 * the preview's own state and the two lists it sends, not the shell's step machine.
 *
 * **It exists because three mutations survived without it.** `useImport.test.ts` pins the hook's
 * two-command order, its rollback and its invalidation union, and every one of those held when
 * `collectionItems: alsoOwn ? owned.items : undefined` was rewritten to send the copies whether
 * or not the reader ticked anything — the box was fully tested at the hook and completely unwired
 * at the surface, which is the exact shape this branch exists to close.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type {
  DeckCard,
  DeckDetail,
  DeckRow,
  ImportCommitOutcome,
  ImportMatch,
  ImportOutcome,
  ImportResolveRow,
  SyncStatus,
} from "@/lib/ipc";
import { spec } from "@/features/decks/validation/fixtures";

const deckImportCommit = vi.hoisted(() => vi.fn());
const collectionImportCommit = vi.hoisted(() => vi.fn());
const deckCreate = vi.hoisted(() => vi.fn());
const deckDelete = vi.hoisted(() => vi.fn());
const deckGet = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
const syncStatus = vi.hoisted(() => vi.fn());
const collectionFolderList = vi.hoisted(() => vi.fn());
const deckTagAll = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckImportCommit,
    collectionImportCommit,
    deckCreate,
    deckDelete,
    deckGet,
    formatSpecs,
    syncStatus,
    collectionFolderList,
    deckTagAll,
  },
}));

/**
 * The cabinet as `collection_folder_list` answers it — unfiltered by kind, so the deck groups and
 * a binder the reader made arrive in one flat list.
 *
 * Deck 4 is the one {@link deckPreview} imports into and deck 12 is the one `deckCreate` makes,
 * with a binder between them: a lookup taking the first `deck` row would pass with one group and
 * file the new deck's copies into the open deck's folder.
 */
const FOLDERS = [
  { id: 44, parentId: null, name: "Burn", kind: "deck", deckId: 4, sortOrder: 0 },
  { id: 5, parentId: null, name: "Binder", kind: "user", deckId: null, sortOrder: 1 },
  { id: 12_00, parentId: null, name: "Burn", kind: "deck", deckId: 12, sortOrder: 2 },
];

import { parseDecklist } from "../parse";
import { DeckPreview } from "./DeckPreview";
import { NewDeckPreview } from "./NewDeckPreview";

/** One resolved printing, with everything this surface does not read filled in as nothing —
 *  `ImportDialog.test.tsx`'s builder, trimmed to the two cards below. */
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
const BOLT = match({ name: "Lightning Bolt", typeLine: "Instant" });

/** Two lines, three copies. Deliberately no `*F*` and no condition column, so the collection
 *  items can only be carrying the reader's standing defaults — which is what tells a real
 *  `planCollectionImport` answer from deck items renamed. */
const LIST = parseDecklist("2 Sol Ring\n1 Lightning Bolt\n");

const RESOLVED: ImportResolveRow[] = [
  { index: 0, matched: SOL_RING, hintMissed: false },
  { index: 1, matched: BOLT, hintMissed: false },
];

/** Nothing resolved: the whole step is dead, and the box has nothing to be about. */
const NONE_RESOLVED: ImportResolveRow[] = [
  { index: 0, matched: null, hintMissed: false },
  { index: 1, matched: null, hintMissed: false },
];

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
  cardCount: 0,
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

const DETAIL: DeckDetail = { deck: DECK, cards: [] as DeckCard[], categories: [], tags: [] };

const OUTCOME: ImportOutcome = { added: 3, removed: 0, categoriesCreated: 1, tagsCreated: 0 };
const OWNED: ImportCommitOutcome = { added: 2, updated: 0, removed: 0 };

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

const onDone = vi.fn();
const onBack = vi.fn();

let client: QueryClient;
function mount(node: ReactElement) {
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  deckImportCommit.mockReset().mockResolvedValue(OUTCOME);
  collectionImportCommit.mockReset().mockResolvedValue(OWNED);
  deckCreate.mockReset().mockResolvedValue({ ...DECK, id: 12, name: "Burn" });
  deckDelete.mockReset().mockResolvedValue(undefined);
  deckGet.mockReset().mockResolvedValue(DETAIL);
  formatSpecs.mockReset().mockResolvedValue([spec("commander")]);
  syncStatus.mockReset().mockResolvedValue(IDLE);
  collectionFolderList.mockReset().mockResolvedValue(FOLDERS);
  // The app-wide tag list. Empty by default, so every label a list carries reads as new — the
  // one case about an existing tag overrides it.
  deckTagAll.mockReset().mockResolvedValue([]);
  onDone.mockReset();
  onBack.mockReset();
});

function deckPreview(resolved: ImportResolveRow[] = RESOLVED) {
  return mount(
    <DeckPreview
      list={LIST}
      resolved={resolved}
      tags={[]}
      onDone={onDone}
      onBack={onBack}
      deckId={4}
      variant="live"
    />,
  );
}

const box = () => screen.getByRole("checkbox", { name: /Add cards to collection/ });
const importButton = () => screen.getByRole("button", { name: "Import" });

describe("Add cards to collection", () => {
  /**
   * The box unticked is the import this app has always made. `undefined` rather than an empty
   * array, so the hook's own invalidation branch reads "the reader did not ask for this" rather
   * than "they asked and there was nothing to write".
   */
  it("sends no collection items while the box is unticked", async () => {
    deckPreview();
    await userEvent.click(importButton());

    await waitFor(() => expect(deckImportCommit).toHaveBeenCalled());
    expect(collectionImportCommit).not.toHaveBeenCalled();
    expect(deckImportCommit.mock.calls[0][3]).toHaveLength(2);
  });

  /**
   * Ticked, the same two lines are sent **twice, at two grains**. The assertion is on a field a
   * deck item has nowhere to put — `condition` — because that is what tells a real
   * `planCollectionImport` answer apart from `ImportItem`s renamed on the way past.
   */
  it("sends the copies at the collection's own grain once the box is ticked", async () => {
    deckPreview();
    await userEvent.click(box());
    await userEvent.click(importButton());

    await waitFor(() => expect(collectionImportCommit).toHaveBeenCalled());
    const [items, mode, folderId] = collectionImportCommit.mock.calls[0];
    expect(mode).toBe("add");
    // **This deck's own group, never the root** — the whole of what the box promises. Filed at
    // the top level the deck goes on reading *missing* on every line the reader just ticked,
    // and every other deck can still take the copies.
    expect(folderId).toBe(44);
    expect(items).toHaveLength(2);
    // The four flags are `false` rather than absent and the condition is the reader's standing
    // default: a file that says nothing about a copy still lands as a plain unmarked one, which
    // is the grain the collection's own `ON CONFLICT` folds on.
    expect(items[0]).toMatchObject({
      cardId: "sol-ring",
      quantity: 2,
      finish: "nonfoil",
      condition: "NM",
      altered: false,
      signed: false,
      proxy: false,
      misprint: false,
    });
    expect(items[1]).toMatchObject({ cardId: "lightning-bolt", quantity: 1, condition: "NM" });
  });

  /** And the copies say what the reader owns rather than what the deck holds: the count under
   *  the box is in **copies**, so two Sol Rings are two of the three. */
  it("counts the copies, not the lines", () => {
    deckPreview();
    expect(screen.getByText(/3 copies are added to what you have/)).toBeInTheDocument();
  });

  /** Nothing resolved is nothing to own, so the question is not asked — the way the tally and
   *  the commander section draw nothing they have no answer for. */
  it("draws no box when the list resolved nothing", () => {
    deckPreview(NONE_RESOLVED);
    expect(screen.queryByRole("checkbox", { name: /Add cards to collection/ })).toBeNull();
  });

  /**
   * The deck import landed and the copies did not, so the dialog still closes — leaving it open
   * over a landed commit invites a second press that merges the whole list again — and the
   * sentence it closes with says both things.
   */
  it("closes saying both halves when the copies are refused", async () => {
    collectionImportCommit.mockRejectedValue("The card database is busy finishing a sync.");
    deckPreview();
    await userEvent.click(box());
    await userEvent.click(importButton());

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toBe(
      "3 cards imported. The copies could not be added to your collection — " +
        "The card database is busy finishing a sync.",
    );
  });

  /** The landed pair, said in one sentence. */
  it("closes saying what landed in both places", async () => {
    deckPreview();
    await userEvent.click(box());
    await userEvent.click(importButton());

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toBe("3 cards imported. 2 rows in your collection.");
  });
});

/** The gallery's arm, which is the one a physically built deck arrives through most often —
 *  same box, same second command, one `deck_create` in front. */
describe("Add cards to collection, on a new deck", () => {
  /** This list names no deck — nothing but Arena's `Name` line does — so the button is dark
   *  until the reader types one, which is `nameMissing` and not this feature. */
  async function newDeckPreview() {
    mount(
      <NewDeckPreview list={LIST} resolved={RESOLVED} tags={[]} onDone={onDone} onBack={onBack} />,
    );
    await userEvent.type(screen.getByLabelText("Name"), "Burn");
  }

  it("sends the copies after the deck it just made", async () => {
    await newDeckPreview();
    await userEvent.click(box());
    await userEvent.click(importButton());

    await waitFor(() => expect(collectionImportCommit).toHaveBeenCalled());
    expect(deckCreate).toHaveBeenCalled();
    expect(collectionImportCommit.mock.calls[0][1]).toBe("add");
    // The group of the deck that did not exist a statement ago — deck 12's, not deck 4's.
    expect(collectionImportCommit.mock.calls[0][2]).toBe(1200);
    expect(deckDelete).not.toHaveBeenCalled();
  });

  it("sends none of them while the box is unticked", async () => {
    await newDeckPreview();
    await userEvent.click(importButton());

    await waitFor(() => expect(deckImportCommit).toHaveBeenCalled());
    expect(collectionImportCommit).not.toHaveBeenCalled();
  });
});

/**
 * Archidekt's labels on the step that sends them — the picker, and the wiring between its ticks
 * and `deck_import_commit`'s items.
 *
 * **Mounted in the real preview rather than on its own**, which is this file's own argument one
 * control over: `ImportTags` could be perfect and unreached, exactly as the collection box was
 * fully tested at the hook and completely unwired at the surface. What is under test here is
 * that a tick reaches the command.
 */
describe("Archidekt tags", () => {
  /** Three labelled lines and one bare one — two distinct labels, and one of them on two copies
   *  so the count on the row is visibly copies. */
  const LABELLED = parseDecklist(
    "2 Sol Ring ^Keeper,#4aab08^\n1 Lightning Bolt ^Fence,#fffc19^\n1 Path to Exile\n",
  );
  const PATH = match({ name: "Path to Exile", typeLine: "Instant" });
  const LABELLED_ROWS: ImportResolveRow[] = [
    { index: 0, matched: SOL_RING, hintMissed: false },
    { index: 1, matched: BOLT, hintMissed: false },
    { index: 2, matched: PATH, hintMissed: false },
  ];

  function labelledPreview() {
    return mount(
      <DeckPreview
        list={LABELLED}
        resolved={LABELLED_ROWS}
        tags={[]}
        onDone={onDone}
        onBack={onBack}
        deckId={4}
        variant="live"
      />,
    );
  }

  /** The items the press sent — the only thing that decides what lands. */
  const sentItems = () => deckImportCommit.mock.calls[0][3] as { tagName?: string }[];

  const MY_KEEPER = { id: 9, name: "KEEPER", color: "#d9b95c", cardCount: 4, deckCount: 2 };

  it("draws nothing at all for a list carrying no labels", () => {
    deckPreview();
    expect(screen.queryByRole("heading", { name: "Tags" })).toBeNull();
    // And makes no read either: a paste with no labels has no question to ask.
    expect(deckTagAll).not.toHaveBeenCalled();
  });

  it("offers one box per distinct label, ticked", async () => {
    labelledPreview();
    expect(await screen.findByRole("checkbox", { name: "Keeper" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Fence" })).toBeChecked();
  });

  it("sends every label while nothing is unticked", async () => {
    labelledPreview();
    await screen.findByRole("checkbox", { name: "Keeper" });
    await userEvent.click(importButton());

    await waitFor(() => expect(deckImportCommit).toHaveBeenCalled());
    expect(sentItems().map((i) => i.tagName)).toEqual(["Keeper", "Fence", undefined]);
  });

  it("drops a label the reader unticks and keeps the rest", async () => {
    labelledPreview();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Keeper" }));
    await userEvent.click(importButton());

    await waitFor(() => expect(deckImportCommit).toHaveBeenCalled());
    expect(sentItems().map((i) => i.tagName)).toEqual([undefined, "Fence", undefined]);
  });

  it("still imports every card when every label is unticked", async () => {
    labelledPreview();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Keeper" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Fence" }));
    await userEvent.click(importButton());

    await waitFor(() => expect(deckImportCommit).toHaveBeenCalled());
    expect(sentItems()).toHaveLength(3);
    expect(sentItems().every((i) => i.tagName === undefined)).toBe(true);
  });

  /**
   * The reader's own row is the row the import will use, so it is the row the step draws — the
   * whole of "show what you'll actually get". Their capitals, not the file's.
   */
  it("draws an existing label as the reader spelled it, and says it is theirs", async () => {
    deckTagAll.mockResolvedValue([MY_KEEPER]);
    labelledPreview();

    // `KEEPER` and not the file's `Keeper` — matched through `tagNameKey`, which is what
    // `commit_import` matches on.
    await screen.findByRole("checkbox", { name: "KEEPER" });
    expect(screen.getByText("already yours")).toBeInTheDocument();
    expect(screen.getByText("new tag")).toBeInTheDocument();
  });

  /** The colour still rides along: whether to ignore it is `commit_import`'s decision, and
   *  nothing in the webview may make it on the backend's behalf. */
  it("sends the file's colour even for a label the reader already has", async () => {
    deckTagAll.mockResolvedValue([MY_KEEPER]);
    labelledPreview();
    await screen.findByRole("checkbox", { name: "KEEPER" });
    await userEvent.click(importButton());

    await waitFor(() => expect(deckImportCommit).toHaveBeenCalled());
    expect(sentItems()[0]).toMatchObject({ tagName: "Keeper", tagColor: "#4aab08" });
  });

  it("says how many new tags landed when the import made some", async () => {
    deckImportCommit.mockResolvedValue({ ...OUTCOME, tagsCreated: 2 });
    labelledPreview();
    await screen.findByRole("checkbox", { name: "Keeper" });
    await userEvent.click(importButton());

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toBe("3 cards imported, 2 new tags.");
  });
});
