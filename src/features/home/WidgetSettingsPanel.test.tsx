import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { HomeWidget } from "@/lib/ipc";

import { WidgetSettingsPanel, type WidgetSettingsPanelProps } from "./WidgetSettingsPanel";

/** A value widget at its default footprint: two picks, one switch, a chip — every row the panel
 *  draws. */
function widget(over: Partial<HomeWidget> = {}): HomeWidget {
  return {
    id: "collectionValue",
    kind: "collectionValue",
    x: 0,
    y: 0,
    w: 2,
    h: 3,
    config: null,
    ...over,
  };
}

/** Fresh spies per call, so a `toHaveBeenCalledTimes` cannot pass or fail by test order. */
function props(over: Partial<WidgetSettingsPanelProps> = {}): WidgetSettingsPanelProps {
  return { widget: widget(), onConfig: vi.fn(), onGrow: vi.fn(), ...over };
}

describe("WidgetSettingsPanel", () => {
  /**
   * The four stepper names fold the card's title in, so nine cards' settings are nine sets of
   * addressable steppers — and each one is a delta, because only the page knows the grid.
   */
  it("steps the footprint one cell at a time", async () => {
    const user = userEvent.setup();
    const onGrow = vi.fn();
    render(<WidgetSettingsPanel {...props({ widget: widget({ w: 3, h: 3 }), onGrow })} />);

    await user.click(screen.getByRole("button", { name: "Wider, Collection value" }));
    expect(onGrow).toHaveBeenLastCalledWith(1, 0);
    await user.click(screen.getByRole("button", { name: "Narrower, Collection value" }));
    expect(onGrow).toHaveBeenLastCalledWith(-1, 0);
    await user.click(screen.getByRole("button", { name: "Taller, Collection value" }));
    expect(onGrow).toHaveBeenLastCalledWith(0, 1);
    await user.click(screen.getByRole("button", { name: "Shorter, Collection value" }));
    expect(onGrow).toHaveBeenLastCalledWith(0, -1);
    expect(onGrow).toHaveBeenCalledTimes(4);
  });

  /**
   * **`aria-disabled`, never the attribute**, and a press on it does nothing. A stepper the page
   * says cannot grow keeps its tab stop, so a reader sweeping the panel finds the control and learns
   * it is at its limit rather than finding it gone.
   */
  it("greys a step the page refuses, and keeps it on the tab path", async () => {
    const user = userEvent.setup();
    const onGrow = vi.fn();
    const canGrow = (dw: number, dh: number) => !(dw === 1 && dh === 0);
    render(<WidgetSettingsPanel {...props({ widget: widget({ w: 3 }), onGrow, canGrow })} />);

    const wider = screen.getByRole("button", { name: "Wider, Collection value" });
    expect(wider).toHaveAttribute("aria-disabled", "true");
    expect(wider).not.toHaveAttribute("disabled");
    // The others are live.
    expect(screen.getByRole("button", { name: "Taller, Collection value" })).not.toHaveAttribute(
      "aria-disabled",
    );

    // Reached by Tab from the top of the panel: Narrower, then Wider.
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(wider);

    await user.click(wider);
    await user.keyboard("{Enter}");
    expect(onGrow).not.toHaveBeenCalled();
  });

  /** The kind's own bounds hold even where the page's answer would allow more: a Collection value
   *  is two cells wide at the least. */
  it("greys a step past the kind's own bounds", () => {
    render(<WidgetSettingsPanel {...props({ widget: widget({ w: 2, h: 2 }), canGrow: () => true })} />);

    expect(screen.getByRole("button", { name: "Narrower, Collection value" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Shorter, Collection value" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("draws one group per pick, pressed on the current value, and writes the option's id", async () => {
    const user = userEvent.setup();
    const onConfig = vi.fn();
    render(
      <WidgetSettingsPanel
        {...props({ widget: widget({ config: { dimension: "color" } }), onConfig })}
      />,
    );

    const split = within(screen.getByRole("group", { name: "Split by" }));
    expect(split.getByRole("button", { name: "Colour" })).toHaveAttribute("aria-pressed", "true");
    expect(split.getByRole("button", { name: "Rarity" })).toHaveAttribute("aria-pressed", "false");

    await user.click(split.getByRole("button", { name: "Set" }));
    expect(onConfig).toHaveBeenCalledWith({ dimension: "set" });

    // The second pick reads its default where nothing is stored.
    const chart = within(screen.getByRole("group", { name: "Chart" }));
    expect(chart.getByRole("button", { name: "Bars" })).toHaveAttribute("aria-pressed", "true");
  });

  /** A numeric option is written as the number, never as its label's string — `pickValue` compares
   *  with `===`, so `"25"` would read back as the default. */
  it("writes a numeric pick as a number", async () => {
    const user = userEvent.setup();
    const onConfig = vi.fn();
    render(
      <WidgetSettingsPanel
        {...props({ widget: widget({ id: "activity", kind: "activity" }), onConfig })}
      />,
    );

    const limit = within(screen.getByRole("group", { name: "Changes to show" }));
    expect(limit.getByRole("button", { name: "50" })).toHaveAttribute("aria-pressed", "true");
    await user.click(limit.getByRole("button", { name: "25" }));
    expect(onConfig).toHaveBeenCalledWith({ limit: 25 });
  });

  /** Comfortable is the absence of a density, so choosing it removes the key. */
  it("writes compact as a word and comfortable as nothing", async () => {
    const user = userEvent.setup();
    const onConfig = vi.fn();
    const view = render(<WidgetSettingsPanel {...props({ onConfig })} />);

    let density = within(screen.getByRole("group", { name: "Density" }));
    expect(density.getByRole("button", { name: "Comfortable" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(density.getByRole("button", { name: "Compact" }));
    expect(onConfig).toHaveBeenLastCalledWith({ density: "compact" });

    view.rerender(
      <WidgetSettingsPanel
        {...props({ widget: widget({ config: { density: "compact" } }), onConfig })}
      />,
    );
    density = within(screen.getByRole("group", { name: "Density" }));
    expect(density.getByRole("button", { name: "Compact" })).toHaveAttribute("aria-pressed", "true");
    await user.click(density.getByRole("button", { name: "Comfortable" }));
    expect(onConfig).toHaveBeenLastCalledWith({ density: undefined });
  });

  /**
   * **A switch is stored only as `false`.** Turning one off writes `false`; turning it back on
   * removes the key, so a reader who has changed nothing and one who changed it back carry the same
   * config.
   */
  it("stores a switch turned off as false, and one turned on as nothing", async () => {
    const user = userEvent.setup();
    const onConfig = vi.fn();
    const view = render(<WidgetSettingsPanel {...props({ onConfig })} />);

    const totals = within(screen.getByRole("group", { name: "Show" })).getByRole("checkbox", {
      name: "Show totals",
    });
    expect(totals).toBeChecked();
    await user.click(totals);
    expect(onConfig).toHaveBeenLastCalledWith({ figures: false });

    view.rerender(
      <WidgetSettingsPanel {...props({ widget: widget({ config: { figures: false } }), onConfig })} />,
    );
    const off = screen.getByRole("checkbox", { name: "Show totals" });
    expect(off).not.toBeChecked();
    await user.click(off);
    expect(onConfig).toHaveBeenLastCalledWith({ figures: undefined });
  });

  /** A kind with no switches draws no empty Show heading. */
  it("draws no Show group for a kind with no switches", () => {
    render(
      <WidgetSettingsPanel
        {...props({ widget: widget({ id: "priceMovers", kind: "priceMovers" }) })}
      />,
    );
    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
    expect(screen.getByRole("group", { name: "Window" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Direction" })).toBeInTheDocument();
  });

  /**
   * A kind this build cannot draw gets the footprint and the density and nothing else — its picks
   * and switches are a newer build's words.
   */
  it("draws only size and density for a kind this build does not know", () => {
    render(
      <WidgetSettingsPanel {...props({ widget: widget({ id: "sync", kind: "syncStatus" }) })} />,
    );

    expect(screen.getAllByRole("group")).toHaveLength(2);
    expect(screen.getByRole("group", { name: "Size" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Density" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Wider, Unknown widget (syncStatus)" }),
    ).toBeInTheDocument();
  });

  it("draws the kind's own settings last", () => {
    render(<WidgetSettingsPanel {...props({ extraSettings: <p>Pinned decks</p> })} />);
    expect(screen.getByText("Pinned decks")).toBeInTheDocument();
  });
});
