import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { ChevronLeft, Trash2 } from "lucide-react";
import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  filterChipState,
  ToggleChip,
} from "@/components/FilterChips";
import { ipcError, type DeckCard } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { PRICES_AS_OF } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { DeckSearchPanel, PANEL_WIDTH_PX } from "./DeckSearchPanel";
import { DeckStats } from "./DeckStats";
import { dropWrite, readDragData, type DeckWrite, type DragPayload } from "./dnd";
import { useDeck } from "./useDeck";
import { useFormatSpecs } from "./useFormatSpecs";
import { ValidationPanel } from "./ValidationPanel";
import { ZoneColumn, type GroupBy } from "./ZoneColumn";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * How wide a column wants to be, and how it gives way.
 *
 * **One width for every column, where there used to be a map keyed by zone.** That map gave the
 * main deck two shares of the spare width against one each for the sideboard, the commander and
 * the companion, and it cannot survive schema v8: a column is now a `deck_categories` row the
 * user named, so there is no closed set of keys to write widths against and no way to know from
 * a category which of them it is. The main deck's own `flex-[2_1_24rem]` is what every column
 * gets — the widest of the five, chosen because a user's category is as likely to be a
 * sixty-card pile as a two-card one, and a column that is too wide wraps while a column that is
 * too narrow truncates the card names it exists to show.
 *
 * The basis is what the columns wrap at rather than what they are: below about 24rem of content
 * the row breaks and each column gets the width to itself, which is how the editor stays
 * readable at 1024px with the card pane docked beside it — and why nothing here ever scrolls
 * sideways.
 */
const COLUMN_WIDTH = "flex-[2_1_24rem]";

/** Stable identity for "this category holds nothing", so an empty column is not handed a fresh
 *  array on every render (`useDeck`'s `NONE`, for its reason). */
const EMPTY: readonly DeckCard[] = [];

/**
 * Narrowest the deck itself may be squeezed to, in px, before the docked search panel gives
 * way to its rail.
 *
 * The same rule the category columns already follow — the narrowest thing yields first — one
 * level up. Three docked columns do not fit in a 1024px window: sidebar, padding, the card pane and
 * the panel come to 1044 before the deck gets a pixel, and the deck was measured at **2px**
 * before this existed, which reads as a rendering fault rather than as a squeeze.
 *
 * 208 rather than the 224 this was first drawn at, and the 16px is a *scrollbar*: the page's
 * own, which the arithmetic did not count. At 1280 with a card open the row measures **617**,
 * not the 632 on paper, so a 224 floor collapsed the panel at the app's default window size —
 * the common case, where a reader clicking a tile to read a card would have lost their search
 * to it. Verified in the running window at every width below.
 *
 * | window | card pane | row | deck | panel |
 * |---|---|---|---|---|
 * | 1024 | closed | 776 | 380 | open |
 * | 1024 | open | 361 | 313 | rail |
 * | 1280 | open | 617 | 221 | open |
 * | 1440 | open | 777 | 381 | open |
 *
 * 208 is also the sidebar's width, which is the app's own evidence that a column this wide is
 * still a column: a category row at 208 keeps its stepper and truncates the card's name.
 */
const DECK_FLOOR = 208;

/** The `gap-3` between the deck and the panel, which the panel's width has to be counted with. */
const PANEL_GAP = 12;

/** The two ways a deck list can be read, and what each is called on the control. */
const GROUPINGS: { id: GroupBy; label: string }[] = [
  { id: "type", label: "Type" },
  { id: "manaValue", label: "Mana value" },
];

