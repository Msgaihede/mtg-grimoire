import { describe, expect, it, vi } from "vitest";
import type { MenuAction, MenuItem, MenuRadio, MenuSubmenu } from "@/components/menu/types";
import type { GameCard } from "@/lib/ipc";
import { gameCard, turnNineSeat, turnNineTokens } from "./fixtures";
import { cardMenu, gameMenu, libraryMenu, rulesPlay, type GameMenuView } from "./menus";

/** The row with this label, at this level of the menu. */
function row(items: MenuItem[], label: string): MenuAction | MenuSubmenu | MenuRadio {
  const found = items.find((i) => i.kind !== "separator" && "label" in i && i.label === label);
  if (found === undefined || found.kind === "separator" || found.kind === "lazy") {
    throw new Error(
      `no row "${label}" in ${items.map((i) => ("label" in i ? i.label : "—")).join(", ")}`,
    );
  }
  return found;
}

function act(items: MenuItem[], label: string): MenuAction {
  const r = row(items, label);
  if (r.kind !== "action") throw new Error(`"${label}" is a ${r.kind}`);
  return r;
}

function sub(items: MenuItem[], label: string): MenuItem[] {
  const r = row(items, label);
  if (r.kind !== "submenu") throw new Error(`"${label}" is a ${r.kind}`);
  return r.items;
}

const labels = (items: MenuItem[]) =>
  items.flatMap((i) => (i.kind === "separator" ? [] : [i.label]));

/** What the game menu reads of the turn-nine table, the sandbox on. */
function menuView(over: Partial<GameMenuView> = {}): GameMenuView {
  const seat = turnNineSeat();
  return {
    graveyard: seat.graveyard,
    exile: seat.exile,
    tokens: turnNineTokens(),
    canUndo: true,
    canRedo: false,
    sandbox: true,
    ...over,
  };
}

