# packages/ui/features/draft — Draft & Packs

The desktop's Draft & Packs page: drafting a pool against phase.rs's draft bots or with people in a
lobby, building it into a deck in the deck editor, and opening boosters against their average.
Modes: Quick, Sealed, Cube, Pod (booster, Commander or Winston), Commander (you + 3 bots, two cards
a pick, a 60-card deck with a commander) and Winston (you + 1 bot, a shared stack in three piles) —
spec §4a.
Desktop only — the light app draws no such page, and every command it calls is on the desktop's
`DESKTOP_ONLY` list.

Design: [the spec](../../../../docs/superpowers/specs/2026-10-29-draft-and-packs-design.md).
Record and reasons: [draft-and-packs.md](../../../../docs/reference/draft-and-packs.md).

| Folder / file                                | Holds                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `booster/`                                   | Pure booster logic: `open.ts` (collation, `draftProduct`), `value.ts` (expected value, variance, simulation, percentile), `rng.ts` (seeded `mulberry32`), `prices.ts` (`useBoosterPrices`)                                                                    |
| `sets.ts`, `SetGrid.tsx`                     | MTGJSON's booster sets (`useBoosterSets`), one set's `BoosterSet` (`useBoosterSet`), the set wall                                                                                                                                                             |
| `packs/`                                     | Open Packs: the set page's set picker (`SetSwitcher.tsx`), the product picker, the marketplace pick (`marketplaces.ts`), the reduced price (`reducedPick.ts`), the opened wall, the figures and the histogram                                                 |
| `DraftPage.tsx`                              | The hub (_Draft in progress_, _Start new_) and the page-local state machine                                                                                                                                                                                   |
| `table.ts`                                   | The one draft slot as the page sees it: the saved draft (`useSavedDraft`, `DRAFT_SAVED_KEY`), a hosted pod drafting (`hostsDraftingPod`), a row's pack and pick (`whereOf`)                                                                                  |
| `setup/`                                     | Quick, Sealed, Cube, Commander and Winston setup; `deal.ts` deals boosters to seats and holds each table's seat bounds                                                                                                                                        |
| `pick/`                                      | The pick screen (one or two cards a pick; the pack by rarity or as dealt), the Winston table, the pool as Deck and Sideboard (`PoolZones`, `split.ts`) under the pack or in side trays (`trayLayout.ts`), the large card preview on hover (`CardPreview.tsx`), the deck's stats on a wide page (`PickStats.tsx`) |
| `build/`                                     | The hand-over from a finished draft to a draft deck                                                                                                                                                                                                           |
| `lobby/`                                     | Pod drafts: create (a supporter's), join by code, the host's room (format and seats) and the guest's                                                                                                                                                          |
| `deck/`, `useDraftDecks.ts`, `navigation.ts` | The deck editor's draft mode (`DraftDeckBar`), the unsaved draft decks (`draft_deck_list`), and the way in and out: `openDraftDeck`, `returnToDraftPage`, `openSavedDeck`                                                                                     |

## Binding rules

- **Rust supplies facts, this folder draws conclusions.** The host answers a set's sheets, weights
  and cards (`packs_booster_set`) and prices come from `printing_prices`; which cards a booster
  holds, what it is worth on average and where a pack falls are `booster/`'s. Never move that math
  to Rust, and never put a price in `BoosterSet`.
- **Open Packs prices at the page's own marketplaces** (`packs/marketplaces.ts`, issue #1446): one
  or several, picked in a searchable combobox (`packs/MarketplaceCombobox.tsx`), the app's
  marketplace until the reader picks, kept per device in `localStorage` — never `app_meta`, and
  never written to the app's setting. A card is worth each finish's lowest quote among them
  (`lowestPrices`), and never let the pick go empty.
- **Two currencies meet only through the ECB's rate** (`packs/currency.ts`, issue #1463): a pick of
  dollars and euros is priced in the app's currency, each answer multiplied by its factor
  (`convertPrices`) before the lowest is taken. With no rate, the other currency is left out and
  the page says so — never compare a euro with a dollar unconverted, and never convert a price
  anywhere but this page.
- **Open Packs' reduced price is the page's own** (`packs/reducedPick.ts`): its sell percentage,
  minimum and bulk price are kept the marketplace pick's way, and never read from or written to
  Settings' collection value. The sum is `lib/collectionValue.ts`' `reducedValue` — and its
  per-copy form `reducedCopy`, held equal to it by the suite; never write a third. Its bulk price
  (issue #1477) is apart from the collection setting's bulk price like the other two: the same
  `CollectionValue` shape, never the same stored figure.
- **Set, the reduced price is every figure on Open Packs** (issue #1502): the totals, the
  expected value, the simulation, the histogram and the chance to beat a price are all figured at
  it (`reducedPrices`), the full value said only in the breakdown's tooltip. Never figure one of
  them at full price beside the others, and keep the session's tally as prices and expected copies
  by price (never reduced sums), so a changed figure reprices it. A card under the minimum is red.
- **The set walls are MTGJSON's** (`useBoosterSets` over `packs_booster_sets`): Open Packs and a
  draft's pack order offer only the sets MTGJSON sells a booster pack of. Never build a wall from
  the corpus's `list_sets` — Scryfall splits a release into sets no booster is sold of.
- **One collation for both halves.** A draft's boosters are opened by the same `openBooster` the
  Packs page uses, from `draftProduct(set)`, and handed to the draft as printing ids. Never deal a
  draft another way.
- **A booster never holds a card this corpus lacks** (`deal.ts`' `playable`): the draft is played on
  the corpus's facts, and the engine refuses a printing it cannot read.
- **Seeded randomness only** (`booster/rng.ts`): tests are exact, and the Packs figures do not move
  between presses.
- **A draft deck is built from its pool alone** (the owner's rule): it is virtual (nothing reaches
  the collection, and its kind cannot change until Save — `DRAFT_STAYS_VIRTUAL`), and while its
  row says `draft` the editor mounts no card search dock, no Quick Add, no import, no
  `Add to ▸ Collection/Wishlist`, no Share and no goldfish. A new way into a deck must be switched
  off for a draft deck too.
- **The row's `draft` flag is the only truth** (`DeckRow.draft`, user schema v69). Never keep a
  list of draft deck ids beside the decks (issue #1467: ids are reused after a delete). The editor
  reads `row.draft` once `deck_get` answers; _Draft in progress_ lists `draft_deck_list`'s rows
  (`useDraftDecks`). Keep `DRAFT_DECKS_KEY` under the `["decks"]` root so every deck write asks it
  again.
- **A draft deck is apart from the reader's decks until Save**: `deck_list` never answers one (nor
  any count, picker, widget, mirror, share or sync), so never filter one out on this side and never
  open one in the Decks view. Its editor is the Draft view's (`openDraftDeck` → the store's
  `draftDeckId` → `DeckEditor host="draft"`, a `Draft & Packs ›` crumb that is the close);
  Discard and the crumb are `returnToDraftPage`; Save toasts, then `openSavedDeck` moves to the
  Decks view's editor on that deck.
- **Deck or sideboard is the page's** (`pick/split.ts`, issue #1471): which picks are on the
  sideboard is held by `instanceId`, kept per device in `localStorage`, and never sent to the
  engine; a pick's list is applied only once the pick is taken. It starts over on every new deal
  and on the hub's Abandon (`resetSideboard`, issue #1588) — a Sealed pool's ids repeat across
  drafts, so never let an empty first pool be the only reset. At Build, the deck's cards are
  filed by `autoCategoryFor` — the add path's own rule, never a second copy of it — and the
  sideboard's go into Pool. `split.ts` makes no IPC call: `test-setup.ts` loads it before any
  suite mocks `@/lib/ipc`.
- **A lobby is a draft's, a game's or a trade's** (`LobbyState.kind`, issue #1419): this page
  draws a `draft` lobby only; a `game` lobby is the Playtesting page's and a `trade` lobby the
  Trade page's (`features/trade/lobby/`), which host and join it with the same hooks
  (`useLobbyState`, `useMayHostPod`, `normalizeCode`). Create a lobby with its kind.
- **Hosting a pod is a supporter's; joining is anybody's.** The page reads the membership the way
  `useMaySendScans` does (`useMayHostPod`); the host refuses a device that is not entitled, and the
  relay mints tokens only for an entitled membership.
- **A drafting pod is a draft in progress** (issue #1468): the hub lists it with **Rejoin**, which
  opens the seat this window kept (`pick/current.ts`) or else the lobby's screen, which takes the
  seat again through `lobby_rejoin`. A guest's draft asks it on every arrival — a guest's view only
  ever arrives pushed. Never route a drafting lobby to a screen that waits without asking.
- **The pool is below the pack unless the reader moves it** (`pick/trayLayout.ts`, issue #1474): the
  curve (`PoolColumns`) is the default, the side tray (`PoolTray`) the other of MTG Arena's two
  views, switched by the pack heading's Pool toggle and kept per device in `localStorage` —
  never `app_meta`. Either is the pick's drop target. A Winston table and the Build step always
  draw the curve. Under the pack, Deck and Sideboard sit **side by side** on one panel, the
  sideboard in four columns of the deck's width (issue #1499); every pool column is headed in
  symbols (`ColumnSymbols`), and a tray row leads with the card's cost (`DraftCard.manaCost`,
  issue #1498). The trays' panel is their one scroller — never a scroll per tray.
- **The deck's stats count the deck, never the sideboard** (`pick/PickStats.tsx`, over
  `pickStatsCounts.ts` and the deck editor's own stats pieces). They are drawn on a page at least
  `STATS_MIN_WIDTH` wide, measured with `useElementWidth` — never a container query, which would
  hold this screen's `fixed` previews — and hidden by the toggle beside the Pool switch, kept per
  device like the layout. Record: [draft-and-packs.md](../../../../docs/reference/draft-and-packs.md).
- **The app holds one draft, and the page never puts one away unasked** (`table.ts`, issue #1586).
  A solo Start asks before it replaces the saved draft (`SetupScreen`'s question, read at the
  press), and Start and the hub's Resume are refused while a pod this app hosts is drafting
  (`hostsDraftingPod`) — the host refuses them too (`draft::POD_AT_TABLE`). The hub's Abandon
  ends this window's own solo draft by its name, or else drops the saved copy with
  `draft_discard`; never `draft_resume` a draft only to have a name to end.
- **Every pushed view is filtered** (`pick/pool.ts`' `acceptsView`): a `draft:view` for another seat
  or an older step is dropped. A guest's sent pick or Winston decision is held beside the view
  (`DraftSession`'s `sentOn`) until any view of its seat is pushed — never written into the view as
  `waiting`, which would outscore the host's re-send of the seat and strand the guest (issue #1585).
