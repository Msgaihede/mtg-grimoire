# Sync — pairing two devices without an account

What PR 6 shipped: the whole of the pairing *protocol*, and none of the transport. Every
measurement below is from a **debug** build on Windows, on the date it names.

Spec: [`2026-08-27-cross-platform-design.md`](../superpowers/specs/2026-08-27-cross-platform-design.md)
§7.5 (pairing) and §7.6 (unpairing and revocation).

---

## The claim, and what makes it testable

Two devices become one pairing group with no account, no server-side identity and no password —
and **a man-in-the-middle sitting where the relay will later sit cannot join, because both
readers compare a six-digit code that only the true pair can produce.**

PR 6 carries both of the blobs that protocol produces **by hand**: the invite as a QR code or a
typed code, and the sealed group key as a second blob. There is no network of any kind. Two
windows side by side, or a phone photographing a laptop, complete a pairing with the app
offline.

That split is not a compromise. **A pairing that never touches a network cannot be attacked by a
network**, so every test here is about the protocol rather than about the transport, and PR 7
inherits a verified protocol instead of debugging both at once.

---

## The protocol, step by step

| Press | Command | A (offering) holds | B (joining) holds |
| --- | --- | --- | --- |
| A: *Pair a device* | `sync_pairing_begin` | pending offer, the invite | — |
| B: pastes the code | `sync_pairing_accept(code)` | — | pair key, **six digits**, a response blob |
| A: pastes the response | `sync_pairing_respond(response)` | pair key, **six digits** | — |
| **both compare the six digits** | — | | |
| A: *Codes match* | `sync_pairing_confirm` | group created if needed; **sealed key** | — |
| B: pastes the sealed key | `sync_pairing_complete(blob)` | — | joined |

The four layers behind it, and the boundary between them is that only the last two touch SQLite:

- **`sync_pair::crypto`** — X25519, HKDF-SHA256, XChaCha20-Poly1305 and the six digits. No
  database, no I/O, no clock. Everything is a pure function of its arguments, which is why the
  man-in-the-middle test is a real three-party exchange in a few microseconds rather than a mock.
- **`sync_pair::invite`** — the 64-byte payload as a typed code and as a QR *module matrix*.
- **`sync_pair::identity`** — the three tables user schema v28 created.
- **`sync_pair::pairing`** — the state machine and the nine commands.

### Both hand-carried blobs put one field in the clear, and that is not a leak

Each side has to know **which key to derive** before it can open anything, and the value it needs
is the one the other side is identified by:

- B's response is `<32-byte public key><sealed remainder>`. A cannot derive the pair key without
  B's key, and B's key is repeated *inside* the sealed bytes — `respond` compares the two, so a
  swapped prefix fails to open and a prefix that opens is one the sealing device chose.
- A's sealed key is `<device id>\0<sealed remainder>`. The id is that seal's associated data and
  B does not know it yet. It is hex, so it carries no zero byte of its own and the first one is
  the separator.

**Both are public by construction.** [The plan](../superpowers/plans/2026-08-28-sync-pairing.md)
had `respond` and `complete` parsing for those prefixes while `accept` and `confirm` wrote
neither; nine of sixteen pairing tests fail against it as written.

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
`aria-disabled` until the digits exist **and its handler refuses the press**, both sides show the
number at the same size in the same face, and the joining device does not reveal the blob it has
to carry back until the reader has said the numbers agree.

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

## §7.6 — unpairing and revocation

> **It cannot be un-told what it already knows.** A removed device still holds whatever it synced
> before removal, and no server can reach into it.

**The rotation is the removal**, in the same transaction that marks the row. Marking the row and
leaving the key alone would produce an app that says a device is gone while that device can still
read every op written afterwards. The epoch is what the remaining devices compare, and it is
bumped in the same breath.

**The removed row is kept rather than deleted**, so the roster can still say who was taken off
and when, and so a rotation can be explained rather than merely happening.

Three refusals, each a sentence rather than a constraint failure:

- **This device cannot revoke itself.** "Leave the group" is a different press with different
  consequences — it throws this device's own copy of the key away — and collapsing the two would
  let a mis-click cost the reader the group they are standing in.
