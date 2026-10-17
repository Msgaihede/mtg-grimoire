import { describe, expect, it, vi } from "vitest";
import type { MenuAction, MenuItem, MenuRadio, MenuSubmenu } from "@/components/menu/types";
import { gameCard, turnNineSeat, turnNineTokens } from "./fixtures";
import { cardMenu, gameMenu, libraryMenu, type GameMenuView } from "./menus";

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
    const ring = gameCard("Sol Ring");
    const commander = gameCard("Kenrith, the Returned King", { isCommander: true });
    const off = { sandbox: false, onAct };
    expect(labels(cardMenu({ ...off, card: ring, ids: [ring.id], place: "hand" }))).toEqual([
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
    // An opponent's permanent (no ability of the reader's to activate) and a graveyard card have
    // nothing left to offer.
    expect(cardMenu({ ...off, card: ring, ids: [ring.id], place: "battlefield" })).toEqual([]);
    expect(cardMenu({ ...off, card: ring, ids: [ring.id], place: "graveyard" })).toEqual([]);
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

  it("heads a permanent's sandbox rows with Activate ability when the reader may activate it", () => {
    const ring = gameCard("Sol Ring");
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
    const items = libraryMenu({ view: turnNineSeat(), onAct, onLook });

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
    const items = libraryMenu({ view: { library: 0 }, onAct: vi.fn(), onLook: vi.fn() });
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
      backLabel: "Back to the deck",
      onAct,
      onNewGame,
      onBack,
    });
    act(items, "Untap everything").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "untapAll" });
    act(items, "New game").onSelect();
    expect(onNewGame).toHaveBeenCalled();
    act(items, "Back to the deck").onSelect();
    expect(onBack).toHaveBeenCalled();
  });
});
