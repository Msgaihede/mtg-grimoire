import { handleSnapshot, handleUpload } from "./blob";
import { authorised, json, type Env } from "./env";
import { sweepLapsed } from "./lapse";
import { handleShell, notFound } from "./page";
import { handleCreate, handleList, handleRevoke } from "./shares";

/**
 * The share Worker's entry: a router and the bearer gate. Every decision about a share is in
 * `shares.ts`; every decision about who may take one is in `env.ts`'s `authorised`.
 *
 * **The whole entitlement asymmetry is which side of the gate a route stands on** (spec §5.4).
 * Publishing, uploading, listing and revoking need a token, which needs a membership. Viewing —
 * the two public `/s/…` routes — needs the link and nothing else, which is what the issue asked
 * for. There is no third state and no viewer identity: the link *is* the capability, and the UI
 * says so in those words.
 *
 * **`/assets/*` is not routed here at all and must not be**, which is the other half of what
 * makes anonymous traffic affordable: `wrangler.jsonc`'s `assets` binding names `/s/*` and `/g/*`
 * as the only prefixes that reach this Worker, and a static asset request is free and unlimited
 * even on the free plan. Adding a route for the bundle would put every viewer's JavaScript on the
 * account's 100,000-request budget — the cliff spec §7.1 says nothing else can raise.
 *
 * **Nothing here reaches a Durable Object and this Worker binds none**, which is the reason
 * anonymous traffic is affordable at all: a request that reaches a DO costs a Durable Object
 * request whether it is honoured or refused, and that is the line that meters (spec §8). D1 and
 * R2 are what this Worker has.
 */

/** A share id: 12 random bytes as unpadded base64url, so exactly 16 characters. */
const SHARE_ID = "[A-Za-z0-9_-]{16}";

/**
 * The group segment, spelled from the same character class `relay/src/claim.ts` exports rather
 * than imported from it.
 *
 * **Not imported, deliberately.** `tsconfig.share-worker.json` names the two relay modules this
 * Worker depends on and `claim.ts` is not one of them: importing a constant would pull the
 * relay's entitlement layer — Patreon, the Durable Object binding, the whole graph — into a
 * bundle that must be able to deploy while the relay's is broken. The rule the class encodes is
 * worth restating anyway: an unconstrained segment means `%41` and `A` name two groups a reader
 * would read as one, with no later point at which the disagreement becomes visible.
 */
const GROUP_SEGMENT = "[A-Za-z0-9_-]{1,128}";

/**
 * `/g/{group}/share`, `/g/{group}/share/{id}` and `/g/{group}/shares` — the gated three.
 *
 * The id is optional in the pattern rather than in a second regex, so a path that carries one
 * where none belongs (`/g/{group}/shares/{id}`) falls to the table below and is a 404 rather
 * than being silently read as a list.
 */
const WRITE = new RegExp(`^/g/(${GROUP_SEGMENT})/(share|shares)(?:/(${SHARE_ID}))?$`);

/**
 * The digest a snapshot is named by: sixteen lowercase hex characters, `blob.ts`'s `digest`.
 *
 * **Constrained here rather than checked in the handler**, for `GROUP_SEGMENT`'s reason: an
 * unconstrained segment lets `/s/{id}/../../x.json.gz` and `/s/{id}/ABC.json.gz` be spelled at
 * all, and every one of them would reach a storage lookup before being refused. The character
 * class is the refusal.
 */
const HASH = "[0-9a-f]{16}";

/**
 * The two public routes: the rendered shell, and the immutable snapshot under it.
 *
 * The hash is optional in the pattern for the reason the id is above — one regex, so a path that
 * carries a third segment is a 404 rather than being read as either.
 */
const PUBLIC = new RegExp(`^/s/(${SHARE_ID})(?:/(${HASH})\\.json\\.gz)?$`);

/**
 * The methods each of those four gated shapes takes, keyed by the action and whether an id came
 * with it. A `Map` and not a `Record`, so a shape that is not a route reads as `undefined` rather
 * than as a value the type system has promised is there.
 *
 * `share/id` takes **two**: the blob upload is the same path as the withdrawal with the other
 * method, because both are statements about one share and inventing `/share/{id}/blob` beside it
 * would be a second name for the same thing.
 */
const METHOD = new Map<string, readonly string[]>([
  ["share", ["POST"]],
  ["share/id", ["PUT", "DELETE"]],
  ["shares", ["GET"]],
]);

