# Draft & Packs — design (2026-10-29)

A new desktop page, **Draft & Packs**, with a rail row of its own. Two halves:

- **Draft** — draft a pool from boosters (or a cube list) against phase.rs's draft bots, or with
  other people in a **pod** reached by a **lobby code**, then build a deck from the pool in the
  app's own deck editor, and save it or export it.
- **Packs** — open a booster of any set and any product (play, draft, set, collector, …) or a
  sealed product that holds boosters (a box, a case, a bundle), and compare what was opened with
  what that product is worth on average.

The owner's request (2026-10-29): the page and its rail row are named "Draft & Packs"; drafting
uses phase.rs's draft module; a drafted pool is built into a deck in the deck editor **without the
collection and without the global search**, and nothing is added to the collection; the deck is
then saved or exported; drafting is against the AI or against other players through lobby codes;
**creating a lobby is a supporter's**; pack opening is botbox.dev's idea: open, then compare
against the average.

**Desktop only**, like Playtesting: phase.rs's crates are linked by the desktop alone
(`crates/grimoire-play/CLAUDE.md`), and the light app draws no such page.

## 1. Where each part lives

| Part | Where | Why there |
| --- | --- | --- |
| Booster data: MTGJSON's set file, parsed to sheets and products, joined to the corpus | `crates/grimoire-core/src/boosters.rs` (parse + resolve, over `&Connection`) | Data plumbing, no window. Pure: takes the JSON text, answers a DTO. |
| Fetching and caching MTGJSON's set file | `apps/desktop/src-tauri/src/packs/` | The host is what reaches a network for this feature; files under the data dir. |
| Opening a booster, expected value, variance, simulation, percentile | `packages/ui/features/draft/booster/` (TypeScript) | Rust supplies facts (the sheets, the weights, the prices), TypeScript draws conclusions. One generator serves both Packs and Draft, so a drafted booster is collated exactly as an opened one. |
| The draft itself (passing, picks, bots, sealed pools) | `crates/grimoire-play/src/draft/` over phase.rs's `draft-core` | The owner asked for phase.rs's draft module. Desktop-only crate. |
| One draft at a time, its persistence, the lobby socket | `apps/desktop/src-tauri/src/draft/` | Host state, network, Tauri events. |
| The lobby rendezvous | `infrastructure/relay/src/lobby.ts`, a Durable Object `Lobby` | The relay is already the hosted service a desktop reaches, and it already mints the supporter's token. |
| The draft deck (pool into a virtual Limited deck; unsaved marker; basics) | `crates/grimoire-core/src/draft_deck.rs` | Deck writes are the core's; the marker is one `app_meta` row (never synced). |
| Page, flows, deck editor's draft mode | `packages/ui/features/draft/`, `features/decks/` | UI. |

## 2. Booster data (MTGJSON)

**Source**: `https://mtgjson.com/api/v5/{CODE}.json.gz` (MTGJSON v5 per-set file; `CODE` is the
set code upper-cased). Measured 2026-10-29: `HOB.json.gz` is 646 KB (2.7 MB of JSON). It carries
`booster` (one entry per product: `play`, `draft`, `set`, `collector`, `jumpstart`, `box-topper`,
`prerelease`, … each `{ name, boosters: [{ contents: {sheet: count}, weight }], boostersTotalWeight,
sheets: { name: { cards: {uuid: weight}, totalWeight, foil, fixed?, allowDuplicates?,
balanceColors? } }, sourceSetCodes }`) and `sealedProduct` (boxes, cases, bundles: `{ uuid, name,
category, subtype, contents: { pack?: [{code, set}], sealed?: [{uuid, set, count, name}], card?:
[{uuid, set, foil?}], deck?, other?, variable? } }`). A sheet names cards by MTGJSON `uuid`; the
set's own `cards[]` (and `tokens[]`) map `uuid → identifiers.scryfallId`. A sheet may name cards of
another set (`sourceSetCodes`, e.g. HOB's box topper is HOC's) — those set files are fetched too.

