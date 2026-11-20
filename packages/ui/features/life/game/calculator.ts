/**
 * The board's calculator: a held press on a panel opens it, and it sets a life total or one
 * commander's damage to a whole sum worked out the usual way — brackets first, then × and ÷, then
 * + and −, left to right.
 *
 * Pure: what is typed is a list of tokens (numbers, the four signs, the two brackets), each key is
 * a step from one {@link CalcState} to the next ({@link pressKey}), and {@link evaluate} reads a
 * list as far as it goes. The dialog only draws {@link calcDisplay}.
 *
 * **A number typed on its own is a new total; a sign first works from the current one** — `−5`
 * typed on a fresh calculator over 40 life is `40 − 5`, which is how a player says it ("I take
 * five"), and `25` is "I'm at 25". Life is whole numbers, so ÷ rounds down, and says so.
 */

/** The four signs, as the keys spell them. The minus is U+2212, as on the panels. */
export const SIGNS = ["+", "−", "×", "÷"] as const;
export type Sign = (typeof SIGNS)[number];

/** Every key, in the keypad's order: five across, the digits as on any calculator, the four
 *  signs in a column beside them, and delete, the brackets and = down the right-hand edge. */
export const KEYS = [
  "7",
  "8",
  "9",
  "÷",
  "del",
  "4",
  "5",
  "6",
  "×",
  "(",
  "1",
  "2",
  "3",
  "−",
  ")",
  "0",
  "00",
  "C",
  "+",
  "=",
] as const;
export type CalcKey = (typeof KEYS)[number];

/** What a screen reader says for a key that is not a digit. */
export const SPOKEN: Partial<Record<CalcKey, string>> = {
  del: "Delete the last entry",
  "−": "Subtract",
  "+": "Add",
  "×": "Multiply",
  "÷": "Divide",
  "(": "Open bracket",
  ")": "Close bracket",
  C: "Clear",
  "=": "Work it out",
};

export interface CalcState {
  tokens: string[];
  /** `=` was the last key: the answer stands alone, a sign carries on from it and anything else
   *  starts again. */
  done: boolean;
}

export const EMPTY_CALC: CalcState = { tokens: [], done: false };

/** Long enough for any sum a game calls for, short enough to stay on the display. */
const MOST_TOKENS = 40;
/** A typed number's digits — the 19 of the largest 64-bit integer. */
const MOST_DIGITS = 19;

export function isNumber(token: string | undefined): token is string {
  return token !== undefined && /^-?\d+$/.test(token);
}

function isSign(token: string | undefined): token is Sign {
  return token !== undefined && (SIGNS as readonly string[]).includes(token);
}

export type Worked = { value: bigint; rounded: boolean } | { zero: true };

/**
 * `{ value }` when the sum can be worked out, with `rounded` where a division did not come out
 * whole; `{ zero: true }` for a division by zero; `null` where there is nothing to work out yet.
 *
 * **A sum still being typed is read as far as it goes**: a trailing sign or open bracket is left
 * off, and brackets not yet closed are closed — so the line under the display can show
 * `= 14` while the reader is still typing, and Set works on what is there.
 */
export function evaluate(tokens: readonly string[]): Worked | null {
  const list = tokens.slice();
  while (list.length && !isNumber(list[list.length - 1]) && list[list.length - 1] !== ")") {
    list.pop();
  }
  if (!list.length) return null;
  let open = 0;
  for (const t of list) {
    if (t === "(") open += 1;
    if (t === ")") open -= 1;
  }
  for (; open > 0; open--) list.push(")");

  let at = 0;
  let bad = false;
  let zero = false;
  let rounded = false;

  const primary = (): bigint => {
    const t = list[at];
    if (t === "(") {
      at += 1;
      const inner = sum();
      if (list[at] === ")") at += 1;
      else bad = true;
      return inner;
    }
    if (t === "−") {
      at += 1;
      return -primary();
    }
    if (isNumber(t)) {
      at += 1;
      return BigInt(t);
    }
    bad = true;
    return 0n;
  };
  const product = (): bigint => {
    let left = primary();
    while (list[at] === "×" || list[at] === "÷") {
      const sign = list[at];
      at += 1;
      const right = primary();
      if (sign === "×") left = left * right;
      else if (right === 0n) zero = true;
      else {
        let whole = left / right;
        if (left % right !== 0n) {
          rounded = true;
          // A bigint division cuts towards zero; *down* is one further for a negative answer.
          if (left < 0n !== right < 0n) whole -= 1n;
        }
        left = whole;
      }
    }
    return left;
  };
  function sum(): bigint {
    let left = product();
    while (list[at] === "+" || list[at] === "−") {
      const sign = list[at];
      at += 1;
      const right = product();
      left = sign === "+" ? left + right : left - right;
    }
    return left;
  }

  const value = sum();
  if (zero) return { zero: true };
  if (bad || at < list.length) return null;
  return { value, rounded };
}

/** What the calculator is setting: its current figure and the bounds its answer is held to. */
export interface CalcTarget {
  base: bigint;
  least: bigint;
  most: bigint;
}

/**
 * What Set would set: the current figure while nothing is typed, `null` while the sum cannot be
 * worked out (or divides by zero — which sets nothing), and otherwise its answer held to what a
 * life total or a damage count can be.
 */
