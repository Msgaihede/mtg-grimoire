import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TitleBar } from "@/components/TitleBar";
import { LAYER } from "@/lib/layers";
import { useAppStore } from "@/lib/store";
import { SNAP_BUTTON_ID, SNAP_HOVER_EVENTS } from "@/lib/window";
import { emitFake, resetListeners } from "../../.storybook/fake/event";
import { resetWindow, setMaximized, windowCalls } from "../../.storybook/fake/window";

/**
 * The fakes, not hand-rolled stubs, and both at the same rung they sit at in Storybook: under
 * `src/lib/window.ts` rather than replacing it. That module is a hand-written mirror of four
 * Tauri methods and four ACL permissions, and a test that mocked it would prove nothing about
 * the one file that can drift from `capabilities/desktop.json`.
 */
vi.mock("@tauri-apps/api/window", () => import("../../.storybook/fake/window"));
vi.mock("@tauri-apps/api/event", () => import("../../.storybook/fake/event"));

beforeEach(() => {
  resetWindow();
  resetListeners();
  // The keyboard map's flag lives in the store, which is a module singleton — a test that
  // opened the panel would otherwise hand the next one a caption with a panel hanging off it.
  useAppStore.setState(useAppStore.getInitialState());
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
   * pointer and nothing else. So the row needs it, the lockup wrapper needs its own (it is
   * what holds the 10px between the mark and the wordmark inside the grab area), the wordmark
   * needs its own, and the buttons must not have one at all: on an element that handles a
   * click, the attribute swallows it and the button becomes a way to drag the window.
   *
   * The mark is the one hole the attribute cannot close, because an `<svg>` under the pointer
   * is the element Tauri asks and it carries nothing. `pointer-events-none` is what makes the
   * hit test resolve to the wrapper instead, so that class is load-bearing rather than
   * cosmetic — and **jsdom has no hit testing at all**, so this assertion on the class is the
   * whole of what the suite can say about it. The consequence of losing it is a 20×20 patch
   * of caption that does not drag, which is intermittent by geometry: nobody reports it, they
   * just press again a few pixels to the right.
   */
  it("marks the row, the lockup and the wordmark draggable and the buttons not", () => {
    const { container } = render(<TitleBar />);

    const row = container.firstElementChild;
    expect(row).toHaveAttribute("data-tauri-drag-region");

    const wordmark = screen.getByText("MTG GRIMOIRE");
    expect(wordmark).toHaveAttribute("data-tauri-drag-region");

    const lockup = wordmark.parentElement;
    expect(lockup).toHaveAttribute("data-tauri-drag-region");

    const mark = lockup?.querySelector("svg");
    expect(mark).not.toBeNull();
    expect(mark).toHaveClass("pointer-events-none");

    for (const name of ["Keyboard shortcuts", "Minimize", "Maximize", "Close"]) {
      expect(screen.getByRole("button", { name })).not.toHaveAttribute("data-tauri-drag-region");
    }
  });

  /**
   * The fourth button, which is the one that opens something rather than doing something to the
   * window.
   *
   * A caption button is a glyph with no visible label, so `aria-label` is the whole of its name;
   * `aria-expanded` is the whole of what says the panel is open, since the button draws no
   * chevron and there is no room for one. Both states are asserted because the attribute is only
   * useful if it moves — a button reporting `false` for ever is worse than one reporting nothing,
   * which is why the three window verbs below carry none at all.
   */
  it("names the keyboard button and reports whether its panel is open", async () => {
    const user = userEvent.setup();
    render(<TitleBar />);

    const button = screen.getByRole("button", { name: "Keyboard shortcuts" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Everywhere" })).not.toBeInTheDocument();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "Everywhere" })).toBeInTheDocument();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Everywhere" })).not.toBeInTheDocument();

    for (const name of ["Minimize", "Maximize", "Close"]) {
      expect(screen.getByRole("button", { name })).not.toHaveAttribute("aria-expanded");
    }
  });

  /**
   * Open draws the same wash the pointer draws, through the same branch `forceHover` uses —
   * there is no third styling path, and this is what says so.
   *
   * `classList.contains`, never `className.includes`: the button always carries
   * `hover:bg-accent/10`, whose name *contains* the unprefixed class, so a substring check passes
   * before anything has been pressed. That trap cost a run in the snap-overlay test above, which
   * is why the same sentence is written twice.
   */
  it("lights the keyboard button while its panel is open", async () => {
    const user = userEvent.setup();
    render(<TitleBar />);

    const button = screen.getByRole("button", { name: "Keyboard shortcuts" });
    expect(button.classList.contains("bg-accent/10")).toBe(false);

    await user.click(button);
    expect(button.classList.contains("bg-accent/10")).toBe(true);
  });

  /**
   * A drag region nothing can reach is not a drag region, which is why this sits beside the
   * test above rather than among the layout assertions.
   *
   * `SyncProgress`'s overlay and `Dialog`'s scrim are both `fixed inset-0`, and a positioned
   * element paints over non-positioned content in the same stacking context whatever the
   * numbers say — so this row, a flex item at `z-auto`, was covered by both. It shipped that
   * way: driven in the window on 2026-08-22, a first launch drew **no caption at all** for the
   * length of the sync and `elementFromPoint` over Close answered the overlay, leaving Alt+F4
   * as the only way out of the app.
   *
   * Asserted against the constant rather than the string, because the number is the rung's to
   * choose and `layers.test.ts` is what holds the rung above `gate`. Between the two files the
   * claim is complete; neither half says it alone. **jsdom paints nothing**, so a class is the
   * whole of what the suite can check here — the pass that found this was a hit test in the
   * real window, and that is what would have to be re-run to prove it again.
   */
  it("draws the caption above every surface the app can cover it with", () => {
    const { container } = render(<TitleBar />);

    expect(container.firstElementChild).toHaveClass(LAYER.caption);
  });

  /**
   * The mark is drawn and is not announced, which is `GrimoireMark`'s default rather than an
   * omission: the wordmark two millimetres to its right already sets the product's name in
   * type, so a named mark here is that name read out twice in a row. `getByRole("img")` is
   * the assertion because that is exactly what a `label` would add — pass one and the svg
   * becomes `role="img"` with an accessible name, which is what this must not be.
   *
   * Scoped through the lockup rather than the whole container: the three caption buttons each
   * draw a lucide `<svg>`, so a bare `container.querySelector("svg")` would answer about the
   * Minimize glyph and pass with the mark deleted.
   */
  it("draws the mark and keeps it out of the accessibility tree", () => {
    render(<TitleBar />);

    const mark = screen.getByText("MTG GRIMOIRE").parentElement?.querySelector("svg");
    expect(mark).not.toBeNull();
    // The 34px row's 20px mark, which is under `GrimoireMark`'s 24px detail floor and is
    // therefore the simplified variant. The size is the whole of what picks that, so it is
    // worth pinning: a bare `width` change here silently redraws the artwork.
    expect(mark).toHaveAttribute("width", "20");
    expect(mark).toHaveAttribute("aria-hidden", "true");

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  /** Without the native caption there is nothing else that names the app on screen. */
  it("carries the product name in full", () => {
    render(<TitleBar />);
    expect(screen.getByText("MTG GRIMOIRE")).toBeInTheDocument();
  });
});
