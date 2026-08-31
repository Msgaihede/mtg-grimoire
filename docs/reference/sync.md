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
windows side by side, or a phone photographing a laptop, complete a pairing with the app
offline.

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
were both retyped by hand — the second one phone→PC, the hard direction — through
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
  now (`accept`, `confirm`), so they and `poll` run on the blocking pool with a runtime of their
  own — `sync_device_revoke`'s shape, for its reason: the write connection is behind a `Mutex`, a
  guard cannot cross an `await` on a multi-threaded runtime.

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
secret can re-register the group's auth and therefore evict the devices that removed it** —
`/rotate` takes the refresh secret as its second door (§2.4 of
[the group-wide design](../superpowers/specs/2026-08-30-group-wide-membership-and-removal-design.md)),
so leaving it on every paired device would have made a removal something any of them could
reverse. Restricting the Patreon-side secret to the device that pressed Connect is what makes a
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

`AppState.pairing`, a `Mutex<Option<Pending>>`. An offer that survived a restart would be an
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
and the six digits would become the sole defence by the back door. It also sidesteps a web-target
problem: the app shell answers any navigation once its service worker is installed, but a QR scan
is by definition a first visit, and a path-shaped deep link would need a server rewrite that does
not exist — the server only ever sees `/pair`.

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

⚠️ **This paragraph named a third thing — an `intent://` link into the Android app, "gated on
`/.well-known/assetlinks.json`" — and both halves were wrong, so both are gone (2026-08-31).**
`assetlinks.json` gates an `https` **App Link**; it has never gated a custom scheme, and the app
declared no `mtggrimoire` scheme, so that button was dead on arrival. Worse, the App Link it was
paired with was a *trap*: nothing in this app reads a launch intent, so the day a real signing
fingerprint went up, Android would have started handing `https://…/pair#<code>` to the app instead
of the browser — the app opening on its ordinary window with the code nowhere, and this page,
which is the only thing that shows a camera-app scan to the reader, unreachable from a scan. The
button, the `autoVerify` intent-filter and the `assetlinks.json` route are all removed;
`relay/src/pair.ts` and `gen/android/app/src/main/AndroidManifest.xml` each carry the argument at
their own site, and [the deploy runbook](hosted-relay-deploy.md) records that its step 9 was
deleted rather than deferred. Deep-linking into the app is a coherent follow-up whose *first* step
is the intent handling.

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
removed the phone. `identity::mint_name` is the fix, called from `ensure` on the insert and on
no other path.

| Target | What it reads | Where it comes from |
| --- | --- | --- |
| Windows | `MAIN-PC` | `COMPUTERNAME`. Measured on this machine, 2026-08-29, debug |
| Linux / macOS | `HOSTNAME`, or `Desktop` | a shell variable that a process usually does **not** inherit, so the fallback is the ordinary answer there rather than the exceptional one |
| Android | `OnePlus 12` | `android.os.Build.MODEL` over JNI. **Not a hostname** — Android answers `localhost` on every handset, which would be the same bug one platform over |
| Web | `Chrome on Windows` | `navigator.userAgent`, read by reflection off the global so it answers in a Worker as well as in a page. A browser has no hostname and nothing to ask for one |

**Three arms because they are three different questions**, and every one of them is infallible:
failing to read a name must never stop a device minting an identity, so each falls back to a word
rather than returning an error.

**The privacy trade was made knowingly and is the reader's, not this file's.** The comment on the
old constant argued the other way — a hostname is often a person's own name and it would travel
to every paired device without anybody choosing to send it — and that cost is real and unchanged:
`sync_identity.name` is the copy `create_group`, `join_group` and `pairing::accept` all send. What
pays for it is that a roster a reader cannot act on is the worse failure, and that
`sync_device_rename` is still one press away on every row the panel draws, this device's own
included. That press is why the panel keeps **Rename** beside the pill rather than replacing it.

