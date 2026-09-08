import { authorised, json, type Env } from "./env";
import { handleCreate, handleList, handleRevoke } from "./shares";

/**
 * The share Worker's entry: a router and the bearer gate. Every decision about a share is in
 * `shares.ts`; every decision about who may take one is in `env.ts`'s `authorised`.
 *
 * **The whole entitlement asymmetry is which side of the gate a route stands on** (spec §5.4).
 * Publishing, listing and revoking need a token, which needs a membership. Viewing — the public
 * `/s/…` routes Task 5 adds — needs the link and nothing else, which is what the issue asked
 * for. There is no third state and no viewer identity: the link *is* the capability, and the UI
 * says so in those words.
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
 * The method each of those four shapes takes, keyed by the action and whether an id came with
 * it. A `Map` and not a `Record`, so a shape that is not a route reads as `undefined` rather
 * than as a value the type system has promised is there.
 *
 * `share/id` is `DELETE` alone until Task 5's `PUT` lands beside it; the blob upload is the same
 * path with the other method.
 */
const METHOD = new Map<string, string>([
  ["share", "POST"],
  ["share/id", "DELETE"],
  ["shares", "GET"],
]);

function methodNotAllowed(expected: string): Response {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json", allow: expected },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const write = WRITE.exec(url.pathname);
    if (write === null) return json({ error: "not found" }, 404);

    const group = write[1];
    const action = write[2];
    // The optional group is `undefined` when the path carries no id, which `RegExpExecArray`'s
    // `string` element type does not say — so it is annotated rather than inferred.
    const id: string | undefined = write[3];

    const expected = METHOD.get(id === undefined ? action : `${action}/id`);
    if (expected === undefined) return json({ error: "not found" }, 404);
    // Ahead of the gate, as the relay answers 405 before 401: the method is a fact about the
    // request that costs nothing to check, and an HMAC verify is not free.
    if (request.method !== expected) return methodNotAllowed(expected);

    if (!(await authorised(request, env, group))) return json({ error: "unauthorized" }, 401);

    // One clock read for the whole request, passed down rather than taken again in each handler:
    // a row whose `created_at` and `updated_at` disagree by a millisecond is a row that looks
    // like it was edited.
    const now = Date.now();
    if (action === "shares") return handleList(env, group);
    if (id === undefined) return handleCreate(request, env, group, now);
    return handleRevoke(env, group, id, now);
  },
} satisfies ExportedHandler<Env>;

export type { Env };
