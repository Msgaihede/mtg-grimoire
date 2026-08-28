fn main() {
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
    tauri_build::build()
}