**Two dependency notes, because the obvious route for the Android arm does not work here.**
`jni` was already in `Cargo.lock` through `tao`, `wry` and `tauri`, so `Cargo.toml`'s line is a
direct edge rather than a new crate — `tauri-plugin-fs`'s case. **`ndk-context` is not in this
tree at all** and was deliberately not added: nothing calls `initialize_android_context`, so
`android_context()` would answer a null VM pointer and the model lookup would fall back on every
phone forever — code that compiles, ships and can never run. The VM comes from
`tauri::tao::platform::android::prelude::main_android_context` instead, which is where the runtime
this app is actually built on keeps the pointer the activity handed it.

**`ensure` mints on absence only, and that is what makes the change safe to ship.** An existing
install keeps whatever name it has — including "This device" — and a reader who renamed is never
renamed back. A version that recomputed the name per call would look like keeping the roster
current and would in fact undo a rename at the next command;
`a_renamed_device_keeps_its_name_across_every_later_ensure` and
`an_existing_identity_is_never_renamed_by_ensure` are what hold that, and both go red against
exactly that mutation.

**Nothing here asserts a literal hostname.** The value differs on every desk and CI is nobody's
desk, so the tests assert the shape: a non-empty name, not the placeholder every install used to
share, and the same answer twice. Only `browser_label` is checkable by value, because it is a pure
function over a string and the desktop suite is the one place it can run at all.

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
   `run_once` would hand thousands of ops to the very device this is about to remove.
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
new group, drop the roster rows the manifest omits, carry on — and the pull cursor `behind = true`
was holding advances on its own, which is the stall above resolving itself. Higher epoch with
**no** blob: this device was the one removed.

### The manifest is the roster

`group_keys.keys` is one JSON column holding `{"<device_id>": "<blob>", …}`, and **its key set is
the roster at that epoch**. A device that adopts *N+1* deletes every `sync_devices` row the
manifest does not name.

**That is deliberately not a thirteenth synced table.** A manifest that *is* the key distribution
cannot disagree with it, where a synced `device_removals` table could arrive late, arrive out of
order, or arrive at a device that cannot decrypt it — which is precisely the state a rotation puts
every peer in.

**A device with no blob at the current epoch was removed, and that is positive evidence rather
than an inference from a refusal.** It is why `/keys` accepts an auth up to eight epochs old
(`groupauth::EPOCH_HISTORY`): "behind a rotation" and "removed" otherwise produce an identical
stale-auth 401, and a device that guessed wrong would either leave a group it is still in or sit
for ever in one it is not. A removed device leaves fully — `identity::leave_group` clears
`sync_group` and `sync_devices`, and the caller clears the grant beside it — and the panel returns
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

