/**
 * The wishlist as a destination — `CollectionPreview.tsx`'s twin, with the finish control alone.
 *
 * **No condition select.** A wish is a card the reader does not have yet; recording a grade for
 * cardboard nobody owns is a question this list has never asked. The finish select is the same
 * store field the collection's own draws — `importDefaults.finish` — because "the shiny one" is
 * an answer about the reader's taste that both lists share; `importDefaults.condition` exists for
 * the collection alone and this preview never reads it.
 */
import { useMemo, useState, type JSX } from "react";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type DeckFinish, type TransferImportMode } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { DestinationPreviewProps, ImportDestination, ImportModeOption } from "../destination";
import { CommitBar, useImportCommit } from "../shared/CommitBar";
import { ModeRadios } from "../shared/ModeRadios";
import { ImportProblems } from "../shared/Problems";
import { planWishlistImport, toWishlistImportItems } from "./wishlist";

export const WISHLIST_MODES: readonly ImportModeOption[] = [
  { key: "add", label: "Add these wishes", hint: "Quantities add to what you already want." },
  { key: "set", label: "Set these quantities", hint: "The file's number replaces yours." },
];

export function WishlistPreview({
  list,
  resolved,
  onDone,
  onBack,
}: DestinationPreviewProps): JSX.Element {
  // The same store field the collection reads, finish alone — see the file doc.
  const defaults = useAppStore((s) => s.importDefaults);
  const setDefaults = useAppStore((s) => s.setImportDefaults);
  const [mode, setMode] = useState("add");

  const plan = useMemo(
    () => planWishlistImport(list, resolved, { finish: defaults.finish }),
    [list, resolved, defaults.finish],
  );

  // `["wishlist"]` and `["cards", "search"]` — the same pair `WishlistPage`'s own `settle()`
  // invalidates after a single wish write, since a wish write moves no copies and touches
  // neither the collection nor a deck's claims. See `useImportCommit`'s own doc.
  const commit = useImportCommit(
    [["wishlist"], ["cards", "search"]],
    () => ipc.wishlistImportCommit(toWishlistImportItems(plan.items), mode as TransferImportMode),
  );

  const runImport = () => {
    if (plan.items.length === 0) return;
    commit.mutate(undefined, {
      onSuccess: (outcome) => onDone(`${outcome.added} added, ${outcome.updated} updated.`),
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        runImport();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <p className="text-sm">
          {plan.totalCards === 1 ? "1 card" : `${plan.totalCards} cards`} will be added to your
          wishlist.
        </p>

        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            Finish when the file doesn&apos;t say
            <select
              value={defaults.finish ?? ""}
              onChange={(e) =>
                setDefaults({
                  ...defaults,
                  finish: e.target.value === "" ? null : (e.target.value as DeckFinish),
                })
              }
              className={cn("h-8 rounded-md border border-border bg-surface px-2", FOCUS)}
            >
              <option value="">No preference</option>
              <option value="foil">Foil</option>
              <option value="etched">Etched</option>
            </select>
          </label>
        </div>

        <ModeRadios
          modes={WISHLIST_MODES}
          value={mode}
          onChange={setMode}
          label="How to apply this file"
        />

        <ImportProblems
          unmatched={plan.unmatched}
          hintMisses={plan.hintMisses}
          parseIssues={plan.parseIssues}
        />
      </div>

      <CommitBar
        label="Import"
        pendingLabel="Importing…"
        pending={commit.isPending}
        disabled={plan.items.length === 0}
        message={
          commit.error === null ? "" : `Could not import the list — ${ipcError(commit.error)}`
        }
        failed={commit.error !== null}
        onBack={onBack}
      />
    </form>
  );
}

export const wishlistDestination: ImportDestination = {
  key: "wishlist",
  label: "your wishlist",
  Preview: WishlistPreview,
};
