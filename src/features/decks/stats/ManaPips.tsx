/**
 * What the deck's costs **ask for** and what its cards can **make**, side by side.
 *
 * The two halves are deliberately not one number. A pip is a demand — `{B}{B}` on four copies is
 * eight black pips whatever the manabase looks like — and a source is a supply, counted in
 * copies because Scryfall says *which* colours a card produces and never how much. Drawing them
 * as one figure would be this app inventing a ratio the data cannot support; drawing them as two
 * tracks in one tile lets the reader make the comparison themselves, which is the only place it
 * can honestly be made.
 *
 * **Two bands, then six tiles, and the two are different readings rather than a summary and its
 * detail.** A band is the deck's *shape* — present colours only, in `MANA_KEYS` order, one strip
 * the eye takes in at a glance — and it is the one place in this readout where a colour the deck
 * has nothing of draws nothing. The tiles are the *census*, and there all six are always drawn,
 * because a grid that changed its row count with the deck is one the reader has to read again
 * from scratch every time they edit.
 */
import type { CSSProperties, JSX, ReactNode } from "react";
import { ManaText } from "@/components/ManaText";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { plural } from "@/lib/counts";
import {
  MANA_FILL,
  MANA_KEYS,
  MANA_LABEL,
  manaSymbolClass,
  type ManaKey,
  type PipCounts,
} from "@/lib/mana";
import { cn } from "@/lib/utils";
import type { DeckStatsSummary } from "../DeckStats";
import { percent, StatsCard, Track } from "./StatsCard";

/**
 * The sentence the Sources half says when the corpus has never answered the question.
 *
 * **This is a third state and it must never be allowed to read as the second one.**
 * `DeckStatsSummary.sourcesKnown` is `false` only when *every* counted row came back `null` — a
 * database that has not re-ingested since the corpus grew `produced_mana` — where a genuine row
 * of zeroes is a real answer about a deck of sixty spells. Drawing zeroes for the unknown case
 * would tell every reader with a stale database that none of their decks makes any mana, which is
 * a chart that is confidently wrong rather than one that is honestly absent.
 */
const SOURCES_UNKNOWN = "Mana sources arrive with the next card sync";

/** The short form of {@link SOURCES_UNKNOWN} for a tile, which has no room for a sentence. The
 *  long one rides along as the tile's hint so the two cannot come to say different things. */
const SOURCES_UNKNOWN_SHORT = "awaiting card sync";

const COST_HINT =
  "Coloured pips this deck's costs ask for. A hybrid counts once in each of its halves, and generic mana is not a pip.";

const SOURCES_HINT =
  "Copies that can produce each colour. A dual land counts in every colour it makes, so these add up to more than the number of mana sources in the deck.";

/** The band's own label column. Fixed, so `Cost` and `Sources` start their tracks at one x. */
const BAND_LABEL = "w-[4.5rem] shrink-0 text-[0.9375rem] font-medium text-text";

export function ManaPips({ stats }: { stats: DeckStatsSummary }): JSX.Element {
  const { pips, pipCards, sources, sourcesKnown } = stats;

  const costTotal = total(pips);
  const sourceTotal = total(sources);

  // The union, so the two bands are segmented alike and a colour that only *appears* on one side
  // still holds its place on the other — a band whose segments moved between its two rows would
  // read as two different decks rather than as two facts about one.
  const present = MANA_KEYS.filter((key) => pips[key] > 0 || sources[key] > 0);

  return (
    <StatsCard title="Mana pips">
      <div className="flex flex-col gap-2">
        <Band label="Cost" keys={present} counts={pips} total={costTotal} hint={COST_HINT} />
        {sourcesKnown ? (
          <Band
            label="Sources"
            keys={present}
            counts={sources}
            total={sourceTotal}
            hint={SOURCES_HINT}
          />
        ) : (
          <div className="flex items-center gap-2">
            <span className={BAND_LABEL}>Sources</span>
            {/* No track at all rather than an empty one: an empty `bg-surface` strip beside a
                filled Cost band is exactly the row of zeroes this state exists to refuse, and a
                sentence in its place is the only thing that reads as a question nobody has
                answered yet. The height matches a band's so the pair stays a pair. */}
            <span className="flex h-8 min-w-0 flex-1 items-center text-[0.8125rem] text-dim">
              {SOURCES_UNKNOWN}
            </span>
          </div>
        )}
      </div>

      {/* Two columns whatever the deck is. See this file's header for why all six are drawn. */}
      <ul className="grid grid-cols-2 gap-2">
        {MANA_KEYS.map((key) => (
          <ColorTile
            key={key}
            colour={key}
            pips={pips[key]}
            pipCards={pipCards[key]}
            sources={sources[key]}
            sourcesKnown={sourcesKnown}
            costTotal={costTotal}
            sourceTotal={sourceTotal}
          />
        ))}
      </ul>
    </StatsCard>
  );
}

/** The six keys summed — the denominator a share is taken against. */
function total(counts: PipCounts): number {
  return MANA_KEYS.reduce((sum, key) => sum + counts[key], 0);
}

