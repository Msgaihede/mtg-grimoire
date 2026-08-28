//! The web target: how a command name and a blob of JSON become a call into this crate.
//!
//! **Its routing and its wire format are compiled for every target on purpose.** A dispatch
//! table is precisely the kind of code where a typo produces a silent `undefined` rather than
//! a compile error, and a module gated to `wasm32-unknown-unknown` is invisible to
//! `cargo test`. So they are ordinary Rust that the suite covers, and only the
//! `#[wasm_bindgen]` shell around them is target-gated.
