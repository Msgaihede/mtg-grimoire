import type { Env } from "./index";

/**
 * What a phone's own camera app lands on when it scans the pairing QR.
 *
 * ⚠️ **The code is in the URL fragment and this Worker never sees it.** A fragment is not sent to
 * the server; that is the whole reason the QR uses one. This page reads `location.hash` in the
 * browser, so the relay learns nothing about an invite even though it serves the page the invite
 * is opened on. Do not "improve" this by moving the code into a path or query — it would hand the
 * relay A's public key and the one-time token, and the six digits would become the only defence.
 *
 * ⚠️ **There is no "Open the app" link and there must not be one until the app reads a launch
 * intent.** This page carried an `intent://…;scheme=mtggrimoire;…;S.code=…;end` button for part of
 * a day. Nothing in the app declares that scheme and nothing in it reads `S.code`, so the button
 * was dead on arrival — and the App Link that was supposed to replace it was worse than dead:
 * once `assetlinks.json` carried a real fingerprint, Android would have opened the app for
 * `https://…/pair#<code>` **instead of this page**, with the app having nowhere to read the code
 * from and this page — the only thing that shows it — no longer reachable from a scan. The
 * reader's primary path is the app's own in-app scanner, which needs no link at all; this page is
 * the fallback for a generic camera app, and copying the code is what it is for.
 */
const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair a device — MTG Grimoire</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:2rem 1.25rem;background:#0C0D12;color:#E8E6F0;
     font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:34rem;margin:0 auto}
h1{font-size:1.35rem;margin:0 0 .75rem}
p{color:#A9A6BC}
code{display:block;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
     font-size:.95rem;letter-spacing:.02em;background:#16171F;border:1px solid #2A2B36;
     border-radius:.5rem;padding:.85rem;margin:1rem 0}
a.btn,button{display:inline-block;font:inherit;background:#2A2B36;color:#E8E6F0;border:0;
     border-radius:.5rem;padding:.7rem 1.1rem;margin:0 .5rem .5rem 0;cursor:pointer;
     text-decoration:none}
</style></head><body><main>
<h1>Pair this device</h1>
<p id="lead">Open MTG Grimoire on this device, choose <b>Enter a code from another device</b>, and
paste the code below.</p>
<code id="code"></code>
<button id="copy" type="button">Copy the code</button>
<script>
(function () {
  var raw = location.hash.replace(/^#/, "");
  var el = document.getElementById("code");
  if (!raw) {
    document.getElementById("lead").textContent =
      "That link carried no pairing code. Scan the QR code again from the other device.";
    el.remove();
    document.getElementById("copy").remove();
    return;
  }
  el.textContent = raw.replace(/(.{5})(?=.)/g, "$1-");
  document.getElementById("copy").addEventListener("click", function () {
    navigator.clipboard.writeText(raw);
    this.textContent = "Copied";
  });
})();
</script>
</main></body></html>`;

// `env` is part of the signature every sibling handler shares (`(request, env) => Response`) and
// what `pair.test.ts` calls this with, even though the page itself needs nothing out of it — it
// carries no secret and reads no D1 table. The leading underscore satisfies `tsc`'s own
// `noUnusedParameters` (it exempts that name shape unconditionally), but ESLint's
// `@typescript-eslint/no-unused-vars` does not grant the same exemption — its `args: "after-used"`
// only forgives an unused parameter that precedes a later one that IS used, and this is the only
// parameter — so the disable comment is necessary too, not decorative.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function handlePair(_env: Env): Response {
  return new Response(PAGE, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}

// ⚠️ **`/.well-known/assetlinks.json` is deliberately gone, and its absence is the fix rather
// than an oversight.** It served a placeholder fingerprint for part of a day so that the app's
// `autoVerify` intent-filter could one day succeed. Installing a real fingerprint would have
// *broken* the scan flow rather than completing it: Android would then open the app for
// `https://…/pair#<code>`, and the app reads no launch intent, so the code would arrive nowhere
// and this page would stop being reachable from a camera. The intent-filter is gone from
// `AndroidManifest.xml` too, with the whole argument written at its site. Re-add both together,
// after the intent handling exists — never one of them alone.
