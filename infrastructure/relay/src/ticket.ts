/**
 * What a browser needs from `GET /g/{group}/ws` that the app's own Rust socket never did: a way to
 * present the bearer without a header, a sub-protocol selected in the 101, and a keepalive it is
 * able to send. Pure functions and three strings; `index.ts`'s gate and `group.ts`'s `ws` are the
 * two callers.
 *
 * **A browser's `WebSocket` constructor takes a URL and a list of sub-protocols, and nothing
 * else.** It cannot set `Authorization` — which is one of the reasons the desktop's socket lives
 * in Rust (`infrastructure/relay/README.md`'s last section) — so a page has two places to put a credential, and
 * the URL is the wrong one: a query string is what access logs, proxies and a browser's own
 * history record. The sub-protocol list rides in the `Sec-WebSocket-Protocol` request header, so
 * that is where the token goes:
 *
 * ```
 * new WebSocket(url, ["grimoire.live.v1", "bearer.<access>"])
 * ```
 *
 * **Every character an access token can contain is legal there.** A sub-protocol is an RFC 7230
 * `token` — letters, digits and ``!#$%&'*+-.^_`|~`` — and `token.ts` mints
 * `{base64url}.{base64url}`: letters, digits, `-`, `_` and one `.`, with the `=` padding dropped.
 * No escaping, and nothing a browser's constructor refuses as a `SyntaxError`.
 *
 * ⚠️ **It is a request header like any other to Cloudflare's logs, and less hidden than
 * `Authorization` there.** A Worker's invocation log records request headers and redacts by
 * *name* — `cookie`, and any name containing `auth`, `key`, `secret`, `token` or `jwt`
 * (Cloudflare's Tail handler reference, read 2026-10-04). `sec-websocket-protocol` contains none
 * of them, so with `observability` on, a browser's access token is stored in this account's
 * Workers Logs for their retention where a desktop's is the word `REDACTED`. It is a token the
 * account's own relay minted, good for at most a day, readable by whoever can already read the
 * signing key — so nothing is exposed to anybody new — but it is a credential at rest that was not
 * one before, and that is written down here rather than discovered.
 */

/**
 * The sub-protocol the 101 selects. Versioned, so that a frame format a browser could not read
 * would be a new name an old page never offers, rather than a surprise on a socket it already
 * holds.
 */
export const LIVE_PROTOCOL = "grimoire.live.v1";

/** The entry that carries the bearer: `bearer.<access token>`. Never selected, never echoed. */
const BEARER_PREFIX = "bearer.";

/**
 * The keepalive a browser can send, and the answer it gets — `group.ts` hands both to
 * `setWebSocketAutoResponse`.
 *
 * **A browser cannot send a protocol ping.** The native client sends one every 45 s
 * (`sync_engine::schedule::PING_SECS`) because an idle socket is otherwise dropped by whatever
 * sits between the two ends, and the `WebSocket` a page gets exposes no such frame. So the page
 * sends the text frame `ping`, and expects — and ignores — `pong`.
 *
 * Exact strings, compared by the runtime byte for byte: `Ping`, `ping\n` and `"ping"` are ordinary
 * messages that wake the object for `webSocketMessage` to drop.
 */
export const KEEPALIVE = { request: "ping", response: "pong" } as const;

/**
 * The sub-protocols a `Sec-WebSocket-Protocol` request header offers, in order. The header is a
 * comma-separated list, and a client may also send it as several headers, which `Headers.get`
 * joins with `", "` — one split reads both.
 */
function offered(header: string | null): string[] {
  if (header === null) return [];
  return header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * The bearer a socket's sub-protocols carry, or `null` when they carry none.
 *
 * **The first `bearer.` entry and no other**: a page has one token, and a list offering two is
 * not a case to choose well in. An entry that is the prefix and nothing after it is `null`, which
 * the gate answers with the same 401 as no ticket at all.
 *
 * **The value is untrusted text and is returned unread** — `token.ts`'s `verify` is what decides
 * whether it is ours, exactly as it does for the header.
 *
 * ⚠️ **Only `/ws` may call this.** On `push`, `pull` and `ack` a sub-protocol header means nothing
 * and a `fetch` is able to set `Authorization`; reading a credential from a second place there
 * would be a second way in with no caller that needs it. `index.ts` asks only for `ws`, and
 * `ticket.test.ts` holds the other three to their header.
 */
export function bearerTicket(header: string | null): string | null {
  const entry = offered(header).find((candidate) => candidate.startsWith(BEARER_PREFIX));
  if (entry === undefined) return null;
  const token = entry.slice(BEARER_PREFIX.length);
  return token === "" ? null : token;
}

/**
 * The sub-protocol the 101 must name: {@link LIVE_PROTOCOL} when the request offered it, and
 * `null` — send no `Sec-WebSocket-Protocol` at all — when it did not.
 *
 * **Both halves are load-bearing.** A browser that offered sub-protocols and is answered with none
 * selected fails the connection after the 101 (RFC 6455 §4.1, and Chromium says so in its
 * console), so a page's socket would open and die without ever delivering a frame. And a client
 * that offered none and is answered with one is told by the same section to fail it — that is
 * every released desktop, whose `tokio-tungstenite` offers nothing and must go on getting the 101
 * it gets today — so the header goes out *iff* the name came in.
 *
 * **The `bearer.` entry is never what comes back.** A server selects one of the names it was
 * offered, and echoing the list — the easy way to satisfy a browser — would put the access token
 * in a *response* header, which is one more place for it to be logged.
 *
 * Case-sensitive: the name is ours on both ends, and the comparison a browser makes on the answer
 * is exact.
 */
export function selectedProtocol(header: string | null): string | null {
  return offered(header).includes(LIVE_PROTOCOL) ? LIVE_PROTOCOL : null;
}
