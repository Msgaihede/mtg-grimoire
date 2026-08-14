import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { ChevronLeft, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  filterChipState,
  ToggleChip,
} from "@/components/FilterChips";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { buildCardMenu, type CardMenuTarget } from "@/features/card/cardMenu";
import { useCardMenuDeps } from "@/features/card/useCardMenuDeps";
import {
  ipc,
  ipcError,
  type CardSummary,
  type DeckCard,
  type DeckCategory,
  type DeckVariant,
} from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { statusLine } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { pricesAsOf } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { newestWrite, writeFailure } from "@/lib/writes";
import { DECK_CARD_VARIANT, focusDeckGroup, FOCUS, type DeckCardActions } from "./cardControl";
import { CategoriesDialog } from "./CategoriesDialog";
import { buildCategoryMenu } from "./categoryMenu";
import { DeleteCategory } from "./CategoriesDialog";
import { buildDeckCardMenu } from "./deckCardMenu";
import { DeckDialog } from "./DeckDialog";
import { DeckHistoryDialog } from "./DeckHistoryDialog";
import { AUTO_CATEGORY, DeckSearchPanel, MIN_PANEL_WIDTH_PX } from "./DeckSearchPanel";
import { DeckSettingsDialog } from "./DeckSettingsDialog";
import { DeckStats } from "./DeckStats";
import { dropWrite, readDragData, type DeckWrite, type DragPayload } from "./dnd";
import { ExportDialog } from "./export/ExportDialog";
import {
  asGroupBy,
  buildGroups,
  DEFAULT_GROUP_BY,
  GROUP_BY_OPTIONS,
  type GroupBy,
} from "./grouping";
import { ImportDeckDialog } from "./import/ImportDeckDialog";
import { RenameField } from "./metaRows";
import { QuickAdd } from "./QuickAdd";
import { asSortBy, DEFAULT_SORT_BY, SORT_OPTIONS, type SortBy } from "./sorting";
import { DEFAULT_TAG_COLOR } from "./tagColors";
import { TagsDialog } from "./TagsDialog";
import { TheoryDiffDialog } from "./TheoryDiffDialog";
import { useDeck } from "./useDeck";
import { useDeckMeta } from "./useDeckMeta";
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

/**
 * A header/toolbar control that is not a chip: a select, a field, a plain press.
 *
 * **36px, and the number is `FILTER_CONTROL`'s rather than one of this file's own.** It was 32
 * for the same stated reason it is 36 now — "so the two rows read as rows rather than as a pile
 * of differently sized boxes" — but the rows it was measured against have both grown a chip
 * since: `Built` sits in the header and `Split X` in the toolbar, and `ToggleChip` is
 * `FILTER_CONTROL`, which is 36. So a height meant to unify was drawing the plain presses four
 * pixels shorter than the chips beside them, in both rows, and shorter again than the `h-9` back
 * button at the head of the first one. Every other filter row in the app (search, collection,
 * wishlist) is already 36; this is the deck editor joining them rather than a size invented here.
 *
 * **`text-xs` stays, and that is a width decision with a measurement behind it.** `FILTER_CONTROL`
 * carries `text-sm`, but the six controls drawn with this string are the header's widest block —
 * measured at **692px** at max-content — and 14px glyphs put it near **760**, which is more than
 * the 1017px content box a 1280×800 window leaves once the sidebar, the shell padding and the
 * editor's own scrollbar are taken off. The row is `flex-wrap`, so it does not overflow; it wraps,
 * and a wrapped header costs 44px of deck height at the app's own default window size — the
 * regression {@link NAME_FLOOR} exists to keep out. Height is the axis that had room.
 *
 * The property list is written out because a colour utility and a transform one compile to the
 * same CSS longhand, so tailwind-merge would keep one and silently drop the other; the format
 * select is `disabled` when the specs have not answered and must not appear to depress.
 */
const CONTROL =
  "h-9 rounded-md border border-border bg-surface px-2.5 text-xs text-dim " +
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
 * The shortest the desk row may be squeezed to — `DECK_FLOOR`'s rule turned on its side, because
 * the stats band is the first thing this editor has ever stacked *below* the deck rather than
 * beside it.
 *
 * **384px, and it is a measurement rather than a taste**: a stack group holding one card is
 * exactly that tall in the shipped window — 6px of column padding, a 43px group heading, the
 * 319px card, `stackHeight`'s 8px tail and 6px more padding. One whole card is the floor because
 * a deck view that cannot draw one has stopped being a deck view. Measured at 1280×800 with a
 * content-height band and no floor at all, the row came out at **246px**: the commander was cut
 * through the middle of its art, every column grew a scrollbar, and the docked panel's results
 * spilled out from under it.
 *
 * **So the editor scrolls, and that is the trade this whole arrangement is.** Three things want
 * the column's height — the deck, the price strip and the band — and at 1280×800 they come to
 * **886px** in a **702px** editor (710 when the editor was first measured, less the 8px the
 * ribbon gained on 2026-08-14). The pair was re-measured later that day, in the shipped window
 * on a 14-card Commander deck: **886** with the ribbon's `py-1.5` and 36px chrome, **866** with
 * both backed out in the page, so the two together cost **20px** — 12 of padding and 4 on each
 * of the two rows, the header's second line included, because at 1280 that line *is* the
 * controls. **The deck's own share did not move**: both numbers are far past 702, so the floor
 * below governs the deck and the 20px comes off the tail of the stats band, which was already
 * one scroll down. (847 is the figure that stood here before that pass, taken on an earlier
 * sitting and not on this deck — the pair above is the like-for-like one.) Rather than cut one
 * of them, the section is
 * `overflow-y-auto`: the deck holds 384, the band draws whole, and the last ~145px of it is one
 * scroll away. At 1920×1080 nothing scrolls and the deck takes the surplus (**519px**). A band
 * that shrank instead was measured at **92px** with 229px of charts inside it, which is a
 * scrollbar over a chart nobody can read — the thing `DeckStats` refuses when it wraps rather
 * than truncates.
 *
 * Written out whole rather than built from the number — Tailwind scans source text for class
 * names, and one assembled at runtime emits no rule at all.
 */
const DECK_HEIGHT_FLOOR = "min-h-96";

/** Stable identity for "no tag filter", so the memo below does not re-run on every render. */
const NO_TAGS: readonly number[] = [];

/** The same trick for the closed export dialog, which is mounted at every render and asked for
 *  a card list whether or not it is drawing one. */
