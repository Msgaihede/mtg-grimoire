# One-sided pairing, and a QR that pairs

**The reader's complaint, in their words:** *"Its still too hard to pair 2 devices together. Having
to enter a long code on one device is fine, but the codes having to go both ways is too difficult
for the user… Also the QR code just lists a number, which just googles a random number on most
phones."*

Both halves of this were asked for by §7.5 of
[the cross-platform design](2026-08-27-cross-platform-design.md) and neither was built.
[sync.md](../../reference/sync.md)'s *"The two things §7.5 asked for that are not here"* names
them: there is no scanner, and step 4's *"sends it through the relay"* never happened. This spec
is that section being closed, not a new direction.

---

## 0. What changes, in one table

Three blobs cross between the two devices today. **One does after this**, and it goes A→B, which
is the easy direction — a screen a camera can point at.

| | today | after |
| --- | --- | --- |
| the invite (A→B) | QR + 105 typed characters | **unchanged**, and the QR is now scannable *by the app* |
| B's response (B→A) | the reader retypes ~90 characters **phone → PC** | the relay carries it |
| the sealed key (A→B) | the reader retypes **224** characters | the relay carries it |
| the six digits | compared on both screens, confirmed on both | compared on both screens, **confirmed on A only** |

**The typed code stays 105 characters and that is a decision, not inertia.** It could shrink to
about sixteen by having the relay supply A's public key, and the cost is exact: the six digits
would stop being a backstop and become the only thing between the reader and a relay that
substituted its own key. `sync.md`'s *"What the six digits defend against, and what they do not"*
already says nothing defends against a reader who presses *Codes match* without looking; shrinking
the code makes that sentence load-bearing. The reader said one long entry on one device is fine,
and this is what that answer buys.

---

## 1. The rendezvous: two routes, outside the gate, D1 only

### 1.1 The routes

```
POST {relay}/p/{rv}/{slot}   body {"blob": "<base32>"}   → 204; 409 if that slot is filled
GET  {relay}/p/{rv}/{slot}                               → 200 {"blob": "…"}; 404 if empty
```

`slot` is `join` (B's response, written by B, read by A) or `offer` (A's sealed key, written by A,
read by B). Route regex, matched ahead of `ROUTE` in `relay/src/index.ts` the way `CLAIM_ROUTES`
is: `^/p/([0-9a-f]{32})/(offer|join)$`.

**They stand ahead of the bearer gate, and it is the same sentence that puts `/rotate` and `/keys`
there.** B has no token by construction — it is not in the group yet and cannot derive the group
auth — so a rendezvous behind the gate would refuse exactly the caller it exists to serve. Both
are D1 and **neither reaches a Durable Object**, which is what makes standing outside affordable:
the gate is in front of the DO because a request that reaches one bills whether it is honoured or
refused, and nothing here is on that line.

### 1.2 The table

```sql
CREATE TABLE IF NOT EXISTS pairing_rendezvous (
  rv         TEXT    NOT NULL,
  slot       TEXT    NOT NULL CHECK (slot IN ('offer', 'join')),
  blob       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (rv, slot)
);
```

No second index: every read names `(rv, slot)` or `rv`, and the primary key's automatic index
covers both. The daily cron already in `wrangler.jsonc` sweeps `expires_at < now` alongside
`reconcile`.

⚠️ **It goes in `relay/migrations/`, not into `schema.sql`'s tail.** That file's own comment
records why: `wrangler d1 execute --file` is atomic, D1 has no `ADD COLUMN IF NOT EXISTS`, and on
2026-08-30 a re-run rolled back a `CREATE TABLE` that had succeeded and left the deployed Worker
500ing on `no such table: group_keys`. A `CREATE TABLE IF NOT EXISTS` is safe to re-run, so this
one may also be appended to `schema.sql` for a fresh database — but the *live* database is brought
forward by its own migration file, run as its own `--command`.

### 1.3 `rv` is a one-way derivation of the token, never the token

`crypto::pair_key` takes the 16-byte one-time token as **HKDF salt** (`crypto.rs:78`) — it is
half of what binds the derivation to this pairing attempt. Addressing the rendezvous by the token
itself would hand the relay that value.

```rust
/// The rendezvous the two devices meet at, from the one-time token and nothing else.
///
/// **One-way, for `relay_auth`'s reason.** The token salts `pair_key`, so an address the relay
/// could invert would be the relay holding half of the key derivation. HKDF-SHA256 with a purpose
/// string of its own, 16 bytes, hex — which is also the character class the route regex pins.
pub fn rendezvous_id(token: &[u8; 16]) -> String
```

