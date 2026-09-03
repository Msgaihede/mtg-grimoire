import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { opened } from "./useDeck";

/** Stable identity for "no answer yet, and none coming" — a disabled query on both hooks reads
 *  this, so a consumer's `useMemo` over the set does not see a new identity every render. */
const NO_KEYS: ReadonlySet<string> = new Set<string>();

/** The same, for the other end of the question. */
const NO_DECKS: ReadonlySet<number> = new Set<number>();

/**
 * What joins the sorted keys into the third term of {@link useDecksPlaying}'s query key.
 *
 * Both arms of {@link playKey} are Scryfall UUIDs — `cards.oracle_id` and `deck_cards.card_id`
 * are both `8-4-4-4-12` hex — so no key can contain this character and two different sets can
 * never join to one string. It is a **cache key and never a wire format**: what goes to Rust is
 * the array, and the string exists only so that TanStack sees one question.
 */
const KEY_SEP = "|";

/**
 * The key a deck row and a collection row are matched on. Mirrors the Rust
 * `coalesce(cards.oracle_id, deck_cards.card_id)` exactly — see the doc on
 * `ipc.deckPlayedKeys` for why it is shaped that way.
 *
 * **The oracle id first, because a deck plays a *card* and a reader owns *cardboard*.** A deck
 * holding the Commander 2019 *Sol Ring* plays Sol Ring, so a copy from any other set is a copy
 * of something the deck plays; matching on the printing would refuse the filing for a reason
 * nothing on screen could explain.
 *
 * **The printing is the fallback and not the other way round**, which is the arm to get right:
 * `cards.oracle_id` is nullable and a `deck_cards` row outlives its printing leaving the corpus,
 * so an orphan has no oracle identity to be matched by. Printing-to-printing is then the
 * strictest thing that can honestly be said about it — and a fallback that reached for the
 * printing *first* would silently make every match printing-exact, which is a rule that looks
 * correct on the one card somebody tests it with.
 *
 * Structural rather than a named DTO on purpose: `DeckCard`, `CollectionRow` and `CardDetail`
 * all satisfy it, and a filing surface holding any of the three must not have to convert one
 * into another to ask this question.
 */
export function playKey(card: { oracleId: string | null; cardId: string }): string {
  return card.oracleId ?? card.cardId;
}

/**
 * Sorted, deduped, and therefore one question however the caller built the list.
 *
 * `combosForCardsKey`'s rule in `lib/query.ts`, applied one feature over: the answer does not
 * depend on the order, so two orderings of one set that made two cache entries would be two
 * round trips and two chances for the menu to disagree with itself.
 *
 * **Neither half is a correctness fix** — `decks_playing` dedupes for itself and answers in its
 * own order — which is exactly why it has to be done here: the backend cannot make two cache
 * entries agree, because it never sees the second question.
 */
function askedFor(keys: readonly string[]): string[] {
  return [...new Set(keys)].sort();
}

/**
 * Every card the deck's **live** list plays — the census a filing surface fails closed against.
 *
 * `["decks", "plays", deckId]`, **under the `["decks"]` root**, which is the whole of the
 * invalidation story: every deck write in this app already fires
 * `invalidateQueries({ queryKey: ["decks"] })`, so an add, a move, a removal or a cleared pile
 * refreshes this for free and no mutation anywhere has to learn that this key exists.
 * `useDeckAudit`'s argument, for a read that goes stale on exactly the same events.
 *
 * **No variant, and no marketplace.** The live list is the only one that holds copies — a theory
 * row is a plan — so there is nothing here for a variant to scope; and nothing in the answer is
 * priced, so the marketplace that is in every other deck key would be a second cache entry for
 * one answer.
 *
 * `deckId` is nullable because every surface that wants this is mounted whether or not a deck is
 * open — the card menu draws on six views, most of which have no deck at all — and a query that
 * fired anyway would ask the backend for deck `null` on each of those renders.
 */
