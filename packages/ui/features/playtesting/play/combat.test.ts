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
  aimAttacker,
} from "./combat";
import {
  attackStep,
  blockStep,
  fourPlayer,
  fourPlayerAttack,
  fourPlayerCombat,
  respondStep,
  turnFive,
} from "./fixtures";

describe("phaseLine", () => {
  it("says whose turn and where in it", () => {
    const { view } = turnFive();
    expect(phaseLine(view)).toBe("Turn 5 · Your main phase");
    expect(
      phaseLine({ ...view, active: "opponent", turn: 6, phase: "combat", step: "blockers" }),
    ).toBe("Turn 6 · Opponent's turn · Declare blockers step");
    // No step where nobody gets priority (the end of combat): the phase names it.
    expect(phaseLine({ ...view, active: "opponent", turn: 6, phase: "combat", step: null })).toBe(
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
    expect(stageButtons(view, toggleAttacker(NO_PICKS, view, goyf.id)).primary).toEqual({
      label: "Attack with 1",
      action: {
        type: "attack",
        attacks: [{ attacker: goyf.id, target: null, player: "opponent" }],
      },
    });
  });

  it("passes once or passes the turn when responding, and says when it is passing", () => {
    const { view } = respondStep();
    expect(stageButtons(view, NO_PICKS)).toEqual({
      primary: { label: "Pass", action: { type: "pass" } },
      secondary: { label: "Pass turn", action: { type: "endTurn" } },
    });
    expect(stageButtons({ ...view, endingTurn: true }, NO_PICKS).secondary).toMatchObject({
      label: "Passing turn…",
      disabled: true,
    });
  });

  it("offers nothing in a replay frame", () => {
    expect(stageButtons({ ...turnFive().view, stage: "watching" }, NO_PICKS)).toEqual({
      primary: null,
      secondary: null,
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

describe("attacking", () => {
  it("attacks the opponent first, then re-aims at a planeswalker clicked", () => {
    const { view, goyf, jace } = attackStep();
    let picks = toggleAttacker(NO_PICKS, view, goyf.id);
    expect(picks).toEqual({
      ...NO_PICKS,
      attacks: [{ attacker: goyf.id, target: null, player: "opponent" }],
      aiming: goyf.id,
    });
    expect(tablePicks(view, picks).opponent).toEqual(new Set([jace.id]));
    picks = aimAttacker(picks, view, jace.id);
    expect(picks.attacks).toEqual([{ attacker: goyf.id, target: jace.id, player: null }]);
    expect(picks.aiming).toBeNull();
    // Clicked again it waits to be aimed; clicked a third time it is put back.
    picks = toggleAttacker(picks, view, goyf.id);
    expect(picks.aiming).toBe(goyf.id);
    picks = aimAttacker(picks, view, "opponent");
    expect(picks.attacks).toEqual([{ attacker: goyf.id, target: null, player: "opponent" }]);
    picks = toggleAttacker(toggleAttacker(picks, view, goyf.id), view, goyf.id);
    expect(picks).toEqual(NO_PICKS);
  });

  it("toggles an attacker with nothing to aim at in one click", () => {
    const { view, elves } = attackStep();
    const picks = toggleAttacker(NO_PICKS, view, elves.id);
    expect(picks.aiming).toBeNull();
    expect(toggleAttacker(picks, view, elves.id)).toEqual(NO_PICKS);
  });

  it("refuses a target the attacker cannot attack", () => {
    const { view, goyf, ragavan } = attackStep();
    const picks = toggleAttacker(NO_PICKS, view, goyf.id);
    expect(aimAttacker(picks, view, ragavan.id)).toBe(picks);
  });
});

describe("phaseLine when responding", () => {
  it("says the reader may respond", () => {
    expect(phaseLine(respondStep().view)).toBe(
      "Turn 6 · Opponent's turn · Upkeep — you may respond",
    );
  });
});

describe("a four-player table", () => {
  it("names whose turn it is by the opponent's number", () => {
    const { view } = fourPlayer();
    expect(phaseLine({ ...view, active: "opponent2", phase: "main1", step: "main1" })).toBe(
      "Turn 13 · Opponent 2's turn · Main phase",
    );
    expect(combatLine(fourPlayerCombat().view, NO_PICKS)).toBe("Opponent 2 attacks with 1");
  });

  it("attacks the first player an attacker can, and aims it at another by name", () => {
    const { view, goyf, elves } = fourPlayerAttack();
    let picks = toggleAttacker(NO_PICKS, view, elves.id);
    // Two players to choose from is a choice: it waits to be aimed.
    expect(picks.aiming).toBe(elves.id);
    expect(picks.attacks).toEqual([{ attacker: elves.id, target: null, player: "opponent" }]);
    picks = aimAttacker(picks, view, "opponent2");
    expect(picks.attacks).toEqual([{ attacker: elves.id, target: null, player: "opponent2" }]);
    // Opponent 3 is out: not a player it may attack.
    const goyfWaits = toggleAttacker(picks, view, goyf.id);
    expect(aimAttacker(goyfWaits, view, "opponent3")).toBe(goyfWaits);
  });

  it("keeps each opponent's marks and picks on their own table", () => {
    const { view, lurrus } = fourPlayerCombat();
    expect(tableMarks(view, NO_PICKS).opponent2.get(lurrus.id)).toEqual({
      tone: "attack",
      word: "attacking",
    });
    expect(tableMarks(view, NO_PICKS).opponent.size).toBe(0);
    const attack = fourPlayerAttack();
    const picks = toggleAttacker(NO_PICKS, attack.view, attack.goyf.id);
    expect(tablePicks(attack.view, picks).opponent).toEqual(new Set([attack.jace.id]));
    expect(tablePicks(attack.view, picks).opponent2.size).toBe(0);
  });
});
