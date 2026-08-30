# Leaving a group and five devices to an account — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A device can leave its group, always; an account is capped at five devices, enforced by the relay.

**Architecture:** Leaving reuses #307's rotation whole — `plan_departure` is a second entrance to the same private `plan`, and the local clear runs whatever the relay answered. One `group_devices` table answers both caps, because a subject holds exactly one group; both `/token` doors carry a device id; slots free through the manifest that #307 already made the roster.

**Tech Stack:** Rust (rusqlite, `x25519-dalek`, `hkdf`), Cloudflare Workers + D1 + vitest, React 19 + TypeScript 6.

**Spec:** `docs/superpowers/specs/2026-08-30-leave-group-and-device-caps-design.md` — read it before any task.

## Global Constraints

- **`npm run verify` runs once, at fan-in, by the controller — never inside a subagent.**
- **Subagents do not commit.** Parallel agents share the git index here.
- **Relay tests run from the repo root** (`npx vitest run relay/src/…`); there is no vitest config in `relay/`.
- **The D1 fake is `relay/src/fakeD1.ts`** and exports `fakeEnv`, `fakeTables`, `fakeEnvOver`. It *evaluates* SQL rather than matching shapes. Import it; never write a second.
- **`cargo test <filter>` exits 0 when the filter matches nothing** — always report "running N tests".
- **`cargo fmt` and `cargo clippy --all-targets -- -D warnings` are not in `npm run verify` and are in CI**, plus `clippy --target wasm32-unknown-unknown --lib` for every-target modules.
- ⚠️ **Never write a file through a Bash heredoc.** It silently injected NUL bytes into a Rust source file in this session — it compiled, passed clippy, and made `grep` treat the file as binary. Use Write/Edit; script edits go in a file first, building backslashes from `chr(92)`.
- ⚠️ **A full-file rewrite on Windows can hand the file back as CRLF**, breaking source-parsing tests locally while CI stays green. Check with `python -c "b=open(P,'rb').read(); print(b.count(b'\r'), b.count(b'\x00'))"` — both must be 0. Count bytes; do **not** use `grep -qU $'\r'`, which false-positived on three clean files.
- ⚠️ **Mutate every test you write and report survivors.** Four agents on the previous PR found checks that *could not fail*, including one of that plan's own prescribed tests. For each test, state what value would make it red.
- ⚠️ **After reversing a behaviour, audit every other test and fixture for one encoding the old truth.**
- **A 403 is the cap and a 401 is a lapse.** The app clears the grant on a 401. Never refuse the cap with one.

---

## Wave A — Tasks 1 and 2 in parallel

### Task 1: The relay's device roll

**Files:** `relay/schema.sql`, `relay/migrations/2026-08-30-group-devices.sql` (create), `relay/src/groupauth.ts`, `relay/src/groupauth.test.ts`, `relay/src/fakeD1.ts`

**Produces** — the contract Tasks 3 and 4 call:
```ts
export const MAX_GROUP_DEVICES = 5;
export const DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Count the live rows, pruning anything past the TTL. */
export async function liveDeviceCount(env: Env, group: string, nowMs: number): Promise<number>;
/** Upsert last_seen. Answers false when this is a NEW device and the group is already full. */
export async function admitDevice(env: Env, group: string, device: string, nowMs: number): Promise<boolean>;
/** Delete rows this manifest does not name. Called by /rotate. */
export async function keepOnly(env: Env, group: string, devices: string[]): Promise<void>;
/** Drop every row for a group. Called when a binding moves. */
export async function forgetGroup(env: Env, group: string): Promise<void>;
```

- [ ] **Step 1: The table**, in `schema.sql` **and** a re-runnable migration file beside `2026-08-30-group-keys.sql`. Read that file's header first — it explains why a migration exists at all (`--file` is atomic, so a failing `ALTER` reverts the `CREATE` above it).
```sql
CREATE TABLE IF NOT EXISTS group_devices (
  group_id   TEXT    NOT NULL,
  device_id  TEXT    NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (group_id, device_id)
);
CREATE INDEX IF NOT EXISTS group_devices_by_group ON group_devices (group_id);
```

- [ ] **Step 2: Teach the fake the new primary key.** `fakeD1.ts`'s `PRIMARY_KEY` map gains `group_devices: ["group_id", "device_id"]`, and `fakeTables` seeds `group_devices: []`.

  ⚠️ **Without this the cap's most important test is vacuous**: "a device already counted does not consume a second slot" would pass against a table that cannot hold a duplicate anyway. Add the key, then prove the test can fail by removing it.

- [ ] **Step 3: Write the failing tests.** At minimum: a count of 4 admits a fifth; a count of 5 refuses a *new* sixth; a count of 5 **admits an existing device again** (and does not grow the table); a row older than `DEVICE_TTL_MS` is not counted **and is gone afterwards**; `keepOnly` deletes exactly the unnamed; `forgetGroup` empties one group and leaves another alone.

  For each, state what makes it red. **The TTL one is the trap**: `nowMs` is a parameter, so assert with a stamp far in the past rather than by waiting, and make sure the assertion would fail if the TTL were doubled.

