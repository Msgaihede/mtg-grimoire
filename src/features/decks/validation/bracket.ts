/**
 * The Commander bracket, estimated — **a floor, an advisory, and never a verdict**.
 *
 * Brackets are the Commander Format Panel's power-level scale (1 Exhibition … 5 cEDH), and
 * every published word about them says the same thing: they are a conversation opener between
 * four players at a table, "advisory only, not hard validation". So this module returns a
 * {@link BracketEstimate} rather than {@link ValidationIssue}s, nothing it computes can make a
 * deck illegal, and {@link bracketWarning}'s one sentence is written to be read as a remark
 * rather than as an error.
 *
 * ## What it reads, and how well it can see each one
 *
 * * **Game Changers** are a *column* (`cards.game_changer`), maintained by the panel and
 *   delivered by a sync — 53 cards on 2026-08-04, plus `Farewell` and `Biorhythm` from the
 *   2026-02-09 update, and growing. Nothing here hardcodes the list, which is the whole reason
 *   the count is trustworthy.
 * * **Mass land denial** and **extra turns** are read out of oracle text, so they are
 *   heuristics with names attached. The estimate discloses the cards behind each number for
 *   exactly that reason: a reader who disagrees can see which card caused it.
 * * **Two-card infinite combos** are a fact about an *interaction* and cannot be read out of
 *   any card's own text. They arrive as {@link DeckCombo}s from Commander Spellbook's bulk
 *   file, each already carrying that project's editors' own `bracketTag` — so this app never
 *   has to decide what "an intentional early-game combo" is. **A database that has never
 *   fetched that file is a supported state**: `combos` defaults to empty and the estimate
 *   reads three signals instead of four. That is the floor working, not an error.
 *
 * What it still deliberately does **not** try to see: the "expected earliest game-ending turn"
 * that the 21 October 2025 update re-based every bracket on. That is a claim about how a deck
 * plays, and no list of cards answers it.
 *
 * ## Why a floor and not a bracket
 *
 * Every bracket restriction is written as a prohibition — bracket 2 may not play mass land
 * denial, bracket 3 may play at most three Game Changers — so what a card list can honestly
 * answer is always "not allowed below N", never "is N". {@link BracketEstimate.floor} is that
 * number, and it is why a *set* bracket can be checked against it at all: a deck told it is
 * bracket 2 that reads as a floor of 4 is a mismatch worth a sentence, and a deck told it is
 * bracket 5 never is.
 *
 * ## Why the floor is never 5
 *
 * It used to be, and a reader who remembers `bracket: 5` should know where it went.
 * **Brackets 4 and 5 have identical *deck* restrictions.** Both allow unlimited Game Changers,
 * mass land denial, extra turns and combos; what separates them is whether the deck is built
 * for the cEDH metagame, which is an intent no card list shows. An estimator that reads card
 * contents can therefore never honestly return 5, so this one does not. A reader who is
 * playing cEDH sets the bracket by hand, which is the whole reason that control exists.
 *
 * ## Why tutors are gone
 *
 * The [21 October 2025 update](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-october-21-2025)
 * **removed the tutor limits from every bracket**; the table reads "unrestricted" in all five
 * rows. This module used to carry an `isTutor` grep, and it was the *only* thing separating
 * its bracket 1 from its bracket 2 — so deleting it would have collapsed the bottom of the
 * scale had nothing taken the job. **Extra turns took it**: bracket 1 forbids them outright,
 * and bracket 2 allows them "in low quantities … not intended to be chained in succession or
 * looped". One Time Warp is now what lifts a deck off the floor.
 *
 * Full record: `docs/superpowers/research/2026-08-27-commander-brackets-and-combos.md`.
 */
import type { DeckCombo } from "@/lib/ipc";
import type { CardFacts } from "./types";

/**
 * One rule that set the floor, and what it read.
 *
 * Every entry in {@link BracketEstimate.reasons} forces the floor the estimate reports — a
 * rule that fired at a *lower* bracket is not a reason, it is just a signal, and the named
 * lists on the estimate are where those live. That is what makes the number arguable rather
 * than oracular: a reader who disagrees with a 4 can see the one rule responsible for it and
 * the cards that rule read.
 */
