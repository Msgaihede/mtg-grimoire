import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent,
} from "react";
import { ArrowRight, ChevronLeft, LoaderCircle, Menu, SkipForward } from "lucide-react";
import type {
  GameCard,
  GamePlace,
  PlaytestAction,
  PlaytestHappened,
  PlaytestPlayer,
  PlaytestSeat,
  PlaytestStackItem,
  PlaytestView,
} from "@/lib/ipc";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Battlefield, tableCardWidth, type TablePick } from "../table/Battlefield";
import { CommanderMat } from "../table/CommanderMat";
import { HandFan } from "../table/HandFan";
import { INSPECT_WIDTH, Inspect, pointerAt } from "../table/Inspect";
import { LibraryDialog } from "../table/LibraryDialog";
import { LifePlate } from "../table/LifePlate";
import { ManaTableView } from "../table/ManaTable";
import { gameMenu } from "../table/menus";
import { OpeningHand } from "../table/OpeningHand";
import { HelpPanel, LogPanel } from "../table/Panels";
import { CommandZone, ExileZone, GraveyardZone, LibraryZone } from "../table/ZonePile";
import { dropAction, type DropAim, type TableAim, type TableDrag } from "../table/tableDrag";
import { useLandingOf } from "../table/landing";
import { useUndoKeys } from "../undo";
import { ASPECT, acrossTables, handRow, type ZoneSize } from "../table/layout";
import type { LogLine } from "../table/log";
import { feltBackground } from "../table/playmats";
import type { Playmat, Pointed, ZoneLook } from "../table/types";
import {
  NO_PICKS,
  aimAttacker,
  aimablePlayers,
  pickAttacker,
  pickBlocker,
  stageButtons,
  tableMarks,
  tablePicks,
  toggleAttacker,
  type Picks,
} from "./combat";
import { aimDrop, canCarry, retractDrop, useAimFollowThrough, type AimAt } from "./aim";
import { combatArrows, targetArrows } from "./arrows";
import { BoardArrows } from "./BoardArrows";
import { DamagePops } from "./DamagePops";
import { MiddleLine, StackColumn } from "./MiddleLine";
import { OpponentArea } from "./OpponentArea";
import {
  OpponentCommand,
  OpponentHand,
  OpponentLibrary,
  OpponentPile,
  opponentHandWidth,
} from "./OpponentZones";
import { PlateFrame } from "./PlateFrame";
import { OPPONENTS, playerPossessive, seatOfPlayer, tableCards } from "./players";
import { pickableCards } from "./prompt";
import { PickPanel } from "./PickPanel";
import { PromptPanel } from "./PromptPanel";
import { RespondPrompt, respondingTo } from "./RespondPrompt";

/**
 * The board — one table for every game on a deck: the reader's deck against **the goldfish**, an
 * opponent that does nothing and never loses (`view.goldfish`), or against another of their decks
 * played by phase.rs's AI, or three of them at a four-player table. The rules engine decides in
 * every case; goldfishing is a playtest whose opponent takes no actions (the owner's decision of
 * 2026-10-17), so a change to this board is a change to both.
 *
 * **Presentational**: a {@link PlaytestView} in, {@link PlaytestAction}s out, no `ipc` —
 * `PlaytestPage` is the one place that wires it to the engine, and the stories draw it from
 * fixtures (`fixtures.ts`). The table's pieces (`../table/`) speak `PlaytestAction` too, and are
 * handed `onAct` as it is.
 *
 * **The opponent's half is the reader's turned 180°**, in arrangement and not in pixels, so their
 * cards still read the right way up: their creatures nearest the middle line and their lands
 * behind toward the top edge (`Battlefield`'s `flipped`), their library and graveyard on the left
 * and exile and command zone on the right, their hand face down along the top edge. Between the
 * two halves, the middle line: the turn, the stack, the combat. **The goldfish is drawn exactly
 * so**, as a single AI opponent is — its band, its face-down hand, its plate, its columns and its
 * empty table — with nothing of its own but the plate's title, which says when it would have died
 * ("Dead on your turn 5", the plate's edge gold).
 *
 * **Three opponents share that half** at a four-player table (issue #994): it is cut into three
 * areas side by side over the reader's table, in turn order from the left, each a whole opponent
 * — plate, hand, zones and battlefield — at a third of the width (`OpponentArea`). A duel is
 * drawn exactly as it always was; nothing of the four-player layout reaches it.
 *
 * **The frame, measured from this element's box** so it fits a 1280 × 800 window with no scroll:
 * see {@link OPPONENT_TABLE} below. The zone columns' cards are {@link zoneSize} — the size of
 * an unshrunk card on the tables beside them — rather than the artboard's 180 × 252: two of them
 * stand beside each table's height.
 *
 * **The rules' handling is always there**: a double-click or a drag onto the table plays a card
 * from the hand or the command zone, a permanent's menu activates its abilities, and a click is a
 * pick when the rules are asking for one (`combat.ts`): in the declare-attackers step a creature
 * that may attack is toggled as an attacker, in declare-blockers a blocker is picked and then the
 * attacker it blocks, and while the engine asks a question each answer that names one card on the
 * table makes that card clickable. Picks are kept here until the stage button declares them, and
 * dropped whenever a new view arrives.
 *
 * **Every one of those clicks has a drag beside it** (`aim.ts`, issue #1335): an attacker carried
 * onto an opponent's side or plate (or a planeswalker) attacks it, a blocker carried onto an
 * attacker blocks it, either carried back onto the reader's table is taken off, and with priority
 * a card from the hand or a permanent carried onto a card or a plate is played or activated with
 * that card or player as its target — an Aura, a removal spell, an equip. The drag makes the same
 * picks and sends the same actions as the clicks; nothing new reaches the engine.
 *
 * **The sandbox is the rest** (`view.sandbox`, toggled by the chip in the top band and the game
 * menu's row — off against the AI, on against the goldfish, at the start). Its moves change the
 * game by hand, outside the rules: a click taps, a drag puts a card in any zone, the T / G / E / H
 * keys, the card menus' moves and counters and token copies, the library's draws and looks, a
 * token from the game menu, the life steppers on every plate. The engine takes them only in the
 * reader's main phase, so the board offers them only then and only while nothing is with the
 * engine (`edits`); off, none of them is drawn, and what is left is the rules'. With it on they
 * reach **every card the table shows**: an opponent's permanents get the sandbox's card menu and
 * their plates a stepper — but an opponent's cards are never dragged, and their hand and library
 * are counts the reader never touches.
 *
 * **Every action can take seconds** — the AI plays its whole turn before the engine answers — so
 * while one is with the engine (`busy`) the stage button says so and nothing new is offered;
 * `PlaytestPage`'s hook queues anything sent anyway, in order.
 */
