# One-Sided Pairing and a QR That Pairs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The reader types or scans one code on one device, and the relay carries the two blobs that
today have to be retyped back and forth — while the QR becomes a URL that opens the app instead of a
number that gets googled.

**Architecture:** Two new unauthenticated D1-only relay routes (`/p/{rv}/{slot}`) form a rendezvous
addressed by a one-way derivation of the pairing token. `accept` and `confirm` post their blobs
there; a new `sync_pairing_poll` command collects them. The QR payload becomes
`{RELAY_BASE}/pair#<code>` — the fragment keeps the invite off the relay — and the relay serves a
small page at `/pair`. A `<QrScanner>` component decodes with jsQR over `getUserMedia` frames.
Finally `identity::plan_join` publishes the roster on join, closing a bug where a paired device is
evicted by a third device's next rotation.

**Tech Stack:** Rust (rusqlite, x25519-dalek, hkdf, reqwest), TypeScript/React 19, Cloudflare Workers
+ D1, vitest, jsQR.

**Spec:** [`docs/superpowers/specs/2026-08-31-one-sided-pairing-and-qr-design.md`](../specs/2026-08-31-one-sided-pairing-and-qr-design.md)

## Global Constraints

- **The typed code stays 105 characters.** Do not shrink the invite and do not move A's public key
  to the relay. Spec §0.
- **The QR payload puts the code in the URL *fragment*.** `https://…/pair#<code>` — never a path
  segment. A fragment is not sent to the server; a path would hand the relay the invite. Spec §2.1.
- **`rv` is `crypto::rendezvous_id(token)`, never the raw token.** The token is HKDF *salt* in
  `pair_key`. Spec §1.3.
- **The sealed-key blob layout does not change**: `<device_id>\0` then a seal over
  `<group_id>\0<epoch>\0<32-byte key>`, key last. Spec §4.3.
- **Never install `@types/node`.** Project rule; its absence is the only fence.
- **Adding a dependency with permissions means adding its narrowest permission, never `:default`.**
- **`npm run verify` runs once, after fan-in** — not inside a task. Tasks report what they changed.
- Commit style: `feat:`/`fix:`/`chore:`/`test:`/`docs:`.
- Relay secrets (`PATREON_CLIENT_SECRET`, `PATREON_WEBHOOK_SECRET`, `RELAY_HMAC_KEY`) are **never**
  committed and never appear in a `.dev.vars`.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `relay/src/rendezvous.ts` | the two rendezvous handlers, pure of routing | 1 |
| `relay/src/pair.ts` | the `GET /pair` HTML page and `/.well-known/assetlinks.json` | 1 |
| `relay/src/index.ts` | routing both of the above | 1 |
| `relay/migrations/2026-08-31-pairing-rendezvous.sql` | the live database's forward step | 1 |
| `relay/schema.sql` | the same table for a fresh database | 1 |
| `relay/src/fakeD1.ts` | taught the new statements | 1 |
| `src-tauri/src/sync_pair/crypto.rs` | `rendezvous_id` | 2 |
| `src-tauri/src/sync_pair/invite.rs` | `decode` strips a URL fragment; `qr_payload` | 2 |
| `src-tauri/src/sync_pair/identity.rs` | `plan_join`, `roster_dirty` | 3 |
| `src-tauri/src/sync_engine/client.rs` | `post_rendezvous` / `get_rendezvous`; the join retry | 4 |
| `src-tauri/src/sync_pair/pairing.rs` | the state machine, `poll`, the new `confirm` order | 5 |
| `src-tauri/src/desktop.rs` | command registration; the camera handler call site | 5 |
| `src/lib/ipc.ts` | the command surface and its types | 6 |
| `src/features/settings/SyncPanel.tsx` | the panel's four states per side | 7 |
| `src/features/settings/QrCode.tsx` | 288px | 7 |
| `src/features/settings/QrScanner.tsx` | camera → canvas → jsQR | 8 |
| `src-tauri/src/camera.rs` | the WebView2 `PermissionRequested` handler | 9 |
| `src-tauri/src/lib.rs` | `mod camera;` | 9 |
| `src-tauri/tauri.conf.json`, `gen/android/.../AndroidManifest.xml` | platform permission | 9 |
| `src/features/settings/SyncPanel.test.tsx`, `.stories.tsx` | the panel's suites | 10 |
| `docs/reference/sync.md`, `CLAUDE.md`s | the record | 11 |

**Waves.** 1, 2, 3, 8, 9 are fully parallel — disjoint files, no shared state. Then 4, 5, 6 in
parallel. Then 7. Then 10. Then 11, then `npm run verify`, then the PR.
⚠️ **Two subagents editing one file clobber each other.** The table above is the ownership map; do
not let a task touch a file it does not own.

---

### Task 1: The relay — rendezvous, the `/pair` page, and routing

**Files:**
- Create: `relay/src/rendezvous.ts`, `relay/src/rendezvous.test.ts`, `relay/src/pair.ts`,
  `relay/src/pair.test.ts`, `relay/migrations/2026-08-31-pairing-rendezvous.sql`
- Modify: `relay/src/index.ts`, `relay/schema.sql`, `relay/src/fakeD1.ts`

**Interfaces:**
- Consumes: `Env` from `relay/src/index.ts` (has `DB: D1Database`, `RELAY_BASE: string`).
- Produces:
  - `handleRendezvousPut(request: Request, env: Env, rv: string, slot: string, now: number): Promise<Response>`
  - `handleRendezvousGet(env: Env, rv: string, slot: string, now: number): Promise<Response>`
  - `handlePair(env: Env): Response` — the HTML page, no D1
  - `handleAssetLinks(): Response`
  - `RENDEZVOUS_TTL_MS = 600_000`, `MAX_BLOB_CHARS = 2048`

- [ ] **Step 1: Write the failing tests**

Create `relay/src/rendezvous.test.ts`. Use `fakeD1.ts` the way `rotate.test.ts` does.

```ts
import { describe, expect, it } from "vitest";
import { fakeD1 } from "./fakeD1";
import { handleRendezvousGet, handleRendezvousPut, MAX_BLOB_CHARS } from "./rendezvous";

const RV = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;
const env = () => ({ DB: fakeD1() }) as never;

const put = (e: never, slot: string, blob: string, now = NOW) =>
  handleRendezvousPut(new Request("https://r/", { method: "POST", body: JSON.stringify({ blob }) }), e, RV, slot, now);

describe("the pairing rendezvous", () => {
  it("carries a blob from one side to the other", async () => {
    const e = env();
    expect((await put(e, "join", "ABC")).status).toBe(204);
    const got = await handleRendezvousGet(e, RV, "join", NOW);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ blob: "ABC" });
  });

  it("keeps the two slots apart", async () => {
    const e = env();
    await put(e, "join", "ABC");
    expect((await handleRendezvousGet(e, RV, "offer", NOW)).status).toBe(404);
  });

  it("refuses a second write to a filled slot, and keeps the first", async () => {
    const e = env();
    await put(e, "join", "FIRST");
    expect((await put(e, "join", "SECOND")).status).toBe(409);
    expect(await (await handleRendezvousGet(e, RV, "join", NOW)).json()).toEqual({ blob: "FIRST" });
  });

  it("is empty once it has expired", async () => {
    const e = env();
    await put(e, "join", "ABC");
    expect((await handleRendezvousGet(e, RV, "join", NOW + 600_001)).status).toBe(404);
  });

  it("refuses an oversized blob", async () => {
    const e = env();
    expect((await put(e, "join", "X".repeat(MAX_BLOB_CHARS + 1))).status).toBe(413);
  });

  it("refuses a slot that is not one of the two", async () => {
    expect((await put(env(), "middle", "ABC")).status).toBe(400);
  });
});
```

