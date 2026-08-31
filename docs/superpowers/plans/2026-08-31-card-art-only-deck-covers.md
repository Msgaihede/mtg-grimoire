# Card-art-only deck covers — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans`. Steps use `- [ ]` so progress is trackable.

**Goal:** Remove the custom (reader-picked file) deck cover entirely. A cover becomes one thing —
`cover_card_id`, the art crop of a card — which is a short string that already syncs, works
identically on desktop, web and Android, and needs no encoder, no directory and no URL scheme.

**Architecture:** A deletion, not a feature. `decks` already carries `cover_kind`
(`card_art` | `custom`), `cover_card_id` and `cover_image_path`. We drop the `custom` half and
everything that served it, flip every `custom` row to `card_art` in a migration, and retire
`cover_image_path` in two phases so the sync wire does not change.

**Tech stack:** Rust (rusqlite, Tauri commands), React 19 + TS, SQLite migrations.

**Spec:** none — this supersedes the custom-cover half of
`docs/superpowers/specs/2026-08-04-mtg-collection-tracker-design.md`.

---

## Why this is a deletion rather than a port

Recorded here because it is the argument, and because a future reader will otherwise try to
add the feature back on the web target.

1. **It already does not survive sync.** `cover_kind`, `cover_card_id` **and
   `cover_image_path`** are all synced fields on `decks`
   (`sync_engine/capture.rs`, the `decks` `Spec`). `cover_image_path` is stored **absolute** —
   `deck.rs`'s own doc says "stored **absolute**, as the path actually written". So a custom
   cover today syncs a `D:\…\covers\7.webp` to a phone.
2. **And every receiving device already draws the card art.** `images.rs`'s `serve_cover`
   flattens "no covers directory" and "no file" into one answer, deliberately: *"there is no
   cover, and the deck draws its card art."* So card-art-only is already what every device
   except the one that set it shows. This change makes the existing behaviour the only one.
3. **The fallback is already populated.** Setting a custom cover "leaves the card id alone"
   (`deck.rs`), so a deck with a custom cover almost always still carries a `cover_card_id`.
4. **It removes the `clear_decks` → `covers` → `sweep_dir` recursive delete**, which is the code
   path that destroyed a working tree during the 2026-08-31 session when a mutation made
   `covers` resolve to the cargo test working directory.

**The one loss, to be stated in the changelog and not glossed:** a reader who set a custom cover
on a single device loses that picture. A deck with `cover_kind = 'custom'` and a **NULL**
`cover_card_id` falls back to the no-cover placeholder, which is an already-supported state.

## Global constraints

- **`cover_image_path` is NOT removed from `sync_engine/capture.rs`'s `decks` `Spec` in this
  work** — but ⚠️ **the reason given here was wrong, and it was checked rather than assumed.**

  This plan originally said there was "no documented rule for changing a `Spec`'s field list and
  no unknown-field handling in `apply/`", making removal an unbudgeted wire risk. **That is
  false.** `apply::updates` (`apply.rs:1011`) and `apply::creations` (`:1047`) both iterate
  **`spec.fields` — the *local* spec** — and look each one up with `combined.fields.get(*f)`.
  So a field an incoming op carries that the local spec does not name is never looked up and is
  silently ignored, and a field the local spec names that the op does not carry is skipped by
  the same `get`. `merge::fold` folds a `BTreeMap` with no spec reference at all. **Removing a
  `Spec` field is therefore safe in both directions.**

  The field stays anyway, for a smaller reason than the one first given: nothing reads the
  column, so leaving it on the wire costs one stale value that is never written again, and that
  is not worth a second change to the sync surface in the same week the relay work is moving.
  **What was genuinely missing is that none of this is written down anywhere** — the only census
  fence, `capture::tests::every_column_a_spec_names_exists_on_its_table`, runs one direction
  (spec ⊆ table) and would not have caught a removal either way. The comment at the Spec entry
  records the finding.
