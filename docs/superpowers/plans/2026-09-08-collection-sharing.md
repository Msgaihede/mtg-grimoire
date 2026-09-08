# Shared collections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reader with a Patreon membership can publish a collection folder as a permanent
read-only web link, and anyone can open that link — in a browser, or inside their own Grimoire,
where it is cross-referenced against their collection and wishlist.

**Architecture:** One JSON format (`ShareSnapshot`) with three implementations — a Rust writer
that reads the folder subtree and uploads it, a new Cloudflare Worker that stores it in D1 + R2
and serves it publicly, and two TypeScript readers (a standalone web bundle and a view inside the
app). A committed golden snapshot is the fence that keeps the three from drifting.

**Tech Stack:** Rust (rusqlite, serde, flate2, reqwest), Cloudflare Workers (D1, R2, static
assets), React 19 + TypeScript 6, Vite, Vitest.

**Spec:** [`docs/superpowers/specs/2026-09-08-collection-sharing-design.md`](../specs/2026-09-08-collection-sharing-design.md)
— read it before Task 1. The plan argues from it, and §4 in particular is the reason Task 1 does
not reuse `collection::list_entries`.

**Issue:** [#360](https://github.com/Msgaihede/mtg-grimoire/issues/360). The PR body must carry
`Closes #360`.

---

## Global Constraints

Copied from the spec and from the repo's own rules. Every task's requirements implicitly include
this section.

- **Six fields are absent from `ShareSnapshot` and must never be added**: `purchase_price`,
  `purchase_currency`, `acquired_at`, `acquisition_source`, `notes`, `tags`. Absent, not
  optional — an optional field is one a future switch can turn on by accident.
- **A share never includes a locked folder, a folder with a locked ancestor, or a folder whose
  `kind <> 'user'`.** `collection_folders.locked` is non-zero-means-locked (`!= 0`, so a
  hand-edited `2` is locked).
- **Never reuse `collection::list_entries` for a snapshot.** `folder_id = ?` is direct members
  only and `exclude_locked` is skipped whenever `folder_id` is set. Spec §4.
- **`RELAY_HMAC_KEY`, `PATREON_CLIENT_SECRET` and `PATREON_WEBHOOK_SECRET` are never committed**,
  and no `.dev.vars` either. A new Worker that verifies relay tokens needs `RELAY_HMAC_KEY` set
  with `wrangler secret put` by Markus.
- **No agent may deploy.** `wrangler dev --local` is the only wrangler command an agent may run.
- **`data/` is the user's and is never committed.** When seeding fixtures seed **user tables
  only**; never `cards` or `sync_meta`. Delete every seeded row afterwards.
- **Never install `@types/node`.**
- **Adding a dependency with permissions means adding its narrowest permission, never
  `:default`.**
- Commits are `feat:` / `fix:` / `chore:` / `test:` / `docs:`, small, one per task step group.
- **`npm run verify` is run once, by the coordinator, after fan-in** — not inside each subagent.
  A subagent's slice compiles against a tree its siblings are still changing.
- **`npm run verify` does not run `cargo fmt` or `cargo clippy`; CI runs both.** Run
  `cargo fmt --manifest-path src-tauri/Cargo.toml` and
  `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` before the PR.
- **Never run two `npm run verify` at once** — concurrent runs fake ~18 Rust schema failures.
- **`npm run verify`'s exit code lies through a pipe.** Do not `| tail`.
- The Storybook MCP server (`mtg-grimoire-sb-mcp`) **failed to connect this session**. Do not
  invent design-system component properties; check a component's own source or an existing call
  site before using a prop.

---

## File Structure

### Created

| Path | Responsibility |
| --- | --- |
| `src-tauri/src/share/mod.rs` | `ShareSnapshot` + its child structs, `ShareFields`, module wiring |
| `src-tauri/src/share/snapshot.rs` | The subtree read: resolve, filter, price, emit |
| `src-tauri/src/share/publish.rs` | The two-step upload; desktop/Android only |
| `src-tauri/src/share/commands.rs` | The five `#[tauri::command]` wrappers |
| `src-tauri/src/share/__golden__/snapshot.json` | The committed golden, byte-asserted by three suites |
| `share-worker/wrangler.jsonc` | The new Worker's config — D1, R2, assets, cron, vars |
| `share-worker/schema.sql` | The `shares` table, applied to the existing D1 |
| `share-worker/src/index.ts` | Router, method table, the bearer gate |
| `share-worker/src/shares.ts` | Create / list / revoke, and the caps |
| `share-worker/src/blob.ts` | R2 put and the public immutable get |
| `share-worker/src/page.ts` | The `/s/{id}` shell with OpenGraph tags |
| `share-worker/src/lapse.ts` | The daily `live`↔`lapsed` flip |
| `share-worker/src/env.ts` | The `Env` interface |
| `tsconfig.share-worker.json` | The Worker's own type-check program (workerd globals) |
| `vite.share.config.ts` | The viewer bundle's build |
| `share/index.html` | The viewer's document |
| `share/main.tsx` | The viewer's entry — reads `location.pathname`, fetches, renders |
| `share/SharePage.tsx` | The viewer: header, folder rail, grid, filter |
| `src/lib/shareSnapshot.ts` | The TypeScript mirror of the format, and its parser |
| `src/features/share/SharedPage.tsx` | The in-app view |
| `src/features/share/OpenShareDialog.tsx` | Paste a link |
| `src/features/share/useShares.ts` | Query hooks for the owner's own shares |
| `src/features/share/useSharedSnapshot.ts` | Query hook for an opened share |
| `src/features/share/ShareFolderMenu.tsx` | Share / Update / Revoke, mounted by the collection |
| `docs/reference/collection-sharing.md` | The record of what shipped |

### Modified

| Path | Change |
| --- | --- |
| `src-tauri/src/schema.rs` | `USER_SCHEMA_VERSION` 40 → 41, the v41 rung, `collection_shares` in `USER_SCHEMA_SQL`, a `TABLES` row, and the `65` → `67` literal |
| `src-tauri/src/lib.rs` | `pub mod share;` — the module map, and nothing else |
| `src-tauri/src/desktop.rs` | Five entries in `tauri::generate_handler![…]` (line ~356). **The invoke handler is here, not in `lib.rs`** |
| `src-tauri/src/web/route.rs` | The read-only share commands in `COMMANDS` and their match arms |
| `src/lib/ipc.ts` | The five commands and the snapshot types |
| `src/lib/ipc.test.ts` | Mirror rows for the new structs and command names |
| `src/lib/store.ts` | `ViewId` gains `"shared"` |
| `src/App.tsx` | One dispatch arm |
| `src/components/AppShell.tsx` | The rail entry, shown only when a share has been opened |
| `src/features/collection/CollectionPage.tsx` | Mounts `ShareFolderMenu` on a user folder |
| `.storybook/fake/db.ts` | A handler per new command |
| `tsconfig.json` | `include` gains `"share"` |
| `package.json` | `share:build`, and `tsc -p tsconfig.share-worker.json` in `build` |
| `vite.config.ts` | A fourth vitest glob: `share-worker/src/**/*.test.ts` |
| `eslint.config.js` | `dist-share/` ignored |
| `.gitignore` | `dist-share/` |
| `CLAUDE.md`, `src-tauri/CLAUDE.md`, `src/CLAUDE.md` | Pointers to the new reference doc |

### Deliberately not modified

- **`relay/`** — spec §5.1. The share Worker verifies relay-minted tokens by importing
  `relay/src/token.ts`, which is a read, not a change.
- **`.github/workflows/ci.yml`** — `share-worker/`, `share/` and `vite.share.config.ts` match no
  `case` arm and fall through to the `*)` fail-safe, which runs every job. That is the cheap
  direction and needs no edit, exactly as `crates/` did before its arm was written.

---

## Execution waves

Tasks inside a wave touch disjoint files and are dispatched together. Nothing crosses a wave
boundary early — a later wave's task consumes an earlier one's `Produces` block.

| Wave | Tasks | Owns |
| --- | --- | --- |
| 1 | 1, 2, 4 | `src-tauri/src/share/*` + `lib.rs` · `schema.rs` · `share-worker/**` |
| 2 | 3, 5, 6 | the golden + `src/lib/shareSnapshot.ts` · the Worker's blob/public/page · the Worker's cron |
| 3 | 7, 8 | `share/publish.rs`+`commands.rs`+`desktop.rs`+`route.rs` · `src/lib/ipc.ts`+`ipc.test.ts` |
| 4 | 9, 10 | `share/**` + `vite.share.config.ts` + `package.json` · `src/features/share/**` + `store.ts` + `App.tsx` + `nav.ts` + `shortcuts.ts` |
| 5 | 11, 12 | `src/features/collection/*` · want lists + `.storybook/fake/db.ts` |
| 6 | 13 | docs |

Tasks 5 and 6 are in wave 2 rather than wave 1 only because they extend files Task 4 creates.

**The coordinator runs `npm run verify` after every wave, never a subagent.**

---

## Phase 1 — the format and the read (no network, no UI)

### Task 1: `ShareSnapshot` and the subtree read

**Files:**
- Create: `src-tauri/src/share/mod.rs`
- Create: `src-tauri/src/share/snapshot.rs`
- Create: `src-tauri/src/share/tests.rs`
- Modify: `src-tauri/src/lib.rs` — one `pub mod share;` line

**Interfaces:**
- Consumes: `crate::collection_folders::LOCKED_FOLDER_IDS` (`pub(crate)`, a self-contained
  `SELECT` binding nothing), `crate::sorting::{price_expr, Marketplace, ENTRY_FINISH}`,
  `crate::image_uri::{front_face_selects, front_face_map, LIST_VARIANT}`.
- Produces, for Tasks 3, 8 and 9:
  ```rust
  pub const SNAPSHOT_VERSION: i64 = 1;
  pub const FOLDER_IS_LOCKED: &str = "That folder is locked. Unlock it before sharing it.";
  pub const FOLDER_NOT_SHAREABLE: &str = "Only your own folders can be shared.";
  pub const FOLDER_NOT_FOUND: &str = "That folder is not in this collection.";

  pub struct ShareFields { pub condition: bool, pub lang: bool, pub value: bool }

  pub fn snapshot(
      conn: &rusqlite::Connection,
      id: &str,
      owner: &str,
      folder_uid: Option<&str>,
      fields: ShareFields,
      marketplace: crate::sorting::Marketplace,
      now: i64,
  ) -> Result<ShareSnapshot, String>;

  pub fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String>;
  ```

**Read before writing:** spec §3 and §4. The one fact that decides this task's shape:
`collection::list_entries` must **not** be reused. `collection.rs:1677` scopes a named folder with
`e.folder_id = ?` — direct members only, no subtree — and `collection.rs:1711` gates
`exclude_locked` on `q.folder_id.is_none()`, so a named folder is served whole, locked subfolders
included. Both defaults are correct for the app and would leak here.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/share/tests.rs`.

```rust
use super::*;
use rusqlite::{params, Connection};

/// `collection_folders.rs`'s own `open()`, which is private to that module's tests — so this is
/// the same two lines rather than a call into it.
///
/// **`foreign_keys` is ON and that is not ceremony here**: `collection_entries.folder_id`
/// REFERENCES `collection_folders`, and an in-memory connection starts with the pragma off, so
/// without this line a test could file a card in a folder that does not exist and pass.
fn test_db() -> Connection {
    let conn = crate::schema::memory_pair();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn
}

fn folder(conn: &rusqlite::Connection, parent: Option<i64>, name: &str, locked: bool) -> (i64, String) {
    let uid = format!("uid-{name}");
    conn.execute(
        "INSERT INTO collection_folders
           (parent_id, name, kind, sort_order, created_at, updated_at, sync_uid, locked)
         VALUES (?1, ?2, 'user', 0, 0, 0, ?3, ?4)",
        params![parent, name, uid, i64::from(locked)],
    ).unwrap();
    (conn.last_insert_rowid(), uid)
}

fn card(conn: &rusqlite::Connection, id: &str, name: &str) {
    conn.execute(
        "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, image_uris, prices)
         VALUES (?1, ?2, 'tsp', '157', 'en', 'normal',
                 json_object('normal', 'https://cards.scryfall.io/normal/front/0/0/x.jpg?1'),
                 json_object('usd', '0.34'))",
        params![id, name],
    ).unwrap();
}

fn entry(conn: &rusqlite::Connection, card_id: &str, folder: Option<i64>, qty: i64) {
    conn.execute(
        "INSERT INTO collection_entries
           (card_id, set_code, collector_number, lang, finish, condition, quantity,
            tradelist_quantity, purchase_price, notes, tags, folder_id, created_at, updated_at)
         VALUES (?1, 'tsp', '157', 'en', 'nonfoil', 'NM', ?2, 0, 9.99, 'bought at a GP', '[]',
                 ?3, 0, 0)",
        params![card_id, qty, folder],
    ).unwrap();
}

fn all(condition: bool) -> ShareFields {
    ShareFields { condition, lang: condition, value: condition }
}

fn snap(conn: &rusqlite::Connection, folder_uid: Option<&str>) -> ShareSnapshot {
    snapshot(conn, "testshareid00000", "Giradeli", folder_uid, all(true),
             crate::sorting::Marketplace::Tcgplayer, 1_757_308_800).unwrap()
}

#[test]
fn a_shared_parent_carries_its_subfolders_cards() {
    let conn = test_db();
    let (parent, parent_uid) = folder(&conn, None, "Binder", false);
    let (child, _) = folder(&conn, Some(parent), "Duals", false);
    card(&conn, "c1", "Fury Sliver");
    card(&conn, "c2", "Tundra");
    entry(&conn, "c1", Some(parent), 1);
    entry(&conn, "c2", Some(child), 2);

    let s = snap(&conn, Some(&parent_uid));

    let names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    assert!(names.contains(&"Tundra"), "the subfolder's card must travel: {names:?}");
    assert_eq!(s.folders.len(), 2, "both folders travel so the viewer can draw the tree");
}

#[test]
fn a_locked_subfolder_is_dropped_from_its_parents_share() {
    let conn = test_db();
    let (parent, parent_uid) = folder(&conn, None, "Binder", false);
    let (locked, _) = folder(&conn, Some(parent), "Display case", true);
    card(&conn, "c1", "Fury Sliver");
    card(&conn, "c2", "Black Lotus");
    entry(&conn, "c1", Some(parent), 1);
    entry(&conn, "c2", Some(locked), 1);

    let s = snap(&conn, Some(&parent_uid));

    let names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    assert_eq!(names, vec!["Fury Sliver"], "a locked subfolder must not travel");
    assert_eq!(s.folders.len(), 1, "and neither must its name");
}

#[test]
fn a_folder_below_a_locked_one_is_dropped_too() {
    let conn = test_db();
    let (parent, parent_uid) = folder(&conn, None, "Binder", false);
    let (locked, _) = folder(&conn, Some(parent), "Display case", true);
    let (under, _) = folder(&conn, Some(locked), "Top shelf", false);
    card(&conn, "c1", "Black Lotus");
    entry(&conn, "c1", Some(under), 1);

    let s = snap(&conn, Some(&parent_uid));

    assert!(s.cards.is_empty(), "the lock inherits down, so this card is set aside too");
}

#[test]
fn publishing_a_locked_folder_is_refused_by_name() {
    let conn = test_db();
    let (_, uid) = folder(&conn, None, "Display case", true);
    let err = snapshot(&conn, "x", "Giradeli", Some(&uid), all(false),
                       crate::sorting::Marketplace::Tcgplayer, 0).unwrap_err();
    assert_eq!(err, FOLDER_IS_LOCKED);
}

#[test]
fn a_deck_group_and_recently_removed_never_travel() {
    let conn = test_db();
    conn.execute(
        "INSERT INTO collection_folders (parent_id, name, kind, sort_order, created_at,
                                         updated_at, sync_uid, locked)
         VALUES (NULL, 'Recently removed', 'removed', 0, 0, 0, 'uid-removed', 0)", [],
    ).unwrap();
    let removed = conn.last_insert_rowid();
    card(&conn, "c1", "Fury Sliver");
    entry(&conn, "c1", Some(removed), 1);

    let s = snap(&conn, None);

    assert!(s.cards.is_empty(), "an app-owned folder is not a binder");
    assert!(s.folders.is_empty());
}

