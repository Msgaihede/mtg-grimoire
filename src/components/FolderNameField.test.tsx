import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NOT_A_DRAG } from "@/features/decks/dnd";
import { FolderNameField, useFolderFieldReturn } from "./FolderNameField";

/**
 * The props every case needs, with fresh spies each call — a shared `vi.fn()` at module scope
 * carries one case's calls into the next, and every `toHaveBeenCalledTimes` in the file then
 * passes or fails by the order vitest happened to run them in.
 */
function stubs() {
  return { pending: false, onSubmit: vi.fn(), onCancel: vi.fn() };
}

/** The create shape, as both pages draw it: no `initial`, no `footer`. */
function creating(props: ReturnType<typeof stubs>, over: Partial<{ pending: boolean }> = {}) {
  return (
    <FolderNameField
      mode="create"
      label="New folder name"
      submitLabel="Create folder"
      {...props}
      {...over}
    />
  );
}

/** The rename shape, opening on a name and keeping the drawer's figures line under it. */
function renaming(
  props: ReturnType<typeof stubs>,
  over: Partial<{ pending: boolean; initial: string }> = {},
) {
  return (
    <FolderNameField
      mode="rename"
      label="Rename Trade binder"
      initial="Trade binder"
      submitLabel="Rename folder"
      footer={<span>240 cards · $1,304.00</span>}
      {...props}
      {...over}
    />
  );
}

