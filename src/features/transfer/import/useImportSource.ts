/**
 * The import's first step as state with no drawing: the text in the box, how a file's text was
 * read, the parse, the one `import_resolve` press and which of the two steps is up.
 *
 * **Split out of `ImportDialog`'s body so a second shell can ask the same question.** The desktop
 * dialog and the light app's phone sheet draw the paste step differently — a 12px monospaced box
 * and a native file dialog behind Rust on one, a 16px box and a browser `<input type="file">` on
 * the other — and they must not differ about anything this hook decides: what the parser was
 * handed, which lines go to the resolver and in what shape, that Back throws the resolved rows
 * away, and that a file's encoding note dies with the first keystroke. **How a file is picked is
 * not here**: `takeFile` is what either shell calls once it has one.
 *
 * Store-free, and so is everything it reaches (`useImport`'s `resolve`, the parser).
 */
import { useMemo, useState } from "react";
import type { ImportFile, ImportResolveLine } from "@/lib/ipc";
import { languageCode } from "@/lib/languages";
import { parseDecklist, type ParsedList } from "./parse";
import { useImport } from "./useImport";

/** Which half of the import is up. Two steps in one panel rather than two dialogs: the second
 *  is entirely about the first, and Back has to keep what was pasted. */
export type ImportStep = "source" | "preview";

/**
 * Every parsed line as the resolver takes it.
 *
 * The `lang` is a CSV's `Language` cell, as a Scryfall code — a **preference** the resolver ranks
 * ahead of every other key, never a filter (issue #555). `null` for a decklist line, which has no
 * such column, and for a cell `languageCode` does not recognise: an unreadable language is no
 * preference rather than a reason to lose the card.
 */
export function resolveLinesOf(parsed: ParsedList): ImportResolveLine[] {
  return parsed.lines.map((line) => ({
    name: line.name,
    setCode: line.setCode,
    collectorNumber: line.collectorNumber,
    lang: languageCode(line.extra.lang),
  }));
}

export function useImportSource() {
  const [text, setText] = useState("");
  const [step, setStep] = useState<ImportStep>("source");
  /**
   * How the text in the box was read, while it is still the text a file read put there — `null`
   * from the first keystroke or paste on, because from then on it is the reader's text and a
   * sentence about how a file was decoded would be about something no longer on screen. Picking
   * another file replaces it **only when that read succeeds**: a cancelled picker or a refused
   * read leaves the old file's text in the box, so its reading still describes what is there.
   */
  const [readAs, setReadAs] = useState<ImportFile["encoding"] | null>(null);

  const { resolve } = useImport();
  const parsed = useMemo(() => parseDecklist(text), [text]);

  /** The reader's own edit of the box. */
  const type = (next: string) => {
    setText(next);
    setReadAs(null);
  };

  /** A file the shell has read, into the box — its text and how it was decoded. */
  const takeFile = (file: ImportFile) => {
    setText(file.text);
    setReadAs(file.encoding);
  };

  /** Back to the box, and the resolved rows go with it. They are addressed by **index** into
   *  `parsed.lines`, so rows kept across an edit of the text would file the whole list by line
   *  numbers that have moved. The destination's own mutation state goes with them, because its
   *  `Preview` unmounts — which is why nothing here has to reset it. */
  const toSource = () => {
    resolve.reset();
    setStep("source");
  };

  /** Resolve every line and, only once both reads have answered, cross to the preview. */
  const preview = () => {
    if (parsed.lines.length === 0) return;
    resolve.mutate(resolveLinesOf(parsed), { onSuccess: () => setStep("preview") });
  };

  return {
    text,
    type,
    takeFile,
    readAs,
    parsed,
    step,
    resolve,
    /** The resolver's answer, or `null` before it has one. */
    resolved: resolve.data ?? null,
    preview,
    toSource,
  };
}

export type ImportSource = ReturnType<typeof useImportSource>;