Create `relay/src/pair.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { handlePair } from "./pair";

const env = { RELAY_BASE: "https://relay.example" } as never;

describe("the /pair landing page", () => {
  it("is HTML", async () => {
    const r = handlePair(env);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
  });

  it("never puts the code in the markup, because the Worker never sees it", async () => {
    const body = await handlePair(env).text();
    expect(body).toContain("location.hash");
    // The page reads the fragment in the browser. Nothing server-side can know it.
    expect(body).not.toContain("#</");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run relay/src/rendezvous.test.ts relay/src/pair.test.ts`
Expected: FAIL — `Failed to resolve import "./rendezvous"`.

- [ ] **Step 3: Write `relay/src/rendezvous.ts`**

```ts
import type { Env } from "./index";

/**
 * The pairing rendezvous: two slots, ten minutes, and no authentication.
 *
 * **It stands ahead of the bearer gate for `/rotate` and `/keys`'s reason, not by exemption.** The
 * joining device is not in the group yet and cannot derive a group auth, so a rendezvous behind the
 * gate would refuse exactly the caller it exists to serve. Both handlers are D1 only and **neither
 * reaches the Durable Object**, which is what makes standing outside affordable: the gate is in
 * front of the DO because a request that reaches one bills whether it is honoured or refused.
 *
 * **`rv` is a one-way derivation of the pairing token and never the token itself** — the token is
 * HKDF *salt* in `crypto::pair_key`, so an address the relay could invert would be the relay
 * holding half of the key derivation. This file only ever sees 32 hex characters.
 */

/** Ten minutes. The app's `Pending` expires on the same clock. */
export const RENDEZVOUS_TTL_MS = 600_000;

/**
 * The largest blob measured is the 224-character sealed key, so this is 9× headroom.
 * It is a cap on an **unauthenticated** write, which is the only reason it exists.
 */
export const MAX_BLOB_CHARS = 2048;

const SLOTS = new Set(["offer", "join"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * **First write wins, and the 409 is the feature.** Without it anyone who photographed the QR could
 * overwrite the joiner's answer after the fact; with it they can only get there first, which the
 * reader sees immediately because the six digits on the two screens then disagree.
 *
 * The insert is `INSERT ... SELECT ... WHERE NOT EXISTS` in one statement rather than a read
 * followed by a write: two requests racing a read-then-write both see an empty slot and the second
 * clobbers the first, which is exactly the attack this refuses.
 */
export async function handleRendezvousPut(
  request: Request,
  env: Env,
  rv: string,
  slot: string,
  now: number,
): Promise<Response> {
  if (!SLOTS.has(slot)) return json({ error: "no such slot" }, 400);

  let blob: unknown;
  try {
    blob = ((await request.json()) as { blob?: unknown }).blob;
  } catch {
    return json({ error: "that is not a rendezvous body" }, 400);
  }
  if (typeof blob !== "string" || blob.length === 0) {
    return json({ error: "that is not a rendezvous body" }, 400);
  }
  if (blob.length > MAX_BLOB_CHARS) return json({ error: "that blob is too large" }, 413);

  const written = await env.DB.prepare(
    `INSERT INTO pairing_rendezvous (rv, slot, blob, expires_at)
       SELECT ?1, ?2, ?3, ?4
        WHERE NOT EXISTS (
          SELECT 1 FROM pairing_rendezvous WHERE rv = ?1 AND slot = ?2 AND expires_at > ?5
        )`,
  )
    .bind(rv, slot, blob, now + RENDEZVOUS_TTL_MS, now)
    .run();

  // A row that already stood unexpired changes nothing, which is the 409.
  if ((written.meta?.changes ?? 0) === 0) {
    return json({ error: "that slot has already been answered" }, 409);
  }
  return new Response(null, { status: 204 });
}

/** The other half. An expired row is not there, which is the same answer as never having been. */
export async function handleRendezvousGet(
  env: Env,
  rv: string,
  slot: string,
  now: number,
): Promise<Response> {
  if (!SLOTS.has(slot)) return json({ error: "no such slot" }, 400);

  const row = await env.DB.prepare(
    `SELECT blob FROM pairing_rendezvous WHERE rv = ?1 AND slot = ?2 AND expires_at > ?3`,
  )
    .bind(rv, slot, now)
    .first<{ blob: string }>();

  if (row === null) return json({ error: "nothing there" }, 404);
  return json({ blob: row.blob });
}

/** Swept by the daily cron beside `reconcile`. */
export async function sweepRendezvous(env: Env, now: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM pairing_rendezvous WHERE expires_at <= ?1`).bind(now).run();
}
```

- [ ] **Step 4: Write `relay/src/pair.ts`**

The page must read `location.hash` **in the browser**. Nothing server-side may embed the code.

```ts
import type { Env } from "./index";

/**
 * What a phone's own camera app lands on when it scans the pairing QR.
 *
 * ⚠️ **The code is in the URL fragment and this Worker never sees it.** A fragment is not sent to
 * the server; that is the whole reason the QR uses one. This page reads `location.hash` in the
 * browser, so the relay learns nothing about an invite even though it serves the page the invite
 * is opened on. Do not "improve" this by moving the code into a path or query — it would hand the
 * relay A's public key and the one-time token, and the six digits would become the only defence.
 */
const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair a device — MTG Grimoire</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:2rem 1.25rem;background:#0C0D12;color:#E8E6F0;
     font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:34rem;margin:0 auto}
