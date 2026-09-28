# Deck stats band — three columns, mana-chart labels, creature split, type breakdown

Issue [#620](https://github.com/Msgaihede/mtg-grimoire/issues/620) plus the changes Markus designed
on the canvas on 2026-09-28 (Design artifact "Deck Stats Band",
`claude.ai/artifact/655MryUhYQjAudX1Gy24d3`). Every decision below was made on that canvas; this
file is the contract the parallel tasks share.

## Decisions

### 1. Layout — three columns at the largest width (issue #620)

- **Three columns when the band's own width is ≥ 1400px** (~a 1920 window; a 1440 window's band is
  ~1184px and stays at two). Measured on the band with a `ResizeObserver`, **never a container
  query** — `container-type` makes the box the containing block for `fixed` descendants and the
  Collection card opens anchored layers (the band's standing rule, `DeckStats.tsx`).
- **Balanced arrangement**: `[Mana curve, Curve by color] [Mana pips, Figures] [Card distribution,
  Collection]`.
- Below 1400px nothing changes: today's two wrapping columns `[Mana pips, Card distribution]
  [Mana curve, Curve by color, Figures, Collection]`, each `min-w-[22rem]`, wrapping to one.
- **Moving a card between column containers remounts it**, so every piece of card-local state
  (Mana pips' hide-colorless, Card distribution's `by`, the odds' mode/want/hand) is lifted to
  `DeckStats` so a resize across 1400px loses nothing.

### 2. Mana curve and Curve by color — labels and counts

- **Axis labels in circles.** Mana curve: circle `min(100%, 36px)` square, `aspect-ratio: 1`,
  mono **20px bold**, `text-text`. Curve by color: `min(100%, 22px)`, mono **13px bold**,
  `text-text` (was 12px medium `text-dim` in a box). Card distribution keeps its word boxes.
- **Every count sits above its bar**, never inside. The track keeps its height (152 / 88) and the
  tallest bar still fills it to the top; the room is a clear strip **above** the track — 24px on
  the curve, 19px on a colour curve — which is where the tallest bar's count lands. Every other
  count rides directly on top of its own fill. Zero draws no count (as today).
- Card distribution's bars keep today's above-or-inside rule.

### 3. Mana curve — creature split toggle

- A **`Creatures`** toggle button in the Mana curve header, left of the average, in the Mana pips
  `Hide` button's grammar (`h-8`, bordered, `aria-pressed`, `border-accent text-accent` when on),
  with a stacked-columns icon.
- **On**: each bar is two parts — creatures at the foot in `--color-creature`, noncreatures above
  in `--color-noncreature`, a 1px `--color-bg` rule between. Total count above the bar (§2). **Each
  part prints its own count inside it** when the part is ≥ 18px tall (creature count in
  `--color-creature-fg`, noncreature in `--color-text`, mono 12px semibold, top of the part). The X
  bar splits too. A legend under the chart: swatch + `Creatures` + count, swatch + `Noncreatures`
  + count.
- Spoken per bar: *"5 creatures and 5 noncreatures at mana value 2"*.
- **Off**: exactly §2's gold chart.
- **Saved per deck**: a new `decks.curve_creatures INTEGER NOT NULL DEFAULT 0` column, riding
  `deck_update` exactly as `stats_open` does (`DeckSummary.curveCreatures`).
- A creature is a card whose **front** face type line includes `Creature` — the test `typeBucket`
  makes, since `Creature` leads `TYPE_BUCKETS`.

### 4. Mana pips

- **`Cost` / `Sources` labels above their 32px bands**, not in a 4.5rem column beside them; the
  bands take the card's full width.
- **Colour tiles**: the separate symbol row is gone; the colour's symbol sits **left of each
  header** — `(U) Cost`, `(U) Sources` — header above its bar, caption under it.
- **Tile bars are 18px** and full width; the **percentage is centred inside the coloured fill**
  (mono 11px semibold, `#111`/black on the mana fill). A fill under 20% prints it just past the
  fill in `text-text`; no share prints `—` centred in the empty track in `text-dim`. The Sources
  fill is thinned with `color-mix(in srgb, <fill> 55%, transparent)`, not `opacity`, so the number
  on it stays full strength.

### 5. Card distribution — creature split bar and type breakdown

Always drawn (not tied to the `by` select), under the bar chart, above the odds:

- **`Creatures vs noncreatures`** — the Mana pips Cost band's grammar: 15px medium label above a
  32px rounded bar in two parts, `--color-creature` (text `--color-creature-fg`) and
  `--color-noncreature` (text `--color-text`), each holding `<count bold mono> creatures <share
  mono>`. Counts are the curve's: creatures = `sum(curveCreatures) + (variableCostCreatures ?? 0)`,
  total = `sum(curve) + (variableCost ?? 0)` — so the band and the curve's legend are one number.
  A part too narrow for its text prints it beside the bar instead.
- Then, behind a `border-t`, **two panels**, side by side where the card allows
  (`repeat(auto-fit, minmax(min(100%, 15rem), 1fr))`), stacked where it does not:
  - **Creature** — heading with the creature count; one row per creature **subtype** (front face,
    after the `—`), count desc then name: name, a 6px accent track scaled to the largest, count.
    A dim note: *"A creature with two types counts under both."*
  - **Land** — heading with the land count; a **pie** with a legend (swatch, name, count, share).
    Lands are **partitioned by their basic land types** so the slices sum to the land count
    exactly: `Island`, `Mountain`, `Island Mountain` (a dual), and `No basic land type`. Colours
    are the **mana fills** (`MANA_FILL`, `--color-mana-*`), never `--color-pie-*`: one type is its
    fill; a slice with two or more types is **striped** in each of its fills (an SVG pattern); no
    basic type is `--color-mana-c`. The pie is `aria-hidden`; the legend is the accessible story.
  - Counted over the same copies the distribution bars count.
- This reverses the 2026-09-10 "the two pies are gone" note — amend that paragraph, don't leave it.

### 6. Design tokens

In `src/index.css`, beside the mana and pie tokens:

```css
--color-creature: oklch(0.72 0.07 305);
--color-creature-fg: oklch(0.2 0.03 305);
--color-noncreature: oklch(0.5 0.08 305);
```

And in the claude.ai design system's `project/tokens.json`.

## The contract between tasks

`DeckStatsSummary` gains (task B implements, C and D consume):

```ts
/** Creature copies per curve bucket — a subset of `curve`: same length, same rules. */
curveCreatures: readonly number[];
/** Creature copies among `variableCost`; `null` exactly when `variableCost` is `null`. */
variableCostCreatures: number | null;
```

Props:

- `DeckStats` gains `creatureSplit: boolean` and `onCreatureSplitChange: (next: boolean) => void`
  (task A wires them from `DeckEditor`, the way `open` / `onToggle` are).
- `ManaCurveChart` becomes `{ stats, split, onSplitChange }` (task C; B passes them).
- `CardDistribution` gains `stats: DeckStatsSummary` plus its lifted state (task D defines the
  prop names for its own lifted state and reports them; B passes them).
- `ManaPips` gains `hideColorless` / `onHideColorlessChange` (D; B passes them).

## Tasks

| Task | Owns |
| --- | --- |
| A — persistence | `src-tauri/**`, `src/lib/ipc.ts`, `.storybook/**` fake, every `DeckSummary` fixture outside `DeckStats.*`, `DeckEditor.tsx` wiring |
| B — stats + layout | `DeckStats.tsx`, `DeckStats.test.tsx`, `DeckStats.stories.tsx`, `deckBuckets.ts`(+test), `src/index.css`, a new width hook |
| C — charts | `stats/StatsCard.tsx`, `stats/ManaCurveChart.tsx`, `stats/CurveByColor.tsx`, their tests |
| D — pips + distribution | `stats/ManaPips.tsx`, `stats/CardDistribution.tsx`, `stats/OpeningHandOdds.tsx`, new `stats/typeBreakdownCounts.ts`(+test), new `stats/CreatureSplitBar.tsx`, new `stats/TypeBreakdown.tsx` |

`typeBreakdownCounts.ts` rather than the `typeBreakdown.ts` first written here: on Windows that name
resolves to the same file as `TypeBreakdown.tsx` (TS1149, a case-only collision).

Then: `npm run verify`, the docs, a live pass in the window.
