/**
 * Deck validation, part one: how big the deck is, how many copies of a card it holds, and
 * whether the format's card pool admits them.
 *
 * **Every rule below is read from data.** There is no `if (format === "vintage")` in this
 * file and there must never be one: the sizes and copy limits come from the seeded
 * `format_specs` row, the pool comes from each card's own `legalities` blob, what
 * `"restricted"` *means* comes from `restrictedSemantic` (TRAP A — max one copy in Vintage,
 * banned as a commander in Duel Commander), whether a format is judged against a pool at
 * all comes from `hasLegalityData`, and the mana-value ceiling comes from `maxManaValue`.
 * A new format is a seeded row; a rules change is an UPDATE. That is the whole design, and
 * a single format key compared here would quietly end it.
 *
 * Two zones behave unlike the rest, both by design and both handled once, at the top:
 *
 * * **`maybe` counts toward nothing at all** — not size, not copies, not legality. It is a
 *   scratchpad, and the allocator does not even claim copies for it.
 * * **`companion` counts toward no deck size** (EDH's is "effectively a 101st card"). Where
 *   the format has a real sideboard it occupies one of its slots; where `sideboardMax` is 0
 *   it is simply an extra card — which is read from that cell rather than from a key, so
 *   Commander, the three Brawls, Oathbreaker, PDH, Duel and PreDH all come out right
 *   together. Whether the card may be a companion at all is Task 10's.
 *
 * Commander eligibility, partners and colour identity are Task 9's; companion conditions
 * and the bracket advisory are Task 10's. This file knows nothing about any of them.
 */
import type { DeckZone, FormatSpec } from "@/lib/ipc";
import type { CardFacts, ValidationIssue } from "./types";
import { copyException, isBasicLand } from "./singleton";

/** The zones `deckMin`/`deckMax` count together — "exactly 100 **incl cmdr**", "exactly 60
 *  incl Oathbreaker + signature spell" (both of those live in the `commander` zone). */
const SIZE_ZONES: readonly DeckZone[] = ["main", "commander"];

/**
 * The zones a copy limit counts together.
 *
 * `main` + `side` is CR 100.4a — a sideboard's copies count toward the same four. The
 * commander is one of the 100 (CR 903.5b), so a card in the commander zone *and* in the
 * main deck is two copies of it, which a singleton format has to hear about. The companion
 * is left out because it is judged with the deck rather than inside it (Task 10 runs the
 * singleton rule over `[...deck, companion]` for exactly that reason).
 */
const COPY_ZONES: readonly DeckZone[] = ["main", "side", "commander"];

/**
 * Everything wrong with this deck under this format, worst-first by rule rather than by
 * severity: the deck's own shape (size, sideboard), then its copy counts, then each card in
 * the order the read returned it.
 *
 * Pure and total. It never throws — a malformed `legalities` blob or a row whose printing
 * has left the database produces a *warning*, because a validator that crashes on bad data
 * is a validator that hides the deck it was asked about.
 */
export function validateDeck(cards: CardFacts[], spec: FormatSpec): ValidationIssue[] {
  // The scratchpad is dropped once, here, so no rule below has to remember it exists.
  const deck = cards.filter((card) => card.zone !== "maybe");
  const legalities = readLegalities(deck);
  return [
    ...deckSizeIssues(deck, spec),
    ...sideboardIssues(deck, spec),
    ...copyIssues(deck, spec, legalities),
    ...cardIssues(deck, spec, legalities),
  ];
}

/**
 * Copies of this card allowed under this spec: `Infinity` for basic lands and for the cards
 * whose own text permits any number, the printed count for the "up to N" cards, and the
 * format's `maxCopies` otherwise (`null` there means unlimited — the two pseudo-formats).
 *
 * `restricted` is **not** folded in: what that word means is a property of the format, not
 * of the card, and reading it needs the legality blob. {@link validateDeck} applies it.
 */
export function copyLimitFor(card: CardFacts, spec: FormatSpec): number {
  if (isBasicLand(card.typeLine)) return Infinity;
  const exception = copyException(card.oracleText);
  if (exception !== null) return exception;
  return spec.maxCopies ?? Infinity;
}

/**
 * The mana value of a printed cost: `{2}{U}` is 3, `{X}` is 0 (CR 202.3b — X is zero
 * everywhere but on the stack), a hybrid counts once and a twobrid counts its generic half
 * (`{2/W}` is 2).
 *
 * Exported because Task 15's curve needs the same arithmetic and two implementations of it
 * would eventually disagree about a card.
 */