#[test]
fn a_whole_collection_share_carries_the_root_and_drops_locked_drawers() {
    let conn = test_db();
    let (open, _) = folder(&conn, None, "Binder", false);
    let (shut, _) = folder(&conn, None, "Display case", true);
    card(&conn, "c1", "Fury Sliver");
    card(&conn, "c2", "Tundra");
    card(&conn, "c3", "Black Lotus");
    entry(&conn, "c1", None, 1);
    entry(&conn, "c2", Some(open), 1);
    entry(&conn, "c3", Some(shut), 1);

    let s = snap(&conn, None);

    let mut names: Vec<&str> = s.cards.iter().map(|c| c.n.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["Fury Sliver", "Tundra"]);
}

#[test]
fn fields_off_means_the_keys_are_absent_rather_than_null() {
    let conn = test_db();
    card(&conn, "c1", "Fury Sliver");
    entry(&conn, "c1", None, 1);
    let s = snapshot(&conn, "x", "Giradeli", None, all(false),
                     crate::sorting::Marketplace::Tcgplayer, 0).unwrap();
    let json = serde_json::to_string(&s).unwrap();
    assert!(!json.contains("\"c\":"), "condition must be absent: {json}");
    assert!(!json.contains("\"l\":"), "lang must be absent: {json}");
    assert!(!json.contains("\"p\":"), "price must be absent: {json}");
    assert!(json.contains("\"fields\":[]"));
}

/// Must hold for **every** input, which is why it sweeps the serialised text rather than the
/// struct: a field added to `ShareCard` in a year fails this without anyone remembering the rule.
#[test]
fn no_private_field_can_reach_the_wire() {
    let conn = test_db();
    card(&conn, "c1", "Fury Sliver");
    entry(&conn, "c1", None, 3);
    let json = serde_json::to_string(&snap(&conn, None)).unwrap();
    for forbidden in ["purchase", "acquired", "acquisition", "notes", "tags", "needsReview",
                      "tradelist", "grading", "serial", "bought at a GP"] {
        assert!(!json.contains(forbidden),
                "`{forbidden}` reached a share snapshot, which spec section 3 forbids: {json}");
    }
}

/// Spec section 3.1 has no measured figure and says so. This is the measurement. It **prints**
/// rather than asserting a byte count, so it reports rather than rots.
#[test]
fn a_thousand_card_snapshot_is_measured() {
    let conn = test_db();
    let (f, uid) = folder(&conn, None, "Binder", false);
    for i in 0..1000 {
        let id = format!("c{i}");
        card(&conn, &id, &format!("Test Card {i}"));
        entry(&conn, &id, Some(f), 1);
    }
    let json = serde_json::to_vec(&snap(&conn, Some(&uid))).unwrap();
    let gz = gzip(&json).unwrap();
    println!("1000 cards: {} B raw, {} B gzipped, {:.1} B/card gzipped",
             json.len(), gz.len(), gz.len() as f64 / 1000.0);
    assert!(gz.len() < json.len(), "gzip must actually compress a snapshot");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cargo test --manifest-path src-tauri/Cargo.toml share::
```

Expected: FAIL — `share` is not a module yet. **If it reports `0 tests` and exits 0, that is the
undeclared-module trap**: a filter matching nothing exits 0 and proves nothing. Confirm the count
is non-zero before believing any later green.

- [ ] **Step 3: Write `src-tauri/src/share/mod.rs`**

```rust
//! Publishing a collection folder as a read-only snapshot.
//!
//! **This module does not read through [`crate::collection::list_entries`], and that is the
//! whole of its safety.** That query scopes a named folder with `e.folder_id = ?` — direct
//! members only — and skips `exclude_locked` entirely whenever `folder_id` is set, because "a
//! named folder is served whole" is the right answer for a reader standing in their own drawer.
//! Both defaults publish more than the reader asked for. So the read here is its own, and where
//! `CollectionQuery`'s unasked question keeps every row, this one's keeps none.
mod snapshot;
#[cfg(test)]
mod tests;

pub use snapshot::{gzip, snapshot, ShareCard, ShareFields, ShareFolder, ShareSnapshot,
                   FOLDER_IS_LOCKED, FOLDER_NOT_FOUND, FOLDER_NOT_SHAREABLE, SNAPSHOT_VERSION};
```

- [ ] **Step 4: Write `src-tauri/src/share/snapshot.rs`**

The structs. `skip_serializing_if` is what makes an unselected field **absent** rather than
`null`, which is the test above and spec §3.

```rust
use rusqlite::Connection;
use serde::Serialize;
use std::io::Write;

pub const SNAPSHOT_VERSION: i64 = 1;
pub const FOLDER_IS_LOCKED: &str = "That folder is locked. Unlock it before sharing it.";
pub const FOLDER_NOT_SHAREABLE: &str = "Only your own folders can be shared.";
pub const FOLDER_NOT_FOUND: &str = "That folder is not in this collection.";

#[derive(Debug, Clone, Copy, Default)]
pub struct ShareFields { pub condition: bool, pub lang: bool, pub value: bool }

impl ShareFields {
    /// The wire form — an array, so the viewer can tell "every card was NM" from "this snapshot
    /// carries no condition".
    fn names(self) -> Vec<&'static str> {
        let mut v = Vec::new();
        if self.condition { v.push("condition"); }
        if self.lang { v.push("lang"); }
        if self.value { v.push("value"); }
        v
    }
}

