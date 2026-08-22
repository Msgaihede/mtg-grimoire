import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CardImage } from "@/components/CardImage";
import { Figure } from "@/components/Figure";
import { FinishMark } from "@/components/FinishMark";
import { FINISH_LABEL } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { cardImageUrl } from "@/lib/images";
import { ipc, ipcError, type TheoryDiffRow } from "@/lib/ipc";
import type { Currency, Marketplace, MarketplaceId } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { Dialog } from "@/components/Dialog";

/** Stable identity for "not read yet", so the totals below are not recomputed over a new empty
 *  array on every render of a dialog that is still waiting. */
const NO_ROWS: readonly TheoryDiffRow[] = [];

/**
 * What makes one line of this list itself — the printing **and** the object played, which is
 * `deck_theory::group_key` read from this end.
 *
 * **`cardId` alone is not unique here and must not be used as a key.** The backend tells a foil
 * copy from the regular one (2026-08-20), so a plan calling for both is two rows carrying the
 * same `cardId` — two React children under one key, and one `sent` mark that would light both.
 *
 * **It is also the wire format**, since 2026-08-22: `deck_theory_missing_to_wishlist`'s `only`
 * argument is a list of exactly these strings. So the string this file keys a render by, ticks a
 * checkbox by and sends to the backend by is one string, computed in one place — a second
 * spelling would be a selection that silently wrote somebody else's rows.
 */
function rowKey(row: TheoryDiffRow): string {
  return `${row.cardId}|${row.finish ?? ""}`;
}

/**
 * The sentence this dialog exists to say out loud.
 *
 * A difference list that shows one direction and does not say so reads as a bug — the reader
 * counts the cards they cut, does not find them, and concludes the list is broken. It is not: a
 * cut is a decision already made and needs no row (`deck_theory.rs`'s own words). So the footer
 * says it, in words, where the number it qualifies is.
 */
const ONE_DIRECTION =
  "Only what Theory wants and Live does not have. Cards in Live but not in Theory are cuts you " +
  "have already made, so they are not listed.";

/**
 * The second sentence of the same kind, drawn beside the control it is about.
 *
 * Two counts that add up to more than the list is the same "correct list that reads as broken"
 * {@link ONE_DIRECTION} exists to prevent, one axis over: `Missing 4` beside
 * `Different printing 2` over a five-row list looks like arithmetic nobody can check, and it is
 * simply a row that is partly both — two copies wanted with one already on the table. The
 * second half is the fact a reader has no way to guess: **the comparison is per _object_**, so
 * the live list holding the regular copy of the exact printing the plan asks for in foil is a
 * different printing for this purpose.
 *
 * In the band rather than in the footer, because it explains the segmented control and a reader
 * reading a count is looking at the count. Always drawn, never hovered: a hover is not a reader,
 * which is this file's rule for the as-of line already.
 */
const VIEW_NOTE =
  "A card can be in both views — and a different finish counts as a different printing.";

/**
 * Which half of the difference the list is showing.
 *
 * **Two overlapping questions and the union of them, never three buckets.** `missing` is
 * "copies I would have to find", `other` is "copies the deck is already playing as something
 * else", and a row can answer both — theory 2× art A against live 1× art B is one copy to find
 * and one already on the table. Partitioning them would force that row into one answer and make
 * the other one a lie.
 */
type DiffView = "all" | "missing" | "other";

/**
 * The control's rungs, in the order it draws them — **and deliberately not through
 * `sortOptions`.** `lib/options.ts` exempts a list whose order *is* the information, and this is
 * one: `All` is the whole difference and the two beside it are readings of it, so the row is a
 * widening ladder rather than an alphabet. Sorting it would put `Different printing` first and
 * make the group read as three peers.
 */
const VIEWS: readonly DiffView[] = ["all", "missing", "other"];

const VIEW_LABEL: Record<DiffView, string> = {
  all: "All",
  missing: "Missing",
  other: "Different printing",
};

/**
 * What "nothing here" means, which is a different sentence for each rung.
 *
 * The unfiltered one is the answer this dialog was written for — the two lists agree — and it is
 * the only one that is about the *deck*. The other two are about the **filter**: rows exist and
 * this reading of them is empty, which is a fact worth telling apart from a plan that is fully
 * built. One sentence for both would be wrong on whichever case it was not written for.
 */
const NOTHING_SHOWN: Record<DiffView, string> = {
  all: "The two lists agree. Everything the plan asks for is already in the deck.",
  missing:
    "Nothing here is missing. Every copy the plan asks for is already on the table as another " +
    "printing.",
  other:
    "No substitutions. Every copy the plan asks for is one the deck has not got in any printing.",
};

/**
 * Whether a row belongs to a reading of the difference.
 *
 * Both tests are against {@link TheoryDiffRow.heldAsOtherPrinting}, which the backend answers
 * per row and this file re-derives nothing of — the same rule the whole surface follows about
 * `deck_theory_diff`'s arithmetic. `quantity > heldAsOtherPrinting` is "at least one copy left
 * to find"; `heldAsOtherPrinting > 0` is "at least one copy already on the table". A row where
 * both hold shows under both, at its full quantity.
 */
