# Cross-platform MTG Grimoire — desktop, web, Android, one synced dataset

**Design spec, 2026-08-27.** Supersedes nothing; extends
[the 2026-08-04 collection-tracker design](2026-08-04-mtg-collection-tracker-design.md).

Two documents come before this one and are not repeated here:

- [**The wasm-core spike**](../research/2026-08-27-wasm-core-spike.md) — every measurement this
  design rests on, with build, platform and device named.
- [**The parity matrix**](2026-08-27-cross-platform-parity-matrix.md) — every feature × three
  platforms, signed off 2026-08-27.

**This is an architectural spec covering five phases and nine PRs. It is deliberately not a
single implementation plan** — each phase gets its own plan, written when its turn comes, so that
later phases are planned against what earlier ones actually built rather than against a guess.

## 1. What is being built

One codebase, three targets, one dataset:

| Target | Core | Storage | UI |
| --- | --- | --- | --- |
| **Desktop** | Rust, native | SQLite file, WAL | Tauri webview |
| **Web** | Rust → `wasm32-unknown-unknown` | SQLite in OPFS, rollback journal | Browser, installable PWA |
| **Android** | Rust, native (`aarch64-linux-android`) | SQLite file, WAL | Tauri mobile, system webview |

**Android is native, not wasm.** Every wasm constraint in this document — the OPFS VFS, the
absent WAL, the single connection, the push-parser rewrite — applies to **Web only**. This is the
single most load-bearing fact in the design and the easiest to forget.

### Decisions carried in, not re-opened

Search and faceting stay local on every platform. Only the user's own data syncs, end-to-end
encrypted. Android first; iOS is out of scope entirely. No accounts — pairing only. Every
platform builds its own corpus from Scryfall. Web and Android drop `cards.raw`. The web target
ships as an installable PWA.

### Decisions taken during this design

