/**
 * **What the export writer's graph names from `@/lib/ipc`, and nothing else** — the type-check's
 * stand-in for the shared UI's IPC barrel, which `tsconfig.json`'s `paths` points
 * `@/lib/ipc` at.
 *
 * The writer (`packages/ui/features/transfer/`) imports these as types only, so a bundle carries
 * nothing of the barrel either way. The barrel itself is a webview's: it reaches Tauri and the
 * web host's Worker, whose DOM types this Worker's program has no business loading. The two
 * literal types are the barrel's (`packages/ui/lib/ipc/decks.ts`), copied; the four rows are the
 * converters' inputs `TransferCard.ts` takes and this Worker never calls, so they are opaque. The
 * shared UI's own program checks the real ones.
 */
export type CategoryKind = "main" | "side" | "commander" | "companion" | "maybe";
export type DeckFinish = "foil" | "etched" | null;
/* eslint-disable @typescript-eslint/no-explicit-any */
export type CollectionRow = any;
export type DeckCard = any;
export type TradeLine = any;
export type WishRow = any;
