import { useMemo, type JSX, type ReactNode } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Dialog } from "@/components/Dialog";
import { UNTITLED_NOTE } from "@/features/decks/deckNotes";
import { parseNoteBody, type Block, type Inline } from "@/features/decks/noteMarkdown";
import { openExternal } from "@/lib/externalLinks";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type CardDetail, type CardNote } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { cardDetailKey } from "./cardDetailKey";

/**
 * Every note naming this card, in every deck — `ipc.cardNotes`.
 *
 * **Keyed on the oracle id, because that is what a note attaches by.** A note points at a card
 * across every printing of it (`deck_note_cards.oracle_id`), so a key carrying the printing id
 * would fetch one answer once per printing and miss the cache every time a reader stepped
 * between two printings of the card they are already reading about.
 *
 * **Under `["decks", "notes"]` on purpose, which is `useDeckNotes`' own root with `"card"` where
 * it puts a deck id.** The two are the same rows asked from opposite ends, so they belong under
 * one prefix — and `invalidateQueries` matches by prefix, so anything that fires the two-segment
 * root refreshes both. `"card"` rather than a deck id in that third slot because this read is the
 * one that spans every deck: there is no id to put there.
 *
 * ⚠️ **`useDeckNotes`' five writes fire the *three*-segment key (`["decks", "notes", deckId]`)
 * and therefore do not reach this entry**, which is a hole worth naming rather than leaving for
 * somebody to find. What it costs is bounded by `query.ts`' app-wide 30 s `staleTime`: a reader
 * who writes a note in the band and opens this overlay within half a minute is served the list as
 * it stood before the press, and after that a fresh mount refetches. The fix is one word in that
 * hook — invalidate `["decks", "notes"]` — and it belongs there rather than here, because a key
 * cannot invalidate itself and this file has no way to hear a write it does not make.
 */
function cardNotesKey(oracleId: string) {
  return ["decks", "notes", "card", oracleId];
}

/**
 * An answer of no rows, said out loud.
 *
 * **There is no status row behind this sentence and there must not be one**, which is the one
 * place this dialog parts company with the two rail siblings it is otherwise modelled on.
 * `OracleTagsDialog` and `CombosDialog` each read a feed's freshness before they will claim an
 * empty answer, because for them "no rows" could mean *this card has none* or *this database has
 * never downloaded the file*, and those are claims about two different things. Notes are the
 * reader's own rows: nothing is ever downloaded, so an empty answer has exactly one meaning and
 * the sentence can be said without asking anything else.
 *
 * It says where a note is written rather than only that there are none, because there is no way
 * to write one from here — this surface is a reader and the deck's own band is the writer.
 */
const NO_NOTES =
  "No notes. Nothing has been written about this card in any of your decks — " +
  "open a deck that holds it to write the first one.";

/**
 * A printing with no oracle card behind it.
 *
 * `CardDetail.oracleId` is nullable and a handful of rows really are null, so this is a state
 * rather than a defect — and it is the one case where the dialog asks nothing at all. There is no
 * question to put: `card_notes` matches on oracle id, so a null id has nothing to look up and a
 * call would only be this component asking the backend to confirm that zero is zero.
 */
const NO_ORACLE_CARD =
  "No notes. This printing is not linked to an oracle card, and a note is attached to the card " +
  "rather than to the printing.";

