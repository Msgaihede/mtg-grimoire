import { describe, expect, it } from "vitest";
import {
  NO_PICKS,
  combatLine,
  phaseLine,
  pickAttacker,
  pickBlocker,
  stageButtons,
  tableMarks,
  tablePicks,
  toggleAttacker,
} from "./combat";
import { attackStep, blockStep, turnFive } from "./fixtures";

describe("phaseLine", () => {
  it("says whose turn and where in it", () => {
    const { view } = turnFive();
    expect(phaseLine(view)).toBe("Turn 5 · Your main phase");
    expect(phaseLine({ ...view, active: "opponent", turn: 6, phase: "combat" })).toBe(
      "Turn 6 · Opponent's turn · Combat",
    );
    expect(phaseLine({ ...view, turn: 0, stage: "mulligan" })).toBe("Opening hands");
  });
});

describe("stageButtons", () => {
  it("offers combat or the end of the turn in the first main phase", () => {
    const { primary, secondary } = stageButtons(turnFive().view, NO_PICKS);
    expect(primary).toEqual({ label: "To combat", action: { type: "pass" } });
    expect(secondary).toEqual({ label: "End turn", action: { type: "endTurn" } });
  });

  it("ends the turn from the second", () => {
    const { primary, secondary } = stageButtons({ ...turnFive().view, phase: "main2" }, NO_PICKS);
    expect(primary).toEqual({ label: "End turn", action: { type: "pass" } });
    expect(secondary).toBeNull();
  });

  it("counts the attackers picked", () => {
    const { view, goyf } = attackStep();
    expect(stageButtons(view, NO_PICKS).primary?.label).toBe("No attack");
    expect(stageButtons(view, toggleAttacker(NO_PICKS, goyf.id)).primary).toEqual({
      label: "Attack with 1",
      action: { type: "attack", attackers: [goyf.id] },
    });
  });

  it("confirms the blocks picked, or none", () => {
    const { view, goyf, ragavan } = blockStep();
    expect(stageButtons(view, NO_PICKS).primary?.label).toBe("No blocks");
    const blocks = [{ blocker: goyf.id, attacker: ragavan.id }];
    expect(stageButtons(view, { ...NO_PICKS, blocks }).primary).toEqual({
      label: "Confirm blocks",
      action: { type: "block", blocks },
    });
  });
});

describe("blocking", () => {
  it("picks a blocker, then the attacker it blocks; a second click takes it off", () => {
    const { view, goyf, ragavan } = blockStep();
    let picks = pickBlocker(NO_PICKS, goyf.id);
    expect(picks.chosen).toBe(goyf.id);
    expect(tablePicks(view, picks).opponent).toEqual(new Set([ragavan.id]));
    picks = pickAttacker(picks, view, ragavan.id);
    expect(picks).toEqual({ ...NO_PICKS, blocks: [{ blocker: goyf.id, attacker: ragavan.id }] });
    expect(combatLine(view, picks)).toBe("The opponent attacks with 1 · you block 1");
    picks = pickBlocker(picks, goyf.id);
    expect(picks).toEqual(NO_PICKS);
  });

  it("refuses an attacker the blocker cannot block", () => {
    const { view, goyf, reckoner } = blockStep();
    const picks = pickBlocker(NO_PICKS, goyf.id);
    expect(pickAttacker(picks, view, reckoner.id)).toBe(picks);
  });

  it("numbers each block on both creatures", () => {
    const { view, goyf, elves, ragavan } = blockStep();
    const marks = tableMarks(view, {
      ...NO_PICKS,
      blocks: [
        { blocker: goyf.id, attacker: ragavan.id },
        { blocker: elves.id, attacker: ragavan.id },
      ],
    });
    expect(marks.you.get(goyf.id)).toEqual({ tone: "block", badge: "1", word: "blocking 1" });
    expect(marks.you.get(elves.id)?.badge).toBe("2");
    expect(marks.opponent.get(ragavan.id)).toEqual({
      tone: "attack",
      badge: "1·2",
      word: "attacking, blocked 1 and 2",
    });
  });
});
