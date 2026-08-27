# Feed Pipeline Takes A Stream — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three bulk-feed ingests consume a stream of byte chunks instead of a file path, so the same code can be fed by a file on desktop and by `fetch` in a browser.

**Architecture:** A new pure module `feed::frame` does three things with no I/O and no database: sniffs whether a byte stream is gzipped and decompresses it incrementally, frames JSONL into lines, and frames a JSON array into top-level elements. `ingest.rs` and `combos.rs` then grow `*_stream` entry points built on it, and their existing `ingest_gz(path)` functions become thin wrappers that open a file and feed the chunks through. **Desktop behaviour does not change** — same public functions, same tests, same results.

**Tech Stack:** Rust 2021, `flate2` (miniz_oxide backend), `serde_json`, `rusqlite`. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md) §4 — Boundary B.

## Why this is PR 1, and why it is smaller than the spec's §4

The spec describes three traits over "around twenty modules". Measurement narrows that sharply, and the narrowing is worth stating so nobody plans the bigger version:

- **Android is native.** It compiles the same `tokio::fs`, `std::fs` and `std::thread` as desktop. **Only Web needs any of this.**
- `tokio::fs` is **13 call sites across 4 files** (`images.rs`, `scryfall.rs`, `combos.rs`, `marketplace_feed.rs`), not twenty modules.
- `images.rs`, `maintenance.rs`, `db.rs` and `paths.rs` are the heaviest `std::fs` users and are **desktop-and-Android only** — on Web the image cache is Cache Storage, not a filesystem, so a trait over `fs` would buy nothing there.

What genuinely must be shared across all three targets is **the feed pipeline**: download → decompress → parse → insert. That is this PR. The HTTP trait and the remaining fs surface follow in their own PRs, planned when their turn comes.

## Global Constraints

Copied verbatim from the spec and the repo's `CLAUDE.md`; every task's requirements implicitly include these.

- `npm run verify` before every commit. It does **not** run `cargo fmt` or `clippy`; CI does, and those are the only reds a fully green verify can produce. Run `cargo fmt` and `cargo clippy` in `src-tauri/` before each commit too.
- **Never install `@types/node`.** `xlsx` is banned. TypeScript stays on 6.0.x.
- **No new dependencies in this PR.** `flate2`, `serde_json` and `rusqlite` are already present.
- `clippy` caps function arguments at 7.
- **Never hand-write rows into `cards` or `sync_meta`** — it makes every later measurement a fiction. Tests use `Connection::open_in_memory()` plus `crate::schema::migrate`.
- Commit messages use `feat:` / `fix:` / `chore:` / `test:` / `refactor:`.
- **`data/` is the user's and is never committed.**

---

### Task 1: `feed::frame::Decoder` — sniff gzip, decompress incrementally

