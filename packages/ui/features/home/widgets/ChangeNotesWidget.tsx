/**
 * What the newest releases changed, as the build carries them — the version history's top rows,
 * opened, on the home page (issue #905).
 *
 * **A body, not a card.** `WidgetCard` draws the title, the settings popover (the registry's
 * `Releases to show` pick and `Highlights only` switch) and the Customize tray; this draws one
 * section per release — the version and its day over its notes. The body's scroller is the card's,
 * so a release body longer than its box scrolls like every other widget's and nothing here says
 * anything about scrolling.
 *
 * ## This build's notes, on every host
 *
 * **`useBundledHistory`, never `useReleaseHistory`.** The bundled history is `changelog/<version>.md`
 * read at build time, up to and including the running version — so the card says *what changed in
 * the app you are using*, offline, on the desktop, the phone and the web alike, and asks no host
 * anything. The updater's cached GitHub page would draw a release this install has not taken yet as
 * though it were news about the app on screen; an offered update is the ribbon's to announce and
 * Settings' to describe. The chunk is fetched the first time a card of this kind mounts, which is
 * `useBundledHistory`'s own laziness: a page without one never fetches it.
 *
 * ## Highlights, and a release that has none
 *
 * The generator opens a release body with `### Highlights` — the two or three things a reader
 * should hear about — before the full `New` / `Changed` / `Fixed` lists. `Highlights only` cuts a
 * body to that section ({@link highlightsOf}); a body with no such section (every release before the
 * generator, and a hand-written one) is drawn whole rather than as nothing, because an empty
 * release reads as a failure to load.
 *
 * `All versions` opens Settings on its Updates panel, which both editions draw — the desktop's
 * updater panel and the light edition's `VersionPanel` share the `updates` id.
 */
import type { ReactElement } from "react";

import { ReleaseNotes } from "@/features/settings/ReleaseNotes";
import { FOCUS } from "@/lib/focus";
import type { ReleaseNote } from "@/lib/ipc";
import { PRESS_SOFT } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { useBundledHistory, type ReleaseHistory } from "@/lib/useReleaseHistory";
import { cn } from "@/lib/utils";

import type { WidgetFit } from "../fit";
import { WidgetMessage } from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";
import { pickOf, toggleOnOf } from "../widgetSettings";

export const PENDING = "Loading change notes…";
export const EMPTY = "No change notes in this build.";

/** What a stored `releases` pick that is somehow not a number reads as — the pick's own default. */
const RELEASES_FALLBACK = 1;

/** `### Highlights`, at any depth and in any case — the generator writes level three. */
const HIGHLIGHTS = /^(#{1,6})\s+highlights\s*$/i;
const HEADING = /^(#{1,6})\s+/;

/**
 * A release body cut to its `Highlights` section — the lines under that heading up to the next
 * heading of the same depth or shallower — **or the whole body where there is no such section, or
 * the section is empty**. The heading itself is dropped: the switch that asked for it already says
 * which section this is.
 */
export function highlightsOf(notes: string): string {
  const lines = notes.split(/\r?\n/);
  const start = lines.findIndex((line) => HIGHLIGHTS.test(line.trim()));
  if (start === -1) return notes;
  const depth = HIGHLIGHTS.exec(lines[start].trim())![1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const heading = HEADING.exec(lines[i].trim());
    if (heading !== null && heading[1].length <= depth) {
      end = i;
      break;
    }
  }
  const section = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return section === "" ? notes : section;
}

/**
 * The releases a card draws: the newest `count`, each body cut to its highlights where the reader
 * asked for that. Pure, so the two settings are tested without a render.
 */
export function shownReleases(
  releases: readonly ReleaseNote[],
  { count, highlights }: { count: number; highlights: boolean },
): ReleaseNote[] {
  return releases
    .slice(0, Math.max(1, count))
    .map((release) => (highlights ? { ...release, notes: highlightsOf(release.notes) } : release));
}

/**
 * One answer, drawn: a refusal, the loading line, the empty sentence, or a section per release.
 *
 * **The day is dropped on a two-cell tile**, where the version and `All versions` already fill the
 * line; the version is the one fact a reader cannot recover from anything else on the card.
 */
export function ChangeNotesFace({
  history,
  count,
  highlights,
  fit,
  still,
}: {
  history: ReleaseHistory;
  count: number;
  highlights: boolean;
  fit: WidgetFit;
  still: boolean;
}): ReactElement {
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setPendingSettingsPanel = useAppStore((s) => s.setPendingSettingsPanel);

  if (history.error !== null) {
    return <WidgetMessage tone="destructive">{history.error}</WidgetMessage>;
  }
  if (history.loading) return <WidgetMessage>{PENDING}</WidgetMessage>;

  const shown = shownReleases(history.releases, { count, highlights });
  if (shown.length === 0) return <WidgetMessage>{EMPTY}</WidgetMessage>;

  const tile = fit.tier === 0;
  // The view first, then the hand-off — the view change is what clears every hand-off
  // (`ToReviewWidget`'s `open` argues it).
  const openHistory = () => {
    setActiveView("settings");
    setPendingSettingsPanel("updates");
  };

  return (
    <>
      {shown.map((release, i) => (
        <section
          key={release.tag}
          aria-label={`Release ${release.version}`}
          className={cn("min-w-0 shrink-0", i > 0 && "border-t border-border/60 pt-2")}
        >
          <div className="flex min-w-0 items-baseline gap-2 pb-1.5">
            {/* A version is data, and data is Geist Mono — `VersionHistory`'s row. */}
            <span className="font-mono text-sm tabular-nums text-text">{release.version}</span>
            {!tile && release.publishedAt !== null && (
              <span className="truncate text-xs text-dim">{release.publishedAt.slice(0, 10)}</span>
            )}
            {i === 0 && !still && (
              <button
                type="button"
                onClick={openHistory}
                className={cn(
                  "ml-auto shrink-0 rounded-sm text-xs text-dim hover:text-text",
                  PRESS_SOFT,
                  FOCUS,
                )}
              >
                All versions
              </button>
            )}
          </div>
          <ReleaseNotes notes={release.notes} />
        </section>
      ))}
    </>
  );
}

export function ChangeNotesWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const history = useBundledHistory();
  const picked = pickOf(widget, "releases");
  const count = typeof picked === "number" ? picked : RELEASES_FALLBACK;
  return (
    <ChangeNotesFace
      history={history}
      count={count}
      highlights={toggleOnOf(widget, "highlights")}
      fit={fit}
      still={still}
    />
  );
}
