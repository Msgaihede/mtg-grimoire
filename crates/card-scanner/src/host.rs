//! The one place this crate knows what kind of machine it is on: whether there is a clock to
//! read, and a panic that can be caught.
//!
//! **A browser's Worker has neither.** `Instant::now()` **panics** on `wasm32-unknown-unknown` —
//! at run time, in a build that compiled without a warning — and the web module is built with
//! `panic = "abort"`, where a panic is a trap and nothing unwinds. So the rest of the crate asks
//! here, and this file answers for the host it finds itself on:
//!
//! | | A native host (the desktop, Android) | A Worker |
//! | --- | --- | --- |
//! | [`Stopwatch`] | an installed clock, else `Instant` | an installed clock, else **zero** |
//! | [`guard`] | `catch_unwind` | nothing: see below |
//!
//! **The scanner runs on the thread that hands it a frame**, on every host: nothing in this crate
//! spawns, and a Worker is one thread.
//!
//! **⚠️ [`guard`] guards nothing where a panic aborts.** With `panic = "abort"` there is no
//! unwinding for `catch_unwind` to stop, so the closure's panic is the end of the instance: in a
//! browser a `RuntimeError: unreachable` thrown out of whichever export was running, with the
//! module's memory left as it was at that instruction. **Containing that is the host's**, and
//! the only containment there is: throw the instance away and make another.
//!
//! **Only this file names a thread, a clock, an unwind or a target.** `tests::the_fence` reads
//! every other source file's shipped code, at any depth under `src/`, and refuses one that
//! does — or that waits as only a host with a second thread can: a channel's blocking
//! `.recv()`, a `Condvar`, a `Barrier`. `src/bin/` is outside it (the tools are a desktop's),
//! and so is a `#[cfg(test)]` module at the foot of a file.

use std::sync::OnceLock;

/// Whether this target has a clock of its own to read.
///
/// `target_family = "wasm"` and not the one triple the web module is built for: a WASI build
/// has a clock, but a zero in a timing is the cheap way to be wrong.
const NATIVE: bool = cfg!(not(target_family = "wasm"));

// ---- The panic guard --------------------------------------------------------------------------

/// What [`guard`] answers: the body's value, or the panic it ended in.
pub type Caught<T> = Result<T, Box<dyn std::any::Any + Send + 'static>>;

/// Run `body`, and answer a panic inside it as a value instead of unwinding through the caller.
///
/// `AssertUnwindSafe`, because the caller throws away what the body was working on: a frame's
/// verdict.
///
/// **On a host where a panic aborts this is `Ok(body())` and nothing else** — see the module
/// doc. It is still called there, so the code that reads its answer is the same on every host.
pub fn guard<T>(body: impl FnOnce() -> T) -> Caught<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(body))
}

// ---- The clock --------------------------------------------------------------------------------

/// The host's clock, when it has said it has one: milliseconds on something monotonic, from
/// any origin.
static CLOCK: OnceLock<fn() -> f64> = OnceLock::new();

/// Hand the crate a clock: `now_ms` answers milliseconds, monotonic, from whatever origin the
/// host likes — `performance.now()` is one. Once per process; a second word is ignored.
///
/// **Telemetry, with one exception.** Every reading ends in an `_ms` field of a verdict — which
/// is why a host that installs none still scans, with its timings at zero. **The exception is
/// the agreement** (`src/neural_mode.rs`), whose votes age by a [`Stopwatch`] started when its
/// models load: two accepted frames further apart than its gap do not agree. On a host with no
/// clock every frame is at zero, so no vote ages and no gap is too long — a frame with no card
/// still resets the count, which is most of what the ages are for. The replay installs the
/// label's own frame times through this, so its Neural votes age as the reader's frames did.
pub fn set_clock(now_ms: fn() -> f64) {
    let _ = CLOCK.set(now_ms);
}

