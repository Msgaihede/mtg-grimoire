/**
 * ContextMenu's preview — owned, because `Card` ends its `play` on a keyboard-focused row.
 *
 * The play opens nothing new: the menu is already open, focused on its own panel, and the play's
 * last step is `userEvent.keyboard("{ArrowDown}")`, which moves the caret to **Copy card name**. So
 * storybook photographs that row with its focused fill, and the generated preview — which runs no
 * play — drew the menu with no row focused. Measured on the 2026-09-27 capture; a probe against the
 * shipped bundle reproduced the reference exactly with the one event below.
 *
 * {@link withPlay} re-enacts that end state and nothing else: once the panel has arrived *and* holds
 * focus (the play's own `FRAME_WAIT` and `toHaveFocus()` precondition), a bubbling `keydown`
 * ArrowDown on it. The menu's own handler moves the caret, and `installKeyboardModality` — mounted
 * by `GrimoirePreviewProvider` — reads the key and marks the focus as keyboard. No props, no store
 * writes, no reach into the menu's internals.
 *
 * `compose` below is copied verbatim from the generated wrapper
 * (`.design-sync/.cache/previews/ContextMenu.tsx`) — keep it that way, so a converter change to
 * story composition can be diffed straight across. If `Card`'s play changes, `[STORY_CHANGED]`
 * names it on the next sync and this file has to follow. The other fifteen exports are the
 * generated ones, unchanged.
 */
import * as React from 'react';
import * as S from "@ds-stories/src/components/menu/ContextMenu.stories";

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


/** The DOM half of a `play`, run against the cell's open menu panel. */
type Act = (panel: HTMLElement) => void;

function withPlay(S: any, key: string, act: Act) {
  const Cell = compose(S, key);
  return function Story() {
    const ref = React.useRef<HTMLDivElement>(null);
    const done = React.useRef(false);
    React.useEffect(() => {
      const root = ref.current;
      if (done.current || !root) return;
      done.current = true;
      // The panel arrives a frame after mount and focuses itself; wait for both, bounded. It is
      // drawn by `ContextMenuProvider` as a *sibling* of the story — outside this wrapper but
      // inside the cell's own React root — so look in the card's cell, never the whole document:
      // the grid card holds sixteen menus.
      const scope: ParentNode = root.closest(".ds-cell, .ds-single") ?? root.ownerDocument;
      let frames = 0;
      const tick = () => {
        const panel = scope.querySelector<HTMLElement>('[role="menu"]');
        if (panel && panel === root.ownerDocument.activeElement) act(panel);
        else if (++frames < 90) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, []);
    // `display: contents` so the wrapper adds no box — the cell lays out exactly as the story's.
    return (
      <div ref={ref} style={{ display: "contents" }}>
        <Cell />
      </div>
    );
  };
}

/** `userEvent.keyboard("{ArrowDown}")` with the caret on the panel. */
const arrowDown: Act = (panel) => {
  panel.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
};

export const Card = /* Card */ withPlay(S, "Card", arrowDown);
export const SubmenuExpanded = /* Submenu Expanded */ compose(S, "SubmenuExpanded");
export const AddToDeck = /* Add To Deck */ compose(S, "AddToDeck");
export const AddToWishlistFolders = /* Add To Wishlist Folders */ compose(S, "AddToWishlistFolders");
export const GreyedPrintings = /* Greyed Printings */ compose(S, "GreyedPrintings");
export const NoStoredImage = /* No Stored Image */ compose(S, "NoStoredImage");
export const GreyedCommander = /* Greyed Commander */ compose(S, "GreyedCommander");
export const MoveToPile = /* Move To Pile */ compose(S, "MoveToPile");
export const LabelRadios = /* Label Radios */ compose(S, "LabelRadios");
export const Deck = /* Deck */ compose(S, "Deck");
export const MoveDeckToFolder = /* Move Deck To Folder */ compose(S, "MoveDeckToFolder");
export const Folder = /* Folder */ compose(S, "Folder");
export const Category = /* Category */ compose(S, "Category");
export const PredefinedZone = /* Predefined Zone */ compose(S, "PredefinedZone");
export const EmptyPileCannotBeCleared = /* Empty Pile Cannot Be Cleared */ compose(S, "EmptyPileCannotBeCleared");
export const ClearingAPileAsksFirst = /* Clearing A Pile Asks First */ compose(S, "ClearingAPileAsksFirst");
