//! **Scryfall's query syntax, ported from the page** — `packages/ui/features/search/queryLanguage.ts`,
//! function by function, for a host with no window to ask.
//!
//! `t:goblin`, `o:"draw a card"`, `c>=rg`, `cmc>=3`, `-kw:flying`, `otag:removal`,
//! `(t:goblin or t:elf) is:commander`, `!"lightning bolt"`: the page reads every card search box
//! with that module, and the MCP server's tools read an agent's `syntax` with this one. The owner
//! ruled the port (2026-11-24, `docs/superpowers/specs/2026-11-24-mcp-card-knowledge-design.md`
//! §2): TypeScript logic the MCP needs is ported to Rust, because the planned remote tier has no
//! window, and **the TypeScript stays where it is for the page**.
//!
//! # One answer, held by a golden
//!
//! [`parse_query`] answers what `parseQuery` answers, for every input, source spans included.
//! `packages/ui/features/search/__golden__/query-language.json` is written by the TypeScript
//! (`queryLanguage.golden.test.ts`, `pnpm vitest run -u`) and read by the test at the foot of this
//! file: every vocabulary table, some three hundred chosen queries and five hundred seeded random
//! ones. A change to the grammar on either side fails one suite until the other follows.
//!
//! **The reasons live in the TypeScript.** Each function here names the one it ports, and the
//! *why* of the grammar (why `:` means something different per keyword, why a quote opens only
//! where a value can begin, why AND binds tighter than OR) is that function's doc comment. A
//! second copy of the reasoning here would drift from the first with nothing to hold it.
//!
//! # JavaScript's semantics, not Rust's
//!
//! Where the two standard libraries disagree, the port follows JavaScript, because the page is
//! the reference:
//!
//! - **Whitespace** is `/\s/`'s, which counts U+FEFF and not U+0085 — the opposite of
//!   [`char::is_whitespace`] on both ([`js_space`], [`js_trim`]).
//! - **"A word in it"** is `/[\p{L}\p{N}]/u`, a letter or a number by general category, which is
//!   narrower than [`char::is_alphanumeric`]: that one also takes every Other_Alphabetic mark,
//!   such as Ⓐ ([`indexable`]).
//! - **Character classes are ASCII**: `\d`, `[A-Za-z]` and a `/i` without `u` match no other
//!   script.
//! - **Spans are byte offsets** here and UTF-16 offsets there; the golden test converts.
//!
//! Every regular expression the module uses is deterministic — no backtracking changes what it
//! matches — so each is a short hand-written scan rather than a dependency.
//!
//! # [`read`]: the tools' entry point
//!
//! The page's grammar is forgiving because the box is parsed on every keystroke: `cmc>=banana` is
//! the words *cmc banana*, a bare `t:` says nothing, and an unclosed `(` runs to the end. An agent
//! that wrote those would read the empty answer as "no such cards", so the tools call [`read`],
//! which refuses — naming every term it cannot apply as written ([`Unread`]) — before it parses.
//! It reads the parser's own decisions ([`classify_why`]), so the check and the parse cannot
//! disagree. The owner's decision, 2026-11-25
//! (`docs/superpowers/specs/2026-11-25-mcp-scryfall-syntax-design.md` §2).

use crate::filters::{
    PredicateField, PredicateOp, QueryPredicate, COLOR_NAMES as FILTER_COLOR_NAMES, IS_VALUES,
};
use serde::Serialize;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

/// The two tag taxonomies a keyword can name — the page's `TagNamespace`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TagNamespace {
    Oracle,
    Art,
}

impl TagNamespace {
    /// The word `tag_resolve` and `tag_search` take.
    pub fn as_str(self) -> &'static str {
        match self {
            TagNamespace::Oracle => "oracle",
            TagNamespace::Art => "art",
        }
    }
}

/// A tag the query named at the top level, and where — the page's `TagToken`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagToken {
    pub namespace: TagNamespace,
    pub value: String,
    pub negated: bool,
    /// Byte offsets into the query, half-open.
    pub start: usize,
    pub end: usize,
}

/// A predicate and where it sits — the page's `PredicateToken`. A group's `terms` carry no spans.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredicateToken {
    #[serde(flatten)]
    pub predicate: QueryPredicate,
    /// Byte offsets into the query, half-open.
    pub start: usize,
    pub end: usize,
}

/// What one query says — the page's `ParsedQuery`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedQuery {
    /// The unrecognised words, rejoined with single spaces — `SearchRequest.text`.
    pub text: String,
    pub tags: Vec<TagToken>,
    /// In source order, plain terms and groups alike.
    pub predicates: Vec<PredicateToken>,
}

/// What a keyword names: a predicate field, or a tag taxonomy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Field(PredicateField),
    Tag(TagNamespace),
}

/// One row of the vocabulary — the page's `KeywordSpec`, whose doc says what each part is for.
#[derive(Debug, Clone, Copy)]
pub struct KeywordSpec {
    pub target: Target,
    pub keywords: &'static [&'static str],
    /// What a bare `:` means for this keyword.
    pub default_op: PredicateOp,
    pub ops: &'static [PredicateOp],
    pub example: &'static str,
    pub blurb: &'static str,
    /// One of [`QUERY_SECTIONS`].
    pub section: &'static str,
}

/// The F1 panel's sections, in its order — `QUERY_SECTIONS`.
pub const QUERY_SECTIONS: [&str; 7] = [
    "Text and names",
    "Colors and mana",
    "Numbers",
    "Sets and printings",
    "Formats and prices",
    "Card properties",
    "Tags",
];

use PredicateOp::{Colon, Eq, Gt, Gte, Lt, Lte, Ne};

/// `COMPARISONS`: what a numeric or ordered field takes.
const COMPARISONS: &[PredicateOp] = &[Colon, Eq, Ne, Gt, Gte, Lt, Lte];

/// `MATCHES`: what a text or closed-vocabulary field takes — contains, or equals.
const MATCHES: &[PredicateOp] = &[Colon, Eq];

/// Only `:`.
const COLON: &[PredicateOp] = &[Colon];

/// One row, in the order of the TypeScript literal.
const fn row(
    target: Target,
    keywords: &'static [&'static str],
    default_op: PredicateOp,
    ops: &'static [PredicateOp],
    example: &'static str,
    blurb: &'static str,
    section: &'static str,
) -> KeywordSpec {
    KeywordSpec {
        target,
        keywords,
        default_op,
        ops,
        example,
        blurb,
        section,
    }
}

use PredicateField as F;
use Target::{Field, Tag};

