---
paths:
  - "**/*.{ts,tsx,mts,cts}"
---

# typescript-lsp, and the one answer it gets wrong

The `typescript-lsp` plugin is active for every `.ts`/`.tsx` file — `src/`, `.storybook/`,
`.design-sync/` and `relay/` alike. All nine `LSP` operations were driven against this tree on
2026-09-01. It resolves the **workspace** TypeScript (6.0.3), not whatever is installed globally,
so it honours the TS 6.0.x pin rather than type-checking against a newer compiler. If a call
errors that no server is configured, check `typescript-lsp` is enabled in settings before
concluding the tooling is broken.

## Reach for it when the question is semantic

`hover` returns the full doc comment, which in this repo is where the *reasoning* lives — the
`combosForCardsKey` hover carries the whole explanation of why the key is the card ids and not the
deck id. That is usually faster and more complete than opening the file. `goToDefinition` follows
the `@/` alias without you resolving it, and `incomingCalls` answers "which component calls this"
directly.

Keep grep for strings, class names, Tailwind tokens, and anything crossing into Rust.

## `findReferences` silently under-reports — always cross-check

**This is the one that will cost you a wrong conclusion.** tsserver only searches files it has
already loaded, and it does not tell you that. Measured: `findReferences` on `combosForCardsKey`
(`src/lib/query.ts:68`) returned **1 reference — its own declaration** — while an import and a
call site sat in `src/features/decks/DeckBracket.tsx`. A single `hover` on that file, and the
identical call returned **3 references across 2 files**.

There is no error and no warning. A narrow answer looks exactly like a true answer.

So: **never conclude a symbol is unused, dead, or safe to delete from `findReferences` alone.**
Confirm with `grep` before acting, or `hover` the files you suspect and ask again. This matters
most during a wiring sweep or a rename, where "1 reference" reads as "nothing else to update"
and the compiler will not catch a missed dynamic usage.

rust-analyzer does **not** share this failure — once indexed it answers across the whole
workspace cold. The habit is TypeScript-specific.
