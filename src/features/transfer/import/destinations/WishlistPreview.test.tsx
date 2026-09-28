/**
 * The wishlist destination's preview, mounted directly — `CollectionPreview.test.tsx`'s twin,
 * for the two things issue #555 changed here: a landed import leaves an undo offer behind for the
 * wishlist page to draw, and a `set` file stops promising additions it does not make.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBulkUndo, useBulkUndo } from "@/lib/bulkUndo";
import type { ImportCommitOutcome, ImportResolveRow } from "@/lib/ipc";
import { parseDecklist } from "../parse";

const wishlistImportCommit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, wishlistImportCommit } };
});

import { WishlistPreview } from "./WishlistPreview";

const hit = (index: number, name: string): ImportResolveRow =>
  ({
    index,
    hintMissed: false,
    matched: { cardId: `c-${name}`, oracleId: `o-${name}`, name, setCode: "ltc", collectorNumber: "1" },
  }) as unknown as ImportResolveRow;

const outcome = (over: Partial<ImportCommitOutcome> = {}): ImportCommitOutcome => ({
  added: 0,
  updated: 0,
  removed: 0,
  copies: 0,
  leftInFolders: 0,
  undoId: null,
  ...over,
});

function mount(text: string) {
  const list = parseDecklist(text);
  const onDone = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WishlistPreview
        list={list}
        resolved={list.lines.map((line, i) => hit(i, line.name))}
        tags={[]}
        onDone={onDone}
        onBack={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { onDone };
}

beforeEach(() => {
  wishlistImportCommit.mockReset().mockResolvedValue(outcome({ added: 1 }));
  resetBulkUndo();
});

describe("WishlistPreview", () => {
  it("offers to undo an add, on the wishlist and not the collection", async () => {
    const user = userEvent.setup();
    wishlistImportCommit.mockResolvedValue(outcome({ added: 2, undoId: 7 }));
    const { onDone } = mount("3 Sol Ring\n1 Lightning Bolt\n");

    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(useBulkUndo.getState().offers).toEqual({
      collection: null,
      wishlist: { id: 7, scope: "wishlist", label: "Imported 4 cards into your wishlist." },
    });
  });

  /** A `set` lowers some wishes and removes others, so "will be added" was wrong about it; the
   *  sentence says only what the file is, which is true whatever the rows already hold. */
  it("says what a set does, and offers to undo it in those words", async () => {
    const user = userEvent.setup();
    wishlistImportCommit.mockResolvedValue(outcome({ updated: 1, undoId: 8 }));
    const { onDone } = mount("3 Sol Ring\n");

    await user.click(screen.getByRole("radio", { name: "Set these quantities" }));

    expect(screen.getByText("Sets how many you want of 1 card.")).toBeInTheDocument();
    expect(screen.queryByText(/will be added/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(wishlistImportCommit).toHaveBeenCalledWith(expect.any(Array), "set");
    expect(useBulkUndo.getState().offers.wishlist).toEqual({
      id: 8,
      scope: "wishlist",
      label: "Set wishlist quantities from a file of 1 card.",
    });
  });

  /** An outcome from a double that predates the ticket carries no `undoId` at all — which is
   *  what every other suite's mock still answers — and must not publish an offer with no id. */
  it("offers nothing when the outcome carries no ticket", async () => {
    const user = userEvent.setup();
    wishlistImportCommit.mockResolvedValue({ added: 1, updated: 0, removed: 0 });
    const { onDone } = mount("1 Sol Ring\n");

    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(useBulkUndo.getState().offers.wishlist).toBeNull();
  });
});
