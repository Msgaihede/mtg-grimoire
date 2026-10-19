/**
 * The Scryfall requests this Worker makes: a name's completions and a card by a name typed
 * loosely, for `/card-search` (the design, §13.7 — the one command answered here, since it reads
 * nobody's data and needs no Durable Object); and **a card's printings**, for the `set` option of
 * `/collection add` and `/wishlist add`, whose `card` it completes too (§14.4). Every one of them
 * is about cards and never about a reader.
 *
 * **Every request carries a `User-Agent` and an `Accept`**, which Scryfall's API rules require
 * and Cloudflare in front of it answers 403 without — the engine's `scryfall.rs` says the same of
 * the app's own client. The API is rate limited (ten requests a second is its own figure), so
 * each answer is cached at Cloudflare's edge for a while (`cf.cacheTtl`): a reader typing a name,
 * and the next reader typing the same one, costs Scryfall one request for both.
 *
 * **Discord wants an answer within three seconds**, so every request gives up well inside that
 * ({@link TIMEOUT_MS}), and a failure is a value, never a throw: an autocomplete answers no
 * choices and a command answers a sentence.
 */

export const API = "https://api.scryfall.com";

/** This Worker's own name, as Scryfall asks every client to send one. */
export const USER_AGENT = "MTGGrimoire-Discord/1.0 (https://github.com/Msgaihede/mtg-grimoire)";
export const ACCEPT = "application/json";

/** Per request: inside Discord's three seconds with room to spare. */
export const TIMEOUT_MS = 2000;

export interface CardFace {
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  image_uris?: { normal?: string };
}

/** The fields of Scryfall's card object this Worker reads. */
export interface Card {
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  scryfall_uri: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  image_uris?: { normal?: string };
  card_faces?: CardFace[];
  prices?: { usd?: string | null; usd_foil?: string | null; usd_etched?: string | null };
}

/** What a lookup came to: the card, no such card, or Scryfall not answering in time. */
export type Lookup = { card: Card } | { missing: true } | { failed: true };

async function ask(path: string, cacheTtl: number): Promise<Response | null> {
  try {
    return await fetch(`${API}${path}`, {
      headers: { "user-agent": USER_AGENT, accept: ACCEPT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheTtl, cacheEverything: true },
    });
  } catch {
    return null;
  }
}

/**
 * Up to twenty card names that complete `query` — Scryfall's own autocomplete. **An empty list on
 * any failure**, and for fewer than two characters, which Scryfall answers with nothing anyway.
 */
export async function autocomplete(query: string): Promise<string[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const answer = await ask(`/cards/autocomplete?q=${encodeURIComponent(trimmed)}`, 86_400);
  if (answer === null || !answer.ok) return [];
  try {
    const body = (await answer.json()) as { data?: unknown };
    return Array.isArray(body.data)
      ? body.data.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

function isCard(value: unknown): value is Card {
  if (typeof value !== "object" || value === null) return false;
  const card = value as Record<string, unknown>;
  return (
    card.object === "card" &&
    typeof card.id === "string" &&
    typeof card.name === "string" &&
    typeof card.set === "string" &&
    typeof card.set_name === "string" &&
    typeof card.collector_number === "string" &&
    typeof card.scryfall_uri === "string"
  );
}

/** A card by a name typed loosely — Scryfall's `cards/named?fuzzy=`. */
export async function fuzzy(name: string): Promise<Lookup> {
  // An hour: a printing's text does not change, and its price moves once a day.
  const answer = await ask(`/cards/named?fuzzy=${encodeURIComponent(name)}`, 3_600);
  if (answer === null) return { failed: true };
  if (answer.status === 404) return { missing: true };
  if (!answer.ok) return { failed: true };
  try {
    const body: unknown = await answer.json();
    return isCard(body) ? { card: body } : { failed: true };
  } catch {
    return { failed: true };
  }
}

/** The image a card is shown with: its own, or its front face's. */
export function imageOf(card: Card): string | null {
  return card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal ?? null;
}

/** One printing, as the `set` option offers it. */
export interface Printing {
  set: string;
  setName: string;
  collectorNumber: string;
}

/**
 * **Every printing of the card called exactly `name`**, newest first — Scryfall's
 * `cards/search?q=!"<name>" unique:prints`, its first page (175 printings, more than any card
 * has but a basic land, and an autocomplete shows 25). **An empty list on any failure**, for a
 * name Scryfall does not know (its 404), and for an empty name.
 */
export async function printings(name: string): Promise<Printing[]> {
  const trimmed = name.trim();
  if (trimmed === "") return [];
  const q = `!"${trimmed.replace(/"/g, "")}" unique:prints`;
  // A day: a set is not reprinted into, and a new one is a day's news at most.
  const answer = await ask(
    `/cards/search?q=${encodeURIComponent(q)}&order=released&dir=desc`,
    86_400,
  );
  if (answer === null || !answer.ok) return [];
  try {
    const body = (await answer.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return [];
    return body.data.filter(isCard).map((card) => ({
      set: card.set,
      setName: card.set_name,
      collectorNumber: card.collector_number,
    }));
  } catch {
    return [];
  }
}
