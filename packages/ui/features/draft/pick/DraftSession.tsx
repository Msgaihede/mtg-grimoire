import { useEffect, useRef, useState, type JSX } from "react";
import { LogOut, Trash2 } from "lucide-react";
import { ipc, ipcError, type DraftCard, type DraftMode, type DraftView } from "@/lib/ipc";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";
import { cn } from "@/lib/utils";
import { BuildPanel, type DraftRole } from "../build/BuildPanel";
import { lobbyFor, useLobbyState } from "../lobby/useLobby";
import { FlowBar, QUIET_BUTTON } from "../setup/parts";
import { currentDraft } from "./current";
import { PickScreen } from "./PickScreen";
import { acceptsView } from "./pool";
import { PoolZones } from "./PoolZones";
import { keepSideboard, recallSideboard, resetSideboard, sendTo, type Destination } from "./split";
import { useDraftTrayLayout } from "./trayLayout";

export const MODE_TITLE: Record<DraftMode, string> = {
  quick: "Quick Draft",
  sealed: "Sealed",
  cube: "Cube Draft",
  pod: "Pod Draft",
  commander: "Commander Draft",
  winston: "Winston Draft",
};

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
 * **A guest's sent pick is held beside the view, never written into it** (issue #1585). A
 * `lobby_pick` or `lobby_winston` that resolves has only queued a frame: the relay drops it while
 * the host is off the relay, and the host may refuse it. So the view the decision went out on is
 * kept (`sentOn`) and drawn as waiting — the pack greyed, a Winston turn's buttons down — until any
 * view of this seat is pushed, the host's re-send of the seat as it stands included. A view marked
 * `waiting` here would score past that re-send and turn it away, for good.
 *
 * While the host is off the relay a guest's pick is greyed, and the host coming back is asked to
 * push the seat again (`lobby_rejoin`), as a guest's arrival is.
 *
 * Going back to the hub keeps the draft (`./current.ts`; a solo draft is saved by the host too),
 * and coming back to it asks again for the view this seat missed meanwhile — `draft_view` for a
 * draft this app runs, `lobby_rejoin` (the host's push) for a guest's. *Abandon* puts a solo
 * draft away, *Leave pod* leaves the lobby.
 *
 * **Which picks are on the sideboard is this component's** (issue #1471, `./split.ts`): a pick's
 * list is applied once the pick is taken — the host's answer, or a guest's send — so a refused
 * pick leaves nothing behind; a press on a picked card moves it, through the Build step too. It is
 * kept per device as it changes, started over by a draft that opens with an empty pool (and by
 * every new deal and the hub's Abandon, which are `DraftPage`'s — issue #1588), and forgotten
 * when the draft is put away.
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
  const [sideboard, setSideboard] = useState<string[]>(() =>
    initial !== null && initial.pool.length === 0 ? [] : recallSideboard(),
  );
  useEffect(() => keepSideboard(sideboard), [sideboard]);
  const send = (ids: readonly string[], to: Destination) =>
    setSideboard((cur) => sendTo(cur, ids, to));
  const move = (card: DraftCard, to: Destination) => send([card.instanceId], to);
  // Ctrl+wheel anywhere over the draft steps its cards (issue #1433) — the pack, a Winston pile and
  // the pool, which all read `cardZoom.draft`. The scroll container rather than one wall, so a
  // gesture over the gaps between them is caught too and is never WebView2's page zoom.
  const scrollRef = useRef<HTMLDivElement>(null);
  useCardZoomGesture(scrollRef, "draft");
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

  // Any accepted push is a new view object, so it lets go of a guest's sent decision (`sentOn`).
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

  // A guest is never answered a view on demand — it only arrives pushed — so a guest arriving
  // asks the host to push it again (`lobby_rejoin`, issue #1468): the views the host sent while
  // the reader was on another view, or before a reload, went by with no one listening, and the
  // one kept may be a pick behind (or still waiting on a pack that has since come).
  useEffect(() => {
    if (role !== "guest") return;
    ipc.lobbyRejoin().catch(() => {
      // A lobby that closed says so over the draft (`notice`); the view on screen stays.
    });
  }, [role]);

  // A host off the relay hears none of a guest's frames (issue #1585): the pick is greyed until
  // it is back, and then it is asked to push the seat again — a pick sent just before it dropped
  // went by unheard. `null` is a lobby not known yet, read as online.
  const lobby = lobbyFor(useLobbyState(), "draft");
  const hostOnline =
    role === "guest" && lobby !== null && lobby.phase !== "closed" ? lobby.hostOnline : null;
  const hostOffline = hostOnline === false;
  const wasOnline = useRef(hostOnline);
  useEffect(() => {
    const back = wasOnline.current === false && hostOnline === true;
    wasOnline.current = hostOnline;
    if (!back) return;
    ipc.lobbyRejoin().catch(() => {
      // As on arrival: the view on screen stays.
    });
  }, [hostOnline]);

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

  /**
   * The view a guest's pick or Winston decision went out on, by identity: drawn as waiting while
   * it is the view on screen. Any pushed view replaces the object, and so lets go of it — the
   * host's answer, or its re-send of a seat whose decision it never applied.
   */
  const [sentOn, setSentOn] = useState<DraftView | null>(null);
  /** Hold `at` as sent while `work` sends it — let go if the send is refused. Held from before
   *  the send, so a push that lands before `work` resolves still lets go of it. */
  const sending = async (at: DraftView | null, work: () => Promise<void>) => {
    setSentOn(at);
    try {
      await work();
    } catch (e) {
      setSentOn(null);
      throw e;
    }
  };

  const pick = (cards: DraftCard[], to: Destination) =>
    void run(async () => {
      const ids = cards.map((c) => c.instanceId);
      if (role === "guest" || draft === null) {
        await sending(view, () => ipc.lobbyPick(ids));
        send(ids, to);
        return;
      }
      const next = await ipc.draftPick(draft, ids);
      send(ids, to);
      setView(next);
    });

  const decide = (pile: number, take: boolean) =>
    void run(async () => {
      if (role === "guest" || draft === null) {
        await sending(view, () => ipc.lobbyWinston(pile, take));
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
      resetSideboard();
      onBack();
    });

  const building = view?.status === "deckbuilding";
  const sent = sentOn !== null && sentOn === view;
  // The pool in a tray beside the pack (issue #1474): the pick screen splits the height between
  // the pack's scroller and the tray's, so this box gives it the whole height and scrolls nothing
  // itself. A Winston table and the Build step keep the pool underneath, in this one scroller.
  const layout = useDraftTrayLayout((s) => s.layout);
  const sideTray = layout === "side" && view !== null && !building && view.stack === null;

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
      <div
        ref={scrollRef}
        className={cn(
          "min-h-0 flex-1 pt-3",
          sideTray ? "flex flex-col overflow-hidden" : "overflow-y-auto pb-8 pr-1",
        )}
      >
        {hostOffline && view !== null && !building && (
          <p
            role="status"
            className="m-0 mb-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm"
          >
            The host is offline — your pick waits until they are back.
          </p>
        )}
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
              sideboard={sideboard}
              onBuilt={() => {
                currentDraft.keep(null);
                resetSideboard();
              }}
            />
            <PoolZones pool={view.pool} sideboard={sideboard} onMove={move} />
          </div>
        ) : (
          <PickScreen
            view={sent && view.stack === null ? { ...view, waiting: true } : view}
            busy={busy || hostOffline}
            error={error}
            onPick={pick}
            onAutoPick={autoPick}
            onWinston={decide}
            winstonSent={sent}
            sideboard={sideboard}
            onMove={move}
          />
        )}
      </div>
    </section>
  );
}
