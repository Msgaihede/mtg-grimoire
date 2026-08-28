import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UpdateReadyBar } from "@/pwa/UpdateReadyBar";

describe("the update bar", () => {
  it("is not on screen until a build is waiting", () => {
    render(<UpdateReadyBar ready={false} onApply={() => {}} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says what is ready and offers the press that takes it", async () => {
    const onApply = vi.fn();
    render(<UpdateReadyBar ready onApply={onApply} />);
    expect(screen.getByRole("status")).toHaveTextContent(/A new version is ready/);
    await userEvent.click(screen.getByRole("button", { name: /Reload to update/ }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  /**
   * Non-modal is the spec's word and this is what it costs to keep. A dialog role, an
   * `aria-modal`, or anything that took focus would interrupt a reader mid-deck — which is
   * exactly the outcome §5.4 says to avoid.
   */
  it("does not claim to be a dialog and does not take focus", () => {
    render(<UpdateReadyBar ready onApply={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).not.toHaveAttribute("aria-modal");
    expect(document.body).toHaveFocus();
  });
});
