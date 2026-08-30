# Group-wide membership, and a removal that reaches every device

**2026-08-30.** Four changes the reader asked for on 2026-08-30, after driving the shipped
pairing flow on a real desktop and a real phone:

1. A removed device stays on the roster as `Removed` for ever. It should be gone the next time
   the page is opened.
2. Removing a device removes it **on the device that pressed the button and nowhere else**. It
   should leave the group everywhere — on every remaining device, and on the removed device
   itself.
3. The *Connect Patreon* button is still drawn on a second device after the first one has
   connected and the two are paired. A group with any connected device is entitled, so every
   device in it should read *Supporting since …*.
4. The *Last relay failure* paragraph in the Sync panel should go; a relay failure belongs in
   the Errors panel with every other failure.

Items 1 and 4 are UI. Items 2 and 3 are one protocol change wearing two faces, and this document
is mostly about them.

---

## 1. What is there now

### 1.1 The relay's gate

Every `/g/{group}/…` route is behind a bearer token the relay mints
(`relay/src/index.ts`). A token is minted by `/claim` (once, against a ten-minute code) and by
`/token` (thereafter, against a long-lived **refresh secret**). The refresh secret is the only
credential that reaches `/token`, and it is stored in `entitlements.refresh_secret` against a
subject the relay minted for one Patreon member.

That gate is not protecting the reader's ciphertext — the relay can decrypt nothing it holds. It
is protecting the account's bill, which is what `index.ts`'s own module doc says: a stranger who
guessed a group id can spend somebody else's Durable Object requests.

### 1.2 How a second device becomes entitled

`sync_pair::pairing` seals the refresh secret into the pairing blob (spec §6.2,
`pairing.rs:287`), so a device that joins a group whose host has already connected is entitled
without opening a browser. `pairing::complete` calls `entitlement::store_grant` with a
placeholder access token and the carried secret, and **does not call `store_status`** — so that
device holds no `status` and no `since`, and `supporterNote` draws the dateless *Supporting.
Thank you.* rather than *Supporting since …*.

**And that is the good case.** If the reader pairs first and connects second — the natural
order, and the one `CONNECT_ORDER` in `SyncPanel.tsx` exists to warn against — the second device
gets nothing, and can never get anything. Reaching the relay needs a token; a token needs the
refresh secret; the refresh secret travels only in a pairing blob. The loop is closed, and
nothing in the app says so. **That is item 3.**

### 1.3 What a removal does

`identity::revoke_device` (`identity.rs:574`) stamps `revoked_at`, re-arms `baselined_at` for
everyone who stays, and rotates the group key — all in one transaction, on the device that
pressed the button.

**Nothing distributes the new key.** `docs/reference/sync.md:1278` already lists this under what
is owed: *"A revoked device's rewrapped key over the relay. §7.6's rotation is PR 6's and works;
the hop that hands the new key to the remaining devices is not built."* The consequences are
worse than that bullet makes them sound:

- The **removed** device hears nothing. It keeps its group row, its key and its roster, and its
  panel still says it is in a group of *n*.
- The **remaining** devices hear nothing either. They are still at epoch *N*; the removing
  device now pushes at *N+1*; `client::pull` sees `envelope.epoch > group.epoch`, sets
  `behind = true` and **holds the cursor** (`client.rs:424`) so the page is re-delivered until
  the key arrives. It never arrives. **One removal bricks any group of three.**

A group of two survives only because the one device that still matters is the one that rotated.

**That is item 2**, and it cannot be honoured without building the hop.

---

## 2. The design

### 2.1 The group's relay key

Every device in a group holds the group key. Nothing derived from it may be sent to the relay in
a form the relay can invert, and nothing needs to be:

```
relay_auth = HKDF-SHA256(
    ikm  = group_key,                                   -- 32 bytes, never leaves the devices
    salt = group_id,
    info = "mtg-grimoire/relay-auth/v1|" || epoch,
)                                                       -- 32 bytes, sent as lowercase hex
```

`crypto.rs` already carries `Hkdf<Sha256>` for `pair_key` and `sas`; this is a third
`INFO_` constant beside those two and no new dependency.

**The epoch is in the `info` even though the key already changes with it.** Belt and braces: a
group key that was ever reused across two epochs — by a restore-from-backup, by a bug — would
otherwise yield one auth for two epochs, and the monotonic check in §2.3 is the only thing
standing between a removed device and re-entry.

The relay stores it, and can invert nothing from it. Two places, because the two answer different
questions:

