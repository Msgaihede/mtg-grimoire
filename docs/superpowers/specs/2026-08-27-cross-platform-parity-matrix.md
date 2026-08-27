# Cross-platform parity matrix — every feature × three platforms

**Drafted 2026-08-27**, against the feature surface as it stands on `main` at `4350447`, and
against the measurements in
[the wasm-core spike](../research/2026-08-27-wasm-core-spike.md). **This needs sign-off before
anything is implemented against it.**

Legend: **✅ full** — same behaviour, same code. **🟡 adapted** — the feature exists and the
reader gets the outcome, by a different mechanism. **⛔ absent** — deliberately not on that
platform, with a reason. **❓ open** — needs a decision from you; collected at the end.

Platforms: **Desktop** (Tauri/Windows, today's app) · **Web** (Vite + wasm core, PWA) ·
**Android** (Tauri mobile, native Rust core + system webview).

> **Android is native, not wasm.** Tauri's mobile target compiles Rust for `aarch64-linux-android`
> and runs the UI in a system webview. So the whole wasm story — the OPFS VFS, no WAL, the
> one-connection ceiling, the push-parser rewrite — **applies to Web only**. Android gets
> desktop's `rusqlite` with `bundled`, a real filesystem, and `tokio`. Wherever this matrix says
> Android matches desktop, that is why.

## 1. Card data and search

| Feature | Desktop | Web | Android | Note |
| --- | --- | --- | --- | --- |
| Scryfall corpus, built on device | ✅ | ✅ | ✅ | Measured: 10.4 s web, 36.5 s phone-browser. Android native will be faster than the browser figure. |
| `cards.raw` column | ✅ | ⛔ | ⛔ | Decision 6. Costs those platforms a re-sync where desktop backfills in place. |
| FTS5 search | ✅ | ✅ | ✅ | `ENABLE_FTS5` confirmed in the wasm build. |
| Faceting (`CardIndex`) | ✅ | ✅ | ✅ | In-memory Rust bitsets, no VFS involved. Greying, sink-not-hide, fail-open and `Skip`/`mana_x` semantics all carry unchanged. |
| Tag search syntax | ✅ | ✅ | ✅ | Depends only on the tagger tables being present. |
| Printings, card detail, zoom | ✅ | ✅ | ✅ | |
| Collapsed / uncollapsed browse | ✅ | ❓ | ✅ | **Not yet measured on the real corpus in wasm.** See open question 1. |

## 2. Optional feeds

All four are opt-in on every platform, exactly as they are today: nothing downloads until the
reader asks. **The tier is therefore a per-database state, not a build-time platform decision** —
your ruling, and it is the behaviour the app already has.

| Feed | Desktop | Web | Android | Measured |
| --- | --- | --- | --- | --- |
| Oracle tags (5.85 MB) | ✅ | ✅ | ✅ | Unmeasured in browser; same JSONL shape as `default_cards`, 13× smaller. |
| Art tags (12.5 MB) | ✅ | ✅ | ✅ | Unmeasured in browser. Index build is the unknown — 140.4 MB of corpus, index-heavy. |
| Card Kingdom prices | ✅ | ✅ | ✅ | `access-control-allow-origin: *`. Verified in a browser: HTTP 200, `type=cors`, body readable. |
| **Mana Pool prices** | ✅ | **⛔** | ✅ | **Blocked by CORS.** See below. |
| Spellbook combos (27.5 MB / 639 MB) | ✅ | ✅ | ✅ | **12.6 s web, 23.1 s phone-browser**, 2.01 MB peak buffer. |

> ⛔ **Mana Pool cannot be reached from a browser, and this is the matrix's one unavoidable
> feature loss.** `https://manapool.com/api/v1/prices/singles` returns `200` with
> `Access-Control-Allow-Headers: sentry-trace, baggage` and **no `Access-Control-Allow-Origin`
> at all**, so a browser refuses to expose the response. Verified from a real page origin
> (`http://localhost:5204`), not inferred from headers: Card Kingdom returned `type=cors` with a
> readable 146 651-byte first chunk; Mana Pool threw `TypeError: Failed to fetch`.
>
> Android is unaffected — it is native Rust, not `fetch`. **On Web the marketplace picker must
> offer Card Kingdom only**, and a database synced from a desktop that had selected Mana Pool has
> to fall back rather than show blanks.
>
> **Decided 2026-08-27: disabled on web.** A Worker CORS proxy was costed (~10 lines, streaming,
> inside the free tier) and declined — it makes a marketplace depend on our uptime and re-serves
> another party's data through our account. So was a paired desktop pushing prices for referenced
> printings only (~363 rows / ~18 KB here, against ~99 502 for the whole feed). Card Kingdom only.

**Mobile-data prompt.** Your brief said an unprompted 27.5 MB download on a phone plan is wrong
and the fix is a prompt. Proposed: on Web and Android, any feed over 5 MB shows its **measured**
size and, where `navigator.connection` reports a metered or cellular link, says so and defaults
the button to "Not now". Desktop is unchanged. The numbers in that prompt come from the feed's
own `compressed_size`, never a hardcoded constant.

## 3. Collection, wishlist, decks

Everything here is user data over local SQLite, and none of it touches a platform API.

| Feature | Desktop | Web | Android |
| --- | --- | --- | --- |
| Collection entries, 11-term grain, provenance | ✅ | ✅ | ✅ |
| Collection folders (the cabinet), deck groups, `Recently removed` | ✅ | ✅ | ✅ |
| Wishlist entries + folders | ✅ | ✅ | ✅ |
| Deck editor, categories, validation, formats | ✅ | ✅ | ✅ |
| Commander brackets (4 signals) | ✅ | ✅ | ✅ |
| Deck audit log | ✅ | ✅ | ✅ |
| Deck undo | ✅ | ✅ | ✅ | 
| Deck tags | ✅ | ✅ | ✅ |
| Deck drag-and-drop | ✅ | ✅ | ✅ | 
| Custom deck cover image | ✅ | 🟡 | 🟡 |

### Drag-and-drop moves to `@dnd-kit/react` on every platform — decided

`@atlaskit/pragmatic-drag-and-drop` is built on native HTML5 drag-and-drop, which **has no touch
implementation at all**: a phone cannot drag a card into a category, and no version of that
library will change it. Measured on 2026-08-27, the replacement field is thin:

| Library | Latest | Published | Weekly | Touch |
| --- | --- | --- | --- | --- |
| `@atlaskit/pragmatic-drag-and-drop` (today) | 3.0.0 | 2026-08-14 | 1.29 M | ❌ |
| `@dnd-kit/core` | 6.3.1 | **2024-12-05** | 24.4 M | ✅ |
| **`@dnd-kit/react`** | **0.5.0** | 2026-06-11 | 1.2 M | ✅ |
| `sortablejs` | 1.15.7 | 2026-02-11 | 4.4 M | ✅ |

**`@dnd-kit/react` 0.5.0**, chosen with the trade understood: `@dnd-kit/core` has the proven API
and the download count but has not shipped in 21 months, and adopting a frozen library onto React
19 buys a migration that has to happen again. The successor has explicit React 19 support and
active development.

**It is pre-1.0, so it gets treated as such.** Pin the exact version — no caret. The migration is
its own PR, done desktop-first, and **every shipped drag is re-verified before touch is added**:
repo memory records that a second drop-target registration on one element silently replaces the
first, so "the new drop works" is never evidence that the old one still does.

> **One upside worth stating, because it is not obvious.** HTML5 DnD cannot be driven
> synthetically — Chrome refuses to begin a native drag from an untrusted event — which is why
> the deck editor's drags are **unverifiable in the live window today**. `@dnd-kit/react` is
> pointer-event based, and pointer events *can* be dispatched over CDP. This migration converts
> the app's least-testable interaction into a testable one, on every platform including desktop.

**Deck cover** needs a file picked and re-encoded to WEBP at 626×457. Web: `<input type="file">`
plus the same `image` crate compiled to wasm. Android: Tauri's dialog plugin. Same outcome, three
mechanisms.

## 4. Import and export

| Feature | Desktop | Web | Android | Note |
| --- | --- | --- | --- | --- |
| Import — 7 formats, 4 destinations | ✅ | 🟡 | 🟡 | Web reads via `<input type="file">` rather than a path; the parser is TS and unchanged. |
| Export — 7 formats, field registry, fold rule | ✅ | 🟡 | 🟡 | Web writes via a `Blob` download or the File System Access API. |
| Export to clipboard | ✅ | ✅ | ✅ | `navigator.clipboard.writeText` on web. |
| **The golden fence** | ✅ | ✅ | ✅ | See below. |
| Plain-text mirror | ✅ | ⛔ | ⛔ | **Desktop-only** — decided. See below. |

**The golden fence survives, and gets simpler.** `src/features/transfer/__golden__/` exists
because `src-tauri/src/transfer/` is a second implementation of the TS writer, needed only
because the mirror is a Rust thread that cannot ask the page to render a file. **The mirror is
desktop-only**, so the Rust writer is desktop-only too — and the fence keeps doing exactly its
current job on that platform: one corpus, one golden set, both suites asserting byte equality.
Web and Android run the TS writer alone and inherit the same goldens. **Nothing about the fence
changes**; it simply guards one platform's second implementation instead of every platform's.

**The mirror is desktop-only on all three platforms — decided.** Android has a real filesystem
and Tauri mobile can write to scoped storage, so it is *possible*. It is not built, because the
mirror's whole point is a folder a reader opens in a text editor, syncs with Dropbox or greps,
and on Android that directory is reachable mainly through a file-manager app and often not by
other apps at all. The feature would exist without delivering what it is for.

**This is what keeps the golden fence simple.** The Rust writer exists only to serve the mirror,
so it compiles on exactly one platform, and `__golden__/` goes on guarding exactly one second
implementation.

## 5. Platform services

The fifteen frontend files that name a Tauri API today, and what each becomes.

| Seam | Desktop | Web | Android |
| --- | --- | --- | --- |
| `src/lib/ipc.ts` — all 136 commands | Tauri `invoke` | wasm-core call into the DB Worker | Tauri `invoke` |
| `plugin-dialog` (4 components) | native picker | `<input type=file>` / FS Access API | Tauri mobile dialog |
| `plugin-clipboard-manager` | Tauri | `navigator.clipboard` | Tauri |
| `plugin-opener` | Tauri | `window.open` | Tauri |
| `api/window` + `TitleBar` + snap layouts | custom caption, Win32 hit-test | ⛔ — the browser owns the frame | ⛔ — the OS owns the frame |
| `api/event` (sync/tag/combo progress) | Tauri events | `postMessage` from the Worker | Tauri events |
| `mtgimg://` protocol (`src/lib/images.ts`) | custom protocol | Cache Storage + blob URLs | Tauri asset protocol |

**The 136 commands are one file.** `src/lib/ipc.ts` is the only place the frontend names a
command, which makes boundary 2a a genuinely small PR: one interface, three implementations
behind it, and no call site changes.

## 6. Images, storage and updates

| Feature | Desktop | Web | Android |
| --- | --- | --- | --- |
| Image cache | uncapped (519 MB / 7 929 files live) | 🟡 **256 MB LRU** | 🟡 **256 MB LRU** |
| Corpus storage | file on disk | OPFS via `opfs-sahpool` | file on disk |
| WAL journal | ✅ | ⛔ rollback journal only | ✅ |
| Two windows / tabs at once | ✅ | ⛔ **first tab wins** | ✅ |
| Updates | hand-written portable exe swap | service worker | Play Store |

**The image cache cap, with the number you asked for: 256 MB, LRU, reader-adjustable up to 1 GB.**
The live cache is 519 MB over 7 929 files — **~65 KB per image** at browsed sizes. 256 MB is
therefore ~3 900 cards: a 1 000-card collection browsed as a grid costs ~65 MB and a 100-card
deck ~6.5 MB, so the cap holds several full sessions before evicting anything. It also keeps the
whole web footprint under 1 GB against a Tier A corpus of 526 MB, which is a defensible ceiling
for something a browser can evict. All 116 703 printings would be ~7 GB and is never the target.

**Two tabs: first one wins, and the second says so** — your ruling. The second document detects
the held access handles and renders "MTG Grimoire is already open in another tab", with a Reload
button. Not a silent failure and not a fight over the database.

**The web update flow, because "just reload" is not an answer.** Service worker registers, a new
build installs as the waiting worker, the app shows a non-modal "A new version is ready" bar,
the reader presses it, `skipWaiting` + `clients.claim` run, the page reloads once. **Two storage
systems, two eviction policies:** the shell lives in Cache Storage and the corpus in OPFS, so
"shell loaded, corpus gone" is a real state — on boot the app checks the corpus is openable and
offers a rebuild rather than assuming. `navigator.storage.persist()` is requested once the corpus
is built, and **its answer is not trusted as a guarantee**.

> The service worker does **not** need to re-attach COOP/COEP headers. Cross-origin isolation is
> not required at all — measured both ways. That whole class of second-load bug is designed out.

## 7. Mobile layout

Not a media-query exercise, and not settled here. The four things that need a phone answer are
the ribbon, `CardGrid`, the deck editor's drags, and the filter bar. **Options come to you before
anything is built**, via the `frontend-design` skill — this matrix only records that they are
open. The drag question that used to sit here is settled in §3: `@dnd-kit/react` gives every
platform a touch-capable drag, so the phone layout question is about *shape*, not capability.

## 8. Deliberately absent, with reasons

| Not built | Why |
| --- | --- |
| iOS, including "just install the PWA" | Your non-goal. Safari evicts after ~7 days of non-use, and a 526 MB corpus is the worst case for that. |
| Accounts, signup, email, password, OAuth | Your non-goal. Pairing only. |
| Multi-user, sharing, social | Your non-goal. |
| Server-side card search, hosted corpus or images | Decision 5. Cloudflare only ever relays encrypted user data. |
| Card Trader | Per-user JWT, no bulk download. |
| `cards.raw` on Web/Android | Decision 6. |
| Window chrome on Web/Android | The browser and the OS own the frame. |
| Plain-text mirror on Web | No filesystem a browser can write the way the mirror needs. |

## 9. Open questions — I need answers to these

1. ~~The collapsed browse~~ — **settled: an implementation-PR gate.** 131.8 ms end-to-end on
   desktop today, unmeasured in wasm. Porting it properly means bringing over `search.rs`'s tuned
   query shape (the `legal_mask` widening at 505 ms → 41 ms, the primary-key join at 108 ms
   against 2 486 ms), which is implementation work rather than spike work. Every PR touching
   search carries a measurement anyway. Supporting evidence that it will be fine: FTS5 answered
   in 3.0 ms, a primary-key lookup in 1.00 ms, and a full scan of a 532 MB table in 509 ms.
2. ~~Mana Pool on the web~~ — **settled: disabled on web.** No alternate endpoint exists
   (`api.manapool.com` does not resolve; `OPTIONS` answers 405). A Worker CORS proxy and a
   desktop-shares-prices-for-your-own-cards path were both costed and declined. Card Kingdom only.
3. ~~The mirror on Android~~ — **settled: desktop-only.** See §4.
4. ~~Touch drag-and-drop~~ — **settled: `@dnd-kit/react` 0.5.0 on every platform.** See §3.
5. ~~`deck_undo` and `deck_audit`~~ — **settled: the audit log syncs, undo stays per-device.**
   They answer different questions. `deck_audit` is the record of what happened to a deck, which
   belongs to the deck on every device. `deck_undo` is the state of one editing session — Ctrl+Z
   on a phone undoing something done on a desktop an hour ago is a surprise rather than a
   feature, and it would make undo a distributed-consensus problem for no gain.

   **The synced set is therefore 12 tables** — the same count as the brief's list but not the
   same list, since `deck_tags` joins as `deck_undo` leaves. That is `collection_entries`, `collection_folders`, `decks`, `deck_cards`,
   `deck_categories`, `deck_folders`, `deck_allocations`, `deck_audit`, `deck_tags`,
   `wishlist_entries`, `wishlist_folders`, `muted_tags`, and the preference subset of `app_meta`.
