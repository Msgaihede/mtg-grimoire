/**
 * What a card offers on a right-click, anywhere it is drawn.
 *
 * **A pure builder, and its dependencies are an argument.** Ten surfaces call it — the two
 * search views, the two collection views, the wishlist, four deck editor views, the docked
 * panel, the card pane and the printings list — and each has its own writes, its own
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
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  ChevronRight,
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
import type { MenuAction, MenuItem } from "@/components/menu/types";
import { buildFolderTree, type FolderNode } from "@/features/decks/FolderTree";
import { DEFAULT_VARIANT, useDeck } from "@/features/decks/useDeck";
import { useDeckFolders } from "@/features/decks/useDeckFolders";
import { useDecks } from "@/features/decks/useDecks";
import { copyText } from "@/lib/clipboard";
import { marketplaceSearchUrl, openExternal, scryfallCardUrl } from "@/lib/externalLinks";
import { FINISH_LABEL, parseFinishes, type Finish } from "@/lib/finish";
import { ipc, type DeckFolder, type DeckRow, type DeckVariant } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { sortOptions } from "@/lib/options";
import { cn } from "@/lib/utils";

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
   * The card's own `type_line`, where the surface has one — the **fallback** half of
   * `autoCategoryFor`, exactly as the four drag sources carry it.
   *
   * Optional because two of the surfaces genuinely have none: a `Printing` row says what a
   * printing *is* and never what the card does, and neither does a wishlist row. Absent and
   * `null` are the same answer here and both reach `useDeck.addCard` as `null`, which is the
   * arm that consults the card's Oracle tags — **not** the arm that files everything under
   * `DEFAULT_CATEGORY_NAME` without asking. Sending nothing at all would take the rule off a
   * menu add that a drag of the same card gets.
   */
  typeLine?: string | null;
}

