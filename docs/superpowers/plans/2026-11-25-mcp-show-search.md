# Show a search in the app (MCP project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP tool, `show_search`, that puts an agent's search (Scryfall-syntax text plus the
app's filters) on the Search page of the window the user last focused, brings it forward, and
answers what the page shows.

**Architecture:** The tool checks its arguments with `find_cards`' checks (moved to a module of
their own), translates them into a `SearchHandoff` in the page's shape, and hands it to a
`SearchWindows` seam on `AppState`. The desktop's implementation emits `search:show` to one window,
focuses it and checks the foreground. The page's window-scoped listener writes a one-shot store
hand-off. `SearchPage` applies it as it applies the quick search's and reports back through
`mcp_search_shown`, which wakes the waiting tool.

**Tech Stack:** Rust (Tauri 2.11, tokio, serde_json, windows-sys 0.61), React 19 + TypeScript,
Zustand store, TanStack Query, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-25-mcp-show-search-design.md` (read it first), building on
`docs/superpowers/specs/2026-11-24-mcp-card-knowledge-design.md` §6.4.

## Global Constraints

- The branch is project A's (`claude/mtg-grimoire-mcp-overview-d8ef41`, PR #1728, not merged). Open
  B's PR against A's branch while A is open.
- Before running any test in this worktree, read the `worktree-setup` skill (three Vite suites fail
  until its `fs.allow` step is done). Never run two `pnpm verify` at once.
- Read `apps/desktop/src-tauri/CLAUDE.md` and `packages/ui/CLAUDE.md` before editing their areas.
- No SQL in `mcp/`; every tool is a translation onto `grimoire_core::commands::dispatch`.
- No tool writes the user's cards, decks or wishlists. `show_search` changes what one window shows.
- `show_search` annotations: `readOnlyHint: false`, `destructiveHint: false`,
  `idempotentHint: true`, `openWorldHint: false`.
- `text` at most 1,000 characters. The tool waits at most 5 seconds for the page.
- Picker formats (the page's `FORMATS`): `standard`, `pioneer`, `modern`, `legacy`, `vintage`,
  `pauper`, `commander`. Chip rarities (`RARITIES`): `common`, `uncommon`, `rare`, `mythic`.
- Sort keys (`SEARCH_SORT_OPTIONS`): `name`, `set`, `type`, `rarity`, `price`, `manaValue`,
  `released`, `imageUpdated`.
- New filter words: `borders` ∈ `regular`, `borderless`, `fullart`; `finishes` ∈ `nonfoil`,
  `foil`, `etched`; `universe` ∈ `beyond`, `within`.
- `find_cards` keeps exactly its 13 filter fields; only `show_search` takes the three new ones.
- No `format` means _Tokens & extras_ (no format filter).
- The page listens on its own window (`getCurrentWindow().listen`), never the global `listen`.
- No `setState` inside an effect (lint). Render-phase adjustment plus an effect that spends the
  store field, as `pendingSearchText` does.
- Every new TS interface in `packages/ui/lib/ipc/mcp.ts` has a Rust struct of its name
  (`ipc.test.ts`). The new command goes on `command_table::DESKTOP_ONLY`.
- Tests needing files use `crate::scratch::path`. `cargo fmt -p mtg-grimoire` only, never `--all`.
- Commits: Conventional Commits, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm verify` once, at the end (Task 11). Intermediate steps run only the named tests.

## Review Focus

1. **Two `show_search` calls in quick succession** (an agent retrying). The first answers
   "replaced", and the page reports only the second id, with the second search's count. Tests:
   Task 3 step 1 (Rust), Task 8 step 1 (page).
2. **The same search shown twice** while the page already shows it. The query key does not change
   and nothing refetches, but the new id must still be reported. Test: Task 8 step 1.
3. **Blank or padded agent text with filters that add keywords.** The composed text has no
   leading, trailing or double spaces. Test: Task 1 step 1.
4. **A hand-off arriving while a deck is open in the editor.** The view moves to Search and the deck
   is parked, so the rail brings it back. Test: Task 6 step 1.
5. **The last-focused window was closed** before the next call. The pick falls back to `main`, then
   to any open window, never to a closed label. Test: Task 4 step 1.

---

### Task 1: Shared filter checks, and the hand-off's translation

Move `find_cards`' checks into `mcp/filters.rs` so both tools read one set. Add the three new
fields (accepted only when the caller allows them) and the pure translation into a `SearchHandoff`.

**Files:**
- Create: `apps/desktop/src-tauri/src/mcp/filters.rs`
- Create: `apps/desktop/src-tauri/src/mcp/show.rs` (types and the pure translation only; Task 2
  adds the rest)
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs` (declare `mod filters; pub mod show;`)
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs:825-989` (`FILTER_FIELDS` and `filter_fields`
  move out; `find_cards` calls the new pair). Make `Args` (and its field:
  `pub(super) struct Args(pub(super) Map<String, Value>)`), its methods, `run` and `format_key`
  `pub(super)`.

