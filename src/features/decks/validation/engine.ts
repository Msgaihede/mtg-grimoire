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
 * Two things behave unlike the rest, both by design and both handled once, at the top:
 *
 * * **A card in an inactive category counts toward nothing at all** — not size, not copies,
 *   not legality. Schema v7 made that a switch on the *category* rather than a fixed word on
 *   the card: the Maybeboard is simply the predefined category seeded off, a category of the
 *   user's own that they switch off behaves identically, and a Maybeboard they switch on
 *   counts like anything else. The Rust allocator makes the same read (`cat.is_active = 1`),
 *   so "counts toward nothing" and "reserves no copy of anything" cannot come apart.
 * * **The `companion` kind counts toward no deck size** (EDH's is "effectively a 101st card")
 *   but toward every copy limit. Where the format has a real sideboard it occupies one of its
 *   slots; where `sideboardMax` is 0 it is simply an extra card — which is read from that
 *   cell rather than from a key, so Commander, the three Brawls, Oathbreaker, PDH, Duel,
 *   PreDH and Gladiator all come out right together. (Gladiator is the one of those that also
 *   has `allowsCompanion` false — no sideboard, so no companion at all — and refusing the
 *   card is `companions.ts`'s job, not this file's sideboard arithmetic.)
 *
 * Commander eligibility, partners and colour identity live in `commanders.ts`; the ten
 * companion conditions live in `companions.ts`. Both are called from the bottom of this file.
 * The bracket advisory is in `bracket.ts` and is not called from here at all — it is an
 * estimate rather than a finding, and nothing about it belongs in a list of what is wrong.
 */
import type { CategoryKind, FormatSpec } from "@/lib/ipc";
import type { CardFacts, ValidationIssue } from "./types";
import { copyException, isBasicLand, unreadableCopyCount } from "./singleton";
import { colorIdentityIssues, commanderIdentity, validateCommanderZone } from "./commanders";
import { companionIssues } from "./companions";

/**
 * The category kinds `deckMin`/`deckMax` count together — "exactly 100 **incl cmdr**",
 * "exactly 60 incl Oathbreaker + signature spell" (both of those live in a `commander`
 * category).
 *
 * Kinds and not categories, because a deck may own any number of `main` categories — the user
 * names and orders them — and a size rule that had to be told about each one would be a rule
 * the user could break by making a pile. What a card is *for* is the kind; what it is *called*
 * is theirs.
 *
 * Exported because the deck editor's stats strip prints the same total beside this file's
 * sentence about it: "Modern decks need at least 60 cards; you have 59" under a headline
 * figure counting the sideboard too is two numbers for one question. Reading one query is not
 * enough to make two surfaces agree — they have to read one definition.
 */
export const SIZE_KINDS: readonly CategoryKind[] = ["main", "commander"];

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
  // Everything that counts toward nothing is dropped once, here, so no rule below has to
  // remember it exists. One flag rather than the old `zone !== "maybe"`, and that is the whole
  // of schema v7 in this file: the Maybeboard is the predefined category seeded off, and a
  // pile of the user's own that they switched off leaves by the same line.
  const deck = cards.filter((card) => card.categoryActive);
  const legalities = readLegalities(deck);
  return collapse([
    ...deckSizeIssues(deck, spec),
    ...sideboardIssues(deck, spec),
    ...copyIssues(deck, spec, legalities),
    ...cardIssues(deck, spec, legalities),
    ...commanderIssues(deck, spec),
    ...companionIssues(
      deck.filter((card) => card.categoryKind === "companion"),
      deck,
      spec,
    ),
  ]);
}

/**
 * One sentence, one finding.
 *
 * The per-card pass runs over **rows**, and one card is usually several: the same printing in
 * the main deck and in the sideboard, or two printings of one card that is banned either way.
 * Saying "Lightning Bolt is banned in Modern." twice reads as two problems, so identical
 * `(code, message)` pairs collapse into the first of them and it takes every row's
 * `cardId` with it — the panel highlights all of them from one line.
 *
 * Sentences that genuinely differ stay apart, which is what keeps Old School honest: two
 * printings of one card are one answer when they agree and two when they do not.
 */
