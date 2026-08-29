# Hosted Relay and Patreon Entitlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** move every reader onto one relay Markus runs, gated on Patreon membership, with no
Cloudflare credential in the shipped binary and the entitlement enforced by the relay.

**Architecture:** the relay gains an entitlement layer (one D1 table, one Patreon adapter) and an
auth gate that verifies an HMAC-signed per-group token **in the Worker, before the Durable Object
hop**. The app gains a compiled-in `RELAY_BASE`, a claim/refresh client, and a Settings block that
replaces the relay-URL field. `group.ts` and `log.ts` keep their shape.

**Tech Stack:** Cloudflare Workers + Durable Objects + D1 (TypeScript, `@cloudflare/workers-types`);
Rust `reqwest` + `rusqlite`; React 19 + TanStack Query; vitest; `cargo test`.

**Spec:** [`docs/superpowers/specs/2026-08-29-hosted-relay-and-patreon-design.md`](../specs/2026-08-29-hosted-relay-and-patreon-design.md)

---

## Global Constraints

- **Subagents do not commit.** Parallel agents in this repo share one git index, so a bare
  `git commit` takes whatever a sibling staged. Each task ends by **reporting what it changed**;
  the controller runs `npm run verify` and commits after fan-in.
- **Tests run once, at the end, after fan-in.** A subagent's slice compiles against a tree its
  siblings are still changing. Do not run `npm run verify` inside a task.
- **Never run two `npm run verify` at once** — concurrent runs fake ~18 Rust schema failures.
- **`relay/src/` is a separate TypeScript program.** `tsconfig.relay.json` pins
  `"types": ["@cloudflare/workers-types"]`, `"lib": ["ES2022"]`, no `DOM`, no Node types.
  **`import ... from "node:crypto"` will not type-check there, and `@types/node` is banned
  repo-wide.** `npm run build` runs `tsc -p tsconfig.relay.json`, so this is enforced.
- **Relay tests run in the root vitest** — `vite.config.ts` includes `relay/src/**/*.test.ts`.
- **`noUnusedLocals` and `noUnusedParameters` are on** in every program.
- **Adding a dependency with permissions means adding its narrowest permission, never `:default`.**
  No new dependency is needed by this plan.
- **`data/` is the user's and is never committed.**
- Commit style: `feat:` / `fix:` / `chore:` / `test:`.
- **Mutate your own tests.** Before reporting, break the code each test covers and confirm the
  test fails. **Say so explicitly if any assertion survives the mutation** — that is a finding,
  not a formality.

### Names fixed across tasks

Copy these verbatim; several tasks depend on them and their implementers cannot see each other.

| Name | Where | Shape |
| --- | --- | --- |
| `RELAY_BASE` | `sync_engine/entitlement.rs` | `pub const RELAY_BASE: &str` |
| `ACCESS_TOKEN` / `REFRESH_SECRET` / `ACCESS_EXPIRES` | `sync_engine/entitlement.rs` | `sync_state` key constants |
| `md5(data: Uint8Array): Uint8Array` | `relay/src/md5.ts` | pure |
| `hmacMd5(key, message): Uint8Array` | `relay/src/md5.ts` | pure |
| `hex(bytes: Uint8Array): string` | `relay/src/md5.ts` | pure |
| `Claims { sub: string; grp: string; exp: number }` | `relay/src/token.ts` | interface |
| `mint(claims, secret): Promise<string>` | `relay/src/token.ts` | HMAC-SHA256 via WebCrypto |
| `verify(token, secret, nowMs): Promise<Claims \| null>` | `relay/src/token.ts` | |
| `Status = "active" \| "grace" \| "dead"` | `relay/src/entitlement.ts` | |
| `decide(patronStatus, nowMs, graceUntil): Decision` | `relay/src/entitlement.ts` | pure |
| `GRACE_MS` | `relay/src/entitlement.ts` | 7 days |
| `sync_patreon_begin` / `sync_patreon_claim` / `sync_supporter_status` | Tauri commands | |
| `SupporterStatus` | `sync_engine/commands.rs` + `ipc.ts` | `{ connected, status, since, groupBound }` |

---

## File Structure

**Relay — new**

| File | Responsibility |
| --- | --- |
| `relay/src/md5.ts` | MD5 and HMAC-MD5, pure. Patreon's webhook signature needs it and no runtime here offers it. |
| `relay/src/md5.test.ts` | RFC 1321 and RFC 2202 vectors. |
| `relay/src/token.ts` | Mint and verify the access token. Pure but for WebCrypto. |
| `relay/src/token.test.ts` | Tamper, expiry, group mismatch. |
| `relay/src/entitlement.ts` | `patron_status` + clock → `Status`. Pure. |
| `relay/src/entitlement.test.ts` | Grace opening, closing, and reprieve. |
| `relay/src/patreon.ts` | OAuth exchange, identity fetch, webhook verification and handling. |
| `relay/src/claim.ts` | The callback landing page, the claim code, `/claim` and `/token`. |
| `relay/schema.sql` | The D1 `entitlements` and `claim_codes` tables. |

**Relay — modified**

| File | Change |
| --- | --- |
| `relay/src/index.ts` | The auth gate ahead of the DO hop; the four new routes; the cron handler. |
| `relay/src/group.ts` | One `drop` action that empties the log. |
| `relay/wrangler.jsonc` | D1 binding, cron trigger. |
| `relay/README.md` | Rewritten — it currently denies everything this builds. |

**App — Rust**

| File | Change |
| --- | --- |
| `src-tauri/src/sync_engine/entitlement.rs` | **new** — `RELAY_BASE`, the three `sync_state` keys, `claim`, `refresh`, `bearer`. |
| `src-tauri/src/sync_engine/mod.rs` | Declare the module. **An undeclared module makes every test in it vacuous.** |
| `src-tauri/src/sync_engine/client.rs` | `relay_url` falls back to `RELAY_BASE`; `Authorization` on all four call sites. |
| `src-tauri/src/sync_engine/client/tests.rs` | Auth-header assertions; 401 handling. |
| `src-tauri/src/sync_engine/commands.rs` | Three new commands; `sync_relay_set_url` and `valid_relay_url` deleted. |
| `src-tauri/src/desktop.rs` | Registration, lines 513–515. |
| `src-tauri/src/sync_pair/pairing.rs` | `refresh` into the sealed blob, **before** the key. |

**App — TypeScript**

| File | Change |
| --- | --- |
| `src/lib/ipc.ts` | Three commands added, `syncRelaySetUrl` removed, `SupporterStatus` type. |
| `src/features/settings/SyncPanel.tsx` | `RelaySection` becomes `SupporterSection`. |
| `src/features/settings/SyncPanel.test.tsx` | Follows. |
| `src/features/settings/SyncPanel.stories.tsx` | Follows. |

**Docs**

`CLAUDE.md`, `docs/reference/sync.md`, `docs/superpowers/specs/2026-08-27-cross-platform-design.md` §7.7.

---

## Wave 1 — no task touches a file another touches

Tasks 1–5 may run concurrently.

---

### Task 1: MD5 and HMAC-MD5, from scratch

