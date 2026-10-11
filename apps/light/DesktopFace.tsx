import App from "@grimoire/ui/App";
import { EditionContext, LIGHT_EDITION } from "@grimoire/ui/lib/edition";
import { useDesktopPlace } from "./useDesktopPlace";

/**
 * The light app at 1024px and above: **the desktop UI itself**, in the light edition.
 *
 * Not a lookalike. These are the desktop's own pages, drawn at the widths they were designed and
 * measured for, with a rail of six rows and no window caption. The hook is called before `App`
 * renders so the store is on the URL's view by then.
 */
export default function DesktopFace() {
  useDesktopPlace();
  return (
    <EditionContext.Provider value={LIGHT_EDITION}>
      <App />
    </EditionContext.Provider>
  );
}
