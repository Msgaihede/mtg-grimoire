import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ArrowRight, ChevronLeft, LoaderCircle, Menu, Skull, SkipForward } from "lucide-react";
import type {
  GameCard,
  GoldfishAction,
  GoldfishPlace,
  PlaytestAction,
  PlaytestHappened,
  PlaytestSeat,
  PlaytestStackItem,
  PlaytestView,
} from "@/lib/ipc";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Battlefield, type TablePick } from "../goldfish/Battlefield";
import { CommanderMat } from "../goldfish/GoldfishBoard";
import { HandFan } from "../goldfish/HandFan";
import { INSPECT_WIDTH, Inspect, pointerAt } from "../goldfish/Inspect";
import { LibraryDialog } from "../goldfish/LibraryDialog";
import { LifePlate } from "../goldfish/LifePlate";
import { ManaTableView } from "../goldfish/ManaTable";
import { gameMenu } from "../goldfish/menus";
import { OpeningHand } from "../goldfish/OpeningHand";
import { HelpPanel, LogPanel } from "../goldfish/Panels";
import { CommandZone, ExileZone, GraveyardZone, LibraryZone } from "../goldfish/ZonePile";
import { dropAction, type GoldfishDrag } from "../goldfish/goldfishDrag";
import { useLandingOf } from "../goldfish/landing";
import { handRow, type ZoneSize } from "../goldfish/layout";
import type { LogLine } from "../goldfish/log";
import { feltBackground } from "../goldfish/playmats";
import type { Playmat, Pointed, ZoneLook } from "../goldfish/types";
import { fromGoldfish } from "./actions";
import {
  NO_PICKS,
  aimAttacker,
  aimsAtPlayer,
  pickAttacker,
  pickBlocker,
  stageButtons,
  tableMarks,
  tablePicks,
  toggleAttacker,
  type Picks,
} from "./combat";
import { combatArrows } from "./arrows";
import { CombatArrows } from "./CombatArrows";
import { DamagePops } from "./DamagePops";
import { MiddleLine, StackColumn } from "./MiddleLine";
import {
  OpponentCommand,
  OpponentHand,
  OpponentLibrary,
  OpponentPile,
  opponentHandWidth,
} from "./OpponentZones";
import { pickableCards } from "./prompt";
import { PickPanel } from "./PickPanel";
import { PromptPanel } from "./PromptPanel";

/**
 * The playtest board — the goldfish's table with an opponent across it: the reader's deck against
 * another of their decks, the opponent played by phase.rs's AI, the rules engine deciding.
 *
 * **Presentational, like `GoldfishBoard`**: a {@link PlaytestView} in, {@link PlaytestAction}s
 * out, no `ipc` — `PlaytestPage` is the one place that wires it to the engine, and the stories
 * draw it from fixtures (`fixtures.ts`).
 *
 * **The opponent's half is the reader's turned 180°**, in arrangement and not in pixels, so their
 * cards still read the right way up: their creatures nearest the middle line and their lands
 * behind toward the top edge (`Battlefield`'s `flipped`), their library and graveyard on the left
 * and exile and command zone on the right, their hand face down along the top edge. The reader's
 * half is the goldfish's own. Between them, the middle line: the turn, the stack, the combat.
 *
 * **The frame, measured from this element's box** so it fits a 1280 × 800 window with no scroll:
 * the opponent's band is the top 72 px (their hand, their plate, the chrome), the reader's
 * foot the bottom 108 (the hand, the plate, the stage button), the middle line
 * 36 px tall just above the centre, and the two tables share what is left equally — 275 px
 * each in a 766 px board. The zone columns' cards are {@link ZONE} rather than the goldfish's
 * 180 × 252: two of them and their labels stand beside each table's height.
 *
 * **The reader's cards are handled as on the goldfish** — drag between zones, a click taps, a
 * double-click plays, a right-click opens the goldfish's menus — and those are sandbox moves the
 * engine also allows here (the escape hatch for a card the rules cannot play). **The opponent's
 * are only looked at**: pointable for the preview, never dragged, tapped or opened in a menu.
 *
 * **A click is a pick when the rules are asking for one** (`combat.ts`): in the declare-attackers
 * step a creature that may attack is toggled as an attacker, in declare-blockers a blocker is
 * picked and then the attacker it blocks, and while the engine asks a question each answer that
 * names one card on the table makes that card clickable. Picks are kept here until the stage
 * button declares them, and dropped whenever a new view arrives.
 *
 * **Every action can take seconds** — the AI plays its whole turn before the engine answers — so
 * while one is with the engine (`busy`) the stage button says the opponent is thinking and nothing
 * new is offered; `PlaytestPage`'s hook queues anything sent anyway, in order.
 */
