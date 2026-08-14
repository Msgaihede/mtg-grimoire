import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { DeckFolder, DeckRow, FormatSpec, ImportMatch, SyncStatus } from "@/lib/ipc";
import { cardImageUrl, imageOrigin } from "@/lib/images";
import { spec } from "./validation/fixtures";

const deckList = vi.hoisted(() => vi.fn());
const deckCreate = vi.hoisted(() => vi.fn());
const deckUpdate = vi.hoisted(() => vi.fn());
const deckDelete = vi.hoisted(() => vi.fn());
const deckDuplicate = vi.hoisted(() => vi.fn());
const deckSetFolder = vi.hoisted(() => vi.fn());
const deckFolderList = vi.hoisted(() => vi.fn());
const deckFolderCreate = vi.hoisted(() => vi.fn());
const deckFolderRename = vi.hoisted(() => vi.fn());
const deckFolderMove = vi.hoisted(() => vi.fn());
const deckFolderDelete = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
// The import dialog's three commands and the sync it reads to tell "your list is wrong" from
// "the card database is not filled in yet". Mounted only while the dialog is open, but the
// whole `ipc` object is replaced here, so a command left out is a `TypeError` rather than a
// missing answer.
const deckImportResolve = vi.hoisted(() => vi.fn());
const deckImportCommit = vi.hoisted(() => vi.fn());
const deckImportReadFile = vi.hoisted(() => vi.fn());
const syncStatus = vi.hoisted(() => vi.fn());
// The gallery warms the `art` crops its tiles draw. Fire-and-forget, so the stub only has to
// resolve; what it is called with is asserted in its own test below.
const prefetchImages = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    prefetchImages,
    deckList,
    deckCreate,
    deckUpdate,
    deckDelete,
    deckDuplicate,
    deckSetFolder,
    deckFolderList,
    deckFolderCreate,
    deckFolderRename,
    deckFolderMove,
    deckFolderDelete,
    formatSpecs,
    deckImportResolve,
    deckImportCommit,
    deckImportReadFile,
    syncStatus,
  },
}));

import { DecksPage } from "./DecksPage";
import { useAppStore } from "@/lib/store";

/** A deck with a cover, which is the only kind that can carry an artist credit. */
const BURN: DeckRow = {
  id: 4,
  name: "Burn",
  formatKey: "modern",
  formatName: "Modern",
  description: null,
  coverCardId: "0000419b-0bba-4488-8f7a-6194544ce91d",
  coverArtist: "Rebecca Guay",
  isBuilt: false,
  archived: false,
  cardCount: 60,
  updatedAt: 1_800_000_000,
  // The four v8 deck columns. Every real row carries all four, so the fixture does too.
  coverKind: "card_art",
  folderId: null,
  notes: null,
  theoryEnabled: false,
  // How the editor was last read. The gallery draws none of the three — they are here because
  // every real row carries them.
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
};

/** No cover, so no art and — the plan's ruling — no credit line at all. */
const DRAFT: DeckRow = {
  ...BURN,
  id: 5,
  name: "Sunday draft",
  formatKey: "limited",
  formatName: "Limited",
  coverCardId: null,
  coverArtist: null,
  cardCount: 40,
};

/** Filed away: sorted last by `deck_list`, and behind a disclosure here. */
const FILED: DeckRow = { ...BURN, id: 6, name: "Old Standard", archived: true, cardCount: 60 };

/** Two folders, one inside the other — flat rows, because `deck_folders` has no notion of
 *  depth and the tree is the reader's to build from `parentId`. */
const EDH: DeckFolder = { id: 1, parentId: null, name: "Commander", sortOrder: 0 };
const LEGENDS: DeckFolder = { id: 2, parentId: 1, name: "Legends", sortOrder: 0 };

/** Filed one level down, and the only fixture that keeps a theory list. */
const KENRITH: DeckRow = {
  ...BURN,
  id: 7,
  name: "Kenrith Two-Drops",
  formatKey: "commander",
  formatName: "Commander",
  coverArtist: "Kieran Yanner",
  cardCount: 100,
  folderId: 2,
  theoryEnabled: true,
};

/** Two folders, three decks: `Burn` at the top level, `Sunday draft` in Commander and
 *  `Kenrith Two-Drops` one level further down in Legends. */
function withFolders() {
  deckFolderList.mockResolvedValue([EDH, LEGENDS]);
  deckList.mockResolvedValue([BURN, { ...DRAFT, folderId: 1 }, KENRITH]);
}

/**
 * The picker's rows as `format_specs` serves them: every seeded row, in `sort_order`,
 * including the one that is switched off.
 *
 * Only four cells matter to a picker — key, display name, `enabledInPicker` and the order —
 * so the two rows the shared fixture does not carry are built from one that does. The
 * authority for the seed itself is Task 2's Rust test, not this list.
 */
const PICKER: FormatSpec[] = [
  { ...spec("modern"), key: "standard", displayName: "Standard", sortOrder: 1 },
  {
    ...spec("modern"),
    key: "future",
    displayName: "Future Standard",
    enabledInPicker: false,
    sortOrder: 2,
  },
  spec("modern"),
  spec("commander"),
  spec("casual"),
];

