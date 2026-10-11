import { describe, expect, it } from "vitest";
import {
  AREAS,
  MAINTENANCE,
  MAX_HIGHLIGHTS,
  SCHEMA,
  omittedLines,
  problems,
  render,
} from "./notes.ts";

const IDS = ["#860", "#861", "#854", "#856", "#848", "abc1234"];

/** An answer that passes every check for {@link IDS}. Each test breaks one thing in a copy. */
const good = () => ({
  highlights: [
    {
      lead: "Scan cards from your phone or browser",
      text: "The Scanner comes to the Android and web apps.",
      refs: ["#861"],
    },
  ],
  new: [
    { area: "Scanner", text: "the Scanner works in the web app", refs: ["#861"] },
    { area: "Android", text: "sync turns on by pairing with another device", refs: ["#860"] },
  ],
  changed: [],
  fixed: [
    {
      area: "Sync",
      text: "a copy moved on one device is no longer skipped on another",
      refs: ["#856", "#854", "abc1234"],
    },
  ],
  omitted: [{ ref: "#848", reason: "planning document" }],
});

describe("problems", () => {
  it("finds none in an answer that accounts for every entry", () => {
    expect(problems(good(), IDS)).toEqual([]);
  });

  it("refuses a ref that was never sent", () => {
    const answer = good();
    answer.new[0].refs.push("#999");
    expect(problems(answer, IDS)).toEqual([
      "new[0] cites #999, which is not an entry that was sent",
    ]);
  });

  it("refuses an entry that is neither cited nor omitted", () => {
    const answer = good();
    answer.omitted = [];
    expect(problems(answer, IDS)).toEqual([
      "#848 is neither cited by an item nor listed in omitted",
    ]);
  });

  it("refuses an entry that is both", () => {
    const answer = good();
    answer.omitted.push({ ref: "#860", reason: "internal" });
    expect(problems(answer, IDS)).toEqual(["#860 is both cited by an item and omitted"]);
  });

  // Review Focus 1: a description is text somebody else wrote, and the app opens https links.
  it("refuses a link or a URL in any text", () => {
    for (const text of [
      "see https://example.com for more",
      "see [the guide](x) for more",
      "visit www.example.com",
      "see HTTP://EXAMPLE.COM",
      // What GitHub's release page would make a link or a picture of, whatever the app does.
      'see <a href="//evil.example">here</a>',
      "an <img src=x> of it",
      "a note <!-- hidden --> in it",
      "see ftp://example.com/file",
    ]) {
      const answer = good();
      answer.fixed[0].text = text;
      expect(problems(answer, IDS), text).toEqual(["fixed[0].text carries a link or a URL"]);
    }
    const lead = good();
    lead.highlights[0].lead = "Read https://example.com";
    expect(problems(lead, IDS)).toEqual(["highlights[0].lead carries a link or a URL"]);
  });

  it("lets an ordinary angle bracket through", () => {
    const answer = good();
    answer.new[0].text = "cards with a mana value < 3 sort first, and 4 > 3";
    expect(problems(answer, IDS)).toEqual([]);
  });

  // GitHub links both by itself in a release body: one pings a person, the other points at
  // whatever issue or pull request has that number. The renderer adds the real ones.
  it("refuses a mention, and a number written as a reference", () => {
    for (const text of ["thanks to @someone for the report", "see #999", "also fixed in (#860)"]) {
      const answer = good();
      answer.fixed[0].text = text;
      expect(problems(answer, IDS), text).toEqual([
        "fixed[0].text mentions a user or names an issue by number",
      ]);
    }
  });

  // A lead is drawn between `**` and `**`, and `files.test.ts` holds every file to that. One
  // asterisk inside it would write a file the release PR's own checks refuse.
  it("refuses an asterisk in a lead", () => {
    const answer = good();
    answer.highlights[0].lead = "Scan * cards";
    expect(problems(answer, IDS)).toEqual([
      "highlights[0].lead carries an asterisk, and a lead is drawn bold",
    ]);
  });

  // What the model writes is printed in a workflow's log, where a line that opens `::…::` is a
  // command to the runner. Nothing it writes may bring a line of its own.
  it("holds a reason to one line, and echoes nothing that could start a line", () => {
    const reason = good();
    reason.omitted[0].reason = "internal\n::add-mask::0.44.0";
    expect(problems(reason, IDS)).toEqual(["omitted[0].reason is more than one line"]);

    const empty = good();
    empty.omitted[0].reason = " ";
    expect(problems(empty, IDS)).toEqual(["omitted[0].reason is empty"]);

    const ref = good();
    ref.fixed[0].refs = ["#856", "#854", "abc1234\n::error::gotcha"];
    const found = problems(ref, IDS);
    expect(found).toEqual([
      "fixed[0] has a ref that is not an id (#123, or a commit's seven characters)",
      "abc1234 is neither cited by an item nor listed in omitted",
    ]);

    const area = good();
    area.new[0].area = "Camera\n::error::gotcha";
    const said = problems(area, IDS);
    expect(said).toEqual([
      'new[0].area is "Camera\\n::error::gotcha", which is not one of the areas',
    ]);
    for (const line of [...found, ...said]) expect(line).not.toMatch(/[\r\n]/);
  });

  it("refuses a text of more than one line, an empty one, and bold markup", () => {
    const lines = good();
    lines.new[0].text = "one\ntwo";
    expect(problems(lines, IDS)).toEqual(["new[0].text is more than one line"]);

    const empty = good();
    empty.new[0].text = "   ";
    expect(problems(empty, IDS)).toEqual(["new[0].text is empty"]);

    const bold = good();
    bold.new[0].text = "the **Scanner** works";
    expect(problems(bold, IDS)).toEqual(["new[0].text carries bold markup"]);
  });

  it("refuses more highlights than the limit", () => {
    const answer = good();
    answer.highlights = Array.from({ length: MAX_HIGHLIGHTS + 1 }, () => good().highlights[0]);
    expect(problems(answer, IDS)).toEqual([
      `there are ${MAX_HIGHLIGHTS + 1} highlights, and at most ${MAX_HIGHLIGHTS} are allowed`,
    ]);
  });

  it("refuses an area that is not on the list", () => {
    const answer = good();
    answer.new[0].area = "Camera";
    expect(problems(answer, IDS)).toEqual([
      'new[0].area is "Camera", which is not one of the areas',
    ]);
  });

  it("refuses an item or a highlight that cites nothing", () => {
    const item = good();
    item.new[1].refs = [];
    item.omitted.push({ ref: "#860", reason: "moved" });
    expect(problems(item, IDS)).toEqual(["new[1] cites no entry"]);

    const highlight = good();
    highlight.highlights[0].refs = [];
    expect(problems(highlight, IDS)).toEqual(["highlights[0] cites no entry"]);
  });

  it("refuses a highlight about something no item mentions", () => {
    const answer = good();
    answer.highlights[0].refs = ["#848"];
    expect(problems(answer, IDS)).toEqual([
      "highlights[0] cites #848, which no item under new, changed or fixed cites",
    ]);
  });

  it("says so when the answer is not the shape that was asked for", () => {
    expect(problems(null, IDS)).toEqual(["the answer is not a JSON object"]);
    expect(problems([], IDS)).toEqual(["the answer is not a JSON object"]);
    expect(problems({ ...good(), fixed: "none" }, IDS)).toEqual(["`fixed` is not a list"]);
    const answer = {
      ...good(),
      new: [{ area: "Scanner", text: 5, refs: ["#861"] }, good().new[1]],
    };
    expect(problems(answer, IDS)).toEqual(["new[0] is not { area, text, refs }"]);
    const omitted = { ...good(), omitted: [{ ref: "#848" }] };
    expect(problems(omitted, IDS)).toEqual(["omitted[0] is not { ref, reason }"]);
    const highlight = { ...good(), highlights: [{ lead: "x", text: "y", refs: [1] }] };
    expect(problems(highlight, IDS)).toEqual(["highlights[0] is not { lead, text, refs }"]);
  });
});