/**
 * One colour's share of a total, or `null` where there is nothing to take a share **of**.
 *
 * `null` and not `0`, because `percent` draws the two differently on purpose: an em dash says
 * *this colour is not in the question* where `0%` says *it is, and it rounds to nothing*.
 */
function shareOf(count: number, whole: number): number | null {
  return count > 0 && whole > 0 ? count / whole : null;
}

/**
 * One full-width segmented strip: the deck's colour mix in one line.
 *
 * The whole drawing is `aria-hidden` and the strip carries an `sr-only` sentence of its own. That
 * sentence does restate percentages the tiles below print again, and it is worth the repetition:
 * what a band says is the *mix* — which colours are in this deck at all, and in what proportion,
 * read as one phrase — and that is not something a reader can assemble from six tiles heard one
 * at a time.
 */
function Band({
  label,
  keys,
  counts,
  total: whole,
  hint,
}: {
  label: string;
  /** Which colours get a segment — the union of the two halves, computed once by the caller. */
  keys: readonly ManaKey[];
  counts: PipCounts;
  total: number;
  hint: ReactNode;
}): JSX.Element {
  const tip = useTooltip();
  const named = keys.filter((key) => counts[key] > 0);
  const spoken =
    named.length === 0
      ? `${label}: none.`
      : `${label}: ${named
          .map((key) => `${MANA_LABEL[key]} ${percent(shareOf(counts[key], whole))}`)
          .join(", ")}.`;

  return (
    <div className="flex items-center gap-2" {...tip(hint)}>
      <span className={BAND_LABEL}>{label}</span>
      <span className="sr-only">{spoken}</span>
      <span
        aria-hidden="true"
        className="flex h-8 min-w-0 flex-1 overflow-hidden rounded-md bg-surface"
      >
        {keys.map((key) => (
          <span
            key={key}
            // **The glyph's size is set here, on the segment, and never on the `<i>` that draws
            // it.** `mana-font`'s own `.ms` rule declares `font-size: inherit` — a class
            // selector, exactly as specific as a Tailwind utility, and `main.tsx` imports
            // `mana.css` after `index.css`, so on a tie source order hands the font the win. A
            // `text-[…]` written on the `<i>` would be in the markup, in the stylesheet, and
            // doing nothing; `DeckColorBar` carries the same arrangement and the measurement
            // behind it. 14px is what the pill this replaced occupied overall — `ms-cost` is
            // 1.3em of a glyph the font had already stepped to 0.95em of the 11px it inherited —
            // so the mark keeps its weight in the 32px band and loses only its disc.
            className="flex items-center justify-center text-[0.875rem] leading-none"
            style={{
              width: `${(shareOf(counts[key], whole) ?? 0) * 100}%`,
              background: MANA_FILL[key],
              // A flex item's automatic minimum size is its content, so without these two a
              // segment standing for 2% of the deck would be held open by the glyph inside it
              // and every segment after it would be pushed off the strip. The glyph is
              // decoration — every number it stands for is printed in the tiles below — so
              // clipping it is the right failure.
              minWidth: 0,
              overflow: "hidden",
              // The seam. `--color-bg` rather than a border, because a border is part of the box
              // and would be subtracted from the share the segment is drawn to stand for. On the
              // last segment it lands inside the strip's own rounded edge, where it reads as the
              // band's rim rather than as a seam.
              boxShadow: "inset -1px 0 0 var(--color-bg)",
            }}
          >
            {/* **The bare glyph on the field, never `ManaText`'s `ms-cost` pill.** That pill is
                the font's own printed symbol — an opaque disc in `mana-font`'s palette with the
                glyph knocked out of it — and it is right everywhere a symbol sits on a surface
                that is not already the colour, which is what the census tiles below and
                `CurveByColor` are. Here the field *is* the colour, so the pill landed as a
                second, slightly-off disc on top of it: `#aca29a` on `--color-mana-b`, `#db8664`
                on `--color-mana-r`. It read as a smudge behind the pip rather than as a symbol,
                and it disagreed with the deck gallery's own band, which has drawn a knocked-out
                glyph straight on the fill since it shipped. So this is `DeckColorBar`'s
                arrangement character for character — `manaSymbolClass` in `text-black`, sized by
                the parent — and the two bands are one drawing of one fact again.

                `aria-hidden` because the glyph is a font `::before` on an empty element with
                nothing to announce; the strip above it is hidden anyway, and the sentence a
                reader hears is the `sr-only` span beside it. */}
            <i className={cn(manaSymbolClass(key), "text-black")} aria-hidden="true" />
          </span>
        ))}
      </span>
    </div>
  );
}

