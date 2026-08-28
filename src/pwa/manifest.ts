/** One entry of the manifest's `icons` array. */
export interface ManifestIcon {
  src: string;
  /** `"512x512"`, or `"any"` for a vector. */
  sizes: string;
  type: string;
  purpose: "any" | "maskable";
}

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}

/** Where the plugin emits it, and therefore what `index.html` links to. Root-relative, so
 *  `scope: "/"` contains it. */
export const MANIFEST_PATH = "manifest.webmanifest";

/**
 * The app's identity to the browser.
 *
 * A function rather than a const so the test and the build read the same object without either
 * being able to mutate the other's.
 *
 * **`id` is `"/"` and it is not decoration.** It is the key the browser files an installed app
 * under; leaving it out makes `start_url` the id, so the day `start_url` gains a query string
 * every installed copy becomes a *second* app. Written down once, here.
 *
 * **`display: "standalone"`, not `"window-controls-overlay"`.** Spec §3's seam table has no
 * window-chrome row for web at all — the custom caption and the Win32 hit-test are desktop's,
 * and asking for an overlay would put the app's content under a title bar it does not draw.
 *
 * Both colours are `--color-bg` resolved to hex, which `logos/README.md` pins at `#0C0D12`.
 * The theme colour is what paints the browser's own bar around the app before a single pixel
 * of ours is drawn, so a mismatch here is a light flash on every cold start.
 */
export function manifestJson(): WebManifest {
  return {
    id: "/",
    name: "MTG Grimoire",
    short_name: "Grimoire",
    description: "Track a Magic: The Gathering collection — offline, on your own device.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0C0D12",
    theme_color: "#0C0D12",
    icons: [
      // The vector first: a browser that can rasterise it gets every size for 2.8 KB.
      { src: "/mtg-grimoire-mark.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/mark-256.png", sizes: "256x256", type: "image/png", purpose: "any" },
      { src: "/icons/mark-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Separate file, separate purpose. A single icon declared `"any maskable"` is drawn
      // full-frame *and* cropped to a circle, and one of those two is always wrong.
      { src: "/icons/maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
