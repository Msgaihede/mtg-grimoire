import { useState, type JSX } from "react";
import { RotateCcw } from "lucide-react";
import { TheoryMatchMark } from "@/features/decks/CardMarks";
import { LabelColorRow, LabelSwatch } from "@/features/decks/LabelColorPicker";
import type { TheoryTier } from "@/features/decks/theoryMatch";
import { FOCUS } from "@/lib/focus";
import { labelFgCss } from "@/lib/hexColor";
import { MARK_COLOR_DEFAULTS, useMarkColors, type MarkColorKey } from "@/lib/useMarkColors";
import { cn } from "@/lib/utils";
import { BUTTON } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";

/**
 * The two colours the theory marks are drawn in, and the reader's to change.
 *
 * ## Why this is a settings panel rather than a preference nobody offers
 *
 * A deck that keeps a plan marks every card on its **live** list against it, in two tiers: one
 * colour for the printing the plan actually names, another for the same card in a printing it
 * does not. `CardMarks.tsx` sets out the four separations that keep a tick from reading as the
 * app's "there is a problem here" mark — the corner, the colour, the shape and the card's own
 * edge — and says out loud that **the colour is the one of the four a reader can defeat**. This
 * panel is where they defeat it, deliberately: the other three are structural and hold whatever
 * is picked here, which is exactly why there are four of them.
 *
 * A green tick and an azure one are also the two marks a reader with a red-green or a blue-yellow
 * confusion has the hardest time telling apart, and no palette this app ships is the right answer
 * for every pair of eyes. The `data-theory-match` attribute and the marks' own words carry the
 * distinction for anybody reading them another way; this is for the reader who can see them and
 * wants them further apart than we chose.
 *
 * ## Draft, then commit
 *
 * `input[type=color]` fires continuously while the OS dialog is being dragged, so a control that
 * wrote on every change would send one `set_mark_color` per pixel of travel. The open picker's
 * colour is therefore a **draft** held here — `LabelsDialog`'s arrangement one folder over, and
 * for its reason: the draft lives with "which row is open" as one piece of state, so opening
 * **is** the reset and closing throws the draft away with no effect to write.
 *
 * ## What this panel does not touch
 *
 * Whether a deck draws these marks at all is the deck's own two switches, and this changes
 * neither. A reader who has turned the loose tier off sees no azure mark anywhere and can still
 * pick its colour here, which is the honest arrangement: the switch is about one deck and the
 * colour is about this device.
 */
