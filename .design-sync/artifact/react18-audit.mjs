// Reads a built bundle and refuses the things React 18 will not do for it.
//
// The app is React 19; the bundle runs on the page's React **18.3.1** — the Design System
// artifact's own `components/lib/`, and the React every Design canvas supplies. Nothing in
// `pnpm verify` runs these modules on 18, so a React-19-only construct in the bundle's graph
// type-checks, passes every suite, renders at rest on every page card, and fails only when a
// reader presses something: `Dropdown` opened an invisible panel at 0,0 for two months this way
// (NOTES.md, "The artifact runs React 18.3.1").
//
// What it reads is the bundle's own module list — esbuild leaves a `// <repo path>` line above
// each module — so the audit covers exactly what ships, whatever the barrel reaches this month.
// Each repo module on that list is parsed and four things are refused:
//
//   1. a component that takes `ref` as a prop (React 18 hands a function component no `ref`);
//   2. `<Component ref=…>` on anything that is not a `forwardRef` in this graph or `motion.*`;
//   3. a context rendered as its own provider (`<Ctx value=…>`; 18 reads that as a consumer);
//   4. a hook React 18 does not export (`use`, `useEffectEvent`, `useActionState`, …).
//
// Not refused, because it degrades rather than breaks, and it is everywhere: a callback ref that
// returns a cleanup. React 18 ignores the return and calls the callback with `null` instead, so
// every one of them has to take `null` without throwing (they do — the types make them), and
// whatever the cleanup would have released stays held. NOTES.md has the measurement.
//
// Usage: node .design-sync/artifact/react18-audit.mjs [ds-bundle/_ds_bundle.js]
// Exits 1 with one line per finding; prints the module count and nothing else when clean.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundleFile = path.resolve(process.argv[2] ?? path.join(repo, "ds-bundle/_ds_bundle.js"));
const ts = createRequire(path.join(repo, "package.json"))("typescript");

const modules = [
  ...new Set(
    [
      ...fs
        .readFileSync(bundleFile, "utf8")
        .matchAll(/^\s*\/\/ ((?:packages|apps|\.design-sync)\/\S+\.tsx?)$/gm),
    ].map((m) => m[1]),
  ),
].filter((rel) => fs.existsSync(path.join(repo, rel)));
if (modules.length === 0) {
  console.error(`react18-audit: no repo modules named in ${bundleFile} — is it a built bundle?`);
  process.exit(1);
}

const sources = modules.map((rel) =>
  ts.createSourceFile(
    rel,
    fs.readFileSync(path.join(repo, rel), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  ),
);

/** Names bound to `createContext(…)` and to `forwardRef(…)` (through `memo(…)` too), graph-wide. */
const contexts = new Set();
const forwarded = new Set();
for (const sf of sources) {
  (function walk(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const text = node.initializer.getText(sf);
      if (/^(React\.)?createContext\b/.test(text)) contexts.add(node.name.text);
      if (/^(React\.)?(memo\(\s*)?(React\.)?forwardRef\b/.test(text)) forwarded.add(node.name.text);
    }
    ts.forEachChild(node, walk);
  })(sf);
}

const ONLY_19 = new Set([
  "use",
  "useEffectEvent",
  "useActionState",
  "useOptimistic",
  "useFormStatus",
]);
const findings = [];
for (const sf of sources) {
  const at = (node) =>
    `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  (function walk(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      const isComponent = /^[A-Z]/.test(tag) || tag.includes(".");
      const hasRef = node.attributes.properties.some(
        (a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "ref",
      );
      if (isComponent && hasRef && !tag.startsWith("motion.") && !forwarded.has(tag))
        findings.push(`${at(node)}  <${tag} ref=…> — ${tag} is not a forwardRef in the bundle`);
      if (contexts.has(tag))
        findings.push(
          `${at(node)}  <${tag}> — a context as its own provider; write <${tag}.Provider>`,
        );
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf).replace(/^React\./, "");
      if (ONLY_19.has(callee)) findings.push(`${at(node)}  ${callee}() — not in React 18`);
    }
    const isFunction =
      ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
    if (isFunction && node.parameters[0] && ts.isObjectBindingPattern(node.parameters[0].name)) {
      const name =
        node.name?.getText(sf) ??
        (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(sf) : "");
      const takesRef = node.parameters[0].name.elements.some(
        (el) => (el.propertyName ?? el.name).getText(sf) === "ref",
      );
      // A hook taking `{ ref }` is handed a ref *object* by its caller, which is any React's.
      if (takesRef && /^[A-Z]/.test(name))
        findings.push(`${at(node)}  ${name}({ ref }) — takes ref as a prop; wrap it in forwardRef`);
    }
    ts.forEachChild(node, walk);
  })(sf);
}

console.log(`react18-audit: ${modules.length} repo modules in ${path.relative(repo, bundleFile)}`);
if (findings.length > 0) {
  for (const line of findings) console.error("  " + line);
  console.error(`react18-audit: ${findings.length} construct(s) React 18 will not honour`);
  process.exit(1);
}
