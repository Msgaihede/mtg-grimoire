/**
 * The narrowest window each target promises to be usable in.
 *
 * **These are three different promises, and conflating them is the mistake this module exists
 * to prevent.** A good many files in this repo say "the app's 1024px floor" as though it were a
 * property of the app; it is a property of *one target*, enforced by `tauri.conf.json`'s
 * `minWidth`, and a browser tab and a phone honour nothing of the sort.
 *
 * They are **widths to look at, not breakpoints to branch on.** Where a control row folds is a
 * question about that row's own box — `FilterBar` answers it with `@container/fb` and
 * `DeckEditor` with a `ResizeObserver` over its desk — because the same component is drawn in a
 * 1500px bar and a 206px docked panel, and a viewport query answers about the wrong box. Nothing
 * in this app may grow a `sm:`/`md:`/`lg:` layout branch off these numbers without saying at its
 * own site why the *window* is the thing it is asking about.
 */

/** `src-tauri/tauri.conf.json`'s `minWidth`. Pinned against it by this module's test. */
export const DESKTOP_FLOOR_PX = 1024;

/** `src-tauri/tauri.conf.json`'s `minHeight`. */
export const DESKTOP_FLOOR_HEIGHT_PX = 700;

/**
 * The phone frame the design round is drawn in — a 390×844 CSS viewport, which is the iPhone
 * 12/13/14 and sits within a pixel or two of the common Android flagship in CSS pixels.
 *
 * **Chosen as a hard case rather than as a device.** It is narrow enough that
 * `CardGrid.columnsFor` floors at one column against today's 170px tile, which is the failure
 * the wall's round exists to answer.
 */
export const PHONE_PX = 390;

/** The same frame's height, before any browser chrome is taken off it. */
export const PHONE_HEIGHT_PX = 844;

/** The middle frame — a portrait tablet, where the deck editor's two columns become possible again. */
export const TABLET_PX = 768;
