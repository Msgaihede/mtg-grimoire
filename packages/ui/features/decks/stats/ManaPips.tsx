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
 *
 * **Colourless can be taken out of the question** (issue #513), from a toggle at the card's
 * top-right. Colourless is the one key that is not a colour of the pie — a pile of `{C}` rocks and
 * Wastes can take half of both bands and squeeze the five colours a reader is balancing into
 * slivers. Hidden, it leaves both bands **and both denominators**, so a tile's percentage keeps
 * agreeing with the band above it; the Colourless tile stays in the grid, for the grid's reason,
 * with its counts still printed and both shares an em dash — `percent`'s *not in the question*.
 * Not a stored preference, like `CardDistribution`'s `by`: it is a way of reading the chart rather
 * than a fact about the deck. **It is `DeckStats`' state rather than this card's** since
 * 2026-09-28, handed in as `hideColorless` with `onHideColorlessChange` beside it, because the
 * band's three-column layout moves this card between column containers and a move remounts it —
 * held here, widening the window past the breakpoint would put colourless back.
 *
 * **Labels sit above what they label** (2026-09-28): `Cost` and `Sources` over their bands, which
 * take the card's whole width, and each tile's `(U) Cost` / `(U) Sources` over its own track. The
 * tile's separate symbol row is gone — the symbol leads each header instead, so a tile is two
 * figures rather than a glyph and two figures.
 */
import type { JSX, ReactNode } from "react";
import { ManaText } from "@/components/ManaText";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import {
  MANA_FILL,
  MANA_KEYS,
  MANA_LABEL,
  manaSymbolClass,
  type ManaKey,
  type PipCounts,
} from "@/lib/mana";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { DeckStatsSummary } from "../DeckStats";
import { percent, StatsCard } from "./StatsCard";

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
const SOURCES_UNKNOWN = "Mana sources appear after the next card sync.";

/** The short form of {@link SOURCES_UNKNOWN} for a tile, which has no room for a sentence. The
 *  long one rides along as the tile's hint so the two cannot come to say different things. */
const SOURCES_UNKNOWN_SHORT = "awaiting card sync";

const COST_HINT =
  "Total colored mana symbols in casting costs. Hybrid symbols count toward both colors; generic mana is excluded.";

const SOURCES_HINT =
  "Mana-producing cards for each required color and colorless. Multi-color sources count toward each color they produce.";

/** A band's label, set **above** its strip so the strip takes the card's full width.
 *  `CreatureSplitBar` spells the same label, so the two bands read as one grammar. */
const BAND_LABEL = "text-[0.9375rem] font-medium text-text";

/** The toggle's accessible name. Names the card it acts on, so it cannot be confused with any
 *  other colourless control on the screen, and stays one string whether pressed or not —
 *  `aria-pressed` carries the state. */
export const HIDE_COLORLESS_LABEL = "Hide colorless in mana pips";

export function ManaPips({
  stats,
  hideColorless,
  onHideColorlessChange,
}: {
  stats: DeckStatsSummary;
  /** Colourless taken out of both bands and both denominators — issue #513, held by `DeckStats`. */
  hideColorless: boolean;
  /** Asked for the other state when the toggle is pressed; this card never sets it itself. */
  onHideColorlessChange: (next: boolean) => void;
}): JSX.Element {
  const { pips, pipCards, sources, sourcesKnown } = stats;
  const tip = useTooltip();

  // The keys in the question. Everything below reads this rather than `MANA_KEYS`, so a hidden
  // colourless leaves the bands and the denominators together — see this file's header.
  const counted: readonly ManaKey[] = hideColorless
    ? MANA_KEYS.filter((key) => key !== "C")
    : MANA_KEYS;

  const costTotal = total(pips, counted);
  const sourceTotal = total(sources, counted);

  // The union, so the two bands are segmented alike and a colour that only *appears* on one side
  // still holds its place on the other — a band whose segments moved between its two rows would
  // read as two different decks rather than as two facts about one.
  const present = counted.filter((key) => pips[key] > 0 || sources[key] > 0);

  return (
    <StatsCard
      title="Mana pips"
      actions={
        <button
          type="button"
          aria-pressed={hideColorless}
          aria-label={HIDE_COLORLESS_LABEL}
          onClick={() => onHideColorlessChange(!hideColorless)}
          {...tip(
            hideColorless
              ? "Include colorless mana in Cost and Sources."
              : "Exclude colorless mana from Cost and Sources.",
          )}
          className={cn(
            // `Dropdown size="sm"`'s box, so this sits on the heading line at the height the
            // Card distribution card's select does one readout over.
            "inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs",
            PRESS,
            FOCUS,
            hideColorless ? "border-accent text-accent" : "border-border text-dim hover:text-text",
          )}
        >
          <span aria-hidden="true">
            <ManaText source="{C}" className="text-[0.75rem]" />
          </span>
          {/* One word in both states — the accent edge and `aria-pressed` say which — so the
              visible label stays inside the accessible name (WCAG 2.5.3). */}
          <span aria-hidden="true">Hide</span>
        </button>
      }
    >
      <div className="flex flex-col gap-2.5">
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
          <div className="flex flex-col gap-1">
            <span className={BAND_LABEL}>Sources</span>
            {/* No track at all rather than an empty one: an empty `bg-surface` strip beside a
                filled Cost band is exactly the row of zeroes this state exists to refuse, and a
                sentence in its place is the only thing that reads as a question nobody has
                answered yet. The height matches a band's so the pair stays a pair. */}
            <span className="flex h-8 min-w-0 items-center text-[0.8125rem] text-dim">
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
            // Out of the question, so both shares are an em dash rather than a slice of a total
            // this key is no longer in. The counts in the captions are still true and stay.
            costTotal={counted.includes(key) ? costTotal : 0}
            sourceTotal={counted.includes(key) ? sourceTotal : 0}
            excluded={!counted.includes(key)}
          />
        ))}
      </ul>
    </StatsCard>
  );
}

