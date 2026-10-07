# Google Play C — what the store asks for: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Android app wears its own launcher icon, a privacy policy is served at `https://mtg-grimoire.app/privacy` and linked from Settings, and everything Play Console asks for is written down ready to paste.

**Architecture:** `scripts/light-icons.mjs` already renders the web icons from the one master mark; it grows the Android launcher set, the store's 512px icon and the feature graphic. The privacy policy is two static files in `mobile/public/`, which every light build copies to its root; the service worker learns that a place whose `.html` it precached is that file and not the app. Settings draws one link on both faces. The listing text and the Console's answers live in `docs/play/`.

**Tech Stack:** Node + headless Chromium over CDP (`light-icons.mjs`), static HTML/CSS under a strict CSP, the web host's service worker (`src/lib/core/web/sw/shell.ts`), React 19, Vitest, the web smoke run (`scripts/web-smoke.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-07-google-play-release-design.md` §6 (and §7 for where each piece is used). Read it before starting.

## Owner input this plan needs

| What | Used in | Until he says |
| --- | --- | --- |
| **A contact address** for privacy questions and deletion requests. It is published on the page and on the store listing | Task 2 Step 2, Task 5 | **Given 2026-10-07: `markus@seerup.com`.** It is on the page and in the listing below |
| **His approval of every sentence of the privacy policy** — it is his statement, and Task 2 drafts it from the code | Task 2 Step 2 | Task 2 does not go past Step 2 |
| **His approval of the listing text** | Task 5 | Nothing is pasted into the Console |

## Global Constraints

- **The privacy page runs no script and carries no inline style element.** The host's policy is `script-src 'self' 'wasm-unsafe-eval'; style-src 'self'`. One `<link rel="stylesheet" href="/privacy.css">`; no `<script>`, no `<style>`, no `style=""`.
- **The page states only what the code does.** Every host it names is one in `app-worker/_headers`' `connect-src` (plus `manapool.com`, which the Android host alone asks). A fence holds the two lists together.
- **No Patreon price, no "subscribe", no join link** on the page or in the listing. The page may say that a membership connected on another MTG Grimoire install stores a Patreon user id, because that is a fact about data; it does not say how to become a member.
- **The canonical address is `https://mtg-grimoire.app/privacy`.** The file is `privacy.html`.
- **The four committed web icons (`mobile/public/icons/*.png`) must not change.** A changed byte there is a new service-worker build that every web reader is offered. If a re-render moves them, restore them.
- **Launcher sizes:** legacy 48dp and adaptive layer 108dp, at mdpi ×1, hdpi ×1.5, xhdpi ×2, xxhdpi ×3, xxxhdpi ×4. The adaptive safe zone is a circle 66dp across: a radius of `33 / 108` of the width.
- **`gen/android` is hand-edited and committed.** Never run `tauri android init` or `tauri icon` over it: both rewrite it.
- **Nothing under `mobile/` asks which platform it runs on** (`mobile/phone/fence.test.ts`).
- **Design tokens:** dim text is `text-dim`; a control grows for a finger through `TOUCH_FLOOR`, never a raw pointer query.
- **No agent deploys.** The page goes live with the next release's web deploy, which is the owner merging the release PR.
- **One commit for this whole plan** (`feat(android): …`), in the last task. `npm run verify` once, in the last task; before that run only the single test file a step names.
- **This worktree needs `npm install` before any Vitest run** (the `worktree-setup` skill).

## Deviation from the spec

Spec §6 says the screenshots are "rendered from the phone face by a script". This plan has **the owner take them on a phone from the internal-testing install** (Task 5 lists which). Play requires screenshots to show the app as it is, with real card pictures; the scriptable sources are the Storybook fake, whose cards are fixtures, and a full first-run of the web app in a headless browser, which is a card download per render. The icon and the feature graphic are still rendered by script.

## Review Focus

1. **Someone who has the web app installed taps the privacy link.** Their browser's service worker owns every navigation on the origin; they must get the policy, not the app. → Task 2's `shell.test.ts` cases and the smoke run's eighteenth check.
2. **A reader offline** opens the policy from the installed web app. It is precached, so it should open. → the same `shell` route (cache first).
3. **A new host is added to the app's network policy** and nobody updates the privacy page. → Task 2's fence over `connect-src`.
4. **A launcher that masks icons to a circle or a squircle** must not clip the book's clasp or ribbon. → `light-icons.mjs` measures the foreground's furthest painted pixel against the 66dp circle and fails the render (Task 1).
5. **A `tauri android init` re-run** puts the stock Tauri icons and the stock Android vectors back. → Task 1's `host.test.ts` fence on sizes and on the stock files' absence.

Not covered by any test: **Cloudflare answering `/privacy` with `privacy.html`**. It is that host's default (`html_handling: auto-trailing-slash`) and no local server emulates it; Task 2 Step 9 measures it under `wrangler dev`, and `docs/play/README.md`'s order (Task 5) has the owner ask the live address after the deploy.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `scripts/light-icons.mjs` | modify | Also render the Android launcher set, the store icon and the feature graphic |
| `mobile/src-tauri/gen/android/app/src/main/res/mipmap-*/ic_launcher.png`, `…/ic_launcher_foreground.png` | regenerate | The mark, at each density |
| `…/res/mipmap-anydpi-v26/ic_launcher.xml` | create | The adaptive icon: ground behind, mark in front |
| `…/res/mipmap-*/ic_launcher_round.png`, `…/res/drawable/ic_launcher_background.xml`, `…/res/drawable-v24/ic_launcher_foreground.xml` | delete | Stock Tauri and stock Android art nothing references |
| `docs/play/listing-icon-512.png`, `docs/play/feature-graphic-1024x500.jpg` | create (rendered) | The two graphics the store asks for |
| `mobile/public/privacy.html`, `mobile/public/privacy.css` | create | The policy |
| `src/lib/core/web/sw/shell.ts` (+ `shell.test.ts`) | modify | A navigation to a place whose `.html` was precached is that file |
| `app-worker/src/hosting.test.ts`, `app-worker/README.md` | modify | The host's policy holds for the new files; the README's "no other HTML file" stops being true |
| `scripts/web-smoke.mjs` | modify | An eighteenth check: the policy opens as itself |
| `src/lib/externalLinks.ts` | modify | `PRIVACY_URL` |
| `src/features/settings/PrivacyLink.tsx` (+ test) | create | The one link, drawn by both settings pages |
| `src/features/settings/SettingsPage.tsx`, `mobile/phone/pages/SettingsPage.tsx` | modify | Draw it |
| `mobile/host.test.ts` | modify | Fences: launcher files; the page's shape and its hosts |
| `docs/play/README.md` | create | Listing text, the Console's answers, the screenshot list |
| `logos/README.md`, `mobile/CLAUDE.md`, `docs/reference/light-app.md` | modify | Say what is now true |

---

### Task 1: The launcher icon, the store icon and the feature graphic

**Files:**
- Modify: `scripts/light-icons.mjs`
- Regenerate: `mobile/src-tauri/gen/android/app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png` and `ic_launcher_foreground.png`
- Create: `mobile/src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`
- Delete: the five `ic_launcher_round.png`; `res/drawable/ic_launcher_background.xml`; `res/drawable-v24/ic_launcher_foreground.xml`
- Create (rendered): `docs/play/listing-icon-512.png`, `docs/play/feature-graphic-1024x500.jpg`
- Modify: `mobile/host.test.ts`, `logos/README.md`

**Interfaces:**
- Consumes: `logos/svg/mtg-grimoire-mark.svg` (a 64-unit mark with one `scale(...)`), `GROUND = "#0C0D12"`.
- Produces: `node scripts/light-icons.mjs` writes, besides the four web icons, ten launcher PNGs, the adaptive XML, and the two store graphics.

- [ ] **Step 1: Write the failing fence in `mobile/host.test.ts`**

Add near the other globs (module scope):

```ts
/** The launcher's pictures as data URLs — small files, and a PNG's size is in its first bytes. */
const launcherPngs = import.meta.glob(
  "./src-tauri/gen/android/app/src/main/res/mipmap-*/*.png",
  { query: "?inline", import: "default", eager: true },
) as Record<string, string>;
const launcherFiles = Object.keys(
  import.meta.glob("./src-tauri/gen/android/app/src/main/res/{mipmap,drawable}*/*"),
);
import adaptiveIcon from "./src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml?raw";

/** A PNG's width and height: big-endian, at bytes 16 and 20 of its header. */
function pngSize(dataUrl: string): { width: number; height: number } {
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) =>
    c.charCodeAt(0),
  );
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
```