export interface BracketReason {
  /**
   * Stable machine handle, so a panel can group by it and a test can name one without matching
   * prose — the same contract {@link ValidationIssue.code} holds.
   */
  code: "game-changers" | "mass-land-denial" | "extra-turns" | "combo";
  /** The bracket this rule alone forces: 2, 3 or 4. Never 1, and never 5. */
  floor: number;
  /**
   * The card names behind it — the Game Changers, the denial, the extra-turn cards, or the
   * combo's own cards in the order Spellbook lists them.
   */
  cards: string[];
  /** The combo behind a `"combo"` reason, and absent on every other. */
  combo?: DeckCombo;
}

/** A reading of a deck's power level: the floor, and everything it was read from. */
export interface BracketEstimate {
  /**
   * **1–4, and never 5** — the lowest bracket this deck is allowed in, not the bracket it is.
   * See the module header for where 5 went.
   */
  floor: number;
  gameChangers: number;
  /** The cards behind the number, for the panel's disclosure. */
  gameChangerNames: string[];
  massLandDenial: string[];
  extraTurns: string[];
  /**
   * Combos the deck **definitely** has: every card they name is in it, and they need nothing
   * else. These are the ones that feed the floor.
   */
  combos: DeckCombo[];
  /**
   * Combos whose named cards are all present but which also need a *template* — "a creature
   * with flying", "a way to sacrifice a creature" — which this app cannot check against a
   * card list.
   *
   * They are kept out of the arithmetic and shown to the reader anyway, and both halves of
   * that matter. Counting them would raise a floor on a combo the deck may well not have;
   * dropping them silently would hide a real interaction from the one person who *can* tell
   * whether the template is there. Neither failure is visible from the outside, which is why
   * the split is a field rather than a filter.
   */
  possibleCombos: DeckCombo[];
  /** Every rule that set or matched {@link floor}. Empty exactly when the floor is 1. */
  reasons: BracketReason[];
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
 * — and one hit here pins the whole estimate at bracket 4. Real mass land denial is written at
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
 *
 * **Unchanged by the October 2025 rewrite, and deliberately so.** What that update moved is
 * what the *mapping* does with a hit — bracket 4 now, not bracket 5 — and not one word of what
 * counts as a hit.
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
 *
 * **This grep carries more weight than it used to.** Until October 2025 it lifted a deck off
 * bracket 1 alongside a tutor grep; the tutors are gone and extra turns now hold that line
 * alone, because bracket 1 is the one bracket that forbids them outright.
 */
function isExtraTurn(text: string): boolean {
  return sentencesOf(text).some(
    (sentence) => sentence.includes("extra turn") && !TURN_DENIAL.test(sentence),
  );
}

/**
 * Spellbook's `bracketTag`, as a floor. **This table is the whole of what this app decides
 * about combos** — the editors of Commander Spellbook classified each variant, the ingest
 * carries their letter through unread, and this turns the letter into a number.
 *
 *     R  Ruthless     "for competitive decks at brackets 4+"          →  4
 *     S  Spicy        "probably 3 or 4, but hard to classify"         →  3
 *     P  Powerful     "for strong decks in bracket 3+"                →  3
 *     O  Oddball      "probably 2 or 3, but hard to classify"         →  2
 *     C  Core         "for unoptimized decks in bracket 2+"           →  2
 *     E  Exhibition   "for any deck"                                  →  nothing
 *     B  Banned       "not legal in Commander"                        →  nothing
 *
 * The two `null`s are not oversights. **`E` says the combo is fine at bracket 1**, which is the
 * floor already, so it can only raise a deck's reading by mistake. **`B` is a legality finding,
 * not a power one** — the cards in it are banned, `engine.ts` already says so from the banned
 * list, and a bracket estimate that quietly re-reported it as power level would be answering a
 * different question with the same words. Both still appear in
 * {@link BracketEstimate.combos}, because the reader should see what their deck does.
 *
 * `S` and `O` take the *lower* of the two brackets Spellbook hedges between, which is the only
 * reading a floor can honestly give: "probably 3 or 4" is not evidence a deck is barred from 3.
 */
const COMBO_FLOOR: Record<DeckCombo["bracketTag"], number | null> = {
  R: 4,
  S: 3,
  P: 3,
  O: 2,
  C: 2,
  E: null,
  B: null,
};

/**
 * A reading of this deck's bracket floor.
 *
 * An inactive category is dropped for the same reason every rule in `engine.ts` drops one — a
 * pile the user switched off is not the deck, and the seeded Maybeboard is only the commonest
 * of those. Everything else counts, the companion included: it is a card the deck plays.
 *
 * Cards are counted **by name**, once each. In Commander that is also the number of copies,
 * and in a format where it is not, "this deck runs Rhystic Study" is still one fact about it.
 *
 * **`combos` is optional and empty is a real answer, not a missing one.** A database that has
 * never fetched Commander Spellbook's bulk file has no combo rows to hand over, and the
 * estimate it gets back reads three signals instead of four. The caller — and only the caller
 * — knows which of those two an empty list is: `combosStatus()` reports whether anything was
 * ever ingested, and the panel says so in words rather than implying the deck has no combos.
 *
 * **The combos handed in are not re-checked here.** They were matched by oracle id against a
 * set of card ids the caller chose, so a caller that queried with rows from a switched-off
 * pile gets back a combo this deck does not really play — and this module cannot tell. The
 * card ids passed to `combosForCards` must come from the same active-category filter applied
 * to `cards` below.
 */
export function estimateBracket(
  cards: CardFacts[],
  combos: readonly DeckCombo[] = [],
): BracketEstimate {
  const deck = cards.filter((card) => card.categoryActive);

  const gameChangerNames: string[] = [];
  const massLandDenial: string[] = [];
  const extraTurns: string[] = [];

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
  }

