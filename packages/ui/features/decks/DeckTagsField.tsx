import { useEffect, useId, useRef, useState, type JSX } from "react";
import { AnimatePresence } from "motion/react";
import { X } from "lucide-react";
import { PopupPanel } from "@/components/PopupListbox";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import {
  MAX_TAG_LENGTH,
  movedTag,
  suggestTags,
  withTag,
  withoutTag,
  type TagInUse,
} from "./deckTags";
import { CAPTION } from "./formFields";
import { useDeckTagReorder } from "./tagDrag";

export interface DeckTagsFieldProps {
  /** The deck's tags, in the reader's order — what the chips draw. */
  tags: readonly string[];
  /**
   * Every tag some deck wears — `deckTags.ts`' `tagsInUse` over the whole gallery, this deck
   * included. The field takes out the ones already on this deck and narrows the rest by what is
   * typed, so a host hands over the same list for every deck and decides nothing.
   */
  inUse: readonly TagInUse[];
  /**
   * The whole new list, on each act that settles one: Enter, a pick, a chip's ✕, Backspace in
   * an empty box, looking away with a tag half typed, or a chip moved. **Never a no-op** — a blank or a repeat
   * calls nothing — so a host may write on every call.
   */
  onChange: (tags: string[]) => void;
  id: string;
}

/**
 * A deck's tags: a row of chips, a box to type the next one into, and under it the tags other
 * decks already wear (issue #834).
 *
 * **The suggestions are the feature rather than a convenience.** A tag is free text and there is
 * no list of them anywhere, so the only thing that makes `Budget` on one deck and `Budget` on the
 * next the *same* tag is the reader spelling it the same way twice — and the list is what makes
 * that a press instead of a memory test. It opens as soon as the box takes the caret, before a
 * key is pressed, because the commonest thing done here is tagging a second deck with a word
 * already used on a first.
 *
 * ## The keyboard
 *
 * | Key | What it does |
 * | --- | --- |
 * | Enter | adds the highlighted suggestion, or — with none highlighted — what was typed |
 * | ↓ / ↑ | walk the suggestions; the caret never leaves the box (`aria-activedescendant`) |
 * | Backspace, in an empty box | takes the last chip off — one per press, never on a held key |
 * | Escape | closes the list; pressed again, clears what was typed; only then is it the dialog's |
 * | ← / →, on a chip's word | moves that chip one place (issue #913) |
 *
 * **Nothing is highlighted until an arrow is pressed**, so Enter always means "the word I typed"
 * to a reader who never looked at the list. A suggestion pre-selected under the caret is how a
 * typed `Meme` becomes `Meme deck` on a fast Enter.
 *
 * ## Looking away adds what was typed
 *
 * `DeckSettingsDialog`'s rule for its other text fields, for its reason: every other control on
 * that screen has already written by the time it is closed, so a half-typed tag thrown away by a
 * click on the scrim would be the one destructive thing on it. **Measured against this field's
 * own box rather than the input**, so a press on a chip's ✕ is not "away" — otherwise one press
 * would be two writes built from the same list, and the second would undo the first.
 *
 * ## The order is the reader's
 *
 * A chip is dragged by its word and let go on another chip to take its place (`tagDrag.ts`), or
 * moved a place at a time with the arrow keys on the word — the same write either way, the whole
 * list in its new order (issue #913). `DeckTile` draws the tags in that order, so the first few are
 * the ones a narrow tile still shows. With one tag there is nothing to move, and the word is plain
 * text rather than a tab stop.
 *
 * ## Anchored, not portalled, and not measured
 *
 * The list is `absolute` under the box in the box's own wrapper — `DeckTile`'s `DeleteConfirm`
 * arrangement rather than `Dropdown`'s measured frame. The box grows a line when the chips wrap,
 * and a panel placed from numbers taken when it opened would then sit over the line being typed
 * on; one that hangs off the box's own bottom edge cannot.
 */
