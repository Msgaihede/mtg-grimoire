/**
 * AppShell's preview — owned, because four of its twelve stories choose their own backend.
 *
 * `cfg.provider` wraps every cell in one `GrimoirePreviewProvider`, and that provider is handed
 * the mounted element and nothing else: Storybook's `parameters` are metadata on the story
 * object, which no preview wrapper ever sees. AppShell is the only component in the synced set
 * that uses them — `Update Available` and `Sync Failed` ask for a fault, `First Run` and
 * `First Run Failed Mid Run` ask for the `empty` seed — so without this file all four render the
 * default `starter` world and the sheet shows a plain Search view where storybook shows an
 * update panel, a red sync banner and the first-run hero. Measured on the solo pass: 8 of 12
 * matched, and those exact four did not.
 *
 * **The wrapping is derived, never enumerated.** `withWorld` reads `parameters.fake` off the
 * story itself, so a story that gains, loses or changes a seed is followed automatically and a
 * new story needs no edit here. Enumerating the four by name would have been shorter and would
 * have gone stale the first time someone added a fifth.
 *
 * Nesting a `GrimoireWorld` inside the provider's own is deliberate and the inner one wins, on
 * both counts that matter: React fires effects in fiber-completion order so the inner
 * `Activate` re-points the fake's scope last, and `QueryClientProvider` is plain React context
 * where the nearest provider wins.
 *
 * `compose` below is copied verbatim from the generated wrapper
 * (`.design-sync/.cache/previews/AppShell.tsx`) — keep it that way, so a converter change to
 * story composition can be diffed straight across.
 */
import * as React from "react";
import { GrimoireWorld } from "mtg-grimoire";
import * as S from "@ds-stories/src/components/AppShell.stories";

function compose(S: any, key: string) {
  const meta: any = S.default ?? {};
  const st: any = S[key];
  const args: any = { ...(meta.args ?? {}), ...(st && st.args ? st.args : {}) };
  // Storybook resolves argTypes.mapping (control value -> real arg) before
  // rendering; mirror that so mapped args don't render raw.
  const at: any = { ...(meta.argTypes ?? {}), ...(st && st.argTypes ? st.argTypes : {}) };
  for (const k of Object.keys(args)) {
    const m = at[k] && at[k].mapping;
    if (m && typeof m === "object" && args[k] in m) args[k] = m[args[k]];
  }
  const title: string = typeof meta.title === "string" ? meta.title : "";
  const ctx: any = {
    args,
    name: key,
    title,
    kind: title,
    id: "",
    componentId: "",
    globals: {},
    viewMode: "story",
    parameters: (st && st.parameters) ?? meta.parameters ?? {},
  };
  let render: (() => any) | null = null;
  if (st && typeof st.render === "function") render = () => st.render(args, ctx);
  else if (typeof st === "function") render = () => st(args, ctx);
  else if (typeof meta.render === "function") render = () => meta.render(args, ctx);
  else {
    const C = (st && st.component) || meta.component;
    if (C) render = () => React.createElement(C, args);
  }
  if (!render) return () => null;
  // [].concat: a single function is legal CSF decorator shorthand. A
  // decorator returning undefined (stubbed addon) falls through to the inner
  // render — otherwise one unrecognized addon blanks the cell silently.
  const decorators: any[] = ([] as any[]).concat((st && st.decorators) ?? []).concat(meta.decorators ?? []);
  return decorators.reduce((inner: any, dec: any) => () => {
    const out = dec(inner, ctx);
    return out === undefined ? inner() : out;
  }, render);
}

/** One cell, in the world its own story asked for. */
function withWorld(S: any, key: string) {
  const Cell = compose(S, key);
  const fake = ((S[key] && S[key].parameters && S[key].parameters.fake) ??
    (S.default && S.default.parameters && S.default.parameters.fake) ??
    {}) as { seed?: string; fault?: string | null };
  return function Story() {
    return (
      <GrimoireWorld seed={fake.seed} fault={fake.fault}>
        <Cell />
      </GrimoireWorld>
    );
  };
}

export const Search = withWorld(S, "Search");
export const Collection = withWorld(S, "Collection");
export const Wishlist = withWorld(S, "Wishlist");
export const Decks = withWorld(S, "Decks");
export const Settings = withWorld(S, "Settings");
// `UpdateAvailable` is deliberately absent: the story is skipped in cfg.overrides (its `play`
// clicks the gold update button and storybook captures the Settings view that click opens, which
// no static render can reach). Exporting it anyway would ship a cell the compare harness reports
// as an extra with no story to grade it against. `Settings` already shows the Updates panel.
export const SyncFailed = withWorld(S, "SyncFailed");
export const FirstRun = withWorld(S, "FirstRun");
export const FirstRunFailedMidRun = withWorld(S, "FirstRunFailedMidRun");
export const DropTargetsLive = withWorld(S, "DropTargetsLive");
export const DecksDropTargetInert = withWorld(S, "DecksDropTargetInert");
export const DroppedOnWishlist = withWorld(S, "DroppedOnWishlist");
