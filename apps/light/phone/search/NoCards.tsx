import type { Activity } from "@grimoire/ui/lib/activity";
import { DimNote } from "../pages/parts";

/**
 * What a card search draws where the wall would be when it answered nothing — and **"No cards
 * match." only when there are cards for a search to have missed.**
 *
 * Found on a real phone on 2026-10-04: a first run's Search said *No cards match.* over an empty
 * database for the whole download, which is a claim about the reader's search when the truth was
 * that there was nothing yet to search. So `empty` turns the sentence, and the caller answers it
 * two ways: `sync_status`' count is a real `0`, or the search asked nothing of the database at all
 * (`CardSearch.unfiltered` — the desktop `summaryOf`'s test, which needs no status read). A count
 * not read yet is neither, and is not read as empty: that would tell a reader with 116 k cards
 * that they have none.
 *
 * - **A sync running over an empty database** says what the desktop's first-run screen says, in a
 *   paragraph rather than over the whole window — the frame's mana line above is the bar, and the
 *   phase and its count sit here in the ribbon's words (`syncActivity`).
 * - **An empty database with nothing running** — a reader who said *Not now* on a metered link, a
 *   first download that failed — says so, with the failure when there is one. It names no host's
 *   reason, because which one applies is not this page's to know.
 */
export function NoCards({
  empty,
  sync,
  error,
}: {
  /** The database has no cards — not merely none this search found. */
  empty: boolean;
  /** The card sync, while one runs (`CardData.sync`). */
  sync: Activity | null;
  /** Why the last card sync failed (`CardData.error`). */
  error: string | null;
}) {
  if (!empty) return <DimNote>No cards match.</DimNote>;

  if (sync) {
    return (
      <div className="flex flex-col gap-2 p-4 text-sm">
        <p className="font-medium text-text">Setting up your card database</p>
        <p className="text-dim">
          Downloading every Magic card from Scryfall. This happens once — after that, search works
          offline.
        </p>
        <div className="flex items-start justify-between gap-3 text-xs">
          {/* The desktop's arrangement: the phase is announced, the count is not — it changes
              many times a second during the ingest. */}
          <p role="status" className="min-w-0 text-dim">
            {sync.label}
          </p>
          {sync.detail && (
            <span aria-hidden="true" className="shrink-0 font-mono text-dim tabular-nums">
              {sync.detail}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4 text-sm">
      <p className="text-dim">
        No card data yet — search has nothing to look through until it downloads.
      </p>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
