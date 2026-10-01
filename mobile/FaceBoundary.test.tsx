import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FaceBoundary } from "./FaceBoundary";

function Broken(): never {
  throw new Error("the chunk did not arrive");
}

afterEach(() => vi.restoreAllMocks());

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

    render(
      <FaceBoundary>
        <Broken />
      </FaceBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("This page could not be drawn.");
    // The reader's way out is a real link to where they already are: a fresh document, and the
    // one control here that needs no script to have survived.
    const reload = screen.getByRole("link", { name: "Reload" });
    expect(reload).toHaveAttribute("href", window.location.pathname + window.location.search);
    expect(logged).toHaveBeenCalled();
  });
});
