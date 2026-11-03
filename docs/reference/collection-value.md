# The reduced price

What a reader expects to get for their cards, drawn beside what the market lists them at:
`$6,247.11 ($4,331.79)`. Issues [#1449](https://github.com/Msgaihede/mtg-grimoire/issues/1449) (a
sell percentage) and [#1450](https://github.com/Msgaihede/mtg-grimoire/issues/1450) (a minimum card
value), combined into one price by the owner's decision of 2026-11-01. The approved design is the
[Collection Value Settings canvas](https://claude.ai/artifact/Rmb1qt65YerawdkRRedvTw).

## The sum

`reduced = (full − below the minimum) × sell percentage`, in `packages/ui/lib/collectionValue.ts`.
Every surface calls `reducedValue`, so no two can come to different answers.

- **The minimum goes first**, because it is a fact about each card's market price: a $0.60 card at
  70% is still a card worth selling against a $0.50 minimum.
- **Compared per copy, at the copy's own price**, so a foil is judged at its foil price and a
  playset of $0.40 cards is below $0.50 however much the four add up to.
- **Strictly below**: a card priced exactly at the minimum counts.
- **An unpriced copy is not below anything.** It is already `unpriced`, and the tooltip says so.

## Who answers what

Rust supplies a fact and TypeScript draws the conclusion. The percentage never reaches a statement:
changing it asks nothing of the database. The minimum has to reach one, because only SQL can
compare it per copy. It travels as `minimumValue` on `collection_summary`, `collection_shelf_counts`,
`collection_folder_summary` and `collection_value_history`, and each answers `belowMinimum` (`{cards,
value}`), or `below` on a graph point. **Asked no minimum, the field is absent**, so every other
caller's answer is byte-identical to what it was, and it sits in the read's query key only when set.

The setting is one `app_meta` row, `collection_value` (`crates/grimoire-core/src/collection_value.rs`),
`scansounds.rs`'s shape: written whole, a bad row reads as the defaults, a fact about this device and
not synced. Its minimum is in the marketplace's own currency and nothing converts it.

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
**It is the one surface that draws the reduced price in place of the full value** (issue
[#1502](https://github.com/Msgaihede/mtg-grimoire/issues/1502)): what a pack would fetch is the
figure a reader opens packs to learn, so the full value is said only in the tooltip's breakdown.
Its expected value and simulation are drawn card by card, so it also runs the per-copy form,
`reducedCopy` — the same sum one copy at a time (`(full − below) × percent + cards below × bulk` is
a sum over copies of it), which the suite holds equal to `reducedValue` to the cent.

**The bulk price is Open Packs' alone** (issue
[#1477](https://github.com/Msgaihede/mtg-grimoire/issues/1477)): `reducedValue` takes it as
`ReducedSettings.bulkPrice`, and with a minimum set counts each card under it back at that price,
after the percentage — `(full − below) × percent + cards below × bulk` — as a breakdown line of its
own. The collection's setting (`CollectionValue`, Rust's `collection_value`) has no such field, so
every collection surface still takes those cards out.

## `ReducedPrice`

`components/ReducedPrice.tsx` draws the brackets, the dotted underline and the tooltip's breakdown.
**`bracketed={false}`** drops the brackets where the reduced price is the figure rather than an
aside to the full one — Open Packs alone.
It is a `<button>` that presses nothing, so the keyboard reaches the tooltip. **`plain` is for a
figure already inside a press** (Summary's Value, a Folders row), where a button in a button is
invalid HTML: there the tooltip is pointer-only, and the press's own name says the price.

On the phone the tooltip has no hover. The band still shows the price, and the folder lines do not.
