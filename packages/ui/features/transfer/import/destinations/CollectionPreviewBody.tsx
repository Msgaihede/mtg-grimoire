/**
 * The collection as a destination: what the second step of the dialog draws when the cards are
 * going into the reader's own binder.
 *
 * **Two facts a text list cannot carry, said before the reader commits.** A file's own row can
 * override either — `planCollectionImport` reads `extra.condition` and `line.finish` first and
 * only falls back to these — but most lines say nothing about either, and a hundred rows filed
 * on a silent guess is a hundred things to correct by hand afterwards if the reader meant
 * something else. The two dropdowns are the store's `importDefaults`, shared with the wishlist's
 * finish alone: a reader who has just told this dialog "assume nothing about the grade, and
 * foil" is answering a question about their box, not about this screen.
 *
 * **The Condition dropdown opens on "Not set" since schema v35, which is the one option in it
 * that is not a grade.** It is still a question worth asking — a reader importing a box they
 * graded on the way in answers `NM` once instead of correcting three hundred rows — but the
 * answer it opens on now records that the file said nothing, rather than putting the best grade
 * on the scale on every ungraded line.
 *
 * **Under `set` the headline is the backend's own count, not this page's arithmetic** (issue
 * #555). It used to say "40 cards will be added" over a press that lowers some quantities,
 * deletes others and — before the backend learnt to count filed copies toward the file's
 * number — doubled every copy the reader had filed in a folder. What a `set` does depends on what
 * the reader already holds, which only the database knows, so the sentence is drawn from
 * `ipc.collectionImportPreview`: the same write, run without writing.
 *
 * **Which folder the file lands in is the third question, asked first** (issue #872). A file
 * says nothing about a reader's filing, so the step asks: `Import into` opens on whatever the
 * host named — the drawer the reader is standing in, or the one whose menu they pressed — and on
 * Not sorted otherwise, and offers every drawer the reader made plus a new one named on the spot.
 * A host that hands no `folders` draws no selector and lands every row at the root, which is the
 * light app's phone face: it has no folder tree to choose from.
 */
