import { useCallback, useEffect, useState, type JSX, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Boxes,
  Hammer,
  Layers,
  Package,
  PackageOpen,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useDecks } from "@/features/decks/useDecks";
import { openDraftDeck } from "@/features/draft/navigation";
import { PackOpener } from "@/features/draft/packs/PackOpener";
import { useDraftDeckIds } from "@/features/draft/useDraftDecks";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import {
  ipc,
  ipcError,
  type DraftMode,
  type DraftSaved,
  type DraftView,
  type LobbyState,
} from "@/lib/ipc";
import { PRESS_SOFT } from "@/lib/motion";
import { ago } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { viewMemory } from "@/lib/viewMemory";
import type { DraftRole } from "./build/BuildPanel";
import { LobbyScreen } from "./lobby/LobbyScreen";
import { isLive, useLobbyState } from "./lobby/useLobby";
import { currentDraft } from "./pick/current";
import { DraftSession, MODE_TITLE } from "./pick/DraftSession";
import { freshDraftName } from "./setup/deal";
import { InlineError, LABEL, PANEL, QUIET_BUTTON } from "./setup/parts";
import { SetupScreen, type SetupMode } from "./setup/SetupScreen";

/** Which screen of the page is up. The page keeps its own — there is no router below a view. */
type Flow =
  | { kind: "hub" }
  | { kind: "setup"; mode: SetupMode }
  | { kind: "lobby" }
  | { kind: "packs" }
  | { kind: "draft"; draft: number | null; role: DraftRole; view: DraftView | null };

/** The screen the reader left, for the window's life — a draft is `./pick/current.ts`'s. */
const flowMemory = viewMemory<Flow>("draft.flow");

/** The saved solo draft — read fresh whenever the hub is drawn (it moves with every pick). */
export const DRAFT_SAVED_KEY = ["draft", "saved"] as const;

function firstFlow(): Flow {
  const current = currentDraft.recall();
  if (current) return { kind: "draft", ...current };
  const left = flowMemory.recall();
  return left !== undefined && left.kind !== "draft" ? left : { kind: "hub" };
}

/**
 * The Draft & Packs view (`docs/superpowers/specs/2026-10-29-draft-and-packs-design.md` §7): a hub
 * — *Draft in progress* (a saved solo draft to resume, the draft decks not saved yet, a live lobby)
 * and *Start new* (Quick Draft, Sealed, Cube Draft, Pod Draft, Open Packs) — and the flow each
 * starts: Choose → Draft → Build.
 *
 * **The page holds which screen is up** (`Flow`), as Playtesting holds its setup and its board:
 * a state here, kept in window memory so going to another view and back lands on the same screen.
 * A draft under way is `./pick/current.ts`'s, so coming back mid-draft opens on the pick.
 *
 * `App.tsx` loads it lazily; desktop only, like Playtesting (phase.rs's draft module is linked by
 * the desktop alone).
 */
export function DraftPage(): JSX.Element {
  const [flow, setFlowState] = useState<Flow>(firstFlow);
  const queryClient = useQueryClient();
  const lobby = useLobbyState();

  const setFlow = useCallback((next: Flow) => {
    flowMemory.keep(next);
    setFlowState(next);
  }, []);
  const toHub = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: DRAFT_SAVED_KEY });
    setFlow({ kind: "hub" });
  }, [queryClient, setFlow]);
  const toDraft = useCallback(
    (draft: number | null, view: DraftView | null, role: DraftRole) => {
      currentDraft.keep({ draft, role, view });
      setFlow({ kind: "draft", draft, role, view });
    },
    [setFlow],
  );

  switch (flow.kind) {
    case "setup":
      return (
        <SetupScreen
          mode={flow.mode}
          onMode={(mode) => setFlow({ kind: "setup", mode })}
          onBack={toHub}
          onStarted={(draft, view) => toDraft(draft, view, "solo")}
        />
      );
    case "lobby":
      return <LobbyScreen onBack={toHub} onDraft={toDraft} />;
    case "packs":
      return <PackOpener onBack={toHub} />;
    case "draft":
      return (
        <DraftSession
          // A new draft is a new session: nothing of the last one's state carries over.
          key={`${flow.role}:${flow.draft ?? "guest"}`}
          draft={flow.draft}
          role={flow.role}
          initial={flow.view}
          onBack={toHub}
          notice={
            flow.role === "guest" && lobby?.phase === "closed"
              ? `The lobby closed${lobby.closedReason ? `: ${lobby.closedReason}` : "."} Your pool is still yours to build.`
              : null
          }
        />
      );
    case "hub":
      return (
        <DraftHub
          lobby={lobby}
          onStart={(mode) =>
            setFlow(
              mode === "pod"
                ? { kind: "lobby" }
                : mode === "packs"
                  ? { kind: "packs" }
                  : { kind: "setup", mode },
            )
          }
          onDraft={toDraft}
          onLobby={() => {
            const current = currentDraft.recall();
            if (lobby?.phase === "drafting" && current && current.role !== "solo") {
              setFlow({ kind: "draft", ...current });
            } else {
              setFlow({ kind: "lobby" });
            }
          }}
        />
      );
  }
}

