import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ErrorEntry } from "@/lib/ipc";
import type { ErrorLog } from "@/lib/useErrorLog";
import { ErrorLogPanel, formatWhen } from "./ErrorLogPanel";

const NOW = Math.floor(Date.now() / 1000);

function entry(over: Partial<ErrorEntry> = {}): ErrorEntry {
  return {
    id: 1,
    firstAt: NOW - 600,
    lastAt: NOW - 120,
    source: "scryfall_image",
    operation: "image_fetch",
    kind: "timeout",
    message: "timed out after 10s",
    detail: "https://cards.scryfall.io/art/front/0/0/a1b2.webp?1699999999",
    count: 1,
    ...over,
  };
}

const log = (over: Partial<ErrorLog> = {}): ErrorLog => ({
  entries: [entry()],
  loading: false,
  error: null,
  clear: vi.fn(),
  clearing: false,
  ...over,
});

const panel = () => screen.getByRole("region", { name: "Errors" });

describe("ErrorLogPanel", () => {
  /**
   * An empty screen states the good news plainly. Not "No errors found", which reads as a
   * search that came back empty rather than an app that is working.
   */
  it("says nothing has failed when the log is empty, and offers nothing to clear", () => {
    render(<ErrorLogPanel log={log({ entries: [] })} />);

    expect(screen.getByText("Nothing has failed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  /**
   * A row is named for what the reader controls — card images, app updates — and never for
   * how it is built. `scryfall_image` is a column name, not a thing a person has.
   */
  it("names a failure in the reader's words, with when it last happened", () => {
    render(<ErrorLogPanel log={log()} />);

    const row = within(panel()).getByRole("listitem");
    expect(row).toHaveTextContent("timed out after 10s");
    expect(row).toHaveTextContent("Card images");
    expect(row).toHaveTextContent("Timed out");
    expect(row).toHaveTextContent("2 minutes ago");
    // The URL is what someone debugging actually needs.
    expect(row).toHaveTextContent("cards.scryfall.io/art/front/0/0/a1b2.webp");
  });

  /**
   * The reason the table folds at all. Six hundred failed images are one fault that happened
   * six hundred times, and the count is the only thing that says so.
   */
  it("shows a repeat count, and shows nothing for a fault that happened once", () => {
    const { rerender } = render(<ErrorLogPanel log={log({ entries: [entry({ count: 617 })] })} />);
    expect(within(panel()).getByText("×617")).toBeInTheDocument();

    rerender(<ErrorLogPanel log={log({ entries: [entry({ count: 1 })] })} />);
    expect(within(panel()).queryByText(/^×/)).not.toBeInTheDocument();
  });

  it("clears the log on request", async () => {
    const clear = vi.fn();
    render(<ErrorLogPanel log={log({ clear })} />);

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(clear).toHaveBeenCalledTimes(1);
  });

  /** The log failing to read is its own small irony, and still has to be sayable. */
  it("reports a refusal to read or clear the log", () => {
    render(<ErrorLogPanel log={log({ error: "The database is busy. Try again." })} />);

    expect(screen.getByRole("alert")).toHaveTextContent("The database is busy. Try again.");
  });

  /**
   * The question this panel answers is "is this still going on?", so the boundaries are
   * where the rounding rule has to be right — and a clock that moved backwards must never
   * produce "in -3 minutes".
   */
  it("reads a time relative to now, at every boundary", () => {
    const now = 1_800_000_000_000; // ms
    const at = (secondsAgo: number) => formatWhen(1_800_000_000 - secondsAgo, now);

    expect(at(0)).toBe("just now");
    expect(at(59)).toBe("just now");
    expect(at(60)).toBe("1 minute ago");
    expect(at(120)).toBe("2 minutes ago");
    expect(at(3_599)).toBe("59 minutes ago");
    expect(at(3_600)).toBe("1 hour ago");
    expect(at(86_399)).toBe("23 hours ago");
    expect(at(86_400)).toBe("1 day ago");
    expect(at(172_800)).toBe("2 days ago");
    expect(at(-500)).toBe("just now");
  });
});