**Files:**
- Create: `src-tauri/src/feed/mod.rs`
- Create: `src-tauri/src/feed/frame.rs`
- Modify: `src-tauri/src/lib.rs` — add `pub mod feed;` beside the other `pub mod` lines
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/feed/frame.rs` (house style — every module in this crate tests inline)

**Interfaces:**
- Consumes: nothing.
- Produces: `feed::frame::Decoder` with `Decoder::new() -> Decoder`, `Decoder::push(&mut self, chunk: &[u8], out: &mut Vec<u8>) -> std::io::Result<()>`, `Decoder::finish(&mut self, out: &mut Vec<u8>) -> std::io::Result<()>`, `Decoder::is_gzip(&self) -> Option<bool>`.

> **Why it decides from the bytes and not from a header.** Spellbook serves `variants.json.gz` with `Content-Encoding: gzip` and keeps doing so even when the client asks for `identity`; Scryfall serves its `.jsonl.gz` with no `Content-Encoding` at all. A browser's `fetch` transparently decodes the former and **cannot be told not to**, so in a browser that body arrives already-plain while on desktop it arrives still-gzipped. The same URL, the same code, two different shapes — so the only thing that can be trusted is the two-byte magic.

> ⚠️ **`lib.rs` must actually name the module.** A module the crate never declares compiles nothing and runs no tests, and the suite stays green while reporting on nothing — this has cost this repo four waves of work before. Step 5 asserts the test count moved.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/feed/frame.rs` with only this test module and no implementation yet:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write as _;

    fn gzipped(bytes: &[u8]) -> Vec<u8> {
        let mut e = GzEncoder::new(Vec::new(), Compression::fast());
        e.write_all(bytes).unwrap();
        e.finish().unwrap()
    }

    /// The desktop shape: a real .gz file's bytes.
    #[test]
    fn decodes_a_gzip_stream() {
        let src = b"hello world, this is a line\n";
        let mut d = Decoder::new();
        let mut out = Vec::new();
        d.push(&gzipped(src), &mut out).unwrap();
        d.finish(&mut out).unwrap();
        assert_eq!(out, src);
        assert_eq!(d.is_gzip(), Some(true));
    }

    /// The browser shape: fetch already decompressed a Content-Encoding: gzip body,
    /// so the same feed arrives as plain bytes and must pass straight through.
    #[test]
    fn passes_plain_bytes_through_untouched() {
        let src = b"{\"id\":\"a\"}\n{\"id\":\"b\"}\n";
        let mut d = Decoder::new();
        let mut out = Vec::new();
        d.push(src, &mut out).unwrap();
        d.finish(&mut out).unwrap();
        assert_eq!(out, src);
        assert_eq!(d.is_gzip(), Some(false));
    }

    /// The sniff needs two bytes and a chunk is not guaranteed to carry them. A
    /// one-byte first chunk must not decide, and must not lose that byte either.
    #[test]
    fn sniffs_correctly_when_the_first_chunk_is_one_byte() {
        let full = gzipped(b"split header\n");
        let mut d = Decoder::new();
        let mut out = Vec::new();
        d.push(&full[..1], &mut out).unwrap();
        assert_eq!(d.is_gzip(), None, "one byte is not enough to decide");
        d.push(&full[1..], &mut out).unwrap();
        d.finish(&mut out).unwrap();
        assert_eq!(out, b"split header\n");
        assert_eq!(d.is_gzip(), Some(true));
    }

    /// Plain bytes whose first chunk is a single byte must also survive.
    #[test]
    fn a_one_byte_plain_first_chunk_is_not_lost() {
        let mut d = Decoder::new();
        let mut out = Vec::new();
        d.push(b"{", &mut out).unwrap();
        d.push(b"\"a\":1}", &mut out).unwrap();
        d.finish(&mut out).unwrap();
        assert_eq!(out, b"{\"a\":1}");
        assert_eq!(d.is_gzip(), Some(false));
    }

    /// Many small chunks must decode to exactly what one big chunk does.
    #[test]
    fn chunking_does_not_change_the_output() {
        let src: Vec<u8> = (0..500).map(|i| format!("line {i}\n")).collect::<String>().into_bytes();
        let gz = gzipped(&src);
        let mut whole = Vec::new();
        let mut d1 = Decoder::new();
        d1.push(&gz, &mut whole).unwrap();
        d1.finish(&mut whole).unwrap();

        let mut piecemeal = Vec::new();
        let mut d2 = Decoder::new();
        for c in gz.chunks(7) {
            d2.push(c, &mut piecemeal).unwrap();
        }
        d2.finish(&mut piecemeal).unwrap();

        assert_eq!(whole, src);
        assert_eq!(piecemeal, whole);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test feed::frame 2>&1 | tail -20`
Expected: **compile error** — `cannot find type Decoder in this scope`. A compile failure is the correct first red here; there is no implementation yet.

- [ ] **Step 3: Write the minimal implementation**

Add above the test module in `src-tauri/src/feed/frame.rs`:

```rust
//! Framing a byte stream, with no I/O and no database in sight.
//!
//! Everything here is push-shaped: the caller hands over chunks as they arrive and the
//! framer calls back with whatever became complete. That is not a stylistic choice — a
//! browser stream is push and async with no thread to block, so a pull parser
//! (`Read`, `Deserializer::from_reader`) cannot be driven from one at all.

/// Decompresses a byte stream if it is gzipped, and passes it through if it is not.
///
/// **The decision comes from the first two bytes, never from a header.** The same feed
/// arrives gzipped on desktop and already-decompressed in a browser, because `fetch`
/// transparently decodes `Content-Encoding: gzip` and offers no way to opt out.
pub struct Decoder {
    gz: Option<flate2::write::GzDecoder<Vec<u8>>>,
    /// Held back until two bytes have been seen and the question can be answered.
    pending: Vec<u8>,
    decided: bool,
}

impl Decoder {
    pub fn new() -> Self {
        Decoder {
            gz: None,
            pending: Vec::new(),
            decided: false,
        }
    }

    /// `Some(true)` gzip, `Some(false)` plain, `None` if fewer than two bytes have arrived.
    pub fn is_gzip(&self) -> Option<bool> {
        if !self.decided {
            return None;
        }
        Some(self.gz.is_some())
    }

    /// Push raw bytes; append whatever decoded to `out`.
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<u8>) -> std::io::Result<()> {
        use std::io::Write as _;

        if !self.decided {
            self.pending.extend_from_slice(chunk);
            if self.pending.len() < 2 {
                return Ok(());
            }
            let is_gz = self.pending[0] == 0x1f && self.pending[1] == 0x8b;
            self.decided = true;
            let buffered = std::mem::take(&mut self.pending);
            if is_gz {
                self.gz = Some(flate2::write::GzDecoder::new(Vec::new()));
            } else {
                out.extend_from_slice(&buffered);
                return Ok(());
            }
            // Fall through with the buffered bytes rather than the caller's chunk: the
            // buffered copy is the whole stream so far, and the chunk is only its tail.
            let gz = self.gz.as_mut().expect("just set");
            gz.write_all(&buffered)?;
            out.append(gz.get_mut());
            return Ok(());
        }

        match self.gz.as_mut() {
            Some(gz) => {
                gz.write_all(chunk)?;
                out.append(gz.get_mut());
            }
            None => out.extend_from_slice(chunk),
        }
        Ok(())
    }

    /// Flush the decompressor's tail. A plain stream has nothing to flush.
    pub fn finish(&mut self, out: &mut Vec<u8>) -> std::io::Result<()> {
        // A stream shorter than two bytes never decided; it is plain by definition.
        if !self.decided {
            self.decided = true;
            out.append(&mut self.pending);
            return Ok(());
        }
        if let Some(gz) = self.gz.as_mut() {
            gz.try_finish()?;
            out.append(gz.get_mut());
        }
        Ok(())
    }
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}
```

Create `src-tauri/src/feed/mod.rs`:

```rust
//! Reading a bulk feed, in a shape that works on a file and on a browser stream alike.

