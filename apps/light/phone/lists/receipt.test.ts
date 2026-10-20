import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECEIPT_MS } from "../deck/receipt";
import { useListReceipt } from "./receipt";

/** A promise the test answers by hand — the slow `bulk_undo` of issue #1157. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the list receipt", () => {
  /** A removal that has landed and offers its undo, through `run`. */
  async function removed(run: () => Promise<unknown>) {
    const hook = renderHook(() => useListReceipt());
    await act(async () => {
      hook.result.current.track(
        Promise.resolve(2),
        (n) => `Removed ${n} copies`,
        () => ({ name: "2 copies", run }),
      );
    });
    expect(hook.result.current.text).toBe("Removed 2 copies");
    return hook;
  }

  it("goes by itself once its time is up", async () => {
    const { result } = await removed(() => Promise.resolve());
    act(() => vi.advanceTimersByTime(RECEIPT_MS));
    expect(result.current.text).toBeNull();
  });

  it("stays up while the undo is out, and says a late refusal for a full stretch of its own", async () => {
    const undo = deferred();
    const { result } = await removed(() => undo.promise);

    act(() => vi.advanceTimersByTime(RECEIPT_MS - 500));
    act(() => result.current.undo());
    expect(result.current.busy).toBe(true);

    // The timer would have run out here; the line is still up, waiting on the undo.
    act(() => vi.advanceTimersByTime(RECEIPT_MS * 2));
    expect(result.current.text).toBe("Removed 2 copies");

    await act(async () => undo.reject("The ticket has expired"));
    expect(result.current.text).toBe("Couldn't undo — The ticket has expired");
    expect(result.current.refused).toBe(true);
    expect(result.current.busy).toBe(false);
    expect(result.current.undoName).toBeNull();

    act(() => vi.advanceTimersByTime(RECEIPT_MS - 1));
    expect(result.current.text).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.text).toBeNull();
  });

  it("puts the line down once the undo lands", async () => {
    const undo = deferred();
    const { result } = await removed(() => undo.promise);
    act(() => result.current.undo());
    await act(async () => undo.resolve());
    expect(result.current.text).toBeNull();
  });
});
