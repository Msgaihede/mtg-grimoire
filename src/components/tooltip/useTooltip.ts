import { createContext, useContext, useMemo, type FocusEventHandler, type PointerEventHandler, type ReactNode } from "react";
import type { TooltipSide } from "@/lib/tooltip";

export interface TooltipOptions {
  /** Preferred side. `placeTooltip` flips it when the window is in the way. Default `"top"`. */
  side?: TooltipSide;
  /**
   * The pointer may enter the panel and its text may be selected.
   *
   * A pointer affordance and nothing else — the panel never takes focus, so a keyboard reader
   * hears the words through `aria-describedby` and cannot select them. A panel Tab could reach
   * would need a rung on the dismissal ladder and a focus hand-back, at which point it has
   * stopped being a tooltip and is `AnchoredPopup`.
   */
  interactive?: boolean;
  /**
   * Open only when the anchor's own text is genuinely cut off — `scrollWidth > clientWidth`.
   *
   * For the largest group of call sites: a `truncate` cell whose tooltip is its own full text.
   * The measurement happens at pointer-enter and costs nothing until then, which is what makes
   * this free on four hundred virtualised rows. **Implies `describes: false`**: the text in the
   * DOM is complete and the accessibility tree already has all of it — only the paint is clipped,
   * so describing it would make a screen reader say the set name twice.
   */
  whenClipped?: boolean;
  /** Wire `aria-describedby` while open. Default `true`. */
  describes?: boolean;
}

/** What a bound element gets. Every field optional, so "no tooltip" is `{}`. */
export interface TooltipBinding {
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onBlur?: FocusEventHandler<HTMLElement>;
}

/** What the provider hands every surface. */
export interface TooltipApi {
  enter: (anchor: HTMLElement, content: ReactNode, options: TooltipOptions) => void;
  focus: (anchor: HTMLElement, content: ReactNode, options: TooltipOptions) => void;
  leave: (anchor: HTMLElement) => void;
}

/**
 * What a surface gets when nothing has mounted a `TooltipProvider` above it: no tooltip.
 *
 * **A no-op rather than a thrown "missing provider", and it is the same trade `NO_MENU` makes in
 * `menu/useContextMenu.ts`.** After the sweep, most surfaces in the app bind a tooltip, and every
 * one of them is also a Storybook story and a test that renders it on its own — so a throw here
 * would not be a helpful error at the one call site that forgot, it would be
 * `src/stories.test.tsx` red for everybody. The cost is that a forgotten provider is a hint that
 * never appears rather than a message saying why, which is why the two mounts that matter —
 * `src/App.tsx` and `.storybook/preview.tsx` — are pinned by `src/lib/tokens.test.ts`.
 */
const NO_TOOLTIP_API: TooltipApi = { enter: () => {}, focus: () => {}, leave: () => {} };

export const TooltipContext = createContext<TooltipApi>(NO_TOOLTIP_API);

/** Nothing bound, as one frozen object, so a re-render is not a new prop identity. */
const NO_BINDING: TooltipBinding = Object.freeze({});

export type TooltipBinder = (content: ReactNode, options?: TooltipOptions) => TooltipBinding;

/**
 * The one door a surface uses: `{...tip(words)}` on the element it already has.
 *
 * **The anchor is `event.currentTarget`, so there is no ref to merge and no wrapper element.**
 * That is the whole reason this is a spread rather than a `<Tooltip>` component: it cannot break a
 * `min-w-0` chain in a truncating flex cell or displace an absolutely positioned card corner, and
 * the edit at a call site is the one line the `title` attribute occupied.
 *
 * `content` of `null`, `undefined`, `false`, `""` or `0` binds nothing — the same shape as the
 * `title={… ?? undefined}` that nine sites in this app already used, and as `cond && "words"`.
 * **`0` is falsy on purpose, and it is the one departure from "whatever survives a truthiness
 * check binds."** `cond && "words"` is the documented shape above, and a numeric `cond` — a
 * count, a length — reaching this hook un-coerced is a call site that meant `cond > 0`, not one
 * that meant the tooltip to read the single digit "0". A tooltip whose entire content is "0" is
 * a bug at the call site far more often than it is an intent, so this hook refuses to bind it
 * rather than faithfully show something almost nobody wanted.
 */
export function useTooltip(): TooltipBinder {
  const api = useContext(TooltipContext);
  return useMemo<TooltipBinder>(
    () => (content, options = {}) => {
      if (
        content === null ||
        content === undefined ||
        content === false ||
        content === "" ||
        content === 0
      ) {
        return NO_BINDING;
      }
      return {
        onPointerEnter: (e) => api.enter(e.currentTarget, content, options),
        onPointerLeave: (e) => api.leave(e.currentTarget),
        onFocus: (e) => api.focus(e.currentTarget, content, options),
        onBlur: (e) => api.leave(e.currentTarget),
      };
    },
    [api],
  );
}
