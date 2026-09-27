fn main() {
    // Declared on every build, so `#[cfg(scanner_assets)]` is never an unknown cfg name. It is
    // only ever *set* further down, once the three files it stands for are all on disk.
    println!("cargo:rustc-check-cfg=cfg(scanner_assets)");

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

    // `tauri_build::build()` resolves each plugin's ACL permissions through the dependency
    // graph, which is why `Cargo.toml` keeps `tauri-plugin-snap-layout` and
    // `tauri-plugin-mcp-bridge` as plain dependencies rather than `cfg(windows)` ones.
    tauri_build::build()
}
