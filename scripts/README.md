# Repository scripts

Run scripts directly with Node.js 22.18 or newer, for example:

```sh
node scripts/cdp.ts pages
pnpm web:smoke
pnpm scanner:bench --sizes
```

Node strips TypeScript types at runtime. Scripts use ESM, explicit `.ts` extensions for local
TypeScript imports, and erasable syntax: no enums, parameter properties, namespaces with runtime
code, or compiler-dependent path aliases. Type-only dependencies use `import type`.

Check the scripts with `pnpm exec tsc -p scripts` and the Worker probe tests with
`pnpm exec tsc -p scripts/tsconfig.workers.json`. The root `pnpm build` includes both checks;
`pnpm test:run` collects the TypeScript script tests through Vitest.

The scripts workspace installs its own Node declarations. The browser packages keep their
existing environment: no ambient `process` or `Buffer`, and browser timer return types.
`pnpm-workspace.yaml` prevents Node types from being hoisted, retains separate peer dependency
instances, and removes Vite/Vitest's optional Node peers. This matters because dependency
triple-slash references can load Node declarations even when a browser config has `types: []`.

Browser smoke scripts share the harness in `web-smoke/`. `protocol.ts` supplies the official
Chrome DevTools Protocol command and event types; evaluated page expressions declare their
serialized result types at the call site. These scripts require their existing built app,
browser, or development server prerequisites, documented in each script's header.
