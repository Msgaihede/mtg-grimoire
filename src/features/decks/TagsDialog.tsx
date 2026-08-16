/**
 * The deck's labels, as things in themselves — a centred dialog over the editor.
 *
 * A label is a thing a reader made, and this is where it is made, renamed and taken away.
 * {@link CategoriesDialog} is the same idea one floor up: a category says *where in the deck* a
 * card lives and the rules read it, a tag says what the reader thinks of the card and no rule
 * has heard of it. They were one drawer with two sections until they became two dialogs off the
 * same toolbar, which is why the shape of a row here is the shape of a row there — see
 * `metaRows.tsx`, which is the whole of what the two share besides a `useDeckMeta`.
 *
 * ## The rule this dialog has to say out loud
 *
 * It is not guessable from the controls, so it is printed beside them rather than left to a
 * tooltip: **tags belong to this deck; the suggestions come from every deck.**
 * `deck_tag_suggestions` is the one command in the deck surface that takes no deck id at all —
 * a name typed into a fifth deck is offered in the sixth, and picking one makes a tag *of this
 * deck* rather than sharing anything.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { FOCUS } from "@/lib/focus";
import { type DeckTag, type DeckVariant, type TagColor } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { DeckDialog } from "./DeckDialog";
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
import { DEFAULT_TAG_COLOR, TAG_COLORS, tagColorCss } from "./tagColors";
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

/**
 * The chrome is {@link DeckDialog}'s and the body below is this file's.
 *
 * **The body is a separate component and that is not tidiness**: a closed {@link DeckDialog}
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
    <DeckDialog
      open={open}
      title="Tags"
      closeLabel="Close tags"
      width="w-[36rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <TagsBody deckId={deckId} variant={variant} />
    </DeckDialog>
  );
}

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
 */
function TagsBody({ deckId, variant }: { deckId: number; variant: DeckVariant }) {
  const meta = useDeckMeta(deckId, variant);
  const { tags, tagsQuery, suggestions } = meta;
  const [renaming, setRenaming] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>(DEFAULT_TAG_COLOR.token);

  // A suggestion this deck already has is not an offer — it is the row above it.
  const taken = useMemo(() => new Set(tags.map((t) => t.name)), [tags]);
  const offers = useMemo(() => suggestions.filter((s) => !taken.has(s.name)), [suggestions, taken]);

  const failure = sectionFailure([meta.createTag, meta.updateTag, meta.deleteTag], tagsQuery);

  return (
    // The body's own scroller, with its own padding: the shell owns the header and stops there,
    // because the deck's dialogs do not agree about what goes inside one.
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4">
      {/* No heading of its own — the dialog is titled "Tags" one element up, and a second "Tags"
          under it would be the same word twice with nothing between them. */}
      <p className="mb-2.5 text-[0.6875rem] leading-relaxed text-dim">
        Tags belong to this deck, and a card carries at most one. The suggestions below come from
        every deck you have — picking one makes a tag of that name here. Deleting a tag keeps its
        cards and takes the label off them.
      </p>

      {tagsQuery.isPending ? (
        <p className="text-xs text-dim">Reading this deck’s tags…</p>
      ) : tags.length === 0 ? (
        <p className="text-xs text-dim">No tags yet.</p>
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
              onRename={() => setRenaming(tag.id)}
              confirming={confirming === tag.id}
              onConfirm={() => setConfirming(tag.id)}
              onDone={() => {
                setRenaming(null);
                setConfirming(null);
              }}
            />
          ))}
        </ul>
      )}

      {/* Not on the design canvas, and here because the canvas's own answer only works for a
          reader who already has decks: with no other deck there are no suggestions, and without
          this field the very first tag could never be made. It is the categories dialog's add
          field wearing the same clothes — literally, now that both spell it `META_FIELD` — plus
          the one thing a tag has that a category does not. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          meta.createTag.mutate({ name: trimmed, color }, { onSuccess: () => setName("") });
        }}
        className="mt-2.5 flex flex-wrap items-center gap-2"
      >
        <label htmlFor="new-tag-name" className="sr-only">
          New tag name
        </label>
        <input
          id="new-tag-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New tag name…"
          className={META_FIELD}
        />
        <ColorPicker value={color} onChange={setColor} />
        <button
          type="submit"
          disabled={meta.createTag.isPending || name.trim() === ""}
          className={META_SUBMIT}
        >
          Add tag
        </button>
      </form>

      <p className="mb-1.5 mt-3 text-[0.6875rem] text-dim">Suggested from your other decks</p>
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
              <Swatch color={s.color} />
              {s.name}
            </button>
          ))}
        </div>
      )}

      {failure && (
        <p className="mt-2 text-[0.6875rem] text-destructive" role="alert">
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
  onDone: () => void;
}) {
  const [color, setColor] = useState<TagColor>(tag.color);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const owedFocus = useRef(false);

  // `CategoryRow`'s hand-back — in `CategoriesDialog.tsx` — on the sibling control and for the
  // identical reason.
  useEffect(() => {
    if (confirming || !owedFocus.current) return;
    owedFocus.current = false;
    deleteRef.current?.focus();
  }, [confirming]);

  return (
    <li className="rounded-md border border-border px-2 py-1.5">
      <div className="flex items-center gap-2.5">
        <Swatch color={tag.color} />
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

      {renaming && (
        <RenameField
          label={`Rename ${tag.name}`}
          initial={tag.name}
          pending={meta.updateTag.isPending}
          // Both fields, always: `deck_tag_update` renames **and** recolours in one command and
          // has no patch shape, so a caller changing one sends the other back unchanged.
          extra={<ColorPicker value={color} onChange={setColor} />}
          onSave={(next) =>
            meta.updateTag.mutate({ id: tag.id, name: next, color }, { onSuccess: onDone })
          }
          onCancel={() => {
            setColor(tag.color);
            onDone();
          }}
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

/** A tag's colour, 9px square — the same scale as a rarity gem, which is what keeps the
 *  direction's colour budget on the card art where it belongs. `aria-hidden`: the colour is
 *  never the only carrier of anything, and the name is right beside it. */
function Swatch({ color }: { color: TagColor }) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: tagColorCss(color) }}
      className="size-2.5 shrink-0 rounded-[2px]"
    />
  );
}

/** The palette, as the picker offers it. Buttons rather than radios: `aria-pressed` is the
 *  shape every other toggle in the app takes, and a stored colour is a **token name** — never
 *  a hex string, which would outlive the theme that chose it. */
function ColorPicker({
  value,
  onChange,
}: {
  value: TagColor;
  onChange: (color: TagColor) => void;
}) {
  return (
    <div role="group" aria-label="Tag colour" className="flex shrink-0 gap-1">
      {TAG_COLORS.map((c) => (
        <button
          key={c.token}
          type="button"
          aria-pressed={value === c.token}
          aria-label={c.label}
          title={c.label}
          onClick={() => onChange(c.token)}
          style={{ backgroundColor: c.css }}
          className={cn(
            "size-5 rounded-[3px] border",
            "transition-colors duration-150 motion-reduce:transition-none",
            value === c.token ? "border-accent" : "border-transparent hover:border-border",
            FOCUS,
          )}
        />
      ))}
    </div>
  );
}
