/**
 * A deck note's body, read into something the app can draw.
 *
 * **This is a reader for a pinned dialect, not a markdown parser**, and the narrow name is the
 * honest one. `src/lib/releaseNotes.ts` is this file's sibling and the constraint is inherited
 * from it word for word: the shipped CSP is `script-src 'self'` with **no
 * `dangerouslySetInnerHTML` anywhere in `src/`**, so a library that answers an HTML string
 * could not be used here at all, and one that answers elements would drag a whole CommonMark
 * parser in for the eleven shapes below. No dependency, and none is owed.
 *
 * The dialect is the spec's §6 list and nothing else — paragraph, heading levels 1–3, bullet
 * list, ordered list, blockquote, hard break, and inline text, strong, em, strike, code and
 * link. It is closed because **two renderers have to agree about it**: Tiptap writes the
 * markdown into `deck_notes.body` and this file reads it back, and `NoteEditor.test.tsx` pins
 * the round trip. Widening the dialect costs a rule on both sides, which is why widening it is
 * a decision and not an accident.
 *
 * **Nothing is ever dropped for not being understood.** A construct this file has no rule for
 * falls through to a paragraph and is drawn as written — a pasted table row reads as
 * `| a | b |` rather than as nothing at all. A reader's typing must never vanish because we
 * had no rule for it, and that is the rule the whole file is arranged around: every branch
 * below either recognises a shape or hands the characters on untouched.
 *
 * **Reading a note loads no editor.** The band's list, the card menu's submenu and the card
 * modal's overlay all draw through here. Mounting a ProseMirror instance per note to render a
 * paragraph would put an editing surface and 141.5 kB gzip behind a read.
 *
 * Three things this reader cannot carry, each stated here rather than discovered later:
 *
 * - **Two marks on one run.** {@link Inline} is flat — one mark per run, no nesting — so
 *   `***both***` comes back as a `strong` and the italic is lost. The *words* always survive;
 *   it is the second mark that does not. Overlapping marks (`*a **b** c*`) come apart into
 *   neighbouring runs for the same reason.
 * - **A hard break is a `"\n"` inside a text run**, because the union has no break member.
 *   A renderer that does not set `whitespace-pre-line` draws it as a space, which is a lost
 *   line boundary and never a lost word.
 * - **Indentation is not structure.** A nested list comes back one level up, which is
 *   `releaseNotes.ts`' answer and reads perfectly well.
 */

/**
 * A run of text inside a block.
 *
 * Flat on purpose: one mark per run and no nesting, which is what keeps a renderer a `switch`
 * over six cases instead of a recursive component. See the file header for what that costs.
 */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "strike"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

/**
 * One drawable block. Four kinds, because the dialect has four.
 *
 * A `quote` holds inlines rather than blocks: a blockquote in this dialect is prose somebody
 * set apart, not a document inside a document, and the alternative — a recursive `Block[]` —
 * buys a nesting the editor's own toolbar cannot produce.
 *
 * `start` is present **only on an ordered list that does not begin at 1**, so the ordinary
 * list's shape is exactly what it looks like. It exists because Tiptap keeps the start number
 * and serializes it, so a list a reader began at `3.` would otherwise be drawn as `1.` the
 * moment they stopped editing it — the two renderers disagreeing about the same body, which is
 * the one failure this dialect exists to prevent. Drawing it is `<ol start={block.start}>`.
 */
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][]; start?: number }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] };

/**
 * `#` through `######`, and everything past the third is **drawn** as the third.
 *
 * ⚠️ **A deeper heading really does reach this reader, and the clamp is what makes the two
 * renderers agree about it.** `Heading.configure({ levels: [1, 2, 3] })` bounds Tiptap's input
 * rules and shortcuts, **not its schema**, so a body pasted into the editor keeps `#### four`
 * byte for byte and `getMarkdown()` writes it back out — `NoteEditor.test.tsx` pins exactly that,
 * and it is why nothing here may rewrite the stored text either. What the editor *draws* it as
 * is a separate question, and `NoteEditor.tsx` overrides `renderHTML` to draw an out-of-range
 * level at `max(levels)` — **3** — rather than at stock ProseMirror's `levels[0]`, which was an
 * h1. So clamping here is not this reader's own taste: it is the same answer the editing surface
 * gives, one heading rung, on a body both sides leave with its four hashes intact.
 *
 * It is also `releaseNotes.ts`' precedent unchanged — the words survive either way, and a reader
 * who reached past the dialect's depth is asking for emphasis rather than for an outline.
 * **Falling through to a paragraph is the wrong answer here** and was tried for one revision: it
 * showed the reader `#### four`, hashes and all, as body text, beside an editor drawing the same
 * line as a heading reading *four*.
 *
 * **The clamp is in the parse and the union stays at three levels.** No level 4 on {@link Block}:
 * widening the dialect is a rule on both renderers, and there is nothing to widen it for.
 *
 * The `[ \t]+` after the hashes is what keeps `#hashtag` a paragraph.
 */
