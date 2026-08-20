/**
 * The deck as a destination: what the second step of the dialog draws when the cards are going
 * into a deck that already exists, and everything that decides it.
 *
 * **Everything here used to be the import dialog's own second half**, and the split is the whole
 * of Task 12: the shell keeps the pasted text, the file picker, the one `import_resolve` call and
 * the step machine, because those are the same whatever the cards are going into; the variant,
 * the commander choice, the mode and the commit are facts about a *deck* and belong to the
 * destination that writes one.
 *
 * **It decides nothing itself.** `buildImportPlan` beside this file makes every deck decision
 * there is — the piles, the commander, the tallies — and this draws that plan and sends it back
 * through `toImportItems`. A second opinion here about which pile a Sol Ring belongs in would be
 * a second answer to a question the app already answers in one place.
 */
import { useId, useMemo, useState, type JSX } from "react";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import {
  ipcError,
  type DeckVariant,
  type ImportMatch,
  type ImportMode,
  type ImportOutcome,
} from "@/lib/ipc";
import { useSync } from "@/lib/useSync";
import { cn } from "@/lib/utils";
import { useDeck } from "@/features/decks/useDeck";
import { useFormatSpecs } from "@/features/decks/useFormatSpecs";
import type { DestinationPreviewProps, ImportDestination } from "../destination";
import { useImport } from "../useImport";
import { CommitBar } from "../shared/CommitBar";
import {
  buildImportPlan,
  tallyOf,
  toImportItems,
  type CategoryTally,
  type ImportPlan,
} from "./deck";

/** Stable identity for "nothing chosen", so the memo below is not recomputed over a new empty
 *  array on every render. */
export const NO_COMMANDERS: readonly string[] = [];

/**
 * The two facts about a deck that no parsed list can carry, and the one thing a host may want
 * back — closed over at the call site rather than threaded through the shell.
 *
 * This is the reason {@link ImportDestination} is not generic: a shell holding four destinations
 * must not know that one of them needs a deck id, so the deck's identity is bound where it is
 * known and the shell sees a `Preview` taking {@link DestinationPreviewProps} and nothing else.
 */
export interface DeckImportInto {
  deckId: number;
  /** The list on screen. An import lands in one variant and clears at most one: a plan is never
   *  overwritten by a paste into the sleeved deck, and the other way round. */
  variant: DeckVariant;
  /** Copies in that variant right now — what a `replace` would clear, said before it does it. A
   *  count and not a flag, because "removes the 42 cards in Live first" is the whole of the
   *  warning. */
  cardsInVariant: number;
  /**
   * The pile every line of this paste lands in, whatever the filer would have said — a
   * right-click on a category heading and "Import cards…".
   *
   * **The override is applied in the planner and not here**, which is this folder's rule rather
   * than a preference: `deck.ts` makes every deck decision and this file makes none, so all this
   * prop does is reach `buildImportPlan`'s trailing argument. Absent — which is what the
   * toolbar's Import passes — the list is filed by what each card *does*, exactly as before.
   *
   * Only the editor has a pile to aim at. `NewDeckPreview` would take one just as well
   * (`deck_import_commit` finds-or-creates a category by name), but the gallery has no heading
   * to right-click and passes nothing.
   */
  forcedCategoryName?: string;
  /**
   * The import landed: which deck, and what it did in the three numbers `ImportOutcome` carries.
   *
   * Optional, because it is the *host's* consequence rather than the dialog's — the gallery opens
   * the deck a list became, and the editor is already showing the one it wrote into and passes
   * nothing. Closing is `onDone`'s, on {@link DestinationPreviewProps}, and happens either way.
   */
  onImported?: (deckId: number, outcome: ImportOutcome) => void;
}

/**
 * A parsed list, into the deck that is open.
 *
 * `plan` is rebuilt from the format the *deck* carries — never from a format picked in this
 * dialog, which is `NewDeckPreview`'s arm and the one difference that runs all the way through
 * both surfaces. Getting it backwards is a Commander deck that never asks for a commander, a
 * failure with nothing on screen to say it happened.
 */
