import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useIsPresent } from "motion/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

/**
 * The shell's own contract, tested away from any host.
 *
 * Kept in its own file rather than folded into `DeckSettingsDialog.test.tsx` for the reason
 * `DeckSettingsForm.test.tsx` is kept away from its hosts: this component reaches no backend, so
 * a suite that mounts it with **no `QueryClientProvider` and no `ipc` mock at all** is a
 * standing check that it never grows one. It would also be four suites' worth of duplication
 * otherwise — every dialog in the deck builder is this chrome, and none of them should be
 * re-asserting that Escape closes it.
 */

/** The dialog with the two callbacks a caller owns, and a body that is only a body. */
function open(props: Partial<React.ComponentProps<typeof Dialog>> = {}) {
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <Dialog
      open
      title="Deck settings"
      closeLabel="Close deck settings"
      width="w-[55rem]"
      onDismiss={onDismiss}
      onClose={onClose}
      {...props}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <button type="button">A control inside the body</button>
      </div>
    </Dialog>,
  );
  return { onDismiss, onClose, ...view };
}

/**
 * The panel, once its first frame has been painted over.
 *
 * A `motion` element's first painted frame carries its `initial`, so everything inside a freshly
 * opened overlay is invisible until the next one — which is why this waits rather than reading.
 */
async function panel() {
  const dialog = await screen.findByRole("dialog", { name: "Deck settings" });
  await waitFor(() => expect(dialog).toBeVisible());
  return dialog;
}

