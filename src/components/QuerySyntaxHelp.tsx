import { Fragment } from "react";
import { QUERY_KEYWORDS, type KeywordSpec, type PredicateOp } from "@/features/search/queryLanguage";
import { cn } from "@/lib/utils";

/**
 * A section's caption, spelled here rather than imported from {@link KeyMap}.
 *
 * The same four utilities `FilterChips`' `FILTER_LABEL`, `PrintingsFilterBar`'s `CAPTION` and
 * `KeyMap`'s own `SECTION` carry, and a fourth spelling for a reason those three do not have:
 * `KeyMap` draws this component, so importing back out of it would be a **cycle**. A `const`
 * string survives one under ESM and that is exactly the kind of thing that stops being true
 * during a refactor, for a saving of four class names.
 */
const SECTION = "text-[0.6875rem] uppercase tracking-[0.08em] text-dim";

/**
 * A literal the reader types, standing in a line of prose.
 *
 * Chipped only **here**, and the asymmetry with the table below is deliberate rather than
 * drift: an example in the table already has a column to itself and needs nothing to be found
 * in, while a lone `-` in a sentence of dim text is a hyphen until something says otherwise.
 * `bg-bg` is the one darker surface this app has and it is what {@link KeyMap}'s keycap sits
 * on; no border and no thickened edge, because a query is not a key and a box that looked like
 * a cap on the *other* tab's vocabulary would be the panel saying something untrue.
 *
 * **`whitespace-nowrap` is not tidying.** A query term is one token and the line is 358px wide:
 * without it `-t:land` broke after the `-` and the sentence taught the reader a query that is
 * two terms, one of which is a bare minus. Measured in a browser, 2026-09-22 — jsdom wraps
 * nothing, so the only witness is a rendered line.
 */
const LITERAL = "whitespace-nowrap rounded bg-bg px-1 font-mono text-text";

/**
 * The operators that make a keyword a *comparison* rather than a match.
 *
 * `ne` is deliberately absent: `!=` is a negation of whatever the keyword already does, and no
 * row in the table carries it without also carrying the four below. Typed as
 * {@link PredicateOp}, so a misspelling here is a compile error rather than a group that
 * silently never matches.
 */
const RANGE_OPS: readonly PredicateOp[] = ["gt", "gte", "lt", "lte"];

/**
 * Which of the three groups a keyword belongs in — **derived from the row, never listed.**
 *
 * A second table naming which keyword goes where would be the drift `QUERY_KEYWORDS` exists to
 * end, one step removed: the parser would read one list and the panel another, and a keyword
 * added to the vocabulary would go missing from the panel with nothing red. So the question is
 * asked of the row itself. A tag names a taxonomy; a keyword that accepts `<` or `>` is
 * something you can put a range on; everything else is matched as text. Every row lands in
 * exactly one of the three by construction, which is why there is no fallback group and no way
 * for a row to be dropped — `KeyMap.test.tsx` draws the whole table and counts.
 */
function groupOf(spec: KeywordSpec): number {
  if (typeof spec.target !== "string") return 2;
  return spec.ops.some((op) => RANGE_OPS.includes(op)) ? 1 : 0;
}

/**
 * The groups, in the order they are drawn, each with the rows {@link groupOf} put in it.
 *
 * Computed once at module scope: {@link QUERY_KEYWORDS} is a constant, so re-bucketing it on
 * every open of the panel would be work with no input that can change. An empty group draws
 * nothing at all rather than a heading over a gap — `KeyMap`'s rule for a scope with no
 * shortcuts, met here for the same reason.
 */
const GROUPS = ["Text and names", "Numbers and colours", "Tags"]
  .map((heading, at) => ({ heading, specs: QUERY_KEYWORDS.filter((spec) => groupOf(spec) === at) }))
  .filter((group) => group.specs.length > 0);

/**
 * What a reader may type into any card search box in this app, drawn from the parser's own
 * vocabulary.
 *
 * **One table, two readers** — `src/lib/shortcuts.ts`'s principle one module over. Every row
 * here is a row of {@link QUERY_KEYWORDS}, which is also what `parseQuery` matches against, so
 * this panel cannot advertise a keyword the search box ignores. Nothing about a keyword is
 * written down twice: the spellings, the example and the sentence all come off the row, the
 * grouping is derived from it, and the single paragraph of prose says only the thing no row
 * can — how two terms combine.
 *
 * **A dictionary rather than the other tab's caps**, and that is why this is a tab and not a
 * fifth section of the shortcuts list. A chord is a legend printed on a key, drawn as a key;
 * a query term is a word with a meaning, drawn as a headword with its definition beside it.
 * The two share a `<dl>` and a two-column grid and nothing else, which is as much resemblance
 * as they have.
 *
 * **No colour of its own.** The panel's one accent is the lit tab above this, and a reference
 * table that also spent gold on its examples would be two things asking to be looked at first.
 */
export function QuerySyntaxHelp() {
  return (
    <>
      {/* The one thing the table cannot say: what happens when a reader types two terms. It is
          first because it is true of every row under it, and it is the only prose here — a
          second paragraph restating the keywords in sentences is the drift this component's
          whole shape refuses. */}
      <p className="text-xs leading-5 text-dim">
        Terms narrow together. A leading <code className={LITERAL}>-</code> excludes one:{" "}
        <code className={LITERAL}>-t:land</code>
      </p>

      <div className="mt-3">
        {GROUPS.map(({ heading, specs }) => (
          <Fragment key={heading}>
            {/* `<h2>`, matching the shortcuts tab's scope headings: the two are the same rung of
                one panel, and a jump to `<h3>` with no `<h2>` over it would be a level skipped
                for a visual difference that does not exist. */}
            <h2 className={cn(SECTION, "mt-4 mb-1.5 first:mt-0")}>{heading}</h2>
            {/* The term column is `auto` — sized by the widest spelling list rather than by a
                number picked here, so a keyword with a fourth spelling widens the column
                instead of wrapping out of it. `items-baseline` lands each blurb on the first of
                the term's two lines. */}
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">
              {specs.map((spec) => (
                <Fragment key={spec.example}>
                  <dt>
                    {/* **The example leads, and it is the only mono line.** It is the thing a
                        reader copies, so it is what the eye should land on and what the blurb
                        beside it is aligned to; the spellings under it are which other words
                        reach the same place, which is the second question and not the first.
                        Mono is also what buys the layout: the widest spelling list —
                        `otag · oracletag · function` — is **178px** in Geist Mono at 11px and
                        **127px** in the app's sans, against a 348px content box. Set in mono
                        it takes so much of the row that `Oracle tag — what it does` wraps;
                        set in sans, no description in the table wraps at all and the three
                        groups' columns land within 19px of each other instead of 40.
                        Measured in a browser over the compiled stylesheet with both real
                        faces loaded, 2026-09-22 — jsdom lays none of this out. */}
                    <span className="font-mono text-xs text-text">{spec.example}</span>
                    {/* **The space is markup, not the line break.** Adjacent element
                        contributions concatenate when a text alternative is flattened — this
                        repo has paid for that twice, with `Missing2` and with `Ctrl1toCtrl9` —
                        so without it the row is read out as `t:goblint · type`. A trailing
                        space before a block element costs nothing on screen. */}{" "}
                    <span className="mt-0.5 block text-[0.6875rem] text-dim">
                      {spec.keywords.join(" · ")}
                    </span>
                  </dt>
                  <dd className="text-sm">{spec.blurb}</dd>
                </Fragment>
              ))}
            </dl>
          </Fragment>
        ))}
      </div>
    </>
  );
}