/// The whole vocabulary — `QUERY_KEYWORDS`, row for row and in its order, which the golden holds.
pub const QUERY_KEYWORDS: [KeywordSpec; 45] = [
    row(
        Field(F::Name),
        &["name"],
        Colon,
        MATCHES,
        "name:goblin",
        "Card name",
        "Text and names",
    ),
    row(
        Field(F::TypeLine),
        &["t", "type"],
        Colon,
        MATCHES,
        "t:goblin",
        "Card type line",
        "Text and names",
    ),
    row(
        Field(F::OracleText),
        &["o", "oracle", "fo", "fulloracle"],
        Colon,
        MATCHES,
        "o:\"draw a card\"",
        "Rules text",
        "Text and names",
    ),
    row(
        Field(F::Flavor),
        &["ft", "flavor"],
        Colon,
        MATCHES,
        "ft:mishra",
        "Flavor text",
        "Text and names",
    ),
    row(
        Field(F::Keyword),
        &["kw", "keyword"],
        Colon,
        MATCHES,
        "kw:flying",
        "Keyword ability",
        "Text and names",
    ),
    row(
        Field(F::Artist),
        &["a", "artist"],
        Colon,
        MATCHES,
        "a:avon",
        "Illustrator",
        "Text and names",
    ),
    row(
        Field(F::Watermark),
        &["wm", "watermark"],
        Colon,
        MATCHES,
        "wm:orzhov",
        "Watermark",
        "Text and names",
    ),
    row(
        Field(F::Colors),
        &["c", "color", "colour"],
        Gte,
        COMPARISONS,
        "c>=rg",
        "Card colors: letters, a color name, a guild or shard, m, or a count",
        "Colors and mana",
    ),
    row(
        Field(F::ColorIdentity),
        &["id", "identity", "ci"],
        Lte,
        COMPARISONS,
        "id<=wu",
        "Color identity",
        "Colors and mana",
    ),
    row(
        Field(F::ManaCost),
        &["m", "mana"],
        Gte,
        COMPARISONS,
        "m:{G}{U}",
        "Mana cost symbols",
        "Colors and mana",
    ),
    row(
        Field(F::Devotion),
        &["devotion"],
        Gte,
        COMPARISONS,
        "devotion:{U}{U}{U}",
        "Devotion to a color",
        "Colors and mana",
    ),
    row(
        Field(F::Produces),
        &["produces"],
        Gte,
        COMPARISONS,
        "produces:wu",
        "Mana it can produce",
        "Colors and mana",
    ),
    row(
        Field(F::Cmc),
        &["cmc", "mv", "manavalue"],
        Eq,
        COMPARISONS,
        "cmc>=3",
        "Mana value, or even, odd",
        "Numbers",
    ),
    row(
        Field(F::Power),
        &["pow", "power"],
        Eq,
        COMPARISONS,
        "pow>=4",
        "Power",
        "Numbers",
    ),
    row(
        Field(F::Toughness),
        &["tou", "tough", "toughness"],
        Eq,
        COMPARISONS,
        "tou<=2",
        "Toughness",
        "Numbers",
    ),
    row(
        Field(F::Loyalty),
        &["loy", "loyalty"],
        Eq,
        COMPARISONS,
        "loy>=5",
        "Starting loyalty",
        "Numbers",
    ),
    row(
        Field(F::PowTou),
        &["pt", "powtou"],
        Eq,
        COMPARISONS,
        "pt>=10",
        "Power plus toughness",
        "Numbers",
    ),
    row(
        Field(F::CollectorNumber),
        &["cn", "number"],
        Eq,
        COMPARISONS,
        "cn>=250",
        "Collector number",
        "Numbers",
    ),
    row(
        Field(F::Rarity),
        &["r", "rarity"],
        Eq,
        COMPARISONS,
        "r>=rare",
        "Rarity, ordered",
        "Sets and printings",
    ),
    row(
        Field(F::SetCode),
        &["s", "set", "e", "edition"],
        Eq,
        MATCHES,
        "s:neo",
        "Set code",
        "Sets and printings",
    ),
    row(
        Field(F::SetType),
        &["st", "settype"],
        Eq,
        MATCHES,
        "st:masters",
        "Set type",
        "Sets and printings",
    ),
    row(
        Field(F::Block),
        &["b", "block"],
        Eq,
        MATCHES,
        "b:zen",
        "Block, by code or name",
        "Sets and printings",
    ),
    row(
        Field(F::InPrinting),
        &["in"],
        Eq,
        MATCHES,
        "in:lea",
        "Ever printed in a set, game, rarity or language",
        "Sets and printings",
    ),
    row(
        Field(F::Game),
        &["game"],
        Eq,
        MATCHES,
        "game:arena",
        "Printed for paper, Arena or MTGO",
        "Sets and printings",
    ),
    row(
        Field(F::Language),
        &["lang", "language"],
        Eq,
        MATCHES,
        "lang:ja",
        "Printing language",
        "Sets and printings",
    ),
    row(
        Field(F::Year),
        &["year"],
        Eq,
        COMPARISONS,
        "year<=1994",
        "Release year",
        "Sets and printings",
    ),
    row(
        Field(F::Date),
        &["date"],
        Eq,
        COMPARISONS,
        "date>=2020-01-01",
        "Release date, or a set's",
        "Sets and printings",
    ),
    row(
        Field(F::Border),
        &["border"],
        Eq,
        MATCHES,
        "border:white",
        "Border color",
        "Sets and printings",
    ),
    row(
        Field(F::Frame),
        &["frame"],
        Eq,
        MATCHES,
        "frame:1997",
        "Frame edition or frame effect",
        "Sets and printings",
    ),
    row(
        Field(F::Stamp),
        &["stamp"],
        Eq,
        MATCHES,
        "stamp:acorn",
        "Security stamp",
        "Sets and printings",
    ),
    row(
        Field(F::Prints),
        &["prints"],
        Eq,
        COMPARISONS,
        "prints=1",
        "How many printings",
        "Sets and printings",
    ),
    row(
        Field(F::PaperPrints),
        &["paperprints"],
        Eq,
        COMPARISONS,
        "paperprints>=10",
        "How many paper printings",
        "Sets and printings",
    ),
    row(
        Field(F::Sets),
        &["sets"],
        Eq,
        COMPARISONS,
        "sets>=20",
        "How many sets it is in",
        "Sets and printings",
    ),
    row(
        Field(F::PaperSets),
        &["papersets"],
        Eq,
        COMPARISONS,
        "papersets=1",
        "How many paper sets it is in",
        "Sets and printings",
    ),
    row(
        Field(F::NewFeature),
        &["new"],
        Colon,
        COLON,
        "new:art",
        "First printing with this art, frame, rarity…",
        "Sets and printings",
    ),
    row(
        Field(F::Format),
        &["f", "format", "legal"],
        Eq,
        MATCHES,
        "f:modern",
        "Format legality",
        "Formats and prices",
    ),
    row(
        Field(F::Banned),
        &["banned"],
        Eq,
        MATCHES,
        "banned:modern",
        "Banned in a format",
        "Formats and prices",
    ),
    row(
        Field(F::Restricted),
        &["restricted"],
        Eq,
        MATCHES,
        "restricted:vintage",
        "Restricted in a format",
        "Formats and prices",
    ),
    row(
        Field(F::Usd),
        &["usd"],
        Eq,
        COMPARISONS,
        "usd<1",
        "Price in US dollars",
        "Formats and prices",
    ),
    row(
        Field(F::Eur),
        &["eur"],
        Eq,
        COMPARISONS,
        "eur>=10",
        "Price in euros",
        "Formats and prices",
    ),
    row(
        Field(F::Tix),
        &["tix"],
        Eq,
        COMPARISONS,
        "tix<0.5",
        "Price in MTGO tickets",
        "Formats and prices",
    ),
    row(
        Field(F::Is),
        &["is", "not"],
        Colon,
        COLON,
        "is:fetchland",
        "A property. not: asks for its absence",
        "Card properties",
    ),
    row(
        Field(F::Has),
        &["has"],
        Colon,
        COLON,
        "has:watermark",
        "Has a watermark, indicator, flavor or stamp",
        "Card properties",
    ),
    row(
        Tag(TagNamespace::Oracle),
        &["otag", "oracletag", "function"],
        Colon,
        COLON,
        "otag:removal",
        "Oracle tag: what the card does",
        "Tags",
    ),
    row(
        Tag(TagNamespace::Art),
        &["atag", "arttag", "art"],
        Colon,
        COLON,
        "atag:dragon",
        "Art tag: what the art shows",
        "Tags",
    ),
];

/// `DISPLAY_KEYWORDS`: Scryfall's presentation keywords, recognised and dropped by the parse.
pub const DISPLAY_KEYWORDS: [&str; 6] = [
    "unique",
    "order",
    "direction",
    "prefer",
    "display",
    "include",
];

/// `VOCABULARY.game`.
pub const GAMES: [&str; 3] = ["paper", "arena", "mtgo"];
/// `VOCABULARY.border`.
pub const BORDERS: [&str; 6] = ["black", "white", "borderless", "silver", "gold", "yellow"];
/// `VOCABULARY.stamp`.
pub const STAMPS: [&str; 6] = ["oval", "triangle", "acorn", "circle", "arena", "heart"];
/// `VOCABULARY.has`.
pub const HAS: [&str; 4] = ["watermark", "indicator", "flavor", "stamp"];
/// `VOCABULARY.newFeature`.
pub const NEW_FEATURES: [&str; 7] = [
    "art", "artist", "flavor", "frame", "language", "rarity", "card",
];
/// `VOCABULARY.frame`: the five frame editions and the frame effects, which Rust's SQL tells apart.
pub const FRAMES: [&str; 30] = [
    "1993",
    "1997",
    "2003",
    "2015",
    "future",
    "legendary",
    "miracle",
    "enchantment",
    "nyxtouched",
    "draft",
    "devoid",
    "tombstone",
    "colorshifted",
    "inverted",
    "sunmoondfc",
    "compasslanddfc",
    "originpwdfc",
    "mooneldrazidfc",
    "waxingandwaningmoondfc",
    "showcase",
    "extendedart",
    "companion",
    "etched",
    "snow",
    "lesson",
    "shatteredglass",
    "convertdfc",
    "fandfc",
    "upsidedowndfc",
    "spree",
];

/// The closed vocabulary of a field — `VOCABULARY[field]`; `is:` is the crate's [`IS_VALUES`].
pub fn vocabulary(field: PredicateField) -> Option<&'static [&'static str]> {
    match field {
        F::Game => Some(&GAMES),
        F::Border => Some(&BORDERS),
        F::Stamp => Some(&STAMPS),
        F::Has => Some(&HAS),
        F::NewFeature => Some(&NEW_FEATURES),
        F::Is => Some(IS_VALUES),
        F::Frame => Some(&FRAMES),
        _ => None,
    }
}

/// `LANGUAGE_CODE`: each language code and English name, as the code it is sent as.
pub const LANGUAGE_CODES: [(&str, &str); 37] = [
    ("en", "en"),
    ("es", "es"),
    ("fr", "fr"),
    ("de", "de"),
    ("it", "it"),
    ("pt", "pt"),
    ("ja", "ja"),
    ("ko", "ko"),
    ("ru", "ru"),
    ("zhs", "zhs"),
    ("zht", "zht"),
    ("he", "he"),
    ("la", "la"),
    ("grc", "grc"),
    ("ar", "ar"),
    ("sa", "sa"),
    ("ph", "ph"),
    ("qya", "qya"),
    ("any", "any"),
    ("english", "en"),
    ("spanish", "es"),
    ("french", "fr"),
    ("german", "de"),
    ("italian", "it"),
    ("portuguese", "pt"),
    ("japanese", "ja"),
    ("korean", "ko"),
    ("russian", "ru"),
    ("simplifiedchinese", "zhs"),
    ("traditionalchinese", "zht"),
    ("hebrew", "he"),
    ("latin", "la"),
    ("ancientgreek", "grc"),
    ("arabic", "ar"),
    ("sanskrit", "sa"),
    ("phyrexian", "ph"),
    ("quenya", "qya"),
];