/** The one printing `deck_import_resolve` answers with here — everything the plan does not
 *  read filled in as nothing, `plan.test.ts`'s own builder cut to one row. */
const SOL_RING: ImportMatch = {
  cardId: "sol-ring",
  name: "Sol Ring",
  setCode: "ltc",
  collectorNumber: "285",
  lang: "en",
  oracleId: null,
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
  gameChanger: false,
  everUncommon: false,
  printingCount: 1,
  ownedQuantity: 0,
};

/** A card database that is filled in and idle: the import dialog reads this to tell a list
 *  that is wrong from one the app has not synced the cards for yet. */
const SYNCED: SyncStatus = {
  cardCount: 116_695,
  lastCheckAt: null,
  bulkUpdatedAt: null,
  lastError: null,
  lastIngestSkipped: null,
  dataDir: "C:/data",
  syncing: false,
  imageStoreFailures: 0,
};

function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** The tile, addressed the way a reader sees it: the deck's name first. */
const tileFor = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  deckList.mockReset().mockResolvedValue([BURN, DRAFT, FILED]);
  deckCreate.mockReset().mockResolvedValue({ ...BURN, id: 9, name: "Sunday burn" });
  deckUpdate.mockReset().mockResolvedValue({ ...BURN, archived: true });
  deckDelete.mockReset().mockResolvedValue(undefined);
  deckDuplicate.mockReset().mockResolvedValue({ ...BURN, id: 10, name: "Burn (copy)" });
  deckSetFolder.mockReset().mockResolvedValue(BURN);
  // No folders by default: the ordinary gallery is one that files nothing, and every case
  // below that is about filing says so by overriding this.
  deckFolderList.mockReset().mockResolvedValue([]);
  deckFolderCreate.mockReset().mockResolvedValue(LEGENDS);
  deckFolderRename.mockReset().mockResolvedValue({ ...EDH, name: "EDH" });
  deckFolderMove.mockReset().mockResolvedValue({ ...LEGENDS, parentId: null });
  deckFolderDelete.mockReset().mockResolvedValue(undefined);
  formatSpecs.mockReset().mockResolvedValue(PICKER);
  // One printing, so a one-line paste has something to resolve to and the Import button is
  // live. What the plan makes of it is `plan.test.ts`'s and the dialog's own to prove.
  deckImportResolve.mockReset().mockResolvedValue([{ index: 0, matched: SOL_RING, hintMissed: false }]);
  deckImportCommit.mockReset().mockResolvedValue({ added: 1, removed: 0, categoriesCreated: 1 });
  deckImportReadFile.mockReset().mockResolvedValue("");
  syncStatus.mockReset().mockResolvedValue(SYNCED);
  prefetchImages.mockClear();
  useAppStore.setState({ openDeckId: null, returnToDeckId: null });
});

