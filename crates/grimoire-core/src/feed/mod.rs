//! Reading a bulk feed a chunk at a time — and, in [`backoff`], when to stop asking for one.

pub mod backoff;
pub mod frame;

/// **The floor every bulk ingest holds before it swaps: a file more unusable than usable is a bad
/// download, not a smaller catalogue** (issue #551).
///
/// Each ingest already refused a file with *nothing* in it — `Empty`, in all four — but one good
/// row among a hundred thousand bad ones swapped: the card corpus down to a handful of printings,
/// with every collection row flagged for review and the mirror rewritten with blank names; a
/// taxonomy of one tag, held for a week behind its ETag; a price table of em dashes under a fresh
/// as-of line. Strictly greater, so a file that is exactly half usable still swaps.
///
/// Where the healthy files sit, from the measurements in `docs/`: 0 skipped of 116 568 card lines,
/// 0 of 4 521 oracle-tag and 11 531 art-tag lines, 1.4 % of the combo file's variants, 0.55 % of
/// Card Kingdom's rows for a missing id, and at most 16 % of Mana Pool's — so the nearest healthy
/// feed is three times inside the line and the others thirty-five.
pub fn mostly_unusable(kept: u64, skipped: u64) -> bool {
    skipped > kept
}

/// **How much work a streamed download does before it gives the host's event loop a turn.**
///
/// Every streamed loop — the card sync's, both tag files', the combos' and the price list's —
/// keeps a `platform::timer::Breather` on this budget and breathes once per chunk. On a host
/// with one thread that turn is the only moment a command can be answered while a body that
/// the network has already buffered is being ingested: without it the first measured run
/// answered a page's `sync_status` 3.5–8.4 s late through a 16.4 s card download
/// (`platform::timer::yield_to_host` has the mechanism).
///
/// **Fifty milliseconds**: a waiting command is taken within about one budget plus one chunk's
/// push, so around twenty times a second — past the point a reader can feel — and at twenty
/// turns a second a turn that costs a fraction of a millisecond adds well under a percent to
/// the ingest. Per chunk would be thousands of turns for nothing; a second would be a wall
/// that stutters. Chosen from those two bounds, and then measured in headless Chrome 154
/// (2026-10-04): a status call sent once a second through a 78 MB card download answered every
/// time, in 24–440 ms with a median of 185 ms, where before the budget it waited 3.5–8.4 s.
pub const WORK_BUDGET: std::time::Duration = std::time::Duration::from_millis(50);

/// **What a streamed download says of itself as it arrives**: how many bytes are in, out of
/// how many — and when it does not know the second number, that it does not.
///
/// A streamed download is a host with no files reading a body a chunk at a time — a browser.
/// There the response's `Content-Length` is the length *on the wire*, and a `fetch` hands
/// over a `Content-Encoding: gzip` body already decompressed: Commander Spellbook declares
/// 28.8 MB and delivers 639 MB. Counting the one against the other filled the bar in the
/// first twentieth of the download and then reported `done / done` on **every chunk** — a
/// bar pinned at 100 % and an event per chunk, thousands of them, for the rest of it.
///
/// So the declared length is a denominator **only for a body that arrived still gzipped**,
/// which is the one case where what was received is what the wire carried; the first two
/// bytes say (`frame::Decoder::is_gzip`). For anything else the total is `0`, which every
/// reader of these events draws as a bar with no fraction. And a report is due on the byte
/// step, or once when a known total is reached — never per chunk.
pub(crate) struct StreamedProgress {
    declared: u64,
    step: u64,
    /// The byte count last reported. `0` is the opening event, which the caller sends.
    said: u64,
}

impl StreamedProgress {
    /// `declared` is the response's `Content-Length`, `0` where it declared none; `step` is
    /// how many bytes pass between two reports.
    pub(crate) fn new(declared: u64, step: u64) -> StreamedProgress {
        StreamedProgress {
            declared,
            step,
            said: 0,
        }
    }

    fn total(&self, still_gzipped: Option<bool>) -> u64 {
        match still_gzipped {
            Some(true) => self.declared,
            _ => 0,
        }
    }

    /// `(done, total)` to report now that `done` bytes are in, or `None` to say nothing yet.
    pub(crate) fn after(&mut self, done: u64, still_gzipped: Option<bool>) -> Option<(u64, u64)> {
        let total = self.total(still_gzipped);
        let stepped = done.saturating_sub(self.said) >= self.step;
        let reached = total > 0 && done >= total && done != self.said;
        if !stepped && !reached {
            return None;
        }
        self.said = done;
        // A body that ran past what it declared has no denominator worth the name either.
        Some((done, if done > total { 0 } else { total }))
    }

    /// The last word, once the body has ended: the final count, unless it was already said.
    pub(crate) fn at_end(&mut self, done: u64, still_gzipped: Option<bool>) -> Option<(u64, u64)> {
        if done == self.said {
            return None;
        }
        self.said = done;
        let total = self.total(still_gzipped);
        Some((done, if done > total { 0 } else { total }))
    }
}

