import { render, screen, waitFor } from "@testing-library/react";
import mainSource from "@/main.tsx?raw";
import appSource from "@/App.tsx?raw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PwaShell } from "@/pwa/PwaShell";

vi.mock("@/pwa/target", () => ({ isWebTarget: () => true }));

function fakeContainer() {
  const registration = {
    waiting: null,
    installing: null,
    update: vi.fn(() => Promise.resolve()),
    addEventListener: vi.fn(),
  };
  return {
    controller: null,
    register: vi.fn(() => Promise.resolve(registration)),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

afterEach(() => Reflect.deleteProperty(navigator, "serviceWorker"));

describe("the shell around the root", () => {
  it("draws whatever it was given, and no bar while nothing is waiting", async () => {
    const container = fakeContainer();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
    render(
      <PwaShell>
        <p>the root</p>
      </PwaShell>,
    );
    expect(screen.getByText("the root")).toBeInTheDocument();
    await waitFor(() => expect(container.register).toHaveBeenCalledWith("/sw.js"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

/**
 * **Nothing in this suite and nothing in Storybook loads `main.tsx`**, which is the repo's own
 * observation about providers put there — so the mount is pinned as source text, the way
 * `tokens.test.ts` pins `<TooltipProvider>`.
 *
 * The thing being guarded is not stylistic. On the web target `<App />` is mounted only once a
 * corpus exists (`WebBoot` draws `BuildCorpus` for a count of zero), so a registration inside
 * `App` does not happen until the reader has downloaded 75 MB. Measured in headless Edge on
 * 2026-08-28 against a production build: a first visit reported **zero** registrations with the
 * page showing "Build the card database", and `navigator.serviceWorker.ready` never resolved.
 */
describe("where it is mounted", () => {
  it("wraps both roots in main.tsx", () => {
    expect(mainSource).toContain("<PwaShell>");
    expect(mainSource.indexOf("<PwaShell>")).toBeLessThan(mainSource.indexOf("<WebBoot />"));
    expect(mainSource.indexOf("<PwaShell>")).toBeLessThan(mainSource.indexOf("<App />"));
  });

  /** One mount: two registrations would be two objects racing to describe one waiting worker. */
  it("is not also mounted inside App", () => {
    expect(appSource).not.toContain("useServiceWorker");
    expect(appSource).not.toContain("<UpdateReadyBar");
  });
});
