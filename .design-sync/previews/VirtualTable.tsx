/**
 * VirtualTable's preview — owned, because `Shelved` is *about* a sticky shelf bar that only its
 * `play` puts up.
 *
 * `Shelved`'s play ends by scrolling the table's scroller 800px down, which hands the sticky bar
 * under the column header to `Trade binder`; storybook photographs that end state. A preview runs
 * no play, so the generated wrapper drew the list at its top — `Binder` as its own heading and an
 * empty bar — which is a different picture of the same component (2026-10-17, the first capture
 * of this story: it sat past compare's 6-story cap until then).
 *
 * {@link withPlay} re-enacts the play's one action and nothing else: `scrollTop = 800` on the
 * table's parent, then the `scroll` event the play dispatches. The scroll is in flow (the bar is
 * the table's sibling inside the scroller, not a fixed panel), so NOTES' rule 3 allows it on this
 * `column` card. One animation frame first, so the virtualiser has measured the scroller it is
 * about to be scrolled in. The `done` ref keeps a StrictMode double effect from scrolling twice.
 *
 * `compose` below is copied verbatim from the generated wrapper
 * (`.design-sync/.cache/previews/VirtualTable.tsx`) — keep it that way, so a converter change to
 * story composition can be diffed straight across. If `Shelved`'s play changes, `[STORY_CHANGED]`
 * names it on the next sync and this file has to follow.
 */
import * as React from 'react';
import * as S from "@ds-stories/packages/ui/components/table/VirtualTable.stories";

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

export const FewRows = /* Few Rows */ compose(S, "FewRows");
export const ManyRows = /* Many Rows */ compose(S, "ManyRows");
export const Empty = /* Empty */ compose(S, "Empty");
export const SortedByName = /* Sorted By Name */ compose(S, "SortedByName");
export const SortedByTwoColumns = /* Sorted By Two Columns */ compose(S, "SortedByTwoColumns");
export const CountUnknown = /* Count Unknown */ compose(S, "CountUnknown");
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
      const root = ref.current;
      requestAnimationFrame(() => act(root));
    }, []);
    // `display: contents` so the wrapper adds no box — the cell lays out exactly as the story's.
    return (
      <div ref={ref} style={{ display: "contents" }}>
        <Cell />
      </div>
    );
  };
}

/** `scroller.scrollTop = 800; scroller.dispatchEvent(new Event("scroll"))`, as the play does it. */
const scrollToTradeBinder: Act = (root) => {
  const scroller = root.querySelector('[role="table"]')?.parentElement;
  if (!scroller) return;
  scroller.scrollTop = 800;
  scroller.dispatchEvent(new Event("scroll"));
};

export const Shelved = /* Shelved */ withPlay(S, "Shelved", scrollToTradeBinder);
