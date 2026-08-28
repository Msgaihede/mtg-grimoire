import { describe, expect, it } from "vitest";
import { meteredLink } from "@/pwa/connection";

describe("reading the link", () => {
  it("takes Data Saver at its word", () => {
    expect(meteredLink({ saveData: true })).toMatchObject({ metered: true });
    expect(meteredLink({ saveData: true }).why).toMatch(/Data Saver/);
  });

  it("treats a cellular link as metered", () => {
    expect(meteredLink({ type: "cellular" })).toMatchObject({ metered: true });
  });

  it("treats a 2G link as metered even when it does not say cellular", () => {
    expect(meteredLink({ effectiveType: "2g" })).toMatchObject({ metered: true });
    expect(meteredLink({ effectiveType: "slow-2g" })).toMatchObject({ metered: true });
  });

  it("says nothing about wifi, and nothing at all when the API is absent", () => {
    expect(meteredLink({ type: "wifi", effectiveType: "4g" })).toEqual({
      metered: false,
      why: null,
    });
    // Safari and Firefox expose no `navigator.connection`. Absent is not metered — guessing
    // "yes" would default every download to Not now on two whole browsers.
    expect(meteredLink(undefined)).toEqual({ metered: false, why: null });
  });
});
