/**
 * Shortcuts to the drawers a reader keeps coming back to — the collection's filing cabinet and
 * the wishlist's, side by side, each folder with what is in it and what it is worth.
 *
 * ## The three things this widget has to get right, and each is a way to be quietly wrong
 *
 * **Both folder summaries are direct per folder and never recursive, so this widget does the
 * roll-up.** `collection_folder_summary` and `wishlist_folder_summary` `GROUP BY folder_id` over
 * their own entries and stop there — `collection_folders.rs` says why in words: SQL that walked
 * the tree would be a second implementation of arithmetic `buildFolderTree` already does for
 * `FolderNode.count`, and two implementations of one figure disagree the first time either
 * changes. So a tile handed a raw `Map.get` would draw `3 cards` over a binder holding twelve in
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
 * nothing in the drawer; a tile is a small number under a name with no room for the page
 * header's "n unpriced" note, so flattening it to zero would make a drawer full of cards the
 * feed has never heard of read as a drawer worth nothing. It draws an em dash instead, which is
 * this app's answer for a price it does not have — and {@link rollUp}'s collection `add` keeps
 * that rule all the way up the tree: a child's `null` contributes nothing and a child's number
 * lifts its parent out of `null`, which is exactly how `sum()` treats a `NULL` in the statement
 * below it.
 *
 * ## Two smaller decisions
 *
 * **The app's own folders are offered and labelled rather than hidden.** A `deck`-kind folder is
 * the one group standing for a deck and `removed` is the single `Recently removed` holding area;
 * every folder *picker* in this app offers `user` and only `user`, because a picker is choosing
 * somewhere to write and those two refuse every write in words. This is a shortcut rather than a
 * destination, so both are worth pinning — but a deck's group must not read as a binder the
 * reader made, so the tile says which it is in words as well as with a glyph.
 *
 * **An empty config falls back to the top-level drawers the reader made.** `folders` is in the
 * default layout with `config: null`, so that fallback is what every reader sees before they
 * have pinned anything, and a dead card would be the first thing the home page ever said —
 * `DecksWidget`'s "six most recently updated" is the same decision on the other cabinet. The
 * fallback is `user` folders only: twenty deck groups would bury the two binders that matter.
 *
 * **The press opens the view, and today it cannot open the folder.** Which drawer a reader is
 * standing in is `useCollection`'s and `useWishlist`'s own `useState` — deliberately, so a
 * folder restored at launch cannot open the app somewhere nobody navigated to — and there is no
 * cross-view door into it. Carrying one would mean a field on the store both pages consume on
 * mount, which is a change to files this widget does not own. So a press lands on the view and
 * the folder is one press further; the day that door exists, it goes in {@link openFolder} and
 * nowhere else.
 */
