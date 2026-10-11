export interface NotesItem {
  area: string;
  text: string;
  refs: string[];
}
export interface Highlight {
  lead: string;
  text: string;
  refs: string[];
}
export interface NotesAnswer {
  highlights: Highlight[];
  new: NotesItem[];
  changed: NotesItem[];
  fixed: NotesItem[];
  omitted: { ref: string; reason: string }[];
}
// What the model answers, whether that answer is acceptable, and the markdown it becomes
// (docs/superpowers/specs/2026-10-11-generated-release-notes-design.md, §4 and §5).
//
// **The model returns data and code writes the file.** The shape of `changelog/<version>.md` is
// fixed here, in `render`, so the app's reader (`packages/ui/lib/releaseNotes.ts`) is reading
// something a program wrote and not something a model chose.
//
// **`problems` is the gate.** It holds the answer to the entries that were sent — every one
// cited or left out by name, no number made up — and to plain text on one line with no link in
// it. It does not, and cannot, hold the answer to the truth: that is the owner's read of the
// file on the release PR.
//
// Pure, so `notes.test.ts` needs nothing.

/** Where a user would notice a change. Closed, so the same thing is not filed two ways. */
export const AREAS = [
  "Decks",
  "Collection",
  "Wishlist",
  "Search",
  "Scanner",
  "Sync",
  "Import & export",
  "Sharing",
  "Prices",
  "Backup",
  "Settings",
  "Android",
  "Web",
  "General",
];

export const MAX_HIGHLIGHTS = 5;

/** The whole of a release's notes when nothing in it reaches a user. */
export const MAINTENANCE = "Maintenance release with no user-facing changes.";

/** The itemized sections, in the order they are written: the answer's key, then the heading. */
const SECTIONS: ["new" | "changed" | "fixed", string][] = [
  ["new", "New"],
  ["changed", "Changed"],
  ["fixed", "Fixed"],
];

const REFS = { type: "array", items: { type: "string" } };
const ITEMS = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["area", "text", "refs"],
    properties: { area: { type: "string", enum: AREAS }, text: { type: "string" }, refs: REFS },
  },
};

/**
 * The answer's JSON schema, sent as `response_format`. No numeric limit is in it — a provider's
 * strict mode refuses some — so "at most five" is {@link problems}' to hold.
 */
export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["highlights", "new", "changed", "fixed", "omitted"],
  properties: {
    highlights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["lead", "text", "refs"],
        properties: { lead: { type: "string" }, text: { type: "string" }, refs: REFS },
      },
    },
    new: ITEMS,
    changed: ITEMS,
    fixed: ITEMS,
    omitted: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "reason"],
        properties: { ref: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
};

/**
 * A link, in any form GitHub's release page or the app would make one of: a URL with any scheme,
 * a bare `www.`, a markdown link, and raw HTML — `<a href>`, `<img>`, a comment. An angle
 * bracket with a space after it (`a mana value < 3`) is none of those.
 *
 * Exported for `files.test.ts`, which holds every file in `changelog/` to the same rule.
 */
export const LINK = /:\/\/|www\.|\]\(|<[a-z/!]/i;
/**
 * What GitHub links by itself in a release body: `@someone` pings a person, and `#123` points at
 * whatever issue or pull request has that number. The renderer adds the real references.
 */
const MENTION = /@\w|#\d/;
/** An entry's id: a pull request's number, or a commit's seven characters. */
const ID = /^(?:#\d+|[0-9a-f]{7})$/;
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v: unknown) => typeof v === "string");
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What is wrong with the answer's shape. Anything here, and nothing else is looked at. */
function shapeProblems(answer: unknown) {
  if (!isObject(answer)) return ["the answer is not a JSON object"];
  const out = [];
  for (const key of ["highlights", "new", "changed", "fixed", "omitted"]) {
    if (!Array.isArray(answer[key])) out.push(`\`${key}\` is not a list`);
  }
  if (out.length) return out;
  (answer.highlights as unknown[]).forEach((entry, i) => {
    if (
      !isObject(entry) ||
      typeof entry.lead !== "string" ||
      typeof entry.text !== "string" ||
      !isStrings(entry.refs)
    ) {
      out.push(`highlights[${i}] is not { lead, text, refs }`);
    }
  });
  for (const [key] of SECTIONS) {
    (answer[key] as unknown[]).forEach((entry, i) => {
      if (
        !isObject(entry) ||
        typeof entry.area !== "string" ||
        typeof entry.text !== "string" ||
        !isStrings(entry.refs)
      ) {
        out.push(`${key}[${i}] is not { area, text, refs }`);
      }
    });
  }
  (answer.omitted as unknown[]).forEach((entry, i) => {
    if (!isObject(entry) || typeof entry.ref !== "string" || typeof entry.reason !== "string") {
      out.push(`omitted[${i}] is not { ref, reason }`);
    }
  });
  return out;
}

/**
 * What is wrong with anything the model wrote that is printed somewhere: it says something, and
 * it is one line. **One line is the rule a workflow's log needs**: there a line that opens
 * `::…::` is a command to the runner, and a reason is printed in one.
 */
function lineProblems(where: string, value: string) {
  if (value.trim() === "") return [`${where} is empty`];
  return /[\r\n]/.test(value) ? [`${where} is more than one line`] : [];
}

