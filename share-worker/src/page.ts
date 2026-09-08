import { shareUrl, type Env } from "./env";
import { LAPSED, publicShare, REVOKED, type PublicRow } from "./shares";

/**
 * `GET /s/{id}` — the one page this Worker renders, and the whole reason a snapshot is stored in
 * the clear.
 *
 * **The shell is rendered rather than served as a static file** (spec §7), which costs one Worker
 * request per cold view and buys the OpenGraph card: *"Giradeli's Trade binder · 412 cards ·
 * updated 2 days ago"* in every Discord the link is pasted into. Decision 2 — plaintext storage —
 * has no other payoff, so the four `og:` tags below are the feature rather than decoration. A
 * static shell could not carry them: they have to be built from the D1 row.
 *
 * ⚠️ **There is no template engine standing between these strings and the browser.** `title` and
 * `ownerName` are typed by a reader into a dialog, `claim.ts:1112` carries this warning in words,
 * and `esc` below is the whole of the defence. Every interpolation goes through it — including
 * the id, which the router has already constrained to sixteen base64url characters and which is
 * escaped anyway, because a fence that is only correct as long as a regex two files away does not
 * change is not a fence.
 */

/** Spec §10's two sentences, which differ on purpose. */
export const WITHDRAWN = "This shared collection was withdrawn.";
export const UNAVAILABLE = "This shared collection is no longer available.";

/** A well-formed id nobody ever minted — a mistyped or truncated link, rather than a dead one. */
const MISSING = "That link does not point at a shared collection.";

/**
 * Metadata posted, blob never uploaded: the state a publish that died between its two steps
 * leaves behind (spec §4.1). It resolves within seconds of the upload, so the page says so and is
 * never cached.
 */
const PENDING = "This shared collection is not ready yet.";

/** Five characters, `&` first, on every value that came out of the database. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * `412` and `1,204`, without `Intl`.
 *
 * `toLocaleString` would need a locale argument to be deterministic and would still be answering
 * from whichever ICU build the runtime shipped; three thousand cards is not worth that surface.
 */