**Optional by construction**: nothing is asked until a reader picks a set on the Packs page or a
set for a draft pack. A failure is one sentence on that page. Cached under the data dir in
`boosters/{CODE}.json.gz`, re-asked when older than 7 days or on Refresh. The host sends the app's
`User-Agent`.

### Wire (`crates/grimoire-core/src/boosters.rs`, mirrored in `packages/ui/lib/ipc/packs.ts`)

All `#[derive(Debug, Clone, Serialize)]` + `#[serde(rename_all = "camelCase")]`.

```rust
pub struct BoosterSet {
    pub code: String,               // lower-case, as the corpus spells it
    pub name: String,
    pub release_date: Option<String>,
    pub products: Vec<BoosterProduct>,
    pub sealed: Vec<SealedProduct>,
    pub cards: Vec<BoosterCard>,    // every card any sheet or sealed product names, once
    pub fetched_at: i64,            // ms; when the file was fetched
}
pub struct BoosterProduct {
    pub key: String,                // MTGJSON's key: "play", "collector", …
    pub name: String,               // "The Hobbit Play Booster"
    pub total_weight: u64,
    pub variants: Vec<BoosterVariant>,
    pub sheets: Vec<BoosterSheet>,
}
pub struct BoosterVariant { pub weight: u64, pub slots: Vec<BoosterSlot> }
pub struct BoosterSlot { pub sheet: String, pub count: u32 }
pub struct BoosterSheet {
    pub name: String,
    pub foil: bool,
    pub fixed: bool,
    pub allow_duplicates: bool,
    pub balance_colors: bool,
    pub total_weight: u64,
    pub cards: Vec<SheetCard>,
}
pub struct SheetCard { pub card_id: String, pub weight: u64 } // card_id: Scryfall id
pub struct SealedProduct {
    pub uuid: String,
    pub name: String,
    pub category: Option<String>,   // "booster_box", "booster_pack", "bundle", …
    pub subtype: Option<String>,
    pub packs: Vec<SealedPack>,     // boosters it holds directly
    pub sealed: Vec<SealedInner>,   // other sealed products it holds
    pub cards: Vec<SealedCard>,     // fixed cards it holds (a bundle's promo)
}
pub struct SealedPack { pub set: String, pub product: String, pub count: u32 }
pub struct SealedInner { pub uuid: String, pub set: String, pub count: u32 }
pub struct SealedCard { pub card_id: String, pub foil: bool }
pub struct BoosterCard {
    pub card_id: String,
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub rarity: Option<String>,
    pub type_line: Option<String>,
    pub mana_cost: Option<String>,
    pub cmc: Option<f64>,
    pub colors: Option<String>,     // letters, "WU", as the corpus stores them
    pub in_corpus: bool,            // false: facts from MTGJSON alone; no image, no price
}
```

A sheet card whose `uuid` maps to no Scryfall id is dropped and its weight leaves the sheet's
`total_weight` (the total is recomputed from what is kept). A product whose sheets come out empty
is dropped. A sealed product that holds no booster, directly or through what it holds (a deck, a
kit of tokens), is dropped. `variable` contents are not read (the product is kept only if it holds
boosters otherwise).

Prices are **not** in the wire: the page asks `printing_prices(cardIds, marketplace)` — the one
place a printing's per-finish price is read, at the reader's marketplace. A card opened from a
`foil` sheet is priced at its foil price, else nonfoil, else etched; an unpriced card counts 0 and
is drawn with an em dash.

## 3. Opening a booster (TypeScript, `packages/ui/features/draft/booster/`)

