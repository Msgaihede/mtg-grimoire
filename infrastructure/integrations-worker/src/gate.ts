import { newestKeys, stillInGroup, verify } from "@grimoire/relay/src/token";
import { required } from "./env";

/**
 * **The door**: is this request carrying a live relay token for this group, from a device still
 * in it? The share Worker's `authorised` (`infrastructure/share-worker/src/env.ts`), copied
 * rather than imported for the reason that Worker gives about its own copies — a shared module
 * would couple two deploys, and this Worker exists so a bad deploy of it is nobody else's outage.
 *
 * **This is the only file that reads the relay's signing key**, and it reads it to verify and
 * never to mint: a token this Worker accepts is one the relay minted for a membership the relay
 * checked, and checking it is an HMAC over memory rather than a lookup. Beyond the signature it
 * costs one D1 read — the newest key manifest of the group, the relay's `newestKeys` — so a
 * device the group has removed is refused while its token is still unexpired (issue #548). This
 * Worker holds no key material of the group's and cannot derive any: the manifest it reads names
 * devices, and the keys in it are sealed to them.
 */

/** The two bindings the door reads. */
export interface GateEnv {
  /** The relay's D1 — for the newest key manifest, which `newestKeys` reads. */
  DB: D1Database;
  /**
   * The relay's signing key, and the whole of the coupling between the two Workers — the same
   * value the relay, the share Worker and the scan inbox hold. A secret: Cloudflare's to keep,
   * the owner's to set (`README.md`, *Deploying*).
   */
  RELAY_HMAC_KEY: string;
}

/**
 * `true` when the bearer is a relay token for `group` from a device still in it.
 *
 * The header is coalesced to `null` before `verify` is called, and `verify` is not asked about
 * `null`: it splits the token, and a request with no ticket is a 401, not an exception.
 *
 * ⚠️ **`claims.grp !== group` is not redundant with the signature**: a validly signed token for
 * the caller's own group is exactly what an attacker holds, and without the comparison one
 * membership would open every group's store.
 *
 * An unset key throws (`required`) — a 500 naming it, which is the deploy's tell, rather than a
 * 401 to every device in the world. An unreadable manifest throws in `stillInGroup`, and is a 500
 * too.
 */
export async function authorised(request: Request, env: GateEnv, group: string): Promise<boolean> {
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") === true ? header.slice(7) : null;
  const claims = bearer
    ? await verify(bearer, required(env.RELAY_HMAC_KEY, "RELAY_HMAC_KEY"), Date.now())
    : null;
  if (claims === null || claims.grp !== group) return false;
  return stillInGroup(await newestKeys(env.DB, group), group, claims);
}
