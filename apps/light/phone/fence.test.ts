import { describe, expect, it } from "vitest";

/**
 * **The light app is fenced twice, and this file is both fences.**
 *
 * 1. **The phone face does not reach the desktop's store, its shell or Tauri's window.** Round
 *    one of this app's phone layout was the desktop's own components bent to fit 360px, and it
 *    was removed. The phone face is a face of its own: it may use anything in `packages/ui/` that is not
 *    welded to the desktop — the presentational components, `ipc`, the data hooks, the domain
 *    logic — and nothing that is. A component it wants that *is* welded gets changed to take
 *    props, in `packages/ui/`, so both faces gain.
 * 2. **Nothing under `apps/light/` asks where it is running.** The Android app and the web app are
 *    one program and the phone face is one face; the face is chosen by viewport width and by
 *    nothing else. A resemblance kept by hand is N decisions that happen to agree today, so the
 *    probes are refused in source rather than reviewed for.
 *
 * Both read the tree as text through `?raw` globs, the way `tokens.test.ts` does and for its
 * reason: this project has no `@types/node` on purpose, so a test cannot open a file.
 *
 * `apps/share/SharePage.test.tsx` walks its bundle's graph the same way, and its two lessons are kept:
 * relative specifiers and a package's name are followed as well as `@/…` ones, and a side-effect or dynamic import
 * counts. **Phase 3 closed the blind spots phase 1 left**: a root-absolute specifier is followed,
 * an `import.meta.glob` is an import of every file it matches, an `import()` of anything but a
 * literal is refused, and the comment stripper reads strings and regexes as what they are.
 * Two things are different on purpose. **A type-only import is not an edge** —
 * `lib/edition.ts` and `components/nav.ts` each import `ViewId` from the store as a type, which
 * costs nothing at runtime, and the phone's tab bar reads its words from `nav.ts`. And **the walk
 * is a function over a map of sources**, so the cases below can hand it a tree with a weld in it:
 * a fence that has only ever been run on a clean tree has never been seen to fail.
 */

/** Source text by root-absolute path — `/packages/ui/lib/store.ts`, `/apps/light/phone/Shell.tsx`. */
type Sources = Record<string, string>;

const SRC: Sources = import.meta.glob<string>(["/packages/ui/**/*.{ts,tsx}", "/apps/desktop/src/**/*.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Everything the light app is written in. The stylesheet and the document are source too: a
 *  platform question asked in a media query is still that question.
 *
 *  **Not its build.** This folder is the app's root, so its two configs (`vite.config.ts`,
 *  `vite.sw.ts`) and, after any build, `dist-mobile/` and `dist-web/` — minified CSS and built
 *  HTML — sit under the same `**`. They are the toolchain and its output, not what the app is
 *  written in, and a probe in a bundle would fail a fence over text nobody wrote. */
const LIGHT: Sources = import.meta.glob<string>(
  ["/apps/light/**/*.{ts,tsx,css,html}", "!/apps/light/vite.*.ts", "!/apps/light/dist-*/**"],
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);

/**
 * This file. It spells every probe out in order to refuse them, so the sweep steps over it.
 * Vite already leaves a module out of its own glob; the filter below is that said on purpose
 * rather than inherited from a bundler's default.
 */
const SELF = "/apps/light/phone/fence.test.ts";

/**
 * A test, a story, or the test harness — which installs a fake world and so reaches the
 * Storybook fake on purpose. **Exempt by name, and the harness by its whole path**: a second
 * `testing.tsx` somewhere else is not excused by this one.
 */
const HARNESS = "/apps/light/phone/testing.tsx";
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

/**
 * Keywords after which a `/` opens a regular expression rather than dividing — `return /x/`.
 * Any other word before a `/` is an operand, and the slash divides it.
 */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

/** Punctuation after which a `/` opens a regular expression. Not `<`: that is a JSX closing tag. */
const REGEX_AFTER_PUNCT = new Set([..."(,=:[!&|?{};+-*%~^"]);

/** Whether a `/` written after `code` (the comment-free text so far) opens a regular expression. */
function regexMayStart(code: string): boolean {
  let at = code.length - 1;
  while (at >= 0 && /\s/.test(code[at])) at--;
  if (at < 0) return true;
  const last = code[at];
  if (REGEX_AFTER_PUNCT.has(last)) return true;
  // `=>`, and only that: a bare `>` is the end of a JSX tag, whose text a slash may begin.
  if (last === ">") return code[at - 1] === "=";
  if (!/[\w$]/.test(last)) return false;
  let start = at;
  while (start > 0 && /[\w$]/.test(code[start - 1])) start--;
  return REGEX_AFTER_WORD.has(code.slice(start, at + 1));
}

/**
 * Where the quoted string opening at `from` ends — past its closing quote, or at the end of its
 * line. **A quote never runs past a newline**, because neither `'…'` nor `"…"` can: an apostrophe
 * in JSX text (`Don't`) opens one here, and bounded to its line it costs that line and nothing else.
 */
function endOfQuoted(source: string, from: number): number {
  const quote = source[from];
  let at = from + 1;
  while (at < source.length) {
    const c = source[at];
    if (c === "\\") at += 2;
    else if (c === quote) return at + 1;
    else if (c === "\n") return at;
    else at++;
  }
  return at;
}

/**
 * Where the regular expression opening at `from` ends — past its flags — or `from + 1` when what
 * follows is not one (a line ends first), so the slash is taken as a character and nothing more.
 * A `/` inside a character class does not close it: `/[/]/`.
 */
function endOfRegex(source: string, from: number): number {
  let inClass = false;
  for (let at = from + 1; at < source.length; at++) {
    const c = source[at];
    if (c === "\n") return from + 1;
    if (c === "\\") at++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      let end = at + 1;
      while (end < source.length && /[a-z]/i.test(source[end])) end++;
      return end;
    }
  }
  return from + 1;
}

