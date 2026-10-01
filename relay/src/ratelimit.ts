/**
 * The rate limits on the routes a caller can reach with no token — runbook step 8.
 *
 * **What this buys is the D1 read, not the request.** `index.ts`'s bill argument — junk is
 * refused for the price of a Worker invocation alone — holds for the routes behind the bearer
 * gate and not for these five, which each read D1 before anything can refuse them. A limit here
 * refuses the caller before that read. It does **not** keep the request off the account's
 * 100,000-a-day budget: the Worker has already been invoked to ask the question, and only a rule
 * in front of the Worker could spare that — which needs a zone, and `workers.dev` has none.
 *
 * **Three bindings because a binding carries one limit**, and the routes fall into three sizes of
 * honest use: a Connect press, a token mint or a rotation, and the two reads a device makes on
 * every trip or every poll. The numbers live in `wrangler.jsonc`; {@link LIMITS} repeats them so
 * the refusal can say how long to wait, and `ratelimit.test.ts` holds the two together.
 *
 * **Cloudflare counts per location and eventually** — the binding's own documentation calls it
 * permissive and "not … an accurate accounting system" — so a limit of 10 is a caller refused
 * somewhere after their tenth request in a minute at one data centre, not a promise about the
 * eleventh. That is the right instrument for bounding junk and the wrong one for anything exact.
 */

/** The three limiter bindings, and the limit `wrangler.jsonc` gives each. */
export const LIMITS = {
  /** `/claim` — one per Connect press. */
  RL_CLAIM: { limit: 10, period: 60 },
  /** `/token` and `/rotate` — a device mints about once every eighteen hours. */
  RL_MINT: { limit: 30, period: 60 },
  /**
   * `/keys` and the pairing rendezvous — one `/keys` per sync trip, and a pairing dialog polls
   * `/p/{rv}/{slot}` every 1.5 s, which is 40 a minute from one device and 80 from the two of a
   * pair sitting behind one address.
   */
  RL_READ: { limit: 240, period: 60 },
} as const;

type Binding = keyof typeof LIMITS;

/** The limited routes, each with the binding sized for it. The name is half of the bucket key. */
const BINDING = {
  claim: "RL_CLAIM",
  token: "RL_MINT",
  rotate: "RL_MINT",
  keys: "RL_READ",
  rendezvous: "RL_READ",
} as const satisfies Record<string, Binding>;

export type LimitedRoute = keyof typeof BINDING;

/**
 * The bindings, **optional because their absence is handled and not assumed away.** A secret this
 * Worker cannot run without is typed `string` and `required` turns an unset one into a loud 500;
 * a limiter is the opposite case — sync must not stop because the thing that bounds junk is
 * missing — so an absent one is a request let through.
 */
export type Limiters = { [K in Binding]?: RateLimit };

/**
 * The 429 that refuses this request, or `null` when it may go on to its handler.
 *
 * **Keyed on the route and the client address**, because an address is the only identity a caller
 * with no token has. Cloudflare's guidance is against keying on an address — many readers share
 * one behind a mobile carrier or a proxy — and the answer here is the size of the limits rather
 * than a better key: there is none, and every limit is several times the heaviest honest use of a
 * whole household. The route is in the key so that a pairing dialog's polls never spend the
 * budget a sync trip's `/keys` needs.
 *
 * `cf-connecting-ip` is set by Cloudflare on every request that reaches a deployed Worker and
 * cannot be forged past it. A request without one is local or a test, and it shares one bucket
 * rather than escaping the limit.
 *
 * ⚠️ **It fails open twice, deliberately**: a binding that is not there and a binding that throws
 * both let the request through. The refusal is `429` with a `code`, and **never a 401** — the app
 * reads a 401 on these routes as a statement about a membership, and a reader told their
 * membership ended because they pressed Sync too fast is the failure `device_limit` already had
 * to be given its own status to avoid.
 */
export async function limited(
  request: Request,
  env: Limiters,
  route: LimitedRoute,
): Promise<Response | null> {
  const name = BINDING[route];
  const binding = env[name];
  if (binding === undefined) return null;

  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  let success: boolean;
  try {
    ({ success } = await binding.limit({ key: `${route}:${address}` }));
  } catch {
    return null;
  }
  if (success) return null;

  return new Response(JSON.stringify({ error: "too many requests", code: "rate_limited" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(LIMITS[name].period),
    },
  });
}
