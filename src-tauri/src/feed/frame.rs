//! Framing a byte stream, with no I/O and no database in sight.
//!
//! Everything here is push-shaped: the caller hands over chunks as they arrive and the
//! framer calls back with whatever became complete. That is not a stylistic choice — a
//! browser stream is push and async with no thread to block, so a pull parser
//! (`Read`, `Deserializer::from_reader`) cannot be driven from one at all.

/// A framer that has stopped draining, refused before it becomes the whole document.
///
/// **The failure this exists for is silence, not a wrong number.** The spike's first element
/// framer found 63 elements in a 610.2 MB document and grew its buffer to 609.82 MB *without
/// erroring* — a row count cannot see that, and neither can a caller that only checks the
/// `Result`. [`Elements::peak_buffer`] is how a test sees it; this is what stops a real run
/// paying for it, on a target where the whole database is in one Worker's linear memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Overlong {
    /// What the framer was holding when it gave up.
    pub bytes: usize,
    /// The cap it passed — [`MAX_ELEMENT_BYTES`] or [`MAX_LINE_BYTES`].
    pub cap: usize,
    /// `"element"` or `"line"`, so the sentence names which framer stalled.
    pub unit: &'static str,
}

impl std::fmt::Display for Overlong {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(
            f,
            "the framer buffered {} bytes without completing one {} (cap {}); \
             the stream is not what this parser expects",
            self.bytes, self.unit, self.cap
        )
    }
}

impl std::error::Error for Overlong {}

/// So each caller lifts this into the `Io` variant its own error enum already has, rather
/// than four enums each growing a variant for one condition.
impl From<Overlong> for std::io::Error {
    fn from(e: Overlong) -> Self {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
    }
}

/// How much [`Elements`] may hold without completing one element.
///
/// **8 MiB against a measured 2.01 MB peak** on Commander Spellbook's real 610.2 MB document
/// (2026-08-27, a desktop and a OnePlus 12 alike) — four times the largest reading this repo
/// has ever taken, so a legitimate element cannot reach it while a desynchronised framer
/// passes it within a document's first few chunks.
pub const MAX_ELEMENT_BYTES: usize = 8 * 1024 * 1024;

/// How much [`Lines`] may hold without seeing a newline.
///
/// The same slack for the same reason one framer over. The longest line either JSONL feed
/// serves is one Scryfall card, measured in single-digit KB.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

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

/// Frames a byte stream into newline-terminated records.
///
/// Owns its own tail buffer rather than making the caller hold one. That is deliberate:
/// the drain and the state that describes it then change together in one place, which is
/// the class of bug this repo has already paid for once.
pub struct Lines {
    tail: Vec<u8>,
}

impl Lines {
    pub fn new() -> Self {
        Lines { tail: Vec::new() }
    }

