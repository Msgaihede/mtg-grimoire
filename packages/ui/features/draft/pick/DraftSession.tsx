import { useEffect, useRef, useState, type JSX } from "react";
import { LogOut, Trash2 } from "lucide-react";
import { ipc, ipcError, type DraftCard, type DraftMode, type DraftView } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { BuildPanel, type DraftRole } from "../build/BuildPanel";
import { FlowBar, QUIET_BUTTON } from "../setup/parts";
import { currentDraft } from "./current";
import { PickScreen } from "./PickScreen";
import { acceptsView } from "./pool";
import { PoolColumns } from "./PoolColumns";

export const MODE_TITLE: Record<DraftMode, string> = {
  quick: "Quick Draft",
  sealed: "Sealed",
  cube: "Cube Draft",
  pod: "Pod Draft",
  commander: "Commander Draft",
  winston: "Winston Draft",
};

/** One Winston turn's place, as a key: whose turn, which pile, and what is on the table. Any
 *  decision moves at least one of them. */
export function winstonTurn(view: DraftView): string | null {
  const stack = view.stack;
  if (stack === null) return null;
  return [
    stack.turnSeat,
    stack.activePile ?? "-",
    stack.mainCount,
    ...stack.piles.map((p) => p.count),
    view.pool.length,
  ].join(":");
}

/**
 * A draft under way, from the reader's seat: the Draft step while it is picking, the Build step
 * once the table is done.
 *
 * **Who makes the picks decides the calls.** A solo draft and a pod's host pick through
 * `draft_pick` and are answered the next view; a guest sends `lobby_pick` and is told what
 * happened by the host's push (`draft:view`). Every app listens to that push — the host is sent
 * one when a guest's pick moves its seat on — and keeps a pushed view only when it is this seat's
 * and no older than the one on screen (`acceptsView`).
 *
 * A Winston turn is the same split: `draft_winston` answers the host's next view, a guest's
 * `lobby_winston` is answered by the push — and until that push the turn it was sent on is held
 * (`winstonSent`), so a second press cannot decline the next pile by accident.
 *
 * Going back to the hub keeps the draft (`./current.ts`; a solo draft is saved by the host too);
 * *Abandon* puts a solo draft away, *Leave pod* leaves the lobby.
 */
export function DraftSession({
  draft,
  role,
  initial,
  onBack,
  notice = null,
}: {
  draft: number | null;
  role: DraftRole;
  initial: DraftView | null;
  onBack: () => void;
  /** A sentence over the draft — a guest's lobby that closed under it. */
  notice?: string | null;
}): JSX.Element {
  const [view, setView] = useState<DraftView | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A ref as well as the state: a fast second click lands before the re-render that greys the
  // pack, and a pick sent twice is a refusal from the engine at best.
  const inFlight = useRef(false);
  // Abandon and Leave ask twice: the first press arms the button for a few seconds, the second
  // puts the draft away. A whole draft is too much to lose to one stray click, and a dialog for
  // it would be heavier than the question.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  useEffect(() => {
    currentDraft.keep({ draft, role, view });
  }, [draft, role, view]);

  useEffect(
    () => ipc.onDraftView((pushed) => setView((cur) => (acceptsView(cur, pushed) ? pushed : cur))),
    [],
  );

  // A draft this app runs is asked for its view again on arrival: the reader may be back from
  // another view, and a guest's picks moved the host's seat on meanwhile with no one listening.
  useEffect(() => {
    if (role === "guest" || draft === null) return;
    let live = true;
    ipc.draftView(draft).then(
      (fresh) => {
        if (live && fresh !== null) setView((cur) => (acceptsView(cur, fresh) ? fresh : cur));
      },
      () => {
        // The view on screen stays; the next pick will say what is wrong, in the host's words.
      },
    );
    return () => {
      live = false;
    };
  }, [draft, role]);

  const run = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(ipcError(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  /** The Winston turn a guest's decision went out on — the buttons stay down until it moves. */
  const [winstonSentOn, setWinstonSentOn] = useState<string | null>(null);

  const pick = (cards: DraftCard[]) =>
    void run(async () => {
      const ids = cards.map((c) => c.instanceId);
      if (role === "guest" || draft === null) {
        const at = view;
        await ipc.lobbyPick(ids);
        // Drawn as waiting until the host's push — unless that push has already landed.
        setView((cur) =>
          cur !== null &&
          at !== null &&
          cur.packNumber === at.packNumber &&
          cur.pickNumber === at.pickNumber &&
          cur.status === "drafting"
            ? { ...cur, waiting: true }
            : cur,
        );
        return;
      }
      setView(await ipc.draftPick(draft, ids));
    });

  const decide = (pile: number, take: boolean) =>
    void run(async () => {
      if (role === "guest" || draft === null) {
        const at = view === null ? null : winstonTurn(view);
        await ipc.lobbyWinston(pile, take);
        setWinstonSentOn(at);
        return;
      }
      setView(await ipc.draftWinston(draft, pile, take));
    });

  const autoPick =
    role === "guest" || draft === null
      ? undefined
      : () =>
          void run(async () => {
            setView(await ipc.draftAutoPick(draft));
          });

  const abandon = () =>
    void run(async () => {
      if (role === "solo" && draft !== null) await ipc.draftEnd(draft);
      else await ipc.lobbyLeave();
      currentDraft.keep(null);
      onBack();
    });

  const building = view?.status === "deckbuilding";

  return (
    <section className="flex h-full min-h-0 flex-col">
      <FlowBar
        title={view?.label || (view === null ? "Pod Draft" : MODE_TITLE[view.mode])}
        meta={view === null ? undefined : MODE_TITLE[view.mode]}
        onBack={onBack}
        step={building ? "build" : "draft"}
        actions={
          <button
            type="button"
            onClick={() => (armed ? abandon() : setArmed(true))}
            className={cn(QUIET_BUTTON, armed && "border-destructive/60 text-destructive")}
          >
            {role === "solo" ? (
              <Trash2 className="size-4" aria-hidden="true" />
            ) : (
              <LogOut className="size-4" aria-hidden="true" />
            )}
            {armed
              ? role === "solo"
                ? "Abandon this draft?"
                : "Leave the pod?"
              : role === "solo"
                ? "Abandon"
                : "Leave pod"}
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-8 pt-3 pr-1">
        {notice !== null && (
          <p
            role="status"
            className="m-0 mb-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm"
          >
            {notice}
          </p>
        )}
        {view === null ? (
          <p role="status" className="m-0 py-16 text-center text-sm text-dim">
            Waiting for the host to deal…
          </p>
        ) : building ? (
          <div className="flex flex-col gap-6">
            <BuildPanel
              view={view}
              draft={draft}
              role={role}
              onBuilt={() => currentDraft.keep(null)}
            />
            <PoolColumns pool={view.pool} />
          </div>
        ) : (
          <PickScreen
            view={view}
            busy={busy}
            error={error}
            onPick={pick}
            onAutoPick={autoPick}
            onWinston={decide}
            winstonSent={winstonSentOn !== null && winstonSentOn === winstonTurn(view)}
          />
        )}
      </div>
    </section>
  );
}
