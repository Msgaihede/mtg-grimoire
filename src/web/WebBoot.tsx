import { useEffect, useState } from "react";
import App from "@/App";
import { corpusState } from "@/pwa/corpusMark";
import { browserCore } from "@/lib/core/browser";
import type { Opened } from "@/workers/protocol";
import { AlreadyOpen } from "./AlreadyOpen";
import { BuildCorpus } from "./BuildCorpus";

/**
 * The OPFS folder the sahpool lives in. A bare name and not a path: the pool *is* the
 * filesystem.
 *
 * **A directory and no filename.** Schema 27 split the one database into two — `user.db`
 * holds the reader's own tables and `corpus.db` the rebuildable Scryfall ones — and the Rust
 * side opens that pair from fixed names. Naming a file here would be a second opinion about
 * which is which, and only one of them can be right.
 */
export const OPFS_DIRECTORY = "mtg-grimoire";

type Phase =
  | { at: "opening" }
  | { at: "already-open" }
  | { at: "failed"; message: string }
  | { at: "empty" }
  | { at: "ready" };

/**
 * The web build's root, and the only thing `main.tsx` renders differently.
 *
 * Four outcomes and one of them is not an error: a database that opened and holds no cards is
 * a first run, not a fault. The one that *is* refused — another tab holding the pool's access
 * handles — gets a sentence rather than a stack trace, per spec §5.2.
 *
 * `<App />` is mounted only once a corpus exists, so nothing inside it ever has to know that
 * an empty database was a state it could have been born into.
 */
export function WebBoot() {
  const [phase, setPhase] = useState<Phase>({ at: "opening" });

  useEffect(() => {
    let live = true;
    void browserCore.open(OPFS_DIRECTORY).then(async (opened: Opened) => {
      if (!live) return;
      if (opened.kind === "already-open") return setPhase({ at: "already-open" });
      if (opened.kind === "failed") return setPhase({ at: "failed", message: opened.message });
      const status = await browserCore.call<{ cardCount: number | null }>("sync_status");
      if (!live) return;
      setPhase({ at: (status.cardCount ?? 0) > 0 ? "ready" : "empty" });
    });
    return () => {
      live = false;
    };
  }, []);

  if (phase.at === "already-open") return <AlreadyOpen />;
  if (phase.at === "failed")
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-xl font-semibold">The card database would not open</h1>
          <p role="alert" className="text-muted-foreground">
            {phase.message}
          </p>
        </div>
      </main>
    );
  // **The empty screen has two meanings and `corpusMark` is what tells them apart.** The mark
  // lives in `localStorage`, which is the shell’s own storage rather than the corpus’s, so it
  // survives exactly the eviction it detects - and a browser that cleared everything cleared
  // it too, at which point "first run" is the truth.
  if (phase.at === "empty")
    return (
      <BuildCorpus onDone={() => setPhase({ at: "ready" })} reason={corpusState(0, localStorage)} />
    );
  if (phase.at === "ready") return <App />;
  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      Opening the card database&hellip;
    </main>
  );
}