/// `RARITY_BY_WORD`: a rarity's word or letter, as its full word.
pub const RARITY_WORDS: [(&str, &str); 12] = [
    ("c", "common"),
    ("common", "common"),
    ("u", "uncommon"),
    ("uncommon", "uncommon"),
    ("r", "rare"),
    ("rare", "rare"),
    ("m", "mythic"),
    ("mythic", "mythic"),
    ("s", "special"),
    ("special", "special"),
    ("b", "bonus"),
    ("bonus", "bonus"),
];

/// `CROSS_FIELD`: the stats a number may be compared *with*, as the `@field` each is sent as.
pub const CROSS_FIELDS: [(&str, &str); 10] = [
    ("pow", "@power"),
    ("power", "@power"),
    ("tou", "@toughness"),
    ("tough", "@toughness"),
    ("toughness", "@toughness"),
    ("cmc", "@cmc"),
    ("mv", "@cmc"),
    ("manavalue", "@cmc"),
    ("loy", "@loyalty"),
    ("loyalty", "@loyalty"),
];

/// The four multicolour spellings `filters::color_value` matches before its name table —
/// `COLOR_NAMES`' first four entries.
pub const MULTICOLOR_NAMES: [&str; 4] = ["m", "multi", "multicolor", "multicolour"];

/// `COLOR_NAMES.has(key)`: a multicolour spelling, or a name in `filters`' own table (the page's
/// set is exactly those two lists, which `ipc.test.ts` holds).
fn is_color_name(key: &str) -> bool {
    MULTICOLOR_NAMES.contains(&key) || FILTER_COLOR_NAMES.iter().any(|(name, _)| *name == key)
}

/// Every colour name `c:` and `id:` take, multicolour spellings first — the golden's `colorNames`.
pub fn color_names() -> Vec<&'static str> {
    MULTICOLOR_NAMES
        .iter()
        .copied()
        .chain(FILTER_COLOR_NAMES.iter().map(|(name, _)| *name))
        .collect()
}

fn lookup(table: &[(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

// ---------------------------------------------------------------------------------------------
// JavaScript's character classes.
// ---------------------------------------------------------------------------------------------

/// `/\s/`: Rust's White_Space less U+0085 (NEL), plus U+FEFF (the BOM, which JavaScript counts).
pub fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `String.prototype.trim`, over [`js_space`].
fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// `/[\p{L}\p{N}]/u.test(s)`: a letter or a number, by general category.
fn indexable(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(
            c.general_category_group(),
            GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
        )
    })
}

/// `keywordKey`: lowercased with every character but an ASCII letter or digit dropped.
pub fn keyword_key(word: &str) -> String {
    word.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `NUMERIC`: `/^-?\d+(?:\.\d+)?$/`.
fn numeric(s: &str) -> bool {
    let s = s.strip_prefix('-').unwrap_or(s);
    match s.split_once('.') {
        Some((whole, frac)) => all_digits(whole) && all_digits(frac),
        None => all_digits(s),
    }
}

/// `COUNT`: `/^\d+$/`.
fn count(s: &str) -> bool {
    all_digits(s)
}

/// `PRICE`: `/^(?:\d+(?:\.\d+)?|\.\d+)$/`.
fn price(s: &str) -> bool {
    match s.split_once('.') {
        Some(("", frac)) => all_digits(frac),
        Some((whole, frac)) => all_digits(whole) && all_digits(frac),
        None => all_digits(s),
    }
}

fn wubrg(b: u8) -> bool {
    matches!(b.to_ascii_lowercase(), b'w' | b'u' | b'b' | b'r' | b'g')
}

/// `COLOR_LETTERS`: `/^[wubrgc]+$/i`.
fn color_letters(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| wubrg(b) || b.eq_ignore_ascii_case(&b'c'))
}

/// `MANA_COST`: `/^(?:\{[^{}\s]+\}|[0-9wubrgcxyzs])+$/i`.
fn mana_cost(s: &str) -> bool {
    let mut chars = s.chars();
    let mut any = false;
    while let Some(c) = chars.next() {
        any = true;
        if c == '{' {
            let mut inside = 0;
            loop {
                match chars.next() {
                    Some('}') if inside > 0 => break,
                    Some(c) if c != '{' && c != '}' && !js_space(c) => inside += 1,
                    _ => return false,
                }
            }
        } else if !(c.is_ascii_digit()
            || matches!(
                c.to_ascii_lowercase(),
                'w' | 'u' | 'b' | 'r' | 'g' | 'c' | 'x' | 'y' | 'z' | 's'
            ))
        {
            return false;
        }
    }
    any
}

/// `DEVOTION`: `/^(?:\{[wubrg](?:\/[wubrg])?\}|[wubrg])+$/i`.
fn devotion(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'{' {
            if i + 2 < b.len() && wubrg(b[i + 1]) && b[i + 2] == b'}' {
                i += 3;
            } else if i + 4 < b.len()
                && wubrg(b[i + 1])
                && b[i + 2] == b'/'
                && wubrg(b[i + 3])
                && b[i + 4] == b'}'
            {
                i += 5;
            } else {
                return false;
            }
        } else if wubrg(b[i]) {
            i += 1;
        } else {
            return false;
        }
    }
    !b.is_empty()
}

/// `DATE`: `/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/`.
fn date(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let sized = |p: &str, n: usize| p.len() == n && all_digits(p);
    match parts.as_slice() {
        [y] => sized(y, 4),
        [y, m] => sized(y, 4) && sized(m, 2),
        [y, m, d] => sized(y, 4) && sized(m, 2) && sized(d, 2),
        _ => false,
    }
}

/// `SET_CODE`: `/^[a-z0-9]{3,6}$/i`.
fn set_code(s: &str) -> bool {
    (3..=6).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// `YEAR`: `/^\d{4}$/`.
fn year(s: &str) -> bool {
    s.len() == 4 && all_digits(s)
}

/// The operator signs, longest first — `TERM`'s alternation `>=|<=|!=|:|=|>|<`.
const SIGNS: [(&str, PredicateOp); 7] = [
    (">=", Gte),
    ("<=", Lte),
    ("!=", Ne),
    (":", Colon),
    ("=", Eq),
    (">", Gt),
    ("<", Lt),
];

/// The sign a reader types for an operator.
pub fn sign_of(op: PredicateOp) -> &'static str {
    SIGNS
        .iter()
        .find(|(_, o)| *o == op)
        .map(|(sign, _)| *sign)
        .unwrap_or(":")
}

/// `[A-Za-z][A-Za-z0-9_-]*` then a sign: the keyword, the sign and what follows. The keyword is
/// the longest such run, and no shorter one could be followed by a sign, so this is the match.
fn keyword_and_sign(s: &str) -> Option<(&str, &'static str, &str)> {
    let b = s.as_bytes();
    if !b.first()?.is_ascii_alphabetic() {
        return None;
    }
    let mut k = 1;
    while k < b.len() && (b[k].is_ascii_alphanumeric() || b[k] == b'_' || b[k] == b'-') {
        k += 1;
    }
    let rest = &s[k..];
    SIGNS
        .iter()
        .find(|(sign, _)| rest.starts_with(sign))
        .map(|(sign, _)| (&s[..k], *sign, &rest[sign.len()..]))
}

/// `TERM`: `/^(-?)([A-Za-z][A-Za-z0-9_-]*)(>=|<=|!=|:|=|>|<)([\s\S]*)$/` — the dash, the keyword,
/// the sign and the raw value.
fn term_parts(chunk: &str) -> Option<(bool, &str, &'static str, &str)> {
    let (dash, rest) = match chunk.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, chunk),
    };
    keyword_and_sign(rest).map(|(keyword, sign, value)| (dash, keyword, sign, value))
}

/// `QUOTE_OPENS`: `/^-?(?:!|[A-Za-z][A-Za-z0-9_-]*(?:>=|<=|!=|:|=|>|<))?$/`, over what precedes the
/// quote in its chunk.
fn quote_opens(prefix: &str) -> bool {
    let p = prefix.strip_prefix('-').unwrap_or(prefix);
    p.is_empty() || p == "!" || keyword_and_sign(p).is_some_and(|(_, _, rest)| rest.is_empty())
}

// ---------------------------------------------------------------------------------------------
// Values.
// ---------------------------------------------------------------------------------------------

/// `isEquality`.
fn is_equality(op: PredicateOp) -> bool {
    matches!(op, Colon | Eq | Ne)
}

/// A Scryfall regular expression, `/…/` — refused by `predicateValue` for every field.
fn is_regex(raw: &str) -> bool {
    raw.len() > 1 && raw.starts_with('/') && raw.ends_with('/')
}