import type { ReactElement, ReactNode } from "react";
import { Folder, Inbox, Layers } from "lucide-react";
import { MultiDropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { useTooltip } from "@/components/tooltip/useTooltip";
import {
  folderFace,
  type CollectionFolderTotals,
} from "@/features/collection/CollectionFolderCard";
import { DECK_KIND, REMOVED_KIND } from "@/features/collection/PinnedFolders";
import { useCollectionFolders } from "@/features/collection/useCollectionFolders";
import { useWishlistFolders } from "@/features/wishlist/useWishlistFolders";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { buildFolderTree, type FolderLike, type FolderNode } from "@/lib/folderTree";
import {
  ipcError,
  type CollectionFolder,
  type CollectionFolderSummary,
  type WishlistFolder,
  type WishlistFolderSummary,
} from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { PRESS } from "@/lib/motion";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { WidgetCard } from "../WidgetCard";
import { widgetConfig, widgetSpan } from "../layout";
import type { WidgetProps } from "../widgetProps";
import { WIDGETS } from "../widgets";

/** This widget's stored settings — two pinned sets, one per cabinet. */
export interface FoldersConfig {
  collectionFolderIds: number[];
  wishlistFolderIds: number[];
}

/**
 * The default *and* the schema — `widgetConfig` reads a stored config against this shape and
 * fills, ignores or carries through field by field, so nothing below has to guard.
 *
 * Two empty arrays rather than two absent fields: "nothing pinned" is a state this widget draws
 * (the fallback below), and it must be spellable.
 */
const FALLBACK: FoldersConfig = { collectionFolderIds: [], wishlistFolderIds: [] };

/** How many folders the fallback offers per cabinet. Six is `DecksWidget`'s number, and for its
 *  reason: enough to be a shortcut, few enough that a wide card is still one glance. */
const FALLBACK_LIMIT = 6;

/** The heading, read off the registry rather than retyped — the Add widget menu's row and the
 *  card's title are one word, and a widget that spelled its own would be the one that drifts. */
const HEADING = WIDGETS.find((meta) => meta.kind === "folders")?.label ?? "Folders";

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
 * **The whole tree in one pass rather than a sum per tile**, because a node's total is its
 * children's totals: a per-tile recursion would recompute every level of the cabinet once per
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
 * What a collection folder is, in the three vocabularies a tile needs it in.
 *
 * `badge` is the word on screen beside the name, `spoken` the one folded into the accessible
 * name, and `option` what the settings picker's row says — three because each replaces a
 * different thing: the glyph, the whole button's contents, and a bare list row.
 *
 * **The kind is compared through `PinnedFolders`' constants**, which are `schema::
 * COLLECTION_FOLDER_KINDS` spelled once for the webview. A fourth kind is a migration rather
 * than a type error — `CollectionFolder.kind` is a plain `string` on purpose — so anything this
 * build has not heard of falls through as an ordinary drawer rather than refusing to draw.
 */
function collectionKind(folder: CollectionFolder): {
  badge: string | null;
  spoken: string;
  option: string;
  Icon: typeof Folder;
} {
  if (folder.kind === DECK_KIND) {
    return { badge: "Deck", spoken: "deck folder", option: `${folder.name} (deck)`, Icon: Layers };
  }
  if (folder.kind === REMOVED_KIND) {
    return {
      badge: "Removed",
      spoken: "removed cards",
      option: `${folder.name} (removed cards)`,
      Icon: Inbox,
    };
  }
  return { badge: null, spoken: "collection folder", option: folder.name, Icon: Folder };
}

/** One tile of either wall: a bordered press with the folder's name over its figures. */
const TILE = "block w-full rounded-lg border border-border p-2 text-left hover:border-accent";

/** The kind badge — `PinnedFolders`' heading tone, at a size that sits inside a tile's name row
 *  without pushing the name out of it. */
const BADGE =
  "shrink-0 rounded border border-border px-1 text-[0.625rem] uppercase tracking-wide text-dim";

/** A sentence where the tiles would be: loading, empty, or the refusal. Its own component so the
 *  three read alike and no branch can forget the tone. */
function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-dim">{children}</p>;
}

/** One tile, whichever cabinet it came out of — the two differ in their figures and in nothing
 *  about the box, which is why they share one. */
function FolderTile({
  name,
  badge,
  Icon,
  face,
  spokenName,
  onOpen,
}: {
  name: string;
  badge: string | null;
  Icon: typeof Folder;
  face: { shown: string; spoken: string };
  /** What the whole button is called: the name, what kind of folder it is, then the figures as
   *  a sentence. **An explicit name rather than the button's own contents**, because the name
   *  and the figures sit in two elements with a gap between them and would otherwise compute to
   *  `"Binder12 cards · $30.00"` — the same trap `CollectionFolderCard` spells its `spoken` half
   *  for. WCAG 2.5.3 is what puts the visible name first. */
  spokenName: string;
  onOpen: () => void;
}) {
  const tip = useTooltip();
  return (
    <li>
      <button
        type="button"
        aria-label={spokenName}
        onClick={onOpen}
        className={cn(TILE, PRESS, FOCUS)}
      >
        <span className="flex items-center gap-2">
          <Icon className="size-3.5 flex-none text-dim" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm" {...tip(name, { whenClipped: true })}>
            {name}
          </span>
          {badge !== null && <span className={BADGE}>{badge}</span>}
        </span>
        <span className="mt-0.5 block truncate text-xs tabular-nums text-dim">{face.shown}</span>
      </button>
    </li>
  );
}

/**
 * One cabinet's half of the card: its heading, and either its tiles or the one sentence saying
 * why there are none.
 *
 * **Three states, and they are three different sentences.** A cabinet still being read must not
 * draw `0 cards` across the window the summary takes to answer — a wrong number that then jumps
 * is not a spinner — an empty cabinet is not an error, and a refused read says what the backend
 * said. Each half answers for itself, so one refusal is one refusal rather than two: a wishlist
 * the database would not read must not blank the collection beside it.
 */
function Section({
  title,
  loading,
  error,
  empty,
  children,
}: {
  title: string;
  loading: boolean;
  error: unknown;
  /** Whether there is nothing to draw — computed by the caller, because "nothing pinned and
   *  nothing to fall back to" is a fact about this widget rather than about the query. */
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0" aria-label={`${title} folders`}>
      <h4 className="mb-1.5 text-[0.7rem] font-medium uppercase tracking-wide text-dim">{title}</h4>
      {error !== null && error !== undefined ? (
        <Note>
          Could not read your {title.toLowerCase()} folders — {ipcError(error)}
        </Note>
      ) : loading ? (
        <Note>Reading your {title.toLowerCase()} folders…</Note>
      ) : empty ? (
        <Note>
          No {title.toLowerCase()} folders to show — make one in your {title.toLowerCase()}, then
          pin it here from Customize.
        </Note>
      ) : (
        <ul
          aria-label={`${title} folders`}
          className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-1.5"
        >
          {children}
        </ul>
      )}
    </section>
  );
}

/** One cabinet's picker in the settings popover — a visible label, and a trigger saying how many
 *  are pinned rather than which, because a count is what fits and a list is not. */
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

export function FoldersWidget({ widget, onConfig, ...chrome }: WidgetProps): ReactElement {
  const { currency } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const collection = useCollectionFolders();
  const wishlist = useWishlistFolders();

  const config = widgetConfig<FoldersConfig>(widget, FALLBACK);

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

  /** The folders a wall draws: the pinned ones **in the order they were pinned**, or the
   *  fallback. A pinned id whose folder is gone draws nothing and refuses nothing. */
  const pinnedCollection = pick(config.collectionFolderIds, collection.folders, () =>
    collectionNodes.filter(
      (node) => node.folder.kind !== DECK_KIND && node.folder.kind !== REMOVED_KIND,
    ),
  );
  const pinnedWishlist = pick(config.wishlistFolderIds, wishlist.folders, () => wishlistNodes);

  /** The whole config back, **spread**: `widgetConfig` carries a key this build has never heard
   *  of straight through, and that is what stops this build deleting a newer one's settings. */
  const toggle = (key: keyof FoldersConfig, value: string) => {
    const id = Number(value);
    const current = config[key];
    onConfig({
      ...config,
      [key]: current.includes(id) ? current.filter((each) => each !== id) : [...current, id],
    });
  };

  /** Where a press lands. One function so the day a folder can be opened across views, it is one
   *  edit — see this module's head. */
  const openFolder = (view: "collection" | "wishlist") => setActiveView(view);

  return (
    <WidgetCard
      {...chrome}
      heading={HEADING}
      span={widgetSpan(widget)}
      settings={
        <div className="grid gap-3">
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
        </div>
      }
    >
      <div className={widgetSpan(widget) === 2 ? "grid gap-4 md:grid-cols-2" : "grid gap-4"}>
        <Section
          title="Collection"
          loading={collection.query.isPending || collection.summaryQuery.isPending}
          error={collection.query.error ?? collection.summaryQuery.error}
          empty={pinnedCollection.length === 0}
        >
          {pinnedCollection.map((folder) => {
            const kind = collectionKind(folder);
            const face = folderFace(cardTotals.get(folder.id) ?? NO_CARDS, currency);
            return (
              <FolderTile
                key={folder.id}
                name={folder.name}
                badge={kind.badge}
                Icon={kind.Icon}
                face={face}
                spokenName={`${folder.name}, ${kind.spoken}, ${face.spoken}`}
                onOpen={() => openFolder("collection")}
              />
            );
          })}
        </Section>

        <Section
          title="Wishlist"
          loading={wishlist.query.isPending || wishlist.summaryQuery.isPending}
          error={wishlist.query.error ?? wishlist.summaryQuery.error}
          empty={pinnedWishlist.length === 0}
        >
          {pinnedWishlist.map((folder) => {
            const face = wishFace(wishTotals.get(folder.id) ?? NO_WISHES, currency);
            return (
              <FolderTile
                key={folder.id}
                name={folder.name}
                badge={null}
                Icon={Folder}
                face={face}
                spokenName={`${folder.name}, wishlist folder, ${face.spoken}`}
                onOpen={() => openFolder("wishlist")}
              />
            );
          })}
        </Section>
      </div>
    </WidgetCard>
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

/**
 * Which folders a wall draws.
 *
 * The pinned ids resolved **in the order they were pinned** — the reader chose both which and
 * where — and an id naming nothing dropped, because another surface deleting a folder is a race
 * rather than a mistake. With nothing pinned it is the caller's fallback level, capped: read off
 * the *tree* rather than filtered out of the flat rows, because a folder whose parent this list
 * does not carry is drawn at the root, and "the top level" has to mean the level a reader can
 * see.
 */
function pick<F extends FolderLike>(
  ids: readonly number[],
  folders: readonly F[],
  fallback: () => readonly FolderNode<F>[],
): readonly F[] {
  if (ids.length === 0) return fallback().slice(0, FALLBACK_LIMIT).map((node) => node.folder);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return ids.flatMap((id) => {
    const folder = byId.get(id);
    return folder === undefined ? [] : [folder];
  });
}
