/**
 * Integrations: the group's switch for a server-held copy of the collection, and what goes in it
 * (issue #1396, plan `2026-10-25-integrations-projection-store.md` §3.3).
 *
 * **One domain of `../ipc.ts`.** Nothing outside `packages/ui/lib/ipc*` imports this file: every
 * page, hook, story and test goes through `@/lib/ipc`, which re-exports these types and spreads
 * `integrationCommands` into `ipc`. ESLint refuses the deep import, and `ipc.test.ts` reads this
 * file with its siblings, so the struct-parity walk and the argument-name fences cover it.
 *
 * **The store's existence is the group's switch, and the fields are the group's too** (plan §2):
 * two devices projecting under two policies would flap the store between them. So nothing here is
 * a per-device preference — `enabled` and `fields` are what this device last heard from the store,
 * and a change made on one device is what every other device reads back on its next ask.
 */
import { invoke } from "./invoke";

/**
 * Which of the five optional columns the group's copy carries —
 * `grimoire_core::integration::projection::IntegrationFields`, and the wire form of the
 * `fields` argument of {@link integrationCommands.integrationsEnable} and
 * {@link integrationCommands.integrationsSetFields}.
 *
 * **Five booleans under their own names, never a list of words**, `ShareFields`' reason: a page
 * cannot invent a sixth column by spelling one. Every one is off until the reader ticks it.
 *
 * ⚠️ **`tags` is the collection's free-text `tags` column** — what a reader typed on an entry —
 * and never one of Scryfall's tagger datasets, which this app calls tags everywhere else
 * (`docs/agent/DOMAIN_VOCABULARY.md`). The panel labels it *Entry tags* for that reason, and
 * `notes` *Entry notes* beside it: the entry's own note, not a deck's.
 *
 * **What is never a switch** — purchase price and currency, acquired date, acquisition source —
 * is absent from the format rather than off here (plan §3.1), so no field on this struct can put
 * one on a server.
 */
export interface IntegrationFields {
  /** The copy's condition word: `NM`, `LP`, … */
  condition: boolean;
  /** The printing's language. */
  lang: boolean;
  /** The marketplace price of each copy, in the reader's chosen marketplace's currency. */
  value: boolean;
  /** The entry's free-text tags — see this interface's header. */
  tags: boolean;
  /** The entry's own note. */
  notes: boolean;
}

/**
 * What the Integrations panel draws — `grimoire_core::integration::settings::IntegrationsStatus`.
 *
 * Every command of the domain answers one, so a press draws its outcome without a second read.
 *
 * **`available` and `entitled` are the two reasons nothing can be switched, and they are not the
 * same kind of reason.** `available` is the build: the store's address is a placeholder until the
 * owner deploys the Worker (plan §2), and until then every store request is refused before it is
 * made. `entitled` is the reader: a store request carries a relay token, and the relay mints one
 * only for a device whose group has a membership (`sync_engine::commands::entitled`).
 */
export interface IntegrationsStatus {
  /** This build has a store address (or an override for `wrangler dev`). */
  available: boolean;
  /** The relay will mint this device a token — a membership covers its group. */
  entitled: boolean;
  /** The group's store exists, **as last heard** — another device may have switched it since. */
  enabled: boolean;
  /** The group's choice of columns, as last heard. Meaningful while {@link enabled}. */
  fields: IntegrationFields;
  /** Unix **seconds** the store was last asked, or `null` for never. */
  checkedAt: number | null;
  /** Unix **seconds** this device last sent a table to the store, or `null` for never. */
  publishedAt: number | null;
  /** The last publish round's failure, as a sentence, or `null` when it went through. */
  error: string | null;
  /**
   * A publish this device was asked for — by a switch-on or a change of columns — has not run
   * yet. **The press does not publish; the round does**, within one of the publish loop's polls,
   * so {@link publishedAt} moves only after this goes back to `false`. The panel asks again while
   * it is `true`, and only then: nothing else re-reads this status while the panel is open.
   */
  pending: boolean;
}

/**
 * One intent this device parks for the reader's review — `grimoire_core::integration::review::
 * ParkedIntent` (issue #1396, plan `2026-10-29-integrations-intents.md` §3.5).
 *
 * **What an integration proposed, read through this device's own card data**: `name` is this
 * device's name for the printing where it knows it, else the integration's hint, else the id —
 * the hint is never trusted for anything but drawing (plan §2). `folder` is the folder's name
 * *here*, `null` for the wishlist's root.
 *
 * `source` and `kind` are plain strings rather than closed unions: the panel only labels them,
 * with a fallback for a word it does not know, and the device — not this page — owns the list of
 * kinds it will apply (`integration::intents`' allow-list).
 */
