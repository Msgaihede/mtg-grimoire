# Feature parity across web, Android and desktop — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every feature the desktop app has works on the web target and on Android, or is
replaced there by the honest equivalent — no destination showing an error, no panel silently
missing.

**Architecture:** The download path's abstraction **already exists and is not a trait layer**:
`web::net` is the browser's HTTP, `feed::frame` is the gzip sniff and the push-shaped framer,
and each ingest is a `#[wasm_bindgen]` entry point in `web::glue` that `src/workers/db.ts`
calls. This plan finishes that seam rather than building a second one beside it. What genuinely
has no browser answer yet is **file writing** — the image cache, the mirror, import/export —
and each of those is a different mechanism rather than one `Fs` trait.

**Tech Stack:** Rust 1.96, `wasm32-unknown-unknown`, `reqwest` (wasm backend), `flate2`,
`web-sys` Cache Storage, `rusqlite`/OPFS.

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md)
§4 (Boundary B) and §6.2. **§4's framing findings are already implemented** — see below.
**Survey:** [`web-target.md`](../../reference/web-target.md).

---

## Global Constraints

- **The gate string is `#[cfg(not(target_family = "wasm"))]`**, and a module's side is decided
  by what is *in* it, not by where its commands are.
- **`SystemTime::now()` and `Instant::now()` panic on `wasm32-unknown-unknown`** rather than
  failing. Read the clock with `SELECT unixepoch()` off the connection. **This caught three
  modules in one day** (`tags`, `combos`, `marketplace_feed`); assume it will catch a fourth.
- **CI's wasm job is `cargo clippy --lib --locked --target wasm32-unknown-unknown -- -D warnings`**
  — an unused import is a red build, and moving a gate strands them by the dozen.
- **`npm run verify` before every commit**, and it runs neither `cargo fmt` nor `clippy`.
- Ship through `auto-pr`. **The agent does not press Merge.**

---

## What the survey found, 2026-08-31

Run against `main` after PR 10 (114 of 154 commands routed). **Ungating every remaining module
at once gives 79 errors in 8 files** — the whole outstanding surface, not per-command work.

| File | Errors | What it wants |
| --- | --- | --- |
| `images.rs` | **38** | `tokio` fs, the `image` crate, a filesystem cache |
| `scryfall.rs` | 16 | `tokio` streaming a download to `tmp/` |
| `update.rs` | 9 | `zip`, `tokio` |
| `mirror/watch.rs` | 8 | `state.mirror`, a thread |
| `mirror/settings.rs` | 3 | the mirror root |
| `picked.rs`, `paths.rs`, `export.rs` | 5 | `tauri` file handles, native paths |

By cause: **`tokio` 33, `tauri` 26**, `image`/`zip` 5, `state.mirror` 9.

### Three things that are already built, and must not be built again

**Spec §4 says the combo parser "has to be rewritten, not ported" and warns it fails silently.
That work is done.** `feed/frame.rs` carries:

- **`Decoder`** — sniffs the two gzip magic bytes and decides from the bytes, never a header,
  because `fetch` transparently decodes `Content-Encoding: gzip` and cannot opt out (§4.2).
- **`Elements`** — the push-shaped, brace-depth framer (§4.1).
- **`peak_buffer()`, and a test asserting `< 8 KiB`** — which is the specific guard §4.2's
  warning demanded, after the spike's first framer grew to 609.82 MB **without erroring**.

**`web::net` is the browser's `Http`** — `get`, `get_json`, and `response.bytes_stream()`.

**`web::glue` is the pattern for an ingest**: a `#[wasm_bindgen]` entry that fetches through
`net`, streams through `frame`, writes through a `StreamIngest`, and reports progress by calling
a JS function passed in. `ingest_cards` does exactly this and works.

**So `Http` and `Spawn` are effectively solved for the download path.** A parallel trait layer
would be a second answer to a settled question. `Fs` is the one that is genuinely missing, and
it splits into three unrelated mechanisms rather than one trait — Cache Storage for images, a
zip for the mirror, browser file inputs for import/export.

### The gap is narrower than the command count

`ingest_combos` **is already exported from wasm and has no TypeScript caller** — the export
exists, the wiring does not. That is the shape of most of what follows.

### Android has no engineering gap

The only things `#[cfg(desktop)]` keeps from Android are window sizing (the OS does it), the
mirror, and the updater. **Both of those are decided below and neither is a port.**

---

## The two decisions, taken 2026-08-31

**The mirror becomes an on-demand zip on web and Android.** The folder exists so *other
programs* can read it; OPFS and an Android private directory are invisible to every other
program, so a continuously-written folder there would be the feature's name without the
feature. A button that renders the same files and hands over one zip through the browser's
download or Android's share sheet gives the reader the files somewhere they can actually open
them. It is a snapshot rather than a live mirror, and that is the trade.

