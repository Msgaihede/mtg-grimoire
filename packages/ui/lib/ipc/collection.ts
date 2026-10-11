/**
 * The collection: entries and their patches, the list and its summary, imports into it, the bulk outcomes, shelf counts and folds, and its folders.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `collectionCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import type { Condition } from "../conditions";
import type { Finish } from "../finish";
import type { MarketplaceId } from "../marketplace";
import type { SortSpec } from "../sort";
import type { CardFilters, CollectionSortKey } from "./cards";
import type { DeckPile, MoveOutcome } from "./decks";
import { invoke } from "./invoke";

/**
 * One quick-add, as the popup sends it.
 *
 * `lang`, `setCode` and `collectorNumber` are deliberately absent: they are properties of
 * the printing, read from `cards` at write time, and letting a caller supply them would let
 * a caller disagree with the card it named.
 *
 * Every field is `#[serde(default)]` on the Rust side, but the three that identify what is
 * being added stay required here — an add with no card, no finish or no quantity is a write
 * the backend refuses in words, and it should not compile.
 */
export interface EntryInput {
  cardId: string;
  finish: Finish;
  /** Copies to add. Never `0`: adding nothing would conjure a row out of a card the user
   *  never said they had. Zero is a state a row is *moved* to, by `collectionSetQuantity`. */
  quantity: number;
  /**
   * Where a menu add files it. Absent — and `null` — is the root of the collection: nothing has
   * to be filed for the collection to work, and this is the field that keeps that true for a
   * reader who has never made a folder.
   *
   * It is part of the row's **storage grain** ({@link CollectionRow.folderId}), exactly the way
   * {@link WishInput.folderId} is one table over: adding the same printing to two folders is two
   * rows, never one row that moves. Moving one is {@link ipc.collectionSetFolder} and only that.
   */
  folderId?: number | null;
  /** Defaults to `NONE` — *not set*. An add that names no grade records that nobody
   *  named one, which is a fact; `NM` would be a guess dressed as one. */
  condition?: Condition;
  /** What the user's file called that condition, kept because the normalisation is lossy. */
  conditionOriginal?: string;
  tradelistQuantity?: number;
  purchasePrice?: number;
  purchaseCurrency?: string;
  acquiredAt?: string;
  acquisitionSource?: string;
  serialNumber?: string;
  altered?: boolean;
  signed?: boolean;
  proxy?: boolean;
  misprint?: boolean;
  /** `{"company":"PSA","grade":"10","cert":"12345678"}` as JSON text. The backend parses and
   *  re-serialises it into canonical key order — two spellings of one slab would otherwise
   *  be two rows at the storage grain. An unknown key is refused, not dropped. */
  grading?: string;
  /** A JSON array of strings. */
  tags?: string;
  notes?: string;
}

/**
 * An edit to one existing row. Every field is optional: absent means "leave it".
 *
 * Absent and blank are *not* the same for most fields — but they are for
 * {@link EntryPatch.grading}, whose empty string reads as "no slab" and is therefore a
 * silent no-op rather than a clear. An entry editor that offers to remove a grading has
 * nothing here to do it with.
 */
export interface EntryPatch {
  finish?: Finish;
  condition?: Condition;
  /** Editable, because correcting a grade without correcting the record of what the file
   *  said would leave the row disagreeing with its own provenance. */
  conditionOriginal?: string;
  quantity?: number;
  tradelistQuantity?: number;
  purchasePrice?: number;
  purchaseCurrency?: string;
  acquiredAt?: string;
  acquisitionSource?: string;
  serialNumber?: string;
  altered?: boolean;
  signed?: boolean;
  proxy?: boolean;
  misprint?: boolean;
  grading?: string;
  tags?: string;
  notes?: string;
}

/**
 * What a write did.
 *
 * `removed` is the difference between "you now have zero" and "that row is gone", which the
 * list has to know to drop it. **Both tables now answer it the same way on the same input**:
 * `collectionSetQuantity(id, 0)` and `wishlistSetQuantity(id, 0)` each delete and each report
 * `removed: true`. The wishlist has always been that way — a wish for none of something is not
 * a wish — and the collection joined it at schema v24, because with the folder in the grain a
 * row holding no copies cannot be told from a row somebody filed and emptied. `collectionUpdate`
 * is the one write left that answers `removed: false` at a quantity of zero, and deliberately:
 * an edit form sends eight fields at once and must not delete the row being edited.
 */
export interface EntryChange {
  id: number;
  quantity: number;
  removed: boolean;
}

/**
 * What a bulk import writes into the collection or the wishlist. `add` folds onto the grain like
 * a quick-add repeated per line; `set` writes each line's number as the truth rather than adding
 * to what is already there. There is deliberately no `replace`: the deck's `replace` clears one
 * variant of one deck, and the same word over a collection would empty a 3,000-card record from
 * a 40-line paste with the file that caused it looking completely ordinary. An unknown mode is
 * refused by the backend rather than defaulted.
 */
export type TransferImportMode = "add" | "set";

/**
 * One line of a bulk import, after this side has decided everything a *collection* decision is.
 *
 * `condition` is `undefined` rather than defaulted here: an absent one means the file said
 * nothing, and the **dialog** is where the reader chose what that becomes. Defaulting it in two
 * places is how the preview and the write come to disagree.
 */
export interface CollectionImportItem {
  cardId: string;
  quantity: number;
  finish: Finish;
  condition?: Condition;
  conditionOriginal?: string;
  /**
   * The six grain columns beyond the printing, its finish and its grade —
   * {@link EntryInput}'s spelling and its optionality, deliberately, because they say the same
   * thing about the same row and a line of a file must be able to state everything a quick-add
   * can.
   *
   * **They are here because the fold *is* the grain, and it was not.** A planner folding its
   * lines on `(cardId, finish, condition)` while `idx_collection_grain` is eleven columns wide is
   * wrong in two directions at once: two lines differing only in `signed` collapse into one
   * before the write ever sees them, and — because `commit_import` had nothing to read for these
   * six and hard-coded the defaults — a re-import could never land on a reader's altered or
   * graded row. It wrote a second all-defaults entry beside it instead of adding to it, which is
   * the half that costs the reader something: the copy they described is still there, and now it
   * has an anonymous twin.
   *
   * **Absent is not `false` reaching the wire.** It means the file carried no such column, which
   * the backend reads as the plain unmarked copy. That is why the four flags are optional rather
   * than required: almost every import is a text file with three columns in it, and requiring
   * them would make every caller write four `false`s in order to say nothing.
   */
  altered?: boolean;
  signed?: boolean;
  proxy?: boolean;
  misprint?: boolean;
  serialNumber?: string;
  /** `{"company":"PSA","grade":"10","cert":"12345678"}` as JSON text — {@link EntryInput.grading}
   *  verbatim, including that the backend re-serialises it into canonical key order and
   *  **refuses** an unknown key rather than dropping it. Two spellings of one slab would
   *  otherwise be two rows at the storage grain, which is the whole reason this field belongs in
   *  the fold above. */
  grading?: string;
  purchasePrice?: number;
  purchaseCurrency?: string;
  acquiredAt?: string;
  acquisitionSource?: string;
  notes?: string;
  /**
   * How many of these copies the reader offers for trade — the export's `Tradelist quantity`
   * column read back (issue #555). Absent is "the file said nothing", which an `add` leaves the
   * row's own number alone for and a `set` leaves alone too; the backend clamps it to the row's
   * quantity either way, because a tradelist bigger than the pile it is drawn from is not a
   * promise anyone can keep.
   */
  tradelistQuantity?: number;
  /**
   * `collection_entries.tags` as the column holds it — a JSON array of strings, `["cube"]`
   * (issue #555). The planner turns whatever the file said (this app's own JSON cell, or a
   * comma-separated `cube, trade` from another app) into that one spelling. Absent is silence:
   * an `add` onto an existing row **unions** the file's tags into the row's, a `set` **replaces**
   * them, and neither touches a row's tags when the item carries none.
   */
  tags?: string;
}

