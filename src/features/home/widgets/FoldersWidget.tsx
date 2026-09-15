/**
 * Shortcuts to the drawers a reader keeps coming back to — the collection's filing cabinet and
 * the wishlist's, each folder with what is in it and what it is worth.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the chip, the settings popover and the
 * Customize tray; this draws one list of rows cut to the box `fit` describes. The two pin pickers
 * that used to sit in this widget's own popover are {@link FoldersWidgetSettings}, drawn by the card
 * under the registry's `Cabinets` row and `Show which cabinet` switch.
 *
 * ## The three things this widget has to get right, and each is a way to be quietly wrong
 *
 * **Both folder summaries are direct per folder and never recursive, so this widget does the
 * roll-up.** `collection_folder_summary` and `wishlist_folder_summary` `GROUP BY folder_id` over
 * their own entries and stop there — `collection_folders.rs` says why in words: SQL that walked
 * the tree would be a second implementation of arithmetic `buildFolderTree` already does for
 * `FolderNode.count`, and two implementations of one figure disagree the first time either
 * changes. So a row handed a raw `Map.get` would draw `3 cards` over a binder holding twelve in
 * two sub-folders, and the reader would only catch it by opening the drawer. {@link rollUp} is
 * that walk, over the drawn tree — `CollectionPage.tsx`'s and `WishlistPage.tsx`'s `subtotalsOf`
 * are the same arithmetic, one cabinet each, and both are module-private to their pages; this is
 * the one generic spelling, parameterised over what "add" means for a cabinet's own fields.
 *
 * **Both summaries exclude the root and return no row at all for an empty folder.** A folder the
 * lookup misses is a folder with nothing in it — not an error, and not a reason to draw a
 * blank — so the *list* is the census and the summary is a lookup layered onto it. `0 cards` is the
 * honest face of an empty drawer, and an empty drawer is where the next card goes.
 *
 * **`CollectionFolderSummary.value` is `number | null` where `CollectionSummary.value` is
 * `coalesce(…, 0.0)`, and the two differ deliberately.** A `null` is the marketplace pricing
 * nothing in the drawer; a row has no room for the page header's "n unpriced" note, so flattening
 * it to zero would make a drawer full of cards the feed has never heard of read as a drawer worth
 * nothing. It draws an em dash instead, and {@link rollUp}'s collection `add` keeps that rule all
 * the way up the tree: a child's `null` contributes nothing and a child's number lifts its parent
 * out of `null`, which is exactly how `sum()` treats a `NULL` in the statement below it.
 *
 * ## Smaller decisions
 *
 * **The app's own folders are offered and labelled rather than hidden.** A `deck`-kind folder is
 * the one group standing for a deck and `removed` is the single `Recently removed` holding area;
 * every folder *picker* in this app offers `user` and only `user`, because a picker is choosing
 * somewhere to write and those two refuse every write in words. This is a shortcut rather than a
 * destination, so both are worth pinning — but a deck's group must not read as a binder the
 * reader made, so the row says which it is in words (its caption and its accessible name) as well
 * as with a glyph.
 *
 * **An empty pin set falls back to the top-level drawers the reader made.** `folders` is in the
 * default layout with `config: null`, so that fallback is what every reader sees before they have
 * pinned anything, and a dead card would be the first thing the home page ever said. The fallback
 * is `user` folders only: twenty deck groups would bury the two binders that matter. **It is no
 * longer capped at six per cabinet** — that number was a wide card's glance, and the box now
 * decides how many rows are a glance.
 *
 * **The press opens the view *and* the folder, through a door that is one field wide.** Which
 * drawer a reader is standing in is still `useCollection`'s and `useWishlist`'s own `useState` —
 * deliberately, so a folder restored at launch cannot open the app somewhere nobody navigated to
 * — so what this widget writes is not that state but a **one-shot hand-off**: `store.ts`'s
 * `pendingFolder`, which the page that answers reads once on its way in and spends. The two writes
 * are **ordered** — `setActiveView` first, `setPendingFolder` second — because a view change is
 * what *clears* a hand-off, so the other order would have this widget wipe the folder it just
 * named (`docs/reference/home-page.md` §8); and both live in {@link FoldersWidget}'s one
 * `openFolder`, which every row presses.
 */
