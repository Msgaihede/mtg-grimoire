import { AnimatePresence, motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ReleaseNote } from "@/lib/ipc";
import { PRESS_SOFT, statusLine } from "@/lib/motion";
import type { ReleaseHistory } from "@/lib/useReleaseHistory";
import { cn } from "@/lib/utils";
import { ReleaseNotes } from "./ReleaseNotes";

/**
 * What every version before this one changed.
 *
 * **Every row starts closed.** A changelog is consulted rather than read: a reader opens
 * Settings to check their version, and thirty release bodies unrolled underneath that would
 * bury the panel that answers the question they came with. So the list is versions and dates
 * — one line each, the whole history legible at a glance — and a body appears only where one
 * is asked for.
 *
 * The release the app is *offering* is not drawn here twice: `UpdatePanel` renders its notes
 * open, above, because that one is news. This is the past.
 */
export function VersionHistory({
  history,
  currentVersion,
}: {
  history: ReleaseHistory;
  /** The running build, so its row can say so. `undefined` before the first status lands. */
  currentVersion: string | undefined;
}) {
  const { releases, loading, error } = history;

  return (
    <div className="space-y-2 border-t border-border pt-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-dim">Version history</h3>

      {error ? (
        <p className="text-xs text-dim">{error}</p>
      ) : loading ? (
        <p className="text-xs text-dim">Reading the version history…</p>
      ) : releases.length === 0 ? (
        // Not an error, and not an app with no past: an install that has never reached GitHub
        // has nothing cached to list, and the way out is the button at the top of the panel.
        <p className="text-xs text-dim">
          No releases have been read yet. Check for updates to fetch them.
        </p>
      ) : (
        // **It grows; it does not scroll.** A capped `overflow-y-auto` here was drawn in the
        // shipped window on 2026-08-17 and put its scrollbar directly beside the settings
        // page's own — two tracks a few pixels apart — and squeezed an expanded release's
        // notes into 320px while the page below it had room to spare. The deck editor
        // answered the same question the same way in August: its page section is the only
        // scroller, and its three wall views were given a height of their own and grow. One
        // page of releases is the whole of what can arrive here, so the height is bounded by
        // the data rather than by a class.
        <ul className="divide-y divide-border/60">
          {releases.map((release) => (
            <HistoryRow
              key={release.tag}
              release={release}
              installed={release.version === currentVersion}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryRow({ release, installed }: { release: ReleaseNote; installed: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyId = `release-${release.tag}-notes`;

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className={cn(
          "flex w-full items-center gap-2 rounded-sm py-1.5 text-left text-sm",
          PRESS_SOFT,
          "hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-dim transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        {/* A version is data, and data is Geist Mono — the panel's own rule, one line up. */}
        <span className="font-mono tabular-nums">{release.version}</span>
        {release.publishedAt && (
          <span className="text-xs text-dim">{release.publishedAt.slice(0, 10)}</span>
        )}
        {installed && (
          <span className="ml-auto shrink-0 text-xs text-dim">installed</span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          // `statusLine` — a height opening from nothing rather than a body appearing at full
          // size and shoving every row below it down at once. `overflow-hidden` is the
          // consumer's to add, because the content is laid out at full height whatever the
          // box is doing.
          <motion.div {...statusLine} id={bodyId} className="overflow-hidden">
            <ReleaseNotes notes={release.notes} className="px-5 pb-3 pt-1" />
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}
