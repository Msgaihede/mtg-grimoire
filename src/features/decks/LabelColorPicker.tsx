/**
 * The control a label's colour is chosen with, in the two densities the dialog needs.
 *
 * **One picker, two frames.** {@link LabelColorPanel} is the box that drops out of the "Add label"
 * row; {@link LabelColorRow} is the strip that opens inside a label's own row, ruled off from it
 * and ending in a Done. What is inside them is the same three controls in the same order, and that
 * is the point: a reader who has learned to pick a colour once has learned it for both.
 *
 * ## The three, and why each one is there
 *
 * **The wheel** is the platform's `input[type=color]`, which is what makes an arbitrary colour
 * reachable at all — see `labelColors.ts` for what changed in storage to allow it. It is the
 * platform's dialog rather than a hand-rolled one on purpose: colour pickers are a solved control
 * with an eyedropper, a recent-colours row and OS-level accessibility that no in-app square
 * matches.
 *
 * **The hex field** is the one a reader arrives at with a colour already in mind — from a
 * proxy-printing sheet, a playgroup's convention, a brand. It takes six digits or three, with or
 * without a `#`, and holds what is typed until it makes a colour: a field that snapped back on
 * every keystroke would be untypeable, so {@link normalizeLabelColor} answering `null` mid-word is
 * a state this component sits in rather than an error it reports.
 *
 * **The six swatches** are the app's own identity deeps, one press each. They are the fast path
 * and the common answer, which is why they sit in both frames — the redesign drew them only in
 * the create box, and a reader recolouring an existing label would then have had to reach the
 * sanctioned six through a wheel. The row is wide enough for them; there was no other reason to
 * leave them out.
 *
 * ## What this file does not decide
 *
 * **What it is a colour _of_.** Every control in here used to name itself "Label colour", which
 * was true while a label was the only thing in the app a reader could recolour and became a
 * vocabulary error the day it was not: Settings → Appearance recolours a **mark**, and a *label*,
 * a *mark* and a *tag* are three different things this repo is explicit about never letting trade
 * places. So the words are the caller's — {@link ColourSubject} — and every name below is built
 * from that one string rather than written out, which is what stops a frame naming the group one
 * thing and the hex field inside it another. It **defaults to `"Label colour"`**, so the deck
 * dialog and the card modal are byte-identical and their suites did not move.
 *
 * **When a colour is written.** Both frames are controlled, and the caller holds the value —
 * because the wheel fires continuously while the OS dialog is being dragged, and a row that wrote
 * on every one of those would be a `deck_label_update` per pixel of travel. The create form's
 * value is state that has not been written yet, and the row's is a draft its Done commits. Neither
 * decision belongs here.
 */
import { useState, type JSX } from "react";
import { Palette } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { normalizeLabelColor, LABEL_COLORS, labelColorCss, labelColorHex } from "./labelColors";

/**
 * What is being coloured, in the words a reader would hear — and the stem every control in the
 * picker names itself from.
 *
 * **A noun phrase that already carries the word "colour"**, because it is the group's own
 * accessible name and "Matching printing" alone would announce a group of colour controls as
 * though it were the mark itself. The three derived names are {@link subjectNames}'.
 *
 * Sentence case, and the first word capitalised: "Label colour", "Matching printing colour".
 */
export type ColourSubject = string;

/** What every caller got before there was anything but a label to colour, and what they still get
 *  for passing nothing. */
const DEFAULT_SUBJECT: ColourSubject = "Label colour";

/**
 * The three names one subject becomes.
 *
 * **Built rather than written out**, which is the whole of what the prop buys: a caller that had
 * to pass four strings could pass three that agree and one that does not, and a picker whose hex
 * field belongs to a different thing than the group around it is worse than one that says "label"
 * everywhere.
 *
 * `choose` lowers the first character rather than the string, so `Choose label colour` survives
 * character for character and a subject with a capital inside it — a set name, a format — keeps
 * it. Every subject here is a common noun phrase, which is what makes that safe; a proper noun
 * would need its own answer.
 */
function subjectNames(subject: ColourSubject) {
  return {
    group: subject,
    wheel: `${subject} picker`,
    hex: `${subject} hex`,
    choose: `Choose ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`,
  };
}

/** A label's colour as a square of it. `aria-hidden`: the colour is never the only carrier of
 *  anything, and the label's name is always beside it. */
export function LabelSwatch({ color, className }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: labelColorCss(color) }}
      className={cn("size-2.5 shrink-0 rounded-[2px]", className)}
    />
  );
}

/**
 * The "Add label" row's colour control: an icon, the colour it is currently on, and nothing else.
 *
 * A **trigger** rather than the picker itself, because the row it sits in is a name, a colour and
 * a submit on one line and a wheel with a hex field is not a thing that fits on it. `aria-expanded`
 * is what says the press opens something, and the swatch is what says what it is set to now — a
 * button that only said "Choose label colour" would make the current colour unreadable until the
 * panel was open.
 */
