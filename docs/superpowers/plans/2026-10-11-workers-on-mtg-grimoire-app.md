# The relay and the share Worker on mtg-grimoire.app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New builds, links, policy lines, probes and documents name `relay.mtg-grimoire.app` and `share.mtg-grimoire.app`, while both `workers.dev` addresses keep answering for every installed build.

**Architecture:** Each Worker gains a Custom Domain route beside an explicit `workers_dev: true`. The two compiled-in constants and their vars move together. The relay's OAuth redirect URI becomes a function of the address the callback arrived at, limited to its two known addresses. The deploy probes ask both addresses.

**Tech Stack:** wrangler config (JSONC), Cloudflare Workers (TypeScript, Vitest), Rust constants, Node probe scripts.

**Spec:** `docs/superpowers/specs/2026-10-11-workers-on-mtg-grimoire-app-design.md`

## Global Constraints

- New addresses, exact, no trailing slash: `https://relay.mtg-grimoire.app`, `https://share.mtg-grimoire.app`.
- Legacy addresses, exact: `https://mtg-grimoire-relay.denmark-east.workers.dev`, `https://mtg-grimoire-share.denmark-east.workers.dev`.
- `workers_dev: true` is stated in both configs; `preview_urls` is not stated in either.
- No deploy, no Custom Domain attach, no secret and no Patreon change is made by this plan. Those are the spec's rollout steps and are asked for one by one.
- One `feat:` commit for code, tests, documents, the spec and this plan. `pnpm verify` once, at the end; targeted suites before it.
- Dated files under `docs/superpowers/` other than this spec and plan are not edited.

## Review Focus

1. A callback arriving at the legacy address must exchange with the legacy URI — Task 1's `redirectUri` tests.
2. A callback whose host is neither address must not send that host to Patreon — Task 1.
3. A config edit that drops `workers_dev: true` must fail in the pull request — Task 5's config tests.
4. A legacy address that has stopped answering must fail the release's probe — Task 5's `legacyProbe` tests.
5. `RELAY_BASE_LEGACY` missing from a deploy must be a 500 that names it, not a silent fallback — Task 1's `handleCallback` test.

---

### Task 1: The relay — config and the redirect URI per host

**Files:**
- Modify: `infrastructure/relay/wrangler.jsonc`, `infrastructure/relay/src/index.ts` (`Env`), `infrastructure/relay/src/patreon.ts`, `infrastructure/relay/src/claim.ts`
- Test: `infrastructure/relay/src/patreon.test.ts`, `infrastructure/relay/src/claim.test.ts`

**Interfaces:**
- Produces: `redirectUri(env: Env, request: Request): string`; `exchangeCode(code: string, env: Env, request: Request)`; `Env.RELAY_BASE_LEGACY: string`.

- [ ] **Step 1: config.** Add before `"vars"`, with a comment saying `workers_dev: true` is what keeps every installed build working because `routes` alone would infer `false`:

```jsonc
"routes": [{ "pattern": "relay.mtg-grimoire.app", "custom_domain": true }],
"workers_dev": true,
```

In `vars`: `"RELAY_BASE": "https://relay.mtg-grimoire.app"`, and new `"RELAY_BASE_LEGACY": "https://mtg-grimoire-relay.denmark-east.workers.dev"`. Correct the two comments that say a zone rule is impossible: still true of the legacy address, which is why the limits stay in the Worker.

- [ ] **Step 2: tests in `patreon.test.ts`.**

```ts
describe("redirectUri", () => {
  const env = {
    RELAY_BASE: "https://relay.example",
    RELAY_BASE_LEGACY: "https://old-relay.example",
  } as never;
  const at = (url: string) => new Request(url);

  it("repeats the current address for a callback that arrived there", () => {
    expect(redirectUri(env, at("https://relay.example/oauth/patreon/callback?code=x"))).toBe(
      "https://relay.example/oauth/patreon/callback",
    );
  });

  it("repeats the legacy address for a callback that arrived there", () => {
    expect(redirectUri(env, at("https://old-relay.example/oauth/patreon/callback?code=x"))).toBe(
      "https://old-relay.example/oauth/patreon/callback",
    );
  });

  it.each([
    ["https://evil.example/oauth/patreon/callback"],
    ["http://old-relay.example/oauth/patreon/callback"],
    ["https://old-relay.example:8443/oauth/patreon/callback"],
  ])("never sends a host it does not own: %s", (url) => {
    expect(redirectUri(env, at(url))).toBe("https://relay.example/oauth/patreon/callback");
  });
});
```

- [ ] **Step 3: test in `claim.test.ts`** — `handleCallback` with `fetch` stubbed to capture the token request and answer 500 (so no D1 is reached and the page is the 502): assert the captured body's `redirect_uri` for a callback at each address, and that an env without `RELAY_BASE_LEGACY` rejects naming it.

- [ ] **Step 4: implement.** `patreon.ts`:

```ts
export function redirectUri(env: Env, request: Request): string {
  const current = required(env.RELAY_BASE, "RELAY_BASE");
  const legacy = required(env.RELAY_BASE_LEGACY, "RELAY_BASE_LEGACY");
  const arrived = new URL(request.url).origin;
  return `${arrived === legacy ? legacy : current}${REDIRECT_PATH}`;
}

export function exchangeCode(code: string, env: Env, request: Request): Promise<PatreonTokens> {
  return postToken(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(env, request),
  });
}
```

`claim.ts`: `required(env.RELAY_BASE_LEGACY, "RELAY_BASE_LEGACY")` beside the other four; `connectPatreon(code, request, env)` passes the request to `exchangeCode`. `index.ts`: `RELAY_BASE_LEGACY: string` on `Env`, documented.

