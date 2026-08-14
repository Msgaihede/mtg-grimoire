import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  filterChipState,
  ToggleChip,
} from "@/components/FilterChips";
import { ipc, ipcError, type DeckCard, type DeckVariant } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { statusLine } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { pricesAsOf } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { newestWrite, writeFailure } from "@/lib/writes";
import { AuditDrawer } from "./AuditDrawer";
import { DECK_CARD_VARIANT, focusDeckGroup, FOCUS, type DeckCardActions } from "./cardControl";
import { CategoriesPanel } from "./CategoriesPanel";
import { AUTO_CATEGORY, DeckSearchPanel, PANEL_WIDTH_PX } from "./DeckSearchPanel";
import { DeckSettingsDialog } from "./DeckSettingsDialog";
import { DeckStats } from "./DeckStats";
import { dropWrite, readDragData, type DeckWrite, type DragPayload } from "./dnd";
import { buildGroups, GROUP_BY_OPTIONS, type GroupBy } from "./grouping";
import { ImportDeckDialog } from "./import/ImportDeckDialog";
import { QuickAdd } from "./QuickAdd";
import { SORT_OPTIONS, type SortBy } from "./sorting";
import { TheoryDiffDialog } from "./TheoryDiffDialog";
import { useDeck } from "./useDeck";
import { pickerFormats, useFormatSpecs } from "./useFormatSpecs";
import { ValidationPanel } from "./ValidationPanel";
import { validateDeck } from "./validation/engine";
import { violationsByCard } from "./violations";
import { GridView } from "./views/GridView";
import { StackView } from "./views/StackView";
import { TableView } from "./views/TableView";
import { TextView } from "./views/TextView";

/**
 * The toolbar's two option lists, as the toolbar draws them: alphabetically by label.
 *
 * Sorted here rather than trusted from `grouping.ts` and `sorting.ts`, whose arrays are named
 * in domain order and happen to read alphabetically today — which is exactly how an ordering
 * drifts the day somebody appends a fourth grouping or a fifth sort. Module level, so the sort
 * is paid once per session rather than once per render of the largest component in the app.
 */
const GROUP_BY_PICKER = sortOptions(GROUP_BY_OPTIONS, (o) => o.label);
const SORT_BY_PICKER = sortOptions(SORT_OPTIONS, (o) => o.label);

/** A header/toolbar control that is not a chip: a select, a field, a plain press. 32px, so the
 *  two rows read as rows rather than as a pile of differently sized boxes. The property list is
 *  written out because a colour utility and a transform one compile to the same CSS longhand,
 *  so tailwind-merge would keep one and silently drop the other; the format select is
 *  `disabled` when the specs have not answered and must not appear to depress. */
const CONTROL =
  "h-8 rounded-md border border-border bg-surface px-2 text-xs text-dim " +
  "transition-[color,background-color,border-color,opacity,transform,scale] " +
  "duration-[var(--duration-fast)] ease-standard active:scale-[0.97] " +
  "disabled:active:scale-100 motion-reduce:transition-none";

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

/**
 * The narrowest the deck's name field may be squeezed to.
 *
 * 10rem, which at the field's `text-xl` is about thirteen characters — enough to tell two decks
 * apart, and enough that the caret has somewhere to go. Below that the field stops being a
 * field: measured in the shipped window, with nothing holding it, it collapsed to **18px**,
 * which draws as a sliver with no glyph in it at all.
 *
 * A floor rather than a fixed width, because the field is still the row's flexible child: it
 * takes every pixel the chrome beside it does not need, and 10rem is only what it falls back on
 * when there are none. At the app's own 1280×800 it is never reached — the field measures 238px
 * there — which is the point of the number: **10rem is the largest floor that still lets the
 * whole header sit on one line at 1280.** At 12rem the row wrapped even with the Theory switch
 * off, costing 44px of deck height in the common case to protect a width that was never at
 * risk. Measured both ways; see the report.
 *
 * Written out whole rather than built from a constant — Tailwind scans source text for class
 * names, and one assembled at runtime emits no rule at all.
 */
