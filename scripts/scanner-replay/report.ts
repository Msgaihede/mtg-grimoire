// The replay as a page: what every scan was expected to be, what each pass matched instead,
// the frames, and the pictures the scanner cut. One document, written beside the corpus and
// opened from disk — it draws readers' photographs from the local mirror and is not for
// publishing. `results.json` is a file on disk, so its types are no guarantee: every value
// from it is escaped on its way in, and every word that picks a class, a data attribute or
// a lookup is checked against our own table first.

import type { Pass, Results, Run, Score, Slice } from "./results.ts";
import { compare, PASSES, percent, tally, type Flip, type Tally } from "./summary.ts";

const esc = (text: unknown) =>
  String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Scryfall's picture of a printing, from its id alone; empty for an id that is not a UUID. */
export function cardImage(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return "";
  const lower = String(id).toLowerCase();
  return `https://cards.scryfall.io/normal/front/${lower[0]}/${lower[1]}/${lower}.jpg`;
}

const WORDS: Record<Score, string> = {
  printing: "Right printing",
  card: "Right card, other printing",
  wrong: "Wrong card",
  undecided: "Nothing decided",
  error: "Could not replay",
};
const SLICES: Record<Slice["kind"], string> = {
  rectified: "Rectified card",
  binary: "Black and white",
  title: "Title band",
  collector: "Collector band",
};

/** Whether a word from the file is one of a table's own keys. */
const own = <T extends string>(table: Record<T, string>, key: unknown): key is T =>
  typeof key === "string" && Object.hasOwn(table, key);

const scoreOf = (value: unknown): Score => (own(WORDS, value) ? value : "error");
const wordOf = (value: unknown) => (own(WORDS, value) ? WORDS[value] : "Unknown result");
const lockOf = (value: unknown) => (typeof value === "string" && /^[a-z]+$/.test(value) ? value : "none");
const join = (prefix: string, rest: string) => (prefix ? `${prefix}/${rest}` : rest);
const encoded = (path: unknown) => String(path ?? "").split("/").map(encodeURIComponent).join("/");
const printed = (set: unknown, number: unknown) => `${esc(String(set ?? "").toUpperCase())} ${esc(number)}`.trim();

const share = (count: number, t: Tally) => {
  const text = percent(count, t);
  return text === "—" ? text : `${text}%`;
};

/** The scans both results hold, so a tile's movement compares like with like. */
function shared(now: Results, base: Results): { now: Run[]; base: Run[] } {
  const before = new Set(base.runs.map((run) => run.id));
  const after = new Set(now.runs.map((run) => run.id));
  return { now: now.runs.filter((run) => before.has(run.id)), base: base.runs.filter((run) => after.has(run.id)) };
}

function tiles(now: Results, base: Results | null): string {
  const both = base ? shared(now, base) : null;
  return PASSES.map((name) => {
    const t = tally(now.runs, name);
    const nowBoth = both ? tally(both.now, name) : null;
    const wasBoth = both ? tally(both.base, name) : null;
    const delta = (pick: (x: Tally) => number) => {
      if (!nowBoth || !wasBoth) return "";
      const of = (x: Tally) => x.n - x.error;
      if (!of(nowBoth) || !of(wasBoth)) return "";
      const d = (100 * pick(nowBoth)) / of(nowBoth) - (100 * pick(wasBoth)) / of(wasBoth);
      if (Math.abs(d) < 0.05) return "";
      return ` <span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}</span>`;
    };
    return `<section class="tile"><h2>${esc(name)}</h2>
<p class="big">${share(t.printing, t)}${delta((x) => x.printing)}</p><p class="what">right printing</p>
<dl><dt>Right card</dt><dd>${share(t.card, t)}${delta((x) => x.card)}</dd>
<dt>Wrong card</dt><dd>${t.wrong}</dd><dt>Undecided</dt><dd>${t.undecided}${t.lost ? `<span class="sub">of which ${t.lost} decided, then lost</span>` : ""}${t.unresolved ? `<span class="sub">of which ${t.unresolved} never got to try</span>` : ""}</dd>
<dt>Errors</dt><dd>${t.error}</dd><dt>Median frames</dt><dd>${esc(t.medianFrames ?? "—")}</dd></dl></section>`;
  }).join("\n");
}

