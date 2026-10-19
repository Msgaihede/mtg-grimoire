/**
 * **The one Scryfall request an add makes**: the printing it is about (the Discord spec, §14.4).
 *
 * - a set and a collector number (what the front's `set` completion hands back, `c21/263`) —
 *   `cards/{set}/{number}`;
 * - a set code typed by hand — `cards/named?exact=<name>&set=<set>`;
 * - no set — `cards/named?exact=<name>`, which is Scryfall's default printing of the card.
 *
 * **Scryfall's rules, as the front's `scryfall.ts` keeps them**: a `User-Agent` and an `Accept` on
 * every request (Cloudflare in front of the API answers 403 without), and one request for one
 * command — nothing here loops. The engine's slim corpus (`crates/grimoire-bot/src/corpus.rs`)
 * paces its own batches; this is a reader's single lookup. It runs **after** the interaction has
 * been answered (a deferred reply, `add.ts`), so its timeout is not Discord's three seconds.
 *
 * Written here rather than imported from the front: the front's package is this Worker's for
 * types only (`tsconfig.json`), so a deploy of one folder bundles nothing of the other.
 */

export const API = "https://api.scryfall.com";

/** The Discord bot's name, as Scryfall asks every client to send one — the front's, the same. */
export const USER_AGENT = "MTGGrimoire-Discord/1.0 (https://github.com/Msgaihede/mtg-grimoire)";
export const ACCEPT = "application/json";

/** Per request. The reply is deferred, so this is patience, not Discord's deadline. */
export const TIMEOUT_MS = 8000;

/** The fields of Scryfall's card object an add reads. */
export interface Printing {
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  lang: string;
  finishes: string[];
  oracle_id?: string;
  card_faces?: { oracle_id?: string }[];
}

/** What a lookup came to: the printing, no such card, or Scryfall not answering. */
export type Found = { card: Printing } | { missing: true } | { failed: true };

/** Where a printing is asked for. `set` is `null` for Scryfall's default printing. */
export interface Wanted {
  name: string;
  set: string | null;
  number: string | null;
}

/** A set option's value: `c21/263` (one printing, as the front completes it) or `c21` (a set
 *  typed by hand). `null` for anything else. */
export function parseSet(value: string): { set: string; number: string | null } | null {
  const text = value.trim();
  const printing = /^([A-Za-z0-9]{2,8})\/([^/\s]{1,16})$/.exec(text);
  if (printing !== null) return { set: printing[1].toLowerCase(), number: printing[2] };
  if (/^[A-Za-z0-9]{2,8}$/.test(text)) return { set: text.toLowerCase(), number: null };
  return null;
}

function isPrinting(value: unknown): value is Printing {
  if (typeof value !== "object" || value === null) return false;
  const card = value as Record<string, unknown>;
  return (
    card.object === "card" &&
    typeof card.id === "string" &&
    typeof card.name === "string" &&
    typeof card.set === "string" &&
    typeof card.set_name === "string" &&
    typeof card.collector_number === "string" &&
    Array.isArray(card.finishes)
  );
}

/** The path a wanted printing is asked at. */
export function pathOf(wanted: Wanted): string {
  if (wanted.set !== null && wanted.number !== null) {
    return `/cards/${encodeURIComponent(wanted.set)}/${encodeURIComponent(wanted.number)}`;
  }
  const exact = `exact=${encodeURIComponent(wanted.name.trim())}`;
  return wanted.set === null
    ? `/cards/named?${exact}`
    : `/cards/named?${exact}&set=${encodeURIComponent(wanted.set)}`;
}

/** Ask Scryfall (at `base`, its API or a local one) for the printing. Never throws. */
export async function lookup(fetcher: typeof fetch, base: string, wanted: Wanted): Promise<Found> {
  let answer: Response;
  try {
    answer = await fetcher(`${base.replace(/\/+$/, "")}${pathOf(wanted)}`, {
      headers: { "user-agent": USER_AGENT, accept: ACCEPT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { failed: true };
  }
  if (answer.status === 404) return { missing: true };
  if (!answer.ok) return { failed: true };
  try {
    const body: unknown = await answer.json();
    if (!isPrinting(body)) return { failed: true };
    return {
      card: {
        ...body,
        lang: typeof body.lang === "string" ? body.lang : "en",
        finishes: body.finishes.filter((f): f is string => typeof f === "string"),
      },
    };
  } catch {
    return { failed: true };
  }
}

/** A printing's oracle id: its own, or its first face's (a reversible card has it there). */
export function oracleOf(card: Printing): string | null {
  return card.oracle_id ?? card.card_faces?.find((face) => face.oracle_id)?.oracle_id ?? null;
}
