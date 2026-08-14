# Plan — the deck editor's search panel opens on the deck's own format

**Date:** 2026-08-14
**Spec authority:** the user's request, quoted whole:

> When creating or editing a deck, we should set a default search filter in the card search for
> the format to match the format selected on the deck. It should still be possible to change the
> search format to a different (technically illegal) format, in case the user wishes to do that
> (it will be caught by our existing rulebreak validation).

## What is being built

`DeckSearchPanel` — the docked column the deck editor is built out of — mounts `useCardSearch`,
whose `format` filter starts at `""` ("Any format"). It should start at the **open deck's
format**, and stay a control the reader can move.

Nothing about legality moves: the panel already adds whatever the reader presses, `useDeck.addCard`
refuses nothing on legality grounds, and `validation/engine.ts` draws the `RULE BREAK` on a card
the format does not allow. This is a **default on a filter**, and the filter keeps every one of
its existing states including "Any format".

## Global Constraints

1. **A format key with no `legalities` data must never reach the filter.** `filters.rs:201-206`
   answers an unrecognised format key with the literal SQL `0` — *no rows*, deliberately, so that
   an unknown format cannot quietly return the whole corpus. `casual` and `limited` are exactly
   that: `format_specs.has_legality_data = 0`, and `legalities::LEGALITY_KEYS` has never carried
   them. Defaulting a Casual deck's panel to `casual` would draw an **empty wall with no
   explanation**. The fence is `FormatSpec.hasLegalityData`, read off the seeded row — never a
   hard-coded list of the two keys, and never inferred from the key's spelling.
2. **The reader can always change it, including to a format the deck is not in.** That is the
   whole of the request's second sentence. So the default seeds `format` state; it does not
   constrain it, and `Any format` stays in the list.
3. **The deck's format may not be one of `FORMATS`' seven.** The filter row offers seven legality
   keys; the deck picker offers every enabled `format_specs` row. A `<select>` whose `value` has no
   matching `<option>` does not draw blank — React selects the first row that is not disabled, so
   the control reads `Any format` while the filter it names narrows the wall underneath. An
   unlisted default must therefore be **folded into the option list** — the same rule, for the
   same reason, as `pickerFormats`' `keep` argument (`useFormatSpecs.ts:90-101`).
4. **`SearchPage` and `CollectionFilterBar` change behaviour in no way.** `useCardSearch()` called
   with no argument must behave exactly as it does today, and `FORMATS` stays exported for the
   collection's own row.
5. **Every option list is drawn through `sortOptions`** (`src/lib/options.ts`), `Any format` stays
   pinned above the sort, and the greyed half still sinks. `FilterBar` already does all three; the
   only change there is *which list* it sorts.
6. **`aria-disabled`, never `disabled`; `text-dim`, never `text-muted`;** no new z-index outside
   `LAYER`. No new dependency. No Rust change — the backend already takes any legality key.
7. **Tests run once, at the end, after fan-in.** Each task writes its own tests and does **not**
   run `npm run verify`; the controller runs it after every task has reported.

## The interface every task builds against

Added to `src/features/search/useCardSearch.ts`:

```ts
/**
 * One row of the format filter — the `legalities` key the backend filters by, and the word the
 * picker draws it as. Named for the *filter* rather than for a format, because
 * `useFormatSpecs.ts` already exports a `FormatOption` of `{ key, name }` for the deck's own
 * picker and the two are not the same shape.
 */
export interface FormatFilterOption {
  value: string;
  label: string;
}

export function useCardSearch(
  options: {
    /**
     * The format the filter opens on, or `null`/absent for "Any format" — the caller's own
     * answer, which the deck editor derives from the open deck.
     */
    defaultFormat?: FormatFilterOption | null;
  } = {},
): CardSearch;
```

`CardSearch` gains one field:

```ts
/** The formats the picker offers: `FORMATS`, plus `defaultFormat` when it is not one of them. */
formats: readonly FormatFilterOption[];
```

`DeckSearchPanelProps` gains one optional prop, `defaultFormat?: FormatFilterOption | null`,
handed straight to `useCardSearch`.

## Tasks

### Task 1 — `useCardSearch` takes a default format

