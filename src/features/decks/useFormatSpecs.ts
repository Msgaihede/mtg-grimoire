import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc, type FormatSpec } from "@/lib/ipc";
import { sortOptions } from "@/lib/options";

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
    /** Every row, in the seed's `sortOrder` — the order Rust answered in, which is a fact about
     *  the table and **not** the order a picker shows them in. Display order is
     *  {@link pickerFormats}' business; see `src/lib/options.ts` for why it is a display
     *  decision rather than a SQL one. */
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

/** One row of a format picker: the key a deck stores, and the words it is offered by. */
export interface FormatOption {
  key: string;
  name: string;
}

/**
 * The formats a picker offers, in the order it offers them.
 *
 * Three controls ask this question — {@link FormatSelect} (both dialogs that create a deck),
 * the editor's header select and the settings dialog's — and the list was built three times
 * from three near-identical `useMemo`s. It is one shape here so they cannot drift into three
 * answers.
 *
 * Two rules, and neither of them is the backend's:
 *
 * * `enabledInPicker` is the whole of why **Future Standard** — a format you can test a card
 *   against and cannot build for — is not offered. It is a cell of the seed, so this filters
 *   rather than naming the key.
 * * The order is **alphabetical by display name**, not `sortOrder`. The seed's ranking runs
 *   Standard, Future Standard, Historic, Timeless, Gladiator, Pioneer, Modern… which is the
 *   right thing for `format_specs` to say and no help at all to a reader looking for Modern,
 *   who looks under M. `src/lib/options.ts` carries the app-wide rule and the collator.
 *
 * `keep` is the deck's own format, passed by the two surfaces that edit an existing deck: a
 * select that cannot show its own value would silently re-format the deck on the first other
 * change, and `decks.format_key` is deliberately not a foreign key, so a deck whose format
 * left the seed is a state that can exist. It is added only when the picker does not already
 * carry it, and **folded into the alphabet rather than pinned first** — it is an option like
 * any other, and the `<select>`'s own `value` already marks it as the current one.
 */
export function pickerFormats(
  specs: readonly FormatSpec[],
  keep?: FormatOption | null,
): FormatOption[] {
  const picker = specs
    .filter((s) => s.enabledInPicker)
    .map((s) => ({ key: s.key, name: s.displayName }));
  return sortOptions(
    keep && !picker.some((f) => f.key === keep.key) ? [...picker, keep] : picker,
    (f) => f.name,
  );
}
