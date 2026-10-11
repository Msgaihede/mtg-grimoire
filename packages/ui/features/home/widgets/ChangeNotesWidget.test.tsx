import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeWidget, ReleaseNote } from "@/lib/ipc";
import type { ReleaseHistory } from "@/lib/useReleaseHistory";

/**
 * The one read, in front of an intact module: the bundled history is a lazy `import()` of every
 * file in `changelog/`, so the cases hand the body a history of their own rather than reading the
 * repository's notes, which change with every release.
 */
const useBundledHistory = vi.hoisted(() => vi.fn<() => ReleaseHistory>());
vi.mock("@/lib/useReleaseHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/useReleaseHistory")>();
  return { ...actual, useBundledHistory };
});

import { useAppStore } from "@/lib/store";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import {
  ChangeNotesWidget,
  EMPTY,
  highlightsOf,
  PENDING,
  shownReleases,
} from "./ChangeNotesWidget";

/** A generated body: highlights, then the full lists. Constructed — no real release. */
const GENERATED = [
  "### Highlights",
  "",
  "- **Decks have covers.** Pick any card as a deck's picture.",
  "",
  "### New",
  "",
  "- **Decks:** set a deck's cover from a card's menu (#895)",
  "",
  "### Fixed",
  "",
  "- **Search:** a blank query no longer clears the filters (#880)",
].join("\n");

/** A release-please body, which has no highlights section. */
const OLDER = ["### Features", "", "* **search:** fuzzy names"].join("\n");

function release(version: string, notes: string, publishedAt: string | null = null): ReleaseNote {
  return {
    version,
    tag: `v${version}`,
    notes,
    publishedAt,
    htmlUrl: `https://example.test/v${version}`,
  };
}

const RELEASES: ReleaseNote[] = [
  release("0.45.0", GENERATED, "2026-10-10"),
  release("0.44.0", OLDER, "2026-10-04"),
  release("0.43.1", OLDER),
  release("0.43.0", OLDER),
];

function history(over: Partial<ReleaseHistory> = {}): ReleaseHistory {
  return { releases: RELEASES, loading: false, error: null, ...over };
}

function widget(config: unknown = null, w = 3, h = 3): HomeWidget {
  return { id: "changeNotes", kind: "changeNotes", x: 0, y: 0, w, h, config };
}

function fitFor(w: number, h: number): WidgetFit {
  return makeFit({
    w,
    h,
    widthPx: spanPx(w, 104),
    heightPx: spanPx(h, 104),
    density: "comfortable",
  });
}

function draw(
  config: unknown = null,
  { w = 3, h = 3, still = false }: { w?: number; h?: number; still?: boolean } = {},
) {
  return render(
    <ChangeNotesWidget
      widget={widget(config, w, h)}
      fit={fitFor(w, h)}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
  );
}

beforeEach(() => {
  useBundledHistory.mockReset().mockReturnValue(history());
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

describe("highlightsOf", () => {
  it("cuts a generated body to its highlights, without the heading", () => {
    expect(highlightsOf(GENERATED)).toBe(
      "- **Decks have covers.** Pick any card as a deck's picture.",
    );
  });

  it("answers the whole body where there is no highlights section", () => {
    expect(highlightsOf(OLDER)).toBe(OLDER);
  });

  it("answers the whole body where the section is empty", () => {
    const empty = "### Highlights\n\n### New\n\n- a thing";
    expect(highlightsOf(empty)).toBe(empty);
  });

  it("runs to the end of the body when highlights is the last section", () => {
    expect(highlightsOf("### New\n- one\n### Highlights\n- two\n- three")).toBe("- two\n- three");
  });
});

describe("shownReleases", () => {
  it("keeps the newest count, at least one", () => {
    expect(shownReleases(RELEASES, { count: 1, highlights: false }).map((r) => r.version)).toEqual([
      "0.45.0",
    ]);
    expect(shownReleases(RELEASES, { count: 3, highlights: false })).toHaveLength(3);
    expect(shownReleases(RELEASES, { count: 0, highlights: false })).toHaveLength(1);
  });

  it("cuts each body to its highlights only when asked", () => {
    expect(shownReleases(RELEASES, { count: 1, highlights: false })[0].notes).toBe(GENERATED);
    expect(shownReleases(RELEASES, { count: 2, highlights: true }).map((r) => r.notes)).toEqual([
      "- **Decks have covers.** Pick any card as a deck's picture.",
      OLDER,
    ]);
  });
});

describe("ChangeNotesWidget", () => {
  it("draws the latest release alone by default, with its day and its notes", () => {
    draw();
    const sections = screen.getAllByRole("region");
    expect(sections).toHaveLength(1);
    const latest = within(sections[0]);
    expect(latest.getByText("0.45.0")).toBeInTheDocument();
    expect(latest.getByText("2026-10-10")).toBeInTheDocument();
    expect(latest.getByText("Fixed")).toBeInTheDocument();
  });

  it("draws as many releases as the pick asks for, newest first", () => {
    draw({ releases: 3 });
    expect(
      screen.getAllByRole("region").map((section) => section.getAttribute("aria-label")),
    ).toEqual(["Release 0.45.0", "Release 0.44.0", "Release 0.43.1"]);
  });

  it("reads a pick no option carries as the latest alone", () => {
    draw({ releases: 4 });
    expect(screen.getAllByRole("region")).toHaveLength(1);
  });

  it("draws the highlights alone when the switch is on", () => {
    draw({ highlights: true });
    expect(screen.getByText("Decks have covers.")).toBeInTheDocument();
    expect(screen.queryByText("Fixed")).toBeNull();
    expect(screen.queryByText("Highlights")).toBeNull();
  });

  it("drops the day on a two-cell tile", () => {
    draw(null, { w: 2 });
    expect(screen.getByText("0.45.0")).toBeInTheDocument();
    expect(screen.queryByText("2026-10-10")).toBeNull();
  });

  it("opens Settings on the Updates panel from All versions", async () => {
    const user = userEvent.setup();
    draw();
    await user.click(screen.getByRole("button", { name: "All versions" }));
    expect(useAppStore.getState().activeView).toBe("settings");
    expect(useAppStore.getState().pendingSettingsPanel).toBe("updates");
  });

  it("draws no press on a still preview", () => {
    draw(null, { still: true });
    expect(screen.getByText("0.45.0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All versions" })).toBeNull();
  });

  it("says when it is loading, when it has nothing, and when the history will not load", () => {
    useBundledHistory.mockReturnValue(history({ releases: [], loading: true }));
    const { unmount } = draw();
    expect(screen.getByText(PENDING)).toBeInTheDocument();
    unmount();

    useBundledHistory.mockReturnValue(history({ releases: [] }));
    const second = draw();
    expect(screen.getByText(EMPTY)).toBeInTheDocument();
    second.unmount();

    useBundledHistory.mockReturnValue(history({ releases: [], error: "Reload the app." }));
    draw();
    expect(screen.getByText("Reload the app.")).toHaveClass("text-destructive");
  });
});