### 1.4 First write wins

A `POST` to a slot that already holds a row answers **409**, and the app's sentence is *"That
pairing code has already been answered on another device."* — the shape `ALREADY_USED` already
has.

**Without it, anyone who photographed the QR could overwrite B's answer after the fact.** With it
they can only get there first, which the reader sees immediately because the six digits on the two
screens disagree. A device that has already written does not write again: `Pending` records that
it posted, and everything after is polling.

### 1.5 What it costs, and what it exposes

Unauthenticated writes, like `/claim`'s. Bounded four ways: `rv` must be 32 hex characters, `blob`
is capped at **2048 characters** (the largest blob measured is the 224-character sealed key, so
this is 9× headroom), one `rv` holds at most two rows, and everything expires in ten minutes.

Polling at 1.5 s for at most ten minutes is **400 reads per pairing**, against D1's 5 000 000
reads a day. There is no `DELETE` route: a cancelled offer is already dead because `Pending` dies
with the process and the token is one-time, and an unauthenticated delete would only hand an
attacker a way to clear a slot and re-take it.

---

## 2. The QR carries a URL, and the code rides in the fragment

### 2.1 The payload

```
https://mtg-grimoire-relay.denmark-east.workers.dev/pair#<105 characters, no hyphens>
```

**The fragment is load-bearing and not cosmetic.** A fragment is never sent to the server, so the
relay still never learns the invite — which is the whole of what §0's "keep 105 characters"
decision buys. Put the code in the path and the relay would hold A's public key and the one-time
token, and the six digits would become the sole defence by the back door.

It also sidesteps a second problem the web target would otherwise have. `src/pwa/swCore.ts:61`
answers **any** navigation from the app shell, so a path-shaped deep link would work — but only
once a service worker is installed, and a QR scan is by definition a first visit. A path would
need a server rewrite rule that does not exist. The server only ever sees `/pair`.

### 2.2 The size, measured

**162 bytes**, which is a **version-9 QR at error-correction level M** (176-byte capacity;
version 8 holds 152 and does not fit) — **53 × 53 modules**, 61 with the four-module quiet zone
`QrCode.tsx` already draws.

The panel draws `size-56` (224 px) today, which is **3.67 px per module**. That goes to `size-72`
(288 px) — **4.72 px per module**. Nothing else about `QrCode.tsx` changes, and its warning stands:
`bg-white` and `fill="#000"` are literal, because a QR inverted by dark mode is a QR no camera
reads.

### 2.3 `Invite::decode` must strip the URL before it filters

`decode` keeps every ASCII alphanumeric and folds `I`/`L`/`O` (`invite.rs:78`). Handed a URL it
would fold the hostname into the payload and answer `InviteError::Length` about a code that is
perfectly good. So: **if the string contains `#`, take everything after the last one**; otherwise
use it as-is, which is today's behaviour exactly. A pasted URL and a pasted code both work, and
the scanner hands it whichever the QR held.

### 2.4 `GET /pair`, and the Android app link

The relay serves a small static page. It reads `location.hash` **itself, in the page** — the
Worker never sees it — and offers three things: the code large enough to read across a desk, a
copy button, and an `intent://` link into the Android app. Plus `/.well-known/assetlinks.json`
carrying the app's signing-certificate SHA-256, so `android:autoVerify` succeeds and a scan opens
the app rather than a chooser.

The manifest gains the filter it has never had — one `VIEW`/`BROWSABLE` intent-filter for
`https://mtg-grimoire-relay.denmark-east.workers.dev/pair`. `android:launchMode="singleTask"` is
already set, which is what such a filter wants.

---

## 3. The scanner — driven live, 2026-08-31, debug

This section is measurement, not reasoning. Every figure below came off the shipped window under
`npm run tauri dev` on Windows, driven over CDP.

### 3.1 `sync.md` is wrong about the mechanism, and the conclusion moves with it

> **There is no scanner.** … the Tauri webview has no camera permission, `getUserMedia` is not
> reachable under the CSP in `tauri.conf.json` (`default-src 'self'`, no `media-src`) …

**The CSP is not what stops it.** CSP has no camera directive; `media-src` governs a `<video src>`
URL fetch, and `srcObject` is not a fetch. Measured in the running window:

