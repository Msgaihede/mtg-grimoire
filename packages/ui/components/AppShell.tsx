import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Bell, PanelLeftClose, PanelLeftOpen, TriangleAlert, type LucideIcon } from "lucide-react";
import {
  ActivityProvider,
  useRegisterActivity,
  useTopActivity,
} from "@/components/ActivityProvider";
import { ChromeStatus } from "@/components/ChromeStatus";
import { ManaLine } from "@/components/ManaLine";
import { NotificationsDialog } from "@/components/NotificationsDialog";
import { SyncProgress } from "@/components/SyncProgress";
import { TitleBar } from "@/components/TitleBar";
import { Toaster } from "@/components/Toaster";
import { NAV } from "@/components/nav";
import { useTooltip } from "@/components/tooltip/useTooltip";
import {
  useSidebarDrops,
  useSidebarDropTarget,
  type SidebarDrop,
} from "@/components/useSidebarDrops";
import { ipc, ipcError } from "@/lib/ipc";
import {
  ACTIVITY_DELAY_MS,
  comboActivity,
  marketplaceFeedActivity,
  oracleTagActivity,
  syncActivity,
  updateActivity,
} from "@/lib/activity";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { editionHas, useEdition } from "@/lib/edition";
import { PublishesContext, ReachContext } from "@/lib/reach";
import { DURATION, statusLine as statusLineMotion } from "@/lib/motion";
import { notify, useUnreadCount } from "@/lib/notifications";
import { matchesChord, matchesShortcut, shortcut } from "@/lib/shortcuts";
import { useAppStore, type ViewId } from "@/lib/store";
import { usePrefetchSearchOpen } from "@/features/search/useSearchOpen";
import { useShareAutoUpdate } from "@/features/collection/useShareAutoUpdate";
import { usePrefetchPanelWidth } from "@/features/search/usePanelWidth";
import { usePrefetchShelfFolds } from "@/features/shelves/useShelfFolds";
import { usePrefetchFolderPane } from "@/features/decks/useFolderPane";
import { useCardZoomPersistence } from "@/lib/useCardZoomPersistence";
import { useComboProgress } from "@/lib/useComboProgress";
import { useCrossWindowRefresh } from "@/lib/useCrossWindowRefresh";
import { useListViewPersistence } from "@/lib/useListViewPersistence";
import { useDelayedFlag } from "@/lib/useDelayedFlag";
import { useDeviceSyncInvalidation } from "@/lib/useDeviceSyncInvalidation";
import { useDeviceSyncLive } from "@/lib/useDeviceSyncLive";
import { useMarketplace, useMarketplaceProgress } from "@/lib/useMarketplace";
import { useMarkColorVars } from "@/lib/useMarkColors";
import { useNavCollapsed } from "@/lib/useNavCollapsed";
import { useNavLabels } from "@/lib/useNavLabels";
import { useOracleTagProgress } from "@/lib/useOracleTagProgress";
import { useStartViewHydration } from "@/lib/useStartView";
import { statusLine, useSync } from "@/lib/useSync";
import { useSyncInvalidation } from "@/lib/useSyncInvalidation";
import { useSyncProgress } from "@/lib/useSyncProgress";
import type { Update } from "@/lib/useUpdate";
import { cn } from "@/lib/utils";

/**
 * The `<nav>`'s id, so the toggle at its foot can point `aria-controls` at the region it is
 * opening and closing.
 *
 * A constant rather than the string written twice, because the failure is silent at both ends:
 * an `aria-controls` naming an element that does not exist is not a validation error anywhere,
 * and nothing in a jsdom test would notice the day one of the two spellings moved.
 */
const NAV_ID = "app-nav";

/**
 * The three chords this shell binds, looked up **once at module scope** rather than per press.
 *
 * `shortcut()` throws on an id the catalogue does not carry, which is the whole reason it is a
 * function; resolving here rather than inside the handler is what makes that throw arrive at
 * import time — before a render, before a keypress — so a renamed id is a suite that cannot even
 * load rather than a key that quietly stopped working.
 */
const SWITCH_VIEW = shortcut("global", "switchView");
const KEY_MAP = shortcut("global", "keyMap");
const NEW_WINDOW = shortcut("global", "newWindow");

/**
 * The list `Ctrl+1…9` is bound against, by index — `NAV` minus the one row that is not always
 * drawn.
 *
 * **Ten destinations against nine digits, and the one that goes without is `shared`, because
 * its row is _conditional_.** Somebody else's binder appears on the rail only once a link has
 * been opened, and a chord's whole value is that it does not move — a digit bound to a row that
 * comes and goes would either shift every digit after it, one press meaning two things to two
 * readers, or point at a row half the readers do not have. No amount of room would change that,
 * which is what makes it a filter rather than arithmetic. `Ctrl+0` is not a tenth step of the run
 * (`lib/shortcuts.ts` says why).
 *
 * **So `Ctrl+9` is Settings.** It was Playtesting from Home's arrival until the Tagger row left
 * the rail (issue #937 — tag search is the Search page's sidebar now), which made this list nine
 * long again. `nav.test.ts` pins the ninth entry **by name**, because a length can only say how
 * many rows are reached and never which, and it is the *which* a reader has in their fingers.
 * What `shared` lost was its only keyboard route, and that route was a *fallback* —
 * `features/collection/ShareFolderMenu.tsx` draws **Open a shared collection** beside the Share
 * control now. `docs/reference/keyboard-shortcuts.md` carries the record.
 *
 * Derived rather than written out, so a destination added to `NAV` joins the list by construction
 * and only a deliberate second *exclusion* could ever be a decision again.
 */
const CHORD_NAV = NAV.filter((n) => n.id !== "shared");

/**
 * The window: sidebar, header, and whatever view the store points at.
 *
 * Owns the sync status because everything that needs it lives here — the header's summary
 * line, Refresh button and mana line, and the first-run overlay — and one poll for the
 * whole app is the point of the arrangement.
 *
 * The activity provider is out here rather than inside `Shell`, because a store read by the
 * component that creates it is a store nothing else can be mounted above. Here it covers both
 * of today's writers *and* `children`, so a long job started from inside a view can describe
 * itself in the header with no rewiring.
 */
export function AppShell({ children, update }: { children: ReactNode; update: Update }) {
  return (
    <ActivityProvider>
      <Shell update={update}>{children}</Shell>
    </ActivityProvider>
  );
}

