# Collection value graph — design

**Date:** 2026-09-26 · **Status:** approved design, implementation planned in
`docs/superpowers/plans/2026-09-26-collection-value-graph.md`.
**Design canvas:** <https://claude.ai/artifact/FqJsY5YXr8KdA21sbgvFJc> — the `ValueGraph` component
board is the reference for every size, state and interaction below.

## What it is

A twelfth home-page widget kind, `valueHistory`, labelled **Collection value graph**: the
collection's value over time, drawn as one line per bucket with one line *lit* and the rest as
faint context, a list of the buckets beside or under it, and a readout of every figure the
hovered day holds.

It answers a question the existing `collectionValue` widget cannot: that one is a snapshot split
four ways; this one is the same money **over time**. The two are separate kinds and neither
replaces the other.

## The four splits

| Split | Buckets | Colours |
| --- | --- | --- |
| `total` | one series, the collection | the accent (money is gold) |
| `type` | the deck Stacks precedence — Creature, Planeswalker, Instant, Sorcery, Artifact, Enchantment, Battle, Land — on the **front face**, first match wins; anything else is Other | the 5-slot categorical palette below, top 5 by today's value, the rest folded into a grey **Other types** |
| `color` | W, U, B, R, G, colourless (`c`), multicolour (`multi`) — `collection_breakdown`'s own colour buckets | the stepped identity palette below, fixed WUBRG order |
| `set` | one per set | the categorical palette, top 5 by today's value, the rest folded into **Every other set** |

The type precedence is `src/features/decks/deckBuckets.ts`'s `TYPE_BUCKETS` / `typeBucket`
exactly (Artifact Creature → Creature, Artifact Land → Artifact, Dryad Arbor → Creature), chosen
so a reader meets one answer to "what type is this card" across the deck editor and the home
page. **A card is in exactly one bucket**, so the buckets always sum to the total.

### Palettes (validated for colour-blind separation against `--color-bg` #0c0d12)

- **Categorical** (type, set), fixed slot order: `#4c88d3`, `#d5753a`, `#009b8f`, `#9460b7`,
  `#819f47`; the folded Other is `#55585f`. Passes every adjacent-pair check (worst CVD ΔE 9.4,
  normal-vision 22.4).
- **Colour identity**, WUBRG then colourless then multicolour: `#dfd19d`, `#1f86cd`, `#725195`,
  `#cc3f2f`, `#53be70`, `#5c6b7a`, `#deb459`. Adjacent pairs pass (worst CVD ΔE 10.4). White,
  colourless and multicolour sit outside the validator's lightness/chroma band **on purpose** —
  they have to read as white, grey and gold — so identity is carried by the list's words and the
  readout, never by colour alone.
- The existing value widget's `--color-mana-*` pastels were measured and **fail** (Black and
  Colourless ΔE 2.0), so they are not reused here.

## The data

**Price history exists; holdings history does not.** `price_snapshots` (user schema 45) keeps
each owned printing's price per marketplace per day but not how many copies were held, so a past
total cannot be rebuilt from it.

**User schema v50 adds `price_snapshots.copies INTEGER`**, written by the snapshot in the same
statement as the price (the sum of `collection_entries.quantity` for that printing and finish,
which the snapshot already computes to decide what is owned). Rows written before the upgrade
carry NULL and are **not** read: the graph starts on the upgrade day. No backfill — a backfill
with today's quantities would show cards added last week as owned all along.

**One read, `collection_value_history(split, marketplace)`,** answers:

- every kept snapshot period before today, oldest first — **daily inside the 35-day window, one
  point per 7-day bucket beyond it**, the table's own thinning rule applied again at read time so
  a printing sold mid-week cannot make a point of its own;
- **plus a live point for today**, computed from `collection_entries` at today's price the way
  `collection_summary` computes the collection's value, so the graph's last point is exactly the
  number the Collection value widget shows;
- per point: the total, one value per bucket, and **`moved`** — the part of the change since the
  previous point that came from prices alone (for every printing present at both points,
  `copies_before × (price_now − price_before)`). The rest of the change is what the reader added
  or removed; TypeScript derives it as `total − previous total − moved`.

Everything past that is TypeScript's: which buckets to fold into Other, what the range shows,
percent change, the readout's sentences, the markers.

## The widget

- **Registry:** default footprint 6×3, min 2×2, max 8×6. Picks: **Split by** (Total, Card type,
  Colour, Set — default Card type), **Range** (30 days, 90 days, 1 year, All — default 90 days),
  **Measure** (Value, Change — default Change). Toggles: **Show totals**, **Mark collection
  changes**. Chip: the split. Not in the default layout (catalogue only, like `newPrintings`).
- **The in-card chips write the same config keys the settings popover writes**, through the
  body's `onConfig`, so the two can never disagree. They are drawn only where there is room.
- **Measure = Change** plots each line as percent change since the first point in range (all lines
  start at 0%, and the one that grew most is on top); **Value** plots money on a shared axis.
- **One line is lit** — the followed bucket, 2px in its colour with a 10% wash — and the rest are
  1.5px at 30% opacity. Hovering a list row previews it; pressing pins it (session state, not
  config). Total has one line.
- **The readout** on hover (and on arrow keys — the plot is a `role="slider"`): the date; the
  total with its change since the start of the range; then every bucket's value and change, the
  lit one in bold; and, where the reader added or removed cards in that step, a note saying how
  much. On Total the readout is: value, change since start, change since the previous point,
  collection changes in that step, price moves in that step. It is never clipped by the card, and
  positions correctly under the home grid's CSS zoom.
- **Markers:** a small accent diamond on the baseline for each step whose collection-change part
  is not zero, when *Mark collection changes* is on.

### Fit (cells → content), per the design canvas

| Width | Layout |
| --- | --- |
| 2 cells (tile) | figure line (value + change) and the chart, no scale; the figure line doubles as the readout |
| 3 cells (panel) | figure line with the lit bucket beside the total; chart; a strip of bucket names when 3+ tall |
| 4–5 cells (band) | figure line; the in-card chips (split + range; measure too at 5); chart; the strip, or a two-column list when 4+ tall |
| 6+ cells (row) | in-card chips across the top; chart on the left; a rail on the right holding the total and the bucket list (or, on Total, Change / Price moves / Collection changes / High / Low) |

Compact density tightens padding and gaps as every widget does. Whole rows only: a list that does
not fit folds its tail into one "N more" row.

### States

Loading (*Reading your price history…*), failed (*Your price history could not be read.* plus the
error, destructive), nothing owned (*Nothing in your collection yet.*), first day (today's figure,
and *Prices are kept once a day, so the line starts tomorrow.* where the chart would be), and a
history shorter than the range (draw what exists; the first date label reads *History starts
<date>*). Marketplace follows `useMarketplace()`: currency, and the `N unpriced` note beside the
figure, as the Collection value widget does.

## Out of scope

Dragging the card by pointer is the page's; this widget adds nothing to Customize beyond its
registry row. No backfill. No sync of the new column's meaning beyond what `price_snapshots`
already has (it is not synced).