describe("render", () => {
  it("writes the whole shape, with the pull requests in order and no commit hash", () => {
    expect(render(good())).toBe(
      [
        "### Highlights",
        "",
        "- **Scan cards from your phone or browser.** The Scanner comes to the Android and web apps.",
        "",
        "### New",
        "",
        "- **Scanner:** the Scanner works in the web app (#861)",
        "- **Android:** sync turns on by pairing with another device (#860)",
        "",
        "### Fixed",
        "",
        "- **Sync:** a copy moved on one device is no longer skipped on another (#854, #856)",
        "",
      ].join("\n"),
    );
  });

  it("leaves an empty section out, Highlights included", () => {
    const answer = { ...good(), highlights: [], new: [] };
    expect(render(answer)).toBe(
      "### Fixed\n\n- **Sync:** a copy moved on one device is no longer skipped on another (#854, #856)\n",
    );
  });

  it("writes an item from direct commits alone with no reference at all", () => {
    const answer = {
      highlights: [],
      new: [],
      changed: [{ area: "General", text: "the app starts faster", refs: ["abc1234"] }],
      fixed: [],
      omitted: [],
    };
    expect(render(answer)).toBe("### Changed\n\n- **General:** the app starts faster\n");
  });

  it("keeps a lead's own closing mark", () => {
    const answer = good();
    answer.highlights[0].lead = "Custom deck covers are gone!";
    expect(render(answer)).toContain("- **Custom deck covers are gone!** The Scanner");
  });

  // The first real answer, for 0.43.0, closed every lead and left every highlight's text open.
  it("closes a highlight's text with a full stop when the model left it open", () => {
    const answer = good();
    answer.highlights[0].text = "The Scanner comes to the Android and web apps";
    expect(render(answer)).toContain(
      "- **Scan cards from your phone or browser.** The Scanner comes to the Android and web apps.\n",
    );
  });

  it("writes one line for a release with nothing a user sees", () => {
    const answer = { highlights: [], new: [], changed: [], fixed: [], omitted: good().omitted };
    expect(render(answer)).toBe(`${MAINTENANCE}\n`);
  });
});

describe("omittedLines", () => {
  it("lists what was left out and why, and nothing for no answer", () => {
    expect(omittedLines(good())).toEqual(["#848 — planning document"]);
    expect(omittedLines(null)).toEqual([]);
  });
});

describe("SCHEMA", () => {
  it("asks for the five lists and nothing else, at every level", () => {
    expect(SCHEMA.required).toEqual(["highlights", "new", "changed", "fixed", "omitted"]);
    expect(Object.keys(SCHEMA.properties)).toEqual(SCHEMA.required);
    const objects = [
      SCHEMA,
      SCHEMA.properties.highlights.items,
      SCHEMA.properties.new.items,
      SCHEMA.properties.omitted.items,
    ];
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      expect(object.required).toEqual(Object.keys(object.properties));
    }
    expect(SCHEMA.properties.new.items.properties.area.enum).toEqual(AREAS);
    expect(SCHEMA.properties.changed).toEqual(SCHEMA.properties.new);
    expect(SCHEMA.properties.fixed).toEqual(SCHEMA.properties.new);
  });
});
