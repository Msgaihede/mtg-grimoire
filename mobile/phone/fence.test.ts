import { describe, expect, it } from "vitest";

/**
 * **The light app is fenced twice, and this file is both fences.**
 *
 * 1. **The phone face does not reach the desktop's store, its shell or Tauri's window.** Round
 *    one of this app's phone layout was the desktop's own components bent to fit 360px, and it
 *    was removed. The phone face is a face of its own: it may use anything in `src/` that is not
 *    welded to the desktop — the presentational components, `ipc`, the data hooks, the domain
 *    logic — and nothing that is. A component it wants that *is* welded gets changed to take
 *    props, in `src/`, so both faces gain.
 * 2. **Nothing under `mobile/` asks where it is running.** The Android app and the web app are
 *    one program and the phone face is one face; the face is chosen by viewport width and by
 *    nothing else. A resemblance kept by hand is N decisions that happen to agree today, so the
 *    probes are refused in source rather than reviewed for.
 *
 * Both read the tree as text through `?raw` globs, the way `tokens.test.ts` does and for its
 * reason: this project has no `@types/node` on purpose, so a test cannot open a file.
 *
 * `share/SharePage.test.tsx` walks its bundle's graph the same way, and its two lessons are kept:
 * relative specifiers are followed as well as `@/…` ones, and a side-effect or dynamic import
 * counts. Two things are different on purpose. **A type-only import is not an edge** —
 * `lib/edition.ts` and `components/nav.ts` each import `ViewId` from the store as a type, which
 * costs nothing at runtime, and the phone's tab bar reads its words from `nav.ts`. And **the walk
 * is a function over a map of sources**, so the cases below can hand it a tree with a weld in it:
 * a fence that has only ever been run on a clean tree has never been seen to fail.
 */

/** Source text by root-absolute path — `/src/lib/store.ts`, `/mobile/phone/Shell.tsx`. */
type Sources = Record<string, string>;

