import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc, type DeckAuditEntry } from "@/lib/ipc";
import { auditDays } from "./auditText";
import { opened } from "./useDeck";

/** Stable identity for "nothing read yet", so {@link auditDays} is not re-run over a new empty
 *  array on every render of a dialog that is still waiting. */
const NONE: readonly DeckAuditEntry[] = [];

/**
 * How much history the dialog asks for: the backend's own ceiling, `deck_audit::MAX_LIMIT`.
 *
 * **A cap, not a page.** This table grows by one row per edit, so a deck a person has actually
 * built is hundreds of rows rather than millions, and the dialog shows the most recent day or
 * two. Asking for the maximum is what turns "show me the history" into one read instead of a
 * cursor nobody would scroll. The backend clamps into `1..=500` regardless — which is also
 * what stops a `0` from meaning *no limit at all*, since that is how SQLite reads a negative
 * `LIMIT`.
 */
const LIMIT = 500;

/**
 * One deck's history, grouped into the day sections `DeckHistoryDialog` draws.
 *
 * **Read-only, and there is no write here at all** — a history row is written by the change it
 * describes, inside that change's own transaction, so an audit row that committed while its
 * change rolled back is a state the backend makes impossible. This hook only asks.
 *
 * `["decks", "audit", deckId]`, under the `["decks"]` root: **every** deck write records a row,
 * so the invalidation that already follows a rename, an add or a label change is exactly what
 * refreshes the dialog open over the deck. That is why no mutation anywhere needs to know this
 * key exists.
 *
 * **No variant.** The history covers both lists — a Theory edit is history too — and each entry
 * carries its own {@link DeckAuditEntry.variant}. A dialog that filtered would be hiding half
 * of "all changes" from a reader who came to see them.
 *
 * The grouping is `auditDays` from `auditText.ts` and is deliberately not re-derived here:
 * days are **local** calendar days, which is a thing that has already been got wrong once (a
 * change made at 23:30 files itself under tomorrow if the day is sliced off an ISO string).
 * One implementation, memoised on the answer.
 */
export function useDeckAudit(deckId: number | null) {
  const query = useQuery({
    queryKey: ["decks", "audit", deckId],
    queryFn: () => ipc.deckAuditList(opened(deckId), LIMIT),
    enabled: deckId !== null,
  });

  const entries = query.data ?? NONE;
  const days = useMemo(() => auditDays(entries), [entries]);

  return {
    query,
    /** Day sections, newest first, each with the roll-up its sticky header prints. Empty both
     *  while the read is in flight and for a deck with no history — `query.isPending` is what
     *  tells those apart. */
    days,
  };
}

/** The whole of what `DeckHistoryDialog` consumes, named so the view and the hook agree. */
export type DeckAudit = ReturnType<typeof useDeckAudit>;
