/**
 * TooltipProvider's preview — owned, because two of its stories are *about* an open tooltip and
 * only their `play` opens it.
 *
 * compare photographs storybook once the page settles, with the story's `play` already under way —
 * for these two, after it has opened the panel — and a preview never runs one: the converter
 * stubs `storybook/test`, so `userEvent` is inert here even if it were called. `Interactive` and
 * `OnFocus` end their plays with the panel on screen, so their reference shows a tooltip and the
 * generated preview showed a bare button — measured on the first capture, 2026-09-27. The other
 * three need nothing: `Default`'s play hovers *and then unhovers*, so it ends closed, and the two
 * `whenClipped` stories have no play at all.
 *
 * {@link withPlay} re-enacts the **end state** of each play with the DOM events `userEvent` itself
 * dispatches, and nothing else — no store writes, no props the story does not pass:
 *
 * - `Interactive` — `userEvent.hover`. React builds `onPointerEnter` from a bubbling `pointerover`
 *   whose `relatedTarget` is outside the anchor, so that one event is the whole of a hover to
 *   `useTooltip`. The panel then opens on the provider's own `TOOLTIP_OPEN_MS` timer, as it does
 *   in storybook.
 * - `OnFocus` — `userEvent.tab()`: a `keydown` Tab, then focus lands on the button. The keydown is
 *   what `installKeyboardModality` (mounted by `GrimoirePreviewProvider`, as `main.tsx` mounts it
 *   for the app) reads to set `html[data-kbd]`, which is what draws the focus ring the reference
 *   shows; and `TooltipProvider.focus()` opens only for an anchor matching `:focus-visible`.
 *
 * **Re-enacting an end state is the opposite of neutralising one.** The card now shows what the
 * story shows. `compose` below is copied verbatim from the generated wrapper
 * (`.design-sync/.cache/previews/TooltipProvider.tsx`) — keep it that way, so a converter change to
 * story composition can be diffed straight across. If either play changes, `[STORY_CHANGED]` names
 * it on the next sync and this file has to follow.
 */
import * as React from 'react';
import * as S from "@ds-stories/src/components/tooltip/Tooltip.stories";

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

/** The DOM half of a `play`, run once the cell has mounted, against the cell's own button. */
type Act = (button: HTMLButtonElement) => void;

function withPlay(S: any, key: string, act: Act) {
  const Cell = compose(S, key);
  return function Story() {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      const button = ref.current?.querySelector("button");
      if (button) act(button);
    }, []);
    // `display: contents` so the wrapper adds no box — the cell lays out exactly as the story's.
    return (
      <div ref={ref} style={{ display: "contents" }}>
        <Cell />
      </div>
    );
  };
}

/** `userEvent.hover(button)`, as far as `useTooltip` can tell. */
const hover: Act = (button) => {
  button.dispatchEvent(
    new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", relatedTarget: null }),
  );
};

/** `userEvent.tab()` onto the story's only focusable control. */
const tabTo: Act = (button) => {
  button.ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  button.focus();
};

export const Default = /* Default */ compose(S, "Default");
export const Interactive = /* Interactive */ withPlay(S, "Interactive", hover);
export const OnFocus = /* On Focus */ withPlay(S, "OnFocus", tabTo);
export const OnlyWhenClipped = /* Only When Clipped */ compose(S, "OnlyWhenClipped");
export const NotClipped = /* Not Clipped */ compose(S, "NotClipped");
