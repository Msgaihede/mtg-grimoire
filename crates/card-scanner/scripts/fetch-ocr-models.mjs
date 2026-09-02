#!/usr/bin/env node
// Fetch the ocrs text-detection and text-recognition models.
//
//   node crates/card-scanner/scripts/fetch-ocr-models.mjs [dest]
//
// 12.2 MB the two of them, into `.scanner-bundle/models/` by default, which is gitignored.
// They are not vendored for the same reason the hash bundle is not: they are large, they are
// not ours, and they are reproducible from a URL.
import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://ocrs-models.s3-accelerate.amazonaws.com';
const MODELS = [
  ['text-detection.rten', 2510284],
  ['text-recognition.rten', 9716568],
];

const dest = process.argv[2] ?? '.scanner-bundle/models';
mkdirSync(dest, { recursive: true });

for (const [name, expected] of MODELS) {
  const out = join(dest, name);
  if (existsSync(out) && statSync(out).size === expected) {
    console.log(`have  ${name} (${(expected / 1e6).toFixed(1)} MB)`);
    continue;
  }
  process.stdout.write(`get   ${name} … `);
  const res = await fetch(`${BASE}/${name}`, {
    headers: { 'User-Agent': 'mtg-grimoire-card-scanner' },
  });
  if (!res.ok) {
    console.log(`FAILED HTTP ${res.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Size-checked rather than trusted: a truncated model loads and then produces nonsense,
  // which is far harder to recognise than a download that refused outright.
  if (buf.length !== expected) {
    console.log(`FAILED got ${buf.length} bytes, expected ${expected}`);
    process.exit(1);
  }
  writeFileSync(out, buf);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
}
console.log(`\nmodels in ${dest}`);
