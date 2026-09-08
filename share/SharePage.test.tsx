/**
 * The public viewer, over the same golden snapshot the Rust writer produces.
 *
 * **Nothing here mocks a backend, because there is nothing to mock.** The page takes a parsed
 * `ShareSnapshot` and draws it; every filter, every folder walk and every sort happens over that
 * one object.
 *
 * The other half of that design — *and no second request* — is asserted in `boot.test.tsx` and
 * deliberately not here. `fetch` is reached only from `boot`, which this file never imports, so a
 * spy on it could not fire whatever `SharePage` did.
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
import {
  ShareBoundary,
  SharePage,
  snapshotHref,
  SNAPSHOT_UNDRAWABLE,
} from "./SharePage";
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

  it("narrows the wall from the search box", async () => {
    const user = userEvent.setup();
    mount(snapshot());

    await user.type(screen.getByLabelText("Search this collection"), "tundra");
    expect(tiles()).toHaveLength(1);
    expect(within(wall()).getByAltText("Tundra")).toBeInTheDocument();
    // **The "without refetching" half is asserted in `boot.test.tsx` and deliberately not here.**
    // `fetch` is only ever called from `boot`, which this file never imports, so a spy on it
    // could not fire whatever `SharePage` did — an assertion no mutation can redden reads as
    // coverage and is worse than none.
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

  /**
   * **Nothing about a card identifies it, so nothing built out of a card can be a React key.**
   *
   * The golden's two rows differ in every column, so no case above can see this: the first key
   * this page shipped was `{id}:{finish}:{folder}:{condition}` and it looked unique. Two rows of
   * one binder can agree on all four and differ in a column this page does not draw.
   *
   * ⚠️ **The length assertion below cannot be the pin.** React renders duplicate-keyed siblings
   * on first mount and only drops one on reconciliation, so a wall of two is what a broken key
   * draws too. `console.error` is the only witness at mount, which is why the spy is the test and
   * the count is the sanity check beside it.
   */
  it("keys two identical rows apart", () => {
    const complained = vi.spyOn(console, "error").mockImplementation(() => {});
    mount(
      edited((s) => {
        s.cards = [structuredClone(s.cards[0]), structuredClone(s.cards[0])];
      }),
    );
    const said = complained.mock.calls.map((call) => call.join(" ")).join("\n");
    complained.mockRestore();

    expect(said).not.toMatch(/same key/i);
    expect(tiles()).toHaveLength(2);
  });

  /**
   * **`parseSnapshot` promises `v`, `folders` and `cards` and nothing else** — its own header
   * says a per-field validator there would be a fourth implementation of the format. So a body
   * from a build that spells `currency` differently, or omits it, still has to draw: the throw
   * this used to produce happened *during render*, where `boot`'s `try` cannot reach it, and a
   * throw out of `root.render` is a blank page rather than a notice.
   */
  it("draws the wall when the optional top-level fields are missing", () => {
    const bare = parseSnapshot(golden) as unknown as Record<string, unknown>;
    for (const key of ["currency", "fields", "owner", "title", "updatedAt", "marketplace"])
      delete bare[key];

    expect(() => mount(bare as unknown as ShareSnapshot)).not.toThrow();
    expect(tiles()).toHaveLength(2);
    // The privacy sentence is the one thing that may never fall off the page.
    expect(screen.getByText(/anyone with this link/i)).toBeInTheDocument();
    // No money column was asked for, so none is drawn — and no `NaN` figure either.
    expect(screen.getByText(/prices were not shared/i)).toBeInTheDocument();
    expect(screen.queryByText(/NaN|Invalid Date|undefined/)).not.toBeInTheDocument();
  });
});

