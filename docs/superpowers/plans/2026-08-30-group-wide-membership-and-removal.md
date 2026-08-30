# Group-wide membership and a removal that reaches every device — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A removed device leaves the group on every device including itself, and any device in a group with a connected membership is entitled — so the Connect Patreon button becomes *Supporting since …* everywhere.

**Architecture:** A `relay_auth` derived one-way from the group key (HKDF-SHA256) lets any paired device mint its own relay token without holding the Patreon refresh secret. Removal rotates the group key, rewraps it per remaining device under that device's X25519 public key, and publishes the set to the relay — where the manifest's key set **is** the roster, so a device the manifest omits is a device that has left.

**Tech Stack:** Rust (rusqlite, `x25519-dalek`, `hkdf`, `sha2`, XChaCha20-Poly1305 via `crypto.rs`), Cloudflare Workers + D1 + vitest, React 19 + TypeScript 6, Storybook.

**Spec:** `docs/superpowers/specs/2026-08-30-group-wide-membership-and-removal-design.md` — read it before Task 4. Every design argument lives there; this plan does not repeat them.

## Global Constraints

- **Two PRs.** Tasks 1–3 are PR 1 and ship on their own. Tasks 4–14 are PR 2 and depend on a relay deploy.
- **`npm run verify` runs once, at fan-in, by the controller — never inside a subagent.** A subagent's slice compiles against a tree its siblings are still changing.
- **Subagents do not commit.** Parallel agents in one worktree share the git index; a bare `git commit` takes whatever a sibling staged. Each agent reports what it changed and the controller commits.
- **Never install `@types/node`.**
- **Adding a dependency with permissions means adding its narrowest permission, never its `:default`.** No new dependency is needed by this plan — `hkdf`, `sha2` and `x25519-dalek` are already in `src-tauri/Cargo.toml`.
- **The wire between the relay and Rust is unix *seconds* for `expires` and `since`.** The relay counts in milliseconds throughout and converts at the boundary. `entitlement::SECONDS_CEILING` refuses a millisecond value; do not weaken it.
- **Info strings follow the existing convention** in `src-tauri/src/sync_pair/crypto.rs:23-24`: `b"mtg-grimoire/<purpose>/v1"`.
- **`cargo fmt` and `cargo clippy` are not run by `npm run verify` but are run by CI.** Clippy caps a function at 7 arguments.
- **Every new test must be mutated once.** Break the implementation, confirm the test goes red, restore. Report any test that survived its mutation — that is a finding, not a formality.

---

# PR 1 — the two UI changes

Three tasks, no shared files, all three dispatchable at once.

---

### Task 1: Rust stops offering removed devices and stops answering `last_error`

**Files:**
- Modify: `src-tauri/src/sync_pair/pairing.rs` — the `status` function, around line 406
- Modify: `src-tauri/src/sync_engine/commands.rs` — `RelayStatus` (line 55-67) and `read_status` (line 85-110)

**Interfaces:**
- Consumes: nothing
- Produces: `RelayStatus` loses its `last_error: Option<String>` field. `PairingStatus.devices` contains only rows with `revoked_at IS NULL`.

- [ ] **Step 1: Write the failing test in `pairing.rs`'s test module**

```rust
/// A removed device is off the list the panel draws, and the roster underneath still has it.
///
/// **Two assertions and not one.** `identity::roster` is the record — `add_device` clears
/// `revoked_at` on a re-pair and `baseline::peers_needing` reads the mark — so a fix that
/// deleted the row would pass a test that only counted what the panel sees, and would quietly
/// hand a full baseline to a device that is never going to answer.
#[test]
fn a_removed_device_is_not_on_the_panels_list() {
    let conn = db();
    let me = crate::sync_pair::identity::ensure(&conn).unwrap();
    crate::sync_pair::identity::create_group(&conn, &me).unwrap();
    crate::sync_pair::identity::add_device(&conn, "deadbeef", &[7u8; 32], "Phone").unwrap();
    crate::sync_pair::identity::revoke_device(&conn, "deadbeef").unwrap();

    let drawn = status(&conn).unwrap();
    assert_eq!(
        drawn.devices.iter().map(|d| d.device_id.as_str()).collect::<Vec<_>>(),
        vec![me.device_id.as_str()],
        "the removed device is still being drawn"
    );
    assert_eq!(
        crate::sync_pair::identity::roster(&conn).unwrap().len(),
        2,
        "the roster itself must keep the row"
    );
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd src-tauri && cargo test a_removed_device_is_not_on_the_panels_list`
Expected: FAIL — the list holds two devices.

- [ ] **Step 3: Filter in `pairing::status`**

At `pairing.rs:406`, replace the `devices:` line:

```rust
        // **Filtered here rather than in `identity::roster`, which has other readers.** A
        // removed device is not a row of history the reader asked for; the reader asked for it
        // to be gone. The roster keeps the mark because `add_device` clears it on a re-pair and
        // `baseline::peers_needing` reads it — this is only what the panel draws.
        devices: identity::roster(conn)
            .map_err(err)?
            .into_iter()
            .filter(|d| d.revoked_at.is_none())
            .collect(),
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd src-tauri && cargo test a_removed_device_is_not_on_the_panels_list`
Expected: PASS. Report the number of tests the filter selected — a filter matching nothing exits 0.

- [ ] **Step 5: Drop `last_error` from `RelayStatus`**

In `commands.rs`, delete the `pub last_error: Option<String>,` field and its doc comment from `RelayStatus`, delete the `let last_error: Option<String> = conn.query_row(...)` block from `read_status`, and delete `last_error,` from the struct literal it builds.

Replace the struct's doc comment's final paragraph with:

```rust
/// **No `last_error` either, and its absence is the change rather than an omission.** It read
/// the newest `error_log` row with `source = 'relay'` — a row the Errors panel already draws —
/// so the panel rendered one failure twice, in two registers, under two headings. The record is
/// untouched: `errors::record(Source::Relay, …)` still writes every relay failure, and
/// `client::lapsed` still writes none, for spec §10's reason.
```

- [ ] **Step 6: Fix the tests that named the field**

Run: `cd src-tauri && cargo test sync_engine::commands 2>&1 | tail -40`
Any test constructing a `RelayStatus` literal or asserting on `last_error` needs the field removed. Do not delete a whole test to make it compile — if a test existed only to assert `last_error`'s behaviour, delete it and say so in your report.

- [ ] **Step 7: Mutate both changes**

Revert the filter (`.filter(|d| d.revoked_at.is_none())` → nothing) and confirm Step 1's test goes red. Restore. Report if it survived.

- [ ] **Step 8: Report**

Do not commit. Report: files changed, tests added, tests deleted and why, the mutation result, and the count of tests your `cargo test` filter selected.

---

### Task 2: The panel stops drawing removed rows and the relay-failure line

**Files:**
- Modify: `src/lib/ipc.ts` — `RelayStatus` (line 3956-3969) and `PairedDevice` (line 3908-3914)
- Modify: `src/features/settings/SyncPanel.tsx` — `DeviceRow` (line 172-263), the `lastError` paragraph (line 780-789)
- Modify: `src/features/settings/SyncPanel.test.tsx`

**Interfaces:**
- Consumes: nothing (types only; Task 1 makes the Rust agree)
- Produces: `RelayStatus` has no `lastError`. `PairedDevice.revokedAt` stays on the type — the backend still sends the column — but nothing renders it.

- [ ] **Step 1: Write the two failing tests**

Add to `SyncPanel.test.tsx`. `PAIRED` at line 87-89 already seeds a device with `revokedAt: 99` named `Old laptop`, and `RELAY_FAILED` at line 111 already seeds a `lastError`; use both.

