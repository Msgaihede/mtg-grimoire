import { configured, json, notConfigured, refusal, type Env } from "./env";
import { handleInteraction } from "./interactions";
import {
  handleBegin,
  handleCallback,
  handleClaim,
  handleEnroll,
  handleStatus,
  handleUnlink,
  linkedBy,
  notLinked,
  sweepRequests,
  type LinkRow,
} from "./link";

/**
 * The Discord front's entry: a table of routes, the one limiter, and the daily sweep.
 *
 * Two callers, and a browser only for the one page. **Discord** posts every interaction to
 * `/interactions`, signed (`verify.ts`); **the desktop** links an account and enrolls the bot
 * through `/link…` (the design, §13.3). The one thing a browser ever opens is the OAuth callback,
 * a page of its own (`page.ts`) — so there is no CORS here, and a page that tried to call a route
 * would be refused by its own browser.
 *
 * **Until the Discord application exists every route answers 503 `not_configured`**
 * (`env.ts`'s `configured`): `wrangler.jsonc` ships placeholders for its id and public key, and a
 * Worker deployed before they are filled in must say so rather than verify against nonsense.
 */

/**
 * The limiter's numbers, which `wrangler.jsonc` gives the binding — repeated here so a refusal
 * can say how long to wait, and `wrangler.test.ts` holds the two together. Ten a minute from one
 * address: a reader presses the switch once, and a retry or two is all a person does.
 */
export const LIMIT = { limit: 10, period: 60 } as const;

/**
 * The 429 that refuses `POST /link/begin`, or `null` when it may go on — the scan inbox's
 * `limited`, keyed on the client address because there is no other identity on that route. It
 * fails open on a binding that is absent or throws.
 */
async function limited(request: Request, env: Env): Promise<Response | null> {
  const binding = env.RL_BEGIN;
  if (binding === undefined) return null;
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  let success: boolean;
  try {
    ({ success } = await binding.limit({ key: `begin:${address}` }));
  } catch {
    return null;
  }
  if (success) return null;
  return refusal(429, "rate_limited", "too many requests", {
    "retry-after": String(LIMIT.period),
  });
}

type Handler = (request: Request, env: Env, now: number) => Promise<Response>;
type Bearer = (request: Request, env: Env, link: LinkRow) => Promise<Response>;

/**
 * A route that needs a link secret: the 401 first, then the handler with the link it named. The
 * secret is 32 random bytes and is looked up by its SHA-256, so there is nothing to limit.
 */
const behindLink =
  (handler: Bearer): Handler =>
  async (request, env) => {
    const link = await linkedBy(request, env);
    return link === null ? notLinked() : handler(request, env, link);
  };

/** Every route: a path, and a handler for each method it takes. */
const ROUTES: Record<string, Record<string, Handler>> = {
  "/interactions": { POST: (request, env) => handleInteraction(request, env) },
  "/link/begin": {
    POST: async (request, env, now) =>
      (await limited(request, env)) ?? handleBegin(request, env, now),
  },
  "/oauth/discord/callback": { GET: handleCallback },
  "/link/claim": { POST: handleClaim },
  "/link/enroll": { POST: behindLink(handleEnroll) },
  "/link": {
    GET: behindLink((_request, env, link) => handleStatus(env, link)),
    DELETE: behindLink((_request, env, link) => handleUnlink(env, link)),
  },
};

export default {
  /**
   * **A path that is not a route is a 404, and a method a route does not take a 405** — both
   * ahead of the configuration check, the limiter and every binding, because they are facts
   * about the request and a probe should not cost anything to be told them.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const methods = ROUTES[new URL(request.url).pathname];
    if (methods === undefined) return json({ error: "not found", code: "not_found" }, 404);
    const handler = methods[request.method];
    if (handler === undefined) {
      return json({ error: "method not allowed", code: "method_not_allowed" }, 405, {
        allow: Object.keys(methods).join(", "),
      });
    }
    if (!configured(env)) return notConfigured();
    return handler(request, env, Date.now());
  },

  /**
   * The daily sweep, fired by `wrangler.jsonc`'s `45 3 * * *`: the link requests nobody came back
   * for. Awaited rather than handed to `ctx.waitUntil`, for the share Worker's reason: a pass
   * that throws is reported against the scheduled invocation that caused it.
   */
  async scheduled(controller: ScheduledController, env: Env) {
    await sweepRequests(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;

export type { Env };
