/**
 * The one page this Worker draws: what a browser shows after Discord's sign-in redirects back to
 * `/oauth/discord/callback`.
 *
 * **Self-contained, and everything in it escaped.** No script, no image, no font, no stylesheet
 * from anywhere — the policy below refuses all of them — because the address it is drawn at holds
 * Discord's one-time code and the request's `state`, and a request for any other resource could
 * carry that address in its `Referer`. `referrer-policy: no-referrer` says the same twice. The
 * only text that varies is a Discord username, and it is escaped like the rest.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** The policy the page is served under: inline style, and nothing else from anywhere. */
export const PAGE_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** A page with a heading and a sentence, both escaped here. */
export function page(heading: string, sentence: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>MTG Grimoire · Discord</title>
<style>
:root { color-scheme: light dark; --bg: #f6f4ef; --fg: #1d1b18; --muted: #5c574f; --card: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg: #141311; --fg: #ece8e1; --muted: #a59f95; --card: #1f1d1a; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
  color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 28rem; margin: 16px; padding: 28px 32px; background: var(--card); border-radius: 12px;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.12); }
h1 { margin: 0 0 8px; font-size: 1.25rem; }
p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(sentence)}</p>
</main>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": PAGE_POLICY,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
