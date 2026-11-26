import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaytestPrompt } from "@/lib/ipc";
import {
  castChoicePrompt,
  optionalEffectPrompt,
  orderTriggersPrompt,
  targetPrompt,
} from "./fixtures";
import { PromptPanel } from "./PromptPanel";

function setup(prompt: PlaytestPrompt, disabled = false) {
  const onAct = vi.fn();
  const onPoint = vi.fn();
  render(
    <PromptPanel
      prompt={prompt}
      table={[]}
      disabled={disabled}
      onAct={onAct}
      onPoint={onPoint}
      onUnpoint={vi.fn()}
    />,
  );
  return { onAct, onPoint };
}

/** A question of `kind` with no listed answers but those in `over`. */
function question(kind: string, over: Partial<PlaytestPrompt>): PlaytestPrompt {
  return {
    kind,
    source: null,
    sourceText: null,
    cause: null,
    options: [],
    cancellable: false,
    pick: null,
    keyword: null,
    damage: null,
    shown: [],
    distribute: null,
    nameEntry: false,
    counters: null,
    triggers: null,
    results: null,
    ...over,
  };
}

const ref = (id: number, name: string) => ({ id, name, cardId: null, text: null, cause: null });

const named = (index: number, label: string) => ({
  index,
  kind: "ChooseOption",
  cards: [],
  players: [],
  number: null,
  yes: null,
  label,
});

