/**
 * The board's three right-click menus — a card (or a pile), the library, and the game — as the
 * artboard `Goldfish · the table, turn 9` draws them (2026-10-12).
 *
 * **Pure builders over the view**, the `features/decks/*Menu.tsx` arrangement: each returns
 * `MenuItem[]` and asks for everything through the callbacks, so the menus are tested as data and
 * the board decides when to build one (`menuClick`, `menu`). Built at the press rather than held,
 * because a {@link GameCard.id} is good only for the view it came from (CR 400.7).
 *
 * **The sandbox decides most of what is in them** (`PlaytestView.sandbox`, the owner's decision
 * of 2026-10-17). Its moves — a card put anywhere by hand, a tap, counters, a token, a draw, a
 * mill, a shuffle — are the reader's hand changing the game outside the rules, and the engine
 * takes them only while the sandbox is on and only in the reader's main phase. So each builder
 * takes `sandbox` as the board works it out (on, the main phase, nothing with the engine) and,
 * off, offers only what the rules do: a hand card's Play, a commander's Cast, a permanent's
 * Activate ability. A row the engine would only refuse is not offered.
 */
import type { MenuAction, MenuItem } from "@/components/menu/types";
import type { GameCard, GamePlace, PlaytestAction, PlaytestSeat, PlaytestView } from "@/lib/ipc";
import { FELTS } from "./playmats";
import type { Playmat, ZoneLook } from "./types";

type Act = (a: PlaytestAction) => void;

function action(id: string, label: string, onSelect: () => void, disabled = false): MenuAction {
  return disabled
    ? { kind: "action", id, label, disabled, onSelect }
    : { kind: "action", id, label, onSelect };
}

/**
 * A submenu, or — when nothing in it can be done — one greyed row of its name. A submenu row has
 * no `disabled` of its own, and a reader should not have to open one to find every row in it
 * grey.
 */
function submenu(id: string, label: string, items: MenuItem[], disabled = false): MenuItem {
  return disabled ? action(id, label, () => {}, true) : { kind: "submenu", id, label, items };
}

/** How many counters of `kind` the card carries. */
function counted(card: GameCard, kind: string): number {
  return card.counters.find((c) => c.kind === kind)?.count ?? 0;
}

/**
 * The menu for a card, or for a pile of identical cards on the battlefield (`ids`, the pile's
 * engine ids, `ids[0]` its top). Everything but "Tap all" acts on the top card alone: moving a
 * pile of seven Forests to the graveyard by one row would be a misclick nobody could take back.
 *
 * `onActivate` heads a permanent's menu with "Activate ability" — the rules engine's, for the
 * reader's own permanents. An opponent's card is handed no `onActivate`: only its controller
 * activates it.
 *
 * **`sandbox` off leaves only the rules' rows**: Play on a hand card, Cast on a commander, and
 * Activate ability on a permanent — and on a graveyard or exile card, or an opponent's permanent,
 * nothing at all (an empty menu, which the caller does not open). On, every hand move follows,
 * on whichever seat's card it is: the engine puts an opponent's card in its owner's zones.
 */
