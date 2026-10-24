import { describe, expect, it } from "vitest";
import { CARD_ID, gotId, pass, results, run } from "./fixture.ts";
import { cardImage, FILTER_SRC, matchesFilter, removeCommand, reportHtml } from "./report.ts";
import type { Results } from "./results.ts";

const paths = { frames: "../frames" };
const BAD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const styleOf = (html: string) => html.match(/<style>([\s\S]*?)<\/style>/)![1];

describe("the replay's report", () => {
  it("finds a card's picture from its id alone", () => {
    expect(cardImage("9f8a0c1d-2e3f-4a5b-8c7d-000000000001")).toBe(
      "https://cards.scryfall.io/normal/front/9/f/9f8a0c1d-2e3f-4a5b-8c7d-000000000001.jpg",
    );
  });

  it("lower-cases an upper-case UUID, which Scryfall's address needs", () => {
    expect(cardImage("9F8A0C1D-2E3F-4A5B-8C7D-00000000000A")).toBe(
      "https://cards.scryfall.io/normal/front/9/f/9f8a0c1d-2e3f-4a5b-8c7d-00000000000a.jpg",
    );
  });

  it("will not build a picture address from an id that is not a UUID", () => {
    expect(cardImage("card-1")).toBe("");
    expect(cardImage('x"><script>')).toBe("");
  });

  it("draws a row a scan: its frames, what was expected, and what each pass matched instead", () => {
    const html = reportHtml(
      results([
        run({
          id: "scan-1",
          frames: 2,
          then_frames: [
            { ms: -110, ok: true, decided: null },
            { ms: 0, ok: true, decided: null },
          ],
          passes: [
            pass("As scanned", "wrong", { first_decision_frame: 2, got: { id: BAD, name: "Shockwave Zzz", set: "m19", number: "156" } }),
            pass("Neural", "undecided"),
          ],
        }),
      ]),
      null,
      paths,
    );
    expect(html).toContain('src="../frames/scan-1/00.jpg"');
    expect(html).toContain('src="../frames/scan-1/01.jpg"');
    expect(html).toContain('data-score="wrong"');
    expect(html).toContain("Shockwave Zzz");
    expect(html).toContain(cardImage(BAD));
    expect(html).toContain(cardImage(CARD_ID));
    expect(html).toContain('alt="Shockwave Zzz M19 156"');
    expect(html).toContain('alt="Frame 2 of 2, decided here"');
    expect(html).toContain('title="Frame 1, -110 ms"');
    expect(html.match(/class="frame[^"]*decided/g)).toHaveLength(1);
    expect(html).toContain("Nothing decided");
  });

  it("reads a path of '' as beside the report, and '.' as the folder itself", () => {
    const one = results([run({ id: "s 1" })]);
    const beside = reportHtml(one, null, { frames: "" });
    expect(beside).toContain('src="s%201/00.jpg"');
    expect(beside).not.toContain('src="/');
    const dot = reportHtml(one, null, { frames: "." });
    expect(dot).toContain('src="./s%201/00.jpg"');
  });

  it("escapes a name and an error, which are never markup", () => {
    const html = reportHtml(
      results([
        run({
          card: { id: "c", set: "s", number: "1", lang: "en", name: `<img src=x onerror=alert(1)> & "Co"` },
          passes: [pass("As scanned", "error", { error: "<script>bad()</script>" }), pass("Neural", "printing")],
        }),
      ]),
      null,
      paths,
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>bad()");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;");
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
  });

  it("renders hostile file contents as text and nothing else", () => {
    const hostile = {
      ...results([
        run({
          id: "h1",
          frames: "<i>3</i>" as unknown as number,
          decided_differs: "<u>2</u>" as unknown as number,
          mode: '<b>fast" onload="x' as never,
          then_frames: [{ ms: "<m>" as unknown as number, ok: true, decided: null }],
          passes: [
            pass("As scanned", "weird" as never, {
              first_decision_frame: "<f>" as unknown as number,
              confidence: "<c>" as unknown as number,
              distance: "<d>" as unknown as number,
              got: { id: 'x" onload="y', name: "<script>g()</script>", set: "<s>", number: "<n>" },
              frames: [{ ok: true, confidence: null, distance: null, decided: null, error: '"><e>' }],
            }),
            pass("Neural", "printing"),
          ],
        }),
      ]),
      commit: "<commit>",
      skipped: [{ id: '"><script>s()</script>', why: "<why>" }],
    } as Results;
    const html = reportHtml(hostile, hostile, paths);
    expect(html).not.toContain('" onload=');
    expect(html).not.toMatch(/<[^>]*\sonload=/);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain("undefined");
    const loose = /<(i|u|m|f|c|d|e|s|n)>|<b>fast/.exec(html);
    expect(loose && html.slice(loose.index - 60, loose.index + 40)).toBeNull();
    expect(html).toContain("Unknown result");
    expect(html).toContain('data-score="error"');
  });

  it("marks what changed since a baseline and counts it in the tiles", () => {
    const base = results([run({ id: "a", scores: ["wrong", "printing"] }), run({ id: "b" })]);
    const now = results([run({ id: "a" }), run({ id: "b" })]);
    const html = reportHtml(now, base, paths);
    expect(html.match(/<article[^>]*data-changed="yes"/g)).toHaveLength(1);
    expect(html).toContain("wrong → printing");
    expect(html).toContain("+50.0");
  });

  it("draws a falling tile as a fall, and a move as a change", () => {
    const base = results([run({ id: "a" }), run({ id: "b", scores: ["undecided", "printing"] })]);
    const now = results([run({ id: "a", scores: ["wrong", "printing"] }), run({ id: "b", scores: ["card", "printing"] })]);
    const html = reportHtml(now, base, paths);
    expect(html).toContain('class="delta down">−50.0');
    expect(html).toContain("undecided → card");
    expect(html.match(/<article[^>]*data-changed="yes"/g)).toHaveLength(2);
  });

  it("compares the tiles over the scans both results hold, and says so", () => {
    const base = results([run({ id: "a" }), run({ id: "gone", scores: ["wrong", "wrong"] })]);
    const now = results([run({ id: "a" }), run({ id: "new" })]);
    const html = reportHtml(now, base, paths);
    expect(html).toContain("over the 1 scans in both");
    expect(html).not.toContain('class="delta');
    expect(reportHtml(now, now, paths)).not.toContain("scans in both");
  });

  it("shows a dash, not a percent sign, when no scan replayed", () => {
    const all = results([run({ scores: ["error", "error"] })]);
    const html = reportHtml(all, all, paths);
    expect(html).toContain('<p class="big">—</p>');
    expect(html).not.toContain("—%");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain('class="delta');
    expect(html).toContain('data-filter="error"');
  });

  it("draws a tile and a card for each of the two passes, beside the expected card", () => {
    const html = reportHtml(results([run()]), null, paths);
    expect(html.match(/<section class="tile"><h2>([^<]*)<\/h2>/g)).toEqual([
      '<section class="tile"><h2>As scanned</h2>',
      '<section class="tile"><h2>Neural</h2>',
    ]);
    expect(html.match(/<h4>[^<]*<\/h4>/g)).toEqual(["<h4>Expected</h4>", "<h4>As scanned</h4>", "<h4>Neural</h4>"]);
    expect(styleOf(html)).toContain(".cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))");
    expect(html).toContain("scanned in neural");
    expect(reportHtml(results([run({ mode: "exact" })]), null, paths)).toContain("scanned in exact");
  });

  it("keeps chip text readable (4.5:1) on every chip colour in both colour schemes", () => {
    const style = styleOf(reportHtml(results([run()]), null, paths));
    const light = style.match(/^\s*:root\{([^}]*)\}/)![1];
    const dark = style.match(/prefers-color-scheme:dark\)\{:root\{([^}]*)\}/)![1];
    const token = (block: string, name: string) => block.match(new RegExp(`--${name}:(#[0-9a-f]{6})`, "i"))![1];
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const [scheme, block] of [["light", light], ["dark", dark]] as const) {
      for (const bg of ["good", "warn", "bad", "idle"]) {
        expect(ratio(token(block, "on-chip"), token(block, bg)), `${bg} in ${scheme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(style).toContain("color:var(--on-chip)");
  });

  it("says what a frame's outline and mark mean, in words", () => {
    const html = reportHtml(results([run({ frames: 12 })]), null, paths);
    expect(html).toMatch(/class="legend"/);
    for (const word of ["a decision was made here", "frame failed"]) expect(html).toContain(word);
    for (const gone of ["acquiring", "no lock", "lock-", "detail picture"]) expect(html).not.toContain(gone);
    expect(html).toContain('alt="Frame 1 of 12"');
    expect(html).toContain('alt="Frame 9 of 12, decided here"');
  });

  it("filters by any pass, by change and by search, and says so", () => {
    expect(matchesFilter("all", "", "no", "bolt x", "")).toBe(true);
    expect(matchesFilter("wrong", "wrong card", "no", "bolt", "")).toBe(true);
    expect(matchesFilter("card", "wrong", "no", "bolt", "")).toBe(false);
    expect(matchesFilter("error", "error", "no", "bolt", "")).toBe(true);
    expect(matchesFilter("changed", "", "yes", "bolt", "")).toBe(true);
    expect(matchesFilter("changed", "wrong", "no", "bolt", "")).toBe(false);
    expect(matchesFilter("all", "", "no", "lightning bolt", "bolt")).toBe(true);
    expect(matchesFilter("all", "", "no", "lightning bolt", "shock")).toBe(false);
    const html = reportHtml(results([run()]), null, paths);
    expect(html).toContain("any pass");
    expect(html).toContain("No scans match.");
    expect(html).toContain('aria-live="polite"');
    // The page's own script is built from the very source the predicate above was made from.
    expect(html).toContain(FILTER_SRC);
  });

  it("holds long unbroken text", () => {
    const style = styleOf(reportHtml(results([run()]), null, paths));
    for (const selector of [".card.none", ".id", "code"]) {
      expect(style).toMatch(new RegExp(`${selector.replace(".", "\\.")}[^{]*\\{[^}]*overflow-wrap:anywhere`));
    }
  });

  it("uses the grey box, not a picture, for an id it cannot address", () => {
    const html = reportHtml(results([run({ card: { id: "card-1", set: "s", number: "1", lang: "en", name: "N" } })]), null, paths);
    expect(html).not.toContain('src=""');
    expect(html).toContain(cardImage(gotId("printing")));
  });

  it("is one document that asks nothing of a server", () => {
    const html = reportHtml(results([run()]), null, paths);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
  });

  it("marks the frame of the decision that was scored, and says when the decision changed", () => {
    const changed = pass("As scanned", "printing", { first_decision_frame: 3, decision_frame: 7, decisions: 2 });
    const html = reportHtml(results([run({ frames: 8, passes: [changed, pass("Neural", "printing")] })]), null, paths);
    expect(html).toContain("first decided at frame 3, changed by frame 7");
    expect(html).toContain('alt="Frame 7 of 8, decided here"');
    expect(html).not.toContain('alt="Frame 3 of 8, decided here"');
    const same = reportHtml(results([run()]), null, paths);
    expect(same).not.toContain("changed by frame");
  });

  it("marks a frame that failed, in the strip and in words", () => {
    const failing = pass("As scanned", "error", {
      error: "frame 2: decode: bad jpeg",
      frames: [
        { ok: true, confidence: null, distance: null, decided: null, error: null },
        { ok: false, confidence: null, distance: null, decided: null, error: "decode: <bad>" },
      ],
    });
    const html = reportHtml(results([run({ frames: 2, passes: [failing, pass("Neural", "printing")] })]), null, paths);
    expect(html.match(/class="frame-error"/g)).toHaveLength(1);
    expect(html).toContain("failed: decode: &lt;bad&gt;");
    expect(html).toContain('alt="Frame 2 of 2, failed: decode: &lt;bad&gt;"');
    expect(html).toContain("frame failed");
  });

  it("reads a replay that cannot be compared frame by frame as such", () => {
    const html = reportHtml(results([run({ decided_differs: null }), run({ id: "b", decided_differs: 2 })]), null, paths);
    expect(html).toContain("replay not comparable frame by frame");
    expect(html).toContain("2 frames replayed differently");
    expect(html).not.toContain("null");
  });

  it("tells one story of a decision the scanner made and then lost", () => {
    const lost = pass("As scanned", "undecided", { first_decision_frame: 7, decision_frame: 7 });
    const html = reportHtml(results([run({ frames: 8, passes: [lost, pass("Neural", "printing")] })]), null, paths);
    expect(html).toMatch(/data-score="undecided">Decided, then lost/);
    expect(html).not.toContain("Nothing decided");
    expect(html).toContain("decided at frame 7, nothing held at the end");
    expect(html).toContain('alt="Frame 7 of 8, a decision was made here"');
    expect(html).not.toContain("decided here");
    expect(html).toContain("a decision was made here");
    expect(html).toContain("of which 1 decided, then lost");
    const held = reportHtml(results([run({ frames: 8, passes: [pass("As scanned", "printing", { first_decision_frame: 7 }), pass("Neural", "printing")] })]), null, paths);
    expect(held).toContain('alt="Frame 7 of 8, decided here"');
    expect(held).not.toContain("decided, then lost");
  });

  it("keeps every tile label beside its value, notes included", () => {
    const runs = [run({ id: "a", passes: [pass("As scanned", "undecided", { decision_frame: 4, first_decision_frame: 4 })] })];
    const html = reportHtml(results(runs), null, paths);
    for (const dl of html.match(/<dl>[\s\S]*?<\/dl>/g)!) {
      expect(dl.replace(/<dt>[^<]*<\/dt><dd>[\s\S]*?<\/dd>/g, "").replace(/\s+/g, "")).toBe("<dl></dl>");
    }
    expect(html).not.toContain('<dt class="sub"');
    expect(html).toMatch(/<dd>1<span class="sub">of which 1 decided, then lost<\/span>/);
  });

  it("keeps a missing frame picture the shape of a frame", () => {
    const style = styleOf(reportHtml(results([run()]), null, paths));
    expect(style).toContain("height:84px;aspect-ratio:16/9;object-fit:cover;background:var(--line)");
  });

  it("builds the command that removes the scans picked, in the order given", () => {
    expect(removeCommand(["a-1", "b_2"])).toBe("pnpm scanner:corpus remove a-1 b_2");
  });

  it("leaves out an id the corpus tool would refuse: ids in results.json come from a file", () => {
    const command = removeCommand(["ok", "x; rm -rf /", "../up", "a b", "", "$(id)", "fine-2"]);
    expect(command).toBe("pnpm scanner:corpus remove ok fine-2");
    expect(removeCommand([])).toBe("pnpm scanner:corpus remove");
  });

  it("leaves out an id that would read as a flag, and keeps the real shape of an id", () => {
    expect(removeCommand(["a", "--yes", "--from-file", "-x"])).toBe("pnpm scanner:corpus remove a");
    const real = "20261011T101500Z-9f8a0c1d2e3f4a5b";
    expect(removeCommand([real])).toBe(`pnpm scanner:corpus remove ${real}`);
    expect(reportHtml(results([run({ id: real })]), null, paths)).toContain(`class="pick" value="${real}"`);
  });

  it("draws no box on a scan whose id would read as a flag", () => {
    const html = reportHtml(results([run({ id: "--yes" }), run({ id: "-x" }), run({ id: "fine" })]), null, paths);
    expect(html.match(/class="pick"/g)).toHaveLength(1);
    expect(html).not.toContain('value="--yes"');
  });

  it("gives each scan a labelled box, and the bar a count, a copy button, a clear button and the note", () => {
    const html = reportHtml(
      results([run({ id: "scan-1" }), run({ id: "scan-2", card: { id: CARD_ID, set: "2x2", number: "1", lang: "en", name: "Shock" } })]),
      null,
      paths,
    );
    expect(html).toContain('aria-label="Select Lightning Bolt, scan scan-1"');
    expect(html).toContain('aria-label="Select Shock, scan scan-2"');
    expect(html.match(/<input type="checkbox" class="pick"/g)).toHaveLength(2);
    expect(html).toContain("Copy remove command");
    expect(html).toContain(">Clear</button>");
    expect(html).toContain("selected");
    expect(html).toContain("This page deletes nothing. Run the command yourself; it lists what it would delete, and deletes with --yes.");
    expect(html).toMatch(/<input type="text" class="cmd" readonly hidden/);
    expect(html).toContain('class="said" aria-live="polite"');
  });

  it("gives no box to a scan whose id the tool would refuse, and escapes the name in the label", () => {
    const html = reportHtml(results([run({ id: 'x"><b>', card: { id: CARD_ID, set: "s", number: "1", lang: "en", name: '<i>"N"' } }), run({ id: "fine" })]), null, paths);
    expect(html.match(/class="pick"/g)).toHaveLength(1);
    expect(html).toContain('value="fine"');
    expect(html).not.toContain("<i>");
  });

  it("makes no request: the script only writes to the clipboard", () => {
    const script = reportHtml(results([run()]), null, paths).match(/<script>([\s\S]*)<\/script>/)![1];
    expect(script).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|location\./);
  });
});