export interface ParkedIntent {
  /** The intent's id in the store — what Apply and Decline name. */
  id: string;
  /** Which integration wrote it: `discord`, `mcp` or `trade`. */
  source: string;
  /** What it asks for: `collection.add` or `wishlist.add`. */
  kind: string;
  /** The card, by this device's name for it where it knows one. */
  name: string;
  /** The printing's set code, or `null` for an any-printing wish. */
  set: string | null;
  /** The printing's collector number. */
  cn: string | null;
  /** `nonfoil`, `foil` or `etched`; `null` for a wish with no preferred finish. */
  finish: string | null;
  /** How many copies — 1 to 99, the allow-list's bounds. */
  quantity: number;
  /** The folder's name on this device, or `null` for the wishlist's root. */
  folder: string | null;
  /** When the integration wrote it, Unix **milliseconds** — the Worker's clock. */
  createdAt: number;
  /** Who confirmed it there — `discord:123` — or `null`. */
  confirmedBy: string | null;
}

/**
 * One `(source, kind)` pair and whether this device applies it without asking —
 * `grimoire_core::integration::review::IntentAutomatic`.
 *
 * **The policy is this device's** (plan §2: a store that could flip it could make a device apply
 * what the reader never approved). Discord's two adds are `fixed` on — the reader pressed Confirm
 * in Discord — and every other pair is the reader's switch.
 */
export interface IntentAutomatic {
  source: string;
  kind: string;
  /** Applied without asking. */
  on: boolean;
  /** Not the reader's to change — Discord's two adds. */
  fixed: boolean;
}

/**
 * The review list — `grimoire_core::integration::review::IntentReview`. Every review command
 * answers one, so a press draws its outcome without a second read.
 */
export interface IntentReview {
  /** The intents this device parks, oldest first. Empty when the store cannot be asked. */
  intents: ParkedIntent[];
  /** The four `(source, kind)` rows of the policy. */
  automatic: IntentAutomatic[];
}

export const integrationCommands = {
  /**
   * The panel's state — `integrations_status`. **Asks the store when it can and answers the
   * cache when it cannot** (plan §3.3), so a read with no network still draws the last answer.
   */
  integrationsStatus: () => invoke<IntegrationsStatus>("integrations_status"),
  /**
   * Create the group's store under `fields` — `integrations_enable`. The switch's press, after
   * which every device in the group starts sending its copy on its next publish round.
   *
   * `fields` under its own name: `invoke` matches arguments by name, and a misspelt key is
   * *dropped* rather than refused — the store would be created carrying nothing the reader
   * ticked. `ipc.test.ts` pins it.
   */
  integrationsEnable: (fields: IntegrationFields) =>
    invoke<IntegrationsStatus>("integrations_enable", { fields }),
  /**
   * Change the group's columns while the store exists — `integrations_set_fields`. **The store
   * drops every table at once** (plan §2), so narrowing the choice removes a column from the
   * server before any device sends the copy again.
   */
  integrationsSetFields: (fields: IntegrationFields) =>
    invoke<IntegrationsStatus>("integrations_set_fields", { fields }),
  /**
   * Delete the group's store — `integrations_disable`. **For every device in the group**, not
   * this one: the store is the group's, and a device that hears it is gone stops sending.
   */
  integrationsDisable: () => invoke<IntegrationsStatus>("integrations_disable"),
  /**
   * The parked intents and the policy — `integrations_review`. **Asks the store**, and answers an
   * empty list with no request where it cannot be asked (no address, no membership, off).
   */
  integrationsReview: () => invoke<IntentReview>("integrations_review"),
  /**
   * Apply one parked intent now, whatever the policy says — `integrations_review_apply`: claimed,
   * checked against this device's allow-list, applied as the reader's own add, and acked. A
   * refusal by the allow-list rejects with its reason, after acking the intent refused.
   */
  integrationsReviewApply: (id: string) =>
    invoke<IntentReview>("integrations_review_apply", { id }),
  /** Decline one parked intent — `integrations_review_decline`: acked refused, nothing written. */
  integrationsReviewDecline: (id: string) =>
    invoke<IntentReview>("integrations_review_decline", { id }),
  /**
   * Whether this device applies `(source, kind)` without asking — `integrations_set_automatic`.
   * A `fixed` row refuses. Switching one on asks for a publish round, which applies what was
   * parked of that kind within one poll.
   *
   * Three arguments under their Rust names: `invoke` drops a misspelt key rather than refusing it,
   * and a dropped `on` would deserialise to nothing at all.
   */
  integrationsSetAutomatic: (source: string, kind: string, on: boolean) =>
    invoke<IntentReview>("integrations_set_automatic", { source, kind, on }),
};
