/**
 * What a card offers on a right-click, anywhere it is drawn.
 *
 * **A pure builder, and its dependencies are an argument.** Every card surface calls it — the
 * two search views, the two collection views, the wishlist, the four deck editor views, the
 * docked panel, the card pane and the printings list — and each has its own writes, its own
 * marketplace hook instance and its own answer to "am I inside the deck editor". Passing
 * `CardMenuDeps` keeps every one of those decisions at the surface and keeps this file
 * testable without a provider.
 *
 * **Nothing here reaches the backend while the menu is merely open.** "Copy card image" asks
 * `card_image_uri` in its `onSelect`; "Open on" builds a string and calls `openExternal` in
 * its; the deck picker is a `lazy` row whose component mounts on expand. That is a rule, not
 * an optimisation — a menu that fetched on open would fire a request every time a reader
 * right-clicked the wrong tile.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Copy,
  ExternalLink,
  Folder,
  FolderInput,
  Heart,
  Image as ImageIcon,
  Images,
  Inbox,
  Layers,
  LibraryBig,
  Plus,
} from "lucide-react";
import { MenuRows } from "@/components/menu/ContextMenu";
import type { MenuAction, MenuItem } from "@/components/menu/types";
// From `@/lib/folderTree` rather than through `@/features/decks/folders`, which re-exports it:
// this file builds three trees now, and neither the wishlist's cabinet nor the collection's has
// anything to do with the deck gallery's. The arithmetic is one implementation because
// `DeckFolder`, `WishlistFolder` and `CollectionFolder` all answer the same flat shape, and the
// module it lives in is the one that says so.
import { buildFolderTree, type FolderNode } from "@/lib/folderTree";
import { DEFAULT_VARIANT, useDeck } from "@/features/decks/useDeck";
import { useDeckFolders } from "@/features/decks/useDeckFolders";
// The census behind the cabinet's greyed deck rows — see {@link appSection}. A **read**, and the
// one this file makes lazily: `useDecksPlaying` is a backend query, so it lives inside a
// `MenuLazy.Content` and fires on an expand rather than on a right-click.
import { playKey, useDecksPlaying } from "@/features/decks/useDeckPlays";
import { useDecks } from "@/features/decks/useDecks";
import { copyText } from "@/lib/clipboard";
import { marketplaceSearchUrl, openExternal, scryfallCardUrl } from "@/lib/externalLinks";
import { FINISH_LABEL, parseFinishes, type Finish } from "@/lib/finish";
import {
  ipc,
  ipcError,
  type CollectionFolder,
  type DeckFolder,
  type DeckRow,
  type DeckVariant,
  type WishlistFolder,
} from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import type { PaneDeckContext, PrintingsRequest } from "@/lib/store";
import { sortOptions } from "@/lib/options";

/**
 * The card a menu was opened on, as every surface can describe it.
 *
 * **The printings list is the one adapter that reads two objects.** A `Printing` row carries
 * `setCode`, `collectorNumber` and `finishes` but no `name` and no `oracleId` — it is a
 * printing of the card the pane is open on, so both come from that `CardDetail`. Getting that
 * wrong is invisible: the menu still draws, and "Copy card name" copies `undefined`.
 */
export interface CardMenuTarget {
  cardId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  oracleId: string | null;
  /** The printing's finish list as stored JSON. Parse with `parseFinishes` from `@/lib/finish`. */
  finishes: string | null;
  /** Only where the surface names one — a collection row, a wishlist row with a preference. */
  finish?: Finish;
  /**
   * The `collection_entries` row this target **is**, where the surface has one.
   *
   * Set by the collection's **table**, whose row is exactly one entry, and by nothing else — a
   * search tile, a deck card and a printings row are all pieces of cardboard rather than copies
   * the reader owns, and the collection's own *wall* collapses several entries of one printing
   * into one tile, so it names {@link entryIds} instead.
   *
   * **It is half of what "Move to" is fenced on** — this field or {@link entryIds} — and the
   * fence is an absence rather than a greyed row: that item is missing from every card of every
   * surface that owns no collection row at all, so it reads as a property of the surface rather
   * than of the card — the categories menu's argument for leaving Delete off a predefined zone,
   * and the opposite of "View all printings", which is present on every surface and therefore
   * greys.
   */
  entryId?: number;
  /**
   * Every `collection_entries` row this target stands for, when it stands for more than one.
   *
   * A wall **tile** is a printing the page summed several entries into — different finishes,
   * different conditions, different folders, all drawn as one piece of cardboard — so it has no
   * single id to name and sets this instead. A **table row** is exactly one entry and sets
   * {@link entryId}. **Exactly one of the two is ever set**, which is what lets `moveItem` read
   * both without asking which kind of surface it is on.
   *
   * **It is not a weaker `entryId`, and the difference is the whole reason it is a second
   * field.** One id is a move the menu can simply make; several is a question — *which copies?* —
   * that only the reader can answer, and {@link CardMenuDeps.pickCopies} is where it gets asked.
   * Folding both into one array would lose the fact that a single-row surface has nothing to ask.
   */
  entryIds?: readonly number[];
  /**
   * The card's own `type_line` — the **fallback** half of `autoCategoryFor`, exactly as the four
   * drag sources carry it.
   *
   * **Optional in the type and supplied by every surface**, which is not the same thing, and the
   * difference is a rule rather than a nicety. `useDeck.addCard` reads **absent** as "this caller
   * has nothing to say" and files the card under `DEFAULT_CATEGORY_NAME` with **no rule run at
   * all**; `null` is a card whose printing has left `cards`, and it still goes through
   * `autoCategoryFor` — the Land pin first, then the Oracle-tag buckets — reaching
   * `Uncategorized` only when nothing matches. So omitting the key takes the filing rule off a
   * menu add that a drag of the same card would get, and nothing goes red when it happens.
   *
   * The printings list is the case worth naming. A `Printing` row has no type line of its own,
   * because it says what a *printing* is; `printingTarget` supplies the **card's**, off the same
   * `CardDetail` it already takes the name and the oracle id from. That is the stronger answer
   * rather than a workaround — what a card does is a fact about the card, not about the piece of
   * cardboard.
   */
  typeLine?: string | null;
}

