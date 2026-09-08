import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import { DEFAULT_SCANNER_OPTIONS, DEFAULT_SEND_PX } from "./scannerOptions";
import { ScannerPanels, type ScannerPanelsProps } from "./ScannerPanels";
import { STATUS, VERDICTS } from "./fixtures";
import type { ScannerVerdict } from "./types";

function props(over: Partial<ScannerPanelsProps> = {}): ScannerPanelsProps {
  return {
    status: STATUS.present,
    verdict: VERDICTS.voting,
    roundTripMs: 180,
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
 * A voting frame that also carries both OCR tiers' reads, neither of which resolved.
 *
 * Built here rather than taken from `fixtures.ts`: every shared fixture has `ocr: null` and
 * `collector: null` — the tiers run on one frame in a few, so a null there is the ordinary case
 * and is what the other tests exercise. This is the other half, and it is a *failed* pair of
 * reads on purpose: the two "could not resolve" fallbacks and the truncated pairings list are
 * the rows with somewhere to go wrong.
 */
const withReads: ScannerVerdict = {
  ...VERDICTS.voting,
  ocr: {
    raw: "5torm of 5aruman!",
    normalized: "5torm of 5aruman",
    rotated: false,
    elapsed_ms: 41.2,
    band: "data:image/png;base64,iVBORw0KGgo=",
    matched: null,
    edits: null,
  },
  collector: {
    raw: "0072 LTR",
    rotated: false,
    elapsed_ms: 18.6,
    pairings: 5,
    tried: [
      { set: "LTR", number: "72", matched: null },
      { set: "72", number: "LTR", matched: null },
    ],
    more: 3,
    band: "data:image/png;base64,iVBORw0KGgo=",
    matched: null,
  },
};

beforeEach(() => {
  useAppStore.setState({ scannerFolds: { ...ALL_FOLDED } });
});

describe("the match panel", () => {
  it("draws the vote rule's verdict, bar, tally, lead and standings", () => {
    render(<ScannerPanels {...props()} />);
    const match = screen.getByRole("region", { name: "Match" });
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
    expect(
      screen.getByText(
        `No reference bundle. Put \`card-hashes.bin\` at ${STATUS.missing.bundle.path}.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("voting")).not.toBeInTheDocument();
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
    expect(screen.queryByRole("slider", { name: "decide at" })).not.toBeInTheDocument();
    await userEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("slider", { name: "decide at" })).toBeInTheDocument();
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
    expect(within(budget).getByText("180 ms")).toBeInTheDocument();
    const readouts = screen.getByRole("region", { name: "Readouts" });
    expect(within(readouts).getByText(/Storm of Saruman/)).toBeInTheDocument();
  });

  it("says what each tier read and what it could not resolve", () => {
    useAppStore.setState({ scannerFolds: { ...ALL_FOLDED, readouts: true } });
    render(<ScannerPanels {...props({ verdict: withReads })} />);
    const readouts = screen.getByRole("region", { name: "Readouts" });
    expect(within(readouts).getByText("5torm of 5aruman!")).toBeInTheDocument();
    expect(within(readouts).getByText("no name")).toBeInTheDocument();
    expect(within(readouts).getByText("no printing")).toBeInTheDocument();
    expect(within(readouts).getByText("LTR 72 → —")).toBeInTheDocument();
    expect(within(readouts).getByText("+3 more pairings not shown")).toBeInTheDocument();
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
