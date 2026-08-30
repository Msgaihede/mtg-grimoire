# Leaving a group, and five devices to an account

**2026-08-30**, straight after #307. Three things the reader asked for once group-wide membership
was in:

1. **It should be possible to leave a group**, rather than only to remove somebody else — and
   **that operation should always be possible**.
2. **Five devices signed in per Patreon account.**
3. **Five devices per group** — *"this goes for accounts inheriting the sign-in from another
   grouped device too"*, which is to say a device entitled through `/token`'s group door counts
   like any other.

A fourth thing falls out of the first and is not optional: leaving strands the paying device
unless `/claim` learns to rebind.

---

## 1. What is there now

`plan_rotation` refuses to remove this device, and its sentence is
**`"This device cannot remove itself. Use Leave group instead."`** — copy that has pointed at
nothing since it was written; Task 14 of #307 flagged it and left it, being code rather than
prose.

Everything a departure needs already exists. `plan_rotation` mints a key, rewraps it per
remaining device and writes nothing; `commit_rotation` writes; `leave_group` clears the pairing
state; `client::post_rotation` publishes. **The only reason a device cannot leave is one guard.**

There is no device limit anywhere. `/rotate`'s manifest caps at **64**, which was a bound on what
the relay will store rather than a policy, and nothing counts devices at all.

---

## 2. Leaving

### 2.1 The shape

`identity::plan_departure(conn) -> Result<Rotation, String>` — `plan_rotation`'s body with the
self-check inverted: the manifest is everyone **except** this device.

**The guard stays on `plan_rotation` rather than being relaxed.** Removing somebody else and
leaving yourself are different acts with different consequences, and collapsing them would let a
mis-click on a roster row throw this device's own key away. Both call one private `plan`.

`pairing::leave_group_now`, behind the command `sync_group_leave`:

1. `plan_departure`
2. `client::post_rotation` — **best effort**
3. `identity::leave_group` **and** `entitlement::clear` — **unconditionally**

Step 3 running whatever step 2 said is the whole of *"always possible"*. A reader on a plane, or
one whose membership has lapsed, gets out of the group.

### 2.2 What the leaver knows, and why that is not a hole

**The leaver mints the key the devices that stay will use.** That is uncomfortable and it is not
new exposure: a device that wanted to go on reading the group would simply **not leave**, and
would keep the key it already has. Leaving is voluntary, so the threat it would defend against is
one the actor has already declined to be.

What it does buy is the honest half: the group closes behind the leaver *when the relay is
reachable*, so the roster on every remaining device drops it on their next trip, exactly as a
removal does. When the relay is not reachable the reader still leaves, and the remaining devices
go on listing a device that has gone — which is the cost of the reader's instruction, and belongs
in the panel's copy rather than being hidden.

### 2.3 The grant goes, for the removal's reason

`entitlement::clear`, not `revoke` — nothing ended, this device left a group. A leaver keeping its
refresh secret keeps a *working credential for the group it left*: the refresh door mints a token
whose `grp` is that group, and `/g/{group}/push` honours it. §2.4 of the previous spec made that
argument for a removed device and it is unchanged here.

---

## 3. `/claim` rebinds, because leaving would otherwise strand the payer

**The dead end.** The paying device leaves. Its entitlement is still bound to the old group. It
pairs elsewhere or founds a group of one, presses Connect, and `handleClaim` answers **409 — that
membership is already bound to another sync group**. There is no press that helps and no way back
without editing D1 by hand.

**So a re-claim moves the binding rather than refusing it.** When a subject that already holds a
group claims a *different* one:

- drop the old group's relay log (`dropGroup`, which `revoke` already calls),
- delete its `group_keys` and `group_devices` rows,
- bind the new group, and `seedGroup` it.

**The invariant that mattered is kept.** Trust-on-first-use existed to stop one subscription
serving two groups at once; moving a binding leaves a subject serving exactly one. Only the
*first* becomes the *latest*.

**The 409 does not go away — it changes which case it is for.** Another **subject** holding this
group id is still refused, and still by the unique index rather than by a question asked first:
that is a shared subscription wearing two names, which is the thing the constraint is actually
about.

⚠️ **The cost, stated rather than discovered.** A re-claim silently orphans whatever devices
remain in the old group: their manifest and log are gone, and they will fail their next key check
with the sentence #307 added. They are already orphaned if the payer has left — but a reader who
re-claims *without* leaving can do this to a working group by accident. **The panel says so before
the press**, and that copy is load-bearing.

---

## 4. Five devices

### 4.1 One table serves both limits

A subject holds exactly one group — that is what §3 preserves — so *five per account* and *five
per group* are the same count asked twice. One table answers both:

