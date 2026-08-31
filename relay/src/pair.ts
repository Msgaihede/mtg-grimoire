import type { Env } from "./index";

/**
 * What a phone's own camera app lands on when it scans the pairing QR.
 *
 * ⚠️ **The code is in the URL fragment and this Worker never sees it.** A fragment is not sent to
 * the server; that is the whole reason the QR uses one. This page reads `location.hash` in the
 * browser, so the relay learns nothing about an invite even though it serves the page the invite
 * is opened on. Do not "improve" this by moving the code into a path or query — it would hand the
 * relay A's public key and the one-time token, and the six digits would become the only defence.
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
<a class="btn" id="open" href="#">Open the app</a>
<script>
(function () {
  var raw = location.hash.replace(/^#/, "");
  var el = document.getElementById("code");
  if (!raw) {
    document.getElementById("lead").textContent =
      "That link carried no pairing code. Scan the QR code again from the other device.";
    el.remove();
    document.getElementById("copy").remove();
    document.getElementById("open").remove();
    return;
  }
  el.textContent = raw.replace(/(.{5})(?=.)/g, "$1-");
  document.getElementById("copy").addEventListener("click", function () {
    navigator.clipboard.writeText(raw);
    this.textContent = "Copied";
  });
  document.getElementById("open").href =
    "intent://pair#Intent;scheme=mtggrimoire;package=com.mtggrimoire.app;S.code=" +
    encodeURIComponent(raw) + ";end";
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

/**
 * Android App Links. ⚠️ **`REPLACE_WITH_RELEASE_SHA256` is a deploy step, not a code one** — until
 * the real signing-certificate fingerprint is here the scan opens a chooser rather than the app,
 * which is degraded and not broken. Get it with:
 *   keytool -list -v -keystore <ks> -alias <alias> | findstr SHA256
 */
export function handleAssetLinks(): Response {
  const body = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "com.mtggrimoire.app",
        sha256_cert_fingerprints: ["REPLACE_WITH_RELEASE_SHA256"],
      },
    },
  ];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