/** The counted keys summed — the denominator a share is taken against. */
function total(counts: PipCounts, keys: readonly ManaKey[]): number {
  return keys.reduce((sum, key) => sum + counts[key], 0);
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
    <div className="flex flex-col gap-1" {...tip(hint)}>
      {/* `aria-hidden` because the sentence beside it opens with the same word — `Cost: White
          42%, …` — and a label read out before its own sentence is the word twice. */}
      <span className={BAND_LABEL} aria-hidden="true">
        {label}
      </span>
      <span className="sr-only">{spoken}</span>
      <span aria-hidden="true" className="flex h-8 w-full overflow-hidden rounded-md bg-surface">
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
  excluded,
}: {
  colour: ManaKey;
  pips: number;
  pipCards: number;
  sources: number;
  sourcesKnown: boolean;
  costTotal: number;
  sourceTotal: number;
  /** Taken out of the question by the card's toggle — dimmed like an idle tile. */
  excluded: boolean;
}): JSX.Element {
  // With the sources unknown every key's `sources` is 0, so this reduces to "no pips of this
  // colour" — which is the honest reading: the cost half is answered for every colour, and the
  // source half is unanswered for every colour equally and so cannot tell one tile from another.
  const idle = excluded || (pips === 0 && sources === 0);

  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border border-border p-2",
        // Dimmed rather than dropped — the grid is a shape the reader learns the positions of.
        idle && "opacity-45",
      )}
    >
      {/* The colour's name for a screen reader, said once for the tile. The symbol that stands for
          it on screen leads each header below, and `ManaText` spells its own token — "W" — which
          is a wire format rather than a word. */}
      <span className="sr-only">{MANA_LABEL[colour]}</span>

      <Figure
        colour={colour}
        word="Cost"
        share={shareOf(pips, costTotal)}
        fill={MANA_FILL[colour]}
        caption={pips > 0 ? `${plural(pips, "pip")} · ${plural(pipCards, "card")}` : "no pips"}
      />

      {sourcesKnown ? (
        <Figure
          colour={colour}
          word="Sources"
          share={shareOf(sources, sourceTotal)}
          // The two halves of one colour are one hue at two weights: the supply is the fainter
          // of the pair, so a tile reads as one colour answering two questions rather than as
          // two colours that happen to sit together. **Thinned with `color-mix` and never
          // `opacity`** (2026-09-28): the percentage is printed on the fill now, and opacity on
          // the fill would take the number down with it.
          fill={`color-mix(in srgb, ${MANA_FILL[colour]} 55%, transparent)`}
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
          colour={colour}
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
 * One figure of a tile: `(U) Cost` over its track, the caption under it.
 *
 * **The percentage lives inside the track** (2026-09-28), which is what freed the header and the
 * track to take the tile's whole width. It used to be a fixed `w-9` column right of a track
 * squeezed between it and a `w-13` word column, which at the band's 22rem floor left the track
 * ~45px — a proportion bar nobody could read a proportion off. Now the word sits over the track
 * with the colour's symbol before it, the track is {@link TRACK_HEIGHT}px tall across the tile's
 * full content box (~141px at that floor), and the number is on the fill it stands for.
 *
 * **The caption is deliberately left free to wrap** — it is the one string with no ceiling
 * (`110 pips · 100 cards` is 144px at `text-xs`), and a second line under a tall deck's tile is a
 * better failure than a truncation that eats the `· N cards` half.
 */
function Figure({
  colour,
  word,
  share,
  fill,
  caption,
  drawTrack = true,
  hint,
}: {
  colour: ManaKey;
  word: string;
  /** `null` where there is nothing to take a share of — drawn as an em dash, never `0%`. */
  share: number | null;
  /** The fill as a CSS colour — the mana fill, or the thinned `color-mix` of it for Sources. */
  fill: string;
  caption: string;
  drawTrack?: boolean;
  hint?: ReactNode;
}): JSX.Element {
  const tip = useTooltip();
  return (
    <div className="flex min-w-0 flex-col gap-1" {...tip(hint)}>
      <span className="flex items-center gap-1.5 text-xs font-medium text-text">
        {/* The symbol and never the colour's name: the tile's `sr-only` name has said it once. */}
        <span aria-hidden="true" className="inline-flex">
          <ManaText source={`{${colour}}`} className="text-[0.8125rem]" />
        </span>
        {word}
      </span>
      {drawTrack ? <ShareTrack share={share} fill={fill} /> : null}
      <span className="font-mono text-xs text-dim">{caption}</span>
    </div>
  );
}

/** How tall a tile's track is drawn — room for an 11px figure inside it with air either side. */
const TRACK_HEIGHT = 18;

/**
 * The share below which the percentage is printed **just past** the fill rather than on it.
 *
 * 0.2 is where the figure stops fitting on its fill: it is 11px Geist Mono, ~6.6px a character,
 * so `20%` is ~20px, and a fifth of a tile's content box at the band's floor (~141px) is 28px.
 * Under it the number would overhang its own fill onto the empty track in black, which is the
 * one colour that disappears there.
 */
const INSIDE_MIN_SHARE = 0.2;

/** The figure's type, on the fill or off it. */
const SHARE_TYPE = "font-mono text-[0.6875rem] font-semibold leading-none tabular-nums";

/**
 * A tile's track with its percentage drawn in it — this file's own rather than `StatsCard`'s
 * `Track`, which draws a bare fill for the odds table and the creature rows and has no place for
 * a number.
 *
 * Three placements, one per state a share can be in: **on the fill**, centred, in black like a
 * glyph on a mana symbol; **just past the fill** in `text-text` where the fill is under
 * {@link INSIDE_MIN_SHARE}; and an **em dash centred in the empty track** in `text-dim` where
 * there is no share at all (`percent`'s *not in the question*). Only the fill is `aria-hidden` —
 * the number is text a screen reader reads after the header word, as it did when it sat in a
 * column of its own.
 */
function ShareTrack({ share, fill }: { share: number | null; fill: string }): JSX.Element {
  // Clamped for `Track`'s reason: two independently rounded counts can land a hair outside.
  const width = share === null ? 0 : Math.max(0, Math.min(1, share)) * 100;
  return (
    <span
      className="relative block w-full overflow-hidden rounded-sm bg-surface"
      style={{ height: TRACK_HEIGHT }}
    >
      <span
        aria-hidden="true"
        data-share-fill=""
        className="absolute inset-y-0 left-0 rounded-sm"
        style={{ width: `${width}%`, background: fill }}
      />
      {share === null ? (
        <span
          data-share="none"
          className={cn("absolute inset-0 flex items-center justify-center text-dim", SHARE_TYPE)}
        >
          {percent(null)}
        </span>
      ) : share >= INSIDE_MIN_SHARE ? (
        <span
          data-share="inside"
          className={cn(
            "absolute inset-y-0 left-0 flex items-center justify-center text-black",
            SHARE_TYPE,
          )}
          style={{ width: `${width}%` }}
        >
          {percent(share)}
        </span>
      ) : (
        <span
          data-share="beside"
          className={cn("absolute inset-y-0 flex items-center text-text", SHARE_TYPE)}
          style={{ left: `calc(${width}% + 4px)` }}
        >
          {percent(share)}
        </span>
      )}
    </span>
  );
}
