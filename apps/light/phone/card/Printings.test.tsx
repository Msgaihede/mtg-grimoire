import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));

import { PRINTING_GROUP_BY_KEY } from "@grimoire/ui/features/card/usePrintingGroupBy";
import type { Printing } from "@grimoire/ui/lib/ipc";
import { PRINTINGS_FOLDED, PrintingsSection } from "./Printings";

/** One printing of a card, released on `releasedAt` — only the facts the list draws. */
const printing = (n: number, releasedAt: string): Printing => ({
  id: `p${n}`,
  setCode: "blb",
  setName: "Bloomburrow",
  collectorNumber: String(n),
  releasedAt,
  rarity: "rare",
  illustrationId: null,
  artist: null,
  lang: "en",
  finishes: '["nonfoil"]',
  finishPrices: { nonfoil: null, foil: null, etched: null },
  promo: false,
  promoTypes: null,
  fullArt: false,
  frameEffects: null,
  borderColor: null,
  layout: "normal",
});

/** Seven variants on one release date, and one older printing: the first group is bigger than
 *  the fold. */
const ITEMS: Printing[] = [
  ...Array.from({ length: 7 }, (_, i) => printing(i + 1, "2024-08-02")),
  printing(8, "1993-08-05"),
];

function renderSection() {
  const client = new QueryClient();
  // Grouped by release date, the default, seeded rather than read.
  client.setQueryData(PRINTING_GROUP_BY_KEY, "released");
  render(
    <QueryClientProvider client={client}>
      <PrintingsSection
        cardId="p1"
        place={{ view: "search", deckId: null, cardId: "p1" }}
        items={ITEMS}
        total={ITEMS.length}
        loading={false}
        error={null}
        currency="usd"
      />
    </QueryClientProvider>,
  );
  return screen.getByRole("region", { name: "Printings" });
}

describe("the card sheet's printings", () => {
  it("counts a folded group by its whole size, not by the rows the fold leaves drawn", async () => {
    expect(ITEMS.length).toBeGreaterThan(PRINTINGS_FOLDED);
    const section = renderSection();
    expect(within(section).getByText("8 printings · 2 release dates")).toBeInTheDocument();

    // Folded: five rows of the first group drawn, and its heading still says seven.
    expect(within(section).getAllByRole("listitem")).toHaveLength(PRINTINGS_FOLDED);
    expect(within(section).getByText("· 7")).toBeInTheDocument();
    expect(within(section).queryByText(`· ${PRINTINGS_FOLDED}`)).toBeNull();

    // Unfolded: the same seven, and the older group with its one.
    await userEvent.click(within(section).getByRole("button", { name: /Show all/ }));
    expect(within(section).getAllByRole("listitem")).toHaveLength(ITEMS.length);
    expect(within(section).getByText("· 7")).toBeInTheDocument();
    expect(within(section).getByText("· 1")).toBeInTheDocument();
  });
});
