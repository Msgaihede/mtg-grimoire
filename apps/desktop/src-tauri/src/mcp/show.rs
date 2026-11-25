//! **`show_search`** — an agent's text and checked filters into what the Search page's bar holds
//! ([`handoff`], pure), the one hand-off waiting for its page's answer ([`ShowSearch`], on
//! `AppState`, reaching windows only through [`SearchWindows`]), the tool's answer ([`answer`],
//! pure) and the page's command that reports ([`mcp_search_shown`]). A value the bar has a control
//! for lands on the control; one it has none for goes into the text as a term, so the page shows
//! the whole of the search and nothing is silently dropped.

use super::filters::CheckedFilters;
use crate::sync::AppState;
use grimoire_core::tags::query::TagRef;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

/// The formats the page's picker offers (`FORMATS` in `useCardSearch.ts`).
pub const PICKER_FORMATS: [&str; 7] = [
    "standard",
    "pioneer",
    "modern",
    "legacy",
    "vintage",
    "pauper",
    "commander",
];

/// The rarities the page has a chip for (`RARITIES` in `filterOptions.ts`).
pub const CHIP_RARITIES: [&str; 4] = ["common", "uncommon", "rare", "mythic"];

/// The page's sort keys (`SEARCH_SORT_OPTIONS` in `useCardSearch.ts`).
pub const SORT_KEYS: [&str; 8] = [
    "name",
    "set",
    "type",
    "rarity",
    "price",
    "manaValue",
    "released",
    "imageUpdated",
];

/// The most characters of `text` a call may carry.
pub const MAX_TEXT_CHARS: usize = 1000;

/// A search as the page's bar holds it. `id` is assigned when it is sent.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHandoff {
    pub id: u64,
    pub text: String,
    pub format: Option<String>,
    pub colors: Vec<String>,
    pub colors_strict: bool,
    pub types: Vec<String>,
    pub rarities: Vec<String>,
    pub sets: Vec<String>,
    pub mana_values: Vec<u64>,
    pub mana_x: bool,
    pub owned: Option<bool>,
    pub price_min: Option<f64>,
    pub price_max: Option<f64>,
    pub borders: Vec<String>,
    pub finishes: Vec<String>,
    pub universe: Option<String>,
    pub tags: Vec<TagRef>,
    pub sort: Option<HandoffSort>,
    pub all_printings: Option<bool>,
}

impl SearchHandoff {
    /// Whether the search narrows the wall at all — text, or any filter. `sort` and
    /// `allPrintings` order and group the wall and narrow nothing, so a hand-off with only those
    /// would put the reader's page down for every card.
    pub(super) fn narrows(&self) -> bool {
        !self.text.is_empty()
            || self.format.is_some()
            || !self.colors.is_empty()
            || !self.types.is_empty()
            || !self.rarities.is_empty()
            || !self.sets.is_empty()
            || !self.mana_values.is_empty()
            || self.mana_x
            || self.owned.is_some()
            || self.price_min.is_some()
            || self.price_max.is_some()
            || !self.borders.is_empty()
            || !self.finishes.is_empty()
            || self.universe.is_some()
            || !self.tags.is_empty()
    }
}

/// A sort the agent asked for; `dir` is `"asc"` or `"desc"`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HandoffSort {
    pub key: String,
    pub dir: String,
}

