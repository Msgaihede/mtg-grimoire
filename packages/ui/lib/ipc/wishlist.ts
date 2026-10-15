/**
 * The wishlist: wishes, the list and its summary, its folders, and the optimise plan.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `wishlistCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import type { Finish } from "../finish";
import type { MarketplaceId } from "../marketplace";
import type { SortSpec } from "../sort";
import type { CardFilters, WishlistSortKey } from "./cards";
import type {
  BreakdownRow,
  EntryChange,
  FolderRule,
  ImportCommitOutcome,
  RuleConflicts,
  ShelfCount,
  TransferImportMode,
} from "./collection";
import { invoke } from "./invoke";

/**
 * One wish, as the UI sends it.
 *
 * Either identifier will do: `cardId` alone pins the wish to that printing and looks the
 * oracle id and name up from it; `oracleId` alone means "any printing", and needs a `name`
 * of its own when no printing of it is in the card database — a shopping list that cannot
 * say what it is shopping for is not a list.
 */
export interface WishInput {
  /** Absent means **any printing**, which is what a wishlist usually means. */
  cardId?: string;
  oracleId?: string;
  name?: string;
  quantity: number;
  /** A wish *for the foil* is a different wish from one for the nonfoil, and is not filled
   *  by it. Absent means no preference. */
  preferredFinish?: Finish;
  notes?: string;
  /** Where a menu add files it. Absent is the root wishlist — nothing has to be filed for the
   *  list to work, and this is the field that keeps that true for a fresh install. It is part
   *  of the row's storage grain, the same way {@link WishInput.preferredFinish} is: adding the
   *  same card to two different folders is two wishes, never one row that moves. */
  folderId?: number | null;
}

/** One line of a bulk import, after this side has decided everything a *wishlist* decision is. */
export interface WishlistImportItem {
  oracleId?: string;
  /** Absent is a wish for **any printing** — what a wishlist usually means, and what the
   *  planner writes for a line that named no set. Not a looser version of a pinned wish: the
   *  storage grain already treats the two as different rows. */
  cardId?: string;
  quantity: number;
  preferredFinish?: Finish;
  notes?: string;
}

export interface WishlistQuery extends CardFilters {
  /** Ignored, exactly as {@link CollectionQuery.paperOnly} is, and for the same reason. */
  paperOnly?: boolean;
  /** `true` narrows to the wishes a Scryfall migration or a vanished printing flagged — the
   *  reconciler walks this table too, so this is {@link CollectionQuery.needsReview}'s
   *  question asked of the other list. */
  needsReview?: boolean;
  /**
   * Which folder the list is being read at. `null` is the root wishlist — a real destination,
   * the same folder every unfiled wish lands in, and not to be confused with "no folder
   * filter" (that is {@link WishlistQuery.flatten}).
   *
   * This is navigation, not a filter: it is where the reader is standing rather than something
   * they narrowed, so it plays no part in an active-filter count and a Reset leaves it alone.
   */
  folderId?: number | null;
  /**
   * `true` ignores {@link WishlistQuery.folderId} entirely and returns every wish regardless
   * of filing. Default `false`.
   *
   * It exists because a nullable `folderId` cannot carry three states on its own: `null` is
   * already spoken for as "the root wishlist", so there would be no value left to mean "no
   * folder filter at all, show everything" — this flag is that third state, kept separate
   * rather than smuggled into `folderId` as some other sentinel.
   */
  flatten?: boolean;
  /**
   * **The shelves to answer, in the order to answer them** — {@link CollectionQuery.shelves} one
   * table over: folder ids, `0` for the root. **Sent, it replaces {@link folderId} and
   * {@link flatten}**; rows come back in list position, then the sort, then id. Absent is today's
   * answer — the root, or every wish when flattened.
   */
  shelves?: number[];
  /** How to order the list, first column deciding. Empty or absent is name order. */
  sort?: SortSpec<WishlistSortKey>;
  /** Which marketplace every price is quoted from, and therefore what the `cost` and `price`
   *  orders rank by. Absent means `tcgplayer`; see {@link SearchRequest.marketplace}. */
  marketplace?: MarketplaceId;
  /** Clamped to 500 by the backend; 0 means "use the default page size" (100). */
  limit: number;
  offset: number;
}

