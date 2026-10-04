import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BootScreen } from "./BootScreen";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("the boot screen", () => {
  it("says the collection is opening, and offers nothing to press", () => {
    render(<BootScreen status={{ state: "loading" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Opening your collection…");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("draws a failure in the host's words, with no way out the host did not offer", () => {
    render(<BootScreen status={{ state: "failed", message: "user.db is locked." }} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("user.db is locked.");
    // A data folder that would not open will not open on a second try: no Reload to press.
    expect(screen.queryByRole("link")).toBeNull();
    expect(alert.classList.contains("text-destructive")).toBe(true);
  });

  it("offers a reload, to where the reader already is, when the host says one can cure it", () => {
    // Somewhere that is not the root, so a link hard-coded to `/` cannot pass for the right one.
    window.history.replaceState(null, "", "/decks/12?card=abc");
    render(
      <BootScreen
        status={{
          state: "failed",
          message: "MTG Grimoire is already open in another tab of this browser.",
          reload: true,
        }}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("already open in another tab");
    expect(screen.getByRole("link", { name: "Reload" })).toHaveAttribute(
      "href",
      "/decks/12?card=abc",
    );
    // Told plainly, not as a fault: the reader did nothing wrong and neither did the app.
    expect(alert.classList.contains("text-destructive")).toBe(false);
  });
});