const HEADING = /^\s*(#{1,6})[ \t]+(.*)$/;

/**
 * A bullet, any of the three markers.
 *
 * `[ \t]+` after the marker is what keeps `**Mana:** fourteen sources` from reading as one: a
 * `*` followed by another `*` is not a list. It is also what keeps `---` out — a thematic break
 * is outside the dialect and reads as written.
 */
const BULLET = /^\s*[*+-][ \t]+(.*)$/;

/** `1.` or `1)`, at any start number. CommonMark caps the digits at nine and so does this. */
const ORDERED = /^\s*(\d{1,9})[.)][ \t]+(.*)$/;

/** `> quoted`. The single optional space after the marker is the marker's, not the text's. */
const QUOTE = /^\s*>[ \t]?(.*)$/;

/**
 * A hard break: CommonMark's two trailing spaces, or the trailing backslash prosemirror's
 * markdown serializer actually writes.
 *
 * The lookbehind is not decoration — a line whose text genuinely ends in a backslash is
 * serialized `a\\`, and without it that escaped backslash would read as a line break the reader
 * never typed.
 */
const HARD_BREAK = / {2,}$|(?<!\\)\\$/;

/**
 * The six inline shapes, scanned left to right in one pass, **with the backslash escape first**.
 *
 * That order is the whole of it. prosemirror-markdown escapes a literal `*`, `` ` ``, `~`, `[`,
 * `]`, `\` and `_` on its way out, so a note whose text is `2 * 3` is *stored* as `2 \* 3`;
 * putting the escape branch anywhere but first would let that `*` open an emphasis the reader
 * never wrote. Strong before em for the mirror-image reason: at a `**`, the two-star rule has to
 * be tried before the one-star rule or every bold run reads as an empty italic.
 *
 * `[^*]` in the em branch stops an italic run from swallowing a `**` it does not own, and the
 * link's `[^()\s]+` href is `releaseNotes.ts`' — a URL with a bracket in it is not a link here,
 * and falls through to text like everything else this file cannot read.
 *
 * ⚠️ **`(?!\*)` on the strong branch is what makes `***both***` come out whole**, and it was
 * measured rather than reasoned: a lazy `**…**` closes at the *first* pair it finds, which in a
 * triple is the middle two — leaving `strong("*both")` beside a stray `*`. The lookahead
 * refuses a close that has another star behind it, so the run grows to `*both*` and
 * {@link flatten} reads the italic off it. The same repair handles `**bold *and italic***`,
 * which is what a reader gets for italicising the tail of a bold run.
 *
 * **The underscore spellings are read and never written**, which is the shape of every alternate
 * in this dialect: Tiptap settles `_x_` on `*x*`, so nothing the editor stores reaches these two
 * branches — but a body from a paste or from a build that spelled it differently still reads. The
 * `(?<!\w)`/`(?!\w)` fence is CommonMark's own intraword rule and is what makes them safe here:
 * without it `deck_note_cards` is a word with an italic in the middle of it, which is the one
 * mangling this domain would meet constantly. It doubles as `(?!\*)`'s twin on `__…__`, since
 * `_` is itself a `\w`.
 *
 * Declared without `g` and cloned per call: {@link parseInlines} recurses into itself, and a
 * `lastIndex` shared between the outer scan and an inner one would rewind the outer loop into
 * text it had already consumed.
 */