pub mod frame;
```

- [ ] **Step 4: Declare the module, or none of this runs**

In `src-tauri/src/lib.rs`, add `pub mod feed;` in alphabetical position among the existing `pub mod` declarations (between `pub mod export;` and `pub mod filters;`).

- [ ] **Step 5: Run the tests and confirm the count actually moved**

Run: `cd src-tauri && cargo test feed::frame 2>&1 | tail -12`
Expected: `test result: ok. 5 passed`.

**A filter that matches nothing also exits 0.** Confirm the number is 5 and not 0 — "expected PASS" proves nothing if the filter selected no tests, and an undeclared module produces exactly that.

- [ ] **Step 6: Mutate one test to prove it can fail**

Temporarily change `assert_eq!(d.is_gzip(), Some(false));` in `passes_plain_bytes_through_untouched` to `Some(true)`. Run the test; it must FAIL. Revert the change. **Report it if the test survives the mutation** — that means the assertion is not testing what it claims.

- [ ] **Step 7: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/feed/ src-tauri/src/lib.rs
git commit -m "feat(feed): a chunk decoder that sniffs gzip from the bytes

The same feed arrives gzipped on desktop and already-decompressed in a browser, because
fetch transparently decodes Content-Encoding: gzip and offers no way to opt out. Spellbook
sends that header even when the client asks for identity; Scryfall sends none at all. So the
only thing that can be trusted is the two-byte magic, and the sniff is deliberately tolerant
of a first chunk too short to answer."
```

> **Redirect `npm run verify` to a file and grep it.** Piping it to `tail` reports tail's exit code while tests fail underneath.

---

### Task 2: `feed::frame::Lines` — JSONL framing across chunk boundaries

**Files:**
- Modify: `src-tauri/src/feed/frame.rs` (add `Lines` above the test module; extend the test module)

**Interfaces:**
- Consumes: nothing from Task 1 at the type level; both live in the same module.
- Produces: `feed::frame::Lines` with `Lines::new() -> Lines`, `Lines::push(&mut self, bytes: &[u8], f: impl FnMut(&[u8]))`, `Lines::finish(&mut self, f: impl FnMut(&[u8]))`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `mod tests`:

```rust
fn collect_lines(chunks: &[&[u8]]) -> Vec<String> {
    let mut out = Vec::new();
    let mut l = Lines::new();
    for c in chunks {
        l.push(c, |line| out.push(String::from_utf8_lossy(line).into_owned()));
    }
    l.finish(|line| out.push(String::from_utf8_lossy(line).into_owned()));
    out
}

#[test]
fn frames_whole_lines() {
    assert_eq!(collect_lines(&[b"a\nbb\nccc\n"]), vec!["a", "bb", "ccc"]);
}

/// The case the whole type exists for: a line split across two chunks.
#[test]
fn a_line_split_across_chunks_is_emitted_once_and_whole() {
    assert_eq!(collect_lines(&[b"{\"id\":\"", b"abc\"}\n"]), vec!["{\"id\":\"abc\"}"]);
}

/// A final line with no trailing newline is still a line.
#[test]
fn an_unterminated_last_line_is_emitted_by_finish() {
    assert_eq!(collect_lines(&[b"one\ntwo"]), vec!["one", "two"]);
}

/// ...but a stream that ends exactly on a newline must not emit a phantom empty line.
#[test]
fn a_trailing_newline_does_not_emit_an_empty_line() {
    assert_eq!(collect_lines(&[b"one\ntwo\n"]), vec!["one", "two"]);
}

/// Byte-for-byte chunking must not change the answer.
#[test]
fn one_byte_chunks_frame_the_same_as_one_big_chunk() {
    let src: Vec<u8> = (0..200).map(|i| format!("line {i}\n")).collect::<String>().into_bytes();
    let whole = collect_lines(&[&src]);
    let mut out = Vec::new();
    let mut l = Lines::new();
    for b in src.chunks(1) {
        l.push(b, |line| out.push(String::from_utf8_lossy(line).into_owned()));
    }
    l.finish(|line| out.push(String::from_utf8_lossy(line).into_owned()));
    assert_eq!(out, whole);
    assert_eq!(out.len(), 200);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test feed::frame 2>&1 | tail -20`
Expected: compile error — `cannot find type Lines in this scope`.

- [ ] **Step 3: Write the minimal implementation**

Add to `src-tauri/src/feed/frame.rs`, above the test module:

```rust
/// Frames a byte stream into newline-terminated records.
///
/// Owns its own tail buffer rather than making the caller hold one. That is deliberate:
/// the drain and the state that describes it then change together in one place, which is
/// the class of bug this repo has already paid for once — see [`Elements`].
pub struct Lines {
    tail: Vec<u8>,
}

impl Lines {
    pub fn new() -> Self {
        Lines { tail: Vec::new() }
    }

    /// Feed decoded bytes; `f` is called once per complete line, without its newline.
    pub fn push(&mut self, bytes: &[u8], mut f: impl FnMut(&[u8])) {
        self.tail.extend_from_slice(bytes);
        let mut start = 0usize;
        while let Some(rel) = self.tail[start..].iter().position(|b| *b == b'\n') {
            let end = start + rel;
            f(&self.tail[start..end]);
            start = end + 1;
        }
        self.tail.drain(..start);
    }

    /// Emit a final unterminated line, if there is one. A stream that ended on a newline
    /// has nothing here — emitting an empty record would invent a row.
    pub fn finish(&mut self, mut f: impl FnMut(&[u8])) {
        if !self.tail.is_empty() {
            f(&self.tail);
            self.tail.clear();
        }
    }
}

impl Default for Lines {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test feed::frame 2>&1 | tail -12`
Expected: `test result: ok. 10 passed`.

- [ ] **Step 5: Mutate one test to prove it can fail**

Temporarily change `Lines::finish` to always call `f(&self.tail)` even when empty. Run: `a_trailing_newline_does_not_emit_an_empty_line` must FAIL. Revert. Report if it survives.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/feed/frame.rs
git commit -m "feat(feed): JSONL line framing that survives chunk boundaries