/** Everything the card menu needs that is not the card. Built once per surface, not per row. */
export interface CardMenuDeps {
  marketplace: Marketplace;
  /**
   * One copy of this printing, in that finish, filed where the reader pointed — `null` is the
   * root of the collection.
   *
   * **The destination is an argument rather than a default**, {@link addToWishlist}'s rule and
   * the same grain argument one table over: `folder_id` is the eleventh term of
   * `COLLECTION_GRAIN`, so the same printing added to two folders is two rows and a folder the
   * caller failed to pass writes a **second row at the root** rather than filing anything.
   */
  addToCollection: (target: CardMenuTarget, finish: Finish, folderId: number | null) => void;
  /**
   * Move a copy the reader already owns into a folder — `null` is the root of the collection,
   * a real destination and not an omission.
   *
   * **Optional, because it is the one write here that needs a row rather than a card.** Only a
   * surface that can name a `collection_entries` id ({@link CardMenuTarget.entryId}) can offer
   * it, so a surface with no rows leaves both out and the item is simply not built.
   *
   * The backend **merges** rather than refusing when the destination already holds the same
   * printing at the same grain, so the id it answers is not always the id it was given — which
   * is why nothing here holds on to one.
   */
  moveToFolder?: (entryId: number, folderId: number | null) => void;
  /**
   * Aim a card at a **deck's** group — the one destination in the collection's cabinet that is
   * not a folder write.
   *
   * `collection_folders::set_entry_folder` refuses a `deck` folder outright (`FOLDER_NOT_YOURS`),
   * and the refusal is the point rather than an obstacle: a deck group means *this deck holds
   * these copies*, so filing into one by hand would assert that without writing the `deck_cards`
   * row, and the deck would go on listing a card whose copies have walked off. So the row routes
   * to the deck's own add — this is `useAddCardToDeck`'s callback, and
   * {@link buildCollectionTargetItems} sends the row to it instead of to `choose`.
   *
   * **The add writes the `deck_cards` row and no copies, which is the half worth stating.** A
   * sentence here claimed it "does both halves in one transaction" until 2026-09-03; it does not.
   * `deck_add_card` touches `deck_cards` and nothing else (`useDeck.ts`'s `addCard`), and the
   * command that moves custody is `collection_alloc::collection_to_deck`, which the Collection
   * Search tab presses and this row does not. What a press records is an intention — and issue
   * #358 is what keeps that honest: {@link appSection} greys a deck whose live list does not
   * already play the card, so this callback is only ever reached for a deck that plays it.
   *
   * **Optional, and absent is the ordinary answer for a surface with no `CardToDeckProvider`
   * above it** — see {@link useOptionalAddCardToDeck}. Absent means the `Decks` rows are not
   * offered, the same absence `moveToFolder` and `collectionFolders` already express.
   */
  toDeck?: (target: CardMenuTarget, deckId: number) => void;
  /**
   * Ask which copies, then file the ones the reader chose.
   *
   * **Given by a surface whose targets can stand for several entries** — the collection's wall,
   * whose tile is a printing the page summed rows into ({@link CardMenuTarget.entryIds}). A
   * surface whose targets are single rows leaves it out and {@link moveToFolder} is called
   * directly, exactly as it always was.
   *
   * **Why the plural does not simply loop.** One tile can be a nonfoil playset, a foil, and a
   * graded copy in three different drawers; moving all of them because the reader pointed at the
   * card would file copies they never meant to touch, and the collection is the one record they
   * cannot check against anything. Two entries is a *question*, and this dep is where it gets
   * asked. It is optional rather than required so that the fallback below stays reachable: a
   * surface that has not wired the dialog loops {@link moveToFolder}, which is what a multi-picked
   * set has always done and is not a regression to introduce here.
   */
  pickCopies?: (entryIds: readonly number[], folderId: number | null) => void;
  /**
   * The collection's filing cabinet, flat, as the host page already holds it.
   *
   * **A value and not a query**, {@link wishlistFolders}' shape and for its reason: every host
   * subscribes once through `useCardMenuDeps`, so the rows are in hand before a reader
   * right-clicks anything and both folder rows stay plain `submenu`s rather than `lazy` ones.
   *
   * **Handed over whole and filtered here**, which is deliberate: this list carries the folders
   * the *app* owns as well as the reader's — the one standing for a deck, and `Recently removed`
   * — because a page has to draw them. Neither is ever offered as a **destination**: copies reach
   * those through the app's own writes, and the backend refuses a hand-filing into one in words.
   * `buildCollectionTargetItems` is where that filter lives, so a second caller cannot forget it.
   *
   * Optional, and empty is the ordinary answer — a collection that files nothing, and a hook
   * whose first read has not landed, are the same array here. Neither is an error, and the rows a
   * reader gets are the ones they had before folders existed.
   */
  collectionFolders?: readonly CollectionFolder[];
  /**
   * A wish for this printing, filed where the reader pointed — `null` is the root wishlist.
   *
   * **The destination is an argument rather than a default**, because the menu is the one
   * surface that offers every folder at once and the row that was pressed is the only thing
   * that knows which. `WishInput.folderId` treats the folder as part of the row's storage
   * grain, the way `preferredFinish` already is: the same card wished into two folders is two
   * wishes, so passing the wrong one here writes a second row rather than moving anything.
   */
  addToWishlist: (target: CardMenuTarget, folderId: number | null) => void;
  /**
   * The wishlist's filing cabinet, flat, as the host page already holds it.
   *
   * **A value and not a query, which is what keeps the wishlist row a `submenu`.** Every host
   * subscribes once through `useCardMenuDeps` → `useWishlistFolders`, so the rows are in hand
   * before a reader right-clicks anything; see the row itself in `buildCardMenu` for why that
   * is the whole difference between this and the deck picker.
   *
   * Empty is the ordinary answer — a wishlist that files nothing, and a hook whose first read
   * has not landed, are the same array here. Neither is an error, and the row a reader gets is
   * the one they have always had.
   */
  wishlistFolders: readonly WishlistFolder[];
  /**
   * Open the printings modal for a card.
   *
   * **One field where there were three** — `viewPrintingsInPane`, `paneCardId` and
   * `requestAllPrintings`. The row used to route two ways, to the Search *view* outside the deck
   * editor and to the docked card *pane* inside it, and both were the same wish answered by
   * moving the reader somewhere: the first wrote `activeView` and cleared the open card and the
   * open deck in one `set`, so asking a question about a card closed the deck it was being asked
   * about; the second spent 384px of a 602px desk on a list. The modal is drawn over wherever the
   * reader already is, so there is one destination and no surface has to say which one it wants.
   */
  openAllPrintings: (t: PrintingsRequest) => void;
  /**
   * The deck slot this surface's rows belong to, or absent.
   *
   * Set only by a surface whose rows really are rows of an **open deck** — the deck editor's four
   * views. It is what makes a press inside the modal a *swap* rather than a look, and it is the
   * whole {@link PaneDeckContext} rather than a card id for that type's own reason: a context
   * naming fewer parts than `DECK_CARD_GRAIN` has rewritten the wrong row twice in this
   * codebase's history. A search tile in the editor's docked panel is not a deck row, and says so
   * by leaving this out.
   */
  printingsDeck?: PaneDeckContext | null;
  /**
   * The oracle card this surface is **already** listing every printing of, if it is.
   *
   * `paneCardId`'s replacement, one level up: the old field named a *printing*, because the pane
   * showed one card at a time and could only refuse the row on the card it was open on. The modal
   * lists the whole oracle card, so a different printing of it is the same list and the fence has
   * to be an oracle comparison. Only the modal sets it; absent means "this surface is not a
   * printings list", which is true of every other one.
   */
  printingsOracleId?: string | null;
  DeckTargetSubmenu: ComponentType<{ targets: readonly CardMenuTarget[]; onDone: () => void }>;
  /**
   * **The whole picked set, when the right-clicked card is in it** — issue #214. Absent, empty, or
   * holding one card, and this menu is about the tile that was right-clicked, exactly as it was
   * before multi-select existed.
   *
   * The *surface* decides membership rather than this builder, because the answer is a rule about
   * a press: a right-click on a tile outside the set is about that tile, not about four others the
   * reader had picked and forgotten. Passing `[]` there is what says so.
   *
   * ## Which rows read it
   *
   * The **writes** do: `Add to → Collection`, `Add to → Wishlist`, `Add to → Deck`, and the
   * collection's `Move to`. Each is a per-card write over an address the target already carries,
   * so plural is a loop and the label is the only thing that has to change.
   *
   * **`Copy card name`, `Copy card image`, `Open on` and `View all printings` stay about the one
   * card, and that is a statement rather than an omission.** A clipboard holds one image; a
   * browser tab opens one page; a printings modal lists one oracle card. There is no plural of
   * any of them that is not a different feature.
   *
   * **`Add to → Collection` drops its finish level for a group**, which is the one place the
   * plural is narrower than the singular — see {@link collectionItem}.
   */
  picked?: readonly CardMenuTarget[];
}

/**
 * The cards this press is about: the picked set, or the one card that was right-clicked.
 *
 * A set of one is the card, which is not merely equivalent — it is what stops every label growing
 * a `1 card` that says less than the card's own name.
 */
function menuTargets(target: CardMenuTarget, deps: CardMenuDeps): readonly CardMenuTarget[] {
  const picked = deps.picked ?? [];
  return picked.length > 1 ? picked : [target];
}

/** `4 cards` — the plural half of the labels below, never reached for a set of one. */
function manyCards(n: number): string {
  return `${n} cards`;
}

/**
 * The image size a reader means by "the card image": the same `display` variant the card pane
 * draws, which is Scryfall's `normal` — big enough to read, small enough to paste.
 */
const COPIED_IMAGE_VARIANT = "display" as const;

export function buildCardMenu(target: CardMenuTarget, deps: CardMenuDeps): MenuItem[] {
  const { marketplace, DeckTargetSubmenu } = deps;
  const rows = menuTargets(target, deps);
  const many = rows.length > 1;

  /** The `lazy` row's component, closed over the card. Named rather than inline so its identity
   *  is stable for the life of the built array, which is what keeps React from remounting the
   *  picker — and re-reading the deck list — on every render of the open panel. */
  function DeckPicker({ onDone }: { onDone: () => void }) {
    return <DeckTargetSubmenu targets={rows} onDone={onDone} />;
  }

  return [
    {
      kind: "action",
      id: "copy-name",
      label: "Copy card name",
      Icon: Copy,
      onSelect: () => run(copyText(target.name)),
    },
    {
      kind: "action",
      id: "copy-image",
      label: "Copy card image",
      Icon: ImageIcon,
      onSelect: () => run(copyCardImage(target.cardId)),
    },
    { kind: "separator", id: "sep-open" },
    {
      kind: "submenu",
      id: "open-on",
      label: "Open on",
      Icon: ExternalLink,
      /**
       * **Scryfall first, then the one marketplace, and this pair is deliberately not
       * alphabetical** — the app's option-list rule (`sortOptions`) orders lists a reader
       * *searches*, and this is a two-row ladder rather than a list: Scryfall is where the
       * card's own data came from and is the same entry on every card, while the second row
       * changes name with a setting. Sorting them would put Card Kingdom above Scryfall and
       * Cardmarket below it, so the row a reader has learnt the position of would move when
       * they changed marketplace.
       *
       * Exactly one marketplace, and it is the selected one: a menu offering all five would be
       * a marketplace picker, which Settings already is.
       */
      items: [
        {
          kind: "action",
          id: "open-scryfall",
          label: "Scryfall",
          onSelect: () =>
            run(openExternal(scryfallCardUrl(target.setCode, target.collectorNumber))),
        },
        {
          kind: "action",
          id: "open-marketplace",
          label: marketplace.label,
          onSelect: () => run(openExternal(marketplaceSearchUrl(marketplace.id, target.name))),
        },
      ],
    },
    // Beside "Open on" rather than in a group of its own: both answer "show me more of this
    // card", one outside the app and one in it, and a six-row menu with three rules in it is a
    // form rather than a menu.
    printingsItem(target, deps),
    { kind: "separator", id: "sep-add" },
    {
      kind: "submenu",
      id: "add-to",
      // `Add 4 cards to → Wishlist` (issue #214). The count is on the outer row rather than on
      // each destination, because it is a fact about what is being filed and not about where.
      label: many ? `Add ${manyCards(rows.length)} to` : "Add to",
      Icon: Plus,
      items: [
        collectionItem(target, rows, deps),
        wishlistItem(rows, deps),
        // `lazy` and not `submenu`: the folder tree and the deck list are two queries, and a
        // right-click on a card in a wall of forty must not fire either of them.
        { kind: "lazy", id: "add-deck", label: "Deck", Icon: Layers, Content: DeckPicker },
      ],
    },
    // Directly under "Add to" and with no rule between them: both are filing, and the pair reads
    // as one question — where does this card go — asked of a card the reader does not have yet
    // and of one they do. Absent entirely on every surface that cannot name a row; see
    // {@link CardMenuTarget.entryId} for why that is an absence rather than a greyed row.
    ...toItems(moveItem(rows, deps)),
  ];
}

/** One optional row, as a list to spread. A `null` item is a row the surface cannot offer at
 *  all, which is not the same as a row it offers greyed. */
function toItems(item: MenuItem | null): MenuItem[] {
  return item === null ? [] : [item];
}