function inView(row: TheoryDiffRow, view: DiffView): boolean {
  if (view === "missing") return row.quantity > row.heldAsOtherPrinting;
  if (view === "other") return row.heldAsOtherPrinting > 0;
  return true;
}

/**
 * The sentence a row wears beside its name when the live list is already playing some of it,
 * or `null` for the ordinary row that is simply not there.
 *
 * **The row's count is untouched by this and that is the rule the whole surface hangs on**: a
 * line shows its full `quantity` in every view, because the number on screen is what a press
 * writes. So the qualification is a *note*, in words, and never a second number the button
 * disagrees with — which is the same reason {@link TheoryDiffRow.ownedSpare} is a display field
 * and never a term in an arithmetic.
 *
 * Two shapes and no more. A row the live list covers entirely says so plainly — the `3×` beside
 * it already says how many that is — and a partly-covered row spells the split out, because
 * "some of these are already on the table" is the one reading a reader cannot get from the
 * numbers on screen.
 */
function heldNote(row: TheoryDiffRow): string | null {
  if (row.heldAsOtherPrinting <= 0) return null;
  if (row.heldAsOtherPrinting >= row.quantity) return "Already played as another printing";
  return `${row.heldAsOtherPrinting} of ${row.quantity} already played as another printing`;
}

/**
 * What the plan is short of, and the two ways to buy it.
 *
 * **Read-only about the deck**: nothing here adds, removes or moves a card, and neither write
 * below touches `deck_cards` — a shopping list is not an edit. That is why the only cache keys
 * they take are the wishlist's and the search's.
 *
 * `deck_theory_diff` is grouped and subtracted **by the backend, on the exact card**, and this hook
 * deliberately re-derives none of it. A second grouping here would be a second place for that
 * rule to live — which is not hypothetical: `DeckEditor` kept one until 2026-08-20, to count the
 * "N cards differ" readout the `Compare` button replaced, and it disagreed with this command in
 * both directions it was possible to disagree in. The rows arrive ready to draw.
 *
 * Local to this file rather than added to `useDeck`/`useDeckMeta`, because it is one surface's
 * two questions and nothing else in the app asks them.
 *
 * **No `enabled` gate and no nullable deck**, unlike every other hook in this folder — and that is
 * the whole benefit of {@link Dialog} mounting nothing while it is closed. A closed dialog
 * does not mount {@link TheoryDiffBody}, so this hook does not exist, so nothing is read. The
 * query is a full pass over both of a deck's lists plus an allocation roll-up per line; a
 * button nobody has pressed should not pay for it, and unmounting says that more plainly than a
 * flag does.
 */
function useTheoryDiff(deckId: number, marketplace: MarketplaceId) {
  const queryClient = useQueryClient();

  /**
   * `["decks", "theoryDiff", deckId, marketplace]` — under the `["decks"]` root, which is the
   * whole of how this stays fresh: every deck write in the app invalidates that prefix, and a
   * theory edit changes this answer. No variant in the key, because the diff *is* the pair; a
   * marketplace, because it prices every row of the shopping list this draws.
   */
  const query = useQuery({
    queryKey: ["decks", "theoryDiff", deckId, marketplace],
    queryFn: () => ipc.deckTheoryDiff(deckId, marketplace),
  });

  /**
   * What a wish changes, and it is never the deck.
   *
   * `["wishlist"]` for the list itself, and `["cards", "search"]` because
   * `CardSummary.wishlisted` is an `EXISTS` against `c.oracle_id` — so one press turns the heart
   * on for **every** printing of every card sent, whatever printing the wish was pinned to, and
   * a search left on screen behind this dialog is visibly wrong rather than stale in a field
   * nothing draws.
   *
   * **Not `["decks"]`**, unlike its live twin: `deck_theory_missing_to_wishlist` writes wishes
   * and commits, with no `allocate_deck` anywhere in it. Nothing about the deck moved.
   */
  const bought = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
  }, [queryClient]);

  /**
   * The footer's one press: the keys the reader left ticked, in one transaction, answering how
   * many wishes were touched.
   *
   * **Always an explicit key list, never the absent argument that means "the whole
   * difference".** The two differ exactly for rows that appeared between this dialog's read and
   * the press — the backend re-reads the diff inside the write — and those are rows the reader
   * never saw. Sending them would be the dialog acting on its own, which is `only`'s own
   * argument for being an include list read from the other end.
   */
  const wishAll = useMutation({
    mutationFn: (only: readonly string[]) => ipc.deckTheoryMissingToWishlist(deckId, only),
    onSuccess: bought,
  });

  /**
   * One row's press — **the same command, with one key**, which is what makes "the row button
   * writes the same shape as the footer" true by construction.
   *
   * It used to be `card_detail` for an oracle id and then `wishlist_add` for an any-printing
   * wish, with a paragraph here asking the next reader to keep the two writes in step, and a
   * hand-written refusal for the orphan row whose printing has left the card database. All of
   * that is the backend's now: `deck_theory_missing_to_wishlist` pins the wish to the printing
   * the plan names and carries its finish, and its loop skips an orphan itself. A rule that
   * lives in one command cannot drift between two buttons, so the doc comment asking somebody to
   * keep them the same is gone with the code that needed it — and so is a round trip on a button
   * pressed a handful of times.
   *
   * **The variables stay the row rather than the key**, because the row is what the pending
   * check below compares and what `onSuccess` marks; the key is one call away from either.
   *
   * **`row.quantity` is not passed and never was.** The backend re-reads the difference and
   * writes what that row is short of, which is the one number that cannot have gone stale behind
   * an open dialog — and {@link TheoryDiffRow.ownedSpare} is not netted out of it there either,
   * for the reason `ipc.ts` states at the field: `quantity` has already had the live list taken
   * out of it and `ownedSpare` has not.
   */
  const wishRow = useMutation({
    mutationFn: (row: TheoryDiffRow) => ipc.deckTheoryMissingToWishlist(deckId, [rowKey(row)]),
    onSuccess: bought,
  });

  return { query, rows: query.data ?? NO_ROWS, wishAll, wishRow };
}