/**
 * `source` with its comments taken out and **everything else left exactly as it was** — strings,
 * template literals and regular expressions included, since a specifier is a string.
 *
 * **String-aware, and that is the whole reason it is not two regular expressions.** The first
 * version was a pattern for a block comment and one for a line comment, and a comment opener
 * inside a string or a regex — a glob such as `"packages/ui/**"` followed by a slash, or a regex that
 * matches a run of slashes — opened a "comment" that ran to the next closer anywhere below,
 * swallowing every import between them. A fence that deletes edges fails open. So this walks the
 * text once, and a comment can open only where code is being read: not inside `"…"`, `'…'`, a
 * template literal's text, or a regular expression. (The two openers and the closer are not
 * spelled in this comment, which they would end.)
 *
 * **Its mistakes are bounded and conservative.** Whether a `/` opens a regex is a guess from the
 * token before it, and an apostrophe in JSX text opens a "string". Neither runs past its line, and
 * either can only leave a comment *in* — an edge counted that a reader meant as prose — never take
 * an import out.
 */
function stripComments(source: string): string {
  let out = "";
  let at = 0;
  /** The brace depth each open `${` was entered at — where its template literal resumes. */
  const templates: number[] = [];
  let depth = 0;

  /** Template text from `at` to its closing backtick or its next `${`. */
  const templateText = (): void => {
    while (at < source.length) {
      const c = source[at];
      if (c === "\\") {
        out += source.slice(at, at + 2);
        at += 2;
      } else if (c === "`") {
        out += c;
        at++;
        return;
      } else if (c === "$" && source[at + 1] === "{") {
        out += "${";
        at += 2;
        templates.push(depth);
        depth++;
        return;
      } else {
        out += c;
        at++;
      }
    }
  };

  while (at < source.length) {
    const c = source[at];
    const next = source[at + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", at);
      at = end === -1 ? source.length : end;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", at + 2);
      out += " ";
      at = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'") {
      const end = endOfQuoted(source, at);
      out += source.slice(at, end);
      at = end;
    } else if (c === "`") {
      out += c;
      at++;
      templateText();
    } else if (c === "/" && regexMayStart(out)) {
      const end = endOfRegex(source, at);
      out += source.slice(at, end);
      at = end;
    } else if (c === "{") {
      out += c;
      at++;
      depth++;
    } else if (c === "}") {
      out += c;
      at++;
      depth--;
      // The `}` that closes a `${`: back into the template literal it interrupted.
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        templateText();
      }
    } else {
      out += c;
      at++;
    }
  }
  return out;
}

/** A module's runtime source: no comments, and no type-only import — erased, so not an edge. */
const codeOf = (source: string): string => stripComments(source).replace(TYPE_ONLY, " ");

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** `import(` and whatever its argument opens with — so a non-literal argument can be seen. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*([^)]*)/g;

