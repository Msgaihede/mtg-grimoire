import { createContext, useContext } from "react";
import type { PanelId } from "@/features/settings/nav";
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

/**
 * The Settings panels the light app draws — spec §4's *reduced* Settings, mapped onto `nav.ts`'s
 * panels. **Drawing order is `nav.ts`'s `PANELS`, not this list's**, so the order here says
 * nothing; it follows that file for a reader comparing the two.
 *
 * The spec names six things — sync and pairing, the supporter block, card data and the optional
 * feeds, the image cache, marketplace, the danger zone — and says Backup (the mirror) and Updates
 * (the portable swap) are not in it. Each panel, and why:
 *
 * - **`prices`** — *marketplace*, and *card data and the optional feeds*: it is the whole of the
 *   `Card data` entry, and its rows are where each price feed's own state is drawn.
 * - **`sync`** — *sync and pairing*, and *the supporter block*, which is that panel's second half.
 * - **`review`** — what sync asks of a reader, and the card reconciler's flags before any relay
 *   existed. Rows in a database a light install has too; it is `Sync`'s other panel for that.
 * - **`hidden-tags`** — the one undo for a tag hidden from the card surface, which the light
 *   edition draws with its tags (spec §4, Search). A hide with no way back would be a trap.
 * - **`theory-marks`** and **`labels`** — the light deck editor draws both marks (spec §4, Decks),
 *   so the place a reader recolours or deletes them comes with it.
 * - **`cache`** — *the image cache*, and with it the combo list's clear, the one optional feed
 *   that has no panel of its own.
 * - **`errors`** — the log is rows in the reader's own database, written by the same fetches on
 *   every host; a failed image is as much a fact on a phone as on a desk.
 * - **`danger`** — *the danger zone*, by name.
 *
 * And what is left out:
 *
 * - **`updates`** — the portable swap, a desktop feature (spec §4). A light install is updated
 *   by its store or by a deploy, neither of which this app drives.
 * - **`backup`** — the plain-text mirror, a desktop feature (spec §4): a folder of files the
 *   reader's own sync client picks up, which a browser and a phone do not have.
 * - **`data-folder`** — a path on disk and the image-write failures in it. A browser's storage
 *   has no path a reader can open, and a phone's is the app's own; a line that names one would
 *   name nothing the reader can act on.
 * - **`start-view`** — a light install opens where its URL says, and on Search when it says
 *   nothing (`LIGHT_START`). A stored start view is a question it does not ask.
 */
export const LIGHT_SETTINGS = [
  "prices",
  "sync",
  "review",
  "hidden-tags",
  "theory-marks",
  "labels",
  "cache",
  "errors",
  "danger",
] as const satisfies readonly PanelId[];

export type LightPanel = (typeof LIGHT_SETTINGS)[number];

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
 * (`apps/light/DesktopFace.tsx`) provides {@link LIGHT_EDITION}. A page never reads this — its
 * readers are the shell's rail, its caption and its chords, and Settings' entry list (spec §3.1
 * names that one, and only that one).
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
  /** The Settings panels drawn — Settings' entry list. `null` is every panel `nav.ts` holds, for
   *  `views`' reason: the full edition cannot fall behind a panel added to the page. */
  settings: readonly PanelId[] | null;
  /**
   * Whether this window can publish a share — the collection's **Share** and its publish
   * dialog. Read by the shell, which answers `usePublishes` (`lib/reach.ts`) from it.
   *
   * **False in the light edition because no light host has the commands.** The five `share_*`
   * commands are registered by the desktop host alone (`apps/desktop/src-tauri/src/desktop.rs`); the table
   * both light hosts dispatch through (`grimoire_core::commands`) has none of them, so a publish
   * there could only ever answer *"There is no command named share_create on this host."*
   * Opening somebody else's share is the other half, and `views` already leaves it out.
   */
  publishes: boolean;
}

export const FULL_EDITION: Edition = {
  id: "full",
  views: null,
  caption: true,
  startView: "home",
  settings: null,
  publishes: true,
};

export const LIGHT_EDITION: Edition = {
  id: "light",
  views: LIGHT_VIEWS,
  caption: false,
  startView: LIGHT_START,
  settings: LIGHT_SETTINGS,
  publishes: false,
};

export function editionHas(edition: Edition, view: ViewId): boolean {
  return edition.views === null || edition.views.includes(view);
}

/**
 * The edition, handed down once from the root; no provider at all is {@link FULL_EDITION}.
 *
 * **A provider must pass a module constant** — {@link FULL_EDITION} or {@link LIGHT_EDITION} —
 * **and never an object built during render**: the shell's key listener lists the edition as a
 * dependency, so an inline object would be a new one every render and rebind that listener
 * every render.
 */
export const EditionContext = createContext<Edition>(FULL_EDITION);

export function useEdition(): Edition {
  return useContext(EditionContext);
}