import { useId, useMemo, useRef, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { offerUndo } from "@/lib/bulkUndo";
import { CONDITIONS, CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { count, plural, verb } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { buildFolderTree, flattenFolders, trailOf } from "@/lib/folderTree";
import {
  ipc,
  ipcError,
  type CollectionFolder,
  type DeckFinish,
  type ImportCommitOutcome,
  type TransferImportMode,
} from "@/lib/ipc";
import { languageName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import type { DestinationPreviewProps, ImportDestination, ImportModeOption } from "../destination";
import type { ImportDefaults } from "../../prefs";
import { CommitBar, useImportCommit } from "../shared/CommitBar";
import { ModeRadios } from "../shared/ModeRadios";
import { ImportProblems } from "../shared/Problems";
import { BinderImportStopped, binderImportProgress, useImport } from "../useImport";
import { BinderSort, binderDoneMessage } from "./BinderSort";
import { hasBinders, planBinderImport } from "./binders";
import { planCollectionImport, type CollectionPlan } from "./collection";
import { ProblemList } from "./DeckPreviewBody";

/**
 * No `replace`: the deck's version clears one variant of one deck, and the same word over a
 * collection would empty a 3,000-card record from a 40-line paste with the file that caused it
 * looking completely ordinary — see `TransferImportMode`'s own doc for why the backend never
 * offers the word at all.
 *
 * **`set`'s hint says "folders included" because that is the rule now and was not before.** A
 * `set` used to write the file's number into a root row beside whatever the reader had filed,
 * so 4 in the file over 3 in a binder became 7. The backend counts the filed copies toward the
 * file's number and adjusts the root by the difference, and a reader choosing between the two
 * radios needs to know the number means *all* of them before they press.
 */
export const COLLECTION_MODES: readonly ImportModeOption[] = [
  { key: "add", label: "Add these copies", hint: "Quantities add to what you already own." },
  {
    key: "set",
    label: "Set these quantities",
    hint: "Replaces your quantities with the file's, including copies in folders.",
  },
];

/**
 * The same two modes **when the file is going into a folder**, where `set` means something
 * narrower. Filed into a folder, `walk_import` writes the file's number into *that folder's* row
 * and counts nothing filed anywhere else — so "including copies in folders" would be the root's
 * rule told over a press that does not follow it.
 */
export const FOLDER_MODES: readonly ImportModeOption[] = [
  COLLECTION_MODES[0],
  {
    key: "set",
    label: "Set these quantities",
    hint: "Replaces the quantities in this folder with the file's. Copies elsewhere stay.",
  },
];

/** The selector's value for Not sorted — the root, `folderId: null`. */
const NOT_SORTED = "";
/** The selector's value for a folder the press will make. Never a number, so never an id. */
const NEW_FOLDER = "new";

/**
 * Where the file can be filed — handed in, because the folder list is the face's to read and the
 * phone face has none.
 */
export interface ImportFolderProps {
  /**
   * Every folder the collection has, flat — `collection_folder_list`'s answer. Only the reader's
   * own (`kind: "user"`) are offered: a deck's group asserts the deck holds the copies and
   * `Recently removed` would be cardboard arriving already discarded.
   *
   * **Absent draws no selector**, and every row lands at the root exactly as it always has.
   */
  folders?: readonly CollectionFolder[];
  /** The folder the selector opens on. `null` or absent is Not sorted, and so is an id naming no
   *  folder of the reader's own — rather than a selector showing a value it cannot offer. */
  initialFolderId?: number | null;
}

/**
 * The two fallbacks this step draws, and where a change to them is remembered — handed in, because
 * where they live is the face's question: `useAppStore` on the desktop (`./CollectionPreview`), a
 * store of the phone face's own in the light app. Either way they outlive the step, so a reader
 * importing box after box re-picks nothing.
 */
export interface ImportDefaultsProps {
  defaults: ImportDefaults;
  setDefaults: (defaults: ImportDefaults) => void;
}

/**
 * The collection's step, **store-free** — `CollectionPreview` in `./CollectionPreview` is this
 * with the desktop store's answers handed in, and the light app's phone face hands its own.
 */
export function CollectionPreviewBody({
  list,
  resolved,
  tags,
  onDone,
  report,
  onBack,
  defaults,
  setDefaults,
  folders,
  initialFolderId = null,
}: DestinationPreviewProps & ImportDefaultsProps & ImportFolderProps): JSX.Element {
  const id = useId();
  const [mode, setMode] = useState("add");

  const plan = useMemo(
    () => planCollectionImport(list, resolved, defaults),
    [list, resolved, defaults],
  );

  // A ManaBox export names the binder every row is in (issue #873), and is then offered sorted:
  // folders and decks by binder, rather than the whole file into one place. `binderPlan` is
  // `null` for every file that names none — which is every file but that one — and the step below
  // is then exactly the step it always was. Planned over the same `resolved` rows and the same
  // defaults as `plan`, so the copies the list promises are the copies the groups write.
  const binderPlan = useMemo(
    () => (hasBinders(list) ? planBinderImport(list, resolved, tags, defaults) : null),
    [list, resolved, tags, defaults],
  );
  const [byBinder, setByBinder] = useState(true);
  const sorting = binderPlan !== null && byBinder;
  const { importBinders } = useImport();
  /**
   * What this step's sorted presses have written (issue #1173): a press refused part-way leaves
   * Import enabled, and the next press finishes the file from where it stopped rather than adding
   * the groups that landed a second time — the binder path's twin of {@link made} below. Mutated
   * by the write itself and never drawn, so it is state only for its lazy, once-per-step start.
   */
  const [binderProgress] = useState(binderImportProgress);

  /**
   * The reader's own drawers, top to bottom in the order the wall draws them, each labelled with
   * its whole path — a closed trigger reading `Rares` cannot say which binder's.
   */
  const drawers = useMemo(() => {
    const own = (folders ?? []).filter((folder) => folder.kind === "user");
    return flattenFolders(buildFolderTree(own, [])).map((node) => ({
      id: node.folder.id,
      name: node.folder.name,
      path: trailOf(own, node.folder.id)
        .map((folder) => folder.name)
        .join(" / "),
    }));
  }, [folders]);

  const [target, setTarget] = useState(() =>
    drawers.some((drawer) => drawer.id === initialFolderId) ? String(initialFolderId) : NOT_SORTED,
  );
  const [newName, setNewName] = useState("");
  const making = target === NEW_FOLDER;
  /** The folder the selector names, or `null` for Not sorted and for one not made yet. */
  const chosenId = target === NOT_SORTED || making ? null : Number(target);
  const chosen = drawers.find((drawer) => drawer.id === chosenId);
  const intoFolder = making || chosenId !== null;
  /** Where the sentences say the cards are going. */
  const where = making
    ? newName.trim() === ""
      ? "a new folder"
      : `a new folder, ${newName.trim()}`
    : (chosen?.name ?? "your collection");

  /** Where the toast says the cards went: a folder's name in quotes, which the sentences above
   *  draw bare because they sit beside the selector that names it. */
  const receiptWhere = making
    ? newName.trim() === ""
      ? "a new folder"
      : `“${newName.trim()}”`
    : chosen === undefined
      ? "your collection"
      : `“${chosen.name}”`;

  /**
   * The folder this press made, by the name it was made under — so a commit refused after the
   * folder landed and pressed again files into that folder rather than making a second one beside
   * it. A changed name is a different folder, and makes one.
   */
  const made = useRef<{ name: string; id: number } | null>(null);
  const folderForCommit = async (): Promise<number | null> => {
    if (!making) return chosenId;
    const name = newName.trim();
    if (made.current?.name === name) return made.current.id;
    const folder = await ipc.collectionFolderCreate(null, name);
    made.current = { name, id: folder.id };
    return folder.id;
  };

  // The same four keys `CollectionPage`'s own writes invalidate on a stepper press
  // (`settle`/`settleFailure`) — `["collection"]` covers both the list and the summary a bulk
  // import moves the same as a single row does, and the other three are what else reads "what
  // is owned": the wishlist's owned-progress, the search wall's owned badges, and every open
  // deck. That last one is a real move even though this import files into no deck's group: since
  // schema v25 a theory list's spare column counts exactly the copies that are in no group, and a
  // 300-row import into the root or a drawer is 300 of them. It moves ownership at least as much
  // as one stepper press, so it earns the same invalidation set rather than a narrower one of its
  // own. `["collection"]` also covers the folder list a new folder has just joined — on a refusal
  // too, which is `useImportCommit`'s, since the folder may have landed before the import failed.
  const commit = useImportCommit(
    [["collection"], ["wishlist"], ["cards", "search"], ["decks"]],
    async () =>
      ipc.collectionImportCommit(plan.items, mode as TransferImportMode, await folderForCommit()),
  );

  // **The items are in the key as one string**, memoised with the plan: TanStack hashes a key on
  // every render, and a 3,000-item array hashed field by field with its keys sorted is a cost
  // this step would pay on every dropdown press. A string is the same identity for a fraction of
  // it. Under `["collection"]` so every collection write — including this dialog's own, and a
  // second window's — invalidates it: the dry run is a fact about the rows as they stand.
  const itemsKey = useMemo(() => JSON.stringify(plan.items), [plan.items]);
  const dryRun = useQuery({
    queryKey: ["collection", "importPreview", mode, chosenId, itemsKey],
    queryFn: () => ipc.collectionImportPreview(plan.items, mode as TransferImportMode, chosenId),
    // `add` needs no count — its sentence is the file's own total — and neither does an empty
    // plan. **Off while the write is in flight and after it lands**: the commit invalidates
    // `["collection"]`, and a dry run refetched over the rows it has just written would redraw
    // the sentence as "nothing changes" in the frame before the dialog closes. **And off for a
    // folder not made yet**: there is no id to ask about and nothing to ask — an empty folder set
    // to the file's numbers is the file added, which is the sentence `add` draws.
    enabled:
      !sorting &&
      mode === "set" &&
      !making &&
      plan.items.length > 0 &&
      !commit.isPending &&
      !commit.isSuccess,
    // A refused dry run is said once and the reader can still press Import; retrying it three
    // times with backoff would hold "Counting…" on screen for seconds to say the same thing.
    retry: false,
  });

  const runImport = () => {
    if (plan.items.length === 0) return;
    if (sorting) {
      // No undo offer: the press is one write per binder, each with a ticket of its own, and
      // offering the last of them would take back one folder and say it took back the file.
      // A deck it made is undone the way any deck is — deleting it sends its copies to
      // `Recently removed`.
      // One toast for the whole press, however many binders it wrote: what landed on a success,
      // and on a refusal how far it got — a warning when some groups landed before it stopped,
      // since those copies are in the collection now, and a refusal when none did.
      importBinders.mutate(
        { groups: binderPlan.groups, progress: binderProgress },
        {
          onSuccess: (result) => {
            report?.({
              title: `Imported ${cards(result.copies)} into your collection`,
              body: binderDoneMessage(result),
              tone: "success",
            });
            onDone(binderDoneMessage(result));
          },
          onError: (e) => {
            const stopped = e instanceof BinderImportStopped ? e : null;
            report?.(
              stopped !== null && stopped.copies > 0
                ? {
                    title: `Imported ${count(stopped.copies)} of ${cards(stopped.total)} into your collection`,
                    body: stopped.message,
                    tone: "warning",
                  }
                : {
                    title: "Couldn't import into your collection",
                    body: ipcError(e),
                    tone: "error",
                  },
            );
          },
        },
      );
      return;
    }
    commit.mutate(undefined, {
      onError: (e) =>
        report?.({
          title: `Couldn't import into ${receiptWhere}`,
          body: ipcError(e),
          tone: "error",
        }),
      onSuccess: (outcome) => {
        // The toast is the receipt the owner's rule asks of every collection write; the undo bar
        // on the page keeps the Undo. One notice for the one transaction.
        report?.({
          title: receiptOf(mode, plan, intoFolder ? receiptWhere : null),
          body: doneCounts(outcome),
          tone: "success",
        });
        // `?? null`: an outcome from a build (or a test double) that predates the ticket carries
        // no `undoId` at all, and `offerUndo` offers anything that is not `null`.
        offerUndo(
          "collection",
          outcome.undoId ?? null,
          undoLabel(mode, plan, intoFolder ? where : null),
        );
        onDone(doneMessage(outcome));
      },
    });
  };

  // Exempt from `sortOptions`: a condition grade's order *is* the information — Near Mint
  // to Damaged is a scale, not an alphabet (`packages/ui/CLAUDE.md`'s exemption rule) — so `CONDITIONS`'
  // own order is drawn unchanged. That includes `NONE` in front of the scale rather than inside
  // it: it is the absence of a grade and the row this dropdown opens on, and `conditions.ts`
  // argues both halves at the constant itself.
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
        {/* First, because the sentence under it names its answer. Not while sorting by binder:
            the binders say where every card goes, so a single destination would be a question
            the press does not ask. */}
        {folders !== undefined && !sorting && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {/* `Default condition`'s labelling, below, for its reason. */}
            <label id="collection-import-folder-label" htmlFor="collection-import-folder">
              Import into
            </label>
            <Dropdown
              id="collection-import-folder"
              labelledBy="collection-import-folder-label"
              size="sm"
              value={target}
              onChange={setTarget}
              options={[
                // What the wall calls the root's shelf, so what the selector calls it.
                { value: NOT_SORTED, label: "Not sorted" },
                // Exempt from `sortOptions`: the order is the tree's, which is the wall's.
                ...drawers.map((drawer) => ({ value: String(drawer.id), label: drawer.path })),
                { value: NEW_FOLDER, label: "New folder…" },
              ]}
              className="bg-surface"
            />
            {making && (
              <input
                aria-label="New folder name"
                placeholder="Folder name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className={cn(
                  "h-7 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm",
                  "focus:border-accent focus:outline-none",
                  FOCUS,
                )}
              />
            )}
          </div>
        )}

        {/* A sorted press is always `add`, whatever the hidden radios last said. */}
        {!sorting && mode === "set" && !making ? (
          <SetSummary cardCount={plan.items.length} outcome={dryRun.data} error={dryRun.error} />
        ) : (
          <p className="text-sm">
            {cards(plan.totalCards)} will be added to {sorting ? "your collection" : where}.
          </p>
        )}

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
              Default condition
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
              Default finish
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

        {binderPlan !== null && (
          <BinderSort
            plan={binderPlan}
            checked={byBinder}
            onChange={setByBinder}
            id={`${id}-binders`}
          />
        )}

        {/* No radios while sorting: the sorted press is always `add`. A `set` counts every
            folder's copies toward the file's number, so run once per binder it would have each
            group rewrite what the others had just written — `importBinderGroups` says so too. */}
        {!sorting && (
          <ModeRadios
            modes={intoFolder ? FOLDER_MODES : COLLECTION_MODES}
            value={mode}
            onChange={setMode}
            label="How to apply this file"
          />
        )}

        {/* While sorting, the merges listed are the binders' own: the whole-file plan merges
            copies across binders, which the sorted press never does. */}
        <CollectionProblems
          plan={
            sorting
              ? { ...plan, folded: binderPlan.folded, droppedPrices: binderPlan.droppedPrices }
              : plan
          }
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
        pending={sorting ? importBinders.isPending : commit.isPending}
        // A new folder with no name is not a folder yet: the backend would refuse it in words, and
        // a button whose only outcome is that sentence teaches nothing its greying does not.
        disabled={plan.items.length === 0 || (!sorting && making && newName.trim() === "")}
        message={commitMessage(sorting ? importBinders.error : commit.error)}
        failed={(sorting ? importBinders.error : commit.error) !== null}
        onBack={onBack}
      />
    </form>
  );
}