export interface PlaytestBoardProps {
  /** The reader's deck. */
  deckName: string;
  /** The opponent's deck, for their plate. */
  opponentName: string;
  /** `null` while a game is being dealt. */
  view: PlaytestView | null;
  log: readonly LogLine[];
  /** The engine's last refusal, shown in the status line until the next action. */
  error: string | null;
  /** An action is with the engine. */
  busy: boolean;
  onAct: (action: PlaytestAction) => void;
  onBack: () => void;
  onNewGame: () => void;
  initialPlaymat?: Playmat;
  /** What the view has just had happen, for the damage and life pops. A new list per step. */
  happened?: readonly PlaytestHappened[];
  /** The opponent's actions are being played back: the board is read-only, Skip ends it. */
  replaying?: boolean;
  onSkip?: () => void;
}

/** The zone columns' cards: 72 × 101, two fifths of the goldfish's 180 × 252 (issue #992 grew
 *  them a fifth from 60 × 84), their counts drawn on them. */
const ZONE: ZoneSize = { width: 72, height: 101, compact: true };

const NONE: readonly PlaytestHappened[] = [];

const CHROME_BUTTON = cn(
  "inline-flex items-center justify-center border border-border bg-surface text-text",
  "transition-colors motion-reduce:transition-none hover:border-accent",
  PRESS,
  FOCUS,
);

/**
 * Which side of the board a pointed card is on — a zone of that seat — or `loose`: a spell on the
 * stack, or a card an answer names that is on neither table (a library being searched). A loose
 * card is let go of only when the pointer leaves it.
 */
type Side = "you" | "opponent" | "loose";

