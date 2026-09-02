#!/usr/bin/env node
// Parse the live view's inline script and check that every element it reaches for exists.
//
// **Run this after every edit to `src/bin/live.html`.** A syntax error there does not look
// like a syntax error: the whole script fails to parse, `start()` never runs, and the only
// symptom is "the camera doesn't start" — which reads as a permissions or hardware problem
// and sends you looking in entirely the wrong place. It cost a debugging round exactly once,
// from a duplicate `const` introduced by a careless edit.
//
//   node crates/card-scanner/scripts/check-live-page.mjs
//
// The page is `include_str!`d into the binary, so nothing at compile time reads it as
// JavaScript and `cargo build` cannot catch any of this.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, '..', 'src', 'bin', 'live.html');
const html = readFileSync(path, 'utf8');

let failed = 0;
const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  failed++;
};

const script = html.match(/<script>([\s\S]*?)<\/script>/);
if (!script) {
  fail('no <script> block found');
} else {
  try {
    // eslint-disable-next-line no-new-func
    new Function(script[1]);
    console.log('ok    the inline script parses');
  } catch (e) {
    fail(`the inline script does not parse: ${e.message}`);
    const line = (e.stack?.match(/<anonymous>:(\d+)/) ?? [])[1];
    if (line) {
      const src = script[1].split('\n');
      for (let i = Math.max(0, line - 4); i < Math.min(src.length, +line + 2); i++) {
        console.error(`      ${String(i + 1).padStart(4)} ${src[i]}`);
      }
    }
  }

  // Every `$('id')` must name an element the markup actually has. A typo here is silent:
  // `$(...)` returns null and the first property access throws at run time, in a callback,
  // where nothing surfaces it.
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...script[1].matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  for (const u of used) {
    if (!ids.has(u)) fail(`the script reaches for #${u}, which the markup does not define`);
  }
  console.log(`ok    ${used.size} element lookups all resolve`);
}

// A fragment-level sanity check: the page is a full document and must stay one.
for (const needed of ['<video', '<canvas', 'getUserMedia']) {
  if (!html.includes(needed)) fail(`the page no longer contains ${needed}`);
}
if (!failed) console.log('ok    the page still has a video, a canvas and a camera request');

process.exit(failed ? 1 : 0);
