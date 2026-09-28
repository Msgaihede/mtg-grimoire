import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bulkUndo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { bulkUndo },
}));

import { offerUndo, resetBulkUndo, useBulkUndo } from "@/lib/bulkUndo";
import { DISMISS_UNDO, UndoNotice } from "./UndoNotice";

let client: QueryClient;

function mount(scope: "collection" | "wishlist" = "collection") {
  return render(
    <QueryClientProvider client={client}>
      <UndoNotice scope={scope} />
    </QueryClientProvider>,
  );
}

/** A promise the test settles by hand, for the press that is still on its way. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const region = () => screen.getByRole("status", { name: "Undo" });

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  bulkUndo.mockReset().mockResolvedValue({ scope: "collection", restored: 3 });
  resetBulkUndo();
});

describe("UndoNotice", () => {
  /**
   * **The region is there before the offer is**, which is the whole of what makes a screen reader
   * hear the sentence: a live region that arrives with its words already inside announces nothing.
   */
  it("keeps an empty live region mounted, and swaps the offer into it", () => {
    mount();
    expect(region()).toBeEmptyDOMElement();

    act(() => offerUndo("collection", 12, "Removed 3 cards from your collection."));

    expect(region()).toHaveTextContent("Removed 3 cards from your collection.");
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("draws only its own scope's offer", () => {
    mount("wishlist");
    act(() => offerUndo("collection", 12, "Removed 3 cards from your collection."));
    expect(region()).toBeEmptyDOMElement();
  });

  it("takes the write back, re-reads what it put back, and takes the offer down", async () => {
    const user = userEvent.setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mount();
    act(() => offerUndo("collection", 12, "Removed 3 cards from your collection."));

    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(bulkUndo).toHaveBeenCalledTimes(1);
    expect(bulkUndo).toHaveBeenCalledWith(12);
    await waitFor(() => expect(useBulkUndo.getState().offers.collection).toBeNull());
    await waitFor(() => expect(region()).toBeEmptyDOMElement());
    // `OWNED_WRITE_KEYS`, which is what every other collection write that can put rows back fires.
    for (const queryKey of [["collection"], ["wishlist"], ["decks"]]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("re-reads the wishlist's own roots for a wishlist ticket", async () => {
    bulkUndo.mockResolvedValue({ scope: "wishlist", restored: 40 });
    const user = userEvent.setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mount("wishlist");
    act(() => offerUndo("wishlist", 5, "Imported 40 cards."));

    await user.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] }));
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["collection"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["decks"] });
  });

  /**
   * **A refusal retires the ticket in Rust, so it takes the offer down here** — a button left on
   * screen would promise a second press the backend answers the same way — and it is said in the
   * page's alert voice, with the backend's own sentence.
   */
  it("says a refusal in the alert voice and takes the offer down", async () => {
    bulkUndo.mockRejectedValue(
      "Some of those cards have changed since, so this can no longer be undone.",
    );
    const user = userEvent.setup();
    mount();
    act(() => offerUndo("collection", 12, "Removed 3 cards from your collection."));

    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't undo — Some of those cards have changed since, so this can no longer be undone.",
    );
    await waitFor(() => expect(useBulkUndo.getState().offers.collection).toBeNull());
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  /** The refusal speaks until a newer write replaces it, the page banner's rule. */
  it("takes a refusal down when a newer offer arrives", async () => {
    bulkUndo.mockRejectedValue("That can no longer be undone.");
    const user = userEvent.setup();
    mount();
    act(() => offerUndo("collection", 12, "Removed 3 cards from your collection."));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByRole("alert");

    act(() => offerUndo("collection", 13, "Moved 2 cards to Trade binder."));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(region()).toHaveTextContent("Moved 2 cards to Trade binder.");
  });

  /**
   * **Greyed with `aria-disabled` while the undo is on its way, and a second press sends
   * nothing** — the button stays in the tab order (a `disabled` one would drop the caret), so the
   * refusal has to be the handler's.
   */
  it("greys the button while the undo is on its way and refuses a second press", async () => {
    const answer = deferred<{ scope: "collection"; restored: number }>();
    bulkUndo.mockReturnValue(answer.promise);
    const user = userEvent.setup();
    mount();
    act(() => offerUndo("collection", 12, "Removed 3 cards from your collection."));

    const button = screen.getByRole("button", { name: "Undo" });
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
    expect(button).not.toBeDisabled();

    await user.click(button);
    expect(bulkUndo).toHaveBeenCalledTimes(1);

    await act(async () => answer.resolve({ scope: "collection", restored: 3 }));
    await waitFor(() => expect(useBulkUndo.getState().offers.collection).toBeNull());
  });

  /** An answer that lands after a newer write replaced the offer must not take the newer one down. */
  it("leaves a newer offer standing when the older ticket's answer lands", async () => {
    const answer = deferred<{ scope: "collection"; restored: number }>();
    bulkUndo.mockReturnValue(answer.promise);
    const user = userEvent.setup();
    mount();
    act(() => offerUndo("collection", 12, "Removed 3 cards from your collection."));
    await user.click(screen.getByRole("button", { name: "Undo" }));

    act(() => offerUndo("collection", 13, "Moved 2 cards to Trade binder."));
    await act(async () => answer.resolve({ scope: "collection", restored: 3 }));

    await waitFor(() => expect(bulkUndo).toHaveBeenCalledTimes(1));
    expect(useBulkUndo.getState().offers.collection?.id).toBe(13);
    expect(region()).toHaveTextContent("Moved 2 cards to Trade binder.");
  });

  it("takes the offer down unpressed on its ✕, and writes nothing", async () => {
    const user = userEvent.setup();
    mount();
    act(() => offerUndo("collection", 12, "Removed 3 cards from your collection."));

    await user.click(screen.getByRole("button", { name: DISMISS_UNDO }));

    expect(bulkUndo).not.toHaveBeenCalled();
    expect(useBulkUndo.getState().offers.collection).toBeNull();
    await waitFor(() => expect(region()).toBeEmptyDOMElement());
  });
});
