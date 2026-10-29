import { normaliseName, type Table } from "./projection";
import { toBase64url } from "./seal";

/**
 * **Intents**, as this Worker holds a consumer to them (the PR 3 plan,
 * `docs/superpowers/plans/2026-10-29-integrations-intents.md`, §3.1): the closed list of kinds,
 * each kind's payload as an exact key set, the sources and the integrations a token is minted
 * for, the scopes, the caps, and every code word the inbox and the consumer routes answer with.
 *
 * **The Worker checks, and the device checks again** (the spec's §6.2). What is refused here is a
 * shape a device would refuse anyway — refusing it at the door keeps a consumer that sends it from
 * filling a group's inbox with things nobody will ever apply. What is *let through* here is still
 * only a proposal: `grimoire_core::integration::intents` holds every intent to the device's own
 * allow-list before it writes, whatever this file said. So this file is a fence against noise,
 * and never the fence against a write.
 *
 * Nothing here is I/O. `store.ts` calls it from inside the group's object, and the router calls
 * the parsers that need no store.
 */

/** Where an intent came from — the token's integration, or a trade room's object (PR 6). */
export const SOURCES = ["discord", "mcp", "trade"] as const;
export type Source = (typeof SOURCES)[number];

/**
 * **The integrations a consumer token is minted for**, v1. `trade` is a source and not one of
 * these: a trade room is an object of this Worker's (PR 6), and writes into an inbox with no
 * token at all.
 */
export const INTEGRATIONS = ["discord", "mcp"] as const;
export type Integration = (typeof INTEGRATIONS)[number];

/** The closed list of kinds, v1. A change, a move or a removal has no kind, so none can be sent. */
export const KINDS = ["collection.add", "wishlist.add"] as const;
export type Kind = (typeof KINDS)[number];

/** What a consumer token may do. A read scope per table group, and an add scope per kind. */
export const SCOPES = [
  "collection:read",
  "wishlist:read",
  "decks:read",
  "collection:add",
  "wishlist:add",
] as const;
export type Scope = (typeof SCOPES)[number];

/** An intent's states. Only `pending` is ever overlaid or handed to a device to apply. */
export type State = "pending" | "applied" | "refused";

// ---------------------------------------------------------------------------------------
// The code words — read by the Rust from this file (`integration::store`'s tests)
// ---------------------------------------------------------------------------------------

/** No such intent in this store — or, to a consumer, none of its integration's. */
export const NO_INTENT = "no_intent";
/** Another device holds a live lease on that intent. */
export const CLAIMED = "claimed";
/** That intent has been acked already, with another state than this ack's. */
export const ALREADY_ACKED = "already_acked";
/** An ack body that is not `{ state, reason, lease, hlcMs, hlcCtr }` as plan §3.2 says. */
export const BAD_ACK = "bad_ack";
/** A mint body that is not `{ scopes, days }` as plan §3.2 says. */
export const BAD_CONSUMER = "bad_consumer";
/** An intent body or payload outside plan §3.1. */
export const BAD_INTENT = "bad_intent";
/** The consumer's token does not carry the scope the route or the kind needs. */
export const SCOPE = "scope";
/** A `POST /c/intents` body over {@link MAX_INTENT_BYTES}. */
export const INTENT_TOO_LARGE = "intent_too_large";
/** The integration has written {@link INTENTS_PER_DAY} intents today (UTC). */
export const INTENT_QUOTA = "intent_quota";
/** No deck of that uid in the store's projection. */
export const NO_DECK = "no_deck";

// ---------------------------------------------------------------------------------------
// The caps — the Discord branch's figures (the issue's PR 3 line)
// ---------------------------------------------------------------------------------------

/** A `POST /c/intents` body may be at most this many bytes, counted as it arrives. */
export const MAX_INTENT_BYTES = 64 * 1024;

/** An integration may write this many intents a UTC day into one group's inbox. */
export const INTENTS_PER_DAY = 64;

/**
 * **How long a claim holds** — ten minutes. A device applies within milliseconds of its claim;
 * the lease is long so a slow host's round still acks under it, and short so a device that died
 * mid-round leaves an intent another device can take the same day.
 */
export const LEASE_MS = 10 * 60 * 1000;

/** An acked intent is kept this long for its integration to read the outcome, then purged. */
export const KEEP_ACKED_MS = 30 * 24 * 60 * 60 * 1000;

/** At most this many pending intents a `GET …/intents` answers; `more` says there were others. */
export const MAX_PENDING_LISTED = 200;

/** A `refused` ack's reason: a sentence a reader is shown, so it is short. */
export const MAX_REASON_CHARS = 300;

/** `confirmedBy`: who pressed Confirm, as the integration names them (`discord:123`). */
export const MAX_CONFIRMED_BY_CHARS = 128;

/** A display hint's longest form — `name`, `set`, `cn`. */
export const MAX_HINT_CHARS = 200;

/** An identity field's — a Scryfall id, an oracle id, a folder's `sync_uid`. */
export const MAX_ID_CHARS = 64;

/** The longest lease a token may ask for, in days, and the shortest. */
export const MAX_TOKEN_DAYS = 365;

