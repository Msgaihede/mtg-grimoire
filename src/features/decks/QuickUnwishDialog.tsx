/**
 * **Which wish these copies came off** — the one question a `Quick add and remove from wishlist`
 * can ask that the reader has to answer.
 *
 * A deck card's right-click offers three collection rows (issue #350), and the second of them is
 * two acts in one press: record the copies the line is short of, and take them off a wish that
 * was asking for exactly that printing. Almost always there is nothing to decide — no wish
 * matches, or one does — and `quickCollection.ts`'s `chooseWish` settles both of those without
 * drawing anything at all. This is the third case: **several wishes match**, which happens when a
 * reader has the same card on their list in two folders, and no rule the app could invent would
 * say which of them a purchase satisfies.
 *
 * ## Why a dialog rather than a rule
 *
 * The wishlist is where a reader has written down what they mean to buy and *why* — a folder
 * called `Modern staples` and one called `Birthday list` are two different intentions about one
 * card. Picking one for them would quietly empty a list they were keeping on purpose, and a wish
 * removed is not something the app offers to put back. So the press stops here, and the reader
 * spends one keystroke rather than losing a line they wrote.
 *
 * ## Cancel does nothing at all — including the add
 *
 * This is the decision most likely to be read as an oversight, so it is stated at the top of the
 * component that enforces it: **Escape, the ✕ and the Cancel button write nothing**, and that
 * includes the collection half the reader has already been told is going to happen. They asked
 * for both halves of one act; giving them one half and silently dropping the other would leave a
 * collection row recorded against a wish still standing, which is the exact state the row exists
 * to prevent. The honest answer to "never mind" is that nothing happened, and the two other rows
 * of that submenu are one press away for a reader who wanted only the add.
 *
 * ## The pre-pick, and why it is not a guess
 *
 * The rows arrive in `deck_quick_add_wishes`' order — the root first, then the reader's own
 * folders in their own `sort_order`, oldest row first inside a tie — and the **first is
 * selected**. That is `PullFromCollectionDialog`'s arrangement and its argument: the backend has
 * already ranked by how little of the reader's filing the write disturbs, so opening on the head
 * of that list is the same answer the app would have given had there been only one. A radio
 * group with nothing chosen would make the commonest press two acts instead of one.
 *
 * **A radio group and not a `<select>`.** Two or three rows, each carrying a folder name *and* a
 * quantity, is a list a reader compares rather than one they scroll — and a controlled select
 * handed a value no option carries silently reports its first row, which is a lie this surface
 * cannot afford (`src/CLAUDE.md`, and `PullFromCollectionDialog`'s own `chosen` note).
 *
 * ## What it does not own
 *
 * **The write.** `onConfirm` is the editor's `quickAddToCollection`, exactly as `AddLabelDialog`'s
 * `onCreate` is the editor's label create, and for that file's reason: a `mutate`-scoped callback
 * belongs to its *observer*, and TanStack drops it when the observer unmounts. The refusal comes
 * back as {@link QuickUnwishDialogProps.failure} and is drawn **inside** this panel, because the
 * editor's own banner is behind this dialog's `LAYER.overlay` scrim — `DeleteCategory`'s and
 * `ClearCategory`'s rule, and the same one: a refusal the reader cannot see is a press that did
 * nothing.
 */
import { useId, useState, type JSX } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "@/components/Dialog";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import type { DeckQuickAddWish } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { META_SUBMIT } from "./metaRows";

/**
 * The wishlist's own word for the root, which is what a `null` `folderName` is.
 *
 * `PullFromCollectionDialog`'s `ROOT_LABEL` says `Collection` for the same column of the *other*
 * cabinet, and `WishlistBreadcrumb.tsx` says this one. The top level is a real place the reader
 * already knows by name from the breadcrumb, not the absence of one — a row reading "No folder"
 * would be describing the drawer that page calls Wishlist. Kept here rather than imported for
 * that file's stated reason: the constant is module-private over there, and folding the two
 * together is a change to a file this one does not own.
 */
const ROOT_LABEL = "Wishlist";

/** What the body says when the layer is up with no wishes in it — a state the editor cannot
 *  produce (`chooseWish` only opens this for two or more) and which a story or a stale payload
 *  can. It says so rather than drawing an empty fieldset with a live button over it. */
const NO_WISHES = "No wishlist line matches this printing any more.";