export function PlaytestBoard({
  deckName,
  opponentName,
  view,
  log,
  error,
  busy,
  onAct,
  onBack,
  onNewGame,
  initialPlaymat = "felt",
  happened = NONE,
  replaying = false,
  onSkip,
}: PlaytestBoardProps): JSX.Element {
  const [pointed, setPointed] = useState<{ pointed: Pointed; side: Side } | null>(null);
  const [panel, setPanel] = useState<"help" | "log" | null>(null);
  const [look, setLook] = useState<{ look: ZoneLook; side: "you" | "opponent" } | null>(null);
  const [playmat, setPlaymat] = useState<Playmat>(initialPlaymat);
  const [previewWidth, setPreviewWidth] = useState(INSPECT_WIDTH);
  const { menuClick } = useContextMenu();
  const root = useRef<HTMLDivElement>(null);

  // **The reader's combat picks belong to the view they were made on.** Every answer is a new
  // view — the step moved on, or the engine refused and the old one came back — and either way
  // a pick held across it would name a declaration that is no longer being asked for. Adjusted
  // while rendering, React's way to reset state that follows a prop without an effect.
  const [held, setHeld] = useState<{ view: PlaytestView | null; picks: Picks }>({
    view,
    picks: NO_PICKS,
  });
  let picks = held.picks;
  if (held.view !== view) {
    picks = NO_PICKS;
    setHeld({ view, picks });
  }
  const setPicks = useCallback(
    (next: (p: Picks) => Picks) => setHeld((h) => ({ view: h.view, picks: next(h.picks) })),
    [],
  );

  // **"Passing turn…" from the press, not only from the answer**: `endTurn` can play out the
  // whole of a turn and the opponent's after it, and the busy state should say that is what it is
  // doing rather than that the opponent is thinking. Held against the view it was pressed on.
  const [ending, setEnding] = useState<PlaytestView | null>(null);
  const passing = (ending !== null && ending === view) || (view?.endingTurn ?? false);
  const act = useCallback(
    (action: PlaytestAction) => {
      setPointed(null);
      if (action.type === "endTurn") setEnding(view);
      onAct(action);
    },
    [onAct, view],
  );
  /** The goldfish's pieces speak `GoldfishAction` (`actions.ts`). */
  const goldfishAct = useCallback(
    (action: GoldfishAction) => {
      const mapped = fromGoldfish(action);
      if (mapped !== null) onAct(mapped);
    },
    [onAct],
  );

  const ids = useMemo(
    () => (view === null || view.stage === "mulligan" ? null : seen(view)),
    [view],
  );
  useLandingOf(root, ids);

  const current = useMemo(() => fresh(pointed, view), [pointed, view]);

  const drop = useCallback(
    (drag: GoldfishDrag, to: GoldfishPlace) => {
      const action = dropAction(drag, to);
      if (action !== null) goldfishAct(action);
      setPointed(null);
    },
    [goldfishAct],
  );

  const pointYou = useCallback((p: Pointed) => setPointed({ pointed: p, side: "you" }), []);
  const pointOpponent = useCallback(
    (p: Pointed) => setPointed({ pointed: p, side: "opponent" }),
    [],
  );
  // **It takes no argument, and must not grow one** — `GoldfishBoard`'s reason: every card hands
  // it to `onMouseLeave` as it is.
  const unpoint = useCallback(() => setPointed(null), []);
  const pointCard = useCallback(
    (card: GameCard, e: MouseEvent) => {
      const side = seatHolding(view, card.id);
      const inHand = view !== null && view.you.hand.some((c) => c.id === card.id);
      setPointed({
        pointed: {
          card,
          ids: [card.id],
          place: inHand ? "hand" : "battlefield",
          line: card.name,
          at: pointerAt(e),
        },
        side: side ?? "loose",
      });
    },
    [view],
  );
  const pointStack = useCallback(
    (card: GameCard, item: PlaytestStackItem, e: MouseEvent) =>
      setPointed({
        pointed: {
          card,
          ids: [card.id],
          place: "battlefield",
          line: `${item.name} · on the stack, ${item.seat === "you" ? "yours" : "the opponent's"}`,
          at: pointerAt(e),
        },
        side: "loose",
      }),
    [],
  );

  // `GoldfishBoard`'s guard against a card redrawn under a still pointer, for its reasons.
  const pointedId = pointed?.pointed.card.id ?? null;
  useEffect(() => {
    if (pointedId === null) return;
    const onMove = (e: PointerEvent) => {
      const over = e.target instanceof Element ? e.target.closest("[data-point]") : null;
      if (over?.getAttribute("data-point") !== String(pointedId)) setPointed(null);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [pointedId]);

  /** Nothing new is offered while the engine is busy or the opponent's turn is played back. */
  const locked = busy || replaying;
  const buttons = view === null ? null : stageButtons(view, picks);
  const primary = locked ? null : (buttons?.primary ?? null);

  // **The board's keys**: Space presses the stage button (to combat, end the turn, declare), and
  // T, G, E, H act on the reader's own card under the pointer as on the goldfish. Not while a
  // field has the caret or a menu or dialog is open, and Space is the board's even on a focused
  // button — `GoldfishBoard`'s reasons, both.
  useEffect(() => {
    const blocked = (e: KeyboardEvent) =>
      (e.target instanceof HTMLElement && e.target.closest("input, textarea, [role=menu]")) ||
      document.querySelector('[aria-modal="true"], [role="menu"]') !== null;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || view === null || blocked(e)) return;
      const key = e.key.toLowerCase();
      if (key === " ") {
        // Space skips a replay, as the Skip chip does; otherwise it presses the stage button.
        if (replaying) {
          e.preventDefault();
          onSkip?.();
          return;
        }
        if (primary === null) return;
        e.preventDefault();
        act(primary.action);
        return;
      }
      if (current === null || current.side !== "you" || locked) return;
      if (view.stage === "mulligan" || view.stage === "over") return;
      const id = current.pointed.ids[0];
      const action: PlaytestAction | null =
        key === "t" && current.pointed.place === "battlefield"
          ? { type: "tap", ids: [id], tapped: !current.pointed.card.tapped }
          : key === "g"
            ? { type: "move", id, to: "graveyard" }
            : key === "e"
              ? { type: "move", id, to: "exile" }
              : key === "h"
                ? { type: "move", id, to: "hand" }
                : null;
      if (action === null) return;
      e.preventDefault();
      act(action);
    };
    // A button presses on Space's keyup, so the keyup is held back too.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || view === null || blocked(e)) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [act, current, view, primary, replaying, onSkip, locked]);

  // The picks the rules are asking for, by side — stable per view and picks, so the tables'
  // piles are not re-cut on every render.
  const marks = useMemo(() => (view === null ? null : tableMarks(view, picks)), [view, picks]);
  const pickable = useMemo(() => (view === null ? null : tablePicks(view, picks)), [view, picks]);
  const answers = useMemo(() => pickableCards(view?.prompt ?? null), [view]);
  const stage = view?.stage ?? null;
  const yourPick = useMemo<TablePick | undefined>(() => {
    if (pickable === null || pickable.you.size === 0 || locked) return undefined;
    return {
      ids: pickable.you,
      onPick: (id) => {
        if (stage === "attack" && view !== null) setPicks((p) => toggleAttacker(p, view, id));
        else if (stage === "block") setPicks((p) => pickBlocker(p, id));
        else if (stage === "prompt") {
          const index = answers.get(id);
          if (index !== undefined) act({ type: "choose", index });
        }
      },
    };
  }, [view, pickable, locked, stage, answers, act, setPicks]);
  const theirPick = useMemo<TablePick | undefined>(() => {
    if (view === null || pickable === null || pickable.opponent.size === 0 || locked)
      return undefined;
    return {
      ids: pickable.opponent,
      onPick: (id) => {
        if (stage === "attack") setPicks((p) => aimAttacker(p, view, id));
        else if (stage === "block") setPicks((p) => pickAttacker(p, view, id));
        else if (stage === "prompt") {
          const index = answers.get(id);
          if (index !== undefined) act({ type: "choose", index });
        }
      },
    };
  }, [view, pickable, locked, stage, answers, act, setPicks]);
  const onActivate = useCallback((id: number) => act({ type: "activate", id }), [act]);
  const arrows = useMemo(() => (view === null ? [] : combatArrows(view, picks)), [view, picks]);

  const you = view?.you ?? null;
  const opponent = view?.opponent ?? null;
  const commander = you?.command[0] ?? you?.battlefield.find((c) => c.isCommander) ?? null;
  const felt = feltBackground(playmat);
  const status = error ?? log[0]?.text ?? "";
  const playing = view !== null && view.stage !== "mulligan" && view.stage !== "over";
  const handCount = opponent?.handCount ?? 0;
  const prompting = view !== null && view.stage === "prompt" && view.prompt !== null;
  const tabled = view !== null && view.stage !== "mulligan";
  /** Whose turn it is, lit on their plate — not before the first turn or after the last. */
  const active = playing && view.turn > 0 ? view.active : null;
  const lookYou = (l: ZoneLook) => setLook({ look: l, side: "you" });
  const lookOpponent = (l: ZoneLook) => setLook({ look: l, side: "opponent" });

  return (
    <div
      ref={root}
      aria-busy={busy}
      className="relative h-full w-full overflow-hidden bg-bg text-sm text-text"
      data-testid="playtest-board"
    >
      {felt !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ background: felt }}
        />
      )}
      {playmat === "commander" && commander?.cardId != null && (
        <CommanderMat cardId={commander.cardId} name={commander.name} />
      )}

      {/* The two tables' dashed edges, drawn under everything on them. */}
      <div
        aria-hidden="true"
        className={cn(
          OPPONENT_TABLE,
          "pointer-events-none rounded-[22px] border border-dashed border-border opacity-50",
        )}
      />
      <div
        aria-hidden="true"
        className={cn(
          YOUR_TABLE,
          "pointer-events-none rounded-[22px] border border-dashed border-border opacity-70",
        )}
      />

      {view === null ? (
        <div className="absolute inset-x-[96px] top-[48px] bottom-[112px] flex items-center justify-center text-dim">
          {error ?? "Shuffling both decks…"}
        </div>
      ) : view.stage === "mulligan" ? (
        // The whole board below the opponent's band (issue #993), the zone columns and the
        // reader's plate under a scrim: before the first turn the seven are all there is to read.
        <div
          data-testid="playtest-opening-hand"
          className={cn(
            "absolute inset-x-0 top-[48px] bottom-0 flex flex-col items-center gap-3 bg-bg/85 px-6 pt-2 pb-4",
            LAYER.raised,
          )}
        >
          {/* The middle line is not drawn over an opening hand, so a refusal is said here. */}
          {error !== null && (
            <p role="status" className="m-0 text-xs text-text">
              {error}
            </p>
          )}
          <OpeningHand
            view={{
              hand: view.you.hand,
              mulligan: view.mulligan,
              library: view.you.library,
              libraryLands: view.you.libraryCards.filter((c) => c.isLand).length,
            }}
            onAct={goldfishAct}
            onPoint={pointYou}
            onUnpoint={unpoint}
          />
        </div>
      ) : (
        <>
          <div data-table="opponent" className={OPPONENT_TABLE}>
            <Battlefield
              label="The opponent's battlefield"
              cards={view.opponent.battlefield}
              onAct={goldfishAct}
              onDrop={drop}
              onPoint={pointOpponent}
              onUnpoint={unpoint}
              flipped
              readOnly
              dense
              marks={marks?.opponent}
              pick={theirPick}
              className="h-full w-full"
            />
          </div>
          <MiddleLine
            view={view}
            picks={picks}
            status={status}
            failed={error !== null}
            onStops={locked ? undefined : (stops) => act({ type: "setStops", stops })}
            className="absolute inset-x-[96px] top-[calc(50%-46px)] h-7"
          />
          <div data-table="you" className={YOUR_TABLE}>
            <Battlefield
              label="Your battlefield"
              cards={view.you.battlefield}
              onAct={goldfishAct}
              onDrop={drop}
              onPoint={pointYou}
              onUnpoint={unpoint}
              dense
              readOnly={replaying}
              marks={marks?.you}
              pick={yourPick}
              onActivate={onActivate}
              className="h-full w-full"
            />
          </div>
          {/* The stack, in the right gutter between the two tables' zone columns. */}
          <StackColumn
            view={view}
            prominent={view.stage === "respond"}
            onPoint={pointStack}
            onUnpoint={unpoint}
            className={cn(
              "absolute top-[calc(50%-32px)] right-1.5 w-[72px] -translate-y-1/2",
              LAYER.raised,
            )}
          />
        </>
      )}

      {/* The opponent's band, the top 48 px: the way back and the menu, their hand face down
          hanging from the edge with their plate beside it, and help and the log. */}
      <div className={cn("absolute top-1.5 left-3 flex items-center gap-2", LAYER.raised)}>
        <button
          type="button"
          aria-label="Game menu"
          className={cn(CHROME_BUTTON, "size-9 rounded-full")}
          onClick={menuClick(() =>
            gameMenu({
              view:
                view === null
                  ? null
                  : { tokens: view.tokens, graveyard: view.you.graveyard, exile: view.you.exile },
              playing: playing && !locked,
              backLabel: "Back to setup",
              playmat,
              commanderName: commander?.name ?? null,
              onAct: goldfishAct,
              onPlaymat: setPlaymat,
              onNewGame,
              onBack,
              onLook: lookYou,
            }),
          )}
        >
          <Menu className="size-[18px]" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Back to the playtest setup"
          onClick={onBack}
          className={cn(CHROME_BUTTON, "h-9 gap-1 rounded-full pr-3 pl-2 text-[13px]")}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Setup
          <kbd className="ml-1 rounded border border-border px-1 font-mono text-[11px] text-dim">
            Esc
          </kbd>
        </button>
      </div>

      <div className="absolute top-0 left-1/2 -translate-x-1/2">
        <OpponentHand count={handCount} />
      </div>
      <div
        className="absolute top-[5px]"
        style={{ left: `calc(50% + ${opponentHandWidth(handCount) / 2 + 64}px)` }}
      >
        <PlateFrame
          seat="opponent"
          active={active === "opponent"}
          poison={opponent?.poison ?? 0}
          compact
        >
          <LifePlate
            seat="opponent"
            title={`Opponent · ${opponentName}`}
            life={opponent?.life ?? 0}
            highlight={view?.winner === "opponent"}
            disabled={view === null || locked}
            onChange={(life) => act({ type: "setLife", seat: "opponent", life })}
            compact
          />
          {/* An attacker waiting to be aimed, that may attack the opponent: their plate is the
              target to click. */}
          {view !== null && view.stage === "attack" && !locked && aimsAtPlayer(picks, view) && (
            <button
              type="button"
              onClick={() => setPicks((p) => aimAttacker(p, view, null))}
              className={cn(
                "absolute inset-0 rounded-full bg-transparent outline-2 outline-offset-2 outline-accent outline-dashed",
                FOCUS,
              )}
            >
              <span className="sr-only">Attack the opponent</span>
            </button>
          )}
        </PlateFrame>
      </div>

      <div className={cn("absolute top-1.5 right-3 flex gap-2", LAYER.raised)}>
        <button
          type="button"
          aria-label="How to play"
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

      {/* The opponent's columns, the reader's turned round: library and graveyard on the left,
          exile and the command zone on the right — each centred on their table's height. */}
      <div className={cn(OPPONENT_COLUMN, "left-3")}>
        <OpponentLibrary seat={opponent} size={ZONE} />
        <OpponentPile
          seat={opponent}
          zone="graveyard"
          size={ZONE}
          onPoint={pointOpponent}
          onUnpoint={unpoint}
          onLook={lookOpponent}
        />
      </div>
      <div className={cn(OPPONENT_COLUMN, "right-3 items-end")}>
        <OpponentPile
          seat={opponent}
          zone="exile"
          size={ZONE}
          onPoint={pointOpponent}
          onUnpoint={unpoint}
          onLook={lookOpponent}
          className="items-end"
        />
        <OpponentCommand
          seat={opponent}
          size={ZONE}
          onPoint={pointOpponent}
          onUnpoint={unpoint}
          className="items-end"
        />
      </div>

      {/* The reader's columns, the goldfish's: command and exile left, graveyard and library
          right. */}
      <div className={cn(YOUR_COLUMN, "left-3")}>
        <CommandZone
          view={you}
          onAct={goldfishAct}
          onDrop={drop}
          onPoint={pointYou}
          onUnpoint={unpoint}
          size={ZONE}
        />
        <ExileZone
          view={you}
          onDrop={drop}
          onPoint={pointYou}
          onUnpoint={unpoint}
          onLook={lookYou}
          size={ZONE}
        />
      </div>
      <div className={cn(YOUR_COLUMN, "right-3 items-end")}>
        <GraveyardZone
          view={you}
          onDrop={drop}
          onPoint={pointYou}
          onUnpoint={unpoint}
          onLook={lookYou}
          size={ZONE}
        />
        <LibraryZone view={you} onAct={goldfishAct} onDrop={drop} onLook={lookYou} size={ZONE} />
      </div>

      {/* The foot: the reader's hand, their plate beside it, and the stage button. */}
      {tabled && (
        <HandFan
          cards={view.you.hand}
          onAct={goldfishAct}
          onDrop={drop}
          onPoint={pointYou}
          onUnpoint={unpoint}
          pointedId={
            current?.side === "you" && current.pointed.place === "hand"
              ? current.pointed.card.id
              : null
          }
        />
      )}
      {/* Beside the hand, as on the goldfish — and at the very edge while a prompt is docked over
          the hand, so the two never meet. */}
      <div
        className="absolute bottom-3"
        style={{
          left:
            tabled && !prompting
              ? `max(12px, calc(50% - ${handRow(view.you.hand.length).width / 2 + 20 + 236}px))`
              : "12px",
        }}
      >
        <PlateFrame seat="you" active={active === "you"} poison={you?.poison ?? 0}>
          <LifePlate
            seat="you"
            title={`You · ${deckName}`}
            life={you?.life ?? 0}
            cardId={commander?.cardId ?? null}
            highlight={view?.winner === "you"}
            disabled={view === null || locked}
            onChange={(life) => act({ type: "setLife", seat: "you", life })}
          />
        </PlateFrame>
      </div>

      {view !== null && view.stage !== "mulligan" && view.stage !== "over" && !replaying && (
        <div className="absolute right-3 bottom-3 flex flex-col items-end gap-2">
          <ManaTableView mana={view.you.mana} label="Your mana" />
          <span className="text-xs text-dim">
            {view.you.manaOpen} mana open · hand {view.you.hand.length}
          </span>
          {busy ? (
            <span
              role="status"
              className="inline-flex h-[58px] items-center gap-2.5 rounded-2xl border border-border bg-surface px-6 text-[15px] text-dim"
            >
              <LoaderCircle
                className="size-[18px] animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {passing ? "Passing turn…" : "Opponent is thinking…"}
            </span>
          ) : (
            buttons !== null &&
            buttons.primary !== null && (
              <div className="flex items-end gap-2">
                {buttons.secondary !== null && (
                  <button
                    type="button"
                    aria-disabled={buttons.secondary.disabled === true}
                    onClick={() =>
                      buttons.secondary !== null &&
                      buttons.secondary.disabled !== true &&
                      act(buttons.secondary.action)
                    }
                    className={cn(
                      "inline-flex h-11 items-center rounded-2xl border border-border bg-surface px-4",
                      "text-[13px] text-text transition-colors motion-reduce:transition-none hover:border-accent",
                      PRESS,
                      FOCUS,
                      buttons.secondary.disabled === true &&
                        "cursor-default text-dim hover:border-border active:scale-100",
                    )}
                  >
                    {buttons.secondary.label}
                  </button>
                )}
                <StageButton
                  label={buttons.primary.label}
                  onPress={() => buttons.primary !== null && act(buttons.primary.action)}
                />
              </div>
            )
          )}
        </div>
      )}

      {prompting && view.prompt!.pick !== null && (
        <PickPanel
          key={view.prompt!.pick.cards.map((c) => c.id).join(",")}
          prompt={{ ...view.prompt!, pick: view.prompt!.pick }}
          table={[...view.you.battlefield, ...view.opponent.battlefield, ...view.you.hand]}
          disabled={locked}
          onAct={act}
          onPoint={pointCard}
          onUnpoint={unpoint}
          className="absolute top-[calc(50%-32px)] left-1/2 max-h-[calc(100%-200px)] w-[min(820px,calc(100%-200px))] -translate-x-1/2 -translate-y-1/2"
        />
      )}
      {prompting && view.prompt!.pick === null && (
        <PromptPanel
          prompt={view.prompt!}
          table={[...view.you.battlefield, ...view.opponent.battlefield, ...view.you.hand]}
          disabled={locked}
          onAct={act}
          onPoint={pointCard}
          onUnpoint={unpoint}
          className="absolute bottom-2 left-1/2 max-h-[104px] w-[min(640px,calc(100%-560px))] -translate-x-1/2"
        />
      )}

      {view !== null && view.stage === "over" && !replaying && (
        <GameOver winner={view.winner} turn={view.turn} onNewGame={onNewGame} onBack={onBack} />
      )}

      <CombatArrows root={root} arrows={arrows} />
      <DamagePops root={root} view={view} happened={happened} />

      {/* **Read-only while the opponent's turn is played back**: one sheet over the whole board
          takes every press, and only the Skip chip above it answers one. */}
      {replaying && (
        <>
          <div
            aria-hidden="true"
            data-testid="replay-shield"
            className={cn("absolute inset-0", LAYER.raised)}
          />
          <button
            type="button"
            onClick={onSkip}
            aria-keyshortcuts="Space Escape"
            className={cn(
              "absolute right-3 bottom-3 inline-flex h-11 items-center gap-2 rounded-full border border-mana-r bg-surface px-4",
              "text-[13px] text-text transition-colors motion-reduce:transition-none hover:bg-mana-r hover:text-bg",
              LAYER.raised,
              PRESS,
              FOCUS,
            )}
          >
            <span className="text-dim">Opponent’s turn</span>
            <span className="font-semibold">Skip</span>
            <SkipForward className="size-4" aria-hidden="true" />
          </button>
        </>
      )}

      <Inspect pointed={current?.pointed ?? null} width={previewWidth} onResize={setPreviewWidth} />

      {panel === "help" && (
        <HelpPanel heading="Playing a game" onClose={() => setPanel(null)}>
          <PlaytestHelp />
        </HelpPanel>
      )}
      {panel === "log" && <LogPanel log={log} onClose={() => setPanel(null)} />}

      {look !== null && view !== null && (
        <LibraryDialog
          look={look.look}
          view={look.side === "you" ? view.you : view.opponent}
          opponent={look.side === "opponent"}
          onAct={goldfishAct}
          onClose={() => setLook(null)}
        />
      )}
    </div>
  );
}

