import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardSummary, SearchResponse } from "@/lib/ipc";

vi.mock("@/lib/ipc", async (orig) => {
  const real = await orig<typeof import("@/lib/ipc")>();
  return {
    ...real,
    ipc: {
      ...real.ipc,
      searchCards: vi.fn(async (): Promise<SearchResponse> => ({
        items: [],
        total: 0,
        totalIsCapped: false,
      })),
    },
  };
});

import { ipc } from "@/lib/ipc";
import { CHOOSE_ITS_FINISH } from "../submit/submitText";
import type { ScannerFinishPref } from "../types";
import { AddCardDialog, CHOOSE_A_PRINTING } from "./AddCardDialog";

function printing(
  over: Partial<CardSummary> & Pick<CardSummary, "id" | "setCode" | "collectorNumber">,
): CardSummary {
  return {
    name: "Lightning Bolt",
    setName: null,
    rarity: "common",
    typeLine: "Instant",
    manaCost: "{R}",
    price: null,
    layout: "normal",
    oracleId: "bolt",
    finishes: '["nonfoil","foil"]',
    promoTypes: null,
    gameChanger: false,
    releasedAt: null,
    imageUpdatedAt: null,
    ownedQuantity: 0,
    wishlisted: false,
    printings: 1,
    priceLow: null,
    priceHigh: null,
    ...over,
  };
}

const DBL = printing({ id: "bolt-2x2", setCode: "2x2", collectorNumber: "117" });
const JGP = printing({
  id: "bolt-jgp",
  setCode: "jgp",
  collectorNumber: "1",
  finishes: '["foil"]',
});

function open(finishPref: ScannerFinishPref = "detect") {
  const onAdd = vi.fn();
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AddCardDialog
        open
        finishPref={finishPref}
        onAdd={onAdd}
        onDismiss={onDismiss}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { onAdd, onDismiss, onClose };
}

const dialog = () => screen.getByRole("dialog", { name: "Add a card" });
const add = () => within(dialog()).getByRole("button", { name: "Add to tray" });
const finish = (name: string) =>
  within(screen.getByRole("radiogroup", { name: "Finish" })).getByRole("radio", { name });

async function search(text: string) {
  await userEvent.type(
    within(dialog()).getByRole("searchbox", { name: "Which card do you want to add?" }),
    text,
  );
}
const tile = (setCode: string) =>
  within(dialog()).findByRole("radio", { name: new RegExp(`${setCode.toUpperCase()}`) });

beforeEach(() => {
  vi.mocked(ipc.searchCards).mockResolvedValue({
    items: [DBL, JGP],
    total: 2,
    totalIsCapped: false,
  });
});
afterEach(() => vi.mocked(ipc.searchCards).mockReset());

describe("AddCardDialog", () => {
  it("opens empty, says the scanner is paused, and asks nothing until typed into", () => {
    open();
    expect(
      within(dialog()).getByText("Scanning is paused while this is open."),
    ).toBeInTheDocument();
    expect(ipc.searchCards).not.toHaveBeenCalled();
    expect(add()).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog()).getByText(CHOOSE_A_PRINTING)).toBeInTheDocument();
  });

  it("holds Add until both the printing and its finish are chosen, then hands both over", async () => {
    const { onAdd } = open();
    await search("bolt");
    await userEvent.click(await tile("2x2"));
    expect(within(dialog()).getByText(CHOOSE_ITS_FINISH)).toBeInTheDocument();
    await userEvent.click(add());
    expect(onAdd).not.toHaveBeenCalled();

    await userEvent.click(finish("Foil"));
    await userEvent.click(add());
    expect(onAdd).toHaveBeenCalledWith(
      {
        cardId: "bolt-2x2",
        oracleId: "bolt",
        name: "Lightning Bolt",
        setCode: "2x2",
        collectorNumber: "117",
      },
      "foil",
    );
  });

  it("takes a printing's only finish, and the Defaults' fixed one where the printing has it", async () => {
    const { onAdd } = open("nonfoil");
    await search("bolt");
    await userEvent.click(await tile("jgp"));
    expect(finish("Foil")).toHaveAttribute("aria-checked", "true");
    await userEvent.click(await tile("2x2"));
    expect(finish("Nonfoil")).toHaveAttribute("aria-checked", "true");
    await userEvent.click(add());
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ cardId: "bolt-2x2" }), "nonfoil");
  });

  it("Cancel is a dismissal, and adds nothing", async () => {
    const { onAdd, onDismiss } = open();
    await userEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(onDismiss).toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });
});
