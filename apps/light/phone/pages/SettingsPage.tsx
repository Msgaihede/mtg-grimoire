import { useId, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { CachePanel } from "@grimoire/ui/features/settings/CachePanel";
import { DangerZonePanel } from "@grimoire/ui/features/settings/DangerZonePanel";
import { ErrorLogPanel } from "@grimoire/ui/features/settings/ErrorLogPanel";
import { HiddenTagsPanel } from "@grimoire/ui/features/settings/HiddenTagsPanel";
import { LabelsPanel } from "@grimoire/ui/features/settings/LabelsPanel";
import { MarketplacePanel } from "@grimoire/ui/features/settings/MarketplacePanel";
import { PrivacyLink } from "@grimoire/ui/features/settings/PrivacyLink";
import { ReviewPanel } from "@grimoire/ui/features/settings/ReviewPanel";
import { SyncPanel } from "@grimoire/ui/features/settings/SyncPanel";
import { TheoryMarksPanel } from "@grimoire/ui/features/settings/TheoryMarksPanel";
import {
  GROUPS,
  PANELS,
  groupsOf,
  panelsOf,
  type BadgeId,
  type GroupId,
} from "@grimoire/ui/features/settings/nav";
import { useDangerZone, useLocalCache } from "@grimoire/ui/features/settings/useDataReset";
import { useHiddenTags } from "@grimoire/ui/features/settings/useHiddenTags";
import { count } from "@grimoire/ui/lib/counts";
import { LIGHT_SETTINGS, type LightPanel } from "@grimoire/ui/lib/edition";
import { FOCUS_INSET } from "@grimoire/ui/lib/focus";
import { ipc } from "@grimoire/ui/lib/ipc";
import { LAYER } from "@grimoire/ui/lib/layers";
import { REVIEW_KEY } from "@grimoire/ui/lib/query";
import { useErrorLog, type ErrorLog } from "@grimoire/ui/lib/useErrorLog";
import { useMarketplace } from "@grimoire/ui/lib/useMarketplace";
import { cn } from "@grimoire/ui/lib/utils";

/**
 * The light edition's panels, in the desktop's drawing order, and the groups that hold them.
 *
 * **Read from the edition's own list, so the two faces cannot list different Settings.** Spec
 * §3.1 makes Settings' entry list the edition's to answer; `LIGHT_SETTINGS` is that answer, the
 * desktop face's `SettingsPage` reads it through `LIGHT_EDITION`, and this page reads it
 * directly — the phone face *is* the light edition, so there is no context to ask. Module
 * constants, because nothing about them moves while the app runs.
 */
const PANEL_LIST = panelsOf(LIGHT_SETTINGS) as LightPanel[];
const GROUP_LIST = groupsOf(PANEL_LIST);

/**
 * One panel, with the state it is drawn over.
 *
 * **Each hook is called by the panel that needs it, so a closed group asks the backend
 * nothing** — the desktop page holds every hook for every panel because its rail and its pane
 * are one component; here a group's panels mount only while it is open. The one exception is the
 * error log, which the page holds for its row's count and hands down, so the count and the panel
 * read one list.
 *
 * A `switch` over {@link LightPanel} with no `default`: a panel added to the light edition is a
 * compile error here rather than a group that opens on nothing.
 */
function Panel({ id, log }: { id: LightPanel; log: ErrorLog }): JSX.Element {
  switch (id) {
    case "prices":
      return <Prices />;
    case "sync":
      // The desktop's own panel. Where the host offers a membership (the web app), *Connect
      // Patreon* leaves through `@/lib/core`'s host seam, as a new tab. The Android host offers
      // none, and the panel draws that host's sentence in its place (`@/lib/core/hostMembership`).
      return <SyncPanel />;
    case "review":
      return <ReviewPanel />;
    case "hidden-tags":
      return <HiddenTags />;
    case "theory-marks":
      return <TheoryMarksPanel />;
    case "labels":
      return <LabelsPanel />;
    case "cache":
      return <Cache />;
    case "errors":
      return <ErrorLogPanel log={log} />;
    case "danger":
      return <Danger />;
  }
}

function Prices(): JSX.Element {
  const marketplace = useMarketplace();
  return <MarketplacePanel marketplace={marketplace} />;
}

function HiddenTags(): JSX.Element {
  const hidden = useHiddenTags();
  return <HiddenTagsPanel hidden={hidden} />;
}

function Cache(): JSX.Element {
  const cache = useLocalCache();
  return <CachePanel cache={cache} />;
}

function Danger(): JSX.Element {
  const danger = useDangerZone();
  return <DangerZonePanel danger={danger} />;
}

/**
 * Settings, on the phone: the light edition's groups as a list, each opening its panels beneath
 * it.
 *
 * **The groups are the desktop rail's, and the panels are the desktop's own components** — the
 * same words, the same order, and the same controls at both widths. What the phone changes is the
 * layout: the rail and the pane cannot stand side by side at 360px, so the rail becomes this
 * list and a group's panels open under its row. **One group is open at a time**: a second press
 * closes the first, so the list never grows into a scroll of every panel at once — the one the
 * desktop page left on 2026-09-03.
 *
 * **In the page and not in the URL**, deliberately. `routes.ts` is the one grammar both faces
 * read and it names no group, so Back from an open group leaves Settings as it does from a closed
 * one; a group in the URL would be a change to that grammar and to the desktop's adapter.
 *
 * **No search box.** The desktop's answers a reader with a word rather than a category across
 * every panel it has; this list is six rows on one screen, and the box would cost the screen's
 * first line to find what is already on it.
 *
 * Nothing here asks where it is running or which edition it is: this face draws the light
 * edition and nothing else.
 */
export function SettingsPage(): JSX.Element {
  const [open, setOpen] = useState<GroupId | null>(null);
  const stem = useId();
  const log = useErrorLog();
  /** What is waiting in the review queue, on `ReviewPanel`'s own key — the desktop rail's `Sync`
   *  count, read for the same reason: the row has to count while its panel is not mounted. */
  const review = useQuery({ queryKey: REVIEW_KEY, queryFn: () => ipc.syncReviewList() });
  const badges: Record<BadgeId, number> = {
    review: review.data?.length ?? 0,
    errors: log.entries.length,
  };

  return (
    // `relative` because this is the scroll container: `packages/ui/CLAUDE.md`'s rule, so an `sr-only`
    // inside a panel is laid out here and not against the document.
    <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain select-text">
      {/* The column the desktop's panels were written for (`max-w-2xl`), so a tablet-wide phone face
          does not run their prose to a hundred characters a line. */}
      <ul aria-label="Settings sections" className="mx-auto max-w-2xl">
        {GROUP_LIST.map((id) => {
          const meta = GROUPS[id];
          const expanded = open === id;
          const badge = meta.badge === undefined ? 0 : badges[meta.badge];
          // The whole name in one string, the rail's rule and its reason: a count in a sibling
          // element folds into the name with no space before it.
          const name = badge > 0 ? `${meta.label} (${count(badge)})` : meta.label;
          const body = `${stem}-${id}`;
          return (
            <li key={id} className="border-b border-border">
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={expanded ? body : undefined}
                aria-label={name}
                onClick={() => setOpen(expanded ? null : id)}
                className={cn(
                  // 52px: the tab bar's height, and over the 44px touch floor.
                  "flex min-h-13 w-full items-center gap-3 bg-bg px-4 text-left text-base",
                  // An open group's row pins to the top of the list while its panels scroll under
                  // it, so the press that closes it is never a scroll away — and only within its
                  // own `<li>`, so the next group's row takes over rather than stacking. Opaque,
                  // and on the header rung `SettingsNav`'s pinned rail uses for the same pairing.
                  expanded ? cn("sticky top-0 border-b border-border text-text", LAYER.header) : "text-dim",
                  FOCUS_INSET,
                )}
              >
                <span className="min-w-0 flex-1 truncate">{meta.label}</span>
                {badge > 0 && (
                  <span aria-hidden className="shrink-0 font-mono text-sm tabular-nums text-accent">
                    {count(badge)}
                  </span>
                )}
                <ChevronDown
                  aria-hidden
                  className={cn("size-5 shrink-0", expanded && "rotate-180")}
                />
              </button>
              {expanded && (
                <div id={body} className="flex flex-col gap-8 px-4 pt-2 pb-8">
                  {PANEL_LIST.filter((panel) => PANELS[panel].group === id).map((panel) => (
                    <Panel key={panel} id={panel} log={log} />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {/* Under the last group, in the list's own column: Google Play asks for the policy's link
          in the app as well as on the listing, and this is every reader's last row. */}
      <p className="mx-auto max-w-2xl px-4 py-6">
        <PrivacyLink />
      </p>
    </div>
  );
}