function collapse(issues: ValidationIssue[]): ValidationIssue[] {
  const first = new Map<string, ValidationIssue>();
  const kept: ValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}\u0000${issue.message}`;
    const seen = first.get(key);
    if (!seen) {
      first.set(key, issue);
      kept.push(issue);
      continue;
    }
    // Only rows merge. An issue about the deck itself carries no ids and gains none.
    if (!seen.cardIds || !issue.cardIds) continue;
    seen.cardIds = [...new Set([...seen.cardIds, ...issue.cardIds])];
  }
  return kept;
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
 * same printing in two categories are two objects with two blobs (which is what makes Old
 * School work per printing).
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

function quantityIn(deck: CardFacts[], kinds: readonly CategoryKind[]): number {
  return deck.reduce((n, card) => (kinds.includes(card.categoryKind) ? n + card.quantity : n), 0);
}

function deckSizeIssues(deck: CardFacts[], spec: FormatSpec): ValidationIssue[] {
  const size = quantityIn(deck, SIZE_KINDS);
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
 *
 * **It counts every row it is handed, and there is no list here on purpose.** Until schema v7
 * this filtered a `COPY_ZONES` constant whose entire content was "every zone but the
 * scratchpad", and that exclusion is now {@link validateDeck}'s first line — one step earlier
 * and asked of the *category*. Writing the four kinds out again here would put the special
 * case back as something no user could switch off: a `main` category they had turned off would
 * have its copies counted, which is exactly the bug the category model exists to remove.
 *
 * The reasoning that constant carried is still true, and is why nothing narrower belongs here
 * either:
 *
 * * `main` + `side` is CR 100.4a — a sideboard's copies count toward the same four.
 * * The commander is in because CR 903.5b's rule ("with the exception of basic lands, each
 *   card in a Commander deck must have a different English name") is about the *deck*, and the
 *   commander is one of its cards — 903.5a is what puts it there ("exactly 100 cards, including
 *   its commander"). So a card in the command zone *and* in the main deck is two copies of it,
 *   which a singleton format has to hear about.
 * * The companion is in for the same reason under either shape the formats give it. Where the
 *   format has a real sideboard the companion occupies one of its slots, and 100.4a counts
 *   those; where it has none, the research doc calls the companion "effectively a 101st card"
 *   and 903.5b counts that. So a deck holding Lurrus as its companion **and** in the 99 is
 *   holding two Lurruses, and the one place in this file that counts cards is the place that
 *   says so. It is deliberately *not* in {@link SIZE_KINDS}: a companion is not a card of the
 *   starting deck, and counting it there would make every companion deck one card too big.
 *
 * **Hand-off to Plan 5's importer:** because the companion counts here, an import must file a
 * companion into **either** a `side` category **or** a `companion` one and never both. Arena's
 * own export lists the card twice — its `Companion` section repeats it in `Sideboard` (research
 * doc, deck-text formats) — and a parser that copies both sections literally would hand this
 * function two rows for one card and manufacture a copy-limit error out of one Lurrus.
 */
function groupCopies(deck: CardFacts[]): CopyGroup[] {
  const groups = new Map<string, CopyGroup>();
  for (const card of deck) {
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
    const { name, quantity, cardIds } = group;

    if (group.quantity <= limit) {
      // A card whose printed count this app could not read was just let past a limit it
      // might not actually clear (`copyException` answers Infinity rather than reporting an
      // error the card's own text contradicts). Say so — but only where the unread clause
      // is doing work, which is when the format would otherwise have complained.
      const unreadable = unreadableCount(group.rows);
      const withoutClause = spec.maxCopies ?? Infinity;
      if (unreadable !== null && !restricted && quantity > withoutClause) {
        issues.push({
          severity: "warning",
          code: "unknown-copy-limit",
          message:
            `${name}'s text allows up to "${unreadable}" copies, a number this app cannot ` +
            `read; its ${quantity} copies were not checked.`,
          cardIds,
        });
      }
      continue;
    }

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

