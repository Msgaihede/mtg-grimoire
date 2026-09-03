import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { BackupPanel } from "@/features/settings/BackupPanel";
import { CachePanel } from "@/features/settings/CachePanel";
import { CombosPanel } from "@/features/settings/CombosPanel";
import { DangerZonePanel } from "@/features/settings/DangerZonePanel";
import { ErrorLogPanel } from "@/features/settings/ErrorLogPanel";
import { HiddenTagsPanel } from "@/features/settings/HiddenTagsPanel";
import { MarketplacePanel } from "@/features/settings/MarketplacePanel";
import { ReviewPanel } from "@/features/settings/ReviewPanel";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { SyncPanel } from "@/features/settings/SyncPanel";
import { UpdatePanel } from "@/features/settings/UpdatePanel";
import { WebStoragePanel, useWebStorage } from "@/features/settings/WebStoragePanel";
import { visiblePanels, type BadgeId, type GroupId, type PanelId } from "@/features/settings/nav";
import { useDangerZone, useLocalCache } from "@/features/settings/useDataReset";
import { useHiddenTags } from "@/features/settings/useHiddenTags";
import { SettingsSection } from "@/features/settings/panelChrome";
import { count } from "@/lib/counts";
import { ipc } from "@/lib/ipc";
import { REVIEW_KEY } from "@/lib/query";
import type { Update } from "@/lib/useUpdate";
import { useErrorLog } from "@/lib/useErrorLog";
import { useMarketplace } from "@/lib/useMarketplace";
import { useReleaseHistory } from "@/lib/useReleaseHistory";
import { cn } from "@/lib/utils";
import { isWebTarget } from "@/pwa/target";

/**
 * What the Data folder section says about card images that could not be written to the cache.
 *
 * **One string, count and words together, rather than a number in a span beside a word.** Two
 * elements compute to a single accessible name with no space between them — `Missing2` — and
 * jsdom cannot referee it, so a test would have to hedge with `\s*` and would then pass either
 * way. Sentence-shaped for the same reason `ErrorLogPanel` keeps its own line in plain text:
 * nothing here is an alarm.
 *
 * `undefined` is "the read has not answered yet", never zero. `imageStoreFailures` is a counter
 * in the running process rather than a database read, so the backend answers it on every poll
 * that comes back at all — the only way to have no number is to have no answer.
 */
export function imageFailureLine(failures: number | undefined): string {
  if (failures === undefined) return "Checking whether any card images failed to save…";
  if (failures === 0) return "No card images have failed to save this session.";
  return (
    `${count(failures)} card image${failures === 1 ? "" : "s"} could not be saved there ` +
    "this session — the folder may be read-only or full."
  );
}

/**
 * Settings.
 *
 * **A rail of six entries and a pane, since 2026-09-03.** This page was one scroll of twelve
 * panels until then, and the scroll's own rule — *ordered by what a press costs* — is still the
 * rule, but it survives **inside a group** rather than down the length of the page. An ordering
 * only helps a reader who already knows what they are scrolling towards; a rail is what tells
 * them, and the search box beside it is what answers the reader who has a word rather than a
 * category ("dropbox", "tcgplayer", "patreon").
 *
 * **`nav.ts` decides what is drawn and this file only draws it.** Which panels a group holds and
 * which panels a query matches are both decidable with no DOM, so they are a pure module with a
 * suite of its own; `visiblePanels(group, query, isWeb)` is the whole of that decision and
 * nothing here re-derives any part of it. What this page still owns is the two pieces of state
 * the decision is taken over — the current group and the query — plus every hook the panels are
 * fed from.
 *
 * **Picking a group clears the query and scrolls the page back to the top.** The clear is
 * `nav.ts`'s rule read from this side: a query outranks the group, so the two states must never
 * both apply. The scroll is the plainer of the two — the scroller is `AppShell`'s `<main>`, a
 * reader deep in `Storage and data` who presses `Updates` would otherwise land halfway down a
 * pane that is now one panel long, looking at nothing.
 *
 * Import is still a later plan's, and the blurb that said so has **left this page for the rail**
 * — see the note where it used to stand, above `Clear data`.
 *
 * `useLocalCache` and `useDangerZone` are hooked up here for the error log's reason — nothing
 * else in the window writes to those tables, so there is no second caller to race.
 *
 * `update` is passed in rather than hooked up here: `AppShell` already owns it for the
 * ribbon's button, and a second `useUpdate()` would be a second `update:progress` listener
 * racing to describe the same download. The error log is the opposite and is hooked up
 * *here*, because nothing else in the window reads it — it is not polled, it has no
 * listener, and there is no second surface for it to race.
 *
 * The version history is hooked up here for the error log's reason and one more of its own:
 * it reads a row the update check already wrote, so there is nothing in flight for a second
 * caller to race — and hooking it in `AppShell` beside `useUpdate` would fetch thirty release
 * bodies at launch for a panel most sessions never open. It takes `lastCheckAt` so that
 * pressing Check now moves its query key and refreshes the list.
 *
 * The marketplace is hooked up here for the same reason arrived at from the other side. Half
 * the window reads it — every price surface asks `useMarketplace()` for its currency — and
 * that is precisely why a second call here is free: it is one TanStack Query entry with
 * `staleTime: Infinity`, so every caller is reading the same cached answer rather than opening
 * a second channel to the backend. There is nothing to race, and threading it down from
 * `App.tsx` would buy nothing but a prop.
 *
 * `BackupPanel` and `CombosPanel` take no props at all and reach the backend themselves, which
 * is the same argument from one step further along: the mirror has no second reader in the
 * window, and the combo status has one — the deck editor's bracket advisory — that is reading
 * the very same cache entry. Either way `SettingsPage` would be holding a hook only to hand its
 * answer straight back down.
 */
