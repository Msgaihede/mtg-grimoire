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

| Folder / file                                | Holds                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `booster/`                                   | Pure booster logic: `open.ts` (collation, `draftProduct`), `value.ts` (expected value, variance, simulation, percentile), `rng.ts` (seeded `mulberry32`), `prices.ts` (`useBoosterPrices`)                               |
| `sets.ts`, `SetGrid.tsx`                     | MTGJSON's booster sets (`useBoosterSets`), one set's `BoosterSet` (`useBoosterSet`), the set wall                                                                                                                        |
| `packs/`                                     | Open Packs: the set page's set picker (`SetSwitcher.tsx`), the product picker, the marketplace pick (`marketplaces.ts`), the reduced price (`reducedPick.ts`), the opened wall, the figures and the histogram            |
| `DraftPage.tsx`                              | The hub (_Draft in progress_, _Start new_) and the page-local state machine                                                                                                                                              |
| `setup/`                                     | Quick, Sealed, Cube, Commander and Winston setup; `deal.ts` deals boosters to seats and holds each table's seat bounds                                                                                                   |
| `pick/`                                      | The pick screen (one or two cards a pick; the pack by rarity or as dealt), the Winston table, the pool as Deck and Sideboard (`PoolZones`, `split.ts`) under the pack or in side trays (`trayLayout.ts`)                 |
| `build/`                                     | The hand-over from a finished draft to a draft deck                                                                                                                                                                      |
| `lobby/`                                     | Pod drafts: create (a supporter's), join by code, the host's room (format and seats) and the guest's                                                                                                                     |
| `deck/`, `useDraftDecks.ts`, `navigation.ts` | The deck editor's draft mode: `DraftDeckBar`, the unsaved list, opening a draft deck                                                                                                                                     |

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
- **Open Packs' reduced price is the page's own** (`packs/reducedPick.ts`): its sell percentage and
  minimum are kept the marketplace pick's way, and never read from or written to Settings'
  collection value. The sum is `lib/collectionValue.ts`' `reducedValue`; never write a second one.
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
  the collection), and while it is on `draft_decks` the editor mounts no card search dock, no Quick
  Add, no import and no `Add to ▸ Collection/Wishlist`. A new way into a deck must be switched off
  for a draft deck too. Call `rememberDraftDeck` (with the created `DeckRow`) before
  `openDraftDeck`, so the editor's first frame is already in draft mode.
- **A draft deck is its id and its `syncUid` together, never the id alone** (issue #1467). Deck ids
  are reused after a delete, so a bare id can name an ordinary deck; the unsaved list stores
  `DraftDeckRef`s and every reader matches both (`isDraftDeckIn`, `useIsDraftDeck(deckId, row)`,
  `draft_deck::ids` / `discard`). Never test membership by id alone, and keep `DRAFT_DECKS_KEY`
  under the `["decks"]` root so a deck's delete refreshes it.
- **Deck or sideboard is the page's** (`pick/split.ts`, issue #1471): which picks are on the
  sideboard is held by `instanceId`, kept per device in `localStorage`, and never sent to the
  engine; a pick's list is applied only once the pick is taken. At Build, the deck's cards are
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
  draw the curve.
- **Every pushed view is filtered** (`pick/pool.ts`' `acceptsView`): a `draft:view` for another seat
  or an older step is dropped.