export function manaValueOf(cost: string | null): number {
  if (!cost) return 0;
  let total = 0;
  for (const symbol of cost.matchAll(/\{([^}]*)\}/g)) total += symbolValue(symbol[1]);
  return total;
}

/** One brace-less symbol's contribution. Anything unrecognised is one mana, which is what a
 *  coloured, snow, colourless or Phyrexian symbol costs. */
function symbolValue(token: string): number {
  // A hybrid is paid one way or the other; its mana value is the greater half.
  if (token.includes("/")) return Math.max(...token.split("/").map(symbolValue));
  const upper = token.toUpperCase();
  if (upper === "X" || upper === "Y" || upper === "Z") return 0;
  if (token === "½") return 0.5;
  const generic = Number(token);
  return Number.isFinite(generic) ? generic : 1;
}

// ---------------------------------------------------------------------------------------
// Legalities: parsed once per deck, read many times.
// ---------------------------------------------------------------------------------------

/** What a card's blob says about one format, or why it says nothing. */
type LegalityRead =
  | { kind: "status"; status: string }
  /** No blob, or a blob with no key for this format — the format's list does not mention it. */
  | { kind: "missing" }
  /** A blob that is not a JSON object. Evidence of nothing, so never a verdict. */
  | { kind: "unreadable" };

/**
 * `legalities` is a **JSON object string** and is parsed exactly once per row here — unlike
 * `colors`/`colorIdentity`, which are concatenated letters (`"WU"`) and would throw.
 *
 * Keyed by the row object: a deck read hands out one object per row, and two rows of the
 * same printing in two zones are two objects with two blobs (which is what makes Old School
 * work per printing).
 */
function readLegalities(deck: CardFacts[]): Map<CardFacts, Record<string, string> | null> {
  const parsed = new Map<CardFacts, Record<string, string> | null>();
  for (const card of deck) {
    if (card.legalities === null) continue;
    try {
      const blob: unknown = JSON.parse(card.legalities);
      parsed.set(
        card,
        blob !== null && typeof blob === "object" && !Array.isArray(blob)
          ? (blob as Record<string, string>)
          : null,
      );
    } catch {
      parsed.set(card, null);
    }
  }
  return parsed;
}

function legalityOf(
  card: CardFacts,
  spec: FormatSpec,
  legalities: Map<CardFacts, Record<string, string> | null>,
): LegalityRead {
  if (!legalities.has(card)) return { kind: "missing" };
  const blob = legalities.get(card);
  if (!blob) return { kind: "unreadable" };
  const status = blob[spec.key];
  return typeof status === "string" ? { kind: "status", status } : { kind: "missing" };
}

// ---------------------------------------------------------------------------------------
// The rules.
// ---------------------------------------------------------------------------------------

function quantityIn(deck: CardFacts[], zones: readonly DeckZone[]): number {
  return deck.reduce((n, card) => (zones.includes(card.zone) ? n + card.quantity : n), 0);
}

function deckSizeIssues(deck: CardFacts[], spec: FormatSpec): ValidationIssue[] {
  const size = quantityIn(deck, SIZE_ZONES);
  const { deckMin: min, deckMax: max, displayName } = spec;

  // An exactly-sized format is wrong in both directions, and says so in one sentence.
  if (max !== null && min === max) {
    if (size === max) return [];
    const including = spec.requiresCommander ? " including the commander" : "";
    return [
      error(
        "deck-size",
        `${displayName} decks are exactly ${max} cards${including}; you have ${size}.`,
      ),
    ];
  }
  if (size < min) {
    return [
      error("deck-size", `${displayName} decks need at least ${min} cards; you have ${size}.`),
    ];
  }
  // CR 100.5: most formats have no maximum at all, which is what `deckMax` NULL means.
  if (max !== null && size > max) {
    return [error("deck-size", `${displayName} decks are at most ${max} cards; you have ${size}.`)];
  }
  return [];
}

function sideboardIssues(deck: CardFacts[], spec: FormatSpec): ValidationIssue[] {
  const cap = spec.sideboardMax;
  // NULL is *uncapped* — Limited plays the rest of its pool, Casual caps nothing.
  if (cap === null) return [];

  // A companion takes a sideboard slot only where there is a sideboard to take one from.
  const companions = cap > 0 ? quantityIn(deck, ["companion"]) : 0;
  const size = quantityIn(deck, ["side"]) + companions;
  if (cap === 0) {
    return size > 0
      ? [error("sideboard-size", `${spec.displayName} decks have no sideboard.`)]
      : [];
  }
  return size > cap
    ? [error("sideboard-size", `Sideboards are capped at ${cap} cards; you have ${size}.`)]
    : [];
}