**Files (yours alone):** `src/features/search/useCardSearch.ts`,
`src/features/search/useCardSearch.test.ts`

1. Export `FormatFilterOption` as written above.
2. Give `useCardSearch` the options parameter above, defaulting to `{}`. Read
   `const defaultFormatValue = options.defaultFormat?.value ?? ""` once.
3. **Seed the state:** `useState(defaultFormatValue)` instead of `useState("")`.
4. **Re-seed when the deck's format changes**, using React's *adjust-state-during-render*
   pattern rather than an effect — an effect would paint one frame of the old filter and fire a
   second request for it:

   ```ts
   const [appliedDefaultFormat, setAppliedDefaultFormat] = useState(defaultFormatValue);
   if (defaultFormatValue !== appliedDefaultFormat) {
     setAppliedDefaultFormat(defaultFormatValue);
     setFormat(defaultFormatValue);
   }
   ```

   This is what makes the deck's own format select re-point the panel beside it, and it is also
   what applies a default that **arrives late**: `useFormatSpecs` is a query, so on the first
   deck opened in a session the panel mounts before the seed has answered and the default is
   `null` for a render or two.
5. **`formats`:** a `useMemo` returning `FORMATS` when the default is absent or already one of
   them, and `[...FORMATS, options.defaultFormat]` when it is not. **Depend on the two string
   fields** (`options.defaultFormat?.value`, `options.defaultFormat?.label`), never on the object,
   which every caller rebuilds each render. Return it.
6. **`unfiltered` counts a *reader-set* format only.** It captions the empty result area, and its
   one job is to tell "the database is still syncing" from "your search missed" — a default
   nobody chose must not turn the first sentence into the second. So:

   ```ts
   // The default is not the reader narrowing anything, and `""` is not either.
   const formatIsReaderSet = format !== "" && format !== defaultFormatValue;
   ```

   and `unfiltered` reads `!formatIsReaderSet` in place of `!format`. With no default the two are
   the same expression, which is why `SearchPage` cannot notice.
7. **`activeFilterCount` is untouched, and the asymmetry with (6) is deliberate** — write the
   reason down at the site. The two answer different questions: `unfiltered` asks "did the reader
   ask anything of the database", `activeFilterCount` captions **Reset all** and asks "how much
   would pressing this change" — and a format filter that is on really is one thing it would
   clear. So a Commander deck's panel opens showing `Reset all 1`, and pressing it goes to
   `Any format`, which is the honest escape hatch.
8. **`resetAll` clears `format` to `""`, unchanged.** Reset means "no filters", not "back to the
   deck's". The reset sticks: the guard in (4) compares against `appliedDefaultFormat`, which
   reset does not touch, so the default returns only when the *deck's* format changes.

**Tests** (add to the existing file, in its idiom):

- with no options, `format` starts `""` and `formats` is `FORMATS` — the `SearchPage` case
- with a `defaultFormat`, `format` starts at its `value`
- changing the `defaultFormat` prop re-seeds `format`, **including over a format the reader had
  picked by hand**
- a default arriving from `null` (the late-seed case) is applied
- a reader's `setFormat` sticks while the default does not change
- `formats` folds in an unlisted key (use one only the deck picker has — `oathbreaker`) and does
  **not** duplicate a listed one (`commander`)
- `unfiltered` is true for an untouched default, true after `resetAll`, and false once the reader
  picks a different format
- `resetAll` leaves `format` at `""` and does not bounce back to the default

### Task 2 — `FilterBar` draws the search's own format list

**Files (yours alone):** `src/features/search/FilterBar.tsx`,
`src/features/search/FilterBar.test.tsx`

1. Sort and draw `search.formats` in place of the imported `FORMATS`. Drop the `FORMATS` import
   (keep `type CardSearch`); **do not** delete or move the `FORMATS` declaration —
   `CollectionFilterBar` imports it and Task 1 owns that file's contents.
2. The `useMemo` gains `search.formats` as a dependency. Everything else about that memo stays:
   `sortOptions` by `label`, `optionDisabled` deciding the grouping level and the attribute once,
   `Any format` pinned above the sorted list.
