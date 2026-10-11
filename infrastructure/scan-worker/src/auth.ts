import { verify } from "@grimoire/relay/src/token";
import { json, type Env } from "./env";

/**
 * The door: **a scan is taken from a supporter's device and from nobody else** (the owner's
 * decision, 2026-10-11).
 *
 * The app draws its Send for a supporter alone, and its engine refuses anybody else before it
 * reads a frame — and both of those are a suggestion to anyone who can send a request. So the
 * entitlement is enforced here, the way the share Worker enforces its own
 * (`infrastructure/share-worker/src/env.ts`, `authorised`): the request carries the token the
 * relay's `/token` door mints, which an unentitled caller cannot get, and this Worker checks the
 * relay's signature on it with the relay's key. No service binding and no request to the relay:
 * a deploy here stays a deploy of this Worker alone.
 *
 * **What the token says is checked and thrown away.** It names a membership and a sync group,
 * which is the one thing in a submission that could say who sent it. Nothing here returns the
 * claims: the caller learns that the door is open and nothing else, so no later line can store
 * them, log them or key a limit on them. `submit.test.ts` holds that nothing of a token is in
 * either stored object.
 *
 * **A signature and an expiry, and no more.** The share Worker goes on to ask the relay's
 * database whether the device is still in its group, because what it guards is a group's own
 * shares; this Worker has no database and guards an inbox. A device removed from its group can
 * therefore send scans until its token dies, which is at most a day (`TOKEN_TTL_MS`) — and a
 * membership that ended, the same day.
 */

/** The machine-readable half of the two refusals this file makes. */
export const UNAUTHORIZED = "unauthorized";
export const NO_KEY = "no_key";

/**
 * The refusal for this request, or `null` when it carries a live token of the relay's.
 *
 * - **401** for every way a token can be unacceptable — none, not a bearer, another key's,
 *   edited, expired — in one sentence that does not say which: `verify` answers `null` for all
 *   of them and throws for none, so what a stranger sends can never be a 500.
 * - **500** when this Worker holds no key. That is a deploy with a step left out, not a caller's
 *   fault, and it is answered rather than thrown: this Worker keeps no log, so an exception
 *   would be an error page that says nothing, where this says what is missing. The release's
 *   probe reads it (`scripts/scan-deploy-probe.ts`).
 *
 * The header is read as `Bearer <token>` exactly, and coalesced to no token otherwise.
 */
export async function refused(request: Request, env: Env, now: number): Promise<Response | null> {
  const key = env.RELAY_HMAC_KEY;
  if (typeof key !== "string" || key === "") {
    return json({ error: "this Worker holds no RELAY_HMAC_KEY", code: NO_KEY }, 500);
  }
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") === true ? header.slice(7) : "";
  const claims = bearer === "" ? null : await verify(bearer, key, now);
  if (claims === null) {
    return json({ error: "unauthorized", code: UNAUTHORIZED }, 401, {
      "www-authenticate": "Bearer",
    });
  }
  return null;
}
