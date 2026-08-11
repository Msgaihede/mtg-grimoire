import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CardImage } from "@/components/CardImage";
import { Figure } from "@/components/Figure";
import { cardImageUrl } from "@/lib/images";
import { ipc, ipcError, type TheoryDiffRow } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { PRICES_AS_OF, usdPrice } from "@/lib/prices";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { FOCUS } from "./cardControl";

/** Stable identity for "not read yet", so the totals below are not recomputed over a new empty
 *  array on every render of a dialog that is still waiting. */
const NO_ROWS: readonly TheoryDiffRow[] = [];

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
 * What the plan is short of, and the two ways to buy it.
 *
 * **Read-only about the deck**: nothing here adds, removes or moves a card, and neither write
 * below touches `deck_cards` — a shopping list is not an edit. That is why the only cache keys
 * they take are the wishlist's and the search's.
 *
 * `deck_theory_diff` is grouped and subtracted **by the backend, by oracle card**, and this hook
 * deliberately re-derives none of it: needing a second Sol Ring is not answered by owning a
 * different printing of one already in the live list, and a second grouping here would be a
 * second place for that rule to live. The rows arrive ready to draw.
 *
 * Local to this file rather than added to `useDeck`/`useDeckMeta`, because it is one surface's
 * two questions and nothing else in the app asks them.
 *
 * **No `enabled` gate and no nullable deck**, unlike every other hook in this folder — and that is
 * the whole benefit of {@link TheoryDiffDialog} returning `null` before this is ever called. A
 * closed dialog does not mount the panel, so this hook does not exist, so nothing is read. The
 * query is a full pass over both of a deck's lists plus an allocation roll-up per oracle card; a
 * button nobody has pressed should not pay for it, and unmounting says that more plainly than a
 * flag does.
 */
function useTheoryDiff(deckId: number) {
  const queryClient = useQueryClient();

  /**
   * `["decks", "theoryDiff", deckId]` — under the `["decks"]` root, which is the whole of how
   * this stays fresh: every deck write in the app invalidates that prefix, and a theory edit
   * changes this answer. No variant in the key, because the diff *is* the pair.
   */
  const query = useQuery({
    queryKey: ["decks", "theoryDiff", deckId],
    queryFn: () => ipc.deckTheoryDiff(deckId),
  });

  /**
   * What a wish changes, and it is never the deck.
   *
   * `["wishlist"]` for the list itself, and `["cards", "search"]` for the reason
   * `useDeck.missingToWishlist` takes it: both writes below make **any-printing** wishes, and
   * `CardSummary.wishlisted` is an `EXISTS` against `c.oracle_id` — so one press turns the heart
   * on for every printing of every card sent, and a search left on screen behind this dialog is
   * visibly wrong rather than stale in a field nothing draws.
   *
   * **Not `["decks"]`**, unlike its live twin: `deck_theory_missing_to_wishlist` writes wishes
   * and commits, with no `allocate_deck` anywhere in it. Nothing about the deck moved.
   */
  const bought = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
  }, [queryClient]);

  /** The footer's one press: the whole difference, in one transaction, answering how many wishes
   *  were touched. */
  const wishAll = useMutation({
    mutationFn: () => ipc.deckTheoryMissingToWishlist(deckId),
    onSuccess: bought,
  });

  /**
   * One row's press — and it writes the **same shape** as the footer's, which is the whole reason
   * it is two calls rather than one.
   *
   * `deck_theory_missing_to_wishlist` writes `add_wish { oracle_id, name, quantity }`: an
   * any-printing wish, because a shopping list is not a printing preference. `wishlistAdd` with a
   * `cardId` writes a **pinned** wish instead, and the wishlist grain is
   * `(oracle_id, card_id, preferred_finish)` — so the pinned row and the any-printing row are two
   * different wishes for one card. A reader who pressed nine row buttons would then hold a
   * different wishlist from one who pressed the footer once, for the same nine cards.
   * `.storybook/fake/db.test.ts`'s "makes a pinned wish and an any-printing wish two different
   * wishes" is that fact, stated from the other side.
   *
   * {@link TheoryDiffRow} carries no oracle id — deliberately, because the surface draws a
   * printing and a count — so the oracle id is read from the printing the row names. One extra
   * round trip on a button pressed a handful of times, against a wishlist that folds.
   *
   * **`row.quantity` and nothing else.** {@link TheoryDiffRow.ownedSpare} is not subtracted here
   * and must never be: `quantity` has already had the live list taken out of it and `ownedSpare`
   * has not, so netting them counts the live list twice — the backend refuses the same
   * arithmetic, in the same words, at `missing_to_wishlist`.
   */
  const wishRow = useMutation({
    mutationFn: async (row: TheoryDiffRow) => {
      const detail = await ipc.cardDetail(row.cardId);
      const oracleId = detail?.oracleId ?? null;
      // The same row the backend's loop skips — `let Some(oracle_id) = … else { continue }` —
      // said out loud instead of silently, because a button that reports success and wrote
      // nothing is worse than one that says why. Reachable only for an orphan: no live row has
      // a null `oracle_id` (0 of 116,590).
      if (oracleId === null) {
        throw new Error(`${row.name} has left the card database, so it cannot be wishlisted.`);
      }
      return ipc.wishlistAdd({ oracleId, name: row.name, quantity: row.quantity });
    },
    onSuccess: bought,
  });

  return { query, rows: query.data ?? NO_ROWS, wishAll, wishRow };
}

