/**
 * What a sticky note *is*, computed — the page's half of the boundary.
 *
 * Rust stores strings and validates nothing about a colour, deliberately: `sticky_notes` is
 * synced, and a CHECK there would make a build that adds a sixth colour emit rows this build
 * refuses at apply. So an unknown word reads as `slate` here, which is the rule
 * `widgetSettings.ts` already keeps for a stored value no option carries.
 *
 * **Nothing in this file is React and nothing in it reaches the backend**, so the widget, the
 * dialog and the catalogue preview all answer the same four questions the same way. A title, a
 * preview and an order are decisions; the row is the fact.
 */
import { noteTitle, UNTITLED_NOTE } from "@/features/decks/deckNotes";
import { noteToPlainText } from "@/features/decks/noteMarkdown";
import type { StickyNote } from "@/lib/ipc";

export const NOTE_COLORS = ["amber", "jade", "azure", "rose", "slate"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

/**
 * What a note with neither a title nor a body is called.
 *
 * It *is* `deckNotes.ts`' {@link UNTITLED_NOTE}, aliased rather than respelled. Two constants
 * with the same three words in them is two chances to drift, and a reader who sees one name in
 * a deck's band and another on the home page has no way to tell they mean the same nothing.
 * The alias exists only so a home-page call site reads as a home-page call site.
 */
export const UNTITLED_STICKY = UNTITLED_NOTE;

/**
 * The stored colour word as something this build can draw.
 *
 * ⚠️ **Never throws and never returns the stored word unchecked.** The column carries no CHECK
 * on purpose — a newer build's sixth colour must arrive over sync and apply cleanly — so this
 * is the only place that decides a word is unknown, and the answer is always a colour.
 */
export function noteColor(stored: string): NoteColor {
  return (NOTE_COLORS as readonly string[]).includes(stored) ? (stored as NoteColor) : "slate";
}

/**
 * The title, or the body's first line, or the placeholder — computed, never stored.
 *
 * **Delegates to `deckNotes.ts`' {@link noteTitle} rather than repeating its three arms**, which
 * is what that function's `Pick<…, "title" | "body">` parameter was written for: a note shape
 * that is not a deck note is named by the same rule, including the trim that makes a title of
 * spaces fall through to the body.
 */
export function stickyTitle(note: Pick<StickyNote, "title" | "body">): string {
  return noteTitle(note);
}

/**
 * The first `lines` non-empty lines of a body, as words.
 *
 * ⚠️ **`lines` counts blocks, list items and hard breaks — not visual lines.**
 * `noteToPlainText` joins wrapped source lines with a space, so one long paragraph is a single
 * very long entry however many rows a tile draws it over, and a tile still needs its own
 * character clamp on top of this. What *does* spend a line is each item of a list (`blockText`
 * joins them with a newline) and each hard break the reader typed (it survives as a `"\n"`
 * inside a text run).
 */
export function notePreview(body: string, lines: number): string {
  return noteToPlainText(body)
    .split("\n")
    .filter((line) => line !== "")
    .slice(0, lines)
    .join("\n");
}

/**
 * Sort order, with pinned notes lifted when the widget's toggle is on.
 *
 * The id breaks a tie so two notes that were written in the same write — and so share a sort
 * order — do not swap places between renders. Returns a new array; the input is a query cache's
 * own array and is never reordered in place.
 */
export function orderedNotes(notes: StickyNote[], pinnedFirst: boolean): StickyNote[] {
  const by = [...notes].sort((l, r) => l.sortOrder - r.sortOrder || l.id - r.id);
  if (!pinnedFirst) return by;
  return [...by.filter((n) => n.pinned), ...by.filter((n) => !n.pinned)];
}