| probe | answer |
| --- | --- |
| `window.isSecureContext` | `true` |
| `navigator.mediaDevices.getUserMedia` | `function` |
| `document.featurePolicy.allowsFeature('camera')` | **`true`** |
| `navigator.permissions.query({name:'camera'})` | **`granted`** |
| `enumerateDevices()` | an `audioinput`, a **`videoinput`**, an `audiooutput` |
| `getUserMedia({video:true})` | **`NotSupportedError: Not supported`** |
| `getUserMedia({audio:true})` | **`NotSupportedError: Not supported`** |

**Audio fails identically, which is what rules out every camera-specific explanation.** Permissions
policy allows it, the permission reads granted, a device exists — and capture still refuses.

### 3.2 What it actually is: an unhandled WebView2 permission request

Relaunched with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` extended, twice:

| flags | `getUserMedia({video:true})` |
| --- | --- |
| none | `NotSupportedError: Not supported` |
| `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` | **ok** — `video/fake_device_0` |
| `--use-fake-ui-for-media-stream` **alone** | **ok** — `Lenovo 500 RGB Camera (17ef:482f)`, 640×480 @ 30 fps |

The third row is the one that settles it. `--use-fake-ui-for-media-stream` fakes only the
*permission prompt*; the device is real. So the capture stack is present and working in the
WebView2 that Tauri embeds, and what fails without the flag is the `PermissionRequested` event
going unhandled — which WebView2 surfaces as `NotSupportedError` rather than the `NotAllowedError`
anybody debugging this would expect. **That misleading error name is why this cost a session
before and is written down here.**

### 3.3 The whole pipeline runs under the shipped CSP

`devCsp` differs from `csp` only in `connect-src` (HMR's `ws://localhost:1420`) and `style-src`
(`'unsafe-inline'`). **Neither declares `media-src`**, so both fall back to `default-src 'self'` —
the dev reading transfers to the shipped build.

Real camera → `<video srcObject>` → `canvas.drawImage` → `getImageData`, measured:
**640 × 480, 307 200 pixels, mean red 109, 307 200 non-zero** — a live image, not a black frame.
That `ImageData` is exactly what a decoder takes.

### 3.4 So: a component, not a native plugin

**`BarcodeDetector` is `undefined` in WebView2** (measured above), so the platform decoder is not
available and a JS decoder is required whatever else is decided. Given that, one
`<QrScanner onCode={…} />` — `getUserMedia`, a `<video>`, a `rAF` loop drawing to a canvas, and
`jsQR` over the `ImageData` — serves desktop **and** Android **and** the web build later, from one
implementation. `tauri-plugin-barcode-scanner` is mobile-only and would have left desktop, which
the reader asked for, with nothing.

### 3.5 Granting the permission, and the recommendation

Two ways, and the spec prefers the first:

1. **Handle `PermissionRequested` on the `ICoreWebView2`**, through Tauri's `with_webview` and
   `webview2-com`. The grant is then scoped to the request the app made, and nothing is granted
   while the reader is not on the scanner.
2. **`additionalBrowserArgs` carrying `--use-fake-ui-for-media-stream`.** Proven above, one line
   of config — and blunt: it auto-grants camera *and* microphone for the whole webview, for ever,
   in an app that otherwise asks for no camera at all. ⚠️ It is also a known trap that setting
   `additionalBrowserArgs` in `tauri.conf.json` **replaces** Tauri's own defaults rather than
   appending to them.

(2) is the fallback if (1) proves fiddly, and either way the flag is what proves the plumbing.

### 3.6 ⚠️ Android is not yet measured

Everything in §3 is Windows/WebView2. Android needs
`<uses-permission android:name="android.permission.CAMERA" />`, a runtime request, and wry's
`WebChromeClient` to grant `onPermissionRequest` — and **whether it does is unverified**. The
named test: build the APK, open the scanner on the OnePlus 12, and read the same
`getUserMedia({video:true})` probe over adb + CDP that §3.1 ran. If wry does not grant it, the
Android half needs a Kotlin shim and that is a task of its own.

---

## 4. The state machine

### 4.1 The commands after this change

