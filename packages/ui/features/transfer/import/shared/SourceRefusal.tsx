/**
 * Why a list the reader typed or picked has nothing to preview — the parser's own sentences,
 * drawn on the **source** step (issue #1552).
 *
 * **Only when nothing was read.** Preview is shut while `parsed.lines` is empty, so the preview
 * step's `Problems` / `ImportProblems` — the one other place a `ParseIssue` is drawn — is out of
 * reach exactly when its sentence is all the reader has. Both file-level refusals (a spreadsheet
 * with no column naming the card, an XML file that is not an MTGO `.dek`) return zero lines by
 * construction, and so does a list whose every line was refused (`0 Shock`). With any line read
 * this draws nothing: the preview is one press away and quotes every issue there, so saying them
 * here too would be saying them twice.
 *
 * **Said in the reader's own words, under the count line**, in the source step's quiet voice
 * rather than as an alert: it follows the box as it is typed, and an alert that fires on every
 * half-typed line is noise. Capped and scrolled in place, so a long file's refusals cannot push
 * the footer off a short window; `relative` for the scroller rule (`packages/ui/CLAUDE.md`).
 *
 * Shared by the desktop's `ImportDialog` and the light app's `ImportSheet`, which draw the same
 * count line over the same `useImportSource`.
 */
import type { JSX } from "react";
import { cn } from "@/lib/utils";
import type { ParsedList } from "../parse";

/** How many refusals are quoted before the rest are only counted. */
export const SOURCE_REFUSAL_LIMIT = 20;

export function SourceRefusal({
  parsed,
  id,
  className,
}: {
  parsed: Pick<ParsedList, "lines" | "issues">;
  /** For the box's `aria-describedby`, so a screen reader in the box hears why too. */
  id?: string;
  /** The face's type size — the desktop's 11px or the phone's `text-xs`. */
  className?: string;
}): JSX.Element | null {
  if (parsed.lines.length > 0 || parsed.issues.length === 0) return null;

  const shown = parsed.issues.slice(0, SOURCE_REFUSAL_LIMIT);
  const more = parsed.issues.length - shown.length;
  return (
    <div id={id} className={cn("space-y-1", className)}>
      <p className="text-dim">Nothing here can be imported:</p>
      <ul className="relative max-h-32 space-y-1 overflow-y-auto rounded-md border border-border px-3 py-1.5">
        {shown.map((issue) => (
          <li key={`${issue.lineNumber}:${issue.raw}`}>
            <span className="block truncate font-mono text-dim">
              line {issue.lineNumber} · &ldquo;{issue.raw.trim()}&rdquo;
            </span>
            <span className="block">{issue.reason}</span>
          </li>
        ))}
        {more > 0 && <li className="text-dim">…and {more} more</li>}
      </ul>
    </div>
  );
}
