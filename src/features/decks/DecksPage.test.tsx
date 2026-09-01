import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { DeckFolder, DeckRow, FormatSpec, ImportMatch, SyncStatus } from "@/lib/ipc";
import { cardImageUrl } from "@/lib/images";
import { isWebTarget } from "@/pwa/target";
import { openDropdown } from "@/test-dropdown";
import { spec } from "./validation/fixtures";

/**
 * Which build a cover frame thinks it is in.
 *
 * `isWebTarget()` reads `__CORE__`, a build-time constant vitest fixes at `"tauri"`, so the web
 * answer cannot be arranged any other way — `src/pwa/target.ts`'s own comment says why that is
 * deliberate. Mocked `false` by default, which is what every case in this file but the web
 * describe block expects, and reset in `beforeEach` so one case cannot leak into the next.
 */
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));

const deckList = vi.hoisted(() => vi.fn());
/** Read by `DeckSettingsDialog`, which the gallery hosts — and **only** while it is open, which
 *  is what one of the cases below asserts. */
const deckGet = vi.hoisted(() => vi.fn());
const deckCreate = vi.hoisted(() => vi.fn());
const deckUpdate = vi.hoisted(() => vi.fn());
const deckDelete = vi.hoisted(() => vi.fn());
const deckDuplicate = vi.hoisted(() => vi.fn());
const deckSetFolder = vi.hoisted(() => vi.fn());
const deckFolderList = vi.hoisted(() => vi.fn());
const deckFolderCreate = vi.hoisted(() => vi.fn());
const deckFolderRename = vi.hoisted(() => vi.fn());
const deckFolderMove = vi.hoisted(() => vi.fn());
/** The folder drag's whole write: one command places a level, `sort_order` from each id's
 *  position and `parent_id` from the argument. */
const deckFolderReorder = vi.hoisted(() => vi.fn());
const deckFolderDelete = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
/** The one `app_meta` row behind "what does a new deck start on" — read by this screen and
 *  handed to both surfaces that make a deck. `null` here means no deck has been created on this
 *  install, which is the ordinary gallery's state as far as this preference is concerned. */
const deckLastFormat = vi.hoisted(() => vi.fn());
// The import dialog's three commands and the sync it reads to tell "your list is wrong" from
// "the card database is not filled in yet". Mounted only while the dialog is open, but the
// whole `ipc` object is replaced here, so a command left out is a `TypeError` rather than a
// missing answer.
const importResolve = vi.hoisted(() => vi.fn());
const deckImportCommit = vi.hoisted(() => vi.fn());
const importReadFile = vi.hoisted(() => vi.fn());
const syncStatus = vi.hoisted(() => vi.fn());
// The gallery warms the `art` crops its tiles draw. Fire-and-forget, so the stub only has to
// resolve; what it is called with is asserted in its own test below.
const prefetchImages = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    prefetchImages,
    deckList,
    deckGet,
    deckCreate,
    deckUpdate,
    deckDelete,
    deckDuplicate,
    deckSetFolder,
    deckFolderList,
    deckFolderCreate,
    deckFolderRename,
    deckFolderMove,
    deckFolderReorder,
    deckFolderDelete,
    formatSpecs,
    deckLastFormat,
    importResolve,
    deckImportCommit,
    importReadFile,
    syncStatus,
  },
}));

import { DecksPage } from "./DecksPage";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { FOLDER_DROP_LINE_ATTR } from "@/components/FolderDropLine";
import { DEFAULT_SECTION_ZOOMS, DEFAULT_ZOOM, ZOOM_SECTIONS } from "@/lib/cardZoom";
import { useAppStore } from "@/lib/store";
import { startPointerDrag } from "@/test-drag";

