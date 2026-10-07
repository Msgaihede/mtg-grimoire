import { SCANNER_ASSETS_PREFIX } from "./assets";
import type { Answered, ScanManifest, StoreEnv } from "./scanStore";
import type { CacheLike, CachesLike } from "./sw/pictures";

/**
 * **What the scanner's two suites stand a browser in with** (`scanStore.test.ts`,
 * `scanner.test.ts`): a Cache Storage, an origin that serves the three files, and a clock whose
 * timers the test fires. Not a test file — it has no cases — and nothing but those suites
 * imports it.
 */

const ORIGIN = "https://mtg-grimoire.app";

/** A Cache as the standard says one behaves where the scanner leans on it. */
export class FakeCache implements CacheLike {
  readonly entries = new Map<string, Response>();
  private abs = (key: string): string => new URL(key, ORIGIN).pathname;

  async match(key: string): Promise<Response | undefined> {
    return this.entries.get(this.abs(key))?.clone();
  }
  async put(key: string, response: Response): Promise<void> {
    this.entries.set(this.abs(key), response);
  }
  async delete(key: string): Promise<boolean> {
    return this.entries.delete(this.abs(key));
  }
  async keys(): Promise<{ url: string }[]> {
    return [...this.entries.keys()].map((path) => ({ url: ORIGIN + path }));
  }
}

export class FakeCaches implements CachesLike {
  readonly named = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let cache = this.named.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.named.set(name, cache);
    }
    return cache;
  }
  async keys(): Promise<string[]> {
    return [...this.named.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.named.delete(name);
  }
}

/** SHA-256 of nothing a test needs to be real: a digest that differs when the bytes do. */
export const digestOf = (bytes: Uint8Array): string => {
  let sum = 0;
  for (const byte of bytes) sum = (sum * 31 + byte) >>> 0;
  return sum.toString(16).padStart(8, "0").repeat(8);
};

/** The three files as an origin serves them: small, and each unlike the others. */
export const FILES: Record<string, Uint8Array> = {
  "card-hashes.bin": Uint8Array.from({ length: 700 }, (_, i) => i % 251),
  "text-detection.rten": Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256),
  "text-recognition.rten": Uint8Array.from({ length: 500 }, (_, i) => (i * 13) % 256),
};

export const MANIFEST: ScanManifest = {
  formatVersion: 3,
  files: [
    { key: "bundle", name: "card-hashes.bin", bytes: 700, sha256: digestOf(FILES["card-hashes.bin"]) },
    {
      key: "detectionModel",
      name: "text-detection.rten",
      bytes: 300,
      sha256: digestOf(FILES["text-detection.rten"]),
    },
    {
      key: "recognitionModel",
      name: "text-recognition.rten",
      bytes: 500,
      sha256: digestOf(FILES["text-recognition.rten"]),
    },
  ],
};

/** A response whose body arrives `chunk` bytes at a time. */
export function answered(
  body: Uint8Array | string,
  init: { status?: number; type?: string; chunk?: number } = {},
): Answered {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const status = init.status ?? 200;
  const chunk = init.chunk ?? 256;
  let at = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? (init.type ?? null) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (at >= bytes.length) return { done: true };
          const value = bytes.slice(at, at + chunk);
          at += chunk;
          return { done: false, value };
        },
        cancel: async () => undefined,
      }),
    },
    json: async () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
  };
}

/**
 * A browser the test owns: a Cache Storage, a clock whose timers run when the test says, and an
 * origin answering the manifest and the three files — each of which a test can replace.
 */
export function fakeBrowser(over: Partial<Record<string, () => Answered | Promise<Answered>>> = {}) {
  const caches = new FakeCaches();
  const asked: string[] = [];
  let now = Date.UTC(2026, 9, 7, 12);
  const timers: { at: number; run: () => void }[] = [];
  const served: Record<string, () => Answered | Promise<Answered>> = {
    [`${SCANNER_ASSETS_PREFIX}manifest.json`]: () =>
      answered(JSON.stringify(MANIFEST), { type: "application/json" }),
    ...Object.fromEntries(
      Object.entries(FILES).map(([name, bytes]) => [
        `${SCANNER_ASSETS_PREFIX}${name}`,
        () => answered(bytes),
      ]),
    ),
  };
  const env: StoreEnv = {
    caches,
    fetch: async (path) => {
      asked.push(path);
      const answer = over[path] ?? served[path];
      return answer ? answer() : answered("Not found", { status: 404, type: "text/plain" });
    },
    digest: async (bytes) => digestOf(bytes),
    after: (ms, run) => void timers.push({ at: now + ms, run }),
    now: () => now,
  };
  return {
    env,
    caches,
    asked,
    /** Move the clock on, running every timer that falls due — those a timer sets included. */
    advance(ms: number): void {
      const until = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) break;
        timers.shift();
        now = next.at;
        next.run();
      }
      now = until;
    },
  };
}

/** Let every promise already settled run its callbacks, a few turns deep. */
export async function settle(turns = 25): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}
