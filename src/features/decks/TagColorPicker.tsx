/**
 * The control a tag's colour is chosen with, in the two densities the dialog needs.
 *
 * **One picker, two frames.** {@link TagColorPanel} is the box that drops out of the "Add tag"
 * row; {@link TagColorRow} is the strip that opens inside a tag's own row, ruled off from it and
 * ending in a Done. What is inside them is the same three controls in the same order, and that is
 * the point: a reader who has learned to pick a colour once has learned it for both.
 *
 * ## The three, and why each one is there
 *
 * **The wheel** is the platform's `input[type=color]`, which is what makes an arbitrary colour
 * reachable at all — see `tagColors.ts` for what changed in storage to allow it. It is the
 * platform's dialog rather than a hand-rolled one on purpose: colour pickers are a solved control
 * with an eyedropper, a recent-colours row and OS-level accessibility that no in-app square
 * matches.
 *
 * **The hex field** is the one a reader arrives at with a colour already in mind — from a
 * proxy-printing sheet, a playgroup's convention, a brand. It takes six digits or three, with or
 * without a `#`, and holds what is typed until it makes a colour: a field that snapped back on
 * every keystroke would be untypeable, so {@link normalizeTagColor} answering `null` mid-word is
 * a state this component sits in rather than an error it reports.
 *
 * **The six swatches** are the app's own identity deeps, one press each. They are the fast path
 * and the common answer, which is why they sit in both frames — the redesign drew them only in
 * the create box, and a reader recolouring an existing tag would then have had to reach the
 * sanctioned six through a wheel. The row is wide enough for them; there was no other reason to
 * leave them out.
 *
 * ## What this file does not decide
 *
 * **When a colour is written.** Both frames are controlled, and the caller holds the value —
 * because the wheel fires continuously while the OS dialog is being dragged, and a row that wrote
 * on every one of those would be a `deck_tag_update` per pixel of travel. The create form's value
 * is state that has not been written yet, and the row's is a draft its Done commits. Neither
 * decision belongs here.
 */
import { useState, type JSX } from "react";
import { Palette } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { normalizeTagColor, TAG_COLORS, tagColorCss, tagColorHex } from "./tagColors";

/** A tag's colour as a square of it. `aria-hidden`: the colour is never the only carrier of
 *  anything, and the tag's name is always beside it. */
export function TagSwatch({ color, className }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: tagColorCss(color) }}
      className={cn("size-2.5 shrink-0 rounded-[2px]", className)}
    />
  );
}

/**
 * The "Add tag" row's colour control: an icon, the colour it is currently on, and nothing else.
 *
 * A **trigger** rather than the picker itself, because the row it sits in is a name, a colour and
 * a submit on one line and a wheel with a hex field is not a thing that fits on it. `aria-expanded`
 * is what says the press opens something, and the swatch is what says what it is set to now — a
 * button that only said "Choose tag colour" would make the current colour unreadable until the
 * panel was open.
 */
export function TagColorButton({
  color,
  open,
  onToggle,
}: {
  color: string;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label="Choose tag colour"
      title="Choose tag colour"
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-[0.4375rem] rounded-md border border-border",
        "bg-surface px-2.5 text-dim transition-colors duration-150",
        "hover:border-accent hover:text-text motion-reduce:transition-none",
        FOCUS,
      )}
    >
      <Palette className="size-[0.9375rem]" aria-hidden="true" />
      <TagSwatch color={color} className="size-3 rounded-[3px]" />
    </button>
  );
}

/** The panel {@link TagColorButton} opens: the picker in a box of its own. It carries no margin
 *  of its own — where it sits is the layout's question, and its two callers answer it
 *  differently. */
export function TagColorPanel({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Tag colour"
      className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5"
    >
      <PickerControls value={value} onChange={onChange} wheel="size-[2.125rem]" />
    </div>
  );
}

/**
 * The picker inside a tag's row: ruled off from the row above it, and ending in a Done.
 *
 * **Done is the write**, which is why this frame has a button and the create box does not. There
 * is nothing to press in the create form because "Add tag" is already the press that commits;
 * here the reader is editing a row that exists, so something has to say when the editing stopped.
 * It is the same control that opened the panel — the row's swatch — said a second time where the
 * reader's hands are.
 */