/** The commit bar's sentence for whichever press the step is making — empty until one fails. */
function commitMessage(error: Error | null): string {
  return error === null ? "" : `Couldn't import the list — ${ipcError(error)}`;
}

/**
 * What a `set` would do, from the dry run — or a neutral sentence while it counts, or the reason
 * it could not.
 *
 * **A refused count never blocks Import.** The dry run is a courtesy: the write is its own
 * transaction with its own refusal, and a reader who can see their file was read correctly is
 * entitled to press the button whether or not this page managed to predict the outcome.
 *
 * `cardCount` is the number of **items** — distinct copies at the collection's grain — and not
 * the file's total, because `added`/`updated`/`removed` are counted in rows: "Sets how many you
 * hold of 1 card: 1 changed" is a file reading `4 Lightning Bolt`.
 */
function SetSummary({
  cardCount,
  outcome,
  error,
}: {
  cardCount: number;
  outcome: ImportCommitOutcome | undefined;
  error: unknown;
}): JSX.Element {
  if (cardCount === 0) return <p className="text-sm">Nothing in this file can be imported.</p>;
  if (error !== null) {
    return (
      <div className="space-y-1">
        <p className="text-sm">Updates quantities for {cards(cardCount)}.</p>
        <p className="text-xs text-dim">Couldn&apos;t preview changes — {ipcError(error)}</p>
      </div>
    );
  }
  if (outcome === undefined) {
    return <p className="text-sm">Previewing changes…</p>;
  }
  return (
    <div className="space-y-1">
      <p className="text-sm">{setSentence(cardCount, outcome)}</p>
      {outcome.leftInFolders > 0 && (
        <p className="text-xs text-dim">{leftInFoldersSentence(outcome.leftInFolders)}</p>
      )}
    </div>
  );
}