Owns its tail buffer rather than making the caller hold one, so the drain and the state
describing it can never fall out of step."
```

---

### Task 3: `feed::frame::Elements` — array framing, with the silent failure guarded

**Files:**
- Modify: `src-tauri/src/feed/frame.rs` (add `Elements`; extend the test module)

**Interfaces:**
- Consumes: nothing.
- Produces: `feed::frame::Elements` with `Elements::new() -> Elements`, `Elements::push(&mut self, bytes: &[u8], f: impl FnMut(&[u8]))`, `Elements::peak_buffer(&self) -> usize`.

> **This is the type that replaces `serde_json::Deserializer::from_reader`.** The Spellbook feed is one JSON object whose `variants` key holds the whole array, and `combos.rs` reads it today with a `DeserializeSeed` over a `Read` — a **pull** parser that blocks for more input. There is no thread to block in a browser, so it cannot be driven from a stream at all. This frames each top-level element by brace depth and hands the complete bytes to `serde_json::from_slice`, which keeps serde for the part serde is good at.

> ⚠️ **This framer fails silently when it is wrong.** The spike's first version found **63 elements in 610 MB** and grew its buffer to 609.82 MB — no error, no panic, just a wrong answer and a runaway allocation. The cause was per-element state surviving a buffer drain, so a rescan counted the same braces twice and depth never returned to zero. Two defences, both required: `Elements` **owns its buffer** so drain and reset happen in one place, and `peak_buffer()` exists so tests can assert the thing a row count cannot see.

- [ ] **Step 1: Write the failing test**

Append inside `mod tests`:

```rust
fn collect_elements(chunks: &[&[u8]]) -> (Vec<String>, usize) {
    let mut out = Vec::new();
    let mut e = Elements::new();
    for c in chunks {
        e.push(c, |el| out.push(String::from_utf8_lossy(el).into_owned()));
    }
    (out, e.peak_buffer())
}

