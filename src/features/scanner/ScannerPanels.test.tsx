import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import { DEFAULT_SCANNER_OPTIONS, DEFAULT_SEND_PX } from "./scannerOptions";
import { ScannerPanels, type ScannerPanelsProps } from "./ScannerPanels";
import { READS, STATUS, VERDICTS } from "./fixtures";
import type { ScannerVerdict } from "./types";

function props(over: Partial<ScannerPanelsProps> = {}): ScannerPanelsProps {
  return {
    status: STATUS.present,
    verdict: VERDICTS.voting,
    lastOcr: null,
    lastCollector: null,
    // A real `performance.now()` delta rather than a whole number: a `180` here passes whether
    // the panel rounds or interpolates, which is how `288.39999999999998 ms` reached the shipped
    // window. **The digits have to survive being parsed** — that exact literal is the same
    // double as `288.4` and `String()`s back as `"288.4"`, so it would assert nothing. This one
    // round-trips long, and the assertion below is what pins the rounding.
    roundTripMs: 288.4000000000001,
    rate: 5.6,
    options: DEFAULT_SCANNER_OPTIONS,
    sendPx: DEFAULT_SEND_PX,
    onOptions: vi.fn(),
    onSendPx: vi.fn(),
    onReset: vi.fn(),
    onCapture: vi.fn(async () => "live-1.jpg"),
    ...over,
  };
}

/** Every panel folded away, which is where the store starts. */
const ALL_FOLDED = {
  controls: false,
  pipeline: false,
  budget: false,
  rectified: false,
  readouts: false,
} as const;

/**
 * The two reads as the panels take them — **props, not fields of the frame**.
 *
 * Every shared verdict fixture has `ocr: null` and `collector: null`, and that is the ordinary
 * frame rather than an omission: the tiers run on one eligible frame in four. `useScanLoop`
 * keeps the last of each, so these arrive beside the verdict. Both are deliberately *failed*
 * reads — the two "could not resolve" fallbacks and the truncated pairings list are the rows
 * with somewhere to go wrong.
 */
const withReads = { lastOcr: READS.ocr, lastCollector: READS.collector } as const;

beforeEach(() => {
  useAppStore.setState({ scannerFolds: { ...ALL_FOLDED } });
});