3. Extend the doc comment over `formatOptions` to say where the list now comes from and why it
   can be longer than seven — the deck editor's panel seeds it with the open deck's format, and a
   `<select>` whose value has no `<option>` silently reports the first one, putting `Any format`
   over a filtered wall.

**Tests:** the existing file builds a `CardSearch` stub — give the stub a `formats` field
defaulting to `FORMATS` so no existing case changes, and add: a stub carrying an extra option
draws it, it sorts into the alphabet with the rest (not pinned), and `Any format` is still first.

### Task 3 — `DeckSearchPanel` takes and forwards the default

**Files (yours alone):** `src/features/decks/DeckSearchPanel.tsx`,
`src/features/decks/DeckSearchPanel.test.tsx`, `src/features/decks/DeckSearchPanel.stories.tsx`

1. Add `defaultFormat?: FormatFilterOption | null` to `DeckSearchPanelProps`, importing the type
   from `@/features/search/useCardSearch`. Document it in the file's idiom: it is the **open
   deck's** format, handed down rather than read here — for the reason `categories` is
   (`DeckSearchPanel.tsx:126-131`) — and it is a *default*, so the reader may move the select to
   any format including one the deck is not legal in, which the validation panel then marks.
2. `useCardSearch({ defaultFormat })`.
3. Nothing else in this file changes. The filter row, the select and Reset all are all
   `FilterBar`'s.

**Tests:** the panel renders with no `defaultFormat` and its Format select reads `Any format`
(today's behaviour); with one, the select reads that format's label; and the reader can move the
select to another format and the panel keeps working — the request's second sentence, pinned.
Reach the select the way the existing suite reaches labelled controls.

**Story:** add one story showing the panel opened on a deck's format — caption it with why the
default exists and that it is only a default.

### Task 4 — `DeckEditor` hands the panel the open deck's format

**Files (yours alone):** `src/features/decks/DeckEditor.tsx`,
`src/features/decks/DeckEditor.test.tsx`

1. The editor already holds both halves: `row` (line ~275) and
   `spec = formatSpecFor(row.formatKey)` (line ~276). Derive, in a `useMemo` near the existing
   `formats` memo (~line 840):

   ```ts
   const searchFormatDefault = useMemo(
     () =>
       row && spec?.hasLegalityData ? { value: row.formatKey, label: spec.displayName } : null,
     [row, spec],
   );
   ```

2. Pass it: `<DeckSearchPanel … defaultFormat={searchFormatDefault} />`.
3. **Write the `hasLegalityData` fence down at the site** — Global Constraint 1, in a sentence: a
   Casual or Limited deck has no legality key, `filters.rs` answers an unknown key with no rows
   at all, and the panel would draw an empty wall. `spec` is also `null` while the seed is still
   loading and for a deck whose format left the seed, and `null` is the right answer in both —
   "Any format" is a working panel.
4. `spec.displayName` rather than `row.formatName`, because the spec is what was already required
   for the fence, and one source cannot disagree with itself.

**Tests:** the editor renders a deck whose format has legality data and the panel's Format select
reads it; a `casual` deck's panel reads `Any format`. Use the suite's existing deck fixtures and
its way of reaching the panel. Note the editor draws **two** format controls — the header's is
`aria-label="Deck format"` and the panel's is labelled `Format` — so address them apart.

### Task 5 — the rule, written down

**Files (yours alone):** `src/features/decks/CLAUDE.md`

Add a bullet to the section that governs the docked panel (`## Views and interaction` is where the
panel's rules sit; put it with the panel's, not with the quick add's). It must carry, in this
file's voice and in one bullet:

- the panel's format filter opens on the **open deck's** format, and is a default rather than a
  constraint — the reader may pick any format, and an illegal card is the validation panel's job
  and not the search's;
- **the `hasLegalityData` fence and why it is not a list of two keys** — `filters.rs` answers an
  unrecognised legality key with `0`, so `casual` and `limited` would draw an empty wall;
- that the default **re-seeds when the deck's format changes** and survives `resetAll` only until
  it does;
- that an unlisted key is folded into the picker the way `pickerFormats`' `keep` is, because a
  `<select>` with no matching `<option>` does not draw blank — it silently reports the first one,
  putting `Any format` over a filtered wall.

Do not re-count anything, and do not touch any other file.
