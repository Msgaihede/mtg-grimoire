/**
 * The reader's labels, as things in themselves, with no deck open.
 *
 * A **label** is the deckbuilder's coloured per-card mark — `deck_labels`, `deck_cards.label_id`
 * — and it is neither of the two other things this app calls something similar: a *tag* is one of
 * Scryfall's tagger datasets and the collection's free-text `tags` column is a third thing again.
 * That vocabulary rule is why this panel is filed under **Appearance** and not under **Tags**;
 * `nav.ts` argues it at its own site.
 *
 * ## Why it is the deck dialog's second section and nothing else
 *
 * {@link LabelsDialog} draws two sections: the labels *this deck's list is wearing*, whose
 * destructive control is **Remove** (take it off these cards, leave the label standing), and
 * every other label, whose destructive control is **Delete** (app-wide, and it says how far it
 * reaches before it goes). Those are two different acts and that dialog's header explains at
 * length why conflating them would mean a reader tidying one deck stripping a label off nine
 * others.
 *
 * **Settings has no deck, so only the second act is available here** — there is no list on
 * screen to take a label off. What this panel inherits is therefore exactly that dialog's second
 * section: the add row first, one row per label, and Delete behind a question. The deck editor's
 * dialog is untouched and still draws both.
 *
 * The row grammar itself is `features/decks/metaRows.tsx`, shared rather than restated: a reader
 * who has renamed a label inside a deck should meet the same strip, the same two small words at
 * the right end, and the same ruled-off question here.
 *
 * ## What a label edited from here does not do
 *
 * It writes no deck history and no undo step. Both of those hang off a `deck_id`, and a rename
 * that reaches every deck wearing the label belongs to none of them — attributing it to one would
 * be a false entry and attributing it to all is a feature nobody asked for. The deck editor's own
 * dialog is unchanged and still records everything it always did. `deck_meta.rs`'s
 * `a_deckless_label_write_records_no_audit_and_no_undo` is the test that says so out loud.
 *
 * **The reader is told, and told at the one press where it costs them something.** A rename made
 * from here is recoverable by renaming it back; a delete is not, so the delete question carries
 * the sentence and nothing else on the panel repeats it. Without it the fact is discovered by
 * pressing Ctrl+Z in a deck and finding nothing.
 *
 * ## Two things this panel deliberately does not do
 *
 * **It passes no `subject` to the picker.** `LabelColorPicker`'s controls name themselves from
 * one string, and that string defaults to `"Label colour"` — which is not a stand-in here, it is
 * the honest name. `TheoryMarksPanel` passes one because a *mark* is not a label; this panel is
 * about labels, so the default is the answer.
 *
 * **It reaches `deck_label_all` itself rather than through `useDeckMeta`.** That hook is one read
 * of a deck's piles *and* the app's labels and gates every query on `deckId !== null`, so from
 * here it would answer nothing at all. What is shared instead is the **cache key** —
 * `["decks", "labelsAll"]`, character for character — so a reader who opens a deck's Labels
 * dialog after visiting this panel finds the list already there, and every write below
 * invalidates the same `["decks"]` root the deck's own writes do.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type JSX } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import {
  LabelColorButton,
  LabelColorPanel,
  LabelColorRow,
  LabelSwatch,
} from "@/features/decks/LabelColorPicker";
import {
  DEFAULT_LABEL_COLOR,
  labelColorCss,
  labelColorHex,
} from "@/features/decks/labelColors";
import { findLabelByName } from "@/features/decks/labelNames";
import {
  CONFIRM_CANCEL,
  CONFIRM_DESTRUCTIVE,
  META_FIELD,
  META_SUBMIT,
  RenameField,
  RowAction,
  sectionFailure,
  useConfirmFocus,
} from "@/features/decks/metaRows";
import { FOCUS } from "@/lib/focus";
import { ipc, type GlobalLabel, type LabelColor } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { PanelAlert, SettingsSection } from "./panelChrome";

/** A stable "not loaded yet", so a `useMemo` or a `.map` downstream is not handed a fresh array
 *  on every render of a panel that is still waiting. */
const NO_LABELS: readonly GlobalLabel[] = [];