```sql
-- What the group is at RIGHT NOW. One row per entitlement, read by /token's group door.
ALTER TABLE entitlements ADD COLUMN group_epoch INTEGER;
ALTER TABLE entitlements ADD COLUMN group_auth  TEXT;    -- hex, the current epoch's

-- The history, and the rewrapped keys. One row per (group, epoch), read by /keys.
CREATE TABLE IF NOT EXISTS group_keys (
  group_id   TEXT    NOT NULL,
  epoch      INTEGER NOT NULL,
  auth       TEXT    NOT NULL,          -- that epoch's relay_auth
  -- The manifest AND the key distribution in one column: {"<device_id>": "<blob>", …}.
  -- Its key set is the roster at this epoch, which is what §2.3 leans on.
  keys       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, epoch)
);
```

**The history exists so that a device which is merely behind can still fetch the key that catches
it up.** Its auth is one epoch stale by definition, so an endpoint that only accepted the current
one would refuse exactly the devices it exists to serve. `/rotate` prunes anything older than
eight epochs in the same statement that writes the new row, so the history is bounded without a
sweep.

`/claim` gains two body fields, `epoch` and `auth`, writes them onto the entitlement, and seeds
`group_keys` with an empty manifest at that epoch. A claim is the first moment the relay is told
about a group at all, so it is the right place — and it is the **only** place a group's first
auth can come from, which is what §2.4's "no membership, no removal" rests on.

### 2.2 `/token` gets a second door

Today `POST /token` takes `{refresh}`. It gains a second accepted shape:

| Body | Who sends it | Answer |
| --- | --- | --- |
| `{refresh}` | the device that pressed Connect | `{access, refresh, expires, status, since}` — unchanged |
| `{group, auth}` | **any device in the group** | `{access, expires, status, since}` — **no refresh secret, ever** |

The group door looks the row up by `group_id`, compares `auth` against `group_auth` in constant
time, settles the status exactly as the refresh door does (a closed grace window is resolved
here, not merely reported), and mints the same token.

**This is the whole of item 3.** A device that has only ever paired can now mint its own token,
which means it can sync, and the answer carries `status` and `since` — so `store_status` runs
and the panel reads *Supporting since …*, dated, on every device in the group. "If a group has
any device signed into Patreon, all the devices in the group are valid" becomes a property of
the protocol rather than a thing pairing happened to carry.

**`pairing.rs` stops sealing the refresh secret into the blob.** It no longer needs to, and
keeping it would be actively harmful: a device that holds the refresh secret can re-register the
group auth (§2.3) and therefore evict the devices that removed it. Restricting the Patreon-side
secret to the device that pressed Connect is what makes a removal stick. The blob's plaintext
loses one field and one separator.

The cost, stated plainly: a freshly paired device draws *Supporting since …* after its first
relay call rather than instantly. `SyncPanel` already re-reads `SUPPORTER_KEY` under the
`["sync"]` root when a round trip finishes, so the window is one sync.

### 2.3 Rotation, and the manifest that is the roster

Two new routes on the group. Both live in the Worker against **D1**, not inside the Durable
Object, so a rotation never touches the metered log path.

```
POST /g/{group}/rotate
  body   { epoch, auth, keys: [ { device, blob }, … ] }
  auth   the CURRENT group auth, or the refresh secret
  refuse 409 unless epoch > stored group_epoch

GET  /g/{group}/keys?device=<id>
  auth   any auth this group has registered in the last 8 epochs
  answer { epoch, blob | null, devices: [ id, … ] }
```

Each `blob` is the new group key sealed for one device:

```
kek  = HKDF-SHA256(ikm  = X25519(remover_secret, target_public),
                   salt = group_id,
                   info = "mtg-grimoire/rotate/v1|" || epoch)
blob = seal(kek, aad = group_id || 0 || target_device || 0 || epoch, new_group_key)
```

`sync_devices.public_key` is already every peer's X25519 public key, and the target already
holds the *remover's* public key on its own roster — so nothing new crosses in the clear and no
key material is published the target cannot already authenticate.

**The device list at the current epoch is the roster.** A device that adopts epoch *N+1* deletes
every `sync_devices` row not on that list. This is what carries item 2 to the remaining devices,
and it is deliberately not a thirteenth synced table: a manifest that *is* the key distribution
cannot disagree with it, where a synced `device_removals` table could arrive late, arrive out of
order, or arrive at a device that cannot decrypt it — which is precisely the state a rotation
puts every peer in.

**A device with no blob at the current epoch was removed.** That is positive evidence, and it is
the reason `/keys` accepts a stale auth: "behind a rotation" and "removed" otherwise produce an
identical stale-auth 401, and a device that guessed wrong would either leave a group it is still
in or sit for ever in one it is not.

⚠️ **The manifest is consulted only when the answered epoch is strictly higher than this
device's, and that guard is load-bearing.** A group that has claimed but never rotated has one
`group_keys` row with an empty manifest, so every device in it reads `blob: null` and
`devices: []`. Comparing the epochs first is the whole of what stops every device in a
never-rotated group concluding it has been removed and dissolving the group on its next sync.
Equal epochs mean *nothing to do*, and the manifest is not read at all.