const SRC: Sources = import.meta.glob<string>("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Everything the light app is written in. The stylesheet and the document are source too: a
 *  platform question asked in a media query is still that question. */
const LIGHT: Sources = import.meta.glob<string>("/mobile/**/*.{ts,tsx,css,html}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * This file. It spells every probe out in order to refuse them, so the sweep steps over it.
 * Vite already leaves a module out of its own glob; the filter below is that said on purpose
 * rather than inherited from a bundler's default.
 */
const SELF = "/mobile/phone/fence.test.ts";

/**
 * A test, a story, or the test harness — which installs a fake world and so reaches the
 * Storybook fake on purpose. **Exempt by name, and the harness by its whole path**: a second
 * `testing.tsx` somewhere else is not excused by this one.
 */
const HARNESS = "/mobile/phone/testing.tsx";
const isExempt = (path: string): boolean =>
  /\.(test|stories)\.tsx?$/.test(path) || path === HARNESS;

/**
 * `import type … from` and `export type … from`: erased by the compiler, so no runtime edge.
 *
 * **Spelled as the import clause it is, not as "anything up to the next `from`".** A loose
 * `[^;]*?` between the keyword and `from` also swallows `export type Face = "a" | "b"` on a line
 * with no semicolon, together with every real import down to the next quoted specifier — and a
 * fence that deletes edges fails open. An inline `import { type A } from "x"` is **not** matched:
 * it is counted as an edge, conservatively — whether a compiler elides it depends on a flag this
 * test should not have to know, and `import type` is how to say "no edge" on purpose.
 *
 * The clause: an optional default binding and comma, then a name, a braced list or a star.
 */
const TYPE_CLAUSE = String.raw`(?:[\w$]+\s*,\s*)?(?:[\w$]+|\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)`;
const TYPE_ONLY = new RegExp(
  String.raw`\b(?:import|export)\s+type\s+${TYPE_CLAUSE}\s*from\s*["'][^"']+["']`,
  "g",
);

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/**
 * Every specifier a module names at runtime — `from "x"`, a bare `import "x"`, `import("x")`.
 *
 * Comments come out first: these files quote module paths in prose, and a doc comment must not
 * be able to fail a build. The `[^:"'`]` guard on the line-comment arm keeps `https://…` in.
 */
function specifiersOf(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
    .replace(TYPE_ONLY, " ");
  return [...code.matchAll(SPECIFIER)].map(([, spec]) => spec);
}

/** `spec` as written in `from`, as a root-absolute path with its `.` and `..` folded away. */
function stemOf(from: string, spec: string): string {
  const raw = spec.startsWith("@/")
    ? `/src/${spec.slice(2)}`
    : `${from.slice(0, from.lastIndexOf("/"))}/${spec}`;
  const out: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** Ours to follow: the alias or a relative path. A bare package name is not. */
const inRepo = (spec: string): boolean => spec.startsWith("@/") || spec.startsWith(".");

/**
 * A stylesheet, a picture, a `?raw` read — a file that is not a module. **A list, not "anything
 * with a dot"**: `./Tile.stories` has a dot too, and is exactly the import the walk should say
 * it could not follow.
 */
const isAsset = (spec: string): boolean =>
  spec.includes("?") || /\.(?:css|json|svg|png|jpe?g|webp|woff2?)$/i.test(spec);

/** A specifier as a key of `files`, or `null` for one this walk cannot follow. */
function resolve(files: Sources, from: string, spec: string): string | null {
  if (!inRepo(spec)) return null;
  const stem = stemOf(from, spec);
  const candidates = [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`];
  return candidates.find((candidate) => candidate in files) ?? null;
}

/** The desktop's own: its store, its shell, and its window verbs. Its boot is a directory. */
const FORBIDDEN_FILES = [
  "/src/lib/store.ts",
  "/src/App.tsx",
  "/src/components/AppShell.tsx",
  "/src/components/TitleBar.tsx",
  "/src/components/Ribbon.tsx",
  "/src/lib/window.ts",
];
const FORBIDDEN_DIR = "/src/boot/";
const isForbidden = (file: string): boolean =>
  FORBIDDEN_FILES.includes(file) || file.startsWith(FORBIDDEN_DIR);

/** Tauri's API is reached through `lib/core` and nowhere else. */
const TAURI_DOOR = "/src/lib/core/tauri.ts";

interface Walk {
  /** Every module the entries reach at runtime, themselves included. */
  reached: Set<string>;
  /** One line per refused edge, **as the whole trail from the entry that started it** — the
   *  last hop alone names a file in `src/` and not the phone file that has to change. */
  refused: string[];
  /** An in-repo specifier this walk could not follow, and so a part of the graph it never saw. */
  blind: string[];
}

/** Follow every runtime import from `entries` through `files`, breadth first. */
function walk(files: Sources, entries: readonly string[]): Walk {
  const cameFrom = new Map<string, string | null>(entries.map((entry) => [entry, null]));
  const queue = [...entries];
  const refused: string[] = [];
  const blind: string[] = [];

  const trailTo = (file: string): string => {
    const steps: string[] = [];
    for (let at: string | null = file; at !== null; at = cameFrom.get(at) ?? null) {
      steps.unshift(at);
    }
    return steps.join(" → ");
  };

  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const spec of specifiersOf(files[file] ?? "")) {
      if (spec.startsWith("@tauri-apps/") && file !== TAURI_DOOR) {
        refused.push(`${trailTo(file)} → ${spec}`);
      }
      const target = resolve(files, file, spec);
      if (target === null) {
        if (inRepo(spec) && !isAsset(spec)) blind.push(`${trailTo(file)} → ${spec}`);
      } else if (isForbidden(target)) {
        refused.push(`${trailTo(file)} → ${target}`);
      } else if (!cameFrom.has(target)) {
        cameFrom.set(target, file);
        queue.push(target);
      }
    }
  }
  return { reached: new Set(cameFrom.keys()), refused, blind };
}

describe("the phone face's import graph", () => {
  /** Both globs as one tree, less what is exempt — which is therefore a dead end to the walk. */
  const files: Sources = {};
  for (const [path, source] of Object.entries({ ...SRC, ...LIGHT }))
    if (/\.tsx?$/.test(path) && !isExempt(path)) files[path] = source;

  /** Every file of the phone face. */
  const entries = Object.keys(files).filter((path) => path.startsWith("/mobile/phone/"));

  it("skips a type-only import and keeps every other kind", () => {
    const specs = specifiersOf(`
      import type { ViewId } from "@/lib/store";
      import type Default from "@/lib/type-default";
      import type * as All from "@/lib/type-star";
      export type { Place } from "../routes";
      import { a, type B } from "@/lib/a";
      import { type OnlyAType } from "@/lib/inline";
      import "@/lib/side-effect";
      export * from "./b";
      const lazy = await import("@/features/late");
      // a comment naming "@/lib/store" must not count
      /* nor a block one naming "@/lib/window" */
    `);
    expect(specs).toEqual([
      "@/lib/a",
      "@/lib/inline",
      "@/lib/side-effect",
      "./b",
      "@/features/late",
    ]);
  });

  it("does not lose a real import to a type alias written above it", () => {
    // No semicolon after the alias, so nothing but the clause's own shape ends the match.
    const specs = specifiersOf(`
      export type Face = "phone" | "desktop"
      import { useAppStore } from "@/lib/store"
    `);
    expect(specs).toEqual(["@/lib/store"]);
  });

  it("names files that exist", () => {
    // A rule about a path nothing has is a rule about nothing: `store.ts` becoming `store/`
    // would leave every assertion below green over a face welded to it.
    for (const file of [...FORBIDDEN_FILES, TAURI_DOOR]) expect(Object.keys(SRC)).toContain(file);
    expect(Object.keys(SRC).some((path) => path.startsWith(FORBIDDEN_DIR))).toBe(true);
    expect(Object.keys(LIGHT)).toContain(HARNESS);
  });

  describe("on a tree with a weld in it", () => {
    const CLEAN: Sources = {
      "/mobile/phone/Shell.tsx": `import { TabBar } from "./TabBar";`,
      "/mobile/phone/TabBar.tsx": `import { NAV } from "@/components/nav";`,
      "/src/components/nav.ts": `import type { ViewId } from "@/lib/store";`,
      "/src/lib/store.ts": `export const useAppStore = 1;`,
      "/src/lib/window.ts": `import { getCurrentWindow } from "@tauri-apps/api/window";`,
      "/src/lib/core/tauri.ts": `import { invoke } from "@tauri-apps/api/core";`,
      "/src/lib/ipc.ts": `import { core } from "./core";`,
      "/src/lib/core/index.ts": `import { tauriCore } from "./tauri";`,
      "/src/boot/useStartup.ts": `export const useStartup = 1;`,
    };
    /** The clean tree with files swapped in, walked from the shell. */
    const from = (extra: Sources): Walk =>
      walk({ ...CLEAN, ...extra }, ["/mobile/phone/Shell.tsx"]);
    /** The same, with the tab bar's source replaced — where every weld below is put. */
    const withTabBar = (source: string): Walk => from({ "/mobile/phone/TabBar.tsx": source });
    /** How every trail below begins. */
    const VIA = "/mobile/phone/Shell.tsx → /mobile/phone/TabBar.tsx";

    it("passes the clean one, and went past the first hop to say so", () => {
      const { reached, refused, blind } = from({});
      expect(refused).toEqual([]);
      expect(blind).toEqual([]);
      // The store is named by `nav.ts` as a type, and is not reached.
      expect([...reached]).toEqual([
        "/mobile/phone/Shell.tsx",
        "/mobile/phone/TabBar.tsx",
        "/src/components/nav.ts",
      ]);
    });

    it("refuses the store, however it is imported", () => {
      const refused = [`${VIA} → /src/lib/store.ts`];
      expect(withTabBar(`import { useAppStore } from "@/lib/store";`).refused).toEqual(refused);
      expect(withTabBar(`import "../../src/lib/store";`).refused).toEqual(refused);
      expect(withTabBar(`const s = await import("@/lib/store");`).refused).toEqual(refused);
    });

    it("refuses a weld two files into `src/`, and prints the way there", () => {
      // The case a grep over `mobile/phone/` cannot see, and the reason the trail is printed
      // whole: the offending edge is between two files in `src/`.
      const { refused } = from({
        "/src/components/nav.ts": `import { helper } from "./helper";`,
        "/src/components/helper.ts": `import { useAppStore } from "@/lib/store";`,
      });
      expect(refused).toEqual([
        `${VIA} → /src/components/nav.ts → /src/components/helper.ts → /src/lib/store.ts`,
      ]);
    });

    it("refuses the desktop's boot and its window verbs", () => {
      expect(withTabBar(`import { useStartup } from "@/boot/useStartup";`).refused).toEqual([
        `${VIA} → /src/boot/useStartup.ts`,
      ]);
      expect(withTabBar(`import { minimize } from "@/lib/window";`).refused).toEqual([
        `${VIA} → /src/lib/window.ts`,
      ]);
    });

    it("refuses Tauri everywhere but behind the core's door", () => {
      const throughTheDoor = withTabBar(`import { ipc } from "@/lib/ipc";`);
      expect(throughTheDoor.refused).toEqual([]);
      expect([...throughTheDoor.reached]).toContain(TAURI_DOOR);

      expect(withTabBar(`import { invoke } from "@tauri-apps/api/core";`).refused).toEqual([
        `${VIA} → @tauri-apps/api/core`,
      ]);
    });

    it("says so when an import leads somewhere it cannot follow", () => {
      // The test harness is exempt and so absent from the tree: a real file importing it is a
      // dead end, and a dead end is a part of the graph nobody checked.
      expect(withTabBar(`import { renderPhone } from "./testing";`).blind).toEqual([
        `${VIA} → ./testing`,
      ]);
      // A stylesheet is not a module, and is not a dead end.
      expect(withTabBar(`import "./tabs.css";`).blind).toEqual([]);
    });
  });

  it("reaches no desktop store, no desktop shell and no Tauri window", () => {
    const { reached, refused, blind } = walk(files, entries);

    // **Do not weaken this to make it pass.** Each line is a trail from a phone file to the thing
    // it may not reach: use the data hook rather than the page, pass the value in as a prop, or
    // change the welded component in `src/` to take props.
    expect(refused).toEqual([]);
    expect(blind).toEqual([]);

    // The walk is worthless if it never left `mobile/phone/`, and worth less than it looks if it
    // stopped at the alias. Each of these is at the far end of something: `routes.ts` is up and
    // out of the directory, the hook is behind a page, `tooltipStore` is reached only through a
    // relative specifier, and `core/tauri.ts` is behind `ipc.ts` and the core's own index.
    expect([...reached]).toEqual(
      expect.arrayContaining([
        "/mobile/routes.ts",
        "/src/components/CardArt.tsx",
        "/src/components/CardTile.tsx",
        "/src/features/search/useCardSearch.ts",
        "/src/components/tooltip/tooltipStore.ts",
        "/src/lib/ipc.ts",
        TAURI_DOOR,
      ]),
    );
    // Floors, not counts — each a little over half of what the skeleton held on 2026-10-01 — so
    // what falls through one is a glob that stopped matching, not a file somebody deleted.
    expect(entries.length).toBeGreaterThan(8);
    expect(reached.size).toBeGreaterThan(50);
  });
});

/**
 * What a file asks when it asks where it is running.
 *
 * Markus's rule, 2026-10-01, as the spec's §3 writes it: *"The Android app and the web app are
 * the same program, and the phone face is one face — not two that resemble each other,"* and
 * the first thing that follows from it — *"Nothing under `mobile/` asks where it is running. No
 * user-agent test, no `isTauri`, no `isAndroid`, no `display-mode` query deciding what a page
 * draws."*
 *
 * **Swept raw, comments included.** Nothing in the tree trips it today, and prose that names a
 * probe is how one gets copied into a component — `tokens.test.ts`'s reason for refusing a
 * retired class in a comment. `import.meta.env.MODE` is not here: it is which *build* this is,
 * decided at compile time, and it is how `main.tsx` leaves the fake out of a production bundle.
 */
const PROBES: readonly (readonly [name: string, pattern: RegExp])[] = [
  ["navigator.userAgent", /\bnavigator\s*\??\.\s*userAgent\b/],
  ["userAgentData", /\buserAgentData\b/],
  ["navigator.platform", /\bnavigator\s*\??\.\s*platform\b/],
  ["isTauri", /\bisTauri\b/],
  ["__TAURI", /__TAURI/],
  ["isAndroid", /\bisAndroid\b/],
  ["isWebTarget", /\bisWebTarget\b/],
  ["display-mode", /\bdisplay-mode\b/],
];

/** Each probe in `source`, as `line N: <probe>`. */
function probesIn(source: string): string[] {
  return source.split("\n").flatMap((line, index) =>
    PROBES.filter(([, pattern]) => pattern.test(line)).map(
      ([name]) => `line ${index + 1}: ${name}`,
    ),
  );
}

describe("where the light app is running", () => {
  it("finds each probe in a line that asks", () => {
    const asked = [
      `if (navigator.userAgent.includes("Android")) return <Rail />;`,
      `const mobile = navigator.userAgentData?.mobile;`,
      `const mac = navigator?.platform === "MacIntel";`,
      `import { isTauri } from "@tauri-apps/api/core";`,
      `const hosted = "__TAURI_INTERNALS__" in window;`,
      `if (isAndroid()) installBackButton();`,
      `return isWebTarget() ? <InstallBanner /> : null;`,
      `@media (display-mode: standalone) { .install { display: none } }`,
    ];
    // One probe a line, in the list's own order — so a row added to the list without a sample
    // here is a row nobody has seen match, and this goes red on its length.
    expect(asked.map(probesIn)).toEqual(PROBES.map(([name]) => [`line 1: ${name}`]));
  });

  it("numbers the line it found one on", () => {
    const source = `const a = 1;\nconst b = 2;\nif (isAndroid()) go();`;
    expect(probesIn(source)).toEqual(["line 3: isAndroid"]);
  });

  it("leaves the build mode and the width question alone", () => {
    // What the light app does ask, and may: which build this is, and how wide the viewport is.
    expect(probesIn(`const FAKE = import.meta.env.MODE === "fake";`)).toEqual([]);
    expect(probesIn("const QUERY = `(min-width: ${DESKTOP_FLOOR_PX}px)`;")).toEqual([]);
    expect(probesIn(`window.matchMedia(QUERY).matches ? "desktop" : "phone"`)).toEqual([]);
    expect(probesIn(`className="pb-[env(safe-area-inset-bottom)]"`)).toEqual([]);
  });

  it("is asked by nothing under `mobile/`", () => {
    const swept = Object.keys(LIGHT).filter((path) => path !== SELF);

    const asked = swept.flatMap((path) =>
      probesIn(LIGHT[path]).map((hit) => `${path}, ${hit}`),
    );
    expect(asked).toEqual([]);

    // A sweep over nothing finds nothing. The same kind of floor as the walk's, tests included —
    // and one file of each kind the sweep reads, so a glob that lost an extension shows.
    expect(swept.length).toBeGreaterThan(20);
    expect(swept).toEqual(
      expect.arrayContaining([
        "/mobile/main.tsx",
        "/mobile/useFace.ts",
        "/mobile/mobile.css",
        "/mobile/index.html",
        "/mobile/phone/Shell.test.tsx",
      ]),
    );
  });
});
