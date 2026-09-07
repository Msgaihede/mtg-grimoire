/**
 * A decklist as a deck of its own: the same planner as `DeckPreview`, three answers only this
 * arm has to ask for, and a different commit.
 *
 * **The one that decides most is where the format spec comes from.** A new deck is judged by the
 * format the reader picks *here*, live, as they change the select; a deck that already exists is
 * judged by its own `format_key`, which no import may change. Getting that backwards is a
 * Commander deck that never asks for a commander — a failure with nothing on screen to say it
 * happened.
 *
 * **The name, the format and the game are this destination's own options and are drawn on this
 * step**, beside the tally they change, rather than under the paste box where they used to
 * live. That is what the seam is for: the shell asks one question — what is the list — and every
 * question after it belongs to whatever the list is going into.
 *
 * **`importIntoNewDeck` stays in `useImport`** and this only calls it. It is `deck_create` then
 * `deck_import_commit` with a hand-rolled rollback between them, and that rollback belongs
 * inside the mutation that invalidates `["decks"]` on refusal as well as on success — two
 * commands are two transactions, and a refused import must not leave half a deck in the gallery.
 *
 * **This arm draws the "Add cards to collection" box too, and it is the arm that needs it most.**
 * The question was whether a *new* deck should offer it at all, and the code answers it: the
 * gallery's own path is "here is a decklist, make it a deck", which is overwhelmingly a list of
 * cards somebody has just built out of cardboard — a deck that already exists is more often a
 * list being edited. Leaving it off here would have made the one control that says "I own these"
 * available only on the path where the reader is least likely to. It costs nothing structurally:
 * `importIntoNewDeck` was already the file's multi-command case, so the copies are a third
 * command after a rollback window that had to exist anyway, and the box is `DeckPreview`'s
 * exported {@link OwnCopies} rather than a second one drawn here.
 */
import { useId, useMemo, useState, type JSX } from "react";
import { ipcError, type DeckGame } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { DEFAULT_FORMAT, FormatSelect, GameSelect } from "@/features/decks/FormatSelect";
import { ANY_GAME, useFormatSpecs } from "@/features/decks/useFormatSpecs";
import type { DestinationPreviewProps } from "../destination";
import { useImport } from "../useImport";
import { CommitBar } from "../shared/CommitBar";
import { ImportLabels, useLabelChoice } from "../shared/ImportLabels";
import { planCollectionImport } from "./collection";
import { buildImportPlan, tallyOf, toImportItems } from "./deck";
import {
  Commander,
  Headline,
  NO_COMMANDERS,
  OwnCopies,
  Problems,
  Tally,
  commanderIdsOf,
  reportOf,
  useBlameSync,
  type DeckImportInto,
} from "./DeckPreview";

/** What a host that makes decks elsewhere can say about this one — both optional, because the
 *  gallery is the only surface that has an answer to either. */
export type NewDeckInto = Pick<DeckImportInto, "onImported"> & {
  /**
   * The format this starts on — the one the reader last created a deck in.
   *
   * Optional because making a deck out of a list is the same act as making one from the gallery's
   * own dialog and the two must not disagree about where it starts, while a host that has no such
   * answer is entitled to say nothing. Absent falls back to {@link DEFAULT_FORMAT}, which is what
   * this select started on before the prop existed.
   */
  defaultFormatKey?: string;
};

