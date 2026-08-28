import { beforeEach, describe, expect, it } from "vitest";
import { CORPUS_KEY, corpusState, markCorpusBuilt } from "@/pwa/corpusMark";

beforeEach(() => localStorage.clear());

describe("what an empty database means", () => {
  it("is a first run when this browser has never had a corpus", () => {
    expect(corpusState(0, localStorage)).toBe("never-built");
  });

  /**
   * The state spec §5.4 names: the shell lives in Cache Storage and the corpus in OPFS, they are
   * evicted independently, and a reader who has been using this app can open it to an empty
   * database with the app itself perfectly intact. Telling them this is a first run would be a
   * lie about what happened to a month of syncing.
   */
  it("is an eviction when it has", () => {
    markCorpusBuilt(117_464, localStorage);
    expect(corpusState(0, localStorage)).toBe("evicted");
  });

  it("is neither while there are cards", () => {
    markCorpusBuilt(117_464, localStorage);
    expect(corpusState(117_464, localStorage)).toBe("present");
  });

  /**
   * `sync_status` answers `null` for a count it could not run, which is the normal state during
   * a sync. `SyncProgress` already refuses to treat that as empty — "treating it as empty would
   * black out a working 116 k-card app once a day" — and this must not undo that.
   */
  it("says nothing at all about a count that could not be read", () => {
    markCorpusBuilt(117_464, localStorage);
    expect(corpusState(null, localStorage)).toBe("present");
  });

  it("does not mark an empty sync as a corpus", () => {
    markCorpusBuilt(0, localStorage);
    expect(localStorage.getItem(CORPUS_KEY)).toBeNull();
    expect(corpusState(0, localStorage)).toBe("never-built");
  });

  it("treats an unreadable mark as never built rather than throwing", () => {
    localStorage.setItem(CORPUS_KEY, "{not json");
    expect(corpusState(0, localStorage)).toBe("never-built");
  });
});
