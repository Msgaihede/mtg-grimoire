import { CircleCheck, Trash2 } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import type { ErrorEntry, ErrorKind, ErrorSource } from "@/lib/ipc";
import { ago } from "@/lib/relativeTime";
import type { ErrorLog } from "@/lib/useErrorLog";
import { cn } from "@/lib/utils";
import { BUTTON } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";

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
  // Named for what the reader controls, never for how it is built: they set a relay URL in
  // the Sync panel, and a push that did not land is that panel's failure rather than a
  // Cloudflare one.
  relay: "Sync",
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
 *
 * The arithmetic is `lib/relativeTime`'s since 2026-08-16, shared with the two other
 * relative times on this page. It kept its own default `now` for `useMarketplace`'s reason:
 * a render-time clock read is what makes this line correct on the render it is drawn in.
 */
export function formatWhen(unixSeconds: number, now: number = Date.now()): string {
  return ago(unixSeconds, now);
}

/** One fault. The count is the number of times it happened, not the number of rows. */
function Row({ entry }: { entry: ErrorEntry }) {
  const tip = useTooltip();
  return (
    <li className="space-y-1 border-t border-border py-3 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 text-sm text-text">{entry.message}</p>
        {entry.count > 1 && (
          // The whole reason the log folds. A number is data, so it is mono and tabular like
          // every other number in this window. The tooltip says what the glyph means — "×5"
          // read aloud is not obviously "happened five times" — as a plain description: nothing
          // here is clipped, and a fold count is not a sentence a reader needs to select or
          // copy, unlike `entry.detail` below, so the default (non-interactive) binding is
          // right. `describes` stays at its default `true`.
          <span
            className="shrink-0 font-mono text-xs tabular-nums text-accent"
            {...tip(`Happened ${entry.count} times`)}
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
    <SettingsSection id="errors" title="Errors">
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

      {/* `plain` and not the red its two neighbours use: this panel's whole argument is that a
          fault is news rather than an alarm, and it would be a strange page that listed six
          hundred of them in grey and then shouted about failing to read them. */}
      <PanelAlert tone="plain">{error}</PanelAlert>

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
    </SettingsSection>
  );
}
