import { useState } from "react";
import { browserCore } from "@/lib/core/browser";

/** Scryfall's bulk descriptor for the everything-printing file. `Access-Control-Allow-Origin: *`
 *  — verified 2026-08-27, and it is the only reason a browser can build its own corpus. */
export const BULK_DESCRIPTOR_URL = "https://api.scryfall.com/bulk-data/default_cards";

/**
 * The first run: there is a database and it has no cards in it.
 *
 * **Measured, so the reader is told what they are agreeing to.** 74.4 MB gzipped in, 598.8 MB
 * of JSON out, 117 464 rows, ~10.4 s on a desktop and ~36.5 s on a flagship phone
 * (2026-08-27, Chrome 151, release wasm). The count below is the honest progress signal: it
 * is the same 2 000-row batch that bounds how long the database connection is held.
 *
 * **Nothing here asks `navigator.storage.estimate()`.** It reported 647 MB during a fill and
 * 7 MB immediately after a restart, against a file that was 532.8 MB both times, and the same
 * quota on a desktop and a phone. It is not a pre-flight and must never gate an ingest.
 */
export function BuildCorpus({ onDone }: { onDone: () => void }) {
  const [inserted, setInserted] = useState<number | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const running = inserted !== undefined && failed === undefined;

  const start = () => {
    setFailed(undefined);
    setInserted(0);
    void browserCore.buildCorpus(BULK_DESCRIPTOR_URL, setInserted).then(onDone, (e: Error) => {
      setFailed(e.message);
      setInserted(undefined);
    });
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold">Build the card database</h1>
        <p className="text-muted-foreground">
          MTG Grimoire builds its own copy of Scryfall&rsquo;s card data on this device. It is
          about 75 MB to download and takes under a minute on a desktop.
        </p>
        {failed !== undefined && <p role="alert">{failed}</p>}
        {running ? (
          <p aria-live="polite">{inserted.toLocaleString("en-US")} cards</p>
        ) : (
          <button
            type="button"
            onClick={start}
            className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
          >
            Build it now
          </button>
        )}
      </div>
    </main>
  );
}
