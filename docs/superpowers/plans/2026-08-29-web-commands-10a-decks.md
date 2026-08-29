# PR 10a — Decks on the web target: move the gate, route the reads

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Decks destination loads on the phone — the folder tree draws, the deck list draws,
and opening a deck shows its cards — by moving the wasm gate off ten modules and onto their
command wrappers, then adding read arms to `web::route`.

**Architecture:** The deck domain is already pure SQLite. Its `#[tauri::command]`s are thin
wrappers that `spawn_blocking` a function taking `&Connection`, and those functions have no
Tauri, no `tokio` and no filesystem in them. What keeps them off the web target is a gate on the
**module** rather than on the **commands** — `search.rs` already does it the other way round and
is the pattern to copy. So this PR moves gates and adds `match` arms; it writes almost no new
logic.

**Tech Stack:** Rust 1.96, `wasm32-unknown-unknown`, rusqlite, serde_json, `web::route`'s
synchronous dispatch.

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md)
§6.1, §6.3, and the **PR 10** row.
**Survey:** [`docs/reference/web-target.md`](../../reference/web-target.md) — *"One of six
destinations works"*.

---

## Global Constraints

- **The gate string is exactly `#[cfg(not(target_family = "wasm"))]`.** Not `target_arch`, not
  a feature. It is what every other gate in the crate says and what `lib.rs` reads.
- **Desktop and Android behaviour must not change.** Every command keeps its wrapper, its
  signature and its `spawn_blocking`. A reviewer should be able to confirm this by seeing that
  no wrapper body was edited.
- **`npm run verify` before every commit**, and `cargo fmt` + `cargo clippy` are **not** in it —
  CI runs both and they are the only reds a green verify can still give you.
- **The wasm gate is checked by CI at `.github/workflows/ci.yml:408`**:
  `cargo clippy --lib --locked --target wasm32-unknown-unknown -- -D warnings`. `-D warnings`
  means **an unused import is a red build**, and moving a gate strands imports constantly.
- **`data/` is never committed**, and no fixture may write to `cards` or `sync_meta`.
- Commit small, `feat:` / `fix:` / `chore:` / `test:`. Ship through the `auto-pr` skill. **The
  agent does not press Merge.**

---

## What was measured on 2026-08-29, and why this plan is shaped the way it is

Run before writing this plan, on `main` at PR #302. **Reproduce any of it by ungating a module
and running `cargo check --lib --target wasm32-unknown-unknown`.**

| | |
| --- | --- |
| `#[tauri::command]` in the crate | **155** |
| Routed in `web::route::COMMANDS` | **4** |
| Commands in the deck cluster | **48** (`deck` 20, `deck_meta` 20, `deck_theory` 4, `deck_undo` 3, `deck_audit` 1) |
| Errors when the whole domain is ungated at once | **93** |

**The gate is in the wrong place, and `search.rs` proves it.** `search.rs` is declared ungated in
`lib.rs:29` and carries `#[cfg(not(target_family = "wasm"))]` on each of its two commands
individually — which is why `run_search` is reachable from `web::route` and `deck_list`'s
`list_decks` is not. The deck cluster is gated at the module, so ~4 000 lines of pure SQLite are
absent from the web build for no reason of their own.

**`deck.rs` is already the right shape.** Its 4 444 lines of real code contain **no `tauri::`
reference before line 3992** — the commands are one contiguous block at the end, and everything
above it takes `&Connection`. `deck_list` is six lines wrapping `list_decks(&conn)`.

**`with_write` was built for this.** `src-tauri/src/sync.rs:531` is ungated and carries
`#[cfg_attr(target_family = "wasm", allow(dead_code))]` with a comment saying `Instant::now()`
panics on wasm *"so that arm exists before the first web write rather than after it."* The write
path was prepared for a port that had not happened yet.

**The 93 errors are not 93 problems.** They classify as:

| Count | Class | Work |
| --- | --- | --- |
| 44 | `cannot find module or crate 'tauri'` | Helpers outside command wrappers (`unfinished(e: tauri::Error)`, fns taking `AppHandle`). **Gate them.** Mechanical. |
| 9 | Excluded modules (`scryfall`, `paths`) | Call sites to gate, or a later PR. |
| ~26 | `tokio` / `image` / `zip` in `images.rs`, `update.rs`, `marketplace_feed.rs` | **Not this PR.** See below. |
| ~14 | `state.client` / `state.mirror` / trait and field errors | **Not this PR.** See below. |

