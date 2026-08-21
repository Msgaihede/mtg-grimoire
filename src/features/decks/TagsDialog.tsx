/**
 * The reader's labels, as things in themselves — a centred dialog over the editor.
 *
 * A label is a thing a reader made, and this is where it is made, renamed, recoloured, taken
 * off a deck and taken away. {@link CategoriesDialog} is the same idea one floor up, and the
 * two have drifted apart in exactly one way that matters: a category says *where in the deck* a
 * card lives and belongs to that deck, a tag says what the reader thinks of a card and belongs
 * to nobody's deck at all. That is why the shape of a row here is still `metaRows.tsx`' and the
 * *sections* are not.
 *
 * ## What schema v21 moved, and why
 *
 * **A tag is one app-wide row.** `Cut candidate` in four decks was four rows, four colours and
 * four things to rename; it is one row now, so recolouring it here recolours it in all four,
 * and no second tag can take a name one already holds. Both halves of that are the issue this
 * dialog was rebuilt for.
 *
 * **So "this deck's tags" became a fact about the cards.** There is no deck on a tag row to
 * filter by. What a deck has is a list of cards, some of which wear a label — so the first
 * section is the tags *this list is wearing*, derived from exactly the same read the right-click
 * menu offers, and the second is every other tag there is. A tag made here and worn by nothing
 * yet lands in the second section, which is honest: it is a label the reader owns and no deck's.
 *
 * **`variant` scopes membership, not just the counts.** The live list and the theory list are
 * treated as different decks where labels are concerned, so switching the editor between them
 * changes which tags are in the first section. That is the issue's own request, and it is why
 * the heading names the list rather than the deck.
 *
 * ## The two destructive acts, and why they are not one control
 *
 * They used to be. While a tag belonged to a deck, "I am done with this label here" and "this
 * label should stop existing" were the same press, and Delete meant both at once. They are
 * different acts now and conflating them would mean a reader tidying one deck stripping a
 * label off nine others without being asked.
 *
 * So: a row **in this list** offers *Remove*, which untags this deck's cards in the list on
 * screen and leaves the tag standing. A row in **every other tag** offers *Delete*, which is
 * app-wide and says how far it reaches before it goes. A tag in use here that the reader wants
 * gone everywhere is removed first and then deleted — two presses, and the second one is never
 * one click away from the deck they are editing, which is a property worth the extra step.
 *
 * ## What stayed
 *
 * The add row is still first, because a reader with no tags is who this screen is hardest for.
 * The colour is still the swatch rather than something behind Rename, and the picker still
 * holds a draft with Done as the write — `input[type=color]` fires all the way down a drag
 * through the OS dialog, so a row writing on every change would be a `deck_tag_update` per
 * pixel of travel. `deck_tag_update` still renames **and** recolours in one command with no
 * patch shape, so each half sends the other back unchanged.
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { type DeckTag, type DeckVariant, type GlobalTag, type TagColor } from "@/lib/ipc";
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
import { findTagByName } from "./tagNames";
import { useDeckMeta, type DeckMeta } from "./useDeckMeta";

export interface TagsDialogProps {
  deckId: number;
  /** Which list the first section is about — **membership as well as counts**, since a tag
   *  belongs to no deck and the two lists are treated as separate decks where labels are
   *  concerned. */
  variant: DeckVariant;
  open: boolean;
  /** Escape, and the ✕: hand focus back to whatever opened the dialog, then close. */
  onDismiss: () => void;
  /** Outside click: close without moving focus — the reader is already somewhere else. */
  onClose: () => void;
}

/** The heading's line, and the two facts that are true of the whole dialog rather than of one
 *  control in it. The second is the one nothing on screen can show: a tag is shared, so the
 *  colour a reader picks here is the colour it has in every deck. */
export const TAGS_SUBTITLE = "A card carries at most one. Tags are shared by all your decks.";

/**
 * The chrome is {@link Dialog}'s and the body below is this file's.
 *
 * **The body is a separate component and that is not tidiness**: a closed {@link Dialog}
 * mounts no children at all, so the queries belong one floor down where they only exist while
 * the dialog is up. A closed dialog therefore costs nothing — no `deck_tag_list`, no
 * `deck_tag_all` — which is what makes it safe for the editor to mount this unconditionally
 * beside five others. The Escape rung is the shell's, registered on the flag for the reason its
 * own doc gives.
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

/** Both section headings. Uppercase and tracked, which is the one place in this dialog a word
 *  is not a sentence. */
