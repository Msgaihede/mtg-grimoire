import { useState, type JSX } from "react";
import { RefreshCw } from "lucide-react";
import { PageBar, type PageCrumb } from "@/components/PageBar";
import type { BoosterSetSummary } from "@/lib/ipc";
import { ago } from "@/lib/relativeTime";
import { useBoosterSet, useBoosterSets } from "../sets";
import { SetGrid } from "../SetGrid";
import { ProductStage, SECONDARY } from "./ProductStage";

/** The page's own name, and the trail's root word for the page above it. */
const TITLE = "Open Packs";
const ROOT = "Draft & Packs";

/**
 * **Open Packs** — the Draft & Packs page's pack opener (spec §7), botbox.dev's idea: pick a set
 * (MTGJSON's — `useBoosterSets`, never the corpus's set list), pick a product (a booster, or a
 * sealed product that holds boosters), open it, and compare what came out with what that product
 * is worth on average.
 *
 * Two steps under one page bar: the set wall, then the set's products and what was opened. The
 * trail walks back up — `Draft & Packs` is `onBack`, `Open Packs` is the set wall again.
 *
 * Nothing here writes: an opened pack is not added to the collection, and the session's tally is
 * window memory.
 */
export function PackOpener({ onBack }: { onBack: () => void }): JSX.Element {
  const [picked, setPicked] = useState<BoosterSetSummary | null>(null);
  const { sets, loading, error, retry } = useBoosterSets();
  const root: PageCrumb = { label: ROOT, name: `${ROOT}, back`, onOpen: onBack };

  if (picked === null) {
    return (
      <section className="flex h-full min-h-0 flex-col">
        <PageBar trail={[root]} title={TITLE} />
        <div className="min-h-0 flex-1 overflow-y-auto pb-6 pr-6 pt-3">
          {loading ? (
            <p role="status" className="m-0 text-sm text-dim">
              Fetching the sets from MTGJSON…
            </p>
          ) : error !== null ? (
            <div className="flex flex-col items-start gap-3">
              <p role="alert" className="m-0 text-sm text-destructive">
                {error}
              </p>
              <button type="button" onClick={retry} className={SECONDARY}>
                Retry
              </button>
            </div>
          ) : (
            <SetGrid sets={sets} onPick={setPicked} label="Sets to open" />
          )}
        </div>
      </section>
    );
  }

  return (
    <SetStage
      summary={picked}
      trail={[
        root,
        { label: TITLE, name: `${TITLE}, choose another set`, onOpen: () => setPicked(null) },
      ]}
    />
  );
}

/**
 * When the set's MTGJSON file was fetched, for the bar's meta. The clock is a default parameter,
 * `BackupPanel`'s `lastPassLine` shape: "2 hours ago" is a fact about the render, not state.
 */
export function fetchedLine(fetchedAtMs: number, nowMs: number = Date.now()): string {
  return `MTGJSON · fetched ${ago(fetchedAtMs / 1000, nowMs)}`;
}

/** One set's page: fetching its boosters, the host's refusal, or its products. */
function SetStage({
  summary,
  trail,
}: {
  summary: BoosterSetSummary;
  trail: PageCrumb[];
}): JSX.Element {
  const booster = useBoosterSet(summary.code);
  const set = booster.set;
  return (
    <section className="flex h-full min-h-0 flex-col">
      <PageBar
        trail={trail}
        title={summary.name}
        meta={set !== undefined ? fetchedLine(set.fetchedAt) : summary.code.toUpperCase()}
        actions={
          set !== undefined && (
            <button
              type="button"
              onClick={() => void booster.refresh()}
              disabled={booster.refreshing}
              className={SECONDARY}
            >
              <RefreshCw
                className={
                  booster.refreshing ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"
                }
                aria-hidden="true"
              />
              {booster.refreshing ? "Refreshing…" : "Refresh"}
            </button>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-6 pr-6 pt-3">
        {booster.loading ? (
          <p role="status" className="m-0 text-sm text-dim">
            Fetching booster data from MTGJSON…
          </p>
        ) : booster.error !== null ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="m-0 text-sm text-destructive">
              {booster.error}
            </p>
            <button type="button" onClick={booster.retry} className={SECONDARY}>
              Retry
            </button>
          </div>
        ) : set !== undefined ? (
          // Keyed on the set's file, so a Refresh that brings new sheets starts the stage over
          // rather than keeping a pack opened from the old ones.
          <ProductStage key={`${set.code}:${set.fetchedAt}`} set={set} />
        ) : null}
      </div>
    </section>
  );
}
