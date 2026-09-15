fn main() {
    // Declared before the wasm return, so no target can meet `#[cfg(scanner_assets)]` as an
    // unknown cfg name — `desktop` and `mobile` below are the same lesson. It is only ever
    // *set* further down, once the three files it stands for are all on disk.
    println!("cargo:rustc-check-cfg=cfg(scanner_assets)");

    // A build script always compiles for the HOST, so `cfg!(target_family = "wasm")` here
    // would ask about the wrong machine and always be false. `TARGET` is the question.
    //
    // **The guard is load-bearing, and what it prevents was measured rather than predicted.**
    // Removing it fails the wasm build with `tauri-build` panicking:
    //
    //     missing `cargo:dev` instruction, please update tauri to latest
    //
    // — which is not the plugin-ACL failure it looks like it should be. It never gets that
    // far: `tauri` itself is in `Cargo.toml`'s `cfg(not(target_family = "wasm"))` table, so
    // on this target its build script never runs and never emits the metadata `tauri_build`
    // reads back. The ACL question below is the *reason the plugins stay plain dependencies*
    // on every target that does run this, not the error you get here.
    //
    // `tauri_build::build()` resolves each plugin's ACL permissions through the dependency
    // graph, which is why `Cargo.toml` keeps `tauri-plugin-snap-layout` and
    // `tauri-plugin-mcp-bridge` as plain dependencies rather than `cfg(windows)` ones. It
    // also has nothing to do here: there is no `frontendDist` to embed and no binary to sign.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.starts_with("wasm32") {
        // `tauri_build` normally emits these two, and returning before it runs makes
        // `#[cfg(desktop)]` in `lib.rs`'s module map an *unknown* cfg name on this target —
        // `unexpected_cfgs`, which the wasm CI job turns into an error with `-D warnings`.
        // Declaring them without setting either is the honest answer: on wasm there is
        // neither a desktop nor a mobile Tauri build, and `#[cfg(desktop)]` correctly
        // excludes this target for free.
        println!("cargo:rustc-check-cfg=cfg(desktop)");
        println!("cargo:rustc-check-cfg=cfg(mobile)");
        return;
    }

    // **The three load together or the cfg is off.** A bundle embedded without its models, or
    // the reverse, is a half-shipped scanner — see the 2026-09-15 scanner spec §4.2.
    // `npm run scanner:assets` is what puts them here, and the release workflow runs it.
    //
    // **`rerun-if-changed` on a path that does not exist reruns this script on every build**,
    // so the directory line relies on the directory always existing — which is what its tracked
    // `README.md` is for — and a file gets a line of its own only once it is there. The
    // directory's line is what notices one arriving: cargo scans a directory it is pointed at.
    let assets = std::path::Path::new("scanner-assets");
    println!("cargo:rerun-if-changed=scanner-assets");
    let names = [
        "card-hashes.bin",
        "text-detection.rten",
        "text-recognition.rten",
    ];
    for n in names {
        if assets.join(n).is_file() {
            println!("cargo:rerun-if-changed=scanner-assets/{n}");
        }
    }
    if names.iter().all(|n| assets.join(n).is_file()) {
        println!("cargo:rustc-cfg=scanner_assets");
    }

    tauri_build::build()
}
