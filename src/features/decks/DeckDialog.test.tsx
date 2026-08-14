import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useIsPresent } from "motion/react";
import { describe, expect, it, vi } from "vitest";
import { DeckDialog } from "./DeckDialog";

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
function open(props: Partial<React.ComponentProps<typeof DeckDialog>> = {}) {
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <DeckDialog
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
    </DeckDialog>,
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

describe("DeckDialog", () => {
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
      <DeckDialog
        open={false}
        title="Deck settings"
        closeLabel="Close deck settings"
        width="w-[55rem]"
        onDismiss={vi.fn()}
        onClose={vi.fn()}
      >
        <Body />
      </DeckDialog>,
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
      <DeckDialog
        open={false}
        title="Deck settings"
        closeLabel="Close deck settings"
        width="w-[55rem]"
        onDismiss={onDismiss}
        onClose={vi.fn()}
      >
        <p>Reading the deck…</p>
      </DeckDialog>,
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
   *  title — "Close Categories & tags" is not a sentence. */
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
    const { container } = open({ title: "Categories & tags" });
    const dialog = await screen.findByRole("dialog", { name: "Categories & tags" });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    const heading = screen.getByRole("heading", { level: 2, name: "Categories & tags" });
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
      <DeckDialog open {...props}>
        <Body />
      </DeckDialog>,
    );
    await panel();
    expect(seen).toContain(true);

    rerender(
      <DeckDialog open={false} {...props}>
        <Body />
      </DeckDialog>,
    );

    // The render that starts the exit, seen from inside the body — the panel is still mounted.
    expect(seen).toContain(false);
  });
});
