/**
 * Where every line of a decklist is going, and what the preview says about the ones that are
 * not going anywhere.
 *
 * Pure, and deliberately so: this is the domain logic the spec keeps on this side of the IPC
 * boundary. Rust answered two questions no amount of TypeScript could — "which printing", which
 * is a question about 116 k rows, and "what does this card *do*", which is Scryfall Tagger's
 * hand-curated vocabulary in a table — and neither answer says a word about *which pile*. Which
 * pile a Sol Ring belongs in, and which card is the commander, are decisions about a deck, and
 * every one of them is made here.
 *
 * **The tag slugs arrive as an argument, and that is what keeps this file pure.** Fetching them
 * is IO, IO belongs in `useImport`, and a planning function that reached for the network
 * could no longer be called synchronously by a test or a preview. So the caller makes **one**
 * read for the whole list and hands the answers in; see {@link buildImportPlan}.
 *
 * **This is not an add path, and it must never become one.** `useDeck.addCard` files a single
 * add by the same rule ({@link autoCategoryFor}, applied on its one definition), and routing an
 * import through it would send one write per line — 105 transactions and 105 allocator runs for
 * the reference list. `deck_import_commit` exists to be one of each; {@link toImportItems} is
 * what feeds it. The tag read obeys the same arithmetic: **one call for the list**, never one
 * per line.
 */
import type {
  DeckFinish,
  FormatSpec,
  ImportItem,
  ImportMatch,
  ImportResolveRow,
  PrintingTags,
} from "@/lib/ipc";
import {
  AUTO_CATEGORY_DISPLAY_ORDER,
  PREDEFINED_CATEGORY_NAMES,
  UNCATEGORIZED,
  autoCategoryFor,
} from "@/features/decks/autoCategory";
import { commanderIneligibility } from "@/features/decks/validation/commanders";
import type { CardIdentity } from "@/features/decks/validation/types";
import type { ParseIssue, ParsedLine, ParsedList, SectionKind } from "../parse";

/**
 * What a section heading calls the pile it opens.
 *
 * **The four names are the four `schema::PREDEFINED_CATEGORIES` seeds, spelled exactly**, and
 * that spelling is the whole of the mechanism: `category_for_name` finds-or-creates **by name
 * alone**, so `Sideboard` lands on the deck's seeded `side` row and a fifth spelling — `Side
 * board`, `Sideboard (15)` — would quietly make a second pile with a `main` kind beside it.
 * {@link PREDEFINED_CATEGORY_NAMES} is the list to check a change against, and `plan.test.ts`
 * sweeps these values against it for that reason.
 *
 * `deck` is not a key: a line in the deck section is filed by the app's auto rule — Land, then
 * what the card does, then what it is — which is the next function down. `satisfies` rather
 * than a type annotation so the strings stay literal *and* a
 * new {@link SectionKind} arm fails to compile here rather than filing itself under `undefined`.
 */
export const SECTION_CATEGORY = {
  commander: "Commander",
  sideboard: "Sideboard",
  companion: "Companion",
  maybeboard: "Maybeboard",
} as const satisfies Record<Exclude<SectionKind, "deck">, string>;

/**
 * The one seeded category that arrives switched off.
 *
 * **This is a fact about that row, not about its kind.** `is_active = 0` is the whole of what
 * `maybe` used to mean and nothing anywhere may branch on a kind being `maybe` — a reader who
 * switches off a pile of their own gets exactly this behaviour from the same flag. What the
 * tally is saying is "these cards will land in a pile that counts toward nothing", which is
 * worth saying *before* an import rather than after it.
 *
 * **It is one of two ways a tally row reads inactive, not the only one**, since a file can say so
 * itself: Archidekt's `{noDeck}` arrives as {@link ImportItem.inactive} and {@link tallyOf} ORs
 * the two. This one is a fact about a row the deck already has; that one is a fact about a pile
 * the import is about to make.
 */
const SEEDED_INACTIVE: string = SECTION_CATEGORY.maybeboard;