/**
 * What a bulk import did.
 *
 * **`removed` is populated by both commands since schema v24.** It was the wishlist's alone while
 * a `set` of 0 left a zero-quantity collection row standing; the collection now deletes that row
 * too, inside the same transaction, and counts it here. One shape still covers both commands, and
 * `0` rather than absent still means "nothing was removed" rather than "this command cannot say".
 *
 * A caller that treats a non-zero `removed` as proof the file was a wishlist import is reading the
 * old rule. What the number costs is the same on both tables and is worth stating: the deleted
 * collection row takes its `condition`, `conditionOriginal`, purchase price and currency,
 * acquired-at, acquisition source, notes and tags with it — the acquisition story the old
 * zero-keeps behaviour existed to preserve.
 *
 * One line can also count in **two** of these at once: a `set` of 0 for a printing the reader does
 * not own inserts the row and then deletes it, so it reads one `added` and one `removed`. Both
 * numbers describe statements that really ran — and because that one item is then subtracted
 * twice, `updated` is **clamped at zero** by both commands rather than allowed to go negative. No
 * field here is ever below zero, so a caller may sum or compare them without a guard.
 */
export interface ImportCommitOutcome {
  added: number;
  updated: number;
  /** Rows deleted: every wish `set` to 0, and — since schema v24 — every collection row `set` to
   *  0 as well, with everything recorded on it. */
  removed: number;
  /** The net change in copies the write made (or, from {@link ipc.collectionImportPreview},
   *  would make) — negative when a `set` file lowers more than it raises. */
  copies: number;
  /**
   * **Collection `set` at the root only**; `0` everywhere else. Copies of a line's exact grain
   * that are filed in folders, beyond what the file's number accounts for — left where they are,
   * because a file says nothing about a reader's filing (issue #555).
   *
   * `set` counts the copies filed elsewhere toward the file's number and adjusts the **root**
   * row by the difference, rather than writing the number into a second root row beside them —
   * which is what doubled a reader's filed copies before. When the folders alone already hold
   * more than the file says, the root goes to zero and the surplus is this number.
   */
  leftInFolders: number;
  /** The ticket {@link ipc.bulkUndo} takes back, or `null` when nothing changed (and always from
   *  {@link ipc.collectionImportPreview}, which changes nothing). Held in the backend's memory
   *  for the session, so it does not survive a restart. */
  undoId: number | null;
}

/**
 * The text of a picked decklist and how its bytes were read (issue #555).
 *
 * `windows-1252` is the fallback for a file that is not valid UTF-8 — Excel's "CSV" on a Western
 * European Windows — and it is the one the import dialog says out loud, because a file in some
 * *other* legacy code page reads as mojibake under it and the reader is the only one who can
 * tell. The two UTF-16 spellings are what a byte-order mark named, and are lossless.
 */
export interface ImportFile {
  text: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";
}

/** What `Remove from collection` over several entries did — one transaction (issue #555). */
export interface BulkRemoveOutcome {
  /** Entries deleted. An id that named nothing is skipped, `collection_remove`'s own rule. */
  removed: number;
  /** Copies those entries held. */
  copies: number;
  /** See {@link ImportCommitOutcome.undoId}. */
  undoId: number | null;
}

/** What `Move to` over several entries did — one transaction (issue #555). */
export interface BulkMoveOutcome {
  /** One per id, in the order they were sent — each {@link EntryChange} says where that entry's
   *  copies ended up, which after a merge is a different row's id. */
  changes: EntryChange[];
  /** See {@link ImportCommitOutcome.undoId}. */
  undoId: number | null;
}

/** What {@link ipc.bulkUndo} put back. */
export interface BulkUndoOutcome {
  /** Which list the ticket was about, so the caller knows which roots to refetch. */
  scope: "collection" | "wishlist";
  /** Rows written back — restored, re-inserted or deleted again. */
  restored: number;
}

