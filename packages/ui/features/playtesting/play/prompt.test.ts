import { describe, expect, it } from "vitest";
import type { PlaytestOption } from "@/lib/ipc";
import {
  optionCards,
  optionDetail,
  optionLabel,
  pickableCards,
  promptTitle,
  words,
} from "./prompt";

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
    const card = { id: 1, name: "Ragavan", cardId: null, text: null };
    expect(optionLabel(option({ cards: [card] }), target).text).toBe("Ragavan");
    expect(optionLabel(option({ players: ["opponent"] }), target).text).toBe("Opponent");
    expect(optionLabel(option({ players: ["you"] }), target).text).toBe("You");
    // At a four-player table, which opponent.
    expect(optionLabel(option({ players: ["opponent2"] }), target, 3).text).toBe("Opponent 2");
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
        cards: [{ id: 1, name: "B", cardId: null, text: null }],
      }),
      { kind: "CastChoice" },
    );
    expect(label).toEqual({ text: "Stomp", hint: "Cast adventure" });
  });
});

describe("an order of triggers", () => {
  const order = { kind: "OrderTriggers" };
  const ability = (id: number, name: string, text: string) => ({ id, name, cardId: null, text });
  const carmen = ability(1, "Carmen", "Whenever Carmen attacks, gain 1 life.");
  const clavileno = ability(2, "Clavileño", "Whenever Clavileño attacks, make a Vampire.");

  it("is said first-to-resolve first: the first placed resolves last", () => {
    const answer = option({ kind: "OrderTriggers", cards: [carmen, clavileno] });
    expect(optionCards(answer, order).map((c) => c.name)).toEqual(["Clavileño", "Carmen"]);
    expect(optionLabel(answer, order)).toEqual({
      text: "Clavileño resolves first",
      hint: "then Carmen",
    });
    expect(optionDetail(answer, order)).toBe(
      "1. Clavileño: Whenever Clavileño attacks, make a Vampire.\n" +
        "2. Carmen: Whenever Carmen attacks, gain 1 life.",
    );
  });

  it("names one card's two different triggers by their words", () => {
    const a = ability(1, "Vito", "Gain 1 life.");
    const b = ability(1, "Vito", "Draw a card.");
    expect(optionLabel(option({ kind: "OrderTriggers", cards: [a, b] }), order)).toEqual({
      text: "Draw a card. resolves first",
      hint: "then Gain 1 life.",
    });
  });

  it("chains three or more", () => {
    const third = ability(3, "Bloodghast", "Return it.");
    expect(
      optionLabel(option({ kind: "OrderTriggers", cards: [carmen, clavileno, third] }), order).hint,
    ).toBe("then Clavileño, then Carmen");
  });
});

describe("a replacement effect", () => {
  it("is named by its card, with its words beside", () => {
    const effect = { id: 4, name: "Doubling Season", cardId: null, text: "Twice that many." };
    expect(
      optionLabel(option({ kind: "ChooseReplacement", cards: [effect] }), {
        kind: "ReplacementChoice",
      }),
    ).toEqual({ text: "Doubling Season", hint: "Twice that many." });
  });
});

describe("pickableCards", () => {
  it("makes each one-card answer its card, the first answer keeping a card twice named", () => {
    const a = { id: 1, name: "A", cardId: null, text: null };
    const b = { id: 2, name: "B", cardId: null, text: null };
    const picks = pickableCards({
      kind: "TargetSelection",
      source: null,
      cancellable: false,
      pick: null,
      keyword: null,
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

  it("leaves a card standing for one of its abilities to the panel", () => {
    const effect = { id: 1, name: "A", cardId: null, text: "Twice that many." };
    const picks = pickableCards({
      kind: "ReplacementChoice",
      source: null,
      cancellable: false,
      pick: null,
      keyword: null,
      options: [option({ index: 0, kind: "ChooseReplacement", cards: [effect] })],
    });
    expect(picks.size).toBe(0);
  });
});

describe("an alternative cost", () => {
  const cast = (label: string) => option({ kind: "ChooseAlternativeCast", label });

  it("is asked as which cost, its answers the keyword's cost and the printed one", () => {
    expect(promptTitle("AlternativeCastChoice")).toBe("Which cost do you pay?");
    const question = { kind: "AlternativeCastChoice", keyword: "Overload" };
    expect(optionLabel(cast("Alternative"), question)).toEqual({ text: "Overload", hint: null });
    expect(optionLabel(cast("Normal"), question)).toEqual({ text: "Mana cost", hint: null });
  });

  it("says alternative cost when the engine names no keyword", () => {
    const question = { kind: "AlternativeCastChoice", keyword: null };
    expect(optionLabel(cast("Alternative"), question).text).toBe("Alternative cost");
  });
});