/** What is wrong with one text a reader will see. */
function textProblems(where: string, value: string) {
  const out = lineProblems(where, value);
  if (value.trim() === "") return out;
  if (LINK.test(value)) out.push(`${where} carries a link or a URL`);
  if (MENTION.test(value)) out.push(`${where} mentions a user or names an issue by number`);
  if (value.includes("**")) out.push(`${where} carries bold markup`);
  return out;
}

/**
 * Everything wrong with `answer`, as sentences the model can be sent back — none when it may be
 * rendered. `ids` are the entries that were sent.
 *
 * **No sentence here carries a line of the model's own.** They are printed in a workflow's log
 * when an answer fails twice: a ref is echoed only once it has an id's form, and an area goes
 * through `JSON.stringify`, which writes a line break as two characters.
 */
export function problems(value: unknown, ids: string[]) {
  const shape = shapeProblems(value);
  if (shape.length) return shape;
  const answer = value as NotesAnswer;

  const known = new Set(ids);
  const cited = new Set<string>();
  const out = [];
  /** The refs of `where` that are ids. One that is not is reported once, and never echoed. */
  const idsOf = (where: string, refs: string[]) => {
    const usable = refs.filter((ref) => ID.test(ref));
    if (usable.length !== refs.length) {
      out.push(`${where} has a ref that is not an id (#123, or a commit's seven characters)`);
    }
    return usable;
  };
  const unknown = (where: string, ref: string) => {
    if (!known.has(ref)) out.push(`${where} cites ${ref}, which is not an entry that was sent`);
  };

  for (const [key] of SECTIONS) {
    answer[key].forEach((entry, i) => {
      const where = `${key}[${i}]`;
      out.push(...textProblems(`${where}.text`, entry.text));
      if (!AREAS.includes(entry.area)) {
        const shown = JSON.stringify(entry.area.slice(0, 40));
        out.push(`${where}.area is ${shown}, which is not one of the areas`);
      }
      if (entry.refs.length === 0) out.push(`${where} cites no entry`);
      for (const ref of idsOf(where, entry.refs)) {
        unknown(where, ref);
        cited.add(ref);
      }
    });
  }

  if (answer.highlights.length > MAX_HIGHLIGHTS) {
    out.push(
      `there are ${answer.highlights.length} highlights, and at most ${MAX_HIGHLIGHTS} are allowed`,
    );
  }
  answer.highlights.forEach((entry, i) => {
    const where = `highlights[${i}]`;
    out.push(
      ...textProblems(`${where}.lead`, entry.lead),
      ...textProblems(`${where}.text`, entry.text),
    );
    // A lead is drawn between `**` and `**`, and `files.test.ts` holds every file to that: one
    // asterisk inside it would write a file the release PR's own checks refuse.
    if (entry.lead.includes("*") && !entry.lead.includes("**")) {
      out.push(`${where}.lead carries an asterisk, and a lead is drawn bold`);
    }
    if (entry.refs.length === 0) out.push(`${where} cites no entry`);
    for (const ref of idsOf(where, entry.refs)) {
      unknown(where, ref);
      if (known.has(ref) && !cited.has(ref)) {
        out.push(`${where} cites ${ref}, which no item under new, changed or fixed cites`);
      }
    }
  });

  const omitted = new Set<string>();
  answer.omitted.forEach((entry, i) => {
    out.push(...lineProblems(`omitted[${i}].reason`, entry.reason));
    for (const ref of idsOf(`omitted[${i}]`, [entry.ref])) {
      unknown(`omitted[${i}]`, ref);
      if (cited.has(ref)) out.push(`${ref} is both cited by an item and omitted`);
      omitted.add(ref);
    }
  });

  for (const id of ids) {
    if (!cited.has(id) && !omitted.has(id)) {
      out.push(`${id} is neither cited by an item nor listed in omitted`);
    }
  }
  return out;
}

/** ` (#854, #856)` for an item's pull requests, in order; nothing for direct commits alone. */
function references(refs: string[]) {
  const numbers = [
    ...new Set(refs.filter((ref) => /^#\d+$/.test(ref)).map((ref) => Number(ref.slice(1)))),
  ].sort((a, b) => a - b);
  return numbers.length ? ` (${numbers.map((n) => `#${n}`).join(", ")})` : "";
}

/**
 * A highlight's lead and its text are sentences: each closes with a mark of its own, or is given
 * a full stop. The first real answer (0.43.0) left every highlight's text open.
 */
const closed = (sentence: string) => (/[.!?]$/.test(sentence) ? sentence : `${sentence}.`);

/** A checked answer, as `changelog/<version>.md`. */
export function render(answer: NotesAnswer) {
  const blocks = [];
  if (answer.highlights.length) {
    blocks.push(
      [
        "### Highlights",
        "",
        ...answer.highlights.map((h) => `- **${closed(h.lead.trim())}** ${closed(h.text.trim())}`),
      ].join("\n"),
    );
  }
  for (const [key, title] of SECTIONS) {
    if (!answer[key].length) continue;
    blocks.push(
      [
        `### ${title}`,
        "",
        ...answer[key].map((e) => `- **${e.area}:** ${e.text.trim()}${references(e.refs)}`),
      ].join("\n"),
    );
  }
  return `${blocks.length ? blocks.join("\n\n") : MAINTENANCE}\n`;
}

/** What was left out and why, for the log and the summary. It is not in the file. */
export function omittedLines(answer: NotesAnswer | null) {
  return answer ? answer.omitted.map((entry) => `${entry.ref} — ${entry.reason}`) : [];
}