/** A collection list, as the UI asks for it. */
export interface CollectionQuery extends CardFilters {
  /**
   * Ignored, and present only because the shared filter struct carries it: the collection
   * forces it off. The user owns what the user owns, and a paper test over a printing that
   * has left `cards` would throw away exactly the rows this list exists to keep showing.
   */
  paperOnly?: boolean;
  finishes?: Finish[];
  conditions?: Condition[];
  /** `true` narrows to the rows a Scryfall migration or a vanished printing flagged, `false`
   *  to those it did not touch — the complement is where a reader goes once the flagged ones
   *  are dealt with, so it is a real filter and reaches the wire as `false` rather than being
   *  dropped the way a blank string is. Absent asks nothing. */
  needsReview?: boolean;
  /**
   * Which folder the list is being read at. Absent — and `null`, which deserializes to the same
   * `Option::None` — asks nothing about filing; {@link rootOnly} is what narrows to the root.
   *
   * Three states between the two fields, and this one wins wherever it names a folder:
   * - `folderId: n` — that folder's **direct** members. Never what is filed in the folders
   *   inside it, which is `collection_folders::folder_summary`'s rule. A `rootOnly` riding
   *   along beside it is ignored rather than intersected, so a stale flag cannot empty the
   *   drawer the reader opened.
   * - `folderId` absent, `rootOnly: true` — `folder_id IS NULL`, the rows filed nowhere and
   *   only those.
   * - `folderId` absent, `rootOnly` absent or `false` — **every folder there is**, which is
   *   what this query has always answered and what every caller written before folders existed
   *   still asks by saying nothing: the plain-text mirror, the export sweep's "everything" arm,
   *   the deck builder's collection panel and the importer's preview.
   *
   * **The same three states {@link WishlistQuery.flatten} carries, with the polarity reversed**,
   * and the reversal is history rather than taste: there `null` is the root and `flatten` widens,
   * because that query navigated into a folder from the start. Here the widest answer is what an
   * absent field has always meant, so it is the *narrowing* that needed a second field — an
   * unasked question keeps today's answer, and a caller nobody updated cannot silently lose rows.
   */
  folderId?: number | null;
  /**
   * `true` narrows an absent {@link folderId} to the root — the rows nobody has filed — where
   * absent otherwise means every folder. Default `false`; ignored entirely when `folderId`
   * names a folder.
   *
   * It exists for {@link WishlistQuery.flatten}'s reason read from the other end. A nullable
   * `folderId` cannot carry three states on its own, and the value that would have to mean
   * "the root and nothing else" is already spent: `null` and an omission are one
   * `Option::None` on the wire. So the third state is a field rather than a sentinel — and it
   * is the *narrow* one here because the wide one is what every existing caller already gets.
   */
  rootOnly?: boolean;
  /**
   * **The shelves to answer, in the order to answer them** — folder ids, `0` for Not sorted (the
   * rows filed nowhere). A Shelves wall sends the ids it draws expanded, depth-first, for the list,
   * and every shelf at and below its level for {@link ipc.collectionShelfCounts} and
   * {@link ipc.collectionSummary}; `@/lib/shelves` builds both lists.
   *
   * **Sent, it replaces {@link folderId}, {@link rootOnly} and {@link excludeLocked}** — none of
   * the three is read. Rows come back in list position, then {@link sort}, then id; `limit`,
   * `offset` and `total` are unchanged. An id no folder answers to matches nothing and refuses
   * nothing. **Absent is today's answer**, which the mirror, the export sweep and the importer all
   * still ask by saying nothing.
   */
  shelves?: number[];
  /**
   * `true` drops the copies filed in a **locked** folder — a drawer the reader set aside
   * ({@link CollectionFolder.locked}) — and in every folder underneath one, since the lock
   * inherits down the tree. Default `false`; **ignored entirely when {@link folderId} names a
   * folder**, which is what makes "except inside the folder" true: standing in a locked drawer,
   * or in a sub-folder of one, names it, and a named folder is served whole.
   *
   * The default is {@link rootOnly}'s argument verbatim, and here it is the whole of the field's
   * safety rather than a convenience. **The callers whose silence must go on meaning
   * "everything" are the plain-text mirror and the export sweep**, both of which page through
   * this query for a whole-collection backup — `mirror/read.rs` already says in words that such
   * a read is the one that must never ask the narrowing question. A backup or a CSV that
   * silently omitted the reader's locked cards, raising nothing, is the worst failure available
   * in this feature, and an unasked question keeping today's answer is what forecloses it.
   *
   * Who sends it: the collection page, and the deck builder's Collection Search tab — that tab
   * asks "what can I build with today", which is exactly the question a set-aside drawer is not
   * part of. Who does not, and must not: the mirror, the export sweep and the importer's
   * preview.
   */
  excludeLocked?: boolean;
  /**
   * Whether copies a deck has taken off the desk are part of the answer.
   *
   * `"all"` — the default, and what every caller written before folders existed sends by
   * omission — is every row. `"unallocated"` drops the rows filed in a **`deck`** folder and
   * nothing else: the root, a folder the reader made and `Recently removed` are all cards on
   * their desk, and only a copy a deck is holding is spoken for.
   *
   * **The deck builder's Collection Search tab is the one sender** (2026-08-23), and it sends
   * the field on *every* request including `"all"` — the two words are the two ends of a control
   * the reader can see, so the payload says which end it is at rather than leaning on the
   * backend's default for one of them. Every other caller of `collection_list` still omits it and
   * still gets every row. The two spellings are `collection::Allocation`'s under
   * `rename_all = "camelCase"`; `packages/ui/lib/ipc.test.ts` pins them, because a third word here is a
   * serde error at runtime and a type error nowhere.
   */
  allocation?: "all" | "unallocated";
  /**
   * The band one **copy** has to cost, at {@link marketplace} — the deck builder's Collection
   * Search tab is the one sender (2026-08-25).
   *
   * **The entry's own per-finish price, which is not {@link SearchRequest.priceMin}'s
   * expression.** This is what the row already reports as {@link CollectionRow.unitPrice} and
   * what the `price` sort orders by, so a copy inside the band is a copy the wall prices inside
   * it; the search filters by the printing's `usd → usd_foil → usd_etched` fallback chain
   * instead, which prices a plain copy at its foil's rate whenever that is the only listing.
   *
   * A copy that marketplace has no price for is `NULL` and fails both bounds, so it drops out of
   * a banded list — the same statement the `NULLS LAST` sort and the summary's `unpriced` count
   * make. Two independent bounds: sending only one asks nothing about the other end, and an
   * inverted pair narrows to nothing rather than being reordered.
   */
  priceMin?: number;
  priceMax?: number;
  /** How to order the list, first column deciding. Empty or absent is name order. */
  sort?: SortSpec<CollectionSortKey>;
  /** Which marketplace every price is quoted from, and therefore what the `value` and `price`
   *  orders rank by. Absent means `tcgplayer`; see {@link SearchRequest.marketplace}. */
  marketplace?: MarketplaceId;
  /** Clamped to 500 by the backend; 0 means "use the default page size" (100). */
  limit: number;
  offset: number;
}

/**
 * One row of the collection table: the entry, plus whatever `cards` still knows about the
 * printing it names.
 *
 * Every `cards`-derived field is nullable — a row whose printing has left the database is
 * still a card the user owns. The entry's own columns (`setCode`, `collectorNumber`,
 * `lang`) never are: they were copied onto the row at write time for exactly this case.
 */
