/**
 * The example under the field row — a few lines of made-up cards in the chosen format, drawn
 * open, so a reader can tell the formats apart without opening their own decklist (issue #1701).
 * The text is `useExportModel`'s `example`; why the cards are made up is `example.ts`'s to say.
 *
 * **Both faces draw this one component**, the desktop's `ExportDialog` and the light app's
 * `ExportSheet`, so the caption is worded once. A face passes its own caption size and nothing
 * else.
 *
 * **Each line is a block of its own with a hanging indent**, rather than one `<pre>`: at a
 * phone's width an Archidekt line wraps, and a wrapped tail set flush left reads as a line of its
 * own — the one thing an example of line shapes must not get wrong. The continuation is indented,
 * so where each line starts stays plain. It is also not a `<pre>` because the decklist preview
 * is, and the suites find that preview as the dialog's one `<pre>`.
 *
 * **A dashed border** against the preview's solid one: these are not the reader's cards.
 */
import { Fragment, useId } from "react";
import { cn } from "@/lib/utils";

export function ExportExample({
  text,
  captionClassName = "text-sm",
}: {
  /** `useExportModel`'s `example` — the writer's output, trailing newline and all. */
  text: string;
  /** The caption's size, to match the face's own `Fields` legend. */
  captionClassName?: string;
}) {
  const captionId = useId();
  if (text === "") return null;
  const lines = text.trimEnd().split("\n");
  return (
    // Named by its caption outright: not every accessibility tree derives a figure's name from
    // its `<figcaption>`, and jsdom's does not.
    <figure aria-labelledby={captionId} className="min-w-0">
      <figcaption id={captionId} className={cn("mb-1 text-dim", captionClassName)}>
        Example
      </figcaption>
      <samp
        className={cn(
          "block rounded-md border border-dashed border-border bg-surface px-3 py-2",
          "font-mono text-xs leading-relaxed",
        )}
      >
        {lines.map((line, i) => (
          <Fragment key={i}>
            {/* A newline between two blocks draws nothing (the `<samp>` collapses it), and is
                what keeps the text — read aloud, copied, or asserted — one line per line. */}
            {i > 0 && "\n"}
            <span className="block whitespace-pre-wrap break-words pl-4 -indent-4">
              {/* A blank line between two sections is still a line of the file. */}
              {line === "" ? " " : line}
            </span>
          </Fragment>
        ))}
      </samp>
    </figure>
  );
}