/// `predicateValue`: the value a field accepts, canonicalised, or `None` (the chunk is words).
fn predicate_value(field: PredicateField, raw: &str, op: PredicateOp) -> Option<String> {
    if raw.is_empty() || is_regex(raw) {
        return None;
    }
    let key = keyword_key(raw);
    match field {
        F::Cmc => {
            if key == "even" || key == "odd" {
                return is_equality(op).then_some(key);
            }
            numeric_value(raw)
        }
        F::Power | F::Toughness | F::Loyalty | F::PowTou => numeric_value(raw),
        F::Colors | F::ColorIdentity => {
            if is_color_name(&key) {
                Some(key)
            } else {
                (color_letters(raw) || count(raw)).then(|| raw.to_owned())
            }
        }
        F::ManaCost => mana_cost(raw).then(|| raw.to_owned()),
        F::Devotion => devotion(raw).then(|| raw.to_owned()),
        F::Produces => color_letters(raw).then(|| raw.to_owned()),
        F::Rarity => {
            let word = lookup(&RARITY_WORDS, &raw.to_lowercase())?;
            ((word != "special" && word != "bonus") || is_equality(op)).then(|| word.to_owned())
        }
        F::CollectorNumber => (is_equality(op) || numeric(raw)).then(|| raw.to_owned()),
        F::Year => year(raw).then(|| raw.to_owned()),
        F::Date => (date(raw) || set_code(raw)).then(|| raw.to_owned()),
        F::Usd | F::Eur | F::Tix => price(raw).then(|| raw.to_owned()),
        F::Prints | F::PaperPrints | F::Sets | F::PaperSets => count(raw).then(|| raw.to_owned()),
        F::Language => lookup(&LANGUAGE_CODES, &key).map(str::to_owned),
        F::Game | F::Border | F::Stamp | F::Has | F::NewFeature | F::Is | F::Frame => {
            vocabulary(field)
                .is_some_and(|words| words.contains(&key.as_str()))
                .then_some(key)
        }
        _ => Some(raw.to_owned()),
    }
}

/// `numericValue`: a star-able number, or another numeric column's name.
fn numeric_value(raw: &str) -> Option<String> {
    if raw == "*" || numeric(raw) {
        return Some(raw.to_owned());
    }
    lookup(&CROSS_FIELDS, &keyword_key(raw)).map(str::to_owned)
}

/// `unquote`: strip the quotes around a value, an unterminated opening one included.
fn unquote(value: &str) -> &str {
    let quote = match value.chars().next() {
        Some(q @ ('"' | '\'')) => q,
        _ => return value,
    };
    let rest = &value[1..];
    rest.strip_suffix(quote).unwrap_or(rest)
}

// ---------------------------------------------------------------------------------------------
// One chunk.
// ---------------------------------------------------------------------------------------------

/// `Classified`: a tag, a predicate, or free text.
#[derive(Debug, Clone)]
enum Classified {
    Tag {
        namespace: TagNamespace,
        value: String,
        negated: bool,
    },
    Predicate(QueryPredicate),
    Text,
}

/// Why a chunk read as it did — what [`read`] reports and [`classify`] throws away.
#[derive(Debug, Clone, Copy)]
enum Why {
    /// A term, a tag, or a name excluded: applied as written.
    Read,
    /// Free text with nothing that looks like a term: words, as meant.
    Words,
    /// `t:`, `cmc>=`, `otag:` — a keyword and a sign with nothing after them.
    NoValue,
    /// `!` or `!"` — an exact name with no name.
    NoName,
    /// `-`, `-"`, `--` — a dash with nothing to exclude.
    NothingToExclude,
    /// `unique:`, `order:`, `include:` — how Scryfall lays its results out.
    Display,
    /// `cube:vintage` — a keyword this vocabulary lacks, with a value.
    UnknownKeyword,
    /// `t>goblin` — a sign the keyword does not take.
    Operator(&'static KeywordSpec),
    /// `cmc>=banana` — a value the keyword does not take.
    Value(&'static KeywordSpec),
    /// `o:/^draw/`.
    Regex,
}

/// The row a keyword names, after [`keyword_key`] — `SPEC_BY_KEYWORD`.
fn spec_by_keyword(key: &str) -> Option<&'static KeywordSpec> {
    QUERY_KEYWORDS
        .iter()
        .find(|spec| spec.keywords.iter().any(|w| keyword_key(w) == key))
}

/// `classify`.
fn classify(chunk: &str) -> Option<Classified> {
    classify_why(chunk).0
}

/// `classify`, with the reason [`read`] reports. The first reason found is the one kept: a
/// negated unparseable term (`-cmc>=banana`) is still "cmc takes a number", even though the page
/// then reads it as a name to exclude.
fn classify_why(chunk: &str) -> (Option<Classified>, Why) {
    let exact = chunk
        .strip_prefix('-')
        .and_then(|rest| rest.strip_prefix('!').map(|v| (true, v)))
        .or_else(|| chunk.strip_prefix('!').map(|v| (false, v)));
    if let Some((negated, raw)) = exact {
        let value = js_trim(unquote(raw));
        if !indexable(value) {
            return (None, Why::NoName);
        }
        let predicate = QueryPredicate {
            field: F::Name,
            op: Eq,
            value: value.to_owned(),
            negated,
            terms: Vec::new(),
        };
        return (Some(Classified::Predicate(predicate)), Why::Read);
    }
    let Some((dash, keyword, sign, raw_value)) = term_parts(chunk) else {
        return excluded_name(chunk, Why::Words);
    };
    let key = keyword_key(keyword);
    let value = js_trim(unquote(raw_value));
    let display = DISPLAY_KEYWORDS.contains(&key.as_str());
    if display && (sign == ":" || sign == "=") {
        if key != "include" || value.is_empty() || value.to_lowercase() == "extras" {
            return (None, Why::Display);
        }
        return excluded_name(chunk, Why::Display);
    }
    let Some(spec) = spec_by_keyword(&key) else {
        let why = if display {
            Why::Display
        } else if value.is_empty() {
            Why::Words
        } else {
            Why::UnknownKeyword
        };
        return excluded_name(chunk, why);
    };
    let op = SIGNS
        .iter()
        .find(|(s, _)| *s == sign)
        .map(|(_, op)| *op)
        .unwrap_or(Colon);
    if !spec.ops.contains(&op) {
        return excluded_name(chunk, Why::Operator(spec));
    }
    if value.is_empty() {
        return (None, Why::NoValue);
    }
    // `not:x` is `-is:x`, so a dash on it cancels.
    let negated = dash != (key == "not");
    let field = match spec.target {
        Tag(namespace) => {
            let tag = Classified::Tag {
                namespace,
                value: value.to_owned(),
                negated,
            };
            return (Some(tag), Why::Read);
        }
        Field(field) => field,
    };
    let resolved = if sign == ":" { spec.default_op } else { op };
    let Some(canonical) = predicate_value(field, value, resolved) else {
        let why = if is_regex(value) {
            Why::Regex
        } else {
            Why::Value(spec)
        };
        return excluded_name(chunk, why);
    };
    let predicate = QueryPredicate {
        field,
        op: resolved,
        value: canonical,
        negated,
        terms: Vec::new(),
    };
    (Some(Classified::Predicate(predicate)), Why::Read)
}

/// `excludedName`: a chunk that is no term, read once more for a leading `-`. `why` is the reason
/// it is no term; a lone dash with nothing after it says so instead when there is no other.
fn excluded_name(chunk: &str, why: Why) -> (Option<Classified>, Why) {
    let Some(rest) = chunk.strip_prefix('-') else {
        return (Some(Classified::Text), why);
    };
    match negated_text(rest) {
        Some(name) => (
            Some(name),
            if matches!(why, Why::Words) {
                Why::Read
            } else {
                why
            },
        ),
        None => (
            None,
            if matches!(why, Why::Words) {
                Why::NothingToExclude
            } else {
                why
            },
        ),
    }
}

/// `negatedText`: free text under a negation — a name exclusion, or `None` with no word in it.
fn negated_text(text: &str) -> Option<Classified> {
    let value = js_trim(unquote(text));
    if !indexable(value) {
        return None;
    }
    Some(Classified::Predicate(QueryPredicate {
        field: F::Name,
        op: Colon,
        value: value.to_owned(),
        negated: true,
        terms: Vec::new(),
    }))
}

// ---------------------------------------------------------------------------------------------
// The lexer.
// ---------------------------------------------------------------------------------------------

/// `Lexeme`, with byte spans.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Lexeme {
    Chunk {
        start: usize,
        end: usize,
    },
    Open {
        negated: bool,
        start: usize,
        end: usize,
    },
    Close {
        start: usize,
        end: usize,
    },
    Or {
        start: usize,
        end: usize,
    },
    And {
        start: usize,
        end: usize,
    },
}

impl Lexeme {
    fn end(self) -> usize {
        match self {
            Lexeme::Chunk { end, .. }
            | Lexeme::Open { end, .. }
            | Lexeme::Close { end, .. }
            | Lexeme::Or { end, .. }
            | Lexeme::And { end, .. } => end,
        }
    }