describe("PromptPanel", () => {
  it("titles the question, names its source and sends the answer picked", () => {
    const prompt = targetPrompt().view.prompt!;
    const { onAct } = setup(prompt);
    expect(screen.getByRole("heading", { name: "Choose a target" })).toBeInTheDocument();
    expect(screen.getByText("Swords to Plowshares")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Boros Reckoner/ }));
    expect(onAct).toHaveBeenCalledWith({ type: "choose", index: 1 });
  });

  it("points at a row's card while it is hovered", () => {
    const { onPoint } = setup(targetPrompt().view.prompt!);
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Ragavan/ }));
    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Ragavan, Nimble Pilferer" }),
      expect.anything(),
    );
  });

  it("lets the engine choose, and cancels a cast of the reader's", () => {
    const { onAct } = setup(castChoicePrompt().view.prompt!);
    expect(screen.getByRole("button", { name: /Stomp/ })).toHaveTextContent("Cast adventure");
    fireEvent.click(screen.getByRole("button", { name: "Let the engine choose" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "auto" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "cancel" });
  });

  it("says what an order of triggers decides, and each answer's order with its pictures", () => {
    const prompt = orderTriggersPrompt().view.prompt!;
    const { onAct } = setup(prompt);
    expect(screen.getByRole("heading", { name: "Order your triggers" })).toBeInTheDocument();
    expect(screen.getByText("Pick which resolves first")).toBeInTheDocument();
    // Two Delvers' upkeep triggers read alike either way round: one answer, not two the same
    // (issue #1076).
    const answers = screen.getAllByRole("button", { name: /resolves first/ });
    expect(answers).toHaveLength(1);
    expect(answers[0]).toHaveTextContent("then Delver of Secrets");
    expect(answers[0].getAttribute("title")).toMatch(/^1\. Delver of Secrets.*: At the beginning/);
    // A picture per trigger, numbered in the order they resolve.
    expect(within(answers[0]).getByText("1")).toBeInTheDocument();
    expect(within(answers[0]).getByText("2")).toBeInTheDocument();
    fireEvent.click(answers[0]);
    expect(onAct).toHaveBeenCalledWith({ type: "choose", index: 0 });
  });

  it("says which trigger a target is for: what set it off, and its words in the tooltip", () => {
    const text = "Whenever another creature enters, it deals 1 damage to any target.";
    setup({
      ...targetPrompt().view.prompt!,
      kind: "TriggerTargetSelection",
      source: "Impact Tremors",
      sourceText: text,
      cause: { event: "ZoneChanged", id: 70, name: "Grizzly Bears", player: "you" },
      cancellable: false,
    });
    const line = screen.getByText("Impact Tremors for Grizzly Bears");
    expect(line.getAttribute("title")).toBe(`Impact Tremors: ${text} (for Grizzly Bears)`);
  });

  it("says the ability a yes or a no agrees to, its mana symbols drawn (issue #1328)", () => {
    const prompt = optionalEffectPrompt().view.prompt!;
    const { onAct } = setup(prompt);
    expect(screen.getByRole("heading", { name: "Do you want to…?" })).toBeInTheDocument();
    expect(screen.getByText("Windbrisk Heights")).toBeInTheDocument();
    const words = screen.getByText(/You may play the exiled card/).closest("p")!;
    expect(words.getAttribute("title")).toBe(prompt.sourceText);
    expect(words).not.toHaveTextContent("{T}");
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onAct).toHaveBeenCalledWith({ type: "choose", index: 1 });
  });

  it("draws no words for a question about no ability", () => {
    setup(castChoicePrompt().view.prompt!);
    expect(document.querySelector("p[title]")).toBeNull();
  });

  it("offers only the engine's choice for a question it cannot draw", () => {
    setup({
      kind: "ChooseRingBearer",
      source: null,
      sourceText: null,
      cause: null,
      options: [],
      cancellable: false,
      pick: null,
      keyword: null,
      damage: null,
      shown: [],
      distribute: null,
      nameEntry: false,
      counters: null,
      triggers: null,
      results: null,
    });
    expect(screen.getByRole("heading", { name: "Choose ring bearer" })).toBeInTheDocument();
    expect(screen.getByText(/can’t show this choice/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("sends nothing while the engine is busy", () => {
    const { onAct } = setup(targetPrompt().view.prompt!, true);
    fireEvent.click(screen.getByRole("button", { name: /Ragavan/ }));
    expect(onAct).not.toHaveBeenCalled();
  });

  it("draws the cards a question shows, each pointed while hovered", () => {
    const { onPoint } = setup(
      question("OptionalEffectChoice", {
        shown: [ref(31, "Ponder")],
        options: [
          { ...named(0, "No"), kind: "DecideOptionalEffect", label: null, yes: false },
          { ...named(1, "Yes"), kind: "DecideOptionalEffect", label: null, yes: true },
        ],
      }),
    );
    const shown = screen.getByRole("list", { name: "Cards shown" });
    fireEvent.mouseEnter(within(shown).getByTitle("Ponder"));
    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: 31, name: "Ponder" }),
      expect.anything(),
    );
    expect(screen.getByRole("button", { name: "Yes" })).toBeInTheDocument();
    expect(screen.queryByText(/can’t show this choice/)).not.toBeInTheDocument();
  });

  it("takes a typed name, and narrows the listed names to it", () => {
    const { onAct } = setup(
      question("NamedChoice", {
        nameEntry: true,
        options: [named(0, "Lightning Bolt"), named(1, "Lightning Helix"), named(2, "Forest")],
      }),
    );
    const name = screen.getByRole("button", { name: "Name it" });
    expect(name).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "light" },
    });
    expect(screen.getByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lightning Helix" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forest" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Lightning Helix" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "choose", index: 1 });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "  Pithing Needle " },
    });
    fireEvent.click(name);
    expect(onAct).toHaveBeenLastCalledWith({ type: "name", text: "Pithing Needle" });
  });

  it("names on Enter, and offers the typed name even with nothing listed", () => {
    const { onAct } = setup(question("NamedChoice", { nameEntry: true }));
    expect(screen.queryByText(/can’t show this choice/)).not.toBeInTheDocument();
    const box = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(box, { target: { value: "Goblin" } });
    fireEvent.submit(box.closest("form")!);
    expect(onAct).toHaveBeenCalledWith({ type: "name", text: "Goblin" });
  });

  it("divides an amount among its targets, the engine's own division behind Other answers", () => {
    const { onAct } = setup(
      question("DistributeAmong", {
        source: "Forked Bolt",
        distribute: {
          total: 2,
          unit: "Damage",
          targets: [
            { card: ref(7, "Grizzly Bears"), player: null, min: 1 },
            { card: null, player: "opponent", min: 1 },
          ],
        },
        options: [{ ...named(0, "x"), kind: "DistributeAmong", label: null }],
      }),
    );
    expect(screen.getByRole("heading", { name: "Divide" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Divide 2 damage" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Distribute among" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Other answers" }));
    expect(screen.getByRole("button", { name: "Distribute among" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Divide" }));
    expect(onAct).toHaveBeenCalledWith({
      type: "distribute",
      shares: [
        { id: 7, player: null, amount: 1 },
        { id: null, player: "opponent", amount: 1 },
      ],
    });
  });

  it("takes so many counters of each kind off a card, none at all an answer (issue #1745)", () => {
    const { onAct } = setup(
      question("RemoveCountersChoice", {
        options: [named(0, "none"), named(1, "all")],
        counters: {
          source: ref(1, "Tetravus"),
          kinds: [{ kind: "+1/+1", count: 3 }],
          destinations: [],
          maxTotal: null,
        },
      }),
    );
    expect(screen.queryByRole("button", { name: "all" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More counters to +1/+1 counters" }));
    fireEvent.click(screen.getByRole("button", { name: "More counters to +1/+1 counters" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove 2" }));
    expect(onAct).toHaveBeenCalledWith({
      type: "moveCounters",
      shares: [{ kind: "+1/+1", to: null, count: 2 }],
    });
  });

  it("puts five triggers in the order picked, the first listed resolving first", () => {
    const triggers = [0, 1, 2, 3, 4].map((i) => ({
      ...ref(10 + i, `Shrine ${i}`),
      text: `gain ${i}`,
    }));
    const { onAct } = setup(question("OrderTriggers", { triggers }));
    // The engine's own order resolves the last put on first.
    const rows = within(screen.getByRole("list", { name: /Triggers/ })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Shrine 4");
    fireEvent.click(screen.getByRole("button", { name: "Resolve Shrine 0 earlier" }));
    fireEvent.click(screen.getByRole("button", { name: "Put on the stack" }));
    expect(onAct).toHaveBeenCalledWith({ type: "orderTriggers", order: [1, 0, 2, 3, 4] });
  });

  it("shows the flips, and keeps the one picked", () => {
    const { onAct } = setup(
      question("CoinFlipKeepChoice", {
        results: { dice: false, results: [1, 0], eligible: [0, 1], count: 1 },
      }),
    );
    const keep = screen.getByRole("button", { name: "Keep it" });
    fireEvent.click(keep);
    expect(onAct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Flip 2: Tails" }));
    fireEvent.click(keep);
    expect(onAct).toHaveBeenCalledWith({ type: "keepResults", indices: [1] });
  });
});
