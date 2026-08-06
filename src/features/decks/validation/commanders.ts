/**
 * Deck validation, part two: who may sit in the command zone, who may sit there *with* them,
 * and what colours the rest of the deck is allowed to be once they do.
 *
 * **Keyed by `spec.commanderRule`, never by a format key.** Six rule names — `edh`, `brawl`,
 * `oathbreaker`, `pdh`, `duel`, `tlr` — cover nine seeded formats, because two formats may
 * genuinely share one eligibility rule (`predh` carries `edh`; its pool check does the
 * narrowing). The rule name is a seeded cell, so a new commander format is a row and not a
 * release, exactly as in `engine.ts`.
 *
 * Three things this file is careful about, all of them load-bearing:
 *
 * * **The front face decides.** Scryfall's top-level `type_line` on a transform card is both
 *   halves joined by `//`, and its top-level `oracle_text` is *absent* — only `card_faces[0]`
 *   says what the front of the card is. {@link frontFace} merges it over the row's own
 *   fields, so every type and keyword test below reads the face a commander is cast as.
 * * **`colorIdentity` is concatenated letters (`"WU"`), not JSON.** `JSON.parse` throws on
 *   it. {@link identityOf} reads it a character at a time, and that one field answers CR
 *   903.5c *and* 903.5d together: Scryfall precomputes it with DFC backs, adventures,
 *   reminder-text exclusion, colour indicators and basic land types already folded in, which
 *   is why there is no second rule here for lands.
 * * **`restricted` means *banned as a commander* in Duel Commander and Tiny Leaders**
 *   (TRAP A), and only ever in the commander zone — Task 8 routes the main deck by
 *   `restrictedSemantic` and stays silent there on purpose.
 *
 * Companion conditions and the bracket advisory are Task 10's; this file knows nothing about
 * them.
 */
import type { FormatSpec } from "@/lib/ipc";
import type { CardFacts, ValidationIssue } from "./types";

/** The rule names `format_specs.commander_rule` takes, minus the NULL. */
type CommanderRule = NonNullable<FormatSpec["commanderRule"]>;

/**
 * Scryfall's type lines and the printed partner variants both use an em dash (U+2014):
 * `"Legendary Creature — Time Lord Doctor"`, `"Partner—Friends forever"`.
 *
 * Written as an escape rather than as the character, here and in {@link PARTNER_VARIANT}, so
 * that an editor or a paste that "helpfully" swaps it for an en dash or a hyphen cannot break
 * the parser invisibly — the same discipline Task 8 arrived at the hard way with a separator
 * that went into a source file as a byte instead of as source text.
 */
const EM_DASH = "\u2014";

/** WUBRG, the order Magic prints colours in and the order a message reads them back in. */
const COLOR_ORDER = ["W", "U", "B", "R", "G"] as const;

// -----------------------------------------------------------------------------------------
// The front face.
// -----------------------------------------------------------------------------------------

/** The four fields every rule below reads, taken from the face the card is cast as. */
interface FrontFace {
  typeLine: string | null;
  oracleText: string | null;
  power: string | null;
  toughness: string | null;
}

/**
 * The card as its front face, which is the only face a commander is judged by.
 *
 * `card_row` already hoists `type_line` and P/T from `card_faces[0]` for the layouts that
 * carry nothing at the top level (reversible cards), but it does **not** hoist `oracle_text`,
 * and for a transform card the top-level `type_line` is both halves joined. Merging the face
 * over the row makes every test below independent of which layout it is looking at.
 *
 * Exported so Task 10's companion conditions can read the same face rather than growing a
 * second answer to "what is the front of this card".
 */
export function frontFace(card: CardFacts): FrontFace {
  const own: FrontFace = {
    // `"A // B"` is a joined type line, not a face; the front is the left half.
    typeLine: card.typeLine === null ? null : card.typeLine.split("//")[0].trim(),
    oracleText: card.oracleText,
    power: card.power,
    toughness: card.toughness,
  };
  const face = firstFace(card.faces);
  if (face === null) return own;
  return {
    typeLine: text(face.type_line) ?? own.typeLine,
    oracleText: text(face.oracle_text) ?? own.oracleText,
    power: text(face.power) ?? own.power,
    toughness: text(face.toughness) ?? own.toughness,
  };
}

/** `faces` is JSON — `card_faces` verbatim — unlike `colors`/`colorIdentity`. A blob this
 *  module cannot read is no faces at all, never a thrown error. */
