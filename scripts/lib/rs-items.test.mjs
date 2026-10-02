// The splitter `scripts/core-step-4.mjs` moves a module with, held to the one property that
// makes moving a hundred thousand lines with it safe — its pieces rejoin to its input — and to
// the handful of Rust spellings that would put a cut in the wrong place.
import { describe, expect, it } from "vitest";
import { code, cut, inner, printUse, split, leavesOf } from "./rs-items.mjs";

// Every Rust file both workspace members compile, as text.
const SOURCES = import.meta.glob(["/src-tauri/src/**/*.rs", "/crates/grimoire-core/src/**/*.rs"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const rejoin = (s) => s.header + s.items.map((i) => i.text).join("") + s.tail;
const kinds = (src) => split(src).items.map((i) => `${i.kind} ${i.name}`);

describe("split", () => {
  it("rejoins to its input for every file in both crates", () => {
    const files = Object.entries(SOURCES);
    expect(files.length).toBeGreaterThan(100);
    for (const [path, text] of files) {
      const src = text.replace(/\r\n/g, "\n");
      expect(rejoin(split(src)), path).toBe(src);
    }
  });

  // `trivia` as well as `other`: an item read as nothing but comments is a head it failed to find.
  it("gives every item of every file a kind it knows", () => {
    for (const [path, text] of Object.entries(SOURCES)) {
      for (const item of split(text.replace(/\r\n/g, "\n")).items) {
        expect(["other", "trivia"], `${path}:${item.line}`).not.toContain(item.kind);
      }
    }
  });

  it("knows a `macro_rules!` and an item-position macro call", () => {
    expect(kinds("macro_rules! m {\n    () => {};\n}\nthread_local! {\n    static X: u8 = 0;\n}\nfn f() {}\n")).toEqual([
      "macro_rules! m",
      "macro null",
      "fn f",
    ]);
  });

  it("peels the `//!` header off the first item, blank lines inside it included", () => {
    const s = split("//! One.\n//!\n\n//! Two.\n\nuse a::b;\nfn f() {}\n");
    expect(s.header).toBe("//! One.\n//!\n\n//! Two.\n");
    expect(s.items.map((i) => i.kind)).toEqual(["use", "fn"]);
  });

  it("keeps an item's doc comment and attributes with it", () => {
    const s = split("fn a() {}\n\n/// Doc.\n#[derive(Debug)]\npub struct B;\n");
    expect(s.items[1].text).toBe("\n/// Doc.\n#[derive(Debug)]\npub struct B;\n");
    expect(s.items[1]).toMatchObject({ kind: "struct", name: "B", vis: "pub" });
    expect(s.items[1].attrs).toEqual(["#[derive(Debug)]"]);
  });

  it("does not end an item at a brace inside a string, a raw string or a char", () => {
    expect(kinds('const A: &str = "}";\nconst B: &str = r#"}"; "#;\nconst C: char = \'}\';\nfn d() {}\n')).toEqual([
      "const A",
      "const B",
      "const C",
      "fn d",
    ]);
  });

  it("reads `'a` as a lifetime and `'\\''` as a char", () => {
    expect(kinds("fn a<'a>(x: &'a str) -> &'a str { x }\nconst Q: char = '\\'';\nfn b() {}\n")).toEqual([
      "fn a",
      "const Q",
      "fn b",
    ]);
  });

  it("steps over a nested block comment", () => {
    expect(kinds("/* a /* } */ b */\nfn a() {}\nfn b() {}\n")).toEqual(["fn a", "fn b"]);
  });

  it("ends a braced value at its `;`, not at its brace", () => {
    expect(kinds("const X: T = T { a: 1 };\nuse a::{b, c};\nfn f() {}\n")).toEqual(["const X", "use null", "fn f"]);
  });

  it("is not ended by the brackets of an attribute", () => {
    const s = split('#[cfg(any(test, feature = "testing"))]\npub mod m {\n    fn a() {}\n}\nfn b() {}\n');
    expect(s.items.map((i) => `${i.kind} ${i.name}`)).toEqual(["mod m", "fn b"]);
  });

  // A bracket inside an attribute's string is not one of the attribute's own.
  it("finds the head under an attribute whose string holds a bracket", () => {
    const [item] = split('#[doc = "a [b"]\nfn f() {}\n').items;
    expect(item).toMatchObject({ kind: "fn", name: "f" });
    expect(item.attrs).toEqual(['#[doc = "a [b"]']);
  });

  it("names an `impl` after its type, with or without a trait", () => {
    expect(
      kinds(
        "impl Foo {}\nimpl<T> Default for Bar<T> {}\nimpl std::ops::Deref for Baz {}\nimpl<T: Into<String>> Qux<T> {}\nimpl<'de> Visitor<'de> for Doc {}\n",
      ),
    ).toEqual(["impl Foo", "impl Bar", "impl Baz", "impl Qux", "impl Doc"]);
  });

  // The one spelling it cuts wrongly: written down here so the day it matters it is found.
  it("ends an item early at a brace in its head, and still rejoins", () => {
    const src = "impl Foo<{ N }> for X {}\nfn f() {}\n";
    expect(rejoin(split(src))).toBe(src);
    expect(split(src).items.length).toBe(3);
  });

  it("reads `const fn` and `pub(crate) async fn` as functions", () => {
    const s = split("const fn a() {}\npub(crate) async fn b() {}\n");
    expect(s.items.map((i) => [i.kind, i.name, i.vis])).toEqual([
      ["fn", "a", ""],
      ["fn", "b", "pub(crate)"],
    ]);
  });

  it("refuses unbalanced brackets rather than guessing", () => {
    expect(() => cut("fn a() {\n")).toThrow(/unbalanced/);
  });
});

describe("inner", () => {
  it("splits a module's body and rejoins to the module", () => {
    const text = "\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn a() {}\n\n    fn helper() {}\n}\n";
    const [item] = split(text).items;
    const body = inner(item);
    expect(body.before + body.items.map((i) => i.text).join("") + body.tail + body.after).toBe(text);
    expect(body.items.map((i) => `${i.kind} ${i.name}`)).toEqual(["use null", "fn a", "fn helper"]);
    expect(body.items[1].attrs).toEqual(["    #[test]"]);
  });
});

describe("code", () => {
  it("blanks comments and literals and keeps every offset", () => {
    const text = 'let a = "tauri::x"; // AppState\nlet b = c;\n';
    const c = code(text);
    expect(c.length).toBe(text.length);
    expect(c).not.toContain("tauri");
    expect(c).not.toContain("AppState");
    expect(c.indexOf("let b")).toBe(text.indexOf("let b"));
  });
});

describe("leavesOf and printUse", () => {
  it("names every leaf of a tree, `self` and aliases included", () => {
    expect(leavesOf("a::{b, c::{self, D as E}, f::*}").map((l) => [l.path, l.name])).toEqual([
      ["a::b", "b"],
      ["a::c", "c"],
      ["a::c::D", "E"],
      ["a::f::*", "*"],
    ]);
  });

  it("prints a pruned tree back, sharing prefixes", () => {
    const leaves = leavesOf("crate::sync::{with_write, AppState}").filter((l) => l.name === "AppState");
    expect(printUse(leaves)).toBe("crate::sync::AppState");
    expect(printUse(leavesOf("a::{b, c::{self, D as E}}"))).toBe("a::{b, c::{self, D as E}}");
    expect(printUse(leavesOf("a::b::{self}"))).toBe("a::b");
  });
});
