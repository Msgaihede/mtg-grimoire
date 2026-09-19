import { afterEach, describe, expect, it } from "vitest";
import mainSource from "@/main.tsx?raw";
import { installNativeDragGuard } from "./nativeDrag";

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
  document.body.innerHTML = "";
});

/**
 * A native drag beginning on `from`, the way Chromium starts one: `dragstart`, cancelable, at the
 * node the press landed on. `Event` rather than `DragEvent` because jsdom has no `DragEvent`, and
 * nothing under test reads a property of it — whether the default was refused is the whole signal.
 */
function dragFrom(from: Node): Event {
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  from.dispatchEvent(event);
  return event;
}

describe("installNativeDragGuard", () => {
  it("refuses a native drag of page content — the selection a press-drag leaves behind", () => {
    uninstall = installNativeDragGuard(window);
    const heading = document.createElement("h2");
    heading.textContent = "Drawpower";
    document.body.append(heading);

    expect(dragFrom(heading).defaultPrevented).toBe(true);
    // A selection drag can begin on the text node itself rather than on its element, and a
    // guard that only read `Element` targets would wave exactly that one through.
    expect(dragFrom(heading.firstChild!).defaultPrevented).toBe(true);
  });

  it("refuses a link and an image too, since nothing in this app is dragged natively", () => {
    uninstall = installNativeDragGuard(window);
    const link = document.createElement("a");
    link.href = "https://scryfall.com";
    const image = document.createElement("img");
    document.body.append(link, image);

    expect(dragFrom(link).defaultPrevented).toBe(true);
    expect(dragFrom(image).defaultPrevented).toBe(true);
  });

  it("leaves a drag that starts inside a text field alone — moving text there is editing", () => {
    uninstall = installNativeDragGuard(window);
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    // The attribute, as ProseMirror writes it — jsdom does not reflect the `contentEditable`
    // property onto the element, so setting that would build a fixture that is not editable.
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Mulligan anything without a land.";
    editor.append(paragraph);
    document.body.append(input, textarea, editor);

    expect(dragFrom(input).defaultPrevented).toBe(false);
    expect(dragFrom(textarea).defaultPrevented).toBe(false);
    expect(dragFrom(paragraph.firstChild!).defaultPrevented).toBe(false);
  });

  it("stops refusing once uninstalled", () => {
    const off = installNativeDragGuard(window);
    off();
    const heading = document.createElement("h2");
    document.body.append(heading);

    expect(dragFrom(heading).defaultPrevented).toBe(false);
  });

  // **The guard is only a fix once something installs it**, and nothing in the suite loads
  // `main.tsx` — so this reads the entry point's text, the way `ipc.test.ts` reads the crate's.
  it("is installed by the app's entry point", () => {
    expect(mainSource).toMatch(/^installNativeDragGuard\(window\);$/m);
  });
});
