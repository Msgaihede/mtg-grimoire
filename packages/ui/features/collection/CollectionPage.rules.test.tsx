/**
 * Folder rules on the collection page (issue #980, spec §5): the badge a folder with rules wears
 * on its heading and beside the path row, `Folder options → Rules…` and its save, and the red
 * outline a conflicting copy wears on the wall and in the table.
 *
 * A harness of its own rather than a block in `CollectionPage.test.tsx`: that file's `ipc` mock
 * is an object literal of the commands *it* answers, and these cases need two more. The commands
 * below are the ones a mount of this page reaches, each answered with the empty cabinet's answer
 * unless a case says otherwise.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { SHELF_HEADING_ATTR } from "@/features/shelves/ShelfHeading";
import { RULE_BREAK } from "@/lib/folderRules";
import type {
  CollectionFolder,
  CollectionQuery,
  CollectionRow,
  RuleConflicts,
  ShelfCount,
} from "@/lib/ipc";
import { UNFILED_SHELF } from "@/lib/shelves";

const cmd = vi.hoisted(() => {
  const names = [
    "searchCards",
    "searchOpen",
    "setSearchOpen",
    "shareList",
    "shareCreate",
    "shareRefresh",
    "shareRevoke",
    "shareOpen",
    "syncSupporterStatus",
    "facetCards",
    "collectionList",
    "collectionSummary",
    "collectionSetQuantity",
    "collectionRemove",
    "collectionUpdate",
    "collectionAdd",
    "wishlistAdd",
    "listSets",
    "prewarmCollection",
    "getMarketplace",
    "deckList",
    "deckFolderList",
    "deckGet",
    "deckAddCard",
    "oracleTagsForPrintings",
    "importResolve",
    "collectionImportCommit",
    "collectionFolderList",
    "collectionFolderSummary",
    "collectionFolderCreate",
    "collectionFolderRename",
    "collectionFolderMove",
    "collectionFolderReorder",
    "collectionFolderDelete",
    "collectionFolderSetLocked",
    "collectionFolderSetRules",
    "collectionRuleConflicts",
    "collectionSetFolder",
    "collectionRemovedClear",
    "collectionRemoveMany",
    "collectionSetFolderMany",
    "bulkUndo",
    "collectionShelfCounts",
    "shelfFolds",
    "setShelfFolds",
  ] as const;
  return Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<
    (typeof names)[number],
    ReturnType<typeof vi.fn>
  >;
});
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: cmd,
}));

import { CollectionPage } from "./CollectionPage";
import { useNotifications } from "@/lib/notifications";
import { useAppStore } from "@/lib/store";

const BOLT: CollectionRow = {
  promoTypes: null,
  legalities: null,
  id: 7,
  cardId: "c1",
  folderId: 3,
  folderName: "Trade binder",
  name: "Lightning Bolt",
  oracleId: "o1",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  typeLine: "Instant",
  layout: "normal",
  finish: "nonfoil",
  condition: "NM",
  quantity: 2,
  tradelistQuantity: 0,
  unitPrice: 400.5,
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
  tags: "[]",
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
};
/** A second copy in the same drawer that matches its rules — the outline is per copy. */
const SHOCK: CollectionRow = {
  ...BOLT,
  id: 8,
  cardId: "c2",
  oracleId: "o2",
  name: "Shock",
  collectorNumber: "162",
  quantity: 1,
  unitPrice: 0.25,
};

/** A drawer for cheap cards — `Price up to $1.00`. */
const BINDER: CollectionFolder = {
  id: 3,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
  syncUid: "uid-binder",
  rules: [{ kind: "price", min: null, max: 1 }],
};

const CONFLICTS: RuleConflicts = { ids: [7], folders: [{ folderId: 3, entries: 1, copies: 2 }] };