/** Everything the card menu needs that is not the card. Built once per surface, not per row. */
export interface CardMenuDeps {
  marketplace: Marketplace;
  addToCollection: (target: CardMenuTarget, finish: Finish) => void;
  addToWishlist: (target: CardMenuTarget) => void;
  /** Null outside the deck editor: inside it, the item opens the card pane instead. */
  viewPrintingsInPane: ((cardId: string) => void) | null;
  requestAllPrintings: (t: { oracleId: string; name: string }) => void;
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
 * "View all printings", and the two places it can land.
 *
 * Inside the deck editor it opens the **card pane**, because `requestAllPrintings` moves
 * `activeView` in the same write and `setActiveView` clears `openDeckId` by design — routing
 * to Search there would close the deck the reader is building out from under them.
 *
 * `oracleId` is nullable on `CardSummary`, which is a fence around the type rather than a card
 * anyone can find (0 of 116 590 live rows are null, reversible printings included, because
 * `card_row` falls back to `card_faces[0]`). So the item is **drawn and disabled with a
 * reason** rather than hidden or crashed on: a greyed row that says why is the answer this
 * app's menus give everywhere else.
 */
function printingsItem(target: CardMenuTarget, deps: CardMenuDeps): MenuAction {
  const { oracleId } = target;
  if (oracleId === null) {
    return {
      kind: "action",
      id: "printings",
      label: "View all printings",
      Icon: Images,
      disabled: true,
      reason: "this printing has left the card database",
      onSelect: () => {},
    };
  }
  return {
    kind: "action",
    id: "printings",
    label: "View all printings",
    Icon: Images,
    onSelect: () => {
      if (deps.viewPrintingsInPane !== null) deps.viewPrintingsInPane(target.cardId);
      else deps.requestAllPrintings({ oracleId, name: target.name });
    },
  };
}

/**
 * Which finish an "Add to collection" records, and whether the reader is asked.
 *
 * A collection row's identity includes its finish, so one has to be chosen. The surface's own
 * wins where it has one (a collection row *is* a finish; a wishlist row may prefer one).
 * Where it has none — a search tile, a deck card, a printings row, because **a deck names a
 * printing and not a finish** — the printing's own list decides: one finish is no question and
 * adds silently, two or more is a submenu.
 *
 * `finishes` is `null` when the column is empty, which is **unknown** rather than "no
 * finishes". Nonfoil is the answer there, because it is the answer for all but a handful of
 * printings and because refusing to add a card over a missing column would be worse.
 *
 * The finishes are offered in the **printing's own order**, which is Scryfall's and is the
 * order `FINISHES` is written in — nonfoil, foil, etched. That is the third exemption from
 * `sortOptions` for the same reason the condition grade is one: the order carries the
 * information (plain, then the two premium treatments), and alphabetising it would draw
 * "Etched, Foil, Nonfoil" over a picker whose whole job is to be read at a glance.
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
 */
export function DeckTargetSubmenu({
  target,
  onDone,
}: {
  target: CardMenuTarget;
  onDone: () => void;
}) {
  const { decks, query: deckQuery } = useDecks();
  const { folders, query: folderQuery } = useDeckFolders();
  /** The leaf the reader pressed. Setting it is what mounts the deck's own hook below. */
  const [pending, setPending] = useState<{ deckId: number; variant: DeckVariant } | null>(null);

  /**
   * **One `useDeck`, mounted on the press rather than on the row**, because `useDeck` is the
   * single definition of the add rule *and* it carries the deck's own `deck_get`. A hook per
   * deck row would read every deck in the gallery to offer a menu; `null` until a leaf is taken
   * leaves the query disabled, and the one read that does happen is for the deck the card is
   * going into.
   */
  const { addCard } = useDeck(pending?.deckId ?? null, pending?.variant ?? DEFAULT_VARIANT);
  const add = addCard.mutate;
  /**
   * Which leaf has already been written, so the add happens exactly once.
   *
   * Load-bearing under `StrictMode`, which mounts an effect twice on purpose — without it a
   * single press would put two copies in the deck in development and one in the shipped
   * window, which is the worst shape a bug can have.
   */
  const written = useRef<string | null>(null);

  useEffect(() => {
    if (pending === null) return;
    const key = `${pending.deckId}:${pending.variant}`;
    if (written.current === key) return;
    written.current = key;
    /**
     * **No `categoryId`, so `autoCategoryFor` files the card by what it does** — the app's one
     * rule, shared by a plain add, a drag with no column under it and an imported line. The
     * type line travels as the fallback (`null` where the surface has none); it is deliberately
     * not *absent*, which is the arm that files everything under `DEFAULT_CATEGORY_NAME`
     * without consulting the card at all.
     */
    add({ cardId: target.cardId, typeLine: target.typeLine ?? null, quantity: 1 });
    onDone();
  }, [pending, add, onDone, target.cardId, target.typeLine]);

  const items = useMemo(
    () =>
      buildDeckTargetItems(folders, decks, (deckId, variant) => setPending({ deckId, variant })),
    [folders, decks],
  );

  if (pending !== null) return <PickerNote>Adding…</PickerNote>;
  // A gallery with nothing in it and a gallery that has not answered yet are told apart by
  // `isPending`, never by the empty array — both hooks say so on their own `decks`/`folders`.
  if (deckQuery.isPending || folderQuery.isPending) return <PickerNote>Loading decks…</PickerNote>;
  if (items.length === 0) return <PickerNote>No decks</PickerNote>;
  return <PickerRows items={items} depth={0} />;
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
 * Folders and decks each go through `sortOptions`, folders first: a filing cabinet lists its
 * drawers before its loose files, and within each half the reader looks a name up
 * alphabetically. A folder holding neither a deck nor a folder with a deck in it is dropped —
 * an empty submenu is a row that opens onto nothing.
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
  const drawers = sortOptions(nodes, (node) => node.folder.name).flatMap((node) => {
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
 * The picker's own rows, drawn inside the panel the `lazy` row opened.
 *
 * **Indented disclosures rather than a second cascade.** The panel owns the cascade, and a
 * lazy row's content is the *inside* of one child panel — so a folder here opens downward, in
 * place, the way the gallery's own filing cabinet indents rather than flying out. It is also
 * what keeps a four-deep path (folder → subfolder → deck → list) reachable without four
 * panels chasing each other off the edge of a 1280px window.
 *
 * The indent is an **inline style**: Tailwind scans source text for whole class names, so
 * `pl-[${n}px]` built by interpolation emits no rule at all.
 */
function PickerRows({ items, depth }: { items: readonly MenuItem[]; depth: number }) {
  return (
    <>
      {items.map((item) => (
        <PickerRow key={item.id} item={item} depth={depth} />
      ))}
    </>
  );
}

const PICKER_INDENT_STEP = 12;

/**
 * The focus ring written out rather than imported from `features/decks/cardControl`, which is
 * where the app's `FOCUS_INSET` lives: that module's subject is a deck card drawn as a control
 * and it pulls in the drag machinery with it, which a menu row has no business importing. Every
 * other surface here spells the same three utilities out for the same reason.
 */
const PICKER_ROW = cn(
  "flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm text-text",
  "transition-colors duration-150 hover:bg-bg motion-reduce:transition-none",
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
);

function PickerRow({ item, depth }: { item: MenuItem; depth: number }) {
  const [open, setOpen] = useState(false);
  const indent = { paddingLeft: 8 + depth * PICKER_INDENT_STEP };

  switch (item.kind) {
    case "submenu": {
      const Icon = item.Icon;
      return (
        <>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            // `aria-expanded` and deliberately **no `aria-haspopup`**: this row does not open a
            // popup, it unfolds its own children into the panel it is already in.
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
            className={PICKER_ROW}
            style={indent}
          >
            {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <ChevronRight
              className={cn(
                "size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
              aria-hidden
            />
          </button>
          {open ? <PickerRows items={item.items} depth={depth + 1} /> : null}
        </>
      );
    }
    case "action": {
      const Icon = item.Icon;
      return (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          // `aria-disabled`, never the `disabled` attribute: a greyed row exists to be read, so
          // it stays in the tab order.
          aria-disabled={item.disabled === true || undefined}
          onClick={() => {
            if (item.disabled !== true) item.onSelect();
          }}
          className={cn(PICKER_ROW, item.disabled === true && "cursor-default text-dim")}
          style={indent}
        >
          {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.reason ? <span className="text-dim">{item.reason}</span> : null}
        </button>
      );
    }
    default:
      // The picker builds actions and submenus and nothing else. A radio, a separator or a
      // nested `lazy` row belongs to the panel's own renderer, which is what draws the menu
      // this content sits inside.
      return null;
  }
}

/**
 * A word where a row would be — loading, empty, or the beat between the press and the close.
 *
 * A **disabled `menuitem`** rather than a paragraph, for the two reasons this app's menus give
 * everywhere: a `role="menu"` may only hold menu rows, so a bare `<p>` inside one is a string a
 * screen reader is not obliged to announce; and a greyed row exists precisely to be read.
 * `aria-disabled`, never the `disabled` attribute.
 */
function PickerNote({ children }: { children: string }) {
  return (
    <p role="menuitem" aria-disabled="true" className="px-2 py-1.5 text-sm text-dim">
      {children}
    </p>
  );
}
