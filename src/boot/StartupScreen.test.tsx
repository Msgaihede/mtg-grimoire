import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => import("../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../.storybook/fake/window"));

import { STARTUP_LOADING_LABEL, StartupScreen } from "@/boot/StartupScreen";
import { ACTIVITY_DELAY_MS } from "@/lib/activity";
import { resetListeners } from "../../.storybook/fake/event";
import { resetWindow } from "../../.storybook/fake/window";

beforeEach(() => {
  resetListeners();
  resetWindow();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StartupScreen", () => {
  /**
   * The live region is there from the first frame and empty, and the words are inserted when the
   * delay ends — a region that arrives already holding its sentence announces nothing, and a start
   * that ends inside the delay should neither flash words nor announce them.
   */
  it("holds its sentence back for the delay, in a status region mounted from the start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container } = render(<StartupScreen status={{ state: "loading" }} />);

    const region = screen.getByRole("status");
    expect(region).toBeEmptyDOMElement();
    // The 64px mark is the only thing on screen with a gradient — the caption's 20px copy ships
    // none — so this is "the big mark is not drawn yet", and the second read below proves the
    // selector can match at all.
    expect(container.querySelector("linearGradient")).toBeNull();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_DELAY_MS);
    });

    // The same node, now speaking — not a second region mounted beside the first.
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent(STARTUP_LOADING_LABEL);
    expect(container.querySelector("linearGradient")).not.toBeNull();
    expect(screen.getByRole("progressbar", { name: STARTUP_LOADING_LABEL })).toBeInTheDocument();
  });

  /** The end state is never behind a timer: no clock is advanced here. */
  it("shows a failure at once, with its line breaks intact", () => {
    const message =
      "Could not open the data folder at\nD:\\Grimoire\\data\n\nIs it on a drive that is still attached?";
    render(<StartupScreen status={{ state: "failed", message }} />);

    expect(
      screen.getByRole("heading", { name: "The data folder would not open" }),
    ).toBeInTheDocument();
    const said = screen.getByRole("alert");
    // `textContent` rather than `toHaveTextContent`, which normalises whitespace and would pass
    // over a message whose breaks had been flattened.
    expect(said.textContent).toBe(message);
    // jsdom lays nothing out, so the class is the only witness that the breaks are drawn.
    expect(said).toHaveClass("whitespace-pre-line");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  /** `decorations: false`: without the caption a loading window cannot be moved or closed. */
  it("draws the window caption on desktop", () => {
    render(<StartupScreen status={{ state: "loading" }} />);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