- [ ] **Step 4: Implement.** `liveDeviceCount` prunes and counts in that order. `admitDevice` is one `INSERT … ON CONFLICT DO UPDATE SET last_seen = ?` after the count, so a returning device never trips the cap.

- [ ] **Step 5: Run.** `npx vitest run relay/src`, `npx tsc -p tsconfig.relay.json --noEmit`, `npx eslint relay/src --max-warnings 0`.

- [ ] **Step 6: Mutate.** Drop the prune from `liveDeviceCount`; drop the `ON CONFLICT` so a returning device inserts; halve `MAX_GROUP_DEVICES`. Each must go red. **Report survivors.**

- [ ] **Step 7: Report** — signatures, test counts, mutation results, and anything the spec got wrong.

---

### Task 2: Leaving, and the pairing refusal

**Files:** `src-tauri/src/sync_pair/identity.rs`, `src-tauri/src/sync_pair/pairing.rs`

**Produces:**
```rust
// identity
pub fn plan_departure(conn: &Connection) -> Result<Rotation, String>;  // manifest excludes this device
pub const GROUP_IS_FULL: &str;                                          // the sixth-device refusal
// pairing
async fn leave_group_now(conn: &Connection) -> Result<(), String>;
#[tauri::command] pub async fn sync_group_leave(...) -> Result<(), String>;
```

- [ ] **Step 1: Extract the shared body.** `plan_rotation` and `plan_departure` both call one private `fn plan(conn, removing: &str) -> Result<Rotation, String>`. **`plan_rotation` keeps its self-refusal** — see the spec §2.1: removing somebody else and leaving yourself are different acts, and collapsing them lets a mis-click on a roster row throw this device's key away.

- [ ] **Step 2: Write the failing tests.**
  - `a_departure_names_everyone_but_this_device` — red if the manifest includes self, or omits a peer.
  - `plan_rotation_still_refuses_to_remove_this_device` — red if the guard is relaxed rather than bypassed.
  - `leaving_clears_the_group_even_when_the_relay_refuses` — the whole of "always possible". Drive it against the `client::RELAY_URL` override with a 500. Red if the clear is behind the POST's success.
  - `leaving_clears_the_group_when_the_relay_accepts` — ⚠️ **write this one too.** Without it, "always possible" is satisfiable by never publishing at all, and the test above would not notice.
  - `leaving_clears_the_grant` — `entitlement::clear`, never `revoke`; red if `membership_ended` reads true afterwards.
  - `pairing_refuses_a_sixth_device` — red if the guard counts revoked rows, or is off by one at five.

- [ ] **Step 3: Implement.** `leave_group_now` is: `plan_departure` → `client::post_rotation` (**best effort — swallow the error**) → `identity::leave_group` **and** `entitlement::clear`, unconditionally.

- [ ] **Step 4: The pairing cap.** `confirm` and `complete` refuse when `roster().iter().filter(|d| d.revoked_at.is_none()).count() >= 5`. **Count live rows only** — a stale tombstone from a pre-#307 build must not cost a reader a slot.

- [ ] **Step 5: Run.** `cargo test sync_pair`, then `cargo test sync_` for the blast radius. `cargo fmt`, both clippy targets.

- [ ] **Step 6: Mutate.** Move the local clear behind the POST's success; relax `plan_rotation`'s guard; make the pairing count include revoked rows. Report survivors.

- [ ] **Step 7: Report** — signatures, counts, mutations, and **any test outside your files that your change breaks** (report, do not fix).

---

## Wave B — Tasks 3, 4, 5 and 6 in parallel

### Task 3: Both doors carry a device, and `/claim` rebinds

**Files:** `relay/src/claim.ts`, `relay/src/claim.test.ts`

**Consumes:** Task 1's exports. **Produces:** `/token` accepts `{refresh, device}` **or** `{group, auth, device}`; `/claim` accepts `{code, group, epoch, auth, device}`.

- [ ] **Step 1: Failing tests** — a sixth device refused **403 and never 401**; the refresh door counted too (spec §4.2: the connecting device never reaches the group door, so a cap that skipped it would never count the one device certainly signed in); an existing device re-admitted at the cap; a re-claim onto a **different** group moving the binding and calling `forgetGroup` + `dropGroup`; another **subject** on one group id still 409.
- [ ] **Step 2:** Validate `device` with the same care as `group` — it reaches a D1 write.
- [ ] **Step 3:** Implement. **`admitDevice` is called only on a token that would otherwise be issued** — never before the status settle, or a dead membership would consume a slot.
- [ ] **Step 4:** Run the relay suites, tsc, eslint.
- [ ] **Step 5: Mutate** — refuse the cap with 401; skip the refresh door's admit; make a re-claim keep the old group's rows. Report survivors.
- [ ] **Step 6: Report** — **the exact JSON both doors now accept**, since a Rust sibling sends it.

