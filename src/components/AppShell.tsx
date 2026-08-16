import { useEffect, useRef, useState, type ReactNode } from "react";
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { AnimatePresence, motion } from "motion/react";
import {
  Heart,
  Layers,
  LibraryBig,
  Search,
  Settings,
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
import { useSidebarDrops, type SidebarDrop } from "@/components/useSidebarDrops";
import { useCardToDeckRefusal } from "@/features/card/cardMenu";
import { readDragData } from "@/features/decks/dnd";
import {
  ACTIVITY_DELAY_MS,
  marketplaceFeedActivity,
  oracleTagActivity,
  syncActivity,
  updateActivity,
} from "@/lib/activity";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { statusLine as statusLineMotion } from "@/lib/motion";
import { useAppStore, type ViewId } from "@/lib/store";
import { useDelayedFlag } from "@/lib/useDelayedFlag";
import { useMarketplace, useMarketplaceProgress } from "@/lib/useMarketplace";
import { useOracleTagProgress } from "@/lib/useOracleTagProgress";
import { statusLine, useSync } from "@/lib/useSync";
import { useSyncInvalidation } from "@/lib/useSyncInvalidation";
import { useSyncProgress } from "@/lib/useSyncProgress";
import type { Update } from "@/lib/useUpdate";
import { cn } from "@/lib/utils";

const NAV: { id: ViewId; label: string; Icon: LucideIcon }[] = [
  { id: "search", label: "Search", Icon: Search },
  { id: "collection", label: "Collection", Icon: LibraryBig },
  { id: "wishlist", label: "Wishlist", Icon: Heart },
  { id: "decks", label: "Decks", Icon: Layers },
  { id: "settings", label: "Settings", Icon: Settings },
];

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
  // The sidebar is the one part of the window that is always on screen, which is what makes
  // it the place a card can be dropped from any view — the Search wall and the deck editor
  // never coexist, so without this a card found in Search has nowhere to go.
  const drops = useSidebarDrops();
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
    <div className="flex h-screen overflow-hidden bg-bg text-text">
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
      <nav
        aria-label="Views"
        className="flex w-52 shrink-0 flex-col gap-1.5 border-r border-border bg-surface p-3"
      >
        {NAV.map(({ id, label, Icon }) => (
          <NavItem
            key={id}
            label={label}
            Icon={Icon}
            active={id === activeView}
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
            The geometry is the report line's, which was measured for exactly this push. */}
        {cardToDeckRefusal !== null && (
          <p role="alert" className="px-3 pt-1 text-xs leading-tight text-destructive">
            {cardToDeckRefusal}
          </p>
        )}
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
 */
function NavItem({
  label,
  Icon,
  active,
  onSelect,
  dragging,
  drop,
}: {
  label: string;
  Icon: LucideIcon;
  active: boolean;
  onSelect: () => void;
  /** A card is in the air somewhere in the window — the only time this entry is anything but
   *  a link. */
  dragging: boolean;
  /** What a drop here would mean, or `null` for the three entries a card cannot land on. */
  drop: SidebarDrop | null;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  /** The card is over *this* entry: which one of the ringed pair is about to take it. */
  const [over, setOver] = useState(false);
  // What the target answers, kept current without the registration depending on it. The shell
  // re-renders the moment a card is picked up — that is what raises the ring — and a drop
  // target that unregisters mid-drag is a drop that never arrives.
  const latest = useRef(drop);
  useEffect(() => {
    latest.current = drop;
  });

  // Registered once, for the life of the entry: whether an entry is a target at all is fixed
  // (Decks and Wishlist are, always), while *what it accepts* is asked at drag time and read
  // off the ref above.
  useEffect(() => {
    const element = ref.current;
    if (!element || latest.current === null) return;
    const taken = (data: Record<string, unknown>) => {
      const payload = readDragData(data);
      return payload !== null && latest.current?.eligible === true ? payload : null;
    };
    return dropTargetForElements({
      element,
      // No `getData`: what a drop writes is decided by the entry, and the entry is already
      // here. A payload this app did not put in the air, or an entry that cannot take one,
      // never enters — so `over` below is only ever true for a drop that will happen.
      canDrop: ({ source }) => taken(source.data) !== null,
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: ({ source }) => {
        setOver(false);
        const payload = taken(source.data);
        if (payload) latest.current?.onDrop(payload);
      },
    });
  }, []);

  const eligible = drop !== null && dragging && drop.eligible;
  const inert = drop !== null && dragging && !drop.eligible;

  return (
    <div>
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
        title={inert ? (drop.inertReason ?? undefined) : undefined}
        className={cn(
          "relative flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-base",
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
        {label}
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
        <p
          role="status"
          className={drop.report ? "px-3 pt-1 text-xs leading-tight text-dim" : "sr-only"}
        >
          {drop.report}
        </p>
      )}
    </div>
  );
}
