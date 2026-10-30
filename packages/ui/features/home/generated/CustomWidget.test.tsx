import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The two reads this body makes — the mirror spread, `DecksWidget.test.tsx`'s reason. */
const customWidgets = vi.hoisted(() => vi.fn());
const graphqlQuery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, customWidgets, graphqlQuery } };
});

import type { CustomWidget as Definition, GraphResponse, HomeWidget } from "@/lib/ipc";
import { DEFAULT_MARKETPLACE } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { makeFit } from "../fit";
import {
  CUSTOM_WIDGET_GONE,
  CUSTOM_WIDGET_PARTIAL,
  CustomWidget,
  CustomWidgetSettings,
} from "./CustomWidget";

const QUERY = "{ decks { id name } }";

/** A definition: rows of decks that open their deck, a switch under `/ui`, a saved setting. */
function definition(over: Partial<Definition> = {}): Definition {
  return {
    id: 5,
    name: "Shelf",
    description: "",
    query: QUERY,
    w: 4,
    h: 3,
    createdAt: 1,
    updatedAt: 1,
    spec: {
      root: "body",
      settingsRoot: "face",
      elements: {
        body: {
          type: "Stack",
          props: { direction: null, gap: null, align: null, justify: null, wrap: null },
          children: ["toggle", "list", "shown", "refresh"],
        },
        shown: {
          type: "Text",
          props: {
            text: { $template: "${/settings/rows} rows" },
            tone: null,
            size: null,
            mono: null,
            truncate: null,
          },
          children: [],
        },
        // The settings face — the popover's, never the card's.
        face: {
          type: "Stack",
          props: { direction: null, gap: null, align: null, justify: null, wrap: null },
          children: ["rows"],
        },
        toggle: {
          type: "Switch",
          props: { label: "Hide list", checked: { $bindState: "/ui/hide" } },
          children: [],
        },
        list: {
          type: "RowList",
          props: { label: null },
          repeat: { statePath: "/decks", key: "id" },
          visible: { $state: "/ui/hide", not: true },
          children: ["deck"],
        },
        deck: {
          type: "Row",
          props: {
            name: { $item: "name" },
            caption: null,
            value: null,
            money: null,
            delta: null,
            rarity: null,
            setCode: null,
            track: null,
          },
          on: { press: { action: "openDeck", params: { deckId: { $item: "id" } } } },
          children: [],
        },
        rows: {
          type: "CompactStepper",
          props: { label: "Rows", value: { $bindState: "/settings/rows" }, min: 1, max: 9 },
          children: [],
        },
        refresh: {
          type: "Button",
          props: { label: "Refresh", variant: "quiet" },
          on: { press: { action: "refresh", params: {} } },
          children: [],
        },
      },
      state: { ui: { hide: false }, settings: { rows: 3 } },
    },
    ...over,
  };
}

function answer(decks: { id: number; name: string }[]): GraphResponse {
  return { data: { decks }, extensions: { invalidatedBy: ["decks"] } };
}

let qc: QueryClient;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

function placed(config: unknown): HomeWidget {
  return { id: "custom-1", kind: "custom", x: 0, y: 0, w: 4, h: 3, config };
}

const FIT = makeFit({ w: 4, h: 3, widthPx: 480, heightPx: 320, density: "comfortable" });

function draw(config: unknown, onConfig = vi.fn()) {
  const view = render(
    <CustomWidget
      widget={placed(config)}
      fit={FIT}
      editing={false}
      still={false}
      onConfig={onConfig}
    />,
    { wrapper },
  );
  return Object.assign(onConfig, { view });
}