/// A moment to measure a stage from. **An installed clock wins; otherwise `Instant` where the
/// target has one; otherwise every reading is zero** — and none of the three can panic.
#[derive(Debug, Clone, Copy)]
pub struct Stopwatch(Started);

#[derive(Debug, Clone, Copy)]
enum Started {
    /// A reading of the host's clock, kept with the clock that gave it.
    Host(f64, fn() -> f64),
    Own(std::time::Instant),
    /// No clock at all.
    Never,
}

impl Stopwatch {
    pub fn start() -> Stopwatch {
        Stopwatch::on(CLOCK.get().copied(), NATIVE)
    }

    /// [`Stopwatch::start`], told which clocks there are — the seam its tests come in by.
    fn on(host: Option<fn() -> f64>, own: bool) -> Stopwatch {
        Stopwatch(match host {
            Some(now) => Started::Host(now(), now),
            None if own => Started::Own(std::time::Instant::now()),
            None => Started::Never,
        })
    }

    /// Milliseconds since [`Stopwatch::start`]. Never negative and never not a number, whatever
    /// the host's clock answered.
    pub fn ms(&self) -> f32 {
        match self.0 {
            Started::Host(at, now) => {
                let span = now() - at;
                if span.is_finite() && span > 0.0 {
                    span as f32
                } else {
                    0.0
                }
            }
            Started::Own(at) => at.elapsed().as_secs_f32() * 1000.0,
            Started::Never => 0.0,
        }
    }
}