export function cardMenu({
  card,
  ids,
  place,
  sandbox,
  onAct,
  onActivate,
}: {
  card: GameCard;
  ids: number[];
  place: GamePlace;
  /** The sandbox's moves work now: it is on, it is the reader's main phase, nothing is out. */
  sandbox: boolean;
  onAct: Act;
  onActivate?: (id: number) => void;
}): MenuItem[] {
  const id = ids[0] ?? card.id;
  const move = (to: GamePlace) => () => onAct({ type: "move", id, to });
  const commandRow = card.isCommander ? [action("command", "Command zone", move("command"))] : [];

  switch (place) {
    case "battlefield": {
      const pile = ids.length > 1;
      const tapWord = card.tapped ? "Untap" : "Tap";
      const counter = (kind: string, delta: number) => () =>
        onAct({ type: "counters", id, kind, delta });
      const items: MenuItem[] = [];
      if (onActivate !== undefined) {
        items.push(action("activate", "Activate ability", () => onActivate(id)));
        if (sandbox) items.push({ kind: "separator", id: "sepActivate" });
      }
      if (!sandbox) return items;
      items.push(
        action("tap", `${tapWord}${pile ? " one" : ""}`, () =>
          onAct({ type: "tap", ids: [id], tapped: !card.tapped }),
        ),
      );
      if (pile) {
        items.push(
          action("tapAll", `${tapWord} all ${ids.length}`, () =>
            onAct({ type: "tap", ids, tapped: !card.tapped }),
          ),
        );
      }
      items.push(
        submenu("counters", "Counters", [
          action("addPlus", "Add a +1/+1 counter", counter("+1/+1", 1)),
          action(
            "removePlus",
            "Remove a +1/+1 counter",
            counter("+1/+1", -1),
            counted(card, "+1/+1") === 0,
          ),
          action("addMinus", "Add a -1/-1 counter", counter("-1/-1", 1)),
          ...(counted(card, "-1/-1") > 0
            ? [action("removeMinus", "Remove a -1/-1 counter", counter("-1/-1", -1))]
            : []),
          { kind: "separator", id: "sep" },
          action("addLoyalty", "Add a loyalty counter", counter("loyalty", 1)),
          action(
            "removeLoyalty",
            "Remove a loyalty counter",
            counter("loyalty", -1),
            counted(card, "loyalty") === 0,
          ),
          action("addCharge", "Add a charge counter", counter("charge", 1)),
          ...(counted(card, "charge") > 0
            ? [action("removeCharge", "Remove a charge counter", counter("charge", -1))]
            : []),
        ]),
        action("copy", "Create a token copy", () => onAct({ type: "tokenCopy", id })),
        { kind: "separator", id: "sep" },
        submenu("move", pile ? "Move one to" : "Move to", [
          action("hand", "Hand", move("hand")),
          action("graveyard", "Graveyard", move("graveyard")),
          action("exile", "Exile", move("exile")),
          action("top", "Top of library", move("libraryTop")),
          action("bottom", "Bottom of library", move("libraryBottom")),
          ...commandRow,
        ]),
      );
      return items;
    }
    case "hand": {
      const play = action("play", "Play", () => onAct({ type: "play", id }));
      if (!sandbox) return [play];
      return [
        play,
        { kind: "separator", id: "sep" },
        submenu("move", "Move to", [
          // "Unpaid" because that is the difference from Play: no land drop spent, no mana paid,
          // nothing cast — a card put down by hand (`session.rs`' `Move`).
          action("battlefield", "Battlefield, unpaid", move("battlefield")),
          action("graveyard", "Discard", move("graveyard")),
          action("exile", "Exile", move("exile")),
          action("top", "Top of library", move("libraryTop")),
          action("bottom", "Bottom of library", move("libraryBottom")),
          ...commandRow,
        ]),
      ];
    }
    case "command": {
      const cast = action("cast", "Cast", () => onAct({ type: "play", id }));
      if (!sandbox) return [cast];
      return [
        cast,
        { kind: "separator", id: "sep" },
        submenu("move", "Move to", [
          action("hand", "Hand", move("hand")),
          action("battlefield", "Battlefield, unpaid", move("battlefield")),
          action("graveyard", "Graveyard", move("graveyard")),
          action("exile", "Exile", move("exile")),
        ]),
      ];
    }
    default: {
      if (!sandbox) return [];
      // The graveyard and exile (and a library card, should one ever be pointed at): every other
      // place, the one it is in left out.
      const rows: MenuItem[] = [
        action("hand", "Hand", move("hand")),
        action("battlefield", "Battlefield", move("battlefield")),
      ];
      if (place !== "graveyard") rows.push(action("graveyard", "Graveyard", move("graveyard")));
      if (place !== "exile") rows.push(action("exile", "Exile", move("exile")));
      rows.push(
        action("top", "Top of library", move("libraryTop")),
        action("bottom", "Bottom of library", move("libraryBottom")),
        ...commandRow,
      );
      return [submenu("move", "Move to", rows)];
    }
  }
}

/**
 * The library's menu, on a right-click of the pile (a left click draws). **Every row is a sandbox
 * move**, a draw or a look as much as a mill, so the pile offers it only while those work
 * (`LibraryZone`'s `sandbox`) and it has no rows of the rules' to keep when they do not.
 */
export function libraryMenu({
  view,
  onAct,
  onLook,
}: {
  view: Pick<PlaytestSeat, "library">;
  onAct: Act;
  onLook: (l: ZoneLook) => void;
}): MenuItem[] {
  const empty = view.library === 0;
  const look = (mode: ZoneLook["mode"], count: number) => () =>
    onLook({ zone: "library", mode, count });
  return [
    action("draw", "Draw a card", () => onAct({ type: "draw", count: 1 }), empty),
    submenu(
      "drawMany",
      "Draw",
      [2, 3, 7].map((n) =>
        action(`draw${n}`, `Draw ${n}`, () => onAct({ type: "draw", count: n })),
      ),
      empty,
    ),
    submenu(
      "scry",
      "Scry…",
      [1, 2, 3].map((n) => action(`scry${n}`, `Scry ${n}`, look("scry", n))),
      empty,
    ),
    submenu(
      "surveil",
      "Surveil…",
      [1, 2].map((n) => action(`surveil${n}`, `Surveil ${n}`, look("surveil", n))),
      empty,
    ),
    // No ellipsis: milling opens nothing, the cards go straight to the graveyard.
    submenu(
      "mill",
      "Mill",
      [1, 2, 3].map((n) =>
        action(`mill${n}`, `Mill ${n}`, () => onAct({ type: "mill", count: n })),
      ),
      empty,
    ),
    submenu(
      "look",
      "Look at the top cards…",
      [3, 5, 7].map((n) => action(`look${n}`, `The top ${n}`, look("look", n))),
      empty,
    ),
    { kind: "separator", id: "sep" },
    // Not greyed over an empty library: searching one and finding nothing is still a search a
    // card can ask for, and the dialog says the library is empty.
    action("search", "Search the library…", () =>
      onLook({ zone: "library", mode: "search", count: "all" }),
    ),
    action("shuffle", "Shuffle", () => onAct({ type: "shuffle" })),
  ];
}