| Decision | Where |
| --- | --- |
| The corpus tier is a per-reader choice, not a platform decision | [§5.3](#53-the-corpus-and-the-optional-feeds) |
| A second browser tab is refused, with an explanation | [§5.2](#52-one-connection-one-tab) |
| The mirror stays desktop-only | [§6.3](#63-what-compiles-where) |
| `deck_audit` syncs; `deck_undo` does not | [§7.2](#72-what-syncs) |
| Drag-and-drop moves to `@dnd-kit/react` everywhere | [§6.4](#64-drag-and-drop) |
| Mana Pool is unavailable on web (CORS) | [§5.3](#53-the-corpus-and-the-optional-feeds) |
| One SQLite Durable Object, no R2 | [§7.7](#77-the-relay) |
| Compact on ack, keep 30 days | [§7.7](#77-the-relay) |

## 2. Architecture

```
        ┌──────────────────────── React 19 + TypeScript ────────────────────────┐
        │   pages · deck validation · import/export parsing · domain logic      │
        └───────────────────────────────┬───────────────────────────────────────┘
                                        │  Boundary A — src/lib/ipc.ts
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
              Tauri invoke        wasm Worker          Tauri invoke
               (desktop)            (web)               (Android)
                    │                   │                   │
        ┌───────────┴───────────────────┴───────────────────┴───────────┐
        │                    Rust core — facts, never conclusions        │
        │   search · facets · schema · deck storage · ingest · sync      │
        └───────────────────────────────┬───────────────────────────────┘
                                        │  Boundary B — platform I/O traits
                    ┌───────────────────┴───────────────────┐
              native impl                              browser impl
        tokio::fs · reqwest · threads            OPFS · fetch · Worker
```

**The architectural rule is unchanged and binding: Rust supplies _facts_, TypeScript draws
_conclusions_.** Nothing in this design moves domain logic across that line. The two boundaries
are about *where code runs*, not about *what decides what*.

## 3. Boundary A — the TS→core interface

**Smaller than expected, and that is measured.** All 136 `#[tauri::command]`s are named in exactly
one file, `src/lib/ipc.ts`. Fourteen other frontend files touch a Tauri API.

One interface, three implementations:

```ts
interface Core {
  call<K extends keyof Commands>(name: K, args: Commands[K]["args"]): Promise<Commands[K]["result"]>;
  listen(event: string, handler: (payload: unknown) => void): () => void;
}
```

| Seam | Desktop | Web | Android |
| --- | --- | --- | --- |
| 136 commands | `invoke` | `postMessage` to the DB Worker | `invoke` |
| progress events | Tauri events | `postMessage` from the Worker | Tauri events |
| file open/save | `plugin-dialog` | `<input type=file>` / FS Access | Tauri mobile dialog |
| clipboard | `plugin-clipboard-manager` | `navigator.clipboard` | plugin |
| external links | `plugin-opener` | `window.open` | plugin |
| window chrome | custom caption + Win32 hit-test | — | — |
| card images | `mtgimg://` protocol | Cache Storage + blob URLs | Tauri asset protocol |

**No call site changes.** `ipc.ts` keeps its exported shape; only its body learns to dispatch.
The hand-written DTO mirrors and their `ipc.test.ts` argument-name pins stay exactly as they are.

## 4. Boundary B — the Rust I/O layer

The larger half. Around twenty modules touch `tokio::fs`, `std::thread` or `reqwest`. Three
traits, two implementations each.

```rust
trait Fs   { async fn read(&self, p: &Path) -> Result<Vec<u8>>; /* write, remove, list, mkdir */ }
trait Http { async fn get(&self, req: Request) -> Result<Response>; /* Response yields a byte stream */ }
trait Spawn{ fn spawn(&self, f: impl Future<Output = ()> + 'static); fn semaphore(&self, n: usize) -> Semaphore; }
```

Three things the spike found that this layer must carry, none of which were in the original scope:

**4.1 The combo parser has to be rewritten, not ported.** `combos.rs` streams with
`serde_json::Deserializer::from_reader` plus a `DeserializeSeed` — a **pull** parser that blocks
for more input. A wasm stream is push and async with no thread to block, so `from_reader` cannot
be driven from it at all. The replacement, proven in the spike: **frame array elements by brace
depth** (respecting string and escape state) and hand each complete element to
`serde_json::from_slice`. Measured peak buffer **2.01 MB against a 610.2 MB document**.

> This framer **fails silently when wrong.** The spike's first version found 63 elements in
> 610 MB and grew its buffer to 609.82 MB without erroring. **The implementation must assert peak
> buffer size, not only row count.**

**4.2 Who decompresses differs by platform.** Spellbook sends `Content-Encoding: gzip` even when
the client asks for `identity`; Scryfall sends none. A browser's `fetch` always decodes the former
and cannot opt out. **Sniff the two-byte gzip magic (`1f 8b`) off the first chunk** and decide
from the bytes, never from a header or a file extension.

> Related, for desktop: the absent reqwest `gzip` feature is load-bearing for the combo feed
> specifically. Enabling it would break that ingest with `invalid gzip header` while leaving
> Scryfall's working. `Cargo.toml`'s comment gives a different reason and should be corrected.

**4.3 `ingest_gz` takes a path today.** It becomes "takes a stream of lines". That is the clean
seam and it is a small change.

## 5. The web target

### 5.1 The core in a browser

`rusqlite 0.40` already targets `wasm32-unknown-unknown` natively — `sqlite-wasm-rs` is its
declared FFI backend, in the **default** feature set. The manifest change is:

```toml
[target.'cfg(not(target_family = "wasm"))'.dependencies]
rusqlite = { version = "0.40", features = ["bundled", "hooks"] }

[target.'cfg(target_family = "wasm")'.dependencies]
rusqlite = { version = "0.40", features = ["hooks"] }
```

> ⚠️ **Never pass `default-features = false`.** It switches the wasm FFI backend off and rusqlite
> then fails with `unresolved import libsqlite3_sys`, which reads exactly like "wasm unsupported"
> and is the opposite of the truth.

SQLite is **3.53.0** with FTS5, DBSTAT, COLUMN_METADATA and PREUPDATE_HOOK. `THREADSAFE=0` and
`OS_OTHER` are both fine — rusqlite's single-threaded guard is on the `libsqlite3-sys` path, and
`sqlite-wasm-rs` installs a default memory VFS at init.

**Cross-origin isolation is not required.** Measured both ways, identical results. The service
worker therefore does **not** re-attach COOP/COEP on cached navigations, and that entire class of
"works on first load, breaks on the second" bug does not exist here. COI remains available if
wasm threads ever earn their keep.

**No WAL.** `PRAGMA journal_mode = WAL` answers `delete` on the sahpool VFS. The web target runs
a rollback journal, and its durability semantics differ from desktop's. Anything that assumes WAL
behaviour must be `cfg`-gated.

### 5.2 One connection, one tab

`opfs-sahpool` holds exclusive access handles and permits one connection. A second document
opening the same database fails hard:

```
NoModificationAllowedError: Access Handles cannot be created if there is another
open Access Handle or Writable stream associated with the same file.
```

**Decided: the first tab wins and the second says so.** The second document detects the held
handles at startup and renders a plain page — "MTG Grimoire is already open in another tab" —
with a Reload button, rather than a stack trace or a blank screen. No pause/unpause handoff, no
fight over the database.

Everything else follows from this: the **entire database lives in one dedicated Worker**, and
every command queues through it. The Worker is not an optimisation, it is where the app is.

### 5.3 The corpus and the optional feeds

Built on device from Scryfall, like every platform. Both Scryfall hosts send
`Access-Control-Allow-Origin: *`, which is what makes decision 5 possible at all.

**Measured first runs** (Chrome 151, release wasm — desktop workstation / OnePlus 12):

> Sizes here are **byte counts**, because the probe reported MiB (÷1048576) while the feed
> figures already in `CLAUDE.md` are decimal MB — 27 555 788 B is both "26.3 MB" and "27.5 MB"
> depending on the divisor, and the raw number is the only one that cannot drift.

| | Desktop | Android browser |
| --- | --- | --- |
| `default_cards` — 77 972 714 B gz → 627 900 518 B JSON, 117 464 rows | **10.4 s** | **36.5 s** |
| Spellbook combos — 27 555 788 B gz → 639 866 292 B JSON, 105 516 kept | **12.6 s** | **23.1 s** |

**The tier is the reader's, not the platform's.** All four optional feeds stay opt-in exactly as
they are today; nothing downloads until asked, and a database that never fetched the taggers is a
supported state the app already handles. Tier A (526 MB) and Tier B (386 MB) are therefore
per-database conditions, not build variants.

**Mobile-data prompt:** on Web and Android, any feed over 5 MB shows its **measured**
`compressed_size` and, where `navigator.connection` reports a metered link, says so and defaults
to "Not now".

**Mana Pool is unavailable on web.** `manapool.com/api/v1/prices/singles` returns 200 with no
`Access-Control-Allow-Origin`, so a browser refuses the response — verified from a real page
origin, where Card Kingdom returned `type=cors` with a readable body and Mana Pool threw
`TypeError: Failed to fetch`. The web marketplace picker offers Card Kingdom only, and a database
synced from a desktop that had chosen Mana Pool falls back rather than showing blanks. **No CORS
proxy** — that puts infrastructure we maintain in the path of a feed, which is what decision 5
exists to avoid.

### 5.4 Storage and the PWA

Tier A stores comfortably: 532.8 MB written at 162 MB/s, reattached in 40 ms and byte-intact
after Chrome was killed and relaunched.

> ⚠️ **`navigator.storage.estimate()` is not a pre-flight.** It reported 647 MB during a fill and
> 7 MB immediately after a restart, against a file that was 532.8 MB both times, and reported an
> identical quota on the desktop and the phone. Never gate an ingest on it.

**Image cache: 256 MB LRU, reader-adjustable to 1 GB.** From the live cache — 519 MB over 7 929
files, ~65 KB per image — that is ~3 900 cards, against ~65 MB for a 1 000-card grid and ~6.5 MB
for a deck. It keeps the whole web footprint under 1 GB against a 526 MB corpus. Desktop stays
uncapped.

**Two storage systems, two eviction policies.** The shell lives in Cache Storage and the corpus in
OPFS, evicted independently. **"Shell loaded, corpus gone" is a state to handle**: on boot the app
opens the corpus before assuming it, and offers a rebuild rather than erroring.
`navigator.storage.persist()` is requested once the corpus is built, and its answer is recorded,
not trusted.

**The update flow**, because "just reload" is not one: the service worker installs a new build as
the waiting worker; the app shows a non-modal "A new version is ready" bar; the reader presses it;
`skipWaiting` + `clients.claim` run and the page reloads once. A reader who never presses it keeps
working on the old build rather than being interrupted.

## 6. Shared frontend work

### 6.1 Mobile layout

A design task, not a media-query pass. The ribbon, `CardGrid`, the deck editor and the filter bar
each need a phone answer, and **options come to Markus before anything is built**, via the
`frontend-design` skill. This spec fixes only that it happens in Phase 5, after the drag migration
has made touch dragging possible at all.

### 6.2 Import and export

Parsers and writers are TypeScript and unchanged. Only the file handle differs: `<input type=file>`
and a `Blob` download on web, Tauri's dialog elsewhere.

**The golden fence survives unchanged.** `src/features/transfer/__golden__/` exists because
`src-tauri/src/transfer/` is a second implementation of the TS writer, needed only because the
mirror is a Rust thread that cannot ask the page to render a file. The mirror is desktop-only, so
the Rust writer is desktop-only, and the fence goes on guarding exactly one second implementation
against one corpus and one golden set. Web and Android run the TS writer alone and inherit the
same goldens.

### 6.3 What compiles where

| Module | Desktop | Web | Android |
| --- | --- | --- | --- |
| `src-tauri/src/mirror/` | ✅ | ⛔ | ⛔ |
| `src-tauri/src/transfer/` (Rust writer) | ✅ | ⛔ | ⛔ |
| `src-tauri/src/update.rs` (portable swap) | ✅ | ⛔ | ⛔ |
| `src-tauri/src/window.rs`, snap layouts | ✅ | ⛔ | ⛔ |
| everything else | ✅ | ✅ | ✅ |

### 6.4 Drag-and-drop

**Moves to `@dnd-kit/react` on every platform.** `pragmatic-drag-and-drop` is built on native
HTML5 DnD, which has no touch implementation and never will. Measured 2026-08-27:
`@dnd-kit/core` has the proven API and 24.4 M weekly downloads but has not shipped since
2024-12-05; `@dnd-kit/react` 0.5.0 is the actively developed successor with explicit React 19
support.

**It is pre-1.0 and gets treated as such:** pin the exact version, no caret. Migrate desktop-first
in its own PR, and **re-verify every shipped drag before touch is added** — a second drop-target
registration on one element silently replaces the first, so a working new drop is never evidence
the old one survived.

> **A benefit that is not obvious.** HTML5 DnD cannot be driven synthetically — Chrome refuses to
> begin a native drag from an untrusted event — which is why the deck editor's drags are
> **unverifiable in the live window today**. `@dnd-kit/react` is pointer-event based, and pointer
> events *can* be dispatched over CDP. This migration converts the app's least-testable
> interaction into a testable one, on desktop as much as on a phone.

## 7. Sync

### 7.1 Shape

Offline-first. Every device works fully offline against its own SQLite and reconciles on
reconnect. The relay stores and forwards ciphertext and can decrypt nothing.

### 7.2 What syncs

**Twelve tables**, plus a preference subset of `app_meta`. That is the same *count* as the
brief's list and not the same *list* — one table leaves and one joins, which is precisely why
it is easy to write down as thirteen:

`collection_entries` · `collection_folders` · `decks` · `deck_cards` · `deck_categories` ·
`deck_folders` · `deck_allocations` · `deck_audit` · `deck_tags` · `wishlist_entries` ·
`wishlist_folders` · `muted_tags`

**Corrections to the brief's list**, both found by reading the schema:

- **`deck_tags` was miscategorised as derived.** It is `(id, deck_id, name, color, created_at,
  updated_at)` — a label a person typed and coloured. It syncs.
- **`deck_undo` does not sync.** `deck_audit` is the record of what happened to a deck and belongs
  to it on every device; `deck_undo` is one editing session's state, and Ctrl+Z on a phone undoing
  a desktop action from an hour ago is a surprise, not a feature.

**`app_meta` is a mixed table and splits per key.** Synced: `card_zoom`, `list_view`,
`flatten_state`, `nav_collapsed`, `last_deck_format`, `deck_search_open`, marketplace,
printing-group-by. Local: `update_last_check_at`, `scryfall_penalty_until`, `update_latest_seen`,
`update_release_history`. That split is not cosmetic — **`update_release_history` alone is
124 435 bytes, 35% larger than the entire synced dataset.**

Everything else — `cards`, `sets`, the four tagger tables, the three combo tables,
`marketplace_prices`, `image_cache`, `sync_meta`, `card_migrations`, `format_specs`, `error_log` —
is derived or per-device and each device builds its own.

### 7.3 Conflict semantics

Ordering is by **hybrid logical clock** — physical millis, a logical counter, and the device id as
a deterministic tiebreak. No server clock, no coordination.

| Kind of data | Rule | Why |
| --- | --- | --- |
| `quantity`, `tradelist_quantity` | **counter — ops carry a delta** | Two devices each adding one copy must end at **+2**. A value would end at +1 and silently lose a card. An explicit "set to N" is a distinct op, resolved last-writer-wins. |
| scalar fields (condition, notes, price, names) | **last-writer-wins per field** | Per-field, not per-row: one device editing a note must not clobber another's price edit on the same row. |
| row existence | **add-wins** | A delete concurrent with an edit resurrects the row. Losing a collection entry is worse than keeping one the reader meant to remove. A tombstone strictly later than every edit does delete. |
| folder trees (`parent_id`) | **LWW, then cycle-break** | Concurrent moves can make A→B→A. On apply, a cycle is broken by returning the later-moved folder to root. |
| category assignment | **LWW per card** | |
| `deck_audit` | **union, append-only** | Cannot conflict by construction. |
| `deck_undo` | **not synced** | |

### 7.4 What the reader sees

Counters and per-field LWW resolve silently and correctly; surfacing them would be noise. **Two
outcomes are surfaced, and the schema already has the mechanism**: `needs_review TEXT` exists on
`collection_entries` and `deck_cards` and is documented as "a sentence here means the row needs
the user's attention". Reused rather than reinvented:

- a row edited on one device and deleted on another → resurrected, `needs_review` set
- a folder cycle broken → the folder lands at root, `needs_review` set

### 7.5 Pairing

No accounts, no server-side identity. Each device holds an X25519 keypair generated on first run.

1. Device A displays a QR code (with a typed short-code fallback) carrying a group id, its public
   key and a one-time pairing token.
2. Device B scans and completes an ECDH.
3. **Both devices display a six-digit code derived from the shared secret, and the reader confirms
   they match.** This is the step that defeats a man-in-the-middle at the relay, and it is not
   optional.
4. A wraps the group key to B's public key and sends it through the relay.

The group key never leaves the paired devices. Cloudflare sees ciphertext and routing metadata.

### 7.6 Unpairing and revocation

Removing a device rotates the group key; the remaining devices re-encrypt the compacted log under
the new key, and the removed device can read nothing further.

> **It cannot be un-told what it already knows.** A removed device still holds whatever it synced
> before removal, and no server can reach into it. A best-effort wipe op is honoured if that device
> connects before rotation — **that is a convenience, not a security guarantee**, and the UI must
> say so rather than implying a lost phone has been cleaned.

### 7.7 The relay

**One SQLite-backed Durable Object per pairing group. No R2, no KV.**

It holds a compacted op log — one row per change, latest-wins, **batched ~200 ops per stored
row** — and fans out to connected devices over hibernatable WebSockets. There is no separate
snapshot artifact, so the **2 MB per-row cap can never be hit** however large a collection grows;
a new device replays the compacted log. **Retention: compact on ack, keep a 30-day tail** of
superseded ops so a device that spent a fortnight in a drawer reconciles precisely instead of
replaying wholesale.

Free-tier limits **verified live 2026-08-27**: Workers 100 000 req/day, 10 ms CPU per invocation,
3 MB script. Durable Objects **are available on the free plan, SQLite-backed only** — 100 000
req/day, 13 000 GB-s/day, 5 GB storage, 5 M row reads/day, 100 000 rows written/day.

Sized against the measured data — full state **381.0 KB JSON → 44.7 KB gzipped**, average op
**453 bytes** on the wire:

| | Modelled (3 devices, 50 edits/day) | Free limit | Use |
| --- | --- | --- | --- |
| relay requests/day | ~100–150 | 100 000 | ~0.15% |
| compacted log | ~484 KB | 5 GB | 0.01% |
| rows written/day | ~50 | 100 000 | 0.05% |

**The one case that gets near a limit is a bulk import**: 50 000 rows one-op-per-row would spend
half a day's write budget. Batching ~200 ops per row makes it 250 writes. That batch size is
derived from the limit, not chosen for tidiness.

**KV is ruled out** of the hot path: 1 000 writes/day on the free plan.

> **Nothing is provisioned by an agent.** When a resource is needed, Markus is asked and Markus
> creates it.

## 8. Performance

**Desktop must not regress.** Every PR touching search, faceting or sync re-measures the table in
[data-and-sync.md](../../reference/data-and-sync.md) and shows both columns, with the build named.

**Faceting is not at risk and this is structural, not optimistic.** `facets::compute` (1.8 ms
unfiltered) reads an in-memory Rust structure of bitsets and ordinal arrays. It never touches
SQLite, so it ports as ordinary Rust with no VFS and no engine involved. Its behaviour — greying,
sink-not-hide ordering, the fail-open rule, `Skip` semantics including the `mana_x` overlay — is
unchanged on every platform.

**Web budget: no interaction over 250 ms at p95**, against the brief's 500 ms ceiling. Grounded in
what was measured in a browser: FTS `dragon` 3.0 ms, primary-key lookup 1.00 ms, `count(*)` over
117 464 rows 2.0 ms, a full scan of a 532 MB table 509 ms. **Android browser figures ran ~3.5×
desktop**, so the same budget holds there with margin.

**The collapsed browse is the one number not yet taken in wasm** — 131.8 ms end-to-end today. It
rides SQLite rather than the in-memory index, and porting it means bringing over `search.rs`'s
tuned shape (the `legal_mask` widening at 505 ms → 41 ms, the primary-key join at 108 ms against
2 486 ms for the obvious window function). **It is an implementation-PR gate**, measured there
rather than guessed here.

## 9. Verification

| Platform | How |
| --- | --- |
| Desktop | `scripts/cdp.mjs` against the Tauri window — [the existing contract](../../reference/live-ui-verification.md) |
| Web | headless Chrome over CDP against the dev server; the spike's `serve.mjs` + `drive.mjs` are the proven shape |
| Android | Chrome on a physical device over `adb reverse` + `adb forward localabstract:chrome_devtools_remote`, driven by CDP — **proven in the spike on a OnePlus 12** |

`adb reverse` makes the dev server `localhost` on the device, which is a **secure context**, so
OPFS and service workers work with no HTTPS setup. This needs `adb` only — no Android SDK, NDK or
Gradle, which belong to Phase 4.

`npm run verify` green before every commit, plus `cargo fmt` and `clippy` — the two reds a fully
green verify can still produce.

**A new toolchain requirement:** `sqlite-wasm-rs` compiles SQLite's C amalgamation with `cc`
targeting wasm32, and MSVC cannot emit wasm. **clang becomes a permanent CI requirement** the day
the web target ships.

## 10. PR sequence

**Phase 1 — three PRs, genuinely parallel** (different trees, no shared files):

1. `feat(core)`: the platform I/O traits — §4, native implementations only, desktop behaviour
   unchanged. Carries the combo push-parser rewrite and gzip sniffing. **The largest PR here.**
2. `refactor(ipc)`: Boundary A — §3, the interface plus the Tauri implementation.
3. `refactor(decks)`: `@dnd-kit/react` migration — §6.4, desktop-first, every shipped drag
   re-verified.

**Phase 2 — the web target:** 4. the wasm core build (browser I/O impls, the DB Worker, the
one-tab guard). 5. the PWA shell (manifest, service worker, update flow, the evicted-corpus state).

**Phase 3 — sync, which can run alongside Phase 2** — they share no files: 6. pairing (§7.5).
7. the relay and conflict engine (§7.3, §7.7).

**Phase 4 — Android:** 8. the Tauri mobile target. Needs the SDK and NDK installed.

**Phase 5 — mobile layout:** 9. after `frontend-design` options are approved.

Each phase gets its own implementation plan, written at its turn.

## 11. Open

- **Mana Pool.** This spec assumes Card Kingdom only on web. Asking Mana Pool to send one response
  header is the better fix and costs them nothing; nobody has asked.
- **The two tagger feeds in a browser** are unmeasured. Same JSONL shape as `default_cards` and 6×
  and 13× smaller, so download and parse are low-risk by inference; their **index build** is the
  genuine unknown, the art tagger being 140.4 MB of the corpus and index-heavy.
- **A mid-range Android phone.** Every Android figure here is a flagship and is an optimistic
  bound.