/** An intent id, a lease and a token id: 16 random bytes, base64url, unpadded. */
export const RANDOM_ID = /^[A-Za-z0-9_-]{22}$/;

/** The three finishes a printing is made in — the projection's and the app's own words. */
export const FINISHES = ["nonfoil", "foil", "etched"] as const;

/** An intent as the Worker answers it, to a device or to its integration. */
export interface Intent {
  id: string;
  group: string;
  source: Source;
  kind: Kind;
  payload: Record<string, unknown>;
  createdAt: number;
  confirmedBy: string | null;
  state: State;
  reason: string | null;
}

/** A consumer's `POST /c/intents` body, once checked. */
export interface IntentBody {
  kind: Kind;
  payload: Record<string, unknown>;
  confirmedBy: string | null;
}

export const isKind = (value: unknown): value is Kind =>
  typeof value === "string" && (KINDS as readonly string[]).includes(value);

export const isIntegration = (value: unknown): value is Integration =>
  typeof value === "string" && (INTEGRATIONS as readonly string[]).includes(value);

const isScope = (value: unknown): value is Scope =>
  typeof value === "string" && (SCOPES as readonly string[]).includes(value);

/** The scope that lets a token write `kind`. */
export function scopeFor(kind: Kind): Scope {
  return kind === "collection.add" ? "collection:add" : "wishlist:add";
}

/** The projected table an add of `kind` lands in — what the overlay is drawn over. */
export function tableOf(kind: Kind): Table {
  return kind === "collection.add" ? "collection_entries" : "wishlist_entries";
}

/** Is `value` a plain object — not `null`, not an array? */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Does `object` hold exactly `required` and nothing outside `required ∪ optional`? */
function keysAre(
  object: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(object);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

/** A non-empty string of at most `max` characters. */
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** `text`, or `null`. */
const textOrNull = (value: unknown, max: number): value is string | null =>
  value === null || text(value, max);

const quantity = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 99;

const finish = (value: unknown): value is string =>
  typeof value === "string" && (FINISHES as readonly string[]).includes(value);

/** The optional hints, each a string of at most {@link MAX_HINT_CHARS} when present. */
function hintsOk(payload: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => !(key in payload) || text(payload[key], MAX_HINT_CHARS));
}

/**
 * The payload of `kind`, or the sentence that refuses it (`400 bad_intent`) — plan §3.1's table,
 * key for key:
 *
 * - `collection.add`: `scryfallId`, `finish`, `quantity`, `folderUid` required, `name`, `set`,
 *   `cn` optional; the folder is required (a collection add names a `kind = 'user'` folder and
 *   never the root, the branch's §14.2 rule — the device checks the kind).
 * - `wishlist.add`: `scryfallId`, `oracleId`, `finish`, `quantity`, `folderUid`, `name` required,
 *   `set`, `cn` optional; the two ids each a string or `null` but not both `null`, the finish one
 *   of three or `null`, the folder a uid or `null` for the wishlist's root.
 *
 * **Display hints are checked for size and nothing else**: the device reads the card from its own
 * card data and never from them. They are here so the overlay can draw and search an add before
 * any device has seen it.
 */
export function validatePayload(kind: Kind, payload: unknown): Record<string, unknown> | string {
  if (!isObject(payload)) return "an intent's payload is a JSON object";
  if (kind === "collection.add") {
    if (!keysAre(payload, ["scryfallId", "finish", "quantity", "folderUid"], ["name", "set", "cn"]))
      return "a collection.add is { scryfallId, finish, quantity, folderUid } with name, set and cn optional";
    if (!text(payload.scryfallId, MAX_ID_CHARS)) return "a collection.add names its card";
    if (!text(payload.folderUid, MAX_ID_CHARS)) return "a collection.add names its folder";
    if (!hintsOk(payload, ["name", "set", "cn"])) return "a hint is a string of at most 200";
  } else {
    if (
      !keysAre(
        payload,
        ["scryfallId", "oracleId", "finish", "quantity", "folderUid", "name"],
        ["set", "cn"],
      )
    )
      return "a wishlist.add is { scryfallId, oracleId, finish, quantity, folderUid, name } with set and cn optional";
    if (!textOrNull(payload.scryfallId, MAX_ID_CHARS) || !textOrNull(payload.oracleId, MAX_ID_CHARS))
      return "a wishlist.add's ids are strings or null";
    if (payload.scryfallId === null && payload.oracleId === null)
      return "a wishlist.add names a card or an oracle id";
    if (!textOrNull(payload.folderUid, MAX_ID_CHARS))
      return "a wishlist.add's folder is a uid or null";
    if (!text(payload.name, MAX_HINT_CHARS)) return "a wishlist.add names its card";
    if (!hintsOk(payload, ["set", "cn"])) return "a hint is a string of at most 200";
  }
  if (kind === "collection.add" ? !finish(payload.finish) : !(payload.finish === null || finish(payload.finish)))
    return "an intent's finish is nonfoil, foil or etched";
  if (!quantity(payload.quantity)) return "an intent's quantity is a whole number from 1 to 99";
  return payload;
}