export interface WishRow {
  id: number;
  oracleId: string | null;
  /** `null` = any printing. */
  cardId: string | null;
  /**
   * The {@link WishlistFolder} this wish is filed in, or `null` for the root wishlist —
   * `wishlist_entries.folder_id`, answered on every row rather than made optional, because a
   * wish is always filed *somewhere* and the backend always knows where.
   *
   * A card added twice to two different folders is two rows here with two different values of
   * this field, never one row that moved — {@link WishInput.folderId}'s grain rule, seen from
   * the read side.
   */
  folderId: number | null;
  /** Never null: a wish carries its own name, because it outlives the printing it was made
   *  from and may never have had one. */
  name: string;
  setCode: string | null;
  collectorNumber: string | null;
  lang: string | null;
  rarity: string | null;
  manaCost: string | null;
  /**
   * The joined card's type line, for one reader: a **pinned wish dragged onto the sidebar's
   * Decks entry**, which lands in a deck with no column to have been pointed at, so
   * `autoCategoryFor` names the pile from this and nothing else.
   *
   * `null` only when the join found no card at all — an orphan. An *any-printing* wish does
   * carry one, because the query coalesces to the newest printing of its oracle card, the same
   * way `rarity` and `manaCost` beside it do. Nothing on the wishlist draws it.
   */
  typeLine: string | null;
  /**
   * The printing this wish is **drawn as** — what the wall puts a picture of on its tile.
   *
   * Not {@link WishRow.cardId} and never to be read as one: that is what the wish is *for* and
   * is `null` for an any-printing wish, while this is answered for both kinds by the same join
   * `rarity` and `manaCost` come off. A pinned wish resolves to its own printing; an unpinned
   * one to the newest printing of its oracle card, so the tile has art while its caption goes
   * on saying "Any printing".
   *
   * `null` is a genuine orphan — no printing in `cards`, no oracle match — and draws the
   * no-art frame with the name.
   */
  artCardId: string | null;
  /**
   * The layout of the printing {@link WishRow.artCardId} names — what the wall reads to decide
   * whether a tile turns over (issue #844). Off the same join, so it is the layout of the
   * picture on screen; `null` exactly where `artCardId` is.
   */
  layout: string | null;
  quantity: number;
  preferredFinish: string | null;
  /** The cheapest way to satisfy this wish, per copy, at the marketplace the query named: the
   *  preferred finish's price if one is named, else the nonfoil price of the printing (or of
   *  any printing of the oracle card). `null` is unpriced there — {@link CollectionRow.unitPrice}
   *  has the rule and the two ways a hole happens. */
  unitPrice: number | null;
  /**
   * How many *other* wishes exist for the same oracle card — a correlated count, `0` on an
   * orphan with no oracle id, answered on every row rather than made optional because it is
   * cheap over a list that runs to tens of rows and is computed in SQL rather than in
   * TypeScript for the reason {@link WishlistPage} is paged: a page cannot see the wishes it
   * did not fetch, so a client-side count would only ever be honest about the page itself.
   *
   * This is the field that catches what filing makes possible: with `folderId` part of the
   * storage grain, a card the reader has already filed in `Ordered` and a deck sweep re-adds
   * gets a **second row at the root**, not a bump to the existing one. A non-zero `elsewhere`
   * is what tells the reader that second row exists before they buy the same card twice — it
   * counts the same oracle card, not the same printing, because two wishes for two different
   * printings of one card are still two chances to order it twice over.
   */
  elsewhere: number;
  /**
   * Copies the collection holds **that answer this wish's printing** — every finish, condition
   * and folder (issue #988). A pinned wish counts its own printing; an any-printing wish is
   * answered by every printing, so it counts the whole card here and {@link WishRow.ownedOther}
   * is `0`.
   *
   * A report and never arithmetic: nothing subtracts it from {@link WishRow.quantity} or costs
   * the wish by it — the reader decides whether the wish still stands.
   */
  ownedExact: number;
  /** Copies the collection holds of **other printings of the same card** — `0` for an
   *  any-printing wish and for an orphan with no oracle id. */
  ownedOther: number;
  /**
   * **Where those copies are filed** (issue #1055) — {@link WishRow.ownedExact} and
   * {@link WishRow.ownedOther} by collection folder, one entry per folder holding any. Summed,
   * the two counts are the two above; empty when the collection holds none. Ids rather than
   * names: the path is built from the collection's folder list, as every other folder mark is.
   */
  ownedPlaces: WishOwnedPlace[];
  notes: string | null;
  needsReview: string | null;
  /** Unix seconds. */
  updatedAt: number;
  /**
   * JSON: the joined printing's legality blob — the fact the Arena export filter reads
   * (issue #192), and its only reader. {@link CollectionRow.legalities} carries the argument
   * for the blob over a mask.
   *
   * **An any-printing wish carries one**, the same way {@link WishRow.typeLine} and
   * {@link WishRow.artCardId} beside it do: the join coalesces to the newest printing of the
   * wish's oracle card. `null` is a genuine orphan — no pinned printing, no oracle match.
   */
  legalities: string | null;
}