```tsx
it("does not draw a device that was removed", async () => {
  render(<SyncPanel />, { wrapper: wrapper() });
  await screen.findByText("Phone");
  expect(screen.queryByText("Old laptop")).not.toBeInTheDocument();
  // The struck-through name is gone, so the word beside it must be too.
  expect(screen.queryByText("Removed")).not.toBeInTheDocument();
});

it("draws no relay-failure line, because the Errors panel holds the record", async () => {
  // RELAY_FAILED seeds `lastError`. Nothing on this panel may render it.
  render(<SyncPanel />, { wrapper: wrapper({ relay: RELAY_FAILED }) });
  await screen.findByText("Phone");
  expect(screen.queryByText(/last relay failure/i)).not.toBeInTheDocument();
});
```

Adjust `wrapper()` to whatever this file's existing helper signature is — read it first rather than assuming; it is at the top of the file.

- [ ] **Step 2: Run them and watch both fail**

Run: `npx vitest run src/features/settings/SyncPanel.test.tsx -t "removed"` then `-t "relay-failure"`
Expected: FAIL — both elements are present.

- [ ] **Step 3: Strip `DeviceRow`**

In `SyncPanel.tsx`, delete `const removed = device.revokedAt !== null;`, the `removed && "text-dim line-through"` class, the `{removed && <span …>Removed</span>}` line, and both `!removed &&` guards on the Rename and Remove buttons (keep `!isThisDevice` on Remove).

Delete the paragraph in `THIS_DEVICE_PILL`'s doc comment that begins **"`Removed` beside it stayed plain text"** — it argues for a thing that no longer exists, and a doc comment that describes absent markup fails the repo's token sweep.

- [ ] **Step 4: Delete the relay-failure paragraph**

Delete the whole `{status?.lastError != null && ( … )}` block at `SyncPanel.tsx:780-789`.

- [ ] **Step 5: Drop the type field**

In `src/lib/ipc.ts`, delete `lastError` and its doc comment from `RelayStatus` (line 3962-3966).

⚠️ **`ipc.ts` holds three `lastError` fields: line 3127, line 3892 and line 3966.** Only **3966** is `RelayStatus`. The other two are `SyncStatus` (Scryfall's) and `MirrorStatus` (the plain-text mirror's), and both have many consumers across the app. Delete by struct, never by grep.

- [ ] **Step 5b: Fix the two doc comments that name the field**

`SyncPanel.tsx:274` and `:288` both argue about `lastError` inside `relayState`'s doc comment — line 288 begins **"`failed` is the press this window made, never `RelayStatus.lastError`"**. The field is gone, so the paragraph now explains a distinction against something that does not exist. Rewrite both to argue the same point against what remains: a press that failed is this window's news, and the Errors panel further down the page is the record. **A field name in prose is not free** — this repo's token sweep reads doc comments as markup, so a comment naming a deleted field is a rot that no build catches.

- [ ] **Step 6: Fix the fixtures and the moot test**

`SyncPanel.test.tsx:102` and `:111` construct `RelayStatus` literals with `lastError`; remove the field. `RELAY_FAILED` at line 111 loses its only distinguishing field — if that fixture is now identical to another, delete it and point the new test at whichever fixture remains.

The test at line 785 asserts `lastError` never drives `relayState`. `relayState` never took it, so the assertion is now unreachable through the UI. Delete it and say so in your report.

- [ ] **Step 7: Run the file**

Run: `npx vitest run src/features/settings/SyncPanel.test.tsx`
Expected: PASS, both new tests included.

- [ ] **Step 8: Mutate**

Put `{removed && <span className="shrink-0 text-[0.6875rem] text-dim">Removed</span>}` back and confirm the first test goes red; restore. Put the `lastError` paragraph back and confirm the second goes red; restore. Report if either survived.

- [ ] **Step 9: Report**

Do not commit. Report files changed, tests added, tests deleted and why, and both mutation results.

---

### Task 3: The fake, the stories and the reference doc

**Files:**
- Modify: `.storybook/fake/db.ts` — the `relay` state (line 1824), the `RelayStatus`-shaped interface at line 1298-1300, and the `lastError` in the `sync_relay_status` handler at line 12351
- Modify: `.storybook/fake/seeds.ts` — line 1818, `db.relay = { pending: 3, lastSyncAt: null, lastError: null }`
- Modify: `.storybook/fake/db.test.ts` — any assertion on the **relay's** `lastError`
- Modify: `src/features/settings/SyncPanel.stories.tsx` — the `Paired` story (line 235-277)
- Modify: `docs/reference/sync.md` — §7.6, around line 255-295

**Interfaces:**
- Consumes: `RelayStatus` from Task 2 has no `lastError`
- Produces: nothing

⚠️ **`db.ts` holds three different `lastError` fields and you own exactly one of them.** `db.mirror.lastError` (lines 934, 1663, 6378, 12013) is the plain-text mirror's and **must not be touched**. `sync_status().lastError` (line 6153, and `db.test.ts:2250` and `:2253`) is Scryfall's and **must not be touched**. Only `db.relay.lastError` is this task's. **Bound your edit by grepping `db.relay`**, not by grepping `lastError`.

⚠️ **`.storybook/fake/seeds.ts` also holds the `paired` seed's roster at lines 1799-1810, and that roster keeps its removed `Old laptop` unchanged.** The backend still holds the row; the panel filtering it is exactly what Task 3's story now proves. Deleting the seeded device would make the story pass against a fixture that cannot fail. Read it, change only line 1818.

- [ ] **Step 1: Strip the fake**

Remove `lastError` from the `relay` state object (line 1824), from the `sync_relay_status` handler's return (line 12351), and from the `RelayStatus`-typed fixtures in `db.test.ts` at line 2250. Leave `syncError`'s fault alone — it drives `sync_status`, not the relay.

- [ ] **Step 2: Rewrite the `Paired` story**

The `paired` seed keeps its removed device in `db.pairing.devices` — the *backend* still holds the row, and the panel filtering it is exactly what this story now proves. Replace the two doc paragraphs that argue for drawing history, and the two assertions at line 256 and 275:

```tsx
    // The removed device is on the roster the backend holds and off the list the panel draws.
    // A reader who removed a device asked for it to be gone; the row survives only so a
    // re-pair can clear the mark and so the baseline trigger skips a peer that will not answer.
    await expect(canvas.queryByText("Old laptop")).not.toBeInTheDocument();
    await expect(canvas.queryByText("Removed")).not.toBeInTheDocument();
```

Delete `await expect(canvas.getByText("Old laptop")).toBeInTheDocument();` at line 256 and `await expect(canvas.getByText("Removed")).not.toHaveClass("rounded-full");` at line 275.

**`key version 2` stays.** The epoch is a count of rotations and the rotation still happened.

- [ ] **Step 3: Rewrite the story's doc comment**

Replace the paragraph beginning **"The removed device is still on the roster"** and the one beginning **"This is where the two marks are drawn side by side"** with:

```
 * **The removed device is on the roster and off the screen.** The `paired` seed still holds it,
 * because the backend still does — `add_device` clears the mark on a re-pair and the baseline
 * trigger reads it — and this story is where that separation is asserted. The key version beside
 * the group is `2` because the rotation *is* the removal, so the number is a count of them.
 *
 * **One mark per row, and it is `This device`** — orientation, the thing a reader scans a roster
 * for, and the question a real machine name leaves open once the rows stop reading identically.
```

- [ ] **Step 4: Rewrite §7.6 in `docs/reference/sync.md`**

Replace the paragraph **"The removed row is kept rather than deleted…"** with:

```markdown
**The removed row is kept in `sync_devices` and filtered out of what the panel draws.** It is kept
because `add_device` clears `revoked_at` on a re-pair and because `baseline::peers_needing` reads
the mark to skip a peer that will never answer — not so the roster can show history. A reader who
removed a device asked for it to be gone, and it is gone from the next render of the page.
```

Delete the paragraph quoting the *Last relay failure* line if §7.6 or its neighbours carry one; grep `sync.md` for `Last relay failure` and for `Removed` and reconcile every hit. **Re-count any list whose length you change** — a prose-only edit routes to neither CI job, so nothing goes red when a document rots.

- [ ] **Step 5: Run what you can**

