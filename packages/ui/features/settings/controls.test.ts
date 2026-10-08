import { describe, expect, it } from "vitest";
import { compile } from "tailwindcss";
/**
 * Both stylesheets through Vite's `?raw` rather than `node:fs` — this project has no
 * `@types/node` on purpose, and it is how `NoteEditor.test.tsx` and `keyboardModality.test.ts`
 * read them for the same job.
 */
import twEntry from "tailwindcss/index.css?raw";
import appCss from "@/index.css?raw";
import qrCodeSource from "./QrCode.tsx?raw";
import qrScannerSource from "./QrScanner.tsx?raw";
import syncPanelSource from "./SyncPanelBody.tsx?raw";
import {
  BUTTON,
  PANEL_BUTTON,
  SWITCH,
  TOUCH_CODE_ROOM,
  TOUCH_FIELD,
  TOUCH_FLOOR,
} from "./controls";

/**
 * **The Settings page under a finger** — the light app's phone face draws these panels, and what
 * makes them usable there is four utilities nothing else in the suite would miss: delete the
 * floor from `PANEL_BUTTON`, or the 16px type from a text box, and every other test stays green.
 *
 * Two kinds of fence, because there are two ways to lose a utility:
 *
 * 1. **The class leaves the constant** — a tidy-up, a merge. Pinned by splitting the constant on
 *    spaces and asking for the exact utility: `FilterChips.test.tsx`'s way, and for its reason —
 *    a substring test over a class list passes on a prefix of some other class.
 * 2. **The class is there and emits nothing** — a mistyped arbitrary value, a variant this
 *    Tailwind does not parse. That fails silently and only in a build, so each utility is
 *    compiled here against the app's own stylesheet and its declaration read back.
 *
 * What neither can say is a pixel: jsdom applies no media query. The sizes were measured in a
 * browser under a touch pointer, and `scripts/pairing-scan-smoke.mjs` takes two of them again.
 */

const classesOf = (recipe: string): string[] => recipe.split(" ");

