/**
 * The deck's labels, as things in themselves — a centred dialog over the editor.
 *
 * A label is a thing a reader made, and this is where it is made, renamed, recoloured and taken
 * away. {@link CategoriesDialog} is the same idea one floor up: a category says *where in the
 * deck* a card lives and the rules read it, a tag says what the reader thinks of the card and no
 * rule has heard of it. They were one drawer with two sections until they became two dialogs off
 * the same toolbar, which is why the shape of a row here is the shape of a row there — see
 * `metaRows.tsx`, which is the whole of what the two share besides a `useDeckMeta`.
 *
 * ## What the redesign of 2026-08-20 moved, and why
 *
 * **The making of a tag went to the top.** The field used to sit under the list, after a
 * four-line paragraph — so the first thing a reader with no tags met was a rule about a thing
 * they did not have yet, and the control that would give them one was below the fold of the
 * explanation. The dialog now opens on the act: name it, colour it, add it.
 *
 * **The paragraph became a subtitle and two section headings.** It said three things — a card
 * carries at most one, deleting a tag keeps its cards, and the suggestions come from every deck.
 * The first two are the header's line, because they are true of the whole dialog. The third was
 * never a paragraph's job: it is what the section is *called*, "Suggestions from your other
 * decks", said where the chips are and nowhere else.
 *
 * **The colour left the rename.** A tag's colour used to be reachable only by pressing Rename,
 * which asked a reader who wanted a different red to open the control for changing the word. The
 * swatch is the control now: it is where the colour already is, and pressing it opens the picker
 * under the row. `deck_tag_update` still renames *and* recolours in one command with no patch
 * shape, so each half sends the other back unchanged — the rename sends `tag.color`, the picker
 * sends `tag.name`.
 *
 * ## The rule this dialog has to say out loud
 *
 * It is not guessable from the controls: **tags belong to this deck; the suggestions come from
 * every deck.** `deck_tag_suggestions` is the one command in the deck surface that takes no deck
 * id at all — a name typed into a fifth deck is offered in the sixth, and picking one makes a tag
 * *of this deck* rather than sharing anything.
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { type DeckTag, type DeckVariant, type TagColor } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/focus";
import { Dialog } from "@/components/Dialog";
import {
  CONFIRM_CANCEL,
  CONFIRM_DESTRUCTIVE,
  META_FIELD,
  META_SUBMIT,
  RenameField,
  RowAction,
  sectionFailure,
  useConfirmFocus,
} from "./metaRows";
import { TagColorButton, TagColorPanel, TagColorRow, TagSwatch } from "./TagColorPicker";
import { DEFAULT_TAG_COLOR, tagColorCss, tagColorHex } from "./tagColors";
import { useDeckMeta, type DeckMeta } from "./useDeckMeta";

export interface TagsDialogProps {
  deckId: number;
  /** Scopes the count on each row, and nothing else: which tags a deck has is a fact about the
   *  deck rather than about one of its two lists. */
  variant: DeckVariant;
  open: boolean;
  /** Escape, and the ✕: hand focus back to whatever opened the dialog, then close. */
  onDismiss: () => void;
  /** Outside click: close without moving focus — the reader is already somewhere else. */
  onClose: () => void;
}

/** The heading's line, and the two facts that are true of the whole dialog rather than of one
 *  control in it. */
export const TAGS_SUBTITLE = "A card carries at most one. Deleting a tag keeps its cards.";

/**
 * The chrome is {@link Dialog}'s and the body below is this file's.
 *
 * **The body is a separate component and that is not tidiness**: a closed {@link Dialog}
 * mounts no children at all, so the queries belong one floor down where they only exist while
 * the dialog is up. A closed dialog therefore costs nothing — no `deck_tag_list`, no
 * `deck_tag_suggestions` — which is what makes it safe for the editor to mount this
 * unconditionally beside five others. The Escape rung is the shell's, registered on the flag for
 * the reason its own doc gives.
 *
 * `36rem` against the categories dialog's 48: a row here is a swatch, a name, a count and two
 * text buttons, with no `GroupHeader` and no money in it, so the extra twelve would be a column
 * of empty.
 */
export function TagsDialog({
  deckId,
  variant,
  open,
  onDismiss,
  onClose,
}: TagsDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      title="Tags"
      subtitle={TAGS_SUBTITLE}
      closeLabel="Close tags"
      width="w-[36rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <TagsBody deckId={deckId} variant={variant} />
    </Dialog>
  );
}