/// The page's shape of a search: the text the agent typed, then the terms the bar has no control
/// for (`is:gamechanger`, a format outside the picker, a rarity with no chip), joined by single
/// spaces. `id` is 0 here.
///
/// **Text holding an `or` is grouped before a term is appended.** The page binds terms side by side
/// tighter than `or` (`queryLanguage.ts`), so `t:goblin or t:elf` and `is:gamechanger` would be a
/// goblin, or an elf game changer; `(t:goblin or t:elf) is:gamechanger` is what the agent asked.
/// Any whitespace-separated `or` (in any case) counts, a nested one too, where an extra pair of
/// parentheses changes nothing. Text with no `or`, or with nothing appended, is left as typed.
pub(super) fn handoff(
    text: Option<&str>,
    f: &CheckedFilters,
    sort: Option<HandoffSort>,
    all_printings: Option<bool>,
) -> SearchHandoff {
    let typed = text.map(str::trim).filter(|t| !t.is_empty());
    let mut parts: Vec<String> = Vec::new();
    if f.game_changer {
        parts.push("is:gamechanger".to_owned());
    }
    let format = match &f.format {
        Some(key) if PICKER_FORMATS.contains(&key.as_str()) => Some(key.clone()),
        Some(key) => {
            parts.push(format!("f:{key}"));
            None
        }
        None => None,
    };
    let rarities = if f
        .rarities
        .iter()
        .all(|r| CHIP_RARITIES.contains(&r.as_str()))
    {
        f.rarities.clone()
    } else {
        let terms: Vec<String> = f.rarities.iter().map(|r| format!("r:{r}")).collect();
        parts.push(match terms.as_slice() {
            [one] => one.clone(),
            many => format!("({})", many.join(" or ")),
        });
        Vec::new()
    };
    if let Some(t) = typed {
        let holds_or = t.split_whitespace().any(|w| w.eq_ignore_ascii_case("or"));
        parts.insert(
            0,
            if holds_or && !parts.is_empty() {
                format!("({t})")
            } else {
                t.to_owned()
            },
        );
    }
    SearchHandoff {
        id: 0,
        text: parts.join(" "),
        format,
        colors: f.colors.clone(),
        colors_strict: f.colors_exact.unwrap_or(false) && !f.colors.is_empty(),
        types: f.types.iter().map(|t| (*t).to_owned()).collect(),
        rarities,
        sets: f.sets.clone(),
        mana_values: f.mana_values.clone(),
        mana_x: f.mana_x,
        owned: f.owned,
        price_min: f.price_min,
        price_max: f.price_max,
        borders: f.borders.clone(),
        finishes: f.finishes.clone(),
        universe: f.universe.clone(),
        tags: f.oracle_tags.clone(),
        sort,
        all_printings,
    }
}

/// The event the Search page listens for on its own window.
pub const SEARCH_SHOW_EVENT: &str = "search:show";

/// How long `show_search` waits for the page to say what it shows.
pub const WAIT: Duration = Duration::from_secs(5);

/// What the Search page says it shows once it has run a hand-off.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchShownReport {
    pub total: u64,
    pub total_is_capped: bool,
    pub keywords: Vec<String>,
    pub words: String,
    pub unknown_tags: Vec<String>,
    pub failure: Option<String>,
}

/// Which window got the search, and whether Windows let it come to the front.
pub struct Shown {
    pub label: String,
    pub came_forward: bool,
}

/// The app's windows, as `show_search` needs them. `show` may block; it is called on the blocking
/// pool.
pub trait SearchWindows: Send + Sync + 'static {
    fn show(&self, handoff: &SearchHandoff) -> Result<Shown, String>;
}

/// How a waiting call ended, other than by timing out.
pub enum Outcome {
    Reported(SearchShownReport),
    Replaced,
}

struct Detached;

impl SearchWindows for Detached {
    fn show(&self, _: &SearchHandoff) -> Result<Shown, String> {
        Err("No app window can show a search here.".to_owned())
    }
}

type Waiting = Option<(u64, oneshot::Sender<Outcome>)>;

/// The one hand-off waiting for its page's answer.
///
/// **Two overlapping calls may take the slot in one order and reach the window in the other**: the
/// slot is taken before the window is sent the search, on the blocking pool, so the later call's
/// search can arrive first. The window then shows the search that was answered "replaced", and the
/// one left waiting times out with `shown: null`. Accepted: only parallel tool calls reach it, and
/// the tool asks the agent to call once per yes.
pub struct ShowSearch {
    windows: Arc<dyn SearchWindows>,
    wait: Duration,
    next_id: AtomicU64,
    waiting: Mutex<Waiting>,
}

impl ShowSearch {
    pub fn new(windows: Arc<dyn SearchWindows>, wait: Duration) -> Self {
        Self {
            windows,
            wait,
            next_id: AtomicU64::new(1),
            waiting: Mutex::new(None),
        }
    }

