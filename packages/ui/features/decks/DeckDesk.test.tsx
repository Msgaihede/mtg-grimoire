import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

/**
 * **How many times each probe was drawn** — the render counter issue #557 asked for.
 *
 * Each probe below is a module the editor imports, replaced by a component that counts and then
 * draws the real one. **The probe itself is never memoised**, and that is what makes it a
 * measurement of its *parent* rather than of itself: React redraws an un-memoised child exactly
 * when the component that drew it re-renders and hands it a new element. So:
 *
 * - `DeckNameField` counts the **header** (`DeckEditorHeader`, the ribbon it is drawn in);
 * - `DeckLedger`, `DeckStats`, `DeckNotesPanel` and `DeckSearchPanel` count the **editor** itself,
 *   which draws each of them — the ledger, the stats band, the notes band and the docked search
 *   wall the issue names;
 * - `DeckCardFace`, keyed by the card's name, counts **`CardStack`** — the stack draws one face per
 *   card, so a stack that was skipped draws none.
 *
 * Every probe keeps the real component's whole behaviour, so nothing here is a claim about a
 * surface that is not on screen.
 */
const { renders, bump } = vi.hoisted(() => {
  const renders = new Map<string, number>();
  return {
    renders,
    bump: (key: string) => {
      renders.set(key, (renders.get(key) ?? 0) + 1);
    },
  };
});

vi.mock("./DeckCardFace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DeckCardFace")>();
  const Real = actual.DeckCardFace;
  return {
    ...actual,
    DeckCardFace: (props: Parameters<typeof Real>[0]) => {
      bump(`face:${props.card.name}`);
      return <Real {...props} />;
    },
  };
});
vi.mock("./DeckNameField", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DeckNameField")>();
  const Real = actual.DeckNameField;
  return {
    ...actual,
    DeckNameField: (props: Parameters<typeof Real>[0]) => {
      bump("DeckNameField");
      return <Real {...props} />;
    },
  };
});
vi.mock("./DeckLedger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DeckLedger")>();
  const Real = actual.DeckLedger;
  return {
    ...actual,
    DeckLedger: (props: Parameters<typeof Real>[0]) => {
      bump("DeckLedger");
      return <Real {...props} />;
    },
  };
});
vi.mock("./DeckStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DeckStats")>();
  const Real = actual.DeckStats;
  return {
    ...actual,
    DeckStats: (props: Parameters<typeof Real>[0]) => {
      bump("DeckStats");
      return <Real {...props} />;
    },
  };
});
vi.mock("./DeckNotesPanel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DeckNotesPanel")>();
  const Real = actual.DeckNotesPanel;
  return {
    ...actual,
    DeckNotesPanel: (props: Parameters<typeof Real>[0]) => {
      bump("DeckNotesPanel");
      return <Real {...props} />;
    },
  };
});
vi.mock("./DeckSearchPanel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DeckSearchPanel")>();
  const Real = actual.DeckSearchPanel;
  return {
    ...actual,
    DeckSearchPanel: (props: Parameters<typeof Real>[0]) => {
      bump("DeckSearchPanel");
      return <Real {...props} />;
    },
  };
});

import { installWorld } from "@grimoire/fake/world";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { DEBOUNCE_MS } from "@/features/search/useCardSearch";
import { DeckEditor } from "./DeckEditor";

/** The starter world's first deck. Its Main pile holds lands and spells; its Maybeboard holds
 *  one card, Ancient Tomb, whose type line is `Land`. */
const DECK = 1;

const count = (key: string) => renders.get(key) ?? 0;

/**
 * The editor on the starter world's first deck, opened and **settled** — every query answered and
 * every answer drawn. The counter is cleared only after that, because a read landing in the middle
 * of the measurement would re-render the editor for a reason that has nothing to do with the
 * filter, and the test would be measuring the fake's latency.
 */
async function openSettled() {
  const world = installWorld({ seed: "starter" });
  onTestFinished(world.mount());
  render(
    <QueryClientProvider client={world.client}>
      <TooltipProvider>
        <ContextMenuProvider>
          <DeckEditor deckId={DECK} />
        </ContextMenuProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await screen.findByLabelText("Deck name");
  await waitFor(() => expect(count("face:Ancient Tomb")).toBeGreaterThan(0));
  await settle(world.client);
  renders.clear();
  return world;
}

/** Wait until nothing is fetching, twice over a tick — a query that answers can start another. */
async function settle(client: ReturnType<typeof installWorld>["client"]) {
  for (let pass = 0; pass < 2; pass += 1) {
    await waitFor(() => {
      expect(client.isFetching()).toBe(0);
      expect(client.isMutating()).toBe(0);
    });
    await act(() => new Promise((done) => setTimeout(done, DEBOUNCE_MS + 50)));
  }
}

describe("DeckDesk — what a filter keystroke re-renders (issue #557)", () => {
  it("re-renders the desk and nothing above it, and skips a pile the filter took nothing from", async () => {
    const world = await openSettled();
    const user = userEvent.setup();

    await user.type(screen.getByRole("searchbox", { name: "Filter this deck" }), "land");
    // The filter has answered: Lightning Bolt is not a land, so its pile no longer draws it.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Lightning Bolt/ })).toBeNull(),
    );
    await settle(world.client);

    // **The control**: the Main pile lost its spells, so its stack was drawn again — which is what
    // proves the counter is wired to the stack at all.
    expect(count("face:Island")).toBeGreaterThan(0);

    // **The pile the filter took nothing from**: the Maybeboard's one card is a land, so its rows
    // are the same objects in the same order and `CardStack` was not drawn again — four keystrokes,
    // no face.
    expect(count("face:Ancient Tomb")).toBe(0);
    expect(screen.getAllByRole("button", { name: /Ancient Tomb/ }).length).toBeGreaterThan(0);

    // **The siblings that do not read the filter**: the header, the ledger, the stats band, the
    // notes band and the docked search wall. Not one of them was drawn again, because the filter
    // is `DeckDesk`'s state and a keystroke never re-renders the editor that draws them.
    expect({
      header: count("DeckNameField"),
      ledger: count("DeckLedger"),
      stats: count("DeckStats"),
      notes: count("DeckNotesPanel"),
      search: count("DeckSearchPanel"),
    }).toEqual({ header: 0, ledger: 0, stats: 0, notes: 0, search: 0 });
  });

  it("does not redraw a single pile for a render of the editor that changed nothing on the desk", async () => {
    const world = await openSettled();
    const user = userEvent.setup();

    // A layer opening is a render of the editor — its one `Layer` slot is editor state — and it
    // changes nothing any pile draws. The probes above it prove the editor did render.
    await user.click(screen.getByRole("button", { name: "History" }));
    await screen.findByRole("dialog");
    await settle(world.client);

    expect(count("DeckStats")).toBeGreaterThan(0);
    expect(count("face:Island")).toBe(0);
    expect(count("face:Ancient Tomb")).toBe(0);
  });
});