/** One collection folder's share of a wish's owned copies — {@link WishRow.ownedPlaces}. */
export interface WishOwnedPlace {
  /** The collection folder, or `null` for copies filed in no folder (`Not sorted`). */
  folderId: number | null;
  /** Copies here that answer the wish's printing — {@link WishRow.ownedExact}'s reading. */
  exact: number;
  /** Copies here of another printing of the same card — {@link WishRow.ownedOther}'s reading. */
  other: number;
}

export interface WishlistPage {
  items: WishRow[];
  total: number;
}

/**
 * The whole wishlist as one aggregate — {@link CollectionSummary} one cabinet over, and
 * deliberately not its twin: a shopping list has no condition, no tradelist and nothing to
 * review.
 *
 * **It is the folder subtotals plus the root, which is the whole reason it is its own command.**
 * {@link WishlistFolderSummary} comes from a query carrying `WHERE w.folder_id IS NOT NULL` —
 * what keeps root-level wishes out of a folder tile — and a list total that inherited that clause
 * would be wrong by exactly the root, silently and only for readers who file some of their wishes.
 * Same expression, one clause fewer.
 */
export interface WishlistSummary {
  /** Rows, not copies: how many distinct things the reader is shopping for. */
  wishes: number;
  /** Copies, summed over those rows. */
  copies: number;
  /**
   * What they would cost at the marketplace the caller named, over the copies it has a price
   * for. An **any-printing** wish is priced at its cheapest printing, the same join a folder
   * tile uses — so the two figures are two readings of one expression rather than two opinions.
   */
  cost: number;
  /** Copies with no price for their finish at that marketplace — {@link CollectionSummary.unpriced}'s
   *  rule and its reason: a cost that silently omits them is a number that lies by rounding
   *  down, and the count has to travel beside the figure because the two marketplaces do not
   *  have the same holes. */
  unpriced: number;
}

/**
 * One printing in an optimise plan — either the one a wish is pinned to now, or the one the
 * sweep would move it to.
 *
 * The three descriptive columns are `cards`', not the wish's: a plan is about printings that
 * exist today, and the denormalised `setCode`/`collectorNumber`/`lang` a wish carries can
 * describe a printing Scryfall has since removed. `from` is therefore read off the wish's
 * printing **through `cards`** — a wish pinned to a vanished id is skipped entirely, because
 * there is nothing to compare against.
 */
export interface OptimizePrinting {
  cardId: string;
  setCode: string;
  collectorNumber: string;
  lang: string;
  /**
   * Per copy, at the plan's marketplace and **at the wish's finish** —
   * `sorting::row_price_expr` over `w.preferred_finish`, the same expression
   * {@link WishRow.unitPrice} is. So a foil wish is compared foil-to-foil and never against a
   * nonfoil rate nobody quoted.
   *
   * `null` is *unpriced there*, and it can only ever appear on {@link WishOptimizeMove.from}:
   * a candidate with no price is not a candidate at all — issue #352's own sentence, "a card
   * without a price should not be considered the cheapest printing" — so `to.price` is always
   * a number.
   */
  price: number | null;
}

/**
 * One row of the preview: a wish, where it is, and where one press would put it.
 *
 * **Only pinned wishes are ever here.** An any-printing wish is already drawn and priced at the
 * cheapest printing of its oracle card by `list_wishes`' join, so there is no saving to find,
 * and pinning it would take away the very flexibility that makes it cheap. It is counted in
 * {@link WishlistOptimizePlan.alreadyCheapest} instead.
 */