export function SettingsPage({ update }: { update: Update }) {
  /**
   * Which rail entry is current, and what is in the search box.
   *
   * `updates` is where a reader lands, and it is the group the ribbon's gold button points at —
   * "there is a new version" is the one thing that sends somebody to this page without their
   * having chosen to come.
   */
  const [group, setGroup] = useState<GroupId>("updates");
  const [query, setQuery] = useState("");
  /**
   * The page's own root, so that picking a group can put the reader back at the top of it.
   *
   * The scroller is `AppShell.tsx`'s `<main>` and this element is inside it, so scrolling *this*
   * into view is the same instruction with none of the reaching: nothing here has to know which
   * ancestor happens to carry the `overflow`.
   */
  const root = useRef<HTMLDivElement>(null);

  const log = useErrorLog();
  const marketplace = useMarketplace();
  const history = useReleaseHistory(update.status?.lastCheckAt ?? null);
  const cache = useLocalCache();
  const danger = useDangerZone();
  const hidden = useHiddenTags();
  // Called unconditionally, `useLocalCache`'s shape, and inert on desktop: every read inside
  // it is behind `isWebTarget()`, which is a build-time constant.
  const webStorage = useWebStorage();
  /**
   * The two facts the Data folder section below draws, read here rather than through a second
   * `useSync()`.
   *
   * **A query and not that hook**, which is `useErrorLog`'s shape and its argument: `useSync`
   * runs a chained poll of its own — 30 s idle, 1 s mid-sync — and a second instance would be
   * two loops describing one database, which is the reason `useWebStorageLifecycle` gives at
   * its own site for not calling it either. Nothing here needs a loop: the folder cannot move
   * while the process runs, and the counter only moves while the reader is looking at cards
   * rather than at this page. It loads when Settings opens, and `query.ts`'s 30 s `staleTime`
   * is what a reader who leaves and comes back is re-reading against.
   */
  const folder = useQuery({ queryKey: ["syncStatus"], queryFn: () => ipc.syncStatus() });
  /**
   * What is waiting in the review queue, read a second time on the same key `ReviewPanel` uses.
   *
   * **The duplication is free and deliberate, and it is `useMarketplace`'s argument again**: one
   * TanStack cache entry, two callers reading the same answer, no second channel to the backend
   * and nothing to race. What makes it a *second* call rather than a prop threaded up out of the
   * panel is where the number has to appear — the rail's `Sync` badge is drawn while the Sync
   * group is **not** selected, which is exactly when `ReviewPanel` is unmounted and holding no
   * hook at all. A badge that could only count while its own panel was on screen would be a
   * badge that never told anybody anything.
   */
  const review = useQuery({ queryKey: REVIEW_KEY, queryFn: () => ipc.syncReviewList() });
  /**
   * The two counts the rail draws, and a total `Record` so that a third badge cannot be declared
   * in `nav.ts` and then quietly never answered here.
   *
   * **`errors` caps at `ERROR_LOG_LIMIT` (50)**, because it is the length of the list the panel
   * asked for rather than the height of the table — the backend caps at 200 and folds repeats,
   * and 50 is what a person will scroll. A badge reading `50` therefore means "at least fifty",
   * which is the same thing the panel itself says by showing fifty rows.
   */
  const badges: Record<BadgeId, number> = {
    review: review.data?.length ?? 0,
    errors: log.entries.length,
  };

  const visible = visiblePanels(group, query, isWebTarget());
  const shown = (id: PanelId) => visible.includes(id);

  /**
   * Picking a rail entry.
   *
   * The clear is `nav.ts`'s rule (a query outranks the group, so the two must never both apply)
   * and the rail deliberately does not do it itself — it reports the press and this page decides
   * what a press *means*.
   *
   * **`scrollIntoView` is called optionally, and the `?.()` is required rather than defensive**:
   * jsdom implements no layout and simply does not define the method, which
   * `src/components/AnchoredPopup.test.tsx:16` records. Shimming it in the page would be putting
   * a lie about the environment into shipped code to keep a test quiet.
   */
  const pickGroup = (id: GroupId) => {
    setGroup(id);
    setQuery("");
    root.current?.scrollIntoView?.({ block: "start" });
  };

  return (
    /* **`max-w-4xl` (896px) rather than the 64rem the design asked for, and the difference is
       the pane's measure.** At 64rem the pane draws 760px and these panels' prose runs to ~106
       characters a line; at `max-w-4xl` it draws ~632px, within 40px of the `max-w-2xl` (42rem)
       column every one of them was written for. The rail took the width, so the pane must not
       also grow into it.

       The row **wraps** rather than branching on a breakpoint: `src/lib/viewports.ts` forbids
       `sm:`/`md:`/`lg:` outside `AppShell`, and none is needed — plain flex puts the rail above
       the pane when there is no room beside it, and the rail's own container query is what
       changes its shape when that happens. */
    <div ref={root} className="mx-auto flex max-w-4xl flex-wrap items-start gap-8 py-2">
      <SettingsNav
        group={group}
        onGroup={pickGroup}
        query={query}
        onQuery={setQuery}
        badges={badges}
      />

      {/* **`flex-[999_1_480px]`, and the 999 is load-bearing rather than a joke.** The rail runs
          a container query off its **own inline size** to decide whether it is standing beside
          the pane or wrapped above it. That only reads cleanly while the rail sits at its 232px
          basis whenever both are on one line — so the pane has to absorb effectively all of the
          free space. The design's 3-against-1 would put the rail at ~302px on a wide window and
          ~232px when wrapped-and-full-width is not in play either, and the query could not tell
          the two states apart. This is the first thing a reviewer will want to change back. */}
      <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-8">
        {/* **Drawn on every target again, and this reverses half of PR #315.** That change hid
            the whole panel behind `!isWebTarget()`, which was right while nothing on it worked:
            `update_status` and `update_history` answered `unknown command` in a browser, and the
            panel's own `installKind === "managed"` test could not save it, because that reads an
            answer from `update_status` — so on web it read the *absence* as "not managed" and
            drew the controls anyway. Driven on the phone 2026-08-30, that was the last
            `unknown command` in the app.

            What it cost was the nearest thing to an About screen, which #315 said out loud was
            worth having and was a different thing to build. This is that thing: `update_status`
            and `update_history` are routed by `web::route` now, the browser answers
            `installKind: "web"`, and the panel draws the mark, the name and the version and
            names the service worker in place of a Download button. **The gate moved from the
            build target onto a backend answer**, which is the general lesson #315 wrote down.

            **`update_check` followed on 2026-08-31, and the download did not** — "check and
            notes, no download". It is still *absent* from `COMMANDS` rather than unrouted:
            `web::route::call` is synchronous, so no `async` command can be an arm there at all.
            It is `glue::update_check`, a `#[wasm_bindgen]` entry beside the four feed ingests,
            with the name diverted in `src/lib/core/browser.ts` — which is why nothing on this
            page took a branch for it. What it buys is the panel's other half: only a check ever
            writes the `app_meta` row `update_history` reads, so routing that command without
            this one was a version history that answered `[]` for ever.

            `update_download`, `update_apply` and `update_open_release_page` stay desktop's —
            they verify a checksum, unpack a zip beside a running `.exe` and relaunch it — and
            `update::pick_asset` answers `None` for `web` and `managed`, so the panel offers no
            button that reaches one. */}
        {shown("updates") && <UpdatePanel update={update} history={history} />}

        {shown("prices") && <MarketplacePanel marketplace={marketplace} />}

        {/* **Directly under Prices, because it is the same kind of thing** — and that argument is
            now what puts the two of them under one rail entry rather than what puts one below the
            other on a scroll. Both are optional bulk feeds from a third party that the app works
            entirely without: a marketplace with no feed quotes em dashes, and a database with no
            combos estimates a bracket from three signals instead of four. `Card data` is the
            question they both answer, which is why `nav.ts` gives them one entry between them.
            Nothing here throws anything away either, so it stays second within that group. It
            reaches the backend itself — see `CombosPanel`, and `BackupPanel` for the rule it
            follows. */}
        {shown("combos") && <CombosPanel />}

        {/* **First in `Sync`, and still in the group that throws nothing away.** Removing a device
            is the sharpest press on this panel and it is not a clear: the copies, the decks and
            the wishlist are untouched, and what changes is which other machine can read what
            comes next. It reaches the backend itself — `BackupPanel`'s rule, and its reason
            exactly: nothing else in the window reads `sync_pairing_status`.

            What used to be here as well was an argument about sitting *below* the hidden-tags
            undo on one long scroll. That argument has moved to the rail, where `Tags` and `Sync`
            are two entries a reader picks between rather than two stops on a journey down a
            page. */}
        {shown("sync") && <SyncPanel />}

        {/* **Directly under Sync, because it is what sync asks of a reader.** The rows here are
            the two outcomes §7.4 surfaces — a row another device deleted while this one was still
            editing it, a folder move that would have made a loop — plus every printing the card
            reconciler flagged long before a relay existed. One column, one queue. That adjacency
            is the whole reason the two share a rail entry, and the `Sync` badge counts *these*
            rows: it is what is waiting, drawn on the entry rather than only on the panel.

            Still in the group that throws nothing away, and that is a judgement rather than an
            oversight: *Looks fine* deletes a sentence and touches no card, no deck and no copy.
            It used to have to stay above the error log, on the grounds that a reader who has just
            synced is looking for this and not for a fault list; with `Errors` an entry of its own
            that is the rail's job now and no longer an ordering constraint here. It reaches the
            backend itself — `BackupPanel`'s rule, and `SyncPanel`'s reason directly above it. */}
        {shown("review") && <ReviewPanel />}

        {/* The page's one *undo*, and the only panel in `Tags`. The argument that used to sit here
            was about distance — the rail's live line tells a reader who has just hidden a tag that
            Settings is where it comes back, and the shorter the scroll to that list, the fewer of
            them give up on the way. That argument is now **won by the rail** rather than by this
            panel's position: `Tags` is one press from anywhere in Settings and from the sentence
            that sent them here, which is shorter than any scroll could be. Worth keeping because
            it is the reason this panel exists at all. */}
        {shown("hidden-tags") && <HiddenTagsPanel hidden={hidden} />}

        {/* **The two facts that reached the reader at exactly one place each, and that place was a
            hover tooltip** on the ribbon's status line — `Ribbon.tsx:96` names the folder and
            `:97–98` appends the failure count. A phone has no hover, and 9a's touch census found
            by grep that there was no second door to either. This is that second door and not a
            move: the tooltip stays exactly as it was, so a pointer reader loses nothing.

            **Here rather than inside `Local cache` below**, which was the other candidate. The
            count's own sentence blames the *folder* — read-only, or full — and Clear cache's text
            says in as many words that the collection and the decks kept in that folder
            are **not** what it sweeps; a path printed under that heading would read as the cache's
            own directory rather than as the place everything lives. It is **first in `Storage and
            data`**, above `Backup` and `Local cache`, because those two are the group's other
            panels about that folder and this one is what names it. It presses nothing at all, so
            the "ordered by what a press costs" rule leaves it free to sit wherever it reads best.

            What did not survive the regrouping is the other half of that placement — *directly
            below the error log*, because a failed image **fetch** is a row in that log while a
            failed image **write** is this line. Those two are now in different groups, so the
            pairing only happens when a reader searches; `nav.ts` keeps them one apart in the
            global order, which is the most that arrangement can still buy.

            **No platform gate, because every target answers `dataDir`**: the web build reports
            `OPFS:/…` (`src-tauri/src/web/glue.rs:92`), which is still the true answer to "where
            does this keep my data". */}
        {shown("data-folder") && (
          <SettingsSection id="data-folder" title="Data folder">
            <p className="text-sm text-dim">
              Where this app keeps everything: the card database, your collection, your decks, and
              the card images it has cached.
            </p>
            {/* `break-all` because a Windows path has nothing to break at and this pane is ~632px
                on a desk and ~350px on a phone — the surface this whole plan is for. */}
            <p className="break-all font-mono text-sm">
              {folder.data?.dataDir ?? "Not known yet."}
            </p>
            {/* Plain text when there is something to report rather than the destructive red, which
                is `ErrorLogPanel`'s tone and its reason: every affected image still displays — the
                bytes were in hand when the write failed — so nothing on screen is broken. Dim when
                the answer is "none", because a settled question should not draw the eye. */}
            <p
              className={cn("text-sm", folder.data?.imageStoreFailures ? "text-text" : "text-dim")}
            >
              {imageFailureLine(folder.data?.imageStoreFailures)}
            </p>
          </SettingsSection>
        )}

        {/* Beside the cache because the two are this group's only panels about the folder on disk
            — one says what is kept there and the other what can be swept out of it. Above it
            rather than below for the ordering rule, which is what survives the regrouping intact:
            the mirror deletes nothing a reader owns, and Clear cache does.

            **On every platform since 2026-08-31, and the `!isAndroid()` that used to stand here is
            the interesting part of the history.** The mirror's whole point is a folder a reader
            opens in a text editor, syncs with Dropbox or greps; on Android that directory is
            reachable mainly through a file-manager app and often not by other apps at all, and
            `tauri-plugin-dialog`'s manifest records the platform as having no folder picker, so
            the root could not even be chosen. All of that is still true — so the panel was hidden
            outright, which took the *feature* away along with the folder.

            It is back because the folder and the backup are not the same thing. `BackupPanel`
            now dispatches on the platform itself: the folder where there is one, and everywhere
            else a button that renders the same files and hands over one archive. The gate that
            matters moved inside it, where a component can pick which backend it reads —
            `mirror_status` is not routed on the web target at all, and on Android it answers
            about a thread `lib.rs` never starts. */}
        {shown("backup") && <BackupPanel />}

        {shown("cache") && <CachePanel cache={cache} />}

        {/* Web only: none of these rows means anything in a window that owns its own disk.
            `panelsOn` filters it out on every other build off `isWebTarget()`, a build-time
            constant, so on desktop this subtree is not merely hidden - nothing under it is ever
            constructed.

            Beside the cache because these are the group's two panels about where the bytes
            live, and this one throws nothing away either. */}
        {shown("web-storage") && <WebStoragePanel storage={webStorage} />}

        {shown("errors") && <ErrorLogPanel log={log} />}

        {/* **What used to stand here is the `Not here yet` block, and it has left the page for the
            rail.** One dim heading over one sentence was cheap at the foot of a scroll and is not
            cheap as a thirteenth panel a group would have to hold; the sentence itself — import is
            still the dialog's alone — is the rail's now, where it reads as a note about the whole
            of Settings rather than as a section of one group.

            The record that block carried is worth keeping, because each line of it was a thing
            that stopped being missing. **Export** left the list when the mirror landed — `Backup`
            above writes every deck, the collection and the wishlist in all seven formats,
            continuously, which is more than the line ever promised. **Sync behaviour** left it
            when the relay landed: an address, what is waiting and a press that makes a round trip
            are all in the `Sync` group. **The data folder** left it on 2026-08-29, when the
            section above got a home of its own and a phone reader finally had a way to that fact
            at all. A "coming later" line for something a reader can reach in one press is the kind
            of rot neither CI job can see, which is why the list has been pruned three times. */}

        {/* **Last in `Storage and data`, and with no rail entry of its own — deliberately.**
            Everything above is a setting; these three empty the app for good. Distance is the only
            thing standing between a reader who came for something else and the button that deletes
            their collection — the typed word inside the dialog is the second fence, not the first.
            A rail entry would have turned that distance into one press from every visit to
            Settings, so `nav.ts` files these under the group whose data they empty and keeps the
            distance *inside* the pane, where it has always been. */}
        {shown("danger") && <DangerZonePanel danger={danger} />}

        {/* Only reachable while searching: a group is never empty, so `visiblePanels` can only
            answer nothing when a query matched nothing. Dim and one line, because a search that
            found nothing is not a failure — the box above is still full of the words that did
            not match, which is the whole of what the reader needs in order to try again. */}
        {visible.length === 0 && (
          <p className="text-sm text-dim">Nothing in Settings matches that.</p>
        )}
      </div>
    </div>
  );
}
