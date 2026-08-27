#!/usr/bin/env bash
# Build Probe 1 to a loadable ES module. Two steps because we deliberately do not use
# wasm-pack: it downloads its own toolchain at run time, and a spike whose numbers depend
# on an opaque auto-download is not a spike whose numbers mean anything.
set -e
cd "$(dirname "$0")/probe1"
export PATH="$PATH:/c/Program Files/LLVM/bin"
cargo build --target wasm32-unknown-unknown --release
wasm-bindgen \
  --target web \
  --out-dir pkg \
  --no-typescript \
  target/wasm32-unknown-unknown/release/probe1.wasm
ls -la pkg