/** One colour's census tile: what the costs ask of it, and what the deck can make of it. */
function ColorTile({
  colour,
  pips,
  pipCards,
  sources,
  sourcesKnown,
  costTotal,
  sourceTotal,
}: {
  colour: ManaKey;
  pips: number;
  pipCards: number;
  sources: number;
  sourcesKnown: boolean;
  costTotal: number;
  sourceTotal: number;
}): JSX.Element {
  // With the sources unknown every key's `sources` is 0, so this reduces to "no pips of this
  // colour" — which is the honest reading: the cost half is answered for every colour, and the
  // source half is unanswered for every colour equally and so cannot tell one tile from another.
  const idle = pips === 0 && sources === 0;

  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border border-border p-2",
        // Dimmed rather than dropped — the grid is a shape the reader learns the positions of.
        idle && "opacity-45",
      )}
    >
      <span aria-hidden="true">
        <ManaText source={`{${colour}}`} className="text-[0.875rem]" />
      </span>
      {/* `ManaText` spells its own token — "W" — which is a wire format rather than a word. */}
      <span className="sr-only">{MANA_LABEL[colour]}</span>

      <Figure
        word="Cost"
        share={shareOf(pips, costTotal)}
        fill={MANA_FILL[colour]}
        caption={pips > 0 ? `${plural(pips, "pip")} · ${plural(pipCards, "card")}` : "no pips"}
      />

      {sourcesKnown ? (
        <Figure
          word="Sources"
          share={shareOf(sources, sourceTotal)}
          fill={MANA_FILL[colour]}
          // The two halves of one colour are one hue at two weights: the supply is the fainter
          // of the pair, so a tile reads as one colour answering two questions rather than as
          // two colours that happen to sit together.
          fillStyle={{ opacity: 0.55 }}
          // **`N sources`, and deliberately not `N sources · M cards`.** The design spells a
          // two-term caption here, mirroring the cost's, and it cannot be honest: Scryfall's
          // `produced_mana` says *which* colours a card makes and never *how much*, so a source
          // is a copy — "sources" and "cards that are sources" are the same number by
          // construction, and printing both would be one figure twice with a `·` between them
          // implying it is two.
          caption={sources > 0 ? plural(sources, "source") : "no sources"}
        />
      ) : (
        <Figure
          word="Sources"
          share={null}
          fill={MANA_FILL[colour]}
          // No track: see {@link SOURCES_UNKNOWN}. An empty track under an em dash still reads as
          // a measured zero to anyone glancing at the grid.
          drawTrack={false}
          caption={SOURCES_UNKNOWN_SHORT}
          hint={SOURCES_UNKNOWN}
        />
      )}
    </li>
  );
}

/**
 * One line of a tile: the word, the track, the percentage, and the caption under them.
 *
 * The word and the percentage take fixed columns so the six tiles' tracks start and end at the
 * same two x positions — six bars that each began where their own label happened to end would be
 * six charts rather than one grid. What that costs is the track itself at the narrowest useful
 * width, and the sum is taken at the band's own floor: a stats column is `min-w-[22rem]` (352px),
 * which leaves this card 326px of content, a tile 159px and a tile's content box **141px** — of
 * which the two fixed columns and the two gaps take 96, leaving the track **~45px**. It is a
 * proportion bar rather than something anybody measures off, and the percentage beside it is the
 * number, so a short track is a legible failure; the alternative — a track on a line of its own —
 * spends a third line per figure and six lines per card.
 *
 * **All three strings are `text-xs`, and the two column widths are that size measured rather than
 * guessed** (2026-09-10, the reader's report that the tile read too small). They were
 * `text-[0.625rem]` — the app's smallest type, two steps under the `text-xs` every other readout
 * in this band writes its figures at, on the one card where the numbers are the whole readout. At
 * 12px in this app's own faces `Sources` is **46.1px** and a mono `100%` is **28.8px**, so the
 * columns are `w-13` (52) and `w-9` (36) rather than the 44 and 32 that fitted 10px type; a word
 * that does not fit its `shrink-0` column wraps to two lines and takes the row's baseline with it.
 * **The caption is deliberately left free to wrap** — it is the one string with no ceiling
 * (`110 pips · 100 cards` is 144px at this size), and a second line under a tall deck's tile is a
 * better failure than a truncation that eats the `· N cards` half.
 */
function Figure({
  word,
  share,
  fill,
  fillStyle,
  caption,
  drawTrack = true,
  hint,
}: {
  word: string;
  /** `null` where there is nothing to take a share of — drawn as an em dash, never `0%`. */
  share: number | null;
  fill: string;
  /** Spread onto the fill itself, which is what `Track` does with its `style`. */
  fillStyle?: CSSProperties;
  caption: string;
  drawTrack?: boolean;
  hint?: ReactNode;
}): JSX.Element {
  const tip = useTooltip();
  return (
    <div className="flex min-w-0 flex-col gap-0.5" {...tip(hint)}>
      <div className="flex items-center gap-1">
        <span className="w-13 shrink-0 text-xs font-medium text-text">{word}</span>
        {drawTrack ? (
          <Track share={share ?? 0} fill={fill} style={fillStyle} />
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-text">
          {percent(share)}
        </span>
      </div>
      <span className="font-mono text-xs text-dim">{caption}</span>
    </div>
  );
}