function shelfCountsOf(rows: readonly CollectionRow[], shelves: readonly number[] | undefined) {
  const by = new Map<number, ShelfCount>();
  for (const row of rows) {
    const shelf = row.folderId ?? UNFILED_SHELF;
    if (shelves !== undefined && !shelves.includes(shelf)) continue;
    const at = by.get(shelf) ?? {
      folderId: shelf,
      tiles: 0,
      copies: 0,
      value: 0,
      unpriced: 0,
      peek: [],
    };
    at.tiles += 1;
    at.copies += row.quantity;
    at.value = (at.value ?? 0) + (row.unitPrice ?? 0) * row.quantity;
    by.set(shelf, at);
  }
  return [...by.values()];
}

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ContextMenuProvider>{ui}</ContextMenuProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function heading(name: string): HTMLElement {
  const chevron = screen
    .queryAllByRole("button", { name: new RegExp(`^(Collapse|Expand) ${name}$`) })
    .find((el) => el.closest(`[${SHELF_HEADING_ATTR}]`) !== null);
  const found = chevron?.closest<HTMLElement>(`[${SHELF_HEADING_ATTR}]`);
  if (!found) throw new Error(`no heading for ${name}`);
  return found;
}
const findHeading = (name: string) => waitFor(() => heading(name), { timeout: 5000 });

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(cleanup);

beforeEach(() => {
  for (const fn of Object.values(cmd)) fn.mockReset().mockResolvedValue(undefined);
  cmd.searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  cmd.searchOpen.mockResolvedValue({ collection: false });
  cmd.shareList.mockResolvedValue([]);
  cmd.syncSupporterStatus.mockResolvedValue({
    entitled: false,
    status: "none",
    since: null,
    groupBound: false,
  });
  cmd.facetCards.mockResolvedValue({
    colors: {},
    manaValues: {},
    manaX: 0,
    formats: {},
    sets: {},
    rarities: {},
    owned: { owned: 0, missing: 0 },
    total: 0,
    ready: false,
  });
  cmd.collectionList.mockResolvedValue({ items: [BOLT, SHOCK], total: 2 });
  cmd.collectionSummary.mockResolvedValue({
    totalCards: 3,
    uniqueCards: 2,
    entries: 2,
    tradelistCards: 0,
    value: 801.25,
    unpriced: 0,
    needsReview: 0,
  });
  cmd.listSets.mockResolvedValue([]);
  cmd.prewarmCollection.mockResolvedValue(0);
  cmd.getMarketplace.mockResolvedValue("tcgplayer");
  cmd.deckList.mockResolvedValue([]);
  cmd.deckFolderList.mockResolvedValue([]);
  cmd.oracleTagsForPrintings.mockResolvedValue([]);
  cmd.collectionFolderList.mockResolvedValue([BINDER]);
  cmd.collectionFolderSummary.mockResolvedValue([]);
  cmd.collectionFolderSetRules.mockResolvedValue({ ...BINDER, rules: [] });
  cmd.collectionRuleConflicts.mockResolvedValue(CONFLICTS);
  cmd.collectionShelfCounts.mockImplementation(async (query: CollectionQuery) =>
    shelfCountsOf([BOLT, SHOCK], query.shelves),
  );
  cmd.shelfFolds.mockResolvedValue({ collection: {}, wishlist: {} });
  useNotifications.setState({ notices: [] });
  useAppStore.setState({
    collectionView: "grid",
    selectedCardId: null,
    paneFinish: null,
    cardSelection: null,
    pendingFolder: null,
    pendingReviewFilter: null,
  });
});