/**
 * **The frame**, measured from the board's box: the opponent's band is the top 48 px, the reader's
 * foot the bottom 112, the middle line 28 px tall just above the centre, and the two tables share
 * the rest equally — `calc(50% - 94px)` each, 289 px in a 766 px board (1280 × 800 less the
 * caption), 339 in an 866 px one. The tables are 96 px in from either side: a 72 px zone column
 * 12 px from the edge, and 12 px between it and the table.
 */
const OPPONENT_TABLE = "absolute inset-x-[96px] top-[48px] bottom-[calc(50%+46px)]";
const YOUR_TABLE = "absolute inset-x-[96px] top-[calc(50%-18px)] bottom-[112px]";
/** A zone column, centred on its table's height. */
const OPPONENT_COLUMN =
  "absolute top-[48px] bottom-[calc(50%+46px)] flex flex-col justify-center gap-2";
const YOUR_COLUMN =
  "absolute top-[calc(50%-18px)] bottom-[112px] flex flex-col justify-center gap-2";

/**
 * A plate's frame: `data-plate`, which the combat's arrows and the life pops find it by, a gold
 * glow on the plate of the seat whose turn it is, and the seat's poison counters when it has any.
 */
function PlateFrame({
  seat,
  active,
  poison,
  compact = false,
  children,
}: {
  seat: "you" | "opponent";
  active: boolean;
  poison: number;
  compact?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      data-plate={seat}
      data-active={active || undefined}
      className={cn(
        "relative flex items-center gap-2 transition-shadow duration-200 motion-reduce:transition-none",
        compact ? "rounded-full" : "rounded-[14px]",
        active &&
          "shadow-[0_0_0_2px_var(--color-accent),0_0_18px_color-mix(in_oklch,var(--color-accent)_45%,transparent)]",
      )}
    >
      {children}
      {poison > 0 && (
        <span
          aria-label={`${poison} poison`}
          className={cn(
            "inline-flex flex-none items-center gap-1 rounded-full border border-mana-g bg-surface px-2 font-mono text-xs/6 font-semibold text-mana-g tabular-nums",
            !compact && "absolute -top-3 right-2",
          )}
        >
          <Skull className="size-3.5" aria-hidden="true" />
          {poison}
        </span>
      )}
    </div>
  );
}

