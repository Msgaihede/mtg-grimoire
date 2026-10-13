import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { ArrowRight, ChevronLeft, Menu } from "lucide-react";
import type { GameCard, GoldfishAction, GoldfishPlace, GoldfishView } from "@/lib/ipc";
import { CardImage } from "@/components/CardImage";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { cardImageUrl } from "@/lib/images";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Battlefield } from "./Battlefield";
import { HandFan } from "./HandFan";
import { INSPECT_WIDTH, Inspect } from "./Inspect";
import { LibraryDialog } from "./LibraryDialog";
import { LifePlate } from "./LifePlate";
import { gameMenu } from "./menus";
import { OpeningHand } from "./OpeningHand";
import { HelpPanel, LogPanel } from "./Panels";
import { CommandZone, ExileZone, GraveyardZone, LibraryZone } from "./ZonePile";
import { dropAction, type GoldfishDrag } from "./goldfishDrag";
import { useLanding } from "./landing";
import { handRow } from "./layout";
import type { LogLine } from "./log";
import { feltBackground } from "./playmats";
import type { Playmat, Pointed, ZoneLook } from "./types";

/**
 * The goldfish board — the artboards `Goldfish · opening hand` and `Goldfish · the table, turn 9`
 * (2026-10-12), drawn from one {@link GoldfishView} and asking for everything through `onAct`.
 *
 * **Presentational, and that is what its stories stand on**: it never calls `ipc`, so a story
 * draws it from a fixture view and records what it asks (`fixtures.ts`). `GoldfishPage` is the
 * one place that wires it to the engine.
 *
 * **The frame, and nothing drawn by itself**: the artboard's fixed places — a dashed table inset
 * 150 px from either side, 92 from the top and 108 from the bottom; the zone columns 22 px in at
 * 250 px down; the plates and the hand at the foot — each filled by a component of its own file.
 * Positions are the artboard's, measured from this element's box rather than its 1440 × 900 frame,
 * so a wider window has a wider table and the same margins.
 *
 * **One card is "pointed at" for the whole board** (`hover`): it is what the inspect preview
 * shows, and what the T / G / E / H keys act on — the artboard's help says "point at a card and
 * press…".
 *
 * **A card that lands pops once where it landed** (`useLanding`): the table places a card by the
 * rules rather than where it was let go, so the reader is shown where it went.
 */
export interface GoldfishBoardProps {
  /** The deck's name, for the back button: "‹ Aerith  Esc". */
  deckName: string;
  /** `null` while a game is being dealt. */
  view: GoldfishView | null;
  log: readonly LogLine[];
  /** The engine's last refusal, shown in the status line until the next action. */
  error: string | null;
  onAct: (action: GoldfishAction) => void;
  onBack: () => void;
  onNewGame: () => void;
  /** The commander's art behind the table (the game menu's Playmat). Default: felt. */
  initialPlaymat?: Playmat;
}

const CHROME_BUTTON = cn(
  "inline-flex items-center justify-center border border-border bg-surface text-text",
  "transition-colors motion-reduce:transition-none hover:border-accent",
  PRESS,
  FOCUS,
);