/**
 * "View all printings" — one destination, and the two facts that can refuse it.
 *
 * **The first refusal is a fact about the card.** `oracleId` is nullable on `CardSummary`, which
 * is a fence around the type rather than a card anyone can find (0 of 116 590 live rows are null,
 * reversible printings included, because `card_row` falls back to `card_faces[0]`). With no oracle
 * id there is no list to ask for.
 *
 * **The second is a fact about the surface.** Inside the printings modal the row would re-ask the
 * question already on screen. This used to be `paneCardId` and used to be a *printing* comparison,
 * because the pane it fenced showed one card at a time; the modal lists the whole oracle card, so
 * a different printing of it is the same list and every tile in the modal would otherwise offer to
 * open the modal it is drawn in.
 *
 * **Both are greyed with a reason rather than hidden, and that is a judgement about this row in
 * particular.** The category menu leaves Delete *absent* on the four predefined zones on the
 * grounds that "an item that exists only to be refused is worse than one that is not there" — but
 * that item is refused on one kind of category and offered on every other, so its absence reads as
 * a property of the row it is missing from. This row is on every card surface and on every other
 * card of the surface it greys on, so removing it from one would read as a bug in the menu rather
 * than as a fact about the card. Greyed, it teaches the rule; that is the commander row's argument
 * and it is this one's.
 *
 * What a surface supplies is a fact — {@link CardMenuDeps.printingsOracleId} and
 * {@link CardMenuDeps.printingsDeck} — and never a decision. The label, the destination and both
 * sentences stay here, so the rule is one thing in one place.
 */
function printingsItem(target: CardMenuTarget, deps: CardMenuDeps): MenuAction {
  const { oracleId } = target;
  const row = {
    kind: "action",
    id: "printings",
    label: "View all printings",
    Icon: Images,
  } as const;

  if (oracleId === null) {
    return {
      ...row,
      disabled: true,
      reason: "this printing has left the card database",
      onSelect: () => {},
    };
  }
  // `!= null` before the comparison, rather than the comparison alone: the field is absent on
  // every surface that is not a printings list, and `undefined === undefined` would grey the row
  // for a card with no oracle id — which the arm above has already answered, in its own words.
  if (deps.printingsOracleId != null && deps.printingsOracleId === oracleId) {
    return {
      ...row,
      disabled: true,
      reason: "you are already looking at them",
      onSelect: () => {},
    };
  }
  return {
    ...row,
    // `?? null` because the dep is optional and the store's field is not: a surface that says
    // nothing about a deck is saying there is no slot to write to, and a press in the modal then
    // opens the card pane on the printing instead of swapping anything.
    onSelect: () =>
      deps.openAllPrintings({
        // The printing the menu was opened on: the modal's "you are here" mark, and — where the
        // surface is one of the app's card lists rather than a deck row — how it finds the
        // reader's place on `store.cardWalk`. Every target carries one; a row that names no
        // cardboard names no card menu either.
        cardId: target.cardId,
        oracleId,
        name: target.name,
        deck: deps.printingsDeck ?? null,
        // A menu row never repoints a wish: the wishlist's own controls are where a wish names
        // itself, and a right-click on a card is a question about the cardboard. Spelled out
        // because the field is required — see `PrintingsRequest`, where the `null` every
        // construction site has to write is the whole guarantee.
        wish: null,
      }),
  };
}

/**
 * Which finish an "Add to collection" records, and whether the reader is asked.
 *
 * A collection row's identity includes its finish, so one has to be chosen. The surface's own
 * wins where it has one (a collection row *is* a finish; a wishlist row may prefer one).
 * Where it has none — a search tile, a printings row, a deck card — the printing's own list
 * decides: one finish is no question and adds silently, two or more is a submenu.
 *
 * **A deck card carries one since schema v18 and still does not name it here**, which is a
 * decision rather than an oversight. `deck_cards.finish` says what a *deck* plays; a collection
 * entry says what the reader physically owns, and pre-filling the second from the first would
 * put a foil in somebody's binder because they had planned to buy one. The deck's own menu is
 * where that fact is edited (`deckCardMenu.tsx`'s `Set as foil`); this row asks its own
 * question.
 *
 * `finishes` is `null` when the column is empty, which is **unknown** rather than "no
 * finishes". Nonfoil is the answer there, because it is the answer for all but a handful of
 * printings and because refusing to add a card over a missing column would be worse.
 *
 * The finishes are offered in the **printing's own order**, which is Scryfall's and is the
 * order `FINISHES` is written in — nonfoil, foil, etched. That is an exemption from
 * `sortOptions` of the same kind the condition grade is: the order carries the information
 * (plain, then the two premium treatments), and alphabetising it would draw "Etched, Foil,
 * Nonfoil" over a picker whose whole job is to be read at a glance. `src/CLAUDE.md` states the
 * test the exemptions are granted by; it deliberately keeps no list of them.
 */
function collectionItem(
  target: CardMenuTarget,
  rows: readonly CardMenuTarget[],
  deps: CardMenuDeps,
): MenuItem {
  const folders = userFolders(deps.collectionFolders);
  /**
   * **The whole cabinet, not {@link folders}, and the difference is a bug this shipped with for
   * an afternoon.** `buildCollectionTargetItems` filters to the reader's own folders itself for
   * the tree it draws — but its app section has to find the `kind = 'deck'` rows, and a list that
   * has already been through `userFolders` has none. The picker then drew `Recently removed` and
   * no `Decks` submenu at all, on a database with three deck groups in the pinned band one panel
   * over. Every unit test passed, because they call that builder directly with an unfiltered
   * list; only driving the shipped window found it.
   *
   * `folders` stays for the `length === 0` guards below, which really are asking about the
   * reader's own cabinet: it is what decides whether this row is one press or a picker.
   */
  const cabinet = deps.collectionFolders ?? [];
  const { addToCollection } = deps;
  /**
   * The app's own drawers, for the cabinet below — **only under "Add to", never under "Move to"**.
   *
   * A deck row here files a copy through the deck's own add, and an add is what this row already
   * is. `moveItem` deliberately passes no `app`: it is labelled *Move*, `deps.toDeck` writes a
   * `deck_cards` row and adds one copy, and a row that said "move" while adding would be
   * mislabelling its own write — the one thing a destination picker may not do.
   *
   * **And only where the reader already has folders**, which is why every branch below tests
   * `folders.length` *before* it reaches for this. A reader who has made no folder has always had
   * "Add to → Collection" as a single press, and turning that into a submenu so it could offer
   * decks would put a fork in the commonest path in the app to describe a cabinet they do not
   * have — with `Add to → Deck` sitting one row above it the whole time. It cost a test to learn:
   * the docked pane's refusal case clicked Add to → Collection → Nonfoil on a printing with no
   * folders, and the extra rung swallowed the add. **That test went with `CardDetailPane.test.tsx`
   * on 2026-09-03 and nothing has replaced it**, so the rule above is currently guarded by this
   * comment rather than by a build.
   */
  const appTargets = (rows: readonly CardMenuTarget[]): CollectionAppSection | undefined =>
    deps.toDeck === undefined
      ? undefined
      : {
          toDeck: (deckId: number) => rows.forEach((row) => deps.toDeck?.(row, deckId)),
          // **The same `rows` the write loops over, and that identity is the whole point.** The
          // deck rows are greyed unless the deck plays every one of these, so a `targets` naming a
          // different set than the loop would grey against one list and write another — a fence
          // measuring something other than what it guards.
          targets: rows,
        };

  /**
   * **A group is recorded in each card's own plain finish, and the finish level is dropped.**
   *
   * This is the one row where the plural is narrower than the singular, and it is deliberate. A
   * finish belongs to a *printing*: the choices differ card by card, so a group has no one list to
   * offer — and a submenu built from the right-clicked card's finishes would either refuse the
   * members that are not sold that way or, worse, record them in a finish nobody said they had.
   * The collection is a record of cardboard the reader physically owns; inventing a foil in it is
   * the one kind of wrong they cannot check against anything.
   *
   * So the group files each card in `finishChoices`' first answer — `nonfoil` for all but the
   * 13 515 foil-only and 892 etched-only printings, which get their own only finish — and a reader
   * who wants the shiny copy records that card on its own. The folder question survives whole,
   * because a folder is about the reader's cabinet rather than about the cardboard.
   */
  if (rows.length > 1) {
    const fileAll = (folderId: number | null) => {
      for (const row of rows) {
        addToCollection(row, row.finish ?? finishChoices(row.finishes)[0], folderId);
      }
    };
    if (folders.length === 0) return collectionRow(() => fileAll(null));
    const app = appTargets(rows);
    return {
      kind: "submenu",
      id: "add-collection",
      label: "Collection",
      Icon: LibraryBig,
      items: buildCollectionTargetItems(cabinet, fileAll, app),
    };
  }

  // A finish the surface named is the whole list: it is what that row **is**, and offering the
  // printing's other two would be asking a question the surface has already answered.
  const named = target.finish;
  const choices = named !== undefined ? [named] : finishChoices(target.finishes);

  const app = appTargets([target]);
  if (choices.length === 1) {
    const finish = choices[0];
    if (folders.length === 0) {
      return collectionRow(() => addToCollection(target, finish, null));
    }
    return {
      kind: "submenu",
      id: "add-collection",
      label: "Collection",
      Icon: LibraryBig,
      items: buildCollectionTargetItems(
        cabinet,
        (folderId) => addToCollection(target, finish, folderId),
        app,
      ),
    };
  }
  /**
   * **Finish first, then folder** — the two questions compose rather than flattening into one
   * list, because they are about different things: which piece of cardboard the reader is
   * recording, and which drawer they keep it in. A flat "Nonfoil → Binder" list would be
   * `finishes × folders` rows, and the count multiplies with every folder the reader makes.
   */
  return {
    kind: "submenu",
    id: "add-collection",
    label: "Collection",
    Icon: LibraryBig,
    items: choices.map((finish) =>
      finishBranch(
        finish,
        folders,
        cabinet,
        (folderId) => addToCollection(target, finish, folderId),
        app,
      ),
    ),
  };
}