- [ ] **Step 5:** `pnpm exec vitest run infrastructure/relay` — all pass.

### Task 2: The share Worker — config

**Files:** Modify `infrastructure/share-worker/wrangler.jsonc`.

- [ ] Add `"routes": [{ "pattern": "share.mtg-grimoire.app", "custom_domain": true }]` and `"workers_dev": true` with the same comment; `"SHARE_BASE": "https://share.mtg-grimoire.app"`; rewrite the var's comment (the address is the Custom Domain; the `workers.dev` one still serves links minted before 2026-10-11).

### Task 3: The compiled-in addresses

**Files:** Modify `crates/grimoire-core/src/sync_engine/entitlement.rs` (`RELAY_BASE` and its doc), `crates/grimoire-core/src/sync_pair/invite.rs` (test literal), `apps/desktop/src-tauri/src/share/publish.rs` (`SHARE_BASE` and its doc), `packages/fake/db.ts` (`RELAY_BASE`).

- [ ] Set the two constants and the fake's copy to the new addresses. Rewrite each doc comment's first paragraph: the address is a Custom Domain on the app's zone; the `workers.dev` address is the same Worker and still answers for builds through 0.44.0. Keep the dated probe history.
- [ ] `invite.rs`: `decode_accepts_the_url_the_qr_carries` reads an invite drawn against each of the two addresses.
- [ ] **Found while implementing — the address is part of the pairing QR's payload, so the symbol changes size.** 162 bytes became 141. Measured with the crate's own encoder: an invite is drawn at 45 or 49 modules, by its bytes, and never more than 49 (a new test, `the_invite_is_drawn_at_49_modules_or_fewer`). The comment's "version 9, 53×53, for every invite" was not what that encoder does: it packs digits and capitals tighter than bytes. Followed through `packages/fake/qr.ts` (version 9 → version 8, the largest symbol the app draws: `VERSION`, `BLOCKS`, `ALIGNMENT`), `qr.test.ts`, `scripts/pairing-scan-smoke.mjs` (53 → 49), and the comments in `QrCode.tsx` and `sync.md`. `size-72` stays: a build through 0.44.0 still draws the larger symbol in the same box.

### Task 4: The web app

**Files:** Modify `infrastructure/app-worker/_headers`, `apps/light/public/privacy.html`.

- [ ] `_headers`: both relay sources in `connect-src` and the comment's table row become `relay.mtg-grimoire.app`.
- [ ] `privacy.html`: the row names `relay.mtg-grimoire.app`; add that versions through 0.44.0 reach the same service at `mtg-grimoire-relay.denmark-east.workers.dev`.
- [ ] `pnpm exec vitest run infrastructure/app-worker` — passes (it derives from the Rust constant).

### Task 5: The probes and their fences

**Files:** Modify `scripts/relay-deploy-probe.mjs`, `scripts/share-deploy-probe.mjs`, `scripts/relay-deploy-probe.test.mjs`, `scripts/share-deploy-probe.test.mjs`.

**Interfaces:** each probe script exports `LEGACY` (string) and `LEGACY_PROBES` (one probe).

- [ ] **Probes.** `RELAY`/`SHARE` take the new addresses. `LEGACY` is the `workers.dev` address. `LEGACY_PROBES` is the relay's `"a page's pre-flight is answered"` probe, and the share Worker's `"the gate refuses a request with no bearer"` (a review found the 404 page too close to a switched-off name's own 404; the gate's 401 is not). `main` asks `LEGACY` only when no origin argument was given:

```js
const result = await askUntil(async () => [
  ...(await askAll(origin, PROBES)),
  ...(origin === RELAY ? await askAll(LEGACY, LEGACY_PROBES) : []),
]);
```

- [ ] **Tests.** Replace "ask the address the Worker's name gives it" with: `LEGACY` is `https://${name}.denmark-east.workers.dev`; the config's one route is `{ pattern: new URL(RELAY).host, custom_domain: true }`; the config says `"workers_dev": true` and does not mention `preview_urls`; (relay) `"RELAY_BASE_LEGACY": "${LEGACY}"`; every `LEGACY_PROBES` entry is one of `PROBES` and passes against the tree's Worker asked at `LEGACY`. The relay test's env gains `RELAY_BASE_LEGACY: LEGACY`.
- [ ] `pnpm exec vitest run scripts/relay-deploy-probe.test.mjs scripts/share-deploy-probe.test.mjs` — pass.

### Task 6: Documents

**Files:** Modify `docs/agent/EXTERNAL_SERVICES.md`; `infrastructure/relay/README.md`, `infrastructure/share-worker/README.md`, `infrastructure/app-worker/README.md`; `docs/reference/` — `hosted-relay-deploy.md`, `collection-sharing.md`, `sync.md`, `ci-and-releases.md` (`light-app.md` is dated step records and is left); `infrastructure/relay/src/ratelimit.ts` (comment).

- [ ] Rule: a sentence about where a Worker **is** names the new address and says the `workers.dev` one still answers; a dated record of a probe or deploy keeps the address it was asked at. `ci-and-releases.md`: the infra token needs Zone → Workers Routes → Edit on `mtg-grimoire.app`, and each deploy probe asks a second address. `EXTERNAL_SERVICES.md`: one dated paragraph for the move and the owner's rollout steps.
- [ ] `git grep -n "workers\.dev" -- . ":!docs/superpowers"` — every remaining hit is a legacy mention, a dated record, or the app Worker's "no second origin" text.

### Task 7: Verify and hand over

- [ ] `pnpm verify`.
- [ ] One commit: `feat: the relay and the share Worker answer on mtg-grimoire.app`.
- [ ] Push, open the pull request with the spec's rollout steps 1–3 and 6 as the owner's checklist.
