import { describe, expect, it } from "vitest";
import {
  EMPTY_CALC,
  calcDisplay,
  calcResult,
  evaluate,
  pressKey,
  type CalcKey,
  type CalcState,
  type CalcTarget,
} from "./calculator";
import { LIFE_MAX, LIFE_MIN, grouped, humanize } from "./lifeNumber";

const life = (base: bigint): CalcTarget => ({ base, least: LIFE_MIN, most: LIFE_MAX });
const damage = (base: bigint): CalcTarget => ({ base, least: 0n, most: 999n });

/** Press each key in turn, from a fresh calculator over `target`. */
function type(keys: string, target: CalcTarget = life(40n)): CalcState {
  let state = EMPTY_CALC;
  for (const key of keys.split(" ")) state = pressKey(state, key as CalcKey, target);
  return state;
}

const shown = (state: CalcState, target: CalcTarget = life(40n)) =>
  calcDisplay(state, target, grouped, (v) => humanize(v).text);

describe("evaluate", () => {
  it("multiplies before it adds", () => {
    expect(evaluate(["2", "+", "3", "×", "4"])).toEqual({ value: 14n, rounded: false });
  });

  it("works brackets first", () => {
    expect(evaluate(["(", "2", "+", "3", ")", "×", "4"])).toEqual({ value: 20n, rounded: false });
  });

  it("rounds a division down, and says so", () => {
    expect(evaluate(["31", "÷", "2"])).toEqual({ value: 15n, rounded: true });
    // Down, not towards zero.
    expect(evaluate(["−", "(", "31", ")", "÷", "2"])).toEqual({ value: -16n, rounded: true });
    expect(evaluate(["30", "÷", "2"])).toEqual({ value: 15n, rounded: false });
  });

  it("refuses to divide by zero", () => {
    expect(evaluate(["5", "÷", "0"])).toEqual({ zero: true });
    expect(evaluate(["5", "÷", "(", "2", "−", "2", ")"])).toEqual({ zero: true });
  });

  it("reads a sum still being typed as far as it goes", () => {
    // A trailing sign is left off, an open bracket is closed.
    expect(evaluate(["2", "+"])).toEqual({ value: 2n, rounded: false });
    expect(evaluate(["(", "2", "+", "3"])).toEqual({ value: 5n, rounded: false });
    expect(evaluate(["2", "×", "(", "(", "1", "+", "1"])).toEqual({ value: 4n, rounded: false });
    expect(evaluate([])).toBeNull();
    expect(evaluate(["("])).toBeNull();
  });
});

describe("pressKey", () => {
  it("works 2 + 3 × 4 out to 14", () => {
    expect(shown(type("2 + 3 × 4")).result).toBe(14n);
  });

  it("works (2 + 3) × 4 out to 20", () => {
    expect(shown(type("( 2 + 3 ) × 4")).result).toBe(20n);
  });

  it("starts a sum from the current total when a sign comes first", () => {
    const state = type("− 5");
    expect(state.tokens).toEqual(["40", "−", "5"]);
    expect(shown(state).result).toBe(35n);
  });

  it("takes a number typed on its own as the new total", () => {
    const state = type("2 5");
    expect(shown(state).result).toBe(25n);
    expect(shown(state).line).toBe("Was 40");
  });

  it("rounds 31 ÷ 2 down to 15, and says so", () => {
    const view = shown(type("3 1 ÷ 2"));
    expect(view.result).toBe(15n);
    expect(view.line).toBe("= 15 (rounded down)");
  });

  it("refuses a division by zero, and sets nothing", () => {
    const view = shown(type("8 ÷ 0"));
    expect(view.result).toBeNull();
    expect(view.line).toBe("Cannot divide by 0");
    expect(view.applyLabel).toBe("Done");
  });

  it("puts an implicit × before a bracket, and after one", () => {
    expect(type("2 ( 3 )").tokens).toEqual(["2", "×", "(", "3", ")"]);
    expect(type("( 3 ) 2").tokens).toEqual(["(", "3", ")", "×", "2"]);
    expect(shown(type("2 ( 3 )")).result).toBe(6n);
  });

  it("closes brackets left open", () => {
    expect(shown(type("( ( 2 + 3")).result).toBe(5n);
    // A close with nothing open, or straight after a sign, is ignored.
    expect(type("2 )").tokens).toEqual(["2"]);
    expect(type("( 2 + )").tokens).toEqual(["(", "2", "+"]);
  });

  it("replaces a sign with the next sign, but keeps a bracket's leading minus", () => {
    expect(type("2 + ×").tokens).toEqual(["2", "×"]);
    expect(type("( −").tokens).toEqual(["(", "−"]);
    expect(type("( − +").tokens).toEqual(["(", "−"]);
    // Only a minus opens a bracket.
    expect(type("( ×").tokens).toEqual(["("]);
  });

  it("carries on from = with a sign, and starts again with anything else", () => {
    const answered = type("2 + 3 =");
    expect(answered).toEqual({ tokens: ["5"], done: true });
    expect(pressKey(answered, "×", life(40n)).tokens).toEqual(["5", "×"]);
    expect(pressKey(answered, "7", life(40n)).tokens).toEqual(["7"]);
    expect(pressKey(answered, "del", life(40n)).tokens).toEqual([]);
  });

  it("deletes a digit, then a token", () => {
    expect(type("1 2 del").tokens).toEqual(["1"]);
    expect(type("1 2 + del").tokens).toEqual(["12"]);
    expect(type("1 del").tokens).toEqual([]);
    expect(type("4 + 2 C").tokens).toEqual([]);
  });

  it("drops leading zeros and stops at nineteen digits", () => {
    expect(type("0 0 7").tokens).toEqual(["7"]);
    expect(type("00").tokens).toEqual(["0"]);
    const long = type(Array.from({ length: 25 }, () => "9").join(" "));
    expect(long.tokens[0]).toHaveLength(19);
  });

  it("holds an answer to what the figure can be", () => {
    expect(calcResult(type("9 9 9 9 × 9 9 9 9", damage(0n)), damage(0n))).toBe(999n);
    expect(calcResult(type("− 5 0", damage(10n)), damage(10n))).toBe(0n);
    expect(calcResult(type("9 9 9 9 9 9 9 9 9 9 × 9 9 9 9 9 9 9 9 9 9"), life(40n))).toBe(LIFE_MAX);
  });
});

describe("calcDisplay", () => {
  it("shows the current figure and a hint before anything is typed", () => {
    const view = shown(EMPTY_CALC, life(1234n));
    expect(view).toMatchObject({
      touched: false,
      value: "1,234",
      line: "Type a total, or start with + − × ÷",
      applyLabel: "Done",
    });
  });

  it("spaces the signs, not the brackets", () => {
    expect(shown(type("( − 2 + 3 ) × 2")).value).toBe("(−2 + 3) × 2");
  });

  it("holds the sign the sum is waiting on", () => {
    expect(shown(type("2 +")).op).toBe("+");
    expect(shown(type("( −")).op).toBeNull();
  });

  it("names what Set sets, short when the figure is long", () => {
    expect(shown(type("− 5")).applyLabel).toBe("Set to 35");
    expect(shown(type("1 0 0 0 0 0 0 0 0 0 0")).applyLabel).toBe("Set to 10.0b");
    expect(shown(type("4 0")).applyLabel).toBe("Done");
  });
});