export interface WishOptimizeMove {
  wishId: number;
  /** The wish's own name, as the list draws it. */
  name: string;
  quantity: number;
  /** `null` is "the reader has not said", which prices through the `nonfoil → foil → etched`
   *  chain rather than at the nonfoil rate. Never coalesced — see `row_price_expr`. */
  preferredFinish: Finish | null;
  /** Where the wish is filed, so a flattened preview can say which drawer each row is in.
   *  `null` is the root. */
  folderId: number | null;
  from: OptimizePrinting;
  to: OptimizePrinting;
  /**
   * `from.price - to.price`, per copy — and **`null` exactly when `from.price` is**.
   *
   * A wish whose current printing this marketplace does not list is still offered as a move,
   * and counted as no saving: an unlisted printing may be cheap rather than dear, and a figure
   * invented for it would inflate the headline. The preview draws that row `— → $2.00` and
   * leaves it unticked.
   */
  savedPerCopy: number | null;
  /** {@link savedPerCopy} times {@link quantity}, or `null` with it. */
  saved: number | null;
  /**
   * The wish is filed in a deck's **managed wishlist** — the deck's own folder or its Tokens
   * child ([issue #598](https://github.com/Msgaihede/mtg-grimoire/issues/598)). Only ever `true`
   * on a plan asked for with `includeManaged`; `false` on every other.
   *
   * **Informational, never applicable.** The wish is the deck's printing, and repointing it is a
   * hand edit the backend refuses (`managed_wishlist::MANAGED`) — which inside
   * `wishlist_optimize_apply`'s one transaction would roll back every other row with it. So no
   * surface sends one: the reader changes the printing in the deck, and the folder follows.
   */
  managed: boolean;
}

/**
 * What `wishlist_optimize_plan` answers: every improvement available over **the rows the list is
 * currently showing**, and an account of the ones it passed over.
 *
 * **The plan is taken over the whole query, not over the visible page.** It is handed the same
 * {@link WishlistQuery} the list drew — folder, flatten switch and every active card filter —
 * with `limit`/`offset` ignored, so `considered` equals the `total` in the page header and the
 * preview cannot silently leave out a wish on page two.
 *
 * The three counts partition `considered`: `moves.length + alreadyCheapest + skipped`.
 *
 * **It does not echo the marketplace back, deliberately.** Every price here was quoted at the
 * one the query carried, which came from `useMarketplace()`, which is also what the dialog
 * renders with — and the query is in the caller's key, so a switch refetches rather than
 * relabels. A second copy of that fact travelling in the answer is one more thing that can
 * disagree with the hook, which is the rule `packages/ui/CLAUDE.md` states for every price surface.
 */
/**
 * What `wishlist_optimize_plan` is asked: the list's own query, plus whether a deck's **managed
 * wishlist** is in scope ([issue #598](https://github.com/Msgaihede/mtg-grimoire/issues/598)).
 *
 * `includeManaged` is a second command argument on the wire rather than a field of
 * {@link WishlistQuery}, because nothing but the plan reads it: on the list query it would be a
 * field `list_wishes` silently ignores. Absent is `false`, which is the Wishlist page's Optimise
 * button — a sweep that offers only what it can apply. The home page's Wishlist savings widget is
 * the caller that sends `true` (unless its reader switched it off), because a managed wish is
 * still a wish and its saving is still money.
 */
export type OptimizePlanQuery = WishlistQuery & { includeManaged?: boolean };

export interface WishlistOptimizePlan {
  moves: WishOptimizeMove[];
  /** How many wishes the sweep looked at — the list's own `total` for the same query. */
  considered: number;
  /** Already on the cheapest priced printing, plus every any-printing wish, which is cheapest
   *  by construction. */
  alreadyCheapest: number;
  /** Passed over: a wish with no oracle id (nothing to find siblings by), a wish pinned to a
   *  printing `cards` no longer has, and an oracle card **no** printing of which this
   *  marketplace prices at this wish's finish. */
  skipped: number;
}

