import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Ribbon, type RibbonProps } from "./Ribbon";

const props = (over: Partial<RibbonProps> = {}): RibbonProps => ({
  title: "Search",
  statusLine: "116,568 cards · data from 2026-08-03",
  dataDir: "D:\\app\\data",
  busy: false,
  upToDate: false,
  hasError: false,
  onRefresh: vi.fn(),
  sync: null,
  ...over,
});

describe("Ribbon", () => {
  /** Global actions live here now, not in a view — that is the whole point of the row. */
  it("carries the view title, the status line and Refresh", () => {
    render(<Ribbon {...props()} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Search");
    expect(screen.getByText("116,568 cards · data from 2026-08-03")).toHaveAttribute(
      "title",
      "D:\\app\\data",
    );
    expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled();
  });

  it("runs and then refuses a second sync while one is in flight", async () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<Ribbon {...props({ onRefresh })} />);

    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(<Ribbon {...props({ onRefresh, busy: true })} />);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
  });

  it("says a Refresh found nothing, and only when there is nothing louder to say", () => {
    const { rerender } = render(<Ribbon {...props({ upToDate: true })} />);
    expect(screen.getByText(/already up to date/i)).toBeInTheDocument();

    // An error banner is showing below; repeating a cheerful line beside it is noise.
    rerender(<Ribbon {...props({ upToDate: true, hasError: true })} />);
    expect(screen.queryByText(/already up to date/i)).not.toBeInTheDocument();
  });

  it("hands the sync to the mana line", () => {
    render(<Ribbon {...props({ busy: true, sync: { value: 0.5, label: "Importing cards" } })} />);

    expect(screen.getByRole("progressbar", { name: "Importing cards" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
  });
});