A dialog that said only "Remove" would imply a lost phone had been wiped, which is the opposite
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
   leaver on every device that adopts, exactly as a removal does. Both entrances call one private
   `plan`. **The guard stays on `plan_rotation`** because removing somebody else and leaving
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
onCode={…} />` opens the camera, draws frames to a `<canvas>`, and decodes with `jsQR` — desktop,
Android and the later web build all get one implementation rather than three, because
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
against the threat a single-page desktop app has. The pipeline
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
digits are derived from the code with a plain hash and the QR is a picture of the right shape
rather than a readable code — the workbench has no X25519, no HKDF, no relay and no QR encoder.
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

**What a single window structurally cannot show, and what is therefore still owed.**
`tauri-plugin-single-instance` gives a second copy exit code 0 and no window, so **no pass on one
machine can complete a pairing** — everything past "read their answer" needs two devices. The
crossed halves ([§the two blobs](#the-two-blobs)) are covered by
`two_databases_pair_and_agree_on_the_key`, which drives two connections in one process; that is
the strongest evidence available until a second device exists, and the Android build merged on
the same day is the obvious one.

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

## What syncs: twelve tables, and the spec's twelfth still does not exist

`schema::SYNCED_TABLES`:

`collection_entries` · `collection_folders` · `deck_audit` · `deck_cards` · `deck_categories` ·
`deck_folders` · `deck_tags` · `decks` · `device_names` · `muted_tags` · `wishlist_entries` ·
`wishlist_folders`

**Twelve, and not for the reason the spec's own count would suggest.** The spec's list names
`deck_allocations`, which **schema v25 dropped** — which deck holds a card is now which folder
its row sits in, so the work that table did is inside `collection_folders`, which is on the
list. A table that does not exist cannot be synced, and that argument has not changed: it is
why `deck_allocations` stays off this list for good. What brought the count back to twelve is a
different table entirely — user schema **v31** added `device_names` (what each device in the
group is called), a table the spec predates and never named. Two tables have each been "the
twelfth" at different times, and they are not the same table: the spec's was dropped and is
gone for good, this tree's is real and the spec never spoke of it. The count moved twice; the
intent behind the first move did not.

Two further corrections, both found by reading `schema.rs` rather than the spec:

- **`deck_tags` has no `deck_id`.** Schema v21 rebuilt it as one app-wide list keyed on
  `name_key`. That matters here more than anywhere: two devices typing "Ramp" must converge on
  **one** row, because `idx_deck_tags_grain` is `UNIQUE (name_key)` and a second row is a
  constraint failure at apply time rather than a duplicate.
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
| `deck_tags` | `name_key` |
| `muted_tags` | `namespace, tag_id` |

`decks`, `deck_folders`, `wishlist_folders` and `deck_audit` have no grain and are uid-only.

**A table can have more than one grain, and three of them are PARTIAL indexes** — which the
plan's table misses entirely, and one of them matters from the first minute a group exists:

| Index | Grain | Why it fires |
| --- | --- | --- |
| `idx_collection_folder_removed` | `kind = ? AND kind = 'removed'` | **every database seeds its own `Recently removed`**, so two paired devices hold that row under two uids the moment they meet |
| `idx_collection_folder_deck` | `deck_id = ? AND deck_id IS NOT NULL` | one group per deck; two readers each pressing Clear collection rebuild one each |
| `idx_deck_categories_kind` | `deck_id = ? AND kind = ? AND kind <> 'main'` | a deck has one Sideboard, one Commander, one Companion and one Maybeboard, and a renamed one slips past the `(deck_id, name)` grain |

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

**The row handle in `apply` is the uid and never the rowid.** Ten of the twelve tables have an
`INTEGER PRIMARY KEY`; two have none at all — `muted_tags` is `WITHOUT ROWID` on
`(namespace, tag_id)` and `device_names` on `device_id` alone. Addressing by `sync_uid` is one
spelling for all twelve.

**Minting takes three sites, not one**, and only one of them is the ladder:

| Path | Who mints |
| --- | --- |
| an *upgraded* file | the v29 rung's `UPDATE … SET sync_uid = lower(hex(randomblob(16)))` |
| a *converted* file | `schema::mint_missing_uids` inside `split::extract_user_file` |
| a *fresh* file | `USER_SEED_SQL`, plus the capture trigger for every row written afterwards |

A converted file is the one that was missed first: a legacy `mtg.db` has no such column to
copy, and `split::convert` stamps *head*, so the ladder never reaches it. A NULL uid is not
cosmetic — `sync_ops.uid` is `NOT NULL`, so the first edit to such a row on a paired device
would fail **the reader's own write**.

---

## Capture: triggers, and three facts about SQLite that decide the shape

`sync_engine::capture` installs 31 triggers from one census — an insert trigger per table, plus
an update and a delete for the ten that are not `deck_audit`, plus one that advances the clock.
They are `DROP` + `CREATE` at every open and never `CREATE … IF NOT EXISTS`: a trigger is stored
SQL, and a build that changed the generator would otherwise leave every existing database
running last year's rules forever.

**Not the update hook, and not `preupdate_hook`.** `update_hook` — what `mirror::watch` uses —
gives the table and the rowid but **no values**. `preupdate_hook` does give values but fires
*before commit*, so an in-memory buffer is the only record of an op between the commit and the
drain, and a crash there loses an op: a device diverged for good, silently. A trigger runs
inside the caller's transaction, rolls back with it, cannot be forgotten by a write site added
next year, and is identical on native and on wasm.

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
survives a restart because the row is in the database.

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
arriving after a tombstone, which is **deferred** rather than lost.

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
the batch's latest stamp — `hlc::Hlc::observe` spelled in SQL, because `SystemTime::now()`
**panics on `wasm32-unknown-unknown`** and this module compiles for the web target.

### A deferred op holds the watermark

`sync_peers` is a *watermark*: everything at or below it has been applied. So an op that could
not be applied cannot be counted and stepped over — advancing past it loses it for good, and not
advancing replays the ops above it and **adds their counter deltas a second time**. Both are
silent.

**The whole of that device's stream stops at the block**, and that is stronger than it first
looks: the ops after it in the same page are not applied either, even when nothing about them is
unresolvable. It has to be. Applying them while holding the watermark below means the next pull
re-delivers them and applies them again — measured before the fix, one `+1` behind a blocked
op became a quantity of 2 on the second delivery of the same page.

So a batch that defers anything is applied **twice**: once to find out which devices stall, then
rolled back and applied again with the stalls known. The loop runs until no new device is found
blocked, which is at most once per device and in practice once.

A stall is visible in `ApplyReport::deferred` and self-heals when the missing parent arrives. A
block that *never* becomes appliable — a parent lost to compaction — stalls that device's stream
permanently, and that is the deliberate choice: it is the only one of the three that neither
loses an op nor doubles a counter, and it is the only one a reader can be told about.

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
new, and the epoch stops the reverse — a blob written before the rotation replayed at a device
that has moved on, which the key alone cannot refuse because the ciphertext predates it. Removing
any one of the three terms turns a test red.

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

`base64` joined the tree for one job. Hex was the alternative and is twice the bytes over the
wire and against that cap; base64 is four thirds and URL-safe.

---

## The relay: five group routes, three of them behind an auth gate

`relay/` is a Cloudflare Worker with one SQLite-backed Durable Object per pairing group.

| | | | |
| --- | --- | --- | --- |
| `POST {relay}/g/{group}/push` | one `Envelope` | 200 with the stored cursor | **bearer** |
| `GET {relay}/g/{group}/pull?since={cursor}&device={id}` | | 200 with `{ envelopes, cursor }` | **bearer** |
| `POST {relay}/g/{group}/ack` | `{ device, cursor }` | 204 — what compaction reads | **bearer** |
| `POST {relay}/g/{group}/rotate` | `{ epoch, auth, keys }` | 200 with the epoch; 409 if it does not advance | the group auth, or the refresh secret |
| `GET {relay}/g/{group}/keys?device={id}` | | 200 with `{ epoch, blob, devices }` | any auth this group has used in eight epochs |

**The last two are `/g/…` routes that stand *ahead* of the bearer gate, and the placement is the
point rather than an exemption.** A device that has just been rotated away from cannot mint a
token — the auth it would present to `/token`'s group door is stale by definition — so a `/keys`
behind the gate would refuse exactly the caller it exists to serve, and a removed device would sit
for ever in a group it is no longer in. Both are D1 reads and writes in the Worker and **neither
reaches the Durable Object**, which is what makes standing outside affordable: the gate is in
front of the DO because a request that reaches one costs a Durable Object request whether it is
honoured or refused, and nothing these two can be made to spend is on that line. The residual —
a removed device spending `/keys` reads until its auth ages out of the eight-epoch window — is
accepted for the same reason.

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
`relay/src/index.ts` carries the auth gate, `claim.ts` and `patreon.ts` the OAuth hop and the
webhook, `token.ts`, `entitlement.ts` and `md5.ts` the pure decisions the root vitest tests
without workerd, `groupauth.ts` and `rotate.ts` the group-key store, its two routes and the device
roll, and `wrangler.jsonc` a D1 binding and a daily cron.
**What is *not* deployed is this change's half** — the device cap, `/claim`'s rebind and the
`group_devices` table. Settled by the same kind of probe rather than by reading this file:
`POST /token {group, auth}` **with no `device` field** answers 401 from the entitlement lookup,
where the code in this tree answers **400 `that is not a device id`** before it reads anything.
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
`{sub, grp, exp}`, minted by the relay with a 24-hour TTL. The Worker checks signature, expiry
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
401 on the refresh door is a lapse: the grant is revoked and the panel offers Connect again. A 401
on the **group** door is `entitlement::STALE_GROUP_AUTH` and is *not* a lapse — the auth is
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
`EPOCH_HISTORY` — **eight** epochs — in the same statement that writes the new row, so the history
is bounded without a sweep. **A manifest is capped at `MAX_GROUP_DEVICES` and 4 KB per blob.**
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
kept working. **Both statements now carry the same guard — this epoch must be at least the highest
the group has — and both halves are load-bearing**, since dropping either one alone turns the test
red. Behind, the claim still succeeds and still mints a grant, because it is a legitimate press by
a paying reader; it simply leaves the key registration where it already correctly pointed. **This
is reachable through the ordinary repair rather than by contrivance**, and
[hosted-relay-deploy.md](hosted-relay-deploy.md) step 2 is where that matters.

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
`admitDevice` (count, then one `INSERT … ON CONFLICT DO UPDATE SET last_seen`, so a *returning*
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
keeps its log rather than compacting away the state that device has not seen.

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
and `/keys` are D1 only, carry their own credential, and are covered in the routes table above.
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
carries a real `database_id`, so the D1 exists too and may hold live rows. **What is missing today
is the device roll**: the deployed `/token` accepts a body with no `device` field, where this
tree's code refuses one with a 400. The next deploy is an update to a running service, and
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
   compile to `wasm32-unknown-unknown`."** True, and irrelevant once nothing on the wasm target
   names the crate: `tokio-tungstenite` sits in `Cargo.toml`'s existing
   `[target.'cfg(not(target_family = "wasm"))'.dependencies]` block, and every line of
   `sync_engine::live` — the only module that touches it — carries the same `cfg`, not just the
   dependency declaration. `sync_engine` as a whole still compiles for wasm, which `lib.rs`'s
   module doc states as the point rather than a bonus, and `npm run verify` cannot see whether the
   gate is right — only CI's `wasm` job builds that target.
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
   page was granted nothing. A fourth reason the record never named: a browser's own `WebSocket` constructor
   cannot set an `Authorization` header, so a socket opened from the page would have forced the
   relay's bearer gate onto a query parameter or a subprotocol — a relay change, and a worse one.
   Opening it from Rust keeps the existing gate unchanged.
3. **"Nothing polls, so nothing is being spent."** Correct at the time, and it was a reason to
   wait rather than a reason never to build it — see the cost below for what spending looks like
   now that something does.

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

What changed against the old manual baseline: a change made on a phone now reaches the desktop
within a few seconds, rather than at the next press of **Sync now**. What did not change: the core
still compiles to wasm, and the CSP still grants nothing.

**One correction to the plan, and it is the difference between a stall and a loss.** The plan says
an envelope that will not open must not advance the cursor past it. That is right for exactly one
of the two ways it happens:

- `envelope.epoch > group.epoch` — this device is **behind** a key rotation and has not been
  handed the new key. Those ops become readable, so the cursor stays put. **That bet only came
  good on 2026-08-30**: until the rewrap hop existed the key never arrived, so "the cursor stays
  put" meant the page was re-delivered for ever and one removal bricked any group of three. The
  hold was the right call against a hop that had not been built yet, and it is now what makes the
  stall temporary rather than permanent — `check_keys` runs before pull on every round trip.
- `envelope.epoch < group.epoch`, or a failed AEAD — written before a rotation, or altered. No key
  this device will ever hold opens it, so refusing to advance would stall the stream for the
  thirty days the relay keeps a tail, for nothing. It is counted, written to `error_log` and
  stepped over.

---

## Schema — user v30

| Object | What it is |
| --- | --- |
| `sync_uid TEXT` + `idx_<table>_uid` on all twelve synced tables | a name every device agrees on |
| `device_names` (v31) | `device_id` → `name`, and nothing else. **The twelfth synced table**, so a rename reaches the group and a joiner stops reading "Paired device". `sync_devices` stays unsynced beside it, because it holds keys |
| `needs_review TEXT` on `deck_folders`, `wishlist_folders`, `collection_folders` | §7.4's second surfaced outcome had nowhere to go |
| `sync_ops` | the op log: `tbl`, `uid`, `kind`, `fields`, `counters`, `parents`, the stamp, `pushed_at` |
| `sync_clock` | one row: the hybrid logical clock, **seeded** |
| `sync_state` | key/value: `pull_cursor`, `last_sync_at`, the `applying` guard, the entitlement tokens the hosted relay design §10 adds, and `relay_url` — which is **a test/dev override with no UI**, not something a reader types |
| `sync_peers` | per-device watermarks — what makes a counter idempotent |
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
files; the seed reaches converted and fresh ones, and the browser has only ever had the second
kind.

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
| `deck_tags` · `muted_tags` | 0 |

### The split, with the uid mint — debug

`split::tests::the_real_database_converts_with_every_row_intact`: **264 ms**, a **1 523 712 B**
user file beside a 787 075 072 B corpus, zero `foreign_key_check` violations. The user file was
1 323 008 B before v29; the eleven uid columns and their eleven unique indexes are the ~200 KB
difference, over 1 069 rows.

---

## The engine compiles for wasm, and nobody had tried

Spec §2's premise is one dataset across three platforms, so the conflict engine has to be one
implementation — and `wire` seals every batch with `sync_pair::crypto`, which makes a browser
that cannot open an envelope a browser that cannot sync. PR 4 gated `AppState.pairing` off wasm
and said in its own comment that the gate was temporary. This is the half of it that could be
lifted.

`crypto`, `invite` and `identity` are in `lib.rs`'s every-target column now; `pairing` stays
gated, because it is `#[tauri::command]`s over `AppState` and is the desktop's IPC surface rather
than a piece of the protocol. So is `sync_engine::commands`, for the same reason. Everything else
in `sync_engine` — `hlc`, `capture`, `merge`, `apply`, `wire`, `client` — compiles there.

