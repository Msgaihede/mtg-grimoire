import { useEffect, useState } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { ipc, type ComboPhase, type ComboProgress, type ComboStatus } from "@/lib/ipc";
import { COMBOS_KEY, COMBOS_STATUS_KEY } from "@/lib/query";

/**
 * The deck gallery's read of the same fact, as a prefix — `deckBracketsKey`'s first two segments
 * with the ids left off, which is what `invalidateQueries` matches on.
 *
 * **Spelled here rather than imported, and the test is what keeps that honest.** The alternative
 * is `deckBracketsKey` itself, which cannot be called without a list of deck ids and would then
 * match only the wall that happens to be asking for exactly those; and a bare `["decks"]` root
 * exists but reaches every deck read in the app, which is a great deal of refetching for one
 * column of one caption. So this is a literal, and `useComboProgress.test.ts` asserts it is a
 * prefix of a key `deckBracketsKey` actually builds — the drift `lib/query.ts`'s `COMBOS_KEY`
 * paragraph warns about, caught by a build rather than by a reader.
 */
const DECK_BRACKETS_ROOT: QueryKey = ["decks", "brackets"];

/**
 * What each phase is called on screen — the ribbon's status line and its mana line, and
 * **total over the union** exactly as `ORACLE_TAG_PHASE_LABEL` is over `OracleTagPhase`.
 *
 * `ComboPhase` is a hand-mirrored copy of `combos::PHASES`, and a phase Rust emits that is
 * missing here renders `undefined` while the refresh runs perfectly — nothing fails except what
 * the reader is told. `useComboProgress.test.ts` pins this list against the Rust one, which
 * `the_progress_phases_are_the_ones_the_frontend_mirrors` pins from its side.
 *
 * **The sentences name combos and never Commander Spellbook.** The marketplace feed names its
 * marketplace because two of them exist and the reader picked one; there is a single combo
 * source, so putting its name on a 48px row beside a moving bar would spend the width on a
 * proper noun that answers a question nobody asked. The words also say *combos* rather than
 * *brackets*: Rust stores an interaction and knows nothing about the bracket a deck lands in,
 * and a sentence promising the reader their bracket was updated would be describing a
 * conclusion `features/decks` draws somewhere else entirely.
 */
export const COMBO_PHASE_LABEL: Record<ComboPhase, string> = {
  checking: "Checking for combo updates",
  downloading: "Downloading combos",
  // No count, and that is a fact about `combos.rs` rather than a choice made here: `refresh`
  // hands `ingest_gz` a `&mut |_, _| {}` and emits `("ingesting", 0, 0)` exactly once, so there
  // is no number to print and the bar is indeterminate for the whole 639 MB parse.
  ingesting: "Importing combos",
  done: "Combos are up to date",
  error: "Combo refresh failed",
};

/** The combo table's state, and whether it is being replaced right now. */
export interface ComboRefresh {
  /** The backend's row, or `null` while the status read has not answered (or could not).
   *  **Never a rejection to guard against**: a database that has never ingested answers two
   *  zeros and three nulls with `stale: true`. */
  status: ComboStatus | null;
  /** A refresh is in flight — this window's or the one the backend starts at launch. */
  refreshing: boolean;
  /** The latest `combos:progress` event, for the one surface that counts bytes. `null` until
   *  one arrives, which is most of the time. */
  progress: ComboProgress | null;
}

/** The phases that mean a refresh is still running. `done` and `error` are terminal and their
 *  event outlives the run, so neither may be read as "in flight". */
const RUNNING: ComboPhase[] = ["checking", "downloading", "ingesting"];