function filmstrip(run: Run, paths: { frames: string }): string {
  const decided = run.passes[0]?.decision_frame ?? run.passes[0]?.first_decision_frame ?? null;
  const total = Math.max(0, Math.min(Math.trunc(Number(run.frames)) || 0, 1000));
  return Array.from({ length: total }, (_, n) => {
    const then = run.then_frames?.[n];
    const lock = lockOf(run.passes[0]?.frames?.[n]?.lock ?? then?.lock);
    const here = decided === n + 1;
    const detail = then?.detail === true;
    const classes = ["frame", `lock-${lock}`, here ? "decided" : "", detail ? "detail" : ""];
    const failure = run.passes[0]?.frames?.[n]?.error;
    const failed = typeof failure === "string" && failure !== "" ? `failed: ${failure}` : "";
    const kept = run.passes[0]?.score !== "undecided";
    const said = `Frame ${n + 1} of ${total}, ${lock === "none" ? "no lock" : lock}${here ? (kept ? ", decided here" : ", a decision was made here") : ""}${detail ? ", had a detail picture" : ""}${failed ? `, ${failed}` : ""}`;
    const title = `Frame ${n + 1}${then ? `, ${then.ms} ms` : ""}, lock ${lock}${detail ? ", had a detail picture" : ""}${failed ? `, ${failed}` : ""}`;
    const src = join(paths.frames, `${encodeURIComponent(String(run.id))}/${String(n).padStart(2, "0")}.jpg`);
    const img = `<img class="${classes.filter(Boolean).join(" ")}" loading="lazy" src="${esc(src)}" alt="${esc(said)}" title="${esc(title)}">`;
    return failed ? `<span class="frame-error" title="${esc(failed)}">${img}<b aria-hidden="true">!</b></span>` : img;
  }).join("");
}

/** A card's picture, or the grey box where an id cannot be addressed. */
function picture(id: string, alt: string, fallback = "—"): string {
  const src = cardImage(id);
  return src
    ? `<img class="card" loading="lazy" src="${esc(src)}" alt="${esc(alt)}">`
    : `<div class="card none">${esc(fallback)}</div>`;
}

function matched(pass: Pass, run: Run): string {
  const score = scoreOf(pass.score);
  const lost = score === "undecided" && typeof pass.decision_frame === "number";
  const tooShort = score === "undecided" && !lost && pass.resolve_ran === false;
  const chip = `<span class="chip" data-score="${score}">${lost ? "Decided, then lost" : tooShort ? "Too short to resolve" : wordOf(pass.score)}${pass.ambiguous === true ? " (ambiguous)" : ""}</span>`;
  const fixed = (value: unknown, digits: number) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : String(value));
  const first = pass.first_decision_frame;
  const last = pass.decision_frame;
  const frameSaid =
    lost
      ? `decided at frame ${last}, nothing held at the end`
      : first === null || first === undefined
        ? null
      : last !== null && last !== undefined && last !== first
        ? `first decided at frame ${first}, changed by frame ${last}`
        : `frame ${first}`;
  const figures = [
    frameSaid,
    typeof pass.locked_frames === "number" ? `${pass.locked_frames} locked frames` : null,
    pass.confidence === null ? null : `confidence ${fixed(pass.confidence, 2)}`,
    pass.distance === null ? null : `distance ${pass.distance}`,
  ].filter(Boolean).join(" · ");
  const got = pass.got;
  const shown = got
    ? `${picture(got.id, `${got.name ?? got.id} ${String(got.set ?? "").toUpperCase()} ${got.number ?? ""}`.trim(), pass.error ?? "—")}
<p class="name">${esc(got.name ?? got.id)}</p><p class="print">${printed(got.set, got.number)}</p>`
    : `<div class="card none">${pass.error ? esc(pass.error) : "—"}</div>`;
  const same = got !== null && String(got.id).toLowerCase() === String(run.card.id).toLowerCase();
  return `<div class="pass${same ? " same" : ""}"><h4>${esc(pass.name)} <small>${esc(pass.mode)}</small></h4>${shown}${chip}<p class="figures">${esc(figures)}</p></div>`;
}

/** A finish mark is whatever JSON the scanner wrote: a string as it is, anything else compact. */
function markText(mark: unknown): string | null {
  if (mark === null || mark === undefined) return null;
  if (typeof mark === "string") return mark;
  try {
    return JSON.stringify(mark) ?? null;
  } catch {
    return "(unreadable)";
  }
}

