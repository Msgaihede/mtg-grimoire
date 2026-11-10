import type { DraftCard, DraftDeckCard } from "@/lib/ipc";
import { autoCategoryFor } from "@/features/decks/autoCategory";

/**
 * **Deck or sideboard** (issue #1471): where each picked card goes, decided while picking and
 * changed until the deck is built — MTG Arena's arrangement, which the reporter pointed at.
 *
 * **A pick goes to the deck unless the reader says sideboard.** The page holds the cards on the
 * sideboard, by `instanceId`, and every other card in the pool is the deck's. The engine never
 * hears of it: the draft is the same draft wherever a card is laid, so the split is the page's
 * conclusion and is handed over only once, when the deck is built (`toDraftDeck`).
 *
 * **Kept per device in `localStorage`** (`packs/marketplaces.ts`' arrangement): a solo draft is
 * resumed after a restart from the host's saved copy, and the split it was being sorted into comes
 * back with it. One draft is in hand at a time, so one row; it is emptied when a draft starts with
 * an empty pool, on every new deal (a Sealed pool's first view holds the whole pool, and its
 * instance ids — seat 0, rounds 0–5 — repeat across drafts, issue #1588) and when a draft is put
 * away, the hub's Abandon included. A host that refuses the store keeps it for the session.
 *
 * **No IPC here, deliberately**: `test-setup.ts` loads this module for `resetSideboard` before any
 * suite mocks `@/lib/ipc`, so a call made from here would reach the real one. The Build step's tag
 * read is `BuildPanel`'s.
 */
export type Destination = "deck" | "sideboard";

const STORAGE_KEY = "draft.sideboard";

/** The session's copy, for a host that refuses the store. */
let fallback: string[] = [];

function parse(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return null;
  }
}

/** The cards on the sideboard, as last kept. */
export function recallSideboard(): string[] {
  try {
    return parse(window.localStorage.getItem(STORAGE_KEY)) ?? [...fallback];
  } catch {
    return [...fallback];
  }
}

/** Keep `ids` as the cards on the sideboard. */
export function keepSideboard(ids: readonly string[]): void {
  fallback = [...ids];
  try {
    if (ids.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Kept for the session.
  }
}

/** Forget the split — a draft put away, and a fresh device's state for tests and stories. */
export function resetSideboard(): void {
  keepSideboard([]);
}

/** The sideboard after `ids` are sent to `to` — added once, or taken off. */
export function sendTo(
  sideboard: readonly string[],
  ids: readonly string[],
  to: Destination,
): string[] {
  if (to === "deck") return sideboard.filter((id) => !ids.includes(id));
  return [...sideboard, ...ids.filter((id) => !sideboard.includes(id))];
}

/** The pool split in two, each half in pick order. */
export function splitPool(
  pool: readonly DraftCard[],
  sideboard: readonly string[],
): { deck: DraftCard[]; sideboard: DraftCard[] } {
  const side = new Set(sideboard);
  const out = { deck: [] as DraftCard[], sideboard: [] as DraftCard[] };
  for (const card of pool) (side.has(card.instanceId) ? out.sideboard : out.deck).push(card);
  return out;
}

/**
 * The split as `draft_deck_create` takes it: the sideboard's printing ids for the deck's Pool, and
 * each deck card with the pile **the add path's own rule** files it into (`autoCategoryFor` — by
 * what it does where its Oracle tags are known, by its type line where they are not). `tags` is
 * the slugs per printing id, already expanded to their ancestors; a printing missing from it is
 * filed by its type line, the rule's supported floor.
 */
export function toDraftDeck(
  split: { deck: readonly DraftCard[]; sideboard: readonly DraftCard[] },
  tags: ReadonlyMap<string, readonly string[]>,
): { cardIds: string[]; deck: DraftDeckCard[] } {
  return {
    cardIds: split.sideboard.map((c) => c.cardId),
    deck: split.deck.map((c) => ({
      cardId: c.cardId,
      pile: autoCategoryFor({ typeLine: c.typeLine, oracleTags: tags.get(c.cardId) ?? [] }),
    })),
  };
}