export function LabelsPanel(): JSX.Element {
  const queryClient = useQueryClient();

  /**
   * Every label there is, most-used first — the only list that can answer a label no card is
   * wearing, which is most of what a reader comes here to tidy.
   *
   * **No `enabled` gate**, unlike `useDeckMeta`'s copy of this query: that one is gated on a deck
   * because the only surface wanting it was a dialog inside an editor, and this is the surface
   * that wants it with no deck at all.
   */
  const labelsQuery = useQuery({
    queryKey: ["decks", "labelsAll"],
    queryFn: () => ipc.deckLabelAll(),
  });
  const labels = labelsQuery.data ?? NO_LABELS;

  /**
   * The whole `["decks"]` root, on error as well as on success — `useDeckMeta`'s rule, and the
   * reason is the same at both sites. A label write changes what is drawn on cards in every deck,
   * and a refusal here is either a busy database or a label another surface has already deleted;
   * the second must not leave this list drawing a row that is gone.
   */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  };
  const writes = { onSuccess: invalidate, onError: invalidate };

  /** `null` is the deck, at all three writes: see the header. */
  const createLabel = useMutation({
    mutationFn: ({ name, color }: { name: string; color: LabelColor }) =>
      ipc.deckLabelCreate(null, name, color),
    ...writes,
  });
  const updateLabel = useMutation({
    mutationFn: ({ id, name, color }: { id: number; name: string; color: LabelColor }) =>
      ipc.deckLabelUpdate(null, id, name, color),
    ...writes,
  });
  const deleteLabel = useMutation({
    mutationFn: (id: number) => ipc.deckLabelDelete(null, id),
    ...writes,
  });

  const [name, setName] = useState("");
  const [color, setColor] = useState<LabelColor>(DEFAULT_LABEL_COLOR.hex);
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * Which row is renaming, which is being confirmed, and which has its picker open — three
   * single-tenant pieces of state rather than one per row, so opening something on a row below
   * closes the one above. A panel with three rows unfolded is a panel with no list left in it.
   *
   * The picker's state carries **the colour it is currently on** as well as the row, which is
   * what keeps a `useEffect` out of the row: opening seeds the draft from the label's own colour
   * and closing throws it away, so opening *is* the reset. It has to be a draft at all because
   * `input[type=color]` fires all the way down a drag through the OS dialog, and a row that wrote
   * on every change would send one `deck_label_update` per pixel of travel.
   */
  const [renaming, setRenaming] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [picking, setPicking] = useState<{ id: number; color: LabelColor } | null>(null);
  const nameId = useId();

  // A name any label already holds cannot be made a second time — the `UNIQUE INDEX` refuses it,
  // and a reader who has to press Add and wait to find that out was told nothing the app did not
  // already know. Compared on `labelNames.ts`' key, so `removal` is `Removal`.
  const clash = findLabelByName(labels, name);

  const failure = sectionFailure([createLabel, updateLabel, deleteLabel], labelsQuery);

  const rowState = (id: number) => ({
    renaming: renaming === id,
    onRename: () => {
      setRenaming(id);
      setConfirming(null);
      setPicking(null);
    },
    confirming: confirming === id,
    onConfirm: () => {
      setConfirming(id);
      setRenaming(null);
      setPicking(null);
    },
    draft: picking?.id === id ? picking.color : null,
    onDraft: (next: LabelColor) => setPicking({ id, color: next }),
    onPick: () => {
      setPicking((open) => (open?.id === id ? null : { id, color: colorOf(labels, id) }));
      setRenaming(null);
      setConfirming(null);
    },
    onDone: () => {
      setRenaming(null);
      setConfirming(null);
      setPicking(null);
    },
  });

  return (
    <SettingsSection id="labels" title="Labels">
      {/* **The fact nothing on this screen can show**, and the reason this panel is worth having:
          a label belongs to no deck, so the word and the colour a reader sets here are the word
          and the colour it has everywhere. The deck dialog says the same thing in its subtitle. */}
      <p className="text-sm text-dim">
        Every deck shares one list of labels, and a card carries at most one. Renaming or
        recolouring a label here changes it in every deck wearing it.
      </p>

      {/* Making one comes first, and this panel opens on it — `LabelsDialog`'s own rule, kept for
          its own reason: a reader with no labels is who this screen is hardest for, and the
          control that fixes that must not sit under the list they have not got. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed || clash !== undefined) return;
          createLabel.mutate(
            { name: trimmed, color },
            {
              onSuccess: () => {
                setName("");
                setPickerOpen(false);
              },
            },
          );
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <label htmlFor={nameId} className="sr-only">
          New label name
        </label>
        <input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New label name…"
          className={META_FIELD}
        />
        {/* **No `subject`**: the default is `"Label colour"`, which is exactly what this is. */}
        <LabelColorButton color={color} open={pickerOpen} onToggle={() => setPickerOpen((o) => !o)} />
        <button
          type="submit"
          disabled={createLabel.isPending || name.trim() === "" || clash !== undefined}
          className={META_SUBMIT}
        >
          Add label
        </button>
      </form>

      {clash !== undefined && (
        <p className="text-xs text-dim" role="status">
          “{clash.name}” already exists — every deck shares one list, so there is only ever one of
          a name.
        </p>
      )}

      {pickerOpen && <LabelColorPanel value={color} onChange={setColor} />}

      {/* Three states and three answers, never two. A read still in flight and a read that failed
          both leave an empty array behind, and neither is a reader with no labels — the sentence
          below is a claim about a table, so it is drawn only when something actually answered.
          The failure itself is the alert at the foot. */}
      {labelsQuery.isPending && <p className="text-sm text-dim">Reading your labels…</p>}

      {labelsQuery.isSuccess && labels.length === 0 && (
        <p className="text-sm text-dim">
          Labels are yours to invent — a colour and a word you put on a card in a deck, like{" "}
          <span className="text-text">Cut candidate</span> or{" "}
          <span className="text-text">Borrowed</span>. Name one above, then right-click a card in
          any deck to put it on.
        </p>
      )}

      {labels.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {labels.map((label) => (
            <LabelRow
              key={label.id}
              label={label}
              updatePending={updateLabel.isPending}
              deletePending={deleteLabel.isPending}
              onUpdate={(patch) => updateLabel.mutate(patch)}
              onDelete={(id, done) => deleteLabel.mutate(id, { onSuccess: done })}
              {...rowState(label.id)}
            />
          ))}
        </ul>
      )}

      {/* `problem`, because every refusal reachable here is something the reader pressed that did
          not happen — and the row is still on screen saying the old word, so the red line is the
          only thing between "refused" and "nothing was pressed". It carries the failed *read*
          too, which is what stops that case looking like a reader with no labels. */}
      <PanelAlert tone="problem">{failure}</PanelAlert>
    </SettingsSection>
  );
}

