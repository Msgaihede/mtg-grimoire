import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Redo2, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { FILTER_FOCUS } from "@/components/FilterChips";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { buildCardMenu, type CardMenuTarget } from "@/features/card/cardMenu";
import { useCardMenuDeps } from "@/features/card/useCardMenuDeps";
import { useSearchOpen } from "@/features/search/useSearchOpen";
import { LAYER } from "@/lib/layers";
import {
  ipc,
  ipcError,
  type CardSummary,
  type DeckCard,
  type DeckFinish,
  type DeckNote,
  type DeckPullRow,
  type DeckQuickAddWish,
  type DeckVariant,
} from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { PLAIN_PRESS } from "./headerControls";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useAppStore, type PaneDeckContext } from "@/lib/store";
import { nearestScroller, useDockHeight } from "@/lib/useDockHeight";
import { useMarketplace } from "@/lib/useMarketplace";
import { useScrollPaddingTop } from "@/lib/useScrollPaddingTop";
import { useUndocked } from "@/lib/useUndocked";
import { cn } from "@/lib/utils";
import { handled, NO_BATCH, newestWrite, writeFailure, type Write } from "@/lib/writes";
import { DECK_CARD_VARIANT, focusDeckGroup, keepsSelection } from "./cardControl";
import { AUTO_CATEGORY } from "./autoCategory";
import { defaultPileFor } from "./defaultCategory";
import { movedTo } from "./categoryDrag";
import { buildCategoryMenu } from "./categoryMenu";
import { buildDeckCardMenu } from "./deckCardMenu";
import { tracksCollection } from "./deckKind";
import { DeckBracket } from "./DeckBracket";
import { DeckDesk, type DeckBarProps, type RestoredView } from "./DeckDesk";
import {
  ACTIONS,
  DeckEditorHeader,
  SETTINGS_ICON_PX,
  TIGHT_HEADER_PX,
  TRANSFER,
  WIDE_HEADER_PX,
  type HeaderAction,
} from "./DeckEditorHeader";
import { DeckEditorLayers, layerMatches, type AddLabelSlot, type Layer } from "./DeckEditorLayers";
import { DeckLedger } from "./DeckLedger";
// **The band and never the editor it can open.** `DeckNotesPanel` reaches `NoteEditor` through
// `React.lazy`, so Tiptap's 141.5 kB gzip stays out of this chunk — an import of that module
// anywhere on this path would put it back with nothing going red. `DeckNotesPanel.test.tsx`
// sweeps `packages/ui/` for exactly that.
import { DeckNotesPanel, type DeckNoteRequest } from "./DeckNotesPanel";
import { DeckDescriptionPanel, shownDescription } from "./DeckDescriptionPanel";
// The same rule for the band under it: `DeckTodosPanel` reaches the editor through `React.lazy`
// in checklist mode, and this file names only the band.
import { DeckTodosPanel } from "./DeckTodosPanel";
import { notedOracleIds } from "./deckNotes";
import { useDeckNotes } from "./useDeckNotes";
import { useHiddenStacks } from "./useHiddenStacks";
import { DeckSearchPanel, MIN_PANEL_WIDTH_PX } from "./DeckSearchPanel";
import { usePrefetchDeckSearchWidth } from "./useDeckSearchWidth";
import { DeckStats } from "./DeckStats";
import { DeckTokensPanel, tokenWallDrawn } from "./DeckTokensPanel";
import { TokenArtPicker } from "./TokenArtPicker";
import { entryRef, pileTokens, type DeckTokenView } from "./deckTokens";
import { useDeckTokens } from "./useDeckTokens";
import {
  focusable,
  TOKEN_ADD_ATTR,
  TOKEN_BAND_ATTR,
  usePickCaret,
  useRemoveCaret,
} from "./tokenCaret";
import { tokenTheoryMark, tokenTheoryPlan } from "./tokenTheory";
import { TOKEN_PILE_ATTR, type TokenPile } from "./views/TokenPile";
import { useDeckUndo } from "./useDeckUndo";
import { deckCardSlot, dropWrite, type DragPayload } from "./dnd";
import { asGroupBy } from "./grouping";
import { RenameField } from "./metaRows";
import { PriceStrip } from "./PriceStrip";
// **`quickCollection` and not `quickAdd`**, which is a Windows filename hazard rather than a
// naming preference: `QuickAdd.tsx` — the toolbar's quick-add field — already sits in this
// directory, and a case-insensitive filesystem resolves `./quickAdd` to whichever of the two the
// resolver reaches first. `tsc` refuses the whole program with TS1149 and a suite that got past
// it went red with `quickAddShort is not a function`, having imported the component.
import { chooseWish, choosePullFor, missingPicks, type QuickAddTarget } from "./quickCollection";
import {
  BAR_WIDEST_PX,
  DECK_BAR_CLEARANCE_PX,
  type BarAction,
  type BarWidth,
} from "./DeckHeaderBar";
import { QuickAdd } from "./QuickAdd";
import { QuickZones } from "./QuickZones";
import { asSortBy } from "./sorting";
import { wishesSentNote, type WishesSent } from "./TheoryDiffDialog";
import { theoryMatchPlan, theoryProgress } from "./theoryMatch";
import {
  pullPlanQuery,
  quickAddWishesQuery,
  useDeck,
  useMissingPlan,
  usePullPlan,
} from "./useDeck";
import { useDeckDrops } from "./useDeckDrops";
import { useDeckKeyboard } from "./useDeckKeyboard";
import { useDeckMeta } from "./useDeckMeta";
import { useFormatSpecs } from "./useFormatSpecs";
import { useRecentAdds } from "./useRecentAdds";
import { ValidationPanel } from "./ValidationPanel";
import { validateForMarks } from "./validation/engine";
import { violationsBySlot } from "./violations";

/**
 * Narrowest the deck itself may be squeezed to, in px, before the docked search panel gives
 * way to its rail.
 *
 * The rule is "the narrowest thing yields first", one level up from the views, which wrap.
 * Three docked columns do not fit in a 1024px window: sidebar, padding, the card pane and the
 * panel come to 1044 before the deck gets a pixel, and the deck was measured at **2px** before
 * this existed, which reads as a rendering fault rather than as a squeeze.
 *
 * **Every measurement below was taken with the card pane docked beside the editor, and that is
 * history rather than the current layout** (issue #183, 2026-08-22). The pane is an overlay over
 * one of this row's two columns now and takes no width from either, so the "card pane" column in
 * the table is a state the app cannot be in any more. The figures are kept because they are what
 * this constant's value was derived from and because they are the evidence for the rule — *the
 * narrowest thing yields first* — which has not changed. What has changed is that the case the
 * number was tuned against no longer arises, so 192 now binds only on a genuinely narrow window.
 *
 * 208 rather than the 224 this was first drawn at, and the 16px is a *scrollbar*: the page's
 * own, which the arithmetic did not count. At 1280 with a card open the row measured **617**,
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
 * **192 rather than 208, and it is the same 16px correction a second time.** The editor became a
 * scroller when the stats moved under the deck ({@link DECK_HEIGHT_FLOOR}), so the row now pays
 * for *two* scrollbars rather than one: measured at 1280 with a card pane docked, it is **602**
 * against the 617 in the table above, which leaves the deck **202** — and a 208 floor collapsed
 * the panel at the app's default window size, which is precisely the failure the drop from 224
 * to 208 existed to prevent. The reasoning is the earlier paragraph's, applied to the scrollbar
 * the arithmetic did not count this time. `scrollbar-width: thin` was measured too and is not an
 * answer: it costs 10px instead of 15 and lands on **207**, one pixel short of the old floor.
 *
 * 192 is the sidebar's 208 less that scrollbar — still a column by the app's own evidence, and
 * still far from the 2px this constant exists to rule out.
 *
 * **The desk row holds two things, which is what the table above was measured against.** It
 * briefly held three: the rebuild put a 280px stats aside between the view and the panel, and
 * that width was subtracted here before the panel was asked whether it fit — so opening Stats
 * at 1280 with a card pane docked cost the reader their search, and a toolbar toggle existed
 * for no reason other than to give the width back. The stats are a band **under** the deck now
 * (the section at the foot of this component), so the deck and the panel are measured against
 * each other and against nothing else.
 */
const DECK_FLOOR = 192;

/** The `gap-4` between the two things on the desk, which both of their widths have to be
 *  counted with. */
const DESK_GAP = 16;

/**
 * The narrowest column the Description, Notes and To-do bands are drawn in side by side (issues
 * #685 and #912). The row holding them fits as many columns as it holds this plus a `gap-x-6`
 * each, and one full-width column otherwise, so this is the whole of where the folds happen —
 * **920px of row** for two and **1392px** for three. A deck with no description draws no
 * Description band, so its row holds two tracks at most.
 *
 * 28rem because each band's own card grid holds one 280px track of cards and grows a second at
 * **568px** (280 twice plus its 8px gutter — `NOTE_GAP` and `TODO_LIST_GAP` agree), so a column
 * this wide shows each band one comfortable track at the fold. It was 32rem while the row held
 * two bands; with three, 32rem would only line them up on a row of 1584px, which a window with a
 * docked search panel rarely has. Much narrower and a band at the fold is one card squeezed
 * toward its floor. A CSS length rather than a pixel count because the template is a string,
 * spelled in an inline `style` rather than an arbitrary Tailwind value for Tailwind's
 * whole-class-name rule.
 */
export const NOTES_TODOS_COLUMN = "28rem";

/**
 * Which deck the editor has restored the remembered controls for, and under which readings of
 * the theory switch — the marker the restore is honoured against. See it for what each half is
 * holding off, and {@link NEVER} for the deck it has not reached yet.
 *
 * `switches` holds at most the two values a `boolean` has, which is the whole point of it being
 * a list: a restore that may run once per *reading* can run twice per deck and then not again,
 * however far the two cached copies of the deck row drift apart.
 */
interface Restored {
  deckId: number;
  switches: readonly boolean[];
}

/** A deck this editor has not restored anything for yet — the other deck's readings are not
 *  this deck's, so switching decks reads this rather than {@link Restored.switches}. */
const NEVER: readonly boolean[] = [];

// The export dialog's subject, card list and file name — `exportSubject` and `exportFileName` —
// moved to `./deckExport`, store-free, so the light app's phone face exports a deck through the
// same three answers. Re-exported here, where this file's tests and callers have always found them.
export { exportFileName, exportSubject, type ExportScope } from "./deckExport";

// `layerMatches` moved to `./DeckEditorLayers` with the `Layer` union it reads (issue #557), and is
// re-exported here for the same reason the three above are: this file's tests have always found it
// here.
export { layerMatches } from "./DeckEditorLayers";

/**
 * A tile in the docked search panel, as a card menu describes it.
 *
 * **No `finish`**, for the search wall's reason: a result is a *printing* and not a copy, so
 * "Add to → Collection" records the printing's own default finish — the one the tile draws.
 * `typeLine` travels because `CardSummary` carries it and a menu add is filed by what the card
 * does — the same fact, off the same row, that this panel's drag payload already hands a drop.
 */
function searchCardTarget(card: CardSummary): CardMenuTarget {
  return {
    cardId: card.id,
    name: card.name,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    oracleId: card.oracleId,
    finishes: card.finishes,
    typeLine: card.typeLine,
  };
}

/**
 * How long the quick zones' "nothing to do" sentence stays up.
 *
 * Long enough to be read after a gesture the reader's eye was following elsewhere, short enough
 * that it is gone before it could be mistaken for a statement about the *next* card. It is a
 * hint about one press rather than a state of the deck, which is the whole difference between
 * this and the refusal banner above it — that one stays until another write replaces it.
 */
const REFILE_NOTE_MS = 6000;

/**
 * What `deck_add_card` answers for `EntryChange.id` when the add made **no deck card** — the
 * printing was a token, a double-faced token or an emblem, and Rust filed it as a token entry
 * instead (token stacks, spec §4.6: *tokens never become deck cards*, whichever pile they were
 * dropped on). No SQLite row is numbered 0, so this is a sentinel and never an address, and the
 * landed mark skips it ({@link DeckEditor}'s `markAdded`): there is no card to point at. The
 * token shows up on the Tokens & Emblems band — and in the views' pile too, at the copies the add
 * filed — both re-read by the add's own `["decks"]` invalidation.
 */
const NO_DECK_CARD = 0;

/**
 * What the Tokens & Emblems printing picker is open for, or `null` while it is shut — an
 * **entry's key** for a swap, and nothing at all for an add, because an add is about every token
 * the deck brings. Never a frozen view; {@link DeckEditor}'s `pickingToken` says why.
 */
type TokenPicking = { kind: "swap"; entryKey: string } | { kind: "add" } | null;

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
 * them, and which of its layers is open. It draws no card and no group heading itself —
 * `grouping.ts` says what the groups are and `views/` draw them, so four surfaces cannot answer
 * "how many cards are in the Ramp column" four ways.
 *
 * **Three of those decisions outlive the editor**: the variant, the grouping and the sort are
 * columns on the deck row, restored on the way in and written on every press
 * (`deck.rememberView`). The view, the filter, the label chips and the stats block are not —
 * they are how the reader is looking *now*, and a deck that reopened filtered would be a deck
 * missing cards until somebody noticed the field.
 *
 * **Where each part of it lives since issue #557**, which split one function of ~6 350 lines along
 * the seams it already had. This file keeps what decides *which deck and which list* and every
 * write: the variant and its restore, the deck's reads, the layer slot, the menus, the banners.
 * {@link DeckDesk} owns how the deck is *looked at* — the view, the grouping, the sort, the filter
 * — and draws the toolbar, the undocked bar and the desk, so a keystroke in the filter re-renders
 * the desk and nothing above it. `DeckEditorHeader` is the header's first line, `DeckEditorLayers`
 * every overlay and the `Layer` union, `useDeckDrops` every write a drop makes, and
 * `useDeckKeyboard` the two window bindings.
 */