/** What the game menu reads of a game: the reader's graveyard and exile, the deck's tokens,
 *  whether there is anything to undo or redo, and whether the sandbox is on. */
export type GameMenuView = Pick<PlaytestSeat, "graveyard" | "exile"> &
  Pick<PlaytestView, "tokens" | "canUndo" | "canRedo" | "sandbox">;

/**
 * The game menu, under the board's top-left button. `view` is `null` while a game is being
 * dealt; then only the rows that are not moves in the game work.
 *
 * **Two flags say what works now, and the board works both out**: `playing` — a game on the
 * table, not its opening hand and not over — opens the graveyard and exile to look through, which
 * is public and needs no sandbox; `sandbox` — the sandbox is on, it is the reader's main phase
 * and nothing is with the engine — is every row that changes the game by hand: untapping
 * everything, a token, and looking through the library, which the rules never let a reader do.
 *
 * **The sandbox's own row is a setting, not a move**: a check mark that turns it on or off
 * (`setSandbox`) at any stage, the opening hand included, whatever the two flags say. Only a game
 * still being dealt has no sandbox to set.
 *
 * **Undo and redo head it** (issue #1022), greyed when the view has nothing to go back or forward
 * to — the menu's way to the same two actions `Ctrl+Z` and `Ctrl+Y` send, for a reader who does
 * not know the chords. Not greyed by the opening hand: a mulligan is an action to take back.
 */
export function gameMenu({
  view,
  playing,
  sandbox,
  backLabel,
  playmat,
  commanderName,
  onAct,
  onPlaymat,
  onNewGame,
  onBack,
  onLook,
}: {
  view: GameMenuView | null;
  /** A game is on the table: not being dealt, not its opening hand, not over. */
  playing: boolean;
  /** The sandbox's moves work now: on, the reader's main phase, nothing with the engine. */
  sandbox: boolean;
  /** The way back's row: "Back to setup", "Back to the deck". */
  backLabel: string;
  playmat: Playmat;
  commanderName: string | null;
  onAct: Act;
  onPlaymat: (p: Playmat) => void;
  onNewGame: () => void;
  onBack: () => void;
  onLook: (l: ZoneLook) => void;
}): MenuItem[] {
  const tokens = view?.tokens ?? [];
  const edits = playing && sandbox;

  const mats: MenuItem[] = FELTS.map((felt): MenuItem => ({
    kind: "radio",
    id: felt.id,
    label: felt.label,
    checked: playmat === felt.id,
    onSelect: () => onPlaymat(felt.id),
  }));
  if (commanderName !== null) {
    mats.push({
      kind: "radio",
      id: "commander",
      label: `${commanderName}'s art`,
      checked: playmat === "commander",
      onSelect: () => onPlaymat("commander"),
    });
  }

  // A check mark on the row while the sandbox is on: a radio of one, which the menu draws as the
  // mark a setting carries. Greyed, as an action, only while there is no game to set it on.
  const sandboxRow: MenuItem =
    view === null
      ? action("sandbox", "Sandbox", () => {}, true)
      : {
          kind: "radio",
          id: "sandbox",
          label: "Sandbox",
          checked: view.sandbox,
          onSelect: () => onAct({ type: "setSandbox", on: !view.sandbox }),
        };

  return [
    action("undo", "Undo", () => onAct({ type: "undo" }), !(view?.canUndo ?? false)),
    action("redo", "Redo", () => onAct({ type: "redo" }), !(view?.canRedo ?? false)),
    { kind: "separator", id: "sepUndo" },
    sandboxRow,
    action("untap", "Untap everything", () => onAct({ type: "untapAll" }), !edits),
    submenu(
      "token",
      "Create a token",
      tokens.length === 0
        ? [action("none", "This deck makes no tokens", () => {}, true)]
        : tokens.map((t) =>
            action(`token-${t.preset}`, t.source ? `${t.name} · from ${t.source}` : t.name, () =>
              onAct({ type: "createToken", preset: t.preset, count: 1 }),
            ),
          ),
      !edits,
    ),
    submenu(
      "lookThrough",
      "Look through",
      [
        action(
          "library",
          "Your library…",
          () => onLook({ zone: "library", mode: "search", count: "all" }),
          !edits,
        ),
        action(
          "graveyard",
          "Your graveyard…",
          () => onLook({ zone: "graveyard", mode: "browse", count: "all" }),
          (view?.graveyard.length ?? 0) === 0,
        ),
        action(
          "exile",
          "Exile…",
          () => onLook({ zone: "exile", mode: "browse", count: "all" }),
          (view?.exile.length ?? 0) === 0,
        ),
      ],
      !playing,
    ),
    submenu("playmat", "Playmat", mats),
    { kind: "separator", id: "sep" },
    action("new", "New game", onNewGame),
    { kind: "separator", id: "sep2" },
    action("back", backLabel, onBack),
  ];
}
