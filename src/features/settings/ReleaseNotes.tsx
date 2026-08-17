import { useMemo } from "react";
import { openExternal } from "@/lib/externalLinks";
import { parseReleaseNotes, type Block, type Inline } from "@/lib/releaseNotes";
import { cn } from "@/lib/utils";

/**
 * A release body, drawn.
 *
 * **This replaces a `<pre>` and the argument for it.** The panel used to show release notes
 * as written — "markdown is a renderer this app does not have, and half-rendered markdown
 * reads worse than none" — which was true while there was no reader. There is one now
 * (`src/lib/releaseNotes.ts`), and the half-rendering the old note feared is answered at the
 * *parser*: a line it has no rule for becomes a paragraph and is drawn as written, so the
 * worst case is what the `<pre>` gave and the ordinary case is a changelog.
 *
 * Deliberately not a general markdown component, and deliberately not a dependency: the
 * shipped CSP is `script-src 'self'` with **no `dangerouslySetInnerHTML` anywhere in
 * `src/`**, so an HTML-string renderer is unusable here on principle rather than on taste.
 *
 * The type is the panel's own and one step down from it: body at `text-xs`, a section label
 * brighter rather than bigger, and a scope (`**decks:**`) in `text-text` against the body's
 * `text-dim`. Nothing here is Cinzel — the display face is `SettingsSection`'s heading, and a
 * changelog is content.
 */
export function ReleaseNotes({ notes, className }: { notes: string; className?: string }) {
  const blocks = useMemo(() => parseReleaseNotes(notes), [notes]);

  if (!blocks.length) {
    // The honest answer, said once here rather than at each of the two call sites. A release
    // really can publish an empty body, and an empty box reads as a failure to load.
    return <p className={cn("text-xs text-dim", className)}>This release published no notes.</p>;
  }

  return (
    <div className={cn("space-y-2.5 text-xs leading-relaxed text-dim", className)}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === "heading") {
    // One drawn weight for all three depths. release-please emits `###` and nothing else, and
    // a body that reaches for `#` is asking for emphasis rather than for an outline — three
    // sizes inside a 12px block would be a type scale nobody chose.
    return (
      <p className="pt-1 text-[11px] font-medium uppercase tracking-wide text-text first:pt-0">
        <Inlines inlines={block.inlines} />
      </p>
    );
  }
  if (block.kind === "list") {
    // A real `list-disc` and not a drawn glyph in a span: the marker stays out of the
    // element's `textContent` and out of the accessibility tree, where a hand-drawn one has
    // to be `aria-hidden` and still turns up in every assertion about the row's words.
    // `list-outside` is the default, so a wrapped bullet already hangs under its own text.
    return (
      <ul className="list-disc space-y-1 pl-4 marker:text-dim/60">
        {block.items.map((item, i) => (
          <li key={i}>
            <Inlines inlines={item} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p>
      <Inlines inlines={block.inlines} />
    </p>
  );
}

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
        if (run.kind === "code") {
          return (
            <code key={i} className="rounded bg-surface px-1 py-0.5 font-mono text-[0.95em]">
              {run.text}
            </code>
          );
        }
        if (run.kind === "link") {
          // A button and not an `<a href>`: this window has nowhere to navigate to, and an
          // anchor a middle-click could follow would replace the app with a web page. The
          // panel's own "View on GitHub" is a button for the same reason, and `openExternal`
          // is the one call in this app that leaves it.
          return (
            <button
              key={i}
              type="button"
              onClick={() => void openExternal(run.href)}
              className="rounded-sm text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