### 2.4 What each side does

**The device that presses Remove** (`identity::revoke_device`, and the order matters):

1. Round trip first, so the departing device's last push is absorbed — unchanged, `client.rs:571`.
2. Mint the new key and epoch **in memory**.
3. Rewrap it for every device that stays.
4. `POST /g/{group}/rotate`.
5. **Only on success**, commit: write the new group, re-arm `baselined_at` for everyone who
   stays, and **delete** the departed row.

Today step 5 happens first and unconditionally, which is how the app comes to hold a rotation
nobody else can see. A failed POST now leaves the group exactly as it was and reports a refusal
the reader can retry.

**The row is deleted rather than stamped, and that is a reversal of §7.6.** The manifest is the
roster (§2.3), so a device the manifest omits has no row on any *other* device — and a remover
that kept a `revoked_at` tombstone would be the one machine in the group with a different answer
about who is in it. `baseline.rs` reads `WHERE revoked_at IS NULL`, which a deleted row satisfies
just as well; `add_device` still puts a re-paired device back, now by insert rather than by
clearing the stamp. The column stays for the migration's sake and stops being written.

⚠️ **A group with no membership cannot remove a device, and the press says so.** `/rotate`
authenticates against an auth that only `/claim` can seed, so an unentitled group has no way to
publish a rotation — and rotating locally anyway is exactly today's bug: the removing device
moves to epoch *N+1* and every other device stalls at *N* the moment somebody finally connects.
A fourth refusal joins `revoke_device`'s three, in the same register:

> Removing a device changes the key your devices share, and that change has to reach the others
> through the relay. Connect a membership first.

This is the honest answer rather than a limitation: until a membership exists nothing is
syncing, so there is nothing a removal would be protecting.

**A device that stays**, on every `client::round_trip` before push and pull: `GET /keys`. If
`epoch` matches, nothing happens — one cheap D1 read. If it is higher and a `blob` is present:
unwrap, write the new group, drop the roster rows the manifest omits, and carry on. The pull
cursor that `behind = true` was holding then advances on its own, which is the stall in §1.3
resolving itself.

**A device that was removed**, on the same check: `epoch` is higher and `blob` is `null`. It
leaves the group fully — `sync_group`, `sync_devices` and the grant keys are cleared — and the
panel returns to *not paired with anything yet*. Its own collection is untouched, which is what
`REMOVAL_WARNING` already promises the reader.

### 2.5 Local shape

`Grant` gains a sibling rather than growing an `Option`:

```rust
struct GroupGrant { access: String, expires: i64, status: String, since: Option<i64> }
```

— because `store_grant` refuses an empty refresh secret today, and it should keep refusing one.
A new `store_access(conn, access, expires)` writes the two token keys without touching
`REFRESH_SECRET`.

`SupporterStatus.connected` stops meaning "this device holds a refresh secret" and starts
meaning "this device is entitled", which is now a group fact. It is renamed `entitled` so no
call site can quietly keep the old reading. `group_bound` is unchanged and still separates the
two silences (*Membership ended* from *Not connected*).

`entitlement::access_token` tries the refresh door if this device has a secret and the group
door otherwise. A 401 on the **group** door is not automatically a lapse — it can be a stale
auth after a rotation this device has not caught up with — so it re-checks `/keys` once before
concluding the membership has ended.

---

## 3. Items 1 and 4

**Removed rows vanish.** `pairing::status` filters `revoked_at IS NULL` out of the `devices` it
answers. `identity::roster` has exactly one production caller (`pairing.rs:406`), so nothing else
is touched; `baseline.rs` runs its own `WHERE revoked_at IS NULL` and is unaffected.

**PR 1 filters; PR 2 deletes.** On its own, PR 1 leaves the stamped row in `sync_devices` and
merely stops drawing it — a one-line change with no migration and no risk, which is the point of
shipping it separately. §2.4 then replaces the stamp with a delete, at which point the filter
becomes belt-and-braces for rows written by builds that predate it. Both orders leave the panel
saying the same thing, which is why they can ship apart.

`DeviceRow` loses its `removed` branch, the `Removed` label and the paragraph in
`THIS_DEVICE_PILL`'s doc that argues for keeping history on screen. §7.6's "the removed row is
kept rather than deleted" paragraph in `docs/reference/sync.md` is rewritten in the same commit.

**The sync error line goes.** `RelayStatus.last_error` reads the newest `error_log` row with
`source = 'relay'` (`commands.rs:96`) — it is a second rendering of a row the Errors panel
already draws. The field, its query and the paragraph at `SyncPanel.tsx:780` all go. Nothing is
lost: `errors::record(Source::Relay, …)` still writes every relay failure, and the one place a
failure is *not* recorded — a 401 that means the membership lapsed, `client::lapsed` — stays
unrecorded for spec §10's reason.

