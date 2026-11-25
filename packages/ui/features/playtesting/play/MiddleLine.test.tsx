import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NO_PICKS } from "./combat";
import { parityMarks } from "./fixtures";
import { MiddleLine, TurnFacts } from "./MiddleLine";

describe("TurnFacts", () => {
  it("is nothing before day or night, off the reader's turn", () => {
    const { container } = render(<TurnFacts view={{ dayNight: null, landsLeft: null }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says whether it is day or night", () => {
    const { rerender } = render(<TurnFacts view={{ dayNight: "day", landsLeft: null }} />);
    expect(screen.getByText("Day")).toBeInTheDocument();
    rerender(<TurnFacts view={{ dayNight: "night", landsLeft: null }} />);
    expect(screen.getByText("Night")).toBeInTheDocument();
  });

  it("counts the lands the reader may still play on their turn", () => {
    const { rerender } = render(<TurnFacts view={{ dayNight: null, landsLeft: 1 }} />);
    expect(screen.getByText("1 land to play")).toBeInTheDocument();
    rerender(<TurnFacts view={{ dayNight: null, landsLeft: 2 }} />);
    expect(screen.getByText("2 lands to play")).toBeInTheDocument();
    rerender(<TurnFacts view={{ dayNight: null, landsLeft: 0 }} />);
    expect(screen.getByText("No lands left to play")).toBeInTheDocument();
  });
});

describe("MiddleLine", () => {
  it("says night and the reader's land drop beside the switches", () => {
    render(<MiddleLine view={parityMarks().view} picks={NO_PICKS} status="" failed={false} />);
    expect(screen.getByText("Night")).toBeInTheDocument();
    expect(screen.getByText("1 land to play")).toBeInTheDocument();
  });
});