Run: `npx vitest run .storybook/fake/db.test.ts`
Expected: PASS.
Story plays cannot be run during a fan-out — `stories.test.tsx` collects the whole tree and will fail for your siblings' reasons. Do not run it; the controller runs it at fan-in.

- [ ] **Step 6: Report**

Do not commit. Report files changed, and list every `sync.md` hit you reconciled.

---

### Task 4: PR 1 fan-in (controller only)

- [ ] **Step 1:** `npm run verify > verify.log 2>&1; grep -E "Tests|failed|error" verify.log` — never through a pipe to `tail`, whose exit code lies.
- [ ] **Step 2:** `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings` — neither runs in `verify` and both run in CI.
- [ ] **Step 3:** Commit as one change: `fix(sync): drop removed devices from the roster and the duplicate relay-failure line`.
- [ ] **Step 4:** Ship via the `shipping-a-branch` skill.

---

# PR 2 — group-wide membership and a removal that reaches everybody

Read the spec before starting. Waves: **Task 5 and Task 8 in parallel**, then **6, 7, 9 in parallel**, then **10**, then **11, 12** in parallel, then **13**.

---

### Task 5: The relay's group-key store

**Files:**
- Modify: `relay/schema.sql`
- Create: `relay/src/groupauth.ts`
- Create: `relay/src/groupauth.test.ts`

**Interfaces:**
- Consumes: `Env` from `relay/src/index.ts` (already exported)
- Produces:
  - `export const EPOCH_HISTORY = 8`
  - `export interface Manifest { epoch: number; keys: Record<string, string> }`
  - `export async function seedGroup(env: Env, group: string, epoch: number, auth: string): Promise<void>`
  - `export async function recordRotation(env: Env, group: string, epoch: number, auth: string, keys: Record<string, string>): Promise<boolean>` — `false` when `epoch` is not strictly higher than the stored one
  - `export async function currentManifest(env: Env, group: string): Promise<Manifest | null>`
  - `export async function authIsCurrent(env: Env, group: string, auth: string): Promise<boolean>`
  - `export async function authIsRecent(env: Env, group: string, auth: string): Promise<boolean>` — true for any auth within `EPOCH_HISTORY` epochs
  - `export function equalsConstantTime(a: string, b: string): boolean` — **import the one in `relay/src/token.ts` instead if it is exported; do not write a second.** Check first.

- [ ] **Step 1: Add the table to `relay/schema.sql`**

```sql
-- The group's relay key, per epoch, and the rewrapped keys that go with it.
--
-- **Two homes for one fact, and they answer different questions.** `entitlements.group_auth` is
-- what the group is RIGHT NOW and is what `/token`'s group door compares against; this table is
-- the HISTORY, and it exists because a device that is merely behind a rotation holds an auth
-- that is stale by definition. An endpoint that only accepted the current auth would refuse
-- exactly the devices it exists to serve.
--
-- **`keys` is the manifest and the key distribution in one column**: a JSON object of
-- `device_id -> sealed blob`. Its key SET is the roster at this epoch, which is what makes a
-- removal impossible to disagree about — there is no second table to arrive late or out of order.
-- A device the object does not name is a device that has left.
CREATE TABLE IF NOT EXISTS group_keys (
  group_id   TEXT    NOT NULL,
  epoch      INTEGER NOT NULL,
  auth       TEXT    NOT NULL,
  keys       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, epoch)
);

-- Read on every /keys and every /token group door, both by group alone.
CREATE INDEX IF NOT EXISTS group_keys_by_group ON group_keys (group_id, epoch DESC);
```

And the two columns on `entitlements`. **`schema.sql` is applied with `CREATE TABLE IF NOT EXISTS` against a live D1**, so the two new columns need `ALTER TABLE` statements at the foot of the file rather than edits to the `CREATE TABLE` body — a `CREATE TABLE IF NOT EXISTS` with new columns silently does nothing on a database that already has the table:

```sql
-- Added 2026-08-30. `ALTER TABLE` and not an edit to the CREATE above: that statement is
-- `IF NOT EXISTS` and does nothing at all on a database that already holds the table, so a new
-- column written there reaches a fresh deploy and never an existing one. D1 has no
-- `ADD COLUMN IF NOT EXISTS`; re-running these two on a database that has them is an error the
-- deploy runbook expects and ignores.
ALTER TABLE entitlements ADD COLUMN group_epoch INTEGER;
ALTER TABLE entitlements ADD COLUMN group_auth  TEXT;
```

- [ ] **Step 2: Write the failing tests**

`relay/src/groupauth.test.ts`. Follow `relay/src/claim.test.ts` for how it fakes `env.DB` — read that file first and reuse its harness rather than inventing one.

```ts
it("refuses a rotation that does not advance the epoch", async () => {
  const env = fakeEnv();
  await seedGroup(env, "g1", 0, "auth-0");
  expect(await recordRotation(env, "g1", 0, "auth-0b", {})).toBe(false);
  expect(await recordRotation(env, "g1", 1, "auth-1", { d1: "blob" })).toBe(true);
  expect(await recordRotation(env, "g1", 1, "auth-1b", {})).toBe(false);
});

it("accepts a recent auth and refuses one nine epochs old", async () => {
  const env = fakeEnv();
  await seedGroup(env, "g1", 0, "auth-0");
  for (let e = 1; e <= 9; e += 1) await recordRotation(env, "g1", e, `auth-${e}`, {});
  expect(await authIsCurrent(env, "g1", "auth-9")).toBe(true);
  expect(await authIsCurrent(env, "g1", "auth-8")).toBe(false);
  expect(await authIsRecent(env, "g1", "auth-8")).toBe(true);
  expect(await authIsRecent(env, "g1", "auth-0")).toBe(false);
});

it("never accepts another group's auth", async () => {
  const env = fakeEnv();
  await seedGroup(env, "g1", 0, "auth-0");
  await seedGroup(env, "g2", 0, "auth-0");
  expect(await authIsCurrent(env, "g1", "auth-0")).toBe(true);
  // Same string, different group. The lookup is by (group, auth) and never by auth alone —
  // an auth that opened any group would open every group that happened to collide.
  expect(await currentManifest(env, "g2")).not.toBeNull();
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `cd relay && npx vitest run src/groupauth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `groupauth.ts`**

`recordRotation` must be **one statement** for the monotonic check, for `handleClaim`'s reason — D1 has no interactive transaction, so a read-then-write is two round trips with a race between them:

```ts
const written = await env.DB.prepare(
  `INSERT INTO group_keys (group_id, epoch, auth, keys, created_at)
   SELECT ?, ?, ?, ?, ?
    WHERE ? > coalesce((SELECT max(epoch) FROM group_keys WHERE group_id = ?), -1)`,
)
  .bind(group, epoch, auth, JSON.stringify(keys), now, epoch, group)
  .run();
if (written.meta.changes === 0) return false;
```

Then prune, and mirror the current epoch onto the entitlement so `/token`'s group door is one lookup:

```ts
await env.DB.batch([
  env.DB.prepare(
    `DELETE FROM group_keys WHERE group_id = ? AND epoch <= ? - ?`,
  ).bind(group, epoch, EPOCH_HISTORY),
  env.DB.prepare(
    `UPDATE entitlements SET group_epoch = ?, group_auth = ? WHERE group_id = ?`,
  ).bind(epoch, auth, group),
]);
return true;
```

`authIsCurrent` compares against `entitlements.group_auth` for that group, in constant time. `authIsRecent` selects the auths in `group_keys` for that group and compares each in constant time — **never with `WHERE auth = ?`**, which is a timing oracle and also an index lookup on a secret.

- [ ] **Step 5: Run and watch them pass**