/** The card's settings popover's extra rows, alone. */
function drawSettings(config: unknown, onConfig = vi.fn()) {
  render(<CustomWidgetSettings widget={placed(config)} onConfig={onConfig} />, { wrapper });
  return onConfig;
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(MARKETPLACE_KEY, DEFAULT_MARKETPLACE);
  qc.setQueryData(MARKETPLACE_FEEDS_KEY, []);
  customWidgets.mockReset().mockResolvedValue([definition()]);
  graphqlQuery.mockReset().mockResolvedValue(answer([{ id: 7, name: "Burn" }]));
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe("CustomWidget", () => {
  it("draws its spec over its query's answer", async () => {
    draw({ widgetId: 5 });
    expect(await screen.findByText("Burn")).toBeInTheDocument();
    expect(graphqlQuery).toHaveBeenCalledWith(QUERY, null, null, DEFAULT_MARKETPLACE);
  });

  it("navigates from a row bound to an action", async () => {
    draw({ widgetId: 5 });
    await userEvent.click(await screen.findByRole("button", { name: /Burn/ }));
    await expect.poll(() => useAppStore.getState().openDeckId).toBe(7);
  });

  it("says so when the definition it names is gone", async () => {
    draw({ widgetId: 99 });
    expect(await screen.findByText(CUSTOM_WIDGET_GONE)).toBeInTheDocument();
    expect(graphqlQuery).not.toHaveBeenCalled();
  });

  it("refuses a spec the catalogue cannot draw, without asking the graph", async () => {
    customWidgets.mockResolvedValue([
      definition({
        spec: { root: "a", elements: { a: { type: "Iframe", props: {}, children: [] } } },
      }),
    ]);
    draw({ widgetId: 5 });
    expect(await screen.findByText(/picture could not be drawn/)).toBeInTheDocument();
    expect(graphqlQuery).not.toHaveBeenCalled();
  });

  it("shows the graph's refusal", async () => {
    graphqlQuery.mockResolvedValue({ data: null, errors: [{ message: "Unknown field `dekcs`." }] });
    draw({ widgetId: 5 });
    expect(await screen.findByText("Unknown field `dekcs`.")).toBeInTheDocument();
  });

  it("draws a partial answer, and says part of it is missing", async () => {
    graphqlQuery.mockResolvedValue({
      ...answer([{ id: 7, name: "Burn" }]),
      errors: [{ message: "a field was refused" }],
    });
    draw({ widgetId: 5 });
    expect(await screen.findByText("Burn")).toBeInTheDocument();
    expect(screen.getByText(CUSTOM_WIDGET_PARTIAL)).toBeInTheDocument();
  });

  it("draws its settings face in the popover, never on the card", async () => {
    draw({ widgetId: 5 });
    expect(await screen.findByText("3 rows")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More, Rows" })).toBeNull();
  });

  it("keeps each settings change in the placed copy's config as it is made", async () => {
    const onConfig = drawSettings({ widgetId: 5, settings: { rows: 6 } });
    // The saved setting over the spec's seed of 3.
    expect(await screen.findByText("6")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More, Rows" }));
    await expect.poll(() => onConfig.mock.calls.length).toBe(1);
    expect(onConfig).toHaveBeenCalledWith({ settings: { rows: 7 } });
  });

  it("redraws the card from settings the popover kept", async () => {
    const drawn = draw({ widgetId: 5, settings: { rows: 6 } });
    expect(await screen.findByText("6 rows")).toBeInTheDocument();
    drawn.view.rerender(
      <CustomWidget
        widget={placed({ widgetId: 5, settings: { rows: 8 } })}
        fit={FIT}
        editing={false}
        still={false}
        onConfig={drawn}
      />,
    );
    expect(await screen.findByText("8 rows")).toBeInTheDocument();
  });

  it("draws no settings for a spec with no settings face", async () => {
    const { settingsRoot: _, ...faceless } = definition().spec as Record<string, unknown>;
    customWidgets.mockResolvedValue([definition({ spec: faceless })]);
    drawSettings({ widgetId: 5 });
    await waitFor(() => expect(customWidgets).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "More, Rows" })).toBeNull();
  });

  it("asks its document again on refresh, and keeps the reader's /ui state over the new answer", async () => {
    draw({ widgetId: 5 });
    expect(await screen.findByText("Burn")).toBeInTheDocument();

    // The reader hides the list — widget state, under `/ui`.
    await userEvent.click(screen.getByRole("switch", { name: "Hide list" }));
    expect(screen.queryByText("Burn")).toBeNull();

    graphqlQuery.mockResolvedValue(
      answer([
        { id: 7, name: "Burn" },
        { id: 8, name: "Elves" },
      ]),
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await expect.poll(() => graphqlQuery.mock.calls.length).toBe(2);

    // Still hidden: the answer moved, the switch did not.
    expect(screen.queryByText("Elves")).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: "Hide list" }));
    expect(await screen.findByText("Elves")).toBeInTheDocument();
  });
});
