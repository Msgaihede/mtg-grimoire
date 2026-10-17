// `@/lib/appVersion` as the converter's esbuild must see it. Nothing but
// `.design-sync/tsconfig.json`'s alias reaches this file, and the app never compiles it.
//
// **The real module reads two Vite `define`s the converter is never handed.** `vite.base.ts`
// replaces `import.meta.env.VITE_APP_VERSION` and `import.meta.env.VITE_RELEASE_DATES` in every
// program it builds; the converter's esbuild defines `import.meta.env` as a fixed object without
// them, so `JSON.parse(undefined)` threw at module init and AppShell's card rendered nothing
// (2026-10-17). Its stories reach the module through `SettingsPage` → `VersionPanel`.
//
// **What this answers is never drawn on these cards.** `VersionPanel` is the light edition's;
// the desktop's Settings, which every AppShell story is, draws `UpdatePanel` in its place. So the
// version is the real one, read from the root manifest at every build, and the release days are
// none — not a copy of `CHANGELOG.md`, which would put 390 KB of text into the preview to answer
// a question nothing on the card asks.
import { version } from "../package.json";

export const APP_VERSION: string = version;

export const RELEASE_DATES: Readonly<Partial<Record<string, string>>> = {};

export const APP_RELEASED: string | null = RELEASE_DATES[APP_VERSION] ?? null;
