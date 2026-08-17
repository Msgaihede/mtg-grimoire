/**
 * A decklist as text, read into lines this app can act on.
 *
 * One parser for every shape people paste — plain lists, Moxfield, Archidekt, Arena, MTGO —
 * because they overlap almost entirely and a format *detector* would be a second thing to be
 * wrong: it would have to choose a reader before it had read anything, and it would be wrong
 * about exactly the lists that have been edited by hand. Every rule here is a **per-line**
 * rule for that reason, so an unfamiliar mixture is read line by line rather than refused
 * whole, and no line's reading depends on a verdict about the file.
 *
 * It knows nothing about cards. A name is a string, and whether any card bears it is
 * `deck_import_resolve`'s question — which is what keeps this file pure TypeScript with no
 * IPC in it, and what stops it rejecting a card printed after the last sync.
 *
 * **Nothing is ever silently dropped.** A line this cannot read becomes a {@link ParseIssue}
 * carrying its number and its raw text so the preview can quote it back, and one bad line
 * never aborts the parse. The only lines that leave no trace are the ones making no claim —
 * blanks and comments.
 */
// The only import here, and it is a **type**. This file stays text in, data out: no React, no
// hook, no IPC — which is what lets `parse.test.ts` drive every rule as a pure function.
import type { DeckFinish } from "@/lib/ipc";

/**
 * Which of the deck's four zones a line is in — **the fixed word the rules read**, beside
 * {@link ParsedLine.categoryName}, which is the name the user (or their exporter) gave a pile.
 *
 * That is `deck_categories`' own distinction — the name is the reader's and the kind is what the
 * engine sizes a deck by — applied to a parsed line, and the rename from `Section` is what says
 * so. The starting value is `deck`, which is what makes a list with no headings at all read as a
 * deck rather than as nothing.
 */
export type SectionKind = "deck" | "commander" | "sideboard" | "companion" | "maybeboard";

/** One line that named a card. */
export interface ParsedLine {
  /** 1-based, counted over **every** line including the blanks — it is what the preview quotes. */
  lineNumber: number;
  /** The line exactly as it arrived, untrimmed, so a quoted line looks like what was pasted. */
  raw: string;
  /** Always ≥ 1. A count of zero is a {@link ParseIssue}, never a line. */
  quantity: number;
  name: string;
  /** Uppercased — `(ltc)` and `(LTC)` are the same set and only one of them is a set code. */
  setCode: string | null;
  /** Verbatim. Collector numbers are TEXT (`123★`, `A-45`, `285`), so nothing is parsed out. */
  collectorNumber: string | null;
  section: SectionKind;
  /**
   * The pile the **file** named for this line, or `null` when it named none.
   *
   * A bracket's first entry, else the name of an unknown section heading. It is `null` whenever
   * `section` is not `"deck"`, and that invariant is the whole of what keeps `plan.ts`'s
   * precedence chain three rungs rather than four: a heading or a bracket naming one of the four
   * seeded zones sets the *section*, and only a name the section vocabulary has never heard of
   * lands here.
   */
  categoryName: string | null;
  /**
   * Which object the file said this line is — the `*F*` / `*E*` marker, `null` for the regular
   * copy. Carried since 2026-08-17; it used to be stripped and discarded.
   *
   * **`[Foil]` in a bracket is still decoration and never reaches this**, which looks like an
   * inconsistency and is not. A bracket is the *category* channel: a finish that arrived there
   * is an exporter being loose with a field, while `*F*` is the channel every format that says
   * anything about a finish agrees on. Reading the bracket would also mean deciding, for every
   * word in it, whether it is a pile or a treatment — which is the format detector this file
   * exists without.
   */
  finish: DeckFinish;
  /** The file said this card counts toward nothing — Archidekt's `{noDeck}`, which is this app's
   *  `is_active = 0`. */
  excluded: boolean;
}

/** A line that named nothing this could import, kept so the preview can show it. */
export interface ParseIssue {
  lineNumber: number;
  raw: string;
  reason: string;
}

