import { useId, type ComponentProps, type JSX, type ReactNode } from "react";
import { Check } from "lucide-react";
import { PageBar } from "@/components/PageBar";
import { FOCUS } from "@/lib/focus";
import { PRESS, PRESS_STILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The pieces every Draft & Packs flow is drawn from — the Choose, Draft and Build screens, the
 * lobby — so the setup, the pick screen and the pod's room read as one page.
 */

/** A small caps label over a group of controls: the Playtesting setup's `LABEL`. */
export const LABEL = "m-0 text-[0.6875rem] font-normal tracking-[0.08em] text-dim uppercase";

/** A plain bordered button. `aria-disabled` greys it without taking it out of the tab order. */
export const QUIET_BUTTON = cn(
  "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-border",
  "bg-surface px-3 text-sm text-text hover:border-accent/55",
  "aria-disabled:cursor-default aria-disabled:text-dim aria-disabled:hover:border-border",
  "aria-disabled:active:scale-100",
  PRESS,
  FOCUS,
);

/** A one-line text box. No press scaling: a field never dips (`packages/ui/CLAUDE.md` §5). */
export const FIELD = cn(
  "h-9 rounded-md border border-border bg-bg px-3 text-sm text-text placeholder:text-dim",
  "focus-visible:border-accent/70",
  PRESS_STILL,
  FOCUS,
);

/** The flow's big gold button — Start draft, Build deck, Create lobby. */
export function PrimaryButton({
  ready,
  busy = false,
  onPress,
  children,
  className,
  ...rest
}: {
  /** Pressable now. A button that is not is `aria-disabled` and its press does nothing. */
  ready: boolean;
  busy?: boolean;
  onPress: () => void;
  children: ReactNode;
  className?: string;
} & Omit<ComponentProps<"button">, "onClick" | "className" | "children">): JSX.Element {
  const live = ready && !busy;
  return (
    <button
      type="button"
      {...rest}
      // `aria-disabled`, never the attribute: a `disabled` button leaves the tab order, and this
      // one ungreys as the reader makes their picks — the Playtesting setup's Start game.
      aria-disabled={!live}
      aria-busy={busy || undefined}
      onClick={() => {
        if (live) onPress();
      }}
      className={cn(
        "inline-flex h-11 items-center justify-center gap-2.5 rounded-full border px-6",
        "text-[15px] font-semibold transition-colors motion-reduce:transition-none",
        PRESS,
        FOCUS,
        live
          ? "border-accent bg-accent text-accent-fg hover:bg-accent/90"
          : "cursor-default border-border bg-surface text-dim active:scale-100",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The three steps of a draft, as the flow's bar draws them. */
export type DraftStep = "choose" | "draft" | "build";

const STEPS: readonly { id: DraftStep; label: string }[] = [
  { id: "choose", label: "Choose" },
  { id: "draft", label: "Draft" },
  { id: "build", label: "Build" },
];

/** Choose · Draft · Build, the step on screen in accent and the ones behind it ticked. */
export function Stepper({ step }: { step: DraftStep }): JSX.Element {
  const at = STEPS.findIndex((s) => s.id === step);
  return (
    <ol aria-label="Steps" className="m-0 flex list-none items-center gap-2 p-0">
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden="true" className="h-px w-6 bg-border" />}
          <span
            aria-current={i === at ? "step" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 text-[0.6875rem] tracking-[0.08em] uppercase",
              i === at ? "font-medium text-accent" : i < at ? "text-text" : "text-dim",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "grid size-5 place-items-center rounded-full border font-mono text-[0.625rem]",
                i === at
                  ? "border-accent bg-accent text-accent-fg"
                  : i < at
                    ? "border-accent/60 text-accent"
                    : "border-border",
              )}
            >
              {i < at ? <Check className="size-3" /> : i + 1}
            </span>
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A flow's page bar: the way back to the hub as the trail, the flow's name as the title, and the
 * stepper (or whatever the screen puts there) against the right edge.
 */
export function FlowBar({
  title,
  onBack,
  step,
  meta,
  actions,
}: {
  title: ReactNode;
  onBack: () => void;
  step?: DraftStep;
  meta?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <PageBar
      trail={[{ label: "Draft & Packs", onOpen: onBack, name: "Back to Draft & Packs" }]}
      title={title}
      meta={meta}
      actions={
        step === undefined && actions === undefined ? undefined : (
          <>
            {actions}
            {step !== undefined && <Stepper step={step} />}
          </>
        )
      }
    />
  );
}

/** A labelled row of segments where exactly one is pressed — the bots' skill. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onPick: (id: T) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="flex flex-col gap-2.5">
      <h3 id={id} className={LABEL}>
        {label}
      </h3>
      <div
        role="group"
        aria-labelledby={id}
        className="flex overflow-hidden rounded-md border border-border"
      >
        {options.map((option) => {
          const pressed = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={pressed}
              onClick={() => onPick(option.id)}
              className={cn(
                "h-9 min-w-0 flex-1 px-2 text-xs",
                "transition-colors duration-150 motion-reduce:transition-none",
                pressed ? "bg-accent font-medium text-accent-fg" : "text-dim hover:text-text",
                FOCUS,
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A refusal said where the reader is looking — the backend's sentence, or the page's own. */
export function InlineError({ message }: { message: string | null }): JSX.Element | null {
  if (message === null) return null;
  return (
    <p role="alert" className="m-0 text-sm text-destructive">
      {message}
    </p>
  );
}

/** A bordered panel on the page's ground. */
export const PANEL = "rounded-xl border border-border bg-surface/45";
