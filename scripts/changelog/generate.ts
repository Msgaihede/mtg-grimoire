import type { Entry } from "./collect.ts";
import type { NotesAnswer } from "./notes.ts";
import type { Message } from "./openrouter.ts";
// One release's entries into its checked notes
// (docs/superpowers/specs/2026-10-11-generated-release-notes-design.md, §5 "Check").
//
// Ask, check, and on a failed check ask once more with what failed. A second failure is an
// error and there is no file: a note nobody could hold to its pull requests is worse than
// release-please's, which is what a release without a file publishes.
//
// `ask(messages)` is the model; it is passed in, so `generate.test.ts` needs no key.
import { MAINTENANCE, problems, render } from "./notes.ts";
import { input, instructions, retryMessage } from "./prompt.ts";

export class NotesError extends Error {
  declare problems: string[];
  constructor(version: string, failed: string[]) {
    super(`the notes for ${version} failed their checks twice:\n- ${failed.join("\n- ")}`);
    this.name = "NotesError";
    this.problems = failed;
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * `{ markdown, answer, attempts }` for one release.
 *
 * `entries` is `collect`'s answer; `ask(messages)` resolves to the model's text. With no entries
 * nothing is asked: the release holds nothing but itself.
 */
export async function notesFor({
  version,
  entries,
  ask,
}: {
  version: string;
  entries: Entry[];
  ask: (messages: Message[]) => Promise<string>;
}) {
  if (entries.length === 0) return { markdown: `${MAINTENANCE}\n`, answer: null, attempts: 0 };

  const ids = entries.map((entry) => entry.id);
  const messages: Message[] = [
    { role: "system", content: instructions() },
    { role: "user", content: input(entries, version) },
  ];
  let failed: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await ask(messages);
    const answer = parse(text);
    failed = answer === undefined ? ["the answer is not JSON"] : problems(answer, ids);
    if (failed.length === 0)
      return {
        markdown: render(answer as NotesAnswer),
        answer: answer as NotesAnswer,
        attempts: attempt,
      };
    messages.push(
      { role: "assistant", content: text },
      { role: "user", content: retryMessage(failed) },
    );
  }
  throw new NotesError(version, failed);
}