    fn start(self) -> usize {
        match self {
            Lexeme::Chunk { start, .. }
            | Lexeme::Open { start, .. }
            | Lexeme::Close { start, .. }
            | Lexeme::Or { start, .. }
            | Lexeme::And { start, .. } => start,
        }
    }
}

/// What the lexer saw that the lexemes do not say — what [`read`] reports about the shape.
#[derive(Debug, Default)]
struct Shape {
    /// A quote that ran to the end of the box: the span of its chunk.
    unclosed_quote: Option<(usize, usize)>,
    /// Chunks whose last `)` closes nothing.
    stray_closes: Vec<(usize, usize)>,
    /// Groups never closed.
    unclosed: usize,
}

fn char_at(s: &str, i: usize) -> Option<char> {
    s.get(i..).and_then(|rest| rest.chars().next())
}

/// `closesQuote`: a `"` always closes; a `'` only at the end of a word.
fn closes_quote(input: &str, i: usize) -> bool {
    let b = input.as_bytes();
    if b[i] == b'"' {
        return true;
    }
    let mut next = i + 1;
    while b.get(next) == Some(&b')') {
        next += 1;
    }
    char_at(input, next).is_none_or(js_space)
}

/// `lex`.
fn lex(input: &str) -> Vec<Lexeme> {
    lex_shape(input).0
}

/// `lex`, and what [`Shape`] records on the way.
fn lex_shape(input: &str) -> (Vec<Lexeme>, Shape) {
    let mut out = Vec::new();
    let mut shape = Shape::default();
    let mut depth = 0usize;
    let mut i = 0;
    let n = input.len();
    while i < n {
        let ch = char_at(input, i).expect("i is a char boundary below the end");
        if js_space(ch) {
            i += ch.len_utf8();
            continue;
        }
        loop {
            let at = char_at(input, i);
            let negated = at == Some('-') && char_at(input, i + 1) == Some('(');
            if at != Some('(') && !negated {
                break;
            }
            let start = i;
            i += if negated { 2 } else { 1 };
            out.push(Lexeme::Open {
                negated,
                start,
                end: i,
            });
            depth += 1;
        }
        let start = i;
        let mut quote: Option<char> = None;
        let mut after_quote = start;
        while i < n {
            let ch = char_at(input, i).expect("i is a char boundary below the end");
            if let Some(q) = quote {
                if ch == q && closes_quote(input, i) {
                    quote = None;
                    after_quote = i + 1;
                }
            } else if (ch == '"' || ch == '\'') && quote_opens(&input[start..i]) {
                quote = Some(ch);
            } else if js_space(ch) {
                break;
            }
            i += ch.len_utf8();
        }
        let mut end = i;
        let mut closes = Vec::new();
        if quote.is_none() {
            while depth > 0 && end > after_quote && input.as_bytes()[end - 1] == b')' {
                end -= 1;
                depth -= 1;
                closes.push(Lexeme::Close {
                    start: end,
                    end: end + 1,
                });
            }
            if end > after_quote && input.as_bytes()[end - 1] == b')' {
                shape.stray_closes.push((start, end));
            }
        } else {
            shape.unclosed_quote = Some((start, end));
        }
        closes.reverse();
        if end > start {
            let text = &input[start..end];
            out.push(if text.eq_ignore_ascii_case("or") {
                Lexeme::Or { start, end }
            } else if text.eq_ignore_ascii_case("and") {
                Lexeme::And { start, end }
            } else {
                Lexeme::Chunk { start, end }
            });
        }
        out.extend(closes);
    }
    shape.unclosed = depth;
    (out, shape)
}

// ---------------------------------------------------------------------------------------------
// The tree.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
enum Connective {
    And,
    Or,
}

/// `Node`. A term keeps its chunk's text apart from its span, because a lone child of a
/// parenthesised group takes the group's span and keeps its own text.
#[derive(Debug, Clone)]
enum Node<'a> {
    Term {
        text: &'a str,
        start: usize,
        end: usize,
        flip: bool,
    },
    Group {
        op: Connective,
        negated: bool,
        parens: bool,
        start: usize,
        end: usize,
        children: Vec<Node<'a>>,
    },
}

impl Node<'_> {
    fn start(&self) -> usize {
        match self {
            Node::Term { start, .. } | Node::Group { start, .. } => *start,
        }
    }

    fn end(&self) -> usize {
        match self {
            Node::Term { end, .. } | Node::Group { end, .. } => *end,
        }
    }
}

/// `parseSequence`: lexemes from `at` up to the `)` that closes `open` (or the end), as one group,
/// AND tighter than OR.
fn parse_sequence<'a>(
    input: &'a str,
    lexemes: &[Lexeme],
    at: &mut usize,
    open: Option<Lexeme>,
) -> Node<'a> {
    let mut branches: Vec<Vec<Node<'a>>> = Vec::new();
    let mut current: Vec<Node<'a>> = Vec::new();
    let mut end = open.map(Lexeme::end).unwrap_or(0);
    while *at < lexemes.len() {
        let lexeme = lexemes[*at];
        *at += 1;
        end = lexeme.end();
        match lexeme {
            Lexeme::Close { .. } => break,
            Lexeme::And { .. } => continue,
            Lexeme::Or { .. } => {
                if !current.is_empty() {
                    branches.push(std::mem::take(&mut current));
                }
            }
            Lexeme::Open { .. } => {
                let group = parse_sequence(input, lexemes, at, Some(lexeme));
                end = group.end();
                current.push(group);
            }
            Lexeme::Chunk { start, end } => current.push(Node::Term {
                text: &input[start..end],
                start,
                end,
                flip: false,
            }),
        }
    }
    if !current.is_empty() {
        branches.push(current);
    }
    let and_of = |mut nodes: Vec<Node<'a>>| -> Node<'a> {
        if nodes.len() == 1 {
            return nodes.remove(0);
        }
        Node::Group {
            op: Connective::And,
            negated: false,
            parens: false,
            start: nodes[0].start(),
            end: nodes[nodes.len() - 1].end(),
            children: nodes,
        }
    };
    let or = branches.len() > 1;
    let children: Vec<Node<'a>> = if or {
        branches.into_iter().map(and_of).collect()
    } else {
        branches.pop().unwrap_or_default()
    };
    let first = children.first().map(Node::start);
    let last = children.last().map(Node::end);
    let negated = matches!(open, Some(Lexeme::Open { negated: true, .. }));
    Node::Group {
        op: if or { Connective::Or } else { Connective::And },
        negated,
        parens: open.is_some(),
        start: open.map(Lexeme::start).or(first).unwrap_or(0),
        end: if open.is_some() {
            end
        } else {
            last.unwrap_or(0)
        },
        children,
    }
}