function grouped(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * How old the snapshot is, in the words the OpenGraph card wants.
 *
 * Clamped at zero rather than allowed to go negative: `updated_at` is the *publisher's* clock and
 * the difference is read against this Worker's, so a device a few minutes fast would otherwise
 * produce "updated -1 days ago" on a card that is about to be seen by everyone the link reaches.
 */
function since(updatedAt: number, now: number): string {
  const days = Math.floor((now - updatedAt) / 86_400_000);
  if (days <= 0) return "updated today";
  if (days === 1) return "updated yesterday";
  return `updated ${days} days ago`;
}

/**
 * The document every answer here shares. Kept as one template rather than three so a change to
 * the ground colour cannot apply to the shell and miss the 410.
 *
 * `color-scheme: dark` and the palette are `pair.ts`'s, deliberately: these are the only two
 * pages either Worker serves and a reader who meets both should not meet two designs.
 */
function page(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="robots" content="noindex">
<style>
:root{color-scheme:dark}
body{margin:0;background:#0C0D12;color:#E8E6F0;
     font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:34rem;margin:0 auto;padding:3rem 1.25rem}
h1{font-size:1.35rem;margin:0 0 .75rem}
p{color:#A9A6BC}
</style>${head}
</head><body>${body}</body></html>`;
}

/**
 * A share that is gone, as 410 and not 404 (spec §10): a viewer should learn that the collection
 * was withdrawn or expired, not that they mistyped a link.
 *
 * ⚠️ **It carries no metadata and no OpenGraph tags.** A withdrawn share whose card still read
 * *"Giradeli's Trade binder · 412 cards"* would go on advertising the binder in every Discord it
 * was ever pasted into, which is most of what withdrawing it was for. The title is a constant for
 * the same reason.
 *
 * `no-store` because both states can change under the page: `lapsed` is the daily pass's and is
 * *reversible* — a reader who renews must not be told for five more minutes that their link is
 * dead — and a 404 becomes a 200 the moment a publish lands on that id.
 */
function gone(status: number, sentence: string): Response {
  return html(
    page("MTG Grimoire", "", `<main><h1>MTG Grimoire</h1><p>${esc(sentence)}</p></main>`),
    status,
    "no-store",
  );
}

function html(body: string, status: number, cache: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache },
  });
}

/**
 * The shell a viewer's browser lands on: the OpenGraph tags, the bundle, and the one `<link>`
 * that tells the bundle where the snapshot is.
 *
 * **The blob's immutable URL is inlined rather than fetched.** This response is already built
 * from the D1 row that holds `object_key`, so an `index.json` route beside it would spend a
 * second Worker request — on the free plan's per-*account* 100,000/day, the ceiling spec §7.1
 * says nothing else can raise — to learn a fact this response is holding. `rel="preload"` rather
 * than a data attribute so the fetch starts while the bundle is still being parsed, and
 * `crossorigin` so the preload matches the `fetch()` the viewer will make.
 *
 * **A row with no `object_key` gets the sentence and no `<link>`.** Task 9's viewer reads
 * `document.getElementById("snapshot")`, so its absence *is* the signal that there is nothing to
 * fetch — which is why the shell must not emit an empty or a guessed one. That state is
 * transient, so this response alone is `no-store` rather than the five minutes below.
 *
 * ⚠️ `/assets/share.js` is a **fixed** name, not a Vite content hash. Task 9's build has to pin
 * its entry file name; a hashed bundle would need this Worker to learn the manifest, which is a
 * read this page cannot afford.
 */
function shell(env: Env, row: PublicRow, now: number): Response {
  const title = esc(row.title);
  const owner = esc(row.owner_name);
  const id = esc(row.id);
  const heading = `${owner}&#39;s ${title}`;
  const summary = `${grouped(row.card_count)} ${row.card_count === 1 ? "card" : "cards"} · ${since(
    row.updated_at,
    now,
  )}`;

  // The key is `shares/{id}/{hash}.json.gz` and the URL is its last two segments under `/s/`,
  // which is what carries the content addressing all the way into the browser's cache. A key
  // that is not that shape yields no file name and is treated as no snapshot at all — one
  // unreadable row renders "not ready yet" rather than a `<link>` pointing at nothing.
  const file = esc(/^shares\/[^/]+\/([^/]+)$/.exec(row.object_key ?? "")?.[1] ?? "");
  const link =
    file === ""
      ? ""
      : `\n<link id="snapshot" rel="preload" as="fetch" crossorigin href="/s/${id}/${file}">`;

  const head = `
<meta property="og:type" content="website">
<meta property="og:title" content="${heading}">
<meta property="og:description" content="${summary}">
<meta property="og:url" content="${esc(shareUrl(env, row.id))}">${link}
<script type="module" src="/assets/share.js"></script>`;

  // The pending sentence sits outside `#root` so the bundle can render over the container without
  // erasing it, and `<noscript>` carries what a reader with no JavaScript — and any crawler that
  // does not read the tags above — would otherwise get nothing of.
  const pending = file === "" ? `<main id="pending"><p>${esc(PENDING)}</p></main>` : "";
  const body = `<div id="root"></div>${pending}
<noscript><main><h1>${heading}</h1><p>${summary}</p>
<p>This is a read-only snapshot. Anyone with this link can see it.</p></main></noscript>`;

  return html(
    page(`${heading} — MTG Grimoire`, head, body),
    200,
    file === "" ? "no-store" : "public, max-age=300",
  );
}

/**
 * The route. One D1 read, a branch on `state`, and no second query — spec §6's rule for keeping
 * an anonymous click cheap.
 */
export async function handleShell(env: Env, id: string, now: number): Promise<Response> {
  const row = await publicShare(env, id);
  if (row === null) return gone(404, MISSING);
  if (row.state === REVOKED) return gone(410, WITHDRAWN);
  if (row.state === LAPSED) return gone(410, UNAVAILABLE);
  return shell(env, row, now);
}
