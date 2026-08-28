import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const open = vi.hoisted(() => vi.fn());
const call = vi.hoisted(() => vi.fn());
const buildCorpus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/core/browser", () => ({ browserCore: { open, call, buildCorpus } }));
// The real App mounts the whole product. What this suite is about is which of four things
// gets rendered, so the heaviest one stands in for itself.
vi.mock("@/App", () => ({ default: () => <div>the app</div> }));

import { WebBoot } from "@/web/WebBoot";

/**
 * What `glue::open` actually answers on the web target: **both** journals, because the data
 * folder is two files and the OPFS pool refuses WAL on each, and the **user** file's schema
 * version, which is the number that gates compatibility. Spelled once so a mock cannot drift
 * into a shape the Rust side never sends — 26 is the frozen single-file version and no user
 * file is ever on it.
 */
const READY = {
  kind: "ready",
  journal: "delete",
  corpusJournal: "delete",
  schemaVersion: 27,
} as const;

beforeEach(() => {
  open.mockReset();
  call.mockReset();
  buildCorpus.mockReset();
});

describe("the web boot", () => {
  it("renders the app once the database is open and a corpus is there", async () => {
    open.mockResolvedValue(READY);
    call.mockResolvedValue({ cardCount: 117464 });
    render(<WebBoot />);
    expect(await screen.findByText("the app")).toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(1);
  });

  /** The whole point of the guard: a second tab gets a sentence, never the app. */
  it("renders the second-tab page instead of the app when the database is held elsewhere", async () => {
    open.mockResolvedValue({ kind: "already-open" });
    render(<WebBoot />);
    expect(await screen.findByRole("heading", { name: /already open/i })).toBeInTheDocument();
    expect(screen.queryByText("the app")).not.toBeInTheDocument();
    // And no command is attempted against a database this tab does not have.
    expect(call).not.toHaveBeenCalled();
  });

  it("offers to build the corpus when the database is open and empty", async () => {
    open.mockResolvedValue(READY);
    call.mockResolvedValue({ cardCount: 0 });
    render(<WebBoot />);
    expect(await screen.findByRole("button", { name: /build/i })).toBeInTheDocument();
    expect(screen.queryByText("the app")).not.toBeInTheDocument();
  });

  it("shows the running count while the corpus is being built, then the app", async () => {
    open.mockResolvedValue(READY);
    call.mockResolvedValueOnce({ cardCount: 0 }).mockResolvedValue({ cardCount: 117464 });
    // The ingest ends when this test says so, and never on a timer. A `setTimeout(0)` here
    // fires inside `userEvent.click`'s own trailing wait — measured 2026-08-28: the corpus
    // resolved, `onDone` ran, and the page was already showing `the app` by the time
    // `report(24000)` reached a component that had been unmounted. The count assertion then
    // failed against a body containing nothing but `the app`. Holding the resolver is what
    // makes this a test of the running state rather than a race with the click.
    let report: ((n: number) => void) | undefined;
    let finish: (() => void) | undefined;
    buildCorpus.mockImplementation((_url: string, onProgress: (n: number) => void) => {
      report = onProgress;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    render(<WebBoot />);
    await userEvent.click(await screen.findByRole("button", { name: /build/i }));
    report?.(24000);
    // Grouped, because 117 464 rows read as a phone number otherwise.
    expect(await screen.findByText(/24,000/)).toBeInTheDocument();
    finish?.();
    expect(await screen.findByText("the app")).toBeInTheDocument();
  });

  it("says what went wrong rather than showing a blank page", async () => {
    open.mockResolvedValue({ kind: "failed", message: "QuotaExceededError: out of space" });
    render(<WebBoot />);
    expect(await screen.findByText(/QuotaExceededError/)).toBeInTheDocument();
  });
});