/**
 * One ticked row on its way to `wishlist_optimize_apply`.
 *
 * **`fromCardId` is a guard, not a description.** Between the preview and the press a sync can
 * land, or another pane can repoint the same wish; applying regardless would move a printing the
 * reader never saw. A wish whose `card_id` no longer matches is left exactly as it is and
 * reported {@link WishOptimizeStatus} `"stale"`.
 */
export interface WishOptimizeApplyItem {
  wishId: number;
  fromCardId: string;
  toCardId: string;
}

/**
 * What became of one ticked row.
 *
 * * `changed` — repointed, the ordinary answer.
 * * `merged` — the cheaper printing collided with a wish already in the same folder at the same
 *   finish, so the two quantities summed into that row and this one was deleted.
 *   {@link ipc.wishlistSetPrinting}'s documented rule rather than a failure, and the saving
 *   still stands.
 * * `stale` — the wish had moved on since the preview; nothing was written.
 * * `missing` — the wish is not on the list any more; nothing was written.
 */
export type WishOptimizeStatus = "changed" | "merged" | "stale" | "missing";

export interface WishOptimizeResult {
  wishId: number;
  status: WishOptimizeStatus;
}

/**
 * The outcome of one press of Apply — **one result per item sent, in the order they were sent**,
 * so the caller can sum the saving over exactly the rows that actually moved rather than over
 * the rows it hoped would.
 */
export interface WishlistOptimizeOutcome {
  results: WishOptimizeResult[];
}

/**
 * One folder of the wishlist's own filing tree — `deck_folders`' shape ported onto
 * `wishlist_folders`, because the tree arithmetic, the cycle refusal and the two cascade rules
 * were already written and tested there and a wishlist folder needs exactly the same three.
 *
 * **Flat rows; the tree is the reader's to build from `parentId`**, {@link DeckFolder}'s rule
 * verbatim — `wishlist_folder_list` takes no argument because a folder belongs to no wish, the
 * way a directory belongs to no file.
 *
 * The two cascades point the same opposite ways {@link DeckFolder}'s do, and the wishlist's
 * are the ones a delete confirmation has to quote: `wishlist_folders.parent_id` is
 * `ON DELETE CASCADE` **on itself**, so deleting a folder takes its sub-folders with it.
 * `wishlist_entries.folder_id` is `ON DELETE SET NULL`, so the wishes inside surface at the
 * root — filed nowhere, otherwise untouched, and in particular **not deleted**. A folder is a
 * filing decision the reader made about a wish, never a second list the wish could be lost
 * inside.
 */
export interface WishlistFolder {
  id: number;
  /** The folder this one sits inside, or `null` for the root of the tree. */
  parentId: number | null;
  name: string;
  sortOrder: number;
  /**
   * The deck this folder is the **managed wishlist** of, or `null` for a folder the reader made
   * (user schema v48, [issue #512](https://github.com/Msgaihede/mtg-grimoire/issues/512)).
   *
   * A managed folder holds exactly what that deck's Compare dialog lists — the theory list less
   * the actual list — and Rust rewrites it after every write that changes the deck. It is the
   * **deck's** rather than the reader's: every write that would file, rename, move, delete or
   * edit a wish in it is refused by the backend, so a surface draws no such control for it.
   * A root folder (`parentId` is `null`) — except its **Tokens** child, below — and never
   * synced: each device derives its own from the deck, which is.
   */
  managedDeckId: number | null;
  /**
   * **The managed wishlist's Tokens subfolder** (user schema v55, managed tokens spec §3.8): the
   * one child a managed folder can have, named `Tokens`, carrying the **same** `managedDeckId` and
   * its parent's id in `parentId`, and holding the token printings that deck's plan is short of.
   * `false` for every other folder — the reader's own and the managed folder itself. What tells
   * one deck's `Tokens` from another's is the parent, never the name, so a list of managed folders
   * by name leaves these out.
   */
  managedTokens: boolean;
  /**
   * `wishlist_folders.sync_uid` — the folder's cross-device name, or `null` where none was minted
   * (a managed folder, derived per device and never synced). On the wire for the share key
   * ([issue #941](https://github.com/Msgaihede/mtg-grimoire/issues/941)): a share names what it
   * publishes by a uid and never by a row id. See `features/wishlist/wishlistShare.ts`.
   */
  syncUid: string | null;
  /**
   * The managed deck's `decks.sync_uid`, or `null` for a folder the reader made. A managed
   * folder's share is named by its deck, which syncs, rather than by its own per-device uid.
   */
  managedDeckUid: string | null;
  /**
   * The folder's **own** rules ({@link FolderRule}), `[]` for none — what a wish filed here is
   * expected to meet, never a bar to filing it. Inherited ones are walked by `lib/folderRules.ts`.
   */
  rules: FolderRule[];
}

