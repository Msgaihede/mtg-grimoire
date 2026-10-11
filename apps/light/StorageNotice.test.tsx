import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import type { StorageCleared } from "@grimoire/ui/lib/core/hostStorage";
import { LAYER } from "@grimoire/ui/lib/layers";
import { StorageNotice, StorageNoticeCard } from "./StorageNotice";

/** What a host that found its storage gone answers, in that host's own words. */
const CLEARED: StorageCleared = {
  at: Date.UTC(2026, 9, 4, 12),
  title: "The saved data was cleared",
  lines: [
    "Why it happened.",
    "The card data downloads again by itself.",
    "What you had added here is not coming back.",
  ],
};

function answer(cleared: StorageCleared | null | Error) {
  invoke.mockImplementation((command: string) => {
    if (command === "storage_cleared") {
      return cleared instanceof Error ? Promise.reject(cleared) : Promise.resolve(cleared);
    }
    return Promise.resolve(null);
  });
}

// Braces, and they matter: a `beforeEach` that *returns* a function hands Vitest a teardown to
// call, and `mockReset()` returns the mock — so the bare arrow has every test end by calling
// `invoke()` with nothing, under whatever implementation that test left behind.
beforeEach(() => {
  invoke.mockReset();
});

describe("the storage notice", () => {
  it("says what the host answered: what happened, what is rebuilt and what is not", async () => {
    answer(CLEARED);
    render(<StorageNotice />);

    // The words are announced as they arrive; the region around them is named by its title.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The saved data was cleared");
    for (const line of CLEARED.lines) expect(alert).toHaveTextContent(line);
    expect(screen.getByRole("region", { name: "The saved data was cleared" })).toContainElement(
      alert,
    );
    // The button is beside the alert and not inside it, so it is not read out with the words.
    expect(alert).not.toContainElement(screen.getByRole("button", { name: "Got it" }));
  });

  it("is put away by its one button, and tells the host the reader has read it", async () => {
    answer(CLEARED);
    render(<StorageNotice />);
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("storage_cleared_dismiss");
  });

  it("is put away even when the host refuses to hear it", async () => {
    invoke.mockImplementation((command: string) =>
      command === "storage_cleared" ? Promise.resolve(CLEARED) : Promise.reject("refused"),
    );
    render(<StorageNotice />);
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("draws nothing on a host with nothing to say", async () => {
    answer(null);
    render(<StorageNotice />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("storage_cleared"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws nothing on a host without the command — one that owns its folder, the fake", async () => {
    answer(new Error("Command storage_cleared not found"));
    render(<StorageNotice />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("storage_cleared"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("draws nothing for an answer that is not a notice", async () => {
    // A host that answers the name with something else is not one to put words in the mouth of.
    answer({ cleared: true } as unknown as StorageCleared);
    render(<StorageNotice />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("storage_cleared"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the notice's card", () => {
  it("is not a modal: it takes no focus and claims nothing about the page behind it", () => {
    render(<StorageNoticeCard notice={CLEARED} onDismiss={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("is drawn on the first-run screen's rung, and only the card takes a press", () => {
    // jsdom lays nothing out and stacks nothing, so the two classes are what can be pinned: the
    // rung it shares with the desktop face's first-run screen (`LightApp` mounts it after that
    // screen, and equal rungs paint in document order), and a strip that lets presses through.
    render(<StorageNoticeCard notice={CLEARED} onDismiss={() => {}} />);
    const strip = screen.getByRole("region");
    expect(strip.classList.contains(LAYER.gate)).toBe(true);
    expect(strip.classList.contains("pointer-events-none")).toBe(true);
    expect(strip.firstElementChild?.classList.contains("pointer-events-auto")).toBe(true);
  });
});
