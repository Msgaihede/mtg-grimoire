import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  Columns3Cog,
  History,
  Redo2,
  Scale,
  SquareArrowRightEnter,
  SquareArrowRightExit,
  Tag,
  Undo2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  filterChipState,
  ToggleChip,
} from "@/components/FilterChips";
import { isTextField, useContextMenu } from "@/components/menu/useContextMenu";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { CardDetailPane } from "@/features/card/CardDetailPane";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { buildCardMenu, type CardMenuTarget } from "@/features/card/cardMenu";
import { usePublishCardWalk } from "@/features/card/cardWalk";
import { useCardMenuDeps } from "@/features/card/useCardMenuDeps";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import {
  ipc,
  ipcError,
  type CardSummary,
  type DeckCard,
  type DeckCategory,
  type DeckFinish,
  type DeckPullRow,
  type DeckQuickAddWish,
  type DeckVariant,
} from "@/lib/ipc";
import { PRESS, statusLine } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { matchesShortcut, shortcut } from "@/lib/shortcuts";
import { useMarketplace } from "@/lib/useMarketplace";
import { clearFieldOnEscape, useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useAppStore, type PaneDeckContext } from "@/lib/store";
import { useCardSelection } from "@/lib/useCardSelection";
import { cn } from "@/lib/utils";
import { newestWrite, writeFailure } from "@/lib/writes";
import {
  DECK_CARD_VARIANT,
  focusDeckGroup,
  keepsSelection,
  type DeckCardActions,
  type DeckCardGroupDrag,
} from "./cardControl";
import { AUTO_CATEGORY } from "./autoCategory";
import { CategoriesDialog, DeleteCategory } from "./CategoriesDialog";
import { movedTo } from "./categoryDrag";
import { buildCategoryMenu } from "./categoryMenu";
import { ClearCategory } from "./ClearCategory";
import { buildDeckCardMenu } from "./deckCardMenu";
import { deckSlotOrder, deckWalkStops } from "./deckWalk";
import { Dialog } from "@/components/Dialog";
import { DeckHistoryDialog } from "./DeckHistoryDialog";
import { DeckBracket } from "./DeckBracket";
import { DeckLedger } from "./DeckLedger";
import { DeckNameField } from "./DeckNameField";
import { DeckSearchPanel, MIN_PANEL_WIDTH_PX } from "./DeckSearchPanel";
import { DeckSettingsDialog } from "./DeckSettingsDialog";
import { DeckStats } from "./DeckStats";
import { useDeckUndo } from "./useDeckUndo";
import { deckCardSlot, dropWrite, type DeckWrite, type DragPayload } from "./dnd";
import { ExportDialog } from "@/features/transfer/export/ExportDialog";
import { fromDeckCard, type TransferCard } from "@/features/transfer/TransferCard";
import {
  asGroupBy,
  buildGroups,
  DEFAULT_GROUP_BY,
  GROUP_BY_OPTIONS,
  type GroupBy,
} from "./grouping";
import type { ImportDestination } from "@/features/transfer/import/destination";
import { deckDestination } from "@/features/transfer/import/destinations/deckInto";
import { newDeckDestination } from "@/features/transfer/import/destinations/newDeck";
import { NewDeckPreview } from "@/features/transfer/import/destinations/NewDeckPreview";
import { ImportDialog } from "@/features/transfer/import/ImportDialog";
import { RenameField } from "./metaRows";
import { AddLabelDialog } from "./AddLabelDialog";
import { PriceStrip } from "./PriceStrip";
import { pullKey } from "./pullPlan";
import { PullFromCollectionDialog } from "./PullFromCollectionDialog";
// **`quickCollection` and not `quickAdd`**, which is a Windows filename hazard rather than a
// naming preference: `QuickAdd.tsx` — the toolbar's quick-add field — already sits in this
// directory, and a case-insensitive filesystem resolves `./quickAdd` to whichever of the two the
// resolver reaches first. `tsc` refuses the whole program with TS1149 and a suite that got past
// it went red with `quickAddShort is not a function`, having imported the component.
import { chooseWish, choosePull } from "./quickCollection";
import { QuickAdd } from "./QuickAdd";
import { QuickUnwishDialog } from "./QuickUnwishDialog";
import { QuickCategoryDialog, QuickZones } from "./QuickZones";
import { asSortBy, DEFAULT_SORT_BY, SORT_OPTIONS, type SortBy } from "./sorting";
import { LabelsDialog } from "./LabelsDialog";
import { TheoryDiffDialog } from "./TheoryDiffDialog";
import { theoryMatchPlan } from "./theoryMatch";
import { pullPlanQuery, quickAddWishesQuery, useDeck, usePullPlan } from "./useDeck";
import { useDeckMeta } from "./useDeckMeta";
import { useFormatSpecs } from "./useFormatSpecs";
import { useRecentAdds } from "./useRecentAdds";
import { ValidationPanel } from "./ValidationPanel";
import { validateForMarks } from "./validation/engine";
import { violationsByCard } from "./violations";
import { GridView } from "./views/GridView";
import { StackView } from "./views/StackView";
import { TableView } from "./views/TableView";
import { TextView } from "./views/TextView";

/**
 * Two of the toolbar's three option lists, as the toolbar draws them: alphabetically by label.
 * The third is {@link VIEW_PICKER}, which sits beside the array it sorts.
 *
 * Sorted here rather than trusted from `grouping.ts` and `sorting.ts`, whose arrays are named
 * in domain order and happen to read alphabetically today — which is exactly how an ordering
 * drifts the day somebody appends a fourth grouping or a fifth sort. Module level, so the sort
 * is paid once per session rather than once per render of the largest component in the app.
 */
const GROUP_BY_PICKER = sortOptions(GROUP_BY_OPTIONS, (o) => o.label);
const SORT_BY_PICKER = sortOptions(SORT_OPTIONS, (o) => o.label);

/**
 * The three chords this editor binds, looked up **once at module scope** — `AppShell`'s
 * arrangement for the two it binds, and it is the right one here for the same reason.
 *
 * `shortcut()` throws on an id the catalogue does not carry, which is the whole reason it is a
 * function rather than an index; resolving at import makes that throw arrive before a render and
 * before a press. Resolved inside a `keydown` handler instead, a renamed id throws on a `window`
 * listener where no error boundary is standing — the editor keeps drawing, and the only symptom
 * is a key that quietly stopped working.
 */
const UNDO = shortcut("deckEditor", "undo");
const REDO = shortcut("deckEditor", "redo");
const REMOVE = shortcut("deckEditor", "remove");

/**
 * A header/toolbar press that is not a chip — since 2026-08-26 exactly the undo/redo pair and
 * the header's Categories/Labels/History/Deck settings row.
 *
 * **The toolbar's three pickers — View, Group by, Sort — drew from this same string until
 * then.** They moved onto `components/Dropdown`, whose trigger is a `<button>` rather than a
 * `<select>` and draws its own `md` geometry rather than borrowing this one; a native select and
 * a popup-driven button were never going to share one class list forever. What is left is what
 * this doc's own numbers were always about — a plain press, never a picker.
 *
 * **36px, and the number is `FILTER_CONTROL`'s rather than one of this file's own.** It was 32
 * for the same stated reason it is 36 now — "so the two rows read as rows rather than as a pile
 * of differently sized boxes" — but the rows it was measured against grew a chip since:
 * `Split X` sits in the toolbar, and `ToggleChip` is `FILTER_CONTROL`, which is 36. So a height
 * meant to unify was drawing the plain presses four pixels shorter than the chip beside them,
 * and shorter again than the `h-9` back button at the head of the header row. Every other filter
 * row in the app (search, collection, wishlist) is already 36; this is the deck editor joining
 * them rather than a size invented here. The header carried a `Built` chip of its own when this
 * was measured; that chip is gone, and 36 stands on the app-wide agreement rather than on it.
 *
 * **`text-xs` stays, and that is a width decision with a measurement behind it.** `FILTER_CONTROL`
 * carries `text-sm`, but the six controls drawn with this string are the header's widest block —
 * measured at **692px** at max-content — and 14px glyphs put it near **760**, which is more than
 * the 1017px content box a 1280×800 window leaves once the sidebar, the shell padding and the
 * editor's own scrollbar are taken off. The row is `flex-wrap`, so it does not overflow; it wraps,
 * and a wrapped header costs 44px of deck height at the app's own default window size — the
 * regression `NAME_FLOOR` (see {@link DeckNameField}) exists to keep out. Height is the axis
 * that had room.
 *
 * The press is {@link PRESS}, the app's one recipe.
 */
const PLAIN_PRESS =
  "h-9 rounded-md border border-border bg-surface px-2.5 text-xs text-dim " +
  `${PRESS} ` +
  "disabled:active:scale-100";

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
 * Which of the desk's two columns the card pane is drawn over — `"search"` or `"deck"`.
 *
 * **An attribute because the decision is invisible to everything else.** What the two positions
 * differ by is a `right` offset and a width, and both are numbers this component measures — so
 * jsdom, which has no layout engine, reads `0` for each of them and cannot tell the two apart at
 * all. The attribute is the *choice* rather than its geometry, which is the half a suite can
 * honestly hold; the geometry is a live-window question, and this is also the handle a CDP pass
 * uses to ask it (`[data-pane-over]`, then the rects).
 *
 * `DECK_GROUP_ATTR`'s argument, one surface over: an attribute is a question the DOM can answer
 * from anywhere, and the alternative here — walking up from the pane's own `complementary` role
 * to whatever box happens to be its parent — is a test that breaks when a wrapper is added and
 * says nothing about what the wrapper is for.
 */
export const PANE_OVER_ATTR = "data-pane-over";

/**
 * The shortest the desk row may be squeezed to — `DECK_FLOOR`'s rule turned on its side, because
 * the stats band is the first thing this editor has ever stacked *below* the deck rather than
 * beside it.
 *
 * **It is a floor and no longer also a ceiling, and it moved off the desk row to say so**
 * (2026-08-14). The row used to be exactly as tall as whatever the page could spare, never less
 * than this and never more, and the deck's view scrolled inside it — the
 * scrollbar-in-the-deck-builder this floor's own arithmetic was written around. The views grow
 * now, so this says only how short the deck may get: four nearly empty piles still draw a desk
 * one card tall, rather than a strip of headings with the price line under it.
 *
 * **It is on the view and not on the row, and that is the whole of the bug it fixed.** The row
 * is `flex-1` — `flex: 1 1 0%` — inside the page, and a flex item's automatic minimum size is
 * what stops it being squeezed below its content. `min-h-96` *replaces* that `auto`: with a
 * number there the row has no content-based minimum left, so it takes the free space, floors at
 * 384, and lets a taller deck spill out of it. Measured in the shipped window on a 132-card,
 * 17-pile deck at 1280×800, with the class still on the row: the deck drew **2 783px** of piles
 * in a desk box of **384**. It *looked* right — the piles paint, and the page counted them, so
 * the editor scrolled to 2 996 — and two things behind it were wrong. The price strip and the
 * stats band were laid out from the foot of the 384, i.e. over the deck rather than under it;
 * and `position: sticky` is clamped to its containing block, so the search panel could follow
 * the reader for 384px and was then dragged off the top of the window with the box it was in.
 * On the view the number is a `min-height` on a stretched flex item, which floors it without
 * capping it — the row is then as tall as the view, and the row's own `auto` minimum is back.
 *
 * **`cn` puts it before the table branch's `min-h-0` on purpose**: they are one tailwind-merge
 * group, the later wins, and the virtualised table has to keep the squeezable box it has always
 * had. A floor under a scrollport would be a floor under a scrollbar.
 *
 * Everything below is the measurement 384 came from and the reasoning for the page scroller,
 * both of which stand.
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
 * `overflow-y-auto`: the deck holds at least 384, the band draws whole, and whatever does not
 * fit is one scroll away. At 1920×1080 a deck that fits does not scroll at all and takes the
 * surplus (**519px**); a deck that does not fit is now what pushes the band down the page, where
 * before it was the band pushing the deck into a letterbox of its own. A band
 * that shrank instead was measured at **92px** with 229px of charts inside it, which is a
 * scrollbar over a chart nobody can read — the thing `DeckStats` refuses when it wraps rather
 * than truncates.
 *
 * Written out whole rather than built from the number — Tailwind scans source text for class
 * names, and one assembled at runtime emits no rule at all.
 */
const DECK_HEIGHT_FLOOR = "min-h-96";

/** Stable identity for "no label filter", so the memo below does not re-run on every
 *  render. */
const NO_LABELS: readonly number[] = [];

/** Stable identity for the wishes a *closed* {@link QuickUnwishDialog} is handed. The shell
 *  mounts no body while it is shut, so nothing reads this — a fresh `[]` on every render would
 *  still be a new prop on every render of the deck, which is the kind of churn `NO_ROWS` in
 *  `PullFromCollectionDialog` exists to avoid. */
const NO_WISHES: readonly DeckQuickAddWish[] = [];

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

/** The same trick for the closed export dialog, which is mounted at every render and asked for
 *  a card list whether or not it is drawing one. */
const NO_EXPORT_CARDS: readonly TransferCard[] = [];

/**
 * What the export dialog is titled when the pile it was opened on has gone.
 *
 * Reachable: another surface — the Categories dialog, a second window on the same database —
 * can delete a category while this dialog is open over it, and the editor re-reads the deck
 * without it. The empty card list that follows is honest; `Export ""` as the dialog's accessible
 * name is not, which is the whole reason this string exists rather than a fallback of `""`.
 * **Not the deck's name**, and that is sharper now than when it was written: the header's
 * `Export deck` titles itself with exactly that, so a deleted pile falling back to it would be
 * indistinguishable from a press nobody made.
 */
const DELETED_CATEGORY = "a deleted category";

/**
 * What the export dialog is titled when the **deck** has no name of its own.
 *
 * {@link DELETED_CATEGORY}'s argument applied to the other scope — `Export ""` is not an
 * accessible name — and the state is reachable rather than defensive: the header's name field
 * takes an empty string, and the editor renders with `row` still `null` for the length of the
 * first read.
 */
const UNNAMED_DECK = "this deck";

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
 * Exported for its test, and still exported now that the header has an `Export deck` to open the
 * dialog with: what this answers is only ever *seen* inside the native save picker, which
 * `dialog:allow-save` opens outside the page — no test and no CDP pass can read the name in that
 * box. The dialog has a rendered path; this string does not.
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
 * What is being exported: the whole deck, or one pile.
 *
 * **Three states rather than a nullable id**, counting the `null` {@link exportSubject} takes for
 * a closed dialog: `null` already carries a meaning in the layer's own arm — the whole deck — so
 * reusing it for "nothing is being exported" would be one sentinel answering two questions. Two
 * shapes ask them separately, and each answer is then narrowed by the type rather than by a
 * comment.
 */
export type ExportScope = { kind: "deck" } | { kind: "category"; categoryId: number };

