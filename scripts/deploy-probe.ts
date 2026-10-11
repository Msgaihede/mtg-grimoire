export interface Probe {
  name: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  status: number;
  says?: string;
  type?: string;
  allowOrigin?: string | null;
  means?: Record<number, string>;
}
export interface ProbeAnswer {
  status: number;
  type: string | null;
  body: string;
  allowOrigin: string | null;
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    return cause !== null &&
      typeof cause === "object" &&
      "message" in cause &&
      typeof cause.message === "string"
      ? cause.message
      : error.message;
  }
  return String(error);
}
// What a Worker's post-deploy probe is made of — `relay-deploy-probe.ts` and
// `share-deploy-probe.ts`, which `release.yml` runs the moment a `wrangler deploy` returns.
//
// A probe is a request any stranger could make and the answer this tree's router gives it:
//
//   { name, path, method?, headers?, body?, status, says?, type?, allowOrigin?, means? }
//
// `says` is a piece of the body; `type` the start of the content type; `allowOrigin` the
// `Access-Control-Allow-Origin` it must carry, or `null` for *must not carry one* (left out, it
// is not looked at); `means` says what a wrong status is known to mean, by status.
//
// **Nothing here holds a token.** The functions are pure but `askAll`, whose `send` a test
// replaces with the Worker's own `fetch` — so each probe's expectation is held to the code it
// will be asked of, in a pull request, before a release asks the host.
import { appendFileSync } from "node:fs";

/** How long one request may take, connection to last byte (`PROBE_TIMEOUT_MS`). */
export const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 15_000);

export function requestOf(origin: string, probe: Probe) {
  return new Request(`${origin}${probe.path}`, {
    method: probe.method ?? "GET",
    headers: {
      "cache-control": "no-cache",
      ...(probe.body === undefined ? {} : { "content-type": "application/json" }),
      ...probe.headers,
    },
    body: probe.body,
    // A redirect is an answer that is not the expected one, and is reported as one.
    redirect: "manual",
  });
}

export async function answerOf(response: Response) {
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    body: await response.text(),
    allowOrigin: response.headers.get("access-control-allow-origin"),
  };
}

/** What is wrong with an answer, as sentences — none when it is the one the probe expects. */
export function problemsOf(probe: Probe, answer: ProbeAnswer) {
  const out = [];
  if (answer.status !== probe.status) {
    const meaning = probe.means?.[answer.status];
    out.push(
      `${probe.name}: answered ${answer.status}, not ${probe.status}${meaning ? ` — ${meaning}` : ""}`,
    );
    return out;
  }
  if (probe.says !== undefined && !answer.body.includes(probe.says)) {
    out.push(`${probe.name}: answered ${answer.status} without "${probe.says}"`);
  }
  if (probe.type !== undefined && !(answer.type ?? "").startsWith(probe.type)) {
    out.push(`${probe.name}: answered as ${answer.type ?? "no content type"}, not ${probe.type}`);
  }
  if ("allowOrigin" in probe && answer.allowOrigin !== probe.allowOrigin) {
    out.push(
      `${probe.name}: access-control-allow-origin is ${answer.allowOrigin ?? "absent"}, not ${probe.allowOrigin ?? "absent"}`,
    );
  }
  return out;
}

/** Ask every probe once, in order; everything that was wrong. */
export async function askAll(
  origin: string,
  probes: Probe[],
  send: (request: Request) => Promise<Response> = (request) =>
    fetch(request, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
) {
  const wrong = [];
  for (const probe of probes) {
    wrong.push(...problemsOf(probe, await answerOf(await send(requestOf(origin, probe)))));
  }
  return wrong;
}

/**
 * Ask until an attempt finds nothing wrong, or the attempts run out. The edge may answer with
 * the previous version, a 429 or a 5xx for a moment after a deploy returns: `PROBE_ATTEMPTS`
 * times (6), `PROBE_WAIT_MS` apart (10 s).
 */
export async function askUntil(
  once: () => Promise<string[]>,
  {
    attempts = Number(process.env.PROBE_ATTEMPTS ?? 6),
    wait = Number(process.env.PROBE_WAIT_MS ?? 10_000),
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = (line: string) => console.error(line),
  }: {
    attempts?: number;
    wait?: number;
    sleep?: (ms: number) => Promise<unknown>;
    log?: (line: string) => void;
  } = {},
) {
  // A probe that asks nothing passes everything: whatever `attempts` holds, the host is asked once.
  const tries = Number.isInteger(attempts) && attempts >= 1 ? attempts : 1;
  const pause = Number.isFinite(wait) && wait >= 0 ? wait : 10_000;
  let wrong: string[] = [];
  let asked = 0;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    asked = attempt;
    try {
      wrong = await once();
    } catch (error) {
      wrong = [`could not be asked: ${errorMessage(error)}`];
    }
    if (wrong.length === 0) break;
    log(`attempt ${attempt} of ${tries}: ${wrong.join("; ")}`);
    if (attempt < tries) await sleep(pause);
  }
  return { wrong, asked };
}

/** Print the outcome, write it to the step summary, and give the exit code. */
export function report(
  heading: { passed: string; failed: string },
  passedDetail: string,
  { wrong, asked }: { wrong: string[]; asked: number },
) {
  // Nothing wrong is only a pass if something was asked.
  const passed = wrong.length === 0 && asked > 0;
  const lines = passed
    ? [`### ${heading.passed}`, "", `Asked ${asked} time${asked === 1 ? "" : "s"}: ${passedDetail}`]
    : [
        `### ${heading.failed}`,
        "",
        asked === 0
          ? "The host was never asked."
          : `After ${asked} attempt${asked === 1 ? "" : "s"}:`,
        "",
        ...wrong.map((sentence) => `- ${sentence}`),
      ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
  return passed ? 0 : 1;
}