export function GoldfishBoard({
  deckName,
  view,
  log,
  error,
  onAct,
  onBack,
  onNewGame,
  initialPlaymat = "felt",
}: GoldfishBoardProps): JSX.Element {
  const [pointed, setPointed] = useState<Pointed | null>(null);
  const [panel, setPanel] = useState<"help" | "log" | null>(null);
  const [look, setLook] = useState<ZoneLook | null>(null);
  const [playmat, setPlaymat] = useState<Playmat>(initialPlaymat);
  /** The preview's card width, which the wheel changes while it is open; kept for the game. */
  const [previewWidth, setPreviewWidth] = useState(INSPECT_WIDTH);
  const { menuClick } = useContextMenu();
  const root = useRef<HTMLDivElement>(null);
  useLanding(root, view);

  // **What is pointed at, as the current view has it.** A tap keeps a card's id (only a zone
  // change mints a new one, CR 400.7) but not its state, and no new `mouseenter` fires on a card
  // that was clicked where it lies — so the card held in state is re-read here, by id, every
  // view. A card that has left its zone is no longer pointed at.
  const current = useMemo(() => fresh(pointed, view), [pointed, view]);

  const drop = useCallback(
    (drag: GoldfishDrag, to: GoldfishPlace) => {
      const action = dropAction(drag, to);
      if (action !== null) onAct(action);
      setPointed(null);
    },
    [onAct],
  );

  const commander = view?.command[0] ?? view?.battlefield.find((c) => c.isCommander) ?? null;

  // **The board's own keys**, the artboard's help panel's: Space for the next turn, and T, G, E,
  // H on the card pointed at — tap it, bury it, exile it, return it to hand. Not while a field
  // has the caret (the life steppers) or a menu or dialog is open over the board.
  //
  // **Space is the board's even on a focused button**, and the `preventDefault` is what makes it
  // so: a card clicked keeps the focus, and Space would otherwise press it — playing the card in
  // hand the reader only meant to end the turn after. Enter still presses a focused control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || view === null) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [role=menu]"))
        return;
      if (document.querySelector('[aria-modal="true"], [role="menu"]') !== null) return;
      const key = e.key.toLowerCase();
      if (key === " " && view.stage === "playing") {
        e.preventDefault();
        onAct({ type: "nextTurn" });
        return;
      }
      if (current === null || view.stage !== "playing") return;
      const id = current.ids[0];
      const action: GoldfishAction | null =
        key === "t" && current.place === "battlefield"
          ? { type: "tap", ids: [id], tapped: !current.card.tapped }
          : key === "g"
            ? { type: "move", id, to: "graveyard" }
            : key === "e"
              ? { type: "move", id, to: "exile" }
              : key === "h"
                ? { type: "move", id, to: "hand" }
                : null;
      if (action === null) return;
      e.preventDefault();
      setPointed(null);
      onAct(action);
    };
    // A button presses on Space's keyup, so the keyup is held back too.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || view === null || view.stage !== "playing") return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [role=menu]"))
        return;
      if (document.querySelector('[aria-modal="true"], [role="menu"]') !== null) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [onAct, current, view]);

  const point = setPointed;
  // **It takes no argument, and must not grow one**: every card hands it to `onMouseLeave` as it
  // is, so a parameter here is filled with the mouse event.
  const unpoint = useCallback(() => setPointed(null), []);

  // **A card's `mouseleave` is not the only way the pointer stops being on it.** A card redrawn
  // by another element — an untapped land joining a pile, a graveyard's new top card — is gone
  // from under the pointer without one, and is still in its zone, so nothing above lets go of it.
  // So while a card is pointed at, each move of the pointer is asked what it is over
  // (`data-point`), and anything but that card lets go.
  const pointedId = pointed?.card.id ?? null;
  useEffect(() => {
    if (pointedId === null) return;
    const onMove = (e: PointerEvent) => {
      const over = e.target instanceof Element ? e.target.closest("[data-point]") : null;
      if (over?.getAttribute("data-point") !== String(pointedId)) setPointed(null);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [pointedId]);

  const felt = feltBackground(playmat);
  const dead = view !== null && view.opponentLife <= 0;
  const status = error ?? log[0]?.text ?? "";

  return (
    <div
      ref={root}
      className="relative h-full w-full overflow-hidden bg-bg text-sm text-text"
      data-testid="goldfish-board"
    >
      {felt !== null && (
        <div
          aria-hidden="true"
          data-testid="goldfish-felt"
          className="pointer-events-none absolute inset-0"
          style={{ background: felt }}
        />
      )}
      {playmat === "commander" && commander?.cardId != null && (
        <CommanderMat cardId={commander.cardId} name={commander.name} />
      )}

      {/* The table's dashed edge, drawn under everything on it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-[150px] top-[92px] bottom-[108px] rounded-[28px] border border-dashed border-border opacity-70"
      />

      {view === null ? (
        <div className="absolute inset-x-[150px] top-[92px] bottom-[108px] flex items-center justify-center text-dim">
          {error ?? "Shuffling…"}
        </div>
      ) : view.stage === "mulligan" ? (
        <div className="absolute inset-x-[150px] top-[92px] bottom-[108px] flex items-center justify-center">
          <OpeningHand view={view} onAct={onAct} />
        </div>
      ) : (
        <Battlefield
          cards={view.battlefield}
          onAct={onAct}
          onDrop={drop}
          onPoint={point}
          onUnpoint={unpoint}
          className="absolute inset-x-[150px] top-[92px] bottom-[108px]"
        />
      )}

      {/* Top left: the game menu and the way back. */}
      <div className="absolute top-[14px] left-4 flex items-center gap-2">
        <button
          type="button"
          aria-label="Game menu"
          className={cn(CHROME_BUTTON, "size-9 rounded-full")}
          onClick={menuClick(() =>
            gameMenu({
              view,
              playmat,
              commanderName: commander?.name ?? null,
              onAct,
              onPlaymat: setPlaymat,
              onNewGame,
              onBack,
              onLook: setLook,
            }),
          )}
        >
          <Menu className="size-[18px]" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`Back to the ${deckName} deck`}
          onClick={onBack}
          className={cn(CHROME_BUTTON, "h-9 gap-1 rounded-full pr-3 pl-2 text-[13px]")}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {deckName}
          <kbd className="ml-1 rounded border border-border px-1 font-mono text-[11px] text-dim">
            Esc
          </kbd>
        </button>
      </div>

      {/* Top centre: the goldfish, whose life the reader keeps. */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2">
        <LifePlate
          seat="opponent"
          title={dead && view !== null ? `Opponent · dead on turn ${view.turn}` : "Opponent"}
          life={view?.opponentLife ?? 0}
          highlight={dead}
          disabled={view === null}
          onChange={(life) => onAct({ type: "setLife", seat: "opponent", life })}
        />
      </div>

      {/* Top right: help and the log. */}
      <div className="absolute top-[14px] right-4 flex gap-2">
        <button
          type="button"
          aria-label="How to move cards"
          aria-pressed={panel === "help"}
          onClick={() => setPanel(panel === "help" ? null : "help")}
          className={cn(
            CHROME_BUTTON,
            "h-9 min-w-9 rounded-full px-3 text-[13px]",
            panel === "help" && "border-accent text-accent",
          )}
        >
          ?
        </button>
        <button
          type="button"
          aria-pressed={panel === "log"}
          onClick={() => setPanel(panel === "log" ? null : "log")}
          className={cn(
            CHROME_BUTTON,
            "h-9 rounded-full px-3 text-[13px]",
            panel === "log" && "border-accent text-accent",
          )}
        >
          Log
        </button>
      </div>

      {/* The left column: command zone and exile. */}
      <div className="absolute top-[250px] left-[22px] flex flex-col gap-[22px]">
        <CommandZone view={view} onAct={onAct} onDrop={drop} onPoint={point} onUnpoint={unpoint} />
        <ExileZone view={view} onDrop={drop} onPoint={point} onUnpoint={unpoint} onLook={setLook} />
      </div>

      {/* The right column: graveyard and library. */}
      <div className="absolute top-[250px] right-[22px] flex flex-col items-end gap-[22px]">
        <GraveyardZone
          view={view}
          onDrop={drop}
          onPoint={point}
          onUnpoint={unpoint}
          onLook={setLook}
        />
        <LibraryZone view={view} onAct={onAct} onDrop={drop} onLook={setLook} />
      </div>

      {/* The foot: the reader's hand, their plate beside it, the turn and its button. */}
      {view !== null && view.stage === "playing" && (
        <HandFan
          cards={view.hand}
          onAct={onAct}
          onDrop={drop}
          onPoint={point}
          onUnpoint={unpoint}
          pointedId={current?.place === "hand" ? current.card.id : null}
        />
      )}
      {/* The plate sits just left of the hand's band — the artboard's `handLeft - 236` — so it
          moves out as the hand grows, and never under 16 px from the edge. During the opening
          hand there is no band, and it takes the artboard's fixed place. */}
      <div
        className="absolute bottom-4"
        style={{
          left:
            view?.stage === "playing"
              ? `max(16px, calc(50% - ${handRow(view.hand.length).width / 2 + 20 + 236}px))`
              : "274px",
        }}
      >
        <LifePlate
          seat="you"
          title="You"
          life={view?.life ?? 0}
          cardId={commander?.cardId ?? null}
          disabled={view === null}
          onChange={(life) => onAct({ type: "setLife", seat: "you", life })}
        />
      </div>

      {status !== "" && panel !== "log" && (
        <span
          role="status"
          className={cn(
            "pointer-events-none absolute bottom-[18px] left-4 max-w-[260px] text-xs",
            error === null ? "text-dim" : "text-text",
          )}
        >
          {status}
        </span>
      )}

      {view !== null && view.stage === "playing" && (
        <div className="absolute right-4 bottom-4 flex flex-col items-end gap-2">
          <span className="text-xs text-dim">
            Turn {view.turn} · {view.manaOpen} mana open · hand {view.hand.length}
          </span>
          <button
            type="button"
            onClick={() => onAct({ type: "nextTurn" })}
            aria-keyshortcuts="Space"
            className={cn(
              "inline-flex flex-col items-center gap-1 rounded-2xl border border-accent bg-surface px-6 pt-2 pb-1.5",
              "text-[15px] font-semibold text-accent transition-colors motion-reduce:transition-none",
              "hover:bg-accent hover:text-accent-fg",
              PRESS,
              FOCUS,
            )}
          >
            <span className="inline-flex items-center gap-2.5">
              Next turn
              <ArrowRight className="size-[18px]" aria-hidden="true" />
            </span>
            <kbd className="rounded border border-current px-1.5 font-mono text-[10px] leading-4 font-normal opacity-70">
              Space
            </kbd>
          </button>
        </div>
      )}

      <Inspect pointed={current} width={previewWidth} onResize={setPreviewWidth} />

      {panel === "help" && <HelpPanel onClose={() => setPanel(null)} />}
      {panel === "log" && <LogPanel log={log} onClose={() => setPanel(null)} />}

      {look !== null && view !== null && (
        <LibraryDialog look={look} view={view} onAct={onAct} onClose={() => setLook(null)} />
      )}
    </div>
  );
}

/** The commander's art across the whole board, dimmed to 28% under the cards. */
function CommanderMat({ cardId, name }: { cardId: string; name: string }): JSX.Element {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <PlaymatArt cardId={cardId} />
      <div className="absolute inset-0 bg-bg opacity-[0.72]" />
      <span className="absolute top-[58px] right-4 text-[11px] text-dim">Playmat: {name}</span>
    </div>
  );
}

function PlaymatArt({ cardId }: { cardId: string }): JSX.Element {
  return (
    <CardImage
      src={cardImageUrl(cardId, 0, "art")}
      alt=""
      className="block h-full w-full object-cover"
    />
  );
}

/** {@link Pointed} as `view` has it now, or `null` when its card is no longer in that zone. */
function fresh(pointed: Pointed | null, view: GoldfishView | null): Pointed | null {
  if (pointed === null || view === null) return null;
  const zone: readonly GameCard[] =
    pointed.place === "hand"
      ? view.hand
      : pointed.place === "battlefield"
        ? view.battlefield
        : pointed.place === "graveyard"
          ? view.graveyard
          : pointed.place === "exile"
            ? view.exile
            : pointed.place === "command"
              ? view.command
              : view.libraryCards;
  const card = zone.find((c) => c.id === pointed.card.id);
  if (card === undefined) return null;
  // A pile's other ids are kept only while they are still on the table.
  const ids = pointed.ids.filter((id) => zone.some((c) => c.id === id));
  return { ...pointed, card, ids: ids.length > 0 ? ids : [card.id] };
}
