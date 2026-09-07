/**
 * The tokens and emblems the open deck needs, and the writes that change them.
 *
 * **The read is derived on every open and the writes store only deviations**, which is what
 * decides everything below. Rust resolves each deck card's `all_parts` against the corpus and
 * joins whatever the reader stored against that token; `deckTokenViews` turns those rows into
 * what the wall draws. So this hook owns exactly two things — the query key, and the arithmetic
 * that turns "the reader changed one field" into a write the backend can take.
 *
 * **The key is `["decks", "tokens", deckId, variant]`, under the `["decks"]` root on purpose.**
 * `useDeck`'s own `invalidate` fires that root for every write to what is *in* a deck, so adding
 * a card, moving one between piles or switching a category off already refreshes this list — and
 * it should, because all three change what the deck makes. A key of this feature's own would have
 * to be invalidated by every one of those writes, from a file that has no reason to know this
 * area exists.
 *
 * **No `staleTime`.** `query.ts` caches 30 s app-wide, which is the whole budget; a second one
 * here could only make a missing invalidation *invisible*, and the derived list has to move the
 * moment a deck card does.
 *
 * **No `marketplace` in the key either.** Nothing this answers is priced — a token is not a card
 * anybody buys — so carrying it would be two cached answers to one question, refetched on a
 * switch that cannot change it.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type DeckVariant } from "@/lib/ipc";
import { writeFailure } from "@/lib/writes";
import { DEFAULT_VARIANT, opened } from "./useDeck";
import {
  deckTokenViews,
  type DeckTokenRow,
  type DeckTokenState,
  type DeckTokenView,
} from "./deckTokens";

/**
 * Stable identity for "no tokens" — an unloaded deck, a deck with no cards and a deck whose
 * cards make nothing all read this, and {@link useDeckTokens}' `useMemo` keys off it.
 *
 * `query.data ?? []` would be a fresh array on every render, so the views would be rebuilt and
 * re-sorted for every keystroke anywhere in the editor.
 */
const NO_ROWS: readonly DeckTokenRow[] = [];

/**
 * The three columns `deck_tokens` stores, as one value.
 *
 * All three are nullable together: a token nobody has touched has **no row at all**, and that is
 * the state every derived token starts in.
 */
interface TokenOverride {
  cardId: string | null;
  quantity: number | null;
  state: DeckTokenState | null;
}

/** The absence of a row, spelled once — what {@link storedOverride} answers for a token the
 *  reader has never deviated on. */
const NO_OVERRIDE: TokenOverride = { cardId: null, quantity: null, state: null };

/**
 * What is currently stored against one token, or {@link NO_OVERRIDE}.
 *
 * **Every write here sends the whole triple, and this is what lets it.** `deck_token_set` takes
 * `card_id`, `quantity` and `token_state` and reads an absent one as *no value* rather than as
 * *leave it alone* — there is no `coalesce` on that command, because the row it upserts is
 * defined by what it carries and is deleted outright when it would carry nothing. So a caller
 * sending only the field it changed would silently clear the other two: picking a different art
 * for a token the reader had set to 4 copies would put the count back to 1.
 *
 * It reads the **stored** columns rather than the effective values a {@link DeckTokenView} draws,
 * and that distinction is the load-bearing one. `view.printingId` is `cardId ?? defaultCardId` —
 * so writing it back would pin a reader who only changed the count to whatever art the resolver
 * happened to name today, and the next deck edit that moved the default would find that token no
 * longer following it. An untouched field stays untouched.
 */
function storedOverride(rows: readonly DeckTokenRow[], oracleId: string): TokenOverride {
  const row = rows.find((r) => r.oracleId === oracleId);
  if (row === undefined) return NO_OVERRIDE;
  return { cardId: row.cardId, quantity: row.quantity, state: row.state };
}

/**
 * The tokens and emblems one deck needs, with the reader's deviations applied.
 *
 * `deckId` is nullable for {@link useDeck}'s reason: a caller with no deck open mounts an idle
 * query rather than branching around one, and `enabled` is what keeps `opened` unreachable.
 *
 * `variant` defaults to {@link DEFAULT_VARIANT}, imported rather than respelled so that every
 * deck hook in this folder means the same list by the same word. **The derived list is
 * per-variant because deck cards are; the override is not** — `deck_tokens` is grained on
 * `(deck_id, oracle_id)` with no variant term, which is why every write below invalidates the
 * deck's tokens for *both* lists rather than only the one on screen.
 */
