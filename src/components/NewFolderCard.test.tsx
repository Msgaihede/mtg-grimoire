import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewFolderCard } from "./NewFolderCard";

/**
 * Every prop the tile cannot be drawn without, so a case states only the one it is about.
 *
 * A **fresh** set per call rather than one object at module scope: `toHaveBeenCalledTimes(1)`
 * against a shared spy passes or fails by the order vitest happens to run the file in, which is
 * a green suite that means nothing.
 */
function stubs() {
  return {
    naming: false,
    pending: false,
    onClick: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
  };
}

describe("NewFolderCard", () => {
  /**
   * The tile is dropped straight into the wall's existing `<ul aria-label="Folders">`, beside the
   * `<li>`s the folder cards draw — so an `<li>` root is the contract rather than a detail. A
   * `<div>` there is invalid markup that renders perfectly well and quietly costs the list its
   * count, which is the announcement a screen reader uses to say how many drawers there are.
   *
   * "Exactly one button" is the other half **while the tile is at rest**: the folder cards carry a
   * second, the `⋯` trigger, and a copy of one of them that kept its corner control would give
   * this tile a menu over a folder that does not exist yet. (Naming, it has two of its own — the
   * ✓ and the ✕ — which is the case below.)
   *
   * `relative` is the third thing this root has to be, and it is the one that goes wrong silently:
   * the field's ✓ / ✕ pair is `absolute right-1 top-1`, so with no positioned ancestor here the
   * pair resolves against whatever box up the tree happens to be positioned — the page, at worst —
   * and lands nowhere near the tile. jsdom lays nothing out, so the class is the whole of what can
   * be held.
   */
  it("draws a positioned <li> holding exactly one button, so it is legal inside the wall's <ul>", () => {
    const { container } = render(<NewFolderCard {...stubs()} />);

    const root = container.firstElementChild;
    expect(root?.tagName).toBe("LI");
    expect(root?.classList.contains("relative")).toBe(true);
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
    render(<NewFolderCard {...stubs()} />);

    const button = screen.getByRole("button", { name: "New folder" });
    expect(button).toHaveTextContent("New folder");
    expect(button).not.toHaveAttribute("aria-label");
  });

  /** A caller names the level in that level's own word — "New binder" over a cabinet. */
  it("honours a label of the caller's own", () => {
    render(<NewFolderCard {...stubs()} label="New binder" />);

    expect(screen.getByRole("button", { name: "New binder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New folder" })).not.toBeInTheDocument();
  });

  /**
   * **The button element itself, not the event.** The press is what tells the page which tile to
   * open the field in, and `currentTarget` is null by the time an async handler reads it off a
   * pooled-looking event — so the element has to be pulled out here and handed over. The caret's
   * way back is `useFolderFieldReturn` now rather than this element (the trigger unmounts while
   * the field is open, so anything the page remembered is a detached node), but the element is
   * still what a caller wants for anything anchored on the press.
   *
   * Asserted by **identity** against the queried button, because "was called with an HTMLElement"
   * would pass just as happily for the `<li>`, for `e.target` on a press that landed on the glyph,
   * or for `document.body`.
   */
  it("hands the click the button element itself, once per press", async () => {
    const user = userEvent.setup();
    const props = stubs();
    render(<NewFolderCard {...props} />);

    const button = screen.getByRole("button", { name: "New folder" });
    await user.click(button);

    expect(props.onClick).toHaveBeenCalledTimes(1);
    expect(props.onClick).toHaveBeenCalledWith(button);
    // Identity rather than a shape: `toHaveBeenCalledWith` compares structurally, and two
    // different elements in this tree can be structurally alike.
    expect(props.onClick.mock.calls[0]?.[0]).toBe(button);
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
    const props = stubs();
    render(<NewFolderCard {...props} />);

    const button = screen.getByRole("button", { name: "New folder" });
    await user.tab();
    expect(button).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(props.onClick).toHaveBeenCalledTimes(1);

    await user.keyboard(" ");
    expect(props.onClick).toHaveBeenCalledTimes(2);

    expect(props.onClick).toHaveBeenNthCalledWith(1, button);
    expect(props.onClick).toHaveBeenNthCalledWith(2, button);
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
    render(<NewFolderCard {...stubs()} />);

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
   * Both were driven in headless Chromium at the wall's real track — `FolderNameField`'s doc
   * carries the figures, since `FOLDER_CARD_HEIGHT` moved there when the naming tile came to need
   * it too.
   *
   * The literal string rather than the imported constant, deliberately: an assertion that reads
   * its own constant agrees with whatever the constant becomes, which is three tests in this repo
   * that passed against the exact defect they were written for.
   */
  it("carries both halves of the folder-card footprint", () => {
    render(<NewFolderCard {...stubs()} />);

    const button = screen.getByRole("button", { name: "New folder" });
    expect(button.classList.contains("h-full")).toBe(true);
    expect(button.classList.contains("w-full")).toBe(true);
    expect(button.classList.contains("min-h-[calc(3.75rem+2px)]")).toBe(true);
  });

  /**
   * **The tile becomes the field — it does not open one beside itself.** That is the whole of what
   * changed on 2026-09-03, and the way it goes wrong is that the button stays put and the field
   * arrives *under* it, which reflows the wall on every press and is invisible to a test that only
   * asks whether an input turned up. So both halves are asserted: the button is gone, and the box
   * that replaced it still carries the folder-card floor, which is the only form the "nothing
   * reflows" promise takes in a runner with no layout engine.
   *
   * The caret is the third half. A field a reader has to click into before typing is a press they
   * did not know they owed, and the focus is set in an effect — so nothing about the markup would
   * be wrong if it were dropped.
   */
  it("replaces the button with a focused field, at the same footprint", () => {
    const { container } = render(<NewFolderCard {...stubs()} naming />);

    expect(screen.queryByRole("button", { name: "New folder" })).not.toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "New folder name" });
    expect(input).toHaveFocus();

    const box = container.querySelector("form")?.firstElementChild;
    expect(box?.classList.contains("min-h-[calc(3.75rem+2px)]")).toBe(true);
    expect(box?.classList.contains("h-full")).toBe(true);
  });

  /**
   * **The field's name is built from the tile's, so the two cannot drift.** A cabinet whose tile
   * says `New binder` and whose box announces itself as "New folder name" is one control telling a
   * screen reader two different things about the level it is on — and the derivation is a template
   * literal, which is exactly the kind of line a later edit rewrites to a constant without anyone
   * noticing the caller's word has stopped reaching it.
   */
  it("names the field after the tile's own label", () => {
    render(<NewFolderCard {...stubs()} naming label="New binder" />);

    expect(screen.getByRole("textbox", { name: "New binder name" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "New folder name" })).not.toBeInTheDocument();
  });

  /**
   * **Enter and the ✓ are one answer reached two ways, and they must stay one.** Enter is the
   * `<form>`'s own implicit submission rather than a `keydown` handler, so a tick moved outside
   * the form — or retyped as `type="button"` with an `onClick` — leaves the keyboard route working
   * and silently breaks the pointer one, or the reverse.
   *
   * The name arrives **trimmed**: a reader who types a trailing space has made a folder called
   * `Trade binder`, not one whose name sorts and matches differently from what is drawn.
   */
  it("submits the trimmed name on Enter and on the tick alike", async () => {
    const user = userEvent.setup();
    const props = stubs();
    render(<NewFolderCard {...props} naming />);

    const input = screen.getByRole("textbox", { name: "New folder name" });
    await user.type(input, "  Trade binder  ");
    await user.keyboard("{Enter}");

    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).toHaveBeenCalledWith("Trade binder");

    props.onSubmit.mockClear();
    await user.click(screen.getByRole("button", { name: "Create folder" }));

    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).toHaveBeenCalledWith("Trade binder");
    // The press on the tick moves the caret out of the input; the form's blur guard has to read
    // that as still-inside and not as the reader looking away.
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  /**
   * **`pending` has to reach the field, and a prop that stops being forwarded breaks nothing that
   * renders.** It is what holds the tile open rather than closing it optimistically, greys the
   * tick, and — the half nobody would notice missing — suspends the blur discard, so the browser's
   * relatedTarget-less blur off a control that has just disabled itself is not read as the reader
   * looking away from a write in flight.
   *
   * Asserted with a full name in the box, so `!trimmed` cannot be what greyed it.
   */
  it("passes the in-flight write down to the field", async () => {
    const user = userEvent.setup();
    const props = stubs();
    const { rerender } = render(<NewFolderCard {...props} naming />);

    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "Trade binder");
    expect(screen.getByRole("button", { name: "Create folder" })).toBeEnabled();

    rerender(<NewFolderCard {...props} naming pending />);
    expect(screen.getByRole("button", { name: "Create folder" })).toBeDisabled();
  });

  /** The ✕ is the deliberate way out, and it is the only one of the three corner answers that
   *  discards without asking. */
  it("cancels on the cross", async () => {
    const user = userEvent.setup();
    const props = stubs();
    render(<NewFolderCard {...props} naming />);

    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "Half a name");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  /**
   * **Looking away discards**, exactly as every other layer in this app discards its half-made
   * decision — a folder field left standing open in a wall the reader has walked away from is a
   * tile that is not a tile any more.
   *
   * Driven at a real control outside the tile rather than at `document.body`, because the guard is
   * `contains(relatedTarget)` and a blur with no `relatedTarget` at all is the *other* case (the
   * one `pending` exists to suspend, covered in `FolderNameField.test.tsx`).
   */
  it("discards the half-typed name when the caret leaves the tile", async () => {
    const user = userEvent.setup();
    const props = stubs();
    render(
      <>
        <NewFolderCard {...props} naming />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "Half a name");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));

    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  /**
   * **The caret comes back to the tile, and this is the one focus return the page cannot make.**
   * Every other layer in this app hands focus back through `dismiss`, which focuses the element it
   * remembered as the opener — and that works because the opener is still mounted behind the
   * layer. Here the opener *is* what the field replaced: by the time the page focuses it, it is a
   * detached node and the call is a silent no-op. So the tile takes its own ref through
   * `useFolderFieldReturn` and restores the caret itself.
   *
   * The precondition is produced by the close rather than staged: React removes the focused input
   * in the commit's mutation phase, jsdom drops the caret to `<body>`, and the hook's effect then
   * finds exactly the state it restores from. A reader who clicked *elsewhere* leaves something
   * else focused and keeps it — that half is `FolderNameField.test.tsx`'s, where the hook can be
   * driven without a rerender staging both at once.
   */
  it("hands the caret back to the tile when the field closes", () => {
    const props = stubs();
    const { rerender } = render(<NewFolderCard {...props} naming />);
    expect(screen.getByRole("textbox", { name: "New folder name" })).toHaveFocus();

    rerender(<NewFolderCard {...props} naming={false} />);

    expect(screen.getByRole("button", { name: "New folder" })).toHaveFocus();
  });
});