type StartMode = SetupMode | "pod" | "packs";

const MODES: readonly {
  id: StartMode;
  title: string;
  blurb: string;
  icon: LucideIcon;
}[] = [
  {
    id: "quick",
    title: "Quick Draft",
    blurb: "Three boosters of any sets you like, passed round a table of seven bots.",
    icon: Layers,
  },
  {
    id: "sealed",
    title: "Sealed",
    blurb: "Six boosters straight into your pool — build the best forty you can.",
    icon: Package,
  },
  {
    id: "cube",
    title: "Cube Draft",
    blurb: "Paste a cube list; it is shuffled and dealt into boosters for the table.",
    icon: Boxes,
  },
  {
    id: "pod",
    title: "Pod Draft",
    blurb: "Draft with friends through a lobby code. Bots fill the empty seats.",
    icon: Users,
  },
  {
    id: "packs",
    title: "Open Packs",
    blurb: "Open any booster or box and see how it stacks up against its average.",
    icon: PackageOpen,
  },
];

/** The hub: what is under way, and the five ways to start something new. */
function DraftHub({
  lobby,
  onStart,
  onDraft,
  onLobby,
}: {
  lobby: LobbyState | null;
  onStart: (mode: StartMode) => void;
  onDraft: (draft: number | null, view: DraftView | null, role: DraftRole) => void;
  onLobby: () => void;
}): JSX.Element {
  const saved = useQuery({
    queryKey: DRAFT_SAVED_KEY,
    queryFn: () => ipc.draftSaved(),
    retry: false,
    // Every pick moves it; the hub is drawn between drafts, so it is always asked again.
    staleTime: 0,
  });
  const draftDeckIds = useDraftDeckIds();
  const { decks } = useDecks();
  const draftDecks = decks.filter((d) => draftDeckIds.includes(d.id));
  const live = isLive(lobby) ? lobby : null;
  const savedDraft = saved.data ?? null;
  const anything = savedDraft !== null || draftDecks.length > 0 || live !== null;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-y-auto pb-8">
      <header className="flex flex-col gap-2 pb-6 pt-2">
        <p className={LABEL}>Draft</p>
        <h2 className="m-0 font-heading text-[2.25rem] font-semibold leading-none tracking-[0.02em]">
          Draft &amp; Packs
        </h2>
        <p className="m-0 max-w-[70ch] text-sm text-dim">
          Draft against bots or friends, build a deck from what you take, or open a pack and see
          what it was worth. Nothing here touches your collection.
        </p>
      </header>

      {anything && (
        <HubSection title="Draft in progress">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {savedDraft !== null && (
              <SavedDraftRow
                saved={savedDraft}
                onResumed={(draft, view) => onDraft(draft, view, "solo")}
              />
            )}
            {live !== null && <LobbyRow lobby={live} onReturn={onLobby} />}
            {draftDecks.map((deck) => (
              <ProgressRow
                key={deck.id}
                icon={Hammer}
                title={deck.name}
                chip="Building"
                detail={`${plural(deck.cardCount, "card")} · not saved yet`}
                actions={
                  <button
                    type="button"
                    onClick={() => openDraftDeck(deck.id)}
                    className={cn(QUIET_BUTTON, "border-accent/60 text-accent")}
                  >
                    Continue building
                  </button>
                }
              />
            ))}
          </ul>
        </HubSection>
      )}

      <HubSection title="Start new">
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3 p-0">
          {MODES.map((mode) => (
            <li key={mode.id} className="flex">
              <ModeCard {...mode} onEnter={() => onStart(mode.id)} />
            </li>
          ))}
        </ul>
      </HubSection>
    </section>
  );
}

function HubSection({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section aria-label={title} className="flex flex-col gap-3 pb-8">
      <div className="flex items-center gap-4">
        <h3 className={LABEL}>{title}</h3>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </div>
      {children}
    </section>
  );
}

/** One thing under way: its glyph, its name, a status chip, a line of detail, and its presses. */
function ProgressRow({
  icon: Icon,
  title,
  chip,
  detail,
  actions,
  error = null,
}: {
  icon: LucideIcon;
  title: string;
  chip: string;
  detail: string;
  actions: ReactNode;
  error?: string | null;
}): JSX.Element {
  return (
    <li className={cn(PANEL, "flex flex-col gap-2 px-4 py-3")}>
      <div className="flex items-center gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface text-accent">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="truncate font-medium">{title}</span>
            <span className="shrink-0 rounded-full border border-accent/50 bg-accent/10 px-2 text-[0.6875rem] leading-5 text-accent">
              {chip}
            </span>
          </div>
          <span className="truncate text-xs text-dim">{detail}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
      <InlineError message={error} />
    </li>
  );
}

