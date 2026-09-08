#!/usr/bin/env node
// POST one photograph to the debug server's /frame N times and print the verdict per frame.
//
//   node crates/card-scanner/scripts/drive-frames.mjs <image> <frames> [reset] [key=value ...]
//
// Keys go on the query string exactly as the page sends them (edge, method, lo, hi, aspect,
// cardness, stages, rule, decide, margin). `reset` POSTs /reset first. `port=7778` picks a
// server. The tracker's cross-frame behaviour — the decision, the freeze, the swap, the reset —
// is only visible across frames, and this is how to see it without a card in hand: found this
// way on 2026-09-08, a decision that reset itself every ten frames on a held card.
import { readFileSync } from 'node:fs';

const [image, frames, ...rest] = process.argv.slice(2);
if (!image || !frames) {
  console.error('usage: drive-frames.mjs <image> <frames> [reset] [key=value ...]');
  process.exit(2);
}
let port = '7777';
let reset = false;
const params = [];
for (const arg of rest) {
  if (arg === 'reset') reset = true;
  else if (arg.startsWith('port=')) port = arg.slice(5);
  else params.push(arg);
}
const base = `http://127.0.0.1:${port}`;
const body = readFileSync(image);
if (reset) {
  await fetch(`${base}/reset`, { method: 'POST' });
  console.log('reset');
}
for (let f = 1; f <= Number(frames); f++) {
  const t0 = performance.now();
  const res = await fetch(`${base}/frame?${params.join('&')}`, { method: 'POST', body });
  const j = await res.json();
  const ms = (performance.now() - t0).toFixed(0);
  const t = j.tracked;
  const lead = t?.standings?.[0];
  const name = lead?.label ? `${lead.label.name} ${lead.label.set.toUpperCase()} ${lead.label.number}` : '-';
  const tally = lead ? lead.evidence.toFixed(1) : '-';
  const reads = [j.ocr?.matched && `ocr=${j.ocr.matched}`, j.collector?.matched && `col=${j.collector.matched}`]
    .filter(Boolean)
    .join(' ');
  console.log(
    `${String(f).padStart(2)} ${String(ms).padStart(5)} ms lock=${j.lock?.phase ?? '-'} ` +
      `${t ? `rule=${t.rule} committed=${t.committed} frozen=${t.frozen} tally=${tally}/${t.decide_at} misses=${t.misses}` : 'no tracker'} ` +
      `:: ${name} ${reads} ${j.error ? `err=${j.error}` : ''}`,
  );
}
