import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaytestPrompt, PlaytestView } from "@/lib/ipc";
import type { TableDrag } from "../table/tableDrag";
import { aimAnswer, aimDrop, canCarry, retractDrop, useAimFollowThrough } from "./aim";
import { NO_PICKS, toggleAttacker } from "./combat";
import {
  attackStep,
  blockStep,
  castChoicePrompt,
  fourPlayerAttack,
  respondStep,
  targetPrompt,
  turnFive,
  withAttachments,
} from "./fixtures";

const carried = (id: number, from: TableDrag["from"] = "battlefield"): TableDrag => ({
  ids: [id],
  from,
  name: "Card",
});

describe("canCarry", () => {
  it("picks up an attacker or a blocker in its step, and any permanent but a land with priority", () => {
    const attack = attackStep();
    expect(canCarry(attack.view, attack.goyf)).toBe(true);
    expect(canCarry(attack.view, { id: 999_999, isLand: false })).toBe(false);
    const block = blockStep();
    expect(canCarry(block.view, block.elves)).toBe(true);
    expect(canCarry(block.view, block.delver)).toBe(false);
    const main = turnFive();
    const forest = main.view.you.battlefield.find((c) => c.isLand)!;
    expect(canCarry(main.view, main.goyf)).toBe(true);
    expect(canCarry(main.view, forest)).toBe(false);
    expect(canCarry(respondStep().view, main.goyf)).toBe(true);
    expect(canCarry({ ...main.view, stage: "watching" }, main.goyf)).toBe(false);
    expect(canCarry(targetPrompt().view, main.goyf)).toBe(false);
  });
});

describe("aimDrop in the declare-attackers step", () => {
  it("attacks the opponent when an attacker is let go on their plate, felt or creature", () => {
    const { view, elves, ragavan } = attackStep();
    const pair = { attacker: elves.id, target: null, player: "opponent" };
    for (const [at, felt] of [
      ["opponent", false],
      ["opponent", true],
      [ragavan.id, false],
    ] as const) {
      expect(aimDrop(view, NO_PICKS, carried(elves.id), at, felt)).toEqual({
        kind: "picks",
        picks: { ...NO_PICKS, attacks: [pair] },
      });
    }
  });

  it("attacks a planeswalker it may attack, and re-aims one already attacking", () => {
    const { view, goyf, jace } = attackStep();
    const picked = toggleAttacker(NO_PICKS, view, goyf.id);
    expect(picked.aiming).toBe(goyf.id);
    expect(aimDrop(view, picked, carried(goyf.id), jace.id)).toEqual({
      kind: "picks",
      picks: {
        ...picked,
        attacks: [{ attacker: goyf.id, target: jace.id, player: null }],
        aiming: null,
      },
    });
    // Jace's felt is the player's, not the planeswalker: a drop beside it attacks the player.
    expect(aimDrop(view, NO_PICKS, carried(goyf.id), "opponent", true)).toMatchObject({
      picks: { attacks: [{ attacker: goyf.id, target: null, player: "opponent" }] },
    });
  });

  it("refuses what the rules do not allow", () => {
    const { view, elves, goyf, jace, delver } = attackStep();
    // The Elves may not attack Jace, and nothing attacks the reader.
    expect(aimDrop(view, NO_PICKS, carried(elves.id), jace.id)).toMatchObject({
      picks: { attacks: [{ attacker: elves.id, player: "opponent", target: null }] },
    });
    expect(aimDrop(view, NO_PICKS, carried(elves.id), "you")).toBeNull();
    expect(aimDrop(view, NO_PICKS, carried(elves.id), goyf.id)).toBeNull();
    // A creature that may not attack, a card from the hand, a card onto itself.
    const sphinx = view.you.hand[2];
    expect(aimDrop(view, NO_PICKS, carried(sphinx.id, "hand"), "opponent")).toBeNull();
    expect(aimDrop(view, NO_PICKS, carried(delver.id), delver.id)).toBeNull();
    const noDelver = {
      ...view,
      attack: { ...view.attack!, attackers: view.attack!.attackers.slice(0, 2) },
    };
    expect(aimDrop(noDelver, NO_PICKS, carried(delver.id), "opponent")).toBeNull();
  });

  it("attacks the opponent whose side it is let go on at a four-player table", () => {
    const { view, elves } = fourPlayerAttack();
    expect(aimDrop(view, NO_PICKS, carried(elves.id), "opponent2", true)).toMatchObject({
      picks: { attacks: [{ attacker: elves.id, target: null, player: "opponent2" }] },
    });
    // Opponent 3 is not among the players the Elves may attack.
    expect(aimDrop(view, NO_PICKS, carried(elves.id), "opponent3")).toBeNull();
  });
});