describe("cardMenu", () => {
  it("taps one card of a pile, or the whole pile", () => {
    const onAct = vi.fn();
    const forest = gameCard("Forest");
    const items = cardMenu({
      card: forest,
      ids: [11, 12, 13],
      place: "battlefield",
      sandbox: true,
      onAct,
    });

    act(items, "Tap one").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "tap", ids: [11], tapped: true });
    act(items, "Tap all 3").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "tap", ids: [11, 12, 13], tapped: true });
    expect(labels(items)).toContain("Move one to");
  });

  it("untaps a tapped card alone, with no pile rows", () => {
    const onAct = vi.fn();
    const card = gameCard("Sol Ring", { tapped: true });
    const items = cardMenu({ card, ids: [card.id], place: "battlefield", sandbox: true, onAct });

    expect(labels(items)).toEqual(["Untap", "Counters", "Create a token copy", "Move to"]);
    act(items, "Untap").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "tap", ids: [card.id], tapped: false });
  });

  // Issue #1713: who a permanent can be handed to by hand.
  it("gains control of an opponent's permanent, and gives the reader's own away", () => {
    const onAct = vi.fn();
    const giant = gameCard("Tarmogoyf");
    const theirs = cardMenu({
      card: giant,
      ids: [giant.id],
      place: "battlefield",
      sandbox: true,
      onAct,
      control: [{ player: "you", name: "you" }],
    });
    expect(labels(theirs)).toEqual([
      "Tap",
      "Counters",
      "Create a token copy",
      "Gain control",
      "Move to",
    ]);
    act(theirs, "Gain control").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "control", id: giant.id, seat: "you" });

    const mine = cardMenu({
      card: giant,
      ids: [giant.id],
      place: "battlefield",
      sandbox: true,
      onAct,
      control: [{ player: "opponent", name: "the opponent" }],
    });
    act(mine, "Give control to the opponent").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "control", id: giant.id, seat: "opponent" });
  });

  it("gives control to one of several players from a submenu, a pile's top card alone", () => {
    const onAct = vi.fn();
    const goblin = gameCard("Tarmogoyf");
    const items = cardMenu({
      card: goblin,
      ids: [21, 22],
      place: "battlefield",
      sandbox: true,
      onAct,
      control: [
        { player: "you", name: "you" },
        { player: "opponent", name: "Opponent 1" },
        { player: "opponent3", name: "Opponent 3" },
      ],
    });
    act(items, "Gain control of one").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "control", id: 21, seat: "you" });
    const to = sub(items, "Give control of one to");
    expect(labels(to)).toEqual(["Opponent 1", "Opponent 3"]);
    act(to, "Opponent 3").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "control", id: 21, seat: "opponent3" });
  });

  it("offers no control rows with the sandbox off, or off the battlefield", () => {
    const card = gameCard("Tarmogoyf");
    const control = [{ player: "you" as const, name: "you" }];
    const off = cardMenu({
      card,
      ids: [card.id],
      place: "battlefield",
      sandbox: false,
      onAct: vi.fn(),
      control,
    });
    expect(off).toEqual([]);
    const yard = cardMenu({
      card,
      ids: [card.id],
      place: "graveyard",
      sandbox: true,
      onAct: vi.fn(),
      control,
    });
    expect(labels(yard)).not.toContain("Gain control");
  });

  it("greys removing a counter the card does not carry", () => {
    const onAct = vi.fn();
    const bare = gameCard("Llanowar Elves");
    const counters = sub(
      cardMenu({ card: bare, ids: [bare.id], place: "battlefield", sandbox: true, onAct }),
      "Counters",
    );
    expect(act(counters, "Remove a +1/+1 counter").disabled).toBe(true);
    expect(act(counters, "Remove a loyalty counter").disabled).toBe(true);

    act(counters, "Add a +1/+1 counter").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({
      type: "counters",
      id: bare.id,
      kind: "+1/+1",
      delta: 1,
    });

    const grown = gameCard("Llanowar Elves", { counters: [{ kind: "+1/+1", count: 2 }] });
    const more = sub(
      cardMenu({ card: grown, ids: [grown.id], place: "battlefield", sandbox: true, onAct }),
      "Counters",
    );
    expect(act(more, "Remove a +1/+1 counter").disabled).toBeUndefined();
    act(more, "Remove a +1/+1 counter").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({
      type: "counters",
      id: grown.id,
      kind: "+1/+1",
      delta: -1,
    });
  });

  it("offers the command zone only to a commander", () => {
    const onAct = vi.fn();
    const plain = gameCard("Sol Ring");
    const commander = gameCard("Kenrith, the Returned King", { isCommander: true });
    const plainMove = sub(
      cardMenu({ card: plain, ids: [plain.id], place: "battlefield", sandbox: true, onAct }),
      "Move to",
    );
    const commanderMove = sub(
      cardMenu({
        card: commander,
        ids: [commander.id],
        place: "battlefield",
        sandbox: true,
        onAct,
      }),
      "Move to",
    );
    expect(labels(plainMove)).not.toContain("Command zone");
    act(commanderMove, "Command zone").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "move", id: commander.id, to: "command" });
  });

  it("plays from the hand, and puts a card down unpaid by Move to", () => {
    const onAct = vi.fn();
    const card = gameCard("Sol Ring");
    const items = cardMenu({ card, ids: [card.id], place: "hand", sandbox: true, onAct });

    act(items, "Play").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "play", id: card.id });
    const move = sub(items, "Move to");
    expect(labels(move)).toEqual([
      "Battlefield, unpaid",
      "Discard",
      "Exile",
      "Top of library",
      "Bottom of library",
    ]);
    act(move, "Battlefield, unpaid").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "move", id: card.id, to: "battlefield" });
  });

  it("casts from the command zone", () => {
    const onAct = vi.fn();
    const card = gameCard("Kenrith, the Returned King", { isCommander: true });
    const items = cardMenu({ card, ids: [card.id], place: "command", sandbox: true, onAct });
    act(items, "Cast").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "play", id: card.id });
    expect(labels(sub(items, "Move to"))).toEqual([
      "Hand",
      "Battlefield, unpaid",
      "Graveyard",
      "Exile",
    ]);
  });

  it("moves out of the graveyard to anywhere but the graveyard", () => {
    const onAct = vi.fn();
    const card = gameCard("Swords to Plowshares");
    const move = sub(
      cardMenu({ card, ids: [card.id], place: "graveyard", sandbox: true, onAct }),
      "Move to",
    );
    expect(labels(move)).toEqual([
      "Hand",
      "Battlefield",
      "Exile",
      "Top of library",
      "Bottom of library",
    ]);
    act(move, "Top of library").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "move", id: card.id, to: "libraryTop" });
  });

  it("keeps only the rules' rows with the sandbox off", () => {
    const onAct = vi.fn();
    const onActivate = vi.fn();
    const ring = gameCard("Sol Ring", { canActivate: true });
    const idle = gameCard("Sol Ring");
    const commander = gameCard("Kenrith, the Returned King", { isCommander: true });
    const off = { sandbox: false, onAct };
    expect(labels(cardMenu({ ...off, card: idle, ids: [idle.id], place: "hand" }))).toEqual([
      "Play",
    ]);
    expect(
      labels(cardMenu({ ...off, card: commander, ids: [commander.id], place: "command" })),
    ).toEqual(["Cast"]);
    const permanent = cardMenu({
      ...off,
      card: ring,
      ids: [ring.id, 99],
      place: "battlefield",
      onActivate,
    });
    expect(labels(permanent)).toEqual(["Activate ability"]);
    act(permanent, "Activate ability").onSelect();
    expect(onActivate).toHaveBeenCalledWith(ring.id);
    // A permanent with no ability the rules let the reader activate now, and a graveyard card
    // with none, have nothing left to offer.
    expect(
      cardMenu({ ...off, card: idle, ids: [idle.id], place: "battlefield", onActivate }),
    ).toEqual([]);
    expect(cardMenu({ ...off, card: idle, ids: [idle.id], place: "graveyard" })).toEqual([]);
  });

  it("offers Activate ability on a permanent only when the rules offer one", () => {
    // It was offered on every permanent of the reader's, and the engine refused most of them.
    const onActivate = vi.fn();
    const base = { place: "battlefield" as const, onAct: vi.fn(), onActivate };
    const idle = gameCard("Llanowar Elves");
    expect(labels(cardMenu({ ...base, card: idle, ids: [idle.id], sandbox: false }))).toEqual([]);
    expect(labels(cardMenu({ ...base, card: idle, ids: [idle.id], sandbox: true }))[0]).toBe("Tap");
  });

  it("activates an opponent's permanent any player may activate, by the rules (CR 602.2)", () => {
    // An opponent's card is handed no `onActivate`: the row sends its `activate` itself.
    const onAct = vi.fn();
    const relic = gameCard("Sol Ring", { canActivate: true });
    const items = cardMenu({
      card: relic,
      ids: [relic.id],
      place: "battlefield",
      sandbox: false,
      onAct,
    });
    expect(labels(items)).toEqual(["Activate ability"]);
    act(items, "Activate ability").onSelect();
    expect(onAct).toHaveBeenCalledWith({ type: "activate", id: relic.id });
  });

  it("offers Activate ability on a commander with commander ninjutsu, sandbox or not", () => {
    const onAct = vi.fn();
    const ninja = gameCard("Kenrith, the Returned King", { isCommander: true, canActivate: true });
    const menu = (sandbox: boolean) =>
      cardMenu({ card: ninja, ids: [ninja.id], place: "command", sandbox, onAct });
    expect(labels(menu(false))).toEqual(["Cast", "Activate ability"]);
    act(menu(false), "Activate ability").onSelect();
    expect(onAct).toHaveBeenCalledWith({ type: "activate", id: ninja.id });
    expect(labels(menu(true))).toEqual(["Cast", "Activate ability", "Move to"]);
  });

  it("offers Foretell on a hand card the rules let the reader foretell, sandbox or not", () => {
    const onAct = vi.fn();
    const behold = gameCard("Behold the Multiverse", { canForetell: true });
    const off = cardMenu({ card: behold, ids: [behold.id], place: "hand", sandbox: false, onAct });
    expect(labels(off)).toEqual(["Play", "Foretell"]);
    act(off, "Foretell").onSelect();
    expect(onAct).toHaveBeenCalledWith({ type: "foretell", id: behold.id });
    const on = cardMenu({ card: behold, ids: [behold.id], place: "hand", sandbox: true, onAct });
    expect(labels(on)).toEqual(["Play", "Foretell", "Move to"]);
    // Not offered when the rules would refuse it.
    const plain = gameCard("Behold the Multiverse");
    expect(
      labels(cardMenu({ card: plain, ids: [plain.id], place: "hand", sandbox: false, onAct })),
    ).toEqual(["Play"]);
  });

  it("offers Activate ability on a hand card the rules let the reader cycle, sandbox or not", () => {
    // Issue #1431: a cycling card in hand had no row that reached its cycling.
    const onAct = vi.fn();
    const illumination = gameCard("Hieroglyphic Illumination", { canActivate: true });
    const menu = (sandbox: boolean, card = illumination) =>
      cardMenu({ card, ids: [card.id], place: "hand", sandbox, onAct });
    expect(labels(menu(false))).toEqual(["Play", "Activate ability"]);
    act(menu(false), "Activate ability").onSelect();
    expect(onAct).toHaveBeenCalledWith({ type: "activate", id: illumination.id });
    expect(labels(menu(true))).toEqual(["Play", "Activate ability", "Move to"]);
    // Not offered when the rules would refuse it.
    expect(labels(menu(false, gameCard("Hieroglyphic Illumination")))).toEqual(["Play"]);
  });

  it("casts a foretold card from exile, sandbox or not", () => {
    const onAct = vi.fn();
    const behold = gameCard("Behold the Multiverse", { foretold: true, castable: true });
    const off = cardMenu({ card: behold, ids: [behold.id], place: "exile", sandbox: false, onAct });
    expect(labels(off)).toEqual(["Cast"]);
    act(off, "Cast").onSelect();
    expect(onAct).toHaveBeenCalledWith({ type: "play", id: behold.id });
    const on = cardMenu({ card: behold, ids: [behold.id], place: "exile", sandbox: true, onAct });
    expect(labels(on)).toEqual(["Cast", "Move to"]);
  });

  it("offers Activate ability on a graveyard card the rules let the reader unearth, sandbox or not", () => {
    // Issue #1714: unearth works from the graveyard, and the menu had no row that reached it.
    const onAct = vi.fn();
    const zombie = gameCard("Dregscape Zombie", { canActivate: true });
    const menu = (sandbox: boolean, card = zombie) =>
      cardMenu({ card, ids: [card.id], place: "graveyard", sandbox, onAct });
    expect(labels(menu(false))).toEqual(["Activate ability"]);
    act(menu(false), "Activate ability").onSelect();
    expect(onAct).toHaveBeenCalledWith({ type: "activate", id: zombie.id });
    expect(labels(menu(true))).toEqual(["Activate ability", "Move to"]);
    // Not offered when the rules would refuse it.
    expect(labels(menu(false, gameCard("Dregscape Zombie")))).toEqual([]);
    // A card that can be both cast and activated from here offers both, Cast first.
    const both = gameCard("Dregscape Zombie", { canActivate: true, castable: true });
    expect(labels(menu(false, both))).toEqual(["Cast", "Activate ability"]);
  });

  it("offers Tap for mana on a permanent the rules let tap for it, sandbox or not", () => {
    const onAct = vi.fn();
    const forest = gameCard("Forest", { canTapForMana: true });
    const base = { card: forest, ids: [forest.id], place: "battlefield" as const, onAct };
    const off = cardMenu({ ...base, sandbox: false });
    expect(labels(off)).toEqual(["Tap for mana"]);
    act(off, "Tap for mana").onSelect();
    expect(onAct).toHaveBeenCalledWith({ type: "tapForMana", id: forest.id });
    expect(labels(cardMenu({ ...base, sandbox: true }))).toEqual([
      "Tap for mana",
      "Tap",
      "Counters",
      "Create a token copy",
      "Move to",
    ]);
    // A tapped land, or one the rules would refuse, has no such row.
    const tapped = gameCard("Forest", { canTapForMana: true, tapped: true });
    expect(cardMenu({ ...base, card: tapped, sandbox: false })).toEqual([]);
    expect(cardMenu({ ...base, card: gameCard("Forest"), sandbox: false })).toEqual([]);
  });

  it("heads a permanent's sandbox rows with Activate ability when the reader may activate it", () => {
    const ring = gameCard("Sol Ring", { canActivate: true });
    const items = cardMenu({
      card: ring,
      ids: [ring.id],
      place: "battlefield",
      sandbox: true,
      onAct: vi.fn(),
      onActivate: vi.fn(),
    });
    expect(labels(items)).toEqual([
      "Activate ability",
      "Tap",
      "Counters",
      "Create a token copy",
      "Move to",
    ]);
  });
});