**Files:**
- Create: `relay/src/md5.ts`
- Test: `relay/src/md5.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `md5(data: Uint8Array): Uint8Array`, `hmacMd5(key: Uint8Array, message: Uint8Array): Uint8Array`,
  `hex(bytes: Uint8Array): string`, `timingSafeEqualHex(a: string, b: string): boolean`.

**Why this exists rather than a runtime call.** Patreon signs `X-Patreon-Signature` as the hex
digest of the body, HMAC signed with **MD5**. Workers exposes MD5 through
`crypto.subtle.digest("MD5", …)` as a documented non-standard extension, but **HMAC's supported
hashes do not include it**, so `importKey`/`sign` is not a route. Injecting Node's
`createHash("md5")` for the test is also not a route: `tsconfig.relay.json` pins
`"types": ["@cloudflare/workers-types"]` and `@types/node` is banned repo-wide. A pure
implementation type-checks in that program, runs in vitest and runs in workerd, and is pinned by
published vectors.

- [ ] **Step 1: Write the failing test**

`relay/src/md5.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hex, hmacMd5, md5, timingSafeEqualHex } from "./md5";

const utf8 = (s: string) => new TextEncoder().encode(s);
const repeat = (byte: number, n: number) => new Uint8Array(n).fill(byte);

describe("md5", () => {
  // RFC 1321 appendix A.5, verbatim. These are the whole point of writing MD5 by hand:
  // the implementation is pinned to a published answer rather than to its own output.
  it.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "d174ab98d277d9f5a5611c2c9f419d9f",
    ],
  ])("hashes %j", (input, expected) => {
    expect(hex(md5(utf8(input)))).toBe(expected);
  });

  it("crosses the 56-byte padding boundary correctly", () => {
    // 56 bytes is where MD5 needs a whole extra block for the length field. An
    // implementation that pads in one block is right for 55 bytes and wrong here.
    expect(hex(md5(utf8("a".repeat(55))))).toBe("ef1772b6dff9a122358552954ad0df65");
    expect(hex(md5(utf8("a".repeat(56))))).toBe("3b0c8ac703f828b04c6c197006d17218");
  });
});

describe("hmacMd5", () => {
  // RFC 2202 section 2. Case 6 is the one that matters most: an 80-byte key exercises the
  // "hash the key first" branch, which is silently skippable and wrong forever if skipped.
  it("matches RFC 2202 case 1", () => {
    expect(hex(hmacMd5(repeat(0x0b, 16), utf8("Hi There")))).toBe(
      "9294727a3638bb1c13f48ef8158bfc9d",
    );
  });

  it("matches RFC 2202 case 2", () => {
    expect(hex(hmacMd5(utf8("Jefe"), utf8("what do ya want for nothing?")))).toBe(
      "750c783e6ab0b503eaa86e310a5db738",
    );
  });

  it("matches RFC 2202 case 3", () => {
    expect(hex(hmacMd5(repeat(0xaa, 16), repeat(0xdd, 50)))).toBe(
      "56be34521d144c88dbb8c733f0e8b3f6",
    );
  });

  it("matches RFC 2202 case 6, whose key is longer than the block", () => {
    expect(
      hex(hmacMd5(repeat(0xaa, 80), utf8("Test Using Larger Than Block-Size Key - Hash Key First"))),
    ).toBe("6b1ab7fe4bd7bf8f0b62e6ce61b9d0cd");
  });
});