describe("FolderNameField", () => {
  /**
   * **Both calls, and jsdom is the only place the missing one is visible.** The spec says
   * `select()` sets the selection and nothing else, and jsdom implements exactly that — but every
   * browser *also* focuses the control it is called on, so a `select()` with no `focus()` beside
   * it works perfectly in the shipped window and in Storybook. A past session lost a session to
   * that combination.
   *
   * The selection is the other half of the promise a rename makes: the commonest rename replaces
   * the word rather than edits inside it, so the field opens with the name taken. Without
   * `select()` the caret sits at the end of the value — that is what setting an `<input>`'s value
   * does, in jsdom and in a browser alike — which is a working field that quietly costs the reader
   * a Ctrl+A they did not know they owed.
   */
  it("takes the caret on mount with the name already selected", () => {
    render(renaming(stubs()));

    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Rename Trade binder" });
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Trade binder".length);
  });

  /**
   * **A folder with no name is not a folder, and a folder called `"   "` is worse** — it draws as
   * an empty tile a reader cannot tell from a broken one, and it sorts and matches as something no
   * search box can type. The tick is the only thing standing between the two, and the guard is
   * `trim()`: a `!name` test lets the whitespace case straight through while looking correct.
   *
   * A real `disabled`, deliberately, against the app's standing `aria-disabled` rule. That rule is
   * about controls that grey as the reader types *and still have something to say*; this is a
   * submit whose whole meaning is the field beside it, and leaving it in the tab order buys a stop
   * that can only ever do nothing.
   */
  it("refuses to submit an empty or whitespace-only name", async () => {
    const user = userEvent.setup();
    const props = stubs();
    render(creating(props));

    const tick = screen.getByRole("button", { name: "Create folder" });
    expect(tick).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "   ");
    expect(tick).toBeDisabled();

    // And Enter cannot get past it either — the guard is in the submit handler as well as on the
    // button, because implicit submission does not ask the tick's permission.
    await user.keyboard("{Enter}");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  /**
   * The name reaches the caller **trimmed**, so a reader who types a trailing space has made
   * `Trade binder` rather than a folder whose stored name disagrees with what is drawn beside it.
   * `onSubmit(name)` instead of `onSubmit(trimmed)` is a one-word slip that leaves every other
   * assertion in this file green.
   */
  it("hands over the trimmed name", async () => {
    const user = userEvent.setup();
    const props = stubs();
    render(creating(props));

    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "  Trade binder  ");
    await user.click(screen.getByRole("button", { name: "Create folder" }));

    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).toHaveBeenCalledWith("Trade binder");
  });

  /**
   * **`pending` does two jobs and the second one is the one that is easy to drop.** Greying the
   * tick while the write is in flight is the obvious half. The other is that it suspends the blur
   * discard — because a control that disables itself on the press is blurred **by the browser**
   * with no `relatedTarget` at all, which the guard below would otherwise read as the reader
   * looking away and would answer by cancelling the write it had just started.
   *
   * Driven at a real control outside the form, which is the reader's version of the same event.
   */
  it("greys the tick and stops discarding while the write is in flight", async () => {
    const user = userEvent.setup();
    const props = stubs();
    render(
      <>
        {renaming(props, { pending: true })}
        <button type="button">Elsewhere</button>
      </>,
    );

    // A full name, so `!trimmed` cannot be what disabled it.
    expect(screen.getByRole("button", { name: "Rename folder" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  /**
   * **The blur guard asks about the whole form, not about the input.** Both corner controls are
   * outside the box the input sits in, so a guard written against the input — or against the box —
   * cancels the field the moment the reader reaches for the tick, and the press that was meant is
   * delivered to a form that has already gone.
   *
   * Both directions in one case, because either alone passes for the wrong reason: a guard that
   * never cancels satisfies the first half, and one that always cancels satisfies the second.
   */
  it("survives a blur onto its own controls and discards on one that leaves", async () => {
    const user = userEvent.setup();
    const props = stubs();
    render(
      <>
        {creating(props)}
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "Trade binder");
    // Tab, not a click: it is the route with no pointer press to confuse the result, and it lands
    // on the tick, which is a sibling of the box rather than a descendant of it.
    await user.tab();
    expect(screen.getByRole("button", { name: "Create folder" })).toHaveFocus();
    expect(props.onCancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  /**
   * **`data-no-drag` is what stops a rename gesture picking the folder up**, and on the rename
   * shape it is load-bearing: the `<li>` under this form is a folder drag source, so without the
   * mark, pressing into the field and moving five pixels files the folder somewhere instead of
   * placing the caret — and the press that was meant is never delivered at all.
   *
   * Asserted through `NOT_A_DRAG` itself with `closest()`, which is the question
   * `PointerSensor.preventActivation` actually asks (`lib/dndManager.ts`), rather than through the
   * attribute alone: the selector is the contract and a mark spelled `data-nodrag` would satisfy
   * an attribute check and answer `null` here.
   *
   * The **tick** is the element that proves it, not the input: `NOT_A_DRAG` excludes fields by tag
   * already, so an input would match itself and pass with the form's mark removed. A button is
   * covered by nothing but the mark on the root.
   */
  it("marks the whole form as not-a-drag, so its buttons are covered too", () => {
    const { container } = render(renaming(stubs()));

    const form = container.querySelector("form");
    expect(form).toHaveAttribute("data-no-drag");

    const tick = screen.getByRole("button", { name: "Rename folder" });
    expect(tick.closest(NOT_A_DRAG)).toBe(form);
    expect(screen.getByRole("button", { name: "Cancel" }).closest(NOT_A_DRAG)).toBe(form);
  });

  /**
   * **The border is the whole of what tells the two shapes apart, and it is the app's own
   * vocabulary rather than decoration.** A dashed edge means *provisional — a container rather
   * than a thing you own*: a folder being renamed is still a container, so the dash stays; a
   * naming tile is a control standing among things you open and holds no folder yet, so it is
   * solid. Dressing the create shape in the dash to make the wall look uniform would spend the one
   * word the wall has for "container" on a control.
   *
   * `classList.contains`, never `className.includes` — a substring check is satisfied by
   * `border-dashed` appearing inside any longer class name and by a `hover:` variant that has not
   * fired.
   */
  it("is solid when it makes a folder and dashed when it renames one", () => {
    const create = render(creating(stubs()));
    const createBox = create.container.querySelector("form")?.firstElementChild;
    expect(createBox?.classList.contains("border")).toBe(true);
    expect(createBox?.classList.contains("border-dashed")).toBe(false);
    create.unmount();

    const rename = render(renaming(stubs()));
    const renameBox = rename.container.querySelector("form")?.firstElementChild;
    expect(renameBox?.classList.contains("border-dashed")).toBe(true);

    // Both wear the accent edge, which is the whole of what says *this tile is live*.
    expect(createBox?.classList.contains("border-accent")).toBe(true);
    expect(renameBox?.classList.contains("border-accent")).toBe(true);
  });

  /**
   * **Three geometry classes, none of them visible to jsdom, and each one a silent failure.** The
   * house rule is that a height or an offset can only be pinned as the classes that produce it —
   * so this is where they are held, with the measurements in the component's own doc.
   *
   * - **`pr-[4.125rem]` is the room the corner pair needs**, as the box's own right padding:
   *   `right-1` + 28px + a 2px gap + 28px, and four more so a long name stops short of the tick
   *   rather than running underneath it. It is a literal because Tailwind scans source text for
   *   whole class names and a value built by arithmetic emits no rule at all — which is the worst
   *   version of this defect, since the source still reads correctly.
   * - **The pair is `absolute`**, and that is the half of a two-class pair whose other half
   *   (`relative` on the host `<li>`) lives in `NewFolderCard.test.tsx`. Either alone is a bug: no
   *   `absolute` puts the ✓ and the ✕ in the flow underneath the name, and no `relative` sends
   *   them to whatever ancestor happens to be positioned.
   * - **`h-full` belongs to the create shape alone.** It is the tile's own `h-full` reaching
   *   through — the `<li>` is the grid item and stretches to the tallest card in its row, so a
   *   naming tile sized only by its floor would shrink the moment it opened beside a card with a
   *   wrapped name. A rename must *not* have it: a folder card's button is content-height, so a
   *   field that stretched would be taller than the card it replaced.
   */
  it("keeps a name clear of the corner pair, and stretches only when it is a tile", () => {
    const create = render(creating(stubs()));
    const createForm = create.container.querySelector("form");
    expect(createForm?.classList.contains("h-full")).toBe(true);
    expect(createForm?.firstElementChild?.classList.contains("pr-[4.125rem]")).toBe(true);
    expect(create.container.querySelector(".absolute.right-1.top-1")).not.toBeNull();
    create.unmount();

    const rename = render(renaming(stubs()));
    const renameForm = rename.container.querySelector("form");
    expect(renameForm?.classList.contains("h-full")).toBe(false);
    expect(renameForm?.firstElementChild?.classList.contains("pr-[4.125rem]")).toBe(true);
    expect(rename.container.querySelector(".absolute.right-1.top-1")).not.toBeNull();
  });

  /**
   * **The figures line stays under a rename and has nothing to say on a create.** It is how a
   * reader checks they are renaming the drawer they meant — 240 cards is what tells `Trade binder`
   * from the empty one they made yesterday — and a folder that does not exist yet has no figures
   * to draw, so the create shape ignores the slot rather than reserving room for it.
   *
   * The create half is the assertion worth having: a `{footer}` tidied into the shared part of the
   * render would grow the naming tile past a folder card's footprint the moment any caller passed
   * one, which is the reflow this whole arrangement promises not to do.
   */
  it("draws the footer when renaming and never when creating", () => {
    const rename = render(renaming(stubs()));
    expect(screen.getByText("240 cards · $1,304.00")).toBeInTheDocument();
    rename.unmount();

    render(
      <FolderNameField
        mode="create"
        label="New folder name"
        submitLabel="Create folder"
        footer={<span>240 cards · $1,304.00</span>}
        {...stubs()}
      />,
    );
    expect(screen.queryByText("240 cards · $1,304.00")).not.toBeInTheDocument();
  });

  /**
   * **Escape belongs to the page, and a handler here would be a second one for the same rung.**
   * The field is one arm of the page's `Panel`, so `useDismissOnEscape({ layer: "inner" })` closes
   * it already — and that hook listens on `window` in the **capture** phase, so anything written
   * here could never run first anyway. What it could do is run *as well*, or stop the press
   * propagating and starve the layer stack below it, which is the failure the two stacks exist to
   * prevent. So the absence is the design, and this is where it is held.
   */
  it("leaves Escape to the page's dismiss rung", async () => {
    const user = userEvent.setup();
    const props = stubs();
    render(creating(props));

    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "Half a name");
    await user.keyboard("{Escape}");

    expect(props.onCancel).not.toHaveBeenCalled();
  });
});

/**
 * The host's half of the arrangement: the field replaces a control, so when the field closes the
 * control React renders in its place is a **new** element and only the host is holding a ref to
 * it.
 */
function ReturnHarness({ open }: { open: boolean }) {
  const ref = useFolderFieldReturn<HTMLButtonElement>(open);
  return (
    <>
      {open ? (
        <input aria-label="New folder name" />
      ) : (
        <button ref={ref} type="button">
          New folder
        </button>
      )}
      <button type="button">Elsewhere</button>
    </>
  );
}

describe("useFolderFieldReturn", () => {
  /**
   * **A wall of ten folder cards mounts ten of these, and none of them may take the caret.** The
   * hook latches the previous value in a ref precisely so a first render with `open: false` is not
   * read as a close — drop that latch and every navigation into a folder ends with the last card
   * in the wall stealing focus from wherever the reader actually was.
   */
  it("does nothing on a mount that never opened", () => {
    render(<ReturnHarness open={false} />);

    expect(screen.getByRole("button", { name: "New folder" })).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  /**
   * **The state a close actually leaves behind.** React removes the focused input in the commit's
   * mutation phase and jsdom drops the caret to `<body>` — which is also what Escape, the ✕ and a
   * committed write each leave — so the hook's effect finds `document.body` and puts the caret on
   * the control that took the field's place.
   *
   * That is worth doing rather than leaving alone, because focus on `<body>` restarts the next Tab
   * from the top of the app: the tile the reader was just typing in is a better place to resume
   * from than the window's first control.
   */
  it("returns the caret to the control that replaced the field", () => {
    const { rerender } = render(<ReturnHarness open />);
    const input = screen.getByRole("textbox", { name: "New folder name" });
    act(() => input.focus());

    rerender(<ReturnHarness open={false} />);

    expect(screen.getByRole("button", { name: "New folder" })).toHaveFocus();
  });

  /**
   * **The case the `document.body` test exists for, and the one a naive `ref.current?.focus()`
   * gets wrong.** An outside click does not hand focus back anywhere in this app — the reader is
   * already somewhere else, and yanking the caret out of the control they just pressed is worse
   * than doing nothing at all. A blur-driven close is exactly that shape: the click that closed
   * the field is also the click that focused something.
   *
   * Staged with the caret on a sibling rather than with a click, so the assertion is about the
   * hook's guard and not about which element `userEvent` decided to focus.
   */
  it("leaves the caret alone when something else has already taken it", () => {
    const { rerender } = render(<ReturnHarness open />);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    act(() => elsewhere.focus());

    rerender(<ReturnHarness open={false} />);

    expect(elsewhere).toHaveFocus();
    expect(screen.getByRole("button", { name: "New folder" })).not.toHaveFocus();
  });
});
