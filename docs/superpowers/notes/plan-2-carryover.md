# Plan 2 Carryover Notes (2026-08-04)

Final whole-branch review: **approved with fixes — all applied and re-verified** (fix wave `e9db12f`).
Plan 2 range: `a94f890..e9db12f` (25 commits). Live smoke (dev) 7/7 PASS + packaged-build smoke PASS (prod CSP behaviorally proven).

## MUST-DO in Plan 3 (collection & wishlist)

1. **Write-during-sync policy — decide before the first task brief.** `do_sync` holds the write connection for the whole ~44 s ingest (one open transaction); Plan 3's entry editor must write. Recommended: **chunk the staging load** (release the mutex between batches) — also shrinks the ~1.9 GB transient WAL and lets the exit checkpoint stop being best-effort. Cheap fallback if deferred: bounded `lock_for` + honest "sync running, try again" toast.
2. **v3 migration bundle** (order matters; run the one-time compaction OUTSIDE `migrate()` — post-window with progress, or a Settings action; `migrate` runs pre-window and this would be minutes on a USB stick):
   a. `artist TEXT` column, backfill from `raw`, repoint `card.rs::ARTIST_SQL` (removes `raw`'s last runtime reader).
   b. Compress `raw` to gzip BLOB (~4:1; keeps local-backfill capability; ~460 MB saved).
   c. One-time `PRAGMA auto_vacuum=INCREMENTAL; VACUUM;` then **`create_fts` (make it `pub`) — mandatory** (VACUUM may renumber rowids; desynced external-content FTS returns wrong cards silently).
   d. `do_sync`: `PRAGMA incremental_vacuum` after `swap_staging` commits (measured 33 ms at scale-model; no temp file).
   Measured basis: db is 2.02 GB with a 998 MB freelist (structural 2× from the swap — plateaued, not a leak); live data 1,021 MB of which `raw` = 622 MB (61%). Projected steady state ≈ 560 MB.
3. **Single-flight map** in `images::Cache` (`Mutex<HashMap<ImageKey, Weak<Shared<...>>>>`) — prefetch/tile dedup; ledgered twice now.
4. **`--muted` real fix**: rename the app's dim-text token (42 `text-muted` sites) so shadcn's `--muted` surface mapping stops being a tripwire; warning comment in index.css marks the spot.
5. **CLAUDE.md image-cache section**: add the versionless-URI refusal rule, the `cards.scryfall.io` allowlist, and placeholder `no-store` (spec §5 has them; CLAUDE.md is what sessions read first).
6. **Host-allowlist observability**: one `eprintln!` on the off-host refuse branch in `resolve` (a Scryfall CDN move would currently render app-wide "No image" with zero signal).
7. `fetch_image`: add a content-length cap (now has a prod caller; error hosts can serve arbitrary bytes).
8. `image_status` re-fetch-on-improve (spec §5): the 8 `soon.jpg` + 162 artless printings should heal when Scryfall publishes art — versionless-URI refusal handles the poison; the improve-path needs the manifest or next bulk sync to update `image_uris`, which the swap does automatically. Verify after a real rotation.
9. Small folds while files are open: `SCHEMA_VERSION` const; `manaValues` dedupe; collector_number natural sort (collection table sorts on it); rarity gem AT-reachable pattern (pane's sr-only) wherever collection views repeat it; printings rows clickable (add-to-collection entry point); `store_failures` consumer; collapse the two bounded-lock helpers; `PRICES_AS_OF` genuinely shared; `useDismissOnEscape` doc: protocol does NOT generalize to two `inner` peers (only ordered layers).

## Escape-dismiss convention (binding for new layers)
`src/lib/useDismissOnEscape.ts`: innermost layer = `layer: "inner"` (capture + preventDefault); outer = `"outer"` (bubble + defaultPrevented check). Two inner peers are NOT ordered — nest deliberately or extend the hook first.

## Deferred to Plan 6
Set-picker/table polish already ledgered there; image-cache budget/eviction + "Clear cache" + "Compact database" buttons (Settings); `Printing`'s four unrendered fields; role=grid + roving tabindex for tables; overlay focus containment; Cinzel dead `.woff`.

## Accepted as-is (rulings recorded in the final review output, workspace deleted)
Motion-budget deviations (hover scale, flip fade, first-run pulse — all reduced-motion-safe; spec amended); first-run overlay covering the mana line (Plan 6 polish candidate); dev-only quirks; historical-migration coverage gaps verified against real data. **Two of these are gone as of 2026-08-14**: the overlay now draws the mana line itself rather than a bar of its own, which takes the first-run pulse with it.

## Perf/scale baselines (live, this machine)
- Packaged debug build boots clean, 0 CSP violations; injected `<style>` refused under prod CSP.
- Image serve: warm 3 ms (disk), cold 127 ms (CDN + pace); grid images ≈ 59.6 KB avg; full-library grid warm would be ~7 GB (lazy-only confirmed correct).
- 44.8 s forced full sync with live mana-line progress; search during sync works (db_read).
- db: 2.02 GB current (998 MB reusable freelist — see v3 bundle above).