/**
 * The counts and subtotal a folder card is drawn from — `wishlist_folder_summary`'s row, one
 * per folder that exists.
 *
 * **Every number here is direct, never recursive: what this folder holds itself, not what it
 * and everything nested inside it hold together.** `wishlist_folder_list` builds the tree from
 * flat rows and sums a node's children on the way up — {@link DeckFolder}'s `FolderNode.count`
 * does the same arithmetic for decks — so a summary that already recursed would be a second,
 * disagreeing implementation of that sum. Read one of these alone and a folder holding two
 * sub-folders of six wishes each and none of its own reads as **empty**; that is correct for
 * this row and wrong for a folder card, which has to add its children in before it draws.
 */
export interface WishlistFolderSummary {
  folderId: number;
  /** Wishes filed **directly** in this folder — not its sub-folders' wishes. */
  wishes: number;
  /** Copies wanted here — `sum(quantity)` over the wishes filed directly in this folder.
   *
   *  It was `sum(max(0, quantity - owned))` and was called `missing` until 2026-09-08. The
   *  wishlist compares itself to the collection nowhere now, so there is no such thing as a copy
   *  a wish no longer needs: what a drawer wants is what its wishes say they want. */
  copies: number;
  /** What those copies cost at the summary's own marketplace — the same `price_expr` the page
   *  header prices its own total from, so a folder's figure and the root's can never disagree
   *  about what one copy costs. Unpriced rows are left out of the sum entirely, never quoted at
   *  another marketplace's rate. */
  cost: number;
  /** How many of this folder's own wishes the marketplace could not price — the folder card's
   *  own version of the page header's unpriced note, so a dashed card whose total looks low
   *  can say why. */
  unpriced: number;
}

