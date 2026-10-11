import { describe, expect, it } from "vitest";
import { NotesError, notesFor } from "./generate.mjs";
import { MAINTENANCE } from "./notes.mjs";

const ENTRIES = [
  { id: "#860", title: "feat(android): pairing", body: "what it does" },
  { id: "#848", title: "docs: a plan", body: "" },
];
const good = {
  highlights: [],
  new: [{ area: "Android", text: "sync turns on by pairing with another device", refs: ["#860"] }],
  changed: [],
  fixed: [],
  omitted: [{ ref: "#848", reason: "planning document" }],
};
const forgetful = { ...good, omitted: [] };

/** An `ask` that answers from a list and keeps a copy of what it was sent each time. */
function scripted(...answers) {
  const sent = [];
  return {
    sent,
    ask: async (messages) => {
      sent.push(messages.map((message) => ({ ...message })));
      return answers.shift();
    },
  };
}

describe("notesFor", () => {
  // Review Focus 3: a range that holds only its own release PR has nothing to ask about.
  it("writes the maintenance line without asking when there is nothing to read", async () => {
    const io = scripted();
    expect(await notesFor({ version: "0.38.0", entries: [], ask: io.ask })).toEqual({
      markdown: `${MAINTENANCE}\n`,
      answer: null,
      attempts: 0,
    });
    expect(io.sent).toEqual([]);
  });

  it("renders an answer that passes, in one request", async () => {
    const io = scripted(JSON.stringify(good));
    const result = await notesFor({ version: "0.44.0", entries: ENTRIES, ask: io.ask });
    expect(result.markdown).toBe(
      "### New\n\n- **Android:** sync turns on by pairing with another device (#860)\n",
    );
    expect(result.answer).toEqual(good);
    expect(result.attempts).toBe(1);
    expect(io.sent[0].map((message) => message.role)).toEqual(["system", "user"]);
    expect(io.sent[0][1].content).toContain("Release 0.44.0: 2 entries");
  });

  it("sends a failed answer back once, with what failed", async () => {
    const io = scripted(JSON.stringify(forgetful), JSON.stringify(good));
    const result = await notesFor({ version: "0.44.0", entries: ENTRIES, ask: io.ask });
    expect(result.attempts).toBe(2);
    expect(io.sent[1].map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(io.sent[1][2].content).toBe(JSON.stringify(forgetful));
    expect(io.sent[1][3].content).toContain("#848 is neither cited by an item nor listed in omitted");
  });

  it("fails after a second answer that does not pass, and says why", async () => {
    const io = scripted(JSON.stringify(forgetful), JSON.stringify(forgetful));
    const error = await notesFor({ version: "0.44.0", entries: ENTRIES, ask: io.ask }).catch((e) => e);
    expect(error).toBeInstanceOf(NotesError);
    expect(error.problems).toEqual(["#848 is neither cited by an item nor listed in omitted"]);
    expect(error.message).toContain("the notes for 0.44.0 failed their checks twice");
    expect(io.sent).toHaveLength(2);
  });

  it("treats text that is not JSON as a failed answer", async () => {
    const io = scripted("Here are the notes:", JSON.stringify(good));
    const result = await notesFor({ version: "0.44.0", entries: ENTRIES, ask: io.ask });
    expect(result.attempts).toBe(2);
    expect(io.sent[1][3].content).toContain("the answer is not JSON");
  });
});
