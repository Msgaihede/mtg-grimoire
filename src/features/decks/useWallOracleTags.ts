import { useMemo } from "react";
import {
  useQueries,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ipc, type PrintingTags } from "@/lib/ipc";
import { ORACLE_TAGS_KEY } from "@/lib/useOracleTagProgress";

/**
 * How many printings one read asks about.
 *
 * The card search pages 50 rows at a time, so a wall's ids arrive in runs of about this many and
 * a chunk that is full never changes again — only the last, part-full one is re-asked as the wall
 * grows. Nothing depends on the two numbers agreeing; a different page size costs one more
 * re-read of a short list.
 */
export const TAG_READ_CHUNK = 50;

/**
 * What each printing on a wall *does*, by card id — and **absent for a printing nobody has
 * answered about yet**, which is a different fact from an empty list.
 *
 * `[]` is "asked, and the card carries no tag"; a missing key is "not known" — the read is still
 * out, or was refused. `autoCategoryIfKnown` is what turns that difference into a button that
 * either names a pile or does not.
 */
export type WallOracleTags = ReadonlyMap<string, readonly string[]>;

/** Every wall read is cached under this — {@link ORACLE_TAGS_KEY}'s subtree, one chunk a key. */
const WALL_TAGS_KEY = [...ORACLE_TAGS_KEY, "printings"];

/**
 * What the cache already holds about these printings, from **any** earlier wall read — or
 * `undefined` where it holds nothing, which is what tells a query it has no placeholder.
 *
 * **Not `keepPreviousData`, which is inert here.** A chunk whose id list changed is a new key,
 * and `useQueries` gives a new key a fresh observer with no previous result to keep — measured in
 * this hook's own test, where a named tile lost its pile the moment the wall grew. Reading the
 * cache by *card* rather than by observer is what survives that, and it buys the other case too:
 * every keystroke in the search box is a new result set and so a new set of keys, and a card the
 * reader has already been shown keeps its word across all of them.
 *
 * Oldest answer first, so where two cached chunks both carry a card the newer one is what a
 * `Map` built from this ends on. A partial list is a legal answer: the hook's map is filled by
 * card id, and an id that is not in it is simply not known yet.
 */
function alreadyKnown(client: QueryClient, ids: readonly string[]): PrintingTags[] | undefined {
  const wanted = new Set(ids);
  const known = new Map<string, PrintingTags>();
  const reads = client
    .getQueryCache()
    .findAll({ queryKey: WALL_TAGS_KEY })
    .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt);
  for (const read of reads) {
    for (const entry of (read.state.data as PrintingTags[] | undefined) ?? []) {
      if (wanted.has(entry.cardId)) known.set(entry.cardId, entry);
    }
  }
  return known.size > 0 ? [...known.values()] : undefined;
}

/** No printing known — what a wall that is not on `Auto` holds, and every wall's first paint. */
const NOTHING_KNOWN: WallOracleTags = new Map();

/**
 * Module scope, so its identity never moves: `useQueries` re-runs `combine` only when a result
 * or the function itself changed, and a fresh arrow per render would rebuild the map — and hand
 * every tile's Add button a new closure — on every keystroke in the search box.
 */
function byCardId(results: UseQueryResult<PrintingTags[]>[]): WallOracleTags {
  const known = new Map<string, readonly string[]>();
  for (const result of results) {
    for (const entry of result.data ?? []) known.set(entry.cardId, entry.slugs);
  }
  return known;
}

/**
 * The Oracle tags of every printing a docked search wall has drawn, so its Add buttons can name
 * the pile an `Auto` add will actually land in.
 *
 * **This is the read `useDeck.addCard` makes at the press, made early and in bulk.** That hook
 * files an add that names no category by what the card *does* (`autoCategoryFor` over its tags,
 * then its type line), and the button that promises the pile had only the type line to go on —
 * no list DTO carries a slug list — so with the taxonomy downloaded it named the wrong pile for
 * every card whose function and type disagree. The two tabs of the deck editor's docked search
 * call this, and each hands the slugs it holds to its press, so the label and the write are one
 * function over one fact.
 *
 * **`enabled` is `Auto`, and off means no read at all.** A deck that names the pile its adds land
 * in has already answered; there is nothing about a card to look up.
 *
 * **Keyed under {@link ORACLE_TAGS_KEY}**, which is the seam a finished refresh acts on: the
 * taxonomy has just been replaced under every pile a wall has named, and `useOracleTagProgress`
 * invalidates that whole prefix. A read keyed anywhere else would go on naming yesterday's pile.
 *
 * **In chunks rather than one growing list**, because the wall pages: one key over every loaded
 * id would re-ask about all of them each time a page landed. A full chunk's key never changes;
 * the part-full last one is re-read as it grows, and draws what the cache already knows about
 * its cards meanwhile ({@link alreadyKnown}), so a tile that has been named does not lose its
 * pile for the length of a read as the reader scrolls or types.
 *
 * **A read that fails costs a word, never a card.** Its ids stay unknown, their buttons name no
 * pile, and the press goes through `useDeck`'s own read — which catches and files by type line.
 * Nothing here may refuse an add.
 */
export function useWallOracleTags(cardIds: readonly string[], enabled: boolean): WallOracleTags {
  const client = useQueryClient();
  // Deduplicated in first-seen order: the Collection tab folds copies to a tile per printing
  // *and finish*, so one card id can head two tiles. Order-preserving, so an appended page
  // appends to this list and every chunk before the last stays the chunk it was.
  const chunks = useMemo(() => {
    if (!enabled) return [];
    const distinct = [...new Set(cardIds)];
    const out: string[][] = [];
    for (let at = 0; at < distinct.length; at += TAG_READ_CHUNK) {
      out.push(distinct.slice(at, at + TAG_READ_CHUNK));
    }
    return out;
  }, [cardIds, enabled]);

  const known = useQueries({
    queries: chunks.map((ids) => ({
      queryKey: [...WALL_TAGS_KEY, ids],
      queryFn: async (): Promise<PrintingTags[]> => {
        const answers = await ipc.oracleTagsForPrintings(ids);
        // **Matched by `cardId`, never by position** — the command drops blank and duplicate
        // ids, so its answer can be shorter than the request. An id it did not answer for was
        // still asked about, and reads as a card with no tags: `useDeck`'s `oracleTagsFor` makes
        // the same `?? []`, and the label must not come to a different answer than the press.
        const slugs = new Map(answers.map((entry) => [entry.cardId, entry.slugs]));
        return ids.map((cardId) => ({ cardId, slugs: slugs.get(cardId) ?? [] }));
      },
      placeholderData: () => alreadyKnown(client, ids),
    })),
    combine: byCardId,
  });

  return enabled ? known : NOTHING_KNOWN;
}