import type { ReactElement, ReactNode } from "react";
import { Folder, Heart, Inbox, Layers } from "lucide-react";
import { MultiDropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import {
  folderFace,
  type CollectionFolderTotals,
} from "@/features/collection/CollectionFolderCard";
import { DECK_KIND, REMOVED_KIND } from "@/features/collection/PinnedFolders";
import { useCollectionFolders } from "@/features/collection/useCollectionFolders";
import { useWishlistFolders } from "@/features/wishlist/useWishlistFolders";
import { count, plural } from "@/lib/counts";
import { buildFolderTree, type FolderLike, type FolderNode } from "@/lib/folderTree";
import {
  ipcError,
  type CollectionFolder,
  type CollectionFolderSummary,
  type HomeWidget,
  type WishlistFolder,
  type WishlistFolderSummary,
} from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { widgetConfig } from "../layout";
import { WidgetMessage, WidgetRow, WidgetRowList } from "../WidgetParts";
import type { WidgetBodyProps, WidgetSettingsProps } from "../widgetProps";
import { pickOf, toggleOn } from "../widgetSettings";

/** Which cabinets the widget draws — the registry's `cabinets` pick. */
export type Cabinets = "both" | "collection" | "wishlist";

/** Which cabinet one folder came out of — the same word `pendingFolder.scope` carries. */
type Cabinet = "collection" | "wishlist";

/** This widget's stored pins — one set per cabinet. */
export interface FoldersConfig {
  collectionFolderIds: number[];
  wishlistFolderIds: number[];
}

/** A bare row is one line; a row with a caption — or with its figure moved under the name on a
 *  two-cell tile — is two. The design's numbers. */
const ROW_WITH_CAPTION = 51;
const ROW_BARE = 36;
/** One sentence standing in for a cabinet, before the rows are counted: a line of `text-sm`. */
const MESSAGE_LINE = 20;

/** Stable identity for a tree built with no members to count: {@link buildFolderTree} sums
 *  `FolderNode.count` from this list, and this widget counts through the summaries instead. */
const NO_MEMBERS: readonly [] = [];

/** The wishlist's four figures, rolled up. `WishFolderCard`'s own `WishFolderSummary` minus the
 *  folder id, which is the map's key here. */
interface WishTotals {
  wishes: number;
  copies: number;
  cost: number;
  unpriced: number;
}

const NO_CARDS: CollectionFolderTotals = { cards: 0, value: null };
const NO_WISHES: WishTotals = { wishes: 0, copies: 0, cost: 0, unpriced: 0 };

/** The glyph colours — the design's `iconColor`: a drawer of cardboard is the accent, a wish is the
 *  heart's red, and the app's own folders are dim, because a glyph is where "these are four
 *  different statements" is cheapest to say. */
const ACCENT = "var(--color-accent)";
const WISH = "var(--color-pie-r)";
const DIM = "var(--color-dim)";

/** The list's accessible name, per scope — the card's title is `Folders` either way, so the list
 *  says which cabinets it holds. */
const LIST_LABEL: Record<Cabinets, string> = {
  both: "Collection and wishlist folders",
  collection: "Collection folders",
  wishlist: "Wishlist folders",
};

/** Which cabinets this widget draws. A stored word no option carries reads as `both`. */
export function cabinetsOf(widget: HomeWidget): Cabinets {
  const value = pickOf(widget, "cabinets");
  return value === "collection" || value === "wishlist" ? value : "both";
}

/**
 * The pins, narrowed.
 *
 * A fresh fallback per call, and the **elements** checked here: `widgetConfig`'s shape check
 * accepts any array for an empty-array fallback, so a hand-edited `["3"]` is a pin that answers to
 * no folder and is dropped the way a deleted folder is.
 */
export function foldersConfig(widget: HomeWidget): FoldersConfig {
  const config = widgetConfig<FoldersConfig>(widget, {
    collectionFolderIds: [],
    wishlistFolderIds: [],
  });
  return {
    collectionFolderIds: config.collectionFolderIds.filter((id) => Number.isInteger(id)),
    wishlistFolderIds: config.wishlistFolderIds.filter((id) => Number.isInteger(id)),
  };
}

/**
 * Every folder's figures **with everything filed under it added in**, indexed by folder id.
 *
 * One walk for both cabinets, parameterised over what a folder's own figures are and what
 * adding two sets of them means — the pages each have this walk written out over their own
 * fields (`CollectionPage.tsx`'s `subtotalsOf`, `WishlistPage.tsx`'s beside it), and both are
 * private to the module they sit in, so this is a third *spelling* rather than a third
 * *implementation*: the tree it walks is `buildFolderTree`'s, which is the one place the shape
 * of the cabinet is decided.
 *
 * **The whole tree in one pass rather than a sum per row**, because a node's total is its
 * children's totals: a per-row recursion would recompute every level of the cabinet once per
 * level. A folder caught in a corrupt cycle is drawn at the root as a leaf by the tree builder
 * and totals to its own row here, which is the same answer the two pages give.
 */
function rollUp<F extends FolderLike, T>(
  nodes: readonly FolderNode<F>[],
  own: (id: number) => T,
  add: (into: T, under: T) => T,
): ReadonlyMap<number, T> {
  const out = new Map<number, T>();
  const visit = (node: FolderNode<F>): T => {
    let total = own(node.folder.id);
    for (const child of node.children) total = add(total, visit(child));
    out.set(node.folder.id, total);
    return total;
  };
  for (const node of nodes) visit(node);
  return out;
}

/**
 * Two folders' copies and money, added.
 *
 * **A `null` value stays `null` all the way up, and only until something under it is priced.**
 * The backend answers `None` for a drawer the marketplace could price nothing in, and a sub-tree
 * in which *nothing* is priced has to say the same rather than `$0.00` — but a drawer holding
 * one priced card and one unpriced one is worth what the priced one is worth.
 */
function addCards(into: CollectionFolderTotals, under: CollectionFolderTotals) {
  return {
    cards: into.cards + under.cards,
    value: under.value === null ? into.value : (into.value ?? 0) + under.value,
  };
}

function addWishes(into: WishTotals, under: WishTotals): WishTotals {
  return {
    wishes: into.wishes + under.wishes,
    copies: into.copies + under.copies,
    cost: into.cost + under.cost,
    // It travels with the subtotal it qualifies, so it rolls up with it: a parent whose child
    // holds three cards nobody quoted is a parent with three unpriced cards in it.
    unpriced: into.unpriced + under.unpriced,
  };
}

/**
 * The wishlist folder's face, in the two spellings every folder tile in this app draws.
 *
 * `shown` is joined with the app's `·` and `spoken` with commas, because an `aria-label`
 * replaces everything inside the control and a middot read aloud is punctuation nobody asked
 * for. **A mirror of `WishFolderCard`'s own `face`, which is module-private there** — the rule
 * is that one's and is repeated here rather than diverged from: an empty drawer shows its wish
 * count and no money at all (`$0.00` under `0 wishes` is noise), and a folder whose every copy
 * is unpriced draws an em dash rather than claiming the marketplace quoted nothing for them.
 *
 * The collection's half of this is `folderFace`, which **is** exported and is imported above:
 * a second spelling of "12 cards · $340.00" is a second chance for two walls to disagree.
 */
function wishFace(summary: WishTotals, currency: Currency): { shown: string; spoken: string } {
  const wishes = plural(summary.wishes, "wish", "wishes");
  if (summary.copies === 0) return { shown: wishes, spoken: wishes };
  const parts = [
    formatPrice(summary.cost > 0 ? summary.cost : null, currency),
    ...(summary.unpriced > 0 ? [`${summary.unpriced} unpriced`] : []),
  ];
  return { shown: [wishes, ...parts].join(" · "), spoken: [wishes, ...parts].join(", ") };
}

/**
 * What a collection folder is, in the vocabularies a row needs it in.
 *
 * `lead` opens the caption, `spoken` is folded into the accessible name, and `option` is what the
 * settings picker's row says — three because each replaces a different thing.
 *
 * **The kind is compared through `PinnedFolders`' constants**, which are `schema::
 * COLLECTION_FOLDER_KINDS` spelled once for the webview. A fourth kind is a migration rather
 * than a type error — `CollectionFolder.kind` is a plain `string` on purpose — so anything this
 * build has not heard of falls through as an ordinary drawer rather than refusing to draw.
 */
function collectionKind(folder: CollectionFolder): {
  lead: string;
  spoken: string;
  option: string;
  Icon: typeof Folder;
  color: string;
} {
  if (folder.kind === DECK_KIND) {
    return {
      lead: "Deck folder",
      spoken: "deck folder",
      option: `${folder.name} (deck)`,
      Icon: Layers,
      color: DIM,
    };
  }
  if (folder.kind === REMOVED_KIND) {
    return {
      lead: "Removed cards",
      spoken: "removed cards",
      option: `${folder.name} (removed cards)`,
      Icon: Inbox,
      color: DIM,
    };
  }
  return {
    lead: "Collection",
    spoken: "collection folder",
    option: folder.name,
    Icon: Folder,
    color: ACCENT,
  };
}

/** One row, whichever cabinet it came out of — already worded, so drawing it decides nothing. */
interface FolderRowModel {
  key: string;
  cabinet: Cabinet;
  id: number;
  name: string;
  /** The caption a comfortable panel carries: which cabinet, and what is in the drawer. */
  caption: string;
  /** The money at the right, or `undefined` for a drawer holding nothing — which has no price. */
  money: string | undefined;
  /** The count alone — what a bare row shows in place of money it does not have. */
  count: string;
  /** The folder's whole face, for a two-cell tile that moves its figure under the name. */
  face: string;
  spokenName: string;
  icon: ReactNode;
  color: string;
}

/** The two facts about a query a cabinet's state is read from. */
interface QueryState {
  isPending: boolean;
  error: unknown;
}

/** One cabinet's answer: still being read, refused, or rows (which may be none). */
type CabinetState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "rows"; rows: FolderRowModel[] };