/**
 * The order the preview lists piles in: the four sections first, in the order a deck seeds
 * them, then every bucket the auto rule can answer with in reading order — the functional
 * piles, then the type ones, with Land last — then the fallback.
 *
 * Derived from the two published orders rather than typed out, so a bucket added to
 * `autoCategory.ts` appears here without a second edit. That is not hypothetical: the thirteen
 * functional names arrived in {@link AUTO_CATEGORY_DISPLAY_ORDER} and this list needed no edit
 * at all, which is the whole of why it is derived.
 */
const TALLY_ORDER: readonly string[] = [
  ...PREDEFINED_CATEGORY_NAMES,
  ...AUTO_CATEGORY_DISPLAY_ORDER,
  UNCATEGORIZED,
];

/** One line that is going into the deck: the printing it resolved to, how many, and where. */
export interface PlannedCard {
  /** 1-based and counted over the pasted text, so the preview can quote the line back. */
  lineNumber: number;
  match: ImportMatch;
  quantity: number;
  /** A **name**, never an id — the piles an imported list names may not exist yet, and
   *  `deck_import_commit` finds-or-creates each one. */
  categoryName: string;
  /** The file said this pile counts toward nothing — Archidekt's `{noDeck}`. It rides to
   *  `ImportItem.inactive`, where it switches off **only a pile the import creates**. */
  excluded: boolean;
  /** The line's `*F*` / `*E*` marker. Carried straight through: a finish is a fact about the
   *  object, so nothing in this module decides anything about it. */
  finish: DeckFinish;
}

/** A line no printing answered. Quoted back, never an error: the import proceeds without it. */
export interface UnmatchedLine {
  lineNumber: number;
  raw: string;
  name: string;
}

/**
 * A line whose `(SET) 123` this app has no printing for, and the printing that answered
 * instead.
 *
 * Only ever recorded for a line that **matched**: a missed hint whose name also matched nothing
 * is an {@link UnmatchedLine} and nothing was used, which is why `used` is not nullable.
 */
export interface HintMiss {
  lineNumber: number;
  name: string;
  /** `"LTC 285"` — the set code as a card prints it, in capitals, and the collector number
   *  verbatim. `cards.set_code` is stored lowercase; upper-casing is the renderer's job here
   *  as it is in `auditText.ts`. */
  used: string;
}

/** One pile the import will land in. `cards` is **copies, not lines** — a reader counts cards. */
export interface CategoryTally {
  name: string;
  cards: number;
  /** The pile counts toward nothing: no size, no copy limit, no legality, no allocation. */
  inactive: boolean;
}

/**
 * Which card the deck's commander is, and how sure this is of it.
 *
 * Four outcomes, because there are four genuinely different situations and collapsing any two
 * of them means guessing:
 *
 * * `notApplicable` — the format has no command zone. There is no question to ask.
 * * `fromFile` — the list named one under a `Commander` heading. The file said; nothing here
 *   improves on that.
 * * `automatic` — exactly one card in the list could legally be a commander. One candidate is
 *   not a guess, it is the answer.
 * * `ask` — none, or more than one. The reader chooses, and an empty candidate list is a real
 *   outcome rather than a failure: confirming a commander deck with no commander is a thing
 *   people do halfway through building one.
 *
 * **Never inferred from position.** "The first line is the commander" and "the last line is
 * the commander" are both real export conventions and each is wrong about half the lists in
 * the wild, so neither is used at all.
 */
export type CommanderChoice =
  | { kind: "fromFile" }
  | { kind: "notApplicable" }
  /** Plural because the reader may send back a partner pair; this **never pairs by itself** —
   *  a pairing is a choice, and `validateCommanderZone` judges it once the deck exists. */
  | { kind: "automatic"; cardIds: string[] }
  | { kind: "ask"; candidates: ImportMatch[] };