export function DeckEditor({ deckId }: { deckId: number }) {
  // Live until the deck row says otherwise, which it does on the first read — a deck nobody has
  // switched remembers `"live"` too, so this is the same answer arriving twice rather than a
  // guess the restore has to correct.
  const [variant, setVariant] = useState<DeckVariant>("live");
  // Every price on this screen — four views, every heading, the stats strip and the line under
  // the deck — is quoted from here. Read once at the top of the editor and threaded, so no two
  // surfaces of one deck can name two marketplaces.
  const { marketplace } = useMarketplace();
  const deck = useDeck(deckId, variant);
  // The search column's remembered width (issue #932), asked for beside `deck_get` rather than
  // when the column mounts after it — see `usePrefetchDeckSearchWidth`.
  usePrefetchDeckSearchWidth(deckId);
  /*
   * **`useAddMode` was read here from 2026-08-23 to 2026-08-25 and is deleted.**
   *
   * It held one answer for the editor's two click-to-add paths — the docked panel's Add button
   * and the toolbar's quick-add field — because a control drawn on one of them governed both.
   * With the control gone every add here means "I need this", which is the mode a reader who
   * never pressed the pair was already on, and there is no answer left to hold. `useDeck`'s
   * owned arm and `NormalSearchAdd`'s hunt for a free copy went with it: moving a copy the
   * reader owns into this deck is `collection_to_deck`, which the Collection tab presses.
   */
  const { formatSpecFor } = useFormatSpecs();
  /**
   * The right-click, and everything a card menu needs that is not the card.
   *
   * **One `CardMenuDeps` for this whole screen**, from the hook every other card surface uses:
   * the collection add's four invalidation keys and the wishlist add's two are written down once
   * there, and this page spelling them out again would be one more place for one rule to
   * drift. What this editor answers differently is `printingsDeck` — the **deck slot** a press
   * inside the printings modal writes to — and that is a *per surface* answer rather than a
   * per-screen one: the deck's own cards are rows of this deck and hand their slot over, the
   * docked panel's tiles are not and hand over nothing. So it is spread over at the first of the
   * two builders below and deliberately absent from the second, rather than fixed here.
   *
   * `menu(build)` takes a **thunk**: a deck of a hundred cards builds no menu at all until a
   * reader right-clicks one of them.
   */
  const { menu, menuKey } = useContextMenu();
  const tip = useTooltip();
  const { deps: cardMenuDeps, error: menuFailure } = useCardMenuDeps();
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const paneDeckContext = useAppStore((s) => s.paneDeckContext);
  const openCardFromDeck = useAppStore((s) => s.openCardFromDeck);
  /**
   * The picked set's clear, taken straight off the store rather than from `useCardSelection`
   * below it.
   *
   * The hook is measured along `groups`, which is derived near the bottom of this component, and
   * two writes up here need to stand a set down — a drop that has just moved every member, and
   * the Delete that has just removed them. Neither needs the set's *contents*, only the clear,
   * and the store's setter is the same function the hook would have handed back.
   */
  const setCardSelection = useAppStore((s) => s.setCardSelection);
  /**
   * Close the deck — the ribbon's `Back to decks` button and Escape's floor, as one callback.
   *
   * **Two entrances to one act, so there is one function rather than two spellings of it.** The
   * button and the key must not be able to drift: whatever closing a deck comes to mean — a
   * confirmation, a last write flushed, a note left for the gallery — is written here and both
   * paths get it.
   */
  const closeDeck = useCallback(() => setOpenDeckId(null), [setOpenDeckId]);
  /**
   * **Escape's floor on this screen: the deck closes.**
   *
   * `"navigation"` is the bottom rung, so this fires only on a press nothing nearer wanted —
   * every dialog and popup here is `"inner"` and outranks it (the card is one of them since
   * 2026-09-03, when the docked pane that held the `"outer"` rung beside this desk was deleted),
   * and a filter box with text in it spends the press before any of
   * them (see {@link clearFieldOnEscape} on the toolbar's field below). One press closes one
   * thing, all the way down.
   *
   * **Always enabled**, because an open editor always has somewhere to go: the gallery it was
   * opened from. There is no state in which this rung would be a listener with nothing to do.
   *
   * **The caret is handed back by the same route the button's press uses**, and that is
   * {@link closeDeck} doing exactly one thing: `setOpenDeckId(null)` writes `returnToDeckId` in
   * the store, and `DecksPage` reads it to open the folder the deck is filed in and put the caret
   * on the deck's own tile. So Escape lands the reader precisely where `Back to decks` does —
   * which is what "Escape hands the caret to the opener" means at this rung, one view up.
   */
  useDismissOnEscape({ layer: "navigation", onDismiss: closeDeck });

  const row = deck.deck;
  const spec = row ? formatSpecFor(row.formatKey) : null;
  /** The deck's description as its band draws it, or `null` — which draws no band (issue #912). */
  const description = shownDescription(row?.description);
  const loading = deck.query.isPending;
  const readFailure = deck.query.isError ? ipcError(deck.query.error) : null;
  /** The read succeeded and answered nothing: another view deleted this deck. */
  const gone = !loading && !deck.query.isError && deck.query.data === null;

  /**
   * Whether this deck keeps a plan at all — the switch, the Compare button and the whole of
   * what {@link Layer}'s `theoryDiff` arm is reachable from.
   *
   * **The deck's *other* list is no longer read here** (2026-08-20). A second `useDeck` under
   * the opposite variant's query key sat on this line for one readout — "N cards differ" — and
   * it was a second, disagreeing implementation of a comparison the backend already owns:
   * it keyed rows on `(categoryId, cardId)` and counted **both** directions, so a card the two
   * lists file in different piles scored two and a hundred-card deck routinely read as a
   * hundred and fifty differences. The button says `Compare` and the dialog behind it answers,
   * through `deck_theory_diff`, so there is exactly one rule again — and a deck with a plan
   * costs one `deck_get` rather than two.
   */
  const theoryEnabled = row?.theoryEnabled === true;

  /**
   * Whether this deck reads the reader's collection at all — `deckKind.ts`'s
   * {@link tracksCollection}, answered **once here** and handed to the five surfaces that owe a
   * reader an owned readout.
   *
   * **A Virtual deck is the `false` case** (issue #401): a list the reader tracks without owning
   * the cardboard, so it has no `collection_folders` group and every owned figure would be a `0`
   * about cardboard nobody ever claimed to have. What goes with it is the whole of what this
   * editor says about a binder — `DeckStats`' shortfall block and its three presses,
   * `DeckLedger`'s `Owned` term, `PriceStrip`'s `Recently removed` note, `TableView`'s `Owned`
   * column, the docked panel's Collection tab, and the card menu's `Collection ▸` submenu.
   *
   * **One answer handed down, never `deckKind(row)` spelled at six sites**, which is
   * {@link separateX}'s arrangement one flag over and for its reason: a curve and a heading that
   * each decided for themselves would be two surfaces answering one question about one deck two
   * ways. It is also why every one of those props is **required** rather than optional — a host
   * that has not thought about it must not silently get the collection-reading case.
   *
   * **A row that has not answered reads as `false`, and the direction is the argument.** Only
   * {@link PriceStrip} is drawn before `deck_get` lands — everything else in this list is inside
   * a `row &&` — so the choice is between its `Recently removed` note appearing a beat late on
   * every deck, and appearing and then being taken away on a virtual one. A page filling in is
   * what a reader expects of a load; a promise withdrawn is not. It is also `deckKind`'s own
   * tie-break read one step out: where the answer is not in, show *less* of the collection rather
   * than more.
   */
  const tracks = row !== null && tracksCollection(row);

  /**
   * Whether the ledger's `Game Changers` chip is pressed — **the thing that answers _which cards
   * are the game changers_**, where the count printed on that same chip says how many.
   *
   * It spent a day in the toolbar's label-filter row (2026-09-09 → 2026-09-10) and is back beside
   * the bracket, merged into the readout it belongs to; {@link DeckLedger} carries why.
   *
   * Plain `useState` like the two above it and persisted nowhere: which cards a reader is
   * looking at right now is a fact about the sitting, not about the deck. What is *derived* from
   * it is {@link gcFilter}, and the derivation is the fence — see it.
   */
  const [gcOnly, setGcOnly] = useState(false);
  const [layer, setLayer] = useState<Layer>(null);
  /**
   * A **read** the reader pressed for and that refused, as a sentence — the wishes behind
   * `Quick add and remove from wishlist`, or the plan behind a card's `Pull …`.
   *
   * **In the write banner rather than in a second sentence of its own**, which is the one thing
   * about this state worth arguing. Both reads are made *inside* a press: the reader chose a
   * menu row, the row promised an act, and the act cannot happen — so what has failed is the
   * press, not a background query, and the press's family is the banner. It is also the only
   * place either could be said at all: the menu closes before its handler runs, and neither
   * read has a surface of its own until it has answered.
   *
   * Cleared on the next press of either row rather than on a timer, so a sentence stays up for
   * as long as it is the last thing that happened — {@link bannerFailure}'s own rule, since a
   * refused write's sentence stays until another write replaces it.
   */
  const [pressReadFailure, setPressReadFailure] = useState<string | null>(null);
  /**
   * The pile whose heading is showing its rename field, or `null`.
   *
   * **Not a `Layer` arm**, and the difference is what a `Layer` means: those are full-window
   * surfaces of which at most one may be up, and this is an inline field on the desk that the
   * reader can have open *while* a card's menu is open over it. It is also the one editor state
   * a view draws rather than the editor — the field is built here and handed down as a node,
   * because four views must not each own a draft.
   */
  const [renamingCategoryId, setRenamingCategoryId] = useState<number | null>(null);

  /* There is no `dragging` state here any more, and its absence is the 2026-08-16 change stated
     in one line: the editor used to run a `monitorForElements` of its own so the remove tray
     could be drawn from it, which re-rendered this component — and with it all four views,
     `DeckStats`, `ValidationPanel` and the docked panel — on every deck-card `dragstart` and
     `drop`. {@link PriceStrip} owns that monitor now and re-renders itself instead, which is
     `QuickZones`' argument applied to the other end of the same gesture. */

  /**
   * Which cards have just arrived, so the deck can point at them for five seconds.
   *
   * Held here rather than in a view, because the three surfaces that add a card — the quick-add
   * field, a drop onto a pile, and the docked panel's own Add button — are all *this*
   * component's or its children's, and the four views that draw the mark are all below it. It is
   * also the reason the panel takes an `onAdded`: it presses the editor's mutation itself
   * (`add={deck.addCard}`), so the one add path that does not run through {@link addTo} has to
   * hand its answer back.
   *
   * **Both paths mark through `markAdded`, which skips {@link NO_DECK_CARD}** — the answer an add
   * Rust rerouted to the tokens gives. A token dropped on a pile made no deck row, so there is
   * nothing to point at; arming the mark against `0` anyway would be a timer and a re-render
   * aimed at a row id no card has.
   */
  const { landed, markLanded } = useRecentAdds();
  const markAdded = useCallback(
    (entryId: number) => {
      if (entryId !== NO_DECK_CARD) markLanded(entryId);
    },
    [markLanded],
  );

  /**
   * The deck this editor has already put the remembered controls on screen for, and **which
   * readings of the theory switch it has done it under** — so the restore below runs once per
   * *question* rather than once per answer. See it for why both halves are load-bearing: this
   * file has crashed the window twice over that difference.
   *
   * A **list** of readings rather than the latest one, and that is the fix rather than a detail
   * of it. There are only two readings a deck can have, so honouring each at most once bounds
   * the restore at two runs per deck **by construction** — which is the property the marker
   * needs and the one a "has it changed?" comparison cannot have, because the value it compares
   * is one the restore itself can move. The restore below says the rest.
   *
   * State rather than a ref, and not a stylistic choice: this is React's own "adjusting state
   * when a prop changes" pattern, where the previous value is held in state precisely so the
   * comparison and the update are both part of the render the new value arrived in. A ref read
   * during render is the thing `react-hooks/refs` forbids, and for the reason that would bite
   * here — a ref written in a render React then discards would leave the editor believing it
   * had honoured a deck it never drew.
   */
  const [restored, setRestored] = useState<Restored | null>(null);
  /** What the restore below decided about the two pickers `DeckDesk` owns — see `RestoredView`. */
  const [restoredView, setRestoredView] = useState<RestoredView | null>(null);

  const editorRef = useRef<HTMLElement>(null);
  /** The row the deck and the panel share, and the only width either of them can be judged
   *  against — the window's own is three layouts away from it. */
  const deskRef = useRef<HTMLDivElement>(null);
  /* There is no ref on the box the view draws into, and its absence is the 2026-08-14 change
     stated in one line: that box was the editor's scroller and the thing a drag auto-scrolled,
     and it is neither now — the views grow to hold their content and the page takes the scroll.
     It said "three of the four" until 2026-09-08, the fourth being the table, whose own
     scrollport was `VirtualTable`'s and one element further in than any ref here could reach;
     that view grows too now and there is no scrollport left in here at all. */
  /** The box the docked search panel is pinned inside — see {@link DeckEditor}'s dock effect. */
  const dockRef = useRef<HTMLDivElement>(null);
  /**
   * The header's third line, and whether it has scrolled up out of the page (issue #577).
   *
   * **Docked** is the header drawn where it always was; **undocked** is that line gone above the
   * top of `AppShell`'s `main`, which is when {@link DeckHeaderBar} comes down in its place with
   * the controls a reader reaches for mid-deck. The line rather than the whole header, because the
   * toolbar is what the bar stands in for: while any of it is on screen there is nothing to stand
   * in for.
   *
   * **An observer, never a scroll listener** — {@link useUndocked} answers only when the answer
   * flips, so this editor re-renders twice per trip down the page rather than once per frame of it.
   * Held in state through a callback ref because the line mounts only once `deck_get` answers.
   * jsdom's stub observer never fires, so no existing test ever sees the bar.
   */
  const [toolbarLine, setToolbarLine] = useState<HTMLDivElement | null>(null);
  const undocked = useUndocked(toolbarLine);
  /**
   * How far down the page the two other sticky things on it start while the bar is down: the
   * search panel's dock (its `top`, and the height {@link useDockHeight} draws it) and the Table
   * view's column header (through `--sticky-top`, on the view box only — the panel's own tables are
   * scrollers of their own and must not inherit it). Neither moves for a drag, when the bar hides
   * under the quick zones: those cover the top 92px anyway, and a drag must not re-render this.
   */
  const barClearance = undocked ? DECK_BAR_CLEARANCE_PX : 0;
  /** The header's first control, where the caret goes when the bar's ↥ takes the reader back up. */
  const backRef = useRef<HTMLButtonElement>(null);
  /** A caret the page scrolls to must not land under the bar (WCAG 2.4.11) — see the hook. */
  useScrollPaddingTop(editorRef, barClearance);
  /**
   * How wide the desk row is — **width only, and the height that used to sit beside it is gone**
   * (2026-08-14).
   *
   * The row's height is its content's now, so a number read off it is a number this component's
   * own output decides. Its one reader was `TextView`'s `columnHeight`, which would have packed
   * taller columns into a taller desk into a taller pack; the view takes a fixed readable target
   * instead and this measurement is about the axis the desk really does have to share.
   */
  const [deskWidth, setDeskWidth] = useState(0);
  /**
   * How wide the window is, for the half-of-it cap on the docked panel's drag.
   *
   * `document.documentElement.clientWidth` rather than `window.innerWidth`, which is this app's
   * rule wherever a viewport width is used for anything: `innerWidth` counts the classic vertical
   * scrollbar and the layout does not — 1280 against 1265, measured — and the editor is a
   * scroller, so this surface always has one. `0` is jsdom, which has no layout engine at all,
   * and is read below as "not measured" rather than as a window of no width.
   */
  const [viewport, setViewport] = useState(0);
  /**
   * How to give the caret back when the layer that is up closes — **a function, not an
   * element, and that is the whole point of it.**
   *
   * A toolbar button hands back to itself. A **menu row has no control to return to**, and
   * `null` there is not "no hand-back needed": `Dialog` focuses its own panel on mount and
   * restores nothing, so a `null` opener leaves the caret on a panel that is unmounting and
   * drops it on `<body>` — the next Tab then restarts from the top of the app. That is the
   * failure `DecksPage.test.tsx` already documents in those words, and it is the third time on
   * this branch that a caret was handed to something that could not take it.
   *
   * A function is what lets the menu rows answer honestly: they hand back to the **pile** the
   * menu was opened on, through `focusDeckGroup`, which finds the group by attribute at the
   * moment it is called rather than holding an element that a rename or a re-pack may have
   * replaced. An element ref could not have expressed that, and widening this to `HTMLElement`
   * would only have moved the same lookup earlier and made it stale.
   */
  const handBackRef = useRef<(() => void) | null>(null);
  /** The format check's button, which owns its own trigger ref because `ValidationPanel` draws
   *  the button itself. */
  const chipRef = useRef<HTMLButtonElement>(null);
  /** The bracket readout beside it, for the same reason — `DeckBracket` draws its own trigger. */
  const bracketRef = useRef<HTMLButtonElement>(null);
  const tookFocus = useRef(false);

  /**
   * The deck's piles and labels **as things in themselves** — what the category menu writes
   * through, and where the menu's "New label…" now makes its label.
   *
   * **Four local-SQLite reads on every deck opened, and they are paid deliberately.** The
   * categories (a *priced* per-category aggregate), the labels of the list on screen, the labels
   * of the **other** list, and the global suggestion palette — counted off `useDeckMeta.ts`'s four
   * `useQuery` calls, every one of them `enabled` on nothing but the deck id. Two things make that
   * the right trade *here* and made it the wrong one inside a lazy menu body, which is where this
   * hook was refused a round earlier: a reader **opening a deck** already pays a
   * `deck_get` of the whole deck, its cards, its categories and its labels, so four more local
   * reads sit inside an act that is already a read; and what they buy is not one write but every
   * write the category menu makes — rename, the switch, delete — each from its single
   * definition. The lazy body paid the same four to draw a text field the reader might never
   * type in.
   *
   * The Categories dialog mounts the same hook against the same `["decks"]`-rooted keys, so
   * opening it after this is free rather than four reads again.
   */
  const meta = useDeckMeta(deckId, variant);

  /**
   * The menu's "New label…" — a label made and put on the card, as one act.
   *
   * **`useDeckMeta.createLabel`, the single definition**, now that the hook is mounted above for
   * the category menu. It replaced a hand-rolled `useMutation` over `ipc.deckLabelCreate` whose
   * whole justification was avoiding this mount; that justification stopped being true, so it
   * was deleted rather than corrected.
   *
   * **The chain's second half is the editor's, which is the part that must not regress.** A
   * `useMutation`'s callbacks belong to its *observer*, and TanStack drops them when the observer
   * unmounts — so a create started from inside the menu and chained there loses its attach to any
   * dismissal landing during the round trip, leaving the label made and silently never worn. This
   * observer is **this component's**, and the editor is still on screen when the answer arrives.
   * `DeckEditor.test.tsx`'s "attaches a label whose create was still in flight when the menu was
   * dismissed" is the proof, and it holds Escape between the press and the answer.
   *
   * **`mutateAsync` rather than a per-call `onSuccess`, and the difference is a second create.**
   * Those callbacks live on the *observer*, and starting a second mutation on one observer
   * removes the first's — so two "New label…" presses inside one round trip would create both
   * labels and attach only the second's. The promise belongs to the call rather than to the
   * observer, so each attach survives the next press. Narrow, but it costs a line and it is
   * strictly the stronger shape; the observer's own state still drives the banner, which is why
   * the rejection is swallowed here and not reported here.
   *
   * **The colour is the reader's and arrives with the name**, which is what changed on
   * 2026-08-20. It used to be `DEFAULT_LABEL_COLOR`, chosen here and never asked for, because the
   * control was a text field inside a context menu with no room for a picker — so every label a
   * reader made this way was gold and had to be visited in the Labels dialog to be told from the
   * last one. `AddLabelDialog` asks for both, and this chain is otherwise untouched.
   */
  const startLabelCreate = meta.createLabel.mutateAsync;
  const setLabelOnSlot = deck.setLabel.mutate;
  // The category menu's two direct writes, taken as `mutate` for the reason every other write
  // here is: TanStack hands back a fresh result object each render, and these end up in
  // `useCallback` dependency lists that the four views' group elements are built from.
  const setCategoryActive = meta.setCategoryActive.mutate;
  const renameCategory = meta.renameCategory.mutate;
  const renamePending = meta.renameCategory.isPending;
  /**
   * **The delete confirmation's sentence has to be cleared when the confirmation opens**, and
   * `reset` is what does it — `DecksPage`'s `decks.create.reset()`/`folders.create.reset()`
   * before each of its dialogs, for exactly this reason.
   *
   * This observer is the **editor's**, so it outlives every open of the `deleteCategory` layer —
   * unlike the meta dialogs', which live in a body `Dialog` unmounts and start clean by
   * construction. Without this a refused delete left the mutation in `isError`, and the next
   * `Delete…` drew its `role="alert"` on mount: a sentence *announced on insertion*, about a
   * press the reader had not made, naming a pile it was never about.
   *
   * **It clears the editor's own banner too, and that is right rather than incidental.** The
   * banner speaks for the newest of {@link writes}, this is one of them, and a reader opening the
   * question again is starting the write over — a stale refusal outliving the attempt that
   * produced it is the same bug one rung out.
   *
   * Stable for the component's life, like every `mutate` above it: TanStack binds `reset` on the
   * observer, so putting it in a dependency list costs the menu memo nothing.
   */
  const resetCategoryDelete = meta.deleteCategory.reset;
  /** The clear's half of the pair above, and it is owed for the same reason: this observer is
   *  the editor's and outlives every open of the `clearCategory` layer, so without the reset the
   *  question reopens with the last refusal already announced inside it. */
  const resetCategoryClear = deck.clearCategory.reset;
  // The clear's write and its pending flag are read where the confirmation is drawn —
  // `DeckEditorLayers` (issue #557).
  const createLabelFor = useCallback(
    (slot: AddLabelSlot, name: string, color: string) => {
      void startLabelCreate({ name, color })
        .then((label) =>
          setLabelOnSlot({
            cardId: slot.cardId,
            categoryId: slot.categoryId,
            finish: slot.finish,
            labelId: label.id,
          }),
        )
        // The refusal is already on the observer, and the observer is in the banner family above.
        // Swallowed here so a refused create is a sentence rather than an unhandled rejection.
        .catch(() => {});
    },
    [startLabelCreate, setLabelOnSlot],
  );

  /** Putting an **existing** label on the slot — `createLabelFor` without the create. One write
   *  rather than two, and the same `deck_card_set_label` grain, which is the whole reason the
   *  slot is frozen rather than looked back up. */
  const setCardLabelOnSlot = useCallback(
    (slot: AddLabelSlot, labelId: number) => {
      setLabelOnSlot({
        cardId: slot.cardId,
        categoryId: slot.categoryId,
        finish: slot.finish,
        labelId,
      });
    },
    [setLabelOnSlot],
  );

  // Every write the editor's **own banner** speaks for — the array is the list, deliberately not
  // a number in this sentence, because it has been recounted twice in one day. The *latest* of
  // them owns it, not
  // whichever is still holding an error: a refused move used to leave its sentence up while the
  // reader went on to rename the deck successfully (the collection table's lesson). That rule
  // is `lib/writes.ts` now, shared with the gallery, the settings dialog and the categories
  // dialog, because four copies of it were four places to keep one rule — and one of the four
  // had it backwards. The docked panel's add is deliberately not here — it says so in the
  // panel, beside the button that was pressed, and two banners for one refusal would be worse
  // than one in the wrong place.
  //
  // **The two right-click menus of 2026-08-14 are what the tail of this list is.** `setLabel`
  // sat outside the family for as long as nothing in the app could reach it, and the four
  // `useDeckMeta` writes below it had no control in this view at all — they were the Categories
  // dialog's, which draws its own sentence for its own observer. A write a reader can now make
  // from a card's menu or a pile's heading is a write whose refusal has to be said somewhere,
  // and the menu that started it has closed by the time an answer arrives.
  //
  // **`useDeckMeta`'s four are a *different observer* from the dialog's** — TanStack shares a
  // query's cache between observers and a mutation's state with nobody — so this banner speaks
  // only for presses made out here, and the dialog goes on speaking for its own.
  /**
   * Undo and redo for this deck — the cursor comes from the backend, the redo stack lives in
   * the hook for the length of the session.
   *
   * Mounted here rather than beside its buttons because the banner below reads its refusal, and
   * that line is computed at the top of this component.
   */
  const undo = useDeckUndo(deckId);

  /**
   * The tokens and emblems this deck makes — **read once, here, for every surface that draws
   * them** (issue #507). The Tokens & Emblems band and the pile each view draws are two drawings
   * of one answer: a quantity stepped on one is the number the other draws, and a token stepped to
   * 0 on the band leaves the pile. A hook call per surface would be two write observers, each free
   * to own a refusal the other never hears about. ({@link planTokens} is a second call and not a
   * second drawing: it reads the *other* list, for the plan's marks, and draws nothing.)
   *
   * **One view per entry** since token stacks PR 2 (user schema v52, spec §4.2) — a token with a
   * foil and a regular copy in this list is two views — and every write addresses an entry.
   *
   * **Declared here, above {@link bannerWrites} and {@link lastOfAny}, and not beside the rest of
   * the token wiring**, because its `writes` join both: every token write is journalled since PR 2
   * (spec §4.7), so a token write is a deck write the redo stack has to be thrown away after, and
   * a refused one has to be said somewhere while the band that would say it is shut. A `const`
   * read above its own declaration is a `ReferenceError` on the first render.
   */
  const deckTokens = useDeckTokens(deckId, variant);

  const writes = [
    deck.setQuantity,
    deck.clearCategory,
    deck.moveCard,
    deck.refileCard,
    deck.update,
    deck.setLabel,
    // The finish write, whose three refusals — already that finish, a printing not sold in it,
    // a row that is not in the pile — all arrive after the menu that made the press has closed.
    deck.setCardFinish,
    meta.createLabel,
    meta.renameCategory,
    meta.setCategoryActive,
    // A pile dragged past its neighbours on the desk, which is the fifth `useDeckMeta` write a
    // reader can now make without opening the Categories dialog — and the one whose refusal is
    // least visible on its own, because the optimistic order below puts the column back and
    // nothing else on screen says why it moved.
    meta.reorderCategories,
    meta.deleteCategory,
    // **The quick add, and it is in this family on purpose even though it writes no
    // `deck_cards` row** (2026-09-03, issue #350). Every argument the family is built on holds:
    // it goes through `touch_deck`, so it answers the same `deck::GONE` and must not leave a
    // dead deck painted; it is pressed from a card's right-click, which has closed by the time
    // an answer arrives, so its refusal has nowhere else to be said; and its two other refusals
    // (`NOT_IN_DECK`, and a wish that moved under the reader) are exactly the kind this banner
    // exists for. What it records is the copies a deck row is short of, so "a write to what is
    // in the deck" is true of it in every sense but the table it touches.
    deck.quickAddToCollection,
    // **The deck-wide record, for the same reason since issue #510**: a picked set's quick add
    // presses it straight from a card's right-click, whose menu has closed by the time a refusal
    // arrives. The stats band's dialog still says its own refusal inside its panel.
    deck.addMissingToCollection,
    // **The card menu's `Add to actual` / `Add to theory`** (issue #592). An add like
    // `deck.addCard`, which stays out of this list because the docked panel says its refusal
    // beside its button — this one is pressed from a menu that has closed, so it is said here.
    deck.addToOtherList,
  ] as const;
  // **The undo hook's own refusal joins this banner rather than drawing a second one.** Its
  // two mutations are writes to what is in the deck like any other, and its commonest refusal
  // — "the deck has been edited since" — is exactly the kind this line exists to say. It is not
  // in `writes` because it is not a `useMutation` the array's type accepts: `useDeckUndo`
  // reports through a string of its own so that it can also drop a redo that can never work.
  // **And a read the reader pressed for**, which is {@link pressReadFailure}'s own argument:
  // the two menu rows that fetch before they write have no surface to report into, and their
  // failure is the failure of a press rather than of a background query. It is last in the
  // chain because a refused *write* is the more specific answer whenever both are standing.
  //
  // **The token writes join this family exactly while the Tokens & Emblems wall is not drawn**
  // (token stacks PR 2). The band says their refusal itself — once, above its wall, the newest
  // token write's sentence (`useDeckTokens`' `failure`) — but the wall is unmounted while the band
  // is collapsed, which is every deck's default, and the views draw the pile on every deck that has
  // counted a token. So a refused pile stepper or pile swap (a busy database, a deck deleted under
  // the reader) would otherwise be a press that changed nothing and said nothing anywhere. Drawn,
  // the band speaks and this banner leaves them out: two sentences for one refusal is the reason
  // this family leaves the docked panel's add out too.
  //
  // **The wall and not the band's open flag** (`tokenWallDrawn`, the band's own condition): an
  // open band over a deck that makes nothing draws no wall, and since managed tokens that deck is
  // the one Add printing is offered on precisely to add a first token by hand — the press opens
  // the band, so a refused first add keyed on `tokensOpen` was said nowhere at all.
  const bannerWrites = tokenWallDrawn(deckTokens, row?.tokensOpen === true)
    ? writes
    : ([...writes, ...deckTokens.writes] as const);
  /**
   * **The last batch of card writes, as one write** — a multi-card drop or Delete over a picked
   * set (issue #553). Each card in a batch is its own call on the same observer, so the observer
   * only ever remembers the last card, and a refusal in the middle of a batch that ended well
   * was said nowhere. {@link reportBatch} gathers every outcome into this record; `batchWrite`'s
   * doc has the rest. **Last in both lists**, so a tie with its own final member goes to it.
   */
  const [lastBatch, setLastBatch] = useState<Write>(NO_BATCH);
  const bannerFailure =
    writeFailure([...bannerWrites, lastBatch]) ?? undo.error ?? pressReadFailure;

  /**
   * What to say when a re-file moved nothing — and **nothing at all when it moved something**,
   * because a card that travelled announces its new pile by taking the caret there.
   *
   * The two silences this fills are the ones that read as a broken control: a reader drags a card
   * onto `Auto`, lets go, and the deck looks exactly as it did. Both answers are true and neither
   * is a failure, so this is a `role="status"` rather than the `role="alert"` banner above it —
   * a refused re-file is a refusal like any other and belongs in that one.
   *
   * **The card is named by looking it up rather than by being carried back**, which is free here
   * and only here: nothing moved, so the row is still in the slot the mutation was addressed to.
   * A moved card would need the answer to carry its name, and a moved card needs no sentence.
   */
  const refileAnswer = deck.refileCard.data;
  const refileSlot = deck.refileCard.variables;
  // `deck.cards` rather than the `cards` binding, which is declared further down this component
  // and would be a temporal-dead-zone throw from up here.
  const refileNote = useMemo(() => {
    if (!refileAnswer || refileAnswer.moved || !refileSlot) return null;
    const card = deck.cards.find(
      (c) => c.cardId === refileSlot.cardId && c.categoryId === refileSlot.from,
    );
    const named = card ? `“${card.name}”` : "That card";
    // **One sentence, where there were two.** The other said a card had no pile of its own to go
    // in and had stayed put; since 2026-08-16 it goes to `Uncategorized` instead, so the only
    // press that changes nothing is one aimed at the pile the card is already in.
    return `${named} is already in ${refileAnswer.category}.`;
  }, [refileAnswer, refileSlot, deck.cards]);

  /**
   * The sentence is a hint about one press, so it goes of its own accord — `reset()` clears the
   * mutation's answer, which is what this is derived from, so there is no second piece of state
   * to keep in step.
   *
   * Keyed on {@link refileAnswer}, whose identity is fresh per call (the `mutationFn` returns a
   * literal), so pressing again restarts the clock rather than inheriting the first press's
   * remaining time.
   */
  const resetRefile = deck.refileCard.reset;
  useEffect(() => {
    if (refileNote === null) return;
    const timer = setTimeout(resetRefile, REFILE_NOTE_MS);
    return () => clearTimeout(timer);
  }, [refileAnswer, refileNote, resetRefile]);

  /**
   * What the Compare dialog's bulk send wrote — **said here, because the dialog closes on it**
   * (issue #553). Pressing it twice wishes for the same copies twice, which is `add_wish`'s fold
   * and was kept on purpose, so what the press owed the reader instead was an unmistakable
   * "that worked": the dialog goes, and this line says what went where. A hint about one press,
   * so it clears itself on the refile note's clock; a fresh answer is a fresh object and restarts
   * it.
   */
  const [compareSent, setCompareSent] = useState<WishesSent | null>(null);
  useEffect(() => {
    if (compareSent === null) return;
    const timer = setTimeout(() => setCompareSent(null), REFILE_NOTE_MS);
    return () => clearTimeout(timer);
  }, [compareSent]);

  /**
   * The columns and the move targets: **every category the deck has, in `sortOrder`.**
   *
   * There used to be a filter *here*, driven by the seeded format spec — the sideboard dropped
   * out of this array when `sideboard_max` was 0, the commander column unless
   * `requires_commander`. Schema v8 makes that wrong and still does: a category is a row the
   * user named, ordered and switched on or off, so cutting one out of this list hides a pile
   * they built, and a deck may own any number of `main` ones, which no spec cell has anything
   * to say about.
   *
   * **The format has since come back, and it came back one rung lower — read this before
   * reinstating anything here, because the change looks like a revert of that decision and is
   * not.** What the spec answers now is {@link emptyGroupRules}, which `buildGroups` consults
   * about a group holding **nothing**: a Modern deck draws no empty command zone. This array is
   * untouched by it and is still every category of the deck. It is what deck settings' "Add
   * cards to" select, a card's `Move to` submenu and `CategoriesDialog` are built from, so every pile
   * stays reachable by name whether or not a heading is drawn for it — and a pile that *holds*
   * a card draws whatever the format says, because `drawsWhenEmpty` is never asked about a
   * group with cards in it. Nothing holding cardboard is hidden, and nothing at all is hidden
   * from the surfaces a reader files a card with. The format also still judges the deck, which
   * is the check chip in the header and a different question again.
   *
   * **It is the reader's order while a reorder is in flight, and the server's the rest of the
   * time** — see {@link localCategoryOrder}.
   */
  /**
   * The pile the reader is dragging, kept where it landed rather than where the deck last said
   * it was — the one write in this editor that draws its own answer before the backend has given
   * one.
   *
   * A reorder is a round trip *and* a re-read of the whole deck, so a pile that only moved once
   * `deck_get` came back would make the gesture read as a broken control: the reader lets go, the
   * column snaps back to where it was, and moves a moment later. `CategoriesDialog` holds exactly
   * this state for exactly this reason, and the two are deliberately the same shape.
   *
   * **It is dropped on a refusal**, which is the case that matters — a lie about what the deck's
   * columns look like must not outlive the write that failed. The banner says why:
   * `reorderCategories` is in `writes` above.
   *
   * **And it is dropped once the deck has been re-read after the write went through** (issue
   * #553). It used to stand for as long as the server's list held the same number of piles, which
   * is to say for the rest of the visit: a Ctrl+Z that put the old order back, a reorder in
   * `CategoriesDialog`, a sync — every one changed `deck.categories` and none of them was drawn,
   * so undoing a pile drag read as a key that did nothing. Not dropped *at* the answer, though:
   * the write's `onSuccess` only starts the re-read, and a desk that fell back to the list it
   * still holds would snap the pile home for the length of that round trip and then move it
   * again. So a settled write records **which server list it settled over** (`settledOver`), and
   * the preview stands until a different one arrives — the re-read carrying the new order, or
   * anything after it.
   *
   * Declared in front of the memo that reads it rather than beside the callback that writes it,
   * because a `useMemo` runs during the render it is written in and a `const` below it is a
   * temporal-dead-zone throw.
   */
  const [localCategoryOrder, setLocalCategoryOrder] = useState<{
    ids: number[];
    /** The server's list when the write answered, or `null` while it is still out. */
    settledOver: typeof deck.categories | null;
  } | null>(null);
  // Cleared during render — React's own answer for state that has to follow a prop, and what
  // keeps the superseded order from being drawn for one frame first.
  if (
    localCategoryOrder !== null &&
    localCategoryOrder.settledOver !== null &&
    localCategoryOrder.settledOver !== deck.categories
  ) {
    setLocalCategoryOrder(null);
  }
  /** The server's list as of the last commit, for the write's answer to record — see above. */
  const serverCategoriesRef = useRef(deck.categories);
  useEffect(() => {
    serverCategoriesRef.current = deck.categories;
  }, [deck.categories]);

  const categories = useMemo(() => {
    const rows = deck.categories;
    if (localCategoryOrder === null) return rows;
    const byId = new Map(rows.map((c) => [c.id, c]));
    // **`sortOrder` is re-stamped from position, and that is not decoration.** `buildGroups`
    // sorts by it — handing it an array in the right order and the old numbers would change
    // nothing on the desk at all. Every other consumer of this array (the `Move to` submenu,
    // deck settings' "Add cards to", the quick zones) reads it in array order and gets the same
    // answer either way.
    const picked = localCategoryOrder.ids.flatMap((id, index) => {
      const found = byId.get(id);
      return found ? [{ ...found, sortOrder: index }] : [];
    });
    // The moment it stops describing the same set of rows it is a lie about the deck rather than
    // a preview of it: a category created or deleted anywhere rebuilds from the server's order.
    return picked.length === rows.length ? picked : rows;
  }, [deck.categories, localCategoryOrder]);

  /**
   * The whole of the desk's reorder: the two ids a view can name, resolved against **every**
   * category the deck has.
   *
   * `deck_category_reorder` writes `sort_order` from position over the whole list, and what a
   * view holds is the piles it is drawing — the rail taken out by `splitRail`, the empty auto
   * piles never built by `drawsWhenEmpty`. So the flow's positions are not this list's, and
   * resolving them is this editor's job rather than the view's ({@link DeckCardActions
   * .moveCategory} says so at the seam). Landing the dragged pile **at the target's index in the
   * full list** is what puts it next to that pile in the flow as well, because the ids that are
   * not on screen keep their relative places.
   *
   * **The list is read through a ref**, so this callback is stable: it is a dependency of every
   * pile's drop-target registration, and one that changed with the deck would re-register a
   * dozen targets on every write — including the one this makes.
   */
  const reorderCategories = meta.reorderCategories.mutateAsync;
  const categoriesRef = useRef(categories);
  useEffect(() => {
    categoriesRef.current = categories;
  }, [categories]);
  const moveCategory = useCallback(
    (categoryId: number, targetId: number) => {
      const ids = categoriesRef.current.map((c) => c.id);
      const to = ids.indexOf(targetId);
      // A pile that has been deleted under the drag. `movedTo` is total and would answer a copy
      // of the list, which is a whole reorder sent to say nothing.
      if (to < 0 || !ids.includes(categoryId)) return;
      const next = movedTo(ids, categoryId, to);
      setLocalCategoryOrder({ ids: next, settledOver: null });
      // Each arm touches the preview only while it is still **this** drag's — a second drag made
      // before the first answered owns the desk now, and the first's answer is not about it.
      void reorderCategories(next).then(
        () =>
          setLocalCategoryOrder((was) =>
            was?.ids === next ? { ids: next, settledOver: serverCategoriesRef.current } : was,
          ),
        () => setLocalCategoryOrder((was) => (was?.ids === next ? null : was)),
      );
    },
    [reorderCategories],
  );

  // A deck deleted under an open layer takes its trigger with it — but not the state that says
  // one is open, and an `"inner"` layer nothing draws is a layer that eats the first Escape of
  // whatever the reader does next. Reset during render (`CardDetailModal`'s face, `Cover`'s art).
  if (gone && layer !== null) setLayer(null);

  // Put the reader back where they left this deck: the tab, the grouping and the sort the row
  // remembers. Another reset during render — React's own answer to state that has to follow a
  // prop, and the pattern this file already uses twice (the `targetCategoryId` clamp above and
  // the `variant` clamp below).
  //
  // **Honoured at most once per deck and reading of the switch — never once per stored value,
  // which is what this used to do and what crashed the app** (fixed 2026-08-16). `honouredView`
  // was `${deckId}:${row.lastVariant}:${row.lastGroupBy}:${row.lastSortBy}`, so the marker held a
  // value the restore's own `setVariant` could change: the variant decides which query's row
  // `row` is, each list caches its **own snapshot of the one deck row**, and two snapshots that
  // name each other's tab are a restore that moves the variant, which moves the snapshot, which
  // asks for the move back. React counts the nested renders and throws **"Too many
  // re-renders"** — and there is no error boundary above this component, so the window goes
  // blank. Measured in the shipped window: ~40 ms between tab presses took it down in three.
  //
  // The two snapshots really do disagree, and no amount of care at the write end fixes it:
  // `rememberView` deliberately does not invalidate, so `last_variant` is written without either
  // cached row hearing about it, and one `["decks"]` invalidation later the two rows are read by
  // **two** round trips — a press committing between them leaves one row on each side. That is a
  // fact about the cache; what this line owes is a marker the restore cannot move.
  //
  // So the marker is the two things that are genuinely a *new question about where the reader
  // should be*, and neither of them is state this block writes: **the deck** being opened, and
  // **the switch** being turned on, which leaves `lastVariant` at `"theory"` because that write
  // moves the cards there. Everything else is the reader's own press, which set the state and
  // wrote the column in the same act — there is nothing to restore them to but where they are.
  //
  // **`theoryEnabled` is off the same moving snapshot, and keying on it as a *value* brought the
  // crash straight back** — reported from the shipped app as "disabling the theory deck crashes
  // the entire frontend", and fixed here rather than at the switch. `deck_update` invalidates
  // `["decks"]`, so both lists re-read; until the second answer lands the query the reader is
  // **not** looking at goes on serving the row it already had, and that row still says the deck
  // keeps a plan. Off, on the plan's row, said "land on Actual"; on, on the deck's row, said
  // "land on `lastVariant`" — and `lastVariant` is `"theory"` on precisely the decks the report
  // is about, because a plan with cards in it is a plan its reader has been looking at. Each
  // answer moved the variant, the variant moved the row, and the row asked for the move back.
  // A deck whose plan is empty has `lastVariant: "live"`, so both readings ask for Actual and
  // nothing oscillates: that is the whole of why an empty plan looked fine.
  //
  // So the marker is not "the last deck-and-switch seen" but **"every reading of the switch this
  // deck has already been restored under"**, which is the same rule said in the one way that
  // cannot cycle. A switch has two readings, so a deck is restored at most twice however hard
  // the two cached rows disagree, and the clamp below is what settles where it lands. Nothing is
  // given up for it: a switch turned on for the *first* time is a reading this deck has not seen,
  // so the reader still follows their cards onto the plan, and a second time could not move any
  // — `deck.rs` pours the live list into an **empty** theory list only, and a plan that is
  // switched off is a plan no control in this window can empty.
  const honoured = restored !== null && restored.deckId === deckId ? restored.switches : NEVER;
  if (row !== null && !honoured.includes(theoryEnabled)) {
    setRestored({ deckId, switches: [...honoured, theoryEnabled] });
    // Narrowed rather than cast: a word a future build stops offering must land the editor on
    // the default, not in a mode its own select cannot draw.
    const storedGroupBy = asGroupBy(row.lastGroupBy);
    const storedSortBy = asSortBy(row.lastSortBy);
    // A remembered `"theory"` on a deck that keeps no plan is an ordinary state, not a corrupt
    // one — switching the list off does not rewrite the column — and the clamp below would take
    // it straight back. Asking for it anyway would cost a `deck_get` for a list the reader has
    // no control to reach, fired and thrown away on the way in. So the restore asks for what
    // this deck can actually show, and the clamp stays what it is: the guarantee rather than
    // the mechanism.
    const storedVariant = theoryEnabled ? row.lastVariant : "live";
    if (storedVariant !== variant) setVariant(storedVariant);
    // The grouping and the sort are `DeckDesk`'s state since issue #557; what the restore decides
    // about them is handed down as a fresh object, which the desk adopts in its own render — see
    // `RestoredView`. Read off the same row as the variant above, in the same breath, so the two
    // halves of one restore can never come from two snapshots.
    setRestoredView({ groupBy: storedGroupBy, sortBy: storedSortBy });
  }

  // Same reason, one field along: a switch the header stops drawing must not leave the editor
  // reading a list nothing can get back to.
  //
  // **After the restore, and still the guarantee even though the restore no longer hands it a
  // `"theory"` to take back.** A deck that kept a plan and no longer does can perfectly well
  // remember `"theory"`, since switching the list off does not rewrite the column; the restore
  // reads that as Live rather than asking for a list the reader has no control to reach (its
  // own comment says why). What is left for this line is the case the restore is not part of:
  // the switch being turned off under an editor that is already reading the plan.
  if (row !== null && !theoryEnabled && variant !== "live") setVariant("live");

  /**
   * The list switch's press — the first of the three toolbar writes the deck remembers, and the
   * one that stayed here when the grouping and the sort moved to `DeckDesk` (issue #557), because
   * the variant decides which list this component reads. `DeckDesk`'s `pickGroupBy` carries the
   * doc for all three: the state is what is drawn, the write is what survives the deck being
   * closed, and nothing waits on the answer.
   *
   * **A `useCallback` over `mutate`**, which is stable, so the memoised header is handed the same
   * function on every render.
   */
  const rememberView = deck.rememberView.mutate;
  /** `deck.update.mutate` — stable, unlike `deck.update`, so every callback built on it is too. */
  const updateDeck = deck.update.mutate;
  const pickVariant = useCallback(
    (next: DeckVariant) => {
      setVariant(next);
      rememberView({ variant: next });
    },
    [rememberView],
  );

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

  // How much room the two things on the desk have between them. A window resize changes it, and
  // this component would not otherwise hear about that, which is why it is an observer and not a
  // prop (`CardGrid`'s arrangement). Re-run when the deck lands, because the element being
  // measured does not exist until then.
  //
  // **It observed the dock as well until 2026-09-03, and that half went with the card pane.**
  // The dock's own width was measured only to place a pane beside it; the card is a centred
  // modal now, so the panel's width is nobody's business but the panel's and a drag on its edge
  // moves nothing this callback answers. The desk row is what a window resize changes, and it is
  // the one box left to watch.
  const hasRow = row !== null;
  //
  // The window's own width is read in the same callback rather than through a second listener:
  // this row is `flex-1` inside the page, so nothing can change the window's width without
  // changing the desk's, and one observer answering both keeps the two numbers from being a
  // frame apart.
  useEffect(() => {
    const el = deskRef.current;
    if (!el) return;
    const measure = () => {
      setViewport(document.documentElement.clientWidth);
      setDeskWidth(el.clientWidth);
    };
    // `entry` is deliberately not read: the width is taken off the element itself, so this stays
    // one callback whether it is called by the observer or by the line below it.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [hasRow]);

  /**
   * The widest the docked panel may be drawn or dragged — the smaller of two caps that bind at
   * different window sizes, and `Infinity` while neither has been measured.
   *
   * **Half the window**, because a search column that can take three quarters of the app has
   * stopped being a column; and **whatever the desk can spare over `DECK_FLOOR`**, because the
   * deck is what the width is being taken from. Neither is redundant: at 1280 with the card pane
   * docked the desk is 602, so half the window is 640 — wider than the whole row — and only the
   * floor says anything; at 1920 with the pane closed the floor would allow ~1462 and only the
   * half-window cap is holding the column to a column.
   */
  const maxPanelWidth = Math.min(
    viewport > 0 ? Math.floor(viewport / 2) : Number.POSITIVE_INFINITY,
    deskWidth > 0 ? deskWidth - DESK_GAP - DECK_FLOOR : Number.POSITIVE_INFINITY,
  );

  /**
   * Which way the reader last left the search column — **read here and handed down** since
   * 2026-09-07, where the panel used to ask for itself.
   *
   * The hoist is what lets one `CardSearchPanel` serve three surfaces that each remember their own
   * answer: the shell takes a boolean and a setter and knows nothing about where either came
   * from, and this editor is the component that already hands the panel its mutation, its
   * categories and its two measurements. `DeckSearchPanel` keeps a fallback for a panel mounted on
   * its own — a story, or `DeckSearchPanel.test.tsx` — and the prop is what overrides it here.
   *
   * **`"deck"` is the section**, one entry of the `app_meta.search_open` map the collection's and
   * the wishlist's columns share. It is the word `searchopen.rs`'s legacy bridge answers for, and
   * the one section name that crate spells at all.
   *
   * **The press is what is stored, never {@link roomForPanel}.** A railing is a measurement about
   * a narrow window and not a thing the reader asked for, so it reaches the drawn state and
   * nothing else.
   */
  const { open: panelOpen, setOpen: setPanelOpen } = useSearchOpen("deck");

  /**
   * Whether the panel may draw itself open, or has to fall back to its rail.
   *
   * `0` is "not measured yet" and reads as room: the first paint of a wide window should not
   * flash a rail, and the observer answers on the same frame.
   *
   * **Measured against the panel's _minimum_ now, not against its opening width** (changed
   * 2026-08-14, with the drag). The threshold used to be `DECK_FLOOR` plus a fixed 384 — 592 of
   * desk — because 384 was the only width the panel had; a panel that can be dragged has a range
   * instead, so the question is whether the narrowest useful one fits. `MIN_PANEL_WIDTH_PX` is
   * one card and its chrome (206), which puts the threshold at **414** and gives the reader a
   * squeezed search column across the 178px of desk width that used to rail outright. Below it
   * nothing changes: there is no room for a card, so there is no room for a card search, and the
   * rail says so in words.
   */
  const roomForPanel = deskWidth === 0 || maxPanelWidth >= MIN_PANEL_WIDTH_PX;

  /**
   * How wide to draw the search panel **over** the deck, for a desk that cannot hold the two of
   * them side by side — `undefined` where it can, which is every desk at or above the 414 the
   * bullet above works out.
   *
   * **This is the door out of the rail, and until 2026-08-29 there was none.** Below 414 the
   * panel railed *and refused to be pressed*: `roomy` was the whole of whether the disclosure
   * did anything, so on a 390px phone the one route from a deck to a card search was
   * `aria-disabled` with a sentence about widening a window that has no width to give. The
   * arithmetic was right and the question was wrong — there is no room for the two of them
   * **beside each other**, which is not the same as no room for the search.
   *
   * **The placement is issue #183's, reused.** The card pane used to draw over one of this row's
   * two columns rather than taking width from either; this is that arrangement at the one width
   * where the deck and the panel cannot both be on screen. The panel positions itself inside its
   * own dock, which is `sticky` and therefore already the box it needs — so what it is missing,
   * and all it is missing, is this number.
   *
   * **Never while a card is open, and the argument for that changed under it on 2026-09-03.** It
   * was paint order: the pane and this overlay both covered the deck, the pane was drawn from a
   * `sticky` host *earlier* in this scroller at the same `LAYER.popup`, and equal z-indexes
   * resolve by document order — so an overlay raised enough to beat the deck's own `LAYER.raised`
   * also beat the pane, and a tile pressed in the search opened a card **behind** the search.
   * There is no pane now; the card is a centred modal at `LAYER.overlay` over a scrim, so it
   * covers this overlay whatever this line says and nothing can paint in the wrong order.
   *
   * What is left is the half that was always the better half: **one surface at a time is the
   * honest answer at 390px**, and it is the phone's own idiom — the list steps aside for the
   * thing you tapped and is there again when you come back. `open` is untouched and the body is
   * hidden rather than unmounted, exactly as a railing already does, so nothing the reader typed
   * is thrown away. The refusal on the rail is `NO_ROOM`, whose first remedy is *close the card
   * details*, which is still literally the thing to do. **Kept rather than deleted with its
   * original reason**, and flagged here so the next reader knows it is a preference now rather
   * than a constraint.
   */
  const panelOverWidth =
    deskWidth > 0 && !roomForPanel && selectedCardId === null ? deskWidth : undefined;

  /**
   * Hold the docked search panel against the top of the page and draw it exactly as tall as the
   * part of the page that is on screen.
   *
   * **This exists because the desk stopped having a height** (2026-08-14). The deck's views grow
   * to hold their piles now, so the desk row is as tall as the deck is — 3 000px for a large
   * one — and the panel is its sibling. Left to the flex row's own `stretch` it would be drawn
   * 3 000px tall too: its search field and its filter row would scroll off the top with the
   * deck's header, its virtualised wall would mount tiles for a wall nobody can see at once, and
   * the reader would be dragging cards from a control at the top of the page to a pile near the
   * bottom of it. Pinned instead, the search stays exactly where it was while the deck scrolls
   * past it, which is what the column is *for*.
   *
   * `sticky` on the dock is the pinning and CSS does all of it — at the page's top edge, or
   * {@link barClearance} below it while the undocked bar is down; the height is the part CSS
   * cannot answer, and {@link useDockHeight} is where the arithmetic for it lives — the
   * scroller's visible height, less however much of the desk row still sits below its top (and
   * never less than the bar takes), less the scroller's own bottom padding, which a sticky box's
   * containing block ends above.
   *
   * **It was forty lines here until the collection and the wishlist grew the same column**
   * (2026-09-07), and the whole of what moving it cost is that the scroller is now *found* rather
   * than named: this editor is an `overflow-y-auto` page of its own, while those two pages scroll
   * in `AppShell`'s `main` several levels up. Nothing about this editor's arrangement changed —
   * every measurement, the jsdom branch and the `requestAnimationFrame` that coalesces a scroll
   * are the hook's doc, including the one gap it still has: a refusal banner growing in above the
   * desk moves the row's top without resizing either observed box.
   */
  useDockHeight(dockRef, deskRef, barClearance);

  // A refused write re-reads the deck, and the read is what decides what happened: every write
  // goes through `touch_deck`, which answers "That deck is not there any more" when the deck
  // has been deleted under the reader — so the same refusal is either a busy database (the
  // banner says so, the deck stays) or a deck that is gone (the read answers null and the
  // editor says so). Keyed on `submittedAt` so each new failure re-reads exactly once.
  //
  // **Every write above, and the ones the banner leaves out, banner or no banner.** `add_card`
  // calls `touch_deck` like the rest and
  // `missing_to_wishlist` answers the same `GONE` from its own read, so a press in the docked
  // panel or on the stats block reaches the same sentence — and without them here that surface
  // would report a deck that is gone while the view beside it went on painting it, with every
  // further press failing the same way and nothing on screen explaining why. The family is the
  // point: **no refused deck write may leave a dead deck painted.**
  //
  // **`swapPrinting` has no control in this view and is kept anyway.** It is pressed on the
  // card pane, which is a *sibling* of this editor, so its refusal lands in the pane's own
  // mutation state and this observer stays idle for the life of the editor — what actually
  // carries it back here is the `onError` invalidation on the mutation's single definition
  // (`useDeck.ts`). It costs one array element, it is where an in-editor control would land the
  // day one exists, and reading it as live GONE coverage would be reading it as something it
  // cannot do today.
  //
  // **`moveCard` has two callers again, and one of them is a keypress.** The card's own `Move…`
  // select was removed on 2026-08-14 and left a drop as the only route — which a caret cannot
  // perform — and the card's right-click restored both halves later the same day: `Move to`
  // lists every category the deck has, and Shift+F10 opens the menu. So this entry is live
  // coverage from a pointer *and* from the keyboard, rather than the placeholder the line above
  // it describes.
  //
  // **`setLabel` rides in through `writes`** and is live coverage for the same reason: nothing
  // in the app could reach it until that menu, and every one of the four views can now.
  //
  // **The token writes ride here always, and in the banner only while the band's wall is not
  // drawn** (token stacks PR 2, spec §4.7). Here always, because each one is a journalled deck
  // write now — a stepper press, a swap, an added printing, a removed one — so a success has to
  // clear the redo stack below like any other, and a refusal (a deck deleted under the reader
  // answers `GONE` from `touch_deck`) has to re-read the deck like any other. Not in `writes`
  // itself, because the band says their refusal once, above its own wall (`useDeckTokens`'
  // `failure`, the newest token write's sentence), and while that wall is drawn a banner too would
  // be two sentences for one refusal; {@link bannerWrites} is what adds them while it is not.
  // `planTokens`' writes are never pressed, so they are in neither list.
  const refetch = deck.query.refetch;
  const lastOfAny = newestWrite([
    ...writes,
    deck.addCard,
    deck.missingToWishlist,
    deck.swapPrinting,
    ...deckTokens.writes,
    // A batch whose last card went through and whose second did not is a refusal the deck has to
    // be re-read after — the observers above would all read as a success.
    lastBatch,
  ]);
  const failedAt = lastOfAny.isError ? lastOfAny.submittedAt : 0;
  useEffect(() => {
    if (failedAt) void refetch();
  }, [failedAt, refetch]);

  /**
   * **Any other write to the deck throws the redo stack away**, which is the ordinary undo
   * contract: once the reader has edited past a branch, the branch is gone.
   *
   * Keyed on the newest *successful* write across the whole refused-write family plus the
   * mutations that sit outside it — the add, the wishlist sweep, the printing swap and, since
   * token stacks PR 2, every token write — rather than on a call inside each mutation's
   * `onSuccess`: there are a couple of dozen of those, they live in three hooks, and several are
   * borrowed whole by surfaces outside this editor. One effect over `newestWrite` is the same list
   * the banner already reads, so a write added to that array is covered here for free.
   */
  const succeededAt = lastOfAny.isSuccess ? lastOfAny.submittedAt : 0;
  const clearRedo = undo.clearRedo;
  useEffect(() => {
    if (succeededAt) clearRedo();
  }, [succeededAt, clearRedo]);

  // Focus first, then close: the trigger is still mounted at this point. This is the
  // **keyboard** way out; the click-away way out is `close` and hands nothing back, because the
  // reader who clicked elsewhere is already somewhere else.
  const dismiss = useCallback(() => {
    handBackRef.current?.();
    setLayer(null);
  }, []);
  const close = useCallback(() => setLayer(null), []);

  /**
   * Open one of them, and never a second one, because there is one slot.
   *
   * The second argument is **where the caret goes when it closes**, and every caller owes one:
   * a button hands back to itself, a menu row hands back to the pile it was opened on. `null`
   * is only for a caller that genuinely has nowhere — and there is none today, because `null`
   * means the caret lands on `<body>` (see {@link handBackRef}).
   *
   * **A press on the layer that is already up closes it**, which is what a toolbar toggle should
   * do and is why the kind is compared. The note that used to sit here asked whether that toggle
   * could re-aim a payload arm at a *different* pile rather than closing it. **It still cannot**,
   * and the reason survived `export` growing a second opener: every overlay in this union is
   * modal, so neither the heading behind the scrim nor the header button behind it can be
   * pressed while one is up. It becomes reachable the day anything can ask for one of these
   * without going through a scrim — and the right answer then is one line, {@link layerMatches}
   * in place of the kind comparison below, which now exists for the `aria-expanded` half of the
   * same question. Left unwritten here rather than guessed, because a toggle nothing can reach
   * is a behaviour no test can pin.
   */
  const openLayer = useCallback((next: NonNullable<Layer>, handBack: (() => void) | null) => {
    handBackRef.current = handBack;
    setLayer((open) => (open?.kind === next.kind ? null : next));
  }, []);
  const openCheck = useCallback(
    () => openLayer({ kind: "check" }, () => chipRef.current?.focus()),
    [openLayer],
  );
  const openBracket = useCallback(
    () => openLayer({ kind: "bracket" }, () => bracketRef.current?.focus()),
    [openLayer],
  );

  /**
   * Where the caret goes when a layer opened from {@link DeckHeaderBar} closes: the bar's own
   * control, **or the header's first one if the bar has gone**. The bar is mounted only while the
   * header is scrolled away, so a control of its own can be a detached node by the time a dialog
   * shuts, and `focus()` on one is a silent no-op that leaves the caret on `<body>` — the header
   * is what the bar was standing in for, so the header is where the caret lands instead.
   */
  const handBackToBar = useCallback(
    (trigger: HTMLElement) => () => (trigger.isConnected ? trigger : backRef.current)?.focus(),
    [],
  );

  /**
   * The bar's ↥: the page back to its top, where the header docks again and the bar goes away.
   *
   * **The caret moves to the header's back button**, the first control of the lines the bar was
   * standing in for — without that it would stay on the ↥ it pressed, and the bar is kept mounted
   * while it holds the caret, so it would hang over the docked header until the reader tabbed out.
   * `preventScroll`, because the scroll is already on its way and a focus-driven one would jump it.
   *
   * Smooth unless the reader asked for reduced motion, read at the press rather than through
   * `useReducedMotion`, which reads once at mount (`packages/ui/CLAUDE.md`, Motion). `scrollTo` is feature-
   * tested because jsdom does not implement it on elements.
   */
  const backToTop = useCallback(() => {
    const scroller = editorRef.current ? nearestScroller(editorRef.current) : null;
    if (scroller) {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      if (typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      } else {
        scroller.scrollTop = 0;
      }
    }
    backRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * The bar's deck-level verbs: the header's Import/Export pair and its four worded actions
   * (issue #577) — behind the bar's `⋯` as the app's one context menu, or drawn out as buttons of
   * their own where the column is widest (issue #646). **Built from {@link TRANSFER} and
   * {@link ACTIONS} rather than listed again**, so a seventh header action reaches the bar by
   * being added once, and each opens exactly the layer its header button does, with the same
   * words: the pair's first word, the actions' whole label — the header's own `wideHeader` rule.
   */
  const barAction =
    (word: (label: string) => string) =>
    ({ layer: target, label, Icon }: HeaderAction): BarAction => ({
      label,
      word: word(label),
      Icon,
      expanded: layerMatches(layer, target),
      open: (trigger) => openLayer(target, handBackToBar(trigger)),
    });
  const barActions = {
    pair: TRANSFER.map(barAction((label) => label.split(" ")[0])),
    rest: ACTIONS.map(barAction((label) => label)),
  };

  /**
   * **Pull from collection** — the one layer opened from the stats band at the foot of the page.
   *
   * **The hand-back is read off `document.activeElement`**, which is `openAddLabel`'s answer rather
   * than the two above it, and for its reason: those two hold a ref to the control they are
   * drawn on, and this button is `DeckStats`' own. A ref threaded down through that component
   * would be a second `sendRef` — one prop, one `RefObject`, one more thing a strip rendered in
   * a test has to be handed — to name an element the browser has already focused by the time
   * this runs. A press focuses what it presses, so the caret is on the button and reading it is
   * exact.
   *
   * `null` if the caret is somewhere else by then, which is `handBackRef`'s documented floor:
   * the dialog focuses its own panel either way, and the reader who moved on owns where they are.
   */
  const openPull = useCallback(() => {
    const opener = document.activeElement;
    openLayer({ kind: "pull" }, () => {
      if (opener instanceof HTMLElement) opener.focus();
    });
  }, [openLayer]);

  /**
   * The plan behind that layer — **gated on the layer being up**, which is the whole of what
   * `enabled` is here for.
   *
   * A `deck_pull_plan` is the widest read this editor makes: every hole in the live list, and
   * every unallocated collection row that could fill one, joined and ordered. Nothing on the
   * screen behind the dialog draws a word of it, so an ungated query would be that read on every
   * deck anybody merely opened — the `Layer` union's own doc states the rule, and this is the
   * first member with a query to spend.
   *
   * **The kind and not {@link layerMatches}, and this line reversed on 2026-09-03.** It used to
   * read `layerMatches(layer, { kind: "pull" })` with a note saying that for an arm with no
   * payload it was the same question, and that it could not be the thing that was wrong on the
   * day the arm grew a field. The arm grew a field, and the note was half right: it is the thing
   * that would have been wrong, and the fix is the *opposite* of what the note implied. Both
   * shapes of the arm want this exact plan under this exact key — the per-card one narrows what
   * the dialog is *handed*, not what is read — so a `layerMatches` here would have left the card
   * entrance's dialog reading an idle query while the answer sat in the cache beside it.
   *
   * The answer survives the dialog closing — the key is the deck's, and TanStack keeps a
   * disabled query's cache — so reopening it in the same minute redraws immediately and
   * refetches behind the rows. Anything invalidating `["decks"]` in between, the pull included,
   * refills it: see {@link usePullPlan} for why the key is shaped to sit under that root. It is
   * also what {@link pullCard}'s `fetchQuery` fills, through the shared options factory, so the
   * press that *decides* whether to open this dialog and the dialog itself are one read.
   */
  //
  // **{@link tracks} rides the same gate, and it is not a second reading of the layer.** Rust
  // refuses `deck_pull_plan` for a virtual deck **by name** (`deck::VIRTUAL_HOLDS_NOTHING`)
  // rather than answering an empty plan, so a query left enabled would put a real error banner on
  // a screen whose reader never asked a question. Nothing can open the layer on such a deck — the
  // stats band's press is `null` and the card menu's row is gone — so this is the fence for the
  // deck changing *under* an editor that is already open, which a sync from another device can do.
  const pullPlan = usePullPlan(deckId, tracks && layer?.kind === "pull");

  /**
   * **Add missing to collection** — the second layer opened from the stats band, and the third
   * answer to the shortfall the two beside it already answer.
   *
   * **The hand-back is read off `document.activeElement`**, which is {@link openPull}'s answer
   * for {@link openPull}'s reason: this button is `DeckStats`' own and hands no ref up, and a
   * press focuses what it presses, so reading the caret at the press is exact rather than a
   * guess. `null` if the reader has moved on by then, which is `handBackRef`'s documented floor.
   *
   * There is nothing else for this callback to carry — see the `addMissing` arm's own doc for
   * why the layer has no payload and cannot grow one.
   */
  const openAddMissing = useCallback(() => {
    const opener = document.activeElement;
    openLayer({ kind: "addMissing" }, () => {
      if (opener instanceof HTMLElement) opener.focus();
    });
  }, [openLayer]);

  /**
   * The plan behind that layer — **gated on the layer being up**, exactly as {@link pullPlan} is
   * and for the same reason: `deck_missing_plan` walks every hole in the live list and asks the
   * wishlist about each one, and nothing on the screen behind the dialog draws a word of it.
   *
   * **The kind is the whole gate here, and unlike the pull's line that needs no explaining**:
   * this arm carries no payload, so there is one shape of it and {@link layerMatches} would be
   * asking the same question with more words.
   *
   * The answer survives the dialog closing — the key is the deck's and TanStack keeps a disabled
   * query's cache — and anything invalidating `["decks"]` refills it, which crucially includes
   * this feature's own write: recording the copies closes the very holes this read answers. See
   * {@link useMissingPlan} for why the key sits under that root.
   */
  //
  // **{@link tracks} for {@link pullPlan}'s reason exactly** — `deck_missing_plan` is the other
  // command Rust refuses by name for a virtual deck, and an enabled query behind a layer nothing
  // can open is a banner nobody pressed for.
  const missingPlan = useMissingPlan(deckId, tracks && layer?.kind === "addMissing");

  /**
   * **Label card ▸ New label…** — the one layer opened from a *card's* menu rather than a
   * pile's or the toolbar's.
   *
   * **The hand-back is read off `document.activeElement`, and that is exact rather than a
   * guess**: `ContextMenu`'s `run` focuses the opener *before* it calls a row's `onSelect` — in
   * that order, and its own comment says why — so by the time this runs the caret is already
   * back on the element the reader right-clicked. Every other opener here can name its
   * destination (`chipRef`, `focusDeckGroup(id)`) because a pile has one heading and the check
   * has one chip; a card row is drawn by four different views and has no id this file can focus.
   * Reading the caret asks the question the other callers answer from a lookup, and answers it
   * for all four views at once.
   */
  const openAddLabel = useCallback(
    (card: DeckCard) => {
      const opener = document.activeElement;
      openLayer(
        {
          kind: "addLabel",
          slot: {
            cardId: card.cardId,
            categoryId: card.categoryId,
            finish: card.finish,
            name: card.name,
          },
        },
        () => {
          if (opener instanceof HTMLElement) opener.focus();
        },
      );
    },
    [openLayer],
  );

  /**
   * The client the two menu reads below go through.
   *
   * **`fetchQuery` rather than a hook, because a right-click must fire nothing.** A `useQuery`
   * for the wishes would run for every card the deck draws, and one for the pull plan is the
   * widest read this editor makes — the `Layer` union's own rule applied a rung lower: nothing
   * is asked for until the reader presses the row that needs it. It also means the answer lands
   * in the same cache the dialogs read, so a press that *decides* and a dialog that *draws* are
   * one round trip rather than two.
   */
  const queryClient = useQueryClient();

  /**
   * The write behind all three `Collection ▸` rows, and the pull's own — `mutate` rather than
   * the mutation, for the reason the three category writes below give: TanStack hands back a
   * fresh result object every render, so a callback closing over the whole thing has a new
   * identity every render and every menu built from it is rebuilt.
   */
  const writeQuickAdd = deck.quickAddToCollection.mutate;
  const writePull = deck.pullFromCollection.mutate;
  /** The deck-wide record, which is what a picked set's quick add presses (issue #510): one
   *  transaction and one history row for the whole set, rather than one per card. */
  const writeMissing = deck.addMissingToCollection.mutate;

  /**
   * **Quick add N copies** — record what this row is short of into the deck's own group, and ask
   * nothing.
   *
   * No read and no dialog, which is what makes it the simplest of the three: the count arrives
   * from the menu (it is `quickAddShort` over the row that was right-clicked, so it is exactly
   * the `3/4` the card is wearing) and `wishId: null` says this press is not about the wishlist
   * at all. A reader who wanted the wishlist half pressed the row below it.
   *
   * **A picked set goes through `deck_missing_to_collection`** (issue #510), the stats band's
   * `Add missing to collection` write with the plan narrowed to the picked rows: all or nothing,
   * one history row, and no wish touched. Looping the one-card write instead would be a
   * transaction, an invalidation and a history line per card for one press.
   */
  const quickAdd = useCallback(
    (targets: readonly QuickAddTarget[]) => {
      setPressReadFailure(null);
      if (targets.length === 1) {
        const [{ card, copies }] = targets;
        writeQuickAdd({ card, quantity: copies, wishId: null });
        return;
      }
      const picks = missingPicks(targets);
      if (picks.length > 0) writeMissing({ picks, clearWishes: false });
    },
    [writeQuickAdd, writeMissing],
  );

  /**
   * **Quick add N and remove from wishlist** — the same record, then take the copies off the
   * wishlist line the reader picks.
   *
   * **A prompt whenever the card is wished for at all** (issue #511), which is `chooseWish`'s
   * whole job and deliberately not this callback's. The read answers every wish for the card —
   * any printing, any finish — so {@link QuickUnwishDialog} lists them with their folders and the
   * reader says which one this purchase settles. No wish at all writes straight through.
   *
   * **A failed read reaches the banner and never nothing.** This is a read the reader pressed
   * for, inside an act they were promised, and the menu that made the press has closed — so a
   * silent catch would be a menu row that sometimes does nothing at all. The write's own
   * refusals are the banner's already, through `writes`; this puts the read beside them.
   *
   * The hand-back is read off `document.activeElement` **before** the await, which is
   * {@link openAddLabel}'s answer and a rung more careful for the same reason: `ContextMenu`'s
   * `run` focuses the opener before it calls a row, so the caret is right *now* — where by the
   * time the round trip lands the reader may have moved on, and the element read here is still
   * the honest destination.
   *
   * **A picked set asks nothing** (issue #510): it is the deck-wide record with `clearWishes`
   * on, which takes copies off every row's wish where exactly one matches and leaves the
   * ambiguous ones standing — a press over eleven cards cannot ask eleven questions, which is
   * `Add missing to collection`'s own rule.
   */
  const quickAddAndUnwish = useCallback(
    (targets: readonly QuickAddTarget[]) => {
      setPressReadFailure(null);
      if (targets.length !== 1) {
        const picks = missingPicks(targets);
        if (picks.length > 0) writeMissing({ picks, clearWishes: true });
        return;
      }
      const [{ card, copies }] = targets;
      const opener = document.activeElement;
      const handBack = () => {
        if (opener instanceof HTMLElement) opener.focus();
      };
      void (async () => {
        let wishes: DeckQuickAddWish[];
        try {
          wishes = await queryClient.fetchQuery(quickAddWishesQuery(card.cardId, card.finish));
        } catch (error) {
          setPressReadFailure(ipcError(error));
          return;
        }
        const choice = chooseWish(wishes);
        if (choice.kind === "ask") {
          openLayer({ kind: "quickUnwish", card, copies, wishes: choice.wishes }, handBack);
          return;
        }
        writeQuickAdd({ card, quantity: copies, wishId: null });
      })();
    },
    [openLayer, queryClient, writeQuickAdd, writeMissing],
  );

  /**
   * **Pull N from your collection** — the per-card entrance to the dialog the stats band already
   * opens over the whole deck.
   *
   * The same test as the row above it and the same argument: `choosePull` answers `take` where
   * the plan holds exactly one candidate for this printing — a lone source is unambiguous even
   * when it cannot cover the line, so what there is is taken — and `ask` for two or more, **and
   * for none**. None goes to the dialog rather than to a sentence here, because the dialog
   * already words that case (`NOTHING_TO_PULL`) and words it better than a banner could: a
   * reader whose deck says *3 missing* needs to be told *why* the pull found nothing, not merely
   * that it did.
   *
   * The read is {@link pullPlan}'s own, through the shared options factory, so this press fills
   * the cache the dialog then draws from and the two can never disagree about the key. The
   * filtering is done at the render site off the **live** query rather than frozen into the
   * layer: the arm carries the card, and the plan is re-read after every write.
   *
   * **A picked set is one press over every picked row that is short** (issue #510):
   * `choosePullFor` takes them all silently where each has one answer, and opens the dialog over
   * the whole set where any one of them needs the reader.
   */
  const pullCard = useCallback(
    (cards: readonly DeckCard[]) => {
      if (cards.length === 0) return;
      const opener = document.activeElement;
      const handBack = () => {
        if (opener instanceof HTMLElement) opener.focus();
      };
      setPressReadFailure(null);
      void (async () => {
        let rows: DeckPullRow[];
        try {
          rows = await queryClient.fetchQuery(pullPlanQuery(deckId));
        } catch (error) {
          setPressReadFailure(ipcError(error));
          return;
        }
        const choice = choosePullFor(rows, cards);
        if (choice.kind === "take") {
          writePull(choice.picks);
          return;
        }
        openLayer({ kind: "pull", cards }, handBack);
      })();
    },
    [deckId, openLayer, queryClient, writePull],
  );

  // The menu's three writes, each addressed by the **row** rather than by a slot — a menu is opened
  // on one card. Taken as `mutateAsync` (and the finish as `mutate`) for the reasons the drop's
  // writes are; `useDeckDrops` carries that argument in full beside the writes it was written for.
  const writeLabel = deck.setLabel.mutateAsync;
  const writeOtherList = deck.addToOtherList.mutateAsync;
  const writeFinish = deck.setCardFinish.mutate;

  /** Every write a drop makes, and the caret's hand-off after one — see `useDeckDrops`. Called
   *  where these callbacks were declared, so the order of this component's effects is unchanged.
   *  `handOffTo` and `refile` stay inside it: nothing out here calls either but a drop. */
  const { addTo, setQuantityAt, moveTo, applyDrop, reportBatch, applyDrops } = useDeckDrops({
    deck,
    cards: deck.cards,
    markAdded,
    editorRef,
    setLastBatch,
    setCardSelection,
  });
  const cards = deck.cards;

  /**
   * **The cards the reader has Ctrl- and Shift-clicked**, as rows of this deck — issue #214.
   *
   * The one derivation of "which cards are picked", and it is here rather than beside
   * `useCardSelection` below because three things above that hook need it: the card menu (built at
   * `deckCardMenu` a few hundred lines down), the Delete key, and the group a drag carries. What
   * the hook adds on top is the *gestures* — which chord means what, and the range order — and
   * those genuinely need `groups`, which is derived near the bottom of this component.
   *
   * **Read off the store rather than off the hook** for exactly that reason, and scoped by the
   * same string the hook writes under, so the two can never answer about different decks.
   *
   * **A slot that names no row is dropped**, which is `pruneSelection`'s rule reached by a second
   * road and needed here for its own sake: a set outlives the list it was made in, so between a
   * removal landing and the next render the keys can address rows that are gone — and a
   * `Remove 4 cards` that removes three is worse than one that says three.
   */
  // **Another surface's set is `null` here, at the selector** (issue #910): a Ctrl+A in the docked
  // search column writes its set once per page it fetches, and read whole each of those writes was
  // a render of this editor for a set it does not draw.
  const cardSelection = useAppStore((s) =>
    s.cardSelection?.scope === `deck:${deckId}` ? s.cardSelection : null,
  );
  const pickedCards = useMemo(() => {
    if (cardSelection === null) return [];
    const bySlot = new Map(
      cards.map((card) => [deckCardSlot(card.categoryId, card.cardId, card.finish), card]),
    );
    return cardSelection.keys.flatMap((slot) => {
      const card = bySlot.get(slot);
      return card ? [card] : [];
    });
  }, [cardSelection, cards]);

  /**
   * The same list read at a moment rather than at a render — the Delete key's and a drag's copy.
   *
   * Both are handlers registered once and asked later: a `keydown` listener that had the set in
   * its dependency list would be torn down and re-added on every Ctrl-click, and a drag
   * registration doing the same would unregister the source under the reader's pointer.
   */
  const pickedRef = useRef(pickedCards);
  useEffect(() => {
    pickedRef.current = pickedCards;
  }, [pickedCards]);

  /** The card menu's `Set as foil` / `Set as regular`, and the card pane's own button. */
  const setFinishAt = useCallback(
    (card: DeckCard, to: DeckFinish) => {
      writeFinish({
        cardId: card.cardId,
        categoryId: card.categoryId,
        finish: card.finish,
        to,
      });
    },
    [writeFinish],
  );

  /**
   * The quick zones' **New category**, in two halves an act apart.
   *
   * The drop opens the dialog and writes nothing: a modal cannot be opened mid-gesture, and a
   * pile has to be called something. The submit makes the pile and then files the card into it
   * with the write the drag meant all along — {@link dropWrite} asked a second time, against the
   * id the create just answered with, so the add/move branch is the *same* rule a drop onto a
   * drawn heading goes through rather than a second copy of it.
   */
  const createCategory = meta.createCategory.mutate;
  const resetCreateCategory = meta.createCategory.reset;
  const openQuickCategory = useCallback(
    (payload: DragPayload) => {
      // The dialog draws this observer's refusal, and a sentence left over from a previous press
      // would be on screen before the reader had typed anything — `resetCategoryDelete`'s reason.
      resetCreateCategory();
      // Nothing to hand the caret back to: the drop is a pointer gesture and no control opened
      // this.
      openLayer({ kind: "quickCategory", payload }, null);
    },
    [openLayer, resetCreateCategory],
  );
  const quickCategoryPayload = layer?.kind === "quickCategory" ? layer.payload : null;
  const createQuickCategory = useCallback(
    (name: string) => {
      if (!quickCategoryPayload) return;
      createCategory(name, {
        // **Closed only on success**, which is what leaves a refused name in the field to be
        // corrected. The second write's own refusal is the editor's banner, like every other add
        // and move.
        onSuccess: (category) => {
          const write = dropWrite(quickCategoryPayload, {
            kind: "category",
            categoryId: category.id,
          });
          if (write) applyDrop(write);
          close();
        },
      });
    },
    [applyDrop, close, createCategory, quickCategoryPayload],
  );

  /** The stepper's write, addressed by the card's own slot. */
  const setQuantity = useCallback(
    (card: DeckCard, quantity: number) =>
      setQuantityAt(card.cardId, card.categoryId, card.finish, quantity),
    [setQuantityAt],
  );

  /**
   * One deck row as the slot every write to it is addressed by, and the reason every view hands
   * its whole `DeckCard` back rather than an id.
   *
   * **Written once because two things need it now**: {@link openCard}, which anchors the card
   * pane on the row it was opened from, and the card menu's `printingsDeck`, which is what makes
   * a press inside the printings modal a *swap* of this row rather than a look at a printing. Two
   * hand-written copies of a five-part address is how one of them comes to name four parts —
   * which is not a hypothetical: `PaneDeckContext`'s own doc records it happening twice, once
   * over `variant` and once over `finish`, each time rewriting the wrong deck row while showing
   * the reader the right-looking answer.
   *
   * The slot carries the category's **name** as well as its id, because both readers are
   * *siblings* of this editor and have no category list to translate one with; the **variant**,
   * because a deck is two lists and a swap addressed to the wrong one either misses or rewrites
   * a row the reader is not looking at; and the **finish**, for that same reason one column
   * over — a pile can hold this printing twice, and a swap, the pane's foil button and the
   * modal's tiles all write to one of the two.
   */
  const deckSlotOf = useCallback(
    (card: DeckCard): PaneDeckContext => ({
      deckId,
      categoryId: card.categoryId,
      categoryName: card.categoryName,
      cardId: card.cardId,
      variant,
      finish: card.finish,
    }),
    [deckId, variant],
  );

  /**
   * Open a card **as a deck row** — the only write of `paneDeckContext` in the app.
   *
   * What it buys is on the other side of the app: the pane's printings list gains "Use this
   * printing", which rewrites *this* slot, and the gold ring on the desk is drawn from the same
   * context. Everything else that opens a card — the docked panel's tiles, the validation
   * panel's names — goes through `setSelectedCardId`, which clears the context in the same write
   * (see the store), so a card that is not a row of this deck can never be shown as one.
   */
  const openCard = useCallback(
    (card: DeckCard) => openCardFromDeck(deckSlotOf(card)),
    [deckSlotOf, openCardFromDeck],
  );

  /**
   * **Remove card** — the stepper's zero, addressed by the row.
   *
   * `setQuantity(card, 0)` and nothing else, which is what makes this row free of *surprises*:
   * it goes through `setQuantityAt`, so it is the same optimistic patch, the same rollback and
   * the same hand-off of the caret to the pile the card just left that the stepper and the
   * remove tray already get. There is no `remove` mutation in this app because zero is the
   * removal — see `useDeck.setQuantity`.
   *
   * **It is not free of consequences, and that changed with schema v25**: on the Actual list this
   * takes the copies the deck's group was holding and files them into `Recently removed`. The
   * reader still owns them, which is why the row still needs no confirmation — but the sentence
   * saying where they went is {@link CUT_CARDS_NOTE}, standing at the foot of the deck rather
   * than repeated on every one of the three ways to make this press.
   */
  const removeCard = useCallback(
    (card: DeckCard) => setQuantityAt(card.cardId, card.categoryId, card.finish, 0),
    [setQuantityAt],
  );

  /** The deck writes the menu adds, each addressed by the **row** — a menu is opened on one
   *  card, which is more than a drop carries and is why these are not `applyDrop`'s pair. */
  const moveCardTo = useCallback(
    (card: DeckCard, categoryId: number) =>
      moveTo(card.cardId, card.categoryId, categoryId, card.finish),
    [moveTo],
  );
  const setCardLabel = useCallback(
    (card: DeckCard, labelId: number | null) =>
      handled(
        writeLabel({
          cardId: card.cardId,
          categoryId: card.categoryId,
          finish: card.finish,
          labelId,
        }),
      ),
    [writeLabel],
  );
  /** **Add to actual / Add to theory** (issue #592): one copy of the row into the list this editor
   *  is *not* showing — `useDeck.addToOtherList` sends it there, and Rust finds the pile. */
  const addToOtherList = useCallback(
    (card: DeckCard) =>
      handled(
        writeOtherList({ cardId: card.cardId, categoryId: card.categoryId, finish: card.finish }),
      ),
    [writeOtherList],
  );

  /**
   * Every oracle id a deck note names — the per-card note mark, in every view at once.
   *
   * **There is no *"which cards in this deck have notes"* command and there must not be one.**
   * The band below already holds every note and every note holds its oracle ids, so this is a
   * `Set` built in TypeScript from a read the page has already made — the boundary this repo
   * keeps, and the same call `Empty a list` makes for its two counts. A second command would be
   * a second source of truth for a fact already in hand, free to disagree with the band a reader
   * is looking at.
   *
   * **The same hook the band mounts, and that costs one cache read rather than a round trip**:
   * `useDeckNotes` keys on `["decks", "notes", deckId]`, so the two observers share one query.
   * Reading it here rather than lifting it out of the band is what keeps the band's own props
   * the four the plan gives it.
   *
   * `undefined` never reaches a view — an empty set is what a deck with no notes answers, and
   * `deckCardNoted` treats the two alike.
   *
   * **It is read here, above the card menu, rather than beside the marks it feeds.** The menu's
   * `Notes ▸` is built from `notes.notes`, so that list is a dependency of `deckCardMenu`'s
   * `useCallback` — and a dependency array is evaluated during the render that declares it, so a
   * hook called two hundred lines below would be a temporal-dead-zone `ReferenceError` on the
   * first paint of every deck rather than anything the type checker would name.
   */
  const notes = useDeckNotes(deckId);
  const noted = useMemo(() => notedOracleIds(notes.notes), [notes.notes]);

  /**
   * **Which stacks the reader hid in the Stacks view** (issue #618) — this device's, per window,
   * one `app_meta` row (`useHiddenStacks`). Read up here, above `categoryMenu`, for the notes'
   * reason just above: the menu's `useCallback` names it in its dependency array, which is
   * evaluated during the render that declares it.
   */
  const { hidden: hiddenStacks, setHidden: setStackHidden } = useHiddenStacks(deckId);

  /**
   * **A note act the card menu asked for, parked until the band can honour it** (issue #447).
   *
   * `quickCategory`'s arrangement one union over, and its reason: a menu row is a bare callback
   * that runs as the panel closes, and what these two rows ask for — create a note, open one for
   * reading — belongs to the band, which owns the notes query, the five writes and the
   * one-panel-per-row state. Holding the *request* here is what lets the row stay a callback and
   * keeps every note write in one observer.
   *
   * **Not a `Layer` arm**, though it looks like one: nothing is drawn over the deck, the band is
   * always mounted, and this state is cleared on the render after the band takes it rather than
   * living as long as a surface is up.
   */
  const [noteRequest, setNoteRequest] = useState<DeckNoteRequest | null>(null);
  const clearNoteRequest = useCallback(() => setNoteRequest(null), []);

  /**
   * **Add note…** — the card menu's first note row.
   *
   * It writes nothing here and, since 2026-09-20, **the band writes nothing on the press
   * either**: the request opens the note editor seeded with this card, and **Save** is the create
   * that names it. What the split buys is unchanged — the create, its refusal line and the editor
   * are all one observer's — and `addLabel`'s is that same split, one beat later.
   *
   * ⚠️ **A card with no oracle id never reaches this**, and the fence is at the build site rather
   * than in here: `deckCardMenu` passes `addNote: undefined` for an orphan printing, and
   * `noteItems`' all-or-none guard then drops the whole block — which costs that card nothing it
   * could have used, since `notesForCard` answers `[]` for a missing id and `Notes ▸` would never
   * have been drawn. **Absent rather than greyed** is this menu's own precedent for a row that
   * can only be refused (`zoneItem`), and it is the honest shape here: a note attaches by oracle
   * id and by nothing else, so a note made from such a card would name nothing and turn up under
   * no card's submenu ever again — a write with no way back to it. The narrowing below is what
   * makes {@link DeckNoteRequest}'s own `oracleId: string` true without a cast, and it is
   * unreachable in the app.
   */
  const addNote = useCallback((card: DeckCard) => {
    const { oracleId, name } = card;
    if (oracleId === null) return;
    setNoteRequest({ kind: "add", card: { oracleId, name } });
  }, []);

  /** **Notes ▸ <title>** — the card menu's second note row. The note itself rather than its id,
   *  because the row already holds the whole thing; only the id survives the trip, since the band
   *  reads the same query and would rather point at its own row than hold a frozen copy. */
  const openNote = useCallback((note: DeckNote) => {
    setNoteRequest({ kind: "open", noteId: note.id });
  }, []);

  /** **Set as deck image** — the card menu's cover row, over `updateDeck` (stable). A refusal
   *  lands in the banner every other `deck.update` write already speaks through. The menu reads
   *  the cover id rather than `row`, so a write to any other field does not rebuild it. */
  const coverCardId = row === null ? undefined : row.coverCardId;
  const setCoverFrom = useCallback(
    (card: DeckCard) => updateDeck({ coverCardId: card.cardId }),
    [updateDeck],
  );

  /**
   * One deck card's right-click, **built here and handed to the four views as one function**.
   *
   * A view that assembled its own would be four copies of one rule, and the rule reads three
   * facts no view has: every category the deck holds (`categories`, in the reader's own order
   * and deliberately not the drawn groups), the deck's format spec, and the deck's labels.
   *
   * The item list is a thunk inside `menu`, so a hundred-card deck pays for nothing until a
   * reader right-clicks a card. The `printingsDeck` override is per **card** rather than per
   * surface, and that is free for the same reason — this whole object is built on the press, so
   * the slot handed over is the slot of the row that was actually right-clicked, and "View all
   * printings" opens the modal already knowing which of this deck's rows a press in it rewrites.
   *
   * **Both doors, from one thunk.** `menuKey` is Shift+F10 and the ContextMenu key, and it is
   * not an extra here: the per-card `Move…` select was removed on 2026-08-14 and took the only
   * keyboard path to moving a card with it (a caret cannot drag). This menu is that path, so a
   * menu only a mouse could open would restore nothing.
   *
   * **`flips` arrives as an argument**, `categoryMenuFor`'s arrangement: whether the view on screen
   * draws the card's picture is a question about the view, which is `DeckDesk`'s state since issue
   * #557. The desk binds it to the view it is drawing, so a switch of view rebuilds the menu and a
   * filter keystroke does not.
   */
  const deckCardMenuFor = useCallback(
    (card: DeckCard, flips: boolean) => {
      const build = () =>
        buildDeckCardMenu(card, {
          // **The slot, not a destination.** The row used to re-anchor the card pane onto this
          // deck row so that the pane's printings list could offer "Use this printing"; the modal
          // takes the slot directly, so the pane is out of the path entirely and the deck stays
          // on screen behind it. `deckSlotOf` rather than a second object literal, because a slot
          // written out twice is how one of the two copies comes to name four of the five parts.
          //
          // No `printingsOracleId` either. That field is `paneCardId`'s replacement one level up,
          // and it greys the row on a surface that is *already* listing this oracle card's
          // printings — which the modal is and a deck card is not, so the row stays live here on
          // every card including the one the pane happens to be open on.
          card: { ...cardMenuDeps, printingsDeck: deckSlotOf(card) },
          // "Flip card" on the two views that draw the card's picture (issue #844). Table and
          // Text draw none, so the row would turn a card nobody can see.
          flips,
          categories,
          cards: deck.cards,
          spec,
          moveTo: moveCardTo,
          setLabel: setCardLabel,
          setFinish: setFinishAt,
          labels: deck.labels,
          addLabel: openAddLabel,
          remove: removeCard,
          // **Add to actual / Add to theory** (issue #592) — the copy goes into the list this tab
          // is not, and only on a deck that keeps a plan: a regular or virtual deck has no other
          // list, so it passes nothing and the row is absent rather than greyed.
          otherList: theoryEnabled
            ? { variant: variant === "theory" ? "live" : "theory", add: addToOtherList }
            : undefined,
          // The plural rows' outcomes, into the same record a multi-card drop and Delete use.
          batch: reportBatch,
          // **The `Collection ▸` submenu's three rows** (2026-09-03, issue #350). All three are
          // callbacks and none of them is a mutation, which is this builder's contract — and
          // here it is load-bearing rather than ceremonial: two of the three *read* before they
          // write, and one of those two ends in a dialog rather than in a write at all, so
          // "which write does this row make" is a question with no single answer.
          //
          // **Passed on both lists, and the theory one is greyed rather than absent.** That is
          // `quickAddBlock`'s call and not this file's: a plan holds no cardboard, so a theory
          // row can neither record copies nor pull any — but every card of this surface can be
          // short, so a submenu that simply vanished on one tab would read as a bug rather than
          // as a refusal. The row says `a plan holds no cards` instead. **Its shortfall is real
          // on that tab since 2026-09-09** (issue #435): a theory row counts every copy the deck
          // could use, so the block is about where the cardboard would go and no longer about a
          // number that was zero by construction. The stats band's deck-wide `onPull` is `null`
          // there for a different reason and stays so: that button has a *question* to lose,
          // where these rows have an answer to give.
          //
          // **A virtual deck passes all three as `undefined`, and the whole submenu goes with
          // them** — `collectionItems`' own all-three-or-none rule (`deckCardMenu.tsx`), which
          // drops the item rather than drawing two answers to a question whose third would then
          // read as *impossible* rather than as unwired. **Structural rather than greyed, and
          // that is the split**: the three arms of `QUICK_ADD_REASON` grey a row about a deck
          // that *has* a binder and cannot use it here — a plan holds no cards, this pile is
          // switched off, nothing missing — where a virtual deck has no binder to talk about at
          // all. A greyed `Quick add 0 copies` on every card of every pile of such a deck is a
          // row that spends the menu's width on a sentence that is true of the whole deck.
          quickAdd: tracks ? quickAdd : undefined,
          quickAddAndUnwish: tracks ? quickAddAndUnwish : undefined,
          pullCard: tracks ? pullCard : undefined,
          // **The two note rows** (2026-09-10, issue #447). `deckCardNoteRows` was built, tested
          // and reachable from nothing until this: `noteItems`' all-or-none guard drops the whole
          // block — separator included — unless both callbacks arrive, so a builder handed
          // neither drew a menu with no mention of notes at all and every test in
          // `deckCardMenu.test.tsx` went on passing about a function the app never called.
          //
          // The list is **unfiltered**, which is what `DeckCardMenuDeps.notes` asks for: *which
          // notes name this card* is `notesForCard`'s question and is answered in the builder, so
          // filtering here would put that predicate at every call site and hand this menu a list
          // that disagrees with the band on the same screen.
          notes: notes.notes,
          // ⚠️ **`undefined` for an orphan printing, which takes `Notes ▸` with it** — see
          // `addNote` for the argument. `openNote` is passed unconditionally because it is
          // structurally fine on any card; the guard is on the half that would write.
          addNote: card.oracleId === null ? undefined : addNote,
          openNote,
          // **Set as deck image** — the same write the settings dialog's cover picker makes, on
          // the printing this row plays. `undefined` only before the deck row has loaded, when no
          // card is drawn to right-click.
          cover: coverCardId === undefined ? undefined : { cardId: coverCardId, set: setCoverFrom },
          // **Only when this card is in the set** — `dragsWholeSelection`'s rule for a press
          // instead of a drag. A right-click on a card the reader has not picked is about that
          // card, so `[]` goes over and the menu is the singular one it has always been.
          picked: pickedCards.some(
            (row) =>
              row.cardId === card.cardId &&
              row.categoryId === card.categoryId &&
              row.finish === card.finish,
          )
            ? pickedCards
            : [],
        });
      return { onContextMenu: menu(build), onKeyDown: menuKey(build) };
    },
    [
      menu,
      menuKey,
      cardMenuDeps,
      deckSlotOf,
      categories,
      deck.cards,
      deck.labels,
      spec,
      moveCardTo,
      setCardLabel,
      setFinishAt,
      openAddLabel,
      removeCard,
      theoryEnabled,
      variant,
      addToOtherList,
      reportBatch,
      tracks,
      quickAdd,
      quickAddAndUnwish,
      pullCard,
      // **The notes themselves and not just the two callbacks.** `Notes ▸` is built from this
      // list at the moment the menu is opened, so a missing dependency here is a menu built from
      // the notebook as it was when this callback was last made — a note written in the band
      // would not be offered on the card it names until something else moved.
      notes.notes,
      addNote,
      openNote,
      coverCardId,
      setCoverFrom,
      pickedCards,
    ],
  );

  /**
   * One **pile's** right-click, built here and handed to the four views as one function.
   *
   * `buildCategoryMenu` is `categoryMenu.tsx`'s, and every one of its six dependencies is a
   * decision this editor already owns: the deck's unfiltered rows, the two `Layer` arms that
   * were built for exactly this (`import` aimed at one pile, `export` of one pile), the rename
   * field's flag, `useDeckMeta`'s switch, and the confirmation a delete owes. **That last one is
   * why `CategoryMenuDeps` carries no delete mutation** — a menu opens by accident, and deleting
   * a pile takes its cards with it.
   *
   * `undefined` for a category this deck does not have, which a derived heading never reaches
   * (`deckGroupMenuProps` refuses a `null` id first) but a pile deleted under an open menu could.
   *
   * **`Hide` / `Unhide` is offered in the Stacks view alone** (issue #618): `stackVisibility` is
   * handed only there, because the other three views draw every card of a hidden stack and a row
   * that changed nothing on screen would read as a broken control.
   *
   * **`stacks` arrives as an argument since issue #557**, because the view is `DeckDesk`'s state
   * now: the desk wraps this into the one-argument `categoryMenu` the views are handed, over the
   * view it is drawing, so the menu is rebuilt for a switch of view and for nothing the filter does.
   */
  const categoryMenuFor = useCallback(
    (categoryId: number, stacks: boolean) => {
      const category = categories.find((c) => c.id === categoryId);
      if (category === undefined) return undefined;
      const build = () =>
        buildCategoryMenu(category, {
          // The deck's own rows, never `shown`: exporting "Removal" means the pile rather than
          // the four of it the toolbar's filter happens to be showing.
          cards: deck.cards,
          startRename: (pile) => setRenamingCategoryId(pile.id),
          // Each hands the caret back to the **pile**, not to nothing: these three are opened
          // from a menu row, which has unmounted by the time the dialog closes.
          openImport: ({ forcedCategoryName }) =>
            openLayer({ kind: "import", forcedCategoryName }, () => focusDeckGroup(category.id)),
          openExport: ({ categoryId: id }) =>
            openLayer({ kind: "export", categoryId: id }, () => focusDeckGroup(id)),
          setActive: (pile, isActive) => setCategoryActive({ id: pile.id, isActive }),
          // The clear's confirmation, and the reset on the way in is `askDelete`'s below —
          // same observer lifetime, same stale-sentence bug it prevents.
          askClear: (pile) => {
            resetCategoryClear();
            openLayer({ kind: "clearCategory", categoryId: pile.id }, () =>
              focusDeckGroup(pile.id),
            );
          },
          // **The refusal from the last time is cleared on the way in**, because the confirmation
          // draws its own sentence off an observer this file holds and the layer opens with that
          // sentence already in it otherwise. See {@link resetCategoryDelete} — and note the
          // reset belongs *here* rather than in `openLayer`, which is the union's switch and has
          // no business knowing which arm carries a mutation.
          askDelete: (pile) => {
            resetCategoryDelete();
            openLayer({ kind: "deleteCategory", categoryId: pile.id }, () =>
              focusDeckGroup(pile.id),
            );
          },
          stackVisibility: stacks
            ? {
                hidden: hiddenStacks.has(category.id),
                setHidden: (pile, hidden) => setStackHidden(pile.id, hidden),
              }
            : undefined,
        });
      return { onContextMenu: menu(build), onKeyDown: menuKey(build) };
    },
    [
      menu,
      menuKey,
      categories,
      deck.cards,
      openLayer,
      setCategoryActive,
      resetCategoryClear,
      resetCategoryDelete,
      hiddenStacks,
      setStackHidden,
    ],
  );

  /**
   * The eye on a hidden stack's heading shows its cards again — and hands the caret to the pile,
   * because the button it was on is gone with the press. Same element, so it is there to take it.
   */
  const showStack = useCallback(
    (categoryId: number) => {
      setStackHidden(categoryId, false);
      focusDeckGroup(categoryId);
    },
    [setStackHidden],
  );

  /**
   * The rename field for the pile that is being renamed, drawn in its own heading.
   *
   * Built here rather than in the views because the draft, the write and the caret's way home
   * are one decision — `metaRows.tsx`'s `RenameField` is the same control both meta dialogs use,
   * so a pile renamed from its heading and a pile renamed from the Categories dialog are the
   * same field with the same rules.
   *
   * The caret goes back to the pile on both exits, which is where it came from: `focusDeckGroup`
   * is the editor's existing hand-off and finds the group by attribute, so it works after the
   * field has unmounted and after a rename has moved the pile in a packed column.
   */
  const renameCategoryField = useCallback(
    (categoryId: number) => {
      if (renamingCategoryId !== categoryId) return null;
      const category = categories.find((c) => c.id === categoryId);
      if (category === undefined) return null;
      const done = () => {
        setRenamingCategoryId(null);
        focusDeckGroup(categoryId);
      };
      return (
        <RenameField
          label={`Rename ${category.name}`}
          initial={category.name}
          pending={renamePending}
          onSave={(name) => renameCategory({ id: categoryId, name }, { onSuccess: done })}
          onCancel={done}
        />
      );
    },
    [renamingCategoryId, categories, renameCategory, renamePending],
  );

  /**
   * The docked panel's tiles, which are **not** deck cards: a search result is a printing the
   * reader has not filed anywhere, so none of the four deck rows means anything about it and it
   * gets the plain card menu every other wall in the app draws.
   *
   * Built here rather than in the panel so that one `useCardMenuDeps` serves both surfaces of
   * this screen — two would be two collection-add observers and two sentences to draw for one
   * refusal. It is `cardMenuDeps` **unaltered**, which is the whole of what a tile has to say: no
   * `printingsDeck`, because a search result is not a row of this deck, so there is no slot for a
   * press in the printings modal to rewrite. Absent is not a gap the surface forgot to fill —
   * `printingsItem` reads it as `deck: null` and a press then opens the card pane on the printing,
   * which is what a reader who is not editing this row asked for.
   */
  const panelCardBuild = useCallback(
    (card: CardSummary, picked: readonly CardSummary[] = [], flip = false) =>
      () =>
        // `flip` is the wall's: the tile turns over (issue #844), so the menu offers "Flip card".
        buildCardMenu(
          { ...searchCardTarget(card), flip },
          { ...cardMenuDeps, picked: picked.map(searchCardTarget) },
        ),
    [cardMenuDeps],
  );
  const panelCardMenu = useCallback(
    (card: CardSummary, picked: readonly CardSummary[] = [], flip = false) =>
      menu(panelCardBuild(card, picked, flip)),
    [menu, panelCardBuild],
  );
  /** The keyboard's own door to the same rows. `CardGrid` takes it in a slot of its own because
   *  a keypress has no coordinates — the panel is anchored at the tile's corner rather than at a
   *  pointer that was never there. */
  const panelCardMenuKey = useCallback(
    (card: CardSummary, picked: readonly CardSummary[] = [], flip = false) =>
      menuKey(panelCardBuild(card, picked, flip)),
    [menuKey, panelCardBuild],
  );

  /**
   * Putting the card down: a click anywhere in this editor that was not on a card and not on a
   * control clears the selection.
   *
   * **Clearing the selection closes the pane, because they are the same fact.** The gold ring
   * means "this is the card the pane is about" here exactly as it does on the search wall
   * (`components/CardArt`), so a mark that outlived the pane would be a ring around a card
   * nothing is open on, and a pane that outlived the mark would be a pane about a card the deck
   * is no longer pointing at. There is one piece of state and this is how a reader ends it —
   * the pane's own ✕ and Escape being the other two.
   *
   * One listener at the top of the view rather than one per gap, and {@link keepsSelection} is
   * what makes that safe: the card that was just clicked is *inside* the click that bubbles up
   * here, so without the test every selection would be undone by the press that made it.
   *
   * The early return on `null` is not an optimisation — `setSelectedCardId(null)` also clears
   * `paneDeckContext`, and writing a store slice on every click on the desk would re-render the
   * pane's whole subtree for nothing.
   */
  const dropSelection = useCallback(
    (event: React.MouseEvent) => {
      if (keepsSelection(event.target)) return;
      // **The picked set goes down with the pane** (issue #214), and the guard above is why it is
      // safe to clear it here: a click on a card or on one of a card's controls never reaches
      // this, so the press that *made* a selection cannot be the press that throws it away. A
      // click on the desk is the reader putting everything down.
      setCardSelection(null);
      if (selectedCardId === null) return;
      setSelectedCardId(null);
    },
    [selectedCardId, setSelectedCardId, setCardSelection],
  );

  // The drag's two monitors and the remove tray's drop target are not here: `QuickZones` owns
  // the one that answers for every drag and {@link PriceStrip} owns the one narrowed to the
  // deck's own cards, each so that a `dragstart` re-renders that component rather than this one.
  // What is left in this file is `applyDrop`, which is what a drop *writes* — one place a drag
  // becomes a command, for all three of them.

  // **The auto-scroller is the manager's now, and this file registers nothing for it.**
  // `defaultPreset.plugins` in `@dnd-kit/dom` is
  // `[Accessibility, AutoScroller, Cursor, Feedback, PreventSelection]`, and `lib/dndManager.ts`
  // filters out only `Accessibility` — so the scroller has been installed for the whole window
  // since 3a, walking real scrollable ancestors and scrolling within 20% of one's edge.
  //
  // What that replaces is a `pragmatic-drag-and-drop-auto-scroll` registration on **this page's
  // own element** (`editorRef`), moved there on 2026-08-14 with the growing desk: no view here
  // has a scroller of its own, so the box that has to move to bring a pile — or the remove tray
  // under the deck — under the pointer is the editor's. The scroller the library now finds is
  // `AppShell`'s `main`, which is the one scroller left in this view since 2026-08-24 and is the
  // ancestor the old registration was reaching for through the page.
  //
  // That sentence read "three of the four" until 2026-09-08, and the paragraph after it said the
  // table's own `VirtualTable` scroller — never registered, and a candidate once the library
  // walked real ancestors — was a behaviour change no jsdom test could see. Both premises are
  // gone with the table's scroller: it grows now, so there is one scroller for this whole view
  // again and the library can only find `main`. Worth keeping as a note rather than a rule: a
  // view that reintroduces a scrollport is a view that quietly changes what a drag scrolls, and
  // jsdom cannot go red for it either way, because it measures rectangles.

  /** The deck's new name, once {@link DeckNameField} has decided there is one. The field holds
   *  the draft and refuses a blank or an unchanged name, so there is nothing to re-check here —
   *  this is the same `deck.update` the format select and the `Split X` chip ride. (It named the
   *  Built switch until schema v25 dropped `decks.is_built` along with the allocator the word
   *  meant something to.) */
  //
  // **`deck.update.mutate` and not `deck.update`** in the dependency list since issue #557: the
  // mutation object is a fresh one every render and `mutate` is stable, so this callback is now
  // stable too — which is what lets the memoised header hold. The call is the same call.
  const renameDeck = useCallback(
    (name: string) => {
      updateDeck({ name });
    },
    [updateDeck],
  );

  /**
   * How much room the header has, in the three answers it asks for.
   *
   * **`deskWidth` and not a fourth observer**: the desk row and the header are both full-width
   * children of this one flex column, so the box already measured for the search panel's floor is
   * the box this header is drawn in. Zero is unmeasured and reads as the roomy middle — see
   * {@link TIGHT_HEADER_PX}, where the three numbers are argued.
   *
   * **The picker these replaced is gone with the two selects that drew it.** `pickerFormats` and
   * its game narrowing are still exactly what `DeckSettingsDialog` mounts them for; what this file
   * no longer does is ask a question it was only ever printing the answer to.
   */
  const wideHeader = deskWidth >= WIDE_HEADER_PX;
  const settingsIcon = deskWidth > 0 && deskWidth < SETTINGS_ICON_PX;
  const tightHeader = deskWidth > 0 && deskWidth < TIGHT_HEADER_PX;
  /**
   * The undocked bar's rung, off the same measurement and the same two thresholds, plus one of
   * the bar's own: {@link BAR_WIDEST_PX}, where its `⋯` opens out into buttons. Unmeasured is the
   * middle rung, for the header's reason.
   */
  const barWidth: BarWidth = tightHeader
    ? "tight"
    : deskWidth >= BAR_WIDEST_PX
      ? "widest"
      : wideHeader
        ? "wide"
        : "normal";

  /**
   * What the docked panel's **format filter** opens on — this deck's format, or `null` for
   * `Any format`.
   *
   * **`spec.hasLegalityData` is the fence, and it is the seeded cell rather than a list of the
   * two keys it happens to be false for.** `filters.rs` looks a format key up in
   * `legalities::bit()` and, for a key that build has never heard of, pushes the literal SQL
   * `0` — no rows, deliberately, so an unknown format cannot quietly answer with the whole
   * corpus. `LEGALITY_KEYS` is 23 keys and has never carried `casual` or `limited`: those two
   * are pseudo-formats, `format_specs` rows seeded `has_legality_data = 0`, judged against no
   * card pool at all. So defaulting a Casual deck's panel to `casual` would draw an empty wall
   * with nothing on screen saying why — and `casual` is what every deck is born in, so that is
   * the ordinary case rather than the edge one. Reading the cell is also what keeps this from
   * being a second copy of the seed: a hard-coded pair of keys, or a guess from the spelling,
   * would have to be corrected here on the day a third pseudo-format is seeded.
   *
   * `null` in the two states where there is no spec to read, and it is the right answer in
   * both: while `useFormatSpecs` is still in flight, and for a deck whose format has left the
   * seed (`decks.format_key` is deliberately not a foreign key, so that state can exist). A
   * panel opening on `Any format` is a working panel the reader can narrow themselves; one
   * opening on a filter the backend cannot answer is a wall of nothing.
   *
   * `spec.displayName` rather than `row.formatName`, because the spec is what the fence already
   * required — one source cannot disagree with itself, and the deck row carries its own copy of
   * the name.
   */
  const searchFormatDefault = useMemo(
    () => (row && spec?.hasLegalityData ? { value: row.formatKey, label: spec.displayName } : null),
    [row, spec],
  );

  /**
   * Which rows on screen the plan also asks for — the four views' theory tick.
   *
   * **`deckTheorySlots`, and emphatically not a second `deck_get` of the other variant.** That
   * read was deleted from this file on 2026-08-20 and the test above it pins the deletion:
   * nothing may call `deckGet` for the list the reader is not looking at. Both halves of that
   * decision are honoured here. The *duplicate rule* half — it re-implemented the comparison
   * `deck_theory_diff` owns, and disagreed with it — does not apply, because this is not a
   * comparison: it asks the plan for its rows, which is the one question about the pair that the
   * diff cannot answer in either direction. A card the reader has **fully acquired is absent from
   * the diff and still in the plan**; a card half-acquired is on the diff and also in the plan.
   * The *cost* half is answered by the command itself: two columns of one indexed scan, no
   * prices, no allocation roll-up, no marketplace.
   *
   * **`live` only, and `undefined` everywhere else.** On the Theory tab every row *is* the plan,
   * so a mark on all of them is noise. `undefined` rather than an empty set is the distinction
   * {@link theoryMatchPlan} exists to keep: no plan is not the same statement as a plan that
   * wants none of this.
   *
   * **`enabled` is what stops the fetch and emphatically not what stops the mark** — this note
   * claimed the opposite until issue #159, and the claim was the bug. A disabled `useQuery` still
   * serves whatever sits in the cache under its key, and that key is the **deck's** rather than
   * the tab's, deliberately: both tabs want one entry, so the plan is fetched once and a reader
   * flipping back and forth pays nothing. So a reader who had Live on screen first — which is
   * where every deck without a remembered tab opens — pressed `Theory` and carried Live's answer
   * straight over, onto rows that match it by definition. Anything invalidating `["decks"]` while
   * Live showed refilled that cache, which is why the report was written from a printing swapped
   * through `View all printings`, and why it read as intermittent rather than as the plain
   * consequence of pressing two tabs in order.
   *
   * The gate therefore sits on the **derivation**, where the question is actually asked, and
   * `enabled` is left saying only what it can promise: do not spend a query on a tab with no use
   * for one.
   *
   * Under `["decks"]` like every other read here, so a theory edit made in this session
   * invalidates it with everything else.
   *
   * **`deck.cards` is the second half of it since issue #212**, and it is the *live* list — which
   * on this branch it always is, because the derivation is fenced on `variant === "live"` and
   * `useDeck` is keyed on the variant. The plan says how many copies it wants; what the reader
   * has sleeved up is already in hand, so the difference costs no second read. It is the whole
   * list rather than the filtered `shown`: a card the toolbar's text box has hidden is still a
   * card in the deck, and counting only what is on screen would make the mark change as somebody
   * typed.
   */
  const planned = useQuery({
    queryKey: ["decks", "theorySlots", deckId],
    queryFn: () => ipc.deckTheorySlots(deckId),
    enabled: theoryEnabled && variant === "live",
  });
  // **`theoryEnabled` as well as the tab, for the reason the note above gives about `enabled`.**
  // A disabled `useQuery` still serves what sits in the cache under its key, and this key is the
  // deck's — so a reader who had the marks on screen and then switched the plan off in Deck
  // settings kept every one of them: a mark about a list the deck no longer admits to having,
  // beside a tab strip and a `Compare` that had both correctly gone. Same fix as the tab's, on
  // the same line, because it is the same mistake one axis over — the gate belongs where the
  // question is asked.
  // **`row !== null` is a narrowing rather than a third gate.** `theoryEnabled` is read off that
  // row, so it is already false without one; what the test buys is the three switches below
  // being reachable at the type level, which is the whole of how a per-deck mark reaches the
  // screen.
  const theoryPlan = useMemo(
    () =>
      theoryEnabled && variant === "live" && row !== null
        ? theoryMatchPlan(planned.data, deck.cards, {
            // The deck's own answer to *which of the three marks do I want drawn*, carried into
            // the plan so `theoryMatchMark` needs no second argument at every call site in four
            // views — `theoryMatch.ts`'s `TheoryMarkSwitches` says why it is three booleans and
            // not one ordered field, and why the red one is a tier below the other two rather
            // than a third answer about a printing.
            exact: row.theoryMarkExact,
            name: row.theoryMarkName,
            unplanned: row.theoryMarkUnplanned,
          })
        : undefined,
    [planned.data, theoryEnabled, variant, deck.cards, row],
  );

  /**
   * How far the live list has got toward the plan — the stats band's `Matches theory` figure,
   * derived from the query above rather than from one of its own.
   *
   * **Gated on exactly the pair `theoryPlan` is gated on, and for exactly that reason.** A
   * disabled `useQuery` still serves whatever sits in the cache under its key, and this key is
   * the *deck's*: without the gate, pressing `Theory` after Live had loaded would carry Live's
   * answer over and compare the plan against **itself**, since `deck.cards` is the plan's own
   * rows on that tab. The figure would read `100%` — issue #159's mark-side bug, one readout
   * over, and it would be the more convincing for being a plausible number.
   *
   * A memo because it walks every row of the deck and the band is redrawn on every edit; the
   * dependency list is the memo above's less the three mark switches, which this does not read.
   */
  const theoryDone = useMemo(
    () => (theoryEnabled && variant === "live" ? theoryProgress(planned.data, deck.cards) : null),
    [planned.data, theoryEnabled, variant, deck.cards],
  );

  /**
   * Whether the deck **draws** a game changer at all — the chip's own gate, and deliberately
   * not {@link gameChangers}.
   *
   * That figure counts *copies over the piles that count* (`categoryActive`), because it is a
   * rules readout: the number the format will judge. This is a question about what is on the
   * desk. A game changer parked in a switched-off Maybeboard is exactly a card a reader wants to
   * ask *where are the powerful ones* about — it is still in front of them — so the chip is drawn
   * for it and the filter matches it. That is the same split `validateForMarks` and
   * `validateDeck` already make one screen over (issue #134): a claim about the deck, and an
   * answer about each card drawn.
   */
  const hasGameChangers = useMemo(
    () => deck.cards.some((card) => card.gameChanger === true),
    [deck.cards],
  );

  /**
   * The chip's press **as the filter actually reads it** — derived at render and never stored.
   *
   * The chip is drawn only for a deck that draws a game changer, so it cannot be *pressed* on a
   * deck with none; but the flag is this component's state and the answer is a memo over the
   * deck's rows, so an edit that removes the last game changer takes the chip away and would
   * leave `gcOnly` standing — a deck narrowed to nothing, with nothing on screen to press to get
   * it back. Gating the **derivation** rather than clearing the flag in an effect is what keeps
   * that a *read*: this repo's lint refuses `setState` in an effect and refuses it only at
   * `pnpm verify`, and a reader who steps a card to zero and undoes it finds their filter
   * exactly where they left it.
   *
   * **It is gated on exactly what draws the chip and must go on being so.** {@link DeckLedger}
   * draws the chip on `hasGameChangers`, so gating this on the *count* beside it would take the
   * fence away in the one case the two disagree about — a game changer parked in a switched-off
   * pile, where the count is nothing and the chip is there to be pressed.
   */
  const gcFilter = gcOnly && hasGameChangers;

  /**
   * Whether the `{X}` spells get a heading of their own — **the deck's, not this editor's.**
   *
   * `decks.separate_x_group` (schema v13), so it survives closing the deck and is answered per
   * deck rather than per session: a storm list where half the spells are `{X}` reads quite
   * differently from an aggro deck with one Fireball in it. Which is why it is not `useState`
   * beside `groupBy` and `sortBy` — those two are how the reader is looking *now* and are
   * deliberately thrown away with the editor.
   *
   * `false` while the read is in flight and for a deck that has gone: the editor's frame renders
   * before `deck_get` answers, and a grouping is not a thing to hold up on a boolean.
   */
  const separateX = row?.separateXGroup === true;

  /**
   * What `buildGroups` needs beyond the piles themselves to decide which **empty** headings are
   * drawn — the deck's format, and nothing else. It cannot reach a group that holds a card,
   * because `drawsWhenEmpty` is not asked about one, so nothing here hides cardboard.
   *
   * `requiresCommander` falls back to `false`, and the fallback is the half worth writing down.
   * `useFormatSpecs` answers `null` twice over: while the table is still loading, and for a deck
   * whose `formatKey` has left the seed — `decks.format_key` is deliberately not a foreign key,
   * so that state can exist and the deck must still open. A deck with no format opinion
   * therefore gets no empty command zone. That costs nothing, because a command zone **holding a
   * card** draws whatever the format says, so the heading arrives with the first card filed
   * there and never after it.
   *
   * **The `narrowed` half is gone, and the filter is deliberately not a dependency of this memo
   * any more.** It reported whether the toolbar's box or a label chip was running, and while one
   * was, only the four seeded zones drew empty. Every pile that wall was made of was one the app
   * had created while filing a card, and `grouping.ts` now keeps those out whenever they are empty
   * — a pile the filter emptied included. What is left drawing under a filter is the reader's own
   * piles, which is what they asked for, so the editor has one fact to pass rather than two and
   * this recomputes only when the format does.
   */
  const emptyGroupRules = useMemo(
    () => ({ requiresCommander: spec?.requiresCommander ?? false }),
    [spec],
  );

  /**
   * Every finding, filed under each row it marks, so a view can mark a card — by the row's slot
   * and never by its printing, so a parked copy does not wear the break its active twin is part
   * of (issue #554).
   *
   * The second validation pass on this screen — `ValidationPanel` makes its own for the chip's
   * count — and that is the cheaper of the two arrangements rather than an oversight: the engine
   * is pure over a few hundred rows, and the alternative is lifting the panel's state out of the
   * panel so that a chip and a set of marks share one array. Two `useMemo`s over the same input
   * cannot disagree; two owners of one array can.
   *
   * **`validateForMarks` rather than `validateDeck`, and the difference is the whole of issue
   * #134.** The panel counts the deck, which a card in a switched-off pile is not part of; the
   * marks answer for every card *drawn*, parked ones included, because a card a reader has put
   * in their Maybeboard is a card they are asking a question about. The two are separate
   * functions rather than one with a flag precisely so the chip cannot pick up the answer
   * meant for the frames.
   */
  const violations = useMemo(
    () =>
      spec ? violationsBySlot(validateForMarks([...deck.cards], spec), deck.cards) : undefined,
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

  /**
   * The **live** list's piles, read on the Theory tab for one fact: the name of the pile
   * `decks.default_category_id` points at, which {@link targetCategoryId} carries across to the
   * plan's pile of that name.
   *
   * `deck_category_list` rather than a second `deck_get` — a name is all this wants, and the key
   * is `useDeckMeta`'s, so a Categories dialog opened on the Actual tab shares the answer and every
   * write's `["decks"]` invalidation reaches it. **Gated on the tab and on there being a pile to
   * resolve**: on the Actual tab the id is read against the piles already on screen, and Auto
   * names none. The tab gate is repeated where the answer is *used*, because a disabled query
   * still serves what its key holds — `planned`'s lesson below.
   */
  const defaultLivePiles = useQuery({
    queryKey: ["decks", "categories", deckId, "live", marketplace.id],
    queryFn: () => ipc.deckCategoryList(deckId, "live", marketplace.id),
    enabled: variant === "theory" && row !== null && row.defaultCategoryId !== AUTO_CATEGORY,
  });

  /**
   * Where the docked panel's adds land, and the quick add with them — **the deck row's answer**
   * (`decks.default_category_id`), read here and handed down.
   *
   * {@link AUTO_CATEGORY} (`0`) is the one value that is not a category, and it is what a deck is
   * born on: an add nobody filed is filed by what the card *does*.
   *
   * **It was `useState` in this component until 2026-08-15, and the move is the whole point of
   * this being a deck setting.** A reader who pointed the panel at their Sideboard lost the
   * choice the moment they closed the deck, and the control that set it sat in the editor's own
   * chrome — where a *setting* was being asked for on the row a reader adds cards from, and
   * where the second surface it governs (the toolbar's quick-add field) drew nothing at all.
   * `DeckSettingsForm` asks it once now, beside the format and the folder.
   *
   * **An id the deck's categories do not carry reads as Auto**, and that fallback is a *read*
   * rather than the repairing write the old clamp was. Nothing needs repairing: deleting a pile
   * puts every deck filing by it back to zero in the same transaction. What is left is the one
   * render a deleted pile can be caught in, where the deck row and the category list arrive on
   * the same commit and nothing orders them — and Auto is the honest answer there, because it is
   * where the deck is about to land anyway.
   *
   * **On the Theory tab it is resolved by name** (issue #561). The setting names a *live* pile —
   * Deck settings offers the live list's — and since user schema v53 the plan has piles of its
   * own, so the stored id is never one on screen there. {@link defaultPileFor} carries it across
   * by the live pile's name to the plan's pile of that name, else Auto; the one extra read that
   * needs is {@link defaultLivePiles}.
   */
  const targetCategoryId =
    row === null
      ? AUTO_CATEGORY
      : defaultPileFor(
          row.defaultCategoryId,
          categories,
          variant === "theory" ? defaultLivePiles.data : undefined,
        );

  /**
   * **Which one card is picked** — the deck row the pane was opened from, as a
   * {@link deckCardSlot}, or `null`.
   *
   * The mark used to be `selectedCardId` straight out of the store, and that was the bug this
   * replaced (2026-08-17): a printing filed in two piles was marked in both, so one click stood
   * a card clear of the stack in two places at once. A deck row is `(category, card)` and a
   * click names one of them, so the mark is now addressed the way every deck *write* already is
   * — and it comes from `paneDeckContext`, which is the store's own answer to "which row did
   * this card come out of" and needed no new state to say so.
   *
   * **A card opened from anywhere that is not a row of this deck marks nothing**, which is a
   * second change and the deliberate half of it. The docked panel's tiles, the validation
   * panel's names and every other opener go through `setSelectedCardId`, which clears the
   * context in the same write — so the old rule marked *every* copy of a panel tile's card in
   * the deck, which is the reported defect reached by a different gesture. There is no one slot
   * to pick, so nothing is picked.
   *
   * **The `variant` test is the one that can actually fail.** `setOpenDeckId` clears the context,
   * so `deckId` cannot drift and is restated here only because this expression should not have to
   * be read against a store invariant two files away. The variant can: the toolbar switches
   * `live`/`theory` without touching an open pane, and the same printing in the same category of
   * both lists is exactly the case `useSwapFromPane` was once caught rewriting the wrong half of.
   */
  const selectedSlot =
    paneDeckContext !== null &&
    paneDeckContext.deckId === deckId &&
    paneDeckContext.variant === variant
      ? deckCardSlot(paneDeckContext.categoryId, paneDeckContext.cardId, paneDeckContext.finish)
      : null;

  /** What the add target is called, or `null` under {@link AUTO_CATEGORY} — where there is no
   *  one answer, because the pile is per card. */
  const targetName =
    targetCategoryId === AUTO_CATEGORY
      ? null
      : (categories.find((c) => c.id === targetCategoryId)?.name ?? "this deck");

  /**
   * Undo and redo, and the picked set's Delete — `useDeckKeyboard`, where both handlers and every
   * word of their argument moved (issue #557). Called here, below every write they reach.
   */
  useDeckKeyboard({
    runUndo: undo.runUndo,
    runRedo: undo.runRedo,
    layerOpen: layer !== null,
    pickedRef,
    setQuantityAt,
    reportBatch,
    setCardSelection,
  });

  /** The size the band and the pile both draw a token at, which the picker has to agree with or
   *  a swap does not read as one — `DeckTokensPanel`'s header has the whole argument. */
  const tokenZoom = useAppStore((s) => s.cardZoom.deck);

  /**
   * Whether the views draw the Tokens & Emblems pile at all — **once the deck row has answered,
   * and on every deck** (managed tokens spec §3.9). It was `decks.token_mode`'s, where `hidden`
   * took the pile out of all four views; the mode's control is gone and the column stays with
   * nothing reading it, because with every token at 0 until the reader counts it there was nothing
   * left for it to decide. A deck set to `hidden` before this build draws its pile again, which is
   * the tokens its reader has counted and nothing else ({@link pileTokenList}). Still `false` until
   * the row has answered, so the pile does not flash into a deck mid-open.
   */
  const tokenPileDrawn = row !== null;
  const tokenList = deckTokens.tokens;
  const setTokenQuantity = deckTokens.setQuantity;
  const swapToken = deckTokens.swap;
  const addTokenPrinting = deckTokens.addPrinting;
  const removeToken = deckTokens.remove;

  /**
   * **The tokens the stacks draw: the ones the reader has counted** — `pileTokens`, the band's
   * list less every entry at 0 (managed tokens spec §3.2). **This is the one place the filter is
   * applied**: the band draws every row, the picker's `add` mode offers the printings of every
   * token the deck has, and the live side of {@link tokenPlan} reads every row too, so a mark is
   * about an entry the reader can see on the band whether or not it is in the pile. Nothing reads
   * `hidden` any more (§3.3): a dismissal an older peer synced in after the launch pass ran is
   * drawn like any other token, in the pile once it has copies.
   */
  const pileTokenList = useMemo(() => pileTokens(tokenList), [tokenList]);

  /**
   * What the one printing picker is open for — **one picker for the band's tiles, the views' pile
   * and the band's `Add printing` alike** (token stacks, spec §4.6), so every way in opens the
   * same dialog and a pick writes through the one {@link deckTokens}:
   *
   * - **`swap`**, from a press on an entry in the pile or on the band: the picker swaps **that
   *   entry** (rule 4) and never the token's other entries, so it is held by the entry's
   *   `entryKey` — the printing and the finish — and not by the token's `oracle_id`, which a
   *   token's two entries share.
   * - **`add`**, from the band's `Add printing`: the printings of every token the deck has — the
   *   band's whole list, at 0 included — or, with the picker's `All tokens`, of any token in the
   *   game; a pick is rule 5 at one copy.
   *
   * **A key and never the view**, which is the `Layer` union's rule: the entries are re-derived
   * after every write, so a frozen view would answer about the entry as it was when it was
   * pressed — a quantity stepped since, a printing another write has moved — and a swap made
   * through it would name a `from` the list may no longer hold. Looked up in `deckTokens.tokens`,
   * which is every entry either surface can draw: the pile draws a subset of it (the entries with
   * copies) and the band draws all of it.
   *
   * **An entry that has gone is no entry to swap, and the key goes with it** — reset here, during
   * render, which is this file's own pattern for state that has to follow a read (never an effect,
   * which is a `setState` the lint refuses). Shutting the dialog through `mode` alone is not
   * enough: `Dialog`'s `onClose` runs only for the reader's own presses, so the key would outlive
   * the entry, and a later read that brought the same entry back — an undo taking a Treasure away
   * and the redo returning it — would reopen a picker nobody pressed for. The reset only ever
   * writes `null`, and only while a swap's lookup misses, so it cannot cycle.
   */
  const [pickingToken, setPickingToken] = useState<TokenPicking>(null);
  const pickedEntry =
    pickingToken?.kind === "swap"
      ? tokenList.find((view) => view.entryKey === pickingToken.entryKey)
      : undefined;
  if (pickingToken?.kind === "swap" && pickedEntry === undefined) setPickingToken(null);
  const tokenPicker = useMemo(() => {
    if (pickingToken === null) return null;
    if (pickingToken.kind === "add") return { kind: "add" as const, tokens: tokenList };
    return pickedEntry === undefined ? null : { kind: "swap" as const, entry: pickedEntry };
  }, [pickingToken, tokenList, pickedEntry]);
  /**
   * **The control that opened the picker** — read off `document.activeElement` at the press, which
   * is {@link openPull}'s answer for its reason: the press is a picture on a tile or a line, or the
   * band's Add printing, none of which hands a ref up, and a press focuses what it presses. It is
   * where Escape and the ✕ hand the caret back (`Dialog`'s `onDismiss` contract), where a refused
   * pick leaves it, and — by the surface it sits in, the band or the pile — where a landed pick
   * looks for the tile it made ({@link pickCaret}).
   */
  const tokenPickerOpener = useRef<HTMLElement | null>(null);
  /** A press on an entry, from the pile or the band — stable, because the pile's memo holds it. */
  const pickTokenEntry = useCallback((view: DeckTokenView) => {
    tokenPickerOpener.current = focusable(document.activeElement);
    setPickingToken({ kind: "swap", entryKey: view.entryKey });
  }, []);
  /**
   * A press on a token's card in the pile: open the card details on that entry's printing
   * (issue #619), as a press on a deck card does. **`setSelectedCardId` and never
   * `openCardFromDeck`**: a token is no `deck_cards` row, so there is no deck slot to name, and the
   * store's own clearing of `paneDeckContext` is what keeps the modal from offering a swap or a
   * finish write against a row that does not exist. Stable, because the pile's memo holds it.
   */
  const openTokenCard = useCallback(
    (view: DeckTokenView) => setSelectedCardId(view.printingId),
    [setSelectedCardId],
  );
  /** The band's Add printing. */
  const addTokenEntry = useCallback(() => {
    tokenPickerOpener.current = focusable(document.activeElement);
    setPickingToken({ kind: "add" });
  }, []);
  /**
   * Where a pick's caret goes when the tile it made cannot be found, where the pick was refused,
   * and where Escape sends it: the opener, **if it can still take it** — a swap takes its own
   * entry's tile away, opener and all — and otherwise the band's Add printing, the floor
   * `tokenCaret.ts` names for both surfaces.
   */
  const tokenPickerHandBack = useCallback(
    () =>
      focusable(tokenPickerOpener.current) ??
      focusable(editorRef.current?.querySelector(`[${TOKEN_ADD_ATTR}]`)) ??
      editorRef.current,
    [],
  );
  /** Escape and the ✕ — `Dialog`'s contract: hand the caret back to the opener, then close. */
  const dismissTokenPicker = useCallback(() => {
    tokenPickerHandBack()?.focus();
    setPickingToken(null);
  }, [tokenPickerHandBack]);
  const closeTokenPicker = useCallback(() => setPickingToken(null), []);
  /** The caret owed by a pick — see {@link tokenPickerOpener}. Every entry, the band's list: a
   *  swapped or added printing is on it whether or not the pile draws it. */
  const pickCaret = usePickCaret(tokenList);

  /**
   * The **theory** list's tokens — the plan's half of the token pile's marks (token stacks, spec
   * §3.5 and §4.8), and emphatically not a second drawing of anything.
   *
   * **Only `tokens` is read here, never a write.** The hook comes with its writes, and every one
   * of them belongs to {@link deckTokens}: one picker, one write observer. A write through this
   * copy would land on the theory list — the list the reader is not looking at — and report its
   * refusal to nobody. This is a read.
   *
   * **A `null` deck id unless the question is being asked**, which is `theoryPlan`'s pair one
   * read over — a deck that keeps a plan, read on its Live list — once the deck row has answered
   * ({@link tokenPileDrawn}). It also waited on the token mode until managed tokens retired it
   * (spec §3.9): a deck whose pile was hidden drew no marks, and every deck draws its pile now.
   * `null` disables the query (the hook gates on it) *and* moves its key off this deck's, so a
   * disabled read cannot serve a cached answer the way issue #159's did — though the gate that
   * means it is still on the derivation below, where the question is asked.
   */
  const planTokens = useDeckTokens(
    tokenPileDrawn && theoryEnabled && variant === "live" ? deckId : null,
    "theory",
  );
  const planTokenRows = planTokens.tokens;
  const planTokensLoaded = planTokens.query.isSuccess;

  /**
   * The plan as a lookup over tokens — `tokenTheory.ts`, which is `theoryMatchPlan` fed the two
   * lists' tokens, under the deck's own three mark switches.
   *
   * **`undefined` until the theory list's tokens have answered**, and that gate is the whole of
   * why a plan with tokens does not flash a wall of red X on every open. `useDeckTokens` answers
   * `[]` while its read is in flight, and `[]` is a plan that asks for nothing — every live token
   * would be marked as off-plan for the length of one round trip. `isSuccess` rather than the
   * list's length: a plan that genuinely makes no tokens is an answer, and its marks are the X.
   *
   * Gated on exactly the pair {@link theoryPlan} is gated on, for that memo's reason; `row !==
   * null` narrows the three switches into reach.
   *
   * **Both sides are every row of their list** — the band's, not the pile's — so the plan's
   * arithmetic sees a live entry at 0 as the 0 it is, rather than as an entry the deck does not
   * hold; the marks are drawn on the pile, which is the counted subset of the same rows.
   */
  const tokenPlan = useMemo(
    () =>
      row === null || !(theoryEnabled && variant === "live")
        ? undefined
        : tokenTheoryPlan(planTokensLoaded ? planTokenRows : undefined, tokenList, {
            exact: row.theoryMarkExact,
            name: row.theoryMarkName,
            unplanned: row.theoryMarkUnplanned,
          }),
    [row, theoryEnabled, variant, planTokensLoaded, planTokenRows, tokenList],
  );

  /**
   * Where the reader last put the token pile, drawn **before** the write that stores it has
   * answered — {@link localCategoryOrder}'s arrangement, for the one pile that is not a category.
   *
   * A move is a round trip *and* a re-read of the deck, so a pile drawn from the column alone
   * stays where it was until both land: the grip goes on saying `3 of 3` after the press, and a
   * second press inside that beat sends the first one's index again — two presses, one place. So
   * the press is drawn at once and the column takes over again at one of two moments:
   *
   * - **A refusal drops it**, which is the case that matters: a lie about where the pile is must
   *   not outlive the write that failed, and the banner says why (`deck.update` is in `writes`).
   * - **Success drops it once the deck has been read again behind the write**, never at the
   *   answer itself. The answer arrives with the re-read still in flight, and the column in hand
   *   is the one from before the press; drawing it then would jump the pile back for a beat. Once
   *   the write has settled *and* nothing is fetching, the column is the answer — whatever put it
   *   there, so an undo or another device's move is followed from then on rather than masked.
   *   That is the "clear once the stored row agrees" rule stated so it cannot stick: waiting for
   *   the column to *equal* the press would hold a stale press for ever the day something else
   *   moved the pile in the same beat.
   *
   * **`seq` is what makes that the latest press's answer.** Each press is its own `mutateAsync`,
   * and the promise belongs to the call rather than to the observer (`startLabelCreate`'s note), so
   * an older write answering between two presses is recognised and ignored rather than settling
   * the newer one early — or dropping it on its own refusal, when the newer write is what the
   * reader meant.
   */
  const [localTokenRail, setLocalTokenRail] = useState<{
    index: number;
    seq: number;
    settled: boolean;
  } | null>(null);
  const tokenRailSeq = useRef(0);
  // Reset during render — this file's own pattern for state that has to follow a read — and
  // monotone, so it cannot cycle: it only ever writes `null`, and only while there is a press.
  if (localTokenRail?.settled === true && !deck.query.isFetching) setLocalTokenRail(null);

  /**
   * Put the token pile at rail slot `index` — `-1` is last — through the deck's own `update`, the
   * one `tokensOpen` and `Split X` ride. `decks.token_rail_index` is a deck column like those, so
   * the write needs no mutation of its own and joins the refused-write family by already being in
   * it: a refused move says so in the editor's banner, and the rejection is swallowed here rather
   * than reported twice.
   *
   * `mutateAsync` rather than the mutation object, because it is stable across renders and the
   * object is not — this callback is in {@link tokenPile}'s memo, and a new pile on every change of
   * the mutation's own state would redraw four views for nothing — and rather than `mutate`,
   * because a `mutate` call's callbacks belong to the observer and the next `deck.update` of any
   * kind (the band's disclosure, a rename) takes them away, which would leave a press unsettled.
   */
  const updateDeckAsync = deck.update.mutateAsync;
  const moveTokenPile = useCallback(
    (index: number) => {
      tokenRailSeq.current += 1;
      const seq = tokenRailSeq.current;
      setLocalTokenRail({ index, seq, settled: false });
      updateDeckAsync({ tokenRailIndex: index }).then(
        () => setLocalTokenRail((now) => (now?.seq === seq ? { ...now, settled: true } : now)),
        () => setLocalTokenRail((now) => (now?.seq === seq ? null : now)),
      );
    },
    [updateDeckAsync],
  );

  /**
   * The pile each view draws among the rail's piles, or `undefined` — which is the whole of the
   * off switch, since a view handed nothing draws exactly what it drew before the pile existed.
   * `undefined` until the deck row has answered ({@link tokenPileDrawn}); a pile whose tokens are
   * all at 0 is an empty list, which the views draw as no pile at all (`hasTokenPile`).
   *
   * Its tokens are {@link pileTokenList} — **the counted entries only**, one view per entry, so a
   * token with two printings is two cards and one at 0 is none. The stepper writes the entry it is
   * on (`setQuantity` takes the entry's address), a press on the card opens the card details
   * ({@link openTokenCard}, issue #619), **Change the art** opens the picker to swap that entry
   * ({@link pickTokenEntry}), and **Remove printing** deletes it (`remove`, managed tokens spec
   * §3.4) — the same stable write the band's tile presses.
   *
   * **Nothing here enters `groups`, `deck.cards` or `buildGroups`**, and that is what keeps a
   * token out of the deck's size, every pile total, the ledger, the stats and validation — the
   * views place it in their own layer, beside the groups this editor hands them.
   *
   * **Three fields beyond the tokens and their three writes** (token stacks, PR 1):
   * - `railIndex` is the reader's last press while it is in flight ({@link localTokenRail}), and
   *   otherwise `decks.token_rail_index` as stored — `-1`, or any slot the rail no longer has,
   *   reads as last. The views clamp it on read (`tokenRailSlot`); this passes the column through
   *   untouched, so a rail that shrinks and grows back puts the pile where it was.
   * - `moveTo` is {@link moveTokenPile}, and its presence is what draws the pile's grip.
   * - `theoryMark` is {@link tokenPlan} asked about one entry, or absent where there is no plan
   *   to ask — a deck without one, the Theory tab, or a plan still loading. Absent draws no marks,
   *   which is the same statement `theoryPlan` being `undefined` makes about the deck's cards.
   *
   * Memoised on the tokens, a `setQuantity` that `useDeckTokens` keeps stable, a `remove` that
   * changes only with the tokens ({@link removePileToken} reads them as the list before), a
   * stable press, the drawn index (the in-flight move, else the stored column), a stable move and
   * the plan, so a keystroke anywhere in the editor does not hand four views a new pile.
   */
  const tokenRailIndex = localTokenRail?.index ?? row?.tokenRailIndex ?? -1;

  /**
   * The token pile as the printings modal's walk counts it — what {@link DeckDesk} publishes the
   * walk with. **Memoised on the three facts the walk read straight off this component** before the
   * walk moved to the desk (issue #557), so the desk's memo over it recomputes exactly when it used
   * to. Nothing until the deck row has answered, as the pile draws nothing.
   */
  const walkTokens = useMemo(
    () => (tokenPileDrawn ? { views: pileTokenList, railIndex: tokenRailIndex } : undefined),
    [tokenPileDrawn, pileTokenList, tokenRailIndex],
  );

  /**
   * **The pile's Remove printing, handing the caret on** (`tokenCaret.ts`) — kept here rather than
   * in the pile, because the pile unmounts with its last entry and would take an owed caret with
   * it. The target is looked up in the pile by attribute after the re-read has drawn it: the same
   * token's next entry, else the next token. **The floor is the band's Add printing, not the
   * pile's grip**, and that is not a shortcut: the floor is only reached when the pile has no
   * entry left, and a pile with no entry is not drawn, grip and all (`hasTokenPile`). The editor's
   * own box is under that, for a band whose read was refused and draws no Add printing.
   */
  const pileRoot = useCallback(
    () => editorRef.current?.querySelector(`[${TOKEN_PILE_ATTR}]`) ?? null,
    [],
  );
  const pileFloor = useCallback(
    () => focusable(editorRef.current?.querySelector(`[${TOKEN_ADD_ATTR}]`)) ?? editorRef.current,
    [],
  );
  const removePileToken = useRemoveCaret({
    views: pileTokenList,
    remove: removeToken,
    root: pileRoot,
    fallback: pileFloor,
  });

  const tokenPile = useMemo<TokenPile | undefined>(
    () =>
      tokenPileDrawn
        ? {
            tokens: pileTokenList,
            setQuantity: setTokenQuantity,
            remove: removePileToken,
            pickArt: pickTokenEntry,
            openCard: openTokenCard,
            railIndex: tokenRailIndex,
            moveTo: moveTokenPile,
            theoryMark:
              tokenPlan === undefined ? undefined : (view) => tokenTheoryMark(tokenPlan, view),
          }
        : undefined,
    [
      tokenPileDrawn,
      pileTokenList,
      setTokenQuantity,
      removePileToken,
      pickTokenEntry,
      openTokenCard,
      tokenRailIndex,
      moveTokenPile,
      tokenPlan,
    ],
  );

  /*
   * **What the memoised bands and the ledger are handed, held still** (issue #557). Each of these
   * was an arrow written in the JSX below, which is a new function every render — and a new prop
   * every render is a memo that never holds. `mutate` is stable, so each of these is too.
   */
  const toggleNotes = useCallback((next: boolean) => updateDeck({ notesOpen: next }), [updateDeck]);
  const toggleTodos = useCallback((next: boolean) => updateDeck({ todosOpen: next }), [updateDeck]);
  const toggleGcOnly = useCallback(() => setGcOnly((on) => !on), []);

  /**
   * The ledger's two controls, built here because each opens one of this editor's layers — and
   * **built in a `useMemo`** since issue #557, so the memoised `DeckLedger` is handed the same two
   * elements until something either of them draws has changed.
   */
  const checkOpen = layer?.kind === "check";
  const check = useMemo(
    () =>
      // Nothing at all while the seeded rules are not in hand. A format the seed no longer
      // carries has no rules to judge against, and a button that said "No issues" because
      // nothing was checked would be the one sentence this panel must never write.
      spec && (
        <ValidationPanel
          cards={deck.cards}
          spec={spec}
          open={checkOpen}
          tight={tightHeader}
          buttonRef={chipRef}
          onOpen={openCheck}
          onDismiss={dismiss}
          onClose={close}
          onSelectCard={setSelectedCardId}
        />
      ),
    [deck.cards, spec, checkOpen, tightHeader, openCheck, dismiss, close, setSelectedCardId],
  );
  const bracketOpen = layer?.kind === "bracket";
  const bracket = useMemo(
    () =>
      // Only where the format has a command zone: a bracket is the Commander
      // conversation, and `estimateBracket` is a per-edit pass over every face of every
      // card that must not be paid by a Standard deck that has no use for the answer.
      spec?.commanderRule != null &&
      row !== null && (
        <DeckBracket
          cards={deck.cards}
          // The reader's own answer, and the write that sets it. `AUTO_BRACKET` is `0` and
          // is a real value in the patch rather than an absent field, which is what makes
          // "put it back to Auto" reachable at all — `DeckPatch`'s rule is that an absent
          // field means "leave it", so the sentinel is the same shape `defaultCategoryId`
          // already uses for the same reason.
          //
          // `deck.update` and not a mutation of its own: it is already in this editor's
          // `writes` array, so a refused bracket lands in the one banner above with every
          // other write's, and the refusal rule stays on the mutation's single definition.
          bracket={row.bracket}
          onBracket={(bracket) => updateDeck({ bracket })}
          open={bracketOpen}
          buttonRef={bracketRef}
          onOpen={openBracket}
          onDismiss={dismiss}
          onClose={close}
        />
      ),
    [spec, row, deck.cards, updateDeck, bracketOpen, openBracket, dismiss, close],
  );

  /**
   * The undocked bar's props — every one of them this editor's — handed to {@link DeckDesk}, which
   * adds the four it answers (the filter, and the Display menu's name and rows) and draws the bar.
   */
  const bar: DeckBarProps | null =
    row === null
      ? null
      : {
          undocked,
          width: barWidth,
          onTop: backToTop,
          quickAddTarget: targetName,
          onQuickAdd: (card) => addTo(card.id, targetCategoryId, card.typeLine),
          lists: theoryEnabled
            ? {
                variant,
                onPick: pickVariant,
                onCompare: (trigger) => openLayer({ kind: "theoryDiff" }, handBackToBar(trigger)),
                comparing: layer?.kind === "theoryDiff",
              }
            : null,
          undo: {
            label: undo.undoLabel,
            disabled: undo.undo === null || undo.busy,
            run: undo.runUndo,
          },
          redo: {
            label: undo.redoLabel,
            disabled: undo.redo === null || undo.busy,
            run: undo.runRedo,
          },
          actions: barActions,
        };

  /** The header's first two lines, drawn by this editor and placed by {@link DeckDesk}. */
  const header = (
    <>
      <DeckEditorHeader
        backRef={backRef}
        closeDeck={closeDeck}
        name={row?.name ?? null}
        renameDeck={renameDeck}
        theoryEnabled={theoryEnabled}
        variant={variant}
        pickVariant={pickVariant}
        layer={layer}
        openLayer={openLayer}
        tightHeader={tightHeader}
        wideHeader={wideHeader}
        settingsIcon={settingsIcon}
      />

      {row && (
        // What the deck adds up to, and what the rules make of it — the second of the header's
        // three lines. See {@link DeckLedger}, which owns the figures; the three controls at its
        // right end are this file's, because each opens one of its layers.
        <DeckLedger
          cards={deck.cards}
          marketplace={marketplace}
          formatName={spec?.displayName ?? row.formatName ?? null}
          gameChangers={gameChangers}
          // The count is what the format will judge and the gate is what is on the desk, so the
          // chip is drawn for a game changer parked in a switched-off pile and says only `Game
          // Changers` for it. See both props for the split.
          hasGameChangers={hasGameChangers}
          gameChangersOnly={gcFilter}
          onGameChangersOnlyToggle={toggleGcOnly}
          tight={tightHeader}
          // Four terms rather than five on a Virtual deck — the `Owned` figure is the one thing
          // on this line that is about a *binder* rather than about the deck. See {@link tracks}.
          tracksCollection={tracks}
          check={check}
          bracket={bracket}
        />
      )}
    </>
  );

  /** The toolbar's quick add and undo pair — this editor's writes, in the desk's toolbar. */
  const tools = (
    <>
      {/* The fastest way to put a card in a deck you already know the name of. Where it
          lands is the deck's own `defaultCategoryId`, chosen in deck settings — one place
          for one decision, rather than a select of the same categories on this row and
          another on the panel's. This field draws no control for it and never did: it was
          the panel's select that answered for both, which is the asymmetry that made the
          choice worth moving out to a *setting*. What the field shows instead is the answer,
          in its own label ({@link targetName}). */}
      <div className={cn("flex shrink-0 items-center gap-1.5", tightHeader && "order-3")}>
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

      {/* **Icons rather than words, and on this row rather than in the header.** The
          header's actions block measured 825px against the ~729 a 1280px window can spare
          (2026-08-14, a debug build, **five** buttons — `Export deck` is a sixth and nothing
          has been re-measured since), so it already wraps — and a wrapped header costs 44px
          of deck height at the app's own default size (see {@link PLAIN_PRESS}). Two more text
          buttons there would make that worse at every width; two 36px icons here cost 76px
          on the row that is already about editing the deck's contents.

          The name is the whole sentence — "Undo — Removed 2 × Lightning Bolt" — which is
          what a caret and a pointer both get, since the glyph says nothing. It comes from
          `auditText`, the same module the history drawer words its lines with. */}
      <div
        role="group"
        aria-label="Undo and redo"
        className={cn("flex shrink-0 items-center gap-1", tightHeader && "order-3")}
      >
        {(
          [
            {
              key: "undo",
              Icon: Undo2,
              label: undo.undoLabel,
              on: undo.undo,
              run: undo.runUndo,
            },
            {
              key: "redo",
              Icon: Redo2,
              label: undo.redoLabel,
              on: undo.redo,
              run: undo.runRedo,
            },
          ] as const
        ).map(({ key, Icon, label, on, run }) => (
          <button
            key={key}
            type="button"
            onClick={run}
            // **`aria-disabled`, never the attribute** — this greys and un-greys as the
            // reader edits, and a `disabled` button drops out of the tab order under a
            // caret that is sitting on it.
            aria-disabled={on === null || undo.busy}
            aria-label={label}
            {...tip(label, { describes: false })}
            className={cn(
              PLAIN_PRESS,
              FILTER_FOCUS,
              "grid w-9 place-items-center px-0",
              on === null || undo.busy ? "cursor-default opacity-40" : "hover:text-text",
            )}
          >
            <Icon aria-hidden className="size-4" />
          </button>
        ))}
      </div>
    </>
  );

  /** Everything between the toolbar and the desk. */
  const notices = (
    <>
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
              Couldn't change this deck — {bannerFailure}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The quick zones' `Auto`, when the rule had nothing to do — the card is already in the
          pile it names, or there is no pile for it. Neither is a refusal, so this is a
          `role="status"` and it is drawn in the dim voice rather than the destructive one; a
          re-file that was actually *refused* is the banner above, like every other write.

          It clears itself after {@link REFILE_NOTE_MS} — see the effect that owns that — which
          is the other half of the difference: the banner speaks for the state of the deck until
          something replaces it, and this speaks for one press. Grown into place like its two
          neighbours, for their reason: the animated element is the wrapper and carries only
          `overflow-hidden`, because `statusLine` takes `height` to 0 and a box with its own
          padding can never be shorter than that padding. */}
      <AnimatePresence initial={false}>
        {refileNote && (
          <motion.div {...statusLine} className="shrink-0 overflow-hidden">
            <p
              role="status"
              className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-dim"
            >
              {refileNote}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The Compare dialog's bulk send, after the dialog has closed on it — see
          {@link compareSent}. **Two elements for one sentence**, and the split is the point: a
          live region that arrives with its words already inside announces nothing, so the
          region is always mounted (and `sr-only`, so it costs the column no height while it is
          empty) and the visible line is `aria-hidden` so it is not read a second time. Accent and
          a check when something was wished for, the dim voice when nothing was — the stats
          band's own pair for its inline press. */}
      <p role="status" className="sr-only">
        {compareSent ? wishesSentNote(compareSent) : ""}
      </p>
      <AnimatePresence initial={false}>
        {compareSent && (
          <motion.div {...statusLine} className="shrink-0 overflow-hidden" aria-hidden="true">
            <p
              className={cn(
                "flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs",
                compareSent.wishes > 0 ? "text-accent" : "text-dim",
              )}
            >
              {compareSent.wishes > 0 && <CircleCheck className="size-3.5 shrink-0" />}
              {wishesSentNote(compareSent)}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* A collection or wishlist add the reader made from a card's right-click, refused.
          Separate from the banner above because that one speaks for writes to **this deck** and
          this one is about the binder — and it has to be drawn *somewhere*, because the menu
          cannot draw it: `ctx.run` closes the panel before a row's handler runs, so by the time
          an answer arrives there is no menu left to put a sentence in. The deck add is not here
          and needs nothing from this file — it reaches the app's single `useCardToDeck` through
          `CardToDeckProvider`, and that one mount draws its own sentence.

          **The shared component rather than this file's fifth copy of it** (2026-08-16). Every
          other surface that mounts `useCardMenuDeps` already drew `CardMenuRefusal`; this one
          hand-drew the same markup down to the class string, and the only thing that differed
          was the `shrink-0` this column needs — which is what `className` is for. `shrink-0`
          stays at the call site rather than in the component: whether a banner may be squeezed
          is a fact about the box it is drawn in. */}
      <CardMenuRefusal error={menuFailure} className="shrink-0" />

      {loading && (
        <p role="status" className="py-16 text-center text-sm text-dim">
          Loading deck…
        </p>
      )}

      {readFailure && (
        <p role="alert" className="py-16 text-center text-sm text-destructive">
          Couldn't open this deck — {readFailure}
        </p>
      )}

      {gone && (
        <p className="mx-auto max-w-prose py-16 text-center text-sm text-dim">
          This deck no longer exists. It may have been deleted.
        </p>
      )}
    </>
  );

  /** The docked search panel's dock, the desk row's second child. */
  const dock = (
    <>
      {/* The panel's dock — `sticky` so the search stays put while a deck taller than the
          window scrolls past it, `self-start` so the row's own `stretch` does not draw it as
          tall as the deck, and `flex` so the panel inside fills whatever height the effect
          above measures for it. Every word of why: that effect.

          **`LAYER.popup` while the panel is drawn over the deck, and it has to be _here_.**
          `position: sticky` always creates a stacking context, so a z-index asked for inside
          this box competes only with its own siblings — which is the trap the card pane's
          note two hundred lines up records from the other side, and the reason the overlay
          itself carries no number. The deck it is covering draws at `LAYER.raised` (an open
          stack card) and `LAYER.header` (the table view's sticky header row), both of which
          would paint straight through an unraised overlay: this is the one element that can
          out-rank them. It is not applied at every width, because a rung nothing overlaps is
          a claim about an overlap that does not occur — see {@link panelOverWidth}. */}
      <div
        ref={dockRef}
        className={cn(
          "sticky flex shrink-0 self-start",
          panelOverWidth !== undefined && LAYER.popup,
        )}
        // Under the undocked bar while it is down (issue #577) — see {@link barClearance}. An
        // inline length rather than two classes, because it is a number this editor computes,
        // and `useDockHeight` is handed the same one so the height and the inset agree.
        style={{ top: barClearance }}
      >
        <DeckSearchPanel
          // `deck.addCard` unwrapped since 2026-08-25 — it was `panelAdd`, the same mutation
          // with the own/need answer folded into every `mutate` on the way past, and there is
          // no answer left to fold.
          add={deck.addCard}
          // `markAdded`, never `markLanded` bare: an add the backend filed as a token answers
          // {@link NO_DECK_CARD}, and there is no deck card to point at.
          onAdded={markAdded}
          categories={categories}
          deckId={deckId}
          targetCategoryId={targetCategoryId}
          // No Collection tab on a Virtual deck, so the column is the card search and the
          // strip that would offer to switch between two things is not drawn — see
          // {@link tracks} here and `DeckSearchPanelProps.tracksCollection` there.
          tracksCollection={tracks}
          defaultFormat={searchFormatDefault}
          open={panelOpen}
          setOpen={setPanelOpen}
          cardMenu={panelCardMenu}
          cardMenuKey={panelCardMenuKey}
          roomy={roomForPanel}
          overWidth={panelOverWidth}
          maxWidth={maxPanelWidth}
        />
      </div>
    </>
  );

  return (
    <section
      ref={editorRef}
      tabIndex={-1}
      aria-label={row ? `Deck editor: ${row.name}` : "Deck editor"}
      // Putting the card down — see {@link dropSelection}, which is where the "not on a card,
      // not on a control" test lives. On the whole editor rather than on the deck's own view,
      // because the desk is not the only place a reader clicks when they mean nothing: the
      // toolbar's empty half and the strip under the deck are the same gesture.
      onClick={dropSelection}
      // **The page, and since 2026-08-14 the *only* scroller in this editor** — see
      // {@link DECK_HEIGHT_FLOOR}. The deck, the price strip and the stats band together want
      // more height than a 1280×800 window has, and none of the three may be cut, so the column
      // scrolls: the header and the toolbar scroll away with it, which is what makes this the
      // page rather than a frame.
      //
      // What changed is the sentence that used to end that paragraph — "the deck's own view
      // keeps its scroller inside, and a wheel spent there is spent there first". It does not,
      // and it was the defect: a deck with more piles than the window was tall was letterboxed
      // in a box of the desk's height with this scrollbar beside it, and nothing on screen said
      // which of the two a wheel was about to move. The views grow instead — piles overflow
      // down and the box expands — so a deck of any size is one column of one page with one
      // scrollbar. The two things that had leaned on the old arrangement come with it: the
      // search panel is pinned rather than stretched (the dock effect) and the remove tray
      // sticks to the foot of the window for the length of a drag (the price strip).
      //
      // **All four views, since 2026-09-08.** The virtualised table was the one still given a
      // height, because a virtualiser is a scrollport by construction — it draws the rows in
      // view and holds a spacer open for the rest, so with no height it would draw its own
      // scrollbar and the page's, which is the letterbox above in miniature. `VirtualTable.grow`
      // is the opt-out and `TableView` takes it: every row of the deck is rendered, at the list
      // size this surface has (a few hundred rows against the 100k-row walls the virtualiser was
      // built for elsewhere). So there is nothing left in this editor that scrolls but the page.
      //
      // **`relative` is not decoration and it is the whole of a two-scrollbar bug** (2026-08-15).
      // `overflow` clips a descendant only when this box is between that descendant and its
      // *containing block* — and Tailwind's `.sr-only` is `position: absolute`, so every
      // screen-reader label in here whose nearest positioned ancestor was missing resolved to the
      // **initial** containing block instead. Laid out at its static position, deep inside the
      // scrolled column, and clipped by nothing: the label stretched the **document**, which is a
      // window scrollbar beside this one and an app that slides up off its own window when you use
      // it. Measured live at 1280×800 on a 24-card deck (`tauri dev`, debug):
      // `documentElement.scrollHeight` **1704** against a `clientHeight` of 800 — a 904px scroll
      // the window had no content for — with `window.innerWidth - documentElement.clientWidth`
      // reading **15**, while `body.scrollHeight` and the `h-screen` shell root both read 800 and
      // the shell's own `overflow-hidden` said nothing was overflowing. The deepest escapee was
      // `DeckStats`' curve label "0 cards at mana value 8 or more" at y **1703**, which is the
      // 1704 exactly. One `relative` here took it to **800 / 0**.
      //
      // **It belongs on the box that scrolls, and putting it one level up is not the same fix.**
      // With `relative` on `AppShell`'s `main` instead, the document came right (800) and
      // `main.scrollHeight` went **742 → 1646**: the label was contained by main but its static
      // position is still inside *this* column's scrolled content, so the phantom bar moved rather
      // than went. The rule that generalises is "a scroll container is the containing block for
      // its own absolutely positioned content", and the scroller here is this element.
      // No `FOCUS`: this section is a landing pad, not a control. `tabIndex={-1}` is there so
      // the caret has somewhere to go when a card leaves the pile under it, and neither Tab nor
      // an arrow can reach the editor root itself — so the outline ringed the entire builder,
      // piles and rail and all, on any keystroke. The piles and cards inside keep theirs.
      // `packages/ui/lib/focus.ts` has the rule.
      //
      // **`select-none` because this editor is a thing a reader handles, not text they read**
      // (issue #473). Every press on a card is a drag, and a press anywhere else — a pile heading,
      // a price line, the gap between two piles — used to start a text selection instead: across a
      // Stacks desk that is ~4 200 characters of headings and card frames painted blue, measured
      // in the shipped window. A second press inside it began a native drag of the selection, and
      // the reader lost the window. The drag is refused app-wide (`lib/nativeDrag.ts`); this takes
      // the selection away where the report found it. Fields are untouched — an `<input>` and a
      // `contenteditable` edit their own text whatever an ancestor says — and **the surfaces a
      // reader reads rather than handles opt back in at their own shell**: `Dialog`'s panel (every
      // overlay below is mounted *inside* this section and would inherit the refusal),
      // `ValidationPanel` and `DeckBracket` on the ledger line, and the notes band's body.
      //
      // **`min-h-full` rather than `h-full`, and it is the whole of why this page had no bottom
      // margin** (2026-09-22, the reader's own report: the bottom-most controls were "very hard
      // to use"). `AppShell`'s `<main>` is `p-5`, so every other page in this app gets 20px under
      // its last row. **This one got none.** With `h-full` this section is *exactly* the
      // scroller's height, its children are `shrink-0`, and on a deck taller than the window they
      // **overflow** it rather than extend it — and a scroll container's bottom padding is part
      // of the scrollable overflow of its own **in-flow** content only. An overflowing descendant
      // contributes its border box and nothing after it, so `main`'s 20px was real on Collection
      // and Wishlist and silently absent here. Measured in the shipped window (`tauri dev`,
      // debug) on a 100-card Commander deck at 1920×1080: at `scrollTop === scrollHeight -
      // clientHeight` the notes band's bottom edge sat at y **1079.59** in a 1080px window —
      // **0.4px of clearance**, its `New note` button flush against the frame.
      //
      // **A `pb-*` here does not fix it and was tried first.** Padding is inside this box's own
      // border box under `box-sizing: border-box`, and the box is pinned at 100%: `pb-8` applied
      // (`paddingBottom` read back `32px`) and moved `main.scrollHeight` **not at all** — 4305
      // before and after, gap still 0.41px. The height had to stop being definite. `min-h-full`
      // is what `DecksPage` has always used, and with it the section wraps its content (948 →
      // 4316.6 on the same deck), `main`'s own 20px lands the way it does everywhere else, and
      // `pb-3` on top brings the clearance to the **32px** asked for. Measured after: 4305 →
      // 4357, gap **32.4**.
      //
      // **Nothing below loses a definite height by it.** The views are `flex-1` under
      // {@link DECK_HEIGHT_FLOOR}'s `min-h-96`: on a deck shorter than the window this box is
      // still 100% tall, there is still free space, and `flex-1` still stretches into it; on one
      // taller there was never free space to distribute and the floor is what was holding the
      // view up already.
      className={cn("relative flex min-h-full flex-col gap-3 pb-3 select-none")}
    >
      {/* The four quick destinations, drawn across the top of this scroller for the length of a
          drag and at no other time. **The first child on purpose**: it is `sticky top-0`, so it
          has to be a child of the page scroller itself — a sticky box inside the ribbon row below
          would scroll away with that row — and it costs no layout in either state, which is what
          `h-0 -mb-3` is for. Every word of why, and why it owns a monitor of its own rather than
          reading the `dragging` state the remove tray is drawn from: `QuickZones`. (That state
          is {@link PriceStrip}'s since 2026-08-16, not this file's — the argument is the same
          one read at the other end of the gesture, so both ends of a drag now re-render
          themselves rather than the editor.) */}
      <QuickZones categories={categories} onDrop={applyDrops} onNewCategory={openQuickCategory} />

      <DeckDesk
        deckId={deckId}
        row={row}
        variant={variant}
        theoryEnabled={theoryEnabled}
        restoredView={restoredView}
        rememberView={rememberView}
        updateDeck={updateDeck}
        cards={deck.cards}
        labels={deck.labels}
        categories={categories}
        separateX={separateX}
        gcFilter={gcFilter}
        emptyGroupRules={emptyGroupRules}
        theoryPlan={theoryPlan}
        marketplace={marketplace}
        violations={violations}
        noted={noted}
        tracks={tracks}
        openCard={openCard}
        landed={landed}
        selectedSlot={selectedSlot}
        tokenPile={tokenPile}
        walkTokens={walkTokens}
        hiddenStacks={hiddenStacks}
        showStack={showStack}
        setQuantity={setQuantity}
        applyDrops={applyDrops}
        deckCardMenuFor={deckCardMenuFor}
        categoryMenuFor={categoryMenuFor}
        renameCategoryField={renameCategoryField}
        moveCategory={moveCategory}
        pickedRef={pickedRef}
        deskRef={deskRef}
        barClearance={barClearance}
        tightHeader={tightHeader}
        setToolbarLine={setToolbarLine}
        bar={bar}
        header={header}
        tools={tools}
        notices={notices}
        dock={dock}
      />

      {/* The strip under the deck: how old these prices are (spec §5, said once here rather
          than as a tooltip on every one of sixty cards), where a card cut from the Actual list
          goes (said once for the same reason — the three ways to cut one would otherwise carry
          three spellings of it, and a stepper held down would narrate it per press) and, while
          a card is in the air, the way out of the deck drawn over it.

          **A direct child of this column, and it has to be.** The tray inside it is `-top-3`
          over the empty `gap-3` above this line, so the gap it reaches back into is this
          column's — one box further in and the number would be measuring nothing. It owns its
          own drag monitor for `QuickZones`' reason, which is why no `dragging` state reaches
          this file any more: see {@link PriceStrip}. */}
      {/* **`tracksCollection` is the note rather than the strip**: the prices are true of every
          kind of deck, and where a cut card *goes* is only a sentence a deck with a collection
          group behind it can write — see {@link tracks}, which is also where the `row === null`
          reading is argued, this being the one child of the five drawn before `deck_get` lands. */}
      <PriceStrip
        marketplace={marketplace}
        variant={variant}
        tracksCollection={tracks}
        onRemove={applyDrops}
      />

      {row && (
        // What this deck puts on the table beside itself — the tokens and emblems its cards
        // make, resolved out of each card's `all_parts` on every open and never stored.
        //
        // **Under the price strip and _over_ the stats band since 2026-09-08, where it was under
        // both.** The pair that may not be split is the deck and the strip: the remove tray is
        // drawn on that strip for the length of a drag, at `-top-3` over this column's own
        // `gap-3`, so a band inserted between them would put a wall of tokens between a card in
        // the air and the one drop that takes it out. This band is below that pair either way —
        // what moved is which side of the four charts it takes. The reader's reason is that a
        // token wall is a *list of cards* the deck is about to want, and the cards belong beside
        // the cards; the old ordering was argued only as "the far side of a pair that may not be
        // split", which was true of both positions and therefore never chose between them.
        //
        // **A `section` and `shrink-0`** for the two reasons the band below spells out in full —
        // a second complementary landmark answered `getByRole("complementary")` and broke five of
        // `App.test.tsx`'s pane assertions, and `shrink-0` on the bands below the desk is the
        // whole of why this editor scrolls. Both live on the panel's own root, so this mount
        // cannot get either wrong.
        //
        // `tokensOpen` is the deck's own column (`decks.tokens_open`, schema v37) rather than
        // editor state, for `separateXGroup`'s reason one control over: whether a reader wants
        // the token wall in front of them is an answer about a *particular* deck, and a
        // `useState` here would ask it again every time they opened one.
        //
        // **No mode control since managed tokens** (spec §3.9): the band's header carried the
        // deck's `Managed | Hide` until then, and with every token at 0 until the reader counts it
        // there is nothing left for it to decide — `decks.token_mode` stays in the schema, and
        // nothing here reads it. The band draws every token; the views draw the counted ones.
        // `Add printing` opens the one picker below in `add` mode; a press on a tile opens it on
        // that entry, as the pile's does; its Remove printing is `deckTokens.remove`, the write
        // the pile's own button makes, and the band hands its own caret on after it
        // (`tokenCaret.ts`), since it is always drawn and the pile is not.
        <DeckTokensPanel
          tokens={deckTokens}
          open={row.tokensOpen}
          onToggle={(next) => deck.update.mutate({ tokensOpen: next })}
          onPick={pickTokenEntry}
          onAddPrinting={addTokenEntry}
        />
      )}

      {/* The one printing picker the band's tiles, the views' token pile and the band's `Add
          printing` all open — see {@link pickingToken}. A pick in `swap` mode replaces the entry
          that was pressed (rule 4: the token's other entries are untouched, and a pick onto a
          printing and finish the list already holds folds the two in Rust); a pick in `add` mode
          is rule 5, one copy of that printing and finish on the list on screen. Either way the
          picker shuts on the pick, before the write answers — the refusal is the band's to draw.

          **The caret is owed on both exits** (`tokenCaret.ts`). The panel it was on unmounts with
          the pick, so once the write has answered and the re-read draws the picked printing, the
          caret goes to that tile's picture on the surface the picker was opened from — the band
          or the pile — and back to the opener where the tile cannot be found or the write was
          refused. Escape and the ✕ hand it back to the opener before closing, `Dialog`'s own
          `onDismiss` contract; an outside click moves nothing, since the reader is elsewhere.

          **Mounted in this column, and the check that makes that legal is written down rather
          than assumed.** `Dialog`'s scrim is a bare `fixed inset-0` and corrects for nothing, so
          a dialog opened from inside a box that is transformed, filtered or
          `container-type: inline-size` stretches to *that box* instead of to the window. This
          editor's root is `relative flex h-full min-h-0 flex-col`, and `relative` is not a
          containing block for `fixed`. It lived inside the band until 2026-09-24 on the same
          reasoning; the rule to keep is that a container query may never be added above it. */}
      <TokenArtPicker
        mode={tokenPicker}
        zoom={tokenZoom}
        onPick={(to) => {
          const written =
            tokenPicker?.kind === "swap"
              ? swapToken(entryRef(tokenPicker.entry), to)
              : tokenPicker?.kind === "add"
                ? addTokenPrinting(to.cardId, to.finish)
                : undefined;
          setPickingToken(null);
          if (written === undefined) return;
          // The surface by its attribute, asked when the caret is placed — never the element the
          // opener sat in, which a view switch in the meantime could have replaced.
          const surface = tokenPickerOpener.current?.closest(`[${TOKEN_PILE_ATTR}]`)
            ? TOKEN_PILE_ATTR
            : TOKEN_BAND_ATTR;
          pickCaret(
            written,
            to,
            () => editorRef.current?.querySelector(`[${surface}]`) ?? null,
            tokenPickerHandBack,
          );
        }}
        onDismiss={dismissTokenPicker}
        onClose={closeTokenPicker}
      />

      {row && (
        // What the deck adds up to — the foot of the page, and the last band on it.
        //
        // **It was an aside on the desk row with a toggle in the toolbar, and both halves of
        // that cost more than they bought.** The block took 280px off a row that already had to
        // fit a deck and a search panel, so opening it at 1280 with a card pane docked pushed
        // the panel to its rail — and the toggle beside the label filters was a control whose
        // only job was to give that width back. Full width under the deck, the four charts and the
        // figure row lay themselves out across the page instead of stacking down a column, and
        // no reader has to trade their search for their curve.
        //
        // **A band, not a card**: a rule and the content under it, the same grammar as the
        // toolbar above, which is a rule and its controls. The surface, the border and the
        // rounded corners it used to carry said *a panel you opened* — which is precisely what
        // it has stopped being.
        //
        // **Below the price strip on purpose.** The strip is where the remove tray is drawn
        // during a drag, exactly `-top-3` over the gap under the deck; putting the band between
        // them would leave a reader dragging a card the height of four charts to reach the one
        // drop that takes it out.
        //
        // **And below the Tokens & Emblems band since 2026-09-08**, where it was above it. That
        // band is a wall of cards; this one is four charts. A reader scanning down the page
        // reads the deck, then what the deck puts on the table beside it, then what it all adds
        // up to — and the charts, which nothing is dragged into and nothing is pressed on, are
        // the honest last thing. Neither band may go above the strip, so the two are only ever
        // ordered against each other.
        //
        // **A `section`, not an `aside`** — the same call `DeckSearchPanel` makes and for the
        // same measured reason: the docked card detail pane was the app's one complementary
        // landmark, and a second one answered `getByRole("complementary")` too. Drawn as an
        // aside, this block broke five of `App.test.tsx`'s pane assertions without touching the
        // pane. The pane is a modal since 2026-09-03 and no longer claims that role, but the
        // call stands: a landmark is a promise about the page and this block is not a
        // complementary one.
        //
        // **The `<section>` and its chrome are `DeckStats`' own since 2026-09-10, where they
        // were this file's** — the band has a disclosure now, and a header that could be
        // collapsed while the rule and the padding around it stayed here would be one control
        // whose two halves live in two files. `DeckTokensPanel` above it made the same call for
        // the same reason, and the two bands draw one grammar between them.
        //
        // **`shrink-0`, and that is the whole of why this editor scrolls now** — see
        // {@link DECK_HEIGHT_FLOOR}. The band is drawn whole or not at all: a curve with its
        // last two buckets cut off and a legend with its last colour under the fold is a chart
        // that has stopped being one, which is the same line `DeckStats` takes about wrapping
        // rather than truncating. It rides on the component's own root now.
        <>
          {/* Every number over the same rows the view is drawn from — one query, so a curve and
              a legality panel can never disagree. Unfiltered on purpose: the toolbar's filter
              narrows what is *shown*, and a deck's mana curve is a fact about the deck rather
              than about what is on screen.

              `separateX` is the same value `buildGroups` was handed above, and handing it to both
              from one place is the point: a curve counting `{X}{B}{B}{B}` as 3 beside a column
              headed "Mana value X" would be two surfaces answering one question about one deck
              two ways. It is drawn here whichever grouping is up, unlike the chip that sets it —
              the deck's answer does not stop being true because the reader went back to looking
              at their categories. */}
          {/* **`onPull` is `null` on the plan, and that is the list rather than the feature.**
              A theory list is what the deck is being built *toward*, and since schema v25 a deck
              holds a card because a collection row sits in its group — so a plan holds no
              cardboard and there is nothing on that tab to pull copies into. The backend agrees
              at the same seam: `deck_pull_plan` takes no variant and reads the live list, exactly
              as `deck_missing_to_wishlist` does one command over. Absent rather than greyed, for
              the editor's own rule about a control that cannot act: a button that spends the
              whole Theory tab refusing teaches the reader to stop looking at the line it is in.

              **The line it is in now says something true there, and that is 2026-09-09's whole
              visible change** ([issue #435](https://github.com/Msgaihede/mtg-grimoire/issues/435)):
              a theory row counts every copy the reader owns that this deck could use, so the band
              reads `38 of 100 missing` on a plan whose 62 other cards are in the deck's box,
              where it read `100 of 100`. Counting moved and writing did not — which is why this
              absence and the one below it are argued about the *write* rather than about the
              number beside them.

              **{@link tracks} is a second term on both, and it is a different sentence rather
              than a stronger one.** `variant === "live"` is about which of a deck's two *lists*
              is on screen; `tracks` is about the *deck*, and a Virtual deck keeps one live list
              — so on that deck the first term is satisfied on the only tab there is and the
              second is what takes the press away. The rule above extends unchanged: absent
              rather than greyed, because a button that refuses for the whole life of a deck is
              worse than one that refuses for the length of a tab. The block those two presses
              sit in goes with them (`tracksCollection` below) — a shortfall line with no way to
              act on it is the same lesson written as a number. */}
          {/* **`onAddMissing` is `null` on the plan for `onPull`'s reason**, which is the list
              rather than the feature: `deck_missing_plan` takes no variant and walks the live
              list, because a plan holds no cardboard for a record to file copies into. Absent
              rather than greyed, like its neighbour. **Not because the plan is short of
              nothing** — it says what it is short of on that tab since 2026-09-09 (issue #435),
              and the sentence this one used to carry was written when it could not.

              **It is not disabled by either sibling write being in flight**, deliberately: the
              three presses in that row are three independent answers to one number, and a
              record that had to wait for a wishlist write to land would be a control greyed by
              something the reader did not press. And it has no `spent` state — the wishlist's
              exists because pressing twice wishes for the same copies again, where a second
              press here re-plans against a shortfall the first one closed and finds nothing to
              offer. */}
          {/* **`marketplace` came back with the Figures card** — the band quoted no money
              between 2026-08-24 and 2026-09-10, and quotes three sums now. The rows arrived
              priced at this marketplace, so what travels is the **currency** and never a second
              lookup of a price.

              **`theory` is derived from the query this editor already makes for the per-card
              marks**, and that is the whole of why the band takes an answer rather than asking
              one: a second read of the plan would be a second answer to *what does this deck
              need* that could come to disagree with the ticks on the cards. It is `null` on a
              deck with no plan and on the Theory tab itself — a plan compared against itself is
              a figure that can only ever read `100%`.

              **The open state is `decks.stats_open` and rides the ordinary `deck_update`**,
              exactly as the tokens band's does one component up. What it does *not* share is the
              default: that column is `DEFAULT 1`, because this band has been on screen for every
              deck since 2026-08-14 with no control that hides it, so a collapsed default would
              take a band away from every deck in the database rather than choose one.

              **The Mana curve's creature split is `decks.curve_creatures` and rides the same
              patch** (user schema v56), wired the way `open` is one prop up. Its default is the
              other one — `DEFAULT 0`, because the split is new and off is the chart every deck
              already drew. */}
          <DeckStats
            cards={deck.cards}
            send={deck.missingToWishlist}
            onPull={tracks && variant === "live" ? openPull : null}
            onAddMissing={tracks && variant === "live" ? openAddMissing : null}
            tracksCollection={tracks}
            marketplace={marketplace}
            theory={theoryDone}
            open={row.statsOpen}
            onToggle={(next) => deck.update.mutate({ statsOpen: next })}
            creatureSplit={row.curveCreatures}
            onCreatureSplitChange={(next) => deck.update.mutate({ curveCreatures: next })}
            separateXGroup={separateX}
          />
        </>
      )}

      {row && (
        // **The Description, Notes and To-do bands share one row: three columns when there is
        // room, two, or one above the other when there is not** (issues #685 and #912). Each
        // keeps its own header and disclosure, so the row is placement and nothing else — on a
        // wide monitor a reader reads what the deck is for beside what they wrote about it and
        // what is left to do, rather than under a wall of it. A deck with no description mounts
        // no Description band, so the row is the two bands it always was.
        //
        // **An intrinsic grid, never `@container` and never a viewport breakpoint.** Both bands
        // mount their dialogs inside their own `<section>`, and a container box is the containing
        // block for every `fixed` descendant, so `Dialog`'s scrim would stretch to this row rather
        // than to the window (`packages/ui/CLAUDE.md`'s `@container` rule). A viewport breakpoint answers
        // about the window, and this app has no viewport branch: every fold answers its own box.
        // So the template counts its own tracks — `auto-fit` over a `NOTES_TODOS_COLUMN` floor
        // fits two only when the row holds two of them and the gap, and `min(100%, …)` keeps the
        // single track from overflowing a row narrower than that floor. Each band's own card grid
        // then answers its own column, as it always has.
        //
        // `items-start`, so a shut band is not stretched to its open neighbour's height, and its
        // top rule stays on its own header. `shrink-0` here as well as on the two sections: this
        // row is now the flex item of the editor's column, and `shrink-0` on the bands below the
        // desk is the whole of why this editor scrolls.
        <div
          className="grid shrink-0 items-start gap-x-6 gap-y-3"
          style={{
            gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${NOTES_TODOS_COLUMN}), 1fr))`,
          }}
        >
          {/* The deck's own description (issue #912) — first in the row, and not drawn at all
              when it is blank, so it takes no column. Open on arrival; `DeckDescriptionPanel`'s
              header says why that is editor state rather than a `decks.*_open` column. */}
          {description !== null && <DeckDescriptionPanel description={description} />}

          {/* What the reader has written down about this deck — many notes, each managed and
              deleted on its own, each free to name any number of cards (issue #447, schema v43).

              **After `DeckStats`, and before only the To-do band** — beside it or above it since
              issue #685, and ahead of it in the page's order either way. Neither this band nor
              the two above it may go between the deck and `PriceStrip`: the remove tray is drawn
              on that strip for the length of a drag, at `-top-3` reaching up into this column's
              own `gap-3`, so anything inserted between them would leave a reader dragging a card
              past a wall of prose to reach the one drop that takes it out. Below the strip, the
              bands are only ever ordered against each other, and the reader's reason for this
              one coming after the other two is that a notebook is opened deliberately: the tokens
              wall is a list of cards the deck is about to want and the stats band is four charts
              read at a glance, where a note is read by somebody who came here to read it.

              **A `section` and `shrink-0`** for the two reasons the bands above spell out in full
              — a second complementary landmark answered `getByRole("complementary")` and broke
              five of `App.test.tsx`'s pane assertions, and `shrink-0` on the bands below the desk
              is the whole of why this editor scrolls. Both live on the panel's own root, so this
              mount cannot get either wrong.

              **The cards go down as a prop and the band mounts no second `useDeck`.** It did, for
              the attach picker's card names — `CategoriesDialog`'s arrangement, and free only
              while the deck query is *fresh*: this band is gated on `row`, so it mounts after the
              first read settles, and a second observer arriving on a stale query is a second
              `deck_get`. Which of the deck's two lists these are is this file's answer, which is
              also why `useDeckNotes` takes no variant — `deck_notes` has no such column, and a
              note written against the plan shows on the actual list too because both hold the
              same oracle ids.

              `notesOpen` is the deck's own column (`decks.notes_open`, schema v43) rather than
              editor state, for `tokensOpen`'s reason one band up: whether a reader wants their
              notes in front of them is an answer about a *particular* deck, and a `useState` here
              would ask it again every time they opened one. The column is `DEFAULT 0` and not `1`
              — v37's answer rather than v42's — because this band is new and no deck has ever
              shown one, so a shut default takes nothing from anybody. */}
          <DeckNotesPanel
            deckId={deckId}
            cards={deck.cards}
            open={row.notesOpen}
            onToggle={toggleNotes}
            // The card menu's two rows, honoured here — see `addNote` above. The band clears the
            // request as it takes it, which is what stops a standing instruction being re-run on
            // every render of a deck the reader is editing.
            request={noteRequest}
            onRequestHandled={clearNoteRequest}
          />

          {/* The deck's to-do lists — many titled lists to a deck, each edited in its own dialog
              (issues #672 and #688, `deck_todo_lists`). ⚠️ **Not a note**: it borrows the notes
              band's header and the notes' editor and nothing else.

              **After the notes band, and so last on the page** — beside it on a wide row, under
              it on a narrow one. It inherits every reason the three bands above it are where they
              are — below `PriceStrip` and never between it and the deck, whose remove tray reaches
              up into this column's `gap-3` for the length of a drag — and the reader's reason for
              this order is the spec's: what there is still to do about a deck follows what they
              wrote about it.

              **A `section` and `shrink-0`**, both on the panel's own root, for the notes band's
              two reasons: a second complementary landmark broke `App.test.tsx`'s pane assertions,
              and `shrink-0` on the bands below the desk is the whole of why this editor scrolls.

              `todosOpen` is the deck's own column (`decks.todos_open`), `notesOpen`'s twin one
              column along and `DEFAULT 0` for its reason — the band is new, so a shut default
              takes nothing from anybody. No `cards` and no request: the list names no card, and
              nothing else in the editor asks this band for anything. */}
          <DeckTodosPanel deckId={deckId} open={row.todosOpen} onToggle={toggleTodos} />
        </div>
      )}

      <DeckEditorLayers
        deckId={deckId}
        variant={variant}
        layer={layer}
        dismiss={dismiss}
        close={close}
        deck={deck}
        meta={meta}
        deckName={row?.name ?? ""}
        categories={categories}
        tracks={tracks}
        setCardLabelOnSlot={setCardLabelOnSlot}
        createLabelFor={createLabelFor}
        setCompareSent={setCompareSent}
        pullPlan={pullPlan}
        missingPlan={missingPlan}
        createQuickCategory={createQuickCategory}
      />
    </section>
  );
}
