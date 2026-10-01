import { createContext, useContext } from "react";
import type { ViewId } from "./store";

/**
 * The destinations the light app draws, in the rail's own order.
 *
 * `satisfies` rather than an annotation: the tuple's literal members are what {@link LightView}
 * is derived from, and a view removed from `ViewId` is a compile error here.
 */
export const LIGHT_VIEWS = [
  "search",
  "decks",
  "collection",
  "wishlist",
  "scanner",
  "settings",
] as const satisfies readonly ViewId[];

export type LightView = (typeof LIGHT_VIEWS)[number];

/** Where a light install opens when the URL names no destination. */
export const LIGHT_START: LightView = "search";

const LIGHT_SET = new Set<string>(LIGHT_VIEWS);

/** A `Set` rather than `in`, which walks the prototype — `useStartView.ts`'s own reason. */
export function isLightView(value: string): value is LightView {
  return LIGHT_SET.has(value);
}

/**
 * Which app this shell is drawing — handed to it once, at the root.
 *
 * **A seam, not a platform check.** Nothing here says where the code is running; it says what to
 * draw. The desktop app provides nothing and gets {@link FULL_EDITION}; the light entry
 * (`mobile/DesktopFace.tsx`) provides {@link LIGHT_EDITION}. A page never reads this — its
 * readers are the shell's rail, its caption and its chords.
 */
export interface Edition {
  id: "full" | "light";
  /** The rail's rows. `null` is every destination `NAV` holds, so the full edition cannot fall
   *  behind a view added to the rail. */
  views: readonly ViewId[] | null;
  /** Whether this window draws its own caption. False wherever a browser or an OS owns the frame. */
  caption: boolean;
  /** The view a URL that names nothing opens on. The full edition's is the store's own default
   *  and nothing reads it there. */
  startView: ViewId;
}

export const FULL_EDITION: Edition = { id: "full", views: null, caption: true, startView: "home" };

export const LIGHT_EDITION: Edition = {
  id: "light",
  views: LIGHT_VIEWS,
  caption: false,
  startView: LIGHT_START,
};

export function editionHas(edition: Edition, view: ViewId): boolean {
  return edition.views === null || edition.views.includes(view);
}

export const EditionContext = createContext<Edition>(FULL_EDITION);

export function useEdition(): Edition {
  return useContext(EditionContext);
}