/**
 * Everything the preview draws, and everything {@link toImportItems} needs.
 *
 * **There is deliberately no `categories` here.** The piles are a fact about the *items being
 * sent*, not about the plan — the commander choice moves a card between piles and is applied in
 * {@link toImportItems} — so the tally is {@link tallyOf} over those items, and a preview that
 * read it off the plan would describe an import nobody asked for. It did: see that function.
 *
 * {@link totalCards} stays, because the commander choice changes *which pile* a card lands in
 * and never *how many copies* land.
 */
export interface ImportPlan {
  cards: PlannedCard[];
  unmatched: UnmatchedLine[];
  hintMisses: HintMiss[];
  /** {@link ParsedList.issues} verbatim — the lines the parser could not read at all. */
  parseIssues: ParseIssue[];
  commander: CommanderChoice;
  /** Copies that will actually land. **Not {@link ParsedList.totalCards}**, which counts every
   *  line the parser read, including the ones nothing resolved. */
  totalCards: number;
}

/**
 * The card-level facts, under the name the validation layer means by them.
 *
 * Written out as a literal rather than returned whole so that a field leaving {@link ImportMatch}
 * fails here, at the one place the two contracts meet, rather than somewhere downstream. Every
 * field is on `ImportMatch` under the same name; `gameChanger` is the one narrowing — a plain
 * boolean where `DeckCard`'s is nullable — and a plain boolean is assignable to it.
 *
 * (Unrelated to `commanders.identityOf`, which is a card's *colour* identity. That one is not
 * imported here.)
 */
function identityOf(m: ImportMatch): CardIdentity {
  return {
    cardId: m.cardId,
    name: m.name,
    oracleId: m.oracleId,
    manaCost: m.manaCost,
    cmc: m.cmc,
    typeLine: m.typeLine,
    oracleText: m.oracleText,
    colors: m.colors,
    colorIdentity: m.colorIdentity,
    legalities: m.legalities,
    power: m.power,
    toughness: m.toughness,
    layout: m.layout,
    rarity: m.rarity,
    faces: m.faces,
    gameChanger: m.gameChanger,
    everUncommon: m.everUncommon,
  };
}

/**
 * The pile one line lands in — one chain, in the order the reader's own intent narrows.
 *
 * ```
 * forcedCategoryName        the right-click aimed this import at a pile
 *   > SECTION_CATEGORY[…]   the line is in one of the four zones
 *   > line.categoryName     the file named a pile of its own
 *   > autoCategoryFor(…)    nobody named one: file it by what the card does
 * ```
 *
 * **The zone is above the name and not below it**, which is not the order the two *arrived* in:
 * a section is a rules fact — the command zone, a sideboard — and a category name is filing.
 * {@link ParsedLine.categoryName} is `null` whenever `section` is not `"deck"` — the parser
 * guarantees it, a bracket or a heading naming one of the four seeded zones setting the *section*
 * instead — so the two can never both answer, and that invariant is the whole of what makes this
 * three rungs rather than four.
 *
 * **A file naming a pile is the reader naming one.** The app's rule has always been that an add
 * naming a category is untouched and only an add naming none is filed by what the card does; an
 * Archidekt export naming `Flash Enabler` is that statement, made by the reader weeks ago in
 * somebody else's deck builder. {@link autoCategoryFor} is untouched and is still the app's
 * **one** filing rule for everything that names nothing — it must never be copied, because a
 * plain add, a drag with no column under it and an imported line all have to agree about where a
 * Sol Ring goes, or the same deck files the same card two ways. That rule reads a **land's type
 * line first, then the card's Oracle tags, then its type line** — so this hands it both facts and
 * decides nothing itself.
 *
 * `forcedCategoryName` still outranks all of it: right-clicking "Removal" and pressing Import
 * names a pile, and it is the later and more specific naming — a heading and a bracket are what
 * somebody else's exporter wrote, and the right-click is the reader pointing at a column of their
 * own a moment ago. Absent, and every existing caller is byte-for-byte unchanged. **The command
 * zone outranks even that**, applied in {@link toImportItems} after the pile is chosen.
 *
 * **The slugs are looked up by `cardId`, never taken by position** — see {@link buildImportPlan}
 * for why a decklist is exactly the shape that breaks positional matching. A card the tag read
 * had no answer for gets `undefined`, which is the rule's documented fallback and not a miss:
 * it files by type line, as this whole path did before the tag dataset existed.
 *
 * An import is never in the "caller said nothing" case that `DEFAULT_CATEGORY_NAME` answers —
 * a resolved line always has its printing's `typeLine` in hand, so a `null` there means the
 * card really has none (an odd layout) and `Uncategorized` is the honest pile for it.
 */