**Four modules are a split, not a port, and none of them is in this PR.** `images.rs`,
`update.rs`, `marketplace_feed.rs` and `tags/mod.rs` each mix *downloading a thing* with
*reading the thing already downloaded*. The compiler names the seam precisely: on wasm
`AppState` **has no `client` field and no `mirror` field**, so every error in those modules is
the download half asking for a capability the web target does not have. `image_uri.rs` is the
worked precedent — it was carved out of `images.rs` when the search DTO needed it on web. Record
this; do not attempt it here.

**The frontend needs no changes at all.** `src/lib/ipc.ts` is a flat mirror calling
`invoke("deck_list", …)` through `@/lib/core`, and there is **no allowlist on the TS side**. The
Decks page already asks for these commands and already fails; the moment `web::route` answers,
the page works. This PR is Rust-only.

### The three seams inside the deck cluster

1. **Covers.** `deck.rs` calls `crate::images::{cover_file, write_cover, remove_cover,
   copy_cover, encode_cover_picked}`. Every one is reached through a `covers: Option<&Path>`
   parameter — already `Option`, already `None`-able. On web there is no cover directory, so
   `None` is the honest value and the call sites gate cleanly.
2. **`crate::marketplace::stored(conn)`**, used by `deck_meta.rs:433`'s `readback_marketplace`.
   A pure settings read. `marketplace.rs` only fails on wasm at line 133 (`state.mirror`), so
   `stored` itself is portable — Task 2 lifts it, it does not rewrite it.
3. **`crate::wishlist::add_wish(&tx, …)`**, used by `deck_missing_to_wishlist`. Pure SQLite, and
   `wishlist` is ungated in Task 1 anyway.

---

## File Structure

| File | Change |
| --- | --- |
| `src-tauri/src/lib.rs` | Remove the module gate from ten `pub mod` lines. No other change. |
| `src-tauri/src/collection.rs`, `collection_alloc.rs`, `collection_folders.rs` | Gate moves to commands; gate stranded imports. |
| `src-tauri/src/wishlist.rs`, `wishlist_folders.rs` | Same. |
| `src-tauri/src/deck.rs`, `deck_meta.rs`, `deck_theory.rs`, `deck_undo.rs`, `deck_audit.rs` | Same, plus the covers seam. |
| `src-tauri/src/marketplace.rs` | Gate the one `state.mirror` fn so `stored` is reachable. |
| `src-tauri/src/web/route.rs` | 14 read arms, 14 names in `COMMANDS`, tests. |
| `docs/reference/web-target.md` | Record what shipped and the four-module finding. |

---

## Tasks 1–2 — **DONE, and the split between them was wrong**

> **Shipped 2026-08-29.** Both tasks landed as one commit, because executing Task 1 disproved
> its own premise: **there are no leaf modules.** `collection` and `wishlist` import
> `deck_meta`, and `collection_alloc` calls into `deck` and `deck_audit` — the cluster is
> mutually recursive, so ungating "the five the deck cluster depends on" produced 24 errors
> pointing back at the deck cluster. The eleven modules move together or not at all.
>
> Two more things the plan did not predict, both recorded in
> [web-target.md](../../reference/web-target.md):
>
> - **`app_meta` had to be carved out of `update.rs` first.** `crate::update::get_app_meta` is
>   a settings read that eleven modules call, and it lived in the module that swaps an `.exe`.
>   A `pub use` re-export does not solve it — a name re-exported from a gated module is
>   invisible on wasm exactly when it is wanted — so all **61** call sites moved.
> - **`-D warnings` cost more than the gates did**: 22 `use` statements and 9 private helpers
>   needed attributes before the wasm clippy job went green.
>
> The measurement ladder was 93 errors → 19 → 13 → **0**, and desktop stayed at 1745 tests
> passing. The steps below are kept as written for the record.

## Task 1: The leaf modules compile for wasm