Run: `cd relay && npx vitest run src/groupauth.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutate**

Change `?` to `>=` in the monotonic `WHERE`; confirm the first test goes red. Change `EPOCH_HISTORY` to 9; confirm the second goes red. Restore both. Report survivors.

- [ ] **Step 7: Report** — do not commit.

---

### Task 6: `/rotate` and `/keys`

**Files:**
- Create: `relay/src/rotate.ts`
- Create: `relay/src/rotate.test.ts`
- Modify: `relay/src/index.ts` — `ROUTE`, `METHOD`, and the gate

**Interfaces:**
- Consumes: everything Task 5 produces; `Env` from `index.ts`
- Produces: `export async function handleRotate(request: Request, env: Env, group: string): Promise<Response>` and `export async function handleKeys(url: URL, env: Env, group: string): Promise<Response>`

⚠️ **These two routes must not reach the Durable Object.** They are D1 reads and writes in the Worker. `index.ts`'s bearer gate stands in front of the DO precisely because a request that reaches one costs a Durable Object request whether it is honoured or refused; routing a rotation through the DO would put the group's key distribution on the metered path for no reason.

- [ ] **Step 1: Write the failing tests** in `relay/src/rotate.test.ts`, covering: a rotation with the current auth accepted; with the refresh secret accepted; with a stale auth refused 401; with an equal epoch refused 409; `/keys` at the current epoch answering `blob: null` and the right manifest; `/keys` with a one-epoch-stale auth accepted; `/keys` with a nine-epoch-stale auth refused 401; and an unknown group answering 404.

- [ ] **Step 2: Run and watch them fail.** `cd relay && npx vitest run src/rotate.test.ts`

- [ ] **Step 3: Implement `handleRotate`**

Body `{ epoch: number, auth: string, keys: Record<string, string> }`. Authenticate with **either** the current group auth **or** the refresh secret, read from a `authorization: Bearer <secret>` header — the refresh secret is a credential and does not belong in a body beside the thing it authorises. Then `recordRotation`; `false` is a 409 with `{ error: "that rotation does not advance the group's key" }`.

Validate `keys`: every key must match `GROUP_SEGMENT`'s character class and every value must be a non-empty string under 4 KB. A manifest is at most 64 devices; refuse a larger one 400. **This is the one place a caller chooses how much the relay stores**, and an unbounded object here is an unbounded D1 row.

- [ ] **Step 4: Implement `handleKeys`**

`?device=<id>` is required and must match `GROUP_SEGMENT`'s class. Authenticate with `authIsRecent`. Answer `{ epoch, blob: keys[device] ?? null, devices: Object.keys(keys) }` from `currentManifest`; `null` for an unknown group is a 404.

- [ ] **Step 5: Route them in `index.ts`**

Extend `ROUTE` to `^/g/(${GROUP_SEGMENT})/(push|pull|ack|ws|rotate|keys)$` and add `rotate: "POST"`, `keys: "GET"` to `METHOD`. Then, **before** the bearer verification:

```ts
    // **Ahead of the bearer gate and never behind it, and that is the whole point of these two
    // routes.** A device that has just been rotated away from cannot mint a token — its auth is
    // stale — so a `/keys` behind the gate would refuse exactly the caller it exists to serve.
    // They carry their own credential, they are D1 only, and they never reach the Durable
    // Object, so nothing metered is exposed by their standing outside it.
    if (action === "rotate") return handleRotate(request, env, group);
    if (action === "keys") return handleKeys(url, env, group);
```

- [ ] **Step 6: Run and watch them pass.** `cd relay && npx vitest run src/rotate.test.ts src/index.test.ts` (run `index.test.ts` too if it exists; if not, say so).

- [ ] **Step 7: Mutate.** Move the two route lines *below* the bearer gate and confirm the stale-auth `/keys` test goes red. Restore. Report.

- [ ] **Step 8: Report** — do not commit.

---

### Task 7: `/claim` registers the group key, and `/token` grows its second door

**Files:**
- Modify: `relay/src/claim.ts` — `handleClaim` (line 457-528), `handleToken` (line 542-…), and `Grant`
- Modify: `relay/src/claim.test.ts`

**Interfaces:**
- Consumes: `seedGroup`, `authIsCurrent` from Task 5
- Produces: `/claim` accepts `{ code, group, epoch, auth }`. `/token` accepts `{ refresh }` **or** `{ group, auth }`, and the group-door answer omits `refresh`.

- [ ] **Step 1: Write the failing tests** — `/claim` rejecting a missing or non-integer `epoch` 400; `/claim` seeding `group_keys`; `/token` with a right group auth answering a grant **with no `refresh` field**; with a wrong auth 401; for a group with no entitlement 401; for a dead entitlement 401; and a declined-card grace window settled on the group door exactly as on the refresh door.

- [ ] **Step 2: Run and watch them fail.** `cd relay && npx vitest run src/claim.test.ts`

- [ ] **Step 3: Extend `handleClaim`**

Two more body fields, validated with the same care as `group`:

```ts
  if (typeof body.epoch !== "number" || !Number.isInteger(body.epoch) || body.epoch < 0) {
    return json({ error: "malformed claim" }, 400);
  }
  if (typeof body.auth !== "string" || !/^[0-9a-f]{64}$/.test(body.auth)) {
    return json({ error: "malformed claim" }, 400);
  }
```

After the binding `UPDATE` succeeds, call `seedGroup(env, group, body.epoch, body.auth)`. **After, not before** — a claim that is refused 409 must not register a key for a group it did not bind, or the next device to claim that group finds an auth it cannot match.

- [ ] **Step 4: Split the `Grant` type**

```ts
/**
 * What the refresh door answers. Unchanged.
 */
interface Grant {
  access: string;
  refresh: string;
  expires: number;
  status: Status;
  since: number;
}

/**
 * What the **group door** answers — the same thing minus the refresh secret, and the omission is
 * the point rather than an economy. A device that reached `/token` by proving it is in the group
 * has not proved anything about the Patreon account; handing it the credential that can revoke,
 * rebind and re-register would make every paired device able to evict every other one, which is
 * the failure `pairing.rs` dropping the secret from its blob exists to prevent.
 */
type GroupGrant = Omit<Grant, "refresh">;
```

- [ ] **Step 5: Add the group door to `handleToken`**

Branch on the body shape first, then share the settle-and-mint tail:

```ts
  // **The two doors, and the group one is looked up by `group_id` while the refresh one is
  // looked up by `refresh_secret`.** They must not be collapsed into one query with an `OR`: a
  // row is findable by either column, and an `OR` would let a caller presenting a *group id*
  // in the `refresh` field open a row whose secret they do not have.
```

The group door: reject unless `authIsCurrent(env, group, auth)`, then load the entitlement by `group_id`, `settle` it, revoke-and-401 on `dead` exactly as the refresh door does, stamp `checked_at`, and answer `grantFor(...)` with `refresh` deleted from the result.

- [ ] **Step 6: Run and watch them pass.** `cd relay && npx vitest run src/claim.test.ts`

- [ ] **Step 7: Mutate.** Make the group door skip the `authIsCurrent` check; confirm the wrong-auth test goes red. Make it return the full `Grant`; confirm the no-`refresh` test goes red. Restore both. Report.

- [ ] **Step 8: Report** — do not commit. **Name the exact JSON shape both doors now answer**; Task 9 deserialises it.

---

### Task 8: The two new crypto primitives

**Files:**
- Modify: `src-tauri/src/sync_pair/crypto.rs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `pub fn relay_auth(group_key: &[u8; 32], group_id: &str, epoch: i64) -> String` — 64 lowercase hex characters
  - `pub fn wrap_group_key(my_secret: &[u8; 32], their_public: &[u8; 32], group_id: &str, target_device: &str, epoch: i64, new_group_key: &[u8; 32]) -> Result<Vec<u8>, CryptoError>`
  - `pub fn unwrap_group_key(my_secret: &[u8; 32], their_public: &[u8; 32], group_id: &str, my_device: &str, epoch: i64, blob: &[u8]) -> Result<[u8; 32], CryptoError>`

⚠️ **`wrap_group_key` has six parameters and `unwrap_group_key` has six. Clippy caps at seven** — do not add a seventh without collapsing them into a struct.

- [ ] **Step 1: Write the failing tests**

