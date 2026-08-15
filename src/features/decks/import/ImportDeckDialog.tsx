import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import {
  ipcError,
  type DeckVariant,
  type ImportMatch,
  type ImportMode,
  type ImportOutcome,
  type ImportResolveLine,
} from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { dialog, scrim, statusLine } from "@/lib/motion";
import { trapTab } from "@/lib/trapTab";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useSync } from "@/lib/useSync";
import { cn } from "@/lib/utils";
import { FOCUS } from "../cardControl";
import { plural } from "../FolderTree";
import { DEFAULT_FORMAT, FormatSelect } from "../FormatSelect";
import { DEFAULT_VARIANT, useDeck } from "../useDeck";
import { useFormatSpecs } from "../useFormatSpecs";
import { parseDecklist } from "./parse";
import {
  buildImportPlan,
  tallyOf,
  toImportItems,
  type CategoryTally,
  type ImportPlan,
} from "./plan";
import { useDeckImport } from "./useDeckImport";

/** The extensions the picker offers. A decklist is text; the other three are what the desktop
 *  clients have always written it as (`.dec` MTGO, `.dek` Arena, `.csv` a spreadsheet export). */
const DECKLIST_EXTENSIONS = ["txt", "dec", "dek", "csv"];

/** Stable identity for "nothing chosen", so the memo below is not recomputed over a new empty
 *  array on every render. */
const NO_COMMANDERS: readonly string[] = [];

/** The one gold control on the surface, in both steps — the same shape `CreateDeckDialog`'s
 *  submit carries, at the width a footer button wants rather than a form's full width. */
const PRIMARY = cn(
  "h-9 shrink-0 rounded-md border border-accent px-4 text-sm text-accent",
  "transition-colors duration-[var(--duration-fast)] ease-standard",
  "hover:bg-accent hover:text-accent-foreground",
  "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-accent",
  "motion-reduce:transition-none",
);

/** `plural` says "categorys". A pile count is the one figure this surface prints that has an
 *  irregular plural, so it is spelled out rather than the helper being taught English. */
function categoryCount(n: number): string {
  return `${n} ${n === 1 ? "category" : "categories"}`;
}

/**
 * Where an import is going.
 *
 * Two arms, because the two entry points ask genuinely different questions and the difference
 * runs all the way through this surface. **The one that decides most is where the format spec
 * comes from**: a new deck is judged by the format the reader picks in this dialog, live, as
 * they change the select; an open deck is judged by its own `format_key`, which this dialog has
 * no business changing. Getting that backwards is a Commander deck that never asks for a
 * commander — a failure with nothing on screen to say it happened.
 */
export type ImportTarget =
  | { kind: "new" }
  | {
      kind: "deck";
      deckId: number;
      /** The list on screen. An import lands in one variant and clears at most one: a plan is
       *  never overwritten by a paste into the sleeved deck, and the other way round. */
      variant: DeckVariant;
      /** Copies in that variant right now — what a `replace` would clear, said before it does
       *  it. A count and not a flag, because "removes the 42 cards in Live first" is the whole
       *  of the warning. */
      cardsInVariant: number;
    };