/**
 * The three arguments `ExportDialog` takes, for whatever the `export` layer is aimed at.
 *
 * **Derived from the deck's live list rather than from what a control was holding**, which is why
 * the layer carries an id and not the cards: a deck is re-read after every write, so a snapshot
 * taken when the menu opened would describe the pile as it was. A rename under the open dialog
 * therefore retitles it, and a delete empties it and says so.
 *
 * `cards` is the deck's rows and **not** `shown`: the toolbar's filter narrows what is *drawn*,
 * and exporting "Removal" means the pile rather than the four of it a search box happens to be
 * showing. **The deck scope passes every row of the variant on screen, switched-off piles
 * included** — what a format does with a maybeboard is the *format's* decision, and
 * `format.ts`'s `omittedCount` is what says so in the dialog rather than a filter here.
 *
 * A `null` scope is a **closed** dialog, which is every render but the ones it is up — the
 * subject is `""` there because nothing draws it, and that is the one case that must **not** read
 * {@link DELETED_CATEGORY}: a closed dialog is not a statement about a deleted pile.
 *
 * **The cards are `TransferCard`s, built through `fromDeckCard`** — the row shape `ExportDialog`
 * and `formatExport` speak now, so this function is one of the two places (`categoryMenu.tsx`'s
 * export row is the other) that adapts a deck's own `DeckCard`s on the way out. That trades away
 * the old identity guarantee for the deck scope — the returned array is a fresh one, mapped
 * rather than passed through — but the claim it stood for is untouched: every row of the variant
 * on screen still arrives, switched-off piles included, with nothing filtered out here.
 *
 * Pure, and exported for that reason: see {@link exportFileName}.
 */