function methodNotAllowed(expected: string): Response {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json", allow: expected },
  });
}

export default {
  /**
   * `ctx` is optional because the suite calls `worker.fetch(request, env)` — there is no workerd
   * here to supply one, by `vite.config.ts`'s deliberate choice — and `handleSnapshot` is written
   * to await its cache write when it is absent, which is also what lets a test assert that a warm
   * view costs no R2 read.
   */
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // **The public pair is matched first, because it is the only traffic that scales.** A gated
    // request comes from one of five devices; these two come from everyone the link reaches.
    const seen = PUBLIC.exec(url.pathname);
    if (seen !== null) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed("GET, HEAD");
      }
      const id = seen[1];
      const hash: string | undefined = seen[2];
      // ⚠️ **A HEAD is served as the GET it is asking about and then stripped.** The Cache API
      // takes GET alone — `cache.put` throws on anything else — so a HEAD carried into
      // `handleSnapshot` as itself would miss the cache every time and then throw trying to fill
      // it. Rewriting it here means a link checker warms the same entry a reader would use, and
      // neither handler needs to know the method exists.
      const get = request.method === "HEAD" ? new Request(url.toString()) : request;
      const answer = await (hash === undefined
        ? handleShell(env, id, Date.now())
        : handleSnapshot(get, env, id, hash, ctx));
      if (request.method !== "HEAD") return answer;
      // The unread half of the tee `handleSnapshot` handed the cache: cancelled rather than
      // dropped, because a tee whose other branch is never read can stall the branch that is.
      void answer.body?.cancel();
      return new Response(null, { status: answer.status, headers: answer.headers });
    }

    const write = WRITE.exec(url.pathname);
    // **`/g/…` answers JSON and everything else answers the page.** A path that is neither route
    // is overwhelmingly a mistyped or truncated share link — a well-formed id is sixteen
    // base64url characters and one wrong keystroke misses `PUBLIC` entirely — and that reader is
    // exactly who the page is for. Under `/g/` the caller is the app, which parses JSON and would
    // meet an HTML body as a decode error naming nothing.
    if (write === null) {
      return url.pathname.startsWith("/g/") ? json({ error: "not found" }, 404) : notFound();
    }

    const group = write[1];
    const action = write[2];
    // The optional group is `undefined` when the path carries no id, which `RegExpExecArray`'s
    // `string` element type does not say — so it is annotated rather than inferred.
    const id: string | undefined = write[3];

    const expected = METHOD.get(id === undefined ? action : `${action}/id`);
    if (expected === undefined) return json({ error: "not found" }, 404);
    // Ahead of the gate, as the relay answers 405 before 401: the method is a fact about the
    // request that costs nothing to check, and an HMAC verify is not free.
    if (!expected.includes(request.method)) return methodNotAllowed(expected.join(", "));

    if (!(await authorised(request, env, group))) return json({ error: "unauthorized" }, 401);

    // One clock read for the whole request, passed down rather than taken again in each handler:
    // a row whose `created_at` and `updated_at` disagree by a millisecond is a row that looks
    // like it was edited.
    const now = Date.now();
    if (action === "shares") return handleList(env, group);
    if (id === undefined) return handleCreate(request, env, group, now);
    if (request.method === "PUT") return handleUpload(request, env, group, id, now);
    return handleRevoke(env, group, id, now);
  },

  /**
   * The daily lapse pass (spec §6), fired by `wrangler.jsonc`'s `30 3 * * *`.
   *
   * **This Worker's own cron and not the relay's**, which is §5.1's blast-radius argument
   * applied to the schedule: the relay's source and deploy stay untouched, and the free plan
   * allows five triggers per account against the one the relay uses. The half hour is the whole
   * reason for `30` rather than `0` — the two passes write the same D1 and there is nothing to
   * be gained by having them do it at the same instant.
   *
   * Awaited rather than handed to `ctx.waitUntil`, so a pass that throws is reported against the
   * scheduled invocation that caused it rather than against nothing — and `ctx` is deliberately
   * absent from the signature for the reason `relay/src/index.ts` states: there is nothing to
   * keep alive past the return, and eslint's `no-unused-vars` runs `args: "after-used"`, which
   * forgives a leading `_controller` in front of a parameter that is used and refuses a trailing
   * one that is not.
   */
  async scheduled(_controller: ScheduledController, env: Env) {
    await sweepLapsed(env);
  },
} satisfies ExportedHandler<Env>;

export type { Env };