function categoryFor(
  line: ParsedLine,
  match: ImportMatch,
  slugs: ReadonlyMap<string, readonly string[]>,
  forcedCategoryName: string | undefined,
): string {
  if (forcedCategoryName !== undefined) return forcedCategoryName;
  if (line.section !== "deck") return SECTION_CATEGORY[line.section];
  return (
    line.categoryName ??
    autoCategoryFor({ typeLine: match.typeLine, oracleTags: slugs.get(match.cardId) })
  );
}

/**
 * The tag answers as the one thing {@link categoryFor} asks of them: a lookup from printing id
 * to slugs.
 *
 * **Built here rather than by the caller so the match-by-id rule is stated once, in the pure
 * function tests can reach.** `oracle_tags_for_printings` drops blank and duplicate ids, so its
 * answer is one entry per *distinct* id and can be shorter than the request — and a decklist
 * naming two printings of one card, or one card on two lines, is the ordinary case that makes
 * `answers[i]` against `ids[i]` file the wrong cards. A later entry for the same id simply wins;
 * the command answers each id once, so there is no second one to lose.
 */
function slugsById(tags: readonly PrintingTags[]): ReadonlyMap<string, readonly string[]> {
  const byId = new Map<string, readonly string[]>();
  for (const answer of tags) byId.set(answer.cardId, answer.slugs);
  return byId;
}

/** The printing a line was answered with, as a card prints it. */
function printingOf(match: ImportMatch): string {
  return `${match.setCode.toUpperCase()} ${match.collectorNumber}`;
}

/** Where a pile sorts. A name {@link TALLY_ORDER} has never heard of goes to the foot, which
 *  is where an unknown belongs — and `sort` is stable, so those keep the order they arrived
 *  in rather than an arbitrary one. */
function tallyOrder(name: string): number {
  const at = TALLY_ORDER.indexOf(name);
  return at < 0 ? TALLY_ORDER.length : at;
}

/**
 * A parsed decklist and its resolved rows, decided.
 *
 * **`row.index` is the address, never the array position.** `import_resolve` carries the
 * caller's own index back precisely so the two can differ; reading `rows[i]` against
 * `parsed.lines[i]` would work today and mis-file the whole list the day anything filters
 * between them. A row whose index names no line is skipped rather than thrown over — a preview
 * that refuses to draw is worse than one missing a line.
 *
 * `spec` is `null` for a deck whose format this build has no row for, which is the same answer
 * as a format with no command zone: no commander question is asked.
 *
 * `tags` is what one `oracle_tags_for_printings` over every resolved card id answered — the
 * whole list in a single read, made by {@link useImport} before this is called. Three
 * things about it are load-bearing:
 *
 * * **It is matched by `cardId` and never by position.** The command drops blank and duplicate
 *   ids, so it answers one entry per *distinct* id; a list naming a card twice — which the
 *   commander step already has a rule for — is exactly the case `tags[i]` mis-files.
 * * **Empty is a complete answer.** An untagged card, an id `cards` has never heard of and a
 *   printing with a NULL `oracle_id` all come back with no slugs, and the rule's response to
 *   all three is the same: file by type line.
 * * **Which is why the whole argument defaults to nothing.** A tag read that was refused, or a
 *   build whose taxonomy has never been downloaded, plans the identical import filed entirely
 *   by type line. That is the floor this feature stands on, not an error path — an import is a
 *   large deliberate action and must not be lost to a taxonomy fetch.
 *
 * `forcedCategoryName` is the pile a right-click aimed the import at — "Import cards…" on a
 * category heading — and it is **trailing and optional so that absent is today's behaviour
 * exactly**: the toolbar's Import passes nothing and every one of this file's existing tests
 * describes that caller. What it does is {@link categoryFor}'s first line and nothing else; the
 * tags are still read, still handed in and still cost their round trip, because a forced pile
 * that also changed what the *caller* fetched would be a second rule in a second place.
 */
