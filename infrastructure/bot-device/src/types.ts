/**
 * The shapes the engine answers in (`crates/grimoire-bot/src/queries.rs` and `device.rs`,
 * `serde(rename_all = "camelCase")`), and the engine's surface as this Worker uses it.
 */
import type { BotStatus, Enrolled, EnrollRefused } from "@grimoire/discord-worker/src/rpc";

/** `queries::Line`: one printing in one finish in one folder. */
export interface Line {
  quantity: number;
  setName: string | null;
  setCode: string | null;
  collectorNumber: string | null;
  finish: string | null;
  folder: string | null;
  priceUsd: number | null;
}

/** `queries::Holding`: one card, every line held, bounded. */
export interface Holding {
  name: string;
  image: string | null;
  typeLine: string | null;
  total: number;
  lines: Line[];
  /** Lines the engine left out past its own bound. */
  more: number;
}

/** `queries::Choice`. */
export interface Choice {
  name: string;
  value: string;
}

/** `queries::DeckSummary`. */
export interface DeckSummary {
  uid: string;
  name: string;
  format: string;
  cards: number;
}

/** `device::Target`: where an add goes — a collection folder's uid and path, or for a wish,
 *  `null` for both (the wishlist's root). */
export interface Target {
  uid: string | null;
  path: string | null;
}

/** `device::Advanced`: what an alarm did. */
export interface Advanced {
  nextInMs: number | null;
  purge: boolean;
  did: string;
}

/** A read's answer: `{ ok }` or `{ err }`. An add's (`target`, `add`) may also be
 *  `{ refused }`: a sentence for the reader, in the engine's own words. */
export type Answer<T> = { ok: T } | { err: string };

/**
 * The engine, as `glue.rs`'s `Bot` class is — every answer JSON text. The real one is the wasm
 * class; the tests' is `fake.ts`.
 */
export interface Engine {
  enroll(invite: string, capability: string): Promise<string>;
  advance(): Promise<string>;
  status(): string;
  collection_by_name(name: string): string;
  wishlist_by_name(name: string): string;
  names(kind: string, prefix: string, limit: number): string;
  decks(prefix: string): string;
  deck_cards(uid: string): string;
  /** `{ ok: Choice[] }` — the reader's `kind = 'user'` collection folders, value the uid. */
  folders(prefix: string, limit: number): string;
  /** `{ ok: Target } | { refused } | { err }` — where an add to `table` goes, `folder` named or
   *  `""` for the default; refused for a missing default, a folder that is not a user folder,
   *  and the day's quota. */
  target(table: string, folder: string): string;
  /** `{ ok: uid } | { refused } | { err }` — `integration::add::emit` on the add's JSON, after
   *  the folder and the quota are checked again. */
  add(add: string): string;
  close(): void;
}

export type EnrollAnswer = Enrolled | EnrollRefused;
export type { BotStatus };
