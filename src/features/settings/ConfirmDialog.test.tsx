import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CONFIRM_WORD, ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";

function open(over: Partial<ConfirmDialogProps> = {}) {
  const props: ConfirmDialogProps = {
    open: true,
    title: "Clear collection",
    confirmLabel: "Clear collection",
    typeToConfirm: true,
    pending: false,
    onConfirm: vi.fn(),
    onDismiss: vi.fn(),
    onClose: vi.fn(),
    children: "Deletes every entry in your collection.",
    ...over,
  };
  render(<ConfirmDialog {...props} />);
  return props;
}

const field = () => screen.getByRole("textbox");
const confirmButton = (name = "Clear collection") => screen.getByRole("button", { name });

describe("ConfirmDialog", () => {
  /**
   * The whole point of the gate: the destructive button is not pressable until the reader has
   * written the word out. `disabled` rather than `aria-disabled`, so this is also the assertion
   * that a click cannot reach the handler at all.
   */
  it("keeps the destructive button out of reach until the word is typed", async () => {
    const user = userEvent.setup();
    const props = open();

    expect(confirmButton()).toBeDisabled();
    await user.click(confirmButton());
    expect(props.onConfirm).not.toHaveBeenCalled();

    await user.type(field(), CONFIRM_WORD);

    expect(confirmButton()).toBeEnabled();
  });

  /**
   * A deliberateness gate, not a spelling test — but a gate that took `confirm` is one a reader
   * passes without looking at it. This is the assertion that would fail if the comparison were
   * ever loosened to be case-insensitive "for kindness".
   */
  it("refuses a near miss, including the wrong case", async () => {
    const user = userEvent.setup();
    open();

    await user.type(field(), "confirm");
    expect(confirmButton()).toBeDisabled();

    await user.clear(field());
    await user.type(field(), "Confirm!");
    expect(confirmButton()).toBeDisabled();
  });

  /** A double-click on the label above selects the word *and* its trailing space. */
  it("accepts the word with whitespace around it", async () => {
    const user = userEvent.setup();
    open();

    await user.type(field(), `  ${CONFIRM_WORD} `);

    expect(confirmButton()).toBeEnabled();
  });

  /**
   * The dialog closes itself before the command runs — see the handler's note. Asserting the
   * order matters: the panel underneath is where the outcome sentence lands, and a dialog left
   * up would cover it.
   */
  it("dismisses first and then runs the clear", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const props = open({
      onDismiss: vi.fn(() => calls.push("dismiss")),
      onConfirm: vi.fn(() => calls.push("confirm")),
    });

    await user.type(field(), CONFIRM_WORD);
    await user.click(confirmButton());

    expect(calls).toEqual(["dismiss", "confirm"]);
    expect(props.onConfirm).toHaveBeenCalledOnce();
  });

  /**
   * Enter is the same press as the button and is gated identically. Without the gate it would
   * fire on the keystroke that finishes typing the word — the one moment the reader is looking
   * at the field rather than at the sentence.
   */
  it("runs on Enter only once the word matches", async () => {
    const user = userEvent.setup();
    const props = open();

    await user.type(field(), "Conf{Enter}");
    expect(props.onConfirm).not.toHaveBeenCalled();

    await user.type(field(), "irm{Enter}");
    expect(props.onConfirm).toHaveBeenCalledOnce();
  });

  /**
   * The caret starts in the field, which is `Dialog`'s "no field is focused" rule
   * deliberately overridden — this dialog is one question and the field is its answer. Asserted
   * with the DOM's own `activeElement` rather than by typing, because `user.type` focuses what
   * it is handed and would repair a broken entry point.
   */
  it("puts the caret in the field on open", () => {
    open();

    expect(document.activeElement).toBe(field());
  });

  /**
   * The plain confirm — the local cache's. No field at all, so the shell's own focus rule
   * stands and the button is armed from the first frame.
   */
  it("arms immediately and asks for nothing when the word is not required", () => {
    open({ typeToConfirm: false, title: "Clear local cache", confirmLabel: "Clear cache" });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(confirmButton("Clear cache")).toBeEnabled();
  });

  /** A clear in flight takes both controls out of reach and says what is happening. */
  it("goes inert while the clear is running", () => {
    open({ typeToConfirm: false, confirmLabel: "Clear cache", pending: true });

    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  /** Closed is nothing mounted — the shell's guarantee, and what throws the typed word away. */
  it("renders nothing at all when closed", () => {
    open({ open: false });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
