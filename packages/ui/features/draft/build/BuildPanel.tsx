import { useId, useMemo, useState, type JSX } from "react";
import { Hammer } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { openDraftDeck } from "@/features/draft/navigation";
import { plural } from "@/lib/counts";
import { ipc, ipcError, type DraftView } from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { colorTally, isLand } from "../pick/pool";
import { ColorTally } from "../pick/PoolColumns";
import { FIELD, LABEL, PANEL, PrimaryButton } from "../setup/parts";

/** Whose draft this is, which decides how it is put away once the deck is built. */
export type DraftRole = "solo" | "host" | "guest";

/**
 * The Build step: what the pool holds, a name for the deck, and the press that turns the pool
 * into a deck in the deck editor's draft mode (spec §5) — a **virtual** Limited deck whose Pool
 * holds every card drafted, never the collection's.
 *
 * Once the deck exists the draft is put away: a solo draft's saved copy is dropped
 * (`draft_end`), and a pod's seat leaves the lobby (`lobby_leave` — for the host that closes the
 * room, which every guest has already been dealt their last view by). A failure to put it away
 * loses nothing — the deck is made, and a solo draft left saved is one *Abandon* on the hub — so
 * it is not said.
 */
export function BuildPanel({
  view,
  draft,
  role,
  onBuilt,
}: {
  view: DraftView;
  /** The page's name for the draft — `null` for a guest, whose draft runs on the host. */
  draft: number | null;
  role: DraftRole;
  /** The deck is made and the draft put away — the session forgets it. */
  onBuilt?: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState(`${view.label} Draft`);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const tally = useMemo(() => colorTally(view.pool), [view.pool]);
  const lands = view.pool.filter(isLand).length;
  const creatures = view.pool.filter((c) => !isLand(c) && /\bCreature\b/.test(c.typeLine)).length;
  const others = view.pool.length - lands - creatures;
  const ready = name.trim() !== "" && view.pool.length > 0;

  const build = async () => {
    setBusy(true);
    try {
      const row = await ipc.draftDeckCreate(
        name.trim(),
        view.pool.map((c) => c.cardId),
      );
      try {
        if (role === "solo" && draft !== null) await ipc.draftEnd(draft);
        else await ipc.lobbyLeave();
      } catch {
        // See the component's doc: the deck is made, and nothing the reader did is lost.
      }
      void queryClient.invalidateQueries({ queryKey: ["draftDecks"] });
      void queryClient.invalidateQueries({ queryKey: ["decks"] });
      onBuilt?.();
      notify.success(`Built “${row.name}” from a ${view.pool.length}-card pool`);
      openDraftDeck(row.id);
    } catch (e) {
      notify.error("Couldn’t build the deck", { body: ipcError(e) });
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`${fieldId}-title`} className={cn(PANEL, "flex flex-col gap-5 p-6")}>
      <div className="flex flex-col gap-2">
        <h3 id={`${fieldId}-title`} className="m-0 font-heading text-xl font-semibold">
          Build your deck
        </h3>
        <p className="m-0 max-w-[60ch] text-sm text-dim">
          The draft is done. Your {plural(view.pool.length, "card")} go into a deck of their own,
          all in its Pool — move the ones you play into the Deck and add basics in the editor. A
          deck needs {view.minDeckSize} cards. Nothing is added to your collection.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span>
          <span className="font-mono tabular-nums">{creatures}</span>{" "}
          <span className="text-dim">{creatures === 1 ? "creature" : "creatures"}</span>
        </span>
        <span>
          <span className="font-mono tabular-nums">{others}</span>{" "}
          <span className="text-dim">{others === 1 ? "other spell" : "other spells"}</span>
        </span>
        <span>
          <span className="font-mono tabular-nums">{lands}</span>{" "}
          <span className="text-dim">{lands === 1 ? "land" : "lands"}</span>
        </span>
        <ColorTally tally={tally} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-72 flex-1 flex-col gap-1.5">
          <label htmlFor={fieldId} className={LABEL}>
            Deck name
          </label>
          <input
            id={fieldId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready && !busy) void build();
            }}
            className={FIELD}
          />
        </div>
        <PrimaryButton ready={ready} busy={busy} onPress={() => void build()}>
          <Hammer className="size-4" aria-hidden="true" />
          Build deck
        </PrimaryButton>
      </div>
    </section>
  );
}