export function buildImportPlan(
  parsed: ParsedList,
  // `readonly`, because {@link DestinationPreviewProps} hands the rows to every destination as a
  // read-only array and a planner that decides nothing has no business asking for a mutable one.
  // Widening a parameter costs no caller: an `ImportResolveRow[]` is assignable to this.
  rows: readonly ImportResolveRow[],
  spec: FormatSpec | null,
  tags: readonly PrintingTags[] = [],
  forcedCategoryName?: string,
): ImportPlan {
  const cards: PlannedCard[] = [];
  const unmatched: UnmatchedLine[] = [];
  const hintMisses: HintMiss[] = [];
  const slugs = slugsById(tags);

  for (const row of rows) {
    // Annotated rather than inferred: `noUncheckedIndexedAccess` is off, so an out-of-range
    // read types as `ParsedLine` and the guard below would be narrowed away as dead code.
    const line: ParsedLine | undefined = parsed.lines[row.index];
    if (line === undefined) continue;
    if (row.matched === null) {
      unmatched.push({ lineNumber: line.lineNumber, raw: line.raw, name: line.name });
      continue;
    }
    if (row.hintMissed) {
      hintMisses.push({
        lineNumber: line.lineNumber,
        name: line.name,
        used: printingOf(row.matched),
      });
    }
    cards.push({
      lineNumber: line.lineNumber,
      match: row.matched,
      quantity: line.quantity,
      categoryName: categoryFor(line, row.matched, slugs, forcedCategoryName),
      excluded: line.excluded,
      finish: line.finish,
    });
  }

  return {
    cards,
    unmatched,
    hintMisses,
    parseIssues: parsed.issues,
    commander: commanderChoice(cards, spec),
    totalCards: cards.reduce((sum, card) => sum + card.quantity, 0),
  };
}

/**
 * The piles, with a copy count each — **over the items an import is actually sending**.
 *
 * Summed rather than counted, and summed **per pile name**: a list naming a card on two lines
 * is one row in the deck (the grain folds it) and two items here, and the tally has to agree
 * with the deck rather than with the file.
 *
 * **It takes {@link ImportItem}s and not {@link ImportPlan} on purpose, and that is a bug
 * fix.** It used to run over `plan.cards`, which carries only {@link autoCategoryFor}'s answer,
 * and it ran once when the plan was built — before the reader had chosen a commander and never
 * again after. So the preview's two headline numbers disagreed with what was written. Measured
 * live 2026-08-12 (a **debug** build, the 105-line reference list into a Commander deck): the
 * step read **`117 cards · 6 categories`** with `Creature 56` and no Commander row, and
 * `deck_get` after the import read **7 categories**, `Creature 55`, `Commander 1`. It was worst
 * on the `automatic` arm, where the reader presses nothing: the dialog printed *"Krenko, Mob
 * Boss goes in the command zone"* directly above a tally filing him under `Creature`.
 *
 * The split {@link toImportItems}' doc calls deliberate is still right — the plan is what the
 * preview draws *while* they are still choosing. What was missing is that the tally is not part
 * of the plan: it describes the items, so it is derived where they are, from the same call, and
 * recomputes with every press.
 */
