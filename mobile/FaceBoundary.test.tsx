import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { FaceBoundary } from "./FaceBoundary";

function Broken(): never {
  throw new Error("the chunk did not arrive");
}

/** What the host answers `host_update` with: a waiting build's words, or a refusal of the name. */
function host(update: { title: string; action: string } | null) {
  invoke.mockImplementation((command: string) => {
    if (command === "host_update") {
      return update ? Promise.resolve(update) : Promise.reject("no such command");
    }
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  invoke.mockReset();
  host(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("the boundary around a face", () => {
  it("draws its children when nothing throws, and asks the host nothing", () => {
    render(
      <FaceBoundary>
        <p>the face</p>
      </FaceBoundary>,
    );

    expect(screen.getByText("the face")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("says so, and offers a reload, when a face throws — rather than a blank page", async () => {
    // React logs a caught render error itself, and the boundary records it once more.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Somewhere that is not the root, so a link hard-coded to `/` cannot pass for the right one.
    window.history.replaceState(null, "", "/decks/12?card=abc");

    render(
      <FaceBoundary>
        <Broken />
      </FaceBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("This page could not be drawn.");
    // The reader's way out is a real link to where they already are: a fresh document, and the
    // one control here that needs no script to have survived.
    expect(screen.getByRole("link", { name: "Reload" })).toHaveAttribute(
      "href",
      "/decks/12?card=abc",
    );
    // The boundary's own record — the error and the stack of components it came through — which
    // React's log of the same throw does not match.
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ message: "the chunk did not arrive" }),
      expect.stringContaining("Broken"),
    );
    // A host with no newer build to offer leaves the reload standing.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("host_update"));
    expect(screen.getByRole("link", { name: "Reload" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  /**
   * A reload asks the same host for the same build, and a host that lost a file of that build
   * answers the same failure. When it is holding a newer one, that is the way out.
   */
  it("offers the waiting build instead of a reload, in the host's words, when the host has one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    host({ title: "A new version is ready.", action: "Reload to update" });

    render(
      <FaceBoundary>
        <Broken />
      </FaceBoundary>,
    );

    const update = await screen.findByRole("button", { name: "Reload to update" });
    expect(screen.getByText("A new version is ready.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This page could not be drawn.");
    // Not both: a reload here would be a way back into the same failure.
    expect(screen.queryByRole("link", { name: "Reload" })).toBeNull();

    await userEvent.click(update);
    expect(invoke).toHaveBeenCalledWith("host_update_apply");
    expect(update).toHaveAttribute("aria-disabled", "true");
  });
});
