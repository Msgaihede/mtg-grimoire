import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ActivityProvider,
  useRegisterActivity,
  useTopActivity,
} from "@/components/ActivityProvider";
import { RANK, type Activity } from "@/lib/activity";

const wrapper = ({ children }: { children: ReactNode }) => (
  <ActivityProvider>{children}</ActivityProvider>
);

const job = (over: Partial<Activity> = {}): Activity => ({
  key: "sync",
  rank: RANK.sync,
  label: "Syncing card data",
  detail: null,
  value: null,
  ...over,
});

describe("the activity registry, through React", () => {
  it("has nothing to say until something registers", () => {
    const { result } = renderHook(() => useTopActivity(), { wrapper });

    expect(result.current).toBeNull();
  });

  it("reports the registered job, and follows it as it moves", () => {
    const { result, rerender } = renderHook(
      ({ detail }: { detail: string | null }) => {
        useRegisterActivity(job({ label: "Importing cards", detail }));
        return useTopActivity();
      },
      { wrapper, initialProps: { detail: "1,000 cards" } },
    );

    expect(result.current?.detail).toBe("1,000 cards");

    rerender({ detail: "83,000 cards" });

    expect(result.current?.detail).toBe("83,000 cards");
  });

  /**
   * The reason registration is declarative rather than a `begin()`/`end()` pair: an early
   * return, a thrown render, an unmount mid-job, and an imperative registry would claim
   * forever that something was running.
   */
  it("drops the job when the component describing it goes away", () => {
    const { result, rerender } = renderHook(
      ({ running }: { running: boolean }) => {
        useRegisterActivity(running ? job() : null);
        return useTopActivity();
      },
      { wrapper, initialProps: { running: true } },
    );

    expect(result.current).not.toBeNull();

    rerender({ running: false });

    expect(result.current).toBeNull();
  });

  it("ranks two live jobs and hands back the loud one", () => {
    const { result } = renderHook(
      () => {
        useRegisterActivity(
          job({
            key: "update-download",
            rank: RANK.update,
            label: "Downloading update 0.3.0",
          }),
        );
        useRegisterActivity(job({ label: "Importing cards" }));
        return useTopActivity();
      },
      { wrapper },
    );

    expect(result.current?.label).toBe("Importing cards");
  });

  /** Consumers outside a provider are a wiring mistake, and a silent `null` would look
   *  exactly like "nothing is running". */
  it("refuses to answer outside a provider", () => {
    expect(() => renderHook(() => useTopActivity())).toThrow(/ActivityProvider/);
  });
});