export function calcResult(state: CalcState, target: CalcTarget): bigint | null {
  if (!state.tokens.length) return target.base;
  const worked = evaluate(state.tokens);
  if (!worked || "zero" in worked) return null;
  return worked.value < target.least
    ? target.least
    : worked.value > target.most
      ? target.most
      : worked.value;
}

function openBrackets(tokens: readonly string[]): number {
  let open = 0;
  for (const t of tokens) {
    if (t === "(") open += 1;
    if (t === ")") open -= 1;
  }
  return open;
}

/** One key, from one state to the next. Nothing here can throw: a key with nowhere to go is
 *  ignored, which is a calculator's manners. */
export function pressKey(state: CalcState, key: CalcKey, target: CalcTarget): CalcState {
  let t = state.tokens.slice();
  let done = state.done;
  let last: string | undefined = t[t.length - 1];
  let number = isNumber(last);
  const restart = () => {
    t = [];
    done = false;
    last = undefined;
    number = false;
  };

  if (key === "C") {
    restart();
  } else if (key === "del") {
    if (done) restart();
    else if (number && last!.replace("-", "").length > 1) t[t.length - 1] = last!.slice(0, -1);
    else t.pop();
  } else if (isSign(key)) {
    if (!t.length) t.push(String(target.base), key);
    else if (number || last === ")") t.push(key);
    // Straight after an open bracket only a minus makes sense: (−5 + 2).
    else if (last === "(") {
      if (key === "−") t.push(key);
    }
    // A sign after a sign replaces it — except a bracket's leading minus, which stays.
    else if (t[t.length - 2] !== "(") t[t.length - 1] = key;
    done = false;
  } else if (key === "(") {
    if (done) restart();
    // `2(3)` is `2 × (3)`, as it is written on paper.
    if (number || last === ")") t.push("×");
    t.push("(");
  } else if (key === ")") {
    if (openBrackets(t) > 0 && (number || last === ")")) t.push(")");
  } else if (key === "=") {
    const answer = t.length > 1 ? calcResult({ tokens: t, done }, target) : null;
    if (answer !== null) {
      t = [String(answer)];
      done = true;
    }
  } else {
    // A digit, or 00.
    if (done) restart();
    if (last === ")") {
      t.push("×");
      number = false;
    }
    if (number) {
      const grown = (last + key).replace(/^0+(?=\d)/, "");
      if (grown.length <= MOST_DIGITS) t[t.length - 1] = grown;
    } else {
      t.push(key === "00" ? "0" : key);
    }
  }

  if (t.length > MOST_TOKENS) t = t.slice(0, MOST_TOKENS);
  return { tokens: t, done };
}

/** The calculator's figure as it reads: grouped, with a real minus. */
export type Spell = (value: bigint) => string;

/** Everything the dialog draws, worked out from the state. */
export interface CalcDisplay {
  /** Anything typed yet. */
  touched: boolean;
  /** The sum as it reads, or the current figure while nothing is typed. */
  value: string;
  /** The line under it: the answer so far, a hint, a refusal, or nothing. */
  line: string;
  /** `line` is an answer (`= 14`), drawn in gold, rather than small print. */
  lineIsAnswer: boolean;
  /** The sign the sum is waiting on the other side of, held down on the keypad. */
  op: Sign | null;
  /** What Set sets, or `null` when nothing can be set. */
  result: bigint | null;
  /** The apply button's words. */
  applyLabel: string;
}

/**
 * The display. A space either side of a sign, none inside a bracket and none after the minus that
 * leads a bracket; a sum too long for the display keeps its end in view.
 */
export function calcDisplay(
  state: CalcState,
  target: CalcTarget,
  spell: Spell,
  short: Spell,
): CalcDisplay {
  const { tokens } = state;
  const touched = tokens.length > 0;
  const result = calcResult(state, target);
  const worked = evaluate(tokens);
  // An answer worth showing under the sum: there is a sum, not just one number.
  const answer = tokens.length > 1 ? result : null;
  const pending = answer !== null;

  let value = "";
  tokens.forEach((token, at) => {
    const before = tokens[at - 1];
    if (isNumber(token)) value += spell(BigInt(token));
    else if (token === "(" || token === ")") value += token;
    else value += before === "(" ? token : ` ${token} `;
  });
  value = touched ? value.replace(/ $/, "") : spell(target.base);
  if (value.length > 33) value = `…${value.slice(value.length - 32)}`;

  const zero = worked !== null && "zero" in worked;
  const rounded = worked !== null && "rounded" in worked && worked.rounded;
  const line = zero
    ? "Cannot divide by 0"
    : pending
      ? `= ${spell(answer)}${rounded ? " (rounded down)" : ""}`
      : !touched
        ? "Type a total, or start with + − × ÷"
        : tokens.length === 1 && !state.done
          ? `Was ${spell(target.base)}`
          : "";

  const lastToken = tokens[tokens.length - 1];
  const op = isSign(lastToken) && tokens[tokens.length - 2] !== "(" ? lastToken : null;
  const applyLabel =
    touched && result !== null && result !== target.base
      ? `Set to ${spell(result).length > 11 ? short(result) : spell(result)}`
      : "Done";

  return { touched, value, line, lineIsAnswer: pending, op, result, applyLabel };
}
