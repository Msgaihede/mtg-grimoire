/**
 * CardZoomIndicator's preview — owned, because `WhileZooming` is *about* a badge that only its
 * `play` puts up.
 *
 * Storybook runs a story's `play` and compare photographs the root while that play is still in
 * flight: `WhileZooming`'s play presses **Zoom in**, and the shot lands inside the badge's
 * `ZOOM_QUIET_MS` (1,200 ms), so the reference shows `130%` in the frame's top-right corner. A
 * preview runs no play (the converter stubs `storybook/test`), so the generated wrapper showed the
 * two buttons and no badge — measured on the 2026-09-27 capture. The other five stories are the
 * badge at rest with its figure passed as an argument, and need nothing.
 *
 * {@link withPlay} re-enacts the play's one interaction — `userEvent.click` on **Zoom in** — once
 * the cell has mounted, and nothing else: no store writes of its own, no props the story does not
 * pass. The press goes through the story's own `onClick`, so it reaches the bundle's
 * `useAppStore().zoomCards` exactly as the play's click does, and the badge then fades on the
 * component's own timer — which is the rest of the play, since everything after the click is a
 * wait. The `done` ref keeps a StrictMode double effect from pressing twice (140%).
 *
 * `compose` below is copied verbatim from the generated wrapper
 * (`.design-sync/.cache/previews/CardZoomIndicator.tsx`) — keep it that way, so a converter change
 * to story composition can be diffed straight across. If `WhileZooming`'s play changes,
 * `[STORY_CHANGED]` names it on the next sync and this file has to follow.
 */
import * as React from 'react';
import * as S from "@ds-stories/src/components/CardZoomIndicator.stories";

function compose(S: any, key: string) {
  const meta: any = S.default ?? {};
  const st: any = S[key];
  const args: any = { ...(meta.args ?? {}), ...(st && st.args ? st.args : {}) };
  // Storybook resolves argTypes.mapping (control value -> real arg) before
  // rendering; mirror that so mapped args don't render raw.
  const at: any = { ...(meta.argTypes ?? {}), ...(st && st.argTypes ? st.argTypes : {}) };
  for (const k of Object.keys(args)) {
    const m = at[k] && at[k].mapping;
    if (m && typeof m === 'object' && args[k] in m) args[k] = m[args[k]];
  }
  const title: string = typeof meta.title === 'string' ? meta.title : '';
  const ctx: any = {
    args, name: key, title, kind: title, id: '', componentId: '',
    globals: {}, viewMode: 'story',
    parameters: (st && st.parameters) ?? meta.parameters ?? {},
  };
  let render: (() => any) | null = null;
  if (st && typeof st.render === 'function') render = () => st.render(args, ctx);
  else if (typeof st === 'function') render = () => st(args, ctx);
  else if (typeof meta.render === 'function') render = () => meta.render(args, ctx);
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

export const Enlarged = /* Enlarged */ compose(S, "Enlarged");
export const LifeSize = /* Life Size */ compose(S, "LifeSize");
export const AtHalfSize = /* At Half Size */ compose(S, "AtHalfSize");
export const AtDoubleSize = /* At Double Size */ compose(S, "AtDoubleSize");
export const InASectionsCorner = /* In A Sections Corner */ compose(S, "InASectionsCorner");
/** The DOM half of a `play`, run once the cell has mounted, against the cell's own root. */
type Act = (root: HTMLElement) => void;

function withPlay(S: any, key: string, act: Act) {
  const Cell = compose(S, key);
  return function Story() {
    const ref = React.useRef<HTMLDivElement>(null);
    const done = React.useRef(false);
    React.useEffect(() => {
      if (done.current || !ref.current) return;
      done.current = true;
      act(ref.current);
    }, []);
    // `display: contents` so the wrapper adds no box — the cell lays out exactly as the story's.
    return (
      <div ref={ref} style={{ display: "contents" }}>
        <Cell />
      </div>
    );
  };
}

/** `userEvent.click(canvas.getByRole("button", { name: "Zoom in" }))`, as far as `onClick` can tell. */
const pressZoomIn: Act = (root) => {
  const button = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Zoom in");
  button?.click();
};

export const WhileZooming = /* While Zooming */ withPlay(S, "WhileZooming", pressZoomIn);
