/**
 * The three values `vite.sw.config.ts` substitutes at build time.
 *
 * Only `tsconfig.sw.json` includes this file. The app program must never see these names — a
 * component that reached for `__PRECACHE__` would compile and then be `undefined` in the shipped
 * window, because the app bundle is built by a config that does not define them.
 */
declare const __PRECACHE__: readonly string[];
declare const __BUILD_ID__: string;
/** The origin card art is fetched from, baked in so `sw.ts` and `cardImageUrl` cannot disagree. */
declare const __IMAGE_ORIGIN__: string;
