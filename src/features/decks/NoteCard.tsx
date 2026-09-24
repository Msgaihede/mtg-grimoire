/**
 * One note, drawn as a card in the band's masonry.
 *
 * **It is as tall as its note, and `min-h-[11.5rem]` is the floor.** The spec fixed this at 184px
 * and clamped the body to three lines; the reader's answer reverses that argument rather than the
 * layout — do the masonry properly, so what stays uniform across the grid is the **gap** and never
 * the height. A one-line note is still a card because of the floor; a long one is as long as it
 * is, and there is no clamp and no `+ more` on the prose. That is also what retired the question
 * of how a reader gets at the rest of a long note: the whole body is here.
 *
 * **The span is this card's own measured height**, `masonry.ts`'s hook at {@link NOTE_GAP}. The
 * grid is ruled in one-pixel rows with `rowGap: 0`, so a card that wraps to the next line lands at
 * the foot of the shortest column rather than under the tallest card of a shared line —
 * `views/StackView.tsx` has the full argument, and this is the same mechanism at a smaller gutter.
 *
 * **No `N cards` chip.** The strip below counts them, and two things on a 292px card saying the
 * same number is one too many. The chip stays in the picker, where there is no strip.
 *
 * **Nothing here imports `NoteEditor`, statically or otherwise.** That chunk is 141.5 kB gzip
 * behind `React.lazy` and this card is the read path — `DeckNotesPanel.test.tsx` sweeps every
 * source file in `src/` for a static import of it, so an "Edit opens the editor" tidy made here
 * would put the whole of Tiptap back in the main bundle. A press on `Edit` reports upward through
 * {@link NoteCardProps.onEdit} and the host decides what to open.
 */
import { useCallback, useEffect, useMemo, type JSX, type KeyboardEvent } from "react";
import { GripVertical } from "lucide-react";
import { CardImage } from "@/components/CardImage";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { plural } from "@/lib/counts";
import { DROP_EDGE, DROP_OVER } from "@/lib/dropMarks";
import { openExternal } from "@/lib/externalLinks";
import { FOCUS } from "@/lib/focus";
import { cardArtSrc, cardImageUrl } from "@/lib/images";
import type { DeckNote, DeckNoteCard } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { noteTitle } from "./deckNotes";
import { useMasonryRowSpan } from "./masonry";
import { useDeckNoteReorder } from "./noteDrag";
import { RowAction } from "./metaRows";
import { parseNoteBody, type Block, type Inline } from "./noteMarkdown";

/** The gutter between two cards in the masonry, in pixels — the band's grid draws it. */
export const NOTE_GAP = 8;

/**
 * How many art crops a card draws before the `+N more` chip.
 *
 * Three rather than however many fit: the strip has to be the same shape on every card of the
 * grid, and the narrowest track the band draws is ~280px — four 44px frames and their gutters fit
 * there and read as a wall of pictures rather than as a reference beside prose.
 */
export const NOTE_THUMBS = 3;

/**
 * The art strip, for a test or a live pass to address.
 *
 * `DECK_COLOR_SEGMENT_ATTR`'s reason exactly: the strip has no role, no accessible name and no
 * text of its own, and in the shipped band its frames are `aria-hidden` decoration — so there is
 * nothing to query it by. Without a handle *"draws no strip at all"* and *"draws an empty strip"*
 * are the same assertion, and only one of them is what this card promises.
 */
export const NOTE_STRIP_ATTR = "data-note-strip";

/**
 * The note the band has been sent to, and whether it was sent there to write or to read.
 *
 * It is **not** the `DeckNoteRequest` a card's menu raises, and the difference is the whole reason
 * for the second type: an `add` request holds a card and no id, because the id does not exist
 * until the create answers. This is what the request *becomes* once there is a row to point at.
 */
