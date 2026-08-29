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
`sync_device_rename` is still one press away on every row that is not removed, this device's own
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

## What PR 7 changed, and what it did not

**The crypto, the SAS, the roster and the rotation are all PR 6's and PR 7 changed none of them.**
What it added is the transport below, `errors::Source::Relay`, and the two Settings panels that
read the relay and the review queue.

**One thing §7.5 step 4 asks for is still hand-carried**: A wraps the group key to B's public key
and the reader carries the sealed blob across. The relay could carry it and does not yet — see
"What is still owed" at the end of this document.

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

## What syncs: eleven tables, and the twelfth does not exist

`schema::SYNCED_TABLES`:

`collection_entries` · `collection_folders` · `deck_audit` · `deck_cards` · `deck_categories` ·
`deck_folders` · `deck_tags` · `decks` · `muted_tags` · `wishlist_entries` · `wishlist_folders`

**Eleven and not the spec's twelve.** The spec's list names `deck_allocations`, which **schema
v25 dropped** — which deck holds a card is now which folder its row sits in, so the work that
table did is inside `collection_folders`, which is on the list. A table that does not exist
cannot be synced; the count moved and the intent did not.

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

**The row handle in `apply` is the uid and never the rowid.** Ten of the eleven tables have an
`INTEGER PRIMARY KEY`; `muted_tags` has none at all, being `WITHOUT ROWID` on
`(namespace, tag_id)`. Addressing by `sync_uid` is one spelling for all eleven.

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

## The relay: three endpoints, and no authentication

`relay/` is a Cloudflare Worker with one SQLite-backed Durable Object per pairing group.

| | | |
| --- | --- | --- |
| `POST {relay}/g/{group}/push` | one `Envelope` | 200 with the stored cursor |
| `GET {relay}/g/{group}/pull?since={cursor}&device={id}` | | 200 with `{ envelopes, cursor }` |
| `POST {relay}/g/{group}/ack` | `{ device, cursor }` | 204 — what compaction reads |

**There is no authentication and that is the design.** The relay cannot decrypt anything it
stores; the group key is minted during pairing and lives only on the paired devices. What guards
a group is that its id is 128 random bits, and what guards its contents is the key the relay has
never seen. A stranger who guessed a group id could read ciphertext or append rows no device can
open.

Compaction, the 30-day tail and the pull ordering are pure functions in `relay/src/log.ts`,
tested by the root vitest. **`since` orders by `(hlcMs, hlcCtr, device)` and not by arrival**, and
**a device with no ack at all holds everything** — a group whose third device has never connected
keeps its log rather than compacting away the state that device has not seen.

**Nothing is deployed.** The source is committed and type-checks; no Cloudflare account, Worker,
Durable Object namespace or API token was created by any agent. The URL a deploy produces goes in
each reader's own `sync_state.relay_url`, through Settings, and **never in this repository**,
which is public.

---

## What is not built: the WebSocket

§7.7 says the Durable Object "fans out to connected devices over hibernatable WebSockets". This
ships **HTTP pull-and-push**, and the Durable Object keeps a `/ws` route in its shape — a `501`
with the reason in the body — for the PR that adds it. Three reasons, in order of weight:

1. **`reqwest` has no WebSocket client**, and the obvious addition, `tokio-tungstenite`, does not
   compile to `wasm32-unknown-unknown`. Adding it would make the web target's core un-buildable,
   which is the one thing this phase is arranged not to do.
2. **A WebSocket from the page would need the CSP widened.** `tauri.conf.json` grants
   `connect-src 'self' ipc: http://ipc.localhost` and nothing else. Widening it is a decision to
   take once, for all three targets.
3. **Polling is comfortably inside the free tier.** Pull on open, pull every 60 s while the window
   has focus, push 2 s after the write mask goes quiet — `mirror::watch`'s own debounce. Eight
   hours is 28 800 / 60 = 480 pulls per device per day; three devices sharing one group is
   **1 440**, which is 1.4% of 100 000.

What is lost is latency: a change made on a phone shows on the desktop within a minute rather
than instantly. What is kept is a core that still compiles to wasm and a CSP that still grants
nothing.

**One correction to the plan, and it is the difference between a stall and a loss.** The plan says
an envelope that will not open must not advance the cursor past it. That is right for exactly one
of the two ways it happens:

- `envelope.epoch > group.epoch` — this device is **behind** a key rotation and has not been
  handed the new key. Those ops become readable, so the cursor stays put.
- `envelope.epoch < group.epoch`, or a failed AEAD — written before a rotation, or altered. No key
  this device will ever hold opens it, so refusing to advance would stall the stream for the
  thirty days the relay keeps a tail, for nothing. It is counted, written to `error_log` and
  stepped over.

---

## Schema — user v30

| Object | What it is |
| --- | --- |
| `sync_uid TEXT` + `idx_<table>_uid` on all eleven synced tables | a name every device agrees on |
| `needs_review TEXT` on `deck_folders`, `wishlist_folders`, `collection_folders` | §7.4's second surfaced outcome had nowhere to go |
| `sync_ops` | the op log: `tbl`, `uid`, `kind`, `fields`, `counters`, `parents`, the stamp, `pushed_at` |
| `sync_clock` | one row: the hybrid logical clock, **seeded** |
| `sync_state` | key/value: `relay_url`, `pull_cursor`, `last_sync_at`, the `applying` guard |
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

**The relay is deployed and its address is not in this repository and never will be.** It lives
in each device's own `sync_state.relay_url`, typed by the reader. Nothing here names it.

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

**Two devices that have revoked each other cannot recover on their own** — §7.6's rotation mints
a key nothing distributes, so re-pairing by hand is the only route back, and the app does not say
so. That is the hole listed under "what is still owed" below, met in the wild rather than in a
test.

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
  quoting.
- **`cdp.mjs eval` right after launch can find the page mid-load**, where
  `window.__TAURI_INTERNALS__` is still `undefined`. That reads as the bridge being broken; it is
  a race, and `document.readyState` tells them apart.

## What is still owed

- **The WebSocket fan-out**, with the CSP decision that comes with it. Until then §7.7's request
  figure is the polled 1 440 rather than the ~150 an edit-driven relay would spend.
- **A third device's tombstone against a third device's edit.** Add-wins reads this device's own
  history and the incoming batch; two *other* devices' ops only meet if they arrive together. A
  tombstone table would close it and is not built.
- **A revoked device's rewrapped key over the relay.** §7.6's rotation is PR 6's and works; the
  hop that hands the new key to the remaining devices is not built, which is why an envelope from
  a newer epoch holds the pull cursor rather than being stepped over.
- **`sync_ops` has no retention rule.** `pushed_at` is stamped and the row is kept, because the
  log is also this device's memory of what it did — add-wins and the cycle-break both read
  it. Nothing prunes it, so it grows for the life of the install: at the measured 453—698 B per
  op and fifty edits a day, that is a few megabytes a year, which is small beside a 787 MB
  corpus and is still unbounded. A pruner would have to keep whatever the two readers above can
  still need, which is a decision nobody has taken.
- ~~**Nothing has been driven in the shipped window.**~~ **Done 2026-08-29** — the relay is
  deployed and a desktop and a phone converged over it. See "The first end-to-end pass" below.
- **The bulk-import cost.** 4.22× is measured and unaddressed; see above.