export function tallyOf(items: readonly ImportItem[]): CategoryTally[] {
  const copies = new Map<string, number>();
  const inactive = new Set<string>();
  for (const item of items) {
    copies.set(item.categoryName, (copies.get(item.categoryName) ?? 0) + item.quantity);
    // The seeded Maybeboard arrives switched off; a `{noDeck}` pile the import is about to make
    // will be. Either way the sentence the preview owes the reader is the same one, so the two
    // are **OR**ed rather than branched between — and it is OR'd across the *items*, because one
    // pile can be named by several lines and a single `{noDeck}` among them is what the file
    // said about that pile.
    if (item.inactive === true || item.categoryName === SEEDED_INACTIVE) {
      inactive.add(item.categoryName);
    }
  }
  return [...copies]
    .map(([name, count]) => ({ name, cards: count, inactive: inactive.has(name) }))
    .sort((a, b) => tallyOrder(a.name) - tallyOrder(b.name));
}

/**
 * Which card sits in the command zone, decided in one order that never guesses.
 *
 * Eligibility is `commanderIneligibility` and nothing else — the same rule the editor's
 * validation panel judges a built deck by, asked here about a card that is not in a deck yet
 * (which is what `CardIdentity` was widened for). A second, looser "looks like a commander"
 * test would offer the reader a card the panel then refuses.
 *
 * **A card with no type line counts as a candidate**, because that function declines to judge
 * one at all: it has nothing to read and the reconciler's warning already covers it. That is
 * failing open — one extra name in a list the reader is choosing from — rather than dropping
 * the card they may have meant.
 *
 * Deduplicated by printing, so a list that names one legendary creature twice is one candidate
 * and stays `automatic`. An `ask` between a card and itself is not a question.
 */
function commanderChoice(cards: readonly PlannedCard[], spec: FormatSpec | null): CommanderChoice {
  const rule = spec?.commanderRule ?? null;
  if (spec === null || rule === null) return { kind: "notApplicable" };
  if (cards.some((card) => card.categoryName === SECTION_CATEGORY.commander)) {
    return { kind: "fromFile" };
  }

  const candidates: ImportMatch[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.match.cardId)) continue;
    if (commanderIneligibility(identityOf(card.match), rule, spec) !== null) continue;
    seen.add(card.match.cardId);
    candidates.push(card.match);
  }

  return candidates.length === 1
    ? { kind: "automatic", cardIds: [candidates[0].cardId] }
    : { kind: "ask", candidates };
}

/**
 * The plan as the one thing `deck_import_commit` takes: one item per planned card, whatever
 * the copy count — the quantity rides on the item and the backend's `ON CONFLICT` sums two
 * items that land on the same grain.
 *
 * `commanderIds` is whatever the reader confirmed (a `CommanderChoice`'s `cardIds`, or their
 * pick out of `candidates`), and it moves those cards into the Commander pile wherever
 * {@link autoCategoryFor} had filed them — under `Creature` by type line, or under `Ramp` or
 * `Draw` by what their tags say they do, all of which the command zone outranks. It is applied
 * here and not in the plan because the plan is what the preview draws *while* they are still
 * choosing.
 *
 * **Which is exactly why the tally is {@link tallyOf} over this function's answer** rather than
 * a field on the plan: this is the one place the commander choice is applied, so it is the only
 * place a preview of it can be counted.
 *
 * `inactive` rides across here for the same reason and is decided in the same expression: the
 * command zone outranks the pile the file named, so the `{noDeck}` that came with that pile has
 * to go with it. A commander filed into a switched-off category is a deck with no commander —
 * `is_active = 0` counts toward nothing, the command zone included.
 */
export function toImportItems(plan: ImportPlan, commanderIds: readonly string[]): ImportItem[] {
  const chosen = new Set(commanderIds);
  return plan.cards.map((card) => {
    const isCommander = chosen.has(card.match.cardId);
    return {
      cardId: card.match.cardId,
      quantity: card.quantity,
      // **Not touched by the commander choice**, unlike the pile and the `{noDeck}` flag beside
      // it: those two are filing, which the command zone outranks, and a finish is a fact about
      // the object. A foil commander is a foil commander.
      finish: card.finish,
      categoryName: isCommander ? SECTION_CATEGORY.commander : card.categoryName,
      // The command zone outranks the pile, so the flag that came with the pile goes with it —
      // a commander in a switched-off category is a deck with no commander.
      inactive: isCommander ? false : card.excluded,
    };
  });
}