describe("the match panel", () => {
  it("draws the vote rule's verdict, bar, tally, lead and standings", () => {
    render(<ScannerPanels {...props()} />);
    const match = screen.getByRole("region", { name: "Match" });
    // One level under the view's own `<h2>Scanner</h2>`: a panel heading level-equal with the
    // view's reads as six views to a screen reader's heading list.
    expect(within(match).getByRole("heading", { level: 3, name: "Match" })).toBeInTheDocument();
    expect(within(match).getByText("Plains — 2XM 373")).toBeInTheDocument();
    expect(within(match).getByText("voting")).toBeInTheDocument();
    expect(within(match).getByText("5.0/8 · 12f")).toBeInTheDocument();
    expect(within(match).getByText("×4.0")).toBeInTheDocument();
    expect(within(match).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "63");
    const rows = within(match).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Plains · 2XM 373");
    expect(rows[0]).toHaveTextContent("5.0");
  });

  it("says decided at the bar and fills it", () => {
    render(<ScannerPanels {...props({ verdict: VERDICTS.decided })} />);
    const match = screen.getByRole("region", { name: "Match" });
    expect(within(match).getByText("decided")).toBeInTheDocument();
    expect(within(match).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(within(match).getByText("unopposed")).toBeInTheDocument();
  });

  it("keeps the confidence rule's words and percentage", () => {
    render(<ScannerPanels {...props({ verdict: VERDICTS.confidence })} />);
    const match = screen.getByRole("region", { name: "Match" });
    expect(within(match).getByText("confirmed")).toBeInTheDocument();
    expect(within(match).getByText("80% over 12f")).toBeInTheDocument();
    expect(within(match).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "80");
  });

  it("names the missing bundle and where it looked, in place of a verdict", () => {
    render(<ScannerPanels {...props({ status: STATUS.missing, verdict: VERDICTS.noCard })} />);
    // The path and the restart clause both matter and both belong to `verdictText.test.ts`,
    // which pins the wording; what this file owes is that the sentence reached the panel.
    expect(
      screen.getByText(/^No reference bundle\. Put .card-hashes\.bin. at .+\. Restart the app/),
    ).toBeInTheDocument();
    expect(screen.queryByText("voting")).not.toBeInTheDocument();
  });

  /**
   * A bundle that is *there* and did not parse. The panel used to print the placement sentence
   * — an instruction to put a file where that file already is — and `Asset.error`, the only
   * thing saying why, was rendered nowhere at all.
   */
  it("gives a present-but-unreadable bundle its own reason, not an instruction", () => {
    render(<ScannerPanels {...props({ status: STATUS.corrupt, verdict: VERDICTS.noCard })} />);
    expect(screen.getByText(/did not load: bad magic/)).toBeInTheDocument();
    expect(screen.queryByText(/No reference bundle/)).not.toBeInTheDocument();
  });

  /**
   * Labels that failed under a bundle that did not. The scanner matches and answers ids, so
   * the sentence goes **under** the verdict rather than in place of it — the head row still
   * carries a name, and `voting` still says what the tracker is doing.
   */
  it("says the names failed without taking the verdict's place", () => {
    render(<ScannerPanels {...props({ status: STATUS.unlabelled })} />);
    const match = screen.getByRole("region", { name: "Match" });
    expect(within(match).getByText(/Bundle loaded, but its names did not/)).toBeInTheDocument();
    expect(within(match).getByText("Plains — 2XM 373")).toBeInTheDocument();
    expect(within(match).getByText("voting")).toBeInTheDocument();
  });

  it("resets and captures through its two buttons", async () => {
    const p = props();
    render(<ScannerPanels {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Reset evidence" }));
    expect(p.onReset).toHaveBeenCalledOnce();
    await userEvent.type(screen.getByRole("textbox", { name: "What it actually is" }), "Plains");
    await userEvent.click(screen.getByRole("button", { name: "Add frame to dataset" }));
    expect(p.onCapture).toHaveBeenCalledWith("Plains");
    expect(await screen.findByText("saved live-1.jpg")).toBeInTheDocument();
  });

  it("says why a capture did not land, in the same line", async () => {
    const p = props({
      onCapture: vi.fn(async () => Promise.reject(new Error("scans dir is gone"))),
    });
    render(<ScannerPanels {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Add frame to dataset" }));
    expect(await screen.findByText("scans dir is gone")).toBeInTheDocument();
  });
});

describe("the folded panels", () => {
  it("start folded, open on their heading, and remember it in the store", async () => {
    render(<ScannerPanels {...props()} />);
    const heading = screen.getByRole("button", { name: "Controls" });
    expect(heading).toHaveAttribute("aria-expanded", "false");
    // The body is unmounted while folded, so pointing at its id would be a dangling IDREF.
    expect(heading).not.toHaveAttribute("aria-controls");
    expect(screen.queryByRole("slider", { name: "decide at" })).not.toBeInTheDocument();
    await userEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "true");
    // Open, it points at the body — and the IDREF is checked by *resolving* it rather than by
    // comparing it to the id this test would have had to write down itself.
    const target = heading.getAttribute("aria-controls") ?? "";
    expect(document.getElementById(target)).toContainElement(
      screen.getByRole("slider", { name: "decide at" }),
    );
    expect(useAppStore.getState().scannerFolds.controls).toBe(true);
  });

  it("writes a slider and a segment through onOptions", async () => {
    const p = props();
    useAppStore.setState({ scannerFolds: { ...ALL_FOLDED, controls: true } });
    render(<ScannerPanels {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "confidence" }));
    expect(p.onOptions).toHaveBeenLastCalledWith({
      ...DEFAULT_SCANNER_OPTIONS,
      rule: "confidence",
    });
    // `fireEvent.change` rather than typing: a range input has no caret.
    const slider = screen.getByRole("slider", { name: "decide at" });
    fireEvent.change(slider, { target: { value: "12" } });
    expect(p.onOptions).toHaveBeenLastCalledWith({ ...DEFAULT_SCANNER_OPTIONS, decide_at: 12 });
  });

  it("sends the send-px slider to its own writer", () => {
    const p = props();
    useAppStore.setState({ scannerFolds: { ...ALL_FOLDED, controls: true } });
    render(<ScannerPanels {...p} />);
    fireEvent.change(screen.getByRole("slider", { name: "send px" }), {
      target: { value: "1120" },
    });
    expect(p.onSendPx).toHaveBeenLastCalledWith(1120);
    expect(p.onOptions).not.toHaveBeenCalled();
  });

  it("shows the budget's six stages and the readouts' two reads when open", () => {
    useAppStore.setState({ scannerFolds: { ...ALL_FOLDED, budget: true, readouts: true } });
    render(<ScannerPanels {...props({ verdict: VERDICTS.decided })} />);
    const budget = screen.getByRole("region", { name: "Frame budget" });
    for (const k of ["decode", "resize", "mask", "contour", "rectify", "transport"]) {
      expect(within(budget).getByText(k)).toBeInTheDocument();
    }
    // Rounded like the six rows above it: the prop is `288.4000000000001`, which is what a
    // `performance.now()` delta really looks like and what the row used to print verbatim.
    expect(within(budget).getByText("288.4 ms")).toBeInTheDocument();
    expect(within(budget).queryByText("288.4000000000001 ms")).not.toBeInTheDocument();
    const readouts = screen.getByRole("region", { name: "Readouts" });
    expect(within(readouts).getByText(/Storm of Saruman/)).toBeInTheDocument();
  });

  it("says what each tier read and what it could not resolve", () => {
    useAppStore.setState({ scannerFolds: { ...ALL_FOLDED, readouts: true } });
    render(<ScannerPanels {...props(withReads)} />);
    const readouts = screen.getByRole("region", { name: "Readouts" });
    expect(within(readouts).getByText("5torm of 5aruman!")).toBeInTheDocument();
    expect(within(readouts).getByText("no name")).toBeInTheDocument();
    expect(within(readouts).getByText("no printing")).toBeInTheDocument();
    expect(within(readouts).getByText("LTR 72 → —")).toBeInTheDocument();
    expect(within(readouts).getByText("+3 more pairings not shown")).toBeInTheDocument();
  });

  /**
   * **The readers run on one eligible frame in four**, so `verdict.ocr` is `null` on most
   * frames and this is the ordinary case rather than an edge one. Read off the current verdict
   * the panel blinked "(nothing read)" three frames in four on a card it had read correctly;
   * the loop keeps the last of each, and the panel draws that.
   *
   * The verdict here is `voting`, whose `ocr` and `collector` are both `null` — so a panel that
   * went back to reading the frame would show two em dashes and fail every line below.
   */
  it("draws the last read on a frame that carried none", () => {
    useAppStore.setState({ scannerFolds: { ...ALL_FOLDED, readouts: true } });
    expect(VERDICTS.voting.ocr).toBeNull();
    expect(VERDICTS.voting.collector).toBeNull();
    render(<ScannerPanels {...props({ verdict: VERDICTS.voting, ...withReads })} />);
    const readouts = screen.getByRole("region", { name: "Readouts" });
    expect(within(readouts).getByText("5torm of 5aruman!")).toBeInTheDocument();
    expect(within(readouts).getByText("0072 LTR")).toBeInTheDocument();
    expect(within(readouts).queryByText("(nothing read)")).not.toBeInTheDocument();
    // The Match panel's own `collector` row is the same read in the one panel that never folds,
    // and it flickered the same way while it read `verdict.collector`.
    const match = screen.getByRole("region", { name: "Match" });
    expect(within(match).getByText("[0072 LTR] no printing")).toBeInTheDocument();
  });

  /** Nothing read yet is still two em dashes and two empty bands — the state before a read. */
  it("says nothing read where the loop is holding no read at all", () => {
    useAppStore.setState({ scannerFolds: { ...ALL_FOLDED, readouts: true } });
    render(<ScannerPanels {...props()} />);
    const readouts = screen.getByRole("region", { name: "Readouts" });
    expect(within(readouts).getAllByText("(nothing read)").length).toBe(2);
    expect(within(readouts).queryByRole("img")).not.toBeInTheDocument();
  });

  it("says the models are missing inside the readouts", () => {
    useAppStore.setState({ scannerFolds: { ...ALL_FOLDED, readouts: true } });
    render(<ScannerPanels {...props({ status: STATUS.noModels })} />);
    expect(screen.getByText(/No OCR models\. Put/)).toBeInTheDocument();
  });

  it("draws the pipeline's three stage crops only where the options asked for them", () => {
    useAppStore.setState({ scannerFolds: { ...ALL_FOLDED, pipeline: true } });
    const staged: ScannerVerdict = {
      ...VERDICTS.voting,
      stages: {
        binary: "data:image/png;base64,iVBORw0KGgo=",
        contours: "data:image/png;base64,iVBORw0KGgo=",
        quad: "data:image/png;base64,iVBORw0KGgo=",
      },
    };
    const { rerender } = render(<ScannerPanels {...props({ verdict: staged })} />);
    expect(screen.queryByRole("region", { name: "Pipeline" })).not.toBeInTheDocument();

    rerender(
      <ScannerPanels
        {...props({ verdict: staged, options: { ...DEFAULT_SCANNER_OPTIONS, stages: true } })}
      />,
    );
    const pipeline = screen.getByRole("region", { name: "Pipeline" });
    expect(within(pipeline).getByRole("img", { name: "mask" })).toBeInTheDocument();
    expect(within(pipeline).getByRole("img", { name: "contours" })).toBeInTheDocument();
    expect(within(pipeline).getByRole("img", { name: "quad" })).toBeInTheDocument();
  });

  it("draws the rectification and its geometry when open", () => {
    useAppStore.setState({ scannerFolds: { ...ALL_FOLDED, rectified: true } });
    render(<ScannerPanels {...props()} />);
    const rectified = screen.getByRole("region", { name: "Rectified" });
    expect(within(rectified).getByRole("img", { name: "the rectified card" })).toBeInTheDocument();
    expect(within(rectified).getByText("0.716")).toBeInTheDocument();
    expect(within(rectified).getByText("58.0%")).toBeInTheDocument();
  });

  it("says there is no rectification where the frame had no card", () => {
    useAppStore.setState({ scannerFolds: { ...ALL_FOLDED, rectified: true } });
    render(<ScannerPanels {...props({ verdict: VERDICTS.noCard })} />);
    const rectified = screen.getByRole("region", { name: "Rectified" });
    expect(within(rectified).getByText("no rectification")).toBeInTheDocument();
    expect(within(rectified).queryByRole("img")).not.toBeInTheDocument();
  });
});