const NO_EXPORT_CARDS: readonly DeckCard[] = [];

/**
 * What the export dialog is titled when the pile it was opened on has gone.
 *
 * Reachable: another surface — the Categories dialog, a second window on the same database —
 * can delete a category while this dialog is open over it, and the editor re-reads the deck
 * without it. The empty card list that follows is honest; `Export ""` as the dialog's accessible
 * name is not, which is the whole reason this string exists rather than a fallback of `""`.
 * **Not the deck's name**: that would claim a deck-level export nobody asked for.
 */
const DELETED_CATEGORY = "a deleted category";

/**
 * What the save dialog's file name starts as: the deck and the pile.
 *
 * The characters Windows forbids in a file name are taken out rather than replaced — a deck
 * called `Atraxa: Superfriends` should suggest `Atraxa Superfriends - Removal`, not a name with
 * an underscore where nobody typed one. The extension is `ExportDialog`'s, which appends the one
 * belonging to the format chosen there.
 *
 * **An empty half contributes nothing, separator included** — and it is cleaned *before* it is
 * judged empty, which is the order that matters. Joining unconditionally answered `"Atraxa -"`
 * for a pile with no name (the state {@link DELETED_CATEGORY} covers on the title side), and
 * filtering before stripping would answer `"-"` for a deck whose whole name is punctuation this
 * has to remove.
 *
 * Exported for its test: it is reached only through a dialog this editor has no control to open
 * (the opener is a category heading's right-click, which `views/` wires), so there is no rendered
 * path to assert it through yet.
 */
