import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The caption reaches Tauri's window API; the workbench's fake stands in, as in `TitleBar.test.tsx`.
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { RootBoundary } from "./RootBoundary";

function Broken(): never {
  throw new Error("the shell threw");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the desktop's root boundary", () => {
  it("draws its children when nothing throws", () => {
    render(
      <RootBoundary>
        <p>the app</p>
      </RootBoundary>,
    );
    expect(screen.getByText("the app")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the caption and offers a reload when everything under it threw", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <RootBoundary>
        <Broken />
      </RootBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("MTG Grimoire could not be drawn.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    // The window's only caption, and so its only Close (`decorations: false`).
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ message: "the shell threw" }),
      expect.stringContaining("Broken"),
    );
  });
});