export interface ParsedList {
  lines: ParsedLine[];
  issues: ParseIssue[];
  /** The sum of every line's `quantity` — cards, not lines. */
  totalCards: number;
  /** Arena's `Name <x>` from under its `About` block, and nothing else names a deck. */
  suggestedName: string | null;
}

/**
 * Every spelling of a section heading this reads, lowercased and already stripped of a
 * trailing count or colon by {@link sectionFor}.
 *
 * A `Map` and not an object literal, which is not taste: a plain object answers `toString`
 * and `constructor` off `Object.prototype`, so a lookup of either would come back truthy and
 * switch the current section to a function — after which every remaining line is filed
 * somewhere no reader can name and nothing on screen says why.
 *
 * `deck` has five spellings because the sites that export decklists have never agreed on one.
 * They are listed rather than normalised: a rule that folded `main deck` into `maindeck` by
 * deleting spaces would be a rule about every heading, including the ones added later.
 */
const SECTIONS = new Map<string, SectionKind>([
  ["deck", "deck"],
  ["main", "deck"],
  ["maindeck", "deck"],
  ["mainboard", "deck"],
  ["main deck", "deck"],
  ["commander", "commander"],
  ["commanders", "commander"],
  ["sideboard", "sideboard"],
  ["sb", "sideboard"],
  ["companion", "companion"],
  ["maybeboard", "maybeboard"],
  ["maybe", "maybeboard"],
  ["considering", "maybeboard"],
]);

/**
 * A count, a name and an optional printing, in one pass. Groups: `qty`, `name`, `set`, `cn`.
 *
 * `name` is **lazy** and the printing hint is anchored to the end of the line, which is the
 * whole reason `Erase (Not the Urza's Legacy One)` keeps its parentheses: a set code is 1–10
 * word characters closed by `)`, followed by either the end of the line or one unspaced
 * collector number — so a parenthesised phrase containing spaces can never satisfy it and the
 * lazy name simply grows past it. A hint is recognised or the text is part of the name; there
 * is no third answer and no guessing.
 *
 * **The `x` must touch the digits, and that is load-bearing.** `4x Shock` is a count and
 * `2 X Marks the Spot` is a card. Allowing whitespace between `\d{1,4}` and `[xX]?` eats that
 * card's first word as a multiplier and imports a card called "Marks the Spot" — silently,
 * because the line still parses and the count still reads 2.
 *
 * What that costs, stated as measured rather than as intended: `4 x Shock` gives
 * `{ quantity: 4, name: "x Shock" }`. The **count is still taken** — only the stray `x`
 * migrates into the name — so the reader gets four copies of a name nothing will resolve,
 * not one copy of `"4 x Shock"`. That is the losing side of the trade and it is a loud
 * failure: an unresolvable name is a row the preview asks about, where "Marks the Spot"
 * would have imported quietly and correctly-looking.
 *
 * **The set may be empty, and that is a real export rather than a tolerance.** `1 Aerith, Last
 * Ancient () 76` is 33 of one reference export's 88 lines: the exporter had a collector number
 * and no set, and wrote the parentheses anyway. `\w{0,10}` reads it, and an empty match is
 * `setCode: null` below. Widening the count to zero cannot cost `Erase (Not the Urza's Legacy
 * One)` its parentheses — the hint is still anchored to the end and a set code still holds no
 * spaces, so a parenthesised *phrase* can never satisfy it.
 *
 * What it costs is honest and worth stating: `resolve_lines` reads a collector number with no
 * set as a hint it cannot use (a number is not unique across sets) and sets `hint_missed`. So
 * such a list previews 33 missed hints where it used to preview 33 unresolved cards.
 */
const LINE =
  /^(?:(?<qty>\d{1,4})[xX]?\s+)?(?<name>.+?)(?:\s+\((?<set>\w{0,10})\)(?:\s+(?<cn>\S+))?)?$/;