function Shell({ children, update }: { children: ReactNode; update: Update }) {
  const activeView = useAppStore((s) => s.activeView);
  // Which app this shell is drawing. A context value that never changes for the life of the
  // window, so naming it in a dependency list below costs nothing.
  const edition = useEdition();
  const setActiveView = useAppStore((s) => s.setActiveView);
  // Only its length is read, and only to decide whether the rail draws the Shared row — see
  // `entries` below.
  const openedShares = useAppStore((s) => s.openedShares);
  // The flag `TitleBar` draws the map from and this component's `F1` turns over — see its doc in
  // `store.ts` for why one press and one panel need a store between them.
  const setKeyMapOpen = useAppStore((s) => s.setKeyMapOpen);
  const { status, error, refresh, refreshing, upToDate } = useSync();
  const progress = useSyncProgress();
  // The sidebar is the one part of the window that is always on screen, which is what makes
  // it the place a card can be dropped from any view — the Search wall and the deck editor
  // never coexist, so without this a card found in Search has nowhere to go.
  const drops = useSidebarDrops();
  /**
   * Whether the rail is 68px of icons or 208px of labels (issue #177).
   *
   * **Called once, here**, for the reason every other "exactly one of these in the app" mount in
   * this component has: the shell is the only thing that draws the rail, and a second observer
   * would be a second optimistic write racing the first. The hook keeps the answer in
   * `app_meta`, so the choice outlives the process.
   *
   * **A read that fails answers `false`.** A database that cannot say must open the way the app
   * has always opened — its destinations named — rather than hiding them behind a mystery the
   * reader then has to guess their way out of.
   */
  const { collapsed, setCollapsed } = useNavCollapsed();
  /**
   * Whether the rail is wide enough to paint a word — **`collapsed`'s answer in one direction
   * and one tween later in the other**, which is the whole of the two bugs reported 2026-08-22.
   *
   * The rail's width is a CSS transition and its labels are a React commit, so a single flag
   * driving both meant the words arrived 180ms before the room for them: a column of labels re-entering
   * the flow at full width inside a 68px rail, painted over the view beside it for the length of
   * the tween, because `<nav>` cannot carry an `overflow-hidden` (the collapsed rail's floating
   * notes hang off it at `left-full`). `useNavLabels` holds them back until the rail has arrived
   * and the label sites then fade them in over `DURATION.instant`; going the other way it answers
   * in the same commit as the press, so the words are gone before the rail starts to move.
   *
   * **`useReducedMotion()` here is the per-component branch `App.tsx` sanctions**, not a second
   * app-wide switch: what it decides is not whether to animate but *how long the rail takes*,
   * and under `motion-reduce:transition-none` the answer is that it does not take any time at
   * all. A rail that snapped wide and then sat wordless for 180ms would be this bug again with
   * the sign flipped.
   */
  const reduced = useReducedMotion();
  const labels = useNavLabels(collapsed, reduced ? 0 : DURATION.base);
  /** The rail is down to icons, or on its way back out of them. */
  const narrow = !labels;
  /** The rail's inbox (`NotificationsDialog`) — open or not. Window state, never persisted. */
  const [inboxOpen, setInboxOpen] = useState(false);
  // Here rather than in a view, because it is about the whole cache and this is the one
  // component that is always mounted — and it takes the progress event as a prop so the
  // app still registers exactly one `sync:progress` listener.
  useSyncInvalidation(progress);
  // Task 10's bug fix, for the same "exactly one of these in the app" reason as everything else
  // in this block: `sync_now`'s own mutation invalidates only the sync status, so applying pulled
  // ops from an automatic trip refreshed nothing on screen until this listener existed.
  useDeviceSyncInvalidation();
  // Another window's commit, as `db:changed` — which Rust sends only while two or more windows
  // are open, so a one-window session subscribes here and never hears it.
  useCrossWindowRefresh();
  // The relay socket's state, seeded and then kept live by one `sync:live` listener — the
  // header marker's whole reason for existing (see `ChromeStatus`'s comment on the marker). Read here
  // rather than in the header itself so there is exactly one subscription for the life of the
  // app.
  const deviceSync = useDeviceSyncLive();
  /**
   * The app's three window-wide chords: `Ctrl+1`…`Ctrl+9` to jump between the nine destinations
   * {@link CHORD_NAV} names, `F1` to open the map that says so, and `Ctrl+Shift+N` to open another
   * window onto the same app.
   *
   * **Both matched against `@/lib/shortcuts` rather than compared by hand**, which is what makes
   * the panel's rows and these bindings one fact instead of two that drift silently past both CI
   * jobs. The `switchView` entry's chords are `NAV`'s own order, and the *index* is the binding —
   * so the rail stays the single list of destinations rather than being restated here as a
   * second copy, exactly as `nav.ts` argues about the label being the page's `<h1>`.
   *
   * **The modal guard is `[aria-modal="true"]`, and it covers `Ctrl+1…9` alone.** `Dialog.tsx`
   * is the one modal chrome in this app and always sets the attribute, so asking the document is
   * asking the thing that knows, with nothing to register and nothing to keep in step. A view
   * that switched out from under an open dialog would leave that dialog sitting over a page it
   * has no relationship to. `F1` deliberately passes the guard: the map is *more* use with a
   * dialog up, not less, and it draws over whatever is there rather than replacing it.
   *
   * **Not guarded by `isTextField`**, and that is the one place this differs from the deck
   * editor's undo. `Ctrl+Z` yields in a field because the browser's own undo is there and must
   * not be swallowed; `Ctrl+1` has no native meaning in a field at all, so yielding would only
   * make view-switching dead exactly where a reader's caret usually is — in the quick-add box,
   * in a search field. The argument lives at each call site because it is a fact about the
   * binding rather than about matching a chord.
   *
   * **The listener binds once for the life of the shell.** Two of its three dependencies are
   * zustand setters, which are created with the store and never replaced; the third is the
   * edition, a module constant handed down by context that does not change for the life of the
   * window (`EditionContext`'s doc is where a provider is told so). The current flag is read
   * through `getState()` at press time rather than closed over — `useCardZoomGesture`'s idiom.
   * Reading `keyMapOpen` as a dependency would tear the listener down and put a new one up on
   * every press of the key that toggles it.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The map's only mount is the header row — `KeyMap` is drawn inside `TitleBar` and nowhere
      // else — and every edition draws that row since 2026-10-11 (the light edition as a band
      // without window verbs), so the key is taken in every edition.
      if (matchesShortcut(KEY_MAP, e)) {
        // The press is ours whether or not it does anything, so the browser never sees a held
        // `F1` either.
        e.preventDefault();
        // **Auto-repeat is swallowed per chord, here and at `Ctrl+Shift+N` below, because each
        // has its own failure behind the guard.** Holding a key fires `keydown` at the OS
        // repeat rate, and a toggle on that is the panel strobing through its own fade for as
        // long as the finger is down — it lands on whichever side the reader let go on.
        // `Ctrl+1…9` below is left alone deliberately: re-selecting the view you are on is
        // idempotent, so a guard there would be a rule with no failure behind it, and hoisting
        // one to the top of the handler would decide the question for every chord this shell
        // ever grows — including a stepping chord, where repeating *is* the binding.
        if (!e.repeat) setKeyMapOpen(!useAppStore.getState().keyMapOpen);
        return;
      }
      // Ahead of the modal guard with `F1`, and for a reason of its own: opening another window
      // disturbs nothing in this one, so a dialog has nothing to be stranded over.
      //
      // **The full edition's alone.** Another window onto the same app is a desktop window's
      // verb (`docs/reference/multi-window.md`); wherever the light edition runs, a browser or an
      // OS owns the windows, and in a browser this very chord is its own — a private window. So
      // there the press is left alone entirely, ahead of `preventDefault`, like a digit for a
      // view the edition does not draw.
      if (edition.id === "full" && matchesShortcut(NEW_WINDOW, e)) {
        e.preventDefault();
        // Held keys repeat at the OS rate, and every repeat would be another window. A refusal
        // is a toast: the press asked for something that then did not appear, and nothing else
        // on screen would say why.
        if (!e.repeat) {
          void ipc
            .windowNew()
            .catch((failure: unknown) =>
              notify.error("Couldn't open a new window", { body: ipcError(failure) }),
            );
        }
        return;
      }
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      const i = SWITCH_VIEW.chords.findIndex((c) => matchesChord(c, e));
      // `-1` is "not one of ours". The second half is not ceremony: the chords and the
      // destinations are two lists that agree by construction rather than by type, and the day
      // a tenth chord is written without a tenth `CHORD_NAV` entry, the lookup is `undefined`
      // and this handler throws on every press. The reverse — a destination with no chord —
      // costs nothing and needs no guard, which is what `shared` relies on.
      //
      // **`CHORD_NAV` and never the filtered `entries` below**, which is the one thing about
      // this line that is a decision rather than arithmetic. The rail hides the Shared row until
      // a reader has opened a link; binding against what is *drawn* would move every digit after
      // it depending on something the reader did last week, so one chord would mean two things
      // to two readers. Against a fixed list the digits never move — and the list is fixed
      // precisely because the conditional row is the one left out of it.
      if (i === -1 || i >= CHORD_NAV.length) return;
      // **The digits do not move between editions.** A chord for a view this edition does not
      // draw is inert rather than rebound to the next row, for `CHORD_NAV`'s own reason: one
      // press must not mean two things to two readers. Ahead of `preventDefault`, so the press
      // is left to whatever else wants it.
      if (!editionHas(edition, CHORD_NAV[i].id)) return;
      e.preventDefault();
      setActiveView(CHORD_NAV[i].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [edition, setActiveView, setKeyMapOpen]);
  // The one `marketplace:progress` subscription in the app, for `useSyncProgress`' reason.
  // It renders nothing: the event goes into the query cache, and every `useMarketplace()`
  // observer — including the one two lines below — reads it back from there.
  useMarketplaceProgress();
  // The one place the walls' zoom is read from and written to the database, here for the same
  // "exactly one of these in the app" reason as the two subscriptions above — and because this is
  // the component that is always mounted, so a size is written whichever view the reader zoomed.
  // It renders nothing: the sizes go into the zustand store, where every wall already reads them.
  useCardZoomPersistence();
  // The same arrangement for the four lists' grid-or-table choice, and here for the same reason
  // twice over: one subscription writing one row, and a component that is mounted whichever page
  // the reader is on. It renders nothing — the layouts go into the zustand store, where each page
  // already reads its own.
  useListViewPersistence();
  // And once more for the colours the reader has given the card marks — one read at launch, from
  // the component that is mounted whatever they are looking at. It renders nothing: the answer
  // becomes four custom properties on `:root`, which is where every mark that wears one already
  // reads it, so no view is handed a hex and no mark subscribes to anything.
  useMarkColorVars();
  // And once more for the view the reader wants to be *put* on, which is this block's one hook
  // that changes what is on screen rather than how it is drawn. Here for the block's own reason
  // and for one of its own: the read has to start before the reader has reached anything, and a
  // second copy would be a second launch read racing the first — the shell is the only component
  // that is always mounted, so it is the only place "once per launch" can be spelled at all.
  //
  // **It renders nothing and returns nothing, and it is deliberately not a `useQuery`.** This
  // component never draws the stored word; an observer here would re-render the whole shell every
  // time the Settings row changed it. The fetch fills the same `["startView"]` entry
  // `useStartView` reads back — same key, same `staleTime: Infinity` — so the Settings panel
  // opened later costs no round trip.
  //
  // **A press already made wins, and the guard for that is `store.ts`'s rather than this line's.**
  // On a launch that is also a first sync the read queues behind one, so a reader who has already
  // reached for the rail would otherwise be yanked off the page they asked for a beat later;
  // `hydrateStartView` drops a seed that lands after the first `setActiveView`. Nothing here has
  // to know that — this side's only job is to never send it twice.
  useStartViewHydration();
  // The three docked search columns — the deck editor's, the collection's and the wishlist's —
  // read here rather than where any of them is drawn, and that is a measurement rather than a
  // preference for tidiness. Asked by the panel, the read queues behind the page's own read on
  // the read connection and lands ~700ms after the column has already been drawn the other way
  // round, so a reader who had shut it watched it thrown open and yanked closed on every deck
  // they opened. Asked here it resolves while they are still on the Search view. One prefetch
  // for all three, because they share one `app_meta` row and one query key. It renders nothing:
  // the answer goes into the query cache, where `useSearchOpen` reads it.
  usePrefetchSearchOpen();
  // The tag sidebar's dragged width, for the same reason one row over (issue #937).
  usePrefetchPanelWidth();
  // The collection's and the wishlist's stored folds (spec §5.7), for the same measurement one
  // row up: asked by the page, the read would queue behind the page's own list read and every
  // shelf the reader had folded would draw open for a round trip and then snap shut, with the
  // wall below it re-laying itself out. One prefetch for both pages, because they share one
  // `app_meta` row and one query key; `useShelfFolds` reads the entry this fills.
  usePrefetchShelfFolds();
  // The decks page's folder tree — its width and whether it is railed — for the same measurement
  // one row over. The flash it prevents is the worse of the two: until the row lands the tree
  // answers with its shipped 208px and `collapsed: false`, so a reader who works railed watches
  // it draw open and shut, and a reader who dragged it wide watches it draw narrow and jump —
  // and the wall beside it re-lays itself out both times. A second prefetch rather than a wider
  // one because it is a second `app_meta` row with a key of its own; `useFolderPane` reads the
  // entry this fills.
  usePrefetchFolderPane();
  // The one `oracle-tags:progress` subscription, for the same reason again. Unlike the two
  // above it hands back what it heard: the taxonomy has no `useMarketplace`-shaped module of
  // its own to read the event out of a cache entry, and the header is its only consumer today.
  const oracleTags = useOracleTagProgress();
  // And the one `combos:progress` subscription, mounted here for the same reason again. It is
  // the only consumer of that channel anywhere: Settings' combo panel and its progress bar are
  // gone, so without this the 27.5 MB and the 639 MB parse behind it would run with nothing on
  // screen saying why the disk and the network are busy.
  const combos = useComboProgress();
  // The shares this device published, republished when their folder changes (issue #1025).
  // Here because the shell is the one mount that lives as long as the window — a share is kept
  // current whichever page the reader is on — and `edition.publishes` keeps it off the light app.
  useShareAutoUpdate(edition.publishes);

  // Either this window started the sync or something else did (the run spawned at
  // startup, most often). A second `sync_run` would only be refused.
  const busy = refreshing || status?.syncing === true;

  // The five long jobs this window can be running. All are registered from here — the sync by
  // this component, the update by `App`, which hands it down — and the registry is what lets
  // the header describe any of them without knowing which.
  //
  // **The feed fetch is started somewhere else entirely** — Settings, or the moment a reader
  // picks a marketplace whose prices are not downloaded yet — and is visible here because
  // `useMarketplace` reads its state out of the *mutation cache* rather than out of one
  // observer's `useMutation`. A mutation's state is shared with nobody; a keyed one can be read
  // from anywhere, which is what lets a sibling component describe a job this one never started.
  const { refreshing: refreshingFeed, feeds, progress: feedProgress } = useMarketplace();
  const refreshingLabel = feeds.find((f) => f.marketplace.id === refreshingFeed)?.marketplace.label;
  useRegisterActivity(syncActivity(progress, busy));
  useRegisterActivity(marketplaceFeedActivity(refreshingLabel ?? null, feedProgress));
  // **Started somewhere else again, and usually by nobody**: `tags::oracle::refresh_if_due`
  // and `combos::refresh_if_due` both run at launch when their file is a week old, so the
  // commonest way either of these lines appears is a job no surface in the window asked for.
  // That argument is what puts them here rather than on a panel — and it is stronger for the
  // combos, which no longer *have* a panel and are the largest download of the two by four
  // times over. What makes each visible differs and each hook says so: the taxonomy has a
  // `refreshing` flag on its status to read, and the combo feed has only its own event.
  useRegisterActivity(oracleTagActivity(oracleTags.refreshing, oracleTags.progress));
  useRegisterActivity(comboActivity(combos.refreshing, combos.progress));
  useRegisterActivity(updateActivity(update.progress, update.status?.available?.version ?? null));
  const activity = useTopActivity();
  // The line moves the moment a job starts; the sentence waits, so a sub-second `checking`
  // phase never flashes words the reader cannot finish. It gates the *slot* rather than one
  // job, so a sync handing over to a download swaps the sentence without the row blinking.
  const activityVisible = useDelayedFlag(activity !== null, ACTIVITY_DELAY_MS);

  const title = NAV.find((n) => n.id === activeView)?.label ?? "";

  /**
   * What `useReaches` answers below this shell: whether this window draws a view. Memoised on the
   * edition, which never changes for the life of the window, so it is one function for good —
   * `ReachContext`'s doc says why that matters.
   */
  const reaches = useCallback((view: ViewId) => editionHas(edition, view), [edition]);

  /**
   * The destinations this reader actually has, which is `NAV` minus the row they have not earned.
   *
   * **Shared appears once a link has been opened** (spec decision 6): a reader who never trades
   * pays no rail slot for a view they will never press. It is filtered *here* rather than in
   * `nav.ts` so that module stays a plain list — one `nav.test.ts` can assert literally, and one
   * {@link CHORD_NAV} can be derived from.
   *
   * **`activeView === "shared"` keeps the row while the reader is standing on it**, which is what
   * makes closing the last binder safe: without it the row would vanish from under the reader in
   * the same frame the view emptied.
   *
   * **The way *in* before there is a row at all is the collection's own control** —
   * `features/collection/ShareFolderMenu.tsx` draws **Open a shared collection** beside the Share
   * control, and opening one is what puts this row on the rail. It was `Ctrl+6` until 2026-09-08,
   * when a tenth destination left nine digits to go round; {@link CHORD_NAV} carries that whole
   * argument, and the entry point is why it costs nothing.
   */
  const entries = useMemo(
    () =>
      NAV.filter(
        (n) =>
          editionHas(edition, n.id) &&
          (n.id !== "shared" || openedShares.length > 0 || activeView === "shared"),
      ),
    [edition, openedShares.length, activeView],
  );

  return (
    // A column now, where it was a row: the title bar spans the window and the sidebar starts
    // below it. `min-h-0` on the row underneath is what lets it shrink past its content —
    // without it the row keeps `min-height: auto`, the sidebar and `main` size to their content
    // instead of to the window, and the whole shell scrolls the document.
    // `h-dvh`, not `h-screen`: `100vh` on a mobile browser is the **large** viewport — the height
    // the page would have if the URL bar were hidden — so an `h-screen` shell puts its own bottom
    // row under browser chrome. `100dvh` is the visible height and tracks the bar. On desktop and
    // in WebView2 the two are identical, so this costs the shipped window nothing.
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text">
      {/* The window's caption, drawn by the app because `tauri.conf.json` sets
          `decorations: false`. Outside `min-h-0`: it is chrome belonging to the *window*
          rather than to the app, which is why it sits above the sidebar rather than beside it,
          and why it is the one row here that nothing the app draws may cover. A reader on a
          blank first launch can still close the app.

          **That last sentence was false from the day this row replaced Windows' caption until
          2026-08-22, and being written down is what hid it.** `SyncProgress`'s overlay and
          `Dialog`'s scrim are both `fixed inset-0`, and this row is a flex item carrying no
          z-index of its own — which does not lose the ordering contest so much as never enter
          it. (Spelling that default as a class here would have Tailwind emit a rule for it,
          which is why `layers.test.ts` sweeps comments too, and it caught this one.) Driven in the
          shipped window: on a first launch `elementFromPoint` over the Close button answered
          the overlay, and there was no caption on screen for the whole ~90s sync. It is kept
          now by `LAYER.caption` in `TitleBar` itself, where the rung carries the argument; the
          claim lives here because this is where the row is placed, and `layers.test.ts` is
          what holds the two together.

          `edition.caption` is false wherever a browser or an OS owns the frame — the light
          entry — and there this row is a header band of the same height without the window
          verbs: the same lockup, the same status and the same keyboard map.

          **The app's status is this row's right-hand run since 2026-10-11** — the status line,
          the sync marker and Refresh, against the keyboard map. The 56px ribbon and the page
          heading it carried are gone (the heading stays for screen readers, in `main`), so the
          mana line is directly under this row and the page directly under that.

          The data directory is the app's one piece of hidden state — it silently falls back to
          AppData when the folder beside the exe is not writable, and spec §3 asks for an
          indicator of which one is live. The status line hangs it as a tooltip on the sentence
          that already summarises the database. */}
      <TitleBar windowControls={edition.caption}>
        <ChromeStatus
          statusLine={statusLine(status)}
          dataDir={status?.dataDir}
          imageStoreFailures={status?.imageStoreFailures}
          busy={busy}
          upToDate={upToDate}
          hasError={error !== null}
          onRefresh={refresh}
          activity={activity}
          activityVisible={activityVisible}
          updateVersion={update.status?.available?.version ?? null}
          updateInstallable={update.action !== "unavailable"}
          onOpenUpdate={() => setActiveView("settings")}
          deviceSync={deviceSync}
          onOpenSync={() => setActiveView("settings")}
          drag={edition.caption}
        />
      </TitleBar>
      {/* The app's signature and its only progress bar, spanning the window under the header —
          the edge of the chrome rather than of any one view. */}
      <ManaLine sync={activity} />

      <div className="flex min-h-0 flex-1">
        {/* **`w-52` is 208px and it is pinned, which is the one part of this shell that got
          bigger in every direction except the obvious one** (2026-08-14). The entries grew —
          44px rows, 16px labels, 20px icons — and the column they sit in did not, because
          `main` is what a wider sidebar takes the width out of and the deck editor is measured
          against it to the pixel: at 1280×800 with a card pane docked the desk row is 602px,
          the docked search panel and its gap want 400, and `DECK_FLOOR` (192) leaves **10px**
          of headroom. Anything wider than 208 rails that panel at the app's own default window
          size, which is precisely the failure `DECK_FLOOR`'s two drops (224 → 208 → 192) exist
          to prevent. Widening this column is therefore a change to `DeckEditor`'s arithmetic
          first and a change to the sidebar second. */}
        {/* **Collapsed, that same arithmetic runs the other way, and that is the whole of issue
          #177.** The paragraph above says a wider column is a change to `DeckEditor`'s sums; a
          *narrower* one is the same change with the sign flipped, and it lands where the app is
          tightest. 68px is a **43×44** target inside this element's own `p-3` — the row keeps
          its height, its `size-5` icon and its gold hairline, and loses only the painted word.
          **43 rather than the round 44**, and the missing pixel is this element's own
          `border-r`: Tailwind's `box-sizing: border-box` puts the hairline inside the 68, so
          the entry gets 68 − 12 − 12 − 1. Measured in the shipped window 2026-08-22, because
          the round number was written here first and was wrong. So
          at 1280×800 with a card pane docked, where the desk row is 602px and `DECK_FLOOR` (192)
          leaves **10px** of headroom, the rail hands `main` back **140px**.

          **`relative` is load-bearing twice.** Tailwind's `.sr-only` is `position: absolute`,
          and one with no positioned ancestor resolves to the *initial* containing block, is laid
          out at its static position and is clipped by nothing — which stretches the **document**
          (`packages/ui/CLAUDE.md`; the deck editor's 1704px phantom scrollbar is what that costs). A
          collapsed rail turns every one of its labels into exactly that shape, so the containing block has to
          be here. It is also what the two floating notes below are positioned against, which is
          what keeps their `left-full top-0` free of any offset arithmetic.

          **The width is tweened at the `base` tier — 180ms — because the rail travels a real
          distance** rather than changing colour; `--duration-base` is read as a bracketed
          custom property because `--duration-*` is not a Tailwind namespace and there is no
          `duration-base` utility (`packages/ui/index.css`). `DeckEditor` picks docked-panel-vs-rail out
          of a `ResizeObserver`, so an animated width drives it through every intermediate width
          on the way — and that is safe by construction rather than by luck: a collapse only ever
          *widens* the desk, and an expand only narrows it back to the 208px value that is valid
          today. No intermediate state is worse than the endpoint it is heading for, so the
          docked panel cannot flicker in either direction.

          **The words are not on that tween, and the two directions are not symmetric** — the
          second half of the 2026-08-22 report, and `useNavLabels` above is where the timing
          lives. Opening, they wait the tween out and fade in after it; closing, they are gone in
          the commit that starts it. Everything below is therefore handed `narrow` rather than
          `collapsed`: the width belongs to the rail's own state, and every question about
          whether there is room for a word belongs to the other. */}
        <nav
          id={NAV_ID}
          aria-label="Views"
          className={cn(
            "relative flex shrink-0 flex-col gap-1.5 border-r border-border bg-surface p-3",
            "transition-[width] duration-[var(--duration-base)] ease-standard",
            "motion-reduce:transition-none",
            collapsed ? "w-17" : "w-52",
          )}
        >
          {entries.map(({ id, label, Icon }) => (
            <NavItem
              key={id}
              label={label}
              Icon={Icon}
              active={id === activeView}
              narrow={narrow}
              onSelect={() => setActiveView(id)}
              dragging={drops.dragging}
              drop={id === "decks" || id === "wishlist" ? drops[id] : null}
            />
          ))}
          {/* No sentences live in the rail any more. A drop on Decks or Wishlist and a refused
              card-menu deck add used to each draw a line here (a panel beside the rail when it
              was collapsed); both are toasts now (`@/lib/notifications`, drawn by the `Toaster`
              below), which is the app's one place to say what just happened. */}

          {/* The rail's foot: the inbox, then the collapse toggle under it. **Full width, drawn
              with negative margins against the `<nav>`'s own `p-3`**, so the rule above it runs
              edge to edge rather than stopping 12px short either side; `mt-auto` is what pins the
              pair to the bottom of a rail with room to spare. */}
          <div className="-mx-3 -mb-3 mt-auto flex flex-col gap-1.5 border-t border-border p-3">
            <NavInbox narrow={narrow} open={inboxOpen} onOpen={() => setInboxOpen(true)} />
            <NavToggle
              collapsed={collapsed}
              narrow={narrow}
              onToggle={() => setCollapsed(!collapsed)}
            />
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Given the whole screen when the database is empty, so it needs the error and
            the retry action too: it covers the page; the header above stays drawn. */}
          <SyncProgress
            progress={progress}
            cardCount={status?.cardCount ?? null}
            error={error}
            busy={busy}
            onRetry={refresh}
          />

          {/* The banner grows into place rather than shoving the whole view down by its height
            the instant a sync fails.

            **Two elements, and the split is load-bearing.** `statusLine` animates `height` to
            0, and Tailwind's `box-sizing: border-box` means a box with `py-2` and a `border-b`
            can never be shorter than its own padding and border — so an animated element
            carrying either would bottom out at 17px and jump the rest. The padding, the border
            and the colours live on the child; the animated wrapper is height and
            `overflow-hidden` and nothing else. It is also where `role="alert"` stays, on the
            element that holds the sentence, so nothing about the announcement moved. */}
          <AnimatePresence initial={false}>
            {error && (
              <motion.div {...statusLineMotion} className="shrink-0 overflow-hidden">
                <div
                  role="alert"
                  className="flex items-start gap-2.5 border-b border-destructive/40 bg-destructive/10 px-5 py-2 text-base text-destructive"
                >
                  <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0">{error}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* **`relative`, because this is a scroll container and a scroll container has to be the
            containing block for its own absolutely positioned content.** Tailwind's `.sr-only` is
            `position: absolute`, and `overflow` clips a descendant only when the scroller sits
            between it and its containing block — so a label with no positioned ancestor resolves
            to the *initial* containing block, is laid out at its static position and is clipped by
            nothing, stretching the **document** instead. Probed here 2026-08-15: three of them in
            this box alone (two filter labels and a view heading) had `offsetParent` of `body`.
            They cost nothing today only because every view they sit in happens to keep them near
            the top; the deck editor is where one finally sat 1704px down and opened a second
            scrollbar across the whole window. That instance is fixed on the editor's own section,
            which is the scroller its content belongs to and the only place that can fix it —
            `relative` *here* moved that phantom scroll from the document into `main` rather than
            removing it (measured: `main.scrollHeight` 742 → 1646). This line is the same rule
            applied to the outermost scroller, so a view that grows cannot reach the document. */}
          <main className="relative min-h-0 flex-1 overflow-auto p-5">
            {/* The page's name, for the screen reader that navigates by headings and for nothing
                else: the visible page header is gone (2026-10-11), and the rail's lit entry is
                the sighted reader's copy. Inside `main` because `main` is `relative` — see
                above for what an `sr-only` without a positioned ancestor costs. */}
            <h1 className="sr-only">{title}</h1>
            <ReachContext.Provider value={reaches}>
              <PublishesContext.Provider value={edition.publishes}>
                {children}
              </PublishesContext.Provider>
            </ReachContext.Provider>
          </main>
        </div>
      </div>

      {/* **Once per window, here**, because the store behind both is module state: a second
          `Toaster` would draw every toast twice. Both are `fixed`, and the shell's root is no
          container-query context, so neither resolves against anything but the window. */}
      <Toaster />
      <NotificationsDialog open={inboxOpen} onClose={() => setInboxOpen(false)} />
    </div>
  );
}

