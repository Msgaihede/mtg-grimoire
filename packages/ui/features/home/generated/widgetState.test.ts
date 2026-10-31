import { describe, expect, it } from "vitest";
import type { Spec } from "@json-render/core";
import GOLDEN from "./__golden__/widget-state.json";
import { answerState, checkSpec, customConfig, widgetState } from "./widgetState";

const SPEC: Spec = {
  root: "a",
  elements: { a: { type: "Divider", props: {}, children: [] } },
  state: {
    ui: { filter: "", foils: false },
    settings: { rows: 5, sort: "value" },
    decks: [{ name: "a model's sample deck" }],
  },
};

describe("customConfig", () => {
  it("reads the definition a placed copy names and the settings it kept", () => {
    expect(customConfig({ widgetId: 3, name: "Shelf", settings: { rows: 8 } })).toEqual({
      widgetId: 3,
      settings: { rows: 8 },
    });
  });

  it("reads a config another build wrote as naming nothing, rather than failing", () => {
    expect(customConfig(null)).toEqual({ widgetId: null, settings: null });
    expect(customConfig({ widgetId: "3", settings: [1] })).toEqual({
      widgetId: null,
      settings: null,
    });
    expect(customConfig({ widgetId: 2.5 })).toEqual({ widgetId: null, settings: null });
  });
});

describe("answerState", () => {
  it("is the answer's data, less the two keys the widget owns", () => {
    expect(answerState({ decks: [], ui: "shadowed", settings: 1 })).toEqual({ decks: [] });
    expect(answerState(null)).toEqual({});
    expect(answerState([1, 2])).toEqual({});
  });
});

describe("widgetState", () => {
  it("puts the answer at the root, so the spec's paths are the query's", () => {
    const state = widgetState(SPEC, { decks: [{ name: "Burn" }] }, null);
    expect(state.decks).toEqual([{ name: "Burn" }]);
  });

  it("seeds /ui from the spec, and lays saved settings over the spec's own", () => {
    const state = widgetState(SPEC, { decks: [] }, { rows: 12 });
    expect(state.ui).toEqual({ filter: "", foils: false });
    // A saved key wins; a key the spec added since keeps its default.
    expect(state.settings).toEqual({ rows: 12, sort: "value" });
  });

  it("keeps /ui and /settings the widget's, whatever the answer names", () => {
    const state = widgetState(SPEC, { ui: { filter: "x" }, settings: { rows: 1 } }, null);
    expect(state.ui).toEqual({ filter: "", foils: false });
    expect(state.settings).toEqual({ rows: 5, sort: "value" });
  });

  it("gives a spec with no seeds an empty /ui and /settings", () => {
    const state = widgetState({ root: "a", elements: SPEC.elements }, { decks: [] }, null);
    expect(state).toEqual({ decks: [], ui: {}, settings: {} });
  });

  it("copies the seeds, so a widget's inputs never write into its stored spec", () => {
    const state = widgetState(SPEC, {}, null);
    (state.ui as { filter: string }).filter = "typed";
    expect((SPEC.state as { ui: { filter: string } }).ui.filter).toBe("");
  });
});

describe("checkSpec", () => {
  it("answers a spec the catalogue can draw", () => {
    const checked = checkSpec(SPEC);
    expect(checked.ok).toBe(true);
  });

  it("names the first thing wrong with one it cannot", () => {
    const checked = checkSpec({
      root: "a",
      elements: { a: { type: "Iframe", props: {}, children: [] } },
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problem).toMatch(/elements\.a/);
  });
});

/**
 * **The mapping, as a file both sides hold.** The desktop's MCP tool `widget_preview` builds the
 * same state in Rust (`mcp::tools::widget_state`) so an agent sees what the page will draw; its
 * test reads this file too, so the two cannot drift apart.
 */
describe("the shared widget-state golden", () => {
  it.each(GOLDEN.map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(
      widgetState(c.spec as Spec, c.data, c.saved as Record<string, unknown> | null),
    ).toEqual(c.state);
  });
});
