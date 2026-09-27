/**
 * The smallest window the app promises to be usable in — the one promise this module carries.
 *
 * **It is enforced by `tauri.conf.json`, not by anything here.** The window's `minWidth` and
 * `minHeight` are what stop a reader dragging it smaller; these constants only quote them, so a
 * story or a test can be drawn at the floor without typing `1024` again. The quote is what can
 * rot, which is why this module's test reads the two numbers out of the file that enforces them.
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