```rust
/// The auth is a function of the key, the id and the epoch, and no two of the three may be
/// dropped from it.
#[test]
fn relay_auth_separates_every_input() {
    let k1 = [1u8; 32];
    let k2 = [2u8; 32];
    let a = relay_auth(&k1, "group-a", 0);
    assert_eq!(a.len(), 64, "64 hex characters");
    assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    assert_ne!(a, relay_auth(&k2, "group-a", 0), "a different key");
    assert_ne!(a, relay_auth(&k1, "group-b", 0), "a different group");
    // **The epoch, even though the key already changes with it.** A group key that was ever
    // reused across two epochs — a restore from backup, a bug — would otherwise yield one auth
    // for two epochs, and the relay's monotonic check is the only thing standing between a
    // removed device and re-entry.
    assert_ne!(a, relay_auth(&k1, "group-a", 1), "a different epoch");
    assert_eq!(a, relay_auth(&k1, "group-a", 0), "and it is deterministic");
}

/// The rewrapped key opens for the device it was sealed to, and **for nobody else** — which is
/// the one assertion the whole rotation scheme rests on.
#[test]
fn a_rewrapped_key_opens_only_for_its_target() {
    let remover = keypair();
    let target = keypair();
    let bystander = keypair();
    let new_key = [9u8; 32];

    let blob = wrap_group_key(
        &remover.secret, &target.public, "g1", "dev-target", 4, &new_key,
    )
    .expect("wrap");

    assert_eq!(
        unwrap_group_key(&target.secret, &remover.public, "g1", "dev-target", 4, &blob)
            .expect("the target opens it"),
        new_key
    );
    assert!(
        unwrap_group_key(&bystander.secret, &remover.public, "g1", "dev-target", 4, &blob).is_err(),
        "a device that is not the target must not open it"
    );
    // The AAD binds the device and the epoch, so a blob lifted from one row of the manifest and
    // presented as another device's does not open either.
    assert!(
        unwrap_group_key(&target.secret, &remover.public, "g1", "dev-other", 4, &blob).is_err(),
        "the target device is bound"
    );
    assert!(
        unwrap_group_key(&target.secret, &remover.public, "g1", "dev-target", 5, &blob).is_err(),
        "the epoch is bound"
    );
    assert!(
        unwrap_group_key(&target.secret, &remover.public, "g2", "dev-target", 4, &blob).is_err(),
        "the group is bound"
    );
}
```

- [ ] **Step 2: Run and watch them fail.** `cd src-tauri && cargo test sync_pair::crypto`

- [ ] **Step 3: Implement**

Add beside `INFO_PAIR` and `INFO_SAS`:

```rust
const INFO_RELAY_AUTH: &[u8] = b"mtg-grimoire/relay-auth/v1";
const INFO_ROTATE: &[u8] = b"mtg-grimoire/rotate/v1";
```

`relay_auth` extracts with the group id as salt and expands over `INFO_RELAY_AUTH` with the epoch appended — mirroring `pair_key`'s shape, where the values unique to *this* use go into the salt and the purpose goes into the info:

```rust
/// The credential a device presents to the relay to say "I am in this group".
///
/// **One-way from the group key, which is what makes it safe to send.** The relay stores this
/// and can invert nothing from it: it never learns the group key, so what it holds stays
/// ciphertext it cannot open. Every device in the group derives the same value without anything
/// being distributed, which is what makes an entitlement a property of the *group* rather than
/// of whichever device happened to open a browser.
///
/// **It changes with the epoch, and that is how a removal reaches the device that was removed.**
/// A rotation mints a new group key, so the auth derived from it is new too; the departed device
/// derives the old one, the relay has the new one, and the refusal is what sends it to `/keys` to
/// find out it is not on the manifest.
pub fn relay_auth(group_key: &[u8; 32], group_id: &str, epoch: i64) -> String {
    let hk = Hkdf::<Sha256>::new(Some(group_id.as_bytes()), group_key);
    let mut info = INFO_RELAY_AUTH.to_vec();
    info.push(b'|');
    info.extend_from_slice(epoch.to_string().as_bytes());
    let mut out = [0u8; 32];
    hk.expand(&info, &mut out)
        .expect("32 bytes is far below HKDF-SHA256's output limit");
    out.iter().map(|b| format!("{b:02x}")).collect()
}
```

`wrap_group_key` does one ECDH, one HKDF over `INFO_ROTATE`, and one `seal` with AAD `group_id\0target_device\0epoch` — `\0` and not `|`, for `wire::aad`'s reason. `unwrap_group_key` is the mirror and must return `Err(CryptoError)` rather than panicking on a blob of the wrong length.

- [ ] **Step 4: Run and watch them pass.** `cd src-tauri && cargo test sync_pair::crypto` — report the selected test count.

- [ ] **Step 5: Mutate.** Drop the epoch from `relay_auth`'s info; confirm the epoch assertion goes red. Drop `target_device` from the AAD; confirm the device assertion goes red. Restore both. Report.

- [ ] **Step 6: Report** — do not commit.

---

### Task 9: The entitlement's group door

**Files:**
- Modify: `src-tauri/src/sync_engine/entitlement.rs`

**Interfaces:**
- Consumes: `crypto::relay_auth` (Task 8); the JSON shape Task 7 reported
- Produces:
  - `pub fn store_access(conn: &Connection, access: &str, expires: i64) -> Result<(), String>` — writes `ACCESS_TOKEN` and `ACCESS_EXPIRES` and **never touches `REFRESH_SECRET`**
  - `access_token` unchanged in signature, with a second path

- [ ] **Step 1: Write the failing tests**

Follow the existing endpoint tests in this file — they stand a server on localhost through the `client::RELAY_URL` override. Cover: a device with no refresh secret but a group mints through the group door and stores `status` and `since`; a 401 on the group door does **not** `revoke` on the first refusal; and `store_access` leaves an existing refresh secret alone.

⚠️ **The no-revoke-on-first-401 test is the one that matters.** A 401 on the group door is ambiguous — it is a lapse *or* a rotation this device has not caught up with — and treating it as a lapse would show *Membership ended* to a reader whose only problem is that a sibling device removed somebody an hour ago.

- [ ] **Step 2: Run and watch them fail.** `cd src-tauri && cargo test sync_engine::entitlement`

- [ ] **Step 3: Add `GroupGrant` and `store_access`**

```rust
/// What the **group door** answers: [`Grant`] without the refresh secret.
///
/// A separate struct rather than an `Option<String>` on `Grant`, because [`store_grant`] refuses
/// an empty refresh secret today and should keep refusing one — an access token with no refresh
/// secret beside it reads as disconnected, and the guard that catches that mistake must not be
/// weakened to accommodate a case that is not a mistake.
#[derive(Debug, Clone, Deserialize)]
struct GroupGrant {
    access: String,
    expires: i64,
    status: String,
    #[serde(default)]
    since: Option<i64>,
}
```

- [ ] **Step 4: Add the group path to `access_token`**

The existing early return `let Some(refresh) = refresh_secret(conn) else { return Ok(None) };` becomes a branch: with a secret, today's behaviour unchanged; without one, derive the auth from the group and post to `/token`. A device in **no group and with no secret** still answers `Ok(None)` — that is where every existing installation stands and it is not an error.

```rust
    // **A 401 here is not automatically a lapse, and that is the difference from the refresh
    // door.** The group auth is derived from the group key, so a rotation this device has not
    // caught up with produces exactly the same refusal a cancelled membership does. Calling
    // `revoke` on it would tell a reader their membership ended because a *sibling device*
    // removed somebody. The caller checks `/keys` and asks again; only the second refusal, with
    // the epoch confirmed current, is a lapse.
```

Answer a distinguishable error — a `pub const STALE_GROUP_AUTH: &str` this module owns — so `client` can act on it without matching a sentence.

- [ ] **Step 5: Run and watch them pass.** Report the selected count.

- [ ] **Step 6: Mutate.** Make the group-door 401 call `revoke`; confirm the no-revoke test goes red. Make `store_access` write `REFRESH_SECRET`; confirm its test goes red. Restore. Report.