const NAME_FLOOR = "min-w-40";

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
 * then structural rather than remembered, and at most one of the six registrations is ever
 * enabled. `DecksPage`'s `Panel` is the same arrangement, for the same reason.
 *
 * **A union rather than six booleans, and the rebuild is what makes that worth saying twice.**
 * Six flags are six ways to be in a state the Escape protocol cannot order, and the failure
 * is invisible: two layers close on one press, two focus hand-backs race for the caret, and
 * every test that opens one layer at a time still passes. The union cannot express it.
 *
 * `check` is the format check anchored to its chip; the other five are **full-window overlays**
 * on `LAYER.overlay` — which is one rung and not five for exactly this reason (see `layers.ts`).
 *
 * **Two more `"inner"` peers sit on this screen and neither is in this union**: the set filter
 * inside the docked search panel (`SetCombobox.tsx`, reached through `FilterBar`), and the quick
 * add's suggestion list (`QuickAdd.tsx`, in the toolbar above). Both are whole layers of
 * somebody else's, so the union cannot model them — what keeps them apart is **focus and click
 * mechanics, not structure**. Opening either takes the caret out of whichever of these is up,
 * and every one of them closes on focus-out or on a press outside its own root; opening any of
 * these takes the caret out of that combobox, which closes on focus-out and on a mousedown
 * outside its root. The quick add narrows it further by registering **only while its list is
 * actually up** (`enabled: listOpen`), so a field the reader is merely typing in owns no press
 * at all. Pinned both ways by `DeckEditor.test.tsx`'s "never has the set filter and one of the
 * editor's own layers open at once".
 *
 * **The card pane docked beside this view carries two more, and they are peers of these**: its
 * printings quick-add popup and its hover preview, both `"inner"`. The popup is kept apart the
 * way the set filter is, by focus — it closes when the caret leaves its root, and every layer
 * here focuses itself on the way up. The preview is a *dwell*, so it can coexist with an
 * anchored layer out here; the five overlays make it unreachable, because a pointer cannot get
 * to the pane through a scrim.
 *
 * **All five overlays are modal, and that is what makes the sentence above true of a keyboard
 * too.** Each paints a full-window scrim, each claims `aria-modal="true"`, and each installs
 * `lib/trapTab.ts` — so nothing behind one can be reached by Tab any more than by a pointer.
 * Two of them used to argue the opposite in their own docs; the scrim had always contradicted
 * it. `DeckEditor.test.tsx`'s "keeps Tab inside itself" sweep holds the five together.
 */
type Layer =
  | { kind: "check" }
  | { kind: "categories" }
  | { kind: "history" }
  | { kind: "theoryDiff" }
  | { kind: "settings" }
  | { kind: "import" }
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
 * them, and which of six layers is open. It draws no card and no group heading itself —
 * `grouping.ts` says what the groups are and `views/` draw them, so four surfaces cannot answer
 * "how many cards are in the Ramp column" four ways.
 */
