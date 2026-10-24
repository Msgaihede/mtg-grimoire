import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VERDICTS } from "../fixtures";
import { matchStrip, type LastAdded } from "./readerText";
import { ScanHud, type ScanHudProps } from "./ScanHud";

const saruman: LastAdded = {
  name: "Storm of Saruman",
  setCode: "ltr",
  collectorNumber: "72",
  bumpedTo: null,
  replaced: false,
};

/** The strip while the evidence builds: five eighths of the way, with a leader named. */
const matching = matchStrip(VERDICTS.voting, null);
/** Decided and filed. */
const matched = matchStrip(VERDICTS.decided, saruman);
/** No recogniser loaded — the strip's one error tone. */
const cantIdentify = matchStrip({ ...VERDICTS.noCard, matcher: false }, null);

function props(over: Partial<ScanHudProps> = {}): ScanHudProps {
  return { strip: matching, live: true, variant: "labelled", ...over };
}

function region(): HTMLElement {
  return screen.getByRole("status", { name: "Scanner status" });
}

/** The region's text as assistive tech is given it: every `aria-hidden` subtree left out. */
function announced(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("ScanHud", () => {
  /** Nothing is being matched, so there is nothing to measure — and no empty bar standing in. */
  it("draws no bar while the scanner is not reading", () => {
    render(<ScanHud {...props({ live: false })} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("draws the bar along the top edge, dim while the evidence builds", () => {
    render(<ScanHud {...props()} />);
    const bar = screen.getByRole("progressbar", { name: "Match progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "63");
    expect(bar.classList.contains("top-0")).toBe(true);
    expect(bar.firstElementChild?.classList.contains("bg-dim")).toBe(true);
  });

  it("fills the bar and turns it gold once the scanner has settled", () => {
    render(<ScanHud {...props({ strip: matched })} />);
    const bar = screen.getByRole("progressbar", { name: "Match progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar.firstElementChild?.classList.contains("bg-accent")).toBe(true);
    expect(bar.firstElementChild?.classList.contains("bg-dim")).toBe(false);
  });

  /**
   * The strip's words are gone from view and still said: the region is always mounted, so a
   * screen reader is watching it before the first card lands, and the leader is left out of the
   * announcement while it can still change from frame to frame — the old strip's rule.
   */
  it("announces the strip from a hidden region, without the leaning leader", () => {
    const { rerender } = render(<ScanHud {...props({ live: false })} />);
    expect(region()).toHaveTextContent(/^$/);
    expect(region().classList.contains("sr-only")).toBe(true);

    rerender(<ScanHud {...props()} />);
    expect(announced(region())).toBe("Matching Hold steady");

    rerender(<ScanHud {...props({ strip: matched })} />);
    expect(announced(region())).toBe(
      "Matched Storm of Saruman LTR 72 Added · swap in the next card",
    );
  });

  it("draws Reset evidence and Send scan… only where the page hands it their presses", () => {
    const { rerender } = render(<ScanHud {...props()} />);
    expect(screen.queryByRole("button", { name: "Reset evidence" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();

    rerender(<ScanHud {...props({ onReset: vi.fn() })} />);
    expect(screen.getByRole("button", { name: "Reset evidence" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();

    rerender(<ScanHud {...props({ onSend: vi.fn() })} />);
    expect(screen.queryByRole("button", { name: "Reset evidence" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send scan…" })).toBeInTheDocument();
  });

  /** Outside the live region — a press is not news — and pressable through a click-through layer. */
  it("hands up both presses, Send scan… with the button for the caret to come back to", async () => {
    const onReset = vi.fn();
    const onSend = vi.fn();
    render(<ScanHud {...props({ onReset, onSend })} />);
    const reset = screen.getByRole("button", { name: "Reset evidence" });
    const send = screen.getByRole("button", { name: "Send scan…" });
    expect(region()).not.toContainElement(reset);
    expect(region()).not.toContainElement(send);
    expect(send).toHaveAttribute("aria-haspopup", "dialog");
    expect(reset.classList.contains("pointer-events-auto")).toBe(true);
    expect(send.classList.contains("pointer-events-auto")).toBe(true);

    await userEvent.click(reset);
    expect(onReset).toHaveBeenCalledOnce();
    await userEvent.click(send);
    expect(onSend).toHaveBeenCalledWith(send);
  });

  it("names the labelled presses by their words", () => {
    render(<ScanHud {...props({ onReset: vi.fn(), onSend: vi.fn() })} />);
    const reset = screen.getByRole("button", { name: "Reset evidence" });
    expect(reset).not.toHaveAttribute("aria-label");
    expect(reset).toHaveTextContent("Reset evidence");
    expect(screen.getByRole("button", { name: "Send scan…" })).toHaveTextContent("Send scan…");
  });

  /** A glyph alone under a thumb: the words are the press's accessible name, never drawn. */
  it("names the icon presses by aria-label", () => {
    render(<ScanHud {...props({ variant: "icon", onReset: vi.fn(), onSend: vi.fn() })} />);
    const reset = screen.getByRole("button", { name: "Reset evidence" });
    const send = screen.getByRole("button", { name: "Send scan…" });
    expect(reset).toHaveAttribute("aria-label", "Reset evidence");
    expect(send).toHaveAttribute("aria-label", "Send scan…");
    expect(reset).toHaveTextContent(/^$/);
    expect(send).toHaveTextContent(/^$/);
    expect(reset.classList.contains("size-11")).toBe(true);
  });

  it("says the strip's error sentence in the note chip", () => {
    render(<ScanHud {...props({ strip: cantIdentify, note: "A busy database" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The card recognizer isn't loaded, so cards can't be identified.",
    );
  });

  /** Always mounted, so a sentence that arrives is announced; only its words come and go. */
  it("says the page's note otherwise, from a region that outlives it", () => {
    const { rerender } = render(<ScanHud {...props({ note: "Wait for the camera to start." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Wait for the camera to start.");
    rerender(<ScanHud {...props({ note: null })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/^$/);
  });
});
