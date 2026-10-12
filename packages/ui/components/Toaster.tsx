/**
 * The toast stack: every live toast `@/lib/notifications` holds, bottom-right, newest at the
 * bottom.
 *
 * **Mounted once per face**, in `AppShell` — the store is module state and a second `Toaster`
 * would draw every toast twice. Nothing else draws from `toasts`; anything that has something to
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
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CircleCheck, CircleX, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";
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

/** The glyph and its colour, by tone — shared with the inbox so a notice looks the same in both. */
export const TONE: Record<NoticeTone, { Icon: LucideIcon; className: string }> = {
  info: { Icon: Info, className: "text-dim" },
  success: { Icon: CircleCheck, className: "text-ok" },
  warning: { Icon: TriangleAlert, className: "text-accent" },
  error: { Icon: CircleX, className: "text-destructive" },
};

/** The ✕'s name. */
export const CLOSE_TOAST = "Close notification";

export function Toaster() {
  const toasts = useNotifications((s) => s.toasts);
  const notices = useNotifications((s) => s.notices);

  return (
    <section
      aria-label="Notifications"
      className={cn(
        "pointer-events-none fixed right-4 bottom-4 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2",
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
    </section>
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
