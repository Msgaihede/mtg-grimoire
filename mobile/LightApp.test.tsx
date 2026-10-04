import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Set by the one test that needs the phone face to fail as a face's render can. */
const phone = vi.hoisted(() => ({ throws: false }));

vi.mock("./DesktopFace", () => ({ default: () => <div>the desktop face</div> }));
vi.mock("./phone/PhoneApp", () => ({
  default: () => {
    if (phone.throws) throw new Error("the phone face broke");
    return <div>the phone face</div>;
  },
}));

// Stood in for, so the test of where it is mounted does not need a host that answers it.
vi.mock("./StorageNotice", () => ({ StorageNotice: () => <div>the storage notice</div> }));

const startupStatus = vi.hoisted(() => vi.fn());
/** The gate's one subscription, so a test can be the host saying something after `ready`. */
const gate = vi.hoisted(() => ({
  heard: undefined as ((status: unknown) => void) | undefined,
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    startupStatus,
    onStartupChanged: (cb: (status: unknown) => void) => {
      gate.heard = cb;
      return () => {
        if (gate.heard === cb) gate.heard = undefined;
      };
    },
  },
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

beforeEach(() => {
  startupStatus.mockReset();
  phone.throws = false;
});
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

  it("says so when a face breaks, and does not carry the failure across the floor", async () => {
    // React logs the caught error and the boundary records it; neither belongs in the run's output.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    phone.throws = true;
    const resize = stubViewport(false);
    render(<LightApp gate={false} />);

    // Without the boundary the throw unwinds the whole tree and the page is blank.
    expect(await screen.findByRole("alert")).toHaveTextContent("This page could not be drawn.");

    // The boundary is keyed by the face: unkeyed, it would stay failed and draw its sentence over
    // a desktop face that has nothing wrong with it.
    act(() => resize(true));
    expect(await screen.findByText("the desktop face")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("mounts the storage notice after whichever face is drawn, and not before the gate opens", async () => {
    // After, in the document: the notice shares a rung with the desktop face's first-run screen,
    // and equal rungs paint in document order — mounted ahead of the face it would be drawn
    // under the screen it explains. jsdom stacks nothing, so the order is what can be held.
    const resize = stubViewport(true);
    render(<LightApp gate={false} />);
    const desktop = await screen.findByText("the desktop face");
    const notice = screen.getByText("the storage notice");
    expect(desktop.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Outside the face's boundary, so a crossing keeps the one that is there.
    act(() => resize(false));
    const phone = await screen.findByText("the phone face");
    expect(screen.getByText("the storage notice")).toBe(notice);
    expect(phone.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("asks the host nothing about its storage while the data folder is still opening", async () => {
    stubViewport(false);
    startupStatus.mockResolvedValue({ state: "loading" });
    render(<LightApp gate />);
    await screen.findByRole("status");
    expect(screen.queryByText("the storage notice")).toBeNull();
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

  /**
   * **The gate can close again, once**: a host whose engine stops under an open app says so on
   * the startup status, and what is drawn is the boot screen *instead of* the app — never a
   * shell whose every read now fails quietly.
   */
  describe("when the host says its engine stopped under an open app", () => {
    const STOPPED = {
      state: "failed",
      message: "MTG Grimoire's card engine stopped. Reload to start it again.",
      reload: true,
    };

    it.each([
      ["the phone face", false],
      ["the desktop face", true],
    ])("replaces %s with the host's sentence and a way out", async (face, wide) => {
      stubViewport(wide);
      startupStatus.mockResolvedValue({ state: "ready" });
      render(<LightApp gate />);
      await screen.findByText(face);
      expect(gate.heard).toBeDefined();

      act(() => gate.heard?.(STOPPED));

      expect(screen.getByRole("alert")).toHaveTextContent(
        "MTG Grimoire's card engine stopped. Reload to start it again.",
      );
      expect(screen.getByRole("link", { name: "Reload" })).toBeInTheDocument();
      // The whole app is gone with it, and so is everything mounted beside the faces: nothing
      // left on screen is asking an engine that is not there.
      expect(screen.queryByText(face)).toBeNull();
      expect(screen.queryByText("the storage notice")).toBeNull();
    });

    it("draws it over a face that had already failed by itself, as the one account", async () => {
      // An engine that stops fails the face's own reads too, and a face can throw on one before
      // the gate is heard. The boundary's sentence is then replaced, not left beside the host's.
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      phone.throws = true;
      stubViewport(false);
      startupStatus.mockResolvedValue({ state: "ready" });
      render(<LightApp gate />);
      expect(await screen.findByRole("alert")).toHaveTextContent("This page could not be drawn.");

      act(() => gate.heard?.(STOPPED));

      const alerts = screen.getAllByRole("alert");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toHaveTextContent("card engine stopped");
      expect(screen.getAllByRole("link", { name: "Reload" })).toHaveLength(1);
    });

    it("stays closed across a resize, and whatever the host says next", async () => {
      const resize = stubViewport(false);
      startupStatus.mockResolvedValue({ state: "ready" });
      render(<LightApp gate />);
      await screen.findByText("the phone face");
      const heard = gate.heard;
      act(() => heard?.(STOPPED));

      // Crossing the floor picks a face; it must not bring one back over a dead engine.
      act(() => resize(true));
      // And the listener that heard it is finished: a late `ready` is not an app again.
      act(() => heard?.({ state: "ready" }));

      expect(screen.getByRole("alert")).toHaveTextContent("card engine stopped");
      expect(screen.queryByText("the desktop face")).toBeNull();
      expect(screen.queryByText("the phone face")).toBeNull();
    });
  });
});