/**
 * Subscribe to `combos:progress` and say whether the combo table is being replaced.
 *
 * **Call this once.** `AppShell` is that one caller — `useOracleTagProgress`'s rule, for its
 * reason: every extra call is another `listen` registration on the same event for the life of
 * the app. A second consumer reads the result as a prop, or reads {@link COMBOS_STATUS_KEY} out
 * of the cache; it does not start a second subscription.
 *
 * **The event is the flag here, where one dataset over it is emphatically not, and the
 * difference is a fact about the wire rather than a change of mind.** `ComboStatus` carries no
 * `refreshing` field where `TagStatus` and `MarketplaceFeedStatus` both do — `combos.rs` holds
 * the claim in a module-level `AtomicBool` whose reader `is_refreshing` is `#[cfg(test)]`, and
 * its own doc says why: nothing in production has a place to put the answer. So this hook reads
 * the status for the state the event cannot carry (how many combos, over how many cards, from
 * which build of the file, how old) and derives "in flight" from the phase of the last event
 * heard.
 *
 * **That is honest here for one reason, and it is worth stating because it is exactly what was
 * false for the tag hook.** A flag derived from the event can only be *raised* by an event this
 * window heard — and the listener that heard the run start is still registered when it ends,
 * because `AppShell` mounts this for the life of the window and nothing unsubscribes mid-run.
 * Every path through `combos::refresh` that emits `checking` ends in `done` or `error`: a 304,
 * a download failure, a good ingest and a failed one all reach one of the two. So the line
 * cannot latch. `useOracleTagProgress` polls its status precisely because *its* flag goes up
 * from a source the terminal event has to reach back to, which made the run most likely to need
 * the flag the run whose terminal event was most likely to have been missed — a circle that
 * left the ribbon reading *"Updating card tags"* for the life of the window (measured
 * 2026-08-14, `tauri dev`). Both edges come off one channel here, so there is nothing to poll
 * and an idle window reads nothing on a timer.
 *
 * **What it costs is the opposite failure, and it is the smaller one**: `combos::refresh_if_due`
 * is spawned at launch, so a run can begin before this window has a listener, and Tauri drops
 * what it emitted first. Attaching mid-`downloading` still catches it — that phase reports
 * throughout the 27.5 MB — but attaching during the ingest catches nothing until `done`, since
 * `ingesting` is emitted exactly once. The ribbon is then silent for a job that is running,
 * which is a missing sentence rather than a wrong one. **Guessing from the status instead would
 * be worse and was rejected**: `stale` says a refresh is *due*, not that one is running, and a
 * failed fetch never moves `checkedAt` — so a machine that cannot reach Spellbook would carry
 * that line in the ribbon forever.
 *
 * A terminal event invalidates {@link COMBOS_KEY}, the root over both the status and every
 * deck's `combosForCards` answer, so an ingest that lands under an open deck refills the bracket
 * advisory rather than leaving it reading three signals for the client's whole `staleTime`.
 *
 * **Two roots and not one, because two surfaces answer the bracket question through two reads.**
 * The editor's advisory comes off `["combos", …]`; the deck *gallery* does not read that root at
 * all — `features/decks/useDeckBrackets.ts` takes its combos off `deck_bracket_reads`, where they
 * arrive alongside the cards they are estimated against, under {@link DECK_BRACKETS_ROOT}. So an
 * invalidation of the combo root alone reaches no tile, and a download landing while the wall is
 * on screen would refill whichever deck the reader had open and leave every tile estimating from
 * three signals until some unrelated deck write fired `["decks"]`. That is the failure this whole
 * feed's automatic download exists to remove, reproduced one surface over: correct data in the
 * database, an old answer on the screen, and nothing the reader can see to explain the
 * difference. A tile in that state is not *wrong* — `estimateBracket` answers a floor, so three
 * signals read low rather than false — but a reader watching a caption not change has no way to
 * know the fourth signal ever arrived.
 */
export function useComboProgress(): ComboRefresh {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<ComboProgress | null>(null);

  /**
   * No `refetchInterval`, which is the one line where this parts company with
   * `useOracleTagProgress` — see the paragraph above: a flag that goes up and comes down on the
   * same channel has nothing for a poll to heal. A rejection is not guarded against because the
   * command does not have one: `combos_status` answers a database with no `combo_meta` row
   * rather than refusing, so `data` being `undefined` here means the read has not landed, never
   * that it failed.
   */
  const status = useQuery({ queryKey: COMBOS_STATUS_KEY, queryFn: () => ipc.combosStatus() }).data;

  // The unmount race and the registration that fails outside a Tauri window (a plain
  // `vite dev`, a story) belong to `lib/core/tauri.ts`. Losing the fast path costs the ribbon
  // its sentence and costs the app nothing else: the bracket estimate reads the three signals
  // it can see and says so.
  useEffect(
    () =>
      ipc.onCombosProgress((event) => {
        setProgress(event);
        // **Both terminal phases, and the reason is not `useOracleTagProgress`'s.** There is no
        // `refreshing` flag on this status for a refetch to take down. What there is instead is
        // a table that may have moved: a `done` after a 304 moved `checkedAt` alone, a `done`
        // after an ingest moved everything, and an `error` moved nothing at all — and telling
        // the three apart from here would put a copy of `combos::store`'s transaction
        // discipline in the frontend, right up until that discipline moved. One local read of
        // one small table is the cheaper half of that trade.
        if (event.phase === "done" || event.phase === "error") {
          void queryClient.invalidateQueries({ queryKey: COMBOS_KEY });
          // The gallery's copy of the same answer. Both go out of date on the same event for
          // the same reason, and they are two calls rather than one because the two reads share
          // no prefix — see the paragraph above on why a fix to one is not a fix to the other.
          void queryClient.invalidateQueries({ queryKey: DECK_BRACKETS_ROOT });
        }
      }),
    [queryClient],
  );

  return {
    status: status ?? null,
    refreshing: progress !== null && RUNNING.includes(progress.phase),
    progress,
  };
}