  // `=== 0` for the definite half and everything else for the possible one, rather than
  // `> 0` on both sides: the split has to be total, and a `templateCount` this app cannot
  // make sense of must land on the side that raises nothing.
  const definite = combos.filter((combo) => combo.templateCount === 0);
  const possibleCombos = combos.filter((combo) => combo.templateCount !== 0);

  const fired = rulesThatFired(gameChangerNames, massLandDenial, extraTurns, definite);
  const floor = fired.reduce((high, reason) => Math.max(high, reason.floor), 1);

  return {
    floor,
    gameChangers: gameChangerNames.length,
    gameChangerNames,
    massLandDenial,
    extraTurns,
    combos: definite,
    possibleCombos,
    reasons: fired.filter((reason) => reason.floor === floor),
  };
}

/**
 * Every rule that fired, each carrying the floor it alone forces. The caller keeps the highest
 * and reports the rules that reached it; a rule that fired lower is a signal the panel still
 * lists by name, and is not a *reason* for the number.
 *
 * The mapping, in one table:
 *
 *     4  ≥ 4 Game Changers · any mass land denial · ≥ 3 extra-turn cards · a combo tagged R
 *     3  1–3 Game Changers · a combo tagged P or S
 *     2  any extra-turn card · a combo tagged C or O
 *     1  none of the above
 *
 * Three of those cells deserve their provenance stated, because two are the document's and one
 * is not:
 *
 * * **≥ 4 Game Changers → 4** is the document's, read off the only numbered cell in it: bracket
 *   3 allows "up to 3", so a fourth is what puts a deck past it. Bracket 4 names no ceiling and
 *   neither does this.
 * * **Any mass land denial → 4** is the document's. It was a **5** here until this rewrite, on
 *   the argument that a deck playing it "has decided something about the table" — an over-read
 *   this file made on purpose and which the current text simply contradicts. One Armageddon
 *   does not make a cEDH deck.
 * * **≥ 3 extra-turn cards → 4 is this app's judgement and not the document's.** Brackets 2 and
 *   3 both allow extra turns "in low quantities … not intended to be chained in succession or
 *   looped", and the document never says what a low quantity is. Three is where this app draws
 *   chaining. Below it they still fire, at 2, which is the line bracket 1 draws by forbidding
 *   them outright.
 *
 * Order matters only for {@link bracketWarning}, which prints the first reason it is given:
 * the three signals read from data this app always has come before the combos, which are a
 * fourth signal a database may not have at all.
 */
