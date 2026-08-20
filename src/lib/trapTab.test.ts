import { afterEach, describe, expect, it, vi } from "vitest";
import { trapTab } from "./trapTab";

/** A minimal stand-in for the `KeyboardEvent` `trapTab` reads — it never touches anything on
 *  the object but `key`, `shiftKey`, `currentTarget` and `preventDefault`. */
function press(
  panel: HTMLElement,
  opts: { shiftKey?: boolean } = {},
): ReturnType<typeof vi.fn> {
  const preventDefault = vi.fn();
  trapTab({
    key: "Tab",
    shiftKey: opts.shiftKey ?? false,
    currentTarget: panel,
    preventDefault,
  } as unknown as Parameters<typeof trapTab>[0]);
  return preventDefault;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("trapTab", () => {
  /**
   * The bug `DeckEditor.test.tsx`'s "keeps Tab inside Import cards" caught the day the import
   * dialog's destination radios landed beside a disabled Preview button: a naive `querySelectorAll`
   * counts both members of a named radio group as their own stop, so `last` could be the member
   * a real Tab press never lands on — and the wrap this file exists for then never runs.
   */
  it("treats a checked radio group as one stop, not one per button", () => {
    const panel = document.createElement("div");
    const before = document.createElement("button");
    const first = document.createElement("input");
    first.type = "radio";
    first.name = "mode";
    first.checked = true;
    const second = document.createElement("input");
    second.type = "radio";
    second.name = "mode";
    panel.append(before, first, second);
    document.body.append(panel);

    first.focus();
    expect(document.activeElement).toBe(first);

    // Forward Tab from the checked radio — the group's real stop — has to wrap straight back
    // to `before`. Before the fix, `last` was `second` (the unchecked member, literally last in
    // the DOM), so `at === last` never held here and nothing wrapped.
    const preventDefault = press(panel);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(before);
  });

  it("stops at the group's first member when none is checked", () => {
    const panel = document.createElement("div");
    const before = document.createElement("button");
    const first = document.createElement("input");
    first.type = "radio";
    first.name = "mode";
    const second = document.createElement("input");
    second.type = "radio";
    second.name = "mode";
    panel.append(before, first, second);
    document.body.append(panel);

    // Real Tab from `before`, with neither radio checked, lands on the group's first member —
    // never the second, which nobody's Tab press can reach.
    first.focus();
    const preventDefault = press(panel);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(before);
  });

  it("leaves an unnamed radio-typed input as its own stop", () => {
    // `name=""` cannot form a group — every `<input type="radio">` with no name is its own
    // island, exactly like any other control, so the grouping logic must not fold two of them
    // into one stop by accident.
    const panel = document.createElement("div");
    const alone = document.createElement("input");
    alone.type = "radio";
    const after = document.createElement("button");
    panel.append(alone, after);
    document.body.append(panel);

    after.focus();
    const preventDefault = press(panel);
    // `after` is the last stop and there is nothing past it — forward Tab wraps to the first.
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(alone);
  });
});