function firstFace(faces: string | null): Record<string, unknown> | null {
  if (faces === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(faces);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const face: unknown = parsed[0];
  return face !== null && typeof face === "object" && !Array.isArray(face)
    ? (face as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// -----------------------------------------------------------------------------------------
// Type lines.
// -----------------------------------------------------------------------------------------

/** Everything left of the em dash: supertypes and card types. */
function cardTypesOf(typeLine: string): string {
  return typeLine.split(EM_DASH)[0];
}

/** Everything right of it: the subtypes, where Vehicle, Spacecraft and Background live. */
function subtypesOf(typeLine: string): string {
  const dash = typeLine.indexOf(EM_DASH);
  return dash < 0 ? "" : typeLine.slice(dash + EM_DASH.length).trim();
}

/** Substring tests, as in `singleton.ts`: no printed card type or subtype contains another
 *  as a substring, so a word-boundary regex would buy nothing but a slower answer. */
function isLegendary(typeLine: string): boolean {
  return cardTypesOf(typeLine).includes("Legendary");
}

function hasCardType(typeLine: string, type: string): boolean {
  return cardTypesOf(typeLine).includes(type);
}

function hasSubtype(typeLine: string, subtype: string): boolean {
  return subtypesOf(typeLine).includes(subtype);
}

function isPlaneswalkerCard(card: CardFacts): boolean {
  const { typeLine } = frontFace(card);
  return typeLine !== null && hasCardType(typeLine, "Planeswalker");
}

function isInstantOrSorcery(card: CardFacts): boolean {
  const { typeLine } = frontFace(card);
  if (typeLine === null) return false;
  return hasCardType(typeLine, "Instant") || hasCardType(typeLine, "Sorcery");
}

/** A Background is a legal *second* commander and nothing else — the zone rule is what
 *  makes it one, so this only ever identifies the card. */
function isBackground(typeLine: string): boolean {
  return isLegendary(typeLine) && hasSubtype(typeLine, "Background");
}

/**
 * "the Doctor" as Doctor's companion means it: a legendary creature whose creature types are
 * **Time Lord Doctor and nothing else** (research doc). Susan Foreman is a legendary
 * `Time Lord` and is not the Doctor; an ordinary substring test would make her one.
 */
function isTheDoctor(typeLine: string): boolean {
  if (!isLegendary(typeLine) || !hasCardType(typeLine, "Creature")) return false;
  return subtypesOf(typeLine).replace(/\s+/g, " ").trim() === "Time Lord Doctor";
}

// -----------------------------------------------------------------------------------------
// Colour identity — CR 903.5c and 903.5d, in one subset test.
// -----------------------------------------------------------------------------------------

/**
 * A card's colour identity as a set of WUBRG letters.
 *
 * `colorIdentity` is **concatenated letters** (`"WU"`, `""` for colourless) and never JSON —
 * `card_row` joins Scryfall's array and the letters are what comes back. Anything that is not
 * one of the five is dropped, so a stray token can never widen an identity.
 */
export function identityOf(card: CardFacts): ReadonlySet<string> {
  const letters = card.colorIdentity;
  if (!letters) return new Set();
  const identity = new Set<string>();
  for (const letter of letters.toUpperCase()) {
    if ((COLOR_ORDER as readonly string[]).includes(letter)) identity.add(letter);
  }
  return identity;
}

/**
 * The identity the deck is judged against: the **union** across the commander zone
 * (CR 702.124c — two partners contribute both their identities), and `null` when there is no
 * commander to judge against, which is not the same as an empty set. A colourless commander
 * has an empty identity and admits only colourless cards; an *absent* commander has no
 * identity at all, and calling {@link colorIdentityIssues} with one would report every
 * coloured card in the deck for a commander the user has not chosen yet.
 *
 * Under Oathbreaker the definers are the **planeswalkers**, and nothing else in the zone. The
 * signature spell must fit *inside* the oathbreaker's identity, so letting it widen the thing
 * it is measured against would make that rule unfalsifiable; and a card that is neither — a
 * creature somebody dropped into the zone — has an eligibility error of its own rather than a
 * say in what the deck may contain. A partner pair contributes both identities, which is the
 * same union `oathbreakerZoneIssues` holds each signature spell to — and in the oathbreaker
 * zone that union is this app's permissive reading rather than a rule (see `unionIdentity`).
 */
export function commanderIdentity(zone: CardFacts[], spec: FormatSpec): ReadonlySet<string> | null {
  const definers = spec.commanderRule === "oathbreaker" ? zone.filter(isPlaneswalkerCard) : zone;
  if (definers.length === 0) return null;
  return unionIdentity(definers);
}

/**
 * Several definers, one identity: the union of theirs.
 *
 * In the **commander** zone that is a citation — CR 702.124c, two partners make one identity —
 * and in the **oathbreaker** zone it is not. Oathbreaker is not a CR format, and its own rule
 * is per-oathbreaker: each signature spell must fit inside *the oathbreaker it was chosen for*.
 * A zone-level check has no spell→walker assignment to read (the zone is a list of cards; which
 * spell belongs to which walker is nowhere in the data), so this app takes the union
 * deliberately — the permissive reading, which under-reports rather than inventing a pairing
 * and refusing a deck over it. 702.124c is the analogy the shape is borrowed from, not the
 * rule being enforced.
 */
function unionIdentity(cards: CardFacts[]): Set<string> {
  const union = new Set<string>();
  for (const card of cards) for (const colour of identityOf(card)) union.add(colour);
  return union;
}

/**
 * CR 903.5c: every card in the deck must have a colour identity inside the commander's.
 *
 * 903.5d — "a land with a basic land type is inside the identity of every colour that type
 * produces" — needs no rule of its own here, because Scryfall's `color_identity` has already
 * folded land types in. Taiga prints no mana symbol anywhere and answers `RG`; that is the
 * 903.5d test, and it passes with no land-specific code.
 */
export function colorIdentityIssues(
  cards: CardFacts[],
  commanderIdentity: ReadonlySet<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const card of cards) {
    const identity = identityOf(card);
    if ([...identity].every((colour) => commanderIdentity.has(colour))) continue;
    issues.push(
      error(
        "color-identity",
        `${card.name}'s color identity (${nameIdentity(identity)}) is outside your ` +
          `commander's (${nameIdentity(commanderIdentity)}).`,
        [card.cardId],
      ),
    );
  }
  return issues;
}

/** An identity as the reader sees it printed: WUBRG order, and a word for the empty set. */
function nameIdentity(identity: ReadonlySet<string>): string {
  const letters = COLOR_ORDER.filter((colour) => identity.has(colour)).join("");
  return letters === "" ? "colorless" : letters;
}

// -----------------------------------------------------------------------------------------
// Eligibility — CR 903.3 and its per-format variants.
// -----------------------------------------------------------------------------------------

/** One rule name's answer to "what may sit in the command zone", as data. */
interface RuleDefinition {
  /** What this format calls the card, and how the sentence introduces it. */
  noun: string;
  nounPhrase: string;
  /** The prose after "must be", so every refusal says what would have worked. */
  requirement: string;
  legendary: boolean;
  creature: boolean;
  planeswalker: boolean;
  /** Vehicles and Spacecraft qualify only **with a power and toughness** (CR 903.3, 2026). */
  vehicle: boolean;
  spacecraft: boolean;
  /** CR 903.3's escape hatch: the 32 cards whose own rules text grants it. */
  canBeYourCommander: boolean;
  /** TRAP C: Pauper Commander's commander is judged by rarity, never by its legality key. */
  everUncommon: boolean;
}

const EDH_REQUIREMENT =
  "a legendary creature, a legendary Vehicle or Spacecraft with a power and toughness, or a " +
  "card that says it can be your commander";

/** EDH's rule plus planeswalkers — Brawl's by CR 903.12c, and Tiny Leaders' by its own list.
 *  The two rules coincide today and are still separate rows, because what makes them separate
 *  rule names lives on the spec (`restrictedSemantic`, `maxManaValue`) rather than here. */
const BROAD_REQUIREMENT =
  "a legendary creature or planeswalker, a legendary Vehicle or Spacecraft with a power and " +
  "toughness, or a card that says it can be your commander";

const RULES: Record<CommanderRule, RuleDefinition> = {
  // CR 903.3, 2026 wording.
  edh: {
    noun: "commander",
    nounPhrase: "a commander",
    requirement: EDH_REQUIREMENT,
    legendary: true,
    creature: true,
    planeswalker: false,
    vehicle: true,
    spacecraft: true,
    canBeYourCommander: true,
    everUncommon: false,
  },
  // CR 903.12c is broader than EDH: any legendary planeswalker will do, with no "can be your
  // commander" text needed.
  brawl: {
    noun: "commander",
    nounPhrase: "a commander",
    requirement: BROAD_REQUIREMENT,
    legendary: true,
    creature: true,
    planeswalker: true,
    vehicle: true,
    spacecraft: true,
    canBeYourCommander: true,
    everUncommon: false,
  },
  // The signature spell is a zone rule, not an eligibility one — an instant in this zone is
  // the second half of the pair, and `validateCommanderZone` treats it as such.
  oathbreaker: {
    noun: "oathbreaker",
    nounPhrase: "an oathbreaker",
    requirement: "a planeswalker",
    legendary: false,
    creature: false,
    planeswalker: true,
    vehicle: false,
    spacecraft: false,
    canBeYourCommander: false,
    everUncommon: false,
  },
  // Research doc: "UNCOMMON creature/Vehicle/Spacecraft, need NOT be legendary".
  pdh: {
    noun: "commander",
    nounPhrase: "a commander",
    requirement: "a creature, Vehicle or Spacecraft that has been printed at uncommon",
    legendary: false,
    creature: true,
    planeswalker: false,
    vehicle: true,
    spacecraft: true,
    canBeYourCommander: false,
    everUncommon: true,
  },
  // Duel Commander's eligibility is CR 903.3 like every other Commander variant; what makes
  // it its own rule name is TRAP A — `duel: restricted` bans a card *as a commander*, which
  // is why `is:duelcommander` (3 260) is smaller than `is:commander` (3 666).
  duel: {
    noun: "commander",
    nounPhrase: "a commander",
    requirement: EDH_REQUIREMENT,
    legendary: true,
    creature: true,
    planeswalker: false,
    vehicle: true,
    spacecraft: true,
    canBeYourCommander: true,
    everUncommon: false,
  },
  // Research doc: "leg. creature/PW/Vehicle" — planeswalkers like Brawl, Vehicles like EDH.
  // **Spacecraft is in even though that cell does not name it**, because the omission is
  // terseness rather than a rule: the pool itself disagrees with the strict reading. Two
  // legendary Spacecraft are `tlr: legal` in the live data (The Seriema `{1}{W}{W}` 5/5 and
  // Inspirit, Flagship Vessel `{U}{R}{W}`), both under the format's mana-value ceiling, and
  // refusing them would manufacture an error about cards the format's own list admits.
  // Where the doc is silent, a false negative beats a confident false error.
  tlr: {
    noun: "commander",
    nounPhrase: "a commander",
    requirement: BROAD_REQUIREMENT,
    legendary: true,
    creature: true,
    planeswalker: true,
    vehicle: true,
    spacecraft: true,
    canBeYourCommander: true,
    everUncommon: false,
  },
};

/** The phrase the 32 cards print. It lives in rules text, not reminder text, so the test is
 *  on the unstripped oracle text. */
const CAN_BE_YOUR_COMMANDER = "can be your commander";

/**
 * Why this card cannot sit in the command zone under this rule, or `null` if it can.
 *
 * The answer is about the card **on its own**. A Background is refused here and made legal by
 * {@link validateCommanderZone}, which is the only place that can see the commander that
 * chose it; an orphaned row is not judged at all, because it has no type line to judge and
 * already carries the reconciler's warning.
 */
export function commanderIneligibility(
  card: CardFacts,
  rule: CommanderRule,
  spec: FormatSpec,
): string | null {
  const front = frontFace(card);
  if (front.typeLine === null) return null;
  const def = RULES[rule];
  const format = spec.displayName;

  if (def.canBeYourCommander && (front.oracleText ?? "").includes(CAN_BE_YOUR_COMMANDER)) {
    return null;
  }

  const typeLine = front.typeLine;
  const vehicle = def.vehicle && hasSubtype(typeLine, "Vehicle");
  const spacecraft = def.spacecraft && hasSubtype(typeLine, "Spacecraft");
  // CR 903.3, 2026: the Vehicle/Spacecraft clause turns on a printed P/T box. Both columns
  // null means *unknown*, and the backend already repaired what it could, so a null pair here
  // is a card that genuinely has none.
  const hasPowerAndToughness = front.power !== null && front.toughness !== null;
  const typeOk =
    (def.creature && hasCardType(typeLine, "Creature")) ||
    (def.planeswalker && hasCardType(typeLine, "Planeswalker")) ||
    ((vehicle || spacecraft) && hasPowerAndToughness);

  if ((!def.legendary || isLegendary(typeLine)) && typeOk) {
    // TRAP C, and it is the whole of PDH's commander rule: the `paupercommander` legality key
    // answers for the 99 (commons), so every uncommon reads `not_legal` there. Rarity decides.
    if (def.everUncommon && !card.everUncommon) {
      return (
        `${card.name} has never been printed at uncommon, so it cannot be your ${def.noun} ` +
        `in ${format}.`
      );
    }
    return null;
  }

  if (
    (vehicle || spacecraft) &&
    !hasPowerAndToughness &&
    (!def.legendary || isLegendary(typeLine))
  ) {
    // "legendary" only where the rule asks for it — Pauper Commander's does not, and saying it
    // would add a requirement the format has never had.
    return (
      `${card.name} has no power and toughness, so it cannot be your ${def.noun} in ${format}; ` +
      `a ${def.legendary ? "legendary " : ""}${vehicle ? "Vehicle" : "Spacecraft"} needs one.`
    );
  }

  if (def.creature && isBackground(typeLine)) {
    return (
      `${card.name} is a Background, so it can only be a second commander beside a card that ` +
      `says "Choose a Background".`
    );
  }

  return `${card.name} is not a legal ${def.noun} in ${format}: ${def.nounPhrase} must be ${def.requirement}.`;
}

// -----------------------------------------------------------------------------------------
// Partner abilities — CR 702.124 and its named variants.
// -----------------------------------------------------------------------------------------

/**
 * Line-anchored, every one of them, and the anchoring is the rule rather than tidiness:
 * `Partner with Amy Pond` starts with the word `Partner`, so a bare `includes("Partner")`
 * reads it as plain partner and pairs it with anything.
 *
 * Reminder text is in parentheses and is optional in the printed corpus — Nikara carries it
 * and Yannik does not — so each pattern ends at either a `(` or the end of the line rather
 * than assuming one shape.
 */
const PARTNER_PLAIN = /^Partner[ \t]*(?:\(|$)/m;
const PARTNER_WITH = /^Partner with ([^\n(]+?)[ \t]*(?:\(|$)/m;
const PARTNER_VARIANT = /^Partner\u2014([^\n(]+?)[ \t]*(?:\(|$)/m;
const CHOOSE_A_BACKGROUND = "Choose a Background";
const DOCTORS_COMPANION = "Doctor's companion";

/** Every way one card can be half of a pair, read off its front face. */
interface PartnerFacts {
  plain: boolean;
  /** The card `Partner with` names, printed and trimmed. */
  withName: string | null;
  /** The tag after `Partner—`: "Friends forever", "Character select", "Survivors",
   *  "Father & son". */
  variant: string | null;
  choosesBackground: boolean;
  doctorsCompanion: boolean;
  isBackground: boolean;
  isDoctor: boolean;
}

function partnerFactsOf(card: CardFacts): PartnerFacts {
  const front = frontFace(card);
  const oracle = front.oracleText ?? "";
  const typeLine = front.typeLine ?? "";
  return {
    plain: PARTNER_PLAIN.test(oracle),
    withName: PARTNER_WITH.exec(oracle)?.[1].trim() ?? null,
    variant: PARTNER_VARIANT.exec(oracle)?.[1].trim() ?? null,
    choosesBackground: oracle.includes(CHOOSE_A_BACKGROUND),
    doctorsCompanion: oracle.includes(DOCTORS_COMPANION),
    isBackground: isBackground(typeLine),
    isDoctor: isTheDoctor(typeLine),
  };
}

/** How a message names the ability, or `null` when the card has none. */
function abilityLabel(facts: PartnerFacts): string | null {
  if (facts.plain) return "partner";
  if (facts.variant !== null) return `partner${EM_DASH}${facts.variant}`;
  if (facts.withName !== null) return `partner with ${facts.withName}`;
  if (facts.choosesBackground) return '"Choose a Background"';
  if (facts.doctorsCompanion) return "Doctor's companion";
  return null;
}

/** `Partner with` names a card by its printed name; a two-faced card is named by its front. */
function namesCard(printed: string, card: CardFacts): boolean {
  const wanted = printed.trim();
  return wanted === card.name || wanted === card.name.split(" // ")[0].trim();
}

type Pairing =
  /** `excused` is the card the pairing — and only the pairing — makes a legal commander. */
  | { ok: true; excused?: CardFacts }
  /**
   * `covers` names the cards whose own eligibility sentence this failure has already said, so
   * the reader gets one finding instead of three. Only ever the two-Backgrounds case, and
   * deliberately **not** a general suppression: when a pairing fails *and* one of the cards is
   * illegal for an unrelated reason (a nonlegendary creature beside a legend), both sentences
   * are true and hiding either one loses a problem the user has to fix.
   */
  | { ok: false; message: string; covers?: CardFacts[] };

/**
 * CR 702.124: two commanders are legal only through a partner ability, and the variants never
 * mix (702.124f) — plain partner does not pair with "Friends forever", and "Friends forever"
 * does not pair with "Character select".
 */
function pairingOf(a: CardFacts, b: CardFacts): Pairing {
  const fa = partnerFactsOf(a);
  const fb = partnerFactsOf(b);

  if (fa.plain && fb.plain) return { ok: true };
  // 702.124e: the naming is mutual, so both halves are checked.
  if (
    fa.withName !== null &&
    fb.withName !== null &&
    namesCard(fa.withName, b) &&
    namesCard(fb.withName, a)
  ) {
    return { ok: true };
  }
  if (fa.variant !== null && fb.variant !== null && sameTag(fa.variant, fb.variant)) {
    return { ok: true };
  }
  // A Background is not a creature, so CR 903.3 refuses it on its own; being chosen is what
  // makes it a commander, and the eligibility pass is told to skip it.
  if (fa.choosesBackground && fb.isBackground) return { ok: true, excused: b };
  if (fb.choosesBackground && fa.isBackground) return { ok: true, excused: a };
  if ((fa.doctorsCompanion && fb.isDoctor) || (fb.doctorsCompanion && fa.isDoctor)) {
    return { ok: true };
  }

  // Two Backgrounds get one sentence, not three: the pairing message already says everything
  // each card's own "is a Background" refusal would.
  const covers = fa.isBackground && fb.isBackground ? [a, b] : undefined;
  return { ok: false, message: pairingFailure(a, fa, b, fb), covers };
}

function sameTag(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The most specific true sentence about why these two cannot both be commanders. */
function pairingFailure(a: CardFacts, fa: PartnerFacts, b: CardFacts, fb: PartnerFacts): string {
  if (fa.isBackground && fb.isBackground) {
    return (
      `${a.name} and ${b.name} are both Backgrounds; a Background is a second commander ` +
      `beside a card that says "Choose a Background".`
    );
  }
  if (fa.choosesBackground || fb.choosesBackground) {
    const [chooser, other] = fa.choosesBackground ? [a, b] : [b, a];
    return (
      `${chooser.name} says "Choose a Background", so the other commander must be a legendary ` +
      `Background; ${other.name} is not one.`
    );
  }
  if (fa.doctorsCompanion || fb.doctorsCompanion) {
    const [companion, other] = fa.doctorsCompanion ? [a, b] : [b, a];
    return (
      `${companion.name} has Doctor's companion, so the other commander must be a legendary ` +
      `Time Lord Doctor; ${other.name} is not one.`
    );
  }
  // Name the side that is wrong, not the first side: when A names B and B names someone else,
  // the sentence the reader needs is about B.
  if (fa.withName !== null && !namesCard(fa.withName, b)) {
    return `${a.name} partners only with ${fa.withName}; ${b.name} is not that card.`;
  }
  if (fb.withName !== null && !namesCard(fb.withName, a)) {
    return `${b.name} partners only with ${fb.withName}; ${a.name} is not that card.`;
  }

  const la = abilityLabel(fa);
  const lb = abilityLabel(fb);
  if (la !== null && lb !== null) {
    return `${a.name} has ${la} and ${b.name} has ${lb}; two commanders must share one partner ability.`;
  }
  if (la !== null || lb !== null) {
    const [withIt, without] = la !== null ? [a, b] : [b, a];
    return (
      `${withIt.name} has ${la ?? lb}, but ${without.name} has no partner ability; a second ` +
      `commander needs one.`
    );
  }
  return (
    `${a.name} and ${b.name} cannot both be commanders; a second commander needs a partner ` +
    `ability.`
  );
}

// -----------------------------------------------------------------------------------------
// The zone.
// -----------------------------------------------------------------------------------------

/**
 * Everything wrong with the command zone: how many cards are in it, whether each may be
 * there, whether two of them may be there together, and — under Duel Commander and Tiny
 * Leaders — whether one of them is banned from it specifically.
 *
 * Called for **every** format, including the ones with no commander: a card parked in the
 * commander zone of a Modern deck still counts toward the deck's size (`SIZE_ZONES`), so it
 * is a card in the wrong pile rather than a card nobody mentions.
 */
export function validateCommanderZone(zone: CardFacts[], spec: FormatSpec): ValidationIssue[] {
  const rule = spec.commanderRule;
  if (!spec.requiresCommander || rule === null) {
    return zone.map((card) =>
      error(
        "commander-zone",
        `${spec.displayName} decks have no commander; move ${card.name} to the main deck.`,
        [card.cardId],
      ),
    );
  }
  if (rule === "oathbreaker") return oathbreakerZoneIssues(zone, spec);

  const count = zone.reduce((n, card) => n + card.quantity, 0);
  if (count === 0) {
    return [
      error(
        "commander-missing",
        `${spec.displayName} decks need a commander; the commander zone is empty.`,
      ),
    ];
  }

  const issues: ValidationIssue[] = [];
  // CR 702.124g: never more than two, and only ever two through a partner ability.
  if (count > 2) {
    issues.push(
      error(
        "commander-count",
        `${spec.displayName} decks have at most two commanders, and only with a partner ` +
          `ability; you have ${count}.`,
      ),
    );
  }

  // Pairing is about two distinct cards. Two copies of one card is a copy-limit problem, and
  // every commander format is singleton, so `engine.ts` has already said so.
  const pair = zone.length === 2 ? pairingOf(zone[0], zone[1]) : null;
  for (const card of zone) {
    if (pair?.ok && pair.excused === card) continue;
    if (pair !== null && !pair.ok && pair.covers?.includes(card)) continue;
    const why = commanderIneligibility(card, rule, spec);
    if (why !== null) issues.push(error("commander-eligibility", why, [card.cardId]));
  }
  if (pair !== null && !pair.ok) {
    issues.push(
      error(
        "commander-partner",
        pair.message,
        zone.map((card) => card.cardId),
      ),
    );
  }
  issues.push(...bannedAsCommanderIssues(zone, spec));
  return issues;
}

/**
 * Oathbreaker's command zone is a pair rather than a commander: a planeswalker and an instant
 * or sorcery, and the spell must fit inside the planeswalker's colour identity.
 *
 * **Partner oathbreakers are legal**, and the format's own rules say so: two oathbreakers whose
 * planeswalkers have a partner ability bring **two** signature spells, one each. Four
 * oathbreaker-legal planeswalkers carry one today — Tevesh Szat, Jeska Thrice Reborn, Rowan
 * Kenrith and Will Kenrith — and Tevesh + Jeska is a staple pairing, so refusing it would be
 * two confident wrong sentences about a real deck. CR 702.124 does the pairing here exactly as
 * it does for commanders; a mixed or partnerless pair still errors.
 *
 * The signature spell is not judged by {@link commanderIneligibility} — an instant is not a
 * planeswalker and never will be. Anything that is neither is.
 */
function oathbreakerZoneIssues(zone: CardFacts[], spec: FormatSpec): ValidationIssue[] {
  const format = spec.displayName;
  if (zone.length === 0) {
    return [
      error(
        "commander-missing",
        `${format} decks need an oathbreaker and a signature spell; the commander zone is empty.`,
      ),
    ];
  }

  const issues: ValidationIssue[] = [];
  const walkers = zone.filter(isPlaneswalkerCard);
  const spells = zone.filter(isInstantOrSorcery);
  for (const card of zone) {
    if (walkers.includes(card) || spells.includes(card)) continue;
    const why = commanderIneligibility(card, "oathbreaker", spec);
    if (why !== null) issues.push(error("commander-eligibility", why, [card.cardId]));
  }

  if (walkers.length === 0) {
    issues.push(
      error(
        "commander-missing",
        `${format} decks need an oathbreaker: one planeswalker in the command zone.`,
      ),
    );
  } else if (walkers.length === 2) {
    // The same 702.124 machinery, so "Tevesh Szat has partner, but X does not" is the sentence
    // an unpartnered second oathbreaker gets — one pairing rule, not two.
    const pair = pairingOf(walkers[0], walkers[1]);
    if (!pair.ok) {
      issues.push(
        error(
          "commander-partner",
          pair.message,
          walkers.map((card) => card.cardId),
        ),
      );
    }
  } else if (walkers.length > 2) {
    issues.push(
      error(
        "commander-count",
        `${format} decks have at most two oathbreakers, and only with a partner ability; you ` +
          `have ${walkers.length}.`,
      ),
    );
  }

  // One signature spell **per oathbreaker**: a partner pair brings two. The cap never exceeds
  // two, because more than two oathbreakers is already its own error.
  const spellCap = Math.max(1, Math.min(walkers.length, 2));
  if (spells.length === 0) {
    issues.push(
      error(
        "commander-missing",
        `${format} decks need a signature spell: one instant or sorcery in the command zone.`,
      ),
    );
  } else if (spells.length > spellCap) {
    // The sentence quotes the **cap**, never `walkers.length`. Above two oathbreakers the two
    // numbers come apart, and a per-walker denominator then reads "you have 3 for 3
    // oathbreakers" — a sentence stating a rule its own numbers keep. The count error just
    // above has already said there are too many oathbreakers; this one says how many signature
    // spells the zone can hold whatever that count turns out to be.
    issues.push(
      error(
        "commander-count",
        spellCap === 1
          ? `${format} decks have one signature spell; you have ${spells.length}.`
          : `${format} decks have one signature spell for each oathbreaker and at most two ` +
              `oathbreakers, so at most two; you have ${spells.length}.`,
      ),
    );
  }

  // The one place a command-zone card is measured against another one — and with a partner pair
  // it is measured against the **combined** identity, the same union the deck is held to.
  //
  // That union is this app's deliberate reading, not the format's rule. Oathbreaker asks each
  // signature spell to fit inside *its own* oathbreaker; a zone-level check has no
  // spell→walker assignment to read, so holding both spells to both identities is the
  // permissive answer — it lets a Sultai spell through beside a Dimir and a Simic oathbreaker
  // rather than guessing which one it was chosen for and refusing a legal deck. It
  // under-reports and never invents. (CR 702.124c is the analogy — see `unionIdentity`.)
  //
  // Outside the walker-count branches on purpose: two oathbreakers must not switch it off.
  if (walkers.length > 0) {
    const oathbreakers = unionIdentity(walkers);
    const possessive = walkers.length > 1 ? "oathbreakers'" : "oathbreaker's";
    for (const spell of spells) {
      const identity = identityOf(spell);
      if ([...identity].every((colour) => oathbreakers.has(colour))) continue;
      issues.push(
        error(
          "color-identity",
          `${spell.name}'s color identity (${nameIdentity(identity)}) is outside your ` +
            `${possessive} (${nameIdentity(oathbreakers)}); a signature spell must fit inside it.`,
          [spell.cardId],
        ),
      );
    }
  }
  return issues;
}

/**
 * TRAP A's second meaning: in Duel Commander and Tiny Leaders: Reborn, Scryfall's
 * `"restricted"` is *banned as a commander* — a max-one reading would be no restriction at
 * all in a format that is already singleton. It is a **commander-zone** rule, and the main
 * deck stays silent about it (Task 8 routes by `restrictedSemantic` and returns nothing).
 */
function bannedAsCommanderIssues(zone: CardFacts[], spec: FormatSpec): ValidationIssue[] {
  if (!spec.hasLegalityData || spec.restrictedSemantic !== "banned_as_commander") return [];
  const issues: ValidationIssue[] = [];
  for (const card of zone) {
    if (legalityStatus(card, spec.key) !== "restricted") continue;
    issues.push(
      error("commander-banned", `${card.name} is banned as a commander in ${spec.displayName}.`, [
        card.cardId,
      ]),
    );
  }
  return issues;
}

/** `legalities` is a JSON object string — unlike `colors`/`colorIdentity`. Parsed here rather
 *  than handed in: the commander zone is one or two rows, and the signature the plan fixed
 *  for this module takes a zone and a spec and nothing else. */
function legalityStatus(card: CardFacts, key: string): string | null {
  if (card.legalities === null) return null;
  let blob: unknown;
  try {
    blob = JSON.parse(card.legalities);
  } catch {
    return null;
  }
  if (blob === null || typeof blob !== "object" || Array.isArray(blob)) return null;
  const status = (blob as Record<string, unknown>)[key];
  return typeof status === "string" ? status : null;
}

function error(code: string, message: string, cardIds?: string[]): ValidationIssue {
  return cardIds
    ? { severity: "error", code, message, cardIds }
    : { severity: "error", code, message };
}