export interface CollectionRow {
  id: number;
  cardId: string;
  /**
   * The {@link CollectionFolder} this copy is filed in, or `null` for the root of the collection
   * — `collection_entries.folder_id`, answered on every row rather than made optional, because a
   * copy is always filed *somewhere* and the backend always knows where. {@link WishRow.folderId}
   * one table over, for its reasons.
   *
   * The same printing filed in two folders is **two rows** here with two different values of this
   * field, never one row that moved: `folder_id` is the eleventh term of
   * `schema::COLLECTION_GRAIN`, which is what makes "Add to → \<binder\>" an add and moving
   * between folders an act of its own ({@link ipc.collectionSetFolder}).
   */
  folderId: number | null;
  /**
   * That folder's name, joined on for the reader — `null` at the root, and `null` for a folder
   * that has left the cabinet between the two reads.
   *
   * On the row rather than looked up from {@link ipc.collectionFolderList} because a table cell
   * has to draw it per row: the alternative is every collection surface holding the folder list
   * and building the same map. **It is a display string and never an identity** —
   * {@link folderId} is what a write names, and two sibling folders may share a name.
   */
  folderName: string | null;
  name: string | null;
  /**
   * The oracle card this printing is of — read off `cards.oracle_id`, never denormalised
   * onto the entry.
   *
   * **`null` means exactly one thing: this entry is orphaned.** No live `cards` row is ever
   * null (0 of 116,590), so a healthy entry's card row always answers one — the fact the card
   * menu's "View all printings" reads to tell "this printing has left the card database" from
   * "the reader's copy is fine".
   */
  oracleId: string | null;
  /** From the *entry*, not the card: this is what the user recorded owning. */
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  lang: string;
  rarity: string | null;
  manaCost: string | null;
  typeLine: string | null;
  layout: string | null;
  finish: string;
  /**
   * What state the copy is in — `collection_entries.condition`, straight off the entry, and
   * always one of {@link Condition}.
   *
   * **Not `| null`, because the column is `TEXT NOT NULL DEFAULT 'NONE'`** and no backend write
   * can leave it unset — an absent condition becomes `NONE` before the insert. It carried
   * `| null` for three releases as a fence around the wire, which cost every reader of the row a
   * branch that could not be reached.
   *
   * **A reader who never stated a grade is now represented in the column itself**, as `NONE`,
   * and that is what schema v35 is for. Until then this doc pointed at `conditionOriginal` being
   * `null` as the only record of their silence — which was true, and which meant the silence
   * could not be filtered, sorted or drawn, because it lived in a *provenance* field rather than
   * in the grade. `conditionOriginal` still answers the question it was built for: what the
   * reader's own file said before the normalisation flattened it.
   */
  condition: string;
  quantity: number;
  tradelistQuantity: number;
  /**
   * Per copy, per finish, at the marketplace the query named — never the derived `price_usd`
   * column, which is a fallback chain and would price a plain copy at foil rates.
   *
   * `null` is unpriced *there*, and the holes are not the same at every marketplace:
   * `eur_etched` does not exist in Scryfall's data, so an etched card is unpriced on
   * Cardmarket; a printing a bulk feed has never listed is unpriced on that feed. Neither is
   * ever filled in from another marketplace's number.
   */
  unitPrice: number | null;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
  acquiredAt: string | null;
  acquisitionSource: string | null;
  serialNumber: string | null;
  altered: boolean;
  signed: boolean;
  proxy: boolean;
  misprint: boolean;
  grading: string | null;
  /** A JSON array of strings, never null — the column defaults to `[]`. */
  tags: string;
  notes: string | null;
  /** A sentence when this row needs the user's attention, `null` otherwise. */
  needsReview: string | null;
  /** Unix seconds. */
  updatedAt: number;
  /**
   * JSON: Scryfall's `promo_types` — the column the **kind** of foil lives in, or `null`.
   *
   * `finishes` has three words for how shiny a copy is and no way to say *which* shiny; this
   * is what tells a Surge Foil from a Halo Foil from an ordinary one (issue #160). Read it
   * with `cardTreatments` / `finishTreatments` from `@/lib/treatment`, which owns the naming
   * — Rust hands the column over unread.
   *
   * `null` on four fifths of the corpus and open-ended by construction: 113 distinct members
   * are live and Scryfall adds more without asking, so an unrecognised one is dropped rather
   * than shown raw.
   */
  promoTypes: string | null;
  /**
   * JSON: **this printing's** legality blob, the same shape {@link DeckCard.legalities}
   * carries — 23 keys and growing, so parse it and never index fixed fields.
   *
   * **It rides here for one reader, the Arena export filter** — issue #192,
   * `packages/ui/features/transfer/export/arena.ts`. Nothing the collection screen draws touches it.
   * The blob rather than `cards.legal_mask`, which would have been 8 bytes against this
   * field's 483-byte average (528 at most, over the 116,712-printing corpus of 2026-08-22,
   * where `promoTypes` above averages 23): bit positions are stored data Rust owns and freezes
   * — `crates/grimoire-core/src/legalities.rs` — and a copy of that order over here would be a second
   * place for it to drift. Scryfall's key *names* are public vocabulary and cannot.
   *
   * `null` is an orphan — the printing this entry names has left `cards`.
   */
  legalities: string | null;
}

export interface CollectionPage {
  items: CollectionRow[];
  /** Rows matching the filters, counted in full — a collection is thousands of rows, not
   *  the 116 k the search has to cap. No `totalIsCapped` twin, deliberately. */
  total: number;
}

/** The aggregate header, over the same filters as the list it captions. */
export interface CollectionSummary {
  /** Copies, not rows: a row holding none contributes 0. */
  totalCards: number;
  /** Distinct printings **recorded**, not distinct printings currently held — a row holding no
   *  copies is still on the screen this number captions. */
  uniqueCards: number;
  entries: number;
  tradelistCards: number;
  /** Summed at the marketplace the query named, over the copies it has a price for. */
  value: number;
  /** Copies with no price for their finish **at that marketplace**. Shown beside the value,
   *  because a total that silently omits 400 cards is a number that lies by rounding down —
   *  and the count travels with its own figure, since the two marketplaces do not have the
   *  same holes. */
  unpriced: number;
  needsReview: number;
}

/**
 * One shelf of a Shelves wall, counted — `collection::ShelfCount`, which `wishlist.rs` answers
 * too. One row per **non-empty** shelf in the query's scope, ordered by folder id; a shelf with
 * nothing in scope has no row at all. The four figures honour search and filters; {@link peek}
 * does not.
 */
export interface ShelfCount {
  /** The folder, or `0` for Not sorted. */
  folderId: number;
  /** What the wall draws: on the collection one per printing and finish on this shelf (two grades
   *  of one printing are one tile), on the wishlist one per wish. */
  tiles: number;
  /** `sum(quantity)`. */
  copies: number;
  /** Priced at the query's marketplace; `null` when it prices nothing on the shelf — an em dash,
   *  never `0.00`. */
  value: number | null;
  /** What the marketplace could not price, in the heading's own unit: on the collection
   *  **copies** (the unit of its "n cards" and of {@link CollectionSummary.unpriced}), on the
   *  wishlist **wishes** (the unit of its "n wishes"). */
  unpriced: number;
  /** Up to four card ids for a **collapsed** heading's thumbnails — the only source, because a
   *  collapsed shelf's cards are never fetched. By card name then id, one id per card, each the
   *  id that card's tile is drawn from (a wish's `artCardId`). **Unfiltered**: a filter opens
   *  every shelf, so a peek is only drawn with none active. */
  peek: string[];
}

/** The two pages that draw shelves — `shelffolds::PAGES`, and the keys of {@link ShelfFolds}. */
export type ShelfFoldPage = "collection" | "wishlist";