- **`sweep_dir` in `reset.rs` STAYS.** `clear_cache` uses it for `data/images/` and `data/tmp/`.
  Only the `covers` *call site* and the `covers` parameter go.
- **Never mutation-test anything that deletes a file or directory.** See the note above; this is
  the same area.
- `cargo clippy --lib --locked --target wasm32-unknown-unknown -- -D warnings` is a CI gate: an
  unused import or a now-dead helper is a red build.
- Do not run `npm run verify` inside a task — the controller runs it once at fan-in. Two
  concurrent runs fake ~18 Rust schema failures across worktrees.

---

## Task 1 — the Rust deletion

**Owns (no other task may touch these):** `src-tauri/src/images.rs`, `paths.rs`, `picked.rs`,
`deck.rs`, `deck_audit.rs`, `deck_undo.rs`, `reset.rs`, `desktop.rs`, `export.rs`, `import.rs`,
`mirror/watch.rs`, `web/route.rs`, `lib.rs`.

**Interfaces produced:** `DecksCleared` loses its `covers` field; `clear_decks` loses its
`covers` parameter; `ipc.deckSetCoverImage` ceases to exist (Task 3 consumes that fact).

- [ ] **Step 1: inventory before deleting.** `grep -rn` each of `cover_image_path`,
      `encode_cover`, `encode_cover_picked`, `encode_cover_from`, `covers_dir`, `cover_file`,
      `write_cover`, `serve_cover`, `COVER_ROUTE`, `COVER_VARIANT`, `parse_cover_path`,
      `MAX_COVER_SOURCE_PIXELS`, `set_cover_image`, `deck_set_cover_image`. Write the list down.
      There were **106 occurrences across 14 files** when this plan was written.
- [ ] **Step 2: delete the image half.** In `images.rs`: `encode_cover`, `encode_cover_picked`,
      `encode_cover_from`, `write_cover`, `cover_file`, `serve_cover`, `parse_cover_path`,
      `COVER_ROUTE`, `MAX_COVER_SOURCE_PIXELS`, and the `/cover/` branch of the protocol router.
      **`COVER_VARIANT` may be load-bearing elsewhere — check before removing it.** Remove
      `covers_dir` from `paths.rs`, and the third bullet from `picked.rs`'s module doc (it lists
      the three commands that funnel through it; only two remain).
- [ ] **Step 3: delete the deck half.** In `deck.rs`: the `deck_set_cover_image` command,
      `set_cover_image`, and every write to `cover_image_path`. **`cover_kind` stays** and is
      now always `card_art`; **`cover_card_id` stays and is the whole feature.** Check
      `duplicate_deck` (it copies the cover file) and `deck_delete` (it removes one).
- [ ] **Step 4: `reset.rs`.** Drop `clear_decks`'s `covers` parameter, the `sweep_dir(covers)`
      call, and `DecksCleared::covers`. Update the module doc — it currently says the clear
      "never touches `data/covers/`", which stops meaning anything. **Do not touch
      `clear_cache`'s two `sweep_dir` calls.**
- [ ] **Step 5: unregister.** Remove `deck_set_cover_image` from `lib.rs`'s `invoke_handler` and
      from `web/route.rs`'s comments if it is named there. `COMMANDS` does not contain it, so the
      census drops from 157 commands / 37 unrouted to **156 / 36** — re-derive with
      `node scripts/routed-census.mjs` rather than trusting this sentence.
- [ ] **Step 6: tests.** Delete the tests for what is gone; keep and extend the ones for
      `cover_card_id`. Add one asserting a deck whose `cover_kind` was `custom` reads `card_art`
      after the migration (coordinate with Task 2 — the migration is theirs, the assertion may
      live either side, so say in your report which you did).
- [ ] **Step 7:** `cargo test --lib` and both clippy targets. **Report the number of tests
      selected**, not just that they passed.

