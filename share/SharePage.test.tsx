/**
 * The public viewer, over the same golden snapshot the Rust writer produces.
 *
 * **Nothing here mocks a backend, because there is nothing to mock.** The page takes a parsed
 * `ShareSnapshot` and draws it; every filter, every folder walk and every sort happens over that
 * one object. That is the whole design (spec §7) and it is what the "filters in the browser"
 * case below is really asserting: a `fetch` spy that never fires.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

/**
 * **The one mock in this file, and it makes the suite agree with the bundle rather than with the
 * repo's default.**
 *
 * `vite.share.config.ts` defines `__CORE__` as `"web"`; `vite.config.ts` — which vitest inherits
 * — defines it as `"tauri"`. `cardArtSrc` branches on exactly that, so under the suite's default
 * a tile with `cardId={null}` draws the no-picture fallback and **no `<img>` at all**, which is
 * not what a reader of this page ever sees. Mocked, the wall draws the `cards.scryfall.io` URL
 * the snapshot carries, which is the whole of how this page gets its pictures.
 */
vi.mock("@/pwa/target", () => ({ isWebTarget: () => true }));
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { parseSnapshot, type ShareSnapshot } from "@/lib/shareSnapshot";
import golden from "../src-tauri/src/share/__golden__/snapshot.json?raw";
import { SharePage, snapshotHref } from "./SharePage";
import { NOTHING } from "./ShareTile";

const snapshot = () => parseSnapshot(golden);

/** The golden with one field changed — the absences the format's header calls ordinary. */
function edited(edit: (s: ShareSnapshot) => void): ShareSnapshot {
  const s = parseSnapshot(golden);
  edit(s);
  return s;
}

function mount(s: ShareSnapshot) {
  return render(
    <TooltipProvider>
      <SharePage snapshot={s} />
    </TooltipProvider>,
  );
}

const wall = () => screen.getByRole("list", { name: "Cards" });
const tiles = () => within(wall()).getAllByRole("listitem");
const folders = () => screen.getByRole("list", { name: "Folders" });

