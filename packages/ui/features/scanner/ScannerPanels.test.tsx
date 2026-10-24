import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore, type ScannerPanelId } from "@/lib/store";
import { ScannerPanels, type ScannerPanelsProps } from "./ScannerPanels";
import { STATUS, VERDICTS } from "./fixtures";

function props(over: Partial<ScannerPanelsProps> = {}): ScannerPanelsProps {
  return {
    status: STATUS.present,
    verdict: VERDICTS.voting,
    // A real `performance.now()` delta rather than a whole number: a `180` here passes whether
    // the panel rounds or interpolates, which is how `288.39999999999998 ms` reached the shipped
    // window. **The digits have to survive being parsed** — that exact literal is the same
    // double as `288.4` and `String()`s back as `"288.4"`, so it would assert nothing. This one
    // round-trips long, and the assertion below is what pins the rounding.
    roundTripMs: 288.4000000000001,
    rate: 5.6,
    onCapture: vi.fn(async () => "live-1.jpg"),
    ...over,
  };
}

/**
 * Every panel folded away, which is where the store starts — **keyed off the store's own initial
 * record, with every value forced to `false`**, so the next panel id arrives folded here without
 * an edit.
 */
const ALL_FOLDED = Object.fromEntries(
  Object.keys(useAppStore.getInitialState().scannerFolds).map((id) => [id, false]),
) as Record<ScannerPanelId, boolean>;

beforeEach(() => {
  useAppStore.setState({ scannerFolds: { ...ALL_FOLDED } });
});

describe("the match panel", () => {
  it("draws the leader's votes, the frames read and the standings", () => {
    render(<ScannerPanels {...props()} />);
    const match = screen.getByRole("region", { name: "Match" });
    // One level under the view's own `<h2>Scanner</h2>`: a panel heading level-equal with the
    // view's reads as two views to a screen reader's heading list.
    expect(within(match).getByRole("heading", { level: 3, name: "Match" })).toBeInTheDocument();
    expect(within(match).getByText("1.3/2 · 3f")).toBeInTheDocument();
    const rows = within(match).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Plains · 2XM 373");
    expect(rows[0]).toHaveTextContent("1.3");
  });

  /**
   * **The bar moved to the Match strip above the camera**, which every reader sees — a developer
   * included. A second one here would be one answer drawn twice on one screen.
   */
  it("leaves the bar to the strip above the camera", () => {
    render(<ScannerPanels {...props()} />);
    const match = screen.getByRole("region", { name: "Match" });
    expect(within(match).queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("draws the best look's distance, its margin, its way up and the cards read", () => {
    render(<ScannerPanels {...props({ verdict: VERDICTS.decided })} />);
    const match = screen.getByRole("region", { name: "Match" });
    expect(within(match).getByText("2.0/2 · 2f")).toBeInTheDocument();
    expect(within(match).getByText("0.043 (11/256)")).toBeInTheDocument();
    expect(within(match).getByText("30/128")).toBeInTheDocument();
    expect(within(match).getByText("upright")).toBeInTheDocument();
    expect(within(match).getByText("this frame: Storm of Saruman · d=11")).toBeInTheDocument();
  });

  it("draws em dashes and no standings where the frame matched nothing", () => {
    render(<ScannerPanels {...props({ verdict: VERDICTS.noMatch })} />);
    const match = screen.getByRole("region", { name: "Match" });
    expect(within(match).getByText("this frame: no match")).toBeInTheDocument();
    expect(within(match).queryAllByRole("listitem")).toHaveLength(0);
  });

  /** The recogniser there and not loaded: its sentence, at the top of the panel. */
  it("says the recogniser did not load, in the load's words, at the top of the panel", () => {
    render(<ScannerPanels {...props({ status: STATUS.corrupt, verdict: VERDICTS.noCard })} />);
    const match = screen.getByRole("region", { name: "Match" });
    expect(
      within(match).getByText("The card recognizer did not load: gallery: bad magic."),
    ).toBeInTheDocument();
  });

  it("says nothing of a recogniser that is absent: every frame says so instead", () => {
    render(<ScannerPanels {...props({ status: STATUS.missing, verdict: VERDICTS.noCard })} />);
    expect(screen.queryByText(/did not load/)).not.toBeInTheDocument();
  });

  /** Reset moved to the Match strip beside the bar (#740); one button by that name per screen. */
  it("captures through its button, and leaves reset to the strip", async () => {
    const p = props();
    render(<ScannerPanels {...p} />);
    expect(screen.queryByRole("button", { name: "Reset evidence" })).not.toBeInTheDocument();
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

describe("the budget panel", () => {
  it("starts folded, opens on its heading, and remembers it in the store", async () => {
    render(<ScannerPanels {...props()} />);
    const heading = screen.getByRole("button", { name: "Frame budget" });
    expect(heading).toHaveAttribute("aria-expanded", "false");
    // The body is unmounted while folded, so pointing at its id would be a dangling IDREF.
    expect(heading).not.toHaveAttribute("aria-controls");
    expect(screen.queryByText("transport")).not.toBeInTheDocument();
    await userEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "true");
    // Open, it points at the body — checked by *resolving* the IDREF.
    const target = heading.getAttribute("aria-controls") ?? "";
    expect(document.getElementById(target)).toContainElement(screen.getByText("transport"));
    expect(useAppStore.getState().scannerFolds.budget).toBe(true);
  });

  it("shows the decode, the read and the transport, rounded", () => {
    useAppStore.setState({ scannerFolds: { ...ALL_FOLDED, budget: true } });
    render(<ScannerPanels {...props({ verdict: VERDICTS.decided })} />);
    const budget = screen.getByRole("region", { name: "Frame budget" });
    for (const k of ["decode", "read", "transport"]) {
      expect(within(budget).getByText(k)).toBeInTheDocument();
    }
    expect(within(budget).getByText("18.4 ms")).toBeInTheDocument();
    // What is left of the round trip after the scanner's own two.
    expect(within(budget).getByText("268.1 ms")).toBeInTheDocument();
    // Rounded like the rows above it: the prop is `288.4000000000001`, which is what a
    // `performance.now()` delta really looks like and what the row used to print verbatim.
    expect(within(budget).getByText("288.4 ms")).toBeInTheDocument();
    expect(within(budget).queryByText("288.4000000000001 ms")).not.toBeInTheDocument();
  });

  it("is the one panel that folds: nothing of the old scanner's is drawn", () => {
    render(<ScannerPanels {...props()} />);
    for (const name of ["Controls", "Pipeline", "Rectified", "Readouts", "Tiers"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});
