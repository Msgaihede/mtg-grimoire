import { verify } from "../../relay/src/token";

/**
 * The share Worker's bindings, its two caps, and the bearer gate every `/g/…` route stands
 * behind.
 *
 * **This is a second Worker beside the relay rather than a route on it, and the reason is blast
 * radius** (spec §5.1). Sync is a paid feature people depend on; sharing is new and will churn,
 * and every deploy here is done by hand by one person. One Worker carrying both means a bad
 * share deploy is a sync outage. The two share a D1 database and the `RELAY_HMAC_KEY` secret and
 * nothing else — no service binding, no shared module beyond the two files `tsconfig` names.
 *
 * **And the invariant the relay states does not extend here.** `relay/src/index.ts` argues,
 * correctly, that the relay can decrypt nothing it stores; by decision 2 a share snapshot is
 * stored **in the clear**, and Cloudflare — and Markus — can read it. What that buys is the
 * OpenGraph card in Discord and a server-rendered landing page. What it costs is that the app
 * must never send a field a reader would not put on a public page, which is why spec §3's six
 * absences are absences rather than switches, and why the privacy claim the UI makes is
 * **"anyone with the link"** and not "private".
 */
export interface Env {
  /**
   * The entitlement store — **the same D1 database the relay binds**, `mtg-grimoire-relay`.
   * `share-worker/schema.sql` adds one table to it; `relay/schema.sql` owns the rest, and the
   * daily lapse pass reads `entitlements` rather than re-deciding what the relay already wrote.
   */
  DB: D1Database;

  /**
   * The snapshots. R2 and not D1, KV or a Durable Object (spec §5.3): D1's free tier allows
   * 100,000 row writes a day account-wide, which a 3,000-card share would spend thirty times
   * over; KV allows 1,000, which is the limit `relay/wrangler.jsonc` already rejected KV for;
   * and a Durable Object is the one line that meters, which anonymous traffic must never reach.
   */
  SHARES: R2Bucket;

  /**
   * The viewer bundle, served from `dist-share/`.
   *
   * ⚠️ **Nothing in this Worker calls it, and that is the point.** `wrangler.jsonc`'s
   * `run_worker_first` names `/s/*` and `/g/*` as the only prefixes that reach the handler, so
   * `/assets/*` is answered at the edge and never costs a Worker request — which is what keeps a
   * share that goes viral off the account's per-day budget (spec §7.1). It is declared here so
   * the binding in `wrangler.jsonc` has a name in the type and nobody adds a route for the bundle
   * without meeting this paragraph first.
   */
  ASSETS: Fetcher;

  /**
   * The relay's signing key, and the whole of the coupling between the two Workers. A token this
   * Worker accepts is one the relay minted — which means a membership the relay checked — and
   * verifying it is an HMAC over memory rather than a lookup, so the gate costs no storage read.
   */
  RELAY_HMAC_KEY: string;

  /**
   * This Worker's own public address. Every link the app shows is `{SHARE_BASE}/s/{id}` built
   * here, and it must equal `share::SHARE_BASE` in the Rust byte for byte — the trap
   * `relay/wrangler.jsonc` already documents for `RELAY_BASE` and the OAuth redirect URI.
   */
  SHARE_BASE: string;
}

/**
 * Twenty shares to a group, refused with the number in the message (spec §5.3).
 *
 * **Provisional until spec §3.1 is measured**, like the blob cap beside it. It is a ceiling that
 * says "something is wrong" rather than a budget: twenty binders is far past what decision 7's
 * one-share-per-folder shape produces for a reader who is sharing rather than storefronting.
 *
 * The cap counts **non-revoked** rows. A revoked share keeps its row — it is what answers a
 * viewer 410 rather than 404 — but it must give its slot back, or a reader who publishes and
 * withdraws twenty times is locked out for ever.
 */
export const MAX_SHARES_PER_GROUP = 20;

/**
 * Eight megabytes of gzip per snapshot (spec §5.3), enforced by `blob.ts`.
 *
 * Spec §3.1's arithmetic: ~150 B a card before compression, so a 50,000-card whole-collection
 * share is ~7.5 MB of JSON and ~1.5 MB gzipped. This is five times that estimate and is
 * provisional until a real one is measured.
 */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/**
 * `relay/src/rotate.ts` and `relay/src/claim.ts` each carry these five lines and neither exports
 * them; this is the third copy, for the reason `rotate.ts:93-97` gives about the second. Reaching
 * across a directory boundary for a five-line helper would couple two Workers' deploys to make
 * one function shared, and this Worker exists precisely so the two deploys are separate.
 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A binding a deploy was supposed to set, or a throw that names it. `patreon.ts`'s `required` in
 * two lines, not imported for the reason above.
 *
 * Left to throw rather than answered as a 401: an unset signing key is a misconfigured Worker,
 * and a 500 that says so is far better than every reader in the world quietly getting a 401.
 */
function required(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`the share Worker is missing its ${name} binding`);
  }
  return value;
}

/** `{SHARE_BASE}/s/{id}` — the only link there is, and the only credential a viewer has. */
export function shareUrl(env: Env, id: string): string {
  return `${required(env.SHARE_BASE, "SHARE_BASE")}/s/${id}`;
}

/**
 * Is this request carrying a live token for **this** group? The gate in front of every `/g/…`
 * route, and the only thing that gates publishing.
 *
 * **A client-side check would be a suggestion** (spec §9), so the entitlement is enforced here:
 * the token comes from the relay's `/token` flow and an unentitled caller cannot mint one.
 *
 * The header is coalesced to `null` before `verify` is called and never passed through: `verify`
 * splits the token, so `null` throws where a 401 belongs — an error page and an alert for what is
 * simply a request without a ticket.
 *
 * ⚠️ **`claims.grp !== group` is not redundant with the signature check.** A validly signed token
 * for *your own* group is exactly what an attacker has; without this comparison one membership
 * would open every group's shares on the account.
 */
export async function authorised(request: Request, env: Env, group: string): Promise<boolean> {
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") === true ? header.slice(7) : null;
  const claims = bearer
    ? await verify(bearer, required(env.RELAY_HMAC_KEY, "RELAY_HMAC_KEY"), Date.now())
    : null;
  return claims !== null && claims.grp === group;
}