    /// A `ShowSearch` whose windows refuse every search.
    pub fn detached() -> Self {
        Self::new(Arc::new(Detached), WAIT)
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Waiting> {
        self.waiting.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sends the search to a window and waits for the page's report.
    pub async fn show(&self, mut handoff: SearchHandoff) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        handoff.id = id;
        let (tx, rx) = oneshot::channel();
        {
            let mut slot = self.slot();
            if let Some((_, earlier)) = slot.take() {
                let _ = earlier.send(Outcome::Replaced);
            }
            *slot = Some((id, tx));
        }
        let windows = self.windows.clone();
        let sent = tauri::async_runtime::spawn_blocking(move || windows.show(&handoff))
            .await
            .map_err(|e| format!("The window could not be reached: {e}"))
            .and_then(|r| r);
        let shown = match sent {
            Ok(shown) => shown,
            Err(why) => {
                self.clear(id);
                return Err(why);
            }
        };
        let outcome = match tokio::time::timeout(self.wait, rx).await {
            Ok(Ok(outcome)) => Some(outcome),
            Ok(Err(_)) => None,
            Err(_) => {
                self.clear(id);
                None
            }
        };
        Ok(answer(&shown, outcome))
    }

    /// Empties the slot if it still holds `id`'s sender.
    fn clear(&self, id: u64) {
        let mut slot = self.slot();
        if slot.as_ref().is_some_and(|(waiting, _)| *waiting == id) {
            *slot = None;
        }
    }

    /// The page's answer for `id`; false when no call is waiting on that id.
    pub fn report(&self, id: u64, report: SearchShownReport) -> bool {
        let mut slot = self.slot();
        if slot.as_ref().is_some_and(|(waiting, _)| *waiting == id) {
            if let Some((_, tx)) = slot.take() {
                return tx.send(Outcome::Reported(report)).is_ok();
            }
        }
        false
    }
}

/// The tool's answer, and the notes the agent should pass to the user. Pure.
pub fn answer(shown: &Shown, outcome: Option<Outcome>) -> Value {
    let mut notes: Vec<String> = Vec::new();
    let mut out = Map::new();
    match outcome {
        Some(Outcome::Reported(r)) => {
            if let Some(failure) = &r.failure {
                notes.push(failure.clone());
            } else if r.total == 0 {
                let mut s = "The Search page shows no cards.".to_owned();
                if r.words.contains(':') {
                    s.push_str(&format!(
                        " It searched \"{}\" as plain words, so a term there was not read as a keyword.",
                        r.words
                    ));
                }
                notes.push(s);
            }
            out.insert("shown".into(), json!(true));
            out.insert("cameForward".into(), json!(shown.came_forward));
            out.insert("total".into(), json!(r.total));
            out.insert("totalIsCapped".into(), json!(r.total_is_capped));
            out.insert("keywords".into(), json!(r.keywords));
            out.insert("words".into(), json!(r.words));
            out.insert("unknownTags".into(), json!(r.unknown_tags));
            out.insert("failure".into(), json!(r.failure));
        }
        Some(Outcome::Replaced) => {
            notes.push("A later search replaced this one.".to_owned());
            out.insert("shown".into(), json!(false));
            out.insert("cameForward".into(), json!(shown.came_forward));
        }
        None => {
            notes.push(
                "The app was sent the search, but its window did not say what it shows within 5 seconds; ask the user whether it appeared."
                    .to_owned(),
            );
            out.insert("shown".into(), Value::Null);
            out.insert("cameForward".into(), json!(shown.came_forward));
        }
    }
    if !shown.came_forward {
        notes.push(
            "Windows kept the app behind the window in front, and its taskbar button is flashing: tell the user to click it."
                .to_owned(),
        );
    }
    if !notes.is_empty() {
        out.insert("note".into(), json!(notes.join(" ")));
    }
    Value::Object(out)
}

/// The Search page's answer to a `search:show`.
#[tauri::command]
pub fn mcp_search_shown(
    state: tauri::State<'_, Arc<AppState>>,
    id: u64,
    report: SearchShownReport,
) {
    state.show_search.report(id, report);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::testing::FakeWindows;

    fn blank() -> SearchHandoff {
        handoff(None, &CheckedFilters::default(), None, None)
    }

    fn report(total: u64, words: &str) -> SearchShownReport {
        SearchShownReport {
            total,
            words: words.to_owned(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn the_pages_report_is_the_answer() {
        let fake = Arc::new(FakeWindows::forward(true));
        let show = Arc::new(ShowSearch::new(fake.clone(), Duration::from_secs(2)));
        let call = tokio::spawn({
            let show = show.clone();
            async move { show.show(blank()).await }
        });
        let id = fake.wait_for_one().await.id;
        assert!(show.report(id, report(143, "")));
        let got = call.await.unwrap().unwrap();
        assert_eq!(got["shown"], true);
        assert_eq!(got["cameForward"], true);
        assert_eq!(got["total"], 143);
        assert!(got.get("note").is_none());
        assert!(
            !show.report(id, report(1, "")),
            "a second report for a spent id is dropped"
        );
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
        let first = tokio::spawn({
            let show = show.clone();
            async move { show.show(blank()).await }
        });
        let first_id = fake.wait_for_one().await.id;
        let second = tokio::spawn({
            let show = show.clone();
            async move { show.show(blank()).await }
        });
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
        let behind = Shown {
            label: "main".into(),
            came_forward: false,
        };
        let got = answer(&behind, Some(Outcome::Reported(report(5, ""))));
        assert_eq!(got["cameForward"], false);
        assert!(got["note"].as_str().unwrap().contains("taskbar"));
        let front = Shown {
            label: "main".into(),
            came_forward: true,
        };
        let empty = answer(&front, Some(Outcome::Reported(report(0, "cube:vintage"))));
        let note = empty["note"].as_str().unwrap();
        assert!(
            note.contains("no cards") && note.contains("cube:vintage"),
            "{note}"
        );
        assert_eq!(
            empty.get("failure"),
            Some(&Value::Null),
            "an answer with no failure says so"
        );
        let failed = SearchShownReport {
            failure: Some("The tag list could not be read.".into()),
            ..report(0, "")
        };
        let failed = answer(&front, Some(Outcome::Reported(failed)));
        assert_eq!(failed["shown"], true);
        assert_eq!(failed["failure"], "The tag list could not be read.");
        assert!(failed["note"]
            .as_str()
            .unwrap()
            .contains("could not be read"));
        assert!(!answer(&front, None)["note"]
            .as_str()
            .unwrap()
            .contains("  "));
    }

    #[tokio::test]
    async fn a_refusing_window_is_the_tools_refusal() {
        let why = ShowSearch::detached().show(blank()).await.err().unwrap();
        assert!(why.contains("No app window"), "{why}");
    }

    /// The text between `start` and the next `]`.
    fn list_after<'a>(src: &'a str, start: &str) -> &'a str {
        let from = src.find(start).expect("the list is in the page's source") + start.len();
        let rest = &src[from..];
        &rest[..rest.find(']').expect("the list closes")]
    }

    /// The `value: "…"` strings between `start` and the next `]`.
    fn values_in(src: &str, start: &str) -> Vec<String> {
        list_after(src, start)
            .split("value: \"")
            .skip(1)
            .filter_map(|s| s.split('"').next())
            .map(str::to_owned)
            .collect()
    }

    /// Every `"…"` between `start` and the next `]`.
    fn quoted_in(src: &str, start: &str) -> Vec<String> {
        list_after(src, start)
            .split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn a_picker_format_lands_on_the_select_and_another_goes_into_the_text() {
        let f = CheckedFilters {
            format: Some("commander".into()),
            ..Default::default()
        };
        let h = handoff(Some("t:creature"), &f, None, None);
        assert_eq!(h.format.as_deref(), Some("commander"));
        assert_eq!(h.text, "t:creature");
        let f = CheckedFilters {
            format: Some("premodern".into()),
            ..Default::default()
        };
        let h = handoff(Some("t:creature"), &f, None, None);
        assert_eq!(h.format, None);
        assert_eq!(h.text, "t:creature f:premodern");
    }

    #[test]
    fn rarities_stay_on_the_chips_unless_one_has_none_then_all_go_in_one_group() {
        let chips = CheckedFilters {
            rarities: vec!["rare".into(), "mythic".into()],
            ..Default::default()
        };
        let h = handoff(None, &chips, None, None);
        assert_eq!(h.rarities, ["rare", "mythic"]);
        assert_eq!(h.text, "");
        let one = CheckedFilters {
            rarities: vec!["special".into()],
            ..Default::default()
        };
        assert_eq!(handoff(None, &one, None, None).text, "r:special");
        let mixed = CheckedFilters {
            rarities: vec!["rare".into(), "special".into()],
            ..Default::default()
        };
        let h = handoff(None, &mixed, None, None);
        assert!(h.rarities.is_empty());
        assert_eq!(h.text, "(r:rare or r:special)");
    }

    #[test]
    fn game_changers_are_a_term_and_the_text_is_never_padded() {
        let f = CheckedFilters {
            game_changer: true,
            format: Some("oathbreaker".into()),
            ..Default::default()
        };
        assert_eq!(
            handoff(Some("   "), &f, None, None).text,
            "is:gamechanger f:oathbreaker"
        );
        assert_eq!(
            handoff(Some("  bolt  "), &f, None, None).text,
            "bolt is:gamechanger f:oathbreaker"
        );
        assert_eq!(
            handoff(None, &CheckedFilters::default(), None, None).text,
            ""
        );
    }

    /// The page binds terms side by side tighter than `or` (`queryLanguage.ts`), so a term
    /// appended after an agent's `a or b` would narrow `b` alone. Such text is grouped first;
    /// text with no `or`, or with nothing appended, is left as the agent typed it.
    #[test]
    fn text_holding_an_or_is_grouped_before_a_term_is_appended() {
        let gc = CheckedFilters {
            game_changer: true,
            ..Default::default()
        };
        assert_eq!(
            handoff(Some("t:goblin or t:elf"), &gc, None, None).text,
            "(t:goblin or t:elf) is:gamechanger"
        );
        let premodern = CheckedFilters {
            format: Some("premodern".into()),
            ..Default::default()
        };
        assert_eq!(
            handoff(Some("T:Goblin OR t:elf"), &premodern, None, None).text,
            "(T:Goblin OR t:elf) f:premodern"
        );
        assert_eq!(
            handoff(Some("bolt"), &gc, None, None).text,
            "bolt is:gamechanger"
        );
        assert_eq!(
            handoff(
                Some("t:goblin or t:elf"),
                &CheckedFilters::default(),
                None,
                None
            )
            .text,
            "t:goblin or t:elf"
        );
    }

    #[test]
    fn a_search_narrows_by_its_text_or_a_filter_and_never_by_its_order() {
        assert!(!blank().narrows());
        let ordered = handoff(
            Some("   "),
            &CheckedFilters {
                colors_exact: Some(true),
                ..Default::default()
            },
            Some(HandoffSort {
                key: "price".into(),
                dir: "desc".into(),
            }),
            Some(true),
        );
        assert!(!ordered.colors_strict, "colorsExact with no colours");
        assert!(!ordered.narrows(), "{ordered:?}");
        assert!(handoff(Some("bolt"), &CheckedFilters::default(), None, None).narrows());
        for f in [
            CheckedFilters {
                owned: Some(false),
                ..Default::default()
            },
            CheckedFilters {
                mana_x: true,
                ..Default::default()
            },
            CheckedFilters {
                universe: Some("within".into()),
                ..Default::default()
            },
            CheckedFilters {
                price_min: Some(1.0),
                ..Default::default()
            },
        ] {
            assert!(handoff(None, &f, None, None).narrows(), "{f:?}");
        }
    }

    #[test]
    fn the_rest_is_carried_in_the_pages_shape() {
        let tag = TagRef {
            slug: "ramp".into(),
            label: "Ramp".into(),
            namespace: "oracle".into(),
        };
        let f = CheckedFilters {
            colors: vec!["U".into(), "R".into()],
            colors_exact: Some(true),
            oracle_tags: vec![tag.clone()],
            borders: vec!["borderless".into()],
            universe: Some("beyond".into()),
            mana_values: vec![1, 8],
            mana_x: true,
            owned: Some(false),
            price_max: Some(2.5),
            ..Default::default()
        };
        let sort = HandoffSort {
            key: "price".into(),
            dir: "desc".into(),
        };
        let h = handoff(None, &f, Some(sort.clone()), Some(true));
        assert_eq!(
            (h.colors.clone(), h.colors_strict),
            (vec!["U".to_owned(), "R".to_owned()], true)
        );
        let colourless_exact = CheckedFilters {
            colors_exact: Some(true),
            ..Default::default()
        };
        assert!(
            !handoff(None, &colourless_exact, None, None).colors_strict,
            "colorsExact with no colours sets no strictness the bar would draw"
        );
        assert_eq!(h.tags, [tag]);
        assert_eq!(h.sort, Some(sort));
        assert_eq!(h.all_printings, Some(true));
        let wire = serde_json::to_value(&h).unwrap();
        for key in [
            "colorsStrict",
            "manaValues",
            "manaX",
            "priceMax",
            "allPrintings",
        ] {
            assert!(wire.get(key).is_some(), "{key}");
        }
    }

    /// The three lists are the page's: a format added to the picker, a rarity given a chip or a
    /// sort key added there must be added here, or the hand-off sends a value the bar cannot draw.
    #[test]
    fn the_lists_match_the_pages_own() {
        let search = include_str!("../../../../../packages/ui/features/search/useCardSearch.ts");
        let options = include_str!("../../../../../packages/ui/features/search/filterOptions.ts");
        assert_eq!(
            values_in(search, "export const FORMATS = ["),
            PICKER_FORMATS
        );
        assert_eq!(
            values_in(search, "export const SEARCH_SORT_OPTIONS = ["),
            SORT_KEYS
        );
        assert_eq!(
            quoted_in(options, "export const RARITIES = ["),
            CHIP_RARITIES
        );
    }
}