export function exportSubject(
  scope: ExportScope | null,
  categories: readonly DeckCategory[],
  cards: readonly DeckCard[],
  deckName: string,
): { subject: string; cards: readonly TransferCard[]; fileName: string } {
  if (scope === null) {
    return { subject: "", cards: NO_EXPORT_CARDS, fileName: exportFileName(deckName, "") };
  }
  if (scope.kind === "deck") {
    return {
      subject: deckName === "" ? UNNAMED_DECK : deckName,
      cards: cards.map(fromDeckCard),
      // The deck's own name and no second half, which `exportFileName` already answers for an
      // empty one: a whole-deck export is the deck, so there is no pile to name after it.
      fileName: exportFileName(deckName, ""),
    };
  }
  const name = categories.find((c) => c.id === scope.categoryId)?.name ?? null;
  return {
    subject: name ?? DELETED_CATEGORY,
    cards: cards.filter((c) => c.categoryId === scope.categoryId).map(fromDeckCard),
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

/** How a deck is drawn, and what the switch calls each one. */
type DeckView = "stacks" | "table" | "text" | "grid";
const VIEWS: readonly { id: DeckView; label: string }[] = [
  { id: "stacks", label: "Stacks" },
  { id: "table", label: "Table" },
  { id: "text", label: "Text" },
  { id: "grid", label: "Grid" },
];

/**
 * The view switch as the toolbar draws it — a `Dropdown`, like the two pickers beside it.
 * It was a four-button segmented group until 2026-08-15, then a `<select>` like its two
 * neighbours, then (2026-08-26) all three moved onto `components/Dropdown` — see
 * {@link VIEW_OPTIONS}, which is this array reshaped for that component's `options`.
 *
 * **Three controls answering three questions about one list, in one grammar.** `View` says how a
 * card is drawn, `Group by` says what the headings are and `Sort` says the order inside one;
 * drawing the first as a four-button segmented group and the other two as selects made the
 * odd one out the one a reader reaches for most, and spent a quarter of the toolbar's width on
 * three answers nobody had asked for. A dropdown costs one press to open and shows the picked
 * view when it is shut, which is what the pressed button was doing at four times the width.
 *
 * **Alphabetically, through `sortOptions`, because there is no order here that carries
 * information.** The array above is written in the order the views were built and reads as a
 * decision nobody made — the two exemptions this app grants (an order that *is* the information,
 * like a grade scale; an order the reader arranged themselves, like their own categories) fit
 * neither. Sorted at module level for {@link GROUP_BY_PICKER}'s reason.
 */
const VIEW_PICKER = sortOptions(VIEWS, (v) => v.label);

/**
 * {@link VIEW_PICKER}, reshaped for `<Dropdown>`'s `options` prop — `id` renamed to `value`,
 * the field every `DropdownOption` is keyed on, and nothing else moved. Two names for the same
 * list rather than one: `VIEWS`' own `id` field is `DeckView`-typed and read straight into
 * `setView`, and renaming it there would ripple into every other reader of `DeckView` far past
 * this toolbar.
 */
const VIEW_OPTIONS: readonly DropdownOption[] = VIEW_PICKER.map(({ id, label }) => ({
  value: id,
  label,
}));

/**
 * The dismissible layers this editor *owns*, and it deliberately holds at most one.
 *
 * **At most one of these is ever meant to be open, and a union is what makes that structural
 * rather than remembered.** A boolean per member could express "Categories and History both up",
 * which is
 * a state nothing here draws and nothing here could draw well: two scrims, two `aria-modal`
 * panels and two focus traps, with two hand-backs racing for the caret as either closes. One slot
 * cannot say it, and the failure it forecloses is the invisible kind — every test that opens one
 * layer at a time passes either way. Every member below registers the same `"inner"` Escape rung
 * from inside its own component, so at most one of those registrations is ever enabled.
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
 * `check` is the format check anchored to its chip; **every other arm is a full-window overlay**
 * on `LAYER.overlay` — one rung between them, rather than one each, because of that same "at most
 * one is up": they
 * never need ordering against each other (see `layers.ts`). Categories and labels used to be one
 * of them: a single right-hand drawer with two sections in it. Splitting it into two dialogs adds
 * a member here and takes nothing away from the argument — one slot is one slot however many
 * things can occupy it, which is also why the export dialog joined without an argument being
 * reopened.
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
 * anchored layer out here; the overlays make it unreachable, because a pointer cannot get
 * to the pane through a scrim.
 *
 * **Every overlay here is modal, and that is what makes the sentence above true of a keyboard
 * too**: each paints a full-window scrim, claims `aria-modal="true"` and runs `lib/trapTab.ts`,
 * so nothing behind one can be reached by Tab any more than by a pointer. Two of them used to
 * argue the opposite in their own docs while drawn as right-hand drawers; the scrim had always
 * contradicted it. `DeckEditor.test.tsx`'s "keeps Tab inside itself" sweep holds **the ones with a
 * control in this view** together — the delete-category and clear-stack confirmations and the
 * quick zones' New category have no button to point that sweep at, and the export dialog joined
 * it when the header grew `Export deck` — and it is a **behavioural** sweep for a reason worth
 * reading before the next modality edit.
 *
 * **Every overlay here is a `Dialog`** — where the scrim, the centring, `aria-modal`, the
 * trap, the ✕ and the `"inner"` rung are written once, and since 2026-08-16 that shell is the
 * only definition of a modal in this surface. `TheoryDiffDialog` and `ImportDialog` were the
 * last two here carrying their own copy of that chrome, with `CreateDeckDialog` a third copy
 * outside this editor; all three moved onto the shell on that date.
 *
 * **The cost while the copies lasted is why the shell exists, and is the argument for not
 * starting a fourth.** A change to how a modal behaves here — a focus restore, a different
 * `trapTab`, a change to when the rung is enabled — was an edit to **four files, not one**,
 * until 2026-08-16, and each of those files was free to answer a shared question its own way:
 * one editor drew two scrim darknesses, the ✕ at two geometries and two speeds, and the panel
 * at three `max-h` values, none of it decided by anybody. A new modal here is built *on*
 * `Dialog.tsx` rather than beside it.
 */
type Layer =
  | { kind: "check" }
  /**
   * The bracket estimate, anchored to its own readout on the ledger — the second arm that is not
   * a full-window overlay, and it is in this union for the reason every other member is: at most
   * one of these is up, so the check's findings and the bracket's advisory can never be open over
   * each other at the two ends of one line.
   *
   * **It rode inside `check` until 2026-08-24.** A bracket cannot make a deck illegal, so an
   * advisory printed under a list of findings was a second answer nobody had asked the first
   * question to get to; it is a press of its own now, and `DeckBracket` is where the estimate and
   * its copy live.
   */
  | { kind: "bracket" }
  | { kind: "categories" }
  | { kind: "labels" }
  /**
   * The pull: what this deck is short of that the reader **already owns**, and which copies to
   * move into its group.
   *
   * **A full-window overlay like its neighbours, by the rule that decides every one of them**
   * (`src/CLAUDE.md`): a surface the reader *consults* is a centred modal, and only a surface
   * they work *out of* while editing beside it earns a place in the layout. This is consulted —
   * a plan is read, a few numbers are set, and it is shut — and it is consulted at the widest
   * grain anything in this editor asks about: every hole in the list, and every unallocated copy
   * on the reader's desk that could fill one. A docked column of that would take its width from
   * the deck for the whole session; the desk row measures 602px at the app's own 1280×800 with
   * the card pane docked, and the deck's own floor is what runs out first.
   *
   * **The card, or absent for the whole deck — and the payload arrived on 2026-09-03.** It used
   * to carry nothing, on the argument that `deck_pull_plan` takes the deck and no variant (it
   * reads the live list, because a plan holds no cards to be short of), so there was nothing for
   * an arm to hold that the editor did not already know. That is still true of the *read*: a
   * deck card's `Collection ▸ Pull …` (issue #350) fetches the same plan under the same key and
   * this arm narrows only what the dialog is handed — the rows whose {@link pullKey} matches
   * this card, and that card's name for the subtitle.
   *
   * **So the payload is what the dialog draws, never what is read**, which is why the query's
   * gate below asks `layer?.kind === "pull"` and not {@link layerMatches}: both shapes want the
   * same plan, and a gate that distinguished them would spend a second `deck_pull_plan` on the
   * card entrance for an answer already in the cache.
   *
   * `null` for the opener on the theory tab is unchanged and is still not a disabled button:
   * there is no question to ask there, rather than a question with an empty answer.
   */
  | { kind: "pull"; card?: DeckCard }
  /**
   * **Which wish these copies come off** — a deck card's `Collection ▸ Quick add N and remove
   * from wishlist`, on the one press where the answer is ambiguous (issue #350).
   *
   * **Every field is frozen on purpose, which is `quickCategory`'s exception rather than
   * `export`'s rule.** The arms that carry an id name a row the editor re-reads the deck into;
   * this one names a **press that is over**: the reader right-clicked one row, the menu quoted
   * one number off it, and `deck_quick_add_wishes` has already answered for that printing and
   * finish. Looking any of it back up would be looking up the answer the reader was shown.
   *
   * `wishes` is `many` and only `many` — {@link chooseWish} writes outright for none and for
   * one, so this layer is opened for two or more and the dialog never asks a question with one
   * answer in it.
   */
  | { kind: "quickUnwish"; card: DeckCard; copies: number; wishes: readonly DeckQuickAddWish[] }
  | { kind: "history" }
  | { kind: "theoryDiff" }
  | { kind: "settings" }
  /** The pile every line lands in, for an import opened from a category's right-click — absent
   *  from the toolbar's own press, which files each card by what it does. */
  | { kind: "import"; forcedCategoryName?: string }
  /**
   * What is being exported. **The id and not the cards**: the deck is re-read after every write
   * and this editor already holds the answer, so the dialog is fed from the actual list rather
   * than from an array frozen at the moment a control was pressed.
   *
   * **`null` is the whole deck**, which is the header's `Export deck`; a number is one pile,
   * which is a category heading's right-click. Two controls, one layer — so this is the one kind
   * whose *kind* is not enough to say which button is open, and {@link layerMatches} is what
   * asks the rest.
   */
  | { kind: "export"; categoryId: number | null }
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
  /**
   * The pile a `Clear stack…` was pressed on. The **id**, like the two arms above and for their
   * reason — and here it buys one thing more: the confirmation counts copies off the live row,
   * so a card added or stepped under the open question is counted as it now is rather than as it
   * was when a menu row was pressed.
   *
   * A separate arm from `deleteCategory` rather than a flag on it, because the two ask different
   * questions with different scopes — a delete takes both lists and offers somewhere to put the
   * cards, a clear takes one list and offers nothing — and a union arm is where a state that
   * means nothing while the other is open belongs.
   */
  | { kind: "clearCategory"; categoryId: number }
  /**
   * A card was let go over the quick zones' **New category**, and the pile it is going into has
   * no name yet.
   *
   * **The whole payload, not a card id**, and it is the one arm that carries a drag: what the
   * card is doing depends on where it was picked up — a printing off a wall is *added* to the
   * new pile and a row of this deck is *moved* into it — and that is exactly what a
   * {@link DragPayload} says and a card id does not. It is also frozen on purpose, unlike
   * `export`, `deleteCategory` and `clearCategory` above: those name a row the deck is re-read
   * into, while this names a gesture that is over. There is nothing live to look it up from.
   */
  | { kind: "quickCategory"; payload: DragPayload }
  /**
   * A card's **Label card ▸ New label…** was pressed, and the label it will wear has no name
   * and no colour yet.
   *
   * **The slot rather than a card id, and frozen on purpose** — `quickCategory`'s exception
   * rather than `export`'s rule. The three arms above name a row the editor re-reads the deck
   * into, so an id keeps them current; this one names a **press that is over**, on one card in
   * one pile in one finish, and the write it ends in (`deck_card_set_label`) is addressed by
   * exactly that triple. Looking it back up would be looking up the answer the reader already
   * gave. The name rides along because the dialog's header says which card it is about, and a
   * card removed under the open dialog must not turn that sentence into a blank.
   */
  | { kind: "addLabel"; slot: AddLabelSlot }
  | null;

/** The card a label is being put on: the grain `deck_card_set_label` is addressed at, plus the
 *  name {@link AddLabelDialog} says out loud. */
interface AddLabelSlot {
  cardId: string;
  categoryId: number;
  finish: DeckFinish;
  name: string;
}

/**
 * Is the open layer the one this control opens?
 *
 * **Two kinds are reached by two controls each**, and for both the kind alone is not the answer:
 * `export` (the header's `Export deck` and a category heading's `Export cards…`) and, since
 * 2026-09-03, `pull` (the stats band's `Pull from collection` and a deck card's
 * `Collection ▸ Pull …`). A control that read `aria-expanded` off the kind would claim to be
 * open while the *other* one's dialog was up. Every other arm has one opener, which is why this
 * is a widening of `layer?.kind === kind` rather than a second rule beside it.
 *
 * Pure and exported for its test, like the two functions above it: the case it exists for is
 * unreachable by a press — an open export paints a scrim over both of its openers — so the only
 * way to assert it is to ask it directly.
 */
export function layerMatches(open: Layer, target: NonNullable<Layer>): boolean {
  if (open === null || open.kind !== target.kind) return false;
  if (open.kind === "export" && target.kind === "export") {
    return open.categoryId === target.categoryId;
  }
  if (open.kind === "pull" && target.kind === "pull") {
    // **Absent and present are different controls**, which is the whole of what this arm asks:
    // the stats band opens `{ kind: "pull" }` over the deck and a card's menu opens one carrying
    // that card, so a bare kind test would have the band's button claim to be open while a
    // per-card dialog was up. Two *cards* can never be open at once — there is one slot — so the
    // comparison below is a courtesy rather than a case anything reaches, and it is by
    // {@link pullKey} rather than by object identity because a `DeckCard` is a fresh object on
    // every `deck_get`.
    if (open.card === undefined || target.card === undefined) {
      return open.card === undefined && target.card === undefined;
    }
    return pullKey(open.card) === pullKey(target.card);
  }
  return true;
}

/**
 * The header's dialog buttons, each carrying the layer it opens.
 *
 * It used to carry a `kind` per row, which stopped being enough when `export` grew a payload: the
 * header exports the **whole deck** (`categoryId: null`) and a category heading exports one pile,
 * and both are the same layer kind.
 *
 * **"Import cards" and not "Import"**, which is what it said for one test run: the dialog it
 * opens carries a control called `Import`, and two buttons with one name on screen at once is a
 * pair a screen reader can only tell apart by position. It names what it puts in the deck, the
 * way the gallery's `Import deck` names what it makes. **"Export deck" and not "Export cards"**
 * for the mirror of that reason — the category menu's row is already called `Export cards…`, so
 * this one names its scope instead.
 *
 * **Two buttons where there was one called "Categories & tags"** — the title it carried while
 * a label was called a tag. The piles and the labels were two sections of one drawer, so
 * reaching the second cost a press and a scroll; they are two
 * dialogs now, each one press away and each sized for what it draws. The ampersand went with the
 * split — a control named for two things is a control that can only ever be right about one of
 * them.
 *
 * **Every row here costs width on a row that already wraps.** This block measured **825px** at
 * 1280×800 against the ~729 the ribbon can spare (2026-08-14, a debug build) with five buttons on
 * it; `Export deck` was the sixth and the figure was never re-measured.
 *
 * **What answered that measurement is the 2026-08-24 header** rather than a seventh argument about
 * wording. Six words became six glyphs with a word beside each: the two transfer buttons moved
 * into {@link TRANSFER}'s joined pair, the four that are left carry an icon, and each word is
 * dropped — never the control — as the column narrows (see {@link TIGHT_HEADER_PX}). Two selects
 * went with it, `Deck game` and `Deck format`, whose questions were already asked in Deck settings
 * and whose only job here was to be read; the ledger line below says which format the deck is on.
 * The row still wraps rather than overflows, and every control is reachable at every width —
 * nothing here is ever put behind a menu.
 */
interface HeaderAction {
  layer: NonNullable<Layer>;
  /** The accessible name, the tooltip, and — for {@link ACTIONS} — the word on the button. */
  label: string;
  Icon: LucideIcon;
}

/**
 * The two transfer buttons, drawn as one joined pair.
 *
 * **A pair rather than two loose buttons, because they are one idea read in two directions** —
 * cards into this deck, this deck out to a file — and joining them says so in the width of one
 * control and a hairline. The glyphs are lucide's own mirror pair, so the direction is the
 * picture rather than a word the reader has to find.
 *
 * **The visible word is shorter than the name, deliberately and legally.** `Import` and `Export`
 * are each contained in the accessible name beside them, which is what WCAG 2.5.3 asks for, and
 * the names are the ones {@link ACTIONS}' own doc argues at length. Both words disappear below
 * {@link WIDE_HEADER_PX}, where the buttons are their glyphs and the name is the tooltip.
 */
const TRANSFER: readonly HeaderAction[] = [
  { layer: { kind: "import" }, label: "Import cards", Icon: SquareArrowRightEnter },
  { layer: { kind: "export", categoryId: null }, label: "Export deck", Icon: SquareArrowRightExit },
];

const ACTIONS: readonly HeaderAction[] = [
  { layer: { kind: "categories" }, label: "Categories", Icon: Columns3Cog },
  { layer: { kind: "labels" }, label: "Labels", Icon: Tag },
  { layer: { kind: "history" }, label: "History", Icon: History },
  { layer: { kind: "settings" }, label: "Deck settings", Icon: Wrench },
];

/**
 * The three widths this header reasons about, measured on **the editor column** rather than on
 * the window — which is what `deskWidth` already is (see the observer that sets it), so nothing
 * new is measured and nothing new re-renders.
 *
 * The numbers are the column a window leaves once the sidebar, the shell's padding and the page
 * scrollbar are taken off: **1017** at the app's own 1280x800 with the rail expanded, 1157 with
 * it collapsed, 1657 at 1920, and **761** at the narrowest window the shell reasons about. So
 * {@link SETTINGS_ICON_PX} sits above the app's default and below the collapsed-rail width — the
 * longest word in the row, `Deck settings`, is the first to go — and {@link TIGHT_HEADER_PX} sits
 * between 761 and the default, which is where every remaining word goes and the toolbar splits in
 * two. {@link WIDE_HEADER_PX} is above 1157: `Import` and `Export` say themselves only where
 * there is room to spare.
 *
 * **Zero means unmeasured and reads as the middle**, which is `roomForPanel`'s convention one row
 * up: the first paint of a wide window must not flash a narrow header, and jsdom — which lays
 * nothing out and whose `ResizeObserver` never fires — draws the state every test is written
 * against.
 *
 * **Three rungs and not four, re-asked at a phone width on 2026-08-29** (with
 * {@link panelOverWidth}) and deliberately left where they are. A 390px window is a ~350px desk,
 * which is under {@link TIGHT_HEADER_PX} — so the ladder is already at its bottom rung there and
 * every word in the row has gone. A fourth rung could only drop **controls**, and which of the
 * six actions a deck may be edited without is a different question from which of them has room
 * for its word: the first is about what the header *holds* and belongs with whatever decides
 * what the ribbon sheds, and the second is what this ladder is. The row is `flex-wrap`, so what
 * a narrow desk costs is height rather than an overhang.
 */
const WIDE_HEADER_PX = 1400;
const SETTINGS_ICON_PX = 1100;
const TIGHT_HEADER_PX = 900;

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
   * Which of the desk's two columns the card pane is drawn **over** — see the pane host at the
   * end of the desk row, and {@link useAppStore}'s `paneFromDeckSearch` for why this is a field
   * of its own rather than `paneDeckContext !== null` read backwards.
   */
  const paneFromDeckSearch = useAppStore((s) => s.paneFromDeckSearch);

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
   * `"navigation"` is the bottom rung, so this fires only on a press nothing nearer wanted — the
   * card pane docked beside the desk is `"outer"` and outranks it, every dialog and popup here is
   * `"inner"` and outranks both, and a filter box with text in it spends the press before any of
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

  const [view, setView] = useState<DeckView>("stacks");
  // The two the deck row remembers, seeded from the same constants a stored word this build
  // cannot draw falls back to — so "never chosen" and "chosen and since dropped" are one state
  // rather than two. The restore below overwrites both the moment the row lands.
  const [groupBy, setGroupBy] = useState<GroupBy>(DEFAULT_GROUP_BY);
  const [sortBy, setSortBy] = useState<SortBy>(DEFAULT_SORT_BY);
  const [filter, setFilter] = useState("");
  const [labelIds, setLabelIds] = useState<readonly number[]>(NO_LABELS);
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
   */
  const { landed, markLanded } = useRecentAdds();

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

  const editorRef = useRef<HTMLElement>(null);
  /** The row the deck and the panel share, and the only width either of them can be judged
   *  against — the window's own is three layouts away from it. */
  const deskRef = useRef<HTMLDivElement>(null);
  /* There is no ref on the box the view draws into, and its absence is the 2026-08-14 change
     stated in one line: that box was the editor's scroller and the thing a drag auto-scrolled,
     and it is neither now — three of the four views grow to hold their content, the page takes
     the scroll, and the table's own scrollport is `VirtualTable`'s, one element further in than
     any ref here could reach. */
  /** The box the docked search panel is pinned inside — see {@link DeckEditor}'s dock effect. */
  const dockRef = useRef<HTMLDivElement>(null);
  /**
   * The box the card pane is drawn in — **placed and sized by the same effect the dock is**,
   * because it stands beside the dock and the two must never be measured a frame apart. See the
   * pane host, the first thing this column draws.
   */
  const paneFrameRef = useRef<HTMLDivElement>(null);
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
   * How wide the docked search panel is drawn, in px — **read here only to place the card pane
   * beside it**, never to decide anything about the panel itself.
   *
   * The width is the panel's own state (the reader drags it) and this component does not get to
   * know it any other way, so it is measured rather than passed: an editor that was *told* the
   * panel's width would be a second copy of a number the panel clamps twice, and the two would
   * disagree the first time a drag was refused. A measurement cannot disagree with what is drawn.
   *
   * `0` is jsdom, which has no layout engine, and is read below as "not measured" rather than as
   * a panel of no width — the pane then falls back on its own 384 and is laid out by nothing,
   * which is the honest answer on a surface with no layout at all.
   */
  const [dockWidth, setDockWidth] = useState(0);
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
  const clearCategory = deck.clearCategory.mutate;
  const clearPending = deck.clearCategory.isPending;
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

  /**
   * What "More labels…" offers: every label the reader owns, minus the ones the context menu
   * has already listed.
   *
   * **The subtraction is here because this is the only place holding both halves.**
   * `deck.labels` is what this deck and variant wears, carried in with `deck_get`;
   * `meta.allLabels` is the
   * app-wide list, off a command that takes no deck at all. Neither knows about the other, and
   * a dialog handed both would be a dialog re-deriving the menu's own rule.
   *
   * The app-wide list's order survives the filter — most-used first — because `filter` keeps
   * it, which is the ordering the issue asks for and the reason nothing sorts here.
   */
  const wornHere = deck.labels;
  const allLabels = meta.allLabels;
  const addLabelChoices = useMemo(() => {
    const worn = new Set(wornHere.map((t) => t.id));
    return allLabels.filter((t) => !worn.has(t.id));
  }, [allLabels, wornHere]);

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
  const bannerFailure = writeFailure(writes) ?? undo.error ?? pressReadFailure;

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
    return `${named} is already filed under ${refileAnswer.category}.`;
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
   * Declared in front of the memo that reads it rather than beside the callback that writes it,
   * because a `useMemo` runs during the render it is written in and a `const` below it is a
   * temporal-dead-zone throw.
   */
  const [localCategoryOrder, setLocalCategoryOrder] = useState<number[] | null>(null);

  const categories = useMemo(() => {
    const rows = deck.categories;
    if (localCategoryOrder === null) return rows;
    const byId = new Map(rows.map((c) => [c.id, c]));
    // **`sortOrder` is re-stamped from position, and that is not decoration.** `buildGroups`
    // sorts by it — handing it an array in the right order and the old numbers would change
    // nothing on the desk at all. Every other consumer of this array (the `Move to` submenu,
    // deck settings' "Add cards to", the quick zones) reads it in array order and gets the same
    // answer either way.
    const picked = localCategoryOrder.flatMap((id, index) => {
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
  const reorderCategories = meta.reorderCategories.mutate;
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
      setLocalCategoryOrder(next);
      reorderCategories(next, { onError: () => setLocalCategoryOrder(null) });
    },
    [reorderCategories],
  );

  /** The pile a right-click aimed the importer at, or nothing for the toolbar's own press. */
  const forcedCategoryName = layer?.kind === "import" ? layer.forcedCategoryName : undefined;

  /**
   * The one destination this surface offers: the deck that is open.
   *
   * **Memoised on identity alone, because what comes back is a component identity** — a new one
   * each render would remount the preview step and take the reader's commander choice with it,
   * and a *presentational* value in this dependency list (the copy count used to be one) would
   * do the same on any refetch. The three facts here are all "which deck, which list": an import
   * lands in one variant and a `replace` clears at most one, so a paste made while Theory is up
   * must never touch what is sleeved. Everything the preview has to draw — the deck's name, the
   * count a `replace` would clear — it reads from the same `deck_get` this screen is reading.
   */
  const importInto = useMemo<ImportDestination>(
    () => deckDestination({ deckId, variant, forcedCategoryName }),
    [deckId, variant, forcedCategoryName],
  );

  /**
   * Choosing "a new deck" from inside an editor that is already open on a different one leaves
   * that new deck invisible: nothing on screen names it, and this editor stays put showing the
   * deck the reader started on. `onImported` is `DecksPage`'s own answer to the identical
   * question — open the deck the list became — reused rather than reinvented; `setOpenDeckId`
   * is what makes this editor a different `deckId` prop on the next render.
   */
  const onNewDeckImported = useCallback(
    (newDeckId: number) => setOpenDeckId(newDeckId),
    [setOpenDeckId],
  );
  /** **Memoised for `importInto`'s reason**: `Preview` is a component identity, and a fresh one
   *  each render would remount the new-deck step and take the reader's typed name with it. */
  const importIntoNewDeck = useMemo<ImportDestination>(
    () => ({
      ...newDeckDestination,
      Preview: (props) => <NewDeckPreview {...props} onImported={onNewDeckImported} />,
    }),
    [onNewDeckImported],
  );

  /** The pile the delete confirmation is about, read from the **live** list — a rename made
   *  under the open question retitles it, and a delete from another surface empties it. */
  const deletedCategory =
    layer?.kind === "deleteCategory"
      ? (categories.find((c) => c.id === layer.categoryId) ?? null)
      : null;

  /** The pile the clear confirmation is about, from the **live** list for `deletedCategory`'s
   *  reason and one of its own: this dialog quotes `cardCount`, so a card added under the open
   *  question has to be in the number the reader presses through. */
  const clearedCategory =
    layer?.kind === "clearCategory"
      ? (categories.find((c) => c.id === layer.categoryId) ?? null)
      : null;

  /**
   * What the export dialog draws — {@link exportSubject}, which is pure and carries the whole of
   * the reasoning.
   *
   * **The id is what the memo keys on, and it is three-valued on purpose**: `undefined` is a
   * closed dialog, `null` is the whole deck and a number is one pile. Building an
   * {@link ExportScope} out here and depending on *that* would hand the memo a fresh object every
   * render and recompute the filter on each one, which is the entire thing a memo over the deck's
   * card list is for.
   */
  const exportedId = layer?.kind === "export" ? layer.categoryId : undefined;
  const exported = useMemo(
    () =>
      exportSubject(
        exportedId === undefined
          ? null
          : exportedId === null
            ? { kind: "deck" }
            : { kind: "category", categoryId: exportedId },
        categories,
        deck.cards,
        row?.name ?? "",
      ),
    [exportedId, categories, deck.cards, row?.name],
  );

  // A deck deleted under an open layer takes its trigger with it — but not the state that says
  // one is open, and an `"inner"` layer nothing draws is a layer that eats the first Escape of
  // whatever the reader does next. Reset during render (`CardDetailPane`'s face, `Cover`'s art).
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

  // How much room the two things on the desk have between them. A window resize changes it, and
  // so does the card pane opening and closing beside the whole view — neither of which this
  // component would otherwise hear about, which is why it is an observer and not a prop
  // (`CardGrid`'s arrangement). Re-run when the deck lands, because the element being measured
  // does not exist until then.
  const hasRow = row !== null;
  //
  // The window's own width is read in the same callback rather than through a second listener:
  // this row is `flex-1` inside the page, so nothing can change the window's width without
  // changing the desk's, and one observer answering both keeps the two numbers from being a
  // frame apart.
  useEffect(() => {
    const el = deskRef.current;
    const dock = dockRef.current;
    if (!el || !dock) return;
    const measure = () => {
      setViewport(document.documentElement.clientWidth);
      setDeskWidth(el.clientWidth);
      // `offsetWidth` rather than a `contentRect`: what the pane has to be placed beside is the
      // panel's **border box**, hairline and all, and the rail state has a border of its own.
      setDockWidth(dock.offsetWidth);
    };
    // Both boxes, and neither is redundant. The desk resizes when the window does; the dock
    // resizes when the reader drags the panel's edge or collapses it, which moves nothing else
    // on this row. `entry` is deliberately not read any more — with two observed elements the
    // callback fires for either, so the widths are taken off the elements themselves rather than
    // off whichever one happened to trigger this call.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(dock);
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
   * **The placement is issue #183's, reused.** The card pane already draws over one of this
   * row's two columns rather than taking width from either; this is that arrangement at the one
   * width where the deck and the panel cannot both be on screen. The panel positions itself
   * inside its own dock, which is `sticky` and therefore already the box it needs — so what it
   * is missing, and all it is missing, is this number.
   *
   * **Never while a card is open, and that is a paint-order fact rather than a preference.** The
   * pane and this overlay would both be covering the deck, and the pane is drawn from a `sticky`
   * host *earlier* in this scroller at the same `LAYER.popup` — equal z-indexes resolve by
   * document order, so an overlay raised enough to beat the deck's own `LAYER.raised` also beats
   * the pane, and a tile pressed in the search would open a card behind the search. One surface
   * at a time is the honest answer at 390px anyway, and it is the phone's own idiom: the list
   * steps aside for the thing you tapped and is there again when you come back — `open` is
   * untouched and the body is hidden rather than unmounted, exactly as a railing already does.
   * The refusal the reader then sees on the rail is `NO_ROOM`, whose first remedy is *close the
   * card details*, which is now literally the thing to do.
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
   * `sticky top-0` is the pinning and CSS does all of it; the height is the part CSS cannot
   * answer. `100%` of this row is the deck's height, and a viewport unit is wrong by the app
   * chrome above the scroller — so the number is measured: the scroller's visible height, less
   * however much of the desk row still sits below its top. Scrolled past, that term is zero and
   * the panel is the full height of the window; at rest it is the window under the header, which
   * is where the panel is drawn anyway. Both ends exact, and no second scrollbar in either.
   *
   * `useLayoutEffect` rather than `useEffect`: the panel's wall is a `min-h-0 flex-1` child, so
   * an unsized dock draws it at nothing, and after paint is one frame too late to avoid the
   * reader seeing that. **jsdom has no layout engine and answers `0` to every one of these
   * reads**, which is why a zero height is left unset rather than written — a `height: 0px` here
   * would be a real collapse in the one environment that cannot see it.
   *
   * The rAF is coalescing, not animation: a scroll fires far more often than a frame, and the
   * work is two `getBoundingClientRect`s. The observer covers a window resize and the card pane
   * opening beside the editor; a scroll covers everything the reader does. The one gap is the
   * refusal banner growing in above the desk, which moves the row's top without resizing either
   * observed box — worth ~34px for the length of one animation, on a surface that has just
   * refused a write.
   */
  useLayoutEffect(() => {
    const page = editorRef.current;
    if (!page) return;

    let frame = 0;
    const size = () => {
      frame = 0;
      const visible = page.clientHeight;
      if (visible === 0) return;
      // **Where the desk starts is what both boxes are measured from**, and it is read fresh
      // rather than closed over: the deck may not have arrived yet, and a refused write may take
      // it away again while the pane over it is still up.
      const deskEl = deskRef.current;
      const below = deskEl
        ? deskEl.getBoundingClientRect().top - page.getBoundingClientRect().top
        : 0;
      const top = Math.max(0, below);
      const height = Math.max(0, visible - top);
      // The dock is inside the desk row and shares its left edge with the panel, so it needs
      // only the height; the pane's frame is pinned to the top of the *page* and needs the
      // offset as well. **One read for both**, which is the whole reason they are written here
      // together: two measurements a frame apart would draw the search column and the card
      // beside it at different heights on every scroll.
      if (dockRef.current) dockRef.current.style.height = `${height}px`;
      if (paneFrameRef.current) {
        paneFrameRef.current.style.top = `${top}px`;
        paneFrameRef.current.style.height = `${height}px`;
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(size);
    };

    size();
    page.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(page);
    // The desk only when it is drawn. Everything else this effect answers for — the window
    // resizing, the page growing — reaches it through `page`, and `hasRow` re-runs the whole
    // effect when the deck arrives or goes, which is what re-observes this.
    if (deskRef.current) observer.observe(deskRef.current);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      page.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [hasRow]);

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
  // **`setLabel` rides in through `writes`** and is live coverage for the same reason: nothing
  // in the app could reach it until that menu, and every one of the four views can now.
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

  /**
   * **Any other write to the deck throws the redo stack away**, which is the ordinary undo
   * contract: once the reader has edited past a branch, the branch is gone.
   *
   * Keyed on the newest *successful* write across the whole refused-write family plus the two
   * mutations that sit outside it, rather than on a call inside each mutation's `onSuccess` —
   * there are a dozen of those, they live in two hooks, and two of them are borrowed whole by
   * surfaces outside this editor. One effect over `newestWrite` is the same list the banner
   * already reads, so a write added to that array is covered here for free.
   */
  const succeededAt = lastOfAny.isSuccess ? lastOfAny.submittedAt : 0;
  const clearRedo = undo.clearRedo;
  useEffect(() => {
    if (succeededAt) clearRedo();
  }, [succeededAt, clearRedo]);

  /**
   * Undo and redo, on `window` for the length of this editor.
   *
   * **The chords are the catalogue's** — {@link UNDO} and {@link REDO}, `deckEditor`'s entries in
   * `src/lib/shortcuts.ts` — rather than comparisons written out here, so the key map cannot
   * advertise a chord this handler does not bind. `redo` carries more than one spelling and this
   * site does not know how many; the argument for the pair is written at that entry, where the
   * chords are, and a spelling added there is bound with no edit here.
   *
   * **It yields inside a text field**, which is the whole of what keeps the quick-add box, the
   * deck name and the notes usable: those get the browser's own undo, which this cannot
   * replace and must not swallow. That yield stays at this call site rather than moving into
   * the matcher, because it is a fact about *this* binding — `Ctrl+1` has no native meaning in
   * a field, and yielding there would kill view-switching exactly where the caret usually is.
   * `isTextField` is `useContextMenu`'s — the same predicate the native-context-menu carve-out
   * already turns on, rather than a second spelling of "is the caret in something typed".
   *
   * **The match runs first and the caret test second**, which is the `Delete` handler's order one
   * screen down and the *inverse* of `useContextMenu.ts:119`'s. Both orders are the same rule —
   * pay for the cheap half first — read against two different expensive halves: there the item
   * list is built on every press and `isTextField` is the cheap guard, here matching two chords
   * is arithmetic over an event and `isTextField` is a `closest()` walk up the DOM. Tested first
   * it walked the tree on every keystroke typed into the quick-add box, for the two presses in a
   * session that are `Ctrl+Z`.
   *
   * There is no modifier pre-check left: `matchesChord`, which `src/lib/shortcuts.ts` builds
   * {@link matchesShortcut} out of, is exact in both directions — so an unlisted modifier is
   * already a non-match and a guard for it would be a second, looser statement of the same rule.
   */
  const runUndo = undo.runUndo;
  const runRedo = undo.runRedo;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const run = matchesShortcut(UNDO, e) ? runUndo : matchesShortcut(REDO, e) ? runRedo : null;
      if (run === null) return;
      if (isTextField(e.target)) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runUndo, runRedo]);

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
   * **Pull from collection** — the one layer opened from the stats band at the foot of the page.
   *
   * **The hand-back is read off `document.activeElement`**, which is `openAddTag`'s answer rather
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
  const pullPlan = usePullPlan(deckId, layer?.kind === "pull");

  /** The one card an open pull is about, or `null` for the deck-wide press. */
  const pulledCard = layer?.kind === "pull" ? (layer.card ?? null) : null;

  /**
   * What the pull dialog draws: the whole plan, or the rows for one card.
   *
   * **The narrowing is here rather than in the dialog**, which is that component's own fence —
   * it holds no notion of a {@link pullKey} and therefore cannot come to disagree with this
   * about which rows belong to which card. And it is derived from the **live** query rather
   * than frozen into the layer, so a pull made from the dialog re-reads the plan and the rows
   * under the reader's eyes are the rows a second press would write.
   *
   * `pullKey` is `(cardId, finish)`, which is the grain the plan is folded to — the same card
   * short in two piles is one row of it — so a deck card's key matches at most one row and the
   * filter is a lookup rather than a subset.
   */
  const pulledRows = useMemo(() => {
    const rows = pullPlan.data;
    if (rows === undefined) return null;
    if (pulledCard === null) return rows;
    const wanted = pullKey(pulledCard);
    return rows.filter((planRow) => pullKey(planRow) === wanted);
  }, [pullPlan.data, pulledCard]);

  /** The press {@link QuickUnwishDialog} is asking about — the card, the count and the wishes,
   *  all frozen at the press. See the arm's own doc for why none of the three is looked up. */
  const unwish = layer?.kind === "quickUnwish" ? layer : null;

  /**
   * The refusal that dialog draws **inside its own panel** — and it is narrowed to the write the
   * dialog itself made.
   *
   * One mutation serves all three `Collection ▸` rows, so `isError` alone is the *last* quick add
   * of any kind: a refused `Quick add 4 copies` would still be standing when the reader opened
   * this question on some other card a minute later, and the panel would greet them with a red
   * sentence about a press they had already been told about in the banner. The mutation's own
   * `variables` are what tell the two apart — this dialog is the only presser that sends both a
   * `wishId` and *this* card — and reading them is a derivation rather than a `reset()`, which
   * would take the banner's memory of that earlier refusal away with it.
   */
  const unwishVariables = deck.quickAddToCollection.variables;
  const unwishFailure =
    unwish !== null &&
    deck.quickAddToCollection.isError &&
    unwishVariables !== undefined &&
    unwishVariables.wishId !== null &&
    unwishVariables.card.cardId === unwish.card.cardId
      ? ipcError(deck.quickAddToCollection.error)
      : null;

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

  /**
   * **Quick add N copies** — record what this row is short of into the deck's own group, and ask
   * nothing.
   *
   * No read and no dialog, which is what makes it the simplest of the three: the count arrives
   * from the menu (it is `quickAddShort` over the row that was right-clicked, so it is exactly
   * the `3/4` the card is wearing) and `wishId: null` says this press is not about the wishlist
   * at all. A reader who wanted the wishlist half pressed the row below it.
   */
  const quickAdd = useCallback(
    (card: DeckCard, copies: number) => {
      setPressReadFailure(null);
      writeQuickAdd({ card, quantity: copies, wishId: null });
    },
    [writeQuickAdd],
  );

  /**
   * **Quick add N and remove from wishlist** — the same record, then take the copies off a wish
   * that was asking for this exact printing.
   *
   * **A prompt only when the answer is ambiguous**, which is `chooseWish`'s whole job and
   * deliberately not this callback's: no matching wish and one matching wish both write straight
   * through, because a dialog with nothing to decide is a dialog that made the reader press
   * twice. Two or more open {@link QuickUnwishDialog}, because which of two lists a purchase
   * satisfies is a thing only the reader knows.
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
   */
  const quickAddAndUnwish = useCallback(
    (card: DeckCard, copies: number) => {
      const opener = document.activeElement;
      const handBack = () => {
        if (opener instanceof HTMLElement) opener.focus();
      };
      setPressReadFailure(null);
      void (async () => {
        let wishes: DeckQuickAddWish[];
        try {
          wishes = await queryClient.fetchQuery(quickAddWishesQuery(card.cardId, card.finish));
        } catch (error) {
          setPressReadFailure(ipcError(error));
          return;
        }
        const choice = chooseWish(wishes);
        if (choice.kind === "many") {
          openLayer({ kind: "quickUnwish", card, copies, wishes: choice.wishes }, handBack);
          return;
        }
        writeQuickAdd({
          card,
          quantity: copies,
          wishId: choice.kind === "one" ? choice.wish.id : null,
        });
      })();
    },
    [openLayer, queryClient, writeQuickAdd],
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
   */
  const pullCard = useCallback(
    (card: DeckCard) => {
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
        const choice = choosePull(rows, card);
        if (choice.kind === "take") {
          writePull(choice.picks);
          return;
        }
        openLayer({ kind: "pull", card }, handBack);
      })();
    },
    [deckId, openLayer, queryClient, writePull],
  );

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
  const writeLabel = deck.setLabel.mutate;
  const writeFinish = deck.setCardFinish.mutate;

  /**
   * One copy into a category — the quick add's write, and a drop's.
   *
   * `categoryId` may be {@link AUTO_CATEGORY}, in which case the card's own type line goes
   * instead and `useDeck`'s `addCard` names the pile (`autoCategoryFor`). A drop always passes a
   * real id — pointing at a column is naming one — so the auto arm is the click path's alone,
   * and a caller with a real id may pass no type line at all.
   *
   * **The per-call `onSuccess` is where the landed mark comes from, and it has to be per call.**
   * The mutation's own `onSuccess` is `useDeck`'s invalidate and belongs to every surface that
   * borrows the hook — the sidebar's drop target adds to a deck with no editor on screen. What
   * is wanted here is the *row* the add answered with, which is the one thing only the caller
   * can do something with. TanStack runs both, the definition's first.
   */
  const addTo = useCallback(
    (
      cardId: string,
      categoryId: number,
      typeLine?: string | null,
      /*
       * **An `owned` argument stood here until 2026-08-25**, passed by the two callers the
       * own/need pair named — the quick-add field and the docked panel's Add button — and
       * absent at every drop, because a drag is a gesture about a card that is already
       * somewhere. With the pair deleted every add means the same thing, so there is nothing
       * left to say on the way past. See {@link DeckSearchPanelProps}.
       */
    ) =>
      writeAdd(
        categoryId === AUTO_CATEGORY
          ? { cardId, typeLine: typeLine ?? null, quantity: 1 }
          : { cardId, categoryId, quantity: 1 },
        // **`change.id` is the `deck_cards` row this write landed in**, which the editor marks
        // for five seconds so the reader can find it in a deck they are not looking at. It was
        // tested against a `NO_DECK_ROW` floor until 2026-08-25: the `own` add went through
        // `collection_to_deck`, whose `deckCardId` is nullable on the wire, and a `null` arrived
        // here as `0` — a row id no card has, armed against a timer. Every add is `deck_add_card`
        // now and it answers the row it wrote.
        { onSuccess: (change) => markLanded(change.id) },
      ),
    [writeAdd, markLanded],
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
  /*
   * **`panelAdd` stood here from 2026-08-23 to 2026-08-25 and is gone with the own/need pair.**
   *
   * It was `deck.addCard` with `owned: addMode === "own"` folded into every `mutate` on the way
   * past — a wrapper rather than a prop, because the docked panel presses the mutation itself and
   * this component could not reach into that call. With no control over the mode there is nothing
   * to fold: every add from that panel writes a `deck_cards` row and claims nothing about the
   * reader's cardboard, which is what `DEFAULT_ADD_MODE` already meant. The panel takes
   * `deck.addCard` unwrapped, and moving a copy the reader owns into the deck is the Collection
   * tab's `collection_to_deck` — a different command, with a confirmation that names the deck a
   * spoken-for copy would come out of.
   */

  const owedFocus = useRef<number | null>(null);
  const handOffTo = useCallback((categoryId: number) => {
    owedFocus.current = categoryId;
    if (!focusDeckGroup(categoryId)) editorRef.current?.focus();
  }, []);
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
  const cardSelection = useAppStore((s) => s.cardSelection);
  const pickedCards = useMemo(() => {
    const scope = `deck:${deckId}`;
    if (cardSelection === null || cardSelection.scope !== scope) return [];
    const bySlot = new Map(
      cards.map((card) => [deckCardSlot(card.categoryId, card.cardId, card.finish), card]),
    );
    return cardSelection.keys.flatMap((slot) => {
      const card = bySlot.get(slot);
      return card ? [card] : [];
    });
  }, [cardSelection, cards, deckId]);

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
  useEffect(() => {
    const owed = owedFocus.current;
    if (owed === null) return;
    owedFocus.current = null;
    focusDeckGroup(owed);
  }, [cards]);

  /**
   * **The app's one removal path**, and since schema v25 that is a statement about the reader's
   * *cards* rather than about a list. The stepper stepped to zero, the card menu's `Remove card`
   * and the remove tray under the deck all arrive here, and on the **Live** list a decrease is
   * the write that files the copies the deck's group was holding into `Recently removed`
   * ({@link CUT_CARDS_NOTE}, the standing sentence on the price line).
   *
   * The row is looked up here rather than in the hook, and the reason is the ordering: TanStack
   * runs `onMutate` before the write, `onMutate` takes the row out of the cache optimistically,
   * and `deck_to_collection` addresses `deck_cards.id` and takes a *delta* — so the id and the
   * copies it currently holds have to travel with the press. See {@link CutFrom}.
   *
   * The finish is part of the `find` for the reason it is part of the write: a pile can hold this
   * printing twice, and stepping the foil row must not read the regular one's number. A row that
   * is not there is not an error — a drag can outlive the list it started in — and it falls back
   * to the absolute write, which is what every list did before the group existed.
   */
  const setQuantityAt = useCallback(
    (cardId: string, categoryId: number, finish: DeckFinish, quantity: number) => {
      // Zero takes the card out from under the caret — optimistically, so it happens on the
      // press — and the control the caret was on goes with it. Before the write, because the
      // card is gone by the time an answer arrives.
      if (quantity === 0) handOffTo(categoryId);
      const row = cards.find(
        (c) => c.cardId === cardId && c.categoryId === categoryId && c.finish === finish,
      );
      writeQuantity({
        cardId,
        categoryId,
        finish,
        quantity,
        held: row ? { deckCardId: row.id, quantity: row.quantity } : undefined,
      });
    },
    [cards, writeQuantity, handOffTo],
  );

  const moveTo = useCallback(
    (cardId: string, from: number, to: number, finish: DeckFinish) => {
      writeMove(
        { cardId, from, to, finish },
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
   * The quick zones' `Auto`, for a card the deck already holds: file it again by what it *does*.
   *
   * **The row is looked up here rather than carried in the drag**, which is `dnd.ts`'s decision
   * and is written out there: a `deck-card` payload is an address into a list this component is
   * already drawing, so the type line and the pile's name are one `find` away and a copy in the
   * payload would be the thing that goes stale. Addressed by the slot — `cardId` and the category
   * it is in — like every other write in this feature.
   *
   * A row that is not there is not an error and not a write: a drag can outlive the list it
   * started in (a filter, a refetch, another surface's delete), and nothing about failing to
   * re-file a card that is gone is worth a sentence.
   */
  const refileWrite = deck.refileCard.mutate;
  const refile = useCallback(
    (cardId: string, from: number, finish: DeckFinish) => {
      // The finish is part of the `find` for the reason it is part of the write: a pile can
      // hold this printing twice, and the two rows share a type line but not a slot.
      const card = cards.find(
        (c) => c.cardId === cardId && c.categoryId === from && c.finish === finish,
      );
      if (!card) return;
      refileWrite(
        { cardId, from, finish, typeLine: card.typeLine, categoryName: card.categoryName },
        {
          // The caret follows the card to the pile that now has it, which announces that pile's
          // name — the same hand-off a drag onto a heading makes, and the only feedback a move
          // needs. When nothing moved there is nowhere to send it, and the sentence below is
          // what says so instead.
          onSuccess: ({ moved, categoryId }) => {
            if (moved && categoryId !== null) handOffTo(categoryId);
          },
        },
      );
    },
    [cards, refileWrite, handOffTo],
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
      // The quick zones' `Auto`, and the same call the toolbar's `Add to → Auto (by what it
      // does)` makes: the type line goes and the pile does not, because `useDeck.addCard` names
      // it. The one drop in this editor that points at no column — see {@link QuickZones}.
      else if (write.write === "auto-add") addTo(write.cardId, AUTO_CATEGORY, write.typeLine);
      // The same zone for a card the deck already holds, and the same rule — see {@link refile}.
      else if (write.write === "auto-refile") refile(write.cardId, write.from, write.finish);
      else if (write.write === "move") moveTo(write.cardId, write.from, write.to, write.finish);
      else setQuantityAt(write.cardId, write.categoryId, write.finish, 0);
    },
    [addTo, moveTo, refile, setQuantityAt],
  );

  /**
   * A whole drop — **every card it was carrying** (issue #214), and the picked set stood down
   * afterwards.
   *
   * One write per card rather than a batched command, and that is a cost this feature accepts
   * rather than hides. Each `mutate` is its own `deck_audit` row, so a four-card move is four
   * entries and four presses of Ctrl+Z to reverse. Batching would be a Rust change to `deck_undo`
   * — a grain the audit log does not have — and it is worth having the gesture before the tidier
   * undo rather than neither.
   *
   * **The set is cleared once the drop is applied.** The cards have moved, so a set still
   * pointing at where they *were* is a set whose next drag carries slots that no longer exist —
   * `pruneSelection` would empty it on the next render anyway, and clearing here is what stops
   * the ring standing on a pile the cards have left for the frame in between.
   */
  const applyDrops = useCallback(
    (writes: DeckWrite[]) => {
      for (const write of writes) applyDrop(write);
      if (writes.length > 1) setCardSelection(null);
    },
    [applyDrop, setCardSelection],
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
      writeLabel({
        cardId: card.cardId,
        categoryId: card.categoryId,
        finish: card.finish,
        labelId,
      }),
    [writeLabel],
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
   */
  const deckCardMenu = useCallback(
    (card: DeckCard) => {
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
          categories,
          cards: deck.cards,
          spec,
          moveTo: moveCardTo,
          setLabel: setCardLabel,
          setFinish: setFinishAt,
          labels: deck.labels,
          addLabel: openAddLabel,
          remove: removeCard,
          // **The `Collection ▸` submenu's three rows** (2026-09-03, issue #350). All three are
          // callbacks and none of them is a mutation, which is this builder's contract — and
          // here it is load-bearing rather than ceremonial: two of the three *read* before they
          // write, and one of those two ends in a dialog rather than in a write at all, so
          // "which write does this row make" is a question with no single answer.
          //
          // **Passed on both lists, and the theory one is greyed rather than absent.** That is
          // `quickAddBlock`'s call and not this file's: a plan holds no cards, so a theory row
          // can neither record copies nor pull any — but every card of this surface can be
          // short, so a submenu that simply vanished on one tab would read as a bug rather than
          // as a refusal. The row says `a plan holds no cards` instead. The stats band's
          // deck-wide `onPull` is `null` there for a different reason and stays so: that button
          // has a *question* to lose, where these rows have an answer to give.
          quickAdd,
          quickAddAndUnwish,
          pullCard,
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
      quickAdd,
      quickAddAndUnwish,
      pullCard,
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
    ],
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
    (card: CardSummary, picked: readonly CardSummary[] = []) => () =>
      buildCardMenu(searchCardTarget(card), {
        ...cardMenuDeps,
        picked: picked.map(searchCardTarget),
      }),
    [cardMenuDeps],
  );
  const panelCardMenu = useCallback(
    (card: CardSummary, picked: readonly CardSummary[] = []) => menu(panelCardBuild(card, picked)),
    [menu, panelCardBuild],
  );
  /** The keyboard's own door to the same rows. `CardGrid` takes it in a slot of its own because
   *  a keypress has no coordinates — the panel is anchored at the tile's corner rather than at a
   *  pointer that was never there. */
  const panelCardMenuKey = useCallback(
    (card: CardSummary, picked: readonly CardSummary[] = []) => menuKey(panelCardBuild(card, picked)),
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
  /**
   * The pane's ✕ and its Escape, which are the same act — closing the card and forgetting the
   * row it was anchored to, exactly as {@link dropSelection} below does for a click on the desk.
   *
   * Stable, because it is the pane's `onClose` and therefore a dependency of the `keydown`
   * listener behind it: an inline arrow is a new function on every render of this editor — every
   * keystroke in the deck's filter box, every optimistic patch — and each one tears that window
   * listener down and adds it back for no change in behaviour. `App` holds the identical
   * `useCallback` for the identical reason, one mount over.
   */
  const closeCard = useCallback(() => setSelectedCardId(null), [setSelectedCardId]);

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
  // own element** (`editorRef`), moved there on 2026-08-14 with the growing desk: three of the
  // four views have no scroller of their own, so the box that has to move to bring a pile — or
  // the remove tray under the deck — under the pointer is the editor's. The scroller the library
  // now finds is `AppShell`'s `main`, which is the one scroller left in this view since
  // 2026-08-24 and is the ancestor the old registration was reaching for through the page. The
  // table's own `VirtualTable` scroller was never registered and now *is* a candidate, which is
  // a behaviour change no jsdom test can see: it measures rectangles.

  /** The deck's new name, once {@link DeckNameField} has decided there is one. The field holds
   *  the draft and refuses a blank or an unchanged name, so there is nothing to re-check here —
   *  this is the same `deck.update` the format select and the `Split X` chip ride. (It named the
   *  Built switch until schema v25 dropped `decks.is_built` along with the allocator the word
   *  meant something to.) */
  const renameDeck = useCallback(
    (name: string) => {
      deck.update.mutate({ name });
    },
    [deck.update],
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
  const theoryMatches = useMemo(
    () =>
      theoryEnabled && variant === "live"
        ? theoryMatchPlan(planned.data, deck.cards)
        : undefined,
    [planned.data, theoryEnabled, variant, deck.cards],
  );

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
    if (!needle && labelIds.length === 0) return deck.cards;
    return deck.cards.filter(
      (card) =>
        (labelIds.length === 0 || (card.labelId !== null && labelIds.includes(card.labelId))) &&
        (!needle ||
          card.name.toLowerCase().includes(needle) ||
          (card.typeLine ?? "").toLowerCase().includes(needle)),
    );
  }, [deck.cards, filter, labelIds]);

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

  const groups = useMemo(
    // No currency any more: the rows this groups arrived priced at the selected marketplace,
    // because that marketplace is in `useDeck`'s query key. A switch therefore changes
    // `deck.cards` itself and this recomputes over the new answer, rather than picking a
    // different field out of the old one.
    () => buildGroups(shown, categories, groupBy, sortBy, separateX, emptyGroupRules),
    [shown, categories, groupBy, sortBy, separateX, emptyGroupRules],
  );

  /**
   * The same deck as a **walk** — every drawn row, in the order the desk draws it — published to
   * the store so the printings modal's left/right keys can step through the deck behind it.
   *
   * It goes through the store because `AllPrintingsDialog` is mounted at `App` level, a sibling
   * of the shell, so there is no context between here and there; and it is published from here
   * rather than derived there because {@link groups} is the only place this order exists.
   * `groupBy` and `sortBy` are this component's `useState`, and the rows are `shown` — the deck
   * narrowed by the toolbar's text box and label chips. Nothing outside this file can reconstruct
   * any of that.
   *
   * **What it costs, since the input recomputes on every keystroke in that box.** `groups` is a
   * new array per letter typed, so this is a new array of ~100 lean objects per letter and a
   * `set` on the store. That is noise beside `buildGroups` itself, which runs on the same
   * keystroke over the same rows and does strictly more — a sort per pile and a price sum per
   * heading. The part worth being careful about is not the arithmetic but the **write**: a
   * zustand `set` re-runs every subscriber's selector, and the modal is the only thing in the
   * app that selects `cardWalk`. It is shut nearly always, and shut it draws nothing, so an
   * ordinary keystroke here costs one selector call and one `Object.is`. That stays true only
   * for as long as this field has one reader — a component that selected the walk to decide
   * something *else* would turn typing in a deck's filter into a re-render of a surface that has
   * nothing to do with the deck.
   *
   * Memoised so that a render which changed none of the inputs does not rewrite the store at
   * all: without it every unrelated re-render of this component — a hover on a stack, a mutation
   * settling — would publish an identical walk under a new identity and re-render the modal.
   */
  const deckWalk = useMemo(() => deckWalkStops(groups, deckId), [groups, deckId]);

  // Published through the same hook the three card lists use, which is also where the two-effect
  // shape this needs — publish on change, clear once on unmount — is written down and argued.
  // `the deck` is what the modal's chevrons say they are stepping along.
  usePublishCardWalk("the deck", deckWalk);

  /**
   * Every finding, filed under each card it names, so a view can mark a card.
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
    () => (spec ? violationsByCard(validateForMarks([...deck.cards], spec)) : undefined),
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
   */
  const targetCategoryId =
    row !== null && categories.some((c) => c.id === row.defaultCategoryId)
      ? row.defaultCategoryId
      : AUTO_CATEGORY;

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
   * The deck's rows as a flat list of slots, in the order the desk draws them — what a
   * Shift-click measures a range along (issue #214).
   *
   * `deckSlotOrder` and not `deckWalk` beside it, though the two walk the same groups in the same
   * order: the walk drops orphaned rows because it steps *through printings*, and an orphan is
   * still a card the reader can see and pick. A range that silently skipped a row on screen is
   * the one failure this list cannot have.
   */
  const slotOrder = useMemo(() => deckSlotOrder(groups), [groups]);

  /**
   * The cards the reader has Ctrl- and Shift-clicked, scoped to **this deck**.
   *
   * A deck id in the scope because two decks are two surfaces: the slots are
   * `<category>:<card>:<finish>` and a category id is per-deck, so a set carried across a close
   * and an open would address piles of a deck that is no longer on screen.
   */
  const picked = useCardSelection(`deck:${deckId}`, slotOrder);

  /**
   * What a card's drag asks the selection — {@link DeckCardGroupDrag}, held still on purpose.
   *
   * Both live values it reads come off refs, which is what lets this object keep one identity for
   * the life of the editor: it lands in every card's `useDeckCardDrag` dependency list, and a
   * fresh one per render would tear four hundred drag registrations down each time the reader
   * Ctrl-clicked — a source unregistering mid-gesture is a drop that never arrives.
   *
   * `dragsAll` is asked first and has a side effect by design: a card picked up from *outside* the
   * set throws the set away, so a stray drag can never rearrange cards the reader had forgotten
   * were picked.
   */
  const dragsAllRef = useRef(picked.dragsAll);
  useEffect(() => {
    dragsAllRef.current = picked.dragsAll;
  }, [picked.dragsAll]);
  const groupDrag = useMemo<DeckCardGroupDrag>(
    () => ({
      rest: (slot) => {
        if (!dragsAllRef.current(slot)) return [];
        return pickedRef.current
          .filter((card) => deckCardSlot(card.categoryId, card.cardId, card.finish) !== slot)
          .map(
            (card): DragPayload => ({
              kind: "deck-card",
              cardId: card.cardId,
              name: card.name,
              fromCategoryId: card.categoryId,
              finish: card.finish,
            }),
          );
      },
    }),
    [],
  );

  /**
   * **The catalogue's `remove` takes the picked cards out of the deck** — issue #214, and the one
   * keyboard verb this editor has that is not undo. The chord is {@link REMOVE}, `deckEditor`'s
   * `remove` entry in `src/lib/shortcuts.ts`, rather than a comparison written out here, so the
   * key map cannot advertise a chord this handler does not bind.
   *
   * ## Why it exists here and nowhere else in the app
   *
   * "Remove" is a defined act on a deck row and is not one anywhere else a card is drawn: on a
   * search wall Delete would name nothing, and on the collection it would mean destroying a record
   * of cardboard the reader owns. So the key is bound by the editor, for the editor's own scope,
   * and the walls get multi-select without it.
   *
   * ## Three fences, each closing a real way this goes wrong
   *
   * **A text field keeps the key**, through the same `isTextField` the undo handler one screen up
   * yields to and the native context menu's carve-out turns on — a reader deleting a character out
   * of the deck's name must not lose four cards. It stays at this call site for that handler's
   * reason: which bindings yield to a caret is a fact about each binding, not about matching a
   * chord. **A layer takes it too**: with a dialog or a confirmation open the deck is behind a
   * scrim, and a key that reached past it would act on a surface the reader cannot see.
   * And **nothing is written for a set of one**, which is the
   * deliberate asymmetry — one card has a stepper, a menu row and a tray, all of them visible, and
   * a bare Delete that silently removed whatever was last clicked is a keystroke away from a deck
   * the reader did not mean to edit.
   *
   * It goes through `setQuantityAt(…, 0)` like every other removal in this editor — the stepper's
   * zero, the menu's `Remove card`, the tray's drop — so it inherits the optimistic patch, the
   * rollback, and the collection write that files the copies into `Recently removed`. There is no
   * remove mutation and this is not the place to add one.
   *
   * **What it costs is one press of Ctrl+Z per card**, because `deck_audit` has a row per write.
   * Named rather than hidden: batching is a Rust change to `deck_undo`'s grain.
   */
  const layerOpen = layer !== null;
  useEffect(() => {
    if (layerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (!matchesShortcut(REMOVE, event)) return;
      if (isTextField(event.target)) return;
      const held = pickedRef.current;
      if (held.length < 2) return;
      event.preventDefault();
      for (const card of held) setQuantityAt(card.cardId, card.categoryId, card.finish, 0);
      setCardSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layerOpen, setQuantityAt, setCardSelection]);

  /**
   * A press on a deck card, with the chords it was holding — the seam every view calls before it
   * opens the pane.
   *
   * It answers `true` for a chord, and the view then does nothing else. A plain click has already
   * collapsed the set to this one card by the time this returns `false`, which is what keeps the
   * ring and the pane agreeing without the views knowing either exists.
   */
  const pickCard = useCallback(
    (card: DeckCard, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
      picked.pick(deckCardSlot(card.categoryId, card.cardId, card.finish), event),
    [picked],
  );

  /**
   * What every view is handed, and the whole of what a card **and a pile** can be made to do.
   *
   * One object rather than six props, because it travels three components deep — the view, the
   * group, the card — and a bag that is passed on whole cannot be passed on incompletely. The
   * views spend it differently (a table gets columns, the other three get a bar over the card),
   * and every control inside it is `cardControl.tsx`'s.
   *
   * It carries two pile-level members beside the card's three, which is what `drop` always was:
   * the heading's own menu, and the rename field for the pile being renamed.
   *
   * **It is built here, below `groups`, rather than beside the writes it is made of** — moved for
   * issue #214, because three of its members are about the picked set and the set is measured
   * along the order `groups` decides. Nothing reads it before this point; `viewProps` below is
   * its only consumer.
   */
  const actions = useMemo<DeckCardActions>(
    () => ({
      setQuantity,
      drop: applyDrops,
      menu: deckCardMenu,
      categoryMenu,
      groupDrag,
      isPicked: picked.selected,
      pick: pickCard,
      renameCategory: (categoryId) =>
        categoryId === null ? null : renameCategoryField(categoryId),
      // **Only while the deck is grouped by category**, and absent is the whole of the off
      // switch — a view draws no grip without it. Under `manaValue` and `type` the headings on
      // the desk are buckets the app derived, so there is no order of the reader's on screen to
      // change; the piles that *are* real there are the switched-off ones `buildGroups` appends
      // and the command zones it heads the list with, and neither is in the flow — the first is
      // in the rail, the second in the box `splitRail` answers `command` for, whose piles are
      // drawn without a `flowWidth` and so register no grip whatever this prop says. That second
      // exemption is not this gate's doing and does not want to be: a zone pinned to the head of
      // every grouping has no position for a drag to change, under `category` least of all.
      moveCategory: groupBy === "category" ? moveCategory : undefined,
    }),
    [
      setQuantity,
      applyDrops,
      deckCardMenu,
      categoryMenu,
      groupDrag,
      picked.selected,
      pickCard,
      renameCategoryField,
      groupBy,
      moveCategory,
    ],
  );

  const viewProps = {
    groups,
    marketplace,
    violations,
    theoryMatches,
    onSelect: openCard,
    actions,
    // The two marks a card can carry here, in the four views that draw them. `landed` is this
    // editor's alone: nothing outside it can add a card to the deck the reader is looking at.
    // `selectedSlot` is derived from the store just above.
    selectedSlot,
    landed,
    // No `className`, and the `min-h-0` that was here went with the desk's height (2026-08-14):
    // it said "this view may be squeezed below its content", which is the sentence that made the
    // deck builder scroll inside itself. `TableView` — the one view that still wants it — carries
    // it on its own root, where a virtualiser's scrollport belongs.
  };

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
      // sticks to the foot of the window for the length of a drag (the price strip). The
      // virtualised table is the one view still given a height, because a virtualiser is a
      // scrollport by construction.
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
      // `src/lib/focus.ts` has the rule.
      className={cn("relative flex h-full min-h-0 flex-col gap-3")}
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

      {/**
       * **The card pane, drawn over one of this editor's own columns rather than beside them**
       * (issue #183). Everything about this box serves one sentence: opening a card must not
       * change the flow of the deck.
       *
       * It used to be `App`'s, docked at the right-hand edge of the shell — a real flex item,
       * 384px plus a gap, taken out of this editor whether or not the reader was reading a card.
       * That is a **reflow of the whole deck on a click**: the piles re-pack, the desk narrows
       * past {@link DECK_FLOOR}, and the search column beside it collapses to its rail — so a
       * reader who pressed a card to look at it lost the search they were adding from. `App`
       * still draws the docked pane for every other view and steps aside for this one; see its
       * `inDeckEditor`.
       *
       * ## The two positions
       *
       * **A card opened from the deck draws over the search column; a card opened from the
       * search column draws over the deck, against that column's left edge.** Either way the
       * pane covers what the reader was *not* looking at — a search whose answer covers the
       * search is the failure the whole arrangement exists to avoid. `paneFromDeckSearch` is the
       * whole of the decision, and the store's own note says why it is a field rather than
       * `paneDeckContext` read backwards.
       *
       * ## Why it is here and not inside the desk row
       *
       * The desk row is where the panel it is drawn against lives, and the dock beside it is
       * already sticky and already sized — so that is where this went first. Two things make it
       * wrong. **The desk row is unmounted when the deck read answers `null`**, which is the one
       * state the pane matters most in: a swap refused with GONE draws its sentence *in the
       * pane*, over an editor that has stopped painting the deck (`App.test.tsx` holds both
       * halves). And **the dock is `position: sticky`, which always creates a stacking
       * context**, so a pane inside it could never be raised above the {@link LAYER.raised} the
       * deck's own stack puts on an open card — a card standing proud of its neighbours would
       * paint straight through the pane drawn over it. Here it is a sibling of the desk row and
       * competes in this column's context, where `LAYER.popup` beats that lift.
       *
       * `sticky top-0 h-0 -mb-3` is `QuickZones`' arrangement one line up and for its reason:
       * the first children of this scroller are the only ones a `sticky` box can be pinned to
       * the top of the window from, and this one has to cost no layout in either state — `h-0`
       * so it takes no height and `-mb-3` so it takes back the column's `gap-3`. That is the
       * "no reflow" claim, and it is structural rather than a number to keep in step.
       */}
      <div className={cn("pointer-events-none sticky top-0 -mb-3 h-0", LAYER.popup)}>
        {/**
         * Where the pane is allowed to be, on the side it was opened from — a real box rather
         * than an offset, because `max-w-full` needs something to be full *of*. The pane asks
         * for 384px; a desk narrower than that would otherwise clip it against the editor's own
         * `overflow`, and content overflowing the inline-start edge is unreachable rather than
         * scrollable, so the missing half of the card could not even be scrolled to.
         *
         * `top` and `height` are written by the dock effect and are deliberately not classes:
         * at rest the pane starts where the desk starts, under the deck's ribbon and toolbar,
         * and scrolled past it takes the whole window — the same two ends the search column
         * beside it is drawn between, measured once for both.
         *
         * `pointer-events-none`, because this box spans a whole column and is transparent; the
         * pane inside re-enables them for itself (`CardDetailPane`). Without it, opening a card
         * would make the deck under it unclickable, which is the exact opposite of what an
         * overlay that leaves the list live is for.
         *
         * An undefined width is jsdom, where nothing has been measured: the box then shrinks to
         * the pane's own 384 and `max-w-full` binds on nothing, which is the honest answer on a
         * surface with no layout engine.
         */}
        <div
          ref={paneFrameRef}
          {...{ [PANE_OVER_ATTR]: paneFromDeckSearch ? "deck" : "search" }}
          className="pointer-events-none absolute flex justify-end"
          // The desk's right edge, or the search column's left edge one gap further in. The
          // unmeasured fallback for the second is the first — it is reachable only before the
          // observers have answered, which on this side means before the reader can have pressed
          // a tile in a column that has not been laid out yet, and in jsdom, which never lays
          // anything out. See {@link PANE_OVER_ATTR} for what a suite can hold instead.
          style={
            paneFromDeckSearch
              ? {
                  right: dockWidth > 0 ? dockWidth + DESK_GAP : 0,
                  width: deskWidth > 0 ? Math.max(0, deskWidth - dockWidth - DESK_GAP) : undefined,
                }
              : { right: 0, width: deskWidth > 0 ? deskWidth : undefined }
          }
        >
          {/* The presence and nothing finer — `App`'s note on this key holds word for word: a
              constant, because keying on the card would turn every card-to-card move into one
              pane leaving and another arriving. The per-card remount lives inside the pane,
              where React can throw the body away without the box going anywhere. */}
          <AnimatePresence>
            {selectedCardId && (
              <CardDetailPane key="card-pane" cardId={selectedCardId} onClose={closeCard} />
            )}
          </AnimatePresence>
        </div>
      </div>

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
       *
       * **Three lines since 2026-08-24, and this is the first of them**: what the deck is and
       * what can be done to it, then the ledger of what it adds up to, then the toolbar that
       * decides how it is drawn. The two selects that used to sit at the right of this row are
       * gone — see {@link ACTIONS}.
       */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 py-1.5">
        <button
          type="button"
          // {@link closeDeck}, shared with Escape's `"navigation"` rung — one act, one function,
          // so the key and the button can never come to mean different things.
          onClick={closeDeck}
          aria-label="Back to decks"
          // The words go and the chevron stays, at the width where every other word on the row
          // goes. The tooltip is bound only then, for the reason it is bound at all: at any
          // other width it would repeat the word printed beside it.
          {...(tightHeader ? tip("Back to decks", { describes: false }) : {})}
          className={cn(
            "inline-flex h-9 shrink-0 items-center rounded-md text-sm text-dim",
            tightHeader ? "w-9 justify-center px-0" : "gap-1 px-2",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
          {!tightHeader && "Decks"}
        </button>

        {row && (
          <>
            {/* The document's heading for this state of the view. Drawn as the field beside it
                rather than twice — the ribbon's `h1` says "Decks", and this says which one. */}
            <h2 className="sr-only">{row.name}</h2>
            {/**
             * The deck's name, and it is the row's one flexible child.
             *
             * **The wrapper that used to hold it is gone** (2026-08-24). It grouped the field
             * with the Theory/Actual switch and the Compare button, which was right while those
             * three were the row's left-hand half; both of them are in the actions block now, so
             * the group had one child left. The field is therefore the flex item this row's
             * layout was always about.
             *
             * **`flex-wrap` and a floor on the field, because this row overflowed in the shipped
             * window and no test could see it.** Measured over CDP with Theory on: the field was
             * the only shrinkable child between two `shrink-0` siblings, so it collapsed to its
             * intrinsic minimum — **18px at 1100, 1200 and 1280** — while the switch and the
             * control beside it spilled 180px / 80px out of this box and over the actions. At
             * 1200 the last pixels of that control (a "N cards differ" readout then, the
             * Compare button since) hit-tested to the *format select*: a reader aiming at the
             * difference re-formatted their deck.
             *
             * So the narrowest things yield first. The field keeps its own floor
             * (`NAME_FLOOR`, in {@link DeckNameField}) and the actions block wraps to a second
             * line when it no longer fits beside it; nothing overlaps at any width, because
             * nothing is squeezed past its own content any more.
             *
             * **The field is the bare `<input>` this box's flex layout expects**, which is why
             * {@link DeckNameField} draws no wrapper of its own — see it.
             */}
            <DeckNameField name={row.name} onRename={renameDeck} />

            {/**
             * Everything that can be done to this deck, in one block against the right edge.
             *
             * **`ml-auto` and `flex-nowrap`, which is the reverse of what this block used to
             * carry and is safe for a reason the old shape did not have.** It was
             * `flex-wrap justify-end` and deliberately shrinkable, because `shrink-0` on it had
             * pinned it at its max-content width — **692px, at every window size** — and every
             * pixel of the squeeze fell on the deck's name. What has changed is that the block
             * now gives width back *itself*: the four labelled buttons drop to their icons, and
             * `Deck settings` goes first (see {@link SETTINGS_ICON_PX}). So it is a fixed run
             * whose fixed width is a function of the column, and the outer row's `flex-wrap` is
             * what catches the width below which even the narrow run does not fit — the whole
             * block folds to a line of its own rather than crushing the name.
             */}
            <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
              {/* Only for a deck that keeps a plan. A two-way switch over a deck with one list
                  is a control whose other half is empty by construction — the way to get one is
                  Deck settings, where the toggle that creates it lives. The same condition covers
                  `Compare` beside it, which weighs exactly the two lists this switch chooses
                  between and is meaningless to a deck that has one. */}
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
                        one a reader sees as "Actual" and voice control has to be asked for as
                        "actual". Which is doubly true now that the word is not the value: the
                        variant is still `live` in the database, in the IPC and in every URL this
                        app keeps — `Actual` is the *name*, and renaming a stored value to match a
                        label would be a migration bought with nothing. */}
                    {/* **Theory first, Actual second** (2026-08-26, the reader's call), which
                        reverses the order argued here on 2026-08-24 and restores the one before
                        it: the plan is the list a deck is *built* in, so it is the one the eye
                        should land on first, and the live list is what the plan has become so far.
                        **Nothing about which tab is pressed, remembered or restored is decided
                        here** — that is `lastVariant`'s doing, and it survived the last flip of
                        this order untouched for the reason it survives this one: the write that
                        turns the switch on moves the deck into theory and leaves it there, so the
                        reader arrives on the tab their cards are now under whichever end of the
                        group it is painted at. This is the order the two words are painted in,
                        and no more than that.

                        **No hairline between them, unlike {@link TRANSFER}'s pair.** One of these
                        two is always pressed — a deck is showing one of its lists or the other —
                        so the filled half's own edge is the divider, and a border drawn on top of
                        it would be a second line saying the same thing. The pair needed one while
                        `Compare` sat between them and carried it; it does not now. */}
                    {(
                      [
                        { id: "theory", label: "Theory" },
                        { id: "live", label: "Actual" },
                      ] as const
                    ).map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => pickVariant(id)}
                        aria-pressed={variant === id}
                        className={cn(
                          // 36px like every other press in this ribbon — the back button and
                          // {@link PLAIN_PRESS}. At 28px this segmented pair was the shortest thing
                          // in the row by eight pixels and read as a secondary control, which is
                          // the opposite of what it is: it says which of the deck's two lists is
                          // on screen.
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

                  {/**
                   * **Beside the switch, not inside it** (2026-08-26, the reader's call).
                   *
                   * It was a third segment between the two words from 2026-08-24 — a verb between
                   * two nouns, on a row that had no width for a third label — and what that shape
                   * got wrong is that `Compare` is not one of the deck's two lists. The group is a
                   * two-way switch named `Deck list`, and a press inside it that answers a
                   * different question is a press a reader has to learn is not a third list. Out
                   * here it is what it is: an action about both lists, standing next to them.
                   *
                   * **The row's own `gap-2` is the whole of the spacing decision** — it is a
                   * sibling of the switch and of {@link TRANSFER}'s pair in the same flex line, so
                   * it sits at the same distance from its neighbours as everything else on the
                   * row, and nothing here says otherwise.
                   *
                   * The word is back with it, because a button outside the group has no adjacent
                   * nouns to lean on. It gives way at {@link TIGHT_HEADER_PX} exactly as
                   * {@link ACTIONS}' words do — the word goes, never the control — and the tooltip
                   * is bound exactly when the word is not there to be read. The scales are
                   * lucide's `Scale`: two things weighed against each other.
                   */}
                  <button
                    type="button"
                    onClick={(e) => {
                      const trigger = e.currentTarget;
                      openLayer({ kind: "theoryDiff" }, () => trigger.focus());
                    }}
                    aria-expanded={layer?.kind === "theoryDiff"}
                    aria-haspopup="dialog"
                    aria-label="Compare"
                    {...(tightHeader ? tip("Compare", { describes: false }) : {})}
                    className={cn(
                      PLAIN_PRESS,
                      FILTER_FOCUS,
                      "inline-flex shrink-0 items-center justify-center whitespace-nowrap",
                      tightHeader ? "w-9 px-0" : "gap-1.5",
                      "hover:text-text",
                    )}
                  >
                    <Scale className="size-4 shrink-0" aria-hidden="true" />
                    {!tightHeader && "Compare"}
                  </button>
                </>
              )}

              {/* The joined pair — see {@link TRANSFER}, which is where both names are argued
                  and where the widths they keep or lose are decided. */}
              <div
                role="group"
                aria-label="Import and export"
                className="flex shrink-0 overflow-hidden rounded-md border border-border bg-surface"
              >
                {TRANSFER.map(({ layer: target, label, Icon }, at) => (
                  <button
                    key={label}
                    type="button"
                    onClick={(e) => {
                      const trigger = e.currentTarget;
                      openLayer(target, () => trigger.focus());
                    }}
                    aria-expanded={layerMatches(layer, target)}
                    aria-haspopup="dialog"
                    aria-label={label}
                    {...(wideHeader ? {} : tip(label, { describes: false }))}
                    className={cn(
                      "inline-flex h-9 shrink-0 items-center justify-center whitespace-nowrap",
                      "text-xs text-dim",
                      at === 1 && "border-l border-border",
                      wideHeader ? "gap-1.5 px-2.5" : "w-9 px-0",
                      "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                      FOCUS,
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {wideHeader && label.split(" ")[0]}
                  </button>
                ))}
              </div>

              {/* Each row carries the layer it opens rather than a kind — see {@link ACTIONS},
                  which is where every one of these buttons' names is argued. The word is what
                  gives way as the column narrows, never the control, and the tooltip is bound
                  exactly when the word is not there to be read. */}
              {ACTIONS.map(({ layer: target, label, Icon }) => {
                // `Deck settings` is the longest word in the row, so it is the first to go.
                const bare = tightHeader || (settingsIcon && target.kind === "settings");
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={(e) => {
                      const trigger = e.currentTarget;
                      openLayer(target, () => trigger.focus());
                    }}
                    aria-expanded={layerMatches(layer, target)}
                    aria-haspopup="dialog"
                    aria-label={label}
                    {...(bare ? tip(label, { describes: false }) : {})}
                    className={cn(
                      PLAIN_PRESS,
                      FILTER_FOCUS,
                      "inline-flex shrink-0 items-center justify-center whitespace-nowrap",
                      bare ? "w-9 px-0" : "gap-1.5",
                      "hover:text-text",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {!bare && label}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {row && (
        // What the deck adds up to, and what the rules make of it — the second of the header's
        // three lines. See {@link DeckLedger}, which owns the figures; the three controls at its
        // right end are this file's, because each opens one of its layers.
        <DeckLedger
          cards={deck.cards}
          marketplace={marketplace}
          formatName={spec?.displayName ?? row.formatName ?? null}
          gameChangers={gameChangers}
          tight={tightHeader}
          check={
            // Nothing at all while the seeded rules are not in hand. A format the seed no longer
            // carries has no rules to judge against, and a button that said "No issues" because
            // nothing was checked would be the one sentence this panel must never write.
            spec && (
              <ValidationPanel
                cards={deck.cards}
                spec={spec}
                open={layer?.kind === "check"}
                tight={tightHeader}
                buttonRef={chipRef}
                onOpen={openCheck}
                onDismiss={dismiss}
                onClose={close}
                onSelectCard={setSelectedCardId}
              />
            )
          }
          bracket={
            // Only where the format has a command zone: a bracket is the Commander
            // conversation, and `estimateBracket` is a per-edit pass over every face of every
            // card that must not be paid by a Standard deck that has no use for the answer.
            spec?.commanderRule != null && (
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
                onBracket={(bracket) => deck.update.mutate({ bracket })}
                open={layer?.kind === "bracket"}
                buttonRef={bracketRef}
                onOpen={openBracket}
                onDismiss={dismiss}
                onClose={close}
              />
            )
          }
        />
      )}

      {row && (
        /**
         * The third of the header's lines: how the deck is drawn, and the two controls that
         * change it.
         *
         * **At {@link TIGHT_HEADER_PX} it reads as two sentences rather than one long run** —
         * the three pickers that decide how the deck is *drawn*, then the tools that *change*
         * it. `order` does the regrouping and a zero-height full-width child forces the break,
         * so **the DOM order is unchanged** — quick add, undo/redo, the pickers, the filter —
         * and a caret walking the row is unaffected by which line a control is painted on.
         * `order` is deliberately not a reordering anybody reads: it is one flex line becoming
         * two, and the groups within each are in the order they were written.
         */
        <div
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-x-3 border-b border-border pb-3",
            tightHeader ? "gap-y-1.5" : "gap-y-2.5",
          )}
        >
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

          {/* **The own/need toggle stood here on 2026-08-23, moved to the search panel's card
              tab, and was deleted on 2026-08-25.** Both placements were arguments about where a
              control goes; what retired it is that the question it asked has a better answer.
              "I own this" from a wall of Scryfall printings was a silent write that filed
              collection rows for cards the reader had only searched for; the Collection tab
              searches the copies they actually hold, names the deck a spoken-for copy would come
              out of, and asks first. Every add from this editor now writes a `deck_cards` row
              and reads as missing until a copy is put behind it. */}

          {/* The first of the row's three pickers, and the one that says how a card is drawn.
              It is the same control as the two beside it on purpose — see {@link VIEW_PICKER}. */}
          <div className={cn("flex shrink-0 items-center gap-1.5", tightHeader && "order-1")}>
            <label
              id="deck-view-label"
              htmlFor="deck-view"
              className="text-[0.6875rem] text-dim"
            >
              View
            </label>
            <Dropdown
              id="deck-view"
              labelledBy="deck-view-label"
              value={view}
              onChange={(value) => setView(value as DeckView)}
              options={VIEW_OPTIONS}
            />
          </div>

          <div className={cn("flex shrink-0 items-center gap-1.5", tightHeader && "order-1")}>
            <label
              id="deck-group-by-label"
              htmlFor="deck-group-by"
              className="text-[0.6875rem] text-dim"
            >
              Group by
            </label>
            <Dropdown
              id="deck-group-by"
              labelledBy="deck-group-by-label"
              value={groupBy}
              onChange={(value) => pickGroupBy(value as GroupBy)}
              options={GROUP_BY_PICKER}
            />

            {/* A modifier of the picker it stands beside, so it lives inside that cluster's
                `gap-1.5` rather than out in the toolbar's `gap-x-4` — and it is drawn **only**
                under Mana value, because there is nothing for it to say about a deck grouped by
                category or by type. A control that persists across a grouping it has no effect
                on is a control the reader has to remember the scope of.

                **Its state is the deck's, written through the same `update` the header's format
                select writes** — one `deck_update`, no `deck_cards` row touched, and a refusal
                lands in the banner above with every other write of this editor's, because the
                refusal rule lives on the mutation's single definition and never on a call site.

                The whole sentence is the chip's `title`, which `ToggleChip` also makes its
                accessible name: "Split X" alone is a control naming a thing rather than an
                action, and the name has to stand up read out of context — a screen reader gets
                no picker beside it. It begins with the visible label all the same (WCAG 2.5.3),
                so the chip is still addressable by what is written on it. */}
            {groupBy === "manaValue" && (
              // `ToggleChip` (`components/FilterChips.tsx`) owns turning its `title` prop into
              // a `useTooltip()` binding internally — that file is outside this bucket, but the
              // prop's name and shape are unchanged, so this call needed no edit.
              <ToggleChip
                label="Split X"
                pressed={separateX}
                title="Split X — give cards with X in their cost a group of their own, instead of counting X as zero"
                onClick={() => deck.update.mutate({ separateXGroup: !separateX })}
              />
            )}
          </div>

          <div className={cn("flex shrink-0 items-center gap-1.5", tightHeader && "order-1")}>
            <label
              id="deck-sort-by-label"
              htmlFor="deck-sort-by"
              className="text-[0.6875rem] text-dim"
            >
              Sort
            </label>
            <Dropdown
              id="deck-sort-by"
              labelledBy="deck-sort-by-label"
              value={sortBy}
              onChange={(value) => pickSortBy(value as SortBy)}
              options={SORT_BY_PICKER}
            />
          </div>

          {/* The break, and it is `aria-hidden` because it is a line ending rather than a
              control. `flex-basis: 100%` on a zero-height child fills the rest of the line it
              lands on, so everything after it starts a new one — `order-2` puts it between the
              pickers and the tools without moving either in the DOM. */}
          {tightHeader && <span aria-hidden="true" className="order-2 h-0 basis-full" />}

          {/* The deck's own labels, as filters. Nothing at all for a deck with no labels — an
              empty group with a name is a control that says there is something to press.

              **A toolbar item of its own, and it was inside the filter's box until 2026-08-24.**
              That box grew a `max-w-[25rem]` ceiling in the same change — the field's, and a good
              one — and a row of arbitrary user strings crammed into 400px is not what the ceiling
              was for. */}
          {deck.labels.length > 0 && (
            <div
              role="group"
              aria-label="Filter by label"
              className={cn("flex flex-wrap items-center gap-1.5", tightHeader && "order-3")}
            >
              {deck.labels.map((label) => {
                const on = labelIds.includes(label.id);
                return (
                  <button
                    key={label.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setLabelIds((held) =>
                        held.includes(label.id)
                          ? held.filter((id) => id !== label.id)
                          : [...held, label.id],
                      )
                    }
                    className={cn(
                      FILTER_CONTROL,
                      FILTER_FOCUS,
                      // `FILTER_CONTROL`'s own 36px, which the `h-8` here used to override
                      // back down to the toolbar's old height. Only the type size is still
                      // overridden: a deck's labels are a row of arbitrary user strings, and
                      // 14px of them is a line that pushes the filter field off the end.
                      "px-2.5 text-xs",
                      filterChipState(on),
                    )}
                  >
                    {label.name}
                  </button>
                );
              })}
            </div>
          )}

          <div
            className={cn(
              // The design's own shape: the field takes the line's leftover between a floor and
              // a ceiling, rather than the fixed 176px it drew before. `ml-auto` is inert while
              // there is anything left to grow into and pins the box right once the ceiling
              // binds — a search box as wide as a maximised window is a box whose text sits
              // alone in the middle of the desk.
              "ml-auto flex min-w-40 max-w-[25rem] flex-1 items-center",
              tightHeader && "order-3",
            )}
          >
            <input
              type="search"
              aria-label="Filter this deck"
              placeholder="Filter this deck…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              // **A box with text in it owns one Escape, and an empty one owns none.** Without
              // this the press would empty the box *and* close the deck behind it: Chromium
              // clears an `<input type="search">` on Escape by itself and does **not** set
              // `defaultPrevented`, so the `"navigation"` rung above would take the same press.
              // jsdom implements no native clear, so only the second half of that is visible to
              // this suite — the reason is on {@link clearFieldOnEscape}.
              onKeyDown={(e) => clearFieldOnEscape(e, filter, () => setFilter(""))}
              className={cn(
                "h-9 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 text-xs",
                FOCUS,
              )}
            />
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
        <div
          ref={deskRef}
          // `min-h-96` on **this** box is what holds a flex item to the page's leftover height
          // rather than to its content — see {@link DECK_HEIGHT_FLOOR}, where that is written
          // out — so it belongs to the one view that wants to be held: the virtualised table.
          // For the three that grow it is one level in, on the view box, where it floors without
          // capping. Measured with it left here: the table drew its own scrollbar *and* the page
          // drew one, which is the two-scrollbar screen this whole change is about.
          className={cn("flex flex-1 gap-4", view === "table" && DECK_HEIGHT_FLOOR)}
        >
          {/**
           * The box the deck is drawn in, and **it is given no height** — which is the whole of
           * the 2026-08-14 change and the reason the paragraphs above read the way they do.
           *
           * It was `min-h-0 … overflow-auto`, a scroller of exactly the desk's height. That is
           * what put a scrollbar *inside* the deck builder the moment a deck had more piles than
           * the window was tall: a wall of cards in a letterbox, the editor's own scrollbar
           * beside it, and no way to tell from the screen which of the two a wheel was about to
           * move. `min-h-0` is what did it, not `overflow` — it is the line that tells the flex
           * row this box may be squeezed below its content, and with it gone the row is as tall
           * as the deck, the page is as tall as the row, and the page scroller is the one thing
           * in this editor that scrolls. Piles overflow **down**, and the container grows.
           *
           * **The table is the exception, and it is a difference in kind rather than a case to
           * tidy away.** `VirtualTable` mounts the rows in view and holds the scrollbar open to
           * the height of the rest; a scrollport is what it *is*, and a virtualiser given no
           * height renders every row of the deck. So that one view keeps the arrangement this
           * div used to carry for all four, and the three walls — stacks, grid, text — grow.
           */}
          <div
            className={cn(
              "min-w-0 flex-1",
              DECK_HEIGHT_FLOOR,
              view === "table" && "flex min-h-0 flex-col overflow-auto",
            )}
          >
            {/* Neither `columnHeight` nor a measured height reaches a view any more. `StackView`
                packs nothing — every pile is a flex item that wraps on width — and `TextView`
                still packs, to a fixed readable target rather than to the desk, which is as tall
                as its own answer now. See that prop's own note. */}
            {view === "stacks" && <StackView {...viewProps} />}
            {view === "table" && <TableView {...viewProps} />}
            {view === "text" && <TextView {...viewProps} />}
            {view === "grid" && <GridView {...viewProps} />}
          </div>

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
              "sticky top-0 flex shrink-0 self-start",
              panelOverWidth !== undefined && LAYER.popup,
            )}
          >
            <DeckSearchPanel
              // `deck.addCard` unwrapped since 2026-08-25 — it was `panelAdd`, the same mutation
              // with the own/need answer folded into every `mutate` on the way past, and there is
              // no answer left to fold.
              add={deck.addCard}
              onAdded={markLanded}
              categories={categories}
              deckId={deckId}
              targetCategoryId={targetCategoryId}
              defaultFormat={searchFormatDefault}
              cardMenu={panelCardMenu}
              cardMenuKey={panelCardMenuKey}
              roomy={roomForPanel}
              overWidth={panelOverWidth}
              maxWidth={maxPanelWidth}
            />
          </div>
        </div>
      )}

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
      <PriceStrip marketplace={marketplace} variant={variant} onRemove={applyDrops} />

      {row && (
        // What the deck adds up to — the foot of the page, and the last thing under the deck.
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
          {/* **`onPull` is `null` on the plan, and that is the list rather than the feature.**
              A theory list is what the deck is being built *toward*, and since schema v25 a deck
              holds a card because a collection row sits in its group — so a theory row holds no
              cards at all and there is nothing on that tab to pull into. The backend agrees at
              the same seam: `deck_pull_plan` takes no variant and reads the live list, exactly as
              `deck_missing_to_wishlist` does one command over. Absent rather than greyed, for the
              editor's own rule about a control that cannot act: a button that spends the whole
              Theory tab refusing teaches the reader to stop looking at the line it is in. */}
          <DeckStats
            cards={deck.cards}
            send={deck.missingToWishlist}
            onPull={variant === "live" ? openPull : null}
            separateXGroup={separateX}
          />
        </section>
      )}

      {/* The overlays, mounted **at the editor's top level and as siblings of the layout
          above**, which is not a tidiness preference. (Count them off the `Layer` union rather
          than from a number here — this comment said "seven" through three separate additions,
          and a prose-only edit routes to neither CI job.) Each is `fixed inset-0` and none is
          portalled, so a transformed ancestor would become its containing block and pin it to
          whatever box that ancestor happens to occupy — and this editor has transformed
          elements in it (a virtualised table's rows are `absolute` *and* `transform`ed, which
          is a stacking context and a containing block both). Mounted inside the view area, a
          dialog would centre itself over a column instead of over the window.

          Each is closed by `open`, and each unmounts everything behind that flag — so a closed
          one costs no query, no window listener and no state. That is what makes it safe to
          mount every one of them unconditionally, and it is why the editor can hold them in one
          `Layer` union rather than a boolean apiece. For all but two `Dialog` guarantees it:
          `open` gates an `AnimatePresence`, so a closed dialog's body is not in the tree at all.
          The theory diff and the import dialog are not on that shell (see the `Layer` union's
          doc) and each guarantees the same thing with an `AnimatePresence` of its own — which
          is a second and a third copy of the rule rather than a second reading of it.

          **Two of them were one until 2026-08-14.** `CategoriesPanel` drew the deck's piles and
          its labels as two sections of a single right-hand drawer; they are `CategoriesDialog`
          and `LabelsDialog` now, which is why the toolbar above has a button for each. */}
      <CategoriesDialog
        deckId={deckId}
        variant={variant}
        open={layer?.kind === "categories"}
        onDismiss={dismiss}
        onClose={close}
      />
      <LabelsDialog
        deckId={deckId}
        variant={variant}
        open={layer?.kind === "labels"}
        onDismiss={dismiss}
        onClose={close}
      />
      {/* The label a card's menu asked for — pick one of the reader's other labels, or make
          one.
          **The press closes it and the chain finishes without it** — `createLabelFor` is two
          writes on this component's observers, so the dialog is free to go on the press exactly
          as the field it replaced did, and a create still in flight when the reader dismisses
          still lands on the card.

          `choices` is the app-wide list minus what this list already wears, and the subtraction
          is here rather than in the dialog because the editor is the only thing holding both
          halves: `deck.labels` came in with `deck_get` and `meta.allLabels` off
          `deck_label_all`. */}
      <AddLabelDialog
        open={layer?.kind === "addLabel"}
        cardName={layer?.kind === "addLabel" ? layer.slot.name : null}
        choices={addLabelChoices}
        pending={meta.createLabel.isPending}
        onPick={(labelId) => {
          if (layer?.kind !== "addLabel") return;
          setCardLabelOnSlot(layer.slot, labelId);
          dismiss();
        }}
        onCreate={(name, color) => {
          if (layer?.kind !== "addLabel") return;
          createLabelFor(layer.slot, name, color);
          dismiss();
        }}
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
      {/* Two destinations since Task 14 — the deck that is open, and a fresh one made out of
          the same paste — so the shell now draws the radio group it has always been able to.
          `importInto` is built where the deck's own facts are; `importIntoNewDeck` wraps
          `newDeckDestination` the way `DecksPage`'s own does, closing over `onNewDeckImported`
          so choosing "a new deck" from here does not leave it invisible — this editor has no
          remembered format to seed the new deck's select with, which is the one thing
          `DecksPage`'s wrapper passes that this one does not.

          `forcedCategoryName` is set only when the dialog was opened from a category heading's
          right-click, and it is the whole of the difference between "import into this deck" and
          "import into this pile" — applied in `buildImportPlan`, not here, because
          `destinations/deck.ts` makes every deck decision. The toolbar's own press carries none
          and is unchanged. **It has no equivalent on the new-deck arm**: a right-click names a
          pile of *this* deck, and a list sent to a deck that does not exist yet has no such pile
          to aim at.

          `dismiss` on the way out, whichever way the import ended: the trigger is one press
          away in the toolbar, and importing into *this* deck needs no navigation — the editor
          re-reads it, because every write in `useImport` takes the `["decks"]` root with it.
          Importing as a *new* deck is `onNewDeckImported`'s job, which fires alongside `dismiss`
          rather than instead of it. No `subtitle` prop: the chosen destination says its own
          header line (`importInto`'s names this deck; the new deck's leaves the fallback in
          place, since there is no deck yet to name). */}
      <ImportDialog
        destinations={[importInto, importIntoNewDeck]}
        open={layer?.kind === "import"}
        onDismiss={dismiss}
        onClose={close}
        onDone={dismiss}
      />
      {/* The confirmation a `Delete…` owes, and it is **`CategoriesDialog`'s own component**
          rather than a second one written here. That dialog asks a careful question — the cards
          go with the pile unless the reader names somewhere to move them, and the sentence
          changes with the answer — and two confirmations for one command would be two chances to
          word "this cannot be undone" differently. It takes `meta` and draws itself, so the only
          thing this file decides is which pile and what "the others" are.

          `others` is every category **but** this one, in the reader's own `sortOrder`: the list
          the move picker offers, which must not include the pile being deleted. */}
      <Dialog
        open={layer?.kind === "deleteCategory"}
        title={deletedCategory === null ? "Delete category" : `Delete “${deletedCategory.name}”`}
        // Named for what it closes, like every other dialog here — two controls called "Close"
        // on one screen are two a screen reader cannot tell apart.
        closeLabel="Close delete category"
        // Narrow, because the body is one question, one picker and two buttons — the width class
        // is written out whole, since Tailwind emits no rule for a class built at runtime.
        width="w-[28rem]"
        onDismiss={dismiss}
        onClose={close}
      >
        {deletedCategory && (
          <div className="px-4 pb-4">
            {/* **A refused delete has to be said _inside_ this dialog**, and that is not a
                duplicate of the editor's banner — it is the only place the sentence can be seen.
                That banner draws in the editor body, which is behind this dialog's own
                `LAYER.overlay` scrim, and a refusal leaves the dialog open with its button still
                live: `onDeleted` never fires, so nothing on screen changes and a sighted reader
                sees a press that did nothing. `role="alert"` announces it either way, which is
                exactly the shape of bug that passes a suite. `CategoriesDialog` never had this
                because its banner is inside its own panel. */}
            {meta.deleteCategory.isError && (
              <p
                role="alert"
                className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
              >
                Could not delete that category — {ipcError(meta.deleteCategory.error)}
              </p>
            )}
            <DeleteCategory
              category={deletedCategory}
              others={categories.filter((c) => c.id !== deletedCategory.id)}
              meta={meta}
              onCancel={dismiss}
              onDeleted={dismiss}
            />
          </div>
        )}
      </Dialog>

      {/* The confirmation a `Clear stack…` owes, beside the delete's and deliberately **not**
          folded into it. That dialog asks which of two things should happen to the cards; this
          one has a single outcome and a different scope — one list, not both — so sharing a
          component would mean a picker with nothing to pick and a sentence with a branch for
          each caller. What they do share is the chrome, which is `Dialog`'s.

          A refused clear is said **inside** this dialog for the delete's reason, in full there:
          the editor's own banner draws behind this dialog's `LAYER.overlay` scrim, and a
          refusal leaves the question open with its button still live — so without this the
          reader sees a press that did nothing. */}
      <Dialog
        open={layer?.kind === "clearCategory"}
        title={clearedCategory === null ? "Clear stack" : `Clear “${clearedCategory.name}”`}
        closeLabel="Close clear stack"
        width="w-[28rem]"
        onDismiss={dismiss}
        onClose={close}
      >
        {clearedCategory && (
          <div className="px-4 pb-4">
            {deck.clearCategory.isError && (
              <p
                role="alert"
                className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
              >
                Could not clear that stack — {ipcError(deck.clearCategory.error)}
              </p>
            )}
            <ClearCategory
              category={clearedCategory}
              variant={variant}
              pending={clearPending}
              onCancel={dismiss}
              onCleared={() => clearCategory(clearedCategory.id, { onSuccess: dismiss })}
            />
          </div>
        )}
      </Dialog>

      {/* **The one overlay two controls open**, and the only one whose scope decides which. The
          header's `Export deck` opens it over the deck; a category heading's right-click opens
          it over one pile, and *that* scope is still an overlay with no control in this view —
          as the delete and clear confirmations above it are, both opened from the same menu.
          This used to say "the last of the seven, and the only one", then "one of the two", then
          "one of the overlays with no control"; each was made false by the next thing wired. The
          union is the count, and this sentence carries none.

          `cards` is an argument the dialog never fetches — which is exactly what let a deck-level
          export be a caller rather than a rewrite — and it is derived from the deck's live list
          rather than from whatever the control was holding. See {@link exported}. */}
      <ExportDialog
        open={layer?.kind === "export"}
        subject={exported.subject}
        surface="deck"
        cards={exported.cards}
        suggestedFileName={exported.fileName}
        onDismiss={dismiss}
        onClose={close}
      />

      {/* The pull, beside the transfer pair because it is the third way cards reach this deck —
          and the one that moves cardboard the reader already has rather than writing a list.

          **Fed rather than fetching**, which is `ExportDialog`'s arrangement one overlay up and
          for a sharper version of its reason: the read is gated on this layer being open, and a
          query mounted inside a component that only exists while the dialog is up would make
          "does a closed dialog cost a round trip" a question about `AnimatePresence`'s teardown
          instead of about one `enabled` flag. See {@link pullPlan}.

          **The mutation goes down whole and narrowed by the dialog's own type**, exactly as
          `DeckStats`' `send` does — so the write is `useDeck`'s single definition (with its three
          invalidations) and the dialog owns the sentence it words about the answer.

          **`dismiss` rather than `close`**, and the dialog takes one callback rather than the two
          `Dialog` splits: every way out of this one is the reader saying "put me back" — its ✕,
          its Cancel, Escape — and the caret's destination is a button in the stats band two
          screens down the page, which is precisely where a reader who has just shut this expects
          to be. `close` exists for the click-away, and a scrim press here is not one this surface
          distinguishes. */}
      <PullFromCollectionDialog
        open={layer?.kind === "pull"}
        deckName={row?.name ?? ""}
        cardName={pulledCard?.name ?? null}
        rows={pulledRows}
        loading={pullPlan.isLoading}
        readError={pullPlan.isError ? ipcError(pullPlan.error) : null}
        pull={deck.pullFromCollection}
        onClose={dismiss}
      />

      {/* **Which wish those copies came off**, and the third of the editor's overlays with no
          button in this view — a card's right-click is the affordance, like the delete and clear
          confirmations above.

          **The card and the count come off the layer, and the wishes do too** — which is the one
          place this file freezes a payload rather than re-reading it. `deck_quick_add_wishes`
          answered for one printing at one finish and the reader was shown that answer; a second
          read here would be re-asking a question they have already been given, and would let the
          list change under an open radio group. `quickCategory`'s exception, for its reason.

          **Its refusal is drawn inside the panel** rather than in the editor's banner, which is
          behind this scrim — the delete confirmation's rule. The banner still gets it, because
          the write is in `writes`; what this passes is the same sentence said where the reader
          is looking. */}
      <QuickUnwishDialog
        open={layer?.kind === "quickUnwish"}
        cardName={unwish?.card.name ?? null}
        copies={unwish?.copies ?? 0}
        wishes={unwish?.wishes ?? NO_WISHES}
        pending={deck.quickAddToCollection.isPending}
        failure={unwishFailure}
        onConfirm={(wishId) => {
          if (unwish === null) return;
          writeQuickAdd(
            { card: unwish.card, quantity: unwish.copies, wishId },
            // Closed on the answer rather than on the press, so a refusal leaves the question
            // open with its sentence under it — `ClearCategory`'s arrangement, and the reason
            // the panel takes a `failure` at all.
            { onSuccess: dismiss },
          );
        }}
        onDismiss={dismiss}
        onClose={close}
      />

      {/* The quick zones' New category, which is the third overlay in this view with no control
          to open it — a drop is not a press, and there is nowhere to hand the caret back to. It
          draws `createCategory`'s refusal itself rather than leaning on the editor's banner, for
          the delete confirmation's reason one dialog up: that banner is behind this scrim. */}
      <QuickCategoryDialog
        open={layer?.kind === "quickCategory"}
        cardName={quickCategoryPayload?.name ?? ""}
        pending={meta.createCategory.isPending}
        failure={
          meta.createCategory.isError
            ? `Could not make that category — ${ipcError(meta.createCategory.error)}`
            : null
        }
        onCreate={createQuickCategory}
        onDismiss={dismiss}
        onClose={close}
      />
    </section>
  );
}