#[derive(Debug, Serialize)]
pub struct ShareFolder {
    pub uid: String,
    pub name: String,
    pub parent: Option<String>,
}

/// One card. **Short keys**, because this struct is repeated once per copy and the snapshot is
/// what crosses a stranger's network.
#[derive(Debug, Serialize)]
pub struct ShareCard {
    pub id: String,
    pub n: String,
    pub s: String,
    pub cn: String,
    pub f: String,
    pub q: i64,
    pub fo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub img: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub c: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub l: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareSnapshot {
    pub v: i64,
    pub id: String,
    pub title: String,
    pub owner: String,
    pub updated_at: i64,
    pub marketplace: String,
    pub currency: String,
    pub fields: Vec<&'static str>,
    pub folders: Vec<ShareFolder>,
    pub cards: Vec<ShareCard>,
}
```

The read. The subtree CTE is `delete_folder`'s `doomed` shape verbatim (it is already spelled four
times in this crate — `collection_folders.rs:640`, `deck.rs:2739`, `reset.rs:368`,
`deck_meta.rs:1899`), and `UNION` rather than `UNION ALL` is what makes a `parent_id` cycle
converge instead of looping.

```rust
/// Every folder in the share, as `(id, uid, name, parent_uid)`.
///
/// Two exclusions, and they are the feature: a folder that is locked or has a locked ancestor,
/// and a folder the app owns. `LOCKED_FOLDER_IDS` is `crate::collection_folders`' single copy of
/// the inheritance rule and binds nothing, so it drops straight into `NOT IN (…)`.
const SUBTREE: &str = "WITH RECURSIVE subtree(id) AS (
        SELECT id FROM collection_folders WHERE (?1 IS NULL AND parent_id IS NULL)
                                             OR sync_uid = ?1
        UNION
        SELECT f.id FROM collection_folders f JOIN subtree s ON f.parent_id = s.id
    )
    SELECT f.id, f.sync_uid, f.name,
           (SELECT p.sync_uid FROM collection_folders p WHERE p.id = f.parent_id)
      FROM collection_folders f
     WHERE f.id IN (SELECT id FROM subtree)
       AND f.kind = 'user'
       AND f.id NOT IN (<LOCKED>)
     ORDER BY f.sort_order, f.id";
```

⚠️ **`?1` is bound twice in that statement and rusqlite binds by index, so pass the uid once.**
Write `params![folder_uid]` and use `?1` in both places, never `?1` and `?2`.

Then `snapshot()`:

1. if `folder_uid` is `Some`, read the named folder's `id`, `kind` and effective lock. Refuse with
   `FOLDER_NOT_FOUND`, `FOLDER_NOT_SHAREABLE` (`kind <> 'user'`) or `FOLDER_IS_LOCKED`
   (`collection_folders::effectively_locked`) — in that order, so a missing folder never reports
   as locked;
2. run `SUBTREE` (with `<LOCKED>` replaced by `LOCKED_FOLDER_IDS`) to get the folders;
3. select the cards. The `FROM` **must** alias `cards` as `c` — `sorting::price_expr` writes
   `c.prices` and `c.id` into its expression and a different alias is a silent SQL error:

```rust
let image = crate::image_uri::front_face_selects("c").join(", ");
let price = crate::sorting::price_expr(marketplace, crate::collection::ENTRY_FINISH);
let ids: Vec<i64> = /* folder ids from step 2 */;
// The root is a share member only for a whole-collection share; a named folder never includes it.
let root_arm = if folder_uid.is_none() { "e.folder_id IS NULL OR " } else { "" };
let holes = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
let sql = format!(
    "SELECT e.card_id, c.name, e.set_code, e.collector_number, e.lang, e.finish, e.quantity,
            e.condition,
            (SELECT f.sync_uid FROM collection_folders f WHERE f.id = e.folder_id),
            {price},
            {image}
       FROM collection_entries e LEFT JOIN cards c ON c.id = e.card_id
      WHERE ({root_arm}e.folder_id IN ({holes}))
        AND e.quantity > 0
      ORDER BY coalesce(c.name, e.card_id) ASC, e.set_code ASC,
               CAST(e.collector_number AS INTEGER) ASC, e.id ASC"
);
```

Map the row: `n` is `c.name` and is `Option<String>` for an orphan whose printing has left the
database — fall back to `e.card_id` rather than dropping the row, matching
`COLLECTION_DEFAULT_ORDER`'s own `coalesce`. `img` is
`crate::image_uri::front_face_map(|i| r.get(IMAGE_COL + i))?` then
`.and_then(|m| m.get(crate::image_uri::LIST_VARIANT).cloned())`. `c`, `l` and `p` are `Some(..)`
only when the matching `fields` flag is set.

`gzip`:

```rust
/// `flate2` is already a dependency and already compiles for wasm through `rust_backend`.
pub fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(bytes).map_err(|e| e.to_string())?;
    e.finish().map_err(|e| e.to_string())
}
```

- [ ] **Step 5: Declare the module**

In `src-tauri/src/lib.rs`, add `pub mod share;` to the **portable** group — the one that is not
behind `#[cfg(not(target_family = "wasm"))]`. This module reads SQLite and formats JSON; only
Task 8's `publish.rs` needs gating.

- [ ] **Step 6: Run the tests**

```
cargo test --manifest-path src-tauri/Cargo.toml share:: -- --nocapture
```

Expected: PASS, 9 tests, and the measurement line printed. **Record the printed figures — they
are what spec §3.1 asks for and what Task 5's caps are set against.**

- [ ] **Step 7: Mutate one test to prove it can fail**

Temporarily delete `AND f.id NOT IN (<LOCKED>)` from `SUBTREE` and re-run.
`a_locked_subfolder_is_dropped_from_its_parents_share` and `a_folder_below_a_locked_one…` must
both go red. Restore the line. A test that cannot fail is the defect this step exists to catch.

- [ ] **Step 8: Commit**

```
git add src-tauri/src/share src-tauri/src/lib.rs
git commit -m "feat: render a collection folder subtree as a share snapshot"
```

---

### Task 2: user schema v41 — `collection_shares`

**Files:**
- Modify: `src-tauri/src/schema.rs` — five separate places

**Interfaces:**
- Produces, for Task 7: the table below, and `crate::schema::USER_SCHEMA_VERSION == 41`.

**Read first:** this table is a **cache of the relay's list, and is deliberately not synced.**
`SYNCED_TABLES` stays at 13. The relay's `GET /g/{group}/shares` is the roster, exactly as the
rewrapped key set is the roster for group membership — a synced copy would be a second record of
a fact the relay already holds, and the two would disagree the first time a device was offline
during a revoke. What the table buys is a "shared" badge that survives being offline.

⚠️ **v41 is a guess.** Every open branch adding a rung guesses the same number, and git cannot
help — both sides read the same literal, so there is no conflict on it and only the rungs
underneath collide. **Take the next free number at merge time**, and renumber all five places.

- [ ] **Step 1: Write the failing test**

In `schema.rs`'s own `mod tests`:

```rust
#[test]
fn v41_gives_a_database_the_share_cache() {
    let conn = Connection::open_in_memory().unwrap();
    migrate_single_file(&conn).unwrap();
    migrate_user(&conn).unwrap();
    let v: i64 = conn.query_row("PRAGMA main.user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 41);
    conn.execute(
        "INSERT INTO collection_shares (id, folder_uid, title, fields, state, updated_at)
         VALUES ('abc', 'uid-1', 'Binder', '[\"value\"]', 'live', 0)",
        [],
    )
    .unwrap();
    // One share per folder — decision 7, enforced here as well as on the relay.
    let second = conn.execute(
        "INSERT INTO collection_shares (id, folder_uid, title, fields, state, updated_at)
         VALUES ('def', 'uid-1', 'Binder again', '[]', 'live', 0)",
        [],
    );
    assert!(second.is_err(), "a folder may be shared once");
    // ...but a whole-collection share is NULL, and SQLite's unique index lets NULLs repeat, so
    // the partial index below is what stops two of those.
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM collection_shares",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn the_share_cache_is_not_synced() {
    assert!(
        !crate::schema::SYNCED_TABLES.contains(&"collection_shares"),
        "the relay's list is the roster; a synced copy would disagree during an offline revoke"
    );
}
```

- [ ] **Step 2: Run to verify failure**

```
cargo test --manifest-path src-tauri/Cargo.toml schema::tests::v41
```
Expected: FAIL — `no such table: collection_shares`, and the version assertion sees 40.

- [ ] **Step 3: The rung**

In `migrate_user`, immediately after the `if v < 40 { … }` block and **before** the
`INSERT OR IGNORE INTO main.sync_clock` line at the tail:

```rust
    if v < 41 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE collection_shares (
                 id TEXT PRIMARY KEY,
                 -- `collection_folders.sync_uid`, and NULL for a whole-collection share. Soft,
                 -- like every other cross-table reference in a user table: a share outlives the
                 -- device that made it and a row id is local.
                 folder_uid TEXT,
                 title TEXT NOT NULL,
                 -- The wire form, verbatim — a JSON array of `condition`/`lang`/`value`.
                 fields TEXT NOT NULL,
                 state TEXT NOT NULL DEFAULT 'live'
                     CHECK (state IN ('live','lapsed','revoked')),
                 -- When THIS device last uploaded. NULL means it never has, which is what a
                 -- second device in the group reads before it offers Update.
                 published INTEGER,
                 updated_at INTEGER NOT NULL
              );
             CREATE UNIQUE INDEX idx_collection_shares_folder
                 ON collection_shares (folder_uid) WHERE folder_uid IS NOT NULL;
             CREATE UNIQUE INDEX idx_collection_shares_whole
                 ON collection_shares (folder_uid) WHERE folder_uid IS NULL;",
        )?;
        // Literal `41`, for the reason every step before it writes its own: this step is what
        // *makes* a database version 41.
        tx.execute_batch("PRAGMA main.user_version = 41;")?;
        tx.commit()?;
    }
```

⚠️ **Two partial indexes, not one.** SQLite treats NULLs as distinct in a unique index, so
`idx_collection_shares_folder` alone would allow any number of whole-collection shares. The
second index is `WHERE folder_uid IS NULL`, which admits at most one row — because every such row
has the same (null) key.

⚠️ **No `sync_uid` column**, unlike every table that climbed v29 — this one does not sync.

- [ ] **Step 4: `USER_SCHEMA_SQL`**