## Task 2 — the migration and the sync note

**Owns:** `src-tauri/src/schema.rs`, `src-tauri/src/sync_engine/capture.rs`.

- [ ] **Step 1:** Add the next migration rung: `UPDATE decks SET cover_kind = 'card_art' WHERE
      cover_kind = 'custom'`. Do **not** drop the `cover_image_path` column (see constraints).
      Follow the rung style already in the file, and read
      `docs/reference/data-and-sync.md`'s schema ladder first.
- [ ] **Step 2:** At `capture.rs`'s `decks` `Spec`, leave `cover_image_path` in the field list
      and add a comment: it is retired, never written after this rung, and stays on the wire
      until a later rung drops it, because removing a field from a `Spec` has no documented
      forward-compatibility rule.
- [ ] **Step 3:** A test that drives the rung on a database holding a `custom` row and asserts it
      reads `card_art` after. **Prove the migration on a real upgrade path, not a fresh
      install** — a fresh worktree database is created at the newest rung and can never show an
      upgrade bug.
- [ ] **Step 4:** `cargo test --lib schema::` — report the selected count.

## Task 3 — the frontend

**Owns:** `src/lib/ipc.ts`, `src/features/decks/DeckSettingsDialog.tsx`,
`src/features/decks/CreateDeckDialog.tsx`, `src/features/decks/DeckTile.tsx`, and the
`DeckCoverPicker` component, plus their tests and stories.

- [ ] **Step 1:** Remove `ipc.deckSetCoverImage` and the `coverImagePath` field from the
      `DeckRow` mirror. **`coverCardId` and `coverKind` stay.**
- [ ] **Step 2:** `DeckCoverPicker` answers `onPickCard` and `onPickFile` today — remove
      `onPickFile` and every control that reaches it. **The card grid stays and is now the whole
      picker.** `DeckSettingsDialog`'s module doc has a paragraph beginning "Two commands set a
      cover and they are not interchangeable" — it describes exactly what is being deleted and
      must be rewritten, not left.
- [ ] **Step 3:** `DeckTile` must stop branching on `coverKind === "custom"`.
- [ ] **Step 4:** Update tests and stories. Storybook's fake may seed a `custom` cover — check
      `.storybook/fake/`. **Do not commit; report what you changed** (story plays are the
      controller's fix round).
- [ ] **Step 5:** `npx vitest run src/features/decks src/lib/ipc.test.ts` and `tsc`. Report
      counts.

## Task 4 — the record (runs AFTER 1–3 land)

**Owns:** `docs/reference/decks-storage.md`, `image-cache.md`, `android-target.md`,
`web-target.md`, `frontend-design.md`, `decks-live-findings.md`, `CHANGELOG.md`,
`src-tauri/CLAUDE.md`.

- [ ] **Step 1:** Rewrite each passage describing custom covers. `image-cache.md` documents the
      `/cover/` route, which no longer exists. `web-target.md`'s "37" table loses
      `deck_set_cover_image` — **re-derive the counts with `node scripts/routed-census.mjs`;
      do not hand-count, that table has rotted three times.**
- [ ] **Step 2:** `CHANGELOG.md` states the loss plainly: custom cover pictures are gone, decks
      fall back to card art, and a deck that had no cover card shows the placeholder.
- [ ] **Step 3:** Re-count every list or number touched in the same commit.

---

## Self-review notes

- **Spec coverage:** the four "why" arguments each map to a task — (1) and (2) to Task 2's Spec
  comment, (3) to Task 1 Step 3, (4) to Task 1 Step 4.
- **The `COVER_VARIANT` question is deliberately left open** in Task 1 Step 2 rather than
  guessed: it is `Variant::Art`, which the card-art path may well still use.
- **Ordering:** 1, 2 and 3 are file-disjoint and run in parallel; 4 runs after so it describes
  what happened rather than what was intended.