function slices(run: Run, paths: { slices: string }): string {
  const cut = run.passes[0]?.slices ?? [];
  const cells = cut.map((slice) => {
    const known = own(SLICES, slice.kind);
    const caption = `${known ? SLICES[slice.kind] : "Picture"}, frame ${esc(slice.frame)}`;
    const read = slice.raw === null ? "" : `<p class="read">read <q>${esc(slice.raw)}</q>${slice.matched ? ` → matched <code>${esc(slice.matched)}</code>` : " → matched nothing"}</p>`;
    const tried = (Array.isArray(slice.tried) ? slice.tried : []).map(
      (pairing) => `<li>${esc(pairing?.set)} ${esc(pairing?.number)} → ${pairing?.matched ? `matched <code>${esc(pairing.matched)}</code>` : "nothing"}</li>`,
    );
    const more = Number(slice.more) > 0 ? `<li>+${esc(slice.more)} more</li>` : "";
    const pairings = tried.length || more ? `<ul class="tried">${tried.join("")}${more}</ul>` : "";
    const mark = markText(slice.mark);
    const finish = mark === null ? "" : `<p class="mark">finish mark: ${esc(mark)}</p>`;
    const edits = slice.edits === null || slice.edits === undefined ? "" : `<p class="edits">${esc(slice.edits)} edits from the name</p>`;
    return `<figure class="${known ? `slice ${slice.kind}` : "slice"}"><img loading="lazy" src="${esc(join(paths.slices, encoded(slice.file)))}" alt="${caption}">
<figcaption>${caption}${read}${pairings}${finish}${edits}</figcaption></figure>`;
  });
  if (!cut.some((slice) => slice.kind === "title" || slice.kind === "collector")) {
    cells.push(`<p class="none">No title or collector band was read on this scan.</p>`);
  }
  const tiers = run.passes.flatMap((pass) => pass.tiers.map((tier) => `<li><b>${esc(pass.name)}: ${esc(tier.tier)}</b> — ${esc(tier.survivors)} left. ${esc(tier.detail)}</li>`));
  return `<div class="slices">${cells.join("")}</div>${tiers.length ? `<ul class="tiers">${tiers.join("")}</ul>` : ""}`;
}

function row(run: Run, changes: Flip[], paths: { frames: string; slices: string }): string {
  const scores = run.passes.map((pass) => scoreOf(pass.score));
  const flags = [
    scores.includes("wrong") ? "wrong" : "",
    scores.includes("card") ? "card" : "",
    scores.includes("undecided") ? "undecided" : "",
    scores.includes("error") ? "error" : "",
  ].filter(Boolean).join(" ");
  const changed = changes.map((f) => `<li>${esc(f.pass)}: ${esc(f.from)} → ${esc(f.to)}</li>`).join("");
  const card = run.card;
  return `<article class="run" data-flags="${flags}" data-changed="${changes.length ? "yes" : "no"}" data-search="${esc(`${card.name} ${run.id} ${card.set}`.toLowerCase())}">
<header><h3>${esc(card.name)} <small>${printed(card.set, card.number)} · ${esc(run.finish)} · ${esc(run.platform)} ${esc(run.version)} · scanned in ${esc(run.mode)}${run.filtered ? ", filtered" : ""}${run.known ? "" : " · not in this card data"}</small></h3>
<p class="id"><code>${esc(run.id)}</code> · then: ${wordOf(run.then?.score)}${run.decided_differs === null ? " · replay not comparable frame by frame" : run.decided_differs ? ` · ${esc(run.decided_differs)} frames replayed differently` : ""}</p>
${changed ? `<ul class="changed">${changed}</ul>` : ""}</header>
<div class="strip">${filmstrip(run, paths)}</div>
<div class="cards"><div class="pass expected"><h4>Expected</h4>${picture(card.id, `${card.name} ${String(card.set ?? "").toUpperCase()} ${card.number ?? ""}`.trim())}<p class="name">${esc(card.name)}</p><p class="print">${printed(card.set, card.number)}</p></div>
${run.passes.map((pass) => matched(pass, run)).join("\n")}</div>
${slices(run, paths)}
</article>`;
}