describe("libraryMenu", () => {
  it("draws, mills and opens the top cards", () => {
    const onAct = vi.fn();
    const onLook = vi.fn();
    const items = libraryMenu({ view: turnNineSeat(), sandbox: true, onAct, onLook });

    act(items, "Draw a card").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "draw", count: 1 });
    act(sub(items, "Draw"), "Draw 7").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "draw", count: 7 });
    act(sub(items, "Mill"), "Mill 3").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "mill", count: 3 });
    act(sub(items, "Scry…"), "Scry 2").onSelect();
    expect(onLook).toHaveBeenLastCalledWith({ zone: "library", mode: "scry", count: 2 });
    act(sub(items, "Look at the top cards…"), "The top 5").onSelect();
    expect(onLook).toHaveBeenLastCalledWith({ zone: "library", mode: "look", count: 5 });
    act(items, "Search the library…").onSelect();
    expect(onLook).toHaveBeenLastCalledWith({ zone: "library", mode: "search", count: "all" });
    act(items, "Shuffle").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "shuffle" });
  });

  it("greys drawing, milling and scrying from an empty library", () => {
    const items = libraryMenu({
      view: { library: 0, libraryTop: null },
      sandbox: true,
      onAct: vi.fn(),
      onLook: vi.fn(),
    });
    for (const label of [
      "Draw a card",
      "Draw",
      "Scry…",
      "Surveil…",
      "Mill",
      "Look at the top cards…",
    ]) {
      expect(act(items, label).disabled).toBe(true);
    }
    expect(act(items, "Search the library…").disabled).toBeUndefined();
    expect(act(items, "Shuffle").disabled).toBeUndefined();
  });
});

