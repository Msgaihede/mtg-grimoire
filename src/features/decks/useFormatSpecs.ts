import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc, type FormatSpec } from "@/lib/ipc";

/** Stable identity for "no specs yet", so a consumer's `useMemo` over `specs` does not
 *  recompute on every render of a hook that has not loaded. */
const NONE: readonly FormatSpec[] = [];

/**
 * The format rules, as data, once per session.
 *
 * `format_specs` is seeded by `schema::migrate` and by nothing else: 25 rows written before
 * the first command can be served, changing only when a migration corrects a cell — which is
 * to say once per app version, never while the app is running. So this is the one query in
 * the app that holds its answer with a flat `staleTime: Infinity`, and the one query root a
 * sync does not invalidate (see `SYNC_INVALIDATED`, which says so).
 *
 * `["sets"]` looks like this and is not: the set picker needs a *function* staleTime, because
 * its first launch can answer `[]` while the opening sync is still writing the table, and
 * `Infinity` over that empty array would leave the filter empty for the session. That case
 * does not exist here — the seed lands in the migration, before a window opens.
 */
export function useFormatSpecs() {
  const query = useQuery({
    queryKey: ["formatSpecs"],
    queryFn: () => ipc.formatSpecs(),
    staleTime: Infinity,
  });

  const specs = query.data ?? NONE;
  const byKey = useMemo(() => new Map(specs.map((s) => [s.key, s])), [specs]);

  return {
    query,
    /** Every row, in the seed's `sortOrder` — which is the order a picker shows them in. */
    specs,
    /**
     * The rules one deck is judged by. A deck carries a `formatKey` and nothing else, so
     * this lookup is the whole of how it finds its own spec.
     *
     * `null` for a key the table does not carry, rather than a thrown error or a
     * casual-shaped stand-in: `decks.format_key` is deliberately **not** a foreign key (a
     * migration re-seeds `format_specs` with `INSERT OR REPLACE`, and a REFERENCES clause
     * would make that a migration that can fail in the field), so a deck whose format left
     * the seed is a state that can exist — and it must still open. What to say about it is
     * the caller's decision, not this hook's.
     *
     * `null` while the table is still loading, for the same reason: every consumer renders
     * through its own loading pass, and asking early is not an error.
     */
    formatSpecFor: useCallback((key: string) => byKey.get(key) ?? null, [byKey]),
  };
}