/**
 * One destination in the sidebar — and, for two of them, one place to let a card go.
 *
 * The entry is the whole target: a nav item is 44px tall and 183px wide, and asking a reader
 * to hit something smaller than the word they are aiming at while holding a card is asking
 * them to miss.
 *
 * It was 36px, and the eight it gained is the sidebar's whole share of the shell's 2026-08-14
 * enlargement — the row grew, the column did not (see the `<nav>` above). The label is 16px;
 * the lit entry is the only visible name the page has had since the page header went
 * (2026-10-11).
 *
 * **Collapsed it is 43×44 and nothing else about it moves**: same height, same icon, same gold
 * hairline, same drop target. The word is still in the DOM, still the button's accessible name,
 * and merely not painted. The 43 is measured rather than intended — the rail's `border-r` is
 * inside its own 68px, and the `<nav>` comment above has the arithmetic.
 *
 * **"Nothing else moves" is now literally true of the icon, and it was not when that sentence
 * was written.** The row used to centre its content while narrow — `justify-center` — which is
 * the same place to half a pixel *at rest*: the icon's left edge is **24** from the rail's own
 * edge expanded (12 of `<nav>` padding, 12 of the button's `px-3`) and **23.5** centred in the
 * collapsed row. But the class flips on the **press** and the width takes 180ms to follow, so
 * for those 180ms the icon was being centred in a box that was still 183px wide. Sampled every
 * frame in the shipped window 2026-08-22, with the fix backed out through `element.style` so
 * both readings come from one build: **24 → 93.5 on the first frame**, then 93.3, 92.6, 91.2,
 * 88.8 … 24.5, 23.7, settling at 23.5 — a **69.5px** leap outward and a slow slide back, six
 * icons thrown to the right and reeled in, which is what was reported. The same sweep with the
 * fix in place reads **24 on all 40 frames**, and 24 on all 45 frames of the expand.
 *
 * Left-anchoring costs the half pixel and makes the offset a constant the tween cannot reach.
 * Nothing about the *target* changed, which was the thing to check: measured collapsed in the
 * same pass, this button and the toggle are still **43×44**, and `main` still gets its 140px
 * back (1712 → 1852 at the app's 1920×1080).
 */