describe("Dialog", () => {
  /**
   * **Closed is nothing mounted**, and the second assertion is the one that matters: the body is
   * passed as an *element*, and an element React never puts in the tree is a component that never
   * ran. That is the property that lets the editor mount every one of its dialogs unconditionally
   * and pay for none of them — each body's queries are inside the `open &&`.
   */
  it("renders nothing and mounts no child while it is closed", () => {
    const mounted = vi.fn();
    function Body() {
      mounted();
      return <p>Reading the deck…</p>;
    }

    render(
      <Dialog
        open={false}
        title="Deck settings"
        closeLabel="Close deck settings"
        width="w-[55rem]"
        onDismiss={vi.fn()}
        onClose={vi.fn()}
      >
        <Body />
      </Dialog>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mounted).not.toHaveBeenCalled();
  });

  /** The `"inner"` rung: one press, one layer, and the caret hand-back is the caller's. */
  it("dismisses on Escape", async () => {
    const { onDismiss, onClose } = open();
    await panel();

    await userEvent.keyboard("{Escape}");

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * The rung comes up with the **flag**, not with the panel, so a closed dialog consumes no
   * press — which is what stops a dialog that has been dismissed but is still fading from eating
   * the Escape meant for the layer behind it.
   */
  it("consumes no Escape while it is closed", async () => {
    const onDismiss = vi.fn();
    render(
      <Dialog
        open={false}
        title="Deck settings"
        closeLabel="Close deck settings"
        width="w-[55rem]"
        onDismiss={onDismiss}
        onClose={vi.fn()}
      >
        <p>Reading the deck…</p>
      </Dialog>,
    );

    await userEvent.keyboard("{Escape}");

    expect(onDismiss).not.toHaveBeenCalled();
  });

  /**
   * A press on the scrim closes; a press on the panel does not.
   *
   * The `mouseDown`-with-target-check is the whole mechanism — a `click` handler would close the
   * dialog on a drag that started inside it and ended out here, because the click lands on the
   * two targets' common ancestor.
   */
  it("closes on a press on the scrim and not on one inside the panel", async () => {
    const { onClose, onDismiss } = open();
    const dialog = await panel();

    fireEvent.mouseDown(dialog);
    fireEvent.mouseDown(screen.getByRole("button", { name: "A control inside the body" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Closing is not dismissing: the reader who clicked elsewhere is already somewhere else.
    expect(onDismiss).not.toHaveBeenCalled();
  });

  /** The ✕ is the other half of the dismiss, and it is named by the host rather than by the
   *  title — "Close Categories & labels" is not a sentence. */
  it("dismisses on the close control, which carries the host's own label", async () => {
    const { onDismiss, onClose } = open({ closeLabel: "Close the deck's history" });
    await panel();

    await userEvent.click(screen.getByRole("button", { name: "Close the deck's history" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * `aria-modal` is a promise about both hands — a pointer that cannot cross the scrim and a
   * caret that cannot leave the panel — so it is asserted beside the trap that makes the second
   * half true, and the heading that names the thing being claimed.
   */
  it("is a modal dialog labelled by its own heading", async () => {
    const { container } = open({ title: "Categories & labels" });
    const dialog = await screen.findByRole("dialog", { name: "Categories & labels" });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    const heading = screen.getByRole("heading", { level: 2, name: "Categories & labels" });
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    // Two dialogs on one screen would otherwise share an id: `useId` is per instance.
    expect(heading.id).not.toBe("");
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  /**
   * The caret starts on the panel, which is what makes Shift+Tab wrap rather than fall out, and
   * `tabIndex={-1}` keeps the panel out of its own cycle so that counts as *before* the first
   * stop. No field is focused: these panels are settled values, not questions.
   */
  it("takes the caret when it opens, and keeps Tab inside itself", async () => {
    open();
    const dialog = await panel();
    await waitFor(() => expect(dialog).toHaveFocus());

    const close = screen.getByRole("button", { name: "Close deck settings" });
    const inBody = screen.getByRole("button", { name: "A control inside the body" });

    // Backward from the panel: the wrap a reader meets first.
    await userEvent.tab({ shift: true });
    expect(inBody).toHaveFocus();

    // And forward off the end.
    await userEvent.tab();
    expect(close).toHaveFocus();
  });

  /**
   * The width is the host's, written out whole — a class built by interpolation matches nothing
   * Tailwind's source scan knows and emits no rule. `max-w-full` is the shell's, so a panel
   * wider than the window still fits inside it.
   */
  it("wears the width class it was handed, verbatim", async () => {
    open({ width: "w-[48rem]" });
    const dialog = await panel();

    expect(dialog).toHaveClass("w-[48rem]");
    expect(dialog).toHaveClass("max-w-full");
  });

  /**
   * **The panel is clamped to the window, and it takes two classes to say so** (2026-08-18).
   *
   * `max-h-full` on the panel is a percentage against its *grid area*, and the area was an
   * implicit row — which is `auto`, and an `auto` row sizes to its own content. The clamp was
   * therefore circular and clamped nothing: measured in a headless browser at a 708px viewport
   * with a 140-line export, the panel drew **2963px**, its body's `overflow-y-auto` never
   * scrolled because it had every pixel it asked for, and the dialog's buttons sat at y≈2930 —
   * off the window, and reachable by neither pointer nor wheel. One explicit
   * `minmax(0,1fr)` row bounds the area to the scrim's content box; the same panel then draws
   * 660px and the body scrolls.
   *
   * **This can only be a class assertion, and that is a property of the tool rather than a
   * choice**: jsdom has no layout engine, so every box it reports is 0px and the entire class of
   * defect is invisible to this suite. The numbers above were measured in a browser. What this
   * pins is that neither half of the pair is dropped by an edit that never runs one.
   */
  it("bounds the panel to the window, which takes the scrim's row and the panel's max height", async () => {
    open();
    const dialog = await panel();

    expect(dialog).toHaveClass("max-h-full");
    const scrim = dialog.parentElement as HTMLElement;
    // A bare `1fr` is `minmax(auto, 1fr)`, and that `auto` floor is the panel's content again —
    // which is the same bug spelled a second way. The `minmax(0,` half is load-bearing.
    expect(scrim).toHaveClass("grid");
    expect(scrim).toHaveClass("grid-rows-[minmax(0,1fr)]");
  });

  /**
   * **The shell does not own the body's scroller.** The three bodies differ — one keeps a sticky
   * roll-up inside its scroller — so the host's element is a direct child of the panel and
   * nothing is wrapped around it. A shell that grew a scroll container here would give every one
   * of them two.
   */
  it("puts the body straight into the panel, with no scroller of its own", async () => {
    open();
    const dialog = await panel();

    const body = dialog.lastElementChild as HTMLElement;
    expect(body.tagName).toBe("DIV");
    expect(body).toHaveClass("overflow-y-auto");
    expect(dialog.querySelector("header")).not.toBeNull();
    // Header and body, and nothing between them.
    expect(dialog.children).toHaveLength(2);
  });

  /**
   * **The body renders inside the shell's presence subtree**, which is the one guarantee here
   * that a careless extraction breaks in silence: `useDeckField` commits a half-typed paragraph
   * on `useIsPresent()` going false — the dialog's *close* — rather than on the unmount a fifth
   * of a second later. `children` created by a host and rendered by the shell keep React's
   * context by position, so the hook sees `AnimatePresence`'s answer and not the default `true`
   * a body outside one would get.
   */
  it("hands the body its own presence, so a close reaches it before the unmount", async () => {
    const seen: boolean[] = [];
    function Body() {
      seen.push(useIsPresent());
      return <p>Reading the deck…</p>;
    }
    const props = {
      title: "Deck settings",
      closeLabel: "Close deck settings",
      width: "w-[55rem]",
      onDismiss: vi.fn(),
      onClose: vi.fn(),
    };

    const { rerender } = render(
      <Dialog open {...props}>
        <Body />
      </Dialog>,
    );
    await panel();
    expect(seen).toContain(true);

    rerender(
      <Dialog open={false} {...props}>
        <Body />
      </Dialog>,
    );

    // The render that starts the exit, seen from inside the body — the panel is still mounted.
    expect(seen).toContain(false);
  });

  /**
   * **A host that asks for nothing gets the dialog every other host already had.**
   *
   * `flanks` is one surface's — `AllPrintingsDialog`'s step chevrons — and every other dialog in
   * the builder is drawn by the same two class strings. So the absent case is asserted as an
   * absence rather than left to a reading of the source: a third grid column narrows the panel on
   * every dialog at once to reserve room nobody is using, and `relative` on the panel moves the
   * containing block out from under any absolutely positioned thing a body draws. Neither would
   * fail anything else in this suite, and **jsdom lays nothing out**, so neither would fail
   * anything anywhere.
   */
  it("leaves the scrim and the panel untouched when no flanks were asked for", async () => {
    open();
    const dialog = await panel();
    const scrim = dialog.parentElement as HTMLElement;

    expect(scrim.className).not.toMatch(/grid-cols-/);
    expect(dialog).not.toHaveClass("relative");
    expect(dialog).not.toHaveClass("col-start-2");
    // Header and body, and nothing hung off the sides.
    expect(dialog.children).toHaveLength(2);
  });

  /**
   * The flanked case: **room reserved on the scrim, controls rendered inside the panel.**
   *
   * The split is the whole design and neither half works alone. The room has to be the *scrim's*,
   * because the panel is `max-w-full` inside a padded scrim — at the app's 1024px floor a wide
   * panel already is the window, so a control hung off its edge is off the glass. And the control
   * has to be inside the **panel**, because `trapTab` cycles within `e.currentTarget`: a flank
   * rendered as a sibling of the panel would be pointer-only and would sit outside the
   * `aria-modal` subtree while being the only way to move the dialog on.
   *
   * **The classes are all this can check.** jsdom has no layout engine, so every box here is 0px
   * and nothing about the three columns, the panel narrowing or where a chevron lands is visible
   * to this suite. Those are the live pass's, at 1024 and at 1280.
   */
  it("reserves a column either side and renders the flanks inside the panel", async () => {
    open({
      flanks: {
        left: <button type="button">Previous card</button>,
        right: <button type="button">Next card</button>,
      },
    });
    const dialog = await panel();
    const scrim = dialog.parentElement as HTMLElement;

    expect(scrim).toHaveClass("grid-cols-[3.5rem_minmax(0,1fr)_3.5rem]");
    // …and the rows are untouched: that class is what makes the panel's `max-h-full` mean
    // anything, and a flanked dialog is clamped to the window exactly like an unflanked one.
    expect(scrim).toHaveClass("grid-rows-[minmax(0,1fr)]");
    expect(dialog).toHaveClass("relative");
    expect(dialog).toHaveClass("col-start-2");

    const previous = screen.getByRole("button", { name: "Previous card" });
    const next = screen.getByRole("button", { name: "Next card" });
    expect(dialog.contains(previous)).toBe(true);
    expect(dialog.contains(next)).toBe(true);
  });

  /**
   * A flank is an ordinary tab stop of the dialog, which is the point of rendering it in there.
   *
   * The cycle is the panel's own: ✕ first — the way out is the stop a reader expects to meet
   * first — then the two flanks, then whatever the body drew, then back round to the ✕. That last
   * step is the one worth driving: it is `trapTab` still holding the caret with two more controls
   * in the panel than it had before.
   */
  it("puts the flanks in the panel's own tab cycle", async () => {
    open({
      flanks: {
        left: <button type="button">Previous card</button>,
        right: <button type="button">Next card</button>,
      },
    });
    const dialog = await panel();
    await waitFor(() => expect(dialog).toHaveFocus());

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close deck settings" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Previous card" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Next card" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "A control inside the body" })).toHaveFocus();
    // Off the end and round, rather than out into the view behind the scrim.
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close deck settings" })).toHaveFocus();
  });

  /**
   * **The host's keydown is composed with `trapTab`, never in place of it.**
   *
   * Both halves are asserted because either alone is a shell that lies: a host handler that never
   * fires is a dialog with no keys of its own, and a `trapTab` displaced by one is an
   * `aria-modal` claim that is false for the keyboard — which is the half no reader with a mouse
   * would ever notice.
   *
   * On the **panel** and not on `window`, which is why this can be driven at all: the caret is in
   * the dialog, so the press reaches the panel by bubbling from whatever holds it.
   */
  it("runs the host's keydown as well as the tab trap", async () => {
    const onPanelKeyDown = vi.fn();
    open({ onPanelKeyDown });
    const dialog = await panel();
    await waitFor(() => expect(dialog).toHaveFocus());

    await userEvent.keyboard("{ArrowRight}");
    expect(onPanelKeyDown).toHaveBeenCalledTimes(1);
    expect(onPanelKeyDown.mock.calls[0][0]).toMatchObject({ key: "ArrowRight" });

    // Tab reaches it too — the composition hands the host every press — and the trap still holds
    // the caret, which is the assertion that says `trapTab` ran first and was not replaced.
    //
    // **The keys are counted rather than the calls**, and the difference is `userEvent`'s rather
    // than this shell's: `tab({ shift: true })` presses Shift *and* Tab, so a composed handler
    // that is working correctly is called twice by that one line. Asserting a call count here
    // pins a fact about the test driver — it was `2`, and the handler saw 3 — where what this is
    // about is that a `Tab` press reaches the host at all.
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "A control inside the body" })).toHaveFocus();
    expect(onPanelKeyDown.mock.calls.map(([e]) => e.key)).toEqual(["ArrowRight", "Shift", "Tab"]);
  });
});