/** One finish of the picker above: a press where the collection files nothing, and the folder
 *  tree where it does. */
function finishBranch(
  finish: Finish,
  /** The reader's own, for the one question this level asks: is there a cabinet at all? */
  folders: readonly CollectionFolder[],
  /** The whole list, for the builder — see {@link collectionItem}'s `cabinet`. */
  cabinet: readonly CollectionFolder[],
  choose: (folderId: number | null) => void,
  app?: CollectionAppSection,
): MenuItem {
  const row = { id: `add-collection-${finish}`, label: FINISH_LABEL[finish] } as const;
  if (folders.length === 0) {
    return { kind: "action", ...row, onSelect: () => choose(null) };
  }
  return { kind: "submenu", ...row, items: buildCollectionTargetItems(cabinet, choose, app) };
}

function collectionRow(onSelect: () => void): MenuAction {
  return { kind: "action", id: "add-collection", label: "Collection", Icon: LibraryBig, onSelect };
}

/**
 * "Move to" — the same cabinet as "Add to → Collection", asked of a copy the reader already has.
 *
 * **Three things have to be true for it to exist at all**, and each absence means the same
 * thing: the surface has no row to move ({@link CardMenuTarget.entryId} or
 * {@link CardMenuTarget.entryIds}), the surface wired no write
 * ({@link CardMenuDeps.moveToFolder}), or the reader has made no folder. The last is the
 * wishlist row's rule read from the other end — with no cabinet the only destination is the root,
 * which is where every unfiled copy already is, so the whole item would be a press that does
 * nothing.
 *
 * **It is a `submenu` and never a `lazy` row** for {@link wishlistItem}'s reason: the folder list
 * is one command the host page already ran, so there is nothing for a right-click to fire.
 *
 * **The folder the copy is already in is offered like any other and is not marked.** A move onto
 * it writes the row back where it is, which is a no-op the reader cannot see — and marking it
 * would mean every collection surface handing this file a `folderId` it has no other use for,
 * for a fence the backend does not need.
 */
function moveItem(rows: readonly CardMenuTarget[], deps: CardMenuDeps): MenuItem | null {
  const move = deps.moveToFolder;
  const pick = deps.pickCopies;
  const folders = userFolders(deps.collectionFolders);
  const entryIds = movableEntryIds(rows);
  if (entryIds.length === 0 || move === undefined || folders.length === 0) return null;
  return {
    kind: "submenu",
    id: "move-to",
    // The count is of **entries**, which is what it has always been — one row of
    // `collection_entries` is one thing the write addresses, and it is the only unit either side
    // of this row agrees on (an entry may hold four copies, and a tile may hold three entries).
    label: entryIds.length > 1 ? `Move ${manyCards(entryIds.length)} to` : "Move to",
    Icon: FolderInput,
    items: buildCollectionTargetItems(folders, (folderId) => {
      /**
       * **One entry is a move; several is a question.** A single row is the copy the reader
       * pointed at, so the press files it and there is nothing to ask — that is this row's whole
       * behaviour on the collection's table and it does not change.
       *
       * Several is the wall's tile, or a picked set: the ids behind it are copies in different
       * grades, languages and drawers, and filing all of them because the reader pointed at the
       * art would move copies they never named. {@link CardMenuDeps.pickCopies} is the surface's
       * dialog.
       *
       * (It read "different finishes in different drawers" until 2026-08-26. Only collection
       * targets carry `entryIds`, and both of the app's collection walls now draw one tile per
       * printing **and finish** — so the finish is the one thing the ids behind a tile can no
       * longer disagree about. The rule is unchanged; the example was simply the wrong one.)
       *
       * **With no dialog wired it loops**, which is what a multi-picked set has done since #214.
       * Falling through to nothing would take a working row off a surface that never had the
       * question to ask.
       */
      if (entryIds.length === 1) {
        move(entryIds[0], folderId);
        return;
      }
      if (pick !== undefined) {
        pick(entryIds, folderId);
        return;
      }
      for (const entryId of entryIds) move(entryId, folderId);
    }),
  };
}

/**
 * Every `collection_entries` row this press is about, in the order the targets name them and with
 * no id twice.
 *
 * **Only the members that name a row.** A picked set can hold a search tile and a deck card as
 * well as copies the reader owns; {@link CardMenuTarget.entryId} and
 * {@link CardMenuTarget.entryIds} are what say a target really is stored cardboard. A group with
 * neither has nothing to move and gets no row at all, which is the same absence a card outside the
 * collection has always had.
 *
 * **Both fields are read, and reading only one would be silently wrong in opposite directions.**
 * A table row carries the first and a wall tile the second, and a picked set drawn on a page that
 * offers both views can hold either.
 *
 * **Deduped, because the two surfaces can name the same row twice.** A picked set that holds a
 * tile and the entry inside it — or two tiles the page summed overlapping — would otherwise file
 * one entry twice, and the second write lands on a row the first has already merged away.
 */
function movableEntryIds(rows: readonly CardMenuTarget[]): number[] {
  const seen = new Set<number>();
  for (const row of rows) {
    if (row.entryId !== undefined) seen.add(row.entryId);
    for (const id of row.entryIds ?? []) seen.add(id);
  }
  return [...seen];
}

/**
 * "Add to → Wishlist", and the one thing that decides whether it is a press or a question.
 *
 * **With no folders it is a single `action`, exactly as it was before folders existed.** That
 * is the case for every reader who has never made one — a wishlist that files nothing is the
 * ordinary wishlist — and turning their one press into a submenu with one row in it would be a
 * cost paid by everybody to describe a cabinet that is empty. `null` is the root, spelled out
 * rather than defaulted, because a destination the caller did not choose is the bug
 * {@link CardMenuDeps.addToWishlist} exists to make unwritable.
 *
 * **With folders it is a `submenu` and deliberately not a `lazy` row, which is the opposite of
 * the deck picker directly below it.** `lazy` exists because `useDecks()` and `useDeckFolders()`
 * are two queries a right-click on a wall of forty tiles must not fire; that is a rule about
 * *reaching the backend on open*, and a folder list the host page is already subscribed to is
 * not reaching anything. `useCardMenuDeps` holds one `useWishlistFolders()` per page mount, so
 * the rows are in hand before the menu is built and the whole `lazy` machinery — a component, a
 * mount, a note while it loads — would buy a fetch that has already happened.
 */
function wishlistItem(rows: readonly CardMenuTarget[], deps: CardMenuDeps): MenuItem {
  const row = { id: "add-wishlist", label: "Wishlist", Icon: Heart } as const;
  // **The plural is a clean loop here and needs no note about finishes**, unlike the collection
  // row above: a wish is oracle-grained and finish-blind by design (`add_wish` upserts, so two
  // lines of one card fold into one wish), so filing four cards is four writes and nothing about
  // any of them is a guess.
  const wishAll = (folderId: number | null) => {
    for (const target of rows) deps.addToWishlist(target, folderId);
  };
  if (deps.wishlistFolders.length === 0) {
    return { kind: "action", ...row, onSelect: () => wishAll(null) };
  }
  return {
    kind: "submenu",
    ...row,
    items: buildWishlistTargetItems(deps.wishlistFolders, wishAll),
  };
}

/** The finishes this printing can be recorded in — never empty, because an add has to name one. */
function finishChoices(finishes: string | null): Finish[] {
  const listed = parseFinishes(finishes);
  return listed.length > 0 ? listed : ["nonfoil"];
}

/**
 * The display image's URL, asked for **on the press**.
 *
 * Three ways to `null` and all of them answers — an unknown card, a card with no `image_uris`,
 * a variant the source lacked — and the honest response to every one of them is to copy
 * nothing. A clipboard holding the *previous* card's URL because this one had no picture is
 * worse than a press that did nothing.
 */
async function copyCardImage(cardId: string): Promise<void> {
  const uri = await ipc.cardImageUri(cardId, COPIED_IMAGE_VARIANT);
  if (!uri) return;
  await copyText(uri);
}

/**
 * Start an item's asynchronous work and swallow its refusal.
 *
 * `MenuItem.onSelect` is synchronous and the panel closes on the press, so there is nothing
 * left on screen for a rejection to be reported to. Every call routed through here is a
 * clipboard write, an `openUrl` or a local SQLite read — a failed one costs the reader a press
 * they can simply make again, and an unhandled rejection in the window costs a console error on
 * every one of them.
 */
function run(work: Promise<unknown>): void {
  void work.catch(() => {});
}

/* ------------------------------------------------------------------------------------------ *
 * The deck picker
 * ------------------------------------------------------------------------------------------ */

/**
 * The folder tree, the decks in it, and the two lists a deck may have — mounted only when the
 * reader expands "Add to → Deck".
 *
 * **This component is the whole reason `MenuLazy` exists.** `useDecks()` and `useDeckFolders()`
 * are two queries, and a right-click on a tile in a wall of forty must fire neither. They fire
 * here, on an expand, which is a deliberate act.
 *
 * **It draws nothing of its own but two words.** The rows are `MenuRows`, the menu module's one
 * export for a lazy body, so a folder here is a real nested `role="menu"` with the cascade's
 * ArrowRight, ArrowLeft, `aria-haspopup`/`aria-expanded`, caret and per-level Escape — rather
 * than an indented list whose hierarchy only the sighted reader can see. A second implementation
 * of a menu row is the thing that export exists to prevent.
 *
 * **It writes nothing, and that is not tidiness.** `ctx.run` hands focus back, closes the menu
 * and *then* calls `onSelect`, so by the time a leaf's handler runs this component is on its way
 * out — it survives only for the length of the panel's exit animation, which is no place to put
 * a write and nowhere at all to put its refusal. {@link useCardToDeck} is the other half, mounted
 * **once** above the whole app, and this reaches it through {@link useAddCardToDeck}. That is the
 * split `useSidebarDrops` and `useSwapFromPane` already use — borrow `useDeck` whole somewhere
 * that persists, and own the reporting there — and it is mounted once for their reason too.
 *
 * **The write arrives by context rather than by a prop, and that is the fence.** Its props are
 * exactly `CardMenuDeps`' `{ target, onDone }`, so a surface passes this component itself with
 * no glue: there is no callback to mis-wire and no `error` string for a surface to forget to
 * draw. Wiring the picker without the single mount is not a silent omission either — see
 * {@link useAddCardToDeck}.
 *
 * `onDone` is accepted and deliberately **not called**: `ctx.run` has already closed the menu by
 * the time any row of this body runs, and calling it too would be a double close. It is for a
 * body that finishes without a row being pressed, which this one cannot do.
 */