describe("libraryMenu's top card", () => {
  it("offers nothing with the sandbox off and no top card to play", () => {
    const menu = (libraryTop: GameCard | null) =>
      libraryMenu({
        view: { library: 40, libraryTop },
        sandbox: false,
        onAct: vi.fn(),
        onLook: vi.fn(),
      });
    expect(menu(null)).toEqual([]);
    // Seen, but not playable from there: still nothing.
    expect(menu(gameCard("Llanowar Elves"))).toEqual([]);
  });

  it("casts the top card the rules let the reader cast from there, sandbox or not (Future Sight)", () => {
    const onAct = vi.fn();
    const elves = gameCard("Llanowar Elves", { castable: true });
    const menu = (sandbox: boolean) =>
      libraryMenu({ view: { library: 40, libraryTop: elves }, sandbox, onAct, onLook: vi.fn() });
    expect(labels(menu(false))).toEqual(["Cast Llanowar Elves"]);
    act(menu(false), "Cast Llanowar Elves").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "play", id: elves.id });
    // The sandbox's rows follow the rules' own.
    expect(labels(menu(true)).slice(0, 3)).toEqual(["Cast Llanowar Elves", "Draw a card", "Draw"]);
  });

  it("plays a land from the top, and activates an ability that works from there (plot)", () => {
    const onAct = vi.fn();
    const forest = gameCard("Forest", { castable: true });
    const land = libraryMenu({
      view: { library: 40, libraryTop: forest },
      sandbox: false,
      onAct,
      onLook: vi.fn(),
    });
    expect(labels(land)).toEqual(["Play Forest"]);
    const plotted = gameCard("Llanowar Elves", { canActivate: true });
    const plot = libraryMenu({
      view: { library: 40, libraryTop: plotted },
      sandbox: false,
      onAct,
      onLook: vi.fn(),
    });
    expect(labels(plot)).toEqual(["Activate Llanowar Elves's ability"]);
    act(plot, "Activate Llanowar Elves's ability").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "activate", id: plotted.id });
  });
});