**Two dependency edits were what it took, and neither is a workaround; each removes something the
tree did not need.**

- **`chacha20poly1305` gets `default-features = false`.** Its default set enables
  `aead/getrandom`, which pulls `rand_core 0.6` and with it **`getrandom 0.2`** — the one major
  in this tree that refuses `wasm32-unknown-unknown` outright, with a `compile_error!` pointing
  at a `js` feature. Nothing here uses what it buys: `AeadCore::generate_nonce` is unreachable,
  because `crypto::seal` draws its own 24 bytes.
- **`getrandom` moves 0.3 → 0.4**, which is the edit its own comment already told the next reader
  to make: `x25519-dalek 3.0.0` resolves **0.4.3**, so declaring 0.3 stood two majors in the tree
  and switched a browser backend on in only one of them — the build failed inside the *other*.
  No code changed.

Plus `getrandom`'s `wasm_js` feature in the web target block. **A `.cargo/config.toml` carrying
`--cfg getrandom_backend="wasm_js"` was written first and then deleted**: 0.3 needs that flag and
0.4 does not, established by removing the file and watching the wasm build stay green. Worth
recording, because the file would have been a trap — `scripts/build-wasm.mjs` runs cargo from the
repository root and CI's wasm job runs it from `src-tauri`, and cargo reads its config by walking
up from the **current** directory, not the manifest's.

