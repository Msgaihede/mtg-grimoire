// A lossless splitter of a rustfmt-formatted Rust file into its top-level items — what
// `scripts/core-step-4.mjs` moves a module with.
//
// **Not a parser.** It tracks comments, string and char literals and bracket depth, and cuts at
// depth 0 on a `;` or on the `}` that returns there. Each item carries its leading trivia (blank
// lines, comments, doc comments, attributes), so the items joined end to end, plus the tail, are
// the input byte for byte — `split` throws when they are not, which is the whole of what makes
// moving 100 000 lines with it safe: a cut in the wrong place cannot lose a character, only put
// one in the wrong item, and that is a compile error.
//
// **One spelling it cuts wrongly, and loudly**: a brace in an item's *head* — the const argument
// in `impl Foo<{ N }> for X { … }` — closes the item at that brace, because nothing here tells an
// angle bracket from a comparison. The pieces still rejoin; the two halves are each a compile
// error if they are moved apart. Neither crate has one.
//
// Dependency-free, like the rest of `scripts/`.

/**
 * Walk `src[from..to]`, calling `onCode(i, ch)` for every character that is code — outside a
 * comment, a string, a raw string and a char literal. Returning `false` stops the walk.
 */
export function scan(src, from, to, onCode) {
  let i = from;
  while (i < to) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 || e > to ? to : e;
      continue;
    }
    if (c === "/" && n === "*") {
      // Rust's block comments nest.
      let depth = 1;
      i += 2;
      while (i < to && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    // r"…", r#"…"#, br#"…"# — but not an identifier that merely ends in `r`.
    if ((c === "r" || (c === "b" && n === "r")) && !/[A-Za-z0-9_]/.test(src[i - 1] ?? " ")) {
      let j = i + (c === "b" ? 2 : 1);
      let hashes = 0;
      while (src[j] === "#") {
        hashes++;
        j++;
      }
      if (src[j] === '"') {
        const close = '"' + "#".repeat(hashes);
        const e = src.indexOf(close, j + 1);
        i = e < 0 ? to : e + close.length;
        continue;
      }
    }
    if (c === '"') {
      i++;
      while (i < to && src[i] !== '"') {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "'") {
      // A char literal or a lifetime. `'\…'` is always a literal; `'x'` is one when the quote
      // closes two characters on (three for a surrogate pair); anything else is a lifetime.
      if (n === "\\") {
        i += 3;
        while (i < to && src[i] !== "'") i++;
        i++;
        continue;
      }
      if (src[i + 2] === "'") {
        i += 3;
        continue;
      }
      const hi = src.charCodeAt(i + 1);
      if (src[i + 3] === "'" && hi >= 0xd800 && hi <= 0xdbff) {
        i += 4;
        continue;
      }
      i++;
      continue;
    }
    if (onCode(i, c) === false) return i;
    i++;
  }
  return to;
}

/**
 * Cut `src[from..to]` into item spans. `tailHasCode` is true when something that is not
 * whitespace or a comment follows the last item — a caller splitting a whole file treats that
 * as a refusal.
 */
export function cut(src, from = 0, to = src.length) {
  const items = [];
  let depth = 0;
  let start = from;
  let sawCode = false;
  // Inside `#[…]` at depth 0: its brackets must not end an item.
  let attrDepth = 0;
  scan(src, from, to, (i, c) => {
    if (c === "(" || c === "[" || c === "{") {
      const opensAttr =
        attrDepth === 0 &&
        depth === 0 &&
        c === "[" &&
        (src[i - 1] === "#" || (src[i - 1] === "!" && src[i - 2] === "#"));
      if (attrDepth > 0 || opensAttr) attrDepth++;
      depth++;
      sawCode = true;
      return;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (attrDepth > 0) {
        attrDepth--;
        return;
      }
      if (depth === 0 && c === "}") {
        // `};` — a braced value closing a `const`, a `static` or a `use`: the `;` ends it.
        let j = i + 1;
        while (src[j] === " ") j++;
        if (src[j] === ";") return;
        let e = i + 1;
        if (src[e] === "\r") e++;
        if (src[e] === "\n") e++;
        items.push({ start, end: e });
        start = e;
        sawCode = false;
      }
      return;
    }
    if (c === ";" && depth === 0) {
      let e = i + 1;
      // A trailing comment on the same line stays with its item.
      const nl = src.indexOf("\n", e);
      const lineEnd = nl < 0 || nl >= to ? to : nl + 1;
      if (/^[ \t]*(\/\/.*)?\r?\n?$/.test(src.slice(e, lineEnd))) e = lineEnd;
      items.push({ start, end: e });
      start = e;
      sawCode = false;
      return;
    }
    if (!/\s/.test(c)) sawCode = true;
  });
  if (depth !== 0) throw new Error(`unbalanced brackets: depth ${depth} at the end`);
  return { items, tail: [start, to], tailHasCode: sawCode };
}

// `macro_rules!` is its own alternative with no `\b` after it: there is no word boundary between
// `!` and a space, so behind the shared one it never matched.
const HEAD =
  /^(pub(?:\([^)]*\))?\s+)?((?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?)(macro_rules!|(?:fn|struct|enum|union|trait|type|const|static|mod|impl|use|extern crate)\b)\s*([A-Za-z_][A-Za-z0-9_]*)?/;

/** How many `ch` a line holds outside its string literals — `#[doc = "a [b"]` opens one bracket. */
function count(s, ch) {
  let n = 0;
  for (const c of s.replace(/"(?:[^"\\]|\\.)*"/g, '""')) if (c === ch) n++;
  return n;
}

/** The type an `impl` is for: past its own generics, past `Trait for`, without the type's. */
function implName(head) {
  let i = head.indexOf("impl") + 4;
  if (head[i] === "<") {
    // `impl<T: Into<String>>` — the parameters nest.
    let depth = 0;
    for (; i < head.length; i++) {
      if (head[i] === "<") depth++;
      else if (head[i] === ">" && head[i - 1] !== "-" && --depth === 0) break;
    }
    i++;
  }
  const rest = head.slice(i);
  const at = rest.search(/\sfor\s/);
  const type = (at < 0 ? rest : rest.slice(at + 5)).trim();
  return /^&?(?:'\w+\s+)?(?:mut\s+)?([\w:]+)/.exec(type)?.[1]?.split("::").pop() ?? null;
}

/**
 * What one item is: its attributes, its visibility, its kind and its name. `headLine` is the
 * index, within the item's own lines, of the line the declaration starts on.
 */
export function describe(text) {
  const lines = text.split("\n");
  const attrs = [];
  let headLine = -1;
  let attrOpen = 0;
  let inBlock = false;
  for (let k = 0; k < lines.length; k++) {
    const t = lines[k].trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (attrOpen > 0) {
      attrs[attrs.length - 1] += "\n" + lines[k];
      attrOpen += count(t, "[") - count(t, "]");
      continue;
    }
    if (t === "" || t.startsWith("//")) continue;
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true;
      continue;
    }
    if (t.startsWith("#[") || t.startsWith("#![")) {
      attrs.push(lines[k]);
      attrOpen = count(t, "[") - count(t, "]");
      continue;
    }
    headLine = k;
    break;
  }
  if (headLine < 0) return { kind: "trivia", name: null, vis: "", attrs, headLine };
  const m = HEAD.exec(lines[headLine].trim());
  if (!m) {
    // `thread_local! { … }` — an item-position macro call declares whatever it likes.
    const call = /^([A-Za-z_][A-Za-z0-9_:]*)!\s*[({[]/.exec(lines[headLine].trim());
    return { kind: call ? "macro" : "other", name: null, vis: "", attrs, headLine };
  }
  let kind = m[3];
  // A `use` declares many names or none; its leaves are `leavesOf`' to say.
  let name = kind === "use" ? null : (m[4] ?? null);
  // `const fn f` reads as a `const` named `fn`.
  if (kind === "const" && name === "fn") {
    kind = "fn";
    name = /fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[headLine])?.[1] ?? null;
  }
  if (kind === "impl") {
    // `impl<T> Trait for Type` and `impl Type`: the name is the type.
    name = implName(lines.slice(headLine, headLine + 3).join(" ").trim());
  }
  return { kind, name, vis: (m[1] ?? "").trim(), attrs, headLine };
}

function countNewlines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * A whole file as `{ header, items, tail }`. `header` is the `//!` block at the top, peeled off
 * the first item; `header + items.map(text).join("") + tail` is the input.
 */
export function split(src) {
  const { items: spans, tail, tailHasCode } = cut(src);
  if (tailHasCode) throw new Error("code after the last item");
  const items = [];
  let line = 1;
  let pos = 0;
  for (const s of spans) {
    const text = src.slice(s.start, s.end);
    const startLine = line + countNewlines(src.slice(pos, s.start));
    const d = describe(text);
    items.push({ ...d, text, line: startLine + Math.max(d.headLine, 0) });
    line = startLine + countNewlines(text);
    pos = s.end;
  }
  const tailText = src.slice(tail[0], tail[1]);
  let header = "";
  if (items.length > 0) {
    const first = items[0];
    const ls = first.text.split("\n");
    let k = 0;
    const moreHeader = (from) => {
      for (let j = from; j < ls.length; j++) {
        if (ls[j].trim() === "") continue;
        return ls[j].startsWith("//!");
      }
      return false;
    };
    while (k < ls.length && (ls[k].startsWith("//!") || (ls[k].trim() === "" && moreHeader(k + 1)))) k++;
    if (k > 0) {
      header = ls.slice(0, k).join("\n") + "\n";
      const rest = ls.slice(k).join("\n");
      Object.assign(first, describe(rest), { text: rest, line: first.line });
    }
  }
  if (header + items.map((i) => i.text).join("") + tailText !== src) {
    throw new Error("the split does not rejoin to its input");
  }
  return { header, items, tail: tailText };
}

/**
 * The body of a braced item — `mod tests { … }` — as items of its own.
 * `before + items.map(text).join("") + tail + after` is the item's text.
 */
export function inner(item) {
  const text = item.text;
  let open = -1;
  let attr = 0;
  scan(text, 0, text.length, (i, c) => {
    // The item's own brace, not one inside an attribute above it.
    if (c === "[" && (text[i - 1] === "#" || attr > 0)) attr++;
    else if (c === "]" && attr > 0) attr--;
    else if (c === "{" && attr === 0) {
      open = i;
      return false;
    }
  });
  const close = text.lastIndexOf("}");
  if (open < 0 || close < open) throw new Error("not a braced item");
  let bodyStart = open + 1;
  if (text[bodyStart] === "\r") bodyStart++;
  if (text[bodyStart] === "\n") bodyStart++;
  const { items: spans, tail, tailHasCode } = cut(text, bodyStart, close);
  if (tailHasCode) throw new Error("code after the last item of a body");
  const items = spans.map((s) => {
    const t = text.slice(s.start, s.end);
    return { ...describe(t), text: t };
  });
  return {
    before: text.slice(0, bodyStart),
    items,
    tail: text.slice(tail[0], tail[1]),
    after: text.slice(close),
  };
}

/**
 * `text` with everything that is not code blanked to spaces, newlines kept — so an offset into
 * the answer is an offset into `text`, and a name in a comment or a string is not a reference.
 */
export function code(text) {
  const keep = new Uint8Array(text.length);
  scan(text, 0, text.length, (i) => {
    keep[i] = 1;
  });
  let out = "";
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (keep[i] || text[i] === "\n") {
      if (run > 0) {
        out += " ".repeat(run);
        run = 0;
      }
      out += text[i];
    } else run++;
  }
  return out + " ".repeat(run);
}

/**
 * The leaves of a `use` declaration's tree: `use a::{b, c::{self, D as E}};` is
 * `a::b` named `b`, `a::c` named `c`, and `a::c::D` named `E`. A glob's name is `*`.
 */
export function leavesOf(tree) {
  const out = [];
  const walk = (prefix, s) => {
    for (const part of splitTop(s)) {
      const p = part.trim();
      if (!p) continue;
      const brace = p.indexOf("{");
      if (brace >= 0) {
        const head = p.slice(0, brace).replace(/::\s*$/, "").trim();
        const body = p.slice(brace + 1, p.lastIndexOf("}"));
        walk(prefix ? (head ? `${prefix}::${head}` : prefix) : head, body);
        continue;
      }
      const as = /^(.*?)\s+as\s+(\w+)$/.exec(p);
      const path = (as ? as[1] : p).replace(/\s/g, "");
      if (path === "self") {
        out.push({ path: prefix, name: as ? as[2] : prefix.split("::").pop(), self: true, alias: as?.[2] });
        continue;
      }
      const full = prefix ? `${prefix}::${path}` : path;
      out.push({ path: full, name: as ? as[2] : full.split("::").pop(), alias: as?.[2] });
    }
  };
  walk("", tree);
  return out;
}

function splitTop(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** A `use` tree printed back from leaves, sharing prefixes. rustfmt lays it out. */
export function printUse(leaves) {
  const root = { children: new Map(), leaves: [] };
  for (const leaf of leaves) {
    const segs = leaf.path.split("::");
    const last = leaf.self ? "self" : segs.pop();
    let node = root;
    for (const s of segs) {
      if (!node.children.has(s)) node.children.set(s, { children: new Map(), leaves: [] });
      node = node.children.get(s);
    }
    node.leaves.push(leaf.alias ? `${last} as ${leaf.alias}` : last);
  }
  const print = (node) => {
    const parts = [...node.leaves];
    for (const [seg, child] of node.children) {
      const sub = print(child);
      // `a::{self}` is `a`: a lone `self` is only legal inside braces.
      if (sub === "self") parts.push(seg);
      else if (sub.startsWith("self as ")) parts.push(`${seg} as ${sub.slice("self as ".length)}`);
      else parts.push(`${seg}::${sub}`);
    }
    return parts.length === 1 ? parts[0] : `{${parts.join(", ")}}`;
  };
  return print(root);
}