/**
 * The shelves the reader folded away from their default, per page: folder id (decimal) →
 * collapsed. **Only overrides** — a shelf with no entry is at its default, which is
 * `@/lib/shelves`' `defaultCollapsed` to say. An id whose folder is gone is answered like any
 * other and matches nothing.
 */
export type ShelfFolds = Record<ShelfFoldPage, Record<string, boolean>>;

/**
 * One bucket of a list, sliced along one dimension — the home page's two value widgets.
 *
 * **One struct for two commands**, and the two are deliberately not one: `collection.rs` owns the
 * Rust definition and `wishlist.rs` imports it, because breaking a collection down by rarity and
 * breaking a shopping list down by rarity are the same question asked of different rows. Which
 * dimension a `key` is a value *of* is the caller's — it is whatever it asked for, and nothing on
 * the row repeats it.
 *
 * **A breakdown sums to the summary above it, by construction.** Both sides group over the same
 * `sorting::price_expr` fragment {@link CollectionSummary} totals, so a slice can never disagree
 * with the figure it is a slice of, and the colour buckets partition rather than overlap — a card
 * with two colours is in `multi` and a card with none is in `c`, so nothing is dropped and nothing
 * is counted twice.
 */
export interface BreakdownRow {
  /** The bucket, as its grouping column spells it: a rarity, a colour bucket (`"multi"` and
   *  `"c"` included), a lowercase set code, or a finish — and for the wishlist's finish
   *  dimension, `"any"` for a wish pinned to none. */
  key: string;
  /** A name to draw where the key is not one — the set name beside the set code. `null` for
   *  every dimension whose key is already the word, which is three of the four. */
  name: string | null;
  /** Copies in the bucket, not rows. */
  cards: number;
  /**
   * Summed at the marketplace the caller named, over the copies it has a price for.
   *
   * **`null` means the marketplace priced nothing in this bucket, and that is not zero** — it is
   * the em dash every priced figure in this file falls back to, and a `?? 0` on this side would
   * turn "we do not know" into "worth nothing" on a bucket of forty cards. Zero is a real answer
   * beside it and means the feed priced these cards *at* nothing.
   */
  value: number | null;
}

/**
 * One folder of the **collection's** own filing cabinet — `collection_folders`, schema v24, and
 * the third table to answer {@link DeckFolder}'s flat-rows-with-a-parent-id shape.
 *
 * **Flat rows; the tree is the reader's to build from `parentId`**, and `collection_folder_list`
 * takes no argument because a folder belongs to no card: it files them. `null` **is** the root,
 * so a reader who has never made a folder sees the collection they saw before the upgrade.
 *
 * # The one field the other two cabinets do not have
 *
 * **A folder here can belong to the app rather than to the reader**, which is what {@link kind}
 * says. Only a `user` folder is the reader's to rename, move, delete or file a card into by hand
 * — every write in `collection_folders.rs` refuses the other two in words, `FOLDER_NOT_YOURS` —
 * so a surface offering folders as *destinations* filters on that word rather than listing what
 * it was handed.
 *
 * The two cascades point the same opposite ways the wishlist's do:
 * `collection_folders.parent_id` is `ON DELETE CASCADE` **on itself**, so deleting a folder takes
 * its sub-folders with it, while `collection_entries.folder_id` is `ON DELETE SET NULL` — the
 * cards inside surface at the root, filed nowhere and in particular **not deleted**. A folder is
 * a filing decision the reader made about copies they own, never a second collection a card can
 * be lost inside.
 */
export interface CollectionFolder {
  id: number;
  /** The folder this one sits inside, or `null` for the root of the collection. */
  parentId: number | null;
  name: string;
  /**
   * Who the folder belongs to — one of `schema::COLLECTION_FOLDER_KINDS`.
   *
   * `"user"` is a drawer the reader made and named. `"deck"` is the one folder standing for a
   * deck, and carries {@link deckId}. `"removed"` is the single folder copies go to when they
   * leave the collection without leaving the database. **Nothing creates either of the latter
   * two by hand**, and every folder write refuses to touch one — which is why a picker offers
   * `"user"` and only `"user"`.
   *
   * A plain `string` rather than a union, deliberately: Rust stores the word, a fourth kind is a
   * migration rather than a type error, and a reader that compares and falls through keeps
   * working the day there is one.
   */
  kind: string;
  /** The deck a `"deck"` folder stands for, and `null` on every other kind — the schema CHECKs
   *  that pair, so the two can never be read apart. */
  deckId: number | null;
  sortOrder: number;
  /**
   * A drawer the reader has **set aside** — cards being held for a trade, a display case — so
   * the app stops *offering* what is in it without ever stopping them reaching it.
   *
   * What that split means, concretely: the collection's own lists drop these copies when they
   * ask ({@link CollectionQuery.excludeLocked}) and `owned_spare` stops counting them as
   * something a deck could be built from, while every statement about what the reader *has* is
   * untouched — the owned pip, both owned badges, the Owned/Missing facet, a wish's filled
   * count and the folder's own tile all still see them. Deleting the folder is the one write
   * refused, because it would re-file every card inside it to the root and silently undo the
   * filing the lock was protecting. Moving a card in or out is always allowed.
   *
   * **This is the folder's own flag, not the effective answer — the lock inherits down the
   * tree.** A folder inside a locked folder is locked, computed over ancestry rather than
   * stored twice (two copies of one fact disagree the first time a folder is moved). Ask
   * `lockedFolderIds` in `@/lib/folderTree` for the effective answer; it is the single place
   * that walk is written, and a badge, a greyed menu row or a drag confirmation must never
   * re-derive it from this field alone.
   *
   * **Not the sense `PinnedFolders.tsx` means by *fixed***: those are the app's own folders,
   * with no rename, no delete, no move and no `⋯` at all. A folder locked here is still the
   * reader's own drawer — still renameable, still movable, still a drop target both ways.
   */
  locked: boolean;
  /**
   * The folder's **cross-device** name — `collection_folders.sync_uid`.
   *
   * **On the wire because a share names a folder by it and can name it by nothing else.**
   * {@link ipc.shareCreate} takes a `folderUid` and {@link ShareRow.folderUid} answers one,
   * because a published share is a cross-device artifact: the link outlives the device that made
   * it, another device in the group publishes updates to it, and {@link id} is a rowid that
   * names a row in a database nobody else has ever seen. So a page needs this twice — to say
   * *this drawer* when publishing, and to match a {@link ShareRow} back to a folder for the
   * shared badge.
   *
   * **`null` is possible and means *not shareable yet*, not an error.** The column is nullable;
   * a capture trigger mints a uid on insert and a migration swept the rows that predate it, so
   * in practice every folder has one — but that is a fact about the database rather than about
   * the type, so a surface greys the Share row for a `null` rather than sending it.
   */
  syncUid: string | null;
}

