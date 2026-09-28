/**
 * How a deck keeps its tokens — `decks.token_mode`, user schema v52 (token stacks spec §4.5).
 *
 * **One control, two places, one column.** The Tokens & Emblems band draws it in its header — on
 * every deck, including one that makes no tokens, because the mode is a question about the deck
 * rather than about the tokens on the wall — and Deck settings draws it where the
 * `Show Tokens & Emblems in the deck` switch stood until v52. Both write `tokenMode` through the
 * ordinary `deck_update`, so the two cannot come to disagree.
 *
 * **Two of the column's three words are drawn, and the missing one is deliberate.** The `CHECK`
 * carries `managed`, `collection` and `hidden` from v52, so PR 3 adds a button and a behaviour and
 * no rung. Until then a `Collection` button would behave exactly as `Managed` does — a control
 * that lies about what it does, which is worse than no control. A deck a newer build put in
 * Collection mode can still reach this one through sync, and then **neither button is pressed**:
 * both are answers the deck has not given.
 */
import type { JSX } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import type { TokenMode } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/**
 * The column's three words — `DeckRow.tokenMode`'s union, **re-exported from its one home** in
 * `ipc.ts` rather than spelled a second time, so the band, the settings form and the editor can
 * name it from beside the control that draws it and still mean the mirror's type.
 *
 * `hidden` takes the token pile out of all four views; `managed` and `collection` both draw it.
 * The band under the desk is there in every mode and every stepper works in every mode — the mode
 * decides the *pile*, never whether a token can be kept.
 */
export type { TokenMode };

/**
 * The modes this build offers, **in the order an argument puts them** rather than an alphabet —
 * the one every deck starts in, then the one that takes the pile away — so it is deliberately not
 * put through `sortOptions`, for `DECK_KINDS`' own reason. PR 3 inserts `collection` between the
 * two, where the spec's three-way control has it.
 */
export const TOKEN_MODES_DRAWN: readonly TokenMode[] = ["managed", "hidden"];

/**
 * A button's word. `Hide` and never `Hidden`: the button is a verb the reader presses, and
 * "Tokens: Hide" is the sentence the group reads as, where the column's `hidden` is the state it
 * leaves behind.
 */
export const TOKEN_MODE_LABEL: Readonly<Record<TokenMode, string>> = {
  managed: "Managed",
  collection: "Collection",
  hidden: "Hide",
};

/**
 * What each mode means, in the reader's terms — a button's tooltip here, and the line under the
 * control in Deck settings, which draws the **selected** mode's sentence exactly as `DeckKindGroup`
 * draws its kind's.
 *
 * `collection`'s is the sentence a reader meets only on a deck a newer build set, and it says
 * what this build does with it rather than describing custody this build does not have.
 */
export const TOKEN_MODE_HINT: Readonly<Record<TokenMode, string>> = {
  managed:
    "Displays a Tokens & Emblems category in deck views. Tokens do not count toward the deck's card total.",
  collection:
    "Collection tokens, set by a newer version of the app. This version draws the pile as it does for Managed.",
  hidden:
    "Hides the token category from deck views. Tokens remain accessible in the Tokens & Emblems panel below.",
};

/**
 * The mode as one control with exclusive presses — `DeckKindGroup`'s shape (`DeckSettingsForm`).
 *
 * **`role="group"` with `aria-pressed` per button, never a radiogroup**, and the argument is that
 * group's verbatim, which it took from the scanner's `ControlsPanel`: these are toggles that
 * happen to be exclusive, and a radio's roving tab stop would put the reader inside a keyboard
 * mode to change one word. The joined box, the `bg-accent`/`text-accent-fg` pressed half against
 * `text-dim hover:text-text`, `h-8`, and the 150ms colour tween with its `motion-reduce` opt-out
 * are that group's classes character for character, so the two groups in Deck settings are one
 * object rather than two that rhyme.
 *
 * **Where it departs is the heading, and the band is why.** `DeckKindGroup` sets its heading on a
 * line of its own above the buttons and its caption under them; this control is also drawn in the
 * band's header, which is one row that a reader who never sleeves tokens pays for on every deck —
 * so the word sits *beside* the buttons and the caption is the host's to draw. Deck settings draws
 * {@link TOKEN_MODE_HINT} under it; the band does not, and a pointer gets each button's sentence
 * as its tooltip instead.
 *
 * **Named by the word a reader can see**, `aria-labelledby` and never an `aria-label` repeating
 * it — WCAG 2.5.3, `DeckKindGroup`'s rule. `idPrefix` is the host's stem, so the band's control
 * and the one in the settings dialog opened over it never share an `id`.
 *
 * **The pressed button stays pressable and nothing is disabled** — `aria-disabled` included. A
 * press on the mode the deck is already in calls back with that mode, which is what
 * `DeckKindGroup` does: the host's write is a patch that changes nothing.
 */
export function TokenModeControl({
  value,
  onChange,
  idPrefix,
}: {
  value: TokenMode;
  onChange: (mode: TokenMode) => void;
  idPrefix: string;
}): JSX.Element {
  const tip = useTooltip();
  const labelId = `${idPrefix}-token-mode`;
  return (
    <div className="flex items-center gap-2">
      {/* `Tokens` rather than the band's `Tokens & Emblems`, because the group reads as a sentence
          with its buttons — "Tokens: Managed", "Tokens: Hide" — which is the spec's own wording
          of the three segments (*Managed tokens / Collection tokens / Hide tokens*). */}
      <span id={labelId} className="text-sm">
        Tokens
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
        // `DeckKindGroup`'s box with `shrink-0` where that one carries `w-fit`: this root is a
        // flex row, so the group is a flex item and `shrink-0` is what keeps a squeezed header
        // from folding the two words onto each other.
        className="flex shrink-0 overflow-hidden rounded-md border border-border"
      >
        {TOKEN_MODES_DRAWN.map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={mode === value}
            onClick={() => onChange(mode)}
            // The meaning of the press, for a pointer. It *describes* rather than names: the word
            // on the button is its name, and the sentence is what pressing it would do.
            {...tip(TOKEN_MODE_HINT[mode])}
            className={cn(
              "h-8 px-2.5 text-xs",
              "transition-colors duration-150 motion-reduce:transition-none",
              mode === value ? "bg-accent font-medium text-accent-fg" : "text-dim hover:text-text",
              FOCUS,
            )}
          >
            {TOKEN_MODE_LABEL[mode]}
          </button>
        ))}
      </div>
    </div>
  );
}