/**
 * `Sets how many you hold of 40 cards: 5 new, 20 changed, 2 removed — 12 more copies than now.`
 *
 * **Only the parts that are not zero are named**, and a file that matches the collection
 * exactly says so in words rather than as `0 new, 0 changed, 0 removed`. The copies clause is the
 * one a reader restoring a backup is really asking — *will I have more cardboard or less* — so it
 * turns on the sign rather than printing `-12 more`.
 */
function setSentence(cardCount: number, outcome: ImportCommitOutcome): string {
  const head = `Updates quantities for ${cards(cardCount)}`;
  const parts = [
    outcome.added > 0 ? `${count(outcome.added)} new` : null,
    outcome.updated > 0 ? `${count(outcome.updated)} changed` : null,
    outcome.removed > 0 ? `${count(outcome.removed)} removed` : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return `${head}: all quantities already match. Nothing to change.`;
  return `${head}: ${parts.join(", ")} — ${copiesClause(outcome.copies)}.`;
}

function copiesClause(copies: number): string {
  if (copies === 0) return "the same number of copies as now";
  const n = Math.abs(copies);
  return `${count(n)} ${copies > 0 ? "more" : "fewer"} ${n === 1 ? "copy" : "copies"} than now`;
}

/**
 * The copies a `set` counted toward the file's number and could not take away, because they are
 * filed — `ImportCommitOutcome.leftInFolders`. A file says nothing about a reader's filing, so the
 * backend never reaches into a folder to lower a count, and this is where the reader learns their
 * binder still holds more than the file does.
 */
function leftInFoldersSentence(n: number): string {
  return (
    `${count(n)} ${n === 1 ? "copy" : "copies"} in ${n === 1 ? "a folder" : "folders"} ` +
    `${verb(n, "exceeds", "exceed")} the file's count and will stay.`
  );
}

/**
 * The sentence the collection page's undo notice draws — already pluralised, as
 * `UndoOffer.label` asks. The two modes are two different acts and say so: an `add` imported
 * cards, a `set` rewrote quantities, and a reader deciding whether to press Undo needs to know
 * which one they would be taking back.
 */
function undoLabel(mode: string, plan: CollectionPlan, folder: string | null): string {
  return mode === "set"
    ? `Set quantities${folder === null ? "" : ` in ${folder}`} from a file of ${cards(plan.items.length)}.`
    : `Imported ${cards(plan.totalCards)} into ${folder ?? "your collection"}.`;
}

/** The toast's title: {@link undoLabel}'s sentence, with the folder quoted and no full stop. */
function receiptOf(mode: string, plan: CollectionPlan, folder: string | null): string {
  return mode === "set"
    ? `Set quantities in ${folder ?? "your collection"} from a file of ${cards(plan.items.length)}`
    : `Imported ${cards(plan.totalCards)} into ${folder ?? "your collection"}`;
}

/** What `onDone` reports. `removed` only when a `set` removed something — an `add` never does,
 *  and `0 removed` on every import would be a clause that is never news. */
function doneMessage(outcome: ImportCommitOutcome): string {
  return `${doneCounts(outcome)}.`;
}

/** {@link doneMessage} without its full stop — the toast's second line. */
function doneCounts(outcome: ImportCommitOutcome): string {
  const removed = outcome.removed > 0 ? `, ${outcome.removed} removed` : "";
  return `${outcome.added} added, ${outcome.updated} updated${removed}`;
}

/** `1 card`, `3,000 cards` — `plural` with the thousands separator a collection file reaches and
 *  a deck never does (`counts.ts`' own note on `plural`). */
function cards(n: number): string {
  return `${count(n)} ${n === 1 ? "card" : "cards"}`;
}

/**
 * The collection's own warnings, beside the three `ImportProblems` draws for every destination.
 *
 * **Each one is a place the file said something the import cannot carry as written**, and each
 * is listed rather than absorbed: a grade or a tradelist this app could not read, a language it
 * has no printing in, a price in another currency than the copy it was merged into. The fold is
 * listed too, although nothing is lost by it, because a file of 300 lines that lands as 290 rows
 * is a file the reader will otherwise count by hand.
 */
function CollectionProblems({ plan }: { plan: CollectionPlan }): JSX.Element {
  return (
    <>
      {/* A grade the file named that this app cannot read fell back to the default above rather
          than being filed as though the file had named none. Only the collection reads
          conditions, so this has no wishlist equivalent. */}
      {plan.unknownConditions.length > 0 && (
        <ProblemList
          caption={`${plural(plan.unknownConditions.length, "line")} had an unknown condition, so the default was used`}
          lines={plan.unknownConditions.map(
            (u) => `line ${u.lineNumber} · ${u.name} — "${u.said}"`,
          )}
        />
      )}

      {/* A language cell nothing here can read was sent to the resolver as no preference at all,
          so the line matched whichever printing it would have without the column. */}
      {plan.unknownLanguages.length > 0 && (
        <ProblemList
          caption={`${plural(plan.unknownLanguages.length, "line")} had an unknown language and ${verb(plan.unknownLanguages.length, "was", "were")} matched without it`}
          lines={plan.unknownLanguages.map((u) => `line ${u.lineNumber} · ${u.name} — "${u.said}"`)}
        />
      )}

      {/* The resolver preferred the file's language and the corpus had nothing in it — the row
          takes its language from the printing it names, so this is the only notice the reader
          gets that their Japanese copy is about to be recorded as English. */}
      {plan.languageMismatches.length > 0 && (
        <ProblemList
          caption={`${plural(plan.languageMismatches.length, "line")} asked for a language with no printing, and will be added in an available language`}
          lines={plan.languageMismatches.map(
            (m) =>
              `line ${m.lineNumber} · ${m.name} — the file says ${languageName(m.said)}; added as ${languageName(m.used)}`,
          )}
        />
      )}

      {/* The same shape for a purchase price the file filled and this app could not read —
          refused rather than guessed (`parsePurchasePrice`), so the copy lands with no price
          and this is the only place the reader learns the cell was not empty. */}
      {plan.unreadablePrices.length > 0 && (
        <ProblemList
          caption={`${plural(plan.unreadablePrices.length, "line")} had an unreadable purchase price, and will be added without one`}
          lines={plan.unreadablePrices.map((u) => `line ${u.lineNumber} · ${u.name} — "${u.said}"`)}
        />
      )}

      {plan.unreadableTradelists.length > 0 && (
        <ProblemList
          caption={`${plural(plan.unreadableTradelists.length, "line")} had an invalid tradelist quantity, and will be added without one`}
          lines={plan.unreadableTradelists.map(
            (u) => `line ${u.lineNumber} · ${u.name} — "${u.said}"`,
          )}
        />
      )}

      {plan.folded.length > 0 && (
        <ProblemList
          caption={`${plural(plan.folded.length, "line")} duplicated an earlier line and ${verb(plan.folded.length, "was", "were")} merged into it`}
          lines={plan.folded.map((f) => `line ${f.lineNumber} → line ${f.into} · ${f.name}`)}
        />
      )}

      {/* A mean across currencies is a number in no currency, so the first price a copy was
          given sets its currency and a later one in another is left out — said here, because
          the merged row's price is otherwise indistinguishable from one nobody disagreed with. */}
      {plan.droppedPrices.length > 0 && (
        <ProblemList
          caption={`${plural(plan.droppedPrices.length, "merged line")} had a price in a different currency, and ${verb(plan.droppedPrices.length, "that price was", "those prices were")} dropped`}
          lines={plan.droppedPrices.map(
            (d) =>
              `line ${d.lineNumber} → line ${d.into} · ${d.name} — "${d.said}" ${inCurrency(d.currency)}, kept ${inCurrency(d.kept)}`,
          )}
        />
      )}
    </>
  );
}

function inCurrency(currency: string | undefined): string {
  return currency === undefined ? "with no currency" : `in ${currency}`;
}

/**
 * The collection as a destination, less its `Preview` — the key and the radio's word, which both
 * faces' descriptors share. The desktop's is `collectionDestination` in `./CollectionPreview`.
 */
export const COLLECTION_DESTINATION: Omit<ImportDestination, "Preview"> = {
  key: "collection",
  label: "your collection",
};