function rulesThatFired(
  gameChangerNames: string[],
  massLandDenial: string[],
  extraTurns: string[],
  combos: readonly DeckCombo[],
): BracketReason[] {
  const fired: BracketReason[] = [];

  if (gameChangerNames.length >= 4) {
    fired.push({ code: "game-changers", floor: 4, cards: [...gameChangerNames] });
  } else if (gameChangerNames.length >= 1) {
    fired.push({ code: "game-changers", floor: 3, cards: [...gameChangerNames] });
  }

  if (massLandDenial.length >= 1) {
    fired.push({ code: "mass-land-denial", floor: 4, cards: [...massLandDenial] });
  }

  if (extraTurns.length >= 3) {
    fired.push({ code: "extra-turns", floor: 4, cards: [...extraTurns] });
  } else if (extraTurns.length >= 1) {
    fired.push({ code: "extra-turns", floor: 2, cards: [...extraTurns] });
  }

  for (const combo of combos) {
    // `?? null` and not a lookup taken on trust: `bracketTag` comes out of a bulk file this
    // app does not control, and a letter Spellbook adds later must raise nothing rather than
    // reading as `undefined` and poisoning the `Math.max`.
    const floor = COMBO_FLOOR[combo.bracketTag] ?? null;
    if (floor !== null) fired.push({ code: "combo", floor, cards: [...combo.cards], combo });
  }

  return fired;
}

/**
 * How many names a sentence is allowed to carry before it starts counting instead.
 *
 * The advisory panel lists every name it read and should; a *sentence* that did the same would
 * run to nine card names on the kind of deck that trips this warning, and a sentence nobody
 * finishes reading says nothing. Three is enough to recognise the deck.
 */
const NAMES_IN_A_SENTENCE = 3;

function nameList(names: string[]): string {
  if (names.length <= NAMES_IN_A_SENTENCE) return names.join(", ");
  const shown = names.slice(0, NAMES_IN_A_SENTENCE).join(", ");
  return `${shown} and ${names.length - NAMES_IN_A_SENTENCE} more`;
}

/**
 * One reason as a noun phrase, ready to be dropped into a sentence.
 *
 * Exported because the advisory panel and {@link bracketWarning} must not word the same fact
 * two different ways — a reader who sees "3 extra-turn cards" on the button and "extra turns"
 * in the panel is being told about two things.
 *
 * A combo names **all** its cards rather than the first three, because a combo is the set: the
 * ingest can never produce one with no cards in it (the match query joins on
 * `have = card_count`, so a zero-card combo could never match a deck).
 */
export function describeReason(reason: BracketReason): string {
  const n = reason.cards.length;
  switch (reason.code) {
    case "game-changers":
      return `${n} Game Changer${n === 1 ? "" : "s"}: ${nameList(reason.cards)}`;
    case "mass-land-denial":
      return `mass land denial: ${nameList(reason.cards)}`;
    case "extra-turns":
      return `${n} extra-turn card${n === 1 ? "" : "s"}: ${nameList(reason.cards)}`;
    case "combo":
      return `the combo ${reason.cards.join(" + ")}`;
  }
}

/**
 * The deck's *set* bracket against its estimated floor, in one sentence — or `null`, which is
 * the answer most of the time.
 *
 * `set` is `decks.bracket`, where **`0` means Auto** (`AUTO_BRACKET` in `@/lib/ipc`, mirroring
 * `AUTO_CATEGORY`). The sentinel is compared here rather than imported so that this module
 * stays a pure function of its two arguments, and anything below 1 is read as Auto: a deck
 * that has not been told what it is cannot be told it is wrong.
 *
 * Three things it will not do, each of them on purpose:
 *
 * * **It never fires upward.** A deck set to bracket 4 whose floor reads 2 is a perfectly
 *   ordinary thing — a bracket is a ceiling the table agreed on, and playing under it is not a
 *   mistake. Only a set bracket *below* the floor is a mismatch.
 * * **It never says "illegal", "invalid" or "must".** The floor is built out of two oracle-text
 *   greps and a third party's classification of a combo, and the reader is the one who knows
 *   whether their playgroup cares. The sentence hands them the fact and the reason for it and
 *   stops there.
 * * **It names one reason, not all of them.** Every entry in `estimate.reasons` forces the same
 *   floor, so there is no strongest one to find; the first is the one this app read most
 *   directly, and the panel behind the button lists the rest.
 */
export function bracketWarning(set: number, estimate: BracketEstimate): string | null {
  if (set < 1) return null;
  if (estimate.floor <= set) return null;
  // Unreachable in practice — a floor above 1 is a floor some rule set — and a guard rather
  // than a case: `reasons` is empty exactly when the floor is 1, and a floor of 1 is at or
  // below every settable bracket.
  if (estimate.reasons.length === 0) return null;

  return (
    `Set to bracket ${set}, but this deck reads as bracket ${estimate.floor} or higher ` +
    `(${describeReason(estimate.reasons[0])}) — worth a word with the table before the game.`
  );
}