/** A deck with a cover, which is the only kind that can carry an artist credit. */
const BURN: DeckRow = {
  gameKey: "any",
  id: 4,
  name: "Burn",
  formatKey: "modern",
  formatName: "Modern",
  description: null,
  coverCardId: "0000419b-0bba-4488-8f7a-6194544ce91d",
  coverArtist: "Rebecca Guay",
  archived: false,
  cardCount: 60,
  updatedAt: 1_800_000_000,
  // The four v8 deck columns, the three v12 view-state ones and `separateXGroup` from v13.
  // Every real row carries all eight, so the fixture does too.
  coverKind: "card_art",
  folderId: null,
  notes: null,
  theoryEnabled: false,
  // How the editor was last read. The gallery draws none of the three — they are here because
  // every real row carries them.
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  defaultCategoryId: 0,
  bracket: 0,
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

/** The one printing `import_resolve` answers with here — everything the plan does not
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
  // The menu provider is `App.tsx`'s in the shipped window, and it is here for the tile's
  // right-click. `useContextMenu` degrades to a no-op without one — deliberately, so that every
  // surface's own suite and story can render alone — so a test that forgot it would find a
  // right-click doing nothing rather than an error saying why.
  const view = render(
    <QueryClientProvider client={client}>
      <ContextMenuProvider>{ui}</ContextMenuProvider>
    </QueryClientProvider>,
  );
  // Handed back for the one case that has to make a *read* answer differently mid-test: a folder
  // deleted by another surface is not something any control on this screen can do.
  return { ...view, client };
}

/** The tile, addressed the way a reader sees it: the deck's name first. */
const tileFor = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name}`) });

/**
 * A right-click, and the menu it opens.
 *
 * A real `MouseEvent` rather than `fireEvent.contextMenu`, because the handler reads `clientX`
 * and `clientY` to place the panel — and `bubbles`, because the menu's own suppressor and the
 * surface's handler are on different elements.
 */
async function rightClick(target: HTMLElement) {
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await screen.findByRole("menu");
}

beforeEach(() => {
  // Desktop unless a case says otherwise. A leaked `true` would draw every cover in this file
  // from a row field the fixtures do not carry, which reads as "the gallery stopped drawing art".
  vi.mocked(isWebTarget).mockReturnValue(false);
  deckList.mockReset().mockResolvedValue([BURN, DRAFT, FILED]);
  // The hosted settings dialog's own read. Empty lists: this screen's cases are about the deck
  // row, and what the form does with cards, categories and tags is its own suite's.
  deckGet.mockReset().mockResolvedValue({ deck: BURN, cards: [], categories: [], tags: [] });
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
  deckFolderReorder.mockReset().mockResolvedValue([]);
  deckFolderDelete.mockReset().mockResolvedValue(undefined);
  formatSpecs.mockReset().mockResolvedValue(PICKER);
  // Nobody has made a deck yet, so there is no remembered format: the two create surfaces get
  // Commander, which is what `newDeckFormat` answers for a reader with no history.
  deckLastFormat.mockReset().mockResolvedValue(null);
  // One printing, so a one-line paste has something to resolve to and the Import button is
  // live. What the plan makes of it is `plan.test.ts`'s and the dialog's own to prove.
  importResolve
    .mockReset()
    .mockResolvedValue([{ index: 0, matched: SOL_RING, hintMissed: false }]);
  deckImportCommit.mockReset().mockResolvedValue({ added: 1, removed: 0, categoriesCreated: 1 });
  importReadFile.mockReset().mockResolvedValue("");
  syncStatus.mockReset().mockResolvedValue(SYNCED);
  prefetchImages.mockClear();
  // A **copy** of `DEFAULT_SECTION_ZOOMS`, never the constant itself — a case that wrote through
  // it would resize every wall in every file that has run since. The wall's geometry is a
  // function of this, so a size left behind by the zoom cases below would follow the whole suite.
  useAppStore.setState({
    openDeckId: null,
    returnToDeckId: null,
    cardZoom: { ...DEFAULT_SECTION_ZOOMS },
  });
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
   * An empty wall says it is empty, and the way out of it is where it always is.
   *
   * It used to be a paragraph about what a deck is and what the app would do with one. The
   * affordance was never those words — "New deck" sits in the heading row above on every visit,
   * empty wall or not — so the sentence was an explanation carried by the one screen least able
   * to act on it. Both halves are the claim: the placeholder, and the control still beside it.
   */
  it("says the wall is empty and still offers to make a deck", async () => {
    deckList.mockResolvedValue([]);

    wrap(<DecksPage />);

    expect(await screen.findByText("No decks")).toBeInTheDocument();
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
   * The platform, drawn **only when the deck has been given one**.
   *
   * `any` is what every deck is born as, so a tile that printed it would put a word that says
   * nothing on nearly every tile in the gallery — and the caption already truncates in a narrow
   * column. The test asserts both halves against one another because either alone passes on a
   * caption that always draws the game, or never does.
   */
  it("names the deck's game on the tile, and says nothing when it has none", async () => {
    deckList.mockResolvedValue([{ ...BURN, gameKey: "arena" }, KENRITH]);
    wrap(<DecksPage />);

    const pinned = await tileFor("Burn");
    expect(within(pinned).getByText(/Modern/)).toHaveTextContent("Modern · Arena · 60 cards");

    const unpinned = await tileFor("Kenrith Two-Drops");
    expect(within(unpinned).getByText(/Commander/)).toHaveTextContent("Commander · 100 cards");
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
   * **A cover is a card's art crop and nothing else, and three cases here went with the other
   * kind.**
   *
   * A deck could wear a picture the reader had chosen off disk, served at `/cover/<deckId>`, and
   * `coverKind` was the only answer to which of the two a tile drew — a deck carried both at
   * once, since setting either left the other alone. The three deleted cases pinned that half:
   * the route reaching the frame rather than the card id, a deck with *only* a file (no card id,
   * so no artist, which is exactly the row a `coverArtist` gate would have hidden), and the
   * `updatedAt` key that replaced the `<img>` element when new bytes landed behind a URL that
   * had not changed.
   *
   * All of it is deleted, because the picture never survived a sync: the path was stored
   * absolute, so a second device was handed a `D:\\…` and drew the card art instead. This case
   * is what is left to assert — that a row still carrying the retired word draws its card art
   * rather than nothing, which is the state a device on an older rung can still send.
   */
  it("draws card art for a row still carrying the retired cover kind", async () => {
    deckList.mockResolvedValue([{ ...BURN, coverKind: "custom" }]);

    wrap(<DecksPage />);

    const tile = (await tileFor("Burn")).closest("li")!;
    expect(tile.querySelector("img")).toHaveAttribute(
      "src",
      cardImageUrl(BURN.coverCardId!, 0, "art"),
    );
    expect(tile).not.toHaveTextContent("No cover");
    // And the credit with it: the picture on screen is the crop, so the illustrator is named.
    expect(within(tile).getByText("Art by Rebecca Guay")).toBeInTheDocument();
  });

  /**
   * The credit rides the picture it is about, and `coverArtist` is now the whole test.
   *
   * Two decks, identical but for whether the printing they name is one `cards` still has — so
   * the only thing that can explain one credit and not two is the artist. It used to be
   * `coverKind` that separated them, one deck wearing a file and one wearing a crop.
   */
  it("credits the illustrator, and only where there is one", async () => {
    deckList.mockResolvedValue([
      BURN,
      { ...BURN, id: 5, name: "Sunday burn", coverArtist: null },
    ]);

    wrap(<DecksPage />);

    const credited = (await tileFor("Burn")).closest("li")!;
    const orphaned = (await tileFor("Sunday burn")).closest("li")!;
    expect(within(credited).getByText("Art by Rebecca Guay")).toBeInTheDocument();
    expect(within(orphaned).queryByText(/art by/i)).not.toBeInTheDocument();
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
   * made wrong by later code. `DeckCoverPicker`'s `CoverPreview` had the policy right on the
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

  /**
   * **The web build has no protocol to ask, and this gallery was the loudest place it showed.**
   *
   * `mtgimg://` is registered natively with the webview and wasm cannot register a URL scheme
   * with a browser, so a tile handed `http://mtgimg.localhost/art/<id>/0` in a browser draws the
   * platform's broken-image glyph. PRs #320/#321 routed the card walls through `cardArtSrc` and
   * missed the cover frames — and PR #327 then made the card-art crop the *only* deck cover, so
   * **every** cover on web and on the phone was that glyph. Confirmed on the device before this
   * was written.
   *
   * The three cases are the three states, and each is a different `<img>` on screen: the row's
   * own URL drawn, no `<img>` at all, and — the one a browser can never see — the protocol URL
   * still winning on the desktop build even when the row carries a picture.
   */
  describe("the cover frame on the web build, where there is no protocol", () => {
    /** A real `art` crop URL: the host and the `?<epoch>` are what `is_fetchable` demands, so
     *  this is the shape the backend can actually put on a row. */
    const SUPPLIED = "https://cards.scryfall.io/art/front/0/0/0000419b.webp?1706230661";

    beforeEach(() => {
      vi.mocked(isWebTarget).mockReturnValue(true);
    });

    it("draws the URL the deck's own row carries", async () => {
      deckList.mockResolvedValue([{ ...BURN, imageUris: { art: SUPPLIED } }]);

      wrap(<DecksPage />);

      const tile = (await tileFor("Burn")).closest("li")!;
      expect(tile.querySelector("img")).toHaveAttribute("src", SUPPLIED);
      // The credit rides the picture, and the picture is on screen.
      expect(within(tile).getByText("Art by Rebecca Guay")).toBeInTheDocument();
    });

    /**
     * **"No image", not "No cover" — and the distinction is the whole of why `hasCover` was
     * split out of `coverUrl`.** The deck has chosen a cover; what is missing is the bytes.
     * Telling a reader they have not picked one, when they have, is a sentence that sends them
     * to the wrong dialog.
     */
    it("draws no img at all for a cover whose row carries no URL, and says the picture is what is missing", async () => {
      deckList.mockResolvedValue([BURN]);

      wrap(<DecksPage />);

      const tile = (await tileFor("Burn")).closest("li")!;
      expect(tile.querySelector("img")).toBeNull();
      expect(within(tile).getByText("No image")).toBeInTheDocument();
      expect(within(tile).queryByText("No cover")).not.toBeInTheDocument();
    });

    /** A deck that really has no cover still says so, on either build. */
    it("still says No cover for a deck that has chosen none", async () => {
      deckList.mockResolvedValue([DRAFT]);

      wrap(<DecksPage />);

      const tile = (await tileFor("Sunday draft")).closest("li")!;
      expect(within(tile).getByText("No cover")).toBeInTheDocument();
    });

    /** The strip is the same branch one component over, per member row. */
    it("draws a folder's member art from the member row's own URL", async () => {
      deckFolderList.mockResolvedValue([EDH, LEGENDS]);
      deckList.mockResolvedValue([
        BURN,
        { ...DRAFT, folderId: 1 },
        { ...KENRITH, imageUris: { art: SUPPLIED } },
      ]);

      wrap(<DecksPage />);

      const card = (
        await screen.findByRole("button", { name: "Commander folder, 2 decks" })
      ).closest("li")!;
      expect(card.querySelector("img")).toHaveAttribute("src", SUPPLIED);
    });

    /** And a member whose row carries none leaves an empty cell rather than a broken one — the
     *  strip's existing "the bytes have not arrived" state, which keeps its geometry. */
    it("leaves a member cell empty when that row carries no URL", async () => {
      withFolders();

      wrap(<DecksPage />);

      const card = (
        await screen.findByRole("button", { name: "Commander folder, 2 decks" })
      ).closest("li")!;
      expect(card.querySelectorAll("img")).toHaveLength(0);
      // The credit is about the cover the folder *holds*, not about whether it drew — so it is
      // still named, exactly as on the desktop build.
      expect(within(card).getByText("Art by Kieran Yanner")).toBeInTheDocument();
    });
  });

  /**
   * The other side of the branch, and it is the half a browser can never show: on desktop the
   * local cache already holds the crop at the right size, so a row that carries a URL is still
   * drawn from the protocol. A frame that preferred the supplied URL would refetch every cover
   * over the network on a wall the reader has already paid for.
   */
  it("keeps drawing the cached protocol picture on desktop when a row hands it a URL", async () => {
    deckList.mockResolvedValue([
      { ...BURN, imageUris: { art: "https://cards.scryfall.io/art/front/0/0/x.webp?1" } },
    ]);

    wrap(<DecksPage />);

    const tile = (await tileFor("Burn")).closest("li")!;
    const img = tile.querySelector("img");
    expect(img).toHaveAttribute("src", cardImageUrl(BURN.coverCardId!, 0, "art"));
    expect(img!.getAttribute("src")).not.toContain("scryfall.io");
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

    await screen.findByLabelText("Name");
    await openDropdown(userEvent.setup(), "Format");
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        "Casual",
        "Commander",
        "Modern",
        "Standard",
      ]),
    );
    // Commander, not Casual: nothing has been created on this install, so there is no remembered
    // format and `newDeckFormat` answers with what a first deck starts on. The value's own rule
    // is the test below.
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Commander");
  });

  /**
   * **A new deck starts on the format the reader last created a deck in.**
   *
   * The wiring this pins is the one thing neither dialog's own suite can see: the gallery
   * resolves the answer — it is mounted long before the button is pressed, which is what lets
   * the dialog seed its draft at mount rather than overwrite it a beat later — and hands the
   * same value to both surfaces that make a deck.
   */
  it("opens the create form on the format the last deck was created in", async () => {
    deckLastFormat.mockResolvedValue("modern");
    wrap(<DecksPage />);
    // The wall first: the draft is seeded **at mount**, so this claim is only about the wiring
    // if the screen has finished reading before the dialog is opened — which is the state a
    // reader presses the button in, the gallery having been up since the app started.
    await screen.findByRole("list", { name: "Your decks" });
    await userEvent.click(screen.getByRole("button", { name: "New deck" }));

    await screen.findByLabelText("Name");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Modern"),
    );
  });

  /** The other door into a new deck, and it starts in the same place: a pasted list makes a deck
   *  too, so the two cannot disagree about what format that deck is. */
  it("opens the import dialog on the same remembered format", async () => {
    deckLastFormat.mockResolvedValue("modern");
    wrap(<DecksPage />);
    await screen.findByRole("list", { name: "Your decks" });
    await userEvent.click(screen.getByRole("button", { name: "Import deck" }));

    // The select belongs to the new-deck **destination** since Task 12 and is drawn on the
    // preview step, beside the tally its format changes — so the list has to be read before
    // there is a select to look at. What the claim is about is unchanged: the answer this
    // screen resolved reaches both surfaces that make a deck.
    await userEvent.click(await screen.findByLabelText("Decklist"));
    await userEvent.paste("1 Sol Ring");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));

    await screen.findByRole("button", { name: "Format" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Modern"),
    );
  });

  /** Creating a deck is creating it *and* going to it — nobody makes a deck to look at a tile. */
  it("creates the deck and opens it", async () => {
    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New deck" }));

    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await openDropdown(userEvent.setup(), "Format");
    await userEvent.click(await screen.findByRole("option", { name: "Modern" }));
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
        // The dialog always sends the game, and `any` is what it always starts on: unlike the
        // format there is no `last_deck_game` to seed it from, because a filter a reader set
        // to find one format must not narrow the next dialog's list for them.
        gameKey: "any",
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
    await screen.findByRole("list", { name: "Your decks" });
    await userEvent.click(screen.getByRole("button", { name: "Import deck" }));

    await userEvent.click(await screen.findByLabelText("Decklist"));
    await userEvent.paste("1 Sol Ring");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    // The name is the destination's question and is asked on its own step.
    await userEvent.type(await screen.findByLabelText("Name"), "Sunday burn");
    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    // Commander rather than Casual, and untouched by the reader: nothing has been created on
    // this install, so the gallery's remembered format is what a first deck starts on — and it
    // reaches the import dialog exactly as it reaches the create one.
    await waitFor(() =>
      expect(deckCreate).toHaveBeenCalledWith({
        name: "Sunday burn",
        formatKey: "commander",
        gameKey: "any",
      }),
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
   * **The gallery can rename a deck now, and until this it could not.** Renaming meant opening
   * the editor and typing into its settings dialog, which is a round trip for one word.
   *
   * The field is `metaRows.tsx`'s `RenameField` — the one the folder rename already uses, and a
   * third rename control would be a third place to get the caret wrong — drawn *under* the tile
   * rather than over it: the art is how a reader knows which deck they are renaming, and a
   * `<form>` inside the tile's own `<button>` is invalid HTML.
   *
   * F2 is the route, the file manager's key and the same one the folder tree already answers.
   * The pointer's route is the tile's context menu, which is wired with the rest of them.
   */
  it("renames a deck in place, from the tile the caret is on", async () => {
    wrap(<DecksPage />);
    const tile = await tileFor("Burn");
    tile.focus();

    await userEvent.keyboard("{F2}");

    const field = await screen.findByLabelText("Rename Burn");
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Burn");
    // `keyboard`, never `type`: `type` focuses what it is handed and would repair the very
    // thing this asserts. The current name arrives selected, so typing replaces it.
    await userEvent.keyboard("Sunburn");
    expect(field).toHaveValue("Sunburn");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(deckUpdate).toHaveBeenCalledWith(4, { name: "Sunburn" });
  });

  /** Escape is the reader saying *put me back*, and the tile is where they were: the field is
   *  drawn under the tile rather than in place of it, so the opener really is still there. */
  it("hands the caret back to the tile when a rename is cancelled", async () => {
    wrap(<DecksPage />);
    const tile = await tileFor("Burn");
    tile.focus();
    await userEvent.keyboard("{F2}");
    await screen.findByLabelText("Rename Burn");

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByLabelText("Rename Burn")).not.toBeInTheDocument();
    expect(tile).toHaveFocus();
    expect(deckUpdate).not.toHaveBeenCalled();
  });

  /**
   * **`DeckSettingsDialog` gets a third host, and the gallery is it.**
   *
   * Everything a deck carries that is not a card in it — format, description, notes, cover,
   * folder, theory — was reachable only from inside the editor. `DeckSettingsForm` owns no
   * mutation and imports no hook that reaches the backend, which is exactly what lets a third
   * host draw it; nothing in that file or its suite changed to allow this.
   *
   * Reached the way the spec says it is reached: the tile's own right-click menu.
   */
  it("opens a deck's settings over the gallery, without opening the editor", async () => {
    wrap(<DecksPage />);

    await rightClick(await tileFor("Burn"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Deck settings…" }));

    const dialog = await screen.findByRole("dialog", { name: "Deck settings" });
    expect(await within(dialog).findByLabelText("Name")).toHaveValue("Burn");
    expect(deckGet).toHaveBeenCalledWith(4, "live", expect.anything());
    // The editor is what this saves the reader: the deck is not opened.
    expect(useAppStore.getState().openDeckId).toBeNull();
  });

  /**
   * The menu's other five rows, and the one that must not write.
   *
   * The rows themselves are `deckMenu.test.tsx`'s; what is asserted here is the **wiring** — that
   * this screen's callbacks are what the menu was built with, which is the half a pure builder's
   * test cannot see.
   */
  it("offers the deck's menu on a right-click, and routes delete through the question", async () => {
    wrap(<DecksPage />);

    await rightClick(await tileFor("Burn"));

    expect(screen.getAllByRole("menuitem").map((row) => row.textContent)).toEqual([
      "Open deck",
      "Rename…",
      "Move to",
      "Deck settings…",
      "Duplicate",
      "Delete…",
    ]);

    await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));

    // A menu opens by accident, so the destructive row asks rather than writes.
    expect(deckDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /delete burn/i })).toBeInTheDocument();
  });

  /** The field the menu's "Rename…" opens is the tile's own — the same one F2 opens, and not a
   *  second control for one gesture. */
  it("opens the tile's rename field from the menu", async () => {
    wrap(<DecksPage />);

    await rightClick(await tileFor("Burn"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));

    expect(await screen.findByLabelText("Rename Burn")).toHaveValue("Burn");
  });

  /**
   * **A layer the menu raised hands the caret back to the tile the menu was opened on.**
   *
   * The menu focuses that tile as it closes — and that is *not* enough, which is the whole reason
   * these three cases exist. Every layer on this screen moves the caret into itself on mount
   * (`DeleteConfirm`'s effect, `RenameField`'s, `Dialog`'s panel), so the menu's hand-back is
   * overwritten a moment later. `dismiss()` is then the only thing that can put it back, and it
   * puts it back on `openerRef` — so a menu that passed no opener leaves the caret on the panel
   * it is about to unmount, and this codebase's own rule says what happens next: an element that
   * unmounts with the caret on it drops focus to `<body>`, after which the next Tab restarts from
   * the top of the app.
   *
   * `document.activeElement`, never `toHaveFocus` on something the test pressed: `user.click`
   * focuses what it is handed, so an assertion aimed at the control that was clicked would repair
   * itself and prove nothing.
   */
  it.each([
    ["Cancel", async () => userEvent.click(screen.getByRole("button", { name: "Cancel" }))],
    ["Escape", async () => userEvent.keyboard("{Escape}")],
  ])("hands the caret back to the tile when a menu-raised delete is dropped (%s)", async (_, go) => {
    wrap(<DecksPage />);
    const tile = await tileFor("Burn");

    await rightClick(tile);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    await screen.findByRole("dialog", { name: /delete burn/i });
    await go();

    expect(document.activeElement).toBe(tile);
    expect(deckDelete).not.toHaveBeenCalled();
  });

  it("hands the caret back to the tile when a menu-raised rename is dropped", async () => {
    wrap(<DecksPage />);
    const tile = await tileFor("Burn");

    await rightClick(tile);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    await screen.findByLabelText("Rename Burn");
    await userEvent.keyboard("{Escape}");

    expect(document.activeElement).toBe(tile);
    expect(deckUpdate).not.toHaveBeenCalled();
  });

  it("hands the caret back to the tile when the menu's settings dialog is dismissed", async () => {
    wrap(<DecksPage />);
    const tile = await tileFor("Burn");

    await rightClick(tile);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Deck settings…" }));
    await screen.findByRole("dialog", { name: "Deck settings" });
    await userEvent.keyboard("{Escape}");

    expect(document.activeElement).toBe(tile);
  });

  /** Closed is nothing mounted — `Dialog`'s guarantee, and what makes hosting this on a
   *  wall of forty tiles free. */
  it("reads no deck at all until the settings dialog is opened", async () => {
    wrap(<DecksPage />);
    await tileFor("Burn");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(deckGet).not.toHaveBeenCalled();
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

  /**
   * **The question names the destination, not only the loss.** A card is in a deck because its
   * collection row physically sits in that deck's group, so a delete refiles those copies into
   * `Recently removed` rather than destroying them — the half of the sentence a reader is
   * actually afraid of. It is unconditional: no checkbox, because where the copies land is a
   * fact about the write and not an option.
   *
   * The collection's own folder-delete confirmation is the precedent this follows ("Its cards
   * move back to your collection; folders inside it are deleted"), and the failure it guards
   * against is a sentence that says only "and everything in it".
   */
  it("says where a deleted deck's cards go, with nothing to switch off", async () => {
    wrap(<DecksPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Delete Burn" }));

    const confirm = screen.getByRole("dialog", { name: /delete burn/i });
    expect(confirm).toHaveTextContent("Its 60 cards move to Recently removed.");
    expect(within(confirm).queryByRole("checkbox")).toBeNull();
    expect(deckDelete).not.toHaveBeenCalled();
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
   * The current name arrives **selected**, `metaRows.tsx`'s `RenameField` ruling for its reason:
   * the commonest rename replaces the word rather than edits inside it.
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

/* ------------------------------------------------------------------------------------------ *
 * Rearranging the cabinet by dragging a folder
 * ------------------------------------------------------------------------------------------ */

/** A second folder at the top level, so a *level* has two members and reordering one against the
 *  other is a gesture that exists at all. */
const MODERN: DeckFolder = { id: 3, parentId: null, name: "Modern", sortOrder: 1 };

/**
 * Three folders and no decks: `Commander` and `Modern` at the top level, `Legends` inside
 * `Commander`.
 *
 * The smallest cabinet that has all three landings in it — two siblings to place against each
 * other, and one of them holding a third to nest into and to refuse a cycle from. No decks on
 * purpose: every case below is about where a *folder* lands, and a wall of tiles would only add
 * card art to warm and more buttons for the name queries here to collide with.
 */
function withNestedFolders() {
  deckFolderList.mockResolvedValue([EDH, LEGENDS, MODERN]);
  deckList.mockResolvedValue([]);
}

/**
 * **jsdom has no layout engine, so every box it measures is four zeroes** — and a drop on a box
 * with no length is an `inside` by `folderEdge`'s own rule, so a suite that hoped for a real rect
 * would pass over any threshold at all. Which landing a drop means is arithmetic over a rect, so
 * the rect is what a test has to state, and dnd-kit hit-tests by coordinate, so the pointer has
 * to be somewhere real too.
 *
 * Two boxes and three landings: the folder being carried, the folder it is carried to, and where
 * along the second one the reader lets go. The boxes are **square**, so the same three landings
 * serve the sidebar's vertical tree and the wall's horizontal grid without saying which is which
 * — `folderEdge` reads only the axis it is handed. `EDGE_ZONE` is a quarter, so a tenth in from
 * either end is unambiguously beside and the middle is unambiguously inside.
 * `folderDrag.test.ts` uses the same arrangement for the same reason.
 */
const SOURCE_BOX = new DOMRect(0, 0, 100, 100);
const TARGET_BOX = new DOMRect(400, 400, 100, 100);
const LEADING = { x: 0.1, y: 0.1 };
const MIDDLE = { x: 0.5, y: 0.5 };
const TRAILING = { x: 0.9, y: 0.9 };

/** Where a drop target is, as far as the drag is concerned. */
function place(element: Element, rect: DOMRect) {
  element.getBoundingClientRect = () => rect;
}

/** Pick a folder up, having first given it somewhere to be picked up *from*: dnd-kit reads the
 *  press coordinate off the source's own box, and a source with no box presses the origin. */
async function hold(source: HTMLElement) {
  place(source, SOURCE_BOX);
  return startPointerDrag(source);
}

/**
 * A folder's row in the sidebar, as **the folder gesture** sees it.
 *
 * Both surfaces draw two nested boxes, because the drag library keeps one drop target per element
 * — the outer one is the deck's and the inner one is the folder's, and the inner one is also where
 * the folder is picked up. So this is the row's button's own parent, and it is the single element
 * every case below both starts a drag from and drops onto.
 */
async function folderRow(name: string): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name: new RegExp(`^${name}, `) });
  return button.parentElement as HTMLElement;
}

/** The same folder's other drawing: its card on the wall. Told from the row above by the word
 *  the card's own label carries — "Commander folder, 0 decks" against "Commander, 0 decks". */
async function folderCard(name: string): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name: new RegExp(`^${name} folder, `) });
  return button.parentElement as HTMLElement;
}

