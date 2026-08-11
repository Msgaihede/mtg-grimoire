/**
 * The Commander bracket, estimated — **an advisory and never a verdict**.
 *
 * Brackets are Wizards' beta power-level scale for Commander (1 Exhibition … 5 cEDH), and the
 * research doc is precise about what they are: *"5 brackets; B3 ≤ 3 game changers; advisory
 * only, not hard validation."* So this module returns an {@link BracketEstimate} rather than
 * {@link ValidationIssue}s, and nothing it computes can make a deck illegal. A bracket is a
 * conversation opener between four players at a table, and an app that turned one into a red
 * error would be answering a question nobody asked it.
 *
 * Three signals, in decreasing order of how well this app can see them:
 *
 * * **Game Changers** are a *column* (`cards.game_changer`), maintained by the Commander
 *   Format Panel and delivered by a sync — 53 cards on 2026-08-04 and growing. Nothing here
 *   hardcodes the list, which is the whole reason the count is trustworthy.
 * * **Mass land denial** and **extra turns** are read out of oracle text, so they are
 *   heuristics with names attached. The estimate discloses the cards behind each number for
 *   exactly that reason: a reader who disagrees can see which card caused it.
 * * **Tutors** are the weakest of the three and are used only to keep a deck off bracket 1.
 *
 * What this module deliberately does **not** try to see: infinite combos, two-card win
 * conditions, and the "early game" timing that separates brackets 3 and 4 in the real
 * document. They need a card-interaction model this app does not have, and guessing at them
 * would make the number worse rather than more precise.
 */
import type { CardFacts } from "./types";

/** A reading of a deck's power level: the number, and everything it was read from. */
export interface BracketEstimate {
  /** 1–5, a heuristic reading, never enforced. */
  bracket: number;
  gameChangers: number;
  /** The cards behind the number, for the panel's disclosure. */
  gameChangerNames: string[];
  massLandDenial: string[];
  extraTurns: string[];
}

/**
 * A card's whole printed text, every face included, lowercased once for the greps below.
 *
 * `faces` is JSON — unlike `colors`/`colorIdentity` — and a blob this module cannot read is no
 * faces at all rather than a thrown error, because a bracket estimate must not be the thing
 * that breaks a deck screen.
 */
function textOf(card: CardFacts): string {
  const parts = [card.oracleText ?? ""];
  if (card.faces !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(card.faces);
    } catch {
      parsed = null;
    }
    if (Array.isArray(parsed)) {
      for (const face of parsed as Record<string, unknown>[]) {
        if (face !== null && typeof face === "object" && typeof face.oracle_text === "string") {
          parts.push(face.oracle_text);
        }
      }
    }
  }
  return parts.join("\n").toLowerCase();
}

/** Sentences, roughly — enough to keep "destroy all creatures" and a later mention of lands
 *  from being read as one clause. */
function sentencesOf(text: string): string[] {
  return text.split(/[.\n]/);
}

/**
 * The word `lands`, and **only** the word.
 *
 * A substring test reads `Islands` and `Highlands` as `lands`, which is how Pirate Ship and
 * Walk the Aeons came to be mass land denial — **twenty** cards, nearly every one of them an
 * old blue creature that cares about Islands. The boundary is the whole fix for that half.
 */
const LANDS = /\blands\b/;

/**
 * Who a sacrifice is aimed at.
 *
 * "Sacrifice" and "lands" in one sentence is a *cost* far more often than it is denial —
 * Lotus Field, Lotus Vale, Mana Seism, Devastating Summons, every `Kicker—Sacrifice two lands`
 * — and one hit here pins the whole estimate at bracket 5. Real mass land denial is written at
 * the table: `each player`, `each opponent`, or `all lands`.
 */
const TABLE_FACING = /each player|each opponent|all lands/;

/**
 * Mass land denial, read a sentence at a time.
 *
 * The printed shapes, all four of them live: `"Destroy all lands."` (Armageddon),
 * `"Destroy all nonbasic lands."` (Ruination), `"Destroy all artifacts, creatures, and
 * lands."` (Jokulhaups) and `"Each player sacrifices four lands of their choice."` (Wildfire).
 * One phrase cannot cover them, so the test is a sentence about **`lands`** plus either
 * `destroy all` or a {@link TABLE_FACING} sacrifice.
 *
 * The last clause is the one that keeps a board wipe out: `"Destroy all permanents except for
 * artifacts and lands"` (Scourglass) names lands only as the things it *spares*. Where every
 * mention of them falls after an `except`, the sentence is about what survives — and where one
 * falls before it, as in Keldon Firebombers' `"sacrifices all lands they control except for
 * three"`, it is denial with a remainder.
 *
 * Measured on the live corpus (2026-08-05) as **this function reads it** — every face's text,
 * not just the row's — the three clauses come off one at a time:
 *
 *     105  the naive test          →  85  word boundary  →  42  table-facing  →  39  except
 *
 * and every one of the well-known pieces survives the cut: Armageddon, Ravages of War,
 * Ruination, Jokulhaups, Obliterate, Decree of Annihilation, Wildfire, Death Cloud, Pox,
 * Catastrophe, Devastation, Global Ruin, Tectonic Break, Fall of the Thran, From the Ashes.
 */
function isMassLandDenial(text: string): boolean {
  return sentencesOf(text).some((sentence) => {
    if (!LANDS.test(sentence) || sparesTheLands(sentence)) return false;
    if (sentence.includes("destroy all")) return true;
    return sentence.includes("sacrific") && TABLE_FACING.test(sentence);
  });
}

