import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HeldChip, HoldPrompt, ShotReadyPill, StoppedVeil } from "./PictureNotes";

describe("PictureNotes", () => {
  it("says the scanner is stopped, the title in the heading face", () => {
    render(<StoppedVeil />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Scanning stopped");
    expect(status).toHaveTextContent("Press Start to begin. The camera stays on.");
    expect(screen.getByText("Scanning stopped").classList.contains("font-heading")).toBe(true);
  });

  it("asks for a card between two shots", () => {
    render(<ShotReadyPill />);
    expect(screen.getByRole("status")).toHaveTextContent("Point at a card, then press Scan card.");
  });

  it("says how the picture is held, in full and compact", () => {
    const { rerender } = render(<HoldPrompt />);
    expect(screen.getByText("Hold the picture to scan")).toBeInTheDocument();
    expect(screen.getByText("Scanning pauses the moment you let go.")).toBeInTheDocument();
    rerender(<HoldPrompt compact />);
    expect(screen.getByText("Hold the picture to scan")).toBeInTheDocument();
    expect(screen.getByText("Scanning pauses the moment you let go.")).toBeInTheDocument();
  });

  it("says a held picture is scanning", () => {
    render(<HeldChip />);
    expect(screen.getByText("Scanning")).toBeInTheDocument();
  });

  /**
   * A note over the picture is never in the way of a press: under the phone's point and shoot the
   * picture itself is what a finger holds, and a prompt that caught the touch would be a dead spot
   * in the middle of it.
   */
  it("lets every press through to the picture", () => {
    for (const Note of [StoppedVeil, ShotReadyPill, HoldPrompt, HeldChip]) {
      const { container, unmount } = render(<Note />);
      expect(container.firstElementChild?.classList.contains("pointer-events-none")).toBe(true);
      unmount();
    }
  });
});
