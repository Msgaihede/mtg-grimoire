/**
 * Dialog's preview — owned, because the scrim needs a stage with a *size*.
 *
 * `Dialog`'s scrim is `fixed inset-0 grid place-items-center` (see `src/components/Dialog.tsx`),
 * and `cfg.overrides.Dialog.cardMode: "single"` mounts each cell inside the card's
 * `.ds-single{transform:translateZ(0)}` wrapper. That transform correctly makes the wrapper the
 * containing block for a `fixed` descendant — that is the whole point of single mode — but the
 * wrapper has no *definite* size: its height is driven by content, and the scrim is out of flow
 * and contributes none. So `inset-0` resolved against a zero-height box, and measured on the
 * first capture at 900x700 the panel was top-anchored instead of centred and ran past the right
 * edge with its text never wrapping, while storybook at the same 900x700 drew an 880px
 * (`w-[55rem]`) panel centred with a gold border on all four sides.
 *
 * `withStage` supplies what was missing and nothing else: a box of exactly the card's declared
 * viewport that is itself transformed, so it — not the outer wrapper — is the nearest containing
 * block, and `inset-0` now resolves against a real 900x700. **Keep STAGE equal to
 * `cfg.overrides.Dialog.viewport`**; they are two halves of one measurement, and a viewport
 * change that does not move this constant silently re-introduces the bug it was written for.
 *
 * `compose` below is copied verbatim from the generated wrapper
 * (`.design-sync/.cache/previews/Dialog.tsx`) — keep it that way, so a converter change to story
 * composition can be diffed straight across.
 */
import * as React from "react";
import * as S from "@ds-stories/src/components/Dialog.stories";

/** The card's declared viewport — `cfg.overrides.Dialog.viewport`, in sync by hand. */
const STAGE = { width: 960, height: 700 };

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
    args, name: key, title, kind: title, id: "", componentId: "",
    globals: {}, viewMode: "story",
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

/** One cell on a stage the scrim can measure itself against. */
function withStage(S: any, key: string) {
  const Cell = compose(S, key);
  return function Story() {
    return (
      <div
        style={{
          position: "relative",
          width: STAGE.width,
          height: STAGE.height,
          maxWidth: "100%",
          overflow: "hidden",
          transform: "translateZ(0)",
        }}
      >
        <Cell />
      </div>
    );
  };
}

export const Default = withStage(S, "Default");
export const LongBody = withStage(S, "LongBody");
export const PressingTheScrim = withStage(S, "PressingTheScrim");
export const Flanked = withStage(S, "Flanked");
