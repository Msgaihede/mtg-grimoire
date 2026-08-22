/**
 * Which cards MTG Arena actually has, for the Arena export's filter.
 *
 * Issue #192: an Arena decklist naming a card Arena has never printed is a line the game
 * cannot resolve, and a paper collection is mostly such cards. The dialog offers to leave them
 * out; this file is the whole of what "them" means.
 *
 * **Pure, like everything else in `export/` — no React, no hook, no IPC.** The one fact it
 * reads is `TransferCard.legalities`, the printing's own blob, which all three surfaces now
 * carry (`src-tauri`'s `CollectionRow` and `WishRow` gained it for this; `DeckCard` already
 * had it). Rust supplies the blob, this draws the conclusion — the repo's boundary, kept.
 *
 * ## Why legality answers a question about availability
 *
 * The obvious fact to reach for is Scryfall's `games`, which literally lists `arena`. **It is
 * the wrong one, and wrong in the direction that matters**: `games` is a property of a
 * *printing*, not of a card. The Alpha printing of Lightning Bolt says `["paper"]` while the
 * card itself is in Arena's Timeless pool, so a `games`-based filter would throw out a paper
 * collection almost entirely. Legality is the oracle-level fact hiding inside a printing-level
 * blob: measured over the 116,712-printing corpus on **2026-08-22**, exactly **0** oracle cards
 * had printings that disagreed about any key in {@link ARENA_LEGALITY_KEYS}, so the paper
 * printing's blob answers for the card.
 *
 * ## What the key list is, and the one key that is not in it
 *
 * The rule is "a format Arena runs", and this app already writes that down once —
 * `format_specs.games`, seeded in Rust, whose cell says `arena` for exactly nine formats with
 * legality data. Eight of them are below. **`gladiator` is the ninth and is deliberately
 * excluded**, and it is the entry most likely to be helpfully restored by someone reading the
 * seed: Gladiator genuinely is an Arena format, but Scryfall's `gladiator` legality is not
 * computed from Arena's pool — it marks paper-only cards such as Grand Coliseum, Exotic Orchard
 * and Together Forever `legal`. On the corpus above, `gladiator` alone accounted for **all 37**
 * of the cards a nine-key list kept that have no Arena printing at all; the eight keys below
 * keep **0**. The exclusion is about Scryfall's data, not about the format, which is why it
 * cannot be read off the seed and has to live here.
 *
 * ## What it costs
 *
 * Against "has an Arena printing" (16,219 oracle cards), these eight keys match 15,973 — they
 * keep nothing Arena lacks, and drop 246 cards Arena has: tokens, and Arena-exclusives such as
 * Alchemy Horizons: Baldur's Gate's own cards, which Scryfall records as playable in no format
 * at all. Both halves of the issue's wording are served by that — a card legal nowhere in Arena
 * is one an Arena decklist should not name either — and a token is not a decklist line.
 */
import type { TransferCard } from "../TransferCard";

/**
 * Scryfall `legalities` keys for the formats MTG Arena runs.
 *
 * **Names, never bit positions.** `src-tauri/src/legalities.rs` packs these same keys into
 * `cards.legal_mask` at frozen, append-only bit offsets that are *stored data*; a copy of that
 * order over here would be a second place for it to drift, and a wrong bit reads as a plausible
 * legality rather than as a crash. A key name is Scryfall's public vocabulary and cannot drift.
 *
 * Alphabetical, and the order carries no meaning — {@link isInArena} asks whether *any* of them
 * is playable. See the module docs for where the list comes from and why `gladiator` is not on
 * it.
 */
export const ARENA_LEGALITY_KEYS: readonly string[] = [
  "alchemy",
  "brawl",
  "competitivebrawl",
  "future",
  "historic",
  "standard",
  "standardbrawl",
  "timeless",
];

/**
 * The values that count as playable — `src-tauri/src/legalities.rs`' `PLAYABLE`, spelled the
 * same way for the same reason.
 *
 * `restricted` is playable: a restricted card is one you may run one of, which is a copy-count
 * rule rather than a statement that Arena does not have the card. `banned` is **not** here, and
 * that is the deliberate half — a card banned in every Arena format is one this filter drops,
 * which is the issue's "not legal" arm. A card banned in one Arena format and legal in another
 * (Lightning Bolt: `historic` banned, `timeless` legal) survives, because it is in Arena.
 */
const PLAYABLE: ReadonlySet<string> = new Set(["legal", "restricted"]);

/**
 * Whether MTG Arena has this card at all.
 *
 * **An unreadable blob answers `false`**, and the two ways one happens are worth telling apart.
 * `null` is an orphan — the printing has left `cards`, so the row has no set code and no
 * collector number either and would export as a bare name. Unparseable is a corrupt blob, which
 * nothing has ever produced. Neither is a card this function can say Arena has, and the
 * checkbox's promise is *only* cards it can: the dialog's count line is what keeps that from
 * being silent, so a reader who disagrees can see the number and switch the filter off.
 *
 * That is the opposite of what the deck validator does with the same unreadable blob — it warns
 * and judges nothing (`validation/engine.ts`' `unknown-legality`) — and the difference is that a
 * warning has somewhere to go there. Here the only two answers are "written" and "not written".
 */
export function isInArena(card: TransferCard): boolean {
  if (card.legalities === null) return false;
  let blob: unknown;
  try {
    blob = JSON.parse(card.legalities);
  } catch {
    return false;
  }
  if (typeof blob !== "object" || blob === null) return false;
  const legalities = blob as Record<string, unknown>;
  return ARENA_LEGALITY_KEYS.some((key) => {
    const status = legalities[key];
    return typeof status === "string" && PLAYABLE.has(status);
  });
}

/**
 * How many **copies** the filter would leave out — the number the dialog says out loud.
 *
 * Copies rather than rows, for `omittedCount`'s reason one file over: four copies of one card
 * on one row are four cards missing from the file, and a reader checking a 60-card list against
 * what came out counts cards.
 */
export function notInArenaCopies(cards: readonly TransferCard[]): number {
  return cards.reduce((total, card) => (isInArena(card) ? total : total + card.quantity), 0);
}
