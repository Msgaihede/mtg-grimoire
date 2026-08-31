import { useQuery } from "@tanstack/react-query";
import { BackupPanel } from "@/features/settings/BackupPanel";
import { CachePanel } from "@/features/settings/CachePanel";
import { CombosPanel } from "@/features/settings/CombosPanel";
import { DangerZonePanel } from "@/features/settings/DangerZonePanel";
import { ErrorLogPanel } from "@/features/settings/ErrorLogPanel";
import { HiddenTagsPanel } from "@/features/settings/HiddenTagsPanel";
import { MarketplacePanel } from "@/features/settings/MarketplacePanel";
import { ReviewPanel } from "@/features/settings/ReviewPanel";
import { SyncPanel } from "@/features/settings/SyncPanel";
import { UpdatePanel } from "@/features/settings/UpdatePanel";
import { WebStoragePanel, useWebStorage } from "@/features/settings/WebStoragePanel";
import { useDangerZone, useLocalCache } from "@/features/settings/useDataReset";
import { useHiddenTags } from "@/features/settings/useHiddenTags";
import { SettingsSection } from "@/features/settings/panelChrome";
import { count } from "@/lib/counts";
import { ipc } from "@/lib/ipc";
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
 * Import is still a later plan's — the blurb near the foot stands in for the part that is
 * genuinely still missing, rather than hiding panels that exist. **The data folder left that
 * blurb on 2026-08-29** and has a section of its own now; the reason is at that section.
 *
 * **Ordered by what a press costs**, which is the one rule about this page's shape: updates,
 * prices, combos and errors first, since none of them throws anything away; then the cache,
 * which throws away bytes the app fetches again; then the three clears that cannot be taken
 * back, alone at the bottom in their own region. See `DangerZonePanel` for why that distance is
 * load-bearing rather than tidy.
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

  return (
    <div className="mx-auto max-w-2xl space-y-8 py-2">
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
      <UpdatePanel update={update} history={history} />

      <MarketplacePanel marketplace={marketplace} />

      {/* **Directly under Prices, because it is the same kind of thing.** Both are optional bulk
          feeds from a third party that the app works entirely without: a marketplace with no
          feed quotes em dashes, and a database with no combos estimates a bracket from three
          signals instead of four. Nothing here throws anything away either, so it stays in the
          page's first group. It reaches the backend itself — see `CombosPanel`, and
          `BackupPanel` for the rule it follows. */}
      <CombosPanel />

      {/* Above the error log rather than below it, because this is the page's only *undo*: the
          rail tells a reader who has just hidden a tag that Settings is where it comes back, and
          the shorter the scroll from the top of the page to that list, the fewer of them give up
          on the way. Everything below is either a report or a deletion. */}
      <HiddenTagsPanel hidden={hidden} />

      {/* **Still in the group that throws nothing away**, which is the page's one ordering rule,
          and below the undo above it because that one is what a reader arrives here looking for.
          Removing a device is the sharpest press on this panel and it is not a clear: the copies,
          the decks and the wishlist are untouched, and what changes is which other machine can
          read what comes next. It reaches the backend itself — `BackupPanel`'s rule, and its
          reason exactly: nothing else in the window reads `sync_pairing_status`. */}
      <SyncPanel />

      {/* **Directly under Sync, because it is what sync asks of a reader.** The rows here are
          the two outcomes §7.4 surfaces — a row another device deleted while this one was still
          editing it, a folder move that would have made a loop — plus every printing the card
          reconciler flagged long before a relay existed. One column, one queue.

          Still in the group that throws nothing away, and that is a judgement rather than an
          oversight: *Looks fine* deletes a sentence and touches no card, no deck and no copy.
          What it must stay above is the error log, because a reader who has just synced is
          looking for this and not for a fault list. It reaches the backend itself —
          `BackupPanel`'s rule, and `SyncPanel`'s reason directly above it. */}
      <ReviewPanel />

      <ErrorLogPanel log={log} />

      {/* **The two facts that reached the reader at exactly one place each, and that place was a
          hover tooltip** on the ribbon's status line — `Ribbon.tsx:96` names the folder and
          `:97–98` appends the failure count. A phone has no hover, and 9a's touch census found
          by grep that there was no second door to either. This is that second door and not a
          move: the tooltip stays exactly as it was, so a pointer reader loses nothing.

          **Here rather than inside `Local cache` below**, which was the other candidate. The
          count's own sentence blames the *folder* — read-only, or full — and Clear cache's text
          says in as many words that the collection, the decks and the covers kept in that folder
          are **not** what it sweeps; a path printed under that heading would read as the cache's
          own directory rather than as the place everything lives. It sits above `Backup` and
          `Local cache` because those two are this page's other panels about that folder and this
          one is what names it, and directly below the error log because a failed image *fetch*
          is a row in that log while a failed image *write* is this line — the two halves of one
          question a reader arrives with. It presses nothing at all, so the page's "ordered by
          what a press costs" rule leaves it free to sit wherever it reads best.

          **No platform gate, because every target answers `dataDir`**: the web build reports
          `OPFS:/…` (`src-tauri/src/web/glue.rs:92`), which is still the true answer to "where
          does this keep my data". */}
      <SettingsSection id="data-folder" title="Data folder">
        <p className="text-sm text-dim">
          Where this app keeps everything: the card database, your collection, your decks, and
          the card images it has cached.
        </p>
        {/* `break-all` because a Windows path has nothing to break at and this column is 42rem
            on a desk and ~350px on a phone — the surface this whole plan is for. */}
        <p className="break-all font-mono text-sm">{folder.data?.dataDir ?? "Not known yet."}</p>
        {/* Plain text when there is something to report rather than the destructive red, which
            is `ErrorLogPanel`'s tone and its reason: every affected image still displays — the
            bytes were in hand when the write failed — so nothing on screen is broken. Dim when
            the answer is "none", because a settled question should not draw the eye. */}
        <p className={cn("text-sm", folder.data?.imageStoreFailures ? "text-text" : "text-dim")}>
          {imageFailureLine(folder.data?.imageStoreFailures)}
        </p>
      </SettingsSection>

      {/* Still in the group that throws nothing away, and beside the cache because the two are
          this page's only panels about the folder on disk — one says what is kept there and the
          other what can be swept out of it. Above it rather than below for the ordering rule:
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
      <BackupPanel />

      <CachePanel cache={cache} />

      {/* Web only: none of these rows means anything in a window that owns its own disk.
          `isWebTarget()` is a build-time constant, so on desktop this subtree is not merely
          hidden - nothing under it is ever constructed.

          Beside the cache because these are the page's two panels about where the bytes
          live, and this one throws nothing away either. */}
      {isWebTarget() && <WebStoragePanel storage={webStorage} />}

      <section aria-labelledby="later-heading" className="space-y-2">
        <h2 id="later-heading" className="font-heading text-lg leading-none text-dim">
          Not here yet
        </h2>
        {/* Export left this list when the mirror landed — the panel above writes every deck,
            the collection and the wishlist in all seven formats, continuously, which is more
            than this line ever promised. Import is still the dialog's alone.

            Sync behaviour left it when the relay landed: an address, what is waiting and a
            press that makes a round trip are on this page now, in the Sync panel above. A
            "coming later" line for something a reader can scroll up and use is the kind of rot
            neither CI job can see.

            The data folder left it on 2026-08-29 for exactly that reason — the section above
            names it, and a phone reader had no other way to that fact at all. Import is what is
            left, and it is genuinely still the dialog's alone. */}
        <p className="text-sm text-dim">Import. Coming in a later plan.</p>
      </section>

      {/* **Last on the page, under the blurb about what is still missing, and deliberately so.**
          Everything above is a setting; these three empty the app for good. Distance is the only
          thing standing between a reader scrolling for the error log and the button that deletes
          their collection — the typed word inside the dialog is the second fence, not the
          first. */}
      <DangerZonePanel danger={danger} />
    </div>
  );
}
