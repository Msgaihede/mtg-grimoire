import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FaceBoundary } from "./FaceBoundary";

function Broken(): never {
  throw new Error("the chunk did not arrive");
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("the boundary around a face", () => {
  it("draws its children when nothing throws", () => {
    render(
      <FaceBoundary>
        <p>the face</p>
      </FaceBoundary>,
    );

    expect(screen.getByText("the face")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so, and offers a reload, when a face throws — rather than a blank page", () => {
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
  });
});