/**
 * Trailing decoration that belongs to the exporter rather than to the card: the `*F*`/`*E*`
 * finish markers, an Archidekt `^Tag,#colour^`, and a trailing `#tag`.
 *
 * Every one is anchored to the **end** and requires whitespace in front of it. Both halves of
 * that matter: a `#` in the middle of a line is part of a name, and a marker regex that
 * matched anywhere would cut one out of the middle of one.
 *
 * **The `^…^` arm is not the `#` arm widened.** Archidekt writes `^Keeper,#4aab08^`, where the
 * hash follows a comma rather than whitespace, so the `#` arm never saw it and the whole tail
 * stayed inside the card's name. `[^^]*` rather than `\S*` because a tag's text has spaces and
 * parentheses in it — `^Fence (flavor),#fa890d^` is one of them.
 *
 * **The bracket is no longer here**, because it is read rather than discarded: see
 * {@link stripDecorations}.
 */
const MARKERS = [/\s+\*[A-Z]\*$/, /\s+\^[^^]*\^$/, /\s+#\S+$/];

/**
 * The `*F*` / `*E*` marker, **read** rather than merely stripped (2026-08-17).
 *
 * It was thrown away for as long as a deck named a printing and never a finish. Schema v18 gave
 * `deck_cards` a `finish`, so the line has somewhere to put it, and this is the channel every
 * format that says anything about a finish agrees on.
 *
 * The letter is the whole of it: `*F*` is foil and `*E*` is etched, and any other letter is a
 * marker this app does not read — which is why {@link MARKERS} still strips the general shape
 * and this only recognises two. `null` for a line carrying neither, which is the regular copy.
 */
const FINISH_MARKER = /\s+\*([FE])\*$/;

/** A trailing `[…]`, anchored like every {@link MARKERS} pattern. */
const BRACKET = /\s+\[([^\]]+)\]$/;

/**
 * Bracket contents that are a *finish* rather than a pile.
 *
 * `[Foil]` is decoration in the same way `*F*` is, and a deck names a printing rather than a
 * finish, so reading it as a category would put a pile called "Foil" in somebody's deck. Matched
 * whole and case-insensitively; anything else in a bracket is a category, because guessing which
 * words are "really" categories is the format detector this file exists without.
 */
const FINISH_WORDS = /^(?:foil|etched|non-?foil)$/i;

/**
 * What ends a line. CRLF first so a Windows paste splits once and not twice.
 *
 * The lone `\r` arm is not decoration: `/\r?\n/` — the obvious spelling — does not treat a
 * carriage return on its own as anything, and `.` inside {@link LINE} does not cross one
 * either. So a CR-only paste used to arrive as **one** row that matched nothing, and the whole
 * decklist came back as a single issue reading "No card name on this line." Measured on
 * `"1 Sol Ring\r2 Shock"`: 0 lines, 1 issue.
 *
 * U+2028 and U+2029 are deliberately **not** here. A decklist comes from a text editor, a
 * site's copy button or a `.txt` file and none of them emit one; handling a separator nobody
 * produces is grammar nobody can check. A paste containing one is still not swallowed — it
 * lands in the empty-name fence below and is quoted back.
 */
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * The section a line announces, or `null` if it announces nothing.
 *
 * A trailing `:` and a trailing `(15)` both come off first, because `Sideboard`, `Sideboard:`
 * and `Sideboard (15)` are one heading spelled three ways. The colon comes off first so that
 * `Sideboard (15):` — both at once — is reached by the count strip afterwards.
 */
