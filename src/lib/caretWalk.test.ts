import { beforeEach, describe, expect, it } from "vitest";
import { consumeCaretNote, keepCaretForCard } from "@/lib/caretWalk";

/**
 * The note is module state, so every test starts by discarding whatever the last one left — with
 * a card id no test uses, which is the only way to clear it from outside.
 */
beforeEach(() => {
  consumeCaretNote("nothing-walked-to-this-id");
});

describe("the caret's walk note", () => {
  it("is unset until somebody walks", () => {
    expect(consumeCaretNote("card-a")).toBe(false);
  });

  it("answers for the card it was written about", () => {
    keepCaretForCard("card-a");
    expect(consumeCaretNote("card-a")).toBe(true);
  });

  /**
   * **The regression this file exists for.**
   *
   * `main.tsx` wraps the app in `React.StrictMode`, which invokes a mount effect **twice** in
   * development — and the reader of this note is a mount effect. The first spelling of it cleared
   * the note on every read, so the second invocation found nothing, took the caret for the card
   * pane, and the arrow walk was still exactly one card long on all three surfaces. It read as a
   * fix and was not; a release build, where StrictMode does not double-invoke, would have passed.
   */
  it("answers the same way however many times it is asked", () => {
    keepCaretForCard("card-a");
    expect(consumeCaretNote("card-a")).toBe(true);
    expect(consumeCaretNote("card-a")).toBe(true);
    expect(consumeCaretNote("card-a")).toBe(true);
  });

  /** A deliberate press on some other card is what discards a note nobody consumed. */
  it("is discarded by any other card", () => {
    keepCaretForCard("card-a");
    expect(consumeCaretNote("card-b")).toBe(false);
    expect(consumeCaretNote("card-a")).toBe(false);
  });

  it("keeps only the newest walk", () => {
    keepCaretForCard("card-a");
    keepCaretForCard("card-b");
    expect(consumeCaretNote("card-a")).toBe(false);
    expect(consumeCaretNote("card-b")).toBe(false);
  });
});