const MODE_ICON: Record<DraftMode, LucideIcon> = {
  quick: Layers,
  sealed: Package,
  cube: Boxes,
  pod: Users,
};

/**
 * The solo draft left off. **Resume** takes it back up — the one this window is already running
 * if there is one, else the saved copy under a fresh name (`draft_resume`). **Abandon** asks twice
 * and drops it; a saved copy no window runs is taken up under a fresh name first, so `draft_end`
 * names a draft the host holds.
 */
function SavedDraftRow({
  saved,
  onResumed,
}: {
  saved: DraftSaved;
  onResumed: (draft: number, view: DraftView) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  // The clock once, as the row mounts: the hub is drawn fresh each time it is opened.
  const [now] = useState(() => Date.now());
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  /** The draft under a name the host holds: this window's, or the saved copy taken up again. */
  const takeUp = async (): Promise<{ draft: number; view: DraftView }> => {
    const current = currentDraft.recall();
    if (current && current.role === "solo" && current.draft !== null) {
      const view = await ipc.draftView(current.draft);
      if (view !== null) return { draft: current.draft, view };
    }
    const draft = freshDraftName();
    return { draft, view: await ipc.draftResume(draft) };
  };

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(ipcError(e));
    } finally {
      setBusy(false);
    }
  };

  const resume = () =>
    void act(async () => {
      const { draft, view } = await takeUp();
      onResumed(draft, view);
    });
  const abandon = () =>
    void act(async () => {
      const { draft } = await takeUp();
      await ipc.draftEnd(draft);
      currentDraft.keep(null);
      setArmed(false);
      await queryClient.invalidateQueries({ queryKey: DRAFT_SAVED_KEY });
    });

  const where =
    saved.status === "deckbuilding"
      ? "Done picking"
      : `Pack ${saved.packNumber + 1} of ${saved.packCount} · Pick ${saved.pickNumber + 1}`;
  return (
    <ProgressRow
      icon={MODE_ICON[saved.mode]}
      title={saved.label || MODE_TITLE[saved.mode]}
      chip={saved.status === "deckbuilding" ? "Building" : "Drafting"}
      detail={`${MODE_TITLE[saved.mode]} · ${where} · ${ago(saved.updatedAt / 1000, now)}`}
      error={error}
      actions={
        <>
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) (armed ? abandon : () => setArmed(true))();
            }}
            className={cn(QUIET_BUTTON, armed && "border-destructive/60 text-destructive")}
          >
            {armed ? "Abandon this draft?" : "Abandon"}
          </button>
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) resume();
            }}
            className={cn(QUIET_BUTTON, "border-accent/60 text-accent")}
          >
            Resume
          </button>
        </>
      }
    />
  );
}

function LobbyRow({ lobby, onReturn }: { lobby: LobbyState; onReturn: () => void }): JSX.Element {
  const people = 1 + lobby.peers.filter((p) => p.online).length;
  return (
    <ProgressRow
      icon={Users}
      title={lobby.label || `Lobby ${lobby.code}`}
      chip={lobby.phase === "drafting" ? "Drafting" : lobby.role === "host" ? "Hosting" : "Joined"}
      detail={`Pod Draft · code ${lobby.code} · ${plural(people, "person", "people")}${
        lobby.role === "guest" ? ` · hosted by ${lobby.hostName}` : ""
      }`}
      actions={
        <button
          type="button"
          onClick={onReturn}
          className={cn(QUIET_BUTTON, "border-accent/60 text-accent")}
        >
          Return
        </button>
      }
    />
  );
}

/** One way to start: its glyph, its name, two lines on what it is, and the way in — with the glyph
 *  again, large and faint, in the corner. The whole card is the press. */
function ModeCard({
  title,
  blurb,
  icon: Icon,
  onEnter,
}: {
  title: string;
  blurb: string;
  icon: LucideIcon;
  onEnter: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onEnter}
      className={cn(
        "group relative flex min-h-44 w-full flex-col gap-3 overflow-hidden rounded-xl border border-border",
        "bg-surface/45 p-5 text-left hover:border-accent/60 hover:bg-surface",
        PRESS_SOFT,
        FOCUS,
      )}
    >
      {/* First in the order, so the text after it — `relative` — paints over it. */}
      <Icon
        aria-hidden="true"
        strokeWidth={1}
        className="pointer-events-none absolute -bottom-6 -right-6 size-36 text-accent opacity-[0.07]"
      />
      <span className="relative grid size-10 place-items-center rounded-lg border border-accent/40 bg-accent/10 text-accent">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="relative flex flex-col gap-1">
        <span className="font-heading text-lg font-semibold leading-tight">{title}</span>
        <span className="line-clamp-2 text-sm text-dim">{blurb}</span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "relative mt-auto inline-flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-[0.08em] text-accent uppercase",
          "transition-[gap] duration-150 group-hover:gap-2.5 motion-reduce:transition-none",
        )}
      >
        Enter
        <ArrowRight className="size-3.5" />
      </span>
    </button>
  );
}