function sectionFor(line: string): SectionKind | null {
  const word = line
    .replace(/\s*:\s*$/, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim()
    .toLowerCase();
  return SECTIONS.get(word) ?? null;
}

/** What a line carries besides its card: the text with every decoration peeled off, and the
 *  bracket if it had one. */
interface Decorations {
  body: string;
  /** Verbatim, flags and all — {@link bracketCategory} is what reads it. */
  bracket: string | null;
  /** The `*F*` / `*E*` marker as a finish, or `null` for the regular copy. */
  finish: DeckFinish;
}

/**
 * The line with its trailing decoration removed, and its bracket kept.
 *
 * Repeatedly, to a fixed point, because each pattern is anchored to the end and a line can carry
 * three. `1x Skrelv, Defector Mite (one) 33 *F* [Protection] ^Keeper,#4aab08^` is the case: the
 * tag comes off first, which is the only thing that puts the bracket at the end, which is the
 * only thing that puts `*F*` there. The same loop is what `1 Sol Ring *F* #Ramp` has always
 * needed — one pass takes `#Ramp` off the tail and a single pass would import `Sol Ring *F*`.
 *
 * **The first bracket peeled wins**, which is the rightmost one on the line. No export in scope
 * writes two; a line that did would be naming a pile twice and the nearer one is the later word.
 */
function stripDecorations(line: string): Decorations {
  let body = line;
  let bracket: string | null = null;
  let finish: DeckFinish = null;
  for (;;) {
    const before = body;
    const found = BRACKET.exec(body);
    if (found !== null) {
      bracket ??= found[1];
      body = body.slice(0, found.index);
    }
    // Read before the general strip below takes it off, and **first wins** like the bracket —
    // which is the rightmost marker on the line, for the same reason: no export in scope writes
    // two, and a line that did would be naming a finish twice.
    const marked = FINISH_MARKER.exec(body);
    if (marked !== null) finish ??= marked[1] === "F" ? "foil" : "etched";
    for (const marker of MARKERS) body = body.replace(marker, "");
    if (body === before) return { body, bracket, finish };
  }
}

/**
 * A bracket's first entry, as a pile name and a flag.
 *
 * **The first entry is the pile.** Verified against a real Archidekt export: in all 105 of its
 * lines the first entry is the heading the line is printed under. The rest are the card's other
 * categories, which this app's grain could hold but an import item cannot name.
 *
 * `{flag}` suffixes come off every entry — `{top}`, `{noDeck}`, `{noPrice}` are Archidekt's, and
 * anything in braces is a flag rather than part of a name. **`{noDeck}` on the first entry is the
 * only one that means anything here**: it says this pile counts toward nothing, which is this
 * app's `is_active = 0`. On a later entry it says only that the card is *also* filed in some
 * maybeboard, and the card is still in the deck.
 */
function bracketCategory(bracket: string): { name: string; excluded: boolean } {
  const first = bracket.split(",")[0] ?? "";
  return {
    name: first.replace(/\{[^}]*\}/g, "").trim(),
    excluded: /\{noDeck\}/i.test(first),
  };
}

/** A count at the head of a line — the strongest signal that a line is a card and not a
 *  heading, and the same shape {@link LINE}'s `qty` group reads. */
const QUANTITY = /^\d{1,4}[xX]?\s/;

/** A trailing `(SET) 123`, `(SET)` or `() 123` — {@link LINE}'s hint, on its own, so a heading
 *  candidate can be refused for carrying one. */
const HINT_TAIL = /\s+\(\w{0,10}\)(?:\s+\S+)?$/;

/**
 * The first row after `index` that makes a claim — not blank, not a comment.
 *
 * `null` at the end of the text, which is one of the things that stops a trailing word being
 * read as a heading over nothing.
 */
