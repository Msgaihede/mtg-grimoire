import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewRow, ReviewTable } from "@/lib/ipc";

const syncReviewList = vi.hoisted(() => vi.fn());
const syncReviewClear = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { syncReviewList, syncReviewClear },
}));

import { ReviewPanel, groupByTable } from "./ReviewPanel";

/**
 * `sync_engine::apply::RESURRECTED`, verbatim — §7.4's first surfaced outcome.
 *
 * Copied rather than paraphrased on purpose: this file's whole subject is that the page draws
 * what Rust wrote, so a fixture in the page's own words would prove nothing at all.
 */
const RESURRECTED =
  "Another device deleted this while this one was still changing it, so it was kept.";

/** `sync_engine::apply::CYCLE_BROKEN`, verbatim — §7.4's second, and the one the three folder
 *  tables gained a column for at user schema v29. */
const CYCLE_BROKEN =
  "A folder move on another device would have put this folder inside itself. It was moved to " +
  "the top level.";

/** `reconcile.rs`' sentence for a printing that left the card database — the reason this
 *  column existed before a relay did, and why its rows are listed here too. */
const MISSING =
  "This printing is not in the card database. It may have been removed by the last card-data " +
  "sync, or it may return with the next one.";

const ROWS: ReviewRow[] = [
  {
    table: "collection_entries",
    uid: "collection_entries:12",
    title: "Ragavan, Nimble Pilferer",
    sentence: RESURRECTED,
  },
  { table: "deck_cards", uid: "deck_cards:41", title: "Psychic Frog", sentence: MISSING },
  { table: "deck_folders", uid: "deck_folders:2", title: "Commander", sentence: CYCLE_BROKEN },
];

function harness() {
  return function Harness({ children }: { children: ReactNode }) {
    const [client] = useState(
      () =>
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, staleTime: Infinity },
            mutations: { retry: false },
          },
        }),
    );
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const wrapper = harness();

beforeEach(() => {
  syncReviewList.mockReset().mockResolvedValue(ROWS);
  syncReviewClear.mockReset().mockResolvedValue([]);
});

describe("ReviewPanel", () => {
  /**
   * **The one rule this panel has.** Rust wrote the sentence and the page does not reword it,
   * shorten it or turn it into an icon — so the assertion is an exact string rather than a
   * regex, which is the only shape that fails when a word is dropped.
   */
  it("draws the sentence exactly as it arrived", async () => {
    render(<ReviewPanel />, { wrapper });

    expect(await screen.findByText(RESURRECTED)).toBeInTheDocument();
    expect(screen.getByText(CYCLE_BROKEN)).toBeInTheDocument();
    expect(screen.getByText(MISSING)).toBeInTheDocument();
  });

  it("names the row so a reader knows which card is being asked about", async () => {
    render(<ReviewPanel />, { wrapper });

    expect(await screen.findByText("Ragavan, Nimble Pilferer")).toBeInTheDocument();
    expect(screen.getByText("Commander")).toBeInTheDocument();
  });

  /** Never the raw table name: a person has a collection and decks, not a `deck_folders`. */
  it("files each row under a heading a person would recognise", async () => {
    render(<ReviewPanel />, { wrapper });

    expect(await screen.findByRole("heading", { name: "The collection" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Decks" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Deck folders" })).toBeInTheDocument();
    // A heading with nothing under it is as wrong as a row with no heading: only the three
    // tables that have a row are drawn.
    expect(screen.queryByRole("heading", { name: "The wishlist" })).not.toBeInTheDocument();
    expect(screen.queryByText(/collection_entries|deck_cards|deck_folders/)).toBeNull();
  });

  it("clears one row and redraws from what is left", async () => {
    const user = userEvent.setup();
    syncReviewClear.mockResolvedValue(ROWS.filter((r) => r.table !== "deck_folders"));
    render(<ReviewPanel />, { wrapper });

    await user.click(
      await screen.findByRole("button", { name: /looks fine, commander/i }),
    );

    await waitFor(() =>
      expect(syncReviewClear).toHaveBeenCalledWith("deck_folders", "deck_folders:2"),
    );
    // The command answers what is left and the list is redrawn from that answer, so the row is
    // gone without a second read.
    await waitFor(() => expect(screen.queryByText(CYCLE_BROKEN)).not.toBeInTheDocument());
    expect(screen.getByText(RESURRECTED)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Deck folders" })).not.toBeInTheDocument();
  });

  /**
   * An empty queue is the good state and has to read like one. It is where every install starts
   * and where most stay, so "No rows found" — which reads as a search that came back empty —
   * would be the wrong sentence on almost every visit.
   */
  it("reads an empty queue as good news", async () => {
    syncReviewList.mockResolvedValue([]);
    render(<ReviewPanel />, { wrapper });

    expect(await screen.findByText(/nothing needs a look/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /looks fine/i })).not.toBeInTheDocument();
  });

  it("says the queue could not be read rather than drawing it empty", async () => {
    syncReviewList.mockRejectedValue("The database is busy right now.");
    render(<ReviewPanel />, { wrapper });

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing needs a look/i)).not.toBeInTheDocument();
  });

  it("shows the refusal when a clear is turned down", async () => {
    const user = userEvent.setup();
    syncReviewClear.mockRejectedValue("The database is busy right now.");
    render(<ReviewPanel />, { wrapper });

    await user.click(await screen.findByRole("button", { name: /looks fine, psychic frog/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/busy/i);
    // Nothing was cleared, so the row is still there to try again on.
    expect(screen.getByText(MISSING)).toBeInTheDocument();
  });
});

