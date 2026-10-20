/**
 * The tokens and emblems the open deck needs, and the writes that change them.
 *
 * **The read is derived on every open and the writes are to what the reader chose**, which is
 * what decides everything below. Rust resolves each deck card's `all_parts` against the corpus,
 * joins the token's state and **this list's entries** (user schema v52 — one row per printing and
 * finish, or one implicit row for a token the list holds none of), and `deckTokenViews` turns
 * those rows into what the wall draws. So this hook owns exactly two things — the query key, and
 * turning "the reader pressed this on that tile" into the one command that means it.
 *
 * **The key is `["decks", "tokens", deckId, variant, marketplace]`, under the `["decks"]` root on
 * purpose.** `useDeck`'s own `invalidate` fires that root for every write to what is *in* a deck,
 * so adding a card, moving one between piles or switching a category off already refreshes this
 * list — and it should, because all three change what the deck makes. A key of this feature's
 * own would have to be invalidated by every one of those writes, from a file that has no reason
 * to know this area exists. The same root is what a price feed landing sweeps, which is the
 * other reason it is the right one now that the rows carry a price.
 *
 * **No `staleTime`.** `query.ts` caches 30 s app-wide, which is the whole budget; a second one
 * here could only make a missing invalidation *invisible*, and the derived list has to move the
 * moment a deck card does.
 *
 * **The `marketplace` is in the key**, since user schema v51's token pile: each row carries its
 * entry's `unitPrice`, and the pile's chin and heading quote it. So the marketplace is part of
 * the question, exactly as it is for `useDeck`'s `deck_get` — two marketplaces are two answers,
 * and a switch refetches rather than relabelling one feed's numbers as another's. It is read here
 * with `useMarketplace()` rather than taken as an argument — `useDeck`'s arrangement — so every
 * caller and every story keeps the signature it had.
 */
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Finish } from "@/lib/finish";
import { ipc, type DeckVariant, type TokenEntryKey } from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";
import { writeFailure, type Write } from "@/lib/writes";
import { DEFAULT_VARIANT, opened } from "./deckQuery";
import {
  deckTokenViews,
  type DeckTokenRow,
  type DeckTokenView,
  type TokenEntryRef,
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
 * An entry as a write names it — **`null` for an implicit entry**, which is not stored and which
 * Rust materialises in this list only (spec §4.2 rule 2), and the grain's two fields otherwise.
 *
 * Read off `implicit` and never off anything else: an implicit entry still carries a `cardId`
 * and a `finish` (the resolver's default), and sending them would ask Rust to change an entry
 * that does not exist.
 */
function stored(entry: TokenEntryRef): TokenEntryKey | null {
  return entry.implicit ? null : { cardId: entry.cardId, finish: entry.finish };
}

/**
 * The list as the stepper's press says it will be — rules 2 and 3 applied to the cache, for
 * {@link useDeckTokens}' optimistic step.
 *
 * The entry is found the way Rust's `named_entry` finds it: an implicit one by its token alone
 * (a list holds at most one, and only while it stores none of the token), a stored one by its
 * grain. **0 takes a stored entry out unless it is the token's last one here**, which stays at 0
 * — the row's fate as `set_quantity` decides it, so the wall does not draw a 0 for a round trip
 * that the answer then removes. An entry the cache no longer holds leaves the list as it was:
 * the write will say `ENTRY_GONE`, and the guess has nothing to guess about.
 */
function stepped(
  rows: readonly DeckTokenRow[],
  entry: TokenEntryRef,
  quantity: number,
): readonly DeckTokenRow[] {
  const target = rows.findIndex(
    (row) =>
      row.oracleId === entry.oracleId &&
      row.implicit === entry.implicit &&
      (entry.implicit || (row.cardId === entry.cardId && row.finish === entry.finish)),
  );
  if (target === -1) return rows;
  const others = rows.filter((row, at) => at !== target && row.oracleId === entry.oracleId);
  if (quantity === 0 && others.length > 0) return rows.filter((_, at) => at !== target);
  return rows.map((row, at) => (at === target ? { ...row, quantity } : row));
}

/**
 * The tokens and emblems one list of one deck needs, one view per entry.
 *
 * `deckId` is nullable for {@link useDeck}'s reason: a caller with no deck open mounts an idle
 * query rather than branching around one, and `enabled` is what keeps `opened` unreachable.
 *
 * `variant` defaults to {@link DEFAULT_VARIANT}, imported rather than respelled so that every
 * deck hook in this folder means the same list by the same word. **Since v52 the entries are
 * per-list and the state is not**: a step, a swap, an added printing and a removed one name this
 * hook's list, while a removal that takes a hand-added token off the deck ends the token's own
 * row, which both lists read — which is why every write below invalidates the whole root rather
 * than the one list on screen.
 *
 * **No dismissal, no restore, no reset and no switch revealing either** since managed tokens
 * (spec §3.3, §3.4): a token at 0 is how a reader says "not this one" now, and **Remove printing**
 * is what Reset printings did, one entry at a time.
 */
export function useDeckTokens(deckId: number | null, variant: DeckVariant = DEFAULT_VARIANT) {
  const queryClient = useQueryClient();

  // The marketplace prices every row — see the file header for why it is in the key.
  const { marketplace } = useMarketplace();

  const tokensKey = ["decks", "tokens", deckId, variant, marketplace.id] as const;
  const query = useQuery({
    queryKey: tokensKey,
    queryFn: () => ipc.deckTokens(opened(deckId), variant, marketplace.id),
    enabled: deckId !== null,
  });

  const rows = query.data ?? NO_ROWS;

  /** The wall, in order — emblems last, then by name, a token's entries together, and every row:
   *  a `hidden` one an older peer synced in is drawn like any other (spec §3.3). */
  const tokens: DeckTokenView[] = useMemo(() => deckTokenViews(rows), [rows]);

  /**
   * **The whole `["decks"]` root — `useDeck`'s `invalidate`, matched on purpose.**
   *
   * Since v52 a token write is a deck write in every sense the editor draws: it moves the deck's
   * `updatedAt` (the gallery tile's), files a history row (`["decks", "audit", …]`, the history
   * dialog) and files an undo step (`["decks", "undo", …]`, whose answer **is the Undo button's
   * label** — "Undo — Treasure 1 → 3"). Three narrower keys would be three things to keep in step
   * with a command that grows a fourth effect; the root is what every other deck write fires, and
   * it also reaches both lists and every marketplace of this deck's tokens, which a removal that
   * ends a hand-added token needs (its state row is read by both lists) and an art change needs (a
   * cached answer for the marketplace the reader is not on would draw the old printing the moment
   * they switched back).
   *
   * **And `["wishlist"]`, since user schema v55**, which `useDeck` fires after every deck write for
   * the same reason: a theory deck's managed wishlist files the plan's missing tokens in a
   * `Tokens` subfolder (managed tokens spec §3.8), and its dirty triggers watch
   * `deck_token_printings` and `deck_tokens` — so Rust re-settles it after a token step exactly as
   * after a card step, and the wishlist's reads go stale with it. It was left out until then on
   * the argument that no token write touches a card, which was true of the folder and is not now.
   *
   * **On success only.** Each command is one transaction, so a refusal leaves the tables exactly
   * as this cache already describes them — there is nothing to re-read, and the sentence
   * {@link writeFailure} draws is what says the press did not land. **The stepper is the one
   * exception**: its guess has already moved the cache, so a refusal rolls it back and re-reads.
   */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
  };

  /**
   * The stepper's write — rules 2 and 3: an implicit entry is materialised, and a step to 0
   * deletes the entry unless it is the token's last one in this list.
   *
   * **Optimistic on the entry's own number and nothing else** — the fourth copy of the fix
   * `useDeckCore`'s `setQuantity` describes (issue #1160), for its reason: the stepper's `value` is
   * this cache, and the write is absolute, so two presses on a Treasure ×2 inside one round trip
   * both read 2 and both send 3. Cancel first, or an in-flight read of the old list lands on top
   * of the guess; patch only the key the stepper is reading (the other marketplaces' answers are
   * the root's to refresh); roll back on a refusal, because 0 *removes* an entry that is not the
   * token's last here, and a refused removal that stayed removed would be a printing silently gone.
   *
   * **The patch keeps `implicit` as it was.** An implicit entry stepped to 3 is stored once the
   * write lands, but the next press still sending `null` is right: Rust's `named_entry` reads
   * `null` as the default printing's entry whether or not it has been materialised yet.
   *
   * **Only the last press to settle re-reads.** A refetch fired by the first answer while the
   * second write is still in flight can read the list between the two and paint the first press's
   * number over the second's guess — and a third press made in that window is the bug again. So a
   * settle with another step still pending leaves the cache to that step, and the rollback waits
   * for it too: a refusal's snapshot is older than every press made after it.
   */
  const quantityKey = ["decks", "tokens", "quantity", deckId, variant] as const;
  const quantityWrite = useMutation({
    mutationKey: quantityKey,
    mutationFn: ({ entry, quantity }: { entry: TokenEntryRef; quantity: number }) =>
      ipc.deckTokenSetQuantity(opened(deckId), variant, entry.oracleId, stored(entry), quantity),
    onMutate: async ({ entry, quantity }) => {
      await queryClient.cancelQueries({ queryKey: tokensKey, exact: true });
      const saved = queryClient.getQueryData<DeckTokenRow[]>(tokensKey);
      if (saved !== undefined) {
        queryClient.setQueryData(tokensKey, stepped(saved, entry, quantity));
      }
      return { saved };
    },
    onError: (_error, _press, context) => {
      if (queryClient.isMutating({ mutationKey: quantityKey }) > 1) return;
      if (context?.saved !== undefined) queryClient.setQueryData(tokensKey, context.saved);
      invalidate();
    },
    onSuccess: () => {
      if (queryClient.isMutating({ mutationKey: quantityKey }) > 1) return;
      invalidate();
    },
  });

  /** The art picker's write on one entry — rule 4, folding onto an entry the list already holds. */
  const swapWrite = useMutation({
    mutationFn: ({ entry, to }: { entry: TokenEntryRef; to: TokenEntryKey }) =>
      ipc.deckTokenSwap(opened(deckId), variant, entry.oracleId, stored(entry), {
        cardId: to.cardId,
        finish: to.finish,
      }),
    onSuccess: invalidate,
  });

  /** The *Add printing* picker's write — rule 5, and the only one that names a printing rather
   *  than a token: Rust resolves the oracle id, and marks a token nothing derives `manual`. */
  const addWrite = useMutation({
    mutationFn: ({ cardId, finish }: { cardId: string; finish: Finish }) =>
      ipc.deckTokenAddPrinting(opened(deckId), variant, cardId, finish),
    onSuccess: invalidate,
  });

  /**
   * **Remove printing** — one stored entry, deleted (managed tokens spec §3.4). Always named by
   * its grain, never `null`: an implicit entry is not stored and draws no Remove, so there is no
   * materialisation to ask for. A derived token's last entry falls back to its implicit one at 0;
   * a hand-added token's last entry in both lists takes it off the deck.
   */
  const removeWrite = useMutation({
    mutationFn: (entry: TokenEntryRef) =>
      ipc.deckTokenRemove(opened(deckId), variant, entry.oracleId, {
        cardId: entry.cardId,
        finish: entry.finish,
      }),
    onSuccess: invalidate,
  });

  // TanStack's `mutate` and `mutateAsync` are stable per observer, so every callback below is
  // stable too — which matters because the editor hands them to all four deck views as part of the
  // token pile, inside a `useMemo`, and a callback minted fresh on every render would rebuild that
  // pile and re-render four views on every keystroke anywhere in the editor.
  const mutateQuantity = quantityWrite.mutate;
  const swapAsync = swapWrite.mutateAsync;
  const addAsync = addWrite.mutateAsync;
  const removeAsync = removeWrite.mutateAsync;

  const setQuantity = useCallback(
    (entry: TokenEntryRef, quantity: number) => mutateQuantity({ entry, quantity }),
    [mutateQuantity],
  );
  // **The three writes that take a tile away or put one on answer whether they landed** — a
  // promise that resolves `true` on success and `false` on a refusal, and **never rejects**, so a
  // caller that ignores it leaves no unhandled rejection behind. The caret hand-off
  // (`tokenCaret.ts`) is what reads it: it moves the caret only once the write has answered, and
  // not at all on a refusal. The refusal is still the mutation's own state, so `failure` below
  // says it exactly as it did through `mutate`. `mutateAsync` rather than `mutate`'s per-call
  // callbacks, which belong to the observer and would be taken away by the next press
  // (`DeckEditor`'s `localTokenRail` says the same).
  const swap = useCallback(
    (entry: TokenEntryRef, to: { cardId: string; finish: Finish }): Promise<boolean> =>
      swapAsync({ entry, to }).then(
        () => true,
        () => false,
      ),
    [swapAsync],
  );
  const addPrinting = useCallback(
    (cardId: string, finish: Finish): Promise<boolean> =>
      addAsync({ cardId, finish }).then(
        () => true,
        () => false,
      ),
    [addAsync],
  );
  const remove = useCallback(
    (entry: TokenEntryRef): Promise<boolean> =>
      removeAsync(entry).then(
        () => true,
        () => false,
      ),
    [removeAsync],
  );

  /** Every write this hook makes, newest-press-wins through {@link writeFailure}, and handed out
   *  for a host that folds them into a wider family — the editor's redo-clearing `newestWrite`.
   *  Remove printing is journalled like the other three, so it is one of them. */
  const writes: readonly [Write, ...Write[]] = [quantityWrite, swapWrite, addWrite, removeWrite];

  return {
    /** The query itself, for a caller that needs more than {@link loading} and {@link failure} —
     *  a panel's empty state reads `isSuccess` to tell "this deck makes nothing" from "nothing
     *  has answered yet", which are two sentences and not one. */
    query,
    /** Every entry to draw, in order. Never `undefined`: an unloaded deck answers the empty wall,
     *  because a deck that derives nothing is a supported state and not an error. */
    tokens,
    /** The first read is in flight. **Gated on the deck as well as on the query**, because an
     *  `enabled: false` query is `pending` for ever and a gallery with no deck open must not
     *  report a spinner. */
    loading: deckId !== null && query.isPending,
    /** The most recently started write's refusal as a sentence, or `null`. `writeFailure`'s rule
     *  — the newest write owns the banner, whatever its outcome — so a refused removal does not
     *  leave its sentence up over a printing swap that then worked. */
    failure: writeFailure(writes),
    writes,
    /**
     * How many copies of one entry this list wants. **`0` is a value**: it deletes the entry
     * unless it is the token's last one here, which stays at 0 (rule 3). An implicit entry is
     * sent as `null` and materialised in this list only.
     */
    setQuantity,
    /** Swap one entry to another printing and/or finish — the picker's press on a tile. The
     *  token's other entries are untouched, and landing on one the list holds folds the two. */
    swap,
    /** Add one copy of a printing in a finish to this list — the band's *Add printing*, from the
     *  deck's own tokens or, with `All tokens`, from every token in the game. */
    addPrinting,
    /** **Remove printing**: one stored entry of this list, deleted — drawn on every entry that
     *  is not `DeckTokenView.implicit`. Like `swap` and `addPrinting`, answers whether it landed
     *  (`true`) or was refused (`false`), and never rejects. */
    remove,
  };
}

/** The whole of what the panel consumes, named so the view and the hook agree. */
export type DeckTokens = ReturnType<typeof useDeckTokens>;
