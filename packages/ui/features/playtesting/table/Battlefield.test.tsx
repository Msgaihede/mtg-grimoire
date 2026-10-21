import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GameCard } from "@/lib/ipc";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { LAYER } from "@/lib/layers";
import { Battlefield, tableCardWidth } from "./Battlefield";

let next = 1;
function card(name: string, over: Partial<GameCard> = {}): GameCard {
  return {
    id: next++,
    cardId: `p-${name}`,
    name,
    typeLine: "",
    lane: "land",
    manaValue: 0,
    isLand: true,
    isToken: false,
    isCommander: false,
    tapped: false,
    counters: [],
    effects: [],
    power: null,
    toughness: null,
    basePower: null,
    baseToughness: null,
    tax: 0,
    attachedTo: null,
    foretold: false,
    canForetell: false,
    castable: false,
    gaps: [],
    ...over,
  };
}

function creature(name: string, over: Partial<GameCard> = {}): GameCard {
  return card(name, {
    lane: "creature",
    isLand: false,
    power: 2,
    toughness: 2,
    basePower: 2,
    baseToughness: 2,
    ...over,
  });
}

function setup(
  cards: GameCard[],
  {
    sandbox = true,
    readOnly = false,
    onActivate,
  }: { sandbox?: boolean; readOnly?: boolean; onActivate?: (id: number) => void } = {},
) {
  const onAct = vi.fn();
  const onPoint = vi.fn();
  const onUnpoint = vi.fn();
  render(
    <ContextMenuProvider>
      <Battlefield
        cards={cards}
        sandbox={sandbox}
        readOnly={readOnly}
        onActivate={onActivate}
        onAct={onAct}
        onDrop={vi.fn()}
        onPoint={onPoint}
        onUnpoint={onUnpoint}
      />
    </ContextMenuProvider>,
  );
  return { onAct, onPoint, onUnpoint };
}

const menuRows = () => screen.queryAllByRole("menuitem").map((r) => r.textContent);