#[test]
fn frames_the_elements_of_the_variants_array() {
    let doc = br#"{"timestamp":"t","variants":[{"id":"a"},{"id":"b"},{"id":"c"}]}"#;
    let (els, _) = collect_elements(&[doc]);
    assert_eq!(els, vec![r#"{"id":"a"}"#, r#"{"id":"b"}"#, r#"{"id":"c"}"#]);
}

/// Nested objects must not end the element early.
#[test]
fn nested_objects_do_not_close_an_element() {
    let doc = br#"{"variants":[{"id":"a","card":{"n":{"deep":1}}},{"id":"b"}]}"#;
    let (els, _) = collect_elements(&[doc]);
    assert_eq!(els, vec![r#"{"id":"a","card":{"n":{"deep":1}}}"#, r#"{"id":"b"}"#]);
}

/// A brace inside a string is text, not structure. Card names really do contain them.
#[test]
fn a_brace_inside_a_string_is_not_structure() {
    let doc = br#"{"variants":[{"n":"Chandra, {T}: deal damage"},{"n":"ok"}]}"#;
    let (els, _) = collect_elements(&[doc]);
    assert_eq!(els.len(), 2);
    assert!(els[0].contains("{T}"));
}

/// An escaped quote does not end the string, so the brace after it is still text.
#[test]
fn an_escaped_quote_does_not_end_a_string() {
    let doc = br#"{"variants":[{"n":"say \"hi\" }"},{"n":"second"}]}"#;
    let (els, _) = collect_elements(&[doc]);
    assert_eq!(els.len(), 2, "the escaped quote must not desynchronise the framer");
    assert_eq!(els[1], r#"{"n":"second"}"#);
}

/// The regression test for the spike's silent failure: chunked input must frame every
/// element AND must not accumulate the document in memory.
#[test]
fn chunked_input_frames_every_element_and_keeps_the_buffer_small() {
    let mut doc = String::from(r#"{"timestamp":"t","variants":["#);
    for i in 0..2000 {
        if i > 0 {
            doc.push(',');
        }
        doc.push_str(&format!(r#"{{"id":"v{i}","pad":"{}"}}"#, "x".repeat(200)));
    }
    doc.push_str("]}");
    let bytes = doc.into_bytes();

    let mut out = 0usize;
    let mut e = Elements::new();
    for c in bytes.chunks(64) {
        e.push(c, |_| out += 1);
    }
    assert_eq!(out, 2000, "every element must be framed");
    // The whole document is ~430 KB. A framer that fails to drain grows to hold all of
    // it — which is exactly how the spike's bug looked, and a row count alone cannot see it.
    assert!(
        e.peak_buffer() < 8 * 1024,
        "peak buffer was {} bytes; the framer is not draining",
        e.peak_buffer()
    );
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test feed::frame 2>&1 | tail -20`
Expected: compile error — `cannot find type Elements in this scope`.

- [ ] **Step 3: Write the minimal implementation**

Add to `src-tauri/src/feed/frame.rs`, above the test module:

```rust
/// Frames the top-level elements of the first JSON array in a stream.
///
/// Used for Commander Spellbook's `variants.json.gz`, whose whole payload is one array
/// under a `variants` key.
pub struct Elements {
    /// The first `[` seen opens the array this frames. The Spellbook document has no other
    /// array before `variants`; if that ever changes, this is the line that breaks.
    entered: bool,
    depth: i32,
    in_string: bool,
    escaped: bool,
    /// Byte offset of the current element's opening brace, within `buf`.
    start: Option<usize>,
    /// Scanned up to here already; reset whenever `buf` is drained.
    scanned: usize,
    buf: Vec<u8>,
    peak: usize,
}

impl Elements {
    pub fn new() -> Self {
        Elements {
            entered: false,
            depth: 0,
            in_string: false,
            escaped: false,
            start: None,
            scanned: 0,
            buf: Vec::new(),
            peak: 0,
        }
    }

    /// The largest the internal buffer has ever been, in bytes.
    ///
    /// Exists so tests can assert the thing a row count cannot see: a framer that stops
    /// draining still returns rows for a while and then quietly holds the whole document.
    pub fn peak_buffer(&self) -> usize {
        self.peak
    }

    pub fn push(&mut self, bytes: &[u8], mut f: impl FnMut(&[u8])) {
        self.buf.extend_from_slice(bytes);
        if self.buf.len() > self.peak {
            self.peak = self.buf.len();
        }

        let mut consumed = 0usize;
        let mut i = self.scanned;
        while i < self.buf.len() {
            let b = self.buf[i];
            if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if b == b'\\' {
                    self.escaped = true;
                } else if b == b'"' {
                    self.in_string = false;
                }
                i += 1;
                continue;
            }
            match b {
                b'"' => self.in_string = true,
                b'[' if !self.entered => self.entered = true,
                b'{' if self.entered => {
                    if self.depth == 0 {
                        self.start = Some(i);
                    }
                    self.depth += 1;
                }
                b'}' if self.entered => {
                    self.depth -= 1;
                    if self.depth == 0 {
                        if let Some(s) = self.start.take() {
                            f(&self.buf[s..=i]);
                            consumed = i + 1;
                        }
                    }
                }
                _ => {}
            }
            i += 1;
        }

        if consumed > 0 {
            // `consumed` is always the byte just past a closing brace, so the state that
            // describes the current element is empty by construction — and resetting it
            // HERE, in the same statement as the drain, is what stops the rescan below
            // from counting the same braces twice. Splitting these two apart is the bug
            // that found 63 elements in 610 MB.
            self.buf.drain(..consumed);
            self.depth = 0;
            self.start = None;
            self.in_string = false;
            self.escaped = false;
            self.scanned = 0;
        } else {
            self.scanned = self.buf.len();
        }
    }
}

impl Default for Elements {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test feed::frame 2>&1 | tail -12`
Expected: `test result: ok. 15 passed`.

- [ ] **Step 5: Mutate the guard to prove it can fail**

Temporarily delete the four state-reset lines (`self.depth = 0;` through `self.escaped = false;`) inside the `if consumed > 0` branch — reproducing the spike's bug exactly. Run the tests.

Expected: `chunked_input_frames_every_element_and_keeps_the_buffer_small` FAILS on **both** assertions — a low element count and a peak buffer in the hundreds of kilobytes. Revert.

**If it does not fail, stop and report it** — the regression test is not guarding what it claims to guard, which is worse than having no test.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/feed/frame.rs
git commit -m "feat(feed): frame JSON array elements by brace depth, with the buffer asserted

Replaces the pull parser for the combo feed: serde_json::Deserializer::from_reader blocks
for more input, and a browser stream has no thread to block. This frames each element and
hands it whole to from_slice, keeping serde for the part serde is good at.

peak_buffer() is not diagnostics. A framer that stops draining still returns rows for a
while and then silently holds the entire document - the spike's first version found 63
elements in 610 MB and grew to 609.82 MB without erroring. A row count cannot see that;
the buffer size can, so a test asserts it."
```

---

### Task 4: `ingest::ingest_stream` — the card ingest takes chunks

**Files:**
- Modify: `src-tauri/src/ingest.rs:87-140` (`ingest_gz` becomes a wrapper; add `ingest_stream`)
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/ingest.rs` (extend; the existing `gz_fixture`, `mem_db` and `card_line` helpers are already there)

**Interfaces:**
- Consumes: `feed::frame::Decoder`, `feed::frame::Lines` from Tasks 1–2.
- Produces: `ingest::ingest_stream(db: &Mutex<Connection>, chunks: impl Iterator<Item = std::io::Result<Vec<u8>>>, progress: &mut dyn FnMut(u64)) -> Result<IngestStats, IngestError>`. `ingest_gz` keeps its exact current signature and behaviour.

> **Desktop behaviour must not change.** `ingest_gz(db, path, progress)` keeps working and keeps its tests; it just becomes a file-shaped caller of the new function. The browser will later call `ingest_stream` directly with chunks from `fetch`.

- [ ] **Step 1: Write the failing test**

Append inside `ingest.rs`'s existing `mod tests`:

```rust
/// The new entry point must produce exactly what the file-shaped one does.
#[test]
fn ingest_stream_matches_ingest_gz_row_for_row() {
    let lines: Vec<String> = (0..50).map(card_line).collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let path = gz_fixture(&refs);
    let bytes = std::fs::read(&path).unwrap();

    let db_a = mem_db();
    let a = ingest_gz(&db_a, &path, &mut |_| {}).unwrap();

    let db_b = mem_db();
    let chunks = bytes.chunks(64).map(|c| Ok(c.to_vec())).collect::<Vec<_>>();
    let b = ingest_stream(&db_b, chunks.into_iter(), &mut |_| {}).unwrap();

    assert_eq!(a.inserted, b.inserted);
    assert_eq!(a.skipped, b.skipped);
    assert_eq!(b.inserted, 50);
}

/// The browser case: fetch already decompressed the body, so the same content arrives
/// plain. It must ingest identically.
#[test]
fn ingest_stream_accepts_already_decompressed_bytes() {
    let lines: Vec<String> = (0..30).map(card_line).collect();
    let mut plain = Vec::new();
    for l in &lines {
        plain.extend_from_slice(l.as_bytes());
        plain.push(b'\n');
    }
    let db = mem_db();
    let chunks = plain.chunks(31).map(|c| Ok(c.to_vec())).collect::<Vec<_>>();
    let stats = ingest_stream(&db, chunks.into_iter(), &mut |_| {}).unwrap();
    assert_eq!(stats.inserted, 30);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test ingest:: 2>&1 | tail -20`
Expected: compile error — `cannot find function ingest_stream in this scope`.

- [ ] **Step 3: Write the implementation**

In `src-tauri/src/ingest.rs`, replace the body of `ingest_gz` (lines 87–140, from `pub fn ingest_gz(` down to the end of the `for line in reader.lines()` loop and its tail flush) so that `ingest_gz` opens the file, reads it in chunks and delegates. Add `ingest_stream` beside it:

```rust
/// Ingest from a file. The desktop entry point, unchanged in signature and behaviour.
pub fn ingest_gz(
    db: &Mutex<Connection>,
    gz_path: &Path,
    progress: &mut dyn FnMut(u64),
) -> Result<IngestStats, IngestError> {
    use std::io::Read as _;

    // Opened before the database is touched: a missing or unreadable path must not
    // cost the caller the staging table it was about to fill.
    let mut file = std::fs::File::open(gz_path)?;
    let chunks = std::iter::from_fn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        match file.read(&mut buf) {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some(Ok(buf))
            }
            Err(e) => Some(Err(e)),
        }
    });
    ingest_stream(db, chunks, progress)
}

/// Ingest from a stream of byte chunks — gzipped or not, the decoder decides.
///
/// The platform-neutral entry point: desktop feeds it a file and the browser feeds it
/// `fetch`. Peak memory is one chunk plus one batch, exactly as the file version was.
pub fn ingest_stream(
    db: &Mutex<Connection>,
    chunks: impl Iterator<Item = std::io::Result<Vec<u8>>>,
    progress: &mut dyn FnMut(u64),
) -> Result<IngestStats, IngestError> {
    {
        let conn = crate::db::lock_blocking(db);
        schema::create_staging(&conn)?;
    }
    let mut stats = IngestStats {
        inserted: 0,
        skipped: 0,
    };
    let mut batch: Vec<CardRow> = Vec::with_capacity(BATCH as usize);
    let mut decoder = crate::feed::frame::Decoder::new();
    let mut lines = crate::feed::frame::Lines::new();
    let mut decoded: Vec<u8> = Vec::new();

    // Parsing happens with the lock *not* held — it is the expensive half of the loop,
    // and the whole point of chunking is that the connection is free during it.
    let mut take_line = |line: &[u8], stats: &mut IngestStats, batch: &mut Vec<CardRow>| {
        if line.is_empty() {
            return;
        }
        let Ok(text) = std::str::from_utf8(line) else {
            stats.skipped += 1;
            return;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
            stats.skipped += 1;
            return;
        };
        let Some(row) = CardRow::from_json_line(&v, text) else {
            stats.skipped += 1;
            return;
        };
        batch.push(row);
    };

    for chunk in chunks {
        let chunk = chunk?;
        decoded.clear();
        decoder.push(&chunk, &mut decoded)?;
        lines.push(&decoded, |line| take_line(line, &mut stats, &mut batch));
        while batch.len() as u64 >= BATCH {
            let n = batch.len().min(BATCH as usize);
            stats.inserted += n as u64;
            let mut head: Vec<CardRow> = batch.drain(..n).collect();
            write_batch(db, &mut head)?;
            progress(stats.inserted);
        }
    }
    decoded.clear();
    decoder.finish(&mut decoded)?;
    lines.push(&decoded, |line| take_line(line, &mut stats, &mut batch));
    lines.finish(|line| take_line(line, &mut stats, &mut batch));

    if !batch.is_empty() {
        stats.inserted += batch.len() as u64;
        write_batch(db, &mut batch)?;
    }

    // Nothing parsed as a card: the download is bad, not the collection. Swapping here
    // would trade a working card database for an empty one, so refuse — and drop the
    // empty staging table rather than leave it lying around.
    if stats.inserted == 0 {
        let conn = crate::db::lock_blocking(db);
        conn.execute_batch("DROP TABLE IF EXISTS cards_staging")?;
        return Err(IngestError::Empty);
    }
    Ok(stats)
}
```

Leave everything after the `stats.inserted == 0` check in the original `ingest_gz` — the swap, the FTS rebuild and the return — in whichever function currently owns it, unchanged. If that tail lives inside `ingest_gz`, move it verbatim into `ingest_stream` so both entry points get it.

Remove the now-unused `use flate2::read::GzDecoder;` and `use std::io::{BufRead, BufReader};` imports at `ingest.rs:21-23` if nothing else in the file needs them; `cargo clippy -D warnings` will fail the commit if they are left dangling.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test ingest:: 2>&1 | tail -12`
Expected: every pre-existing ingest test still passes, plus the two new ones. **The pre-existing tests are the real assertion here** — they are what proves desktop behaviour did not change.

- [ ] **Step 5: Mutate to prove the equivalence test bites**

Temporarily change the chunk size in `ingest_stream`'s caller test from `bytes.chunks(64)` to `bytes.chunks(1)`. It must still pass — one-byte chunks are the hardest case and the framers are built for it. Then temporarily break `Lines::push` to drop the last complete line of each chunk; `ingest_stream_matches_ingest_gz_row_for_row` must FAIL. Revert both.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/ingest.rs
git commit -m "refactor(ingest): take a stream of chunks, not a path

ingest_gz keeps its signature and its tests and becomes a file-shaped caller of
ingest_stream, so desktop behaviour is unchanged and the pre-existing tests are what proves
it. The browser will call ingest_stream directly with chunks from fetch.

Peak memory is still one chunk plus one batch, and the connection is still taken once per
batch rather than held across the parse."
```

---

### Task 5: `combos::ingest_stream` — the combo ingest takes chunks

**Files:**
- Modify: `src-tauri/src/combos.rs:405-430` (replace `read_file`'s pull parser), `src-tauri/src/combos.rs:696-712` (`ingest_gz` becomes a wrapper)
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/combos.rs` (extend)

**Interfaces:**
- Consumes: `feed::frame::Decoder`, `feed::frame::Elements` from Tasks 1 and 3; `combos::reduce`, `combos::RawVariant`, `combos::ComboFile`, `combos::store` — all already in `combos.rs` and unchanged.
- Produces: `combos::read_stream(chunks: impl Iterator<Item = std::io::Result<Vec<u8>>>) -> Result<ComboFile, ComboError>` and `combos::ingest_stream(db: &Mutex<Connection>, chunks: impl Iterator<Item = std::io::Result<Vec<u8>>>, etag: Option<&str>, fetched_at: i64, progress: &mut dyn FnMut(u64, u64)) -> Result<Ingested, ComboError>`. `ingest_gz` keeps its exact current signature.

> `reduce` and `store` are not touched. Only *how the bytes become `RawVariant`s* changes.

- [ ] **Step 1: Write the failing test**

Append inside `combos.rs`'s existing `mod tests`. Reuse whatever fixture builder that module already has for a `variants` document; if it builds a `String`, gzip it with the same `GzEncoder` pattern `ingest.rs` uses.

```rust
/// Many distinct variants, built from the module's own helpers.
fn many_variants(n: usize) -> String {
    let vs: Vec<String> = (0..n)
        .map(|i| {
            ok_variant(
                &format!("v{i}"),
                "R",
                &[("Card A", &format!("o{i}a")), ("Card B", &format!("o{i}b"))],
            )
        })
        .collect();
    document(&vs)
}

/// The stream path must reduce a document to exactly what the file path does.
#[test]
fn read_stream_matches_read_file() {
    let doc = many_variants(120);
    let bytes = doc.clone().into_bytes();

    let from_file = parse(&doc);
    let chunks = bytes.chunks(97).map(|c| Ok(c.to_vec())).collect::<Vec<_>>();
    let from_stream = read_stream(chunks.into_iter()).unwrap();

    assert_eq!(from_file.seen, from_stream.seen);
    assert_eq!(from_file.skipped, from_stream.skipped);
    assert_eq!(from_file.combos.len(), from_stream.combos.len());
    // `stamp` is Option<String>; both paths must find the document's own timestamp.
    assert_eq!(from_file.stamp, from_stream.stamp);
    assert_eq!(from_stream.stamp.as_deref(), Some("2026-08-27T03:12:44Z"));
    for (a, b) in from_file.combos.iter().zip(from_stream.combos.iter()) {
        assert_eq!(a.id, b.id);
        assert_eq!(a.bracket_tag, b.bracket_tag);
        assert_eq!(a.card_count, b.card_count);
    }
}

/// The browser case: already-decompressed bytes must ingest like gzipped ones.
#[test]
fn read_stream_accepts_plain_and_gzipped_alike() {
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write as _;

    let doc = many_variants(40);
    let plain = doc.into_bytes();
    let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
    enc.write_all(&plain).unwrap();
    let gz = enc.finish().unwrap();

    let a = read_stream(plain.chunks(64).map(|c| Ok(c.to_vec()))).unwrap();
    let b = read_stream(gz.chunks(64).map(|c| Ok(c.to_vec()))).unwrap();
    assert_eq!(a.combos.len(), b.combos.len());
    assert_eq!(a.seen, b.seen);
    assert_eq!(a.stamp, b.stamp);
    assert!(a.seen > 0, "the fixture must actually contain variants");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test combos:: 2>&1 | tail -20`
Expected: compile error — `cannot find function read_stream in this scope`.

- [ ] **Step 3: Write the implementation**

Add to `src-tauri/src/combos.rs`, beside `read_file` (which stays, so the existing tests keep their entry point):

```rust
/// Read `{ timestamp, version, variants: [ … ] }` from a stream of byte chunks.
///
/// **Why this exists beside [`read_file`].** That one streams with
/// `serde_json::Deserializer::from_reader` plus a `DeserializeSeed` — a *pull* parser,
/// which calls `read()` when it wants more and blocks until it gets it. A browser stream
/// is push and async with no thread to block, so `from_reader` cannot be driven from one
/// at all. This frames each element by brace depth and hands it whole to `from_slice`,
/// which keeps serde doing the part serde is good at.
///
/// Peak memory is one element plus the reduced list, the same as `read_file`'s.
pub fn read_stream(
    chunks: impl Iterator<Item = std::io::Result<Vec<u8>>>,
) -> Result<ComboFile, ComboError> {
    let mut file = ComboFile::default();
    let mut decoder = crate::feed::frame::Decoder::new();
    let mut elements = crate::feed::frame::Elements::new();
    let mut decoded: Vec<u8> = Vec::new();
    // The document's own `timestamp` sits before `variants`, so it is scraped from the
    // head rather than parsed structurally — the framer deliberately does not model the
    // enclosing object.
    let mut head: Vec<u8> = Vec::new();

    for chunk in chunks {
        let chunk = chunk?;
        decoded.clear();
        decoder.push(&chunk, &mut decoded)?;
        if head.len() < 512 {
            let want = 512 - head.len();
            head.extend_from_slice(&decoded[..decoded.len().min(want)]);
        }
        elements.push(&decoded, |el| {
            file.seen += 1;
            match serde_json::from_slice::<RawVariant>(el) {
                Ok(raw) => match reduce(raw) {
                    Some(combo) => file.combos.push(combo),
                    None => file.skipped += 1,
                },
                Err(_) => file.skipped += 1,
            }
        });
    }
    decoded.clear();
    decoder.finish(&mut decoded)?;
    elements.push(&decoded, |el| {
        file.seen += 1;
        match serde_json::from_slice::<RawVariant>(el) {
            Ok(raw) => match reduce(raw) {
                Some(combo) => file.combos.push(combo),
                None => file.skipped += 1,
            },
            Err(_) => file.skipped += 1,
        }
    });

    file.stamp = stamp_from_head(&head);
    Ok(file)
}

/// Pull the document's `"timestamp"` out of its first bytes.
///
/// A scrape and not a parse, because the enclosing object is never modelled: the framer
/// starts at the first `[`. `None` for a document that omits the key, which is what
/// [`read_file`] also produces — `ComboFile::stamp` is `Option<String>` precisely because
/// a file without one is a real state rather than an error.
fn stamp_from_head(head: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(head);
    let rest = text.split_once("\"timestamp\"").map(|(_, r)| r)?;
    // Past the colon and the opening quote of the value.
    let rest = rest.split_once('"').map(|(_, r)| r)?;
    Some(rest.split('"').next()?.to_owned())
}

/// Ingest the combo feed from a stream of byte chunks.
pub fn ingest_stream(
    db: &Mutex<Connection>,
    chunks: impl Iterator<Item = std::io::Result<Vec<u8>>>,
    etag: Option<&str>,
    fetched_at: i64,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Ingested, ComboError> {
    let file = read_stream(chunks)?;
    store(db, &file, etag, fetched_at, progress)
}
```

Then rewrite `ingest_gz` (currently `combos.rs:696-712`) to delegate, keeping its signature exactly:

```rust
pub fn ingest_gz(
    db: &Mutex<Connection>,
    gz_path: &Path,
    etag: Option<&str>,
    fetched_at: i64,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Ingested, ComboError> {
    use std::io::Read as _;

    // Opened before the database is touched: a missing or unreadable path must not cost
    // the caller the staging tables it was about to fill.
    let mut handle = std::fs::File::open(gz_path)?;
    let chunks = std::iter::from_fn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        match handle.read(&mut buf) {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some(Ok(buf))
            }
            Err(e) => Some(Err(e)),
        }
    });
    ingest_stream(db, chunks, etag, fetched_at, progress)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test combos:: 2>&1 | tail -12`
Expected: every pre-existing combo test still passes, plus the two new ones. If `read_stream_matches_read_file` shows a different `seen`, the framer's `entered` heuristic has found an array before `variants` — check the fixture for one.

- [ ] **Step 5: Mutate to prove the equivalence test bites**

Temporarily change `reduce`'s Commander-legality check to accept everything. `read_stream_matches_read_file` must still pass (both paths call the same `reduce`), but the combo counts in the pre-existing `store` tests must change. Then temporarily make `Elements::push` skip every second element; `read_stream_matches_read_file` must FAIL on `seen`. Revert both.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/combos.rs
git commit -m "refactor(combos): read the variants array from a stream of chunks

read_file stays and keeps its tests; read_stream is the platform-neutral path. The pull
parser it replaces (Deserializer::from_reader + DeserializeSeed) blocks for more input, and
a browser stream has no thread to block, so it could not be driven from one at all.

reduce and store are untouched - only how bytes become RawVariants changed - and the new
test asserts the two paths agree variant for variant."
```

---

## Self-Review

**Spec coverage.** This plan implements spec §4.1 (the combo push-parser rewrite, Tasks 3 and 5), §4.2 (gzip sniffing from the bytes, Task 1), and §4.3 (`ingest_gz` takes a stream, Task 4). It does **not** implement the `Fs`, `Http` and `Spawn` traits sketched in §4 — deliberately, and the reasoning is at the top of this document: Android is native, so only Web needs them, and Web's need is this pipeline. `marketplace_feed.rs` also downloads-then-ingests and is **not** covered here; it follows the same shape and gets its own task in the HTTP-trait PR, where its client construction is already being touched.

**Placeholders.** None. Every step carries the code it needs; no step says "similar to Task N".

**Type consistency.** `Decoder::push(&[u8], &mut Vec<u8>) -> io::Result<()>` and `Decoder::finish` are used with those exact signatures in Tasks 4 and 5. `Lines::push`/`Lines::finish` take `impl FnMut(&[u8])` and are called that way in Task 4. `Elements::push` takes `impl FnMut(&[u8])` and is called that way in Task 5. `peak_buffer()` is defined in Task 3 and asserted in Task 3 only. Both `ingest_stream` functions take `impl Iterator<Item = std::io::Result<Vec<u8>>>`, and both `ingest_gz` wrappers build exactly that with `std::iter::from_fn`.

**Two things were checked against the source rather than assumed, and the plan was wrong about both before the check:**

- `ComboFile::stamp` is **`Option<String>`**, not `String`. `stamp_from_head` returns `Option<String>` and yields `None` for a document with no `timestamp`, which is the state `read_file` already produces.
- `combos.rs`'s test module has **no `variants_fixture`**. Its real helpers are `document(&[String]) -> String`, `ok_variant(id, tag, cards) -> String` and `parse(&str) -> ComboFile`. Task 5 builds on those and adds one local `many_variants(n)` on top of them rather than a second fixture builder.