export function DeckTargetSubmenu(props: {
  /**
   * The cards to file — one for an ordinary press, several when the reader right-clicked a member
   * of a picked set (issue #214). A list rather than a single target because the picker is one
   * tree of decks whichever it is, and the only thing a group changes is how many writes a press
   * on a deck makes.
   */
  targets: readonly CardMenuTarget[];
  onDone: () => void;
}) {
  const { targets } = props;
  const addToDeck = useAddCardToDeck();
  const { decks, query: deckQuery } = useDecks();
  const { folders, query: folderQuery } = useDeckFolders();

  const items = useMemo(
    () =>
      buildDeckTargetItems(folders, decks, (deckId, variant) => {
        for (const target of targets) addToDeck(target, deckId, variant);
      }),
    [folders, decks, addToDeck, targets],
  );

  // A gallery with nothing in it and a gallery that has not answered yet are told apart by
  // `isPending`, never by the empty array — both hooks say so on their own `decks`/`folders`.
  if (deckQuery.isPending || folderQuery.isPending) return <PickerNote>Loading decks…</PickerNote>;
  if (items.length === 0) return <PickerNote>No decks</PickerNote>;
  return <MenuRows items={items} />;
}

/** Where a card the reader picked in the menu is written, and what a refusal left behind. */
export interface CardToDeck {
  /** Called by {@link DeckTargetSubmenu}, through {@link useAddCardToDeck}. */
  addToDeck: (target: CardMenuTarget, deckId: number, variant: DeckVariant) => void;
  /** What the last refused add said, or `null`. Drawn by the one mount, and by nothing else. */
  error: string | null;
  clearError: () => void;
}

/**
 * The context the picker reaches its write through — **provided once, for the whole app**.
 *
 * `null` is "nobody has mounted {@link useCardToDeck}", and {@link useAddCardToDeck} turns that
 * into a throw rather than into a card that quietly never lands.
 */
const CardToDeckContext = createContext<CardToDeck | null>(null);

/**
 * The app's single {@link useCardToDeck}, and the context every card menu reaches it through.
 *
 * Mounted **once**: `cardMenu.tsx` serves every card surface, TypeScript can force a callback but
 * cannot force anybody to *render* a string, and a rule that lives at every call site is a rule
 * that drifts. One mount is one place to forget, and it is the same place the sentence is drawn
 * ({@link useCardToDeckRefusal}).
 *
 * **It calls the hook itself rather than taking the value as a prop**, so the state and the
 * sentence cannot end up owned in two different components.
 *
 * ## Where to mount it, and the trap
 *
 * **Above `ContextMenuProvider`, in `App.tsx` — not inside `AppShell`.** `ContextMenuProvider`
 * draws the menu panel as a **sibling** of its `children`, so "inside the shell" and "inside the
 * menu" are two different places: a provider around the shell is around every *view* and around
 * none of the *menu rows*, and `useAddCardToDeck` then throws the moment a reader expands
 * "Add to → Deck" on any surface. Anything a menu's rows need — this, and whatever comes next —
 * belongs above `ContextMenuProvider`. That mistake shipped once; see this file's tests.
 */
export function CardToDeckProvider({ children }: { children: ReactNode }) {
  const value = useCardToDeck();
  return <CardToDeckContext.Provider value={value}>{children}</CardToDeckContext.Provider>;
}

/**
 * The write, as a surface's picker sees it.
 *
 * **Throws without the provider, on render, deliberately.** The failure this fences off is a
 * card that is never added and a refusal nobody is told about — silent in the window, silent in
 * the suite, and reported by the reader as "the menu does nothing sometimes". A missing provider
 * is a wiring mistake, and a wiring mistake should be loud at the first render of the surface
 * that made it rather than quiet at the reader's tenth add.
 */
export function useAddCardToDeck(): CardToDeck["addToDeck"] {
  return useMountedCardToDeck().addToDeck;
}

/**
 * The sentence a refused add left, for the **one** place that draws it.
 *
 * Read through the same context as the write rather than out of a second `useCardToDeck`, so
 * there is exactly one piece of state: a component that mounted its own hook to get the sentence
 * would be reporting on adds nobody made through it.
 */
export function useCardToDeckRefusal(): string | null {
  return useMountedCardToDeck().error;
}

/**
 * The deck write **if somebody mounted it**, or `null` — for a surface that offers a deck as one
 * destination among many and must stay renderable without the provider.
 *
 * **Deliberately not {@link useAddCardToDeck}, whose throw is a fence this is not weakening.**
 * That one guards the case it was written for: a picker whose *whole purpose* is the deck add,
 * wired without the mount, doing nothing and saying nothing. Here the write is one optional row
 * inside the collection's cabinet, so a missing provider means the row is **not offered** rather
 * than offered and inert — which is how every other optional dependency in this file already
 * behaves (`moveToFolder`, `collectionFolders`: absent, and the item is simply not built).
 *
 * The alternative was to throw from `useCardMenuDeps`, which every card surface in the app
 * mounts — the search walls, the collection, the wishlist, the tags page, the card pane, the deck
 * editor — and whose suites deliberately render those pages under `ContextMenuProvider` and
 * `TooltipProvider` alone. `useContextMenu` answers a no-op with no provider above it for exactly
 * this reason, and its comment in `CollectionPage.test.tsx` states the trade: a surface offering a
 * right-click stays renderable on its own. This is that rule, one dependency further in.
 */
export function useOptionalAddCardToDeck(): CardToDeck["addToDeck"] | null {
  return useContext(CardToDeckContext)?.addToDeck ?? null;
}

function useMountedCardToDeck(): CardToDeck {
  const value = useContext(CardToDeckContext);
  if (value === null) {
    throw new Error(
      "A card menu needs <CardToDeckProvider> above <ContextMenuProvider> — see CardToDeckProvider.",
    );
  }
  return value;
}

/**
 * The other half of the deck picker: the write, and what to say when it is refused.
 *
 * **Mounted once, above the app, and never by the menu**, because a menu row's handler runs
 * *after* `ctx.run` has closed the menu — a write started from inside the panel lives only as
 * long as its exit animation, and an answer that arrives after that has nowhere to be reported
 * and no observer left to report it. The two surfaces that already reach a deck write from
 * outside the editor solve it the same way: `useSidebarDrops` is mounted in `AppShell` and
 * `useSwapFromPane` in the card pane, and `decks/CLAUDE.md` names both as borrowing the mutation
 * whole while owning only their own reporting. This is the third — and, like `useSidebarDrops`,
 * it is mounted **once** rather than per surface.
 *
 * **{@link CardToDeckProvider} is its only caller in the app**, and mounting it anywhere else
 * would be a second piece of state reporting on adds nobody made through it. It is exported for
 * the tests that drive the write directly, and for nothing else.
 *
 * Its `error` reaches the one place that draws it through {@link useCardToDeckRefusal}. Nothing
 * is invented for it: there is no toast in this app, and a menu that has already closed is not a
 * place to put one.
 */
