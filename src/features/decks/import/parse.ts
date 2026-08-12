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

/**
 * Where the reader put a line.
 *
 * The starting section is `deck`, which is what makes a list with no headings at all — the
 * reference list, and most of what people paste — read as a deck rather than as nothing.
 */
export type Section = "deck" | "commander" | "sideboard" | "companion" | "maybeboard";

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
  section: Section;
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
const SECTIONS = new Map<string, Section>([
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
 */
const LINE =
  /^(?:(?<qty>\d{1,4})[xX]?\s+)?(?<name>.+?)(?:\s+\((?<set>\w{1,10})\)(?:\s+(?<cn>\S+))?)?$/;

/**
 * Trailing decoration that belongs to the exporter rather than to the card: the `*F*`/`*E*`
 * finish markers, a bracketed `[Foil]` or `[Ramp]`, and a trailing `#tag`.
 *
 * Every one is anchored to the **end** and requires whitespace in front of it. Both halves of
 * that matter: a `#` in the middle of a line is part of a name, and a marker regex that
 * matched anywhere would cut one out of the middle of one.
 */
const MARKERS = [/\s+\*[A-Z]\*$/, /\s+\[[^\]]+\]$/, /\s+#\S+$/];

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
function sectionFor(line: string): Section | null {
  const word = line
    .replace(/\s*:\s*$/, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim()
    .toLowerCase();
  return SECTIONS.get(word) ?? null;
}

/**
 * The line with every trailing {@link MARKERS} shape removed.
 *
 * Repeatedly, to a fixed point, because each pattern is anchored to the end and a line can
 * carry two. `1 Sol Ring *F* #Ramp` is the case: one pass takes `#Ramp` off the tail, which
 * is the only thing that puts `*F*` at the end where the next pass can see it — so a single
 * pass would import a card called `Sol Ring *F*`.
 */
function stripMarkers(line: string): string {
  let out = line;
  for (;;) {
    const before = out;
    for (const marker of MARKERS) out = out.replace(marker, "");
    if (out === before) return out;
  }
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
  let section: Section = "deck";
  let suggestedName: string | null = null;
  let inAbout = false;

  // Stripped from the whole text rather than per line, because that is where a pasted BOM
  // actually is — a file has one, at the front. A per-line strip would be a rule about every
  // line for the sake of the first.
  const rows = text.replace(/^\uFEFF/, "").split(LINE_BREAK);

  for (const [index, raw] of rows.entries()) {
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
    if (header) {
      section = header;
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

    body = stripMarkers(body);

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
      // markers. Every {@link MARKERS} pattern needs `\s+` in front of it and `body` is
      // already trimmed, so `stripMarkers` cannot empty a string — `*F*` alone parses as a
      // card named `*F*`, which resolution refuses. There is no path here through an empty
      // name after a strip.
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
      setCode: groups.set?.toUpperCase() ?? null,
      collectorNumber: groups.cn ?? null,
      section: lineSection,
    });
  }

  return {
    lines,
    issues,
    totalCards: lines.reduce((sum, line) => sum + line.quantity, 0),
    suggestedName,
  };
}
