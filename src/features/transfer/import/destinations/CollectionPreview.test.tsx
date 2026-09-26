/**
 * The collection destination's preview, mounted directly — what is under test is what the step
 * **says** about a file before the reader commits, not the dialog's step machine.
 *
 * One fact lives here and nowhere else: a `Purchase price` cell the file filled and the parser
 * refused is **listed**, because the copy lands with no price and this list is the only place the
 * reader learns the cell was not empty. `planCollectionImport`'s own test proves the plan carries
 * the line; this proves the line reaches the screen.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ImportResolveRow } from "@/lib/ipc";
import { parseDecklist } from "../parse";
import { CollectionPreview } from "./CollectionPreview";

/** A resolved row, with everything this preview does not read left out. */
const hit = (index: number, name: string): ImportResolveRow =>
  ({
    index,
    hintMissed: false,
    matched: { cardId: `c${index}`, oracleId: `o${index}`, name, setCode: "ltc", collectorNumber: "1" },
  }) as unknown as ImportResolveRow;

function mount(csv: string) {
  const list = parseDecklist(csv);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CollectionPreview
        list={list}
        resolved={list.lines.map((line, i) => hit(i, line.name))}
        tags={[]}
        onDone={vi.fn()}
        onBack={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

const CAPTION =
  "1 line had a purchase price this app could not read, and will be added without one";

describe("CollectionPreview", () => {
  /** An older build's `1.125` — refused as ambiguous — is named with its line and its words. */
  it("lists a purchase price it could not read, by line", () => {
    mount("Quantity,Name,Purchase price\n1,Sol Ring,4.25\n1,Lightning Bolt,1.125\n");

    expect(screen.getByText(CAPTION)).toBeInTheDocument();
    expect(screen.getByText(`line 3 · Lightning Bolt — "1.125"`)).toBeInTheDocument();
    expect(screen.getByText(/2 cards will be added/)).toBeInTheDocument();
  });

  /** The control: every cell reads, so there is nothing to list — the caption is the list's. */
  it("says nothing when every price reads", () => {
    mount("Quantity,Name,Purchase price\n1,Sol Ring,4.25\n1,Lightning Bolt,1.1250\n");

    expect(screen.queryByText(CAPTION)).toBeNull();
    expect(screen.queryByText(/could not read/)).toBeNull();
  });
});
