import { describe, expect, it } from "vitest";
import { batchWrite, handled, newestWrite, NO_BATCH } from "./writes";

const ok = (value: unknown = null): PromiseSettledResult<unknown> => ({
  status: "fulfilled",
  value,
});
const no = (reason: unknown): PromiseSettledResult<unknown> => ({ status: "rejected", reason });

describe("batchWrite", () => {
  it("is a success stamped when the batch was fired, when every card went through", () => {
    expect(batchWrite([ok(), ok()], 10, 20)).toEqual({
      submittedAt: 10,
      isError: false,
      error: null,
      isSuccess: true,
    });
  });

  /** The case issue #553 is about: the last card went through and an earlier one did not. */
  it("counts a refusal in the middle of a batch that ended well", () => {
    const write = batchWrite([ok(), no("The database is busy."), ok(), ok()], 10, 20);
    expect(write.isError).toBe(true);
    expect(write.error).toBe("1 of 4 cards was not changed — The database is busy.");
  });

  /** Stamped when it settled, so it outranks its own members — whose `submittedAt` TanStack
   *  writes only after `onMutate` has been awaited, later than the batch was fired. */
  it("stamps a refused batch when it settled", () => {
    expect(batchWrite([no("x"), ok()], 10, 20).submittedAt).toBe(20);
  });

  it("says one sentence once however many cards it refused", () => {
    expect(batchWrite([no("Gone."), no("Gone."), ok()], 1, 2).error).toBe(
      "2 of 3 cards were not changed — Gone.",
    );
    expect(batchWrite([no("Gone."), no("Busy.")], 1, 2).error).toBe("Gone. Busy.");
  });

  it("is outranked by any write that has ever run until a batch has", () => {
    const real = { submittedAt: 1, isError: false, error: null, isSuccess: true };
    expect(newestWrite([real, NO_BATCH])).toBe(real);
  });
});

describe("handled", () => {
  it("hands back the same promise, still rejecting, with nothing left unhandled", async () => {
    const press = Promise.reject(new Error("refused"));
    const same = handled(press);
    expect(same).toBe(press);
    await expect(same).rejects.toThrow("refused");
  });
});