const SECTION = "mb-1.5 text-[0.6875rem] uppercase tracking-[0.04em] text-dim";

/** What the first section's heading calls the list on screen. The word is the reader's own —
 *  the editor's Live/Theory switch says exactly these two. */
const LIST_NAME: Record<DeckVariant, string> = { live: "live", theory: "theory" };

/**
 * **This body reads no marketplace and no deck, and both absences are deliberate.** A tag
 * carries a name, a colour and a count and never a price, so there is no currency for this
 * dialog to be wrong about; and the deck's card rows are the auto-filer's argument, which is
 * `CategoriesDialog`'s control. Reaching for either would be this screen paying for a fact it
 * does not draw — `TagsDialog.test.tsx` asserts the `deck_get` half rather than trusting it.
 *
 * **`useDeckMeta` is one hook over a deck's piles *and* the app's labels, so it reads the
 * category list here too** — and takes a marketplace of its own to key that read by. That is
 * the price of the two dialogs sharing a hook rather than each growing one, and it is cheap on
 * purpose: the editor opens at most one of them, so the pair costs one set of reads however the
 * reader arrives. Nothing in this file touches either answer.
 *
 * **Three pieces of "which row is open", not one per row.** Renaming, confirming and
 * recolouring are each a single-tenant state here, and they are shared across *both* sections
 * so that opening one on a row below closes the one above — a dialog with three rows unfolded
 * is a dialog with no list left in it.
 */