---

### Task 4: `/rotate` caps the manifest and frees the slots

**Files:** `relay/src/rotate.ts`, `relay/src/rotate.test.ts`

- [ ] **Step 1: Failing tests** — a manifest of 6 refused; of 5 accepted; a rotation calling `keepOnly` so an omitted device's row goes; a rotation **not** touching another group's rows.
- [ ] **Step 2:** `MAX_DEVICES` 64 → `MAX_GROUP_DEVICES` imported from `groupauth.ts`. **One constant, not two** — a cap spelled twice is a cap that disagrees with itself.
- [ ] **Step 3:** `keepOnly` after `recordRotation` succeeds, never before: a refused rotation must free nothing.
- [ ] **Step 4:** Run, mutate (raise the cap; call `keepOnly` before the record; pass the wrong group), report.

---

### Task 5: The app sends its device id

**Files:** `src-tauri/src/sync_engine/entitlement.rs`

- [ ] **Step 1: Failing tests** — both doors send `device`; a **403** answers a distinguishable error and **does not** clear the grant (`membership_ended` still false); a 401 behaves exactly as it does today.

  ⚠️ **The 403 is the one to get right.** `access_token`'s 401 path clears the grant, and routing the cap through it would tell a reader at their sixth device that their membership had ended.
- [ ] **Step 2:** Add `pub const GROUP_IS_FULL: &str` and a `device` field on both bodies, read from `identity::ensure`.
- [ ] **Step 3:** Run `cargo test sync_engine::entitlement`, fmt, both clippy targets.
- [ ] **Step 4: Mutate** — treat 403 as 401; drop `device` from the refresh door. Report survivors.

---

### Task 6: Leave group in the panel

**Files:** `src/lib/ipc.ts`, `src/features/settings/SyncPanel.tsx`, `SyncPanel.test.tsx`, `SyncPanel.stories.tsx`, `.storybook/fake/db.ts`, `.storybook/fake/seeds.ts`

**Consumes:** `sync_group_leave` from Task 2.

- [ ] **Step 1: Failing tests** — Leave group is drawn on a paired device and **not** on an unpaired one; it asks for confirmation; the confirmation carries the two things a reader must know before pressing (this device keeps its own collection; the others may still list it if the relay could not be reached).
- [ ] **Step 2:** Wire `ipc.syncGroupLeave`, a `ConfirmDialog`, and invalidate `SYNC_KEY` on success.
- [ ] **Step 3: The re-claim warning.** Spec §3: a re-claim onto a new group orphans the devices left in the old one. **Draw that beside the claim-code field**, before the press — it is the one place a reader can do this by accident.
- [ ] **Step 4:** Story for a paired device showing Leave group. Call `get-storybook-story-instructions` first and `preview-stories` after; include every URL.
- [ ] **Step 5:** Run `npx vitest run src/features/settings/SyncPanel.test.tsx .storybook/fake/db.test.ts`, `tsc --noEmit`, eslint. **Do not run `src/stories.test.tsx`** — it collects the whole tree and fails for a sibling's reasons.
- [ ] **Step 6: Mutate** — draw Leave group unconditionally; drop the confirmation. Report survivors.

---

## Wave C

### Task 7: Documentation

**Files:** `docs/reference/sync.md`, `docs/reference/hosted-relay-deploy.md`, `src-tauri/CLAUDE.md`, `CLAUDE.md`, `relay/README.md`

- [ ] Leaving, in §7.6 beside removal — including that the leaver mints the key it does not keep, and why that is not new exposure.
- [ ] The rebinding reversal: `/claim` moves a binding, what that costs the old group, and that the 409 survives for another *subject*.
- [ ] The caps: one table, both doors, the relay as the fence and the client as the message, and how a slot frees.
- [ ] The runbook gains the `group_devices` migration beside the `group_keys` one, and step 0's probe list gains nothing — the new table is reached through `/token`, which already has a probe.
- [ ] `identity::CANNOT_REMOVE_SELF` now points at a real control; say so where §7.6 records the refusals, and **re-count that list** (it went three → four in #307).
- [ ] ⚠️ **Re-count every list whose length you change, and do not write down a number a build already answers.**

---

### Task 8: Fan-in (controller only)

- [ ] `npm run verify > verify.log 2>&1` then grep the summary — never pipe to `tail`, whose exit code lies.
- [ ] `cargo fmt --check`; `clippy --all-targets -D warnings`; `clippy --target wasm32-unknown-unknown --lib`.
- [ ] `npx vitest run src/stories.test.tsx relay/src`.
- [ ] Byte-check every touched file for NUL and CR.
- [ ] Deploy: the two migration files, then `npx wrangler deploy`. **Verify against the host, not an exit code** — `hosted-relay-deploy.md` step 2.
- [ ] The live pass: leave the group on the phone and watch the desktop's roster lose it. That is what found #307's migration gap on its first press.