const STYLE = `
:root{--bg:#f6f5f2;--panel:#fff;--ink:#1c1b19;--dim:#6b6860;--line:#dcd9d2;--good:#1f7a4d;--warn:#8f5700;--bad:#b3261e;--idle:#6b6860;--on-chip:#ffffff}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--panel:#211f1c;--ink:#ece9e2;--dim:#a29e94;--line:#38352f;--good:#58c08a;--warn:#e0a94a;--bad:#f0766c;--idle:#a29e94;--on-chip:#161513}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif}
main{max-width:1280px;margin:0 auto;padding:24px 16px 80px}h1{font-size:22px;margin:0 0 4px}.meta{color:var(--dim);margin:0 0 20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:8px}.note{color:var(--dim);margin:0 0 12px;font-size:12px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.tile h2{font-size:13px;margin:0;color:var(--dim);font-weight:600}
.big{font-size:32px;font-weight:650;margin:4px 0 0;font-variant-numeric:tabular-nums}.what{margin:0 0 8px;color:var(--dim)}
dl{display:grid;grid-template-columns:1fr auto;gap:2px 12px;margin:0}dt{color:var(--dim)}dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.delta{font-size:13px;font-weight:600}.delta.up{color:var(--good)}.delta.down{color:var(--bad)}
.bar{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 0;background:var(--bg)}
.bar button{font:inherit;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
.bar button[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.bar input{font:inherit;flex:1;min-width:180px;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--ink)}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:0 0 4px;color:var(--dim);font-size:12px}.key{display:inline-flex;gap:6px;align-items:center}
.sw{display:inline-block;width:22px;height:14px;border-radius:3px;background:var(--line);border-bottom:4px solid var(--idle)}
.run{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-top:12px}.run[hidden]{display:none}
.run h3{margin:0;font-size:16px}.run small{font-weight:400;color:var(--dim);font-size:12px}.id{margin:2px 0 0;color:var(--dim);font-size:12px}
.changed{margin:6px 0 0;padding:0 0 0 18px;color:var(--warn);font-weight:600}
.strip{display:flex;gap:4px;overflow-x:auto;padding:10px 0}.frame{height:84px;aspect-ratio:16/9;object-fit:cover;background:var(--line);border-radius:4px;border-bottom:4px solid var(--idle);flex:none}
.lock-acquiring{border-color:var(--warn)}.lock-locked{border-color:var(--good)}.decided{outline:3px solid var(--ink);outline-offset:1px}.detail{border-top:3px dotted var(--dim)}
.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}@media (max-width:640px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
.pass h4{margin:0 0 6px;font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em}.pass h4 small{text-transform:none;letter-spacing:0}
.card{width:100%;aspect-ratio:488/680;border-radius:4.5%;background:var(--line);display:block;object-fit:cover}.card.none{display:grid;place-items:center;color:var(--dim);padding:8px;text-align:center;font-size:12px}
.name{margin:6px 0 0;font-weight:600}.print,.figures{margin:0;color:var(--dim);font-size:12px}
.chip{display:inline-block;margin-top:6px;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;color:var(--on-chip);background:var(--idle)}
.chip[data-score=printing]{background:var(--good)}.chip[data-score=card]{background:var(--warn)}.chip[data-score=wrong],.chip[data-score=error]{background:var(--bad)}
.slices{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.slice{margin:0;max-width:100%}.slice img{display:block;max-width:100%;border:1px solid var(--line);border-radius:4px}.slice.rectified img,.slice.binary img{height:auto;max-height:200px;max-width:100%}.slice.title img,.slice.collector img{height:auto;max-height:64px}
figcaption{font-size:12px;color:var(--dim);margin-top:4px}.read{margin:2px 0 0;color:var(--ink)}.none{color:var(--dim)}.empty{margin:24px 0;text-align:center;color:var(--dim)}.empty[hidden]{display:none}
dd .sub{display:block;font-size:12px;color:var(--dim)}.frame-error{position:relative;flex:none;display:block}.frame-error b{position:absolute;top:2px;right:2px;min-width:18px;height:18px;border-radius:9px;background:var(--bad);color:var(--on-chip);font-size:12px;line-height:18px;text-align:center}
.tried,.mark,.edits{margin:2px 0 0;padding-left:16px;font-size:12px;overflow-wrap:anywhere}.mark,.edits{padding-left:0}
.tiers{margin:10px 0 0;padding-left:18px;font-size:12px;color:var(--dim)}code{font-size:12px}
.card.none,.read,.tiers li,.id,code{overflow-wrap:anywhere}`;