describe("CollectionPage — folder rules", () => {
  it("badges a folder with rules on its heading, counting its conflicting copies", async () => {
    wrap(<CollectionPage />);
    const binder = await findHeading("Trade binder");
    const badge = await waitFor(() =>
      within(binder).getByRole("img", { name: /This folder's rules: Price up to \$1\.00\./ }),
    );
    await waitFor(() =>
      expect(badge).toHaveAccessibleName(expect.stringContaining("2 cards don't match")),
    );
  });

  it("outlines a tile whose copy breaks its folder's rules, and only that tile", async () => {
    const { container } = wrap(<CollectionPage />);
    await findHeading("Trade binder");
    const broken = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(`[aria-description="${RULE_BREAK}"]`);
      if (found === null) throw new Error("no outlined tile yet");
      return found;
    });
    expect(broken).toHaveAccessibleName(expect.stringContaining("Lightning Bolt"));
    expect(broken.closest("[data-grid-index]")).toHaveClass("ring-destructive");
    expect(container.querySelectorAll(`[aria-description="${RULE_BREAK}"]`)).toHaveLength(1);
    expect(container.querySelectorAll(".ring-destructive")).toHaveLength(1);
  });

  it("marks a conflicting table row with the red edge and the reason", async () => {
    useAppStore.setState({ collectionView: "table" });
    wrap(<CollectionPage />);
    await findHeading("Trade binder");
    const bolt = await screen.findByRole("row", { name: /Lightning Bolt/ });
    const shock = screen.getByRole("row", { name: /Shock/ });
    expect(bolt).toHaveAttribute("aria-description", RULE_BREAK);
    expect(bolt.className).toContain("shadow-[inset_2px_0_0_var(--color-destructive)]");
    expect(shock).not.toHaveAttribute("aria-description");
    expect(shock.className).not.toContain("--color-destructive");
  });

  it("opens Rules… from the folder's menu and saves through the rules write, with a toast", async () => {
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    const binder = await findHeading("Trade binder");

    await user.click(within(binder).getByRole("button", { name: "Manage Trade binder" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rules…" }));

    const dialog = await screen.findByRole("dialog", { name: "Rules for “Trade binder”" });
    await user.click(within(dialog).getByRole("button", { name: /^Remove rule 1/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save rules" }));

    await waitFor(() => expect(cmd.collectionFolderSetRules).toHaveBeenCalledWith(3, []));
    await waitFor(() =>
      expect(useNotifications.getState().notices[0]).toMatchObject({
        title: "Cleared rules for “Trade binder”",
        tone: "success",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says a refused save in a toast and keeps the dialog open", async () => {
    cmd.collectionFolderSetRules.mockRejectedValue("A folder can hold at most 20 rules.");
    const user = userEvent.setup();
    wrap(<CollectionPage />);
    const binder = await findHeading("Trade binder");

    await user.click(within(binder).getByRole("button", { name: "Manage Trade binder" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rules…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rules for “Trade binder”" });
    await user.click(within(dialog).getByRole("button", { name: "Save rules" }));

    await waitFor(() =>
      expect(useNotifications.getState().notices[0]).toMatchObject({
        title: "Couldn't save rules for “Trade binder”",
        tone: "error",
      }),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "A folder can hold at most 20 rules.",
    );
  });

  it("badges the folder the reader is standing in beside the path row", async () => {
    useAppStore.setState({ pendingFolder: { scope: "collection", id: 3 } });
    wrap(<CollectionPage />);
    const crumbs = await screen.findByRole("navigation", { name: "Collection folders" });
    const badge = await screen.findByRole("img", { name: /This folder's rules: Price up to/ });
    // On the path row, not inside a heading — the level's own heading is not drawn on its wall.
    expect(badge.closest(`[${SHELF_HEADING_ATTR}]`)).toBeNull();
    expect(crumbs.parentElement?.parentElement).toContainElement(badge);
  });

  it("draws no badge and no outline in a cabinet with no rules", async () => {
    cmd.collectionFolderList.mockResolvedValue([{ ...BINDER, rules: [] }]);
    cmd.collectionRuleConflicts.mockResolvedValue({ ids: [], folders: [] });
    const { container } = wrap(<CollectionPage />);
    const binder = await findHeading("Trade binder");
    await waitFor(() => {
      if (container.querySelector('[data-grid-index="1"]') === null) throw new Error("no wall");
    });
    expect(within(binder).queryByRole("img", { name: /rules/ })).toBeNull();
    expect(container.querySelector(".ring-destructive")).toBeNull();
  });
});
