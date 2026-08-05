/**
 * Deck validation, part three: the ten companions, and whether the deck they are attached to
 * is the deck they demand.
 *
 * A companion is not a card of the deck — it begins the game outside it — so nothing here is
 * a legality or a copy count. It is **one deck-shape predicate per card**, keyed by printed
 * name, and the ten conditions are ten different readings of the same pile:
 *
 *     Gyruda   every card's mana value is even          Obosh    every nonland's is odd
 *     Keruga   every nonland's is 3 or more             Lurrus   every permanent's is 2 or less
 *     Jegantha no mana cost repeats a symbol            Lutri    nonland names are all different
 *     Kaheera  every creature is one of five types      Umori    the nonlands share a card type
 *     Yorion   the deck is 20 over the minimum          Zirda    every permanent can activate
 *
 * Keyed by **name** rather than by a parse of the printed condition, and that is deliberate:
 * ten cards, printed once each, and their conditions are English sentences that a parser would
 * read wrongly and silently. A name this table does not know is not silently accepted — it is
 * reported, as a warning where the card genuinely prints a `"Companion —"` line and as an error
 * where it does not.
 *
 * The corpus holds three cards outside the ten that print *some* companion ability, and they
 * split between those two answers rather than sharing one: Lutri, Pauper Otter (a Mystery
 * Booster playtest card) and Treizeci, Sun of Serra (a Heroes of the Realm promo) open with
 * `"Companion —"` and **warn**; The Companion of the Wilds opens with `"Old Companion —"`,
 * which the line anchor deliberately does not match, and it gets the ordinary
 * `companion-eligibility` **error**. All three are `not_legal` in all 23 keys, so the legality
 * pass has already refused every one of them.
 *
 * **The starting deck is `main` + `commander`, and never the sideboard.** A companion's
 * condition is on the deck you begin the game with; the sideboard is not part of it. In the
 * commander formats the commander *is* — it is one of the hundred (CR 903.5a) — which is most
 * of why Lurrus is not an EDH companion.
 *
 * Two things about a companion are **not** in this file, both because they are already the
 * deck's own rules rather than the companion's:
 *
 * * its **copy count**. The `companion` zone is one of `engine.ts`'s `COPY_ZONES`, so a card
 *   held as companion *and* in the 99 is two copies of it and the singleton rule says so —
 *   the research doc's "effectively a 101st card", in the one place that already counts cards.
 * * its **legality and mana value**, which `engine.ts` runs over every zone but `maybe`.
 *
 * Its **colour identity** is here, because `engine.ts` deliberately leaves the companion out
 * of the deck-wide identity pass so that it is checked once rather than twice.
 */
import type { DeckZone, FormatSpec } from "@/lib/ipc";
import type { CardFacts, ValidationIssue } from "./types";
import { colorIdentityIssues, commanderIdentity, frontFace } from "./commanders";
import { isOrphan, manaValueOf } from "./engine";

/**
 * The zones a companion's condition reads. `side` is out (a sideboard is not the starting
 * deck) and so is `companion` itself — the companion begins the game outside the deck, which
 * is why Lurrus at mana value 3 can be its own deck's Lurrus.
 */
const STARTING_DECK: readonly DeckZone[] = ["main", "commander"];

/** U+2014, written as an escape for the reason `commanders.ts` gives: an editor or a paste
 *  that swaps it for an en dash or a hyphen must not break a parser invisibly. */
const EM_DASH = "\u2014";

/**
 * The printed line every companion opens with — `"Companion — …"`.
 *
 * Line-anchored, so the playtest card whose ability reads `"Old Companion — …"` is not
 * one of these.
 */
const COMPANION_LINE = new RegExp(`^Companion[ \\t]*${EM_DASH}`, "m");

/** How many offenders a sentence names before it starts counting them instead. */
const NAMES_SHOWN = 3;

/** One companion's condition, as a predicate that reports rather than answers true/false —
 *  the sentence has to name the cards that failed, so the rule is what produces it. */
interface CompanionRule {
  applies(deck: CardFacts[], spec: FormatSpec): ValidationIssue[];
}

// -----------------------------------------------------------------------------------------
// Card facts the conditions read.
// -----------------------------------------------------------------------------------------

