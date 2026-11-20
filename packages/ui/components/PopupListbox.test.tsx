import { createRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PopupPanel } from "./PopupListbox";

describe("PopupPanel", () => {
  it("hands its ref the panel's own element", () => {
    // What `usePopupPlacement` measures. With no node here `measure()` returns before it places
    // anything, and the panel keeps `invisible` at 0,0 — an open listbox nobody can see.
    const ref = createRef<HTMLDivElement>();
    const { getByText } = render(
      <PopupPanel ref={ref} className="panel">
        <span>rows</span>
      </PopupPanel>,
    );
    expect(ref.current).toBe(getByText("rows").parentElement);
    expect(ref.current).toHaveClass("panel");
  });

  /**
   * **A fence, and the one thing in this suite that is about a React this suite does not run.**
   *
   * The app is React 19, where a function component reads `ref` out of its props and the test
   * above passes either way. The design system's bundle (`.design-sync/`) runs this same module
   * on the page's React 18.3.1, which hands a function component no `ref` at all — so as a plain
   * prop the panel's ref was `null` there and every `Dropdown` on a design canvas opened
   * invisibly. `forwardRef` is the spelling both Reacts honour, and nothing but this assertion
   * goes red when it is tidied back into a prop.
   */
  it("is a forwardRef, which is what React 18 needs to hand it one", () => {
    expect((PopupPanel as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.forward_ref"));
  });
});
