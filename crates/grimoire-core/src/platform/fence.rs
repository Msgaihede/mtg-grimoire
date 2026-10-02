//! The sweep that holds this crate to its own rules, by reading its source.
//!
//! Three of the crate's four rules are things no compiler on a desktop can see: a `cfg` for
//! another target compiles to nothing here, `SystemTime::now()` works here, and a `tauri`
//! dependency builds here. CI's `core` job catches what fails to *compile* for the other two
//! targets; this catches what compiles everywhere and is wrong anyway — a platform gate at a
//! call site, a clock read that panics in a browser at run time.
//!
//! **It reads code lines and skips comment lines**, where `mobile/phone/fence.test.ts` reads
//! both: prose here has to be able to say why a rule exists, and the module docs name
//! `SystemTime::now()` to do it. A line is a comment when it *starts* with `//`. So a trailing
//! comment on a code line is read as code and a `/* … */` block is read as code — both wrong
//! only in the direction of refusing too much.
//!
//! **Test code is swept too.** A test never compiles for the browser, so a clock read in one
//! would be harmless; it is refused all the same, because the line between a test helper and
//! the code beside it is one `#[cfg(test)]` that this sweep would have to parse to trust.
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

    #[test]
    fn nothing_outside_platform_names_a_target_or_reads_the_clock() {
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

        // A walk that found nothing would pass everything below.
        for known in [
            "src/legalities.rs",
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