/** The wishlist commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const wishlistCommands = {
  wishlistAdd: (wish: WishInput) => invoke<EntryChange>("wishlist_add", { wish }),
  /** An absolute quantity — and `0` *removes* the row, because a wish holds nothing worth
   *  keeping once it is emptied. This was the opposite of the collection's rule until schema
   *  v24, when the collection joined it for a different reason: a wish has no acquisition story
   *  to lose, while a collection row does and loses it anyway. Same answer, two arguments. */
  wishlistSetQuantity: (id: number, quantity: number) =>
    invoke<EntryChange>("wishlist_set_quantity", { id, quantity }),
  wishlistRemove: (id: number) => invoke<EntryChange>("wishlist_remove", { id }),
  wishlistList: (query: WishlistQuery) => invoke<WishlistPage>("wishlist_list", { query }),
  /** {@link collectionShelfCounts} one table over: a tile is a wish, and summed over every shelf
   *  the counts are the wishlist header's Total cost. */
  wishlistShelfCounts: (query: WishlistQuery) =>
    invoke<ShelfCount[]>("wishlist_shelf_counts", { query }),
  /**
   * The whole wishlist as one aggregate — see {@link WishlistSummary}, where the reason it is not
   * a folder subtotal is written out.
   *
   * **The whole list, and no query**, {@link ipc.collectionBreakdown}'s rule: this is the home
   * page's figure rather than the wall's, and the `marketplace` decides every number in it.
   */
  wishlistSummary: (marketplace: MarketplaceId) =>
    invoke<WishlistSummary>("wishlist_summary", { marketplace }),
  /** The wishlist sliced along one dimension — {@link ipc.collectionBreakdown}'s contract
   *  verbatim, one cabinet over, and the same {@link BreakdownRow} back. The `finish` dimension
   *  groups on `preferred_finish`, where an any-printing wish lands in a bucket keyed `"any"`. */
  wishlistBreakdown: (dimension: string, marketplace: MarketplaceId) =>
    invoke<BreakdownRow[]>("wishlist_breakdown", { dimension, marketplace }),
  /**
   * One transaction for a whole imported file — {@link ipc.collectionImportCommit}'s rule. The
   * `set` arm reaches its row through `add_wish` first and corrects the quantity after, so a
   * `set` of 0 **deletes** the wish rather than leaving an empty one.
   */
  wishlistImportCommit: (items: WishlistImportItem[], mode: TransferImportMode) =>
    invoke<ImportCommitOutcome>("wishlist_import_commit", { items, mode }),
  /** Every folder there is, flat — {@link ipc.deckFolderList}'s rule verbatim, ported: the
   *  tree is the reader's to build from `parentId`, and no wish id scopes it because a folder
   *  belongs to no wish. */
  wishlistFolderList: () => invoke<WishlistFolder[]>("wishlist_folder_list"),
  /** A new folder, at the root with `parentId: null` or inside another one. */
  wishlistFolderCreate: (parentId: number | null, name: string) =>
    invoke<WishlistFolder>("wishlist_folder_create", { parentId, name }),
  wishlistFolderRename: (id: number, name: string) =>
    invoke<WishlistFolder>("wishlist_folder_rename", { id, name }),
  /**
   * Re-parent a folder — `parentId: null` moves it back to the root.
   *
   * Refuses a move into itself or into one of its own descendants, {@link ipc.deckFolderMove}'s
   * guard verbatim and for the same reason: `wishlist_folders.parent_id` is `ON DELETE CASCADE`
   * **on itself**, so a cycle is a graph SQLite's recursive cascade would walk forever the day
   * the folder is deleted.
   */
  wishlistFolderMove: (id: number, parentId: number | null) =>
    invoke<WishlistFolder>("wishlist_folder_move", { id, parentId }),
  /**
   * Place a whole level — **{@link ipc.collectionFolderReorder}'s contract verbatim, and read that
   * one before calling this**: `ids` is the *full* new list of `parentId`'s children in order, and
   * one transaction writes both `sort_order` (from position) and `parent_id` (from `parentId`), so
   * a drag that re-parents *and* places is never seen half done. Sending only the folder that
   * moved is the mistake the name invites.
   */
  wishlistFolderReorder: (parentId: number | null, ids: number[]) =>
    invoke<WishlistFolder[]>("wishlist_folder_reorder", { parentId, ids }),
  /**
   * Delete a folder. **Its wishes are not deleted** — `wishlist_entries.folder_id` is
   * `ON DELETE SET NULL`, so they surface at the root, filed nowhere and otherwise exactly as
   * they were. Sub-folders *do* go with it. An id that resolves to nothing is a success.
   */
  wishlistFolderDelete: (id: number) => invoke<void>("wishlist_folder_delete", { id }),
  /**
   * Delete {@link ipc.wishlistFolderDelete}'s whole reach **and the wishes in it** — the folder,
   * every folder inside it, and every wish filed anywhere in that sub-tree. Answers how many
   * wishes went. A folder that is gone is **refused** in words, unlike its sibling's success: the
   * likeliest way it went is the plain delete, which left its wishes at the root.
   */
  wishlistFolderDeleteWithWishes: (id: number) =>
    invoke<number>("wishlist_folder_delete_with_wishes", { id }),
  /**
   * Empty a folder of the wishes filed **directly** in it, and keep the folder. Its sub-folders
   * and every wish in them are untouched — this is the level the reader is looking at, not the
   * tree under it. Answers how many wishes went; a folder that is gone is refused in words.
   */
  wishlistFolderClear: (id: number) => invoke<number>("wishlist_folder_clear", { id }),
  /**
   * Move a wish to a folder — `folderId: null` is the root wishlist, a real destination and
   * not an omission.
   *
   * **Merges rather than fails on a collision.** Moving a wish into a folder that already
   * holds a wish for the same `(oracleId, cardId, preferredFinish)` would otherwise violate the
   * storage grain {@link WishInput.folderId} put `folderId` into; instead the two quantities
   * are summed into the destination row, the source row is deleted, and this answers the
   * **destination's** id and quantity. The alternative — a `UNIQUE constraint failed` reaching
   * the reader — would be the app telling them off for filing a card twice.
   */
  wishlistSetFolder: (id: number, folderId: number | null) =>
    invoke<EntryChange>("wishlist_set_folder", { id, folderId }),
  /**
   * The counts and subtotal every folder card on the wishlist page is drawn from, one
   * {@link WishlistFolderSummary} per folder — **direct per folder, never recursive**; see that
   * interface before drawing anything from this, because a caller that assumes recursion draws
   * a folder card reading `0` over a sub-folder holding twelve.
   *
   * Priced at the named marketplace, off the same `price_expr` the page header's own total
   * comes from, so a folder's figure and the whole list's can never disagree about what one
   * copy costs.
   */
  wishlistFolderSummary: (marketplace: MarketplaceId) =>
    invoke<WishlistFolderSummary[]>("wishlist_folder_summary", { marketplace }),
  /**
   * Replace a wishlist folder's own rules ({@link WishlistFolder.rules}) with `rules`, whole — an
   * empty list clears them. Answers the folder re-read, rules tidied; a list the backend cannot
   * accept is refused in one sentence.
   */
  wishlistFolderSetRules: (id: number, rules: FolderRule[]) =>
    invoke<WishlistFolder>("wishlist_folder_set_rules", { id, rules }),
  /**
   * Which wishes break their folder's effective rules, priced at `marketplace` — {@link
   * RuleConflicts}, counted per folder. An any-printing wish breaks a card-level rule only when no
   * printing of its card satisfies them all.
   */
  wishlistRuleConflicts: (marketplace: MarketplaceId) =>
    invoke<RuleConflicts>("wishlist_rule_conflicts", { marketplace }),
  /**
   * Change which printing a wish is for — the write `wishlist_entries.card_id` has never had
   * before, on a column that has always meant "any printing" when `null`.
   *
   * `cardId` pins the wish to that printing and refreshes its denormalised set, collector
   * number and language from the card database; an id the card database does not have is
   * refused, {@link ipc.wishlistAdd}'s words. `cardId: null` is the way back to **any
   * printing** — set, collector number and language all clear with it — and is refused when the
   * wish has no `oracleId` either, because a wish naming neither would be a shopping list item
   * that cannot say what it is shopping for.
   *
   * **Merges rather than fails on a collision**, {@link ipc.wishlistSetFolder}'s rule verbatim:
   * repointing a wish onto a printing (or onto "any printing") that collides with a wish
   * already sitting in the same folder sums the two into one row rather than raising a unique
   * constraint. Clears `needsReview`, because choosing the printing by hand *is* the review a
   * flagged wish was waiting for.
   */
  wishlistSetPrinting: (id: number, cardId: string | null) =>
    invoke<EntryChange>("wishlist_set_printing", { id, cardId }),
  /**
   * What re-pricing the list on screen would change, and **nothing is written** — issue #352's
   * "preview you can verify before committing", which is the whole reason this is two commands
   * and not one.
   *
   * Takes the query the list is currently drawn from, so the folder, the flatten switch and
   * every active card filter scope the sweep; `limit` and `offset` are ignored, because a
   * preview that stopped at the end of page one would quietly leave wishes un-optimised.
   *
   * The **`marketplace` on the query decides every figure in the answer**, so it belongs in the
   * caller's query key like every other priced read — see {@link WishlistOptimizePlan}.
   *
   * `includeManaged` travels as its own argument — {@link OptimizePlanQuery} has why — and puts
   * the decks' managed wishlists in scope, each of their moves marked `managed`.
   */
  wishlistOptimizePlan: ({ includeManaged = false, ...query }: OptimizePlanQuery) =>
    invoke<WishlistOptimizePlan>("wishlist_optimize_plan", { query, includeManaged }),
  /**
   * Commit the ticked rows of a plan — **one transaction**, {@link ipc.wishlistImportCommit}'s
   * rule: a sweep seen half done is a shopping list nobody can reason about.
   *
   * Each item names the printing it is coming *from* as well as the one it is going to, and a
   * wish that has moved since the preview is skipped rather than repointed. Every item gets a
   * {@link WishOptimizeResult}, in order.
   */
  wishlistOptimizeApply: (items: WishOptimizeApplyItem[]) =>
    invoke<WishlistOptimizeOutcome>("wishlist_optimize_apply", { items }),
};
