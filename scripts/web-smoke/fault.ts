// A browser fault: the run's browser breaking under it in a way that is the browser's and not the
// app's — how one is told from the browser's own output, and what a run does about it.
//
// **A module with nothing in it that runs on import**, for `harness.ts`'s reason, and with no
// import of its own, so `fault.test.ts` reads it without a browser.
//
// ## The fault, as measured (issue #1296, 2026-10-20)
//
// `pnpm web:sync-smoke` failed on CI about one run in five, at a different step each time — a
// pairing that never landed, a removal that never landed, a departure that logged `rotate` →
// "error sending request". The relay was well throughout: its log answered the *other* device's
// requests on time while one device's went unanswered. What failed was one browser's network
// service. Chrome says so on its stderr —
//
//     ERROR:content/browser/network_service_instance_impl.cc:653] Network service crashed or was
//     terminated, restarting service.
//
// — and every request that browser had in flight fails in the same instant: a held fixture
// download beside a relay `POST`, which no relay fault could do. After the restart its requests to
// the relay are never answered. Each of the seven minidumps that Chrome for Testing
// 155.0.8059.39 wrote in the reproduction (two loops of the walk side by side, 7 runs in 26)
// names the same cause:
//
//     mojo-message-error: Received bad user message: DevTools: Duplicate request ID
//
// That is `content/browser/devtools/devtools_url_loader_interceptor.cc` at that tag:
// `DevToolsURLLoaderFactoryProxy::CreateLoaderAndStart` refuses a second interception job for a
// `(process, request id)` that has one already, with `mojo::ReportBadMessage` — which kills the
// network service that asked. While DevTools intercepts requests (`Fetch.enable`, which these
// runs need to answer every other host from fixtures), the proxy sits behind CORS, and a CORS
// pre-flight reuses the request id of the request it precedes. So a pre-flighted request whose
// pre-flight job had not yet gone when the request's own job was made is that refusal. The relay
// is the one host these runs ask with a pre-flight — `authorization`, a JSON body — so only the
// sync walk meets it, and two walks side by side meet it more than one does.
//
// **155.0.8059.84 no longer does it**: the same function exempts pre-flights ("CORS preflights
// reuse the request ID of the request they precede … so preflights are exempt from collision
// handling") and shuts the older job down instead of reporting a bad message. Twenty-odd walks on
// 155.0.8059.84, alone and side by side, left no dump. CI's browser is the runner image's (CI's
// `Find Chrome` step), which was 155.0.8059.39 from image 20261018.
//
// ## What a run does
//
// It stops at the next wait and says so, in place of a minute's wait for something that cannot
// happen ({@link BrowserFault}). A run that asks for it ({@link attempts}) then runs the whole walk
// again from nothing — new relay, new browsers, new profiles — **a bounded number of times, and
// only for this**: any other failure is final at once, and a fault on the last walk is a failure
// that says it is the browser's. **The sync walk takes five.** A walk alone on an idle machine met
// the fault about one time in four (2 walks in 8), and two side by side about as often (13 in
// 46), so three walks would still leave a run red a few times in a hundred and five leave it red
// about once in two hundred. A faulted walk stops at its fault — mostly in its first half-minute
// — so the five fit CI's ten minutes.

/** What Chrome writes, on any host, when its network service died under it. */
export const NETWORK_SERVICE_DIED = "Network service crashed or was terminated";

/** Why a fault is the browser's, in one sentence a failure can carry. */
export const WHY =
  "the browser's network service died, which takes every request it had in flight with it — " +
  "on Chrome 155.0.8059.39 that is DevTools' request interception refusing a CORS pre-flight " +
  "that shares its request's id (scripts/web-smoke/fault.ts), and not the app";

/** A run that stopped because its browser broke, not because the app did. */
export class BrowserFault extends Error {
  override name = "BrowserFault";
}

/** The browser's own sentence, when this line of its output says it broke; otherwise `null`. */
export function faultIn(line: string): string | null {
  const at = line.indexOf(NETWORK_SERVICE_DIED);
  return at === -1 ? null : line.slice(at).trim();
}

/**
 * Run `attempt` up to `times` times in all, again only when it failed for a browser fault.
 *
 * `faultBehind(error)` answers the browser's sentence when a fault is what the failure was — read
 * after the failure, since the browser's output can arrive a moment after the failed request
 * reached the run — and `null` otherwise. `between(said, left)` is the orderly stop before the
 * next attempt, `left` the attempts after it.
 *
 * A failure with no fault behind it is thrown as it was. A fault on the last attempt is thrown as
 * a {@link BrowserFault} whose `cause` is that attempt's failure.
 */
export async function attempts(
  times: number,
  attempt: () => Promise<void>,
  faultBehind: (error: unknown) => Promise<string | null>,
  between: (said: string, left: number) => Promise<void>,
): Promise<void> {
  for (let made = 1; ; made += 1) {
    try {
      return await attempt();
    } catch (error) {
      const said = await faultBehind(error);
      if (said === null) throw error;
      if (made >= times) throw new BrowserFault(`${WHY}. Chrome said: ${said}`, { cause: error });
      await between(said, times - made);
    }
  }
}