export function useCardToDeck(): CardToDeck {
  /**
   * The add the reader asked for. Setting it is what mounts the deck's own hook below.
   *
   * **One `useDeck`, armed by the press rather than by the row**, because `useDeck` is the single
   * definition of the add rule *and* it carries the deck's own `deck_get`. A hook per deck row
   * would read every deck in the gallery to offer a menu; `null` until a leaf is taken leaves
   * that query disabled (`enabled: id !== null`), and the one read that does happen is for the
   * deck the card is going into.
   */
  const [pending, setPending] = useState<{
    target: CardMenuTarget;
    deckId: number;
    variant: DeckVariant;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { addCard } = useDeck(pending?.deckId ?? null, pending?.variant ?? DEFAULT_VARIANT);
  const add = addCard.mutate;
  /**
   * Which add has already been sent, so it happens exactly once.
   *
   * Load-bearing under `StrictMode`, which mounts an effect twice on purpose — without it a
   * single press would put two copies in the deck in development and one in the shipped window,
   * which is the worst shape a bug can have.
   */
  const written = useRef<{ target: CardMenuTarget; deckId: number; variant: DeckVariant } | null>(
    null,
  );

  useEffect(() => {
    if (pending === null || written.current === pending) return;
    written.current = pending;
    /**
     * **No `categoryId`, so `autoCategoryFor` files the card by what it does** — the app's one
     * rule, shared by a plain add, a drag with no column under it and an imported line. The type
     * line travels as the fallback (`null` where the surface has none); it is deliberately not
     * *absent*, which is the arm that files everything under `DEFAULT_CATEGORY_NAME` without
     * consulting the card at all.
     *
     * The per-call callbacks are this surface's reporting, exactly as `dropOnDecks` attaches
     * its sentences; the `["decks"]` invalidation that carries a `GONE` back to the editor's
     * columns stays on `useDeck.addCard`'s single definition, because two definitions would be
     * two places to keep one rule.
     */
    add(
      {
        cardId: pending.target.cardId,
        typeLine: pending.target.typeLine ?? null,
        quantity: 1,
      },
      {
        onError: (refusal) => setError(ipcError(refusal)),
        /**
         * **Disarm, or this surface observes that deck for the rest of the session.**
         * `useDeck(id, …)` is a live `deck_get` — the deck, every card in it and its categories —
         * and `addCard`'s own `onSuccess` invalidates the whole `["decks"]` prefix, which that
         * key is under. A `pending` left set therefore leaves the mount re-reading a deck nothing
         * on screen draws, on every add, quantity change or rename anywhere in the app. Clearing
         * it puts `useDeck` back to `null`, where its query is disabled.
         *
         * `onSettled` rather than a clear in each of the two arms above, because it is one line
         * that cannot be half-applied, and it runs after both — so the sentence is already set
         * when the observer goes away. The in-flight mutation does not care: it belongs to the
         * mutation cache, and only the *observer's* per-call callbacks are at stake here, which
         * have both already run.
         */
        onSettled: () => setPending(null),
      },
    );
  }, [pending, add]);

  const addToDeck = useCallback((target: CardMenuTarget, deckId: number, variant: DeckVariant) => {
    // Last time's refusal is not news about this add. Left standing, a sentence about a deck
    // that has been deleted survives the whole of the next add's round trip, over rows the
    // reader has already moved on from.
    setError(null);
    // A fresh object every time, so pressing the same leaf twice is two adds rather than one:
    // the guard above is identity on this value and a reader who adds a second copy means it.
    setPending({ target, deckId, variant });
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return { addToDeck, error, clearError };
}

/**
 * The gallery as a menu: folders, the decks filed in them, and each deck's two lists.
 *
 * Pure, and separately exported, because it is the half of the picker worth pinning — the
 * component around it is hooks and markup.
 *
 * **Archived decks are left out.** The gallery keeps them behind their own disclosure, and a
 * destination list that offered them would put a deck the reader has explicitly shelved beside
 * the one they are building.
 *
 * Folders come first at every level and **keep `buildFolderTree`'s order**, which is
 * `sortOrder`, then name, then id. A folder tree is an arrangement the reader made, which is one
 * of the two kinds of list `src/lib/options.ts` exempts — the other kind being a list whose order
 * *is* the information, like a grade scale — and it is the same argument deck categories are
 * exempt under: re-sorting it here would list a reader's drawers in one order in the gallery and
 * another in this picker, over the same cabinet, which reads as a bug and is one. **Decks within
 * a level still go through `sortOptions`**: `deck_list` answers archived-last,
 * most-recently-touched-first, which is a gallery's order and not a list anybody looks a name up
 * in.
 *
 * A folder holding neither a deck nor a folder with a deck in it is dropped — an empty submenu
 * is a row that opens onto nothing.
 */
export function buildDeckTargetItems(
  folders: readonly DeckFolder[],
  decks: readonly DeckRow[],
  choose: (deckId: number, variant: DeckVariant) => void,
): MenuItem[] {
  const live = decks.filter((deck) => !deck.archived);
  const tree = buildFolderTree(folders, live);
  // `buildFolderTree` resolves a `parentId` naming a folder this list does not carry towards
  // the **root**; a deck whose `folderId` does the same has to resolve the same way, or it is a
  // deck with no row anywhere in the picker.
  const known = new Set(folders.map((folder) => folder.id));
  const homeOf = (deck: DeckRow) =>
    deck.folderId !== null && known.has(deck.folderId) ? deck.folderId : null;
  return deckLevel(tree, live, null, homeOf, choose);
}

function deckLevel(
  nodes: readonly FolderNode[],
  decks: readonly DeckRow[],
  folderId: number | null,
  homeOf: (deck: DeckRow) => number | null,
  choose: (deckId: number, variant: DeckVariant) => void,
): MenuItem[] {
  // No `sortOptions` here, deliberately — see this level's builder above. `buildFolderTree` has
  // already put the siblings in the reader's own order.
  const drawers = nodes.flatMap((node) => {
    const items = deckLevel(node.children, decks, node.folder.id, homeOf, choose);
    if (items.length === 0) return [];
    return [
      {
        kind: "submenu" as const,
        id: `deck-folder-${node.folder.id}`,
        label: node.folder.name,
        Icon: Folder,
        items,
      },
    ];
  });
  const here = sortOptions(
    decks.filter((deck) => homeOf(deck) === folderId),
    (deck) => deck.name,
  ).map((deck) => deckItem(deck, choose));
  return [...drawers, ...here];
}

/**
 * The wishlist as a menu: the root list, a rule, and the folders filed under it.
 *
 * Pure and separately exported for `buildDeckTargetItems`' reason — this is the half worth
 * pinning, and the row that calls it is three lines of branch.
 *
 * **The root goes first and is never omitted.** `NULL` is where every wish lands unless somebody
 * says otherwise, so it is the answer a reader wants most often and the one that must not move
 * when they make their fourth folder. The separator under it says the same thing the indent
 * would if this were a page: everything below is filing.
 *
 * Folders keep `buildFolderTree`'s order — `sortOrder`, then name, then id — and go through no
 * `sortOptions`, which is `buildDeckTargetItems`' argument reached from the wishlist's end: a
 * folder tree is an arrangement the reader made, one of the two kinds of list `src/lib/options.ts`
 * exempts, and listing their drawers one way on the wishlist page and another in this picker
 * reads as a bug because it is one.
 *
 * **Members are deliberately not passed** — `buildFolderTree(folders, [])`. The node counts come
 * back zero and nothing here reads one: a folder is a *destination*, and how many wishes are
 * already in it has no bearing on whether a reader may file the fortieth there.
 */
export function buildWishlistTargetItems(
  folders: readonly WishlistFolder[],
  choose: (folderId: number | null) => void,
): MenuItem[] {
  return [
    {
      kind: "action",
      id: "wishlist-root",
      label: "Wishlist",
      // `Heart`, not `Folder`: the root is the list itself rather than a drawer in it, and it
      // wears the same glyph as the row this submenu hangs off.
      Icon: Heart,
      onSelect: () => choose(null),
    },
    { kind: "separator", id: "wishlist-sep-root" },
    ...wishlistLevel(buildFolderTree(folders, []), choose),
  ];
}

function wishlistLevel(
  nodes: readonly FolderNode<WishlistFolder>[],
  choose: (folderId: number | null) => void,
): MenuItem[] {
  return nodes.map((node): MenuItem => {
    const { id, name } = node.folder;
    const here = {
      kind: "action",
      id: `wishlist-folder-${id}`,
      label: name,
      Icon: Folder,
      onSelect: () => choose(id),
    } as const;
    /**
     * **An empty folder is still offered, and this is where `deckLevel` does the opposite.**
     * There a folder is a *container of destinations* — a drawer holding no deck and no drawer
     * with a deck in it opens onto an empty panel, so it is dropped. Here the folder **is** the
     * destination: filing the first wish into a folder the reader made an hour ago is exactly
     * what an empty one is for, and dropping it would leave that folder reachable only from the
     * wishlist page.
     */
    if (node.children.length === 0) return here;
    /**
     * A folder with children draws **its own row first**, then a rule, then them — the second
     * divergence. `deckLevel`'s submenu holds decks and sub-folders, two different kinds of
     * thing, and the folder itself is not one of them. Here the parent and its children are all
     * destinations of the same kind, so a submenu that offered only the children would make
     * "Expensive" the one folder in the cabinet a card cannot be filed into: the reader would
     * open it looking for the drawer and find only what is inside it.
     */
    return {
      kind: "submenu",
      id: `wishlist-folder-${id}`,
      label: name,
      Icon: Folder,
      items: [
        { ...here, id: `wishlist-folder-${id}-here` },
        { kind: "separator", id: `wishlist-folder-${id}-sep` },
        ...wishlistLevel(node.children, choose),
      ],
    };
  });
}

/* ------------------------------------------------------------------------------------------ *
 * The collection's cabinet
 * ------------------------------------------------------------------------------------------ */

/**
 * The kind of folder the reader made and named — `schema::COLLECTION_FOLDER_KINDS[0]`, and the
 * only kind anything in this file offers as a destination.
 *
 * The other two say something the **app** is responsible for: that a deck holds these copies,
 * that these copies have left the collection. A reader filing a card into one by hand would be
 * asserting that without any of the writes that make it true, so `collection_set_folder` refuses
 * both in words — and a menu whose rows are refusals is a menu that teaches nothing.
 */
const USER_FOLDER_KIND = "user";

/**
 * `COLLECTION_FOLDER_KINDS[1]` — the one folder standing for a deck, and the only kind carrying a
 * {@link CollectionFolder.deckId}.
 *
 * Spelled here rather than imported from `PinnedFolders.tsx`, which spells it too: `kind` crosses
 * the wire as a plain string, and this file already keeps its own word for the reader's kind one
 * line up. Pulling the collection page's constant across would drag a component, a tooltip and a
 * summary formatter into a builder that draws no markup.
 */
const DECK_FOLDER_KIND = "deck";

/** The reader's own drawers, out of a list that also carries the app's. Absent is empty: a page
 *  that has not answered yet and a collection that files nothing are the same array here. */
function userFolders(folders: readonly CollectionFolder[] | undefined): readonly CollectionFolder[] {
  return (folders ?? []).filter((folder) => folder.kind === USER_FOLDER_KIND);
}

/**
 * What a surface has to hand over before the cabinet may offer the app's own deck groups.
 *
 * **The cards are as required as the write, and that is the shape saying what {@link appSection}
 * now needs.** A deck row is greyed unless the deck's live list already plays *every* card this
 * press is about, so the rows cannot be built from the folder list alone — the census is a
 * question about these particular cards. Making `targets` optional would let a caller reach the
 * rows with nothing to check them against, and the safe answer to that (`[]` → nothing plays it →
 * every deck greyed) is a picker that is silently, permanently dead. Required, so a caller that
 * has not thought about it does not compile.
 */
export interface CollectionAppSection {
  /** Claim these copies for a deck. The caller routes this to the sanctioned write —
   *  never `collection_set_folder`. Absent means the surface offers no deck row. */
  toDeck?: (deckId: number) => void;
  /** The cards the press is about — one for an ordinary right-click, the whole picked set for a
   *  group. Exactly {@link menuTargets}' answer, handed down. */
  targets: readonly CardMenuTarget[];
}

/**
 * The collection as a menu: the root, a rule, and the folders filed under it.
 *
 * **{@link buildWishlistTargetItems} ported, both divergences included**, because the two
 * cabinets answer the same question — where does this card go — and a picker that behaved one
 * way on the wishlist and another on the collection would read as a bug in whichever the reader
 * met second. Written out rather than shared with it: the two differ in their root row, in every
 * id, and in the kind filter below, and a generic taking three of those as parameters would be
 * harder to read than either copy.
 *
 * **Two callers, one shape** — "Add to → Collection" and "Move to". An add and a move are
 * different writes over the same destination list, and the list is exactly this either way.
 *
 * **The root goes first and is never omitted.** `NULL` is where every copy lands unless somebody
 * says otherwise, so it is the answer a reader wants most often and the one that must not move
 * when they make their fourth folder. The separator under it says what the indent would if this
 * were a page: everything below is filing.
 *
 * **Only the reader's own folders are offered as *folders*** — see {@link USER_FOLDER_KIND}. The
 * filter is here rather than at the call sites so that a third caller cannot forget it. The app's
 * own two kinds appear under `app`, routed to the writes that make them true rather than to
 * `collection_set_folder`; see the parameter.
 *
 * Folders keep `buildFolderTree`'s order — `sortOrder`, then name, then id — and go through no
 * `sortOptions`: a folder tree is an arrangement the reader made, one of the two kinds of list
 * `src/lib/options.ts` exempts, and listing their drawers one way on the collection page and
 * another in this picker reads as a bug because it is one.
 *
 * **Members are deliberately not passed** — `buildFolderTree(folders, [])`. The node counts come
 * back zero and nothing here reads one: a folder is a *destination*, and how many copies are
 * already in it has no bearing on whether the fortieth may go there.
 */
export function buildCollectionTargetItems(
  folders: readonly CollectionFolder[],
  choose: (folderId: number | null) => void,
  app?: CollectionAppSection,
): MenuItem[] {
  const mine = collectionLevel(buildFolderTree(userFolders(folders), []), choose);
  const theirs = appSection(folders, app);
  return [
    {
      kind: "action",
      id: "collection-root",
      label: "Collection",
      // `LibraryBig`, not `Folder`: the root is the collection itself rather than a drawer in
      // it, and it wears the same glyph as the row this picker hangs off.
      Icon: LibraryBig,
      onSelect: () => choose(null),
    },
    // **A rule is drawn only where there is something on both sides of it.** Three groups can each
    // be empty independently — a reader who has made no folder, a surface that wires no `toDeck`,
    // a reader with no decks — and a separator emitted unconditionally is a stray rule under the
    // root for the first of those and *two adjacent rules* for the third, which reads as a row
    // that failed to render. `separated` is where that is decided once, so a fourth group cannot
    // reintroduce it.
    ...separated([mine, theirs], "collection-sep"),
  ];
}

/**
 * Groups of rows joined by rules, skipping the empty ones — the only thing that decides where a
 * separator goes in a picker whose sections are independently optional.
 *
 * A leading rule is emitted for the *first* non-empty group as well, because every caller here
 * draws a root row above these and that row is always separated from what follows it.
 */
function separated(groups: readonly MenuItem[][], idPrefix: string): MenuItem[] {
  const out: MenuItem[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    out.push({ kind: "separator", id: `${idPrefix}-${out.length}` }, ...group);
  }
  return out;
}

/**
 * The app's own two kinds of folder, drawn **after** the reader's and behind a rule.
 *
 * ## Why they are here at all, having been filtered out for a release
 *
 * `collection_folder_list` answers eleven kinds of place a copy can sit and only one of them is a
 * drawer the reader made. The other two are the ledger — *this deck holds these copies*, *these
 * copies have left the collection* — and a picker that listed only the drawers made the deck
 * groups reachable by drag and by breadcrumb but not by the one gesture a keyboard has. So they
 * appear, and every one of them is **routed to a real write or refused in its own words**.
 *
 * ## The deck rows are not folder writes, and that is the whole design
 *
 * `set_entry_folder` calls `user_folder` on its destination and answers `FOLDER_NOT_YOURS` for a
 * deck group (`src-tauri/src/collection_folders.rs`). It is right to: a copy reaches a group only
 * through `collection_alloc::collection_to_deck`, which writes the `deck_cards` row in the same
 * transaction. A bare folder write would file the copies into the group and leave the deck's list
 * saying nothing about them — a placement with no deck card behind it, which reads to the reader
 * as cards that walked into a deck that does not play them. So `toDeck` hands the caller a
 * **deck id**, not a folder id, and the caller owes it the sanctioned command.
 *
 * **The whole submenu is omitted where there are no deck groups**, which is `deckLevel`'s rule
 * rather than the folder tree's: a `Decks` row that opens onto nothing is a promise with no
 * destination behind it, and a database with no decks has no group to offer.
 *
 * ## A deck the card is not in is greyed, and that is what makes the row `lazy`
 *
 * Issue #358. A deck group means *this deck holds these copies*, so aiming a card at one that the
 * deck does not play would file custody for a card the list says nothing about — the same
 * placement-with-no-deck-card the paragraph above rejects, arrived at from the other end. The
 * fence is therefore the deck's **live list**: {@link useDecksPlaying} answers which decks already
 * play every card this press is about, and a deck outside that set is drawn with a `reason`
 * instead of a destination.
 *
 * **That answer is a backend read, so the row is `kind: "lazy"` rather than `"submenu"`** — this
 * file's opening paragraph, and the rule `MenuLazy` exists for: a right-click on a wall of forty
 * tiles must fire nothing. The census runs when the reader expands `Decks`, which is a deliberate
 * act, exactly as `Add to → Deck`'s own picker does one row up.
 *
 * **A component defined here and threaded through the `app` parameter, rather than injected as a
 * `ComponentType` the way {@link CardMenuDeps.DeckTargetSubmenu} is.** That injection is a fence
 * around a *write*: the deck picker reaches the app's single `useCardToDeck` through a context, so
 * handing the component itself is what stops a surface wiring a callback that quietly never lands.
 * Nothing of that applies here. The write these rows make is already an argument —
 * {@link CardMenuDeps.toDeck}, threaded to `app.toDeck` — and what is new is a *read*, which needs
 * no fence because it fails in the safe direction: a census that never answers greys every row
 * rather than writing anything. What injection would cost is a second `ComponentType` on every
 * `CardMenuDeps` on eight surfaces and in every fixture, to move one hook call across a file
 * boundary this module already stands on both sides of — `DeckTargetSubmenu` and
 * {@link useCardToDeck} are defined *in here*.
 *
 * **Sorted by name**, which is `PinnedFolders.pinnedFolders`' opinion borrowed rather than a
 * second one invented: schema v25 writes `sort_order = 0` on every group it creates, so the
 * backend's `ORDER BY sort_order, id` is deck-**id** order — the order the decks happened to be
 * made in, which no reader can predict or scan. The reader's own tree keeps the backend's order
 * one function up, because there `sort_order` is a field they will one day arrange. Two lists,
 * two different facts about them.
 *
 * ## `Recently removed` is drawn greyed, and it can never become a destination
 *
 * Not "not wired yet" — **unanswerable**. Schema v25 dropped `deck_allocations`, so a collection
 * entry carries no link to a `deck_cards` row; and a deck may hold one printing in two categories
 * since v18. Filing a copy into the holding area by hand would have to decide which of the deck's
 * rows it was cut from, and there is no fact anywhere that answers. The sanctioned route cuts the
 * card in the deck editor, where the reader is looking at the row they mean, and
 * `deck_to_collection` files the copies here on the way out.
 *
 * **Greyed rather than absent**, which is "View all printings"' argument and not the categories
 * menu's: this row is on every card of every collection surface, so leaving it out would read as
 * a menu that forgot a place cards demonstrably go — the reader can see the folder on the page
 * behind the menu. Its `reason` is what turns a dead row into the one sentence that teaches the
 * route, and it is short because a row is as wide as its widest content.
 *
 * It is drawn whenever `toDeck` is given, without looking for a `removed` folder in the list: v25
 * creates exactly one unconditionally, a partial unique index makes a second impossible, and this
 * row names no id anyway — hunting for a row to prove a sentence may be written would make the
 * lesson vanish on the databases that most need it.
 */
function appSection(
  folders: readonly CollectionFolder[],
  app: CollectionAppSection | undefined,
): MenuItem[] {
  if (app === undefined || app.toDeck === undefined) return [];
  const { targets } = app;
  // **Annotated rather than left to the narrowing above**, because the `lazy` body below is a
  // hoisted function declaration: TypeScript analyses one at its own position, where the guard
  // has not run, so a closure over the bare `app.toDeck` is `… | undefined` however plainly it
  // was checked three lines up.
  const toDeck: (deckId: number) => void = app.toDeck;
  // **A `{ deckId, name }` rather than the folder**, so the row below cannot reach `folder.id`:
  // the group's own id is the one number that must never leave this function, and a `flatMap`
  // narrows away the nullable `deckId` where a `filter` would have needed a cast to say the same
  // thing. `CollectionFolder.deckId` is nullable because the other two kinds carry none, and the
  // schema `CHECK` is what makes it non-null on this one.
  const decks = folders
    .flatMap((folder) =>
      folder.kind === DECK_FOLDER_KIND && folder.deckId !== null
        ? // The group's own name rather than one fetched from `decks`: the backend keeps the two
          // in step, and a deck query here would be exactly the fetch-on-open this file's opening
          // paragraph forbids.
          [{ deckId: folder.deckId, name: folder.name }]
        : [],
    );
  // **`sortOptions` and never a bare `localeCompare`** — `src/CLAUDE.md`'s option-list rule, for
  // its reason: that method sorts by whatever locale the runtime happens to be in, and this app
  // pins one `Intl.Collator` to `"en"` so a picker cannot read one way on the developer's machine
  // and another on a reader's. `deckLevel` sorts its own decks through the same call.
  //
  // **These are not exempt the way the reader's own folder tree is.** That tree keeps
  // `buildFolderTree`'s order because somebody arranged it; nobody arranged this list, and its
  // order carries no information — schema v25 writes `sort_order = 0` on every group it creates,
  // so the backend's order is deck-id order, which is the order the decks happened to be made in.
  const ordered = sortOptions(decks, (deck) => deck.name);

  /** The `lazy` row's body, closed over the groups and the cards. Named rather than inline for
   *  `DeckPicker`'s reason: its identity has to hold for the life of the built array, or every
   *  render of the open panel remounts it and asks the census again.
   *
   *  **It takes no `onDone` and calls none.** Every row it draws is an `action`, and `ctx.run`
   *  closes the whole menu before an `onSelect` runs — `onDone` is for a body that finishes
   *  without a row being pressed, which this one cannot do. */
  function DeckGroups() {
    return <DeckGroupRows groups={ordered} targets={targets} toDeck={toDeck} />;
  }

  return [
    ...(ordered.length === 0
      ? []
      : [
          {
            // **`lazy`, not `submenu`** — see this function's doc. The rows are decided by a
            // backend read, and a right-click may fire none.
            kind: "lazy",
            id: "collection-decks",
            label: "Decks",
            // `Layers`, the glyph every deck wears in this file and in the pinned band the
            // reader met these folders in.
            Icon: Layers,
            Content: DeckGroups,
          } satisfies MenuItem,
        ]),
    {
      kind: "action",
      id: "collection-removed",
      label: "Recently removed",
      Icon: Inbox,
      disabled: true,
      reason: "cut the card in its deck to send it here",
      onSelect: () => {},
    },
  ];
}

/**
 * The phrase on a deck the card is not in.
 *
 * **A phrase and not a sentence, because a row is as wide as its widest content** — `MenuAction`'s
 * own rule for `reason`, and the reason `Recently removed`'s is six words rather than the
 * paragraph in {@link appSection}. It says the fact rather than the remedy: the remedy is *add the
 * card to that deck*, which is the row one level up in this very menu, and a picker that spelled
 * it out on every greyed deck would set the width of the panel from the deck the reader is not
 * filing into.
 */
const NOT_PLAYED_REASON = "not in this deck";

/**
 * The rows behind `Decks`, mounted when the reader expands it — one per deck group, greyed unless
 * that deck's live list already plays every card the press is about.
 *
 * ## Every target, never any
 *
 * `rows.length > 1` is a picked set, and a press writes **one add per target**. A deck that plays
 * three of four cards would take the three and refuse the fourth — or, worse, take all four and
 * claim custody the fourth deck card does not back — and the reader would see one press, one menu
 * closing and no complaint anywhere. That is the failure this whole fence exists to prevent, made
 * partial. {@link useDecksPlaying} answers *every* by construction, and the greyed row is what
 * says so before the press rather than after it.
 *
 * ## Fail closed while the census is loading
 *
 * A pending read draws {@link PickerNote}, not a list of rows. The alternative is rows that are
 * each pressable for one frame with `deckIds` still empty — or, if the arms were flipped, live
 * rows that grey underneath the pointer — and either way the reader can land a press on a row
 * whose answer had not arrived. `CollectionPage.tsx`'s `stepperByTile` argues this direction in
 * full for the same class of control: a tile whose rows the wall cannot vouch for gets **no**
 * stepper (`continue`), because a control drawn before its fence is known is a control that
 * writes past it. `DeckTargetSubmenu` one function up already tells "no decks" from "not answered
 * yet" with `isPending` rather than the empty array; this is that rule, with the greying attached.
 */
function DeckGroupRows({
  groups,
  targets,
  toDeck,
}: {
  groups: readonly { deckId: number; name: string }[];
  targets: readonly CardMenuTarget[];
  toDeck: (deckId: number) => void;
}) {
  // The oracle card, or the printing where `cards` has never heard of it — `playKey` mirrors the
  // Rust `coalesce(oracle_id, card_id)` so a deck row and a collection row are matched on the same
  // thing the backend matched them on.
  const keys = useMemo(() => targets.map(playKey), [targets]);
  // **`pending`, never `query.isPending`** — the hook's own note, and the trap it names: TanStack
  // leaves a *disabled* query `status: "pending"` for ever, so the raw flag would draw this note
  // permanently on any surface whose `keys` came back empty. `pending` is false there, `deckIds`
  // is empty, and every deck greys — which is the same fail-closed answer arrived at honestly.
  const { deckIds, pending } = useDecksPlaying(keys);
  if (pending) return <PickerNote>Checking your decks…</PickerNote>;
  return (
    <MenuRows
      items={groups.map(({ deckId, name }): MenuItem => {
        const live = {
          kind: "action",
          // Keyed by the **deck**, which is also what the press hands over — never `folder.id`.
          id: `collection-deck-${deckId}`,
          label: name,
          Icon: Layers,
          onSelect: () => toDeck(deckId),
        } as const;
        return deckIds.has(deckId)
          ? live
          : // Greyed rather than absent, `Recently removed`'s argument one row down: the deck is
            // on the page behind the menu and in the pinned band, so a group that vanished from
            // this list would read as a picker that lost a deck rather than as a fact about the
            // card. `onSelect` is emptied as well as `disabled` set — `ActionRow` already refuses
            // to run a disabled row's handler, and a row that would write if that check ever
            // moved is not a fence.
            { ...live, disabled: true, reason: NOT_PLAYED_REASON, onSelect: () => {} };
      })}
    />
  );
}

function collectionLevel(
  nodes: readonly FolderNode<CollectionFolder>[],
  choose: (folderId: number | null) => void,
): MenuItem[] {
  return nodes.map((node): MenuItem => {
    const { id, name } = node.folder;
    const here = {
      kind: "action",
      id: `collection-folder-${id}`,
      label: name,
      Icon: Folder,
      onSelect: () => choose(id),
    } as const;
    /**
     * **An empty folder is still offered, and this is where `deckLevel` does the opposite.**
     * There a folder is a *container of destinations* — a drawer holding no deck and no drawer
     * with a deck in it opens onto an empty panel, so it is dropped. Here the folder **is** the
     * destination: an empty drawer is where the next card goes, and it is what a reader makes a
     * folder *for*. Dropping it would leave a folder made an hour ago reachable only from the
     * collection page.
     */
    if (node.children.length === 0) return here;
    /**
     * A folder with children draws **its own row first**, then a rule, then them — so a parent is
     * always pickable. `deckLevel`'s submenu holds decks and sub-folders, two different kinds of
     * thing, and the folder itself is not one of them; here the parent and its children are all
     * destinations of the same kind, and a submenu offering only the children would make
     * "Binder" the one folder in the cabinet a card cannot be filed into.
     */
    return {
      kind: "submenu",
      id: `collection-folder-${id}`,
      label: name,
      Icon: Folder,
      items: [
        { ...here, id: `collection-folder-${id}-here` },
        { kind: "separator", id: `collection-folder-${id}-sep` },
        ...collectionLevel(node.children, choose),
      ],
    };
  });
}

/**
 * One deck, and the choice a deck with a theory list forces.
 *
 * A deck that keeps no theory list is a single row that adds to `live` — offering a plan the
 * deck does not have would be a second press for a choice with one answer. A deck that keeps
 * one asks, **Theory then Actual**, and is deliberately not alphabetical: enabling the theory
 * list *moves* the live deck into the plan, so theory is where a deck's cards are and the actual
 * list is the column that fills as the reader acquires them. This is a menu that has to guess
 * which of two lists a card is meant for, and the likelier one goes first.
 *
 * **The editor's variant tabs read the same way again** (2026-08-26) — `Theory | Actual` — but
 * that is a coincidence rather than a dependency, and this order did not follow them there and
 * back. The two are not the same question: a tab strip is two places a reader chooses between
 * and reads left to right, and this is a ranked guess. It went on being ranked while the tabs
 * read the other way round for two days, which is the evidence for saying so.
 *
 * **`Actual` is the label; `live` is still the value** — see the editor's switch, where the
 * choice not to rename the stored variant is argued.
 */
function deckItem(deck: DeckRow, choose: (deckId: number, variant: DeckVariant) => void): MenuItem {
  if (!deck.theoryEnabled) {
    return {
      kind: "action",
      id: `deck-${deck.id}`,
      label: deck.name,
      Icon: Layers,
      onSelect: () => choose(deck.id, "live"),
    };
  }
  return {
    kind: "submenu",
    id: `deck-${deck.id}`,
    label: deck.name,
    Icon: Layers,
    items: [
      {
        kind: "action",
        id: `deck-${deck.id}-theory`,
        label: "Theory",
        onSelect: () => choose(deck.id, "theory"),
      },
      {
        kind: "action",
        id: `deck-${deck.id}-live`,
        label: "Actual",
        onSelect: () => choose(deck.id, "live"),
      },
    ],
  };
}

/**
 * A word where a row would be — the deck list still arriving, or a gallery with nothing in it.
 *
 * The one piece of markup this file still draws inside a menu, and it is a **disabled
 * `menuitem`** rather than a paragraph for two reasons this app's menus give everywhere: a
 * `role="menu"` may only own menu rows, so a bare `<p>` inside one is a string a screen reader is
 * not obliged to announce; and a greyed row exists precisely to be read. `aria-disabled`, never
 * the `disabled` attribute — which is also what keeps the caret off it, since `menuRowsIn`
 * filters on exactly that attribute.
 */
function PickerNote({ children }: { children: string }) {
  return (
    <p role="menuitem" aria-disabled="true" className="px-2 py-1.5 text-sm text-dim">
      {children}
    </p>
  );
}