describe("SharePage", () => {
  it("names the owner and says the view is read-only", () => {
    mount(snapshot());
    expect(screen.getByText(/Giradeli/)).toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    // "anyone with this link" in words — spec §5.1 requires the privacy claim be worded this
    // way and never "private" or "encrypted", because the relay stores these snapshots in the
    // clear and the app must not tell a reader otherwise.
    expect(screen.getByText(/anyone with this link/i)).toBeInTheDocument();
  });

  it("dates the snapshot rather than implying it is live", () => {
    mount(snapshot());
    // The golden's `updatedAt` is 1757308800 — 8 September 2025. The stamp is **seconds**, and a
    // viewer that read it as milliseconds would date every share ever published to 1970.
    expect(screen.getByText(/as of .*2025/)).toBeInTheDocument();
  });

  it("draws a tile per card and files it under its folder", async () => {
    const user = userEvent.setup();
    mount(snapshot());
    expect(tiles()).toHaveLength(2);

    // The rail's counts are recursive: the root drawer holds one card of its own and one in
    // the drawer below it.
    const rail = within(folders());
    await user.click(rail.getByRole("button", { name: /Duals/ }));
    expect(tiles()).toHaveLength(1);
    expect(within(wall()).getByAltText("Tundra")).toBeInTheDocument();

    await user.click(rail.getByRole("button", { name: /Trade binder/ }));
    expect(tiles()).toHaveLength(2);
  });

  it("filters in the browser without refetching", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const user = userEvent.setup();
    mount(snapshot());

    await user.type(screen.getByLabelText("Search this collection"), "tundra");
    expect(tiles()).toHaveLength(1);
    expect(within(wall()).getByAltText("Tundra")).toBeInTheDocument();
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });

  it("says when a snapshot carries no prices rather than showing zeroes", () => {
    // `fields` is on the wire precisely so "every card was NM" and "no condition was shared"
    // are different answers. A viewer that showed a blank column would collapse them.
    mount(
      edited((s) => {
        s.fields = s.fields.filter((f) => f !== "value");
        for (const c of s.cards) delete c.p;
      }),
    );
    expect(screen.getByText(/prices were not shared/i)).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    // No money anywhere: not a zeroed figure in the header, and no money slot on any chin.
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
    expect(within(tiles()[0]).queryByText(NOTHING)).not.toBeInTheDocument();
  });

  it("draws an em dash for a card the publisher answered nothing for", () => {
    // `fields` advertising a column does not promise every card carries it: an ungraded copy
    // emits no `c` and an unquoted finish emits no `p`, both with `condition` and `value`
    // named. Neither may render as a blank or a zero.
    mount(
      edited((s) => {
        delete s.cards[0].c;
        delete s.cards[0].p;
      }),
    );
    // Both columns, on the one tile: the condition beside the language, and the money in the
    // chin. Neither is a blank and neither is a zero.
    const first = tiles().find((t) => within(t).queryByAltText("Fury Sliver") !== null);
    expect(within(first as HTMLElement).getAllByText(NOTHING)).toHaveLength(2);
    expect(within(first as HTMLElement).queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("offers no condition control when no condition was shared", () => {
    // Unmounted between the two, or the second `getByLabelText` would find the first render's
    // control — cleanup runs between tests, not between renders inside one.
    const first = mount(snapshot());
    expect(screen.getByLabelText("Condition")).toBeInTheDocument();
    first.unmount();

    mount(edited((s) => (s.fields = s.fields.filter((f) => f !== "condition"))));
    expect(screen.queryByLabelText("Condition")).not.toBeInTheDocument();
  });

  it("narrows by finish, and offers only the finishes on the wire", async () => {
    const user = userEvent.setup();
    mount(edited((s) => (s.cards[1].f = "foil")));
    expect(screen.queryByRole("button", { name: "Etched" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Foil" }));
    expect(tiles()).toHaveLength(1);
    expect(within(wall()).getByAltText("Tundra")).toBeInTheDocument();
  });

  it("says so when the filters leave nothing, and offers the way back", async () => {
    const user = userEvent.setup();
    mount(snapshot());
    await user.type(screen.getByLabelText("Search this collection"), "brainstorm");
    expect(screen.queryByRole("list", { name: "Cards" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset all" }));
    expect(tiles()).toHaveLength(2);
  });
});

describe("snapshotHref", () => {
  /**
   * The Worker inlines the blob's immutable URL in the shell (`share-worker/src/page.ts`), and
   * its **absence** is the "metadata posted, blob never uploaded" state. Neither half may be
   * guessed: there is no `/s/{id}/index.json` route to fall back to.
   */
  const doc = (body: string) => new DOMParser().parseFromString(body, "text/html");

  it("reads the URL the shell inlined", () => {
    const href = snapshotHref(
      doc('<link id="snapshot" rel="preload" as="fetch" href="/s/abc/deadbeef.json.gz">'),
    );
    expect(href).toMatch(/\/s\/abc\/deadbeef\.json\.gz$/);
  });

  it("answers null when the shell inlined none", () => {
    expect(snapshotHref(doc("<div id=root></div>"))).toBeNull();
  });

  it("answers null for an element that is not a link", () => {
    expect(snapshotHref(doc('<div id="snapshot"></div>'))).toBeNull();
  });
});

/**
 * **The bundle has no core, and this is the fence.**
 *
 * `share/` is loaded by a stranger's browser from a Discord link. The web target's own core
 * would meet that reader with a 2.6 MB wasm module, a 75 MB corpus ingest and an OPFS pool that
 * refuses a second tab — so the viewer imports none of it, and an `ipc` import would drag a
 * Tauri boundary into a bundle that has none.
 *
 * A `grep` over `share/*.tsx` would only catch the first hop. This walks the graph: every
 * `@/…` specifier is resolved against the real `src/` tree and followed, so a component that is
 * clean today and grows a store import next month fails **here** rather than in a browser.
 */
describe("the viewer's import graph", () => {
  const sources = import.meta.glob("../src/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const own = import.meta.glob("./*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  /** `@/lib/foo` → `../src/lib/foo.ts`, trying the four spellings a bundler would. */
  function resolve(spec: string): string | null {
    const stem = `../src/${spec.slice(2)}`;
    for (const candidate of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`])
      if (candidate in sources) return candidate;
    return null;
  }

  const IMPORTS = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g;
  const FORBIDDEN = ["@/lib/core", "@/lib/ipc", "@/workers", "@/features", "@tauri-apps/"];

  it("reaches no core, no ipc, no worker and no feature", () => {
    const seen = new Set<string>();
    const queue = Object.keys(own).filter((k) => !k.endsWith(".test.tsx"));
    const found: string[] = [];

    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = (own[file] ?? sources[file]) as string | undefined;
      if (text === undefined) continue;
      for (const [, spec] of text.matchAll(IMPORTS)) {
        if (FORBIDDEN.some((bad) => spec.startsWith(bad))) found.push(`${file} → ${spec}`);
        if (!spec.startsWith("@/")) continue;
        const target = resolve(spec);
        if (target !== null) queue.push(target);
      }
    }

    expect(found).toEqual([]);
    // The walk is worthless if it never left `share/` — `CardArt` and `CardChin` are the whole
    // point of reusing the app's frame, so the graph must be dozens of files deep.
    expect(seen.size).toBeGreaterThan(10);
  });
});
