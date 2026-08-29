import { useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  ActivityProvider,
  useRegisterActivity,
  useTopActivity,
} from "@/components/ActivityProvider";
import { Ribbon } from "@/components/Ribbon";
import { SyncProgress } from "@/components/SyncProgress";
import { TitleBar } from "@/components/TitleBar";
import { NAV } from "@/components/nav";
import { useTooltip } from "@/components/tooltip/useTooltip";
import {
  useSidebarDrops,
  useSidebarDropTarget,
  type SidebarDrop,
} from "@/components/useSidebarDrops";
import { isAndroid } from "@/lib/platform";
import { isWebTarget } from "@/pwa/target";
import { useCardToDeckRefusal } from "@/features/card/cardMenu";
import {
  ACTIVITY_DELAY_MS,
  marketplaceFeedActivity,
  oracleTagActivity,
  syncActivity,
  updateActivity,
} from "@/lib/activity";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { LAYER } from "@/lib/layers";
import { DURATION, statusLine as statusLineMotion } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { usePrefetchDeckSearchOpen } from "@/features/decks/useDeckSearchOpen";
import { useCardZoomPersistence } from "@/lib/useCardZoomPersistence";
import { useListViewPersistence } from "@/lib/useListViewPersistence";
import { useFlattenPersistence } from "@/lib/useFlattenPersistence";
import { useDelayedFlag } from "@/lib/useDelayedFlag";
import { useMarketplace, useMarketplaceProgress } from "@/lib/useMarketplace";
import { useNavCollapsed } from "@/lib/useNavCollapsed";
import { useNavLabels } from "@/lib/useNavLabels";
import { useOracleTagProgress } from "@/lib/useOracleTagProgress";
import { statusLine, useSync } from "@/lib/useSync";
import { useSyncInvalidation } from "@/lib/useSyncInvalidation";
import { useSyncProgress } from "@/lib/useSyncProgress";
import { useWebStorageLifecycle } from "@/pwa/useWebStorageLifecycle";
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
 * The window: sidebar, ribbon, and whatever view the store points at.
 *
 * Owns the sync status because everything that needs it lives here — the ribbon's summary
 * line, Refresh button and mana line, and the first-run overlay — and one poll for the
 * whole app is the point of the arrangement.
 *
 * The activity provider is out here rather than inside `Shell`, because a store read by the
 * component that creates it is a store nothing else can be mounted above. Here it covers both
 * of today's writers *and* `children`, so a long job started from inside a view can describe
 * itself in the ribbon with no rewiring.
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
  const setActiveView = useAppStore((s) => s.setActiveView);
  const { status, error, refresh, refreshing, upToDate } = useSync();
  const progress = useSyncProgress();
  // Web only in effect: on desktop this answers "present" for every count and its effect
  // returns immediately, so the gate below behaves exactly as it always has.
  const corpus = useWebStorageLifecycle(status?.cardCount ?? null);
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
   * has always opened — six named destinations — rather than hiding them behind a mystery the
   * reader then has to guess their way out of.
   */
  const { collapsed, setCollapsed } = useNavCollapsed();
  /**
   * Whether the rail is wide enough to paint a word — **`collapsed`'s answer in one direction
   * and one tween later in the other**, which is the whole of the two bugs reported 2026-08-22.
   *
   * The rail's width is a CSS transition and its labels are a React commit, so a single flag
   * driving both meant the words arrived 180ms before the room for them: six labels re-entering
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
  /**
   * What a refused deck add from a card menu left to say, drawn in the sidebar below.
   *
   * **Read through the context rather than by mounting `useCardToDeck` here**, and the reason is
   * not tidiness: the write has to be provided *above* `ContextMenuProvider`, because that
   * provider draws its panel as a **sibling** of the shell rather than inside it — a hook
   * mounted here would be below the menu, out of reach of the rows that call it, and a second
   * one would be a second piece of state reporting on adds nobody made through it. `App.tsx`
   * owns the mount; this is the one place the sentence is drawn.
   */
  const cardToDeckRefusal = useCardToDeckRefusal();
  // Here rather than in a view, because it is about the whole cache and this is the one
  // component that is always mounted — and it takes the progress event as a prop so the
  // app still registers exactly one `sync:progress` listener.
  useSyncInvalidation(progress);
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
  // And the same arrangement a third time for the two cabinets' Flatten switch — one subscription
  // writing one row, from the component that is mounted whichever page the reader is on. It
  // renders nothing: the two booleans go into the zustand store, where the collection and the
  // wishlist each read their own.
  useFlattenPersistence();
  // The deck editor's search column, read here rather than where it is drawn — and that is a
  // measurement rather than a preference for tidiness. Asked by the panel, the read queues behind
  // `deck_get` on the read connection and lands ~700ms after the column has already been drawn
  // the other way round, so a reader who had shut it watched it thrown open and yanked closed on
  // every deck they opened. Asked here it resolves while they are still on the Search view. It
  // renders nothing: the answer goes into the query cache, where `useDeckSearchOpen` reads it.
  usePrefetchDeckSearchOpen();
  // The one `oracle-tags:progress` subscription, for the same reason again. Unlike the two
  // above it hands back what it heard: the taxonomy has no `useMarketplace`-shaped module of
  // its own to read the event out of a cache entry, and the ribbon is its only consumer today.
  const oracleTags = useOracleTagProgress();

  // Either this window started the sync or something else did (the run spawned at
  // startup, most often). A second `sync_run` would only be refused.
  const busy = refreshing || status?.syncing === true;

  // The four long jobs this window can be running. All are registered from here — the sync by
  // this component, the update by `App`, which hands it down — and the registry is what lets
  // the ribbon describe any of them without knowing which.
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
  // **Started somewhere else again, and usually by nobody**: `oracle_tags::refresh_if_due`
  // runs at launch when the taxonomy is a week old, so the commonest way this line appears is
  // a job no surface in the window asked for. The status read is what makes that visible.
  useRegisterActivity(oracleTagActivity(oracleTags.refreshing, oracleTags.progress));
  useRegisterActivity(updateActivity(update.progress, update.status?.available?.version ?? null));
  const activity = useTopActivity();
  // The line moves the moment a job starts; the sentence waits, so a sub-second `checking`
  // phase never flashes words the reader cannot finish. It gates the *slot* rather than one
  // job, so a sync handing over to a download swaps the sentence without the row blinking.
  const activityVisible = useDelayedFlag(activity !== null, ACTIVITY_DELAY_MS);

  const title = NAV.find((n) => n.id === activeView)?.label ?? "";

  return (
    // A column now, where it was a row: the title bar spans the window and the sidebar starts
    // below it. `min-h-0` on the row underneath is what lets it shrink past its content —
    // without it the row keeps `min-height: auto`, the sidebar and `main` size to their content
    // instead of to the window, and the whole shell scrolls the document.
    // `h-dvh`, not `h-screen`: `100vh` on a mobile browser is the **large** viewport — the height
    // the page would have if the URL bar were hidden — so an `h-screen` shell puts its own bottom
    // row under browser chrome. `100dvh` is the visible height and tracks the bar. On desktop and
    // in WebView2 the two are identical, so this costs the shipped window nothing.
    <div
      className="flex h-dvh flex-col overflow-hidden bg-bg text-text"
      // Three of the four insets, as an inline style rather than as arbitrary-value classes:
      // Tailwind scans for whole class names and a mistyped arbitrary value emits *nothing*,
      // silently, with the suite and the type-checker both green. An inline style is what a
      // computed length is spelled as here, exactly as a column template is.
      //
      // Bottom is deliberately absent. Nothing is anchored to the window's bottom edge in this
      // build, and padding the shell there would inset a scroller against an indicator that is
      // not over it. `--safe-b` is published for whatever 9b puts down there.
      style={{
        paddingTop: "var(--safe-t)",
        paddingLeft: "var(--safe-l)",
        paddingRight: "var(--safe-r)",
      }}
    >
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
          what holds the two together. */}
      {/* **Not on Android, and it is three of its four buttons that decide it.** In tauri
          2.11.5 `minimize`, `toggle_maximize` and `start_dragging` are all `#[cfg(desktop)]`
          (`tauri/src/window/plugin.rs`) — they are not commands there at all — and
          `capabilities/mobile.json` grants none of the four. The fourth, `close`, exists and
          would kill the app from a button no phone user is looking for. The OS owns the frame
          there, and `lib.rs` does not even compile `window.rs` for it.

          The argument above about `LAYER.caption` still governs, on the platforms that draw
          the row.

          **And not on the web either, which this gate got wrong until 2026-08-29.** Parity §5
          gives the window's edge to the browser exactly as it gives it to the OS on Android, so
          the reasoning above transfers whole — but the test was `isAndroid()`, which is false in
          a desktop browser, so the web build drew a caption for a window it does not own and
          `TitleBar` reached for Tauri's window API on a target that has none. `window.ts`
          imports `getCurrentWindow` at module scope, so **mounting the row at all was enough**:
          the page logged `TypeError: Cannot read properties of undefined (reading 'metadata')`
          from `getCurrentWindow` and `transformCallback` on every load. It rendered anyway,
          which is why it read as noise rather than as a bug.

          `isWebTarget()` and not a second `isAndroid()`-style user-agent probe: the target is a
          build-time fact here (`__CORE__`), so the branch folds away and the desktop bundle
          carries no web check at all. The two questions are different — *which platform is this
          agent* versus *which core was this built against* — and `src/lib/images.ts`'s header
          makes the same distinction for the same reason. */}
      {!isAndroid() && !isWebTarget() && <TitleBar />}

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
          (`src/CLAUDE.md`; the deck editor's 1704px phantom scrollbar is what that costs). A
          collapsed rail turns six labels into exactly that shape, so the containing block has to
          be here. It is also what the two floating notes below are positioned against, which is
          what keeps their `left-full top-0` free of any offset arithmetic.

          **The width is tweened at the `base` tier — 180ms — because the rail travels a real
          distance** rather than changing colour; `--duration-base` is read as a bracketed
          custom property because `--duration-*` is not a Tailwind namespace and there is no
          `duration-base` utility (`src/index.css`). `DeckEditor` picks docked-panel-vs-rail out
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
          {NAV.map(({ id, label, Icon }) => (
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
          {/* **A refused deck add from a card menu, and deliberately *not* folded into the Decks
            entry's report line above.**

            That line's subject is narrower than it looks: `SidebarDrop.report` is documented as
            "what just happened **here**", and `useSidebarDrops` says "a drop reports where the
            reader dropped it" — it is about a card let go *on this entry*, which is where the
            reader's cursor was. A menu add happened at the card, several hundred pixels away,
            and never touched this entry.

            The mechanical objection is the decisive one. That report clears itself after
            `REPORT_MS` and on the next drag; this one stands until the reader arms another add.
            Two lifetimes in one slot — `drops.decks.report ?? cardToDeckRefusal` — would hide a
            live refusal behind a drop's sentence and then **bring it back** four seconds later,
            when the drop's timer expired. A sentence returning from the dead under a nav item is
            worse than either message alone, and no ordering of the `??` fixes it: the other way
            round, one refusal suppresses every drop report until the next menu add.

            So: its own region, its own subject, and `role="alert"` rather than `status` because
            this only ever holds a refusal.

            **Mounted only when there is something to say, unlike the report line above it.**
            That line is a `status` — polite, and a polite region that first appears with its
            sentence already inside it announces nothing, which is why it is always there and
            `sr-only` while empty. An `alert` is the other case: announcing on insertion is what
            the role is for, and it is what the sync banner further down already relies on. It
            also keeps `getByRole("alert")` meaning one thing — an always-mounted second alert
            makes every such query in this app ambiguous whether or not it has any text in it.
            The geometry is the report line's, which was measured for exactly this push.

            **The wrapper is `relative` so the collapsed rail's floating form is positioned
            against this sentence's own place in the column** rather than against the whole
            `<nav>` — `left-full top-0` then needs no offset arithmetic and no re-measurement
            when an entry above it moves. Collapsed, the wrapper is a zero-height flex item and
            the panel hangs off it; expanded, it is the paragraph exactly where it has always
            been. */}
          {cardToDeckRefusal !== null && (
            <div className="relative">
              <NavNote role="alert" narrow={narrow} tone="text-destructive">
                {cardToDeckRefusal}
              </NavNote>
            </div>
          )}

          <NavToggle
            collapsed={collapsed}
            narrow={narrow}
            onToggle={() => setCollapsed(!collapsed)}
          />
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* The data directory is the app's one piece of hidden state — it silently falls
            back to AppData when the folder beside the exe is not writable, and spec §3
            asks for an indicator of which one is live. The ribbon hangs it as a tooltip
            on the line that already summarises the database. */}
          <Ribbon
            title={title}
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
          />

          {/* Given the whole screen when the database is empty, so it needs the error and
            the retry action too: it covers the ribbon, Refresh button included. */}
          <SyncProgress
            progress={progress}
            cardCount={status?.cardCount ?? null}
            error={error}
            busy={busy}
            onRetry={refresh}
            reason={corpus}
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
          <main className="relative min-h-0 flex-1 overflow-auto p-5">{children}</main>
        </div>
      </div>
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
 * enlargement — the row grew, the column did not (see the `<nav>` above). The label is 16px
 * against the ribbon's 20px title, which keeps the two rungs of app › view distinguishable by
 * size rather than only by face.
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
  // where the whole of the drag reasoning lives now. It moved out of this function on
  // 2026-08-29, when `BottomTabBar` became the second drawing of navigation: the rail's row and
  // the phone's tab are two drawings, but "which entries register, and what they accept" is one
  // rule and had to stop being written twice.
  const { over, eligible, inert } = useSidebarDropTarget({ ref, drop, dragging });

  return (
    // `relative` for the report line below: `.sr-only` is `position: absolute`, so the empty
    // region needs a positioned ancestor or it resolves to the *initial* containing block and
    // stretches the document, and the collapsed rail's floating panel is anchored here so
    // `left-full top-0` lands beside this entry with no offset arithmetic.
    <div className="relative">
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
        // costs nothing. Giving the eye the same sentence means putting it in the `role=status`
        // line below — a change that would announce it on *every* drag while no deck is open,
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
      {drop && (
        // Mounted for the life of the sidebar and empty until there is something to say: a
        // live region that first appears with its sentence already inside it announces
        // nothing (the card pane's swap report, for its reason). `sr-only` while empty takes
        // it out of the flow, so the entries below sit where they always do until a card
        // actually lands — and then move for the four seconds the sentence is up. Re-measured
        // in the shipped window 2026-08-14 at 1280×800, after the shell was enlarged and this
        // line went 11.2 → 12px: the box is 183px, `Added to wishlist.` sets in one line and
        // pushes Settings **19px** down, and both long cases — a deck name
        // (`Added to Kess, Dissident Mage Storm.`) and a refusal — set in two lines and push it
        // **34px**, which is a card the reader just dropped saying where it went. Two lines is
        // still the ceiling this was drawn for; the push grew by the 2px of extra leading.
        //
        // **Collapsed there is no column for any of that** — 68px is a 44px target and its
        // padding — so `NavNote` floats the sentence beside the rail instead. The role and the
        // mounting rule are untouched, which is the part that must not move.
        <NavNote role="status" narrow={narrow} tone="text-dim">
          {drop.report}
        </NavNote>
      )}
    </div>
  );
}

/**
 * One of the sidebar's two live regions, drawn where the rail has room for it.
 *
 * Expanded, that is where both have always been: a line in the rail's own column, under the
 * entry a card landed on or under all of them. Collapsed there is no column to be a line in, so
 * the sentence floats beside the rail on a small bordered panel at `LAYER.popup` — z-indexes
 * come from `src/lib/layers.ts` and `layers.test.ts` sweeps `src/` to keep it that way.
 *
 * **`pointer-events-none`, and it is not a tidiness class.** The drop report is up for four
 * seconds *during and after a drag*, hanging over whatever view is beside the rail: a panel that
 * could take a pointer would eat the next drop, or the click on the thing underneath it — and
 * `pointer-events` inherits, so putting it here covers the sentence too.
 *
 * **One component rather than two copies of the box**, which is this repository's own lesson
 * rather than a preference: two copies of one shape are N independent decisions that happen to
 * agree today, and the three dialogs that each carried their own chrome drew one scrim at two
 * darknesses and one panel at three heights before anybody noticed (`src/CLAUDE.md`).
 *
 * **What it deliberately does *not* own is mounting**, because the two regions differ there and
 * must go on differing. The `status` is mounted for the life of the sidebar and `sr-only` while
 * empty — a polite region that first appears with its sentence already inside it announces
 * nothing — and the `alert` is mounted only when there is something to say, because announcing
 * on insertion is exactly what that role is for. Both callers keep their own rule; this only
 * decides what the box looks like.
 */
function NavNote({
  role,
  narrow,
  tone,
  children,
}: {
  role: "status" | "alert";
  /**
   * There is no column to be a line in — the rail is collapsed, or it is opening and has not
   * arrived. **The tween half matters here too**: laid out inline inside a rail that is still
   * 68px, this paragraph is the sidebar's labels overflowing again, at four times the width.
   */
  narrow: boolean;
  /** The colour this sentence has always had — `text-dim` for a report, `text-destructive` for
   *  a refusal. The box is the same in both cases; the words are not. */
  tone: string;
  children: string | null;
}) {
  return (
    <p
      role={role}
      className={
        children
          ? cn(
              "text-xs leading-tight",
              tone,
              narrow
                ? cn(
                    "pointer-events-none absolute top-0 left-full ml-2 w-48",
                    "rounded-md border border-border bg-surface px-3 py-2",
                    LAYER.popup,
                  )
                : "px-3 pt-1",
            )
          : "sr-only"
      }
    >
      {children}
    </p>
  );
}

/**
 * The control that takes the rail down to icons and brings it back.
 *
 * At the foot of the sidebar, which is where issue #177 asked for it and where a reader looks
 * for something that reshapes the frame rather than choosing what is in it: everything above
 * this hairline is a destination, and this is not one.
 *
 * **Full width, drawn with negative margins against the `<nav>`'s own `p-3`**, so the rule above
 * it reaches both edges of the rail. A hairline that stopped 12px short at each end would read
 * as a border belonging to the button rather than as the line between the destinations and the
 * control that reshapes them; the padding is then put back inside, so the icon still sits on the
 * same 12px as every entry above it.
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
    <div className="-mx-3 -mb-3 mt-auto border-t border-border p-3">
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
    </div>
  );
}
