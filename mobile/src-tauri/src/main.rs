// No console window in a release build on Windows — this binary is a desktop debugging aid for
// the light host (see `lib.rs`); the Android build links the library and never this file.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    grimoire_light_lib::run()
}
