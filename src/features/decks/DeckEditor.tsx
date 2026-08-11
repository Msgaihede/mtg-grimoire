import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  filterChipState,
  ToggleChip,
} from "@/components/FilterChips";
import { ipc, ipcError, type DeckCard, type DeckVariant } from "@/lib/ipc";
import { PRICES_AS_OF } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AuditDrawer } from "./AuditDrawer";
import { CategoriesPanel } from "./CategoriesPanel";
import { DeckSearchPanel, PANEL_WIDTH_PX } from "./DeckSearchPanel";
import { DeckSettingsDialog } from "./DeckSettingsDialog";
import { DeckStats } from "./DeckStats";
import { dropWrite, readDragData, type DeckWrite } from "./dnd";
import { buildGroups, GROUP_BY_OPTIONS, type GroupBy } from "./grouping";
import { SORT_OPTIONS, type SortBy } from "./sorting";
import { TheoryDiffDialog } from "./TheoryDiffDialog";
import { useDeck } from "./useDeck";
import { useFormatSpecs } from "./useFormatSpecs";
import { ValidationPanel } from "./ValidationPanel";
import { validateDeck } from "./validation/engine";
import { violationsByCard } from "./violations";
import { GridView } from "./views/GridView";
import { StackView } from "./views/StackView";
import { TableView } from "./views/TableView";
import { TextView } from "./views/TextView";

/** The shared focus recipe: a gold outline standing off the control, never a ring. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** A header/toolbar control that is not a chip: a select, a field, a plain press. 32px, so the
 *  two rows read as rows rather than as a pile of differently sized boxes. */
const CONTROL =
  "h-8 rounded-md border border-border bg-surface px-2 text-xs text-dim " +
  "transition-colors duration-150 motion-reduce:transition-none";

/**
 * Narrowest the deck itself may be squeezed to, in px, before the docked search panel gives
 * way to its rail.
 *
 * The rule is "the narrowest thing yields first", one level up from the views, which scroll.
 * Three docked columns do not fit in a 1024px window: sidebar, padding, the card pane and the
 * panel come to 1044 before the deck gets a pixel, and the deck was measured at **2px** before
 * this existed, which reads as a rendering fault rather than as a squeeze.
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
 * still a column.
 *
 * **The stats aside is counted with the panel now**, which is the one thing about this that the
 * rebuild changed. The desk row holds three things where it used to hold two — the view, the
 * stats block and the search panel — and the stats block is a *reader's* toggle rather than a
 * measurement, so it is subtracted before the panel is asked whether it fits. Open Stats in a
 * 1280 window with a card pane docked and the panel goes to its rail; close either and it comes
 * back, because nothing here records an intention it cannot honour.
 */
const DECK_FLOOR = 208;

/** The `gap-4` between the three things on the desk, which each of their widths has to be
 *  counted with. */
const DESK_GAP = 16;

/** How wide the stats aside is, off the design canvas: 280px, which fits the figure row two up
 *  and the curve's nine bars without any of them becoming a texture. */
const STATS_WIDTH_PX = 280;
const STATS_WIDTH = "w-70";

/** Stable identity for "no tag filter", so the memo below does not re-run on every render. */
const NO_TAGS: readonly number[] = [];

/** How a deck is drawn, and what the switch calls each one. */
type DeckView = "stacks" | "table" | "text" | "grid";
const VIEWS: readonly { id: DeckView; label: string }[] = [
  { id: "stacks", label: "Stacks" },
  { id: "table", label: "Table" },
  { id: "text", label: "Text" },
  { id: "grid", label: "Grid" },
];

