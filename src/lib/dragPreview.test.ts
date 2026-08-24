import { afterEach, describe, expect, it, vi } from "vitest";
import { cardCountLabel, setCardCountPreview } from "./dragPreview";

/**
 * The count chip a multi-card drag carries — issue #214.
 *
 * What can be checked here is the **decision** and the words: whether a chip is drawn at all, and
 * what it says. What it looks like cannot be — jsdom has no layout engine, and the chip is
 * rendered into a container the library appends to `document.body` for a single frame so the
 * browser can photograph it. That frame is the live pass's to look at.
 */
afterEach(() => {
  // The library appends its container to the body and removes it on `dragstart`/`drop`, neither
  // of which happens here — so each call leaves one behind.
  document.body.innerHTML = "";
});

describe("cardCountLabel", () => {
  it("pluralises", () => {
    expect(cardCountLabel(1)).toBe("1 card");
    expect(cardCountLabel(4)).toBe("4 cards");
  });
});

describe("setCardCountPreview", () => {
  /**
   * **A single-card drag keeps the native preview**, which is a picture of the card and better
   * than any chip could be. Declining is not calling `nativeSetDragImage` at all, which is the
   * documented way to leave the browser's own ghost alone.
   */
  it("draws nothing for a drag carrying one card", () => {
    const native = vi.fn();
    setCardCountPreview(1, native);
    expect(native).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");
  });

  it("draws nothing for a drag carrying none", () => {
    const native = vi.fn();
    setCardCountPreview(0, native);
    expect(native).not.toHaveBeenCalled();
  });

  it("renders the count for a group", () => {
    setCardCountPreview(3, vi.fn());
    expect(document.body.textContent).toContain("3 cards");
  });
});