export interface ImportDeckDialogProps {
  target: ImportTarget;
  /**
   * The format a **`new`** target starts on — the one the reader last created a deck in, else
   * Commander — and **ignored entirely for a `deck` target**, which is judged by the deck's own
   * `format_key` and has no select to seed.
   *
   * That is the whole reason it is optional: the editor mounts this dialog to paste into a deck
   * that already exists, so it has nothing to say here and passes nothing. The gallery, which
   * imports into a deck it is about to make, resolves the answer once for both of its create
   * surfaces and hands it down — see `DecksPage`. Absent, the panel falls back to
   * {@link DEFAULT_FORMAT}, which is what this select used to start on unconditionally.
   */
  defaultFormatKey?: string;
  /**
   * The pile every line of this paste lands in, whatever the filer would have said — a
   * right-click on a category heading and "Import cards…".
   *
   * **The override is applied in the planner and not here**, which is this folder's rule rather
   * than a preference: `plan.ts` makes every deck decision and this dialog makes none, so all
   * this prop does is reach `buildImportPlan`'s trailing argument. Absent — which is what the
   * toolbar's Import passes — the list is filed by what each card *does*, exactly as before.
   *
   * Only the editor has a pile to aim at. A `new` target would take one just as well
   * (`deck_import_commit` finds-or-creates a category by name), but the gallery has no heading
   * to right-click and passes nothing.
   */
  forcedCategoryName?: string;
  /**
   * **A mount, not a class**, exactly as `CreateDeckDialog`'s and `TheoryDiffDialog`'s are:
   * everything with state — the pasted text, the step, the commander picked, the caret — lives
   * one component down, so closing unmounts all of it and reopening starts a genuinely new
   * question rather than one somebody has to remember to clear.
   */
  open: boolean;
  /** Escape, the header's ✕ and the trigger pressed again: close and hand the caret back. */
  onDismiss: () => void;
  /** A press on the scrim: close without moving focus. The reader is already somewhere else. */
  onClose: () => void;
  /**
   * The import landed. The deck it landed in — the one this dialog made, for a `new` target —
   * and what it did, in the three numbers `ImportOutcome` carries.
   *
   * The caller closes the dialog; this does not, because what to do next differs by entry point
   * (the gallery opens the new deck, the editor is already showing it).
   */
  onImported: (deckId: number, outcome: ImportOutcome) => void;
}

/** Which half of the dialog is up. Two steps in one panel rather than two dialogs: the second
 *  is entirely about the first, and Back has to keep what was pasted. */
type Step = "source" | "preview";

/**
 * A decklist, from anywhere, into a deck.
 *
 * **Two steps and one panel.** The reader pastes or picks a file, presses Preview, and is shown
 * what the import would do *before* anything is written — which pile every card lands in, which
 * lines nothing answered, which printing was used where theirs could not be found, and who the
 * commander is going to be. Nothing is written until Import.
 *
 * **It decides nothing itself.** `parseDecklist` reads the text, `deck_import_resolve` answers
 * which printing each name means, `oracle_tags_for_printings` answers what those printings do,
 * and `buildImportPlan` makes every deck decision there is — the piles, the commander, the
 * tallies. This file draws that plan and sends it back through `toImportItems`. A second
 * opinion here about which pile a Sol Ring belongs in would be a second answer to a question
 * the app already answers in one place.
 *
 * **Both reads are one press and one mutation**, so the second step is never reached holding
 * half of what files a card — see `useDeckImport`'s `resolve`.
 *
 * **Opened from a category's right-click it is aimed at that pile**, and even that is not a
 * decision made here: {@link ImportDeckDialogProps.forcedCategoryName} is handed straight to
 * `buildImportPlan`, whose trailing argument is where a named pile beats the filer. This file
 * draws the difference (the header line says which pile) and decides none of it.
 *
 * **Not portalled, and `fixed` — so where it is mounted matters.** Nothing in this app is
 * portalled (the shipped CSP is `style-src 'self'` and every overlay primitive in reach injects
 * a runtime `<style>`). A `fixed` element is positioned against the viewport *unless* an
 * ancestor carries a `transform`, `filter` or `contain`, so this belongs at its host's top
 * level rather than inside a column or a row.
 *
 * **The Escape rung is registered up here, on the flag.** With an exit animation the panel
 * outlives `open` by the length of its fade, so a rung that came up with the *element* would
 * still be consuming Escape while the next layer was opening — and two `"inner"` peers are not
 * ordered by that protocol at all.
 */
