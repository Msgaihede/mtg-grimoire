//! The sweep that holds this crate to its own rules, by reading its source.
//!
//! Three of the crate's four rules are things no compiler on a desktop can see: a `cfg` for
//! another target compiles to nothing here, `SystemTime::now()` works here, and a `tauri`
//! dependency builds here. CI's `core` job catches what fails to *compile* for the other two
//! targets; this catches what compiles everywhere and is wrong anyway — a platform gate at a
//! call site, a clock read that panics in a browser at run time.
//!
//! **A fifth rule arrived with the I/O step, and it is the same kind**: `reqwest`, `tokio`,
//! `std::fs` and `std::thread` all compile on a desktop wherever they are written, and each is
//! something a browser has no equivalent of or a different one. They are named under this
//! directory and nowhere else in what a build ships.
//!
//! **It reads code lines and skips comment lines**, where `mobile/phone/fence.test.ts` reads
//! both: prose here has to be able to say why a rule exists, and the module docs name
//! `SystemTime::now()` to do it. A line is a comment when it *starts* with `//`. So a trailing
//! comment on a code line is read as code and a `/* … */` block is read as code — both wrong
//! only in the direction of refusing too much.
//!
//! **Test code is swept too, for the target and the clock.** A test never compiles for the
//! browser, so a clock read in one would be harmless; it is refused all the same, because the
//! line between a test helper and the code beside it is one `#[cfg(test)]` that this sweep
//! would have to parse to trust.
//!
//! **The fifth rule reads shipped code only, and that is a decision rather than a gap.** A test
//! of a download has to put a file on a disk and read it back, a test of a lock has to start a
//! thread, and `#[tokio::test]` is how an async test runs at all — none of which a browser will
//! ever be asked to do. So that sweep stops at a file's first column-0 `#[cfg(test)]`, the cut
//! `scripts/coverage-rust.mjs` already makes, and skips a file its parent declares behind a
//! test gate. What it costs is the thing the paragraph above refuses to trust: code below that
//! line which is *not* test code is not read. Every file here keeps its tests and its fixtures
//! at the foot, and nothing else below them.
//!
//! **It is a text sweep, and what it cannot see is written down rather than hoped away.** A
//! clock reached through a re-export or another crate's `now()`, a gate hidden inside a macro
//! this crate does not define, and a host that arrives as somebody else's dependency all pass.
//! The first two fail the `core` job or a browser, loudly; the third is what `cargo tree -p
//! grimoire-core -i tauri` answers and nothing here does.
//!
//! This file is under `platform/`, which is the directory the sweep leaves out — that is the
//! only reason it can spell the things it looks for.
//!
//! **Everything below is one `#[cfg(test)]` module, at column 0**, rather than the file being
//! gated where `platform/mod.rs` declares it: `scripts/coverage-rust.mjs` splits each file at
//! that attribute to keep test code out of the shipped-code figure, and gated from outside this
//! whole file would have counted as shipped.

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    const SRC: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
    const MANIFEST: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");

    /// Where else cargo compiles Rust for this package. None exists today; the day one does it
    /// is swept like `src/`, rather than being a place the rules quietly do not reach.
    const OTHER_ROOTS: [&str; 4] = ["build.rs", "tests", "benches", "examples"];

    /// The directory, relative to the package, that may know which machine it is on.
    const PLATFORM: &str = "src/platform/";

    /// The `cfg` keys that name a target. Refused wherever they appear on a code line, gate or
    /// not — so an identifier that merely contains one is refused too, and is renamed.
    const TARGET_KEYS: [&str; 11] = [
        "target_os",
        "target_family",
        "target_arch",
        "target_env",
        "target_vendor",
        "target_abi",
        "target_pointer_width",
        "target_endian",
        "target_has_atomic",
        "target_feature",
        "target_thread_local",
    ];

    /// The three spellings of a conditional-compilation gate.
    const GATES: [&str; 3] = ["cfg(", "cfg!(", "cfg_attr("];

    /// The two bare words that are a target gate on their own. Only looked for inside a gate —
    /// `slice.windows(2)` is not a platform check — and as whole words, so `unixepoch()` beside
    /// a `cfg!` is not one either.
    const BARE_TARGETS: [&str; 2] = ["windows", "unix"];

    /// What reads a clock that panics on `wasm32-unknown-unknown`, as whole words. `SystemTime`
    /// and `UNIX_EPOCH` are refused outright rather than only `::now`: `UNIX_EPOCH.elapsed()`
    /// is the same read without the word, and an alias (`use … SystemTime as T`) has to name
    /// the type once.
    const CLOCK_WORDS: [&str; 2] = ["SystemTime", "UNIX_EPOCH"];

    /// `Instant` cannot be refused as a word — it is a card type, and `cardtypes` spells it —
    /// so its two code spellings are: the call, and the import an alias would need.
    const CLOCK_PATHS: [&str; 2] = ["Instant::now", "time::Instant"];

    /// The two crates that are a host's network and its async runtime, as whole words.
    const IO_CRATES: [&str; 2] = ["reqwest", "tokio"];

    /// The two modules of `std` that are a disk and another thread.
    const IO_MODULES: [&str; 2] = ["fs", "thread"];

    /// The two spellings of a gate that makes the `mod` below it test code.
    const TEST_GATES: [&str; 2] = ["#[cfg(test)]", "#[cfg(any(test, feature = \"testing\"))]"];

    fn is_word_char(c: char) -> bool {
        c.is_alphanumeric() || c == '_'
    }

    /// Whether `word` appears in `line` with no identifier character on either side of it.
    fn has_word(line: &str, word: &str) -> bool {
        line.match_indices(word).any(|(at, _)| {
            let before = line[..at].chars().next_back();
            let after = line[at + word.len()..].chars().next();
            !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char)
        })
    }

    fn is_comment(line: &str) -> bool {
        line.trim_start().starts_with("//")
    }

    /// What one code line holds that it may not, if anything. `gated` is whether the line is
    /// inside a `cfg` — on it, or on a later line of one the formatter broke.
    fn offence(line: &str, gated: bool) -> Option<&'static str> {
        if TARGET_KEYS.iter().any(|key| line.contains(key)) {
            return Some("names a target; ask `platform` instead");
        }
        if gated && line.contains("target_") {
            return Some("names a target; ask `platform` instead");
        }
        if gated && BARE_TARGETS.iter().any(|word| has_word(line, word)) {
            return Some("gates on a platform; ask `platform` instead");
        }
        if CLOCK_WORDS.iter().any(|word| has_word(line, word))
            || CLOCK_PATHS.iter().any(|path| line.contains(path))
        {
            return Some("reads a clock that panics in a browser; call `platform::clock`");
        }
        None
    }

    /// Every offending line in one file, as `path:line: what`.
    ///
    /// A gate is followed across lines by counting its parentheses, because rustfmt breaks a
    /// long `cfg(all(…))` one predicate to a line and a bare `windows` then sits on a line with
    /// no `cfg` on it.
    fn offences(rel: &str, text: &str) -> Vec<String> {
        let mut found = Vec::new();
        let mut open = 0i32;
        for (i, line) in text.lines().enumerate() {
            if is_comment(line) {
                continue;
            }
            let continued = open > 0;
            let gate_at = GATES.iter().filter_map(|gate| line.find(gate)).min();
            if let Some(what) = offence(line, continued || gate_at.is_some()) {
                found.push(format!("{rel}:{}: {what}", i + 1));
            }
            let counted = if continued {
                line
            } else {
                gate_at.map_or("", |at| &line[at..])
            };
            let opens = counted.matches('(').count() as i32;
            let closes = counted.matches(')').count() as i32;
            open = (open + opens - closes).max(0);
        }
        found
    }

    /// What one shipped code line names that only `platform` may, if anything.
    ///
    /// `std::fs` and `std::thread` are matched as paths, so `std::thread_local!` is not one —
    /// and in a grouped `use std::{…}` as bare words, on that line only. A grouped import the
    /// formatter broke across lines passes; so does an alias (`use std as s`). Both then have
    /// to *call* something, and the call is what a reviewer reads.
    fn io_offence(line: &str) -> Option<&'static str> {
        if IO_CRATES.iter().any(|name| has_word(line, name)) {
            return Some(
                "names the HTTP client or the async runtime; ask `platform::http`, `timer` or `files`",
            );
        }
        let import = line.trim_start().trim_start_matches("pub ");
        let grouped = import.starts_with("use std::{");
        let named = |module: &&str| {
            has_word(line, &format!("std::{module}")) || (grouped && has_word(line, module))
        };
        if IO_MODULES.iter().any(named) {
            return Some("reaches a disk or a thread; ask `platform::files` or `platform::pause`");
        }
        None
    }

    /// Every such line in what one file ships: above its first column-0 `#[cfg(test)]`.
    fn io_offences(rel: &str, text: &str) -> Vec<String> {
        text.lines()
            .enumerate()
            .take_while(|(_, line)| !line.starts_with("#[cfg(test)]"))
            .filter(|(_, line)| !is_comment(line))
            .filter_map(|(i, line)| Some(format!("{rel}:{}: {}", i + 1, io_offence(line)?)))
            .collect()
    }

    /// The files that are test code from their first line: a module its parent declares
    /// directly under a test gate — `#[cfg(test)] mod tests;`, and `scratch`, which `lib.rs`
    /// gates on the `testing` feature. As paths relative to the package.
    fn test_only(files: &[(String, String)]) -> Vec<String> {
        let mut found = Vec::new();
        for (rel, text) in files {
            // Where this file's child modules live: beside `lib.rs` and `mod.rs`, and in a
            // directory named for the file otherwise.
            let dir = match rel.rsplit_once('/') {
                Some((dir, "lib.rs" | "mod.rs")) => dir.to_owned(),
                _ => rel.trim_end_matches(".rs").to_owned(),
            };
            let lines: Vec<&str> = text.lines().map(str::trim).collect();
            for pair in lines.windows(2) {
                if !TEST_GATES.contains(&pair[0]) {
                    continue;
                }
                let declared = pair[1].trim_start_matches("pub ");
                let Some(name) = declared
                    .strip_prefix("mod ")
                    .and_then(|rest| rest.strip_suffix(';'))
                else {
                    continue;
                };
                for child in [format!("{dir}/{name}.rs"), format!("{dir}/{name}/mod.rs")] {
                    if files.iter().any(|(other, _)| *other == child) {
                        found.push(child);
                    }
                }
            }
        }
        found
    }

    /// Every `.rs` file cargo compiles for this package: `src/`, and [`OTHER_ROOTS`].
    fn all_sources() -> Vec<(String, String)> {
        let mut files = Vec::new();
        sources(Path::new(SRC), &mut files);
        for other in OTHER_ROOTS {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(other);
            if path.is_dir() {
                sources(&path, &mut files);
            } else if path.is_file() {
                files.push(source(&path));
            }
        }
        files
    }

    /// Every `.rs` file under `dir`, as (path relative to the package with `/` separators, text).
    fn sources(dir: &Path, out: &mut Vec<(String, String)>) {
        let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("a directory entry").path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(source(&path));
            }
        }
    }

    fn source(path: &Path) -> (String, String) {
        let rel = path
            .strip_prefix(env!("CARGO_MANIFEST_DIR"))
            .expect("a file in this package")
            .to_string_lossy()
            .replace('\\', "/");
        let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        (rel.trim_start_matches('/').to_owned(), text)
    }

    /// Whether a crate name is a host's: `tauri`, its build script's, any of its plugins, or
    /// the two crates under it that own the window and the webview.
    fn is_host(name: &str) -> bool {
        let name = name.trim().trim_matches(|c| c == '"' || c == '\'');
        name.starts_with("tauri") || name == "wry" || name == "tao"
    }

    /// Whether one line of a manifest declares a dependency on a host's crate.
    fn names_a_host(line: &str) -> bool {
        let line = line.trim();
        if line.starts_with('#') {
            return false;
        }
        // `[dependencies.tauri]`, `[target.'cfg(…)'.dependencies.tauri-plugin-x]`.
        if line.starts_with('[') {
            return line
                .rsplit_once("dependencies.")
                .is_some_and(|(_, name)| is_host(name.trim_end_matches(']')));
        }
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        // `tauri = …`, `"tauri-build" = …` — and a rename, `ui = { package = "tauri" }`.
        is_host(key)
            || value.split_once("package").is_some_and(|(_, rest)| {
                rest.trim_start()
                    .strip_prefix('=')
                    .and_then(|named| named.trim_start().strip_prefix('"'))
                    .and_then(|named| named.split('"').next())
                    .is_some_and(is_host)
            })
    }

    /// Every line of one manifest that turns this crate's `testing` feature on outside a
    /// `dev-dependencies` table, as `line number: text`.
    ///
    /// Three spellings reach it: `grimoire-core = { …, features = ["testing"] }` in a
    /// dependencies table, a `[dependencies.grimoire-core]` table with the feature in it, and a
    /// feature of the host's own that forwards `grimoire-core/testing`.
    fn asks_for_testing(manifest: &str) -> Vec<String> {
        let mut found = Vec::new();
        let mut dev = false;
        let mut own_table = false;
        for (i, raw) in manifest.lines().enumerate() {
            let line = raw.trim();
            if line.starts_with('#') || line.is_empty() {
                continue;
            }
            if line.starts_with('[') {
                dev = line.contains("dev-dependencies");
                own_table = line
                    .trim_end_matches(']')
                    .ends_with("dependencies.grimoire-core");
                continue;
            }
            if dev {
                continue;
            }
            let names_it = line.contains("\"testing\"") || line.contains("'testing'");
            let on_its_line = line.starts_with("grimoire-core") && names_it;
            let in_its_table = own_table && names_it;
            let forwarded = line.contains("grimoire-core/testing");
            if on_its_line || in_its_table || forwarded {
                found.push(format!("{}: {line}", i + 1));
            }
        }
        found
    }

    /// **The `testing` feature is test scaffolding, and one thing in it is not harmless in a
    /// shipped build**: `image_uri::is_allowed_host` lets a loopback host through under it, so
    /// the image fetcher's tests can run against a mock server. A host that named the feature
    /// on its ordinary dependency line would ship that. This reads every workspace member's
    /// manifest — the hosts that exist and the ones that join later — and refuses the feature
    /// anywhere but a `dev-dependencies` table.
    #[test]
    fn no_member_asks_for_the_test_scaffolding_outside_its_tests() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let workspace = fs::read_to_string(root.join("Cargo.toml")).unwrap();
        let members: Vec<&str> = workspace
            .lines()
            .find(|l| l.trim_start().starts_with("members"))
            .expect("the workspace's member list")
            .split('"')
            .skip(1)
            .step_by(2)
            .collect();
        // The right list, and one with this crate and a host in it.
        assert!(members.contains(&"crates/grimoire-core"), "{members:?}");
        assert!(members.len() >= 2, "{members:?}");

        for member in &members {
            let path = root.join(member).join("Cargo.toml");
            let manifest =
                fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let found = asks_for_testing(&manifest);
            assert!(
                found.is_empty(),
                "{member}/Cargo.toml turns on `testing` outside [dev-dependencies]: {found:?}"
            );
        }

        // The detector, over each spelling — and over the one place the feature belongs.
        for manifest in [
            "[dependencies]\ngrimoire-core = { path = \"../x\", features = [\"testing\"] }",
            "[target.'cfg(windows)'.dependencies]\ngrimoire-core = { path = \"x\", features = ['testing'] }",
            "[dependencies.grimoire-core]\npath = \"../x\"\nfeatures = [\"testing\"]",
            "[features]\ndefault = [\"grimoire-core/testing\"]",
            "[build-dependencies]\ngrimoire-core = { path = \"x\", features = [\"testing\"] }",
        ] {
            assert!(
                !asks_for_testing(manifest).is_empty(),
                "let through: {manifest}"
            );
        }
        for manifest in [
            "[dev-dependencies]\ngrimoire-core = { path = \"../x\", features = [\"testing\"] }",
            "[dev-dependencies.grimoire-core]\npath = \"../x\"\nfeatures = [\"testing\"]",
            "[dependencies]\ngrimoire-core = { path = \"../crates/grimoire-core\" }",
            "[features]\ntesting = []",
            "# grimoire-core = { features = [\"testing\"] }",
        ] {
            assert_eq!(
                asks_for_testing(manifest),
                Vec::<String>::new(),
                "refused: {manifest}"
            );
        }
    }

    #[test]
    fn nothing_outside_platform_names_a_target_or_reads_the_clock() {
        let files = all_sources();

        // A walk that found nothing would pass everything below.
        for known in [
            "src/legalities.rs",
            "src/schema.rs",
            "src/sync_engine/capture.rs",
            "src/sync_pair/crypto.rs",
            "src/platform/clock.rs",
        ] {
            assert!(
                files.iter().any(|(rel, _)| rel == known),
                "the sweep did not reach {known}"
            );
        }

        let found: Vec<String> = files
            .iter()
            .filter(|(rel, _)| !rel.starts_with(PLATFORM))
            .flat_map(|(rel, text)| offences(rel, text))
            .collect();
        assert!(
            found.is_empty(),
            "these lines belong under src/platform/:\n{}",
            found.join("\n")
        );
    }

    /// **What reaches a network, a disk or another thread is named under `platform/` and
    /// nowhere else a build ships.** Each of the four compiles for a desktop wherever it is
    /// written; `tokio::fs` does not compile for a browser at all, `std::fs` compiles and
    /// fails there when called, and a thread there is a panic. One implementation per kind of
    /// host, in the module that owns the question, is the whole of this crate's design.
    #[test]
    fn nothing_outside_platform_names_the_network_the_disk_or_a_thread() {
        let files = all_sources();
        let tests = test_only(&files);
        // The two files that are test code throughout were found by reading their parents,
        // and nothing that ships was taken for one.
        assert_eq!(
            tests,
            ["src/scratch.rs", "src/sync_engine/apply/tests.rs"],
            "a module declared behind a test gate"
        );

        let found: Vec<String> = files
            .iter()
            .filter(|(rel, _)| !rel.starts_with(PLATFORM) && !tests.contains(rel))
            .flat_map(|(rel, text)| io_offences(rel, text))
            .collect();
        assert!(
            found.is_empty(),
            "these lines belong under src/platform/:\n{}",
            found.join("\n")
        );

        // The detector, over what `platform` really holds — or the sweep above would be
        // passing because it cannot see.
        for (file, what) in [
            ("http.rs", "the HTTP client"),
            ("timer.rs", "the async runtime"),
            ("files.rs", "a disk"),
            ("pause.rs", "a thread"),
        ] {
            let rel = format!("src/platform/{file}");
            let text = fs::read_to_string(Path::new(SRC).join("platform").join(file)).unwrap();
            let found = io_offences(&rel, &text);
            assert!(found.iter().any(|f| f.contains(what)), "{rel}: {found:?}");
        }
    }

    #[test]
    fn the_io_detector_refuses_each_shape_and_lets_the_ordinary_ones_through() {
        for text in [
            "let http = reqwest::Client::new();",
            "    Http(#[from] reqwest::Error),",
            "tokio::time::sleep(wait).await;",
            "    slot: Arc<tokio::sync::Mutex<u64>>,",
            "use tokio::io::AsyncWriteExt;",
            "let mut file = std::fs::File::open(path)?;",
            "use std::fs;",
            "use std::{fs, io};",
            "pub use std::{io, thread};",
            "std::thread::sleep(wait);",
            "let worker = ::std::thread::spawn(run);",
        ] {
            assert!(!io_offences("x.rs", text).is_empty(), "let through: {text}");
        }
        for text in [
            "let http = crate::platform::http::Client::new(&config);",
            "crate::platform::timer::sleep(wait).await;",
            "let mut file = crate::platform::files::open(path)?;",
            "std::thread_local! { static STORE: Store = Store::new(); }",
            "use std::{io, path::Path};",
            "let offs = offsets(&fs);",
            "// `tokio::fs` does not compile for a browser, which is why this asks `platform`.",
            "    /// reqwest is built without its `json` feature.",
            // Below the cut a file is its tests, and a test may put a file on a disk.
            "#[cfg(test)]\nmod tests {\n    #[tokio::test]\n    async fn t() { std::fs::write(p, b).unwrap(); }\n}",
        ] {
            assert_eq!(
                io_offences("x.rs", text),
                Vec::<String>::new(),
                "refused: {text}"
            );
        }
    }

    #[test]
    fn a_module_behind_a_test_gate_is_found_and_one_that_ships_is_not() {
        let file = |rel: &str, text: &str| (rel.to_owned(), text.to_owned());
        let files = [
            file(
                "src/lib.rs",
                "pub mod a;\n#[cfg(any(test, feature = \"testing\"))]\npub mod scratch;\n#[cfg(test)]\nmod gone;\n",
            ),
            file("src/a.rs", "pub fn f() {}\n#[cfg(test)]\nmod tests;\n"),
            file("src/a/tests.rs", ""),
            file("src/b/mod.rs", "    #[cfg(test)]\n    mod checks;\n#[cfg(feature = \"x\")]\nmod kept;\n"),
            file("src/b/checks/mod.rs", ""),
            file("src/b/kept.rs", ""),
            file("src/scratch.rs", ""),
        ];
        assert_eq!(
            test_only(&files),
            ["src/scratch.rs", "src/a/tests.rs", "src/b/checks/mod.rs"]
        );
    }

    /// The sweep's detector, run over the one file that is allowed to offend. If this found
    /// nothing the test above would be passing because it cannot see, not because the crate is
    /// clean.
    #[test]
    fn the_sweep_sees_the_gates_that_platform_really_holds() {
        let clock = fs::read_to_string(Path::new(SRC).join("platform/clock.rs")).unwrap();
        let found = offences("src/platform/clock.rs", &clock);
        assert!(
            found.iter().any(|f| f.contains("names a target")),
            "{found:?}"
        );
        assert!(
            found.iter().any(|f| f.contains("reads a clock")),
            "{found:?}"
        );
    }

    #[test]
    fn the_detector_refuses_each_shape_and_lets_the_ordinary_ones_through() {
        for text in [
            "#[cfg(target_os = \"android\")]",
            "#[cfg(not(target_family = \"wasm\"))]",
            "    target_arch = \"wasm32\",",
            "#[cfg(target_feature = \"simd128\")]",
            "#[cfg(windows)]",
            "if cfg!(unix) {",
            "#[cfg_attr(windows, path = \"win.rs\")]",
            "#[cfg(any(test, windows))]",
            // rustfmt's shape for a long gate: the bare word on a line of its own.
            "#[cfg(all(\n    not(test),\n    any(\n        windows,\n        unix,\n    ),\n))]",
            "let now = SystemTime::now();",
            "let t = std::time::Instant::now();",
            "let since = UNIX_EPOCH.elapsed();",
            "use std::time::SystemTime as Wall;",
            "use std::time::Instant as Tick;",
        ] {
            assert!(!offences("x.rs", text).is_empty(), "let through: {text}");
        }
        for text in [
            "#[cfg(test)]",
            "#[cfg(feature = \"hooks\")]",
            "if cfg!(debug_assertions) {",
            "for pair in stamps.windows(2) {",
            // A gate that closed on its own line does not make the next one gated.
            "#[cfg(test)]\nfor pair in stamps.windows(2) {",
            "if cfg!(debug_assertions) { conn.execute(\"SELECT unixepoch()\", [])?; }",
            "// `SystemTime::now()` panics on wasm, which is why this asks `platform`.",
            "    /// A `cfg(windows)` here would be the mistake.",
            "let ms = crate::platform::clock::now_ms();",
            "    \"Instant\",",
            "let wait = std::time::Duration::from_secs(5);",
        ] {
            assert_eq!(
                offences("x.rs", text),
                Vec::<String>::new(),
                "refused: {text}"
            );
        }
    }

    #[test]
    fn the_manifest_names_no_host() {
        let manifest = fs::read_to_string(MANIFEST).unwrap();
        // The right file, and one with dependencies in it.
        assert!(manifest.contains("name = \"grimoire-core\""));
        assert!(manifest.contains("rusqlite"));

        let found: Vec<&str> = manifest.lines().filter(|l| names_a_host(l)).collect();
        assert!(
            found.is_empty(),
            "grimoire-core may not depend on a host: {found:?}"
        );

        for line in [
            "tauri = { version = \"2\", features = [] }",
            "tauri-build = { version = \"2\" }",
            "tauri-plugin-opener = \"2\"",
            "\"tauri\" = \"2\"",
            "wry = \"0.50\"",
            "tao = \"0.30\"",
            "ui = { package = \"tauri\", version = \"2\" }",
            "[dependencies.tauri]",
            "[target.'cfg(windows)'.dependencies.tauri-plugin-snap-layout]",
            "[dev-dependencies.wry]",
        ] {
            assert!(names_a_host(line), "let through: {line}");
        }
        for line in [
            "# **There is no `tauri` here and there never may be**",
            "rusqlite = { version = \"0.40\", features = [\"bundled\", \"hooks\"] }",
            "serde = { package = \"serde\", version = \"1\" }",
            "description = \"MTG Grimoire's engine, with no window: what every host links.\"",
            "[dependencies]",
            "[target.'cfg(target_family = \"wasm\")'.dependencies]",
        ] {
            assert!(!names_a_host(line), "refused: {line}");
        }
    }
}
