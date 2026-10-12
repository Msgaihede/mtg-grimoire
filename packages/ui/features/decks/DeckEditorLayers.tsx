import { useCallback, useMemo } from "react";
import { Dialog } from "@/components/Dialog";
import { ExportDialog } from "@/features/transfer/export/ExportDialog";
import type { ImportDestination } from "@/features/transfer/import/destination";
import { deckDestination } from "@/features/transfer/import/destinations/deckInto";
import { newDeckDestination } from "@/features/transfer/import/destinations/newDeck";
import { NewDeckPreview } from "@/features/transfer/import/destinations/NewDeckPreview";
import { ImportDialog } from "@/features/transfer/import/ImportDialog";
import { plural } from "@/lib/counts";
import {
  ipcError,
  type DeckCard,
  type DeckFinish,
  type DeckQuickAddWish,
  type DeckVariant,
} from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { AddLabelDialog } from "./AddLabelDialog";
import { AddMissingToCollectionDialog } from "./AddMissingToCollectionDialog";
import { CategoriesDialog, DeleteCategory } from "./CategoriesDialog";
import { ClearCategory } from "./ClearCategory";
import { exportSubject } from "./deckExport";
import { DeckHistoryDialog } from "./DeckHistoryDialog";
import { DeckSettingsDialog } from "./DeckSettingsDialog";
import type { DragPayload } from "./dnd";
import { LabelsDialog } from "./LabelsDialog";
import { deckCardPullKey, pullKey } from "./pullPlan";
import { PullFromCollectionDialog } from "./PullFromCollectionDialog";
import { QuickUnwishDialog } from "./QuickUnwishDialog";
import { QuickCategoryDialog } from "./QuickZones";
import { TheoryDiffDialog, type WishesSent } from "./TheoryDiffDialog";
import type { Deck, useMissingPlan, usePullPlan } from "./useDeck";
import type { DeckMeta } from "./useDeckMeta";

/*
 * **The deck editor's layers** — the `Layer` union that says which one is up, and the overlays it
 * opens, mounted as one block (issue #557). Moved out of `DeckEditor.tsx` with every word of their
 * argument; the editor still owns the one `useState<Layer>` slot, `openLayer`, the hand-back and
 * every write a layer ends in, and hands them down. What lives here is what only a layer reads:
 * which pile a confirmation is about, what the export dialog is fed, the rows a pull is narrowed
 * to, the two import destinations.
 *
 * **Mounted from the editor's top level, as siblings of the layout and never inside it** — the
 * comment over the dialogs below says why a transformed or `@container` ancestor would pin one to
 * a column. This component draws no box of its own (a fragment), so the mount stays exactly where
 * it was.
 */

/** Stable identity for the wishes a *closed* {@link QuickUnwishDialog} is handed. The shell
 *  mounts no body while it is shut, so nothing reads this — a fresh `[]` on every render would
 *  still be a new prop on every render of the deck, which is the kind of churn `NO_ROWS` in
 *  `PullFromCollectionDialog` exists to avoid. */