/** The colour a row is currently stored at, for seeding its picker's draft. The list is short
 *  and this runs on a press, so a `Map` would be ceremony. */
function colorOf(labels: readonly GlobalLabel[], id: number): LabelColor {
  return labels.find((l) => l.id === id)?.color ?? DEFAULT_LABEL_COLOR.hex;
}

/** Which of the row's three panels is open, and the callbacks that open and close them. */
interface RowState {
  renaming: boolean;
  onRename: () => void;
  confirming: boolean;
  onConfirm: () => void;
  /** The colour being tried while this row's picker is open, or `null` when it is shut. It is the
   *  panel's state rather than the row's — see `LabelsPanel`'s `picking` for why. */
  draft: LabelColor | null;
  onPick: () => void;
  onDraft: (color: LabelColor) => void;
  onDone: () => void;
}

/**
 * One label: the swatch that recolours it, its name, how far it reaches, and the two words that
 * rename and delete it.
 *
 * The reach is drawn **at rest** rather than only inside the delete question, because it is the
 * fact a reader with no deck open cannot get any other way — `unused` for a label nothing wears,
 * which is a row this list can answer and `deck_label_list` never can.
 */
function LabelRow({
  label,
  updatePending,
  deletePending,
  onUpdate,
  onDelete,
  renaming,
  onRename,
  confirming,
  onConfirm,
  draft,
  onPick,
  onDraft,
  onDone,
}: RowState & {
  label: GlobalLabel;
  updatePending: boolean;
  deletePending: boolean;
  onUpdate: (patch: { id: number; name: string; color: LabelColor }) => void;
  onDelete: (id: number, done: () => void) => void;
}) {
  const tip = useTooltip();
  const { deleteRef, owedFocusRef } = useDestructiveFocus(confirming);
  const picking = draft !== null;
  const shown = draft ?? label.color;

  return (
    <li className="rounded-md border border-border py-1.5 pl-2.5 pr-2">
      <div className="flex items-center gap-2.5">
        {/* The colour, and the way to change it — for every deck at once, which is what the
            paragraph at the top of the panel is for. */}
        <button
          type="button"
          onClick={onPick}
          aria-expanded={picking}
          aria-label={`Change colour of ${label.name}`}
          {...tip(`#${labelColorHex(shown)}`)}
          className={cn(
            "grid size-[1.125rem] shrink-0 place-items-center rounded border border-border",
            "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
            picking && "border-accent",
            FOCUS,
          )}
        >
          <LabelSwatch color={shown} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{label.name}</span>
        <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-dim">
          {reachOf(label)}
        </span>
        <RowAction onClick={onRename} disabled={renaming}>
          Rename
        </RowAction>
        <RowAction ref={deleteRef} onClick={onConfirm} disabled={confirming} destructive>
          Delete
        </RowAction>
      </div>

      {picking && (
        <LabelColorRow
          value={labelColorCss(draft)}
          onChange={onDraft}
          onDone={() => {
            // Both fields, always: `deck_label_update` renames **and** recolours in one command
            // and has no patch shape, so this half sends the name back unchanged. And nothing at
            // all when the colour did not move — Done is how the picker closes, so it is pressed
            // by readers who opened it to look.
            if (labelColorCss(draft) !== labelColorCss(label.color)) {
              onUpdate({ id: label.id, name: label.name, color: labelColorCss(draft) });
            }
            onDone();
          }}
        />
      )}

      {renaming && (
        <RenameField
          label={`Rename ${label.name}`}
          initial={label.name}
          pending={updatePending}
          // The colour's half of the same one-command write, sent back untouched: this field
          // renames and the swatch above recolours, and neither may quietly undo the other.
          onSave={(next) => {
            onUpdate({ id: label.id, name: next, color: label.color });
            onDone();
          }}
          onCancel={onDone}
        />
      )}

      {confirming && (
        <DeleteLabel
          label={label}
          pending={deletePending}
          onDelete={() => onDelete(label.id, onDone)}
          onCancel={() => {
            owedFocusRef.current = true;
            onDone();
          }}
        />
      )}
    </li>
  );
}