/**
 * One wish said aloud — where it sits and what it asks for, in that order.
 *
 * **Written out as one string and set as the radio's `aria-label`, rather than left to the two
 * spans in the row.** A `<label>` whose contents are two elements computes its name by
 * concatenating them, and whether a *space* lands between the two is decided by **CSS**: the row
 * is a flex box, so a browser blockifies both spans and reads `Wishlist 2 copies`, while jsdom
 * applies no stylesheet at all and reads `Wishlist2 copies`. That is not merely a test artifact —
 * it is one string in two places with no test able to hold them together, and this repo has met
 * it before as a `Missing2` chip. Naming the control outright makes the name a fact about the
 * markup rather than about a `gap-2`.
 *
 * The middot is the app's own separator wherever a row states its facts, and
 * `PullFromCollectionDialog`'s `candidateFace` builds the same sentence for the same column of
 * the other cabinet. Both visible words survive in the name and in their visible order, which is
 * what WCAG 2.5.3 asks of a control whose label is drawn beside it.
 */
function wishFace(wish: DeckQuickAddWish): string {
  return `${wish.folderName ?? ROOT_LABEL} · ${plural(wish.quantity, "copy", "copies")}`;
}

export interface QuickUnwishDialogProps {
  open: boolean;
  /**
   * The card the copies are being recorded for, for the header's line. `null` while the dialog
   * is closed, which is the only time the shell draws nothing at all.
   */
  cardName: string | null;
  /**
   * How many copies the press records — the row's own shortfall, and the same number the menu
   * row named. It is quoted on the button because that is what the press *does*; the wish it
   * comes off is what the reader is choosing.
   */
  copies: number;
  /**
   * Every wish matching this printing and finish, in the backend's order. The first is the
   * pre-pick — see this file's header for why the order is not re-sorted here.
   */
  wishes: readonly DeckQuickAddWish[];
  /** The editor's `quickAddToCollection` in flight — the one thing this body cannot know for
   *  itself, since the mutation is mounted a floor up so it can outlive this dialog. */
  pending: boolean;
  /** Why the last press was refused, already through `ipcError`, or `null`. Drawn in here
   *  because the editor's banner is behind this dialog's scrim. */
  failure: string | null;
  /** Record the copies and take them off this wish. The host closes on success; a refusal
   *  leaves this open with its question and {@link failure} under it. */
  onConfirm: (wishId: number) => void;
  /** Escape, and the ✕: hand focus back to whatever opened the dialog, then close. **Writes
   *  nothing** — see this file's header. */
  onDismiss: () => void;
  /** Outside click: close without moving focus. Writes nothing either. */
  onClose: () => void;
}

/**
 * `26rem`, which is `AddLabelDialog`'s — the other dialog a deck card's right-click opens, and
 * the one a reader meets this in the same menu as. A row here is a folder name, a quantity and a
 * radio, which is narrower than that dialog's colour wheel, so the width is set by the pair
 * rather than by this file's content.
 */
export function QuickUnwishDialog({
  open,
  cardName,
  copies,
  wishes,
  pending,
  failure,
  onConfirm,
  onDismiss,
  onClose,
}: QuickUnwishDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      title="Which wish?"
      // The card and the count are the subtitle rather than the heading, for
      // `PullFromCollectionDialog`'s reason: the heading is what the press *is* and stays the
      // same every time, and a card name in a 20px Cinzel heading is the half that truncates.
      subtitle={
        cardName === null
          ? undefined
          : `${plural(copies, "copy", "copies")} of ${cardName} — which wishlist line ` +
            "do they come off?"
      }
      closeLabel="Close which wish"
      size="w-[26rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <QuickUnwishBody
        wishes={wishes}
        copies={copies}
        pending={pending}
        failure={failure}
        onConfirm={onConfirm}
        onCancel={onDismiss}
      />
    </Dialog>
  );
}

/**
 * The way out, in the shape the app's dialog footers use.
 *
 * **Spelled here rather than shared**, which is `ROOT_LABEL`'s situation one constant up:
 * `PullFromCollectionDialog` has the identical recipe and `metaRows.tsx`'s `CONFIRM_CANCEL` is a
 * different geometry for a different job (the `py-1` pair a destructive question is answered
 * with). Folding the three together is a change to `metaRows.tsx`, and a `py-1` cancel beside an
 * `h-8` submit is a footer where the two buttons do not line up. Two spellings of one word is
 * worth noticing; making it one is not this file's edit.
 */
const CANCEL = cn(
  "h-8 shrink-0 rounded-md border border-border px-3 text-xs text-dim",
  "transition-colors duration-150 hover:text-text",
  "motion-reduce:transition-none",
  FOCUS,
);

