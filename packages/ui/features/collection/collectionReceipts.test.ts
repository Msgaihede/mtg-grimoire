/**
 * The collection page's receipts — the words, and `report`'s one rule: every call's own promise
 * is answered, which is what `mutate`'s per-call callbacks do not promise.
 */
import { describe, expect, it, vi } from "vitest";
import { useNotifications } from "@/lib/notifications";
import { addedReceipt, movedReceipt, removedReceipt, report } from "./collectionReceipts";

describe("the receipts' words", () => {
  it("names one card and counts several, in entries", () => {
    expect(removedReceipt(1, "Sol Ring")).toBe("Removed “Sol Ring” from the collection");
    expect(removedReceipt(3, "Sol Ring")).toBe("Removed 3 cards from the collection");
    // A copy the list could not name is counted rather than drawn as empty quotes.
    expect(removedReceipt(1, null)).toBe("Removed 1 card from the collection");
    expect(movedReceipt(1, "Sol Ring", "Trade binder")).toBe("Moved “Sol Ring” to “Trade binder”");
    expect(movedReceipt(50, "Sol Ring", "Trade binder")).toBe("Moved 50 cards to “Trade binder”");
    expect(addedReceipt("Black Lotus", "Collection")).toBe("Added “Black Lotus” to “Collection”");
    expect(addedReceipt("", "Collection")).toBe("Added 1 card to “Collection”");
  });
});

describe("report", () => {
  it("answers every press, two in quick succession included", async () => {
    const then = vi.fn();
    report(Promise.resolve(1), { done: (n) => `First ${n}`, failed: "Couldn't first", then });
    report(Promise.resolve(2), { done: (n) => `Second ${n}`, failed: "Couldn't second" });

    await vi.waitFor(() => expect(useNotifications.getState().notices).toHaveLength(2));
    expect(then).toHaveBeenCalledWith(1);
    expect(useNotifications.getState().notices.map((n) => [n.title, n.tone])).toEqual([
      ["Second 2", "success"],
      ["First 1", "success"],
    ]);
  });

  it("says a refusal in the backend's words and runs nothing meant for a success", async () => {
    const then = vi.fn();
    report(Promise.reject("That folder is locked."), {
      done: () => "Never",
      failed: "Couldn't move “Foils”",
      then,
    });

    await vi.waitFor(() =>
      expect(useNotifications.getState().notices[0]).toMatchObject({
        title: "Couldn't move “Foils”",
        body: "That folder is locked.",
        tone: "error",
      }),
    );
    expect(then).not.toHaveBeenCalled();
  });
});
