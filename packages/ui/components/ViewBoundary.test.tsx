import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewBoundary } from "./ViewBoundary";

/** A view that throws until told not to — the retry's whole question. */
const state = { broken: true };
function View() {
  if (state.broken) throw new Error("a row it did not expect");
  return <p>the view</p>;
}

afterEach(() => {
  state.broken = true;
  vi.restoreAllMocks();
});

describe("the boundary around a view", () => {
  it("draws its children when nothing throws", () => {
    render(
      <ViewBoundary>
        <p>the view</p>
      </ViewBoundary>,
    );
    expect(screen.getByText("the view")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so in the view's box, beside what was left standing, rather than blanking", () => {
    // React logs a caught render error itself, and the boundary records it once more.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <>
        <header>the caption</header>
        <ViewBoundary>
          <View />
        </ViewBoundary>
      </>,
    );

    expect(screen.getByText("the caption")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This view could not be drawn.");
    expect(screen.getByRole("alert")).toHaveTextContent("a row it did not expect");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    // The boundary's own record: the error and the components it came through.
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ message: "a row it did not expect" }),
      expect.stringContaining("View"),
    );
  });

  it("draws the view again on Try again, once it no longer throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ViewBoundary>
        <View />
      </ViewBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    state.broken = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("the view")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