export interface NoteFocus {
  noteId: number;
  /**
   * Open this note's editor as it arrives — **read in one place, and raised by nothing**.
   *
   * ⚠️ It said *`add` only* until 2026-09-20 and that is no longer a description of anything.
   * `Add note…` used to create the row and then send the band to it with this flag up, so the
   * editor opened on a note that already existed; it opens a dialog on a note that does **not**
   * exist yet now — the card travels as `NotesBandProps.pendingCard` and the create is the Save.
   * The band's one producer — `DeckNotesPanel`'s request adjustment — therefore writes
   * `edit: false` unconditionally, and its one reader, `NotesBand`'s adjustment beside it, is
   * reading a field nothing raises. This card is not that reader: it takes the whole focus and
   * asks only whether there *is* one, because bringing a note into view is what both kinds want.
   *
   * **Kept rather than deleted, and the reason is the arm behind it.** `NotesBand`'s adjustment
   * waits for the named note to appear in `notes` before it acts on an `edit` focus — the
   * guarantee a caller that *does* raise one is owed, and the thing that would have to be
   * rediscovered if the field went and came back. It costs one comparison per focus change.
   * Reading is what a focus with this down is for, which is the whole of `Notes ▸`: an editor a
   * reader did not ask for is a body they can lose by pressing the wrong thing, and 141.5 kB of
   * ProseMirror in front of a card they came to look at.
   */
  edit: boolean;
}

export interface NoteCardProps {
  note: DeckNote;
  /** Non-null while this is the card the band was sent to — brings it into view. */
  focused: NoteFocus | null;
  onEdit: () => void;
  onCards: () => void;
  onDelete: () => void;
  /**
   * A press on one thumbnail — the card it names.
   *
   * **`undefined` draws the crops as plain frames rather than as controls, and that is the
   * shipped case rather than a fallback for one.** The band passes no handler: there is nowhere
   * for a press to go that this card could reach, since opening a card's modal from here means a
   * prop threaded down from `DeckEditor` that nothing has asked for. So the crops are decoration
   * beside prose, and the only control the strip can have left is the `+N more` chip — which
   * exists only above {@link NOTE_THUMBS}, so **on a note naming one, two or three cards the
   * shipped strip carries no control at all**. A `<button>` drawn with no handler behind it would
   * be a named, focusable tab stop per crop — three to a card, on every card of the grid — that
   * does nothing when pressed, which is strictly worse than a picture.
   *
   * **What a screen reader gets does not depend on this prop**, and that is deliberate:
   * {@link namesSentence} is drawn inside the strip on both branches, so the count and every name
   * are announced whether the crops are frames or controls. Without it, making the crops
   * decoration would have taken an announcement away and replaced it with nothing — the chip that
   * used to carry the count is gone and `+N more` does not exist below four cards.
   */
  onOpenCard?: (card: DeckNoteCard) => void;
  /**
   * Where this note sits in the band and how to move it — issue #509. **`undefined` draws no grip
   * and registers no drag**, which is the band's answer for a deck with one note (there is nowhere
   * for it to go) and for every caller that has not wired a reorder.
   */
  reorder?: NoteReorder;
}

/** What a card needs to offer the reorder: its place, and the two ways to leave it. */
export interface NoteReorder {
  /** Zero-based, in the order the band draws the notes. */
  index: number;
  total: number;
  /** A note dropped on this one takes its place. */
  onMove: (dragged: number, targetId: number) => void;
  /** One arrow press on the grip: `-1` is one place earlier, `1` one place later. */
  onStep: (delta: -1 | 1) => void;
}

/**
 * Which way each arrow key on the grip steps a note. The masonry fills row by row, so *earlier*
 * is both up and left — one order drawn in two dimensions, and two keys each way so a reader does
 * not have to know which axis the next card happens to sit on.
 */
const STEP: Readonly<Record<string, -1 | 1>> = {
  ArrowUp: -1,
  ArrowLeft: -1,
  ArrowDown: 1,
  ArrowRight: 1,
};