function nextClaim(rows: readonly string[], index: number): string | null {
  for (let at = index + 1; at < rows.length; at += 1) {
    const trimmed = rows[at].trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return null;
}

/**
 * Is this line a section heading whose name is a pile?
 *
 * `Anthem`, `Creature` and `Land` are indistinguishable from card lines to a per-line reader, and
 * a custom category name can be a real card (`Fog`, `Wrath`, `Duress`). This is the one rule in
 * the file that reads past the line in front of it, and each clause pays for itself:
 *
 * * **No quantity, no printing hint, no bracket.** A heading is a bare word; every card line in
 *   an export that writes headings carries at least one of the three.
 * * **The next line that makes a claim carries a count.** This is what leaves a list of bare
 *   names alone — `Sol Ring` followed by `Arcane Signet` fails it — and it is *also* what makes
 *   a heading over an empty section impossible, which is how "nothing is ever silently dropped"
 *   stays true: a line consumed as a heading always opened at least one card.
 * * **Preceded by a blank line.** Without it `Sol Ring` / `4 Shock` — a hand-written list mixing
 *   bare names with counted ones — loses its first card.
 * * **Or the first line of the file, when that next line carries a bracket.** An Archidekt deck
 *   with no commander opens on a category heading with nothing above it, and Archidekt writes a
 *   bracket on every one of its lines while a hand-written list writes none.
 *
 * **The failure it keeps**, named rather than hidden: a hand-written list with a blank line, then
 * a bare card name, then a counted line, loses that name. No exporter in scope emits that shape.
 */
function namesASection(rows: readonly string[], index: number, trimmed: string): boolean {
  if (QUANTITY.test(trimmed) || HINT_TAIL.test(trimmed) || trimmed.includes("[")) return false;
  const next = nextClaim(rows, index);
  if (next === null || !QUANTITY.test(next)) return false;
  return index === 0 ? next.includes("[") : rows[index - 1].trim() === "";
}

/**
 * Read a pasted decklist.
 *
 * Never throws and never returns partial nonsense: every line ends up in `lines`, in
 * `issues`, or was blank or a comment.
 */
export function parseDecklist(text: string): ParsedList {
  const lines: ParsedLine[] = [];
  const issues: ParseIssue[] = [];
  let section: SectionKind = "deck";
  let sectionCategory: string | null = null;
  let suggestedName: string | null = null;
  let inAbout = false;

  // Stripped from the whole text rather than per line, because that is where a pasted BOM
  // actually is — a file has one, at the front. A per-line strip would be a rule about every
  // line for the sake of the first.
  const rows = text.replace(/^\uFEFF/, "").split(LINE_BREAK);

  // Indexed rather than `rows.entries()` because {@link namesASection} reads the row before the
  // candidate and the rows after it — the one lookahead in this file. `lineNumber` is still
  // `index + 1`, counted over every row including the blanks, because it is what the preview
  // quotes back.
  for (let index = 0; index < rows.length; index += 1) {
    const raw = rows[index];
    const lineNumber = index + 1;
    const trimmed = raw.trim();

    // Skipped whole, and note what is *not* here: a blank line does not end a section.
    // Moxfield separates its commander from its deck with a blank line **and** a header, and
    // a hand-written list uses blank lines decoratively — so treating one as an end would
    // file the deck under whatever came before the paragraph break.
    if (trimmed === "") continue;

    // A comment is `//` **at the start of a line**. `1 Branchloft Pathway // Boulderloft
    // Pathway` is one card and there are seven such names in the reference list alone, so a
    // `//` found anywhere else is part of the name and must never be cut.
    if (trimmed.startsWith("//") || trimmed.startsWith("#")) continue;

    // Checked before the `About` block below, because a header is how that block ends: Arena
    // writes `About`, `Name …`, then `Deck`, and that `Deck` has to both close the block and
    // switch the section. Reading the block first would swallow it.
    const header = sectionFor(trimmed);
    if (header !== null) {
      section = header;
      sectionCategory = null;
      inAbout = false;
      continue;
    }

    // A heading whose name is not one of the section words is a **pile**, and it puts the reader
    // back in the deck proper: after `Commander`, a `Ramp` heading is not still the command zone.
    if (namesASection(rows, index, trimmed)) {
      section = "deck";
      sectionCategory = trimmed;
      inAbout = false;
      continue;
    }

    if (/^about$/i.test(trimmed)) {
      inAbout = true;
      continue;
    }
    if (inAbout) {
      // The first `Name` wins, so the answer does not depend on how much was pasted after it.
      // Arena writes exactly one; a second is malformed input, and last-wins would let a
      // second list appended to the first quietly rename the deck.
      const named = /^name\s+(.+)$/i.exec(trimmed);
      if (named && suggestedName === null) suggestedName = named[1].trim();
      continue;
    }

    // MTGO's `SB:` is a **one-line** override, not a heading. It travels on the line it marks
    // and can sit anywhere in the file, so consuming it must not move `section`: the next
    // unprefixed line is still whatever the last heading said, not the sideboard.
    let body = trimmed;
    let lineSection = section;
    const sideboardPrefix = /^sb:\s*/i.exec(body);
    if (sideboardPrefix) {
      body = body.slice(sideboardPrefix[0].length);
      lineSection = "sideboard";
    }

    const decorated = stripDecorations(body);
    body = decorated.body;

    // The pile the file named for this line: the open heading, which a bracket then overrides
    // rather than replaces — Archidekt writes both and they agree, and a list that disagreed
    // with itself is naming the pile twice, where the nearer naming is the one on the line. A
    // bracket naming one of the section words is the *section* — `[Commander{top}]` has to reach
    // the command zone through the one mechanism the seeded piles already use — and only an
    // unknown name is a category.
    let categoryName: string | null = sectionCategory;
    let excluded = false;
    if (decorated.bracket !== null && !FINISH_WORDS.test(decorated.bracket.trim())) {
      const read = bracketCategory(decorated.bracket);
      excluded = read.excluded;
      const known = read.name === "" ? undefined : SECTIONS.get(read.name.toLowerCase());
      if (known !== undefined) lineSection = known;
      else if (read.name !== "") categoryName = read.name;
    }
    // The invariant `ParsedLine.categoryName` documents: a card in one of the four zones is
    // filed by that zone, so a free-form name only ever applies inside the deck proper.
    if (lineSection !== "deck") categoryName = null;

    // `RegExpExecArray["groups"]` types every named group as `string`, optional ones included,
    // and at runtime an unmatched one is `undefined`. Widening here rather than trusting that
    // type is what lets `qty === undefined` mean "no count on this line" — the tempting `!qty`
    // is the same question with a different, wrong answer for `"0"`.
    const groups: Record<string, string | undefined> = LINE.exec(body)?.groups ?? {};
    const name = groups.name?.trim() ?? "";
    if (name === "") {
      // Reachable, and this is the one thing that reaches it: a line terminator `LINE_BREAK`
      // does not split on. `.` never crosses U+2028 or U+2029, so a paste using one arrives
      // as a single row that `LINE` cannot match at all — and this is what quotes the whole
      // text back rather than dropping it. Measured: `"1 Sol Ring\u20282 Shock"` is 0 lines
      // and 1 issue.
      //
      // What does **not** reach it, having been checked rather than assumed: a line of only
      // decoration. Every {@link MARKERS} pattern and {@link BRACKET} needs `\s+` in front of
      // it and `body` is already trimmed, so `stripDecorations` cannot empty a string — `*F*`
      // alone parses as a card named `*F*`, and `[Ramp]` alone as one named `[Ramp]`, both of
      // which resolution refuses. There is no path here through an empty name after a strip.
      issues.push({ lineNumber, raw, reason: "No card name on this line." });
      continue;
    }

    const quantity = groups.qty === undefined ? 1 : Number(groups.qty);
    if (quantity === 0) {
      // Refused rather than corrected, and this is the one line the parser judges. Every other
      // reading here defaults *towards* an import; `0 Shock` is the one where a default would
      // add a card the list explicitly counted to none. Quoted back instead, so the reader
      // decides.
      issues.push({ lineNumber, raw, reason: "A count of zero is not an import." });
      continue;
    }

    lines.push({
      lineNumber,
      raw,
      quantity,
      name,
      // `""` is what an empty `()` matches and it is not a set code. `?? null` alone would put
      // an empty string in the field, which `resolve_lines` trims to absent anyway — but a DTO
      // that says `""` where it means "none" is a field two readers will disagree about.
      setCode: groups.set ? groups.set.toUpperCase() : null,
      collectorNumber: groups.cn ?? null,
      section: lineSection,
      categoryName,
      finish: decorated.finish,
      excluded,
    });
  }

  return {
    lines,
    issues,
    totalCards: lines.reduce((sum, line) => sum + line.quantity, 0),
    suggestedName,
  };
}
