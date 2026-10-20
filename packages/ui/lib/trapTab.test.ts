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

  it("does not group two radios that share no name", () => {
    // `name=""` cannot form a group — every `<input type="radio">` with no name is its own
    // island, exactly like any other control, so the grouping logic must not fold two of them
    // into one stop by accident. A single unnamed radio cannot tell that apart from a bug that
    // *does* fold empty names together, since removing the `el.name !== ""` guard would still
    // leave one radio as its own stop when there is only one — two are needed to cover it.
    const panel = document.createElement("div");
    const before = document.createElement("button");
    const a = document.createElement("input");
    a.type = "radio";
    const b = document.createElement("input");
    b.type = "radio";
    panel.append(before, a, b);
    document.body.append(panel);

    // `a` and `b` are both real stops here, so `b` — not `a` — is the panel's true last one.
    // Forward Tab from `a` is a step *within* the list, not the boundary the wrap has to catch,
    // and `trapTab` must leave it alone. Removing the guard would fold both into one stop keyed
    // on `""`, drop `b`, and make `a` read as `last` — wrapping here by mistake.
    a.focus();
    const preventDefault = press(panel);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(a);
  });

  /**
   * #1184: a `radioKeys` group is one stop by `tabIndex`, not by `name` — the checked
   * `role="radio"` button is `0` and its siblings `-1`. Counted as stops, the unchecked last
   * sibling became `last`, so forward Tab from the checked first one never wrapped and the caret
   * walked out of the modal.
   */
  it("skips roving tabIndex=-1 radio buttons, so the checked one can be last", () => {
    const panel = document.createElement("div");
    panel.tabIndex = -1;
    const before = document.createElement("button");
    const group = document.createElement("div");
    group.setAttribute("role", "radiogroup");
    const radios = ["7d", "30d", "all"].map((label, i) => {
      const radio = document.createElement("button");
      radio.setAttribute("role", "radio");
      radio.setAttribute("aria-checked", String(i === 0));
      radio.tabIndex = i === 0 ? 0 : -1;
      radio.textContent = label;
      return radio;
    });
    group.append(...radios);
    panel.append(before, group);
    document.body.append(panel);

    radios[0].focus();
    const preventDefault = press(panel);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(before);

    // And back: Shift+Tab from the first stop lands on the checked radio, not on `all`.
    press(panel, { shiftKey: true });
    expect(document.activeElement).toBe(radios[0]);
  });
});