`open.ts` — `openBooster(product, rng)`: one variant by weight; for each slot, `count` cards from
its sheet by weight; without replacement unless `allowDuplicates`; a `fixed` sheet gives each of its
cards `weight` times; `balanceColors` (MTGJSON's flag for commons) is met by drawing at least one
card of each of W, U, B, R, G first when the slot holds five or more and the sheet has them, the
rest by weight. Each opened card is `{ cardId, foil, sheet }`. `openSealed(set, uuid, rng)` expands
a sealed product recursively into boosters (and fixed cards), opening each.

`value.ts` — expected value (per sheet the weighted mean price, × count, summed per variant,
weighted by variant), variance (per variant `Σ count·Var(sheet)`, plus the variance of the variant
means; with replacement — an approximation the simulation corrects), `simulate(product, prices, n,
rng)` (n = 10 000 opened packs' values, sorted), percentile of a value among them, median, a
histogram. A sealed product's figures are the sum of its boosters'. `rng` is a seeded PRNG
(`mulberry32`) so tests are exact.

## 4. The draft (`crates/grimoire-play/src/draft/`)

Over phase.rs's `draft-core` (same repository and `rev` as `phase-engine`/`phase-ai`; the three move
together). **The page makes the boosters** (§3) and hands them to Rust as printing ids; a
`PackSource` of our own hands draft-core exactly those packs. A card instance's id is
`"{cardId}#{seat}.{round}.{index}"`, so any app — a guest's too — finds the printing in its own
corpus. Bots pick with the same heuristics phase.rs's own draft bots use (`draft-wasm/src/bot_ai.rs`
is a `cdylib` and cannot be linked, so its pick-and-pass half is ported, over
`phase_ai::draft_eval` with a `CardDatabase` of the draft's own cards built as `cards.rs` builds a
deck's).

Modes → draft-core kinds: **quick** (you + 7 bots, boosters from sets) and **cube** (you + 7 bots,
boosters dealt from a cube list) → `DraftKind::Quick`; **sealed** (six boosters straight into your
pool) → `DraftKind::Sealed`; **pod** (people from a lobby, bots filling the empty seats) →
`DraftKind::Premier` with bot seats. Commander and Winston drafts: §4a.

### Wire (`crates/grimoire-play/src/draft/view.rs`, mirrored in `packages/ui/lib/ipc/draft.ts`)

```rust
#[serde(rename_all = "camelCase")] pub enum DraftMode { Quick, Sealed, Cube, Pod }
#[serde(rename_all = "camelCase")] pub enum DraftStatus { Drafting, Deckbuilding }

#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct DraftSetup {
    pub mode: DraftMode,
    pub difficulty: Difficulty,             // grimoire_play::Difficulty
    pub seed: u32,
    pub label: String,                      // "Reality Fracture · Lorwyn Eclipsed · The Hobbit"
    pub seats: Vec<DraftSeatSetup>,         // table order; seat 0 is this reader
    pub packs: Vec<Vec<Vec<String>>>,       // [seat][round] → printing ids, in the booster's order
    pub pack_sets: Vec<String>,             // per round, the set code to show ("" for a cube)
    pub min_deck_size: u32,                 // 40
}
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct DraftSeatSetup { pub name: String, pub bot: bool, pub peer: Option<String> }

#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct DraftCard {
    pub instance_id: String,
    pub card_id: String,
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub rarity: String,
    pub colors: Vec<String>,
    pub cmc: u8,
    pub type_line: String,
}
#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct DraftSeatView { pub name: String, pub bot: bool, pub connected: bool, pub picked: bool, pub pool_count: u32 }
#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct DraftView {
    pub mode: DraftMode,
    pub status: DraftStatus,
    pub label: String,
    pub seat: u8,
    pub pack_number: u8,          // 0-based round
    pub pack_count: u8,
    pub pick_number: u8,          // 0-based pick within the round
    pub pack_size: u8,            // cards the current round's booster held when opened
    pub pass_left: bool,
    pub pack: Vec<DraftCard>,     // empty while waiting or once the draft is over
    pub waiting: bool,            // picked this step; waiting on the table
    pub pool: Vec<DraftCard>,
    pub seats: Vec<DraftSeatView>,
    pub pack_sets: Vec<String>,
    pub min_deck_size: u32,
}
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct DraftSaved { pub label: String, pub mode: DraftMode, pub status: DraftStatus,
    pub pack_number: u8, pub pack_count: u8, pub pick_number: u8, pub updated_at: i64 }
```

`Draft` (in `draft/mod.rs`): `new(setup, facts: Vec<CardFacts>) -> Result<Draft, String>`,
`view(seat) -> DraftView`, `pick(seat, ids) -> Result<(), String>` (and the bots act until every bot
that holds a pack has picked), `auto_pick(seat)` (the bot's choice for a person), `set_connected`,
`replace_with_bot(seat)`, `pool(seat) -> Vec<String>` (printing ids), `snapshot() -> String` /
`restore(json, facts)`. Every call into it runs on `on_engine_stack` (the bots read
`CardDatabase` faces). A refused pick changes nothing.

### Host commands (`apps/desktop/src-tauri/src/draft/`, all on `DESKTOP_ONLY`)

| Command | Args | Answers |
| --- | --- | --- |
| `draft_start` | `setup: DraftSetup, draft: u64` | `DraftView` (seat 0) |
| `draft_view` | `draft: u64` | `Option<DraftView>` |
| `draft_pick` | `draft: u64, cardInstanceIds: Vec<String>` | `DraftView` |
| `draft_auto_pick` | `draft: u64` | `DraftView` |
| `draft_end` | `draft: u64` | `()` — drops the draft and its saved copy |
| `draft_saved` | — | `Option<DraftSaved>` — the draft left off (a solo draft is kept in `app_meta` `draft_session`; a pod is not resumable) |
| `draft_resume` | `draft: u64` | `DraftView` — restores the saved draft under that name |

`draft` is the page's name for a draft, as `playtest`'s `game` is: a call naming a replaced draft is
refused.

## 4a. Commander and Winston drafts (the owner's follow-up, 2026-10-29)

Every draft type phase.rs's page offers is offered here: Quick, Sealed, Cube, Pod, **Commander** and
**Winston**.

- **Commander** → `DraftKind::CommanderDraft`: you + 3 bots (draft-core allows 3–8 seats), three
  boosters each, **two cards a pick** (`picks_per_step: 2`), a 60-card deck that designates one
  commander (`commanders: 1`). Commander Legends' sets (CMR, CLB) are what the format is built for
  and are offered first; any set's draft booster is allowed.
- **Winston** → `DraftKind::Winston` (`PackDistribution::SharedStackPiles { pile_count: 3 }`): you +
  1 bot (2–4 seats), three boosters each shuffled into one face-down stack. On your turn you look at
  pile 1: take it (and it is refilled from the stack) or decline it (one card from the stack is
  added to it) and look at the next; declining the last pile takes the stack's top card. The view's
  `stack` (`WinstonView`) tells the deciding seat the active pile's cards and everyone else counts.
  The bot's turn is phase.rs's `winston_decision` (`draft-wasm/src/bot_ai.rs`, over
  `phase_ai::winston_eval`), ported like the pick-and-pass bot.
- **A pod drafts any of the three** (`DraftSetup::pod_format`: `booster` 2–8 seats, `commander` 3–8,
  `winston` 2–4); empty seats are bots.
- Wire additions: `DraftMode::{Commander, Winston}`, `PodFormat`, `DraftSetup::pod_format`
  (`#[serde(default)]`), `DraftView::{pod_format, picks_per_step, commanders, stack}`, `WinstonView`,
  `WinstonPile`. Commands: `draft_winston(draft, pile, take) -> DraftView`;
  `lobby_winston(pile, take) -> ()` with the guest body `{"v":1,"kind":"winston","pile":n,"take":bool}`.
  A Commander pick is `draft_pick` / `lobby_pick` with two ids.
- A Commander draft's deck: `draft_deck_create(name, cardIds, commander: true)` makes a virtual
  **Casual** deck (no 40-card Limited floor) with a **Commander** pile beside Deck and Pool; the
  draft bar checks 60 cards and one commander itself.

## 5. The deck (`crates/grimoire-core/src/draft_deck.rs`)

A drafted pool becomes a **virtual** deck (`virtual_only = 1`: no cardboard, no allocation, no
collection — the owner's rule), format `limited`, named after the draft, with two categories:
**Deck** (`main`, the default) — empty — and **Pool** (`side`) holding every drafted card. The reader
moves cards from Pool to Deck in the editor. Basic lands are added from a strip of five (W U B R G)
in the editor's draft bar, in a printing of the draft's own sets where the corpus has one.

Until the reader **saves** it the deck is a draft deck: its id is in `app_meta` `draft_decks` (a
JSON array; `app_meta` is never synced). The deck editor, for a deck on that list, draws no card
search dock (neither the corpus search nor the collection tab), no Quick Add, no pull-from- or
add-to-collection, and draws the draft bar: Basics, **Save deck** (takes it off the list — it is a
deck like any other from then on), **Export** (the editor's own export dialog), **Discard** (deletes
it). The Draft page lists unsaved draft decks under *Draft in progress*.

| Command | Args | Answers |
| --- | --- | --- |
| `draft_deck_create` | `name: String, cardIds: Vec<String>` | `DeckRow` |
| `draft_deck_ids` | — | `Vec<i64>` (decks that still exist) |
| `draft_deck_keep` | `deckId: i64` | `()` |
| `draft_deck_discard` | `deckId: i64` | `()` |
| `draft_basic_lands` | `setCodes: Vec<String>` | `Vec<BasicLand>` |

```rust
#[serde(rename_all = "camelCase")]
pub struct BasicLand { pub color: String, pub name: String, pub card_id: String }
```

## 6. Pods and lobby codes

A **pod** is a draft whose seats are people in a lobby, with bots in the empty seats. **The host's
app runs the draft** (draft-core is the authority, on the host); every other seat is a guest app
that receives its own seat's view and sends its picks. The relay carries the frames and knows
nothing of a draft.

**Creating a lobby is a supporter's** (the owner's rule): the host's app sends the relay's access
token (`entitlement::access_token`, as `scanner_submit` does), which the relay mints only for an
entitled membership; the page draws *Create lobby* only where `sync_supporter_status` reads active
or grace. **Joining needs no membership**: a code is the whole of the capability.

### Relay (`infrastructure/relay/src/lobby.ts`)

- `POST /lobby` — bearer verified as the `/g/…` gate verifies one (signature and expiry; no group
  route). Rate-limited. Answers `201 {"code": "K7QX2M", "hostKey": "<32 hex>", "expiresAt": ms}`.
  A code is 6 characters of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; the object is `idFromName(code)`;
  a code already live is drawn again. A lobby lives 6 hours from creation.
- `GET /lobby/{code}/ws` — a WebSocket upgrade, no bearer. `?role=host&key=…` or
  `?role=guest&name=…[&rejoin=<peer>.<secret>]`. 404 for a code that is not live. Hibernatable
  sockets (`state.acceptWebSocket`).
- Frames (JSON text, ≤ 64 KiB each):
  - to the host: `{"t":"peers","peers":[{"peer":"p1","name":"Ada","online":true}]}` on every change;
    `{"t":"msg","from":"p1","body":{…}}`.
  - from the host: `{"t":"send","to":"p1"|"*","body":{…}}`, `{"t":"lock"}` (no new guests; a rejoin
    still works), `{"t":"kick","peer":"p1"}`, `{"t":"close"}` (ends the lobby: every guest closed
    with 4000).
  - to a guest: `{"t":"welcome","peer":"p1","secret":"…","hostOnline":true}`,
    `{"t":"host","online":bool}`, `{"t":"msg","body":{…}}`.
  - from a guest: `{"t":"msg","body":{…}}` (forwarded to the host as `msg` with `from`).
  - close codes: 4000 lobby closed, 4001 kicked, 4003 started (locked, not a rejoin), 4004 full
    (7 guests), 4005 replaced (the same peer or the host connected again).

### The app's body (`v: 1`)

host → guest: `{"v":1,"kind":"room","room":LobbyRoom}`, `{"v":1,"kind":"view","view":DraftView}`,
`{"v":1,"kind":"end","reason":"…"}`. guest → host: `{"v":1,"kind":"pick","ids":[…]}`,
`{"v":1,"kind":"sync"}` (send me my view again).

### Host commands and events (`apps/desktop/src-tauri/src/draft/lobby.rs`)

| Command | Args | Answers |
| --- | --- | --- |
| `lobby_create` | `name: String` | `LobbyState` (supporter only) |
| `lobby_join` | `code: String, name: String` | `LobbyState` |
| `lobby_state` | — | `Option<LobbyState>` |
| `lobby_leave` | — | `()` (a host closes the lobby; ends a pod draft) |
| `lobby_start` | `setup: DraftSetup, draft: u64` | `DraftView` (host; `setup.seats[*].peer` names each guest's seat) |
| `lobby_pick` | `cardInstanceIds: Vec<String>` | `()` (guest; the view arrives as `draft:view`) |
| `lobby_kick` | `peer: String` | `()` (host, before the start) |

Events: `lobby:state` (`LobbyState`), `draft:view` (`DraftView` — for the host when a guest's pick
moved its seat on, and for a guest whenever the host sends one).

```rust
#[serde(rename_all = "camelCase")] pub enum LobbyRole { Host, Guest }
#[serde(rename_all = "camelCase")] pub enum LobbyPhase { Connecting, Open, Drafting, Closed }
#[serde(rename_all = "camelCase")]
pub struct LobbyPeer { pub peer: String, pub name: String, pub online: bool }
#[serde(rename_all = "camelCase")]
pub struct LobbyState {
    pub role: LobbyRole, pub code: String, pub phase: LobbyPhase, pub name: String,
    pub host_name: String, pub host_online: bool, pub peers: Vec<LobbyPeer>,
    pub label: String,                 // the host's draft, as the room describes it
    pub closed_reason: Option<String>,
}
#[serde(rename_all = "camelCase")]
pub struct LobbyRoom { pub host_name: String, pub label: String, pub peers: Vec<LobbyPeer>, pub started: bool }
```

## 7. The page

`features/draft/DraftPage.tsx`: header **Draft & Packs**; *Draft in progress* (a saved solo draft →
Resume; each unsaved draft deck → Continue building; a live lobby → Return); *Start new*: Quick
Draft, Sealed, Cube Draft, Pod Draft, Open Packs. A flow has a stepper: Choose → Draft → Build.

- **Choose**: bot difficulty; pack order (a set per booster; three for a draft, six for sealed) from
  a grid of set tiles (keyrune icon and name, newest first, filterable); for a cube, a pasted list
  (`1 Lightning Bolt` per line), seats, packs, pack size.
- **Draft**: the pack (card images, click to choose; drag onto the pool, the Pick button or Enter to pick — issue #1434 replaced the double-click), the
  round strip (P1 FRA · P2 HOB · P3 HOB, pick n / size), the pool below by mana value, Pick for me.
- **Build**: `draft_deck_create` → the deck editor in draft mode (§5).
- **Pod**: Create lobby (supporters) shows the code to share and the people who joined; Join lobby
  takes a code and a name. The host picks the packs and starts; empty seats are bots.
- **Open Packs**: a set, a product (boosters first, then sealed products that hold boosters),
  Open; the cards by price with the total, and beside them the product's figures — expected
  value (theoretical and simulated), standard deviation, the chance to beat a price the reader
  types ("What you paid"), the pack's percentile, and the simulated distribution.
