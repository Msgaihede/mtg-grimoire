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
> A CORS proxy would fix it and I am **not** proposing one: it means infrastructure we maintain
> sitting in the path of a feed, which is the thing decision 5 exists to avoid, and it would make
> a marketplace's availability depend on our uptime. Worth asking Mana Pool for the header
> instead — one response header, and it costs them nothing.

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
| Deck undo / audit log | ✅ | ✅ | ✅ |
| Deck tags | ✅ | ✅ | ✅ |
| Deck drag-and-drop | ✅ | 🟡 | 🟡 | 
| Custom deck cover image | ✅ | 🟡 | 🟡 |

**Drag-and-drop** is the one real UI risk. `pragmatic-drag-and-drop` is HTML5-DnD-based, which
has no touch implementation — a phone cannot drag a card into a category today. This is a design
task, not a port: see [mobile layout](#7-mobile-layout) and open question 4.

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
| Plain-text mirror | ✅ | ⛔ | ❓ | See below. |

**The golden fence survives, and gets simpler.** `src/features/transfer/__golden__/` exists
because `src-tauri/src/transfer/` is a second implementation of the TS writer, needed only
because the mirror is a Rust thread that cannot ask the page to render a file. **The mirror is
desktop-only**, so the Rust writer is desktop-only too — and the fence keeps doing exactly its
current job on that platform: one corpus, one golden set, both suites asserting byte equality.
Web and Android run the TS writer alone and inherit the same goldens. **Nothing about the fence
changes**; it simply guards one platform's second implementation instead of every platform's.

**The mirror on Android is genuinely open** — Android has a real filesystem and Tauri mobile can
write to scoped storage, so it is *possible*, but scoped storage is not a folder a reader browses
the way `D:\Decks\` is. Open question 3.

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
open, and that **touch drag-and-drop is the hard one**, since `pragmatic-drag-and-drop` has no
touch backend.

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

1. **The collapsed browse, unmeasured in wasm.** 131.8 ms end-to-end on desktop today. The
   spike proved FTS5 and storage but never ran the real browse SQL against the real corpus in a
   browser. Should I measure it before the spec is written, or accept it as an implementation-PR
   gate?
2. **Mana Pool on the web — accept the loss, or chase the header?** Measured and settled: it
   is blocked. The options are (a) Web offers Card Kingdom only, which is what this matrix
   assumes; (b) ask Mana Pool to send `Access-Control-Allow-Origin`; (c) proxy it, which I argue
   against above. Only (a) needs no one else's cooperation.
3. **The mirror on Android.** Possible via scoped storage, but scoped storage is not a folder a
   reader browses. Desktop-only, or Android too?
4. **Touch drag-and-drop.** Replace `pragmatic-drag-and-drop` with something touch-capable
   everywhere, add a touch-only sensor beside it, or design the phone deck editor so dragging is
   never the only way to do a thing?
5. **`deck_undo` and `deck_audit` — synced or local?** Your brief asks the question and this
   matrix assumes they are user data and sync. If undo history is per-device, say so: it changes
   the conflict rules, not just the table list.