export function NoteCard({
  note,
  focused,
  onEdit,
  onCards,
  onDelete,
  onOpenCard,
  reorder,
}: NoteCardProps): JSX.Element {
  const title = noteTitle(note);
  const { elementRef, span } = useMasonryRowSpan(NOTE_GAP);
  const { attachCard, attachHandle, armed, over } = useDeckNoteReorder(note.id, reorder?.onMove);
  const tip = useTooltip();

  /** The masonry measures the `<li>` through a ref object and the drag registers on it through a
   *  callback, and React takes one ref per element — so the two are joined here. */
  const attachItem = useCallback(
    (element: HTMLLIElement | null) => {
      elementRef.current = element;
      const release = attachCard(element);
      return () => {
        elementRef.current = null;
        release?.();
      };
    },
    [elementRef, attachCard],
  );

  const onGripKey = (event: KeyboardEvent) => {
    const delta = STEP[event.key];
    if (delta === undefined || reorder === undefined) return;
    event.preventDefault();
    reorder.onStep(delta);
  };

  /**
   * Bring this card where the reader is looking, when the card menu sent them here.
   *
   * **The caret rather than a scroll call, and the scroll is the belt.** A press on `Notes ▸` is
   * a reader going somewhere, so the caret goes with them — otherwise it is left on the card they
   * right-clicked, which is behind the deck they have just scrolled past, and their next Tab
   * restarts from there. Focusing an element scrolls it into view by itself in a browser; the
   * explicit call is what covers a card already partly on screen, and `block: "nearest"` is the
   * app's rule for it.
   *
   * **`tabIndex={-1}` and no focus class**, which is the app's landing-pad rule: a reader can
   * neither Tab nor arrow onto this card, so a ring here would mark a stop that does not exist.
   *
   * **The caret is deliberately not put in whatever an `edit` request opens.** That surface is the
   * host's and arrives behind `React.lazy`, so a focus call made here races a chunk fetch and
   * lands on nothing; the card is what is on screen at the moment the request is honoured.
   *
   * jsdom implements neither scroll-on-focus nor `scrollIntoView`, hence the `?.` — the same
   * absence `CardGrid`'s tile works around.
   */
  useEffect(() => {
    if (focused === null) return;
    const el = elementRef.current;
    if (el === null) return;
    el.focus();
    el.scrollIntoView?.({ block: "nearest" });
  }, [focused, elementRef]);

  const extra = note.cards.length - NOTE_THUMBS;

  return (
    <li
      ref={attachItem}
      tabIndex={-1}
      style={span === null ? undefined : { gridRow: `span ${span}` }}
      // ⚠️ **`min-h-*` on a grid item replaces `min-height: auto`** — which makes it a floor here
      // and not a ceiling, because the item's `height` stays `auto` and its content is what grows
      // it. So this card must never also carry an `h-*`: that a long note is as long as it is, is
      // the whole of what the redesign reversed.
      //
      // `max-w-[26.25rem]` is the spec's 420px cap. At the editor column's 1192px it never bites
      // (four tracks at ~292px), and at one column it keeps a card from becoming a banner.
      className={cn(
        "flex min-h-[11.5rem] max-w-[26.25rem] flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2.5",
        // The card owns an edge, so the eligible mark recolours it rather than adding an outline —
        // `dropMarks.ts`' rule for a bordered target — and the card under the pointer goes solid.
        armed && DROP_EDGE,
        over && cn(DROP_OVER, "border-accent"),
      )}
    >
      {/* One line, truncated. A note's title is the reader's own and is deliberately not a
          heading: a grid of these at heading weight would be a type scale nobody chose. */}
      <div className="flex min-w-0 items-center gap-1.5">
        {reorder !== undefined && (
          <button
            ref={attachHandle}
            type="button"
            onKeyDown={onGripKey}
            // The position is in the name because the only other way to know where a note landed
            // is to look at it — `CategoriesDialog`'s grip, one feature over.
            aria-label={`Move ${title}, ${reorder.index + 1} of ${reorder.total}`}
            {...tip("Drag to reorder, or press the arrow keys")}
            className={cn(
              "-ml-1 shrink-0 cursor-grab rounded-sm text-dim",
              "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <GripVertical className="size-3.5" aria-hidden="true" />
          </button>
        )}
        <span className="min-w-0 truncate text-[0.8125rem] font-medium text-text">{title}</span>
      </div>

      {/* `flex-1` is what pushes the actions to the foot while the card sits at its floor; past
          the floor the body is simply its content, and there is no clamp on it. */}
      <div className="min-h-0 flex-1 text-xs leading-relaxed text-dim">
        <NoteBody body={note.body} />
      </div>

      {/* The strip, drawn only where the note names a card — an empty row of frames on the band's
          commonest note is the `0 cards` chip's failure told in pictures. */}
      {note.cards.length > 0 && (
        <div {...{ [NOTE_STRIP_ATTR]: "" }} className="flex items-center gap-1.5">
          {/* **`sr-only` is `position: absolute`, so this span is out of flow and is not a flex
              item at all** — it takes none of the strip's `gap-1.5` and moves no frame. It is the
              same thing `actionLabel` already puts in this card three times, and the app-wide
              containing-block rule is met by `AppShell`'s `main` being `relative`, one scroller
              up. */}
          <span className="sr-only">{namesSentence(note.cards)}</span>
          {note.cards.slice(0, NOTE_THUMBS).map((card) => (
            <NoteThumb key={card.oracleId} card={card} onOpen={onOpenCard} />
          ))}
          {extra > 0 && (
            <button
              type="button"
              onClick={onCards}
              // The count is {@link plural}'s — `2 more cards`, digits and all — because that
              // helper is where "never print 1 cards" is decided, and a second spelling here
              // would be a second place to get it wrong.
              aria-label={`${plural(extra, "more card")} in ${title}`}
              className={cn(
                "grid h-8 shrink-0 place-items-center rounded border border-border px-2",
                "font-mono text-[0.625rem] tabular-nums text-dim",
                FOCUS,
              )}
            >
              +{extra} more
            </button>
          )}
        </div>
      )}

      {/* None of the three is `disabled`: what each opens is a dialog over the page rather than
          something unfolding under this card, so there is no state of *this* card a press could
          honestly be refused for. */}
      <div className="flex items-center justify-end gap-2.5">
        <RowAction onClick={onCards}>{actionLabel("Cards", `on ${title}`)}</RowAction>
        <RowAction onClick={onEdit}>{actionLabel("Edit", title)}</RowAction>
        <RowAction onClick={onDelete} destructive>
          {actionLabel("Delete", title)}
        </RowAction>
      </div>
    </li>
  );
}

/**
 * What the strip says to a screen reader — **the one thing the redesign took away and did not put
 * back**.
 *
 * The row this card replaced drew a mono `N cards` chip beside the title, which was visible *and*
 * announced. The design deleted it on the grounds that *"the strip counts the cards now"*, and
 * that trade holds only while the strip counts them **for everybody**: the crops are `aria-hidden`
 * decoration (see {@link NoteCardProps.onOpenCard}) and the `+N more` chip does not exist until a
 * note names more than {@link NOTE_THUMBS}, so on a note naming one to three cards the count had
 * come to be nowhere at all. `Cards on <note>` says a picker exists; it does not say this note
 * names anything.
 *
 * **Every card, not the three that are drawn.** The sentence costs no pixels and no layout, and
 * the names the strip has no room for are otherwise reachable only by opening the picker — which
 * is the thing a reader would be opening *to find out whether it was worth opening*.
 *
 * **Joined with `; ` and never `, `**, which is not a matter of taste: a card's name may contain a
 * comma — `Krenko, Mob Boss`, `Purphoros, God of the Forge` — so a comma-joined list is read as
 * more items than the note names, and the count at the head of the sentence then disagrees with
 * what follows it. The trailing stop is what keeps the last name from running into whatever the
 * card says next.
 *
 * The count is {@link plural}'s, like the chip's, so `1 card` cannot come out as `1 cards` here
 * while the chip beside it gets it right.
 */
function namesSentence(cards: readonly DeckNoteCard[]): string {
  return `Names ${plural(cards.length, "card")}: ${cards.map((card) => card.name).join("; ")}.`;
}

/** The frame itself — one box at one size, so the two branches below cannot come to draw two. */
const THUMB_FRAME = "block h-8 w-11 shrink-0 overflow-hidden rounded border border-border bg-bg";

/**
 * One card a note names, as an art crop — **a control only where a host has somewhere to send
 * the press**.
 *
 * With a handler it is a `<button>` whose accessible name is the card's own, because a frame with
 * no bytes in it is still a control that goes somewhere. With none it is an `aria-hidden`
 * `<span>`: no role, no name, no tab stop, and the identical picture. See
 * {@link NoteCardProps.onOpenCard} for why the second of those is the shipped case and not the
 * exceptional one.
 *
 * **The picture is `alt=""` in both branches.** Under the button the name is already said once
 * and an `alt` repeating it would have a screen reader read every crop twice; under the span the
 * whole frame is hidden, so the empty `alt` is the element agreeing with its parent rather than a
 * second decision.
 *
 * Through `CardImage`, never a bare `<img>`: this is a *slot*, and a browser paints an `<img>`'s
 * last decoded frame until the new src decodes, so the picture would lag the name by the length
 * of the fetch. `PullFromCollectionDialog`'s row makes the identical call for the identical
 * reason.
 */
function NoteThumb({
  card,
  onOpen,
}: {
  card: DeckNoteCard;
  onOpen?: (card: DeckNoteCard) => void;
}): JSX.Element {
  // `cardId: null` is the orphan — a card the corpus no longer has a row for. It draws the empty
  // frame rather than a broken image, which is `DeckNoteCard`'s own rule stated at the type.
  const art =
    card.cardId === null
      ? null
      : cardArtSrc(cardImageUrl(card.cardId, 0, "art"), card.imageUris?.art);

  const picture = art === null ? null : (
    <CardImage
      src={art}
      alt=""
      draggable={false}
      // Lazy, for a plain scroller's reason rather than a wall's: the band draws every note the
      // deck holds, so a notebook really is that many mounted frames.
      loading="lazy"
      className="size-full object-cover"
    />
  );

  if (onOpen === undefined) {
    // No `FOCUS` here, and its absence is the point rather than an omission: a span takes no
    // caret, so a ring on it would mark a stop that does not exist — the landing-pad rule one
    // element in.
    return (
      <span aria-hidden="true" className={THUMB_FRAME}>
        {picture}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      aria-label={`Open ${card.name}`}
      className={cn(THUMB_FRAME, FOCUS)}
    >
      {picture}
    </button>
  );
}

/**
 * One note's title folded into a verb, for a control's accessible name.
 *
 * **Spelled as a text node beside an `sr-only` span, never assembled from two elements.** Name
 * computation trims each element's contribution before appending it, so `<span>Edit</span>` next
 * to `<span>Mana base</span>` computes to `EditMana base` — the `Missing2` failure. A bare text
 * child followed by `{" "}` survives as a sibling text node and reads correctly.
 *
 * **A note's title is not unique and is not meant to be** (§2: two devices each typing a note
 * about the mana base must stay two notes), so two cards really can carry one name. What keeps
 * that usable is that every control which *acts* names the card it is on, and what each of them
 * opens is a dialog over the page rather than a panel unfolding under one card — so a reader is
 * never reading two of these names at once, and the grid itself is what they read.
 */
function actionLabel(verb: string, rest: string): JSX.Element {
  return (
    <>
      {verb}
      {/* The space is a sibling of both, which is the whole of why this reads as two words. */}{" "}
      <span className="sr-only">{rest}</span>
    </>
  );
}

/**
 * A note's body, drawn.
 *
 * `parseNoteBody` is a reader for one pinned dialect and not a markdown parser: a construct it
 * has no rule for falls through to a paragraph and renders as written, so the worst case is the
 * reader's own typing and the ordinary case is a note. `ReleaseNotes.tsx` is the same shape one
 * feature over, and this is deliberately not a general component shared with it — that one draws
 * a changelog at the settings panel's type scale and this one draws prose inside a note card.
 */
function NoteBody({ body }: { body: string }): JSX.Element {
  const blocks = useMemo(() => parseNoteBody(body), [body]);

  if (blocks.length === 0) {
    // A blank body is an ordinary row rather than a failure — a note that is a title and nothing
    // else, and a note whose body the reader has emptied — so the card says which of the two an
    // empty box is. It is stated as a **sentence** and not as blank space because the line above
    // is a name and deliberately not a heading (see the title span), so nothing else on the card
    // would tell a reader that this note has no prose in it from a note whose prose did not load.
    return <p className="text-[0.6875rem] text-dim">Nothing written yet — press Edit.</p>;
  }

  return (
    // **`whitespace-pre-line`, and it is load-bearing rather than typography.** The `Inline` union
    // has no break member, so `parseNoteBody` represents a hard break as a `"\n"` *inside a text
    // run* — under the default `normal` every one of them would collapse to a space, and a note
    // laid out in short lines would come back as one paragraph with nothing going red. It is set
    // once here because `white-space` inherits, so a run nested in a list item or a quote is
    // covered by the same declaration.
    <div className="space-y-1.5 whitespace-pre-line text-xs leading-relaxed text-dim">
      {blocks.map((block, i) => (
        <NoteBlock key={i} block={block} />
      ))}
    </div>
  );
}

function NoteBlock({ block }: { block: Block }): JSX.Element {
  if (block.kind === "heading") {
    // One drawn weight for all three depths. A note is a paragraph or two inside a card on the
    // band's grid, and three sizes inside a 12px block would be a type scale nobody chose —
    // `ReleaseNotes`' call, for the same reason.
    return (
      <p className="pt-1 text-[0.6875rem] font-medium uppercase tracking-wide text-text first:pt-0">
        <Inlines inlines={block.inlines} />
      </p>
    );
  }
  if (block.kind === "list") {
    // A real list marker and not a drawn glyph in a span: the marker stays out of the element's
    // `textContent` and out of the accessibility tree, where a hand-drawn one has to be
    // `aria-hidden` and still turns up in every assertion about the card's words.
    const items = block.items.map((item, i) => (
      <li key={i}>
        <Inlines inlines={item} />
      </li>
    ));
    // **`start` is drawn, and it is only ever present on a list that does not begin at 1.**
    // Tiptap keeps a reader's start number and serialises it, so a list begun at `3.` would be
    // drawn as `1.` the moment they stopped editing — the two renderers disagreeing about one
    // body, which is the failure the dialect's round trip exists to prevent.
    return block.ordered ? (
      <ol start={block.start} className="list-decimal space-y-1 pl-4 marker:text-dim/60">
        {items}
      </ol>
    ) : (
      <ul className="list-disc space-y-1 pl-4 marker:text-dim/60">{items}</ul>
    );
  }
  if (block.kind === "quote") {
    return (
      <blockquote className="border-l-2 border-border pl-2 italic">
        <Inlines inlines={block.inlines} />
      </blockquote>
    );
  }
  return (
    <p>
      <Inlines inlines={block.inlines} />
    </p>
  );
}

function Inlines({ inlines }: { inlines: readonly Inline[] }): JSX.Element {
  return (
    <>
      {inlines.map((run, i) => {
        if (run.kind === "strong") {
          return (
            <strong key={i} className="font-medium text-text">
              {run.text}
            </strong>
          );
        }
        if (run.kind === "em") {
          return (
            <em key={i} className="italic">
              {run.text}
            </em>
          );
        }
        if (run.kind === "strike") {
          return (
            <s key={i} className="line-through">
              {run.text}
            </s>
          );
        }
        if (run.kind === "code") {
          return (
            <code key={i} className="rounded bg-surface px-1 py-0.5 font-mono text-[0.95em]">
              {run.text}
            </code>
          );
        }
        if (run.kind === "link") {
          // A button and not an `<a href>`: this window has nowhere to navigate to, and an anchor
          // a middle-click could follow would replace the app with a web page. `openExternal` is
          // the one call in this app that leaves it — `ReleaseNotes` makes the identical call for
          // the identical reason.
          return (
            <button
              key={i}
              type="button"
              onClick={() => void openExternal(run.href)}
              className={cn("rounded-sm text-accent underline-offset-2 hover:underline", FOCUS)}
            >
              {run.text}
            </button>
          );
        }
        return <span key={i}>{run.text}</span>;
      })}
    </>
  );
}
