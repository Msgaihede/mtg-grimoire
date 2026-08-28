import { useCallback, useEffect, useState, type JSX } from "react";
import { Download } from "lucide-react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import {
  DEFAULT_CAP_BYTES,
  IMAGE_CACHE,
  LEDGER_KEY,
  MAX_CAP_BYTES,
  parseLedger,
} from "@/pwa/imageLedger";
import { installState, promptInstall, type InstallState } from "@/pwa/install";
import { readPersistence, type PersistenceRecord } from "@/pwa/persistence";
import { isWebTarget } from "@/pwa/target";
import { formatBytes } from "@/lib/useUpdate";
import { cn } from "@/lib/utils";
import { BUTTON } from "./controls";
import { SettingsSection } from "./panelChrome";

/** The browser's own guess at what this origin is using. Printed; never acted on. */
export interface StorageEstimateView {
  usage?: number;
  quota?: number;
}

/** Everything this panel draws, gathered by {@link useWebStorage}. */
export interface WebStorageView {
  /** Whether the browser has offered an install, and whether one already happened. */
  install: InstallState;
  /** Show the browser's own install dialog. Must run from a click. */
  onInstall: () => void;
  /** What was written down the one time `persist()` was asked. */
  persistence: PersistenceRecord | null;
  /** `navigator.storage.persisted()`, read live — `null` while unread or unsupported. */
  persisted: boolean | null;
  /** `navigator.storage.estimate()`, or `null`. **Printed and nothing else.** */
  estimate: StorageEstimateView | null;
  /** The image cache's ceiling, in bytes. One of {@link CAP_OPTIONS}. */
  imageCap: number;
  /** What the ledger says is in the image cache, or `null` when it has not been read. */
  imageBytes: number | null;
  /** Move the ceiling. The worker evicts down to it immediately. */
  onImageCap: (bytes: number) => void;
}

/**
 * The three ceilings a reader is offered, from spec §5.4's "256 MB, reader-adjustable to 1 GB".
 *
 * The middle rung is this file's own: two options is a switch rather than a setting, and the
 * gap from 3 900 cards to 15 000 is wide enough that somebody wants to stand in it.
 */
export const CAP_OPTIONS: DropdownOption[] = [
  { value: String(DEFAULT_CAP_BYTES), label: "256 MB (about 3,900 cards)" },
  { value: String(512 * 1_000_000), label: "512 MB (about 7,800 cards)" },
  { value: String(MAX_CAP_BYTES), label: "1 GB (about 15,000 cards)" },
];

/**
 * The three browser facts the panel shows, gathered in one place.
 *
 * Called unconditionally from `SettingsPage` — `CachePanel`/`useLocalCache`'s shape — and inert
 * on desktop, where `isWebTarget()` is a build-time constant and every read below is skipped.
 * The panel itself takes the result as a prop so that a test and a story can put it in any state
 * without a module mock.
 */
export function useWebStorage(): WebStorageView {
  const [install, setInstall] = useState<InstallState>(installState);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [estimate, setEstimate] = useState<StorageEstimateView | null>(null);
  const [imageCap, setImageCap] = useState(DEFAULT_CAP_BYTES);
  const [imageBytes, setImageBytes] = useState<number | null>(null);

  useEffect(() => {
    if (!isWebTarget()) return;
    // Set from a listener rather than from the effect body: the browser fires these long after
    // this panel mounts, and reading the latch once on mount would freeze the row at whatever
    // it said then.
    const sync = () => setInstall(installState());
    window.addEventListener("beforeinstallprompt", sync);
    window.addEventListener("appinstalled", sync);

    let live = true;
    const storage = navigator.storage as StorageManager | undefined;
    void storage?.persisted?.().then((p) => live && setPersisted(p));
    void storage?.estimate?.().then((e) => live && setEstimate(e));

    // The ledger is the only thing that knows what is in the image cache; the worker keeps it
    // and this reads it. A cache that has never been opened parses to an empty ledger at the
    // default cap, which is the right answer rather than a failure.
    void caches
      .open(IMAGE_CACHE)
      .then((cache) => cache.match(LEDGER_KEY))
      .then(async (stored) => parseLedger(stored ? await stored.text() : null))
      .then((ledger) => {
        if (!live) return;
        setImageCap(ledger.cap);
        setImageBytes(ledger.bytes);
      })
      .catch(() => {
        // No Cache Storage at all (a private window in some browsers). The row shows the
        // default and the picker still works — the worker is what enforces it.
      });

    return () => {
      live = false;
      window.removeEventListener("beforeinstallprompt", sync);
      window.removeEventListener("appinstalled", sync);
    };
  }, []);

  const onInstall = useCallback(() => {
    void promptInstall().then(() => setInstall(installState()));
  }, []);

  const onImageCap = useCallback((bytes: number) => {
    setImageCap(bytes);
    // The worker is what enforces it, and it is the only thing that can: the page has no
    // business deleting entries out from under a `fetch` handler that is reading the ledger.
    navigator.serviceWorker?.controller?.postMessage({ type: "SET_IMAGE_CAP", bytes });
  }, []);

  return {
    install,
    onInstall,
    persistence: isWebTarget() ? readPersistence(localStorage) : null,
    persisted,
    estimate,
    imageCap,
    imageBytes,
    onImageCap,
  };
}