export interface PlaytestBoardProps {
  /** The reader's deck. */
  deckName: string;
  /** Each opponent's deck, for their plates, in turn order: one in a duel, three at a
   *  four-player table — which is also how the board knows which to draw while it deals. */
  opponentNames: readonly string[];
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
  /**
   * Where the board was opened from, which its way back returns to: the Playtesting page's setup
   * ("setup", the default) or the deck editor ("deck", the goldfish button). It names the back
   * button ("‹ Setup" / "‹ <deckName>"), the game menu's and the result banner's way back ("Back
   * to setup" / "Back to the deck"), and the shortcut catalogue's scope for undo ("playtesting" /
   * "goldfish").
   */
  returnTo?: "setup" | "deck";
}

/** The narrowest the zone columns' cards are drawn: 72 × 101, two fifths of the artboard's
 *  180 × 252 (issue #992 grew them a fifth from 60 × 84). */
const ZONE_MIN = 72;

/**
 * The zone columns' cards at a board `boardHeight` px tall, their counts drawn on them: as big as
 * a card on the tables beside them is drawn before a full row shrinks it (`tableCardWidth`, of
 * the {@link FRAME_Y} frame's table height), and never under {@link ZONE_MIN} — so a commander or
 * a graveyard reads at the size of the permanents next to it, not as a thumbnail at the edge of a
 * tall window. Two of them and their gap still stand inside the table's height: a card that fits
 * a lane is under half the table.
 */
export function zoneSize(boardHeight: number): ZoneSize {
  const width = Math.max(ZONE_MIN, tableCardWidth(boardHeight / 2 - FRAME_Y, true));
  return { width, height: Math.round(width * ASPECT), compact: true };
}

const NONE: readonly PlaytestHappened[] = [];

const CHROME_BUTTON = cn(
  "inline-flex items-center justify-center border border-border bg-surface text-text",
  "transition-colors motion-reduce:transition-none hover:border-accent",
  PRESS,
  FOCUS,
);

/**
 * Which side of the board a pointed card is on — a zone of that player — or `loose`: a spell on
 * the stack, or a card an answer names that is on no table (a library being searched). A loose
 * card is let go of only when the pointer leaves it.
 */
type Side = PlaytestPlayer | "loose";

