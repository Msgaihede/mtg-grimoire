// @vitest-environment jsdom
// The report's own inline script, run over the page it belongs to: the picker, the filter and
// the search, with a stub in place of the clipboard.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CARD_ID, results, run } from "./fixture.ts";
import { copiedText, pickedText, reportHtml } from "./report.ts";

const named = (id: string, name: string, scores: ["wrong" | "printing", "wrong" | "printing"]) =>
  run({ id, scores, card: { id: CARD_ID, set: "2x2", number: "1", lang: "en", name } });

const html = reportHtml(
  results([
    named("scan-a", "Lightning Bolt", ["printing", "printing"]),
    named("scan-b", "Shock", ["wrong", "wrong"]),
    named("scan-c", "Counterspell", ["wrong", "wrong"]),
    named("scan-d", "Giant Growth", ["printing", "printing"]),
  ]),
  null,
  { frames: "../frames" },
);
const script = html.match(/<script>([\s\S]*)<\/script>/)![1];

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const picks = () => [...document.querySelectorAll<HTMLInputElement>("input.pick")];
const tick = (...n: number[]) => n.forEach((i) => picks()[i].click());
const shown = () => [...document.querySelectorAll<HTMLElement>(".run")].filter((r) => !r.hidden).length;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
let written: string[];

function load(clipboard: unknown) {
  document.body.innerHTML = html.match(/<main>[\s\S]*<\/main>/)![0];
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  new Function(script)();
}
const works = () => ({ writeText: async (text: string) => void written.push(text) });

beforeEach(() => {
  written = [];
  load(works());
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("the report's script", () => {
  it("starts with nothing selected and the bar hidden", () => {
    expect($(".picks").hasAttribute("hidden")).toBe(true);
    expect($(".count").textContent).toBe("4 of 4 scans");
  });

  it("counts ticked scans, and Clear unticks them and hides the bar", () => {
    tick(1, 2);
    expect($(".picks").hasAttribute("hidden")).toBe(false);
    expect($(".picked").textContent).toBe("2 selected");
    $<HTMLButtonElement>(".clear").click();
    expect(picks().some((p) => p.checked)).toBe(false);
    expect($(".picks").hasAttribute("hidden")).toBe(true);
  });

  it("copies the command for the ticked scans in page order, and says so", async () => {
    tick(3, 1);
    $<HTMLButtonElement>(".copy").click();
    await settle();
    expect(written).toEqual(["pnpm scanner:corpus remove scan-b scan-d"]);
    expect($(".said").textContent).toBe("Copied a command for 2 scans");
  });

  it("keeps a ticked scan the filter hides, counts it as hidden, and still copies it", async () => {
    tick(0, 1);
    $<HTMLButtonElement>('button[data-filter="wrong"]').click();
    expect(shown()).toBe(2);
    expect($(".picked").textContent).toBe("2 selected (1 hidden by the filter)");
    $<HTMLButtonElement>(".copy").click();
    await settle();
    expect(written).toEqual(["pnpm scanner:corpus remove scan-a scan-b"]);
    expect($(".said").textContent).toBe("Copied a command for 2 scans, 1 of them hidden by the filter");
    $<HTMLButtonElement>('button[data-filter="all"]').click();
    expect($(".picked").textContent).toBe("2 selected");
  });

  it("shows the command in a selected, read-only box when the clipboard refuses", async () => {
    load({ writeText: () => Promise.reject(new Error("denied")) });
    tick(1);
    $<HTMLButtonElement>(".copy").click();
    await settle();
    const box = $<HTMLInputElement>(".cmd");
    expect(box.hidden).toBe(false);
    expect(box.readOnly).toBe(true);
    expect(box.value).toBe("pnpm scanner:corpus remove scan-b");
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(box.value.length);
  });

  it("shows the box too when there is no clipboard API, as from file://", () => {
    load(undefined);
    tick(2);
    $<HTMLButtonElement>(".copy").click();
    expect($<HTMLInputElement>(".cmd").value).toBe("pnpm scanner:corpus remove scan-c");
  });

  it("still filters by the buttons and by the search", () => {
    $<HTMLButtonElement>('button[data-filter="wrong"]').click();
    expect(shown()).toBe(2);
    expect($(".count").textContent).toBe("2 of 4 scans");
    const search = $<HTMLInputElement>('input[type="search"]');
    search.value = "shock";
    search.dispatchEvent(new Event("input"));
    expect(shown()).toBe(1);
    $<HTMLButtonElement>('button[data-filter="all"]').click();
    expect(shown()).toBe(1);
    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(shown()).toBe(4);
  });
});

describe("the bar's words", () => {
  it("names the hidden count only when there is one", () => {
    expect(pickedText(3, 0)).toBe("3 selected");
    expect(pickedText(3, 2)).toBe("3 selected (2 hidden by the filter)");
    expect(copiedText(1, 0)).toBe("Copied a command for 1 scan");
    expect(copiedText(3, 2)).toBe("Copied a command for 3 scans, 2 of them hidden by the filter");
  });
});