/** The three figures the strip prints, over the rows it captions. */
interface Totals {
  /** Copies, not rows: a card wanted three more times counts three. */
  copies: number;
  /** The shown printings' unit price at the marketplace the diff was read at, times the copies
   *  wanted. */
  cost: number;
  /** Copies the sum above could not price, so the total never lies by rounding down. */
  unpriced: number;
  /** The plain sum of {@link TheoryDiffRow.ownedSpare} — see {@link FigureStrip}. */
  spare: number;
}

/**
 * The strip's arithmetic, and the one line of it worth reading twice.
 *
 * **Taken over the rows on screen, not over every row the backend answered** (2026-08-22). A
 * filtered list whose caption still counted the rows it is not drawing is a figure a reader
 * cannot check against the thing under it, which is the same complaint the `cost` note below
 * answers about unpriced copies. This function does not know about the filter and must not: it
 * sums what it is handed, and the caller hands it what it drew.
 *
 * `cost` sums **the row's own printing's** price, which is what `unitPrice` is: what that
 * printing costs at the marketplace the diff was read at, in whichever finish it is sold in,
 * never `cards.price_usd`, which is the same chain precomputed for the search's sort and is the
 * column nothing here sums. A row that marketplace does not quote is
 * *counted* as unpriced rather than charged at anything — there is no second number to reach
 * for, and reaching to another marketplace for one is the thing this whole shape forbids.
 *
 * `spare` is a **plain sum** of a display field. It is deliberately not `min(spare, quantity)`, not
 * subtracted from `copies`, and not netted against anything: the moment it enters an arithmetic
 * with `quantity` it counts the live list twice, which is the bug this row's doc comment in
 * `ipc.ts` exists to prevent. A reader may well own five spare Sol Rings while needing one; the
 * figure says so, and says nothing else.
 *
 * **A plain sum is only honest because `ownedSpare` answers on a row's whole identity** —
 * printing and finish — which it has since 2026-08-20. Any wider answer puts the same binder
 * copies on two rows and this line adds them up twice.
 *
 * **{@link TheoryDiffRow.heldAsOtherPrinting} is not netted out of `copies` either**, for the
 * same reason and one step further: a row shows its full quantity in every view, so the figure
 * over it has to be the full quantity too. What the live list is already playing is said in
 * words, on the row — see {@link heldNote}.
 */
export function diffTotals(rows: readonly TheoryDiffRow[]): Totals {
  let copies = 0;
  let cost = 0;
  let unpriced = 0;
  let spare = 0;
  for (const row of rows) {
    copies += row.quantity;
    if (row.unitPrice === null) unpriced += row.quantity;
    else cost += row.unitPrice * row.quantity;
    spare += row.ownedSpare;
  }
  return { copies, cost, unpriced, spare };
}

export interface TheoryDiffDialogProps {
  deckId: number;
  open: boolean;
  /** Escape: hand focus back to whatever opened the dialog, then close. */
  onDismiss: () => void;
  /** Outside click: close without moving focus. */
  onClose: () => void;
}

