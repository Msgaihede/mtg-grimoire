# Draft & Packs

A desktop page with a rail row of its own (no chord — `keyboard-shortcuts.md` says why), built
2026-10-29 at the owner's request: draft a pool from boosters or a cube list against phase.rs's
draft bots or with people in a pod, build it into a deck in the deck editor without the collection
or the card search, save or export the deck; and open a booster or a box of any set and product,
and compare it with what that product is worth on average (botbox.dev's idea). The binding rules
are in [`packages/ui/features/draft/CLAUDE.md`](../../packages/ui/features/draft/CLAUDE.md) and
[`crates/grimoire-play/CLAUDE.md`](../../crates/grimoire-play/CLAUDE.md); the design is
[the spec](../superpowers/specs/2026-10-29-draft-and-packs-design.md). This page holds the reasons
and the figures.

## Contents

- [Booster data: MTGJSON](#booster-data-mtgjson)
- [One collation, and the math in TypeScript](#one-collation-and-the-math-in-typescript)
- [The draft: phase.rs's draft-core](#the-draft-phasers-draft-core)
- [The draft deck](#the-draft-deck)
- [Pods and lobby codes](#pods-and-lobby-codes)
- [What is not there yet](#what-is-not-there-yet)

## Booster data: MTGJSON

**MTGJSON's per-set file is the only public source that describes boosters as print sheets and
weights**, every product of a set (play, draft, set, collector, jumpstart, box topper, prerelease…)
and the sealed products that hold them (boxes, cases, bundles). Scryfall describes printings, not
products. phase.rs reads the same files for its own draft pools (`draft-core`'s `extraction.rs`,
which keeps the draftable product alone); this app keeps every product, because the Packs page
opens any of them.

- `https://mtgjson.com/api/v5/{CODE}.json.gz`, measured 2026-10-29: `HOB.json.gz` is 646 KB, 2.7 MB
  of JSON. A sheet names cards by MTGJSON `uuid`; the set's `cards[]` and `tokens[]` map each to a
  Scryfall id. A sheet may name another set's cards (`sourceSetCodes` — HOB's box topper is HOC's),
  so those files are fetched too.
- Parsed and joined to the corpus in `crates/grimoire-core/src/boosters.rs`; fetched and cached by
  the desktop host (`packs/`) under the data dir, `boosters/{CODE}.json.gz`, for 7 days.
- **The set walls are MTGJSON's too, never the corpus's** (Open Packs and a draft's pack order,
  `useBoosterSets`). Scryfall splits a release into sets no booster is sold of (a bonus sheet like
  `big`, the List, `tsb`, a commander's promos), so a wall built from `list_sets` and a list of set
  types offered tiles MTGJSON had no booster for. The wall is `SetList.json.gz` (2.5 MB, cached as
  `boosters/SetList.json.gz` on the same 7 days), kept to the sets a sealed product of category
  `booster_pack` opens a booster of (`booster_set_list`), then to those out now or within a week.
  Measured 2026-10-30: 190 sets; against 17 sampled per-set files the rule matched the `booster`
  block every time, and the one set it leaves out that has pack references at all is `sld` (Secret
  Lair's bonus sheets, sold in a box).
- **The wall is divided by release year** (`SetGrid`'s `byYear`, issue #1456): newest first, each
  year a list of its own under a divider (the year between two rules), on Open Packs and in a
  draft's pack order alike. `byYear` only cuts the order it is given into runs of one year, never
  re-sorts it, and the filter drops a year whose sets it hides. The year left the tiles' code line
  with it — the divider says it once.
- **Fetched again with the card data** (`packs::spawn_refresh`): a card sync that brought a new
  bulk file (the launch's or Settings') or was forced also fetches the set list and every set file
  already cached, in the background, then emits `packs:refreshed`; the walls (`usePacksRefreshed`)
  ask every `["packs", …]` answer again. So MTGJSON's sheets follow Scryfall's printings instead of
  trailing them by up to the 7 days; a file that cannot be fetched keeps its copy.
- **Optional by construction**: nothing is asked until a reader opens the Packs page or a draft's
  setup (the set list), or picks a set (its file). A failure is a sentence on that page and a Retry.
- Checked against the real HOB + HOC files: 4 products (box topper, collector, play, prerelease),
  21 sealed products kept (kits and welcome decks with no booster dropped), 423 distinct cards.

What the parse drops, and why: a sheet card whose `uuid` maps to no Scryfall id (its weight leaves
the sheet), a product left with no sheet, a variant naming a dropped sheet, a sealed product that
holds no booster directly or through what it holds (worked out to a fixed point, so master case →
case → box → pack holds whatever order the file lists them in), and `variable` contents.

## One collation, and the math in TypeScript

`features/draft/booster/open.ts` opens a booster for both halves of the page: a variant by weight;
each slot draws `count` cards from its sheet by weight, without replacement unless the sheet allows
duplicates; a `fixed` sheet gives every card `weight` times; `balanceColors` draws one card of each
colour first when the slot holds five or more. A drafted booster is therefore collated exactly as an
opened one.

The figures (`value.ts`) are conclusions, so they are TypeScript's: Rust answers the sheets and the
weights, `printing_prices` answers the prices at the marketplaces the page prices at (below), and
the page computes

- **expected value** — per sheet the weighted mean price, × the slot's count, summed per variant and
  weighted by the variant; a colour-balanced slot counts its one card of each colour from that
  colour's cards, as it is opened. Found on the story's own figures (2026-10-29): without it the
  theory read $676 against a simulated $1,076 on the fake corpus, whose red commons include a $620 Lightning
  Bolt;
- **standard deviation** — per variant `Σ count · Var(sheet)` plus the variance of the variant means
  (draws with replacement: an approximation the simulation corrects);
- **the simulation** — 10 000 boosters opened with a fixed seed (the figures do not move between
  presses), sorted; the median, the opened pack's percentile (mid-rank), the chance to beat a price
  the reader types, and a histogram (equal bins to the 99th percentile, the tail folded into the
  last), each bar told as its share of the simulation — the chance a pack lands in it — never a
  raw count (issue #1451);
- a sealed product's figures as the sum of its boosters'.

A card opened from a foil sheet is priced foil, else nonfoil, else etched; an unpriced card counts 0
and is drawn with an em dash. A card MTGJSON knows and this corpus does not (`inCorpus: false`) has
no image and no price, and is never dealt into a draft.

**The product picker is a combobox** (issue #1464, `packs/products.ts`' `openableMatches`): a set
can sell a dozen boosters and sealed products, so the _Product_ dropdown is `searchable`. Typing
keeps the products holding every word typed, in any order, case-insensitively, against the name,
the kind (`booster` or `sealed`) and a sealed product's MTGJSON category in words (`booster box`,
`bundle`) — "collector box" finds the collector booster box. The shell owns the query (the
`Dropdown`'s `matches` prop), so the trigger keeps naming the picked product while a search hides it.

**The marketplaces are the page's own** (issue #1446, `packs/marketplaces.ts`): a combobox at the
head of the right-hand column, _Prices from_ (`packs/MarketplaceCombobox.tsx`, issue #1463) — the
picked marketplaces as chips, a search typed beside them, and under it the marketplaces it matches
by name or currency, each pressed to add or put down — that starts at the app's marketplace
(Settings) and is the reader's pick after that — kept per device in `localStorage`
(`grimoire.packs.marketplaces`), never in `app_meta`, and never written back to the app's setting.
`useBoosterPrices` reads
`printing_prices` once per picked marketplace (each its own cache entry) and takes each finish's
lowest quote (`lowestPrices`) before the foil-else-nonfoil fallback, so one marketplace's non-foil
never stands in for another's foil. **Dollars and euros together** (issue #1463, `packs/currency.ts`):
a pick of one currency is priced in it, untouched; a pick of both — TCGplayer with Cardmarket — is
priced in the app's currency (the owner's decision, 2026-11-02), the other currency's answers
multiplied by the European Central Bank's daily rate (`packs_exchange_rate`, the desktop's
`packs/fx.rs`) before the lowest is taken. The rate is asked only for such a pick; until it answers
no figure is drawn, and with none at all (the ECB unreachable and nothing cached) the other
currency's marketplaces are left out and the line under the picker says so — a euro is never
compared with a dollar unconverted. The line also names the rate and its day when one was used.
The last picked marketplace cannot be put down; Card trader (unpriced) and a feed the host cannot reach are greyed. Picking a
feed that has never landed a row fetches it, as Settings does.

**The reduced price is the page's own too** (`packs/reducedPick.ts`, `packs/ReducedInputs.tsx`): a
_Sell at_ percentage and a _Minimum_ card value under _Prices from_, apart from Settings ›
Collection value — neither read from it nor written to it — and kept per device in `localStorage`
(`grimoire.packs.reduced`). Set, the reduced price is drawn in brackets beside the opening's _Total
value_ and the session's, by the collection's sum ([collection-value.md](collection-value.md)):
each priced card strictly under the minimum is taken out, then the percentage of what is left. The
session's tally keeps every priced card's price, not a reduced sum, so changing a figure mid-session
reprices the whole session. The minimum is in whatever currency the page prices in, and nothing
converts it. The expected value, the simulation and the histogram stay at full value.

**Every price control is in the right-hand column** (issue #1465): _Prices from_, _Sell at_ and
_Minimum_ sit above the expected value and the figures, so the product row (product, _Open_,
_Back_) is the only band at the top and the column starts level with it. On a narrow page the
column folds under the wall, controls first.

## The draft: phase.rs's draft-core

`crates/grimoire-play/src/draft/` runs one draft over `draft-core`, from phase.rs's repository at
the same `rev` as the engine and the AI (the three move together). **The page deals the boosters**
and hands them over as printing ids; a `PackSource` of this crate's hands draft-core exactly those.
A card's instance id is `"{cardId}#{seat}.{round}.{index}"`, so a guest's app finds the printing in
its own corpus.

**The bots are phase.rs's, ported.** Its pick-and-pass bot lives in `draft-wasm`, a `cdylib` that
cannot be linked, so `bots.rs` carries the same strategies — Very Easy random, Easy by rarity,
Medium and Hard `phase_ai::draft_eval` quality plus colour and curve, Very Hard stricter on colour —
over a `CardDatabase` of the draft's own cards. Their dice are seeded from the setup's seed, the
cards picked so far and the seat, with nothing stored, so a restored draft picks exactly as the
original would have.

| Mode                                                                              | draft-core                                                                                | Seats it allows                                                                       |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Quick (sets, you + 7 bots)                                                        | `Quick`, set source                                                                       | 2–8                                                                                   |
| Cube (a pasted list, you + bots)                                                  | `Quick`, cube source                                                                      | 1–255                                                                                 |
| Sealed (six boosters into your pool)                                              | `Sealed`                                                                                  | exactly 6 boosters; a lone seat is padded with a hidden bot that opens six empty ones |
| Pod (people from a lobby, bots in the empty seats)                                | `Premier` with bot seats; a pod drafts any of booster, Commander or Winston (`podFormat`) | 2–8 booster, 3–8 Commander, 2–4 Winston                                               |
| Commander (sets, you + 3 bots, two cards a pick, a 60-card deck with a commander) | `CommanderDraft`                                                                          | 3–8 (the setup offers 3–8, default 4)                                                 |
| Winston (sets, you + 1 bot, one shared stack in three piles)                      | `Winston`, `SharedStackPiles { pile_count: 3 }`                                           | 2–4 (solo is 2)                                                                       |

A Commander draft's set wall puts Commander Legends (`cmr`) and Battle for Baldur's Gate (`clb`)
first, marked _Suggested_, where the corpus has them; any set's booster is allowed. Its pick
screen chooses two cards and picks them together (`draft_pick` with two ids), and its deck is a
virtual Casual deck with a Commander pile (`draft_deck_create(…, commander: true)`); the draft bar
checks 60 cards and a commander itself. A Winston draft deals its boosters `[seat][round]` like
every other mode — the host shuffles them into the stack — and draws a table in the pack's place:
the stack and the piles face down with their counts, the active pile face up on your turn with
**Take pile** and **Decline** (`draft_winston`, or a guest's `lobby_winston`).

**The cards zoom like every other wall** (issue #1433): ctrl+wheel over a draft steps
`cardZoom.draft`, one section for the pack, a face-up Winston pile and the pool, because they are
one table a card is dragged across, and it is remembered with the other walls'. The gesture is
the only control: the pick screen's **Card size** slider, which walked the same ladder, was removed
as redundant (issue #1470).
The pool's eight columns take the zoom as a ceiling (`minmax(0, 190px × zoom)`) so the pool still
fits without a scroll. Open Packs' opened wall is a section of its own, `packs`.

**An opened card is the app's own tile** (issue #1462): `OpenedWall` draws each card with
`components/CardTile` — the art, and under it the `CardChin` every other wall draws, with the
rarity, `SET · number`, the finish and the price at the page's marketplaces. A card MTGJSON knows
and the corpus does not is the same tile with no picture and no press, its chin still naming the
printing. It had drawn its own art-and-caption row (a rarity label and a price, no set or number)
until a reader asked why its cards looked unlike every other wall's.

A refused pick changes nothing (the session is cloned and put back on any error). A solo draft is
saved after each change (`app_meta` `draft_session`) and can be resumed; a pod cannot.

## The draft deck

A finished pool becomes a **virtual** Limited deck (`draft_deck::create`): nothing is allocated and
nothing reaches the collection, which is the owner's rule. It has a **Deck** pile (main, the
default, drawn while empty) and the deck's own Sideboard renamed **Pool** (one `side` pile per list
is all `idx_deck_categories_kind` allows), holding the whole pool.

Until the reader saves it, it is on `app_meta` `draft_decks` (never synced), and the editor is in
**draft mode**: no card search dock (neither the corpus search nor the Collection tab), no Quick Add,
no import, no `Add to ▸ Collection/Wishlist`, and `DraftDeckBar` in their place — basics from a
printing of the draft's sets, **Save deck** (off the list: a deck like any other), **Export** (the
editor's own dialog) and **Discard** (deleted; refused for a deck not on the list, so a stale page
cannot delete a saved one).

**An entry is the deck's id and its `sync_uid` (`DraftDeckRef`), and a deck is a draft deck only
while both match** (issue #1467). `decks.id` has no `AUTOINCREMENT`, so SQLite gives a deleted
highest id to the next deck: a draft deck deleted from the gallery used to leave its bare id on the
list, and the next deck the reader made opened in draft mode — with a **Discard** that deleted it.
The uid is never reused, so `draft_deck::ids`, `discard` and the editor's `useIsDraftDeck` (once
`deck_get` answers) all hold a deck to both. A legacy entry (a bare id) is dropped, the safe
direction. The list's query key is under the decks root (`["decks", "draftDecks"]`), so every deck
write's invalidation asks it again.

## Pods and lobby codes

The host's app runs the draft; each guest's app receives its own seat's view and sends its picks.
The relay's `Lobby` Durable Object (`infrastructure/relay/src/lobby.ts`) routes frames between one
host and up to seven guests and knows nothing of a draft. **Creating a lobby is a supporter's**: the
host sends the relay's access token, which the relay mints only for an active or grace membership.
**Joining needs only the code** (six characters of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`). A lobby lives
six hours. The frames and close codes are the spec's §6; the relay's README has the routes and what
is stored (the roster, for the lobby's life).

The webview reaches no host but its own (the desktop CSP), so the socket is the host's: a task per
lobby in `apps/desktop/src-tauri/src/draft/lobby.rs` that applies a guest's pick to the draft and
sends every seat its view, and tells the page through `lobby:state` and `draft:view`.

**A seat left mid-draft is taken again** (issue #1468). The lobby and the host's draft live in the
host process, so leaving the page — another view, or a reload of the window — leaves the pod
drafting on. The hub lists a drafting lobby under _Draft in progress_ like any other draft (where
this seat was, when the window kept it) with **Rejoin**. The window's kept seat (`pick/current.ts`)
opens directly; otherwise the lobby's screen calls `lobby_rejoin`: a host is answered its draft's
name and reads its view with `draft_view`, and a guest sends the guest body `sync`, which the host
answers by pushing the room and that seat's view (`draft:view`). A guest's draft asks the same on
every arrival, since its view only ever arrives pushed, so a view kept from before (a pick behind,
or still waiting on a pack that has since come) is brought up to date. Creating, joining or leaving
a lobby forgets a pod seat kept from an earlier one.

**A lobby seats a draft or a game** (`LobbyKind`, issue #1419): the Playtesting page opens the same
lobby for a game, and the host's room tells its guests which (`LobbyRoom.kind`; a guest's
`LobbyState.kind` is `null` until it does). A game's lobby carries each guest's deck name beside
its seat (`LobbyPeer.deck`) and is `playing` once started where a draft's is `drafting`. Each page
draws only its own kind; [playtest.md](playtest.md#lobbies-playing-with-people-issue-1419) has the
game's half.

## What is not there yet

- Playing the drafted deck against the bots' decks; the deck can be goldfished or playtested
  against a deck of the reader's from the editor as any deck can.
- A sealed product's own price: the Packs page asks the reader what they paid.
- A pod's draft is not resumable after the host's app closes.
- The relay's refusal of a guest with 4003/4004 (accept, then close) has run under the test fake and
  not yet under workerd.