/** The foot's primary button — the goldfish's "Next turn", saying what this one does. */
function StageButton({ label, onPress }: { label: string; onPress: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onPress}
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
        {label}
        <ArrowRight className="size-[18px]" aria-hidden="true" />
      </span>
      <kbd className="rounded border border-current px-1.5 font-mono text-[10px] leading-4 font-normal opacity-70">
        Space
      </kbd>
    </button>
  );
}

/** The result, over the middle of the board — the tables stay drawn around it to be looked at. */
function GameOver({
  winner,
  turn,
  onNewGame,
  onBack,
}: {
  winner: PlaytestView["winner"];
  turn: number;
  onNewGame: () => void;
  onBack: () => void;
}): JSX.Element {
  const title = winner === "you" ? "You won" : winner === "opponent" ? "You lost" : "Draw";
  return (
    <section
      aria-label="Game over"
      className={cn(
        "absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3",
        "rounded-2xl border border-accent bg-surface px-10 py-6 shadow-lg",
        LAYER.raised,
      )}
    >
      <h2 className="m-0 font-heading text-3xl font-semibold">{title}</h2>
      <p className="m-0 text-sm text-dim">On turn {turn}</p>
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={onNewGame}
          className={cn(
            "inline-flex h-10 items-center rounded-full border border-accent bg-surface px-5",
            "text-[14px] font-semibold text-accent transition-colors motion-reduce:transition-none",
            "hover:bg-accent hover:text-accent-fg",
            PRESS,
            FOCUS,
          )}
        >
          New game
        </button>
        <button
          type="button"
          onClick={onBack}
          className={cn(
            "inline-flex h-10 items-center rounded-full border border-border bg-surface px-5",
            "text-[14px] text-text transition-colors motion-reduce:transition-none hover:border-accent",
            PRESS,
            FOCUS,
          )}
        >
          Back to setup
        </button>
      </div>
    </section>
  );
}