/** Both section headings — the two the paragraph turned into. Uppercase and tracked, which is
 *  the one place in this dialog a word is not a sentence. */
const SECTION = "mb-1.5 text-[0.6875rem] uppercase tracking-[0.04em] text-dim";

/**
 * **This body reads no marketplace and no deck, and both absences are deliberate.** A tag
 * carries a name, a colour and a count and never a price, so there is no currency for this
 * dialog to be wrong about; and the deck's card rows are the auto-filer's argument, which is
 * `CategoriesDialog`'s control. Reaching for either would be this screen paying for a fact it
 * does not draw — `TagsDialog.test.tsx` asserts the `deck_get` half rather than trusting it.
 *
 * **`useDeckMeta` is one hook over a deck's piles *and* its labels, so it reads the category
 * list here too** — and takes a marketplace of its own to key that read by. That is the price of
 * the two dialogs sharing a hook rather than each growing one, and it is cheap on purpose: the
 * editor opens at most one of them, so the pair costs one set of reads however the reader
 * arrives. Nothing in this file touches either answer.
 *
 * **Three pieces of "which row is open", not one per row.** Renaming, deleting and recolouring
 * are each a single-tenant state here, so opening any of them on a second row closes the first —
 * a dialog with three rows unfolded is a dialog with no list left in it.
 */