export function PlaytestBoard({
  deckName,
  opponentNames,
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
  returnTo = "setup",
}: PlaytestBoardProps): JSX.Element {
  const [pointed, setPointed] = useState<{ pointed: Pointed; side: Side } | null>(null);
  const [panel, setPanel] = useState<"help" | "log" | null>(null);
  const [look, setLook] = useState<{ look: ZoneLook; side: PlaytestPlayer } | null>(null);
  const [playmat, setPlaymat] = useState<Playmat>(initialPlaymat);
  const [previewWidth, setPreviewWidth] = useState(INSPECT_WIDTH);
  const { menuClick } = useContextMenu();
  const root = useRef<HTMLDivElement>(null);
  const [boardHeight, setBoardHeight] = useState(0);
  // A callback ref, so the first measurement lands in the commit rather than one paint later
  // (`Battlefield`'s, for its reasons). React 19 runs the returned cleanup.
  const measure = useCallback((el: HTMLDivElement | null) => {
    root.current = el;
    if (el === null) return undefined;
    const read = () => setBoardHeight(el.clientHeight);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.current = null;
    };
  }, []);
  const zone = zoneSize(boardHeight);

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

  /** Nothing new is offered while the engine is busy or the opponent's turn is played back. */
  const locked = busy || replaying;
  /** The sandbox is on — the setting, whatever the stage: the plates have steppers. */
  const sandboxOn = view?.sandbox ?? false;
  /**
   * **The sandbox's moves work now**: it is on, it is the reader's main phase (the engine refuses
   * them anywhere else), and nothing is with the engine. What every table piece is handed as its
   * `sandbox`, so each offers the hand moves only when they would be taken.
   */
  const edits = view !== null && view.sandbox && view.stage === "main" && !locked;

  const ids = useMemo(
    () => (view === null || view.stage === "mulligan" ? null : seen(view)),
    [view],
  );
  useLandingOf(root, ids);

  const current = useMemo(() => fresh(pointed, view), [pointed, view]);

  const drop = useCallback(
    (drag: TableDrag, to: GamePlace) => {
      // An attacker or a blocker carried back onto the reader's own table is taken off.
      const back =
        to === "battlefield" && view !== null && !locked ? retractDrop(view, picks, drag) : null;
      if (back !== null) setPicks(() => back);
      const action = dropAction(drag, to, edits);
      if (action !== null) onAct(action);
      setPointed(null);
    },
    [onAct, edits, view, locked, picks, setPicks],
  );

  // **A card carried onto a card or a player** (`aim.ts`): the declare steps' picks, or a play or
  // an activation whose target question is answered with the card or player it was let go on.
  const follow = useAimFollowThrough(view, busy, replaying, act);
  const aimOf = useCallback(
    (drag: TableDrag, at: AimAt, felt = false) =>
      view === null || locked ? null : aimDrop(view, picks, drag, at, felt),
    [view, locked, picks],
  );
  const aimAt = useCallback(
    (drag: TableDrag, at: AimAt, felt = false) => {
      const out = aimOf(drag, at, felt);
      if (out === null || view === null) return;
      if (out.kind === "picks") {
        setPicks(() => out.picks);
        return;
      }
      follow(out.target, view);
      act(out.action);
    },
    [aimOf, view, follow, act, setPicks],
  );
  /** Each player's table's aims — its cards, and an opponent's felt — and their plate's. */
  const aims = useMemo(() => {
    const target = (at: AimAt, felt = false): DropAim => ({
      accepts: (drag) => aimOf(drag, at, felt) !== null,
      onAim: (drag) => aimAt(drag, at, felt),
    });
    const tables = {} as Record<PlaytestPlayer, TableAim>;
    const plates = {} as Record<PlaytestPlayer, DropAim>;
    for (const player of ["you", ...OPPONENTS] as const) {
      tables[player] = {
        card: (id) => target(id),
        table: player === "you" ? undefined : target(player, true),
      };
      plates[player] = target(player);
    }
    return { tables, plates };
  }, [aimOf, aimAt]);
  /** The reader's cards the rules let them pick up now: an attacker, a blocker, a permanent. */
  const carry = useCallback(
    (card: GameCard) => view !== null && !locked && canCarry(view, card),
    [view, locked],
  );

  const pointYou = useCallback((p: Pointed) => setPointed({ pointed: p, side: "you" }), []);
  /** Each opponent's pointer, made once, so their tables' cards are not redrawn for a new one. */
  const pointThem = useMemo(
    () =>
      Object.fromEntries(
        OPPONENTS.map((player) => [
          player,
          (p: Pointed) => setPointed({ pointed: p, side: player }),
        ]),
      ) as Record<PlaytestPlayer, (p: Pointed) => void>,
    [],
  );
  const pointOpponent = pointThem.opponent;
  // **It takes no argument, and must not grow one**: every card hands it to `onMouseLeave` as it
  // is, so a parameter here is filled with the mouse event.
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
  const opponentCount = view?.opponents.length ?? opponentNames.length;
  const pointStack = useCallback(
    (card: GameCard, item: PlaytestStackItem, e: MouseEvent) =>
      setPointed({
        pointed: {
          card,
          ids: [card.id],
          place: "battlefield",
          line: `${item.name} · on the stack, ${item.seat === "you" ? "yours" : playerPossessive(item.seat, opponentCount, "mid")}`,
          at: pointerAt(e),
        },
        side: "loose",
      }),
    [opponentCount],
  );

  // **A card's `mouseleave` is not the only way the pointer stops being on it.** A card redrawn
  // by another element — an untapped land joining a pile, a graveyard's new top card — is gone
  // from under the pointer without one, and is still in its zone, so `fresh` does not let go of
  // it. So while a card is pointed at, each move of the pointer is asked what it is over
  // (`data-point`), and anything but that card lets go.
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

  const buttons = view === null ? null : stageButtons(view, picks);
  const primary = locked ? null : (buttons?.primary ?? null);

  // Undo and redo (issue #1022): not while the engine is busy; during a replay, `act` shows its
  // end first, as it does for any action. The catalogue's scope is where the board was opened
  // from: the deck editor's goldfish, or the Playtesting page.
  useUndoKeys(returnTo === "deck" ? "goldfish" : "playtesting", view, act, !busy);

  // **The board's keys**: Space presses the stage button (to combat, end the turn, declare), and
  // T, G, E, H tap, bury, exile or return to hand the reader's own card under the pointer — the
  // sandbox's, so only while its moves work (`edits`). Not while a field has the caret (the life
  // steppers) or a menu or dialog is open over the board.
  //
  // **Space is the board's even on a focused button**, and the `preventDefault` is what makes it
  // so: a card clicked keeps the focus, and Space would otherwise press it — playing the card in
  // hand the reader only meant to pass after. Enter still presses a focused control.
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
      if (current === null || current.side !== "you" || !edits) return;
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
  }, [act, current, view, primary, replaying, onSkip, edits]);

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
  /** Each opponent's table's picks: the same three clicks on whichever table the card is on. */
  const theirPicks = useMemo(() => {
    const out: Partial<Record<PlaytestPlayer, TablePick>> = {};
    if (view === null || pickable === null || locked) return out;
    const onPick = (id: number) => {
      if (stage === "attack") setPicks((p) => aimAttacker(p, view, id));
      else if (stage === "block") setPicks((p) => pickAttacker(p, view, id));
      else if (stage === "prompt") {
        const index = answers.get(id);
        if (index !== undefined) act({ type: "choose", index });
      }
    };
    for (const player of OPPONENTS) {
      if (pickable[player].size > 0) out[player] = { ids: pickable[player], onPick };
    }
    return out;
  }, [view, pickable, locked, stage, answers, act, setPicks]);
  const theirPick = theirPicks.opponent;
  /** Each table's attachments that cross to another's — yours first, then each opponent's. */
  const across = useMemo(
    () =>
      view === null
        ? []
        : acrossTables([view.you.battlefield, ...view.opponents.map((o) => o.battlefield)]),
    [view],
  );
  const onActivate = useCallback((id: number) => act({ type: "activate", id }), [act]);
  const arrows = useMemo(
    () => (view === null ? [] : [...combatArrows(view, picks), ...targetArrows(view)]),
    [view, picks],
  );

  const you = view?.you ?? null;
  const opponent = view?.opponents[0] ?? null;
  /** A four-player table: the opponents' half is three areas, not one turned-round table. */
  const four = opponentCount > 1;
  /** The players the attacker waiting to be aimed could attack, while the reader may aim it. */
  const aimable =
    view !== null && view.stage === "attack" && !locked ? aimablePlayers(picks, view) : [];
  const commander = you?.command[0] ?? you?.battlefield.find((c) => c.isCommander) ?? null;
  const felt = feltBackground(playmat);
  const status = error ?? log[0]?.text ?? "";
  const playing = view !== null && view.stage !== "mulligan" && view.stage !== "over";
  const handCount = opponent?.handCount ?? 0;
  const prompting = view !== null && view.stage === "prompt" && view.prompt !== null;
  /** The opponent's spell or ability the reader may respond to, asked about over their table. */
  const responding = replaying ? null : respondingTo(view);
  const tabled = view !== null && view.stage !== "mulligan";
  /** Whose turn it is, lit on their plate — not before the first turn or after the last. */
  const active = playing && view.turn > 0 ? view.active : null;
  const lookYou = (l: ZoneLook) => setLook({ look: l, side: "you" });
  const lookOpponent = (l: ZoneLook) => setLook({ look: l, side: "opponent" });
  const lookedAt = look === null || view === null ? undefined : seatOfPlayer(view, look.side);
  const goldfish = view?.goldfish ?? false;
  /** The goldfish's life has reached 0 on this turn of the reader's; `null` while it is above. */
  const deadOn = goldfish ? (opponent?.deadOn ?? null) : null;
  const backLabel = returnTo === "deck" ? "Back to the deck" : "Back to setup";

  return (
    <div
      ref={measure}
      aria-busy={busy}
      className="relative h-full w-full overflow-hidden bg-bg text-sm text-text"
      style={{ "--table-x": `${zone.width + 2 * COLUMN_GAP}px` } as CSSProperties}
      data-testid="playtest-board"
    >
      {felt !== null && (
        <div
          aria-hidden="true"
          data-testid="board-felt"
          className="pointer-events-none absolute inset-0"
          style={{ background: felt }}
        />
      )}
      {playmat === "commander" && commander?.cardId != null && (
        <CommanderMat cardId={commander.cardId} name={commander.name} />
      )}

      {/* The two tables' dashed edges, drawn under everything on them (each opponent area draws
          its own). */}
      {!four && (
        <div
          aria-hidden="true"
          className={cn(
            OPPONENT_TABLE,
            "pointer-events-none rounded-[22px] border border-dashed border-border opacity-50",
          )}
        />
      )}
      <div
        aria-hidden="true"
        className={cn(
          YOUR_TABLE,
          "pointer-events-none rounded-[22px] border border-dashed border-border opacity-70",
        )}
      />

      {view === null ? (
        <div className="absolute inset-x-[var(--table-x)] top-[48px] bottom-[112px] flex items-center justify-center text-dim">
          {error ?? (four ? "Shuffling every deck…" : "Shuffling both decks…")}
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
            onAct={onAct}
            onPoint={pointYou}
            onUnpoint={unpoint}
          />
        </div>
      ) : (
        <>
          {four ? (
            <div className={cn(OPPONENT_AREAS, "grid grid-cols-3 gap-2")}>
              {view.opponents.map((seat, i) => (
                <OpponentArea
                  key={seat.player}
                  seat={seat}
                  deckName={opponentNames[i] ?? "Deck"}
                  opponents={view.opponents.length}
                  active={active === seat.player}
                  won={view.winner === seat.player}
                  sandbox={edits}
                  steppers={sandboxOn}
                  marks={marks?.[seat.player]}
                  pick={theirPicks[seat.player]}
                  across={across[i + 1]}
                  aim={aims.tables[seat.player]}
                  plateAim={aims.plates[seat.player]}
                  aimable={aimable.includes(seat.player)}
                  onAim={() => setPicks((p) => aimAttacker(p, view, seat.player))}
                  onLife={(life) => act({ type: "setLife", seat: seat.player, life })}
                  onAct={onAct}
                  onDrop={drop}
                  onPoint={pointThem[seat.player]}
                  onUnpoint={unpoint}
                  onLook={(l) => setLook({ look: l, side: seat.player })}
                />
              ))}
            </div>
          ) : (
            <div data-table="opponent" className={OPPONENT_TABLE}>
              <Battlefield
                label="The opponent's battlefield"
                cards={view.opponents[0].battlefield}
                sandbox={edits}
                onAct={onAct}
                onDrop={drop}
                onPoint={pointOpponent}
                onUnpoint={unpoint}
                flipped
                readOnly
                dense
                marks={marks?.opponent}
                pick={theirPick}
                across={across[1]}
                aim={aims.tables.opponent}
                className="h-full w-full"
              />
            </div>
          )}
          <MiddleLine
            view={view}
            picks={picks}
            status={status}
            failed={error !== null}
            onStops={locked ? undefined : (stops) => act({ type: "setStops", stops })}
            onSandbox={(on) => act({ type: "setSandbox", on })}
            className="absolute inset-x-[var(--table-x)] top-[calc(50%-46px)] h-7"
          />
          <div data-table="you" className={YOUR_TABLE}>
            <Battlefield
              label="Your battlefield"
              cards={view.you.battlefield}
              sandbox={edits}
              onAct={onAct}
              onDrop={drop}
              onPoint={pointYou}
              onUnpoint={unpoint}
              dense
              readOnly={replaying}
              marks={marks?.you}
              pick={yourPick}
              onActivate={onActivate}
              across={across[0]}
              carry={carry}
              aim={aims.tables.you}
              className="h-full w-full"
            />
          </div>
          {/* The stack, in the right gutter between the two tables' zone columns. */}
          <StackColumn
            view={view}
            prominent={view.stage === "respond" && responding === null}
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
          hanging from the edge with their plate beside it, and help and the log. A four-player
          table's opponents keep their hands and plates in their own areas below it. */}
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
                  : {
                      tokens: view.tokens,
                      graveyard: view.you.graveyard,
                      exile: view.you.exile,
                      // Not while the engine is busy, as the keys; during a replay `act` shows
                      // its end first.
                      canUndo: view.canUndo && !busy,
                      canRedo: view.canRedo && !busy,
                      sandbox: view.sandbox,
                    },
              playing: playing && !locked,
              sandbox: edits,
              backLabel,
              playmat,
              commanderName: commander?.name ?? null,
              onAct: act,
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
          aria-label={
            returnTo === "deck" ? `Back to the ${deckName} deck` : "Back to the playtest setup"
          }
          onClick={onBack}
          className={cn(CHROME_BUTTON, "h-9 gap-1 rounded-full pr-3 pl-2 text-[13px]")}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {returnTo === "deck" ? deckName : "Setup"}
          <kbd className="ml-1 rounded border border-border px-1 font-mono text-[11px] text-dim">
            Esc
          </kbd>
        </button>
      </div>

      {!four && (
        <>
          <div className="absolute top-0 left-1/2 -translate-x-1/2">
            <OpponentHand count={handCount} />
          </div>
          {/* Right of their hand, and never under the help and log buttons: the box ends 116 px
              from the edge, and a plate wider than it (a long deck name, the sandbox's stepper)
              shortens its title rather than running under them. */}
          <div
            className="absolute top-[5px] right-[116px] flex min-w-0"
            style={{ left: `calc(50% + ${opponentHandWidth(handCount) / 2 + 64}px)` }}
          >
            <PlateFrame
              seat="opponent"
              active={active === "opponent"}
              poison={opponent?.poison ?? 0}
              compact
              aim={aims.plates.opponent}
              className="min-w-0"
            >
              <LifePlate
                seat="opponent"
                title={
                  deadOn !== null
                    ? `Dead on your turn ${deadOn}`
                    : `Opponent · ${opponentNames[0] ?? "Deck"}`
                }
                life={opponent?.life ?? 0}
                highlight={view?.winner === "opponent" || deadOn !== null}
                readOnly={!sandboxOn}
                disabled={!edits}
                onChange={(life) => act({ type: "setLife", seat: "opponent", life })}
                compact
              />
              {/* An attacker waiting to be aimed, that may attack the opponent: their plate is
                  the target to click. */}
              {view !== null && aimable.includes("opponent") && (
                <button
                  type="button"
                  onClick={() => setPicks((p) => aimAttacker(p, view, "opponent"))}
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
        </>
      )}

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
      {!four && (
        <>
          <div className={cn(OPPONENT_COLUMN, "left-3")}>
            <OpponentLibrary seat={opponent} size={zone} />
            <OpponentPile
              seat={opponent}
              zone="graveyard"
              size={zone}
              onPoint={pointOpponent}
              onUnpoint={unpoint}
              onLook={lookOpponent}
            />
          </div>
          <div className={cn(OPPONENT_COLUMN, "right-3 items-end")}>
            <OpponentPile
              seat={opponent}
              zone="exile"
              size={zone}
              onPoint={pointOpponent}
              onUnpoint={unpoint}
              onLook={lookOpponent}
              className="items-end"
            />
            <OpponentCommand
              seat={opponent}
              size={zone}
              onPoint={pointOpponent}
              onUnpoint={unpoint}
              className="items-end"
            />
          </div>
        </>
      )}

      {/* The reader's columns, the artboard's: command and exile left, graveyard and library
          right. */}
      <div className={cn(YOUR_COLUMN, "left-3")}>
        <CommandZone
          view={you}
          sandbox={edits}
          onAct={onAct}
          onDrop={drop}
          onPoint={pointYou}
          onUnpoint={unpoint}
          size={zone}
        />
        <ExileZone
          view={you}
          sandbox={edits}
          onDrop={drop}
          onPoint={pointYou}
          onUnpoint={unpoint}
          onLook={lookYou}
          size={zone}
        />
      </div>
      <div className={cn(YOUR_COLUMN, "right-3 items-end")}>
        <GraveyardZone
          view={you}
          sandbox={edits}
          onDrop={drop}
          onPoint={pointYou}
          onUnpoint={unpoint}
          onLook={lookYou}
          size={zone}
        />
        <LibraryZone
          view={you}
          sandbox={edits}
          onAct={onAct}
          onDrop={drop}
          onLook={lookYou}
          size={zone}
        />
      </div>

      {/* The foot: the reader's hand, their plate beside it, and the stage button. */}
      {tabled && (
        <HandFan
          cards={view.you.hand}
          sandbox={edits}
          onAct={onAct}
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
      {/* Beside the hand — and at the very edge while a prompt is docked over the hand, so the
          two never meet. */}
      <div
        className="absolute bottom-3"
        style={{
          left:
            tabled && !prompting
              ? `max(12px, calc(50% - ${handRow(view.you.hand.length).width / 2 + 20 + 236}px))`
              : "12px",
        }}
      >
        <PlateFrame
          seat="you"
          active={active === "you"}
          poison={you?.poison ?? 0}
          aim={aims.plates.you}
        >
          <LifePlate
            seat="you"
            title={`You · ${deckName}`}
            life={you?.life ?? 0}
            cardId={commander?.cardId ?? null}
            highlight={view?.winner === "you"}
            readOnly={!sandboxOn}
            disabled={!edits}
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
              {/* The goldfish thinks about nothing: the engine is only playing the game on. */}
              {passing
                ? "Passing turn…"
                : goldfish
                  ? "Playing on…"
                  : four
                    ? "Opponents are thinking…"
                    : "Opponent is thinking…"}
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

      {responding !== null && (
        <RespondPrompt
          item={responding}
          view={view!}
          disabled={locked}
          onAct={act}
          onPoint={pointStack}
          onUnpoint={unpoint}
          className="absolute top-[52px] left-1/2 w-[min(600px,calc(100%-2*var(--table-x)))] -translate-x-1/2"
        />
      )}
      {prompting && view.prompt!.pick !== null && (
        <PickPanel
          key={view.prompt!.pick.cards.map((c) => c.id).join(",")}
          prompt={{ ...view.prompt!, pick: view.prompt!.pick }}
          table={[...tableCards(view), ...view.you.hand]}
          disabled={locked}
          onAct={act}
          onPoint={pointCard}
          onUnpoint={unpoint}
          opponents={view.opponents.length}
          className="absolute top-[calc(50%-32px)] left-1/2 max-h-[calc(100%-200px)] w-[min(820px,calc(100%-200px))] -translate-x-1/2 -translate-y-1/2"
        />
      )}
      {prompting && view.prompt!.pick === null && (
        <PromptPanel
          prompt={view.prompt!}
          table={[...tableCards(view), ...view.you.hand]}
          disabled={locked}
          onAct={act}
          onPoint={pointCard}
          onUnpoint={unpoint}
          opponents={view.opponents.length}
          className="absolute bottom-2 left-1/2 max-h-[104px] w-[min(640px,calc(100%-560px))] -translate-x-1/2"
        />
      )}

      {view !== null && view.stage === "over" && !replaying && (
        <GameOver
          winner={view.winner}
          out={view.you.out}
          turn={view.turn}
          backLabel={backLabel}
          onNewGame={onNewGame}
          onBack={onBack}
        />
      )}

      <BoardArrows root={root} arrows={arrows} />
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
            <span className="text-dim">
              {goldfish ? "Playing on" : four ? "Opponents’ turns" : "Opponent’s turn"}
            </span>
            <span className="font-semibold">Skip</span>
            <SkipForward className="size-4" aria-hidden="true" />
          </button>
        </>
      )}

      <Inspect pointed={current?.pointed ?? null} width={previewWidth} onResize={setPreviewWidth} />

      {panel === "help" && (
        <HelpPanel heading="Playing a game" onClose={() => setPanel(null)}>
          <PlaytestHelp sandbox={sandboxOn} goldfish={goldfish} />
        </HelpPanel>
      )}
      {panel === "log" && <LogPanel log={log} onClose={() => setPanel(null)} />}

      {/* A library is looked through only with the sandbox's moves working; a graveyard or exile
          is public, and opens read-only without them. */}
      {look !== null && lookedAt !== undefined && (look.look.zone !== "library" || edits) && (
        <LibraryDialog
          look={look.look}
          view={lookedAt}
          readOnly={!edits}
          opponent={look.side !== "you"}
          owner={playerPossessive(look.side, opponentCount)}
          onAct={onAct}
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
 * caption), 339 in an 866 px one. The tables are `--table-x` in from either side: a zone column
 * ({@link zoneSize}, 72 px in a short window) {@link COLUMN_GAP} from the edge, and as much again
 * between it and the table — 96 px at the narrowest.
 */
const FRAME_Y = 94;
const COLUMN_GAP = 12;
const OPPONENT_TABLE = "absolute inset-x-[var(--table-x)] top-[48px] bottom-[calc(50%+46px)]";
const YOUR_TABLE = "absolute inset-x-[var(--table-x)] top-[calc(50%-18px)] bottom-[112px]";
/**
 * A four-player table's three opponent areas: the duel's opponent table, top to bottom and side
 * to side — over the reader's table, the gutters left to the chrome and the stack — cut into
 * thirds 8 px apart. 357 px each in a 1280 px board, 289 px tall in a 766 px one: a 38 px plate
 * row, and below it the zones' 2 × 3 grid of 40 × 56 tiles (84 × 176) beside the battlefield
 * (about 265 × 245).
 */
const OPPONENT_AREAS = "absolute inset-x-[var(--table-x)] top-[48px] bottom-[calc(50%+46px)]";
/** A zone column, centred on its table's height. */
const OPPONENT_COLUMN =
  "absolute top-[48px] bottom-[calc(50%+46px)] flex flex-col justify-center gap-2";
const YOUR_COLUMN =
  "absolute top-[calc(50%-18px)] bottom-[112px] flex flex-col justify-center gap-2";

/** The foot's primary button, saying what it does: to combat, end the turn, attack, block. */
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

/**
 * The result, over the middle of the board — the tables stay drawn around it to be looked at.
 * **A reader who is out has lost**, though `winner` is `null` then (the others play on, unseen):
 * only a game that ended with no winner and the reader still in is a draw.
 */
function GameOver({
  winner,
  out,
  turn,
  backLabel,
  onNewGame,
  onBack,
}: {
  winner: PlaytestView["winner"];
  /** The reader is out (`you.out`). */
  out: boolean;
  turn: number;
  /** "Back to setup", "Back to the deck". */
  backLabel: string;
  onNewGame: () => void;
  onBack: () => void;
}): JSX.Element {
  const title = winner === "you" ? "You won" : out || winner !== null ? "You lost" : "Draw";
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
          {backLabel}
        </button>
      </div>
    </section>
  );
}

/**
 * The help panel's lines: the rules' clicks, always, and the sandbox's handling said as it stands
 * — what it offers while on, how to turn it on while off.
 */
function PlaytestHelp({ sandbox, goldfish }: { sandbox: boolean; goldfish: boolean }): JSX.Element {
  return (
    <>
      <span>
        Double-click a card in hand, or drag it onto your battlefield, to play it by the rules.
      </span>
      <span>
        Right-click a permanent to activate an ability. Or drag the card onto a card or a player to
        play or activate it with that target: an Aura, a removal spell, an equip.
      </span>
      <span>
        To attack, click each creature that should (it moves forward, ringed red), or drag it onto
        the opponent or a planeswalker, then press Attack.
      </span>
      {!goldfish && (
        <span>
          To block, click one of your creatures, then the attacker it blocks, or drag it onto the
          attacker; both get a number. Click a blocker again, or drag it back, to take it off.
        </span>
      )}
      <span>When the engine asks, click a highlighted card or pick an answer in the panel.</span>
      {sandbox ? (
        <>
          <span className="text-dim">
            The sandbox is on: in your main phase, drag any of your cards anywhere, click a
            permanent to tap it (Shift-click taps the pile), right-click any card on the table for
            counters, copies and moves, and set any life total. A card the rules cannot play is put
            down unpaid.
          </span>
          <span className="text-dim">
            Point at one of your cards and press T, G, E or H to tap it, bury it, exile it or return
            it to hand.
          </span>
        </>
      ) : (
        <span className="text-dim">
          The sandbox is off: only the rules’ plays. Turn it on (the Sandbox button, or the game
          menu) to move, tap and change cards by hand.
        </span>
      )}
      <span className="text-dim">
        Press Space for the button at the bottom right: to combat, end the turn, attack or block.
      </span>
      <span className="text-dim">
        Press Ctrl+Z to undo back to your last decision and Ctrl+Y to redo, or use the game menu.
      </span>
    </>
  );
}

/** Every id a card can land as on this board: the reader's every zone, each opponent's open ones. */
function seen(view: PlaytestView): Set<number> {
  const out = new Set<number>();
  const { you } = view;
  for (const zone of [
    you.hand,
    you.battlefield,
    you.graveyard,
    you.exile,
    you.command,
    you.libraryCards,
    ...view.opponents.flatMap((o) => [o.battlefield, o.graveyard, o.exile, o.command]),
  ]) {
    for (const c of zone) out.add(c.id);
  }
  return out;
}

/** Which player's battlefield or hand holds `id`, for a card pointed at from the prompt panel. */
function seatHolding(view: PlaytestView | null, id: number): PlaytestPlayer | null {
  if (view === null) return null;
  if (view.you.battlefield.some((c) => c.id === id) || view.you.hand.some((c) => c.id === id))
    return "you";
  return view.opponents.find((o) => o.battlefield.some((c) => c.id === id))?.player ?? null;
}

/** One seat's cards in `place`. */
function zoneOf(seat: PlaytestSeat, place: GamePlace): readonly GameCard[] {
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
 * **The card pointed at, as `view` has it now**, or `null` once it has left that zone. A tap keeps
 * a card's id (only a zone change mints a new one, CR 400.7) but not its state, and no new
 * `mouseenter` fires on a card that was clicked where it lies — so the card held in state is
 * re-read here, by id, on whichever seat it is on, every view. A loose card is kept as it is.
 */
function fresh(
  held: { pointed: Pointed; side: Side } | null,
  view: PlaytestView | null,
): { pointed: Pointed; side: Side } | null {
  if (held === null || view === null) return null;
  const { pointed } = held;
  if (held.side === "loose") return held;
  // **An attachment can be drawn on a table that is not its controller's** (`acrossTables`): the
  // reader's Pacifism on an opponent's creature is pointed at from that opponent's table, and an
  // opponent's Aura on the reader's creature from the reader's. So a permanent is looked for at
  // the seat that holds it, and that seat is the side T / G / E / H act for (issue #1331).
  const side =
    pointed.place === "battlefield" ? (seatHolding(view, pointed.card.id) ?? held.side) : held.side;
  const seat = seatOfPlayer(view, side);
  if (seat === undefined) return null;
  const zone = zoneOf(seat, pointed.place);
  const card = zone.find((c) => c.id === pointed.card.id);
  if (card === undefined) return null;
  const ids = pointed.ids.filter((id) => zone.some((c) => c.id === id));
  return { side, pointed: { ...pointed, card, ids: ids.length > 0 ? ids : [card.id] } };
}
