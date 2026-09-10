/**
 * Which view the app opens on, chosen from Settings.
 *
 * **Every assertion here is about the word on the closed trigger or the argument on the wire**,
 * and the first of those is the one worth having. A picker whose stored value matches no row it
 * draws is the app's oldest silent failure — a controlled native `<select>` shows its **first**
 * row while still reporting the old value, so a test that asks "is nothing selected?" passes over
 * the bug and a reader is told their app opens on `Collection` when it opens on somebody else's
 * binder. So nothing below asserts an absence: each case names the value the control is showing.
 *
 * The panel reaches the backend itself, so `startView` and `setStartView` are the whole of the
 * world here. `setStartView` records what it was called with rather than merely counting, because
 * the two things most worth failing on are shaped like arguments: the wrong view id, and a second
 * write nobody asked for.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { startView, setStartView, sent } = vi.hoisted(() => {
  const sent: string[] = [];
  return {
    sent,
    startView: vi.fn(),
    setStartView: vi.fn((view: string) => {
      sent.push(view);
      return Promise.resolve(undefined);
    }),
  };
});

// The two commands this panel is, and nothing else. `importOriginal` keeps `ipcError`, which
// nothing here draws today and which the module's other consumers still import from it.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { startView, setStartView },
}));

import { StartViewPanel } from "./StartViewPanel";
import { openDropdown, pickOption } from "@/test-dropdown";

/**
 * A fresh client per test rather than the app's own module-level one.
 *
 * `useStartView` is `staleTime: Infinity` and `gcTime: Infinity` on purpose — the entry is meant
 * to outlive every observer in the window — so a shared client would carry one case's stored word
 * into the next, and the "a word this build does not draw" case would then be answering about
 * whatever ran before it.
 */
function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

/** The trigger, by the name `Dropdown` is given rather than by the word it happens to show. */
const picker = () => screen.getByRole("button", { name: "Opening view" });

/** Draw the panel over a database whose `start_view` row holds `stored`, and wait for the read. */
async function open(stored: string, shows: string) {
  startView.mockResolvedValue(stored);
  render(wrap(<StartViewPanel />));
  // Let the launch read settle **inside** `act`. Two of the cases below store the word the hook
  // already falls back to, so their `waitFor` is satisfied on its first check — before the query
  // has resolved — and the resolution would then land outside `act` and print a warning about a
  // state update nobody was waiting for. One flushed microtask is the whole fix.
  await act(async () => {});
  // The read is a round trip, so the first paint is the hook's own fallback whatever is stored.
  // Waiting for the word is what makes every later assertion about the answer rather than about
  // the wait — and, for the Home cases, it is the only thing separating "arrived" from "never
  // asked", which is why each case below states a word rather than a settled flag.
  await waitFor(() => expect(picker()).toHaveTextContent(shows));
}

beforeEach(() => {
  sent.length = 0;
  startView.mockReset();
  setStartView.mockClear();
});

describe("StartViewPanel", () => {
  /**
   * The panel is found by its own heading, which is `panelChrome`'s pairing: a
   * `<section aria-labelledby>` has a name only while some `id` in the document matches it, and a
   * mismatch loses that name silently rather than drawing anything wrong.
   */
  it("draws a named region", async () => {
    await open("home", "Home");
    expect(screen.getByRole("region", { name: "Opening view" })).toBeInTheDocument();
  });

  /**
   * **Every unconditional destination, in one literal, alphabetically by the word on screen.**
   *
   * Written out rather than derived from `NAV`: an expectation computed from the thing it checks
   * passes against any defect, and both facts under test here — which rows are offered and what
   * order they come in — are exactly the kind a derivation would erase. The order is
   * `sortOptions`' and no row is pinned, so Home sits at C-D-**H** like any other word.
   */
  it("offers every destination the rail always draws, alphabetically", async () => {
    const user = userEvent.setup();
    await open("home", "Home");

    await openDropdown(user, "Opening view");

    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Collection",
      "Decks",
      "Home",
      "Playtesting",
      "Scanner",
      "Search",
      "Settings",
      "Tagger",
      "Trade",
      "Wishlist",
    ]);
  });

  /**
   * **Shared is not on that list, and this says so as its own claim.**
   *
   * Its row appears on the rail only once a reader has opened a link (spec decision 6), so a
   * reader who picked it here could set the app to open on a page with no row pointing at it.
   * That is the same fact that costs the view its `Ctrl+…` chord, met from a second surface.
   */
  it("does not offer Shared", async () => {
    const user = userEvent.setup();
    await open("home", "Home");

    await openDropdown(user, "Opening view");

    expect(screen.queryByRole("option", { name: "Shared" })).not.toBeInTheDocument();
  });

  it("says which view the app is set to open on", async () => {
    await open("decks", "Decks");
    expect(picker()).toHaveTextContent("Decks");
  });

  /**
   * The press, end to end: the word on the trigger moves and exactly one command goes out.
   *
   * **Once**, because `useStartView`'s write is optimistic — the cache is set before the mutation
   * is sent — and an implementation that also invalidated the entry would re-read the row and
   * write it straight back, which is a second round trip per press and a picker that flickers
   * under a slow database.
   */
  it("writes the reader's choice through one command", async () => {
    const user = userEvent.setup();
    await open("home", "Home");

    await pickOption(user, "Opening view", "Search");

    expect(sent).toEqual(["search"]);
    expect(picker()).toHaveTextContent("Search");
  });

  /**
   * **A stored view this build does not offer, named rather than silently replaced.**
   *
   * `shared` is a real `ViewId`, so `useStartView` hands it back as itself — it is only the
   * *picker* that has no row for it, and the app really will open there on the next launch. The
   * assertion that matters is the second one: `Collection` is the first row alphabetically, which
   * is precisely what a controlled native `<select>` would have drawn here while reporting
   * `shared`. A test asserting "nothing is selected" would have passed over that.
   */
  it("names a stored view it does not offer, rather than showing its first row", async () => {
    await open("shared", "Shared");

    expect(picker()).toHaveTextContent("Shared");
    expect(picker()).not.toHaveTextContent("Collection");
  });

  /**
   * A word no build has ever drawn, which is what a downgrade leaves behind: `startview.rs`
   * stores what it is given and refuses no vocabulary, deliberately, so the narrowing is
   * TypeScript's and lands on Home.
   */
  it("falls back to Home for a word this build has never heard of", async () => {
    await open("someViewFromTheFuture", "Home");
    expect(picker()).toHaveTextContent("Home");
  });

  /**
   * And a read that fails is Home too, never an error: what is left to fail is the IPC boundary
   * and a `BUSY` under a sync, and neither is worth a Settings panel that will not draw.
   */
  it("falls back to Home when the read fails", async () => {
    startView.mockRejectedValue(new Error("BUSY"));
    render(wrap(<StartViewPanel />));

    await waitFor(() => expect(picker()).toHaveTextContent("Home"));
  });
});