/** The help panel's lines for this board: the goldfish's handling, and the rules' clicks. */
function PlaytestHelp(): JSX.Element {
  return (
    <>
      <span>
        Double-click a card in hand, or drag it onto your battlefield, to play it by the rules.
      </span>
      <span>Click a permanent to tap it; right-click it to activate an ability, and the rest.</span>
      <span>
        To attack, click each creature that should (it moves forward, ringed red), then press
        Attack.
      </span>
      <span>
        To block, click one of your creatures, then the attacker it blocks; both get a number. Click
        a blocker again to take it off.
      </span>
      <span>When the engine asks, click a highlighted card or pick an answer in the panel.</span>
      <span className="text-dim">
        Drag any of your cards anywhere to put it there by hand, outside the rules. The opponent’s
        cards can only be looked at.
      </span>
      <span className="text-dim">
        Press Space for the button at the bottom right: to combat, end the turn, attack or block.
      </span>
    </>
  );
}

/** Every id a card can land as on this board: the reader's every zone, the opponent's open ones. */
function seen(view: PlaytestView): Set<number> {
  const out = new Set<number>();
  const { you, opponent } = view;
  for (const zone of [
    you.hand,
    you.battlefield,
    you.graveyard,
    you.exile,
    you.command,
    you.libraryCards,
    opponent.battlefield,
    opponent.graveyard,
    opponent.exile,
    opponent.command,
  ]) {
    for (const c of zone) out.add(c.id);
  }
  return out;
}