h1{font-size:1.35rem;margin:0 0 .75rem}
p{color:#A9A6BC}
code{display:block;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
     font-size:.95rem;letter-spacing:.02em;background:#16171F;border:1px solid #2A2B36;
     border-radius:.5rem;padding:.85rem;margin:1rem 0}
a.btn,button{display:inline-block;font:inherit;background:#2A2B36;color:#E8E6F0;border:0;
     border-radius:.5rem;padding:.7rem 1.1rem;margin:0 .5rem .5rem 0;cursor:pointer;
     text-decoration:none}
</style></head><body><main>
<h1>Pair this device</h1>
<p id="lead">Open MTG Grimoire on this device, choose <b>Enter a code from another device</b>, and
paste the code below.</p>
<code id="code"></code>
<button id="copy" type="button">Copy the code</button>
<a class="btn" id="open" href="#">Open the app</a>
<script>
(function () {
  var raw = location.hash.replace(/^#/, "");
  var el = document.getElementById("code");
  if (!raw) {
    document.getElementById("lead").textContent =
      "That link carried no pairing code. Scan the QR code again from the other device.";
    el.remove();
    document.getElementById("copy").remove();
    document.getElementById("open").remove();
    return;
  }
  el.textContent = raw.replace(/(.{5})(?=.)/g, "$1-");
  document.getElementById("copy").addEventListener("click", function () {
    navigator.clipboard.writeText(raw);
    this.textContent = "Copied";
  });
  document.getElementById("open").href =
    "intent://pair#Intent;scheme=mtggrimoire;package=com.mtggrimoire.app;S.code=" +
    encodeURIComponent(raw) + ";end";
})();
</script>
</main></body></html>`;

export function handlePair(_env: Env): Response {
  return new Response(PAGE, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}

/**
 * Android App Links. ⚠️ **`REPLACE_WITH_RELEASE_SHA256` is a deploy step, not a code one** — until
 * the real signing-certificate fingerprint is here the scan opens a chooser rather than the app,
 * which is degraded and not broken. Get it with:
 *   keytool -list -v -keystore <ks> -alias <alias> | findstr SHA256
 */
export function handleAssetLinks(): Response {
  const body = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "com.mtggrimoire.app",
        sha256_cert_fingerprints: ["REPLACE_WITH_RELEASE_SHA256"],
      },
    },
  ];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 5: Teach `fakeD1.ts` the new statements**

`relay/src/fakeD1.ts` recognises statements by shape. Add support for the three above —
`INSERT ... SELECT ... WHERE NOT EXISTS` against `pairing_rendezvous`, the `SELECT blob`, and the
`DELETE`. Follow the file's existing pattern exactly; commit `a3414d1` did this for `/claim`.
`.run()` must return `{ meta: { changes: n } }`, because the 409 is decided on `changes`.

- [ ] **Step 6: Write the migration and the schema entry**

`relay/migrations/2026-08-31-pairing-rendezvous.sql`:

```sql
-- Run as its OWN --command. `wrangler d1 execute --file` is atomic and a duplicate-object error
-- rolls back every statement in the file; on 2026-08-30 that left the deployed Worker 500ing on
-- `no such table: group_keys` after an execute that looked fine.
CREATE TABLE IF NOT EXISTS pairing_rendezvous (
  rv         TEXT    NOT NULL,
  slot       TEXT    NOT NULL CHECK (slot IN ('offer', 'join')),
  blob       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (rv, slot)
);
```

Append the same `CREATE TABLE IF NOT EXISTS` to `relay/schema.sql` **above** the two trailing
`ALTER TABLE` lines — that file's comment explains why nothing may go below them.

No second index: every read names `(rv, slot)` or `rv`, and the primary key's automatic index
covers both.

- [ ] **Step 7: Route them in `relay/src/index.ts`**

Add beside `ROUTE`:

```ts
/** `/p/{rv}/{slot}` — 32 hex characters, and one of exactly two slots. */
const RENDEZVOUS = /^\/p\/([0-9a-f]{32})\/(offer|join)$/;
```

Add `/pair` and `/.well-known/assetlinks.json` to `CLAIM_ROUTES` (both `GET`), extending that map's
doc comment: neither is behind the bearer gate, `/pair` because it is a static page that reads the
fragment in the browser and holds no secret at all, `assetlinks.json` because Android fetches it
anonymously by definition.

In `fetch`, after the `CLAIM_ROUTES` lookup and **before** `ROUTE`:

```ts
const rv = RENDEZVOUS.exec(url.pathname);
if (rv) {
  const [, id, slot] = rv;
  // D1 only, never a Durable Object — which is what lets it stand ahead of the gate.
  if (request.method === "POST") return handleRendezvousPut(request, env, id, slot, Date.now());
  if (request.method === "GET") return handleRendezvousGet(env, id, slot, Date.now());
  return methodNotAllowed("GET, POST");
}
```

In `scheduled`, add `await sweepRendezvous(env, Date.now());` after `reconcile(env)`.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run relay/src/rendezvous.test.ts relay/src/pair.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 9: Mutate to prove the tests bite**

Break `handleRendezvousPut` so it always returns 204 regardless of `changes`. Re-run: the
"refuses a second write" test must FAIL. Restore. **If it survives, the test is wrong — say so.**

- [ ] **Step 10: Commit**

```bash
git add relay/
git commit -m "feat(relay): a pairing rendezvous, and a /pair page that reads the fragment"
```

---

### Task 2: `rendezvous_id`, and a `decode` that accepts a URL

**Files:**
- Modify: `src-tauri/src/sync_pair/crypto.rs`, `src-tauri/src/sync_pair/invite.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `crypto::rendezvous_id(token: &[u8; 16]) -> String` — 32 lowercase hex characters
  - `invite::qr_payload(code: &str, relay_base: &str) -> String`
  - `Invite::decode` additionally accepts `…/pair#<code>`

- [ ] **Step 1: Write the failing tests**

In `crypto.rs`'s `#[cfg(test)]` module:

```rust
#[test]
fn a_rendezvous_id_is_32_hex_characters_and_stable() {
    let token = [7u8; 16];
    let id = rendezvous_id(&token);
    assert_eq!(id.len(), 32);
    assert!(id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    assert_eq!(id, rendezvous_id(&token), "the same token must address the same rendezvous");
}

#[test]
fn a_rendezvous_id_does_not_reveal_the_token() {
    // Not a proof of one-wayness — HKDF is that. This is the property a reader can check:
    // the token's bytes do not appear in the address the relay is handed.
    let token = crypto_test_token();
    let hex: String = token.iter().map(|b| format!("{b:02x}")).collect();
    assert_ne!(rendezvous_id(&token), hex);
}

#[test]
fn two_tokens_one_bit_apart_address_unrelated_rendezvous() {
    let mut a = [0u8; 16];
    let mut b = [0u8; 16];
    b[15] = 1;
    a[15] = 0;
    assert_ne!(rendezvous_id(&a), rendezvous_id(&b));
}
```

Add a helper `fn crypto_test_token() -> [u8; 16] { [0xA5; 16] }` inside the test module.

In `invite.rs`'s test module:

```rust
#[test]
fn decode_accepts_the_url_the_qr_carries() {
    let inv = Invite { group_id: [1; 16], public_key: [2; 32], token: [3; 16] };
    let code = inv.encode();
    let url = qr_payload(&code, "https://mtg-grimoire-relay.denmark-east.workers.dev");
    assert_eq!(Invite::decode(&url).expect("the URL form must decode"), inv);
}

#[test]
fn decode_still_accepts_a_bare_code() {
    let inv = Invite { group_id: [9; 16], public_key: [8; 32], token: [7; 16] };
    assert_eq!(Invite::decode(&inv.encode()).expect("the bare form must decode"), inv);
}

#[test]
fn a_url_with_no_fragment_is_not_a_pairing_code() {
    // Without the fragment strip this folded the hostname into the payload and answered
    // `Length` about a perfectly good code — a sentence pointing at the wrong fix.
    assert_eq!(Invite::decode("https://example.com/pair"), Err(InviteError::Length));
}

#[test]
fn the_qr_payload_is_the_relay_base_the_fragment_and_nothing_else() {
    let inv = Invite { group_id: [1; 16], public_key: [2; 32], token: [3; 16] };
    let url = qr_payload(&inv.encode(), "https://r.example");
    assert!(url.starts_with("https://r.example/pair#"));
    // Hyphens are the typed form's; the QR carries the code the decoder reads fastest.
    assert!(!url.contains('-'));
    assert_eq!(url.split('#').nth(1).unwrap().len(), 105);
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_pair::`
Expected: FAIL — `cannot find function rendezvous_id`, `cannot find function qr_payload`.

- [ ] **Step 3: Implement `rendezvous_id`**

In `crypto.rs`, beside `INFO_ROTATE`:

```rust
const INFO_RENDEZVOUS: &[u8] = b"mtg-grimoire/rendezvous/v1";
```

```rust
/// The address the two pairing devices meet at on the relay.
///
/// **One-way, and that is the whole of why this function exists rather than the token being used
/// directly.** The token is the HKDF *salt* in [`pair_key`] — it is half of what binds the
/// derivation to this attempt — so an address the relay could invert would be the relay holding
/// that half. HKDF-SHA256 cannot be run backwards, so what the relay gets is 128 bits it can match
/// two requests on and learn nothing else from.
///
/// **Hex and 16 bytes because the route regex pins exactly that** (`^/p/([0-9a-f]{32})/…`). A
/// longer id would be refused by the relay; a shorter one would make two pairings collide.
///
/// **The token is the input keying material and not the salt**, which is the opposite of
/// [`pair_key`]'s use of it and is deliberate: there is no second input here to bind, so the
/// purpose string alone does the domain separation.
pub fn rendezvous_id(token: &[u8; 16]) -> String {
    let hk = Hkdf::<Sha256>::new(None, token);
    let mut out = [0u8; 16];
    hk.expand(INFO_RENDEZVOUS, &mut out)
        .expect("16 bytes is far below HKDF-SHA256's output limit");
    out.iter().map(|b| format!("{b:02x}")).collect()
}
```

- [ ] **Step 4: Implement the fragment strip and `qr_payload` in `invite.rs`**

At the top of `Invite::decode`, before the existing filter:

```rust
// **A scanned QR carries a URL and a typed code does not, and both must work.** The filter
// below keeps every ASCII alphanumeric, so a URL handed to it whole would fold the hostname
// into the payload and answer `Length` about a code that is perfectly good — a sentence
// pointing at the wrong fix. The fragment is the payload; everything before `#` is address.
let code = match code.rsplit_once('#') {
    Some((_, fragment)) => fragment,
    None => code,
};
```

And, beside `encode`:

```rust
/// What the QR draws: the relay's `/pair` page with the code in the **fragment**.
///
/// ⚠️ **The fragment is load-bearing and not a style choice.** A fragment is never sent to the
/// server, so the relay serves the page an invite is opened on and still never learns the
/// invite. A path or query segment here would hand it A's public key and the one-time token,
/// and the six digits would go from a backstop to the only defence there is.
///
/// **Un-hyphenated.** The hyphens are the typed form's, for a reader copying five characters at
/// a time; in a QR they are 20 bytes that buy nothing and push the symbol a version larger.
///
/// Measured 2026-08-31: 162 bytes against `RELAY_BASE`, a **version-9 QR at level M** — 53×53
/// modules. Version 8 holds 152 and does not fit.
pub fn qr_payload(code: &str, relay_base: &str) -> String {
    let bare: String = code.chars().filter(|c| *c != '-').collect();
    format!("{relay_base}/pair#{bare}")
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_pair::`
Expected: PASS. **Report the number of tests the filter selected** — a filter that matches nothing
also exits 0.

- [ ] **Step 6: Mutate to prove the tests bite**

Remove the fragment strip. `decode_accepts_the_url_the_qr_carries` must FAIL. Restore. Say so if it
survives.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/sync_pair/crypto.rs src-tauri/src/sync_pair/invite.rs
git commit -m "feat(sync): a rendezvous address, and a code that survives being a URL"
```

---

### Task 3: `plan_join`, and the mark that survives a group with no membership

**Files:**
- Modify: `src-tauri/src/sync_pair/identity.rs`

**Interfaces:**
- Consumes: `Rotation { group, keys, auth }`, `plan(conn, removing)` — both already in this file.
- Produces:
  - `identity::plan_join(conn: &Connection) -> Result<Rotation, String>` — **no argument**
  - `identity::ROSTER_DIRTY: &str` (the `sync_state` key, value `"roster_dirty"`)
  - `identity::set_roster_dirty(conn: &Connection, dirty: bool) -> Result<(), String>`
  - `identity::roster_is_dirty(conn: &Connection) -> Result<bool, String>`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_join_rotation_names_the_joiner_and_everybody_already_there() {
    let conn = seeded_group_of_two(); // this file's existing helper shape
    let joining = "cccccccccccccccccccccccccccccccc";
    add_device(&conn, joining, &[3u8; 32], "Phone").expect("roster add");

    let plan = plan_join(&conn).expect("a join must plan");
    let named: Vec<&str> = plan.keys.iter().map(|(d, _)| d.as_str()).collect();

    assert!(named.contains(&joining), "the joiner must be in the manifest it joins by");
    // **The manifest key set IS the roster.** Anyone it omits leaves the group on their next
    // sync, which is the bug this whole task exists to close.
    for peer in existing_peer_ids(&conn) {
        assert!(named.contains(&peer.as_str()), "{peer} was on the roster and must stay on it");
    }
}

#[test]
fn a_join_rotation_advances_the_epoch() {
    let conn = seeded_group_of_two();
    let before = group(&conn).unwrap().unwrap().epoch;
    add_device(&conn, "cccccccccccccccccccccccccccccccc", &[3u8; 32], "Phone").unwrap();
    assert_eq!(plan_join(&conn).unwrap().group.epoch, before + 1);
}

#[test]
fn planning_a_join_writes_nothing() {
    // `plan_rotation`'s own contract, and for its reason: a `/rotate` that is refused must leave
    // the group exactly as it was so the reader can press again.
    let conn = seeded_group_of_two();
    let before = group(&conn).unwrap().unwrap();
    add_device(&conn, "cccccccccccccccccccccccccccccccc", &[3u8; 32], "Phone").unwrap();
    let _ = plan_join(&conn).unwrap();
    let after = group(&conn).unwrap().unwrap();
    assert_eq!(before.epoch, after.epoch);
    assert_eq!(before.group_key, after.group_key);
}

#[test]
fn the_roster_mark_round_trips() {
    let conn = seeded_group_of_two();
    assert!(!roster_is_dirty(&conn).unwrap(), "a fresh group owes nobody a publish");
    set_roster_dirty(&conn, true).unwrap();
    assert!(roster_is_dirty(&conn).unwrap());
    set_roster_dirty(&conn, false).unwrap();
    assert!(!roster_is_dirty(&conn).unwrap());
}
```

⚠️ Reuse this file's **existing** test helpers rather than inventing new ones; read the module's
`#[cfg(test)]` block first and adapt the names above to what is actually there. `existing_peer_ids`
may need writing as a two-line helper.

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_pair::identity`
Expected: FAIL — `cannot find function plan_join`.

- [ ] **Step 3: Implement**

```rust
/// What the sync_state key is called. **A publish this device owes the group**, set when a join
/// could not be published and cleared only when `/rotate` accepts one.
pub const ROSTER_DIRTY: &str = "roster_dirty";

/// Work out the rotation a **join** needs, writing nothing.
///
/// The third entrance beside [`plan_rotation`] and [`plan_departure`], and it shares their body.
/// Where a removal's manifest is everyone *but* one device and a departure's is everyone but this
/// one, a join's is **everyone, plus one who is not on the roster yet** — which is why the caller
/// adds the joining device before planning.
///
/// # Why a join rotates at all
///
/// **The manifest's key set is the roster** (`relay/schema.sql`'s `group_keys`), and it is the only
/// thing that says who is in a group. A join that published nothing left the new device invisible
/// to every peer that was not part of the ceremony — and the *next* rotation by any of those peers
/// was built from a roster with no such device in it, so the manifest omitted it and it read the
/// omission as its own removal. A device paired by A was evicted by C's next removal, and nothing
/// anywhere said why.
///
/// It costs an epoch, which the rotation machinery already absorbs: `sync_engine::baseline` clears
/// `baselined_at` on a rotation precisely so the next sync carries every device's last words across
/// the boundary — which is also, exactly, what a device that has just joined needs.
/// **It takes no argument, unlike its two siblings, and that is the shape rather than an
/// omission.** A removal excludes one device and a departure excludes this one; a join excludes
/// **nobody** — the joiner is already on the roster, because `pairing::confirm` calls
/// [`add_device`] before it plans. There is no id to pass.
pub fn plan_join(conn: &Connection) -> Result<Rotation, String> {
    plan_excluding(conn, None)
}
```

⚠️ **`plan` cannot be reused as it stands, and this was checked rather than assumed.** It answers
`NOT_ON_THE_ROSTER` when `removing` matches no device (`identity.rs:733`), so `plan(conn, "")` is a
refusal and not a no-op. Extract its body into:

```rust
fn plan_excluding(conn: &Connection, removing: Option<&str>) -> Result<Rotation, String>
```

`None` skips **both** the `NOT_ON_THE_ROSTER` check and the per-peer `continue` that drops the
excluded device; the `revoked_at.is_some()` skip stays in every case. Then `plan(conn, removing)`
becomes `plan_excluding(conn, Some(removing))` and its two existing callers are untouched.

Then the two `sync_state` helpers, in the shape this file already uses for that table.

- [ ] **Step 4: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_pair::identity`
Expected: PASS. Report the selected test count.

- [ ] **Step 5: Mutate**

Make `plan_join` omit the joining device from `keys`. The first test must FAIL. Restore.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/sync_pair/identity.rs
git commit -m "feat(sync): a join publishes the roster, so a paired device is not evicted later"
```

---

### Task 4: The rendezvous client, and the join retry

**Files:**
- Modify: `src-tauri/src/sync_engine/client.rs`

**Interfaces:**
- Consumes: `entitlement::base(conn)`, `http()`, `identity::{plan_join, roster_is_dirty,
  set_roster_dirty}`, `post_rotation`.
- Produces:
  - `client::post_rendezvous(conn: &Connection, rv: &str, slot: &str, blob: &str) -> Result<(), String>`
  - `client::get_rendezvous(conn: &Connection, rv: &str, slot: &str) -> Result<Option<String>, String>`
  - `client::publish_join(conn: &Connection) -> Result<(), String>` — **`async`**, no argument
  - `pub const RENDEZVOUS_TAKEN: &str` — the sentence for a 409

  `post_rendezvous` and `get_rendezvous` are `async` too; every caller is already on the blocking
  pool with a runtime of its own.

- [ ] **Step 1: Write the failing tests**

Add to `src-tauri/src/sync_engine/client/tests.rs`, using that file's existing `httpmock` shape:

The first one written out in full as the template for the rest — `RELAY`, `seeded_group` and the
`MockServer` shape all come from that file already, so read its top fifty lines and substitute the
real helper names:

```rust
#[tokio::test]
async fn a_rendezvous_post_carries_the_blob_and_answers_nothing() {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST).path(format!("/p/{RV}/join"));
        then.status(204);
    });
    let conn = seeded_group();
    set_relay_url(&conn, &server.base_url());

    post_rendezvous(&conn, RV, "join", "ABCDE").await.expect("a 204 is success");

    mock.assert();
    let body: serde_json::Value =
        serde_json::from_slice(&mock.calls().first().expect("one call").body).expect("json");
    assert_eq!(body["blob"], "ABCDE", "the blob is the only field the relay is sent");
}
```

with `const RV: &str = "0123456789abcdef0123456789abcdef";` beside it. Then:

```rust
#[test]
fn a_409_from_the_rendezvous_is_its_own_sentence() {
    // Not "the pairing failed": somebody else answered this code, which is a different fix.
    // Mock 409 and assert the error string is RENDEZVOUS_TAKEN.
}