describe("DecksPage", () => {
  /**
   * The gallery warms the `art` crops its tiles draw — the same variant the deck builder
   * uses and a different URL on the CDN from the `grid` the search wall warms.
   *
   * Custom covers are deliberately left out: `/cover/<deckId>` is a file the user picked,
   * served straight off disk, and it touches Scryfall not at all.
   */
  it("warms card covers as art and never asks Scryfall for a custom one", async () => {
    deckList.mockResolvedValue([BURN, DRAFT, { ...BURN, id: 7, coverKind: "custom" }]);

    wrap(<DecksPage />);

    // Exactly the one card cover: the custom-cover deck contributes nothing, and `DRAFT` has
    // no cover at all.
    await waitFor(() => expect(prefetchImages).toHaveBeenCalledWith([BURN.coverCardId], "art"));
  });

  /**
   * An empty screen is an invitation to act: it says what the thing is and offers the one
   * action that makes one. Not "No decks found", which blames the reader for a table nobody
   * has put anything in yet.
   */
  it("says what a deck is and offers to make one when there are none", async () => {
    deckList.mockResolvedValue([]);

    wrap(<DecksPage />);

    expect(await screen.findByText(/a deck is a list you build for a format/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New deck" })).toBeInTheDocument();
  });

  /**
   * Scryfall's image policy, which is not optional: the credit rides the interface that
   * shows art, so the footer is drawn whether or not any deck has a cover yet.
   */
  it("credits Wizards and Scryfall even with nothing on the wall", async () => {
    deckList.mockResolvedValue([]);

    wrap(<DecksPage />);

    expect(
      await screen.findByText("Card images © Wizards of the Coast · Data © Scryfall"),
    ).toBeInTheDocument();
  });

  /** Name in the reading face, format beside it, and the count in the data face. */
  it("draws a deck as its cover art, named, formatted and counted", async () => {
    wrap(<DecksPage />);

    const tile = await tileFor("Burn");
    // The art, the name and the caption are one control — a reader who aims at the name of a
    // deck should not miss it. (`toHaveAccessibleName` is asserted as a prefix rather than in
    // full: the name and the caption are two block spans, and jsdom computes no `display`, so
    // dom-accessibility-api joins them without the space a browser would insert.)
    expect(tile).toHaveAccessibleName(/^Burn/);
    expect(within(tile).getByText("Burn")).toBeInTheDocument();
    // `getByText` reads an element's *direct* text nodes, so the caption is found by the
    // part of it that is not in the mono span and read back whole.
    expect(within(tile).getByText(/Modern/)).toHaveTextContent("Modern · 60 cards");
    expect(within(tile).getByText("60")).toHaveClass("font-mono");
    const img = tile.querySelector("img");
    expect(img).toHaveAttribute("src", cardImageUrl(BURN.coverCardId!, 0, "art"));
  });

  /**
   * An art crop has no printed frame, so the illustrator is credited beside it — and the
   * plan's ruling is that a cover with no artist draws *no line at all*, never the word
   * "null" and never a placeholder.
   */
  it("credits the cover's artist, and says nothing at all when there is none", async () => {
    wrap(<DecksPage />);

    expect(await screen.findByText("Art by Rebecca Guay")).toBeInTheDocument();
    // The coverless deck is on screen beside it, and has no credit of its own.
    await tileFor("Sunday draft");
    expect(screen.getAllByText(/art by/i)).toHaveLength(1);
    expect(screen.queryByText(/null/i)).not.toBeInTheDocument();
  });

  /**
   * **A custom cover is drawn, and it is drawn from `coverKind`.**
   *
   * The bug this pins was found in the live window and is invisible to a reading of the tile:
   * `Cover` took only `cardId`, so a deck wearing the reader's own picture rendered "No cover"
   * and no `<img>` at all while the route answered the file 626×457 in 2 ms. Nothing was wrong
   * underneath — the gallery never asked.
   *
   * The URL names the **deck**, not the picture, and carries no cache-buster: the route is
   * served `no-store` so a stable URL can carry changing bytes.
   */
  it("draws a custom cover from the cover route, not from the card id", async () => {
    deckList.mockResolvedValue([{ ...BURN, coverKind: "custom" }]);

    wrap(<DecksPage />);

    const tile = (await tileFor("Burn")).closest("li")!;
    const img = tile.querySelector("img");
    expect(img).toHaveAttribute("src", `${imageOrigin(navigator.userAgent)}/cover/4`);
    // Not the card art, even though this deck still carries a `coverCardId`: setting a custom
    // cover never clears the card id, so "has one" and "is showing one" are different questions.
    expect(img).not.toHaveAttribute("src", cardImageUrl(BURN.coverCardId!, 0, "art"));
    expect(tile).not.toHaveTextContent("No cover");
  });

  /**
   * **The artist rule is Scryfall's, so it stops at Scryfall's pictures.**
   *
   * A file the reader uploaded carries no Scryfall artist and needs no credit — so the custom
   * arm must never be gated on `coverArtist` (or on `coverCardId`), or every custom cover
   * disappears for a second and quieter reason than the first.
   *
   * The fixture is the deck that has only ever worn its own picture: **no card id, and so no
   * artist either.** That is exactly the row such a gate would render invisible, and it is the
   * ordinary state of a deck whose reader uploaded a photograph and never picked a card.
   */
  it("draws a custom cover for a deck that has no card art and no artist", async () => {
    deckList.mockResolvedValue([
      { ...BURN, coverKind: "custom", coverCardId: null, coverArtist: null },
    ]);

    wrap(<DecksPage />);

    const tile = (await tileFor("Burn")).closest("li")!;
    expect(tile.querySelector("img")).toHaveAttribute(
      "src",
      `${imageOrigin(navigator.userAgent)}/cover/4`,
    );
    // And not the empty frame: "No cover" is what this said before the fix.
    expect(tile).not.toHaveTextContent("No cover");
    expect(screen.queryByText(/art by/i)).not.toBeInTheDocument();
  });

  /** And the card-art arm keeps the rule: the credit rides the picture it is about. */
  it("still credits the illustrator when the deck is showing card art", async () => {
    // Two decks, identical but for which cover they wear — so the only thing that can explain
    // one credit and not two is `coverKind`.
    deckList.mockResolvedValue([
      BURN,
      { ...BURN, id: 5, name: "Sunday burn", coverKind: "custom" },
    ]);

    wrap(<DecksPage />);

    const cardArt = (await tileFor("Burn")).closest("li")!;
    const custom = (await tileFor("Sunday burn")).closest("li")!;
    expect(within(cardArt).getByText("Art by Rebecca Guay")).toBeInTheDocument();
    expect(within(custom).queryByText(/art by/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("Art by Rebecca Guay")).toHaveLength(1);
  });

  /**
   * **If the credit cannot be shown, neither can the crop.**
   *
   * The deck *has* a cover and the printing it names has left the card database, so `cards`
   * answers no artist for it. The id still resolves to a URL — but Scryfall's image policy is
   * that an `art` crop, having no printed frame, may be shown only where the illustrator is
   * named, and `DeckRow.coverArtist`'s own doc records the ruling: "a cover with no artist is
   * **not drawn** — an orphaned cover heals on the next sync". So the frame stays empty and
   * says "No cover", which is what this is from the reader's side: nothing to show *yet*.
   *
   * **This case asserted the exact opposite until 2026-08-11** — that the `<img>` was present
   * with only the credit line suppressed — and it was wrong from the day it was written, not
   * made wrong by later code. `DeckSettingsDialog`'s `CoverPreview` had the policy right on the
   * same picture, so the gallery and the dialog disagreed about one deck row. Corrected on a
   * ruling, deliberately, and recorded here so the old assertion is never restored as a "fix":
   * a tile drawing an uncreditable crop is a policy violation, not a feature.
   *
   * The rule stops at the card-art arm. A custom cover is the reader's own picture, carries no
   * Scryfall artist and needs no credit — {@link
   * "draws a custom cover for a deck that has no card art and no artist"} is that half.
   */
  it("draws no card art at all for a cover it cannot credit", async () => {
    deckList.mockResolvedValue([{ ...BURN, coverArtist: null }]);

    wrap(<DecksPage />);

    const tile = (await tileFor("Burn")).closest("li")!;
    expect(tile.querySelector("img")).toBeNull();
    expect(within(tile).getByText("No cover")).toBeInTheDocument();
    expect(screen.queryByText(/art by/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/null/i)).not.toBeInTheDocument();
  });

  /** A filed deck is kept, not shown: it is behind its own disclosure, shut. */
  it("keeps archived decks in a section of their own, collapsed", async () => {
    wrap(<DecksPage />);

    await tileFor("Burn");
    expect(screen.queryByRole("button", { name: /^Old Standard/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /archived/i }));

    expect(await tileFor("Old Standard")).toBeInTheDocument();
  });

  /** The gallery's whole job: pick one to work on. */
  it("opens the deck a tile is clicked", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await tileFor("Burn"));

    expect(useAppStore.getState().openDeckId).toBe(4);
  });

  /**
   * Coming back from an editor. The tile that opened it unmounted while the editor was up, so
   * the store carries the note and the wall hands the caret back once the tiles exist —
   * without it the caret is on `<body>` and the next Tab restarts from the top of the app.
   */
  it("hands the caret back to the tile of the deck an editor just closed", async () => {
    useAppStore.setState({ returnToDeckId: 4 });

    wrap(<DecksPage />);

    await waitFor(async () => expect(await tileFor("Burn")).toHaveFocus());
    // Used once: a note left standing would yank the caret again on the next render.
    expect(useAppStore.getState().returnToDeckId).toBeNull();
  });

  /** A deck deleted from inside its own editor has no tile to come back to, and the note is
   *  still spent — otherwise it waits forever for a row that is never coming. */
  it("clears the note when the deck it names is gone", async () => {
    useAppStore.setState({ returnToDeckId: 99 });

    wrap(<DecksPage />);

    await tileFor("Burn");
    await waitFor(() => expect(useAppStore.getState().returnToDeckId).toBeNull());
  });

  /**
   * Two questions and no more — a name and a format — and the caret starts in the field the
   * reader has to fill.
   */
  it("opens the create form with the caret in the name field", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await screen.findByRole("button", { name: "New deck" }));

    expect(await screen.findByLabelText("Name")).toHaveFocus();
  });

  /**
   * The seeded table, offered **alphabetically** rather than in the `sortOrder` Rust answers
   * in: the ranking is a fact about `format_specs`, and a reader looking for Modern looks
   * under M. `enabled_in_picker` is what keeps Future Standard — a format you can test
   * against but cannot build for — out of it altogether.
   */
  it("offers the seeded formats alphabetically, without the one that is switched off", async () => {
    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New deck" }));

    const format = await screen.findByLabelText("Format");
    const options = within(format)
      .getAllByRole("option")
      .map((o) => o.textContent);

    expect(options).toEqual(["Casual", "Commander", "Modern", "Standard"]);
    expect(format).toHaveValue("casual");
  });

  /** Creating a deck is creating it *and* going to it — nobody makes a deck to look at a tile. */
  it("creates the deck and opens it", async () => {
    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New deck" }));

    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await userEvent.selectOptions(screen.getByLabelText("Format"), "modern");
    await userEvent.click(screen.getByRole("button", { name: "Create deck" }));

    // The whole deck in one call, and the two answers the reader left alone are the switch's
    // `false` and nothing else: a field left empty is **absent** rather than `""`, because this
    // is an INSERT and an absent field is the column's own default. What each field does on the
    // wire is `CreateDeckDialog.test.tsx`'s subject; this one is about the gallery's own two
    // steps — the write, and going to what it made.
    await waitFor(() =>
      expect(deckCreate).toHaveBeenCalledWith({
        name: "Sunday burn",
        formatKey: "modern",
        theoryEnabled: false,
      }),
    );
    await waitFor(() => expect(useAppStore.getState().openDeckId).toBe(9));
  });

  /**
   * The gallery's second door into a deck: a list somebody else wrote.
   *
   * A quiet control beside the primary one, because making a deck and importing one are the
   * same act with different starting material — and the gallery has exactly one primary action.
   */
  it("opens the import dialog from the gallery heading", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Import deck" }));

    expect(await screen.findByRole("dialog", { name: "Import a decklist" })).toBeInTheDocument();
    // The gallery has no deck open, so there is nothing to merge into and no choice to offer.
    expect(screen.queryByLabelText(/^Merge/)).not.toBeInTheDocument();
  });

  /**
   * One piece of state for every panel on this screen, which is what makes "never two" a shape
   * rather than a thing to remember: two `"inner"` Escape rungs open at once are not ordered by
   * that protocol at all, and both would consume one press.
   */
  it("never has the create dialog and the import dialog open at once", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await screen.findByRole("button", { name: "New deck" }));
    expect(await screen.findByRole("dialog", { name: "New deck" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Import deck" }));

    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    expect(screen.getByRole("dialog", { name: "Import a decklist" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "New deck" }));

    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    expect(screen.getByRole("dialog", { name: "New deck" })).toBeInTheDocument();
  });

  /** Nobody imports a deck in order to look at a tile of it — the same rule creating one
   *  follows, through the same handler. */
  it("opens the new deck in the editor after an import", async () => {
    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Import deck" }));

    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await userEvent.click(screen.getByLabelText("Decklist"));
    await userEvent.paste("1 Sol Ring");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await userEvent.click(await screen.findByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(deckCreate).toHaveBeenCalledWith({ name: "Sunday burn", formatKey: "casual" }),
    );
    await waitFor(() => expect(useAppStore.getState().openDeckId).toBe(9));
  });

  /**
   * The one place a refused create can be read is the form it was made in — `writeFailure`
   * covers the three writes a *tile* makes, not this one, and reopening the form resets the
   * mutation. So the form has to outlive the press.
   *
   * The press used to put it at risk: `Create deck` disables itself, a browser blurs a disabled
   * control **with no `relatedTarget` at all**, and the anchored form's click-away handler read
   * that as the reader leaving — closing the form *as if the write had worked*. The modal has
   * no such handler, so the `focusOut` below now proves the opposite of what it once did:
   * **focus leaving a modal is not a dismissal.** It is dispatched directly because jsdom will
   * not produce it on its own (it does not blur a control that becomes disabled, and a
   * `userEvent.click` elsewhere then finds nothing to move the caret *from*).
   */
  it("keeps the create form open while the write is in flight, so a refusal has somewhere to land", async () => {
    let refuse!: (reason: string) => void;
    deckCreate.mockReturnValue(
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
    );

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New deck" }));
    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await userEvent.click(screen.getByRole("button", { name: "Create deck" }));

    fireEvent.focusOut(screen.getByLabelText("Name"), { relatedTarget: null });

    expect(screen.getByLabelText("Name")).toBeInTheDocument();

    refuse("The database is busy with a sync — try again in a moment.");

    expect(await screen.findByRole("alert")).toHaveTextContent("The database is busy with a sync");
  });

  /** The same guard on the other panel: the answer must not arrive over a closed question. */
  it("keeps the delete question open while the delete is in flight", async () => {
    let finish!: () => void;
    deckDelete.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Burn" }));
    const confirm = screen.getByRole("dialog", { name: /delete burn/i });
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete deck" }));

    fireEvent.focusOut(confirm, { relatedTarget: null });

    expect(screen.getByRole("dialog", { name: /delete burn/i })).toBeInTheDocument();

    finish();

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("duplicates a deck", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Duplicate Burn" }));

    expect(deckDuplicate).toHaveBeenCalledWith(4);
  });

  /** Filing a deck away is `archived`, never the delete — this is what a gallery's remove is. */
  it("archives a deck, and restores one", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Archive Burn" }));
    expect(deckUpdate).toHaveBeenCalledWith(4, { archived: true });

    await userEvent.click(screen.getByRole("button", { name: /archived/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Restore Old Standard" }));

    expect(deckUpdate).toHaveBeenCalledWith(6, { archived: false });
  });

  /**
   * A deck is minutes of work and `deck_delete` really deletes, so the destructive one asks
   * — once, in words, naming the deck it would take.
   */
  it("asks before deleting, in words that name the deck", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Delete Burn" }));

    expect(deckDelete).not.toHaveBeenCalled();
    const confirm = screen.getByRole("dialog", { name: /delete burn/i });
    expect(confirm).toHaveTextContent("Burn");
    expect(confirm).toHaveTextContent(/60 cards/);

    await userEvent.click(within(confirm).getByRole("button", { name: "Delete deck" }));

    expect(deckDelete).toHaveBeenCalledWith(4);
  });

  /** The way out of the question, for the reader who did not mean to ask it. */
  it("closes the delete question on Escape, without deleting anything", async () => {
    wrap(<DecksPage />);
    const remove = await screen.findByRole("button", { name: "Delete Burn" });
    await userEvent.click(remove);

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deckDelete).not.toHaveBeenCalled();
    expect(remove).toHaveFocus();
  });

  /**
   * The other half of the same rule, and the half a single shared handler gets wrong: a
   * reader who clicked somewhere else is *already* somewhere else, so the layer goes and the
   * caret stays where they put it. Yanking it back to the trash icon is what makes a Tab
   * forward out of Cancel bounce backwards.
   */
  it("closes the delete question on a click away, and leaves the caret where it went", async () => {
    wrap(<DecksPage />);
    const remove = await screen.findByRole("button", { name: "Delete Burn" });
    await userEvent.click(remove);
    await screen.findByRole("dialog");

    await userEvent.click(document.body);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(remove).not.toHaveFocus();
    expect(deckDelete).not.toHaveBeenCalled();
  });

  /** Cancel is a control *in* the layer, so it is the keyboard way out and hands back. */
  it("hands the caret back when the question is cancelled", async () => {
    wrap(<DecksPage />);
    const remove = await screen.findByRole("button", { name: "Delete Burn" });
    await userEvent.click(remove);

    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(remove).toHaveFocus();
    expect(deckDelete).not.toHaveBeenCalled();
  });

  /**
   * The dialog's pointer way out, and the one thing that separates it from every anchored
   * popup in this app: a press **on the scrim**, not a press anywhere outside.
   *
   * The form used to close on a blur, which is right for a popup and wrong for a modal — the
   * caret cannot leave a trapped layer, so nothing outside it can be pressed by accident.
   *
   * **It does not hand the caret back, and Escape does.** That is CLAUDE.md's rule for every
   * layer in this app: Escape is the reader saying "put me back", and a press outside is the
   * reader already being somewhere else. This dialog handed it back either way until the
   * import dialog was built beside it and the two were made to agree.
   */
  it("closes the create form on a press on the scrim, and leaves the caret alone", async () => {
    wrap(<DecksPage />);
    const newDeck = await screen.findByRole("button", { name: "New deck" });
    await userEvent.click(newDeck);
    await screen.findByLabelText("Name");

    // A press inside the panel is not a dismissal, whatever it lands on.
    const panel = screen.getByRole("dialog", { name: "New deck" });
    fireEvent.mouseDown(panel);
    expect(screen.getByLabelText("Name")).toBeInTheDocument();

    fireEvent.mouseDown(panel.parentElement as HTMLElement);

    await waitFor(() => expect(screen.queryByLabelText("Name")).not.toBeInTheDocument());
    expect(newDeck).not.toHaveFocus();
  });

  /**
   * Escape closes one layer per press: the popover goes, the gallery stays, and the caret
   * comes back to the control that opened it rather than dropping onto `<body>`.
   */
  it("closes the create form on Escape and hands the caret back", async () => {
    wrap(<DecksPage />);
    const newDeck = await screen.findByRole("button", { name: "New deck" });
    await userEvent.click(newDeck);
    await screen.findByLabelText("Name");

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(newDeck).toHaveFocus();
    expect(await tileFor("Burn")).toBeInTheDocument();
  });

  /** A refused write is said in the app's own words, where the reader is looking. */
  it("says so when a write is refused", async () => {
    deckDuplicate.mockRejectedValue("That deck is not there any more.");

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Duplicate Burn" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That deck is not there any more.");
  });

  /**
   * Which of a deck's two lists exist, on the tile — derived from the two fields `deck_list`
   * already answers rather than stored, so the badge and the editor's Live/Theory switch can
   * never disagree. A theory list beside an empty live one is a plan, not a deck.
   */
  it("badges a deck by which of its two lists exist", async () => {
    deckList.mockResolvedValue([
      BURN,
      { ...KENRITH, folderId: null },
      { ...KENRITH, id: 8, name: "Sketch", cardCount: 0, folderId: null },
    ]);

    wrap(<DecksPage />);

    const burn = (await tileFor("Burn")).closest("li")!;
    expect(within(burn).getByText("LIVE")).toBeInTheDocument();
    const kenrith = (await tileFor("Kenrith Two-Drops")).closest("li")!;
    expect(within(kenrith).getByText("LIVE + THEORY")).toBeInTheDocument();
    const sketch = (await tileFor("Sketch")).closest("li")!;
    expect(within(sketch).getByText("THEORY ONLY")).toBeInTheDocument();
  });
});

