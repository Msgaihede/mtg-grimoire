fn main() {
    // `tauri_build::build()` resolves each plugin's ACL permissions through the dependency
    // graph, which is why `Cargo.toml` keeps `tauri-plugin-snap-layout` and
    // `tauri-plugin-mcp-bridge` as plain dependencies rather than `cfg(windows)` ones.
    tauri_build::build()
}
