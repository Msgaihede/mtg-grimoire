/**
 * Folder rules on the wishlist (issue #980, spec §5) — `CollectionPage.rules.test.tsx`'s cases,
 * lighter, on this cabinet: the heading's badge, `Rules…` and its save, and the red outline.
 *
 * A harness of its own for that file's reason: `WishlistPage.test.tsx`'s `ipc` mock is an object
 * literal of the commands it answers, and these cases need two more.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { SEARCH_OPEN_KEY } from "@/features/search/useSearchOpen";
import { SHELF_HEADING_ATTR } from "@/features/shelves/ShelfHeading";
import { SHELF_FOLDS_KEY } from "@/features/shelves/useShelfFolds";
import { RULE_BREAK } from "@/lib/folderRules";
import type { ShelfCount, WishlistFolder, WishlistQuery, WishRow } from "@/lib/ipc";

const cmd = vi.hoisted(() => {
  const names = [
    "wishlistList",
    "wishlistSetQuantity",
    "wishlistRemove",
    "wishlistAdd",
    "collectionAdd",
    "getMarketplace",
    "importResolve",
    "wishlistImportCommit",
    "oracleTagsForPrintings",
    "wishlistFolderList",
    "wishlistFolderSummary",
    "wishlistFolderCreate",
    "wishlistFolderRename",
    "wishlistFolderMove",
    "wishlistFolderReorder",
    "wishlistFolderDelete",
    "wishlistFolderClear",
    "wishlistFolderDeleteWithWishes",
    "wishlistFolderSetRules",
    "wishlistRuleConflicts",
    "wishlistSetFolder",
    "wishlistOptimizePlan",
    "wishlistOptimizeApply",
    "searchCards",
    "facetCards",
    "listSets",
    "prefetchImages",
    "searchOpen",
    "setSearchOpen",
    "wishlistShelfCounts",
    "shelfFolds",
    "setShelfFolds",
    "deckList",
    "bulkUndo",
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

import { WishlistPage } from "./WishlistPage";
import { useNotifications } from "@/lib/notifications";
import { useAppStore } from "@/lib/store";

/** Wishes for cards of one colour — `Colour: Red`. */
const REDS: WishlistFolder = {
  id: 1,
  parentId: null,
  name: "Reds",
  sortOrder: 0,
  managedDeckId: null,
  managedTokens: false,
  syncUid: null,
  managedDeckUid: null,
  rules: [{ kind: "colors", values: ["R"] }],
};

const BOLT: WishRow = {
  legalities: null,
  layout: null,
  id: 7,
  oracleId: "o-bolt",
  cardId: "c1",
  folderId: 1,
  elsewhere: 0,
  ownedExact: 0,
  ownedOther: 0,
  heldExact: 0,
  heldOther: 0,
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  typeLine: "Instant",
  artCardId: "c1",
  quantity: 1,
  preferredFinish: null,
  unitPrice: 400.5,
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
};
/** Filed with the reds, and blue — the wish that breaks the rule. */
const RECALL: WishRow = {
  ...BOLT,
  id: 8,
  oracleId: "o-recall",
  cardId: "c-recall",
  artCardId: "c-recall",
  name: "Ancestral Recall",
  manaCost: "{U}",
  quantity: 3,
};

