import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./DesktopFace", () => ({ default: () => <div>the desktop face</div> }));
vi.mock("./phone/PhoneApp", () => ({ default: () => <div>the phone face</div> }));

const startupStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  ipc: { startupStatus, onStartupChanged: () => () => undefined },
}));

import { LightApp } from "./LightApp";

/** A `matchMedia` the test drives: one query, one answer, and a way to change it. */
function stubViewport(wide: boolean) {
  const listeners = new Set<() => void>();
  let matches = wide;
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return matches;
        },
        media: query,
        addEventListener: (_: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
      }) as unknown as MediaQueryList,
  );
  return (next: boolean) => {
    matches = next;
    for (const cb of listeners) cb();
  };
}

beforeEach(() => startupStatus.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("LightApp", () => {
  it("draws the phone face below the desktop floor", async () => {
    stubViewport(false);
    render(<LightApp gate={false} />);
    expect(await screen.findByText("the phone face")).toBeInTheDocument();
  });

  it("draws the desktop face at the floor and above", async () => {
    stubViewport(true);
    render(<LightApp gate={false} />);
    expect(await screen.findByText("the desktop face")).toBeInTheDocument();
  });

  it("swaps the face when the viewport crosses the floor", async () => {
    const resize = stubViewport(false);
    render(<LightApp gate={false} />);
    expect(await screen.findByText("the phone face")).toBeInTheDocument();

    act(() => resize(true));
    expect(await screen.findByText("the desktop face")).toBeInTheDocument();
    expect(screen.queryByText("the phone face")).toBeNull();
  });

  it("draws neither face until the data folder is open", async () => {
    stubViewport(false);
    startupStatus.mockResolvedValue({ state: "loading" });
    render(<LightApp gate />);
    expect(await screen.findByRole("status")).toHaveTextContent("Opening your collection…");

    // A face's chunk draws that same sentence while it loads, so the sentence alone cannot tell a
    // held gate from a face on its way — and which of the two a broken gate shows is decided by
    // whether an earlier test already loaded the chunk. A second ask is a whole poll interval
    // later: the gate heard `loading` and is still asking, and a face on its way has arrived.
    await waitFor(() => expect(startupStatus.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
    expect(screen.queryByText("the phone face")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Opening your collection…");
  });

  it("says why when the data folder will not open", async () => {
    stubViewport(false);
    startupStatus.mockResolvedValue({ state: "failed", message: "user.db is locked." });
    render(<LightApp gate />);
    expect(await screen.findByRole("alert")).toHaveTextContent("user.db is locked.");
  });

  it("draws the face once the data folder is open", async () => {
    stubViewport(false);
    startupStatus.mockResolvedValue({ state: "ready" });
    render(<LightApp gate />);
    expect(await screen.findByText("the phone face")).toBeInTheDocument();
  });
});