/** Pick a folder up, carry it over another one, let go at one of the three landings. */
async function dropOn(
  source: HTMLElement,
  target: HTMLElement,
  at: { x: number; y: number },
) {
  // A folder dropped on itself is a real gesture and the two arguments are then one element, so
  // the target keeps the box it was picked up from rather than being moved out from under the
  // pointer.
  if (target !== source) place(target, TARGET_BOX);
  const held = await hold(source);
  expect(held.started).toBe(true);
  await held.over(target, at);
  await held.drop();
}

/**
 * The line a target is drawing, as the edge it says a drop would land on — or `null` for none.
 *
 * An attribute because that is the only handle the mark has: which side it is on is a Tailwind
 * class, jsdom applies no stylesheet, and a class assertion would be a check on the source text
 * rather than on the drawing.
 */
const dropLine = (target: HTMLElement) =>
  target.querySelector(`[${FOLDER_DROP_LINE_ATTR}]`)?.getAttribute(FOLDER_DROP_LINE_ATTR) ?? null;

/** `DROP_RING` and `DROP_OVER`, asked of the class list rather than of the class string: a
 *  substring test would pass on any class that merely contains these. */
const ringed = (element: HTMLElement) => element.classList.contains("ring-2");
const washed = (element: HTMLElement) => element.classList.contains("bg-accent/10");