/**
 * What this browser is doing with the app's data — and what it will not promise.
 *
 * Web only: none of these rows means anything in a window that owns its own disk.
 *
 * **The estimate is printed and gates nothing, and that is the spike's measurement rather than
 * caution.** `navigator.storage.estimate()` reported 647 MB during a fill and **7 MB**
 * immediately after a restart, against a file that was 532.8 MB both times, and reported an
 * identical 10 887.0 MB quota on a desktop workstation and on a phone. A pre-flight built on it
 * would refuse a sync that would have worked and allow one that could not.
 *
 * **The install row's honest state is the common one.** Chrome gates its offer behind an
 * engagement heuristic nobody can query, and Firefox on desktop does not offer an install at
 * all — so "your browser has not offered one" is what most readers will see, and it is true.
 */
export function WebStoragePanel({ storage }: { storage: WebStorageView }): JSX.Element {
  const { install, onInstall, persistence, persisted, estimate } = storage;
  const { imageCap, imageBytes, onImageCap } = storage;

  return (
    <SettingsSection id="web-storage" title="This browser">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-dim">
          {install === "installed"
            ? "Installed. The app opens in its own window and works offline."
            : install === "offered"
              ? "This browser can install the app, so it opens in its own window."
              : "Your browser has not offered an install for this app."}
        </p>
        {install === "offered" && (
          <button
            type="button"
            onClick={onInstall}
            className={cn(BUTTON, "border-border hover:bg-bg")}
          >
            <Download className="size-4" aria-hidden="true" />
            Install app
          </button>
        )}
      </div>

      <div className="space-y-1">
        <p className="text-sm text-text">
          {(persisted ?? persistence?.granted) === true
            ? "The browser has agreed to keep this site's data."
            : "The browser may clear this site's data to free space."}
        </p>
        <p className="text-sm text-dim">
          {estimate?.usage === undefined
            ? "The browser has not reported an estimate."
            : `The browser estimates ${formatBytes(estimate.usage)} in use.`}{" "}
          Browsers report this loosely; it is not a measurement of your database.
        </p>
      </div>

      {/* **The one number on this panel that is a measurement rather than a guess.** It is the
          ledger's own running total, kept by the service worker as it caches each file — so
          unlike the estimate above it can be acted on, and it is the row that has a control
          beside it. Desktop is uncapped and has no row of its own; that difference is the
          filesystem's. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <label htmlFor="image-cap" className="block text-sm text-text">
            Card pictures kept on this device
          </label>
          <p className="text-sm text-dim">
            {imageBytes === null
              ? "Nothing has been cached yet."
              : `${formatBytes(imageBytes)} cached. The oldest are removed first when the limit is reached.`}
          </p>
        </div>
        <Dropdown
          id="image-cap"
          label="Card pictures kept on this device"
          value={String(imageCap)}
          onChange={(value) => onImageCap(Number(value))}
          options={CAP_OPTIONS}
        />
      </div>
    </SettingsSection>
  );
}