#[test]
fn an_empty_rendezvous_is_none_and_never_an_error() {
    // Mock 404 and assert Ok(None). A poll that treated "not yet" as a failure would put an
    // error in front of a reader every 1.5 seconds while the other device was still being
    // picked up.
}

#[test]
fn publish_join_marks_the_roster_dirty_when_the_relay_refuses() {
    // Mock /rotate 401 (a group with no membership). Assert publish_join is Ok — a first
    // pairing must not fail because nothing is syncing yet — and that roster_is_dirty is true.
    // ALSO assert the local epoch did NOT move: a refused publish must leave the group exactly
    // as it was, or the device is ahead of a relay that never accepted it.
}

#[test]
fn publish_join_commits_the_epoch_it_published() {
    // The severe one. Mock /rotate 200, then assert identity::group(&conn).epoch equals the
    // epoch that was posted. A publish without a local commit leaves this device BEHIND its own
    // rotation, and `check_keys` then reads a higher epoch with no blob for it — which is the
    // removal notice. The device that pressed Codes match would leave its own group.
}

#[test]
fn publish_join_clears_the_mark_when_the_relay_accepts() {
    // Mock /rotate 200. Assert roster_is_dirty is false afterwards.
}
```

Write these out fully against the existing helpers in that file — read
`register_keys`/`when.method(GET)` usage first and mirror it.

- [ ] **Step 2: Run and watch fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_engine::client`
Expected: FAIL — unresolved names.

