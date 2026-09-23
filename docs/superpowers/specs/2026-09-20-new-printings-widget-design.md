# New printings — a widget for reprints of cards your decks already hold

**Status: design settled, nothing implemented.** [Issue #462](https://github.com/Msgaihede/mtg-grimoire/issues/462),
raised from the Luminia Discord on 2026-09-14. Drawn on a Design canvas on 2026-09-20; the
artboards are in [`new-printings-widget/`](new-printings-widget/) beside this file, and every
pixel below was taken off them. The artboards were themselves laid out by running
`src/features/home/fit.ts`'s arithmetic — cell 104, `GAP` 12, `titleRowPx` 40, `bodyPadPx` 10,
`rowGap` 6, `listColumns = round(widthPx / 240)` — so a number here that disagrees with `fit.ts`
is this document being wrong, not the source.

Three directions were drawn; this is the one chosen. The other two (a dense ledger, a card-face
strip) are recorded only here: the ledger lost because it had nowhere to put the deck count, and
the strip lost because a 4×2 band cannot go tall, and going tall is what this widget is for.

**The tenth kind, and it reaches Rust exactly once** — one new read command. `home.rs` is
untouched: `kind` is a free `String` there and `config` is an opaque `Value`, which is the whole
point of §1 of [`home-page.md`](../../reference/home-page.md). No schema change: every column this
needs already exists.

---

## 1. What it draws

Reverse-chronological printings, **grouped by release day**, of cards that appear in the decks the
reader watches. One row per printing. Pressing a row opens a popover of the decks holding that
card; pressing a deck there opens the card in that deck.

The day group is borrowed from `ActivityWidget`, deliberately: this app already teaches that a
dim uppercase date with a rule and a count means *these things happened together*, and a reprint
feed is the same sentence about a different noun.

---

## 2. The data: one command, no schema change

Everything needed is already stored.

| Fact | Where | Note |
| --- | --- | --- |
| a printing's release date | `corpus.cards.released_at` | `TEXT`, `YYYY-MM-DD`, nullable |
| a printing vs. a card | `cards.id` is the printing, `cards.oracle_id` the card | `idx_cards_oracle` already narrows on it |
| paper only | `cards.is_paper = 1` | `PRINTINGS_WHERE`'s second half, in `card.rs` |
| what a deck holds | `deck_cards.card_id`, `.deck_id`, `.quantity` | |
| theory vs. live | `deck_cards.variant IN ('live','theory')` | the issue's "theory/draft variants" is **per card**, not per deck |
| virtual decks | `decks.virtual_only` | excluded by default, per the issue |
| basic lands | `cards.type_line LIKE 'Basic Land%'` | there is no `is_basic` column; this is the only filter available |

### The command

```rust
#[tauri::command]
pub fn new_printings(
    state: State<Db>,
    scope: String,          // "all" | "pinned" | "chosen"
    deck_ids: Vec<i64>,     // read only when scope == "chosen"
    days: i64,              // 30 | 90 | 365 — clamped, see below
    include_virtual: bool,
    include_theory: bool,
    include_basics: bool,
    limit: Option<i64>,
) -> Result<NewPrintings, String>
```

```ts
export interface NewPrintingDeck {
  deckId: number;
  name: string;
  quantity: number;
  variant: "live" | "theory";
  virtualOnly: boolean;
}

export interface NewPrinting {
  printingId: string;      // cards.id
  oracleId: string;
  name: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  releasedAt: string;      // never null on the wire — see below
  rarity: string;
  promoTypes: readonly string[];
  finishes: readonly string[];
  decks: readonly NewPrintingDeck[];
}

export interface NewPrintings {
  printings: readonly NewPrinting[];
  /** How many decks the scope resolved to. `0` is a real answer and has its own sentence. */
  decksWatched: number;
  /** The window's far edge, `YYYY-MM-DD`. */
  since: string;
  /** The oldest printing actually in the answer, or `null` when there are none. */
  oldest: string | null;
}
```

**`decksWatched`, `since` and `oldest` travel beside the list for `PriceMovers`' reason**: an empty
list means one of three different things — *no deck is watched*, *nothing was reprinted in this
window*, *the window is shorter than your card data goes back* — and a count of zero printings
cannot tell them apart. §7 is the three sentences.

**`released_at` is nullable in the corpus and must not be on the wire.** A printing with no date
cannot be placed in a day group, so the `WHERE` drops it (`released_at IS NOT NULL`) rather than
the body inventing a bucket for it. Measured population is not known for this column; if it turns
out to be non-trivial, that is a finding for `docs/reference/data-and-sync.md`, not a reason to
draw an *Undated* group.

### The shape of the read

**Two statements over one `WHERE`, `list_printings`' pattern** — the page, then the decks for the
printings on it. A single join to `deck_cards` would multiply a printing by the decks holding it
and then need distinct-ing back down, which is how the "each printing appears only once"
requirement in the issue gets quietly broken.

```sql
-- 1. the page
WITH watched AS (
  SELECT d.id, d.name, d.virtual_only
  FROM decks d
  WHERE (:scope_predicate)
    AND (:include_virtual OR d.virtual_only = 0)
),
held AS (
  SELECT DISTINCT c.oracle_id
  FROM deck_cards dc
  JOIN watched w      ON w.id = dc.deck_id
  JOIN corpus.cards c ON c.id = dc.card_id
  WHERE (:include_theory OR dc.variant = 'live')
    AND (:include_basics OR c.type_line NOT LIKE 'Basic Land%')
)
SELECT p.id, p.oracle_id, p.name, p.set_code, p.set_name, p.collector_number,
       p.released_at, p.rarity, p.promo_types, p.finishes
FROM corpus.cards p
JOIN held h ON h.oracle_id = p.oracle_id
WHERE p.is_paper = 1
  AND p.lang = 'en'                      -- ⚠ see below
  AND p.released_at IS NOT NULL
  AND p.released_at >= :since
ORDER BY p.released_at DESC, p.set_code ASC, p.collector_number ASC, p.id ASC
LIMIT :limit
```

> ⚠ **`lang = 'en'` is load-bearing and is the one decision in this file that is not obviously
> right.** `cards.id` is one printing *in one language*, so a set that ships in ten languages is
> ten rows of the same reprint and the issue's deduplication requirement fails on the first
> non-English set. `list_printings` does not filter language because a printings list is *supposed*
> to show them; a feed is not. Filtering to `en` is the simplest thing that satisfies the issue.
> The alternative — collapse to the language of the deck card that matched — is more correct for a
> reader whose decks are not English and is more code. **Pick one before writing the query.**

Statement 2 takes the `oracle_id`s of the page and answers `watched.id, watched.name,
dc.quantity, dc.variant, d.virtual_only` per oracle id, which the Rust folds into each row's
`decks`. `quantity` sums across a deck's categories: the issue's "use total card count" is a
`SUM(dc.quantity) GROUP BY dc.deck_id, c.oracle_id`, and it is what makes a deck holding a card in
both a live and a theory category appear once with the total rather than twice.

### One read, whatever the box

`NEW_PRINTINGS_READ = 100`, the command's own clamp, and **the box cuts that to whole rows**. A
read sized to the rows that fit would re-issue on every drag of the resize corner and paint
*pending* over a list that was already right — `RecentCardsWidget` and `PriceMoversWidget` both
say this at their own sites and it is the same rule here. `days` is clamped to `1..=365` in Rust
so a hand-edited `config` cannot ask for the whole corpus.

---

## 3. The registry row

```ts
newPrintings: {
  label: "New printings",
  description: "Reprints of cards your decks already hold, newest first.",
  def: [3, 3],
  min: [2, 2],
  max: [8, 12],
  picks: [
    {
      key: "scope",
      label: "Which decks",
      options: [
        { id: "all", label: "All decks" },
        { id: "pinned", label: "Pinned" },
        { id: "chosen", label: "Chosen…" },
      ],
    },
    {
      key: "window",
      label: "Window",
      dflt: 90,
      options: [
        { id: 30, label: "30 days" },
        { id: 90, label: "90 days" },
        { id: 365, label: "A year" },
      ],
    },
  ],
  toggles: [
    { key: "virtual", label: "Virtual decks", dflt: false },
    { key: "theory", label: "Theory cards" },
    { key: "basics", label: "Basic lands", dflt: false },
  ],
  chip: "window",
},
```

`scope` reuses `DecksWidget`'s vocabulary rather than minting a second one; `Chosen…` opens a deck
checklist as `extraSettings`, the seam `WidgetSettingsPanel` already has for exactly this (it is
what `Pinned` uses on the Decks widget).

> ### ⚠ `WidgetToggle` cannot express an off-by-default switch, and this kind needs two
>
> `toggleOn` is `stored(widget)[key] !== false` and `WidgetSettingsPanel` writes
> `{ [key]: on ? false : undefined }` — **absent means on**, deliberately, so a reader who has
> changed nothing sees the whole face the catalogue showed them. The issue requires the opposite
> for two switches: virtual decks and basic lands are **excluded by default**.
>
> Spelling them negatively (`hideBasics`) makes the panel read *Hide basic lands ☑*, which is a
> double negative at the one place the design is trying to be plain. The change is small and
> belongs in the registry, not in this kind:
>
> ```ts
> export interface WidgetToggle { key: string; label: string; dflt?: boolean }
>
> export function toggleOn(widget: HomeWidget, key: string, dflt = true): boolean {
>   const v = stored(widget)[key];
>   return typeof v === "boolean" ? v : dflt;
> }
> ```
>
> and the panel's writer becomes `onConfig({ [key]: next === dflt ? undefined : next })` — still
> *the default stores nothing*, which is the rule the current code is an instance of rather than
> the rule itself. `widgetSettings.test.ts` pins the current behaviour; it gains a case, it does
> not change one. Every existing toggle omits `dflt` and keeps behaving exactly as it does today.
>
> **Theory cards default on.** A theory card is one the reader intends to own, which is precisely
> the reader who wants to know it was reprinted. This is a judgement, not something the issue says.

`max: [8, 12]` is the answer to *how tall*. 12 cells is 1 380px — already taller than the content
area of a 1 080p window, so the page scrolls to the card rather than the card scrolling inside
itself. `home.rs` allows `h` up to `MAX_H` (40) and knows nothing about this number; the cap is the
registry's alone.

---

## 4. What a row says, by width

`fit.ts`'s tier, unchanged: `w ≤ 2` is 0, `w = 3` is 1, `w = 4–5` is 2, `w ≥ 6` is 3.

| Part | tier 0 | tier 1 | tier 2+ |
| --- | --- | --- | --- |
| card thumb | 34 × 46, `CardArt` `variant="grid"` | same | same |
| name | 14px `font-medium text-text`, truncate | same | same |
| caption | gem · `SLD` · `3×` | gem · `SLD` · set name | + ` · borderless` from `promo_types` |
| deck count | — (in the caption) | bordered chip, `3 decks` | same |
| unseen mark | 5px accent dot | dot after the chip | same |
| day header | `18 Sep` | `Friday 18 September` | same |
| footer | `6 decks · 90d` | `6 decks watched · 90 days · basics hidden` | same |
| title-line chip | — | — | the window (`chip` needs `tier >= 2`) |

Row height is **54px** (a 46px thumb, 3px padding each side, 2px border) and `rowGap` is 6. The day
header is 16px over a 6px gap. Groups are separated by 8px, the body's own `gap-2`.

Rows flow into `fit.listColumns` columns **inside a group**, never across one: the header spans the
full width and its rows fill the columns under it. A 4-wide card is 2 columns, 6-wide is 3, 8-wide
is 4. Without that rule a 4-column card reads as four unrelated lists.

---

## 5. What height adds

| Height | What appears | Why |
| --- | --- | --- |
| `h ≥ 5` | a `Seen already` rule after the last group newer than the reader's last visit | above it the gold dots mean something; below it they would be noise |
| `h ≥ 6` | month rules between groups when the month turns — `August 2026`, `font-heading`, 12px dim | 1 380px of Fridays is unreadable without one |
| `h ≥ 8` | when the window is exhausted, a closing dim line: *Nothing older than 26 June in this window.* | a tall card should end with a statement, not trail off |

The month rule and the `Seen already` rule each cost 20px over a 6px gap; the closing line 34 over
8. They are budgeted before rows are laid in, so a card one pixel short of a rule drops a row
rather than clipping the rule.

"Last visit" is a timestamp this widget must keep. **`app_meta.new_printings_seen`**, written when
the widget renders a non-empty list — the same shape as `app_meta.recent_cards`, and the same
reason it is not a `config` key: `config` round-trips through older builds and a cursor that an
older build rewrites is a cursor that lies.

---

## 6. The drill-down

Pressing a printing opens `AnchoredPopup` (`align="end"`, `panelClassName="w-[248px]"`) titled
*<Card> is in*, listing that printing's `decks`:

- an 18px rounded cover swatch, the deck name, and `×N` in mono;
- a `theory` chip in place of the count when the holding row is `variant: 'theory'`;
- each line a `<button>` that sets `selectedCardId` and navigates to the deck — the same pair
  `DecksWidget` already does.

The popover is the reason `WidgetCard` does not clip and this body must not either.

---

## 7. The three empty sentences, and the failure

Never one sentence for three situations:

| Condition | Sentence |
| --- | --- |
| `decksWatched === 0` | *No decks are being watched, so there is nothing to compare new printings against.* + a `Choose decks…` press that opens the settings popover |
| `printings.length === 0` | *Nothing in the N decks you watch has been reprinted in the last 90 days. New printings arrive with each card data sync.* |
| pending | *Reading recent printings…* |
| error | `WidgetMessage tone="destructive"` — *Could not read recent printings — {ipcError}* |

---

## 8. The size matrix, measured

Printings visible at rest, with `listColumns`. Taken off the artboards; the sample corpus is 45
printings over 18 release days, 25 of them inside 90 days.

| Footprint | px | Columns | Printings | Window |
| --- | --- | --- | --- | --- |
| 2 × 2 | 220 × 220 | 1 | 2 | 90d |
| 2 × 3 | 220 × 336 | 1 | 3 | 90d |
| 3 × 2 | 336 × 220 | 1 | 2 | 90d |
| **3 × 3 (default)** | 336 × 336 | 1 | 3 | 90d |
| 4 × 3 | 452 × 336 | 2 | 5 | 90d |
| 6 × 4 | 684 × 452 | 3 | 10 | a year |
| 8 × 3 | 916 × 336 | 4 | 8 | a year |
| 2 × 6 | 220 × 684 | 1 | 8 | 90d |
| 3 × 8 | 336 × 916 | 1 | 11 | 90d |
| 4 × 12 | 452 × 1380 | 2 | 25 | 90d — exhausts it, closing line shows |
| 2 × 12 | 220 × 1380 | 1 | 17 | a year |
| 6 × 12 | 684 × 1380 | 3 | 32 | a year |

**A big card on a short window is mostly empty, and that is a real finding.** At 3 columns every
day group collapses to a single row-line, so ten groups filled barely half of a 6 × 12's 1 328px
of body. The fix is not a layout change: `window`'s default should follow the footprint — a card
of `w * h >= 24` arrives on *a year* rather than *90 days*. That is a one-line default in the
component, not a second registry mechanism, and it is why the wide artboards carry the `A YEAR`
chip.

Narrow-and-tall is the most efficient shape per pixel; wide-and-tall trades density for
scannability. Both are worth having, which is why `max` is `[8, 12]` and not `[4, 8]`.

---

## 9. Scrolling

The body is `WidgetCard`'s scroller — `overflow-y-auto`, `overflow-x-hidden`,
`scrollbar-slim scrollbar-accent`. Three consequences:

- **Cutting to whole rows is a painting rule, not a limit.** The rows below the cut are in the DOM
  and scrollable; the counts in §8 are what is visible at rest out of a read of up to 100.
- **Extra width becomes columns, never a sideways strip.** `overflow-x-hidden` is the card's, and
  this body must not fight it.
- **Scrolling survives Customize.** `inert` is on the body's contents, not the scroller, so the
  wheel still works while the card is being dragged. A catalogue preview (`still`) clips instead.

Day headers do **not** stick to the top of the scroller, matching `ActivityWidget`. Worth
revisiting for this kind specifically once a 12-tall card exists to try it on.

---

## 10. Files

| File | Change |
| --- | --- |
| `src-tauri/src/card.rs` (or a new `printings_feed.rs`) | `new_printings`, the two statements, the clamps |
| `src-tauri/src/lib.rs` | register the command |
| `src-tauri/src/home.rs` | **nothing** — and a test that asserts it stores this `kind` untouched |
| `src/lib/ipc.ts` | the three interfaces + `ipc.newPrintings` |
| `src/features/home/widgets.ts` | `"newPrintings"` on `WidgetKind`, the meta row, `WidgetToggle.dflt` |
| `src/features/home/widgetSettings.ts` | `toggleOn`'s default parameter |
| `src/features/home/WidgetSettingsPanel.tsx` | the writer becomes `next === dflt ? undefined : next` |
| `src/features/home/keys.ts` | `newPrintingsKey(scope, deckIds, days, flags)` |
| `src/features/home/HomePage.tsx` | one `case` in the dispatch at ~line 195 |
| `src/features/home/widgets/NewPrintingsWidget.tsx` | the body, `.stories.tsx`, `.test.tsx` |
| `docs/reference/home-page.md` | a §12 recording the tenth kind and the `dflt` change |

`DEFAULT_LAYOUT` is **not** touched: a tenth kind that displaced a shipped one would rearrange the
page of every reader who never asked for it. It arrives from the catalogue.

---

## 11. Tests worth writing before the code

- `home.rs`: a layout holding `kind: "newPrintings"` with a `config` this build does not understand
  round-trips byte-for-byte. The promise in §1 of `home-page.md`, restated for the new kind.
- `widgets.test.ts`: `WIDGET_META` still compiles as `Record<WidgetKind, …>` — the fence that makes
  a missing meta row a type error.
- `widgetSettings.test.ts`: `toggleOn` with no `dflt` is unchanged; with `dflt: false`, absent
  reads off and `true` reads on; the panel stores nothing for the default either way.
- The command: a printing reprinted into two watched decks appears **once** with two `decks`
  entries; a basic land is dropped unless asked for; a virtual deck contributes nothing by default;
  a `variant: 'theory'` row contributes only when `include_theory`; a non-English printing of the
  same set does not produce a second row.
- `NewPrintingsWidget.test.tsx`: at 2 × 2 exactly 2 rows render and no chip; at 4 × 12 the closing
  line renders and the month rules appear; `decksWatched: 0` renders the *no decks* sentence and
  not the *nothing reprinted* one.

---

## 12. Decided in the mock, not in the issue

Flagged so they are re-decided on purpose rather than inherited:

1. **A `window` pick exists at all.** The issue has no end to the list. Without a window the feed
   has no natural bottom and the closing line in §5 has nothing to say.
2. **`lang = 'en'`** (§2) — the deduplication requirement forces *some* answer here.
3. **Theory cards default on, virtual decks and basics default off** (§3).
4. **The window's default scales with the footprint** (§8).
5. **The unseen cursor is `app_meta`, not `config`** (§5).