export function NewDeckPreview({
  list,
  resolved,
  tags,
  onDone,
  onBack,
  defaultFormatKey,
  onImported,
}: DestinationPreviewProps & NewDeckInto): JSX.Element {
  const id = useId();
  /**
   * What the reader will call the deck, seeded from the file.
   *
   * A list exported from Arena carries the deck's name, and `Name` is the only line in any of
   * these formats that does — so the field opens holding it and is still theirs to overwrite.
   * Seeded once, at mount, because the list this step is about cannot change under it: the paste
   * is frozen behind Back.
   */
  const [name, setName] = useState(list.suggestedName ?? "");
  /** Seeded at mount, so nothing can land on top of a format the reader has picked. */
  const [formatKey, setFormatKey] = useState(defaultFormatKey ?? DEFAULT_FORMAT);
  /**
   * Which platform the new deck is for, and the whole of what narrows the format select beside
   * it.
   *
   * **`ANY_GAME` rather than a remembered value**, `CreateDeckDialog`'s `BLANK` rule and its
   * reason: there is no `last_deck_game`, because a filter a reader set to find one format
   * would otherwise open the next dialog with most of the list already hidden.
   */
  const [gameKey, setGameKey] = useState<DeckGame>(ANY_GAME);
  const [picked, setPicked] = useState<readonly string[]>(NO_COMMANDERS);
  /**
   * "I have physically built this deck", offered here as well as on the deck that already
   * exists — see this file's own doc for why this arm is the one that needs it most.
   */
  const [alsoOwn, setAlsoOwn] = useState(false);

  const { importIntoNewDeck } = useImport();
  const { formatSpecFor } = useFormatSpecs();
  /** The reader's standing answer for what a line that says nothing means, shared with both
   *  other import steps rather than asked a third time. `DeckPreview` argues it. */
  const importDefaults = useAppStore((s) => s.importDefaults);

  const spec = formatSpecFor(formatKey);
  const plan = useMemo(
    () => buildImportPlan(list, resolved, spec, tags),
    [list, resolved, spec, tags],
  );
  const commanderIds = commanderIdsOf(plan, picked);
  /** `DeckPreview`'s, verbatim and for its reason — a label is app-wide, so bringing one across
   *  into a brand-new deck is the same act with the same consequences. */
  const { dropped, chosen, toggle } = useLabelChoice(plan.labels);
  const items = useMemo(
    () => toImportItems(plan, commanderIds, chosen),
    [plan, commanderIds, chosen],
  );
  const categories = useMemo(() => tallyOf(items), [items]);
  const blameSync = useBlameSync(plan);

  /** The same lines at the collection's own grain — `DeckPreview`'s memo, verbatim and for its
   *  reason: the grains differ, so the second list is planned rather than adapted. */
  const owned = useMemo(
    () => planCollectionImport(list, resolved, importDefaults),
    [list, resolved, importDefaults],
  );

  const trimmedName = name.trim();
  const nameMissing = trimmedName === "";

  const runImport = () => {
    if (items.length === 0 || nameMissing) return;
    importIntoNewDeck.mutate(
      {
        name: trimmedName,
        formatKey,
        gameKey,
        items,
        collectionItems: alsoOwn ? owned.items : undefined,
      },
      {
        onSuccess: ({ deck, outcome, owned: ownedOutcome, ownRefusal }) => {
          onImported?.(deck.id, outcome);
          // The deck's own name in front of the shared sentence: the gallery is about to open
          // a tile the reader has never seen, and "6 cards imported" alone does not say into what.
          onDone(`${deck.name} — ${reportOf(outcome, ownedOutcome, ownRefusal)}`);
        },
      },
    );
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
        <Headline totalCards={plan.totalCards} categories={categories} />

        {/* The three answers a decklist cannot carry, above the tally they change: the game
            narrows the format, and the format is what decides whether there is a commander
            question at all. */}
        <div className="flex flex-wrap gap-3">
          <div className="min-w-40 flex-1">
            <label htmlFor={`${id}-name`} className="mb-1 block text-xs text-dim">
              Name
            </label>
            <input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={cn(
                "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm",
                "focus:border-accent focus:outline-none",
              )}
            />
          </div>
          {/* Before the format, because it narrows it — `DeckSettingsForm`'s ordering, for
              its reason. */}
          <div className="w-32">
            <GameSelect id={`${id}-game`} value={gameKey} onChange={setGameKey} />
          </div>
          <div className="w-48">
            <FormatSelect
              id={`${id}-format`}
              value={formatKey}
              onChange={setFormatKey}
              game={gameKey}
            />
          </div>
        </div>

        <Tally categories={categories} />
        <Commander plan={plan} picked={picked} onPick={setPicked} labelId={`${id}-commander`} />
        <ImportLabels labels={plan.labels} dropped={dropped} onToggle={toggle} />
        <Problems plan={plan} blameSync={blameSync} />
        {/* No mode radios: `merge` into a deck made one line ago is the only sensible mode —
            there is nothing to replace, and `merge` is the one that cannot clear anything if
            that ever stops being true. The box below stands where they would be, so the
            question sits in the same place on both deck arms. */}
        <OwnCopies
          checked={alsoOwn}
          onChange={setAlsoOwn}
          copies={owned.totalCards}
          id={`${id}-own`}
        />
      </div>

      <CommitBar
        label="Import"
        pendingLabel="Importing…"
        pending={importIntoNewDeck.isPending}
        disabled={items.length === 0 || nameMissing}
        message={
          importIntoNewDeck.error !== null
            ? `Could not import the list — ${ipcError(importIntoNewDeck.error)}`
            : nameMissing
              ? "Name the deck first."
              : ""
        }
        failed={importIntoNewDeck.error !== null}
        onBack={onBack}
      />
    </form>
  );
}