- [ ] **Step 3: Implement**

```rust
/// What a 409 from the rendezvous says.
///
/// **Its own sentence, and not "the pairing failed".** First-write-wins means a filled slot is
/// somebody else having answered this code — a different situation with a different fix, which is
/// to start a fresh offer on the first device rather than to try again here.
pub const RENDEZVOUS_TAKEN: &str =
    "That pairing code has already been answered on another device. Start a new one on the \
     device showing the code.";
```

`post_rendezvous`: `POST {base}/p/{rv}/{slot}` with `{"blob": …}`, `content-type: application/json`,
written by hand rather than through reqwest's `json` feature (this crate does not enable it — see
`client.rs`'s existing comment). 204 → `Ok(())`; 409 → `Err(RENDEZVOUS_TAKEN)`; anything else →
`Err` through `errors::Source::Relay`.

`get_rendezvous`: `GET {base}/p/{rv}/{slot}`. **404 → `Ok(None)`, and that is the important line** —
a poll that treated "not yet" as an error would show the reader a failure every 1.5 seconds.
200 → `Ok(Some(blob))`.

`publish_join`:

```rust
/// Carry a join to the rest of the group. **Best effort, and its failure is recorded rather than
/// raised.**
///
/// A first pairing is the common case that *cannot* publish: `/rotate`'s door is the group auth or
/// the refresh secret, and a group that has never claimed has no entitlement row, so it answers
/// 401. That is not an error the reader can act on — nothing is syncing yet, so there is no
/// divergence to carry — so the debt is marked and paid on the first sync that has a membership.
/// ⚠️ **`commit_rotation` after the relay accepts, and never before or not at all.** `plan`'s
/// manifest names **peers only** — `roster()` reads `sync_devices`, which holds no row for this
/// device — so a device that published epoch *N+1* without committing would sit at *N* and its very
/// next `check_keys` would read a higher epoch with **`blob: null` for itself**, which
/// `client::KeyOutcome::Removed` defines as the removal notice. **The device that pressed *Codes
/// match* would dissolve its own group on its next sync.** Committing makes the epochs equal, so
/// `check_keys` answers `Current` and never reads the manifest at all. This is `remove_device`'s
/// order exactly.
pub async fn publish_join(conn: &Connection) -> Result<(), String> {
    let Ok(plan) = identity::plan_join(conn) else {
        identity::set_roster_dirty(conn, true)?;
        return Ok(());
    };
    if post_rotation(conn, &plan).await.is_err() {
        // Nothing committed, so the group is exactly as it was and the debt is recorded.
        return identity::set_roster_dirty(conn, true);
    }
    // `""` removes nobody: `commit_rotation`'s `DELETE … WHERE device_id = ?1` matches no row,
    // which is what a join wants. Its `baselined_at = NULL` sweep is wanted in full — a joining
    // device needs every peer's last words carried across the epoch boundary.
    identity::commit_rotation(conn, "", &plan)?;
    identity::set_roster_dirty(conn, false)
}
```