function TagsBody({ deckId, variant }: { deckId: number; variant: DeckVariant }) {
  const meta = useDeckMeta(deckId, variant);
  const { tags, tagsQuery, suggestions } = meta;
  const [renaming, setRenaming] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  /**
   * Which row's picker is open **and the colour it is currently on** — one piece of state, not
   * two, and the pairing is what keeps a `useEffect` out of the row.
   *
   * The colour has to be a draft, because `input[type=color]` fires all the way down a drag
   * through the OS dialog and a row writing on every change would be a `deck_tag_update` per
   * pixel of travel. A draft held in the *row* would then have to be reset when the picker
   * closed — a piece of state derived from another piece of state, which is an effect and a
   * cascade. Held here, opening **is** the reset: the press seeds the draft from the row's own
   * colour, and closing throws it away.
   */
  const [picking, setPicking] = useState<{ id: number; color: TagColor } | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>(DEFAULT_TAG_COLOR.hex);
  const [pickerOpen, setPickerOpen] = useState(false);
  const nameId = useId();

  // A suggestion this deck already has is not an offer — it is the row above it.
  const taken = useMemo(() => new Set(tags.map((t) => t.name)), [tags]);
  const offers = useMemo(() => suggestions.filter((s) => !taken.has(s.name)), [suggestions, taken]);

  const failure = sectionFailure([meta.createTag, meta.updateTag, meta.deleteTag], tagsQuery);

  return (
    // The body's own scroller, with its own padding: the shell owns the header and stops there,
    // because the deck's dialogs do not agree about what goes inside one.
    <div className="flex min-h-0 flex-1 flex-col gap-[1.125rem] overflow-y-auto px-5 pb-6 pt-4">
      {/* Making one comes first, and the dialog opens on it. A reader with no tags is the reader
          this screen is hardest for, and the field that fixes that used to be under the list and
          under the paragraph explaining what a tag was. */}
      <section>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            meta.createTag.mutate(
              { name: trimmed, color },
              {
                onSuccess: () => {
                  setName("");
                  setPickerOpen(false);
                },
              },
            );
          }}
          className="flex items-center gap-2"
        >
          <label htmlFor={nameId} className="sr-only">
            New tag name
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New tag name…"
            className={META_FIELD}
          />
          <TagColorButton
            color={color}
            open={pickerOpen}
            onToggle={() => setPickerOpen((o) => !o)}
          />
          <button
            type="submit"
            disabled={meta.createTag.isPending || name.trim() === ""}
            className={META_SUBMIT}
          >
            Add tag
          </button>
        </form>
        {pickerOpen && (
          <div className="mt-2">
            <TagColorPanel value={color} onChange={setColor} />
          </div>
        )}
      </section>

      <section>
        <p className={SECTION}>Tags from this deck</p>
        {tagsQuery.isPending ? (
          <p className="text-xs text-dim">Reading this deck’s tags…</p>
        ) : tags.length === 0 ? (
          <p className="text-xs text-dim">No tags yet — name one above and give it a colour.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {tags.map((tag) => (
              <TagRow
                key={tag.id}
                tag={tag}
                // Both lists, for the confirmation only — the row above it keeps the scoped
                // count. See `DeleteTag`.
                cardsAllVariants={meta.tagCardCountsAllVariants?.get(tag.id) ?? null}
                meta={meta}
                renaming={renaming === tag.id}
                onRename={() => {
                  setRenaming(tag.id);
                  setConfirming(null);
                  setPicking(null);
                }}
                confirming={confirming === tag.id}
                onConfirm={() => {
                  setConfirming(tag.id);
                  setRenaming(null);
                  setPicking(null);
                }}
                draft={picking?.id === tag.id ? picking.color : null}
                onPick={() => {
                  setPicking((p) => (p?.id === tag.id ? null : { id: tag.id, color: tag.color }));
                  setRenaming(null);
                  setConfirming(null);
                }}
                onDraft={(color) => setPicking({ id: tag.id, color })}
                onDone={() => {
                  setRenaming(null);
                  setConfirming(null);
                  setPicking(null);
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {/* The rule that is not guessable from the controls, said as the name of the section it is
          about rather than as a paragraph above three others. */}
      <section>
        <p className={SECTION}>Suggestions from your other decks</p>
        {offers.length === 0 ? (
          <p className="text-[0.6875rem] text-dim">
            Nothing yet — tags you use in other decks are offered here.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {offers.map((s) => (
              <button
                key={`${s.name}-${s.color}`}
                type="button"
                disabled={meta.createTag.isPending}
                onClick={() => meta.createTag.mutate({ name: s.name, color: s.color })}
                aria-label={`Add tag ${s.name}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-xl border border-dashed border-border",
                  "px-2 py-0.5 text-[0.6875rem] text-dim",
                  "transition-colors duration-150 hover:border-accent hover:text-accent",
                  "disabled:opacity-50 motion-reduce:transition-none",
                  FOCUS,
                )}
              >
                <TagSwatch color={s.color} />
                {s.name}
              </button>
            ))}
          </div>
        )}
      </section>

      {failure && (
        <p className="text-[0.6875rem] text-destructive" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

function TagRow({
  tag,
  cardsAllVariants,
  meta,
  renaming,
  onRename,
  confirming,
  onConfirm,
  draft,
  onPick,
  onDraft,
  onDone,
}: {
  tag: DeckTag;
  /** Copies wearing this tag in **both** lists, or `null` while the other one is still being
   *  read. Only the confirmation uses it. */
  cardsAllVariants: number | null;
  meta: DeckMeta;
  renaming: boolean;
  onRename: () => void;
  confirming: boolean;
  onConfirm: () => void;
  /** The colour being tried while this row's picker is open, or `null` when it is shut. It is
   *  the dialog's state rather than the row's — see `TagsBody`'s `picking` for why. */
  draft: TagColor | null;
  onPick: () => void;
  onDraft: (color: TagColor) => void;
  onDone: () => void;
}) {
  const tip = useTooltip();
  const deleteRef = useRef<HTMLButtonElement>(null);
  const owedFocus = useRef(false);

  // `CategoryRow`'s hand-back — in `CategoriesDialog.tsx` — on the sibling control and for the
  // identical reason.
  useEffect(() => {
    if (confirming || !owedFocus.current) return;
    owedFocus.current = false;
    deleteRef.current?.focus();
  }, [confirming]);

  const picking = draft !== null;
  const shown = draft ?? tag.color;

  return (
    <li className="rounded-md border border-border py-1.5 pl-2.5 pr-2">
      <div className="flex items-center gap-2.5">
        {/* The colour, and the way to change it. It was a plain `aria-hidden` dot until the
            redesign, which left recolouring reachable only through Rename. */}
        <button
          type="button"
          onClick={onPick}
          aria-expanded={picking}
          aria-label={`Change colour of ${tag.name}`}
          {...tip(`#${tagColorHex(shown)}`)}
          className={cn(
            "grid size-[1.125rem] shrink-0 place-items-center rounded border border-border",
            "transition-colors duration-150 hover:border-accent motion-reduce:transition-none",
            picking && "border-accent",
            FOCUS,
          )}
        >
          <TagSwatch color={shown} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{tag.name}</span>
        {/* The list on screen, and right to be: this row is the list the reader is editing.
            Only the confirmation below changes scope — see `DeleteTag`. */}
        <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-dim">
          {tag.cardCount} {tag.cardCount === 1 ? "card" : "cards"}
        </span>
        <RowAction onClick={onRename} disabled={renaming}>
          Rename
        </RowAction>
        <RowAction ref={deleteRef} onClick={onConfirm} disabled={confirming} destructive>
          Delete
        </RowAction>
      </div>

      {picking && (
        <TagColorRow
          value={tagColorCss(draft)}
          onChange={onDraft}
          onDone={() => {
            // Both fields, always: `deck_tag_update` renames **and** recolours in one command
            // and has no patch shape, so this half sends the name back unchanged. And nothing
            // at all when the colour did not move — Done is how the panel closes, so it is
            // pressed by readers who opened it to look.
            if (tagColorCss(draft) !== tagColorCss(tag.color)) {
              meta.updateTag.mutate({ id: tag.id, name: tag.name, color: tagColorCss(draft) });
            }
            onDone();
          }}
        />
      )}

      {renaming && (
        <RenameField
          label={`Rename ${tag.name}`}
          initial={tag.name}
          pending={meta.updateTag.isPending}
          // The colour's half of the same one-command write, sent back untouched: this field
          // renames and the swatch above recolours, and neither may quietly undo the other.
          onSave={(next) =>
            meta.updateTag.mutate({ id: tag.id, name: next, color: tag.color }, { onSuccess: onDone })
          }
          onCancel={onDone}
        />
      )}

      {confirming && (
        <DeleteTag
          tag={tag}
          cardsAllVariants={cardsAllVariants}
          meta={meta}
          onCancel={() => {
            owedFocus.current = true;
            onDone();
          }}
          onDeleted={onDone}
        />
      )}
    </li>
  );
}

/**
 * Delete a label, and say how many cards lose it.
 *
 * **The number is both lists, never {@link DeckTag.cardCount}** — the same correction
 * `DeleteCategory` carries in `CategoriesDialog.tsx`, for the same reason one floor up:
 * `deck_cards.tag_id` is `ON DELETE SET NULL`, and a tag is not per-variant, so the label comes
 * off the theory rows wearing it as surely as off the live ones. Viewing Live, a tag worn by 2
 * live and 5 theory rows used to say "Its 2 cards stay in the deck and lose the label" — and,
 * worse, a tag worn by nothing on screen and five cards off it said flatly **"No card is wearing
 * it."** A confirmation is the one place a reader is entitled to the whole reach of the press.
 *
 * Where the category gets its total from a backend column (`cardCountAllVariants`), this gets
 * it from a second `deck_tag_list` — see {@link useDeckMeta}. That read can be in flight, which
 * is what the `null` arm is: no number, and the sentence still names both lists, because
 * "unknown" must never be spelled as the smaller of the two.
 *
 * Nothing is destroyed here, so there is no picker and no choice — a tag delete has one
 * outcome, and the whole of the dialog is saying what it is.
 */
function DeleteTag({
  tag,
  cardsAllVariants,
  meta,
  onCancel,
  onDeleted,
}: {
  tag: DeckTag;
  cardsAllVariants: number | null;
  meta: DeckMeta;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  // The caret comes into the question, for `DeleteCategory`'s reason.
  const confirm = useConfirmFocus(`Delete ${tag.name}`);

  /** Copies in the list the reader is **not** looking at. `> 0` is exactly the condition for
   *  mentioning the other list: a deck whose theory list wears this label nowhere has one list
   *  to talk about, and a sentence about two would be chrome. */
  const elsewhere = cardsAllVariants === null ? 0 : cardsAllVariants - tag.cardCount;
  const bothLists =
    elsewhere > 0 ? " — that is both the live and theory lists, not just the one on screen" : "";
  const wearing =
    cardsAllVariants === 1
      ? "Its 1 card stays in the deck and loses the label"
      : `Its ${cardsAllVariants} cards stay in the deck and lose the label`;

  return (
    <div {...confirm}>
      <p className="text-xs">Delete “{tag.name}”?</p>
      <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
        {cardsAllVariants === null
          ? "Every card wearing it stays in the deck and loses the label, in the live list and the theory list alike."
          : cardsAllVariants === 0
            ? "No card in either list is wearing it."
            : `${wearing}${bothLists}.`}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={meta.deleteTag.isPending}
          onClick={() => meta.deleteTag.mutate(tag.id, { onSuccess: onDeleted })}
          className={CONFIRM_DESTRUCTIVE}
        >
          Delete tag
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
          Keep it
        </button>
      </div>
    </div>
  );
}