/**
 * A consumer's body — `{ kind, payload, confirmedBy }`, exactly those keys, `kind` one of the two —
 * or the sentence that refuses it. **The payload is not looked at here**: the route asks the
 * token's scope for the kind first (`403 scope`), so a token that may not add a card learns
 * nothing about how to spell one; {@link validatePayload} is next.
 */
export function parseIntentShape(
  value: unknown,
): { kind: Kind; payload: unknown; confirmedBy: string | null } | string {
  if (!isObject(value)) return "an intent is a JSON object";
  if (!keysAre(value, ["kind", "payload", "confirmedBy"]))
    return "an intent is { kind, payload, confirmedBy }";
  if (!isKind(value.kind)) return `an intent's kind is one of ${KINDS.join(", ")}`;
  if (!textOrNull(value.confirmedBy, MAX_CONFIRMED_BY_CHARS))
    return "confirmedBy is a string of at most 128 or null";
  return { kind: value.kind, payload: value.payload, confirmedBy: value.confirmedBy };
}

/** A device's ack, once checked. */
export interface Ack {
  state: "applied" | "refused";
  reason: string | null;
  lease: string | null;
  hlcMs: number | null;
  hlcCtr: number | null;
}

const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * `{ state, reason, lease, hlcMs, hlcCtr }`, exactly those keys, or `null` (`400 bad_ack`).
 * **An `applied` ack carries its lease and the device's watermark after the write**, which is what
 * keeps the overlay drawing the add until a published table reflects it (plan §2); its `reason` is
 * `null`. **A `refused` ack carries a reason** a reader is shown, and its lease and watermark may
 * be `null`: every device refuses the same intent for the same reason, so it needs no claim.
 */
export function parseAck(value: unknown): Ack | null {
  if (!isObject(value) || !keysAre(value, ["state", "reason", "lease", "hlcMs", "hlcCtr"])) {
    return null;
  }
  const { state, reason, lease, hlcMs, hlcCtr } = value;
  if (!(lease === null || (typeof lease === "string" && RANDOM_ID.test(lease)))) return null;
  if (state === "applied") {
    if (reason !== null || lease === null || !counter(hlcMs) || !counter(hlcCtr)) return null;
    return { state, reason: null, lease, hlcMs, hlcCtr };
  }
  if (state === "refused") {
    if (!text(reason, MAX_REASON_CHARS)) return null;
    if (!(hlcMs === null || counter(hlcMs)) || !(hlcCtr === null || counter(hlcCtr))) return null;
    return { state, reason, lease, hlcMs: hlcMs ?? null, hlcCtr: hlcCtr ?? null };
  }
  return null;
}

/**
 * A mint's body — `{ scopes, days }`, exactly those keys: a non-empty list of known scopes with no
 * repeats, and a whole number of days from 1 to {@link MAX_TOKEN_DAYS} — or `null`
 * (`400 bad_consumer`). The scopes come back in {@link SCOPES}' order, so one grant has one
 * spelling in every token and every row.
 */
export function parseConsumerRequest(value: unknown): { scopes: Scope[]; days: number } | null {
  if (!isObject(value) || !keysAre(value, ["scopes", "days"])) return null;
  const { scopes, days } = value;
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(isScope)) return null;
  if (new Set(scopes).size !== scopes.length) return null;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS) {
    return null;
  }
  return { scopes: SCOPES.filter((scope) => scopes.includes(scope)), days };
}

/** A list of scopes as stored, back — the known ones, in canonical order. */
export function scopesOf(stored: string): Scope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? SCOPES.filter((scope) => parsed.includes(scope)) : [];
}

/** The UTC day a millisecond falls in — the daily cap's counter key. */
export const utcDay = (ms: number) => Math.floor(ms / 86_400_000);

/** The clear name a pending add is searched by: its `name` hint, normalised, or `null`. */
export function hintName(payload: Record<string, unknown>): string | null {
  return typeof payload.name === "string" ? normaliseName(payload.name) : null;
}

/** 16 random bytes as an id — an intent's, a lease's, a token's. */
export function randomId(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * The overlay's row for an intent (plan §3.3): `uid: null` — it is no projected row yet — the
 * intent's id and state, and the payload's card, finish, quantity and folder. `oracleId` only on a
 * wish; `name` `null` when a collection add carried no hint; `set` and `cn` only when hinted.
 */
export function overlayRow(intent: {
  id: string;
  kind: Kind;
  state: State;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  const { payload } = intent;
  const row: Record<string, unknown> = {
    uid: null,
    intentId: intent.id,
    state: intent.state,
    scryfallId: payload.scryfallId ?? null,
  };
  if (intent.kind === "wishlist.add") row.oracleId = payload.oracleId ?? null;
  row.name = payload.name ?? null;
  if (typeof payload.set === "string") row.set = payload.set;
  if (typeof payload.cn === "string") row.cn = payload.cn;
  row.finish = payload.finish ?? null;
  row.quantity = payload.quantity;
  row.folderUid = payload.folderUid ?? null;
  return row;
}