export function ImportDeckDialog({
  target,
  defaultFormatKey = DEFAULT_FORMAT,
  forcedCategoryName,
  open,
  onDismiss,
  onClose,
  onImported,
}: ImportDeckDialogProps): JSX.Element {
  // `useCallback`, because `onDismiss` is a dependency of the hook's effect and an unstable one
  // re-registers the window listener on every render of the host view.
  const dismiss = useCallback(() => onDismiss(), [onDismiss]);
  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: open });

  return (
    <AnimatePresence>
      {open && (
        <Panel
          key="import-deck"
          target={target}
          defaultFormatKey={defaultFormatKey}
          forcedCategoryName={forcedCategoryName}
          onDismiss={onDismiss}
          onClose={onClose}
          onImported={onImported}
        />
      )}
    </AnimatePresence>
  );
}

/**
 * The dialog itself, mounted only while it is open — see {@link ImportDeckDialog}.
 *
 * `defaultFormatKey` is **not** optional in here: the wrapper above applies the fallback, so the
 * default is written in one place and this half is handed a key it can seed state with.
 */
function Panel({
  target,
  defaultFormatKey,
  forcedCategoryName,
  onDismiss,
  onClose,
  onImported,
}: Omit<ImportDeckDialogProps, "open" | "defaultFormatKey"> & { defaultFormatKey: string }) {
  const id = useId();
  /** False from the render that starts the fade out. */
  const present = useIsPresent();
  const listRef = useRef<HTMLTextAreaElement>(null);

  const [text, setText] = useState("");
  const [step, setStep] = useState<Step>("source");
  /**
   * What the reader typed into the name field, or `null` while they have typed nothing.
   *
   * Not an empty string, because the two mean different things here: a list exported from Arena
   * carries the deck's name and this field shows it until the reader disagrees. A plain `""`
   * initial value cannot tell "they have not typed" from "they cleared it".
   */
  const [typedName, setTypedName] = useState<string | null>(null);
  /** What the format select starts on for a `new` target, and dead state for a `deck` one —
   *  seeded at mount, so nothing can land on top of a format the reader has picked. */
  const [formatKey, setFormatKey] = useState(defaultFormatKey);
  const [mode, setMode] = useState<ImportMode>("merge");
  /** The commander the reader picked out of the candidates — plural, because a partner pair is
   *  two. Only ever read when the plan is asking. */
  const [picked, setPicked] = useState<readonly string[]>(NO_COMMANDERS);
  /** The picker itself could not be opened, which is a different failure from a file the
   *  backend could not read — and it belongs beside the button rather than in the footer. */
  const [pickerFailure, setPickerFailure] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const { resolve, commit, readFile, importIntoNewDeck } = useDeckImport();
  const { formatSpecFor } = useFormatSpecs();
  const { status } = useSync();

  /**
   * The deck being imported into, read for one field: its format.
   *
   * The whole hook rather than a mutation of its own, for `useSwapFromPane`'s reason — it is the
   * same `["decks", "detail", id, variant]` the editor beside this is already reading, and
   * TanStack shares a query's cache between observers, so with an editor open this costs no
   * `deck_get` at all. `useDeck(null)` asks for nothing, which is the `new` arm.
   */
  const into = useDeck(
    target.kind === "deck" ? target.deckId : null,
    target.kind === "deck" ? target.variant : DEFAULT_VARIANT,
  );

  const parsed = useMemo(() => parseDecklist(text), [text]);
  const name = typedName ?? parsed.suggestedName ?? "";
  const trimmedName = name.trim();

  // The format the plan is judged by — see {@link ImportTarget}. A key the seeded table has no
  // row for answers `null`, which `buildImportPlan` reads as "no command zone": the same answer
  // as a format that has none, and the only honest one when there are no rules to apply.
  const spec = formatSpecFor(
    target.kind === "new" ? formatKey : (into.deck?.formatKey ?? ""),
  );

  /**
   * The printings the list resolved to and what they do, from the one press that asked.
   *
   * **Both halves arrive together**, which is what keeps the piles on this step honest: the
   * plan is built once, from everything, rather than drawn by type line and re-filed when a
   * taxonomy answer turns up. See `useDeckImport`'s `resolve`.
   */
  const resolved = resolve.data ?? null;
  const plan = useMemo(
    () =>
      resolved === null
        ? null
        : buildImportPlan(parsed, resolved.rows, spec, resolved.tags, forcedCategoryName),
    [parsed, resolved, spec, forcedCategoryName],
  );

  // The caret starts in the box the reader has to fill, which is `CreateDeckDialog`'s rule and
  // this dialog's whole first step. A stray Enter in a textarea is a newline, not a submit.
  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * Which cards go into the Commander pile whatever the auto rule filed them under — the
   * command zone outranks a functional pile as squarely as it outranks `Creature`.
   *
   * `automatic` is the plan's own answer and is not offered as a choice: one eligible card is
   * not a guess. `ask` is the reader's. The other two contribute nothing — `fromFile` means the
   * list already filed one under a Commander heading, and `notApplicable` means there is no
   * command zone to file anything into.
   */
  const commanderIds =
    plan === null
      ? NO_COMMANDERS
      : plan.commander.kind === "automatic"
        ? plan.commander.cardIds
        : plan.commander.kind === "ask"
          ? picked
          : NO_COMMANDERS;

  const items = useMemo(
    () => (plan === null ? [] : toImportItems(plan, commanderIds)),
    [plan, commanderIds],
  );

  /**
   * The piles, counted over the items that are about to be sent and **not** over the plan.
   *
   * This is the whole of the tally fix: `commanderIds` is a dependency of `items`, so pressing
   * a candidate recomputes both, and the two numbers on this step describe what Import will
   * write rather than what the auto rule filed before anybody chose. See {@link tallyOf}
   * for what the old shape put on screen.
   */
  const categories = useMemo(() => tallyOf(items), [items]);

  /** Back to the box, and the resolved rows go with it. They are addressed by **index** into
   *  `parsed.lines`, so rows kept across an edit of the text would file the whole list by line
   *  numbers that have moved. */
  const toSource = () => {
    resolve.reset();
    commit.reset();
    importIntoNewDeck.reset();
    setStep("source");
  };

  const preview = () => {
    const lines: ImportResolveLine[] = parsed.lines.map((line) => ({
      name: line.name,
      setCode: line.setCode,
      collectorNumber: line.collectorNumber,
    }));
    resolve.mutate(lines, {
      onSuccess: () => {
        setPicked(NO_COMMANDERS);
        setStep("preview");
      },
    });
  };

  const runImport = () => {
    if (items.length === 0) return;
    if (target.kind === "deck") {
      commit.mutate(
        { deckId: target.deckId, variant: target.variant, mode, items },
        { onSuccess: (outcome) => onImported(target.deckId, outcome) },
      );
      return;
    }
    if (trimmedName === "") return;
    importIntoNewDeck.mutate(
      { name: trimmedName, formatKey, items },
      { onSuccess: ({ deck, outcome }) => onImported(deck.id, outcome) },
    );
  };

  const choose = async () => {
    setPickerFailure(null);
    readFile.reset();
    setPicking(true);
    try {
      // `dialog:allow-open` is the one dialog permission this app grants. The picker answers a
      // **path**; `deck_import_read_file` opens the file in Rust, which is why no `fs:`
      // permission is needed here either.
      const path = await pickFile({
        multiple: false,
        directory: false,
        title: "Choose a decklist",
        filters: [{ name: "Decklist", extensions: DECKLIST_EXTENSIONS }],
      });
      // A cancelled picker is not a failure — it is the most ordinary way to use a file dialog
      // after changing your mind.
      if (path !== null) {
        readFile.mutate(path, {
          onSuccess: (contents) => {
            setText(contents);
            // The file may name the deck; whatever the last one suggested is not this one's.
            setTypedName(null);
          },
        });
      }
    } catch (e) {
      setPickerFailure(ipcError(e));
    } finally {
      setPicking(false);
    }
  };

  const pending = commit.isPending || importIntoNewDeck.isPending;
  /** The **write's** refusal. The read's own failure has a place on the first step, where the
   *  button that asked for it is, and repeating it here would be one fault announced as two. */
  const failure = commit.error ?? importIntoNewDeck.error ?? null;
  const fileFailure =
    pickerFailure !== null
      ? `Could not open the file picker — ${pickerFailure}`
      : readFile.isError
        ? `Could not read that file — ${ipcError(readFile.error)}`
        : null;
  /** Nothing resolved, and the card database is still filling: the list is not the problem. */
  const blameSync =
    plan !== null &&
    plan.cards.length === 0 &&
    plan.unmatched.length > 0 &&
    status !== null &&
    (status.syncing || status.cardCount === 0);

  const nameMissing = target.kind === "new" && trimmedName === "";

  return (
    // Scrim and panel in one presence: the ground darkens first and the panel scales up over it,
    // and the dialog is unmounted only once the later of the two tweens has finished.
    //
    // `LAYER.overlay` is the rung every full-window surface in this app shares. The number is
    // deliberately not written out here, in prose or anywhere else: Tailwind's scanner reads a
    // comment as eagerly as it reads code, so naming the class in a sentence emits a rule for it
    // — and `layers.test.ts`' sweep counts that as a second place the scale is written.
    <motion.div
      {...scrim}
      className={cn(
        "fixed inset-0 flex items-center justify-center bg-bg/70 p-4",
        !present && "pointer-events-none",
        LAYER.overlay,
      )}
      // On the way out it is a picture: nothing to press, and nothing in the accessibility tree.
      // Focus left with the flag.
      aria-hidden={present ? undefined : true}
      // A press on the scrim and nowhere else. `onMouseDown` rather than `onClick`, because a
      // click fires on the nearest common ancestor of press and release — so a drag that starts
      // in the textarea and ends past the panel's edge is a "click" on the scrim, and the dialog
      // would vanish under a reader who was selecting the list they had just pasted.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        {...dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        // Labelled **by the heading**, not by an `aria-label` beside it: the words are on screen,
        // so there is nothing for a second copy to drift from.
        aria-labelledby={`${id}-title`}
        // The caret stays inside, which is what makes the `aria-modal` above true rather than
        // merely claimed — see {@link trapTab}.
        onKeyDown={trapTab}
        className={cn(
          "flex max-h-[85%] w-full max-w-2xl flex-col overflow-hidden rounded-xl border",
          "border-border bg-bg shadow-2xl",
          FOCUS,
        )}
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-title`} className="font-heading text-xl leading-none">
              Import a decklist
            </h2>
            {/* Where the cards are going, said on the step the reader is still pasting into —
                the tally on step two says it again, but by then they have committed to a
                preview. A forced pile leads the line because it is the new fact: this is the
                importer aimed at one column rather than at the deck. */}
            <p className="mt-1 truncate text-xs text-dim">
              {target.kind === "new"
                ? "Paste a list or choose a file, and it becomes a deck of its own."
                : [
                    forcedCategoryName === undefined
                      ? `Into ${into.deck?.name ?? "this deck"}`
                      : `Into ${forcedCategoryName} · ${into.deck?.name ?? "this deck"}`,
                    variantName(target.variant),
                  ].join(" · ")}
            </p>
          </div>
          <button
            type="button"
            // The ✕ is the reader saying "put me back", exactly as Escape is — so it hands the
            // caret over rather than dropping it where the dialog used to be.
            onClick={onDismiss}
            aria-label="Close"
            className={cn(
              "-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-dim",
              "transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text",
              "motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        {step === "source" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (parsed.lines.length > 0) preview();
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
              <div>
                <div className="mb-1 flex items-baseline gap-3">
                  <label htmlFor={`${id}-list`} className="flex-1 text-xs text-dim">
                    Decklist
                  </label>
                  <button
                    type="button"
                    onClick={() => void choose()}
                    // Both halves of the round trip — the picker being up and the file being
                    // read — because a second press does nothing useful in either. The label
                    // does not change: an action keeps its name through the whole flow.
                    disabled={picking || readFile.isPending}
                    className={cn(
                      "rounded-md border border-border px-2 py-0.5 text-[0.6875rem] text-dim",
                      "transition-colors duration-[var(--duration-fast)] ease-standard",
                      "hover:border-accent hover:text-accent",
                      "disabled:opacity-50 disabled:hover:border-border disabled:hover:text-dim",
                      "motion-reduce:transition-none",
                      FOCUS,
                    )}
                  >
                    Choose file…
                  </button>
                </div>
                <textarea
                  id={`${id}-list`}
                  ref={listRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={14}
                  spellCheck={false}
                  className={cn(
                    "w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5",
                    "font-mono text-xs leading-relaxed",
                    "focus:border-accent focus:outline-none",
                  )}
                />
                <p className="mt-1 text-[0.6875rem] text-dim">
                  One card a line, count first — <span className="font-mono">4 Lightning Bolt</span>
                  . Arena, Moxfield and MTGO exports read as they come, headings and all.
                </p>
                {/* The counts as they are typed, so the box says what it has read before the
                    reader commits to a preview. */}
                {text.trim() !== "" && (
                  <p className="mt-1 font-mono text-[0.6875rem] tabular-nums text-dim">
                    {plural(parsed.lines.length, "line")} · {plural(parsed.totalCards, "card")}
                    {parsed.issues.length > 0 && ` · ${plural(parsed.issues.length, "unreadable line")}`}
                  </p>
                )}
                <AnimatePresence initial={false}>
                  {fileFailure !== null && (
                    <motion.p
                      {...statusLine}
                      role="alert"
                      className="overflow-hidden text-[0.6875rem] text-destructive"
                    >
                      {fileFailure}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>

              {/* The two fields a new deck needs, under the box rather than over it: a list
                  exported from Arena names the deck, so the name is worth asking for *after*
                  there is something to read it out of. */}
              {target.kind === "new" && (
                <div className="flex flex-wrap gap-3">
                  <div className="min-w-40 flex-1">
                    <label htmlFor={`${id}-name`} className="mb-1 block text-xs text-dim">
                      Name
                    </label>
                    <input
                      id={`${id}-name`}
                      value={name}
                      onChange={(e) => setTypedName(e.target.value)}
                      className={cn(
                        "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm",
                        "focus:border-accent focus:outline-none",
                      )}
                    />
                  </div>
                  <div className="w-48">
                    <FormatSelect id={`${id}-format`} value={formatKey} onChange={setFormatKey} />
                  </div>
                </div>
              )}

              <AnimatePresence initial={false}>
                {resolve.isError && (
                  <motion.p
                    {...statusLine}
                    role="alert"
                    className="overflow-hidden text-xs text-destructive"
                  >
                    Could not look those cards up — {ipcError(resolve.error)}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>

            <footer className="flex items-center justify-end gap-3 border-t border-border px-5 py-3.5">
              <button
                type="submit"
                disabled={parsed.lines.length === 0 || resolve.isPending}
                className={cn(PRIMARY, FOCUS)}
              >
                {resolve.isPending ? "Reading…" : "Preview"}
              </button>
            </footer>
          </form>
        ) : (
          plan !== null && (
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
                <Commander
                  plan={plan}
                  picked={picked}
                  onPick={setPicked}
                  labelId={`${id}-commander`}
                />
                <Problems plan={plan} blameSync={blameSync} />
                {target.kind === "deck" && (
                  <Mode
                    value={mode}
                    onChange={setMode}
                    name={`${id}-mode`}
                    variant={target.variant}
                    cardsInVariant={target.cardsInVariant}
                  />
                )}
              </div>

              <footer className="flex items-center gap-3 border-t border-border px-5 py-3.5">
                <button
                  type="button"
                  onClick={toSource}
                  className={cn(
                    "h-9 shrink-0 rounded-md border border-border px-3 text-sm text-dim",
                    "transition-colors duration-[var(--duration-fast)] ease-standard",
                    "hover:text-text motion-reduce:transition-none",
                    FOCUS,
                  )}
                >
                  Back
                </button>

                {/* One live region for every answer this step gives — the refusal, and the one
                    reason the button can be dark that the reader cannot see from here. Rendered
                    always, so the region is in the tree before it has anything to say: a live
                    region mounted together with its own text announces nothing. `status` and
                    not `alert`, which is `TheoryDiffDialog`'s arrangement for the same slot. */}
                <p
                  role="status"
                  aria-live="polite"
                  className={cn(
                    "min-w-0 flex-1 text-right text-xs",
                    failure !== null ? "text-destructive" : "text-dim",
                  )}
                >
                  {failure !== null
                    ? `Could not import the list — ${ipcError(failure)}`
                    : nameMissing
                      ? "Go back and name the deck first."
                      : ""}
                </p>

                <button
                  type="submit"
                  disabled={pending || items.length === 0 || nameMissing}
                  className={cn(PRIMARY, FOCUS)}
                >
                  {pending ? "Importing…" : "Import"}
                </button>
              </footer>
            </form>
          )
        )}
      </motion.div>
    </motion.div>
  );
}

/** The variant as a reader names it. Two words, and both of them are in the editor's own
 *  switch — so the sentence about what a `replace` clears uses the label they pressed. */
function variantName(variant: DeckVariant): string {
  return variant === "live" ? "Live" : "Theory";
}

/**
 * What the import comes to, in one line: copies first, because that is what a reader counts.
 *
 * Both numbers are handed in rather than read off the plan, because the pile count moves with
 * the commander choice and the copy count does not — see the `categories` memo above.
 */
function Headline({
  totalCards,
  categories,
}: {
  totalCards: number;
  categories: readonly CategoryTally[];
}) {
  return (
    <p className="font-mono text-sm tabular-nums">
      {plural(totalCards, "card")}
      <span className="text-dim"> · {categoryCount(categories.length)}</span>
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
function Tally({ categories }: { categories: readonly CategoryTally[] }) {
  if (categories.length === 0) return null;
  return (
    <dl className="divide-y divide-border rounded-md border border-border">
      {categories.map((category) => (
        <div key={category.name} className="flex items-baseline gap-3 px-3 py-1.5">
          <dt className="min-w-0 flex-1 truncate text-sm">
            {category.name}
            {category.inactive && <span className="ml-2 text-[0.6875rem] text-dim">(inactive)</span>}
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
function Commander({
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
    onPick(
      picked.includes(cardId) ? picked.filter((id) => id !== cardId) : [...picked, cardId],
    );

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
            {plural(candidates.length, "card")} here could be the commander. Pick one — or two,
            for a partner pair — or leave it for later.
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
function Problems({ plan, blameSync }: { plan: ImportPlan; blameSync: boolean }) {
  if (blameSync) {
    return (
      // A plain paragraph and not a live region: it is drawn together with the step it belongs
      // to, and a live region mounted with its own text inside it announces nothing anyway.
      <p className="text-sm text-dim">
        Card data is still syncing, so nothing in this list can be matched yet. Wait for the sync
        to finish and preview again.
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
          lines={plan.unmatched.map(
            (line) => `line ${line.lineNumber} · "${line.raw.trim()}"`,
          )}
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
function ProblemList({ caption, lines }: { caption: string; lines: string[] }) {
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
