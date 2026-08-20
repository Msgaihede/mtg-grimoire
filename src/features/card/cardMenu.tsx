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
  Heart,
  Image as ImageIcon,
  Images,
  Layers,
  LibraryBig,
  Plus,
} from "lucide-react";
import { MenuRows } from "@/components/menu/ContextMenu";
import type { MenuAction, MenuItem } from "@/components/menu/types";
import { buildFolderTree, type FolderNode } from "@/features/decks/folders";
import { DEFAULT_VARIANT, useDeck } from "@/features/decks/useDeck";
import { useDeckFolders } from "@/features/decks/useDeckFolders";
import { useDecks } from "@/features/decks/useDecks";
import { copyText } from "@/lib/clipboard";
import { marketplaceSearchUrl, openExternal, scryfallCardUrl } from "@/lib/externalLinks";
import { FINISH_LABEL, parseFinishes, type Finish } from "@/lib/finish";
import { ipc, ipcError, type DeckFolder, type DeckRow, type DeckVariant } from "@/lib/ipc";
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
  addToCollection: (target: CardMenuTarget, finish: Finish) => void;
  addToWishlist: (target: CardMenuTarget) => void;
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
  DeckTargetSubmenu: ComponentType<{ target: CardMenuTarget; onDone: () => void }>;
}

/**
 * The image size a reader means by "the card image": the same `display` variant the card pane
 * draws, which is Scryfall's `normal` — big enough to read, small enough to paste.
 */
const COPIED_IMAGE_VARIANT = "display" as const;

export function buildCardMenu(target: CardMenuTarget, deps: CardMenuDeps): MenuItem[] {
  const { marketplace, DeckTargetSubmenu } = deps;

  /** The `lazy` row's component, closed over the card. Named rather than inline so its identity
   *  is stable for the life of the built array, which is what keeps React from remounting the
   *  picker — and re-reading the deck list — on every render of the open panel. */
  function DeckPicker({ onDone }: { onDone: () => void }) {
    return <DeckTargetSubmenu target={target} onDone={onDone} />;
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
      label: "Add to",
      Icon: Plus,
      items: [
        collectionItem(target, deps.addToCollection),
        {
          kind: "action",
          id: "add-wishlist",
          label: "Wishlist",
          Icon: Heart,
          onSelect: () => deps.addToWishlist(target),
        },
        // `lazy` and not `submenu`: the folder tree and the deck list are two queries, and a
        // right-click on a card in a wall of forty must not fire either of them.
        { kind: "lazy", id: "add-deck", label: "Deck", Icon: Layers, Content: DeckPicker },
      ],
    },
  ];
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
  addToCollection: (target: CardMenuTarget, finish: Finish) => void,
): MenuItem {
  const named = target.finish;
  if (named !== undefined) {
    return collectionRow(() => addToCollection(target, named));
  }
  const choices = finishChoices(target.finishes);
  if (choices.length === 1) {
    return collectionRow(() => addToCollection(target, choices[0]));
  }
  return {
    kind: "submenu",
    id: "add-collection",
    label: "Collection",
    Icon: LibraryBig,
    items: choices.map((finish) => ({
      kind: "action",
      id: `add-collection-${finish}`,
      label: FINISH_LABEL[finish],
      onSelect: () => addToCollection(target, finish),
    })),
  };
}

function collectionRow(onSelect: () => void): MenuAction {
  return { kind: "action", id: "add-collection", label: "Collection", Icon: LibraryBig, onSelect };
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
export function DeckTargetSubmenu(props: { target: CardMenuTarget; onDone: () => void }) {
  const { target } = props;
  const addToDeck = useAddCardToDeck();
  const { decks, query: deckQuery } = useDecks();
  const { folders, query: folderQuery } = useDeckFolders();

  const items = useMemo(
    () =>
      buildDeckTargetItems(folders, decks, (deckId, variant) => addToDeck(target, deckId, variant)),
    [folders, decks, addToDeck, target],
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
 * One deck, and the choice a deck with a theory list forces.
 *
 * A deck that keeps no theory list is a single row that adds to `live` — offering a plan the
 * deck does not have would be a second press for a choice with one answer. A deck that keeps
 * one asks, **Theory then Live**, which is the order the editor's own variant tabs read in and
 * is deliberately not alphabetical: enabling the theory list *moves* the live deck into the
 * plan, so theory is where a deck's cards are and live is the column that fills as the reader
 * acquires them. Reading plan → reality is the direction the difference readout counts in.
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
        label: "Live",
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