- [ ] **Step 7: Report** — do not commit.

---

### Task 10: Identity — adopt, leave, and a removal that commits last

**Files:**
- Modify: `src-tauri/src/sync_pair/identity.rs`

**Interfaces:**
- Consumes: `crypto::{relay_auth, wrap_group_key, unwrap_group_key}` (Task 8)
- Produces:
  - `pub struct Rotation { pub group: Group, pub keys: Vec<(String, Vec<u8>)>, pub auth: String }`
  - `pub fn plan_rotation(conn: &Connection, removing: &str) -> Result<Rotation, String>` — mints the key **in memory** and rewraps for everyone who stays; **writes nothing**
  - `pub fn commit_rotation(conn: &Connection, removing: &str, rotation: &Rotation) -> Result<(), String>` — writes the group, re-arms `baselined_at`, **deletes** the removed row
  - `pub fn adopt_epoch(conn: &Connection, from_device: &str, epoch: i64, blob: &[u8], manifest: &[String]) -> Result<(), String>` — unwraps, writes the group, deletes every roster row the manifest omits
  - `pub fn leave_group(conn: &Connection) -> Result<(), String>` — clears `sync_group` and `sync_devices`, keeps `sync_identity`
  - `pub const NO_MEMBERSHIP: &str` — the fourth refusal

⚠️ **`revoke_device`'s current signature and behaviour go away.** Its three existing refusals (self, no group, not on the roster) move into `plan_rotation`. Its callers are `sync_pair::pairing::sync_device_revoke` and its own tests; Task 11 rewires the command.

- [ ] **Step 1: Write the failing tests**

Three, and the third is the one this whole PR exists for.

```rust
/// A planned rotation writes nothing — which is what stops the app holding a key rotation the
/// relay never accepted, and it is the difference from `revoke_device` as it stood.
#[test]
fn planning_a_rotation_changes_no_row() {
    let conn = db();
    let me = ensure(&conn).unwrap();
    create_group(&conn, &me).unwrap();
    add_device(&conn, "phone", &[9u8; 32], "Phone").unwrap();
    add_device(&conn, "tablet", &[8u8; 32], "Tablet").unwrap();

    let before = group(&conn).unwrap().unwrap();
    let plan = plan_rotation(&conn, "tablet").expect("plan");

    assert_eq!(group(&conn).unwrap().unwrap(), before, "the group moved");
    assert_eq!(count(&conn, "sync_devices"), 3, "a row was written");
    // The plan itself really did mint something, or the assertions above are about nothing.
    assert_eq!(plan.group.epoch, before.epoch + 1);
    assert_ne!(plan.group.group_key, before.group_key);
    // One blob per device that STAYS — this one and the phone — and never for the departing
    // one. A manifest naming the removed device would put it back in the group it just left.
    assert_eq!(plan.keys.len(), 2);
    assert!(plan.keys.iter().all(|(id, _)| id != "tablet"));
    assert_eq!(
        plan.auth,
        crate::sync_pair::crypto::relay_auth(
            &plan.group.group_key,
            &plan.group.group_id,
            plan.group.epoch
        )
    );
}

/// A device the manifest omits is off the roster, and the row is **deleted** rather than
/// stamped — because the manifest is the roster, and a tombstone here would make this device
/// the only one in the group with a different answer about who is in it.
#[test]
fn adopting_an_epoch_drops_everyone_the_manifest_omits() {
    // B's database: it is in a group with A and with a tablet.
    let b = db();
    let me_b = ensure(&b).unwrap();
    let remover = crate::sync_pair::crypto::keypair();
    create_group(&b, &me_b).unwrap();
    add_device(&b, "dev-a", &remover.public, "Desk").unwrap();
    add_device(&b, "tablet", &[8u8; 32], "Tablet").unwrap();
    let before = group(&b).unwrap().unwrap();

    // A rotated, removing the tablet, and sealed the new key to B.
    let new_key = [42u8; 32];
    let epoch = before.epoch + 1;
    let blob = crate::sync_pair::crypto::wrap_group_key(
        &remover.secret,
        &me_b.keypair.public,
        &before.group_id,
        &me_b.device_id,
        epoch,
        &new_key,
    )
    .unwrap();

    adopt_epoch(
        &b,
        "dev-a",
        epoch,
        &blob,
        &[me_b.device_id.clone(), "dev-a".to_owned()],
    )
    .expect("adopt");

    let after = group(&b).unwrap().unwrap();
    assert_eq!(after.epoch, epoch);
    assert_eq!(after.group_key, new_key, "B did not take the new key");
    assert_eq!(after.group_id, before.group_id, "the group id must not move");

    let ids: Vec<String> = roster(&b).unwrap().into_iter().map(|d| d.device_id).collect();
    assert!(!ids.contains(&"tablet".to_owned()), "the tablet is still here");
    assert_eq!(ids.len(), 2, "and nobody else was swept");
    // Deleted, not stamped. A stamped row would still satisfy the assertion above.
    assert_eq!(count(&b, "sync_devices"), 2);
}

/// **Three devices, and the case that is broken on `main`.** A removes C; B adopts the
/// rewrapped key and reaches A's epoch, so an envelope A seals is one B can open. Before this
/// PR nothing distributes the key: B stalls at the old epoch, `client::pull` sets
/// `behind = true` and holds its cursor for ever, and one removal bricks any group of three.
///
/// It asserts against `wire`, not against the epoch number, because the number agreeing is not
/// the property that matters — being able to read what the group says is.
#[test]
fn a_third_device_adopts_the_rotated_key_and_catches_up() {
    use crate::sync_engine::wire;

    let a = db();
    let me_a = ensure(&a).unwrap();
    create_group(&a, &me_a).unwrap();

    let b = db();
    let me_b = ensure(&b).unwrap();
    let start = group(&a).unwrap().unwrap();
    join_group(&b, &me_b, &start).unwrap();
    add_device(&a, &me_b.device_id, &me_b.keypair.public, "Phone").unwrap();
    add_device(&b, &me_a.device_id, &me_a.keypair.public, "Desk").unwrap();
    add_device(&a, "tablet", &[8u8; 32], "Tablet").unwrap();
    add_device(&b, "tablet", &[8u8; 32], "Tablet").unwrap();

    // A removes the tablet and the rotation is accepted by a relay this test stands in for.
    let plan = plan_rotation(&a, "tablet").expect("plan");
    commit_rotation(&a, "tablet", &plan).expect("commit");

    // What A now says is unreadable to B until B adopts — the bug, asserted before the fix.
    let ops = vec![crate::sync_engine::merge::Op::default()];
    let envelope = wire::seal_batch(&group(&a).unwrap().unwrap(), &me_a.device_id, &ops).unwrap();
    assert!(
        wire::open_batch(&group(&b).unwrap().unwrap(), &envelope).is_err(),
        "B could already read this, so the test proves nothing"
    );

    let blob = plan
        .keys
        .iter()
        .find(|(id, _)| id == &me_b.device_id)
        .map(|(_, blob)| blob.clone())
        .expect("B is on the manifest");
    let manifest: Vec<String> = plan.keys.iter().map(|(id, _)| id.clone()).collect();
    adopt_epoch(&b, &me_a.device_id, plan.group.epoch, &blob, &manifest).expect("adopt");

    assert_eq!(
        wire::open_batch(&group(&b).unwrap().unwrap(), &envelope).expect("B opens it"),
        ops,
        "B adopted the key and still cannot read A"
    );
    assert!(
        !roster(&b).unwrap().iter().any(|d| d.device_id == "tablet"),
        "and the removal reached B's roster"
    );
}
```

`db()` is `crate::schema::memory_pair()` and `count` is the helper this test module already has.
`join_group` and `Op::default()` may need their real spellings checked before you run — read the
neighbouring tests rather than trusting these two names, and say in your report if either was wrong.

- [ ] **Step 1b: Fix the two existing tests that assert the old removal**