**Interfaces:**
- Produces, in `mcp/filters.rs`:
  - `pub(super) const FIND_FIELDS: [&str; 13]` (A's list, unchanged order)
  - `pub(super) const SHOW_FIELDS: [&str; 16]` (`FIND_FIELDS` plus `borders`, `finishes`,
    `universe`)
  - `pub(super) struct CheckedFilters { format: Option<String>, colors: Vec<String>,
    colors_exact: Option<bool>, types: Vec<&'static str>, rarities: Vec<String>, sets: Vec<String>,
    mana_values: Vec<u64>, mana_x: bool, owned: Option<bool>, price_min: Option<f64>,
    price_max: Option<f64>, oracle_tags: Vec<grimoire_core::tags::query::TagRef>,
    game_changer: bool, borders: Vec<String>, finishes: Vec<String>, universe: Option<String> }`
    (all fields `pub(super)`, `Default`)
  - `pub(super) async fn checked(state: &Arc<AppState>, filters: &Args, fields: &[&str]) ->
    Result<CheckedFilters, String>`
  - `pub(super) fn search_request(f: &CheckedFilters) -> Map<String, Value>` (exactly what
    `filter_fields` answered before)
- Produces, in `mcp/show.rs`:
  - `pub const PICKER_FORMATS: [&str; 7]`, `pub const CHIP_RARITIES: [&str; 4]`,
    `pub const SORT_KEYS: [&str; 8]`, `pub const MAX_TEXT_CHARS: usize = 1000`
  - `#[derive(Debug, Clone, Serialize, PartialEq)] #[serde(rename_all = "camelCase")]
    pub struct SearchHandoff { pub id: u64, pub text: String, pub format: Option<String>,
    pub colors: Vec<String>, pub colors_strict: bool, pub types: Vec<String>,
    pub rarities: Vec<String>, pub sets: Vec<String>, pub mana_values: Vec<u64>,
    pub mana_x: bool, pub owned: Option<bool>, pub price_min: Option<f64>,
    pub price_max: Option<f64>, pub borders: Vec<String>, pub finishes: Vec<String>,
    pub universe: Option<String>, pub tags: Vec<TagRef>, pub sort: Option<HandoffSort>,
    pub all_printings: Option<bool> }`
  - `#[derive(Debug, Clone, Serialize, PartialEq)] #[serde(rename_all = "camelCase")]
    pub struct HandoffSort { pub key: String, pub dir: String }` (`dir` is `"asc"` or `"desc"`)
  - `pub(super) fn handoff(text: Option<&str>, f: &CheckedFilters, sort: Option<HandoffSort>,
    all_printings: Option<bool>) -> SearchHandoff` (`id` 0; Task 2 assigns it)

- [ ] **Step 1: Write the failing tests** (in `mcp/show.rs`'s `tests` and `mcp/filters.rs`'s
  `tests`)

```rust
// show.rs
#[test]
fn a_picker_format_lands_on_the_select_and_another_goes_into_the_text() {
    let f = CheckedFilters { format: Some("commander".into()), ..Default::default() };
    let h = handoff(Some("t:creature"), &f, None, None);
    assert_eq!(h.format.as_deref(), Some("commander"));
    assert_eq!(h.text, "t:creature");
    let f = CheckedFilters { format: Some("premodern".into()), ..Default::default() };
    let h = handoff(Some("t:creature"), &f, None, None);
    assert_eq!(h.format, None);
    assert_eq!(h.text, "t:creature f:premodern");
}

#[test]
fn rarities_stay_on_the_chips_unless_one_has_none_then_all_go_in_one_group() {
    let chips = CheckedFilters { rarities: vec!["rare".into(), "mythic".into()], ..Default::default() };
    let h = handoff(None, &chips, None, None);
    assert_eq!(h.rarities, ["rare", "mythic"]);
    assert_eq!(h.text, "");
    let one = CheckedFilters { rarities: vec!["special".into()], ..Default::default() };
    assert_eq!(handoff(None, &one, None, None).text, "r:special");
    let mixed = CheckedFilters { rarities: vec!["rare".into(), "special".into()], ..Default::default() };
    let h = handoff(None, &mixed, None, None);
    assert!(h.rarities.is_empty());
    assert_eq!(h.text, "(r:rare or r:special)");
}

#[test]
fn game_changers_are_a_term_and_the_text_is_never_padded() {
    let f = CheckedFilters { game_changer: true, format: Some("oathbreaker".into()), ..Default::default() };
    assert_eq!(handoff(Some("   "), &f, None, None).text, "is:gamechanger f:oathbreaker");
    assert_eq!(handoff(Some("  bolt  "), &f, None, None).text, "bolt is:gamechanger f:oathbreaker");
    assert_eq!(handoff(None, &CheckedFilters::default(), None, None).text, "");
}

#[test]
fn the_rest_is_carried_in_the_pages_shape() {
    let tag = TagRef { slug: "ramp".into(), label: "Ramp".into(), namespace: "oracle".into() };
    let f = CheckedFilters {
        colors: vec!["U".into(), "R".into()], colors_exact: Some(true),
        oracle_tags: vec![tag.clone()], borders: vec!["borderless".into()],
        universe: Some("beyond".into()), mana_values: vec![1, 8], mana_x: true,
        owned: Some(false), price_max: Some(2.5), ..Default::default()
    };
    let sort = HandoffSort { key: "price".into(), dir: "desc".into() };
    let h = handoff(None, &f, Some(sort.clone()), Some(true));
    assert_eq!((h.colors.clone(), h.colors_strict), (vec!["U".to_owned(), "R".to_owned()], true));
    assert_eq!(h.tags, [tag]);
    assert_eq!(h.sort, Some(sort));
    assert_eq!(h.all_printings, Some(true));
    let wire = serde_json::to_value(&h).unwrap();
    for key in ["colorsStrict", "manaValues", "manaX", "priceMax", "allPrintings"] {
        assert!(wire.get(key).is_some(), "{key}");
    }
}

/// The three lists are the page's: a format added to the picker, a rarity given a chip or a
/// sort key added there must be added here, or the hand-off sends a value the bar cannot draw.
#[test]
fn the_lists_match_the_pages_own() {
    let search = include_str!("../../../../../packages/ui/features/search/useCardSearch.ts");
    let options = include_str!("../../../../../packages/ui/features/search/filterOptions.ts");
    assert_eq!(values_in(search, "export const FORMATS = ["), PICKER_FORMATS);
    assert_eq!(values_in(search, "export const SEARCH_SORT_OPTIONS = ["), SORT_KEYS);
    assert_eq!(quoted_in(options, "export const RARITIES = ["), CHIP_RARITIES);
}
```

```rust
// filters.rs
#[tokio::test]
async fn the_new_fields_are_refused_by_find_cards_and_checked_for_show_search() {
    let state = crate::mcp::testing::state("filters-new-fields");
    for field in ["borders", "finishes", "universe"] {
        let args = Args(json!({ field: "x" }).as_object().unwrap().clone());
        let why = checked(&state, &args, &FIND_FIELDS).await.err().unwrap();
        assert!(why.contains(&format!("{field:?}")), "{why}");
    }
    let bad = [("borders", json!(["shiny"])), ("finishes", json!(["gold"])), ("universe", json!("outer"))];
    for (field, value) in bad {
        let args = Args(json!({ field: value }).as_object().unwrap().clone());
        let why = checked(&state, &args, &SHOW_FIELDS).await.err().unwrap();
        assert!(why.contains(&format!("filters.{field}")), "{why}");
        assert!(!why.contains("  "), "{why}");
    }
    let ok = Args(json!({ "borders": ["Borderless"], "finishes": ["etched"], "universe": "within" })
        .as_object().unwrap().clone());
    let f = checked(&state, &ok, &SHOW_FIELDS).await.unwrap();
    assert_eq!((f.borders, f.finishes, f.universe), (vec!["borderless".to_owned()], vec!["etched".to_owned()], Some("within".to_owned())));
}
```

`values_in(src, start) -> Vec<String>` (the `value: "…"` strings between `start` and the next `]`)
and `quoted_in(src, start) -> Vec<String>` (every `"…"` there) are test helpers in `show.rs`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p mtg-grimoire mcp::show:: mcp::filters::`
Expected: FAIL to compile (`handoff`, `CheckedFilters`, `checked` not defined).

- [ ] **Step 3: Move the checks into `filters.rs` and add the translation**

- `checked` reads every field `filter_fields` read, with the same sentences. The unknown-field
  sentence lists the `fields` it was given. The three new fields follow `rarities`' shape:
  lowercased, refused with `filters.borders cannot hold "shiny"; use any of: regular, borderless,
  fullart.`, and `filters.universe cannot be "outer"; use one of: beyond, within.`.
- Oracle tags keep the `tag_resolve` call, but keep each hit as a `TagRef` (its `slug`, `label`,
  `namespace`) rather than the slug alone.
- `search_request` rebuilds the old map from `CheckedFilters`. `oracleTags` is
  `{ include: [slugs], exclude: [] }` and `gameChanger` is the `is:gamechanger` predicate, as
  before.
- `handoff` composes `text` as: the agent's text trimmed; then `is:gamechanger`; then
  `f:<key>` when the format is not in `PICKER_FORMATS`; then the rarity group when any rarity is
  not in `CHIP_RARITIES` (`r:x` for one, `(r:a or r:b …)` for several, in the given order). The
  parts are joined by single spaces, empty ones skipped. `format` is the key only when it is a
  picker format. `rarities` is empty when the group went into the text.
- `find_cards` becomes `checked(state, &filters, &FIND_FIELDS)` then `search_request`.

- [ ] **Step 4: Run them, and A's `find_cards` tests, to verify they pass**

Run: `cargo test -p mtg-grimoire mcp::`
Expected: PASS. Every `find_cards_*`, `oracle_tags_narrow_*` and `an_unknown_filter_value_*` test
is unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/
git commit -m "refactor(mcp): find_cards' filter checks in a module of their own, and the search hand-off's translation"
```

---

### Task 2: The waiting hand-off and the page's answer (`ShowSearch`, `mcp_search_shown`)

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/show.rs`
- Modify: `apps/desktop/src-tauri/src/sync/mod.rs:46-80` (`AppState` gains `show_search`)
- Modify: every `AppState { … }` construction: `desktop.rs:1515` (Task 4 replaces its value; use
  `ShowSearch::detached()` here), `mcp/mod.rs:497`, `mirror/watch.rs:672`,
  `sync_engine/live.rs:82`, `update.rs:2342`
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs` (`testing::state_with`)
- Modify: `apps/desktop/src-tauri/src/desktop.rs` (`generate_handler!` gains
  `mcp::show::mcp_search_shown`)
- Modify: `apps/desktop/src-tauri/src/command_table.rs` (`DESKTOP_ONLY` entry:
  `("mcp_search_shown", "the Search page's answer to the local MCP server's show_search, which only this process's listener waits for")`)

**Interfaces:**
- Consumes: `SearchHandoff` (Task 1).
- Produces, in `mcp/show.rs`:
  - `pub const SEARCH_SHOW_EVENT: &str = "search:show"`, `pub const WAIT: Duration` (5 s)
  - `#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)] #[serde(rename_all = "camelCase")]
    pub struct SearchShownReport { pub total: u64, pub total_is_capped: bool,
    pub keywords: Vec<String>, pub words: String, pub unknown_tags: Vec<String>,
    pub failure: Option<String> }`
  - `pub struct Shown { pub label: String, pub came_forward: bool }`
  - `pub trait SearchWindows: Send + Sync + 'static { fn show(&self, handoff: &SearchHandoff) ->
    Result<Shown, String>; }` (may block; called on the blocking pool)
  - `pub enum Outcome { Reported(SearchShownReport), Replaced }`
  - `pub struct ShowSearch` with `pub fn new(windows: Arc<dyn SearchWindows>, wait: Duration) ->
    Self`, `pub fn detached() -> Self` (its windows refuse with "No app window can show a search
    here."), `pub async fn show(&self, handoff: SearchHandoff) -> Result<Value, String>` (assigns
    the id), `pub fn report(&self, id: u64, report: SearchShownReport) -> bool`
  - `pub fn answer(shown: &Shown, outcome: Option<Outcome>) -> Value` (pure)
  - `#[tauri::command] pub fn mcp_search_shown(state: tauri::State<'_, Arc<AppState>>, id: u64,
    report: SearchShownReport)`
  - `AppState.show_search: Arc<crate::mcp::show::ShowSearch>`
  - In `mcp::testing` (`mod.rs`, `#[cfg(test)]`), so `show.rs`' and `tools.rs`' tests share them:
    `pub(crate) struct FakeWindows { pub shown: Mutex<Vec<SearchHandoff>>, pub came_forward: bool }`
    (implements `SearchWindows`, answers label `"main"`) with
    `pub fn forward(came_forward: bool) -> Self`,
    `pub async fn wait_for_one(&self) -> SearchHandoff` and
    `pub async fn wait_for(&self, n: usize) -> SearchHandoff` (poll `shown` every 5 ms, up to
    1 s, and answer the n-th); plus
    `testing::state_with(name: &str, windows: Arc<dyn SearchWindows>) -> Arc<AppState>` (a
    `ShowSearch` waiting 300 ms). `testing::state` uses `ShowSearch::detached()`.

- [ ] **Step 1: Write the failing tests** (`mcp/show.rs`)

```rust
#[tokio::test]
async fn the_pages_report_is_the_answer() {
    let fake = Arc::new(FakeWindows::forward(true));
    let show = Arc::new(ShowSearch::new(fake.clone(), Duration::from_secs(2)));
    let call = tokio::spawn({ let show = show.clone(); async move { show.show(blank()).await } });
    let id = fake.wait_for_one().await.id;
    assert!(show.report(id, report(143, "")));
    let got = call.await.unwrap().unwrap();
    assert_eq!(got["shown"], true);
    assert_eq!(got["cameForward"], true);
    assert_eq!(got["total"], 143);
    assert!(got.get("note").is_none());
    assert!(!show.report(id, report(1, "")), "a second report for a spent id is dropped");
}

#[tokio::test]
async fn a_window_that_never_answers_is_sent_and_unanswered() {
    let fake = Arc::new(FakeWindows::forward(true));
    let show = ShowSearch::new(fake, Duration::from_millis(50));
    let got = show.show(blank()).await.unwrap();
    assert_eq!(got["shown"], Value::Null);
    assert!(got["note"].as_str().unwrap().contains("did not say"));
}

#[tokio::test]
async fn a_later_search_replaces_the_one_waiting() {
    let fake = Arc::new(FakeWindows::forward(true));
    let show = Arc::new(ShowSearch::new(fake.clone(), Duration::from_secs(2)));
    let first = tokio::spawn({ let show = show.clone(); async move { show.show(blank()).await } });
    let first_id = fake.wait_for_one().await.id;
    let second = tokio::spawn({ let show = show.clone(); async move { show.show(blank()).await } });
    let got = first.await.unwrap().unwrap();
    assert_eq!(got["shown"], false);
    assert!(got["note"].as_str().unwrap().contains("replaced"));
    let second_id = fake.wait_for(2).await.id;
    assert_ne!(first_id, second_id);
    assert!(!show.report(first_id, report(9, "")));
    assert!(show.report(second_id, report(3, "")));
    assert_eq!(second.await.unwrap().unwrap()["total"], 3);
}

#[test]
fn the_notes_say_what_the_agent_should_tell_the_user() {
    let behind = Shown { label: "main".into(), came_forward: false };
    let got = answer(&behind, Some(Outcome::Reported(report(5, ""))));
    assert_eq!(got["cameForward"], false);
    assert!(got["note"].as_str().unwrap().contains("taskbar"));
    let front = Shown { label: "main".into(), came_forward: true };
    let empty = answer(&front, Some(Outcome::Reported(report(0, "cube:vintage"))));
    let note = empty["note"].as_str().unwrap();
    assert!(note.contains("no cards") && note.contains("cube:vintage"), "{note}");
    let failed = SearchShownReport { failure: Some("The tag list could not be read.".into()), ..report(0, "") };
    assert!(answer(&front, Some(Outcome::Reported(failed)))["note"].as_str().unwrap().contains("could not be read"));
    assert!(!answer(&front, None)["note"].as_str().unwrap().contains("  "));
}

#[tokio::test]
async fn a_refusing_window_is_the_tools_refusal() {
    let why = ShowSearch::detached().show(blank()).await.err().unwrap();
    assert!(why.contains("No app window"), "{why}");
}
```

`blank()` is `handoff(None, &CheckedFilters::default(), None, None)`. `report(total, words)` builds
a `SearchShownReport` with nothing else set.

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p mtg-grimoire mcp::show::`
Expected: FAIL to compile (`ShowSearch`, `answer`, `FakeWindows` not defined).

- [ ] **Step 3: Implement**

- `ShowSearch` holds `windows`, `wait`, `next_id: AtomicU64` (from 1) and
  `waiting: Mutex<Option<(u64, tokio::sync::oneshot::Sender<Outcome>)>>`.
- `show` does, in order:
  1. assigns the id;
  2. takes any waiting sender and sends it `Outcome::Replaced`;
  3. stores its own sender;
  4. runs `windows.show(&handoff)` on `tauri::async_runtime::spawn_blocking`; an `Err` clears
     the waiting slot and is the refusal;
  5. awaits the receiver under `tokio::time::timeout(self.wait, …)`, clearing the slot on a
     timeout;
  6. answers `answer(&shown, outcome)`.
- `report` sends only when the waiting id equals `id`.
- `answer`:
  - `{ shown, cameForward, total, totalIsCapped, keywords, words, unknownTags }` for a report
    (`shown: true`);
  - `{ shown: false, cameForward, note }` for `Replaced`;
  - `{ shown: null, cameForward, note }` for `None`.
  - `note` joins, with single spaces, whichever of these sentences apply:
    - "The Search page shows no cards." on a 0 with no failure, followed, when `words` contains
      `:`, by `It searched "{words}" as plain words, so a term there was not read as a keyword.`;
    - the failure's own sentence;
    - "A later search replaced this one.";
    - "The app was sent the search, but its window did not say what it shows within 5 seconds; ask
      the user whether it appeared.";
    - "Windows kept the app behind the window in front, and its taskbar button is flashing: tell
      the user to click it." when `came_forward` is false.
- `mcp_search_shown` calls `state.show_search.report(id, report)` and ignores the bool.

- [ ] **Step 4: Run them to verify they pass, with the command table**

Run: `cargo test -p mtg-grimoire mcp::show:: command_table::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/
git commit -m "feat(mcp): show_search's hand-off waits for the Search page's report"
```

---

### Task 3: The `show_search` tool, its description and the server's instructions

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs` (`list()`, `call`, new `show_search` fn,
  tests; tool count 26 → 27 at `tools.rs:2544`/`2547`)
- Modify: `apps/desktop/src-tauri/src/mcp/rpc.rs:34-55` (`INSTRUCTIONS`) and `rpc.rs:270-281` (the
  test's tool list gains `show_search`)

**Interfaces:**
- Consumes: `filters::{checked, SHOW_FIELDS}`, `show::{handoff, HandoffSort, SORT_KEYS,
  MAX_TEXT_CHARS}`, `state.show_search.show` (Tasks 1–2), `testing::state_with`, `FakeWindows`.
- Produces: the tool `show_search`.
  - Arguments: `text` (string), `filters` (object: `find_cards`' 13 properties plus `borders`
    and `finishes` as string arrays and `universe` as a string, `additionalProperties: false`),
    `sort` (`{ key: enum SORT_KEYS, descending: boolean }`, `key` required) and `allPrintings`
    (boolean). Nothing is required.
  - Title: "Show a search in the app".

- [ ] **Step 1: Write the failing tests** (`tools.rs` tests)

```rust
#[tokio::test]
async fn show_search_hands_the_window_the_checked_search_and_answers_the_page() {
    let fake = Arc::new(FakeWindows::forward(true));
    let state = state_with("show-search", fake.clone());
    seed(&state, |c| { filter_cards(c); tag(c, "ramp", "Ramp", &["o-f-drake"]); tags_downloaded(c); });
    let call = tokio::spawn({ let state = state.clone(); async move {
        done(&state, "show_search", json!({
            "text": "t:creature",
            "filters": { "format": "commander", "oracleTags": ["ramp"], "gameChanger": true, "borders": ["borderless"] },
            "sort": { "key": "price", "descending": true },
        })).await
    }});
    let sent = fake.wait_for_one().await;
    assert_eq!(sent.text, "t:creature is:gamechanger");
    assert_eq!(sent.format.as_deref(), Some("commander"));
    assert_eq!(sent.tags[0].label, "Ramp");
    assert_eq!(sent.borders, ["borderless"]);
    assert_eq!(sent.sort, Some(HandoffSort { key: "price".into(), dir: "desc".into() }));
    assert_eq!(sent.all_printings, None);
    state.show_search.report(sent.id, SearchShownReport { total: 2, ..Default::default() });
    assert_eq!(call.await.unwrap()["total"], 2);
}

#[tokio::test]
async fn show_search_refuses_before_any_window_changes() {
    let fake = Arc::new(FakeWindows::forward(true));
    let state = state_with("show-search-refusals", fake.clone());
    seed(&state, filter_cards);
    let long = "a".repeat(1001);
    for (args, word) in [
        (json!({}), "text"),
        (json!({ "filters": {} }), "text"),
        (json!({ "text": long }), "1000"),
        (json!({ "text": "x", "sort": { "key": "power" } }), "sort.key"),
        (json!({ "filters": { "rarities": ["epic"] } }), "filters.rarities"),
        (json!({ "filters": { "oracleTags": ["nonesuch"] } }), "find_tags"),
        (json!({ "filters": { "universe": "outer" } }), "filters.universe"),
    ] {
        let why = refused(&state, "show_search", args.clone()).await;
        assert!(why.contains(word), "{args}: {why}");
        assert!(!why.contains("  "), "{args}: {why}");
    }
    assert!(fake.shown.lock().unwrap().is_empty(), "a refused call sent nothing");
}

#[test]
fn show_search_asks_first_and_is_not_a_read() {
    let tool = list().into_iter().find(|t| t["name"] == "show_search").unwrap();
    let d = tool["description"].as_str().unwrap();
    assert!(d.contains("Ask the user in chat first") && d.contains("only after they say yes"), "{d}");
    assert_eq!(tool["annotations"]["readOnlyHint"], false);
    assert_eq!(tool["annotations"]["destructiveHint"], false);
    assert_eq!(tool["annotations"]["idempotentHint"], true);
    assert_eq!(tool["inputSchema"]["properties"]["filters"]["additionalProperties"], false);
}
```

Rename `every_tool_has_a_closed_object_schema_and_a_distinct_name`'s two `26`s to `27`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p mtg-grimoire mcp::tools::tests::show_search`
Expected: FAIL (`show_search is not a tool`).

- [ ] **Step 3: Implement**

- The refusal for an empty call is `show_search needs text (the Search box's words, in Scryfall
  syntax) or at least one field in filters.` The text refusal is `text is longer than 1000
  characters.` The sort refusal is `sort.key cannot be "power"; use one of: name, set, …`.
- `descending: true` becomes `dir: "desc"`, otherwise `"asc"`.
- The description (exact copy):

  > Show a search on the MTG Grimoire app's Search page, in the window the user last used, and
  > bring that window forward. Ask the user in chat first ("Want to see these in the app?") and
  > call this only after they say yes, once per yes. Changes no data. text is the Search box's
  > text in Scryfall syntax (t:, o:, kw:, pow>=4, otag:, -, or, parentheses); filters are
  > find_cards' filters plus borders, finishes and universe, and find_cards with the same filters
  > previews the count. Answers what the page shows: total, the keywords it read, the words it
  > searched as plain text (words) and any unknownTags; cameForward false means Windows kept the
  > app behind and its taskbar button is flashing.

- `INSTRUCTIONS` gains one sentence, before the "The one thing these tools write" sentence:
  `"show_search puts a search on the app's Search page and brings its window forward: offer it ",
  "in chat first and call it only after the user says yes. "`.

- [ ] **Step 4: Run the MCP tests to verify they pass**

Run: `cargo test -p mtg-grimoire mcp::`
Expected: PASS, including `rpc::tests::the_instructions_*` and the tool count of 27.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/
git commit -m "feat(mcp): show_search, a search shown in the app after the user says yes"
```

---

### Task 4: The last-focused window, and bringing it forward

**Files:**
- Modify: `apps/desktop/src-tauri/src/window.rs` (`LastFocused`, `DesktopWindows`, `in_front`)
- Modify: `apps/desktop/src-tauri/src/desktop.rs`:
  - `setup` (~line 947): `app.manage(Arc::new(window::LastFocused::default()))`;
  - the `.run` match (~line 1012): two `RunEvent::WindowEvent` arms;
  - `AppState`'s construction (~line 1515):
    `show_search: Arc::new(mcp::show::ShowSearch::new(Arc::new(window::DesktopWindows::new(app.clone())), mcp::show::WAIT))`.
- Modify: `apps/desktop/src-tauri/Cargo.toml:202-205` (`windows-sys` gains the
  `Win32_UI_WindowsAndMessaging` feature, with a comment naming `GetForegroundWindow`)

**Interfaces:**
- Consumes: `SearchWindows`, `Shown`, `SearchHandoff`, `SEARCH_SHOW_EVENT` (Task 2).
- Produces:
  - `#[derive(Default)] pub struct LastFocused(Mutex<Option<String>>)` with
    `pub fn record(&self, label: &str)`, `pub fn forget(&self, label: &str)` and
    `pub fn pick(&self, open: &[String]) -> Option<String>`
  - `pub struct DesktopWindows(tauri::AppHandle)` with `pub fn new(app: tauri::AppHandle) -> Self`,
    implementing `SearchWindows`

- [ ] **Step 1: Write the failing tests** (`window.rs` tests)

```rust
#[test]
fn the_last_focused_window_is_picked_while_it_is_open() {
    let last = LastFocused::default();
    let open = vec!["main".to_owned(), "window-2".to_owned(), "window-3".to_owned()];
    assert_eq!(last.pick(&open).as_deref(), Some("main"), "nothing recorded yet: main");
    last.record("window-3");
    last.record("window-2");
    assert_eq!(last.pick(&open).as_deref(), Some("window-2"));
}

#[test]
fn a_closed_window_is_never_picked() {
    let last = LastFocused::default();
    last.record("window-2");
    last.forget("window-2");
    assert_eq!(last.pick(&["main".into(), "window-3".into()]).as_deref(), Some("main"));
    last.record("window-3");
    // Gone without a Destroyed event reaching us: the open list still rules.
    assert_eq!(last.pick(&["window-4".into(), "window-5".into()]).as_deref(), Some("window-4"));
    assert_eq!(last.pick(&[]), None);
}
```

(The fallback to any window takes the first label in sorted order, so a pick is repeatable.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p mtg-grimoire window::`
Expected: FAIL to compile (`LastFocused` not defined).

- [ ] **Step 3: Implement**

- `forget` clears the record only when it names that label.
- `DesktopWindows::show`, in order:
  1. lists `app.webview_windows()` labels;
  2. picks through the managed `LastFocused` (`Err("No app window is open.")` when none);
  3. `app.emit_to(label.as_str(), SEARCH_SHOW_EVENT, handoff)`;
  4. on that window, `unminimize`, `show`, `set_focus` (each result ignored);
  5. answers `Shown { label, came_forward: in_front(&window) }`, calling
     `request_user_attention(Some(tauri::UserAttentionType::Informational))` when it is false.
- `in_front`:
  - On Windows, run on the main thread via `app.run_on_main_thread`, whose closure is queued
    behind `set_focus`'s message, comparing `GetForegroundWindow()` with `window.hwnd()` as raw
    pointers. Send the bool back over a `std::sync::mpsc` channel with a 1-second
    `recv_timeout` (`false` on timeout).
  - Elsewhere: `window.is_focused().unwrap_or(false)`.
- `.run` arms:

```rust
tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Focused(true), .. } => {
    app.state::<Arc<window::LastFocused>>().record(&label)
}
tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
    app.state::<Arc<window::LastFocused>>().forget(&label)
}
```

- [ ] **Step 4: Run them, and the desktop build, to verify they pass**

Run: `cargo test -p mtg-grimoire window::` then `cargo clippy -p mtg-grimoire -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/
git commit -m "feat(desktop): the window last focused takes an agent's search and is brought forward, or flashes"
```

---

### Task 5: The page's wire: mirror, command wrapper, window listener, fake

**Files:**
- Modify: `packages/ui/lib/ipc/mcp.ts` (interfaces and `mcpSearchShown`)
- Modify: `packages/ui/lib/ipc.test.ts` (import `mcpShowRs` from
  `../../../apps/desktop/src-tauri/src/mcp/show.rs?raw`; three rows beside `["McpStatus", …]`
  at ~line 6891; a wrapper test in the MCP `describe` at ~line 5913)
- Modify: `packages/ui/lib/window.ts` (`SEARCH_SHOW_EVENT`, `onSearchShow`)
- Modify: `packages/ui/lib/window.test.ts`
- Modify: `packages/fake/db.ts` (~line 29048: `mcp_search_shown: () => null`)

**Interfaces:**
- Consumes: the Rust structs of Tasks 1–2 (field names as serde writes them).
- Produces:
  - `export interface SearchHandoff { id: number; text: string; format: string | null;
    colors: ManaKey[]; colorsStrict: boolean; types: string[]; rarities: string[];
    sets: string[]; manaValues: number[]; manaX: boolean; owned: boolean | null;
    priceMin: number | null; priceMax: number | null; borders: Border[];
    finishes: Finish[]; universe: Universe | null; tags: TagRef[];
    sort: HandoffSort | null; allPrintings: boolean | null }`
  - `export interface HandoffSort { key: SearchSortKey; dir: SortDir }`
  - `export interface SearchShownReport { total: number; totalIsCapped: boolean;
    keywords: string[]; words: string; unknownTags: string[]; failure: string | null }`
  - `ipc.mcpSearchShown(id: number, report: SearchShownReport): Promise<void>` →
    `invoke("mcp_search_shown", { id, report })`
  - `export const SEARCH_SHOW_EVENT = "search:show"` and
    `export async function onSearchShow(cb: (handoff: SearchHandoff) => void): Promise<() => void>`
    in `lib/window.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// window.test.ts
describe("onSearchShow", () => {
  it("listens on its own window, never app-wide, and hands over the payload", async () => {
    const cb = vi.fn();
    await onSearchShow(cb);
    expect(windowListen).toHaveBeenCalledWith(SEARCH_SHOW_EVENT, expect.any(Function));
    expect(globalListen).not.toHaveBeenCalled();
    const handler = windowListen.mock.calls[0][1] as (e: { payload: unknown }) => void;
    handler({ payload: { id: 7 } });
    expect(cb).toHaveBeenCalledWith({ id: 7 });
  });
});

// ipc.test.ts, in the MCP describe
it("mcpSearchShown sends the id and the report under their own names", async () => {
  invoke.mockResolvedValue(null);
  const report: SearchShownReport = { total: 3, totalIsCapped: false, keywords: ["t:creature"], words: "", unknownTags: [], failure: null };
  await ipc.mcpSearchShown(7, report);
  expect(invoke).toHaveBeenCalledWith("mcp_search_shown", { id: 7, report });
});
```

Plus the three parity rows: `["SearchHandoff", mcpShowRs, "SearchHandoff"]`,
`["HandoffSort", mcpShowRs, "HandoffSort"]`, and
`["SearchShownReport", mcpShowRs, "SearchShownReport"]`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run packages/ui/lib/window.test.ts packages/ui/lib/ipc.test.ts`
Expected: FAIL (`onSearchShow` / `mcpSearchShown` not defined; parity rows name missing interfaces).

- [ ] **Step 3: Implement** the interfaces (types from `@/lib/border`, `@/lib/finish`,
  `@/lib/universe`, `@/lib/mana`, `@/lib/sort` and `./tags`' `TagRef`, `./cards`'
  `SearchSortKey`). Add the wrapper, and `onSearchShow` in `onSnapHover`'s shape. Its doc says
  why it is window-scoped: Rust's `emit_to(label)` reaches every global listener.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm exec vitest run packages/ui/lib/window.test.ts packages/ui/lib/ipc.test.ts packages/fake/`
Expected: PASS. The MCP `describe`'s parameter walk (`MCP_SOURCES`, ~line 5955) reads every
`#[tauri::command]` under `mcp/`. If it lists commands by name, `mcp_search_shown` joins with
`id: u64` and `report: SearchShownReport`.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/lib/ packages/fake/db.ts
git commit -m "feat(ui): the search hand-off's wire, mirror and window-scoped listener"
```

---

### Task 6: The store's one-shot hand-off

**Files:**
- Modify: `packages/ui/lib/store.ts` (fields beside `pendingSearchText` ~line 899; action beside
  `showTextInSearch` ~line 1881; the clear in `setActiveView` ~line 1546)
- Modify: `packages/ui/lib/store.test.ts`

**Interfaces:**
- Consumes: `SearchHandoff` (Task 5).
- Produces: `pendingSearchHandoff: SearchHandoff | null`,
  `showSearchHandoff: (handoff: SearchHandoff) => void` (calls `setActiveView("search")`, then
  writes the field), and `clearPendingSearchHandoff: () => void`.

- [ ] **Step 1: Write the failing tests** (`store.test.ts`, beside the quick search's)

```ts
it("goes to Search with an agent's search, and a later view change spends it", () => {
  const handoff = { id: 7, text: "t:creature" } as SearchHandoff;
  useAppStore.getState().showSearchHandoff(handoff);
  expect(useAppStore.getState().activeView).toBe("search");
  expect(useAppStore.getState().pendingSearchHandoff).toBe(handoff);
  useAppStore.getState().setActiveView("home");
  expect(useAppStore.getState().pendingSearchHandoff).toBeNull();
});

it("parks a deck open in the editor when an agent's search arrives", () => {
  useAppStore.getState().setActiveView("decks");
  useAppStore.setState({ openDeckId: 12 });
  useAppStore.getState().showSearchHandoff({ id: 1, text: "" } as SearchHandoff);
  const s = useAppStore.getState();
  expect(s.activeView).toBe("search");
  expect(s.parkedDeckId).toBe(12);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run packages/ui/lib/store.test.ts`
Expected: FAIL (`showSearchHandoff is not a function`).

- [ ] **Step 3: Implement** in `showTextInSearch`'s shape, with doc comments that name the MCP tool
  and point to `pendingSearchText`.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm exec vitest run packages/ui/lib/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/lib/store.ts packages/ui/lib/store.test.ts
git commit -m "feat(ui): a one-shot store hand-off for an agent's search"
```

---

### Task 7: The Search page applies the hand-off

**Files:**
- Create: `packages/ui/features/search/searchHandoff.ts` (`chipsOf`; Task 8 adds the report)
- Create: `packages/ui/features/search/searchHandoff.test.ts`
- Modify: `packages/ui/features/search/useCardSearch.ts`:
  - `CardSearchOptions` gains `initialHandoff`, read where `initialText` is (~lines 765–873);
  - the return gains `showHandoff` beside `showOnlyText` (~line 1959) and
    `plainWords: parsed.text`.
- Modify: `packages/ui/features/tags/useTagSelection.ts` (`initialChips` option, `replaceChips`)
- Modify: `packages/ui/features/search/SearchPage.tsx:356-408`
- Modify: `packages/ui/features/search/SearchPage.test.tsx` (a new `describe` after the quick
  search's at ~line 1913)

**Interfaces:**
- Consumes: `pendingSearchHandoff`, `clearPendingSearchHandoff` (Task 6); `SearchHandoff`
  (Task 5).
- Produces:
  - `chipsOf(handoff: SearchHandoff): TagChip[]` (include mode, each `TagRef`'s namespace)
  - `useCardSearch({ initialHandoff?: SearchHandoff | null })`, `search.showHandoff(h:
    SearchHandoff): void` and `search.plainWords: string`
  - `useTagSelection({ initialChips?: readonly TagChip[] | null })` and
    `tags.replaceChips(chips: readonly TagChip[]): void`
  - `SearchPage` holds `appliedHandoffId: number | null` (render-phase state, the guard), which
    Task 8 reads.

- [ ] **Step 1: Write the failing tests** (`SearchPage.test.tsx`; reuse the file's `wrap`,
  `searchCards`, `lastRequest`, `openTray`)

```ts
describe("SearchPage — a search handed over by an agent", () => {
  const handoff = (over: Partial<SearchHandoff> = {}): SearchHandoff => ({
    id: 1, text: "t:creature", format: "commander", colors: ["U", "R"], colorsStrict: true,
    types: [], rarities: ["rare"], sets: [], manaValues: [2], manaX: false, owned: null,
    priceMin: null, priceMax: 5, borders: ["borderless"], finishes: [], universe: null,
    tags: [{ slug: "ramp", label: "Ramp", namespace: "oracle" }], sort: { key: "price", dir: "desc" },
    allPrintings: null, ...over,
  });
  afterEach(() => useAppStore.setState({ pendingSearchHandoff: null }));

  it("opens on the agent's text, filters, chips and sort, and spends the hand-off", async () => {
    useAppStore.setState({ pendingSearchHandoff: handoff() });
    wrap(<SearchPage />);
    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    for (const [req] of searchCards.mock.calls) {
      expect(req).toMatchObject({ format: "commander", colors: "UR", colorsStrict: true, rarities: ["rare"], borders: ["borderless"], priceMax: 5 });
      expect(req.oracleTags?.include).toEqual(["ramp"]);
    }
    expect(screen.getByPlaceholderText(/search cards/i)).toHaveValue("t:creature");
    expect(lastRequest().sort).toEqual([{ key: "price", dir: "desc" }]);
    // The chips row draws the agent's tag by its label.
    expect(screen.getAllByText("Ramp").length).toBeGreaterThan(0);
    await waitFor(() => expect(useAppStore.getState().pendingSearchHandoff).toBeNull());
  });

  it("replaces what the reader had, leftover tag chips included, on a page already open", async () => {
    wrap(<SearchPage />);
    await userEvent.type(screen.getByPlaceholderText(/search cards/i), "goblin");
    await waitFor(() => expect(lastRequest().text).toBe("goblin"));
    act(() => useAppStore.getState().showSearchHandoff(handoff({ id: 2, format: null, colors: [], colorsStrict: false, tags: [], sort: null })));
    await waitFor(() => expect(lastRequest()).toMatchObject({ format: undefined, playableOnly: undefined }));
    expect(lastRequest().colors).toBeUndefined();
    expect(screen.getByPlaceholderText(/search cards/i)).toHaveValue("t:creature");
  });
});
```

The request field names are the wire's (`SearchRequest`). Check them against the requests
`lastRequest()` already returns in the file's other tests, and adjust any name that differs before
running.

```ts
// searchHandoff.test.ts
it("turns the agent's tags into include chips", () => {
  expect(chipsOf({ tags: [{ slug: "ramp", label: "Ramp", namespace: "oracle" }] } as SearchHandoff))
    .toEqual([{ slug: "ramp", label: "Ramp", namespace: "oracle", mode: "include" }]);
});

/** The strings Rust composes (`mcp/show.rs`' `handoff`) must be terms this page reads. */
it("reads the keywords Rust puts in the box as keywords, not words", () => {
  for (const text of ["is:gamechanger", "f:premodern", "r:special", "(r:rare or r:special)"]) {
    expect(parseQuery(text).text).toBe("");
    expect(parseQuery(text).predicates).toHaveLength(1);
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run packages/ui/features/search/SearchPage.test.tsx packages/ui/features/search/searchHandoff.test.ts`
Expected: FAIL (`chipsOf` missing; the page ignores `pendingSearchHandoff`).

- [ ] **Step 3: Implement**

- `initialHandoff` seeds every state `initialText` seeds, and also `colorFilter`, `types`,
  `borders`, `finishes`, `universe`, `manaValues`, `manaX`, `owned`, `rarities`, `priceMin` and
  `priceMax` from the hand-off. `format` is the hand-off's key, or `ANY_CARD` when it is `null`.
  `sort` is `[h.sort]` when given, and `allPrintings` is the hand-off's value when it is not
  `null`.
- The remembered filters are skipped when a hand-off seeds, as `seed` is for `initialText`.
- `showHandoff` sets the same values through the setters, after `rewrite(h.text)`. Sort and
  printings change only when given.
- `SearchPage` follows the `pendingSearchText` block exactly:
  - `useTagSelection({ withoutChips: …, initialChips: pendingHandoff ? chipsOf(pendingHandoff) : null })`
    and `useCardSearch({ …, initialHandoff: pendingHandoff })`;
  - an `appliedHandoffId` guard keyed on `id`;
  - in render, `tags.replaceChips(chipsOf(h))` and `search.showHandoff(h)`;
  - an effect that calls `clearPendingSearchHandoff()`.
- If the parse fence fails for `f:` or `r:`, stop and report: the spec's text route rests on it.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm exec vitest run packages/ui/features/search/ packages/ui/features/tags/`
Expected: PASS, the existing set and text hand-off tests included.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/features/search/ packages/ui/features/tags/
git commit -m "feat(ui): the Search page applies an agent's search to its own controls"
```

---

### Task 8: The page's report

**Files:**
- Modify: `packages/ui/features/search/searchHandoff.ts` (`handoffReport`, `useHandoffReport`)
- Modify: `packages/ui/features/search/searchHandoff.test.ts`
- Modify: `packages/ui/features/search/SearchPage.tsx` (call `useHandoffReport(search,
  appliedHandoffId)`)
- Modify: `packages/ui/features/search/SearchPage.test.tsx`

**Interfaces:**
- Consumes: `search.total`, `totalIsCapped`, `predicateChips`, `tagChips`, `plainWords`,
  `tagNotFound`, `tagsResolving`, `tagLookupFailure`, `query` (`useCardSearch`);
  `ipc.mcpSearchShown` (Task 5); `appliedHandoffId` (Task 7).
- Produces:
  - `export interface HandoffWall { total: number; totalIsCapped: boolean; keywords: string[];
    words: string; unknownTags: string[]; failure: string | null; resolving: boolean;
    settled: boolean }`, where `settled` is `query.isSuccess && !query.isPlaceholderData`;
  - `export function handoffReport(wall: HandoffWall): SearchShownReport | null` (`null` while
    waiting);
  - `export function useHandoffReport(search: CardSearch, id: number | null): void`, where
    `CardSearch` is `ReturnType<typeof useCardSearch>`.

- [ ] **Step 1: Write the failing tests**

```ts
// searchHandoff.test.ts
describe("handoffReport", () => {
  const wall = (over: Partial<HandoffWall> = {}): HandoffWall => ({ total: 143, totalIsCapped: false, keywords: ["t:creature"], words: "", unknownTags: [], failure: null, resolving: false, settled: true, ...over });
  it("waits while tags resolve or the rows are the last search's", () => {
    expect(handoffReport(wall({ resolving: true }))).toBeNull();
    expect(handoffReport(wall({ settled: false }))).toBeNull();
  });
  it("reports the wall once it has answered", () => {
    expect(handoffReport(wall())).toEqual({ total: 143, totalIsCapped: false, keywords: ["t:creature"], words: "", unknownTags: [], failure: null });
  });
  it("reports at once when a typed tag names none or a lookup failed, rows or not", () => {
    expect(handoffReport(wall({ settled: false, unknownTags: ["nonesuch"], total: 0 }))?.unknownTags).toEqual(["nonesuch"]);
    expect(handoffReport(wall({ settled: false, failure: "The tag list could not be read." }))?.failure).toMatch(/could not/);
  });
});

// SearchPage.test.tsx, in the agent describe
it("reports the wall's answer once, for the latest hand-off only", async () => {
  wrap(<SearchPage />);
  act(() => {
    useAppStore.getState().showSearchHandoff(handoff({ id: 3 }));
    useAppStore.getState().showSearchHandoff(handoff({ id: 4, text: "t:instant" }));
  });
  await waitFor(() => expect(mcpSearchShown).toHaveBeenCalledTimes(1));
  expect(mcpSearchShown).toHaveBeenCalledWith(4, expect.objectContaining({ keywords: expect.arrayContaining(["t:instant"]) }));
});

it("reports a hand-off that changes nothing on screen", async () => {
  wrap(<SearchPage />);
  act(() => useAppStore.getState().showSearchHandoff(handoff({ id: 5 })));
  await waitFor(() => expect(mcpSearchShown).toHaveBeenCalledWith(5, expect.anything()));
  act(() => useAppStore.getState().showSearchHandoff(handoff({ id: 6 })));
  await waitFor(() => expect(mcpSearchShown).toHaveBeenCalledWith(6, expect.anything()));
});
```

`mcpSearchShown` is the file's `ipc` mock's `mcpSearchShown`, resolving `undefined`. Add it where
the file mocks `searchCards`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run packages/ui/features/search/searchHandoff.test.ts packages/ui/features/search/SearchPage.test.tsx`
Expected: FAIL (`handoffReport` missing; `mcpSearchShown` never called).

- [ ] **Step 3: Implement**

- `useHandoffReport` builds the wall from `search`:
  - `keywords` is the predicate chips' labels, then the typed tag chips' labels;
  - `unknownTags` is `tagNotFound.map(t => t.value)`;
  - `failure` is `tagLookupFailure ?? (query.error ? ipcError(query.error) : null)`.
- It sends `ipc.mcpSearchShown(id, report)` from an effect once `handoffReport` is not null,
  remembering the last id sent in a `useRef` (never state; no `setState` in an effect). A rejected
  send is swallowed: the tool's timeout already speaks for it.
- Use `useCardSearch`'s real `query.error` path, not a re-derived one.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm exec vitest run packages/ui/features/search/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/features/search/
git commit -m "feat(ui): the Search page tells the MCP server what an agent's search shows"
```

---

### Task 9: The desktop face listens

**Files:**
- Create: `packages/ui/features/search/useSearchHandoffs.ts`
- Modify: `apps/desktop/src/DesktopBoot.tsx` (call `useSearchHandoffs()` unconditionally, before
  the ready check)
- Modify: `apps/desktop/src/DesktopBoot.test.tsx`

**Interfaces:**
- Consumes: `onSearchShow` (Task 5), `showSearchHandoff` (Task 6).
- Produces: `export function useSearchHandoffs(): void`, which subscribes once on mount and
  unsubscribes on unmount, safe under StrictMode's double mount (a `cancelled` flag for the
  pending subscription).

- [ ] **Step 1: Write the failing test** (`DesktopBoot.test.tsx`; mock `@grimoire/ui/lib/window`'s
  `onSearchShow` to capture the callback)

```ts
it("hands a search the MCP server sent this window to the store", async () => {
  render(<DesktopBoot />);
  await waitFor(() => expect(onSearchShow).toHaveBeenCalledTimes(1));
  const send = onSearchShow.mock.calls[0][0];
  act(() => send({ id: 9, text: "bolt" } as SearchHandoff));
  expect(useAppStore.getState().activeView).toBe("search");
  expect(useAppStore.getState().pendingSearchHandoff?.id).toBe(9);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/desktop/src/DesktopBoot.test.tsx`
Expected: FAIL (`onSearchShow` never called).

- [ ] **Step 3: Implement** the hook, and call it in `DesktopBoot`. The light app does not call it,
  since it has no server.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run apps/desktop/src/DesktopBoot.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/features/search/useSearchHandoffs.ts apps/desktop/src/
git commit -m "feat(desktop): the window listens for an agent's search"
```

---

### Task 10: The `search_cards` prompt and the documentation

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/prompts/search_cards.md`
- Modify: `docs/reference/local-mcp-server.md` (§2 tool table and a `show_search` paragraph; the
  one-sentence summary; §6's project B line)
- Modify: `apps/desktop/src-tauri/CLAUDE.md` (the MCP bullets: 27 tools, `show_search`, the one
  window-aimed event, `mcp_search_shown` on `DESKTOP_ONLY`)
- Modify: `docs/reference/multi-window.md` §6 (snap hover is no longer the only window-targeted
  event the page hears: `search:show` is the second)
- Modify: `packages/ui/CLAUDE.md` §4 (the quick search's hand-off list gains `showSearchHandoff`,
  an agent's search)

**Interfaces:**
- Consumes: the tool as built (Tasks 1–3) and the answer's fields.

- [ ] **Step 1: Rework the prompt.**
  - The table gains the row `"Show me these in the app", "let me look through them"` →
    `show_search`, after the user says yes.
  - A new section, **Showing a search in the app**, after the `find_cards` section:
    - when to offer (more cards than a chat list reads well, a search to browse or refine,
      cards to add to a deck or the wishlist, which the tools never do);
    - ask in chat first, call once per yes, and never because a search merely could be shown;
    - preview with `find_cards` and the same `filters`;
    - `filters` for what the filter bar holds and `text` for the rest, with five examples
      (`t:`, `o:"draw a card"`, `pow>=4`, `-otag:`, `(… or …)`);
    - what the page does not read (regular expressions, `~`, `cube:`, `order:`/`direction:`;
      use `sort`);
    - reading the answer: `total`, a 0 with a keyword left in `words` (fix and offer again), and
      `cameForward: false` (tell the user to click the flashing taskbar button).
  - Keep the opening paragraph's "Everything here reads; nothing changes the user's data" true by
    adding "and `show_search` changes only what the app's window shows".
  - Keep the graph section as it is.

- [ ] **Step 2: Run the prompt tests**

Run: `cargo test -p mtg-grimoire mcp::prompts:: mcp::rpc::`
Expected: PASS (`every_example_query_is_valid` still holds the graph examples).

- [ ] **Step 3: Update the four documents** as listed under Files, in the style of the lines around
  each edit.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/prompts/search_cards.md docs/reference/ apps/desktop/src-tauri/CLAUDE.md packages/ui/CLAUDE.md
git commit -m "docs(mcp): show_search in the search_cards prompt and the references"
```

---

### Task 11: Verify, the live pass, and the PR

- [ ] **Step 1: Run the whole gate**, alone (no other verify running; follow `worktree-setup`
  first).

Run: `pnpm verify`
Expected: green. On a red suite, use `superpowers:systematic-debugging`; the memory's flaky
`toBeVisible` family is re-run once before being treated as real.

- [ ] **Step 2: Live pass** (the `running-the-app` skill holds the app lock; drive the window over
  CDP with `scripts/cdp.ts`). Use a copy of the real `data` folder (the worktree live-testing
  memory). Switch the MCP server on in Settings → Integrations, then call `show_search` over HTTP
  with curl (`local-mcp-server.md` §4) and record each result in the PR:
  1. text `t:creature` with `filters: { format: "commander", colors: ["U","R"], oracleTags: ["ramp"] }`,
     window behind another app: the page shows the box, the controls, the chip; the answer's
     `total` equals the wall's caption; `cameForward` as observed, and whether the taskbar button
     flashed;
  2. the same with the window minimized;
  3. two windows open (Ctrl+Shift+N), the second focused last: only it changes;
  4. `text: "cube:vintage"`: the answer's 0 note names it;
  5. `filters: { format: "premodern", rarities: ["rare", "special"] }`: the box holds
     `f:premodern (r:rare or r:special)`;
  6. from Claude Code in a terminal as the client in front: note whether tao's Alt tap did
     anything visible there.

- [ ] **Step 3: Open the PR** against `claude/mtg-grimoire-mcp-overview-d8ef41` (A's branch, while
  PR #1728 is open), titled `feat(mcp): show_search — an agent's search on the app's Search page`.
  The body has the live pass's findings, and ends with
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Then follow the
  session's PR-tool instructions (bind it and read its CI).