describe("ShareBoundary", () => {
  /** The floor under everything `asText` and its neighbours do not know to guard. */
  function Explodes(): never {
    throw new Error("a field this build had never heard of");
  }

  it("draws a sentence where a render throw would otherwise draw nothing", () => {
    const complained = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <TooltipProvider>
        <ShareBoundary>
          <Explodes />
        </ShareBoundary>
      </TooltipProvider>,
    );
    complained.mockRestore();
    expect(screen.getByText(SNAPSHOT_UNDRAWABLE)).toBeInTheDocument();
  });

  it("is out of the way when nothing throws", () => {
    render(
      <TooltipProvider>
        <ShareBoundary>
          <p>the binder</p>
        </ShareBoundary>
      </TooltipProvider>,
    );
    expect(screen.getByText("the binder")).toBeInTheDocument();
    expect(screen.queryByText(SNAPSHOT_UNDRAWABLE)).not.toBeInTheDocument();
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
 * A `grep` over `share/*.tsx` would only catch the first hop. This walks the graph, and it has to
 * walk **all** of it — the fence exists to survive edits nobody has made yet, so the two ways a
 * walk can be narrow are both closed:
 *
 * * **relative specifiers are followed as well as `@/…` ones.** Following only the alias visited
 *   31 modules where the real graph is 34: `TooltipProvider` reaches `TooltipPanel`,
 *   `tooltipStore` and `lib/motion` through a plain `./TooltipPanel`, so the three files most
 *   likely to grow a store import were the three this could not see.
 * * **a side-effect and a dynamic import count as imports.** `import "@/lib/core";` and
 *   `await import("@/features/…")` have no `from`, and a matcher that requires one does not
 *   merely miss them — its lazy `[\s\S]*?` runs past and captures the *next* specifier instead.
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

  /**
   * Every specifier a module names — `from "x"`, a bare `import "x"`, and `import("x")`.
   *
   * Comments are stripped first, because this file and its neighbours quote module paths in
   * prose and a doc comment must not be able to fail a build. The `[^:]` guard on the line-comment
   * arm is what keeps `https://…` out of it.
   */
  function specifiersOf(source: string): string[] {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
    return [...code.matchAll(pattern)].map(([, spec]) => spec);
  }

  /** `a/b/../c` → `a/c`, keeping the leading `..` that reaches out of `share/`. */
  function normalise(path: string): string {
    const out: string[] = [];
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  }

  /** Both globs under one canonical spelling, so `./SharePage.tsx` and `../src/…` compare. */
  const files: Record<string, string> = {};
  for (const [key, source] of Object.entries({ ...sources, ...own }))
    if (!key.endsWith(".test.tsx") && !key.endsWith(".stories.tsx")) files[normalise(key)] = source;

  /** A specifier as a key of {@link files}, or `null` for a package this walk does not follow. */
  function resolve(from: string, spec: string): string | null {
    let stem: string;
    if (spec.startsWith("@/")) stem = normalise(`../src/${spec.slice(2)}`);
    else if (spec.startsWith("."))
      stem = normalise(`${from.split("/").slice(0, -1).join("/")}/${spec}`);
    else return null;
    for (const candidate of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`])
      if (candidate in files) return candidate;
    return null;
  }

  const FORBIDDEN = ["@/lib/core", "@/lib/ipc", "@/workers", "@/features", "@tauri-apps/"];

  it("finds a side-effect and a dynamic import, not only a `from`", () => {
    const specs = specifiersOf(`
      import { a } from "@/lib/a";
      import "@/lib/side-effect";
      export * from "./b";
      const lazy = await import("@/features/late");
      // a comment naming "@/lib/ipc" must not count
      /* nor a block one naming "@/workers/x" */
    `);
    expect(specs).toEqual(["@/lib/a", "@/lib/side-effect", "./b", "@/features/late"]);
  });

  it("reaches no core, no ipc, no worker and no feature", () => {
    const seen = new Set<string>();
    const queue = Object.keys(own)
      .filter((key) => !key.endsWith(".test.tsx"))
      .map(normalise);
    const found: string[] = [];

    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = files[file];
      if (source === undefined) continue;
      for (const spec of specifiersOf(source)) {
        if (FORBIDDEN.some((bad) => spec.startsWith(bad))) found.push(`${file} → ${spec}`);
        const target = resolve(file, spec);
        if (target !== null) queue.push(target);
      }
    }

    expect(found).toEqual([]);
    // The walk is worthless if it never left `share/`, and worth less than it looks if it stops
    // at the alias. These three are reached **only** through a relative specifier — the hop this
    // sweep could not see until 2026-09-08 — so they are what proves the fix rather than the
    // count beside them.
    expect([...seen]).toEqual(
      expect.arrayContaining([
        "../src/components/tooltip/TooltipPanel.tsx",
        "../src/components/tooltip/tooltipStore.ts",
        "../src/lib/motion.ts",
      ]),
    );
    expect(seen.size).toBeGreaterThan(25);
  });
});
