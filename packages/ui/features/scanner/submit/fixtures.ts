import { STATUS, VERDICTS } from "../fixtures";
import type { ScanStill } from "./still";

/**
 * A picture for the dialog's stories: 64×36, a pale card with a red picture on it, lying a
 * little askew on dark felt. **Drawn, not photographed** — a real camera frame is somebody's desk,
 * and a story file is not where one of those is kept. 884 bytes of JPEG as the base64 a still
 * carries, so the workbench draws a picture where a test only needs a string.
 */
export const STILL_PICTURE =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDABQODxIPDRQSERIXFhQYHzMhHxwcHz8tLyUzSkFOTUlBSEZSXHZkUldvWEZIZoxob3p9hIWET2ORm4+AmnaBhH//2wBDARYXFx8bHzwhITx/VEhUf39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f3//wAARCAAkAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDm6KKKBE9raTXkhjgTcwGTyBx+NaCeHbxuXaJB7t/9aotBYjUNgODJGy/pn+lSszMfmYk+5rOUmjWnT5iVNAhDAS36ZJxtUDP86x7iLyLiWLrsYr+RrTRtjq3oQara0mzVJwOhIb8wDRGTYVIKOxRooorQyCiiigC3pUnl6lbN/tgfnx/Wul/seEsS0jnJzgYFcjG5jkVx1Ug134IIBHQ1nM0hJrYprpdqvVC31Y1g+JY9moIwHDRj9CRXVdK5zxOY3a3ZHVmG4EA5I6f/AF6Udwk21qYNFFFamYUUUUAFW21O9ZQv2mQADA2nH8qKKQFd5ZJP9ZIzf7xzTKKKYBRRRQB//9k=";

/**
 * What a press on *Send scan…* froze, two ways.
 *
 * - `wrongPrinting` — Exact could not split three reprints of Lightning Bolt and led with one.
 *   The state the press exists for, and the one whose search finds printings in the workbench's
 *   corpus: its four Bolts are sold one, two, one and three ways, which is every shape the
 *   finish group takes.
 * - `nothingNamed` — the scanner had no card in frame, or recognition was stopped. Every figure
 *   it would have sent is `null`, and the search box opens empty.
 */
export const STILLS = {
  wrongPrinting: {
    frame: STILL_PICTURE,
    said: {
      reported: VERDICTS.exactAmbiguous.decision?.printing ?? null,
      mode: "exact",
      confidence: 1,
      distance: 36,
      bundle: STATUS.present.labels,
    },
    leadName: "Lightning Bolt",
  },
  nothingNamed: {
    frame: STILL_PICTURE,
    said: { reported: null, mode: "fast", confidence: null, distance: null, bundle: null },
    leadName: "",
  },
} satisfies Record<string, ScanStill>;