function TagsBody({ deckId, variant }: { deckId: number; variant: DeckVariant }) {
  const meta = useDeckMeta(deckId, variant);
  const { tags, tagsQuery, allTags, allTagsQuery } = meta;
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

  /** Ids this list is wearing — what splits the app-wide list into the dialog's two sections. */
  const worn = useMemo(() => new Set(tags.map((t) => t.id)), [tags]);
  const others = useMemo(() => allTags.filter((t) => !worn.has(t.id)), [allTags, worn]);
  /** The full row for a tag in the first section, for the counts the deck-scoped row has not
   *  got: how far a rename or a delete reaches. `undefined` while the app-wide read is still
   *  in flight, which every consumer of it treats as "no number" rather than as zero. */
  const globalById = useMemo(() => new Map(allTags.map((t) => [t.id, t])), [allTags]);

  // A name any tag already holds cannot be made a second time — the backend refuses it, and a
  // reader who has to press Add and wait to find that out was told nothing the app did not
  // already know. Compared on `tagNames.ts`' key, so `removal` is `Removal`.
  const clash = findTagByName(allTags, name);

  const failure = sectionFailure(
    [meta.createTag, meta.updateTag, meta.removeTagFromDeck, meta.deleteTag],
    tagsQuery,
    allTagsQuery,
  );

  const rowProps = (id: number) => ({
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
    onDraft: (next: TagColor) => setPicking({ id, color: next }),
    onDone: () => {
      setRenaming(null);
      setConfirming(null);
      setPicking(null);
    },
  });

  const onPickFor = (tag: { id: number; color: TagColor }) => () => {
    setPicking((p) => (p?.id === tag.id ? null : { id: tag.id, color: tag.color }));
    setRenaming(null);
    setConfirming(null);
  };

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
            if (!trimmed || clash !== undefined) return;
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
            disabled={meta.createTag.isPending || name.trim() === "" || clash !== undefined}
            className={META_SUBMIT}
          >
            Add tag
          </button>
        </form>
        {clash !== undefined && (
          <p className="mt-1.5 text-[0.6875rem] text-dim" role="status">
            “{clash.name}” already exists — every deck shares one list, so there is only ever one
            of a name.
          </p>
        )}
        {pickerOpen && (
          <div className="mt-2">
            <TagColorPanel value={color} onChange={setColor} />
          </div>
        )}
      </section>

      <section>
        <p className={SECTION}>On cards in this {LIST_NAME[variant]} list</p>
        {tagsQuery.isPending ? (
          <p className="text-xs text-dim">Reading this deck’s tags…</p>
        ) : tags.length === 0 ? (
          <p className="text-xs text-dim">
            Nothing in this list is tagged yet — right-click a card to put a label on it.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {tags.map((tag) => (
              <TagRow
                key={tag.id}
                tag={tag}
                global={globalById.get(tag.id)}
                meta={meta}
                variant={variant}
                {...rowProps(tag.id)}
                onPick={onPickFor(tag)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* The rule that is not guessable from the controls, said as the name of the section it is
          about rather than as a paragraph above three others. */}
      <section>
        <p className={SECTION}>Your other tags</p>
        {allTagsQuery.isPending ? (
          <p className="text-xs text-dim">Reading your tags…</p>
        ) : others.length === 0 ? (
          <p className="text-[0.6875rem] text-dim">
            {allTags.length === 0
              ? "None yet — name one above, then right-click a card to put it on."
              : "Every tag you have is on a card in this list."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {others.map((tag) => (
              <OtherTagRow
                key={tag.id}
                tag={tag}
                meta={meta}
                {...rowProps(tag.id)}
                onPick={onPickFor(tag)}
              />
            ))}
          </ul>
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

/** Everything a row of either section shares — the swatch's draft, and which of the three
 *  single-tenant panels is open on it. */
interface RowState {
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
}

/** The swatch, the name and the picker — the half of a row that is the same in both sections,
 *  because recolouring and renaming are app-wide wherever the row is drawn. */
function TagShell({
  tag,
  meta,
  trailing,
  children,
  renaming,
  onRename,
  confirming,
  onConfirm,
  confirmLabel,
  draft,
  onPick,
  onDraft,
  onDone,
  deleteRef,
}: RowState & {
  tag: { id: number; name: string; color: TagColor };
  meta: DeckMeta;
  /** The count, drawn between the name and the two buttons. */
  trailing: JSX.Element;
  /** The row's confirmation, mounted only while it is open. */
  children: JSX.Element | false;
  confirmLabel: string;
  deleteRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const tip = useTooltip();
  const picking = draft !== null;
  const shown = draft ?? tag.color;

  return (
    <li className="rounded-md border border-border py-1.5 pl-2.5 pr-2">
      <div className="flex items-center gap-2.5">
        {/* The colour, and the way to change it — for every deck at once, which is what the
            dialog's subtitle is for. */}
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
        {trailing}
        <RowAction onClick={onRename} disabled={renaming}>
          Rename
        </RowAction>
        <RowAction ref={deleteRef} onClick={onConfirm} disabled={confirming} destructive>
          {confirmLabel}
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
            meta.updateTag.mutate(
              { id: tag.id, name: next, color: tag.color },
              { onSuccess: onDone },
            )
          }
          onCancel={onDone}
        />
      )}

      {children}
    </li>
  );
}

/** `CategoryRow`'s hand-back — in `CategoriesDialog.tsx` — on the sibling control and for the
 *  identical reason: cancelling a confirmation must put the caret back on the button that
 *  opened it, not at the top of the dialog. */
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

/** A tag **this list is wearing**: it says how many copies, and its destructive control takes
 *  the label off this deck rather than off the app. */
function TagRow({
  tag,
  global,
  meta,
  variant,
  ...state
}: RowState & {
  tag: DeckTag;
  /** The same tag's app-wide row, for the reach a rename has. `undefined` while that read is
   *  in flight. */
  global: GlobalTag | undefined;
  meta: DeckMeta;
  variant: DeckVariant;
}) {
  const { deleteRef, owedFocusRef } = useDestructiveFocus(state.confirming);

  return (
    <TagShell
      tag={tag}
      meta={meta}
      confirmLabel="Remove"
      deleteRef={deleteRef}
      {...state}
      trailing={
        // The list on screen, and right to be: this row is the list the reader is editing.
        <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-dim">
          {tag.cardCount} {tag.cardCount === 1 ? "card" : "cards"}
        </span>
      }
    >
      {state.confirming && (
        <RemoveFromDeck
          tag={tag}
          global={global}
          meta={meta}
          variant={variant}
          onCancel={() => {
            owedFocusRef.current = true;
            state.onDone();
          }}
          onDone={state.onDone}
        />
      )}
    </TagShell>
  );
}

/** A tag **no card in this list wears**: it says how far it reaches across the app, and its
 *  destructive control is the app-wide delete. */
function OtherTagRow({
  tag,
  meta,
  ...state
}: RowState & { tag: GlobalTag; meta: DeckMeta }) {
  const { deleteRef, owedFocusRef } = useDestructiveFocus(state.confirming);

  return (
    <TagShell
      tag={tag}
      meta={meta}
      confirmLabel="Delete"
      deleteRef={deleteRef}
      {...state}
      trailing={
        <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-dim">
          {tag.deckCount === 0
            ? "unused"
            : `${tag.cardCount} in ${tag.deckCount} ${tag.deckCount === 1 ? "deck" : "decks"}`}
        </span>
      }
    >
      {state.confirming && (
        <DeleteTag
          tag={tag}
          meta={meta}
          onCancel={() => {
            owedFocusRef.current = true;
            state.onDone();
          }}
          onDeleted={state.onDone}
        />
      )}
    </TagShell>
  );
}

/**
 * Take a label off this deck's list, and say what survives.
 *
 * **The sentence's job is to say what is *not* happening.** The button is red and sits where
 * Delete used to, so a reader who has used this dialog before will read it as the press that
 * destroys the tag. It is not: the label stays in their list and stays on every other deck
 * wearing it, and this is the only place that can be said before the press rather than
 * discovered after it.
 *
 * `global` is the tag's app-wide row and is `undefined` while that read is in flight, which is
 * why the reach is a clause the sentence can do without: "unknown" must never be spelled as a
 * number, and the outcome for *this* deck is exact either way.
 */
function RemoveFromDeck({
  tag,
  global,
  meta,
  variant,
  onCancel,
  onDone,
}: {
  tag: DeckTag;
  global: GlobalTag | undefined;
  meta: DeckMeta;
  variant: DeckVariant;
  onCancel: () => void;
  onDone: () => void;
}) {
  // The caret comes into the question, for `DeleteCategory`'s reason.
  const confirm = useConfirmFocus(`Remove ${tag.name} from this deck`);
  /** Decks that would still be wearing it afterwards, or `null` while the app-wide read is out.
   *  `> 0` is exactly the condition for mentioning them: a tag no other deck uses has one deck
   *  to talk about, and a sentence about others would be chrome. */
  const elsewhere = global === undefined ? null : global.deckCount - 1;

  return (
    <div {...confirm}>
      <p className="text-xs">
        Take “{tag.name}” off this {LIST_NAME[variant]} list?
      </p>
      <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
        {tag.cardCount === 1
          ? "Its 1 card stays in the deck and loses the label"
          : `Its ${tag.cardCount} cards stay in the deck and lose the label`}
        {". The tag itself stays in your list"}
        {elsewhere !== null && elsewhere > 0
          ? `, and stays on the ${elsewhere === 1 ? "1 other deck" : `${elsewhere} other decks`} using it.`
          : "."}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={meta.removeTagFromDeck.isPending}
          onClick={() => meta.removeTagFromDeck.mutate(tag.id, { onSuccess: onDone })}
          className={CONFIRM_DESTRUCTIVE}
        >
          Remove from deck
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
          Keep it
        </button>
      </div>
    </div>
  );
}

/**
 * Delete a label from the whole app, and say how far that goes.
 *
 * **The number is every deck, which is a widening rather than a rewording.** It used to be
 * every *variant* of the open deck — a correction made when a tag worn by 2 live rows and 5
 * theory ones said "Its 2 cards stay in the deck", and worse, when one worn by nothing on
 * screen said flatly "No card is wearing it." The reach has grown again since: a tag belongs to
 * no deck, so the press reaches every deck that has ever put it on a card.
 *
 * Where that correction needed a second `deck_tag_list` at the other variant to get its number,
 * this one reads it off the row — {@link GlobalTag} carries both counts, from a command that
 * takes no deck at all. There is no in-flight case left to spell, which is the quiet win: the
 * row cannot be drawn before the read it came from has answered.
 *
 * Nothing is destroyed but the label itself, so there is no picker and no choice — a tag delete
 * has one outcome, and the whole of the dialog is saying what it is.
 */
function DeleteTag({
  tag,
  meta,
  onCancel,
  onDeleted,
}: {
  tag: GlobalTag;
  meta: DeckMeta;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  // The caret comes into the question, for `DeleteCategory`'s reason.
  const confirm = useConfirmFocus(`Delete ${tag.name}`);

  const decks =
    tag.deckCount === 1 ? "1 deck" : `${tag.deckCount} decks`;
  const wearing =
    tag.cardCount === 1
      ? `Its 1 card, in ${decks}, stays where it is and loses the label.`
      : `Its ${tag.cardCount} cards, across ${decks}, stay where they are and lose the label.`;

  return (
    <div {...confirm}>
      <p className="text-xs">Delete “{tag.name}” everywhere?</p>
      <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
        {tag.deckCount === 0 ? "No deck is using it." : wearing} This takes it out of your tag
        list for good.
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