Verified with `cargo clippy --lib --target wasm32-unknown-unknown -- -D warnings`, exit 0, and
`cargo tree --target wasm32-unknown-unknown -d` lists no duplicate `getrandom` at all. It needs
clang on `PATH`; on this machine that is `C:\Program Files\LLVM\bin`.

---

## The first end-to-end pass, 2026-08-29

**Two real devices over the deployed relay.** A Windows desktop and a OnePlus 12 (`CPH2581`),
both debug builds off `main` at the pairing-baseline merge, both driven over CDP — 9222 for the
desktop's WebView2, 9333 forwarded to `webview_devtools_remote_<pid>` on the phone.

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
| **Phone collection** | **0 entries** | **275** |
| Ops deferred on the phone | 1, permanently | **0** |
| Ops applied on the phone | 0 | 1 069 |

The deferral was correct and permanent: the one captured op was a `put collection_entries` naming
a folder by uid, and the folder's own op had never been written, so it waited for something that
did not exist.

### The baseline, measured

| | |
| --- | --- |
| Ops in one baseline | **1 069** — the figure §11 of the design predicted, unchanged |
| `deck_audit` rows among them | 28 |
| Desktop build + seal + push | **694 ms** |
| Phone pull + apply of all 1 069 | **1 543 ms** |
| Deferred | **0** |
| `needs_review` raised on either device | **0** — no resurrection, no broken cycle |
| One full 200-op stored relay row | **186 299 B**, against a 2 MB cap (`wire::tests`, debug) |

