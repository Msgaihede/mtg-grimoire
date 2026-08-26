/**
 * The collection as a destination: what the second step of the dialog draws when the cards are
 * going into the reader's own binder.
 *
 * **Two facts a text list cannot carry, said before the reader commits.** A file's own row can
 * override either — `planCollectionImport` reads `extra.condition` and `line.finish` first and
 * only falls back to these — but most lines say nothing about either, and a hundred rows of
 * silent `NM`/regular is a hundred things to correct by hand afterwards if the reader meant
 * something else. The two dropdowns are the store's `importDefaults`, shared with the wishlist's
 * finish alone: a reader who has just told this dialog "assume Near Mint, foil" is answering a
 * question about their box, not about this screen.
 */
import { useMemo, useState, type JSX } from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { CONDITIONS, CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { plural } from "@/lib/counts";
import { ipc, ipcError, type DeckFinish, type TransferImportMode } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import type { DestinationPreviewProps, ImportDestination, ImportModeOption } from "../destination";
import { CommitBar, useImportCommit } from "../shared/CommitBar";
import { ModeRadios } from "../shared/ModeRadios";
import { ImportProblems } from "../shared/Problems";
import { planCollectionImport } from "./collection";
import { ProblemList } from "./DeckPreview";

/**
 * No `replace`: the deck's version clears one variant of one deck, and the same word over a
 * collection would empty a 3,000-card record from a 40-line paste with the file that caused it
 * looking completely ordinary — see `TransferImportMode`'s own doc for why the backend never
 * offers the word at all.
 */
export const COLLECTION_MODES: readonly ImportModeOption[] = [
  { key: "add", label: "Add these copies", hint: "Quantities add to what you already own." },
  { key: "set", label: "Set these quantities", hint: "The file's number replaces yours." },
];

export function CollectionPreview({
  list,
  resolved,
  onDone,
  onBack,
}: DestinationPreviewProps): JSX.Element {
  // The defaults live in the store so a reader importing box after box re-picks nothing.
  const defaults = useAppStore((s) => s.importDefaults);
  const setDefaults = useAppStore((s) => s.setImportDefaults);
  const [mode, setMode] = useState("add");

  const plan = useMemo(
    () => planCollectionImport(list, resolved, defaults),
    [list, resolved, defaults],
  );

  // The same four keys `CollectionPage`'s own writes invalidate on a stepper press
  // (`settle`/`settleFailure`) — `["collection"]` covers both the list and the summary a bulk
  // import moves the same as a single row does, and the other three are what else reads "what
  // is owned": the wishlist's owned-progress, the search wall's owned badges, and every open
  // deck. That last one is a real move even though this import lands `folder_id: None` and so
  // touches no deck's group: since schema v25 a theory list's spare column counts exactly the
  // copies that are in no group, and a 300-row import into the root is 300 of them. It moves
  // ownership at least as much as one stepper press, so it earns the same invalidation set
  // rather than a narrower one of its own.
  const commit = useImportCommit(
    [["collection"], ["wishlist"], ["cards", "search"], ["decks"]],
    () => ipc.collectionImportCommit(plan.items, mode as TransferImportMode),
  );

  const runImport = () => {
    if (plan.items.length === 0) return;
    commit.mutate(undefined, {
      onSuccess: (outcome) => onDone(`${outcome.added} added, ${outcome.updated} updated.`),
    });
  };

  // Exempt from `sortOptions`: a condition grade's order *is* the information — Near Mint
  // to Damaged is a scale, not an alphabet (`src/CLAUDE.md`'s exemption rule) — so `CONDITIONS`'
  // own order is drawn unchanged.
  const conditionOptions: readonly DropdownOption[] = CONDITIONS.map((c) => ({
    value: c,
    label: CONDITION_LABEL[c],
  }));

  // Exempt from `sortOptions` for the same reason: a printing's finishes run plain before the
  // premium treatments, and alphabetising would put Etched first.
  const finishOptions: readonly DropdownOption[] = [
    { value: "", label: "Regular" },
    { value: "foil", label: "Foil" },
    { value: "etched", label: "Etched" },
  ];

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
          collection.
        </p>

        {/* The two facts a text list cannot carry, said before the reader commits rather than
            discovered afterwards in 300 rows they have to correct by hand. A CSV that carries
            the columns overrides these per row — see `planCollectionImport`. */}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <div className="flex items-center gap-2">
            {/* An id'd `<label>` plus `labelledBy`, not a wrapping one left to itself: a
                `<label>` — wrapping or `for`/`id` — does reach a `<button>`'s accessible name the
                same way it reaches a `<select>`'s, `<button>` being labelable too, so `labelledBy`
                is not what makes the connection. It is what states the name outright rather than
                leaving it to an association a later refactor of this markup could break, and
                `htmlFor` alongside it keeps a click on the words opening the dropdown, the way it
                used to focus the select. */}
            <label id="collection-import-condition-label" htmlFor="collection-import-condition">
              Condition when the file doesn&apos;t say
            </label>
            <Dropdown
              id="collection-import-condition"
              labelledBy="collection-import-condition-label"
              size="sm"
              value={defaults.condition}
              onChange={(v) => setDefaults({ ...defaults, condition: v as Condition })}
              options={conditionOptions}
              className="bg-surface"
            />
          </div>
          <div className="flex items-center gap-2">
            {/* Same treatment as Condition above, and the same reason. */}
            <label id="collection-import-finish-label" htmlFor="collection-import-finish">
              Finish when the file doesn&apos;t say
            </label>
            <Dropdown
              id="collection-import-finish"
              labelledBy="collection-import-finish-label"
              size="sm"
              value={defaults.finish ?? ""}
              onChange={(v) =>
                setDefaults({ ...defaults, finish: v === "" ? null : (v as DeckFinish) })
              }
              options={finishOptions}
              className="bg-surface"
            />
          </div>
        </div>

        <ModeRadios
          modes={COLLECTION_MODES}
          value={mode}
          onChange={setMode}
          label="How to apply this file"
        />

        {/* The collection's own third warning, beside the two `ImportProblems` already draws —
            a grade the file named that this app cannot read fell back to the default above
            rather than being silently accepted as Near Mint. Only the collection reads
            conditions, so this has no wishlist equivalent. */}
        {plan.unknownConditions.length > 0 && (
          <ProblemList
            caption={`${plural(plan.unknownConditions.length, "line")} named a condition this app does not recognise, and used the default instead`}
            lines={plan.unknownConditions.map(
              (u) => `line ${u.lineNumber} · ${u.name} — "${u.said}"`,
            )}
          />
        )}

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

export const collectionDestination: ImportDestination = {
  key: "collection",
  label: "your collection",
  Preview: CollectionPreview,
};