/**
 * Whether a scan shows, given the filter chosen, its flags (the results any pass had), whether
 * it changed since the baseline, its search text and the words typed. The page's script is made
 * from this very source, and the tests call it.
 */
export const FILTER_SRC =
  "if(q&&!search.includes(q))return false;" +
  "if(filter==='all')return true;" +
  "if(filter==='changed')return changed==='yes';" +
  "return flags.split(' ').includes(filter);";
export const matchesFilter = new Function("filter", "flags", "changed", "search", "q", FILTER_SRC) as (
  filter: string,
  flags: string,
  changed: string,
  search: string,
  q: string,
) => boolean;

const SCRIPT = `
function matches(filter,flags,changed,search,q){${FILTER_SRC}}
const runs=[...document.querySelectorAll('.run')],buttons=[...document.querySelectorAll('.bar button')],box=document.querySelector('.bar input'),count=document.querySelector('.count'),empty=document.querySelector('.empty');
let filter='all';
function apply(){const q=box.value.trim().toLowerCase();let shown=0;for(const r of runs){const on=matches(filter,r.dataset.flags,r.dataset.changed,r.dataset.search,q);r.hidden=!on;if(on)shown++}count.textContent=shown+' of '+runs.length+' scans';empty.hidden=shown>0}
for(const b of buttons)b.addEventListener('click',()=>{filter=b.dataset.filter;for(const o of buttons)o.setAttribute('aria-pressed',String(o===b));apply()});
box.addEventListener('input',apply);apply();`;

export function reportHtml(now: Results, base: Results | null, paths: { frames: string; slices: string }): string {
  const delta = base ? compare(now, base) : null;
  const changes = new Map<string, Flip[]>();
  for (const flip of delta ? [...delta.fixed, ...delta.broken, ...delta.moved] : []) {
    changes.set(flip.id, [...(changes.get(flip.id) ?? []), flip]);
  }
  const filters: [string, string][] = [
    ["all", "All"],
    ["wrong", "Wrong card"],
    ["card", "Wrong printing"],
    ["undecided", "Undecided"],
    ["error", "Errors"],
    ...(base ? ([["changed", "Changed since baseline"]] as [string, string][]) : []),
  ];
  const against = base ? ` · against <code>${esc(base.commit ?? "unknown")}</code>` : "";
  const both = base ? shared(now, base) : null;
  const differ = both && (both.now.length !== now.runs.length || both.base.length !== base!.runs.length);
  const overlap = differ ? `<p class="note">Tile movement is over the ${both.now.length} scans in both results.</p>` : "";
  const legend = `<p class="legend"><span class="key"><span class="sw lock-acquiring"></span>acquiring</span>
<span class="key"><span class="sw lock-locked"></span>locked</span><span class="key"><span class="sw lock-none"></span>no lock</span>
<span class="key"><span class="sw decided"></span>a decision was made here</span><span class="key"><span class="sw detail"></span>had a detail picture</span><span class="key"><b class="x">!</b>frame failed</span></p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scanner replay</title><style>${STYLE}</style></head><body><main>
<h1>Scanner replay</h1>
<p class="meta">${now.runs.length} scans, ${now.skipped.length} skipped · commit <code>${esc(now.commit ?? "unknown")}</code> · bundle of ${esc(now.bundle_printings)} printings${against}</p>
<div class="tiles">${tiles(now, base)}</div>${overlap}
<div class="bar">${filters.map(([key, word], i) => `<button type="button" data-filter="${key}" aria-pressed="${i === 0}">${word}</button>`).join("")}
<input type="search" placeholder="Card name, set or scan id" aria-label="Search scans"><span class="count" aria-live="polite"></span></div>
<p class="note">A filter keeps a scan when any pass had that result.</p>
${legend}
${now.runs.map((run) => row(run, changes.get(run.id) ?? [], paths)).join("\n")}
<p class="empty" hidden>No scans match.</p>
</main><script>${SCRIPT}</script></body></html>`;
}