---

## 4. Failure modes, and what each costs

| What fails | What happens | Why that is the right answer |
| --- | --- | --- |
| `/rotate` refused or unreachable | The removal does not happen. The reader sees a refusal and can press again. | Better than today's rotation that reaches nobody. The group is exactly as it was. |
| `/rotate` succeeds, the local commit fails | The relay holds epoch *N+1*; this device is still at *N*. Its own `/keys` check finds a blob addressed to it and adopts it. | Self-healing, because the remover is on its own manifest. |
| A device is offline across two removals | `/keys` answers the current epoch and a blob for it, if it is still in the group. | The blob is per-epoch-current, not a chain, so no replay is needed. |
| A device is offline across nine removals | Its auth is older than the eight epochs `/keys` keeps and it is refused. | Re-pair by hand. Nine removals with one device dark is not a case worth carrying state for, and the refusal says so rather than being silent. |
| The reader removes the device that holds the refresh secret | The remaining devices keep working on the group auth; the entitlement stays bound to the same group. Connecting Patreon again on any device re-binds the same group and mints a fresh secret. | `/claim` already passes `row.group_id === group`. Selling a laptop must not cost the group. |
| A removed device tries to re-register its own auth | `/rotate` refuses an epoch that is not strictly higher, and it cannot compute the new epoch's auth. | The monotonic check is the whole guard. |
| Remove is pressed in a group with no membership | Refused, with the sentence in §2.4. | An unentitled group is not syncing, so there is nothing to protect — and rotating locally is today's bug. |
| A group has claimed but never rotated | `/keys` answers the claim's epoch with an empty manifest; every device sees equal epochs and does nothing. | The epoch guard in §2.3. Without it this is the case that dissolves a healthy group. |
| The relay is compromised | It learns `group_auth`, which is one-way from the group key, and a pile of blobs sealed to keys it does not hold. | Unchanged from today: it still decrypts nothing. |

**One residual cost, accepted.** A removed device can spend `/keys` reads until its auth ages out
of the eight-epoch window. Those are D1 reads on a route that never reaches the Durable Object,
so the metered path is untouched; the alternative — refusing a stale auth outright — makes a
device that is merely behind indistinguishable from one that is out, which is the ambiguity §2.3
exists to remove.

---

## 5. Testing

**Rust, `sync_pair` and `sync_engine`.** `relay_auth` is a pure function over a key, an id and an
epoch — a vector test and a "two epochs never agree" test. The rewrap round-trips through
`memory_pair`: seal for B, open as B, and **fail to open as C**, which is the assertion the
whole scheme rests on. `revoke_device` gets three: a refused `/rotate` leaves the group untouched,
a group with no membership refuses the press, and **a claimed-but-never-rotated group leaves every
device alone** — the empty-manifest case from §2.3, which is the one where a missing guard
dissolves a healthy group rather than merely failing. All driven against the `client::RELAY_URL`
override the endpoint tests already use.

**Rust, the three-device case.** The bug in §1.3 is testable today and is not tested: three
in-memory devices, A removes C, B adopts the rewrapped key, and B's pull cursor advances past the
epoch boundary. It should be written to fail against `main` first.

**Relay, vitest.** `/token`'s group door: right auth, wrong auth, auth for the wrong group, a
group with no entitlement, a dead entitlement, and a closed grace window resolved on the group
door exactly as on the refresh door. `/rotate`: a lower epoch, an equal epoch, an unknown group,
and both accepted credentials. `/keys`: current epoch, a stale-but-accepted auth, an auth nine
epochs old, and a device absent from the manifest.

**TS.** `supporterState` over the renamed `entitled` field, and the two states that must not
collapse. `SyncPanel.test.tsx` asserts the *Connect Patreon* button is **absent** on a device
that is entitled through its group, and that no *Last relay failure* paragraph is drawn.

**Live.** Nothing here is finished until it is driven on the real desktop and the real phone:
pair first, connect second, and watch the phone's panel change without being touched; then a
third device, removed, gone from both screens and gone from its own.

---

## 6. What this does not do

- **No WebSocket fan-out.** `/keys` is checked on the same manual cadence `round_trip` already
  has, so a removal reaches a remaining device the next time it syncs, not instantly.
- **No `Leave group` button.** A device can now be made to leave by being removed elsewhere, but
  there is still no press for leaving on its own. That is a separate change.
- **No withdrawal of what a removed device contributed.** Spec §12.3 is unchanged and its
  reasoning is unchanged: a row carries no author.
- **`sync_devices` still does not sync.** Key material never travels. The manifest is a list of
  ids, and `device_names` is still what carries the names.
