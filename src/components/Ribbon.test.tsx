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

  /**
   * The one consumer of `images::Cache::store_failures`, which counted for a whole plan
   * with nothing reading it. Non-zero means the images on screen are never being cached —
   * invisible otherwise, because they display perfectly and simply re-download forever.
   */
  it("says so in the tooltip when images could not be cached, and stays quiet when they could", () => {
    const { rerender } = render(<Ribbon {...props({ imageStoreFailures: 12 })} />);

    const line = screen.getByText("116,568 cards · data from 2026-08-03");
    expect(line).toHaveAttribute(
      "title",
      "D:\\app\\data\n12 card images could not be saved to the cache — the data folder may be read-only or full.",
    );

    // Singular, because "1 card images" is the sort of thing that makes a reader distrust
    // the number beside it.
    rerender(<Ribbon {...props({ imageStoreFailures: 1 })} />);
    expect(screen.getByText("116,568 cards · data from 2026-08-03")).toHaveAttribute(
      "title",
      "D:\\app\\data\n1 card image could not be saved to the cache — the data folder may be read-only or full.",
    );

    rerender(<Ribbon {...props({ imageStoreFailures: 0 })} />);
    expect(screen.getByText("116,568 cards · data from 2026-08-03")).toHaveAttribute(
      "title",
      "D:\\app\\data",
    );
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