describe("DecksPage folders", () => {
  /** Nested and indented, with each row counting everything under it — a row reading 0 over a
   *  sub-folder holding twelve decks is a lie the reader could only catch by clicking. */
  it("draws the folders as a tree, counting every deck under each one", async () => {
    withFolders();

    wrap(<DecksPage />);

    const tree = screen.getByRole("navigation", { name: "Folders" });
    expect(await within(tree).findByRole("button", { name: "All decks, 3 decks" })).toBeVisible();
    const commander = within(tree).getByRole("button", { name: "Commander, 2 decks" });
    // Commander holds one deck directly and one through Legends.
    const legends = within(tree).getByRole("button", { name: "Legends, 1 deck" });
    // The indent *is* the nesting: there is no twisty, so a level is 14px of padding.
    expect(commander).toHaveStyle({ paddingLeft: "22px" });
    expect(legends).toHaveStyle({ paddingLeft: "36px" });
  });

  /** One drawer at a time. The top level holds the decks filed nowhere and the folders in it;
   *  a deck two levels down is in neither until the reader walks there. */
  it("shows the selected folder's own decks and its own sub-folders", async () => {
    withFolders();

    wrap(<DecksPage />);

    expect(await tileFor("Burn")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commander folder, 2 decks" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Sunday draft/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Commander, 2 decks" }));

    expect(await tileFor("Sunday draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Legends folder, 1 deck" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Burn/ })).not.toBeInTheDocument();
    // The heading names the drawer and counts what is in it, folders first.
    expect(screen.getByRole("heading", { name: "Commander" })).toBeInTheDocument();
    expect(screen.getByText("1 folder · 1 deck")).toBeInTheDocument();
  });

  /**
   * Scryfall's image policy reaches the folder cards too: an `art` crop has no printed frame,
   * so every illustrator whose work is in the strip is named — and a cover the card database
   * has no artist for is not drawn at all, exactly as on a deck tile.
   */
  it("draws a folder's member art only where it can credit the illustrator", async () => {
    withFolders();

    wrap(<DecksPage />);

    const card = (await screen.findByRole("button", { name: "Commander folder, 2 decks" })).closest(
      "li",
    )!;
    // `Sunday draft` has no cover and contributes nothing; Kenrith, one level down, does.
    expect(within(card).getByText("Art by Kieran Yanner")).toBeInTheDocument();
    expect(card.querySelectorAll("img")).toHaveLength(1);
    expect(card.querySelector("img")).toHaveAttribute(
      "src",
      cardImageUrl(KENRITH.coverCardId!, 0, "art"),
    );
  });

  /** A folder is made where it will live, at the indent it will have — and at **any** level,
   *  which is the whole reason the control is on every row rather than only in the header. */
  it("makes a folder inside another one", async () => {
    withFolders();

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New folder in Commander" }));

    const field = await screen.findByLabelText("New folder name");
    expect(field).toHaveFocus();
    // The row says where it lands, for a reader who cannot see the indent.
    expect(screen.getByText("in Commander")).toBeInTheDocument();

    // `keyboard` rather than `type` for the reason the F2 case spells out: `type` focuses what
    // it is handed, which would repair the assertion above rather than build on it.
    await userEvent.keyboard("Legends");
    await userEvent.click(screen.getByRole("button", { name: "Create folder" }));

    expect(deckFolderCreate).toHaveBeenCalledWith(1, "Legends");
  });

  it("makes a folder at the top level", async () => {
    withFolders();

    wrap(<DecksPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "New folder at the top level" }),
    );

    // The same pair as every other field on this screen: assert where the caret is, then send
    // keystrokes to wherever it is rather than to an element handed to `type`.
    const field = await screen.findByLabelText("New folder name");
    expect(field).toHaveFocus();
    await userEvent.keyboard("Cubes");
    await userEvent.click(screen.getByRole("button", { name: "Create folder" }));

    expect(deckFolderCreate).toHaveBeenCalledWith(null, "Cubes");
  });

  /** The keyboard's half of the drag — a drop target nothing but a mouse can reach is half a
   *  feature. */
  it("files a deck into a folder from the tile's own control", async () => {
    withFolders();

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Move Burn to a folder" }));

    const picker = screen.getByRole("dialog", { name: "Move Burn to a folder" });
    await userEvent.click(within(picker).getByRole("button", { name: "Commander" }));

    expect(deckSetFolder).toHaveBeenCalledWith(4, 1);
  });

  /**
   * **The trap this screen exists to avoid.** `DeckPatch` writes every column with
   * `coalesce(?n, column)`, so a bound NULL reads as "leave it alone": a move to the top level
   * written as a patch is a write that silently does nothing. `deck_set_folder` is the one
   * command where `null` means the root, and this is the assertion that keeps it that way.
   */
  it("moves a deck to the top level with deckSetFolder and never with a patch", async () => {
    withFolders();

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Commander, 2 decks" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Move Sunday draft to a folder" }),
    );

    const picker = screen.getByRole("dialog", { name: "Move Sunday draft to a folder" });
    // Where it already is is offered and inert: that write changes nothing and bumps
    // `updated_at`.
    expect(within(picker).getByRole("button", { name: /^Commander/ })).toBeDisabled();
    await userEvent.click(within(picker).getByRole("button", { name: "All decks" }));

    expect(deckSetFolder).toHaveBeenCalledWith(5, null);
    expect(deckUpdate).not.toHaveBeenCalled();
  });

  /**
   * Renamed **in place**, at the indent it already has — the field stands where the folder is.
   * The trigger is in the wall's heading row beside the other two things you do to a folder,
   * because a 208px row has no width for a second control; `F2` below is the keyboard's own
   * route, and a rename only a mouse can reach would be half a feature.
   *
   * The current name arrives **selected**, `CategoriesPanel`'s ruling for its reason: the
   * commonest rename replaces the word rather than edits inside it.
   */
  it("renames a folder in place, from the wall's own control", async () => {
    withFolders();

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Commander, 2 decks" }));
    await userEvent.click(screen.getByRole("button", { name: "Rename folder…" }));

    const field = await screen.findByLabelText("Rename Commander");
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Commander");
    // The row it replaced is gone while the field is up: this is in place, not beside.
    expect(screen.queryByRole("button", { name: "Commander, 2 decks" })).not.toBeInTheDocument();

    // `keyboard`, not `type`: `type` clicks the field first and a click collapses the
    // selection — and the selection is the claim. A reader who opens a rename and starts
    // typing replaces the name rather than appending to it; this is that reader.
    await userEvent.keyboard("EDH");
    expect(field).toHaveValue("EDH");

    // The field's own control, named for the write. The trigger that opened it is
    // "Rename folder…" — the ellipsis is what keeps two controls with one name off the screen.
    await userEvent.click(screen.getByRole("button", { name: "Rename folder" }));

    expect(deckFolderRename).toHaveBeenCalledWith(1, "EDH");
  });

  /**
   * F2 renames the row the caret is on — the file manager's key, and a rename that never needs
   * the pointer.
   *
   * **This is the route where the caret's landing place is the whole feature**, so it is
   * asserted positively: where the caret *is*, not where it is not. A keyboard reader who
   * presses F2 and finds the caret still on the row has a field they cannot type into.
   */
  it("renames the row the caret is on when F2 is pressed", async () => {
    withFolders();

    wrap(<DecksPage />);
    const row = await screen.findByRole("button", { name: "Legends, 1 deck" });
    row.focus();
    await userEvent.keyboard("{F2}");

    const field = await screen.findByLabelText("Rename Legends");
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Legends");
    // `keyboard`, never `type`: `type` focuses the element it is handed, so a test that reached
    // the field that way would silently repair the very thing it is checking and pass against
    // a field that never took the caret. This sends to wherever the caret already is.
    await userEvent.keyboard("Partners");
    expect(field).toHaveValue("Partners");
    // Not a selection: F2 renames the row, it does not open the drawer.
    expect(screen.getByRole("heading", { name: "All decks" })).toBeInTheDocument();
  });

  /**
   * The field replaced the row, so the row is what the caret comes back to — the opener rule's
   * *reason* rather than its letter. `openerRef.current?.focus()` cannot serve here: the row is
   * a different element by the time the field is gone, and focusing a detached node drops the
   * caret onto `<body>`.
   */
  it("hands the caret back to the row when a rename is cancelled", async () => {
    withFolders();

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Commander, 2 decks" }));
    await userEvent.click(screen.getByRole("button", { name: "Rename folder…" }));
    await screen.findByLabelText("Rename Commander");

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByLabelText("Rename Commander")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commander, 2 decks" })).toHaveFocus();
    expect(deckFolderRename).not.toHaveBeenCalled();
  });

  /**
   * The opposite of what a reader will fear. `decks.folder_id` is `ON DELETE SET NULL`, so the
   * decks inside surface at the top level; `deck_folders.parent_id` cascades onto itself, so
   * the folders inside do go. The confirmation says both, reassuring half first.
   */
  it("says the decks in a folder are kept when the folder is deleted", async () => {
    withFolders();

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Commander, 2 decks" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete folder…" }));

    const confirm = screen.getByRole("dialog", { name: "Delete Commander" });
    expect(confirm).toHaveTextContent("The 2 decks in it are kept — they move to the top level.");
    expect(confirm).toHaveTextContent("The 1 folder inside goes with it.");

    await userEvent.click(within(confirm).getByRole("button", { name: "Delete folder" }));

    expect(deckFolderDelete).toHaveBeenCalledWith(1);
  });

  /**
   * A folder cannot go inside itself or inside anything it holds — the backend refuses it,
   * because `parent_id` cascades onto itself and a cycle is a graph SQLite would walk forever.
   * The offer is greyed rather than left to be refused: the refusal is a fence, not the
   * affordance.
   */
  it("will not offer a folder its own descendant as a destination, and says why", async () => {
    withFolders();

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Commander, 2 decks" }));
    await userEvent.click(screen.getByRole("button", { name: "Move folder…" }));

    const picker = screen.getByRole("dialog", { name: "Move Commander into a folder" });
    expect(within(picker).getByRole("button", { name: /^Commander/ })).toBeDisabled();
    expect(within(picker).getByRole("button", { name: "Legends" })).toBeDisabled();
    expect(picker).toHaveTextContent(
      "A folder cannot go inside itself, or inside anything it holds.",
    );
    expect(deckFolderMove).not.toHaveBeenCalled();
  });

  /**
   * And when the fence is jumped anyway — another surface re-parented something between the
   * read and the press — the refusal is surfaced rather than swallowed.
   */
  it("says so when a folder move is refused", async () => {
    withFolders();
    deckFolderMove.mockRejectedValue("A folder cannot be moved inside itself.");

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Legends, 1 deck" }));
    await userEvent.click(screen.getByRole("button", { name: "Move folder…" }));
    const picker = screen.getByRole("dialog", { name: "Move Legends into a folder" });
    await userEvent.click(within(picker).getByRole("button", { name: "All decks" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A folder cannot be moved inside itself.",
    );
  });

  /**
   * A deck whose folder this screen's folder list does not carry is drawn at the top level —
   * the same rule the tree uses for a folder whose parent is missing. It is what keeps every
   * deck reachable on the launch where `deck_folder_list` is refused: there is nowhere else a
   * tile could be shown, and hiding it would be the one failure a filing cabinet must not have.
   */
  it("still shows every deck when the folder list is refused", async () => {
    deckFolderList.mockRejectedValue("The card database is busy finishing a sync.");
    deckList.mockResolvedValue([BURN, { ...DRAFT, folderId: 1 }]);

    wrap(<DecksPage />);

    expect(await tileFor("Burn")).toBeInTheDocument();
    expect(await tileFor("Sunday draft")).toBeInTheDocument();
    expect(
      screen.getByText(/Could not read your folders — The card database is busy/),
    ).toBeInTheDocument();
  });
});