Both directions fired: the phone emitted its own baseline back and the desktop applied 1 070. The
second sync on each device emitted **0** — the marker holds.

### Every field agrees

```
field        desktop      phone
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
had revoked each other minutes earlier — the desktop marked the phone at one stamp, the phone
marked the desktop 16 seconds later, both landing on epoch 1. The trigger skips a revoked peer,
so it did. It is worth recording that the *right* answer looked exactly like the feature not
working, and that the roster was what said otherwise.

⚠️ **This paragraph said "two devices that have revoked each other cannot recover on their own",
and the state it describes is no longer reachable.** ⚠️ **Corrected 2026-08-30.** It rested on
§7.6's rotation minting a key nothing distributes; the rewrap hop distributes it, so **the ordinary
removal now reaches every device that stays** and re-pairing by hand is no longer the only route
back from one. The mutual case that produced the reading above is closed from two directions
rather than repaired: with no membership the press is refused outright before anything moves, and
with one, only the *first* rotation is accepted — `/rotate` refuses an epoch that does not strictly
advance the group, so the second device gets a 409, its removal simply does not happen, and it
learns from `/keys` that it is the one that was removed and leaves cleanly. Two devices can no
longer arrive at the same epoch holding two keys neither can read.

**What that pass observed is still worth keeping**: the *right* answer looked exactly like the
feature not working, and the roster was what said otherwise. The mechanism has moved on — a
removed peer is deleted rather than stamped, so `peers_needing` skips it by absence rather than by
reading the mark — and the reading a reader takes from a `baselineOps: 0` has not.

### Traps this pass paid for

- **The debug APK is `com.mtggrimoire.app.debug`**, not the identifier in `tauri.conf.json` —
  `applicationIdSuffix = ".debug"`. `monkey` answers "No activities found to run" for the
  unsuffixed name, which reads like a broken build.
- **Two clangs, and each leg needs the other one.** `wasm32` needs `C:\Program Files\LLVMin`;
  `aarch64-linux-android` needs the **NDK's** toolchain first on PATH, or `ring` fails with
  `fatal error: 'assert.h' file not found` — an error that names a missing C header when the
  cause is a clang with no Android sysroot. Neither is on PATH by default.
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
  routine path** (spec §8). `group.ts:172-197` returns every envelope past the cursor in one
  response and `client.rs:917`'s `response.text()` has no cap, so a peer offline through a
  50 000-row import pulls 250 envelopes in one body — **~46.6 MB**, held as row strings plus the
  `JSON.stringify` copy at **~95 MB inside a 128 MB isolate shared with every other group's**
  Durable Object, and over 150 MB peak on the phone. This is reachable today at
  `wire::BATCH = 200` and has nothing to do with automatic sync — what automatic sync changes is
  how often the path is taken: a `head` frame that wakes a peer holding a 250-row backlog *is*
  this path, where before it needed a reader to press **Sync now** by hand onto a device that had
  been stale for a while. The fix is a `LIMIT` on `pull` plus a cursor-carrying loop on the
  client — a change to the pull contract on both sides, with its own tests — and it is the next
  PR after this one; a live two-device pass must not import 50 000 rows against an offline peer
  until it lands.
- **A third device's tombstone against a third device's edit.** Add-wins reads this device's own
  history and the incoming batch; two *other* devices' ops only meet if they arrive together. A
  tombstone table would close it and is not built.
- ~~**A revoked device's rewrapped key over the relay.**~~ **Built and deployed 2026-08-30** —
  `/rotate` publishes it, `/keys` hands it over, and `client::check_keys` runs on every round trip
  before push and pull, so the pull cursor an envelope from a newer epoch was holding now advances
  on its own. See §7.6 above. ⚠️ **This bullet said "the deploy is what is left … none of it has
  ever executed against a live Worker" for part of that same day**; both routes now answer on the
  host, and step 2 of the runbook records what the deploy itself found.
- ~~**A `Leave group` press.**~~ **Built 2026-08-30** — `sync_group_leave`, and a press on the
  panel beside *Pair a device*, drawn on a paired device and on no other. See "The departure"
  under §7.6. What it is still owed is the **live pass**: leaving on the phone and watching the
  desktop's roster lose it, which is the check that found the group-key migration gap on its first
  press.
- **The device cap is not deployed.** `group_devices`, the `device` field on both `/token` doors
  and on `/claim`, `/claim`'s rebind and `/rotate`'s `keepOnly` are all written and tested and
  none of it is running: the live `/token` still accepts a body with no `device`. The migration
  file and the order it goes in are in the runbook.
- ~~**No WebSocket fan-out for the rewrap either.**~~ **Partly built 2026-08-31** — `check_keys`
  runs at the top of every round trip, so a removal is now picked up by *whatever* wakes a device:
  a `head` frame, a local write, launch, a reconnect. ⚠️ **This bullet claimed "within a few
  seconds of the next `head` frame" for part of that day and it is false — there is no frame.**
  A rotation never reaches the Durable Object at all: `index.ts` answers `/rotate` and `/keys`
  ahead of the bearer gate, out of D1, precisely because a rotated-away device cannot mint a
  token — and `notify()` is called from `push` and nowhere else, so nothing broadcasts. **A quiet
  group therefore learns of a removal at its next trip for some other reason**, which on an idle
  device is the next launch or the next reconnect. Still a large improvement on the manual press
  it replaced, and still not a fan-out. Closing it properly means either a notify on the rotate
  path — which would have to reach the object the rotate deliberately avoids — or the removing
  device pushing something after it publishes.
- **A round trip holds the write connection across the network, so a user edit can be told the
  database is busy.** `live::trip` and `commands::sync_now` both wrap the whole of
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
  deployed and a desktop and a phone converged over it. See "The first end-to-end pass" below.
- **The bulk-import cost.** 4.22× is measured and unaddressed; see above.
- **A persistent push failure still retries every ~3 s while the socket is up.** The outbox gate
  (`live::outbox_has_work`) improved this — before it, *every* commit rang the bell whether or
  not there was anything to push — but it did not close it: a failing trip leaves its op
  `pushed_at IS NULL`, so the next commit (the trip's own `error_log` row among them) finds a
  pending op, the gate answers `true`, and `schedule.rs`'s `WRITE_DEBOUNCE_MS` fires the next
  trip three seconds later. `schedule.rs`'s `backoff_ms`/`deserves_backoff` govern the
  **socket** — how long `connect_once` waits before dialing again after a disconnect — not the
  trip ladder, so a trip that keeps failing over a socket that stays up has no error backoff of
  its own.
- **`Wake::Resume` is declared but never constructed.** Its mechanism is real but unwired —
  `live::resume()` only sets the `FOREGROUND` atomic and never calls
  `sched.wake(Wake::Resume, …)`. The catch-up still happens: the outer loop dials on resume
  regardless, and `connect_once` fires `Wake::Reconnect` on every socket that comes up, so
  `Resume` is redundant rather than missing. But `Wake::Exit` was deleted from this very enum
  for being never-constructed, and this one now sits in the state that condemned it — either
  arm it or delete it.
- **`WAKE_LOCK_WAIT`'s one-second timeout can drop a single wake.** `outbox_has_work` tries the
  write connection for one second and answers `false` on a miss rather than waiting longer or
  asking again on its own. If another writer holds `state.db` for longer than that with no
  further commit to ring the bell a second time, that wake is lost. Self-healing in every case
  examined — the competing writer is usually a `sync_now` press that pushes the very op the
  missed wake would have pushed — but it is the one way the gate can fall quiet with real work
  still in the outbox, and it was undocumented until now.
