// Every file in `changelog/` is one the generator could have written: the app's reader finds
// nothing in it but the headings and the lists `notes.ts` renders, or the one maintenance line.
import { describe, expect, it } from "vitest";
import { LINK, MAINTENANCE } from "./notes.ts";

const FILES = import.meta.glob<string>("/changelog/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const HEADINGS = ["### Highlights", "### New", "### Changed", "### Fixed"];

describe("changelog/", () => {
  it("holds a file for every release", () => {
    expect(Object.keys(FILES).length).toBeGreaterThanOrEqual(48);
  });

  it.each(Object.entries(FILES))("%s is in the generator's shape", (path, text) => {
    expect(path).toMatch(/^\/changelog\/\d+\.\d+\.\d+\.md$/);
    expect(text.endsWith("\n")).toBe(true);
    if (text === `${MAINTENANCE}\n`) return;
    const lines = text.split("\n").filter((line) => line !== "");
    const headings = lines.filter((line) => line.startsWith("#"));
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) expect(HEADINGS, heading).toContain(heading);
    // In the order they are written, each at most once.
    expect(headings).toEqual(HEADINGS.filter((heading) => headings.includes(heading)));
    for (const line of lines) {
      if (line.startsWith("#")) continue;
      expect(line, line).toMatch(/^- \*\*[^*]+\*\* \S/);
      // The generator's own rule, not a second spelling of it: what `problems` lets through is
      // what this holds a file to, so a file it wrote cannot fail here.
      expect(line, line).not.toMatch(LINK);
    }
  });
});
