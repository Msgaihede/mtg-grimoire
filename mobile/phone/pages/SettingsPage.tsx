import { useId, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { CachePanel } from "@/features/settings/CachePanel";
import { DangerZonePanel } from "@/features/settings/DangerZonePanel";
import { ErrorLogPanel } from "@/features/settings/ErrorLogPanel";
import { HiddenTagsPanel } from "@/features/settings/HiddenTagsPanel";
import { LabelsPanel } from "@/features/settings/LabelsPanel";
import { MarketplacePanel } from "@/features/settings/MarketplacePanel";
import { ReviewPanel } from "@/features/settings/ReviewPanel";
import { SyncPanelBody, type OpenLink } from "@/features/settings/SyncPanelBody";
import { TheoryMarksPanel } from "@/features/settings/TheoryMarksPanel";
import {
  GROUPS,
  PANELS,
  groupsOf,
  panelsOf,
  type BadgeId,
  type GroupId,
} from "@/features/settings/nav";
import { useDangerZone, useLocalCache } from "@/features/settings/useDataReset";
import { useHiddenTags } from "@/features/settings/useHiddenTags";
import { count } from "@/lib/counts";
import { LIGHT_SETTINGS, type LightPanel } from "@/lib/edition";
import { FOCUS_INSET } from "@/lib/focus";
import { ipc } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { REVIEW_KEY } from "@/lib/query";
import { useErrorLog, type ErrorLog } from "@/lib/useErrorLog";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";

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
 * How the Sync panel's *Connect Patreon* sends a reader to Patreon from here.
 *
 * **A new tab, through the page's own `window.open`**, because the desktop's opener is a Tauri
 * plugin the phone face may not reach. `null` back is a browser that refused the tab, which the
 * panel reports as a press that did not happen rather than one that silently did nothing. The
 * opener is cut afterwards so the page on the far side cannot steer this one.
 *
 * Spec §3.5 puts *open a link* below the `Core` seam, a host service the phases that build each
 * host (4 and 5) bring; when it lands this is replaced by it, here and in the `Open on …` rows
 * alike.
 */
const openLink: OpenLink = async (url) => {
  const opened = window.open(url, "_blank");
  if (opened === null) throw new Error("The link could not be opened.");
  opened.opener = null;
};

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
      return <SyncPanelBody openLink={openLink} />;
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
    // `relative` because this is the scroll container: `src/CLAUDE.md`'s rule, so an `sr-only`
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
    </div>
  );
}
