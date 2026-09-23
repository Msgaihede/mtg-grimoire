# Combos dialog: split view, brackets instead of letters

Closes [#481](https://github.com/Msgaihede/mtg-grimoire/issues/481) — *"The current size of the
Combos section makes its images and text too small."*

The issue asks for bigger art and a slightly wider panel. Taking it literally gets a wider
accordion and stops there; what the report is actually describing is a surface that is scanned by
card art through a 96px window, where the thing a reader wants is behind a press. So this plan
replaces the accordion with a **rail and a detail pane**: the left rail is the scan list, the
right pane is one combo drawn at full size with nothing collapsed.

Visual reference (Design canvas, interactive — press Play and click down the rail):
https://claude.ai/artifact/T1CDhhmmBf1TftWek1hxe1

The canvas draws its card frames as placeholders; the shipped pane uses `CardArt` with the real
picture. Everything else in it is meant literally, including the sizes below.

## Global constraints

- **`minWidth` is 1024** (`src-tauri/tauri.conf.json`), and the widest dialog this app ships is
  `w-[55rem]`. A split pane wants more than that, so the panel is **`w-[62rem]`** (992px) —
  wider than anything else here, still inside the smallest window the app can be. `Dialog`'s
  `max-w-full` covers the rest. Do not reach for 72rem: it does not fit.
- **The rail must survive Ashnod's Altar.** 6 044 combos on one card is the number this surface
  was paged for in the first place; nothing in this plan may load a list unbounded.
- **One table for what a letter means.** `COMBO_TAG` is already exported from `DeckBracket.tsx`
  for this dialog's sake, and `COMBO_FLOOR` lives in `validation/bracket.ts`. The bracket list
  this plan draws is derived from `COMBO_FLOOR` — never a second map, in this file or any other.
  See `docs/reference/commander-brackets.md`, *`bracketTag`, and the floor each letter implies*.
- **Nothing here touches the backend.** `combos_for_card`, its page shape, the three filters and
  the census are all unchanged; this is a render of the same answer.
- The dialog is dark-only, keyboard-reachable and drawn from the app's own tokens. `FOCUS`,
  `FILTER_FIELD` and the `coarse:` variant keep their existing jobs.

## File map

| File | What happens |
| --- | --- |
| `src/features/decks/validation/bracket.ts` | export `COMBO_FLOOR`; add `comboBrackets(tag)` |
| `src/features/card/CombosDialog.tsx` | the rewrite — rail, detail pane, bracket pips, scroll paging |
| `src/features/card/CombosDialog.test.tsx` | accordion cases out, selection and bracket cases in |
| `src/features/card/CombosDialog.stories.tsx` | stories follow the new shape |
| `docs/reference/commander-brackets.md` | the card-side section describes the accordion and the letters; both are gone |
| `docs/reference/frontend-design.md` | if it names this dialog's width or its accordion |

## Task 1 — the bracket list, derived once

`COMBO_FLOOR` is `const` and unexported today. Export it, and add beside it:

```ts
/**
 * The brackets a combo is legal in, as the five numbers a reader is shown.
 *
 * **Derived from {@link COMBO_FLOOR} and never tabulated a second time.** A floor of N means
 * "this combo belongs in bracket N and up", which is N through 5 — the same statement the deck
 * advisory makes as a lower bound, said as a set because the card side is not estimating a
 * deck's bracket and has no bound to raise.
 *
 * `B` is the exception and it is not a floor at all: *Banned* is a legality finding, so the
 * answer is the empty list and the caller says "not legal in Commander" rather than drawing
 * five empty pips. `E` has no floor for the opposite reason — it is legal everywhere — so it
 * answers all five. The two nulls in `COMBO_FLOOR` mean different things and this is the only
 * place that has to know it.
 */
export function comboBrackets(tag: ComboBracketTag): readonly number[] {
  if (tag === "B") return [];
  const floor = COMBO_FLOOR[tag] ?? 1;
  return [1, 2, 3, 4, 5].filter((n) => n >= floor);
}
```

Unit-test all seven letters, `B` and `E` explicitly.

## Task 2 — the panel and the two columns

`CombosDialog`'s shell keeps its title, subtitle, `layer="stacked"` and both close handlers.
`size` becomes `"w-[62rem] h-[54rem]"` — the height is fixed now because a detail pane that
resized itself as the reader moved down the rail would be the worst thing on this surface.

`Body` keeps the search box and the chips, unchanged in behaviour, and loses their counts: the
census still drives which size chips exist and the *pressed-with-no-bucket* rule still holds, but
`All · 412` becomes `All`. The number stays in one place — a `412 combos` line above the rail —
because the chip row next to a search field reading five figures is what the issue's reporter is
looking past to find the cards.

Under the filter band: a flex row, `min-h-0`, holding

- **the rail**, `w-[21.5rem] shrink-0 border-r border-border`, its own `min-h-0 flex-1
  overflow-y-auto`;
- **the pane**, `min-w-0 flex-1 overflow-y-auto p-5`.

The as-of caption stays outside both, spanning the foot, for the reason it is outside the
scroller today.

## Task 3 — the rail

One row per combo, ~56px, and no art. Each row carries:

- the bracket **range** (`2–5`, `4–5`, or `Not legal`) in a 42px bordered box, gold on the
  selected row;
- the *other* pieces' names on one line, `truncate` — the asked-about card is the dialog's
  subtitle and repeating it on every row costs the width the names need;
- a second line: `3 cards · Missing 1` / `3 cards · You own every piece`, the ownership half in
  `text-ok` when nothing is missing.

A `<button>` per row inside an `<li>`, `aria-current` on the selected one, plus an `sr-only`
sentence carrying the brackets in words (`Legal in brackets 2, 3, 4 and 5`) — the range box is a
colour-and-number pair and must not be the only statement of it.

**Paging becomes scrolling.** Delete the *Show more* button. Put a sentinel `<div>` at the foot
of the rail scroller and an `IntersectionObserver` (root = the scroller) that calls
`fetchNextPage()` when it appears, gated on `hasNextPage && !isFetchingNextPage`. `hasNextPage`
is still `nextComboOffset`'s answer and the short-page rule still ends the list.

**`PAGE_SIZE` moves from 25 to 50, and its comment moves with it.** The constant's current
justification is that "a combo row is a wall of art, so a page here is nearer a screen of reading
than a screen of tiles". After this change a row is one line and no art, so that paragraph is
false and a number left standing on a false reason is worse than a wrong number. Rewrite it.

## Task 4 — the detail pane

Selection is derived, not stored twice:

```ts
const [picked, setPicked] = useState<string | null>(null);
const selected = rows.find((c) => c.id === picked) ?? rows[0] ?? null;
```

That derivation is the whole of why no effect is needed anywhere: a search, a chip or a new page
hands back a different `rows`, and an id that is no longer in it falls through to the first row
of the new list — which is what a reader who just narrowed the list means. Keep it local to
`Body`, for the reason the accordion's own `useState` was local.

The pane draws, top to bottom:

1. **The pieces**, each a `CardArt` at `w-44` (176px, so 176×246 at 5:7) with the name at
   `text-[0.9375rem]` under it and the ownership sentence under that — `ownedNote` unchanged,
   `Must be your commander` appended to that line rather than sitting on its own. The `+` between
   pieces is centred on the art by `items-center`; **delete `mt-[3.75rem]`**, which is the
   derived-not-measured offset the current file admits to in its own comment.
2. **The brackets**: `Legal in bracket` followed by five pips, 26px, the legal ones filled with
   `bg-accent text-accent-fg` and the rest `border-border text-dim`. `role="img"` with the
   `comboBrackets` sentence as `aria-label` on the group, so the five pips speak once and as a
   sentence. Then `COMBO_TAG[tag].name` and its `forces`, in one text node. A `B` combo draws
   *Not legal in Commander* in place of the pips.
3. **`produces`** at `text-lg`, because on this layout it is the headline of the thing.
4. **Prerequisites** (300px column) beside **Steps** (the rest), both through the existing
   `Section`, which keeps drawing nothing for an empty field.
5. The `templateCount` sentence and `Mana needed`, both unchanged.
6. **View on Commander Spellbook**, still `openExternal` on the press.

`ComboRow`, its `open` state and `comboLabel` all go. `comboLabel` existed because a disclosure
button needed a built accessible name; the rail row needs one too, so keep the *idea* under a new
name and a new sentence: pieces, then the tag name, then the brackets — no bare letter.

## Task 5 — keyboard

The rail is a list of buttons. Add a `keydown` handler **on the `<ul>`**, not on the window:
`ArrowDown` / `ArrowUp` move focus and selection to the next/previous row, `Home` / `End` to the
ends, and each stops propagation so nothing reaches the dialog. There is no global handler here
and there must not be one — `Dialog` owns Escape through its capture rung, and `src/CLAUDE.md`
states why a dialog's inner control does not answer it.

Scrolling the focused row into view uses `scrollIntoView({ block: "nearest" })`.

## Task 6 — tests, stories, docs

- `CombosDialog.test.tsx`: drop every case that presses a row open. Add — the first row is
  selected on open; pressing a row moves the pane; narrowing the search moves selection to the
  first row of the new list; the bracket group's accessible name for a `C` combo is
  `Legal in brackets 2, 3, 4 and 5`; a `B` combo says it is not legal; the four empty states are
  untouched.
- `CombosDialog.stories.tsx`: a story per shape — two-card, three-card with a template, a combo
  the reader owns entirely, and the narrow-window case.
- `docs/reference/commander-brackets.md`'s card-side section describes an accordion and a letter.
  Rewrite it to describe the rail, the pane and the derived brackets, and say in it that the
  letters are no longer drawn on the card side while `COMBO_TAG`'s names still are.

## Verification

1. `npm run verify`.
2. Storybook, per the `running-the-app` skill — one Storybook at a time across worktrees.
3. A live pass in the shipped window, which is what settles the two things this plan derived
   rather than measured: the `w-[62rem]` panel at a 1024px window, and the rail's scroll paging
   on a card with thousands of combos. Open Basalt Monolith for the ordinary case and Ashnod's
   Altar for the hard one.
4. Ship per the `shipping-a-branch` skill.