- [ ] **Step 4: Wire the retry into `round_trip`**

Where `check_keys` already runs — above the token fetch — add: if `roster_is_dirty(conn)?` and this
device is in a group, call `publish_join(conn)` once and ignore a failure.
⚠️ It publishes **from the local roster**, and must not read the relay's manifest to decide: a group
that has claimed and never rotated answers `devices: []` at the claim epoch, and treating that as
evidence would be exactly the "dissolve every device" bug `client.rs` already guards against by
comparing epochs first. A race between two devices publishing at once is settled by `/rotate`'s 409
on a non-advancing epoch; the loser adopts.

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_engine::client`
Expected: PASS. Report the selected count.

- [ ] **Step 6: Mutate**

Make `get_rendezvous` return `Err` on 404. `an_empty_rendezvous_is_none_and_never_an_error` must
FAIL. Restore.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/sync_engine/
git commit -m "feat(sync): the rendezvous client, and a join that is published or owed"
```

---

### Task 5: The state machine — `poll`, and the new `confirm`

**Files:**
- Modify: `src-tauri/src/sync_pair/pairing.rs`, `src-tauri/src/desktop.rs`

**Interfaces:**
- Consumes: `crypto::rendezvous_id`, `invite::qr_payload`, `client::{post_rendezvous,
  get_rendezvous, publish_join, RENDEZVOUS_TAKEN}`, `camera::install` (Task 9).
- Produces: `PairingProgress { stage: String, sas: Option<String> }` where `stage` is
  `"idle" | "waiting" | "compare" | "complete"`; command `sync_pairing_poll`.

- [ ] **Step 1: Write the failing tests**

Drive the pure functions, not the commands. Cover:

```rust
#[test]
fn an_offer_carries_a_url_and_the_typed_code_is_unchanged() {
    // Offer.code is still 105 chars + hyphens; Offer.qr is built from qr_payload.
}

#[test]
fn the_two_sides_derive_the_same_rendezvous() {
    // begin on A, accept on B with A's code: crypto::rendezvous_id of each side's token match.
    // This is the whole reason the ceremony works without a second hand-carry.
}

#[test]
fn confirm_seals_at_the_current_epoch_and_the_layout_is_unchanged() {
    // <device_id>\0 then a seal over <group_id>\0<epoch>\0<32-byte key>. Key LAST.
    // A field appended after the key is swallowed by any group key holding a zero byte —
    // about one pairing in eight — so this test pins the order, not just the contents.
}

#[test]
fn a_group_key_full_of_zero_bytes_still_round_trips() {
    // The deliberate all-zero-key fixture. Without it the failure ships as a flake nobody can
    // reproduce: measured 2026-08-29, the randomly-keyed failures moved 1, 3, 2, 2, 1 across
    // five runs while this one failed every time.
}

#[test]
fn a_spent_offer_refuses_a_second_joiner() { /* ALREADY_USED, unchanged behaviour */ }

#[test]
fn a_substituted_rendezvous_blob_moves_the_six_digits() {
    // **The rendezvous is exactly the hop the SAS exists to distrust**, and this is the test
    // that says so now that a relay carries the blobs rather than a reader. Run the existing
    // three-party MITM exchange, but hand A the *attacker's* response instead of B's: A's
    // digits must differ from B's. Probabilistic at the SAS's own strength — two unrelated
    // six-digit codes collide once in a million — which is what §7.5 step 3 is worth.
    assert_ne!(a_side_sas, b_side_sas);
}
```

⚠️ The existing man-in-the-middle test is a real three-party exchange and **must not be replaced**.
Add the assertion above beside it; the rendezvous does not touch the crypto, and the point is to
pin that a relay swapping bytes still shows up on the two screens.

- [ ] **Step 2: Run and watch fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_pair::pairing`

- [ ] **Step 3: Extend `Pending` and `begin`**

`Pending` gains `rv: String`, `posted: bool`, `expires_at: i64` (unix ms). `begin` fills `rv` from
`crypto::rendezvous_id(&token)` and sets the expiry ten minutes out — `relay/src/rendezvous.ts`'s
`RENDEZVOUS_TTL_MS`, and the two are held together by nothing a build can check, so say so in a
comment beside it the way `baseline::TAIL_MS` does.

`Offer.qr` is built from `invite::qr_payload(&code, &entitlement::base(conn))`, **not** from the
bare code. `Offer.code` is unchanged — the typed form keeps its hyphens.

- [ ] **Step 4: `accept` posts, and stops returning a blob**

After deriving, `client::post_rendezvous(conn, &rv, "join", &blob_encode(&blob))`, then set
`posted = true`. `Handshake` loses its `response` field entirely; it is now `{ sas }`.

- [ ] **Step 5: `confirm` — the order is the design**

```
1. identity::room_for(conn, &peer_id)          // the cap, refused at the press, unchanged
2. seal at the CURRENT epoch; post to /p/{rv}/offer   // fails => nothing has changed locally
3. create_group + add_device(B)                       // commit
4. client::publish_join(conn).await                   // best effort; marks roster_dirty on failure
```

⚠️ **Step 2 before step 3 is what makes a failed post cost nothing**, and sealing the *current* key
is what keeps the blob byte-identical to the build that shipped. Do not rotate before sealing: it
would have to seal a key at an epoch the relay has not yet accepted, and that ordering has no safe
answer.

- [ ] **Step 6: `poll`**

```rust
/// What the panel asks every 1.5 seconds while a pairing is in flight.
///
/// **One command for both sides**, because the state it reads already knows which side this is:
/// the initiator is waiting for an answer, the joiner for a key. Two commands would be two things
/// for the panel to decide between using state it would have to be handed first.
pub fn poll(conn: &Connection, pending: &mut Option<Pending>, now_ms: i64)
    -> Result<PairingProgress, String>