/**
 * The dismissible layers this editor *owns*, and it deliberately holds at most one.
 *
 * `useDismissOnEscape` orders exactly two rungs — one capture-phase `"inner"` layer and one
 * bubble-phase `"outer"` one — so two `"inner"` peers open at once are not ordered at all and
 * would both close on a single press. A row's actions menu and the format check are both
 * `"inner"`, so they are modelled as *one* piece of state: "never two" is then structural
 * rather than remembered, and at most one of the two Escape registrations is ever enabled.
 * `DecksPage`'s `Panel` is the same arrangement, for the same reason.
 *
 * **There is a third `"inner"` peer on this screen, and it is not in this union**: the set
 * filter inside the docked search panel (`SetCombobox.tsx:95`, reached through `FilterBar`).
 * It is a whole layer of somebody else's, so the union cannot model it — what keeps it apart
 * from these two is **focus and click mechanics, not structure**. Opening it takes the caret
 * out of whichever of these is up, and both of them close on focus-out; opening either of
 * these takes the caret out of the combobox, which closes on focus-out and on a mousedown
 * outside its root. Pinned both ways by `DeckEditor.test.tsx`'s
 * "never has the set filter and one of the editor's own layers open at once".
 *
 * Mechanics are weaker than structure, and one case survives: `RowMenu`'s `onBlur` skips
 * closing while the write it started is in flight (`ZoneColumn.tsx`, Task 11's binding
 * pattern), so a *refused* menu action leaves the menu open with the caret on `<body>` — and
 * opening the set filter from there has nothing to blur, so both are open and one Escape
 * closes both. Known, accepted, and cheap next to the alternative: dropping that guard would
 * take a menu down as though its refused write had worked.
 *
 * **The card pane docked beside this view carries two more, and they are peers of these**: its
 * printings quick-add popup and its hover preview, both `"inner"`. The popup is kept apart the
 * way the set filter is, by focus — it closes when the caret leaves its root, and every layer
 * here focuses itself on the way up. **The preview genuinely coexists with a row menu**, and
 * that is correct rather than a gap: a pointer wandering off this view onto a printings row
 * moves no focus, so the menu never blurs, and the dwell's own "not over a layer the reader
 * already opened" guard (`PrintingPreview`'s `OPEN_POPUP`) queries *inside the preview's
 * frame*, which is the pane — a menu open out here is not something it can see. Escape then
 * unwinds three rungs in three presses, menu → preview → pane, and only the last of those is
 * ordered by the protocol: the first two are both capture-phase, so what separates them is
 * registration order, and the menu is always the earlier one — reaching the preview means
 * taking the pointer off this view, and bringing it back takes the preview down with the
 * row's own mouse-leave.
 */
type Layer = { kind: "menu"; categoryId: number; cardId: string } | { kind: "check" } | null;

/**
 * One deck, open for editing.
 *
 * The Decks view in its second state rather than a screen of its own — `openDeckId` is the
 * whole of the navigation — and a **view**, not a dismissible layer: Escape closes the menu a
 * row has open and nothing else, and the way out is the back control. The card pane docked
 * beside it by `App` keeps working from in here, which is why a row's click is a store write
 * and nothing more.
 *
 * There is no Save. Every control writes through one of Task 4's commands and the list
 * redraws from what the database answered, which is what spec §7's "autosave drafts" honestly
 * means for a deck: the row *is* the draft.
 */