describe("rulesPlay", () => {
  it("casts when the rules offer it, else activates, else nothing", () => {
    const both = gameCard("Forest", { castable: true, canActivate: true });
    expect(rulesPlay(both)).toEqual({ type: "play", id: both.id });
    const plot = gameCard("Forest", { canActivate: true });
    expect(rulesPlay(plot)).toEqual({ type: "activate", id: plot.id });
    expect(rulesPlay(gameCard("Forest"))).toBeNull();
  });
});

describe("gameMenu", () => {
  const base = {
    playing: true,
    sandbox: true,
    backLabel: "Back to setup",
    playmat: "felt" as const,
    commanderName: "Kenrith, the Returned King",
    onAct: vi.fn(),
    onPlaymat: vi.fn(),
    onNewGame: vi.fn(),
    onBack: vi.fn(),
    onLook: vi.fn(),
  };

  it("offers one token row per token the deck makes", () => {
    const onAct = vi.fn();
    const view = menuView({
      tokens: [
        { preset: "treasure", name: "Treasure", source: "Old Gnawbone", cardId: null },
        { preset: "food", name: "Food", source: "Tireless Provisioner", cardId: null },
      ],
    });
    const tokens = sub(gameMenu({ ...base, view, onAct }), "Create a token");
    expect(labels(tokens)).toEqual([
      "Treasure · from Old Gnawbone",
      "Food · from Tireless Provisioner",
    ]);
    act(tokens, "Food · from Tireless Provisioner").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "createToken", preset: "food", count: 1 });
  });

  it("names a token the reader added by hand without a source", () => {
    const view = menuView({
      tokens: [{ preset: "soldier", name: "Soldier", source: "", cardId: "c-soldier" }],
    });
    const tokens = sub(gameMenu({ ...base, view }), "Create a token");
    expect(labels(tokens)).toEqual(["Soldier"]);
  });

  it("says when the deck makes no tokens", () => {
    const tokens = sub(gameMenu({ ...base, view: menuView({ tokens: [] }) }), "Create a token");
    expect(act(tokens, "This deck makes no tokens").disabled).toBe(true);
  });

  // Issue #1022: the menu's way to the same actions Ctrl+Z and Ctrl+Y send.
  it("heads the menu with undo and redo, greyed when there is nowhere to go", () => {
    const onAct = vi.fn();
    const items = gameMenu({
      ...base,
      view: menuView({ canUndo: true, canRedo: false }),
      onAct,
    });
    expect(labels(items).slice(0, 2)).toEqual(["Undo", "Redo"]);
    expect(act(items, "Undo").disabled).toBeUndefined();
    expect(act(items, "Redo").disabled).toBe(true);
    act(items, "Undo").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "undo" });
    const back = gameMenu({
      ...base,
      view: menuView({ canUndo: false, canRedo: true }),
      onAct,
    });
    expect(act(back, "Undo").disabled).toBe(true);
    act(back, "Redo").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "redo" });
    expect(act(gameMenu({ ...base, view: null }), "Undo").disabled).toBe(true);
  });

  it("greys the game's own moves during the opening hand and while dealing", () => {
    for (const view of [menuView(), null]) {
      const items = gameMenu({ ...base, view, playing: false });
      expect(act(items, "Untap everything").disabled).toBe(true);
      expect(act(items, "Create a token").disabled).toBe(true);
      expect(act(items, "Look through").disabled).toBe(true);
      expect(act(items, "New game").disabled).toBeUndefined();
      expect(act(items, "Back to setup").disabled).toBeUndefined();
    }
  });

  // Issue #1746: Concede, as phase's own game menu offers it — greyed while there is nothing to
  // concede, and the board's own question before it is sent.
  it("offers Concede while a game is unfinished", () => {
    const onConcede = vi.fn();
    const items = gameMenu({ ...base, view: menuView(), onConcede });
    expect(act(items, "Concede").disabled).toBeUndefined();
    act(items, "Concede").onSelect();
    expect(onConcede).toHaveBeenCalledOnce();
    expect(act(gameMenu({ ...base, view: menuView() }), "Concede").disabled).toBe(true);
    expect(act(gameMenu({ ...base, view: menuView(), onConcede: null }), "Concede").disabled).toBe(
      true,
    );
  });

  it("toggles the sandbox from its own row, checked while it is on", () => {
    const onAct = vi.fn();
    const on = row(gameMenu({ ...base, view: menuView({ sandbox: true }), onAct }), "Sandbox");
    if (on.kind !== "radio") throw new Error("not a radio");
    expect(on.checked).toBe(true);
    on.onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "setSandbox", on: false });

    // A setting: offered whatever the stage, the opening hand included.
    const off = row(
      gameMenu({
        ...base,
        view: menuView({ sandbox: false }),
        playing: false,
        sandbox: false,
        onAct,
      }),
      "Sandbox",
    );
    if (off.kind !== "radio") throw new Error("not a radio");
    expect(off.checked).toBe(false);
    off.onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "setSandbox", on: true });

    expect(act(gameMenu({ ...base, view: null }), "Sandbox").disabled).toBe(true);
  });

  it("greys the sandbox's rows while its moves do not work, and keeps the browsing", () => {
    const items = gameMenu({ ...base, view: menuView({ sandbox: false }), sandbox: false });
    expect(act(items, "Untap everything").disabled).toBe(true);
    expect(act(items, "Create a token").disabled).toBe(true);
    const look = sub(items, "Look through");
    expect(act(look, "Your library…").disabled).toBe(true);
    // The graveyard is public: still looked through, read-only.
    expect(act(look, "Your graveyard…").disabled).toBeUndefined();
  });

  it("chooses the playmat, offering the commander's art only when there is a commander", () => {
    const onPlaymat = vi.fn();
    const mats = sub(gameMenu({ ...base, view: menuView(), onPlaymat }), "Playmat");
    expect(mats.map((m) => m.kind === "radio" && [m.label, m.checked])).toEqual([
      ["Felt", true],
      ["Green felt", false],
      ["Blue felt", false],
      ["Red felt", false],
      ["Purple felt", false],
      ["Slate", false],
      ["Kenrith, the Returned King's art", false],
    ]);
    const green = row(mats, "Green felt");
    if (green.kind !== "radio") throw new Error("not a radio");
    green.onSelect();
    expect(onPlaymat).toHaveBeenCalledWith("green");
    const art = row(mats, "Kenrith, the Returned King's art");
    if (art.kind !== "radio") throw new Error("not a radio");
    art.onSelect();
    expect(onPlaymat).toHaveBeenCalledWith("commander");

    const noCommander = sub(
      gameMenu({ ...base, view: menuView(), commanderName: null }),
      "Playmat",
    );
    expect(labels(noCommander)).toEqual([
      "Felt",
      "Green felt",
      "Blue felt",
      "Red felt",
      "Purple felt",
      "Slate",
    ]);
  });

  it("untaps everything, starts over and goes back by the board's own words", () => {
    const onAct = vi.fn();
    const onNewGame = vi.fn();
    const onBack = vi.fn();
    const items = gameMenu({
      ...base,
      view: menuView(),
      backLabel: "Back to deck",
      onAct,
      onNewGame,
      onBack,
    });
    act(items, "Untap everything").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "untapAll" });
    act(items, "New game").onSelect();
    expect(onNewGame).toHaveBeenCalled();
    act(items, "Back to deck").onSelect();
    expect(onBack).toHaveBeenCalled();
  });
});