| command | who | what changes |
| --- | --- | --- |
| `sync_pairing_begin` | A | unchanged output; also stores `rv` on `Pending` |
| `sync_pairing_accept(code)` | B | derives as today, then **POSTs the response to `/p/{rv}/join`**; answers `{sas}` only |
| `sync_pairing_poll()` | both | **new.** The only thing the panel polls |
| `sync_pairing_confirm()` | A | as today, then **POSTs the sealed key to `/p/{rv}/offer`**; answers nothing |
| `sync_pairing_cancel()` | both | unchanged |
| ~~`sync_pairing_respond`~~ | | **gone from the IPC surface**; the logic stays, called by `poll` |
| ~~`sync_pairing_complete`~~ | | **gone from the IPC surface**; the logic stays, called by `poll` |

`sync_pairing_poll` answers `PairingProgress { stage, sas }` with `stage` one of
`waiting | compare | complete`:

- **A** after `begin`: `waiting`. It `GET`s `/p/{rv}/join`; when a blob appears it runs the
  existing `respond` logic and moves to `compare` with the six digits.
- **A** after `confirm`: `complete`.
- **B** after `accept`: `compare`, digits already known. It `GET`s `/p/{rv}/offer`; when a blob
  appears it runs the existing `complete` logic and moves to `complete`, joined.

These commands do network I/O now, so they are `async` and go to the blocking pool with a runtime
of their own — `sync_device_revoke`'s shape, and for its reason: the write connection is behind a
`Mutex`, a guard cannot cross an `await` on a multi-threaded runtime, and `spawn_blocking` moves
the trip to a thread where `block_on` is legal.

`Pending` gains `rv: String`, `posted: bool` and an expiry. **Ten minutes, and the panel says so**
when it passes rather than polling a 404 for ever; the rendezvous rows expire on the same clock.

### 4.2 Only A gets a button, and that is sound

B displays its six digits and has no *Codes match* press — only a *Cancel*. Its copy reads
*"Compare these with the other device, then press Codes match there."*

Under a man-in-the-middle the two screens show different numbers, because a substituted key moves
both halves of the transcript. The comparison is therefore inherently two-screen, and the button
that matters is the one gating the release of the group key — A's. A reader who presses without
looking is no worse off than today, which `sync.md` already says nothing can fix.

**B uploading its response before any confirmation leaks nothing.** The sealed remainder opens only
under the pair key, and anyone holding the invite could already run their own handshake. What the
current design withholds until the reader confirms is withheld from a party that does not need it.

### 4.3 `confirm`'s order, and why it is this order

1. `identity::room_for` — the device cap, unchanged, still refused at the press.
2. Seal the group key **at the current epoch** and POST it to `/p/{rv}/offer`. If this fails,
   **nothing has changed locally** and the reader presses again.
3. Commit `create_group` + `add_device(B)`.
4. **Then** publish the join rotation of §5. Best effort.

**Step 2 before step 3 is what makes a failed post cost nothing**, and step 2 sealing the *current*
key is what keeps the blob layout byte-identical — `<group_id>\0<epoch>\0<32-byte key>`, the key
last, exactly as today. **So this change adds no new skew *of the sealed blob***, which is the one
`sync.md` documents and the one a future field would worsen. The builds are still mutually
unpairable, for the different reason §6 gives: the *flow* changed, not the bytes. The pairing-time
rotation was considered and rejected here: it would have had to seal a key at an epoch the relay
had not yet accepted, and that ordering has no safe answer.

---

## 5. The roster reaches the whole group

### 5.1 The bug this fixes, which is not merely a UX wish

