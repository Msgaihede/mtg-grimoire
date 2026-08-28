import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AlreadyOpen } from "@/web/AlreadyOpen";

describe("the second-tab page", () => {
  it("says which app is open and where, in a sentence rather than an error", () => {
    render(<AlreadyOpen />);
    // A regex, because the sentence is one string across two elements and a CSS gap can
    // break an accessible name into "MTG Grimoireis already open".
    expect(screen.getByRole("heading", { name: /already open/i })).toBeInTheDocument();
    expect(screen.getByText(/another tab/i)).toBeInTheDocument();
    // No stack trace, no error code: the reader did nothing wrong.
    expect(screen.queryByText(/NoModificationAllowedError/)).not.toBeInTheDocument();
  });

  it("reloads when the button is pressed", async () => {
    const reload = vi.fn();
    render(<AlreadyOpen onReload={reload} />);
    await userEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