function countsFor(items: readonly WishRow[], shelves?: readonly number[]): ShelfCount[] {
  const by = new Map<number, ShelfCount>();
  for (const w of items) {
    const id = w.folderId ?? 0;
    if (shelves !== undefined && !shelves.includes(id)) continue;
    const c = by.get(id) ?? { folderId: id, tiles: 0, copies: 0, value: 0, unpriced: 0, peek: [] };
    c.tiles += 1;
    c.copies += w.quantity;
    by.set(id, c);
  }
  return [...by.values()];
}

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SEARCH_OPEN_KEY, { wishlist: false });
  client.setQueryData(SHELF_FOLDS_KEY, { collection: {}, wishlist: {} });
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
  cmd.wishlistList.mockResolvedValue({ items: [BOLT, RECALL], total: 2 });
  cmd.wishlistShelfCounts.mockImplementation(async (q: WishlistQuery) =>
    countsFor([BOLT, RECALL], q.shelves),
  );
  cmd.getMarketplace.mockResolvedValue("tcgplayer");
  cmd.oracleTagsForPrintings.mockResolvedValue([]);
  cmd.wishlistFolderList.mockResolvedValue([REDS]);
  cmd.wishlistFolderSummary.mockResolvedValue([]);
  cmd.wishlistFolderSetRules.mockResolvedValue(REDS);
  cmd.wishlistRuleConflicts.mockResolvedValue({
    ids: [8],
    folders: [{ folderId: 1, entries: 1, copies: 3 }],
  });
  cmd.wishlistOptimizePlan.mockResolvedValue({
    moves: [],
    considered: 0,
    alreadyCheapest: 0,
    skipped: 0,
  });
  cmd.searchCards.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  cmd.facetCards.mockResolvedValue({
    colors: {},
    manaValues: {},
    manaX: 0,
    formats: {},
    sets: {},
    owned: { owned: 0, missing: 0 },
    total: 0,
    ready: false,
  });
  cmd.listSets.mockResolvedValue([]);
  cmd.shelfFolds.mockResolvedValue({ collection: {}, wishlist: {} });
  cmd.searchOpen.mockResolvedValue({});
  cmd.deckList.mockResolvedValue([]);
  useNotifications.setState({ notices: [] });
  useAppStore.setState({
    wishlistView: "grid",
    selectedCardId: null,
    pendingFolder: null,
    pendingReviewFilter: null,
    pendingOptimize: null,
  });
});

describe("WishlistPage — folder rules", () => {
  it("badges a folder with rules, and outlines the wish that breaks them", async () => {
    const { container } = wrap(<WishlistPage />);
    const reds = await findHeading("Reds");
    const badge = await waitFor(() =>
      within(reds).getByRole("img", { name: /This folder's rules: Colour: Red\./ }),
    );
    await waitFor(() =>
      expect(badge).toHaveAccessibleName(expect.stringContaining("3 cards don't match")),
    );

    const broken = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(`[aria-description="${RULE_BREAK}"]`);
      if (found === null) throw new Error("no outlined tile yet");
      return found;
    });
    expect(broken).toHaveAccessibleName(expect.stringContaining("Ancestral Recall"));
    expect(broken.closest("[data-grid-index]")).toHaveClass("ring-destructive");
    expect(container.querySelectorAll(".ring-destructive")).toHaveLength(1);
  });

  it("marks the breaking wish's table row", async () => {
    useAppStore.setState({ wishlistView: "table" });
    wrap(<WishlistPage />);
    const recall = await screen.findByRole("row", { name: /Ancestral Recall/ });
    expect(recall).toHaveAttribute("aria-description", RULE_BREAK);
    expect(recall.className).toContain("--color-destructive");
    expect(screen.getByRole("row", { name: /Lightning Bolt/ })).not.toHaveAttribute(
      "aria-description",
    );
  });

  it("saves a folder's rules from Rules…, with one toast", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    const reds = await findHeading("Reds");

    await user.click(within(reds).getByRole("button", { name: "Manage Reds" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rules…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rules for “Reds”" });
    await user.click(within(dialog).getByRole("button", { name: "Save rules" }));

    await waitFor(() =>
      expect(cmd.wishlistFolderSetRules).toHaveBeenCalledWith(1, [
        { kind: "colors", values: ["R"] },
      ]),
    );
    await waitFor(() =>
      expect(useNotifications.getState().notices[0]).toMatchObject({
        title: "Saved rules for “Reds”",
        tone: "success",
      }),
    );
    expect(useNotifications.getState().notices).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