`removing_a_device_changes_no_row_it_contributed` (around line 1238) asserts *"the removed device
stays on the roster"* and `departed.revoked_at.is_some()`. Invert both: the row is gone. **Keep
every other assertion in it untouched** — that a removal changes no row the departed device
contributed is spec §12.3 and is still true.

`a_rotation_re_arms_the_baseline_for_the_devices_that_remain` (around line 1265) reads
`baselined_at` for the departed device. That row no longer exists; assert its absence instead of
its marker, and keep both surviving-peer assertions exactly as they are.

- [ ] **Step 2: Run and watch them fail.** `cd src-tauri && cargo test sync_pair::identity`

- [ ] **Step 3: Implement the five functions.** `commit_rotation` deletes:

```rust
    // **Deleted, not stamped, and this reverses §7.6.** The relay's manifest is the roster now
    // (spec §2.3), so a device the manifest omits has no row on any *other* device — and a
    // remover that kept a tombstone would be the one machine in the group with a different
    // answer about who is in it. `baseline::peers_needing` reads `WHERE revoked_at IS NULL`,
    // which a deleted row satisfies just as well, and `add_device` still puts a re-paired
    // device back — by insert now rather than by clearing the stamp.
    tx.execute("DELETE FROM sync_devices WHERE device_id = ?1", params![removing])?;
```

The `revoked_at` column stays in the schema for the migration's sake and stops being written. Do **not** add a schema rung to drop it.

- [ ] **Step 4: Run and watch them pass.** Report the selected count.

- [ ] **Step 5: Mutate.** Make `commit_rotation` write the group *before* the caller could have failed — i.e. fold it back into `plan_rotation` — and confirm the first test goes red. Make `adopt_epoch` skip the manifest sweep; confirm the second goes red. Restore. Report.

- [ ] **Step 6: Report** — do not commit. **Name the exact signatures you produced**; Task 11 calls all five.

---

### Task 11: The client checks for a key, and the command commits a removal

**Files:**
- Modify: `src-tauri/src/sync_engine/client.rs` — `round_trip`, plus a `keys` and a `rotate` request
- Modify: `src-tauri/src/sync_engine/commands.rs` — `SupporterStatus`
- Modify: `src-tauri/src/sync_pair/pairing.rs` — `sync_device_revoke`

**Interfaces:**
- Consumes: Tasks 8, 9, 10 in full
- Produces: `SupporterStatus.connected` renamed `entitled`; `pub async fn check_keys(conn: &Connection) -> Result<KeyOutcome, String>` where `KeyOutcome` is `Current | Adopted | Removed`

- [ ] **Step 1: Write the failing tests** in `src-tauri/src/sync_engine/client/tests.rs`, against the localhost server that file already stands up: a `/keys` answering the current epoch changes nothing; one answering a higher epoch with a blob adopts it; one answering a higher epoch with `blob: null` leaves the group; and a `sync_device_revoke` whose `/rotate` answers 500 leaves the group **exactly** as it was.

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Add `check_keys` and call it from `round_trip`**

First thing inside `round_trip`, above the token fetch — it is the one request that must work when the token cannot be minted:

```rust
    // **Before the token, and that ordering is the whole reason this call exists.** A device
    // that has been rotated away from cannot mint a token: its group auth is stale, so
    // `access_token` answers `STALE_GROUP_AUTH` and every route below is closed to it. `/keys`
    // is the one door that accepts a recent auth, and it is what tells the difference between
    // a device that is merely behind — which adopts and carries on — and one that has been
    // removed, which is not on the manifest and leaves.
```

`KeyOutcome::Removed` calls `identity::leave_group` and answers `Ok(None)` from the round trip: there is no longer anything to sync to, and that is not an error.

- [ ] **Step 4: Rewire `sync_device_revoke`**

Round trip without baselines (unchanged), then `plan_rotation`, then `POST /g/{group}/rotate`, then `commit_rotation` **only on 2xx**. A group with no entitlement answers `identity::NO_MEMBERSHIP` before the round trip, so a reader is refused before anything moves.

- [ ] **Step 5: Rename `connected` to `entitled`**

In `commands.rs`, `SupporterStatus.connected` becomes `entitled`, and `supporter_status` computes it as "this device holds a refresh secret **or** is in a group the relay has minted a token for" — the stored `SUPPORTER_STATUS` being `active` or `grace` is that signal. Rewrite the field's doc comment; the table in it is still right, with `entitled` in the first column.

⚠️ **Rename it rather than changing its meaning in place.** A call site that quietly kept reading "holds a refresh secret" would compile and be wrong.

- [ ] **Step 6: Run.** `cd src-tauri && cargo test sync_engine` — report the selected count.

- [ ] **Step 7: Mutate.** Make `sync_device_revoke` commit before the POST; confirm the 500 test goes red. Restore. Report.

- [ ] **Step 8: Report** — do not commit.

---

### Task 12: Pairing stops carrying the refresh secret

**Files:**
- Modify: `src-tauri/src/sync_pair/pairing.rs` — `confirm` (around line 272-295) and `complete` (around line 330-390)

**Interfaces:**
- Consumes: nothing
- Produces: the sealed blob's plaintext becomes `<group_id>\0<epoch>\0<32-byte key>`

⚠️ **Do not start this until Task 11 has reported**, because both touch `pairing.rs`. If the controller dispatches them together, take the second one yourself after the first lands.

- [ ] **Step 1: Update the tests that assert the secret crosses**

`the_sealed_key_carries_the_refresh_secret_to_the_joiner` (line 1028) and `a_zero_byte_in_the_group_key_does_not_swallow_the_refresh_secret` (line 1067) both assert the old behaviour. Invert the first — the joiner must hold **no** refresh secret — and delete the second, which tests a separator that no longer exists. `an_empty_refresh_does_not_take_the_joiners_own_membership_away` (line 1109) becomes a stronger claim: **pairing never touches the joiner's grant at all.**

⚠️ **Audit every mock and fixture in this file after the reversal.** A mock that encodes the old truth stays green for ever.

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Drop the field.** Remove `entitlement::refresh_secret` from `confirm`'s plaintext and the third `parts.next()` from `complete`'s parse, and delete the `store_grant(conn, PAIRED_ACCESS, &refresh, 0)` call and the `PAIRED_ACCESS` constant. Rewrite the doc comment at line 238-245 to say what now happens instead: the joiner reaches the relay on its own group auth and is told its status by `/token`.

- [ ] **Step 4: Run and watch them pass.** Report the selected count.

- [ ] **Step 5: Mutate.** Put the field back in `confirm` only; confirm the parse in `complete` goes red rather than silently mis-reading the key. **If it does not, say so loudly** — a length-mismatched parse that yields a wrong key is the worst failure this file can have.

- [ ] **Step 6: Report** — do not commit.

---

### Task 13: The panel, the types, the fake and the stories

**Files:**
- Modify: `src/lib/ipc.ts` — `SupporterStatus`
- Modify: `src/features/settings/SyncPanel.tsx` — `supporterState`, `CONNECT_ORDER`
- Modify: `src/features/settings/SyncPanel.test.tsx`
- Modify: `src/features/settings/SyncPanel.stories.tsx`
- Modify: `.storybook/fake/db.ts`

**Interfaces:**
- Consumes: `SupporterStatus.entitled` from Task 11
- Produces: nothing

- [ ] **Step 1: Write the failing test**

```tsx
it("offers no Connect button on a device entitled through its group", async () => {
  // Paired, no refresh secret of its own, and the relay has told it the membership is live —
  // which is what a second device looks like once the first one has connected.
  render(<SyncPanel />, {
    wrapper: wrapper({
      supporter: { entitled: true, status: "active", since: 1_740_000_000, groupBound: true },
    }),
  });
  expect(await screen.findByText(/supporting since/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /connect patreon/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Rename the field** in `ipc.ts` and in `supporterState`, and rewrite both doc comments. `supporterState`'s logic is unchanged — `entitled` is asked first for exactly the reason `connected` was.

- [ ] **Step 4: Rewrite `CONNECT_ORDER`**

The trap it warns about is gone: a device can now be paired first and connected second, and both devices end up entitled. Replace it with the one thing that is still true — connecting founds a group of one when this device is in none, so a device that has connected can invite but cannot join:

```tsx
const CONNECT_ORDER =
  "Connecting puts this device in a sync group of its own if it is not in one yet, and a " +
  "device can only be in one group. If your other devices already sync together, pair this " +
  "one to them first — then a membership on any of them covers all of them.";
