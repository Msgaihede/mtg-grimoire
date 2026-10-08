import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ipc, type CardFilters, type DeckCard, type QueryPredicate } from "@/lib/ipc";
import { parseQuery, tokenKey } from "@/features/search/queryLanguage";
import { DEBOUNCE_MS } from "@/features/search/useCardSearch";
import { termsFor, type TagChip } from "@/features/tags/tagFilters";

/**
 * The deck editor's `Filter this deck` box, read the way every other card search box in this app
 * reads its box — Scryfall's syntax and the app's own (issue #621).
 *
 * **Two halves, answered in two places, and the split is the design.**
 *
 * - **The free text stays the webview's.** The box has always narrowed on each keystroke to the
 *   cards whose name or type line *contains* what was typed, and that is kept exactly: `oblin`
 *   still finds the goblins, and plain typing costs no round trip. {@link needleMatches} is that
 *   test, written once.
 * - **Every typed term is Rust's.** `t:goblin`, `cmc>=3`, `-kw:flying`, `a:avon`, `f:modern`,
 *   `otag:removal` and the rest go to `deck_query_cards`, which runs them through the one
 *   `filters` SQL the search, the collection and the wishlist already share. A `DeckCard` carries
 *   no keywords, no artist and no tags, and a second evaluator of the other ten fields here would
 *   be a second implementation of `c:` against `id:`, rarity's order and a star power — which is
 *   the drift `packages/ui/CLAUDE.md` says the parse/SQL split exists to prevent.
 *
 * **The terms are parsed from the debounced string and the free text from the live one**, so a
 * plain word narrows at once while a term waits out {@link DEBOUNCE_MS} — the search boxes' own
 * pause, for their reason: a query per keystroke of `t:creature` would redraw the deck for `t:c`,
 * `t:cr`… on the way. Clearing every term takes effect at once, because a box with no term in it
 * *now* narrows by none whatever the debounced string still says.
 *
 * **Tags fail closed, predicates never gate** — `useCardSearch`'s two rules, verbatim. A tag name
 * that resolves to nothing empties the deck rather than being dropped, because a dropped narrowing
 * is a wider answer than the reader asked for; a predicate that matches nothing is simply an empty
 * answer. Until a term's first answer lands the deck is narrowed by the free text alone, and after
 * that the last answer stands while the next is asked (`keepPreviousData`), so the deck does not
 * blink back to whole between two keystrokes.
 */
export interface DeckCardQuery {
  /** The free text left once every term is lifted out, trimmed and lowercased — `""` narrows by
   *  nothing. */
  needle: string;
  /** The printings that answer every typed term, or `null` when no typed term narrows (none
   *  typed, or none answered yet). An empty set is a real answer: nothing matches. */
  matching: ReadonlySet<string> | null;
}

/** Whether one deck row answers the free text — its name or type line contains the needle. The
 *  box's rule since it shipped, and the half of the filter that never leaves the webview. */
export function needleMatches(card: Pick<DeckCard, "name" | "typeLine">, needle: string): boolean {
  return (
    needle === "" ||
    card.name.toLowerCase().includes(needle) ||
    (card.typeLine ?? "").toLowerCase().includes(needle)
  );
}

/** One term as the wire carries it — the box's span dropped, so two spellings of one question are
 *  one query key (`useCardSearch`'s `bare`). */
function bare({ field, op, value, negated }: QueryPredicate): QueryPredicate {
  return { field, op, value, negated };
}

/** No typed term narrows — one frozen value, so the memo below hands back the same object. */
const NO_TERMS: DeckCardQuery["matching"] = null;
/** A tag nobody knows: nothing matches, and one frozen empty set says so. */
const NOTHING: ReadonlySet<string> = Object.freeze(new Set<string>());

export function useDeckCardQuery(deckId: number, input: string): DeckCardQuery {
  const live = useMemo(() => parseQuery(input), [input]);
  const needle = live.text.trim().toLowerCase();
  const liveHasTerms = live.predicates.length > 0 || live.tags.length > 0;

  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(input), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  const parsed = useMemo(() => parseQuery(debounced), [debounced]);
  const asks = useMemo(
    () => parsed.tags.map((t) => ({ namespace: t.namespace, value: t.value })),
    [parsed],
  );
  const askKey = asks.map(tokenKey).join(" ");

  // The search box's own key, so a name resolved there is answered here from cache.
  const resolution = useQuery({
    queryKey: ["tags", "resolve", askKey],
    queryFn: () => ipc.tagResolve(asks),
    enabled: asks.length > 0,
  });

  const tags = useMemo(() => {
    if (asks.length === 0) return { terms: {}, pending: false, unknown: false };
    const answers = resolution.data;
    if (answers === undefined) return { terms: {}, pending: true, unknown: false };
    const chips: TagChip[] = [];
    let unknown = false;
    parsed.tags.forEach((token, i) => {
      const ref = answers[i];
      if (ref === null || ref === undefined) {
        unknown = true;
        return;
      }
      chips.push({
        slug: ref.slug,
        label: ref.label,
        namespace: ref.namespace,
        mode: token.negated ? "exclude" : "include",
      });
    });
    // `termsFor` leaves out a taxonomy nobody named and sends no floor — the syntax has no
    // keyword for one, because Scryfall has none to borrow.
    const { artTags, oracleTags } = termsFor({ chips, namespace: "both", floor: "any" });
    return { terms: { artTags, oracleTags }, pending: false, unknown };
  }, [asks, parsed, resolution.data]);

  const filters = useMemo((): Pick<CardFilters, "predicates" | "oracleTags" | "artTags"> => {
    const out: Pick<CardFilters, "predicates" | "oracleTags" | "artTags"> = {};
    if (parsed.predicates.length > 0) out.predicates = parsed.predicates.map(bare);
    if (tags.terms.oracleTags) out.oracleTags = tags.terms.oracleTags;
    if (tags.terms.artTags) out.artTags = tags.terms.artTags;
    return out;
  }, [parsed, tags]);
  const hasTerms = parsed.predicates.length > 0 || asks.length > 0;

  // Under the `["decks"]` root on purpose: every write to what is in a deck invalidates it, so a
  // card added, moved or swapped is asked about again with no invalidation of this read's own.
  const query = useQuery({
    queryKey: ["decks", "query", deckId, JSON.stringify(filters)],
    queryFn: () => ipc.deckQueryCards(deckId, filters),
    enabled: hasTerms && !tags.pending && !tags.unknown,
    placeholderData: keepPreviousData,
  });

  const answered = query.data;
  const matching = useMemo((): DeckCardQuery["matching"] => {
    if (!liveHasTerms || !hasTerms) return NO_TERMS;
    if (tags.unknown) return NOTHING;
    return answered === undefined ? NO_TERMS : new Set(answered);
  }, [liveHasTerms, hasTerms, tags.unknown, answered]);

  return { needle, matching };
}