/**
 * The two numbers one collection folder tile draws — `collection_folder_summary`'s row.
 *
 * **Direct per folder, never recursive**, {@link WishlistFolderSummary}'s rule and its warning:
 * a folder holding two sub-folders of six cards each and none of its own reads as **empty**
 * here, which is correct for this row and wrong for a tile. `buildFolderTree` sums a node's
 * children on the way up, and that arithmetic is deliberately not repeated in SQL.
 *
 * **A folder holding nothing produces no row at all**, so a page cannot build its tree from
 * this: {@link ipc.collectionFolderList} is the census and this is a lookup layered onto it.
 */
export interface CollectionFolderSummary {
  folderId: number;
  /** **Copies** filed directly in this folder, not rows — `sum(quantity)`, so a row holding none
   *  contributes nothing. Rare since schema v24, because `collectionSetQuantity` deletes at zero
   *  and only `collectionUpdate` still writes such a row, but summing is the right arithmetic
   *  either way and counting rows would never have been. */
  cards: number;
  /**
   * What those copies are worth at the query's marketplace.
   *
   * **`null` rather than `0` when the marketplace prices nothing in the folder**, which is where
   * this parts company with the page header's `coalesce(…, 0.0)`: a tile is a small number
   * beside a name with no room for the header's "n unpriced" note, so a folder of cards the feed
   * has never heard of would otherwise read as a folder worth nothing. `null` draws an em dash,
   * which is this app's answer for a price it does not have.
   */
  value: number | null;
}