#[cfg(test)]#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn the_guard_answers_a_panic_as_a_value() {
        assert!(guard(|| panic!("a frame panicked")).is_err());
        assert_eq!(guard(|| 5).ok(), Some(5));
    }

    thread_local! {
        /// A clock a test moves by hand, on its own thread.
        static FAKE_MS: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
    }

    fn fake_now() -> f64 {
        FAKE_MS.with(|ms| ms.get())
    }

    #[test]
    fn a_stopwatch_reads_the_hosts_clock_before_its_own_and_zero_with_neither() {
        // A host's clock, from an origin of its own.
        FAKE_MS.with(|ms| ms.set(5_000.0));
        let hosted = Stopwatch::on(Some(fake_now), true);
        assert_eq!(hosted.ms(), 0.0);
        FAKE_MS.with(|ms| ms.set(5_012.5));
        assert_eq!(hosted.ms(), 12.5, "the installed clock did not win over `Instant`");
        // A clock that ran backwards, or answered nonsense, is no time at all.
        FAKE_MS.with(|ms| ms.set(4_000.0));
        assert_eq!(hosted.ms(), 0.0);
        FAKE_MS.with(|ms| ms.set(f64::NAN));
        assert_eq!(hosted.ms(), 0.0);

        // The target's own. **Half the sleep, and only ever a lower bound**: a loaded machine
        // can make a sleep as long as it likes, and Windows has been seen to end one a fraction
        // of a tick early by the clock `Instant` reads — neither is this test's business.
        let own = Stopwatch::on(None, true);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let first = own.ms();
        assert!(first >= 10.0, "a 20 ms sleep measured as {first}");
        assert!(own.ms() >= first);

        // Neither — a Worker nobody handed a clock. Zero, and above all no panic.
        let none = Stopwatch::on(None, false);
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert_eq!(none.ms(), 0.0);
    }

    /// A real clock, counted — so installing it for the whole test binary changes no other
    /// test's timings, and this one can still tell it was asked.
    static ASKED: AtomicUsize = AtomicUsize::new(0);

    fn counted_now() -> f64 {
        static ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();
        ASKED.fetch_add(1, Ordering::Relaxed);
        ORIGIN.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
    }

    #[test]
    fn an_installed_clock_is_the_one_every_stopwatch_reads() {
        set_clock(counted_now);
        // The second word is ignored: a clock swapped under a running stopwatch would measure
        // from one origin to another.
        set_clock(fake_now);
        let before = ASKED.load(Ordering::Relaxed);
        let watch = Stopwatch::start();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let waited = watch.ms();
        assert!(waited >= 10.0, "a 20 ms sleep measured as {waited}");
        assert!(ASKED.load(Ordering::Relaxed) >= before + 2, "start and ms each ask the host");
    }

    // ---- The fence ----------------------------------------------------------------------------

    /// What only this file may spell, on a code line of any other, as whole words. The last
    /// two are not a thread or a clock but what one waits on: a `Condvar` and a `Barrier` are
    /// each a wait for another thread, which on a host with one is a wait for ever.
    const WORDS: [&str; 7] = [
        "Instant",
        "SystemTime",
        "UNIX_EPOCH",
        "catch_unwind",
        "resume_unwind",
        "Condvar",
        "Barrier",
    ];
    /// And as written: `thread::` is the module however it was imported (`thread_local!` is not
    /// it, and is fine — a Worker has thread-locals). `.recv()` is a channel's blocking read —
    /// the same wait for ever; `try_recv`, which the session polls with, is another word.
    const SPELLINGS: [&str; 3] = ["std::thread", "thread::", ".recv()"];
    /// The three spellings of a conditional-compilation gate. One that names a target —
    /// `target_…`, or the bare `windows`, `unix` and `wasm` — is refused.
    const GATES: [&str; 3] = ["cfg(", "cfg!(", "cfg_attr("];
    const BARE_TARGETS: [&str; 3] = ["windows", "unix", "wasm"];

    fn has_word(line: &str, word: &str) -> bool {
        let is_word = |c: char| c.is_alphanumeric() || c == '_';
        line.match_indices(word).any(|(at, _)| {
            !line[..at].chars().next_back().is_some_and(is_word)
                && !line[at + word.len()..].chars().next().is_some_and(is_word)
        })
    }

    /// The word or spelling one code line names, if it names one.
    fn names(line: &str) -> Option<String> {
        if let Some(word) = WORDS.iter().find(|w| has_word(line, w)) {
            return Some(format!("`{word}`"));
        }
        SPELLINGS.iter().find(|s| line.contains(**s)).map(|s| format!("`{s}`"))
    }

    /// Whether `text` — a gate, whole — is a `cfg` that names a target.
    fn gates_a_target(text: &str) -> bool {
        GATES.iter().any(|g| text.contains(g))
            && (text.contains("target_") || BARE_TARGETS.iter().any(|t| has_word(text, t)))
    }

    /// The code line at `at`, **with the lines after it joined on while a gate it opens is
    /// still open**: rustfmt breaks a long `#[cfg(any(…))]` one key a line, and read a line at
    /// a time the line that says `cfg(` names no target and the line that names one says no
    /// `cfg(`. Parentheses are counted over the whole line, so a gate sharing a line with an
    /// open call joins too much — the cheap direction.
    fn statement(code: &[(usize, &str)], at: usize) -> String {
        let open = |text: &str| text.matches('(').count() > text.matches(')').count();
        let mut text = code[at].1.to_string();
        let mut next = at + 1;
        while GATES.iter().any(|g| text.contains(g)) && open(&text) && next < code.len() {
            text.push(' ');
            text.push_str(code[next].1.trim());
            next += 1;
        }
        text
    }

    /// What one code line breaks, if anything — the line itself for a word, the whole gate for
    /// a target.
    fn broken(code: &[(usize, &str)], at: usize) -> Option<String> {
        names(code[at].1).or_else(|| {
            gates_a_target(&statement(code, at)).then(|| "a `cfg` that names a target".to_string())
        })
    }

    /// A file as the sweep reads it.
    struct Shipped<'a> {
        /// Its shipped code: the lines above the cut, numbered, without the comment lines.
        code: Vec<(usize, &'a str)>,
        /// The first line of code **below** the module the cut was made at, if there is any.
        below: Option<(usize, &'a str)>,
    }

    /// A file's shipped code: its lines up to the first column-0 `#[cfg(test)]` **that gates a
    /// module**, without the lines that are comments. A file may gate a `thread_local!` or a
    /// helper far above its tests; cutting at the first gate would leave everything below
    /// them unread, so a single gated item is read as shipped — refusing too much is the cheap
    /// direction.
    ///
    /// **The cut module has to be the last thing in the file**, and `below` is how the sweep
    /// holds a file to it: a `#[cfg(test)] mod helpers { … }` half-way down would otherwise hide
    /// every shipped line under it. The module ends at its own `;` or at the first column-0
    /// `}` after it — every file here closes its test module there.
    fn shipped(source: &str) -> Shipped<'_> {
        let lines: Vec<&str> = source.lines().collect();
        let is_code = |l: &&str| !l.trim().is_empty() && !l.trim_start().starts_with("//");
        // The item a gate at `i` is on: the next line that is neither blank nor an attribute.
        let gated = |i: usize| {
            let item = |l: &&str| !l.trim().is_empty() && !l.starts_with("#[");
            lines[i + 1..].iter().position(item).map(|n| i + 1 + n)
        };
        let cut = (0..lines.len()).find_map(|i| {
            let module = gated(i).filter(|_| lines[i] == "#[cfg(test)]")?;
            let named = lines[module];
            (named.starts_with("mod ") || named.starts_with("pub mod ")).then_some((i, module))
        });
        let (end, below) = match cut {
            None => (lines.len(), None),
            Some((gate, module)) => {
                let close = if lines[module].trim_end().ends_with(';') {
                    Some(module)
                } else {
                    (module..lines.len()).find(|&i| lines[i] == "}")
                };
                let below = close
                    .and_then(|close| (close + 1..lines.len()).find(|&i| is_code(&lines[i])))
                    .map(|i| (i + 1, lines[i]));
                (gate, below)
            }
        };
        let code = lines[..end]
            .iter()
            .enumerate()
            .filter(|(_, l)| !l.trim_start().starts_with("//"))
            .map(|(i, l)| (i + 1, *l))
            .collect();
        Shipped { code, below }
    }

    /// Every `.rs` file under `dir`, **at any depth** — a module that grows into a folder is
    /// still the library — but for the two the fence is not about: this file, and `src/bin/`,
    /// the tools, which a browser never runs.
    fn sources(dir: &std::path::Path, top: bool, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("a source directory") {
            let path = entry.expect("an entry").path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if path.is_dir() {
                if !(top && name == "bin") {
                    sources(&path, false, out);
                }
            } else if path.extension().is_some_and(|e| e == "rs") && !(top && name == "host.rs") {
                out.push(path);
            }
        }
    }

    /// **Nothing in this crate's shipped library names a thread, a clock, an unwind or a target
    /// outside this file** — or waits the way only a host with a second thread can afford to.
    /// Each compiles on a desktop wherever it is written, and each is a trap or a hang in a
    /// Worker at run time — which is exactly why a compiler cannot be the fence.
    #[test]
    fn the_fence() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        sources(&root.join("src"), true, &mut files);
        files.sort();
        let mut found = Vec::new();
        for path in &files {
            let name = path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/");
            let source = std::fs::read_to_string(path).expect("a source file");
            let read = shipped(&source);
            for at in 0..read.code.len() {
                if let Some(what) = broken(&read.code, at) {
                    let (n, line) = read.code[at];
                    found.push(format!("{name}:{n} names {what}: {}", line.trim()));
                }
            }
            if let Some((n, line)) = read.below {
                found.push(format!(
                    "{name}:{n} is code below a `#[cfg(test)]` module, where this sweep stops \
                     reading — move the module to the foot of the file: {}",
                    line.trim()
                ));
            }
        }
        // A sweep that read nothing passes everything.
        let read = files.len();
        assert!(read >= 7, "the fence read {read} files — `src/` has moved, or the walk broke");
        assert!(
            found.is_empty(),
            "only `host.rs` may know the machine it is on — ask it instead:\n{}",
            found.join("\n")
        );
    }

    /// The sweep refuses what it is for and lets through what it must — a fence that could not
    /// go red would look exactly like one that had nothing to find.
    #[test]
    fn the_fence_refuses_each_spelling_and_reads_past_a_gated_item() {
        let refused = |line: &str| broken(&[(1, line)], 0);
        for line in [
            "let t = std::time::Instant::now();",
            "use std::time::{Duration, Instant};",
            "let at = SystemTime::now();",
            "std::thread::scope(|s| {",
            "thread::spawn(job);",
            "match std::panic::catch_unwind(|| body()) {",
            "h.join().unwrap_or_else(|e| std::panic::resume_unwind(e))",
            "#[cfg(target_family = \"wasm\")]",
            "if cfg!(target_arch = \"wasm32\") {",
            "#[cfg_attr(not(windows), allow(dead_code))]",
            "#[cfg(unix)]",
            "let answer = rx.recv().ok();",
            "let ready = (Mutex::new(false), Condvar::new());",
            "let gate = std::sync::Barrier::new(2);",
        ] {
            assert!(refused(line).is_some(), "let through: {line}");
        }
        for line in [
            "thread_local! {",
            "let instants = slice.windows(2);",
            "#[cfg(feature = \"corpus\")]",
            "#[cfg_attr(not(feature = \"corpus\"), allow(dead_code))]",
            "let watch = crate::host::Stopwatch::start();",
            "pub struct InstantReplay;",
            "let result = match rx.try_recv() {",
            "let met = waits.recv_timeout(WAIT).is_ok();",
            "struct BarrierIsland;",
        ] {
            assert_eq!(refused(line), None, "refused: {line}");
        }

        // A gate rustfmt broke across lines is one gate: refused where it opens, and the lines
        // it runs over are not a second finding each.
        let split = [
            (1, "#[cfg(any("),
            (2, "    target_os = \"windows\","),
            (3, "    feature = \"corpus\","),
            (4, "))]"),
            (5, "fn gated() {}"),
        ];
        let hits: Vec<usize> =
            (0..split.len()).filter(|&at| broken(&split, at).is_some()).collect();
        assert_eq!(hits, [0], "a gate over four lines");
        let features =
            [(1, "#[cfg(any("), (2, "    feature = \"corpus\","), (3, "))]"), (4, "#[cfg(unix)]")];
        assert_eq!(broken(&features, 0), None, "a split gate ran on into the next one");

        // A gated item above the tests is read as shipped; the cut is the module's gate.
        let file = "fn a() {}\n// Instant::now() is why\n#[cfg(test)]\nthread_local! {}\n\
                    fn b() {}\n#[cfg(test)]\nmod tests {\n    use std::time::Instant;\n}\n\n\
                    // The foot of the file.\n";
        let read = shipped(file);
        let lines: Vec<&str> = read.code.iter().map(|(_, l)| *l).collect();
        assert_eq!(lines, ["fn a() {}", "#[cfg(test)]", "thread_local! {}", "fn b() {}"]);
        assert_eq!(read.below, None, "a comment under the tests is not code");

        // A test module that is not the last thing in the file hides what is under it.
        let hidden = "fn a() {}\n#[cfg(test)]\nmod helpers {\n    fn h() {}\n}\n\n\
                      fn unread() -> std::time::Instant {\n    todo!()\n}\n";
        assert_eq!(shipped(hidden).below, Some((7, "fn unread() -> std::time::Instant {")));
        let declared = "fn a() {}\n#[cfg(test)]\nmod fixtures;\nfn unread() {}\n";
        assert_eq!(shipped(declared).below, Some((4, "fn unread() {}")));
    }
}