const NO_WISHES: readonly DeckQuickAddWish[] = [];

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
export type Layer =
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
   * (`packages/ui/CLAUDE.md`): a surface the reader *consults* is a centred modal, and only a surface
   * they work *out of* while editing beside it earns a place in the layout. This is consulted —
   * a plan is read, a few numbers are set, and it is shut — and it is consulted at the widest
   * grain anything in this editor asks about: every hole in the list, and every unallocated copy
   * on the reader's desk that could fill one. A docked column of that would take its width from
   * the deck for the whole session; the desk row measures 602px at the app's own 1280×800 with
   * the card pane docked, and the deck's own floor is what runs out first.
   *
   * **The card, or absent for the whole deck — and the payload arrived on 2026-09-03.** It used
   * to carry nothing, on the argument that `deck_pull_plan` takes the deck and no variant (it
   * reads the live list, because a plan holds no cardboard for a pull to move copies into), so
   * there was nothing for an arm to hold that the editor did not already know. That is still true of the *read*: a
   * deck card's `Collection ▸ Pull …` (issue #350) fetches the same plan under the same key and
   * this arm narrows only what the dialog is handed — the rows whose key matches this card's
   * {@link deckCardPullKey}, and that card's name for the subtitle.
   *
   * **So the payload is what the dialog draws, never what is read**, which is why the query's
   * gate below asks `layer?.kind === "pull"` and not {@link layerMatches}: both shapes want the
   * same plan, and a gate that distinguished them would spend a second `deck_pull_plan` on the
   * card entrance for an answer already in the cache.
   *
   * `null` for the opener on the theory tab is unchanged and is still not a disabled button:
   * there is no question to ask there, rather than a question with an empty answer.
   *
   * **`cards` since issue #510**, where it was one `card`: a picked set's `Pull N from your
   * collection` opens the same dialog over every picked row that is short, and one card is a set
   * of one.
   */
  | { kind: "pull"; cards?: readonly DeckCard[] }
  /**
   * **Add missing to collection** — the copies the reader has just bought, recorded into this
   * deck's own group.
   *
   * **It carries no payload and can never grow one, which is the whole of what separates it
   * from `pull` directly above.** That arm grew a `card` on 2026-09-03 because the pull has two
   * entrances — the stats band's deck-wide press and a deck card's `Collection ▸ Pull …` — so
   * its *kind* stopped being enough to say which control is open, and {@link layerMatches}
   * needed a clause to tell them apart. This one has exactly one opener and structurally cannot
   * acquire a second: the per-card form of this press already exists as `Collection ▸ Quick add
   * N copies`, a menu row that writes outright with no dialog at all, because one row's
   * shortfall is a number the menu label already quotes. So `layerMatches` needs no clause for
   * it, and a future `card` field here would mean the per-card menu had grown a preview — which
   * is a different feature and would be a different arm.
   *
   * **A full-window overlay for the pull's reason**: it is *consulted* — a plan is read, some
   * counts are set, it is shut — rather than worked out of, and the widest thing this editor
   * asks about does not get to take width off the desk for the session.
   *
   * The band draws its opener only on the live list, and `null` there is absent rather than
   * greyed: a plan holds no cardboard, so there is nowhere on that list to record copies into.
   * Not because there is nothing to be short of — since 2026-09-09 the band's own count is
   * truthful on the plan (issue #435) — but because `deck_missing_plan` walks the live list and
   * a record files cardboard into the deck's group.
   */
  | { kind: "addMissing" }
  /**
   * **Which wish these copies come off** — a deck card's `Collection ▸ Quick add N and remove
   * from wishlist`, whenever the card has a line on the wishlist at all (issues #350 and #511).
   *
   * **Every field is frozen on purpose, which is `quickCategory`'s exception rather than
   * `export`'s rule.** The arms that carry an id name a row the editor re-reads the deck into;
   * this one names a **press that is over**: the reader right-clicked one row, the menu quoted
   * one number off it, and `deck_quick_add_wishes` has already answered for that printing and
   * finish. Looking any of it back up would be looking up the answer the reader was shown.
   *
   * `wishes` is never empty — {@link chooseWish} writes outright for none and asks for one or
   * more, because the read answers every printing and finish of the card and a lone line is not
   * certainly the cardboard just recorded.
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
   * questions — a delete takes the pile and offers somewhere to put the cards, a clear leaves the
   * pile and offers nothing — and a union arm is where a state that means nothing while the other
   * is open belongs.
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
  | { kind: "addLabel"; slots: readonly AddLabelSlot[] }
  | null;

/** The card a label is being put on: the grain `deck_card_set_label` is addressed at, plus the
 *  name {@link AddLabelDialog} says out loud. */
export interface AddLabelSlot {
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
    // {@link deckCardPullKey} rather than by object identity because a `DeckCard` is a fresh
    // object on every `deck_get`. The played-finish key rather than the stored one because it is
    // the key the dialog is narrowed by (`pulledRows`): two cards it cannot tell apart open the
    // same rows, which is the question this asks.
    if (open.cards === undefined || target.cards === undefined) {
      return open.cards === undefined && target.cards === undefined;
    }
    const keys = (cards: readonly DeckCard[]) => cards.map(deckCardPullKey).join("\n");
    return keys(open.cards) === keys(target.cards);
  }
  return true;
}

/** What the layers need from the editor: the slot, its two closers, and the writes a layer ends
 *  in. Each is the editor's own value, handed through unchanged. */
export interface DeckEditorLayersProps {
  deckId: number;
  variant: DeckVariant;
  layer: Layer;
  dismiss: () => void;
  close: () => void;
  deck: Deck;
  meta: DeckMeta;
  /** The deck's name, or `""` before `deck_get` has answered. */
  deckName: string;
  categories: Deck["categories"];
  tracks: boolean;
  setCardLabelOnSlot: (slots: readonly AddLabelSlot[], labelId: number) => void;
  createLabelFor: (slots: readonly AddLabelSlot[], name: string, color: string) => void;
  setCompareSent: (sent: WishesSent) => void;
  pullPlan: ReturnType<typeof usePullPlan>;
  missingPlan: ReturnType<typeof useMissingPlan>;
  createQuickCategory: (name: string) => void;
}

/**
 * Every overlay the editor owns, mounted unconditionally — each unmounts its body behind its own
 * `open`, so a closed one costs no query, no listener and no state (the comment over them says
 * so at length). A fragment rather than a box, so the overlays stay direct children of the
 * editor's `<section>`.
 */
export function DeckEditorLayers({
  deckId,
  variant,
  layer,
  dismiss,
  close,
  deck,
  meta,
  deckName,
  categories,
  tracks,
  setCardLabelOnSlot,
  createLabelFor,
  setCompareSent,
  pullPlan,
  missingPlan,
  createQuickCategory,
}: DeckEditorLayersProps) {
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
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
        deckName,
      ),
    [exportedId, categories, deck.cards, deckName],
  );

  /** The cards an open pull is about, or `null` for the deck-wide press. */
  const pulledCards = layer?.kind === "pull" ? (layer.cards ?? null) : null;

  /** The subtitle's scope: the card's own name, or `N cards` for a picked set. */
  const pulledName =
    pulledCards === null
      ? null
      : pulledCards.length === 1
        ? pulledCards[0].name
        : plural(pulledCards.length, "card");

  /**
   * What the pull dialog draws: the whole plan, or the rows for one card.
   *
   * **The narrowing is here rather than in the dialog**, which is that component's own fence —
   * it holds no notion of a {@link pullKey} and therefore cannot come to disagree with this
   * about which rows belong to which card. And it is derived from the **live** query rather
   * than frozen into the layer, so a pull made from the dialog re-reads the plan and the rows
   * under the reader's eyes are the rows a second press would write.
   *
   * The key is `(cardId, played finish)`, which is the grain the plan is folded to — the same
   * card short in two piles is one row of it — so a deck card's key matches at most one row and
   * the filter is a lookup rather than a subset — once per picked card. **The card side is
   * {@link deckCardPullKey} and the row side {@link pullKey}**, because a row carries the finish
   * the card _plays_ (its stored finish, else the printing's sole finish): keyed on the stored
   * column, a foil-only printing added from the search — no finish stored — looked for `id|`
   * against a plan row `id|foil`, and the dialog opened on *Nothing to pull.* over copies the
   * reader owns (issue #563's follow-up).
   */
  const pulledRows = useMemo(() => {
    const rows = pullPlan.data;
    if (rows === undefined) return null;
    if (pulledCards === null) return rows;
    const wanted = new Set(pulledCards.map(deckCardPullKey));
    return rows.filter((planRow) => wanted.has(pullKey(planRow)));
  }, [pullPlan.data, pulledCards]);

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

  // The confirmations' and the quick-unwish dialog's writes, read off the editor's observers.
  const clearCategory = deck.clearCategory.mutate;
  const clearPending = deck.clearCategory.isPending;
  const writeQuickAdd = deck.quickAddToCollection.mutate;
  const quickCategoryPayload = layer?.kind === "quickCategory" ? layer.payload : null;

  return (
    <>
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
        cardName={layer?.kind === "addLabel" ? (layer.slots[0]?.name ?? null) : null}
        cardCount={layer?.kind === "addLabel" ? layer.slots.length : 1}
        choices={addLabelChoices}
        pending={meta.createLabel.isPending}
        onPick={(labelId) => {
          if (layer?.kind !== "addLabel") return;
          setCardLabelOnSlot(layer.slots, labelId);
          dismiss();
        }}
        onCreate={(name, color) => {
          if (layer?.kind !== "addLabel") return;
          createLabelFor(layer.slots, name, color);
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
        onSent={setCompareSent}
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
        closeLabel="Close"
        // Narrow, because the body is one question, one picker and two buttons — the width class
        // is written out whole, since Tailwind emits no rule for a class built at runtime.
        size="w-[28rem]"
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
                Couldn't delete that category — {ipcError(meta.deleteCategory.error)}
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
        closeLabel="Close"
        size="w-[28rem]"
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
                Couldn't clear that stack — {ipcError(deck.clearCategory.error)}
              </p>
            )}
            <ClearCategory
              category={clearedCategory}
              variant={variant}
              // {@link tracks}, inverted: the confirmation's second sentence promises a folder
              // the reader's copies go back to, and a virtual deck has no group for them to
              // arrive in. Not a fourth reading of `variant` — see `ClearDeck`'s own prop.
              virtual={!tracks}
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
          distinguishes.

          **This mount takes no `tracks` term, and the three that could have carried one do not
          either** (`pull`, `addMissing`, `quickUnwish`). The fence is upstream and it is the
          *opener*: `DeckStats`' two presses are `null` on a Virtual deck and the card menu's
          `Collection ▸` submenu is not built, so no press anywhere in this editor can set one of
          those three arms. A second test here would be a second answer to a question already
          settled — and the wrong one to reach for, because it would draw a dialog that is *open*
          with a plan it may not read. What the query behind it does take is the term, for the
          reason written at {@link pullPlan}: a read Rust refuses by name must not run. */}
      <PullFromCollectionDialog
        open={layer?.kind === "pull"}
        deckName={deckName}
        cardName={pulledName}
        rows={pulledRows}
        loading={pullPlan.isLoading}
        readError={pullPlan.isError ? ipcError(pullPlan.error) : null}
        pull={deck.pullFromCollection}
        onClose={dismiss}
      />

      {/* **Add missing to collection**, beside the pull because they are two answers to one
          number and the reader reaches them from two buttons an inch apart. Everything the
          mount above says applies unchanged: the plan is **fed rather than fetched** (the read
          is `missingPlan`, gated on this layer, so a closed dialog costs nothing and the
          question is not about `AnimatePresence`'s teardown), the mutation goes down **whole**
          and narrowed by the dialog's own `AddMissingWrite` so the write stays `useDeck`'s
          single definition with its four invalidations, and the dialog owns the sentence it
          words about the answer.

          **No `cardName`, and that is the one prop the pull has that this cannot.** The pull is
          reached from a card's right-click as well as from the band; this is not, so there is no
          one card for a subtitle to name — the arm's own doc says why that is structural rather
          than a gap.

          **`dismiss` rather than `close`**, the pull's reason exactly: every way out of this
          dialog is the reader saying "put me back", and the caret's destination is a button in
          the stats band two screens down the page. */}
      <AddMissingToCollectionDialog
        open={layer?.kind === "addMissing"}
        deckName={deckName}
        rows={missingPlan.data ?? null}
        loading={missingPlan.isLoading}
        readError={missingPlan.isError ? ipcError(missingPlan.error) : null}
        add={deck.addMissingToCollection}
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
            ? `Couldn't create that category — ${ipcError(meta.createCategory.error)}`
            : null
        }
        onCreate={createQuickCategory}
        onDismiss={dismiss}
        onClose={close}
      />
    </>
  );
}
