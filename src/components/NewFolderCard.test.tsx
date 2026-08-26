import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewFolderCard } from "./NewFolderCard";

describe("NewFolderCard", () => {
  /**
   * The tile is dropped straight into the wall's existing `<ul aria-label="Folders">`, beside the
   * `<li>`s the folder cards draw — so an `<li>` root is the contract rather than a detail. A
   * `<div>` there is invalid markup that renders perfectly well and quietly costs the list its
   * count, which is the announcement a screen reader uses to say how many drawers there are.
   *
   * "Exactly one button" is the other half: the folder cards carry a second, the `⋯` trigger, and
   * a copy of one of them that kept its corner control would give this tile a menu over a folder
   * that does not exist yet.
   */
  it("draws an <li> holding exactly one button, so it is legal inside the wall's <ul>", () => {
    const { container } = render(<NewFolderCard onClick={vi.fn()} />);

    const root = container.firstElementChild;
    expect(root?.tagName).toBe("LI");
    expect(root?.querySelectorAll("button")).toHaveLength(1);
    // Inside a form a submit button is the default, and this tile is a long way from knowing
    // whether it is inside one.
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  /**
   * The accessible name is the visible label and nothing else — WCAG 2.5.3, and the rule the
   * folder cards depart from only because they have figures to say in words. There is nothing here
   * an `aria-label` could add, so an `aria-label` could only disagree with what is printed.
   */
  it("is named by the words it prints", () => {
    render(<NewFolderCard onClick={vi.fn()} />);

    const button = screen.getByRole("button", { name: "New folder" });
    expect(button).toHaveTextContent("New folder");
    expect(button).not.toHaveAttribute("aria-label");
  });

  /** A caller names the level in that level's own word — "New binder" over a cabinet. */
  it("honours a label of the caller's own", () => {
    render(<NewFolderCard onClick={vi.fn()} label="New binder" />);

    expect(screen.getByRole("button", { name: "New binder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New folder" })).not.toBeInTheDocument();
  });

  /**
   * **The button element itself, not the event.** Both callers open a naming panel anchored on the
   * trigger (`open({ kind: "newFolder", … }, opener)`) so the caret comes back to the tile the
   * reader pressed — and `currentTarget` is null by the time an async handler reads it off a
   * pooled-looking event, so the element has to be pulled out here and handed over.
   *
   * Asserted by **identity** against the queried button, because "was called with an HTMLElement"
   * would pass just as happily for the `<li>`, for `e.target` on a press that landed on the glyph,
   * or for `document.body`.
   */
  it("hands the click the button element itself, once per press", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<NewFolderCard onClick={onClick} />);

    const button = screen.getByRole("button", { name: "New folder" });
    await user.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(button);
    // Identity rather than a shape: `toHaveBeenCalledWith` compares structurally, and two
    // different elements in this tree can be structurally alike.
    expect(onClick.mock.calls[0]?.[0]).toBe(button);
  });

  /**
   * Cheap insurance against somebody turning this into a `<div>` with an `onClick` to get the
   * centring for free. A real `<button>` is in the tab order and answers both activation keys
   * without a handler; a div with `role="button"` answers neither, and the wall of folders around
   * it is reachable throughout, so the one tile that makes a folder would be the one thing on the
   * screen a keyboard could not reach.
   *
   * Driven the way a reader arrives — Tab, then the key — rather than through `element.focus()`,
   * which is a caret nobody can produce and which a past session found hides exactly this defect.
   */
  it("is reached by Tab and activated by Enter and by Space", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<NewFolderCard onClick={onClick} />);

    const button = screen.getByRole("button", { name: "New folder" });
    await user.tab();
    expect(button).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);

    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);

    expect(onClick).toHaveBeenNthCalledWith(1, button);
    expect(onClick).toHaveBeenNthCalledWith(2, button);
  });

  /**
   * **The whole visual claim of this component, and the one thing a later refactor would silently
   * undo** by copying the class list off the folder card standing next to it.
   *
   * A dashed edge means *provisional — a container rather than a thing you own* everywhere in this
   * app; a button is not a container at all, and the dash is a word the wall spends on exactly one
   * meaning. Nothing about a dashed border fails a render, a type check or any other test here, so
   * this is where it is held.
   *
   * `classList.contains`, never `className.includes`: the class list carries `hover:border-accent`
   * and a substring check against a `hover:` variant passes before any state has changed, which a
   * past session found makes the assertion vacuous.
   */
  it("is solid-bordered where every folder card beside it is dashed", () => {
    render(<NewFolderCard onClick={vi.fn()} />);

    const button = screen.getByRole("button", { name: "New folder" });
    expect(button.classList.contains("border-dashed")).toBe(false);
    expect(button.classList.contains("border")).toBe(true);
    expect(button.classList.contains("border-border")).toBe(true);
    // It keeps the wall's radius and the wall's hover, so the departure is the dash alone.
    expect(button.classList.contains("rounded-xl")).toBe(true);
    expect(button.classList.contains("hover:border-accent")).toBe(true);
  });

  /**
   * Two classes with one job between them, and neither is visible to jsdom — there is no layout
   * engine here, so a height can only be pinned as the classes that produce it. `h-full` is what
   * matches the tallest card in the row (the `<li>` is the grid item and stretches); the floor is
   * what holds the tile at a folder card's 62px when it is the only thing in an empty cabinet.
   * Both were driven in headless Chromium at the wall's real track — the component's own doc
   * carries the figures.
   */
  it("carries both halves of the folder-card footprint", () => {
    render(<NewFolderCard onClick={vi.fn()} />);

    const button = screen.getByRole("button", { name: "New folder" });
    expect(button.classList.contains("h-full")).toBe(true);
    expect(button.classList.contains("w-full")).toBe(true);
    expect(button.classList.contains("min-h-[calc(3.75rem+2px)]")).toBe(true);
  });
});