describe("Battlefield", () => {
  it("piles two Forests that look the same into one card marked ×2", () => {
    setup([card("Forest"), card("Forest")]);
    expect(screen.getByRole("button", { name: "2 Forests" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("×2")).toBeInTheDocument();
  });

  it("draws a pile as its cards stacked, five at most, with the count on the chip", () => {
    setup(Array.from({ length: 8 }, () => card("Forest")));
    const pile = document.querySelector("[data-land]");
    // The top card is the button; the four under it are drawn and hidden from a screen reader.
    expect(pile?.querySelectorAll(':scope > div[aria-hidden="true"]')).toHaveLength(4);
    expect(screen.getByText("×8")).toBeInTheDocument();
  });

  it("draws every card of a pile shorter than five", () => {
    setup([card("Island"), card("Island"), card("Island")]);
    const pile = document.querySelector("[data-land]");
    expect(pile?.querySelectorAll(':scope > div[aria-hidden="true"]')).toHaveLength(2);
  });

  it("keeps a tapped Forest apart from an untapped one, and says which is tapped", () => {
    setup([card("Forest"), card("Forest", { tapped: true })]);
    expect(screen.getByRole("button", { name: "Forest" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forest, tapped" })).toBeInTheDocument();
    expect(screen.queryByText(/^×/)).not.toBeInTheDocument();
  });

  it("does not pluralise a name that already ends in s", () => {
    setup([card("Plains", { tapped: true }), card("Plains", { tapped: true })]);
    expect(screen.getByRole("button", { name: "2 Plains, tapped" })).toBeInTheDocument();
  });

  it("taps the top card of a pile on a click", () => {
    const a = card("Forest");
    const b = card("Forest");
    const { onAct } = setup([a, b]);
    fireEvent.click(screen.getByRole("button", { name: "2 Forests" }));
    expect(onAct).toHaveBeenCalledWith({ type: "tap", ids: [a.id], tapped: true });
  });

  it("taps the whole pile on a Shift-click, and untaps a tapped one", () => {
    const a = card("Plains", { tapped: true });
    const b = card("Plains", { tapped: true });
    const { onAct } = setup([a, b]);
    fireEvent.click(screen.getByRole("button", { name: "2 Plains, tapped" }), { shiftKey: true });
    expect(onAct).toHaveBeenCalledWith({ type: "tap", ids: [a.id, b.id], tapped: false });
  });

  it("badges a +1/+1 counter the way the card reads, and any other kind by name", () => {
    setup([
      creature("Tataru Taru", { counters: [{ kind: "+1/+1", count: 2 }] }),
      card("Karn", { lane: "other", isLand: false, counters: [{ kind: "loyalty", count: 3 }] }),
    ]);
    expect(screen.getByText("+2/+2")).toBeInTheDocument();
    expect(screen.getByText("3 loyalty")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tataru Taru, +2/+2" })).toBeInTheDocument();
  });

  it("chips each effect on a card with its source, and names them in full (issue #1327)", () => {
    setup([
      creature("Vampire Cleric", {
        effects: [
          {
            kind: "type",
            source: "Clavileño",
            gained: ["Demon"],
            lost: [],
            losesAbilities: false,
            abilities: [],
            power: null,
            toughness: null,
          },
          {
            kind: "ability",
            source: "Clavileño",
            gained: [],
            lost: [],
            losesAbilities: false,
            abilities: ["When ~ dies, draw a card."],
            power: null,
            toughness: null,
          },
        ],
      }),
    ]);
    expect(screen.getByText("+Demon · Clavileño")).toBeInTheDocument();
    expect(screen.getByText("+Dies trigger · Clavileño")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name:
          "Vampire Cleric, +Demon from Clavileño; " +
          "+Dies trigger from Clavileño: “When Vampire Cleric dies, draw a card.”",
      }),
    ).toBeInTheDocument();
  });

  it("counts the effects past the third in one more chip", () => {
    const pump = (source: string) => ({
      kind: "modifyPt" as const,
      source,
      gained: [],
      lost: [],
      losesAbilities: false,
      abilities: [],
      power: 1,
      toughness: 1,
    });
    setup([creature("Bear", { effects: ["A", "B", "C", "D"].map(pump) })]);
    expect(document.querySelectorAll("[data-effect]")).toHaveLength(2);
    expect(screen.getByText("+2 more")).toBeInTheDocument();
  });

  it("draws a changed creature's P/T in a chip, each stat coloured by which way it moved", () => {
    setup([
      creature("Tataru Taru", { power: 4, toughness: 1, counters: [] }),
      creature("Grizzly Bears"),
    ]);
    const chips = screen.getAllByTestId("stats-chip");
    expect(chips).toHaveLength(1);
    const [power, slash, toughness] = Array.from(chips[0].children);
    expect([power.textContent, slash.textContent, toughness.textContent]).toEqual(["4", "/", "1"]);
    expect(power).toHaveClass("text-ok");
    expect(toughness).toHaveClass("text-destructive");
    expect(screen.getByRole("button", { name: "Tataru Taru, 4/1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grizzly Bears" })).toBeInTheDocument();
  });

  it("colours a stat that stayed as printed white beside one that moved", () => {
    setup([creature("Tataru Taru", { power: 2, toughness: 4 })]);
    const [power, , toughness] = Array.from(screen.getByTestId("stats-chip").children);
    expect(power).toHaveClass("text-white");
    expect(toughness).toHaveClass("text-ok");
  });

  it("says a token is one", () => {
    setup([
      card("Treasure", { lane: "other", isLand: false, isToken: true, cardId: null }),
      card("Treasure", { lane: "other", isLand: false, isToken: true, cardId: null }),
    ]);
    expect(screen.getByRole("button", { name: "2 Treasures, token" })).toBeInTheDocument();
  });

  it("borders a card the rules engine plays only in part, and says so (issue #1093)", () => {
    setup([
      creature("Moonlit Bard", { gaps: ["Trigger:Whenever the moon is full"] }),
      creature("Grizzly Bears"),
    ]);
    const partly = screen.getByRole("button", { name: "Moonlit Bard, played only in part" });
    expect(partly.querySelector("[data-partly]")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Grizzly Bears" }).querySelector("[data-partly]"),
    ).toBeNull();
  });

  it("lays creatures in front and lands and the rest behind", () => {
    setup([
      creature("Old Gnawbone"),
      card("Forest"),
      card("Sol Ring", { lane: "other", isLand: false }),
    ]);
    const front = screen.getByRole("region", { name: "Creatures" });
    const back = screen.getByRole("region", { name: "Lands and other permanents" });
    expect(within(front).getByRole("button", { name: "Old Gnawbone" })).toBeInTheDocument();
    expect(within(back).getByRole("button", { name: "Forest" })).toBeInTheDocument();
    expect(within(back).getByRole("button", { name: "Sol Ring" })).toBeInTheDocument();
  });

  it("points at a pile with its count, and lets go when the pointer leaves", () => {
    const a = card("Forest");
    const b = card("Forest");
    const { onPoint, onUnpoint } = setup([a, b]);
    const pile = screen.getByRole("button", { name: "2 Forests" });
    fireEvent.mouseEnter(pile);
    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        ids: [a.id, b.id],
        place: "battlefield",
        line: "2 Forests on the battlefield",
      }),
    );
    fireEvent.mouseLeave(pile);
    expect(onUnpoint).toHaveBeenCalled();
  });

  it("tucks an Equipment under the creature it is attached to (issue #1073)", () => {
    const bear = creature("Grizzly Bears");
    const sword = card("Bonesplitter", { lane: "other", isLand: false, attachedTo: bear.id });
    const { onPoint } = setup([bear, sword]);
    const front = screen.getByRole("region", { name: "Creatures" });
    expect(
      within(front).getByRole("button", { name: "Grizzly Bears, with Bonesplitter" }),
    ).toBeInTheDocument();
    const under = within(front).getByRole("button", {
      name: "Bonesplitter, attached to Grizzly Bears",
    });
    const back = screen.getByRole("region", { name: "Lands and other permanents" });
    expect(within(back).queryByRole("button")).not.toBeInTheDocument();
    fireEvent.mouseEnter(under);
    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [sword.id], line: "Bonesplitter, attached to Grizzly Bears" }),
    );
  });

  it("lifts an attachment over the card it is tucked under while it is pointed at (issue #1331)", () => {
    const bear = creature("Grizzly Bears");
    const sword = card("Bonesplitter", { lane: "other", isLand: false, attachedTo: bear.id });
    const aura = card("Rancor", { lane: "other", isLand: false, attachedTo: bear.id });
    setup([bear, sword, aura]);
    const edge = (name: string) =>
      screen.getByRole("button", { name: `${name}, attached to Grizzly Bears` });

    expect(edge("Bonesplitter")).not.toHaveClass(LAYER.raised);
    fireEvent.mouseEnter(edge("Bonesplitter"));
    expect(edge("Bonesplitter")).toHaveClass(LAYER.raised);
    expect(edge("Rancor")).not.toHaveClass(LAYER.raised);

    fireEvent.mouseLeave(edge("Bonesplitter"));
    fireEvent.mouseEnter(edge("Rancor"));
    expect(edge("Bonesplitter")).not.toHaveClass(LAYER.raised);
    expect(edge("Rancor")).toHaveClass(LAYER.raised);

    fireEvent.mouseLeave(edge("Rancor"));
    expect(edge("Rancor")).not.toHaveClass(LAYER.raised);
  });

  it("activates an Equipment's ability from its edge under the creature", async () => {
    const bear = creature("Grizzly Bears");
    const sword = card("Bonesplitter", { lane: "other", isLand: false, attachedTo: bear.id });
    const onActivate = vi.fn();
    setup([bear, sword], { sandbox: false, onActivate });
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Bonesplitter, attached to Grizzly Bears" }),
    );
    await screen.findByRole("menu");
    fireEvent.click(screen.getByRole("menuitem", { name: "Activate ability" }));
    expect(onActivate).toHaveBeenCalledWith(sword.id);
  });

  it("offers an empty table as somewhere to play a card", () => {
    setup([]);
    expect(screen.getByRole("region", { name: "Battlefield" })).toHaveTextContent(
      "Drag a card here to play it",
    );
  });
});

