import { describe, expect, it } from "vitest";
import type { PlaytestCause, PlaytestOption } from "@/lib/ipc";
import {
  distinctOptions,
  optionCards,
  optionDetail,
  optionLabel,
  pickableCards,
  promptSource,
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
    const card = { id: 1, name: "Ragavan", cardId: null, text: null, cause: null };
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
        cards: [{ id: 1, name: "B", cardId: null, text: null, cause: null }],
      }),
      { kind: "CastChoice" },
    );
    expect(label).toEqual({ text: "Stomp", hint: "Cast adventure" });
  });
});

describe("an order of triggers", () => {
  const order = { kind: "OrderTriggers" };
  const ability = (id: number, name: string, text: string) => ({
    id,
    name,
    cardId: null,
    text,
    cause: null,
  });
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

/** Issue #1076: two triggers that read alike are told apart, or offered once. */
describe("triggers of one ability", () => {
  const order = { kind: "OrderTriggers" };
  const entered = (id: number, name: string): PlaytestCause => ({
    event: "ZoneChanged",
    id,
    name,
    player: "you",
  });
  const soulWarden = "Whenever another creature enters, you gain 1 life.";
  const warden = (id: number, cause: PlaytestCause | null) => ({
    id,
    name: "Soul Warden",
    cardId: null,
    text: soulWarden,
    cause,
  });

  it("are named by what set each off", () => {
    const bears = warden(1, entered(7, "Grizzly Bears"));
    const elf = warden(1, entered(8, "Llanowar Elves"));
    const answer = option({ kind: "OrderTriggers", cards: [bears, elf] });
    expect(optionLabel(answer, order)).toEqual({
      text: "Soul Warden for Llanowar Elves resolves first",
      hint: "then Soul Warden for Grizzly Bears",
    });
    expect(optionDetail(answer, order)).toBe(
      `1. Soul Warden: ${soulWarden} (for Llanowar Elves)\n` +
        `2. Soul Warden: ${soulWarden} (for Grizzly Bears)`,
    );
  });

  it("name a player when the event names no card the reader can see", () => {
    const hidden: PlaytestCause = { event: "CardDrawn", id: null, name: null, player: "opponent2" };
    const mine = warden(1, entered(7, "Grizzly Bears"));
    const label = optionLabel(
      option({ kind: "OrderTriggers", cards: [warden(1, hidden), mine] }),
      order,
      3,
    );
    expect(label.text).toBe("Soul Warden for Grizzly Bears resolves first");
    expect(label.hint).toBe("then Soul Warden for Opponent 2");
  });

  it("alike in name, words and cause are one order, offered once", () => {
    // Two Soul Wardens seeing one creature enter: either order is the same action.
    const a = warden(1, entered(7, "Grizzly Bears"));
    const b = warden(2, entered(7, "Grizzly Bears"));
    const options = [
      option({ index: 0, kind: "OrderTriggers", cards: [a, b] }),
      option({ index: 1, kind: "OrderTriggers", cards: [b, a] }),
    ];
    const kept = distinctOptions({ kind: "OrderTriggers", options });
    expect(kept.map((o) => o.index)).toEqual([0]);
    expect(optionLabel(kept[0], order)).toEqual({
      text: "Soul Warden resolves first",
      hint: "then Soul Warden",
    });
  });

  it("that differ keep every order, and other questions keep every answer", () => {
    const a = warden(1, entered(7, "Grizzly Bears"));
    const b = warden(2, entered(8, "Llanowar Elves"));
    const orders = [
      option({ index: 0, kind: "OrderTriggers", cards: [a, b] }),
      option({ index: 1, kind: "OrderTriggers", cards: [b, a] }),
    ];
    expect(distinctOptions({ kind: "OrderTriggers", options: orders })).toHaveLength(2);
    const alike = [option({ index: 0 }), option({ index: 1 })];
    expect(distinctOptions({ kind: "TargetSelection", options: alike })).toHaveLength(2);
  });

  it("asking for targets one after the other say whose target", () => {
    const prompt = {
      source: "Soul Warden",
      sourceText: soulWarden,
      cause: entered(7, "Grizzly Bears"),
    };
    expect(promptSource(prompt)).toEqual({
      text: "Soul Warden for Grizzly Bears",
      detail: `Soul Warden: ${soulWarden} (for Grizzly Bears)`,
    });
    expect(promptSource({ source: "Opt", sourceText: null, cause: null })).toEqual({
      text: "Opt",
      detail: null,
    });
    expect(promptSource({ source: null, sourceText: null, cause: null })).toBeNull();
  });
});

describe("a replacement effect", () => {
  it("is named by its card, with its words beside", () => {
    const effect = {
      id: 4,
      name: "Doubling Season",
      cardId: null,
      text: "Twice that many.",
      cause: null,
    };
    expect(
      optionLabel(option({ kind: "ChooseReplacement", cards: [effect] }), {
        kind: "ReplacementChoice",
      }),
    ).toEqual({ text: "Doubling Season", hint: "Twice that many." });
  });
});

describe("pickableCards", () => {
  it("makes each one-card answer its card, the first answer keeping a card twice named", () => {
    const a = { id: 1, name: "A", cardId: null, text: null, cause: null };
    const b = { id: 2, name: "B", cardId: null, text: null, cause: null };
    const picks = pickableCards({
      kind: "TargetSelection",
      source: null,
      sourceText: null,
      cause: null,
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
    const effect = { id: 1, name: "A", cardId: null, text: "Twice that many.", cause: null };
    const picks = pickableCards({
      kind: "ReplacementChoice",
      source: null,
      sourceText: null,
      cause: null,
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