```

- [ ] **Step 5: Update the fake.** `db.ts`'s supporter fixtures and any seed naming `connected`. Add a seed for a device entitled through its group.

- [ ] **Step 6: Add a story** for the second device — paired, no secret, *Supporting since …*, no Connect button. Call `mcp__mtg-grimoire-sb-mcp__get-storybook-story-instructions` before writing it, and `preview-stories` after; include every preview URL in your report.

- [ ] **Step 7: Run.** `npx vitest run src/features/settings/SyncPanel.test.tsx .storybook/fake/db.test.ts`. **Do not run `stories.test.tsx`** — it collects the whole tree and fails for your siblings' reasons.

- [ ] **Step 8: Mutate.** Make `supporterState` ask `status` before `entitled`; confirm a test goes red. Restore. Report.

- [ ] **Step 9: Report** — do not commit.

---

### Task 14: Documentation

**Files:**
- Modify: `docs/reference/sync.md` — §7.6, the schema section, and "What is still owed"
- Modify: `docs/reference/hosted-relay-deploy.md` — the two `ALTER TABLE`s and the two new routes
- Modify: `CLAUDE.md` — the sync paragraph's claim about what is deployed
- Modify: `src-tauri/CLAUDE.md` — if it names `revoke_device` or the pairing blob's layout

⚠️ **`tauri dev` watches `src-tauri/CLAUDE.md`.** Editing it restarts a running app and kills anybody's CDP pass. Check with the controller before touching that file.

- [ ] **Step 1:** Rewrite §7.6 for the new removal: the rewrap hop, the manifest as the roster, the delete rather than the stamp, the fourth refusal, and the removed device leaving on its own.
- [ ] **Step 2:** Strike **"A revoked device's rewrapped key over the relay"** from "What is still owed" (line ~1278) — it is built. Strike the sentence at line ~1244 saying two devices that revoked each other cannot recover.
- [ ] **Step 3:** Add a section for the group door: why an entitlement is a property of a group, what the relay learns, and what it still cannot.
- [ ] **Step 4:** **Re-count every list whose length you change.** A prose-only edit routes to neither CI job.
- [ ] **Step 5: Report** — do not commit. List every file and every count you re-derived.

---

### Task 15: PR 2 fan-in (controller only)

- [ ] **Step 1:** `npm run verify > verify.log 2>&1` then grep the summary — never pipe to `tail`.
- [ ] **Step 2:** `cd relay && npx vitest run && npx tsc --noEmit`
- [ ] **Step 3:** `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings`
- [ ] **Step 4:** Story plays: `npx vitest run src/stories.test.tsx`. Budget a fix round — a fan-out this size usually breaks plays in files nobody touched.
- [ ] **Step 5:** Deploy the relay: `cd relay && npx wrangler d1 execute mtg-grimoire-relay --remote --file=./schema.sql` then `npx wrangler deploy`. The two `ALTER TABLE`s error on a second run; that is expected.
- [ ] **Step 6: The live pass, and nothing ships without it.** On the real desktop and the real phone: **(a)** pair first, connect second, and watch the phone's panel reach *Supporting since …* without being touched; **(b)** add a third device, remove it from the desktop, and confirm it is gone from all three screens — including its own, which should read *not paired with anything yet*; **(c)** confirm the phone's pull cursor advances past the epoch boundary rather than stalling.
- [ ] **Step 7:** Record what the pass found in `docs/reference/sync.md`, with the date and the build.
- [ ] **Step 8:** Ship via the `shipping-a-branch` skill.

---

## Self-review notes

- **Spec coverage.** §2.1 → Tasks 5, 8. §2.2 → Tasks 7, 9, 12. §2.3 → Tasks 5, 6, 10. §2.4 → Tasks 10, 11. §2.5 → Tasks 9, 11, 13. §3 → Tasks 1, 2, 3. §4's failure table → the tests named in 6, 7, 9, 10, 11. §5 → every task's own test step plus Task 15's live pass. §6 lists what is deliberately absent.
- **The one thing the spec asks for that no task fully closes** is the ⚠️ in §2.3 about a claimed-but-never-rotated group. It is covered by Task 6's `/keys` current-epoch test and Task 11's `KeyOutcome::Current` test, and by Task 10's `adopt_epoch` only being called on a strictly higher epoch — three places, none of them a single named test for the empty-manifest case. **Task 11's first test must assert it explicitly**: a group at epoch 0 with an empty manifest leaves every device alone.

---

## Wave findings — read before Task 11

Recorded as each wave landed. These are corrections to this plan, not suggestions.

### From wave 1

- **There is no vitest config in `relay/`.** Relay tests run from the **repo root** through the
  root vitest's `relay/src/**/*.test.ts` glob. Every `cd relay && npx vitest` in this plan is
  wrong.
- **The D1 fake lives at `relay/src/fakeD1.ts`** and exports `fakeEnv(...groups: string[]): Env`.
  It *evaluates* the SQL rather than matching statement shapes, which is the only reason the
  monotonic guard's mutation goes red at all. Import it; never write a second. It is not named
  `*.test.ts` so vitest does not collect it, and nothing in the Worker's entry graph imports it.
- **`equalsConstantTime` is exported from `groupauth.ts`.** `token.ts`'s copy is private.
- **`currentManifest` throws** on a manifest that will not parse rather than answering `{}` — an
  empty manifest at a higher epoch is positive evidence of removal, so `{}` would evict every
  device in a group nobody was removed from. `handleKeys` lets it 500.
- ⚠️ **This plan's own `EPOCH_HISTORY` test could not fail.** Its four assertions read identically
  whether the window was 8 or 9, because epoch 0 is outside both. The assertion that pins the
  width is `authIsRecent("auth-1") === false`. **Ask of every remaining test what value would make
  it red**, and prove it by mutation where unsure.

### From wave 2 — Task 11 owns both of these

- ⚠️ **`sync_engine::client::tests::no_grant_means_no_request_at_all` (`client/tests.rs:303`) now
  fails, and that is the design working.** It uses `paired("dev-a", 0)` — a device in a group with
  no grant — and asserts no request is made. Spec §2.2 reverses exactly that premise: a paired
  device with no secret now mints through the group door, and no local signal could gate it,
  because once Task 12 lands a pairing-joined device holds no status either. **Task 11 reconciles
  it**: either give the fixture a grant, or invert it into "a device with **no group** and no
  secret makes no request", which is what `entitlement`'s own
  `no_group_and_no_secret_is_still_sync_off` already covers.
- ⚠️ **`entitlement::membership_ended` now reads `true` for a group-entitled device.** It is
  `refresh_secret.is_none() && SUPPORTER_STATUS.is_some()`, and a device entitled through its group
  holds a status and no secret. `commands.rs` computes `group_bound = connected || membership_ended`,
  so the panel would draw *Membership ended* over an `active` status. The `entitled` rename fixes
  the panel because the first row of §10's table wins — but **the function's name and doc now
  over-claim** ("the one function that separates the two silences"), and Task 11 should correct
  them in the same change rather than leave a comment that is no longer true.
- **`post_for_grant` is generic now** (`<T: DeserializeOwned>`) rather than concrete over `Grant`.
  The `Grant`/`GroupGrant` split forces it; the plan did not mention it.
- **`#[serde(default)]` on an `Option<T>` field is decorative** — serde's derive already treats
  `Option` as optional, proven by mutation. It is documentation, not behaviour, on `Grant.since`
  as well. Do not rely on removing it to make a test red.