`collection`, `collection_alloc`, `collection_folders`, `wishlist`, `wishlist_folders` — the
five the deck cluster depends on. Nothing is routed yet; this task's whole deliverable is that
the **web build can see these functions**.

**Files:**
- Modify: `src-tauri/src/lib.rs` (five `pub mod` lines)
- Modify: `src-tauri/src/collection.rs`, `collection_alloc.rs`, `collection_folders.rs`,
  `wishlist.rs`, `wishlist_folders.rs`

**Interfaces:**
- Produces: `crate::collection::*`, `crate::wishlist::add_wish`, `crate::wishlist::WishInput`,
  `crate::collection_folders::*` reachable on `target_family = "wasm"`. Task 2 depends on this.

- [ ] **Step 1: Confirm the current state is red for the right reason**

```bash
cd src-tauri && cargo check --lib --target wasm32-unknown-unknown 2>&1 | tail -5
```

Expected: **clean.** These modules are gated out, so wasm compiles today. This step records the
baseline so a later failure is provably yours.

- [ ] **Step 2: Move the gate in the five module files**

For each `#[tauri::command]` in those five files, put `#[cfg(not(target_family = "wasm"))]`
directly above it, preserving indentation. Counts measured on 2026-08-29:
`collection.rs` 7, `collection_alloc.rs` 2, `collection_folders.rs` 8, `wishlist.rs` 6,
`wishlist_folders.rs` 8 — **31 commands.** If your count differs, the file changed; use the real
count and say so in the commit.

- [ ] **Step 3: Ungate the five modules in `lib.rs`**

Delete the `#[cfg(not(target_family = "wasm"))]` line directly above each of:

```rust
pub mod collection;
pub mod collection_alloc;
pub mod collection_folders;
pub mod wishlist;
pub mod wishlist_folders;
```

Move them **above** the `// ── Desktop and Android ──` comment, into the ungated block, so the
file's own headings stay true. That comment is documentation and this PR is what makes it wrong.

- [ ] **Step 4: Compile and fix what falls out**

```bash
cd src-tauri && cargo check --lib --target wasm32-unknown-unknown --message-format=short 2>&1 | grep -c "^src.*error"
```

Expected on the first run: a handful. The two shapes you will see, both measured:

- `unresolved import` / `cannot find module or crate 'tauri'` — a helper outside a command
  wrapper. Gate it too.
- `warning: unused import` — **this is a red build in CI** (`-D warnings`). Gate the import with
  the same attribute rather than deleting it; desktop still needs it.

Iterate to **0 errors and 0 warnings.**

- [ ] **Step 5: Prove the desktop build is untouched**

```bash
cd src-tauri && cargo check --lib 2>&1 | tail -3
```

Expected: clean. Then the real fence:

```bash
cd src-tauri && cargo test --lib collection 2>&1 | tail -5
```

Expected: PASS, with a **non-zero** selected-test count printed. A filter that matches nothing
exits 0 and proves nothing — report the number you saw.

- [ ] **Step 6: Mutation-check the gate**

