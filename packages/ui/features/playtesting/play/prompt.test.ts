import { describe, expect, it } from "vitest";
import type { PlaytestOption } from "@/lib/ipc";
import { optionLabel, pickableCards, promptTitle, words } from "./prompt";

function option(over: Partial<PlaytestOption>): PlaytestOption {
  return {
    index: 0,
    kind: "ChooseTarget",
    cards: [],
    players: [],
    number: null,
    yes: null,
    label: null,
    ...over,
  };
}

describe("promptTitle", () => {
  it("says the common questions in plain words", () => {
    expect(promptTitle("TargetSelection")).toBe("Choose a target");
    expect(promptTitle("TriggerTargetSelection")).toBe("Choose a target");
    expect(promptTitle("CastChoice")).toBe("How do you cast it?");
    expect(promptTitle("ChooseXValue")).toBe("Choose X");
  });

  it("splits any other kind into words", () => {
    expect(promptTitle("ChooseRingBearer")).toBe("Choose ring bearer");
    expect(words("XValueChoice")).toBe("X value choice");
  });
});

describe("optionLabel", () => {
  const target = { kind: "TargetSelection" };

  it("names a target by its card or its player", () => {
    const card = { id: 1, name: "Ragavan", cardId: null };
    expect(optionLabel(option({ cards: [card] }), target).text).toBe("Ragavan");
    expect(optionLabel(option({ players: ["opponent"] }), target).text).toBe("Opponent");
    expect(optionLabel(option({ players: ["you"] }), target).text).toBe("You");
  });

  it("calls a target answer with nothing in it the end of choosing", () => {
    expect(optionLabel(option({}), target).text).toBe("No more targets");
  });

  it("says yes and no, X and modes", () => {
    const may = { kind: "OptionalEffectChoice" };
    expect(optionLabel(option({ kind: "DecideOptionalEffect", yes: true }), may).text).toBe("Yes");
    expect(optionLabel(option({ kind: "DecideOptionalEffect", yes: false }), may).text).toBe("No");
    expect(optionLabel(option({ kind: "ChooseX", number: 3 }), { kind: "ChooseXValue" }).text).toBe(
      "X = 3",
    );
    expect(
      optionLabel(option({ kind: "ChooseMode", number: 0 }), { kind: "ModeChoice" }).text,
    ).toBe("Mode 1");
  });

  it("prefers a named choice's own word", () => {
    expect(
      optionLabel(option({ kind: "ChooseColor", label: "Red", number: 2 }), { kind: "NamedChoice" })
        .text,
    ).toBe("Red");
  });

  it("says how a cast differs beside its words", () => {
    const label = optionLabel(
      option({
        kind: "CastAdventure",
        label: "Stomp",
        cards: [{ id: 1, name: "B", cardId: null }],
      }),
      { kind: "CastChoice" },
    );
    expect(label).toEqual({ text: "Stomp", hint: "Cast adventure" });
  });
});

describe("pickableCards", () => {
  it("makes each one-card answer its card, the first answer keeping a card twice named", () => {
    const a = { id: 1, name: "A", cardId: null };
    const b = { id: 2, name: "B", cardId: null };
    const picks = pickableCards({
      kind: "TargetSelection",
      source: null,
      cancellable: false,
      pick: null,
      options: [
        option({ index: 0, cards: [a] }),
        option({ index: 1, cards: [a, b] }),
        option({ index: 2, cards: [b] }),
        option({ index: 3, cards: [a] }),
      ],
    });
    expect([...picks]).toEqual([
      [1, 0],
      [2, 2],
    ]);
  });
});