/** The unreadable printed count from whichever row carries one, or `null`. Read across the
 *  rows for the same reason {@link printedException} is: an orphan has no text. */
function unreadableCount(rows: CardFacts[]): string | null {
  for (const row of rows) {
    const printed = unreadableCopyCount(row.oracleText);
    if (printed !== null) return printed;
  }
  return null;
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
 *
 * Exported so `companions.ts` skips the same rows this file does — a second answer to "is
 * there a card here" would eventually disagree, and the disagreement would show up as a
 * companion condition accusing a row the reconciler has already explained.
 */
export function isOrphan(card: CardFacts): boolean {
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
    return outsidePoolIssues(card, spec);
  }
  switch (read.status) {
    case "legal":
      return [];
    // Both meanings of `restricted` are somebody else's: max-one is a copy count (above),
    // banned-as-commander is a commander-zone rule (`commanders.ts`).
    case "restricted":
      return [];
    case "banned":
      return [error("banned", `${name} is banned in ${format}.`, [card.cardId])];
    case "not_legal":
      return outsidePoolIssues(card, spec);
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
 * "This card is not in the format's pool" — one sentence with one exception, and the
 * exception is TRAP C.
 *
 * `paupercommander` answers for the **99**, which are commons: every uncommon reads
 * `not_legal` there, and a Pauper Commander commander must be uncommon. So the key genuinely
 * says nothing about the card in the commander zone, and reporting it would make every legal
 * PDH deck accuse its own commander. Rarity judges that card instead
 * (`commanderIneligibility` under the `pdh` rule), and a `banned` still speaks — it is only
 * the pool answer that is being ignored, not the ban list.
 *
 * **The exemption is the best available answer, not a precise one.** The key cannot tell TRAP C
 * apart from a genuine exclusion: an uncommon that Pauper Commander really does not admit and
 * an uncommon that is `not_legal` only because it is not a common are the same `"not_legal"`
 * string. Suppressing it costs the second case and buys the first, and the first is every legal
 * PDH deck ever built — so it is suppressed, and this comment is the record of what that costs.
 *
 * Keyed on `commanderRule`, which is a seeded cell, so this stays a data-driven rule rather
 * than the format comparison this file refuses to grow.
 */
function outsidePoolIssues(card: CardFacts, spec: FormatSpec): ValidationIssue[] {
  if (spec.commanderRule === "pdh" && card.categoryKind === "commander") return [];
  return [error("not-legal", `${card.name} is not legal in ${spec.displayName}.`, [card.cardId])];
}

/**
 * The commander zone, and the colour identity it puts on the rest of the deck.
 *
 * Called for every format, because a card parked in the commander zone of a Modern deck is a
 * finding of its own. The identity check runs only where there is a commander to derive one
 * from: `commanderIdentity` answers `null` for an empty zone, and an empty *set* is a real
 * answer (a colourless commander admits only colourless cards), so the two cannot be
 * conflated.
 *
 * Two kinds are deliberately left out of the identity pass. The command zone judges itself
 * (Oathbreaker's signature spell is measured against its oathbreaker, and partners are inside
 * their own union by construction), and the `companion` kind is `companions.ts`'s — it holds
 * the companion to the same identity there, and checking it here would report the same card
 * twice.
 */
function commanderIssues(deck: CardFacts[], spec: FormatSpec): ValidationIssue[] {
  const zone = deck.filter((card) => card.categoryKind === "commander");
  const issues = validateCommanderZone(zone, spec);
  const identity = spec.commanderRule === null ? null : commanderIdentity(zone, spec);
  if (identity === null) return issues;
  const judged = deck.filter(
    (card) => card.categoryKind === "main" || card.categoryKind === "side",
  );
  return [...issues, ...colorIdentityIssues(judged, identity)];
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