/** Every mention of lands sits after an `except`, so the sentence lists what it leaves alone. */
function sparesTheLands(sentence: string): boolean {
  const except = sentence.indexOf("except");
  return except >= 0 && sentence.slice(0, except).search(LANDS) < 0;
}

/**
 * Shutting extra turns off is not taking one.
 *
 * Stranglehold, Trouble in Pairs and Gerrard's Hourglass Pendant say `"If a player would begin
 * an extra turn, that player skips that turn instead."` and nothing else about turns — three of
 * the 68 cards in the corpus that mention an extra turn, and the only three that take none.
 */
const TURN_DENIAL = /extra turn[^.\n]*?skips that turn|skips that turn[^.\n]*?instead/;

/**
 * `"Take an extra turn after this one."` and every variant of it, plurals included.
 *
 * **Read a sentence at a time, and that is the rule rather than this file's habit.** Ugin's
 * Nexus does both things: it denies the table's extra turns in its first sentence and hands its
 * controller one in its second (`"instead exile it and take an extra turn after this one"`). It
 * is a Commander-legal extra-turn engine, and a card that says one denial sentence anywhere
 * must not be able to hide every turn it grants — the whole text tested at once loses exactly
 * this card, and it is the only card in the corpus the two readings disagree about (65 against
 * 64).
 */
function isExtraTurn(text: string): boolean {
  return sentencesOf(text).some(
    (sentence) => sentence.includes("extra turn") && !TURN_DENIAL.test(sentence),
  );
}

/**
 * A tutor is a card that finds **a card**, not a card that finds a land.
 *
 * `"Search your library for a basic land card"` is ramp, and a deck full of ramp is still an
 * exhibition deck; a fetchland's `"Sacrifice this land: Search your library for a Plains or
 * Island card"` is the same sentence with the same word in it. So the sentence that searches
 * must not also be about lands. Used for one thing only — telling bracket 1 from bracket 2 —
 * because that is as much weight as a grep this rough can carry.
 */
function isTutor(text: string): boolean {
  return sentencesOf(text).some(
    (sentence) => sentence.includes("search your library") && !sentence.includes("land"),
  );
}

/**
 * A reading of this deck's bracket.
 *
 * An inactive category is dropped for the same reason every rule in `engine.ts` drops one — a
 * pile the user switched off is not the deck, and the seeded Maybeboard is only the commonest
 * of those. Everything else counts, the companion included: it is a card the deck plays.
 *
 * Cards are counted **by name**, once each. In Commander that is also the number of copies,
 * and in a format where it is not, "this deck runs Rhystic Study" is still one fact about it.
 */
export function estimateBracket(cards: CardFacts[]): BracketEstimate {
  const deck = cards.filter((card) => card.categoryActive);

  const gameChangerNames: string[] = [];
  const massLandDenial: string[] = [];
  const extraTurns: string[] = [];
  let tutors = 0;

  const seen = new Set<string>();
  for (const card of deck) {
    if (seen.has(card.name)) continue;
    seen.add(card.name);
    // `gameChanger` is `boolean | null`: an orphaned row knows nothing about itself, and a
    // `null` must not be counted in either direction.
    if (card.gameChanger === true) gameChangerNames.push(card.name);
    const text = textOf(card);
    if (isMassLandDenial(text)) massLandDenial.push(card.name);
    if (isExtraTurn(text)) extraTurns.push(card.name);
    if (isTutor(text)) tutors += 1;
  }

  return {
    bracket: bracketFor(gameChangerNames.length, massLandDenial.length, extraTurns.length, tutors),
    gameChangers: gameChangerNames.length,
    gameChangerNames,
    massLandDenial,
    extraTurns,
  };
}

/**
 * The mapping, in one table, paraphrasing the Commander Format Panel's brackets beta (the
 * `magic.wizards.com/en/formats/commander` document the research doc points at; the numbered
 * cell it pins is B3's "≤ 3 game changers").
 *
 *     mass land denial, or more than 6 Game Changers  →  5   nothing above this is restricted
 *     4–6 Game Changers                               →  4   optimized
 *     1–3 Game Changers                               →  3   upgraded — B3's own ceiling
 *     extra turns and nothing else                    →  3   the same shelf, softer reason
 *     a tutor for any card                            →  2   core
 *     none of the above                               →  1   exhibition
 *
 * Every row is a **judgement**, and three of them are this app's rather than the document's:
 *
 * * **mass land denial → 5.** The real text makes it a bracket-4-and-up signal; it is a 5 here
 *   because a deck that plays it has decided something about the table.
 * * **more than 6 Game Changers → 5.** The document names a ceiling for bracket 3 and none
 *   above it, so where the line between 4 and 5 falls is this file's guess and nobody else's.
 * * **extra turns → 3.** A 4 in the real text, read as a 3 here because one Time Warp is not
 *   a turn chain.
 *
 * The number *moving* is the point; the digit is not evidence of anything.
 */
function bracketFor(
  gameChangers: number,
  massLandDenial: number,
  extraTurns: number,
  tutors: number,
): number {
  if (massLandDenial > 0 || gameChangers > 6) return 5;
  if (gameChangers >= 4) return 4;
  if (gameChangers >= 1 || extraTurns > 0) return 3;
  return tutors > 0 ? 2 : 1;
}