```

- nothing in flight → `stage: "idle"`
- past `expires_at` → clear `pending` and answer an error naming the expiry, so the panel says the
  code timed out rather than polling a 404 for ever
- **initiator**, no `pair_key` yet → `get_rendezvous(conn, rv, "join")`; `None` → `"waiting"`;
  `Some` → run the existing `respond` body and answer `"compare"` with the digits
- **initiator**, `spent` → `"complete"`
- **joiner**, not yet joined → `get_rendezvous(conn, rv, "offer")`; `None` → `"compare"` with the
  digits it already has; `Some` → run the existing `complete` body and answer `"complete"`

`respond` and `complete` **keep their bodies and lose their `#[tauri::command]`s**; `poll` calls
them. The tests that drive them directly stay exactly as they are.

- [ ] **Step 7: `desktop.rs`**

Remove `sync_pairing_respond` and `sync_pairing_complete` from the `invoke_handler` list; add
`sync_pairing_poll`. Add the one call site for Task 9's `crate::camera::install(&window)` where the
main window is built.

`sync_pairing_poll` is `async` and goes to the blocking pool with a runtime of its own —
`sync_device_revoke`'s exact shape, and for its reason: the write connection is behind a `Mutex`, a
guard cannot cross an `await` on a multi-threaded runtime, and `spawn_blocking` moves the trip to a
thread where `block_on` is legal.

- [ ] **Step 8: Run the tests, mutate, commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_pair::pairing` — report the count.
Mutate: swap steps 2 and 3 of `confirm`; a test asserting nothing is committed when the post fails
must FAIL. Add that test if it does not exist.

```bash
git add src-tauri/src/sync_pair/pairing.rs src-tauri/src/desktop.rs
git commit -m "feat(sync): pair from one side, with the relay carrying both answers"
```

---

### Task 6: The IPC surface

**Files:**
- Modify: `src/lib/ipc.ts`

**Interfaces:**
- Produces:

```ts
export interface PairingHandshake {
  sas: string;
}

/** What `sync_pairing_poll` answers. `stage` drives the panel and nothing else does. */
export interface PairingProgress {
  /** `"idle" | "waiting" | "compare" | "complete"` */
  stage: string;
  /** The six digits, once both sides have them. */
  sas: string | null;
}
```

- [ ] **Step 1** — Delete `syncPairingRespond` and `syncPairingComplete`. Delete
  `PairingHandshake.response`. Add:

```ts
  /** Where a pairing has got to. Polled while one is in flight; answers `idle` when none is. */
  syncPairingPoll: () => invoke<PairingProgress>("sync_pairing_poll"),
```

- [ ] **Step 2** — Run `npx tsc --noEmit` and fix only what is in this file. `SyncPanel.tsx` will be
  red until Task 7; that is expected and is not this task's to fix. **Report it rather than
  patching it.**

- [ ] **Step 3: Commit**

```bash
git add src/lib/ipc.ts
git commit -m "feat(sync): the pairing IPC surface loses two commands and gains a poll"
```

---

### Task 7: The panel

**Files:**
- Modify: `src/features/settings/SyncPanel.tsx`, `src/features/settings/QrCode.tsx`

**Interfaces:**
- Consumes: `ipc.syncPairingPoll`, `PairingProgress`, `<QrScanner onCode={} onCancel={} />` (Task 8).

- [ ] **Step 1: `QrCode.tsx`** — `size-56` → `size-72`. Add to its doc comment: the payload is now
  a 162-byte URL, a version-9 symbol at level M (53×53 modules), so 224px was 3.67 px per module and
  288px is 4.72. **Leave `bg-white` and `fill="#000"` exactly as they are** — that warning is why
  the code is scannable at all.

- [ ] **Step 2: The `Flow` union** becomes:

```ts
type Flow =
  | { kind: "idle" }
  | { kind: "reading" }                                  // B is entering or scanning
  | { kind: "scanning" }                                 // B has the camera open
  | { kind: "offer"; offer: PairingOffer; sas: string | null }   // A
  | { kind: "join"; sas: string };                       // B, after accept
```

- [ ] **Step 3: The poll.** One `useQuery` with `refetchInterval: 1500`, enabled only while
  `flow.kind` is `"offer"` or `"join"`. `staleTime: 0` — ⚠️ `src/lib/query.ts` caches 30 s by
  default, and a poll that answered from cache would sit on `waiting` after the other device had
  already answered. On `stage === "compare"` set the digits; on `"complete"` invalidate `PAIRING_KEY`
  and return to `idle` with a success line.

- [ ] **Step 4: Delete** the `Blob` component, the "What the other device answered" `Paste`, the
  "The wrapped key the other device gave you" `Paste`, and the joining side's *Codes match* button.

- [ ] **Step 5: The copy.** A's waiting line: *"Waiting for the other device…"*. A's compare line is
  unchanged. B's line replaces its old button: *"Compare these with the other device, then press
  Codes match there."* Keep *Cancel* on both sides. The intro paragraph gains one sentence: the
  other device needs to be online, because pairing now goes through the relay.

- [ ] **Step 6:** `Enter a code from another device` gains a sibling **`Scan a code`** button that
  sets `flow = { kind: "scanning" }` and renders `<QrScanner>`. Its `onCode` runs the same
  `accept.mutate(code)` the paste box does — `Invite::decode` takes the URL form, so no parsing
  happens here.

- [ ] **Step 7:** `npx tsc --noEmit` clean, then commit.

```bash
git add src/features/settings/SyncPanel.tsx src/features/settings/QrCode.tsx
git commit -m "feat(sync): one code, one screen to compare, and a Scan button"
```

---

### Task 8: `<QrScanner>`

**Files:**
- Create: `src/features/settings/QrScanner.tsx`
- Modify: `package.json`

**Interfaces:**
- Produces: `export function QrScanner({ onCode, onCancel }: { onCode: (text: string) => void;
  onCancel: () => void }): JSX.Element`

- [ ] **Step 1:** `npm install jsqr` — **Apache-2.0** (this line said MIT; corrected in Task 11's
  docs pass, 2026-08-31 — the installed package and its `LICENSE` both say Apache-2.0), no
  transitive dependencies. Not `zxing-wasm`, which is far larger for a job this size, and not
  `BarcodeDetector`, which is **`undefined` in WebView2** (measured 2026-08-31).

- [ ] **Step 2: Write the component.** `getUserMedia({ video: { facingMode: "environment" } })` →
  `<video srcObject muted playsInline>` → a `requestAnimationFrame` loop drawing to an offscreen
  `<canvas>` → `jsQR(imageData.data, width, height)`. On a hit, stop every track and call `onCode`.

  Carry this in its doc comment, because it is the thing that cost a session:

  > ⚠️ **`NotSupportedError` here does not mean the browser lacks the API.** Measured 2026-08-31:
  > in the Tauri WebView2, permissions policy allows `camera`, `permissions.query` answers
  > `granted`, a `videoinput` device is enumerated — and both `{video:true}` and `{audio:true}`
  > still fail with `NotSupportedError: Not supported`. It is an unhandled WebView2
  > `PermissionRequested`, which `src-tauri/src/camera.rs` handles. **The CSP is not involved**;
  > `sync.md` said it was, and `media-src` governs a `<video src>` fetch while `srcObject` is not
  > one.

- [ ] **Step 3:** Every track stopped on unmount, on `onCancel`, and on a hit. A camera left running
  is a lit indicator light on the reader's machine after they have moved on.

- [ ] **Step 4:** An error path with a real sentence: `NotAllowedError` → *"MTG Grimoire needs
  camera access to scan a code."*; `NotFoundError` → *"No camera on this device — type the code
  instead."*; anything else → the error name, plus the paste box.

- [ ] **Step 5:** ⚠️ **No vitest for the camera.** jsdom has neither `getUserMedia` nor canvas
  pixels. Write `QrScanner.stories.tsx` driving `onCode` directly instead — the *parsing* is worth a
  test and the camera is not. Call `mcp__mtg-grimoire-sb-mcp__get-storybook-story-instructions`
  before writing it, and `preview-stories` after.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/features/settings/QrScanner.tsx src/features/settings/QrScanner.stories.tsx
git commit -m "feat(sync): a QR scanner, camera to code"
```