describe("dragging a folder", () => {
  beforeEach(() => {
    withNestedFolders();
  });

  /**
   * The middle of a folder means *inside* it, and the write is the destination's **whole level**
   * rather than the folder that moved — `sort_order` from each id's position, `parent_id` from
   * the argument, one transaction, so a drag that re-parents *and* places is never seen half
   * done.
   */
  it("files a folder inside the row it is dropped in the middle of", async () => {
    wrap(<DecksPage />);

    await dropOn(await folderRow("Modern"), await folderRow("Commander"), MIDDLE);

    // Commander held Legends and now holds both, in that order: `inside` says which drawer and
    // nothing about where in it, so the folder that arrives goes last.
    await waitFor(() => expect(deckFolderReorder).toHaveBeenCalledWith(1, [2, 3]));
    // The other drag is untouched by this one — a folder is not a deck being filed.
    expect(deckSetFolder).not.toHaveBeenCalled();
  });

  /**
   * The edge of a folder means *beside* it, and the destination is the target's own level rather
   * than the target. That difference is the whole of what the gesture reads off the pointer, and
   * a drop that ignored it would file into the folder either way.
   */
  it("places a folder beside the row it is dropped near the edge of", async () => {
    wrap(<DecksPage />);

    await dropOn(await folderRow("Modern"), await folderRow("Commander"), LEADING);

    await waitFor(() => expect(deckFolderReorder).toHaveBeenCalledWith(null, [3, 1]));
  });

  /**
   * **One folder means three things at three heights, and the mark has to say which.** A line at
   * the wrong end is a promise to file the folder in the wrong place; no line at all is the
   * honest answer where a drop would be refused, which is what `useFolderDropTarget` reports as a
   * `null` edge.
   */
  it("marks the landing the pointer is over, and nothing over a part it would refuse", async () => {
    wrap(<DecksPage />);
    const commander = await folderRow("Commander");

    place(commander, TARGET_BOX);
    const held = await hold(await folderRow("Modern"));
    // Armed the moment the folder leaves the ground: this row takes it somehow, and which way is
    // not a question a `dragstart` has a pointer position to answer.
    expect(ringed(commander)).toBe(true);

    await held.over(commander, LEADING);
    expect(dropLine(commander)).toBe("before");

    await held.over(commander, MIDDLE);
    // A nest wears the ring and the wash — the two marks the deck drag already draws for the same
    // two claims — and never a line, which is a position between folders rather than a folder
    // taking the drag.
    expect(dropLine(commander)).toBeNull();
    expect(washed(commander)).toBe(true);

    await held.over(commander, TRAILING);
    // "After Commander" is exactly where Modern already sits, so there is nothing to promise.
    expect(dropLine(commander)).toBeNull();
    expect(washed(commander)).toBe(false);

    await held.cancel();
    expect(ringed(commander)).toBe(false);
  });

  /**
   * **A folder may not go inside itself or inside anything it holds.** The backend refuses it in
   * words (`FOLDER_CYCLE`) and that refusal is a fence rather than the affordance:
   * `deck_folders.parent_id` is `ON DELETE CASCADE` on itself, so a cycle is a graph SQLite would
   * walk forever the day the folder is deleted.
   *
   * All three landings on this row are illegal and the row is dark for all three — the nest would
   * make the cycle, and either positional drop would file `Commander` under its own child, which
   * is the case the obvious spelling misses: neither the target nor the dragged folder is the
   * cycle, the *level* is.
   */
  it("refuses every landing on a folder it holds, and draws no mark at all", async () => {
    wrap(<DecksPage />);
    const legends = await folderRow("Legends");

    place(legends, TARGET_BOX);
    const held = await hold(await folderRow("Commander"));
    expect(ringed(legends)).toBe(false);

    await held.over(legends, MIDDLE);
    expect(dropLine(legends)).toBeNull();
    expect(washed(legends)).toBe(false);
    await held.drop();

    expect(deckFolderReorder).not.toHaveBeenCalled();
  });

  /** The pointer is *on* the folder being dragged for the first few pixels of every drag, so this
   *  is the refusal a reader reaches most often — and a red banner would be a worse answer to it
   *  than a gesture that quietly does nothing. */
  it("writes nothing for a folder dropped on itself", async () => {
    wrap(<DecksPage />);
    const modern = await folderRow("Modern");

    await dropOn(modern, modern, MIDDLE);

    expect(deckFolderReorder).not.toHaveBeenCalled();
  });

  /**
   * A drop that would change nothing writes nothing. `Modern` already sits directly after
   * `Commander` at the top level, so "after Commander" is the position it is in — and a write for
   * it would bump `updated_at` and re-read the tree to arrive at the list already on screen.
   */
  it("writes nothing when the drop would land the folder where it already is", async () => {
    wrap(<DecksPage />);

    await dropOn(await folderRow("Modern"), await folderRow("Commander"), TRAILING);

    expect(deckFolderReorder).not.toHaveBeenCalled();
  });

  /** `inside` says which drawer and nothing about where in it, so a folder already in that drawer
   *  has nowhere to arrive. This is the refusal the payload's own `parentId` travels for. */
  it("writes nothing for a nest into the drawer the folder is already in", async () => {
    wrap(<DecksPage />);

    await dropOn(await folderRow("Legends"), await folderRow("Commander"), MIDDLE);

    expect(deckFolderReorder).not.toHaveBeenCalled();
  });

  /**
   * **The way out of a drawer.** Every other row in the tree is a folder, so dragging a folder
   * *out* would always mean dragging it *into* something else; "All decks" is the one row that
   * means the top level, and without it a nested folder could only be lifted out through the
   * Move control.
   */
  it("files a folder back to the top level from the All decks row", async () => {
    wrap(<DecksPage />);

    await dropOn(await folderRow("Legends"), await folderRow("All decks"), MIDDLE);

    await waitFor(() => expect(deckFolderReorder).toHaveBeenCalledWith(null, [1, 3, 2]));
  });

  /**
   * …and only into itself. The root row is the level rather than a folder in one, so a line above
   * or below it would promise a place among folders it does not sit among — and the position it
   * looks like it offers, "first at the top level", is already the first folder's own leading
   * edge. It stays armed all the same, because the nest in its middle is a real landing.
   */
  it("takes no positional drop on the All decks row", async () => {
    wrap(<DecksPage />);
    const root = await folderRow("All decks");

    place(root, TARGET_BOX);
    const held = await hold(await folderRow("Legends"));
    expect(ringed(root)).toBe(true);

    await held.over(root, LEADING);
    expect(dropLine(root)).toBeNull();
    await held.drop();

    expect(deckFolderReorder).not.toHaveBeenCalled();
  });

  /** The wall's cards are the same folders drawn the other way, so the same drop means the same
   *  write there. */
  it("files a folder inside the card it is dropped in the middle of", async () => {
    wrap(<DecksPage />);

    await dropOn(await folderCard("Modern"), await folderCard("Commander"), MIDDLE);

    await waitFor(() => expect(deckFolderReorder).toHaveBeenCalledWith(1, [2, 3]));
  });

  /**
   * **The axis is the whole of what the two drawings differ by.** A wall lays folders out left to
   * right, so `before` is a card's leading *side* where it is a row's top edge — and the mark
   * proves the card was measured along the axis it is laid out on rather than the tree's.
   */
  it("places a folder beside a card, reading the wall's own axis", async () => {
    wrap(<DecksPage />);
    const commander = await folderCard("Commander");

    place(commander, TARGET_BOX);
    const held = await hold(await folderCard("Modern"));
    await held.over(commander, LEADING);
    expect(dropLine(commander)).toBe("before");
    await held.drop();

    await waitFor(() => expect(deckFolderReorder).toHaveBeenCalledWith(null, [3, 1]));
  });

  /**
   * **The two drags are not one drag, and this is the half that would break silently.** They
   * carry different marks under different keys, so each reader answers `null` for the other's
   * payload — a deck let go on a folder is still filed, and no folder gesture can reach the deck
   * write or the other way round.
   */
  it("still files a deck dropped on a folder, and reorders nothing for one", async () => {
    deckList.mockResolvedValue([BURN]);
    wrap(<DecksPage />);
    const tile = (await tileFor("Burn")).closest("li") as HTMLElement;
    // **The two drags are on one library now, so the claim rests entirely on the two marks.**
    // Until 3b a deck was a native HTML5 drag and a folder was dnd-kit's, and they could not have
    // reached each other's handlers whatever their payloads said; from here on they share a
    // registry, an event and a coordinate space, and the only thing keeping them apart is that
    // `readDeckDrag` refuses a folder record and `readFolderDrag` refuses a deck's.
    //
    // The deck's drop target is the row's **outer** box and the folder's is the inner one. Only
    // the outer gets a rect, which in a suite with no layout engine is what puts the deck target
    // in the collision pass and leaves the folder target out of it.
    const drawer = (await folderRow("Commander")).parentElement as HTMLElement;
    place(drawer, TARGET_BOX);

    const held = await hold(tile);
    expect(held.started).toBe(true);
    await held.over(drawer);
    await held.drop();

    await waitFor(() => expect(deckSetFolder).toHaveBeenCalledWith(BURN.id, 1));
    expect(deckFolderReorder).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------------------------ *
 * The keyboard's door to both menus
 * ------------------------------------------------------------------------------------------ */

/** The row for a folder, addressed the way a reader hears it: the name, then what is in it. */
const rowFor = (label: string) => screen.findByRole("button", { name: label });

/** Shift+F10 — the press Windows spells "open the context menu" with on a keyboard that has no
 *  dedicated key for it. Sent to wherever the caret already is, never to an element handed in:
 *  `user.type` focuses what it is given and would repair the very thing these cases assert. */
async function menuKeyPress() {
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await screen.findByRole("menu");
}

describe("the menus' keyboard route", () => {
  /**
   * The tile's menu without a mouse.
   *
   * The pointer half was wired with the menu itself; this is the half the reader **chose** —
   * "open by keyboard, arrows and Escape" — and a menu only a mouse can open delivers the option
   * they turned down. The tile is a `<button>`, so it is the element the press lands on.
   *
   * F2 on the same element is what the composition has to survive, and it has its own case
   * above ("renames a deck in place, from the tile the caret is on"): a `menuKey` that
   * *replaced* the tile's `onKeyDown` rather than joining it would open a menu and take the
   * rename with it, which is a menu bought with the affordance beside it.
   */
  it("opens the tile's menu on Shift+F10, from the tile the caret is on", async () => {
    wrap(<DecksPage />);
    const tile = await tileFor("Burn");
    tile.focus();

    await menuKeyPress();

    expect(screen.getAllByRole("menuitem").map((row) => row.textContent)).toEqual([
      "Open deck",
      "Rename…",
      "Move to",
      "Deck settings…",
      "Duplicate",
      "Delete…",
    ]);
  });

  it("opens the folder row's menu on Shift+F10, from the row the caret is on", async () => {
    withFolders();

    wrap(<DecksPage />);
    const row = await rowFor("Commander, 2 decks");
    row.focus();

    await menuKeyPress();

    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "New deck here",
      "New subfolder…",
      "Rename…",
      "Move to",
      "Delete…",
    ]);
  });
});

/* ------------------------------------------------------------------------------------------ *
 * The folder row's menu
 * ------------------------------------------------------------------------------------------ */

describe("the folder row's menu", () => {
  /**
   * The five things you do to a folder, on the folder — where three of them have never been.
   *
   * `Rename folder…`, `Move folder…` and `Delete folder…` speak only for the drawer the reader
   * is *standing in*, from the heading row above the wall; the tree's own controls are one
   * "New folder in …" per row and F2. So this is the first surface where a folder that is not
   * open can be acted on at all, and what the cases below assert is the **wiring** — that this
   * screen's own writes and layers are what `buildFolderMenu` was built with, which is the half
   * a pure builder's test cannot see.
   */
  it("offers the five things you do to a folder, on the row itself", async () => {
    withFolders();

    wrap(<DecksPage />);
    await rightClick(await rowFor("Commander, 2 decks"));

    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "New deck here",
      "New subfolder…",
      "Rename…",
      "Move to",
      "Delete…",
    ]);
  });

  /**
   * The pointer's route to the field F2 already opens — the *same* field, in the same place,
   * and not a second rename control.
   *
   * The caret is the interesting half. This field **replaces the row**, so the element the menu
   * hands the caret back to is unmounted before the field is even focused, and the row that
   * comes back is a different element again: `openerRef.current?.focus()` cannot serve, and the
   * page's `refocusFolderRef` is what does. That path already existed for F2 and this is the
   * first thing to prove it still holds when the field was opened from a menu.
   */
  it("opens the row's rename field from the menu and hands the caret back to the row", async () => {
    withFolders();

    wrap(<DecksPage />);
    await rightClick(await rowFor("Commander, 2 decks"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));

    const field = await screen.findByLabelText("Rename Commander");
    expect(field).toHaveFocus();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByLabelText("Rename Commander")).not.toBeInTheDocument();
    expect(await rowFor("Commander, 2 decks")).toHaveFocus();
    expect(deckFolderRename).not.toHaveBeenCalled();
  });

  it("makes a subfolder in the folder the menu was opened on", async () => {
    withFolders();

    wrap(<DecksPage />);
    await rightClick(await rowFor("Commander, 2 decks"));
    await userEvent.click(screen.getByRole("menuitem", { name: "New subfolder…" }));

    // The tree's own field, at the indent the new folder will have, saying whose it is.
    const field = await screen.findByLabelText("New folder name");
    expect(field).toHaveFocus();
    await userEvent.keyboard("Partners");
    await userEvent.click(screen.getByRole("button", { name: "Create folder" }));

    expect(deckFolderCreate).toHaveBeenCalledWith(1, "Partners");
  });

  /**
   * A move without the trip to the heading row — which is the whole reason this menu exists.
   *
   * `Move to` is a **lazy** submenu: the folder list is read when the row is expanded and never
   * when the menu opens, so a right-click costs one render and no query. Its fences are
   * `folderDestinations`', tested there; what is proved here is that the row's pick reaches
   * `deck_folder_move` with this row's folder.
   */
  it("moves the folder from the menu", async () => {
    withFolders();

    wrap(<DecksPage />);
    await rightClick(await rowFor("Legends, 1 deck"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Move to" }));

    await userEvent.click(await screen.findByRole("menuitem", { name: "All decks" }));

    expect(deckFolderMove).toHaveBeenCalledWith(2, null);
  });

  /**
   * **And the caret comes back to the row**, which is the half the write above cannot see.
   *
   * A destination is chosen exactly as `Delete…` or `Rename…` is — a `role="menuitem"` on the
   * caret's walk — so it has to end where they end. The rows behind `Move to` are drawn by a
   * `lazy` body rather than by the panel, and a body is handed only `onDone`, which
   * `ContextMenu` documents as "close the whole menu and hand focus nowhere": a row that closed
   * itself that way left the caret on a panel that was unmounting, dropped it on `<body>`, and
   * the next Tab restarted from the top of the app — with the row still on screen and still
   * focusable. Drawing the destinations with the panel's own rows is what fixes it, because
   * `ctx.run` is where the hand-back lives.
   *
   * `document.activeElement`, never `toHaveFocus` on something the test pressed: `user.click`
   * focuses what it is handed, and what it is handed here is a row that is about to unmount.
   */
  it("hands the caret back to the row when the menu's Move to writes", async () => {
    withFolders();

    wrap(<DecksPage />);
    const row = await rowFor("Legends, 1 deck");
    await rightClick(row);
    await userEvent.click(screen.getByRole("menuitem", { name: "Move to" }));

    await userEvent.click(await screen.findByRole("menuitem", { name: "All decks" }));

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(row);
  });

  /**
   * The destructive row asks rather than writes, because a menu opens by accident — and a
   * folder's delete is the one a reader guesses wrong, since the decks inside are kept and the
   * folders inside are not. The question is the gallery's own, so it is asked about the folder
   * the reader pointed at: the drawer is opened on the way, which is what puts the wall behind
   * the sentence on the thing it is about.
   */
  it("asks before deleting a folder from the menu", async () => {
    withFolders();

    wrap(<DecksPage />);
    await rightClick(await rowFor("Legends, 1 deck"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));

    expect(await screen.findByRole("dialog", { name: /delete legends/i })).toBeInTheDocument();
    expect(deckFolderDelete).not.toHaveBeenCalled();
  });

  /**
   * "New deck here" has to mean *here*.
   *
   * `CreateDeckDialog` seeded `folderId: null` whatever opened it, so a host that merely opened
   * the dialog would make the deck at the top level and the row would be a lie — the one gap
   * this wiring could not close on its own.
   */
  it("creates a deck in the folder the menu was opened on", async () => {
    withFolders();

    wrap(<DecksPage />);
    await rightClick(await rowFor("Commander, 2 decks"));
    await userEvent.click(screen.getByRole("menuitem", { name: "New deck here" }));

    await userEvent.type(await screen.findByLabelText("Name"), "Aristocrats");
    // The dialog opens on the folder rather than making the reader find it in the form.
    expect(screen.getByRole("button", { name: "Folder" })).toHaveTextContent("Commander");
    await userEvent.click(screen.getByRole("button", { name: "Create deck" }));

    await waitFor(() =>
      expect(deckCreate).toHaveBeenCalledWith({
        name: "Aristocrats",
        formatKey: "commander",
        gameKey: "any",
        theoryEnabled: false,
        folderId: 1,
      }),
    );
  });

  /**
   * **A layer the folder menu raised hands the caret back to the row the menu was opened on.**
   *
   * The menu focuses that row as it closes and that is *not* enough — the same fact the tile's
   * three cases are here for. Every layer on this screen moves the caret into itself on mount
   * (`FolderNameField`'s effect, `DeleteFolderConfirm`'s, `Dialog`'s panel), so the menu's
   * hand-back is overwritten a moment later and `dismiss()` is the only thing that can put it
   * right. It puts it on `openerRef` — so a menu row that passed no opener leaves the caret on a
   * panel about to unmount, and this codebase's own rule says what follows: focus drops to
   * `<body>` and the next Tab restarts from the top of the app.
   *
   * A menu row has no element of its own to offer, which is why the row writes itself into
   * `menuOpenerRef` as the menu opens — the deck tile's arrangement, sharing the deck tile's ref.
   *
   * `document.activeElement`, never `toHaveFocus` on something the test pressed: nothing here
   * clicks the row, so the assertion is about where the caret *landed* rather than where a
   * `user.click` put it.
   */
  it("hands the caret back to the row when a menu-raised subfolder field is dropped", async () => {
    withFolders();

    wrap(<DecksPage />);
    const row = await rowFor("Commander, 2 decks");
    await rightClick(row);
    await userEvent.click(screen.getByRole("menuitem", { name: "New subfolder…" }));
    await screen.findByLabelText("New folder name");

    await userEvent.keyboard("{Escape}");

    expect(document.activeElement).toBe(row);
    expect(deckFolderCreate).not.toHaveBeenCalled();
  });

  it("hands the caret back to the row when a menu-raised folder delete is dropped", async () => {
    withFolders();

    wrap(<DecksPage />);
    const row = await rowFor("Legends, 1 deck");
    await rightClick(row);
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    await screen.findByRole("dialog", { name: /delete legends/i });

    await userEvent.keyboard("{Escape}");

    expect(document.activeElement).toBe(row);
    expect(deckFolderDelete).not.toHaveBeenCalled();
  });

  /**
   * **The row's inline field is not part of the row's menu, and the boundary is the button.**
   *
   * A "New folder in …" field is drawn inside this row's `<li>`, as a sibling of the box the row
   * is in — so a handler on either of those would answer a right-click *inside a half-typed
   * field*, and its own `preventDefault()` plus `stopPropagation()` would keep the provider's
   * document-level carve-out from ever running: the reader would lose cut, copy, paste, undo and
   * the spellcheck suggestions and get a folder menu instead.
   *
   * `isTextField` in the primitive is the fence for the input itself. It is **not** a fence for
   * the field's own Save control, which is a `<button>` — so this is asserted on that control,
   * where the only thing keeping the menu away is which element it was attached to.
   */
  it("does not answer a right-click inside the field the row opened", async () => {
    withFolders();

    wrap(<DecksPage />);
    await rightClick(await rowFor("Commander, 2 decks"));
    await userEvent.click(screen.getByRole("menuitem", { name: "New subfolder…" }));
    await screen.findByLabelText("New folder name");

    // **Inside `act`, and that is the whole of what makes this able to fail.** A raw
    // `dispatchEvent` is not flushed synchronously, so a `queryByRole` straight after it finds
    // nothing whether or not a menu was opened — the negative would pass against the very
    // wiring it is here to forbid. `act` returns only once React has committed, so the query
    // below is asked of a tree that has already drawn whatever the press produced.
    act(() => {
      screen
        .getByRole("button", { name: "Create folder" })
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });

    expect(screen.queryByRole("menu")).toBeNull();
    // …and the field is still there to be typed into, rather than replaced by a menu about the
    // folder the reader is in the middle of making one inside.
    expect(screen.getByLabelText("New folder name")).toBeInTheDocument();
  });

  /**
   * …and at the root the heading's own "New deck" still makes one at the top level — which is
   * what keeps the assertion above about the *row the menu was opened on* rather than about the
   * dialog's default.
   *
   * It used to be the whole claim ("the heading's button always means the top level"). It is the
   * root **case** of a wider rule since 2026-09-01 — the button means the drawer the wall is
   * standing in — and at "All decks" that drawer is the top level. See the two below.
   */
  it("still creates at the top level from the heading's New deck at the root", async () => {
    withFolders();

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "New deck" }));
    await userEvent.type(await screen.findByLabelText("Name"), "Aristocrats");

    expect(screen.getByRole("button", { name: "Folder" })).toHaveTextContent("Top level");
  });

  /**
   * **The heading's "New deck" means the drawer it is drawn in the heading row of**
   * ([#332](https://github.com/Msgaihede/mtg-grimoire/issues/332)).
   *
   * The button sits under the folder's own name and over a wall showing that folder's decks, so
   * a press there is a reader filing a deck where they already are — and every one of those
   * decks had to be moved out of the top level afterwards.
   *
   * Both halves are the claim, because the dialog can only seed its draft once: the select opens
   * on the folder, **and** the write goes there. A wiring that reached one and not the other is
   * exactly what the folder menu's own case above was written for.
   */
  it("creates in the folder the wall is standing in, from the heading's New deck", async () => {
    withFolders();

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Commander, 2 decks" }));
    expect(screen.getByRole("heading", { name: "Commander" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "New deck" }));
    await userEvent.type(await screen.findByLabelText("Name"), "Aristocrats");
    expect(screen.getByRole("button", { name: "Folder" })).toHaveTextContent("Commander");
    await userEvent.click(screen.getByRole("button", { name: "Create deck" }));

    await waitFor(() =>
      expect(deckCreate).toHaveBeenCalledWith({
        name: "Aristocrats",
        formatKey: "commander",
        gameKey: "any",
        theoryEnabled: false,
        folderId: 1,
      }),
    );
  });

  /**
   * **The default is read off the *resolved* node, so a folder that has gone under the reader
   * means the top level rather than a number naming nothing.**
   *
   * `selectedFolderId` still holds the deleted id — this screen deliberately corrects a stale id
   * by *deriving* it away rather than writing it back, so there is no render where the heading
   * says a folder that is not there — and the wall is therefore already at the root. Reading the
   * raw id here would file the deck into a drawer no tree holds, under a wall saying "All decks".
   *
   * **Measured against that version rather than argued**: seeded with the stale id the Folder
   * control draws `—`, the select's answer for a value no option carries. So the failure is not
   * merely a wrong folder, it is a form with no readable answer in it — which is what makes this
   * worth a case of its own rather than a note on the one above.
   */
  it("falls back to the top level once the open folder has gone from the tree", async () => {
    withFolders();

    const { client } = wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Legends, 1 deck" }));
    expect(screen.getByRole("heading", { name: "Legends" })).toBeInTheDocument();

    // Another surface deleted it, exactly as the Escape case above stages it.
    deckFolderList.mockResolvedValue([EDH]);
    await act(async () => {
      await client.refetchQueries({ queryKey: ["decks", "folders"] });
    });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "All decks" })).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("button", { name: "New deck" }));
    await userEvent.type(await screen.findByLabelText("Name"), "Aristocrats");

    expect(screen.getByRole("button", { name: "Folder" })).toHaveTextContent("Top level");
  });

  /**
   * **Escape walks the reader up one level, and the caret goes with them.**
   *
   * Two levels in one case, because the interesting claim is that it *repeats*: a rung that read
   * the selected id rather than the resolved node would work once and then be asking a tree for
   * a folder it no longer had open.
   *
   * `document.activeElement`, never `toHaveFocus` on something the test pressed — the file's own
   * rule two describes up. Nothing here is clicked between the press and the assertion, so the
   * caret's landing place is the app's answer rather than the test's.
   */
  it("goes up one folder level on Escape, with the caret on the row it left", async () => {
    withFolders();

    wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Legends, 1 deck" }));
    expect(screen.getByRole("heading", { name: "Legends" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.getByRole("heading", { name: "Commander" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Legends, 1 deck" }));

    await userEvent.keyboard("{Escape}");

    expect(screen.getByRole("heading", { name: "All decks" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Commander, 2 decks" }));
  });

  /**
   * **…and at "All decks" the press is not the gallery's at all.**
   *
   * The rung is not registered at the root rather than registered and answering nothing, which is
   * the difference between a press that falls through to whatever the app puts below this screen
   * and one that is silently swallowed. Both look identical on screen, so `defaultPrevented` at a
   * `window` listener is the only thing that can tell them apart — and it is a *bubble* listener,
   * registered after the gallery mounted, so a rung of this screen's own would have run first.
   */
  it("leaves Escape alone at the top level", async () => {
    withFolders();

    wrap(<DecksPage />);
    await screen.findByRole("heading", { name: "All decks" });
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    await userEvent.keyboard("{Escape}");

    window.removeEventListener("keydown", listen);
    expect(heard).toEqual([false]);
    expect(screen.getByRole("heading", { name: "All decks" })).toBeInTheDocument();
  });

  /**
   * A folder the reader is standing in that goes away under them is the case `openNode` exists
   * for, and it is the one a rung reading `selectedFolderId` would get wrong: the id still names
   * the deleted folder, so "up" would be asked of a node that is not in the tree. Deriving the
   * answer instead puts the wall at the root already — where Escape is nobody's, which is what
   * this asserts rather than a throw.
   */
  it("owns no press once the open folder has gone from the tree", async () => {
    withFolders();

    const { client } = wrap(<DecksPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Legends, 1 deck" }));
    expect(screen.getByRole("heading", { name: "Legends" })).toBeInTheDocument();

    // Another surface deleted it. The gallery re-reads and the row is simply not there, so
    // `selectedFolderId` is left naming nothing — which is the whole state under test.
    deckFolderList.mockResolvedValue([EDH]);
    await act(async () => {
      await client.refetchQueries({ queryKey: ["decks", "folders"] });
    });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "All decks" })).toBeInTheDocument(),
    );

    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);
    await userEvent.keyboard("{Escape}");
    window.removeEventListener("keydown", listen);

    expect(heard).toEqual([false]);
  });
});

/**
 * The wall's own zoom — the gesture, what it writes, and the things on screen that read it.
 *
 * The gallery is the eighth card section (`lib/cardZoom.ts`) and the first whose tiles are decks
 * rather than cards. **Persistence is deliberately not tested here**: `useCardZoomPersistence` is
 * mounted once by `AppShell` and has its own suite, and this screen's whole part in remembering a
 * size across restarts is writing the right key into the store.
 */
describe("DecksPage zoom", () => {
  /** Every section at its default with `deckGallery` moved — a copy, for the `beforeEach`'s
   *  reason. */
  const atZoom = (zoom: number) =>
    useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, deckGallery: zoom } });

  const wall = () => screen.getByRole("list", { name: "Your decks" });

  /**
   * **The gesture writes the gallery's section and only that one.**
   *
   * Driven as a real `wheel` on a tile, which is where a reader's pointer is: the hook attaches a
   * native non-passive listener to the scroller, so a press that reaches the store from here also
   * proves the listener is on an ancestor of the tiles rather than on the tile itself.
   *
   * The other sections are swept out of `ZOOM_SECTIONS` rather than named, so a ninth section
   * added later is covered by this the day it exists. `deck` is the one that matters most and it
   * is in that sweep: it is the editor's cards, its key is one character from this one, and a
   * page that stepped it would resize a wall the reader cannot see.
   */
  it("steps only the deck gallery on a ctrl+wheel over the wall", async () => {
    const before = useAppStore.getState().zoomPulse;

    wrap(<DecksPage />);
    fireEvent.wheel(await tileFor("Burn"), { deltaY: -100, ctrlKey: true });

    const { cardZoom, zoomSection, zoomPulse } = useAppStore.getState();
    expect(cardZoom.deckGallery).toBe(1.1);
    for (const section of ZOOM_SECTIONS.filter((s) => s !== "deckGallery")) {
      expect(cardZoom[section]).toBe(DEFAULT_ZOOM);
    }
    // What the badge draws itself over. A gesture that stepped the right number while naming the
    // wrong section would put the figure in another wall's corner.
    expect(zoomSection).toBe("deckGallery");
    // One wheel, one pulse — read as a delta, because the counter is the session's and this file
    // is not the only thing that has run in it.
    expect(zoomPulse).toBe(before + 1);
  });

  /**
   * **A plain wheel is a scroll and nothing else** — the guard the hook returns on before it
   * measures anything. This wall scrolls for its whole life and zooms for a second of it.
   */
  it("leaves the zoom alone on a wheel with no ctrl held", async () => {
    const before = useAppStore.getState().zoomPulse;

    wrap(<DecksPage />);
    fireEvent.wheel(await tileFor("Burn"), { deltaY: -100 });

    expect(useAppStore.getState().cardZoom.deckGallery).toBe(DEFAULT_ZOOM);
    expect(useAppStore.getState().zoomPulse).toBe(before);
  });

  /**
   * **The folder tree is not part of the wall**, which is the decision the ref records: the
   * listener is on the scroller that holds the tiles, not on the view. A gesture over the rail is
   * therefore the browser's business, and the tree — navigation chrome at a fixed rail width —
   * has nothing to resize.
   *
   * This is the case that pins *where* the listener is. Every other assertion in this block would
   * pass just as well with it attached to the whole page.
   */
  it("ignores a ctrl+wheel over the folder tree", async () => {
    const before = useAppStore.getState().zoomPulse;

    wrap(<DecksPage />);
    await tileFor("Burn");
    fireEvent.wheel(screen.getByRole("navigation", { name: "Folders" }), {
      deltaY: -100,
      ctrlKey: true,
    });

    expect(useAppStore.getState().cardZoom.deckGallery).toBe(DEFAULT_ZOOM);
    expect(useAppStore.getState().zoomPulse).toBe(before);
  });

  /**
   * The wall's geometry is a function of the stored size: the track a tile is drawn in, and the
   * gutter between two of them. 200 × 1.5 is 300, and the gutter at a zoom above 1 is the same
   * multiplication — 16 × 1.5 is 24.
   */
  it("sizes the wall's tracks and gutter from the stored zoom", async () => {
    atZoom(1.5);

    wrap(<DecksPage />);
    await tileFor("Burn");

    expect(wall()).toHaveStyle({
      gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
      gap: "24px",
    });
  });

  /**
   * **The gutter has a floor and the track does not**, which is the one asymmetry on this wall: a
   * gutter is space *between* tiles, and halving it at 0.5× is precisely the zoom a reader chose
   * in order to fit more decks on screen. The tile itself is a picture and shrinks honestly.
   */
  it("shrinks the track below 1x and holds the gutter at its floor", async () => {
    atZoom(0.5);

    wrap(<DecksPage />);
    await tileFor("Burn");

    expect(wall()).toHaveStyle({
      gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
      gap: "16px",
    });
  });

  /**
   * The tiles carry the two variables everything drawn on them reads — the marks' scale, and the
   * controls' 85% of it (`CONTROL_SHRINK`). Asserted on the `<li>` rather than on the type inside
   * it because that is where the inheritance starts: a tile that set neither would draw a 14px
   * name under a doubled crop, and jsdom resolves no `calc` off a variable that is not there.
   */
  it("hands both scale variables to a deck tile", async () => {
    atZoom(1.5);

    wrap(<DecksPage />);
    const tile = (await tileFor("Burn")).closest("li");

    expect(tile).toHaveStyle({ "--mark-scale": "1.5", "--control-scale": "1.275" });
  });

  /**
   * And to a folder card, which needs it for a reason a deck tile does not have: its picture is a
   * strip of three crops at a **fixed height**, where a tile's cover is a full-width box on an
   * aspect and follows the grid track for free. A folder card that missed this would be the one
   * thing on the wall that ignored the gesture.
   */
  it("hands both scale variables to a folder card", async () => {
    withFolders();
    atZoom(1.5);

    wrap(<DecksPage />);
    const card = (await screen.findByRole("button", { name: "Commander folder, 2 decks" })).closest(
      "li",
    );

    expect(card).toHaveStyle({ "--mark-scale": "1.5", "--control-scale": "1.275" });
  });

  /**
   * Filed decks are the same wall behind a disclosure, so one size answers for both — a reader
   * who opens `Archived` after settling on a size must not find a second wall at 100%.
   */
  it("draws the archived wall at the same size", async () => {
    atZoom(1.5);

    wrap(<DecksPage />);
    await tileFor("Burn");
    await userEvent.click(screen.getByRole("button", { name: /^Archived/ }));

    expect(screen.getByRole("list", { name: "Archived decks" })).toHaveStyle({
      gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
      gap: "24px",
    });
  });
});