/** The card types of the front face — everything left of the em dash. The front face decides,
 *  as it does in `commanders.ts`: a transform card's top-level type line is both halves. */
function cardTypesOf(card: CardFacts): string {
  const { typeLine } = frontFace(card);
  return typeLine === null ? "" : typeLine.split(EM_DASH)[0];
}

/** The creature types of the front face — everything right of the em dash. */
function subtypesOf(card: CardFacts): string {
  const { typeLine } = frontFace(card);
  if (typeLine === null) return "";
  const dash = typeLine.indexOf(EM_DASH);
  return dash < 0 ? "" : typeLine.slice(dash + EM_DASH.length).trim();
}

/** Substring tests, as everywhere else in this folder: no printed card type contains another
 *  as a substring, so a word-boundary regex would buy nothing but a slower answer. */
function hasCardType(card: CardFacts, type: string): boolean {
  return cardTypesOf(card).includes(type);
}

function isLand(card: CardFacts): boolean {
  return hasCardType(card, "Land");
}

/** CR 110.4a's list. `Kindred` is not on it — a Kindred Instant is not a permanent. */
const PERMANENT_TYPES = ["Artifact", "Battle", "Creature", "Enchantment", "Land", "Planeswalker"];

function isPermanent(card: CardFacts): boolean {
  const types = cardTypesOf(card);
  return PERMANENT_TYPES.some((type) => types.includes(type));
}

/**
 * The card types a card in a deck can have, and **the supertypes are deliberately absent**:
 * that is Umori's rule. Two legendary cards share the word `Legendary` and share no card type,
 * so splitting the type line on spaces would let a Legendary Sorcery pass among Legendary
 * Creatures.
 *
 * The out-of-deck types (`Plane`, `Scheme`, `Conspiracy`, `Dungeon`, `Phenomenon`, `Vanguard`,
 * `Hero`, `Emblem`) are **not** on the list, and `Plane` is why the omission is load-bearing
 * rather than tidiness: it is a substring of `Planeswalker`, and the substring test every type
 * check in this folder uses would give every planeswalker two types.
 */
const CARD_TYPES = [
  "Artifact",
  "Battle",
  "Creature",
  "Enchantment",
  "Instant",
  "Kindred",
  "Land",
  "Planeswalker",
  "Sorcery",
];

/** The card types this card has, supertypes dropped. */
function typesOf(card: CardFacts): string[] {
  const printed = cardTypesOf(card);
  return CARD_TYPES.filter((type) => printed.includes(type));
}

/**
 * The card's mana value: the column when the read has one, the printed cost when it does not,
 * and `null` when there is nothing to compute it from.
 *
 * Scryfall's top-level `cmc` is already the right number for every layout the conditions meet
 * — the front face's for a modal double-faced card and an adventure, the sum of both halves
 * for a split card (CR 202.3d) — so no face arithmetic belongs here. {@link manaValueOf} is
 * `engine.ts`'s, because two implementations of it would eventually disagree about a card.
 */
function manaValue(card: CardFacts): number | null {
  if (card.cmc !== null) return card.cmc;
  return card.manaCost === null ? null : manaValueOf(card.manaCost);
}

/**
 * Every printed cost on the card, as separate strings — which is Jegantha's whole rule.
 *
 * A split card's top-level `mana_cost` is `"{1}{R} // {1}{U}"`; read as one cost that repeats
 * `{1}`, and Fire // Ice would be refused for a symbol neither half prints twice. So the
 * top-level string is split on `//` and each face's own cost is added, which is also what
 * makes an adventure's front face (`{1}{U}{U}`) count.
 */
function manaCostsOf(card: CardFacts): string[] {
  const costs = new Set<string>();
  for (const half of (card.manaCost ?? "").split("//")) {
    const cost = half.trim();
    if (cost !== "") costs.add(cost);
  }
  for (const face of facesOf(card)) {
    const cost = typeof face.mana_cost === "string" ? face.mana_cost.trim() : "";
    if (cost !== "") costs.add(cost);
  }
  return [...costs];
}

/** All of the card's printed text, every face included. A blob this module cannot read is no
 *  faces at all, never a thrown error — `faces` is JSON, unlike `colors`/`colorIdentity`. */
function allOracleText(card: CardFacts): string {
  const parts = [card.oracleText ?? ""];
  for (const face of facesOf(card)) {
    if (typeof face.oracle_text === "string") parts.push(face.oracle_text);
  }
  return parts.join("\n");
}

