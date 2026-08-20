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
import { DeckDialog } from "./DeckDialog";

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
 * the whole benefit of {@link DeckDialog} mounting nothing while it is closed. A closed dialog
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
      // The marketplace is this hook's own. Nothing here reads a price — only `oracleId` — but
      // the argument is not optional, and passing the surface's own is the one answer that
      // cannot be wrong.
      const detail = await ipc.cardDetail(row.cardId, marketplace);
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
 * list.
 *
 * **One direction, and the footer says so in words.** The other direction — what Live holds and
 * Theory dropped — is a cut the reader already made and needs no row. What *is* here is every
 * exact card the plan holds that the deck has not got — printing **and** finish — with the piles
 * they sit in ignored. That is a product decision
 * taken in `deck_theory.rs`; drawing it silently would make a correct list read as a broken one,
 * which is why {@link ONE_DIRECTION} is copy rather than a comment.
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
 * **The chrome is {@link DeckDialog}'s and no longer this file's** (2026-08-16) — the last of the
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
 * been sent — lives in {@link TheoryDiffBody}, so closing the dialog unmounts all of it and
 * reopening starts a genuinely new question. The alternative, one component that renders `null`
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
    <DeckDialog
      open={open}
      title={
        <>
          Theory <span aria-hidden="true">→</span>
          <span className="sr-only">to</span> Live
        </>
      }
      // The heading draws the arrow; the name says it in words. What a screen reader makes of
      // "→" ranges from "right arrow" to silence, so the panel cannot be labelled by a heading
      // that is half an `aria-hidden` glyph — see {@link DeckDialogProps.ariaLabel}.
      ariaLabel="Theory to Live difference"
      subtitle="What you would need to buy or pull to build the theory list"
      closeLabel="Close the difference list"
      width="w-[47.5rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <TheoryDiffBody deckId={deckId} />
    </DeckDialog>
  );
}

/** The shopping list itself — the query, the two writes and the body's own scroller. Mounted only
 *  while the dialog is open, which is {@link DeckDialog}'s guarantee and what makes the record of
 *  sent rows below a session rather than something an effect has to clear. */
function TheoryDiffBody({ deckId }: { deckId: number }) {
  // Read here rather than threaded from the editor: this dialog is mounted only while it is
  // open, already holds a query client of its own, and a shopping list is exactly the surface
  // a reader would open *because* they have just changed which shop they are pricing against.
  const { marketplace } = useMarketplace();
  const { query, rows, wishAll, wishRow } = useTheoryDiff(deckId, marketplace.id);
  const totals = useMemo(() => diffTotals(rows), [rows]);

  /**
   * The rows a press has already put on the wishlist, so the button can say so.
   *
   * By {@link rowKey}, never by `cardId` — the backend tells a foil line from the regular one,
   * so `cardId` is shared by up to three rows. Kept here rather than read off the mutation,
   * because a mutation remembers only its last variables and a reader presses several. **Rows
   * sharing an oracle card therefore mark separately while writing one folded wish**, which is
   * right: the reader pressed two buttons and each says what that press did.
   */
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());

  const bulkLabel = `Send all ${rows.length} to wishlist`;
  // The **writes'** refusals, and deliberately not the read's: a failed read already has a place
  // on this surface — the list's own body, where the rows would have been — and repeating it in
  // the footer would be one fault announced as two.
  const failure = wishAll.error ?? wishRow.error ?? null;

  return (
    // The shell's header sits above these three, and the panel around them is the `flex flex-col`
    // that makes the scroller work — see {@link DeckDialog}.
    <>
      <FigureStrip
        totals={totals}
        cards={rows.length}
        marketplace={marketplace}
        pending={query.isPending}
      />

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
                key={rowKey(row)}
                row={row}
                currency={marketplace.currency}
                sent={sent.has(rowKey(row))}
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
  totals: Totals;
  cards: number;
  /** Which marketplace "Cost to build" is quoted in. */
  marketplace: Marketplace;
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

/** One line of the shopping list: the card, what it costs, and the one thing to do about it. */
function Row({
  row,
  currency,
  sent,
  pending,
  onWishlist,
}: {
  row: TheoryDiffRow;
  /** How the row's one unit price is written. Which price it *is* was decided by the query. */
  currency: Currency;
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

      {/* How many more, in the data face. `sr-only` says the word, because "3×" beside a name is
          a glyph a screen reader reads as "three x". */}
      <span className="shrink-0 font-mono text-[0.7rem] tabular-nums text-dim">
        <span aria-hidden="true">{row.quantity}×</span>
        <span className="sr-only">{row.quantity} more</span>
      </span>

      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate text-sm">{row.name}</span>
        {/* **The line's whole reason for being a separate line, where a name alone would make
            two rows read as a duplicate.** `FinishMark` draws nothing for the regular copy,
            which is right: the plain card is the unmarked case everywhere else in the app, and
            a mark on every row says nothing. The glyph carries its own `role="img"` and label,
            so a screen reader hears "Foil" beside the name rather than reading a shape. */}
        <FinishMark finish={row.finish ?? "nonfoil"} />
      </span>

      {/* The pile it is wanted *for*, which is what makes a shopping list readable. */}
      <span className="hidden shrink-0 truncate text-[0.7rem] text-dim sm:block">
        {row.categoryName}
      </span>

      {/* The printing the price belongs to. The direction's row leaves it out; it is here because
          the price beside it is *this* printing's own rate and the strip's total is the sum of
          them — a figure a reader cannot attribute to a card they can name is a figure they cannot
          check. Same spelling as every other card row in the app. */}
      <span className="hidden shrink-0 font-mono text-[0.7rem] tabular-nums text-dim md:block">
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
