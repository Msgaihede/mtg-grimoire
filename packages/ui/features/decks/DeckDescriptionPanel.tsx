/**
 * The deck's description, as a band beside the notes and the to-do lists (issue #912).
 *
 * ⚠️ **Not a note and not a tag.** It is `decks.description` — the one free sentence (or primer)
 * the reader writes about the whole deck in Deck settings — drawn read-only. It has no row in
 * `deck_notes`, no cards and no editor of its own; Deck settings is still where it is written.
 *
 * **Why here, and not on the gallery's hover bubble any more.** Issue #840 put it on the cover's
 * tooltip, where it was a hover away and clamped to eight lines. Issue #912 moved it to where the
 * reader's other words about the deck already are, so what a deck is *for* sits beside what they
 * wrote about it and what is left to do — at full length and selectable.
 *
 * ## Three rules, all the host's but the last
 *
 * - **Drawn only when there is a description** — a blank or whitespace one is none. The host
 *   mounts nothing at all then, so the row it shares with the notes and to-do bands holds two
 *   tracks rather than an empty third (`DeckEditor.tsx`).
 * - **First in that row**, ahead of the notes: what the deck is for, then what was written about
 *   it, then what is left to do.
 * - **Open on arrival, and the disclosure is editor state.** A band that is drawn only because
 *   there is something in it should show that thing; a shut default would ask the reader to open
 *   a band whose whole content is three words. So there is no `decks.*_open` column behind it, as
 *   there is for the notes and to-do bands — the editor is keyed on the deck, so each deck opens
 *   with its description showing, and a reader who shuts it has it shut for the visit.
 *
 * **A `<section>` and `shrink-0`** on the root, for the notes band's two reasons: a second
 * complementary landmark broke `App.test.tsx`'s pane assertions, and `shrink-0` on the bands below
 * the desk is the whole of why this editor scrolls. The header is `TodosBand`'s, so the three bands
 * in the row read as one set.
 */
import { memo, useId, useState, type JSX } from "react";
import { ChevronRight } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** The band's name — the region's `aria-label` and the disclosure's visible text. */
export const DESCRIPTION_HEADING = "Description";

/**
 * The description a band would draw, or `null` for none: trimmed, so a description of
 * whitespace is no description. The host mounts the band only on a non-null answer.
 */
export function shownDescription(description: string | null | undefined): string | null {
  const trimmed = description?.trim();
  return trimmed ? trimmed : null;
}

export interface DeckDescriptionPanelProps {
  /** The deck's description, already through {@link shownDescription} — never blank. */
  description: string;
}

/**
 * The band. **Memoised (issue #557)**, the notes and to-do bands' arrangement: one string prop,
 * so it is drawn again when the description changes and not for every render of the editor.
 */
export const DeckDescriptionPanel = memo(function DeckDescriptionPanel({
  description,
}: DeckDescriptionPanelProps): JSX.Element {
  const [open, setOpen] = useState(true);
  const bodyId = useId();

  return (
    <section aria-label={DESCRIPTION_HEADING} className="shrink-0 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((was) => !was)}
          className={cn("flex items-center gap-1.5 rounded-md text-sm text-text", PRESS, FOCUS)}
        >
          {/* One glyph rotated, never two swapped — every band on this page turns its chevron. */}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 transition-transform duration-[var(--duration-fast)] ease-standard",
              "motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          {DESCRIPTION_HEADING}
        </button>
      </div>

      {/* `select-text` because a description is written to be read — the editor's root refuses
          text selection (issue #473). `whitespace-pre-line` keeps the reader's own line breaks. */}
      <div id={bodyId} className="select-text">
        {open && (
          <p className="mt-3 whitespace-pre-line break-words text-sm text-text">{description}</p>
        )}
      </div>
    </section>
  );
});