export function useDeckPlays(deckId: number | null) {
  const query = useQuery({
    queryKey: ["decks", "plays", deckId],
    queryFn: () => ipc.deckPlayedKeys(opened(deckId)),
    enabled: deckId !== null,
  });

  /**
   * **Memoised on `query.data` rather than rebuilt per render**, because both consumers walk a
   * menu or a wall of dozens of rows against it: TanStack hands back the same array identity
   * until the answer actually changes, so this `Set` holds still across a re-render and a
   * caller may put it in a dependency array.
   */
  const plays = useMemo<ReadonlySet<string>>(
    () => (query.data === undefined ? NO_KEYS : new Set(query.data)),
    [query.data],
  );

  return {
    query,
    /**
     * The keys this deck plays, empty until the first answer.
     *
     * **Empty is not "plays nothing"** — it is also "no deck", "still reading" and "the read
     * failed", and which of those it is decides whether a menu row greys. Read `pending` for
     * the third state, or `query` for all of them.
     */
    plays,
    /**
     * The read is in flight, so the census cannot be trusted yet.
     *
     * **A caller enforcing the rule fails *closed* on this** — `CollectionPage`'s
     * `stepperByTile` is the live precedent, where a tile in a drawer draws no stepper for the
     * length of one query rather than drawing a control over copies it may turn out not to own.
     * Here that means a deck group offered on an unloaded census would be a filing the backend
     * then refuses, which is worse than a row that greys for a moment and then lights up.
     *
     * **A disabled query is `false`, not pending**, which is the distinction `query.isPending`
     * alone cannot make: TanStack leaves a disabled query `status: "pending"` for ever, so a
     * caller reading that flag would grey its rows permanently on every surface with no deck
     * open. There is no census coming, and the caller passed the `null` that says so.
     */
    pending: query.isPending && query.fetchStatus !== "idle",
  };
}

/**
 * Which decks play **every** one of these cards — {@link useDeckPlays} asked from the other end,
 * for a menu whose rows are decks rather than cards.
 *
 * `["decks", "playing", <the sorted keys joined>]`, **under the `["decks"]` root** for
 * {@link useDeckPlays}' reason, and keyed on **the cards rather than on anything about a deck**
 * for `combosForCardsKey`'s: a key naming a deck would have to be right about every write that
 * can change what a deck plays, and `query.ts`'s 30 s `staleTime` would hide whichever one was
 * forgotten for half a minute.
 *
 * **The keys are sorted and deduped before they enter the key *and* before they go on the
 * wire**, so a reader who picked four cards bottom-up asks the same question as one who picked
 * them top-down — one cache entry, one round trip.
 *
 * **Empty `keys` disables the query rather than asking**, and the returned set is empty. The
 * conjunction over nothing is vacuously true, so a backend answering "every deck" would be
 * mathematically right and exactly wrong for a menu; not asking at all is the same answer as
 * the backend's own empty one, arrived at without a round trip.
 */
export function useDecksPlaying(keys: readonly string[]) {
  // Recomputed per render rather than memoised: a caller building `[playKey(card)]` inline hands
  // a new array identity every time, so a `useMemo` keyed on it would pay the compare and
  // recompute anyway. It costs a sort over the picked set — a handful of cards — and the query
  // key below is a **string**, so a fresh array can never look like a fresh question.
  const asked = askedFor(keys);
  const cacheKey = asked.join(KEY_SEP);

  const query = useQuery({
    queryKey: ["decks", "playing", cacheKey],
    queryFn: () => ipc.deckIdsPlaying(asked),
    enabled: asked.length > 0,
  });

  /** {@link useDeckPlays}' `plays`, one type over: stable across a re-render because a menu of
   *  dozens of deck rows tests membership against it. */
  const deckIds = useMemo<ReadonlySet<number>>(
    () => (query.data === undefined ? NO_DECKS : new Set(query.data)),
    [query.data],
  );

  return {
    query,
    /**
     * The decks that play every asked-for card, empty until the first answer.
     *
     * **Empty is not "no deck plays these"** — it is also "nothing was asked", "still reading"
     * and "the read failed". `useDeckPlays`' note applies verbatim: read `pending` or `query`,
     * and fail closed.
     */
    deckIds,
    /** In flight, so nothing here may be trusted yet — {@link useDeckPlays}' `pending`, and the
     *  same fail-closed rule. `false` for an empty `keys`, because no census was asked for. */
    pending: query.isPending && query.fetchStatus !== "idle",
  };
}

/** What a surface consuming the live census sees, named so the view and the hook agree. */
export type DeckPlays = ReturnType<typeof useDeckPlays>;

/** The same, for the decks-that-play-these end. */
export type DecksPlaying = ReturnType<typeof useDecksPlaying>;