export function TagColorRow({
  value,
  onChange,
  onDone,
}: {
  value: string;
  onChange: (color: string) => void;
  onDone: () => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Tag colour"
      className="mt-2 flex items-center gap-2.5 border-t border-border pt-2"
    >
      <PickerControls value={value} onChange={onChange} wheel="size-[1.875rem]" />
      <button
        type="button"
        onClick={onDone}
        className={cn(
          "h-7 shrink-0 rounded-md border border-border px-2.5 text-[0.6875rem] text-dim",
          "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
          FOCUS,
        )}
      >
        Done
      </button>
    </div>
  );
}

/**
 * The three controls both frames hold, in the order both hold them.
 *
 * **The hex field's text lives here rather than in the field**, and that is what keeps this
 * component free of an effect. The field cannot read its own text back off `value`: three
 * characters into `d9b95c` there is nothing to normalise to, so a field that re-derived would
 * erase every keystroke that is not yet a colour and the reader could never type a seventh. But
 * the text still has to **follow** the wheel and the swatches, and once the state is up here
 * every one of those writers is a handler in this file — `set` — instead of an external change a
 * `useEffect` would have to watch for. The picker is mounted only while it is open, so it starts
 * on whatever colour it was opened at with nothing to synchronise.
 */
function PickerControls({
  value,
  onChange,
  wheel,
}: {
  value: string;
  onChange: (color: string) => void;
  wheel: string;
}) {
  const [text, setText] = useState(() => tagColorHex(value));

  /** A colour chosen by anything that is not the hex field: the field follows it. */
  const set = (color: string) => {
    setText(tagColorHex(color));
    onChange(color);
  };

  return (
    <>
      {/* The platform's own dialog. `appearance-none` plus the two `::-webkit-color-swatch`
          rules are what stop Chromium drawing its default bevelled chip, which is the one
          control on this screen that would otherwise arrive with a light-mode border. */}
      <input
        type="color"
        value={value}
        onChange={(e) => set(e.target.value)}
        aria-label="Tag colour picker"
        className={cn(
          "shrink-0 cursor-pointer appearance-none border-0 bg-transparent p-0",
          "[&::-webkit-color-swatch-wrapper]:p-0",
          "[&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border",
          "[&::-webkit-color-swatch]:border-border",
          wheel,
          FOCUS,
        )}
      />
      <HexField text={text} onText={setText} onColor={onChange} />
      <div className="ml-auto flex shrink-0 gap-[0.3125rem]">
        {TAG_COLORS.map((c) => (
          <button
            key={c.hex}
            type="button"
            aria-pressed={tagColorCss(value) === c.hex}
            aria-label={c.label}
            title={c.label}
            onClick={() => set(c.hex)}
            style={{ backgroundColor: c.hex }}
            className={cn(
              "size-[1.125rem] rounded-[3px] border",
              "transition-colors duration-150 motion-reduce:transition-none",
              tagColorCss(value) === c.hex ? "border-text" : "border-transparent hover:border-text",
              FOCUS,
            )}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Six digits, with the `#` drawn beside the box rather than typed into it.
 *
 * **What is on screen is the text, and only a completed colour reaches the caller** — the
 * half-typed states in between are a place this field sits rather than an error it reports. The
 * text itself is {@link PickerControls}', for the reason given there.
 */
function HexField({
  text,
  onText,
  onColor,
}: {
  text: string;
  onText: (text: string) => void;
  onColor: (color: string) => void;
}) {
  return (
    <label className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg px-2.5">
      <span aria-hidden="true" className="font-mono text-xs text-dim">
        #
      </span>
      <input
        value={text}
        onChange={(e) => {
          // Anything that is not a hex digit is not a keystroke this field has a use for —
          // pasting `#D9B95C` out of a design tool is the commonest way one arrives, and the `#`
          // is already drawn to the left of the box.
          const next = e.target.value
            .replace(/[^0-9a-f]/gi, "")
            .slice(0, 6)
            .toUpperCase();
          onText(next);
          const color = normalizeTagColor(next);
          if (color) onColor(color);
        }}
        aria-label="Tag colour hex"
        maxLength={6}
        spellCheck={false}
        className={cn(
          "w-[3.875rem] border-0 bg-transparent p-0 font-mono text-xs uppercase tracking-[0.04em]",
          "text-text outline-none",
        )}
      />
    </label>
  );
}
