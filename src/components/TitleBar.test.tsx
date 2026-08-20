import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TitleBar } from "@/components/TitleBar";
import { SNAP_BUTTON_ID, SNAP_HOVER_EVENTS } from "@/lib/window";
import { emitFake, resetListeners } from "../../.storybook/fake/event";
import { resetWindow, setMaximized, windowCalls } from "../../.storybook/fake/window";

/**
 * The fakes, not hand-rolled stubs, and both at the same rung they sit at in Storybook: under
 * `src/lib/window.ts` rather than replacing it. That module is a hand-written mirror of four
 * Tauri methods and four ACL permissions, and a test that mocked it would prove nothing about
 * the one file that can drift from `capabilities/default.json`.
 */
vi.mock("@tauri-apps/api/window", () => import("../../.storybook/fake/window"));
vi.mock("@tauri-apps/api/event", () => import("../../.storybook/fake/event"));

beforeEach(() => {
  resetWindow();
  resetListeners();
});

describe("TitleBar", () => {
  it("runs each caption button's window verb", async () => {
    const user = userEvent.setup();
    render(<TitleBar />);

    await user.click(screen.getByRole("button", { name: "Minimize" }));
    expect(windowCalls().minimizeCount).toBe(1);

    await user.click(screen.getByRole("button", { name: "Maximize" }));
    expect(windowCalls().toggleMaximizeCount).toBe(1);

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(windowCalls().closeCount).toBe(1);
  });

  /**
   * The glyph is the only thing that says which of two things the middle button will do, and
   * the label is the only thing that says it to a screen reader. Both come off one boolean
   * read back from the window — never from a local toggle — so that a maximize performed by
   * anything else still moves them. The three other ways it happens: a double-click on the
   * drag region, Win+Up, and (on Windows 11) the native snap overlay swallowing the click and
   * sending `SC_MAXIMIZE` itself, which is the common path and never runs the `onClick` above.
   */
  it("reads the maximized state from the window rather than from the click", async () => {
    render(<TitleBar />);
    expect(await screen.findByRole("button", { name: "Maximize" })).toBeInTheDocument();

    // Nobody pressed anything: this is the window changing under the app, exactly as Win+Up
    // or the native overlay would.
    setMaximized(true);
    expect(await screen.findByRole("button", { name: "Restore Down" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Maximize" })).not.toBeInTheDocument();
    expect(windowCalls().toggleMaximizeCount).toBe(0);

    setMaximized(false);
    expect(await screen.findByRole("button", { name: "Maximize" })).toBeInTheDocument();
  });

  /**
   * The maximize button is the one control in the app whose hover cannot be a CSS `:hover`.
   * On Windows 11 a transparent Win32 child window sits over it so the OS can raise Snap
   * Layouts, which means the pointer is never over the webview and `:hover` never fires — a
   * button that visibly stops responding on the only platform the overlay exists for. These
   * two events are the substitute, and this asserts they are wired.
   */
  it("draws the maximize hover from the snap overlay's events", async () => {
    render(<TitleBar />);
    const button = await screen.findByRole("button", { name: "Maximize" });
    // `classList.contains`, never `className.includes`: the button always carries
    // `hover:bg-accent/10`, which *contains* the unprefixed class as a substring, so a
    // substring check passes before the event is ever emitted and this test proves nothing.
    // It cost a run to find, which is the argument for the comment.
    expect(button.classList.contains("bg-accent/10")).toBe(false);

    emitFake(SNAP_HOVER_EVENTS.enter, undefined);
    await waitFor(() => expect(button.classList.contains("bg-accent/10")).toBe(true));

    emitFake(SNAP_HOVER_EVENTS.leave, undefined);
    await waitFor(() => expect(button.classList.contains("bg-accent/10")).toBe(false));
  });

  /**
   * The id the Rust side names in `snap_layout::init().button_id(…)`. A mismatch creates no
   * overlay, raises no error and logs nothing — the button keeps working and Snap Layouts
   * never appear — so this assertion is the only thing standing between a rename and a
   * feature that silently is not there.
   */
  it("puts the snap overlay's id on the maximize button and nowhere else", async () => {
    const { container } = render(<TitleBar />);
    const tagged = container.querySelectorAll(`#${SNAP_BUTTON_ID}`);
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toBe(await screen.findByRole("button", { name: "Maximize" }));
  });

  /**
   * `data-tauri-drag-region` does not inherit — Tauri reads it off the element under the
   * pointer and nothing else. So the row needs it, the wordmark inside the row needs its own,
   * and the buttons must not have one at all: on an element that handles a click, the
   * attribute swallows it and the button becomes a way to drag the window.
   */
  it("marks the row and the wordmark draggable and the buttons not", () => {
    const { container } = render(<TitleBar />);

    const row = container.firstElementChild;
    expect(row).toHaveAttribute("data-tauri-drag-region");
    expect(screen.getByText("MTG GRIMOIRE")).toHaveAttribute("data-tauri-drag-region");

    for (const name of ["Minimize", "Maximize", "Close"]) {
      expect(screen.getByRole("button", { name })).not.toHaveAttribute("data-tauri-drag-region");
    }
  });

  /** Without the native caption there is nothing else that names the app on screen. */
  it("carries the product name in full", () => {
    render(<TitleBar />);
    expect(screen.getByText("MTG GRIMOIRE")).toBeInTheDocument();
  });
});