describe("aimDrop in the declare-blockers step", () => {
  it("blocks an attacker the blocker may block, in place of its last block", () => {
    const { view, goyf, ragavan, reckoner } = blockStep();
    const once = aimDrop(view, NO_PICKS, carried(goyf.id), ragavan.id);
    expect(once).toEqual({
      kind: "picks",
      picks: { ...NO_PICKS, blocks: [{ blocker: goyf.id, attacker: ragavan.id }] },
    });
    expect(aimDrop(view, NO_PICKS, carried(goyf.id), reckoner.id)).toBeNull();
    expect(aimDrop(view, NO_PICKS, carried(goyf.id), "opponent")).toBeNull();
    expect(aimDrop(view, NO_PICKS, carried(goyf.id), ragavan.id, true)).toBeNull();
  });
});

describe("aimDrop with priority", () => {
  it("plays a card from the hand, keeping its target", () => {
    const { view, ragavan } = turnFive();
    const swords = view.you.hand[3];
    expect(aimDrop(view, NO_PICKS, carried(swords.id, "hand"), ragavan.id)).toEqual({
      kind: "act",
      action: { type: "play", id: swords.id },
      target: ragavan.id,
    });
    expect(aimDrop(view, NO_PICKS, carried(swords.id, "hand"), "opponent")).toMatchObject({
      action: { type: "play", id: swords.id },
      target: "opponent",
    });
  });

  it("activates a permanent onto a card on either table — an equip", () => {
    const t = withAttachments();
    const bonesplitter = t.view.you.battlefield.find((c) => c.name === "Bonesplitter")!;
    expect(aimDrop(t.view, NO_PICKS, carried(bonesplitter.id), t.elves.id)).toEqual({
      kind: "act",
      action: { type: "activate", id: bonesplitter.id },
      target: t.elves.id,
    });
    const respond = respondStep();
    expect(
      aimDrop(respond.view, NO_PICKS, carried(respond.goyf.id), respond.ragavan.id),
    ).toMatchObject({ action: { type: "activate", id: respond.goyf.id } });
  });

  it("never plays a land, aims at a felt, or names a card the table does not show", () => {
    const { view, goyf } = turnFive();
    const forest = view.you.hand[1];
    expect(aimDrop(view, NO_PICKS, carried(forest.id, "hand"), goyf.id)).toBeNull();
    const island = view.you.battlefield.find((c) => c.name === "Island")!;
    expect(aimDrop(view, NO_PICKS, carried(island.id), goyf.id)).toBeNull();
    const swords = view.you.hand[3];
    expect(aimDrop(view, NO_PICKS, carried(swords.id, "hand"), "opponent", true)).toBeNull();
    expect(aimDrop(view, NO_PICKS, carried(swords.id, "hand"), 999_999)).toBeNull();
    // A graveyard card is the sandbox's to move, not a play.
    const bolt = view.you.graveyard[0];
    expect(aimDrop(view, NO_PICKS, carried(bolt.id, "graveyard"), goyf.id)).toBeNull();
    // An opponent out of the game is no target.
    const out: PlaytestView = {
      ...view,
      opponents: view.opponents.map((o) => ({ ...o, out: true })),
    };
    expect(aimDrop(out, NO_PICKS, carried(swords.id, "hand"), "opponent")).toBeNull();
  });

  it("does nothing while the engine asks a question", () => {
    const { view, ragavan } = targetPrompt();
    expect(aimDrop(view, NO_PICKS, carried(view.you.hand[3].id, "hand"), ragavan.id)).toBeNull();
  });
});