/**
 * The dismissible layers this editor *owns*, and it deliberately holds at most one.
 *
 * `useDismissOnEscape` orders exactly two rungs — one capture-phase `"inner"` layer and one
 * bubble-phase `"outer"` one — so two `"inner"` peers open at once are not ordered at all and
 * would both close on a single press. Every member below registers that same `"inner"` rung
 * from inside its own component, so they are modelled as *one* piece of state: "never two" is
 * then structural rather than remembered, and at most one of the five registrations is ever
 * enabled. `DecksPage`'s `Panel` is the same arrangement, for the same reason.
 *
 * **A union rather than five booleans, and the rebuild is what makes that worth saying twice.**
 * Five flags are five ways to be in a state the Escape protocol cannot order, and the failure
 * is invisible: two layers close on one press, two focus hand-backs race for the caret, and
 * every test that opens one layer at a time still passes. The union cannot express it.
 *
 * `check` is the format check anchored to its chip; the other four are **full-window overlays**
 * on `LAYER.overlay` — which is one rung and not four for exactly this reason (see `layers.ts`).
 *
 * **There is a sixth `"inner"` peer on this screen, and it is not in this union**: the set
 * filter inside the docked search panel (`SetCombobox.tsx`, reached through `FilterBar`). It is
 * a whole layer of somebody else's, so the union cannot model it — what keeps it apart is
 * **focus and click mechanics, not structure**. Opening it takes the caret out of whichever of
 * these is up, and every one of them closes on focus-out or on a press outside its own root;
 * opening any of these takes the caret out of the combobox, which closes on focus-out and on a
 * mousedown outside its root. Pinned both ways by `DeckEditor.test.tsx`'s "never has the set
 * filter and one of the editor's own layers open at once".
 *
 * **The card pane docked beside this view carries two more, and they are peers of these**: its
 * printings quick-add popup and its hover preview, both `"inner"`. The popup is kept apart the
 * way the set filter is, by focus — it closes when the caret leaves its root, and every layer
 * here focuses itself on the way up. The preview is a *dwell*, so it can coexist with an
 * anchored layer out here; the four overlays make it unreachable, because a pointer cannot get
 * to the pane through a scrim.
 */
type Layer =
  | { kind: "check" }
  | { kind: "categories" }
  | { kind: "history" }
  | { kind: "theoryDiff" }
  | { kind: "settings" }
  | null;

/**
 * One deck, open for editing.
 *
 * The Decks view in its second state rather than a screen of its own — `openDeckId` is the
 * whole of the navigation — and a **view**, not a dismissible layer: Escape closes whichever of
 * its layers is open and nothing else, and the way out is the back control. The card pane
 * docked beside it by `App` keeps working from in here, which is why a card's click is a store
 * write and nothing more.
 *
 * There is no Save. Every control writes through one of Task 4's commands and the list redraws
 * from what the database answered, which is what spec §7's "autosave drafts" honestly means for
 * a deck: the row *is* the draft.
 *
 * **What this component is and is not.** It is a header, a toolbar and a frame: it decides which
 * variant is read, how the rows are grouped, sorted and filtered, which of the four views draws
 * them, and which of five layers is open. It draws no card and no group heading itself —
 * `grouping.ts` says what the groups are and `views/` draw them, so four surfaces cannot answer
 * "how many cards are in the Ramp column" four ways.
 */