export function exportFileName(deck: string, category: string): string {
  const name = [deck, category]
    .map((part) => part.replace(/[\\/:*?"<>|]/g, "").trim())
    .filter((part) => part !== "")
    .join(" - ");
  // A deck with no name, and this dialog rendered closed, both reach here. `save()` is handed a
  // `defaultPath`, and an empty one is a picker with no name in its box.
  return name === "" ? "decklist" : name;
}

/**
 * The three arguments `ExportDialog` takes, for the pile the `export` layer names.
 *
 * **Derived from the deck's live list rather than from what a menu row was holding**, which is
 * why the layer carries an id and not the cards: a deck is re-read after every write, so a
 * snapshot taken when the menu opened would describe the pile as it was. A rename under the open
 * dialog therefore retitles it, and a delete empties it and says so.
 *
 * `cards` is the deck's rows and **not** `shown`: the toolbar's filter narrows what is *drawn*,
 * and exporting "Removal" means the pile rather than the four of it a search box happens to be
 * showing.
 *
 * `categoryId` is `null` for a closed dialog, which is every render but the ones it is up — the
 * subject is `""` there because nothing draws it, and that is the one case that must **not** read
 * {@link DELETED_CATEGORY}: a closed dialog is not a statement about a deleted pile.
 *
 * Pure, and exported for that reason: see {@link exportFileName}.
 */
export function categoryExport(
  categoryId: number | null,
  categories: readonly DeckCategory[],
  cards: readonly DeckCard[],
  deckName: string,
): { subject: string; cards: readonly DeckCard[]; fileName: string } {
  if (categoryId === null) {
    return { subject: "", cards: NO_EXPORT_CARDS, fileName: exportFileName(deckName, "") };
  }
  const name = categories.find((c) => c.id === categoryId)?.name ?? null;
  return {
    subject: name ?? DELETED_CATEGORY,
    cards: cards.filter((c) => c.categoryId === categoryId),
    // The **name**, never the subject: a file called `Burn - a deleted category` is a sentence
    // where a name belongs, and the deck's own name is the honest suggestion for a pile that is
    // not there any more.
    fileName: exportFileName(deckName, name ?? ""),
  };
}

/**
 * A tile in the docked search panel, as a card menu describes it.
 *
 * **No `finish`**, for the search wall's reason: a result is a *printing* and not a copy, so
 * "Add to → Collection" offers the finishes this printing exists in rather than choosing one.
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
 * **At most one of these is ever meant to be open, and a union is what makes that structural
 * rather than remembered.** Eight booleans can express "Categories and History both up", which is
 * a state nothing here draws and nothing here could draw well: two scrims, two `aria-modal`
 * panels and two focus traps, with two hand-backs racing for the caret as either closes. One slot
 * cannot say it, and the failure it forecloses is the invisible kind — every test that opens one
 * layer at a time passes either way. Every member below registers the same `"inner"` Escape rung
 * from inside its own component, so at most one of the eight registrations is ever enabled.
 * `DecksPage`'s `Panel` is the same arrangement, for the same reason.
 *
 * **The Escape protocol is no longer that argument, and the change landed under this file.** This
 * paragraph used to read "`useDismissOnEscape` orders exactly two rungs, so two `"inner"` peers
 * open at once are not ordered at all and would both close on a single press", which is wrong
 * now and was wrong then. It is wrong now because that hook keeps a **stack** of capture-phase
 * registrations and only the token on top acts, so two `"inner"` peers *are* ordered — by mount
 * depth, which is what lets a context menu open over a dialog opened over the card pane and give
 * one press to each. It was wrong then because the capture rung checks `defaultPrevented` too, so
 * the old hook did not close both: the *first-registered* peer consumed the press and the newer
 * one — the thing on top — was **starved**, measured `{ first: 1, second: 0 }` on 2026-08-14. The
 * reassuring version was the false one; the hook's own doc carries the whole of it. What survives
 * is the paragraph above, which never depended on any of this.
 *
 * `check` is the format check anchored to its chip; the other seven are **full-window overlays**
 * on `LAYER.overlay` — one rung and not seven because of that same "at most one is up": they
 * never need ordering against each other (see `layers.ts`). Categories and tags used to be one of
 * them: a single right-hand drawer with two sections in it. Splitting it into two dialogs adds a
 * member here and takes nothing away from the argument — one slot is one slot however many things
 * can occupy it, which is also why the export dialog joined without an argument being reopened.
 *
 * **Two members carry a field, and both are the same idea**: which pile the layer is about. A
 * union arm is where such a thing belongs — a second `useState` beside this one could hold a
 * category id while the layer was closed, or while a *different* layer was open, and neither
 * state means anything.
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
 * anchored layer out here; the seven overlays make it unreachable, because a pointer cannot get
 * to the pane through a scrim.
 *
 * **All seven overlays are modal, and that is what makes the sentence above true of a keyboard
 * too**: each paints a full-window scrim, claims `aria-modal="true"` and runs `lib/trapTab.ts`,
 * so nothing behind one can be reached by Tab any more than by a pointer. Two of them used to
 * argue the opposite in their own docs while drawn as right-hand drawers; the scrim had always
 * contradicted it. `DeckEditor.test.tsx`'s "keeps Tab inside itself" sweep holds the **six with
 * a control in this view** together — the export dialog is opened from a category heading's
 * right-click and has no button to point that sweep at — and it is a **behavioural** sweep for a
 * reason worth reading before the next modality edit.
 *
 * **Five of the seven are a `DeckDialog`** — Categories, Tags, History, Deck settings and the
 * export — where the scrim, the centring, `aria-modal`, the trap, the ✕ and the `"inner"` rung
 * are written once. **`TheoryDiffDialog` and `ImportDeckDialog` are not**: each still carries
 * its own copy of that chrome (`TheoryDiffDialog.tsx`, `import/ImportDeckDialog.tsx`), out of
 * scope when the shell was written rather than exempt from it, and they are the next two to
 * move onto it. `CreateDeckDialog` is a third such copy outside this editor. So a change to how
 * a modal behaves here — a focus restore, a different `trapTab`, a change to when the rung is
 * enabled — is an edit to **four files, not one**, until those three are converted.
 */
type Layer =
  | { kind: "check" }
  | { kind: "categories" }
  | { kind: "tags" }
  | { kind: "history" }
  | { kind: "theoryDiff" }
  | { kind: "settings" }
  /** The pile every line lands in, for an import opened from a category's right-click — absent
   *  from the toolbar's own press, which files each card by what it does. */
  | { kind: "import"; forcedCategoryName?: string }
  /**
   * Which pile is being exported. **The id and not the cards**: the deck is re-read after every
   * write and this editor already holds the answer, so the dialog is fed from the live list
   * rather than from an array frozen at the moment a menu row was pressed.
   */
  | { kind: "export"; categoryId: number }
  /**
   * The pile a `Delete…` was pressed on. The **id**, like `export` and for the same reason: the
   * deck is re-read after every write, so the question is asked about the live row rather than
   * about a category frozen when a menu row was pressed.
   *
   * It exists because the confirmation is not optional — `deck_category_delete` takes the cards
   * with the pile unless the reader says where they go — and `CategoryMenuDeps` carries no delete
   * mutation at all, so the menu structurally cannot reach the write without passing through here.
   */
  | { kind: "deleteCategory"; categoryId: number }
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
 * them, and which of eight layers is open. It draws no card and no group heading itself —
 * `grouping.ts` says what the groups are and `views/` draw them, so four surfaces cannot answer
 * "how many cards are in the Ramp column" four ways.
 *
 * **Three of those decisions outlive the editor**: the variant, the grouping and the sort are
 * columns on the deck row, restored on the way in and written on every press
 * (`deck.rememberView`). The view, the filter, the tag chips and the stats block are not — they
 * are how the reader is looking *now*, and a deck that reopened filtered would be a deck missing
 * cards until somebody noticed the field.
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
  const { specs, formatSpecFor } = useFormatSpecs();
  /**
   * The right-click, and everything a card menu needs that is not the card.
   *
   * **One `CardMenuDeps` for this whole screen**, from the hook the other five surfaces use:
   * the collection add's four invalidation keys and the wishlist add's two are written down once
   * there, and a sixth page spelling them out again would be a sixth place for one rule to
   * drift. What this editor answers differently is `viewPrintingsInPane`, which is a *per
   * surface* answer — the deck's cards open as deck rows, the docked panel's tiles do not — so
   * it is spread over at each of the two builders below rather than fixed here.
   *
   * `menu(build)` takes a **thunk**: a deck of a hundred cards builds no menu at all until a
   * reader right-clicks one of them.
   */
  const { menu, menuKey } = useContextMenu();
  const { deps: cardMenuDeps, error: menuFailure } = useCardMenuDeps();
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
  // The two the deck row remembers, seeded from the same constants a stored word this build
  // cannot draw falls back to — so "never chosen" and "chosen and since dropped" are one state
  // rather than two. The restore below overwrites both the moment the row lands.
  const [groupBy, setGroupBy] = useState<GroupBy>(DEFAULT_GROUP_BY);
  const [sortBy, setSortBy] = useState<SortBy>(DEFAULT_SORT_BY);
  const [filter, setFilter] = useState("");
  const [tagIds, setTagIds] = useState<readonly number[]>(NO_TAGS);
  const [layer, setLayer] = useState<Layer>(null);
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

  /**
   * The remembered triple this editor has already put on screen, so the restore below honours a
   * *value* rather than a deck — see it for why that is the difference that matters.
   *
   * State rather than a ref, and not a stylistic choice: this is React's own "adjusting state
   * when a prop changes" pattern, where the previous value is held in state precisely so the
   * comparison and the update are both part of the render the new value arrived in. A ref read
   * during render is the thing `react-hooks/refs` forbids, and for the reason that would bite
   * here — a ref written in a render React then discards would leave the editor believing it
   * had honoured a triple it never drew.
   */
  const [honouredView, setHonouredView] = useState<string | null>(null);

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
  /** The row the deck and the panel share, and the only width either of them can be judged
   *  against — the window's own is three layouts away from it. */
  const deskRef = useRef<HTMLDivElement>(null);
  /** The box the current view draws into — the one scroller a drag may have to move inside to
   *  reach its target, and the height the two column-packing views are told to pack to. */
  const viewRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const [desk, setDesk] = useState({ width: 0, height: 0 });
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
  /** Whatever opened the layer that is up, so Escape can hand the caret back to it. */
  const openerRef = useRef<HTMLButtonElement | null>(null);
  /** The format check's chip, which owns its own trigger ref because `ValidationPanel` draws
   *  the chip itself. */
  const chipRef = useRef<HTMLButtonElement>(null);
  const tookFocus = useRef(false);

  /**
   * The deck's piles and labels **as things in themselves** — what the category menu writes
   * through, and where the menu's "New tag…" now makes its label.
   *
   * **Four local-SQLite reads on every deck opened, and they are paid deliberately.** The
   * categories (a *priced* per-category aggregate), the tags of the list on screen, the tags of
   * the **other** list, and the global suggestion palette — counted off `useDeckMeta.ts`'s four
   * `useQuery` calls, every one of them `enabled` on nothing but the deck id. Two things make
   * that the right trade *here* and made it the wrong one inside a lazy menu body, which is
   * where this hook was refused a round earlier: a reader **opening a deck** already pays a
   * `deck_get` of the whole deck, its cards, its categories and its tags, so four more local
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
   * The menu's "New tag…" — a label made and put on the card, as one act.
   *
   * **`useDeckMeta.createTag`, the single definition**, now that the hook is mounted above for
   * the category menu. It replaced a hand-rolled `useMutation` over `ipc.deckTagCreate` whose
   * whole justification was avoiding this mount; that justification stopped being true, so it
   * was deleted rather than corrected.
   *
   * **The chain's second half is still the editor's, which is the part that must not regress.**
   * A `useMutation`'s callbacks belong to its *observer*, and TanStack drops them when the
   * observer unmounts — so a create started from inside the menu and chained there loses its
   * attach to any dismissal landing during the round trip, leaving the label made and silently
   * never worn. This observer is **this component's**, and the editor is still on screen when
   * the answer arrives, so the per-call `onSuccess` below really runs. `DeckEditor.test.tsx`'s
   * "attaches a label whose create was still in flight when the menu was dismissed" is the proof
   * and holds Escape between the press and the answer.
   *
   * The colour is `DEFAULT_TAG_COLOR` and the menu does not ask: recolouring a label is what the
   * Tags dialog is for.
   */
  const startTagCreate = meta.createTag.mutate;
  const setTagOnSlot = deck.setTag.mutate;
  // The category menu's two direct writes, taken as `mutate` for the reason every other write
  // here is: TanStack hands back a fresh result object each render, and these end up in
  // `useCallback` dependency lists that the four views' group elements are built from.
  const setCategoryActive = meta.setCategoryActive.mutate;
  const renameCategory = meta.renameCategory.mutate;
  const renamePending = meta.renameCategory.isPending;
  const createTagFor = useCallback(
    (card: DeckCard, name: string) =>
      startTagCreate(
        { name, color: DEFAULT_TAG_COLOR.token },
        {
          onSuccess: (tag) =>
            setTagOnSlot({ cardId: card.cardId, categoryId: card.categoryId, tagId: tag.id }),
        },
      ),
    [startTagCreate, setTagOnSlot],
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
  // **The two right-click menus of 2026-08-14 are what the tail of this list is.** `setTag` sat
  // outside the family for as long as nothing in the app could reach it, and the four
  // `useDeckMeta` writes below it had no control in this view at all — they were the Categories
  // dialog's, which draws its own sentence for its own observer. A write a reader can now make
  // from a card's menu or a pile's heading is a write whose refusal has to be said somewhere,
  // and the menu that started it has closed by the time an answer arrives.
  //
  // **`useDeckMeta`'s four are a *different observer* from the dialog's** — TanStack shares a
  // query's cache between observers and a mutation's state with nobody — so this banner speaks
  // only for presses made out here, and the dialog goes on speaking for its own.
  const writes = [
    deck.setQuantity,
    deck.moveCard,
    deck.update,
    deck.setTag,
    meta.createTag,
    meta.renameCategory,
    meta.setCategoryActive,
    meta.deleteCategory,
  ] as const;
  const bannerFailure = writeFailure(writes);

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
   * untouched by it and is still every category of the deck. It is what the toolbar's "Add to"
   * select and `CategoriesDialog` are built from, so every pile
   * stays reachable by name whether or not a heading is drawn for it — and a pile that *holds*
   * a card draws whatever the format says, because `drawsWhenEmpty` is never asked about a
   * group with cards in it. Nothing holding cardboard is hidden, and nothing at all is hidden
   * from the surfaces a reader files a card with. The format also still judges the deck, which
   * is the check chip in the header and a different question again.
   */
  const categories = deck.categories;

  /** Copies in the list on screen — **copies, not rows**, because that is what a reader counts
   *  and what an import's `replace` would clear. Every category, the inactive ones included:
   *  a `replace` clears the variant, and a pile being switched off does not save it. */
  const cardsInVariant = useMemo(
    () => deck.cards.reduce((copies, card) => copies + card.quantity, 0),
    [deck.cards],
  );

  /** What the export dialog draws, for the pile the layer names — {@link categoryExport}, which
   *  is pure and carries the whole of the reasoning. */
  /** The pile the delete confirmation is about, read from the **live** list — a rename made
   *  under the open question retitles it, and a delete from another surface empties it. */
  const deletedCategory =
    layer?.kind === "deleteCategory"
      ? (categories.find((c) => c.id === layer.categoryId) ?? null)
      : null;

  const exportedId = layer?.kind === "export" ? layer.categoryId : null;
  const exported = useMemo(
    () => categoryExport(exportedId, categories, deck.cards, row?.name ?? ""),
    [exportedId, categories, deck.cards, row?.name],
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

  // Put the reader back where they left this deck: the tab, the grouping and the sort the row
  // remembers. Another reset during render — React's own answer to state that has to follow a
  // prop, and the pattern this file already uses twice (the `targetCategoryId` clamp above and
  // the `variant` clamp below).
  //
  // **Honoured once per *triple*, not once per deck**, which is the whole of what makes it
  // co-operate with the reader rather than fight them: `honouredView` holds the triple that was
  // applied, so a row answering the same one again changes nothing, while a row answering a
  // *new* one — the deck being opened, or `theoryEnabled` being switched on, which leaves
  // `lastVariant` at `"theory"` because the cards moved there — moves the controls.
  //
  // **It cannot loop, and the reason is that `rememberView` does not invalidate.** A press
  // writes the columns without re-reading the deck, so the triple on this row changes only when
  // the deck is genuinely read again — opening it, or any card write's `["decks"]`
  // invalidation — and by then it is the reader's own stored choice, which the three `!==`
  // guards make a no-op. Restoring writes nothing back, deliberately: this is a read of what is
  // already stored.
  const remembered =
    row === null ? null : `${deckId}:${row.lastVariant}:${row.lastGroupBy}:${row.lastSortBy}`;
  if (row !== null && honouredView !== remembered) {
    setHonouredView(remembered);
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
    if (storedGroupBy !== groupBy) setGroupBy(storedGroupBy);
    if (storedSortBy !== sortBy) setSortBy(storedSortBy);
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
   * The three toolbar controls the deck remembers, each writing **only the field that moved**.
   *
   * The state is what the editor draws and the write is what makes it survive the deck being
   * closed — in that order, and nothing waits on the answer: `rememberView` does not invalidate
   * and fails silently, so a press lands exactly as fast as it did before anything was stored.
   * Sending one field rather than three is `DeckViewState`'s absent-means-leave-it rule used
   * for what it is for — pressing Sort cannot write back a grouping read out of a stale render.
   */
  const pickVariant = (next: DeckVariant) => {
    setVariant(next);
    deck.rememberView.mutate({ variant: next });
  };
  const pickGroupBy = (next: GroupBy) => {
    setGroupBy(next);
    deck.rememberView.mutate({ groupBy: next });
  };
  const pickSortBy = (next: SortBy) => {
    setSortBy(next);
    deck.rememberView.mutate({ sortBy: next });
  };

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
  //
  // The window's own width is read in the same callback rather than through a second listener:
  // this row is `flex-1` inside the page, so nothing can change the window's width without
  // changing the desk's, and one observer answering both keeps the two numbers from being a
  // frame apart.
  useEffect(() => {
    const el = deskRef.current;
    if (!el) return;
    const measure = () => setViewport(document.documentElement.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      setDesk({ width: entry.contentRect.width, height: entry.contentRect.height });
      measure();
    });
    observer.observe(el);
    setDesk({ width: el.clientWidth, height: el.clientHeight });
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
    desk.width > 0 ? desk.width - DESK_GAP - DECK_FLOOR : Number.POSITIVE_INFINITY,
  );

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
  const roomForPanel = desk.width === 0 || maxPanelWidth >= MIN_PANEL_WIDTH_PX;

  // A refused write re-reads the deck, and the read is what decides what happened: every write
  // goes through `touch_deck`, which answers "That deck is not there any more" when the deck
  // has been deleted under the reader — so the same refusal is either a busy database (the
  // banner says so, the deck stays) or a deck that is gone (the read answers null and the
  // editor says so). Keyed on `submittedAt` so each new failure re-reads exactly once.
  //
  // **Every write above plus three, banner or no banner.** `add_card` calls `touch_deck` like the rest and
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
  // **`setTag` rides in through `writes`** and is live coverage for the same reason: nothing in
  // the app could reach it until that menu, and every one of the four views can now.
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

  /**
   * Open one of the eight, from the control that was pressed — and never a second one, because
   * there is one slot. A menu row has no control to hand back to and passes `null`.
   *
   * **A press on the layer that is already up closes it**, which is what a toolbar toggle should
   * do and is why the kind is compared. **Read this before wiring the category heading's menu
   * (Task 13):** `export` and `import` are the first arms carrying a *payload*, so "the same kind
   * again" is no longer necessarily "the same thing again" — re-opening the export on a
   * **different** pile would close the dialog rather than re-aim it. It cannot happen today,
   * because both payload arms are modal and the heading behind the scrim cannot be right-clicked;
   * it becomes reachable the moment anything can ask for one of these without going through a
   * scrim. Left as it is deliberately rather than fixed blind — the right answer (close only when
   * the payload matches too) is one line, and it wants a caller that can reach it.
   */
  const openLayer = useCallback((next: NonNullable<Layer>, trigger: HTMLButtonElement | null) => {
    openerRef.current = trigger;
    setLayer((open) => (open?.kind === next.kind ? null : next));
  }, []);
  const openCheck = useCallback(() => openLayer({ kind: "check" }, chipRef.current), [openLayer]);

  // The three category writes, each addressed by the slot rather than by a `DeckCard` — because
  // that is all a *drop* carries, and a drag and a control press must not be two ways of
  // writing the same thing. The card's stepper hands its own card to the first of the three;
  // the other two are a drop's alone now that the `Move…` select is gone, and the addressing is
  // still the drop's rather than the control's for the day one of them grows a control again.
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
  const writeTag = deck.setTag.mutate;

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
   * Measured, not guessed: it was `DeckEditor.stories.tsx`'s `MoveBetweenPiles` that failed
   * without the second pass and passed with it. **That story went with the `Move…` select on
   * 2026-08-14 and nothing replaced it**, because the only remaining route into this that
   * changes a pile's *size* is a drop, and Storybook cannot drive a drag (the page's own note
   * says why). What is still driven is the stepper's zero — `ZeroRemovesTheCard` asserts the
   * caret lands on the pile — which exercises the same two passes on the pile a card *left*.
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
          // The dropped card has left the pile it was in, so the caret goes to where it landed
          // — which announces the category it is now in. The same hand-off the stepper's zero
          // makes: it is the card that unmounts either way, and focus follows it.
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

  /** The two deck writes the menu adds, each addressed by the **row** — a menu is opened on one
   *  card, which is more than a drop carries and is why these are not `applyDrop`'s pair. */
  const moveCardTo = useCallback(
    (card: DeckCard, categoryId: number) => moveTo(card.cardId, card.categoryId, categoryId),
    [moveTo],
  );
  const setCardTag = useCallback(
    (card: DeckCard, tagId: number | null) =>
      writeTag({ cardId: card.cardId, categoryId: card.categoryId, tagId }),
    [writeTag],
  );

  /**
   * One deck card's right-click, **built here and handed to the four views as one function**.
   *
   * A view that assembled its own would be four copies of one rule, and the rule reads three
   * facts no view has: every category the deck holds (`categories`, in the reader's own order
   * and deliberately not the drawn groups), the deck's format spec, and the deck's tags.
   *
   * The item list is a thunk inside `menu`, so a hundred-card deck pays for nothing until a
   * reader right-clicks a card. The `viewPrintingsInPane` override is per **card** rather than
   * per surface, and that is free for the same reason — this whole object is built on the press:
   * inside the editor "View all printings" opens the pane, and it opens it *as a deck row*, so
   * the pane's printings list can offer "Use this printing" on the slot that was right-clicked.
   *
   * **Both doors, from one thunk.** `menuKey` is Shift+F10 and the ContextMenu key, and it is
   * not an extra here: the per-card `Move…` select was removed on 2026-08-14 and took the only
   * keyboard path to moving a card with it (a caret cannot drag). This menu is that path, so a
   * menu only a mouse could open would restore nothing.
   */
  const deckCardMenu = useCallback(
    (card: DeckCard) => {
      const build = () =>
        buildDeckCardMenu(card, {
          card: { ...cardMenuDeps, viewPrintingsInPane: () => openCard(card) },
          categories,
          cards: deck.cards,
          spec,
          moveTo: moveCardTo,
          setTag: setCardTag,
          tags: deck.tags,
          createTag: createTagFor,
        });
      return { onContextMenu: menu(build), onKeyDown: menuKey(build) };
    },
    [
      menu,
      menuKey,
      cardMenuDeps,
      openCard,
      categories,
      deck.cards,
      deck.tags,
      spec,
      moveCardTo,
      setCardTag,
      createTagFor,
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
   */
  const categoryMenu = useCallback(
    (categoryId: number) => {
      const category = categories.find((c) => c.id === categoryId);
      if (category === undefined) return undefined;
      const build = () =>
        buildCategoryMenu(category, {
          // The deck's own rows, never `shown`: exporting "Removal" means the pile rather than
          // the four of it the toolbar's filter happens to be showing.
          cards: deck.cards,
          startRename: (pile) => setRenamingCategoryId(pile.id),
          openImport: ({ forcedCategoryName }) =>
            openLayer({ kind: "import", forcedCategoryName }, null),
          openExport: ({ categoryId: id }) => openLayer({ kind: "export", categoryId: id }, null),
          setActive: (pile, isActive) => setCategoryActive({ id: pile.id, isActive }),
          askDelete: (pile) => openLayer({ kind: "deleteCategory", categoryId: pile.id }, null),
        });
      return { onContextMenu: menu(build), onKeyDown: menuKey(build) };
    },
    [menu, menuKey, categories, deck.cards, openLayer, setCategoryActive],
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

  const actions = useMemo<DeckCardActions>(
    () => ({
      setQuantity,
      drop: applyDrop,
      menu: deckCardMenu,
      categoryMenu,
      renameCategory: (categoryId) =>
        categoryId === null ? null : renameCategoryField(categoryId),
    }),
    [setQuantity, applyDrop, deckCardMenu, categoryMenu, renameCategoryField],
  );

  /**
   * The docked panel's tiles, which are **not** deck cards: a search result is a printing the
   * reader has not filed anywhere, so none of the four deck rows means anything about it and it
   * gets the plain card menu every other wall in the app draws.
   *
   * Built here rather than in the panel so that one `useCardMenuDeps` serves both surfaces of
   * this screen — two would be two collection-add observers and two sentences to draw for one
   * refusal. `viewPrintingsInPane` is `setSelectedCardId` here and not `openCard`: the tile is
   * not a row of this deck, and the store clears `paneDeckContext` in that same write precisely
   * so it cannot be shown as one.
   */
  const panelCardBuild = useCallback(
    (card: CardSummary) => () =>
      buildCardMenu(searchCardTarget(card), {
        ...cardMenuDeps,
        viewPrintingsInPane: setSelectedCardId,
      }),
    [cardMenuDeps, setSelectedCardId],
  );
  const panelCardMenu = useCallback(
    (card: CardSummary) => menu(panelCardBuild(card)),
    [menu, panelCardBuild],
  );
  /** The keyboard's own door to the same rows. `CardGrid` takes it in a slot of its own because
   *  a keypress has no coordinates — the panel is anchored at the tile's corner rather than at a
   *  pointer that was never there. */
  const panelCardMenuKey = useCallback(
    (card: CardSummary) => menuKey(panelCardBuild(card)),
    [menuKey, panelCardBuild],
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

  // A pile can be off the bottom of the view while a card is in the air over it — the stack's
  // columns wrap down the page rather than running off its right-hand edge, and the grid runs
  // down it too, so every view here is taller than its box before it is wider. This scrolls the
  // view when the drag nears its edge: the one motion in here, and the platform's own idea of a
  // drag rather than the app's.
  useEffect(() => {
    const element = viewRef.current;
    if (!element) return;
    return autoScrollForElements({ element });
  }, [hasRow]);

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
   * **Filtering used to decide which headings exist and no longer decides anything about it.**
   * `emptyGroupRules` carried a `narrowed` flag: while this filter was running, `grouping.ts`'
   * `drawsWhenEmpty` kept only the four seeded zones, because three letters in the box otherwise
   * answered with twenty headings over three rows. That wall was always made of piles the *app*
   * had created while filing cards, and those hide whenever they are empty now — filter or no
   * filter, since a pile this filter empties is an empty pile. So a filtered deck answers with
   * the reader's own deliberate piles and the fixed zones, which is what the narrowing was
   * reaching for, and **emptying a pile by hand and emptying it with the box are the same answer
   * again**. The shape of the deck still changes as they type — that is what a filter is — but
   * an empty pile of theirs stays on screen and stays a drop target while it does.
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
   * any more.** It reported whether the toolbar's box or a tag chip was running, and while one
   * was, only the four seeded zones drew empty. Every pile that wall was made of was one the app
   * had created while filing a card, and `grouping.ts` now keeps those out whenever they are
   * empty — a pile the filter emptied included. What is left drawing under a filter is the
   * reader's own piles, which is what they asked for, so the editor has one fact to pass rather
   * than two and this recomputes only when the format does.
   */
  const emptyGroupRules = useMemo(
    () => ({ requiresCommander: spec?.requiresCommander ?? false }),
    [spec],
  );

  const groups = useMemo(
    // No currency any more: the rows this groups arrived priced at the selected marketplace,
    // because that marketplace is in `useDeck`'s query key. A switch therefore changes
    // `deck.cards` itself and this recomputes over the new answer, rather than picking a
    // different field out of the old one.
    () => buildGroups(shown, categories, groupBy, sortBy, separateX, emptyGroupRules),
    [shown, categories, groupBy, sortBy, separateX, emptyGroupRules],
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
      // **The one scroller in this view that is the *page*, and it is new** — see
      // {@link DECK_HEIGHT_FLOOR}. The deck, the price strip and the stats band together want
      // more height than a 1280×800 window has, and none of the three may be cut, so the column
      // scrolls: the deck sits at its floor with the band's tail one scroll below it, and at a
      // taller window nothing moves at all. The header and the toolbar scroll away with it,
      // which is what makes this the page rather than a frame — the deck's own view keeps its
      // scroller inside, and a wheel spent there is spent there first.
      className={cn("flex h-full min-h-0 flex-col gap-3 overflow-y-auto", FOCUS)}
    >
      {/**
       * The deck's own ribbon, and the `py-1.5` on it is load-bearing rather than spacing.
       *
       * This row is the **first child of the page scroller** — the `section` above is
       * `overflow-y-auto` — and the name field's focus ring is `outline-2 outline-offset-2`,
       * so it stands **4px proud of the field on every side**. With no padding here the field
       * is vertically centred in a row whose tallest child is the 36px back button, which puts
       * the top of that ring outside the scroller's padding box: a scroll container clips
       * there, and what is left of it runs into the shell's mana line above. Six pixels is the
       * ring's four and two to spare, top and bottom.
       *
       * **Vertical only.** Horizontal padding here would indent the back button and the deck's
       * actions past the toolbar row beneath them and past the deck itself, and the ring has
       * room on that axis already — `gap-x-3` is 12px either side of the field's box, which is
       * three times what the ring asks for.
       */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 py-1.5">
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
                    {/* **Theory first, Live second.** The plan is the list a reader building a
                        deck is in; the live list is what they come back to when they sleeve it
                        up. It is also what makes turning the switch on land somewhere that reads
                        right — the write *moves* the deck into theory and leaves `lastVariant`
                        there, so the reader arrives on the tab their cards are now under, with
                        the empty one beside it rather than under their pointer. */}
                    {(
                      [
                        { id: "theory", label: "Theory" },
                        { id: "live", label: "Live" },
                      ] as const
                    ).map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => pickVariant(id)}
                        aria-pressed={variant === id}
                        className={cn(
                          // 36px like every other press in this ribbon — the back button, the
                          // `Built` chip and {@link CONTROL}. At 28px this segmented pair was
                          // the shortest thing in the row by eight pixels and read as a
                          // secondary control, which is the opposite of what it is: it says
                          // which of the deck's two lists is on screen.
                          "h-9 px-2.5 text-xs",
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
                  // **Two buttons where there was one called "Categories & tags".** The piles
                  // and the labels were two sections of one drawer, so reaching the second cost
                  // a press and a scroll; they are two dialogs now, each one press away and each
                  // sized for what it draws. The ampersand went with the split — a control named
                  // for two things is a control that can only ever be right about one of them.
                  { kind: "categories", label: "Categories" },
                  { kind: "tags", label: "Tags" },
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
                    "h-9 border-r border-border px-3 text-xs last:border-r-0",
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
              onChange={(e) => pickGroupBy(e.target.value as GroupBy)}
              className={cn(CONTROL, FILTER_FOCUS, "text-text")}
            >
              {GROUP_BY_PICKER.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            {/* A modifier of the select it stands beside, so it lives inside that cluster's
                `gap-1.5` rather than out in the toolbar's `gap-x-4` — and it is drawn **only**
                under Mana value, because there is nothing for it to say about a deck grouped by
                category or by type. A control that persists across a grouping it has no effect
                on is a control the reader has to remember the scope of.

                **Its state is the deck's, written through the same `update` the Built toggle
                writes** — one `deck_update`, no `deck_cards` row touched, and a refusal lands in
                the banner above with every other write of this editor's, because the refusal
                rule lives on the mutation's single definition and never on a call site.

                The whole sentence is the chip's `title`, which `ToggleChip` also makes its
                accessible name: "Split X" alone is a control naming a thing rather than an
                action, and the name has to stand up read out of context — a screen reader gets
                no select beside it. It begins with the visible label all the same (WCAG 2.5.3),
                so the chip is still addressable by what is written on it. */}
            {groupBy === "manaValue" && (
              <ToggleChip
                label="Split X"
                pressed={separateX}
                title="Split X — give cards with X in their cost a group of their own, instead of counting X as zero"
                onClick={() => deck.update.mutate({ separateXGroup: !separateX })}
              />
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <label htmlFor="deck-sort-by" className="text-[0.6875rem] text-dim">
              Sort
            </label>
            <select
              id="deck-sort-by"
              value={sortBy}
              onChange={(e) => pickSortBy(e.target.value as SortBy)}
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
              className={cn("h-9 w-44 rounded-md border border-border bg-bg px-2.5 text-xs", FOCUS)}
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
                        // `FILTER_CONTROL`'s own 36px, which the `h-8` here used to override
                        // back down to the toolbar's old height. Only the type size is still
                        // overridden: a deck's tags are a row of arbitrary user strings, and
                        // 14px of them is a line that pushes the filter field off the end.
                        "px-2.5 text-xs",
                        filterChipState(on),
                      )}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            )}
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

      {/* A collection or wishlist add the reader made from a card's right-click, refused.
          Separate from the banner above because that one speaks for writes to **this deck** and
          this one is about the binder — and it has to be drawn *somewhere*, because the menu
          cannot draw it: `ctx.run` closes the panel before a row's handler runs, so by the time
          an answer arrives there is no menu left to put a sentence in. The deck add is not here
          and needs nothing from this file — it reaches the app's single `useCardToDeck` through
          `CardToDeckProvider`, and that one mount draws its own sentence. Grown into place like
          its neighbour: the animated element is the wrapper and carries only `overflow-hidden`,
          because `statusLine` takes `height` to 0 and a box with its own padding can never be
          shorter than that padding. */}
      <AnimatePresence initial={false}>
        {menuFailure && (
          <motion.div {...statusLine} className="shrink-0 overflow-hidden">
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {menuFailure}
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
        // The deck on the left and the way cards get into it on the right (spec §7). One flex
        // row, so both are the full height of the editor — and `min-w-0` on the deck side,
        // because a view that cannot shrink is the horizontal scrollbar the 1024px floor
        // forbids. This element is also what `DECK_FLOOR` is measured against: it is the width
        // the two of them actually have, after the sidebar, the page padding and the card pane
        // have taken theirs. What the deck *adds up to* is no longer in this row; it is the band
        // under it, which trades no width with either of these — and no height either, until the
        // window is too short for both, where {@link DECK_HEIGHT_FLOOR} says which gives way.
        <div ref={deskRef} className={cn("flex flex-1 gap-4", DECK_HEIGHT_FLOOR)}>
          <div ref={viewRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
            {/* No `columnHeight`: this view packs nothing any more — every pile is a flex item
                that wraps on width, so the desk's height is not an input to its layout. `TextView`
                below still packs and still takes it. */}
            {view === "stacks" && <StackView {...viewProps} />}
            {view === "table" && <TableView {...viewProps} selectedCardId={selectedCardId} />}
            {view === "text" && <TextView {...viewProps} columnHeight={desk.height || undefined} />}
            {view === "grid" && <GridView {...viewProps} />}
          </div>

          <DeckSearchPanel
            add={deck.addCard}
            categories={categories}
            targetCategoryId={targetCategoryId}
            onTargetCategoryChange={setTargetCategoryId}
            defaultFormat={searchFormatDefault}
            cardMenu={panelCardMenu}
            cardMenuKey={panelCardMenuKey}
            roomy={roomForPanel}
            maxWidth={maxPanelWidth}
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

      {row && (
        // What the deck adds up to — the foot of the page, and the last thing under the deck.
        //
        // **It was an aside on the desk row with a toggle in the toolbar, and both halves of
        // that cost more than they bought.** The block took 280px off a row that already had to
        // fit a deck and a search panel, so opening it at 1280 with a card pane docked pushed
        // the panel to its rail — and the toggle beside the tag filters was a control whose only
        // job was to give that width back. Full width under the deck, the four charts and the
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
        // **A `section`, not an `aside`** — the same call `DeckSearchPanel` makes and for the
        // same measured reason: the card detail pane is the app's one complementary landmark,
        // and a second one answers `getByRole("complementary")` too. Drawn as an aside, this
        // block broke five of `App.test.tsx`'s pane assertions without touching the pane.
        //
        // Named by its `aria-label` and by nothing drawn: every figure in it carries its own
        // label and every chart its own caption, so a heading over the top would be a fifth
        // word for something already said four times — and a line of deck height for it.
        //
        // **`shrink-0`, and that is the whole of why this editor scrolls now** — see
        // {@link DECK_HEIGHT_FLOOR}. The band is drawn whole or not at all: a curve with its
        // last two buckets cut off and a legend with its last colour under the fold is a chart
        // that has stopped being one, which is the same line `DeckStats` takes about wrapping
        // rather than truncating.
        <section aria-label="Deck stats" className="shrink-0 border-t border-border pt-3">
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
          <DeckStats
            cards={deck.cards}
            marketplace={marketplace}
            send={deck.missingToWishlist}
            separateXGroup={separateX}
          />
        </section>
      )}

      {/* The seven overlays, mounted **at the editor's top level and as siblings of the layout
          above**, which is not a tidiness preference. Each is `fixed inset-0` and none is
          portalled, so a transformed ancestor would become its containing block and pin it to
          whatever box that ancestor happens to occupy — and this editor has transformed
          elements in it (a virtualised table's rows are `absolute` *and* `transform`ed, which
          is a stacking context and a containing block both). Mounted inside the view area, a
          dialog would centre itself over a column instead of over the window.

          Each is closed by `open`, and each of the seven unmounts everything behind that flag —
          so a closed one costs no query, no window listener and no state. That is what makes it
          safe to mount all seven unconditionally, and it is why the editor can hold them in one
          `Layer` union rather than seven booleans. For five of them `DeckDialog` guarantees it:
          `open` gates an `AnimatePresence`, so a closed dialog's body is not in the tree at all.
          The theory diff and the import dialog are not on that shell (see the `Layer` union's
          doc) and each guarantees the same thing with an `AnimatePresence` of its own — which
          is a second and a third copy of the rule rather than a second reading of it.

          **Two of them were one until 2026-08-14.** `CategoriesPanel` drew the deck's piles and
          its labels as two sections of a single right-hand drawer; they are `CategoriesDialog`
          and `TagsDialog` now, which is why the toolbar above has a button for each. */}
      <CategoriesDialog
        deckId={deckId}
        variant={variant}
        open={layer?.kind === "categories"}
        onDismiss={dismiss}
        onClose={close}
      />
      <TagsDialog
        deckId={deckId}
        variant={variant}
        open={layer?.kind === "tags"}
        onDismiss={dismiss}
        onClose={close}
      />
      <DeckHistoryDialog
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
      {/* The one whose target has to be **the list on screen**: an import lands in one variant
          and a `replace` clears at most one, so a paste made while Theory is up must never touch
          what is sleeved. `cardsInVariant` is what a `replace` would clear, said in words before
          it is chosen.

          `forcedCategoryName` is set only when the dialog was opened from a category heading's
          right-click, and it is the whole of the difference between "import into this deck" and
          "import into this pile" — applied in `buildImportPlan`, not here, because `plan.ts`
          makes every deck decision. The toolbar's own press carries none and is unchanged.

          `dismiss` on the way out, whichever way the import ended: the trigger is one press
          away in the toolbar and the deck it wrote into is already on screen — the editor
          re-reads it, because every write in `useDeckImport` takes the `["decks"]` root with
          it. */}
      <ImportDeckDialog
        target={{ kind: "deck", deckId, variant, cardsInVariant }}
        forcedCategoryName={layer?.kind === "import" ? layer.forcedCategoryName : undefined}
        open={layer?.kind === "import"}
        onDismiss={dismiss}
        onClose={close}
        onImported={dismiss}
      />
      {/* The last of the seven, and the only one with no control in this view: it is opened from
          a category heading's right-click. `cards` is an argument the dialog never fetches —
          which is exactly what lets one pile be handed to a component a deck-level export will
          reuse whole — and it is derived from the deck's live list rather than from whatever the
          menu was holding. See {@link exported}. */}
      {/* The confirmation a `Delete…` owes, and it is **`CategoriesDialog`'s own component**
          rather than a second one written here. That dialog asks a careful question — the cards
          go with the pile unless the reader names somewhere to move them, and the sentence
          changes with the answer — and two confirmations for one command would be two chances to
          word "this cannot be undone" differently. It takes `meta` and draws itself, so the only
          thing this file decides is which pile and what "the others" are.

          `others` is every category **but** this one, in the reader's own `sortOrder`: the list
          the move picker offers, which must not include the pile being deleted. */}
      <DeckDialog
        open={layer?.kind === "deleteCategory"}
        title={deletedCategory === null ? "Delete category" : `Delete “${deletedCategory.name}”`}
        closeLabel="Close"
        // Narrow, because the body is one question, one picker and two buttons — the width class
        // is written out whole, since Tailwind emits no rule for a class built at runtime.
        width="w-[28rem]"
        onDismiss={dismiss}
        onClose={close}
      >
        {deletedCategory && (
          <div className="px-4 pb-4">
            <DeleteCategory
              category={deletedCategory}
              others={categories.filter((c) => c.id !== deletedCategory.id)}
              meta={meta}
              onCancel={dismiss}
              onDeleted={dismiss}
            />
          </div>
        )}
      </DeckDialog>

      <ExportDialog
        open={layer?.kind === "export"}
        subject={exported.subject}
        cards={exported.cards}
        suggestedFileName={exported.fileName}
        onDismiss={dismiss}
        onClose={close}
      />
    </section>
  );
}