describe("retractDrop", () => {
  it("takes an attacker or a blocker off when it is carried home", () => {
    const attack = attackStep();
    const picked = toggleAttacker(NO_PICKS, attack.view, attack.elves.id);
    expect(retractDrop(attack.view, picked, carried(attack.elves.id))).toEqual(NO_PICKS);
    expect(retractDrop(attack.view, picked, carried(attack.goyf.id))).toBeNull();
    const block = blockStep();
    const blocking = {
      ...NO_PICKS,
      blocks: [{ blocker: block.goyf.id, attacker: block.ragavan.id }],
    };
    expect(retractDrop(block.view, blocking, carried(block.goyf.id))).toEqual(NO_PICKS);
    expect(retractDrop(turnFive().view, picked, carried(attack.elves.id))).toBeNull();
  });
});

describe("aimAnswer", () => {
  it("answers a target question with the card or player it names", () => {
    const { view, reckoner } = targetPrompt();
    expect(aimAnswer(view.prompt, reckoner.id)).toBe(1);
    expect(aimAnswer(view.prompt, 999_999)).toBeNull();
    const players: PlaytestPrompt = {
      ...view.prompt!,
      options: [
        ...view.prompt!.options,
        {
          index: 3,
          kind: "ChooseTarget",
          cards: [],
          players: ["opponent"],
          number: null,
          yes: null,
          label: null,
        },
      ],
    };
    expect(aimAnswer(players, "opponent")).toBe(3);
    expect(aimAnswer(players, "you")).toBeNull();
  });

  it("answers no other question", () => {
    const { view } = castChoicePrompt();
    const named = view.prompt!.options.find((o) => o.cards.length === 1)?.cards[0].id;
    if (named !== undefined) expect(aimAnswer(view.prompt, named)).toBeNull();
    expect(aimAnswer(null, 1)).toBeNull();
  });
});

describe("useAimFollowThrough", () => {
  function follow(start: PlaytestView) {
    const act = vi.fn();
    const hook = renderHook(
      ({ view, busy }: { view: PlaytestView; busy: boolean }) =>
        useAimFollowThrough(view, busy, false, act),
      { initialProps: { view: start, busy: false } },
    );
    return { act, hook };
  }

  it("answers the target question that follows the play", () => {
    const main = turnFive().view;
    const { act, hook } = follow(main);
    const asked = targetPrompt();
    hook.result.current(asked.reckoner.id, main);
    hook.rerender({ view: main, busy: true });
    hook.rerender({ view: asked.view, busy: false });
    expect(act).toHaveBeenCalledExactlyOnceWith({ type: "choose", index: 1 });
    // Spent: the same question again is not answered twice.
    hook.rerender({ view: { ...asked.view }, busy: false });
    expect(act).toHaveBeenCalledTimes(1);
  });

  it("waits past another question, and gives up when the play needed no target", () => {
    const main = turnFive().view;
    const { act, hook } = follow(main);
    const asked = targetPrompt();
    hook.result.current(asked.reckoner.id, main);
    hook.rerender({ view: castChoicePrompt().view, busy: false });
    expect(act).not.toHaveBeenCalled();
    hook.rerender({ view: castChoicePrompt().view, busy: true });
    hook.rerender({ view: asked.view, busy: false });
    expect(act).toHaveBeenCalledExactlyOnceWith({ type: "choose", index: 1 });

    act.mockClear();
    hook.result.current(asked.reckoner.id, asked.view);
    hook.rerender({ view: main, busy: false });
    hook.rerender({ view: targetPrompt().view, busy: false });
    expect(act).not.toHaveBeenCalled();
  });

  it("forgets a refused play, so it answers no later cast", () => {
    const main = turnFive().view;
    const { act, hook } = follow(main);
    hook.result.current(targetPrompt().reckoner.id, main);
    hook.rerender({ view: main, busy: true });
    hook.rerender({ view: main, busy: false });
    hook.rerender({ view: targetPrompt().view, busy: false });
    expect(act).not.toHaveBeenCalled();
  });

  it("leaves a question that does not offer the target to the reader", () => {
    const main = turnFive().view;
    const { act, hook } = follow(main);
    hook.result.current("opponent", main);
    hook.rerender({ view: targetPrompt().view, busy: false });
    expect(act).not.toHaveBeenCalled();
  });
});