/**
 * Which folders a cabinet draws.
 *
 * The pinned ids resolved **in the order they were pinned** — the reader chose both which and
 * where — and an id naming nothing dropped, because another surface deleting a folder is a race
 * rather than a mistake. With nothing pinned it is the caller's fallback level: read off the
 * *tree* rather than filtered out of the flat rows, because a folder whose parent this list does
 * not carry is drawn at the root, and "the top level" has to mean the level a reader can see.
 */
function pick<F extends FolderLike>(
  ids: readonly number[],
  folders: readonly F[],
  fallback: () => readonly FolderNode<F>[],
): readonly F[] {
  if (ids.length === 0) return fallback().map((node) => node.folder);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const seen = new Set<number>();
  return ids.flatMap((id) => {
    const folder = byId.get(id);
    if (folder === undefined || seen.has(id)) return [];
    seen.add(id);
    return [folder];
  });
}

/**
 * Two cabinets' rows cut to `n`, **shared** rather than first-come.
 *
 * Collection rows first and wishlist rows after, which is the order the eye reads a cabinet in —
 * but each is guaranteed half the box when it has that many, and whatever one side cannot use goes
 * to the other. A collection of twenty drawers taking the first `n` would push the wishlist off a
 * small card entirely, and a `Both` card with no wishlist on it is a card lying about its scope.
 */