Add the table at the **end of the tables run**, immediately after `deck_tokens` and before the
first `CREATE UNIQUE INDEX` (around line 3822), and the two indexes at the **end of the indexes
run**, after `idx_deck_tokens_uid` (around line 3920). The order is creation order, which is what
`sqlite_master` reports for a database that climbed the ladder.

The text must be **byte-identical to the rung's**, differing only by the `{schema}.` prefix — and
`{schema}.` never reaches `sqlite_master`, which is what
`the_schema_prefix_does_not_reach_sqlite_master` pins. Transcribe, do not retype.

- [ ] **Step 5: `TABLES` and the count literal**

Both, or the byte-identity test stays green over an unchecked table.

```rust
    // A cache of the relay's share list (user schema v41), not a synced table: the relay's
    // roster is the fact and this is a copy that lets a folder wear its badge offline.
    ("collection_shares", Side::User),
```

Then in `the_user_schema_is_byte_identical_to_what_the_ladder_builds`, the row-count literal moves
**65 → 68**: one table, two indexes. `id TEXT PRIMARY KEY` on a rowid table also brings an
`sqlite_autoindex` row, so **confirm the number by running the test and reading what it reports
rather than by arithmetic** — the assertion message prints both sides.

- [ ] **Step 6: Bump the version constant**

`USER_SCHEMA_VERSION` 40 → 41, **and** the second assertion at `schema.rs:7776-7777`
(`assert_eq!(USER_SCHEMA_VERSION, 40);`).

- [ ] **Step 7: Run**

```
cargo test --manifest-path src-tauri/Cargo.toml schema::
```
Expected: PASS, including `the_user_schema_is_byte_identical_to_what_the_ladder_builds`. If that
one fails on whitespace, the two DDL literals differ — diff them character by character; that is
exactly what the test exists to catch.

- [ ] **Step 8: Prove the upgrade on the real dev database**

A worktree can never show an upgrade bug, because its database is created at head. Copy the whole
`data` folder from `D:/Code/mtg-grimoire/src-tauri/target/debug/data/` (the folder, not just the
`.db`), point a debug build at the copy, and confirm it climbs 40 → 41 without error.

- [ ] **Step 9: Commit**

```
git add src-tauri/src/schema.rs
git commit -m "feat: user schema v41, the collection_shares cache"
```

---

### Task 3: the golden snapshot and the TypeScript mirror

**Files:**
- Create: `src-tauri/src/share/__golden__/snapshot.json`
- Create: `src/lib/shareSnapshot.ts`
- Create: `src/lib/shareSnapshot.test.ts`
- Modify: `src-tauri/src/share/tests.rs` — the byte-equality test

**Interfaces:**
- Consumes: Task 1's `ShareSnapshot`.
- Produces, for Tasks 9 and 10:
  ```ts
  export interface ShareCard { id: string; n: string; s: string; cn: string; f: string;
    q: number; fo: string | null; img?: string; c?: string; l?: string; p?: number }
  export interface ShareFolder { uid: string; name: string; parent: string | null }
  export interface ShareSnapshot { v: number; id: string; title: string; owner: string;
    updatedAt: number; marketplace: string; currency: string; fields: string[];
    folders: ShareFolder[]; cards: ShareCard[] }
  export const SNAPSHOT_VERSION = 1;
  export function parseSnapshot(text: string): ShareSnapshot;  // throws a sentence
  export const SNAPSHOT_TOO_NEW: string;
  ```

**Why this task exists:** one format, **three** implementations — one Rust writer and two
TypeScript readers. That is one more than the text mirror has, and
`src/features/transfer/__golden__/` is the precedent: one committed corpus, one committed golden,
every suite asserting against it, so drift is a red build rather than a viewer that quietly
disagrees with the publisher.

- [ ] **Step 1: Write the Rust golden test**

Append to `src-tauri/src/share/tests.rs`:

```rust
/// The fence. `src/features/transfer/__golden__/` is the precedent and the reason is the same,
/// one degree harder: this format has three implementations, not two.
#[test]
fn the_golden_snapshot_is_what_the_writer_produces() {
    let conn = test_db();
    let (f, uid) = folder(&conn, None, "Trade binder", false);
    let (child, _) = folder(&conn, Some(f), "Duals", false);
    card(&conn, "0000579f-7b35-4ed3-b44c-db2a538066fe", "Fury Sliver");
    card(&conn, "56ebc372-aabd-4174-a943-c7bf59e5028d", "Tundra");
    entry(&conn, "0000579f-7b35-4ed3-b44c-db2a538066fe", Some(f), 2);
    entry(&conn, "56ebc372-aabd-4174-a943-c7bf59e5028d", Some(child), 1);

    let got = serde_json::to_string_pretty(&snap(&conn, Some(&uid))).unwrap();
    let want = include_str!("__golden__/snapshot.json");

    // `\r\n` is what a Windows checkout can hand back — a subagent write has flipped a file to
    // CRLF in this repo before, and the resulting diff is invisible in a terminal.
    assert_eq!(got.trim_end(), want.replace("\r\n", "\n").trim_end());
}
```

- [ ] **Step 2: Generate the golden**

Run the test, read the `got` side out of the failure, and write it to
`src-tauri/src/share/__golden__/snapshot.json`. **Read the file back and confirm it is LF**;
`git config core.autocrlf` on this machine can rewrite it.

- [ ] **Step 3: Write `src/lib/shareSnapshot.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import golden from "../../src-tauri/src/share/__golden__/snapshot.json?raw";
import { parseSnapshot, SNAPSHOT_TOO_NEW, SNAPSHOT_VERSION } from "./shareSnapshot";

describe("the share snapshot mirror", () => {
  it("parses the golden the Rust writer produced", () => {
    const s = parseSnapshot(golden);
    expect(s.v).toBe(SNAPSHOT_VERSION);
    expect(s.title).toBe("Trade binder");
    expect(s.owner).toBe("Giradeli");
    expect(s.cards).toHaveLength(2);
    expect(s.folders.map((f) => f.name)).toEqual(["Trade binder", "Duals"]);
    // The subfolder's card carries its own folder uid, which is what lets the viewer draw a tree.
    expect(s.cards.some((c) => c.fo !== s.folders[0].uid)).toBe(true);
  });

  /** Not a smoke test: this is the assertion that the writer's absences are real. */
  it("carries no private field", () => {
    for (const forbidden of ["purchase", "acquired", "notes", "tags", "tradelist"]) {
      expect(golden).not.toContain(forbidden);
    }
  });

  it("refuses a snapshot from a newer build by name rather than rendering half of it", () => {
    const newer = JSON.stringify({ ...JSON.parse(golden), v: SNAPSHOT_VERSION + 1 });
    expect(() => parseSnapshot(newer)).toThrow(SNAPSHOT_TOO_NEW);
  });

  it("refuses a body that is not a snapshot at all", () => {
    expect(() => parseSnapshot("not json")).toThrow();
    expect(() => parseSnapshot("{}")).toThrow();
  });
});
```

- [ ] **Step 4: Run to verify failure**

```
npx vitest run src/lib/shareSnapshot.test.ts
```
Expected: FAIL — the module does not exist.

- [ ] **Step 5: Write `src/lib/shareSnapshot.ts`**

Types as in the Interfaces block. `parseSnapshot` must:
- `JSON.parse` inside a `try`, rethrowing a sentence rather than a `SyntaxError`;
- refuse a non-object;
- refuse `v > SNAPSHOT_VERSION` with `SNAPSHOT_TOO_NEW` — *"This shared collection was published
  by a newer version of MTG Grimoire. Update to open it."*;
- refuse a missing `cards` or `folders` array;
- return the parsed object.

**It imports nothing** — no `ipc`, no `core`, no store. Both the web bundle and the app import it,
and the web bundle has no core at all.

- [ ] **Step 6: Run both suites**

```
npx vitest run src/lib/shareSnapshot.test.ts
cargo test --manifest-path src-tauri/Cargo.toml share::
```
Expected: PASS on both.

- [ ] **Step 7: Mutate to prove the fence bites**

Change one field name in `ShareCard` on the Rust side (`n` → `name`) and re-run
`cargo test share::`. The golden test must go red. Restore it.

- [ ] **Step 8: Commit**

```
git add src-tauri/src/share src/lib/shareSnapshot.ts src/lib/shareSnapshot.test.ts
git commit -m "test: golden fence for the share snapshot format"
```

---

## Phase 2 — the share Worker

### Task 4: the Worker, its D1 table, and the gated writes

**Files:**
- Create: `share-worker/wrangler.jsonc`, `share-worker/schema.sql`, `share-worker/README.md`
- Create: `share-worker/src/env.ts`, `share-worker/src/index.ts`, `share-worker/src/shares.ts`
- Create: `share-worker/src/shares.test.ts`
- Create: `tsconfig.share-worker.json`
- Modify: `vite.config.ts` — a fourth `test.include` glob
- Modify: `package.json` — a fifth `&& tsc -p …` link in `build`

**Interfaces:**
- Consumes: `relay/src/token.ts`'s `verify(token, secret, nowMs): Promise<Claims | null>` and
  `relay/src/fakeD1.ts`'s `fakeEnvOver(tables)`. Both are imported across the directory boundary;
  `token.ts` imports nothing, so the coupling is one function.
- Produces, for Tasks 5, 6 and 7:
  ```ts
  export interface Env { DB: D1Database; SHARES: R2Bucket; RELAY_HMAC_KEY: string;
                         SHARE_BASE: string }
  export function json(body: unknown, status?: number): Response;
  export async function authorised(request: Request, env: Env, group: string): Promise<boolean>;
  export const MAX_SHARES_PER_GROUP = 20;
  export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
  ```

**Why a second Worker and not a route on the relay:** blast radius. Sync is a paid feature people
depend on; sharing is new and will churn, and every deploy here is done by hand by one person.
The two share a D1 database and the `RELAY_HMAC_KEY` secret and nothing else. **`relay/` is not
modified by any task in this plan.**

⚠️ **There is no test runner for workerd in this tree, deliberately.**
`@cloudflare/vitest-pool-workers` drags wrangler and workerd into a tree pinned to vitest 4.1.10,
and `vite.config.ts` says so. So handlers must be plain functions over an injected `Env`, driven
in tests as `worker.fetch(request, env)` with a `fakeD1` env — which is exactly how
`relay/src/rotate.test.ts` drives `/rotate` and `/keys`.

- [ ] **Step 1: Write the failing tests**

