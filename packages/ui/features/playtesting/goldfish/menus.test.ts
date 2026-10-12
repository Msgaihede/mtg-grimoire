import { describe, expect, it, vi } from "vitest";
import type { MenuAction, MenuItem, MenuRadio, MenuSubmenu } from "@/components/menu/types";
import type { GoldfishView } from "@/lib/ipc";
import { gameCard, openingHandView, turnNineView } from "./fixtures";
import { cardMenu, gameMenu, libraryMenu } from "./menus";

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

describe("cardMenu", () => {
  it("taps one card of a pile, or the whole pile", () => {
    const onAct = vi.fn();
    const forest = gameCard("Forest");
    const items = cardMenu({ card: forest, ids: [11, 12, 13], place: "battlefield", onAct });

    act(items, "Tap one").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "tap", ids: [11], tapped: true });
    act(items, "Tap all 3").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "tap", ids: [11, 12, 13], tapped: true });
    expect(labels(items)).toContain("Move one to");
  });

  it("untaps a tapped card alone, with no pile rows", () => {
    const onAct = vi.fn();
    const card = gameCard("Sol Ring", { tapped: true });
    const items = cardMenu({ card, ids: [card.id], place: "battlefield", onAct });

    expect(labels(items)).toEqual(["Untap", "Counters", "Create a token copy", "Move to"]);
    act(items, "Untap").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "tap", ids: [card.id], tapped: false });
  });

  it("greys removing a counter the card does not carry", () => {
    const onAct = vi.fn();
    const bare = gameCard("Llanowar Elves");
    const counters = sub(
      cardMenu({ card: bare, ids: [bare.id], place: "battlefield", onAct }),
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
      cardMenu({ card: grown, ids: [grown.id], place: "battlefield", onAct }),
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
      cardMenu({ card: plain, ids: [plain.id], place: "battlefield", onAct }),
      "Move to",
    );
    const commanderMove = sub(
      cardMenu({ card: commander, ids: [commander.id], place: "battlefield", onAct }),
      "Move to",
    );
    expect(labels(plainMove)).not.toContain("Command zone");
    act(commanderMove, "Command zone").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "move", id: commander.id, to: "command" });
  });

  it("plays from the hand, and puts a card down unpaid by Move to", () => {
    const onAct = vi.fn();
    const card = gameCard("Sol Ring");
    const items = cardMenu({ card, ids: [card.id], place: "hand", onAct });

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
    const items = cardMenu({ card, ids: [card.id], place: "command", onAct });
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
    const move = sub(cardMenu({ card, ids: [card.id], place: "graveyard", onAct }), "Move to");
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
});

describe("libraryMenu", () => {
  it("draws, mills and opens the top cards", () => {
    const onAct = vi.fn();
    const onLook = vi.fn();
    const items = libraryMenu({ view: turnNineView(), onAct, onLook });

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
    const view: GoldfishView = { ...turnNineView(), library: 0, libraryCards: [], libraryLands: 0 };
    const items = libraryMenu({ view, onAct: vi.fn(), onLook: vi.fn() });
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
    const view: GoldfishView = {
      ...turnNineView(),
      tokens: [
        { preset: "treasure", name: "Treasure", source: "Old Gnawbone", cardId: null },
        { preset: "food", name: "Food", source: "Tireless Provisioner", cardId: null },
      ],
    };
    const tokens = sub(gameMenu({ ...base, view, onAct }), "Create a token");
    expect(labels(tokens)).toEqual([
      "Treasure · from Old Gnawbone",
      "Food · from Tireless Provisioner",
    ]);
    act(tokens, "Food · from Tireless Provisioner").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "createToken", preset: "food", count: 1 });
  });

  it("says when the deck makes no tokens", () => {
    const view: GoldfishView = { ...turnNineView(), tokens: [] };
    const tokens = sub(gameMenu({ ...base, view }), "Create a token");
    expect(act(tokens, "This deck makes no tokens").disabled).toBe(true);
  });

  it("greys the game's own moves during the opening hand and while dealing", () => {
    for (const view of [openingHandView(), null]) {
      const items = gameMenu({ ...base, view });
      expect(act(items, "Untap everything").disabled).toBe(true);
      expect(act(items, "Create a token").disabled).toBe(true);
      expect(act(items, "New game").disabled).toBeUndefined();
      expect(act(items, "Back to the deck").disabled).toBeUndefined();
    }
  });

  it("chooses the playmat, offering the commander's art only when there is a commander", () => {
    const onPlaymat = vi.fn();
    const mats = sub(gameMenu({ ...base, view: turnNineView(), onPlaymat }), "Playmat");
    expect(mats.map((m) => m.kind === "radio" && [m.label, m.checked])).toEqual([
      ["Felt", true],
      ["Kenrith, the Returned King's art", false],
    ]);
    const art = row(mats, "Kenrith, the Returned King's art");
    if (art.kind !== "radio") throw new Error("not a radio");
    art.onSelect();
    expect(onPlaymat).toHaveBeenCalledWith("commander");

    const noCommander = sub(
      gameMenu({ ...base, view: turnNineView(), commanderName: null }),
      "Playmat",
    );
    expect(labels(noCommander)).toEqual(["Felt"]);
  });

  it("untaps everything, starts over and goes back", () => {
    const onAct = vi.fn();
    const onNewGame = vi.fn();
    const onBack = vi.fn();
    const items = gameMenu({ ...base, view: turnNineView(), onAct, onNewGame, onBack });
    act(items, "Untap everything").onSelect();
    expect(onAct).toHaveBeenLastCalledWith({ type: "untapAll" });
    act(items, "New game").onSelect();
    expect(onNewGame).toHaveBeenCalled();
    act(items, "Back to the deck").onSelect();
    expect(onBack).toHaveBeenCalled();
  });
});