    /// Feed decoded bytes; `f` is called once per complete line, without its newline.
    ///
    /// Errors with [`Overlong`] once the unterminated tail passes [`MAX_LINE_BYTES`] — a
    /// stream with no newline in it is not JSONL, and holding it whole is the failure the
    /// element framer already paid for once.
    pub fn push(&mut self, bytes: &[u8], mut f: impl FnMut(&[u8])) -> Result<(), Overlong> {
        self.tail.extend_from_slice(bytes);
        let mut start = 0usize;
        while let Some(rel) = self.tail[start..].iter().position(|b| *b == b'\n') {
            let end = start + rel;
            f(&self.tail[start..end]);
            start = end + 1;
        }
        self.tail.drain(..start);
        // Checked **after** the drain, so a chunk that both completes lines and leaves a
        // short tail behind cannot be refused for a length it no longer holds.
        if self.tail.len() > MAX_LINE_BYTES {
            return Err(Overlong {
                bytes: self.tail.len(),
                cap: MAX_LINE_BYTES,
                unit: "line",
            });
        }
        Ok(())
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

/// Frames the top-level elements of the first JSON array in a stream.
///
/// Used for Commander Spellbook's `variants.json.gz`, whose whole payload is one array
/// under a `variants` key.
pub struct Elements {
    /// The first `[` seen opens the array this frames. The Spellbook document has no other
    /// array before `variants`; if that ever changes, this is the line that breaks.
    entered: bool,
    /// …and the matching `]` closes it, after which nothing is framed again.
    ///
    /// **Without this the framer went on emitting every depth-0 object in the rest of the
    /// document**, which is not a hypothetical: Card Kingdom's pricelist carries keys after
    /// `data`, and each one's value was framed as though it were a price row. It never
    /// produced a *price* — those objects have no `scryfall_id` — but it inflated `rows_seen`
    /// and `skipped`, which is how the push and pull readers were caught disagreeing.
    done: bool,
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
            done: false,
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

    /// Feed decoded bytes; `f` is called once per complete top-level element of the array.
    ///
    /// Errors with [`Overlong`] once the buffer passes [`MAX_ELEMENT_BYTES`] without an
    /// element having closed. **That is the guard [`Self::peak_buffer`] only reports on**: a
    /// framer that has desynchronised goes on returning `Ok(())` and accumulating for as long
    /// as the document lasts, which is what "63 elements in 610 MB" looked like from outside.
    pub fn push(&mut self, bytes: &[u8], mut f: impl FnMut(&[u8])) -> Result<(), Overlong> {
        // Everything after the array's own `]` belongs to some other key, and framing it
        // would invent rows. Dropped rather than buffered, so a long tail costs nothing.
        if self.done {
            return Ok(());
        }
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
                // The array's own closing bracket, which can only be seen between elements.
                // Inside one, `depth` is at least 1 and a `]` there is an element's own.
                b']' if self.entered && self.depth == 0 => {
                    self.done = true;
                    break;
                }
                b'{' if self.entered => {
                    if self.depth == 0 {
                        self.start = Some(i);
                    }
                    self.depth += 1;
                }
                b'}' if self.entered => {
                    self.depth -= 1;
                    if self.depth == 0 {
                        if let Some(st) = self.start.take() {
                            f(&self.buf[st..=i]);
                            consumed = i + 1;
                        }
                    }
                }
                _ => {}
            }
            i += 1;
        }

        if self.done {
            self.buf.clear();
            self.scanned = 0;
            return Ok(());
        }

        if consumed > 0 {
            // `consumed` is always the byte just past a closing brace, so the state that
            // describes the current element is empty by construction - and resetting it
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

        // After the drain, for [`Lines::push`]'s reason: what is left is what the framer is
        // genuinely still holding, and only that can be a stall.
        if self.buf.len() > MAX_ELEMENT_BYTES {
            return Err(Overlong {
                bytes: self.buf.len(),
                cap: MAX_ELEMENT_BYTES,
                unit: "element",
            });
        }
        Ok(())
    }
}

impl Default for Elements {
    fn default() -> Self {
        Self::new()
    }
}

/// How much of a document's head is kept so a top-level stamp can be scraped out of it.
///
/// Both feeds that need one put it within the first few dozen bytes — Commander Spellbook's
/// `timestamp` and Card Kingdom's `meta.created_at`. This is slack, not a measurement.
pub const HEAD_SCRAPE_BYTES: usize = 512;

/// Keep the first [`HEAD_SCRAPE_BYTES`] of the decoded stream, for [`scrape_string`].
pub fn take_head(head: &mut Vec<u8>, decoded: &[u8]) {
    if head.len() < HEAD_SCRAPE_BYTES {
        let want = HEAD_SCRAPE_BYTES - head.len();
        head.extend_from_slice(&decoded[..decoded.len().min(want)]);
    }
}

/// Pull the value of a top-level string `key` out of a document's first bytes.
///
/// **A scrape and not a parse, because [`Elements`] never models the enclosing object**: it
/// starts at the first `[`, so anything written beside the array — the file's own build stamp
/// — is not something the framer can hand back. `None` for a document that omits the key,
/// which is a real state rather than an error: Mana Pool publishes no stamp at all, and Card
/// Kingdom's would be missing here if it ever moved its `meta` after its `data`.
pub fn scrape_string(head: &[u8], key: &str) -> Option<String> {
    let text = String::from_utf8_lossy(head);
    let rest = text.split_once(&format!("\"{key}\"")).map(|(_, r)| r)?;
    // Past the colon and the opening quote of the value.
    let rest = rest.split_once('"').map(|(_, r)| r)?;
    Some(rest.split('"').next()?.to_owned())
}

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
        let src: Vec<u8> = (0..500)
            .map(|i| format!("line {i}\n"))
            .collect::<String>()
            .into_bytes();
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