`share-worker/src/shares.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fakeEnvOver, type Tables } from "../../relay/src/fakeD1";
import { mint } from "../../relay/src/token";
import worker, { type Env } from "./index";

const KEY = "test-signing-key";
const NOW = 1_757_308_800_000;

/** `fakeD1`'s tables plus the two bindings this Worker reads. R2 is a Map. */
function shareEnv(tables: Partial<Tables> = {}): Env & { r2: Map<string, Uint8Array> } {
  const r2 = new Map<string, Uint8Array>();
  const base = fakeEnvOver({
    entitlements: [
      { subject: "sub-0", source: "patreon", external_id: "e0", status: "active",
        grace_until: null, group_id: "g1", refresh_secret: "s0", patreon_refresh: null,
        created_at: 0, checked_at: 0, group_epoch: null, group_auth: null },
    ],
    shares: [],
    ...tables,
  } as Tables);
  return {
    ...base,
    RELAY_HMAC_KEY: KEY,
    SHARE_BASE: "https://share.example",
    SHARES: {
      put: (k: string, v: ArrayBuffer) => { r2.set(k, new Uint8Array(v)); return Promise.resolve({}); },
      get: (k: string) => Promise.resolve(r2.has(k) ? { body: r2.get(k) } : null),
      delete: (k: string) => { r2.delete(k); return Promise.resolve(); },
    },
    r2,
  } as unknown as Env & { r2: Map<string, Uint8Array> };
}

async function token(group = "g1", exp = NOW + 60_000) {
  return mint({ sub: "sub-0", grp: group, exp }, KEY);
}

function post(group: string, bearer: string, body: unknown): Request {
  return new Request(`https://share.example/g/${group}/share`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

const META = { folderUid: "uid-1", title: "Trade binder", ownerName: "Giradeli",
               cardCount: 2, totalValue: 1.2, currency: "USD", marketplace: "tcgplayer",
               fields: ["condition", "lang", "value"] };