const INLINE =
  /\\(.)|`([^`]+)`|~~([\s\S]+?)~~|\*\*([\s\S]+?)\*\*(?!\*)|(?<!\w)__([\s\S]+?)__(?!\w)|\*([^*]+?)\*|(?<!\w)_([^_]+?)_(?!\w)|\[([^\]]*)\]\(([^()\s]+)\)/;

/**
 * The thirty-two characters a backslash may escape, which is CommonMark's rule exactly.
 *
 * A plain string rather than a character class, because a regex class holding `/`, `` ` ``,
 * `\` and `]` is four escaping questions and this is none. Anything *outside* the set keeps
 * both characters — `\d` is the two characters a reader typed, not a `d`.
 */
const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

/** What a note may link to. Everything else keeps its words and loses its link. */
const OPENABLE = ["https://", "http://"];

/**
 * Whether a link becomes a link.
 *
 * A note body is the reader's own typing rather than text off the network, so the fence is not
 * about transport — it is about the schemes that *do* something. `openExternal` hands a URL
 * straight to the opener with no check of its own, so `[press me](javascript:…)` is stopped
 * here or nowhere. It degrades to plain text rather than disappearing for `releaseNotes.ts`'
 * reason: the sentence around it is still worth reading.
 */
function isOpenable(href: string): boolean {
  const lower = href.toLowerCase();
  return OPENABLE.some((scheme) => lower.startsWith(scheme));
}

/**
 * One accumulated source line, and whether the line after it starts on a new row.
 *
 * Consecutive lines are one wrapped sentence unless the reader asked otherwise, which is why
 * the break travels with the line before it rather than being a run of its own.
 */
interface Run {
  text: string;
  br: boolean;
}

/** The accumulated lines as one string — a space between them, or a newline after a break. */
function joinRuns(runs: Run[]): string {
  let text = "";
  for (let i = 0; i < runs.length; i += 1) {
    if (i > 0) text += runs[i - 1].br ? "\n" : " ";
    text += runs[i].text;
  }
  return text.trim();
}

/**
 * Append text, merging into the run before it when that run is also text.
 *
 * **The one place this reader differs from `releaseNotes.ts`**, which leaves adjacent text runs
 * unmerged because nothing there needs them merged. Here the escape branch emits one character
 * at a time, so `2 \* 3` would otherwise come back as three text runs saying what one says —
 * three `<span>`s to draw, and an assertion nobody can read.
 */
function pushText(out: Inline[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.kind === "text") last.text += text;
  else out.push({ kind: "text", text });
}

/**
 * Split one line into its runs.
 *
 * Entities are **not** decoded, which is the other difference from the sibling: release-please
 * escapes angle brackets on its way out and Tiptap does not, so a `&lt;` in a note body is four
 * characters the reader typed and decoding them would rewrite what their note says.
 */
function parseInlines(line: string): Inline[] {
  const out: Inline[] = [];
  const scanner = new RegExp(INLINE.source, "g");
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = scanner.exec(line)) !== null) {
    if (m.index > at) pushText(out, line.slice(at, m.index));
    const [, escaped, code, strike, strongStars, strongScores, emStars, emScores, linkText, href] =
      m;
    // The two spellings of each mark are one branch: which delimiter a reader used is a fact
    // about the source and never about what the run means.
    const strong = strongStars ?? strongScores;
    const em = emStars ?? emScores;
    if (escaped !== undefined) {
      pushText(out, ASCII_PUNCTUATION.includes(escaped) ? escaped : `\\${escaped}`);
    } else if (code !== undefined) {
      // Verbatim, and never re-scanned: CommonMark's own rule is that nothing inside a code
      // span is markup, and it is the rule that lets a note show `**bold**` as characters.
      out.push({ kind: "code", text: code });
    } else if (strike !== undefined) {
      out.push({ kind: "strike", text: flatten(strike) });
    } else if (strong !== undefined) {
      out.push({ kind: "strong", text: flatten(strong) });
    } else if (em !== undefined) {
      out.push({ kind: "em", text: flatten(em) });
    } else if (linkText !== undefined && href !== undefined) {
      const text = flatten(linkText);
      if (isOpenable(href)) out.push({ kind: "link", text, href });
      else pushText(out, text);
    }
    at = m.index + m[0].length;
  }
  if (at < line.length) pushText(out, line.slice(at));
  return out;
}

/**
 * A mark's content as the words inside it, with any *inner* markup read and then flattened.
 *
 * This is how `***both***` becomes a `strong` saying `both` rather than one saying `*both*`.
 * A flat {@link Inline} cannot carry two marks on one run, so the inner mark's styling is what
 * is lost — never its text, and never its delimiters left lying around as punctuation.
 *
 * It terminates because the content of a match is always strictly shorter than the match.
 */
function flatten(source: string): string {
  return inlineText(parseInlines(source));
}

/** Everything a row of runs says, with the markup gone. */
function inlineText(inlines: Inline[]): string {
  return inlines.map((run) => run.text).join("");
}

/** Everything one block says, with the markup gone. A list's items are one line each. */
function blockText(block: Block): string {
  if (block.kind === "list") return block.items.map(inlineText).join("\n");
  return inlineText(block.inlines);
}

/**
 * A note body → blocks, ready to draw. An empty body answers an empty list.
 *
 * Line-based, and it holds at most one accumulator at a time: every branch closes the other
 * three before it starts collecting, so the blocks come out in the order they were written with
 * no sorting and no second pass.
 *
 * @param body the note's stored CommonMark, exactly as `deck_notes.body` holds it.
 */
export function parseNoteBody(body: string): Block[] {
  const out: Block[] = [];
  const paragraph: Run[] = [];
  const quote: Run[] = [];
  // Items are accumulated as source runs rather than as parsed inlines, because a line that
  // matches no rule while a list is open belongs to the item above it — CommonMark's lazy
  // continuation, and the shape Tiptap writes a hard break inside a list item as. Parsing each
  // item as it arrived would leave nothing to append that continuation to.
  let items: Run[][] = [];
  let ordered = false;
  let start = 1;
  // A blank line inside a list does **not** end it — CommonMark's loose list, which is what
  // `- one\n\n- two` is and what a reader gets for pressing Enter twice. So the flush is deferred
  // until the next line says what it was: another item continues the list, anything else ends it.
  // Tiptap tightens a loose list on its way out, so this only ever reads a body from elsewhere.
  let listBlank = false;

  const flushList = (): void => {
    if (items.length) {
      out.push({
        kind: "list",
        ordered,
        items: items.map((runs) => parseInlines(joinRuns(runs))),
        ...(ordered && start !== 1 ? { start } : {}),
      });
    }
    items = [];
    start = 1;
    listBlank = false;
  };
  const flushQuote = (): void => {
    const text = joinRuns(quote);
    quote.length = 0;
    if (text) out.push({ kind: "quote", inlines: parseInlines(text) });
  };
  const flushParagraph = (): void => {
    const text = joinRuns(paragraph);
    paragraph.length = 0;
    if (text) out.push({ kind: "paragraph", inlines: parseInlines(text) });
  };

  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    // Read before the trim, because two trailing spaces are a hard break and `trimEnd` eats
    // exactly the evidence.
    const br = HARD_BREAK.test(line);
    const content = line.replace(HARD_BREAK, "").trim();

    if (!content) {
      flushQuote();
      flushParagraph();
      if (items.length) listBlank = true;
      else flushList();
      continue;
    }

    const heading = HEADING.exec(content);
    if (heading) {
      flushList();
      flushQuote();
      flushParagraph();
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3;
      out.push({ kind: "heading", level, inlines: parseInlines(heading[2]) });
      continue;
    }

    const quoted = QUOTE.exec(content);
    if (quoted) {
      flushList();
      flushParagraph();
      if (quoted[1].trim()) {
        quote.push({ text: quoted[1].trim(), br });
      } else {
        // A bare `>` is the paragraph break inside a blockquote that Tiptap writes when a
        // reader presses Enter in one. A `quote` holds inlines and cannot hold two paragraphs,
        // so it becomes the line break it looks like rather than nothing.
        const last = quote[quote.length - 1];
        if (last) last.br = true;
      }
      continue;
    }

    const bullet = BULLET.exec(content);
    if (bullet) {
      flushQuote();
      flushParagraph();
      // A bullet under a numbered list ends that list rather than joining it.
      if (ordered) flushList();
      ordered = false;
      listBlank = false;
      items.push([{ text: bullet[1], br }]);
      continue;
    }

    const numbered = ORDERED.exec(content);
    if (numbered) {
      flushQuote();
      flushParagraph();
      if (!ordered) flushList();
      // Only the first item's number is read. The rest are the reader's, and CommonMark
      // renumbers them anyway — a list written `1. 1. 1.` is still one, two, three.
      if (!items.length) start = Number(numbered[1]);
      ordered = true;
      listBlank = false;
      items.push([{ text: numbered[2], br }]);
      continue;
    }

    // A line that matches nothing while a list is open continues the item above it — which is
    // how a hard break *inside* a list item reaches this reader: Tiptap writes it as a second
    // line under the marker, and starting a paragraph here would split one item into a
    // one-item list and a stray paragraph. CommonMark calls it a lazy continuation, and a blank
    // line is what ends the item's reach: past one, this is a new block and the list is closed.
    const openItem = items[items.length - 1];
    if (openItem && !listBlank) {
      openItem.push({ text: content, br });
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push({ text: content, br });
  }

  flushList();
  flushQuote();
  flushParagraph();
  return out;
}

/**
 * A note body as the words in it, blocks separated by newlines and every mark gone.
 *
 * What it is for: {@link noteTitle}'s fallback line, and anywhere a note has to fit somewhere
 * that cannot draw. **It is not truncated here** — a clamp is a decision about how wide a row
 * is, and one made in this function would be made once for every surface that has a different
 * answer.
 */
export function noteToPlainText(body: string): string {
  return parseNoteBody(body).map(blockText).join("\n");
}
