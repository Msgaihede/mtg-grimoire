import { Group } from "./group";

/**
 * The Worker entry. It is a router and nothing else: it validates the shape of the path,
 * addresses the one Durable Object that owns the named group, and forwards. Every decision
 * about the log itself is in `group.ts`, and every decision about *which rows* is in `log.ts`.
 *
 * **There is no authentication here and that is the design, not an omission.** The relay
 * cannot decrypt anything it stores — the group key is minted during pairing and lives only on
 * the paired devices — so the worst a stranger who guesses a group id can do is read
 * ciphertext or append rows that no device can open. What guards a group is that its id is a
 * 128-bit random uid, and what guards its contents is the key the relay has never seen.
 */

export interface Env {
  GROUP: DurableObjectNamespace;
}

/**
 * `/g/{group}/{action}`, with the group constrained to the characters a minted uid can
 * contain. The constraint is worth having for a reason beyond tidiness: an unconstrained
 * segment means `%41` and `A` name two different Durable Objects that a reader would read as
 * one group, and there is no later point at which that becomes visible.
 */
const ROUTE = /^\/g\/([A-Za-z0-9_-]{1,128})\/(push|pull|ack|ws)$/;

const METHOD: Record<string, string> = {
  push: "POST",
  pull: "GET",
  ack: "POST",
  ws: "GET",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = ROUTE.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });

    const [, group, action] = match;
    const expected = METHOD[action];
    if (request.method !== expected) {
      return new Response("method not allowed", { status: 405, headers: { allow: expected } });
    }

    // `idFromName` and not `newUniqueId`: the group id *is* the address, so every device in a
    // pairing group reaches the same object from anywhere in the world without the relay
    // holding a directory of any kind.
    const stub = env.GROUP.get(env.GROUP.idFromName(group));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export { Group };