export function useDeckTokens(deckId: number | null, variant: DeckVariant = DEFAULT_VARIANT) {
  const queryClient = useQueryClient();

  /**
   * Whether dismissed tokens are on the wall.
   *
   * **Plain `useState`, with the views a `useMemo` over it — never state synced in an effect.** A
   * dismissal is a deviation the reader stored and `showDismissed` is a question about this
   * session's view of it, so there are two facts and one derivation rather than three facts that
   * have to be kept in agreement. It is deliberately not persisted: a reader who revealed a
   * dismissed token in order to put it back has finished with the switch by the time they close
   * the deck.
   */
  const [showDismissed, setShowDismissed] = useState(false);

  const query = useQuery({
    queryKey: ["decks", "tokens", deckId, variant],
    queryFn: () => ipc.deckTokens(opened(deckId), variant),
    enabled: deckId !== null,
  });

  const rows = query.data ?? NO_ROWS;

  /** The wall, in order — emblems last, then by name, dismissals dropped unless asked for. */
  const tokens: DeckTokenView[] = useMemo(
    () => deckTokenViews(rows, { showDismissed }),
    [rows, showDismissed],
  );

  /**
   * This deck's tokens in **both** lists — `["decks", "tokens", deckId]`, one segment short of
   * the query key.
   *
   * The override is not grained on variant, so a token dismissed while reading the Actual list is
   * dismissed in the plan too; an invalidation naming one variant would leave the other tab
   * drawing a deviation the reader has just removed, for as long as `query.ts`'s 30 s allows.
   *
   * **On success only.** Each of the three commands is a single statement against one row, so a
   * refusal leaves the table exactly as this cache already describes it — there is nothing to
   * re-read, and the sentence {@link writeFailure} draws is what says the press did not land.
   */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["decks", "tokens", deckId] });
  };

  /**
   * The override write — one mutation with four callers below, because it is one command.
   *
   * A result that would carry nothing (`auto`, no printing, no quantity) **deletes** the row
   * rather than storing it, which is the backend's rule and not this hook's: the empty override
   * is not representable, so "the reader has not deviated" stays one state rather than two that
   * would have to be kept in agreement.
   */
  const set = useMutation({
    mutationFn: ({ oracleId, over }: { oracleId: string; over: TokenOverride }) =>
      ipc.deckTokenSet(opened(deckId), oracleId, over),
    onSuccess: invalidate,
  });

  /** The picker's write: a token nothing in the deck derives, on the wall because the reader
   *  said so. */
  const add = useMutation({
    mutationFn: (cardId: string) => ipc.deckTokenAdd(opened(deckId), cardId),
    onSuccess: invalidate,
  });

  /** Back to the derived defaults — it deletes the row, which is what `overridden` offers. */
  const clear = useMutation({
    mutationFn: (oracleId: string) => ipc.deckTokenClear(opened(deckId), oracleId),
    onSuccess: invalidate,
  });

  /** One field changed against whatever the row already holds — see {@link storedOverride}. */
  const write = (oracleId: string, change: Partial<TokenOverride>) => {
    set.mutate({ oracleId, over: { ...storedOverride(rows, oracleId), ...change } });
  };

  return {
    /** The query itself, for a caller that needs more than {@link loading} and {@link failure} —
     *  a panel's empty state reads `isSuccess` to tell "this deck makes nothing" from "nothing
     *  has answered yet", which are two sentences and not one. */
    query,
    /** Every token and emblem to draw, in order. Never `undefined`: an unloaded deck answers the
     *  empty wall, because a deck that derives nothing is a supported state and not an error. */
    tokens,
    /** The first read is in flight. **Gated on the deck as well as on the query**, because an
     *  `enabled: false` query is `pending` for ever and a gallery with no deck open must not
     *  report a spinner. */
    loading: deckId !== null && query.isPending,
    /** The most recently started write's refusal as a sentence, or `null`. `writeFailure`'s rule
     *  — the newest write owns the banner, whatever its outcome — so a refused dismissal does not
     *  leave its sentence up over a printing swap that then worked. */
    failure: writeFailure([set, add, clear]),
    /**
     * Pin one token's art to a printing the reader picked.
     *
     * Keeps whatever quantity and state the row already carries. Passing the resolver's own
     * `defaultCardId` still **stores** it, which is the honest reading of the press: the reader
     * chose that art, and a deck edit that moved the default must not move it back under them.
     * {@link reset} is how they hand the choice back.
     */
    setPrinting: (oracleId: string, cardId: string) => write(oracleId, { cardId }),
    /**
     * How many copies of one token the reader wants.
     *
     * **`0` is a value and not an absence**, so it is stored: a token zeroed while its art is
     * kept is a decision, and the read side is written with `??` for the same reason.
     */
    setQuantity: (oracleId: string, quantity: number) => write(oracleId, { quantity }),
    /** Take one token off the wall. The row survives — this is `state: "hidden"` and not a
     *  delete — so {@link showDismissed} can find it again. */
    dismiss: (oracleId: string) => write(oracleId, { state: "hidden" }),
    /**
     * Put a dismissed token back.
     *
     * **Which state it goes back to depends on whether the deck still derives it**, because
     * `state` is one column and `hidden` therefore costs a `manual` row its manual-ness. A token
     * the deck makes goes back to `auto` and follows the deck again — and if that leaves the row
     * carrying nothing at all the backend deletes it, which is exactly right. A token nothing
     * derives can only be on the wall as `manual`, so restoring it to `auto` would take it off
     * the wall a second time, in the one press whose whole meaning is the opposite.
     */
    restore: (oracleId: string) => {
      const derived = rows.find((r) => r.oracleId === oracleId)?.derived ?? false;
      write(oracleId, { state: derived ? "auto" : "manual" });
    },
    /** Undo every deviation on one token — the affordance `DeckTokenView.overridden` drives. Not
     *  a {@link setPrinting} of three nulls: that is the same write, and this one says what the
     *  reader pressed. */
    reset: (oracleId: string) => clear.mutate(oracleId),
    /** Add a token by hand, by printing — the picker's press. Rust resolves the oracle id and
     *  writes it `manual`, so it is drawn whether or not anything in the deck makes it. */
    addToken: (cardId: string) => add.mutate(cardId),
    showDismissed,
    setShowDismissed,
  };
}

/** The whole of what the panel consumes, named so the view and the hook agree. */
export type DeckTokens = ReturnType<typeof useDeckTokens>;
