/// <reference types="vite/client" />

// `__CORE__` — which `Core` implementation this build talks to — is **deliberately not
// declared here**, where it would otherwise belong. This file is not in the Storybook
// type-check program: `.storybook/tsconfig.json` sets its own `include` and lists
// `vite/client` in `types` by hand for exactly that reason, and `npm run build` runs that
// program too. It is declared in `src/lib/core/index.ts` instead, which both programs
// contain; the full reason is written there.