describe("groupByTable", () => {
  /** All six tables the crate's `REVIEWABLE` census names, each with a name a person would
   *  recognise, in the order the crate returns them. */
  it("names every table the backend can send a row from", () => {
    // Typed as `ReviewTable[]` and not `string[]`, which is the point of the union: a seventh
    // table the crate grows is a type error in this literal as well as in `TABLE_LABEL`.
    const tables: ReviewTable[] = [
      "collection_entries",
      "deck_cards",
      "wishlist_entries",
      "collection_folders",
      "deck_folders",
      "wishlist_folders",
    ];
    const rows = tables.map((table, i) => ({
      table,
      uid: `${table}:${i}`,
      title: "x",
      sentence: "y",
    }));

    expect(groupByTable(rows).map((g) => g.label)).toEqual([
      "The collection",
      "Decks",
      "The wishlist",
      "Collection folders",
      "Deck folders",
      "Wishlist folders",
    ]);
  });

  it("drops a table with nothing in it rather than drawing an empty heading", () => {
    expect(groupByTable([]).length).toBe(0);
    expect(groupByTable(ROWS).map((g) => g.table)).toEqual([
      "collection_entries",
      "deck_cards",
      "deck_folders",
    ]);
  });

  /**
   * A seventh table is drift, not a crash — and a row filed under a raw table name would be the
   * one thing this panel promises never to draw.
   *
   * **The cast is the point rather than a shortcut.** `ReviewTable` is closed, so a seventh
   * table is a type error in `TABLE_LABEL` and in every literal that builds a row — which is the
   * fence, and which is why this state cannot be written honestly. What it cannot fence is a row
   * arriving at run time from a build that knows one more table than this page does, and that is
   * what is asserted here.
   */
  it("still files a row from a table this build has no name for", () => {
    const stray = {
      table: "muted_tags",
      uid: "muted_tags:1",
      title: "Ramp",
      sentence: "s",
    } as unknown as ReviewRow;
    const groups = groupByTable([...ROWS, stray]);

    const last = groups[groups.length - 1];
    expect(last.label).toBe("Elsewhere");
    expect(last.rows).toEqual([stray]);
    expect(groups.map((g) => g.label)).not.toContain("muted_tags");
  });
});
