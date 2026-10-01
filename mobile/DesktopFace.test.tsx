import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Edition, LIGHT_EDITION } from "@/lib/edition";
import { useAppStore, type ViewId } from "@/lib/store";

/**
 * What the app saw, render by render. A `vi.fn` rather than an array the probe pushes to: the
 * call is the record, and `mock.calls[0]` is the **first** render — which is the only one that
 * can tell "seeded before anything is drawn" from "corrected a frame later".
 */
const sawOnRender = vi.hoisted(() => vi.fn<(view: ViewId, edition: Edition) => void>());

// `DesktopFace` imports the app as `@/App`'s default export, so that is the shape stood in for.
// The real one mounts the whole product; what this suite is about is what it is *handed*: where
// the store stands by the time it renders, and which edition it is told to draw.
vi.mock("@/App", async () => {
  const { useEdition } = await import("@/lib/edition");
  const { useAppStore } = await import("@/lib/store");
  return {
    default: function AppProbe() {
      sawOnRender(useAppStore.getState().activeView, useEdition());
      return <div>the app</div>;
    },
  };
});

import DesktopFace from "./DesktopFace";

const PRISTINE = useAppStore.getState();

const reset = () => {
  useAppStore.setState(PRISTINE, true);
  window.history.replaceState(null, "", "/");
};

beforeEach(() => {
  reset();
  sawOnRender.mockReset();
});

// After as well as before: the face writes to a store and a URL that outlive it.
afterEach(reset);

describe("DesktopFace", () => {
  it("has the store on the URL's view by the app's first render", () => {
    window.history.replaceState(null, "", "/decks");
    // The premise: left alone, the store opens on a view the light edition does not draw.
    expect(useAppStore.getState().activeView).toBe("home");

    render(<DesktopFace />);

    expect(screen.getByText("the app")).toBeInTheDocument();
    expect(sawOnRender.mock.calls[0]?.[0]).toBe("decks");
    // And never since, either.
    expect(sawOnRender.mock.calls.map(([view]) => view)).not.toContain("home");
  });

  it("hands the app the light edition", () => {
    render(<DesktopFace />);

    // Identity, not a look-alike: the shell compares nothing, it reads what it is given.
    expect(sawOnRender.mock.calls[0]?.[1]).toBe(LIGHT_EDITION);
  });
});
