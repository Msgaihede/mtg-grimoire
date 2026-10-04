/**
 * A deck note's body, drawn — the pinned CommonMark dialect `noteMarkdown.ts` reads — and the
 * inline runs a deck to-do list's lines share with it.
 *
 * **Out of `NoteCard.tsx` so the phone face can draw a note.** When it moved, the card reached
 * the opener plugin through `openExternal`, which the phone face could not import
 * (`mobile/phone/fence.test.ts`), and the link was the only edge: so the link's press is a prop
 * here, the desktop card hands in `openExternal`, and a caller that hands in nothing gets a real
 * anchor. Since the light app's step 5.4 `openExternal` is the host's, below `@/lib/core`, and
 * the phone face could import it — it still hands in nothing, because a phone page leaves by a
 * link a reader can long-press. `TodoListCard.tsx`'s own copy of the inline runs was the same
 * code with one class different, and it draws these now.
 */
import { useMemo, type JSX } from "react";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { parseNoteBody, type Block, type Inline } from "./noteMarkdown";

/**
 * A note's body, drawn.
 *
 * `parseNoteBody` is a reader for one pinned dialect and not a markdown parser: a construct it
 * has no rule for falls through to a paragraph and renders as written, so the worst case is the
 * reader's own typing and the ordinary case is a note. `ReleaseNotes.tsx` is the same shape one
 * feature over, and this is deliberately not a general component shared with it — that one draws
 * a changelog at the settings panel's type scale and this one draws prose inside a note card.
 */
export function NoteBody({
  body,
  empty,
  onLink,
}: {
  body: string;
  /** The sentence for a body with nothing in it. The caller's, because what fills an empty note
   *  is a press only the caller knows whether it draws. */
  empty: string;
  /** What a link does when pressed — see {@link MarkdownInlines}. */
  onLink?: (href: string) => void;
}): JSX.Element {
  const blocks = useMemo(() => parseNoteBody(body), [body]);

  if (blocks.length === 0) {
    // A blank body is an ordinary row rather than a failure — a note that is a title and nothing
    // else, and a note whose body the reader has emptied — so the card says which of the two an
    // empty box is. It is stated as a **sentence** and not as blank space because the line above
    // is a name and deliberately not a heading (see the title span), so nothing else on the card
    // would tell a reader that this note has no prose in it from a note whose prose did not load.
    return <p className="text-[0.6875rem] text-dim">{empty}</p>;
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
        <NoteBlock key={i} block={block} onLink={onLink} />
      ))}
    </div>
  );
}

function NoteBlock({
  block,
  onLink,
}: {
  block: Block;
  onLink?: (href: string) => void;
}): JSX.Element {
  if (block.kind === "heading") {
    // One drawn weight for all three depths. A note is a paragraph or two inside a card on the
    // band's grid, and three sizes inside a 12px block would be a type scale nobody chose —
    // `ReleaseNotes`' call, for the same reason.
    return (
      <p className="pt-1 text-[0.6875rem] font-medium uppercase tracking-wide text-text first:pt-0">
        <MarkdownInlines inlines={block.inlines} onLink={onLink} />
      </p>
    );
  }
  if (block.kind === "list") {
    // A real list marker and not a drawn glyph in a span: the marker stays out of the element's
    // `textContent` and out of the accessibility tree, where a hand-drawn one has to be
    // `aria-hidden` and still turns up in every assertion about the card's words.
    const items = block.items.map((item, i) => (
      <li key={i}>
        <MarkdownInlines inlines={item} onLink={onLink} />
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
        <MarkdownInlines inlines={block.inlines} onLink={onLink} />
      </blockquote>
    );
  }
  return (
    <p>
      <MarkdownInlines inlines={block.inlines} onLink={onLink} />
    </p>
  );
}

export function MarkdownInlines({
  inlines,
  onLink,
  codeClassName = "bg-surface",
}: {
  inlines: readonly Inline[];
  /**
   * What a link does when pressed. **Present, the link is a button that calls it** — the
   * desktop's `openExternal`, because that window has nowhere to navigate to and an anchor a
   * middle-click could follow would replace the app with a web page. **Absent, it is a real
   * `<a>` that opens in a new tab**, which is what a page in a browser has always been able to do
   * and the way out the phone face takes: a browser opens the tab, and the Android host's guard
   * hands the address to the system browser (light-app spec §3.5; `mobile/CLAUDE.md` has why it
   * is still a link now that a host seam exists). The dialect's own rule keeps the href to a
   * scheme that leaves (`noteMarkdown.ts`' `isOpenable`), so the anchor can never be a
   * `javascript:` URL.
   */
  onLink?: (href: string) => void;
  /** The code span's backing — `bg-surface` inside a note card, `bg-bg` inside a to-do list,
   *  which sits on the surface colour itself. */
  codeClassName?: string;
}): JSX.Element {
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
            <code
              key={i}
              className={cn("rounded px-1 py-0.5 font-mono text-[0.95em]", codeClassName)}
            >
              {run.text}
            </code>
          );
        }
        if (run.kind === "link") {
          const look = cn("rounded-sm text-accent underline-offset-2 hover:underline", FOCUS);
          return onLink === undefined ? (
            <a key={i} href={run.href} target="_blank" rel="noopener noreferrer" className={look}>
              {run.text}
            </a>
          ) : (
            <button key={i} type="button" onClick={() => onLink(run.href)} className={look}>
              {run.text}
            </button>
          );
        }
        return <span key={i}>{run.text}</span>;
      })}
    </>
  );
}