describe("Battlefield with the sandbox off", () => {
  it("taps nothing on a click, and its menu is the rules' one row", async () => {
    const ring = card("Sol Ring", { lane: "other", isLand: false });
    const onActivate = vi.fn();
    const { onAct } = setup([ring], { sandbox: false, onActivate });
    const button = screen.getByRole("button", { name: "Sol Ring" });
    fireEvent.click(button);
    fireEvent.click(button, { shiftKey: true });
    expect(onAct).not.toHaveBeenCalled();

    fireEvent.contextMenu(button);
    await screen.findByRole("menu");
    expect(menuRows()).toEqual(["Activate ability"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Activate ability" }));
    expect(onActivate).toHaveBeenCalledWith(ring.id);
  });

  it("opens no menu on a card with no ability to offer", () => {
    setup([card("Forest")], { sandbox: false, readOnly: true });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Forest" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("Battlefield's far side with the sandbox on", () => {
  it("is tapped through its menu, never by a click, and offers no ability of its own", async () => {
    const goblin = creature("Goblin Guide");
    const { onAct } = setup([goblin], { readOnly: true, onActivate: vi.fn() });
    const button = screen.getByRole("button", { name: "Goblin Guide" });
    fireEvent.click(button);
    expect(onAct).not.toHaveBeenCalled();

    fireEvent.contextMenu(button);
    await screen.findByRole("menu");
    expect(menuRows()).not.toContain("Activate ability");
    fireEvent.click(screen.getByRole("menuitem", { name: "Tap" }));
    expect(onAct).toHaveBeenCalledWith({ type: "tap", ids: [goblin.id], tapped: true });
  });
});

describe("tableCardWidth", () => {
  it("is the width a lone card is drawn at on a table that tall", () => {
    // jsdom lays nothing out: the section reads a 2000 × 606 box, a tall window's table.
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(2000);
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(606);
    try {
      render(
        <ContextMenuProvider>
          <Battlefield
            cards={[card("Forest")]}
            sandbox
            dense
            onAct={vi.fn()}
            onDrop={vi.fn()}
            onPoint={vi.fn()}
            onUnpoint={vi.fn()}
          />
        </ContextMenuProvider>,
      );
      expect(screen.getByRole("button", { name: "Forest" }).style.width).toBe(
        `${tableCardWidth(606, true)}px`,
      );
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });
});