export function DeckEditor({ deckId }: { deckId: number }) {
  const [variant, setVariant] = useState<DeckVariant>("live");
  // Every price on this screen — four views, every heading, the stats strip and the line under
  // the deck — is quoted from here. Read once at the top of the editor and threaded, so no two
  // surfaces of one deck can name two marketplaces.
  const { marketplace } = useMarketplace();
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

  /**
   * The card a **card** drag is carrying, or `null` when nothing is being dragged out of the
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

  /**
   * Where the docked panel's adds land, and the quick add with them. Here rather than in the
   * panel because it is a fact about the deck being edited, and the categories it may take are
   * this editor's own.
   *
   * {@link AUTO_CATEGORY} (`0`) is the one value that is not a category, and it is the
   * **default**: an add nobody filed is filed by its type line. It used to mean "nothing picked
   * yet" and the clamp below replaced it with `categories[0]` — which is the seeded **Commander**
   * pile, so on a fresh deck every quick add and every panel press landed there and the
   * quick-add field said so in its own label.
   */
  const [targetCategoryId, setTargetCategoryId] = useState<number>(AUTO_CATEGORY);

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
  /** The box the current view draws into — the one scroller a drag may have to move inside to
   *  reach its target, and the height the two column-packing views are told to pack to. */
  const viewRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const [desk, setDesk] = useState({ width: 0, height: 0 });
  /** Whatever opened the layer that is up, so Escape can hand the caret back to it. */
  const openerRef = useRef<HTMLButtonElement | null>(null);
  /** The format check's chip, which owns its own trigger ref because `ValidationPanel` draws
   *  the chip itself. */
  const chipRef = useRef<HTMLButtonElement>(null);
  const tookFocus = useRef(false);

  // The three writes the editor's **own banner** speaks for. The *latest* of them owns it, not
  // whichever is still holding an error: a refused move used to leave its sentence up while the
  // reader went on to rename the deck successfully (the collection table's lesson). That rule
  // is `lib/writes.ts` now, shared with the gallery, the settings dialog and the categories
  // drawer, because four copies of it were four places to keep one rule — and one of the four
  // had it backwards. The docked panel's add is deliberately not here — it says so in the
  // panel, beside the button that was pressed, and two banners for one refusal would be worse
  // than one in the wrong place.
  const writes = [deck.setQuantity, deck.moveCard, deck.update] as const;
  const bannerFailure = writeFailure(writes);

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

  /** Copies in the list on screen — **copies, not rows**, because that is what a reader counts
   *  and what an import's `replace` would clear. Every category, the inactive ones included:
   *  a `replace` clears the variant, and a pile being switched off does not save it. */
  const cardsInVariant = useMemo(
    () => deck.cards.reduce((copies, card) => copies + card.quantity, 0),
    [deck.cards],
  );

  // The add target has to be a category this deck still has — a category deleted or renamed
  // away under an open editor would otherwise leave the select holding an id that is not in its
  // own options, with every press filing a card somewhere nothing is drawing. Reset during
  // render, which is React's own answer to state that has to follow a prop.
  //
  // **Back to `AUTO_CATEGORY`, and only from a real id that has gone.** This used to fire on the
  // *initial* value too, because `0` meant "nothing picked yet" — so the first render with a
  // deck replaced it with `categories[0]`, which is the seeded Commander pile. Now zero is a
  // choice with a meaning, so the clamp is what it always claimed to be in its own first
  // sentence: a repair for a pile that is not there any more. A reader whose Sideboard is
  // deleted under them lands on Auto rather than silently on somebody else's first column.
  if (
    targetCategoryId !== AUTO_CATEGORY &&
    categories.length > 0 &&
    !categories.some((c) => c.id === targetCategoryId)
  ) {
    setTargetCategoryId(AUTO_CATEGORY);
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

  // Warm the pictures this deck's own views draw, exactly as `SearchPage` warms its wall.
  //
  // {@link DECK_CARD_VARIANT}, which is what the stack and the grid render — and the variant is
  // the whole point of this effect rather than an incidental argument, because a warm cache of
  // the *wrong* one contributes nothing at all: each is a different URL on the CDN. Without this,
  // opening a deck fetches every tile cold, from plain scrollers that mount every row at once
  // rather than a virtualiser that mounts two dozen.
  //
  // It is `grid` now, which is what the collection and the search wall use — so this and
  // `prewarm_collection` warm the same key for a card that is both owned and in a deck, where
  // they used to warm two. That makes this effect cheaper rather than redundant: it is still what
  // makes the deck you just opened warm rather than the deck you opened yesterday.
  const faceKey = deck.cards.map((c) => c.cardId).join(",");
  useEffect(() => {
    if (faceKey === "") return;
    // Fire-and-forget by design: the command resolves as soon as the work is queued, and a
    // tile whose prefetch failed simply fetches when it renders.
    void ipc.prefetchImages([...new Set(faceKey.split(","))], DECK_CARD_VARIANT).catch(() => {});
    // `deck.cards` is a fresh array on every render; `faceKey` is the part that means "this
    // deck is showing a different set of cards now" — including after a variant switch,
    // which is a different list under a different query key.
  }, [faceKey]);

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
  const lastOfAny = newestWrite([
    ...writes,
    deck.addCard,
    deck.missingToWishlist,
    deck.swapPrinting,
  ]);
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

  /** Open one of the six, from the control that was pressed — and never a second one, because
   *  there is one slot. */
  const openLayer = useCallback((next: NonNullable<Layer>, trigger: HTMLButtonElement | null) => {
    openerRef.current = trigger;
    setLayer((open) => (open?.kind === next.kind ? null : next));
  }, []);
  const openCheck = useCallback(() => openLayer({ kind: "check" }, chipRef.current), [openLayer]);

  // The three category writes, each addressed by the slot rather than by a `DeckCard` — because
  // that is all a *drop* carries, and a drag and a control press must not be two ways of
  // writing the same thing. The card controls below hand their own card to the same three.
  //
  // Each takes the mutation's `mutate` rather than the mutation: TanStack hands back a fresh
  // result object on every render, so a callback that depended on the whole thing would have a
  // new identity every render — and these are what the drop targets are registered with, so
  // that would be every group unregistering and re-registering itself in the middle of a drag.
  // `mutate` is stable for the life of the component, which makes the stability
  // `useCategoryDrop` asks for true rather than merely intended.
  const writeQuantity = deck.setQuantity.mutate;
  const writeMove = deck.moveCard.mutate;
  const writeAdd = deck.addCard.mutate;

  /**
   * One copy into a category — the quick add's write, and a drop's.
   *
   * `categoryId` may be {@link AUTO_CATEGORY}, in which case the card's own type line goes
   * instead and `useDeck`'s `addCard` names the pile (`autoCategoryFor`). A drop always passes a
   * real id — pointing at a column is naming one — so the auto arm is the click path's alone,
   * and a caller with a real id may pass no type line at all.
   */
  const addTo = useCallback(
    (cardId: string, categoryId: number, typeLine?: string | null) =>
      writeAdd(
        categoryId === AUTO_CATEGORY
          ? { cardId, typeLine: typeLine ?? null, quantity: 1 }
          : { cardId, categoryId, quantity: 1 },
      ),
    [writeAdd],
  );

  /**
   * Give the caret to a pile, now **and once more after the deck redraws.**
   *
   * The second half is not belt and braces, it is the whole thing working. A card leaving a
   * pile takes the control the caret was on with it, so the caret has to go somewhere — and the
   * somewhere is the pile that changed, which announces its own name. Focusing it at the moment
   * of the write is right and is not enough: the stack and the text view **pack groups into
   * columns**, and a pile that changes size can push the pile after it into a different column.
   * A group that changes column changes parent, so React unmounts its section and mounts a new
   * one — taking the caret to `<body>` a beat after it was carefully placed there.
   *
   * So the target is remembered and re-focused on the next render that carries new cards.
   * `focusDeckGroup` looks the pile up by attribute rather than by ref for exactly this reason:
   * the element it finds the second time is a different element with the same identity.
   *
   * Measured, not guessed: `DeckEditor.stories.tsx`'s `MoveBetweenPiles` fails without the
   * second pass and passes with it.
   */
  const owedFocus = useRef<number | null>(null);
  const handOffTo = useCallback((categoryId: number) => {
    owedFocus.current = categoryId;
    if (!focusDeckGroup(categoryId)) editorRef.current?.focus();
  }, []);
  const cards = deck.cards;
  useEffect(() => {
    const owed = owedFocus.current;
    if (owed === null) return;
    owedFocus.current = null;
    focusDeckGroup(owed);
  }, [cards]);

  const setQuantityAt = useCallback(
    (cardId: string, categoryId: number, quantity: number) => {
      // Zero takes the card out from under the caret — optimistically, so it happens on the
      // press — and the control the caret was on goes with it. Before the write, because the
      // card is gone by the time an answer arrives.
      if (quantity === 0) handOffTo(categoryId);
      writeQuantity({ cardId, categoryId, quantity });
    },
    [writeQuantity, handOffTo],
  );

  const moveTo = useCallback(
    (cardId: string, from: number, to: number) => {
      writeMove(
        { cardId, from, to },
        {
          // The card this control belongs to has left the pile, so the caret goes to where it
          // landed — which announces the category it is now in. A dropped card is handed on the
          // same way: it is the card that unmounts either way, and focus follows it.
          onSuccess: () => handOffTo(to),
        },
      );
    },
    [writeMove, handOffTo],
  );

  /**
   * What a drop writes — the one place a drag becomes a command.
   *
   * `dnd.ts` decided *what* the drop means and refused the ones that mean nothing; this decides
   * nothing at all, which is why the rule can be tested without a browser and this can be read
   * in one breath. Every branch is a write a control already makes: a drag adds nothing to what
   * a reader can do, only to how fast they can do it.
   */
  const applyDrop = useCallback(
    (write: DeckWrite) => {
      if (write.write === "add") addTo(write.cardId, write.categoryId);
      else if (write.write === "move") moveTo(write.cardId, write.from, write.to);
      else setQuantityAt(write.cardId, write.categoryId, 0);
    },
    [addTo, moveTo, setQuantityAt],
  );

  /**
   * What every view is handed, and the whole of what a card can be made to do.
   *
   * One object rather than four props, because it travels three components deep — the view, the
   * group, the card — and a bag that is passed on whole cannot be passed on incompletely. The
   * views spend it differently (a table gets columns, the other three get a bar over the card),
   * and every control inside it is `cardControl.tsx`'s.
   */
  const setQuantity = useCallback(
    (card: DeckCard, quantity: number) => setQuantityAt(card.cardId, card.categoryId, quantity),
    [setQuantityAt],
  );
  const move = useCallback(
    (card: DeckCard, to: number) => moveTo(card.cardId, card.categoryId, to),
    [moveTo],
  );
  const actions = useMemo<DeckCardActions>(
    () => ({ setQuantity, move, moveTargets: categories, drop: applyDrop }),
    [setQuantity, move, categories, applyDrop],
  );

  // What is being dragged out of the deck, for as long as it is. `canMonitor` narrows this to
  // the deck's own cards: a tile dragged in from the panel is not something the tray can take,
  // and a monitor that answered for it would re-render the panel — and with it the tile the
  // reader has hold of — in the middle of the drag.
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

  // A pile can be off the bottom of the view while a card is in the air over it — the stack
  // packs into columns that scroll sideways, and the grid runs down the page. This scrolls the
  // view when the drag nears its edge: the one motion in here, and the platform's own idea of a
  // drag rather than the app's.
  useEffect(() => {
    const element = viewRef.current;
    if (!element) return;
    return autoScrollForElements({ element });
  }, [hasRow]);

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
   *  cannot show its own value would silently re-format the deck on the first other change.
   *  Both halves are `pickerFormats`', including that the deck's own row is *folded into* the
   *  alphabet rather than pinned in front of it. */
  const formats = useMemo(
    () =>
      pickerFormats(specs, row && { key: row.formatKey, name: row.formatName ?? row.formatKey }),
    [specs, row],
  );

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
   * the only thing it is for.
   *
   * **Filtering therefore also decides which headings exist**, which is a consequence of
   * `grouping.ts`' `drawsWhenEmpty` rather than a rule of its own: a category the filter empties
   * is an empty category, so it stops drawing exactly as one the reader emptied by hand does.
   * Only the four seeded zones survive it. That is deliberate — a filter whose matches are three
   * cards should not answer with twenty headings and three rows — but it does mean the shape of
   * the deck on screen changes as the reader types, and the pile a card would land in may not be
   * on screen while a filter is running.
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
    // No currency any more: the rows this groups arrived priced at the selected marketplace,
    // because that marketplace is in `useDeck`'s query key. A switch therefore changes
    // `deck.cards` itself and this recomputes over the new answer, rather than picking a
    // different field out of the old one.
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

  /** What the add target is called, or `null` under {@link AUTO_CATEGORY} — where there is no
   *  one answer, because the pile is per card. */
  const targetName =
    targetCategoryId === AUTO_CATEGORY
      ? null
      : (categories.find((c) => c.id === targetCategoryId)?.name ?? "this deck");

  const viewProps = {
    groups,
    marketplace,
    violations,
    onSelect: openCard,
    actions,
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
            {/**
             * The deck's identity: what it is called, which of its two lists is being read, and
             * how far apart they are.
             *
             * **`flex-wrap` and a floor on the field, because this row overflowed in the shipped
             * window and no test could see it.** Measured over CDP with Theory on: the field was
             * the only shrinkable child between two `shrink-0` siblings, so it collapsed to its
             * intrinsic minimum — **18px at 1100, 1200 and 1280** — while the switch and the
             * readout beside it spilled 180px / 80px out of this box and over the actions. At
             * 1200 the last pixels of the difference readout hit-tested to the *format select*:
             * a reader aiming at "0 cards differ" re-formatted their deck.
             *
             * So the narrowest things yield first, which is `DECK_FLOOR`'s rule one row up. The
             * field keeps {@link NAME_FLOOR}; the switch and the readout drop to a second line
             * when they no longer fit beside it. Nothing overlaps at any width, because nothing
             * is squeezed past its own content any more.
             */}
            <div className="flex flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <input
                aria-label="Deck name"
                // **`size={1}` is load-bearing, and it is not about the drawn width.** A text
                // input with no `size` defaults to 20 characters, and *that* is what a flex
                // container reports as its min-content — at this field's `text-xl` it measured
                // over 240px, which is what pushed the whole row of deck controls onto a second
                // line at 1280 even with the Theory switch off. With `size={1}` the intrinsic
                // width is a character and {@link NAME_FLOOR} is the only floor left, which is
                // the one this file actually chose. The width you see is the flex layout's.
                size={1}
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
                  "flex-1 rounded-md border border-transparent bg-transparent px-2 py-1",
                  NAME_FLOOR,
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

            {/**
             * The deck's controls. **Not `shrink-0`**, which is what made the row above
             * collapse: `flex-shrink: 0` on a `flex-wrap` container pins it at its
             * *max-content* width — measured at **692px, at every window size** — so it never
             * wrapped and every pixel of the squeeze fell on the deck's name instead.
             *
             * Shrinkable and wrapping, it gives way when there is nothing left to give: the
             * chips fold onto a second line rather than pushing the name out of the window.
             * `justify-end` so a folded line stays against the edge it belongs to.
             */}
            <div className="flex flex-wrap items-center justify-end gap-2">
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
                  // **"Import cards" and not "Import"**, which is what it said for one test
                  // run: the dialog it opens carries a control called `Import`, and two
                  // buttons with one name on screen at once is a pair a screen reader can
                  // only tell apart by position. It names what it puts in the deck, the way
                  // the gallery's `Import deck` names what it makes.
                  { kind: "import", label: "Import cards" },
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
            {/* The field, its suggestions and its status line are one control and live in one
                component. What stays here is the *decision* — which pile an add lands in, and
                the write that puts it there — because that is the editor's, and because the
                search answered a whole `CardSummary`: the type line is already in hand, so the
                auto arm costs nothing extra, which is the point of filing from a *found* card
                rather than from a typed name. */}
            <QuickAdd
              targetName={targetName}
              onAdd={(card) => addTo(card.id, targetCategoryId, card.typeLine)}
            />
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
                    view === id
                      ? "bg-accent font-medium text-accent-fg"
                      : "text-dim hover:text-text",
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
              {GROUP_BY_PICKER.map((option) => (
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
              {SORT_BY_PICKER.map((option) => (
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
              className={cn("h-8 w-44 rounded-md border border-border bg-bg px-2.5 text-xs", FOCUS)}
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
                      className={cn(
                        FILTER_CONTROL,
                        FILTER_FOCUS,
                        "h-8 px-2.5 text-xs",
                        filterChipState(on),
                      )}
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

      {/* The banner grows into place rather than shoving the whole desk down by its height the
          instant a write is refused — which, with four surfaces writing through six mutations,
          is a jump the reader sees while their eye is somewhere else entirely. The animated
          element is the wrapper and carries only `overflow-hidden`: `statusLine` takes
          `height` to 0, and under `box-sizing: border-box` a box with its own padding and
          border can never be shorter than the two of them. */}
      <AnimatePresence initial={false}>
        {bannerFailure && (
          <motion.div {...statusLine} className="shrink-0 overflow-hidden">
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              Could not change this deck — {bannerFailure}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

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
          <div ref={viewRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
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
              <DeckStats
                cards={deck.cards}
                marketplace={marketplace}
                send={deck.missingToWishlist}
              />
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

      {/* The strip under the deck. Spec §5: a price is never shown without saying how old it
          is — once, here, rather than as a tooltip on every one of sixty cards. And, while a
          card is in the air, the way out of the deck, drawn over it. */}
      <div className="relative shrink-0">
        <p className="text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>

        {dragging && (
          // The way out of a deck, for a hand that is already holding the card. It exists only
          // while a card is in the air, and it takes the place of the price line rather than a
          // place of its own: appearing in the flow would push every pile up by its own height
          // at the exact moment the reader is aiming at one.
          //
          // **Exactly the strip and not a pixel more.** `-top-3` is the `gap-3` above this
          // line, which is empty; the height is whatever the price line is. A tray taller than
          // that overhangs the deck, and an overhang here is a drop aimed at a pile's last card
          // that removes the card instead — the one mistake in this view with nothing to undo
          // it.
          //
          // No transition on either state — it appears instantly and it answers instantly. An
          // affordance that fades in during a drag is an affordance that is still arriving when
          // the reader has let go.
          //
          // Destructive rather than gold: gold is where a card is *going*, and this is the one
          // drop that takes something away. It names the card once it has it, because by then
          // the platform's drag preview is the only other thing saying which card this is.
          //
          // `aria-hidden` like the drop line: this is chrome for a gesture only a pointer can
          // make, and the click path it shortcuts — the stepper's zero — is the one a screen
          // reader is given.
          <div
            ref={trayRef}
            aria-hidden="true"
            className={cn(
              "absolute inset-x-0 -top-3 bottom-0 flex items-center justify-center gap-1.5",
              "rounded-md border border-dashed text-xs",
              // Above the popups rather than among them: a drag can start while a select is
              // open, and this is the target the pointer is being carried to.
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

      {/* The five overlays, mounted **at the editor's top level and as siblings of the layout
          above**, which is not a tidiness preference. Each is `fixed inset-0` and none is
          portalled, so a transformed ancestor would become its containing block and pin it to
          whatever box that ancestor happens to occupy — and this editor has transformed
          elements in it (a virtualised table's rows are `absolute` *and* `transform`ed, which
          is a stacking context and a containing block both). Mounted inside the view area, a
          drawer would cover a column instead of the window.

          Each is closed by `open`, and each of the five unmounts everything behind that flag —
          so a closed one costs no query, no window listener and no state. That is what makes it
          safe to mount all five unconditionally, and it is why the editor can hold them in one
          `Layer` union rather than five booleans. */}
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
      {/* The fifth overlay, and the one whose target has to be **the list on screen**: an
          import lands in one variant and a `replace` clears at most one, so a paste made while
          Theory is up must never touch what is sleeved. `cardsInVariant` is what a `replace`
          would clear, said in words before it is chosen.

          `dismiss` on the way out, whichever way the import ended: the trigger is one press
          away in the toolbar and the deck it wrote into is already on screen — the editor
          re-reads it, because every write in `useDeckImport` takes the `["decks"]` root with
          it. */}
      <ImportDeckDialog
        target={{ kind: "deck", deckId, variant, cardsInVariant }}
        open={layer?.kind === "import"}
        onDismiss={dismiss}
        onClose={close}
        onImported={dismiss}
      />
    </section>
  );
}