---

### Task 9: The camera permission, on both platforms

**Files:**
- Create: `src-tauri/src/camera.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/gen/android/app/src/main/AndroidManifest.xml`,
  `src-tauri/tauri.conf.json` (only if Step 2's fallback is taken — but it is **this task's** file
  either way, so no sibling touches it)

**Interfaces:**
- Produces: `camera::install(window: &tauri::WebviewWindow)` — called by Task 5 from `desktop.rs`.

- [ ] **Step 1:** ⚠️ **Declare `mod camera;` in `lib.rs` in the same commit as the file.** An
  undeclared module compiles to nothing and every test in it is vacuous — this repo lost four waves
  to exactly that.

- [ ] **Step 2: Windows.** In `camera.rs`, behind `#[cfg(windows)]`, use `window.with_webview(…)`
  and `webview2-com` to `add_PermissionRequested`, granting **only** `CAMERA` and denying the rest.
  Scoped, so nothing is granted while the reader is not on the scanner.

  Fallback if that proves fiddly: `additionalBrowserArgs` in `tauri.conf.json` carrying
  `--use-fake-ui-for-media-stream`, which is **proven** to open a real camera (measured 2026-08-31:
  `Lenovo 500 RGB Camera (17ef:482f)`, 640×480 @ 30 fps). ⚠️ It auto-grants camera *and* microphone
  for the whole webview for ever, and ⚠️ setting `additionalBrowserArgs` **replaces** Tauri's own
  default arguments rather than appending. Take the handler first; report if you fall back.

- [ ] **Step 3: Android.** Add to `AndroidManifest.xml`, beside the existing `INTERNET` line:

```xml
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
```

`android:required="false"` so the app still installs on a device with no camera — the typed code
still works there.

- [ ] **Step 4: The App Link.** Inside the existing `<activity>`, a second `intent-filter`:

```xml
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https"
                      android:host="mtg-grimoire-relay.denmark-east.workers.dev"
                      android:path="/pair" />
            </intent-filter>
```

`android:launchMode="singleTask"` is already set, which is what this wants.

- [ ] **Step 5:** ⚠️ **Android's camera is unverified and this task does not verify it.** Record in
  the task report that the named test is still owed: build the APK, open the scanner on the phone,
  and run `getUserMedia({video:true})` over adb + CDP. If wry does not grant `onPermissionRequest`,
  a Kotlin shim is a task of its own.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/camera.rs src-tauri/src/lib.rs src-tauri/gen/android/app/src/main/AndroidManifest.xml
git commit -m "feat(sync): grant the camera, and let a scanned link open the app"
```

---

### Task 10: The panel's suites

**Files:**
- Modify: `src/features/settings/SyncPanel.test.tsx`, `src/features/settings/SyncPanel.stories.tsx`

- [ ] **Step 1:** Delete every test and story that drives the two removed paste boxes or the
  joining side's *Codes match*. ⚠️ **Audit the mocks while you are there**: a mock asserting the old
  three-blob truth stays green for ever and encodes a state that can no longer happen.

- [ ] **Step 2:** New tests — A goes `waiting → compare` when the poll answers a peer; A's *Codes
  match* is `aria-disabled` **and its handler refuses the press** until the digits exist; B shows
  digits and has **no** confirm button; `"complete"` returns the panel to idle; an expired pairing
  says so. Use fake timers for the poll and remember `advanceTimersByTime(0)` after a
  `setQueryData`, or the write is not on screen.

- [ ] **Step 3:** Stories for each state, both sides. `get-storybook-story-instructions` first,
  `preview-stories` after, and put every returned preview URL in the report.

- [ ] **Step 4:** Run `npx vitest run src/features/settings/SyncPanel.test.tsx`, then commit.

```bash
git add src/features/settings/
git commit -m "test(sync): the panel's four states per side"
```

---

### Task 11: The record

**Files:**
- Modify: `docs/reference/sync.md`, `CLAUDE.md`, `src-tauri/CLAUDE.md`, `src/CLAUDE.md`,
  `docs/reference/hosted-relay-deploy.md`

- [ ] **Step 1:** ⚠️ **Correct `sync.md`'s "The two things §7.5 asked for that are not here"** — both
  are here now, and the CSP sentence in it is **wrong about the mechanism**. Replace with §3 of the
  spec: the measured table, and `NotSupportedError` being an unhandled `PermissionRequested`.

- [ ] **Step 2:** The protocol table at `sync.md:37` — rewrite for the new ceremony. Add the
  rendezvous to the relay route table, on the outside-the-gate side, with the reason.

- [ ] **Step 3:** Record what is now **two** costs: pairing needs the relay reachable, and an old
  build cannot pair with a new one.

- [ ] **Step 4:** `hosted-relay-deploy.md` gains the migration and the `assetlinks.json`
  fingerprint as deploy steps.

- [ ] **Step 5:** ⚠️ **A prose-only edit routes to neither CI job.** Re-count anything counted in
  the same commit. Better still, delete counts rather than update them.

- [ ] **Step 6: Commit**

```bash
git add docs/ CLAUDE.md src-tauri/CLAUDE.md src/CLAUDE.md
git commit -m "docs: pairing from one side, and the camera finding that corrects the CSP claim"
```

---

## Fan-in

- [ ] `npm run verify` — **once, here, and never inside a task.** ⚠️ Never run two at a time;
  concurrent runs fake ~18 Rust schema failures.
- [ ] ⚠️ `verify` does **not** run `cargo fmt` or `clippy`, and CI does. Run
  `cargo fmt --manifest-path src-tauri/Cargo.toml` and
  `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, plus
  `cargo clippy --lib --target wasm32-unknown-unknown -- -D warnings` (needs clang on PATH;
  `C:\Program Files\LLVM\bin` on this machine).
- [ ] ⚠️ **Check for CRLF flips** — a subagent write can flip a file's line endings and break
  source-parsing tests locally while CI stays green. `git diff --stat` against expectations.
- [ ] Ship with the **`auto-pr`** skill.
