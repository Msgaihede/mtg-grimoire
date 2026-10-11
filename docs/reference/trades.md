# Trades

The Trade page, on both faces: what a trade is in the database, where its arithmetic lives, what
finishing one does, and what was decided along the way. The design is
[the trade builder spec](../superpowers/specs/2026-10-11-trade-builder-design.md); the issue is
[#363](https://github.com/Msgaihede/mtg-grimoire/issues/363).

**Nothing on this page was measured in a shipped window.** It was built on 2026-10-11 against a
design canvas the owner reviewed board by board, and checked by both suites and by driving a
debug build. A figure quoted here is the test's, and says so.

## 1. Two tables, user schema v63

`trades` is a name, a marketplace id, a percentage for each side (`rate_mine`, `rate_theirs`), a
`status` (`open`, `finished`, `archived`), `finished_before`, an `outcome` (JSON, NULL until a
finish) and two timestamps. `trade_lines` is one printing in one finish on one side: `side`
(`mine`, `theirs`), `card_id`, `finish`, `quantity`, `source` (`collection`, `search`, `scan`),
`position`, and `unit_price`.

- **`card_id` is a soft reference**, as everywhere on the user side, and a line carries its own
  `name`, `set_code` and `collector_number`. A line whose printing has left `cards` still lists,
  with those and no price.
- **`unit_price` is NULL while the trade is open.** `trade_finish` and `trade_archive` write each
  line's price at 100%, in the trade's marketplace; `trade_reopen` clears them. That one column is
  the whole of "a closed trade keeps the prices it closed with".
- **No CHECK on the rates and no UNIQUE over a side's lines.** The commands refuse a rate outside
  50–150 or off a step of 5 in words, and fold a printing and finish a side already holds.
- **Neither table syncs and the mirror writes neither.** They are local to the device that made
  them: absent from `SYNCED_TABLES`, no `sync_uid`, on the mirror's ignored list. The full backup
  carries them, since it walks every user table.

## 2. Thirteen commands

`trade_list`, `trade_get`, `trade_create`, `trade_rename`, `trade_set_rate`, `trade_add_lines`,
`trade_update_line`, `trade_remove_line`, `trade_finish`, `trade_archive`, `trade_reopen`,
`trade_duplicate`, `trade_delete` — `crates/grimoire-core/src/trade.rs`, in the core's command
table, so the Android and web hosts answer them with no code of their own.

- **Any write to a trade that is not open is refused**, except reopen, duplicate and delete.
- **`trade_update_line` applies printing, finish, quantity and side in that order, then folds.** A
  finish the printing does not come in is refused; a new printing keeps the finish when it has it
  and takes its first listed one otherwise. `trade_add_lines` checks the finish as a word only: a
  collection row or a scanned card can carry a finish the printing does not list.
- **A line holds at most 9,999 copies** (`MAX_QUANTITY`, the quantity stepper's own ceiling),
  asked outright or reached by a fold; more is refused in words, and a refused add takes its
  whole batch back. Sums are formed in Rust and written as a figure: SQLite turns an
  overflowing `quantity + ?` into a REAL, which passes the column's CHECK and then makes
  `trade_list` and `trade_get` unreadable for every trade.
- **A blank rename gives `Trade {id}` back** rather than refusing.
- **A trade is always in one of the four priced marketplaces.** `cardtrader`, asked for or
  inherited from the reader's setting, is stored as `tcgplayer`, whose prices it quotes.
- **`trade_finish` is the only one that takes the owned-write path** (`with_write_owned`), because
  it is the only one that moves `collection_entries`.

## 3. Facts from Rust, conclusions in TypeScript

A line arrives with `unitPrice` (100%, the trade's marketplace: live while open, frozen after),
`finishPrices` (always live), `owned`, `ownedInDecks`, `deckNames` and `wished`.

- **A line's copies are counted in two places, and Rust never adds them together.** `owned` is
  the copies of that printing and finish **outside any deck**: unfiled, or in a folder of the
  reader's own that is not locked. `ownedInDecks` is the copies filed in a **deck's group**, and
  `deckNames` is those decks by the name their group wears, in the order a finish would take
  from them, each name once. A proxy is in neither count, and neither is `Recently removed`. A
  lock holds a binder's copies back and is not asked of a deck's group: what guards a deck's
  copy is that every surface showing one names the deck in the destructive colour.
- The fake's `trades` seed has one such line without a row of its own: Trade 5's Ragavan reads
  `owned: 1` beside `ownedInDecks: 1` in `Modern Goodstuff`, off a copy `starter` already files
  there.

Everything a reader sees beyond that is `packages/ui/features/trade/trade.ts`, in integer cents:

- **A percentage is applied to one copy, then multiplied**: `round(unit × rate / 100) × quantity`.
  Rounding a line once instead differs by a cent as soon as a unit rounds the other way — three
  copies at $0.05 at 50% are $0.09, not $0.08 — and the figure two people agree on is the card's.
- **A line with no price is counted and left out of both totals**, and the side says how many.
- **The balance is `theirs − mine`.** Whoever gives less owes the difference.
- The trades list and the open trade both go through `tradeMoney`, so a list row and the page it
  opens cannot state two balances. The fake's `trades` seed pins it: Trade 5 is $64.39 against
  $87.09, *You owe $22.70*, and $69.67 with their side at 80%.

**A trade's currency is its own marketplace's**, not the app's current one. Switching the app to
Cardmarket does not turn an open TCGplayer trade into euros.

## 4. What Finish trade does

One transaction, four optional steps, each counted into the trade's `outcome`:

1. **Take the cards given out of the collection** — `min(quantity, owned + ownedInDecks)` copies
   per line: every copy outside a deck first, and a deck's copies only for what is still owed.
   A line the copies outside cover leaves every deck as it was. Copies in a locked folder or in
   `Recently removed` are not taken, and neither is a proxy: it is not the card being traded.
   The three facts and this step read one statement (`trade::tradeable`), so what the dialog
   shows and what the press does cannot differ — the order the decks are named in included.
   - **A deck's copy leaves the way the collection removes one, and the deck is not told.**
     `collection::set_quantity`, `remove_entry` and `delete_entry` ask nothing about where a
     row is filed and write no `deck_cards` row, no `deck_audit` row and no allocation for one
     in a group; neither does this step. A deck's owned count is a sum over its group at read
     time, so the deck keeps the card on its list and reads it as not owned.
     `outcome.removedFromDecks` is how many of `removedFromCollection` came out of a group.
   - **Plain copies go first, on each side of that line.** A graded, signed, altered,
     misprinted or serial-numbered copy is taken only once the plain ones beside it have run
     out — it still counts, because the reader asked to give that many and holds them — and
     a signed copy in a binder still goes before a plain one in a deck. Within each, rows at
     the collection's root come before folders, folders in their own order, the oldest row
     first; every deck's group is made at `sort_order` 0, so among decks it is the oldest row.
     A line names a printing and a finish and nothing else, and there is no undo.
   - **A row that keeps copies has its tradelist spent**: down by the copies taken, to nothing
     and no further. The copies that left were the ones it was promising, so this is not the
     collection's clamp — a row of four with two for trade that gives two keeps none listed.
2. **Add the cards received**, to the root or a chosen reader folder.
3. **Take the cards received off the wishlist** — up to `quantity` copies per line from wishes
   for that card, the same printing first. Managed-wishlist folders are never touched.
4. **Put the cards given on the wishlist**, pinned to that printing and finish. Off by default.

A line whose printing has left `cards` is skipped by steps 2 and 4.

**A deck's copies were out of reach until 2026-10-11, and the owner reversed it the day the page
was first driven on real data.** The first rule took only unfiled and binder copies, so that a
trade could not leave a deck reading *missing* without mentioning it. On his collection 226 of
340 copies sat in a deck's group — his count, not a measurement of this page's — and a trade
offered almost nothing. So they are offered second and marked: never counted as `owned`, never
taken while another copy would do, and named wherever they are shown.

**`outcome` is cumulative, and `finished_before` survives a reopen.** Reopening undoes nothing a
finish did. So the dialog on a trade that was finished before opens with all four off — a second
pass would move the same cards twice — and the stored outcome is every finish added together,
which is what keeps a finish, reopen, finish-with-nothing-ticked from reading as "nothing
changed" on a trade that did move cards. **A stored outcome outlives the build that wrote it**:
one from before `removedFromDecks` existed parses, and reads as none.

**The home feed.** A step about one card writes that card's ordinary `activity` row. A step about
several writes one bulk row; the table's CHECK has no kind for a trade, so the three bulk rows
borrow `remove`, `import` and `clear` and carry `trade: true`, which `activityText.ts` reads to
say *Traded away 4 cards*, *Received 5 cards in a trade* and *Took 2 cards off your wishlist
after a trade*. No bulk-undo ticket is filed for a finish.

## 5. The two faces

Desktop is `packages/ui/features/trade/`: a trades pane beside the open trade, the two sides as
panels with a divider in the gap, and a balance panel holding both totals and **Finish trade**.
The phone is `apps/light/phone/pages/TradePage.tsx` and `apps/light/phone/trade/`: Trade is a
seventh light view and a sixth tab, the open trade is in the URL as `/trade/5`, and adding,
editing, the percentage, finishing and New trade are bottom sheets. Both faces word a fact through
`tradeWords.ts` and read and write through `useTrades.ts`.

- **The cache has one root, `["trade"]`, and both reads are stale at once.** A line's `owned` and
  `wished` change on pages that know nothing about trades, so the page asks again whenever it
  mounts. Across windows, `TABLE_KEYS` points the two trade tables, `collection_entries` and
  `wishlist_entries` at that root; a card sync and a price-feed refresh invalidate it too.
- **A write settles the root only when it is the last one in the air** (`useTrades.ts`). A stepper
  pressed three times is three writes, and a refetch fired by the first would draw a quantity the
  reader has already moved past.
- **A trade's id is handed out again, and the cache lets go of it at both ends.** `trades.id` is a
  plain `INTEGER PRIMARY KEY`, so deleting the newest trade gives its number to the next one made.
  `useTrades.ts` drops a trade's own read when the trade is deleted and again when a create or a
  duplicate answers with that id, and neither face remembers an id as gone: a read that answers
  `null` *and is not being asked again* is the whole of how a page knows.
- **Your side adds from the collection by default; their side adds from all cards only.**
- **A copy that would come out of a deck is drawn in the destructive colour, names the deck, and
  is never mixed in with the others.** The add field's collection scope reads twice
  (`useTradeCandidates.ts`): the copies outside the reader's decks, and — by naming the deck
  groups as `shelves` — the copies inside them, listed in a section of their own under *In your
  decks*, one row a printing, finish and deck. A line's mark is derived, never recorded:
  `givenMark` (`tradeWords.ts`) reads `fromDecks(line)`, so *from your collection* in gold turns
  to `1 from your deck Serah` in red on the press that steps the quantity past `owned`, on the
  reader's side and an open trade only. Finish trade draws `deckNote` under its first question
  in the same colour, as part of that checkbox's description.
- **New trade always offers TCGplayer and Cardmarket, and a feed marketplace only while the app is
  set to it** (`tradeWords.ts`, `tradeMarketplaceOffers`). Card Kingdom's and Mana Pool's prices
  are downloads the app fetches and refreshes for the selected marketplace alone, so a trade in
  one made while the app quotes another would have no prices — every line an em dash, *Even
  trade* — or months-old ones. The one not on offer stays in the picker, greyed, with the way to
  reach it: a tooltip on the desktop row, a sentence under the picker on the phone.

## 6. Scanning onto a side

Both Scanner pages take an optional `destination` (`features/scanner/useTrayDestination.ts`).
With one, the tray's folder picker, *Create deck…* and the developer panels are not drawn, the
commit button reads *Add 4 to their side*, and the commit is the destination's own write. The two
trade surfaces — `TradeScanDialog` on desktop, `TradeScan` on the phone — pass a destination that
calls `trade_add_lines` with `source: "scan"`.

- **The trade is written first and the tray trimmed after.** The two are not one transaction, so
  the order is chosen for what a failure between them costs: rows left in the tray that are
  already on the trade, never cards lost.
- **The tray is the Scanner view's own tray.** There is one, persisted, shared by every scanner
  surface; cards already in it when the trade scanner opens are in its list and would go onto the
  side. The surface says so in a note, and *Clear all…* is the way out.
- Scanner preferences changed there — mode, filters, camera — are the Scanner view's too.

## 7. Not built

- **Sync.** A trade made on one device is on no other.
- **A cash line.** A balance is shown and never settled.
- **Undo for a finish.** Reopen puts the trade back, not the cards — and not a copy into the
  deck it came out of.
- **Changing a trade's marketplace after it is created.**
- **Keeping a feed trade's prices fresh once the app is switched away.** An open Card Kingdom or
  Mana Pool trade goes stale if the app's marketplace is later changed: only the selected feed is
  refreshed, so the trade is priced from the last download made while its own was selected, and
  nothing on the page says how old that is.
