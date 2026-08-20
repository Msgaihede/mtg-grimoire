import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TOOLTIP_OPEN_MS, TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { RANK, type Activity } from "@/lib/activity";
import { Ribbon, type RibbonProps } from "./Ribbon";

const mount = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const fireHover = (el: HTMLElement) => {
  fireEvent.pointerEnter(el);
  advance(TOOLTIP_OPEN_MS);
};
const fireLeave = (el: HTMLElement) => fireEvent.pointerLeave(el);

const props = (over: Partial<RibbonProps> = {}): RibbonProps => ({
  title: "Search",
  statusLine: "116,568 cards · data from 2026-08-03",
  dataDir: "D:\\app\\data",
  busy: false,
  upToDate: false,
  hasError: false,
  onRefresh: vi.fn(),
  activity: null,
  activityVisible: false,
  ...over,
});

const importing: Activity = {
  key: "sync",
  rank: RANK.sync,
  label: "Importing cards",
  detail: "83,000 cards",
  value: 0.5,
};

describe("Ribbon", () => {
  /** Global actions live here now, not in a view — that is the whole point of the row. */
  it("carries the view title, the status line and Refresh", () => {
    render(<Ribbon {...props()} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Search");
    expect(screen.getByText("116,568 cards · data from 2026-08-03")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled();
  });

  /**
   * The one consumer of `images::Cache::store_failures`, which counted for a whole plan
   * with nothing reading it. Non-zero means the images on screen are never being cached —
   * invisible otherwise, because they display perfectly and simply re-download forever.
   *
   * Through `useTooltip()` rather than a native `title` now — the words are a *description* of
   * the status line (spec §3's data-dir hint plus this), so they bind with the tooltip's
   * default `describes: true` and the panel carries `role="tooltip"`.
   */
  it("says so in the tooltip when images could not be cached, and stays quiet when they could", () => {
    vi.useFakeTimers();
    const { rerender } = mount(<Ribbon {...props({ imageStoreFailures: 12 })} />);

    const line = () => screen.getByText("116,568 cards · data from 2026-08-03");
    // `normalizeWhitespace: false`, so the literal `\n` the tooltip joins its two sentences with
    // is checked rather than collapsed to a space — `whitespace-pre-line` on the panel is what
    // keeps that break, and a normalized comparison would pass even if the join lost it.
    fireHover(line());
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "D:\\app\\data\n12 card images could not be saved to the cache — the data folder may be read-only or full.",
      { normalizeWhitespace: false },
    );
    fireLeave(line());

    // Singular, because "1 card images" is the sort of thing that makes a reader distrust
    // the number beside it.
    rerender(
      <TooltipProvider>
        <Ribbon {...props({ imageStoreFailures: 1 })} />
      </TooltipProvider>,
    );
    fireHover(line());
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "D:\\app\\data\n1 card image could not be saved to the cache — the data folder may be read-only or full.",
      { normalizeWhitespace: false },
    );
    fireLeave(line());

    rerender(
      <TooltipProvider>
        <Ribbon {...props({ imageStoreFailures: 0 })} />
      </TooltipProvider>,
    );
    fireHover(line());
    expect(screen.getByRole("tooltip")).toHaveTextContent("D:\\app\\data", {
      normalizeWhitespace: false,
    });
    vi.useRealTimers();
  });

  it("runs and then refuses a second sync while one is in flight", async () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<Ribbon {...props({ onRefresh })} />);

    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(<Ribbon {...props({ onRefresh, busy: true })} />);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
  });

  it("says a Refresh found nothing, and only when there is nothing louder to say", async () => {
    const { rerender } = render(<Ribbon {...props({ upToDate: true })} />);
    expect(screen.getByText(/already up to date/i)).toBeInTheDocument();

    // An error banner is showing below; repeating a cheerful line beside it is noise.
    rerender(<Ribbon {...props({ upToDate: true, hasError: true })} />);
    // `waitFor` and not a bare assertion, because the line **fades out** rather than
    // vanishing: `AnimatePresence` holds the element until its exit finishes, so it is still
    // in the document for the frame after the rerender. The claim is unchanged — a line that
    // never left would still time out here — only the moment it is read.
    await waitFor(() => expect(screen.queryByText(/already up to date/i)).not.toBeInTheDocument());
  });

  it("hands the job to the mana line, whether or not the row has room to say so", () => {
    render(<Ribbon {...props({ busy: true, activity: importing })} />);

    // The line reacts to the job immediately; only the sentence waits.
    expect(screen.getByRole("progressbar", { name: "Importing cards" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
  });

  /**
   * The whole feature: for ninety seconds the row used to go on reading "116,568 cards",
   * which is the one sentence least about what is happening.
   */
  it("says what the app is doing, and gives the summary back when it stops", () => {
    const { rerender } = render(
      <Ribbon {...props({ busy: true, activity: importing, activityVisible: true })} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Importing cards · 83,000 cards");
    expect(screen.queryByText(/116,568 cards/)).not.toBeInTheDocument();

    rerender(<Ribbon {...props()} />);

    expect(screen.getByRole("status")).toHaveTextContent("116,568 cards · data from 2026-08-03");
  });

  /**
   * A live region announces its accessible text, and skips `aria-hidden` subtrees. The label
   * changes about four times in a sync and is worth hearing; the number changes fifty-eight
   * times during the ingest alone, and the mana line's `aria-valuenow` already carries it.
   */
  it("announces the phase and not the number", () => {
    render(<Ribbon {...props({ busy: true, activity: importing, activityVisible: true })} />);

    expect(screen.getByText(/83,000 cards/, { selector: "span" })).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  /**
   * A live region that first appears with its sentence already inside it announces nothing —
   * the lesson the sidebar's drop report and the card pane's swap report both cost. So the
   * line is mounted from the start and is merely empty.
   */
  it("keeps the status line mounted before it has anything to say", () => {
    render(<Ribbon {...props({ statusLine: null })} />);

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("stays out of the way when there is no update", () => {
    render(<Ribbon {...props()} />);
    expect(screen.queryByRole("button", { name: /update|available/i })).not.toBeInTheDocument();
  });

  /**
   * The two labels are two different promises, and that is the whole reason there are two.
   * A portable or NSIS install really can replace itself; an MSI install and every Linux
   * build can only be shown where to download. "Update to 0.3.0" on one of those is the
   * interface promising something no code behind it can do.
   */
  it("promises an update only where one can actually be installed", () => {
    const { rerender } = render(
      <Ribbon {...props({ updateVersion: "0.3.0", updateInstallable: true })} />,
    );
    expect(screen.getByRole("button", { name: "Update to 0.3.0" })).toBeInTheDocument();

    rerender(<Ribbon {...props({ updateVersion: "0.3.0", updateInstallable: false })} />);
    expect(screen.queryByRole("button", { name: /^Update to/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "0.3.0 available" })).toBeInTheDocument();
  });

  it("opens the update panel rather than doing anything itself", async () => {
    const onOpenUpdate = vi.fn();
    const onRefresh = vi.fn();
    render(
      <Ribbon
        {...props({ updateVersion: "0.3.0", updateInstallable: true, onOpenUpdate, onRefresh })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Update to 0.3.0" }));
    expect(onOpenUpdate).toHaveBeenCalledOnce();
    // Two buttons on one row that both start something long-running: they must not be the
    // same button by accident.
    expect(onRefresh).not.toHaveBeenCalled();
  });

  /**
   * A sync is the app's other long job, and it disables Refresh. The update button is about
   * a different service entirely and stays pressable — the panel it opens reads nothing a
   * sync is writing.
   */
  it("stays available while a sync is running", () => {
    render(<Ribbon {...props({ updateVersion: "0.3.0", updateInstallable: true, busy: true })} />);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Update to 0.3.0" })).toBeEnabled();
  });
});