describe("POST /g/{group}/share", () => {
  it("mints a share for an entitled caller and answers its id", async () => {
    const env = shareEnv();
    const res = await worker.fetch(post("g1", await token(), META), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("refuses a request with no bearer", async () => {
    const env = shareEnv();
    const res = await worker.fetch(
      new Request("https://share.example/g/g1/share", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  /**
   * Not redundant with the signature check: a validly signed token for the caller's OWN group is
   * exactly what an attacker has. Without this comparison it would open every group.
   */
  it("refuses a valid token minted for a different group", async () => {
    const env = shareEnv();
    const res = await worker.fetch(post("g1", await token("g2"), META), env);
    expect(res.status).toBe(401);
  });

  it("returns the same id when the same folder is shared again", async () => {
    const env = shareEnv();
    const first = (await (await worker.fetch(post("g1", await token(), META), env)).json()) as { id: string };
    const again = (await (await worker.fetch(post("g1", await token(), META), env)).json()) as { id: string };
    expect(again.id).toBe(first.id);
  });

  it("caps a group's shares and names the number", async () => {
    const env = shareEnv();
    for (let i = 0; i < 20; i += 1) {
      await worker.fetch(post("g1", await token(), { ...META, folderUid: `uid-${i}` }), env);
    }
    const res = await worker.fetch(post("g1", await token(), { ...META, folderUid: "uid-over" }), env);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("20");
  });

  it("refuses a body that is not a share", async () => {
    const env = shareEnv();
    for (const bad of [{}, { ...META, title: "" }, { ...META, cardCount: -1 },
                       { ...META, fields: "condition" }]) {
      const res = await worker.fetch(post("g1", await token(), bad), env);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("GET /g/{group}/shares and DELETE", () => {
  it("lists what the group has published, from any device in it", async () => {
    const env = shareEnv();
    await worker.fetch(post("g1", await token(), META), env);
    const res = await worker.fetch(
      new Request("https://share.example/g/g1/shares", {
        headers: { authorization: `Bearer ${await token()}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as { shares: { title: string }[] };
    expect(list.shares.map((s) => s.title)).toEqual(["Trade binder"]);
  });

  it("revokes permanently, and a revoked share does not come back on re-publish", async () => {
    const env = shareEnv();
    const { id } = (await (await worker.fetch(post("g1", await token(), META), env)).json()) as { id: string };
    const res = await worker.fetch(
      new Request(`https://share.example/g/g1/share/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${await token()}` },
      }),
      env,
    );
    expect(res.status).toBe(204);
    const again = (await (await worker.fetch(post("g1", await token(), META), env)).json()) as { id: string };
    expect(again.id).not.toBe(id);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```
npx vitest run share-worker/src/shares.test.ts
```
Expected: **`No test files found`** — the glob does not cover this directory yet. That is the
first thing to fix, and it is exactly the trap that makes a filter matching nothing exit 0.

- [ ] **Step 3: Wire the directory into the build**

`vite.config.ts` — a fourth glob:
```ts
include: ["src/**/*.test.{ts,tsx}", ".storybook/**/*.test.ts", "relay/src/**/*.test.ts",
          "share-worker/src/**/*.test.ts"],
```
Leave `coverage.include` alone (`src/**` only), for the reason `relay/` is absent from it.

`tsconfig.share-worker.json` — copy `tsconfig.relay.json` verbatim and change **only**
`"include"` to `["share-worker/src", "relay/src/token.ts", "relay/src/fakeD1.ts"]`. The two relay
files are in the program because this Worker imports them and a type-check that could not see
them would be checking half a module.

`package.json` — `"build": "… && tsc -p tsconfig.relay.json && tsc -p tsconfig.share-worker.json
&& vite build"`.

⚠️ **Do not widen `tsconfig.node.json`'s `include`** — its own comment says why, and doing so
breaks `npm run build` on a clean checkout.

- [ ] **Step 4: `share-worker/schema.sql`**

```sql
-- The share index. Applied to the SAME D1 database the relay uses:
--   npx wrangler d1 execute mtg-grimoire-relay --remote --file=./schema.sql
--
-- ⚠️ One statement per `--command` on a database that already holds part of this, because
-- `wrangler d1 execute --file` is atomic and a duplicate object takes the whole file down —
-- the failure that left a deployed Worker 500ing on 2026-08-30.
CREATE TABLE IF NOT EXISTS shares (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  folder_uid  TEXT,
  title       TEXT NOT NULL,
  owner_name  TEXT NOT NULL,
  card_count  INTEGER NOT NULL,
  total_value REAL,
  currency    TEXT,
  marketplace TEXT,
  fields      TEXT NOT NULL,
  -- NULL until the first blob commits. That is what makes a failed upload leave the previous
  -- snapshot serving rather than a broken link.
  object_key  TEXT,
  bytes       INTEGER,
  -- A state and not a `revoked_at` stamp: a lapsed membership darkens a link and a revived one
  -- must light it again, and a timestamp can only be set. `revoked` is the reader's own press
  -- and is terminal; `lapsed` is the cron's and is reversible.
  state       TEXT NOT NULL CHECK (state IN ('live','lapsed','revoked')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One share per folder (decision 7). `coalesce` because SQLite treats NULLs as distinct, so a
-- bare unique index would allow any number of whole-collection shares per group.
CREATE UNIQUE INDEX IF NOT EXISTS shares_folder
  ON shares (group_id, coalesce(folder_uid, ''));
CREATE INDEX IF NOT EXISTS shares_group ON shares (group_id);
```

- [ ] **Step 5: `share-worker/src/index.ts`**

Mirror `relay/src/index.ts`'s shape: a `ROUTE` regex built from the same
`[A-Za-z0-9_-]{1,128}` group-segment class, a `METHOD` table, `methodNotAllowed`, and the bearer
gate copied line for line — **including `claims.grp !== group`**, with its comment.

```ts
const SHARE_ID = "[A-Za-z0-9_-]{16}";
const GROUP_SEGMENT = "[A-Za-z0-9_-]{1,128}";
const WRITE = new RegExp(`^/g/(${GROUP_SEGMENT})/(share|shares)(?:/(${SHARE_ID}))?$`);

export default {
  async fetch(request: Request, env: Env): Promise<Response> { /* … */ },
} satisfies ExportedHandler<Env>;
```

Carry a **local copy** of `json()` rather than exporting the relay's — `rotate.ts:93-97` states
that rule and its reason.

- [ ] **Step 6: `share-worker/src/shares.ts`**

`handleCreate`, `handleList`, `handleRevoke`. Order every check the way `handleRotate` does:
*every check that costs nothing, then the ones that cost a D1 read.*

Body validation is a pure `metaProblem(body): string | null`, the shape `manifestProblem` has.
Refuse: a missing or empty `title`, a `cardCount` that is not a non-negative integer, a `fields`
that is not an array of the three known strings, a `folderUid` that is not a string or null.

The id: 12 random bytes as unpadded base64url — 96 bits, 16 characters.
```ts
function mintId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
```

`handleCreate` is an upsert on `(group_id, coalesce(folder_uid,''))`: an existing **live or
lapsed** row keeps its id and updates its metadata; a `revoked` row is replaced by a new id,
because a revoked link must stay dead. The cap counts only non-revoked rows.

- [ ] **Step 7: `share-worker/wrangler.jsonc`**

`name: "mtg-grimoire-share"`, `main: "src/index.ts"`, the same `d1_databases` binding as the relay
(`database_name: "mtg-grimoire-relay"`, the same `database_id`), an `r2_buckets` binding named
`SHARES`, `vars: { SHARE_BASE: "<set on first deploy>" }`, `observability: { enabled: true }`.
**No `durable_objects`** — nothing here may reach one.

Write the `SHARE_BASE` value as a placeholder and say so in a comment: only a deploy can produce
the real host, and inventing a plausible one is a value that gets copied into documentation and
deployed against. That is the mistake `wrangler.jsonc`'s `database_id` comment records.

- [ ] **Step 8: Run**

```
npx vitest run share-worker/src/shares.test.ts
```
Expected: PASS, and **confirm the test count is non-zero.**

⚠️ `fakeD1.ts`'s `PRIMARY_KEY` / unique-index maps must gain a `shares` entry, or the cap and
uniqueness tests are vacuous — its own header says a table missing from that map makes its cap
tests vacuous. That is an edit to `relay/src/fakeD1.ts`, and it is the **one** relay file this
plan touches; it is test scaffolding, reaches no deployed bundle, and `relay/`'s own suite must
stay green after it.

- [ ] **Step 9: Commit**

```
git add share-worker tsconfig.share-worker.json vite.config.ts package.json relay/src/fakeD1.ts
git commit -m "feat: the share Worker, its D1 table and the gated writes"
```

---

### Task 5: the blob, the public routes, and the page

**Files:**
- Create: `share-worker/src/blob.ts`, `share-worker/src/page.ts`, `share-worker/src/public.test.ts`
- Modify: `share-worker/src/index.ts` — three more routes

**Interfaces:**
- Consumes: Task 4's `Env`, `json`, `authorised`.
- Produces, for Task 7: `PUT /g/{group}/share/{id}` answering `{ hash }`, and the public URL
  shape `{SHARE_BASE}/s/{id}`.

- [ ] **Step 1: Write the failing tests**

`share-worker/src/public.test.ts` — the cases that matter:

```ts
it("stores a blob and only then points the row at it", async () => {
  // Publish metadata, PUT the gzip, and assert `object_key` was NULL in between. A failed
  // upload must leave the previous snapshot serving rather than a broken link.
});

it("serves the snapshot immutably at a content-addressed path", async () => {
  // GET /s/{id}/{hash}.json.gz -> 200, cache-control `public, max-age=31536000, immutable`
});

it("answers 410 with different sentences for a revoked and a lapsed share", async () => {
  // NOT 404 - a viewer should learn the share was withdrawn, not that they mistyped.
});

it("answers 404 for an id that was never minted", async () => {});

it("refuses a blob over the cap and names the size", async () => {});

it("renders a shell carrying the owner, the title and the count in its OpenGraph tags", async () => {
  const html = await (await worker.fetch(new Request("https://share.example/s/" + id), env)).text();
  expect(html).toContain('property="og:title"');
  expect(html).toContain("Giradeli");
  // The one thing plaintext storage bought. If this is ever removed, decision 2 has no payoff.
});

it("escapes a title that contains markup", async () => {
  // The owner types both of these. `claim.ts:1112` warns in words: there is no template engine
  // standing between this string and the browser.
});
```

- [ ] **Step 2: Run to verify failure.** Expected: FAIL, routes not found (404).

- [ ] **Step 3: `blob.ts`**

`PUT` streams `request.body` straight into R2 — no buffering. The key is
`shares/{id}/{hash}.json.gz` where `hash` is the SHA-256 of the body, first 16 hex characters,
computed as the body is read. Delete the previous `object_key` **after** the D1 row has moved to
the new one; R2 deletes are free and an orphaned object is cheaper than a missing one.

The public GET streams the R2 object back with
`content-encoding: gzip`, `content-type: application/json`, and
`cache-control: public, max-age=31536000, immutable`. Put `caches.default` in front of it so a
warm view costs no R2 read.

- [ ] **Step 4: `page.ts`**

A template literal, exactly `relay/src/pair.ts`'s shape. It carries `<title>`, the four
OpenGraph tags, `<meta name="robots" content="noindex">` — a share is unlisted, and a search
engine indexing it would make "anyone with the link" mean rather more — and a `<script
type="module" src="/assets/share.js">` plus `<div id="root">`.

**It also inlines the current blob's immutable URL**, because the Worker is already reading the
D1 row to build the OpenGraph tags and a second round trip to learn the hash would cost a Worker
request for a fact this response already holds:

```html
<link id="snapshot" rel="preload" as="fetch" crossorigin
      href="/s/{id}/{hash}.json.gz">
```
The viewer reads `document.getElementById("snapshot").href`. `rel="preload"` rather than a data
attribute so the browser starts the fetch while the bundle is still parsing.

A share whose `object_key` is still NULL — metadata posted, blob never uploaded — has no href to
inline. Render the shell with a sentence saying the share is not ready yet, **not** a broken
viewer: that is the state a publish that died between Task 7's steps 1 and 3 leaves behind.

⚠️ **Every value interpolated into it is typed by a reader.** Write one `esc()` and use it on
`title`, `ownerName` and the id. There is no template engine here.

`cache-control: public, max-age=300`, matching `/pair`.

- [ ] **Step 5: the static assets binding**

Add to `wrangler.jsonc`:
```jsonc
  // The first `assets` binding in this repo. Static asset requests are free and unlimited even
  // on the free plan, which is what keeps a viral share off the account's 100 000/day budget —
  // the cliff every paying reader's sync shares. `run_worker_first` for `/s/*` because the
  // shell is rendered, not served.
  "assets": { "directory": "../dist-share", "binding": "ASSETS",
              "run_worker_first": ["/s/*", "/g/*"] },
```

- [ ] **Step 6: Run, then commit**

```
npx vitest run share-worker/
git add share-worker
git commit -m "feat: the share Worker's blob store, public routes and shell"
```

---

### Task 6: the lapse cron

**Files:**
- Create: `share-worker/src/lapse.ts`, `share-worker/src/lapse.test.ts`
- Modify: `share-worker/src/index.ts` — a `scheduled` handler
- Modify: `share-worker/wrangler.jsonc` — `"triggers": { "crons": ["30 3 * * *"] }`

**Read first:** spec §6. This is the share Worker's own cron, **not** an edit to
`relay/src/claim.ts`'s `reconcile` — a flip written there would break §5.1's claim that the
relay is untouched. The free plan allows five cron triggers per account and the relay uses one.
`30 3` rather than `0 3` so the two passes do not contend on the same D1.

**It reads the stored `status` and does not re-run `decide`.** `reconcile` is what moves a subject
through `active → grace → dead` against Patreon; duplicating that judgement here would give one
account two opinions about when a membership ended.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { fakeEnvOver, type Tables } from "../../relay/src/fakeD1";
import { sweepLapsed } from "./lapse";

const ent = (subject: string, group: string, status: string) => ({
  subject, source: "patreon", external_id: subject, status, grace_until: null,
  group_id: group, refresh_secret: "s", patreon_refresh: null, created_at: 0, checked_at: 0,
  group_epoch: null, group_auth: null,
});
const share = (id: string, group: string, state: string) => ({
  id, group_id: group, folder_uid: null, title: "Binder", owner_name: "G", card_count: 1,
  total_value: null, currency: null, marketplace: null, fields: "[]", object_key: "k",
  bytes: 1, state, created_at: 0, updated_at: 0,
});

function stateOf(tables: Tables, id: string) {
  return (tables.shares.find((r) => r.id === id) as { state: string }).state;
}

describe("the lapse sweep", () => {
  it("darkens a dead subject's shares", async () => {
    const tables = { entitlements: [ent("s1", "g1", "dead")], shares: [share("a", "g1", "live")] } as Tables;
    await sweepLapsed(fakeEnvOver(tables));
    expect(stateOf(tables, "a")).toBe("lapsed");
  });

  /** Decision 5's other half: a membership that revives must light the links again. */
  it("lights them again when the subject is active", async () => {
    const tables = { entitlements: [ent("s1", "g1", "active")], shares: [share("a", "g1", "lapsed")] } as Tables;
    await sweepLapsed(fakeEnvOver(tables));
    expect(stateOf(tables, "a")).toBe("live");
  });

  /** `grace` serves. A declined card is a failed payment Patreon retries, not a cancellation. */
  it("leaves a subject in their grace window serving", async () => {
    const tables = { entitlements: [ent("s1", "g1", "grace")], shares: [share("a", "g1", "live")] } as Tables;
    await sweepLapsed(fakeEnvOver(tables));
    expect(stateOf(tables, "a")).toBe("live");
  });

  /** The reader's own press is terminal and the cron must never undo it. */
  it("never resurrects a revoked share", async () => {
    const tables = { entitlements: [ent("s1", "g1", "active")], shares: [share("a", "g1", "revoked")] } as Tables;
    await sweepLapsed(fakeEnvOver(tables));
    expect(stateOf(tables, "a")).toBe("revoked");
  });
});
```

- [ ] **Step 2: Run to verify failure.** Expected: FAIL, `sweepLapsed` is not defined.

- [ ] **Step 3: Write `sweepLapsed`**

Two statements, both scoped by a subquery over `entitlements`, and the second **must** carry
`AND state = 'lapsed'` so a revoked row is never touched:

```sql
UPDATE shares SET state = 'lapsed', updated_at = ?
 WHERE state = 'live'
   AND group_id IN (SELECT group_id FROM entitlements
                     WHERE status = 'dead' AND group_id IS NOT NULL);

UPDATE shares SET state = 'live', updated_at = ?
 WHERE state = 'lapsed'
   AND group_id IN (SELECT group_id FROM entitlements
                     WHERE status IN ('active','grace') AND group_id IS NOT NULL);
```

Then in `index.ts`, `async scheduled(_controller, env) { await sweepLapsed(env); }` — awaited
rather than handed to `ctx.waitUntil`, and `ctx` deliberately absent, exactly as the relay's is.

- [ ] **Step 4: Run, mutate, commit**

Run the suite; then delete `AND state = 'lapsed'` from the second statement and confirm
`never_resurrects_a_revoked_share` goes red. Restore it.

```
git add share-worker
git commit -m "feat: darken a lapsed membership's share links, and light them again"
```

---

## Phase 3 — the app's publishing side

### Task 7: publish, and the five commands

**Files:**
- Create: `src-tauri/src/share/publish.rs`, `src-tauri/src/share/commands.rs`
- Create: `src-tauri/src/share/cache.rs` (the `collection_shares` reads and writes)
- Modify: `src-tauri/src/share/mod.rs`, `src-tauri/src/desktop.rs`, `src-tauri/src/web/route.rs`

**Interfaces:**
- Consumes: Task 1's `snapshot`/`gzip`, Task 2's table, Task 4's routes.
- Produces, for Task 8 — the five wire names and their **exact** camelCase argument keys:
  ```
  share_list        ()                                 -> Vec<ShareRow>
  share_create      { folderUid: String|null,
                      ownerName: String,
                      fields: ShareFields }             -> ShareRow
  share_refresh     { id: String }                      -> ShareRow
  share_revoke      { id: String }                      -> ()
  share_open        { url: String }                     -> ShareSnapshot
  ```
  ```rust
  #[derive(Debug, Serialize)] #[serde(rename_all = "camelCase")]
  pub struct ShareRow { pub id: String, pub folder_uid: Option<String>, pub title: String,
                        pub owner_name: String, pub url: String, pub fields: Vec<String>,
                        pub state: String, pub published: Option<i64>, pub updated_at: i64 }
  pub const SHARE_BASE: &str = "…";   // beside entitlement::RELAY_BASE
  ```
  **`owner_name` is on this row because spec §4.3 needs it there**: the relay holds the name, and
  the second device in a group inherits it from `GET /g/{group}/shares` rather than asking the
  reader to type it again. A `ShareRow` without it would make `share_create`'s `ownerName`
  argument unanswerable on any device but the first.

⚠️ **`SHARE_BASE` must equal `wrangler.jsonc`'s `SHARE_BASE` byte for byte** — the same trap
`RELAY_BASE` documents for the OAuth redirect URI. Until the Worker is deployed, neither value is
known; write both as the same placeholder constant and record it in §14 of the spec.

- [ ] **Step 1: Write the failing tests**

`publish.rs` is network code, so the tests are about the two things that are not:

```rust
/// A publish that fails leaves the previous snapshot and the previous link alone.
#[test]
fn a_failed_upload_does_not_move_the_cached_row() { /* seed a row, drive commit_publish with an
    Err, assert `published` and `state` are unchanged */ }

/// Three states the app draws differently, and `lapsed` is the one a reader must be told about
/// before their friends tell them.
#[test]
fn the_cache_round_trips_all_three_states() { /* insert live/lapsed/revoked, read back */ }

/// The relay's list is the roster (Task 2). A share the relay no longer names has left.
#[test]
fn reconciling_against_the_relays_list_drops_a_row_the_relay_does_not_name() { /* … */ }
```

- [ ] **Step 2: Run to verify failure.** `cargo test --manifest-path src-tauri/Cargo.toml share::`

- [ ] **Step 3: `publish.rs`** — `#[cfg(not(target_family = "wasm"))]` on the module, because it
uses `reqwest`.

Follow `client.rs`'s five conventions exactly: `http()` and never a fresh `reqwest::Client`; the
URL from a `format!` over the base; **the body written by hand** (`serde_json::to_string`, plus an
explicit `content-type`) because this crate does not enable reqwest's `json` feature; the bearer
as `.header("authorization", format!("Bearer {token}"))`; and every failure becoming an
`Err(String)` *and* a `note(conn, "share", kind, &message, Some(&url))` first.

The token comes from `entitlement::access_token(conn).await?`. A `None` there is "not connected",
and the refusal is a sentence, not a 401 dressed up.

The order — and it is the whole of the transactional safety:
1. `POST {SHARE_BASE}/g/{group}/share` with the metadata → `{ id }`;
2. `snapshot(...)` → `serde_json::to_vec` → `gzip`;
3. `PUT {SHARE_BASE}/g/{group}/share/{id}` with the bytes → `{ hash }`;
4. **only now** write `collection_shares`.

- [ ] **Step 4: `commands.rs`**

Five `#[tauri::command]` wrappers, each `#[cfg(not(target_family = "wasm"))]`, each
`spawn_blocking` for the DB half — copy `collection_folder_set_locked`'s shape, including the
`unfinished` mapper. `share_list` takes a read connection; the rest take `with_write`.

⚠️ `generate_handler!` names a command after **the last path segment**, so
`share::commands::share_create` is invoked as `"share_create"`. The comment beside
`collection_alloc::commands::collection_to_deck` in `desktop.rs` states this rule.

- [ ] **Step 5: Register in `desktop.rs`**

In `tauri::generate_handler![…]` (around line 356), after the `collection_folders::` run:

```rust
            share::commands::share_list,
            share::commands::share_create,
            share::commands::share_refresh,
            share::commands::share_revoke,
            share::commands::share_open,
```

- [ ] **Step 6: `web/route.rs`**

Route **`share_list` only.** The other four are network operations, and `route.rs:18-20` is
explicit that a network operation is not a routed command — it is a `web::glue`
`#[wasm_bindgen]` export instead. Publishing from the browser build is out of scope for v1; say so
in a comment beside the entry rather than leaving a reader to wonder.

```rust
    // The share cache, read-only. The other four `share_*` commands reach the network, which
    // `web::route` by construction does not — see this file's head.
    "share_list",
```
and the arm:
```rust
        "share_list" => encode(command, crate::share::cache::list(&crate::sync::lock_db_read(state))
            .map_err(RouteError::Failed)?),
```

A test asserts every `COMMANDS` name has a `match` arm, so adding one without the other is red.

- [ ] **Step 7: Run and commit**

```
cargo test --manifest-path src-tauri/Cargo.toml share::
cargo test --manifest-path src-tauri/Cargo.toml web::route
git add src-tauri/src
git commit -m "feat: publish, refresh and revoke a shared collection"
```

---

### Task 8: the `ipc.ts` mirror

**Files:**
- Modify: `src/lib/ipc.ts` — the header roster, three interfaces, five wrappers
- Modify: `src/lib/ipc.test.ts` — a raw import and one `describe`

**Interfaces:**
- Consumes: Task 7's five wire names and Task 3's `ShareSnapshot`.
- Produces, for Tasks 9–12: `ipc.shareList()`, `ipc.shareCreate(folderUid, ownerName, fields)`,
  `ipc.shareRefresh(id)`, `ipc.shareRevoke(id)`, `ipc.shareOpen(url)`, and
  `export interface ShareRow`.

**Read first:** `ipc.ts` is a hand-written mirror and the compiler checks none of it against the
crate. Three separate fences exist and a new command must satisfy the right ones.

- [ ] **Step 1: Write the failing tests**

In `src/lib/ipc.test.ts`, beside the `collection_folders` block at `:2364`:

```ts
/**
 * The five share commands.
 *
 * **`invoke` matches by name**, and `share.rs` renames to camelCase — so a wrapper spelling
 * `folder_uid` binds nothing and publishes the whole collection instead of one folder, with no
 * type error anywhere. That is the failure this block exists for, and it is worse than a
 * rejection: it is a publish that succeeds and shares more than the reader asked for.
 */
describe("the share wrappers name the commands `share/commands.rs` registers", () => {
  it("sends a folder share under `folderUid`, and a whole-collection share as null", async () => {
    invoke.mockResolvedValue({
      id: "kQ2p7fMx9Lb0RtVw", folderUid: "uid-1", title: "Trade binder",
      url: "https://share.example/s/kQ2p7fMx9Lb0RtVw", fields: ["value"],
      state: "live", published: 1_757_308_800, updatedAt: 1_757_308_800,
    });

    await ipc.shareCreate("uid-1", "Giradeli", { condition: true, lang: true, value: true });
    expect(invoke).toHaveBeenCalledWith("share_create", {
      folderUid: "uid-1",
      ownerName: "Giradeli",
      fields: { condition: true, lang: true, value: true },
    });

    // `null` is the whole collection, and it has to reach the wire as a value rather than as an
    // omitted key — an absent `folderUid` and an explicit null are the same on this wire only
    // because Rust reads `Option`; do not rely on it.
    await ipc.shareCreate(null, "Giradeli", { condition: false, lang: false, value: false });
    expect(invoke).toHaveBeenLastCalledWith("share_create", {
      folderUid: null,
      ownerName: "Giradeli",
      fields: { condition: false, lang: false, value: false },
    });
  });

  it.each([
    ["shareRefresh", "share_refresh"],
    ["shareRevoke", "share_revoke"],
  ] as const)("%s sends the id under `id`", async (method, command) => {
    invoke.mockResolvedValue({});
    await ipc[method]("kQ2p7fMx9Lb0RtVw");
    expect(invoke).toHaveBeenCalledWith(command, { id: "kQ2p7fMx9Lb0RtVw" });
  });

  it("shareList takes no arguments", async () => {
    invoke.mockResolvedValue([]);
    await ipc.shareList();
    expect(invoke).toHaveBeenCalledWith("share_list");
  });

  it("shareOpen sends the pasted link under `url`", async () => {
    invoke.mockResolvedValue({ v: 1, cards: [], folders: [] });
    await ipc.shareOpen("https://share.example/s/kQ2p7fMx9Lb0RtVw");
    expect(invoke).toHaveBeenCalledWith("share_open", {
      url: "https://share.example/s/kQ2p7fMx9Lb0RtVw",
    });
  });
});
```

Then a row in the **non-card** mirror block at `:3022+` (not the `mirrors` table — `ShareRow` has
no `imageUris` and fewer than ten fields, and that table asserts both):

```ts
import shareRs from "../../src-tauri/src/share/commands.rs?raw";
// …
["ShareRow", shareRs, "ShareRow"],
```

- [ ] **Step 2: Run to verify failure.** `npx vitest run src/lib/ipc.test.ts`

- [ ] **Step 3: Write the wrappers and interfaces**

`export interface ShareRow` with fields indented **exactly two spaces** — `tsFields`' regex is
`/^ {2}([A-Za-z0-9_]+)\??:/`, so a differently-indented field is silently invisible to the parser
and the fence passes over it.

Add `share/commands.rs` and `share/snapshot.rs` to the "Sources" roster in the file header
(`ipc.ts:11-52`). Every existing DTO has a line there.

- [ ] **Step 4: Run and commit**

```
npx vitest run src/lib/ipc.test.ts
git add src/lib/ipc.ts src/lib/ipc.test.ts
git commit -m "feat: mirror the five share commands"
```

---

## Phase 4 — the two viewers

### Task 9: the web viewer

**Files:**
- Create: `vite.share.config.ts`, `share/index.html`, `share/main.tsx`, `share/SharePage.tsx`,
  `share/ShareTile.tsx`, `share/SharePage.test.tsx`
- Modify: `package.json` (`share:build`), `tsconfig.json` (`include`), `eslint.config.js`,
  `.gitignore`

**Interfaces:**
- Consumes: Task 3's `parseSnapshot` and types, `@/components/CardArt`, `@/lib/images`.
- Produces: `dist-share/`, which Task 5's `assets` binding serves.

**Read `frontend-design` before writing any of the UI**, and the visual direction doc
`docs/superpowers/specs/2026-08-04-visual-design-direction.md`. The Storybook MCP server is not
connected this session, so check a component's own source before using a prop rather than
guessing one.

**What may be imported, and what may not.** This bundle has **no core**: no `ipc`, no
`src/lib/core`, no `src/workers`, no `src/pwa` beyond `target.ts`. Verified reusable, because
their import lists reach nothing else: `src/lib/images.ts`, `src/components/CardImage.tsx`,
`src/components/CardArt.tsx`, `src/components/CardChin.tsx`, and `CardGrid`'s exported pure
helpers `columnsFor` / `tileWidthFor` / `sideGutterFor`.

**`CardGrid` itself may not be reused** — it pulls `useAppStore`, `useCardSelection`,
`useCardZoomGesture` and `@/features/decks/dnd`, and its `Tile` is module-private. Write a thin
`ShareTile` instead:

```tsx
// `cardId={null}` makes `cardArtSrc` return the supplied URL on **every** build, so this tile
// never depends on the `mtgimg://` protocol the webview registers and a browser does not have.
<CardArt cardId={null} name={card.n} imageUrl={card.img} />
```
`CardArt` uses `useTooltip`, so a `TooltipProvider` must be above it.

- [ ] **Step 1: `vite.share.config.ts`**

⚠️ **The alias trap.** `resolve.alias` `"@": "/src"` is **root-relative in Vite**, so `root:
"share"` would resolve `@/…` against `share/`. Keep the project root and set the entry explicitly:

```ts
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

export default mergeConfig(
  base,
  defineConfig({
    // Root stays the repo root so `resolve.alias`' `"@": "/src"` keeps meaning `<repo>/src`.
    define: { __CORE__: JSON.stringify("web") },
    build: {
      outDir: "dist-share",
      emptyOutDir: true,
      rollupOptions: { input: "share/index.html" },
    },
    server: { port: 5174, strictPort: true },
  }),
);
```
Port 5174: not 1420 (`tauri dev`, hardcoded in tracked files), not 5173 (the web target), not 6006
(Storybook). All four must be able to run at once.

`__CORE__` **must** be defined — `src/lib/core/index.ts:42` and `src/pwa/target.ts:21` read it at
module scope and a bundle without it fails to build. `"web"` is right: it is what makes
`cardArtSrc` prefer the supplied URL.

`package.json`: `"share:build": "tsc && vite build --config vite.share.config.ts"`.
`tsconfig.json`: `"include": ["src", "share"]`.
`eslint.config.js` and `.gitignore`: `dist-share/`.

⚠️ **Do not widen `tsconfig.node.json`** — its comment says why.

- [ ] **Step 2: Write the failing test**

`share/SharePage.test.tsx`, rendering `SharePage` over the committed golden:

```tsx
it("names the owner and says the view is read-only", async () => {
  render(<TooltipProvider><SharePage snapshot={parseSnapshot(golden)} /></TooltipProvider>);
  expect(screen.getByText(/Giradeli/)).toBeInTheDocument();
  expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  // "anyone with this link" in words — spec section 5.1 requires the privacy claim be worded
  // this way and never "private" or "encrypted".
  expect(screen.getByText(/anyone with this link/i)).toBeInTheDocument();
});

it("draws a tile per card and files it under its folder", async () => {});

it("filters in the browser without refetching", async () => {});

it("says when a snapshot carries no prices rather than showing zeroes", async () => {
  // `fields` is on the wire precisely so "every card was NM" and "no condition was shared" are
  // different answers. A viewer that showed a blank column would collapse them.
});
```

- [ ] **Step 3: Run to verify failure, then write the page**

`main.tsx` reads the blob's URL out of the shell's `<link id="snapshot">` (Task 5 inlines it, so
there is no round trip to learn the hash), fetches it, and hands the text to `parseSnapshot`. On a
parse failure it draws the sentence, never a half-binder. A missing `<link>` is the
"not ready yet" state Task 5 renders, and the page says so rather than failing.

The page: owner and title in the header, the *as of* date, a folder rail, a search box, a
finish/condition filter, and the grid. Money only when `fields` contains `value`.

- [ ] **Step 4: Build it for real**

```
npm run share:build
```
Expected: `dist-share/` written, and no `@types/node` anywhere near it.

- [ ] **Step 5: Commit**

```
git add share vite.share.config.ts package.json tsconfig.json eslint.config.js .gitignore
git commit -m "feat: the shared collection web viewer"
```

---

### Task 10: the in-app view

**Files:**
- Create: `src/features/share/SharedPage.tsx`, `OpenShareDialog.tsx`, `useShares.ts`,
  `useSharedSnapshot.ts`, and a `.test.tsx` beside each component
- Modify: `src/lib/store.ts`, `src/App.tsx`, `src/components/nav.ts`, `src/components/nav.test.ts`,
  `src/lib/shortcuts.ts`

**Interfaces:**
- Consumes: Task 8's `ipc.share*`, Task 3's types.
- Produces, for Tasks 11 and 12: `useShares()` (query key `["share", "list"]`),
  `useSharedSnapshot(url)` (key `["share", "snapshot", url]`), and `<OpenShareDialog />`.

⚠️ **Adding an eighth view breaks two assertions, and one of them is silent about its cause.**
- `src/components/nav.test.ts:8-12` asserts the id array literally — add `"shared"` in the right
  position.
- `src/components/nav.test.ts:59-60` asserts
  `shortcut("global","switchView").chords` has `NAV.length` entries, because `AppShell` binds
  `Ctrl+1…7` **by index**. An eighth entry with no eighth chord makes the last destination
  unreachable from the keyboard. Add the chord in `src/lib/shortcuts.ts` and update
  `docs/reference/keyboard-shortcuts.md` in the same commit.

**Where it goes in `NAV`:** after `wishlist` and before `scanner`, so Settings stays last and the
three lists the reader owns stay together. That shifts Scanner's chord, which
`keyboard-shortcuts.md` has recorded happening before.

**The rail entry appears only once a share has been opened** (decision 6). The store gains a
persisted-in-`app_meta`-free, in-memory `openedShares: string[]`; `NAV` is filtered by it in
`AppShell` rather than in `nav.ts`, so the module stays a plain list and the test above keeps
asserting the whole set.

- [ ] **Step 1: Write the failing tests**

```tsx
it("is absent from the rail until a share has been opened", () => {});
it("cross-references every row against what the reader owns and wants", async () => {
  // "you own 2 · you want 3" — the two figures come from existing reads over
  // collection_entries and wishlist_entries keyed on the snapshot's scryfall id.
});
it("names the owner in the header of a share it did not publish", () => {});
it("has no write path at all", () => {
  // A source sweep over src/features/share/**, because the read-only guarantee is structural:
  // `lock_db_read` returns the WRITE connection on wasm and `writes.ts` is only about error
  // banners, so there is no read-only mode to lean on. Not having ipc writes IS the guarantee.
});
it("refuses a pasted link that is not a share URL, by sentence", () => {});
```

- [ ] **Step 2: Run to verify failure, then build the view**

- [ ] **Step 3: Run the whole frontend suite**

```
npx vitest run src/components/nav.test.ts src/App.test.tsx src/features/share
```
Expected: PASS. If `nav.test.ts` is red on the chord count, Step 1's warning is why.

- [ ] **Step 4: Commit**

```
git add src/features/share src/lib/store.ts src/App.tsx src/components/nav.ts src/components/nav.test.ts src/lib/shortcuts.ts docs/reference/keyboard-shortcuts.md
git commit -m "feat: open a shared collection inside the app"
```

---

### Task 11: the Share control on a collection folder

**Files:**
- Create: `src/features/collection/ShareFolderMenu.tsx` + `.test.tsx` + `.stories.tsx`
- Modify: `src/features/collection/CollectionPage.tsx` — mount it on a user folder

**Interfaces:** consumes Task 10's `useShares()` and Task 8's `ipc.share*`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("offers Share on a user folder and on the root, and on nothing else", () => {
  // Not on a deck group, not on `Recently removed` — the app-owned kinds, which
  // `CollectionPage.tsx:1358`'s `userFolders` already separates.
});

it("greys Share on a locked folder and says why in the row's name", () => {
  // A greyed menu row's accessible name includes its reason, so `getByRole` must ask for the
  // whole sentence rather than the verb.
});

it("shows the connect story rather than a nag when nothing is connected", () => {});

it("marks a share stale when its folder has since been locked, and does not auto-revoke", () => {
  // Revoking is the reader's press. Spec section 10.
});

it("copies the link and says so", () => {});
```

- [ ] **Step 2–4: implement, run, commit**

```
npx vitest run src/features/collection
git add src/features/collection
git commit -m "feat: share a collection folder from the cabinet"
```

---

### Task 12: want lists, and the Storybook fake

**Files:**
- Create: `src/features/share/AddToWishlist.tsx` + `.test.tsx`
- Modify: `.storybook/fake/db.ts` — one handler per new command
- Modify: `.storybook/CLAUDE.md` — if a fault or seed is added

**Read first:** `.storybook/fake/db.ts` is 16,768 lines and **ripgrep calls it binary** because of
a stray NUL, so a `grep` for a command name there returns nothing and that "no matches" is a lie.
Search it with `Select-String` in PowerShell.

Decision 8: ticking rows sends them to a wishlist folder the reader **already has**. That is
`wishlist_folders` and `wishlist_entries` used as they are — no new table, no new synced column,
no schema rung. A folder bound to a share id is deliberately out of v1; §8 of the spec says what
adding it later would cost.

- [ ] **Step 1: Write the failing tests**

```tsx
it("adds the ticked rows to an existing wishlist folder", async () => {});
it("offers only folders that already exist, and does not create one", async () => {});
it("counts what the reader already wants so a second add is not silent", async () => {});
```

- [ ] **Step 2: Add the fake handlers**

One per command, keyed by the snake_case wire name, beside `collection_folder_set_locked` at
`.storybook/fake/db.ts:11310`. The fake **stores rows and derives DTOs** — it must not store the
DTO, for the reason `.storybook/CLAUDE.md` gives.

Add a `shared` seed (a group with one published share) and a `shareLapsed` fault (a link that has
gone dark), and **update the seed and fault counts in `.storybook/CLAUDE.md` in the same commit** —
those lists have drifted before, and a prose-only edit routes to neither CI job.

- [ ] **Step 3: Run the story suite and commit**

```
npx vitest run src/stories.test.tsx
git add src/features/share .storybook
git commit -m "feat: build a want list from a shared collection"
```

---

### Task 13: the reference doc and the CLAUDE.md pointers

**Files:**
- Create: `docs/reference/collection-sharing.md`
- Modify: `CLAUDE.md` (the reference table), `src-tauri/CLAUDE.md`, `src/CLAUDE.md`,
  `docs/reference/collection-folders.md` (a pointer from the lock section),
  `docs/reference/sync.md` (a pointer from the relay section)

**Read first:** a prose-only edit routes to neither CI job, so nothing goes red when a document
rots. **Re-count every number in the same commit that changes one**, and better still, do not
write down a number a build already answers.

The reference doc holds: the format with every field and the six absences; the two `collection.rs`
traps and why the publisher has its own read; the Worker's routes, both tables and the R2 key
shape; the `live`/`lapsed`/`revoked` state machine and which pass moves it; **the measured
snapshot sizes from Task 1 Step 6, with the date and the build**; the free-plan request budget and
what the caching buys; and the bugs still open.

State plainly what is **not** deployed. `hosted-relay-deploy.md`'s own rule applies: ask the host,
never a document — five files once agreed the relay was undeployed and all five were wrong.

- [ ] **Step 1: Write it. Step 2: Add the table rows. Step 3: Commit**

```
git add docs CLAUDE.md src-tauri/CLAUDE.md src/CLAUDE.md
git commit -m "docs: the shared collections record"
```

---

## After the last task — the coordinator's checklist

1. `npm run verify` — **once, not per task, and never two at a time** (concurrent runs fake ~18
   Rust schema failures). Do not pipe it; its exit code lies through a pipe.
2. `cargo fmt --manifest-path src-tauri/Cargo.toml` and
   `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` — `verify`
   runs neither and CI runs both.
3. `npm run share:build` — not covered by `verify`.
4. Drive the real window over CDP for Tasks 10 and 11. A green suite and a green Storybook prove
   nothing about the shipped window, and every UI task in Plans 2–3 found something the suite
   could not.
5. Check the schema rung number against `main` before merging, and renumber if it collided.
6. PR body carries `Closes #360`. `--fill` drops it at two commits, so pass the body explicitly.
7. Comment the resolution on issue #360.

**What no agent may do:** deploy. `npx wrangler deploy`, `wrangler d1 execute --remote` and
`wrangler secret put` are Markus's. `wrangler dev --local` is the only wrangler command an agent
may run. The spec's §14 lists what only a live deploy can settle.
