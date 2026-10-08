import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ManaLine } from "./ManaLine";

describe("ManaLine", () => {
  /**
   * At rest it is decoration — the app's signature, carrying no information a screen
   * reader could use. Announcing a 0% progress bar on every screen would be noise.
   */
  it("is a silent rule when nothing is syncing", () => {
    const { container } = render(<ManaLine sync={null} />);

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });

  it("becomes the progress bar during a sync", () => {
    render(<ManaLine sync={{ value: 0.42, label: "Downloading card data" }} />);

    const bar = screen.getByRole("progressbar", { name: "Downloading card data" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  /** `aria-valuenow="0"` would be a claim that no progress has been made; omitting it is
   *  ARIA's way of saying the length is unknown. */
  it("omits the value when the phase has no denominator", () => {
    render(<ManaLine sync={{ value: null, label: "Checking for card data updates" }} />);

    const bar = screen.getByRole("progressbar", { name: /checking/i });
    expect(bar).not.toHaveAttribute("aria-valuenow");
  });
});
