import { useEffect, useId, useState, type JSX, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { JoinedChoices } from "@/components/FilterChips";
import { SWITCH, switchTone, TOUCH_FIELD } from "@/features/settings/controls";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { PRESS, PRESS_SOFT } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { clearSavedGame, peekSavedGame, type SavedGameSummary } from "../game/savedGame";
import {
  LIFE_FORMATS,
  resolveSeating,
  TURN_TIMERS,
  type LifeFormat,
  type LifeSetup,
  type Seating,
} from "../types";
import {
  layoutCaption,
  PREVIEW_COLORS,
  seatsFor,
  shortLife,
  type PreviewSeat,
} from "./layoutPreview";
import { MOST_LIFE, readSetup, writeSetup } from "./setupStore";
import { useWindowShape, type WindowShape } from "./useWindowShape";

/** What a press on Start game or Continue game hands the page: the board's two props. */
export interface LifeGame {
  setup: LifeSetup;
  /** Continue the saved game rather than deal a new one. */
  resume: boolean;
}

/** The turn timer's words, by its seconds (`TURN_TIMERS`). */
export function timerLabel(seconds: number): string {
  if (seconds === 0) return "Off";
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** The starting lives the setup offers as presses; anything else is the Custom field's. */
const LIFE_CHOICES = [20, 25, 30, 40] as const;

/** The phone's upright face: the tab bar's own breakpoint (`apps/light/phone/TabBar.tsx`). */
const RAIL_FROM_PX = 600;

/** The questions' captions: the design's 14/500. */
const CAPTION = "text-sm font-medium";
/** A question's second line, dim. */
const NOTE = "text-xs leading-[1.33] text-dim";
/** Every control on the setup is a finger's size at every width, as the design draws it. */
const FIELD = cn(
  "flex h-11 items-center gap-2 rounded-md border border-border bg-surface px-3 text-[15px] text-text",
  PRESS_SOFT,
  FOCUS,
);

/**
 * The Life tracker's setup: the form a game starts from, on both faces of the light app (the
 * approved setup design, *Life Tracker — Light App* canvas, 2026-11-20).
 *
 * **Only the form** — the design's header, tab bar and desktop rail are the faces' own chrome:
 * the phone face draws this inside its `Shell`, the desktop face under its `PageBar`. Top to
 * bottom: Format (a press that opens the six presets, with a line saying when the setup has left
 * its preset's defaults), Players, Starting life (four presses and a Custom field), Seating, Layout
 * (pictures of the seats in this window's shape), Turn timer, the two commander damage switches —
 * and, pinned under the scrolling form, Continue game when there is a game to continue, and the
 * gold Start game.
 *
 * **The setup is kept on this device** as it is changed (`setupStore.ts`), so the next game starts
 * where this one was set up, after a reload or a crossing from one face to the other.
 *
 * **Starting over a saved game asks first** — "Start a new game? The game in progress is lost." —
 * and only a yes clears it (`clearSavedGame`). Continue game asks nothing: it is the game the
 * reader left.
 *
 * The pickers and the question are the shared `Dialog`, so on the phone face each is a Back step
 * that a finger can drag down (`lib/dialogHost.ts`), and a centred dialog anywhere wider. **They
 * are siblings of the form, never inside it**, for `packages/ui/CLAUDE.md`'s rule about a `fixed`
 * scrim and the box it is mounted in.
 */
export function LifeSetupScreen({
  frame,
  head,
  focusStart = false,
  onPlay,
}: {
  /**
   * Whose page this is drawn in. `"phone"`: the phone face's `main` — 16px in at a phone's width,
   * the column centred beside the ≥600px rail. `"page"`: the desktop face's view, whose `main`
   * already pads 20px — the column against the left under the page title, as that face's pages are.
   */
  frame: "phone" | "page";
  /** Drawn above the form inside its scroller — the desktop face's `PageBar`. */
  head?: ReactNode;
  /** Put the caret on Start game as this mounts: the reader has just come back from a board, and
   *  the press that took them there is gone with it. */
  focusStart?: boolean;
  /** Start game or Continue game, after any question has been answered. */
  onPlay: (game: LifeGame) => void;
}): JSX.Element {
  const [setup, setSetupState] = useState<LifeSetup>(readSetup);
  const setSetup = (next: LifeSetup) => {
    setSetupState(next);
    writeSetup(next);
  };
  const [saved, setSaved] = useState<SavedGameSummary | null>(peekSavedGame);
  const [sheet, setSheet] = useState<"format" | "timer" | "newGame" | null>(null);
  const shape = useWindowShape();
  const seating = resolveSeating(setup, shape.wide);
  const preset = LIFE_FORMATS[setup.format];
  const edited =
    setup.players !== preset.players ||
    setup.life !== preset.life ||
    setup.commander !== preset.commander;

  // The presses a closing dialog hands the caret back to, **found by id when it closes rather than
  // held in refs**: the closes are wired up during render, and a ref handed to them there is one
  // the compiler's rules cannot tell is read only later (`Shell.tsx`'s own reason).
  const id = useId();
  const caretTo = (which: "format" | "timer" | "start") =>
    document.getElementById(`${id}-${which}`)?.focus({ preventScroll: true });
  useEffect(() => {
    if (focusStart) document.getElementById(`${id}-start`)?.focus({ preventScroll: true });
  }, [focusStart, id]);
  /** Close a picker or the question, handing the caret back to the press that opened it. */
  const dismiss = () => {
    setSheet(null);
    caretTo(sheet === "format" ? "format" : sheet === "timer" ? "timer" : "start");
  };

  const pickFormat = (format: LifeFormat) => {
    const next = LIFE_FORMATS[format];
    // The preset fills what it decides and the layout starts over at A; how the seats face, the
    // timer and whether commander damage comes off life are the reader's, and stay.
    setSetup({
      ...setup,
      format,
      players: next.players,
      life: next.life,
      commander: next.commander,
      layout: "A",
    });
    dismiss();
  };
  const start = () => {
    if (saved !== null) setSheet("newGame");
    else onPlay({ setup, resume: false });
  };
  const startOver = () => {
    clearSavedGame();
    setSaved(null);
    setSheet(null);
    onPlay({ setup, resume: false });
  };

  const inset =
    frame === "phone"
      ? "px-4 min-[600px]:px-[max(1.25rem,calc(50%-20rem))]"
      : // The page's own 20px is `main`'s; the column stops at 640px, against the left.
        "max-w-[40rem]";

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain",
            frame === "phone" && "pt-3 pb-1 min-[600px]:pt-4",
          )}
        >
          {head}
          <div className={cn("flex flex-col gap-3", inset, frame === "page" && "pt-3 pb-4")}>
            <section className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-format`} className={CAPTION}>
                Format
              </label>
              <button
                id={`${id}-format`}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={sheet === "format"}
                onClick={() => setSheet("format")}
                className={cn(FIELD, "w-full text-left")}
              >
                <span className="min-w-0 flex-1 truncate">{preset.label}</span>
                <ChevronDown className="size-4 shrink-0 text-dim" aria-hidden="true" />
              </button>
              <div className={cn(NOTE, "flex min-h-[18px] items-center gap-2")}>
                <span className="min-w-0 flex-1">{presetLine(setup.format, edited)}</span>
                {edited && (
                  <button
                    type="button"
                    onClick={() =>
                      setSetup({
                        ...setup,
                        players: preset.players,
                        life: preset.life,
                        commander: preset.commander,
                      })
                    }
                    className={cn("px-0.5 font-medium text-accent", FOCUS)}
                  >
                    Reset to defaults
                  </button>
                )}
              </div>
            </section>

            <section className="flex flex-col gap-1.5">
              {/* A caption for the eye only: the group names itself. */}
              <div aria-hidden="true" className={CAPTION}>
                Players
              </div>
              <JoinedChoices
                label="Players"
                className="h-11"
                choices={[1, 2, 3, 4, 5, 6].map((n) => ({
                  value: String(n),
                  label: String(n),
                  pressed: setup.players === n,
                  onClick: () => setSetup({ ...setup, players: n }),
                }))}
              />
            </section>

            <StartingLife setup={setup} onLife={(life) => setSetup({ ...setup, life })} />

            <section
              // On a phone upright the choice is one row with its caption beside it, so the setup
              // still fits the screen; with more room it is a section like the others, and says what
              // each choice is for (the design's rule). 600px is the phone face's own breakpoint,
              // where its tab bar becomes a rail — the face's shape, not this form's width.
              className="flex flex-row items-center gap-3 min-[600px]:flex-col min-[600px]:items-stretch min-[600px]:gap-1.5"
            >
              <div aria-hidden="true" className={cn(CAPTION, "min-w-0 flex-1")}>
                Seating
              </div>
              <JoinedChoices<Seating>
                label="Seating"
                // 13px and less padding in the phone's row, where two choices share 236px.
                className="h-11 shrink-0 basis-[236px] [&>button]:px-1 [&>button]:text-[13px] min-[600px]:basis-auto min-[600px]:[&>button]:text-sm"
                choices={(
                  [
                    ["table", "Around the table"],
                    ["screen", "Facing one way"],
                  ] as const
                ).map(([value, label]) => ({
                  value,
                  label,
                  pressed: seating === value,
                  onClick: () => setSetup({ ...setup, seating: value }),
                }))}
              />
              <p className={cn(NOTE, "m-0 hidden min-[600px]:block")}>
                {seating === "table"
                  ? "Each panel is turned to its player. For a device lying flat on the table."
                  : "Every panel is upright. For a screen everyone reads from the same side."}
              </p>
            </section>

            <LayoutPicker
              setup={setup}
              seating={seating}
              shape={shape}
              onLayout={(layout) => setSetup({ ...setup, layout })}
            />

            <section className="flex min-h-11 items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <label htmlFor={`${id}-timer`} className={CAPTION}>
                  Turn timer
                </label>
                <span className={NOTE}>Counts down each player’s turn</span>
              </div>
              <button
                id={`${id}-timer`}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={sheet === "timer"}
                onClick={() => setSheet("timer")}
                className={cn(FIELD, "min-w-[104px] shrink-0 text-left")}
              >
                <span className="min-w-0 flex-1 whitespace-nowrap">
                  {timerLabel(setup.timerSeconds)}
                </span>
                <ChevronDown className="size-4 shrink-0 text-dim" aria-hidden="true" />
              </button>
            </section>

            <SwitchRow
              label="Commander damage"
              note="Tracked per commander. 21 from one is lethal."
              on={setup.commander}
              onToggle={() => setSetup({ ...setup, commander: !setup.commander })}
            />
            {setup.commander && (
              <SwitchRow
                label="Commander damage lowers life"
                note={
                  setup.autoLife
                    ? "Each point also comes off the life total."
                    : "Life stays put. Players change it themselves."
                }
                on={setup.autoLife}
                onToggle={() => setSetup({ ...setup, autoLife: !setup.autoLife })}
              />
            )}
          </div>
        </div>

        {/* Pinned under the form, which scrolls when the window is short. */}
        <div
          className={cn(
            "flex shrink-0 flex-col gap-2",
            inset,
            frame === "phone" ? "pt-2 pb-3 min-[600px]:pb-4" : "pt-3",
          )}
        >
          {saved !== null && (
            <button
              type="button"
              onClick={() => onPlay({ setup: saved.setup, resume: true })}
              className={cn(
                "flex h-12 items-center justify-center gap-2 rounded-md border border-accent bg-surface",
                "text-base font-semibold text-accent",
                PRESS_SOFT,
                FOCUS,
              )}
            >
              Continue game
              <span className="text-xs font-normal text-dim">{savedLine(saved)}</span>
            </button>
          )}
          <button
            id={`${id}-start`}
            type="button"
            aria-haspopup={saved !== null ? "dialog" : undefined}
            onClick={start}
            className={cn(
              "flex h-12 items-center justify-center rounded-md bg-accent text-base font-semibold",
              "text-accent-foreground hover:bg-accent/90",
              PRESS_SOFT,
              FOCUS,
            )}
          >
            Start game
          </button>
        </div>
      </div>

      <PickerDialog
        open={sheet === "format"}
        title="Format"
        rows={(Object.keys(LIFE_FORMATS) as LifeFormat[]).map((format) => ({
          key: format,
          label: LIFE_FORMATS[format].label,
          hint: `${LIFE_FORMATS[format].life} life · ${LIFE_FORMATS[format].players} players`,
          on: format === setup.format,
          pick: () => pickFormat(format),
        }))}
        onDismiss={dismiss}
        onClose={() => setSheet(null)}
      />
      <PickerDialog
        open={sheet === "timer"}
        title="Turn timer"
        rows={TURN_TIMERS.map((seconds) => ({
          key: String(seconds),
          label: timerLabel(seconds),
          on: seconds === setup.timerSeconds,
          pick: () => {
            setSetup({ ...setup, timerSeconds: seconds });
            dismiss();
          },
        }))}
        onDismiss={dismiss}
        onClose={() => setSheet(null)}
      />
      <Dialog
        open={sheet === "newGame"}
        title="Start a new game?"
        closeLabel="Close"
        size={SHEET_SIZE}
        onDismiss={dismiss}
        onClose={() => setSheet(null)}
      >
        <div className="flex flex-col gap-4 px-5 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <p className="m-0 text-sm leading-relaxed text-dim">The game in progress is lost.</p>
          <div className="flex justify-end gap-2.5">
            <button type="button" onClick={dismiss} className={cn(DIALOG_BUTTON, "text-text")}>
              Keep it
            </button>
            <button
              type="button"
              onClick={startOver}
              className={cn(DIALOG_BUTTON, "border-destructive font-semibold text-destructive")}
            >
              Start new game
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** A sheet from the foot of the window on a phone, a centred dialog from 640px — the phone face's
 *  action sheet's own size string (`apps/light/phone/deck/sheet.tsx`), and the design's. */
const SHEET_SIZE =
  "w-full self-end rounded-t-xl border-t border-border max-h-[85dvh] sm:max-h-full sm:w-[26rem] sm:self-center";

/** The question's two presses: `EndGameDialog`'s pills, at a finger's height. */
const DIALOG_BUTTON = cn(
  "inline-flex h-11 items-center rounded-full border border-border bg-surface px-4 text-sm",
  PRESS,
  FOCUS,
);

/** The line under Format: the preset's defaults, or that the setup has left them. */
function presetLine(format: LifeFormat, edited: boolean): string {
  const p = LIFE_FORMATS[format];
  if (edited) return `Changed from ${p.label}’s defaults.`;
  return `${p.label} starts at ${p.players} players · ${p.life} life${p.commander ? " · commander damage" : ""}.`;
}

/** Continue game's second line: who is at the table and how far the game has gone. */
function savedLine(saved: SavedGameSummary): string {
  const players = saved.players === 1 ? "1 player" : `${saved.players} players`;
  return saved.turnNo > 0 ? `${players} · turn ${saved.turnNo}` : players;
}

/**
 * Starting life: four presses and a Custom field. **The field keeps what the reader typed** while
 * it has the caret — a total only changes on a number above 0, so clearing the box to type a new
 * one leaves the last total standing — and shows the total itself when it is not one of the four
 * and the reader is not typing (a kept setup's 15, say).
 */
function StartingLife({
  setup,
  onLife,
}: {
  setup: LifeSetup;
  onLife: (life: number) => void;
}): JSX.Element {
  const custom = !(LIFE_CHOICES as readonly number[]).includes(setup.life);
  const [typing, setTyping] = useState<string | null>(null);
  const shown = typing ?? (custom ? String(setup.life) : "");
  return (
    <section className="flex flex-col gap-1.5">
      <div aria-hidden="true" className={CAPTION}>
        Starting life
      </div>
      <div className="flex gap-2">
        <JoinedChoices
          label="Starting life"
          className="h-11 flex-1"
          choices={LIFE_CHOICES.map((n) => ({
            value: String(n),
            label: String(n),
            pressed: setup.life === n,
            onClick: () => {
              setTyping(null);
              onLife(n);
            },
          }))}
        />
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-label="Custom starting life"
          placeholder="Custom"
          value={shown}
          onChange={(e) => {
            // Seven digits and nothing else: `LifeSetup.life`'s bound, and a number the board's
            // three-digit display can still say (9.99m).
            const digits = e.target.value.replace(/[^0-9]/g, "").slice(0, 7);
            setTyping(digits);
            const life = Number(digits);
            if (digits.length > 0 && life > 0 && life <= MOST_LIFE) onLife(life);
          }}
          onBlur={() => setTyping(null)}
          className={cn(
            "h-11 w-[92px] shrink-0 rounded-md border bg-surface px-2.5 text-center text-[15px] text-text",
            TOUCH_FIELD,
            custom ? "border-accent" : "border-border",
            FOCUS,
          )}
        />
      </div>
    </section>
  );
}

/**
 * Layout: the A and B pictures of the seats as the board will lay them out in this window, or the
 * one fixed card where there is no choice — two players (one layout, face to face) and facing one
 * way (one grid).
 */
function LayoutPicker({
  setup,
  seating,
  shape,
  onLayout,
}: {
  setup: LifeSetup;
  seating: Seating;
  shape: WindowShape;
  onLayout: (layout: "A" | "B") => void;
}): JSX.Element {
  const choice = seating === "table" && setup.players !== 2;
  const caption = (layout: "A" | "B") =>
    layoutCaption(setup, layout, seating, shape.wide, shape.high);
  const picture = (layout: "A" | "B") => (
    <LayoutPicture
      seats={seatsFor(setup.players, layout, seating, shape.wide, shape.high)}
      label={shortLife(setup.life)}
      shape={shape}
    />
  );
  return (
    <section className="flex flex-col gap-1.5">
      <div aria-hidden="true" className={CAPTION}>
        Layout
      </div>
      {choice ? (
        <div role="group" aria-label="Layout" className="grid grid-cols-2 gap-2">
          {(["A", "B"] as const).map((layout) => {
            const on = setup.layout === layout;
            return (
              <button
                key={layout}
                type="button"
                aria-pressed={on}
                aria-label={`${layout}, ${caption(layout)}`}
                onClick={() => onLayout(layout)}
                className={cn(
                  "flex min-w-0 items-center gap-3 rounded-md border bg-surface px-3 py-2.5 text-left",
                  on ? "border-accent" : "border-border",
                  PRESS_SOFT,
                  FOCUS,
                )}
              >
                {picture(layout)}
                <span className="flex min-w-0 flex-col items-start gap-0.5">
                  <span className={cn("text-sm font-semibold", on ? "text-accent" : "text-text")}>
                    {layout}
                  </span>
                  <span className={NOTE}>{caption(layout)}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
          {picture("A")}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-semibold">{caption("A")}</span>
            <span className={NOTE}>
              {seating !== "table"
                ? setup.players === 1
                  ? "The whole window, upright."
                  : "Every panel upright, arranged to fit this window."
                : "The one layout for 2 players."}
            </span>
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * One layout's picture: the window's shape in miniature, each seat in its player's colour with
 * the starting life turned the way that player reads it. **Drawn for the eye** — the press beside
 * it names the layout — so it is hidden from a screen reader.
 *
 * The window's shape, as the design sizes it: 156px tall in an upright window (108 on a phone,
 * where the seating row above took the height), its width in proportion; 132px wide in a wide one.
 * The seats are shares of the board, so they are placed with inline percentages — a style set
 * through the DOM, which the web app's `style-src 'self'` allows.
 */
function LayoutPicture({
  seats,
  label,
  shape,
}: {
  seats: readonly PreviewSeat[];
  label: string;
  shape: WindowShape;
}): JSX.Element {
  const tall = shape.wide < RAIL_FROM_PX ? 108 : 156;
  const upright = shape.wide <= shape.high;
  const width = upright ? Math.max(48, Math.round((tall * shape.wide) / shape.high)) : 132;
  const height = upright ? tall : Math.max(60, Math.round((132 * shape.high) / shape.wide));
  return (
    <span
      aria-hidden="true"
      className="relative block shrink-0 overflow-hidden rounded-lg border border-border bg-bg"
      style={{ width, height }}
    >
      {seats.map((seat, i) => (
        <span
          key={i}
          className="absolute block p-[1.5px]"
          style={{
            left: `${seat.x * 100}%`,
            top: `${seat.y * 100}%`,
            width: `${seat.w * 100}%`,
            height: `${seat.h * 100}%`,
          }}
        >
          <span
            className="flex size-full items-center justify-center rounded-[3px]"
            style={{ backgroundColor: PREVIEW_COLORS[i % PREVIEW_COLORS.length] }}
          >
            <span
              className="block font-mono text-[11px] leading-none font-semibold text-accent-foreground"
              style={{ transform: `rotate(${seat.rot}deg)` }}
            >
              {label}
            </span>
          </span>
        </span>
      ))}
    </span>
  );
}

/** A yes-or-no question: its words and note, and the panel switch (`controls.ts`' `SWITCH`). */
function SwitchRow({
  label,
  note,
  on,
  onToggle,
}: {
  label: string;
  note: string;
  on: boolean;
  onToggle: () => void;
}): JSX.Element {
  const id = useId();
  return (
    <section className="flex min-h-11 items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span id={`${id}-label`} className={CAPTION}>
          {label}
        </span>
        <span id={`${id}-note`} className={NOTE}>
          {note}
        </span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-note`}
        onClick={onToggle}
        className={cn(SWITCH, switchTone(on), "min-w-14 justify-center")}
      >
        {on ? "On" : "Off"}
      </button>
    </section>
  );
}

