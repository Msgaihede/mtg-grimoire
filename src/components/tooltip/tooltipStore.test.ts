import { describe, expect, it } from "vitest";
import { createTooltipStore } from "./tooltipStore";

const anchorOf = (id: string): HTMLElement => {
  const el = document.createElement("button");
  el.id = id;
  return el;
};

const shown = (anchor: HTMLElement) => ({
  anchor,
  content: "words",
  side: "top" as const,
  interactive: false,
  describes: true,
});

describe("the tooltip store", () => {
  it("holds the one tooltip that is open", () => {
    const store = createTooltipStore();
    expect(store.getState().open).toBeNull();
    const a = anchorOf("a");
    store.getState().show(shown(a));
    expect(store.getState().open?.anchor).toBe(a);
  });

  it("bumps openId per open, so the panel knows to measure again", () => {
    const store = createTooltipStore();
    store.getState().show(shown(anchorOf("a")));
    const first = store.getState().open?.openId;
    store.getState().show(shown(anchorOf("b")));
    expect(store.getState().open?.openId).toBe((first ?? 0) + 1);
  });

  it("closes whatever is open when the window asks", () => {
    const store = createTooltipStore();
    store.getState().show(shown(anchorOf("a")));
    store.getState().hideAny();
    expect(store.getState().open).toBeNull();
  });

  it("does not write when there is nothing open, so a scroll costs no render", () => {
    const store = createTooltipStore();
    let writes = 0;
    store.subscribe(() => {
      writes += 1;
    });
    store.getState().hideAny();
    expect(writes).toBe(0);
  });

  it("keeps counting across a close, so a reopened panel is never handed an id it has already measured", () => {
    const store = createTooltipStore();
    const a = anchorOf("a");
    store.getState().show(shown(a));
    store.getState().hideAny();
    store.getState().show(shown(a));
    expect(store.getState().open?.openId).toBe(2);
  });
});
