import { describe, expect, it } from "vitest";
import type { ExchangeRate } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { conversionFactor, isMixed, pricingPlan } from "./currency";

const RATE: ExchangeRate = { usdPerEur: 1.25, date: "2026-10-30", fetchedAt: 0 };
const { tcgplayer, cardmarket, cardkingdom } = MARKETPLACES;

describe("conversionFactor", () => {
  it("is 1 within a currency, the rate from euros and its inverse from dollars", () => {
    expect(conversionFactor("usd", "usd", 1.25)).toBe(1);
    expect(conversionFactor("eur", "usd", 1.25)).toBe(1.25);
    expect(conversionFactor("usd", "eur", 1.25)).toBe(0.8);
  });
});

describe("isMixed", () => {
  it("is whether the pick names two currencies", () => {
    expect(isMixed([tcgplayer, cardkingdom])).toBe(false);
    expect(isMixed([tcgplayer, cardmarket])).toBe(true);
    expect(isMixed([])).toBe(false);
  });
});

describe("pricingPlan", () => {
  it("prices one currency's pick in that currency, converting nothing", () => {
    const plan = pricingPlan([cardmarket], "usd", { status: "loading" });
    expect(plan).toEqual({
      currency: "eur",
      sources: [{ marketplace: cardmarket, factor: 1 }],
      leftOut: [],
      rate: null,
      waiting: false,
    });
  });

  it("prices a mixed pick in the app's currency, at the rate", () => {
    expect(pricingPlan([tcgplayer, cardmarket], "usd", { status: "ready", rate: RATE })).toEqual({
      currency: "usd",
      sources: [
        { marketplace: tcgplayer, factor: 1 },
        { marketplace: cardmarket, factor: 1.25 },
      ],
      leftOut: [],
      rate: RATE,
      waiting: false,
    });
    const inEuros = pricingPlan([tcgplayer, cardmarket], "eur", { status: "ready", rate: RATE });
    expect(inEuros.currency).toBe("eur");
    expect(inEuros.sources.map((s) => s.factor)).toEqual([0.8, 1]);
  });

  it("waits on the rate, reading only the app's currency meanwhile", () => {
    const plan = pricingPlan([tcgplayer, cardmarket], "usd", { status: "loading" });
    expect(plan.waiting).toBe(true);
    expect(plan.sources).toEqual([{ marketplace: tcgplayer, factor: 1 }]);
    expect(plan.leftOut).toEqual([]);
  });

  it("leaves the other currency out when there is no rate, and never compares it unconverted", () => {
    const plan = pricingPlan([tcgplayer, cardmarket, cardkingdom], "usd", {
      status: "failed",
      reason: "The exchange rate could not be fetched.",
    });
    expect(plan.waiting).toBe(false);
    expect(plan.sources.map((s) => s.marketplace)).toEqual([tcgplayer, cardkingdom]);
    expect(plan.leftOut).toEqual([cardmarket]);
    expect(plan.currency).toBe("usd");
  });
});