export function shareRows<T>(first: readonly T[], second: readonly T[], n: number): T[] {
  const firstTake = Math.min(first.length, Math.max(Math.ceil(n / 2), n - second.length));
  const secondTake = Math.min(second.length, n - firstTake);
  return [...first.slice(0, firstTake), ...second.slice(0, secondTake)];
}

export function FoldersWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const { currency } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setPendingFolder = useAppStore((s) => s.setPendingFolder);
  const collection = useCollectionFolders();
  const wishlist = useWishlistFolders();

  const cabinets = cabinetsOf(widget);
  const config = foldersConfig(widget);

  /**
   * Both cabinets as trees, then both rolled up.
   *
   * Built from the folder *list* rather than from the summary, which is the census rule: a
   * folder holding nothing has no summary row at all, so a tree built from the summary would
   * have no node for exactly the drawer whose whole job is to be empty.
   */
  const collectionNodes = buildFolderTree<CollectionFolder>(collection.folders, NO_MEMBERS);
  const cardTotals = rollUp(
    collectionNodes,
    (id) => summaryTotals(collection.summary.get(id)),
    addCards,
  );
  const wishlistNodes = buildFolderTree<WishlistFolder>(wishlist.folders, NO_MEMBERS);
  const wishTotals = rollUp(
    wishlistNodes,
    (id) => wishSummary(wishlist.summary.get(id)),
    addWishes,
  );

  const collectionRows = (): FolderRowModel[] =>
    pick(config.collectionFolderIds, collection.folders, () =>
      collectionNodes.filter(
        (node) => node.folder.kind !== DECK_KIND && node.folder.kind !== REMOVED_KIND,
      ),
    ).map((folder) => {
      const kind = collectionKind(folder);
      const totals = cardTotals.get(folder.id) ?? NO_CARDS;
      const face = folderFace(totals, currency);
      // `folderFace`'s own count spelling, so the row's count and the tile's never disagree about
      // how "1,204 cards" is written.
      const cards = `${count(totals.cards)} ${totals.cards === 1 ? "card" : "cards"}`;
      return {
        key: `collection-${folder.id}`,
        cabinet: "collection",
        id: folder.id,
        name: folder.name,
        caption: `${kind.lead} · ${cards}`,
        // An empty drawer shows its count and no money at all — `folderFace`'s rule.
        money: totals.cards === 0 ? undefined : formatPrice(totals.value, currency),
        count: cards,
        face: face.shown,
        spokenName: `${folder.name}, ${kind.spoken}, ${face.spoken}`,
        icon: <kind.Icon className="size-3.5" aria-hidden="true" />,
        color: kind.color,
      };
    });

  const wishlistRows = (): FolderRowModel[] =>
    pick(config.wishlistFolderIds, wishlist.folders, () => wishlistNodes).map((folder) => {
      const totals = wishTotals.get(folder.id) ?? NO_WISHES;
      const face = wishFace(totals, currency);
      const wishes = plural(totals.wishes, "wish", "wishes");
      return {
        key: `wishlist-${folder.id}`,
        cabinet: "wishlist",
        id: folder.id,
        name: folder.name,
        // The unpriced count qualifies the money beside it, so it rides in the caption the money
        // has no room for — the same place `wishFace` puts it.
        caption: `Wishlist · ${wishes}${totals.unpriced > 0 ? ` · ${totals.unpriced} unpriced` : ""}`,
        money:
          totals.copies === 0
            ? undefined
            : formatPrice(totals.cost > 0 ? totals.cost : null, currency),
        count: wishes,
        face: face.shown,
        spokenName: `${folder.name}, wishlist folder, ${face.spoken}`,
        icon: <Heart className="size-3.5" aria-hidden="true" />,
        color: WISH,
      };
    });

  /**
   * One cabinet's state. **Each answers for itself**, so one refusal is one refusal rather than
   * two: a wishlist the database would not read must not blank the collection beside it. And a
   * cabinet still being read must not draw `0 cards` across the window the summary takes to
   * answer — a wrong number that then jumps is not a spinner.
   */
  const state = (
    folders: { query: QueryState; summaryQuery: QueryState },
    rows: () => FolderRowModel[],
  ): CabinetState => {
    const error = folders.query.error ?? folders.summaryQuery.error;
    if (error !== null && error !== undefined) return { kind: "error", error };
    if (folders.query.isPending || folders.summaryQuery.isPending) return { kind: "loading" };
    return { kind: "rows", rows: rows() };
  };

  const shown: { cabinet: Cabinet; state: CabinetState }[] = [];
  if (cabinets !== "wishlist") {
    shown.push({ cabinet: "collection", state: state(collection, collectionRows) });
  }
  if (cabinets !== "collection") {
    shown.push({ cabinet: "wishlist", state: state(wishlist, wishlistRows) });
  }

  // The three sentences a cabinet says instead of rows, in the order the cabinets are drawn.
  const messages = shown.flatMap(({ cabinet, state: each }) => {
    if (each.kind === "error") {
      return [
        <WidgetMessage key={cabinet} tone="destructive">
          Could not read your {cabinet} folders — {ipcError(each.error)}
        </WidgetMessage>,
      ];
    }
    if (each.kind === "loading") {
      return [<WidgetMessage key={cabinet}>Reading your {cabinet} folders…</WidgetMessage>];
    }
    if (each.rows.length === 0) {
      return [
        <WidgetMessage key={cabinet}>
          No {cabinet} folders to show — make one in your {cabinet}, then pin it here from
          Customize.
        </WidgetMessage>,
      ];
    }
    return [];
  });

  const rowsOf = (cabinet: Cabinet): FolderRowModel[] => {
    const entry = shown.find((each) => each.cabinet === cabinet)?.state;
    return entry?.kind === "rows" ? entry.rows : [];
  };

  /**
   * What the box carries, from the design's `body()`: a caption needs a panel, a comfortable
   * density and the `Show which cabinet` switch. **On a two-cell tile the figure moves under the
   * name**, so that row is two lines with no caption and is counted at a caption row's height —
   * counting it at a bare row's would cut the list to more rows than the box holds.
   */
  const tile = fit.tier === 0;
  const bare = fit.compact || tile || !toggleOn(widget, "captions");
  const rowH = bare && !tile ? ROW_BARE : ROW_WITH_CAPTION;
  const reserved = messages.length * (MESSAGE_LINE + fit.rowGap);
  const rows = shareRows(rowsOf("collection"), rowsOf("wishlist"), fit.rowsFit(rowH, reserved));

  /**
   * Where a press lands — the view, and the drawer inside it.
   *
   * **The two writes are in this order and must stay in it.** `setActiveView` clears
   * `pendingFolder` on every view change, which is what keeps a hand-off nobody read from opening
   * a folder the reader asked for one navigation ago — so naming the folder *before* the view
   * would have this line wipe its own press. Written the right way round, the clear is spent on
   * whatever was stale before the press and the hand-off written after it survives to the page.
   *
   * Both `set`s land in one React commit (they are made from one event handler), so the page
   * mounts with the folder already named; it would still work if they did not, because each page
   * reads the field as it renders rather than only as it mounts.
   */
  const openFolder = (cabinet: Cabinet, id: number) => {
    setActiveView(cabinet);
    setPendingFolder({ scope: cabinet, id });
  };

  return (
    <>
      {messages}
      {rows.length > 0 && (
        <WidgetRowList fit={fit} label={LIST_LABEL[cabinets]}>
          {rows.map((row) => (
            <WidgetRow
              key={row.key}
              name={row.name}
              caption={tile ? row.face : bare ? undefined : row.caption}
              captionStrong={tile}
              // A bare row that has no money — an empty drawer — shows its count instead, so the
              // one fact an empty drawer has is still on the row.
              value={tile ? undefined : bare ? (row.money ?? row.count) : row.money}
              icon={row.icon}
              iconColor={row.color}
              onPress={still ? undefined : () => openFolder(row.cabinet, row.id)}
              /**
               * The name, what kind of folder it is, then the figures as a sentence. **An explicit
               * name rather than the row's own contents**, because the name and the figures sit in
               * elements with a gap between them and would otherwise compute to
               * `"Binder12 cards · $30.00"` — the trap `CollectionFolderCard` spells its `spoken`
               * half for. WCAG 2.5.3 is what puts the visible name first.
               */
              pressLabel={still ? undefined : row.spokenName}
            />
          ))}
        </WidgetRowList>
      )}
    </>
  );
}