/**
 * The difference between the deck a reader is planning and the deck they have, as a shopping
 * list they can edit before they send it.
 *
 * **One direction, and the footer says so in words.** The other direction — what Live holds and
 * Theory dropped — is a cut the reader already made and needs no row. What *is* here is every
 * exact card the plan holds that the deck has not got — printing **and** finish — with the piles
 * they sit in ignored. That is a product decision
 * taken in `deck_theory.rs`; drawing it silently would make a correct list read as a broken one,
 * which is why {@link ONE_DIRECTION} is copy rather than a comment.
 *
 * **Two readings of that one list, and they overlap** (2026-08-22). The comparison is on the
 * exact card, so a plan naming one Sol Ring against a deck sleeving another is a full row — right
 * for *buying* and wrong for *playing*, because that deck runs. {@link TheoryDiffRow
 * .heldAsOtherPrinting} is the difference between the two readings and the segmented control is
 * how a reader picks one; {@link VIEW_NOTE} is the sentence that keeps the counts from reading
 * as arithmetic that does not add up.
 *
 * **A real modal, like every other surface that paints a scrim.** The card pane, the validation
 * panel and the set picker are anchored, non-`aria-modal` layers over a page that stays live,
 * because they are things a reader consults *while* editing and nothing covers what is behind
 * them. The editor's full-window overlays are the other kind, and they agree because they are
 * one component: a scrim is a statement that what is behind it is not available, a pointer
 * already cannot cross one, so the caret does not either. Trapped, `aria-modal`, and handed back
 * on the way out — and an `"inner"` Escape rung, so one press closes it and the card pane behind
 * the view keeps its own.
 *
 * **The chrome is {@link Dialog}'s and no longer this file's** (2026-08-16) — the last of the
 * three copies to be folded in, and the one whose header needed the shell to grow. Its heading
 * is `Theory <span aria-hidden>→</span><span class="sr-only">to</span> Live`, because an arrow is
 * not a word: the shell's `title` is a `ReactNode` for this, and `ariaLabel` exists because a
 * heading spelled half in a hidden glyph is not a *name* anything can be addressed by.
 * `DeckEditor.test.tsx`'s Tab sweep addresses this overlay by that string, and it is the only
 * thing that was holding this copy to the shell's behaviour.
 *
 * Escape and an outside click are deliberately different: Escape is the reader saying "put me
 * back", so `onDismiss` returns the caret to whatever opened this; a click on the scrim is the
 * reader already being somewhere else, so `onClose` moves nothing. That is the rule
 * `useDismissOnEscape` states for every layer here, and the shell has a scrim to hang the second
 * half on.
 *
 * **Not portalled, and `fixed` — so where it is mounted matters.** Nothing in this app is
 * portalled (the shipped CSP is `style-src 'self'` and every overlay primitive in reach injects a
 * runtime `<style>`; `SetCombobox`'s finding). A `fixed` element is positioned against the
 * viewport *unless* an ancestor carries a `transform`, `filter` or `contain`, any of which makes
 * that ancestor the containing block instead — the deck editor has transformed elements in it,
 * so this belongs at the editor's top level rather than inside a column or a row.
 *
 * **`open` is a mount, not a class**, and it is the shell's guarantee rather than this file's.
 * Everything with state — the query, the two mutations, the caret, the record of which rows have
 * been sent, **and which rows the reader has unticked** — lives in {@link TheoryDiffBody}, so
 * closing the dialog unmounts all of it and reopening starts a genuinely new question. The
 * alternative, one component that renders `null`
 * late, keeps every one of those alive behind a flag and has to remember to clear each: the first
 * version of this file did, and its reset was an effect that called `setState` — a cascading
 * render, and the thing React's own lint rule exists to stop.
 *
 * **The Escape rung is registered on the flag rather than on the panel's mount**, which the shell
 * owns. With an exit animation the panel outlives `open` by the length of its fade, so a rung
 * that came up with the *element* would still be consuming Escape while the next overlay is
 * opening. `enabled: open` makes the rung die on the render that starts the exit, which is what
 * the editor's `Layer` union has always assumed and used to get for free from a synchronous
 * unmount.
 */
export function TheoryDiffDialog({
  deckId,
  open,
  onDismiss,
  onClose,
}: TheoryDiffDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={open}
      title={
        <>
          Theory <span aria-hidden="true">→</span>
          <span className="sr-only">to</span> Live
        </>
      }
      // The heading draws the arrow; the name says it in words. What a screen reader makes of
      // "→" ranges from "right arrow" to silence, so the panel cannot be labelled by a heading
      // that is half an `aria-hidden` glyph — see {@link DialogProps.ariaLabel}.
      ariaLabel="Theory to Live difference"
      // Widened when the list stopped being purely a shopping list (2026-08-22): a row the live
      // deck already plays as another printing is not a card to buy or pull, and a subtitle that
      // named only those two would be describing the `Missing` view rather than the dialog.
      subtitle="What the plan asks for and the deck has not got — to buy, to pull, or already played as another printing"
      closeLabel="Close the difference list"
      width="w-[47.5rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <TheoryDiffBody deckId={deckId} />
    </Dialog>
  );
}

/** The shopping list itself — the query, the two writes, the reader's selection and the body's
 *  own scroller. Mounted only while the dialog is open, which is {@link Dialog}'s guarantee and
 *  what makes the two records below a session rather than something an effect has to clear. */