/**
 * What has been written about this card, anywhere — over the card detail modal.
 *
 * **Self-mounting, and drawn as a sibling of the modal rather than inside it.** It takes no props
 * and reads `cardOverlay` and `selectedCardId` off the store, which is the shape its four rail
 * siblings already have and the one the card modal's panel forces: that panel is a
 * `@container/card` context, and a container box is the containing block for its `fixed`
 * descendants — so this dialog's `fixed inset-0` scrim rendered *inside* it would resolve against
 * the panel and cover the card modal and nothing else, with nothing in the DOM to say so.
 *
 * `layer="stacked"` for the half of that hazard a container cannot fix. This opens **over**
 * another dialog, and at the base overlay rung the two scrims would tie — two `fixed inset-0`
 * boxes, neither inside the other, in the root stacking context — with the winner decided by
 * document order.
 *
 * **Escape needs no code here.** `Dialog` registers its `"inner"` rung on the open flag, and this
 * one mounts after the card modal, so it lands above it on `useDismissOnEscape`'s capture stack
 * and takes the press.
 *
 * ## Why the card modal asks this at all
 *
 * A note lives in a deck and is read there, and the deck is the one place a reader opening a card
 * from the collection, from search, or from a *different* deck is not. `card_notes` is the one
 * note read that is not deck-scoped, and this is its only caller: the question is *what have I
 * written about this card*, which the deck's own band can only ever answer one deck at a time.
 *
 * ## Four states, and three of them look like an empty list
 *
 * Notes for this card, **no** notes for this card, the read in flight, and the read failed.
 * `DeckBracket`'s `ComboState` is the precedent and its reasoning transfers exactly: an empty
 * list and a failed query are pictures of the same nothing and mean opposite things, so each of
 * the four says which it is and none of them is drawn as silence. The failure is the one that
 * has to be unmistakable — it is `role="alert"` and the destructive colour, because a reader who
 * reads *there is nothing here* about a note they know they wrote has been told something false.
 *
 * Two more states ride along and are not among the four, because they are about the *card* rather
 * than about the notes: the card read in flight, and a printing with no oracle card behind it
 * ({@link NO_ORACLE_CARD}). Both are the two rail siblings' own, word for word.
 *
 * ## It loads no editor
 *
 * Reading is `parseNoteBody`'s closed AST — mounting a ProseMirror instance per note to draw a
 * paragraph would be absurd, and the editor is 141.5 kB gzip behind a `React.lazy` that nothing
 * on this path may reach.
 */
export function NotesOverlay(): JSX.Element {
  const overlay = useAppStore((s) => s.cardOverlay);
  const cardId = useAppStore((s) => s.selectedCardId);
  const close = useAppStore((s) => s.closeCardOverlay);
  // Nothing here draws a price — but the marketplace is in `card_detail`'s **key**, because it is
  // in `card_detail`'s answer, and a key that left it out would open a second cache entry for a
  // card the modal behind this one has already fetched. See {@link cardDetailKey}.
  const { marketplace } = useMarketplace();

  const open = overlay === "notes" && cardId !== null;

  // **Both reads are gated on `open`**, which is what makes this component free to mount
  // unconditionally at `App` level: a dialog nobody has opened asks the backend nothing.
  // `skipToken` rather than `enabled`, so the closed state is *no query function at all* rather
  // than a disabled one.
  const card = useQuery({
    queryKey: cardDetailKey(cardId, marketplace.id),
    queryFn: open && cardId !== null ? () => ipc.cardDetail(cardId, marketplace.id) : skipToken,
  });

  const oracleId = card.data?.oracleId ?? null;

  const notes = useQuery({
    queryKey: cardNotesKey(oracleId ?? ""),
    queryFn: open && oracleId !== null ? () => ipc.cardNotes(oracleId) : skipToken,
  });

  return (
    <Dialog
      open={open}
      // The heading says which *question* is open — which is what a reader choosing between the
      // rail's entries is picking — and the subtitle says which card it is being asked about.
      title="Notes"
      subtitle={card.data?.name}
      closeLabel="Close notes"
      // The two rail siblings' width. A note body is prose rather than a wall of pictures, and at
      // this width the body's own measure lands under 80 characters with the panel's padding
      // taken off. **No `max-h` here**: `cn`'s tailwind-merge would delete the shell's own the
      // moment a host names one, and below the phone fold — where every dialog fills the glass —
      // this one alone would float.
      size="w-[38.75rem]"
      layer="stacked"
      onDismiss={close}
      onClose={close}
    >
      <Body
        card={card.data ?? null}
        loading={card.isPending}
        oracleId={oracleId}
        notes={notes}
      />
    </Dialog>
  );
}

/** One query's four facts, so {@link Body} can be handed a result without importing TanStack's
 *  whole observer type — and so a story or a test can stage one by hand. `OracleTagsDialog`'s
 *  `Reading` with the two error fields it has no use for and this one cannot do without. */
interface Reading<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

/**
 * The panel's contents, mounted only while it is open — `Dialog`'s own rule, and what keeps the
 * scroll position a session rather than something an effect has to reset.
 *
 * **Every state is drawn inside the same scroller**, rather than each returning a shape of its
 * own: the box is a property of the *panel*, so a dialog that dropped it for its empty states
 * would change size exactly when a reader is being told there is nothing to see.
 */