(Move the `import adaptiveIcon …` line up among the file's other imports; it is shown here so the three belong together.)

Append a `describe`:

```ts
/**
 * **The launcher's icon is the app's own mark.** `tauri android init` writes Tauri's logo into
 * every `mipmap-*` and Android's stock robot into `drawable*`, and the app shipped to a phone
 * that way until 2026-10-07. `scripts/light-icons.mjs` renders these from the master mark and
 * they are committed; a regeneration puts the stock art back, and this is what goes red.
 */
describe("the Android launcher icon", () => {
  const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  const at = (density: string, file: string) =>
    launcherPngs[`./src-tauri/gen/android/app/src/main/res/mipmap-${density}/${file}`];

  it.each(Object.entries(DENSITIES))("is drawn at %s: 48dp, and a 108dp layer", (density, scale) => {
    expect(pngSize(at(density, "ic_launcher.png"))).toEqual({
      width: 48 * scale,
      height: 48 * scale,
    });
    expect(pngSize(at(density, "ic_launcher_foreground.png"))).toEqual({
      width: 108 * scale,
      height: 108 * scale,
    });
  });

  it("is adaptive: the app's ground behind, the mark in front", () => {
    expect(adaptiveIcon).toContain('<background android:drawable="@color/ground" />');
    expect(adaptiveIcon).toContain('<foreground android:drawable="@mipmap/ic_launcher_foreground" />');
    // The manifest asks for `@mipmap/ic_launcher`; on every phone this app installs on
    // (minSdk 26) that name is this file.
    expect(manifest).toMatch(/android:icon="@mipmap\/ic_launcher"/);
    expect(manifest).not.toMatch(/android:roundIcon/);
  });

  it("holds none of the stock art `tauri android init` leaves", () => {
    const names = launcherFiles.map((path) => path.slice(path.indexOf("/res/") + 5)).sort();
    expect(names).toEqual(
      [
        "mipmap-anydpi-v26/ic_launcher.xml",
        ...Object.keys(DENSITIES).flatMap((density) => [
          `mipmap-${density}/ic_launcher.png`,
          `mipmap-${density}/ic_launcher_foreground.png`,
        ]),
      ].sort(),
    );
  });

  it("is rendered inside the circle a launcher may cut it to", () => {
    // The script measures the pixels and fails the render; this holds the rule it measures by.
    expect(iconScript).toContain("const ADAPTIVE_SAFE_RADIUS = 33 / 108;");
    expect(iconScript).toMatch(/const ADAPTIVE_SCALE = 0\.\d+;/);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run mobile/host.test.ts -t "launcher icon"`

Expected: FAIL at import — `mipmap-anydpi-v26/ic_launcher.xml` does not exist.

- [ ] **Step 3: Teach `scripts/light-icons.mjs` the Android set**

Replace the header comment's last paragraph but one (the one beginning `// The renderer is a browser`) so its last sentence reads:

```js
// installed. It writes `mobile/public/icons/`, the Android launcher's `res/mipmap-*` under
// `mobile/src-tauri/gen/android`, and the store's two graphics under `docs/play/` — all
// committed; nothing runs this in a build.
```

and add after the two-drawings list in the header:

```js
//   - **the launcher's layers**, for Android's adaptive icon: the mark alone and transparent on
//     a 108dp square, smaller still, because a launcher keeps only a circle 66dp across; the
//     ground behind it is a colour the Android project already has (`@color/ground`). And the
//     48dp icon no phone this app installs on draws (minSdk 26), which is the maskable drawing.
//   - **the store's**: the maskable drawing at 512 for the listing's icon, and the mark on the
//     ground at 1024×500 for its feature graphic — a JPEG, because Play takes no alpha there.
```

Replace the constants from `const MARK =` down to and including the `ICONS` array with:

```js
const MARK = resolve("logos/svg/mtg-grimoire-mark.svg");
const OUT = resolve("mobile/public/icons");
const ANDROID_RES = resolve("mobile/src-tauri/gen/android/app/src/main/res");
const PLAY = resolve("docs/play");

/**
 * `--color-bg` in sRGB — `logos/README.md`'s field, and the manifest's two colours.
 * `mobile/host.test.ts` holds this line equal to the manifest's `background_color`, so a ground
 * that moves there goes red until it moves here — which is the reminder to render again.
 */
const GROUND = "#0C0D12";

/**
 * The mark's scale on the maskable icon, against 0.92 on the transparent one.
 *
 * The art's furthest point from the book's centre is a corner of the back board, 34.4 units out
 * on the 64-unit grid, plus half a stroke: about 35.3. The safe zone's radius is 40% of the
 * width, 25.6 units — so anything up to 0.725 fits, and 0.70 leaves a little air. `measure` below
 * checks the pixels rather than this arithmetic.
 */
const MASKABLE_SCALE = 0.7;
/** The share of the icon's width, from its centre, a maskable icon may count on keeping. */
const SAFE_RADIUS = 0.4;

/**
 * The mark's scale on the Android launcher's foreground layer.
 *
 * An adaptive icon's layer is 108dp square and a launcher shows a 72dp window of it, cut to its
 * own shape; only a circle 66dp across is promised whole. That is a radius of 33/108 of the
 * width — 30.6%, against the maskable icon's 40% — so the mark is drawn smaller again: 0.70
 * reaches 37.5% (measured), and 0.55 is that in proportion with a little air. `measure` checks
 * the pixels.
 */
const ADAPTIVE_SCALE = 0.55;
const ADAPTIVE_SAFE_RADIUS = 33 / 108;

/** Android's densities, as multiples of a dp. */
const DENSITIES = [
  { name: "mdpi", scale: 1 },
  { name: "hdpi", scale: 1.5 },
  { name: "xhdpi", scale: 2 },
  { name: "xxhdpi", scale: 3 },
  { name: "xxxhdpi", scale: 4 },
];

/**
 * Every picture this writes. `kind` is the drawing: `plain` (the mark, transparent),
 * `maskable` (smaller, on the ground to every edge), `adaptive` (smaller still, transparent)
 * and `feature` (the store's banner). A square one names a `size`; the banner its two sides.
 */
const ICONS = [
  { dir: OUT, file: "icon-192.png", size: 192, kind: "plain" },
  { dir: OUT, file: "icon-512.png", size: 512, kind: "plain" },
  { dir: OUT, file: "maskable-192.png", size: 192, kind: "maskable" },
  { dir: OUT, file: "maskable-512.png", size: 512, kind: "maskable" },
  ...DENSITIES.flatMap(({ name, scale }) => [
    {
      dir: join(ANDROID_RES, `mipmap-${name}`),
      file: "ic_launcher.png",
      size: 48 * scale,
      kind: "maskable",
    },
    {
      dir: join(ANDROID_RES, `mipmap-${name}`),
      file: "ic_launcher_foreground.png",
      size: 108 * scale,
      kind: "adaptive",
    },
  ]),
  { dir: PLAY, file: "listing-icon-512.png", size: 512, kind: "maskable" },
  { dir: PLAY, file: "feature-graphic-1024x500.jpg", width: 1024, height: 500, kind: "feature" },
];

/**
 * The adaptive icon itself: two layers by name. Written here rather than by hand so the set is
 * one command; `mobile/host.test.ts` holds its two lines.
 */
const ADAPTIVE_XML = `<?xml version="1.0" encoding="utf-8"?>
<!--
  WRITTEN BY scripts/light-icons.mjs — the launcher's icon on every phone this app installs on
  (minSdk 26). The ground is the app's own (\`values/colors.xml\`); the mark is rendered from
  \`logos/svg/mtg-grimoire-mark.svg\` inside the 66dp circle a launcher keeps whole.
  \`tauri android init\` does not write this file and overwrites the pictures beside it:
  \`mobile/host.test.ts\` holds both.
-->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ground" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
```

Replace `drawing` with:

```js
/** The master mark as the drawing an icon wants: sized, scaled, and for a maskable one, grounded. */
function drawing(master, size, kind) {
  let svg = master.replace(/width="64" height="64"/, `width="${size}" height="${size}"`);
  if (kind === "plain") return svg;
  if (kind === "adaptive") return svg.replace(/scale\([\d.]+\)/, `scale(${ADAPTIVE_SCALE})`);
  svg = svg.replace(/scale\([\d.]+\)/, `scale(${MASKABLE_SCALE})`);
  return svg.replace("</defs>", `</defs><rect width="64" height="64" fill="${GROUND}"></rect>`);
}

/** The page a square icon is photographed on: the drawing and nothing else. */
function iconPage(master, size, kind) {
  return (
    `<!doctype html><html><body style="margin:0;overflow:hidden">` +
    drawing(master, size, kind).replace("<svg ", `<svg style="display:block" `) +
    `</body></html>`
  );
}

/** The store's banner: the mark alone on the ground, two thirds of the height, centred. */
function featurePage(master, width, height) {
  const mark = drawing(master, Math.round((height * 2) / 3), "plain").replace(
    "<svg ",
    `<svg style="display:block" `,
  );
  return (
    `<!doctype html><html><body style="margin:0;overflow:hidden;width:${width}px;` +
    `height:${height}px;background:${GROUND};display:flex;align-items:center;` +
    `justify-content:center">${mark}</body></html>`
  );
}
```

In `main`, replace everything from the comment `// The safe zone, measured on the mark alone` to the end of the `for (const { file, size, maskable } of ICONS)` loop with:

```js
  // The safe zones, measured on the mark alone — a ground reaches every edge by design.
  const zones = [
    { kind: "maskable", safe: SAFE_RADIUS, knob: "MASKABLE_SCALE", what: "the maskable mark" },
    {
      kind: "adaptive",
      safe: ADAPTIVE_SAFE_RADIUS,
      knob: "ADAPTIVE_SCALE",
      what: "the launcher's foreground",
    },
  ];
  for (const { kind, safe, knob, what } of zones) {
    const alone = drawing(master, 512, kind).replace(/<rect width="64"[^>]*><\/rect>/, "");
    const { result } = await page("Runtime.evaluate", {
      expression: measure(alone, 512),
      awaitPromise: true,
      returnByValue: true,
    });
    const reach = result.value;
    if (!(reach > 0.2 && reach <= safe)) {
      throw new Error(
        `${what} reaches ${(reach * 100).toFixed(1)}% of the width from the centre; ` +
          `the safe zone is ${(safe * 100).toFixed(1)}%. Lower ${knob}.`,
      );
    }
    console.log(
      `ok  ${what} reaches ${(reach * 100).toFixed(1)}% — inside the ${(safe * 100).toFixed(1)}% circle`,
    );
  }

  for (const icon of ICONS) {
    const { dir, file, kind } = icon;
    const width = icon.width ?? icon.size;
    const height = icon.height ?? icon.size;
    await mkdir(dir, { recursive: true });
    await page("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const html =
      kind === "feature" ? featurePage(master, width, height) : iconPage(master, width, kind);
    await page("Page.navigate", {
      url: `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
    });
    // Poll for the drawing rather than trusting a load event that may have fired already.
    for (let tries = 0; ; tries++) {
      const drawn = await page("Runtime.evaluate", {
        expression: `document.readyState === "complete" && !!document.querySelector("svg")`,
        returnByValue: true,
      });
      if (drawn.result.value === true) break;
      if (tries > 100) throw new Error(`${file}: the drawing never loaded`);
      await pause(50);
    }
    // A JPEG where the store takes no alpha; a PNG everywhere else, so a transparent mark stays so.
    const jpeg = file.endsWith(".jpg");
    const shot = await page("Page.captureScreenshot", {
      format: jpeg ? "jpeg" : "png",
      ...(jpeg ? { quality: 92 } : {}),
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    await writeFile(join(dir, file), Buffer.from(shot.data, "base64"));
    console.log(`ok  ${file} — ${width}×${height}, ${kind}`);
  }

  await mkdir(join(ANDROID_RES, "mipmap-anydpi-v26"), { recursive: true });
  await writeFile(join(ANDROID_RES, "mipmap-anydpi-v26", "ic_launcher.xml"), ADAPTIVE_XML);
  console.log("ok  mipmap-anydpi-v26/ic_launcher.xml — the adaptive icon");
```

Remove the line `await mkdir(OUT, { recursive: true });` near the top of `main`: the loop makes each directory.

- [ ] **Step 4: Render, and restore what must not move**

Run, from the repository root: `node scripts/light-icons.mjs`

Expected: two `ok  … reaches …% — inside the …% circle` lines (the maskable mark near 37.5%, the launcher's foreground under 30.6%), sixteen `ok  <file>` lines, and the adaptive-icon line. If the foreground line fails, lower `ADAPTIVE_SCALE` by 0.01 and render again; put the measured figure in Step 7's README line.

Then:

```bash
git status --short mobile/public/icons
```

Expected: nothing. If any of the four web icons shows as modified — a different Chromium encodes a PNG differently — restore them: `git checkout -- mobile/public/icons`. They did not need to change.

- [ ] **Step 5: Delete the stock art**

First confirm nothing names it:

```bash
git grep -n "ic_launcher_round\|ic_launcher_background\|drawable/ic_launcher\|drawable-v24" -- mobile/src-tauri ':!mobile/src-tauri/gen/android/app/src/main/res'
```

Expected: no output. Then:

```bash
git rm mobile/src-tauri/gen/android/app/src/main/res/mipmap-*/ic_launcher_round.png
git rm mobile/src-tauri/gen/android/app/src/main/res/drawable/ic_launcher_background.xml
git rm mobile/src-tauri/gen/android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml
```

- [ ] **Step 6: Look at what was drawn**

Open `mobile/src-tauri/gen/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png`, `docs/play/listing-icon-512.png` and `docs/play/feature-graphic-1024x500.jpg` (the Read tool shows images). Confirm: each is the grimoire book in gold, whole, with its clasp and ribbon; the foreground is transparent round it; the banner has the mark centred on the dark ground with nothing clipped. A picture that is not that is a defect whatever the test says.

- [ ] **Step 7: `logos/README.md`**

After the paragraph that records the maskable mark's measured reach, add:

```markdown
The same script renders the **Android launcher's** set from this mark
(`mobile/src-tauri/gen/android/app/src/main/res/mipmap-*`): an adaptive icon whose foreground
is the mark at scale 0.55 on a transparent 108dp layer, over the app's ground. A launcher keeps
only a circle 66dp across — 30.6% of the width from the centre — and the script measures the
foreground's furthest painted pixel against it and fails the render if it passes. It also
writes the store's two graphics to `docs/play/`. `tauri android init` and `tauri icon` both
overwrite the launcher's pictures with stock art; `mobile/host.test.ts` goes red when they do.
```

- [ ] **Step 8: Run the fence**

Run: `npx vitest run mobile/host.test.ts`

Expected: PASS.

---

### Task 2: The privacy policy

**Files:**
- Create: `mobile/public/privacy.html`, `mobile/public/privacy.css`
- Modify: `src/lib/core/web/sw/shell.ts` (`routeFor`), `src/lib/core/web/sw/shell.test.ts`
- Modify: `app-worker/src/hosting.test.ts` (the `UNHASHED` sample), `app-worker/README.md`
- Modify: `scripts/web-smoke.mjs`
- Modify: `mobile/host.test.ts`

**Interfaces:**
- Consumes: `app-worker/_headers`' `connect-src` line.
- Produces: `/privacy.html` and `/privacy.css` at the root of every light build; on the host, `/privacy`.

- [ ] **Step 1: Write `mobile/public/privacy.css`**

```css
/* The privacy policy's own sheet. The page is a document, not the app: it loads no script and
   none of the app's styles, so it reads the same with either missing. The host's policy is
   `style-src 'self'`, which is why this is a file and not a <style> in the page. The two
   colours are the app's ground and its gold (`mobile/public/light.webmanifest`,
   `logos/svg/mtg-grimoire-mark.svg`). */
:root {
  color-scheme: dark;
}
html {
  background: #0c0d12;
  color: #d9dae0;
  font:
    16px/1.6 system-ui,
    -apple-system,
    "Segoe UI",
    Roboto,
    sans-serif;
}
body {
  margin: 0 auto;
  max-width: 44rem;
  padding: 2rem 1.25rem 4rem;
}
header {
  align-items: center;
  display: flex;
  gap: 0.75rem;
}
header img {
  height: 2.5rem;
  width: 2.5rem;
}
h1 {
  font-size: 1.6rem;
  line-height: 1.25;
  margin: 0;
}
h2 {
  border-top: 1px solid #23252e;
  font-size: 1.15rem;
  margin: 2.25rem 0 0.5rem;
  padding-top: 1.5rem;
}
p,
ul {
  margin: 0.75rem 0;
}
ul {
  padding-left: 1.25rem;
}
li {
  margin: 0.35rem 0;
}
a {
  color: #d1a84b;
}
.dated {
  color: #9a9cab;
  font-size: 0.9rem;
}
.hosts {
  border-collapse: collapse;
  font-size: 0.95rem;
  width: 100%;
}
.hosts th,
.hosts td {
  border-bottom: 1px solid #23252e;
  padding: 0.5rem 0.75rem 0.5rem 0;
  text-align: left;
  vertical-align: top;
}
.hosts td:first-child {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 2: Draft `mobile/public/privacy.html`, and stop for the owner**

Every claim below was read from the code on 2026-10-07 (the relay's schema and routes, `app-worker/_headers`, the engine's request code). **This is the owner's statement.** Write the file, then show it to him and do nothing further in this task until he has approved or corrected every sentence. The contact address is the one he gave on 2026-10-07.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Privacy policy — MTG Grimoire</title>
    <meta name="description" content="What MTG Grimoire keeps on your device, what it asks other services for, and what its sync relay stores." />
    <link rel="icon" type="image/svg+xml" href="/mtg-grimoire-mark.svg" />
    <link rel="stylesheet" href="/privacy.css" />
  </head>
  <body>
    <header>
      <img src="/mtg-grimoire-mark.svg" alt="" />
      <h1>MTG Grimoire privacy policy</h1>
    </header>
    <p class="dated">Effective 7 October 2026. This covers the MTG Grimoire apps for Android, for the web at mtg-grimoire.app, and for Windows and Linux.</p>

    <p>MTG Grimoire is made by Markus Seerup. It is a tool for keeping track of a Magic: The Gathering collection. It has no accounts, shows no advertising, and contains no analytics, tracking or crash-reporting code.</p>

    <h2>What stays on your device</h2>
    <p>Everything you make in the app is stored on your own device, in the app's private storage: your collection, decks, wishlist, notes, labels and settings. So are the card database, the card pictures the app has shown you, and a log of errors the app ran into. The app does not send any of this to its maker.</p>
    <p>On Android the app is excluded from Google's device backup, so your collection is not copied to your Google account. In a browser, the same data is kept in that browser's storage for mtg-grimoire.app.</p>

    <h2>What the app asks other services for</h2>
    <p>The app downloads card data, card pictures and prices from the services below, directly from your device. Each of them sees your IP address and the request itself, as any website you visit does, and may log it under its own policy. The Android and desktop apps identify themselves as <code>MTGGrimoire</code> with their version number; in a browser, your browser identifies itself as it always does. None of these requests contains your collection, your decks or anything that identifies you to MTG Grimoire.</p>
    <table class="hosts">
      <thead>
        <tr><th>Address</th><th>What is asked for</th></tr>
      </thead>
      <tbody>
        <tr><td>api.scryfall.com</td><td>Where the current card files are, from Scryfall</td></tr>
        <tr><td>data.scryfall.io</td><td>The card database itself</td></tr>
        <tr><td>cards.scryfall.io</td><td>Card pictures, one at a time as they are shown</td></tr>
        <tr><td>json.commanderspellbook.com</td><td>The list of card combos, if you turn that on</td></tr>
        <tr><td>api.cardkingdom.com</td><td>Card Kingdom's price list, if you choose it</td></tr>
        <tr><td>manapool.com</td><td>Mana Pool's price list, if you choose it (Android and desktop only)</td></tr>
        <tr><td>mtg-grimoire-relay.denmark-east.workers.dev</td><td>Sync between your devices, described below — only once a device is in a sync group</td></tr>
      </tbody>
    </table>
    <p>The desktop apps also ask GitHub (api.github.com) whether a newer version exists. The Android app and the web app do not.</p>

    <h2>The camera</h2>
    <p>The app asks for the camera the first time you use it to scan a pairing code or, where the app offers it, a card. Pictures from the camera are examined on your device and are not stored and not sent anywhere.</p>

    <h2>Sync between your devices</h2>
    <p>Sync is optional. If you pair two or more installs of MTG Grimoire, they exchange changes through a relay server that MTG Grimoire runs on Cloudflare.</p>
    <p>Changes are encrypted on your device with a key that only your paired devices hold. The relay cannot read them, and neither can its maker. Beside each encrypted change the relay stores what it needs to deliver it:</p>
    <ul>
      <li>a random identifier for the device that sent it and one for your group of devices — neither is your name, your phone's name or an advertising identifier;</li>
      <li>the time the change was made and the time it arrived;</li>
      <li>for each device in the group, when the relay first and last heard from it;</li>
      <li>your group's sync key, sealed so that only your devices can open it.</li>
    </ul>
    <p>The relay does not store device names, e-mail addresses or IP addresses. Your IP address is used while a request is being answered, to limit how often one address may ask, and Cloudflare, which hosts the relay, may log requests under its own policy.</p>
    <p>A change is deleted from the relay once every device in the group has received it and it is 30 days old. A device the relay has not heard from in 90 days is dropped from its records. The short-lived data used while two devices pair is deleted within the hour.</p>

    <h2>If sync is paid for with a Patreon membership</h2>
    <p>Sync is funded by a Patreon membership, which is connected from the desktop or web version of MTG Grimoire and never from the Android app. If you connect one, the relay asks Patreon whether the membership is active and stores: your Patreon user identifier, whether the membership is active, a token that lets the relay ask Patreon again later, and which group of devices the membership covers. It does not ask Patreon for, or store, your name, your e-mail address or anything about your payments. This record is kept after a membership ends, until you ask for it to be deleted.</p>

    <h2>Sharing a collection</h2>
    <p>The desktop app can publish a read-only snapshot of a collection folder to a link. A published snapshot is stored on Cloudflare, readable by anyone who has the link, and contains the title and name you typed, the cards and their values. It never contains purchase prices, dates or private notes. It stays until you withdraw it from the app. The Android app and the web app cannot publish.</p>

    <h2>Removing your data</h2>
    <ul>
      <li>Everything on a device is removed by uninstalling the app, or by clearing the site's data in a browser. Settings also has a reset.</li>
      <li>A device leaves a sync group from Settings, under Sync; any device in the group can remove another. Removing a device stops it receiving anything new.</li>
      <li>To have a group's records, a membership's record or a shared snapshot deleted from the relay, ask at the address below.</li>
    </ul>

    <h2>Children</h2>
    <p>MTG Grimoire is not directed at children under 13 and does not knowingly collect personal information from anyone.</p>

    <h2>Changes to this policy</h2>
    <p>If this policy changes, the new text is published here with a new date.</p>

    <h2>Contact</h2>
    <p>Questions and deletion requests: <a href="mailto:markus@seerup.com">markus@seerup.com</a>. The app's source and its issue tracker are at <a href="https://github.com/Msgaihede/mtg-grimoire">github.com/Msgaihede/mtg-grimoire</a>.</p>

    <p class="dated">MTG Grimoire is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC. Card data and pictures are provided by Scryfall.</p>
  </body>
</html>
```

Four sentences the owner should weigh hardest, because the code supports them only as far as stated:

| Sentence | What the code shows | The doubt |
| --- | --- | --- |
| "contains no analytics, tracking or crash-reporting code" | No such dependency or request in `mobile/`, `crates/`, `src/` | None found; it is an absolute, so it is his to make |
| "Cloudflare … may log requests under its own policy" | All three Workers set `observability: { enabled: true }` | What Cloudflare's logs keep is not in the repository. Request paths contain the group identifier |
| "The short-lived data used while two devices pair is deleted within the hour" | `pairing_rendezvous` has a 10-minute life and an hourly sweep; an unused claim code is never swept | Claim codes are a membership's, not a pairing's, and hold no personal data — but "within the hour" is about pairing only |
| "This record is kept after a membership ends" | `relay/schema.sql`: "Nothing deletes a lapsed subject" | True, and worth his knowing before he publishes it |

- [ ] **Step 3: Write the failing page fence in `mobile/host.test.ts`**

Add the imports:

```ts
import privacyPage from "./public/privacy.html?raw";
import privacySheet from "./public/privacy.css?raw";
import hostHeaders from "../app-worker/_headers?raw";
```

Append:

```ts
/**
 * **The privacy policy** — `https://mtg-grimoire.app/privacy`, which Google Play's listing and
 * the app's Settings both link to. A document, not the app: it must read under the host's
 * policy with no script at all, and it must not fall behind the list of hosts the app asks.
 */
describe("the privacy policy's page", () => {
  it("runs no script and carries no style of its own", () => {
    // `script-src 'self' 'wasm-unsafe-eval'; style-src 'self'` — and a policy that needs
    // neither cannot be broken by either.
    expect(privacyPage).not.toMatch(/<script\b/i);
    expect(privacyPage).not.toMatch(/<style\b/i);
    expect(privacyPage).not.toMatch(/\sstyle=/i);
    expect(privacyPage).not.toMatch(/\son[a-z]+=/i);
    expect(privacyPage).toContain('<link rel="stylesheet" href="/privacy.css" />');
    expect(privacySheet).not.toMatch(/@import|url\(/);
  });

  it("is a whole document with one heading", () => {
    expect(privacyPage).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(privacyPage.match(/<h1>/g)).toHaveLength(1);
    expect(privacyPage).toMatch(/<h1>MTG Grimoire privacy policy<\/h1>/);
    expect(privacyPage).toMatch(/Effective \d{1,2} [A-Z][a-z]+ 20\d\d\./);
  });

  it("names every host the app's own policy lets it ask", () => {
    // The web host's `connect-src` is the engine's list of hosts, held to the engine's
    // constants by `app-worker/src/hosting.test.ts`. A host added there is a host this page
    // owes a line.
    const policy = /Content-Security-Policy:.*connect-src ([^;]+);/.exec(hostHeaders)?.[1] ?? "";
    const hosts = [...new Set([...policy.matchAll(/(?:https|wss):\/\/([a-z0-9.-]+)/g)].map((m) => m[1]))];
    expect(hosts.length).toBeGreaterThanOrEqual(6);
    for (const host of hosts) expect(privacyPage, host).toContain(`<td>${host}</td>`);
    // And the one the Android host asks that a browser may not.
    expect(privacyPage).toContain("<td>manapool.com</td>");
  });

  it("offers nothing to pay for", () => {
    // It says what a membership stores; it never says how to get one.
    expect(privacyPage).not.toMatch(/patreon\.com|\$\s?\d|€\s?\d|per month|subscribe|join now|become a/i);
  });
});
```

- [ ] **Step 4: Run it**

Run: `npx vitest run mobile/host.test.ts -t "privacy policy"`

Expected: PASS once Steps 1 and 2 are written (it fails at import before them). If *names every host* fails, the page's table is missing a host the policy allows: add its row.

- [ ] **Step 5: The service worker — write the failing route tests**

In `src/lib/core/web/sw/shell.test.ts`, add `"/privacy.html"` to the fixture set:

```ts
const PRECACHED = new Set(["/", "/light.webmanifest", "/assets/index-abc.js", "/privacy.html"]);
```

and add inside `describe("which request is whose", …)`:

```ts
  /**
   * **A document of its own, at an address with no extension.** The host serves
   * `privacy.html` at `/privacy`; a reader with the web app installed reaches that address
   * through this worker, which answers every extensionless navigation with the app. So a place
   * whose `.html` is in this build is that file — from the cache, offline too.
   */
  it("answers a place that is a page of the build's own with that page, not the app", () => {
    expect(route(get("/privacy", "navigate"))).toEqual({ kind: "shell", key: "/privacy.html" });
    // By its file name it was always the file.
    expect(route(get("/privacy.html", "navigate"))).toEqual({ kind: "shell", key: "/privacy.html" });
    // A query string is the address's, not the file's.
    expect(route(get("/privacy?from=settings", "navigate"))).toEqual({
      kind: "shell",
      key: "/privacy.html",
    });
    // Only a navigation: a script that fetches the bare path is asking the network.
    expect(route(get("/privacy", "cors"))).toEqual({ kind: "passthrough" });
    // And only a page this build has. Every other place is still the app.
    expect(route(get("/privacy/more", "navigate"))).toEqual({ kind: "navigation" });
    expect(route(get("/terms", "navigate"))).toEqual({ kind: "navigation" });
    // The root is the document, and `/.html` is nobody's.
    expect(route(get("/", "navigate"))).toEqual({ kind: "navigation" });
  });
```

Run: `npx vitest run src/lib/core/web/sw/shell.test.ts -t "page of the build's own"`

Expected: FAIL — `/privacy` answers `{ kind: "navigation" }`.

- [ ] **Step 6: The service worker — the route**

In `src/lib/core/web/sw/shell.ts`, in `routeFor`, replace

```ts
  if (request.mode === "navigate" && place) return { kind: "navigation" };
```

with

```ts
  if (request.mode === "navigate" && place) {
    // **A page of the build's own, at an address with no extension** — the privacy policy,
    // `privacy.html`, which the host serves at `/privacy`. Without this the reader who has the
    // app installed would be the one reader who could not open it: this worker answers every
    // extensionless navigation with the app. Asked of the precache and not of a list here, so
    // the rule is the build's: a page that is in it is served, and nothing else changes.
    const page = `${path}.html`;
    if (path !== "/" && precached.has(page)) return { kind: "shell", key: page };
    return { kind: "navigation" };
  }
```

and add to the function's doc comment, as its last paragraph:

```ts
 * **One navigation is not the app: a place whose `.html` this build precached.** It is a
 * document of the build's own — the privacy policy — and is answered from the shell by that
 * file's name.
```

Run: `npx vitest run src/lib/core/web/sw/shell.test.ts`

Expected: PASS, the new case and every existing one — `/`, `/search`, `/decks/12`, `/collection?card=abc` and `/v1.2/notes` are all still `navigation`.

- [ ] **Step 7: The host's policy covers the new files**

In `app-worker/src/hosting.test.ts`, add to `UNHASHED`:

```ts
const UNHASHED = [
  "/light.webmanifest",
  "/mtg-grimoire-mark.svg",
  "/icons/icon-192.png",
  "/icons/maskable-512.png",
  // The privacy policy: a document and its sheet, under the one policy like everything else.
  "/privacy",
  "/privacy.html",
  "/privacy.css",
];
```

In `app-worker/README.md`, replace

```markdown
`html_handling` is left at its default, `auto-trailing-slash`: `/index.html` redirects to `/`, and
nothing in the build is another HTML file.
```

with

```markdown
`html_handling` is left at its default, `auto-trailing-slash`: `/index.html` redirects to `/`.
**One other HTML file is in the build since 2026-10-07: `privacy.html`**, the privacy policy
(`mobile/public/`), which that default serves at `/privacy` and redirects `/privacy.html` to.
A reader the service worker controls never reaches the host for it: the worker answers
`/privacy` with the precached file (`sw/shell.ts`, `routeFor`).
```

Run: `npx vitest run app-worker/src/hosting.test.ts`

Expected: PASS — only the `/*` rule matches the three, so each carries the policy, `nosniff`, the referrer policy and `no-cache`.

- [ ] **Step 8: The smoke run's eighteenth check**

In `scripts/web-smoke.mjs`, in the header comment, change `asks seventeen things` to `asks eighteen things`, and insert between items 14 and 15 a new item, renumbering 15–17 to 16–18 (and `the seventeenth check's card file` further down to `the eighteenth check's`):

```js
//  15. the privacy policy opens as itself — `/privacy`, in a tab the service worker controls,
//      is the document with its one heading and not the app, and loaded under the host's
//      policy with nothing refused;
```

Directly after the line `console.log("ok  a second tab was told, and offered a reload");` insert:

```js
  // The privacy policy, at the address the store listing and Settings link to. This tab is one
  // the worker controls, which is the reader it has to work for: the worker answers every
  // other extensionless navigation with the app.
  const privacy = await openPage(browser, `${origin}/privacy`, hosts.check, policy);
  const heading = await privacy.until(
    "the privacy policy drew",
    `document.querySelector("h1")?.innerText ?? null`,
  );
  if (heading !== "MTG Grimoire privacy policy") fail(`/privacy drew the heading:\n${heading}`);
  const shape = await privacy.evaluate(
    `({
      app: !!document.querySelector("#root"),
      scripts: document.scripts.length,
      sheet: [...document.styleSheets].some((sheet) => sheet.href?.endsWith("/privacy.css")),
      ground: getComputedStyle(document.documentElement).backgroundColor,
    })`,
  );
  if (shape.app || shape.scripts !== 0) fail(`/privacy is not a plain document: ${JSON.stringify(shape)}`);
  if (!shape.sheet || shape.ground !== "rgb(12, 13, 18)") {
    fail(`/privacy drew without its stylesheet: ${JSON.stringify(shape)}`);
  }
  console.log("ok  /privacy is the policy — one heading, its own sheet, no script, not the app");
```

`rgb(12, 13, 18)` is `#0c0d12`, the sheet's ground: a page whose stylesheet the policy refused would be white.

Then build and run it (this needs the wasm toolchain the `web` job uses; if this machine cannot build the module, say so in the pull request and let CI's `web` job be the run):

Run: `npm run web:wasm && npm run web:build && npm run web:smoke`

Expected: every existing `ok` line, plus `ok  /privacy is the policy — …`, and exit 0. If `openPage` waits for something only the app has, read its source in `scripts/web-smoke/harness.mjs` and open the tab the way the run's other non-app probes do; the four assertions are what matter.

- [ ] **Step 9: Measure what Cloudflare does with `/privacy`, locally**

No local server here emulates the host's `html_handling`, and the listing's address depends on it. `wrangler dev --local` runs the Worker and its assets under workerd on this machine; it deploys nothing.

```bash
npm ci --ignore-scripts --prefix app-worker
( cd app-worker && npx --no-install wrangler dev --local --port 8799 ) &
sleep 8
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H "Sec-Fetch-Mode: navigate" -H "Accept: text/html" http://localhost:8799/privacy
curl -s -H "Accept: text/html" http://localhost:8799/privacy | grep -c "<h1>MTG Grimoire privacy policy</h1>"
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:8799/privacy.html
kill %1
```

(`dist-web/` must exist from Step 8. Under PowerShell, start `wrangler dev` in its own terminal tab instead of `&`, and stop it by hand.)

Expected: `200 text/html; charset=utf-8`, then `1`, then `307 http://localhost:8799/privacy`.

**If the first is the app** (the count is `0`): the host does not map the address. Then the canonical address is `/privacy.html` — change `PRIVACY_URL` in Task 3 and the address in Task 5 to `https://mtg-grimoire.app/privacy.html`, and say so in the pull request and in the section Task 6 adds to `docs/reference/light-app.md`. Record whichever was measured there.

---

### Task 3: The link in Settings

**Files:**
- Modify: `src/lib/externalLinks.ts`
- Create: `src/features/settings/PrivacyLink.tsx`
- Test: `src/features/settings/PrivacyLink.test.tsx`
- Modify: `src/features/settings/SettingsPage.tsx`, `mobile/phone/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `openExternal(url: string): Promise<void>` from `@/lib/externalLinks`; `TOUCH_FLOOR` from `src/features/settings/controls`; `FOCUS` from `@/lib/focus`; `cn` from `@/lib/utils`.
- Produces: `export const PRIVACY_URL = "https://mtg-grimoire.app/privacy"`; `export function PrivacyLink(): JSX.Element`.

- [ ] **Step 1: Write the failing test**

`src/features/settings/PrivacyLink.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openExternal = vi.hoisted(() => vi.fn());
vi.mock("@/lib/externalLinks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/externalLinks")>()),
  openExternal,
}));

import { PRIVACY_URL } from "@/lib/externalLinks";
import { PrivacyLink } from "./PrivacyLink";

beforeEach(() => {
  openExternal.mockReset().mockResolvedValue(undefined);
});

describe("PrivacyLink", () => {
  it("is a link to the policy's own address", () => {
    render(<PrivacyLink />);
    const link = screen.getByRole("link", { name: "Privacy policy" });
    // A real address on a real anchor: a middle click, a long press and a screen reader all
    // get the destination, on a host where the press below is never needed.
    expect(link).toHaveAttribute("href", PRIVACY_URL);
    expect(PRIVACY_URL).toBe("https://mtg-grimoire.app/privacy");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("leaves the app through the host, once, on a press", async () => {
    const user = userEvent.setup();
    render(<PrivacyLink />);
    await user.click(screen.getByRole("link", { name: "Privacy policy" }));
    // The host's way out, and not the anchor's own: a desktop webview does not follow
    // `target="_blank"`, and a browser following it as well would open two tabs.
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(PRIVACY_URL);
  });

  it("is large enough for a finger", () => {
    render(<PrivacyLink />);
    const link = screen.getByRole("link", { name: "Privacy policy" });
    expect(link.className).toContain("coarse:");
  });
});
```

Run: `npx vitest run src/features/settings/PrivacyLink.test.tsx`

Expected: FAIL — `./PrivacyLink` does not exist.

- [ ] **Step 2: The address**

In `src/lib/externalLinks.ts`, add above `openExternal`:

```ts
/**
 * The privacy policy — one page for every host, served by the web app's own origin
 * (`mobile/public/privacy.html`). Google Play requires the link on the store listing and in the
 * app; `docs/play/README.md` holds the listing to this address.
 */
export const PRIVACY_URL = "https://mtg-grimoire.app/privacy";
```

- [ ] **Step 3: The component**

`src/features/settings/PrivacyLink.tsx`:

```tsx
import type { JSX, MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { PRIVACY_URL, openExternal } from "@/lib/externalLinks";
import { FOCUS } from "@/lib/focus";
import { TOUCH_FLOOR } from "./controls";

/**
 * The privacy policy's link, at the foot of Settings on both faces.
 *
 * **An anchor with the address on it, and a press the host carries out.** The `href` is what a
 * screen reader announces and what a long press copies. The press itself goes through
 * `openExternal`, the app's one call that leaves it: a desktop webview does not follow
 * `target="_blank"`, the Android host hands the address to the system browser, and a browser
 * opens a tab — so the anchor's own navigation is stopped, or a browser would open two.
 *
 * It asks nothing about where it runs. The policy is one page for every host.
 */
export function PrivacyLink(): JSX.Element {
  const leave = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void openExternal(PRIVACY_URL);
  };
  return (
    <a
      href={PRIVACY_URL}
      target="_blank"
      rel="noreferrer"
      onClick={leave}
      className={cn(
        "inline-flex items-center text-sm text-dim underline underline-offset-2 hover:text-text",
        TOUCH_FLOOR,
        FOCUS,
      )}
    >
      Privacy policy
    </a>
  );
}
```

Run: `npx vitest run src/features/settings/PrivacyLink.test.tsx`

Expected: PASS.

- [ ] **Step 4: Draw it on both faces**

In `mobile/phone/pages/SettingsPage.tsx`, import it:

```tsx
import { PrivacyLink } from "@/features/settings/PrivacyLink";
```

and add directly after the closing `</ul>` of the sections list, inside the scroll container:

```tsx
      {/* Under the last group, in the list's own column: Google Play asks for the policy's link
          in the app as well as on the listing, and this is every reader's last row. */}
      <p className="mx-auto max-w-2xl px-4 py-6">
        <PrivacyLink />
      </p>
```

In `src/features/settings/SettingsPage.tsx`, import it the same way (`./PrivacyLink`) and add as the **last child** of the pane column — the `<div className="flex min-w-0 flex-[999_1_480px] flex-col gap-8">` — after its last panel:

```tsx
        {/* The foot of the pane on every edition: one policy covers every host. */}
        <p>
          <PrivacyLink />
        </p>
```

`mobile/phone/fence.test.ts` allows this import: `@/features/settings/PrivacyLink` is none of the store, the shell or `@tauri-apps/*`.

- [ ] **Step 5: Hold it on the phone face**

In `mobile/phone/pages/SettingsPage.test.tsx`, add a test beside the page's other render tests:

```tsx
  it("links to the privacy policy under the last group", async () => {
    renderPhone(<PhoneFace />, { path: "/settings" });
    const link = await screen.findByRole("link", { name: "Privacy policy" });
    expect(link).toHaveAttribute("href", "https://mtg-grimoire.app/privacy");
    const list = screen.getByRole("list", { name: "Settings sections" });
    expect(list.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
```

Run: `npx vitest run mobile/phone/pages/SettingsPage.test.tsx src/features/settings/SettingsPage.test.tsx mobile/phone/fence.test.ts`

Expected: PASS. If a desktop Settings test counted the pane's children or its links, fit the count; do not move the link.

---

### Task 4: See it

- [ ] **Step 1: The link and the page, at a phone's width**

Follow the `running-the-app` skill for locks. `npm run mobile:dev`, open `http://localhost:5175/settings` at 360px wide. Confirm *Privacy policy* is under the last group, is at least 44px tall under a touch pointer (`Emulation.setTouchEmulationEnabled`), and that a press opens a tab. Then open `http://localhost:5175/privacy.html` (the dev server serves the file by its name) at 360px and at 1280px: the page reads in one column, the table's host names wrap instead of pushing the page sideways, and nothing scrolls horizontally.

- [ ] **Step 2: The desktop face**

The same server at 1280px wide: *Privacy policy* is at the foot of the settings pane.

Record both in the pull request's description.

---

### Task 5: The listing kit

**Files:**
- Create: `docs/play/README.md`

- [ ] **Step 1: Write `docs/play/README.md`**

````markdown
# Google Play — what is pasted into the Console

Everything Play Console asks for about **MTG Grimoire** (`com.mtggrimoire.app`), written down so
filling the Console is pasting. The order is the Console's own. The design is
`docs/superpowers/specs/2026-10-07-google-play-release-design.md`; the release side is
`docs/reference/ci-and-releases.md`, *What only the owner can do*.

**Two rules for every word that goes to the store:** nothing names Patreon, a membership, a
price or a way to pay — Play forbids an app to lead a reader to a payment made elsewhere — and
nothing claims to be official.

## The order

Only the owner signs in, creates, accepts, sets a secret or submits.

1. **Create the app** in Play Console: *MTG Grimoire*, app, free. Accept Play App Signing with
   a Google-generated key. Start collecting twelve testers' Google account addresses now — it
   is the longest wait here.
2. **The upload key**: restrict the `release` environment to `main`, make the key, commit its
   fingerprint, set the three values, back the keystore up —
   `docs/reference/ci-and-releases.md`, *What only the owner can do*.
3. **Merge the three changes and the release PR.** The run leaves the signed bundle as the
   artifact `play-upload-bundle` and deploys the web app, and with it the privacy policy.
4. **Ask the live address**, before anything links to it:

   ```bash
   curl -s https://mtg-grimoire.app/privacy | grep -c "<h1>MTG Grimoire privacy policy</h1>"
   ```

   It prints `1`. If it prints `0`, the host is answering the app: use
   `https://mtg-grimoire.app/privacy.html` everywhere below and say so in an issue.
5. **Internal testing**: upload the bundle — the first upload registers the upload certificate
   and fixes the package name for good. Install from Play on a phone. Check the launcher's
   icon is the book, and that Settings → Sync offers pairing and nothing about a membership.
   Take the five screenshots.
6. **Fill the listing and *App content*** from the sections below.
7. **Closed testing**: create the track, add the testers, roll the same bundle out, send the
   opt-in link. Twelve stay opted in for fourteen days running.
8. **Apply for production**, answer Google's questions about the test, wait for the review,
   create the production release.

After that, every release: download `play-upload-bundle` from the release's run, upload it to
the track, roll it out.

## Store listing → Main store listing

| Field | Limit | Text |
| --- | --- | --- |
| App name | 30 | `MTG Grimoire` |
| Short description | 80 | `Track your Magic: The Gathering collection, build decks, and search every card.` |

**Full description** (limit 4000):

```text
MTG Grimoire is a collection tracker and deck builder for Magic: The Gathering. It keeps the
whole card database on your phone, so searching, building and browsing work offline.

SEARCH EVERY CARD
• The full card database, with every printing
• Scryfall's search syntax: type, colour, cost, rules text, format legality and more
• Card pictures, kept on your device once you have seen them

TRACK YOUR COLLECTION
• Record what you own, down to the printing, finish and condition
• Organise cards into folders and binders
• See what your collection is worth, with prices from Card Kingdom or Mana Pool

BUILD DECKS
• Build for Commander and the other constructed formats, with legality checked as you go
• See which cards in a deck you already own
• Keep a wishlist of what you still need

YOUR DATA STAYS YOURS
• No account, no advertising, no tracking
• Everything you record is stored on your device
• Pair your phone with MTG Grimoire on your computer to keep your devices in step, end-to-end
  encrypted

MTG Grimoire is free and open source.

MTG Grimoire is unofficial Fan Content permitted under the Fan Content Policy. Not
approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the
Coast. ©Wizards of the Coast LLC. Card data and images are provided by Scryfall.
```

Before pasting, check each bullet against the build being listed: the description must not
claim a feature the phone face does not have. The last paragraph is Wizards of the Coast's own
required wording and is not to be edited.

| Graphic | Requirement | File |
| --- | --- | --- |
| App icon | 512×512 PNG | `docs/play/listing-icon-512.png` |
| Feature graphic | 1024×500, no alpha | `docs/play/feature-graphic-1024x500.jpg` |
| Phone screenshots | 2–8, each side 320–3840px, 16:9 or 9:16 | taken on a phone — below |

Both graphics are rendered by `node scripts/light-icons.mjs` from `logos/svg/mtg-grimoire-mark.svg`.

**Screenshots.** Taken on a phone from the internal-testing install, because Play requires them
to show the app as it is. Five, in this order:

1. Search — a wall of results for a recognisable query, such as `t:dragon`.
2. A card's sheet, open over the results.
3. A deck — its list, with the legality and owned marks showing.
4. The collection — a folder with its value.
5. Settings → Sync on a paired phone, showing the devices list.

Before each: no notification icons worth hiding, a full battery and a plain clock (Android's
*Demo mode* under Developer options does all three). Never a screenshot showing a real pairing
code.

## Store listing → Store settings

| Field | Value |
| --- | --- |
| App or game | App |
| Category | Tools |
| Tags | leave empty |
| Email address | `markus@seerup.com` — published on the listing |
| Website | `https://mtg-grimoire.app` |
| Privacy policy | `https://mtg-grimoire.app/privacy` |

## App content

Each row is a declaration the owner makes. The reasons are the code's, read on 2026-10-07.

| Declaration | Answer | Why |
| --- | --- | --- |
| Privacy policy | `https://mtg-grimoire.app/privacy` | — |
| Ads | No, the app does not contain ads | No ad code is in the build |
| App access | All functionality is available without special access | No sign-in exists. Add the note below |
| Content rating | Complete the questionnaire as a *Utility, productivity, communication or other* app. Violence: **yes, mild fantasy violence in images** — card art depicts fantasy combat and creatures. Everything else: no | The pictures are Wizards of the Coast's card art; answering "none" is what gets a rating challenged |
| Target audience | 13 and over. Not designed for children | The app is not directed at children; the game's own packaging says 13+ |
| News app | No | — |
| Data safety | Below | — |
| Government app | No | — |
| Financial features | None | Prices shown are a list from a card shop, not a financial service |
| Health | None | — |
| Advertising ID | The app does not use an advertising ID | No such permission is in the manifest |

**App access — the note for reviewers:**

```text
MTG Grimoire needs no account and no sign-in; every feature is available immediately.

On first launch the app downloads the public card database (about 80 MB) before search works.
On a metered connection it asks first.

Settings > Sync is optional. It pairs this device with another install of MTG Grimoire the user
already has, by scanning or typing a one-time code shown on that device. Nothing is sold or
unlocked inside this app, and the rest of the app works without it.
```

### Data safety

Google counts data as *collected* when it leaves the device, and does not count data that is
end-to-end encrypted so that the developer cannot read it.

| Question | Answer | Why |
| --- | --- | --- |
| Does your app collect or share any of the required user data types? | **Yes** | Sync, when a reader turns it on, sends the relay a device identifier |
| Is all of the user data collected by your app encrypted in transit? | Yes | Every request is HTTPS or WSS (`app-worker/_headers`; `usesCleartextTraffic="false"`) |
| Do you provide a way for users to request that their data is deleted? | Yes | The privacy policy's *Removing your data* and its contact |

**Data types — declare one:**

| Type | Collected | Shared | Processed ephemerally | Required or optional | Purpose |
| --- | --- | --- | --- | --- | --- |
| Device or other IDs | Yes | No | No | Optional — only if the reader pairs devices | App functionality |

Everything else: **not collected**. In particular:

- *App activity, App info and performance, Personal info, Photos and videos, Files and docs,
  Location, Contacts, Financial info, Messages, Audio, Calendar, Health, Web browsing*: none
  leaves the device. The camera's pictures are examined on the device and discarded.
- **A reader's collection and decks do leave the device when sync is on, and are not declared**:
  they are encrypted with a key only the reader's own devices hold, which is the exemption
  above.
- The requests for card data go from the device straight to Scryfall, Commander Spellbook,
  Card Kingdom and Mana Pool and carry nothing about the reader.

**The one judgement in this section**, for the owner: Cloudflare hosts the relay with request
logging on, and a request's path contains the group identifier. Declaring *Device or other
IDs* covers that. If he would rather not rely on it, turning `observability` off in
`relay/wrangler.jsonc` is the change that removes the question — a relay deploy, and his alone.

## Testing → Closed testing

A personal developer account created after 13 November 2023 must run a closed test with **12
testers opted in for 14 days running** before production can be applied for.

- Testers are added by Google account address, as an email list on the track.
- Send each the track's opt-in link; they must accept it and install from Play.
- A tester who opts out inside the fourteen days can drop the count below twelve and restart
  it. Recruit a few more than twelve.
- Tell testers the truth about sync: it pairs with another install they already have, and the
  app is complete without it. `https://mtg-grimoire.app` is the same app in a browser.
- Applying for production asks how the test went. Keep notes of what testers reported and
  what changed.
````

- [ ] **Step 2: Check the counted fields**

```bash
node -e 'const s="Track your Magic: The Gathering collection, build decks, and search every card."; console.log(s.length)'
```

Expected: `79`. And check the full description:

```bash
node -e 'const t=require("fs").readFileSync("docs/play/README.md","utf8"); const m=/\*\*Full description\*\*[^\n]*\n\n```text\n([\s\S]*?)\n```/.exec(t); console.log(m[1].length)'
```

Expected: a number under 4000.

- [ ] **Step 3: Show the owner**

The listing text, the content-rating answer and the data-safety table are his to approve. Show him `docs/play/README.md` and change what he changes.

---

### Task 6: Documents, verify, commit

**Files:**
- Modify: `mobile/CLAUDE.md`, `docs/reference/light-app.md`

- [ ] **Step 1: `mobile/CLAUDE.md`**

In §5, **Android Host**, replace the bullet beginning `- \`gen/android/\` configuration is pinned and validated by \`host.test.ts\`` with:

```markdown
- `gen/android/` configuration is pinned and validated by `host.test.ts` (backup disabled, camera optional, `cache/exports/` FileProvider, and the launcher's icon). The icon is rendered from the master mark by `node scripts/light-icons.mjs` and committed; never run `tauri android init` or `tauri icon` over `gen/android` — both put stock art back.
```

In §5, **Web Worker Host**, add after the *Service Worker handles shell precaching* bullet:

```markdown
- One document is not the app: `mobile/public/privacy.html`, the privacy policy, served at `/privacy`. It runs no script and loads one stylesheet; the service worker answers a navigation to a place whose `.html` it precached with that file (`sw/shell.ts`). `host.test.ts` holds its shape and holds its list of hosts to the web policy's `connect-src` — a new host there owes the page a row.
```

- [ ] **Step 2: `docs/reference/light-app.md`**

Append at the end of the file (number it after the file's last section):

```markdown
## 12. Google Play — the icon, the policy and the listing (2026-10-07)

- **The launcher's icon was Tauri's logo.** `tauri android init` writes it into every
  `mipmap-*`, with Android's stock robot in `drawable*`, and nothing had replaced it — the app
  ran on a phone under another project's mark from 2026-10-04. `scripts/light-icons.mjs` now
  renders the launcher's set from `logos/svg/mtg-grimoire-mark.svg`: an adaptive icon
  (`mipmap-anydpi-v26/ic_launcher.xml`) whose foreground is the mark at scale 0.55 on a
  transparent 108dp layer over `@color/ground`, and the 48dp icon no phone this app installs on
  draws. The script measures the foreground against the 66dp circle a launcher keeps whole and
  fails the render past it. The round PNGs and both stock vectors are deleted: the manifest
  names no `roundIcon`. **Not seen on a phone yet** — the first internal-testing install is.
- **The privacy policy is a document, not a route.** `mobile/public/privacy.html` and
  `privacy.css`, copied to the root of every light build; no script, one stylesheet, so it
  reads under the host's `style-src 'self'` and would read with the app broken. The host's
  default `html_handling` serves it at `/privacy`; **a reader the service worker controls never
  reaches the host**, and the worker answered every extensionless navigation with the app — so
  `routeFor` answers a navigation to a place whose `.html` is precached with that file.
  The smoke run opens `/privacy` in a controlled tab as its eighteenth check. What Cloudflare
  does with the address was measured under `wrangler dev --local` (the pull request has the
  three answers) and **has not been asked of the live address**, which serves it only after
  the next release's deploy.
- **A reader whose worker predates this build** reaches `/privacy.html` through the network,
  is redirected to `/privacy`, and is answered the app by the old worker — once, until that
  worker updates. Nobody new to the site meets it.
- **Its facts are the code's and its sentences are the owner's.** The page's table of hosts is
  held to the web policy's `connect-src` by `mobile/host.test.ts`.
- **Settings links to it on both faces** (`src/features/settings/PrivacyLink.tsx`), through
  `openExternal`.
- **`docs/play/`** holds the listing's text, the Console's answers and the two rendered
  graphics. The screenshots are taken on a phone.
```

- [ ] **Step 3: Run the whole gate, once**

Run: `npm run verify`

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A scripts/light-icons.mjs mobile/src-tauri/gen/android/app/src/main/res docs/play mobile/public/privacy.html mobile/public/privacy.css src/lib/core/web/sw/shell.ts src/lib/core/web/sw/shell.test.ts app-worker/src/hosting.test.ts app-worker/README.md scripts/web-smoke.mjs src/lib/externalLinks.ts src/features/settings/PrivacyLink.tsx src/features/settings/PrivacyLink.test.tsx src/features/settings/SettingsPage.tsx mobile/phone/pages/SettingsPage.tsx mobile/phone/pages/SettingsPage.test.tsx mobile/host.test.ts logos/README.md mobile/CLAUDE.md docs/reference/light-app.md docs/superpowers/plans/2026-10-07-google-play-c-store-readiness.md
git commit -m "$(cat <<'EOF'
feat(android): the app's own launcher icon, and a privacy policy

The Android launcher drew Tauri's stock logo. light-icons.mjs now renders an
adaptive icon from the master mark, measured against the circle a launcher
keeps whole, and the stock art is gone.

A privacy policy is served at /privacy: a static page with no script, whose
list of hosts is held to the web policy's connect-src. The service worker
answers a navigation to a precached page with that page, and Settings links
to it on both faces.

docs/play holds the store listing's text, the Console's declarations and the
two rendered graphics.

Refs #761

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Confirm before committing that `git status` shows no change under `mobile/public/icons/`.

---

## What changed in execution (2026-10-07)

The plan above is as it was written. These are the decisions made while it was carried out —
each one where the code now differs from a task's text, or where something found in review was
fixed or knowingly left. Where the two disagree, the code and this list are right.

- tasks make WIP commits and the controller squashes the branch into the plan's one conventional commit before the PR — the review loop needs a commit range per task and the repo wants one commit per feature — costs a soft reset on a private branch if wrong.
- the controller runs `npm run verify`, one worktree at a time, with one shared CARGO_TARGET_DIR (D:\Code\mtg-grimoire\.claude\worktrees\gp-target); no implementer runs verify — two verifies at once fake Rust failures (memory) — costs a late finding if a task's own focused tests missed something.
- the plan's final commit step is the controller's (the squash); the last task's implementer does the sweep and the documents only.
- merge order is A, then B, then C; B and C merge main and resolve the shared files (mobile/host.test.ts, mobile/CLAUDE.md, docs/reference/light-app.md) when their turn comes — costs a small manual merge.
- Task 2's "stop for the owner" after drafting the policy moves to before the pull request — the page's wording changes no later step, and a parked task buys nothing; the owner approves the text from the file — costs a re-word and one re-run of a fence if he changes a host row.
- Task 5's "show the owner" is likewise at the end, with the policy.
- Task 2 Step 8's smoke run needs the wasm toolchain; if npm run web:wasm cannot finish here within 15 minutes the step is left to CI's web job and reported so. Step 9's wrangler measurement runs against a stub dist-web if there is no real one — bounded measuring (memory: long measurement loops) — costs: the smoke check's first run is on the pull request.
- Task 4's live look is the controller's, serialized with plan B on port 5175.
- the owner's contact address is markus@seerup.com (his message, 2026-10-07); the plan and brief carry it.
- light-app.md's new section is numbered 12 here even though this branch's last is 10: plan B adds 11 and merges first — costs a renumber if the order changes.
- **Task 1.** Minor 1 (README paragraph fused with the next) and Minor 2 (the script's header now untrue in four sentences — a gap in the plan's own edit) join fix round 1 — both are defects this change introduced in files it already touches and cost one edit each — costs a slightly wider re-review.
- four of Task 2's Minors ride with Task 3's dispatch — host.test.ts lost its trailing newline again (ruled Important in Task 1, so it is fixed, not deferred); the routeFor test cannot observe the `path !== "/"` guard (add "/.html" to that test's fixture); the table headers get scope="col"; the smoke header's "in this order" is made true by numbering the new check where it runs — each is one small edit in files this plan already owns — costs a wider Task 3 diff.
- **Task 3.** the plan's two PrivacyLink tests are tightened — "coarse:" substring becomes classList.contains(TOUCH_FLOOR), the repo's own form; the press test observes defaultPrevented — the plan's tests could not fail for the lines they were written for — costs nothing.
- Tasks 5 and 6 are one dispatch and one review — a listing kit and three document edits, no code — costs one larger prose diff.
- **Tasks 5-6.** the kit's verification command becomes PowerShell (curl.exe | Select-String) — the owner's shell has no grep.
- **Tasks 5-6.** the kit's fallback to /privacy.html is removed — the host redirects that address to /privacy (measured), so a failing check means stop and fix the host.
- **Tasks 5-6.** the kit says the fingerprint is its own pull request, and that a release deploys the web app only with the two Cloudflare values set (today the release environment holds none, read 2026-10-07); otherwise the deploy is by hand.
- **Tasks 5-6.** the kit's rule is narrowed to the listing's text, graphics and screenshots; the privacy policy names Patreon as a fact about data and the kit says so — costs: the owner must knowingly accept that page as a store-linked document.
- **Tasks 5-6.** the HTTPS row cites the engine's host constants, not the web build's _headers.
- **Tasks 5-6.** five Minors join the round because each would mislead the owner at the Console (uninstall a CI build first; the screenshot size rule; what screenshot 3 can show; the age bands; "nothing about the reader").
- the IP finding is fixed by the SENTENCE, not by the relay's config — turning invocation logs off needs a relay deploy, which is the owner's alone, and the page must be true of the relay as deployed; the kit names the config change as his option — costs: the page admits a seven-day log until he changes it.
- the Patreon section is rewritten to state only what is stored ("If a Patreon membership is connected to your sync group"), dropping "paid for" and "funded", and the fence forbids both words — the plan's own draft said what sync costs and where to connect it, on a page linked from the Play build.
- the retention paragraph says the figures hold for a group that is still syncing, and what happens to one that is not.
- the smoke's server learns the host's two .html rules, so CI's first smoke run proves the worker's install over a redirect; it cannot be run here, so a throwaway check of the server's answers stands in — costs: if the handler change is wrong, CI's web job is where it shows.
- deletion requests name the device identifier the Sync panel shows — the relay has no route for a reader to drop a group and the owner can find a group by a device id; written only if the implementer confirms the panel shows it.
- the kit gains the account-creation answer, the deletion URL, the privacy address before the first upload, a truthful App-access note, and "prints nothing" for a failed check; the listing loses "and binders" (no binder exists on the phone face) — the owner still approves the listing text.
- the review's qualifications on eleven sentences of the page are applied as worded by the reviewer or tightened by the controller.
- **left as it is.** Settings search for "privacy" finds nothing above the link — real, small, left.
- **left as it is.** no monochrome layer for Android 13 themed icons — optional, left.
- **left as it is.** the design's §6 asked for round mipmaps; the plan deleted them (no roundIcon, minSdk 26) without listing that under its deviations — recorded in the plan's execution note.
- declined-to-judge items left to the owner: GDPR sufficiency of the page; how a Play reviewer reads "all functionality available"; request logs on app-worker and share-worker (same setting); Android 12+ device-to-device transfer copying user.db despite allowBackup=false (pre-existing).
- **left as it is.** the smoke server's Location is built from the raw path — only a percent-encoded ".html" would get a wrong slice and nothing asks one — costs: nothing a run can show.
- the kit's sentence about turning the relay's request log off is corrected by the controller after the gate — Cloudflare's documents confirm the setting (`observability.logs.invocation_logs: false`) but it stops the per-request line only; the relay's own `console.error` lines (seven call sites, one naming a membership's subject) are still kept — a document-only edit, covered by re-running the files that read docs/play — costs: the head that is squashed is one paragraph past the head the gate ran on.
- that failure is the known load flake, not this plan's — the gate resumes from vitest-1 rather than restarting, since nothing before it reads what changed — costs: build and lint ran one document paragraph and one policy sentence before the head.
- the policy gains one sentence — the relay's own fault lines share the request log, and a fault while a membership is checked names its Patreon user id (relay/src/claim.ts:1242) — the page said what the log holds and left that out; the owner approves the page's text either way.
- the gate's vitest shards run with --retry=2 from here on (both plans B and C) — two different tests in two untouched files (CollectionSearchPanel, then mobile/phone/pages/SearchPage) timed out at ~4 s in consecutive runs of shard 1 with the machine at 100% CPU under another session's cargo; each passes alone — costs: a test this change made genuinely flaky would pass on a retry; neither plan touches a file near the two that failed, and CI runs without the retry. verify resumed from vitest-1 (pid 16004).