    fn collect_lines(chunks: &[&[u8]]) -> Vec<String> {
        let mut out = Vec::new();
        let mut l = Lines::new();
        for c in chunks {
            l.push(c, |line| {
                out.push(String::from_utf8_lossy(line).into_owned())
            })
            .unwrap();
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
        assert_eq!(
            collect_lines(&[b"{\"id\":\"", b"abc\"}\n"]),
            vec!["{\"id\":\"abc\"}"]
        );
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
        let src: Vec<u8> = (0..200)
            .map(|i| format!("line {i}\n"))
            .collect::<String>()
            .into_bytes();
        let whole = collect_lines(&[&src]);
        let mut out = Vec::new();
        let mut l = Lines::new();
        for b in src.chunks(1) {
            l.push(b, |line| {
                out.push(String::from_utf8_lossy(line).into_owned())
            })
            .unwrap();
        }
        l.finish(|line| out.push(String::from_utf8_lossy(line).into_owned()));
        assert_eq!(out, whole);
        assert_eq!(out.len(), 200);
    }

    fn collect_elements(chunks: &[&[u8]]) -> (Vec<String>, usize) {
        let mut out = Vec::new();
        let mut e = Elements::new();
        for c in chunks {
            e.push(c, |el| out.push(String::from_utf8_lossy(el).into_owned()))
                .unwrap();
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
        assert_eq!(
            els,
            vec![r#"{"id":"a","card":{"n":{"deep":1}}}"#, r#"{"id":"b"}"#]
        );
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
        assert_eq!(
            els.len(),
            2,
            "the escaped quote must not desynchronise the framer"
        );
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
            e.push(c, |_| out += 1).unwrap();
        }
        assert_eq!(out, 2000, "every element must be framed");
        // The whole document is ~430 KB. A framer that fails to drain grows to hold all of
        // it - which is exactly how the spike's bug looked, and a row count alone cannot see it.
        assert!(
            e.peak_buffer() < 8 * 1024,
            "peak buffer was {} bytes; the framer is not draining",
            e.peak_buffer()
        );
    }

    /// The guard the peak-buffer assertion above can only *report* on.
    ///
    /// A document whose braces never close is what a desynchronised framer looks like from
    /// the inside, and the spike's failure was that it went on returning success. This drives
    /// one past [`MAX_ELEMENT_BYTES`] and insists the push **errors** rather than growing to
    /// hold the whole stream.
    #[test]
    fn an_element_that_never_closes_is_refused_rather_than_buffered_whole() {
        let chunk = {
            let mut v = Vec::with_capacity(1024 * 1024);
            v.extend_from_slice(br#"{"variants":[{"a":"#);
            v.resize(1024 * 1024, b'x');
            v
        };
        let mut e = Elements::new();
        let mut framed = 0usize;
        let mut err = None;
        // 16 MiB offered against an 8 MiB cap; it must give up long before the end.
        for _ in 0..16 {
            if let Err(o) = e.push(&chunk, |_| framed += 1) {
                err = Some(o);
                break;
            }
        }
        let o = err.expect("a framer that never completes an element must error");
        assert_eq!(o.unit, "element");
        assert_eq!(o.cap, MAX_ELEMENT_BYTES);
        assert_eq!(framed, 0, "nothing closed, so nothing may have been framed");
        // The check runs after the scan, so the peak may exceed the cap by at most the chunk
        // that crossed it — and by nothing like the 16 MiB the stream was willing to supply.
        assert!(
            e.peak_buffer() <= MAX_ELEMENT_BYTES + chunk.len(),
            "peak buffer was {}, cap {}",
            e.peak_buffer(),
            MAX_ELEMENT_BYTES
        );
    }

    /// The same failure one framer over: bytes with no newline in them are not JSONL, and a
    /// tags or cards ingest must not hold the whole download waiting for one.
    #[test]
    fn a_line_that_never_ends_is_refused_rather_than_buffered_whole() {
        let chunk = vec![b'x'; 1024 * 1024];
        let mut l = Lines::new();
        let mut framed = 0usize;
        let mut err = None;
        for _ in 0..16 {
            if let Err(o) = l.push(&chunk, |_| framed += 1) {
                err = Some(o);
                break;
            }
        }
        let o = err.expect("a stream with no newline must error rather than accumulate");
        assert_eq!(o.unit, "line");
        assert_eq!(o.cap, MAX_LINE_BYTES);
        assert_eq!(framed, 0);
    }

    /// The cap must not be reachable by a legitimate document. The combo feed's measured peak
    /// is 2.01 MB against 610.2 MB of JSON, so a stream that drains normally never approaches
    /// it however long it runs.
    #[test]
    fn a_draining_framer_never_approaches_the_cap() {
        let mut e = Elements::new();
        let mut framed = 0usize;
        e.push(br#"{"variants":["#, |_| framed += 1).unwrap();
        for i in 0..20_000 {
            let el = format!(r#"{{"id":"v{i}"}},"#);
            e.push(el.as_bytes(), |_| framed += 1).unwrap();
        }
        assert_eq!(framed, 20_000);
        assert!(
            e.peak_buffer() < MAX_ELEMENT_BYTES / 100,
            "peak buffer was {}",
            e.peak_buffer()
        );
    }

    /// **A key after the array is not a row**, and this went unnoticed until the price feed
    /// got a push reader: Card Kingdom's pricelist carries keys after `data`, and each one's
    /// object was framed at depth 0 exactly as an element is. It never produced a *price* —
    /// those objects carry no `scryfall_id` — so the only tell was `rows_seen` disagreeing
    /// between the pull reader and the push one.
    #[test]
    fn nothing_after_the_arrays_closing_bracket_is_framed() {
        let doc = br#"{"meta":{"created_at":"t"},"data":[{"id":1},{"id":2}],"trailing":{"after":"data"},"more":{"x":1}}"#;
        let (els, _) = collect_elements(&[doc]);
        assert_eq!(els, vec![r#"{"id":1}"#, r#"{"id":2}"#]);
    }

    /// …and the same when the closing bracket lands in a different chunk from the last
    /// element, which is the only way a browser stream ever delivers it.
    #[test]
    fn the_arrays_end_is_recognised_across_a_chunk_boundary() {
        let doc = br#"{"data":[{"id":1},{"id":2}],"trailing":{"after":"data"}}"#;
        let mut out = Vec::new();
        let mut e = Elements::new();
        for c in doc.chunks(3) {
            e.push(c, |el| out.push(String::from_utf8_lossy(el).into_owned()))
                .unwrap();
        }
        assert_eq!(out, vec![r#"{"id":1}"#, r#"{"id":2}"#]);
    }

    /// An empty array frames nothing and does not read as a truncated document.
    #[test]
    fn an_empty_array_frames_nothing() {
        let (els, _) = collect_elements(&[br#"{"data":[],"trailing":{"x":1}}"#]);
        assert!(els.is_empty(), "{els:?}");
    }

    /// An array *inside* an element must not be mistaken for the end of the outer one — its
    /// brackets are at depth 1 or more, which is what the guard tests.
    #[test]
    fn an_array_inside_an_element_does_not_end_the_framing() {
        let doc =
            br#"{"data":[{"id":1,"tags":["a","b"]},{"id":2,"n":{"deep":[1,2]}}],"t":{"x":1}}"#;
        let (els, _) = collect_elements(&[doc]);
        assert_eq!(
            els,
            vec![
                r#"{"id":1,"tags":["a","b"]}"#,
                r#"{"id":2,"n":{"deep":[1,2]}}"#
            ]
        );
    }

    /// A `]` inside a string is text, not the end of the array — card names and rules text
    /// really do contain brackets.
    #[test]
    fn a_bracket_inside_a_string_does_not_end_the_framing() {
        let doc = br#"{"data":[{"n":"a ] bracket"},{"n":"second"}]}"#;
        let (els, _) = collect_elements(&[doc]);
        assert_eq!(els.len(), 2, "{els:?}");
        assert_eq!(els[1], r#"{"n":"second"}"#);
    }

    /// The message has to name the framer that stalled — a caller sees it as an `Io` error on
    /// whichever feed was running, and "element" or "line" is what points at the cause.
    #[test]
    fn the_refusal_becomes_an_io_error_that_names_the_unit() {
        let o = Overlong {
            bytes: 9_000_000,
            cap: MAX_ELEMENT_BYTES,
            unit: "element",
        };
        let io = std::io::Error::from(o);
        assert_eq!(io.kind(), std::io::ErrorKind::InvalidData);
        assert!(io.to_string().contains("element"), "{io}");
        assert!(io.to_string().contains("9000000"), "{io}");
    }
}