describe("timingSafeEqualHex", () => {
  it("accepts an exact match and rejects everything else", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abc")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(true);
  });

  it("is case-insensitive, because a hex digest is", () => {
    expect(timingSafeEqualHex("ABCD", "abcd")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test:run -- relay/src/md5.test.ts`
Expected: FAIL — `Failed to resolve import "./md5"`.

- [ ] **Step 3: Implement `relay/src/md5.ts`**

Write the standard RFC 1321 implementation. It must be a **module doc-commented** file in this
repository's voice, explaining *why* it exists (the two dead ends above) rather than what MD5 is.
Required shape:

```ts
/** Per-round shift amounts, RFC 1321 section 3.4. */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** `K[i] = floor(2^32 * abs(sin(i + 1)))`, RFC 1321 section 3.4. */
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));

const BLOCK = 64;

export function md5(data: Uint8Array): Uint8Array { /* ... */ }
export function hex(bytes: Uint8Array): string { /* ... */ }
export function hmacMd5(key: Uint8Array, message: Uint8Array): Uint8Array { /* ... */ }
export function timingSafeEqualHex(a: string, b: string): boolean { /* ... */ }
```

Requirements the tests pin, each of which is a real way to get this wrong:

- **Padding**: append `0x80`, then zeros until `length % 64 === 56`, then the original bit length
  as a **little-endian** 64-bit value. The 55/56-byte test is what catches a one-block padder.
- **Everything is little-endian.** MD5's word order is the opposite of SHA's, and this is the
  most common transcription error.
- **Keep arithmetic in unsigned 32-bit**: `>>> 0` after every add, and `(x << s) | (x >>> (32 - s))`
  for the rotate. JavaScript bitwise operators produce signed 32-bit values.
- **`hmacMd5`**: if `key.length > BLOCK`, replace it with `md5(key)` **first** — RFC 2202 case 6
  is the only test that fails if you skip it. Then zero-pad to 64, XOR with `0x36` for ipad and
  `0x5c` for opad, and return `md5(opad ‖ md5(ipad ‖ message))`.
- **`timingSafeEqualHex`**: lowercase both, compare lengths first, then OR the XOR of every char
  code across the whole string. **Do not return early on the first mismatch.**

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test:run -- relay/src/md5.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Type-check the relay program alone**

Run: `npx tsc -p tsconfig.relay.json`
Expected: no output. **This is the only type-check a relay task may run** — it is fast and it does
not collide with a sibling's build.

- [ ] **Step 6: Mutate, then report**

Change `0x5c` to `0x36` in `hmacMd5` and confirm every HMAC test fails. Change the padding
threshold from 56 to 64 and confirm the boundary test fails. Restore both. **Report any assertion
that survived.** Do not commit.

---

### Task 2: The access token

**Files:**
- Create: `relay/src/token.ts`
- Test: `relay/src/token.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Claims { sub: string; grp: string; exp: number }`;
  `mint(claims: Claims, secret: string): Promise<string>`;
  `verify(token: string, secret: string, nowMs: number): Promise<Claims | null>`;
  `TOKEN_TTL_MS: number` (24 hours).

**Why signed rather than looked up.** This is verified on **every** relay request, ahead of the
Durable Object hop. A storage read there would add a billable lookup to the hot path and put the
entitlement table in the way of every sync; an HMAC verify is a few microseconds and touches
nothing. The cost of that choice is that revocation is not instant for an already-issued token,
which is why the TTL is 24 hours and why the refresh secret (Task 4) is the thing that is actually
revoked.

- [ ] **Step 1: Write the failing test**

`relay/src/token.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mint, TOKEN_TTL_MS, verify, type Claims } from "./token";

const SECRET = "a-relay-hmac-key-for-tests-only";
const NOW = 1_756_000_000_000;
const claims = (over: Partial<Claims> = {}): Claims => ({
  sub: "sub_abc",
  grp: "0123456789abcdef0123456789abcdef",
  exp: NOW + TOKEN_TTL_MS,
  ...over,
});

describe("token", () => {
  it("round-trips the claims it was minted with", async () => {
    const token = await mint(claims(), SECRET);

    expect(await verify(token, SECRET, NOW)).toEqual(claims());
  });

  it("refuses a token signed with a different secret", async () => {
    // This is what rotating RELAY_HMAC_KEY does to every outstanding token, and the break-glass
    // depends on it being a refusal rather than a silent acceptance.
    const token = await mint(claims(), SECRET);

    expect(await verify(token, "some-other-key", NOW)).toBeNull();
  });

  it("refuses a token whose payload was edited", async () => {
    // The attack this exists to stop: take your own valid token and change `grp` to somebody
    // else's group id.
    const token = await mint(claims(), SECRET);
    const [payload, signature] = token.split(".");
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Claims;
    decoded.grp = "ffffffffffffffffffffffffffffffff";
    const forged = btoa(JSON.stringify(decoded)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    expect(await verify(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it("refuses a token that has expired", async () => {
    const token = await mint(claims({ exp: NOW - 1 }), SECRET);

    expect(await verify(token, SECRET, NOW)).toBeNull();
  });

  it("accepts a token one millisecond before it expires", async () => {
    // The boundary is worth pinning: an off-by-one here logs every reader out a day early or
    // a day late, and neither is visible in a passing suite that only tests the middle.
    const token = await mint(claims({ exp: NOW + 1 }), SECRET);

    expect(await verify(token, SECRET, NOW)).not.toBeNull();
  });

  it.each(["", "not-a-token", "a.b.c", "onlyonepart", ".", "a."])(
    "refuses the malformed token %j rather than throwing",
    async (bad) => {
      // The gate calls this on attacker-controlled input. A throw here is a 500 where a 401
      // belongs, and a 500 is a Durable Object request that should never have been billed.
      expect(await verify(bad, SECRET, NOW)).toBeNull();
    },
  );
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test:run -- relay/src/token.test.ts`
Expected: FAIL — cannot resolve `./token`.

- [ ] **Step 3: Implement `relay/src/token.ts`**

- `TOKEN_TTL_MS = 24 * 60 * 60 * 1000`.
- `mint`: `JSON.stringify(claims)` → base64url → HMAC-SHA256 with the secret via
  `crypto.subtle.importKey("raw", …, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])` →
  base64url of the signature → `` `${payload}.${signature}` ``.
- `verify`: split on `.` and **require exactly two non-empty parts**; recompute the signature over
  the payload; compare with a constant-time comparison; `JSON.parse` the payload inside a
  `try`/`catch`; validate that `sub` and `grp` are strings and `exp` is a finite number; return
  `null` when `claims.exp <= nowMs`. **Every failure path returns `null`; nothing throws.**
- Write base64url helpers in this file. `btoa`/`atob` exist in workerd; do not import anything.
- **Verify the signature before parsing the payload.** Parsing first hands unauthenticated JSON to
  the parser on every junk request.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test:run -- relay/src/token.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc -p tsconfig.relay.json` — expected: no output.

- [ ] **Step 6: Mutate, then report**

Make `verify` skip the expiry check and confirm two tests fail. Make it compare only the first 8
characters of the signature and confirm the forgery test fails. Restore. **Report any survivor.**
Do not commit.

---

### Task 3: The entitlement decision

**Files:**
- Create: `relay/src/entitlement.ts`, `relay/schema.sql`
- Test: `relay/src/entitlement.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Status = "active" | "grace" | "dead"`;
  `interface Decision { status: Status; graceUntil: number | null }`;
  `decide(patronStatus: string | null, nowMs: number, graceUntil: number | null): Decision`;
  `GRACE_MS: number`.

**The rule, from spec §7.2.** `active_patron` → `active`, clearing any grace. `declined_patron` is
a **failed card, not a cancellation** — Patreon retries it — so it opens a 7-day grace window on
first sight and keeps the existing `graceUntil` on later sightings, going `dead` only once that
window has passed. `former_patron`, `null`, and anything unrecognised → `dead` at once.

- [ ] **Step 1: Write the failing test**

`relay/src/entitlement.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decide, GRACE_MS } from "./entitlement";

const NOW = 1_756_000_000_000;

describe("decide", () => {
  it("makes an active patron active and clears any grace they were in", () => {
    // The reprieve: a reader whose card was declined and then went through must come all the
    // way back, not merely stop counting down.
    expect(decide("active_patron", NOW, NOW + 1000)).toEqual({
      status: "active",
      graceUntil: null,
    });
  });

  it("opens a seven-day window the first time a card is declined", () => {
    expect(decide("declined_patron", NOW, null)).toEqual({
      status: "grace",
      graceUntil: NOW + GRACE_MS,
    });
  });

  it("keeps the original deadline when a decline is seen again", () => {
    // Re-extending on every webhook or every cron pass would make the window unbounded, which
    // is the same as having no window.
    const opened = NOW - 2 * 24 * 60 * 60 * 1000;

    expect(decide("declined_patron", NOW, opened + GRACE_MS)).toEqual({
      status: "grace",
      graceUntil: opened + GRACE_MS,
    });
  });

  it("kills a decline once the window has passed", () => {
    expect(decide("declined_patron", NOW, NOW - 1)).toEqual({ status: "dead", graceUntil: null });
  });

  it("still holds at the exact instant the window ends", () => {
    expect(decide("declined_patron", NOW, NOW).status).toBe("grace");
  });

  it.each([["former_patron"], [null], ["something_patreon_added_later"], [""]])(
    "kills %j at once, with no grace",
    (status) => {
      // A cancellation is the reader's own decision, and an unrecognised value must fail
      // closed: an unknown string that read as active would be a free subscription forever.
      expect(decide(status, NOW, NOW + GRACE_MS)).toEqual({ status: "dead", graceUntil: null });
    },
  );

  it("is seven days", () => {
    expect(GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test:run -- relay/src/entitlement.test.ts`
Expected: FAIL — cannot resolve `./entitlement`.

- [ ] **Step 3: Implement `relay/src/entitlement.ts`**

`GRACE_MS = 7 * 24 * 60 * 60 * 1000`. A `switch` on `patronStatus` with `default` falling to
`dead` — **`default` is the fail-closed branch and must not be omitted**, and `noFallthroughCasesInSwitch`
is on.

- [ ] **Step 4: Write `relay/schema.sql`**

```sql
-- The relay's entitlement store. Applied with:
--   npx wrangler d1 execute mtg-grimoire-relay --remote --file=./schema.sql
--
-- `subject` is minted here and is NOT the Patreon user id. The Patreon id lives in exactly one
-- column of one table; the token, the group binding and every log line name the subject
-- instead. That is what lets a second source (Paddle) arrive later without a reader losing
-- their group.
CREATE TABLE IF NOT EXISTS entitlements (
  subject        TEXT PRIMARY KEY,
  source         TEXT NOT NULL,            -- 'patreon' today; 'paddle' later
  external_id    TEXT NOT NULL,
  status         TEXT NOT NULL,            -- 'active' | 'grace' | 'dead'
  grace_until    INTEGER,
  group_id       TEXT,                     -- bound on first claim, trust-on-first-use
  refresh_secret TEXT,                     -- NULL once revoked; this is what revocation clears
  patreon_refresh TEXT,                    -- for the daily reconciliation
  created_at     INTEGER NOT NULL,
  checked_at     INTEGER NOT NULL
);

-- One row per source, so a webhook naming a Patreon user finds the subject in one lookup.
CREATE UNIQUE INDEX IF NOT EXISTS entitlements_external
  ON entitlements (source, external_id);

-- The group binding must be unique too: two subjects bound to one group would each be able to
-- mint tokens for it, which is a shared subscription wearing two names.
CREATE UNIQUE INDEX IF NOT EXISTS entitlements_group
  ON entitlements (group_id) WHERE group_id IS NOT NULL;

-- The short-lived code the OAuth landing page shows the reader. One-time and ten minutes.
CREATE TABLE IF NOT EXISTS claim_codes (
  code       TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npm run test:run -- relay/src/entitlement.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Type-check**

Run: `npx tsc -p tsconfig.relay.json` — expected: no output.

- [ ] **Step 7: Mutate, then report**

Delete the `default` branch's `dead` and confirm the unrecognised-status test fails. Make
`declined_patron` always recompute `graceUntil` and confirm the "keeps the original deadline" test
fails. Restore. **Report any survivor.** Do not commit.

---

### Task 4: The app's entitlement client

**Files:**
- Create: `src-tauri/src/sync_engine/entitlement.rs`
- Modify: `src-tauri/src/sync_engine/mod.rs`

**Interfaces:**
- Consumes: `client::get_state` / `client::set_state` (already `pub` in `client.rs`).
- Produces:
  - `pub const RELAY_BASE: &str`
  - `pub const ACCESS_TOKEN: &str = "access_token"`, `pub const REFRESH_SECRET: &str = "refresh_secret"`,
    `pub const ACCESS_EXPIRES: &str = "access_expires"`
  - `pub fn base(conn: &Connection) -> String`
  - `pub fn refresh_secret(conn: &Connection) -> Option<String>`
  - `pub fn store_grant(conn: &Connection, access: &str, refresh: &str, expires: i64) -> Result<(), String>`
  - `pub fn clear(conn: &Connection) -> Result<(), String>`
  - `pub async fn access_token(conn: &Connection) -> Result<Option<String>, String>` — returns the
    stored token, refreshing it first when fewer than `REFRESH_MARGIN_SECS` remain
  - `pub async fn claim(conn: &Connection, code: &str) -> Result<(), String>`
  - `pub fn authorize_url(state: &str) -> String`

**⚠️ `mod.rs` is the one step that cannot be skipped.** An undeclared module compiles to nothing and
every test inside it is silently never run — this repository lost four waves of work to exactly
that. Add `pub mod entitlement;` beside the existing `pub mod client;` **in Step 1**, before
writing any code.

- [ ] **Step 1: Declare the module first**

Add to `src-tauri/src/sync_engine/mod.rs`, in the existing alphabetical run of `pub mod` lines:

```rust
pub mod entitlement;
```

Then create `src-tauri/src/sync_engine/entitlement.rs` containing only `//! …` module docs and
`#[cfg(test)] mod tests {}`, and run `cargo test --manifest-path src-tauri/Cargo.toml entitlement::`.
Expected: compiles, **0 tests selected**. A filter that matches nothing exits 0, so read the
selected count rather than the exit code.

- [ ] **Step 2: Write the failing tests**

Append to `entitlement.rs`. These are the pure-decision tests; the HTTP paths are covered by
Task 7 against the existing localhost server.

```rust
#[cfg(all(test, not(target_family = "wasm")))]
mod tests {
    use super::*;
    use crate::sync_engine::client;

    /// A connection with just the one table these functions touch. `sync_state` is a plain
    /// key/value table, so the fixture does not need the schema ladder.
    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch(
            "CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .expect("sync_state");
        conn
    }

    #[test]
    fn base_is_the_compiled_in_relay_when_nothing_overrides_it() {
        let conn = db();

        assert_eq!(base(&conn), RELAY_BASE);
    }

    #[test]
    fn an_override_wins_and_is_trimmed() {
        // The override has no UI and exists for `client/tests.rs`, which stands a server on
        // localhost. Trailing slashes are trimmed because every caller appends `/g/...`.
        let conn = db();
        client::set_state(&conn, client::RELAY_URL, "http://127.0.0.1:8787/").expect("set");

        assert_eq!(base(&conn), "http://127.0.0.1:8787");
    }

    #[test]
    fn a_blank_override_is_not_an_override() {
        // Every existing installation holds "" here. Reading that as a base would build the
        // relative URL "/g/..." and fail with a confusing message.
        let conn = db();
        client::set_state(&conn, client::RELAY_URL, "   ").expect("set");

        assert_eq!(base(&conn), RELAY_BASE);
    }

    #[test]
    fn no_refresh_secret_means_not_connected() {
        let conn = db();

        assert_eq!(refresh_secret(&conn), None);
    }

    #[test]
    fn store_grant_then_clear_round_trips() {
        let conn = db();
        store_grant(&conn, "access-1", "refresh-1", 1_756_000_000).expect("store");

        assert_eq!(refresh_secret(&conn).as_deref(), Some("refresh-1"));
        assert_eq!(
            client::get_state(&conn, ACCESS_TOKEN).as_deref(),
            Some("access-1")
        );

        clear(&conn).expect("clear");

        assert_eq!(refresh_secret(&conn), None);
        // **The access token must go too.** Clearing only the refresh secret would leave a
        // device syncing for up to a day after the reader disconnected it.
        assert_eq!(client::get_state(&conn, ACCESS_TOKEN), None);
    }

    #[test]
    fn the_authorize_url_carries_both_scopes_and_the_state() {
        let url = authorize_url("state-abc");

        assert!(url.starts_with("https://www.patreon.com/oauth2/authorize?"));
        assert!(url.contains("response_type=code"));
        // `identity` alone returns nothing about memberships, so the app would connect and then
        // be told the reader is not a patron.
        assert!(url.contains("identity%20identity.memberships"));
        assert!(url.contains("state=state-abc"));
    }
}
```

- [ ] **Step 3: Run and watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml entitlement::`
Expected: FAIL to compile — the functions do not exist.

- [ ] **Step 4: Implement**

- `RELAY_BASE` — set it to `"https://mtg-grimoire-relay.markus-seerup.workers.dev"` as a
  placeholder and **flag it in your report as needing Markus's real deployed hostname**. It is
  public and belongs in the repository; the four secrets do not.
- `REFRESH_MARGIN_SECS: i64 = 6 * 60 * 60`.
- `base` reads `client::RELAY_URL`, trims whitespace and trailing `/`, and falls back to
  `RELAY_BASE` when the result is empty.
- `store_grant` writes all three keys; `clear` deletes all three.
- `access_token` returns `Ok(None)` when there is no refresh secret. Otherwise, if
  `ACCESS_EXPIRES` is missing or within the margin, it calls `POST {base}/token` with
  `{"refresh": …}` and stores the answer. **A 401 from `/token` calls `clear` and returns
  `Ok(None)`** — the membership has ended, which is a state and not an error.
- `claim` calls `POST {base}/claim` with `{"code": …}` and stores the answer.
- Both use `client::http()` — make it `pub(crate)` if it is not already — and must **not** record
  a 401 through `errors::note`. Spec §10: a 401 is a sentence, not an `error_log` row.

- [ ] **Step 5: Run and watch it pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml entitlement::`
Expected: PASS, **6 tests selected**. Confirm the count.

- [ ] **Step 6: Mutate, then report**

Make `clear` leave `ACCESS_TOKEN` in place and confirm `store_grant_then_clear_round_trips` fails.
Drop `identity.memberships` from the scope string and confirm the URL test fails. Restore.
**Report any survivor, and report the placeholder hostname.** Do not commit.

---

### Task 5: The documents that currently deny this

**Files:**
- Modify: `CLAUDE.md`, `docs/reference/sync.md`,
  `docs/superpowers/specs/2026-08-27-cross-platform-design.md`

**Interfaces:** consumes the spec; produces nothing other tasks read.

`relay/README.md` is **not** in this task — Task 8 owns it, because it is rewritten around code
that task writes.

**A prose-only edit routes to neither CI job, so nothing here goes red on its own.** Re-read each
passage against the spec rather than pattern-matching on the word "relay".

- [ ] **Step 1: Root `CLAUDE.md`**

Rewrite the sync paragraph. It currently says the relay is "a Cloudflare Worker the reader deploys
themselves" and that "its address is nowhere in this repository and must never be". Both are now
wrong. It must say instead: the relay is one deployment Markus runs; **the address is in the
repository and is public, and the four secrets in spec §9 are what must never be**; sync is gated
on Patreon membership; an installation that has not connected has sync off, which is the state
every existing installation is in; and a reader who wants their own relay forks and changes one
constant.

- [ ] **Step 2: `docs/reference/sync.md` — the three corrections**

1. Retitle **"The relay: three endpoints, and no authentication"** and rewrite it around the auth
   gate. Keep the sentence that the relay cannot decrypt what it stores — that is still true and
   is the reason none of this needs an account.
2. **The 1 440 req/day figure is wrong twice.** It counted pulls alone when a round trip is 2–3
   requests (`pull` and `ack` always fire; `push` short-circuits at `client.rs:291`), *and* it
   models a poll that does not exist. Replace with spec §8's table and say plainly that **sync is
   manual today**: `run_once` has two callers, and `ipc.syncNow()` is called only from the
   **Sync now** button at `SyncPanel.tsx:483`.
3. **"Nothing is deployed" is false.** `2026-08-29-sync-baseline-design.md` §1 records a live pass
   against a deployed relay on 2026-08-29.

- [ ] **Step 3: §7.7 of the cross-platform spec**

Do **not** rewrite it — it is a historical design document. Add a dated note under the heading
pointing at the new spec, in the style §7.2 already uses for its own corrections:

```markdown
> ⚠️ **Superseded 2026-08-29 by
> [the hosted relay design](2026-08-29-hosted-relay-and-patreon-design.md).** Readers no longer
> deploy their own relay; one deployment serves everyone, gated on Patreon membership, and the
> free-tier table below is superseded by that spec's §8 — which corrects the request figure for
> counting pulls alone against a poll that was never built.
```

- [ ] **Step 4: Check every cross-reference you touched still resolves**

Run: `grep -rn "relay_url\|deploys themselves\|Nobody has deployed\|nowhere in this repository" CLAUDE.md docs/reference/sync.md`
Expected: no stale claim survives. `relay_url` may still appear where it names the **test/dev
override**, which is accurate.

- [ ] **Step 5: Report**

List each passage changed and the claim it used to make. Do not commit.

---

## Wave 2 — depends on Wave 1's interfaces

Tasks 6–10 may run concurrently with each other once Wave 1 has landed. Each still owns files no
sibling touches.

---

### Task 6: Patreon, the claim flow, and the routes

**Files:**
- Create: `relay/src/patreon.ts`, `relay/src/claim.ts`
- Modify: `relay/src/index.ts`, `relay/src/group.ts`, `relay/wrangler.jsonc`

**Interfaces:**
- Consumes: `md5.ts`'s `hmacMd5`, `hex`, `timingSafeEqualHex`; `token.ts`'s `mint`, `verify`,
  `TOKEN_TTL_MS`; `entitlement.ts`'s `decide`, `GRACE_MS`, `Status`.
- Produces: the deployed HTTP surface. Nothing in the app imports from here.

- [ ] **Step 1: `relay/src/patreon.ts`**

- `verifyWebhook(body: string, signature: string | null, secret: string): boolean` — `hmacMd5` over
  the **raw body string** (read it once as text; re-serialising JSON changes the bytes and every
  signature then fails), hex it, `timingSafeEqualHex` against the header. `null` signature → `false`.
- `exchangeCode(code, env): Promise<{ accessToken, refreshToken }>` — `POST` to
  `https://www.patreon.com/api/oauth2/token`, form-encoded, with `client_id`, `client_secret`,
  `grant_type=authorization_code`, `code`, `redirect_uri`.
- `fetchIdentity(accessToken): Promise<{ userId: string; patronStatus: string | null }>` —
  `GET https://www.patreon.com/api/oauth2/v2/identity?include=memberships&fields%5Bmember%5D=patron_status`,
  reading `data.id` and the `patron_status` of the membership whose campaign is
  `env.PATREON_CAMPAIGN_ID`. **A reader with memberships to other creators must not read as a
  patron of this one** — that is what the campaign filter is for.

- [ ] **Step 2: `relay/src/claim.ts`**

- `GET /oauth/patreon/callback?code=…` — exchange, fetch identity, `decide(...)`, upsert the
  entitlement row, mint a claim code, and return an HTML page showing it. A `dead` decision
  returns a page saying so and mints no code.
- The claim code is **Crockford base32** — alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, which omits
  `I`, `L`, `O` and `U` — in three groups of four. It is the alphabet `sync_pair::invite` already
  uses, chosen for the confusions a person makes copying between two screens, which is exactly
  what this code is for. Store it in `claim_codes` with `expires_at = now + 10 minutes`.
- `POST /claim {code}` — look up and **delete** the code (one-time), load the entitlement, refuse
  a `dead` one with 403, bind `group_id` if it is `NULL`, refuse with 409 if it is bound to a
  different group, mint a `refresh_secret` if absent, and answer `{access, refresh, expires}`.
- `POST /token {refresh}` — look up by `refresh_secret`, refuse a `dead` one **and a `grace` one
  whose window has closed** with 401, and answer a fresh `{access, refresh, expires}`.
- `POST /webhook/patreon` — verify the signature and **refuse an unverified body with 401 before
  reading it**. An unverified `pledge:delete` deletes a reader's log; this is the one failure in
  the design that destroys data. Then `decide(...)`, update the row, and on `dead`: clear
  `refresh_secret` and call the group's Durable Object `drop`.

- [ ] **Step 3: `relay/src/group.ts` — the drop action**

Add `"drop"` to the action switch, and a private method:

```ts
  /**
   * Empty this group's log. Called only by the entitlement layer when a membership ends
   * (spec §7.1) — **never by a device**, which is why it is not on the router's public
   * `ROUTE` regex but on an internal path the Worker builds itself.
   *
   * `acks` is emptied too. Leaving it would mean a reader who resubscribes has a compaction
   * floor derived from cursors into a log that no longer exists.
   */
  private drop(): Response {
    this.sql.exec(`DELETE FROM log`);
    this.sql.exec(`DELETE FROM acks`);
    return new Response(null, { status: 204 });
  }
```

- [ ] **Step 4: `relay/src/index.ts` — the auth gate**

Keep `ROUTE` as it is and add the new paths ahead of it. The gate, for `/g/…` only:

```ts
    // **The gate stands here and not inside the Durable Object, and the reason is the bill.**
    // A request that reaches a DO costs a Durable Object request whether it is honoured or
    // refused, and that is the line that actually meters (spec §8). Verifying an HMAC here
    // costs microseconds and touches no storage, so junk is refused for the price of a Worker
    // invocation alone.
    const auth = request.headers.get("authorization");
    const bearer = auth?.startsWith("Bearer ") === true ? auth.slice(7) : null;
    const claims = bearer ? await verify(bearer, env.RELAY_HMAC_KEY, Date.now()) : null;
    if (!claims || claims.grp !== group) {
      return new Response("unauthorized", { status: 401 });
    }
```

**`claims.grp !== group` is not redundant with the signature check.** A validly signed token for
*your own* group is exactly what an attacker has; without this line it would open every group.

- [ ] **Step 5: `relay/wrangler.jsonc`**

Add the D1 binding and the cron trigger, each with a comment saying why, matching the file's
existing voice:

```jsonc
  "d1_databases": [
    { "binding": "DB", "database_name": "mtg-grimoire-relay", "database_id": "<set on create>" }
  ],
  // The webhook is primary and this is the backstop: a webhook Patreon failed to deliver would
  // otherwise leave a cancelled membership syncing for ever, and an expired grace window
  // (spec 7.2) has no webhook of its own to close it.
  "triggers": { "crons": ["0 3 * * *"] },
```

- [ ] **Step 6: The cron handler in `index.ts`**

Add `scheduled(event, env, ctx)` beside `fetch`: page through `entitlements` where
`status != 'dead'`, refresh each Patreon token, re-read `patron_status`, `decide(...)`, and apply
§7.1 to any that turn `dead`.

- [ ] **Step 7: Type-check**

Run: `npx tsc -p tsconfig.relay.json`
Expected: no output.

- [ ] **Step 8: Report**

No new vitest file is required here — this task is I/O and routing, which is the half the
`log.ts` split deliberately leaves to a deploy. **Say so in your report**, and list the routes you
added. Note that `database_id` is a placeholder needing `wrangler d1 create`. Do not commit.

---

### Task 7: The Authorization header on every relay request

**Files:**
- Modify: `src-tauri/src/sync_engine/client.rs`
- Modify: `src-tauri/src/sync_engine/client/tests.rs`

**Interfaces:**
- Consumes: `entitlement::{access_token, base, clear}` from Task 4.
- Produces: no new public surface. `client::relay_url` **keeps its signature** so `commands.rs`
  compiles unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `client/tests.rs`, following the existing fixture that stands a server on localhost:

```rust
#[tokio::test]
async fn every_relay_request_carries_the_bearer_token() {
    // Push, pull and ack are three separate call sites in this file, and a header added to one
    // of them is a bug that only shows up as a 401 on whichever endpoint was missed.
    let (a, server) = paired_device_against_server().await;
    entitlement::store_grant(&a, "access-1", "refresh-1", far_future()).expect("grant");

    client::run_once(&a).await.expect("round trip");

    for request in server.requests() {
        assert_eq!(
            request.header("authorization").as_deref(),
            Some("Bearer access-1"),
            "{} carried no bearer token",
            request.path()
        );
    }
}

#[tokio::test]
async fn a_401_clears_the_grant_and_is_not_an_error_log_row() {
    // Spec 10: the membership ended. Telling the reader their sync is broken points at the
    // wrong fix, and an `error_log` row is how this window says "broken".
    let (a, server) = paired_device_against_server().await;
    entitlement::store_grant(&a, "stale", "refresh-1", far_future()).expect("grant");
    server.answer_all(401);

    let _ = client::run_once(&a).await;

    assert_eq!(entitlement::refresh_secret(&a), None);
    let logged: i64 = a
        .query_row("SELECT count(*) FROM error_log WHERE source = 'relay'", [], |r| r.get(0))
        .expect("count");
    assert_eq!(logged, 0);
}

#[tokio::test]
async fn no_grant_means_no_request_at_all() {
    // The successor to `no_relay_url_means_no_request`. The base is now always present, so
    // "sync is off" has moved from "no URL" to "no entitlement" — and it must still be silent
    // rather than an error, because it is the state every existing installation is in.
    let (a, server) = paired_device_against_server().await;

    assert_eq!(client::run_once(&a).await.expect("no-op"), None);
    assert_eq!(server.requests().len(), 0);
}
```

Adapt the fixture helpers to whatever `client/tests.rs` already provides — read it first and reuse
its server rather than standing a second one.

- [ ] **Step 2: Update `no_relay_url_means_no_request`**

That test (line 263) asserts `relay_url(&a) == None` for a fresh device. **`base` never answers
`None` now.** Rewrite it to assert what is still true — a blank override falls back to
`RELAY_BASE` — and let `no_grant_means_no_request_at_all` carry the "sync is off" meaning. **Do
not delete it**; a deleted test is a silent loss of coverage.

- [ ] **Step 3: Run and watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_engine::client::tests`
Expected: FAIL to compile, or the three new tests fail.

- [ ] **Step 4: Implement**

- `relay_url` keeps its `Option<String>` signature but delegates: `Some(entitlement::base(conn))`.
- `round_trip` gains an early `let Some(token) = entitlement::access_token(conn).await? else { return Ok(None) };`
  **above** the existing `me(conn)?.is_none()` check.
- Thread `&token` into `post_ops`, `pull` and `ack`, adding
  `.header("authorization", format!("Bearer {token}"))` to each.
- In each of those three, a `401` calls `entitlement::clear(conn)` and returns the error
  **without** calling `note`. Every other status keeps the existing `note` path unchanged.

- [ ] **Step 5: Run and watch it pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_engine::client::tests`
Expected: PASS. **Report the selected test count** — a filter matching nothing exits 0.

- [ ] **Step 6: Mutate, then report**

Remove the header from `ack` alone and confirm the first test fails naming `/ack`. Make the 401
path call `note` and confirm the second fails. Restore. **Report any survivor.** Do not commit.

---

### Task 8: Commands, registration, and the relay README

**Files:**
- Modify: `src-tauri/src/sync_engine/commands.rs`, `src-tauri/src/desktop.rs`, `relay/README.md`

**Interfaces:**
- Consumes: `entitlement::{authorize_url, claim, refresh_secret, clear}`.
- Produces, for Task 10:
  - `sync_patreon_begin() -> String` (the authorize URL)
  - `sync_patreon_claim(code: String) -> SupporterStatus`
  - `sync_supporter_status() -> SupporterStatus`
  - `pub struct SupporterStatus { connected: bool, status: String, since: Option<i64>, group_bound: bool }`,
    `#[serde(rename_all = "camelCase")]`

- [ ] **Step 1: Write the failing test**

Append to the existing `mod tests` in `commands.rs`. Replace `a_relay_url_must_name_a_scheme`
(line 323) — `valid_relay_url` is deleted, so that test cannot survive — with:

```rust
    #[test]
    fn a_supporter_status_names_the_state_and_never_the_secret() {
        // The panel draws this. A refresh secret reaching the webview is a secret in a
        // screenshot, which is the reason `Device` skips its public key too.
        let status = SupporterStatus {
            connected: true,
            status: "grace".to_owned(),
            since: Some(1_756_000_000),
            group_bound: true,
        };
        let json = serde_json::to_string(&status).expect("serialise");

        assert!(json.contains("\"groupBound\":true"));
        assert!(!json.contains("refresh"));
        assert!(!json.contains("access"));
    }

    #[test]
    fn a_relay_status_no_longer_carries_a_url_for_the_reader_to_set() {
        // The field is gone from Settings; the key survives only as a test/dev override.
        let json = serde_json::to_string(&RelayStatus {
            paired: false,
            pending: 0,
            last_sync_at: None,
            last_error: None,
            review_count: 0,
        })
        .expect("serialise");

        assert!(!json.contains("relayUrl"));
    }
```

- [ ] **Step 2: Run and watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_engine::commands`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

- Delete `valid_relay_url` and `sync_relay_set_url`. Drop `relay_url` from `RelayStatus` and from
  `read_status`.
- Add `SupporterStatus` and the three commands, each following the existing
  `spawn_blocking` + `sync::with_write` shape exactly — the write connection is behind a `Mutex`
  and its guard cannot cross an `await`.
- `sync_patreon_begin` mints a random `state`, stores it in `sync_state`, and returns
  `entitlement::authorize_url(&state)`.

- [ ] **Step 4: `desktop.rs`**

Replace `sync_engine::commands::sync_relay_set_url` (line 514) with the three new command paths.
**A command left in the handler list but deleted from the module fails the build**, and one added
to the module but not the list fails at runtime with "command not found" — check both directions.

- [ ] **Step 5: Rewrite `relay/README.md`**

It currently states "Nobody has deployed this", "There is no authentication on the endpoints and
that is deliberate", and free-tier arithmetic superseded by spec §8. Rewrite around: the auth gate
and why it stands in the Worker; the entitlement table and its two indices; the Patreon flow; the
four secrets and that they are set with `wrangler secret put`; and spec §8's table. **Keep** the
`AUTOINCREMENT` paragraph and the `log.ts` split rationale — both are still true and both are
load-bearing.

- [ ] **Step 6: Run and watch it pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_engine::commands`
Expected: PASS. **Report the selected count.**

- [ ] **Step 7: Mutate, then report**

Add `refresh_secret` to `SupporterStatus` and confirm the first test fails. Restore. **Report any
survivor.** Do not commit.

---

### Task 9: Carry the refresh secret through pairing

**Files:**
- Modify: `src-tauri/src/sync_pair/pairing.rs`

**Interfaces:**
- Consumes: `entitlement::{refresh_secret, store_grant}`.
- Produces: nothing other tasks read.

**⚠️ The field order is the whole trap, and the existing comment names it.** `confirm` seals
`<group_id>\0<epoch>\0<32-byte key>` and the comment at `pairing.rs:258` says the key is last
"because it is 32 raw bytes and may contain a zero of its own". `complete` reads it with
`splitn(3, …)`, which works only because the key is the final part. **Appending `refresh` after
the key would break on any group key containing `0x00` — roughly one pairing in eight — and it
would pass every test whose fixture key happens not to.** `refresh` goes **before** the key, and
`splitn` becomes 4.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn the_sealed_key_carries_the_refresh_secret_to_the_joiner() {
        let (a, b) = two_devices();
        entitlement::store_grant(&a, "access-a", "refresh-a", far_future()).expect("grant");
        let (_, sealed) = pair_them(&a, &b);

        pairing::complete(&b, &mut pending_of(&b), &sealed).expect("complete");

        assert_eq!(entitlement::refresh_secret(&b).as_deref(), Some("refresh-a"));
    }

    #[test]
    fn a_group_key_containing_a_zero_byte_still_opens() {
        // The field-order trap, made unmissable. `complete` splits on zero bytes, so a key with
        // one in it is only safe while the key is the LAST field. A fixture key of random bytes
        // has a zero about one time in eight, which is a test that passes on most runs.
        let (a, b) = two_devices_with_group_key([0u8; 32]);
        entitlement::store_grant(&a, "access-a", "refresh-a", far_future()).expect("grant");
        let (_, sealed) = pair_them(&a, &b);

        pairing::complete(&b, &mut pending_of(&b), &sealed).expect("complete");

        assert_eq!(
            identity::group(&b).expect("group").expect("joined").group_key,
            [0u8; 32]
        );
        assert_eq!(entitlement::refresh_secret(&b).as_deref(), Some("refresh-a"));
    }

    #[test]
    fn a_host_with_no_grant_still_pairs() {
        // Pairing must not require a membership: a reader can pair two devices and connect
        // Patreon afterwards, in either order.
        let (a, b) = two_devices();
        let (_, sealed) = pair_them(&a, &b);

        pairing::complete(&b, &mut pending_of(&b), &sealed).expect("complete");

        assert_eq!(entitlement::refresh_secret(&b), None);
    }
```

Adapt the helper names to what `pairing.rs`'s test module already provides.

- [ ] **Step 2: Run and watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_pair::pairing`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `confirm`, build the plaintext as `<group_id>\0<epoch>\0<refresh>\0<32-byte key>`, with
`refresh` the empty string when there is no grant. Update the comment above it to say the key is
still last and why, and that `refresh` is safe as a middle field because it is base64url and
carries no zero byte.

In `complete`, `splitn(4, |b| *b == 0)`; read the refresh as part three; call
`entitlement::store_grant` only when it is non-empty. **An empty refresh must not clear an
entitlement this device already has** — a device that connected Patreon itself and then pairs with
one that has not must keep its own grant.

- [ ] **Step 4: Run and watch it pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sync_pair::pairing`
Expected: PASS. **Report the selected count** — this module has sixteen existing pairing tests and
none may regress.

- [ ] **Step 5: Mutate, then report**

Move `refresh` after the key and keep `splitn(4)`; confirm `a_group_key_containing_a_zero_byte_still_opens`
fails. Restore. **Report any survivor.** Do not commit.

---

### Task 10: The Settings panel

**Files:**
- Modify: `src/lib/ipc.ts`, `src/features/settings/SyncPanel.tsx`,
  `src/features/settings/SyncPanel.test.tsx`, `src/features/settings/SyncPanel.stories.tsx`

**Interfaces:**
- Consumes Task 8's three commands and `SupporterStatus`; `RelayStatus` **no longer has
  `relayUrl`**.
- Produces: nothing.

- [ ] **Step 1: `src/lib/ipc.ts`**

Remove `syncRelaySetUrl` (line 5574) and `relayUrl` from the `RelayStatus` interface (line 3955).
Add, in the existing sync run and matching its doc-comment style:

```ts
  syncPatreonBegin: () => invoke<string>("sync_patreon_begin"),
  syncPatreonClaim: (code: string) => invoke<SupporterStatus>("sync_patreon_claim", { code }),
  syncSupporterStatus: () => invoke<SupporterStatus>("sync_supporter_status"),
```

and the `SupporterStatus` interface mirroring Task 8's struct exactly — `connected`, `status`,
`since`, `groupBound`.

- [ ] **Step 2: Write the failing tests**

In `SyncPanel.test.tsx`, delete the two `syncRelaySetUrl` tests (lines ~409–440) and add:

```ts
  it("offers Connect Patreon when nothing is connected", async () => {
    syncSupporterStatus.mockResolvedValue({
      connected: false, status: "dead", since: null, groupBound: false,
    });
    render(<SyncPanel />);

    expect(await screen.findByRole("button", { name: /connect patreon/i })).toBeInTheDocument();
  });

  it("says the membership ended without saying sync is broken", async () => {
    // Spec 10: a lapse is a state, not a failure. "Could not reach the relay" points a reader
    // at their network when the fix is their pledge.
    syncSupporterStatus.mockResolvedValue({
      connected: false, status: "dead", since: 1_756_000_000, groupBound: true,
    });
    render(<SyncPanel />);

    expect(await screen.findByText(/membership ended/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not|failed|error/i)).not.toBeInTheDocument();
  });

  it("tells a lapsed reader their own data is untouched", async () => {
    // The one sentence that stops a lapse reading as data loss.
    syncSupporterStatus.mockResolvedValue({
      connected: false, status: "dead", since: 1_756_000_000, groupBound: true,
    });
    render(<SyncPanel />);

    expect(await screen.findByText(/stays on this device|nothing has been deleted/i))
      .toBeInTheDocument();
  });

  it("sends a pasted claim code and shows the connected state", async () => {
    syncSupporterStatus.mockResolvedValue({
      connected: false, status: "dead", since: null, groupBound: false,
    });
    syncPatreonClaim.mockResolvedValue({
      connected: true, status: "active", since: 1_756_000_000, groupBound: true,
    });
    render(<SyncPanel />);
    const field = await screen.findByLabelText(/claim code/i);

    await userEvent.type(field, "ABCD-EFGH-JKMN");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => expect(syncPatreonClaim).toHaveBeenCalledWith("ABCD-EFGH-JKMN"));
  });

  it("says a card was declined without saying the membership ended", async () => {
    syncSupporterStatus.mockResolvedValue({
      connected: true, status: "grace", since: 1_756_000_000, groupBound: true,
    });
    render(<SyncPanel />);

    expect(await screen.findByText(/payment/i)).toBeInTheDocument();
    expect(screen.queryByText(/membership ended/i)).not.toBeInTheDocument();
  });
```

Register `syncPatreonBegin`, `syncPatreonClaim` and `syncSupporterStatus` in the `vi.hoisted`
block at the top (lines 17–34) and reset them in `beforeEach` (line 154), following the existing
pattern. **Remove `syncRelaySetUrl` from both** — a mock left asserting a deleted command stays
green for ever.

- [ ] **Step 3: Run and watch it fail**

Run: `npm run test:run -- src/features/settings/SyncPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement**

Rename `RelaySection` to `SupporterSection` and replace the URL field with:

- a status line driven by `status` — *Supporting since …* / *Payment problem — Patreon is retrying,
  and sync keeps working for now* / *Membership ended* / *Not connected*;
- a **Connect Patreon** button calling `ipc.syncPatreonBegin()` and opening the result with the
  `opener` plugin;
- a **Claim code** field with `<label htmlFor="patreon-claim">` and a **Connect** button calling
  `ipc.syncPatreonClaim`;
- for a `dead` status, the sentence that local data is untouched.

Rewrite the module doc comment. It currently says "There is no relay in this repository and there
must never be one — it is a small server the reader runs themselves", which is now exactly wrong.
Keep the paragraph about the relay holding only ciphertext: still true, and still the reason none
of this needs an account.

Follow `SettingsSection`'s written-`id` rule — a `useId()` `:r7:` moves with render order and these
are read in the shipped window.

- [ ] **Step 5: Update the stories**

`SyncPanel.stories.tsx` seeds `RELAY_ON` / `RELAY_OFF` fixtures carrying `relayUrl`. Update them and
add a supporter fixture per state: `active`, `grace`, `dead`, and not connected.

- [ ] **Step 6: Run and watch it pass**

Run: `npm run test:run -- src/features/settings/SyncPanel.test.tsx`
Expected: PASS.

- [ ] **Step 7: Preview the stories**

Call the `mcp__mtg-grimoire-sb-mcp__preview-stories` tool for the SyncPanel stories and **include
every returned URL in your report.** Do not start Storybook yourself — only one can run across all
worktrees and the collision is silent.

- [ ] **Step 8: Mutate, then report**

Make the `dead` branch render the generic error sentence and confirm the "without saying sync is
broken" test fails. Restore. **Report any survivor.** Do not commit.

---

## Fan-in — the controller only

- [ ] **Step 1: Read every subagent report**, especially any assertion that survived mutation.
- [ ] **Step 2: Sweep for unowned files**

```bash
grep -rn "relayUrl\|syncRelaySetUrl\|sync_relay_set_url\|valid_relay_url" src src-tauri/src relay/src
```

Expected: no hits outside a comment about the test/dev override. A **diff-scoped review cannot find
a file that is not in the diff** — this grep is what catches a caller nobody was given.

- [ ] **Step 3: `npm run verify`, once, alone**

```bash
npm run verify > verify.log 2>&1; grep -E "Tests|failed|error" verify.log | tail -40
```

**Redirect and grep — never pipe to `tail`.** A pipe reports `tail`'s exit code 0 while tests fail.
Never run two verifies at once.

- [ ] **Step 4: `cargo fmt` and `clippy`, which verify does not run**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

These are the only reds available with a fully green verify. Clippy caps a function at 7 arguments —
`post_ops` gains one in Task 7 and is close.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sync): host the relay and gate it on Patreon"
```

- [ ] **Step 6: What no test reaches**

Deploy is Markus's, and these need the real thing: `wrangler d1 create` and applying `schema.sql`;
`wrangler secret put` for the four secrets; the Patreon app's redirect URI; and one live pass —
consent screen, landing page, pasted code, a sync, then a real `pledge:delete` webhook. Write it up
in `docs/superpowers/research/` with the date and the build. **`RELAY_BASE` carries a placeholder
hostname until that deploy.**

---

## Self-Review

**Spec coverage.** §4 → Tasks 4, 7. §5 → Task 3 (schema), Task 6 (use). §6.1 → Tasks 4, 6, 10.
§6.2 → Tasks 2, 6, 7. §6.3 → Task 6 (`/claim` binding). §7.1 → Task 6 (drop). §7.2 → Task 3.
§7.3 → Tasks 1, 6. §8 → Tasks 5, 8 (documented). §9 → Tasks 6, 8. §10 → Tasks 4, 7, 8, 9, 10.
§11 → each task's own tests. §12 → Tasks 5, 8, 10 (module docs). §13 → nothing built, as intended.

**One deliberate deviation from the spec.** §7.3 and §11 say HMAC-MD5 is tested with the digest
injected so the root vitest can supply Node's `createHash("md5")`. **That will not compile**:
`tsconfig.relay.json` pins `"types": ["@cloudflare/workers-types"]` with no Node types, `npm run build`
type-checks it, and `@types/node` is banned repo-wide. Task 1 implements MD5 itself instead — which
also removes the dependency on `subtle.digest("MD5")` being a non-standard extension. Fewer
unknowns, one more file. Fold this correction back into the spec at fan-in.

**Placeholder scan.** Two intentional placeholders, both flagged for Markus in reports rather than
left silent: `RELAY_BASE`'s hostname (Task 4 Step 4) and `database_id` (Task 6 Step 5). Both are
values only a deploy can produce.

**Type consistency.** `SupporterStatus` is `{connected, status, since, groupBound}` in Task 8's
Rust and Task 10's TypeScript. `Claims` is `{sub, grp, exp}` in Tasks 2, 6, 7. `Status` is
`"active" | "grace" | "dead"` in Tasks 3, 6, 8, 10. `RelayStatus` loses `relayUrl` in Task 8 and
Task 10 consumes it without. `relay_url` keeps its `Option<String>` signature in Task 7 so Task 8
compiles against it unchanged.