/**
 * How far this label goes, in the fewest words that are true.
 *
 * `unused` rather than `0 in 0 decks`, which is arithmetic about nothing — and it is the one row
 * a reader can delete without reading any further.
 */
function reachOf(label: GlobalLabel): string {
  if (label.deckCount === 0) return "unused";
  return `${label.cardCount} in ${label.deckCount} ${label.deckCount === 1 ? "deck" : "decks"}`;
}

/** `LabelsDialog`'s hand-back, at the sibling control and for the identical reason: cancelling a
 *  confirmation must put the caret back on the button that opened it, and that cannot happen
 *  until the render that re-enables the button. */
function useDestructiveFocus(confirming: boolean) {
  const deleteRef = useRef<HTMLButtonElement>(null);
  const owedFocusRef = useRef(false);
  useEffect(() => {
    if (confirming || !owedFocusRef.current) return;
    owedFocusRef.current = false;
    deleteRef.current?.focus();
  }, [confirming]);
  return { deleteRef, owedFocusRef };
}

/**
 * Delete a label from the whole app, and say the two things a reader cannot see from here.
 *
 * **How far it reaches.** A label is one app-wide row, so this press strips it off cards in every
 * deck wearing it — and unlike the deck editor's dialog, this panel is not standing inside any one
 * of them, so there is no list on screen from which the reach could be guessed.
 * {@link GlobalLabel.deckCount} is what makes the number sayable. Nothing is destroyed but the
 * label itself: `deck_cards.label_id` is `ON DELETE SET NULL`, so the cards stay where they are.
 *
 * **That it cannot be undone.** A deckless write records no `deck_audit` row and no `deck_undo`
 * step — see the header for why that was the right trade — so the deck editor's Ctrl+Z finds
 * nothing to put back. A reader who is not told here discovers it by pressing that chord in a
 * deck, which is the worst possible moment. It is its own paragraph rather than a clause, because
 * it is a fact about **where the press was made** and not about this label.
 */
function DeleteLabel({
  label,
  pending,
  onDelete,
  onCancel,
}: {
  label: GlobalLabel;
  pending: boolean;
  onDelete: () => void;
  onCancel: () => void;
}) {
  // The caret comes into the question rather than onto a button in it: the reader has not decided
  // yet, and a stray Enter must not decide for them.
  const confirm = useConfirmFocus(`Delete ${label.name}`);

  const decks = label.deckCount === 1 ? "1 deck" : `${label.deckCount} decks`;
  const wearing =
    label.cardCount === 1
      ? `Its 1 card, in ${decks}, stays where it is and loses the label.`
      : `Its ${label.cardCount} cards, across ${decks}, stay where they are and lose the label.`;

  return (
    <div {...confirm}>
      <p className="text-xs">Delete “{label.name}” everywhere?</p>
      <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
        {label.deckCount === 0 ? "No deck is using it." : wearing} This takes it out of your label
        list for good.
      </p>
      <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
        A label deleted from Settings cannot be undone — the change is written to no deck’s
        history, so Ctrl+Z in a deck will not bring it back.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={onDelete}
          className={CONFIRM_DESTRUCTIVE}
        >
          Delete label
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
          Keep it
        </button>
      </div>
    </div>
  );
}
