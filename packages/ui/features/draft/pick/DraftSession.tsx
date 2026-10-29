import { useEffect, useRef, useState, type JSX } from "react";
import { LogOut, Trash2 } from "lucide-react";
import { ipc, ipcError, type DraftCard, type DraftMode, type DraftView } from "@/lib/ipc";
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
 * Going back to the hub keeps the draft (`./current.ts`; a solo draft is saved by the host too);
 * *Abandon* puts a solo draft away, *Leave pod* leaves the lobby.
 */
export function DraftSession({
  draft,
  role,
  initial,
  onBack,
}: {
  draft: number | null;
  role: DraftRole;
  initial: DraftView | null;
  onBack: () => void;
}): JSX.Element {
  const [view, setView] = useState<DraftView | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A ref as well as the state: a fast second click lands before the re-render that greys the
  // pack, and a pick sent twice is a refusal from the engine at best.
  const inFlight = useRef(false);

  useEffect(() => {
    currentDraft.keep({ draft, role, view });
  }, [draft, role, view]);

  useEffect(
    () => ipc.onDraftView((pushed) => setView((cur) => (acceptsView(cur, pushed) ? pushed : cur))),
    [],
  );

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

  const pick = (card: DraftCard) =>
    void run(async () => {
      if (role === "guest" || draft === null) {
        const at = view;
        await ipc.lobbyPick([card.instanceId]);
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
      setView(await ipc.draftPick(draft, [card.instanceId]));
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
          <button type="button" onClick={abandon} className={QUIET_BUTTON}>
            {role === "solo" ? (
              <>
                <Trash2 className="size-4" aria-hidden="true" />
                Abandon
              </>
            ) : (
              <>
                <LogOut className="size-4" aria-hidden="true" />
                Leave pod
              </>
            )}
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-8 pt-3 pr-1">
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
          <PickScreen view={view} busy={busy} error={error} onPick={pick} onAutoPick={autoPick} />
        )}
      </div>
    </section>
  );
}