/**
 * The question itself.
 *
 * Separate for {@link Dialog}'s reason — a closed dialog mounts no body — and here that also
 * makes the pre-pick free: the picked wish is this component's `useState`, seeded from the first
 * row, so **every open starts on the head of the list with no effect having to put it there**.
 * That matters more than it looks: a `useState` seeded once in a component that outlived the
 * flag would keep the last press's answer, and the reflexive fix for that is a `setState` in an
 * effect, which this repo does not allow.
 */
function QuickUnwishBody({
  wishes,
  copies,
  pending,
  failure,
  onConfirm,
  onCancel,
}: {
  wishes: readonly DeckQuickAddWish[];
  copies: number;
  pending: boolean;
  failure: string | null;
  onConfirm: (wishId: number) => void;
  onCancel: () => void;
}) {
  /** The backend's own head, which is the pre-pick. `null` only for the empty payload the
   *  editor cannot produce — see {@link NO_WISHES}. */
  const [picked, setPicked] = useState<number | null>(wishes[0]?.id ?? null);

  /** One `name` for the group, so the rows are one control rather than N independent radios —
   *  and per mount, because two mounted groups sharing a name is one group. */
  const name = useId();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (picked === null || pending) return;
        onConfirm(picked);
      }}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-6 pt-4"
    >
      {wishes.length === 0 ? (
        <p className="text-[0.6875rem] text-dim">{NO_WISHES}</p>
      ) : (
        <fieldset className="flex flex-col gap-1">
          {/* The legend is the question in the subtitle said again for a screen reader, because
              a `subtitle` is a sibling of this form and names the *dialog* rather than this
              group — a radio group with no legend is N options with no question over them. */}
          <legend className="sr-only">Which wishlist line these copies come off</legend>
          {wishes.map((wish) => (
            <label
              key={wish.id}
              className={cn(
                "flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5",
                "text-[0.8125rem] transition-colors duration-150",
                "hover:border-accent motion-reduce:transition-none",
                // `has-[:checked]:` is written out whole, never built by interpolation:
                // Tailwind scans source text for whole class names.
                "has-[:checked]:border-accent has-[:checked]:text-accent",
              )}
            >
              <input
                type="radio"
                name={name}
                value={String(wish.id)}
                checked={picked === wish.id}
                onChange={() => setPicked(wish.id)}
                // Named outright rather than by the two spans beside it — see {@link wishFace}
                // for why a name assembled from them is a name CSS decides.
                aria-label={wishFace(wish)}
                className={cn("size-4 shrink-0 accent-accent", FOCUS)}
              />
              {/* The place first, because it is what tells two lines of one card apart and is
                  the whole of what the reader is choosing on. The quantity is second and is
                  the term they *check* rather than choose by: it is what says whether this
                  wish is settled outright by the press or merely reduced. */}
              <span className="min-w-0 flex-1 truncate">{wish.folderName ?? ROOT_LABEL}</span>
              <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-dim">
                {plural(wish.quantity, "copy", "copies")}
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {/* What the press does to the line above, said once rather than on every row: the wish is
          reduced by what is recorded and disappears when that empties it, which is the fact a
          reader most wants before pressing and cannot read off a radio. */}
      <p className="text-[0.6875rem] leading-relaxed text-dim">
        The copies are recorded in this deck&rsquo;s folder and taken off the line you pick — it
        goes when nothing is left on it. Cancel does neither.
      </p>

      {/* Beside the button that was pressed, not in the editor's banner behind the scrim. Its
          own animated element, carrying no padding and no border so `height: 0` really is 0;
          `overflow-hidden` is still owed, because the sentence is laid out at full size whatever
          the box around it is doing. */}
      <AnimatePresence initial={false}>
        {failure !== null && (
          <motion.p
            {...statusLine}
            role="alert"
            className="overflow-hidden text-[0.6875rem] text-destructive"
          >
            Could not record those copies — {failure}
          </motion.p>
        )}
      </AnimatePresence>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={CANCEL}>
          Cancel
        </button>
        <button type="submit" disabled={pending || picked === null} className={META_SUBMIT}>
          {/* The verb keeps its name through the flow and the number is the menu row's, so a
              reader who pressed `Quick add 4 and remove from wishlist` meets the same 4 here. */}
          {pending ? "Recording…" : `Record ${plural(copies, "copy", "copies")}`}
        </button>
      </div>
    </form>
  );
}
