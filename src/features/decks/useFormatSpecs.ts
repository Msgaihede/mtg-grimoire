import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc, type DeckGame, type FormatSpec } from "@/lib/ipc";
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
 * A deck that has not been pinned to a platform — `decks.game_key`'s own DDL default and
 * `deck::DEFAULT_GAME`, spelled here because the picker has to *select* something.
 *
 * **It is the whole of what "Any" does**: `pickerFormats` offers every format under it, so a
 * deck nobody has answered this question for behaves exactly as it did before the control
 * existed. That is why it is the default of the argument rather than a case inside it.
 *
 * Here rather than beside {@link DEFAULT_FORMAT} in `FormatSelect.tsx`, which is where the
 * format's own default lives: this module is imported *by* that one, so a constant going the
 * other way would be a cycle. It belongs here on its own merits too — the game is a fact about
 * how the format list is read, and that is this module's subject.
 */
// `satisfies` and not a `: DeckGame` annotation, which is load-bearing rather than a style
// choice: annotated, the constant's type widens to the whole union, and `game === ANY_GAME`
// then narrows nothing — so `playableIn`'s `spec.games.includes(game)` would be handed a
// `DeckGame` where a `Game` is wanted. This keeps the literal type *and* the check.
export const ANY_GAME = "any" satisfies DeckGame;

/**
 * The four rows a game picker offers, **in the order it offers them** — `Any` first and then
 * the three platforms.
 *
 * **Deliberately not through `sortOptions`**, and one of the exemptions `src/lib/options.ts`
 * names: `Any` is a pinned row like `Any format`, and the three under it are a ladder rather
 * than an alphabet — Paper is where nearly every deck lives, and alphabetical order would put
 * Arena in front of it and MTGO between. It is four rows a reader learns the position of.
 *
 * The keys are `schema::DECK_GAMES` and the words are this list's alone: Rust stores which
 * platform was named and has no display name to answer with, which is why {@link DeckRow}
 * carries a `gameKey` and no `gameName`.
 */
export const GAME_OPTIONS: readonly { key: DeckGame; name: string }[] = [
  { key: ANY_GAME, name: "Any" },
  { key: "paper", name: "Paper" },
  { key: "arena", name: "Arena" },
  { key: "mtgo", name: "MTGO" },
];

/**
 * What a stored `gameKey` is called on screen.
 *
 * Falls back to the key itself rather than to "Any", because `decks.game_key` carries no CHECK
 * — `ALTER TABLE … ADD COLUMN` cannot add one — so a value this list has never heard of is a
 * state that can exist, and showing it is how anybody would find out. Silently calling it
 * "Any" would hide the one thing worth seeing. {@link DeckRow.formatName}'s `?? formatKey`
 * rule, applied to the column beside it.
 */
export function gameLabel(key: string): string {
  return GAME_OPTIONS.find((g) => g.key === key)?.name ?? key;
}

/**
 * The formats a picker offers, in the order it offers them.
 *
 * Three controls ask this question — {@link FormatSelect} (both dialogs that create a deck),
 * the editor's header select and the settings dialog's — and the list was built three times
 * from three near-identical `useMemo`s. It is one shape here so they cannot drift into three
 * answers.
 *
 * Three rules, and none of them is the backend's:
 *
 * * `enabledInPicker` is the whole of why **Future Standard** — a format you can test a card
 *   against and cannot build for — is not offered. It is a cell of the seed, so this filters
 *   rather than naming the key.
 * * **`game` narrows the list to the formats that platform can play**, read off the seed's
 *   `games` cell by {@link playableIn}. `ANY_GAME` — the argument's default, and what every
 *   deck is born on — narrows nothing, so this is a no-op for a caller that has not been
 *   given a game. It is applied **before** `keep`, deliberately: the reader's own format is
 *   folded back in afterwards, so setting a deck to Arena never takes Modern off the select
 *   that is showing Modern.
 * * The order is **alphabetical by display name**, not `sortOrder`. The seed's ranking runs
 *   Standard, Future Standard, Historic, Timeless, Gladiator, Pioneer, Modern… which is the
 *   right thing for `format_specs` to say and no help at all to a reader looking for Modern,
 *   who looks under M. `src/lib/options.ts` carries the app-wide rule and the collator.
 *
 * `keep` is the deck's own format, passed by the surfaces that edit an existing deck: a select
 * that cannot show its own value would silently re-format the deck on the first other change.
 * It is added only when the picker does not already carry it, and **folded into the alphabet
 * rather than pinned first** — it is an option like any other, and the `<select>`'s own `value`
 * already marks it as the current one.
 *
 * **There are two ways a deck's format can be missing from the list, and `keep` answers both.**
 * The old one is a format that left the seed — `decks.format_key` is deliberately not a foreign
 * key, so that state can exist. The new one is the ordinary case rather than the edge: a Modern
 * deck whose reader sets the game to Arena. Modern is not an Arena format, the filter drops it,
 * and `keep` puts it back — which is the whole of what "setting a game never re-formats a deck"
 * means on this side.
 */
export function pickerFormats(
  specs: readonly FormatSpec[],
  keep?: FormatOption | null,
  game: DeckGame = ANY_GAME,
): FormatOption[] {
  const picker = specs
    .filter((s) => s.enabledInPicker && playableIn(s, game))
    .map((s) => ({ key: s.key, name: s.displayName }));
  return sortOptions(
    keep && !picker.some((f) => f.key === keep.key) ? [...picker, keep] : picker,
    (f) => f.name,
  );
}

/**
 * Whether a format can be played on the platform the reader named.
 *
 * `ANY_GAME` is every format, which is what makes the argument's default a no-op and is why no
 * caller that has not thought about games had to change.
 *
 * **`spec.games` is the seeded cell and the whole of the test** — never a list of keys spelled
 * out here, for the reason `enabledInPicker` is read rather than naming `future`: a rule
 * written twice is a rule that has to be corrected twice, and this one is genuinely likely to
 * be corrected (Commander on MTGO is a judgement call the seed names as one). An **empty**
 * `games` therefore answers `false` for every real platform, which is the fail-closed half of a
 * fact Rust guarantees is never empty — see {@link FormatSpec.games}.
 */
function playableIn(spec: FormatSpec, game: DeckGame): boolean {
  return game === ANY_GAME || spec.games.includes(game);
}