/** The three figures the strip prints, over the rows it captions. */
interface Totals {
  /** Copies, not rows: a card wanted three more times counts three. */
  copies: number;
  /** The shown printings' nonfoil `usd`, times the copies wanted. */
  costUsd: number;
  /** Copies the sum above could not price, so the total never lies by rounding down. */
  unpriced: number;
  /** The plain sum of {@link TheoryDiffRow.ownedSpare} — see {@link FigureStrip}. */
  spare: number;
}

/**
 * The strip's arithmetic, and the one line of it worth reading twice.
 *
 * `costUsd` sums **the row's own printing's** price, which is what `unitPriceUsd` is: the nonfoil
 * `usd` key of that printing's `prices` blob, never `cards.price_usd`, which is a display fallback
 * chain and must not be summed.
 *
 * `spare` is a **plain sum** of a display field. It is deliberately not `min(spare, quantity)`, not
 * subtracted from `copies`, and not netted against anything: the moment it enters an arithmetic
 * with `quantity` it counts the live list twice, which is the bug this row's doc comment in
 * `ipc.ts` exists to prevent. A reader may well own five spare Sol Rings while needing one; the
 * figure says so, and says nothing else.
 */
export function diffTotals(rows: readonly TheoryDiffRow[]): Totals {
  let copies = 0;
  let costUsd = 0;
  let unpriced = 0;
  let spare = 0;
  for (const row of rows) {
    copies += row.quantity;
    if (row.unitPriceUsd === null) unpriced += row.quantity;
    else costUsd += row.unitPriceUsd * row.quantity;
    spare += row.ownedSpare;
  }
  return { copies, costUsd, unpriced, spare };
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
 * list.
 *
 * **One direction, and the footer says so in words.** The other direction — what Live holds and
 * Theory dropped — is a cut the reader already made and needs no row. That is a product decision
 * taken in `deck_theory.rs`; drawing it silently would make a correct list read as a broken one,
 * which is why {@link ONE_DIRECTION} is copy rather than a comment.
 *
 * **A real modal, which is the one place this surface parts company with every other layer in the
 * app.** The card pane, the validation panel, the row menus and the set picker are all anchored,
 * non-`aria-modal` layers over a page that stays live, because they are things a reader consults
 * *while* editing. This is not: it covers the editor, it is centred, and its two buttons write to
 * a list outside the deck. So it traps the caret and hands it back — and it is still an `"inner"`
 * Escape rung, so one press closes it and the card pane behind the view keeps its own.
 *
 * Escape and an outside click are deliberately different: Escape is the reader saying "put me
 * back", so `onDismiss` returns the caret to whatever opened this; a click on the scrim is the
 * reader already being somewhere else, so `onClose` moves nothing. That is the rule
 * `useDismissOnEscape` states for every layer here, and this one has a scrim to hang the second
 * half on.
 *
 * **Not portalled, and `fixed` — so where it is mounted matters.** Nothing in this app is
 * portalled (the shipped CSP is `style-src 'self'` and every overlay primitive in reach injects a
 * runtime `<style>`; `SetCombobox`'s finding). A `fixed` element is positioned against the
 * viewport *unless* an ancestor carries a `transform`, `filter` or `contain`, any of which makes
 * that ancestor the containing block instead — the deck editor has transformed elements in it,
 * so this belongs at the editor's top level rather than inside a column or a row.
 *
 * **`open` is a mount, not a class.** Everything with state — the query, the two mutations, the
 * caret, the record of which rows have been sent — lives one component down, so closing the dialog
 * unmounts all of it and reopening starts a genuinely new question. The alternative, one component
 * that renders `null` late, keeps every one of those alive behind a flag and has to remember to
 * clear each: the first version of this file did, and its reset was an effect that called
 * `setState` — a cascading render, and the thing React's own lint rule exists to stop.
 */
export function TheoryDiffDialog({
  deckId,
  open,
  onDismiss,
  onClose,
}: TheoryDiffDialogProps): React.JSX.Element | null {
  if (!open) return null;
  return <Panel deckId={deckId} onDismiss={onDismiss} onClose={onClose} />;
}

/** The dialog itself, mounted only while it is open — see {@link TheoryDiffDialog}. */
function Panel({ deckId, onDismiss, onClose }: Omit<TheoryDiffDialogProps, "open">) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { query, rows, wishAll, wishRow } = useTheoryDiff(deckId);
  const totals = useMemo(() => diffTotals(rows), [rows]);

  /**
   * The rows a press has already put on the wishlist, so the button can say so.
   *
   * By `cardId`, which is unique per row — the backend groups by oracle card, so one card is one
   * row. Kept here rather than read off the mutation, because a mutation remembers only its last
   * variables and a reader presses several.
   */
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());

  // The `"inner"` rung. `useCallback`, because `onDismiss` is a dependency of the hook's effect
  // and an unstable one re-registers the window listener on every render of the dialog. No
  // `enabled`: this component exists only while the dialog is open.
  const dismiss = useCallback(() => onDismiss(), [onDismiss]);
  useDismissOnEscape({ layer: "inner", onDismiss: dismiss });

  // The caret moves into the layer on the way in, as it does for every other one in the app: the
  // dialog's own controls are then the next thing Tab reaches, and Escape has something to hand
  // back. The panel itself and not a control — the reader has not decided anything yet, and a
  // stray Enter should not send nine cards to the wishlist for them.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const bulkLabel = `Send all ${rows.length} to wishlist`;
  // The **writes'** refusals, and deliberately not the read's: a failed read already has a place
  // on this surface — the list's own body, where the rows would have been — and repeating it in
  // the footer would be one fault announced as two.
  const failure = wishAll.error ?? wishRow.error ?? null;

  return (
    // The scrim. `fixed`, not the canvas's `absolute`: the canvas's inset-0 is relative to its own
    // artboard, and a modal in the shipped window covers the window rather than whichever
    // positioned ancestor it happens to be mounted inside.
    //
    // `LAYER.dragTray` is the rung the direction asks for and the right one — above every popup,
    // below `SyncProgress`'s takeover, which really does outrank a shopping list. The *name*
    // belongs to the editor's remove tray; `layers.ts` wants a `modal` entry of its own at the
    // same height, and this file is not the one that may add it.
    //
    // The number is deliberately not written out here, in prose or anywhere else: Tailwind's
    // scanner reads a comment as eagerly as it reads code, so naming the class in a sentence
    // emits a rule for it — and `layers.test.ts`'s sweep counts that as a second place the scale
    // is written. It caught this very line.
    <div
      className={cn("fixed inset-0 flex items-center justify-center bg-bg/70 p-4", LAYER.dragTray)}
      // A press on the scrim and nowhere else. `onMouseDown` rather than `onClick`, because a
      // click fires on the nearest common ancestor of press and release — so a drag that starts
      // on a row's name and ends past the panel's edge is a "click" on the scrim, and the dialog
      // would vanish under a reader who was selecting a card name.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        // The heading is "Theory → Live", and an arrow is not a word: what a screen reader makes
        // of "→" ranges from "right arrow" to silence. The name says it in words; the heading
        // draws it.
        aria-label="Theory to Live difference"
        // The caret stays inside, which is what makes the `aria-modal` above true rather than
        // merely claimed — see {@link trapTab}.
        onKeyDown={(e) => trapTab(e, panelRef.current)}
        className={cn(
          "flex max-h-[80%] w-full max-w-[47.5rem] flex-col overflow-hidden rounded-xl border",
          "border-border bg-bg shadow-2xl",
          FOCUS,
        )}
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h2 className="font-heading text-xl leading-none">
            Theory <span aria-hidden="true">→</span>
            <span className="sr-only">to</span> Live
          </h2>
          <p className="min-w-0 flex-1 truncate text-xs text-dim">
            What you would need to buy or pull to build the theory list
          </p>
          <button
            type="button"
            // The header's ✕ is the reader saying "put me back", exactly as Escape is — so it
            // hands the caret over rather than dropping it where the dialog used to be.
            onClick={onDismiss}
            aria-label="Close the difference list"
            className={cn(
              "-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-dim",
              "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <FigureStrip totals={totals} cards={rows.length} pending={query.isPending} />

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {query.isPending ? (
            <p className="px-2 py-6 text-center text-xs text-dim">Reading the plan…</p>
          ) : query.isError ? (
            // The read's own refusal, in the backend's words. Not a retry button: the query
            // refetches itself the next time the dialog opens, and every write in the app already
            // invalidates the key it sits under.
            <p className="px-2 py-6 text-center text-xs text-dim">{ipcError(query.error)}</p>
          ) : rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-dim">
              The two lists agree. Everything the plan asks for is already in the deck.
            </p>
          ) : (
            <ul>
              {rows.map((row) => (
                <Row
                  key={row.cardId}
                  row={row}
                  sent={sent.has(row.cardId)}
                  pending={wishRow.isPending && wishRow.variables?.cardId === row.cardId}
                  onWishlist={() =>
                    wishRow.mutate(row, {
                      onSuccess: () => setSent((was) => new Set(was).add(row.cardId)),
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
                the card pane both made for the same reason — a hover is not a reader. */}
            <p className="text-[0.7rem] text-dim">{PRICES_AS_OF}</p>
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
            onClick={() => wishAll.mutate()}
            // Nothing to send, and nothing sent twice while the write is in flight. A second
            // press would fold rather than duplicate — `add_wish` upserts on the grain — so this
            // is about the reader not being told twice, rather than about the data.
            disabled={rows.length === 0 || wishAll.isPending}
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
      </div>
    </div>
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
  pending,
}: {
  totals: Totals;
  cards: number;
  pending: boolean;
}) {
  const dash = (value: string) => (pending ? "—" : value);
  return (
    // The row's own bottom border, not `FigureRow`'s: this strip sits between two other bordered
    // bands and needs the padding a dialog band has, which `FigureRow` — built for the top of a
    // page — does not carry.
    <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-border px-5 py-3.5">
      <Figure
        label="Copies to find"
        value={dash(String(totals.copies))}
        note={pending ? undefined : `${cards} ${cards === 1 ? "card" : "cards"}`}
      />
      <Figure
        label="Cost to build"
        value={dash(usdPrice(totals.costUsd))}
        // The same shape the wishlist's "Still to buy" uses: a total that silently omits the
        // copies it could not price is a number that lies by rounding down.
        note={!pending && totals.unpriced > 0 ? `${totals.unpriced} unpriced` : undefined}
        title={PRICES_AS_OF}
      />
      <Figure
        label="Already owned"
        value={dash(String(totals.spare))}
        note={pending ? undefined : "spare copies"}
        // Said in full on hover because the figure cannot be read correctly without it: this is
        // not "how many of these you have covered". It is a count of loose copies, and it is
        // deliberately not subtracted from anything above.
        title={
          "Copies of these cards in your collection that no built deck has claimed. " +
          "Not subtracted from what the plan needs."
        }
      />
    </dl>
  );
}

/** One line of the shopping list: the card, what it costs, and the one thing to do about it. */
function Row({
  row,
  sent,
  pending,
  onWishlist,
}: {
  row: TheoryDiffRow;
  sent: boolean;
  pending: boolean;
  onWishlist: () => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-surface motion-reduce:transition-none">
      {/* The `art` crop (626×457), as decoration beside the name — `aria-hidden`, empty alt and
          `draggable={false}`, which is the deck row's arrangement for the deck row's reasons. The
          frame keeps the line's geometry while the art is arriving and stays a quiet blank for a
          printing that has none. Through `CardImage`, never a bare `<img>`: this is a *slot*, and
          a browser paints an `<img>`'s last decoded frame until the new src decodes, so the
          picture would lag the name by the length of the fetch. */}
      <span
        aria-hidden="true"
        className="h-8 w-11 shrink-0 overflow-hidden rounded bg-surface"
      >
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

      {/* How many more, in the data face. `sr-only` says the word, because "3×" beside a name is
          a glyph a screen reader reads as "three x". */}
      <span className="shrink-0 font-mono text-[0.7rem] tabular-nums text-dim">
        <span aria-hidden="true">{row.quantity}×</span>
        <span className="sr-only">{row.quantity} more</span>
      </span>

      <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>

      {/* The pile it is wanted *for*, which is what makes a shopping list readable. */}
      <span className="hidden shrink-0 truncate text-[0.7rem] text-dim sm:block">
        {row.categoryName}
      </span>

      {/* The printing the price belongs to. The direction's row leaves it out; it is here because
          the price beside it is *this* printing's `usd` and the strip's total is the sum of them —
          a figure a reader cannot attribute to a card they can name is a figure they cannot
          check. Same spelling as every other card row in the app. */}
      <span className="hidden shrink-0 font-mono text-[0.7rem] tabular-nums text-dim md:block">
        {row.setCode.toUpperCase()} · {row.collectorNumber}
      </span>

      <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums">
        {usdPrice(row.unitPriceUsd)}
      </span>

      <button
        type="button"
        onClick={onWishlist}
        disabled={sent || pending}
        // Named for the card, because a list of twelve buttons all called "Wishlist" is twelve
        // controls a screen reader cannot tell apart — and the quantity, because that is what the
        // press actually writes.
        aria-label={`Wishlist ${row.quantity} more ${row.name}`}
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

/**
 * Keep Tab inside the dialog.
 *
 * The one thing `aria-modal` promises that no attribute can deliver: the app behind this really
 * is still in the tab order, so without this a few presses of Tab walk the caret out into an
 * editor the reader cannot see and cannot get back from. Written here rather than reached for
 * from a library because the app ships `style-src 'self'` and every overlay primitive in reach
 * injects a runtime `<style>` — `SetCombobox`'s finding, and the reason nothing in this app is
 * portalled.
 *
 * Cycling both ways off the *live* list of focusables, read on each press: the row buttons
 * disable themselves as they are used, and a list captured once would send the caret to a control
 * the browser now skips.
 */
function trapTab(e: React.KeyboardEvent, panel: HTMLElement | null): void {
  if (e.key !== "Tab" || panel === null) return;
  const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
  // Nothing to cycle between — an empty or failed diff, where the ✕ may be the only control. The
  // panel itself holds the caret, which is where the open effect put it.
  if (focusable.length === 0) {
    e.preventDefault();
    panel.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  // `document.activeElement`, not `e.target`: the caret may be on the panel itself, which is
  // `tabIndex={-1}` and therefore in neither end of the list.
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/** What counts as a stop on the way round. `[tabindex="-1"]` is excluded by the selector rather
 *  than by the filter, so the panel itself never appears in its own cycle. */
const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
