# Collection value graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `valueHistory` home widget — the collection's value over time, split by total / card type / colour / set — backed by a `copies` column on `price_snapshots` and one new read command.

**Architecture:** Rust records copies beside each daily price (user schema v50) and answers `collection_value_history(split, marketplace)` with per-period bucket values, a live point for today and the price-move part of each step. TypeScript folds buckets, applies the range and measure, lays the widget out per fit tier, and draws a hand-rolled SVG chart with a keyboard-scrubbable readout.

**Tech Stack:** Rust (rusqlite, Tauri 2.11 commands, wasm-routed web target), React 19 + TypeScript 6, TanStack Query, Vitest, Storybook fake.

**Spec:** `docs/superpowers/specs/2026-09-26-collection-value-graph-design.md` (read it first). Design canvas: <https://claude.ai/artifact/FqJsY5YXr8KdA21sbgvFJc>.

## Global Constraints

- **Worktree:** `D:\Code\mtg-grimoire\.claude\worktrees\deck-notes-redesign-d8b299`, branch `claude/collection-value-graph-widget-ab13fe`. Use absolute paths. Do not touch any other checkout.
- **Agents do not commit.** The worktree's git index is shared by every agent in this fan-out. Never `git add`, `git commit`, `git stash`, `git reset`, `git checkout -- <file>`. Edit, run your own targeted checks, report. The controller commits per bucket at fan-in.
- **Edit only the files your task owns.** If a file you do not own needs a change, stop and report it with the exact line and change — do not reach across.
- **Scratch files** go only in `C:\Users\Markus\AppData\Local\Temp\claude\D--Code-mtg-grimoire--claude-worktrees-deck-notes-redesign-d8b299\693aaf08-2b28-43f4-bc1a-c439576afc1a\scratchpad\<your-task-id>\`.
- **Never run `npm run verify`**, and never run two cargo commands at once. Run only the targeted checks your task names, in the **foreground**. The controller runs the full verify once after fan-in.
- **Names that cross the Rust↔TS boundary are fixed by the Contract below.** Do not rename any of them.
- `USER_SCHEMA_VERSION` goes **49 → 50**. The command is `collection_value_history`. The widget kind is `valueHistory`. **Never** use the kind name `priceHistory` (`HomePage.stories.tsx` uses it as the unknown-kind fixture).
- Money is drawn with `formatPrice(value, currency)`; the currency comes from `useMarketplace()`. Dim text is `text-dim`, never `text-muted`. Z-indexes only from `LAYER` (`src/lib/layers.ts`). Timings only from `src/lib/motion.ts`. Tailwind classes are never built by interpolation — computed sizes are inline styles.
- A `null`/absent price is an em dash, never `$0.00`.
- British "Colour" in labels; the colourless bucket's label is `MANA_LABEL.C` (the app's existing word), multicolour is `"Multicolour"` — the same words `CollectionValueWidget.tsx` uses.

## The Contract (every task builds against this)

### Rust (`src-tauri/src/value_history.rs`, new, in `lib.rs`'s every-target block)

```rust
/// Refusal for a split word the command does not answer.
pub const NOT_A_SPLIT: &str = "That is not a way to split collection value.";

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValueBucket {
    /// "creature".."land" | "other" (type); "W","U","B","R","G","c","multi" (color);
    /// a set code or "other" (set). Empty list for "total".
    pub key: String,
    /// The set's name for split "set" (None for an orphan and for every other split).
    pub name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValuePoint {
    /// unixepoch() of the period's day (UTC midnight). For a weekly period, its latest day.
    pub day: i64,
    /// Σ copies × price that period, over priced rows.
    pub total: f64,
    /// One value per `ValueHistory::buckets`, same order; empty for "total".
    pub values: Vec<f64>,
    /// The price-only part of `total − previous.total`: Σ over printings present at both
    /// points of copies_before × (price_now − price_before). None on the first point.
    pub moved: Option<f64>,
    /// True only for the last point: today, computed live from collection_entries.
    pub live: bool,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValueHistory {
    pub buckets: Vec<ValueBucket>,
    /// Oldest first. The last is always today's live point when the collection has any
    /// priced copy; an empty collection answers an empty list.
    pub points: Vec<ValuePoint>,
    /// unixepoch(date('now')) — so the page reads no clock.
    pub today: i64,
}

pub fn history(conn: &Connection, split: &str, marketplace: Marketplace) -> Result<ValueHistory, String>;

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn collection_value_history(
    state: tauri::State<'_, Arc<AppState>>,
    split: String,
    marketplace: Option<Marketplace>,
) -> Result<ValueHistory, String>;
```

### TypeScript (`src/lib/ipc.ts`)

```ts
export type ValueSplit = "total" | "type" | "color" | "set";
export interface ValueBucket { key: string; name: string | null; }
export interface ValuePoint { day: number; total: number; values: number[]; moved: number | null; live: boolean; }
export interface ValueHistory { buckets: ValueBucket[]; points: ValuePoint[]; today: number; }
// on the ipc object:
collectionValueHistory: (split: ValueSplit, marketplace: MarketplaceId) =>
  invoke<ValueHistory>("collection_value_history", { split, marketplace }),
```
(`MarketplaceId` is whatever type `priceMovers` already takes for its marketplace argument — match it.)

### Query key (`src/features/home/keys.ts`)

```ts
export function valueHistoryKey(split: ValueSplit, marketplace: MarketplaceId) {
  return ["collection", "valueHistory", split, marketplace] as const;
}
```
Under `["collection"]` so every collection write and every feed landing refreshes it. Range and measure are client-side and are **not** in the key.

### Registry row (`src/features/home/widgets.ts`)

```ts
valueHistory: {
  label: "Collection value graph",
  description: "What your collection has been worth over time — in total, or split by card type, colour or set.",
  def: [6, 3], min: [2, 2], max: [8, 6],
  picks: [
    { key: "split", label: "Split by", dflt: "type", options: [
      { id: "total", label: "Total" }, { id: "type", label: "Card type" },
      { id: "color", label: "Colour" }, { id: "set", label: "Set" } ] },
    { key: "window", label: "Range", dflt: "90d", options: [
      { id: "30d", label: "30 days" }, { id: "90d", label: "90 days" },
      { id: "1y", label: "1 year" }, { id: "all", label: "All" } ] },
    { key: "measure", label: "Measure", dflt: "change", options: [
      { id: "value", label: "Value" }, { id: "change", label: "Change" } ] },
  ],
  toggles: [{ key: "figures", label: "Show totals" }, { key: "markers", label: "Mark collection changes" }],
  chip: "split",
},
```
Not added to `DEFAULT_LAYOUT` (in either copy).

### The model (`src/features/home/valueHistory/model.ts`, new)

```ts
export type ValueWindow = "30d" | "90d" | "1y" | "all";
export type ValueMeasure = "value" | "change";
export const WINDOW_DAYS: Record<ValueWindow, number | null>; // 30, 90, 365, null (= everything kept)
export const CATEGORICAL: readonly string[];  // ["#4c88d3","#d5753a","#009b8f","#9460b7","#819f47"]
export const OTHER_FILL: string;              // "#55585f"
export const IDENTITY_FILL: Record<string, string>; // W #dfd19d U #1f86cd B #725195 R #cc3f2f G #53be70 c #5c6b7a multi #deb459
export const TOTAL_FILL: string;              // "var(--color-accent)"

export interface Series { key: string; label: string; fill: string; values: number[]; }
export interface HistoryView {
  days: number[];            // unix seconds, oldest first, inside the window
  totals: number[];
  moved: (number | null)[];  // same length; null on the window's first point
  series: Series[];          // [total] for "total"; folded buckets otherwise
  historyShort: boolean;     // the kept history starts after the window would
  today: number;
}

/** Window, fold and label. Pure. */
export function viewOf(h: ValueHistory, split: ValueSplit, window: ValueWindow): HistoryView;
/** Percent change since the window's first point (×100), or the raw values. */
export function shownValues(s: Series, measure: ValueMeasure): number[];
/** `totals[i] − totals[i−1] − moved[i]`; 0 at i = 0 and wherever moved is null. */
export function collectionChange(v: HistoryView, i: number): number;
export interface Scale { lo: number; hi: number; ticks: number[]; }
export function scaleFor(values: readonly number[], measure: ValueMeasure): Scale;
export function tickLabel(t: number, measure: ValueMeasure, currency: Currency): string;
export interface Readout {
  date: string;              // "Today" for the live point, else formatDay(day, "long")
  since: string;             // "change since 4 Jul" (long date when the window crosses a year)
  total: { value: string; change: string; up: boolean };
  rows: { key: string; label: string; fill: string; value: string; change: string; up: boolean; lit: boolean }[]; // empty for total
  facts: { label: string; value: string; change?: string; up?: boolean }[];  // total only
  note: string | null;       // "$74.60 of cards added that day" / "that week" / "−$20.00 … removed" etc.
}
export function readoutAt(v: HistoryView, i: number, litKey: string, currency: Currency): Readout;
export function markerDays(v: HistoryView): number[]; // days whose collectionChange ≠ 0 (|x| ≥ 0.005)
export function dateTicks(v: HistoryView, xs: readonly number[]): { x: number; text: string; anchor: "start" | "middle" | "end" }[];

export type Tier = WidgetFit["tier"];
export interface Rect { x: number; y: number; w: number; h: number; }
export interface Layout {
  figures: Rect | null; controls: Rect | null; chart: Rect | null;
  rail: Rect | null; list: Rect | null; strip: Rect | null;
  controlsHaveRanges: boolean; controlsHaveMeasure: boolean;
  railRows: number; listColumns: 1 | 2;
}
/** Body-pixel rectangles for every region, per the spec's fit table. */
export function layoutFor(fit: WidgetFit, opts: { split: ValueSplit; figures: boolean; bucketCount: number }): Layout;
```

## Review Focus

- **A printing sold mid-week in the thinned region** leaves its last row on a different day from the rest of its bucket; the read must still produce one point per 7-day bucket, never a stray low point (Task 1 test).
- **Today's live point equals `collection_summary`'s value** for the same marketplace, to the cent (Task 1 test) — otherwise the graph and the Collection value widget disagree on the home page.
- **A database upgraded from v49** has only NULL `copies` rows: the answer is the live point alone, never a line built from NULLs (Task 1 test), and the widget draws the first-day state (Task 4 test).
- **Change measure with a bucket whose first value is 0** (a set bought inside the window): no `Infinity`/`NaN` reaches the path — the series starts at its first non-zero point or is drawn flat at 0 (Task 3 test).
- **The readout under the home grid's CSS `zoom`** must land at the pointer, not scaled away from it, and must not be clipped by the card (Task 4, and the controller's live pass).

---

### Task 1: Rust — copies in the snapshot, v50, and `collection_value_history` (owner: agent **R**)

**Files:**
- Modify: `src-tauri/src/schema.rs` — the v50 rung, `USER_SCHEMA_VERSION`, `USER_SCHEMA_SQL`'s `price_snapshots` DDL, `UNDO_V50`, the 17 chain literals, the byte-identical test's object count only if it changes (it should not — a column adds no object), a `user_file_at_49` fixture and a `v50_…` test.
- Modify: `src-tauri/src/price_history.rs` — the snapshot writes `copies`; `DAILY_DAYS` and the week-bucket expression become `pub(crate)` so the read can apply the same thinning.
- Create: `src-tauri/src/value_history.rs` — the Contract's types, `history`, the command, tests.
- Modify: `src-tauri/src/lib.rs` (module in the every-target block), `src-tauri/src/desktop.rs` (`generate_handler!`), `src-tauri/src/web/route.rs` (`COMMANDS`, a match arm, the `COMMANDS.len()` literal, and one routed-call test).
- Also fix every `INSERT INTO price_snapshots` in `src-tauri/src/**` tests that omits a column list (grep them).

**Interfaces:** Produces the Contract's Rust half. Consumes `collection::breakdown_columns` (reuse its `color` key expression — do not respell the colour CASE), `sorting::price_expr`, `schema::memory_pair()`, and price_history's test helpers as a pattern.

**Behaviour to implement:**

- [ ] **Step 1: The rung.** `if v < 50 { ALTER TABLE price_snapshots ADD COLUMN copies INTEGER; PRAGMA main.user_version = 50; }` at the bottom of `migrate_user`, one transaction, with a doc paragraph on the constant. Mirror it into `USER_SCHEMA_SQL` so `the_user_schema_is_byte_identical_to_what_the_ladder_builds` stays green (an `ALTER` appends the column text inside the stored `CREATE`; copy what SQLite writes). `UNDO_V50` = `ALTER TABLE price_snapshots DROP COLUMN copies;`, prepended to all 17 chain literals (`{UNDO_V50} {UNDO_V49} …`). Add `user_file_at_49()` and `v50_adds_copies_and_keeps_every_price_row` (seed rows at v49, migrate, assert rows kept with `copies IS NULL`).
- [ ] **Step 2: The writer.** `snapshot_sql` already builds `owned(card_id, finish, copies)`; insert `copies` beside `price`. A test: after `snapshot`, a printing held as 3 copies across two folders has `copies = 3`.
- [ ] **Step 3: The read — periods.** Rows with `copies IS NOT NULL` for the marketplace and `day < date('now')`. A row younger than `DAILY_DAYS` is its own day's period; an older row belongs to its 7-day bucket (the prune's exact expression), and within a bucket keep **one row per (card_id, finish): its latest** — the prune's own rule, applied again so an un-thinned or partially-thinned table reads the same as a thinned one. A period's `day` is the latest day among its rows. Periods ascend.
- [ ] **Step 4: The read — buckets.** Classify each row by joining `cards` (unqualified; it resolves into the corpus):
  - `type`: front face = `type_line` before the first `//` (whole line when none), first of `Creature, Planeswalker, Instant, Sorcery, Artifact, Enchantment, Battle, Land` it contains (case-sensitive `instr`), else `other`; no card row → `other`. Keys lowercase (`creature` … `land`, `other`). **This must equal `src/features/decks/deckBuckets.ts`'s `typeBucket`** — pin it with a Rust test over these lines: `Artifact Creature — Golem`→creature, `Artifact Land`→artifact, `Land Creature — Forest Dryad`→creature, `Legendary Enchantment Land — Urza's Saga`... (take the real line: `Legendary Enchantment Land — Urza’s Saga`)→enchantment, `Instant // Sorcery`→instant, `Sorcery // Land` (MDFC)→sorcery, `Kindred Instant — Elf`→instant, `Token Creature — Soldier`→creature, `Scheme`→other.
  - `color`: `breakdown_columns("color")`'s key expression.
  - `set`: `coalesce(c.set_code, 'other')`, name `c.set_name`.
  - `total`: no buckets.
  - Unknown split → `Err(NOT_A_SPLIT.into())`.
- [ ] **Step 5: The live point.** From `collection_entries e LEFT JOIN cards c`, `e.quantity > 0`, value `sum(e.quantity * {price_expr(marketplace, "e.finish")})`, bucketed with the same expressions. Its `day` is `unixepoch(date('now'))`, `live: true`. An empty collection (no entries with quantity > 0) → `points: []`.
- [ ] **Step 6: `moved`.** For consecutive points A → B: Σ over (card_id, finish) present in both of `A.copies × (B.price − A.price)`. For the live point, B's price is the live `price_expr` and the printing is "present" if it has a live quantity > 0 **and** a live price; A is the last snapshot period. First point: `None`.
- [ ] **Step 7: Bucket order and cap.** `color`: fixed `W,U,B,R,G,c,multi`, only buckets that are non-zero at some point. `type`/`set`: by the live point's value descending (ties by key), `other` always last; **at most 8 named buckets** — every bucket past the eighth is summed into `other` (create it if needed). `values` aligned with `buckets`, 0.0 where a bucket has nothing that period.
- [ ] **Step 8: Wire it.** Command wrapper (read connection, blocking pool, `Marketplace::from_opt`-style handling exactly as `price_movers` does), `generate_handler!`, route arm + `COMMANDS` entry + the length literal, and a route test calling it through `call(&s, "collection_value_history", &json!({"split":"total","marketplace":"tcgplayer"}))`.
- [ ] **Step 9: Tests to write in `value_history.rs`** (pattern: `price_history.rs`'s `conn()` / `own()` / `past()`):
  1. a v49-shaped history (copies NULL) answers only the live point;
  2. the live point's `total` equals `collection::summarise(…).value` for the same collection and marketplace;
  3. three daily periods with a price rise and one added copy: totals right, `moved` = price part only, and `total − prev − moved` = the added copy's value;
  4. a printing sold mid-week in the weekly region does **not** create an extra point (one point per bucket);
  5. `type` classification table from Step 4;
  6. `set` cap: 10 sets → 8 named + `other`, `other` = sum of the two smallest;
  7. unknown split refuses with `NOT_A_SPLIT`;
  8. a day at or after today in `price_snapshots` is ignored (the live point replaces it).
- [ ] **Step 10: Run** (foreground, one at a time, from `src-tauri`): `cargo test value_history` (report the selected count — a filter matching nothing exits 0), `cargo test schema`, `cargo test price_history`, `cargo test route`, then `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check`. Also `cargo check --target wasm32-unknown-unknown --lib` if the toolchain is installed (the wasm leg needs clang; if it is not available, say so rather than skipping silently).
- [ ] **Step 11: Report** the files changed, test counts, and the final `USER_SCHEMA_VERSION`. Do not commit.

---

### Task 2: TypeScript mirror and the Storybook fake (owner: agent **F**)

**Files:**
- Modify: `src/lib/ipc.ts` — the Contract's TS types and `ipc.collectionValueHistory`.
- Modify: `src/lib/ipc.test.ts` — an argument-names case beside the price_movers/price_history ones (`declares(valueHistoryRs, "collection_value_history", "split")` and `"marketplace"`, plus the invoke-args assertion), and `plainMirrors` rows for `ValueBucket`, `ValuePoint`, `ValueHistory` against a new `?raw` import of `../../src-tauri/src/value_history.rs` (path as the file's other `?raw` imports spell it).
- Modify: `.storybook/fake/db.ts` — `FakePriceSnapshot` gains `copies: number`; `historyFromCollection` records the owned quantity it seeds from; a `collection_value_history` read handler beside `price_movers` that derives the DTO from the stored snapshots and the fake collection **by the same rules as Task 1** (periods, buckets, live point, `moved`, order and cap). Type buckets: import `typeBucket` from `src/features/decks/deckBuckets.ts` if the fake already imports app modules, else port it verbatim with a comment naming the source.
- Modify: `.storybook/fake/db.test.ts` — a `describe("the value history")` beside the price-movers tests: live point equals the fake's collection summary value; four splits answer; unknown split refuses with the Rust sentence; `empty` seed answers `points: []`.

**Rules:** read `.storybook/CLAUDE.md` first. Store rows, derive DTOs; never alias `ipc.ts`; reads answer through a sync; mirror Rust's refusals.

- [ ] Steps: write the types → the ipc function → the ipc.test cases → the fake handler → the fake tests.
- [ ] **Run:** `npx vitest run src/lib/ipc.test.ts .storybook/fake/db.test.ts` (the `ipc.test.ts` Rust `?raw` rows will fail until Task 1's file exists — if so, report that as expected and pending fan-in, do not stub the Rust file).
- [ ] **Report**; do not commit.

---

### Task 3: The pure model (owner: agent **M**)

**Files:**
- Create: `src/features/home/valueHistory/model.ts` — everything in the Contract's model block.
- Create: `src/features/home/valueHistory/model.test.ts`.

**Interfaces:** Consumes `ValueHistory`/`ValueSplit` **as `import type` from `@/lib/ipc`** (Task 2 writes them; type-only imports are erased, so your tests run before it lands), `formatPrice` (`@/lib/prices`), `Currency` (`@/lib/marketplace`), `formatDay`, `signedPercent`, `DAY_SECONDS` (`@/features/home/priceHistory/priceAnalytics`), `signedMoney` (`@/features/home/widgets/PriceMoversWidget`), `MANA_LABEL` (`@/lib/mana`), `WidgetFit` (`@/features/home/fit`). Produces the Contract's model block for Task 4.

**Rules:**
- `viewOf`: window = points with `day ≥ today − days×86400` (all for `all`); when the first kept point is later than that cutoff, `historyShort = true`. Fold: `total` → one series `{key:"total", label:"Total", fill: TOTAL_FILL, values: totals}`; `color` → the buckets in the order Rust gave, fills from `IDENTITY_FILL`, labels White/Blue/Black/Red/Green/`MANA_LABEL.C`/Multicolour; `type`/`set` → keep the first 5 named buckets Rust gave (already ranked), fold every other named bucket **and** Rust's `other` into one `{key:"other", label: "Other types" | "Every other set", fill: OTHER_FILL}` summed per point, fills `CATEGORICAL[i]` by position. Type labels: Creature, Planeswalker, Instant, Sorcery, Artifact, Enchantment, Battle, Land. Set labels: `name ?? key.toUpperCase()`.
- `shownValues(change)`: `(v / base − 1) × 100` where `base` is the series' first non-zero value in the window; points before it are 0. A series that is zero throughout is all zeros. Never `Infinity`/`NaN`.
- `scaleFor`: `value` → the padded domain of `PriceChart.tsx`'s `priceScale` (copy the arithmetic and its comments' reasons, do not import the private function); `change` → a domain that always includes 0, padded 12% of the span (min 1), ticks from the same clean-step search (1, 2, 2.5, 5 × 10ⁿ, ≤ 4 ticks). Tick values are `+0`-normalised (no `-0`).
- `tickLabel`: `change` → `+10%`, `0%`, `−5%` (U+2212, one decimal only when needed); `value` → whole units in the currency (`formatPrice` then strip `.00`, or an `Intl.NumberFormat` with 0 fraction digits keyed by currency).
- `readoutAt`: see the Contract; step words: 1 day apart → "that day", 7 → "that week", else "since <short date>". The note appears only when `collectionChange` ≠ 0: "+$74.60 of cards added that week" or "−$20.00 of cards removed that day" (money through `formatPrice`, sign U+2212).
- `layoutFor`: implements the spec's fit table in **body pixels** (`fit.bodyWidthPx`/`bodyHeightPx`), with: figures height `16 + (tier ≥ 2 ? 28 : 24) + (compact ? 5 : 8) + 1`; controls 26 high; row pitch 27 (24 + 3); rail width 214 at 6 cells, 236 at 7–8; controls shown at tier ≥ 2 and `h ≥ 3`; ranges when body width ≥ 400; measure when ≥ 520; list two-column at tier 2 and `h ≥ 4` (non-total), strip at tier 1–2 and `h ≥ 3` otherwise; vertical gap 8 (5 compact); `railRows` = whole rows that fit under the rail's figure block. **Every rect must lie inside the body** (test this over every footprint 2..8 × 2..6 in both densities).
- [ ] Write the tests first (TDD): fold for each split (including the 5 + other rule and label/fill mapping), windowing and `historyShort`, change with a zero base, scale ticks for a small and a large range and for negative change, `collectionChange` and the note wording for add, remove and none, `readoutAt` on the live point ("Today"), `markerDays`, `dateTicks` (year-crossing long first label; mid label only when it clears both ends), and the `layoutFor` sweep.
- [ ] **Run:** `npx vitest run src/features/home/valueHistory/model.test.ts`.
- [ ] **Report**; do not commit.

---

### Task 4: The widget — chart, readout, body, stories and test (owner: agent **C**)

**Files:**
- Create: `src/features/home/widgets/ValueHistoryWidget.tsx` — the body.
- Create: `src/features/home/valueHistory/ValueChart.tsx` — the SVG chart (context lines, lit line + wash, end dot, hover dots, crosshair, markers, gridlines, right-hand scale, date ticks) and the scrub overlay (`role="slider"`, arrows / Home / End / PageUp / PageDown / Escape).
- Create: `src/features/home/valueHistory/ValueReadout.tsx` — the hover/keyboard readout panel.
- Create: `src/features/home/widgets/ValueHistoryWidget.test.tsx`, `src/features/home/widgets/ValueHistoryWidget.stories.tsx`.

**Interfaces:** Consumes Task 3's model (exact names in the Contract), Task 2's `ipc.collectionValueHistory` and types, Task 5's `valueHistoryKey`, the existing `collectionTotalKey` + `ipc.collectionSummary` (for `unpriced` and the empty state — exactly as `CollectionValueWidget.tsx` calls them), `WidgetBodyProps` (`widget, fit, editing, still, onConfig`), `pickOf` / `toggleOn` (`../widgetSettings`), `WidgetMessage`, `UP_FILL`/`DOWN_FILL`, `useMarketplace`, `formatPrice`.

**Rules:**
- Read `src/features/home/priceHistory/PriceChart.tsx` first and follow it: measured width (`useMeasuredWidth`'s callback-ref pattern — copy it, it is not exported), crisp hairlines, the dot-in-a-ring, `aria-hidden` drawing with one `sr-only` sentence, time (not index) on x.
- Visuals are the design canvas's (`ValueGraph` board): in-card chips are `WidgetSettingsPanel`'s `CHIP` look (`rounded-md border px-2 py-[3px] text-[0.8125rem]`, on = `border-accent text-accent`); the figure line is `WidgetFigures`' look; list rows are `WidgetRow`'s look (bordered, `aria-pressed` for the followed bucket, pressed = `border-accent`); deltas are body ink on a tinted chip (`UP_FILL`/`DOWN_FILL` at 20%), never coloured text.
- **The in-card chips write config** through `onConfig({ split })`, `onConfig({ window })`, `onConfig({ measure })` — the same keys the registry declares. The followed bucket and the hover index are local `useState`.
- **`still` and `editing` bodies** draw everything but take no pointer or keyboard input and write nothing (no chip presses, no scrub, no readout).
- **The readout is never clipped** by the card or the body scroller and must land at the pointer under the home grid's CSS `zoom`. Read `src/components/tooltip/` (the root-mounted `useTooltip` machinery) and **reuse its mounting and positioning mechanism** — a panel at the app root at `LAYER.tooltip`, positioned from the scrub target's measured rect — rather than inventing one; if its API cannot carry a rich, pointer-following panel, extend it minimally and report exactly what you changed (it is outside your file list: report it, do not edit it). Viewport width is `document.documentElement.clientWidth`, never `innerWidth`.
- States: loading, failed (`WidgetMessage tone="destructive"` + `ipcError`), nothing owned (`collectionSummary.totalCards === 0`), first day (`points.length === 1`), short history (first date tick reads "History starts <date>").
- Stories: `title: "Home/ValueHistoryWidget"`, a `Framed` helper like `PriceMoversWidget.stories.tsx`'s, stories for 6×3 Card type, Total 1 year Value, Colour 8×4, Set 4×4, 2×2 tile, Compact, Cardmarket, Empty (`fake: { seed: "empty" }`), and a play that hovers the chart and finds the readout's date.
- Tests (`ValueHistoryWidget.test.tsx`, pattern of `PriceMoversWidget.test.tsx`): renders the region and the figure; a chip press calls `onConfig` with the right key; a list-row press moves the lit line (`aria-pressed`); arrow keys on the slider change `aria-valuetext`; the readout shows every bucket's value for the hovered point; first-day and empty states; `still` renders no slider focus/press handlers (pressing a chip calls nothing).
- [ ] **Run:** `npx vitest run src/features/home/widgets/ValueHistoryWidget.test.tsx` once Tasks 2, 3 and 5 have landed their files (if a sibling's file is missing, report and leave it for fan-in). Do **not** run `src/stories.test.tsx` or Storybook.
- [ ] **Report** anything you needed from a file you do not own; do not commit.

---

### Task 5: Registry, key and page wiring (owner: agent **W**)

**Files:**
- Modify: `src/features/home/widgets.ts` — `"valueHistory"` in `WidgetKind`, the Contract's `WIDGET_META` row (place it right after `collectionValue` so the catalogue shows the two value widgets together), the kind-count doc sentence ("The eleven kinds…" → twelve).
- Modify: `src/features/home/widgets.test.ts` — `EVERY_KIND` gains `valueHistory: true`; the per-kind vocabulary `toEqual` gains the row. `DEFAULT_LAYOUT` untouched.
- Modify: `src/features/home/keys.ts` + `src/features/home/keys.test.tsx` — `valueHistoryKey` per the Contract, with a doc comment in the file's style, and its literal-shape case.
- Modify: `src/features/home/HomePage.tsx` — import `ValueHistoryWidget` and add its `case "valueHistory":` to `renderBody`.
- Modify: `src/features/home/HomePage.test.tsx` — the `vi.mock("./widgets/ValueHistoryWidget")` beside the others.
- Modify: the stale body counts in `src/features/home/widgetProps.ts:3`, `src/features/home/WidgetParts.tsx:3`, `src/features/home/WidgetCatalogue.tsx:196` — reword so they state no number (the repo's rule: do not write down a count a build answers).

**Interfaces:** Consumes the Contract's `ValueSplit`/`MarketplaceId` types (import type from `@/lib/ipc`) and `ValueHistoryWidget` (default or named export — **named**: `export function ValueHistoryWidget`). Produces `valueHistoryKey` and the registry row for Task 4.

- [ ] **Run:** `npx vitest run src/features/home/widgets.test.ts src/features/home/keys.test.tsx` (HomePage.test.tsx needs Task 4's file; run it only if that file exists).
- [ ] **Report**; do not commit.

---

### Task 6: Documentation (owner: agent **D**)

**Files:**
- Modify: `docs/reference/home-page.md` — the widget table gains a `valueHistory` row (and fix the heading that already undercounts: make it state no number); the §6 commands table gains `collection_value_history`; a new numbered section at the end, "The collection value graph — user schema v50, `price_snapshots.copies`", covering: why copies (the table had prices but not holdings), no backfill and why, the read-time thinning and why (a sold printing's mid-week row), the live point and why it must equal `collection_summary`, `moved` and the derived collection-change, the bucket rules (type precedence = `typeBucket`, colour = breakdown's, set cap 8 in Rust and 5 + Other in TS), the two palettes and the failed mana pastels measurement, the fit table, and the readout's mounting.
- Modify: `src-tauri/CLAUDE.md` — the `USER_SCHEMA_VERSION` paragraph gains v50 in the ladder's own voice (one sentence of what it adds and the one rule: copies NULL before the upgrade are never read); do not restate counts.
- Modify: `docs/reference/data-and-sync.md` — the schema ladder's v50 line.
- Modify: root `CLAUDE.md` only where it states a widget-kind count (line ~247, "the ten widget kinds") — reword to state no number.

**Rules:** Match each file's voice (long-form, reasons over rules, measurements dated). Never write a count a build answers. Do not touch code.

- [ ] **Report** the sections added; do not commit.

---

### Task 7: Fan-in (controller)

- [ ] `git status --short`; read every diff; grep for any file no task owned that the sweep missed (`price_snapshots`, `collectionValue`, `WidgetKind`, `EVERY_KIND`).
- [ ] Commit per bucket with explicit pathspecs (`git commit -o <paths> -m …`), Rust first.
- [ ] `npm run verify` once, bare (no pipe), foreground; fix fan-in breaks (cross-bucket tests, story plays).
- [ ] `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` in `src-tauri` (verify skips both).
- [ ] Live pass: launch via the `running-the-app` skill, add the widget from the catalogue, hover and arrow through the chart at 1× and 1.5× home zoom, switch all four splits and the three measures/ranges, and check the readout is at the pointer and unclipped.
- [ ] Whole-branch review (`superpowers:requesting-code-review`), then offer the PR.
