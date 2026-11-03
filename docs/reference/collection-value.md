# The reduced price

What a reader expects to get for their cards, drawn beside what the market lists them at:
`$6,247.11 ($4,331.79)`. Issues [#1449](https://github.com/Msgaihede/mtg-grimoire/issues/1449) (a
sell percentage) and [#1450](https://github.com/Msgaihede/mtg-grimoire/issues/1450) (a minimum card
value), combined into one price by the owner's decision of 2026-11-01. The approved design is the
[Collection Value Settings canvas](https://claude.ai/artifact/Rmb1qt65YerawdkRRedvTw).

## The sum

`reduced = (full − below the minimum) × sell percentage + copies below × bulk price`, in
`packages/ui/lib/collectionValue.ts`. Every surface calls `reducedValue`, so no two can come to
different answers.

- **The minimum goes first**, because it is a fact about each card's market price: a $0.60 card at
  70% is still a card worth selling against a $0.50 minimum.
- **Compared per copy, at the copy's own price**, so a foil is judged at its foil price and a
  playset of $0.40 cards is below $0.50 however much the four add up to.
- **Strictly below**: a card priced exactly at the minimum counts.
- **An unpriced copy is not below anything.** It is already `unpriced`, and the tooltip says so.
- **A bulk price counts each copy under the minimum back at that price** (issue
  [#1477](https://github.com/Msgaihede/mtg-grimoire/issues/1477)) rather than at nothing: every
  card under $1 worth $0.01, say. It is added **after** the percentage, because it is already what
  a buyer pays for such a card and a percentage off it would reduce it twice, and it is a line of
  its own in the breakdown (_Bulk at $0.01 · 466 cards +$4.66_). It counts only while a minimum is
  set — Settings greys its box until then — and `0`, the default, takes those copies out as before.

## Who answers what

Rust supplies a fact and TypeScript draws the conclusion. The percentage and the bulk price never
reach a statement: changing either asks nothing of the database. The minimum has to reach one, because only SQL can
compare it per copy. It travels as `minimumValue` on `collection_summary`, `collection_shelf_counts`,
`collection_folder_summary` and `collection_value_history`, and each answers `belowMinimum` (`{cards,
value}`), or `below` and `belowCards` on a graph point — the copies a bulk price multiplies, the
live point's equal to the header's `belowMinimum.cards`. **Asked no minimum, the field is absent**, so every other
caller's answer is byte-identical to what it was, and it sits in the read's query key only when set.

The setting is one `app_meta` row, `collection_value` (`crates/grimoire-core/src/collection_value.rs`),
`scansounds.rs`'s shape: written whole, a bad row reads as the defaults, a fact about this device and
not synced. Its minimum and bulk price are in the marketplace's own currency and nothing converts
them; a row from before the bulk price reads with none (`#[serde(default)]`).

## Where it is drawn

| Surface | How |
| --- | --- |
| Collection page bar | `Figure`'s `reduced`, between the gold value and its word |
| Folder headings | `ShelfHeading`'s `reduced`, rolled up the tree with the rest of the figures. None under a filter, whose `N of M` states no money |
| Home: Summary | The Value figure only. Beside the number where the cell is wide enough, under it where it is tall enough (`figureGrid`'s `stacked`), and the number steps down a size where it is neither |
| Home: Collection value | The total only. The bars stay at full value: a bar is where the money is, not what it would fetch |
| Home: Collection value graph | Under the figure in the rail, on a tile and on a split; beside it on a band's Total. Every hovered day in the readout |
| Home: Folders | Under each collection folder's money, where a row's caption leaves a second line; beside it would cut the name to one letter. A bare row says it only in its press label, a tile in its caption. Wishlist folders never draw one |

**The graph's dashed line is drawn only on Total, in `$`.** On `%` the two lines all but overlap, and
on a split the chart draws no total for it to sit under. A 2×2 tile leaves it out too. A rail row
names it; a band has no rail, so the line carries its name.

**History uses today's settings against each day's own prices**: `price_snapshots` keeps every
printing's price, so a card that fell under the minimum last week counts before that and not after.
It is not a record of what the reader had set at the time.

**Open Packs has figures of its own**, not these: a sell percentage, a minimum and a bulk price on
the page, kept per device in `localStorage` and never in `app_meta` ([draft-and-packs.md](draft-and-packs.md)).
It runs the same `reducedValue`, with the minimum compared in TypeScript (`belowMinimumOf`) over
the cards it opened, and its tooltip names the page instead of Settings (`ReducedPrice`'s `setIn`).

**The two bulk prices never meet** (issue
[#1477](https://github.com/Msgaihede/mtg-grimoire/issues/1477)): the collection's is
`CollectionValue.bulkPrice` in the `collection_value` row, set in Settings; Open Packs' is the same
field of the page's own `grimoire.packs.reduced`. Neither is read where the other is set.

## `ReducedPrice`

`components/ReducedPrice.tsx` draws the brackets, the dotted underline and the tooltip's breakdown.
It is a `<button>` that presses nothing, so the keyboard reaches the tooltip. **`plain` is for a
figure already inside a press** (Summary's Value, a Folders row), where a button in a button is
invalid HTML: there the tooltip is pointer-only, and the press's own name says the price.

On the phone the tooltip has no hover. The band still shows the price, and the folder lines do not.
