import { describe, expect, it } from "vitest";
/**
 * The stylesheet as it ships. Read through Vite with `?raw`, exactly as `lib/motion.test.ts` and
 * `lib/tokens.test.ts` read the files they assert against — this project has no `@types/node`,
 * so `node:fs` is not available to a test and is not going to be.
 */
import css from "@/index.css?raw";
import { CARD_BODY_ATTR, keepsSelection, LANDED_MS } from "./cardControl";

/** The token the mark's fade is written as, and the duration inside it. */
const FADE = /--animate-card-landed:\s*card-landed\s+([\d.]+)(ms|s)\b/;

describe("the landed mark's five seconds", () => {
  /**
   * **Two files, one number, and nothing else would notice.**
   *
   * The stylesheet fades the mark over five seconds and {@link LANDED_MS} takes it out of the DOM
   * after five seconds, and the two are genuinely two consumers rather than a copy — there is no
   * expression that could compute one from the other, because a CSS animation cannot read a TS
   * constant and Tailwind emits no rule for an interpolated class.
   *
   * The failure they drift into is the quiet kind: shorten the CSS and every mark blinks out
   * early with a dead overlay left on the card; shorten the TS and the mark is torn off
   * mid-fade. Neither breaks anything, so nothing else here can go red for it.
   */
  it("fades in CSS for exactly as long as the mark lives in TypeScript", () => {
    const found = FADE.exec(css);
    expect(found, "--animate-card-landed is not in index.css").not.toBeNull();
    const [, value, unit] = found as RegExpExecArray;
    expect(Number(value) * (unit === "s" ? 1000 : 1)).toBe(LANDED_MS);
  });

  /** The token names a keyframe, and a keyframe that is not there animates nothing at all —
   *  silently, with the mark simply sitting at full strength until it is unmounted. */
  it("names a keyframe the stylesheet actually defines", () => {
    expect(css).toContain("@keyframes card-landed");
  });
});

describe("keepsSelection", () => {
  /** A leaf inside `wrapper`, which is what a click's target actually is — the glyph in a
   *  button, the truncated span in a row — so every case below asks the real question. */
  function leafIn(html: string): Element {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    const leaf = wrapper.querySelector("[data-leaf]");
    return leaf ?? wrapper;
  }

  it("keeps the selection for a click anywhere on a card's body", () => {
    expect(
      keepsSelection(leafIn(`<li ${CARD_BODY_ATTR}><span data-leaf>MH2 · 123</span></li>`)),
    ).toBe(true);
  });

  /** The stack card's data line and the grid tile's control bar are both outside the card's
   *  button, which is the whole reason the body attribute exists — but the button itself is
   *  the commonest target of all and must never end a selection either. */
  it("keeps the selection for a click on any control", () => {
    for (const html of [
      `<button><span data-leaf>Add</span></button>`,
      `<div role="row"><span data-leaf>Sol Ring</span></div>`,
      `<label><input data-leaf /></label>`,
      `<select data-leaf></select>`,
      `<div role="dialog"><p data-leaf>Categories</p></div>`,
    ]) {
      expect(keepsSelection(leafIn(html)), html).toBe(true);
    }
  });

  /** The desk: the gap between two piles, a group's padding, the blank under a short column.
   *  This is the one gesture the app has for putting a card down. */
  it("drops the selection for a click on the desk", () => {
    expect(keepsSelection(leafIn(`<section><span data-leaf>Ramp</span></section>`))).toBe(false);
  });

  /** No element to ask about — a synthetic event, or a target that is not an `Element` — reads
   *  as the desk. It is the safe answer of the two: the worst it costs is a selection the
   *  reader has to make again, where the other way round is a mark that cannot be dismissed. */
  it("treats a click with no element as a click on nothing", () => {
    expect(keepsSelection(null)).toBe(false);
  });
});
