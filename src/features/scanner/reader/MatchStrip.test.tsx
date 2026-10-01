import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ScannerTracked, ScannerVerdict } from "@/lib/ipc";
import { VERDICTS } from "../fixtures";
import { MatchStrip, type MatchStripProps } from "./MatchStrip";
import type { LastAdded } from "./readerText";

function props(over: Partial<MatchStripProps> = {}): MatchStripProps {
  return {
    verdict: VERDICTS.voting,
    mode: "fast",
    lastAdded: null,
    hasBundle: true,
    lastResolution: null,
    onReset: vi.fn(),
    ...over,
  };
}

/** The strip's live region, found by the name the view's status line has always had. */
function region(): HTMLElement {
  return screen.getByRole("status", { name: "Scanner status" });
}

function bar(): HTMLElement {
  return screen.getByRole("progressbar", { name: "Match progress" });
}

/** The line the bar has to cross — the one `aria-hidden` mark inside the progressbar. */
function hairline(): Element | null {
  return bar().querySelector('[aria-hidden="true"]');
}

/**
 * The region's text as assistive tech is given it: every `aria-hidden` subtree left out, which
 * `textContent` — and so `toHaveTextContent` — does not do.
 */
function announced(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

const saruman: LastAdded = {
  name: "Storm of Saruman",
  setCode: "ltr",
  collectorNumber: "72",
  bumpedTo: null,
  replaced: false,
};

describe("MatchStrip", () => {
  /**
   * Beside the bar and outside the live region (#740): a press is not news, and a button inside
   * `Scanner status` would be read out with every change of the line.
   */
  it("draws Reset evidence beside the bar, outside the announcement, and hands the press up", async () => {
    const onReset = vi.fn();
    render(<MatchStrip {...props({ onReset })} />);
    const reset = screen.getByRole("button", { name: "Reset evidence" });
    expect(reset.parentElement).toBe(bar().parentElement);
    expect(region()).not.toContainElement(reset);
    await userEvent.click(reset);
    expect(onReset).toHaveBeenCalledOnce();
  });

  /** A reader with nothing in frame may still want the last card's leftovers gone. */
  it("offers Reset evidence before there is a card", () => {
    render(<MatchStrip {...props({ verdict: null })} />);
    expect(screen.getByRole("button", { name: "Reset evidence" })).toBeEnabled();
  });

  it("asks for a card before there is one, with an empty bar and no line to cross", () => {
    render(<MatchStrip {...props({ verdict: null })} />);
    expect(region()).toHaveTextContent(/^Looking Point the camera at a card$/);
    expect(bar()).toHaveAttribute("aria-valuenow", "0");
    expect(hairline()).toBeNull();
  });

  /**
   * The leader can change from frame to frame while the tracker weighs it, so it is drawn and not
   * announced: a live region re-reading every flip would bury "hold steady" under card names.
   */
  it("draws the leader but keeps it out of the announcement while matching", () => {
    render(<MatchStrip {...props()} />);
    expect(region()).toHaveTextContent(/^Matching Plains 2XM 373 Hold steady$/);
    expect(announced(region())).toBe("Matching Hold steady");
    expect(screen.getByText("Plains")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("2XM 373")).toHaveAttribute("aria-hidden", "true");
    // Five of the eight the vote rule wants, dim, with the line at the bar's end.
    expect(bar()).toHaveAttribute("aria-valuenow", "63");
    expect(bar().firstElementChild).toHaveClass("bg-dim");
    expect(hairline()).toHaveStyle({ right: "0" });
  });

  it("says Exact is reading a locked card it has not settled", () => {
    render(<MatchStrip {...props({ mode: "exact" })} />);
    expect(region()).toHaveTextContent(/^Reading Plains 2XM 373 Hold steady — reading…$/);
    expect(announced(region())).toBe("Reading Hold steady — reading…");
  });

  it("announces the card once it is matched, with the bar full and gold", () => {
    render(<MatchStrip {...props({ verdict: VERDICTS.decided, lastAdded: saruman })} />);
    const text = "Matched Storm of Saruman LTR 72 Added · swap in the next card";
    expect(region()).toHaveTextContent(new RegExp(`^${text}$`));
    expect(announced(region())).toBe(text);
    expect(screen.getByText("Storm of Saruman")).not.toHaveAttribute("aria-hidden");
    expect(bar()).toHaveAttribute("aria-valuenow", "100");
    expect(bar().firstElementChild).toHaveClass("bg-accent");
    // Crossed: a mark where the bar used to have to reach is a bar that stopped short.
    expect(hairline()).toBeNull();
  });

  it("names the card and counts the printings a reader has to pick between", () => {
    render(
      <MatchStrip
        {...props({
          verdict: VERDICTS.exactAmbiguous,
          mode: "exact",
          lastAdded: { ...saruman, name: "Lightning Bolt", setCode: "2x2", collectorNumber: "117" },
          lastResolution: VERDICTS.exactAmbiguous.resolution,
        })}
      />,
    );
    const text = "3 printings Lightning Bolt Pick a printing in the tray";
    expect(region()).toHaveTextContent(new RegExp(`^${text}$`));
    expect(announced(region())).toBe(text);
    expect(bar()).toHaveAttribute("aria-valuenow", "100");
  });

  it("says a resolve found nothing, with the sentence where the name would be", () => {
    render(
      <MatchStrip
        {...props({
          verdict: VERDICTS.exactNotFound,
          mode: "exact",
          lastResolution: VERDICTS.exactNotFound.resolution,
        })}
      />,
    );
    expect(region()).toHaveTextContent(/^No match Try better lighting or clear the filters\.$/);
    expect(bar()).toHaveAttribute("aria-valuenow", "0");
  });

  it("says nothing can be identified while no hashes are loaded", () => {
    render(<MatchStrip {...props({ verdict: VERDICTS.decided, lastAdded: saruman, hasBundle: false })} />);
    expect(region()).toHaveTextContent(
      /^Can't identify Card hashes aren't loaded, so cards can be detected but not identified\.$/,
    );
    expect(bar()).toHaveAttribute("aria-valuenow", "0");
  });

  /**
   * The confidence rule commits at a proportion rather than at the bar's end, so its line sits at
   * 70% — `TrackerOptions::commit_confidence`, which the crate does not send.
   */
  it("puts the line at 70% under the confidence rule", () => {
    const gathering: ScannerTracked = {
      ...(VERDICTS.confidence.tracked as ScannerTracked),
      committed: false,
      confidence: 0.55,
    };
    const verdict: ScannerVerdict = { ...VERDICTS.confidence, decision: null, tracked: gathering };
    render(<MatchStrip {...props({ verdict })} />);
    expect(bar()).toHaveAttribute("aria-valuenow", "55");
    expect(hairline()).toHaveStyle({ left: "70%" });
  });
});
