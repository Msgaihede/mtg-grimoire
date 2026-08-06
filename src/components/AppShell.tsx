import { useEffect, useRef, useState, type ReactNode } from "react";
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  Heart,
  Layers,
  LibraryBig,
  Search,
  Settings,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Ribbon } from "@/components/Ribbon";
import { SyncProgress } from "@/components/SyncProgress";
import { useSidebarDrops, type SidebarDrop } from "@/components/useSidebarDrops";
import { readDragData } from "@/features/decks/dnd";
import { manaLineSync } from "@/lib/mana";
import { useAppStore, type ViewId } from "@/lib/store";
import { statusLine, useSync } from "@/lib/useSync";
import { useSyncInvalidation } from "@/lib/useSyncInvalidation";
import { useSyncProgress } from "@/lib/useSyncProgress";
import { cn } from "@/lib/utils";

const NAV: { id: ViewId; label: string; Icon: LucideIcon }[] = [
  { id: "search", label: "Search", Icon: Search },
  { id: "collection", label: "Collection", Icon: LibraryBig },
  { id: "wishlist", label: "Wishlist", Icon: Heart },
  { id: "decks", label: "Decks", Icon: Layers },
  { id: "settings", label: "Settings", Icon: Settings },
];

/**
 * What an entry that can take the card you are holding looks like: 2px of gold around it,
 * standing for as long as the card is in the air.
 *
 * The app's existing vocabulary rather than a new one — gold is interactive emphasis
 * everywhere in this window, and the same ring is the keyboard's focus mark. Deliberate: a
 * drop target lighting up and a control being reachable are the same claim made to two
 * different hands. The zone columns' `DropIndicator` line stays theirs; a line drawn on a nav
 * entry would promise an insertion point in a list that has none.
 *
 * Instant, with no rule of its own: a ring is a box shadow, and the entry's colour animation
 * does not cover one. That is the answer this wants anyway — an affordance that fades in
 * during a drag is one still arriving when the reader has let go (`DropIndicator`'s reasoning),
 * and it is why the guard in `tokens.test.ts` has nothing to find here.
 */
export const DROP_RING = "ring-2 ring-accent";

/**
 * The window: sidebar, ribbon, and whatever view the store points at.
 *
 * Owns the sync status because everything that needs it lives here — the ribbon's summary
 * line, Refresh button and mana line, and the first-run overlay — and one poll for the
 * whole app is the point of the arrangement.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const { status, error, refresh, refreshing, upToDate } = useSync();
  const progress = useSyncProgress();
  // The sidebar is the one part of the window that is always on screen, which is what makes
  // it the place a card can be dropped from any view — the Search wall and the deck editor
  // never coexist, so without this a card found in Search has nowhere to go.
  const drops = useSidebarDrops();
  // Here rather than in a view, because it is about the whole cache and this is the one
  // component that is always mounted — and it takes the progress event as a prop so the
  // app still registers exactly one `sync:progress` listener.
  useSyncInvalidation(progress);

  // Either this window started the sync or something else did (the run spawned at
  // startup, most often). A second `sync_run` would only be refused.
  const busy = refreshing || status?.syncing === true;
  const title = NAV.find((n) => n.id === activeView)?.label ?? "";

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-text">
      <nav
        aria-label="Views"
        className="flex w-52 shrink-0 flex-col gap-1 border-r border-border bg-surface p-3"
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
          sync={manaLineSync(progress, busy)}
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

        {error && (
          <div
            role="alert"
            className="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-5 py-2 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{error}</span>
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-auto p-5">{children}</main>
      </div>
    </div>
  );
}

/**
 * One destination in the sidebar — and, for two of them, one place to let a card go.
 *
 * The entry is the whole target: a nav item is 36px tall and 172px wide, and asking a reader
 * to hit something smaller than the word they are aiming at while holding a card is asking
 * them to miss.
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
        title={inert ? (drop.inertReason ?? undefined) : undefined}
        className={cn(
          "relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm",
          "transition-colors duration-150 motion-reduce:transition-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          // The gold indicator: a hairline against the item, not a filled pill. The
          // sidebar is chrome, and chrome does not get to be the loudest thing on a
          // screen that is about to be full of card art.
          active
            ? "bg-bg text-accent before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent"
            : "text-dim hover:bg-bg/60 hover:text-text",
          eligible && DROP_RING,
          // The sidebar's own hover surface, because `:hover` does not update during a native
          // drag — the pointer is holding something, so the browser stops answering that
          // question and the entry under it would otherwise look like every other one.
          over && "bg-bg text-text",
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {label}
      </button>
      {drop && (
        // Mounted for the life of the sidebar and empty until there is something to say: a
        // live region that first appears with its sentence already inside it announces
        // nothing (the card pane's swap report, for its reason). `sr-only` while empty takes
        // it out of the flow, so the entries below sit where they always do until a card
        // actually lands — and then move for the four seconds the sentence is up. Measured at
        // 1280×800: the longest realistic sentence sets in two lines of 183px and pushes
        // Settings 32px down, which is a card the reader just dropped saying where it went.
        <p
          role="status"
          className={drop.report ? "px-2.5 pt-1 text-[0.7rem] leading-tight text-dim" : "sr-only"}
        >
          {drop.report}
        </p>
      )}
    </div>
  );
}