```sql
CREATE TABLE IF NOT EXISTS group_devices (
  group_id   TEXT    NOT NULL,
  device_id  TEXT    NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (group_id, device_id)
);
```

`MAX_GROUP_DEVICES = 5`, in `groupauth.ts` beside `EPOCH_HISTORY`.

### 4.2 Both doors carry a device id, and that is the point

**`/token` gains `device` on both shapes**, not only the group one. The connecting device reaches
the relay through the *refresh* door and never the group door, so a cap that counted only the
group door would never count the one device that is certainly signed in — and the reader's own
words are *"this goes for accounts inheriting the sign-in from another grouped device too"*, which
only means something if the device that did **not** inherit is counted as well.

On a token that would be issued: upsert `(group_id, device_id)` with `last_seen`. If the row is
new and the group already holds `MAX_GROUP_DEVICES` live rows, refuse **403** with a sentence
naming the limit — not 401, which the app reads as a lapse and which would clear the grant.

### 4.3 The relay is the fence; the client is the message

`pairing::confirm` and `complete` refuse a sixth device with a sentence, so a reader meets the
limit at the moment they press Pair rather than at a sync three minutes later.

**But the client is advisory and the relay is the limit.** This repository is public and readers
build it; a cap that lived only in `sync_pair` would be a suggestion, and the point of a device
limit is precisely the case where somebody has reason to exceed it.

`/rotate` drops its manifest cap from 64 to `MAX_GROUP_DEVICES`.

### 4.4 Freeing a slot

**The manifest frees them.** `/rotate` already carries the roster at the new epoch, and #307 made
that the authority on who is in the group. So a rotation **deletes `group_devices` rows the
manifest omits** — which means a removal and a departure each free their slot with no new
mechanism, because both publish a manifest.

**And a last-seen ages out what the manifest never mentions.** A device whose data folder is wiped
mints a *new* id at `identity::ensure`, so the old row is never removed by anything: five
reinstalls would exhaust a reader's own account permanently. A row unseen for
`DEVICE_TTL_DAYS = 90` is not counted and is pruned when the count is taken.

Ninety days is chosen against the thing it must not break: a device put in a drawer for a season
and brought back. It is long enough that returning from one is the ordinary case, and short enough
that a machine sold a year ago is not still holding a slot.

---

## 5. Failure modes

| What | What happens | Why that is right |
| --- | --- | --- |
| Leave with the relay unreachable | The device leaves; the others go on listing it | The reader asked to leave. The panel says the others may need a manual removal. |
| Leave on the paying device | It leaves and clears its grant; §3 lets it re-claim elsewhere | Without §3 this is the dead end that motivated it. |
| A sixth device pairs | Refused at the ceremony by the client, and at `/token` by the relay | Two refusals, one limit; the reader meets the good one. |
| A sixth device pairs from a modified build | The ceremony completes and the relay refuses the token, 403 | The fence is the relay. The device is paired and unentitled, which is a state the panel already draws. |
| Five wiped reinstalls | The old rows age out at 90 days, or are freed by the next rotation | The failure this exists to prevent is a reader locked out of their own account. |
| A re-claim onto a new group | The old group is dropped and its devices orphaned | Stated in the panel before the press. |
| Two subjects, one group id | Still 409, still from the unique index | The constraint's real job, untouched. |

---

## 6. Testing

**Rust.** `plan_departure` names everyone but this device; `leave_group_now` clears locally when
the POST fails **and** when it succeeds — the second is what stops "always possible" being
implemented as "never publishes". `plan_rotation` still refuses self.

**Relay.** The count at 4, 5 and 6; a sixth refused **403 and not 401**; the refresh door counted;
a re-registration of an existing device not consuming a second slot; a manifest omitting a device
freeing its row; a row older than the TTL not counted; a re-claim moving a binding and dropping
the old group's rows; another subject still refused 409.

⚠️ **The fake must model `group_devices`' primary key**, or "a device already counted does not
consume a second slot" passes against a table that cannot hold duplicates anyway.

**TS.** The panel draws Leave group on any paired device and never on an unpaired one; the
re-claim warning is present before the press.

**Live.** Leaving on the phone, and the desktop's roster losing it. This is the one that found
#307's migration gap on its first press.

---

## 7. What this does not do

- **No "sign out of this device" for the membership alone.** Leaving clears the grant because the
  group is gone; disconnecting a membership while staying in the group is a different press
  nobody has asked for.
- **No per-device names on the relay.** `group_devices` holds ids and timestamps. What a device is
  called is `device_names`, is synced between the devices, and the relay never sees it.
- **No grace on the cap.** A sixth device is refused, not queued or bumped.