function NavItem({
  label,
  Icon,
  active,
  narrow,
  onSelect,
  dragging,
  drop,
}: {
  label: string;
  Icon: LucideIcon;
  active: boolean;
  /**
   * There is no room for a word: the rail is collapsed, or it is opening and has not arrived.
   * So this entry is a square target with its word in a tooltip. See `Shell`'s `labels`.
   */
  narrow: boolean;
  onSelect: () => void;
  /** A card is in the air somewhere in the window — the only time this entry is anything but
   *  a link. */
  dragging: boolean;
  /** What a drop here would mean, or `null` for the three entries a card cannot land on. */
  drop: SidebarDrop | null;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const tip = useTooltip();
  // The registration, and the three facts drawn from it — `useSidebarDropTarget`, which is
  // where the whole of the drag reasoning lives: which entries register, and what they accept.
  // This function draws the row; that hook decides what a card in the air may do to it.
  const { over, eligible, inert } = useSidebarDropTarget({ ref, drop, dragging });

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      // Only while a card is in the air, and only when it cannot land: a tooltip about
      // dropping on an entry nobody is dragging anything onto is chrome explaining a gesture
      // that is not being made.
      //
      // **It is a description, not a tooltip, and the smoke measured which.** A native
      // tooltip needs `:hover`, and Chromium freezes `:hover` at the element a drag started
      // from for the whole drag — measured 2026-08-06 with a card parked on this entry for
      // 1.6 s: `title` present, `document.querySelectorAll(":hover")` still ending at the
      // search tile, nothing in the DOM (`[role=tooltip]`: 0). So no reader ever *sees* this
      // sentence. What they get instead is the accname spec's fallback: mid-drag the AX node
      // reads `button "Decks", description "Open a deck to drop cards into it"` (measured
      // through `Accessibility.getPartialAXTree` in the same run), which is worth keeping and
      // costs nothing. Giving the eye the same sentence would mean a toast (`notify`) — a
      // change that would raise one, and announce it, on *every* drag while no deck is open,
      // which is a product call and is written up in
      // `docs/superpowers/notes/plan-5-followups-note.md` rather than made here.
      // `drop?.` rather than `drop.`: `inert` is a hook's answer now rather than a `const`
      // alias of `drop !== null && …` in this scope, so TypeScript's aliased-condition
      // narrowing no longer reaches the field. The optional chain says the same thing and is
      // the one line the lift cost.
      title={inert ? (drop?.inertReason ?? undefined) : undefined}
      // **The word, for the eye, while the rail is 68px wide** — `useTooltip()` at side
      // `"right"`, which is the app's one hint mechanism, and never a native `title`.
      //
      // **The `title` above is not a counter-example**: it survives precisely *because* it is
      // not a tooltip. Chromium freezes `:hover` at a drag's origin for the whole drag, so
      // that sentence is never shown to anybody and is read instead through the accname
      // spec's description fallback — measured, and written up above. This one has the
      // opposite job: it has to be **seen**, by a pointer resting on an icon with nothing
      // beside it, which is the one thing a `title` mid-drag provably cannot do.
      //
      // `narrow && label` rather than a conditional spread: `useTooltip` binds nothing for
      // a falsy content, which is the documented shape and keeps one expression here.
      //
      // **`describes: false`, for the same reason `whenClipped` implies it.** The word is
      // still in the DOM and is still this button's accessible name — only the paint is gone —
      // so an `aria-describedby` at a panel holding that same word would have a screen reader
      // say "Decks, Decks". The hint is for the eye, and only the eye has lost anything.
      {...tip(narrow && label, { side: "right", describes: false })}
      className={cn(
        "relative flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-base",
        // 44px in both states, and narrow it has to be said out loud: the label is out of
        // the flow, so the row would otherwise be its 20px icon plus padding — a target
        // smaller than the one this entry was drawn at, on the state where the reader has
        // *less* to aim at rather than more.
        //
        // **`gap-3` is unconditional above, and that is what makes the icon hold still.** An
        // `.sr-only` label is `position: absolute`, so narrow there is exactly one in-flow
        // child and a gap between one thing and nothing is nothing — while a `justify-center`
        // in its place would centre that child in a box the width tween is still moving. The
        // doc comment above has the 24 → 93.5 → 23.5 that cost, sampled per frame.
        narrow && "h-11",
        "transition-colors duration-150 motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        // The gold indicator: a hairline against the item, not a filled pill. The
        // sidebar is chrome, and chrome does not get to be the loudest thing on a
        // screen that is about to be full of card art. It stayed 2px when the row grew:
        // a hairline is a hairline at any row height, and a 3px one on a 44px row is the
        // filled marker this deliberately is not.
        active
          ? "bg-bg text-accent before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-accent"
          : "text-dim hover:bg-bg/60 hover:text-text",
        eligible && DROP_RING,
        over && DROP_OVER,
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      {/* **`sr-only` while there is no room, and deliberately not an `aria-label` on the
            button.**
            The name is still computed from content, so it is the *same string* in both states —
            which is what keeps every `getByRole("button", { name: "Decks" })` in this repository
            meaning what it has always meant, and what makes it impossible for the two states to
            drift into two different names. An `aria-label` would be a second place the word is
            written, and the first of the two to change would be the one nothing tested. */}
      {/* **And it fades in over `DURATION.instant`, arriving after the rail rather than with
            it.** By the time this class swaps, the width tween is over — so the fade is not the
            reader being told a word is coming, which 180ms of rail travelling has already said.
            It is the hard edge taken off text switching on, and that is the whole argument for
            50ms: at `fast` the softening becomes a second event after the first, and at 0 the
            words snap. Going the other way there is no fade at all, because `narrow` answers in
            the same commit as the press — the word is `sr-only` before the rail has moved a
            pixel, and a word fading out over a closing rail is the overflow this arrangement
            exists to prevent.

            **A mount animation rather than an opacity transition**, because the two states
            differ by more than opacity: `.sr-only` is out of the flow, and a transition across
            that is a transition between two boxes rather than two paints — it would need a frame
            with the word in the flow at zero opacity before it could run, which is a frame of
            the rail laid out around a word nobody can see. `motion-reduce:animate-none` is the
            opt-out, and under it the words simply appear. */}
      <span
        className={
          narrow
            ? "sr-only"
            : "animate-in fade-in duration-[var(--duration-instant)] motion-reduce:animate-none"
        }
      >
        {label}
      </span>
    </button>
  );
}

/**
 * The control that takes the rail down to icons and brings it back.
 *
 * At the foot of the sidebar, which is where issue #177 asked for it and where a reader looks
 * for something that reshapes the frame rather than choosing what is in it: everything above
 * this hairline is a destination, and this is not one.
 *
 * **The hairline above it is the rail foot's, which it shares with {@link NavInbox}** since
 * 2026-10-12. The foot is full width, drawn with negative margins against the `<nav>`'s own
 * `p-3`, so the rule reaches both edges of the rail. A hairline that stopped 12px short at each
 * end would read as a border belonging to a button rather than as the line between the
 * destinations and the controls under them; the padding is then put back inside, so the icon
 * still sits on the same 12px as every entry above it.
 *
 * **The accessible name contains the visible word, and that is WCAG 2.5.3 rather than a
 * nicety.** Expanded, the button paints `Collapse` and is named `Collapse sidebar` — a reader
 * driving the app by voice says the word they can see and hits this button. A name that did not
 * contain its own visible label ("Hide navigation" over a button reading "Collapse") would leave
 * that reader saying a word that matches nothing. Collapsed there is no visible word at all, so
 * the name is the whole of it and `useTooltip()` is what the eye gets — never a native `title`.
 */
function NavToggle({
  collapsed,
  narrow,
  onToggle,
}: {
  /**
   * What the rail is *for*, which is what this control announces. `aria-expanded` and the icon
   * flip on the press and never wait for a tween: the reader pressed it, and a control that
   * reports the old state while the thing it controls is visibly moving is a control that
   * did not take.
   */
  collapsed: boolean;
  /** Whether there is room for the word beside the icon — `Shell`'s `labels`, inverted. */
  narrow: boolean;
  onToggle: () => void;
}) {
  const tip = useTooltip();
  const name = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={name}
      // `aria-expanded` on the control and `aria-controls` at the region it acts on: the pair
      // is what says *what* the press does, rather than only that a press happened. The rail
      // is still in the tree collapsed — it is narrower, not hidden — so `expanded` is the
      // honest word for it and `hidden` would not be.
      aria-expanded={!collapsed}
      aria-controls={NAV_ID}
      // Expanded the word is on the button, so there is nothing for a hint to add; collapsed
      // it is the only thing the eye has. `useTooltip` binds nothing for a falsy content, and
      // `describes: false` because this sentence *is* the accessible name above — describing
      // a button with its own name is the name said twice.
      {...tip(narrow && name, { side: "right", describes: false })}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-base text-dim",
        // The entries' own geometry, for the entries' own reason: 44px is what a reader is
        // aiming at everywhere else in this column, and a control that reshapes the whole
        // window is not the one to make smaller. That includes holding its icon still through
        // the tween — see `NavItem`, where the same two classes are the same fix.
        narrow && "h-11",
        "transition-colors duration-150 motion-reduce:transition-none",
        "hover:bg-bg/60 hover:text-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      {/* Mounted rather than `sr-only`, unlike an entry's label: the button is named by its
            `aria-label` above, so this word is for the eye alone and there is nothing to keep in
            the tree for a reader who is not using one. The fade is `NavItem`'s, for `NavItem`'s
            reason — and it runs on mount here, which is the same moment. */}
      {!narrow && (
        <span className="animate-in fade-in duration-[var(--duration-instant)] motion-reduce:animate-none">
          Collapse
        </span>
      )}
    </button>
  );
}