export function LabelColorButton({
  color,
  open,
  onToggle,
  subject = DEFAULT_SUBJECT,
}: {
  color: string;
  open: boolean;
  onToggle: () => void;
  /**
   * What this button opens a colour for — {@link ColourSubject}.
   *
   * **Two of these on one screen with the default between them is two buttons a screen reader
   * cannot tell apart**, which is what a name written into the component rather than passed to it
   * costs the second caller. There is one caller today and it names a label, so the default is
   * what it always said.
   */
  subject?: ColourSubject;
}): JSX.Element {
  const tip = useTooltip();
  const name = subjectNames(subject).choose;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={name}
      {...tip(name, { describes: false })}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-[0.4375rem] rounded-md border border-border",
        "bg-surface px-2.5 text-dim transition-colors duration-150",
        "hover:border-accent hover:text-text motion-reduce:transition-none",
        FOCUS,
      )}
    >
      <Palette className="size-[0.9375rem]" aria-hidden="true" />
      <LabelSwatch color={color} className="size-3 rounded-[3px]" />
    </button>
  );
}

/** The panel {@link LabelColorButton} opens: the picker in a box of its own. It carries no margin
 *  of its own — where it sits is the layout's question, and its two callers answer it
 *  differently. */
export function LabelColorPanel({
  value,
  onChange,
  subject = DEFAULT_SUBJECT,
}: {
  value: string;
  onChange: (color: string) => void;
  /** What this panel colours — {@link ColourSubject}. */
  subject?: ColourSubject;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={subjectNames(subject).group}
      className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5"
    >
      <PickerControls
        value={value}
        onChange={onChange}
        subject={subject}
        wheel="size-[2.125rem]"
      />
    </div>
  );
}

/**
 * The picker inside a label's row: ruled off from the row above it, and ending in a Done.
 *
 * **Done is the write**, which is why this frame has a button and the create box does not. There
 * is nothing to press in the create form because "Add label" is already the press that commits;
 * here the reader is editing a row that exists, so something has to say when the editing stopped.
 * It is the same control that opened the panel — the row's swatch — said a second time where the
 * reader's hands are.
 */
export function LabelColorRow({
  value,
  onChange,
  onDone,
  subject = DEFAULT_SUBJECT,
}: {
  value: string;
  onChange: (color: string) => void;
  onDone: () => void;
  /** What this row colours — {@link ColourSubject}. Settings → Appearance opens one of these per
   *  mark, so the default would name both of them "Label colour" and neither of them honestly. */
  subject?: ColourSubject;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={subjectNames(subject).group}
      className="mt-2 flex items-center gap-2.5 border-t border-border pt-2"
    >
      <PickerControls
        value={value}
        onChange={onChange}
        subject={subject}
        wheel="size-[1.875rem]"
      />
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
  subject,
  wheel,
}: {
  value: string;
  onChange: (color: string) => void;
  /** **Required here and defaulted only at the two frames**, which is what stops a third frame
   *  being written that forgets to thread it and silently names its controls after a label. */
  subject: ColourSubject;
  wheel: string;
}) {
  const [text, setText] = useState(() => labelColorHex(value));
  const tip = useTooltip();
  const names = subjectNames(subject);

  /** A colour chosen by anything that is not the hex field: the field follows it. */
  const set = (color: string) => {
    setText(labelColorHex(color));
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
        aria-label={names.wheel}
        className={cn(
          "shrink-0 cursor-pointer appearance-none border-0 bg-transparent p-0",
          "[&::-webkit-color-swatch-wrapper]:p-0",
          "[&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border",
          "[&::-webkit-color-swatch]:border-border",
          wheel,
          FOCUS,
        )}
      />
      <HexField text={text} onText={setText} onColor={onChange} name={names.hex} />
      <div className="ml-auto flex shrink-0 gap-[0.3125rem]">
        {LABEL_COLORS.map((c) => (
          <button
            key={c.hex}
            type="button"
            aria-pressed={labelColorCss(value) === c.hex}
            aria-label={c.label}
            {...tip(c.label, { describes: false })}
            onClick={() => set(c.hex)}
            style={{ backgroundColor: c.hex }}
            className={cn(
              "size-[1.125rem] rounded-[3px] border",
              "transition-colors duration-150 motion-reduce:transition-none",
              labelColorCss(value) === c.hex
                ? "border-text"
                : "border-transparent hover:border-text",
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
  name,
}: {
  text: string;
  onText: (text: string) => void;
  onColor: (color: string) => void;
  /** The field's accessible name, composed from the picker's subject by `subjectNames` — never
   *  written here, so the field and the group around it cannot come to belong to two things. */
  name: string;
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
          const color = normalizeLabelColor(next);
          if (color) onColor(color);
        }}
        aria-label={name}
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