Delete the `#[cfg(...)]` above **one** command in `collection.rs` and re-run Step 4. Expected:
RED, naming `tauri`. Restore it. **If it stays green, the module never got ungated in `lib.rs`
and every check above was vacuous — say so rather than continuing.**

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/collection.rs src-tauri/src/collection_alloc.rs src-tauri/src/collection_folders.rs src-tauri/src/wishlist.rs src-tauri/src/wishlist_folders.rs
git commit -m "refactor(web): the collection and wishlist modules compile for wasm"
```

---

## Task 2: The deck cluster compiles for wasm

**Files:**
- Modify: `src-tauri/src/lib.rs` (five more `pub mod` lines)
- Modify: `src-tauri/src/deck.rs`, `deck_meta.rs`, `deck_theory.rs`, `deck_undo.rs`,
  `deck_audit.rs`, `marketplace.rs`

**Interfaces:**
- Consumes: Task 1's ungated `collection` and `wishlist`.
- Produces: `crate::deck::{list_decks, deck_detail}`, `crate::deck_meta::*`,
  `crate::deck_theory::*`, `crate::deck_undo::*`, `crate::deck_audit::*` reachable on wasm.
  Task 3 routes them by these names.

- [ ] **Step 1: Move the gate in the five deck files**

Same operation as Task 1 Step 2. Measured counts: `deck.rs` 20, `deck_meta.rs` 20 (one already
carries the gate — leave it), `deck_theory.rs` 4, `deck_undo.rs` 3, `deck_audit.rs` 1.

- [ ] **Step 2: Gate the three `unfinished` helpers**

`deck.rs:3992`, `deck_meta.rs:1882`, `deck_theory.rs:760` each declare:

```rust
fn unfinished(e: tauri::Error) -> String {
```

These sit outside a command wrapper and take a Tauri type, so each needs its own
`#[cfg(not(target_family = "wasm"))]`.

- [ ] **Step 3: Ungate the five modules in `lib.rs`**, as in Task 1 Step 3.

- [ ] **Step 4: The covers seam**

`cargo check --target wasm32-unknown-unknown` will now name six `crate::images` call sites in
`deck.rs` (measured: lines 1999, 2048, 2049, 2370, 2382, 4070). Every one is reached through a
`covers: Option<&Path>` argument.

**Gate the call sites; do not stub `images`.** A stubbed `write_cover` that silently does
nothing is a cover that looks saved and is not — the failure this repo's `Option` was chosen to
avoid. On wasm the argument is `None` and the branch is unreachable, so gating says the true
thing: **the web target has no cover directory.**

Where a gate would leave a binding unused, gate that too rather than deleting it.

- [ ] **Step 5: The marketplace seam**

`deck_meta.rs:433`'s `readback_marketplace` calls `crate::marketplace::stored(conn)`. Ungate
`pub mod marketplace;` in `lib.rs`, gate its two commands, and gate the one function that reads
`state.mirror` (measured at `marketplace.rs:133`). `stored` itself is a pure settings read and
needs no change.

- [ ] **Step 6: Compile both targets to zero**

```bash
cd src-tauri && cargo check --lib --target wasm32-unknown-unknown --message-format=short 2>&1 | grep -c "^src.*error"
cd src-tauri && cargo clippy --lib --locked --target wasm32-unknown-unknown -- -D warnings 2>&1 | tail -3
cd src-tauri && cargo check --lib 2>&1 | tail -3
```

Expected: `0`, then clean, then clean. **The clippy line is the one CI runs** — a `cargo check`
that passes while clippy fails on an unused import is the red you will otherwise discover on the
PR.

- [ ] **Step 7: Prove the deck tests still pass on desktop**

```bash
cd src-tauri && cargo test --lib deck 2>&1 | tail -5
```

Expected: PASS. **Report the selected-test count.** The deck suite is large; a count in the
single digits means your filter is wrong, not that the suite is small.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src
git commit -m "refactor(web): the deck cluster compiles for wasm"
```

---

## Task 3: Route the reads, and the Decks page loads

**Files:**
- Modify: `src-tauri/src/web/route.rs`

**Interfaces:**
- Consumes: Tasks 1–2's ungated functions.
- Produces: `COMMANDS` containing 18 names.

**The fourteen read commands**, chosen because together they are what the Decks page and the
deck editor ask for before a reader touches anything:

```
deck_folder_list      deck_list             deck_get              category_for_name
deck_category_list    deck_tag_list         deck_tag_all          format_specs_list
deck_last_format      deck_search_open      deck_audit_list       deck_theory_slots
deck_theory_diff      deck_undo_state
```

- [ ] **Step 1: Write the failing test**

Add to `route.rs`'s test module. `state()` is the existing fixture helper.

```rust
#[test]
fn deck_list_answers_an_empty_list_before_a_deck_exists() {
    let s = state("web-route-deck-list");
    let out = call(&s, "deck_list", &json!({})).unwrap();
    assert_eq!(
        out.as_array().expect("deck_list answers an array").len(),
        0,
        "a database with no decks is a supported state, not an error"
    );
}

#[test]
fn deck_list_answers_a_deck_that_was_created() {
    let s = state("web-route-deck-created");
    {
        let conn = crate::sync::lock_db_read(&s);
        crate::deck::create_deck(
            &conn,
            &crate::deck::DeckInput {
                name: "Web Deck".into(),
                ..Default::default()
            },
        )
        .expect("the fixture's deck must be creatable");
    }
    let out = call(&s, "deck_list", &json!({})).unwrap();
    assert_eq!(out.as_array().unwrap().len(), 1);
    // camelCase, because the DTO is `rename_all = "camelCase"` and `src/lib/ipc.ts`
    // reads these exact keys. A snake_case answer here is a silent `undefined` on the page.
    assert_eq!(out[0]["name"], json!("Web Deck"));
}
```

**If `DeckInput` does not have that shape, use the real one** — read the struct rather than
forcing this snippet. The assertion that matters is the camelCase key, not the constructor.

- [ ] **Step 2: Run it and watch it fail for the right reason**

```bash
cd src-tauri && cargo test --lib web::route 2>&1 | tail -20
```

Expected: FAIL with `RouteError::Unknown("deck_list")` — **not** a compile error. A compile
error means Task 2 did not land.

- [ ] **Step 3: Add the arms**

Follow the existing shape exactly — `field(command, args, "name")?` for arguments,
`lock_db_read` for the connection, `.map_err(RouteError::Failed)?`, `encode(command, out)`.

```rust
"deck_list" => {
    let conn = crate::sync::lock_db_read(state);
    encode(command, crate::deck::list_decks(&conn).map_err(RouteError::Failed)?)
}

"deck_get" => {
    let id: i64 = field(command, args, "id")?;
    let variant: String = field(command, args, "variant")?;
    let marketplace: Option<String> = args
        .get("marketplace")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    // The wrapper converts BEFORE the pure call, and so must the arm: `get_deck` takes a
    // `Marketplace`, not the `Option<String>` the frontend sends.
    let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
    let conn = crate::sync::lock_db_read(state);
    encode(
        command,
        crate::deck::get_deck(&conn, id, &variant, marketplace).map_err(RouteError::Failed)?,
    )
}
```

**Verified 2026-08-29:** the pure functions are `list_decks(&conn)` at `deck.rs:2400` and
`get_deck(&conn, id, &variant, marketplace)` at `deck.rs:4157` — **not** `deck_detail`, which
does not exist. `DeckInput` derives `Default` and is `rename_all = "camelCase"`.

**Read each wrapper before writing its arm.** The wrapper is the specification: it names the
pure function, the argument names the frontend sends, and the order. Guessing an argument name
produces a `RouteError::Args` at runtime that looks exactly like a frontend bug.

- [ ] **Step 4: Add the names to `COMMANDS` and fix the two tests that encode the old limit**

```rust
pub const COMMANDS: &[&str] = &[
    "sync_status", "search_cards", "list_sets", "facet_cards",
    "deck_folder_list", "deck_list", "deck_get", "category_for_name",
    // ... the rest
];
```

Two existing tests now fail **by design**, and both are load-bearing:

1. `every_advertised_command_is_actually_routed` asserts `COMMANDS.len() == 4` with the message
   *"update this number when a command is added"*. Update it to 18.
2. `an_unknown_command_is_refused_by_name` uses **`deck_list`** as its example of an unknown
   command. It must now use a command that is genuinely unrouted. Use **`"mirror_rebuild"`**
   (verified 2026-08-29 in `mirror/settings.rs`) rather than `"deck_create"`: `mirror_rebuild` is
   one of the ten §6.3 names that are **permanently** desktop-only, so the test cannot rot the
   moment Task 4 lands. Say that in a comment — the next reader will otherwise "fix" it back.

- [ ] **Step 5: Run the tests**

```bash
cd src-tauri && cargo test --lib web::route 2>&1 | tail -10
```

Expected: PASS, and the printed count must be **larger** than before this task.

- [ ] **Step 6: Mutation-check two things**

1. Remove one name from `COMMANDS` while leaving its arm. Expected: the drift fence goes RED on
   the length assertion. Restore.
2. Change one arm's argument key (`"id"` → `"deck_id"`). Expected: RED with `RouteError::Args`.
   Restore.

**Report any that stayed green.** A fence that cannot fail is worse than no fence, and this repo
has shipped ten of those.

- [ ] **Step 7: `npm run verify`, then commit**

Redirect to a file and grep it — **`| tail` reports the pipe's exit code and a failing run reads
green.**

```bash
npm run verify > verify.log 2>&1; echo "exit=$?"; grep -E "Tests|failed|error" verify.log | tail -20
```

```bash
git add src-tauri/src/web/route.rs
git commit -m "feat(web): route the Decks read path"
```

---

## Task 4: Route the writes

The other 34 commands, so a deck can be edited on the phone. Same shape as Task 3, with one
difference that matters:

**Writes go through `crate::sync::with_write`, not `lock_db_read`.** It is ungated and was
prepared for this (`sync.rs:531`). Its wasm arm avoids `Instant::now()`, which **panics** on
`wasm32-unknown-unknown` — so a write arm that reaches for a timer instead will build green and
panic in the Worker, which surfaces as the page hanging with no console error.

- [ ] **Step 1** — Write a test that creates a deck through `call(&s, "deck_create", …)` and
      reads it back through `call(&s, "deck_list", …)`, asserting the round trip. Run it, watch
      it fail with `Unknown`.
- [ ] **Step 2** — Add the 34 arms, reading each wrapper for its argument names.
- [ ] **Step 3** — Extend `COMMANDS` to 52 and update the length assertion.
- [ ] **Step 4** — Mutation-check: make one write arm use `lock_db_read` instead of
      `with_write`. Expected: RED (a read connection cannot commit). Restore. **If it stays
      green the test never asserted the write landed** — fix the test, not the arm.
- [ ] **Step 5** — `npm run verify`, commit as `feat(web): route the Decks write path`.

---

## Task 5: Drive it on the phone

**Not optional, and not replaceable by the suite.** Every UI task in this project's Plans 2–3
found something the suite could not, and 9b's four layouts were falsified by the device.

- [ ] **Step 1: Build and serve**

```bash
node scripts/build-wasm.mjs
npx vite build
npx vite preview --host
```

**`--host` is required** — without it the PC gets 200 and the phone gets `000` through
`adb reverse`, which reads as a broken tunnel rather than a narrowly bound socket.

- [ ] **Step 2: Tunnel and attach**

```bash
adb reverse tcp:4173 tcp:4173
adb forward tcp:9333 localabstract:chrome_devtools_remote
```

**Close any stale tab first.** The one-tab guard renders *"MTG Grimoire is already open"* and
nothing else — correct behaviour, indistinguishable from a broken build. Close it by id from
`/json/list` so the reader's own tabs are left alone.

- [ ] **Step 3: Record what the destination does now**

Open Decks. Capture, in **one** eval each (a click and a read in the same eval answers about the
frame before React re-rendered):

- `document.body.innerText.includes("unknown command")` — expected `false`
- the folder tree's row count
- the deck list's row count
- `innerWidth` and `scrollWidth` together, in the same eval as any rect — the window can resize
  mid-pass and a wide desk reads exactly like an overflow

- [ ] **Step 4: Open a deck** and confirm its cards draw.

- [ ] **Step 5: Write the findings into `docs/reference/web-target.md`**

Replace the *"One of six destinations works"* table's Decks row with what you measured, and
**add the four-module finding** from this plan's measurement section — `images`, `update`,
`marketplace_feed` and `tags` are a split along the download/query seam, named by the compiler
through `AppState`'s missing `client` and `mirror` fields. That is the map for PRs 10b–10f and
it should not have to be re-derived.

- [ ] **Step 6: Commit and ship through `auto-pr`**

```bash
git add docs/reference/web-target.md
git commit -m "docs(web): the Decks destination, driven on the phone"
```

```powershell
.claude\skills\auto-pr\pr-auto.ps1 open
```

Then arm the watch with `Monitor`. **Do not press Merge.**

---

## Self-review notes for the executor

- **The gate move is mechanical and the seams are not.** If you find yourself writing logic in
  Tasks 1–2, stop: something is not the shape this plan measured, and that is worth reporting
  rather than working around.
- **`-D warnings` on the wasm clippy job means a stranded import is a red build.** Expect to gate
  imports, not delete them.
- **Do not touch `images.rs`, `update.rs`, `marketplace_feed.rs` or `tags/mod.rs`.** They are a
  later PR and a different kind of work.
- **Report every mutation that survived.** Six real defects in this project were found that way,
  two of them in code written minutes earlier.