/**
 * Every specifier a module names at runtime — `from "x"`, a bare `import "x"`, `import("x")`,
 * and an `import(`…`)` whose template literal holds no `${`, which is a string like any other.
 */
function specifiersOf(source: string): string[] {
  const code = codeOf(source);
  const quoted = [...code.matchAll(SPECIFIER)].map(([, spec]) => spec);
  const backticked = [...code.matchAll(DYNAMIC_IMPORT)].flatMap(([, arg]) => {
    const literal = /^`([^`$]*)`/.exec(arg);
    return literal ? [literal[1]] : [];
  });
  return [...quoted, ...backticked];
}

/**
 * Every `import(…)` whose argument is not a literal the walk can read — a template literal with a
 * `${` in it, or an expression — as it is written. **Refused, not resolved**: the module it loads
 * is decided at runtime, so no reading of the text can say what it reaches, and a fence that
 * cannot say is not a fence. Vite's own glob is the way to load one of a set (below).
 */
function opaqueImportsOf(source: string): string[] {
  return [...codeOf(source).matchAll(DYNAMIC_IMPORT)].flatMap(([, arg]) => {
    const text = arg.trim();
    if (/^["']/.test(text) || /^`[^`$]*`/.test(text)) return [];
    return [`import(${text})`];
  });
}

/**
 * Every pattern an `import.meta.glob(…)` names — one string or an array of them — **less its
 * negations**, which only take files away: walking without them is the conservative reading.
 *
 * A glob is an import of every file it matches, `eager` or not, which is why the walk follows it.
 * A `?raw` read through one is followed too, though raw text runs nothing: the option is an
 * argument this would have to parse, a phone file globbing `packages/ui/` as text has no business the
 * fence should wave through unread, and the tests that do it are exempt by name.
 *
 * A first argument that is not a literal is not a pattern Vite accepts, so it is not read here.
 */
