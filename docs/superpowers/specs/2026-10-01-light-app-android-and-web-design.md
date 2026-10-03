# The light app: Android and web, on one extracted core

**Design spec, 2026-10-01.** This is the "new lightweight app/web version … written from scratch
later" that [PR #602](https://github.com/Msgaihede/mtg-grimoire/pull/602) promised when it removed
the first web and Android builds on 2026-09-27.

It **replaces the frontend half** of
[the 2026-08-27 cross-platform design](2026-08-27-cross-platform-design.md) and
[the phone-layout options](2026-08-28-mobile-layout-options.md), and **keeps their measurements**:
what a browser and a phone can do has not changed, only how this repository is arranged to ask.
The relay, the pairing protocol and the wire format are untouched.

**This is an umbrella spec over seven phases, and deliberately not one implementation plan.** Each
phase gets its own plan when its turn comes, written against what the phases before it built.
Phase 1 — the skeleton — is specified here in full (§10).

Everything measured for this document was measured on Windows, on 2026-10-01, by reading `main` at
`697d45db` unless a line says otherwise. Figures quoted from the removed builds keep their own
date and come from the tree at `cd54f1a6`, the last one that held them.

---

## 0. The brief, as settled

A second, lighter app for **Android** and for **browsers as an installable PWA**, carrying five of
the desktop's destinations — **card search, decks, collection, wishlist, scanner** — able to pair
with the desktop app or with another light install, and sharing its visual components with the
desktop so a card cannot come to look two ways.

Decisions put to Markus on 2026-10-01 and answered through the option cards:

| Question | Answer |
| --- | --- |
| Where does card data come from? | **The full corpus, built on each device**, exactly as the desktop does. Feature parity in what each feature *does*; only the *selection* of features is lighter |
| How is Android delivered? | **A Tauri shell**, so the phone runs the same Rust the desktop does |
| How much deck editor on a phone? | **Close to the full editor** |
| How does the engine come back? | **Extract a shared core crate first** — over restoring the removed targets inside `src-tauri`, and over a separate TypeScript engine |
| What does the desktop do about the core's command table? | **Keeps its own wrappers for now** |
| Where does the skeleton run first? | **A phone-sized window on Windows, and a plain browser** |
| How is the skeleton's shell designed? | **From the wireframe**; every later page still comes as built options first |
| What does the full-size web version look like? | **The desktop version, with only the light menu** |

### What "light" means, and what it does not

**Light is about the menu and the face. It is not about the data.** A light install holds the same
two databases, runs the same search, stores the same deck rows and merges the same sync ops as the
desktop. What it leaves out is destinations — Home, the Tagger, Trade, Playtesting, shared
binders — and the desktop-only machinery behind them: the plain-text mirror, the portable updater,
more than one window.

**Everything a light install does not show still syncs through it.** Deck notes, to-do lists,
sticky notes and the home layout are rows in tables the core owns; a phone that never draws them
is still a full replica of them.

### Why the first attempt was removed

Markus, in the removal session: *"changed my mind in regards to design."* The first attempt was
**one interface bent to fit three targets** — `isWebTarget`/`isAndroid` branches in the desktop's
own components and a phone layout inside pages built for a 1024px floor. Its engine worked end to
end: a browser built a 117 606-card corpus in 15.6 s, and two devices paired and converged through
the deployed relay.

So this design keeps the engine's shape and changes two things: **the phone gets a face of its
own**, and **the Rust is arranged so a second and third target cost a compile gate instead of 552
`cfg` sites and a hand-written router**.

---

## 1. What is being built

| Target | Core | Storage | Face |
| --- | --- | --- | --- |
| **Desktop** (today) | `grimoire-core`, native | SQLite files, WAL | `src/`, full edition |
| **Android** | `grimoire-core`, native (`aarch64-linux-android`) | SQLite files, WAL | the light app in a Tauri webview |
| **Web / PWA** | `grimoire-core`, `wasm32-unknown-unknown`, in a Worker | SQLite in OPFS, rollback journal | the light app in a browser |

**Android is native, not WASM.** Every WASM constraint in this document — the OPFS pool, the absent
WAL, the single connection, the one-tab rule — applies to the web target only. This was the
load-bearing sentence of the August spec and it still is.

**iOS is out of scope.**

---

## 2. One core, three hosts

```
        desktop UI (src/)                 light app (mobile/ + src/)
              │                             │              │
        Tauri invoke                  Tauri invoke    Worker postMessage
              │                             │              │
     ┌────────┴─────────┐         ┌─────────┴───┐    ┌─────┴────────┐
     │ src-tauri        │         │ Android     │    │ WASM host    │
     │ desktop host     │         │ host        │    │ (PWA)        │
     │ window · mirror  │         │ entry point │    │ one export   │
     │ updater · camera │         │ one command │    │              │
     └────────┬─────────┘         └─────────┬───┘    └─────┬────────┘
              └───────────────┬─────────────┴──────────────┘
                 ┌────────────┴─────────────────────────────┐
                 │ crates/grimoire-core        (no tauri)   │
                 │ schema · search · decks · collection     │
                 │ wishlist · tags · combos · ingest        │
                 │ sync engine · image cache · scanner glue │
                 │ ─ platform/ ─ the only cfg(target_…) ─── │
                 │ native: tokio · reqwest · std::fs        │
                 │ web:    fetch · OPFS · timers            │
                 └──────────────────────────────────────────┘
```

**The architectural rule is unchanged and binding: Rust supplies facts, TypeScript draws
conclusions.** Nothing here moves domain logic across that line. The crate boundary is about *where
code runs*.

### 2.1 Why the extraction is cheaper than it sounds

Four facts about today's tree, each read off the source:

- **Every command is already a thin wrapper.** `search_cards` is
  `spawn_blocking(|| run_search(&lock_db_read(&state), &req))`; `deck_create` is
  `with_write(&state, |c| create_deck(c, &deck))`. The logic is an inner function over
  `&Connection` returning `Result<T, String>`. About 275 `#[tauri::command]` sites follow that shape.
- **`AppState` names no Tauri type.** Two of its twelve fields are the mirror's
  (`mirror::watch::Mask`, `LastPass`); the rest are connections, a path, the Scryfall client, the
  image cache, the facet index, the change mask and the pending pairing offer.
- **Every Rust test is inline.** `src-tauri/tests/` holds fixtures only, so a module's tests move
  with it.
