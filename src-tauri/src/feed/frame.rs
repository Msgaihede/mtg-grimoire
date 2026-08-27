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
    }
}

impl Default for Elements {
    fn default() -> Self {
        Self::new()
    }
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
            });
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
            });
        }
        l.finish(|line| out.push(String::from_utf8_lossy(line).into_owned()));
        assert_eq!(out, whole);
        assert_eq!(out.len(), 200);
    }

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
            e.push(c, |_| out += 1);
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
}
