/**
 * The inbox: every notice this device has kept, newest first — opened from the rail's
 * Notifications entry on the desktop, and from the bell in the light app's phone header.
 *
 * **Opening it reads everything in it**, and so does a notice that arrives while it is open: the
 * rail's count is "arrived since you last looked", and a reader looking at the list has looked.
 *
 * It draws from `@/lib/notifications` and nothing else, so a notice raised anywhere in the app
 * lands here whether or not its toast was ever seen.
 */
import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { TONE } from "@/components/Toaster";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { PANEL_BUTTON } from "@/features/settings/controls";
import { FOCUS } from "@/lib/focus";
import { clearNotices, markAllRead, removeNotice, useNotifications } from "@/lib/notifications";
import { cn } from "@/lib/utils";

/**
 * When a notice arrived, as the inbox says it: relative for the last hour, the clock time for the
 * rest of today, and the date before that.
 *
 * Pure and exported so the arithmetic is pinned without a clock in the suite.
 */
export function noticeTime(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const then = new Date(at);
  const clock = then.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (then.toDateString() === new Date(now).toDateString()) return clock;
  return `${then.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clock}`;
}

export function NotificationsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const notices = useNotifications((s) => s.notices);
  const unread = notices.some((n) => !n.read);

  useEffect(() => {
    if (open && unread) markAllRead();
  }, [open, unread]);

  return (
    <Dialog
      open={open}
      title="Notifications"
      subtitle={notices.length === 0 ? undefined : "Newest first, kept on this device."}
      closeLabel="Close notifications"
      size="w-[32rem] max-h-[40rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      <Body />
    </Dialog>
  );
}

/**
 * The list and its one action. **Its own component so the clock is read once per open**: `Dialog`
 * mounts its body only while open, so the `useState` initialiser below runs on each opening and
 * never again — the list is not a clock, and a "2 min ago" that ticked while the reader watched
 * would be a list that moves under them. A notice arriving while open is newer than `now`, which
 * `noticeTime` answers as "Just now".
 */
function Body() {
  const notices = useNotifications((s) => s.notices);
  const tip = useTooltip();
  const [now] = useState(() => Date.now());

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      {notices.length === 0 ? (
        <p className="py-6 text-center text-sm text-dim">
          Nothing yet. What the app tells you is kept here, on this device.
        </p>
      ) : (
        <>
          <ul
            aria-label="Notifications"
            className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto"
          >
            {notices.map((notice) => {
              const { Icon, className } = TONE[notice.tone];
              return (
                <li
                  key={notice.id}
                  data-tone={notice.tone}
                  className="flex items-start gap-2.5 rounded-md border border-border bg-bg/40 py-2 pr-1.5 pl-3 text-sm"
                >
                  <Icon className={cn("mt-0.5 size-4 shrink-0", className)} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="break-words">{notice.title}</p>
                    {notice.body !== undefined && (
                      <p className="mt-0.5 break-words text-xs text-dim">{notice.body}</p>
                    )}
                    <p className="mt-0.5 text-xs text-dim">
                      <time dateTime={new Date(notice.at).toISOString()}>
                        {noticeTime(notice.at, now)}
                      </time>
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove “${notice.title}”`}
                    {...tip("Remove", { describes: false })}
                    onClick={() => removeNotice(notice.id)}
                    className={cn(
                      "shrink-0 rounded-md p-1 text-dim",
                      // The phone face draws this list too: a finger's floor, `Toaster`'s ✕.
                      "coarse:-my-1 coarse:flex coarse:min-h-[var(--target-min)] coarse:min-w-[var(--target-min)] coarse:items-center coarse:justify-center",
                      "transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text",
                      "motion-reduce:transition-none",
                      FOCUS,
                    )}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={clearNotices}
              className={cn(PANEL_BUTTON, "border-border text-dim hover:text-text")}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Clear all
            </button>
          </div>
        </>
      )}
    </div>
  );
}