function TheoryDiffBody({ deckId }: { deckId: number }) {
  // Read here rather than threaded from the editor: this dialog is mounted only while it is
  // open, already holds a query client of its own, and a shopping list is exactly the surface
  // a reader would open *because* they have just changed which shop they are pricing against.
  const { marketplace } = useMarketplace();
  const { query, rows, wishAll, wishRow } = useTheoryDiff(deckId, marketplace.id);

  const [view, setView] = useState<DiffView>("all");

  /**
   * **The rows the reader has ticked _off_, which is the honest way round.**
   *
   * Every row arrives selected, so the reader's gesture is exclusion and the state is a record
   * of exclusions. That is not a preference: the query refetches under an open dialog — the key
   * sits under `["decks"]`, which every deck write in the app invalidates — so rows can appear
   * while this is on screen, and a set of *selected* keys would have to decide what to do about
   * one it has never seen. With a set of exclusions there is nothing to decide: a new row is not
   * in it, so it is selected, like every other row and like the row it would have been if the
   * refetch had landed a second earlier.
   *
   * By {@link rowKey}, like everything else that addresses a line here.
   */
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());

  /**
   * The rows a press has already put on the wishlist, so the button can say so.
   *
   * By {@link rowKey}, never by `cardId` — the backend tells a foil line from the regular one,
   * so `cardId` is shared by up to three rows. Kept here rather than read off the mutation,
   * because a mutation remembers only its last variables and a reader presses several.
   *
   * **The footer's press deliberately marks nothing.** It answers in the live region, in one
   * sentence, for however many rows it wrote; marking each of them would turn one press into a
   * dozen buttons changing at once and leave the reader nothing to compare against next time
   * they open this. A row button marks its own row because that press *is* about that row.
   */
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());

  /** What the list is drawing, which is what everything below counts. */
  const shown = useMemo(() => rows.filter((row) => inView(row, view)), [rows, view]);
  const totals = useMemo(() => diffTotals(shown), [shown]);

  /** Each rung's own count, over the **whole** difference rather than the shown slice — a
   *  control whose numbers moved when you pressed it could not be used to choose. */
  const counts = useMemo(
    () => ({
      all: rows.length,
      missing: rows.filter((row) => inView(row, "missing")).length,
      other: rows.filter((row) => inView(row, "other")).length,
    }),
    [rows],
  );

  const isPicked = useCallback((row: TheoryDiffRow) => !excluded.has(rowKey(row)), [excluded]);

  /**
   * **Selected ∧ visible** — what the footer writes, and the whole reason the two counts below
   * are separate numbers.
   *
   * A selection survives a change of view, because a reader who unticked a row in `All` did not
   * change their mind by pressing `Missing`. What a press does, though, is bounded by what is on
   * screen: sending a row the current view is not drawing would be the dialog acting on rows the
   * reader is not looking at, which is the same argument `only` makes about rows they have never
   * seen at all.
   */
  const picked = useMemo(() => shown.filter(isPicked), [shown, isPicked]);
  const pickedEverywhere = useMemo(() => rows.filter(isPicked).length, [rows, isPicked]);
  const hiddenPicked = pickedEverywhere - picked.length;

  const allShownPicked = shown.length > 0 && picked.length === shown.length;

  /** One press over the shown rows: all of them, or none of them. Scoped to the view for the
   *  reason above — and to the same set its own readout counts, so the control cannot say one
   *  thing and do another. */
  const toggleAll = useCallback(() => {
    setExcluded((was) => {
      const next = new Set(was);
      for (const row of shown) {
        if (allShownPicked) next.add(rowKey(row));
        else next.delete(rowKey(row));
      }
      return next;
    });
  }, [shown, allShownPicked]);

  const toggleRow = useCallback((key: string) => {
    setExcluded((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * What the press will write, in the number the reader can check against the band.
   *
   * The second shape is the one that keeps "selected ∧ visible" legible: with a filter on, a
   * reader can hold nine ticks and be looking at four of them, and a button that said `Send 4`
   * would read as five presses having gone missing. `Send 4 of 9 selected` says where the other
   * five are — still ticked, in a view this one is not drawing.
   */
  const bulkLabel =
    hiddenPicked > 0
      ? `Send ${picked.length} of ${pickedEverywhere} selected to wishlist`
      : `Send ${picked.length} selected to wishlist`;

  // The **writes'** refusals, and deliberately not the read's: a failed read already has a place
  // on this surface — the list's own body, where the rows would have been — and repeating it in
  // the footer would be one fault announced as two.
  const failure = wishAll.error ?? wishRow.error ?? null;

  return (
    // The shell's header sits above these three, and the panel around them is the `flex flex-col`
    // that makes the scroller work — see {@link Dialog}.
    <>
      {/* The band's own bottom border and padding, not `FigureRow`'s and no longer the `<dl>`'s:
          this strip sits between two other bordered bands, needs the padding a dialog band has,
          and since 2026-08-22 holds a second row that is not a figure. */}
      <div className="space-y-3 border-b border-border px-5 py-3.5">
        <FigureStrip
          totals={totals}
          cards={shown.length}
          marketplace={marketplace}
          pending={query.isPending}
        />
        {/* Hidden while there is nothing to filter or tick — three zeroed rungs and a checkbox
            that can never move are furniture rather than controls, which is `ExportDialog`'s
            rule for a field list with nothing in it. This also covers the pending and refused
            reads, both of which answer no rows. */}
        {rows.length > 0 && (
          <ListControls
            view={view}
            counts={counts}
            onView={setView}
            shown={shown.length}
            picked={picked.length}
            allPicked={allShownPicked}
            onToggleAll={toggleAll}
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {query.isPending ? (
          <p className="px-2 py-6 text-center text-xs text-dim">Reading the plan…</p>
        ) : query.isError ? (
          // The read's own refusal, in the backend's words. Not a retry button: the query
          // refetches itself the next time the dialog opens, and every write in the app already
          // invalidates the key it sits under.
          <p className="px-2 py-6 text-center text-xs text-dim">{ipcError(query.error)}</p>
        ) : shown.length === 0 ? (
          // Which sentence depends on the rung — see {@link NOTHING_SHOWN} — except that an
          // empty *difference* is always the unfiltered answer, whatever rung is selected. A
          // refetch can empty the list under a reader who had filtered it, and "nothing here is
          // missing" said over a plan that is now fully built would be a filter taking credit
          // for the deck.
          <p className="px-2 py-6 text-center text-xs text-dim">
            {rows.length === 0 ? NOTHING_SHOWN.all : NOTHING_SHOWN[view]}
          </p>
        ) : (
          <ul>
            {shown.map((row) => (
              <Row
                key={rowKey(row)}
                row={row}
                currency={marketplace.currency}
                sent={sent.has(rowKey(row))}
                picked={isPicked(row)}
                onPick={() => toggleRow(rowKey(row))}
                // The **whole** identity, for the reason the key is: comparing `cardId` alone
                // would put the spinner on the regular line while the foil one was in flight.
                pending={
                  wishRow.isPending &&
                  wishRow.variables !== undefined &&
                  rowKey(wishRow.variables) === rowKey(row)
                }
                onWishlist={() =>
                  wishRow.mutate(row, {
                    onSuccess: () => setSent((was) => new Set(was).add(rowKey(row))),
                  })
                }
              />
            ))}
          </ul>
        )}
      </div>

      <footer className="flex items-center gap-4 border-t border-border px-5 py-3.5">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[0.7rem] leading-snug text-dim">{ONE_DIRECTION}</p>
          {/* Spec §5: a price is never shown without it, and this surface is nothing but
                prices. Drawn rather than hung on a `title`, which is the choice `DeckEditor` and
                the card pane both made for the same reason — a hover is not a reader. It names
                the marketplace too, because with five in the picker a bare "as of the last
                sync" leaves the reader guessing whose shopping list this is. */}
          <p className="text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>
        </div>

        {/* One live region for every answer this dialog gives, so a reader who cannot see the
              buttons change still hears what the press did. Rendered always, so the region is in
              the tree before it has anything to say — a live region mounted with its own text is
              a region that announces nothing. */}
        <p
          role="status"
          aria-live="polite"
          className="min-w-0 shrink text-right text-[0.7rem] text-dim"
        >
          {failure !== null
            ? ipcError(failure)
            : wishAll.isSuccess
              ? `Sent. ${wishAll.data} ${wishAll.data === 1 ? "wish" : "wishes"} updated.`
              : ""}
        </p>

        <button
          type="button"
          onClick={() => wishAll.mutate(picked.map(rowKey))}
          // Nothing ticked and nothing sent twice while the write is in flight. A second
          // press would fold rather than duplicate — `add_wish` upserts on the grain — so this
          // is about the reader not being told twice, rather than about the data.
          disabled={picked.length === 0 || wishAll.isPending}
          className={cn(
            "h-8 shrink-0 rounded-md border border-accent px-3 text-xs text-accent",
            "transition-colors duration-150 hover:bg-accent hover:text-bg",
            "disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-accent",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          {wishAll.isPending ? "Sending…" : bulkLabel}
        </button>
      </footer>
    </>
  );
}

/**
 * The three numbers over the list, in the app's one figure grammar.
 *
 * An em dash rather than a zero while the first answer is in flight, which is {@link Figure}'s own
 * rule: a list that briefly claims there is nothing to buy is worse than one that has not said.
 */
function FigureStrip({
  totals,
  cards,
  marketplace,
  pending,
}: {
  /** Summed over the rows the list is **drawing** — see {@link diffTotals}. */
  totals: Totals;
  /** How many of those rows there are, which is the count under the copies figure. */
  cards: number;
  /** Which marketplace "Cost to build" is quoted in. */
  marketplace: Marketplace;
  pending: boolean;
}) {
  const dash = (value: string) => (pending ? "—" : value);
  return (
    <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
      <Figure
        label="Copies to find"
        value={dash(String(totals.copies))}
        note={pending ? undefined : `${cards} ${cards === 1 ? "card" : "cards"}`}
      />
      <Figure
        label={`Cost to build (${marketplace.currency.toUpperCase()})`}
        value={dash(formatPrice(totals.cost, marketplace.currency))}
        // The same shape the wishlist's "Still to buy" uses: a total that silently omits the
        // copies it could not price is a number that lies by rounding down — and the count is
        // per currency, because the two do not have the same holes.
        note={!pending && totals.unpriced > 0 ? `${totals.unpriced} unpriced` : undefined}
        title={pricesAsOf(marketplace)}
      />
      <Figure
        label="Already owned"
        value={dash(String(totals.spare))}
        note={pending ? undefined : "spare copies"}
        // Said in full on hover because the figure cannot be read correctly without it: this is
        // not "how many of these you have covered". It is a count of loose copies, and it is
        // deliberately not subtracted from anything above.
        title={
          "Copies of these exact cards in your collection that no built deck has claimed. " +
          "Not subtracted from what the plan needs."
        }
      />
    </dl>
  );
}

/**
 * The second row of the band: which reading of the difference is drawn, and how much of it is
 * ticked.
 *
 * The two sit together because they answer to each other — the select-all's scope is the shown
 * rows, so its readout has to be beside the control that decides which those are. Under the
 * figures rather than over them: the figures are the caption of the list and these are what the
 * caption is taken over, which is the order a reader reads them in.
 */
function ListControls({
  view,
  counts,
  onView,
  shown,
  picked,
  allPicked,
  onToggleAll,
}: {
  view: DiffView;
  /** Each rung's count over the whole difference. */
  counts: Record<DiffView, number>;
  onView: (view: DiffView) => void;
  /** How many rows the current rung draws. */
  shown: number;
  /** How many of those are ticked. */
  picked: number;
  allPicked: boolean;
  onToggleAll: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {/* A real radio group rather than three buttons: one of three is chosen, exactly one is
          true at a time, and `aria-checked` is the only thing that says so to a reader who
          cannot see which one is gold. `ExportDialog`'s format row, at this dialog's own control
          size. */}
      <div role="radiogroup" aria-label="Which rows to show" className="flex flex-wrap gap-2">
        {VIEWS.map((rung) => (
          <button
            key={rung}
            type="button"
            role="radio"
            aria-checked={view === rung}
            onClick={() => onView(rung)}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs",
              "transition-colors duration-150 motion-reduce:transition-none",
              view === rung
                ? "border-accent text-accent"
                : "border-border text-dim hover:border-accent hover:text-accent",
              FOCUS,
            )}
          >
            {VIEW_LABEL[rung]}
            {/* Plain text rather than `aria-hidden` with an `sr-only` twin: the count is part of
                what tells the three rungs apart, and it is inside the control's own name. */}
            <span className="font-mono tabular-nums">{counts[rung]}</span>
          </button>
        ))}
      </div>

      {/* The list header's select-all, in its ordinary shape: checked when every shown row is
          ticked, `indeterminate` when some are, and the readout **is** its accessible name.
          A fixed name plus a separate count would leave a reader who cannot see the band with a
          control whose scope nothing states — and this dialog's one announcing region is the
          footer's, which speaks for presses rather than for the selection. */}
      <label className="ml-auto flex shrink-0 items-center gap-2 text-[0.7rem] text-dim">
        <input
          type="checkbox"
          checked={allPicked}
          // A callback ref rather than an effect: `indeterminate` is a DOM property with no
          // attribute and no React prop, and an inline ref is re-run on every render, so this
          // cannot fall out of step with the count beside it. An effect writing it would be the
          // shape `no-setState-in-an-effect` exists to keep out of this codebase.
          ref={(el) => {
            if (el) el.indeterminate = picked > 0 && !allPicked;
          }}
          onChange={onToggleAll}
          className={cn("size-4 shrink-0 accent-accent", FOCUS)}
        />
        {picked} of {shown} selected
      </label>

      {/* The overlap, said where the counts are. */}
      <p className="w-full text-[0.7rem] leading-snug text-dim">{VIEW_NOTE}</p>
    </div>
  );
}

/**
 * One line of the shopping list: the card, what it costs, whether it is going, and the one thing
 * to do about it on its own.
 *
 * **The row grew a checkbox and a note in a panel that did not grow** (2026-08-22), so two
 * things gave and both are deliberate. The **note is drawn under the name rather than beside
 * it**: at `w-[47.5rem]` the row's content box is ~720px, the fixed columns and the gaps take
 * ~430 of it, and a ~250px sentence on the name's own line would leave the card's name about
 * thirty pixels — a truncated name beside a full sentence about it is the wrong half surviving.
 * Under the name it costs a line of height on the rows that have one and nothing on the rows
 * that do not. And **each optional column moved one rung up the breakpoint ladder** —
 * the pile to `md`, the set and collector number to `lg` — which buys back the checkbox's width
 * at the narrow end. The app's own window floor is **1024px** (`tauri.conf.json`'s `minWidth`),
 * so every column still draws at every size the shipped window can be; what the ladder is for is
 * Storybook's canvas and a browser, where this component is also looked at.
 */
function Row({
  row,
  currency,
  sent,
  picked,
  pending,
  onPick,
  onWishlist,
}: {
  row: TheoryDiffRow;
  /** How the row's one unit price is written. Which price it *is* was decided by the query. */
  currency: Currency;
  sent: boolean;
  /** Whether the footer's press would carry this row. */
  picked: boolean;
  pending: boolean;
  onPick: () => void;
  onWishlist: () => void;
}) {
  const note = heldNote(row);
  // Named for the card the way the row's own button is, and for the same reason: a column of
  // twelve checkboxes all called "Select" is twelve controls a screen reader cannot tell apart.
  // The quantity because that is what a press carries, the finish because two lines can
  // otherwise carry the same name, and the verb different from the button's so that the two
  // controls on one row are not two spellings of one name.
  const pickLabel =
    row.finish === null
      ? `Select ${row.quantity} more ${row.name}`
      : `Select ${row.quantity} more ${FINISH_LABEL[row.finish]} ${row.name}`;

  return (
    <li className="flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-surface motion-reduce:transition-none">
      <input
        type="checkbox"
        checked={picked}
        onChange={onPick}
        aria-label={pickLabel}
        className={cn("size-4 shrink-0 accent-accent", FOCUS)}
      />

      {/* The `art` crop (626×457), as decoration beside the name — `aria-hidden`, empty alt and
          `draggable={false}`, which is the deck row's arrangement for the deck row's reasons. The
          frame keeps the line's geometry while the art is arriving and stays a quiet blank for a
          printing that has none. Through `CardImage`, never a bare `<img>`: this is a *slot*, and
          a browser paints an `<img>`'s last decoded frame until the new src decodes, so the
          picture would lag the name by the length of the fetch. */}
      <span aria-hidden="true" className="h-8 w-11 shrink-0 overflow-hidden rounded bg-surface">
        <CardImage
          src={cardImageUrl(row.cardId, 0, "art")}
          alt=""
          draggable={false}
          // Lazy, for the zone column's reason and not the wall's: this is a plain scroller, so a
          // sixty-card difference really is sixty mounted rows.
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
        />
      </span>

      {/* How many more, in the data face — **the row's full quantity, in every view.** A
          `Different printing` row is not redrawn as a smaller number, because the number on
          screen is what a press writes; what the live list already covers is the note below,
          in words. `sr-only` says the word, because "3×" beside a name is a glyph a screen
          reader reads as "three x". */}
      <span className="shrink-0 font-mono text-[0.7rem] tabular-nums text-dim">
        <span aria-hidden="true">{row.quantity}×</span>
        <span className="sr-only">{row.quantity} more</span>
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm">{row.name}</span>
          {/* **The line's whole reason for being a separate line, where a name alone would make
              two rows read as a duplicate.** `FinishMark` draws nothing for the regular copy,
              which is right: the plain card is the unmarked case everywhere else in the app, and
              a mark on every row says nothing. The glyph carries its own `role="img"` and label,
              so a screen reader hears "Foil" beside the name rather than reading a shape. */}
          <FinishMark finish={row.finish ?? "nonfoil"} />
        </span>
        {note !== null && (
          <span className="min-w-0 truncate text-[0.7rem] text-dim">{note}</span>
        )}
      </span>

      {/* The pile it is wanted *for*, which is what makes a shopping list readable. */}
      <span className="hidden shrink-0 truncate text-[0.7rem] text-dim md:block">
        {row.categoryName}
      </span>

      {/* The printing the price belongs to. The direction's row leaves it out; it is here because
          the price beside it is *this* printing's own rate and the strip's total is the sum of
          them — a figure a reader cannot attribute to a card they can name is a figure they cannot
          check. Same spelling as every other card row in the app. */}
      <span className="hidden shrink-0 font-mono text-[0.7rem] tabular-nums text-dim lg:block">
        {row.setCode.toUpperCase()} · {row.collectorNumber}
      </span>

      <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums">
        {formatPrice(row.unitPrice, currency)}
      </span>

      <button
        type="button"
        onClick={onWishlist}
        disabled={sent || pending}
        // Named for the card, because a list of twelve buttons all called "Wishlist" is twelve
        // controls a screen reader cannot tell apart — the quantity, because that is what the
        // press actually writes, and **the finish, because two lines can otherwise carry the
        // same name**: a plan wanting both objects would give a reader two identical controls.
        aria-label={
          row.finish === null
            ? `Wishlist ${row.quantity} more ${row.name}`
            : `Wishlist ${row.quantity} more ${FINISH_LABEL[row.finish]} ${row.name}`
        }
        className={cn(
          "shrink-0 rounded-md border border-border px-2 py-0.5 text-[0.7rem] text-dim",
          "transition-colors duration-150 hover:border-accent hover:text-accent",
          "disabled:opacity-60 disabled:hover:border-border disabled:hover:text-dim",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        {/* The verb keeps its name through the flow: "Wishlist" becomes "Wishlisted". */}
        {sent ? "Wishlisted" : pending ? "Sending…" : "Wishlist"}
      </button>
    </li>
  );
}
