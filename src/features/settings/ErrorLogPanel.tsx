import { CircleCheck, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ErrorEntry, ErrorKind, ErrorSource } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import type { ErrorLog } from "@/lib/useErrorLog";
import { cn } from "@/lib/utils";

/** The panel's one button — the app's existing bordered control, as `UpdatePanel` draws it,
 *  down to the character. The property list is spelled out because a colour utility and a
 *  transform one compile to the same CSS longhand and tailwind-merge would keep only one of
 *  them; a `disabled` button is held at full size, since a control that depresses and then
 *  refuses is a control that lies. */
const BUTTON =
  "inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-sm " +
  "transition-[color,background-color,border-color,opacity,transform,scale] " +
  "duration-[var(--duration-fast)] ease-standard active:scale-[0.97] " +
  "motion-reduce:transition-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100";

/**
 * What each `source` is called on screen.
 *
 * Named for what the reader controls and recognises, never for how it is built: a person has
 * card images and app updates, not a `scryfall_image` and a `github_update`. Total over the
 * union, so a new arm in Rust is a type error here rather than a blank badge.
 */
const SOURCE_LABEL: Record<ErrorSource, string> = {
  scryfall_api: "Card data",
  scryfall_image: "Card images",
  github_update: "App updates",
  database: "Database",
  image_store: "Image cache",
};

/**
 * What each `kind` is called.
 *
 * "Rate limited" is the one worth reading twice — it is the only kind that is this app's own
 * behaviour to fix rather than someone else's server having a bad day.
 */
const KIND_LABEL: Record<ErrorKind, string> = {
  rate_limited: "Rate limited",
  timeout: "Timed out",
  http: "Refused",
  io: "Disk",
  parse: "Unreadable",
  other: "Failed",
};

/**
 * When this last happened, in words.
 *
 * Relative rather than absolute because the question a reader has here is "is this still
 * going on?", and "4 minutes ago" answers it where a timestamp makes them do arithmetic.
 * Exported for its test — the boundaries are where a rounding rule goes wrong.
 */
export function formatWhen(unixSeconds: number, now: number = Date.now()): string {
  const seconds = Math.round(now / 1000 - unixSeconds);
  if (seconds < 0) return "just now"; // A clock that moved. Never "in -3 minutes".
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** One fault. The count is the number of times it happened, not the number of rows. */
function Row({ entry }: { entry: ErrorEntry }) {
  return (
    <li className="space-y-1 border-t border-border py-3 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 text-sm text-text">{entry.message}</p>
        {entry.count > 1 && (
          // The whole reason the log folds. A number is data, so it is mono and tabular like
          // every other number in this window.
          <span
            className="shrink-0 font-mono text-xs tabular-nums text-accent"
            title={`Happened ${entry.count} times`}
          >
            ×{entry.count}
          </span>
        )}
      </div>
      <p className="text-xs text-dim">
        {SOURCE_LABEL[entry.source]} · {KIND_LABEL[entry.kind]} ·{" "}
        <span className="font-mono">{entry.operation}</span> · {formatWhen(entry.lastAt)}
      </p>
      {entry.detail && (
        // The URL or path, which is the thing someone debugging actually needs and the thing
        // nobody reading casually wants shouted. `break-all` because a Scryfall image URL has
        // no spaces to wrap at and must not push the panel sideways.
        <p className="break-all font-mono text-xs text-dim/80">{entry.detail}</p>
      )}
    </li>
  );
}

/**
 * Everything the app could not do, in the one place a reader goes looking for it.
 *
 * Quiet like `UpdatePanel`, and for the same reason: the direction spends its boldness on the
 * mana line. The only colour here is the fold count, in the gold that already means "the
 * number worth looking at" everywhere else in this window — deliberately *not* red. A failed
 * image fetch is not an alarm, and a panel that shouted would be one nobody opens twice.
 */
export function ErrorLogPanel({ log }: { log: ErrorLog }) {
  const { entries, loading, error, clear, clearing } = log;

  return (
    <section aria-labelledby="errors-heading" className="space-y-4">
      <h2 id="errors-heading" className="font-heading text-lg leading-none">
        Errors
      </h2>

      <div className="space-y-4 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-dim">
            Anything the app could not do — a card update, an image, a check for a new version.
            Repeats are counted, not repeated.
          </p>
          <button
            type="button"
            onClick={clear}
            disabled={clearing || entries.length === 0}
            aria-busy={clearing || undefined}
            className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Clear
          </button>
        </div>

        {/* Grown into place rather than shoving the log down by its height. Its own animated
            element, since it carries no padding and no border — `overflow-hidden` is still
            owed, because the sentence is laid out at full size whatever the box is doing. The
            panel is a `space-y-4` stack, so the 16px between it and the list still arrives at
            once; the sentence itself is what grows. */}
        <AnimatePresence initial={false}>
          {error && (
            <motion.p {...statusLine} role="alert" className="overflow-hidden text-sm text-text">
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        {loading ? (
          <p className="text-sm text-dim">Reading the log…</p>
        ) : entries.length === 0 ? (
          // An empty screen states the good news and what would fill it. Not "No errors
          // found", which reads as a search that came back empty.
          <p className="flex items-center gap-2 text-sm text-dim">
            <CircleCheck className="size-4 text-accent" aria-hidden="true" />
            Nothing has failed.
          </p>
        ) : (
          // Capped and scrolled: fifty faults is more than a panel can hold, and a settings
          // page that grows to the length of a bad week is one nobody can reach the bottom of.
          <ul className="max-h-96 overflow-y-auto">
            {entries.map((entry) => (
              <Row key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