function globsOf(source: string): string[] {
  const GLOB =
    /\bimport\.meta\.glob\w*\s*(?:<[^(]*>)?\s*\(\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|`[^`]*`)/g;
  return [...codeOf(source).matchAll(GLOB)].flatMap(([, arg]) =>
    [...arg.matchAll(/["'`]([^"'`]+)["'`]/g)]
      .map(([, pattern]) => pattern)
      .filter((pattern) => !pattern.startsWith("!")),
  );
}

/** A glob as a regular expression over root-absolute paths: `**`, `*`, `?` and `{a,b}`. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  let braces = 0;
  for (let at = 0; at < glob.length; at++) {
    const c = glob[at];
    if (c === "*" && glob[at + 1] === "*") {
      // `**/` is any number of whole directories, none included; a trailing `**` is anything.
      if (glob[at + 2] === "/") {
        out += "(?:[^/]+/)*";
        at += 2;
      } else {
        out += ".*";
        at += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      out += "(?:";
      braces++;
    } else if (c === "}" && braces > 0) {
      out += ")";
      braces--;
    } else if (c === "," && braces > 0) out += "|";
    else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * How a specifier names a folder of this repository without spelling the path: the shared UI's
 * own alias, and a workspace package's name. A file outside `packages/ui` names a UI module by
 * the package (`@grimoire/ui/lib/store`), a file inside it by the alias (`@/lib/store`), and the
 * walk goes through both kinds.
 */
const PACKAGE_ROOTS: readonly (readonly [prefix: string, root: string])[] = [
  ["@/", "/packages/ui/"],
  ["@grimoire/ui/", "/packages/ui/"],
  ["@grimoire/fake/", "/packages/fake/"],
];

/**
 * `spec` as written in `from`, as a root-absolute path with its `.` and `..` folded away. A
 * root-absolute specifier is the root's already — Vite resolves `/packages/ui/lib/store` against
 * the root, which is the repository here — and an alias or a package name is its folder.
 */
function stemOf(from: string, spec: string): string {
  const named = PACKAGE_ROOTS.find(([prefix]) => spec.startsWith(prefix));
  const raw = named
    ? `${named[1]}${spec.slice(named[0].length)}`
    : spec.startsWith("/")
      ? spec
      : `${from.slice(0, from.lastIndexOf("/"))}/${spec}`;
  const out: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * Ours to follow: the alias, a workspace package's name, a relative path, or a root-absolute
 * one. Any other bare name is somebody else's package, and so is a protocol-relative `//host/…`.
 */
const inRepo = (spec: string): boolean =>
  PACKAGE_ROOTS.some(([prefix]) => spec.startsWith(prefix)) ||
  spec.startsWith(".") ||
  (spec.startsWith("/") && !spec.startsWith("//"));

/**
 * A stylesheet, a picture, a `?raw` read — a file that is not a module. **A list, not "anything
 * with a dot"**: `./Tile.stories` has a dot too, and is exactly the import the walk should say
 * it could not follow.
 */
const ASSET_EXTENSION = /\.(?:css|json|svg|png|jpe?g|webp|woff2?)$/i;
const isAsset = (spec: string): boolean => spec.includes("?") || ASSET_EXTENSION.test(spec);

/** A specifier as a key of `files`, or `null` for one this walk cannot follow. */
function resolve(files: Sources, from: string, spec: string): string | null {
  if (!inRepo(spec)) return null;
  const stem = stemOf(from, spec);
  const candidates = [stem, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`];
  return candidates.find((candidate) => candidate in files) ?? null;
}

/** The desktop's own: its store, its shell, and its window verbs. Its boot is a directory. */
const FORBIDDEN_FILES = [
  "/packages/ui/lib/store.ts",
  "/packages/ui/App.tsx",
  "/packages/ui/components/AppShell.tsx",
  "/packages/ui/components/TitleBar.tsx",
  "/packages/ui/components/Ribbon.tsx",
  "/packages/ui/lib/window.ts",
];
// The desktop's boot lived in `src/boot/` until `DesktopBoot` and `StartupScreen` moved, with
// `main.tsx`, into `apps/desktop/src/` on 2026-10-08; both folders are the desktop's boot still.
const FORBIDDEN_DIRS = ["/packages/ui/boot/", "/apps/desktop/src/"];
const isForbidden = (file: string): boolean =>
  FORBIDDEN_FILES.includes(file) || FORBIDDEN_DIRS.some((dir) => file.startsWith(dir));

/** Tauri's API is reached through `lib/core` and nowhere else. */
const TAURI_DOOR = "/packages/ui/lib/core/tauri.ts";

interface Walk {
  /** Every module the entries reach at runtime, themselves included. */
  reached: Set<string>;
  /** One line per refused edge, **as the whole trail from the entry that started it** — the
   *  last hop alone names a file in `packages/ui/` and not the phone file that has to change. */
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

  /** One edge, from `file` to the module `target` it reaches. */
  const follow = (file: string, target: string): void => {
    if (isForbidden(target)) refused.push(`${trailTo(file)} → ${target}`);
    else if (!cameFrom.has(target)) {
      cameFrom.set(target, file);
      queue.push(target);
    }
  };

  while (queue.length > 0) {
    const file = queue.shift() as string;
    const source = files[file] ?? "";
    for (const spec of specifiersOf(source)) {
      if (spec.startsWith("@tauri-apps/") && file !== TAURI_DOOR) {
        refused.push(`${trailTo(file)} → ${spec}`);
      }
      const target = resolve(files, file, spec);
      if (target !== null) follow(file, target);
      else if (inRepo(spec) && !isAsset(spec)) blind.push(`${trailTo(file)} → ${spec}`);
    }
    for (const opaque of opaqueImportsOf(source)) refused.push(`${trailTo(file)} → ${opaque}`);
    for (const pattern of globsOf(source)) {
      // A glob of pictures or stylesheets is no more a module than one of them is.
      if (ASSET_EXTENSION.test(pattern)) continue;
      const matcher = globToRegExp(stemOf(file, pattern));
      const targets = Object.keys(files).filter((path) => matcher.test(path));
      if (targets.length === 0) blind.push(`${trailTo(file)} → import.meta.glob("${pattern}")`);
      for (const target of targets) follow(file, target);
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
  const entries = Object.keys(files).filter((path) => path.startsWith("/apps/light/phone/"));

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

  it("keeps an import that a comment opener in a string or a regex would have swallowed", () => {
    // Each of these opens a "comment" for a stripper that is not string-aware, and the next
    // closer is two lines down — in a string, where it closes nothing either.
    const opener = "/" + "*";
    const closer = "*" + "/";
    expect(
      specifiersOf(`
        const glob = "packages/ui/${opener}.ts";
        import { a } from "@/lib/a";
        const close = "${closer}";
      `),
    ).toEqual(["@/lib/a"]);
    expect(
      specifiersOf(`
        const slashes = /^\\/*/;
        import { b } from "@/lib/b";
        const close = "${closer}";
      `),
    ).toEqual(["@/lib/b"]);
    // And a line-comment opener in a string is text, wherever it falls in the line.
    expect(specifiersOf(`const path = "a//b"; import "@/lib/c";`)).toEqual(["@/lib/c"]);
    // …while a real comment still goes, apostrophe and all.
    expect(specifiersOf(`// don't count "@/lib/store"\nimport "@/lib/d";`)).toEqual(["@/lib/d"]);
  });

  it("reads a template-literal import with nothing interpolated as the string it is", () => {
    expect(specifiersOf("const m = await import(`@/lib/late`);")).toEqual(["@/lib/late"]);
    expect(opaqueImportsOf("const m = await import(`@/lib/late`);")).toEqual([]);
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
    for (const dir of FORBIDDEN_DIRS) expect(Object.keys(SRC).some((path) => path.startsWith(dir))).toBe(true);
    expect(Object.keys(LIGHT).filter((path) => /\/(?:vite\.[^/]*\.ts|dist-[^/]*\/.*)$/.test(path))).toEqual([]);
    expect(Object.keys(LIGHT)).toContain(HARNESS);
  });

  describe("on a tree with a weld in it", () => {
    const CLEAN: Sources = {
      "/apps/light/phone/Shell.tsx": `import { TabBar } from "./TabBar";`,
      "/apps/light/phone/TabBar.tsx": `import { NAV } from "@grimoire/ui/components/nav";`,
      "/packages/ui/components/nav.ts": `import type { ViewId } from "@/lib/store";`,
      "/packages/ui/lib/store.ts": `export const useAppStore = 1;`,
      "/packages/ui/lib/window.ts": `import { getCurrentWindow } from "@tauri-apps/api/window";`,
      "/packages/ui/lib/core/tauri.ts": `import { invoke } from "@tauri-apps/api/core";`,
      "/packages/ui/lib/ipc.ts": `import { core } from "./core";`,
      "/packages/ui/lib/core/index.ts": `import { tauriCore } from "./tauri";`,
      "/packages/ui/boot/useStartup.ts": `export const useStartup = 1;`,
    };
    /** The clean tree with files swapped in, walked from the shell. */
    const from = (extra: Sources): Walk =>
      walk({ ...CLEAN, ...extra }, ["/apps/light/phone/Shell.tsx"]);
    /** The same, with the tab bar's source replaced — where every weld below is put. */
    const withTabBar = (source: string): Walk => from({ "/apps/light/phone/TabBar.tsx": source });
    /** How every trail below begins. */
    const VIA = "/apps/light/phone/Shell.tsx → /apps/light/phone/TabBar.tsx";

    it("passes the clean one, and went past the first hop to say so", () => {
      const { reached, refused, blind } = from({});
      expect(refused).toEqual([]);
      expect(blind).toEqual([]);
      // The store is named by `nav.ts` as a type, and is not reached.
      expect([...reached]).toEqual([
        "/apps/light/phone/Shell.tsx",
        "/apps/light/phone/TabBar.tsx",
        "/packages/ui/components/nav.ts",
      ]);
    });

    it("refuses the store, however it is imported", () => {
      const refused = [`${VIA} → /packages/ui/lib/store.ts`];
      expect(withTabBar(`import { useAppStore } from "@/lib/store";`).refused).toEqual(refused);
      expect(withTabBar(`import { useAppStore } from "@grimoire/ui/lib/store";`).refused).toEqual(refused);
      expect(withTabBar(`import "../../../packages/ui/lib/store";`).refused).toEqual(refused);
      expect(withTabBar(`const s = await import("@/lib/store");`).refused).toEqual(refused);
      // Root-absolute: Vite resolves it against the root, which is the repository.
      expect(withTabBar(`import { useAppStore } from "/packages/ui/lib/store";`).refused).toEqual(refused);
      expect(withTabBar("const s = await import(`@/lib/store`);").refused).toEqual(refused);
    });

    it("refuses the store reached through a glob, however the glob is spelled", () => {
      // A glob is an import of every file it matches. Each of these matches the store.
      for (const glob of [
        `import.meta.glob("/packages/ui/lib/store.ts", { eager: true })`,
        `import.meta.glob("@/lib/s*.ts")`,
        `import.meta.glob("../../../packages/ui/**/store.{ts,tsx}")`,
        `import.meta.glob<{ default: unknown }>(["./*.css", "/packages/ui/lib/*.ts", "!/packages/ui/lib/window.ts"])`,
      ]) {
        expect(withTabBar(`const all = ${glob};`).refused, glob).toContain(
          `${VIA} → /packages/ui/lib/store.ts`,
        );
      }
      // …and a glob that matches only what the phone may reach is followed, not refused.
      const { refused, reached } = withTabBar(
        `const navs = import.meta.glob("@/components/*.ts");`,
      );
      expect(refused).toEqual([]);
      expect([...reached]).toContain("/packages/ui/components/nav.ts");
    });

    it("refuses an import whose module is decided at runtime", () => {
      // Nothing in the text says what these load, so nothing can say they are clean.
      expect(withTabBar("const page = await import(`@/lib/${name}`);").refused).toEqual([
        `${VIA} → import(\`@/lib/\${name}\`)`,
      ]);
      expect(withTabBar(`const page = await import(which);`).refused).toEqual([
        `${VIA} → import(which)`,
      ]);
    });

    it("refuses a weld two files into `packages/ui/`, and prints the way there", () => {
      // The case a grep over `apps/light/phone/` cannot see, and the reason the trail is printed
      // whole: the offending edge is between two files in `packages/ui/`.
      const { refused } = from({
        "/packages/ui/components/nav.ts": `import { helper } from "./helper";`,
        "/packages/ui/components/helper.ts": `import { useAppStore } from "@/lib/store";`,
      });
      expect(refused).toEqual([
        `${VIA} → /packages/ui/components/nav.ts → /packages/ui/components/helper.ts → /packages/ui/lib/store.ts`,
      ]);
    });

    it("refuses the desktop's boot and its window verbs", () => {
      expect(withTabBar(`import { useStartup } from "@/boot/useStartup";`).refused).toEqual([
        `${VIA} → /packages/ui/boot/useStartup.ts`,
      ]);
      expect(withTabBar(`import { minimize } from "@/lib/window";`).refused).toEqual([
        `${VIA} → /packages/ui/lib/window.ts`,
      ]);
    });

    it("refuses Tauri everywhere but behind the core's door", () => {
      const throughTheDoor = withTabBar(`import { ipc } from "@grimoire/ui/lib/ipc";`);
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
      // The fake is a package of this repository and is not in the tree either: a phone file that
      // reached it at runtime would be a part of the graph nobody checked.
      expect(withTabBar(`import { installWorld } from "@grimoire/fake/world";`).blind).toEqual([
        `${VIA} → @grimoire/fake/world`,
      ]);
      // A stylesheet is not a module, and is not a dead end.
      expect(withTabBar(`import "./tabs.css";`).blind).toEqual([]);
      // A glob that matches nothing the walk holds is one too — and so is a glob of pictures.
      expect(withTabBar(`const pages = import.meta.glob("./pages/*.tsx");`).blind).toEqual([
        `${VIA} → import.meta.glob("./pages/*.tsx")`,
      ]);
      expect(withTabBar(`const icons = import.meta.glob("./icons/*.svg");`).blind).toEqual([]);
    });
  });

  it("reaches no desktop store, no desktop shell and no Tauri window", () => {
    const { reached, refused, blind } = walk(files, entries);

    // **Do not weaken this to make it pass.** Each line is a trail from a phone file to the thing
    // it may not reach: use the data hook rather than the page, pass the value in as a prop, or
    // change the welded component in `packages/ui/` to take props.
    expect(refused).toEqual([]);
    expect(blind).toEqual([]);

    // The walk is worthless if it never left `apps/light/phone/`, and worth less than it looks if it
    // stopped at the alias. Each of these is at the far end of something: `routes.ts` is up and
    // out of the directory, the hook is behind a page, `tooltipStore` is reached only through a
    // relative specifier, and `core/tauri.ts` is behind `ipc.ts` and the core's own index.
    expect([...reached]).toEqual(
      expect.arrayContaining([
        "/apps/light/routes.ts",
        "/packages/ui/components/CardArt.tsx",
        "/packages/ui/components/CardTile.tsx",
        "/packages/ui/features/search/useCardSearch.ts",
        "/packages/ui/components/tooltip/tooltipStore.ts",
        "/packages/ui/lib/ipc.ts",
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
 * the first thing that follows from it — *"Nothing under `apps/light/` asks where it is running. No
 * user-agent test, no `isTauri`, no `isAndroid`, no `display-mode` query deciding what a page
 * draws."*
 *
 * **The question, not a spelling of it.** `userAgent` is the bare word, so a destructure, a bracket
 * read or `Reflect.get` asks it too; `navigator.platform` is the property however `navigator` is
 * reached for it, because the bare word is English; and Tauri's OS plugin is refused by name, since
 * every export it has answers where this is running.
 *
 * **Swept raw, comments included.** Nothing in the tree trips it today, and prose that names a
 * probe is how one gets copied into a component — `tokens.test.ts`'s reason for refusing a
 * retired class in a comment. `import.meta.env.MODE` is not here: it is which *build* this is,
 * decided at compile time, and it is how `main.tsx` leaves the fake out of a production bundle.
 */
const PROBES: readonly (readonly [name: string, pattern: RegExp])[] = [
  // The bare word, not `navigator.userAgent`: destructured, read by bracket or through `Reflect`,
  // it is still the one question. `userAgentData` is the next row — `\b` keeps the two apart.
  ["userAgent", /\buserAgent\b/],
  ["userAgentData", /\buserAgentData\b/],
  // Not the bare word, which is English: the property, however it is reached on `navigator`.
  [
    "navigator.platform",
    /\bnavigator\s*(?:\??\.\s*platform\b|\[\s*["'`]platform["'`])|\{[^}]*\bplatform\b[^}]*\}\s*=\s*(?:window\s*\.\s*)?navigator\b/,
  ],
  ["isTauri", /\bisTauri\b/],
  ["__TAURI", /__TAURI/],
  ["isAndroid", /\bisAndroid\b/],
  ["isWebTarget", /\bisWebTarget\b/],
  ["display-mode", /\bdisplay-mode\b/],
  // Tauri's OS plugin is a platform question by construction — `platform()`, `type()`, `arch()`.
  ["@tauri-apps/plugin-os", /@tauri-apps\/plugin-os\b/],
];

/** Each probe in `source`, as `line N: <probe>`. */
function probesIn(source: string): string[] {
  return source
    .split("\n")
    .flatMap((line, index) =>
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
      `import { platform } from "@tauri-apps/plugin-os";`,
    ];
    // One probe a line, in the list's own order — so a row added to the list without a sample
    // here is a row nobody has seen match, and this goes red on its length.
    expect(asked.map(probesIn)).toEqual(PROBES.map(([name]) => [`line 1: ${name}`]));
  });

  it("finds a probe however it is reached", () => {
    // Each of these asked the question while spelling it in a way the first sweep did not read.
    expect(probesIn(`const { userAgent } = navigator;`)).toEqual(["line 1: userAgent"]);
    expect(probesIn(`const ua = navigator["userAgent"];`)).toEqual(["line 1: userAgent"]);
    expect(probesIn(`const ua = Reflect.get(window.navigator, "userAgent");`)).toEqual([
      "line 1: userAgent",
    ]);
    expect(probesIn(`const os = navigator['platform'];`)).toEqual(["line 1: navigator.platform"]);
    expect(probesIn(`const { platform: os } = window.navigator;`)).toEqual([
      "line 1: navigator.platform",
    ]);
    const plugin = `const { type } = await import("@tauri-apps/plugin-os");`;
    expect(probesIn(plugin)).toEqual(["line 1: @tauri-apps/plugin-os"]);
  });

  it("leaves the word platform alone when it is not navigator's", () => {
    expect(probesIn(`// the same on every platform, which is the point`)).toEqual([]);
    expect(probesIn(`const { platform } = props;`)).toEqual([]);
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

  it("is asked by nothing under `apps/light/`", () => {
    const swept = Object.keys(LIGHT).filter((path) => path !== SELF);

    const asked = swept.flatMap((path) => probesIn(LIGHT[path]).map((hit) => `${path}, ${hit}`));
    expect(asked).toEqual([]);

    // A sweep over nothing finds nothing. The same kind of floor as the walk's, tests included —
    // and one file of each kind the sweep reads, so a glob that lost an extension shows.
    expect(swept.length).toBeGreaterThan(20);
    expect(swept).toEqual(
      expect.arrayContaining([
        "/apps/light/main.tsx",
        "/apps/light/useFace.ts",
        "/apps/light/mobile.css",
        "/apps/light/index.html",
        "/apps/light/phone/Shell.test.tsx",
      ]),
    );
  });
});
