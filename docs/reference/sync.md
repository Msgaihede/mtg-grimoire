# Sync — pairing, the relay, and the conflict engine

Two halves, in the order they were built. **Above the PR 7 heading is the pairing protocol** and
none of the transport; every measurement there is from a **debug** build on Windows, on the date
it names. **Below it is the transport and the rules** — the op log, the five conflict rules, the
envelope, the Cloudflare Worker — and those figures are release-build unless they say otherwise.

Spec: [`2026-08-27-cross-platform-design.md`](../superpowers/specs/2026-08-27-cross-platform-design.md)
§7.2 (what syncs), §7.3 (conflict semantics), §7.4 (what the reader sees), §7.5 (pairing),
§7.6 (unpairing and revocation) and §7.7 (the relay).

---

## The claim, and what makes it testable

Two devices become one pairing group with no account, no server-side identity and no password —
and **a man-in-the-middle sitting where the relay will later sit cannot join, because both
readers compare a six-digit code that only the true pair can produce.**

**That is a claim about the pairing protocol, and the auth gate the relay gained on 2026-08-29
leaves it standing.** Reaching the relay now takes a Patreon membership, and the relay holds one
entitlement row per group; the ceremony below neither knows nor asks about either, and there is
still no password and nothing to log into. Which account does what is settled in
[the relay section](#the-relay-five-group-routes-three-of-them-behind-an-auth-gate).

PR 6 carries both of the blobs that protocol produces **by hand**: the invite as a QR code or a
typed code, and the sealed group key as a second blob. There is no network of any kind. Two
windows side by side, or one machine's camera reading another's screen, complete a pairing with
the app offline.

That split is not a compromise. **A pairing that never touches a network cannot be attacked by a
network**, so every test here is about the protocol rather than about the transport, and PR 7
inherits a verified protocol instead of debugging both at once.

⚠️ **"There is no network of any kind" stopped being true on 2026-08-31, and it is a cost stated in
its own right rather than buried** — see
[the two costs](#two-costs-stated-rather-than-buried). The one-sided pairing and QR change put a
short-lived, unauthenticated **rendezvous** on the relay between the two devices, so **pairing now
needs the relay reachable** even before either side holds a Patreon membership. What the paragraph
above still gets right is the *test* argument: `crypto`, `invite` and `identity` are still pure and
I/O-free, so the man-in-the-middle test is still a real three-party exchange in microseconds rather
than a mock — only `pairing.rs` itself makes a network call now, and only from `accept` and
`confirm`. [The rendezvous](#the-rendezvous-outside-the-gate-same-reasoning-a-different-namespace)
is documented where the relay's other routes are.

---

## The protocol, step by step

**Rewritten 2026-08-31 for one-sided pairing.** Until this branch B's response and A's sealed key
were both retyped by hand — the second one back the other way, the hard direction — through
`sync_pairing_respond` and `sync_pairing_complete`. Both commands are gone from the IPC surface;
`sync_pairing_poll` reads either blob back from the relay's rendezvous and runs their old bodies
internally, so the crypto they perform is unchanged and only how it is invoked moved.

| Press | Command | A (offering) holds | B (joining) holds |
| --- | --- | --- | --- |
| A: *Pair a device* | `sync_pairing_begin` | pending offer, the invite, a rendezvous id (`rv`) | — |
| B: scans or pastes the code | `sync_pairing_accept(code)` | — | pair key, **six digits**; **posts its answer to `/p/{rv}/join` immediately** |
| A polls, reads B's answer | `sync_pairing_poll` | pair key, **six digits** | — |
| **both compare the six digits — only A has a button** | — | | |
| A: *Codes match* | `sync_pairing_confirm` | group created if needed; seals the key, **posts it to `/p/{rv}/offer`**, commits only once that succeeds | — |
| B polls, reads A's sealed key | `sync_pairing_poll` | | joined |

**Only A presses anything past *accept*.** B's screen shows its six digits and a *Cancel*; the
comparison is still two-screen (a substituted key moves both halves of the transcript, so a
man-in-the-middle still shows disagreeing codes), but the button that matters — the one gating the
group key's release — is A's alone. B posting its answer before any human comparison leaks
nothing: the sealed remainder opens only under the pair key, and anyone holding the invite could
already run their own handshake, so what used to be withheld until the reader confirmed was
withheld from a party that never needed it.

**`sync_pairing_poll` answers a `stage`, and there are five of them:
`idle | waiting | compare | complete | expired`.** ⚠️ **`expired` is a stage rather than an error,
and that reversal is what makes the ten-minute window visible at all.** The first build refused
with `Err("That pairing code has expired…")` *and* cleared the pending offer in the same call — so
the refusal was exactly one call long, and the panel's poll query carries `query.ts`'s `retry: 1`:
TanStack re-ran it about a second later, found nothing in flight and got `Ok(idle)` back. `poll.error`
was never populated for the expiry case at all. At ten minutes **nothing on the screen changed** and
the panel went on polling a rendezvous that no longer existed, with Cancel the only way out; the
same silence hit the other side whenever one device pressed Cancel. `SyncPanel` handles `expired`
by ending the flow and drawing `EXPIRED_NOTE`, and handles `idle` **not at all** — deliberately,
because `idle` is also what the backend answers in the instant after a cancel, and reading it as
the timeout would tell a reader who had just pressed Cancel that their code ran out.

The four layers behind it, and the boundary between them is that only the last two touch SQLite:

- **`sync_pair::crypto`** — X25519, HKDF-SHA256, XChaCha20-Poly1305, the six digits, and (since
  this branch) `rendezvous_id` — a one-way HKDF derivation of the address the two relay-borne blobs
  meet at, taking the pairing's own one-time token as **input keying material with no salt** —
  the opposite of `pair_key`'s use of that same token as the salt, and deliberate: the two
  derivations have to stay unrelated, or the relay's address and the pairing key would share
  structure. No database, no I/O, no clock. Everything is a pure function of its arguments, which
  is why the man-in-the-middle test is a real three-party exchange in a few microseconds rather
  than a mock.
- **`sync_pair::invite`** — the 64-byte payload as a typed code and as a QR *module matrix* — since
  this branch, drawn over [a URL rather than the bare
  code](#the-qr-carries-a-url-and-the-code-rides-in-the-fragment).
- **`sync_pair::identity`** — the three tables user schema v28 created, plus (since this branch)
  `plan_join`, a third entrance beside `plan_rotation`/`plan_departure` that publishes the roster
  to the group a device just joined — the fix for a device paired by one machine being silently
  evicted by another's next rotation, which never knew to name it. ⚠️ **It is a fix for the hub
  case and not for every case, and the difference is `adopt_epoch`**: that function prunes the
  roster to the manifest and *never inserts*, because a manifest carries device ids and no public
  keys, so a device that learned of a join only by adopting an epoch is holding a partial roster
  and cannot seal a blob to the peer it never met. `client::publish_join` therefore reads `/keys`
  and publishes **only when what it would publish is a superset of what the relay already holds**;
  otherwise it marks `roster_dirty` and stays quiet, because publishing from a partial view would
  *be* the eviction rather than the fix. Carrying public keys in the manifest is the change that
  would close the rest, and it is a wire change on both sides that this branch does not make.
- **`sync_pair::pairing`** — the state machine and the nine commands. Two of them do network I/O
  now (`accept`, `confirm`), so they and `poll` run on a blocking worker with a runtime of their
  own (`sync::on_a_worker`). **Since 2026-10-03 each takes the pending offer's lock and then the
  sync lane, and reaches the database a stretch at a time** — it held the write connection across
  its requests until then. See *A trip holds nothing across a request*, below.

### Two costs, stated rather than buried

**Pairing now needs the relay reachable.** Until 2026-08-31 two devices paired with no network and
no membership and connected Patreon afterwards — `pairing::confirm`'s own comment calls that "what
makes pairing possible in either order," and the order survives: a reader may still pair first and
connect second. **The *offline* half does not survive.** Two devices with no signal — the reader's
own example was a plane — can no longer complete a pairing at all, because `accept` and `confirm`
each have to reach the rendezvous before either produces anything for the other side to read. This
was chosen deliberately over keeping the old paste boxes as an offline fallback.

**An old build and a new build cannot pair, and it is a louder failure than the sealed-blob skew
already documented above.** That skew is bytes disagreeing under an otherwise-shared flow; this is
the flow itself changing — an old build still shows a second and third paste box that a new build
has nothing to fill, and a new build's rendezvous has no counterpart an old build ever polls.
**Pair two devices on the same build** remains the rule it always was; what changed is which
mismatch a reader hits first.

### Both blobs put one field in the clear, and that is not a leak

**Neither is hand-carried any more — see [the two costs](#two-costs-stated-rather-than-buried) for
what that traded away — but the byte layout below is unchanged**, because the rendezvous only
changed *how* a blob crosses, never what is in it. Each side has to know **which key to derive**
before it can open anything, and the value it needs is the one the other side is identified by:

- B's response is `<32-byte public key><sealed remainder>`. A cannot derive the pair key without
  B's key, and B's key is repeated *inside* the sealed bytes — `respond` compares the two, so a
  swapped prefix fails to open and a prefix that opens is one the sealing device chose.
- A's sealed key is `<device id>\0<sealed remainder>`. The id is that seal's associated data and
  B does not know it yet. It is hex, so it carries no zero byte of its own and the first one is
  the separator.

**Both are public by construction.** [The plan](../superpowers/plans/2026-08-28-sync-pairing.md)
had `respond` and `complete` parsing for those prefixes while `accept` and `confirm` wrote
neither; nine of sixteen pairing tests fail against it as written.

**Inside A's seal the layout is `<group_id>\0<epoch>\0<32-byte key>`, and the field order is
load-bearing.** The id and the epoch travel with the key because a key with no epoch cannot be
compared against a later rotation, and **since 2026-08-30 nothing else travels at all.** This
device's membership is not consulted, which is what makes pairing possible in either order: a
reader may pair two devices and connect Patreon afterwards, or the other way round, and neither
is a refusal.

⚠️ **A fourth field held the refresh secret for one day and was taken back out, and the reason it
went is the whole of the group-wide removal.** Between `86a9b8e` (2026-08-29) and `3f7bbeb`
(2026-08-30) the layout was `<group_id>\0<epoch>\0<refresh>\0<32-byte key>`, so a device that
joined an already-connected group was entitled without opening a browser. **A device holding that
secret could re-register the group's auth and therefore evict the devices that removed it** —
`/rotate` took the refresh secret as a second credential then (§2.4 of
[the group-wide design](../superpowers/specs/2026-08-30-group-wide-membership-and-removal-design.md)),
so leaving it on every paired device would have made a removal something any of them could
reverse. That door has since been removed; the rule stands because the relay retires a secret
with the one device `/claim` recorded as its holder, so a copy anywhere else would survive that
device's removal and go on minting tokens for the group. Restricting the Patreon-side secret to the device that pressed Connect is what makes a
removal stick, and [the group door](#the-group-door-an-entitlement-belongs-to-a-group) is what
pays for the field's absence: a paired device mints its own token from the group key instead.

**The key is last because it is the only field that can hold a zero byte of its own.** `complete`
reads with `splitn(3)` and takes everything left over as the key, so a field appended *after* it
would be swallowed by any group key containing a zero — `1 - (255/256)^32` ≈ **12%**, about one
pairing in eight. **Anything ever added here goes before the key**, and the two fields that are
there are safe ahead of it for the reason A's device id is safe as the clear prefix one step down:
a hex group id and a decimal epoch carry no zero byte at all.

**Measured, 2026-08-30, debug, at epoch 0: the sealed blob is 140 bytes and 224 base32
characters** — 32 hex characters of device id, the separator, and a 107-byte seal over a 67-byte
plaintext (24-byte nonce, 16-byte tag). It was **150 bytes / 240 characters** for the day the
refresh secret was in it, against a 9-byte secret.

**That failure was measured rather than reasoned about, and the shape of it is the part worth
remembering.** The dangerous variant — both ends appending after the key — was run five times
on **2026-08-29, debug**. The deliberate all-zero-key test failed on every run; the *other*
failures moved around, **one, three, two, two, one**, a different randomly-keyed test each
time. Without a fixture that pins a zero into the key, this ships as a flake nobody can
reproduce.

⚠️ **The blob carries no version field, so a version skew reads as a broken key.** The four-field
layout and the three-field one are mutually unreadable **in both directions**: a three-field
`confirm` hands a four-field `complete` a third field that is the whole 32-byte key where it wants
a refresh secret, and the key it then takes is empty; a four-field `confirm` hands a three-field
`complete` a third field that is `<refresh>\0<key>` and fails the 32-byte length check. Either way
the reader is told **"That pairing key is unreadable."** — a sentence about the bytes, when the
cause is that one of the two devices has not been updated. There is nowhere in an unversioned blob
to say so, and adding a version byte now would not help the build that already shipped without
one. **Known limitation: pair two devices on the same build.**

⚠️ **2026-08-31 added a second, louder way for two builds to fail to pair, and it is not this one**
— the skew above is about *bytes* surviving an unchanged flow; the new one is the *flow* itself
changing, so an old build's second and third paste boxes have nothing on a new build to answer
them at all. See [the two costs](#two-costs-stated-rather-than-buried) above.

**What has narrowed is which builds that bites.** Today's three-field layout is byte-identical to
the one that shipped before `86a9b8e`, splitter included, so a build from before 2026-08-29 and a
build from after 2026-08-30 pair with each other perfectly well. The unreadable window is the
one-day four-field build in between — which makes this a smaller limitation than the paragraph
above describes and **not one whit safer to add a field to**, because the next layout change will
not be a return to something.

### The pending offer is in memory and never in SQLite

`State.pairing` in `grimoire-core`, a `platform::sync::Shared<Option<Pending>>` — **an async
lock since 2026-10-03, held across the request an `accept`, a `confirm` or a `poll` makes**, so a
Cancel waits behind it and wins and two polls cannot both complete one offer; taken before the
sync lane, never after. (It was the desktop's `AppState.pairing`, a `tokio::sync::Mutex`, for the
step that made it async, and moved to the core with pairing.) An offer that survived a restart
would be an
invite a reader printed last month still being accepted today. It outlives the webview, which is
what a reader who opens Settings twice needs, and dies with the process — which is what makes
the token one-time in fact rather than in the documentation. `Pending` holds the derived pair
key, which is the second reason it is not a table.

---

## Why the typed code is 105 characters

The payload is a 16-byte group id, a 32-byte X25519 public key and a 16-byte one-time token —
**64 bytes**. Crockford base32 is 5 bits per character, so `ceil(512 / 5)` = **103** characters,
plus a **2**-character checksum.

**The public key is the irreducible half and nothing can shrink it while the invite stays
self-contained.** An invite that omitted it would need the relay to supply it, which is precisely
the hop the six digits exist to distrust. That is exactly why §7.5 makes the QR primary: 105
alphanumeric characters is a version-6 QR at error-correction level M, and it is a miserable
thing to type. The typed form exists for the machine with no camera pointed at it.

**Crockford, not base64.** Its alphabet omits `I`, `L`, `O` and `U`, and its decoder folds `I`/`L`
onto `1` and `O` onto `0` — the three confusions a person reading off one screen and typing into
another actually makes. Base64 has `l`/`1`/`I`, `0`/`O` and case sensitivity, all three of which
this code cannot afford.

**The checksum is two characters, position-weighted, and it is not security.** Swapping adjacent
characters `i` and `i+1` shifts the total by exactly `v[i] - v[i+1]`, which is non-zero whenever
they differ and far below the modulus — so every adjacent transposition is caught, and
`no_adjacent_transposition_anywhere_in_the_code_slips_through` sweeps a whole code rather than
one pair. What it buys is a *sentence*: the reader is told "that code has a typo in it" rather
than that the pairing failed. A **tampered** code fails at the SAS, which is where tampering is
supposed to fail.

**`decode` asks about the alphabet before it asks about the checksum**, and that ordering is what
makes `InviteError::Alphabet` reachable at all. A string with a `U` in it fails a
position-weighted sum too, so with the checks the other way round somebody who pasted an email
address was told their pairing code had a typo in it — a sentence pointing at the wrong fix.

### The QR carries a URL, and the code rides in the fragment

**Since 2026-08-31 the QR is not a picture of the 105 characters above — it is a URL, and the
fragment is load-bearing rather than cosmetic.**
`https://mtg-grimoire-relay.denmark-east.workers.dev/pair#<the 105 characters, no hyphens>`. A
fragment is never sent to a server, so the relay still never learns the invite — the whole reason
the code stayed 105 characters instead of shrinking to the ~16 the public key alone would need.
Put the code in the path instead and the relay would hold A's public key and the one-time token,
and the six digits would become the sole defence by the back door.

**Measured: 162 bytes, a version-9 QR at error-correction level M** (176-byte capacity; version 8
holds 152 and does not fit) — 53×53 modules, 61 with the four-module quiet zone `QrCode.tsx` draws.
The panel's `size-56` (224 px, 3.67 px/module) becomes `size-72` (288 px, 4.72 px/module) so the
larger code stays legible; nothing else about the component changes, and its warning stands —
`bg-white` and `fill="#000"` are literal, because a QR inverted by dark mode is a QR no camera
reads.

**`Invite::decode` strips the URL before it filters.** It keeps every ASCII alphanumeric character
and folds `I`/`L`/`O`, so handed a URL unmodified it would fold the hostname into the payload and
answer `InviteError::Length` about a code that is perfectly good. So: if the string contains `#`,
everything after the *last* one is taken as the code; otherwise it is used as-is, which is today's
behaviour for a pasted bare code exactly. A pasted URL and a pasted code both work, and the scanner
hands `decode` whichever the QR held.

**The relay serves `/pair` itself and never learns what it served.** The static page reads
`location.hash` in the browser — the Worker never sees it — and offers two things: the code large
enough to read across a desk, and a copy button. **That is the fallback for a reader who scanned
with their phone's own camera app; the primary path is the app's own scanner, which reads the QR
directly and never opens a URL at all.**

**The page offers no link into the app.** Nothing in the app reads a launch argument, so a link
would open its ordinary window with the code nowhere; `relay/src/pair.ts` carries that argument at
its own site. Deep-linking into the app is a coherent follow-up whose *first* step is the launch
handling.

---

## What the six digits defend against, and what they do not

`sas(pair_key, initiator_public, joiner_public)` is HKDF-SHA256 over the **derived** key with
both public keys as the salt, in role order, taken modulo 1 000 000 and zero-padded to six
characters.

**They defeat a substituted key.** A relay that put its own key in the middle changes the derived
key on both sides *and* changes which public key each side saw, so both halves of the transcript
move and the two codes disagree. Including the keys rather than hashing the shared secret alone
is what stops a *reflection* — an attacker replaying A's own key back at A. Role order is what
stops the same attack from the other side.

**They do not defend against a reader who presses *Codes match* without looking.** Nothing can.
What the panel does about it is the whole of what is available: the *Codes match* button carries
`aria-disabled` until the digits exist **and its handler refuses the press**, and both sides show
the number at the same size in the same face. ⚠️ **This paragraph used to add that the joining
device withholds its blob until the reader confirms — false since 2026-08-31, and on purpose.**
`accept` posts B's answer to the relay's rendezvous the moment B derives it, before any human has
compared anything; B has no *Codes match* press at all, only *Cancel*. That is not a weakening of
this section's claim: the six digits still gate the one thing that matters, which is `confirm`
sealing and posting the group key on **A**'s side, and B's early post leaks nothing on its own,
since the sealed remainder only opens under the pair key — anyone holding the invite could already
run their own handshake and produce the same answer, so nothing was ever being withheld from a
party that needed it withheld.

**Zero-padded, and that is not cosmetic.** `042913` and `42913` are the same number and not the
same code, and a reader comparing two screens is comparing characters.

**The end-to-end MITM test is probabilistic at exactly the SAS's own strength**: two unrelated
six-digit codes collide once in a million. That is the number §7.5 step 3 is worth, not a
weakness of the test — and nothing could make it deterministic without seeding a key, which
would be a far worse thing to own.

---

## Where the keys live, and what that costs

**The device's secret key and the group key live in `user.db`, in the clear.** There is no OS
keystore for a portable Windows exe a reader copies onto a stick, and inventing one would be a
second store to lose.

The consequence is exact and the panel says it: **copying the data folder copies the identity.**
Somebody who has the database already has the collection it protects, so the key adds no new
exposure — but a *backup* of `user.db` is a backup of the pairing, and restoring it onto a second
machine makes two devices claim one identity.

**`identity::ensure` therefore mints on absence only and never on a mismatch**, so a restored
database stays the device it was rather than silently forking. Two devices claiming one identity
is worse than a device that has to be re-paired, and that one line is what decides which of those
a restore produces.

**No key crosses the IPC boundary.** `identity::Device.public_key` is `#[serde(skip)]` — the
webview draws a list of devices, and a key on that list is a key in a screenshot — and
`pairing::Pending`'s fields are all private and none of them is `Serialize`. What crosses is the
six digits (a string, because they are what a *person* compares) and two sealed blobs.

---

## The name a device mints

**Every install used to mint the same name, and that made the roster unusable.** Read off a live
pair on 2026-08-29, which is where [the baseline design](../superpowers/specs/2026-08-29-sync-baseline-design.md)'s
§15 found it:

```json
[{"device_id":"253b5809…","name":"This device"},
 {"device_id":"942eb0a9…","name":"This device"}]
```

Two identical rows with a Remove button each, and nothing on the screen saying which press
removed which machine. `identity::mint_name` is the fix, called from `ensure` on the insert and on
no other path.

| Target | What it reads | Where it comes from |
| --- | --- | --- |
| Windows | `MAIN-PC` | `COMPUTERNAME`. Measured on this machine, 2026-08-29, debug |
| Linux / macOS | `HOSTNAME`, or `Desktop` | a shell variable that a process usually does **not** inherit, so the fallback is the ordinary answer there rather than the exceptional one |
| Android | `HOSTNAME`, or `Android` | the same variable, which is usually not there. What a real phone mints has not been read off one |
| A browser | `Browser` | nothing: a page is told no machine name, so the fallback is the only answer |

**One question — the machine's hostname — and it is infallible**: failing to read a name must
never stop a device minting an identity, so it falls back to a word rather than returning an
error.

**The word is the kind of machine, since 2026-10-04** — `platform::device::kind()`: `Desktop`,
`Android`, `Browser`. It was `Desktop` on every host until the web host's first run drew
"Desktop — not paired yet." in a browser tab, and this is the name every other device in a
group files this one under. **A browser install pairs like any other device** — a page asks the
relay as every host does, bound by CORS, which the relay answers for the origins on its
allow-list (`relay/src/cors.ts`) — so `Browser` is the word a nameless tab is filed under on a
paired desktop's roster. ⚠️ **In the tree, and on no host yet**: no build that asks the relay
from a page has been deployed, and no browser has paired through the deployed relay.

**The privacy trade was made knowingly and is the reader's, not this file's.** The comment on the
old constant argued the other way — a hostname is often a person's own name and it would travel
to every paired device without anybody choosing to send it — and that cost is real and unchanged:
`sync_identity.name` is the copy `create_group`, `join_group` and `pairing::accept` all send. What
pays for it is that a roster a reader cannot act on is the worse failure, and that
`sync_device_rename` is still one press away on every row the panel draws, this device's own
included. That press is why the panel keeps **Rename** beside the pill rather than replacing it.

**`ensure` mints on absence only, and that is what makes the change safe to ship.** An existing
install keeps whatever name it has — including "This device" — and a reader who renamed is never
renamed back. A version that recomputed the name per call would look like keeping the roster
current and would in fact undo a rename at the next command;
`a_renamed_device_keeps_its_name_across_every_later_ensure` and
`an_existing_identity_is_never_renamed_by_ensure` are what hold that, and both go red against
exactly that mutation.

**Nothing here asserts a literal hostname.** The value differs on every desk and CI is nobody's
desk, so the tests assert the shape: a non-empty name, not the placeholder every install used to
share, and the same answer twice.

---

## §7.6 — unpairing and revocation

> **It cannot be un-told what it already knows.** A removed device still holds whatever it synced
> before removal, and no server can reach into it.

**The rotation is the removal**, and until 2026-08-30 that was the whole of it: one transaction on
the device that pressed the button, marking the row and minting a new key. Marking the row and
leaving the key alone would produce an app that says a device is gone while that device can still
read every op written afterwards, so the epoch is bumped in the same breath.

**What that could never do is tell anybody.** A rotation A performs reached B not at all: B stayed
at epoch *N*, A pushed at *N+1*, and `client::pull` set `behind = true` and **held the cursor** so
the page would be re-delivered until the key arrived. It never arrived, so **one removal bricked
any group of three**, and a group of two survived only because the one device that still mattered
was the one that rotated. The removed device heard nothing either and went on drawing a group of
*n*. That is the bug
[the group-wide design](../superpowers/specs/2026-08-30-group-wide-membership-and-removal-design.md)
was written for, and what follows is what replaced it.

### The rewrap hop, in the order it happens

The remover does four things and **the order is the fix**
(`pairing::remove_device` → `identity::plan_rotation` → `client::post_rotation` →
`identity::commit_rotation`):

1. **Refuse a group with no membership**, before anything moves — the fourth refusal below.
2. **A round trip that emits no baseline**, so the departing device's last push is absorbed.
   `run_once` would hand thousands of ops to the very device this is about to remove. It also
   pays any join paired here and not yet published; **a debt it could not pay refuses the
   removal** (`pairing::JOIN_NOT_PUBLISHED`), because the others would not know the device being
   dropped and would keep the old keys it holds.
3. **Plan the rotation, which writes nothing**, and publish it to `POST /g/{group}/rotate`. The
   plan is the new key rewrapped once per device that stays:
   `kek = HKDF-SHA256(X25519(remover_secret, target_public), salt = group_id, info = "mtg-grimoire/rotate/v1|" || epoch)`,
   sealed with `group_id\0target_device\0epoch` as its associated data. `sync_devices.public_key`
   is already every peer's X25519 key and the target already holds the remover's, so nothing new
   crosses in the clear and no key material is published the target cannot authenticate.
4. **Commit only on a 2xx.** A refused `/rotate` leaves the group exactly as it was and reports a
   refusal the reader can press again — which is strictly better than a rotation that reached
   nobody.

A device that stays asks `GET /g/{group}/keys?device=<id>` on every round trip before push and
pull. Equal epoch: nothing happens, one cheap D1 read. Higher epoch with a blob: unwrap, write the
new group, keep or forget the key it replaced (*One correction to the plan*, below), drop the
roster rows the manifest omits, carry on — and the pull cursor `behind = true` was holding
advances on its own, which is the stall above resolving itself. Higher epoch with **no** blob:
this device was the one removed.

**The blob does not say who sealed it, so `check_keys` tries every sealer this device can name**:
the manifest's devices, every device on its own roster — a departure is sealed by the leaver,
which is on no manifest it publishes — and itself, because `plan_excluding` seals a blob for the
planner too, so a rotation whose 2xx was lost, or whose commit failed, is adopted from its own
blob instead of failing `check_keys` on every trip for ever. **Trying more candidates trusts
nothing new.** A candidate is only a public key to try, taken from this device's own roster at
pairing, behind the six digits, and never off the wire — the relay supplies ids alone — and the
blob opens only under the X25519 secret of whoever sealed it, bound to the group, this device and
the epoch. A device removed earlier is off the roster already, and anybody able to publish to
`/rotate` could always have named itself on its own manifest. Adopting this device's own rotation
is the commit that was lost, so it also re-arms every baseline, as `commit_rotation` would. (A
relay that replayed a rotation this device posted and was *refused* would move it to a key nobody
else holds — confusion rather than injection: the blob is this device's own and hands it nothing.)

### The manifest is the roster

`group_keys.keys` is one JSON column holding `{"<device_id>": "<blob>", …}`, and **its key set is
the roster at that epoch**. A device that adopts *N+1* deletes every `sync_devices` row the
manifest does not name.

**That is deliberately not a synced table** — it would be the **nineteenth** now, and this line
read *thirteenth* until `deck_tokens` took that number at user schema v37, *fourteenth* until
v43's two note tables and v46's `sticky_notes` moved it twice more, *seventeenth* until v52's
`deck_token_printings` moved it again, and *eighteenth* until v59's `deck_todo_lists` did, which
is the argument against writing a count into prose at all. A manifest that *is* the key distribution
cannot disagree with it, where a synced `device_removals` table could arrive late, arrive out of
order, or arrive at a device that cannot decrypt it — which is precisely the state a rotation puts
every peer in.

**A device with no blob at the current epoch was removed, and that is positive evidence rather
than an inference from a refusal.** It is why `/keys` accepts an auth up to eight epochs old
(`groupauth::EPOCH_HISTORY`): "behind a rotation" and "removed" otherwise produce an identical
stale-auth 401, and a device that guessed wrong would either leave a group it is still in or sit
for ever in one it is not. A removed device leaves fully — `identity::leave_group` clears
`sync_group`, `sync_devices`, the superseded keys and its place in the relay's log (*A cursor is a
place in one group's log*, below), and the caller clears the grant beside it — and the panel returns
to *not paired with anything yet*. Its own collection is untouched, which is what the dialog
already promises.

⚠️ **The manifest is read only when the answered epoch is strictly higher, and that guard is
load-bearing.** A group that has claimed but never rotated has one `group_keys` row with an
*empty* manifest, so every device in it reads `blob: null, devices: []`. Comparing the epochs
first is the whole of what stops every device in a healthy group concluding it has been removed
and dissolving the group on its next sync. Equal epochs mean *nothing to do*, and `devices` is not
read at all.

### The removed row is deleted, not stamped — and that reverses what this section used to say

Until 2026-08-30 the row was **kept** in `sync_devices` with `revoked_at` stamped, and filtered out
of what the panel draws; this file argued for keeping it, because `add_device` cleared the stamp on
a re-pair and `baseline::peers_needing` read it to skip a peer that would never answer.

**The manifest ended that argument.** A device the manifest omits has no row on any *other* device,
so a remover that kept a tombstone would be the one machine in the group with a different answer
about who is in it. `commit_rotation` deletes instead. `peers_needing` reads
`WHERE revoked_at IS NULL`, which a deleted row satisfies just as well; `add_device` still puts a
re-paired device back, now by insert rather than by clearing a stamp. **The column stays in the
schema for the migration's sake and stops being written**, and `plan_rotation` still skips a
stamped row — a database written by an older build can hold one, and a manifest naming such a
device would put it back in the group on every device that adopts.

**The filter in `pairing::status` stays** and is belt-and-braces now: it shipped one PR ahead of
the delete, and what it still covers is rows written by builds that predate it.

**Five refusals**, each a sentence rather than a constraint failure. ⚠️ **Re-counted 2026-08-30:
three until the group-wide design added the membership check, four until the device cap added
the fifth.** The count is written here because the list is written here; it is not a fact about
a tree.

- **This device cannot revoke itself.** Leaving a group is a different act with different
  consequences — it throws this device's own copy of the key away — and collapsing the two would
  let a mis-click cost the reader the group they are standing in. **The sentence the reader gets
  says "Use Leave group instead", and since 2026-08-30 that names a real press**:
  `identity::CANNOT_REMOVE_SELF` pointed at nothing from the day it was written until
  `sync_group_leave` landed, and this paragraph carried a ⚠️ saying so. The guard did not move
  when the press arrived — `plan_rotation` still refuses self and `plan_departure` is a second
  entrance, for the reason "The departure" below gives.
- **An id nobody on the roster answers to rotates nothing.** A rotation locks every remaining
  device out of what came before it, so one with nobody removed is a cost with no cause and
  nothing on any screen to explain it.
- **A device already in a group may only rejoin the one it is in.** Joining a second group
  overwrites the key the first one syncs under, and nothing here can get it back. A re-pair after
  a revocation carries the same group id and is allowed by the same check.
- **A sixth device cannot be paired in** (`identity::GROUP_IS_FULL`, from `identity::room_for`,
  asked by both `pairing::confirm` and `pairing::complete`). It counts **live rows only** — a
  `revoked_at` tombstone an older build wrote must not cost a reader a slot — and it **excludes
  the device that is joining**, so re-running the ceremony with a device already on the roster is
  never what fills the group. That matches `admitDevice`'s upsert at the relay end, and it is the
  one case a reader runs the ceremony a second time for. See "Five devices" below for why this
  refusal is a message and the relay is the fence.
- **A group with no membership cannot remove a device** (`identity::NO_MEMBERSHIP`, checked by
  `commands::entitled` before anything moves):

  > Removing a device changes the key your devices share, and that change has to reach the others
  > through the relay. Connect a membership first.

  `/rotate` authenticates against an auth only `/claim` can seed, so an unentitled group has no
  way to publish a rotation — and rotating locally anyway is exactly the bug above. This is the
  honest answer rather than a limitation: until a membership exists nothing is syncing, so there
  is nothing a removal would be protecting.

  ⚠️ **A freshly paired device answers this refusal for one sync**, and it is the design's cost
  rather than a bug. It holds no `SUPPORTER_STATUS` until the group door has answered it once, so
  `entitled` reads `false` and Remove says *Connect a membership first* even though the group has
  a membership. It self-heals on the first round trip, and refusing any later than this would
  break the "refuse before the round trip" ordering that keeps a failed removal from moving
  anything.

**The dialog's wording is load-bearing and not copy:**

> Removing a device changes the key your devices share, so it can read nothing new from now on.
> It keeps whatever it already synced — this app cannot reach into it and take that back, and no
> server has a copy to delete.

A dialog that said only "Remove" would imply a lost laptop had been wiped, which is the opposite
of what happens.

**There is still no "Rotate key now", and its reason has expired.** `identity::rotate_key` was
written, tested and deleted before PR 6 shipped, on the argument that with no relay a rotation A
performs cannot reach B at all — so a rotation with nobody removed would silently lock the group
out of itself with no way back but re-pairing. **That is precisely what the rewrap hop above
builds**, and a bare rotation would now reach every device on the manifest and cost them one
`/keys` round trip each. So the press is missing rather than refused: nobody has asked for it, it
is one more thing to explain on a panel that already carries the five refusals above, and the one
event that genuinely needs a new key — a removal — rotates on its own. **Re-open it as a decision,
not by citing this paragraph**, which no longer argues anything.

### The departure — *"leaving is always possible"*, taken literally

**There is a `Leave group` press since 2026-08-30**, which reverses the paragraph that stood here.
`pairing::sync_group_leave` → `pairing::leave_group_now` is three steps, and the third running
whatever the second answered is the whole of the guarantee:

1. `identity::plan_departure` — `plan_rotation`'s body with the self-check **inverted rather than
   relaxed**, so the manifest is everyone *except* this device and the group closes behind the
   leaver on every device that adopts, exactly as a removal does. **The leaver seals every blob and
   is on no manifest it publishes**, so a device that stays can adopt only because `check_keys`
   tries its whole roster as sealers, not the manifest alone — it did not, and until it did every
   device that stayed failed the AEAD on every trip after a press of *Leave group*. Both
   entrances call one private `plan`. **The guard stays on `plan_rotation`** because removing
   somebody else and leaving
   yourself are different acts: a single entrance that took either would let a mis-click on a
   roster row throw this device's own key away.
2. `client::post_rotation` — **best effort**. A 500, a timeout or a plane is not a reason a reader
   cannot leave.
3. `identity::leave_group` **and** `entitlement::clear` — **unconditionally**.

⚠️ **"Everything after the in-a-group check is best effort" includes the *planning*, and that
breadth is the feature rather than sloppiness.** `plan_departure` reads every peer's public key
and seals a blob to each, so one roster row an interrupted rotation left behind would otherwise be
a device that could **never** get out of its group — a chain that gave up on its first `?` is only
*usually* possible. The single refusal is a device that is in no group at all
(`identity::NOT_IN_A_GROUP`, `pub` since 2026-08-30 so the panel and the command cannot spell one
sentence twice). **What a failed plan costs is the courtesy, never the departure**: nothing is
published, so the devices that stay go on listing this one until somebody removes it by hand.

**"Always possible" had quietly depended on the write lock, and issue #546 took that away.**
`sync_group_leave` ran the three steps inside `sync::with_write`, which answers `db::BUSY` after
`WRITE_LOCK_WAIT` (5 s) — and a sync trip holds the write connection across its whole network round
trip, so a *Leave group* pressed during a slow trip failed with *"the database is busy"*. It then
ran through `sync::with_write_waiting`, which does everything `with_write` does except give up:
the one sanctioned unbounded wait, because a trip always ends (every request it makes has a 10 s
connect and a 30 s read timeout) and a departure is the reader's instruction rather than an
optional write. **Since 2026-10-03 the thing it waits for is the sync lane** (`State::lane`, where
every other press takes `State::lane_for_press`): a trip no longer holds the connection across its
requests — *A trip holds nothing across a request*, below — so what a departure queues behind is
the one lock every sync operation takes, and the promise is the same one. Measured in the shipped
window against a loopback mock relay: a Leave pressed one second into a six-second trip waited
5.0 s, published its rotation the moment the trip's pull answered, and cleared.
`sync_device_revoke` keeps the 5 s answer on purpose — a removal is refused without
the relay anyway and starts with a round trip of its own. **A departure plans two epochs ahead** once
the relay has advertised it (`identity::plan_departure_by` with `client::removal_step`), the
removal marker under *One correction to the plan*, below.

**The leaver mints the key the devices that stay will use, and that is not new exposure.** It
reads badly on its own, and what makes it harmless is that leaving is *voluntary*: a device
that wanted to go on reading the group would simply **not leave**, and would keep the key it
already holds. The threat this would defend against is one the actor has already declined to be.
What it buys is the honest half — when the relay is reachable the group closes behind the leaver
on every remaining device's next trip. When it is not, the reader still leaves and the others go
on listing a device that has gone, **and the panel's `LEAVE_WARNING` says so before the press**
rather than hiding it.

**`clear` and never `revoke`**, for the removed device's reason one section up: nothing ended, so
`entitlement::membership_ended` must not read true and the panel draws *Not connected* rather than
*Membership ended*. **The grant goes at all** because a leaver keeping its refresh secret keeps a
*working credential for the group it left* — the refresh door mints a token whose `grp` is that
group and `/g/{group}/push` honours it.

**No round trip in front of it, unlike `remove_device`.** That one absorbs the *departing*
device's last push before the key moves; here the departing device is this one, and what it has
not pushed it keeps — the rows are already in its own database. Nor is there a membership check: a
removal is refused without one because it must reach the other devices to mean anything, and a
departure means something locally whether or not it publishes.

**The one thing leaving costs that removal does not is the payer's binding**, and that is why
`/claim` had to learn to rebind — "A re-claim moves the binding" below.

### A cursor is a place in one group's log, and it goes with the group

**Fixed 2026-09-28.** The adversarial review of issue #546's branch spotted it, and no test had
covered it. The relay's `seq` is an `AUTOINCREMENT` per Durable Object, and there is one Durable
Object per group, so `pull_cursor` and `last_acked` are positions in **one** group's log and mean
nothing in the next. Until that date `identity::leave_group` deleted the roster, the group, the
superseded keys and `pull_hold`, but it left both of those standing, and nothing on the join path
reset them either. A device that left group A at cursor 500 and paired into group B:

- **asked B for `since=500`**, and `relay/src/group.ts` seeds the head it answers with the cursor
  it was asked. So a B whose log was shorter than that answered no envelopes and handed `500`
  back. The device never received B's rows below 500, and the baseline a new peer is handed carries
  current state, never a delete;
- **acked 500 to B** once B's log passed that number. B's compaction floor is the lowest ack, so B
  could compact rows this device had never read;
- **skipped its ack entirely** when B's head happened to land on the stale `last_acked`, because
  `client::ack` sends nothing for a cursor equal to its watermark. B's relay then never heard from
  this device at all;
- **heard no doorbell** for any of it. `live::pull_cursor` reads the same key on every frame, and
  `Scheduler::wake` schedules nothing for a `head` at or below it. `live.rs` keeps no copy of its
  own, so the fix below reaches it with no change there.

**Two halves, and the second is not redundant:**

1. **`leave_group` forgets the three keys that are a place in the log**: `pull_cursor`,
   `last_acked` and `pull_hold`, through `identity::forget_log_position`. It is the one place a
   device stops being in a group, and it has two callers: a *Leave group* press
   (`sync_group_leave` → `pairing::leave_group_now`) and `client::check_keys` reading a removal
   notice.
2. **`found_group` and `join_group` forget them too, whenever the group id moves**, and this half
   exists for devices that already left. Every device that left or was removed under an earlier
   build still holds its old group's cursor today, while in no group, and its next pairing is the
   first moment anything can tell. **`join_group` keys this on the group id alone**, not on the id,
   epoch and key that decide whether the superseded keys survive. `pairing::confirm` re-writes the
   initiator's own group on every pairing, and a re-pair after a removal carries the same id at a
   newer epoch. Both are the same Durable Object and so the same log, and forgetting the cursor
   there would re-download that whole log on every pairing.

Tests in `identity`: `leaving_forgets_its_place_in_the_relays_log`,
`joining_or_founding_another_group_starts_from_the_first_row_of_its_log` and
`re_writing_the_group_it_is_in_keeps_its_place_in_the_log`. Tests in `client`, end to end against a
mock relay that answers a stale cursor the way `group.ts` does:
`a_device_that_changes_group_pulls_the_new_log_from_the_start` and
`a_device_that_changes_group_acks_the_new_log_at_the_old_logs_number`.

⚠️ **What this does not repair: a device that already made the move under an older build.** It is
in B now with a cursor that started from A's number, so it never passes through a join again, and
nothing on either side can tell a cursor carried in from A from one earned in B. The rows it
stepped over stay stepped over. Pressing *Leave group* and pairing again starts it from B's first
row.

---

## Schema — user v28

Three tables, all `Side::User` in `schema::TABLES` and all `None` in
`mirror::watch::surface_of`.

| Table | Holds |
| --- | --- |
| `sync_identity` | one row: this device's id, its X25519 keypair, its name |
| `sync_group` | one row: the group id, the epoch, the 32-byte group key |
| `sync_devices` | the roster, `WITHOUT ROWID`. **A removed row is deleted since 2026-08-30**; `revoked_at` stays on the table for the migration's sake and is read but no longer written |

**Three tables rather than three `app_meta` rows**, and the difference is what a bad value costs.
Every key in `app_meta` is a *preference* — `get_app_meta` swallows a read error and every caller
falls back on a default, which is right for a zoom level and catastrophic for a secret key: a
corrupt row would read as "not paired" and the app would cheerfully offer to pair again while the
reader's other device kept encrypting to a key this one had just forgotten.

**Both single-row tables carry `CHECK (id = 1)`.** Two identities on one device is the bug where
sync silently forks, so the database refuses it rather than the code remembering to.

**They map to nothing in the mirror for the sharpest reason on that list**: a mirrored file
quoting any of them would write a key into a folder the reader syncs with Dropbox.

**v28 is the first rung above the split**, and it is what turned `schema::migrate_user` from a
version check into a ladder. A rung there is owed a line in `USER_SCHEMA_SQL` as well — that is
what a *converted* or fresh file is built from, and it never climbs anything —
and the two are held together by
`the_user_schema_is_byte_identical_to_what_the_ladder_builds`, which compares
`migrate_single_file` + `migrate_user` against `create_user_schema` byte for byte. A rung written
into only one of the two places is a fresh install that quietly disagrees with every upgraded
one, and that is the shape this test exists to catch.

It also needed `split::extract_user_file` to learn to **skip a user table the legacy file never
had**. That could not happen before v28 — the frozen ladder and the head shape were the same
fifteen tables — and left alone it would have failed every upgrade from a pre-27 folder with
`cannot split: 'sync_identity' has no columns in common`.

---

## The two things §7.5 asked for — both are here now

**This section used to read "there is no scanner" and "there is no relay [for pairing]." Both
claims are false as of 2026-08-31**, closed by
[the one-sided pairing and QR design](../superpowers/specs/2026-08-31-one-sided-pairing-and-qr-design.md).
Here is what replaced each, and — for the scanner — the wrong reasoning this section carried and
what chasing it cost.

**The scanner exists, and it is a component rather than a native plugin.** One `<QrScanner
onCode={…} />` opens the camera, draws frames to a `<canvas>`, and decodes with `jsQR`, because
`BarcodeDetector` is `undefined` in WebView2 (measured below) and a platform decoder was never on
the table. The raw string it reads goes through the same `Invite::decode` a pasted code always
did: `decode` takes everything after the last `#` before it filters, so a URL and a bare code both
work.

⚠️ **The CSP sentence this section carried was wrong about the *mechanism*, not merely
out of date, and it is worth recording exactly how.** It read: *"the Tauri webview has no camera
permission, `getUserMedia` is not reachable under the CSP in `tauri.conf.json` (`default-src
'self'`, no `media-src`)."* **CSP has no camera directive.** `media-src` governs a `<video src>`
URL fetch; a camera stream is assigned through `srcObject`, which is not a fetch and was never in
CSP's reach. Measured in the running window, 2026-08-31, debug, `npm run tauri dev`, driven over
CDP:

| probe | answer |
| --- | --- |
| `window.isSecureContext` | `true` |
| `navigator.mediaDevices.getUserMedia` | `function` |
| `document.featurePolicy.allowsFeature('camera')` | **`true`** |
| `navigator.permissions.query({name:'camera'})` | **`granted`** |
| `enumerateDevices()` | an `audioinput`, a **`videoinput`**, an `audiooutput` |
| `getUserMedia({video:true})` | **`NotSupportedError: Not supported`** |
| `getUserMedia({audio:true})` | **`NotSupportedError: Not supported`** |

**Audio failing identically is what actually settled it.** Every camera-specific theory — a
missing permission, a missing device, a policy block — predicts audio working while video refuses;
audio refused too, with the permission reading granted and a device enumerated. What was left was
neither CSP nor the camera.

**The real cause: an unhandled WebView2 `PermissionRequested` event, surfaced under a name that
points at the wrong bug.** Relaunched with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` carrying
`--use-fake-ui-for-media-stream` alone — which fakes only the *permission prompt*, not the device —
the same call answered `ok` against a real `Lenovo 500 RGB Camera (17ef:482f)` at 640×480 @ 30 fps.
So the capture stack was present and working throughout; what failed with no flag was the
permission request going unhandled, which WebView2 reports as `NotSupportedError` rather than the
`NotAllowedError` anybody debugging a permission refusal would expect. **That misleading name is
why this cost a session before this measurement existed, and why it is written down at this
length now.** The shipped fix is the scoped one — `PermissionRequested` handled through
`webview2-com`, granting **`CAMERA` and refusing every other permission kind** — over the blunt
alternative the flag above proves works, which grants camera *and* microphone to the whole webview
forever. ⚠️ **"Scoped" is about the permission **kind**, not about time or about which request
asked.** This sentence read *"granting only the request the app made and only while it was
asking"* until 2026-08-31 and that was an overstatement of what `camera.rs` does: the handler is
registered on the window's `ICoreWebView2` for the whole life of the webview, and it answers
`CAMERA` with `ALLOW` unconditionally, without consulting the requesting origin or whether the
scanner is on screen. What that costs is bounded by there being exactly one page in this webview
and one thing in it that asks — nothing is granted to a page that never asks, and the reader's
camera light is on only while `QrScanner` is mounted, because the *stream* is what turns it on and
that component stops every track it opens on every exit path. Making the grant conditional on the
scanner being mounted would need state shared between the page and this handler and buys nothing
against the threat a single-page desktop app has. ⚠️ **"Exactly one page in this webview" was an
assumption nothing enforced, and on 2026-09-28 it stopped being one** (issue #545): there was no
navigation handler, and `dragDropEnabled: false` is also what keeps wry from calling
`SetAllowExternalDrop(false)`, so a link dropped on the window should have loaded a remote page
that was then handed a silent camera — reasoned from wry's source, not driven live. The handler now
reads the request's `Uri` and grants `CAMERA` only to the app's own origin
(`app_origin::AppOrigins` — the embedded frontend, or Vite in a dev build), and a navigation guard
in the same module refuses any top-level navigation off it. Neither the kind rule nor the
scanner-mounted argument above changed. The pipeline
was then confirmed end to end under the *shipped* CSP: `devCsp` and the production `csp` differ
only in `connect-src` and `style-src`, neither declares `media-src`, so both fall back to
`default-src 'self'` — and a real camera frame through `<video srcObject>` → `canvas.drawImage` →
`getImageData` measured **640×480, 307 200 pixels, mean red 109, 307 200 non-zero**: a live image,
not a black frame.

**The relay carries the other two blobs now.** §7.5 step 4 — "A wraps the group key to B's public
key and sends it through the relay" — is built, for *pairing* rather than only for a rotation:
`sync_pairing_accept` posts B's answer to `/p/{rv}/join` and `sync_pairing_confirm` posts A's
sealed key to `/p/{rv}/offer`, a short-lived, unauthenticated **rendezvous** that carries both
without either device holding a token. [The protocol table](#the-protocol-step-by-step) above is
the ceremony as it stands now, and
[the route table](#the-relay-five-group-routes-three-of-them-behind-an-auth-gate) below has the
two new routes and why they stand outside the gate.

## What PR 7 changed, and what it did not

**The crypto, the SAS, the roster and the rotation are all PR 6's and PR 7 changed none of them.**
What it added is the transport below, `errors::Source::Relay`, and the two Settings panels that
read the relay and the review queue. **The rotation did change on 2026-08-30** — it publishes to
the relay now and commits only when the relay accepts it. See [§7.6](#76--unpairing-and-revocation).

**The distinction this paragraph used to draw — a pairing's wrap stays hand-carried, only a
rotation's crosses the relay — closed on 2026-08-31, and closing it is the whole of this branch.**
A *pairing* wraps the group key to a device that is not in the group yet, so it can carry no token
and the six digits exist precisely to distrust whatever hop would carry the wrap; the rendezvous
above answers that by carrying the wrap over a route the token gate never sees, addressed by a
one-way derivation of the pairing's own one-time token rather than by anything either device is
already trusted to hold. A *rotation* wraps the group key to devices already on the roster, over
`/rotate`, authenticated by a public key both ends already hold — a different wrap, to different
recipients, through a different route, and it is still the one this paragraph originally described.

---

## The crates, and why these versions

| Crate | Pin | Why |
| --- | --- | --- |
| `x25519-dalek` | `3`, features `static_secrets` + `getrandom` | `static_secrets` because a device's key is reused for every pairing it ever does — an `EphemeralSecret` is consumed by its one `diffie_hellman`. `getrandom` is what supplies `StaticSecret::random()`, so this crate never holds an RNG of its own. |
| `chacha20poly1305` | `0.10`, **not 0.11** | 0.11 moves RustCrypto's array types to `hybrid-array`, which would stand a **second** array stack beside the `sha2 0.10 → digest 0.10 → crypto-common 0.1 → generic-array 0.14` this tree already carries. |
| `hkdf` | `0.12` | Sits on that same stack. |
| `getrandom` | `0.3` | `fill` is the whole API this uses. |
| `qrcode` | `0.14`, `default-features = false` | The app renders the matrix itself in the webview, so the crate's own `image` and `svg` renderers are dead weight. Nothing had to be put back. |

**Measured with `cargo tree -d` on 2026-08-28**, which is the check rather than the paragraph
above: `generic-array`, `crypto-common` and `digest` are each **single-versioned** after this
change. `getrandom` shows three majors — 0.2, 0.3 and 0.4 — and **all three were in the lockfile
before it**: `tauri` brings 0.3, `tempfile` brings 0.4. The `0.3` pin therefore lands on a copy
that was already there and adds nothing.

**XChaCha20-Poly1305 rather than the 96-bit-nonce variant**: a 192-bit nonce can be drawn at
random for every message with no counter to keep, and a counter kept across three devices and a
restore-from-backup is exactly the thing that gets reused.

---

## The workbench

`.storybook/fake/db.ts` answers all nine commands, and **there is no cryptography in it**. The six
digits are derived from the code with a plain hash — the workbench has no X25519, no HKDF and no
relay. **It does have a QR encoder, since 2026-10-04** (`.storybook/fake/qr.ts`, read back by `jsQR`
in `qr.test.ts`): the QR is the real 53-module symbol of `…/pair#<code>` for a code with no key in
it, where it used to be a 21×21 picture of the right shape. `sync_pairing_accept` takes that URL as
`Invite::decode` does, so a story's code can be scanned (`npm run mobile:scan-smoke`), and the
fake's copy of `RELAY_BASE` is held to the crate's by reading `entitlement.rs` as text.
**What it models faithfully is what a panel is drawn against, and this changed shape on
2026-08-31**: one number both readers compare, a poll that finds the other side's turn on its
*second* ask rather than its first — there being no second world here for a story to answer from
any sooner — and a store that keeps a removed device the status command does not answer with.
Every refusal these handlers raise is one the crate raises, in its own words. **This paragraph used
to say the fake models "two blobs carried by hand"; since this branch there is nothing to carry —
`sync_pairing_poll` is the one command a story drives twice to see both turns**, in place of the
two panes a hand-carried ceremony needed.

- **`paired` is a seed**, not a fault: being paired is where a reader arrives after two presses,
  and it is the only state the roster, a removed row the panel filters away and the key version
  are reachable from. The seed keeps its removed device precisely so the story asserting its
  absence on screen is asserting something that could fail.
- **`pairingReadError` is a fault**, and **since 2026-08-31 it lands on `sync_pairing_poll`, on the
  offering device's read of the joining device's answer — not on `sync_pairing_respond`, which no
  longer exists as a command**: the rendezvous moved that read inside `poll`, and the fault moved
  with it. Every other way the flow fails is a *shape* the handler raises itself, and what is left
  is the blob failing to open — which in the crate is an AEAD refusing to authenticate, and nothing
  a person types produces a well-formed blob that will not decrypt.


## Driven in the shipped window, 2026-08-28

The workbench above has no cryptography in it, so everything it proves is a fact about a *panel*.
This is the pass against the real one — `tauri dev`, debug, on a worktree that had just done its
own first-run sync (**117 606 cards**), which means schema **v28 arrived through
`USER_SCHEMA_SQL`** and the three tables were created on a fresh install rather than migrated.

| What was driven | What the real window answered |
| --- | --- |
| Settings → **Devices** on an unpaired database | "This device — not paired with anything yet", and a device id of **32 hex characters** generated by the crate rather than by the fake. **That first phrase is history**: `identity::mint_name` gives a device the machine's own name from 2026-08-29 on, so a desktop reads `MAIN-PC` here and `This device` is only ever the roster's pill — see [§the name a device mints](#the-name-a-device-mints) |
| **Pair a device** | A QR `<svg>` at **224×224 with 853 module elements**, drawn from the matrix `qrcode` produced — the first proof that the crate emits a matrix at all, since the fake returns a picture of the right shape |
| The typed code beside it | **21 groups of 5, 105 characters.** That is [§the invite](#the-invite)'s arithmetic landing exactly: 64 bytes at 5 bits per Crockford character is 103, plus the 2-character checksum |
| **Codes match**, pressed with nothing read | **Refused.** Still unpaired, still offering, no state moved |
| **Cancel** | Back to the two starting buttons |

> ⚠️ **The SAS gate is the one thing here worth driving rather than unit-testing, and it is why
> this pass happened.** `Codes match` is `aria-disabled="true"` with `cursor: not-allowed` — and
> `aria-disabled` is **not** `disabled`, so the button really is clickable and a synthetic press
> really does reach the handler. A test that asserts the attribute proves the styling; only
> pressing it proves the refusal. It refused.

**What a single machine structurally cannot show, and what is therefore still owed.**
`tauri-plugin-single-instance` gives a second copy exit code 0 and no process of its own, so **no
pass on one machine can complete a pairing** — everything past "read their answer" needs two
devices. ⚠️ **A second *window* is not a second device and cannot stand in for one**
([multi-window.md](multi-window.md)): since 2026-09-20 a relaunch opens one, but every window in
that process shares the one `AppState`, the one write connection and therefore the one
`sync_identity` — so two windows pairing would be one device reading its own invite. The
crossed halves ([§the two blobs](#the-two-blobs)) are covered by
`two_databases_pair_and_agree_on_the_key`, which drives two connections in one process; that is
the strongest evidence available until a second device exists.

**Also not shown here: the upgrade.** A worktree is a fresh install, so this pass exercised
`USER_SCHEMA_SQL` and never ran the `migrate_user` rung. The `split::extract_user_file` fix — the
one that stops `convert` refusing a `sync_identity` table the legacy file has never had — sits on
exactly that path. It has unit tests; it has not been driven against a real pre-27 `mtg.db`.

---

# PR 7 — the relay and the conflict engine

Everything above is the pairing *protocol*. What follows is the transport and the rules, added
2026-08-28. **Every figure in this half is from a release build on Windows unless it says
otherwise**, and the debug/release difference on this machine is roughly 8×.

Spec §7.2 (what syncs), §7.3 (conflict semantics), §7.4 (what the reader sees), §7.7 (the relay).

---

## What syncs: eighteen tables, and the spec's twelfth still does not exist

`schema::SYNCED_TABLES`:

`collection_entries` · `collection_folders` · `deck_audit` · `deck_cards` · `deck_categories` ·
`deck_folders` · `deck_labels` · `deck_note_cards` · `deck_notes` · `deck_todo_lists` ·
`deck_token_printings` · `deck_tokens` · `decks` · `device_names` · `muted_tags` · `sticky_notes` ·
`wishlist_entries` · `wishlist_folders`

**Eighteen, and not for the reason the spec's own count would suggest.** The spec's list names
`deck_allocations`, which **schema v25 dropped** — which deck holds a card is now which folder
its row sits in, so the work that table did is inside `collection_folders`, which is on the
list. A table that does not exist cannot be synced, and that argument has not changed: it is
why `deck_allocations` stays off this list for good. What brought the count back to twelve is a
different table entirely — user schema **v31** added `device_names` (what each device in the
group is called), a table the spec predates and never named. Two tables have each been "the
twelfth" at different times, and they are not the same table: the spec's was dropped and is
gone for good, this tree's is real and the spec never spoke of it. The count moved twice; the
intent behind the first move did not. **The thirteenth is `deck_tokens`, at user schema v37** —
one row per token a deck's reader has deviated on, holding the art they picked, how many copies
they want and whether the row is dismissed or hand-added. (Since v52 it holds only the last of
those three; the art and the count moved to the seventeenth, below, and its `card_id` and
`quantity` still travel as fields a v52 device writes no more.)

**The fourteenth and fifteenth are `deck_notes` and `deck_note_cards`, at user schema v43**
(2026-09-10, issue #447) — many notes to a deck where there used to be one `decks.notes` column,
and one row per card a note names. **They are the first rung to take a column *off* the census
as well as putting tables on it**, and the two halves are worth separating. Putting a table on is
the ordinary ten-site job below. Taking `decks.notes` off is the direction nothing had a rule
for, and the rule turns out to be that there is nothing to do: `apply::updates()` iterates the
**local** spec's field list and looks each name up in the incoming op, so a field a peer still
sends and this build no longer has is never visited. It is not an error, it does not fail the
row and it does not roll the group's savepoint back — so unlike an unknown *table*, a dropped
*column* cannot stall that peer's stream. A v42 device keeps sending `notes` and keeps its own
dead paragraph; a v43 device ignores it and both go on syncing decks in both directions.
`a_field_this_build_no_longer_syncs_is_skipped_rather_than_stalling` is that paragraph made
checkable, and it splices the field into a real captured op rather than hand-writing one —
because a v43 build emits no `notes`, so a test that only *hoped* the field was there would pass
while proving nothing.

**`deck_notes` is the fifth table on this census with no grain at all**, joining `decks`,
`deck_folders`, `wishlist_folders` and `deck_audit` — **not all three folder tables**, which this
line said until it was re-read against `apply::META` on 2026-09-20: `collection_folders` carries
two partial grains, for the `Recently removed` row every database seeds itself and the group
folder a deck brings. `sticky_notes` made it six at v46, and `deck_todo_lists` seven at v59. Two devices each typing a note about the mana base must
stay two notes, and there is no column pair that could tell an accidental duplicate from a
deliberate one — a title grain would silently fold two readers' separate thoughts into whichever
arrived second. **`deck_note_cards` needs one for the opposite reason**: two devices attaching
Lightning Bolt to the same note describe *one* fact, and without `idx_deck_note_cards_grain`
both rows land and the card modal reads two notes where there is one. Its grain is
`(note_id, oracle_id)` with the parent resolved through `deck_notes` rather than `decks`, which
is why its `apply::Meta` rank is 14 and sorts after the note's 13.

**A note names a card by `oracle_id` and never by `card_id`**, which is `deck_tokens`' argument
verbatim: a printing id means nothing on the far device's shelf. What it buys beyond sync is that
a note survives the reader swapping printings, and shows on the Live list and the Theory list
alike, because both hold the same oracle id.

**The sixteenth is `sticky_notes`, at user schema v46** (2026-09-20, issue #479) — the reader's
prose on the home page, filed against no deck, no folder and no collection row.
It syncs for `deck_notes`' reason and not `activity`'s: what it holds is typing, and a note
written on the desktop that never reaches the laptop is lost prose rather than a lost preference.
It has **no grain, uid only**, `deck_notes`' argument verbatim — two devices each typing a note
about the same thing must stay two notes, and no column pair could tell an accidental duplicate
from a deliberate one.

⚠️ **Its `capture::Spec` is the fourth empty `parents`, not the first**, and the design document
this table was built from called it a first. `deck_labels`, `device_names` and `muted_tags` are
already parentless — a label is app-wide since v21, a device name is keyed on the device, a mute
is keyed on the tag — so the *shape* is precedented and worth reading before quoting that sentence
back. What is new is only that a parentless table on this census now holds the reader's prose.
`schema.rs`'s own `SYNCED_TABLES` comment still says "first"; `capture.rs`'s spec says "fourth"
beside the field it describes, and the spec is the one that was written against the array.

⚠️ **`color` carries no CHECK, and the rule is not "a synced column may not have one".** Seven
tables on this census carried an enumerated one between them when this was written:
`collection_entries.finish` and `condition`, `decks.cover_kind`, `deck_categories.kind`,
`deck_cards.variant`, `deck_audit.variant`, `collection_folders.kind` and `deck_tokens.state` — and
user schema v52 made it eight, with `deck_token_printings.variant` and `.finish`, plus
`decks.token_mode` on a table already counted. Those vocabularies are Magic's or this app's
own model, and a build does not get to add to them unilaterally — a rung would, and a rung moves
every device. (`token_mode`'s `CHECK` carries PR 3's `collection` from the start for exactly that
reason: the word is in the constraint before any build writes it, so no rung is owed later.)
**A note's colour is a palette the page owns and expects to grow**, which is what turns a
constraint into a forward-compatibility hazard: a build that added a sixth colour would
emit rows an older build refuses **at apply**, and a failed apply rolls the group's savepoint back
rather than showing a note that looks wrong. So Rust stores the string it is handed and the page
maps a word it has never heard of to `slate`. It is *A table's NAME is on the wire* below, one
column type down — a vocabulary that can grow between builds must not be enforced by anything a
peer can trip over.

**`deck_tokens.quantity` travels as a `field` and not as a `counter`, and it is the first column
on this census where the distinction had to be argued.** Mechanically the column is nullable, so
there is no `NEW - OLD` to carry — `deck_cards.quantity` can be a counter precisely because it is
`NOT NULL`. Semantically last-write-wins is what is wanted: `deck_cards.quantity` sums because two
devices each sleeving a copy means two copies, but *how many Treasures I want to bring* is a
**setting**, and two devices each setting it to 4 must mean 4 rather than 8. No counter also means
no `Floor` in its `apply::Meta`. It carries a `Grain` restating `schema::DECK_TOKEN_GRAIN` —
`deck_id` from `Source::Parent`, `oracle_id` from `Source::Field`, because a local deck id means
nothing on the far device while an oracle id is Scryfall's — for `deck_labels`' reason: without it
two devices that each picked an art for the same token in the same deck hold one row under two
uids, and the far op is an insert that hits the unique index, rolls the group's savepoint back and
never lands — deferred for ever when this was written, skipped and recorded since 2026-09-27.
`decks.tokens_open` joined the `decks` `Spec` in the same rung, beside
`separate_x_group` and the three `last_*` view columns: it is per-deck view state, and a reader
who opened that area on one device meant it about the deck rather than about the machine.

**That rung is also what turned "nine registrations" into ten.** The tenth is
`sync_engine/apply/tests.rs`' `every_unique_index_on_a_synced_table_has_been_decided_about`, which
reads every UNIQUE index off a live `SYNCED_TABLES` and compares it against a written-down list,
so it goes red on any new synced table that has a grain. It is easy to miss because it sits in a
`tests.rs` rather than beside the other nine — the rung, its `USER_SCHEMA_SQL` lines, the
`UNDO_V<N>`, `schema::TABLES`, `mirror::watch::surface_of`, the `sync_uid` column and index,
`SYNCED_TABLES`, a `capture::Spec` and an `apply::Meta` — and because nothing at a registration
site points at it.

**The seventeenth is `deck_token_printings`, at user schema v52** (2026-09-26, the token-stacks
spec §4) — a token's printings as **entries**, one printing in one finish in one list with a
quantity, split out of `deck_tokens`, which keeps the token-level state (`auto`, `hidden`,
`manual`) and whose `card_id` and `quantity` are legacy from that rung on. Its `quantity` is a
**field**, on `deck_tokens.quantity`'s second argument alone this time: the column is `NOT NULL`
and could carry a delta, and a count of Treasures is still a setting. Its grain is
`(deck_uid, variant, card_id, finish)`, restating `schema::DECK_TOKEN_PRINTING_GRAIN`; `finish` is
`NOT NULL`, so the predicate needs no `coalesce`, and `oracle_id` travels as a field because the
far device may not hold the printing to derive it from. `decks.token_mode` replaced
`decks.token_stack` on the `decks` spec under a **new name**, v49's precedent: a v51 peer skips a
field it does not know, where a word landing in its INTEGER column would fail its deck read.

**The eighteenth is `deck_todo_lists`, at user schema v59** (2026-09-29, issue #688) — a deck's
titled to-do lists, several to a deck, and **the first table on this census that a rung before it
argued its way off**. v58 (issue #672, the same day) stored one checklist per deck in
`decks.todos` precisely so that it would owe none of this page's sites: one list to a deck was a
column's shape, and the `decks` spec carried it per field. The owner then asked for several titled
lists drawn as cards, and several of a thing is a table's shape — so v59 paid the census after all
and took `todos` back off the `decks` spec, the second field ever removed from a spec after v43's
`notes`, costing nothing on the wire for that rung's reason: a v58 peer goes on sending the key and
a v59 device's `apply::updates()` never visits it. What does not flow is the other direction — a
v58 device holds a v59 sender's stream on the unknown table until it upgrades — and every edit a
v58 device makes to its column after its peer climbed is lost to that peer. The groups this app
has are one reader's devices, and the cost ends at the update.

It is `deck_notes`' twin on this page: **uid-only, no grain** — two devices each starting a list
while apart must stay two lists, and two readers' `To-do` titles are the ordinary case rather
than a collision — `title`, `body` and `sort_order` as fields, the deck as an `Absent::Null`
parent, and `apply::Meta` rank 17, appended. **The rows v59 converts need no grain to meet
either, and that is the design rather than luck**: the rung converts each device's own
`decks.todos` with capture off, as v53 cloned its theory piles, and names each row
`schema::todo_list_uid(<deck uid>)` — SHA-256 over `deck_todo_lists/legacy/<deck uid>`, cut to 32
hex. `decks.todos` synced, so every device in a group converts the same text under the same deck
uid into the same row under the same name, and the next tick on any of them lands on that row
everywhere with nothing announced. A deck with no uid gives a row with none, and the mint names it
later. This is the v53 shape and deliberately not v52's captured launch pass: v52's rows were
derived from picks a v51 peer could go on changing, which is what made a rung-time conversion
stall; here the source column is simply no longer read, and a v58 edit made after the climb is the
mixed-version cost above rather than a stall.

**v51's art picks become entries in a captured launch pass, and until 2026-09-26 the rung did it
uncaptured.** The rung copied each picked override into one entry per list, named
`<override uid>-live` and `-theory`, on the argument that every device climbs over the same synced
override and so derives the same row under the same name with nothing sent — and it dropped
`deck_tokens`' three capture triggers so that its clear of the override stayed off the wire too.
**A group with a device still on v51 broke that argument in both directions**, each break a stream
stalled for good:

- **A pick made on the v51 device after the other device climbed** was converted by the picker
  alone, when *it* climbed, under a name the first device had never derived. The picker's next count
  step reached the first device as a sparse `{quantity}` update: `apply::find_row` could not match
  it (the uid was unknown, and a sparse op carries no grain term), the insert fallback failed
  `NOT NULL`, and the op deferred — the picker's whole stream held behind it. A throwaway two-device
  test against the rung-time design measured it: the one op, a `{quantity}` update for
  `u-pick-live`, `deferred = 1`.
- **A pick the v51 device reset** left the converter the only holder of `<uid>-live`, so the
  converter's own later steps stalled its stream to that device the same way.

This page said "one name, two contents — nothing stalls" about the first case until the same day.
That held only for a *re*-pick of a pick both devices had converted, and the rung's own comment
repeated it.

`deck_tokens::convert_legacy_picks` now runs outside the ladder, **not suppressed**, behind a gate
of two halves: `convert_legacy_picks_at_launch`, from `prepare_database` at every launch after
`capture::install`, and `convert_legacy_picks_after_pull`, from `client::pull` behind every pull
that read everything. A device in no group converts at launch; a device in one converts behind its
pulls, and at launch only once one has landed (the next paragraph is why). Every entry it derives
is a captured insert, so a peer that derived the same row merges on the uid and a peer that did not
builds it from the put; a pick arriving after the climb is converted on the pull that brings it
and announced; a re-pick moves the named entry to the new art in place, captured, so the "two
contents" window closes behind the next pull rather than at the next swap. The clears are captured
as well, and recorded
**after** the entries, so a v51 peer — deferring the first op for a table it does not know, and
the sender's later ops in the page with it — never applies a clear ahead of its entry, and keeps
drawing its art. This read "until it upgrades": ⚠️ **it keeps drawing it after, too**, because a
v51 client drops a deferred op rather than holding it, and the entries and clears are not offered
again — the hold that would keep them is v52's own client, and it cannot reach back for a page a v51
build already stepped past (*Held while it can resolve, skipped when it cannot*, below). Two losses
were accepted, both confined to a v51 device's last days: a reset made there in that window, and a
count stepped there on a pick another device has already cleared, which lands on a legacy column a
converted token no longer reads. The first was argued as "the other device's entry reaches it after
the upgrade, with nothing left to clear" — and a v51 client that pulled the entry dropped it, so it
does not reach it at all.
`a_pick_made_on_a_v51_device_after_the_climb_converges_with_nothing_deferred` and
`an_art_reset_on_a_v51_device_after_the_conversion_leaves_nothing_deferred` drive both through
`apply` with nothing deferred; the second went red, `deferred = 1`, against the rung-time
conversion. (The first cannot go red against a stub that converts at every launch, which is why
the stall was measured by the throwaway test instead.) Both now drive their devices through the
two gated halves rather than the bare conversion.

**A paired device converts behind a pull and never before one** (the fifth review round, the same
day). While it converted at launch, **a laggard's conversion silently reverted edits**: A converts
a pick at 3 and steps the live entry to 5; B, still on v51, pulls A's batch and defers it —
`deck_token_printings` is a table it does not know, and A's clear is held behind the entries, so B
still holds the pick — but `apply`'s `observe` counts deferred ops, so B's clock is past every
stamp A wrote. B climbs and converts at launch: `<uid>-live` inserted at the legacy 3 under a later
stamp than A's step, and last-writer-wins took **both** devices to 3. A finish change or a
theory-switch move made on A went the same way, and an entry A had deleted came back. Behind a
pull, B applies A's entries and A's clear first: last-writer-wins takes B's `card_id` to NULL, so
there is nothing to convert — unless B re-picked after A's clear, and then B's conversion is case
3's sparse move of A's `<uid>-live` by uid, never an insert over it. The key is the `sync_state`
row `token_picks_ready` (`deck_tokens::PICKS_READY`), set by the pull half and never cleared; a
pull held behind a key rotation neither sets it nor converts, because its unreadable envelopes may
be exactly the entries and clears the gate waits for.
`a_laggards_conversion_never_reverts_an_edit_made_since` stands in for B's observed clock by
copying A's into it — a v52 fixture cannot defer a table it knows — and went red, 3 on both devices
instead of 5, with the gate switched off; `client`'s
`a_pull_that_lands_converts_the_legacy_picks_and_one_held_at_an_epoch_does_not` drives the pull half
through a mock relay. **What it costs**: a paired device draws each unconverted token at the
resolver's printing until its first pull at v52 lands, and a paired device that never completes
one — a group with no membership, a relay it cannot reach — goes on doing so. **"Lands" means
advances since 2026-09-27**: a pull that holds its cursor has not heard everything, which is the
gate's own reason, so it neither converts nor sets `token_picks_ready`, and a device whose first
v52 pulls hold on a newer device's page draws the resolver's printing until it updates.
⚠️ **The argument above rests on a re-delivery, and a v51 client does not do one**: "B defers A's
batch" and "behind a pull, B applies A's entries and A's clear first" assume the page B deferred at
v51 is offered again once B climbs. It is not — B's v51 client stepped past it — so a B that
**pulled at v51 during the window** still holds the pick after it climbs, and the conversion behind
its first pull at v52 is the late insert that reverts A's edits; nothing at v52 can fetch a page
back from below its own cursor. The gate closes the reversion for a v51 laggard that did not pull
during the window — and, because the delivery holds ship with v52, **for every laggard on v52 or
later**, whose client holds a newer device's page until it updates and converts behind an advancing
pull only, so the page it held is re-delivered and applied before any conversion runs (*Held while
it can resolve, skipped when it cannot*, below).

**What a mixed group does across v52**, then: a v51 peer **drops** a v52 device's page from its
first `deck_token_printings` op on — that device's later ops in the page with it, the clears
among them — and upgrading does not bring them back. This read "defer on a v51 peer until it
upgrades, which is the ordinary cost of a new table"; it is the ordinary cost, and on a v51 peer it
is a loss rather than a stall, because the fix that turns it into a stall — the delivery holds —
ships in v52 and runs only on the receiving device. That is why every device in a group has to be
updated before it syncs across v52, and why v52 is the last crossing that rule is owed for short
of a rename (*A table's NAME is on the wire*, below): from v52 on, a receiver holds a newer
sender's changes until it upgrades. A v51 peer's `deck_tokens.card_id` / `quantity` ops land in
the legacy columns on a v52 device, where the pull that brings a picked art converts it and
otherwise only an untouched token's implicit count is read. **"Two names, one entry"** — a pick still in flight between two devices
under two uids when each converts it — now converges through the grain rule rather than stalling,
because the announcement is an insert and carries every grain term: `apply` finds the other
device's entry on `(deck, variant, card, finish)` and both adopt the lower uid.
**The corner that grain match used to leave is closed for conversions.** The grain includes the
finish, and each device's finish repair (below) is uncaptured. While the conversion announced every
art as `nonfoil` and left the repair to correct it, an in-flight pick of a **foil-only** printing
broke the match: a device that had already repaired its entry to `foil` received the other's
`nonfoil` announcement, found no grain match, inserted a second row, and its next repair folded the
two (doubling the count) and deleted the other device's name uncaptured, after which an edit to that
name from the other device deferred. Since the same day the conversion files the printing's own
`default_finish`, read from the corpus it runs after, so two devices converting one pick announce
the same finish and the grain matches
(`a_foil_only_pick_converts_straight_to_foil_and_the_repair_then_changes_nothing` pins the
announced `finish: "foil"`). ⚠️ **What remains is the repair's own
population, read off the code and unmeasured**: an entry filed at the `nonfoil` fallback on a
device whose corpus did not hold the printing when it converted, and a printing that loses its
nonfoil after its entry was filed. Either one, meeting a pick in flight under two uids, can still
reach the fold above. It needs two v51 devices to have picked the same token's art independently,
offline, and then one of those two — **or one v51 pick and a reader's own add**, which this page
understated until the fifth review round: a device whose corpus lacks the printing announces
`<uid>-live` at the `nonfoil` fallback, and a device where the reader had already added that
printing at its right finish — so case 1 declined to convert over it — receives the announcement,
finds no grain match, inserts it beside the reader's entry, and its next repair folds the two and
deletes the announced name uncaptured, after which the announcer's edits to that name are skipped
there and recorded — rows this database cannot build.
**The gate does not close either route.** It orders a conversion after a pull, and neither route
is a conversion racing a peer's: each is an announced fallback finish meeting a different row in a
repair that runs uncaptured, and a pull that lands first changes nothing about that.

**Two generic gaps the conversion can widen, and neither is its own** (named in the same round
and left for a follow-up — **both closed 2026-09-27** by the delivery holds). **A deck deleted
during the window cost a stream its page**: `apply::resolve_parent` deferred any child whose parent
row was gone, with no tombstone check, so a peer's entry announcement for a deck this device
deleted was deferred — and dropped, together with that peer's later ops in the page — as every
child op of a deleted parent was. It is **moot** now: a `del` for the deck in this device's own
`sync_ops`, or in the page, makes the child consumed silently, since `deck_token_printings.deck_id`
cascades and the delete would have taken it anyway; a deck deleted on a third device waited out the
bound and was skipped, recorded, until user schema v54's `sync_gone` made that moot too, for a
delete applied here from then on — `gone` has read that table since (tombstones as rows saying a
parent went, not the `del` ops of this paragraph), and not `sync_ops` (*Held while it can
resolve*, below).
**`apply::find_row`'s uid rename was unchecked**: it renamed the local row to the lower uid
without asking whether another local row already held it, and derived names make that reachable
— a v51 device re-picks art Y2 while the other device holds Y2 as a
separate entry, which case 1 declined to move — at which point the `UNIQUE(sync_uid)` error escaped
the group's savepoint and failed the whole `apply` on every pull, about half the time by uid order.
The rename is made inside the savepoint now, after a check that the uid is free, and a taken one is
a row this database cannot build: that group is skipped and recorded, and the rest of the batch
applies. The conversion adds rows and names to both windows; it created neither rule. **And one
cosmetic loss in a group of three or more**: a conversion finding every list already holding the
pick (a third device's announced entries) records its clear with no entry op ahead of it, so a v51
peer applies the clear and draws its default art — and, its v51 client having dropped the third
device's entries, goes on drawing it after it upgrades; nothing at v52 re-offers them.

**And the registrations number twelve, not ten**, counted while landing it: the ten above, plus
`src/lib/userTables.json` — which `changes.rs`' `the_json_both_suites_read_is_the_user_side_of_
the_registry` holds to `schema::TABLES` — and `src/lib/crossWindow.ts`' `TABLE_KEYS`, which
`crossWindow.test.ts` holds to that same file. Both are owed by any new *user* table, synced or
not. The three length fences (`capture::TABLES`, `apply::META`, `SYNCED_TABLES.len()`) and the
mirror's census in `every_table_in_the_schema_has_been_decided_about` are what go red first, and
are counted inside the sites they fence rather than beside them.

**A `WITHOUT ROWID` table owes one more, and `sync_gone` found it** (user schema v54, 2026-09-27,
counted while landing it; a table of tombstones in the sense of a row saying a parent went, not the
`del` ops this page also calls tombstones): `changes::MARKED_BY_COMMAND` or
`changes::WRITTEN_BY_THE_APP`, because the update hook never fires for such a table and a window
learns of its writes only by a hand-made mark or not at all.
`every_without_rowid_user_table_has_been_decided_about` holds `main.sqlite_master` to the two
lists, so a new one goes red there until somebody decides — the census counted inside that site,
like the others. (`device_names`, synced and `WITHOUT ROWID`, has owed it since the lists existed,
and is on the first.) `sync_gone` itself, unsynced, owed eight of these: the rung, its
`USER_SCHEMA_SQL` lines, `UNDO_V54` **at the head of every rewind chain, ahead of `UNDO_V53`**, and not
merely declared, `schema::TABLES`, the mirror's decided-about list (`surface_of` needs no arm — it
falls through to `None`, as `sync_peers` does), `WRITTEN_BY_THE_APP` (a press reaches it only
through its `AFTER DELETE` trigger, `apply` writes the rest, and no window draws a row of it),
`src/lib/userTables.json`, and `TABLE_KEYS` as `sync_gone: []`. Two hand-spelled fences in
`schema.rs` went red with it and are counted inside the sites they fence:
`the_user_side_is_every_table_no_feed_can_rebuild` (`schema::TABLES`) and the figure in
`the_user_schema_is_byte_identical_to_what_the_ladder_builds` (`USER_SCHEMA_SQL`) — re-counted
there rather than incremented.

Two further corrections, both found by reading `schema.rs` rather than the spec:

- **`deck_labels` has no `deck_id`.** Schema v21 rebuilt it as one app-wide list keyed on
  `name_key`. That matters here more than anywhere: two devices typing "Ramp" must converge on
  **one** row, because `idx_deck_labels_grain` is `UNIQUE (name_key)` and a second row is a
  constraint failure at apply time rather than a duplicate. **The table was `deck_tags` until
  user schema v33**, and that rename is the one place this list has ever carried a version
  boundary — *A table's NAME is on the wire* below is what it costs.
- **`needs_review` was on three tables, not two.** §7.4 names `collection_entries` and
  `deck_cards`; `wishlist_entries` has had it since schema v4. **No folder table had it at
  all** — and §7.4's second surfaced outcome is a broken folder cycle, so v29 adds it to
  `deck_folders`, `wishlist_folders` and `collection_folders`. Six tables can hold a sentence
  now, and `sync_engine::commands::REVIEWABLE` is the list, held to `sqlite_master` by a test
  that fails if a table with the column is missing from it.

**`created_at` and `updated_at` are on no capture list.** They are facts about when *this*
device wrote a row; the group's ordering is the hybrid logical clock, and syncing a timestamp
would put two answers to "when" in the database with nothing to say which one a reader is being
shown.

**`app_meta` is on no list either, and since 2026-09-07 that is a stated decision rather than a
gap nobody had reached.** The theory mark shipped three things at once and they land on opposite
sides of this census, which makes it the clearest statement of the rule the list embodies:

- **The three per-deck switches travel.** `decks.theory_mark_exact` and `decks.theory_mark_name`
  (user schema v38), joined on 2026-09-08 by `decks.theory_mark_unplanned` (**v39**, the red X a
  Live row wears when the plan does not ask for it at all), are columns on `decks`, which is on
  the list above, and each was added to
  its `capture::Spec` by hand — `bracket`'s precedent at v26. Which of the mark's three tiers a
  deck draws is an answer *about the deck*, made once by the reader, and two devices showing one
  deck's marks differently with nothing on screen explaining it is the failure that edit prevents.
  **The third column proves the census is a decision each time rather than a habit**: that spec
  spells its field list out by hand and nothing asserts a synced table's columns are all on it, so
  a rung that adds a column and forgets the spec is captured by nothing and goes red nowhere.
- **The labels travel.** `deck_labels` has been on the list since it was `deck_tags`, and the
  Appearance panel that now edits them app-wide changes nothing about that.
- **The colours do not.** They are one `mark_colors` row in `app_meta`, and **`app_meta` is not
  in `SYNCED_TABLES`** — so there is no field for a spec to leave off and no registration that
  was skipped. A rendering choice belongs to the device that draws it, which is what every other
  preference in that table already says, and the panel tells the reader so on screen rather than
  leaving them to discover it on a second device.

**What that line separates is not "state" from "settings".** Per-deck *view* state travels:
`last_variant`, `last_group_by`, `last_sort_by` and `tokens_open` are all on the `decks` spec, on
the argument that a reader who opened that area on one device meant it about the deck rather than
about the machine. The cut is **per-deck against per-device** — what a deck *is*, including how
it is being read, against how this particular screen paints it.

### ⚠️ A table's NAME is on the wire, and v33 renamed one

`Meta { table, .. }` in `apply.rs` and the literals in `capture.rs` and `baseline.rs` are the
same string, and it is what an op is addressed by. User schema **v33** renamed `deck_tags` to
`deck_labels`, so a device on v33 publishes label rows under a name a device still on v32 has
never heard of, and the reverse. **This is the first rename any synced table has had**, and it is
the reason to be sure the next one is worth what it costs.

What it costs is more than the labels, and since 2026-09-27 it depends on **which side of the
rename the sender is on** — `apply::write_group` answers `Deferred(Why::UnknownTable)` for a table
this build does not sync, and only the op's `schema` says what that means
(*Held while it can resolve, skipped when it cannot*, below):

- **A newer sender's op on a table this build has not heard of is held.** The sender's stream to
  this device stops at that op, not just its label rows — everything it wrote after it in the page
  is left unapplied — and the client holds its cursor, so the page comes back on every pull until
  this device upgrades and its stream drains from the block. That is what this section always
  claimed, and it is true from v52 on; the relay's compaction floor stays at this device's ack for
  as long as the hold lasts.
- **An older sender's op on a table this build renamed away is skipped**, recorded in the error log,
  and takes nothing of that sender's with it. Nothing can ever resolve it — the old name is gone from
  this build's census for good — so a hold would pin the relay's log for good too. What it costs is
  the rows themselves: **what an older device writes to a renamed table before it upgrades never
  reaches a device past the rename.**

⚠️ **This section said the block was the right shape because "nothing is lost", and that was
false** (corrected at token stacks PR 2's final review, 2026-09-26). It argued that the ops are
never acked and so are re-delivered, and that the moment the older device updates its stream
drains from the block. Neither happened: `client::pull` advanced and acked `PULL_CURSOR` past the
page whatever `apply` deferred, so the held ops were **dropped** — the sender's later ops in that
page with them — and updating did not bring them back. **That is still what a receiver on v51 or
earlier does**: its client is the one that advances, and nothing a newer build ships changes it.
What still stands:

- **Only the peers that disagree hold or lose anything.** The block is per-device, so a group of
  four where three have updated keeps syncing normally between those three.
- **A device that has never worn a label never blocks at all**, since the block needs an op on
  that table to exist.

The remedy is the ordinary one and there is no other: **update every device in the group, and do it
before any of them syncs across a rename** — the older side's writes are lost on the newer side
whatever the client does, and a receiver below v52 loses the newer side's too. There is no alias
table and no version negotiation on the wire, by design — a wire that accepted two names for one
table would have to keep accepting them for good.

---

## A row's identity: grain first, uid second, `min` tiebreak

Every synced table keys on `INTEGER PRIMARY KEY` — a rowid. Two devices independently create a
deck and both get `id = 1`. §7 never says what an op names a row by, and nothing in it works
until that is answered.

**Every synced row carries a minted `sync_uid` (16 random bytes as hex, `UNIQUE`), and the
applier resolves by grain first, uid second, with a `min(uid)` tiebreak.**

- **A minted uid alone is wrong**, and the counter rule proves it: two devices each adding one
  copy of the same printing mint two uids, and inserting both is two rows at +1 rather than one
  row at +2 — plus a violation of `idx_collection_grain`.
- **A grain alone is wrong too**: `decks`, the three folder tables and `deck_audit` have **no**
  unique index, so two devices' folders both called "Binder" are two folders and must stay two.
- So both. On apply the engine looks for a local row on the incoming op's **logical grain** —
  the table's own unique index with every foreign local id replaced by that parent's `sync_uid`.
  If it finds one, that is the row, and **both devices set the row's uid to the lower of the
  two**, which is deterministic and needs no alias table. If it does not, it looks by uid. If
  neither, it inserts.

| Table | Logical grain |
| --- | --- |
| `collection_entries` | `card_id, finish, condition, lang, altered, signed, proxy, misprint, serial_number, grading, folder_uid` (11 terms) |
| `wishlist_entries` | `oracle_id, card_id, preferred_finish, folder_uid` |
| `deck_cards` | `deck_uid, variant, category_uid, card_id, finish` (**five** — `finish` joined at v19) |
| `deck_categories` | `deck_uid, name` |
| `deck_labels` | `name_key` |
| `deck_note_cards` | `note_uid, oracle_id` (the parent is the **note**, not the deck) |
| `deck_tokens` | `deck_uid, oracle_id` (deliberately **not** per variant) |
| `deck_token_printings` | `deck_uid, variant, card_id, finish` (v52 — per variant, and `finish` NOT NULL so no `coalesce`) |
| `muted_tags` | `namespace, tag_id` |
| `device_names` | `device_id` (its `WITHOUT ROWID` primary key) |

`decks`, `deck_folders`, `wishlist_folders`, `deck_audit`, `deck_notes` and `sticky_notes` have no
grain and are uid-only. (`deck_tokens`, `device_names` and `sticky_notes` were missing from this
table and this sentence until v52's row was added beside them; `apply::META` is the list.)

**A table can have more than one grain, and three of them are PARTIAL indexes** — which the
plan's table misses entirely, and one of them matters from the first minute a group exists:

| Index | Grain | Why it fires |
| --- | --- | --- |
| `idx_collection_folder_removed` | `kind = ? AND kind = 'removed'` | **every database seeds its own `Recently removed`**, so two paired devices hold that row under two uids the moment they meet |
| `idx_collection_folder_deck` | `deck_id = ? AND deck_id IS NOT NULL` | one group per deck; two readers each pressing Clear collection rebuild one each |
| `idx_deck_categories_kind` | `deck_id = ? AND variant = ? AND kind = ? AND kind <> 'main'` | each of a deck's two lists has one Sideboard, one Commander, one Companion and one Maybeboard (user schema v53), and a renamed one slips past the `(deck_id, variant, name)` grain |

A partial index needs no new machinery: its own `WHERE` folds into the predicate, so
`kind = ? AND kind = 'removed'` matches the one holding area when the incoming row is one and
matches nothing when it is not. Dropping that second term makes every device's "Binder" and
every device's "Trades" one folder, because both are `kind = 'user'` — which is what
`two_user_folders_are_not_folded_by_the_partial_grain` is for.

Without the first of the three, the failure is not a crash: the insert hits the index, the
group's savepoint rolls back, and each device quietly keeps its own holding area **forever**
while every count still reads one.

**A sparse update op cannot describe a grain and does not need to** — the row it edits is found
by uid. An *insert* op carries every field, which is what makes the grain rule work at all.

**The row handle in `apply` is the uid and never the rowid.** Every synced table but two has an
`INTEGER PRIMARY KEY`; those two have none at all — `muted_tags` is `WITHOUT ROWID` on
`(namespace, tag_id)` and `device_names` on `device_id` alone. Addressing by `sync_uid` is one
spelling for all of them.

**Minting takes four sites, not one**, and one of them is the ladder (it read "three" until v52;
the fourth row was the v52 rung itself until the pick conversion moved to a launch pass the same
day, which took it off the ladder):

| Path | Who mints |
| --- | --- |
| an *upgraded* file | the v29 rung's `UPDATE … SET sync_uid = lower(hex(randomblob(16)))` |
| a *converted* file | `schema::mint_missing_uids` inside `split::extract_user_file` |
| a *fresh* file | `USER_SEED_SQL`, plus the capture trigger for every row written afterwards |
| a row **the pick conversion derives from a synced row** | the conversion itself — `deck_tokens::convert_legacy_picks` names each entry `<pick uid>-<list>`, so two devices converting one pick announce one name; a pick with no uid is first given the insert trigger's own mint (no op — `sync_uid` is on no capture spec), and its uncaptured clear is the one write of the pass no peer hears; see the seventeenth table above |

A converted file is the one that was missed first: a legacy `mtg.db` has no such column to
copy, and `split::convert` stamps *head*, so the ladder never reaches it. A NULL uid is not
cosmetic — `sync_ops.uid` is `NOT NULL`, so the first edit to such a row on a paired device
would fail **the reader's own write**.

---

## Capture: triggers, and three facts about SQLite that decide the shape

`sync_engine::capture` installs its triggers from one census, and the shape is the number rather
than the other way round: **an insert trigger for every table, an update and a delete for every
table but `deck_audit`** — the one `Spec` with `append_only: true`, since a log that is only ever
appended to needs no other arm — **plus one that advances the clock.** At eighteen tables that
is 18 + 17 + 17 + 1 = **53**, re-derived off `capture::TABLES` when v59 landed; it read 50 at
seventeen and 47 at sixteen, and before that said 31 and named ten non-append-only tables, which had been wrong since
before `deck_tokens`. Count the array, never add to the figure above.
They are `DROP` + `CREATE` at every open and never `CREATE … IF NOT EXISTS`: a trigger is stored
SQL, and a build that changed the generator would otherwise leave every existing database
running last year's rules forever.

**Not the update hook, and not `preupdate_hook`.** `update_hook` — what `mirror::watch` uses —
gives the table and the rowid but **no values**. `preupdate_hook` does give values but fires
*before commit*, so an in-memory buffer is the only record of an op between the commit and the
drain, and a crash there loses an op: a device diverged for good, silently. A trigger runs
inside the caller's transaction, rolls back with it, and cannot be forgotten by a write site added
next year.

Three things about SQLite, all measured against **3.53.0 on 2026-08-28**, decide the rest — and
the plan this was built from had the first two wrong:

1. **`PRAGMA recursive_triggers` is OFF by default and that does *not* mean a trigger's
   statements fire no triggers.** It stops a trigger firing *itself*; a trigger's `UPDATE` fires
   the `AFTER UPDATE` trigger on the same table perfectly happily. The uid mint is an `UPDATE`,
   so the plan's insert trigger wrote **two** ops per insert and failed its own one-op test.
   Two guards fix it and **either alone would do**, which a mutation established: `AFTER UPDATE
   OF <captured columns>` is syntactic and the mint names only `sync_uid`; `WHEN (NEW.a IS NOT
   OLD.a OR …)` is semantic and the mint moves no captured column. Removing either leaves every
   test green; removing both makes one insert two ops. Both stay — the `OF` clause is the
   cheaper, and the `WHEN` is the only one that can also see `UPDATE decks SET notes = notes`.
2. **The obvious sparse-field expression is exponential.** Nesting
   `CASE WHEN … THEN json_set(<expr>, …) ELSE <expr> END` names `<expr>` twice per column, so the
   generated SQL doubles per field — 2²⁰ copies of the innermost expression for
   `collection_entries`, a `CREATE TRIGGER` that never finishes being built. Every test in the
   module sat at "running for over 60 seconds". It is a `json_group_object` over a `UNION ALL`
   of guarded one-row `SELECT`s instead, which is linear.
   **`json_patch` would also have been linear, and wrong in a quieter way**: it implements RFC
   7386 merge semantics, where a null value *removes* the key — so a field the reader **cleared**
   would be a field the op never mentions, and the far device would keep the old value forever.
3. **`last_insert_rowid()` and `changes()` are unaffected by a trigger's own writes.** The op row
   does not become the answer a caller's `INSERT INTO decks` gets back, which had to be true or
   most of the crate would have broken silently.

**An update carries only the columns that moved — and that now includes parents.** The plan
emitted the whole `parents` object on every update; a note edit carrying the row's current
folder wins last-writer-wins against a concurrent **move** with an earlier stamp, so the move is
silently undone by an edit that had nothing to do with it. That is exactly the failure per-field
LWW exists to prevent, one column type over.

**`decks.default_category_id` is a parent, not a field.** The plan had it as a field, which
means an op carries the *originating device's* category row id — a number that names a row in a
database the far device has never seen and cannot be translated into anything. It travels as the
category's uid now, with `Absent::Zero` so the `0` that means Auto survives as a `0` rather than
failing a `NOT NULL` column. It is also the one **soft** parent: `decks` and `deck_categories`
name each other, so no order of tables resolves both in one pass, and `apply` settles it after
the batch instead of deferring the deck.

**`muted_tags` carries its own primary key on the field list**, and it is the only table where
that is so. Everywhere else the key is a rowid the far device assigns itself; there it is
`(namespace, tag_id)`, both `NOT NULL`, and an op without them is an op the far device cannot
turn into a row at all.

---

## A write every device derives for itself must not be captured

`reconcile.rs` is the only module in the crate that makes one, and it is not in the plan at all.

`card_migrations` is on the user side and is deliberately **not** synced, so every device applies
Scryfall's id log against its own rows after its own ingest. Captured, both devices would do the
fold **and** then receive the other's — and `fold_into_existing` sums the source row into the
survivor, which is a counter delta. **A counter delta applied twice is a collection that has
grown by itself**, on the one path where two devices are guaranteed to compute the same change
independently.

So `reconcile::apply` runs behind `capture::Suppressed` and `sweep_orphans` behind
`capture::suppressed`. The two devices converge because they compute the same answer, not
because they told each other. The sweep is the same rule read from the other end: whether a
printing is in *this* device's card database is a fact about this device, and two machines that
synced on different days can honestly disagree — each clears its own flag when its own corpus
catches up.

`Suppressed` is a second shape of the same guard, for a **mutable** connection: `suppressed()`
takes `&Connection` and `reconcile::apply` needs `&mut` for its `Transaction`, which the borrow
checker will not let a caller hold at once. It owns the `&mut` and lends it back, and its `Drop`
is the whole point — a sticky `applying` row is a device that silently stops syncing, and it
survives a restart because the row is in the database. **No `Drop` runs through a kill**, and
both shapes write the row as a statement of its own ahead of their work, so
`schema::prepare_database` clears it at every open (`capture::clear_stale_guard`) before the
triggers go in. Until it did, the only thing that cleared one at launch was
`managed_wishlist::settle_all` opening a window per deck — so a database with no deck kept the row,
and captured nothing, across any number of relaunches (measured 2026-09-26, debug).

**`reconcile.rs` is no longer the only such module, and user schema v52 is where it shows most.**
(`managed_wishlist`'s folder is the earlier one: derived per device from the deck's plan and
written inside `capture::suppressed`.) v52 adds three writes, and they land on both sides of the
rule on purpose:

- **`deck_tokens::convert_legacy_picks` is captured, deliberately, although every device derives
  it too** — the rule's one exception that is not a delete. It turns v51's art picks into entries at
  launch on a device in no group, and behind each pull on a device in one (*The seventeenth*,
  above, has the reversion a launch conversion caused there), and an entry derived on one device
  has to reach the peers
  that never derived it, or their edits to it can never apply there — each a sparse update for a
  row that peer cannot place, skipped and recorded since 2026-09-27 and dropped with its sender's
  later ops in the page before that; the rung that did this uncaptured broke a stream in each
  direction. What makes capturing a derived *insert* safe here is the name:
  every device converting one pick announces the same `<pick uid>-<list>`, so the second copy of a
  put merges on the uid instead of adding a row — and there is no counter on the table to double.
  **And the same content**: the finish is the printing's own `default_finish`, read from the
  corpus, so two devices whose corpora hold the printing announce identical rows.
- **`deck_tokens::repair_entry_finishes` runs behind `capture::suppressed`**, at every launch, after
  the conversion, as its net: it moves an entry the conversion could only file at the `nonfoil`
  fallback (this device's corpus lacked the printing), or one whose printing has since stopped
  being sold that way, onto its printing's sole finish — and whether a printing is foil-only is a
  fact of *this* device's corpus. A captured fold
  would arrive on the other device as a second sum — the `card_migrations` failure one table over.
  ⚠️ **And it rewrites in place, never deleting and re-inserting**: `suppressed` also switches off
  the insert trigger's uid mint, so a re-inserted entry would come back nameless and its next
  captured stepper press would put a NULL into `sync_ops.uid NOT NULL` — a write that fails on every
  press from then on. `the_finish_repair_keeps_the_entrys_uid_and_a_later_step_is_captured` holds
  it on a paired fixture. ⚠️ **And it walks in `sync_uid` order**, so where one list holds two wrong
  finishes of one printing the fold keeps the lower uid on every device — `apply`'s `min` rule;
  walked in local row order, two devices could keep the entry under two names.
  `the_finish_repair_folds_two_wrong_finishes_into_the_lower_uid` went red (`u-b` kept) without it.
- **Rule 7's token reconcile is captured, deliberately, although every device derives it too.**
  `deck_tokens::reconcile_in` deletes the zero-copy entries of a token nothing makes any more, and
  makes one with copies `manual` (#671), after card writes and as a `sync::with_write` backstop —
  including after a sync apply. The state write converges for the delete's reason: every device
  that reconciles writes the same word to the same grain. It is captured
  because a **delete** is not a counter: a second copy of it finds nothing and is a no-op, so
  convergence costs one redundant tombstone rather than a doubled sum; and because the deletions
  ride the card write's undo step, and a *captured* restore on this device is only meaningful on
  the other one if the delete it reverses was captured too. The guard that makes capturing it safe
  is `Derivation::unreadable`: a list whose makers cannot all be read deletes nothing, because a
  device synced before its corpus downloads would otherwise derive nothing, delete every entry and
  **push** those deletes to the whole group.

---

## §7.3's rules, and the test that proves each

`sync_engine::merge::fold` is pure. **Every test folds the same ops in both orders through one
`fold_both_ways` helper and asserts the same answer** — two devices fold whatever order their
relay handed over, and a fold that depended on arrival order leaves them holding different rows
while both believe they have converged.

| Rule | Test |
| --- | --- |
| counters carry deltas; two devices each adding one copy end at **+2** | `two_concurrent_additions_of_one_copy_end_at_plus_two`, plus `a_counter_never_resolves_to_the_last_value_seen`, which asserts the specific wrong answer a value-carrying op would give |
| scalar fields are last-writer-wins **per field** | `concurrent_edits_to_different_fields_both_survive` |
| …and on one field, the later stamp wins | `concurrent_edits_to_one_field_take_the_later_stamp`, `a_dead_heat_on_one_field_is_broken_by_the_device_id` |
| row existence is **add-wins** | `a_delete_concurrent_with_an_edit_resurrects_and_is_flagged`, `a_delete_after_every_edit_really_deletes`, `a_counter_change_also_beats_a_concurrent_delete` |
| folder moves are LWW, then cycle-break | `a_parent_move_is_last_writer_wins` here; the cycle half is `apply`'s, because it needs the whole tree |
| `deck_audit` is union/append-only | `an_audit_row_folds_to_itself` |

**`fold` folds a *set*, keyed on the stamp**, which the plan does not have. A stamp is unique per
device by construction — the clock trigger advances after every op, and a five-row `UPDATE` gets
five distinct counters, measured — so two ops sharing one **are the same op**. Counters *sum*, so
an op counted twice adds its delta twice, and a relay that stored a device's retried push twice
(a 500 after the write landed, which is the ordinary shape of a network failure) would otherwise
grow the reader's collection by itself. `sync_peers` covers the same hazard *between* batches;
this covers it *within* one.

**Two of the plan's five mutations are unreachable rather than uncaught**, and both are recorded
in the source: the field guard's `>=` versus `>` and add-wins' `>` versus `>=` both compare
stamps from two *different* devices, and the device id is the last term of the ordering, so the
two stamps can never be equal. What the tests do bite on is the **direction** — reversing the
add-wins comparison, making a delete always win, or dropping the delete arm each turn tests red.

---

## Apply, and the three things the plan's design could not do

`sync_engine::apply` runs a whole batch in one transaction wrapped in `capture::suppressed`, so
nothing it writes is captured back into `sync_ops` — without that guard two devices ping-pong an
op forever. It drops ops at or below `sync_peers[device]`, **and ops this device wrote itself**:
a counter is not idempotent, so one of this device's own `+1`s coming back would be a card
appearing out of nothing, and the relay is not trusted to have filtered it.

Three things it does that the plan's design does not, each found by a test rather than by
reading:

### Add-wins needs this device's own history

Folding only the incoming ops answers the wrong question. Two devices; A deletes a row and B
edits it concurrently; B pulls A's tombstone alone, folds a set of one, and **deletes the row** —
with B's edit gone and nothing anywhere to say so. That is the silent loss §7.3's add-wins rule
exists to prevent, and it happens on the **two-device group**, which is the ordinary one.

So each group is folded **twice**: once over the incoming ops, and once over the incoming ops
plus this device's own `sync_ops` rows for the same row. The combined fold decides whether the
row exists and which side won each field; the incoming fold alone supplies the counter deltas,
because the local ones are already in the row.

**This is why a pushed op is kept rather than deleted.** `client` stamps `pushed_at` and leaves
the row: the op log is also this device's memory of what it did.

What it does *not* cover is a third device: B has no local ops for a row C edited, so A's
tombstone and C's edit only meet if they arrive in one batch. The relay hands them over in
hybrid-logical-clock order, so the common case orders itself; the residual is a sparse edit
arriving after a tombstone, which cannot rebuild the row it edits. It was **deferred** — written
here as "rather than lost", and lost after all, with its sender's later ops in the page, while the
client dropped a deferral. Since 2026-09-27 it is **skipped** as a row this database cannot build:
recorded in the error log, and taking nothing else of its sender's with it. From a newer sender it
is held until this device upgrades, and skipped then if it still cannot be built (*Held while it
can resolve, skipped when it cannot*, below).

### ...and a resurrected row is rebuilt from it

A row this device deleted, which add-wins has just brought back, is described by nothing the
network sent: the incoming op that saved it can be a sparse note edit that mentions no folder at
all. So an **insert** takes its fields and its parents from the combined fold, where an update
takes only what the incoming ops won. Without that, a card jumps out of its binder because
somebody else edited a note.

The first attempt at this was dead code, and the test said so with `left: None, right:
Some("Binder")`. The resolved-parents map **always** holds every key — an op that mentions no
parent resolves to "nobody", which is written in as the absent value — so asking whether the
map has the key is always yes. The condition has to be about the *incoming* fold.

### The cycle-break needs the same

A loop takes **two** moves and each device only ever *receives* one of them — the other is its
own. Reading the incoming batch alone therefore makes each device break the move the *other* one
made: A cuts Inner, B cuts Outer, the tree is different on the two machines and neither can tell.
The test asserting both devices name the same folder failed on its first run with
`left: "Inner", right: "Outer"`. The stamps come from `sync_ops` as well now, selected with
`json_type(parents, '$.parent') IS NOT NULL` — `json_type` and not `json_extract`, because a move
**to the root** is a JSON null and `json_extract` cannot tell that from a key that is not there.

Spec §7.3 says the **later**-moved folder goes to the root, which leaves the *earlier* move
standing — the arrangement more devices have already seen and drawn. Convergence is a separate
requirement and both directions satisfy it; what convergence needs is that both devices consult
the same set of stamps.

⚠️ **A folder can have no `sync_uid`, and the cycle check reads it as optional** (2026-10-01).
The check walks every folder that has a parent, after **every** apply — an empty page included —
and until then it read the uid as a `String`. One nameless child therefore failed the whole
batch with `Invalid column type Null at index: 2, name: sync_uid`, on every pull, for as long as
the row stood: the device went on pushing and never read again. The row is not an accident. A
theory deck's managed wishlist writes its folders behind `capture::suppressed`, where the insert
trigger's mint does not run, and they are nameless **on purpose** — the baseline's
`WHERE sync_uid IS NOT NULL` is what keeps a folder every device derives for itself from being
announced. User schema v55's **Tokens** subfolder was the first of them to have a parent, so
this reached every paired device whose managed wishlist held a token. A nameless folder stays in
the walk, because a loop can run through one, and it has no move on record, so the cut never
prefers it. **A read over a whole synced table may not assume a uid; a statement addressed by
uid cannot reach a nameless row at all, which is why nothing else in `apply` met one.**

### A resurrection is an event, not a state

`combined.resurrected` stays true for as long as the tombstone sits in this device's own op log
— which is forever, because the log is not pruned. Flagging on that alone re-writes the
sentence on every later batch, so **"Looks fine" clears it and the next pull puts it straight
back**: the reader can never put it away on the device that did the delete.

So the flag is written when *this* batch is the one that resurrected the row: either it carried
the tombstone, or the row was not here and had to be rebuilt. `ApplyReport::resurrected` counts
the same way. The test that found it clears the sentence on one device and applies on the other,
and the sentence was there again.

### The clock must observe what it applied

Without it, an edit made *after* seeing a peer's op can carry a stamp that sorts *before* it, and
last-writer-wins is decided by whose clock ran faster. `apply` ends by pulling `sync_clock` past
the batch's latest stamp — `hlc::Hlc::observe` spelled in SQL.

### A held op holds the watermark

`sync_peers` is a *watermark*: everything at or below it has been applied or given up on. So an
op that may still apply cannot be counted and stepped over — advancing past it loses it for good,
and not advancing replays the ops above it and **adds their counter deltas a second time**. Both
are silent.

**The whole of that device's stream stops at the block**, and that is stronger than it first
looks: the ops after it in the same page are not applied either, even when nothing about them is
unresolvable. It has to be. Applying them while holding the watermark below means a re-delivery
applies them again — measured before the fix, one `+1` behind a blocked op became a quantity of 2
on the second delivery of the same page.

So a batch that holds anything is applied **twice**: once to find out which devices stall, then
rolled back and applied again with the stalls known. The loop runs until no new device is found
blocked, which is at most once per device and in practice once. **Only a held group blocks** since
2026-09-27: a group skipped or made moot is consumed in whichever round finds it, and the
watermark passes it.

**The round cap is where the two halves could part.** The loop stops at `min(groups, 8)` rounds,
and at the cap the pass that commits has applied ops above blocks it found only in that round. The
watermarks used to be advanced by those found blocks, which sat under ops the pass had just
applied, so the next delivery of the page applied them again. They are advanced now from what the
committed pass did — each device to the last op it wrote or consumed, every held group left out —
and `the_round_cap_advances_watermarks_by_the_committed_passes_blocks` goes red on either the
old rule ("a re-delivery added h's +1 a second time") or on a stamp filter that steps past a held
op. ⚠️ **What the cap still costs**: a device first found held in the cap round, whose later op
that round already applied, is advanced past its held op, because re-applying the later one would
double it. It needs a batch whose blocks keep cascading past `min(groups, 8)` rounds.

**That was designed as a stall** — visible in `ApplyReport::deferred`, self-healing when the
missing parent arrived, and permanent only for a block that never becomes appliable, on the
argument that holding is the one choice of three that neither loses an op nor doubles a counter.
⚠️ **The watermark is only half of a hold, and until 2026-09-27 the client did not supply the
other half**, so what a deferral did was lose the op. It supplies it now, for the deferrals that
can still resolve and for no others — *Held while it can resolve, skipped when it cannot*, after
the next section. **A claim is the one op this section no longer governs**: a baseline op that
names its emission is never judged by a watermark and never moves one — the next section.

### A claim names its emission

**Built 2026-10-03** ([the claim emissions design](../superpowers/specs/2026-10-03-baseline-claim-emissions-design.md),
executed by [its plan](../superpowers/plans/2026-10-03-baseline-claim-emissions.md)), on `main`, in
place of a narrower fix that went eight rounds and never merged — *Why no receiver-side rule could
trust a claim*, at this section's end. A baseline op is a **claim**: a row as its emitter held it,
stamped from the row's `updated_at` in whole wall-clock seconds with a running index as the counter
(`baseline::build`), and emitted in table order. Until then `apply_in` **judged** a claim by
`sync_peers` like any op (`seen`) and let it **raise** the watermark (`advance_watermarks`) — the
section above, applied to something that is not a place in a stream — so a claim could be skipped
as seen by a device that had never held its row. And a claim is the baseline design's §8.2 floor,
`max(local + Σ deltas, claim)`, so on a row the receiver already holds it could neither carry a
decrement nor sit beside a concurrent delta. **A claim now carries its own idempotence**, and the
watermark neither judges it nor moves for it.

Measured before any of it was built — debug, Windows, 2026-10-03, as throwaway probes on the
narrow fix's `623f0ccc` over `main` at `dfce2194` and in that fix's own rounds. Each row is a test
in `apply/emission_tests.rs` now:

| Probe | Emitter / peer, then | Now | Test |
| --- | --- | --- | --- |
| A baseline pulled in two halves — the doorbell rings on the first chunk | 3 / **1** row | 3 / 3 | `a_baseline_pulled_in_two_halves_reaches_a_device_that_held_nothing` |
| A sparse op pulled ahead of its baseline — a row held before pairing has no insert on the log | 5 / **0** | 5 / 5 | `a_sparse_op_pulled_ahead_of_its_baseline_does_not_cost_the_row` |
| A re-broadcast, the peer having removed a copy meanwhile — the emitter's row stamped *now* by applying the peer's earlier op | 1 / **2** | 1 / 1 | `a_rebroadcast_takes_back_nothing_this_device_did_since` |
| A re-broadcast built before a third device's **delete** the peer had applied | 0 / **1 row** | 0 / 0 where the emitter's generation was taken; **1 row** where it was not — *What is still owed* | the same |
| A re-broadcast built before a third device's **note** the peer had applied | `c` / **`-`** | `c` / `c` | the same |
| Leave, edit while unpaired, re-pair — and the same with the leaver's clock an hour fast | 4 / 4, and 4 / **2** | 4 / 4 both ways | `a_device_back_from_time_out_of_a_group_brings_what_it_did_there` |
| **The tombstone face** — the claim's wall-clock stamp `(…000, 1)` loses to the peer's own delete `(…400, 3)`, where the edit it carries `(…3600400, 1)` wins add-wins | 3 / **0** | 3 / 3 | `a_claim_does_not_lose_the_add_wins_its_own_edit_would_win` |
| `-1` sent with a re-baseline to a device that holds the row — the same second, or a fresh claim | 2 / **3** | 2 / 2 | `a_removal_sent_with_a_rebaseline_reaches_a_device_that_holds_the_row` |
| `+1` there and `+1` here | 4 / **3** | 4 / 4 | `a_copy_added_on_each_side_is_two_copies` |
| A note written there after it had heard this device's, the clock fast | `theirs` / **`mine`** | `theirs` / `theirs` | `a_note_written_there_after_it_heard_this_devices_wins_here_too` |
| An edit whose claim is in a later chunk, pulled alone | the edit **lost** | lands at once | `an_edit_whose_claim_is_in_a_later_chunk_lands_at_once` |
| A held put released after a claim that contains it — the narrow fix's third review | 3 / **6** under its op path | 3 / 3 | `a_held_back_put_and_a_claim_that_contains_it_count_it_once`; the client's `a_clock_held_senders_put_holds_the_claim_for_its_row` |

Every bold cell was permanent divergence with nothing in `error_log`. Two more shapes were read off
the code and are closed by the same rules — a first-contact parent skipped as seen, so its child
waited out the hold's bound (`a_first_contact_parent_below_the_watermark_lands_with_its_child`), and
a later chunk whose claim fell below a watermark a fast-clock edit had lifted
(`a_later_chunk_lands_after_an_edit_from_a_fast_clock`) — and so is the bug that started it, a
re-baseline's `+1` made in the second the peer last heard from
(`a_rebaseline_carries_an_edit_made_in_the_second_the_peer_last_heard_from`). **Re-broadcasts are
not rare**: every pairing clears every device's `baselined_at`, so every device re-emits to every
peer at every pairing event.

#### The wire: a reference on every claim

`merge::Op` gained one optional field, `emission` (`merge::Emission`), which a baseline op carries
and nothing else does:

| Key | On | Holds |
| --- | --- | --- |
| `id` | every claim | the emission's name: one tick of the emitter's `sync_clock`, minted by `emission::begin` in the stretch that reads the rows — unique per device, and ordering its emissions |
| `i` | every claim | the claim's index in the emission, from 0 |
| `n` | `chunk[0]` of every chunk | how many ops the emission sends |
| `since` | `chunk[0]` of every chunk | the emitter's generation |
| `resumed` | `chunk[0]` of every chunk, only when true | that generation began after the emitter had logged in a group before |

The head rides where the horizon rides, for the horizon's reason: each chunk is its own relay row
and is pulled on its own. **`Op.emission` itself is `#[serde(default, skip_serializing_if =
"Option::is_none")]`**, and that is what makes an ordinary op serialise byte for byte as it did; an
older receiver ignores the field, because nothing on the wire is `deny_unknown_fields`. Inside it,
`id` and `i` are always written, and the head's three keys are skipped when absent — `n` and
`since` when `None`, `resumed` when false — so only `chunk[0]` carries them. A claim's `at` keeps
its meaning — the `updated_at` stamp — for last-writer-wins, the envelope, the clock hold and
`rebase`, and for nothing else. **Only a claim may carry one**: `claims::decide` strips a reference
off an ordinary op at the door, so a malformed or hostile peer cannot get a put judged as a claim
(`an_ordinary_op_that_names_an_emission_is_judged_as_one_with_no_reference`). **A row too large
ever to send is left out before the ops are numbered** — `emit_baselines` probes each one as a
chunk of one, with the horizon and a worst-case head on — so `n` counts what is sent, and an index
that never arrives cannot keep the emission from being taken
(`a_baseline_row_too_large_to_send_is_left_out_and_the_marker_still_set`).

**What it costs, measured 2026-10-03, debug, Windows.** `wire`'s
`a_full_batch_of_claims_with_references_is_far_below_the_cap` printed **205 398 B** as a stored row
for 200 claims with references, against **189 499 B** for 200 ordinary ops on the same run
(`a_full_batch_is_far_below_the_two_megabyte_row_cap`). A reference is **about 44 B of plaintext**
a claim — the design first guessed 30 — and the head about 40 more; sealed and base64'd, the
references come to **about 11.6 KB a chunk**, and the other ~4.3 KB of the difference is
`"baseline":true`, which every claim carried before. All of it is far under the 2 MB row cap,
`MAX_SEALED_CHARS` and `wire::BATCH_BYTES`, and the chunk cut is measured with the references on.

#### The generation: when a device last began logging

**A device's generation is the `sync_clock` stamp at which its capture last turned on** —
`sync_state`'s `logging_since`, with `logging_resumed` beside it. Capture records nothing while a
device is in no group, so a device that has been out of one holds history no log carries.
`identity::found_group` mints one, and `join_group` mints one only when `sync_group` was empty
before it: `pairing::confirm` re-writes the initiator's own group on every pairing, its capture
never stopped, and minting there would make every pairing look like a device with unlogged history
(`founding_and_joining_from_no_group_mint_a_generation`,
`re_writing_the_group_it_is_in_opens_no_gap_and_mints_nothing`). **A generation resumes when one
was held before**: `leave_group` keeps `logging_since` for exactly this, and writes `0:0` for a
device that logged before this build and has none (`emission::keep_logging_mark`) — **and a
`sync_peers` row counts as one too**, ruled while it was built (below). A device's first generation
does not resume: its pre-pairing rows carry uids no peer holds, so they reach every peer through
the arms for a row not held, never through a row held there. A device that has never minted one
sends `since: 0` and no `resumed` — "the logging that began before this build".

#### Consumed once, decided with its row, and never seen by the watermark

A claim that names its emission is decided in `apply::claims` — `decide` before the page is
grouped, `settle` after the committed pass — and nothing there reads or writes `sync_peers`. It is:

- **never judged by `seen`, never counted by `advance_watermarks`, never a device block** in
  `blocks_of`, and never collateral by stamp in `held_by`. That alone closes the two halves, the
  sparse op ahead, the first-contact parent and the fast-clock chunk
  (`a_claim_never_moves_its_emitters_watermark`,
  `a_claim_above_its_emitters_held_op_is_not_held_with_it`).
- **consumed once.** `sync_state`'s `emission@<device id>` holds the emitter's records, newest
  first: each emission's `id`, `n`, `since`, `resumed`, and two sets of index ranges — **wrote**
  (the claim built, merged or floored its row) and **passed** (consumed and wrote nothing: a held
  row's claim, a moot one, one dropped and recorded). A claim whose index is in either set is
  skipped as seen. Four records an emitter (`emission::RECORDS_PER_EMITTER`), and **past four a
  record whose claims wrote nothing goes first**, oldest first — `wrote` is the only evidence that
  a put a claim carried is inside a row here (`the_ledger_evicts_a_record_that_wrote_nothing_first`).
  The record being stored ranks with the ones that wrote whatever it holds, because it is an
  emission's progress, so it is never cut for having written nothing yet; **but it is not exempt**:
  `emission::bound` orders those by age like the rest, so an older in-flight record stored while
  four newer records that wrote are held is evicted the moment it is stored.
- **decided with its row.** A group is one row and holds as a whole (`held_by` asks every op in
  it), so a claim beside a put that is held is held with it, unconsumed, and comes back with it.
  The claim itself blocks nothing (`a_claim_held_mid_emission_lands_once_and_holds_nothing_else`).
- **taken** when every index of one emission is consumed: `taken@<device id>` becomes its `since`,
  and every *other* record of that emitter at or below it goes — **but one of the same generation
  whose claims wrote a row, which stays for containment alone** (the final review's, below). A
  newer emission completing supersedes an older one left half-sent; it does not erase what that
  one's claims built.

Two kinds of claim have their reference stripped and are left to `main`'s rules (a third, an
emission named before the upgrade cut, is below): this device's own emission,
handed back by the relay with the rest of the log, which `main` drops as its own — registering it
wrote an empty `emission@<me>` on every pull that echoed one
(`this_devices_own_emission_handed_back_writes_nothing_and_leaves_no_mark`) — and a claim whose
chunk head is not in the page (`a_claim_whose_head_is_missing_is_judged_as_one_with_no_reference`).

#### Active or inert, and what an active claim does to its row

**Decided per emission, once, at the start of `apply_in`**, from the emitter's `taken@` as it stood
before the page and the `since` the emission's head carries — per emission and not per emitter,
because one page can hold an emission from before an emitter's rejoin and one from after it
(`an_emission_from_before_a_rejoin_is_inert_beside_one_from_after_it`):

| The emitter's generation, as this device holds it | The emission is |
| --- | --- |
| no `taken@` mark, or `since` above it | **active** |
| `since` at or below the mark | **inert**: every claim skipped as seen with no database work, its horizon left out of the page's union so it drops no put, its indices not tracked — except that any record of it the ledger still holds, complete or not, still serves containment: the completed one `take` kept, or a half-sent one it superseded whose claims wrote |

**Inert is the baseline design's cheap exit with its premise checked**: a taken generation means
this device consumed one whole emission of it and has read every op the emitter logged since, and
a gap clears the mark the moment that stops being true
(`a_taken_generations_rebroadcast_writes_nothing`). The exit it replaces asked the same question of
a wall-clock second against a hybrid-clock stream.

An active claim, and the covered puts beside it, by the row — asked in this order:

| The claim's row on this device | A covered put of that row, not seen | The claim |
| --- | --- | --- |
| **merged here into another row, in either direction** (`retired@<table>/<uid>`) — whether or not a row wears the uid again | **op path** — `main`'s rules | **passed — never builds, never floors** |
| **here, under the claim's uid** | **op path**: applied as the delta it is, at its own stamp | **passed — writes nothing**, unless the emission `resumed` or this device has a `gap`, when it is the floor over the op path |
| not here under its uid, and **this device's own `sync_ops` names it** — it held the row and deleted it | **op path** — the tombstone face | **builds**: `max(Σ deltas, claim)`, existence decided by add-wins at the puts' own stamps |
| not here under its uid, **a grain twin under another** | **dropped**: the claim carries it, and the two rows are independent — `max`, never a sum | **merges** by `max`, adopting `min(uid)` |
| **not here at all**, never held | **dropped**: the claim carries it | **builds** — §8.2's accepted under-count, unchanged |

**Why the held-row arm writes nothing.** A row held here under the claim's uid came through the
log, and the log brings everything that happened to it: every covered put in the page takes the op
path, and every put before the page has already been applied. A floor could only take back what
happened here since — the re-broadcast row above — or count a held put twice — the 6-for-3. The two
exceptions are exactly the two ways a held row can be missing history no log carries: the emitter
**resumed** after time out of a group, when its unlogged edits are in the claim and nowhere else;
and this device has a **gap**, when ops it never applied are. There the floor is the only road, and
§8.2's direction — never invent a card, accept an under-count — is the rule.

**Containment, across every row**: a covered put is skipped when the page carries its row's claim,
from an emission whose horizon covers it, that has already *written* the row — a re-delivery of a
page whose claim built, merged or floored the row the first time
(`a_whole_active_page_handed_back_writes_nothing_the_second_time`). The evidence is the page and the
record, per row, where the narrow fix kept a device-wide absorbed mark. **And a covered put an older
claim in the same page carries is left to `main`'s rules** — where the horizon of an op with no
reference, or one stripped at the door, covers it, `inside` drops it as it always did, before the
op path is asked. `claims::decide` builds that union once (`Decided::older`) and `apply_in` judges
`inside` against the same one.

#### A gap: what clears the taken marks, and what closes it

A taken generation promises this device has read everything since. Anything that breaks the promise
calls `emission::open_gap`, which **clears every `taken@` mark and every record's `passed` set,
keeps every record's `wrote` set, marks each record `before_gap`, and sets `sync_state`'s `gap`**:

| The gap | Where it is opened |
| --- | --- |
| This device's place in a log is forgotten — leaving, founding, joining a different group | `identity::forget_log_position`, beside the cursor it already deletes (`forgetting_a_place_in_a_log_opens_the_gap`) |
| An envelope stepped over as unreadable — altered, malformed, an epoch whose key a removal forgot | `client::pull`, after the page's first `apply_page` (`an_envelope_stepped_over_as_unreadable_opens_the_gap`) |
| A group dropped and recorded, or released at the waiting bound | `claims::settle`, after the committed pass writes its `taken@` marks, so a pass that drops a claim leaves its emitter untaken even when the drop was that emission's last index (`a_dropped_group_opens_the_gap_and_the_next_emission_floors`) |

**An envelope held rather than stepped over opens none** — one behind a rotation, or a batch only a
newer build can read (`an_envelope_held_behind_a_rotation_opens_no_gap`,
`a_batch_only_a_newer_build_can_read_opens_no_gap`): a wrong gap clears every mark and floors held
rows for nothing. ⚠️ **And a new place a gap can come from owes the same call.** A source that
skips it leaves `taken@` marks promising a log read whole, and every claim that could have repaired
what the gap cost is inert.

While the gap is open an active claim floors a row held here. **It closes when every device on this
group's roster that this one holds a watermark for has a `taken@` mark again**
(`close_gap_if_whole`, after every settle that drops nothing) — and a record from before the gap is
never taken, so it closes only on emissions recorded after it. The roster and not `sync_peers`
alone, because a watermark outlives its group (*A cursor is a place in one group's log*): a device
that moved groups holds watermarks for peers that will never emit to it again. A peer whose ops are
dropped on every page keeps the gap open and every emission flooring — the narrow fix's behaviour,
never below it. The `pull` gap opens after `apply_page`, so an emission completed in the same page
is not called taken, and its held-row claims pass rather than floor: the conservative order.

#### What an emitter's horizon carries

A horizon says how far each device's ops are already inside the emitter's rows, and those rows also
hold what came in through claims, which never raised `sync_peers`. So the emitter keeps
`carried@<device id>`, raised to an emission's horizon entry for every device it names **when that
emission is taken and every one of its claims wrote its row**, and `baseline::horizon` reports
`max(sync_peers, carried)`. **Over-covering is the dangerous direction**: a horizon naming a put
some row of the emitter lacks makes a receiver drop that put for a row it builds from the claim, and
the put is lost. So a partial emission raises nothing, and nor does a whole one with any claim
passed — a row held there holds what its log brought, no more
(`an_emission_whose_claims_passed_on_held_rows_carries_nothing`) — nor one from before a gap, which
is never taken. Under-covering costs a put taking the op path beside a claim that `max` already
absorbs. What it closes is a grain twin meeting a third device's put the emitter carried in through
a claim (`a_grain_twin_and_a_put_carried_through_a_claim_end_at_the_max_everywhere`) — and, with the
held-row arm, the narrow fix's review-7 double count: four devices, 4 on every one
(`a_put_one_emitter_took_in_through_anothers_claim_counts_once_everywhere`).

#### `update_row` stops stamping a row nothing changed

It wrote `updated_at = unixepoch()` whenever the table has timestamps, even when no column won and
no counter moved. A claim that changed nothing then stamped the row *now*, and this device's next
baseline claimed it at *now* — beating genuinely newer edits made elsewhere in between, which is the
baseline design §10.2's own argument against stamping a claim with "now". And the bump was read:
the deck gallery sorts by `decks.updated_at DESC` and the to-do widget's *Last edited* by
`deck_todo_lists.updated_at`, so a claim that changed nothing moved a deck to the top of the gallery
on the device that applied it, and the `UPDATE` was a row write the update hook reports, refreshing
the mirror and every other window for nothing. **Nothing changed, nothing written** now
(`a_claim_that_changes_nothing_leaves_updated_at_alone`,
`an_op_whose_every_field_lost_leaves_updated_at_alone`,
`a_deck_a_claim_changed_nothing_on_keeps_its_place_in_the_gallery`), and a write that changes
something still moves it (`an_apply_that_changes_a_row_still_moves_its_updated_at`).

#### Ruled while it was built

The plan ran a task at a time with a fresh review after each, and these are the rulings that moved
the design while it ran — each now in the spec, the code and a test:

- **A completed emission's own record is kept when it is taken**, taking one of the four slots.
  A page handed back after the emission completed still carries the covered puts its claims carried;
  the first delivery dropped them and no watermark rose, so that record's `wrote` set is the only
  evidence they are inside rows here. Without it the inert emission dropped nothing and those puts
  went down the op path: §8.1's first pairing applied twice read 10 for 5, and a whole page handed
  back applied 2 for 0 (`the_first_pairing_twice_and_the_never_held_undercount_keep_their_answers`,
  `a_whole_active_page_handed_back_writes_nothing_the_second_time`).
- **A gap keeps what claims wrote.** The design first cleared every `emission@` record at a gap,
  and a page handed back across one then read its emission as new: the claim floored the row it had
  built and the carried puts took the op path beside it, `max(5 + 1 + 4, 5)`, 10. A page comes back
  that way whenever it carries an outbox, a whole emission, a dropped group and a held group — the
  drop opens the gap and the hold hands the page back — and on any full re-read after
  `forget_log_position`. A written claim stays consumed, because flooring it again could only take
  back what this device has done to its row since; a passed claim wrote nothing and is decided
  again, which on a held row now means the floor
  (`a_page_handed_back_across_a_gap_counts_what_its_claim_carried_once`,
  `a_claim_passed_before_a_gap_floors_after_it_and_takes_nothing`).
- **A held claim is a block of its own in `apply::Held`**, keyed
  `<emitter>#<id ms>.<id ctr>#<index>` at the claim's own stamp. A hold made of claims alone used to
  answer an empty `Held`, so the client's same-blocks test passed vacuously and a new held claim
  could be released on an old wait; now a new held claim restarts the waiting bound and a resolved
  one drops out. A device id is 32 hex and never holds a `#`, so no key meets a device's and
  `client::pull`'s per-device merge never touches one
  (`a_claim_held_alone_is_a_block_of_its_own_in_what_apply_answers`).
- **A held-back op is stripped of any reference before it is grouped.** On an ordinary op a
  reference is malformed, and with one left on, `held_by`, `blocks_of` and `advance_watermarks` —
  each of which passes over an op carrying the field — let its group be written with no watermark
  rising, and a later release applied it a second time
  (`a_held_back_op_with_a_stray_reference_holds_the_claim_for_its_row`, and
  `a_held_back_op_with_a_stray_reference_is_not_applied_and_applies_once_when_released` on a row
  with no claim). A held-back *claim* joins nothing: a claim blocks nothing, and a put that lands
  ahead of the claim containing it is the row table's ordinary case.
- **A claim never builds a uid this device merged into another, in either direction**, and the
  write path asks again. `apply` merges one uid into another in two places — a grain match
  (`adopt_uid`) that renames the row it finds, or keeps its own lower uid and **absorbs** the
  incoming one; and a folder delete's re-homing (`rehome`) folding a row onto its root twin — and
  each records `retired@<table>/<uid>` for the uid that went, naming the survivor, inside the
  savepoint of the write that merged it. The retired uid's copies live in the survivor, so building
  it again counts them twice, and without the mark nothing told it from a row never held: measured
  on the narrow fix's renamed-row scenario, **6 on `b` against `a`'s 4**, and with the twin's uid
  sorting higher, **5 against 4**. No gap clears the mark — it is a fact about this device's rows,
  not about a log. `decide` reads it before the page, so a merge *earlier in the same page* wrote it
  too late; with a gap open the claim went to the fold as a floor, found no row by grain or uid, and
  built the merged-away uid — 6 against 4 again. So the write path asks the mark itself, at the
  moment a group carrying a claim would build: the group is refused as `Why::Unbuildable`
  (`MERGED_AWAY`) and read by `classify` like any other: dropped and recorded where no op of the
  group was sealed by a newer schema — the claim passed and the gap opened — and held as newer
  where one was. A newer hold keeps the cursor, so that page comes back on the next pull, where
  `decide` finds the mark the merge wrote and passes the claim; only the newer op waits for this
  device to upgrade (`a_later_emission_never_builds_a_row_a_grain_rename_merged_away`,
  `a_later_claim_never_builds_a_uid_this_device_absorbed`,
  `a_claim_floored_on_a_row_merged_away_in_the_same_page_builds_nothing`,
  `a_retired_uid_a_row_wears_again_is_still_passed_under_a_gap`,
  `a_later_emission_never_builds_a_root_copy_a_folder_delete_folded_away`). What it costs is in
  *What is still owed*.
- **A `sync_peers` row means a generation was held before.** A device that left or was removed
  under an older build never had `keep_logging_mark` write its `0:0`, so `logging_since` alone
  called its return a first generation, and the edits it made while in no group would be passed on
  its peers rather than floored. A watermark is a peer this device applied ops from, which only a
  device that held a group has, and leaving keeps every one, so `emission::start_logging` counts any
  row (`a_device_that_held_a_group_before_this_build_rejoins_resumed`). A fresh install has none.
- **No baseline is begun while anything at all is pending** (`emit_baselines`), not only what was
  written since the trip read its outbox — the rule *A trip holds nothing across a request* records
  below, widened. A pending op is inside the emission's rows and its horizon but not on the relay's
  log, so it arrives a page after the claims with no horizon beside it, and a row a claim has just
  built counts it a second time — whatever left it pending: a write behind the outbox read, a
  conversion behind the pull, or an earlier refusal
  (`a_baseline_waits_while_an_earlier_refusal_left_an_op_pending`). ⚠️ **What it costs is a
  `too_large` the relay keeps refusing**: the batch is one this device measured as fitting, so it is
  offered and refused on every trip, its ops stay pending for good, and no baseline goes out behind
  them — where before one went out over them (`Deferral::TooLarge`). With it,
  `a_push_the_relay_keeps_refusing_still_lets_the_trip_pull_and_ack` changed: none of the four
  deferrals begins a baseline now, and each posts once.
- **The client passes what it holds back into `apply::apply_page`, as held.** A batch from a sender
  held for its clock, or behind one only a newer build can read, used to be taken out of the page —
  and a third device's claim that contained one of its puts landed first; released, the put counted
  again (the 6-for-3). Now each such batch enters `apply` with its ops marked held, so they hold
  the groups of their rows that carry a claim (narrowed by the final review, below), and **each
  opened batch goes to exactly one of the two lists** — an op passed as both is grouped twice. The
  client counts them itself (`report.deferred`, and `held_newer` for a batch behind a newer one), so
  no class of `apply`'s report counts one, whatever its group becomes — a group held as newer used
  to count it a second time (`a_held_back_op_in_a_group_held_as_newer_is_counted_in_no_class`). The
  cursor decision is unchanged: a non-empty `held_back` already holds the page as `"clock"` or
  `"newer"`.

**The final review**, over the whole branch, found two over-counts and a stall, each reproduced red
before it was fixed (2026-10-03, debug, Windows):

- **A half-sent emission superseded while its page is held counted its carried put twice — 4 where
  2 is right.** `a`'s first emission is pulled a chunk at a time, and `b`'s first page carries
  `a`'s outbox beside the chunk for bolt: the claim builds bolt and `a`'s insert is dropped as
  carried by it. `a`'s whole second emission comes in the same page, handed back twice; it completes
  on the first, and `take` dropped every other record of the generation, the half-sent one's with
  it. Its `wrote` set was the only evidence the insert is inside bolt, and the second emission's
  claim for bolt passed on the row now held here, so the second hand-back sent the insert to the
  older rules unseen. Reachable through a quota refusal mid-baseline beside a held page, or a full
  re-read after a rejoin. **Fixed**: `take` keeps a same-generation record whose claims wrote, for
  containment alone; the inert branch of `decide` reads any record it finds, complete or not; and
  the bound evicts a record that wrote nothing first
  (`a_half_sent_emission_superseded_while_its_page_is_held_counts_its_carried_put_once`,
  `taking_an_emission_keeps_a_record_of_its_generation_whose_claims_wrote`). Each of the two code
  halves, reverted alone, reads 4 again.
- **A put an older baseline in the same page already carried was counted again beside a newer
  emission — 4 where `main` answers 2**, a regression against `main`. An older build's baseline of
  `a`'s — no references, as an older emitter sends one, or stripped at the cut — comes beside the
  insert its horizon covers, and `inside` drops it: the claim builds bolt at 2. The page comes back
  with `e`'s emission, which covers the insert too and whose claim for bolt passes on the held row,
  and `decide` sent the insert down the op path, which bypasses `inside`. **Fixed**: `decide` builds
  the older rules' horizon union itself, and a covered put it covers is left to those rules before
  the op path is asked
  (`a_put_an_older_emitters_claim_carried_is_not_counted_again_beside_a_newer_emission`).
- **A held-back op stalled other senders' ordinary ops.** It joined every group of its row, so
  another sender's ordinary op there held with it, and that sender's later ops as collateral, for as
  long as the client held the first — up to a day on a clock hold, and until an upgrade behind a
  newer build's batch — against the rule that an op with no reference keeps `main`'s rules.
  **Fixed**: a held-back op joins only a group that carries a claim, which is all the 6-for-3 needs,
  and anywhere else joins nothing and holds nothing
  (`a_held_back_op_on_a_row_with_no_claim_holds_no_other_senders_op`; the 6-for-3's own two tests
  stay green). An ordinary op that shares a group with a claim and a held-back op still waits with
  them.

#### Older builds, and the upgrade cut

| Pair | What happens |
| --- | --- |
| this emitter → an older receiver | the `emission` field is ignored; claims are judged by `at` as they always were, with every loss above |
| an older emitter → this receiver | no `emission` field: `main`'s rules, unchanged — judged by the watermark on `at`, a covered put dropped as inside. The original same-second `+1` stays lost for this pair alone |
| both on this build | everything above |

A mixed group is never worse than it was, and the gains are between upgraded devices. No rung: every
mark is a `sync_state` key — `logging_since`, `logging_resumed`, `emission@`, `taken@`, `retired@`,
`gap`, `carried@` and `emissions_since`.

**The upgrade cut.** An older build of *this* device may already have applied an emission that
carries references — a newer emitter's, in a page its cursor then held across the upgrade. It
ignored the references, applied the claims by the old rules, dropped the covered puts as inside,
and recorded nothing; handed that page again, this build would find no record, read the claims as
active and send those puts down the op path into rows the old build had already built from the
claims — **5 where 2 is right**, the narrow fix's own measurement of the same boundary. So the first
apply under this build on a database holding any `sync_peers` row stores `emissions_since` — the
later of the wall clock and `sync_clock`, plus `hlc::MAX_AHEAD_MS` — and an emission whose `id` is
at or below it has its reference stripped at the door and is judged exactly as an older build judged
it (`a_page_an_older_build_applied_writes_nothing_again_after_the_upgrade`). A database with no
`sync_peers` row, which no older build has synced, gets a cut of zero
(`the_upgrade_cut_is_minted_once`). **What it costs is a day**: for up to `MAX_AHEAD_MS` after a
device first applies under this build, a re-baseline it receives from an upgraded emitter behaves
as before.

#### Why no receiver-side rule could trust a claim

**Found 2026-10-02 and fought for eight rounds** — one experiment and seven reviews — on
`fix/sync-baseline-claim-skipped-as-seen`, a local branch whose head, **`597d19d6`**, holds the code
and its own record through the sixth review; the seventh review came after that commit, and its
finding is recorded in the claim emissions design's §1. The branch never merged. This design took
its scenarios — ported into `apply/emission_tests.rs`, each under a doc line that begins
`` `597d19d6`: ``, with that fix's end states kept and its own mechanism's assertions dropped — and
none of its code.

`apply_in` dropped an op as `seen` — at or below its sender's watermark — or as `inside` — an
ordinary put at or below the page's baseline horizon, on the promise that its row's claim carried
it. `inside` exempted baseline ops; `seen` did not. A claim is stamped off the **wall** clock in
whole seconds and a watermark off a hybrid clock that is never behind the wall clock and can run
hours ahead of it, so a claim routinely sat below the very edit it carried: a peer handed both in
one page skipped the edit as inside and the claim as seen, neither landed, the cursor passed both,
and `error_log` said nothing. The peer's count after one page, against the emitter's:

| The edit | Emitter | Peer |
| --- | --- | --- |
| `+1` in the wall-clock second of the last op the peer applied | 3 | **2** |
| `+1` ten seconds after it | 3 | 3 |
| `+1` ten minutes after it, the emitter's clock an hour fast | 2 | **1** |
| `+1` by a third device on a row the peer holds, the emitter having applied it | 3 | **2** |

The narrow fix's rule (`apply::Owed::relies_on`, `apply::floor`) took a claim out of the skip only
where raising its row could not put back a copy something had taken away, and floored that row's
counters to it before the page's groups — with an `absorbed@<device id>` mark, so a claim taken out
of the skip was taken out once, and an `absorbed_since` cut for what an older build had taken in.

**Round one** ran six candidates against one scenario matrix, in a harness switched per test
thread. Three were out at once: *no claim judged by the watermark* applied every claim again on
every delivery, took back a removed copy and overwrote a later field edit; *keeping the put when its
claim was skipped* counted it twice on a page handed back, 6 for 3; and *stamping a claim no lower
than its emitter's latest op on the row* turned three of the baseline design's own stamp tests red
and still lost a third device's op. **Round two**, after the first review found the walk-mark draft
re-applying claims and the floor unable to carry a decrement:

| | the base | walk mark | horizon mark | horizon mark + op path |
| --- | --- | --- | --- | --- |
| `+1`, same second / clock an hour fast | lost | ✓ | ✓ | ✓ |
| `-1`, same second / claim fresh | lost | lost | lost | ✓ |
| `+1` there and `+1` here | 3 for 4 | 3 | 3 | ✓ |
| a note written there later, its clock fast | lost | lost | lost | ✓ |
| a put on a row the emitter deleted, the page handed back over a removed copy | ✓ | **3 for 2** | ✓ | ✓ |
| a claim landed a page before its put, over a removed copy | ✓ | **2 for 1** | ✓ | ✓ |
| §8.1's first pairing twice; §8.2's under-count for a row never held | ✓ | ✓ | ✓ | ✓ |
| a baseline pulled in two halves; a sparse op ahead of its baseline | lost | lost | lost | lost |

Every later review took something away, each time because something the base had skipped now ran:

- **The op path** — a covered put on a row held here, applied as an ordinary op — fixed the
  decrement and the concurrent add. The second and third reviews found it counting a put twice:
  its applied edit raised the watermark above a later chunk's claims, and then, with three devices
  and a sender held back at the receiver's client, a third device's claim landed first under a
  horizon that did not name the put — **6 for 3**. Dropped, by Markus, on 2026-10-03.
- **A claim let through for any owed put on its row** went through again on every page handed back
  when the put's own emitter landed nothing, and **one let through onto a row this device lacked**
  built back rows a delete had taken, by three routes the fourth review traced. Narrowed to the
  claim's own chunk, and a row held here.
- **A claim let through the fold** met everything the base had never shown it. The fifth review
  traced an earlier group's grain match renaming its row so that the claim, finding neither grain
  nor uid, inserted a second row — **5 copies where every other device held 3** — and a wall-clock
  stamp, folded beside a delete in the same page, outliving the delete. Narrowed to a floor on
  counts alone.
- **A floor after the groups, from "only the latest claim its emitter sent in the page"** — the
  sixth review found a stale claim flooring a row over a removal three ways, and "latest in the
  page" an order the relay does not keep; a removal made or applied here losing to a floor; a claim
  for a table with no counters spending its horizon; and the floor's `updated_at` touch carrying a
  lost field. Narrowed to a floor first, for a claim whose horizon covers every owed put of its row
  and everything this device had taken in, writing nothing but counts.

**The seventh review found the root, and Markus's stop rule fired** — one more round, then hand it
to the design session. Four devices: `a` took `c`'s `+1` in only through `e`'s claim, then added a
copy and re-baselined; `b` met `c`'s `+1`, `a`'s, and `a`'s emission without `e`'s. `a`, `c` and `e`
held 4 and `b` held **5**. `a`'s claim held `c`'s `+1` and `a`'s horizon did not cover it, because
`a` had never applied that op — it had applied a claim that contained it. Every receiver-side
"trust this claim" rule the eight rounds tried asked the horizon, so every one of them failed for
the same reason, no further narrowing could save one, and the claim needed a provenance of its own,
which is what an emission is. **A horizon says what an emitter *applied*, not what its rows
*hold*.**

#### Driven in the shipped window

**2026-10-03, debug build, Windows, `tauri dev` at `b4406e6b`** — the window over CDP, a copy of the
dev data pointed at a mock relay on the loopback (`relay_url`, and `share_url` so the Collection
page's share list stayed local too), in a TEST group with four **scripted** peers. Two app processes
cannot run on one machine, so the app was device b, and the other devices' pages were built ahead of
time from scratch databases by the real `baseline` and `emission` code, sealed by `wire::seal_batch`
and released into the mock's log one page at a time; each was then pulled by a press of **Sync
now**. Nothing reached the real relay. The copy needed `emissions_since` set to `0:0` by hand: it
held a watermark from an old group, so its first apply would have minted the upgrade cut a day ahead
and stripped every scenario's reference — the cut working as designed, on a database whose history
did not need it. After every page b was read three ways, and they agreed: the Collection page's own
`collection_list`, the tiles it drew, and the copy's `user.db` read beside the running app.

| Page | What it carried | b, then |
| --- | --- | --- |
| A first pairing in two halves | dev-a's first emission, one chunk a page — the second chunk's claims stamped below the first's | Bolt after the first; **Bolt, Counterspell and Elves, one copy each, after the second**; `taken@` dev-a |
| The same-second `+1` | dev-c's `+1` on Opt in the second b last heard from it, beside its own re-baseline | **Opt 2 → 3**: the claim *passed* (`wrote [0] passed [1]`), the `+1` took the op path |
| An inert re-broadcast | dev-a's, its horizon covering that `+1` | Opt **3**, not 4 — `skipped 5`, no record |
| A removal while another device re-broadcasts | the Collection page's stepper took Opt 3 → 2 and the write's own trip pushed it; then dev-c's note and dev-a's re-broadcast claiming 3, stamped above everything b had taken from dev-a | Opt **stays 2**, with dev-c's note — the inert claim took nothing back |
| A held clock | dev-e's put stamped **three days** ahead, and dev-f's claim for that row | **no row**; `pull_hold` kind `clock` with the held claim as a block of its own; the cursor and the ack held while the log moved on; the panel's clock sentence and one `error_log` row, still one after two more presses |

Before the window, the same pages ran through the real client against the same mock — `run_once`
over a scratch copy brought to head the way the launch brings it, at `280b5242`, ahead of the final
review's fixes — with the references and again with every reference stripped, which is how an older
emitter's baseline arrives. With them, every row above; without them, the second half lost
Counterspell and Elves, the `+1` was lost (2), and the removal was taken back (3). The held clock
read the same both ways there, because at `280b5242` a held-back op still joined every group of its
row. Since the final review's I1 it joins only a group whose claim names its emission, so a stripped
run on `b4406e6b` would build that row ahead of the held put, as `main` does — read off the code,
not re-run.

**What b sent**: before any page, its launch pushed the post-pull conversion's three ops and then one
baseline per peer — **4 emissions of 1 277 claims, 7 chunks each, a head and a horizon on every
chunk's first op, `since 0:0`, indices exactly `0..1276`** — and later the removal as one sparse op,
`quantity: -1`. One *Recently removed* folder throughout, under b's own uid (each peer's was absorbed
into it, a `retired@` mark apiece); no gap opened. **The other half of "both collections" was not
driven in the window**: a scripted device taking in what b pushed needs the Rust helper that applies
it, and that was a temporary test which could not be put back while the app ran — a source edit
under `tauri dev` is a rebuild. The dry run did it: dev-a, handed everything b pushed, ended with Opt
at 2, as b did.

**Two things the window says that are not quite right**, observed and not sync faults: a press during
the clock hold summarises the held change as *1 change is waiting on earlier changes* — a parent
wait's words, under the panel's correct clock sentence — and the header keeps saying *Synced with
your other devices.* while the cursor is held.

### Held while it can resolve, skipped when it cannot

Built 2026-09-27 ([the delivery holds design](../superpowers/specs/2026-09-27-sync-delivery-holds-design.md)),
to ship in the release that carries user schema v52 and ahead of token stacks PR 3's v53, whose new
`collection_folders.kind` word a v52 device must hold rather than drop. (PR 3 was dropped the same
day. v53 went to a deck's per-list piles — *A pile's list is on the wire since user schema v53*,
below — and `sync_gone`, written as v53 on its own branch, landed as v54: the moot row below, and
*A delete that would clear rows out of a folder waits for the retry* after the table's notes.) This section was titled
*Deferred ops are dropped, not held (open)* until then, and what it recorded is at its end.

**The client used to supply half a hold.** `apply` held the sender's watermark at the first op it could
not write, which makes a re-delivery safe — and `client::pull` then set `PULL_CURSOR` to the page
head whatever `apply` deferred. The relay's `since` (`relay/src/log.ts`) answers only rows with
`seq > cursor`, in one unpaged body, and `apply` keeps no copy of what it did not write, so the
deferred op, **and every later op from its device in that page**, was never applied and never
offered again. The other half is the cursor, and the reason it is not "hold the cursor on every
deferral" is the relay: `log.ts`'s `compact` drops a row only once its `seq` is at or below every
device's ack **and** it is older than the thirty-day tail, and the ack follows `PULL_CURSOR`. A
cursor held on something that can never resolve pins that group's log for good — metered storage —
and downloads everything above it again on every pull. **So a deferral says why, and only a reason
that something can still change holds.**

**Every op says which schema sealed it.** `merge::Op::schema` is an optional wire field that
`wire::seal_batch` stamps with `USER_SCHEMA_VERSION` on every op it seals — at sealing and never at
capture, so an outbox an older build wrote is stamped by the build that pushes it, and the push and
the baselines both pass through the one function. `op.schema > Some(USER_SCHEMA_VERSION)` is a
**newer** sender; absent — every op a build before this one sealed — is not newer. An older
receiver ignores the key, because nothing on the wire is `deny_unknown_fields`
(`wire`'s `a_sealed_op_carries_this_builds_schema_and_an_old_op_reads_as_none`).

**`apply` classifies every group it could not write**, from why — `UnknownTable`,
`UnknownParent { table, uid }`, or `Unbuildable` carrying the constraint's own words, which were
once discarded; a fourth, `DecidedOnRetry`, is what a pass answers for a decision it withholds — a
gone-based one until a `Decide` pass, a clearing delete until a `Clear` one — and never reaches
here (the table's notes) — and from
who sealed it (`apply.rs`'s `classify`, asked in this order, of the
last answer each group gave):

| The group | Class | Holds its device? | Recorded? |
| --- | --- | --- | --- |
| Names a parent deleted in this page, or anywhere a delete has ever reached this device — its own, a peer's applied here, a row a cascade took with either, or a row this device never held — which is what `sync_gone` records (user schema v54: a table of tombstones, not the `del` ops also called that) — and the parent's foreign key **cascades** | **moot**, decided only on a retry pass that follows one on which nothing else landed — and the row goes here too, where this device holds it and the group's placement under that parent stands, a folder included | no | no — the convergent outcome |
| The same, but the key is **`SET NULL`** (`collection_entries.folder_id`, `wishlist_entries.folder_id`, `decks.folder_id`, `deck_cards.label_id`) | **not held** — written without that parent, only on a retry pass that follows one on which nothing else landed | no | no |
| Any reason, and an op in it was sealed by a **newer** schema | **held · newer** | yes, with no bound | no — the Sync panel says it |
| An unknown parent, from a same or older schema | **held · waiting** | yes, until the client's bound | only when released |
| An unknown table, or a row this database cannot build, from a same or older schema | **dropped** — skipped | no | yes |
| Collateral: a later op of a held device | its block's class | — | — |

- **Moot is asked first**, because a deleted parent is a fact about this device that no upgrade
  changes: a newer device's child of a deck deleted here, held as newer, would wait for an upgrade
  that cannot help it and pin the log until then
  (`a_newer_devices_child_of_a_deleted_parent_is_moot_not_held`). **The page's delete set is built
  from every op in it, the already-seen included**: a held cursor brings a page back with the
  delete below its sender's watermark and the child perhaps attempted for the first time, and
  asking only the fresh ops would call the parent merely missing and hold its sender again
  (`a_redelivered_page_still_makes_a_child_of_its_delete_moot`).
- **A moot row this device already holds goes, as the sender's cascade takes it** (the final
  review, 2026-09-27). A peer moves a card into a pile deleted here: on the peer the card is in
  the pile when the delete lands, and the cascade takes it — while moot consumed the move here and
  left the card in its old pile, one device holding a card the other never will again. So
  `apply::cascade_onto_the_row_here` deletes the local row under the group's uid
  (`a_card_moved_into_a_pile_this_device_deleted_goes_on_both`). **Only where the group's
  placement under the deleted parent is the one that stands**, which the fold over this device's
  own history decides: where this device moved the row somewhere later, that move reaches the peer
  too and wins there, so the row is leaving the pile when the delete lands — and deleting it here
  would lose a row both devices place elsewhere
  (`a_stale_move_into_a_deleted_pile_leaves_a_card_this_device_moved_since`, red against the
  unconditional delete). ⚠️ **Read off the code and unmeasured**: the peer's own outcome is not
  order-free either — its applier takes a page parents first, so a delete and a later move of the
  same row in one page cascade the row before the move is attempted, and the move rebuilds it only
  where that device's history holds the row's insert.
  **Until user schema v54 it never reached a table another table's spec names as a parent** — the
  three folder tables, and a deck, a pile, a label and a note, which moot never finds here anyway
  — and `gone` was the reason. The scoped re-review of this delete found it: the delete is
  uncaptured and no delete in the page, so nothing recorded it. A peer that moved a folder under one
  deleted here and then filed a deck in it sent a deck naming a folder nothing here said was gone;
  the deck waited out the bound and the release dropped it, every card in it with it — where on the
  peer the delete cascaded the folder and `SET NULL` put the deck at the root. So for those tables
  the moot arm consumed the group and touched nothing, and the moved folder stayed here while the
  peer's cascade took it — a folder one device held and the other did not. ⚠️ **That was a lasting
  loss, not a placement difference** (the second scoped re-review of #574, read off the code and
  unmeasured). The peer's cascade ran inside `apply`, under capture suppression, so it left no
  `del` there either, and **anything this device filed into that folder afterwards** — a deck with
  its piles and cards, a copy, a wish, a sub-folder — named a parent the peer's `gone` could not
  see, waited out the bound there and was dropped, for as long as the folder stood here; a rename of
  it was skipped there with an `error_log` row each time. Deleting the folder here instead (round 1)
  converged but lost what the peer had filed into it before hearing about the delete. **Neither
  answer was right without a trace, and v54 is the trace**
  ([folder deletes across devices](../superpowers/specs/2026-09-27-folder-deletes-across-devices-design.md),
  2026-09-27). `sync_gone (tbl, uid)` is a user table of **tombstones in a second sense** — a row
  saying a parent went, where every other tombstone in this document is a `del` op in `sync_ops`
  — `WITHOUT ROWID` and **not synced**, one row per deleted row of a table other rows are filed
  under. An `AFTER DELETE` trigger writes it, `sync_gone_{table}`, which `capture::install` puts on
  every table `capture::parent_tables()` reads off `capture::TABLES`' `parents`, and `apply` writes
  it by hand for a row it never held (below); nothing else does. **The trigger is gated on
  `OLD.sync_uid IS NOT NULL` and on nothing else**: not the apply guard, and not the device being
  in a group, so a device that pairs later still knows what it deleted. SQLite fires `AFTER DELETE`
  on the rows a foreign-key cascade takes as well — measured 2026-09-27 with `node:sqlite`, a
  folder whose child folder cascades logged `before p, before x, after x, after p` — so this
  device's own delete, a peer's applied here, a moot delete and every cascade any of them sets off
  all land there, and no command has to remember to record anything. `gone` asks the page's delete
  set and then that table, one primary-key read, in place of this device's own `sync_ops`; the
  rung backfills it from those `del` ops for the seven parent tables of the day, spelled in the
  rung because a rung is history, so nothing `gone` answered before it stops answering. **Nothing clears it** — leaving a group keeps
  it, as it keeps `sync_ops` — and a stale row is never read, because a parent add-wins brought
  back is found by `resolve_parent` before `gone` is asked. So the moot delete reaches folders
  again, on the same placement check: in the moved-folder case this device now deletes the moved
  folder as the peer's cascade did, a `sync_gone` row for it lands on both devices, and whatever
  either files into it afterwards is written at the root (a deck, a copy, a wish: `SET NULL`) or
  dropped with it (a sub-folder, a pile: `CASCADE`) on both
  (`a_deck_filed_into_a_folder_moved_under_one_this_device_deleted_survives_on_both`, and
  `a_copy_filed_into_a_binder_moved_under_one_this_device_deleted_survives_on_both` for the
  collection's cabinet, each extended to file from both devices and to find the moved folder gone
  on both). A third device's delete is the same fix seen from the other side
  (`a_copy_filed_into_a_binder_a_third_device_deleted_lands_at_the_root`, and *What a hold cannot
  reach*, below). **A row the moot arm never held is recorded by hand** (`apply::tombstone`, where
  rows are filed under its table), because a `DELETE` that finds nothing fires no trigger: a peer
  that makes a folder under one deleted here and files a copy into it sends a folder this device
  consumes as moot with no row to take, and the copy behind it named a folder nothing here said
  was gone — it waited out the bound and was dropped, where the peer's cascade puts it at the root
  (`a_copy_filed_into_a_binder_made_under_one_this_device_deleted_lands_at_the_root_on_both`).
  **That row is written only on a deciding pass**, as the whole moot decision is (below). Written
  on the first attempt, as it was for one fix round, it sent a child in the same page to the root
  before a later group of that page brought the parent back through add-wins, and the retry then
  built the folder under the resurrected parent — the child at the root here and in the folder on
  the peer (`a_folder_made_under_a_parent_the_same_page_brings_back_keeps_its_copy`).
  **A folder's or a deck's moot delete is a clearing delete, and waits as the delete arm's does**:
  while rows are still filed in the folder it is decided only on a `Clear` pass, and the
  re-homing after these notes takes whatever is left then. It had a wait of its own until the whole
  decision moved to the retry, then none — a deciding pass was taken to be late enough — and has one
  again since the final review's second wave, because a deciding pass's own decisions can land a
  deck's group that a copy in the folder is moving into (*Why a `Clear` pass and not the deciding
  one*, below). Two dragged-copy tests pin the older half of the wait
  (`a_copy_dragged_onto_a_lower_root_twin_out_of_a_binder_moved_under_a_deleted_one_lands_once`
  and its `…higher_root_twin…` sibling: deleted on the first attempt, the folder re-homed a copy
  the page was itself folding, which counted it twice or deleted the survivor, by uid order).
  **A moot `deck_cards` row on the live list goes without `release_group_copies`**, so copies its
  deck's group held for it stay in the group, claimed by no row — which is what the peer's own
  cascade leaves too, since a foreign-key cascade releases nothing, so the two agree.
  A delete this database refuses leaves the row where it is, as moot always did, rather than
  failing the apply on every pull — nothing on the tables it reaches refuses one today, and
  `a_moot_delete_this_database_refuses_leaves_the_row_and_applies_the_rest` stands a TEMP trigger
  in for the first thing that will.
- **The `SET NULL` row is an amendment, and a measurement made it.** The design called every child
  of a deleted parent moot, which holds only where the delete would have taken the child with it.
  Where the key is `SET NULL` the delete left its children in place with the column cleared, and
  the child's own device does the same when the delete reaches it — so consuming the child is a copy
  one device holds and the other never will. On the moot-for-everything code the folder case failed
  `b lost the copy: left (0, 0), right (1, 1)`; for `decks.folder_id` it would have been a whole
  deck. `apply::cascades` reads `on_delete` off `pragma_foreign_key_list` on the live schema, so the
  rule is never restated beside the key it describes
  (`a_child_of_a_folder_this_device_deleted_lands_at_the_root_on_both`).
- **Every decision resting on `gone` is taken only on a retry pass that follows one on which
  nothing else landed** — both arms, the moot one and the `SET NULL` one. The first attempt and
  every `Retry` pass — the first retry pass, whatever the first attempt landed, and each one after
  a pass on which something landed or was decided — answer `Why::DecidedOnRetry` and withhold
  the decision (Task C's fix rounds, 2026-09-27: the branch decided both arms on the first attempt,
  then on any retry pass, before this). `gone` answers for the page as it stands, and a group of
  the same page can still bring the parent back: an edit made on the sender after this device's
  delete resurrects it through add-wins, and that group can sort after the child — the page sorts
  by table rank and then by each group's earliest op — **or land only on a retry pass itself**,
  because it waits on a parent of its own. Decided before the parent came back, the moot arm
  deleted a folder moved under it, which the folder's own sparse move could not rebuild when the
  parent returned — dropped as `NOT NULL constraint failed: collection_folders.name` while the
  sender kept it (`a_folder_moved_under_a_parent_the_same_page_brings_back_follows_it`) — and the
  `SET NULL` arm filed at the root a copy the sender keeps in its binder
  (`a_copy_filed_into_a_binder_the_same_page_brings_back_stays_in_it`). **One retry pass was not
  late enough either**: `b` holds `X` and deletes `P`, and `a` moves `X` under `P`, renames `P`,
  makes `Outer` and moves `P` into it, so `P` waits on `Outer` on the first attempt and is
  resurrected on the first retry pass — after `X` was met on it; decided there, `X` was deleted as
  moot and lost for good (`a_folder_moved_under_a_parent_resurrected_on_a_retry_pass_follows_it`,
  and `a_copy_filed_into_a_binder_resurrected_on_a_later_retry_pass_stays_in_it` for the
  `SET NULL` arm two passes in). A pass on which nothing landed is one after which no group of the
  page can land without a withheld decision, so no resurrection is still to come; `resolve_parent`
  is asked again first on every pass, finds a resurrected parent, and the group is written like any
  other — only a parent still unknown and still gone reaches either arm. **The cost: every group
  naming a gone parent takes at least two retry passes**, one that withholds and one that decides.
  That is a put, or a put and its delete in one page, naming the parent: **a bare `del` carries no
  parents**, resolves none and never reaches this arm, so a deck's cards deleted with it in the
  same page, each a bare `del`, do not pay it. Each pass is one more `write_group` over a parent
  already not found — cheap beside the pull.
- **The retry passes run to a fixed point, bounded** (`apply::run_groups`). The groups the first
  attempt did not write are retried in page order on **three kinds of pass**: a `Retry` pass
  writes what it can and withholds every gone-based decision and every clearing delete; a `Decide`
  pass, which runs only after a `Retry` pass on which nothing landed, takes the gone-based
  decisions and still withholds the clearing deletes; and a `Clear` pass, which runs only after a
  `Decide` pass on which nothing landed, takes those too (the clearing-delete notes below). A pass
  that landed or decided something is followed by a `Retry`; one that did neither but withheld a
  decision by a `Decide` after a `Retry` and by a `Clear` after a `Decide`; a `Clear` withholds
  nothing, and a pass that neither progressed nor withheld ends the loop — and a decision is
  progress in its own right, so the loop goes on with `Retry` passes after it. A group waiting on a
  parent that is unknown and not gone goes round again, every other answer is final, and **only
  each group's last answer is classified**, so a hold is decided by the page as it finally stood.
  **The cap is three times the page's group count plus one** and is never reached: every pass
  that lands or decides something takes a group out of the waiting set for good, and at most two
  passes fall between two of those — a `Retry` and a `Decide` that landed nothing, before a `Clear`
  that either decides something or ends the loop. It was twice the count plus one until the
  `Clear` pass came in, at the final review. Why the loop at all: a child can be
  met before the parent it waits on has been decided. `a` renames `X`, makes `Z` under a `P` this
  device deleted and moves `X` into `Z`, and `X`'s group sorts ahead of `Z`'s (its earliest op, the
  rename, is older than `Z`'s creation), so on a single retry `X` asked after `Z` before `Z` had
  been decided — unknown and not yet gone — and was held, `Z` got its `sync_gone` row too late,
  and when the release dropped `X`'s ops this device kept `X` where `a`'s cascade had taken it
  (`a_folder_moved_into_one_made_under_a_parent_deleted_here_goes_on_both`). Now `Z` is decided
  moot on a `Decide` pass and a later pass finds `X` under a parent that is gone, deleting it as
  `a`'s cascade did. A child whose parent is genuinely missing ends the loop on the first pass after
  the last thing moved, never at the cap (`the_retry_passes_stop_when_nothing_can_progress`, which
  reads the pass count a test-only counter keeps). The cost is up to three passes for each link of
  the longest chain of waiting groups, over only the groups still waiting; a page with nothing
  withheld and nothing waiting pays the one retry it always paid. All the passes run inside one round of the apply, so a round that
  is rolled back takes every pass with it.
- **Held · newer is a hold on a possibility.** A newer sender's group this build cannot write may be
  one an upgrade can — a table it has not heard of, a `CHECK` word a rung will add — and nothing
  here can tell which, so every newer deferral holds
  (`a_newer_devices_op_that_defers_is_held_and_blocks_its_later_ops`). One that still cannot be
  written after the upgrade is a same-version group by then, and is skipped.
- **A skip is consumed, and it no longer takes company.** Moot and dropped groups do not block: the
  ops after them apply and the watermark passes them, which is also what stops a re-delivery
  recording the same skip twice. A dropped group is one `errors::record` under `Source::Relay`,
  operation `apply` — "a change to {table} from another device could not be applied and was
  skipped", the uid and the reason in the detail — folded on that message, so a table's repeats are
  one row with a count. It is written only for the pass that committed, inside the apply's
  transaction, so an apply that fails leaves no record of a skip it never made
  (`a_same_version_unknown_table_is_dropped_recorded_and_does_not_block`).
- **`ApplyReport` names each**: `held_newer`, `held_waiting`, `moot` and `dropped` beside the old
  counts. `deferred` is `held_newer + held_waiting`, collateral included, and `applied` counts only
  ops *this* call wrote. `apply(conn, ops)` is `apply_with(conn, ops, Waiting::Hold)`;
  `Waiting::Release` is how a waiting hold ends — it becomes dropped and recorded, and its
  collateral applies exactly once, while a newer group stays held either way
  (`an_unknown_parent_waits_then_release_drops_it_and_applies_its_collateral_once`).

**A delete that would clear rows out of a folder waits for the retry, then re-homes them** (user
schema v54's branch, 2026-09-27, the folder-deletes design §3.3 as amended). It began as a stall,
and the worst kind. `apply` takes a page parents first (`META[].order`), so a peer's
`collection_folders` delete, rank 6, runs ahead of the rank-7 `collection_entries` ops that
re-filed its copies on the sender — where `collection_folders::delete_folder` merges every copy
onto the root one at a time before the folder goes, and so never meets a collision. Here the
folder's `DELETE` ran with a copy still filed in it, `ON DELETE SET NULL` moved the copy onto the
grain of a copy the root already held, and the delete arm answered `UNIQUE constraint failed:
index 'idx_collection_grain'` through `?`: **the whole apply failed, and the same page failed it
again on every pull**, so that device's sync stopped for good. A throwaway probe in the `apply`
test harness reproduced it (debug build). Read off the code, a wishlist folder is the same shape,
and so is a deck: its group folder goes with it (`collection_folders.deck_id` cascades) while
`deck::delete_deck`'s re-filing into `Recently removed` is rank 7 behind the deck's rank 1 — and a
copy filed into the folder here, concurrently, has no re-filing in the page at all. So every
`DELETE` `apply` issues — the delete arm's, and the moot delete above — now finds first what it
would clear (`sync_engine/apply/rehome.rs`'s `doomed`):

1. **The doomed folders.** A `collection_folders` or `wishlist_folders` row and its sub-tree, or a
   `decks` row's group folders and theirs: the three `ON DELETE CASCADE` keys into the two folder
   tables, `collection_folders.parent_id`, `collection_folders.deck_id` and
   `wishlist_folders.parent_id`. (`wishlist_folders.managed_deck_id` has no foreign key, so a deck's
   delete never cascades into the wishlist.) `rehome::CASCADES_INTO_FOLDERS` names the three, and a
   test reads every such key off the live schema and fails on one it does not cover. Any other
   table dooms nothing and costs no query.
2. **The doomed rows**: the copies and wishes filed directly in those folders — the rows the
   delete's `SET NULL` would move onto the root's grain.

- **A first attempt with anything doomed writes nothing** and answers `Why::DecidedOnRetry` — the
  reason every decision resting on `gone` shares (the table's notes, above) — **and so does every
  `Retry` and every `Decide` pass on which anything is still doomed**, the moot arm's delete of a
  folder included. The group joins `run_groups`' failed list and is tried again on the retry
  passes, after every other group in the page has had its first attempt, by which time the
  sender's own writes to those rows — later in rank, sealed before its delete — have landed, or
  land on a later pass. **A clearing delete is taken only on a `Clear` pass**, the one that follows
  a `Decide` pass on which nothing landed: a pass that finds nothing doomed any more deletes at
  once, and otherwise the delete answers `DecidedOnRetry` on every pass until then. The reason is
  **never classified**, short of the loop's cap: a withheld group is
  on every pass until it is decided, the loop ends only on a pass that withheld nothing, and only
  each group's last answer is kept. A delete that dooms nothing — any other table, or an empty
  folder — goes on the first attempt, in stamp order.
- **The retry re-homes, then deletes.** Each doomed row still in a doomed folder, in `id`
  order, is filed at the root through the crate's own merge — `collection_folders::refile_entry`
  and `wishlist_folders::refile_wish` with no folder — which folds it onto a twin (counters summed,
  provenance coalesced) or clears its folder. Where it folded, **the survivor takes the lower of
  the two `sync_uid`s**, set after the source is gone so the uid index has nothing to refuse; a
  nameless side takes the other's, and two nameless sides keep none. Then the `DELETE`, whose `SET
  NULL` has nothing left to act on. By the retry the page's own re-filing has taken what it moves,
  so what is re-homed is only what the page never mentioned.
  `a_binder_deleted_with_a_copy_the_root_also_holds_lands_on_the_peer` went red against the old
  arm with the stall's own words.
- **Why every clearing delete waits, and not only one that would collide.** The design as approved
  waited only on a collision — a doomed row whose grain, its folder cleared, matched a root row or
  another doomed row — and Task B's review found two losses in that. Whether a delete collides
  depends on what has landed yet, and a page taken parents first has not landed the sender's own
  rows: a sender that makes a new root copy and then deletes a binder whose copy folds into it
  sends a delete that collides with nothing on the peer, so the binder's copy was re-homed onto the
  free grain, the new copy's insert grain-matched it and added its count on top, and the two
  devices' counts parted
  (`a_new_root_copy_and_a_binder_that_folds_into_it_land_at_the_senders_count`). That loss is why
  the question is only whether anything is doomed, and the collision probe went. The other was a
  folder deleted and re-made at the same grain in one page, which lost the re-made row wherever its
  delete did wait — no corner, since `reset::clear_collection` re-makes `Recently removed` and every
  deck group in one write — and waiting more makes it commoner, so the next two bullets are the
  other half of the change.
- **A grain match onto a row this page deletes adopts the incoming uid, not `min`** (`find_row`).
  The sender retired that uid: it deleted the row and made the incoming one in its place on the
  same grain. `reset::clear_collection` does exactly that to `Recently removed` and to every deck's
  group, both grained — partially, on `kind = 'removed'` and on `deck_id` — so on a peer whose old
  folders still hold copies the old rows' deletes wait for the retry while the re-made rows'
  inserts land on the old rows. Kept by `min` wherever the old uid sorted lower, the retried
  delete then took the very row the insert had just landed on, and the peer lost its holding area
  or a deck's group with nothing recorded, about half the time by uid order. Under the incoming
  uid the retried delete finds nothing to take
  (`a_collection_cleared_on_one_device_keeps_the_re_made_folders_on_the_other`, which forces the
  old uids low so the order is not a coin toss). `adopt_uid`'s taken-check still applies.
- **A group whose own ops end in a delete finds its row by uid alone, never by grain**
  (`find_row`, the other half of the same fact). The sender made that row and discarded it, so its
  delete can only mean a row wearing its uid, and a grain match could only hand it one this device
  keeps. It did, twice over, each time a row deleted with nothing recorded: a collection cleared
  twice between two pulls — or a deck switched to Virtual and back twice — sends `del R`,
  `put R'` + `del R'`, `put R''` on one partial grain, and on the retry the `R'` group grain-hit
  `R''`, adopted it and deleted it
  (`a_collection_cleared_twice_on_one_device_keeps_the_last_re_made_folders_on_the_other`); and a
  copy the sender added and removed again grain-hit a copy of that printing the peer had made on
  its own, and deleted that (`a_row_made_and_deleted_on_the_sender_never_deletes_a_local_twin`).
  **Keyed on the group's own fold, and not on the page's delete set**: a row deleted and put back
  in one page — a third device's edit beating the delete, add-wins — names its uid in a `del` op
  and still folds to a row that exists, so it grain-matches like any put and a twin this device
  made meets it as one row. Keyed on the page's deletes, it inserted beside the twin and was
  dropped as a row this database cannot build
  (`a_row_deleted_and_put_back_in_one_page_still_meets_its_twin`).
- **A delete of a parent this device never held still leaves a `sync_gone` row.** A parent made
  and deleted on a third device between two of this device's pulls arrives as a put and a `del`
  op in one page, folds to deleted, finds no row and so fires no trigger; the delete arm writes the
  row by hand (`apply::tombstone`, for the tables `capture::parent_tables()` names and no other),
  so a child of that parent on a later page lands at once instead of waiting out the bound
  (`a_child_of_a_parent_a_third_device_made_and_deleted_between_two_pulls_lands_at_once`).
- **Why the lower uid.** A row re-homed here is one the page did not mention — filed here
  concurrently, or by a third device — so its own put reaches the sender with its folder gone, a
  `sync_gone` row there saying so since the sender's own delete. The sender writes it without the
  folder, and `find_row`'s grain match lands it on the same twin, adopting `min`: one row, one
  count and one uid on both devices.
- **Why the retry and not at once.** On the first attempt the sender's re-filing has not landed, so
  a merge would fold a copy the sender has itself already merged onto the root, and the sender's own
  `+n` for the twin would then count it a second time. Measured by mutation on 2026-09-27, against
  the design before the wait was widened: merging on the first attempt turned five of the branch's
  new tests red, the binder's above among them.
- **Why not the first retry pass.** A copy the sender dragged out of the binder
  into a folder the page itself makes is moved only once that folder lands, and the folder can
  land only on a retry pass: `a` makes `N`, then `Outer`, moves `N` into `Outer`, drags `c` from
  `B` into `N` and deletes `B`, so the peer meets `N`, `Outer`, `B` and `c`'s move in that order,
  and `N` and the move each fail the first attempt on a parent that lands later. Decided on the
  first retry pass — as it was until the final review — `B` came round after `N` had landed and
  before `c`'s move, and re-homed `c` onto its root twin `t`. Where `c`'s uid sorted lower the
  survivor wore it and the move carried both copies into `N`, while the sender kept `c` in `N` and
  `t` at the root; where `t`'s did, the move found no row and was dropped with an `error_log` row
  (`a_copy_dragged_into_a_folder_the_page_makes_late_out_of_a_deleted_binder_lands_there`, both uid
  orders forced, red first against the first-attempt-only wait). Waiting through every `Retry`
  pass, the move lands on the first retry pass and `B` is deleted empty on the next.
- **Why a `Clear` pass and not the deciding one.** The deciding pass's own decisions land groups,
  and a group they unblock can re-file a row later in that same pass. `b` deletes a deck folder
  `F`; `a` makes a deck `Q` in `F` — its group `G` with it — adds the card to `Q`'s list, moves `c`
  out of binder `B` into `G` with `collection_to_deck` and deletes `B`, and a root twin `t` of
  `c`'s printing is on both devices. On the peer nothing lands before the deciding pass: `Q` waits
  for its `SET NULL` decision, `G` on `Q`, `B` on `c` and `c`'s move on `G`. The deciding pass
  writes `Q` without `F`, then `G` lands — and `B`, decided on that pass as it was until the final
  review's second wave, re-homed `c` onto `t` before `c`'s move came round: where `c`'s uid sorted
  lower the move carried both copies into `G`, so the peer's deck owned 2 against the sender's 1,
  and where `t`'s did the move found no row and was dropped with an `error_log` row. **The moot
  arm's delete of a folder is the same delete and had the same flaw**: `b` deleted a binder `P` as
  well, and `a` moved `B` under `P` in place of deleting it. Both forms, each in both uid orders,
  are `a_copy_moved_into_a_decks_group_the_page_makes_late_lands_there`, red first against the
  previous wave's guard; a mutation that drops either arm's wait turns exactly that arm's two red.
  Withheld until a `Clear` pass, `B` is met again only after the move has landed on the deciding
  pass, finds nothing doomed and goes empty, so no `Clear` pass is needed at all: three retry
  passes for the delete arm and four for the moot one, read off the test-only counter.
- **Not "apply deletes last"**, which would have fixed the ordering in one line and is wrong: a row
  deleted and re-added at the same grain between two pulls — a card stepped to 0 and added again, a
  pile deleted and re-made under its old name — would have its put land first, grain-match the row
  the delete is about to take, and either sum the two or delete the survivor. So the page order
  stays, and only what the page cannot settle in order waits for the retry — a delete that would
  clear rows, and every decision resting on `gone`; a test pins a copy removed and re-added in one
  page against that change.
- **The backstop.** Every `DELETE` `apply` issues runs inside a savepoint, and a refusal is rolled
  back and **never `?`**. The moot delete already fenced its refusal, leaving the row where it
  stood; the delete arm gained the fence, and there a refusal — the read of the doomed rows and the
  hand-written `sync_gone` row included — becomes `Why::Unbuildable` carrying the constraint's
  words, dropped and recorded, or held where the sender is newer
  (`a_folder_delete_this_database_refuses_is_dropped_and_the_page_applies`, a TEMP trigger standing
  in for the refusal). A refused delete leaves a folder on one device, which is recorded and
  visible; a stalled sync is neither.

All of it runs inside `apply`'s `capture::suppressed`, so every device derives the same re-homing
from the same delete, and `rehome.rs` borrows its two merges, `collection_folders::refile_entry`
and `wishlist_folders::refile_wish`, rather than spelling a third. What it leaves is under *What is still owed*. **And for whatever files into a folder next**: a
folder deleted on a peer re-homes its leftover copies to the **root**, as `SET NULL` does, and a
sweep that files them somewhere else afterwards must be a derived write behind
`capture::suppressed`, like `reconcile`, or both devices sweep the same copy and the destination
counts it twice.

**The client holds for the reason, and for no longer than the reason lasts.** After `apply` in
`client::pull`, with the epoch rule (`behind`) unchanged and still first:

1. **`held_newer > 0`, or an envelope that opened, did not parse and says a newer build sealed
   it** (`WireError::Newer`, below) → the cursor stays, and `sync_state.pull_hold` says `newer`.
   **No bound**: an upgrade resolves it and nothing else does, and releasing it would be the very
   loss this section used to record.
2. **Else `held_waiting > 0`** → the cursor stays, and `pull_hold` says `waiting`. Once the hold has
   been seen on **3 pulls spanning at least 600 seconds**, counted from the pull that first met the
   blocks it holds, the same ops are applied again with `Waiting::Release`, and the cursor advances
   — unless the release uncovers a newer group: a newer build's op held as collateral behind the
   waiting one reports as waiting until the release attempts it, and it then holds as `newer`
   rather than being stepped past (`a_release_that_uncovers_a_newer_op_holds_it_as_newer`).
3. **Else** the cursor advances and `pull_hold` is deleted.

**Why the waiting hold has both bounds.** Its ordinary cause is first contact: `round_trip` pushes
before it emits baselines, so a peer can pull a child a moment before the baseline that carries its
parent, which arrives on that same trip of its sender's, seconds later. **Ten minutes** is time for
it to have come. **Three pulls** is evidence that this device has looked since: elapsed time says
nothing about a device that slept through it, and its next page may be the one with the parent.
What the bound ends is a parent that will never come — deleted on a third device and applied here
by a build before user schema v54, which left no trace here (below). A parent that does arrive
clears the hold on that pull, advancing, with nothing recorded (`client`'s
`a_waiting_hold_clears_when_the_parent_arrives`).

**The bound belongs to the blocks it has watched, and a new block starts it over** (the final
review's I1, 2026-09-27). The hold was counted by kind alone until then, so a second wait that
began while an older one was open inherited the older one's pulls and span, and the release that
ended the first dropped the second with it. The case that costs something: a wait nothing will end
— a child whose parent a third device deleted — has run its course when a device that has just
paired pushes a child ahead of the baseline carrying its parent; the pull that meets that child
releases both, and the parent landing a trip later finds its child gone below the watermark. So
`pull_hold` stores what it holds on — each held device at the stamp of its first held op
(`apply::apply_held`'s `Held`) — and a pull that finds a block not in that set starts `since` and
`pulls` over. A block that resolved and left is not new, and is simply dropped from the set
(`a_new_waiting_block_starts_the_bound_over`). ⚠️ **What it costs**: the release is all or
nothing, so an old wait sharing a hold with new ones is released only once no new block has
appeared for three pulls and ten minutes — longer on the relay's floor, bounded by how often a
first contact happens, which is the only ordinary source of a waiting block.

**`pull_hold`** is `{"kind":"newer"|"waiting","since":<unix seconds>,"pulls":<n>,
"blocks":{"<device>":[<ms>,<ctr>]},"noted":[["<device>",<ms>,<ctr>]]}` in `sync_state`, and an
absent key is not held. `blocks` is what the hold holds on: `apply`'s held devices, and each
device with a batch only a newer build can read, at the earlier of the two stamps. The same kind on
no block it has not seen keeps `since` and counts the pull; a different kind or a new block starts
over — so a page holding both kinds is a newer hold, and its waiting half starts counting only once
an upgrade has cleared the newer one. **A row written before `blocks` was stored reads as a hold on
an unknown set**: its kind still reaches the panel, and the next pull starts over
(`a_hold_written_before_its_blocks_were_stored_reads_and_starts_over`). `noted` is the unreadable
envelopes this hold's pulls have already written to `error_log`, by device and stamp, so a held page
handed back on every trip records each once (below); it is left out while empty. `since` is SQL's
`unixepoch()`. It is a `sync_state` key and no schema rung, it survives a restart,
`identity::leave_group` deletes it with the group (`leaving_clears_a_held_pull` — a count left behind would carry into the next
group's first wait), as a join into a different group does, along with the cursor and the ack
(*A cursor is a place in one group's log*, above), and a newer hold is never released by pull count or time
(`a_newer_hold_is_never_released_by_the_waiting_bound`). `sync_relay_status` reads its kind into
`RelayStatus.pullHeld` — `"newer" | "waiting" | null`, and **`null` whenever the device is in no
group**, whatever the key says: a departure made by a build before `leave_group` deleted it left it
behind, and a device that has left is held on nothing.

**A batch that opens and does not parse holds only when it says a newer build sealed it.**
`wire::open_batch` reaches the parse only after the group, the epoch and the AEAD have all passed,
so a member of the group sealed the batch. It used to be counted unreadable and stepped over, which
dropped a newer build's batch — one carrying an op `Kind` this build has never heard of. The design
then held on every one, on the argument that only a newer build could seal what this one cannot
parse; the final review found the hole in that: a same-version batch that does not parse — a bug, a
hand-rolled client — would pin the relay's floor for good and ask the reader to update a build they
already run. So `open_batch` re-reads a plaintext that failed as a list of bare JSON values, and
answers **`WireError::Newer`** when some element carries a `schema` above `USER_SCHEMA_VERSION` —
the field `seal_batch` stamps, which a newer build stamps too — and **`WireError::Malformed`**
otherwise, including for no `schema` at all and for bytes that are not a list
(`wire`'s `a_batch_that_does_not_parse_is_newer_only_when_an_op_says_so`). `Newer` is counted,
noted and holds the cursor as `newer` (`an_authentic_batch_this_build_cannot_parse_holds_as_newer`);
`Malformed` is counted, noted and stepped over, and holds none of its sender's later batches
(`a_same_version_batch_that_does_not_parse_is_stepped_over_and_recorded_once`). An envelope whose
AEAD fails at the same epoch is stepped over as it always was: nothing says a member wrote it, and
holding on it would pin the log for bytes nobody can read (*One correction to the plan*, below).

**Every unreadable envelope in a held page is noted once per hold, not once per pull.** The page
comes back on every trip — for a newer hold, until the reader updates — and a `pull`/`parse` note
on each would turn one batch into an `error_log` row counting trips. So `pull` asks the stored
hold's `noted` before it notes, and writes what this page met back into the hold
(`a_held_pull_records_its_unreadable_batches_once`, a newer batch and a same-version one stepped
over in the same held page). A pull held behind a key rotation writes no `pull_hold` and still notes
its unreadable envelopes each time, as it always did.

**The newer-batch hold keeps the sender's later envelopes with the cursor.** `apply` never sees a
batch that did not parse, so a later envelope from the same device in the page — sealed by the same
newer build, with nothing in it this one cannot read — would apply and move that device's watermark
past the unparsed ops, and when an upgrade let them parse, the page would come back with them below
the watermark and they would be skipped as seen. So `pull` leaves out every envelope from that
device stamped at or after its first `Newer` one — by the envelope's own stamp
(`hlcMs`, `hlcCtr`), not by its place in the page — and they wait with the cursor, counted in
`held_newer`. The device's earlier envelopes are below the block and apply, and other devices'
envelopes are untouched (`a_malformed_batch_holds_its_senders_later_batches_too`, which puts the
later envelope first in the page, then re-delivers it with the batch parseable and lands its `+1`
exactly once). That first stamp is also the device's block in `pull_hold`, unless `apply` holds it
earlier still.

**What the relay pays for a hold.** A held cursor is a held ack — `ack` sends `PULL_CURSOR`, and
sends nothing at all when it has not moved since the last one — so the group's compaction floor
stays at this device's last ack for the length of the hold, and every pull downloads everything
above the cursor again: the held page and whatever the group has written since, one body that only
grows while `pull` has no page size (*What is still owed*). **For a newer hold that is until the
reader updates**, which the Sync panel asks them to do; **for a waiting one, at least three pulls
and ten minutes**, whichever comes later. The ops `apply` already wrote are skipped against their
watermarks on every re-delivery and are not counted again: `RelayOutcome.pulled` counts newly
applied ops only, so a held cursor does not fire `sync:applied` and refresh every screen on every
trip (`a_held_page_applies_the_other_devices_once_and_counts_them_once`).

**What the reader sees.** While `pullHeld` is `newer` the Sync panel draws "A device in your group
runs a newer version of MTG Grimoire. Update this device to receive its changes." — a paragraph,
not an alert — and a waiting hold, being transient, draws nothing. A sync's outcome line names the
held-newer count ("… from a newer version wait until you update."), the waiting one ("… waiting for
a change they build on."), and the dropped one ("… could not be applied and were skipped. The error
log has the details."). Its old clause, "They land on a later sync.", was false for as long as
nothing re-delivered, and is gone.

**The legacy token-pick conversion runs behind an advancing pull only.** A held pull has not heard
everything, which is the gate's own reason (*A paired device converts behind a pull*, above), so
it neither converts nor sets `token_picks_ready`
(`no_legacy_pick_conversion_runs_behind_a_held_pull`).

⚠️ **A future page limit must page to the end before a hold is evaluated.** `pull` has none today,
and one is planned (*What is still owed*). A limit that answered a page at a time, with the client
holding its cursor on the first, would ask for that same page for ever and never reach the one that
resolves it — the baseline carrying a waiting child's parent, or merely the page after a held one.
The cursor-carrying loop the limit needs must walk to the head, and only then may a hold be decided.

**A third hold, `clock`, since issue #546 (2026-09-28).** A batch carrying any op above its
sender's `sync_peers` watermark and stamped more than `hlc::MAX_AHEAD_MS` — one day — past this
device's wall clock holds **every batch of that sender in the page**, and `PULL_CURSOR` with them,
under `"clock"`. The whole sender and not "from that batch's stamp on", as a newer build's batch is
held: a baseline's chunks are stamped from `updated_at` in table order, so a sibling chunk that
applied could lift the watermark past ops in the held one, and the release would skip them as
seen. The watermark test keeps a far-ahead batch this device already applied — re-delivered across
an upgrade — from holding anything; the panel draws `PULL_HELD_CLOCK_NOTICE`, and `error_log` gets one
row per hold naming the device and roughly how far ahead it is. **Held rather than applied, and
the other two answers are both worse**: applied, a device with a future-dated clock wins every
last-writer-wins edit and `apply`'s observe drags every peer's hybrid logical clock forward for
good; clamped — applied while refusing to let this device's clock pass it — the reader's next edit
here is stamped *before* the op it followed, loses on every other device and stands on this one,
which is divergence. **It is bounded by time itself**: it resolves once this device's clock comes
within a day of the stamp, with nobody pressing anything. A day admits every honest error of the
dual-boot kind (a hardware clock kept in local time, up to 14 hours off) and refuses a wrong date.
Precedence is behind > newer > clock > waiting. ⚠️ **A member chooses its own stamps**, so a batch
sealed a year ahead holds this cursor for a year less a day — within what a member holding the key
can already do to its own group. An updated relay refuses such a push (422 `clock_ahead`, measured
against the relay's clock, the one every device shares), so what reaches this hold is a log stored
before that, or a receiver whose own clock is behind. **The pusher defers rather than stalls** —
its trip still pulls and acks — **and rebases once its clock is set right** (`client::rebase`):
`sync_clock` only ratchets forward, so one write under a date a year ahead stamps every later op a
year ahead too, and without the rebase that device could send nothing for a year. Pending ops
stamped past `base` — the latest of the wall clock, every peer's watermark and this device's own
pushed stamps — are re-stamped from it with successive ticks in one transaction and the push goes
again. It converges because nobody has seen those ops, their order among themselves is kept, and
they still sort after everything this device observed or sent, so every last-writer-wins decision
already made here is the one every other device makes. **It refuses when `base` is itself a day
ahead** — a future stamp already reached the group through an older relay — and then the device
waits until real time reaches it, which is the one case `error_log` still tells it to wait out.

**An envelope claiming an epoch above the relay's is not an epoch hold** (issue #546, item 3).
`pull` used to hold for any `envelope.epoch > group.epoch`, and the relay stores `epoch` exactly as
sent — so anybody holding a token could push `{epoch: 1e12}` and freeze every peer's cursor, its
ack and with them the relay's compaction, for good. `check_keys` now hands `pull` the epoch `/keys`
answered (`KeyCheck::relay_epoch`): an envelope at or below it holds as before; one above it asks
`/keys` once more per pull, for a rotation that landed between this trip's `/keys` and its `/pull`,
and if the relay still has not reached it the envelope is counted unreadable, recorded once and
stepped over. A failed re-ask holds for one trip — a forgery and a mid-trip rotation cannot be told
apart without it, and stepping over a real rotation would lose its first push. An updated relay
refuses the push itself (422 `epoch_ahead`), and one below the group's epoch (409 `stale_epoch`),
which `push` answers with one fresh `check_keys` and a retry re-sealed at the adopted epoch.

**What a hold cannot reach.**

- **A v51 client still drops, and nothing here saves it.** The hold is the receiving client's, so a
  v51 peer pulling a v52 device's page defers its first `deck_token_printings` op and steps past it
  with the sender's later ops in the page — the entries, the conversion's clears recorded after
  them, a step made since, unrelated ops alike — and after it climbs those ops are below its cursor
  and never offered again. It goes on holding the pick and drawing its art, because the clears never
  arrive, and **the pull gate on `convert_legacy_picks` still fails for a laggard that pulled at v51
  during the window** (*A paired device converts behind a pull*, above). **So every device in a
  group is updated before it syncs across v52** — the last crossing that rule is owed for, short of
  a rename (*A table's NAME is on the wire*, above). The loss
  needs an older device to *pull* a newer device's page; one updated before its next pull asks from
  a cursor below that page and applies all of it. From v52 on, a receiver holds a newer sender's
  changes until it upgrades, and the order devices update in costs time and the relay's floor rather
  than data.
- **An entry a v51 peer never received** — announced during the window, or kept by one side after a
  reset made there — turns every later edit to it into a sparse update that peer cannot place, with
  both devices at v52. It deferred and dropped the sender's page from there on; it is **skipped** now,
  one `error_log` row per table, and the sender's later ops apply.
- ~~**A parent deleted on a third device, and applied here on an earlier pull, leaves no
  trace.**~~ **Closed by user schema v54** (2026-09-27,
  [folder deletes across devices](../superpowers/specs/2026-09-27-folder-deletes-across-devices-design.md)).
  It left none because `apply` runs inside `capture::suppressed`, which writes no `del` op, and
  there was no table of tombstones in the other sense — rows saying a parent went — so `gone` could
  not find the delete: the child waited out the bound and was skipped, recorded. Where the key
  cascades that was convergent — the child's own device loses it when the delete arrives there —
  at the price of an `error_log` row that described no fault; ⚠️ where the key is `SET NULL` it was
  not, read off the code and unmeasured: the child's device kept it at the root when the third
  device's delete reached it, and this device had skipped it. The delete now writes a `sync_gone`
  row as it is applied here — the trigger that writes it ignores the apply guard, which is its
  point — so the child lands on the pull that brings it, the way its parent's key answers a
  delete: dropped with it where the key cascades, at the root where it is `SET NULL`, with no hold
  and no `error_log` row (`a_copy_filed_into_a_binder_a_third_device_deleted_lands_at_the_root`).
  **A delete applied here by a build before v54 left no row anywhere and is not recovered** — the
  rung backfills only this device's own `del` ops — so its later children still wait out the
  bound. ~~**Nor does a parent this device never held leave one**~~ — a parent created and deleted
  on the third device between two of this device's pulls folds away here with no row to `DELETE`,
  so no trigger fires. This bullet recorded that as open for part of 2026-09-27, read off the code;
  **it is closed on the same branch**: the delete arm writes the `sync_gone` row by hand for a
  parent-table row it did not find (`apply::tombstone`), so a child another device filed into that
  parent lands on the later page at once
  (`a_child_of_a_parent_a_third_device_made_and_deleted_between_two_pulls_lands_at_once`), and the
  moot arm does the same, on a deciding pass, for a child it never held (the moot notes after the
  table, above).
- ⚠️ **A newer hold that spans a device removal loses everything it held** (the final review's I2,
  read off the code and unmeasured). A removal makes every remaining device forget the superseded
  keys (`identity::supersede` → `forget_superseded`, *One correction to the plan* below). The held
  page is sealed under the epoch before the removal, so once this device has adopted the rotation,
  `pull` cannot open those envelopes and steps over them as unreadable. Whether the cursor then
  advances turns on what the newer device wrote since: new-epoch ops this build can apply are
  applied and the cursor advances; it stays held only while a new-epoch batch still fails to parse
  as newer or a group this build cannot write is held as newer, and those apply after the upgrade.
  **The part sealed before the removal is lost either way**, and any
  other device's collateral held behind it. It is the documented *a removal costs the backlog
  behind it*, now as long as the hold: a hold that lasts until the reader updates can straddle any
  number of rotations, where an ordinary backlog is a few trips. It breaks spec §2's "nothing of
  that device's stream is lost meanwhile" for exactly that case. **What would let the keys be
  kept** is the follow-up already recorded there — the relay refusing a push below the group's
  epoch, so a removed device holding the old key could no longer write under it.

**The two neighbours the review found.** `apply::find_row` renamed a local row to the lower uid
before the group's savepoint opened, without asking whether the uid was free, so a collision's
`UNIQUE (sync_uid)` failure escaped and failed the whole `apply` on every pull. It now answers the
rename it wants, and `write_group` makes it inside the savepoint after `SELECT 1 FROM {table} WHERE
sync_uid = ?`; a taken uid is a row this database cannot build — skipped and recorded, the rest of
the batch applied (`a_uid_rename_onto_a_taken_uid_drops_the_group_instead_of_failing_the_apply`).
The round cap is the other, under *A held op holds the watermark* above.

**What was dropped before this.** Found by reading at token stacks PR 2's final review, 2026-09-26,
and older than that PR: every deferral since the relay was built lost its op and its sender's later
ops in the page, save one the same page resolved — the second attempt in `run_groups`, a parent from
another device's stream further down — which is why "self-heals when the missing parent arrives"
was only ever true inside one page. v33's `deck_labels` rename, `deck_notes` and `deck_note_cards`
at v43, `sticky_notes` at v46 and `deck_token_printings` at v52 each paid it on an older peer, and
upgrading brought none of it back. **Reading older sentences**: where this record, `apply`'s docs,
or the token stacks spec and plan say before 2026-09-27 that an op or a stream "stalls", "defers
for good" or is "held" for the next pull, read *dropped, with the sender's later ops in that page* —
which is still exactly what a v51 client does. From this build on, the table above decides.

### A pile's list is on the wire since user schema v53

Issue [#561](https://github.com/Msgaihede/mtg-grimoire/issues/561) gave `deck_categories` a
`variant`, so a deck's Theory and Actual lists each hold their own piles. `variant` is on the
capture spec, and it is the second term of **both** apply grains —
`deck_id = ? AND variant = ? AND name = ?` and `deck_id = ? AND variant = ? AND kind = ? AND
kind <> 'main'` — so a live "Ramp" and a theory "Ramp" of one deck are two rows on every device,
while two devices that each make a theory Sideboard still merge on the kind grain.
`apply/tests.rs`' `a_plans_pile_never_folds_into_the_decks_pile_of_the_same_name` holds both.

**An op that carries no `variant` binds neither grain**, because `grain_values` answers `None` for a
missing field, and that is deliberate rather than an oversight: an update op carries only the
fields that moved, so a rename op names a pile's new `name` and not its list, and defaulting the
missing term to `'live'` would match a renamed *theory* pile to the live pile of that name. So an
older sender's insert is placed by uid alone and lands on `'live'`, the column's default.

**The rung's clones are named, not minted.** Every device climbs v53 on its own with capture off, so
`schema::theory_pile_uid` derives each clone's uid from its original's, and every device names the
same theory pile the same way without announcing it. **A device still on v52 is the case that
breaks, both ways.** Its writes after a peer climbed file theory cards into the one pile set it
knows, so they reach the climber in a *live* pile — which `deck_meta::refile_stray_theory_cards`
repairs, captured, behind every advancing pull (and at launch on an unpaired device or once a pull
at v53 has landed), making the plan pile under the derived uid so every device that repairs the
same stray converges on one row. What the climber sends, the v52 device misreads: it ignores
`variant`, so a theory pile's insert matches the live pile of that name on its `(deck_id, name)`
grain and the two merge under one uid there. Nothing a v53 build ships can reach a v52 applier,
**so every device in a group is updated before it syncs across v53**, the rule v52 set for its own
table.

### The two `CHECK`s differ and the applier knows it

`collection_entries.quantity` is `CHECK (quantity >= 0)` and clamps: a stepper taken to zero is a
real state there, and the row keeps its condition, its price and its acquisition story.
`deck_cards.quantity` and `wishlist_entries.quantity` are `CHECK (quantity > 0)`, so a row taken
to zero **goes**. Two devices each removing one copy of a two-copy deck card end with the card
gone rather than with a constraint failure, which is the case no single device can reach: no
device can *store* the zero this arithmetic produces.

### The sentences

Both are Rust's, following `reconcile.rs` — that column already holds Rust-written sentences, and
one column with two conventions is worse than either. **The first message wins**: a resurrection
does not overwrite a sentence the reconciler already wrote about a printing that left Scryfall.

- `apply::RESURRECTED` — "Another device deleted this while this one was still changing it, so it
  was kept."
- `apply::CYCLE_BROKEN` — "A folder move on another device would have put this folder inside
  itself. It was moved to the top level."

---

## The envelope, measured

`sync_engine::wire`. Six fields cross the network and **the relay sees nothing else**: `group`
routes it, `device` and the two clock fields let the Durable Object order and compact without
decrypting anything, and `sealed` is opaque. The op count is deliberately absent — "this device
wrote 431 things today" is not needed in order to relay — and a test asserts the JSON has exactly
those six keys.

The AAD is `group\0device\0epoch`, and **binding the epoch is what makes revocation mean
something on the wire**: rotating the group key already stops a removed device reading anything
new, and the epoch binds a blob to its own epoch's key, so it opens under that key or not at all.
Whether a device that has moved on still opens a blob from before the rotation is then a question
of which superseded keys it keeps — across a join it does, across a removal it keeps none (*One
correction to the plan*, below). Removing any one of the three terms turns a test red.

**`BATCH = 200`, derived from the write limit and checked against the row cap**, not the other
way round. Measured 2026-08-28 with 200 realistic `collection_entries` ops — every field
populated, a real note, a folder uid:

| | |
| --- | --- |
| plaintext JSON | **139 601 B** (698 B/op) |
| sealed + base64url | 186 188 B |
| the whole stored row | **186 299 B** |
| against the Durable Object per-row cap | 2 MB — **9%** |

The spec quotes 453 B/op and 90.6 KB per batch. That is the *average* op; a fat one is 698 B and
the cap is still not the binding constraint. A 50 000-row bulk import is **250 stored rows**
against a 100 000 rows/day limit.

**Bytes bind too since issue #546, because a note has no length cap.** `wire::batches` cuts at 200
ops *or* `wire::BATCH_BYTES` (512 KiB of the JSON `seal_batch` seals, the `schema` stamp and the
list's commas counted), whichever comes first. A full byte budget seals to 699 104 characters,
under half the relay's `MAX_SEALED_CHARS` (1 500 000, which `wire.rs` holds to `relay/src/log.ts`
by an `include_str!` test), so no batch of several ops is ever what the relay refuses; an ordinary
200-op batch is ~90 KB, so the count still decides the cut and the arithmetic above stands. An op
over the budget goes alone, up to the cap itself — 1 124 958 bytes of JSON. **Past that it can
never be sent** (`wire::oversized`, computed from the plaintext length as ⌈4(n + 24 + 16)/3⌉ and
checked against a real seal): before, one such op failed its chunk on every trip and `push`
stopped there, so everything queued behind it never reached the relay. Now it is recorded once in
`error_log` — the table, the row's uid, the size, "kept on this device" — stamped `pushed_at` and
stepped over, the one exception to "stamped only on a 200"; a baseline leaves such a row out the
same way and still sets its marker. What it costs is that change on the other devices, which is
the only honest answer to a paste in the megabytes.

**A refusal that will not change on the next try defers the push; it no longer ends the trip.**
`too_large`, `quota`, `clock_ahead` and `epoch_ahead` (`client::Deferral`, matched on the body's
`code`) are recorded, nothing after the refused chunk is sent, the ops stay pending — and the trip
goes on to pull and ack. Before, `round_trip`'s `push(..)?` ended every trip at such a refusal, so
the device stopped reading as well as writing and, on `quota`, held the relay's compaction floor at
its last ack: a full group could never drain. A baseline is skipped behind `quota` or
`clock_ahead`, since a chunk refused part-way re-sends every chunk before it on the next trip.
Network failures, a 5xx and an unreadable answer still fail the trip, as they always did.

`base64` joined the tree for one job. Hex was the alternative and is twice the bytes over the
wire and against that cap; base64 is four thirds and URL-safe.

---

## The relay: five group routes, three of them behind an auth gate

`relay/` is a Cloudflare Worker with one SQLite-backed Durable Object per pairing group.

| | | | |
| --- | --- | --- | --- |
| `POST {relay}/g/{group}/push` | one `Envelope` | 200 with the stored cursor; refused with a `code` — see below | **bearer** |
| `GET {relay}/g/{group}/pull?since={cursor}&device={id}` | | 200 with `{ envelopes, cursor }` | **bearer** |
| `POST {relay}/g/{group}/ack` | `{ device, cursor }` | 204 — what compaction reads; a departed device's is not stored | **bearer** |
| `POST {relay}/g/{group}/rotate` | `{ epoch, auth, keys }` | 200 with the epoch, for one past the group's (a join) or two past it (a removal or a departure); 409 behind or equal; 422 further | the group's current auth, and nothing else |
| `GET {relay}/g/{group}/keys?device={id}[&epoch={n}]` | | 200 with `{ epoch, blob, devices, removalStep }` — with `epoch`, that epoch's manifest, or 404 `no_such_epoch` | any auth this group has used within eight epochs |
| `POST /g/{group}/roster` — **internal** | `{ epoch, devices }` | 204 | built by the Worker after an accepted rotation; not on the public pattern, a 404 from outside |

**`/rotate` and `/keys` are `/g/…` routes that stand *ahead* of the bearer gate, and the placement
is the point rather than an exemption.** A device that has just been rotated away from cannot mint a
token — the auth it would present to `/token`'s group door is stale by definition — so a `/keys`
behind the gate would refuse exactly the caller it exists to serve, and a removed device would sit
for ever in a group it is no longer in. **Every refusal either makes is decided in the Worker, out
of D1, and none reaches the Durable Object**, which is what makes standing outside affordable: the
gate is in front of the DO because a request that reaches one costs a Durable Object request
whether it is honoured or refused. `/keys` never reaches it. `/rotate` reaches it exactly once,
**after D1 has accepted the rotation**, to post the roster — and a caller that gets that far holds
the group's current auth, which mints a bearer token at the group door and opens the gated routes
anyway, so it can spend nothing there it could not already spend. The residual — a removed device
spending `/keys` reads until its auth ages out of the eight-epoch window — is accepted for the same
reason.

**An accepted rotation tells the log who is left, because nothing else could.** Compaction keeps
every row some device has not acked, and "some device" was every device the object had ever heard
from — so a removed device's last ack held the floor for as long as the group lived, and a
departure or a wiped reinstall did the same. The manifest lives in D1 and is written by `/rotate`,
so that is the one place that knows the set changed: `sendRoster` posts `{ epoch, devices }` to the
object's internal `/roster`, which marks every device it knows and the list omits as departed and
forgets its ack, un-marks every device the list names, and compacts. A roster is applied only if
its epoch is newer than the last one applied, since two rotations accepted back to back post two
rosters nothing else orders; the post is best effort, and the rotation's 200 stands if it fails.
**Beside it, a device unheard for ninety days leaves the floor too** — every ack stamps `heard_at`
and a pull refreshes it at most daily, because a device holding its cursor pulls without acking —
which is the reinstall no manifest will ever name. [relay/README.md](../../relay/README.md) has the
object's side in full, and *What is still owed* the three gaps it leaves.

**A push is admitted in the Worker, after the gate and before the object**, for the gate's own
reason — none of these needs the object's state to refuse, so none should cost an object request.
In order: a body past 1 504 096 characters, declared or read, is **413 `too_large`**; one that is
not JSON or not an envelope is the object's old **400**, without a code; `sealed` past 1 500 000 is
**413 `too_large`**; an epoch below the group's — its newest `group_keys` row, one D1 read, and
not `entitlements.group_epoch`, whose mirror follows the rotation's insert in a second statement
that could fail and would then refuse every push at the epoch the group has really reached — is **409
`stale_epoch`**, and above it **422 `epoch_ahead`**; an `hlcMs` more than a day past the relay's
clock is **422 `clock_ahead`**. The object keeps one check of its own: a log that this push would
take past 128 MiB of `sealed` is **507 `quota`**, and it compacts before refusing — a full group
moves no head and acks nothing, so no other path would ever compact it again. `stale_epoch` is what stops a removed device
writing under the key it was removed from for the day its token outlives the rotation;
`epoch_ahead` is what stops one envelope at `{ epoch: 1e12 }` freezing every peer's cursor on keys
to an epoch that will never exist. A group with no key rows — claimed before `group_keys` and
never seeded or rotated since — skips both. Clients match on `code`, never on the sentence.

**`/rotate` takes one epoch or two, and the refresh secret dies with its device's place in the
group.** A join plans its own epoch plus one and a removal or a departure plus two, and a device
presents the auth of the epoch it stands on, which is current only if that is the relay's — so no
shipped client sends anything further, and anything further is a **422**. **The step is the
authenticated join/removal marker**: the rotator binds the epoch into every rewrapped blob, so a
relay that passed a removal off as a join would be handing out blobs that do not open, and a device
adopting a `+2` forgets every superseded key whatever the manifest's `devices` say. The app plans a
`+2` only after `/keys` has answered `removalStep: 2`, and latches it; a relay without the step
never says so, and goes on receiving the `+1` it accepts. **`/keys?epoch=n`** is the other half: a
device that stood on *N* and was answered *N+2* asks for *N+1* by name, and a **404
`no_such_epoch`** — the usual answer, since a removal steps over it rather than writing it — tells
it there was nothing there to open. Beside the epoch rule, `/claim` mints a fresh secret on every
press and records the claiming device in `entitlements.refresh_device`, and an accepted rotation
whose manifest omits that device sets both to NULL. **They close one hole between them,
with a third change**: a lost laptop that pressed Connect and was then removed keeps whatever its
`user.db` holds, and `/rotate` used to accept the refresh secret — so whoever held that file could
publish `{epoch: 1e9, keys: {}}`, every remaining device would read a higher epoch with no blob for
itself, and `check_keys` would take each of them out of the group. **`/rotate` now takes the
group's current auth and nothing else**: no shipped client ever presented the secret there
(`client::post_rotation` always sends the group auth), and a removed laptop still logged into
Patreon could otherwise press Connect, be handed a fresh secret recorded against itself, and
publish a manifest naming itself back in. The retirement still matters for `/token`'s refresh
door, where a removed device's secret would otherwise go on minting tokens for the group. A secret
with no recorded holder — every row claimed before the column existed — is retired by the next
accepted rotation. `/claim` is held to the same epoch rule from the other side: a group that has
key rows is seeded only at its own epoch and only with the auth already registered there, so a
claim can neither skip it ahead nor swap in an auth of its own. **Issue #752 adds a current-auth
gate before a claim can mint a grant at all**; the gate is described below and awaits a relay
deployment.

**A device that only ever uses the group door is now told of a lapse** — a gap older than all of
this, fixed with issue #546. The relay answered a lapsed membership on the group door with the
same bare 401 a stale auth gets; `entitlement::STALE_GROUP_AUTH` read both as the second, so a paired device
whose membership ended went on reading its last stored status — *Supporting since …* — until
something else cleared it, and only the device that pressed Connect was ever told, through its
refresh door and `entitlement::refused_secret`. **Now the group door's 401 carries `code:
"membership_ended"` when the auth presented is the group's current one and the membership has
settled dead**, and `sync_engine::entitlement` revokes on the code, so the panel draws *Membership
ended*. It is safe for the relay to say because only a device holding the group key can derive
the current auth — the caller has already proved it is in the group. **A stale or wrong auth is
still a bare 401 and still `STALE_GROUP_AUTH`**: the relay cannot tell a device behind a rotation
from one that was removed, and a removed device must learn nothing about the group it left. It
takes both halves — until this relay is deployed the live group door's 401 is bare, and a device
there still reads it as stale.

### A second Worker binds the same D1 and the same secret

**`share-worker/` is not on this list and never will be** — it is a separate Cloudflare Worker
for blast radius, added 2026-09-08 for read-only shared collections. What it shares with the
relay is the **D1 database** and the **`RELAY_HMAC_KEY`** secret, so it verifies a token the relay
minted without a service binding; `relay/`'s source and its deploy are untouched by it. Two
consequences reach this page: **publishing is gated by the same bearer token sync mints**, so a
share is an entitlement of the *group* exactly as everything else here is; and **its lapse pass
reads the `status` the relay's own `reconcile` wrote and never re-runs `decide`**, because one
account with two opinions about when a membership ended is the failure that arrangement exists to
avoid. **It is deployed since 2026-10-01** and nothing has been published through it —
[collection-sharing.md](collection-sharing.md) is the record, and *ask the host* applies there
exactly as it does here.

### The rendezvous: outside the gate, same reasoning, a different namespace

Added 2026-08-31, and not a `/g/{group}/…` route at all — `/p/{rv}/{slot}`, keyed on a pairing
attempt rather than on a group, because the group a pairing produces may not exist yet.

| | | | |
| --- | --- | --- | --- |
| `POST {relay}/p/{rv}/{slot}` | `{ blob }` | 204; **409** if that slot is already filled | none |
| `GET {relay}/p/{rv}/{slot}` | | 200 with `{ blob }`; 404 if empty | none |

`slot` is `join` (B's response, written by B, read by A) or `offer` (A's sealed key, written by A,
read by B). **These stand outside the bearer gate for the identical reason `/rotate` and `/keys`
do, one step earlier in a device's life**: B is not in the group yet and cannot derive a token by
construction, so a rendezvous behind the gate would refuse exactly the caller it exists to serve.
Both are D1 only and **never reach a Durable Object**, which is what makes standing outside
affordable here too — nothing either route can be made to spend is on the metered line.

**Unlike `/rotate` and `/keys`, nothing here authenticates at all**, so the exposure is bounded
four ways instead: `rv` must be 32 lowercase hex characters — `crypto::rendezvous_id`'s own output,
a one-way HKDF derivation of the pairing's one-time token that the relay could not invert even if
it wanted the key the token salts — a blob is capped at 2048 characters (9× the 224-character
sealed key, the largest blob ever measured), one `rv` holds at most two rows, and every row expires
in ten minutes on the same cron that sweeps the rest of the schema. A `POST` to an already-filled
slot answering 409 is what stops anyone who photographed the QR from overwriting B's answer after
the fact — they can only get there first, which the reader sees immediately because the six digits
on the two screens then disagree.

**Two relays are described in this section and telling them apart is the first thing to do.** The
**baseline relay** is push, pull and ack with no authentication at all — and it is deployed,
driven and measured: "The first end-to-end pass" below is two real devices converging over it. The
**hosted relay** is what
[the hosted relay design](../superpowers/specs/2026-08-29-hosted-relay-and-patreon-design.md)
adds on top — the auth gate, `/claim`, `/token`, the Patreon callback, the webhook and the D1
entitlement table — plus, since 2026-08-30, `/rotate`, `/keys` and `/token`'s group door.
⚠️ **This paragraph said "all of that is written and none of it is deployed" until 2026-08-30,
and it was wrong in both halves by the end of that day.** The hosted Worker is deployed at
`RELAY_BASE` and the two relays no longer share an address so much as an address that has moved
on: the hosted design *replaces* the code behind it rather than standing beside it. Probed
2026-08-30, after the deploy: `/claim` and `/token` **405** to a GET (the route is there and wants
POST) and **400** to an empty POST body, `/g/{group}/pull` **401** from the bearer gate,
`/g/{group}/rotate` **401** to a POST, and `/g/{group}/keys` **401** to a GET carrying a
well-formed bearer — which is the runbook's own pass criterion for `group_keys` existing, since a
missing table answers 500 there. `/g/{group}/bogus` **404**, so a 404 on this host still means
"no such route" and the 401s are not a router accident.
`relay/src/index.ts` carries the auth gate and a push's admission, `admit.ts` every refusal a push
can meet, `claim.ts` and `patreon.ts` the OAuth hop, the webhook and the reconciliation,
`token.ts`, `entitlement.ts` and `md5.ts` the pure decisions the root vitest tests without workerd,
`groupauth.ts` and `rotate.ts` the group-key store, its two routes and the device roll, `group.ts`
and `log.ts` the object and who its floor waits for, and `wrangler.jsonc` a D1 binding and an
hourly cron — `0 * * * *` since issue #546, `0 3 * * *` before it.
**The device cap, `/claim`'s rebind and the `group_devices` table are deployed too**, and so are
the pairing rendezvous and the refresh-secret change — and since 2026-10-01 issue #548's `dev`
claim and, from that day's last deploy at 22:09 UTC, rate limits on the five routes a caller
reaches with no token. Settled by the same kind of probe rather than by reading this file:
`POST /token {"refresh":"x"}` **with no `device` field** answers **400 `that is not a device id`**,
and **401** once a `device` is added. ⚠️ **This paragraph called that half undeployed until
2026-09-28**, on a `{group, auth}` probe whose short `auth` is refused as `malformed` before
`device` is read — a probe that answers the same on either build.
**Issue #546's half is deployed too** — the push admission, `/keys?epoch=` and
`removalStep`, the two-epoch removal, `/roster`, the hourly reconciliation and `membership_ended`.
Its tell is a query: `/g/{group}/keys?device=…&epoch=x` with any well-formed bearer answers **400
`that is not an epoch`** from this tree and **401** from a Worker that ignores the parameter.
**Probed 2026-10-01: 400.** ⚠️ **This paragraph said "what is not deployed" until then** — the
deploy was 2026-09-28 at 19:57 UTC and went unrecorded, and the probe had never been run.
**The rest of this section describes the hosted design in the present tense**, which is how this
repository writes a design that is agreed and not yet a deployment; where a sentence is about what
has actually run, it says so. [hosted-relay-deploy.md](hosted-relay-deploy.md) is the runbook and
the list of what only a deploy can settle.

**The relay cannot decrypt anything it stores**, and that is still the load-bearing fact. The
group key is minted during pairing and lives only on the paired devices; what the relay holds is
ciphertext, a cursor and a 128-bit group id it never learns the meaning of. That is what the
encryption buys and the gate below does not: if the guard failed completely, a stranger with a
group id would still find only ciphertext, and could only append rows no device can open.

**Every one of the three metered routes carries `Authorization: Bearer <access>`, verified before
the Durable Object hop** — push, pull and ack, and `/ws` when it exists. ⚠️ **This said "every one
of the three" of three total until 2026-08-30**, when `/rotate` and `/keys` joined the `/g/…`
namespace outside the gate; the sentence is about what reaches a Durable Object, which is what the
gate is for. ⚠️ **Corrected 2026-08-29**: this section used to say there was no authentication
and that the 128 random bits were the whole guard. That was true while each reader deployed their
own Worker and paid their own bill, and it stops being true the moment one deployment serves
everyone — the guard now has to keep a stranger from spending *Markus's* quota, not only from
reading ciphertext they cannot open. It does not have to keep them from reading the data, because
the key already does that and the relay was never handed it. **That is why none of this needs an
account with the relay**: the token answers only *may this request cost a Durable Object*, and
the relay keeps no directory of readers — one entitlement row bound to one group id, and nothing
that a reader logs into.

`access` is `base64url(payload) "." base64url(HMAC-SHA256(payload, RELAY_HMAC_KEY))` over
`{sub, grp, exp, dev}`, minted by the relay with a 24-hour TTL. `dev` — the device that presented
itself to the door — was added on 2026-10-01 and is read only by the share Worker, which refuses a
token minted before the group's newest rotation by a device that rotation's manifest omits
([collection-sharing.md](collection-sharing.md), issue #548). The relay checks signature, expiry
and `payload.grp` against the path segment with **zero storage reads**, so a junk request is
refused in microseconds and **never bills a Durable Object request** — which is the line that
actually costs money. What mints the token is a Patreon membership resolved server-side;
[the hosted relay design](../superpowers/specs/2026-08-29-hosted-relay-and-patreon-design.md)
holds the claim flow, the lapse rules and the secrets that must stay out of this repository —
**three of them**. §9 listed four until 2026-08-29 and says three now; the correction below
records why.

### The group door: an entitlement belongs to a group

**`POST /token` has two doors, and which one a device uses is decided by what it holds.**

| Body | Who sends it | Answer |
| --- | --- | --- |
| `{refresh, device}` | the device that pressed Connect | `{access, refresh, expires, status, since}` |
| `{group, auth, device}` | **any device in the group** | `{access, expires, status, since}` — **no refresh secret, ever** |

⚠️ **`device` is required on *both* shapes since 2026-08-30, and the refresh door is the one it
would have been easiest to leave off.** The device that pressed Connect never reaches the group
door, so a cap that counted only the group door would never count the one device that is certainly
signed in — and the reader's own words for the limit were *"this goes for accounts inheriting the
sign-in from another grouped device too"*, which only means something if the device that did
**not** inherit is counted as well. Required rather than used-if-present, because a field the
relay merely reads when it is there is a cap any caller opts out of by omitting it: both doors
answer **400 `that is not a device id`** to a body without one, before any lookup.

The group door looks the entitlement up by `group_id`, compares `auth` against the stored one in
constant time, settles the status exactly as the refresh door does — a closed grace window is
*resolved* here, not merely reported — and mints the same token.

**`auth` is one-way from the group key, so nothing has to be distributed to make this work:**

```
relay_auth = HKDF-SHA256(
    ikm  = group_key,                                   -- 32 bytes, never leaves the devices
    salt = group_id,
    info = "mtg-grimoire/relay-auth/v1|" || epoch,
)                                                       -- 32 bytes, sent as lowercase hex
```

`crypto.rs` already carried `Hkdf<Sha256>` for `pair_key` and `sas`, so this is a third `INFO_`
constant beside those two and no new dependency. **The epoch is in the `info` even though the key
already changes with it** — belt and braces: a group key that was ever reused across two epochs,
by a restore-from-backup or by a bug, would otherwise yield one auth for two epochs, and the
monotonic check on `/rotate` is the only thing standing between a removed device and re-entry.

**This is what makes an entitlement a property of the group.** Before it, a second device was
entitled only because the pairing blob carried the refresh secret across, and the natural order —
pair first, connect second — left that device with nothing and no way ever to get anything:
reaching the relay needed a token, a token needed the secret, and the secret travelled only in a
blob that had already been carried. The loop was closed and nothing in the app said so. Now any
paired device mints its own token, so *"if a group has any device signed into Patreon, all the
devices in the group are valid"* is a property of the protocol rather than a thing pairing
happened to carry. **The cost, stated plainly:** a freshly paired device draws *Supporting since
…* after its first relay call rather than instantly, because `status` and `since` have no local
source. `SyncPanel` re-reads the supporter query when a round trip finishes, so the window is one
sync.

**The two doors fail differently on the same status code, and that is the sharpest thing here.** A
401 on the refresh door says the *secret* is dead, which is not the same as the membership: every
`/claim` mints a fresh secret, so a Connect press on one device leaves another holding one the
relay will never accept again. So `entitlement::refused_secret` drops the secret and asks the
group door — which mints for a superseded secret, and refuses a lapse too, because the relay's
revocation marks the row `dead` and leaves its group auth in place. Only both refusals revoke the
grant and offer Connect again. A 401 on the **group** door alone is `entitlement::STALE_GROUP_AUTH` and is *not* a lapse — the auth is
derived from the group key, so a rotation this device has not caught up with produces exactly the
same refusal a cancelled membership does. Revoking on it would tell a reader their membership
ended because a sibling device removed somebody an hour ago. The two are told apart out of band:
the caller asks `/keys`, which accepts an auth up to eight epochs old, and learns which it is.

**What the relay learns from all this, and what it still cannot.** It learns a hex string per
group per epoch that is one-way from a key it does not hold, and a pile of blobs sealed to X25519
keys it does not hold either. It still decrypts nothing — the group key is minted during pairing
and lives only on the paired devices — and it still keeps no directory of readers: one entitlement
row bound to one group id, and nothing anybody logs into.

**Two D1 tables carry it, because they answer two different questions.**

```sql
-- What the group is at RIGHT NOW. One row per entitlement, read by /token's group door.
ALTER TABLE entitlements ADD COLUMN group_epoch INTEGER;
ALTER TABLE entitlements ADD COLUMN group_auth  TEXT;    -- hex, the current epoch's

-- The history, and the rewrapped keys. One row per (group, epoch), read by /keys.
CREATE TABLE IF NOT EXISTS group_keys (
  group_id   TEXT    NOT NULL,
  epoch      INTEGER NOT NULL,
  auth       TEXT    NOT NULL,          -- that epoch's relay_auth
  keys       TEXT    NOT NULL,          -- {"<device_id>": "<blob>", …} — the manifest AND the
                                        -- key distribution in one column; its key set is the
                                        -- roster at this epoch
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, epoch)
);
```

**The history exists so that a device which is merely behind can still fetch the key that catches
it up.** Its auth is one epoch stale by definition, so an endpoint that accepted only the current
one would refuse exactly the devices it exists to serve. `/rotate` prunes anything older than
`EPOCH_HISTORY` — **eight** epochs — in the same batch that writes the new row, so the history
is bounded without a sweep. **Epochs, not rows**: a removal steps over one, so a run of removals
keeps four rows, and a device dark across three of them still reaches `/keys` where a fourth
refuses it — at one step per rotation it survived seven of any kind. **A manifest is capped at
`MAX_GROUP_DEVICES` and 4 KB per blob.**
⚠️ **That cap was 64 until 2026-08-30**, which was a bound on what the relay would store rather
than a policy; it is `groupauth.ts`'s five now, imported by `rotate.ts` rather than spelled a
second time — a cap written twice is a cap that eventually disagrees with itself, and the two
spellings would be a rotation the relay accepts naming more devices than the relay will admit. The
4 KB stays what it was: `keys` is written whole into a single D1 column, so an unbounded object is
an unbounded row, and it is a ceiling that says "something is wrong" rather than a budget.

**`/claim` is the only place a group's first auth can come from.** It carries `epoch`, `auth` and
`device` as body fields beyond `code` and `group`, writes the first two onto the entitlement and
seeds `group_keys` with an *empty* manifest at that epoch. That is what "no membership, no
removal" rests on: `/rotate` authenticates against a row only `/claim` can seed, so an unentitled
group has no way to publish a rotation at all.

⚠️ **`seedGroup` refuses a *stale* epoch, and `INSERT OR IGNORE` alone did not — fixed
2026-08-30.** `group_keys` is keyed `(group_id, epoch)` rather than `group_id`, so a device
re-claiming **its own** group while it is *behind* conflicted with nothing: it inserted a second
row at its own older epoch and then re-pointed `entitlements.group_auth` at an auth derived from a
key the group had already rotated past. Every device that *was* caught up then failed
`authIsCurrent` — a 401 on the group door — until somebody rotated again, while the stale row was
meanwhile accepted by `authIsRecent`, so the one device that should have stopped was the one that
kept working. **Both statements now carry the same guard — a group that has key rows is seeded
only at the epoch it is standing on, and the mirror moves only to the auth that epoch's row
already holds — and both halves are load-bearing**, since dropping either one alone turns a test
red. Ahead is refused for `/rotate`'s reason (a row at `max + 1` with an empty manifest is a
removal notice to every device), and a foreign auth at the group's own epoch is refused because
it would make the claimer's auth current. `entitlement::claim` sends the device's own current
epoch and the auth it derives there, so a caught-up device's re-claim changes nothing and loses
nothing. A group with no rows at all still takes any epoch.

**That seed guard protected the keys but still let a removed device mint a grant — issue #752.**
A device behind the current epoch could press Connect with its old auth, leave the keys untouched,
and receive a fresh refresh secret and token. The share gate accepts a token minted after a
rotation because the relay's current-auth door is supposed to be the only way to obtain it; a
stale claim broke that assumption and restored the removed device's publishing access.

**The relay source now requires `authIsCurrent` for a target group with key rows** (2026-10-05).
A stale claim returns a plain **401** before consuming its claim code or changing the entitlement
binding, refresh secret, device roll or key rows. Wrong auth is refused, while `seedGroup` still
prevents writing future epoch rows; a group with no key rows keeps the initial seed behavior.
A legitimate device behind a rotation must catch up through `/keys` and then retry Connect with
its current epoch and auth; a removed device receives no blob for itself and cannot satisfy the
gate. An initially stale claim leaves its code available for that retry until ordinary expiry.
**A removal racing the claim is fenced too:** the binding write checks that the authenticated
epoch and auth are unchanged, and an existing group's token is stamped before the auth check,
so a removal after a successful write still makes the share gate treat it as a pre-removal token.
If the rotation overtakes the initial check, the code may already have been consumed when the
binding write refuses the claim. **This source fix awaits a relay deployment**; it is
not a claim that the hosted relay already enforces the gate.

### A re-claim moves the binding, because leaving would otherwise strand the payer

**The dead end, in the order a reader meets it.** The paying device leaves its group — which the
departure above makes an ordinary thing to do. Its entitlement is still bound to the group it
left. It pairs elsewhere or founds a group of one, presses Connect, and `handleClaim` answers
**409 — that membership is already bound to another sync group**. There is no press that helps and
no way back short of editing D1 by hand.

**So since 2026-08-30 a re-claim onto a *different* group moves the binding rather than refusing
it**: bind the new group, `seedGroup` it, and then release the old one — `releaseGroup` deletes its
`group_keys` rows, calls `forgetGroup` for its `group_devices` rows, and drops the Durable
Object's log last, because a DO that cannot be reached must not cost the two deletes that free the
slots and retire the key.

**The invariant the 409 was actually protecting is kept.** Trust-on-first-use existed to stop one
subscription serving two groups at once, and *moving* a binding leaves the subject serving exactly
one. Only the first stops being the latest.

⚠️ **The 409 survives, and what changed is which case it is for: another *subject* holding this
group id.** That is a shared subscription wearing two names, which is what
`entitlements_group` is really about, and it is still caught from the unique violation rather than
by a question asked first — D1 has no interactive transaction, so a `SELECT` and then an `UPDATE`
is two round trips with a window between them. **That unpredictability is exactly why the bind
happens first and the teardown after.** A teardown-first ordering would destroy the reader's
working group on the way to refusing the press that asked for it, and a refusal must destroy
nothing. The `UPDATE`'s `WHERE` is a compare-and-swap on the binding this request read
(`previous`, spelled `(group_id IS NULL OR group_id = ?)` because SQL's `=` is never true against
a NULL), so a second claim racing this one finds the row already moved and changes nothing.

⚠️ **The cost, stated rather than discovered: a re-claim silently orphans whatever devices remain
in the old group.** Their manifest and their log are gone and they fail their next key check. They
are *already* orphaned when the payer has left, and for that reader this tells them nothing new —
but a reader who re-claims **without** leaving can do this to a working group by accident. That
reader is the whole audience for `SyncPanel`'s `RECLAIM_WARNING`, which is why it is drawn beside
the **claim-code field** rather than beside *Connect Patreon*: opening a browser moves nothing, and
the claim is the write.

### Five devices to an account, and one table that answers both caps

The reader asked for five devices per Patreon account *and* five per group. **They are the same
count asked twice**, because a subject is bound to exactly one group and a re-claim *moves* that
binding rather than adding a second — so there is no arrangement in which a subscription's devices
and a group's devices are different sets. One constant, one table, both questions.

```sql
-- The device roll. Read by /token's two doors, /claim, and /rotate.
CREATE TABLE IF NOT EXISTS group_devices (
  group_id   TEXT    NOT NULL,
  device_id  TEXT    NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (group_id, device_id)
);
```

**There is no second index on it, and that is a decision rather than an omission.** SQLite builds
one for a rowid table's `PRIMARY KEY`, `group_id` is its leading column, and `(group_id, device_id)`
*covers* every read here — each is `WHERE group_id = ?` or that plus an equality on `device_id`. A
`(group_id)` index would serve nothing and would cost a second b-tree write on every `/token`,
which is the hottest route the relay has.

`MAX_GROUP_DEVICES = 5` and `DEVICE_TTL_MS = 90 days` live in `groupauth.ts` beside
`EPOCH_HISTORY`, with four functions over the table: `liveDeviceCount` (prune, then count),
`admitDevice` (one `INSERT … SELECT … WHERE <count> ON CONFLICT DO UPDATE SET last_seen`, the count
inside the statement so that devices arriving together cannot all read four, and a *returning*
device never trips the cap), `keepOnly` (delete the rows a manifest does not name) and
`forgetGroup` (empty one group, for the rebind above).

**`admitDevice` is called last on all three paths** — after the status has settled to something
that would be served — so a membership on its way to a 401 never spends one of the reader's five
slots, and the reader who *is* serving and has simply run out of devices is told that rather than
being told they had stopped paying. On `/claim` it is called after `seedGroup` as well, which
matters on exactly one path: re-claiming a group that already holds five devices from a wiped
reinstall. Seeding first leaves that group able to rotate, which is how the reader frees a slot;
refusing ahead of it would leave a bound group with no registered auth and every retry refusing in
the same place for ever.

**The relay is the fence and the client is the message.** This repository is public and readers
build it, so a cap that lived only in `pairing::confirm` would be a suggestion — and the point of
a device limit is precisely the case where somebody has reason to exceed it. What the client-side
`identity::room_for` buys is that a reader meets the limit at the press rather than at a sync
three minutes later. `complete`'s copy of the check is weak by construction and says so: a joining
device cannot know the group's size, so on a first join its roster is empty and the check refuses
nothing. The initiator's `confirm` is the meaningful client-side refusal.

**A slot frees through the manifest, which is already the roster.** `/rotate` calls `keepOnly`
with the manifest's key set, so a removal *and* a departure each free their slot with no new
mechanism — both publish a manifest. `keepOnly` runs **after `recordRotation` succeeds and below
the authorisation check**: only-after-the-record is what stops a refused rotation freeing
anything, and below-the-401 is what stops any caller emptying the device roll of any group id they
can name.

**And a last-seen ages out what the manifest never mentions.** A device whose data folder is wiped
mints a *new* id at `identity::ensure`, so its old row is named by no manifest and freed by
nothing: five reinstalls would exhaust a reader's own account permanently, with a hand edit of D1
the only way out. A row unseen for `DEVICE_TTL_MS` is not counted and is pruned when the count is
taken. **Milliseconds rather than days, because every clock on the relay side is already one** —
`decide` takes a `nowMs` and `GRACE_MS` is one, and a second unit here would be a conversion
somebody eventually forgets. Ninety days is chosen against the case it must not break: a laptop
put in a drawer for a season and brought back should find its slot where it left it.

⚠️ **A 403 is not always the cap, and reading the status alone gets this wrong.** `/claim` answered
403 to *that membership no longer exists* and to *that membership is not active* long before a
device limit existed, so an app branching on the status alone tells a reader whose pledge has
lapsed that they already have five devices — the wrong sentence about the wrong problem, sending
them to remove a device instead of to renew. **So the relay stamps `code: "device_limit"` on the
three refusals that really are the cap, and `entitlement::access_token` matches the code and never
the sentence**, which is copy and free to be improved. Both sides pin the literal —
`claim.ts`'s `DEVICE_LIMIT` and `entitlement::DEVICE_LIMIT` — because nothing at either end can
see the other. **Neither suite could catch this**: each asserted its own half and both were green,
and it was found by an agent reading the other side's file. It is the fourth defect in two PRs
that crossed a language boundary no test spans, after the epoch guard above, the pairing blob's
field order and the seconds-versus-milliseconds unit. **The pattern, not the entry: a constant
that has to be equal on both sides of the wire is a defect neither suite can see, and pinning the
literal in both files is the only fence there is.**

**A 403 must never be routed through the 401 path** on the app side. That path calls
`entitlement::revoke`, which sets the mark `membership_ended` reads, so a sixth device would be
told its membership had ended.

⚠️ **One new failure follows from that and is worth stating rather than fixing.** A paired group
with *no* membership now errors on every **Sync now**: `/keys` authenticates against those same
rows, so an unclaimed group gets a 401 there before `access_token` can answer
`STALE_GROUP_AUTH`. It is one folded `error_log` row per grain, and it follows from the design.

Compaction, the 30-day tail and the pull ordering are pure functions in `relay/src/log.ts`,
tested by the root vitest. **`since` orders by `(hlcMs, hlcCtr, device)` and not by arrival**, and
**a device with no ack at all holds everything** — a group whose third device has never connected
keeps its log rather than compacting away the state that device has not seen. **Two kinds of
device stop holding it**, since issue #546: one a rotation's roster omitted, and one unheard for
ninety days — both used to be the slowest reader the group had, for good.

**The baseline relay is deployed, and Markus deployed it.**
[The baseline design](../superpowers/specs/2026-08-29-sync-baseline-design.md) §1 records a live
pass on 2026-08-29 — a desktop holding 275 entries and a OnePlus 12 holding none, "both pointed
at a deployed relay" — and "The first end-to-end pass" below is that same relay driven to
convergence. ⚠️ **"Nothing is deployed" is history, corrected 2026-08-29**; it was contradicted
twice inside this document before it was corrected here. ⚠️ **This paragraph then said "that is
the only relay that has ever run" and that the hosted Worker "has never been deployed and its
Worker has not been written" — both false, and both corrected 2026-08-30.** The baseline pass is
still the pass it was: two real devices converging over the unauthenticated three-endpoint Worker,
pointed at by hand through `sync_state.relay_url`. What is no longer true is that nothing else has
run — the hosted Worker is deployed at the same address and answers `/claim`, `/token`,
`/g/{group}/rotate` and `/g/{group}/keys`, probed the same day. **What has not changed is who
created it: nothing on Cloudflare is provisioned by an agent.** When a resource is needed, Markus
is asked and Markus creates it — no account, Worker, Durable Object namespace or API token in this
project has ever been made by one, and the probes above are `curl` against a public host, which is
a read and not a provision.

**And the address is in this repository.** ⚠️ **Also corrected 2026-08-29**: this said the URL
a deploy produces goes in each reader's own `sync_state.relay_url`, through Settings, and
**"never in this repository"**. It is one deployment Markus runs rather than one each reader
stands up, so it is compiled in as `RELAY_BASE` and is public in exactly the way every
application's API base URL is public — nothing follows from reading it out of the binary, because
**every route that reaches a Durable Object refuses a request without a token the relay minted**.
⚠️ That sentence read "**every** endpoint", **corrected 2026-08-29** to "every `/g/…` sync route",
and **corrected again 2026-08-30** because two `/g/…` routes are now outside the gate: `/rotate`
and `/keys` refuse out of D1, carry their own credential, and are covered in the routes table
above — an accepted rotation reaches the object once, to post its roster, and only a caller holding
the group's current auth can cause one.
`relay/src/index.ts`'s `CLAIM_ROUTES` doc says the rest in the code: **none of the four
entitlement routes is behind the bearer gate**, and none of them could be — three of the four
exist precisely because the caller has no token yet. Each is guarded by something else instead:
`/oauth/patreon/callback` by the authorization code Patreon's redirect carries, `/claim` by a
single-use code that expires in ten minutes, `/token` by the refresh secret or the group auth it
is presenting, `/webhook/patreon` by its HMAC. **The hostname is real and is committed with
Markus's approval** — it is the baseline relay the 2026-08-29 pass ran against.
**The hosted Worker is deployed at it**, which reverses what this paragraph said until
2026-08-30. Probed that day, **after the group-key deploy**: `/claim` and `/token` answer **405**
to a GET (the route is there and wants POST), `/oauth/patreon/callback` **400**,
`/g/{group}/push` and `/g/{group}/ack` **405**, `/g/{group}/pull` **401** from the bearer gate,
`/g/{group}/rotate` **401** to a POST, `/g/{group}/keys` **401** to a GET with a well-formed
bearer, and `/g/{group}/bogus` **404**. So the gate, the callback, the membership flow **and the
key distribution** are all live — an earlier reading of this line, taken before the deploy, said
`/rotate` and `/keys` were the two routes still missing, and that is history. `wrangler.jsonc`
carries a real `database_id`, so the D1 exists too and may hold live rows. **The device roll and
the pairing rendezvous are live too** — probed 2026-09-28, after this line had called the device
roll missing for four weeks on a probe that could not tell — and the last deploy was 2026-10-01
at 22:09 UTC, with the rate limits. The next deploy is an update to a running service, and
[hosted-relay-deploy.md](hosted-relay-deploy.md)'s step 0 is how to check rather than assume —
this paragraph is why it exists. **`PATREON_CLIENT_ID` is no longer the exception it was**: it was a placeholder until
`a0eb0c6` (2026-08-30) and holds the real id now, verified live — `GET /oauth2/authorize` with it
and `PATREON_REDIRECT_PATH` answered 302 to Patreon's login preserving both parameters, which an
unregistered id or a mismatched redirect does not do. It must equal `PATREON_CLIENT_ID` in
`relay/wrangler.jsonc`'s `vars`, because this side builds the authorize URL and the relay builds
the exchange; a mismatch fails at the *exchange*, where the error names no client.
`sync_state.relay_url` stays a
**test/dev override with no UI**: `sync_engine/client/tests.rs` stands a server on localhost for
the length of one test and points the client at it, and deleting the key would delete those
tests. What must never be committed are the **three** secrets the Worker holds —
`PATREON_CLIENT_SECRET`, `PATREON_WEBHOOK_SECRET`, `RELAY_HMAC_KEY` — in
[the hosted relay design](../superpowers/specs/2026-08-29-hosted-relay-and-patreon-design.md) §9,
and not in a committed `.dev.vars` either — which is why `.dev.vars` and `.wrangler/` are both in
`.gitignore`. ⚠️ **Three and not four, corrected 2026-08-29 — in §9 itself as well as here.**
That table **listed** a `PATREON_CREATOR_TOKEN` for the reconciliation cron; **the Worker that
was written has no consumer for one**, because the cron refreshes each subject against *their
own* stored token rather than querying the campaign with a creator-wide credential. §9 says three
now, and so does `relay/README.md`'s **Deploying** section — this paragraph is the record of that
fix, not a pointer to a table that still disagrees with it.

---

## The WebSocket is built — and two of the three reasons it wasn't were about the wrong socket

⚠️ **Superseded 2026-08-31.** This section used to argue the Durable Object's `/ws` route stayed a
`501` — a hibernating WebSocket, kept, but with nothing behind it. It is built now: see
[the live-sync design](../superpowers/specs/2026-08-31-live-sync-design.md), which is the source
for everything in this section, §§3–6 and §11 by name. The old three-reasons paragraph is kept
below as history rather than deleted, because it was two-thirds wrong for a reason worth carrying
forward: **two of the three were about a socket opened from the page, and the one that shipped is
opened from the Rust process instead.** Neither blocker survived contact with where the socket
actually lives.

The Durable Object accepts a hibernatable WebSocket at `GET /g/{group}/ws`, held open by
`sync_engine::live`'s connection manager for as long as the device is entitled-or-paired and in a
group — the same condition under which the old `round_trip` returned `Ok(None)` with no traffic,
so an installation that has connected nothing opens no socket, exactly as before. On every push
the Durable Object sends the group's other sockets a `{"t":"head","cursor":N,"from":"<device>"}`
frame — a doorbell, never card data — and a device that hears one runs the same HTTP round trip
the **Sync now** button has always run. The socket only ever decides *when* that trip happens; a
frame is a hint and is never itself the cursor advancing.

**The three original reasons, and what actually happened:**

1. **"`reqwest` has no WebSocket client, and the obvious addition, `tokio-tungstenite`, does not
   compile to `wasm32-unknown-unknown`."** True, and irrelevant: the socket is opened by the
   host's Rust process — the desktop's when this was written, and the Android host's too since
   the light app's phase 6 — and one module touches the crate: `grimoire-core`'s
   `platform::socket`, whose native arm it is (it was `sync_engine::live`, in `src-tauri`, until
   the connection manager moved; see "The connection manager, too" below). It is still true of a
   browser, which is why that module has a second arm: there the socket is the engine Worker's
   own `WebSocket`, and the web host runs the same loop over it since step 6.3.
2. **"A WebSocket from the page would need the CSP widened."** It would not, and this is the half
   the record had backwards: `connect-src 'self' ipc: http://ipc.localhost` governs the
   **webview's** connections, and the socket that shipped is opened by `tokio-tungstenite` inside
   the Rust process — the same process that already reaches the relay over `reqwest`, proven live
   by the 2026-08-29 two-device pass. ⚠️ **That clause read "over `reqwest` under that exact CSP"
   for part of 2026-08-31, and "under" is the wrong word for what a CSP does.** A
   Content-Security-Policy is a webview mechanism: it governs fetches the *page* makes, and a
   native HTTP or WebSocket client in the Rust process is **exempt** from it rather than permitted
   by it. Nothing in `connect-src` was ever consulted for either connection. The substantive claim
   is unchanged and is the stronger one: `tauri.conf.json` was not edited by this change and the
   page was granted nothing. A fourth reason the record never named: the page's own `WebSocket` constructor
   cannot set an `Authorization` header, so a socket opened from the page would have forced the
   relay's bearer gate onto a query parameter or a subprotocol — a relay change, and a worse one.
   Opening it from Rust keeps the existing gate unchanged.
3. **"Nothing polls, so nothing is being spent."** Correct at the time, and it was a reason to
   wait rather than a reason never to build it — see the cost below for what spending looks like
   now that something does.

⚠️ **No socket came up from the day this was built until 2026-10-01, and nothing went red.**
`connect_once` handed `connect_async` a hand-built `http::Request` carrying the bearer and
nothing else. tungstenite passes such a request through untouched and its handshake refuses one
without `Sec-WebSocket-Key` before a byte leaves — `WebSocket protocol error: Missing, duplicated
or incorrect header sec-websocket-key`, folded into one `error_log` row with a rising count. The
five handshake headers are only generated when the request is built **from the URL**, so
`upgrade_request` (in the core's `platform::socket` now) does that and then adds the bearer. Sync still worked throughout, because
the round trip ahead of the socket is plain HTTPS — one trip per backoff cycle instead of a
doorbell — which is exactly why it went unnoticed. The route was live the whole time (probed
2026-10-01: `/g/{group}/ws` **401** from the bearer gate, `/g/{group}/bogus` **404**).
`the_upgrade_request_passes_the_handshakes_own_check` runs tungstenite's own check over the
request, with no relay. **The cost table below has therefore never been measured against real
traffic.**

**The first pass with a socket up** (2026-10-01, debug build, Windows; the relay was this tree's
`relay/` under `wrangler dev` 4.143 on `127.0.0.1`, reached through the `relay_url` override with
a membership seeded into the local D1 — the deployed relay and Patreon were not involved, and
the peer was a script pushing envelopes the app could not open, so this times the doorbell and
not an apply):

| | Measured |
| --- | --- |
| Claim → `connecting` → `live` | 1.7 s, 1.9 s; the relay logged `GET …/ws 101` |
| A peer's push → this device's cursor at the relay's head | 1.2–1.3 s, 6 of 6 (`FRAME_DEBOUNCE_MS` plus the trip) |
| The relay's frame itself, push to socket | 22 ms |
| This device's write → its envelope on the relay | 3.1–3.3 s after the commit, 5 of 5 (`WRITE_DEBOUNCE_MS` plus the trip) |
| Relay stopped 20 s, then restarted | `offline` within a second of the stop; `live` again 11 s after the restart was issued, on the ladder's next rung |

So a change crosses in about four and a half seconds where the backoff ladder's one trip per
cycle took a minute or two ([issue #751](https://github.com/Msgaihede/mtg-grimoire/issues/751)).
A device's own push is not echoed to it, and a protocol ping is answered with a pong. **One
write waited 27 s**, and it is the design rather than a fault: it was made while the first-run
card ingest was inside its swap, `outbox_has_work` (`after_a_commit` since step 6.3b) gave up on the write connection after its one
second, and the swap's own commit rang the bell again — the trip could not have had the
connection any sooner. The same pass held a managed wishlist's nameless **Tokens** folder
(`parent_id` set, `sync_uid` NULL, made by the real `settle_deck`) through three pulls with no
error, which is the cycle check's fix above seen in the window. **Not driven: two real devices
through the deployed relay.**

**The cost, re-derived** (spec §11; Cloudflare limits verified 2026-08-31):

| | DO requests/group/day | Groups on free |
| --- | --- | --- |
| Idle group — connected, nobody editing | ~25 | ~4 000 |
| Busy group — 50 edits → ~20 debounced bursts, 3 devices | ~225 | ~440 |
| Manual — what shipped before this branch | ~70 | ~1 400 |

A busy group costs about 3× the old manual cadence, but on a different curve: a poll is paid
whether or not anybody is using the app, where this is paid only when somebody edits, so it cannot
run away on its own — which is what the 2026-08-29 decision below was actually worried about.
**That decision — stay on the free plan, add a Cloudflare notification at ~70% of the daily
request cap — stands, and the notification matters more now that the number is reader-driven.**
Storage and duration never bind: 484 KB/group against 5 GB, and ~0.02 GB-s/group/day against
13 000.

⚠️ One figure is unverified: Cloudflare's 20:1 ratio for incoming WebSocket messages is documented
as *"for compute requests billing-only"*, and whether it applies to the free plan's 100 000/day
counter is genuinely ambiguous. Every figure above assumes the pessimistic 1:1 — it barely bites,
because protocol pings are free and the client sends almost nothing else inbound.

What changed against the old manual baseline: a change made on one device now reaches another
within a few seconds, rather than at the next press of **Sync now**. What did not change: the CSP
still grants nothing.

**One correction to the plan, and it is the difference between a stall and a loss.** The plan says
an envelope that will not open must not advance the cursor past it. That is right for exactly one
of the two ways it happens:

- `envelope.epoch > group.epoch` — this device is **behind** a key rotation and has not been
  handed the new key. Those ops become readable, so the cursor stays put. **That bet only came
  good on 2026-08-30**: until the rewrap hop existed the key never arrived, so "the cursor stays
  put" meant the page was re-delivered for ever and one removal bricked any group of three. The
  hold was the right call against a hop that had not been built yet, and it is now what makes the
  stall temporary rather than permanent — `check_keys` runs before pull on every round trip.
  ⚠️ **Only at or below the epoch the relay answered, since issue #546**: the relay stores an
  envelope's `epoch` as sent, and a hold on any higher number let a token holder freeze every
  cursor in the group with one push (*Held while it can resolve*, above, has the rule).
- `envelope.epoch < group.epoch` — written before a rotation. **It is opened with its own epoch's
  key when this device still holds it** (`identity::group_at`), because `check_keys` adopts before
  the pull: without that key, a device offline across any pairing — and every pairing rotates —
  stepped over everything the group wrote before it, deletes included, and no baseline can carry a
  delete back. ⚠️ **The superseded key is kept only across a rotation that, as far as this device
  can see, dropped nobody** (`identity::supersede`): exactly one epoch ahead, this device holds a
  view of the group, and every device in it — its roster *and* the last manifest it adopted or
  published, since `adopt_epoch` never inserts — is still on the new manifest. **No view is not an
  empty view**: only `identity::found_group` seeds one (`[itself]`, when this device mints the
  group), so an install upgraded from before this history and a device that joined by pairing
  forget across their first rotation and learn the roster from it — one lost backlog, which is
  what every rotation cost before. A removal, a departure or a skipped epoch forgets every
  superseded key too. The group key is symmetric and the relay does not refuse a push at a stale
  epoch, so a device that went on opening *N* after a removal would take writes from the removed
  device, which holds *N*'s key and a token for up to a day. At most `identity::KEY_HISTORY`
  epochs are held, current included — the relay's `EPOCH_HISTORY` — in `sync_state`, never synced
  and `None` to the mirror.
- ⚠️ **That "dropped nobody" is the relay's word — for a one-step rotation only, since issue
  #546.** Only the epoch is bound into the sealed blob; `devices` is `Object.keys(manifest.keys)` as
  the relay reports it. Confidentiality holds against the relay regardless — nothing here hands
  anybody a key — but keeping the backlog across a `+1` relies on the relay reporting the manifest
  honestly: a malicious relay colluding with a removed device could pad `devices` with it and get
  that device's writes under the pre-removal epoch applied. **A removal made by an updated device
  steps the epoch by two**, and a `+2` forgets whatever `devices` says, so the lie no longer reaches
  one — below.
- An old epoch whose key this device never held or has forgotten, or a failed AEAD — altered —
  opens nothing, so refusing to advance would stall the stream for the thirty days the relay keeps
  a tail, for nothing. It is counted, written to `error_log` and stepped over. **An envelope that
  opens and then does not parse is in this bullet only when nothing in it says a newer build sealed
  it** (`WireError::Malformed`): the AEAD passing says a member sealed it, and one whose ops carry a
  schema above this build's (`WireError::Newer`) holds the cursor as `newer` instead (*Held while
  it can resolve, skipped when it cannot*, above). A forgotten key can also cost a held page:
  *What a hold cannot reach*, above.
- **What the client could not do on its own — three follow-ups, built in issue #546 (2026-09-28)
  and not yet deployed on the relay side**:
  - **`/keys?epoch=`.** A device that skipped *N → N+2* never got *N+1*'s key, because `/keys`
    answered only the newest manifest though the relay keeps eight epochs. `check_keys` now walks:
    more than one epoch behind, it asks `?epoch=n` for each epoch up to the newest with the auth of
    the epoch it holds at that step, adopts each blob through the same sealer loop, steps over a
    404 `no_such_epoch` (a removal's gap), and leaves on a manifest that omits it. An old relay
    ignores the parameter and answers the newest — detected by the answered epoch, and adopted as
    before; any other failure falls back the same way rather than stalling.
  - **The authenticated join/removal marker, and it is the epoch.** The rotation wrap still seals a
    bare 32-byte key — a field there would have been a mixed-version break — so the step is the
    marker: a join advances the epoch by `identity::JOIN_STEP` (1), a removal or a departure by
    `identity::REMOVAL_STEP` (2), bound into every wrap by the rotator, and `supersede` already
    forgot on anything but exactly `+1`. The relay's `/rotate` accepts `+1` or `+2` in one
    statement and advertises it with `removalStep: 2` on every `/keys` answer; the app latches that
    (`client::removal_step`, trust on first use — never un-latched, so a relay cannot quietly
    downgrade removals back to `+1`) and plans `+2` only then, so an older relay goes on receiving
    `+1` and nothing breaks in either deploy order. **The two costs this bullet predicted are
    paid**: a removal spends two of `EPOCH_HISTORY`'s eight epochs, so a device dark across four
    removals can no longer reach `/keys` (three it still can), and the relay accepts `+2`.
  - **Refusing a push below the group's epoch** is built on the relay (409 `stale_epoch`), and
    was recorded as what would let the superseded keys be kept across a removal. **They are still
    forgotten, deliberately**: keeping them would trust the relay to enforce the refusal, and the
    marker above exists so a removal no longer rests on the relay's word. A removal still costs
    the backlog behind it.

---

## A trip holds nothing across a request

**2026-10-03, debug build, Windows.** Until then every sync operation was
`sync::with_write(&state, |conn| runtime.block_on(client::run_once(conn)))`: the write connection
taken, a runtime built on a blocking thread, and an `async fn` holding `conn` through every
request it made. Thirty-one functions in `client.rs`, `entitlement.rs` and `pairing.rs` held a
connection across an `.await`, fifty-six awaits between them
(`node scripts/core-step-6-census.mjs .`; it reads none now, and a vitest test holds it there).
[The spike](../superpowers/research/2026-10-02-light-app-step-6-sync-trip-spike.md) is the full
record and [the plan](../superpowers/plans/2026-10-02-light-app-core-step-6-sync.md) the step;
this is what is true of the code.

**A stretch.** Each of those functions takes `db: &impl Store` (`grimoire_core::state`) and
reads or writes inside `db.with(|conn| …)` — one closure, run to its end with the connection. A
request is made between two stretches with nothing held. A test hands over a bare `Connection`,
which is a store whose stretches run back to back, so the modules' tests did not change.

**The lane.** One async lock on the core's `State`, held for the whole of each sync operation,
and its guard is the app's only store — `Store` is not implemented for `State` — so a stretch
outside it does not compile. The held connection used to give "one sync operation at a time" by
accident; without it a pairing confirm, a rotation's commit, a claim and a leave corrupt each
other five ways (the spike's §4).

| Takes the lane | How |
| --- | --- |
| the socket's trip, the socket's token, the exit push, **Leave group** | `State::lane()` — waits its turn |
| Sync now, a claim, a pairing accept / confirm / poll, Remove device, a share publish | `State::lane_for_press()` — `db::BUSY` after `WRITE_LOCK_WAIT`, as a press during a sync always was |

The pending pairing offer has an async lock of its own, taken before the lane and held across
the request: a Cancel waits behind it and wins, and two polls cannot both complete one offer.

**What can land between two stretches is the reader's own write**, and the trip is shaped by it
in three places:

- **`push` sends the outbox as it stood when it read it.** A write behind that read is a row
  with a higher `seq`: neither sent nor stamped by this trip, and carried by the next — which the
  write's own commit has already asked for.
- **`pull` is one stretch from the page to the cursor**: the envelopes opened, measured against
  the clock and the watermarks, applied, the hold decided, the cursor moved, the conversions
  behind an advancing pull. Its one request inside the page — `/keys`, for an envelope above the
  epoch in hand — is asked ahead of the page instead, once, on the same condition.
- **A baseline's rows, its clock and its horizon are one stretch, and none is begun while
  anything at all is pending.** The second half was found by the test, not by the design, and
  was first "an op written since the trip read its outbox" (`emit_baselines`' `through`); it was
  widened to every pending op on 2026-10-03 by
  [the claim emissions design](../superpowers/specs/2026-10-03-baseline-claim-emissions-design.md)
  §5, and `through` is gone. Such an op is in the rows and under the horizon and not yet on the
  relay's log, so it goes out with a *later* trip, behind the baseline — and a peer that pulls in
  between reads the claim in one page and the op in the next, where no horizon filters it.
  `3 here, 4 there`. An op an earlier refusal left pending does exactly the same
  (`a_baseline_waits_while_an_earlier_refusal_left_an_op_pending`).

**A stretch waits for the connection and never answers `db::BUSY`** (`state::with_write_waiting`,
whose one caller it now is). It may be recording an answer the relay will not give twice: the
grant behind a claim code that is now spent, the group a founding `confirm` has just handed a
joiner the key to, a rotation the relay has accepted. What it waits behind is local work, and it
**counts as an ask while it waits** (`db::lock_waiting`), so an ingest's batch loops stand aside
for it as they do for a press — a thread parked on the mutex would get the connection only when
it happened to catch it free.

**What the baseline rule costs, and what it leaves.** A baseline now needs a trip with no write
between its outbox read and its rows — a reader editing through every trip keeps a newly paired
device waiting until they pause for longer than the three-second debounce and one trip. ~~It does
not reach the ops an *earlier* refusal left pending: a push deferred as `too_large` still lets a
baseline go out over them, the over-count this rule closes for a mid-trip write, which was there
before and needs the client and the relay to disagree about a size the client cuts under.~~
**It reaches them since 2026-10-03** (*A claim names its emission*, above), and the cost moved: a
batch the relay refuses as `too_large` is one this device measured as fitting, so it is refused on
every trip and its ops stay pending for good — and now no baseline goes out behind them at all,
where one used to go out over them (`Deferral::TooLarge`). It still needs the client and the
relay to disagree about a size the client cuts under.

### The tests that hold it

| Test | What it lands | Red when |
| --- | --- | --- |
| `a_write_anywhere_in_a_round_trip_is_carried_by_the_next` | a copy added behind each of a trip's stretches, counted by the test as it runs, a second trip, a peer that pulls after each | a baseline goes out over a pending write: `3 here, 4 there` behind 7 of the trip's stretches when the mutation was run, on 2026-10-03 |
| `a_write_anywhere_beside_a_pull_is_counted_once_on_both_devices` | the same, with a peer's own copy of that row in the page | the write and the apply disagree about a counter |
| `a_write_anywhere_in_a_baselines_emission_reaches_the_peer` | a copy added behind each stretch of one emission | the rows and the horizon are read apart: `3 here, 2 there` |
| `leaving_waits_out_an_operation_in_flight_where_a_press_is_told_busy` | the command's own departure (`pairing::leave`) behind a held lane, on a paused clock, for ten of a press's bounds | it takes a press's lane: red, the mutation was run |
| `state::tests::a_second_operation_waits_for_the_first`, `a_press_behind_a_sync_or_a_busy_connection_is_told_busy` | two operations; a press behind one, and behind a held connection | the lane is not exclusive, or a press queues |

Both whole-trip tests added their first copies "ten seconds ago" **until 2026-10-03, and neither
does now.** A baseline op is stamped from its row's `updated_at` — a whole second — and `apply`
skipped as seen whatever its sender stamped at or below the watermark the peer holds, while the
horizon it carries still filtered the delta: an edit made in the second the peer last heard from
this device was lost on that peer. That was `apply`'s, was reproduced on `main`'s code, and was
filed on its own. ⚠️ **Closed 2026-10-03 for an emitter on this build**: a claim that names its
emission is never judged by the watermark (*A claim names its emission*, above), and
`a_rebaseline_carries_an_edit_made_in_the_second_the_peer_last_heard_from` lands that edit. An
older emitter's baseline still loses it.

**The backdating went the same day, measured both ways first** — debug, Windows, 2026-10-03, the
two `UPDATE`s deleted from each test and nothing else changed:

| Tree | `a_write_anywhere_in_a_round_trip_is_carried_by_the_next` | `a_write_anywhere_in_a_baselines_emission_reaches_the_peer` |
| --- | --- | --- |
| `main` at `6d76803b`, the fix in it | green, 9 runs of 9 | green, 9 runs of 9 |
| `bc439e10`, the commit before the fix merged | **red, 7 runs of 7**: `3 here, 2 there` behind stretches 8 to 14 of the trip's 19 | green, 7 runs of 7 |

So the round-trip test needed it and no longer does, and without it that test is a whole-trip
fence for the fix: its fixture's add and its claim share a second, which is the bug's own shape.
**The emission test did not need it on that commit**, and why is read off the code rather than
measured: `emit_baselines` already began no baseline over a pending write, so a write landed
either ahead of the rows — nothing emitted, and it arrived as the delta it is — or behind them
and above the horizon. The claim was skipped as seen there too, and held nothing the peer lacked.
The round trip is where the two rules meet: the first trip holds its baseline back for the
pending write, the second pushes the write and the baseline together, and the peer reads the
write under the horizon beside a claim at or below its watermark.

**And the compiler holds the rule itself.** A future that keeps a `MutexGuard` across an
`.await` is not `Send`; `nothing_is_held_across_a_request`, in each of the three files, hands
every entry point's future to `fn sendable<T: platform::Sendable>(_: T)` and is never called.
`clippy::await_holding_lock` refuses the same in every function, tests included. **The bound was
`Send` until the move**, and the move made it fail the WASM compile at every entry point: a
browser's request is a JavaScript promise, and no future that awaits one is `Send`. `Sendable` is
`Send` on a native build and anything in a browser, where there is no other thread — so the
question the fence asks of the desktop did not change, and a mutation (an `Rc` handed to it) is
still refused natively.

### Driven in the shipped window

`tauri dev` over CDP, the dev copy's `relay_url` pointed at a mock relay on the loopback (the
copy was in no group and held no grant; its files were put back afterwards). **Nothing reached
the real relay.**

| | Measured |
| --- | --- |
| A claim, then a trip | `/claim`, `/keys`, `/keys`, `/rotate` (a join this copy still owed), `/pull`, `/ack`; 10 ms and 18 ms |
| A sticky note written 1.5 s into a trip whose pull took 8 s | **answered in 9 ms** — it was told *the database is busy* after 5 s |
| The status read beside it | 2 ms, `pending: 1` |
| A second Sync now, pressed during that trip | `db::BUSY` after **5 013 ms** |
| That trip | 8 022 ms, `pushed: 0` — the note was written behind its outbox read |
| What happened next, unasked | the socket's own trip: `/keys`, `/push` (641 B), `/pull` — `pending: 0` |
| Leave group, pressed 1 s into a 6 s trip | waited **5 016 ms**, then `/rotate` 3 ms behind the pull's answer; no group, no grant |
| `sync_pairing_begin`, `poll` ×2, `cancel`, `poll` | 16 ms; *waiting*, *waiting*; done; *idle* |
| Each refusal on a device in no group | in words, in 2–3 ms |

### Moved to the core

**The same day, the code above left `src-tauri`** (the light app's step 6, second part, by
`scripts/core-step-6b.mjs`): `sync_engine::{client, entitlement, wire, schedule, commands}` and
`sync_pair::{identity, pairing}` are files under `crates/grimoire-core/src/`, re-exported in
`src-tauri` at the paths they always had. What stayed that day is `sync_engine::live` — the
socket, its timers and the two events it emits through a window ("The connection manager, too",
below, is when it followed) — and every `#[tauri::command]`, in
`sync_engine/commands/mod.rs` and `sync_pair/pairing/mod.rs`. These changed on the way, and
nothing a request sends did — a reviewer compared all eight requests, old against new, route,
verb, headers and body:

| What | Was | Is |
| --- | --- | --- |
| A relay request | `reqwest`, directly | `platform::http`: natively the same connect and read bounds; in a browser a whole-request `deadline` — **120 s** for the client (whose pull is unpaged), **30 s** for the entitlement — because `fetch` has no other bound and a request that never ended would be a Leave that never ran |
| The pending offer | `AppState.pairing`, a `tokio::sync::Mutex` | `State.pairing`, a `platform::sync::Shared` — the same lock, on every host |
| A device's default name | `COMPUTERNAME` / `HOSTNAME` read in `identity` | `platform::device::name()`; `None` in a browser, where `mint_name` falls back to its word — `platform::device::kind()` since 2026-10-04: `Desktop`, `Android` or `Browser` |
| The relay clients' per-call test client | `cfg(test)` | `cfg(any(test, feature = "testing"))`, because the desktop's sync tests link the core with `testing` on, and a dependency's `cfg(test)` is off |
| A client that cannot be built | `reqwest`'s builder `.unwrap_or_default()`, a client with no timeouts | `platform::http::Client::new`'s `expect`, as every other client in the core has panicked since the I/O step — unreachable with a fixed configuration, and a panic beats a client with no bounds |
| `client::kind_of` | an `is_status()` arm answering `Http` | gone: only `error_for_status` builds that error, and neither file ever called it |
| `sync_pairing_begin` | `spawn_blocking` and the offer's `blocking_lock` | `sync::on_a_worker` and `.lock().await`, as the other pairing presses are — one runtime per press |

The same pass in `tauri dev` against the loopback mock, on the moved code: a claim 12 ms; a trip
21 ms; a sticky note written during an 8 s trip **7 ms**; a second Sync now during it `db::BUSY`
after **5 013 ms**; the slow trip 8 014 ms, then the socket's own trip pushing the note (641 B);
Leave group pressed behind the socket's trip, waiting **6 428 ms** and then clearing the group and
the grant; the pairing commands as before. The dev copy was in no group before and after, and its
files were put back.

### The connection manager, too

**`sync_engine::live` is the core's since the light app's phase 6 (step 6.2, 2026-10-04)**, so
that a host other than the desktop can run it — and the Android host does. What moved is the
whole loop: the socket's lifetime, the five wakes, the scheduler it asks, `sync:live` and the
loop's `sync:applied`, the `error_log` note, the write wake and `sync_live_state`'s answer.
`src-tauri/src/sync_engine/live.rs` re-exports the core's module and keeps the one thing only a
desktop has a moment for: the bounded push on the way out (`anything_pending`, `push_now`).

| What | Was (`src-tauri`) | Is (`grimoire-core`) |
| --- | --- | --- |
| The socket | `tokio-tungstenite`, named in `live.rs` | `platform::socket`: `connect(url, bearer)`, `Socket::next() -> Event::{Text, Closed(code), Failed}`, `Socket::keepalive()`. The native arm is the same crate, version, features and upgrade request; the browser arm is a page's own `WebSocket` (step 6.3, below) |
| The five wakes | `tokio::select!` | `futures_util::select!` over fused futures — as fair: whichever is ready is taken in no fixed order. `tokio::select!` cannot be named outside `platform/`, and the core's tokio has no `macros` |
| The 45 s ping and the 250 ms tick | `tokio::time::interval` | `platform::timer::interval`, on `platform::clock::Tick` and `timer::sleep`, so a browser has it: first tick at once, a late beat keeps the grid, safe to drop mid-wait — and **beats missed outright are dropped, where tokio's default owes them back to back** (below) |
| The socket's age limit and `lived_ms` | `tokio::time::Instant` | `Tick`, and one `timer::sleep(SOCKET_MAX_AGE)` for the socket's life |
| The write wake | `Arc<tokio::sync::Notify>` | `Arc<platform::sync::Bell>` — the same `Notify` underneath, `ring()` is `notify_one`, so a commit that lands while the loop is in a trip, asleep on a backoff or dialling is still kept as one permit |
| A trip, and the token for the upgrade | `sync::on_a_worker` | `platform::spawn::on_a_worker`: natively the same — a pool thread with a current-thread runtime of its own; where there is one thread, awaited where it stands |
| The idle reads, the outbox gate, the note | `tokio::task::spawn_blocking` | `platform::spawn::blocking` |
| `sync:live`, and the loop's `sync:applied` | `AppHandle::emit` | the state's `EventSink`, which the desktop forwards to every window as before. The payloads are the same JSON; `sync:applied`'s keys now arrive in the order `serde_json::Value` keeps them, as every other core event's do |
| `sync_live_state` | a desktop-only command | a `task` entry in the core's table; the desktop's wrapper stays registered and answers the same value |
| Who starts it | `live::spawn(app, state, writes)` | the host: `tauri::async_runtime::spawn(live::run(state, writes))`, after its launch has settled |

**Two things the loop does differently on every host, the desktop included, and both on
purpose:**

- **A keepalive that was never answered ends the socket — once its peer has answered one.** A
  connection that goes without a word — a phone back from the background on another network, a
  laptop out of range — is closed by nothing this end can see until TCP gives up: about twenty
  seconds on Windows, on the order of a quarter of an hour on Android's Linux defaults. Until
  then the socket read `live` and heard no doorbell. `Socket::keepalive` now tracks its ping:
  `next` notes the pong as it swallows it, and a keepalive that finds the last ping still
  unanswered looks once at what has already arrived (a loop inside a long trip has not been
  reading) and then fails — *the relay did not answer the last keepalive* — which is
  `Disconnect::Failed`, the ordinary backoff and reconnect. So a dead socket is noticed within
  two ping periods, ninety seconds.
  ⚠️ **The deadline is held only on a socket that has already seen a pong, which is what makes
  it safe by construction.** It rests on the relay's edge answering a protocol ping with a pong.
  Measured locally on 2026-10-04 — the relay under `wrangler dev --local` (workerd, wrangler
  4.146.0) answered a raw masked ping, opcode 9 and empty, with opcode 10 and empty, on a
  hibernatable socket, as the 2026-10-01 pass above had seen — and **production is unseen**.
  If the deployed edge answered no pings at all, a deadline held from the first ping would end
  every socket on every device at its second keepalive, for ever; with this rule such a peer is
  pinged and nothing is concluded, exactly as before the deadline existed. What it gives up is
  a socket that goes half-open before its first pong — the first 45–90 s of a connection —
  which is left to TCP, as every socket was.
- **A beat that was missed is not owed.** `tokio::time::interval` bursts by default: a loop
  that was away takes every missed tick back to back. After an hour frozen — Android freezing a
  background process, a laptop's lid — that was 14 400 ticks and eighty pings, and
  `platform::timer`'s interval, with no timer to pass through for a beat already due, would
  have taken them without once yielding its thread or reading a frame. It takes one and is on
  a grid from then. On the desktop that removes `take_due` calls that answer `false` and pings
  into a socket that is probably dead.

**Android runs it** (`mobile/src-tauri`): its `open` registers `live::WriteWake` as the state's
one write observer and its `start` spawns the loop after `startup::settle`. **It has no push on
the way out** — the process ends by `_exit` or by the system's kill, neither a hook a request
can be awaited in — so the loop's 3 s write debounce is what pushes, and an op that missed it is
still `pushed_at IS NULL` for the next launch's first trip.

**And the web host runs it, since step 6.3** (`crates/grimoire-web`): `host::start` registers the
same wake on the host's one connection, and `glue::open` spawns `host::live_sync` beside the
launch's downloads once `open` has answered. The loop is not changed for it; what a browser
needs is all `platform::socket`'s second arm:

- **The socket is the engine Worker's own `WebSocket`**, constructed off the Worker's global
  through `js_sys::Reflect` (no `web-sys`), with **exactly two sub-protocols** — `grimoire.live.v1`,
  which the relay selects, and `bearer.<access token>`, because a page can set no header on an
  upgrade.
- **Its four events feed a queue, and `next()` drains it.** A browser's socket is not read; it
  tells, whenever the event loop gets to it — also while the loop is inside a trip. A text frame
  is queued; a `close` is `Closed(code)`, 4001 among them; an `error` is `Failed`, with a
  sentence that says nothing, because a browser tells a page nothing about a refused upgrade
  (a 401, a 403, a host that is not there and a policy that forbids it are all `error` and, at
  most, a close with 1006). The first ending is the ending.
- **The keepalive is the text frame `ping`**, and the relay's `pong` is swallowed where the
  event arrives — it is the answer to the outstanding ping and is handed to no caller. The rule
  is the native arm's: a ping that finds its predecessor unanswered fails the keepalive, once
  this peer has answered one. Before concluding, the arm gives the event loop one turn
  (`timer::yield_to_host`), which is its look at what has already arrived.
- **Letting go is ordered**: the four handler properties are cleared, then the socket is closed,
  then the closures are dropped — a closure the browser calls after it was dropped throws inside
  the event loop.
- **One thread, one connection.** `spawn::blocking` and `on_a_worker` run where they stand, so
  the loop's reads, its outbox gate and its trips all run between two turns of the Worker's
  event loop, on the connection a page's commands use. Measured in headless Chrome 154
  (`npm run web:sync-smoke -- --measure`, V8's sampling profiler on the Worker): **idle and in
  no group the Worker was busy about 5 ms of a minute** — the five-second read of `sync_group`
  is inside that — and **idle, paired and live about 5–9 ms of a minute**, the quarter-second
  tick and the keepalive inside it. A `search_cards` issued over and over beside a round trip
  answered in a median 0.6 ms, as it does alone, and at worst in 7–11 ms: the longest stretch a
  small trip keeps the connection.
- **The hosting policy names the socket.** `connect-src` matches a scheme, and Chrome refuses
  `wss://<relay>` under `https://<relay>` alone, so `app-worker/_headers` carries both.

**What a browser's device does not get**: a push on the way out (a closing tab gives a Worker
no moment to await one — the 3 s write debounce pushes, as on Android), and a socket that
survives the tab being frozen. `timer::interval` drops the beats a frozen Worker missed, so it
comes back to one tick and one ping, and a socket that died meanwhile is found by that ping's
missing `pong` within two periods.

#### A device that left, was removed or changed group lets go of its socket (step 6.3b)

**The defect, on every host since the socket was built**: the loop asked whether its device was
in a group *between* sockets and never while it held one, and a socket is its group's — the
Durable Object it reaches is addressed by the group id. So a device that pressed *Leave group*
kept the socket, reading `live`; and one that left and then joined another group went on
listening to the group it had **left**, for as long as that socket lived — up to its twelve
hours — while the group it was in rang on nobody. A device removed by another fared the same:
the relay closed nothing, and the trip on which it learned it was removed cleared its group and
left its socket up. Seen in step 6.3's walk; fixed here, in the loop and in the relay.

**The loop's rules now** (`sync_engine::live`; every consequence is `schedule.rs`'s, with tests):

- **A socket knows which group it was opened for**, and the loop looks at `sync_group` on the
  commit that could have changed it — the write wake's arm, ahead of the outbox's question —
  and again on every keepalive beat, as the backstop for a look that could not be taken. A
  device in no group, or in another one, ends the socket as `Disconnect::Left`: **no backoff,
  no `error_log` row, the attempt counter where it was**. The loop's top then says `off`, or
  `connecting` for the group it is in now.
- **The look is taken on the write connection, behind the writer.** The commit hook fires before
  the commit is anybody else's to see, so the read connection, asked as the bell rings, still
  answers the group that is being deleted — which would keep the socket, with no second commit
  coming. `State::db`'s mutex is held by the writer until its commit is done, as the outbox's
  question already relied on. On a host with one connection there is no other to be wrong on.
  A look that cannot have the connection inside a second decides nothing (`Membership::Unknown`
  keeps the socket) and is taken again at the next commit, and at the next ping.
- **The relay's two closes are two codes, read apart** (`schedule::gone`). **4002** is a device
  a rotation's manifest leaves out; **4001** is a group whose log was dropped — a membership
  ended — and is the only one a released client has heard of.
  - **4002 is read behind the sync lane.** A device that *leaves* publishes exactly such a
    manifest, so its own press closes its own socket a moment before it clears the group
    locally. The lane is held by that press to its last write, so a look taken on the lane sees
    the group gone: `Left`, quiet. A device somebody else removed still thinks it is in the
    group: `Removed` — a backoff, the row, and then the reconnect's first act, the round trip
    on which it finds the manifest without it and clears its group.
  - **4001 is `Dropped`: a backoff, an attempt spent, and no row — nothing is concluded from
    it.** When it arrives the device is still in its group and its stored status still says
    `active`, so asking the database whether this is a lapse answers no, and a row would be the
    one the loop exists never to write: one per lapse per connected device. The close is not
    recorded (`schedule::recorded`); the trip behind the backoff is what learns it is a lapse,
    and that path writes none. (Read behind the lane too: a device already in no group is
    `Left` under either code.)
  - Any other code, one this build has never heard of included, is an ordinary close — which is
    how a released client reads 4002, and what lets the relay add a code.
- **Both of the write wake's questions are one taking of the write connection**
  (`after_a_commit`): which group, and whether the outbox holds anything. Each waits up to a
  second for it, and as two takings they made a batch ingest stand aside twice per commit.
- **A dial with no group to dial for is not a failure.** That round trip is in front of every
  dial, so a removed device reaches `credentials` with no group; it is `Left`, where it was a
  failed socket — a second backoff, `offline` again and a second row.
- **A dial has a deadline**, `CONNECT_SECS` (20 s: the relay's other clients' connect and read
  bounds added). A relay that takes the connection and never answers the upgrade used to hold
  the loop at `connecting`, with no trip, for as long as the stack underneath allowed — minutes,
  in a browser. It is a failed socket now, in a sentence. **The deadline takes one last turn of
  the host and looks once more before it gives up** (`timer::timeout_after_a_last_turn`): in a
  browser the deadline's timer and the socket's `open` are both queued tasks, and behind a
  stretch that held the engine's thread past twenty seconds — a first ingest does — both are
  waiting when the thread comes back. Timer first, and an opened socket was dropped with a row
  saying the relay never answered. A browser's task order is not specified; what is tested,
  natively, is that the second look is taken.
- **What the loop records** is asked as the Settings panel asks it: a lapse is the one failure
  left out of `error_log`, and "lapsed" is `!commands::entitled && entitlement::membership_ended`.
  It asked the second alone, which is also true of a healthy device that joined by pairing — no
  refresh secret, and the `active` the group door answered — so such a device recorded **no
  background failure at all**.
- **A token refused across a rotation is asked again, once** (`client::token_across_a_rotation`,
  in every round trip — the loop's, a press's, a join's). A trip's key check and its group door
  are two requests, and a sibling's rotation can land between them: the door is then asked with
  the auth of the epoch the check just confirmed and refused it bare. Pairing does exactly that
  to a joiner — the confirming device seals at the current epoch and publishes the join's
  rotation a moment later, while the joiner's first trip is running — and the walk met it three
  runs in twenty-one. The refusal is taken to `/keys`, as `push` takes a `stale_epoch`: adopted
  → the door again under the new key; removed → the trip ends quietly; the relay still on this
  device's epoch → the refusal stands, as it did.

**What a desktop does differently, each one**: (1) it lets go of its socket at once when it
leaves its group, is removed, or changes group, and says `off` rather than going on reading
`live`; (2) joined to another group, its socket is that group's within the loop's five-second
read rather than after up to twelve hours; (3) a removed desktop, once the relay tells it, reads
`offline` for one backoff and then `off`, with one row — *the relay says this device is no
longer in its sync group* — on the relay's 4002, which no deployed relay sends yet; **and a
4001, a dropped group, now writes no row** where it wrote *…this device's sync group no longer
exists*: it backs off and the trip speaks; (4) a dial the relay never answers fails after twenty
seconds; (5) **a desktop
that joined by pairing starts recording its background relay failures** — its Errors panel was
silently dropping every one — folded on the message as on every other device; (6) each commit
on the write connection costs the loop one more read, of `sync_group`; (7) a round trip whose
token is refused behind a rotation adopts it and asks once more, where the trip failed.

**The relay's half** — a rotation's roster closes the sockets of the devices it leaves out — is
`relay/README.md`'s, and is not deployed. The two ship in either order;
[hosted-relay-deploy.md](hosted-relay-deploy.md)'s ninth half has what each side does with the
other's old build.

**Still true**: a Sync panel left open on a device that is then removed goes on showing its old
roster until its own query is read again — the engine says `off` through `sync:live`, and
nothing on the page re-reads the pairing for that. Nothing syncs meanwhile; the sentence is
simply late.

**What was run**: the loop's own tests, natively — a device in no group says `off` once over
twelve idle polls and dials nothing until it is put in a group; a device in a group dials a
loopback stand-in with its bearer in `Authorization`, says `connecting`, `live`, sends a protocol
ping first, and on a 4002 close says `offline` and writes the `live` row (on a 4001, `offline`
and no row, whichever door the device is entitled through); and on a state with one
connection, on a thread standing in for a Worker (`platform::alone`), the loop takes no lock
twice — once with no socket (the group read, a failed trip and its row, the token, the note) and
once with one up and a `head` ahead of the cursor (the keepalive, the cursor read, the outbox
gate). The socket's own: a relay that answers its pings stays up across keepalives, one that
answered and then went silent fails the keepalive after the next unanswered ping, one that never
answers any is never failed by a keepalive, and a pong that came in while nobody was reading is
found. Each was
seen to fail against a mutation of what it guards. **Not driven**: the desktop app against a
relay after the move, a phone at all, and an Android build on this machine (no target, no NDK —
CI's `core (aarch64-linux-android)` job is what compiles it).

## Schema — user v30

| Object | What it is |
| --- | --- |
| `sync_uid TEXT` + `idx_<table>_uid` on every synced table | a name every device agrees on. **Eleven** through this rung's `ALTER TABLE`s; each table added since carries the pair in its own `CREATE TABLE`, so the census is **thirteen** at v37, **fifteen** at v43, **sixteen** at v46 and **seventeen** at v52 |
| `device_names` (v31) | `device_id` → `name`, and nothing else. **The twelfth synced table**, so a rename reaches the group and a joiner stops reading "Paired device". `sync_devices` stays unsynced beside it, because it holds keys |
| `needs_review TEXT` on `deck_folders`, `wishlist_folders`, `collection_folders` | §7.4's second surfaced outcome had nowhere to go |
| `sync_ops` | the op log: `tbl`, `uid`, `kind`, `fields`, `counters`, `parents`, the stamp, `pushed_at` |
| `sync_clock` | one row: the hybrid logical clock, **seeded** |
| `sync_state` | key/value: `pull_cursor`, `last_acked` and `pull_hold` — a place in one group's log, forgotten whenever the group changes — `last_sync_at`, the `applying` guard, the entitlement tokens the hosted relay design §10 adds, the superseded group keys (`group_key@<epoch>`) and the last manifest's ids that `identity::supersede` keeps, and `relay_url` — which is **a test/dev override with no UI**, not something a reader types |
| `sync_peers` | per-device watermarks — what makes a counter idempotent |
| `sync_gone` (v54) | tombstones as rows saying a parent went — not the `del` ops in `sync_ops` that are also called tombstones — `(tbl, uid)` and `WITHOUT ROWID`, **not synced**: one row per deleted row of a table other rows are filed under, written by the `sync_gone_{table}` trigger and, for a row `apply` never held, by `apply::tombstone`, and read by `apply`'s `gone` (*Held while it can resolve, skipped when it cannot*) |
| `error_log` rebuilt | `source` gains `'relay'`, which is a table rebuild because the vocabulary is inside a `CHECK` |
| `sync_devices.baselined_at INTEGER` (v30) | when this peer was last handed a baseline. NULL is "never", which is the trigger. **`sync_peers` is deliberately not consulted** — see the pairing-baseline design §10 |

**`ALTER TABLE … ADD COLUMN` refuses a non-constant `DEFAULT`** — verified against 3.53.0, which
answers `Cannot add a column with non-constant default` — so the uid arrives as a plain nullable
column and is backfilled by an `UPDATE`. A `CREATE TABLE` *would* take
`DEFAULT (lower(hex(randomblob(16))))`, and that is exactly why it is not used: the column has to
read the same in an upgraded file as in a fresh one, and
`the_user_schema_is_byte_identical_to_what_the_ladder_builds` compares the two.

**The rung spells its eleven `ALTER TABLE`s out and does not read `SYNCED_TABLES`.** A migration
step is history the day it ships: a step that read the constant would try to alter a twelfth
table that will not exist until v30, on every database that climbs through v29 afterwards.

**`sync_clock` is seeded in the rung *and* in `USER_SEED_SQL`.** Every capture trigger joins it,
and a join against an empty table produces no row — so a file that never got the seed records no
ops at all, silently, which is the worst way for a sync to not happen. The rung reaches upgraded
files; the seed reaches converted and fresh ones.

The user side is **twenty-two tables and thirty-six indexes** now, up from eighteen and
twenty-three.

---

## Measurements, 2026-08-28

### Capture over a bulk import — release, 50 000 `collection_entries` rows in one transaction

| | | |
| --- | --- | --- |
| no triggers at all | 317.3 ms | 1.00× |
| triggers, unpaired — the uid mint alone | 708.5 ms | **2.23×**, 0 ops |
| triggers, behind the apply guard | 483.3 ms | 1.52×, 0 ops |
| triggers, paired | **1.340 s** | **4.22×**, 50 000 ops → 250 relay writes |

**4.22× is above the plan's own stop-and-report threshold, and it is reported rather than worked
around.** In absolute terms it is 1.34 s for fifty thousand rows, on the one operation spec §7.7
names as the only one near a free-tier limit. The breakdown above is a `#[ignore]` test
(`sync_engine::capture::tests::bulk_import_with_capture`) so the decision can be re-measured with
one command. The row worth reading twice is the second: **an unpaired device**, which is every
installation today, pays 2.23× for a feature it does not use.

### Re-measured 2026-08-29, and then decided: nothing changes

| | | |
| --- | --- | --- |
| no triggers at all | 318.98 ms | 1.00× |
| triggers, unpaired — the uid mint alone | 718.48 ms | **2.25×**, 0 ops |
| triggers, behind the apply guard | 490.59 ms | 1.54×, 0 ops |
| triggers, paired | **1.3637 s** | **4.28×**, 50 000 ops → 250 relay writes |

Within noise of the run above, a day later and on a different tree, so the figures are stable
rather than a one-off.

**Decomposing them is what settles it, and the plan's framing did not.** The third row is not a
remedy's result — it is *the cost of a trigger firing and its `WHEN` short-circuiting*, which is
**171 ms** per 50 000 rows. That is the floor of every guard-based approach, because each one
still installs the trigger and still asks `sync_state` a question per row. The uid mint on top of
it is only **228 ms**.

So **the whole achievable win for an unpaired install is ~228 ms on a fifty-thousand-row
import**, and no scheme reaches 1.00× while the triggers exist. "Gate the mint on paired-ness"
— the obvious idea, and not one any plan here proposed — buys exactly that 228 ms and lands on
the same 1.54× floor, in exchange for a new correctness obligation at the moment sync turns on:
the uid backfill would have to complete before the first baseline is built, or a freshly paired
device sends rows with no uid.

**And the remedy the plan named has nothing to reuse.** "Run the importer inside
`capture::suppressed` and seed its ops in one pass afterwards" was written before the baseline
was designed; [the baseline design](../superpowers/specs/2026-08-29-sync-baseline-design.md) §5.1
then decided, deliberately, that **baseline ops are never written to `sync_ops`** — they are built
in memory, sealed, pushed and forgotten, so that `sync_ops.counters` keeps meaning *deltas*. A
seeding pass therefore cannot borrow the baseline's machinery and would be **a second
implementation of the capture rule**, which is the drift the golden fence exists to prevent one
boundary over.

**Decided by Markus on 2026-08-29: record the decomposition and change nothing.** 1.36 s for
fifty thousand rows is not a user-visible problem; the paired remedy costs a second
implementation of a rule the triggers already own; and the unpaired case — the one that is every
install — is worth 228 ms. This paragraph is the answer to "the remedy is available and untaken",
which had been sitting here as an open TODO with no number attached to it. Re-open it if a real
import gets slow enough for somebody to notice, and re-measure with the one command above first.

### The v29 rung over a real user file — debug

`schema::tests::migrate_the_real_database_to_v29`, over a copy of the 788 406 272 B development
database converted and then wound back to 28: **14.35 ms**, 1 069 synced rows, every one with a
distinct uid.

| Table | Rows |
| --- | --- |
| `collection_entries` | 275 |
| `deck_cards` | 611 |
| `deck_categories` | 55 |
| `wishlist_entries` | 88 |
| `deck_audit` | 28 |
| `collection_folders` | 6 |
| `decks` | 4 |
| `deck_folders` · `wishlist_folders` | 1 each |
| `deck_labels` · `muted_tags` | 0 |

### The split, with the uid mint — debug

`split::tests::the_real_database_converts_with_every_row_intact`: **264 ms**, a **1 523 712 B**
user file beside a 787 075 072 B corpus, zero `foreign_key_check` violations. The user file was
1 323 008 B before v29; the eleven uid columns and their eleven unique indexes are the ~200 KB
difference, over 1 069 rows.

---

## The first end-to-end pass, 2026-08-29

**Two real devices over the deployed relay.** A Windows desktop and, as the second device, a debug
build of the Android app this repository had until 2026-09-27 — both off `main` at the
pairing-baseline merge, both driven over CDP. What the pass proved is about the engine and the
relay rather than about either platform, which is why it is kept.

**The relay was deployed for this pass and each device was pointed at it by hand**, through
`sync_state.relay_url` typed by the reader — which is what the app offered on 2026-08-29 and is
the only thing about this pass that has since changed. ⚠️ This paragraph said the address "is not
in this repository and never will be"; **corrected 2026-08-29** — one deployment now serves every
reader, its address is compiled in as `RELAY_BASE`, and it is public. See the relay section above
for why that costs nothing, and
[the hosted relay design](../superpowers/specs/2026-08-29-hosted-relay-and-patreon-design.md) §9
for the secrets that are not — **three of them**, per the correction in the relay section above.

### What was broken, and what it reads now

| | before | after |
| --- | --- | --- |
| Desktop collection | 275 entries | 275 |
| **Second device's collection** | **0 entries** | **275** |
| Ops deferred on the second device | 1, permanently | **0** |
| Ops applied on the second device | 0 | 1 069 |

The deferral was correct and permanent: the one captured op was a `put collection_entries` naming
a folder by uid, and the folder's own op had never been written, so it waited for something that
did not exist.

### The baseline, measured

| | |
| --- | --- |
| Ops in one baseline | **1 069** — the figure §11 of the design predicted, unchanged |
| `deck_audit` rows among them | 28 |
| Desktop build + seal + push | **694 ms** |
| Deferred | **0** |
| `needs_review` raised on either device | **0** — no resurrection, no broken cycle |
| One full 200-op stored relay row | **186 299 B**, against a 2 MB cap (`wire::tests`, debug) |

Both directions fired: the second device emitted its own baseline back and the desktop applied
1 070. The
second sync on each device emitted **0** — the marker holds.

### Every field agrees

```
field        desktop      second
entries      275          275
cards        330          330
unique       272          272
decks        4            4
folders      6            6
review       0            0
pending      0            0
epoch        1            1
roster       2            2
```

`value` is the one figure that differs by design: prices are corpus-side and each device builds
its own.

### The founding constraint, over the wire

A row holding **2** (`Aerith Gainsborough`, `fin` 4, nonfoil NM) was incremented on **both**
devices before either synced, then both synced. **Both ended at 4.**

That is the case worth driving rather than asserting, because the claim and the delta travel in
one pull page: 3 would be a lost update and 5 would be the baseline counting a delta already
inside its own claim. It is the whole of the design's §8.2 in one row of cardboard.

### Pairing, and a discovery

Re-pairing was driven end to end over CDP. Both devices independently derived the same six
digits — `144733` — before anything was confirmed, which is the property the ceremony exists for.

**The first Sync of the session answered `baselineOps: 0`, and that was correct.** Both devices
had revoked each other minutes earlier — each marked the other, 16 seconds apart, both landing on
epoch 1. The trigger skips a revoked peer,
so it did. It is worth recording that the *right* answer looked exactly like the feature not
working, and that the roster was what said otherwise.

⚠️ **This paragraph said "two devices that have revoked each other cannot recover on their own",
and the state it describes is no longer reachable.** ⚠️ **Corrected 2026-08-30.** It rested on
§7.6's rotation minting a key nothing distributes; the rewrap hop distributes it, so **the ordinary
removal now reaches every device that stays** and re-pairing by hand is no longer the only route
back from one. The mutual case that produced the reading above is closed from two directions
rather than repaired: with no membership the press is refused outright before anything moves, and
with one, only the *first* rotation is accepted — `/rotate` refuses an epoch that is not the
group's next, so the second device gets a 409, its removal simply does not happen, and it
learns from `/keys` that it is the one that was removed and leaves cleanly. Two devices can no
longer arrive at the same epoch holding two keys neither can read.

**What that pass observed is still worth keeping**: the *right* answer looked exactly like the
feature not working, and the roster was what said otherwise. The mechanism has moved on — a
removed peer is deleted rather than stamped, so `peers_needing` skips it by absence rather than by
reading the mark — and the reading a reader takes from a `baselineOps: 0` has not.

### Traps this pass paid for

- **A failed `sync_pairing_complete` clears the pending state**, so a mangled sealed key costs the
  whole handshake and the *second* attempt reports "There is no pairing in progress" — which
  names the wrong cause. Marshal the 224-char blob through `JSON.stringify`, never through shell
  quoting. ⚠️ **`sync_pairing_complete` left the IPC surface on 2026-08-31** — `complete`'s body is
  unchanged but now runs only inside `sync_pairing_poll`, reading the blob back from the relay
  rather than from an argument, so this specific trap can no longer be reproduced by calling a
  command directly. The lesson survives it: a malformed blob anywhere in this ceremony reports at
  the *next* step rather than at the one that produced it.
- **`cdp.mjs eval` right after launch can find the page mid-load**, where
  `window.__TAURI_INTERNALS__` is still `undefined`. That reads as the bridge being broken; it is
  a race, and `document.readyState` tells them apart.

## What is still owed

- ~~**The WebSocket fan-out**, with the CSP decision that comes with it.~~ **Built 2026-08-31** —
  see [the live-sync design](../superpowers/specs/2026-08-31-live-sync-design.md) and "The
  WebSocket is built" above: `sync_engine::live` holds a hibernatable socket per device, opened
  from the Rust process rather than the page, so the CSP decision this bullet expected never had
  to be taken. There never was a poll for it to replace either — the record's own confusion about
  that is history now, folded into the section above rather than repeated here.
- **`pull` has no page size, and the doorbell is what turns that from a latent hazard into a
  routine path** (spec §8). `group.ts`'s `pull` returns every envelope past the cursor in one
  response and `client.rs:917`'s `response.text()` has no cap, so a peer offline through a
  50 000-row import pulls 250 envelopes in one body — **~46.6 MB**, held as row strings plus the
  `JSON.stringify` copy at **~95 MB inside a 128 MB isolate shared with every other group's**
  Durable Object, and over 150 MB peak on the pulling device. This is reachable today at
  `wire::BATCH = 200` and has nothing to do with automatic sync — what automatic sync changes is
  how often the path is taken: a `head` frame that wakes a peer holding a 250-row backlog *is*
  this path, where before it needed a reader to press **Sync now** by hand onto a device that had
  been stale for a while. The fix is a `LIMIT` on `pull` plus a cursor-carrying loop on the
  client — a change to the pull contract on both sides, with its own tests — and it is the next
  PR after this one; a live two-device pass must not import 50 000 rows against an offline peer
  until it lands. ⚠️ **Since 2026-09-27 the loop has a second obligation: it must page to the end
  before a hold is evaluated.** A client that held its cursor on the first page of a limited answer
  would ask for that page for ever and never reach the one that resolves the hold (*Held while it
  can resolve, skipped when it cannot*, above). A held cursor also makes this hazard easier to
  reach, because the held page is re-sent on every trip and grows with everything the group writes
  until the hold ends.
  **Measured 2026-10-04, in a browser against the relay's own code under workerd — and still not
  built by that step** ([light-app.md](light-app.md) §10.5, `npm run web:sync-pull`). The
  estimate above was right about the relay and low about the device. A 50 000-op import was a
  **44.6 MB** response (33.6 MB on the wire) for ops of 890 B sealed. **On the relay, read
  request by request with its heap collected between them, a pull costs twice the log and a
  compaction costs it once**: the pull took the isolate's JS heap from 1 to **90 MB**, the ack
  behind it — whose moved cursor runs `compactNow` over every row, body and all — from 1 to
  46 MB, and the importing device's own trip, whose pull reads the rows it has just pushed in
  order to drop them, another 44 MB. So one pull passes production's 128 MB at a log of about
  64 MB, some 72 000 such ops, and a compaction passes it only near the quota; local workerd
  refused none of it. (A first reading of the same runs said 143–157 MB at 50 000 ops: that
  was the run's peak, garbage between requests included.) The pulling engine's linear memory
  went from 21 to **570 MB** — twelve times the response at every size measured — and it
  answered no command for the **29 s** the page took to apply, the whole of `client::pull`'s
  one stretch. At 10 000 ops: 8.9 MB, 5 s, 131 MB. Being live does not avoid it — 250 `head`
  frames became three pulls, the largest 25.5–27.6 MB. The largest answer there can be is the
  group's quota, 128 MiB of sealed text, about 150 000 such ops. And the browser's
  whole-request deadline (120 s) is a floor on the link: a pull that misses it is abandoned
  with the cursor where it stood and asked for again from its first byte. That section has the
  design as a reviewer corrected it — pages in `seq` order under a budget the relay enforces,
  a page that would hold carried into the next rather than decided, the unpaged answer kept
  byte for byte for every released desktop but streamed, and compaction by length — which is
  being built as step 6.5b.
- ~~**A deferred op is dropped, not held.**~~ **Built 2026-09-27**, in the release that carries
  user schema v52 — *Held while it can resolve, skipped when it cannot* above. A newer sender's
  change is held until this device upgrades, a parent that may still arrive for a bounded wait, and
  a same-version change that can never apply is skipped, recorded, without its sender's later ops.
  ⚠️ **What it cannot reach is a v51 client**, which still steps past a deferral: every device in a
  group is updated before it syncs across v52.
- ~~**A first-contact parent carried by a real baseline may be skipped as seen**, so the waiting
  hold may not save the case it was built for (parked at the delivery holds' final review,
  2026-09-27; older than the holds, read off the code and unmeasured). Baseline ops are stamped
  from each row's `updated_at`, and an emitter's ordinary deltas earlier in the page set its
  watermark here — so a parent in the baseline stamped below that watermark is skipped rather than
  applied, and its child waits out the bound. The horizon exempts baseline ops from its own filter
  and not from the watermark. It needs a client test with an earlier emitter delta and the parent
  drawn from `baseline::build`, where the holds' tests seal the parent by hand.~~ **Closed
  2026-10-03 for an emitter on this build**, by claims that name their emission: no watermark
  judges one (*A claim names its emission*, above), and
  `a_first_contact_parent_below_the_watermark_lands_with_its_child` draws the parent from
  `baseline::build` behind an earlier ordinary op of its emitter's and lands it with its child on
  the first delivery. **An older emitter's baseline keeps it**, judged by `main`'s rules (the next
  bullets).
- **A resumed emission, or any active emission while this device has a gap, floors the rows held
  here — and a floor takes back a removal, or reinstates a note, made here in the window before it
  lands** ([the claim emissions design](../superpowers/specs/2026-10-03-baseline-claim-emissions-design.md)
  §11). It is the one window in which the log cannot be trusted to be whole, and the baseline
  design's §8.2 chooses the floor there on purpose: an under-count is accepted, an invented card
  never. Pinned as it stands:
  `a_dropped_group_opens_the_gap_and_the_next_emission_floors` removes a copy here while the gap is
  open, and the next emission raises it back.
- **A re-emission after a half-sent baseline writes again what the first half built** (§11, read
  off the design and unmeasured). The second attempt has a new `id`, so its claims are a new
  emission and a row the first half built is written by them again; a change made here between the
  two attempts can lose to it. No test pins it.
- **A third device's delete, applied here, and a later active claim for that row resurrect the row
  here only** (§11). `sync_gone` records parent tables alone, so nothing remembers a deleted
  `collection_entries` row, and a claim from a generation not yet taken here reads it as a row
  never held and builds it. Pinned: `a_rebroadcast_takes_back_nothing_this_device_did_since`'s
  untaken delete (1 row on the peer, 0 everywhere else), and the narrow fix's two ports,
  `a_claim_is_not_let_through_for_a_row_the_page_deletes` and
  `a_claim_is_not_let_through_for_a_row_deleted_before_its_page`, each asserting it with the words
  "owed (design §11)".
- **For a day after the upgrade, a re-baseline from an upgraded emitter behaves as before** (§11).
  Every emission named at or below `emissions_since` is judged by `main`'s rules, which is the
  price of never counting twice a page an older build of this device already applied
  (`a_page_an_older_build_applied_writes_nothing_again_after_the_upgrade`).
- **An older emitter's baselines keep every loss *A claim names its emission* measured** (§11), the
  original same-second `+1` among them, until that device is updated: no `emission` field, so
  `main`'s rules. No test pins the loss; `apply/tests.rs`, which never sets the field, is `main`'s
  rules unchanged.
- **A device that resumed before this build sends `since: 0` and no `resumed`** (§11, unmeasured).
  It left and rejoined under an older build, so nothing on this one ever minted its generation,
  and its first emission after the upgrade writes nothing on rows held elsewhere: edits it made
  while out of a group before the upgrade, and never re-emitted, stay where they are. (A device
  that left under an older build and rejoins on this one *does* resume — a `sync_peers` row says
  so.) No test pins it.
- **A grain rename that races a regrade keeps `main`'s under-count** (§11). A third device's twin,
  stamped below the regrade, renames the row here to its own lower uid; the regrade finds its uid
  gone and is dropped, and the claim for the merged-away uid is passed for good — so the emitter
  holds the regrade and this device never does. Under, never over:
  `a_claim_let_through_does_not_outlive_its_row_renamed_in_the_same_page` asserts `main`'s answer
  with "owed: main's grain rename drops a's regrade; the narrow fix's floor reached 4".
- **A first pairing between overlapping collections passes the emitter's claims for a twin this
  device absorbed** (§11, ruled at the `retired@` change). Where this device's twin wears the lower
  uid, the emitter's uid is retired here on the first meeting, so the emitter's later claims naming
  it — until it hears the lower uid and renames — are passed rather than merged by `max`. An edit
  the emitter made on that uid in between is dropped here as an unknown uid, which opens the gap,
  and stays lost until the emitter's next emission under the lower uid floors it. Asking the grain
  at decide time, to block only the build and still merge into the twin, would keep it; it was
  judged not worth the surgery. `a_later_claim_never_builds_a_uid_this_device_absorbed` pins the
  pass, not the lost edit.
- **Every pairing absorbs the other device's `Recently removed` folder, and its deck-group
  folders, the same way** (read off the code at the same change, unmeasured): they meet on the
  grain under two uids, so a field edit to one made on the emitter before it renames is lost here
  until its next emission. App-owned folders refuse a reader's edits, so in practice it is cosmetic.
- **`retired@` marks are never pruned, and they outlive their survivor.** One `sync_state` row,
  about 100 B, per merge `apply` makes, for the life of the install. A survivor deleted later still
  passes every claim for the uid retired into it — an under-count only, and it never rebuilds a row
  the group deleted.
- **The gap never closes in a mixed-version group** (found at the final review, read off the
  code). It closes once every roster device this one holds a watermark for is taken again, and only
  a referenced emission is ever taken — so an older-build peer on the roster, whose ops this device
  has applied, holds it open for as long as it runs an older build, and every active emission from
  an upgraded peer floors the rows held here meanwhile. That is `main`'s behaviour — `main` floors
  with every claim its watermark does not skip as seen — so it is never below it; what is lost is
  the held-row arm's pass, so a floor can take back a removal made here in the window before it
  lands (the item above on a resumed emission, or any during a gap), until the last device is
  updated. No test pins it.
- **A joiner's partial roster can close the gap early** (found reviewing the generation's
  identity change, read off the code). A device that has just joined knows only itself and its
  initiator until it adopts a manifest, so `close_gap_if_whole` can find every roster peer taken
  once the initiator is, before the rest of the group has emitted to it. Under-count only: a gap
  closed early passes held-row claims a floor would have raised.
- **A `too_large` the relay keeps refusing starves every baseline** (`Deferral::TooLarge`). Its
  batch is one this device measured as fitting, so it is refused on every trip and its ops stay
  pending for good, and no baseline is begun while anything is pending. It needs the client and the
  relay to disagree about a size the client cuts under, which nothing has seen.
- **A held page with an unreadable envelope reopens the gap on every re-delivery** (found building
  the client's half, read off the code). `pull` opens it when it steps an envelope over, and a
  page held for another reason is handed back with the same envelope until the cursor moves past
  it, clearing every `taken@` again each time. Conservative — floors, never an over-count — and
  strictly early: the cursor has not passed the envelope while the page is held.
- **The ledger keeps four records an emitter, and a record that wrote can still be evicted**
  (`RECORDS_PER_EMITTER`, read off the code after the final review's fix). This item used to say
  a page needed four newer emissions behind it to lose its record; one supersession was enough,
  because `take` dropped every other record of its generation — the final review's C1, fixed
  above. Now a record whose claims wrote a row is kept until four newer records that also wrote, or
  are being stored, push it out: records that wrote nothing go first, and a record from before a gap
  keeps its `wrote` set and ranks with them. **What it still costs**: a page handed back that
  carries an emission whose record was pushed out — after four more emissions of one emitter that
  each wrote here, which takes a first contact or a gap for each, since a held row's claim writes
  nothing otherwise — finds no record and counts the puts that emission carried again; the likely
  road is a full re-read after `forget_log_position`. And a record of an *older* generation is still
  dropped by `take`: a half-sent emission from before the emitter rejoined loses its evidence when
  one from after it is taken, which a resumed emission's floor normally covers, since its own claim
  for the row writes. **And a record from before a gap that wrote nothing is still the first to
  go**: it ranks with the empty ones, so `keep` can evict it, and its emission re-delivered comes
  back as a fresh record — one recorded after the gap, which can be taken and close the gap that
  the before-gap mark was holding open. Under-count only: a gap closed early passes held-row claims
  a floor would have raised, and the record held nothing a page could count twice.
- **`take` ranks the record it takes as evidence even when it wrote nothing** (read off the code
  at `b4406e6b`, after the final re-review; a code minor, parked). `take` hands `emission::bound`
  the taken record's own `id` as the record being stored, so a taken record whose claims all passed
  — whose `wrote` set is empty — ranks with the records that wrote and can push out a kept
  superseded record that wrote: exactly the evidence the final review's C1 keeps. It needs four
  records of one emitter that wrote held at once besides the one being taken. What it costs is C1's
  own shape — a page handed back with a put the pushed-out record's claim carried counts it again.
  One fix would rank the taken record by its `wrote` set alone: it is complete, so it is no longer
  progress that needs protecting, and a record that wrote nothing proves nothing for containment.
- **C2's fix trades one correct answer for `main`'s loss, in one shape** (read off the code at
  `b4406e6b`, after the final re-review). `decide` leaves a covered put to `inside` wherever the
  horizon of an older baseline in the page — no references, or stripped at the cut — covers it
  (`Decided::older`), because that older claim carries it. Where the older claim for the put's row
  is itself skipped as seen by the watermark — `main`'s rules — while the newer emission's claim for
  the row passes on a held row, nothing writes the put: before the fix it took the op path and
  landed; now `inside` drops it, and it is lost exactly as `main` loses it — the spec's §11 loss of
  an older emitter's baselines, the original same-second `+1` among them. It is within §10's "never
  worse than `main`" and §8.2's direction, an under-count; it ends when the older emitter is
  updated. No test pins it.
- **A row whose last copy goes is deleted before its fields are written, so a field that cannot be
  written no longer stops the group** (found at the `update_row` change, read off the code and
  unmeasured). `update_row` now decides every counter before it writes anything, and on
  `Floor::DeleteAtZero` — `deck_cards` and `wishlist_entries` — it deletes the row there and then.
  The field pairs used to be written first, so a group whose field write fails a constraint — a
  grain collision, or a `CHECK` a newer schema's value fails — rolled back as `Unbuildable`,
  dropped and recorded (or held, where a newer schema sealed it). Where its counter also reaches
  zero, the delete now consumes it: the row goes, and no `error_log` row says a field was refused.
  It follows the counter rule — the last copy gone is the row gone — and nothing records it.
- **A held-back baseline op whose reference `decide` would strip on the page holds nothing**
  (found at the held-back change, read off the code). An emission named at or below the upgrade
  cut, or a claim whose chunk head is not in the page, is judged on the page as an op with no
  reference — `main`'s rules, under which it can hold its row. Held back by the client, it is still
  a claim to `claims::claim`, so `apply_in`'s filter, which keeps only ops for which that answers
  `None`, leaves it out of the held-back ops and it joins no group. Not a regression — `main` held
  nothing back at all — but the two paths disagree about it.
- ~~**A folder deleted and re-made at the same grain in one page, whose delete also had to wait,
  loses the re-made row where its uid sorts higher.**~~ **Closed on the same branch, the same day**
  (the folder-deletes design §3.3 as amended). It was recorded here read off the code: the re-made
  row's put grain-matched the old row the waiting delete was about to take and kept the old uid by
  `min`, and the retry then deleted it. The case named was a deck switched to Virtual and back
  between two pulls, with a copy in its group the root also holds; Task B's review found the
  ordinary one, `reset::clear_collection`, which re-makes `Recently removed` and every deck group
  in one write. A grain match onto a row the page deletes now adopts the incoming uid, and a group
  whose own ops end in a delete finds its row by uid alone (*A delete that would clear rows out of
  a folder waits for the retry*, above). Kept as the record of why both rules exist.
- ⚠️ **A row the peer filed concurrently into a folder the sender re-made follows the rename there
  and lands at the root on the sender** (the folder-deletes design §3.5, read off the code at the
  scoped re-review, unmeasured). On the peer the old folder takes the re-made one's uid, so the row
  filed into it stays filed; on the sender that folder's old uid is a delete, its key is
  `SET NULL`, and the row's put lands at the root. Counts and identity converge; placement does
  not.
- **A copy re-homed onto a twin the sender never had can leave one `error_log` row describing no
  fault** (the same design §3.5, read off the code and unmeasured). The sender's own later move of
  it names the uid that lost the fold, finds no row, and is skipped. Counts and identity still
  converge: the sender adopts the twin's uid when the twin's put reaches it.
- **Provenance can differ after a concurrent merge** (the same design §3.5, read off the code and
  unmeasured). The re-homing coalesces the survivor's price, date, source and entry note over the
  source's, where the sender's grain match takes each field by last-writer-wins. Counts and identity
  converge; a field both rows carried may not.
- **A sparse edit under the losing uid, on a later page, is still skipped** (the same design §3.5,
  read off the code and unmeasured) — `find_row`'s existing behaviour after any grain merge, and
  not new here.
- ⚠️ **A copy the peer dragged into a binder the sender deletes, where the root holds its twin,
  ends as one row on the peer and two on the sender** (the same design §3.5, parked at the final
  review, 2026-09-27, read off the code and unmeasured). On the peer the sender's delete re-homes
  the dragged copy and folds it onto the twin. On the sender the drag arrives as a sparse move
  naming the binder, which is gone, so the `SET NULL` arm writes it without the folder — and
  `update_row` fails `idx_collection_grain` against the twin at the root, so the move is
  `Unbuildable`, dropped with an `error_log` row, and the copy stays where it was before the drag.
  Totals converge; rows and uids do not. **Older than this work**: a move applied from a peer onto
  an occupied grain has never folded, and this is only newly *reachable*, where the old delete arm
  stalled on it. A copy the peer *added* to the binder is not this case — its put grain-matches
  the twin (`a_copy_filed_into_a_binder_the_peer_deletes_meets_the_roots_copy_as_one_row`). The
  fix is a fold, not a refusal: where the `SET NULL` arm's update would collide, fold
  through `collection_folders::refile_entry` / `wishlist_folders::refile_wish`, the survivor
  keeping the lower uid, as the delete arm's re-homing does. No test pins it either way.
- ⚠️ **A page carrying a `del X`, a third device's resurrecting edit of X and a new put Y on X's
  grain renames X to Y** (parked at Task B's scoped re-review, 2026-09-27, read off the code and
  unmeasured). The incoming-uid rule above is keyed on the page's delete set: X's own group folds
  to a row that exists — the third device's edit beat the delete, add-wins — but X's uid is still
  in the page's deletes, so Y's put grain-matches X, takes Y's uid, and X's later sparse edits find
  no row and are skipped. **Older than this work, not introduced by it**: before the rule, the same
  page lost the other way — under `min` the resurrection's insert collided on the grain and was
  dropped.
- **An open Sync panel can show a stale `pullHeld`.** `RelayStatus` is under `SYNC_KEY`, which
  `useDeviceSyncInvalidation` refreshes on `sync:applied` — and `live::trip` and `sync_now` emit that
  only when a trip pulled or pushed something, while `pulled` counts newly applied ops only, on
  purpose. So a background trip that starts a newer hold and pushes nothing draws no *Update this
  device* on a panel already open, until something else refreshes it (parked at the same review;
  a press of **Sync now** refreshes it through its own mutation). **The clock hold (issue #546)
  has the same gap**: a trip that starts one applies nothing, so an open panel draws
  `PULL_HELD_CLOCK_NOTICE` only once something else refreshes `RELAY_KEY`.
- **What a pull refreshes is derived, since issue #546**, and it used to be a hand-written list
  that had fallen behind. `DEVICE_SYNC_INVALIDATED` was `OWNED_WRITE_KEYS` plus `SYNC_KEY`, so a
  pull refreshed no sticky notes, no muted tags and no card holdings — and WebView2 never fires
  `visibilitychange`, so the focus refetch never ran either; a sticky note edited from the stale
  text then overwrote the other device's edit. It is now `crossWindow.ts`' `keysForTables` over
  `src/lib/syncedTables.json`, reduced to outermost roots plus `SYNC_KEY` — `["collection"]`,
  `["wishlist"]`, `["decks"]`, `["cards"]`, `["card"]`, `["sync"]`, the four tag roots and
  `["stickyNotes"]`, never `["sets"]` — and `changes.rs`' test holds the JSON to `SYNCED_TABLES`.
  `useDeviceSyncInvalidation` refreshes that whole set only when a trip **changed** something
  (`RelayOutcome.changed` — applied or mooted an op, brought a row back, broke a folder cycle, or
  ran a conversion behind its pull); a push-only trip — the one every local write ends in —
  refreshes `["sync"]` alone. It gated on `pulled > 0` for one review round and missed a pull that
  only mooted: the moot arm deletes rows and counts them in `moot`, never in `applied`.
- ~~**A removed device's ack pins the relay's compaction floor.**~~ **Fixed with issue #546, and
  deployed 2026-09-28.** `compact` took its floor as the lowest ack of every device the object had heard
  from, and nothing but a membership's end ever deleted an ack — so a removed device, a departed
  one and a wiped reinstall each stayed the slowest reader the group had, and nothing above its
  last ack was compacted again. Now an accepted rotation posts its roster to the object's internal
  `/roster`, which departs every device the manifest omits, and a device unheard for ninety days
  (`ACK_TTL_MS`, `heard_at` stamped by every ack and refreshed by a pull at most daily) leaves the
  floor too. [relay/README.md](../../relay/README.md)'s *Who the log waits for* has it in full. What
  it leaves is the next three bullets.
- **A device away more than ninety days comes back to a log compacted past its cursor, and nothing
  on the wire tells it** (read off `log.ts`, unmeasured). The rows between its cursor and the floor
  are gone, and it pulls on as if nothing were missing. The fix is the relay answering the highest
  seq it has compacted, so the client can see its cursor fell below it and ask for a baseline; not
  built. It is the same season `DEVICE_TTL_MS` gives a device's slot, chosen against the same
  drawer.
- **A removed device the object never heard from before its removal is not marked departed**
  (read off `log.ts`, unmeasured). A roster departs only devices the object knows — the direction
  that keeps rows — so a device removed before it ever pushed or acked is not in `departed`, and if
  it acks within its token's last day it is enrolled and pins the floor until the ninety days or the
  group's next roster.
- **A device already gone before the relay deploy keeps pinning** until the group's next rotation
  posts a roster, or ninety days after the deploy (read off `group.ts`'s constructor, unmeasured).
  The migration backfills `heard_at` with its own moment rather than zero, so no live device drops
  off the floor at the deploy — which also counts every long-gone one as heard that day.
- **A third device's tombstone against a third device's edit.** (The tombstone here is a `del` op.)
  Add-wins reads this device's own history and the incoming batch; two *other* devices' ops only
  meet if they arrive together. This said a tombstone table would close it; **user schema v54
  built one, and it does not**: `sync_gone` holds tombstones in the other sense — a uid saying a
  parent went, with no stamp, only for the tables other rows are filed under — and add-wins does
  not read it; it answers `gone` alone. **The delivery holds met the same gap from the other side** —
  a parent deleted on a third device and applied here earlier left no trace, so its child waited
  out the bound and was skipped — and that half *is* closed by v54, for a delete applied from then
  on (*What a hold cannot reach*, above).
- ~~**A revoked device's rewrapped key over the relay.**~~ **Built and deployed 2026-08-30** —
  `/rotate` publishes it, `/keys` hands it over, and `client::check_keys` runs on every round trip
  before push and pull, so the pull cursor an envelope from a newer epoch was holding now advances
  on its own. See §7.6 above. ⚠️ **This bullet said "the deploy is what is left … none of it has
  ever executed against a live Worker" for part of that same day**; both routes now answer on the
  host, and step 2 of the runbook records what the deploy itself found.
- ~~**A `Leave group` press.**~~ **Built 2026-08-30** — `sync_group_leave`, and a press on the
  panel beside *Pair a device*, drawn on a paired device and on no other. See "The departure"
  under §7.6. What it is still owed is the **live pass**: leaving on one device and watching
  another's roster lose it, which is the check that found the group-key migration gap on its first
  press.
- ~~**The device cap is not deployed.**~~ **Deployed** — found live on 2026-09-28, when
  `POST /token {"refresh":"x"}` with no `device` answered `400 that is not a device id`; nobody
  wrote down which of the 2026-08-30/31 deploys shipped it. What it is still owed is the runbook's
  item 11: nothing has driven a real sixth device into the cap, or a real `keepOnly` free a slot.
- ~~**No WebSocket fan-out for the rewrap either.**~~ **Partly built 2026-08-31** — `check_keys`
  runs at the top of every round trip, so a removal is now picked up by *whatever* wakes a device:
  a `head` frame, a local write, launch, a reconnect. ⚠️ **This bullet claimed "within a few
  seconds of the next `head` frame" for part of that day and it is false — there is no frame.**
  `index.ts` answers `/rotate` and `/keys` ahead of the bearer gate, out of D1, precisely because a
  rotated-away device cannot mint a token. **Since issue #546 an accepted rotation does reach the
  Durable Object — once, and only to post its roster** (`/roster`), which departs devices and
  compacts and sends no frame: `notify()` is still called from `push` and nowhere else, so nothing
  broadcasts. **A quiet group therefore still learns of a removal at its next trip for some other
  reason**, which on an idle device is the next launch or the next reconnect. Still a large
  improvement on the manual press it replaced, and still not a fan-out. Closing it properly means
  either a frame sent from the roster post — which no longer needs the rotate to reach an object it
  avoids, only the handler it already reaches to send one, best effort like the post itself; not
  built — or the removing device pushing something after it publishes.
- ~~**A round trip holds the write connection across the network, so a user edit can be told the
  database is busy.**~~ **Closed 2026-10-03**, by the change the last sentence of this bullet
  asked for: the connection is held only for the statements that need it, and the failure mode it
  named — a push and a concurrent edit interleaving on `sync_ops` — is the one a test now lands
  behind every stretch of a trip. See *A trip holds nothing across a request*, below. What this
  bullet said: `live::trip` and `commands::sync_now` both wrap the whole of
  `client::run_once` in `sync::with_write`, and that closure is `check_keys` → `push` → `pull` →
  `emit_baselines` → `ack` — five HTTP requests, one of them a `push` that loops a batch at a
  time. A write the reader makes while one is in flight waits out `db::WRITE_LOCK_WAIT` and then
  answers `db::BUSY`: *"the database is busy finishing a sync"*, after five seconds, over a
  keystroke. **It is not new** — that is the shape `sync_now` has always had, and pressing the
  button has always been able to do it — but automatic sync makes it reachable without a press.
  Two things keep it rare rather than fixed: trips are single-flight, and since the outbox gate
  the local-write trip fires three seconds after writing goes *quiet*, so the reader is usually
  not mid-edit when one starts. Fixing it properly means holding the connection only for the
  statements that need it and letting the network happen outside — a change to this crate's write
  discipline with its own failure modes (a push and a concurrent edit interleaving on `sync_ops`),
  and it needs a spec rather than a patch at the end of a branch.
- **`sync_ops` has no retention rule.** `pushed_at` is stamped and the row is kept, because the
  log is also this device's memory of what it did — add-wins and the cycle-break both read
  it. Nothing prunes it, so it grows for the life of the install: at the measured 453—698 B per
  op and fifty edits a day, that is a few megabytes a year, which is small beside a 787 MB
  corpus and is still unbounded. A pruner would have to keep whatever the two readers above can
  still need, which is a decision nobody has taken.
- ~~**Nothing has been driven in the shipped window.**~~ **Done 2026-08-29** — the relay is
  deployed and two devices converged over it. See "The first end-to-end pass" above.
- **The bulk-import cost.** 4.22× is measured and unaddressed; see above.
- **A persistent push failure still retries every ~3 s while the socket is up.** The outbox gate
  (`live::after_a_commit`, then `outbox_has_work`) improved this — before it, *every* commit rang the bell whether or
  not there was anything to push — but it did not close it: a failing trip leaves its op
  `pushed_at IS NULL`, so the next commit (the trip's own `error_log` row among them) finds a
  pending op, the gate answers `true`, and `schedule.rs`'s `WRITE_DEBOUNCE_MS` fires the next
  trip three seconds later. `schedule.rs`'s `backoff_ms`/`deserves_backoff` govern the
  **socket** — how long `connect_once` waits before dialing again after a disconnect — not the
  trip ladder, so a trip that keeps failing over a socket that stays up has no error backoff of
  its own.
- ~~**`Wake::Resume` is declared but never constructed.**~~ **Deleted 2026-09-27**, with the
  foreground gate it belonged to (`live::resume`, `live::pause`, `Disconnect::Paused` and the
  `sync_live_foreground` command), when the Android build was removed. `connect_once` fires
  `Wake::Reconnect` on every socket that comes up, which was always the catch-up.
- **`WAKE_LOCK_WAIT`'s one-second timeout can drop a single wake.** `after_a_commit` tries the
  write connection for one second and answers `false` on a miss rather than waiting longer or
  asking again on its own. If another writer holds `state.db` for longer than that with no
  further commit to ring the bell a second time, that wake is lost. Self-healing in every case
  examined — the competing writer is usually a `sync_now` press that pushes the very op the
  missed wake would have pushed — but it is the one way the gate can fall quiet with real work
  still in the outbox, and it was undocumented until now.