export function DeckTagsField({ tags, inUse, onChange, id }: DeckTagsFieldProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  /** The highlighted row, or `-1` for none. Read through `active` below, never directly: the
   *  list under it changes with every key, and a stored index can point past its end. */
  const [cursor, setCursor] = useState(-1);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-suggestions`;
  const optionId = (index: number) => `${uid}-suggestion-${index}`;

  /** The chip an arrow key just moved, whose word gets the caret back once the list it asked for
   *  is drawn. React moves a keyed chip by taking it out and putting it back, which drops focus. */
  const owedFocus = useRef<string | null>(null);
  useEffect(() => {
    const tag = owedFocus.current;
    if (tag === null) return;
    owedFocus.current = null;
    const handles = rootRef.current?.querySelectorAll<HTMLElement>("[data-tag-handle]") ?? [];
    for (const handle of handles) {
      if (handle.dataset.tagHandle === tag) handle.focus();
    }
  }, [tags]);

  /** One chip to a new place — a drop or an arrow key. Nothing is reported when nothing moves. */
  const move = (tag: string, to: number) => {
    const next = movedTag(tags, tag, to);
    if (next !== null) onChange(next);
    return next !== null;
  };
  const reorder =
    tags.length < 2
      ? undefined
      : (dragged: string, target: string) => move(dragged, tags.indexOf(target));

  const matches = suggestTags(inUse, tags, draft);
  const shown = open && matches.length > 0;
  const active = shown && cursor >= 0 && cursor < matches.length ? cursor : -1;

  /** One tag onto the end. The box empties whether or not anything was added: a repeat is
   *  already on the deck, so what the reader typed has been answered either way. */
  const add = (raw: string) => {
    const next = withTag(tags, raw);
    if (next !== null) onChange(next);
    setDraft("");
    setCursor(-1);
  };

  // Escape, innermost first: the list, then the draft, and only then whatever this field is
  // drawn in. Registered here rather than read off the input's own `keydown`, because a dialog
  // listens in the window's capture phase and would have closed before a React handler ran —
  // and a closing dialog blurs the box, which would *add* the tag the reader was cancelling.
  useDismissOnEscape({
    layer: "inner",
    enabled: shown || draft !== "",
    onDismiss: () => {
      if (shown) setOpen(false);
      else setDraft("");
    },
  });

  return (
    <div
      ref={rootRef}
      // "Away" is this whole field — see the component's doc for why the chips' own controls
      // must not count.
      onBlur={(e) => {
        if (rootRef.current?.contains(e.relatedTarget)) return;
        setOpen(false);
        if (draft.trim() !== "") add(draft);
      }}
    >
      <label htmlFor={`${id}-tags`} className={cn(CAPTION, "mb-1.5")}>
        Tags
      </label>
      <div className="relative">
        <div
          // The bordered box is the chips and the input together, so it reads as one field and a
          // press on its padding lands in the input like a press on any text box's would.
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className={cn(
            "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-border bg-bg",
            "px-1.5 py-1 text-sm text-text focus-within:border-accent",
          )}
        >
          {tags.length > 0 && (
            <ul aria-label="Tags on this deck" className="contents">
              {tags.map((tag, index) => (
                <TagChip
                  key={tag}
                  tag={tag}
                  index={index}
                  total={tags.length}
                  onMove={reorder}
                  onStep={(delta) => {
                    if (move(tag, index + delta)) owedFocus.current = tag;
                  }}
                  onRemove={() => {
                    onChange(withoutTag(tags, tag));
                    // The chip is about to unmount with the caret on its button; the box is
                    // the one control here that survives every removal.
                    inputRef.current?.focus();
                  }}
                />
              ))}
            </ul>
          )}
          <input
            ref={inputRef}
            id={`${id}-tags`}
            type="text"
            role="combobox"
            aria-expanded={shown}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            autoComplete="off"
            maxLength={MAX_TAG_LENGTH}
            value={draft}
            placeholder={tags.length === 0 ? "Add a tag…" : undefined}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setDraft(e.target.value);
              setOpen(true);
              // A new word is a new list, and nothing in it has been chosen yet.
              setCursor(-1);
            }}
            onKeyDown={(e) => {
              // A key pressed while an input method is composing belongs to the composition:
              // the Enter that confirms a candidate is not the Enter that adds a tag, and
              // taking it here would add half a word and leave the rest to arrive in an empty
              // box. `keyCode` 229 is the same statement from engines that report it instead.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                if (matches.length === 0) return;
                e.preventDefault();
                if (!shown) {
                  setOpen(true);
                  setCursor(e.key === "ArrowDown" ? 0 : matches.length - 1);
                  return;
                }
                const step = e.key === "ArrowDown" ? 1 : -1;
                // From "none", ↓ lands on the first row and ↑ on the last; past either end the
                // walk wraps, so a short list never needs the other key.
                const from = active === -1 && step === -1 ? matches.length : active;
                setCursor((from + step + matches.length) % matches.length);
                return;
              }
              if (e.key === "Enter") {
                // Stops here whatever it adds: this box is drawn inside forms whose own Enter
                // means "create the deck", and a tag is never that.
                e.preventDefault();
                add(active >= 0 ? matches[active].tag : draft);
                return;
              }
              // **A press, never a held key.** Holding Backspace to rub out a typed word goes on
              // firing after the box is empty, and each repeat would otherwise take a chip — a
              // write, a history line and an undo step apiece, at the keyboard's repeat rate.
              if (e.key === "Backspace" && !e.repeat && draft === "" && tags.length > 0) {
                e.preventDefault();
                onChange(tags.slice(0, -1));
              }
            }}
            // No box of its own: the wrapper above draws the border, and this is the part of it
            // that takes the caret. `min-w-24` is what sends it to a new line once the chips
            // have used the row up, rather than leaving a sliver too narrow to read a word in.
            className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm placeholder:text-dim focus:outline-none"
          />
        </div>

        <AnimatePresence>
          {shown && (
            <PopupPanel
              key="suggestions"
              className={cn(
                "absolute inset-x-0 top-full mt-1 origin-top-left rounded-md border border-border",
                "bg-surface p-2 shadow-lg",
                LAYER.popup,
              )}
            >
              <ul
                id={listId}
                role="listbox"
                aria-label="Tags on other decks"
                className="max-h-48 overflow-auto"
              >
                {matches.map((row, index) => (
                  <li
                    key={row.tag}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === active}
                    // Keeps the caret in the box while a row is pressed, so the press is a pick
                    // and not a blur that adds the half-typed word first.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => add(row.tag)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text",
                      "transition-colors duration-150 hover:bg-bg motion-reduce:transition-none",
                      index === active && "bg-bg",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{row.tag}</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-dim">
                      {row.count} {row.count === 1 ? "deck" : "decks"}
                    </span>
                  </li>
                ))}
              </ul>
            </PopupPanel>
          )}
        </AnimatePresence>
      </div>
      <p className="mt-1 text-[0.6875rem] text-dim">
        {tags.length < 2
          ? "Shown on the deck tile. Press Enter to add one."
          : "Shown on the deck tile in this order. Drag a tag to move it."}
      </p>
    </div>
  );
}

/**
 * One chip: the word, which is the grip when there is more than one tag, and the ✕.
 *
 * A component of its own because the drag is a hook per chip (`useDeckTagReorder`).
 */
function TagChip({
  tag,
  index,
  total,
  onMove,
  onStep,
  onRemove,
}: {
  tag: string;
  index: number;
  total: number;
  /** A chip let go on this one — `undefined` with fewer than two tags, which registers nothing. */
  onMove: ((dragged: string, target: string) => void) | undefined;
  /** An arrow key on the word: one place back (`-1`) or forward (`1`). */
  onStep: (delta: -1 | 1) => void;
  onRemove: () => void;
}): JSX.Element {
  const tip = useTooltip();
  const { attachChip, attachHandle, over } = useDeckTagReorder(tag, onMove);

  return (
    <li
      ref={attachChip}
      className={cn(
        "flex min-w-0 max-w-full items-center gap-0.5 rounded-sm border bg-surface pl-1.5",
        "text-xs leading-5 transition-colors duration-150 motion-reduce:transition-none",
        over ? "border-accent" : "border-border",
      )}
    >
      {onMove === undefined ? (
        <span className="min-w-0 truncate">{tag}</span>
      ) : (
        <button
          ref={attachHandle}
          type="button"
          data-tag-handle={tag}
          // The whole of the keyboard reorder, `CategoriesDialog`'s grip turned on its side: the
          // chips run along a line, so the keys are the ones that point along it. The position is
          // in the name because the only other way to know where a chip landed is to look.
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              onStep(e.key === "ArrowLeft" ? -1 : 1);
            }
          }}
          aria-label={`Move ${tag}, ${index + 1} of ${total}`}
          {...tip("Drag to reorder, or press the left and right arrow keys")}
          className={cn("min-w-0 cursor-grab truncate rounded-sm text-left", FOCUS)}
        >
          {tag}
        </button>
      )}
      <button
        type="button"
        aria-label={`Remove the ${tag} tag`}
        onClick={onRemove}
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-sm text-dim",
          "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </li>
  );
}