/** Which seat's battlefield or hand holds `id`, for a card pointed at from the prompt panel. */
function seatHolding(view: PlaytestView | null, id: number): "you" | "opponent" | null {
  if (view === null) return null;
  if (view.you.battlefield.some((c) => c.id === id) || view.you.hand.some((c) => c.id === id))
    return "you";
  if (view.opponent.battlefield.some((c) => c.id === id)) return "opponent";
  return null;
}

/** One seat's cards in `place`. */
function zoneOf(seat: PlaytestSeat, place: GoldfishPlace): readonly GameCard[] {
  switch (place) {
    case "hand":
      return seat.hand;
    case "battlefield":
      return seat.battlefield;
    case "graveyard":
      return seat.graveyard;
    case "exile":
      return seat.exile;
    case "command":
      return seat.command;
    default:
      return seat.libraryCards;
  }
}

/**
 * The card pointed at as `view` has it now, or `null` once it has left that zone — `GoldfishBoard`'s
 * `fresh`, on whichever seat it is on. A loose card is kept as it is.
 */
function fresh(
  held: { pointed: Pointed; side: Side } | null,
  view: PlaytestView | null,
): { pointed: Pointed; side: Side } | null {
  if (held === null || view === null) return null;
  const { pointed, side } = held;
  if (side === "loose") return held;
  const zone = zoneOf(side === "you" ? view.you : view.opponent, pointed.place);
  const card = zone.find((c) => c.id === pointed.card.id);
  if (card === undefined) return null;
  const ids = pointed.ids.filter((id) => zone.some((c) => c.id === id));
  return { side, pointed: { ...pointed, card, ids: ids.length > 0 ? ids : [card.id] } };
}