describe("the Settings page's touch vocabulary", () => {
  it("spells the floor and the type size as the utilities the stylesheet declares", () => {
    expect(TOUCH_FLOOR).toBe("coarse:min-h-[var(--target-min)]");
    expect(TOUCH_FIELD).toBe("coarse:text-base");
    expect(TOUCH_CODE_ROOM).toBe("coarse:min-h-36");
    // The two halves the floor is made of exist in the shipped sheet.
    expect(appCss).toMatch(/@custom-variant\s+coarse\s*\(/);
    expect(appCss).toMatch(/--target-min:\s*44px/);
  });

  it("puts the floor on a panel's button, and on the switch built from it", () => {
    expect(classesOf(PANEL_BUTTON)).toContain(TOUCH_FLOOR);
    // `cn` merges, and a merge is where a class is quietly dropped: `h-8` and a least height
    // are different properties, and both must come out the other side.
    expect(classesOf(SWITCH)).toContain(TOUCH_FLOOR);
    expect(classesOf(SWITCH)).toContain("h-8");
  });

  it("is the app's bordered control and nothing else besides the floor", () => {
    expect(classesOf(PANEL_BUTTON).filter((c) => c !== TOUCH_FLOOR)).toEqual(classesOf(BUTTON));
  });

  /**
   * **`BUTTON` is read outside Settings** — the share menu, the share dialogs, the public share
   * viewer — and none of those was measured under a finger. A floor that reached them by import
   * is a change nobody chose, which is how it stood for one commit.
   */
  it("leaves the shared button with nothing about a finger in it", () => {
    expect(classesOf(BUTTON).filter((c) => c.startsWith("coarse:"))).toEqual([]);
  });
});

/**
 * The utilities layer of one candidate compiled against `packages/ui/index.css` — `""` where Tailwind
 * emitted nothing. One candidate at a time and only its own layer, for
 * `NoteEditor.test.tsx`'s two reasons: preflight and a sibling utility can each make a whole
 * sheet read as success for a rule that is missing.
 */
async function compiled(utility: string): Promise<string> {
  const compiler = await compile(appCss, {
    base: "/",
    loadStylesheet: (id: string) =>
      Promise.resolve(
        id === "tailwindcss"
          ? { path: "/tailwindcss/index.css", base: "/tailwindcss", content: twEntry }
          : { path: "/empty.css", base: "/", content: "" },
      ),
    loadModule: () => Promise.reject(new Error("no JS modules expected")),
  });
  const sheet = compiler.build([utility]);
  return sheet.match(/@layer utilities \{([\s\S]*?)\n\}/)?.[1].trim() ?? "";
}

/**
 * The media query the `coarse` variant stands for, assembled from two pieces: written out whole
 * it is the raw query `touchTargets.test.ts` sweeps `packages/ui/` for, and this file would be its own
 * offender.
 */
const UNDER_A_FINGER = new RegExp(`@media \\(${"pointer"}: coarse\\)`);

describe("the phone-width utilities really compile", () => {
  /** The helper can say no: a candidate Tailwind does not know emits an empty layer. */
  it("reads nothing out of a utility that does not exist", async () => {
    expect(await compiled("coarse:min-h-[var(--target-min")).toBe("");
    expect(await compiled("@max-smm:flex-auto")).toBe("");
  });

  it("the 44px floor: a least height, under a coarse pointer only", async () => {
    const css = await compiled(TOUCH_FLOOR);
    expect(css).toMatch(UNDER_A_FINGER);
    expect(css).toMatch(/min-height:\s*var\(--target-min\)/);
  });

  it("the 16px type a text box takes under a finger", async () => {
    const css = await compiled(TOUCH_FIELD);
    expect(css).toMatch(UNDER_A_FINGER);
    expect(css).toMatch(/font-size:\s*var\(--text-base\)/);
    // And `text-base` is the 16px the rule is about: below it a phone zooms the page on focus.
    expect(await compiled("text-base")).not.toBe("");
    expect(twEntry).toMatch(/--text-base:\s*1rem/);
  });

  it("the code box's room under a finger", async () => {
    const css = await compiled(TOUCH_CODE_ROOM);
    expect(css).toMatch(UNDER_A_FINGER);
    expect(css).toMatch(/min-height:\s*calc\(var\(--spacing\) \* 36\)/);
  });

  /**
   * The three below are spelled at their call sites rather than in `controls.ts`, so each is
   * first found in the shipped source — a utility compiled here and written differently there
   * would be a green test about a class nobody wears.
   */
  it("the viewfinder: 256px, or half the window's height where that is less", async () => {
    const utility = "w-[min(16rem,50dvh)]";
    expect(qrScannerSource).toContain(`aspect-square ${utility} max-w-full`);
    expect(await compiled(utility)).toMatch(/width:\s*min\(16rem,\s*50dvh\)/);
  });

  it("the roster's fold: a container, and a basis of the name's own width under 24rem", async () => {
    expect(syncPanelSource).toContain('<ul className="@container ');
    expect(syncPanelSource).toContain("flex min-w-0 flex-1 items-center gap-2 @max-sm:flex-auto");

    expect(await compiled("@container")).toMatch(/container-type:\s*inline-size/);
    const fold = await compiled("@max-sm:flex-auto");
    expect(fold).toMatch(/@container[^{]*\(width < 24rem\)/);
    expect(fold).toMatch(/flex:\s*auto/);
  });

  it("the offer: a QR code as wide as its step, and a typed code with a floor to wrap by", async () => {
    expect(qrCodeSource).toContain('className="aspect-square w-72 max-w-full shrink-0 ');
    expect(syncPanelSource).toContain('<p className="min-w-32 flex-1 font-mono');

    expect(await compiled("max-w-full")).toMatch(/max-width:\s*100%/);
    expect(await compiled("aspect-square")).toMatch(/aspect-ratio:\s*1\s*\/\s*1/);
    expect(await compiled("w-72")).toMatch(/width:\s*calc\(var\(--spacing\) \* 72\)/);
    expect(await compiled("min-w-32")).toMatch(/min-width:\s*calc\(var\(--spacing\) \* 32\)/);
  });
});
