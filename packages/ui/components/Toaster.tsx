/**
 * The toast stack: every live toast `@/lib/notifications` holds, bottom-right, newest at the
 * bottom.
 *
 * **Mounted once per face** — in `AppShell` on the desktop, and in the light app's `PhoneFace` on
 * the phone — the store is module state and a second `Toaster` would draw every toast twice. Nothing else draws from `toasts`; anything that has something to
 * say calls `notify` and is done.
 *
 * **The stack is a `role="region"` landmark and each toast its own live region**: an error is an
 * `alert` (announced at once, interrupting), everything else a polite `status`. A toast mounts
 * with its sentence already inside it, which a polite region would normally swallow — but a
 * `status` that is *inserted* into the tree is announced by every screen reader this app targets
 * (NVDA, Narrator, TalkBack), which is the role's own contract for an inserted node; it is a live
 * region whose *text changes in place* that has to be mounted first (`UndoNotice`'s case).
 *
 * **`pointer-events-none` on the column, `auto` on each toast**, so the 20rem strip of corner the
 * stack reserves never eats a click meant for the page under the gaps.
 *
 * **Where the stack stands is the face's call** (`className`): the desktop's bottom-right corner by
 * default; the phone face lifts it over its tab bar, its receipt line and the safe-area insets and
 * spans the width (`apps/light/phone/PhoneApp.tsx`'s `PHONE_TOASTS`). The layer is not a face's to
 * change — every face keeps `LAYER.toast`. The ✕ takes a finger's size from `coarse:`, so under a
 * mouse nothing moves.
 *
 * **It also draws the busy pill** (`@/lib/work`): while reader-started work has outlasted its
 * delay, one line — a turning glyph and the work's sentence — at the foot of the stack, which is
 * exactly where the receipt toast that ends the work will land. Drawn here rather than mounted
 * beside the stack so every face that has a `Toaster` has it, placed by the same `className`.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  CircleCheck,
  CircleX,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { landed } from "@/lib/motion";
import {
  dismissToast,
  useNotifications,
  type LiveToast,
  type Notice,
  type NoticeTone,
} from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { busySentence, useBusy, type Busy } from "@/lib/work";

/** The glyph and its colour, by tone — shared with the inbox so a notice looks the same in both. */
export const TONE: Record<NoticeTone, { Icon: LucideIcon; className: string }> = {
  info: { Icon: Info, className: "text-dim" },
  success: { Icon: CircleCheck, className: "text-ok" },
  warning: { Icon: TriangleAlert, className: "text-accent" },
  error: { Icon: CircleX, className: "text-destructive" },
};

/** The ✕'s name. */
export const CLOSE_TOAST = "Close notification";

export function Toaster({
  className,
}: {
  /** Where the stack stands — position, offsets and width only, merged over the corner default. */
  className?: string;
} = {}) {
  const toasts = useNotifications((s) => s.toasts);
  const notices = useNotifications((s) => s.notices);
  const busy = useBusy();

  return (
    <section
      aria-label="Notifications"
      className={cn(
        "pointer-events-none fixed right-4 bottom-4 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2",
        className,
        LAYER.toast,
      )}
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const notice = notices.find((n) => n.id === toast.id);
          // A notice removed from the inbox takes its toast with it (`removeNotice`), so this is
          // only ever the one render between the two writes — nothing to draw for it.
          if (notice === undefined) return null;
          return <Toast key={toast.id} toast={toast} notice={notice} />;
        })}
      </AnimatePresence>
      {/* After the toasts, so it stands at the foot where the newest one lands — the receipt
          that ends the work takes its place rather than pushing in above it. Its own presence,
          so its arrival never re-keys the stack's. */}
      <AnimatePresence initial={false}>{busy && <BusyPill busy={busy} />}</AnimatePresence>
    </section>
  );
}

/**
 * The busy pill — the app saying it heard the press and is still on it.
 *
 * **Mounted only while the work is shown**, with its sentence inside: an inserted `status` is
 * announced (the stack's own arrangement above), and an always-mounted empty one would be a
 * second `status` in this region for every toast test and every reader to step over. The text
 * changing in place (a second piece of work joining) is a live region's ordinary update.
 *
 * **Not a control, and never in the way**: no tab stop, `pointer-events-none` on itself as well
 * as on the column, and no ✕ — it goes when the work does, and nothing a reader could press here
 * would end the work any sooner.
 *
 * **The glyph turns, unless the reader asked for less motion.** `MotionConfig` reduces only
 * positional animation and the spin is a CSS one, so it is turned off twice: by
 * `useReducedMotion` (read once, at mount) and by `motion-reduce:` (which follows a live change
 * of the setting). Still, the glyph and the sentence say the same thing.
 */
function BusyPill({ busy }: { busy: Busy }) {
  const still = useReducedMotion();
  return (
    <motion.div
      {...landed}
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-busy-pill=""
      className={cn(
        "pointer-events-none flex items-center gap-2 self-end rounded-full border border-border",
        "bg-surface py-1.5 pr-3.5 pl-2.5 text-xs text-dim shadow-lg shadow-black/40",
        "max-w-full",
      )}
    >
      <LoaderCircle
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-accent",
          !still && "animate-spin",
          "motion-reduce:animate-none",
        )}
      />
      <span className="min-w-0 truncate">{busySentence(busy)}</span>
    </motion.div>
  );
}

function Toast({ toast, notice }: { toast: LiveToast; notice: Notice }) {
  const tip = useTooltip();
  const { Icon, className } = TONE[notice.tone];
  const [held, setHeld] = useState(false);
  /**
   * What is left of the stay, carried across pauses. A ref rather than state because nothing
   * draws from it — it is read when the clock restarts and written when it stops.
   */
  const remaining = useRef(toast.duration);

  useEffect(() => {
    if (held || remaining.current === null) return;
    const started = Date.now();
    const timer = window.setTimeout(() => dismissToast(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      if (remaining.current !== null) {
        remaining.current = Math.max(0, remaining.current - (Date.now() - started));
      }
    };
  }, [held, toast.id]);

  return (
    <motion.div
      {...landed}
      role={notice.tone === "error" ? "alert" : "status"}
      // **Held while pointed at or focused**, so the reader reaching for the ✕ — or reading a
      // long refusal — never has it vanish under them. Focus covers the keyboard's way in.
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHeld(false);
      }}
      data-tone={notice.tone}
      className={cn(
        "pointer-events-auto flex items-start gap-2.5 rounded-md border border-border bg-surface",
        "py-2.5 pr-1.5 pl-3 text-sm text-text shadow-lg shadow-black/40",
        notice.tone === "error" && "border-destructive/50",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", className)} aria-hidden="true" />
      <div className="min-w-0 flex-1 py-px">
        <p className="break-words">{notice.title}</p>
        {notice.body !== undefined && (
          <p className="mt-0.5 break-words text-xs text-dim">{notice.body}</p>
        )}
      </div>
      <button
        type="button"
        aria-label={CLOSE_TOAST}
        {...tip(CLOSE_TOAST, { describes: false })}
        onClick={() => dismissToast(toast.id)}
        className={cn(
          "shrink-0 rounded-md p-1 text-dim",
          // A finger's floor, `Dialog`'s ✕ recipe: the glyph stays 16px, the press grows to 44.
          "coarse:-my-1.5 coarse:flex coarse:min-h-[var(--target-min)] coarse:min-w-[var(--target-min)] coarse:items-center coarse:justify-center",
          "transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </motion.div>
  );
}