export function DeckPreview({
  list,
  resolved,
  tags,
  onDone,
  onBack,
  deckId,
  variant,
  cardsInVariant,
  forcedCategoryName,
  onImported,
}: DestinationPreviewProps & DeckImportInto): JSX.Element {
  const id = useId();
  const [mode, setMode] = useState<ImportMode>("merge");
  /** The commander the reader picked out of the candidates — plural, because a partner pair is
   *  two. Only ever read when the plan is asking. */
  const [picked, setPicked] = useState<readonly string[]>(NO_COMMANDERS);

  const { commit } = useImport();
  const { formatSpecFor } = useFormatSpecs();

  /**
   * The deck being imported into, read for one field: its format.
   *
   * The whole hook rather than a mutation of its own, for `useSwapFromPane`'s reason — it is the
   * same `["decks", "detail", id, variant]` the editor beside this is already reading, and
   * TanStack shares a query's cache between observers, so with an editor open this costs no
   * `deck_get` at all.
   */
  const into = useDeck(deckId, variant);

  // A key the seeded table has no row for answers `null`, which `buildImportPlan` reads as "no
  // command zone": the same answer as a format that has none, and the only honest one when there
  // are no rules to apply.
  const spec = formatSpecFor(into.deck?.formatKey ?? "");

  const plan = useMemo(
    () => buildImportPlan(list, resolved, spec, tags, forcedCategoryName),
    [list, resolved, spec, tags, forcedCategoryName],
  );

  const commanderIds = commanderIdsOf(plan, picked);
  const items = useMemo(() => toImportItems(plan, commanderIds), [plan, commanderIds]);
  /**
   * The piles, counted over the items that are about to be sent and **not** over the plan.
   *
   * This is the whole of the tally fix: `commanderIds` is a dependency of `items`, so pressing a
   * candidate recomputes both, and the two numbers on this step describe what Import will write
   * rather than what the auto rule filed before anybody chose. See {@link tallyOf} for what the
   * old shape put on screen.
   */
  const categories = useMemo(() => tallyOf(items), [items]);
  const blameSync = useBlameSync(plan);

  const runImport = () => {
    if (items.length === 0) return;
    commit.mutate(
      { deckId, variant, mode, items },
      {
        onSuccess: (outcome) => {
          onImported?.(deckId, outcome);
          onDone(reportOf(outcome));
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
        <Tally categories={categories} />
        <Commander plan={plan} picked={picked} onPick={setPicked} labelId={`${id}-commander`} />
        <Problems plan={plan} blameSync={blameSync} />
        <Mode
          value={mode}
          onChange={setMode}
          name={`${id}-mode`}
          variant={variant}
          cardsInVariant={cardsInVariant}
        />
      </div>

      <CommitBar
        label="Import"
        pendingLabel="Importing…"
        pending={commit.isPending}
        disabled={items.length === 0}
        message={
          // The **write's** refusal. The read's own failure has a place on the first step, where
          // the button that asked for it is, and repeating it here would be one fault announced
          // as two.
          commit.error === null ? "" : `Could not import the list — ${ipcError(commit.error)}`
        }
        failed={commit.error !== null}
        onBack={onBack}
      />
    </form>
  );
}

/**
 * The deck as a destination, with its own identity closed over.
 *
 * **A function and not a value**, and that is the one place this file departs from the shape the
 * other three destinations have. `DeckPreview` needs a deck id, and a `deckDestination` constant
 * whose `Preview` were `DeckPreview` behind a cast would be a value that type-checks everywhere
 * and crashes wherever anybody mounted it without the wrapper. So the wrapper *is* the
 * destination, and there is no unbound one to mount by mistake.
 *
 * Call it inside a `useMemo` keyed on what it closes over: the returned `Preview` is a component
 * identity, and a new one on every render would remount the preview and lose the reader's
 * commander choice mid-step.
 */
export function deckDestination(into: DeckImportInto): ImportDestination {
  return {
    key: "deck",
    label: "this deck",
    Preview: (props) => <DeckPreview {...props} {...into} />,
  };
}

/**
 * Where the cards are going, on the step the reader is still pasting into — the tally on step two
 * says it again, but by then they have committed to a preview.
 *
 * **A component and not a string, because it reads the deck.** The name comes from `useDeck`, and
 * a subtitle computed by the host would mount that read for a dialog nobody has opened — the
 * exact property `Dialog` exists to give. Rendered as an element, the shell mounts it inside its
 * own `open &&` and it costs a `deck_get` only while the dialog is up; with the editor open
 * behind it that is no round trip at all, since TanStack shares a query's cache between observers
 * and {@link DeckPreview} is already reading the same key.
 *
 * A forced pile leads the line because it is the new fact: this is the importer aimed at one
 * column rather than at the deck.
 */
export function DeckImportSubtitle({
  deckId,
  variant,
  forcedCategoryName,
}: {
  deckId: number;
  variant: DeckVariant;
  forcedCategoryName?: string;
}): JSX.Element {
  const into = useDeck(deckId, variant);
  const deckName = into.deck?.name ?? "this deck";
  return (
    <>
      {[
        forcedCategoryName === undefined
          ? `Into ${deckName}`
          : `Into ${forcedCategoryName} · ${deckName}`,
        variantName(variant),
      ].join(" · ")}
    </>
  );
}

/**
 * Which cards go into the Commander pile whatever the auto rule filed them under — the command
 * zone outranks a functional pile as squarely as it outranks `Creature`.
 *
 * `automatic` is the plan's own answer and is not offered as a choice: one eligible card is not a
 * guess. `ask` is the reader's. The other two contribute nothing — `fromFile` means the list
 * already filed one under a Commander heading, and `notApplicable` means there is no command zone
 * to file anything into.
 */
export function commanderIdsOf(plan: ImportPlan, picked: readonly string[]): readonly string[] {
  if (plan.commander.kind === "automatic") return plan.commander.cardIds;
  if (plan.commander.kind === "ask") return picked;
  return NO_COMMANDERS;
}

/** Nothing resolved, and the card database is still filling: the list is not the problem. A
 *  hundred lines of "no such card" during the opening sync is a hundred accusations of a reader
 *  who did nothing wrong. */
export function useBlameSync(plan: ImportPlan): boolean {
  const { status } = useSync();
  return (
    plan.cards.length === 0 &&
    plan.unmatched.length > 0 &&
    status !== null &&
    (status.syncing || status.cardCount === 0)
  );
}

/** What the shell reports back to its host. The dialog's own numbers are on screen; this is the
 *  one sentence a surface with a status line can print after it closes. */
export function reportOf(outcome: ImportOutcome): string {
  return `${plural(outcome.added, "card")} imported.`;
}

/** The variant as a reader names it. Two words, and both of them are in the editor's own
 *  switch — so the sentence about what a `replace` clears uses the label they pressed. */
export function variantName(variant: DeckVariant): string {
  return variant === "live" ? "Live" : "Theory";
}

/**
 * What the import comes to, in one line: copies first, because that is what a reader counts.
 *
 * Both numbers are handed in rather than read off the plan, because the pile count moves with
 * the commander choice and the copy count does not — see the `categories` memo above.
 */
export function Headline({
  totalCards,
  categories,
}: {
  totalCards: number;
  categories: readonly CategoryTally[];
}): JSX.Element {
  return (
    <p className="font-mono text-sm tabular-nums">
      {plural(totalCards, "card")}
      <span className="text-dim"> · {plural(categories.length, "category", "categories")}</span>
    </p>
  );
}

/**
 * The piles, with a copy count each — a decklist's own header, in the order a deck seeds and
 * then files its categories.
 *
 * A `<dl>` and not a div soup: each row is a name and the number belonging to it, which is what
 * a description list is. `(inactive)` is drawn on the pile that counts toward nothing — the
 * Maybeboard as seeded — because "these cards will land somewhere that counts toward nothing"
 * is worth saying before the import rather than after it.
 *
 * It is handed the tally rather than the plan, which is what makes the Commander pile appear
 * the moment a candidate is pressed.
 */
export function Tally({ categories }: { categories: readonly CategoryTally[] }) {
  if (categories.length === 0) return null;
  return (
    <dl className="divide-y divide-border rounded-md border border-border">
      {categories.map((category) => (
        <div key={category.name} className="flex items-baseline gap-3 px-3 py-1.5">
          <dt className="min-w-0 flex-1 truncate text-sm">
            {category.name}
            {category.inactive && (
              <span className="ml-2 text-[0.6875rem] text-dim">(inactive)</span>
            )}
          </dt>
          <dd className="shrink-0 font-mono text-xs tabular-nums text-dim">{category.cards}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Who is going in the command zone.
 *
 * Four outcomes and this draws three of them, because two of the four have nothing to say: the
 * list already named one under a heading (`fromFile`), or the format has no command zone at all
 * (`notApplicable`). The plan decides which; nothing here re-derives eligibility, so a card
 * offered as a candidate is exactly a card the editor's validation panel would accept.
 *
 * **Multi-select, because partners are two commanders.** Nothing pairs by itself — a pairing is
 * a choice and `validateCommanderZone` judges it once the deck exists — so this offers the
 * choice and refuses none of it.
 */
export function Commander({
  plan,
  picked,
  onPick,
  labelId,
}: {
  plan: ImportPlan;
  picked: readonly string[];
  onPick: (ids: readonly string[]) => void;
  labelId: string;
}) {
  if (plan.commander.kind === "fromFile" || plan.commander.kind === "notApplicable") return null;

  if (plan.commander.kind === "automatic") {
    const chosen = plan.commander.cardIds
      .map((cardId) => plan.cards.find((card) => card.match.cardId === cardId)?.match.name)
      .filter((name): name is string => name !== undefined);
    return (
      <section aria-labelledby={labelId} className="space-y-1">
        <h3 id={labelId} className="text-xs text-dim">
          Commander
        </h3>
        {/* One eligible card is not a guess, so this states the choice rather than asking it. */}
        <p className="text-sm">{chosen.join(" and ")} goes in the command zone.</p>
      </section>
    );
  }

  const candidates = plan.commander.candidates;
  const toggle = (cardId: string) =>
    onPick(picked.includes(cardId) ? picked.filter((id) => id !== cardId) : [...picked, cardId]);

  return (
    <section aria-labelledby={labelId} className="space-y-1.5">
      <h3 id={labelId} className="text-xs text-dim">
        Commander
      </h3>
      {candidates.length === 0 ? (
        <p className="text-sm text-dim">
          Nothing in this list can be this format’s commander. The deck imports without one.
        </p>
      ) : (
        <>
          <p className="text-[0.6875rem] text-dim">
            {plural(candidates.length, "card")} here could be the commander. Pick one — or two, for
            a partner pair — or leave it for later.
          </p>
          {/* Scrolled rather than wrapped: the reference list offers dozens of legendary
              creatures, and a cloud of chips at that count is a wall no name can be found in. */}
          <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {candidates.map((candidate) => (
              <li key={candidate.cardId}>
                <CandidateButton
                  candidate={candidate}
                  pressed={picked.includes(candidate.cardId)}
                  onClick={() => toggle(candidate.cardId)}
                />
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => onPick(NO_COMMANDERS)}
            // The way out, and it says what it is rather than being the absence of a press:
            // confirming a commander deck with no commander is a thing people do halfway
            // through building one.
            aria-pressed={picked.length === 0}
            className={cn(
              "rounded-md border px-2 py-0.5 text-[0.6875rem]",
              "transition-colors duration-[var(--duration-fast)] ease-standard",
              "motion-reduce:transition-none",
              picked.length === 0
                ? "border-accent text-accent"
                : "border-border text-dim hover:text-text",
              FOCUS,
            )}
          >
            No commander
          </button>
        </>
      )}
    </section>
  );
}

/** One candidate: the card, and the printing the list resolved to. A whole row is the target,
 *  because a name is what the reader is aiming at and a checkbox beside it is a smaller one. */
function CandidateButton({
  candidate,
  pressed,
  onClick,
}: {
  candidate: ImportMatch;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={cn(
        "flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-sm",
        "transition-colors duration-[var(--duration-fast)] ease-standard",
        "motion-reduce:transition-none",
        pressed ? "text-accent" : "text-text hover:bg-surface",
        FOCUS,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
      <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-dim">
        {candidate.setCode.toUpperCase()} · {candidate.collectorNumber}
      </span>
    </button>
  );
}

/**
 * Everything the import will not do, quoted back with the line it came from.
 *
 * Three lists and not one, because they are three different things to do something about: a name
 * nothing bears is usually a typo, a printing that could not be found is a card that still
 * imports as a different printing, and a line the parser could not read is a line nobody has
 * looked at. Every one carries its number, so the reader can find it in the box behind Back.
 *
 * **`blameSync` replaces the first list entirely.** A hundred lines of "no such card" during the
 * opening sync is a hundred accusations of a reader who did nothing wrong.
 */
export function Problems({ plan, blameSync }: { plan: ImportPlan; blameSync: boolean }) {
  if (blameSync) {
    return (
      // A plain paragraph and not a live region: it is drawn together with the step it belongs
      // to, and a live region mounted with its own text inside it announces nothing anyway.
      <p className="text-sm text-dim">
        Card data is still syncing, so nothing in this list can be matched yet. Wait for the sync to
        finish and preview again.
      </p>
    );
  }

  const nothing =
    plan.unmatched.length === 0 && plan.hintMisses.length === 0 && plan.parseIssues.length === 0;
  if (nothing) return null;

  return (
    <div className="space-y-3">
      {plan.unmatched.length > 0 && (
        <ProblemList
          caption={`${plural(plan.unmatched.length, "line")} named a card this app has not got`}
          lines={plan.unmatched.map((line) => `line ${line.lineNumber} · "${line.raw.trim()}"`)}
        />
      )}
      {plan.hintMisses.length > 0 && (
        <ProblemList
          caption={`${plural(plan.hintMisses.length, "printing")} could not be found, so another was used`}
          lines={plan.hintMisses.map(
            (miss) => `line ${miss.lineNumber} · ${miss.name} — used ${miss.used} instead`,
          )}
        />
      )}
      {plan.parseIssues.length > 0 && (
        <ProblemList
          caption={`${plural(plan.parseIssues.length, "line")} could not be read`}
          lines={plan.parseIssues.map(
            (issue) => `line ${issue.lineNumber} · "${issue.raw.trim()}" — ${issue.reason}`,
          )}
        />
      )}
    </div>
  );
}

/** One captioned list of quoted lines. Capped in height rather than in count: a hundred misses
 *  are a hundred things the reader may want to read, and hiding the tail behind "and 87 more"
 *  would hide exactly the ones they have not seen. */
export function ProblemList({ caption, lines }: { caption: string; lines: string[] }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-dim">{caption}</p>
      <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border px-3 py-1.5">
        {lines.map((line) => (
          <li key={line} className="truncate font-mono text-[0.6875rem] text-dim">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Merge or replace, and only ever for a deck that already exists.
 *
 * A radio group rather than a switch, because the two are not on and off: one adds and one
 * clears first, and the clearing one has to say what it would clear before it is chosen. It
 * clears **one variant** — the reason `variant` is in the deck-card grain at all — so the
 * sentence names the list on screen rather than "the deck".
 */
function Mode({
  value,
  onChange,
  name,
  variant,
  cardsInVariant,
}: {
  value: ImportMode;
  onChange: (mode: ImportMode) => void;
  name: string;
  variant: DeckVariant;
  cardsInVariant: number;
}) {
  const where = variantName(variant);
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-xs text-dim">What this does to {where}</legend>
      <label className="flex items-baseline gap-2 text-sm">
        <input
          type="radio"
          name={name}
          value="merge"
          checked={value === "merge"}
          onChange={() => onChange("merge")}
          className="accent-accent"
        />
        Merge — adds these cards to what is already there
      </label>
      <label className="flex items-baseline gap-2 text-sm">
        <input
          type="radio"
          name={name}
          value="replace"
          checked={value === "replace"}
          onChange={() => onChange("replace")}
          className="accent-accent"
        />
        {cardsInVariant === 0
          ? `Replace — there is nothing in ${where} to remove`
          : `Replace — removes the ${plural(cardsInVariant, "card")} in ${where} first`}
      </label>
    </fieldset>
  );
}
