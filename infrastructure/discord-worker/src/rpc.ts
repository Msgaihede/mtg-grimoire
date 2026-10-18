/**
 * The Workers RPC between the Discord front (this Worker, `mtg-grimoire-discord`) and the bot's
 * Durable Object (`mtg-grimoire-bot-device`, class `BotDevice`) — the design's §13.2, to the
 * letter. **Both scripts are checked against this one file**: the front calls it through the
 * `BOT` binding (`env.ts`), and `infrastructure/bot-device/` imports these types by this
 * package's name and has its class implement {@link BotDeviceRpc}.
 *
 * ⚠️ **Types only, and so `import type` on the other side.** Nothing here is a value, so a
 * deploy of either Worker bundles nothing of the other: esbuild erases a type-only import
 * without resolving it, which is what lets each folder deploy with nothing of the other's
 * installed. A value added to this file would change that — keep it out.
 *
 * **The front holds no sync key and never sees one.** What crosses this line is an invite the
 * desktop handed the front over TLS (`enroll`), an interaction exactly as Discord signed it
 * (`interaction`, which the Durable Object verifies again itself), and answers about the device.
 * Each Durable Object is one link, one Discord account (`docs/superpowers/specs/
 * 2026-10-17-discord-integration-design.md`, §9 and §13).
 */

/** What `POST /link/enroll` hands the Durable Object: the desktop's invite, and the capability. */
export interface EnrollRequest {
  /** Exactly `pairing::Offer.code` — the text the joiner's `pairing::accept` takes. */
  invite: string;
  /** Read-only, in PR 3. The desktop alone sets a capability; this names what it asked for. */
  capability: "read";
}

/** The three public values the bot answers on joining, base64url without padding. */
export interface Enrolled {
  ok: true;
  deviceId: string;
  x25519: string;
  ed25519: string;
}

/** Why the bot did not join, by a code the front maps to an HTTP status (`link.ts`). */
export interface EnrollRefused {
  ok: false;
  code: "already_enrolled" | "bad_invite" | "pairing_failed";
  error: string;
}

/** An interaction as Discord sent it: the raw body and the two headers its signature is in. */
export interface InteractionRequest {
  /** The body, byte for byte as it was signed (decoded as UTF-8, which Discord's JSON is). */
  body: string;
  /** `X-Signature-Ed25519`, hex. */
  signature: string;
  /** `X-Signature-Timestamp`. */
  timestamp: string;
}

/** The Durable Object's answer to an interaction, which the front returns verbatim. */
export interface InteractionAnswer {
  status: number;
  contentType: string;
  body: string;
}

/** What the Durable Object says of itself. */
export interface BotStatus {
  enrolled: boolean;
  deviceId: string | null;
  paired: boolean;
  lastPullAt: number | null;
  error: string | null;
}

/** §13.2's interface: every method the front calls on a `BOT` stub. */
export interface BotDeviceRpc {
  enroll(req: EnrollRequest): Promise<Enrolled | EnrollRefused>;
  /** The Durable Object re-verifies Discord's signature over the raw body itself. */
  interaction(req: InteractionRequest): Promise<InteractionAnswer>;
  status(): Promise<BotStatus>;
  /** `ctx.storage.deleteAll()`: the identity is gone for good. */
  unlink(): Promise<void>;
}

/**
 * The part of the `BOT` binding the front uses — a Durable Object namespace whose stubs are
 * {@link BotDeviceRpc}.
 *
 * **Written here rather than as `DurableObjectNamespace<BotDevice>`**, which would need the
 * other script's class: the front would then import a value of the bot device's and bundle its
 * engine. At run time the binding is the real namespace and a stub's RPC methods are these.
 *
 * The id is minted once, by `newUniqueId()`, when a Discord account's link is first claimed,
 * and stored on the link row as `toString()`'s 64 hex characters; every later call finds the
 * same object with `idFromString`.
 */
export interface BotNamespace {
  newUniqueId(): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): BotDeviceRpc;
}
