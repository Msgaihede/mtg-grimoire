import { refused } from "./auth";
import { allowedOrigin, preflight, withCors } from "./cors";
import { json, type Env } from "./env";
import { handleSubmit } from "./submit";

/**
 * The scan Worker's entry: one route, the pre-flight in front of it and the limiter behind that.
 *
 * `POST /scan` is the whole of it (`submit.ts`), behind the relay's token (`auth.ts`). There is deliberately no second route — nothing
 * lists the inbox, nothing reads a run back, nothing deletes one — because every one of those
 * would be a thing a stranger could ask of a Worker that has no way to tell a stranger from the
 * maker. `env.ts` has the rest of that argument.
 */

const ROUTE = "/scan";
const METHODS = "POST";

/**
 * Twelve a minute from one address, which `wrangler.jsonc` gives the binding; repeated here so the
 * refusal can say how long to wait, and `wrangler.test.ts` holds the two together.
 *
 * A reader sends one scan at a time through a dialog that asks which card it is; twelve a minute
 * is past anything a person does and is a household behind one address besides. **It bounds a
 * flood from one address and nothing else** — `env.ts`'s `MAX_PENDING` is what bounds the bucket.
 */
export const LIMIT = { limit: 12, period: 60 } as const;

/**
 * The 429 that refuses this request, or `null` when it may go on —
 * `infrastructure/relay/src/ratelimit.ts`'s `limited`, for one route. Keyed on the client address
 * because there is no other identity here; it fails open on a binding that is absent or throws.
 */
async function limited(request: Request, env: Env): Promise<Response | null> {
  const binding = env.RL_SUBMIT;
  if (binding === undefined) return null;

  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  let success: boolean;
  try {
    ({ success } = await binding.limit({ key: `submit:${address}` }));
  } catch {
    return null;
  }
  if (success) return null;

  return json({ error: "too many requests", code: "rate_limited" }, 429, {
    "retry-after": String(LIMIT.period),
  });
}

async function route(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  // Ahead of the limiter, as the relay answers 405 before anything that costs: the method is a
  // fact about the request, and a probe that asks `GET /scan` should not spend a reader's budget.
  if (request.method !== METHODS) {
    return json({ error: "method not allowed" }, 405, { allow: METHODS });
  }
  // **The limiter, then the door, then everything about the scan.** The limiter first, because
  // it is what a flood of requests with no token is made to cost least by; then `auth.ts`, so
  // that nothing a stranger sends — a type, a label, a body — is so much as read; and only a
  // supporter's request reaches the handler.
  const now = Date.now();
  return (
    (await limited(request, env)) ??
    (await refused(request, env, now)) ??
    handleSubmit(request, env, now, ctx)
  );
}

export default {
  /**
   * **A path that is not the route is a 404 with no CORS header and no limiter asked**; the route
   * answers a pre-flight before the limiter and the bucket, and every other answer — the refusals
   * above all — is made readable to the page that asked (`cors.ts`). A request with no `Origin`
   * gets the router's own `Response`, untouched.
   *
   * `ctx` is optional because the suite calls `worker.fetch(request, env)` — there is no workerd
   * here to supply one — and `handleSubmit` awaits its writes whether or not it has one.
   */
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== ROUTE) return json({ error: "not found" }, 404);

    const origin = allowedOrigin(request, env);
    if (origin === null) return route(request, env, ctx);
    return (
      preflight(request, origin, METHODS) ?? withCors(await route(request, env, ctx), origin)
    );
  },
} satisfies ExportedHandler<Env>;

export type { Env };
