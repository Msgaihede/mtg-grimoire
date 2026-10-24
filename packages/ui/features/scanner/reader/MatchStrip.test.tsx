import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VERDICTS } from "../fixtures";
import { MatchStrip, type MatchStripProps } from "./MatchStrip";
import type { LastAdded } from "./readerText";

function props(over: Partial<MatchStripProps> = {}): MatchStripProps {
  return {
    verdict: VERDICTS.voting,
    lastAdded: null,
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

  /**
   * *Send scan…* (#776) stands beside Reset, outside the announcement for its reason, and hands
   * up the press itself — the page keeps it, for the caret to come back to when the dialog closes.
   */
  it("draws Send scan… beside Reset evidence, outside the announcement, and hands up the press", async () => {
    const onSend = vi.fn();
    render(<MatchStrip {...props({ onSend })} />);
    const send = screen.getByRole("button", { name: "Send scan…" });
    expect(send.parentElement).toBe(bar().parentElement);
    expect(send.previousElementSibling).toBe(
      screen.getByRole("button", { name: "Reset evidence" }),
    );
    expect(region()).not.toContainElement(send);
    expect(send).toHaveAttribute("aria-haspopup", "dialog");

    await userEvent.click(send);
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith(send);
  });

  /** A scan the scanner cannot name at all is as much worth sending as one it named wrongly. */
  it("offers Send scan… before there is a card", () => {
    render(<MatchStrip {...props({ verdict: null, onSend: vi.fn() })} />);
    expect(screen.getByRole("button", { name: "Send scan…" })).toBeEnabled();
  });

  /**
   * No handler is no run to send — a camera refused or not yet open, recognition stopped — and
   * then there is no button: not a greyed one, whose reason would be a second copy of the
   * sentence already standing over the picture. Reset is unaffected.
   */
  it("draws no Send scan… where the page hands it no press", () => {
    render(<MatchStrip {...props()} />);
    expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reset evidence" })).toBeInTheDocument();
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
    // Five eighths of the way, dim, with the line at the bar's end.
    expect(bar()).toHaveAttribute("aria-valuenow", "63");
    expect(bar().firstElementChild).toHaveClass("bg-dim");
    expect(hairline()).toHaveClass("right-0");
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
          verdict: VERDICTS.ambiguous,
          lastAdded: { ...saruman, name: "Lightning Bolt", setCode: "2x2", collectorNumber: "117" },
        })}
      />,
    );
    const text = "3 printings Lightning Bolt Pick a printing in the tray";
    expect(region()).toHaveTextContent(new RegExp(`^${text}$`));
    expect(announced(region())).toBe(text);
    expect(bar()).toHaveAttribute("aria-valuenow", "100");
  });

  it("announces a card on a real printing once it is matched", () => {
    render(
      <MatchStrip
        {...props({
          verdict: VERDICTS.resolved,
          lastAdded: { ...saruman, name: "Black Lotus", setCode: "lea", collectorNumber: "232" },
        })}
      />,
    );
    const text = "Matched Black Lotus LEA 232 Added · swap in the next card";
    expect(region()).toHaveTextContent(new RegExp(`^${text}$`));
    expect(announced(region())).toBe(text);
    expect(bar()).toHaveAttribute("aria-valuenow", "100");
  });

  it("says nothing can be identified while no recogniser is loaded", () => {
    render(
      <MatchStrip
        {...props({ verdict: { ...VERDICTS.decided, matcher: false }, lastAdded: saruman })}
      />,
    );
    expect(region()).toHaveTextContent(
      /^Can't identify The card recognizer isn't loaded, so cards can't be identified\.$/,
    );
    expect(bar()).toHaveAttribute("aria-valuenow", "0");
  });
});