- **I/O touches about fifteen modules, not dozens.** Eight HTTP client constructions in seven
  modules; file access in roughly sixteen; the domain modules ask SQLite's `unixepoch()` for the
  time and nothing else.

Round one reached the same conclusion from the other side and wrote it down: *the gate was in the
wrong place* — modules were un-portable only because the wrappers sat at the foot of each file.

### 2.2 Four rules

| Rule | What it prevents |
| --- | --- |
| **`grimoire-core` has no `tauri` dependency** | The core quietly growing a desktop assumption |
| **`cfg(target_…)` appears only under `crates/grimoire-core/src/platform/`**, fenced by a source sweep | Round one's 552 scattered gates |
| **A command is declared once, in a table in the core**, with its kind — read, write, owned-write or async | Round one's 4 729-line hand-written `match`, and the second "divert" path that grew beside it for async commands |
| **CI compiles the core for all three targets** on every PR that touches it | A desktop change that breaks a light target surfacing weeks later as "144 of 185 routed" |

### 2.3 The crate boundary

**Moves to `crates/grimoire-core`:** schema and both ladders; `db`; `filters`, `sorting`, `search`,
`card`, `index/`; every `deck*`, `collection*` and `wishlist*` module; `reconcile`,
`managed_wishlist`, `bulk_undo`, `activity`; the view-state modules; `tags/`, `combos`,
`marketplace*`; `scryfall`, `ingest`, `feed/`, `maintenance`; `images`; `sync_engine/` and
`sync_pair/`; the home-page reads; `share/snapshot` and `share/cache`; the scanner's session glue.

**Stays in `src-tauri`:** `desktop`, `window`, `camera`, `app_origin`, `file_dialog`, `export`,
`update`, `mirror/`, `transfer/`, `paths`, `split`, `startup`, the change emitter, the three
pickers — and **the desktop's own command wrappers**, moved out of the foot of each domain file
into `src-tauri/src/commands/`.

A pure module that only the desktop reads still moves. The rule is "has no reason to know about a
window", not "the phone needs it today": a module left behind is one the core cannot call, and the
home reads are exactly the kind of thing a later light destination will want.

**Built 2026-10-02, and the wrappers are not in a `commands/` folder.** Each module's stayed at
the module's own path — `src-tauri/src/deck/mod.rs` is `pub use grimoire_core::deck::*;` and
deck's wrappers below it — which is the shape step 2 had already given `schema`. Read against the
tree, 245 of `generate_handler!`'s 257 entries are a path through a module, and a folder would
have meant rewriting every one of them and every cross-module call a wrapper makes; this way no
handler entry and no caller changed. Markus chose it over the folder. The folder can still be a
rename, with §2.4's table. [The step's plan](../plans/2026-10-02-light-app-core-step-4-domain.md)
has the argument.

### 2.4 The command table

One declaration per command, in the core. The shape below is illustrative — the macro's spelling
and the argument types are the extraction plan's:

```rust
commands! {
    read   search_cards(req: SearchRequest)            => search::run_search;
    write  deck_create(deck: DeckInput)                => deck::create_deck;
    owned  collection_add(entry: NewEntry)             => collection::add_entry;
    async  sync_now()                                  => sync_engine::client::run_once;
}
```

and one entry point, `core::dispatch(&Core, name, args) -> Result<Value, String>`, which picks the
connection, wraps a write in `with_write`, rebuilds the owned facet after an owned write, and
awaits an async one.

- **The WASM host** exports `call(name, json)` and forwards.
- **The Android host** registers a single `#[tauri::command] core_call(name, args)` and forwards.
- **The desktop host keeps its typed wrappers**, which now call the same inner functions. Nothing
  about desktop IPC changes and `ipc.test.ts` keeps pinning what it pins.

**The cost of that last line is two lists**, and the fence is the one the Storybook fake already
has: a name-parity test between the core's table and `generate_handler!`, with an explicit list of
desktop-only commands and a reason beside each. Moving the desktop onto the table is a later
decision, taken once the table has run on two other hosts.

**Argument names are the wire.** `ipc.ts` sends camelCase keys and omits optional ones, which bit
round one twice; the table's argument structs carry `#[serde(rename_all = "camelCase")]` and
`#[serde(default)]` on every optional field, and `ipc.test.ts`'s argument-name cases gain the table
as a second thing to read.

**Raw bytes are the one exception.** `scanner_frame` and `scanner_capture` take a JPEG body with
JSON in a header. The table carries a `bytes` kind for them; Tauri accepts no raw body on Android,
so that host's adapter carries the same payload base64-encoded — a transport detail of the host,
invisible above the `Core` seam (§4.6).

**Built 2026-10-03, the reads first.** Markus chose the machinery and the 88 read commands now,
the rest as the light app's pages ask for them, and a `macro_rules!` table —
`crates/grimoire-core/src/commands.rs`, `grimoire_core::dispatch(&state, name, args, body)`. Three
departures from the sketch above, each smaller than it reads. **The kinds are `read`, `write`,
`owned`, `task` and `bytes`**: `async` is a keyword. **No `#[serde(default)]` is spelled**: serde
already reads an absent `Option` field as `None`, which is the whole of what an omitted optional
argument needed. **And the argument-name fence is a Rust test rather than `ipc.test.ts`**:
`src-tauri`'s `command_table` compares each entry's arguments with its desktop wrapper's
parameters, which `ipc.test.ts` already holds to `ipc.ts`'s, so the table reaches the page's
spelling through the wrapper. The parity test lists 16 desktop-only commands with a reason each
and everything else not yet in the table by name. [light-app.md](../../reference/light-app.md)
§6.11 is the record.

### 2.5 `platform/`

Four small interfaces, two implementations each, chosen by `cfg` in exactly one module:

| Interface | Native (desktop, Android) | Web |
| --- | --- | --- |
| `Http` — a request, a streamed body | `reqwest`, with pacing, timeouts, resume | `fetch` |
| `Fs` — the data directory, temp files | `std::fs` / `tokio::fs` | OPFS |
| `Clock` and `sleep` | `SystemTime`, `Instant`, `thread::sleep` | `Date.now()`, a timer |
| `spawn` — background work | a thread or the async runtime | a microtask on the Worker |

Three things round one measured that this layer inherits rather than rediscovers:

- **`SystemTime::now()` panics on WASM**, and was hit five separate times. Nothing outside
  `platform/` may name it; the sweep that fences `cfg` fences this too.