export function DeckEditor({ deckId }: { deckId: number }) {
  const deck = useDeck(deckId);
  const { specs, formatSpecFor } = useFormatSpecs();
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);
  const openCardFromDeck = useAppStore((s) => s.openCardFromDeck);

  const [groupBy, setGroupBy] = useState<GroupBy>("type");
  const [layer, setLayer] = useState<Layer>(null);
  /**
   * Where the docked panel's adds land. Here rather than in the panel because it is a fact
   * about the deck being edited, and the categories it may take are this editor's own.
   *
   * `0` is the one value that is not a category: `deck_categories.id` is an `INTEGER PRIMARY
   * KEY` and `dnd.ts`'s `isCategoryId` refuses anything but a positive safe integer, so zero
   * is a sentinel meaning "nothing picked yet" that no real category can collide with. The
   * clamp below replaces it on the first render that has a deck.
   */
  const [targetCategoryId, setTargetCategoryId] = useState(0);
  /** What is in the name field while it is being typed in, or `null` when the field is simply
   *  the deck's name (`QuantityStepper`'s draft, for its reason). */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  /**
   * The same draft, readable *now*.
   *
   * Enter commits and then blurs, and the blur handler commits again — in the same tick, with
   * `nameDraft` still holding the closure's value, which is one rename written twice. A ref is
   * cleared where it is read, so the second call has nothing to send.
   */
  const draftRef = useRef<string | null>(null);
  const typeName = useCallback((value: string) => {
    draftRef.current = value;
    setNameDraft(value);
  }, []);
  const dropDraft = useCallback(() => {
    draftRef.current = null;
    setNameDraft(null);
  }, []);

  /**
   * The card a **row** drag is carrying, or `null` when nothing is being dragged out of the
   * deck.
   *
   * Only ever a `deck-card` — `canMonitor` says so — and that is the whole reason this state
   * exists: the remove tray is drawn from it, and a card being dragged *in* from the search
   * panel has nothing to remove. It also keeps a panel drag from re-rendering this editor at
   * all, which is what keeps the tiles' `draggable` registrations still under the reader's
   * pointer while they drag one.
   */
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  /** Whether the card being dragged is over the tray, so the tray can say what letting go
   *  would do. */
  const [overTray, setOverTray] = useState(false);

  const editorRef = useRef<HTMLElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  /** The wrapping row of category columns — the one scroller a drag may have to move to reach
   *  its target, since the four a deck is born with wrap onto a second line well before
   *  1024px, and a deck may own any number of them. */
  const zonesRef = useRef<HTMLDivElement>(null);
  /** The row the deck and the panel share, and the only width either of them can be judged
   *  against — the window's own is three layouts away from it. */
  const deskRef = useRef<HTMLDivElement>(null);
  const [deskWidth, setDeskWidth] = useState(0);
  /** Whatever opened the layer that is up, so Escape can hand the caret back to it. */
  const openerRef = useRef<HTMLButtonElement | null>(null);
  /** The format check's chip, which is what opens the one layer that is not a row's. */
  const chipRef = useRef<HTMLButtonElement>(null);
  /**
   * One per drawn column, so a card that moves takes the caret to where it landed.
   *
   * A `Map` keyed by `deck_categories.id` rather than the `Record` keyed by the five-word zone
   * it replaces: the keys are the user's rows now, so there is no closed set to type a record
   * against, and a deleted category has to be able to leave the map (a `Record` would keep the
   * dead key and a stale element with it).
   */
  const categoryRefs = useRef(new Map<number, HTMLElement | null>());
  const tookFocus = useRef(false);

  const row = deck.deck;
  const spec = row ? formatSpecFor(row.formatKey) : null;
  const loading = deck.query.isPending;
  const readFailure = deck.query.isError ? ipcError(deck.query.error) : null;
  /** The read succeeded and answered nothing: another view deleted this deck. */
  const gone = !loading && !deck.query.isError && deck.query.data === null;

  /** The most recently *started* of a set of writes — which is the one whose refusal is still
   *  news. Ties go to the later entry, which only happens when none of them has ever run. */
  const newest = <T extends { submittedAt: number }>(of: T[]): T =>
    of.reduce((a, b) => (b.submittedAt >= a.submittedAt ? b : a));

  // The three writes the editor's **own banner** speaks for, newest first. The *latest* of them
  // owns it, not whichever is still holding an error: a refused move used to leave its sentence
  // up while the reader went on to rename the deck successfully (the collection table's
  // lesson). The docked panel's add is deliberately not here — it says so in the panel, beside
  // the button that was pressed, and two banners for one refusal would be worse than one in the
  // wrong place.
  const writes = [deck.setQuantity, deck.moveCard, deck.update];
  const lastWrite = newest(writes);
  const writeFailure = lastWrite.isError ? ipcError(lastWrite.error) : null;

  /**
   * Whether the write in flight is one the **open menu** started — the only thing that should
   * grey that menu out or hold it open through a blur.
   *
   * Scoped rather than "any write is running": a rename in the header, or a stepper on a row
   * three lines up, has nothing to do with this menu, and disabling its controls for the
   * duration would make one edit block another for no reason. Read off the mutations' own
   * `variables`, which are the slot each write named.
   */
  const menu = layer?.kind === "menu" ? layer : null;
  const menuBusy =
    menu !== null &&
    ((deck.moveCard.isPending && deck.moveCard.variables?.cardId === menu.cardId) ||
      (deck.update.isPending && deck.update.variables?.coverCardId === menu.cardId));

  /**
   * The deck's rows, filed under the category each is in — a `Map` keyed by
   * `deck_categories.id`, where this used to be a `Record` over the five zone words.
   *
   * Every category the deck has gets an entry, including the ones holding nothing: a column is
   * drawn for a category whether or not anything is in it (that is where the next card goes),
   * and a lookup that answered `undefined` there would make every call site write the same
   * fallback.
   *
   * **Input order is preserved inside each group.** `deck_get` answers in category `sortOrder`,
   * then name, then row id, and `ownedQuantity` is attributed along exactly that order — so a
   * re-sort here would leave the badges attached to the wrong rows and the shortfall marks
   * would lie.
   */
  const byCategory = useMemo(() => {
    const map = new Map<number, DeckCard[]>();
    for (const category of deck.categories) map.set(category.id, []);
    for (const card of deck.cards) {
      const group = map.get(card.categoryId);
      if (group) group.push(card);
      else map.set(card.categoryId, [card]);
    }
    return map;
  }, [deck.cards, deck.categories]);

  /**
   * The columns: **every category the deck has, in `sortOrder`, and nothing else.**
   *
   * There used to be a filter here, driven by the seeded format spec — the sideboard was hidden
   * when `sideboard_max` was 0, the commander column unless `requires_commander`, the companion
   * unless `allows_companion`, each with an exception for a zone that still held cards. That
   * rule made sense while a zone was a slot the *format* implied: hiding one hid nothing the
   * reader had made, and the exception kept a re-format from leaving copies invisible.
   *
   * Schema v8 makes it wrong. A category is a row the user named, ordered and switched on or
   * off, so hiding one would hide a pile they built — and a deck may own any number of `main`
   * ones, which no spec cell has anything to say about. The format still judges the deck (see
   * the check chip in the header); it no longer decides what is drawn.
   */
  const columns = deck.categories;
  /** Where a row can go, and where the search panel can put one: the same list. A column drops
   *  itself from its own menu (`ZoneColumn`), so this needs no per-column narrowing. */
  const moveTargets = deck.categories;

  // The add target has to be a category this deck still has — a category deleted or renamed
  // away under an open editor would otherwise leave the select holding an id that is not in its
  // own options, with every press filing a card somewhere nothing is drawing. Reset during
  // render, which is React's own answer to state that has to follow a prop.
  //
  // The **first** category, not a hard-coded word: there is no `main` to fall back to any more.
  // A deck always has at least the four `PREDEFINED_CATEGORIES` the migration seeds, so the
  // list is only empty while the read is still in flight — and then there is nothing to fall
  // back *to*, so the sentinel stands and the panel below is not drawn at all.
  if (columns.length > 0 && !columns.some((c) => c.id === targetCategoryId)) {
    setTargetCategoryId(columns[0].id);
  }

  // The caret comes here on the way in, once the deck's name is known so the region announces
  // which deck it is. The gallery's New deck button had the caret and unmounts the moment this
  // view takes over, and an element that disappears with focus on it drops it to `<body>`.
  useEffect(() => {
    if (tookFocus.current || loading) return;
    tookFocus.current = true;
    editorRef.current?.focus();
  }, [loading]);

  // How much width the deck and the panel have between them. A window resize changes it, and
  // so does the card pane opening and closing beside the whole view — neither of which this
  // component would otherwise hear about, which is why it is an observer and not a prop
  // (`CardGrid`'s arrangement, for its reason). Re-run when the deck lands, because the element
  // being measured does not exist until then.
  const hasRow = row !== null;
  useEffect(() => {
    const el = deskRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setDeskWidth(entry.contentRect.width));
    observer.observe(el);
    setDeskWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [hasRow]);

  /**
   * Whether the panel may draw itself open, or has to fall back to its rail.
   *
   * `0` is "not measured yet" and reads as room: the first paint of a wide window should not
   * flash a rail, and the observer answers on the same frame.
   */
  const roomForPanel = deskWidth === 0 || deskWidth - (PANEL_WIDTH_PX + PANEL_GAP) >= DECK_FLOOR;

  // A refused write re-reads the deck, and the read is what decides what happened: every write
  // goes through `touch_deck`, which answers "That deck is not there any more" when the deck
  // has been deleted under the reader — so the same refusal is either a busy database (the
  // banner says so, the deck stays) or a deck that is gone (the read answers null and the
  // editor says so). Keyed on `submittedAt` so each new failure re-reads exactly once.
  //
  // **All six writes, banner or no banner.** `add_card` calls `touch_deck` like the rest and
  // `missing_to_wishlist` answers the same `GONE` from its own read, so a press in the docked
  // panel or on the stats strip reaches the same sentence — and without them here that surface
  // would report a deck that is gone while the category columns beside it went on painting it, with
  // every further press failing the same way and nothing on screen explaining why. The family
  // is the point: no refused deck write may leave a dead deck painted.
  //
  // The sixth entry is the one with no control in this view: `swapPrinting` is pressed on the
  // card pane's printings rows, and the pane is a **sibling** of this editor.
  //
  // **It can never fire as the code stands, and that is not an oversight to be tidied away.**
  // Nothing in this tree drives *this* observer — TanStack shares a mutation's state with no
  // other call site, so the pane's press lands in the pane's own copy and this one stays idle
  // for the life of the editor. What actually carries a pane-fired refusal back to these
  // columns is the `onError` invalidation on the mutation's single definition (`useDeck.ts`,
  // where the reasoning is). This entry is the belt to that braces: it costs one array element,
  // it is where an in-editor swap would land the day one is added, and reading it as live GONE
  // coverage would be reading it as something it cannot do today.
  const refetch = deck.query.refetch;
  const lastOfAny = newest([...writes, deck.addCard, deck.missingToWishlist, deck.swapPrinting]);
  const failedAt = lastOfAny.isError ? lastOfAny.submittedAt : 0;
  useEffect(() => {
    if (failedAt) void refetch();
  }, [failedAt, refetch]);

  // Focus first, then close: the trigger is still mounted at this point. This is the
  // **keyboard** way out; the click-away way out is `close` and hands nothing back,
  // because the reader who clicked elsewhere is already somewhere else.
  const dismiss = useCallback(() => {
    openerRef.current?.focus();
    setLayer(null);
  }, []);
  const close = useCallback(() => setLayer(null), []);
  // Only while a row menu is up: the format check owns its own rung and enables it while *it*
  // is open, and the union above is what guarantees the two are never enabled at once.
  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: menu !== null });

  // A deck deleted under an open layer takes the menu's row with it — but not the state that
  // says one is open, and an `"inner"` layer nothing draws is a layer that eats the first
  // Escape of whatever the reader does next. Reset during render, which is React's own answer
  // to state that has to follow a prop (`CardDetailPane`'s face, `Cover`'s art).
  if (gone && layer !== null) setLayer(null);

  const openMenu = useCallback((card: DeckCard, trigger: HTMLButtonElement) => {
    openerRef.current = trigger;
    setLayer((open) =>
      open?.kind === "menu" && open.cardId === card.cardId && open.categoryId === card.categoryId
        ? null
        : { kind: "menu", categoryId: card.categoryId, cardId: card.cardId },
    );
  }, []);

  const openCheck = useCallback(() => {
    openerRef.current = chipRef.current;
    setLayer({ kind: "check" });
  }, []);

  // The three category writes, each addressed by the slot rather than by a `DeckCard` — because
  // that is all a *drop* carries, and a drag and a menu press must not be two ways of writing
  // the same thing. The row controls below hand their own card to the same three.
  //
  // Each takes the mutation's `mutate` rather than the mutation: TanStack hands back a fresh
  // result object on every render, so a callback that depends on the whole thing has a new
  // identity every render — and these three are what the drop targets are registered with, so
  // that would be every category column unregistering and re-registering itself in the middle
  // of a drag. `mutate` is stable for the life of the component, which makes the stability
  // `ZoneColumn.onDropCard` asks for true rather than merely intended.
  const writeQuantity = deck.setQuantity.mutate;
  const writeMove = deck.moveCard.mutate;
  const writeAdd = deck.addCard.mutate;

  const setQuantityAt = useCallback(
    (cardId: string, categoryId: number, quantity: number) => {
      // Zero takes the row out from under the caret — optimistically, so it happens on the
      // press — and the control the caret was on goes with it. The column it left is where the
      // reader is looking and it announces its new count, which is the same hand-off a move
      // makes. Before the write, because the row is gone by the time an answer arrives.
      if (quantity === 0) (categoryRefs.current.get(categoryId) ?? editorRef.current)?.focus();
      writeQuantity({ cardId, categoryId, quantity });
    },
    [writeQuantity],
  );

  const moveTo = useCallback(
    (cardId: string, from: number, to: number) => {
      writeMove(
        { cardId, from, to },
        {
          onSuccess: () => {
            // The row this menu belongs to is about to leave the column, so the caret goes to
            // where the card landed — which announces the category and its new count. The
            // editor itself is the fallback for a column that is not on screen, which since
            // schema v8 means one the deck no longer has rather than a drawer that is shut. A
            // dropped card is handed on the same way: it is the row that unmounts either way,
            // and focus follows the card.
            (categoryRefs.current.get(to) ?? editorRef.current)?.focus();
            setLayer(null);
          },
        },
      );
    },
    [writeMove],
  );

  /** One copy into a category — the panel's Add button's write, and a search tile's drop. */
  const addTo = useCallback(
    (cardId: string, categoryId: number) => writeAdd({ cardId, categoryId, quantity: 1 }),
    [writeAdd],
  );

  const setQuantity = useCallback(
    (card: DeckCard, quantity: number) => setQuantityAt(card.cardId, card.categoryId, quantity),
    [setQuantityAt],
  );

  /**
   * Open a card in the pane **as a deck row** — the only write of `paneDeckContext` in the app,
   * and the reason a category column reports its own id alongside the card.
   *
   * What it buys is on the other side of the app: the pane's printings list gains "Use this
   * printing", which rewrites *this* slot. Everything else that opens a card — the docked
   * panel's tiles, the validation panel's names, the three other views — goes through
   * `setSelectedCardId`, which clears the context in the same write (see the store), so a card
   * that is not a row of this deck can never be shown as one.
   *
   * The context carries the category's **name** as well as its id, because the pane is a
   * sibling of this editor and has no category list to translate one with (see
   * `PaneDeckContext`). This is where both are in hand, so this is where they are read: a
   * column is only ever drawn from `columns`, so the lookup below hits for every click a reader
   * can make, and a miss means the column has left the deck under them — nothing to open.
   */
  const categories = deck.categories;
  const openCard = useCallback(
    (cardId: string, categoryId: number) => {
      const category = categories.find((c) => c.id === categoryId);
      if (!category) return;
      openCardFromDeck({ deckId, categoryId, categoryName: category.name, cardId });
    },
    [categories, deckId, openCardFromDeck],
  );

  const move = useCallback(
    (card: DeckCard, to: number) => moveTo(card.cardId, card.categoryId, to),
    [moveTo],
  );

  /**
   * What a drop writes — the one place the three drags become the three commands.
   *
   * `dnd.ts` decided *what* the drop means and refused the ones that mean nothing; this
   * decides nothing at all, which is why the rule can be tested without a browser and this
   * can be read in one breath. Every branch is a write the editor already had: a drag adds
   * nothing to what a reader can do, only to how fast they can do it.
   */
  const applyDrop = useCallback(
    (write: DeckWrite) => {
      if (write.write === "add") addTo(write.cardId, write.categoryId);
      else if (write.write === "move") moveTo(write.cardId, write.from, write.to);
      else setQuantityAt(write.cardId, write.categoryId, 0);
    },
    [addTo, moveTo, setQuantityAt],
  );

  // What is being dragged out of the deck, for as long as it is. `canMonitor` narrows this to
  // rows: a tile dragged in from the panel is not something the tray can take, and a monitor
  // that answered for it would re-render the panel — and with it the tile the reader has hold
  // of — in the middle of the drag.
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => readDragData(source.data)?.kind === "deck-card",
        onDragStart: ({ source }) => setDragging(readDragData(source.data)),
        // Dropped, or cancelled with Escape: the platform's own way out of a drag ends in the
        // same event, so the tray goes away either way without this view hearing a keypress.
        onDrop: () => {
          setDragging(null);
          setOverTray(false);
        },
      }),
    [],
  );

  // The tray, while it exists. Registered from an effect that re-runs when it mounts, because
  // it only exists during a drag — a drop target added mid-drag is picked up on the next
  // `dragover`, which is how a tray that appears on `dragstart` can be dropped on at all.
  const trayShown = dragging !== null;
  useEffect(() => {
    const element = trayRef.current;
    if (!element) return;
    const writeFor = (data: Record<string, unknown>) => {
      const payload = readDragData(data);
      return payload && dropWrite(payload, { kind: "remove" });
    };
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => writeFor(source.data) !== null,
      onDragEnter: () => setOverTray(true),
      onDragLeave: () => setOverTray(false),
      onDrop: ({ source }) => {
        setOverTray(false);
        const write = writeFor(source.data);
        if (write) applyDrop(write);
      },
    });
  }, [trayShown, applyDrop]);

  // The four columns a deck is born with wrap onto a second line long before the 1024px floor,
  // and a deck may own any number of categories — so a column can be off the bottom of its own
  // scroller while a card is in the air over it. This scrolls it into reach when the drag nears
  // the edge — the one motion in this view, and the platform's own idea of a drag rather than
  // the app's.
  useEffect(() => {
    const element = zonesRef.current;
    if (!element) return;
    return autoScrollForElements({ element });
  }, [hasRow]);

  const setCover = useCallback(
    (card: DeckCard) => {
      deck.update.mutate(
        { coverCardId: card.cardId },
        {
          onSuccess: () => {
            openerRef.current?.focus();
            setLayer(null);
          },
        },
      );
    },
    [deck.update],
  );

  /** Whatever is half-typed, the field goes back to standing for the deck's name. A blank is
   *  not a rename: the backend refuses it in words, and a name is not something a deck can
   *  lose by tabbing through it. */
  const commitName = useCallback(() => {
    const draft = draftRef.current;
    dropDraft();
    if (draft === null || row === null) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === row.name) return;
    deck.update.mutate({ name: trimmed });
  }, [deck.update, dropDraft, row]);

  /** The picker, plus the deck's own format when the seed no longer offers it — a select that
   *  cannot show its own value would silently re-format the deck on the first other change. */
  const formats = useMemo(() => {
    const picker = specs
      .filter((s) => s.enabledInPicker)
      .map((s) => ({ key: s.key, name: s.displayName }));
    if (!row || picker.some((f) => f.key === row.formatKey)) return picker;
    return [{ key: row.formatKey, name: row.formatName ?? row.formatKey }, ...picker];
  }, [specs, row]);

  return (
    <section
      ref={editorRef}
      tabIndex={-1}
      aria-label={row ? `Deck editor: ${row.name}` : "Deck editor"}
      className={cn("flex h-full min-h-0 flex-col gap-3", FOCUS)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={() => setOpenDeckId(null)}
          aria-label="Back to decks"
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Decks
        </button>

        {row && (
          <>
            {/* The document's heading for this state of the view. Drawn as the field beside it
                rather than twice — the ribbon's `h1` says "Decks", and this says which one. */}
            <h2 className="sr-only">{row.name}</h2>
            <input
              aria-label="Deck name"
              value={nameDraft ?? row.name}
              onChange={(e) => typeName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitName();
                  e.currentTarget.blur();
                }
                // **Only when there is something to revert.** Escape consumed here is Escape
                // the card pane never sees — the pane is an `"outer"` layer listening on
                // `window` in the bubble phase, and a handler at the event's own target has
                // already run by then. A field nobody has typed in has nothing to undo, so the
                // press belongs to whatever is open behind it; a field that has been typed in
                // owns exactly one press, and the next one is the pane's again.
                // The ref rather than the state, for the reason it exists: two presses inside
                // one tick — a key held down, an autorepeat — both read a `nameDraft` that
                // React has not re-rendered yet, and the second would consume a press it has
                // nothing to spend it on. The ref is cleared where it is read.
                if (e.key === "Escape" && draftRef.current !== null) {
                  e.preventDefault();
                  dropDraft();
                }
              }}
              // Geist, not the display face, for the reason the card pane gives about a card's
              // name: this is *content*, and Cinzel is for view titles and hero copy. Cinzel is
              // also drawn in caps — which in a field you type into means the letters never
              // match the ones being typed.
              // The shared focus recipe, like every other control in the app: an outline says
              // focus, a border or a ring says state. The border here is the hover affordance
              // that says the title is a field at all.
              className={cn(
                "min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1",
                "text-xl font-medium leading-tight",
                "transition-colors duration-150 hover:border-border motion-reduce:transition-none",
                FOCUS,
              )}
            />
          </>
        )}
      </div>

      {row && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            // "Deck format", not "Format": the docked search panel offers a format *filter*
            // of its own, and two controls called Format in one view are two controls a
            // screen reader — and a test — cannot tell apart. Named like the field beside it
            // ("Deck name"), which is what it belongs to.
            aria-label="Deck format"
            value={row.formatKey}
            onChange={(e) => deck.update.mutate({ formatKey: e.target.value })}
            disabled={formats.length === 0}
            className={cn(FILTER_CONTROL, FILTER_FOCUS, "border-border bg-surface px-2 text-dim")}
          >
            {formats.map((f) => (
              <option key={f.key} value={f.key}>
                {f.name}
              </option>
            ))}
          </select>

          {/* The one switch with a consequence outside this deck, so it says what it does: a
              built deck's claims come off what every other deck can reach. */}
          <ToggleChip
            label="Built"
            pressed={row.isBuilt}
            hint="Reserves your copies for this deck"
            onClick={() => deck.update.mutate({ isBuilt: !row.isBuilt })}
          />

          {/* What the rules make of the deck, in the ribbon of chips that governs it — and
              nothing at all while the seeded rules are not in hand. A format the seed no
              longer carries has no rules to judge against, and a chip that said "No issues"
              because nothing was checked would be the one sentence this panel must never
              write. */}
          {spec && (
            <ValidationPanel
              cards={deck.cards}
              spec={spec}
              open={layer?.kind === "check"}
              buttonRef={chipRef}
              onOpen={openCheck}
              onDismiss={dismiss}
              onClose={close}
              onSelectCard={setSelectedCardId}
            />
          )}

          <div role="group" aria-label="Group cards by" className="ml-auto flex gap-1">
            {GROUPINGS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setGroupBy(id)}
                aria-pressed={groupBy === id}
                className={cn(
                  FILTER_CONTROL,
                  FILTER_FOCUS,
                  "px-3",
                  filterChipState(groupBy === id),
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* What the deck adds up to, over the same rows the columns are drawn from — one query,
          so a curve and a legality panel can never disagree. A *block* rather than a strip:
          four charts and a figure row do not fit on one line at the widths this editor is read
          at, and the direction's floor is a chart whose numbers are legible, not a chart that
          fits. It is `shrink-0`, so the columns below give way to it rather than the other way
          around — the block is a fixed ~150px and a column that lost 150px is still a column. */}
      {row && <DeckStats cards={deck.cards} send={deck.missingToWishlist} />}

      {writeFailure && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          Could not change this deck — {writeFailure}
        </p>
      )}

      {loading && (
        <p role="status" className="py-16 text-center text-sm text-dim">
          Opening your deck…
        </p>
      )}

      {readFailure && (
        <p role="alert" className="py-16 text-center text-sm text-destructive">
          Could not open this deck — {readFailure}
        </p>
      )}

      {gone && (
        <p className="mx-auto max-w-prose py-16 text-center text-sm text-dim">
          This deck is not there any more. It may have been deleted from the gallery — go back and
          pick another one.
        </p>
      )}

      {row && (
        // The deck on the left, the way cards get into it on the right (spec §7). One flex
        // row, so the panel is the full height of the editor and the columns keep whatever is
        // left — and `min-w-0` on the deck side, because a wrapping row of columns that
        // cannot shrink is the horizontal scrollbar the 1024px floor forbids.
        //
        // This element is also what `DECK_FLOOR` is measured against: it is the width the two
        // of them actually have, after the sidebar, the page padding and the card pane have
        // taken theirs.
        <div ref={deskRef} className="flex min-h-0 flex-1 gap-3">
          {/* One row of columns, and nothing under it.
              **The scratchpad drawer is gone**, with its `showMaybe` toggle and the two
              hand-offs that opened it (a move into the pile, and picking it as the add target).
              It was a disclosure under the deck because `maybe` was the one zone that counted
              toward nothing — so it was kept out of the way and out of the arithmetic. Schema
              v8 moves that fact onto `deck_categories.is_active`, where any category can carry
              it: the Maybeboard is one seeded row that happens to start switched off, a pile
              the user switches off behaves identically, and a Maybeboard they switch on counts
              like anything else. A drawer for one of them would be chrome attached to a word
              rather than to what the word used to mean. It is drawn in this row, in its own
              `sortOrder` position, like every other category. */}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div ref={zonesRef} className="flex min-h-0 flex-1 flex-wrap gap-3 overflow-y-auto">
              {columns.map((category) => (
                <ZoneColumn
                  key={category.id}
                  // Deleted rather than set to `null` on the way out, so a category that has
                  // left the deck leaves the map with it — a `Record` keyed by five fixed words
                  // never had to.
                  ref={(el) => {
                    if (el) categoryRefs.current.set(category.id, el);
                    else categoryRefs.current.delete(category.id);
                  }}
                  category={category}
                  cards={byCategory.get(category.id) ?? EMPTY}
                  // The compact roles hold one card or two, and a "Creature 1" heading over a
                  // single commander is a heading that says nothing. Read off the category's
                  // **kind**, which is the fixed word those two roles are still named by — not
                  // off its name, which is the user's and can be anything.
                  groupBy={
                    category.kind === "commander" || category.kind === "companion" ? null : groupBy
                  }
                  moveTargets={moveTargets}
                  openMenuCardId={menu?.categoryId === category.id ? menu.cardId : null}
                  busy={menuBusy}
                  onOpenMenu={openMenu}
                  onCloseMenu={close}
                  onSetQuantity={setQuantity}
                  onMove={move}
                  onSetCover={setCover}
                  onSelect={openCard}
                  onDropCard={applyDrop}
                  // `max-h-full` is what makes a column scroll rather than the editor: in a
                  // *wrapping* flex row, `align-items: stretch` stretches an item to its line's
                  // cross size — which is the tallest item's content — and never to the
                  // container. Without the cap, a 60-card main deck makes the whole row of
                  // columns as tall as itself and takes the sideboard off the bottom of the
                  // window with it.
                  className={cn("min-h-48 max-h-full", COLUMN_WIDTH)}
                />
              ))}
            </div>
          </div>

          <DeckSearchPanel
            add={deck.addCard}
            categories={moveTargets}
            targetCategoryId={targetCategoryId}
            onTargetCategoryChange={setTargetCategoryId}
            roomy={roomForPanel}
          />
        </div>
      )}

      {/* The strip under the deck. Spec §5: a price is never shown without saying how old it
          is — once, here, rather than as a tooltip on every one of sixty rows. And, while a
          row is in the air, the way out of the deck, drawn over it. */}
      <div className="relative shrink-0">
        <p className="text-[0.7rem] text-dim">{PRICES_AS_OF}</p>

        {dragging && (
          // The way out of a deck, for a hand that is already holding the card. It exists
          // only while a row is in the air, and it takes the place of the price line rather
          // than a place of its own: appearing in the flow would push every column up by its
          // own height at the exact moment the reader is aiming at one.
          //
          // **Exactly the strip and not a pixel more.** `-top-3` is the `gap-3` above this
          // line, which is empty; the height is whatever the price line is. A tray taller
          // than that overhangs the columns, and an overhang here is a drop aimed at a
          // column's last row that removes the card instead — the one mistake in this view
          // with nothing to undo it.
          //
          // No transition on either state — it appears instantly and it answers instantly. An
          // affordance that fades in during a drag is an affordance that is still arriving
          // when the reader has let go, and the motion budget spends its 150ms on chip and
          // nav state.
          //
          // Destructive rather than gold: gold is where a card is *going*, and this is the one
          // drop that takes something away. It names the card once it has it, because by then
          // the platform's drag preview is the only other thing saying which card this is.
          //
          // `aria-hidden` like the drop line: this is chrome for a gesture only a pointer can
          // make, and the click paths it shortcuts (the stepper's zero) are the ones a screen
          // reader is given.
          <div
            ref={trayRef}
            aria-hidden="true"
            className={cn(
              "absolute inset-x-0 bottom-0 -top-3 flex items-center justify-center gap-1.5",
              "rounded-md border border-dashed text-xs",
              // Above the popups rather than among them: a drag can start while a column's
              // menu is open, and this is the target the pointer is being carried to.
              LAYER.dragTray,
              overTray
                ? "border-destructive/60 bg-destructive/10 text-destructive"
                : "border-border bg-surface text-dim",
            )}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            {overTray ? `Remove ${dragging.name} from deck` : "Remove from deck"}
          </div>
        )}
      </div>
    </section>
  );
}