/**
 * The Format and Turn timer pickers: a list of choices, the one in force checked. A choice closes
 * the picker and hands the caret back to the press that opened it.
 */
function PickerDialog({
  open,
  title,
  rows,
  onDismiss,
  onClose,
}: {
  open: boolean;
  title: string;
  rows: readonly { key: string; label: string; hint?: string; on: boolean; pick: () => void }[];
  onDismiss: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      open={open}
      title={title}
      closeLabel={`Close ${title.toLowerCase()}`}
      size={SHEET_SIZE}
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto overscroll-contain p-2">
        {rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              aria-pressed={row.on}
              onClick={row.pick}
              className={cn(
                "flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-[15px]",
                "hover:bg-bg active:bg-bg",
                row.on ? "text-accent" : "text-text",
                FOCUS_INSET,
              )}
            >
              <span className="min-w-0 flex-1">{row.label}</span>
              {row.hint !== undefined && <span className={NOTE}>{row.hint}</span>}
              <Check
                className={cn("size-[18px] shrink-0", !row.on && "invisible")}
                aria-hidden="true"
              />
            </button>
          </li>
        ))}
      </ul>
      {/* The home indicator's inset, on the panel's last line. */}
      <div aria-hidden className="h-[env(safe-area-inset-bottom)] shrink-0" />
    </Dialog>
  );
}