/// **A host that answers and then goes quiet**, for the tests of a stall bound.
///
/// `httpmock` can delay a whole response, which is a host that never *begins* to answer. What
/// it cannot do is stop partway through a body — and that is the failure a streamed download
/// has to survive, because in a browser nothing else ends it. This is that host: a listener
/// on a port of its own that answers every request `200`, declares `declared` bytes, sends
/// `sent`, and then holds the connection open and says nothing more.
///
/// Its threads outlive the test that started it by design; the test binary's exit takes them.
#[cfg(test)]
pub(crate) mod quiet_host {
    use std::io::{Read as _, Write as _};

    /// Start one, and answer its base URL.
    pub(crate) fn start(sent: Vec<u8>, declared: usize) -> String {
        serve(sent, declared, None)
    }

    /// **A host that is only late**: it sends `first`, says nothing for `pause`, and then
    /// sends `rest`, which is the end of the body it declared. For the test that a chunk
    /// arriving a little after the stall bound is not a stall.
    pub(crate) fn start_pausing(
        first: Vec<u8>,
        pause: std::time::Duration,
        rest: Vec<u8>,
    ) -> String {
        let declared = first.len() + rest.len();
        serve(first, declared, Some((pause, rest)))
    }

    fn serve(
        sent: Vec<u8>,
        declared: usize,
        then: Option<(std::time::Duration, Vec<u8>)>,
    ) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a free port");
        let addr = listener.local_addr().expect("its address");
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let sent = sent.clone();
                let then = then.clone();
                std::thread::spawn(move || {
                    // Each write on the wire as it is made, not held back for the next one.
                    let _ = stream.set_nodelay(true);
                    // The request's head; nothing in it matters here.
                    let mut head = [0u8; 4096];
                    let _ = stream.read(&mut head);
                    let answer = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\n\
                         content-length: {declared}\r\n\r\n"
                    );
                    let _ = stream.write_all(answer.as_bytes());
                    let _ = stream.write_all(&sent);
                    let _ = stream.flush();
                    match then {
                        Some((pause, rest)) => {
                            std::thread::sleep(pause);
                            let _ = stream.write_all(&rest);
                            let _ = stream.flush();
                            // Long enough for the client to have read it to the end.
                            std::thread::sleep(std::time::Duration::from_secs(5));
                        }
                        // And then nothing, with the connection held open.
                        None => std::thread::sleep(std::time::Duration::from_secs(60)),
                    }
                });
            }
        });
        format!("http://{addr}")
    }
}

#[cfg(test)]
mod tests {
    /// **A body the host decompressed has no denominator, and is reported on the byte step —
    /// never per chunk.** Spellbook's figures: 28.8 MB declared, 639 MB delivered, in 64 KB
    /// chunks. And a body that arrived still gzipped is counted against what it declared,
    /// ending on exactly that.
    #[test]
    fn a_streamed_download_reports_on_the_byte_step_and_only_a_gzipped_body_has_a_total() {
        const MB: u64 = 1_000_000;
        let chunk = 64 * 1024;

        let mut decoded = super::StreamedProgress::new(28_832_784, MB);
        let mut said: Vec<(u64, u64)> = Vec::new();
        let mut done = 0;
        while done < 639_585_506 {
            done += chunk;
            said.extend(decoded.after(done, Some(false)));
        }
        said.extend(decoded.at_end(done, Some(false)));
        assert!(
            said.iter().all(|(_, total)| *total == 0),
            "a decoded body never names the wire's length as its own"
        );
        assert!(
            said.len() <= (done / MB) as usize + 1,
            "{} reports for {} MB: one per step, not one per chunk",
            said.len(),
            done / MB
        );
        assert!(
            said.len() > 500,
            "and it does go on reporting: {}",
            said.len()
        );
        assert_eq!(said.last(), Some(&(done, 0)));
        assert!(
            said.windows(2)
                .all(|w| w[1].0 - w[0].0 >= MB || w[1].0 == done),
            "no two reports closer than the step, but for the last"
        );

        let mut gzipped = super::StreamedProgress::new(3 * MB + 5, MB);
        let mut said: Vec<(u64, u64)> = Vec::new();
        for done in [400_000, MB, 2 * MB + 1, 3 * MB, 3 * MB + 5] {
            said.extend(gzipped.after(done, Some(true)));
        }
        assert_eq!(
            said,
            [
                (MB, 3 * MB + 5),
                (2 * MB + 1, 3 * MB + 5),
                (3 * MB + 5, 3 * MB + 5)
            ],
            "the step, and once more at the end it declared"
        );
        assert_eq!(gzipped.at_end(3 * MB + 5, Some(true)), None, "said already");

        // Undecided — fewer than two bytes in — is not a body anyone can vouch for yet, and a
        // small plain one says its size once, at the end, with no total.
        let mut small = super::StreamedProgress::new(300, MB);
        assert_eq!(small.after(1, None), None);
        assert_eq!(small.after(300, Some(false)), None);
        assert_eq!(small.at_end(300, Some(false)), Some((300, 0)));
    }

    #[test]
    fn a_file_more_unusable_than_usable_is_refused_and_one_exactly_half_is_not() {
        assert!(!super::mostly_unusable(116_568, 0));
        assert!(
            !super::mostly_unusable(84, 16),
            "Mana Pool at its measured worst"
        );
        assert!(!super::mostly_unusable(2, 2), "exactly half still swaps");
        assert!(super::mostly_unusable(2, 3));
        assert!(super::mostly_unusable(1, 199_999));
    }
}