/** Every row of one card, wherever in the deck it sits. */
interface CopyGroup {
  name: string;
  quantity: number;
  cardIds: string[];
  rows: CardFacts[];
}

/**
 * Grouped by `oracleId`, falling back to the row's denormalized `name` — which is what an
 * orphaned row still has, and the only way two orphans of the same card are one card.
 */
function groupCopies(deck: CardFacts[]): CopyGroup[] {
  const groups = new Map<string, CopyGroup>();
  for (const card of deck) {
    if (!COPY_ZONES.includes(card.zone)) continue;
    const key = card.oracleId ?? card.name;
    const group = groups.get(key) ?? { name: card.name, quantity: 0, cardIds: [], rows: [] };
    group.quantity += card.quantity;
    if (!group.cardIds.includes(card.cardId)) group.cardIds.push(card.cardId);
    group.rows.push(card);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function copyIssues(
  deck: CardFacts[],
  spec: FormatSpec,
  legalities: Map<CardFacts, Record<string, string> | null>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const group of groupCopies(deck)) {
    // TRAP A: `restricted` is one copy only where the format says that is what it means.
    // Where it means *banned as a commander* (duel, tlr) the main deck hears nothing —
    // Task 9 judges the commander zone. Any printing saying so speaks for the card.
    const restricted =
      spec.hasLegalityData &&
      spec.restrictedSemantic === "max_one" &&
      group.rows.some((row) => statusOf(row, spec, legalities) === "restricted");

    const printed = printedException(group.rows);
    const limit = restricted ? 1 : Math.max(...group.rows.map((row) => copyLimitFor(row, spec)));
    if (group.quantity <= limit) continue;

    const { name, quantity, cardIds } = group;
    if (restricted) {
      issues.push(
        error(
          "restricted",
          `${name} is restricted in ${spec.displayName}: max 1 copy; you have ${quantity}.`,
          cardIds,
        ),
      );
    } else if (printed !== null && printed === limit) {
      issues.push(
        error(
          "copy-limit",
          `${name} allows up to ${limit} copies by its own text; you have ${quantity}.`,
          cardIds,
        ),
      );
    } else if (spec.singleton && limit === 1) {
      issues.push(
        error(
          "singleton",
          `${spec.displayName} decks are singleton: max 1 copy of ${name}; you have ${quantity}.`,
          cardIds,
        ),
      );
    } else {
      issues.push(
        error(
          "copy-limit",
          `${spec.displayName} decks allow up to ${limit} copies of ${name}; you have ${quantity}.`,
          cardIds,
        ),
      );
    }
  }
  return issues;
}

function statusOf(
  card: CardFacts,
  spec: FormatSpec,
  legalities: Map<CardFacts, Record<string, string> | null>,
): string | null {
  const read = legalityOf(card, spec, legalities);
  return read.kind === "status" ? read.status : null;
}

/** The largest count the group's own text permits, or `null` if none of it says anything.
 *  Read across the rows so one orphaned printing cannot cancel the card's own permission. */
function printedException(rows: CardFacts[]): number | null {
  let printed: number | null = null;
  for (const row of rows) {
    const exception = copyException(row.oracleText);
    if (exception !== null && (printed === null || exception > printed)) printed = exception;
  }
  return printed;
}

/** Per-row: legality against the format's pool, and the per-card mana-value ceiling. */
function cardIssues(
  deck: CardFacts[],
  spec: FormatSpec,
  legalities: Map<CardFacts, Record<string, string> | null>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const card of deck) {
    // A row whose printing has left the card database has no facts to judge. It gets the
    // reconciler's own sentence — never a legality guess, and never a mana value it does
    // not have. It still counts toward deck size: it is a card in the deck.
    if (isOrphan(card)) {
      issues.push({
        severity: "warning",
        code: "orphan",
        message: card.needsReview
          ? `${card.name}: ${card.needsReview}`
          : `${card.name} is not in the card database, so it was not checked against ` +
            `${spec.displayName}'s rules.`,
        cardIds: [card.cardId],
      });
      continue;
    }
    if (spec.hasLegalityData) issues.push(...legalityIssues(card, spec, legalities));
    const manaValue = manaValueIssue(card, spec);
    if (manaValue) issues.push(manaValue);
  }
  return issues;
}