function facesOf(card: CardFacts): Record<string, unknown>[] {
  if (card.faces === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(card.faces);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (face): face is Record<string, unknown> =>
      face !== null && typeof face === "object" && !Array.isArray(face),
  );
}

// -----------------------------------------------------------------------------------------
// Sentences.
// -----------------------------------------------------------------------------------------

/**
 * Up to {@link NAMES_SHOWN} offenders by name, then a count.
 *
 * A condition can fail on forty cards, and forty sentences is not forty problems — the panel
 * highlights every one of them from the issue's `cardIds` regardless of how many the sentence
 * had room to name.
 */
function nameList(names: string[]): string {
  if (names.length <= NAMES_SHOWN) {
    if (names.length <= 1) return names.join("");
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  const rest = names.length - NAMES_SHOWN;
  return `${names.slice(0, NAMES_SHOWN).join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`;
}

/** Distinct names in the order the read returned them — one card is often several rows. */
function distinctNames(cards: CardFacts[]): string[] {
  return [...new Set(cards.map((card) => card.name))];
}

function distinctCardIds(cards: CardFacts[]): string[] {
  return [...new Set(cards.map((card) => card.cardId))];
}

/**
 * The one sentence shape nine of the ten conditions use: what the companion needs, then which
 * cards do not do it.
 *
 * `singular`/`plural` are the verb the offenders take, because "Sol Ring do not" is the kind
 * of wrong that a reader notices and a test does not.
 */
function offenderIssue(
  companion: string,
  requirement: string,
  singular: string,
  plural: string,
  offenders: CardFacts[],
): ValidationIssue[] {
  if (offenders.length === 0) return [];
  const names = distinctNames(offenders);
  return [
    {
      severity: "error",
      code: "companion-condition",
      message: `${companion} needs ${requirement}; ${nameList(names)} ${
        names.length === 1 ? singular : plural
      }.`,
      cardIds: distinctCardIds(offenders),
    },
  ];
}

// -----------------------------------------------------------------------------------------
// The ten.
// -----------------------------------------------------------------------------------------

/** Kaheera's five, as printed. */
const KAHEERA_TYPES = ["Cat", "Elemental", "Nightmare", "Dinosaur", "Beast"];

/**
 * CR 702.73a: a card with changeling is every creature type, so it is a Cat.
 *
 * Its printed subtype line says `Shapeshifter` and nothing else, so a subtype test alone
 * refuses all 68 of them — a confident wrong error about a deck that is legal. The keyword is
 * what makes the card a Cat, so the keyword is what is read; line-anchored, because fourteen
 * cards *mention* changeling while merely creating a token that has it.
 */
const CHANGELING = /^Changeling\b/m;

/**
 * Activated-ability keywords that Scryfall prints with **no colon anywhere**, so Zirda's colon
 * test cannot see them.
 *
 * Every entry is measured, not guessed — probed against the live corpus (2026-08-05) over the
 * 15 593 permanent cards whose whole oracle text holds no `:`, counting what each keyword
 * rescues from a wrong error:
 *
 *     Equip 320 · Crew 62 · Saddle 6 · Cycling 5 · Unearth 3 · Ninjutsu 2 · Scavenge 1
 *     Embalm 0 · Fortify 0 · Reconfigure 0 · Aura swap 0
 *
 * **The four zero-rescue entries are kept deliberately.** They are activated abilities whose
 * reminder text happens to carry a colon on every printing in the corpus today; the day one
 * ships without it they are the difference between a right answer and a wrong error, and a
 * keyword that rescues nothing costs nothing. The counts above are what makes that auditable —
 * re-probe rather than trust them.
 *
 * The `—` alternative is the second half of the fix and is worth as much as the keywords: the
 * thirteen "Job select" Equipment print their equip ability behind a flavour name
 * (`"Murasame — Equip {5}"`), which a line anchor alone cannot match. Written as an escape
 * rather than as the character, like every other dash in this folder.
 *
 * Everything left out is left out on purpose: the morph family and disguise are **special
 * actions**, and suspend, prototype, bestow, evoke and the other alternative costs are ways to
 * cast a card rather than abilities it has.
 */
const BARE_ACTIVATED_KEYWORDS =
  /(?:^|\u2014\s*)(?:Equip|Crew|Saddle|Cycling|Unearth|Ninjutsu|Scavenge|Embalm|Fortify|Reconfigure|Aura swap)\b/im;

/**
 * Zirda's condition is the one that cannot be read exactly, and this is what the reading
 * costs — **in both directions**, because it has two halves that fail opposite ways.
 *
 * The colon is read **including reminder text**. Excluding reminders is the obvious reading and
 * it is wrong twice over: a basic land's entire text is `"({T}: Add {U}.)"`, and Dryad Arbor's
 * is a parenthesis quoting the same ability. Both have activated mana abilities, so stripping
 * reminders refuses the most common card in Magic. Reading them costs a false **pass** on a
 * permanent whose only colon belongs to an ability it grants something else.
 *
 * {@link BARE_ACTIVATED_KEYWORDS} is the other half, and its residual risk is a false
 * **error** — the direction this codebase does not accept. A keyword activated ability that
 * ships with neither a colon nor an entry on that list refuses a legal deck until the list
 * grows, and that, not the false pass, is the live risk in this function.
 */
function hasActivatedAbility(card: CardFacts): boolean {
  const text = allOracleText(card);
  return text.includes(":") || BARE_ACTIVATED_KEYWORDS.test(text);
}

/** Cards of the starting deck this module can judge — an orphaned row has no facts, and the
 *  engine has already said so in the reconciler's own words. */
function judgeable(deck: CardFacts[]): CardFacts[] {
  return deck.filter((card) => !isOrphan(card));
}

/** A condition that fails on individual cards: pick them, then say so. */
function failing(
  deck: CardFacts[],
  applies: (card: CardFacts) => boolean,
  fails: (card: CardFacts) => boolean,
): CardFacts[] {
  return judgeable(deck).filter((card) => applies(card) && fails(card));
}

const COMPANIONS: Record<string, CompanionRule> = {
  // "Your starting deck contains only cards with even mana values." Lands are mana value 0,
  // which is even — so Gyruda is the one mana-value companion with no land clause of its own.
  "Gyruda, Doom of Depths": {
    applies: (deck) =>
      offenderIssue(
        "Gyruda, Doom of Depths",
        "every card in your deck to have an even mana value",
        "does not",
        "do not",
        failing(
          deck,
          () => true,
          (card) => {
            const value = manaValue(card);
            return value !== null && value % 2 !== 0;
          },
        ),
      ),
  },

  // "No card in your starting deck has more than one of the same mana symbol in its mana
  // cost." Symbols are compared as printed tokens, so `{U/B}{U/B}` is a repeat and `{R/G}`
  // beside `{R}` is not; a generic `{2}` is one symbol however large the number, which is why
  // Jegantha's own `{4}{R/G}` passes its own condition.
  "Jegantha, the Wellspring": {
    applies: (deck) =>
      offenderIssue(
        "Jegantha, the Wellspring",
        "no mana cost in your deck to repeat a mana symbol",
        "repeats one",
        "repeat one",
        failing(deck, () => true, repeatsAManaSymbol),
      ),
  },

  // "Each creature card in your starting deck is a Cat, Elemental, Nightmare, Dinosaur, or
  // Beast card."
  "Kaheera, the Orphanguard": {
    applies: (deck) =>
      offenderIssue(
        "Kaheera, the Orphanguard",
        `every creature card in your deck to be a ${KAHEERA_TYPES.slice(0, -1).join(", ")} or ${
          KAHEERA_TYPES[KAHEERA_TYPES.length - 1]
        }`,
        "is not",
        "are not",
        failing(
          deck,
          (card) => hasCardType(card, "Creature"),
          (card) =>
            !CHANGELING.test(allOracleText(card)) &&
            !KAHEERA_TYPES.some((type) => subtypesOf(card).includes(type)),
        ),
      ),
  },

  // "Your starting deck contains only cards with mana value 3 or greater and land cards."
  "Keruga, the Macrosage": {
    applies: (deck) =>
      offenderIssue(
        "Keruga, the Macrosage",
        "every nonland card in your deck to have mana value 3 or greater",
        "does not",
        "do not",
        failing(
          deck,
          (card) => !isLand(card),
          (card) => {
            const value = manaValue(card);
            return value !== null && value < 3;
          },
        ),
      ),
  },

  // "Each permanent card in your starting deck has mana value 2 or less." An instant is not a
  // permanent, so Lurrus has nothing to say about a five-mana Sorcery.
  "Lurrus of the Dream-Den": {
    applies: (deck) =>
      offenderIssue(
        "Lurrus of the Dream-Den",
        "every permanent card in your deck to have mana value 2 or less",
        "does not",
        "do not",
        failing(deck, isPermanent, (card) => {
          const value = manaValue(card);
          return value !== null && value > 2;
        }),
      ),
  },

  // "Each nonland card in your starting deck has a different name." Unbanned in Commander on
  // 2026-02-09 and still banned in Brawl and Competitive Brawl — but that is a *legality*, and
  // `engine.ts`'s ordinary ban check reads it off the card. No code here.
  "Lutri, the Spellchaser": {
    applies: (deck) => {
      const nonlands = judgeable(deck).filter((card) => !isLand(card));
      const counts = new Map<string, number>();
      for (const card of nonlands)
        counts.set(card.name, (counts.get(card.name) ?? 0) + card.quantity);
      const repeated = nonlands.filter((card) => (counts.get(card.name) ?? 0) > 1);
      return offenderIssue(
        "Lutri, the Spellchaser",
        "every nonland card in your deck to have a different name",
        "appears more than once",
        "appear more than once",
        repeated,
      );
    },
  },

  // "Your starting deck contains only cards with odd mana values and land cards."
  "Obosh, the Preypiercer": {
    applies: (deck) =>
      offenderIssue(
        "Obosh, the Preypiercer",
        "every nonland card in your deck to have an odd mana value",
        "does not",
        "do not",
        failing(
          deck,
          (card) => !isLand(card),
          (card) => {
            const value = manaValue(card);
            return value !== null && value % 2 === 0;
          },
        ),
      ),
  },

  // "Each nonland card in your starting deck shares a card type." Sharing *a* type is the
  // rule, so an Artifact Creature sits happily among creatures.
  "Umori, the Collector": { applies: umoriIssues },

  // "Your starting deck contains at least twenty cards more than the minimum deck size." The
  // one condition that reads the format spec rather than the cards — and the reason Yorion is
  // unusable in Commander, whose minimum is also its maximum.
  "Yorion, Sky Nomad": { applies: yorionIssues },

  // "Each permanent card in your starting deck has an activated ability." See ZIRDA_NOTE.
  "Zirda, the Dawnwaker": {
    applies: (deck) =>
      offenderIssue(
        "Zirda, the Dawnwaker",
        "every permanent card in your deck to have an activated ability",
        "does not",
        "do not",
        failing(deck, isPermanent, (card) => !hasActivatedAbility(card)),
      ),
  },
};

/** A cost that prints one symbol twice. Tokens are compared as printed — see the rule. */
function repeatsAManaSymbol(card: CardFacts): boolean {
  for (const cost of manaCostsOf(card)) {
    const seen = new Set<string>();
    for (const [, symbol] of cost.matchAll(/\{([^}]*)\}/g)) {
      if (seen.has(symbol)) return true;
      seen.add(symbol);
    }
  }
  return false;
}