/** The collection commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const collectionCommands = {
  /** Add copies. The same printing, finish and condition twice is one row with a bigger
   *  number — the backend upserts on the grain. */
  collectionAdd: (entry: EntryInput) => invoke<EntryChange>("collection_add", { entry }),
  /** An absolute quantity. `0` **deletes** the row since schema v24 and says so in
   *  `removed: true`. **Name what that costs**, because keeping it was the whole of the old rule:
   *  the row's `condition`, `conditionOriginal`, purchase price and currency, acquired-at,
   *  acquisition source, notes and tags go with it. The folder grain made it unavoidable — a row
   *  holding no copies cannot be told from a row somebody filed and emptied — and
   *  {@link ipc.collectionUpdate} is where a reader who wants that record kept steps the quantity
   *  instead. A second press on the same id is refused as gone, which is the asymmetry with
   *  `collectionRemove`: that one is the unconditional delete and a stale id there is a
   *  success. */
  collectionSetQuantity: (id: number, quantity: number) =>
    invoke<EntryChange>("collection_set_quantity", { id, quantity }),
  collectionUpdate: (id: number, patch: EntryPatch) =>
    invoke<EntryChange>("collection_update", { id, patch }),
  /**
   * Move one row's copies onto another printing of the same card — the one write that reaches
   * `collection_entries.card_id` after the row exists (issue #564). `set_code`,
   * `collector_number` and `lang` follow from `cards`, because they describe the printing.
   *
   * **Merges rather than fails on a collision**, {@link ipc.collectionUpdate}'s rule: a row
   * already holding the new printing at the same finish, condition and folder takes these copies,
   * and the answer's `id` names *that* row — so a caller following the edit reads the id off the
   * answer and never keeps the one it sent. A printing of a different card is refused.
   */
  collectionSetPrinting: (id: number, cardId: string) =>
    invoke<EntryChange>("collection_set_printing", { id, cardId }),
  collectionRemove: (id: number) => invoke<EntryChange>("collection_remove", { id }),
  collectionList: (query: CollectionQuery) => invoke<CollectionPage>("collection_list", { query }),
  /** The aggregate header, over the same filters as the list it captions. */
  collectionSummary: (query: CollectionQuery) =>
    invoke<CollectionSummary>("collection_summary", { query }),
  /**
   * One {@link ShelfCount} per non-empty shelf, over the **same** query the list and the summary
   * take — send `shelves` as every shelf at and below the level, collapsed ones too. `sort`,
   * `limit` and `offset` are read by nothing on the far side.
   */
  collectionShelfCounts: (query: CollectionQuery) =>
    invoke<ShelfCount[]>("collection_shelf_counts", { query }),
  /**
   * The whole collection sliced along one dimension — `rarity`, `color`, `set` or `finish`.
   *
   * **The whole collection, and no query**: this is the home page's figure, not the wall's, so it
   * takes no filters and cannot be narrowed. What it can be is priced, and the `marketplace`
   * decides every `value` in the answer — so it belongs in the caller's query key like every other
   * priced read.
   *
   * `dimension` is a `string` here and **four `match` arms in Rust**, which is the one place the
   * usual split runs the other way: the arms are a fact about which SQL columns exist, not a
   * vocabulary about widgets, so the backend really does own this list and refuses a fifth word in
   * a sentence. `BreakdownDimension` in `packages/ui/features/home/` is the same four words on this side,
   * and a caller should send one of them.
   */
  collectionBreakdown: (dimension: string, marketplace: MarketplaceId) =>
    invoke<BreakdownRow[]>("collection_breakdown", { dimension, marketplace }),
  /**
   * One transaction for a whole imported file, rather than one `collectionAdd` per line — a
   * 500-row CSV would otherwise be 500 transactions, and a failure halfway through would leave
   * a collection nobody can reason about. A refusal rolls the whole file back.
   *
   * **`folderId` files the whole file into one folder, and absent — the default — is the root.**
   * A file says nothing about a reader's filing, so the collection's own import step asks
   * (`Import into`, issue #872): Not sorted sends nothing, and a drawer of the reader's own —
   * or one the step has just made — sends its id. The **deck** arm of the import dialog is the
   * other caller that names a folder: it sends the group of the deck the
   * same press just wrote a list into, so the decklist and the group agree the moment the dialog
   * closes and the copies are out of every other deck's reach. Ticking that box while the copies
   * stopped at the root left the deck reading *missing* on every line the reader had just said
   * they own.
   *
   * `collection::IMPORT_FOLDERS` is the fence: the reader's own folders and a **deck** group.
   * `Recently removed` and an id nothing answers to are refused in words, before anything is
   * written.
   */
  collectionImportCommit: (
    items: CollectionImportItem[],
    mode: TransferImportMode,
    folderId: number | null = null,
  ) => invoke<ImportCommitOutcome>("collection_import_commit", { items, mode, folderId }),
  /**
   * What {@link ipc.collectionImportCommit} **would** do with the same three arguments, without
   * writing anything (issue #555) — the numbers the preview's sentence is built from, so a `set`
   * file stops promising "N cards will be added" over a press that lowers some quantities and
   * leaves others alone. Read-only; `undoId` is always `null`.
   */
  collectionImportPreview: (
    items: CollectionImportItem[],
    mode: TransferImportMode,
    folderId: number | null = null,
  ) => invoke<ImportCommitOutcome>("collection_import_preview", { items, mode, folderId }),
  /**
   * `Remove from collection` over several entries — **one transaction and one activity row**
   * (issue #555), where it used to be one {@link ipc.collectionRemove} per id: N transactions, N
   * feed rows, and a refusal part-way left the press half applied. An id that names nothing is
   * skipped, as `collection_remove` skips it.
   */
  collectionRemoveMany: (ids: readonly number[]) =>
    invoke<BulkRemoveOutcome>("collection_remove_many", { ids }),
  /**
   * `Move to` over several entries — {@link ipc.collectionSetFolder}'s merge rule per entry, in
   * **one transaction with one activity row** (issue #555). Any refusal rolls the whole press
   * back, so a move never lands half-filed.
   */
  collectionSetFolderMany: (ids: readonly number[], folderId: number | null) =>
    invoke<BulkMoveOutcome>("collection_set_folder_many", { ids, folderId }),
  /**
   * Put back what one bulk write did — an import into the collection or the wishlist, a bulk
   * remove, a bulk move (issue #555). The ticket is an outcome's `undoId`, held in the backend's
   * memory for the session. **Refused rather than applied blindly** when a row the write touched
   * has changed since, and refused when the ticket is unknown (a restart, or evicted); either
   * refusal retires the ticket, so a second press answers the same way.
   */
  bulkUndo: (undoId: number) => invoke<BulkUndoOutcome>("bulk_undo", { undoId }),
  /** Every folder there is, flat — {@link ipc.wishlistFolderList}'s rule verbatim, ported: the
   *  tree is the reader's to build from `parentId`, and no card id scopes it because a folder
   *  belongs to no card. **Unfiltered by kind**: a deck's folder and the removed-cards folder
   *  are places cards are, so a page that could not see them would draw a tree the collection
   *  does not have. Offering one as a *destination* is what filters on
   *  {@link CollectionFolder.kind}. */
  collectionFolderList: () => invoke<CollectionFolder[]>("collection_folder_list"),
  /** A new folder, at the root with `parentId: null` or inside another one. Always a `user`
   *  folder — nothing here makes the two the app owns — and a `parentId` naming one of those is
   *  refused in words. */
  collectionFolderCreate: (parentId: number | null, name: string) =>
    invoke<CollectionFolder>("collection_folder_create", { parentId, name }),
  /** Rename a folder the reader made. A deck's folder is named after its deck and the
   *  removed-cards folder after what it is for, so neither is renameable. */
  collectionFolderRename: (id: number, name: string) =>
    invoke<CollectionFolder>("collection_folder_rename", { id, name }),
  /**
   * Re-parent a folder — `parentId: null` moves it back to the root.
   *
   * Refuses a move into itself or into one of its own descendants, {@link ipc.wishlistFolderMove}'s
   * guard and for the same reason: `collection_folders.parent_id` is `ON DELETE CASCADE` **on
   * itself**, so a cycle is a graph SQLite's recursive cascade would walk forever the day the
   * folder is deleted.
   */
  collectionFolderMove: (id: number, parentId: number | null) =>
    invoke<CollectionFolder>("collection_folder_move", { id, parentId }),
  /**
   * Place a whole level. **`ids` is the full new list of `parentId`'s children, in the order they
   * are to sit in** — this is the first of the three folder reorders and the one the other two
   * point at, so the contract is written out once, here.
   *
   * Two things follow from that sentence, and neither is legible from the name:
   *
   * * **It is the order, not a move.** `sort_order` is written from each id's *position*, so the
   *   caller sends every child of that level — {@link ipc.deckCategoryReorder}'s rule, ported.
   *   There is no way to say "put folder 7 third" without also saying what the rest of the level
   *   is, because position is the only thing this command reads.
   * * **`parent_id` is written from `parentId` in the same transaction.** An id in the list that
   *   was living somewhere else is re-parented *and* placed by the one call, which is what a drag
   *   actually is: a folder lifted out of one drawer and dropped third inside another says both
   *   things at once. Spelling it as {@link ipc.collectionFolderMove} followed by a reorder would
   *   be two transactions with a state between them a reader can see — the folder at the end of
   *   its new level, or, if the second call never lands, filed somewhere they did not drop it.
   *
   * Writing `parent_id` is what makes {@link ipc.collectionFolderMove}'s cycle refusal this
   * command's too, and for that comment's reason: `collection_folders.parent_id` is
   * `ON DELETE CASCADE` **on itself**.
   *
   * **Every folder named is fenced to the reader's own, on both sides** — the destination and
   * every id — so a deck's group or `Recently removed` in `ids` is refused in words. This is the
   * one of the three cabinets with that fence, because it is the only one whose folders can
   * belong to the app ({@link CollectionFolder.kind}); `deck_folders` and `wishlist_folders`
   * carry no such column, so their reorders have nothing to refuse.
   *
   * Answers the **whole cabinet**, flat — `collection_folders::reorder_folders` ends in the same
   * `list_folders` {@link ipc.collectionFolderList} calls, not in a read of the level it just
   * wrote. Worth knowing rather than assuming from the argument: a re-parent moves a folder
   * *between* levels, so an answer scoped to `parentId` could not describe the level the folder
   * left. The three hooks still settle by invalidating the folder list rather than seeding the
   * cache from this, which is the shape every other folder write here has.
   */
  collectionFolderReorder: (parentId: number | null, ids: number[]) =>
    invoke<CollectionFolder[]>("collection_folder_reorder", { parentId, ids }),
  /**
   * Delete a folder. **Its cards are not deleted** — they surface at the root, filed nowhere and
   * otherwise exactly as they were, and the backend re-files them by hand before the row goes so
   * two copies of one printing landing at the root merge instead of colliding on the grain.
   * Sub-folders *do* go with it. An id that resolves to nothing is a success.
   *
   * **A locked folder is refused in words** (`collection_folders::FOLDER_IS_LOCKED`), on the
   * **effective** lock — so a sub-folder of a locked one is refused too — and so is a folder with
   * a locked one anywhere beneath it (`FOLDER_HOLDS_LOCKED`), which the same press would re-file.
   * Re-filing a set-aside drawer's cards to the root is exactly the undoing the lock exists to
   * prevent; a caller draws the row greyed with its reason rather than letting the press reach
   * here.
   */
  collectionFolderDelete: (id: number) => invoke<void>("collection_folder_delete", { id }),
  /**
   * Empty `Recently removed` — delete every entry filed in the one removed-cards folder — and
   * answer how many **entries** went (issue #506). The folder stays; nothing else is touched —
   * not the root, not a folder the reader made, not a deck's group, and never a deck's list.
   *
   * **The one folder write that throws cards away**, where {@link ipc.collectionFolderDelete}
   * re-files every card it finds: what sits in the holding area has already left the collection,
   * and this is the reader deciding it is not coming back. No argument, because there is exactly
   * one such folder. A database without one is **refused in words**
   * (`collection_alloc::NO_REMOVED_FOLDER`) rather than answered with a `0` that would claim a pile
   * was emptied. The count is rows, not copies; the feed's line carries the copies.
   */
  collectionRemovedClear: () => invoke<number>("collection_removed_clear"),
  /**
   * Set or clear a folder's own lock — a drawer set aside, {@link CollectionFolder.locked}.
   *
   * `rename_folder`'s shape exactly: one scalar, fenced to the reader's own folders, answering
   * the folder re-read. The app's own two — a deck's group and `Recently removed` — are refused
   * in words, because a group is already fixed and a holding area is not something to set aside.
   *
   * **It writes the folder's own flag and nothing else.** The lock inherits down the tree, so
   * unlocking a folder whose parent is locked changes what this row says and not what the reader
   * sees; that is why a caller greys the row rather than offering a press that reports success
   * over an unmoved badge.
   */
  collectionFolderSetLocked: (id: number, locked: boolean) =>
    invoke<CollectionFolder>("collection_folder_set_locked", { id, locked }),
  /**
   * Move one owned row into a folder — `folderId: null` is the root of the collection, a real
   * destination and not an omission.
   *
   * **A command of its own, because filing is not adding**: `folder_id` is part of the storage
   * grain ({@link CollectionRow.folderId}), so an add can never silently move a row the reader
   * filed last week and moving one has to be something they say out loud.
   *
   * **Merges rather than fails on a collision**, {@link ipc.wishlistSetFolder}'s rule: moving a
   * copy into a folder that already holds the same printing at the same grain sums the two
   * quantities into the destination row, deletes the source, and answers the **destination's**
   * id and quantity — so the `id` that comes back is not always the `id` that went in. Any deck
   * claims on the row that folds move with it.
   *
   * **The destination is fenced**: a `deck` folder and the removed-cards folder are the app's own
   * and are refused in words. Copies reach those through the app's own writes, never by hand.
   */
  collectionSetFolder: (id: number, folderId: number | null) =>
    invoke<EntryChange>("collection_set_folder", { id, folderId }),
  /**
   * The two numbers each collection folder tile is drawn from, one
   * {@link CollectionFolderSummary} per folder that holds at least one card — **direct per
   * folder, never recursive**, and **no row at all for an empty folder**. Read that interface
   * before drawing anything from this.
   *
   * Priced at the named marketplace, off the same `price_expr` the collection header's own total
   * comes from, so a folder's figure and the whole collection's can never disagree about what one
   * copy costs.
   */
  collectionFolderSummary: (marketplace: MarketplaceId) =>
    invoke<CollectionFolderSummary[]>("collection_folder_summary", { marketplace }),
  /**
   * Take `quantity` copies out of a collection row, put them in a deck's group, and write the
   * `deck_cards` row that says the deck plays them — **one transaction**, so mid-move the copies
   * are in both places or in neither.
   *
   * **Its one caller is the deck builder's Collection Search tab**
   * (`features/decks/useCollectionSearch.ts`), which landed on 2026-08-23. This note said
   * "nothing in `packages/ui/` calls this yet" for one PR, while the wrapper existed only so that
   * {@link ipc.deckToCollection} beside it was not a mirror with one half missing.
   *
   * **The copies may be coming out of another deck**, which is the case this command exists to
   * get right: the source row sits in that deck's group, so taking it decrements that deck's
   * *live* list by the same quantity and reports its name in {@link MoveOutcome.fromDeck}. The
   * copies are custody and not a reservation — a deck that loses them loses the card — so a UI
   * confirms that before pressing, because the side effect lands on a deck the reader is not
   * looking at.
   *
   * **The pile is a {@link DeckPile} — an id or a name, never both.** Naming one is what makes
   * an owned add file a card the way every other add does: the backend resolves the word through
   * `category_for_name`, inside the move's own transaction, so a pile it has to invent is marked
   * `origin: "auto"` and goes with its last card. Resolving the name here instead — which is
   * what this had to do while the command took only an id — went through
   * {@link ipc.deckCategoryCreate} and left the reader an empty heading marked as *theirs*,
   * which nothing but a manual delete removes.
   *
   * Refused in words, never as a constraint failure: a quantity below one, more copies than the
   * row holds, a category belonging to another deck, a deck with no group, and copies already in
   * the deck they were pointed at (which would write a second `deck_cards` row against copies
   * the group already holds).
   */
  collectionToDeck: (entryId: number, deckId: number, pile: DeckPile, quantity: number) =>
    invoke<MoveOutcome>("collection_to_deck", {
      entryId,
      deckId,
      // The command's two nullable fields, which is the shape `deckAddCard` sends and the shape
      // an older build's `categoryId`-only payload already fits. Rust refuses both-at-once in
      // words; {@link DeckPile} is what stops a caller here ever producing that call.
      //
      // **The value, never `"id" in pile`.** Both members of the union *declare* `id`, one of
      // them as `?: undefined`, so `{ name: "Ramp", id: undefined }` — legal, and what a caller
      // spreading a partial object produces — satisfies the name member and still answers the
      // presence test true. That sends `categoryId: undefined, categoryName: null`, which
      // deserialises to two `None`s and is refused as `NO_CATEGORY`: a filing by name that
      // reports "a card goes in a pile" instead of going in one.
      categoryId: pile.id !== undefined ? pile.id : null,
      categoryName: pile.id !== undefined ? null : pile.name,
      quantity,
    }),
  /**
   * Cut `quantity` copies from a deck card and file whatever the deck's group holds for that
   * printing into `Recently removed` — the write that makes issue #209's holding area true.
   *
   * **This replaces `deckSetCardQuantity` for a decrease on a `live` list**, rather than
   * accompanying it: it decrements the `deck_cards` row itself, so calling both takes the copies
   * off the list twice. It addresses `deck_cards.id`, which is the one deck command that does —
   * every other one takes the grain.
   *
   * **A theory row is refused** ("A theory list is a plan, and a plan holds no cards."), so the
   * caller must not ask: a plan holds nothing in any folder, and a press that reported success
   * and moved nothing would read as a card that vanished.
   *
   * **A deck card with no backing copies just goes away**, answering
   * {@link MoveOutcome.quantity} `0` and {@link MoveOutcome.entryId} `null`. Read the outcome
   * rather than the argument: what moved is what the reader now has on their desk, and it is
   * less than was asked wherever the list claimed more than the group held.
   */
  deckToCollection: (deckCardId: number, quantity: number) =>
    invoke<MoveOutcome>("deck_to_collection", { deckCardId, quantity }),
};