/// `simplify`: drop what says nothing, fold what is redundant.
fn simplify(node: Node<'_>) -> Option<Node<'_>> {
    let (op, negated, parens, start, end, kids) = match node {
        Node::Term { text, .. } => return classify(text).map(|_| node),
        Node::Group {
            op,
            negated,
            parens,
            start,
            end,
            children,
        } => (op, negated, parens, start, end, children),
    };
    let mut children = Vec::new();
    for child in kids {
        let Some(kept) = simplify(child) else {
            continue;
        };
        match kept {
            Node::Group {
                op: child_op,
                negated: false,
                children: grand,
                ..
            } if child_op == op => children.extend(grand),
            kept => children.push(kept),
        }
    }
    if children.is_empty() {
        return None;
    }
    if children.len() > 1 {
        return Some(Node::Group {
            op,
            negated,
            parens,
            start,
            end,
            children,
        });
    }
    let only = children.remove(0);
    let span = |own_start: usize, own_end: usize| {
        if parens {
            (start, end)
        } else {
            (own_start, own_end)
        }
    };
    Some(match only {
        Node::Term {
            text,
            start: s,
            end: e,
            flip,
        } => {
            let (start, end) = span(s, e);
            Node::Term {
                text,
                start,
                end,
                flip: flip != negated,
            }
        }
        Node::Group {
            op: o,
            negated: n,
            parens: p,
            start: s,
            end: e,
            children: c,
        } => {
            let (start, end) = span(s, e);
            Node::Group {
                op: o,
                negated: n != negated,
                parens: p,
                start,
                end,
                children: c,
            }
        }
    })
}

/// `resolveTerm`: a term's reading with any inherited negation applied.
fn resolve_term(text: &str, flip: bool) -> Option<Classified> {
    let read = classify(text)?;
    if !flip {
        return Some(read);
    }
    Some(match read {
        Classified::Text => return negated_text(text),
        Classified::Tag {
            namespace,
            value,
            negated,
        } => Classified::Tag {
            namespace,
            value,
            negated: !negated,
        },
        Classified::Predicate(mut p) => {
            p.negated = !p.negated;
            Classified::Predicate(p)
        }
    })
}

/// `termOf`: a node inside a group, as the term of the `anyOf`/`allOf` it travels as.
fn term_of(node: &Node<'_>) -> Option<QueryPredicate> {
    let (text, flip) = match node {
        Node::Group { .. } => return group_of(node),
        Node::Term { text, flip, .. } => (*text, *flip),
    };
    Some(match resolve_term(text, flip)? {
        Classified::Predicate(p) => p,
        Classified::Tag {
            namespace,
            value,
            negated,
        } => QueryPredicate {
            field: match namespace {
                TagNamespace::Oracle => F::OracleTag,
                TagNamespace::Art => F::ArtTag,
            },
            op: Colon,
            value,
            negated,
            terms: Vec::new(),
        },
        Classified::Text => QueryPredicate {
            field: F::Text,
            op: Colon,
            value: text.to_owned(),
            negated: false,
            terms: Vec::new(),
        },
    })
}

/// `groupOf`: a group as one predicate.
fn group_of(node: &Node<'_>) -> Option<QueryPredicate> {
    let Node::Group {
        op,
        negated,
        children,
        ..
    } = node
    else {
        return None;
    };
    let mut terms: Vec<QueryPredicate> = children.iter().filter_map(term_of).collect();
    if terms.is_empty() {
        return None;
    }
    if terms.len() == 1 {
        let mut only = terms.remove(0);
        only.negated = only.negated != *negated;
        return Some(only);
    }
    Some(QueryPredicate {
        field: match op {
            Connective::Or => F::AnyOf,
            Connective::And => F::AllOf,
        },
        op: Colon,
        value: String::new(),
        negated: *negated,
        terms,
    })
}

/// **`parseQuery`**: split a query into free text, tag tokens and predicates, exactly as the page
/// does — for any input, however broken (see [`read`] for the tools' stricter door).
///
/// Recursive on parentheses, as the page's is: a caller that takes queries from outside bounds
/// their nesting first, which [`read`] does.
pub fn parse_query(input: &str) -> ParsedQuery {
    let lexemes = lex(input);
    let mut at = 0;
    let root = simplify(parse_sequence(input, &lexemes, &mut at, None));
    let items: Vec<Node<'_>> = match root {
        None => Vec::new(),
        Some(Node::Group {
            op: Connective::And,
            negated: false,
            children,
            ..
        }) => children,
        Some(root) => vec![root],
    };
    let mut words: Vec<&str> = Vec::new();
    let mut tags = Vec::new();
    let mut predicates = Vec::new();
    for item in &items {
        let (start, end) = (item.start(), item.end());
        let (text, flip) = match item {
            Node::Group { .. } => {
                if let Some(predicate) = group_of(item) {
                    predicates.push(PredicateToken {
                        predicate,
                        start,
                        end,
                    });
                }
                continue;
            }
            Node::Term { text, flip, .. } => (*text, *flip),
        };
        match resolve_term(text, flip) {
            None => {}
            Some(Classified::Text) => words.push(text),
            Some(Classified::Tag {
                namespace,
                value,
                negated,
            }) => tags.push(TagToken {
                namespace,
                value,
                negated,
                start,
                end,
            }),
            Some(Classified::Predicate(predicate)) => predicates.push(PredicateToken {
                predicate,
                start,
                end,
            }),
        }
    }
    ParsedQuery {
        text: words.join(" "),
        tags,
        predicates,
    }
}

// ---------------------------------------------------------------------------------------------
// The tools' door.
// ---------------------------------------------------------------------------------------------

/// The longest query [`read`] takes, in characters.
pub const MAX_SYNTAX_CHARS: usize = 2000;

/// How deep [`read`] lets groups nest. [`parse_query`] recurses once a level, and a request body
/// of a mebibyte could hold half a million `(`.
pub const MAX_DEPTH: usize = 16;

/// One thing in a query the tools would not apply as written: the term as typed and one
/// sentence saying what is wrong and what to write instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unread {
    pub term: String,
    pub sentence: String,
}

/// What a keyword takes, for a refusal — one phrase per field.
pub fn takes(field: PredicateField) -> String {
    let words = |list: &[&str]| -> String {
        let quoted: Vec<String> = list.iter().map(|w| format!("`{w}`")).collect();
        match quoted.split_last() {
            Some((last, [])) => last.clone(),
            Some((last, rest)) => format!("{} or {last}", rest.join(", ")),
            None => String::new(),
        }
    };
    let stats = "another stat to compare with (`pow`, `tou`, `cmc`, `loy`)";
    match field {
        F::Cmc => {
            format!("a number (`3`, `2.5`), `even` or `odd` (with `:`, `=` or `!=`), or {stats}")
        }
        F::Power | F::Toughness | F::Loyalty | F::PowTou => {
            format!("a number, `*`, or {stats}")
        }
        F::Colors | F::ColorIdentity => concat!(
            "colour letters (`wubrg`, `c` for colourless), a colour, guild, college, shard or ",
            "wedge name (`red`, `azorius`, `esper`), `m` for multicolour, or a number of colours"
        )
        .to_owned(),
        F::ManaCost => "mana symbols, braced (`{2}{G}{U}`, `{W/U}`) or bare (`2gu`)".to_owned(),
        F::Devotion => {
            "one colour's symbols (`uuu`, `{U}{U}{U}`) or a hybrid pair (`{U/B}`)".to_owned()
        }
        F::Produces => "colour letters (`wubrg`, `c` for colourless)".to_owned(),
        F::Rarity => concat!(
            "`common`, `uncommon`, `rare` or `mythic` (or their first letter); `special` and ",
            "`bonus` only with `:`, `=` or `!=`"
        )
        .to_owned(),
        F::CollectorNumber => {
            "a collector number, and with `>`, `<` and the like only a number".to_owned()
        }
        F::Year => "a four-digit year".to_owned(),
        F::Date => "a date (`2020`, `2020-01`, `2020-01-01`) or a set code".to_owned(),
        F::Usd | F::Eur | F::Tix => "a price (`1`, `0.5`, `.5`)".to_owned(),
        F::Prints | F::PaperPrints | F::Sets | F::PaperSets => "a whole number".to_owned(),
        F::Language => {
            "a language code (`en`, `ja`, `zhs`…) or its English name (`japanese`), or `any`"
                .to_owned()
        }
        F::Is => {
            "one of Scryfall's `is:` properties (`commander`, `fetchland`, `reprint`…)".to_owned()
        }
        F::Game | F::Border | F::Stamp | F::Has | F::NewFeature | F::Frame => {
            words(vocabulary(field).unwrap_or(&[]))
        }
        _ => "any word".to_owned(),
    }
}

/// The signs a row takes, as a phrase: "`:` or `=`", "only `:`".
fn signs_phrase(ops: &[PredicateOp]) -> String {
    let signs: Vec<String> = ops.iter().map(|op| format!("`{}`", sign_of(*op))).collect();
    match signs.split_last() {
        Some((last, [])) => format!("only {last}"),
        Some((last, rest)) => format!("{} or {last}", rest.join(", ")),
        None => String::new(),
    }
}

const QUOTE_IT: &str = "To search for the words instead, put the whole term in quotes.";

/// The sentence for a chunk's reason, or `None` when it reads as written.
fn chunk_sentence(chunk: &str, why: Why) -> Option<String> {
    let keyword = || {
        term_parts(chunk)
            .map(|(_, keyword, _, _)| keyword.to_owned())
            .unwrap_or_default()
    };
    Some(match why {
        Why::Read | Why::Words => return None,
        Why::NoValue => format!("`{chunk}` has no value after it."),
        Why::NoName => format!("`{chunk}` names no card: `!` takes an exact name, e.g. `!\"lightning bolt\"`."),
        Why::NothingToExclude => format!("`{chunk}` has nothing after it to leave out."),
        Why::Display => format!(
            "`{chunk}` is about how Scryfall shows its results, not which cards match, and is not taken here; leave it out."
        ),
        Why::UnknownKeyword => format!(
            "`{chunk}`: `{}` is not a keyword this app reads. {QUOTE_IT}",
            keyword()
        ),
        Why::Operator(spec) => format!(
            "`{chunk}`: `{}` takes {}.",
            keyword(),
            signs_phrase(spec.ops)
        ),
        Why::Value(spec) => {
            let Field(field) = spec.target else {
                return None;
            };
            format!("`{chunk}`: `{}` takes {}. {QUOTE_IT}", keyword(), takes(field))
        }
        Why::Regex => format!("`{chunk}`: regular expressions are not supported. {QUOTE_IT}"),
    })
}

/// The fields whose value is searched as words (the full-text index, or a substring): a value
/// with no letter or number in it searches for nothing, so the page's search matches everything
/// or nothing depending on where it stands.
fn searched_as_words(field: PredicateField) -> bool {
    matches!(
        field,
        F::Name | F::TypeLine | F::OracleText | F::Flavor | F::Artist | F::Watermark | F::Keyword
    )
}

/// A chunk the page reads as written but with no word to search for — free text such as `+++`,
/// or `t:` with only punctuation after it. The page lets one stand, because the box is on its way
/// to a word; for an agent it is a search for nothing.
fn no_word(chunk: &str, read: Option<Classified>) -> Option<String> {
    let empty = match read? {
        Classified::Text => !indexable(chunk),
        Classified::Predicate(p) => searched_as_words(p.field) && !indexable(&p.value),
        Classified::Tag { .. } => false,
    };
    empty.then(|| format!("`{chunk}` holds no word to search for."))
}