function Body({
  card,
  loading,
  oracleId,
  notes,
}: {
  card: CardDetail | null;
  loading: boolean;
  oracleId: string | null;
  notes: Reading<CardNote[]>;
}) {
  const rows = notes.data ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {loading ? (
        <Note>Reading the card…</Note>
      ) : // `card_detail` answers `null` for an id `cards` has no row for, which is a real state
      // rather than a failure: a collection or a deck can hold a printing the corpus has dropped.
      card === null ? (
        <Note>This printing is no longer in the card database.</Note>
      ) : oracleId === null ? (
        <Note>{NO_ORACLE_CARD}</Note>
      ) : notes.isError ? (
        // **Before the pending arm and in a colour of its own**, because this is the state that
        // must never be mistaken for the empty one below it. `role="alert"` for the reason
        // `AllPrintingsDialog` gives at its own site: the press that produced it — a row on a
        // rail, in another dialog — has already been forgotten by the eye.
        <p role="alert" className="text-sm leading-relaxed text-destructive">
          Could not read the notes — {ipcError(notes.error)}.
        </p>
      ) : notes.isPending ? (
        <Note>Reading the notes…</Note>
      ) : rows.length === 0 ? (
        <Note>{NO_NOTES}</Note>
      ) : (
        // The list carries its own name, the more exact of the two the panel offers: the heading
        // says which question is open, this says what the items in it are. A reader moving list
        // to list rather than heading to heading arrives here without the heading.
        //
        // No count above it. Every row names its own deck, so a census line would be this panel
        // restating what the next four inches of it already say.
        <ul aria-label="Notes about this card" className="space-y-4">
          {rows.map((note) => (
            <NoteRow key={note.id} note={note} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One note — the deck it was found in, its heading where it has one, and its body.
 *
 * **The deck name leads, and it is the one thing on this row drawn in the accent.** It is the
 * field {@link CardNote} exists for: a `DeckNote` read from inside a deck needs no such line,
 * and a card can be in five decks, so without it every row here would be prose with no address.
 * The accent is what this app already uses to say "this is yours" — an owned badge, the rail's
 * deck line — and a deck is about as yours as anything in the grimoire gets. It is the panel's
 * only one; a link inside a body takes an underline instead, so the colour goes on saying one
 * thing.
 *
 * **The rule down the left is structure rather than decoration.** A body can hold headings, lists
 * and quotes of its own, so two notes stacked with nothing between them would read as one long
 * one — the rule is what says where a note starts and stops, and it is `DeckBracket`'s advisory
 * device at this panel's size.
 *
 * **A blank heading draws nothing here, and this is the one surface that does not reach for
 * `noteTitle`'s middle arm.** That fallback — the body's first line, unmarked — is for the
 * surfaces that print a note as *one line*: the band's list and the card menu's submenu, where
 * the first line is all a reader gets. Here the whole body is drawn immediately underneath, so
 * the fallback would print one line twice and call the first copy a heading. What this row does
 * take from that function is its **last** arm, {@link UNTITLED_NOTE}, for the note that has
 * neither a heading nor a body: both columns default to empty, so that is a row a reader can
 * really make, and without a word for it the row would draw as a bare deck name over nothing —
 * which reads as a note that failed to load rather than as one nobody has written yet.
 */
function NoteRow({ note }: { note: CardNote }) {
  const title = note.title.trim();
  const blocks = useMemo(() => parseNoteBody(note.body), [note.body]);

  return (
    <li className="border-l-2 border-border pl-3">
      <p className="text-xs font-medium text-accent">{note.deckName}</p>
      {title !== "" && <p className="mt-1 text-sm font-medium text-text">{title}</p>}
      {blocks.length > 0 ? (
        <div className="mt-1 space-y-2 text-sm leading-relaxed text-dim">
          {blocks.map((block, i) => (
            <BlockView key={i} block={block} />
          ))}
        </div>
      ) : (
        title === "" && <p className="mt-1 text-sm leading-relaxed text-dim">{UNTITLED_NOTE}</p>
      )}
    </li>
  );
}

/**
 * One block of a body.
 *
 * **A heading is a `<p>` and not an `<h4>`, which is `ReleaseNotes`' decision for its own
 * reason and for a second one this surface adds.** A `#` in a note is emphasis rather than an
 * outline — nobody structures a paragraph about their mana base — and real heading elements here
 * would splice whatever a reader typed into the outline of a dialog that already has an `<h2>`
 * of its own. One drawn weight for all three depths follows from the same sentence: three sizes
 * inside a row this small would be a type scale nobody chose.
 *
 * The list markers are real `list-disc` and `list-decimal` rather than a drawn glyph in a span:
 * a marker stays out of the element's `textContent` and out of the accessibility tree, where a
 * hand-drawn one has to be `aria-hidden` and still turns up in every assertion about the row's
 * words.
 */
function BlockView({ block }: { block: Block }) {
  if (block.kind === "heading") {
    return (
      <p className="pt-1 font-medium text-text first:pt-0">
        <Inlines inlines={block.inlines} />
      </p>
    );
  }
  if (block.kind === "list") {
    const items = block.items.map((item, i) => (
      <li key={i}>
        <Inlines inlines={item} />
      </li>
    ));
    // **`start` is passed through and is not a detail.** It is present only on an ordered list
    // that does not begin at 1, and Tiptap serializes the number — so a list a reader began at
    // `3.` would be drawn here as `1.` the moment they stopped editing it, which is the two
    // renderers disagreeing about one body. `noteMarkdown.ts` says the same thing at its own site.
    return block.ordered ? (
      <ol start={block.start} className="list-decimal space-y-1 pl-5 marker:text-dim/60">
        {items}
      </ol>
    ) : (
      <ul className="list-disc space-y-1 pl-5 marker:text-dim/60">{items}</ul>
    );
  }
  if (block.kind === "quote") {
    return (
      <blockquote className="border-l border-border pl-3 italic">
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

/** The runs inside one block. Five marks and a link, which is exactly the dialect
 *  `noteMarkdown.ts` pins and the editor is narrowed to — anything wider arrives here as
 *  `text` and is drawn as written, which is the reader's own rule that nothing is ever dropped
 *  for not being understood. */
function Inlines({ inlines }: { inlines: Inline[] }) {
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
        if (run.kind === "em") return <em key={i}>{run.text}</em>;
        if (run.kind === "strike") return <s key={i}>{run.text}</s>;
        if (run.kind === "code") {
          return (
            <code key={i} className="rounded bg-surface px-1 py-0.5 font-mono text-[0.95em]">
              {run.text}
            </code>
          );
        }
        if (run.kind === "link") return <LinkRun key={i} run={run} />;
        return <span key={i}>{run.text}</span>;
      })}
    </>
  );
}

/**
 * A link in a body — a button and not an `<a href>`.
 *
 * This window has nowhere to navigate to, and an anchor a middle-click could follow would replace
 * the app with a web page. `openExternal` is the one call in this app that leaves it, and it is
 * made **on the press**: a note that merely mentions a site must not have visited it.
 *
 * **The scheme fence is `noteMarkdown.ts`'s and is deliberately not repeated here**, which is
 * `ReleaseNotes.tsx`'s arrangement with `releaseNotes.ts` one pair over. `isOpenable` refuses
 * anything but `http` and `https` at the parser, and a refused link is pushed as *text* rather
 * than dropped — so a run reaching this function has already been cleared, and a second check
 * here would be a branch nothing can reach and nothing can go red for. `openExternal` hands its
 * argument straight to the opener with no check of its own, so that one fence is the whole of it:
 * widening the parser's list is what would arm this button, and that is where the reasoning to
 * read lives.
 *
 * Underlined rather than accented, so the panel's one accent goes on meaning the deck.
 */
function LinkRun({ run }: { run: Extract<Inline, { kind: "link" }> }) {
  return (
    <button
      type="button"
      onClick={() => void openExternal(run.href)}
      className={cn("rounded-sm underline underline-offset-2 hover:text-text", FOCUS)}
    >
      {run.text}
    </button>
  );
}

/**
 * One dim sentence in the body — every state that is not a list of notes.
 *
 * **One text node, and that is load-bearing rather than tidy.** Testing Library reads an
 * element's *own* text children, so a sentence broken by a `<span>` becomes unfindable by
 * anything that queries it as a sentence — which is how a reader reads it, and how the test for
 * it is written. `OracleTagsDialog`'s `Note` and `CombosDialog`'s say the same thing at their own
 * sites; this is the third.
 */
function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-dim">{children}</p>;
}