/** A folder's own copies and money — the summary row, or the empty drawer it stands for when
 *  there is none. See this module's head: a miss here is *empty*, never *unknown*. */
function summaryTotals(row: CollectionFolderSummary | undefined): CollectionFolderTotals {
  return row === undefined ? NO_CARDS : { cards: row.cards, value: row.value };
}

function wishSummary(row: WishlistFolderSummary | undefined): WishTotals {
  return row === undefined
    ? NO_WISHES
    : { wishes: row.wishes, copies: row.copies, cost: row.cost, unpriced: row.unpriced };
}

/** One cabinet's picker — a visible label, and a trigger saying how many are pinned rather than
 *  which, because a count is what fits and a list is not. */
function Picker({
  id,
  label,
  options,
  selected,
  onToggle,
}: {
  id: string;
  label: string;
  options: readonly DropdownOption[];
  selected: readonly number[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="grid gap-1">
      {/* Both `id` and `labelledBy`: the first keeps the pointer behaviour a `<label for>` has,
          the second states the accessible name outright rather than leaving it to an
          association a later edit could quietly break. */}
      <label id={`${id}-label`} htmlFor={id} className="text-xs text-dim">
        {label}
      </label>
      <MultiDropdown
        id={id}
        labelledBy={`${id}-label`}
        size="sm"
        fill
        options={options}
        selected={selected.map(String)}
        onToggle={onToggle}
        triggerLabel={selected.length === 0 ? "Automatic" : plural(selected.length, "folder")}
      />
    </div>
  );
}

/**
 * The two pin pickers, moved out of the old card's popover.
 *
 * **A picker is drawn only for a cabinet the card draws.** A `Wishlist folders` picker on a card
 * set to `Collection` would be a control whose every press changes nothing on screen, which reads
 * as broken; the `Cabinets` row is directly above this, and a hidden cabinet's pins are **kept**,
 * so switching back to `Both` brings them back as they were.
 *
 * **The patch names one key**, where the old widget spread its whole config back: the page merges
 * a patch into the stored config and keeps every key it was not handed, a newer build's included,
 * so the spread's job is the page's now.
 */
export function FoldersWidgetSettings({ widget, onConfig }: WidgetSettingsProps): ReactElement {
  const collection = useCollectionFolders();
  const wishlist = useWishlistFolders();
  const cabinets = cabinetsOf(widget);
  const config = foldersConfig(widget);

  /** Add at the end, remove in place — the stored order is the order the reader pinned in. */
  const toggle = (key: keyof FoldersConfig, value: string) => {
    const id = Number(value);
    const current = config[key];
    onConfig({
      [key]: current.includes(id) ? current.filter((each) => each !== id) : [...current, id],
    });
  };

  return (
    <div className="grid gap-3">
      <p className="m-0 text-xs text-dim">
        With nothing pinned, a cabinet shows the top-level folders you made.
      </p>
      {cabinets !== "wishlist" && (
        <Picker
          id={`${widget.id}-collection-folders`}
          label="Collection folders"
          // Every folder there is, the app's own included and labelled — a shortcut may point
          // at a deck's group where a *destination* picker may not.
          options={collection.folders.map((each) => ({
            value: String(each.id),
            label: collectionKind(each).option,
          }))}
          selected={config.collectionFolderIds}
          onToggle={(value) => toggle("collectionFolderIds", value)}
        />
      )}
      {cabinets !== "collection" && (
        <Picker
          id={`${widget.id}-wishlist-folders`}
          label="Wishlist folders"
          options={wishlist.folders.map((each) => ({
            value: String(each.id),
            label: each.name,
          }))}
          selected={config.wishlistFolderIds}
          onToggle={(value) => toggle("wishlistFolderIds", value)}
        />
      )}
    </div>
  );
}