/// **The tools' entry point**: the query parsed, or every term in it the tools would not apply as
/// written ([`Unread`]), in source order. An `Ok` is [`parse_query`]'s answer for the same input.
///
/// The bounds come first, from a scan that does not recurse; then each chunk's reason from the
/// parser's own classifier, and a term with no word in it to search for; then the shape: a
/// dangling `or` or `and`, a group that holds nothing, a `(` never closed, a `)` that closes
/// nothing, a quote never closed. Free text with a word in it is never refused, and an unknown
/// keyword only when it has a value, so `Circle of Protection: Red` stays a name.
pub fn read(input: &str) -> Result<ParsedQuery, Vec<Unread>> {
    let chars = input.chars().count();
    if chars > MAX_SYNTAX_CHARS {
        return Err(vec![Unread {
            term: String::new(),
            sentence: format!(
                "A search is at most {MAX_SYNTAX_CHARS} characters; this one is {chars}."
            ),
        }]);
    }
    let (lexemes, shape) = lex_shape(input);
    let mut depth = 0usize;
    let mut deepest = 0usize;
    for lexeme in &lexemes {
        match lexeme {
            Lexeme::Open { .. } => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            Lexeme::Close { .. } => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    if deepest > MAX_DEPTH {
        return Err(vec![Unread {
            term: String::new(),
            sentence: format!("Groups nest at most {MAX_DEPTH} deep; this search nests {deepest}."),
        }]);
    }
    let mut unread: Vec<(usize, Unread)> = Vec::new();
    let mut note = |at: usize, term: &str, sentence: String| {
        let entry = Unread {
            term: term.to_owned(),
            sentence,
        };
        if !unread.iter().any(|(_, u)| *u == entry) {
            unread.push((at, entry));
        }
    };
    // Each level of grouping: whether it holds anything yet, and whether the last thing in it was
    // a connective (the one to blame if nothing follows).
    struct Level {
        held: bool,
        open: Option<(usize, usize)>,
        dangling: Option<(usize, usize)>,
    }
    let mut levels = vec![Level {
        held: false,
        open: None,
        dangling: None,
    }];
    let dangle = |at: (usize, usize)| {
        let word = &input[at.0..at.1];
        format!("`{word}` needs a term on each side.")
    };
    for lexeme in &lexemes {
        match *lexeme {
            Lexeme::Chunk { start, end } => {
                let chunk = &input[start..end];
                let (read, why) = classify_why(chunk);
                if let Some(sentence) = chunk_sentence(chunk, why).or_else(|| no_word(chunk, read))
                {
                    note(start, chunk, sentence);
                }
                let level = levels.last_mut().expect("the root level is never popped");
                level.held = true;
                level.dangling = None;
            }
            Lexeme::Or { start, end } | Lexeme::And { start, end } => {
                let level = levels.last_mut().expect("the root level is never popped");
                if !level.held || level.dangling.is_some() {
                    note(start, &input[start..end], dangle((start, end)));
                }
                level.dangling = Some((start, end));
            }
            Lexeme::Open { start, end, .. } => {
                let level = levels.last_mut().expect("the root level is never popped");
                level.held = true;
                level.dangling = None;
                levels.push(Level {
                    held: false,
                    open: Some((start, end)),
                    dangling: None,
                });
            }
            Lexeme::Close { end, .. } => {
                let level = levels.pop().expect("a close has an open level");
                if let Some(at) = level.dangling {
                    note(at.0, &input[at.0..at.1], dangle(at));
                }
                if !level.held {
                    let (start, _) = level.open.expect("a closed level was opened");
                    let group = &input[start..end];
                    note(start, group, format!("`{group}` holds nothing."));
                }
            }
        }
    }
    for level in levels.iter().rev() {
        if let Some(at) = level.dangling {
            note(at.0, &input[at.0..at.1], dangle(at));
        }
    }
    if shape.unclosed > 0 {
        let start = levels
            .iter()
            .find_map(|l| l.open)
            .map(|(s, _)| s)
            .unwrap_or(0);
        note(start, "(", "A `(` is never closed.".to_owned());
    }
    for (start, end) in shape.stray_closes {
        let chunk = &input[start..end];
        note(start, chunk, format!("`{chunk}`: its `)` closes no `(`."));
    }
    if let Some((start, end)) = shape.unclosed_quote {
        let chunk = &input[start..end];
        note(
            start,
            chunk,
            format!("`{chunk}` opens a quote that is never closed."),
        );
    }
    if unread.is_empty() {
        return Ok(parse_query(input));
    }
    unread.sort_by_key(|(at, _)| *at);
    Err(unread.into_iter().map(|(_, u)| u).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// The golden the TypeScript writes (`queryLanguage.golden.test.ts`).
    const GOLDEN: &str =
        include_str!("../../../packages/ui/features/search/__golden__/query-language.json");

    fn golden() -> Value {
        serde_json::from_str(GOLDEN).expect("the golden is JSON")
    }

    /// A byte offset into `input` as JavaScript counts it, in UTF-16 code units.
    fn utf16(input: &str, byte: usize) -> usize {
        input[..byte].encode_utf16().count()
    }

    /// A parse as the golden spells it: spans in UTF-16.
    fn as_page(input: &str, parsed: &ParsedQuery) -> Value {
        let mut value = serde_json::to_value(parsed).expect("a parse serialises");
        for list in ["tags", "predicates"] {
            for item in value[list].as_array_mut().expect("a list") {
                for key in ["start", "end"] {
                    let byte = item[key].as_u64().expect("a span") as usize;
                    item[key] = json!(utf16(input, byte));
                }
            }
        }
        value
    }

    fn sorted(list: &Value) -> Vec<String> {
        let mut words: Vec<String> = list
            .as_array()
            .expect("a list")
            .iter()
            .map(|w| w.as_str().expect("a word").to_owned())
            .collect();
        words.sort();
        words
    }

    fn sorted_strs(list: &[&str]) -> Vec<String> {
        let mut words: Vec<String> = list.iter().map(|w| (*w).to_owned()).collect();
        words.sort();
        words
    }

    fn object(pairs: &[(&str, &str)]) -> Value {
        Value::Object(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), json!(v)))
                .collect(),
        )
    }

    #[test]
    fn the_keyword_table_is_the_page_s_row_for_row() {
        let golden = golden();
        let rows: Vec<Value> = QUERY_KEYWORDS
            .iter()
            .map(|spec| {
                json!({
                    "target": match spec.target {
                        Field(field) => serde_json::to_value(field).unwrap(),
                        Tag(namespace) => json!({ "tag": namespace }),
                    },
                    "keywords": spec.keywords,
                    "defaultOp": spec.default_op,
                    "ops": spec.ops,
                    "example": spec.example,
                    "blurb": spec.blurb,
                    "section": spec.section,
                })
            })
            .collect();
        let theirs = golden["tables"]["keywords"].as_array().expect("keywords");
        assert_eq!(
            rows.len(),
            theirs.len(),
            "the tables have different lengths"
        );
        for (ours, theirs) in rows.iter().zip(theirs) {
            assert_eq!(ours, theirs);
        }
        for spec in &QUERY_KEYWORDS {
            assert!(QUERY_SECTIONS.contains(&spec.section), "{}", spec.example);
        }
    }

    #[test]
    fn the_vocabularies_are_the_page_s() {
        let tables = &golden()["tables"];
        assert_eq!(
            sorted(&tables["displayKeywords"]),
            sorted_strs(&DISPLAY_KEYWORDS)
        );
        let theirs = tables["vocabulary"].as_object().expect("vocabulary");
        assert_eq!(theirs.len(), 7, "a vocabulary was added on one side");
        for (name, words) in theirs {
            let field: PredicateField =
                serde_json::from_value(json!(name)).expect("a vocabulary is a field's");
            let ours = vocabulary(field).unwrap_or_else(|| panic!("no vocabulary for {name}"));
            assert_eq!(sorted(words), sorted_strs(ours), "{name}");
        }
        assert_eq!(tables["languageCodes"], object(&LANGUAGE_CODES));
        assert_eq!(tables["rarityWords"], object(&RARITY_WORDS));
        assert_eq!(tables["crossFields"], object(&CROSS_FIELDS));
        assert_eq!(sorted(&tables["colorNames"]), sorted_strs(&color_names()));
    }

    fn hold(cases: &Value, what: &str) -> usize {
        let mut failures = Vec::new();
        let cases = cases.as_array().expect("cases");
        for case in cases {
            let query = case["query"].as_str().expect("a query");
            let ours = as_page(query, &parse_query(query));
            if ours != case["parsed"] {
                failures.push(format!(
                    "{} {query:?}\n  page: {}\n  port: {ours}",
                    case.get("name").and_then(Value::as_str).unwrap_or(what),
                    case["parsed"]
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {} {what} parse differently:\n{}",
            failures.len(),
            cases.len(),
            failures.join("\n")
        );
        cases.len()
    }

    #[test]
    fn every_chosen_query_parses_as_the_page_parses_it() {
        let read = hold(&golden()["cases"], "chosen queries");
        assert!(read >= 250, "the golden's cases were read ({read})");
    }

    #[test]
    fn every_random_query_parses_as_the_page_parses_it() {
        let read = hold(&golden()["random"]["cases"], "random queries");
        assert_eq!(read, 500);
    }

    #[test]
    fn javascript_s_whitespace_is_not_rust_s() {
        assert!(js_space('\u{feff}') && !'\u{feff}'.is_whitespace());
        assert!(!js_space('\u{85}') && '\u{85}'.is_whitespace());
        for c in [' ', '\t', '\n', '\u{a0}', '\u{3000}', '\u{2028}'] {
            assert!(js_space(c), "{c:?}");
        }
    }

    #[test]
    fn a_word_is_a_letter_or_a_number_not_an_alphabetic_mark() {
        assert!(indexable("bolt") && indexable("٣") && indexable("Ⅻ") && indexable("稲"));
        assert!('Ⓐ'.is_alphanumeric() && !indexable("Ⓐ"));
        assert!(!indexable("\u{301}") && !indexable("!!") && !indexable(""));
    }

    #[test]
    fn a_predicate_serialises_as_the_wire_carries_it_and_reads_back() {
        let parsed = parse_query("(t:goblin or t:elf) cmc>=3");
        let wire = serde_json::to_value(&parsed.predicates[1].predicate).unwrap();
        assert_eq!(
            wire,
            json!({ "field": "cmc", "op": "gte", "value": "3", "negated": false })
        );
        for token in &parsed.predicates {
            let wire = serde_json::to_value(&token.predicate).unwrap();
            let back: QueryPredicate = serde_json::from_value(wire).unwrap();
            assert_eq!(back, token.predicate);
        }
        assert_eq!(parsed.predicates[0].predicate.terms.len(), 2);
    }

    fn refused(input: &str) -> Vec<String> {
        match read(input) {
            Ok(parsed) => panic!("{input:?} was read: {parsed:?}"),
            Err(unread) => unread.into_iter().map(|u| u.sentence).collect(),
        }
    }

    #[test]
    fn read_answers_the_parse_for_a_query_it_can_apply() {
        for input in [
            "t:goblin cmc<=2 -is:token",
            "(o:draw or o:scry) id<=ur",
            "bolt t:instant",
            "!\"lightning bolt\"",
            "-(t:goblin t:creature) otag:ramp",
            "Circle of Protection: Red",
            "o:'can't block' sensei's -t:artifact",
            "t:goblin or t:elf",
            "",
        ] {
            assert_eq!(read(input), Ok(parse_query(input)), "{input:?}");
        }
    }

    #[test]
    fn a_value_the_keyword_does_not_take_is_refused_with_what_it_takes() {
        assert_eq!(
            refused("cmc>=banana"),
            [format!(
                "`cmc>=banana`: `cmc` takes {}. {QUOTE_IT}",
                takes(F::Cmc)
            )]
        );
        assert!(refused("is:fetchlnad")[0].contains("`is` takes one of Scryfall's `is:`"));
        assert!(refused("-c:rgx")[0].starts_with("`-c:rgx`: `c` takes colour letters"));
        assert!(refused("r>special")[0].contains("`special` and `bonus` only with"));
        assert!(refused("game:xbox")[0].contains("`paper`, `arena` or `mtgo`"));
    }

    #[test]
    fn a_sign_the_keyword_does_not_take_is_refused_with_the_ones_it_does() {
        assert_eq!(refused("t>goblin"), ["`t>goblin`: `t` takes `:` or `=`."]);
        assert_eq!(
            refused("is=commander"),
            ["`is=commander`: `is` takes only `:`."]
        );
    }

    #[test]
    fn an_unknown_keyword_is_refused_only_with_a_value() {
        assert_eq!(
            refused("cube:vintage"),
            [format!(
                "`cube:vintage`: `cube` is not a keyword this app reads. {QUOTE_IT}"
            )]
        );
        assert!(read("Protection: red").is_ok());
        assert!(read("\"cube:vintage\"").is_ok());
    }

    #[test]
    fn a_regular_expression_is_refused() {
        assert_eq!(
            refused("o:/^draw/"),
            [format!(
                "`o:/^draw/`: regular expressions are not supported. {QUOTE_IT}"
            )]
        );
    }

    #[test]
    fn a_keyword_with_nothing_after_it_is_refused() {
        assert_eq!(refused("t: bolt"), ["`t:` has no value after it."]);
        assert_eq!(refused("cmc>="), ["`cmc>=` has no value after it."]);
        assert_eq!(refused("otag:"), ["`otag:` has no value after it."]);
        assert!(refused("!")[0].starts_with("`!` names no card"));
        assert_eq!(
            refused("bolt -"),
            ["`-` has nothing after it to leave out."]
        );
    }

    #[test]
    fn a_display_keyword_is_refused() {
        for input in [
            "unique:prints",
            "order:usd",
            "include:extras",
            "direction:asc",
        ] {
            assert!(
                refused(input)[0].contains("is about how Scryfall shows its results"),
                "{input}"
            );
        }
    }

    #[test]
    fn a_dangling_connective_is_refused_once() {
        assert_eq!(refused("t:goblin or"), ["`or` needs a term on each side."]);
        assert_eq!(refused("or t:goblin"), ["`or` needs a term on each side."]);
        assert_eq!(
            refused("t:goblin or or t:elf"),
            ["`or` needs a term on each side."]
        );
        assert_eq!(refused("and t:elf"), ["`and` needs a term on each side."]);
        assert_eq!(
            refused("(t:goblin or)"),
            ["`or` needs a term on each side."]
        );
    }

    #[test]
    fn an_unbalanced_or_empty_group_is_refused() {
        assert_eq!(refused("(t:goblin"), ["A `(` is never closed."]);
        assert_eq!(refused("bolt)"), ["`bolt)`: its `)` closes no `(`."]);
        assert_eq!(refused("(a))"), ["`a)`: its `)` closes no `(`."]);
        assert_eq!(refused("t:goblin ()"), ["`()` holds nothing."]);
        assert_eq!(refused("-()"), ["`-()` holds nothing."]);
        assert!(read("o:\"(this ability)\"").is_ok());
    }

    #[test]
    fn a_term_with_no_word_in_it_is_refused() {
        assert_eq!(
            refused("t:goblin +++"),
            ["`+++` holds no word to search for."]
        );
        assert_eq!(refused("t:'--'"), ["`t:'--'` holds no word to search for."]);
        assert_eq!(
            refused("(+++ or t:elf)"),
            ["`+++` holds no word to search for."]
        );
        // A word in any script is a word, and a value that is not searched as words is not asked.
        assert!(read("-Молния o:稲妻 pow:*").is_ok());
    }

    #[test]
    fn an_unclosed_quote_is_refused() {
        assert_eq!(
            refused("o:\"draw a"),
            ["`o:\"draw a` opens a quote that is never closed."]
        );
    }

    #[test]
    fn every_problem_is_named_at_once_in_source_order() {
        assert_eq!(
            refused("cmc>=banana t: or"),
            [
                format!("`cmc>=banana`: `cmc` takes {}. {QUOTE_IT}", takes(F::Cmc)),
                "`t:` has no value after it.".to_owned(),
                "`or` needs a term on each side.".to_owned(),
            ]
        );
    }

    #[test]
    fn the_bounds_are_checked_before_any_recursion() {
        let deep = "(".repeat(100_000);
        assert_eq!(
            refused(&deep),
            [format!(
                "A search is at most {MAX_SYNTAX_CHARS} characters; this one is 100000."
            )]
        );
        let deep = format!("{}t:goblin{}", "(".repeat(17), ")".repeat(17));
        assert_eq!(
            refused(&deep),
            ["Groups nest at most 16 deep; this search nests 17."]
        );
        let fine = format!("{}t:goblin{}", "(".repeat(16), ")".repeat(16));
        assert!(read(&fine).is_ok());
    }

    #[test]
    fn every_field_a_keyword_names_says_what_it_takes() {
        for spec in &QUERY_KEYWORDS {
            if let Field(field) = spec.target {
                assert!(!takes(field).is_empty(), "{}", spec.example);
            }
        }
    }

    #[test]
    fn every_row_s_example_is_one_term_of_its_row() {
        for spec in &QUERY_KEYWORDS {
            let parsed = read(spec.example).expect(spec.example);
            match spec.target {
                Field(field) => {
                    assert_eq!(parsed.predicates.len(), 1, "{}", spec.example);
                    assert!(parsed.tags.is_empty() && parsed.text.is_empty());
                    assert_eq!(parsed.predicates[0].predicate.field, field);
                }
                Tag(namespace) => {
                    assert_eq!(parsed.tags.len(), 1, "{}", spec.example);
                    assert!(parsed.predicates.is_empty() && parsed.text.is_empty());
                    assert_eq!(parsed.tags[0].namespace, namespace);
                }
            }
        }
    }
}