`pairing::confirm` adds the new device to the **local** roster and publishes nothing. A rotation's
manifest key set **is** the roster (`schema.sql`'s `group_keys`, and
`identity::plan_rotation`'s *"The manifest never names the device being removed"*), and it is
built from the rotating device's own `sync_devices` table.

So: A pairs B. C — paired with A earlier, never told about B — later removes any device. C's
manifest is built from C's roster, which has no B in it. `client::check_keys` reads a higher epoch
with no blob for B, which is the removal notice, and **B silently leaves a group nobody removed it
from.**

### 5.2 `identity::plan_join`

A third entrance beside `plan_rotation` and `plan_departure`, sharing their `plan` body: a rotation
at `epoch + 1` whose manifest is the roster **plus** the joining device. Published through
`client::post_rotation`, which already commits only when the relay accepts.

It reuses the removal machinery whole, including the `baselined_at` clear that
`sync_engine::baseline` already performs on a rotation *"precisely so the next sync carries their
last words across the epoch boundary"* — which is also, exactly, what a newly joined device needs.

### 5.3 The group with no membership

`/rotate`'s door is the group auth or the refresh secret, and a group that has never claimed has no
D1 row, so it 401s. `identity::NO_MEMBERSHIP` says the same thing for a removal.

**A first pairing is therefore the common case that cannot publish**, and it does not need to:
nothing is syncing, so there is no divergence to carry. The join is recorded locally and marked,
and the publish is retried on the first sync that has a membership. The mark is a `sync_state` key
— **`roster_dirty`**, set by `confirm` when the publish is skipped or refused and cleared only
when `/rotate` accepts. `client::round_trip` already fetches `/keys` on every sync, so the retry
costs no extra request.

⚠️ **`/claim` seeds `group_keys` with an *empty* manifest**, and `client.rs`'s own comment says a
group that has claimed and never rotated reads `blob: null, devices: []` on every device — which is
survived only because the epochs are compared first. The retry above must not read that empty
manifest as evidence of anything; it publishes from the local roster and lets `/rotate`'s 409 on a
non-advancing epoch settle a race between two devices trying at once. The loser adopts.

---

## 6. What is deleted, and what it costs

Gone: `syncPairingRespond` and `syncPairingComplete` from `ipc.ts`, the `Blob` component, two of
the three paste boxes, and `PairingHandshake.response`. One `Paste` survives — the invite code —
beside the new *Scan a code* button.

**Two costs, stated rather than buried:**

- ⚠️ **Pairing now needs the relay to be reachable.** Today two devices pair with no network and
  no membership and connect Patreon afterwards; `pairing::confirm`'s comment calls that *"what
  makes pairing possible in either order"*, and the order survives — a reader may still pair first
  and connect second — but the *offline* half of it does not. The reader chose this deliberately
  over keeping the paste boxes as a fallback.
- ⚠️ **An old build and a new build cannot pair.** `sync.md` already documents this class for the
  sealed-blob layout: there is no version field in the wire format and nowhere to put a sentence
  saying which side is behind. **Pair two devices on the same build.** This one is louder than the
  blob skew, because the old build's second and third paste boxes have no counterpart at all.

---

## 7. Testing

- **`relay/` vitest** — the two routes against `fakeD1.ts`, which must be taught the new statements
  the way commit `a3414d1` taught it `/claim`'s. Cases: round trip, 409 on a filled slot, 404 on an
  empty one, a bad `rv` shape, an oversized blob, expiry.
- **Rust** — `rendezvous_id` is one-way and stable; `Invite::decode` accepts the URL form, the bare
  form, and still refuses each of its four existing errors; `plan_join`'s manifest names the joiner
  **and** every existing device; the §5.1 three-device sequence, which is the regression test that
  would have caught the eviction.
- **The MITM test stays as it is.** It is a real three-party exchange and the rendezvous does not
  touch the crypto — but it should now also assert that a *substituted* rendezvous blob moves the
  six digits.
- **Frontend** — the panel's four states per side, and the poll driving `waiting → compare →
  complete` with a mocked ipc.
- **Live** — the two devices over the deployed relay, which is the only thing that can show the
  poll cadence and the ten-minute expiry behaving. `sync.md`'s *"The first end-to-end pass"* is the
  shape.

⚠️ **The scanner cannot be tested in vitest.** jsdom has no `getUserMedia` and no canvas pixels.
Its test is the live pass in §3.6 plus a Storybook story driving `onCode` directly with a decoded
string, which is where the *parsing* is worth testing and the camera is not.

---

## 8. Risks

| Risk | Standing |
| --- | --- |
| Android camera permission | **Unverified.** §3.6 names the test. Worst case, a Kotlin shim. |
| WebView2 `PermissionRequested` handler | Unwritten; §3.5's flag is the proven fallback. |
| `jsQR` as a new dependency | Unmaintained since 2021 but stable, **Apache-2.0** (this row said MIT; the installed package and its `LICENSE` file both say Apache-2.0 — corrected in Task 11's docs pass, 2026-08-31), no transitive deps. `zxing-wasm` is the alternative and is much larger. Settle at plan time. |
| Unauthenticated rendezvous writes | Bounded by §1.5. Same exposure `/claim` already carries. |
| Old build ↔ new build | Cannot be fixed; §6 states it. |
| `assetlinks.json` needs the signing cert | A deploy step, not a code one. Until it exists the scan opens a chooser rather than the app — degraded, not broken. |