- **An id nobody on the roster answers to rotates nothing.** A rotation locks every remaining
  device out of what came before it, so one with nobody removed is a cost with no cause and
  nothing on any screen to explain it.
- **A device already in a group may only rejoin the one it is in.** Joining a second group
  overwrites the key the first one syncs under, and nothing here can get it back. A re-pair after
  a revocation carries the same group id and is allowed by the same check.

**The dialog's wording is load-bearing and not copy:**

> Removing a device changes the key your devices share, so it can read nothing new from now on.
> It keeps whatever it already synced — this app cannot reach into it and take that back, and no
> server has a copy to delete.

A dialog that said only "Remove" would imply a lost phone had been wiped, which is the opposite
of what happens.

**There is no "Rotate key now".** `identity::rotate_key` was written, tested and deleted before
this shipped: with no relay, a rotation A performs cannot reach B at all, so a rotation with
nobody removed would silently lock the group out of itself with no way back but re-pairing.
Revocation keeps its rotation because there the lock-out is the point. PR 7 is where a bare
rotation starts to mean something.

---

## Schema — user v28

Three tables, all `Side::User` in `schema::TABLES` and all `None` in
`mirror::watch::surface_of`.

| Table | Holds |
| --- | --- |
| `sync_identity` | one row: this device's id, its X25519 keypair, its name |
| `sync_group` | one row: the group id, the epoch, the 32-byte group key |
| `sync_devices` | the roster, removed devices included, `WITHOUT ROWID` |

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

## The two things §7.5 asked for that are not here

**There is no scanner.** §7.5 says "Device B scans". Nothing in this repo can: the Tauri webview
has no camera permission, `getUserMedia` is not reachable under the CSP in `tauri.conf.json`
(`default-src 'self'`, no `media-src`), and there is no Android build until Phase 4. So this PR
**displays** a QR code — which a phone's own camera app reads into a clipboard today — and
**accepts a typed or pasted code**. The scanner is Phase 4's, in the PR that adds the camera.

**There is no relay.** §7.5 step 4 — "A wraps the group key to B's public key and sends it
through the relay" — names a hop PR 7 builds. Until then the reader carries the sealed key by
hand.

## What PR 7 changes, and what it does not

It replaces the second hand-carried blob with a relay round trip. **The crypto, the SAS, the
roster and the rotation are all this PR's and PR 7 changes none of them.** What it adds is a
transport, an `error_log` source of its own (this PR adds none — nothing here touches the
network) and a second reader of the pairing state, at which point `PAIRING_KEY` moves from
`SyncPanel.tsx` into `@/lib/query.ts` for `COMBOS_KEY`'s reason.

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

`.storybook/fake/db.ts` answers all nine commands, and **there is no cryptography in it**. The
six digits are derived from the code with a plain hash and the QR is a picture of the right shape
rather than a readable code — the workbench has no X25519 and no encoder. What it models
faithfully is what a panel is drawn against: two blobs carried by hand, one number both readers
compare, a roster that keeps a removed device on it, and every refusal in the crate's own words.

- **`paired` is a seed**, not a fault: being paired is where a reader arrives after two presses,
  and it is the only state the roster, a removed row and the key version are reachable from.
- **`pairingReadError` is a fault**, and it lands on `sync_pairing_respond` alone: every other
  way that flow fails is a *shape* the handler raises itself, and what is left is the blob
  failing to open — which in the crate is an AEAD refusing to authenticate, and nothing a person
  types produces a well-formed blob that will not decrypt.


## Driven in the shipped window, 2026-08-28

The workbench above has no cryptography in it, so everything it proves is a fact about a *panel*.
This is the pass against the real one — `tauri dev`, debug, on a worktree that had just done its
own first-run sync (**117 606 cards**), which means schema **v28 arrived through
`USER_SCHEMA_SQL`** and the three tables were created on a fresh install rather than migrated.

| What was driven | What the real window answered |
| --- | --- |
| Settings → **Devices** on an unpaired database | "This device — not paired with anything yet", and a device id of **32 hex characters** generated by the crate rather than by the fake |
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