/**
 * Every card fact null together — the deck read is a `LEFT JOIN` and this is what a miss
 * looks like.
 *
 * Four columns rather than one: `layout` and `rarity` are non-null on every Scryfall
 * object, `legalities` is a blob every card has, and `oracleId` is null on no live row
 * (0 of 116,590). One of them null is a card; all four null is no card at all.
 */
function isOrphan(card: CardFacts): boolean {
  return (
    card.layout === null &&
    card.rarity === null &&
    card.legalities === null &&
    card.oracleId === null
  );
}

function legalityIssues(
  card: CardFacts,
  spec: FormatSpec,
  legalities: Map<CardFacts, Record<string, string> | null>,
): ValidationIssue[] {
  const read = legalityOf(card, spec, legalities);
  const { name } = card;
  const format = spec.displayName;
  if (read.kind === "unreadable") {
    return [warning("unknown-legality", `${name}'s ${format} legality could not be read.`, card)];
  }
  // A list that does not mention a card is a pool that does not contain it.
  if (read.kind === "missing") {
    return [error("not-legal", `${name} is not legal in ${format}.`, [card.cardId])];
  }
  switch (read.status) {
    case "legal":
      return [];
    // Both meanings of `restricted` are somebody else's: max-one is a copy count (above),
    // banned-as-commander is a commander-zone rule (Task 9).
    case "restricted":
      return [];
    case "banned":
      return [error("banned", `${name} is banned in ${format}.`, [card.cardId])];
    case "not_legal":
      return [error("not-legal", `${name} is not legal in ${format}.`, [card.cardId])];
    default:
      return [
        warning(
          "unknown-legality",
          `${name}'s ${format} legality is "${read.status}", which this app does not know.`,
          card,
        ),
      ];
  }
}

/**
 * Tiny Leaders' ceiling, and the one rule that reads `faces`: "every card **and every
 * face**" (research doc). An adventure's or a modal double-faced card's halves carry their
 * own costs, and Scryfall's top-level `cmc` is the front face's — so a card that is legal
 * on its own number can still have a face that is not.
 */
function manaValueIssue(card: CardFacts, spec: FormatSpec): ValidationIssue | null {
  const cap = spec.maxManaValue;
  if (cap === null) return null;
  const own = ownManaValue(card);
  const face = faceManaValue(card);
  const worst = Math.max(own ?? Number.NEGATIVE_INFINITY, face ?? Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(worst) || worst <= cap) return null;

  const capped = `${spec.displayName} caps every card and every face at ${cap}.`;
  return face !== null && face > (own ?? Number.NEGATIVE_INFINITY)
    ? error("mana-value", `${card.name} has a face with mana value ${face}; ${capped}`, [
        card.cardId,
      ])
    : error("mana-value", `${card.name} has mana value ${worst}; ${capped}`, [card.cardId]);
}

/** The card's own mana value, computed from the printed cost when the column is null. */
function ownManaValue(card: CardFacts): number | null {
  if (card.cmc !== null) return card.cmc;
  return card.manaCost === null ? null : manaValueOf(card.manaCost);
}

/** The largest mana value among the card's faces, or `null` for a single-faced card.
 *  A face carries its own `cmc` only on reversible cards; everywhere else it is the cost. */
function faceManaValue(card: CardFacts): number | null {
  if (!card.faces) return null;
  let faces: unknown;
  try {
    faces = JSON.parse(card.faces);
  } catch {
    return null;
  }
  if (!Array.isArray(faces)) return null;
  let worst: number | null = null;
  for (const face of faces as Record<string, unknown>[]) {
    if (face === null || typeof face !== "object") continue;
    const value =
      typeof face.cmc === "number"
        ? face.cmc
        : typeof face.mana_cost === "string"
          ? manaValueOf(face.mana_cost)
          : null;
    if (value !== null && (worst === null || value > worst)) worst = value;
  }
  return worst;
}

function error(code: string, message: string, cardIds?: string[]): ValidationIssue {
  return cardIds
    ? { severity: "error", code, message, cardIds }
    : { severity: "error", code, message };
}

function warning(code: string, message: string, card: CardFacts): ValidationIssue {
  return { severity: "warning", code, message, cardIds: [card.cardId] };
}