export function TheoryMarksPanel(): JSX.Element {
  const { colors, setColor, resetColor, failure } = useMarkColors();
  /**
   * Which mark's picker is open, **and the colour it is currently on** — one piece of state
   * rather than two, which is what keeps a `useEffect` out of the row: a draft held per row would
   * have to be cleared when the picker closed, and a piece of state derived from another piece of
   * state is a cascade. Opening seeds it from the mark's own colour, so a reader who opens the
   * picker to look and closes it again has written nothing.
   */
  const [picking, setPicking] = useState<{ key: MarkColorKey; color: string } | null>(null);

  return (
    <SettingsSection id="theory-marks" title="Theory marks">
      {/* **Neither colour is named in this sentence**, which is the one thing the prose here has
          to get right: the reader may already have replaced both, and a panel that opened by
          calling one of them green would be describing the screen it is sitting on wrongly. What
          it says instead is what the two marks *mean*, which is the thing that does not move. */}
      <p className="text-sm text-dim">
        A deck that keeps a theory list marks the cards on its live list against it — one colour
        where the printing is the one the theory names, another where it is the same card in a
        printing the theory does not name. A card the theory asks a different number of wears the
        difference instead of the tick.
      </p>

      {/* `space-y-4` over a hairline the first row does not wear — `HiddenTagsPanel`'s list,
          verbatim but for the gap, so two panels in one pane rule their rows the same way. */}
      <ul className="space-y-4">
        {MARKS.map((mark) => {
          const stored = colors[mark.key];
          const drafting = picking?.key === mark.key;
          // What the preview is drawn in: the draft while one is open, and the committed colour
          // otherwise — so the mark moves under the reader's hand rather than after Done.
          const shown = drafting ? picking.color : stored;
          // Nothing to put back for a mark that is already the stylesheet's. It is the only thing
          // on this panel that says whether the reader has customised anything at all.
          const untouched = stored === MARK_COLOR_DEFAULTS[mark.key];

          return (
            <li
              key={mark.key}
              className="border-t border-border pt-4 first:border-t-0 first:pt-0"
            >
              <div
                role="group"
                aria-labelledby={`${mark.id}-heading`}
                style={previewVars(mark, shown)}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <h3 id={`${mark.id}-heading`} className="text-sm text-text">
                    {mark.title}
                  </h3>

                  {/* The mark itself, on the app's own background rather than on the panel's
                      card, because that is the tone it is really drawn against: these marks live
                      on card art, and a fill judged against a pale surface is judged against a
                      surface it never meets. Both states, because the number *replaces* the tick
                      on a card the theory asks a different count of — a preview of the tick alone
                      would be a preview of half of what this colour reaches. */}
                  <span className="flex items-center gap-2 rounded-md bg-bg px-2 py-1.5">
                    <TheoryMatchMark tier={mark.tier} delta={0} />
                    <TheoryMatchMark tier={mark.tier} delta={PREVIEW_DELTA} />
                  </span>

                  <div className="ml-auto flex items-center gap-2">
                    {/* The swatch is both the trigger and the answer to "what is it set to now",
                        which is `LabelColorButton`'s argument at its own site. This is
                        `LabelsDialog`'s row trigger rather than that button, and the reason is
                        the row beside it: `Change the matching-printing mark's colour` and
                        `Reset the matching-printing mark…` are one pair naming one thing, where
                        `Choose matching printing colour` would put a third wording for the same
                        mark on the same line. (`LabelColorButton` takes a `subject` of its own
                        now, so it is a choice between two correct controls rather than a way
                        round a broken one.) */}
                    <button
                      type="button"
                      onClick={() =>
                        setPicking((open) =>
                          open?.key === mark.key ? null : { key: mark.key, color: stored },
                        )
                      }
                      aria-expanded={drafting}
                      aria-label={`Change the ${mark.noun}'s colour`}
                      className={cn(
                        "grid size-8 shrink-0 place-items-center rounded-md border border-border",
                        "transition-colors duration-150 hover:border-accent",
                        "motion-reduce:transition-none",
                        drafting && "border-accent",
                        FOCUS,
                      )}
                    >
                      <LabelSwatch color={shown} className="size-4 rounded-[3px]" />
                    </button>

                    {/* **Clears rather than writes today's hex**, which is `useMarkColors`'
                        rule: a reader who has never chosen and one who has just reset have to end
                        in the same state, and they only do if the row is deleted.

                        `aria-disabled` rather than the attribute — the app's rule, since a
                        `disabled` button leaves the tab order and a reader tabbing the panel
                        would find the two marks' controls unevenly spaced for a reason nothing
                        announces. The guard is on the handler, where it has to be. */}
                    <button
                      type="button"
                      onClick={() => {
                        if (untouched) return;
                        // A draft is about a colour that is being thrown away, so it goes too.
                        setPicking(null);
                        resetColor(mark.key);
                      }}
                      aria-disabled={untouched || undefined}
                      aria-label={`Reset the ${mark.noun} to its default colour`}
                      className={cn(
                        BUTTON,
                        "border-border hover:bg-bg",
                        "aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
                        "aria-disabled:hover:bg-transparent aria-disabled:active:scale-100",
                      )}
                    >
                      <RotateCcw className="size-4" aria-hidden="true" />
                      Reset
                    </button>
                  </div>
                </div>

                <p className="mt-1.5 text-sm text-dim">{mark.blurb}</p>

                {drafting && (
                  <LabelColorRow
                    // **What is being coloured, said in the reader's words rather than the
                    // component's.** The picker's own default is `"Label colour"`, and a label is
                    // not a mark — the two are different objects in this app and the vocabulary
                    // rule is that they never trade places. Left at the default, a screen-reader
                    // user recolouring the green tick would hear "Label colour" twice, once per
                    // mark, with nothing telling the two apart.
                    subject={mark.subject}
                    value={picking.color}
                    onChange={(color) => setPicking({ key: mark.key, color })}
                    onDone={() => {
                      // Nothing at all when the colour did not move: Done is how the picker
                      // closes, so it is pressed by readers who opened it to look.
                      if (picking.color !== stored) setColor(mark.key, picking.color);
                      setPicking(null);
                    }}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* **The one sentence a reader with two devices cannot do without.** These colours are an
          `app_meta` row, and `app_meta` is not among the twelve tables sync carries — while the
          per-deck switches that decide whether a mark is drawn at all, and the labels a reader
          puts on cards, are. So the same deck really can wear one reader's green here and the
          stylesheet's on the phone beside it, and that is the design rather than a fault to be
          reported. */}
      <p className="text-sm text-dim">
        These colours are kept only on this device. The theory switches on each deck, and your
        labels, are synced as usual — these are not.
      </p>

      {/* `problem`, and this is the one hook in the app whose refusal is surfaced at all: the
          reader is standing in front of a swatch watching it move, where the rail's silent trade
          costs them nothing they can see until the next launch. The colour they picked stays on
          screen for the session, so the red is the only thing separating "refused" from "saved".
          See `useMarkColors`. */}
      <PanelAlert tone="problem">{failure}</PanelAlert>
    </SettingsSection>
  );
}

/**
 * The count difference the preview draws, so the reader sees the state that is *not* a tick.
 *
 * Positive and small: a `+2` is two characters in the same fixed-advance box the tick occupies,
 * which is what makes the two previews the same shape. The sign is ASCII for `theoryDeltaText`'s
 * reason — the typographic minus is not in that face's fixed-advance run.
 */
const PREVIEW_DELTA = 2;

/** One row of this panel: a mark, the words for it, and the name its two controls are found by. */
interface MarkRow {
  /** The stored key, and what `set_mark_color` is called with. */
  key: MarkColorKey;
  /** Which mark to draw — `CardMarks.tsx` takes this and decides the fill from it. */
  tier: TheoryTier;
  /** The stem of this row's heading id, so the group and its heading cannot come apart. Written
   *  rather than `useId()`, which is `panelChrome.tsx`'s call for its reason: a generated `:r7:`
   *  moves with the render order of the page and these ids are readable in the shipped window. */
  id: string;
  /** The heading, and through `aria-labelledby` the group's name. */
  title: string;
  /** What this tier means, in the deck's own words rather than the code's. */
  blurb: string;
  /**
   * How the swatch and the Reset name themselves.
   *
   * **Each row's controls are named for the mark they belong to**, which is `HiddenTagsPanel`'s
   * rule: two buttons reading "Reset" are two buttons a screen reader cannot tell apart, and the
   * visible word still leads the accessible name (WCAG 2.5.3).
   */
  noun: string;
  /**
   * What the open picker calls the thing it is colouring — `LabelColorPicker`'s `ColourSubject`,
   * which every control inside that frame names itself from.
   *
   * **It is {@link title} plus the word "colour"**, so the group a reader lands in is named for
   * the row they opened it from, and the row is named for the switch they have already met in
   * Deck settings (`DeckSettingsForm`'s `MarkSwitch` headings are these two words exactly). One
   * thing, one name, in all three places.
   */
  subject: string;
  /** The custom property the mark's fill is read from, and — with `-fg` — what a tick or a
   *  number is printed on it in. */
  fill: string;
}

/**
 * The two marks, in `MARK_COLOR_KEYS`' own order, which is the order that array's doc says the
 * Appearance panel draws them in.
 *
 * **The property names are spelled out rather than built from the tier**, which is
 * `CardMarks.tsx`'s rule at its own site and for its reason: these names are only ever found by
 * grep, and a `--color-theory-${tier}` template makes them unfindable from the file that reads
 * them. Three sites name them now — `index.css` defaults them, `useMarkColors` writes them on
 * `:root`, `CardMarks.tsx` draws from them — and this is the fourth, because the preview below
 * has to show a colour that has not been committed and so cannot be on `:root` yet.
 */
const MARKS: readonly MarkRow[] = [
  {
    key: "theoryExact",
    tier: "exact",
    id: "theory-exact",
    title: "Matching printing",
    blurb:
      "The card in front of you is the printing the theory list names — the real thing rather " +
      "than a stand-in.",
    noun: "matching-printing mark",
    subject: "Matching printing colour",
    fill: "--color-theory-exact",
  },
  {
    key: "theoryName",
    tier: "name",
    id: "theory-name",
    title: "Different printing",
    blurb:
      "The same card, in a printing the theory list does not name — the proxy or the spare copy " +
      "standing in until the one you meant arrives.",
    noun: "different-printing mark",
    subject: "Different printing colour",
    fill: "--color-theory-name",
  },
];

/**
 * The two properties one row overrides on itself, so its preview is drawn in the colour the
 * reader is currently on rather than the one `AppShell` last published to `:root`.
 *
 * Custom properties inherit, so setting them on the row reaches every mark inside it and nothing
 * outside — which is what lets the open picker's draft be visible on the mark while the other
 * row, and every mark elsewhere in the window, stays on the committed colour.
 *
 * The foreground is recomputed rather than inherited for the same reason `useMarkColorVars`
 * recomputes it: a tick is printed *on* this fill, so a pale custom green needs the near-black
 * the label picker's own colours get. One formula, one answer.
 */
function previewVars(mark: MarkRow, color: string): Record<string, string> {
  return { [mark.fill]: color, [`${mark.fill}-fg`]: labelFgCss(color) };
}