/**
 * The rail's inbox entry, above the collapse toggle: a bell, the word, and how many notices have
 * arrived since the inbox was last opened (`@/lib/notifications`).
 *
 * **Drawn like {@link NavToggle} rather than like a {@link NavItem}**: it opens a dialog over the
 * view rather than switching to a view, so it carries no `aria-current` and never lights gold.
 *
 * **The count is in the name**, as an `sr-only` clause after the word, and the badge is
 * `aria-hidden` — one number said once. Collapsed, the word goes `sr-only` exactly as an entry's
 * does and the badge shrinks to a corner pip on the bell, so the rail still says "something new"
 * at 68px.
 */
function NavInbox({
  narrow,
  open,
  onOpen,
}: {
  /** Whether there is room for the word beside the icon — `Shell`'s `labels`, inverted. */
  narrow: boolean;
  /** Whether the inbox is open, for `aria-expanded`. */
  open: boolean;
  onOpen: () => void;
}) {
  const tip = useTooltip();
  const unread = useUnreadCount();
  const badge = unread > 99 ? "99+" : String(unread);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={open}
      {...tip(narrow && "Notifications", { side: "right", describes: false })}
      className={cn(
        "relative flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-base text-dim",
        narrow && "h-11",
        "transition-colors duration-150 motion-reduce:transition-none",
        "hover:bg-bg/60 hover:text-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
      )}
    >
      <span className="relative shrink-0">
        <Bell className="size-5" aria-hidden="true" />
        {narrow && unread > 0 && (
          <span
            aria-hidden="true"
            data-testid="inbox-pip"
            className="absolute -top-1.5 -right-2 min-w-4 rounded-full bg-accent px-1 text-center text-[0.625rem] leading-4 font-semibold text-accent-foreground"
          >
            {badge}
          </span>
        )}
      </span>
      <span
        className={
          narrow
            ? "sr-only"
            : "min-w-0 flex-1 animate-in fade-in duration-[var(--duration-instant)] motion-reduce:animate-none"
        }
      >
        Notifications
        {unread > 0 && <span className="sr-only">{`, ${unread} unread`}</span>}
      </span>
      {!narrow && unread > 0 && (
        <span
          aria-hidden="true"
          className="shrink-0 rounded-full bg-accent px-1.5 text-xs leading-5 font-semibold text-accent-foreground"
        >
          {badge}
        </span>
      )}
    </button>
  );
}