- **A browser's `fetch` always decodes `Content-Encoding: gzip`** and cannot opt out, so a feed
  reader sniffs the two-byte gzip magic off the first chunk and never trusts a header.
- **The streaming framers already exist.** `feed::frame` frames by brace depth and refuses past
  8 MiB; the 610 MB combo document peaks at 2.01 MB through it.

**Built 2026-10-02 for three of the four, and three things differ from the table above.**

- **`Http` is `reqwest` on both arms**, not `reqwest` and a hand-written `fetch`: its wasm
  backend is `fetch`, so `platform::http` is one implementation and the arms differ in three
  lines — a browser has no connect or per-read timeout to set, and cannot say a connection never
  came up. Markus chose it over arms that refuse until phase 5. **Pacing, resume and retry are
  not in it**: they are rules about Scryfall and stay in `scryfall::Client`.
- **`Fs` refuses in a browser; it is not OPFS.** The database's OPFS is SQLite's own VFS, and
  the only other files the engine keeps are a download's temp file and the schema's backups —
  neither of which a browser wants in that shape. What a download looks like there is §6's.
- **`sleep` is two things.** `platform::pause` parks a thread (the storage step, for
  `db::lock_for`); `platform::timer` is the wait a future awaits, and a deadline on one.

**`spawn` arrived with its first callers, in the I/O step's second part, and its browser arm
is not a microtask**: `platform::spawn::blocking` and `background` both run the work where it
stands there, to completion. A Worker has one thread; deferring the work to a microtask would
only move the block, and would let a caller believe something had been taken off it.
[The step's plan](../plans/2026-10-02-light-app-core-step-5-io.md) has each reason.

### 2.6 State, events and the one update hook

- **`AppState` splits.** `core::State` holds what every host needs. The desktop wraps it with its
  two mirror fields.
- **Events leave the core through one trait**, `EventSink::emit(name, payload)`, given at
  construction. Tauri hosts forward to `app.emit`; the WASM host posts to the page. No function in
  the core takes an `AppHandle`.
- **The update hook becomes the core's, with observers.** Today `mirror::watch::install_hook_with_changes`
  installs the single SQLite update hook and carries the cross-file fence, the change mask and live
  sync's wake-up with it. SQLite allows one hook per connection, so the core must own the
  installer; the mirror registers as one observer of it and the desktop is the only host that
  registers one.

**Built 2026-10-02, and three things differ from the list above.**

- **`core::State` is four of the twelve fields, not ten**: the connections, the data directory
  and the fence. The Scryfall client, the image cache, the facet index, the sync flag and the
  pending pairing offer are every host's too, and each is a type that has not moved — they
  stay on the desktop's `AppState`, which wraps `State` and derefs to it, until the I/O and sync
  steps bring them. (**The client, the sync flag and the index came with the I/O step's second
  part**, 2026-10-02; the image cache and the pairing offer are the two still waiting.)
- **The desktop registers three observers, not one.** The other windows' change mask has one
  reader, and it emits only with two or more windows open — a browser is one tab and Android
  one window — so it is the desktop's, as the mirror is. Live sync's wake is a third until the
  sync step brings its reader. The core's hook carries the fence, which the core reads, and
  nothing else. §2.1's "the change mask" among core state is superseded by this.
- **`State`'s read connection is optional** — §6's one connection in a browser, given a shape.

`EventSink` is the trait and a field on `State`; nothing in the core emits through it yet.
[The step's plan](../plans/2026-10-02-light-app-core-step-3-state.md) has each reason.

### 2.7 CI

A `core` job compiles `grimoire-core` for `x86_64-pc-windows-msvc`, `aarch64-linux-android` and
`wasm32-unknown-unknown`, and runs its tests natively. It joins `ci-ok`.

**As built, 2026-10-02, that is two jobs' work.** The `core` job compiles and lints the crate for
the two targets no desktop build touches; the Windows compile and the native test run are the
existing `rust` job's, which reaches the crate through `--workspace` on both of its legs. Every
change that routes to `core` routes to `rust` as well, so the three targets are still gated
together.

**It starts the day the crate exists, with whatever is in it** — a gate added after the extraction
is a gate that proves nothing during it. `sqlite-wasm-rs` compiles SQLite's C amalgamation with
`cc` targeting WASM, MSVC cannot emit WASM, so the job needs clang ≥ 18 (Ubuntu 24.04), as round
one's did.

### 2.8 Extraction order

Each step is its own PR. **The light UI waits for none of them** (§9).

1. **Leaves** — `app_meta`, `slug`, `cardtypes`, `legalities`, `sorting`, `image_uri`, `card_row`,
   `errors`, `feed/`, `index/bitset`, and the sync crypto and merge core (`sync_pair/{crypto,invite}`,
   `sync_engine/{hlc,merge,wire}`). The crate, the `platform/` skeleton, the sweep and the CI job
   land here.
   **Built 2026-10-02, and six of these fifteen were not leaves**: `sorting`, `image_uri`,
   `card_row`, `errors`, `feed/backoff` and `sync_engine/wire` each name `schema`, `sync` or
   `sync_pair::identity` — in their code or in the tests that move with them — and go with step
   2. [The step's plan](../plans/2026-10-02-light-app-core-step-1-leaves.md) has the reason for
   each.
2. **Storage** — `db`, `schema`, `filters`, `collection_source`, `reconcile`, `managed_wishlist`,
   `sync_engine/{capture,apply,baseline}`, `sync_pair/identity`.
   **Built 2026-10-02, and seven of the sixteen this step had by then were not storage**: read
   against the tree, `reconcile`, `managed_wishlist`, `collection_source` and
   `sync_engine/{apply,baseline}` call the deck, collection and wishlist modules and go with
   step 4; `sync_pair/identity` and `sync_engine/wire` name the sync client and go with step 6.
   What moved is `db`, `schema`, `filters`, `sorting`, `card_row`, `image_uri`, `errors`,
   `feed/backoff`, `sync_engine/capture` and a `sync_meta` carved out of `sync` — with
   `schema`'s `prepare_database` and `errors`' `kind_of` left in `src-tauri`, each in a module
   that re-exports the rest, because each names code a later step moves.
   [The step's plan](../plans/2026-10-02-light-app-core-step-2-storage.md) has the table.
3. **State** — the `AppState` split, `with_write`, the hook installer and its observers, `EventSink`.
   **Built 2026-10-02, without `with_write`**: its body arms and settles the managed wishlists
   and reconciles tokens around the caller's write, and those modules are step 4's. What landed
   is `state::State`, `hooks` and `events` — new code, no moved file — and an `AppState` that
   wraps the first. [The step's plan](../plans/2026-10-02-light-app-core-step-3-state.md) has
   the table.
4. **The domain cluster, atomically** — decks, collection, wishlist, search, card, the tag queries
   and the view-state modules: on the order of 120 000 lines. **And, since step 2 found they
   belong to it**: `reconcile`, `managed_wishlist`, `collection_source`,
   `sync_engine/{apply,baseline}`, and `schema::prepare_database` with the launch passes it
   runs. **And, since step 3**: `with_write`, `with_write_waiting` and the body they share, which
   move with the three calls that kept them back. Round one found the cluster mutually
   recursive ("no leaf modules"), so it cannot go piecemeal. **It is done by a re-runnable script on
   an announced day**: it will touch every open branch, and a branch that merges `main` afterwards
   re-runs the script rather than resolving the move by hand.
   **Built 2026-10-02: forty-nine modules, about 105 000 lines, in one run of
   `scripts/core-step-4.mjs`** — and "no leaf modules" measured: eighteen of them name none of the
   others, and the other thirty-one are one knot around `deck`. `with_write` and
   `prepare_database` came with them. **Three things on the list did not move**, each because it
   names step-5 code and nothing was hoisted to free it: `reconcile` (`scryfall::Migration`),
   `tags/` (the queries take `tags::Dataset`, which sits in the fetch engine) and
   `deck::bracket_reads` (`combos::match_combos`). They join step 5.
   [The step's plan](../plans/2026-10-02-light-app-core-step-4-domain.md) has the table.
5. **I/O** — `scryfall`, `ingest`, `run_sync` behind a progress sink, the three feeds,
   `index/lifecycle`, `images`.
   **Three pull requests, because this is the first step that edits what it moves** (Markus,
   2026-10-02): `platform`'s request, timer and files with `scryfall`, `ingest` and `reconcile`
   over them; then the state, the facet index and `run_sync`; then the feeds and the image
   cache. **The first is built**: the three modules, `errors::kind_of` and `capture`'s two
   reconcile tests are the core's, `schema`'s file calls go through `platform::files`, and the
   fence refuses `reqwest`, `tokio`, `std::fs` and `std::thread` anywhere else the crate ships.
   **So is the second**: `sync` and `index/` are the core's, `run_sync` takes no window and
   emits through `EventSink`, `State` holds the sync flag, the Scryfall client and the facet
   index, and the desktop's mirror hears a swapped corpus as a `WriteObserver`.
   [The step's plan](../plans/2026-10-02-light-app-core-step-5-io.md) has the decisions.
6. **The sync client, entitlement and pairing** — see below. `sync_pair/identity` and
   `sync_engine/wire` arrive here rather than in step 2.
7. **The scanner's session glue.**

**Step 6 is the one where code changes rather than moves.** A sync trip today is
`with_write(&state, |conn| runtime.block_on(client::run_once(conn)))`: it holds the write
connection across network calls by blocking a thread. A browser has no thread to block. The trip
has to be restated so that no lock is held across an `await` — read what is pending, release, talk
to the relay, take the lock again, apply — and `sync_group_leave`'s "always possible" has to
survive it. **That phase opens with a spike, not a plan.**

**Spiked 2026-10-02, and decided by Markus the same day**:
[the spike](../research/2026-10-02-light-app-step-6-sync-trip-spike.md) counted thirty-one functions
holding a connection across an `.await` and prototyped the restatement — each takes a `Store` and
reaches the database a *stretch* at a time, and one async lock on `State`, the *lane*, keeps one
sync operation running at a time. He chose that shape over a rewrite into plan / request /
commit functions and over a separate browser trip; *Leave group* waits for the lane as it waited
for the connection; and the step is two pull requests — restate in place, then move.
**The first merged** (2026-10-03, #771): none of the thirty-one holds a connection across a
request, a press during a sync is still told the database is busy, and a reader's write during
one is not. **The second is built the same day**: the client, the entitlement, `wire`,
`schedule`, `identity`, pairing and the sync panel's reads are the core's, every relay request
goes through `platform::http` with a deadline a browser honours, and the pending pairing offer
is a field of `State`. Live sync's socket stays the desktop's. [The step's plan](../plans/2026-10-02-light-app-core-step-6-sync.md)
has the tasks, and what a test that lands a write behind every stretch of a trip found. **It
merged the same day, #772.**

**Step 7 was decided and built on 2026-10-03.** Markus chose the whole glue over moving only what
names no engine — so `card-scanner` is a dependency of the core, measured clean for wasm32 first
(its `bundled` SQLite is not in a browser's tree at all) and still unable to *run* there until §8's
seam — and the scanner's state as a field of `State` rather than a struct each host keeps beside
it. [Its plan](../plans/2026-10-03-light-app-core-step-7-scanner.md) has the rest.

### 2.9 Decided here, and deliberately left to the extraction's own plan

- **A Cargo workspace or not.** A workspace moves `target/` to the repository root, and a great
  deal of this repo's tooling and documentation names `src-tauri/target/debug/data`. `card-scanner`
  is a path dependency and deliberately not a workspace member for a related reason. The default is
  **no workspace**; the plan may argue otherwise with the list of paths it would move.
  **Settled 2026-10-02: a workspace at the repository root, with `target/` pinned where it was.**
  Without one, cargo refuses to test a path dependency that has dev-dependencies from the package
  that depends on it, so the core would have needed a second lockfile and a second build tree.
  Markus chose the root over a workspace rooted at `src-tauri`; `.cargo/config.toml` keeps the
  tree at `src-tauri/target`, so the list of paths it moved is one — `Cargo.lock`. `card-scanner`
  is excluded by name and unchanged.
- **`[profile.dev.package.*]` blocks follow the build root.** Cargo reads them from the root
  manifest only, so the seventeen overrides that make a dev scanner usable are owed in every host's
  manifest. **With the workspace they are owed once**: they moved to the root `Cargo.toml`, and
  a host that joins the workspace inherits them.
- **Text fences that read Rust by path.** `ipc.test.ts` imports about 48 `.rs` files with `?raw`;
  `fake/parity.test.ts` reads `desktop.rs`; `coverage-rust.mjs` hardcodes `src-tauri/src`; seven
  Rust tests reach into `../../src/lib/*.json` and `../../../relay/src/*.ts` by relative path. Each
  moves with its module, in the same PR.

---

## 3. The light app: one app, two faces

**The light app is one entry point that draws one of two faces by the width of its own viewport.**

| Viewport | Face | Where it lives |
| --- | --- | --- |
| **≥ 1024px** — `DESKTOP_FLOOR_PX`, the desktop window's own floor | **The desktop UI itself**, in the light edition | `src/` |
| **< 1024px** | **The phone face**, designed for a phone and scaling up through tablet widths | `mobile/` |

This is round one's mistake turned inside out. Round one took components built for ≥ 1024px and
bent them down to 360. Here every component is drawn only at the widths it was designed and
measured for: the desktop's pages never below their floor, the phone's never above it.

Width alone decides. A browser window 1100 wide and 600 tall gets the desktop face below the
desktop's 700px height floor; what that costs is measured in phase 3 rather than guessed here.

**Each face is its own lazy chunk**, so a phone never downloads the deck editor's desktop build and
a laptop never downloads the phone's sheets.

**The Android app and the web app are the same program, and the phone face is one face — not two
that resemble each other.** Markus's rule, 2026-10-01: *the web/PWA collapses down into the mobile
view, and that view is 1:1 with the mobile app.* That is held by construction rather than by care:
the Android host and the web host load one bundle built from one entry, the face is chosen by
viewport width and by nothing else, and what differs between the two installs is entirely below
the `Core` seam (§3.5). Three things follow, and each is a rule:

- **Nothing under `mobile/` asks where it is running.** No user-agent test, no `isTauri`, no
  `isAndroid`, no `display-mode` query deciding what a page draws. A source sweep refuses them
  (§3.3's fence grows a second arm), because a resemblance kept by hand is N decisions that happen
  to agree today.
- **A narrowed browser window is the phone app.** Dragging a browser across 1024px swaps the face
  live and keeps the destination, because the URL is the navigation state both faces read (§3.4).
  The rule runs both ways: an Android tablet wide enough to cross 1024 gets the desktop face, for
  the same reason a wide browser does.
- **What only one host has comes from the host.** The system back gesture arrives as History
  navigation, the safe area as `env()` insets, a file picker through the service modules. The one
  affordance with no counterpart — the browser's install prompt (§6) — is the browser's own UI or
  a Settings entry that states a host capability, never a banner one install draws and the other
  does not.

### 3.1 The desktop face and the edition

The desktop UI learns one thing: **which edition it is**. An `Edition` is a plain object provided
once at the root, and the full edition is the default, so the desktop app changes nothing by not
providing one.

```ts
interface Edition {
  id: "full" | "light";
  /** The rail's rows: `NAV` filtered by this. `null` is every destination, so the full edition
   *  cannot fall behind a view added to the rail. */
  views: readonly ViewId[] | null;
  /** Whether this window draws its own caption. False wherever a browser or an OS owns the frame. */
  caption: boolean;
  /** The view a URL that names nothing opens on. */
  startView: ViewId;
}
```

The light edition's `views` are **Search, Decks, Collection, Wishlist, Scanner, Settings**.
Which Settings entries exist joins the type in phase 3, with its first reader.

**This is a seam, not a platform check, and the difference is the whole lesson of round one.**
`isWebTarget()` reached into components and asked where they were running; three readers of
`isAndroid()` were already flagged as too many. An edition is *handed to* the shell and answers what
to draw. Its readers are few and named: `AppShell` — the rail, the caption and the chords — and,
from phase 3, `SettingsPage`'s entry list. A page never asks.

**The digits do not move between editions.** `Ctrl+2` is Search in both; a chord for a view the
edition does not draw is inert rather than rebound to the next row. That is the shell's own rule
about the conditional Shared row — one press must not mean two things to two readers — and it was
found by reading `AppShell.tsx` while the skeleton was planned, where the first draft of this
section had the chords renumber.

**What a page calls that only a desktop can answer** — the Rust-opened file dialogs, a new window —
is answered below the `Core` seam (§4.6), not by a branch in the page.

### 3.2 The phone face

`mobile/` at the repository root, beside `share/`: the same npm package, the same `@/` alias, its
own Vite config and entry. `share/` already proves the arrangement — a second browser entry that
draws `CardArt` and `CardChin` from `src/components` with no Tauri behind it.

The shell, from the wireframe Markus approved:

- **A bottom tab bar** with the five destinations, inside the safe area. Settings and the sync
  indicator sit in the top bar.
- **One sticky line**: the search box and a single `Filters` button. Everything else is in a sheet.
- **A wall of card tiles**, two columns at 360px.
- **A card opens as a sheet** over the wall.
- Between a phone and 1024px the same face scales — more columns, wider sheets — and at 1024 the
  desktop face takes over. Whether the tab bar gives way to a rail at tablet widths is one of
  phase 3's options, not something this spec decides.

Four of those were chosen from built options in August and measured on a OnePlus 12 in Chrome:
the tab bar is worth a column of card art against a rail; **a 141px tile is the largest that draws
two columns on a 360px device**; the vertical is scarcer than the horizontal, and a sticky line
with a sheet behind it gave the wall the most of it; a `fixed inset-0` box resolves against the
visible viewport, so `Dialog` needs no change for a URL bar. They are adopted, not re-run.

**Every page beyond the shell comes to Markus as built options before it is built** — the filters
sheet, the card sheet, the collection and wishlist cabinets, the deck editor. That is phase 3, and
it follows the `frontend-design` skill and the visual direction doc like all UI here.

### 3.3 What the phone face may import

**One structural rule instead of a list.** A file under `mobile/` may import anything in `src/`
whose import graph does not reach:

- `@/lib/store` — the desktop's 1 745-line store;
- the desktop shell — `@/App`, `@/components/{AppShell,TitleBar,Ribbon}`, `@/boot/*`;
- `@/lib/window`, or any `@tauri-apps/*` module except through `@/lib/core`.

A graph-walking test enforces it, written the way `share/SharePage.test.tsx`'s already is:
side-effect and dynamic imports count, and an anti-vacuity guard fails an empty walk.

| Shared as it stands | The phone face builds its own |
| --- | --- |
| The presentational components — `CardArt`, `CardImage`, `CardChin`, `ManaText`, `RarityGem`, `FinishMark`, `GameChangerMark`, `CountTag`, `OwnedBadge`, `QuantityStepper`, `Dialog`, `Dropdown/`, `menu/`, `tooltip/` | `CardGrid` (2 997 lines), `CardDetailModal` (2 209), every page — each reads the desktop store |
| Tokens, fonts, the `coarse` variant and the 44px touch floors | The shell and its navigation |
| `ipc.ts` and every DTO type — both faces talk to one core | Sheets, gestures, layout |
| TypeScript domain logic — deck validation, the query language, import and export parsing, `formatPrice` | A small store of its own |

**When the phone face wants a component that is welded to the desktop store, the component is
changed to take props, in `src/`** — so both faces gain, and the rule above is what finds the weld.

**One such piece lands with the skeleton: `components/CardTile`**, the composition of `CardArt` and
`CardChin` that `CardGrid` and `ShareTile` each spell out for themselves today. The phone wall and
`ShareTile` adopt it at once; `CardGrid` adopts it when somebody is next in that file, not as a
rider on this work.

### 3.4 Navigation is the URL

The desktop has no router: `activeView` is a field in its store. A browser and a phone need one,
for the Android back gesture, the browser's back button, and a link somebody can send.

- **The phone face** owns a small router over the History API. No dependency.
- **The desktop face** keeps its store. One adapter in the light entry seeds `activeView` and
  `openDeckId` from the URL and writes them back — so no router enters `src/`, and resizing a
  browser window across 1024 lands on the same destination in the other face.

Filter state does not survive that crossing; the query cache does, because both faces share one
`QueryClient`.

### 3.5 The three places a face touches its host

`src/lib/core/index.ts` is seven lines today and hard-wires Tauri. It becomes the one place a build
chooses its host, and three service modules follow it:

| Seam | Desktop | Android | Web |
| --- | --- | --- | --- |
| `Core.call` / `listen` | `invoke(name, args)` | `invoke("core_call", { name, args })` | `postMessage` to the DB Worker |
| File open and save | Rust opens the dialog | the system picker | `<input type=file>`, a `Blob` download |
| Clipboard, open a link | the two plugins | the two plugins | `navigator.clipboard`, `window.open` |
| Card images | `mtgimg://` | `http://mtgimg.localhost` | the same path, served by the service worker |

**The image URL keeps its shape on every host.** `cardImageUrl` builds
`<origin>/<variant>/<card_id>/<face>` and already picks its origin by platform. On the web the
origin is the app's own and a service-worker route answers it — asking the core for the Scryfall
URI, fetching it, and keeping it in Cache Storage. So no call site that builds that URL changes,
and `CardArt`'s `remoteSrc` door stays the share viewer's alone.

**The Storybook fake is a fourth host**, and it already exists: it sits under `ipc.ts` by Vite
alias and answers every registered command. The light app in a plain browser over the fake is a
config file (§10).

---

## 4. Features

| Destination | In the light edition | Depth |
| --- | --- | --- |
| Search | yes | The full query language, filters and facets, the card surface, printings, prices, tags and the combos row |
| Decks | yes | Close to the full editor — categories, labels, quantities, printings and finishes, the theory list, notes and to-do lists, validation, the bracket estimate |
| Collection | yes | The cabinet, folders, entry edits, import and export |
| Wishlist | yes | The cabinet, folders, the managed wishlist as a read |
| Scanner | yes | Fast and Exact, the review tray, commit to a folder |
| Settings | reduced | Sync and pairing, the supporter block, card data and the optional feeds, the image cache, marketplace, the danger zone |
| Home, Tagger, Trade, Playtesting, shared binders | no | — |
| Backup (the mirror), Updates (the portable swap), new window | no | Each is a different feature on these hosts rather than a port |

**At ≥ 1024px that depth is free**: the desktop's own pages are what is drawn. **Below it, each row
is a phone page to design**, and "close to the full editor" on a phone is the largest single piece
of UI work in this programme.

Carried over from August without re-asking:

- **Mana Pool is unavailable in a browser.** Its endpoint sends no `Access-Control-Allow-Origin`.
  The marketplace picker offers what the host can reach, and a database synced from a desktop that
  chose Mana Pool falls back rather than drawing blanks. Android reaches it natively.
- **The mobile-data prompt.** Any feed over 5 MB shows its measured size and, where the connection
  reports itself metered, defaults to *Not now*.

---

## 5. The Android host

A second Tauri project, `mobile/src-tauri`, depending on `grimoire-core` and holding almost nothing
else: the mobile entry point, `core_call`, the image protocol, the camera permission, and the
generated `gen/android`.

What round one learned and this inherits:

- **Android needs JDK 21.** JDK 25 breaks the Android Gradle and Kotlin plugins — and `JAVA_HOME` on
  the development machine is JDK 25 today. No `ANDROID_HOME`, no NDK and no Android Rust target are
  installed either; round one's toolchain measured 4.48 GB.
- **`npx tauri`, not `cargo tauri`.** Bare `cargo` needs the NDK's `bin` on `PATH` and the linker
  named for `aarch64-linux-android`.
- **`gen/android` is committed, and a re-init reverts hand edits** — `allowBackup="false"` and the
  narrowed `FileProvider` among them.
- **`tauri android dev` goes through `adb reverse`**, never `TAURI_DEV_HOST`; the debug build's id
  is suffixed `.debug`; logs are in logcat under `RustStdoutStderr`.
- **The device names itself from `Build.MODEL` over JNI**, through tao's `main_android_context`.
- **A file the reader picks arrives as a `content://` URI**, opened Rust-side.
- **Sync worked on Android** on 2026-08-29 against the deployed relay: pairing, a 1 069-op
  baseline in 1 543 ms, and a both-sides increment converging.

Round one never produced a signed APK, an APK size or a cold-start figure. **Signing and
distribution are phase 4's to decide**, with Markus.

---

## 6. The web host

The core compiled to WASM, loaded by a dedicated Worker, with the page talking to it through the
`Core` seam.

| | Measured in round one (desktop Edge unless said) |
| --- | --- |
| WASM module | 2 642 182 B, release, no `wasm-opt` |
| First run, 117 606 rows | 15.6–16.3 s |
| First run on a OnePlus 12 (spike) | 36.5 s |
| Linear memory, peak | 148.6–171.6 MB |
| `search_cards` | median 53 ms, cold 134 ms |
| `facet_cards` | 5 ms |
| Storage | about 526 MB with every feed |

What it has to carry:

- **One connection and no WAL.** `opfs-sahpool` permits one connection; `PRAGMA journal_mode = WAL`
  answers `delete`. Searches queue behind an ingest. Anything in the core that assumes WAL is the
  platform module's to answer.
- **One tab.** A second document opening the same database fails hard. The second tab detects it at
  start and says so in a sentence with a Reload button.
- **The corpus can vanish while the shell survives.** OPFS and Cache Storage are evicted
  independently; the app opens the corpus before assuming it and offers a rebuild.
  `navigator.storage.persist()` is asked once and its answer recorded, not trusted;
  `navigator.storage.estimate()` gates nothing — it reported 647 MB and then 7 MB for one unchanged
  532.8 MB file.
- **The PWA update flow.** A new build installs as the waiting worker; a non-modal bar says a new
  version is ready; only that press calls `skipWaiting`. Cache Storage lookups pass `ignoreVary`, or
  the offline shell is blank.
- **A `wasm-bindgen` module can instantiate twice under StrictMode and corrupt the heap**; the
  load is memoised. The CLI and the crate version must match, or the failure is at runtime.
- **Hosting.** Cloudflare Workers static assets, at an origin root — a service worker controls its
  own path and below, so a sub-path host pushes a prefix through everything. It is a Worker Markus
  deploys, beside the relay and never the same one.

**No agent provisions anything.** The source and its `wrangler.jsonc` are committed; Markus runs
`wrangler deploy`.

---

## 7. Sync on a light install

**A light install is another device in the group.** It pairs by the same invite, compares the same
six digits, derives the same relay credential, and takes **one of the membership's five slots** — a
phone and a browser are two.

| | Android | Web |
| --- | --- | --- |
| Pairing | Scan the desktop's QR with the camera | Scan with a webcam, or paste the code |
| Transport | The core's native client, as desktop | `fetch` from the Worker |
| Live updates | The socket, from Rust | **None at first** — pull on focus, on a timer and after a write |
| Keys | In `user.db`, as desktop | In `user.db` in OPFS |

**Two things the relay does not do today, both needed only by the browser**, and both a relay
deploy that is Markus's to run:

1. **CORS.** `relay/src` sends no `Access-Control-*` header and answers no `OPTIONS` (read
   2026-10-01). Every sync request is a JSON `POST` or carries a bearer, so each needs a preflight.
   The fix is an allow-list naming the web app's origin. It weakens nothing: no route trusts a
   cookie, and every one is already gated by a token, a code or a secret.
2. **A browser cannot set a header on a `WebSocket`**, and `/g/{group}/ws` authenticates by
   `Authorization` alone. The browser therefore starts without the doorbell. A ticket in the
   sub-protocol is a later relay change, if polling proves too slow to live with.

Two more that follow from what a browser is:

- **Clearing site data mints a new device and spends a slot.** The panel says so before a reader
  presses anything that would, and a removed device frees its slot through the manifest as it does
  today.
- **`pull` is unpaged** and can answer tens of megabytes after a large import. That is a memory
  question in a Worker where it was not one on a desk; the phase that drives browser sync measures
  it first.

**One core means one schema version per commit, so the three hosts release from one tag.** The
standing rule — every device in a group is updated before it syncs across a rung — becomes a
release-train rule rather than something a reader has to arrange.

---

## 8. The scanner on a light install

The camera is already the page's: `useCamera` calls `getUserMedia`, a canvas makes a JPEG, and
`Session::frame(&[u8], &FrameOptions)` answers a verdict. The crate is pure Rust apart from bundled
SQLite, with no GPU and no OpenCV.

| | Android | Web |
| --- | --- | --- |
| Engine | `card-scanner`, native | `card-scanner`, WASM, in a Worker |
| Blockers | none known; never driven on a phone | `std::thread::scope` at five sites, a spawned resolve thread, `Instant::now()` throughout, `catch_unwind` as the panic guard |
| Frame transport | base64 through `core_call` | a transferred buffer |

**The crate's threads and clocks go behind the same kind of seam the core's do**, with an inline
path for a host that has neither.

**The assets are fetched on first use, not embedded.** 5.4 MB of hashes and 12.2 MB of OCR models
are a third of a megabyte-scale app shell; the Scanner destination offers the download with its
measured size, exactly as a feed does.

**Every recorded scanner timing is a Windows desktop's**, and the multi-threaded gains — 170 ms to
101 ms on threads alone — are the ones a single-threaded WASM build gives back. **Phase 7 opens
with a measurement on a real phone**, in both hosts, before anything is promised about Exact mode
or about OCR in a browser.

---

## 9. Phases

| # | Phase | Waits for |
| --- | --- | --- |
| **1** | **The skeleton** — §10 | nothing |
| **2** | **The core extraction** — §2.8's seven steps | nothing |
| **3** | **The phone face's pages** — filters and the card sheet, collection, wishlist, the deck editor; and the desktop face's light Settings | 1 |
| **4** | **The Android host** | core steps 1–5; the toolchain on the machine |
| **5** | **The web host** — the WASM build, the Worker, OPFS, the corpus-build screen, the service worker, hosting | core steps 1–5 |
| **6** | **Sync on light installs** — the pairing UI, the relay's CORS, the browser's polling | core step 6; 4 or 5 |
| **7** | **The scanner on light installs** | core step 7; 4 or 5 |

**Phase 3 never waits on phase 2.** Both faces talk to `ipc.ts`, and `ipc.ts` runs today on the
desktop's Rust and on the Storybook fake. The whole light UI can be designed, built and driven
while the crate moves underneath it — which is also what keeps the extraction honest, since a UI
that already exists is what each extracted step is checked against.

---

## 10. Phase 1 — the skeleton

**What it is for: seeing the light app run, at both faces, on real data, before anything else is
built.**

### 10.1 What is built

**The entry and its build**

- `mobile/index.html`, `mobile/main.tsx`, `mobile/mobile.css`; `vite.mobile.config.ts` merged over
  the base config with the repository root kept as `root`, port **5175**, output `dist-mobile/`.
- `mobile` joins `tsconfig.json`'s `include`. `npm run build` type-checks it.
- A web app manifest and icons. **No service worker** — round one's own trap list has a build that
  looked like a failed port because the worker was serving the old one, and nothing in the skeleton
  needs to be offline.

**The edition seam** (§3.1)

- `src/lib/edition.ts` — the type, the two editions, a provider whose default is `full`.
- `AppShell` filters `NAV` by the edition, draws `TitleBar` only when `caption` is true, and
  leaves a chord for a view outside the edition inert. The stored start view is not consulted in
  the light app at all: the URL is seeded into the store as a press, and the shell's launch
  hydration already yields to a press.
- **The desktop app is unchanged**, and the tests that say so are the existing ones: nothing in
  `AppShell.test.tsx`, `nav.test.ts` or `App.test.tsx` may need editing for the full edition.
  Settings' light entry list is phase 3; the skeleton's light Settings draws what it draws today.

**The phone face**

- The shell: top bar, bottom tab bar, the router. An error boundary stands around *both* faces,
  in the light entry (`mobile/FaceBoundary.tsx`), rather than inside the phone shell: the failure
  it is most needed for is a face's lazy chunk not arriving, which is above either shell.
- `components/CardTile`, adopted by the phone wall and by `ShareTile`.
- **Search, for real**: the query box sends the same request `SearchPage` sends; the wall is
  virtualised, two columns at 360px; a tile opens a card sheet showing the picture, the name, the
  type line and the printing.
- **Decks, Collection, Wishlist**: real, read-only lists from the same commands the desktop pages
  call — deck tiles, and the two cabinets as walls of the same tile.
- **Scanner**: a placeholder that says what is coming.
- No write, anywhere.

**The switch**

- The light entry draws the phone face below 1024px and the desktop face, light edition, at or
  above it — each a lazy chunk — with the URL adapter of §3.4 for the view.

**The fence** (§3.3), and a story for `CardTile`, which lives in `src/`. **Stories for phone UI
are phase 3's**: Storybook's story glob, its stylesheet source and `src/stories.test.tsx`'s module
glob all stop at `src/`, and widening three globs is work for when the pages that need a
catalogue exist. Until then the phone face's workbench is `npm run mobile:dev`.

**`mobile/CLAUDE.md`**, carrying the rules of §3 for whoever works there next, and a row for it in
the root file's table.

### 10.2 Two ways to run it

| Command | What answers `ipc` | What it proves |
| --- | --- | --- |
| `npm run mobile:dev` | The Storybook fake, by the same four Vite aliases Storybook uses | The UI, in any browser, with no Rust and no lock |
| `npm run mobile:tauri` | The desktop's real Rust core and the reader's real corpus | The same UI against 117 000 printings, in a window sized like a phone |

`mobile:tauri` is `tauri dev` with a config overlay: the dev URL is the light entry's, the window
is 412 × 915 with the native frame, and it has no 1024px minimum. **One Rust edit rides with it**:
`window::open_sized_to_monitor` climbs a 1920/1280 ladder for every window, and stands aside for a
window the config sized below the desktop floor. It is the same binary and the same data folder, so
it takes the `app` lock like any launch.

Two details the plan must not rediscover:

- **The fake does not answer `startup_status`** — it is one of the two commands on
  `parity.test.ts`'s `ABSENT` list — and `DesktopBoot` reads a rejected ask as *still loading*. The
  light entry's gate is the same hook with the fake build skipping it, as Storybook does by never
  mounting the gate at all.
- **`mobile:dev` needs a world installed.** The fake's handlers answer from whichever world
  `installWorld` last put up; the fake build's entry installs `starter` once, before React.

### 10.3 Done means

- At 360 × 800 in a browser: five tabs navigate and the URL follows; Back returns; Search answers
  and draws shared tiles; a tile opens the card sheet; Decks, Collection and Wishlist list rows.
- At 1280 × 800 in the same tab: the desktop UI, with a rail of exactly Search, Decks, Collection,
  Wishlist, Scanner and Settings, and no caption.
- In the `mobile:tauri` window: the same against the real corpus, and widening the window past
  1024 changes the face.
- The desktop app, launched normally, is as it was — eleven rail rows, its caption, Home first.
- `npm run verify` is green, with the fence and the phone face's tests in it.

### 10.4 Not in the skeleton

Android. WASM. A service worker. Sync or pairing UI. Any write. The filters sheet. The light
Settings list. Any Rust beyond the one window edit.

---

## 11. Verification

| Target | How |
| --- | --- |
| Desktop | `scripts/cdp.mjs` against the Tauri window — [the existing contract](../../reference/live-ui-verification.md) |
| The light app over the fake | A browser at a phone viewport and at a desktop one, driven over CDP |
| The light app over the real core | `scripts/cdp.mjs` against the `mobile:tauri` window |
| Web host | Headless Chrome over CDP against the built app; a real phone over `adb reverse`, which makes the dev server `localhost` and therefore a secure context |
| Android host | The device over `adb` and logcat |

**A green suite proves the host it ran on and nothing else.** That is why §2.7's job compiles three
targets, and why each later phase ends on its own device rather than on `verify`.

**Desktop must not regress.** Every extraction step re-runs the measurements in
[data-and-sync.md](../../reference/data-and-sync.md) that it could have moved and shows both
columns, with the build named.

---

## 12. Open, and who settles it

| Question | Settled in |
| --- | --- |
| The sync trip without a lock held across an `await` | Phase 2, step 6 — a spike first |
| A Cargo workspace, and where `target/` lives | Settled 2026-10-02 — §2.9. Open: moving `target/` to the root, which is deleting one file on an announced day |
| How the desktop face behaves below its 700px height floor in a browser | Phase 3, measured |
| What the deck editor is on a 360px screen | Phase 3, as built options put to Markus |
| Android signing and distribution | Phase 4, with Markus |
| The web app's origin, and therefore the relay's CORS allow-list | Phase 5, with Markus |
| Whether a browser needs the live socket | Phase 6, after polling has been lived with |
| Whether OCR is usable in a browser on a phone | Phase 7, measured on a device |
| Whether the desktop moves onto the command table | After phases 4 and 5 have both run on it |

## 13. Not being built

- **iOS.**
- **A separate TypeScript engine** for the light app. It would be a second implementation of
  search, storage and the sync merge — the opposite of parity — and on Android it would ignore the
  Rust that Tauri puts beside it.
- **A slim corpus.** The corpus tier stays the reader's choice of which optional feeds to fetch,
  on every host.
- **Platform checks in pages.** There is an edition handed to the shell and a host below `Core`;
  there is no `isWeb()`.
