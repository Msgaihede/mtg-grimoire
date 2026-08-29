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
  // The desk shape, which is what every case above the phone block is about. `AppShell` answers
  // this from `useNarrowWindow`; here it is stated, which is the whole benefit of the prop —
  // both shapes are drivable without stubbing `matchMedia` into a component that never asks it.
  narrow: false,
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
    // The status line's own role, not a bare text lookup — the tooltip sweep left this at a
    // mere `toBeInTheDocument()` once the `title="D:\\app\\data"` assertion it replaced no
    // longer applied, which stopped checking that this text lives in the live region
    // `src/CLAUDE.md` documents (`role="status"`, mounted for the ribbon's whole life) rather
    // than merely somewhere on the page. Exact, since a status line that grew a second sentence
    // (as the failures test below shows it can) would still pass a substring check.
    expect(screen.getByRole("status").textContent).toBe("116,568 cards · data from 2026-08-03");
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
    // Exact, not a substring — this leg is the "stays quiet when they could" half of the test's
    // own name, and `toHaveTextContent`'s string form is `.includes()`: a panel that still
    // appended "0 card images could not be saved…" would pass a bare `"D:\\app\\data"` check as
    // readily as a genuinely quiet one. The anchored regex is what actually asserts silence.
    expect(screen.getByRole("tooltip")).toHaveTextContent(/^D:\\app\\data$/, {
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

/**
 * The row at 390px, where the shell has drawn a tab bar instead of a rail and this is the whole
 * width there is.
 *
 * **Every number this block argues from came from a browser and none of it can go red here.**
 * jsdom lays nothing out, so what these cases pin is markup — a class, an attribute, an element's
 * presence — while the widths that decided the arrangement (`Collection` at 125.75 against 78
 * given, the status line at 243.95 against 89, `Refresh data` at 150.91 × 42) were measured in
 * headless Edge over the built stylesheet with the real faces on 2026-08-29 and live in
 * `Ribbon.tsx`'s own comment.
 *
 * The claim under all of it: **nothing here is unmounted at a width.** The title stops being
 * painted and two buttons stop being lettered; the status line is the same element in both
 * shapes, because a live region that only sometimes exists announces nothing.
 */
describe("the ribbon on a phone-width window", () => {
  const phone = (over: Partial<RibbonProps> = {}) => props({ narrow: true, ...over });

  /**
   * `sr-only` and not a conditional render, which is two decisions in one class: the document
   * keeps its only `<h1>`, and `.sr-only` is `position: absolute` so the title leaves the flex
   * row without leaving a `gap-4` behind it.
   */
  it("keeps the heading in the document and stops painting it", () => {
    render(<Ribbon {...phone()} />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Search");
    // `classList.contains`, not `className.includes` — a substring check passes on any class
    // that merely contains the token, and this file has no layout engine to referee it with.
    expect(heading.classList.contains("sr-only")).toBe(true);
  });

  /**
   * The room the title gave up is the room this needed: 350 of content box, less the icon-only
   * Refresh's 50 and one `gap-4`, is 284 against 243.95. Painted, and still `truncate` — what
   * gives when the update button is also up is this line, and a truncated live region still
   * announces the whole sentence.
   */
  it("paints the status line into the room the title gave up", () => {
    render(<Ribbon {...phone()} />);

    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("116,568 cards · data from 2026-08-03");
    expect(line.classList.contains("sr-only")).toBe(false);
    expect(line.classList.contains("truncate")).toBe(true);
  });

  /**
   * **The one this task exists to defend.** A live region that only sometimes exists announces
   * nothing, so shedding the row's contents at a width must not shed this element — narrow and
   * with nothing to say it is still here and still empty, exactly as it is at desk width.
   */
  it("keeps the status line mounted when there is nothing to say", () => {
    render(<Ribbon {...phone({ statusLine: null })} />);

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  /**
   * The difference between a control that shed its label and one that lost it. 150.91px of
   * `Refresh data` was 43% of the window and is the single reason nothing else fitted; the
   * accessible name is untouched, which is why every `/refresh/i` query in this suite and in
   * `AppShell.test.tsx` goes on working without knowing the shape it is in.
   */
  it("keeps Refresh named when it loses its word, and floors it for a finger", () => {
    render(<Ribbon {...phone()} />);

    const refresh = screen.getByRole("button", { name: "Refresh data" });
    // Nothing painted: the glyph is `aria-hidden` and draws no text of its own.
    expect(refresh.textContent).toBe("");
    // The token, never a typed 44 — and an inline style rather than an arbitrary-value class,
    // for `BottomTabBar`'s reason: a mistyped arbitrary value emits nothing at all, silently,
    // with `tsc` and this suite both green.
    expect(refresh).toHaveStyle({ minWidth: "var(--target-min)", minHeight: "var(--target-min)" });
  });

  /**
   * Two labels are two different promises, and shedding the word must not turn them into four.
   * The string is built once and used as the paint or as the name, never written twice.
   */
  it("keeps the update button's two promises when it loses its words", () => {
    const { rerender } = render(
      <Ribbon {...phone({ updateVersion: "0.3.0", updateInstallable: true })} />,
    );

    const installable = screen.getByRole("button", { name: "Update to 0.3.0" });
    expect(installable.textContent).toBe("");
    expect(installable).toHaveStyle({ minHeight: "var(--target-min)" });

    rerender(<Ribbon {...phone({ updateVersion: "0.3.0", updateInstallable: false })} />);
    expect(screen.getByRole("button", { name: "0.3.0 available" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Update to/ })).toBeNull();
  });

  /**
   * The other half of every assertion above, and it is what makes the shedding a *choice* rather
   * than a change: at desk width the title is painted, both buttons are lettered, and no touch
   * floor is written — 1032px of row is not a place that has to decide any of this.
   */
  it("draws all of it at desk width", () => {
    render(<Ribbon {...props({ updateVersion: "0.3.0", updateInstallable: true })} />);

    expect(screen.getByRole("heading", { level: 1 }).classList.contains("sr-only")).toBe(false);
    expect(screen.getByRole("button", { name: "Refresh data" })).toHaveTextContent("Refresh data");
    expect(screen.getByRole("button", { name: "Update to 0.3.0" })).toHaveTextContent(
      "Update to 0.3.0",
    );
    expect(screen.getByRole("button", { name: "Refresh data" })).not.toHaveStyle({
      minHeight: "var(--target-min)",
    });
  });
});
