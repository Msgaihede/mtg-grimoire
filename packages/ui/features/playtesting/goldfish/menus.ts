/**
 * The goldfish board's three right-click menus — a card (or a pile), the library, and the game —
 * as the artboard `Goldfish · the table, turn 9` draws them (2026-10-12).
 *
 * **Pure builders over the view**, the `features/decks/*Menu.tsx` arrangement: each returns
 * `MenuItem[]` and asks for everything through the callbacks, so the menus are tested as data and
 * the board decides when to build one (`menuClick`, `menu`). Built at the press rather than held,
 * because a {@link GameCard.id} is good only for the view it came from (CR 400.7).
 */
import type { MenuAction, MenuItem } from "@/components/menu/types";
import type { GameCard, GoldfishAction, GoldfishPlace, GoldfishView } from "@/lib/ipc";
import { FELTS } from "./playmats";
import type { Playmat, ZoneLook } from "./types";

type Act = (a: GoldfishAction) => void;

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
 * `onActivate` heads a permanent's menu with "Activate ability" — the playtest board's, where the
 * rules engine can activate one. The goldfish has no such action and passes none.
 */
export function cardMenu({
  card,
  ids,
  place,
  onAct,
  onActivate,
}: {
  card: GameCard;
  ids: number[];
  place: GoldfishPlace;
  onAct: Act;
  onActivate?: (id: number) => void;
}): MenuItem[] {
  const id = ids[0] ?? card.id;
  const move = (to: GoldfishPlace) => () => onAct({ type: "move", id, to });
  const commandRow = card.isCommander ? [action("command", "Command zone", move("command"))] : [];

  switch (place) {
    case "battlefield": {
      const pile = ids.length > 1;
      const tapWord = card.tapped ? "Untap" : "Tap";
      const counter = (kind: string, delta: number) => () =>
        onAct({ type: "counters", id, kind, delta });
      const items: MenuItem[] = [];
      if (onActivate !== undefined) {
        items.push(
          action("activate", "Activate ability", () => onActivate(id)),
          { kind: "separator", id: "sepActivate" },
        );
      }
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
    case "hand":
      return [
        action("play", "Play", () => onAct({ type: "play", id })),
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
    case "command":
      return [
        action("cast", "Cast", () => onAct({ type: "play", id })),
        { kind: "separator", id: "sep" },
        submenu("move", "Move to", [
          action("hand", "Hand", move("hand")),
          action("battlefield", "Battlefield, unpaid", move("battlefield")),
          action("graveyard", "Graveyard", move("graveyard")),
          action("exile", "Exile", move("exile")),
        ]),
      ];
    default: {
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

/** The library's menu, on a right-click of the pile (a left click draws). */
export function libraryMenu({
  view,
  onAct,
  onLook,
}: {
  view: Pick<GoldfishView, "library">;
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

/** What the game menu reads of a game: the reader's tokens, graveyard and exile, and — for a
 *  goldfish view — its stage. */
export type GameMenuView = Pick<GoldfishView, "tokens" | "graveyard" | "exile"> & {
  stage?: string;
};

/**
 * The game menu, under the board's top-left button. `view` is `null` while a game is being
 * dealt; then, and during the opening hand, only the rows that are not moves in the game work —
 * the engine refuses everything else until a hand is kept.
 *
 * **The playtest board's menu too**, which hands it the reader's own zones (`GameMenuView`), says
 * itself whether the moves work (`playing`: not during the opening hand, not once the game is
 * over) and names its own way back (`backLabel`).
 */
export function gameMenu({
  view,
  playing: playingOverride,
  backLabel = "Back to the deck",
  playmat,
  commanderName,
  onAct,
  onPlaymat,
  onNewGame,
  onBack,
  onLook,
}: {
  view: GameMenuView | null;
  /** Whether the game's own moves work now; read off a goldfish view's `stage` when absent. */
  playing?: boolean;
  backLabel?: string;
  playmat: Playmat;
  commanderName: string | null;
  onAct: Act;
  onPlaymat: (p: Playmat) => void;
  onNewGame: () => void;
  onBack: () => void;
  onLook: (l: ZoneLook) => void;
}): MenuItem[] {
  const playing = playingOverride ?? (view !== null && view.stage === "playing");
  const tokens = view?.tokens ?? [];

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

  return [
    action("untap", "Untap everything", () => onAct({ type: "untapAll" }), !playing),
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
      !playing,
    ),
    submenu(
      "lookThrough",
      "Look through",
      [
        action("library", "Your library…", () =>
          onLook({ zone: "library", mode: "search", count: "all" }),
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
