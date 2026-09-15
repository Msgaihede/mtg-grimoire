# scanner-assets

The card scanner's three files, embedded into the binary at compile time:

- `card-hashes.bin` — the reference bundle, one perceptual hash per printing, built by
  `crates/card-scanner`'s `build-hashes`.
- `text-detection.rten` and `text-recognition.rten` — the ocrs models that read a card's title.

`npm run scanner:assets` downloads all three from the GitHub release
`scanner-bundle-v<FORMAT_VERSION>`, which `.github/workflows/scanner-bundle.yml` publishes. They
are gitignored; this file is the only thing here that is tracked, and it is also what keeps the
directory existing, which `build.rs` needs.

`build.rs` sets `cfg(scanner_assets)` and embeds them **only when all three are present** — two
of three embeds nothing. A build without them still runs and asks for the files instead.

A file in the app's `data/scanner/` still overrides the embedded copy, so trying a new bundle
needs no rebuild.