export function DeckEditor({ deckId }: { deckId: number }) {
  const [variant, setVariant] = useState<DeckVariant>("live");
  const deck = useDeck(deckId, variant);
  const { specs, formatSpecFor } = useFormatSpecs();
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const openCardFromDeck = useAppStore((s) => s.openCardFromDeck);

  const row = deck.deck;
  const spec = row ? formatSpecFor(row.formatKey) : null;
  const loading = deck.query.isPending;
  const readFailure = deck.query.isError ? ipcError(deck.query.error) : null;
  /** The read succeeded and answered nothing: another view deleted this deck. */
  const gone = !loading && !deck.query.isError && deck.query.data === null;

  /**
   * The deck's *other* list, read only when the deck keeps one.
   *
   * Two cached answers under two query keys (`useDeck`'s own arrangement), so flipping the
   * switch is instant and this costs one extra `deck_get` per deck that has a plan — and none
   * at all for a deck that does not, because `useDeck(null)` asks for nothing. It exists for
   * one readout: how many rows the two lists disagree about, which is the whole reason a reader
   * would open the difference dialog.
   */
  const theoryEnabled = row?.theoryEnabled === true;
  const other = useDeck(theoryEnabled ? deckId : null, variant === "live" ? "theory" : "live");

  const [view, setView] = useState<DeckView>("stacks");
  const [groupBy, setGroupBy] = useState<GroupBy>("category");
  const [sortBy, setSortBy] = useState<SortBy>("alphabetical");
  const [filter, setFilter] = useState("");
  const [tagIds, setTagIds] = useState<readonly number[]>(NO_TAGS);
  const [statsOpen, setStatsOpen] = useState(true);
  const [layer, setLayer] = useState<Layer>(null);
  /** What the quick-add field is holding, and what the last press could not find. */
  const [quickText, setQuickText] = useState("");
  const [quickMiss, setQuickMiss] = useState<string | null>(null);

  /**
   * Where the docked panel's adds land, and the quick add with them. Here rather than in the
   * panel because it is a fact about the deck being edited, and the categories it may take are
   * this editor's own.
   *
   * `0` is the one value that is not a category: `deck_categories.id` is an `INTEGER PRIMARY
   * KEY` and `dnd.ts`'s `isCategoryId` refuses anything but a positive safe integer, so zero is
   * a sentinel meaning "nothing picked yet" that no real category can collide with. The clamp
   * below replaces it on the first render that has a deck.
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

  const editorRef = useRef<HTMLElement>(null);
  /** The row the deck, the stats block and the panel share, and the only width any of them can
   *  be judged against — the window's own is three layouts away from it. */
  const deskRef = useRef<HTMLDivElement>(null);
  /** The box the current view draws into: a drop target, and the height the two column-packing
   *  views are told to pack to. */
  const viewRef = useRef<HTMLDivElement>(null);
  const [desk, setDesk] = useState({ width: 0, height: 0 });
  /** Whatever opened the layer that is up, so Escape can hand the caret back to it. */
  const openerRef = useRef<HTMLButtonElement | null>(null);
  /** The format check's chip, which owns its own trigger ref because `ValidationPanel` draws
   *  the chip itself. */
  const chipRef = useRef<HTMLButtonElement>(null);
  const tookFocus = useRef(false);

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
   * The columns and the move targets: **every category the deck has, in `sortOrder`.**
   *
   * There used to be a filter here, driven by the seeded format spec — the sideboard was hidden
   * when `sideboard_max` was 0, the commander column unless `requires_commander`. Schema v8
   * makes that wrong: a category is a row the user named, ordered and switched on or off, so
   * hiding one would hide a pile they built, and a deck may own any number of `main` ones,
   * which no spec cell has anything to say about. The format still judges the deck (the check
   * chip in the header); it no longer decides what is drawn.
   */
  const categories = deck.categories;

  // The add target has to be a category this deck still has — a category deleted or renamed
  // away under an open editor would otherwise leave the select holding an id that is not in its
  // own options, with every press filing a card somewhere nothing is drawing. Reset during
  // render, which is React's own answer to state that has to follow a prop.
  //
  // The **first** category, not a hard-coded word: there is no `main` to fall back to any more.
  // A deck always has at least the four `PREDEFINED_CATEGORIES` the migration seeds, so the
  // list is only empty while the read is still in flight.
  if (categories.length > 0 && !categories.some((c) => c.id === targetCategoryId)) {
    setTargetCategoryId(categories[0].id);
  }

  // A deck deleted under an open layer takes its trigger with it — but not the state that says
  // one is open, and an `"inner"` layer nothing draws is a layer that eats the first Escape of
  // whatever the reader does next. Reset during render (`CardDetailPane`'s face, `Cover`'s art).
  if (gone && layer !== null) setLayer(null);
  // Same reason, one field along: a switch the header stops drawing must not leave the editor
  // reading a list nothing can get back to.
  if (row !== null && !theoryEnabled && variant !== "live") setVariant("live");

  // The caret comes here on the way in, once the deck's name is known so the region announces
  // which deck it is. The gallery's New deck button had the caret and unmounts the moment this
  // view takes over, and an element that disappears with focus on it drops it to `<body>`.
  useEffect(() => {
    if (tookFocus.current || loading) return;
    tookFocus.current = true;
    editorRef.current?.focus();
  }, [loading]);

  // How much room the three things on the desk have between them, and how tall they are. A
  // window resize changes it, and so does the card pane opening and closing beside the whole
  // view — neither of which this component would otherwise hear about, which is why it is an
  // observer and not a prop (`CardGrid`'s arrangement). Re-run when the deck lands, because the
  // element being measured does not exist until then.
  const hasRow = row !== null;
  useEffect(() => {
    const el = deskRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setDesk({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(el);
    setDesk({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, [hasRow]);

  /**
   * Whether the panel may draw itself open, or has to fall back to its rail.
   *
   * `0` is "not measured yet" and reads as room: the first paint of a wide window should not
   * flash a rail, and the observer answers on the same frame.
   */
  const roomForPanel =
    desk.width === 0 ||
    desk.width - (statsOpen ? STATS_WIDTH_PX + DESK_GAP : 0) - (PANEL_WIDTH_PX + DESK_GAP) >=
      DECK_FLOOR;

  // A refused write re-reads the deck, and the read is what decides what happened: every write
  // goes through `touch_deck`, which answers "That deck is not there any more" when the deck
  // has been deleted under the reader — so the same refusal is either a busy database (the
  // banner says so, the deck stays) or a deck that is gone (the read answers null and the
  // editor says so). Keyed on `submittedAt` so each new failure re-reads exactly once.
  //
  // **All six writes, banner or no banner.** `add_card` calls `touch_deck` like the rest and
  // `missing_to_wishlist` answers the same `GONE` from its own read, so a press in the docked
  // panel or on the stats block reaches the same sentence — and without them here that surface
  // would report a deck that is gone while the view beside it went on painting it, with every
  // further press failing the same way and nothing on screen explaining why. The family is the
  // point: **no refused deck write may leave a dead deck painted.**
  //
  // **Three of the six have no control in this view as it stands**, and they are kept for the
  // reason `swapPrinting` has always been kept. `swapPrinting` is pressed on the card pane,
  // which is a *sibling* of this editor, so its refusal lands in the pane's own mutation state
  // and this observer stays idle for the life of the editor — what actually carries it back
  // here is the `onError` invalidation on the mutation's single definition (`useDeck.ts`).
  // `setQuantity` and `moveCard` joined it when the rebuilt views replaced the category columns
  // that used to carry a stepper and a "Move to" menu: nothing in this tree fires them today.
  // Each costs one array element, each is where an in-editor control would land the day one
  // exists, and reading any of the three as live GONE coverage would be reading it as something
  // it cannot do today.
  const refetch = deck.query.refetch;
  const lastOfAny = newest([...writes, deck.addCard, deck.missingToWishlist, deck.swapPrinting]);
  const failedAt = lastOfAny.isError ? lastOfAny.submittedAt : 0;
  useEffect(() => {
    if (failedAt) void refetch();
  }, [failedAt, refetch]);

  // Focus first, then close: the trigger is still mounted at this point. This is the
  // **keyboard** way out; the click-away way out is `close` and hands nothing back, because the
  // reader who clicked elsewhere is already somewhere else.
  const dismiss = useCallback(() => {
    openerRef.current?.focus();
    setLayer(null);
  }, []);
  const close = useCallback(() => setLayer(null), []);

  /** Open one of the five, from the control that was pressed — and never a second one, because
   *  there is one slot. */
  const openLayer = useCallback(
    (next: NonNullable<Layer>, trigger: HTMLButtonElement | null) => {
      openerRef.current = trigger;
      setLayer((open) => (open?.kind === next.kind ? null : next));
    },
    [],
  );
  const openCheck = useCallback(
    () => openLayer({ kind: "check" }, chipRef.current),
    [openLayer],
  );

  const writeAdd = deck.addCard.mutate;

  /** One copy into a category — the panel's Add button's write, the quick add's, and a drop. */
  const addTo = useCallback(
    (cardId: string, categoryId: number) => writeAdd({ cardId, categoryId, quantity: 1 }),
    [writeAdd],
  );

  /**
   * What a drop writes — the one place a drag becomes a command.
   *
   * `dnd.ts` decided *what* the drop means and refused the ones that mean nothing; this decides
   * nothing at all, which is why the rule can be tested without a browser and this can be read
   * in one breath.
   */
  const applyDrop = useCallback(
    (write: DeckWrite) => {
      if (write.write === "add") addTo(write.cardId, write.categoryId);
    },
    [addTo],
  );

  /**
   * The deck itself as a drop target: let a card go anywhere over the list and it lands in the
   * category the toolbar is pointed at.
   *
   * **The whole view rather than a target per group, and that is a real narrowing.** The four
   * views take `CardGroup[]` and an `onSelect` and expose no element per heading, so there is
   * nothing for a per-category registration to attach to — which also means a *row* cannot be
   * picked up, so there is no move-by-drag and no remove tray here any more. What survives is
   * the direction that still has a source: the docked panel's tiles, the search wall, the
   * collection table, the pinned wishes and the card pane's printings rows all carry a payload
   * `dnd.ts` can read, and letting one go over the deck adds it. Where it lands is the "Add to"
   * select's answer, which is the same answer the panel's own button gives — so the drag is a
   * shortcut over a click path, exactly as it was.
   */
  useEffect(() => {
    const element = viewRef.current;
    if (!element || targetCategoryId === 0) return;
    const writeFor = (data: Record<string, unknown>) => {
      const payload = readDragData(data);
      return payload && dropWrite(payload, { kind: "category", categoryId: targetCategoryId });
    };
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => writeFor(source.data)?.write === "add",
      onDrop: ({ source }) => {
        const write = writeFor(source.data);
        if (write) applyDrop(write);
      },
    });
  }, [targetCategoryId, applyDrop, hasRow, view]);

  /**
   * Open a card **as a deck row** — the only write of `paneDeckContext` in the app, and the
   * reason every view hands its whole `DeckCard` back rather than an id.
   *
   * What it buys is on the other side of the app: the pane's printings list gains "Use this
   * printing", which rewrites *this* slot. Everything else that opens a card — the docked
   * panel's tiles, the validation panel's names — goes through `setSelectedCardId`, which
   * clears the context in the same write (see the store), so a card that is not a row of this
   * deck can never be shown as one.
   *
   * The context carries the category's **name** as well as its id, because the pane is a
   * sibling of this editor and has no category list to translate one with; and the **variant**,
   * because a deck is two lists and a swap addressed to the wrong one either misses or rewrites
   * a row the reader is not looking at.
   */
  const openCard = useCallback(
    (card: DeckCard) =>
      openCardFromDeck({
        deckId,
        categoryId: card.categoryId,
        categoryName: card.categoryName,
        cardId: card.cardId,
        variant,
      }),
    [deckId, openCardFromDeck, variant],
  );

  /** Whatever is half-typed, the field goes back to standing for the deck's name. A blank is
   *  not a rename: the backend refuses it in words, and a name is not something a deck can lose
   *  by tabbing through it. */
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

  /**
   * How many rows the two lists disagree about — a **row** count, which is what "cards differ"
   * means to a reader looking at a list of cards.
   *
   * Computed over the two reads rather than through `deck_theory_diff`, because that command
   * answers one direction only (what Theory wants that Live has not got) and this readout is
   * the reason to open the dialog at all: a plan that has dropped four cards differs from the
   * deck by four, and a badge that said `0` would be telling the reader there is nothing to
   * look at.
   */
  const differing = useMemo(() => {
    if (!theoryEnabled) return 0;
    const slot = (card: DeckCard) => `${card.categoryId}:${card.cardId}`;
    const mine = new Map(deck.cards.map((card) => [slot(card), card.quantity]));
    let n = 0;
    for (const card of other.cards) {
      if (mine.get(slot(card)) !== card.quantity) n += 1;
      mine.delete(slot(card));
    }
    return n + mine.size;
  }, [theoryEnabled, deck.cards, other.cards]);

  /**
   * The rows on screen: the deck, narrowed by the two filters the toolbar carries.
   *
   * Filtering happens **before** the grouping, so every count and price in a heading is a count
   * of what is under it — a group saying 60 over four visible rows is a heading that lies about
   * the only thing it is for. The empty categories still draw, because that is where the next
   * card goes whether or not the filter matches anything in them.
   */
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle && tagIds.length === 0) return deck.cards;
    return deck.cards.filter(
      (card) =>
        (tagIds.length === 0 || (card.tagId !== null && tagIds.includes(card.tagId))) &&
        (!needle ||
          card.name.toLowerCase().includes(needle) ||
          (card.typeLine ?? "").toLowerCase().includes(needle)),
    );
  }, [deck.cards, filter, tagIds]);

  const groups = useMemo(
    () => buildGroups(shown, categories, groupBy, sortBy),
    [shown, categories, groupBy, sortBy],
  );

  /**
   * Every finding, filed under each card it names, so a view can mark a card.
   *
   * The second pass of `validateDeck` on this screen — `ValidationPanel` makes its own for the
   * chip's count — and that is the cheaper of the two arrangements rather than an oversight:
   * the engine is pure over a few hundred rows, and the alternative is lifting the panel's
   * state out of the panel so that a chip and a set of marks share one array. Two `useMemo`s
   * over the same input cannot disagree; two owners of one array can.
   */
  const violations = useMemo(
    () => (spec ? violationsByCard(validateDeck([...deck.cards], spec)) : undefined),
    [deck.cards, spec],
  );

  /** Copies of the cards the format calls game changers, over the piles that count — the second
   *  half of the header's rules readout, beside the check chip's own count. */
  const gameChangers = useMemo(
    () =>
      deck.cards.reduce(
        (n, card) => (card.gameChanger === true && card.categoryActive ? n + card.quantity : n),
        0,
      ),
    [deck.cards],
  );

  const targetName = categories.find((c) => c.id === targetCategoryId)?.name ?? "this deck";

  /**
   * The quick add: a name, and the card it turns out to be.
   *
   * One search, `collapse: true` and `limit: 1` — the newest printing of the best match, which
   * is the same printing the docked panel's wall offers first for the same query. It is a
   * **shortcut over that wall**, not a second way of choosing a printing: a reader who cares
   * which one they get has the panel open beside them.
   *
   * A miss is said in words rather than swallowed. The field keeps what was typed on a miss and
   * is cleared on a hit, because the two are different next actions: correct it, or type the
   * next card.
   */
  const quickAdd = useMutation({
    mutationFn: (text: string) =>
      ipc.searchCards({ text, collapse: true, limit: 1, offset: 0 }),
    onSuccess: (found, text) => {
      const card = found.items[0];
      if (!card) {
        setQuickMiss(text);
        return;
      }
      setQuickMiss(null);
      setQuickText("");
      addTo(card.id, targetCategoryId);
    },
  });
  const quickAddFailure = quickAdd.isError ? ipcError(quickAdd.error) : null;
  const submitQuickAdd = () => {
    const text = quickText.trim();
    if (!text || targetCategoryId === 0) return;
    setQuickMiss(null);
    quickAdd.mutate(text);
  };

  const viewProps = {
    groups,
    violations,
    onSelect: openCard,
    className: "min-h-0",
  };

  return (
    <section
      ref={editorRef}
      tabIndex={-1}
      aria-label={row ? `Deck editor: ${row.name}` : "Deck editor"}
      className={cn("flex h-full min-h-0 flex-col gap-3", FOCUS)}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
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
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
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
                  // already run by then. A field nobody has typed in has nothing to undo, so
                  // the press belongs to whatever is open behind it; a field that has been
                  // typed in owns exactly one press, and the next one is the pane's again.
                  // The ref rather than the state, for the reason it exists: two presses inside
                  // one tick — a key held down, an autorepeat — both read a `nameDraft` React
                  // has not re-rendered yet, and the second would consume a press it has
                  // nothing to spend it on. The ref is cleared where it is read.
                  if (e.key === "Escape" && draftRef.current !== null) {
                    e.preventDefault();
                    dropDraft();
                  }
                }}
                // Geist, not the display face, for the reason the card pane gives about a
                // card's name: this is *content*, and Cinzel is for view titles and hero copy.
                // Cinzel is also drawn in caps — which in a field you type into means the
                // letters never match the ones being typed.
                className={cn(
                  "min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1",
                  "text-xl font-medium leading-tight",
                  "transition-colors duration-150 hover:border-border motion-reduce:transition-none",
                  FOCUS,
                )}
              />

              {/* Only for a deck that keeps a plan. A two-way switch over a deck with one list
                  is a control whose other half is empty by construction — the way to get one is
                  Deck settings, where the toggle that creates it lives. */}
              {theoryEnabled && (
                <>
                  <div
                    role="group"
                    aria-label="Deck list"
                    className="flex shrink-0 overflow-hidden rounded-md border border-border"
                  >
                    {/* The words are written out rather than `capitalize`d off the value, for
                        WCAG 2.5.3's reason read the other way: `text-transform` changes what is
                        drawn and not what the control is *called*, so a `capitalize` switch is
                        one a reader sees as "Live" and voice control has to be asked for as
                        "live". */}
                    {(
                      [
                        { id: "live", label: "Live" },
                        { id: "theory", label: "Theory" },
                      ] as const
                    ).map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setVariant(id)}
                        aria-pressed={variant === id}
                        className={cn(
                          "h-7 px-2.5 text-xs",
                          "transition-colors duration-150 motion-reduce:transition-none",
                          variant === id
                            ? "bg-accent font-medium text-accent-fg"
                            : "text-dim hover:text-text",
                          FOCUS,
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* The reason to open the difference dialog, said before it is opened. Copies
                      are the dialog's business; this counts *rows the two lists disagree
                      about*, which is what a reader means by "cards". */}
                  <button
                    type="button"
                    onClick={(e) => openLayer({ kind: "theoryDiff" }, e.currentTarget)}
                    aria-expanded={layer?.kind === "theoryDiff"}
                    aria-haspopup="dialog"
                    className={cn(
                      "shrink-0 rounded-md px-1 font-mono text-[0.6875rem] text-dim",
                      "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                      FOCUS,
                    )}
                  >
                    {differing === 1 ? "1 card differs" : `${differing} cards differ`}
                  </button>
                </>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <select
                // "Deck format", not "Format": the docked search panel offers a format *filter*
                // of its own, and two controls called Format in one view are two controls a
                // screen reader — and a test — cannot tell apart.
                aria-label="Deck format"
                value={row.formatKey}
                onChange={(e) => deck.update.mutate({ formatKey: e.target.value })}
                disabled={formats.length === 0}
                className={cn(CONTROL, FILTER_FOCUS)}
              >
                {formats.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.name}
                  </option>
                ))}
              </select>

              {/* The one switch with a consequence outside this deck, so it says what it
                  does: a built deck's claims come off what every other deck can reach. */}
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

              {/* Beside the check rather than inside it, because the two answer different
                  questions: the chip counts what is *wrong*, and this counts what is
                  *powerful*. A game changer is legal by definition — it is the bracket
                  conversation, not the legality one — so folding the number into a chip that
                  reads "4 issues" would invent four problems. */}
              {gameChangers > 0 && (
                <span className="shrink-0 font-mono text-[0.6875rem] text-dim">
                  {gameChangers === 1 ? "1 game changer" : `${gameChangers} game changers`}
                </span>
              )}

              {(
                [
                  { kind: "categories", label: "Categories & tags" },
                  { kind: "history", label: "History" },
                  { kind: "settings", label: "Deck settings" },
                ] as const
              ).map(({ kind, label }) => (
                <button
                  key={kind}
                  type="button"
                  onClick={(e) => openLayer({ kind }, e.currentTarget)}
                  aria-expanded={layer?.kind === kind}
                  aria-haspopup="dialog"
                  className={cn(CONTROL, FILTER_FOCUS, "hover:text-text")}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {row && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-border pb-3">
          {/* The fastest way to put a card in a deck you already know the name of. Where it
              lands is the panel's "Add to" — one control for one decision, rather than a second
              select of the same categories two inches away. */}
          <div className="flex items-center gap-1.5">
            <span className="text-[0.6875rem] text-dim">Quick add</span>
            <input
              type="text"
              aria-label={`Quick add a card to ${targetName}`}
              placeholder="Sol Ring…"
              value={quickText}
              onChange={(e) => setQuickText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                submitQuickAdd();
              }}
              className={cn(
                "h-8 w-52 rounded-md border border-border bg-bg px-2.5 text-[0.8125rem]",
                FOCUS,
              )}
            />
            {/* One live region, mounted for as long as the toolbar is: a region that appears
                together with its text announces nothing, because there was no change to
                notice. */}
            <p role="status" className="min-w-0 text-[0.6875rem] text-dim">
              {quickAddFailure
                ? `Could not search — ${quickAddFailure}`
                : quickAdd.isPending
                  ? "Looking…"
                  : quickMiss !== null
                    ? `No card found for “${quickMiss}”.`
                    : ""}
            </p>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[0.6875rem] text-dim">View</span>
            <div
              role="group"
              aria-label="Deck view"
              className="flex overflow-hidden rounded-md border border-border"
            >
              {VIEWS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setView(id)}
                  aria-pressed={view === id}
                  className={cn(
                    "h-8 border-r border-border px-3 text-xs last:border-r-0",
                    "transition-colors duration-150 motion-reduce:transition-none",
                    view === id ? "bg-accent font-medium text-accent-fg" : "text-dim hover:text-text",
                    FOCUS,
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <label htmlFor="deck-group-by" className="text-[0.6875rem] text-dim">
              Group by
            </label>
            <select
              id="deck-group-by"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as GroupBy)}
              className={cn(CONTROL, FILTER_FOCUS, "text-text")}
            >
              {GROUP_BY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <label htmlFor="deck-sort-by" className="text-[0.6875rem] text-dim">
              Sort
            </label>
            <select
              id="deck-sort-by"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className={cn(CONTROL, FILTER_FOCUS, "text-text")}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <input
              type="search"
              aria-label="Filter this deck"
              placeholder="Filter this deck…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className={cn(
                "h-8 w-44 rounded-md border border-border bg-bg px-2.5 text-xs",
                FOCUS,
              )}
            />

            {/* The deck's own labels, as filters. Nothing at all for a deck with no tags — an
                empty group with a name is a control that says there is something to press. */}
            {deck.tags.length > 0 && (
              <div role="group" aria-label="Filter by tag" className="flex flex-wrap gap-1.5">
                {deck.tags.map((tag) => {
                  const on = tagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setTagIds((held) =>
                          held.includes(tag.id)
                            ? held.filter((id) => id !== tag.id)
                            : [...held, tag.id],
                        )
                      }
                      className={cn(FILTER_CONTROL, FILTER_FOCUS, "h-8 px-2.5 text-xs", filterChipState(on))}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            )}

            <ToggleChip label="Stats" pressed={statsOpen} onClick={() => setStatsOpen((v) => !v)} />
          </div>
        </div>
      )}

      {writeFailure && (
        <p
          role="alert"
          className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
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
        // The deck on the left, what it adds up to beside it, and the way cards get into it on
        // the right (spec §7). One flex row, so all three are the full height of the editor —
        // and `min-w-0` on the deck side, because a view that cannot shrink is the horizontal
        // scrollbar the 1024px floor forbids. This element is also what `DECK_FLOOR` is measured
        // against: it is the width the three of them actually have, after the sidebar, the page
        // padding and the card pane have taken theirs.
        <div ref={deskRef} className="flex min-h-0 flex-1 gap-4">
          <div ref={viewRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
            {view === "stacks" && (
              <StackView {...viewProps} columnHeight={desk.height || undefined} />
            )}
            {view === "table" && <TableView {...viewProps} selectedCardId={selectedCardId} />}
            {view === "text" && <TextView {...viewProps} columnHeight={desk.height || undefined} />}
            {view === "grid" && <GridView {...viewProps} />}
          </div>

          {statsOpen && (
            // A block rather than a strip, and beside the deck rather than over it: four charts
            // and a figure row do not fit on one line at the widths this editor is read at, and
            // the direction's floor is a chart whose numbers are legible, not a chart that fits.
            //
            // **A `section`, not an `aside`** — the same call `DeckSearchPanel` makes and for the
            // same measured reason: the card detail pane is the app's one complementary landmark,
            // and a second one answers `getByRole("complementary")` too. Drawn as an aside, this
            // block broke five of `App.test.tsx`'s pane assertions without touching the pane.
            <section
              aria-label="Deck stats"
              className={cn(
                "flex shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-border",
                "bg-surface p-3.5",
                STATS_WIDTH,
              )}
            >
              <div className="flex shrink-0 items-center justify-between">
                <h3 className="font-heading text-lg leading-none">Deck stats</h3>
                <button
                  type="button"
                  onClick={() => setStatsOpen(false)}
                  aria-label="Hide deck stats"
                  className={cn(
                    "rounded-md p-0.5 text-dim",
                    "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                    FOCUS,
                  )}
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </button>
              </div>
              {/* Every number over the same rows the view is drawn from — one query, so a curve
                  and a legality panel can never disagree. Unfiltered on purpose: the toolbar's
                  filter narrows what is *shown*, and a deck's mana curve is a fact about the
                  deck rather than about what is on screen. */}
              <DeckStats cards={deck.cards} send={deck.missingToWishlist} />
            </section>
          )}

          <DeckSearchPanel
            add={deck.addCard}
            categories={categories}
            targetCategoryId={targetCategoryId}
            onTargetCategoryChange={setTargetCategoryId}
            roomy={roomForPanel}
          />
        </div>
      )}

      {/* Spec §5: a price is never shown without saying how old it is — once, here, rather than
          as a tooltip on every one of sixty rows. */}
      <p className="shrink-0 text-[0.7rem] text-dim">{PRICES_AS_OF}</p>

      {/* The four overlays, mounted **at the editor's top level and as siblings of the layout
          above**, which is not a tidiness preference. Each is `fixed inset-0` and none is
          portalled, so a transformed ancestor would become its containing block and pin it to
          whatever box that ancestor happens to occupy — and this editor has transformed
          elements in it (a virtualised table's rows are `absolute` *and* `transform`ed, which
          is a stacking context and a containing block both). Mounted inside the view area, a
          drawer would cover a column instead of the window.

          Each is closed by `open`, and each of the four unmounts everything behind that flag —
          so a closed one costs no query, no window listener and no state. That is what makes it
          safe to mount all four unconditionally, and it is why the editor can hold them in one
          `Layer` union rather than four booleans. */}
      <CategoriesPanel
        deckId={deckId}
        variant={variant}
        open={layer?.kind === "categories"}
        onDismiss={dismiss}
        onClose={close}
      />
      <AuditDrawer
        deckId={deckId}
        open={layer?.kind === "history"}
        onDismiss={dismiss}
        onClose={close}
      />
      <TheoryDiffDialog
        deckId={deckId}
        open={layer?.kind === "theoryDiff"}
        onDismiss={dismiss}
        onClose={close}
      />
      <DeckSettingsDialog
        deckId={deckId}
        open={layer?.kind === "settings"}
        onDismiss={dismiss}
        onClose={close}
      />
    </section>
  );
}