/**
 * Umori's is the one condition with no natural offender: "share a card type" fails on the
 * *set*, not on a card. So the sentence is built around the type the most of the deck has —
 * the cards missing it are the shortest true answer to "what would I change", and naming the
 * type says what they would have to become.
 */
function umoriIssues(deck: CardFacts[]): ValidationIssue[] {
  const nonlands = judgeable(deck).filter((card) => !isLand(card) && typesOf(card).length > 0);
  if (nonlands.length === 0) return [];

  const shared = typesOf(nonlands[0]).filter((type) =>
    nonlands.every((card) => typesOf(card).includes(type)),
  );
  if (shared.length > 0) return [];

  const counts = new Map<string, number>();
  for (const card of nonlands) {
    for (const type of typesOf(card)) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const commonest = [...counts.entries()].reduce((best, entry) =>
    entry[1] > best[1] ? entry : best,
  )[0];
  const offenders = nonlands.filter((card) => !typesOf(card).includes(commonest));

  const names = distinctNames(offenders);
  return [
    {
      severity: "error",
      code: "companion-condition",
      message:
        "Umori, the Collector needs every nonland card in your deck to share a card type; " +
        `most of yours are ${commonest}, but ${nameList(names)} ${
          names.length === 1 ? "is" : "are"
        } not.`,
      cardIds: distinctCardIds(offenders),
    },
  ];
}

function yorionIssues(deck: CardFacts[], spec: FormatSpec): ValidationIssue[] {
  const needed = spec.deckMin + 20;
  const size = deck.reduce((n, card) => n + card.quantity, 0);
  if (size >= needed) return [];
  return [
    {
      severity: "error",
      code: "companion-condition",
      message:
        `Yorion, Sky Nomad needs at least ${needed} cards in your deck, twenty more than ` +
        `${spec.displayName}'s minimum of ${spec.deckMin}; you have ${size}.`,
    },
  ];
}

// -----------------------------------------------------------------------------------------
// The zone.
// -----------------------------------------------------------------------------------------

/**
 * Everything wrong with the companion zone: whether the format has one, how many cards are in
 * it, whether each may be there, whether the deck satisfies it, and — in the commander formats
 * — whether it fits the commander's colours.
 *
 * `deck` is the whole deck minus the scratchpad, as `engine.ts` holds it; the conditions read
 * {@link STARTING_DECK} out of it themselves.
 */
export function companionIssues(
  companionZone: CardFacts[],
  deck: CardFacts[],
  spec: FormatSpec,
): ValidationIssue[] {
  if (companionZone.length === 0) return [];

  // Read from the row, never from the key: Gladiator is the seeded format where this is 0, and
  // the cell beside it says why — `sideboard_max` 0, so there is no slot to hold one.
  if (!spec.allowsCompanion) {
    return [
      {
        severity: "error",
        code: "companion-zone",
        message: `${spec.displayName} has no sideboard, so it has no companions.`,
        cardIds: distinctCardIds(companionZone),
      },
    ];
  }

  const issues: ValidationIssue[] = [];
  const count = companionZone.reduce((n, card) => n + card.quantity, 0);
  if (count > 1) {
    issues.push({
      severity: "error",
      code: "companion-count",
      message: `${spec.displayName} decks have one companion; you have ${count}.`,
    });
  }

  const startingDeck = deck.filter((card) => STARTING_DECK.includes(card.zone));
  // Only where there is a commander to derive an identity from — `commanderIdentity` answers
  // `null` for an empty zone, and an empty *set* is a real answer (a colourless commander
  // admits only colourless cards).
  const identity =
    spec.commanderRule === null
      ? null
      : commanderIdentity(
          deck.filter((card) => card.zone === "commander"),
          spec,
        );

  for (const companion of companionZone) {
    if (isOrphan(companion)) continue;
    issues.push(...eligibility(companion, startingDeck, spec));
    // CR 903.5c through the research doc's "effectively a 101st card": a companion is judged
    // against the commander's identity like every other card of the deck. `engine.ts` leaves
    // the companion zone out of its own identity pass so this happens exactly once.
    if (identity !== null) issues.push(...colorIdentityIssues([companion], identity));
  }
  return issues;
}

/** Whether this card may be a companion at all, and if it may, what its condition says. */
function eligibility(
  companion: CardFacts,
  startingDeck: CardFacts[],
  spec: FormatSpec,
): ValidationIssue[] {
  const rule = COMPANIONS[companion.name];
  if (rule) return rule.applies(startingDeck, spec);

  // A card that prints a companion ability this table does not know is **evidence of nothing**
  // — the same footing an unreadable legality is on, and it warns for the same reason. Two
  // cards reach this branch today (the module docblock names them and the third that does
  // not), and an eleventh real companion would be a data event rather than a wrong accusation.
  if (COMPANION_LINE.test(frontFace(companion).oracleText ?? "")) {
    return [
      {
        severity: "warning",
        code: "companion-unknown",
        message:
          `${companion.name}'s companion ability is one this app does not know, so your deck ` +
          `was not checked against it.`,
        cardIds: [companion.cardId],
      },
    ];
  }
  return [
    {
      severity: "error",
      code: "companion-eligibility",
      message: `${companion.name} has no companion ability, so it cannot be your companion.`,
      cardIds: [companion.cardId],
    },
  ];
}