**Updates show the check and the notes, never a download.** `update_check` and `update_history`
are a GitHub releases fetch cached in `app_meta` and work anywhere. `update_download` and
`update_apply` swap an `.exe` and cannot exist in a browser or under the Play Store, so those
two buttons stay absent and the platform's own mechanism is named instead.

---

## Task 1: `combos_refresh` on the web — the pattern, proven end to end

The smallest possible instance of the whole plan: the wasm export **already exists**, so this
task is the TypeScript wiring and the command routing. It is first because if this shape is
wrong, every later task inherits the mistake.

**Files:**
- Modify: `src/workers/db.ts` (a message kind and its handler)
- Modify: `src/lib/core/browser.ts` (or wherever `ingestCards` is exposed — read it first)
- Modify: `src-tauri/src/web/route.rs` (route `combos_refresh` to the export's status half)
- Test: `src/workers/db.test.ts`, `src-tauri/src/web/route.rs`'s test module

**Interfaces:**
- Consumes: `web::glue::ingest_combos`, already exported.
- Produces: a TS path that a later task copies for tags and the marketplace feed.

- [ ] **Step 1: Read how `ingest_cards` is wired, end to end**

```bash
grep -n "ingest_cards" src/workers/db.ts src/lib/core/*.ts
grep -n -A25 "pub async fn ingest_combos" src-tauri/src/web/glue.rs
```

Expected: a `postMessage` kind in `db.ts`, a handler that calls `wasm.ingest_cards` and forwards
progress, and a `core` method the page calls. **Write down the three names before editing.**

- [ ] **Step 2: Write the failing test**

In `src/workers/db.test.ts`, alongside the existing ingest tests:

```ts
it("forwards a combo refresh to the wasm export and reports progress", async () => {
  const seen: number[] = [];
  // The fake wasm module the other tests in this file already use.
  wasm.ingest_combos = vi.fn(async (_url: string, onProgress: (n: number) => void) => {
    onProgress(10);
    onProgress(27_500);
    return JSON.stringify({ kind: "ok", result: { stored: 27_500 } });
  });

  await handle({ kind: "ingestCombos", descriptorUrl: "https://example.test/variants.json.gz" });

  expect(wasm.ingest_combos).toHaveBeenCalledOnce();
  expect(seen.at(-1)).toBe(27_500);
});
```

**Read the file's existing helpers first** — `handle`, `wasm` and the progress channel have
real names in it, and this snippet uses placeholders for whatever those are.

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run src/workers/db.test.ts
```

Expected: FAIL on an unknown message kind — **not** a module-resolution error.

- [ ] **Step 4: Wire it**, copying `ingest_cards`' path exactly.

- [ ] **Step 5: Route `combos_status` is already done; route nothing new here.**

`combos_refresh` is **not** routed as a command — it is a wasm export, like `ingest_cards`.
The Settings panel calls the core method. **Check that `CombosPanel` reaches the new path on
web and the `combos_refresh` IPC on desktop**, through the same seam `useUpdate` now uses.

- [ ] **Step 6: `npm run verify`, then drive it on the phone**

Build (`npm run build:wasm && npm run web:build`), serve with `vite preview --host`, tunnel
with `adb reverse tcp:4173 tcp:4173`, and press Refresh in Settings.

⚠️ **The service worker will serve the previous build and it reads exactly like a failed
port.** Clear `caches`, unregister the worker, reload — and check the `grimoire-shell-<id>`
cache name changed. If `unregister()` hangs, close the tab and open a fresh one.

- [ ] **Step 7: Commit** as `feat(web): the combo feed refreshes in a browser`.

---

## Task 2: the two tag feeds and the marketplace feed

Three more ingests, each the same shape as Task 1 and each already having its framer.

**Files:**
- Modify: `src-tauri/src/web/glue.rs` — three `#[wasm_bindgen]` entries
- Modify: `src-tauri/src/tags/mod.rs`, `marketplace_feed.rs` — a stream-shaped ingest beside
  the file-shaped one
- Modify: `src/workers/db.ts`, the core seam, `src/features/settings/*Panel.tsx`

- [ ] **Step 1** — For each feed, find where the desktop path turns bytes into rows and check
      whether that half is already stream-shaped. `tags::ingest_gz` takes a **path** today;
      spec §4.3 says it becomes "takes a stream of lines" and calls that a small change. Do
      that first, and keep the desktop caller passing a file-backed stream so nothing there
      moves.
- [ ] **Step 2** — Add the three exports, modelled on `ingest_cards`.
- [ ] **Step 3** — Wire the three TS paths.
- [ ] **Step 4** — **Mutation-check the framer's guard**: feed a 2 MB fixture whose braces never
      close and assert `peak_buffer()` stays under the cap and the ingest **errors**. The spike's
      failure was silence, not a wrong number.
- [ ] **Step 5** — Verify, drive on the phone, commit.

---

## Task 3: the image cache is Cache Storage on web

`images.rs` is 38 of the 79 errors and is the one module the spec calls a rewrite rather than a
port. **The service worker already caches images** (`grimoire-images`, and `src/pwa/sw.ts` has a
ledger) — so this task is not "port the byte cache", it is **make the two agree about who owns
the cache**.

- [ ] **Step 1** — Read `src/pwa/sw.ts` and `src/pwa/imageLedger.ts`. The web already has a
      working image cache with an eviction ledger; write down what it does *not* do that
      `images.rs` does.
- [ ] **Step 2** — `prefetch_images` and `prewarm_collection` are the two commands. On web they
      become a message to the service worker to warm a list of URLs. Neither returns bytes.
- [ ] **Step 3** — `image_uri.rs` is already every-target and resolves *which* picture a
      printing has, so nothing about resolution moves.
- [ ] **Step 4** — Verify, drive, commit.

---

## Task 4: `reset`, and the three clears that already work

- [ ] **Step 1** — Ungate `reset.rs`, gate its four commands. **Measured: only `cache_clear`
      fails**, on `crate::images`. `collection_clear`, `wishlist_clear` and `decks_clear` are
      pure SQLite and compile as they stand.
- [ ] **Step 2** — Route the three. `cache_clear` on web clears the `grimoire-images` Cache
      Storage bucket instead, which is Task 3's mechanism.
- [ ] **Step 3** — Verify, drive, commit.

---

## Task 5: import and export through the browser's own file dialogs

Spec §6.2 specifies `<input type=file>` and a `Blob` download. `import_resolve` and
`deck_import_commit` are **already routed** — only the two file handles are missing.

- [ ] **Step 1** — `import_read_file` on web is an `<input type=file>` whose text goes straight
      to the already-routed `import_resolve`. The Rust command is not routed at all; the *page*
      reads the file.
- [ ] **Step 2** — `export_write_file` on web is a `Blob` and an `<a download>`. Same shape.
- [ ] **Step 3** — On Android both already work through `picked.rs`'s `content://` seam. **Check
      this rather than assume it** — that seam exists for the dialog plugin's URIs.
- [ ] **Step 4** — Verify, drive, commit.

---

## Task 6: the mirror as an on-demand zip

**Decided 2026-08-31.** Web and Android get a button, not a folder.

- [ ] **Step 1** — `transfer/` already renders every file the mirror writes, and `mirror/watch`
      is the thread and the dirty map. **Only the renderer is wanted here**; check whether it
      can be called without the `Mask`.
- [ ] **Step 2** — A `zip` of the rendered files. `zip` is pure Rust and the survey shows it as
      one error, not a wall.
- [ ] **Step 3** — Web hands the blob to a download; Android to the share sheet.
- [ ] **Step 4** — `mirror_set_root`, `mirror_set_enabled` and `mirror_status` stay desktop-only
      and the panel says so on the other two, the way the Updates panel now does.
- [ ] **Step 5** — Verify, drive, commit.

---

## Task 7: the update check and the release notes, everywhere

- [ ] **Step 1** — `update_check` and `update_history` are a GitHub releases fetch cached in
      `app_meta`. `web::net::get_json` can do the fetch; `app_meta` is already every-target.
- [ ] **Step 2** — Route both. Leave `update_download`, `update_apply` and
      `update_open_release_page` desktop-only.
- [ ] **Step 3** — `UpdatePanel` on web draws the version, whether a newer one exists and the
      notes, and **names the platform's own mechanism** instead of a Download button: a PWA
      updates through its service worker, and the Play Store updates the Android build. This
      **reverses PR #315's `!isWebTarget()`**, which hid the whole panel — that was the right
      answer while nothing on it worked and is the wrong one once two of five commands do.
- [ ] **Step 4** — Verify, drive, commit.

---

## Task 8: the final tally, and the honest remainder

- [ ] **Step 1** — Re-run the census (`unrouted.py`'s shape: walk every `#[tauri::command]`,
      both attribute spellings, skip doc-comment mentions, diff against `COMMANDS`).
- [ ] **Step 2** — Update `web-target.md`'s table so every remaining command has a reason
      **above** it, and `src-tauri/CLAUDE.md`'s module map.
- [ ] **Step 3** — Drive all six destinations plus the card pane on the phone one more time,
      and record the pass.

---

## Self-review notes for the executor

- **Do not build an `Http` or `Spawn` trait.** `web::net` and the `glue` entry-point pattern
  already are that seam, and `feed::frame` already carries §4's three findings including the
  peak-buffer guard. A parallel layer is a second answer to a settled question.
- **A wasm export is not a routed command.** Downloads are `#[wasm_bindgen]` entries called from
  `db.ts`; `web::route` answers *queries*. Adding `combos_refresh` to `COMMANDS` would be the
  wrong seam.
- **Check the clock in anything you ungate.** Three modules have already had the
  `SystemTime::now()` trap and it panics rather than failing.
- **The service worker will serve your previous build.** Every device pass in this plan needs
  the cache cleared first, and the `grimoire-shell-<id>` name is how you know the reload took.
